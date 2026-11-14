import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import type { FileToolOptions, FileToolRecipe } from "../../lib/fileTools";
import { archiveTools } from "./fileToolsArchives";
import type {
    FileToolEngine,
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "./fileToolsTypes";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const TIMEOUT_MS = 180_000;

type RarEvent =
    | { type: "entry"; path: string; size: number; entryType: number }
    | { type: "chunk"; bytes: Uint8Array }
    | { type: "entry-end" }
    | { type: "done" }
    | { type: "error"; message: string };

type RarToolOptions = { root: string };

function abortError() {
    const error = new Error("RAR operation cancelled");
    error.name = "AbortError";
    return error;
}

function runtimeReady(root: string) {
    return (
        existsSync(join(root, "assets/runtime/rar-wasm/rar-runtime.mjs")) &&
        existsSync(join(root, "assets/runtime/rar-wasm/rar-runtime.wasm"))
    );
}

function recipes(root: string, inputs: ToolInput[]): FileToolRecipe[] {
    if (
        inputs.length !== 1 ||
        inputs[0].extension.toLowerCase().replace(/^\./, "") !== "rar"
    )
        return [];
    const resources = runtimeReady(root);
    const available = resources;
    const reason = available
        ? undefined
        : !resources
          ? "Bounded RAR runtime assets are unavailable"
          : "Select one RAR archive";
    return [
        {
            id: "archive-rar-extract",
            label: "Extract RAR",
            group: "tools",
            available,
            reason,
        },
        {
            id: "archive-rar-inspect",
            label: "List RAR contents",
            group: "tools",
            available,
            reason,
        },
        {
            id: "archive-rar-convert",
            label: "Convert RAR",
            group: "convert",
            formats: ["zip", "tar", "gz"],
            available,
            reason,
        },
        {
            id: "archive-rar-test",
            label: "Test RAR integrity",
            group: "tools",
            available,
            reason,
        },
    ];
}

function validateOptions(recipe: string, options: FileToolOptions) {
    const keys = Object.keys(options);
    const allowed =
        recipe === "archive-rar-convert" ? new Set(["format"]) : new Set();
    const unsupported = keys.find((key) => !allowed.has(key));
    if (unsupported)
        throw new Error(`RAR tool option is unavailable: ${unsupported}`);
}

async function ensureRoot(path: string) {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("RAR output directory is unsafe");
    return resolve(path);
}

function childPath(root: string, ...segments: string[]) {
    const target = resolve(root, ...segments);
    if (
        target !== root &&
        !target.startsWith(`${root}\\`) &&
        !target.startsWith(`${root}/`)
    )
        throw new Error("RAR output escaped its staging directory");
    return target;
}

function safeEntryPath(value: string, directory: boolean) {
    if (
        !value ||
        value.length > 1024 ||
        value.includes("\0") ||
        value.includes("\\") ||
        value.includes("\uFFFD") ||
        value.startsWith("/") ||
        /^[a-zA-Z]:/.test(value)
    )
        throw new Error(`Unsafe RAR entry path: ${value}`);
    const source =
        directory && value.endsWith("/") ? value.slice(0, -1) : value;
    const segments = source.split("/");
    if (
        !source ||
        segments.some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".." ||
                segment.includes(":") ||
                /[. ]$/.test(segment) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
        )
    )
        throw new Error(`Unsafe RAR entry path: ${value}`);
    return { segments, normalized: segments.join("/") };
}

async function safeDirectoryChain(root: string, segments: string[]) {
    let current = root;
    for (const segment of segments) {
        current = childPath(current, segment);
        try {
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error(`Unsafe RAR output directory: ${segment}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await mkdir(current);
        }
    }
}

async function hashFile(path: string, signal: AbortSignal) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const value of createReadStream(path)) {
        if (signal.aborted) throw abortError();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_INPUT_BYTES)
            throw new Error("RAR input exceeds 100 MiB");
        hash.update(chunk);
    }
    return { bytes, hash: hash.digest("hex") };
}

async function writeAll(
    handle: Awaited<ReturnType<typeof open>>,
    bytes: Buffer,
) {
    let offset = 0;
    while (offset < bytes.length) {
        const result = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
            null,
        );
        if (!result.bytesWritten)
            throw new Error("RAR output write made no progress");
        offset += result.bytesWritten;
    }
}

function locate(root: string, candidates: string[]) {
    const found = candidates.map((value) => join(root, value)).find(existsSync);
    if (!found)
        throw new Error(`RAR runtime asset is missing: ${candidates[0]}`);
    return found;
}

async function runRuntime(
    root: string,
    input: ToolInput,
    outputRoot: string,
    mode: "extract" | "inspect" | "test",
    signal: AbortSignal,
    progress: (percent: number) => void,
) {
    const html = locate(root, [
        "out/renderer/rar_tools.html",
        "src/renderer/rar_tools.html",
    ]);
    const preload = locate(root, [
        "out/preload/rarTools.js",
        "out/preload/rarTools.cjs",
    ]);
    const runtime = locate(root, ["assets/runtime/rar-wasm/rar-runtime.mjs"]);
    const wasm = locate(root, ["assets/runtime/rar-wasm/rar-runtime.wasm"]);
    const inputBytes = await readFile(input.path, { signal });
    const [runtimeSource, wasmBytes] = await Promise.all([
        readFile(runtime, { encoding: "utf8", signal }),
        readFile(wasm, { signal }),
    ]);
    if (signal.aborted) throw abortError();
    const token = randomUUID();
    const callbackChannel = `oc:rar:event:${token}`;
    const extractRoot = childPath(
        outputRoot,
        `${basename(input.path, extname(input.path)) || "archive"}-extracted`,
    );
    if (mode === "extract") {
        await mkdir(extractRoot);
        if (signal.aborted) throw abortError();
    }
    const entries: {
        path: string;
        size: number;
        directory: boolean;
        verifiedBytes: number;
    }[] = [];
    const seen = new Map<string, "file" | "directory">();
    let current:
        | {
              entry: (typeof entries)[number];
              handle?: Awaited<ReturnType<typeof open>>;
          }
        | undefined;
    let totalBytes = 0;
    let ended = false;
    let ioQueue = Promise.resolve();
    const window = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            preload,
            partition: `oc-rar-${token}`,
        },
    });
    const pageUrl = pathToFileURL(html).toString();
    const rendererRootUrl = pathToFileURL(`${dirname(html)}${sep}`).toString();
    const rarSession = window.webContents.session;
    rarSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
    );
    rarSession.setPermissionCheckHandler(() => false);
    rarSession.webRequest.onBeforeRequest((details, callback) => {
        callback({
            cancel:
                !details.url.startsWith(rendererRootUrl) &&
                !details.url.startsWith("blob:"),
        });
    });
    rarSession.on("will-download", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
    );
    window.webContents.on("will-navigate", (event, url) => {
        if (url !== pageUrl) event.preventDefault();
    });
    const cleanup = async () => {
        ipcMain.removeHandler(callbackChannel);
        await ioQueue.catch(() => {});
        await current?.handle?.close().catch(() => {});
        current = undefined;
        if (!window.isDestroyed()) window.destroy();
    };
    return await new Promise<{
        entries: typeof entries;
        extractRoot?: string;
    }>((resolveRun, reject) => {
        const finish = async (error?: unknown) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            await cleanup();
            if (error) reject(error);
            else
                resolveRun({
                    entries,
                    extractRoot: mode === "extract" ? extractRoot : undefined,
                });
        };
        const cancel = () => void finish(abortError());
        const timer = setTimeout(
            () =>
                void finish(
                    new Error("RAR operation timed out after 180 seconds"),
                ),
            TIMEOUT_MS,
        );
        signal.addEventListener("abort", cancel, { once: true });
        ipcMain.handle(
            callbackChannel,
            async (event, receivedToken: unknown, rawEvent: unknown) => {
                if (
                    event.sender !== window.webContents ||
                    event.senderFrame !== window.webContents.mainFrame ||
                    event.senderFrame.url !== pageUrl ||
                    receivedToken !== token
                )
                    throw new Error("Unauthorized RAR runtime message");
                if (ended) throw new Error("RAR runtime session has ended");
                const pending = ioQueue.then(async () => {
                    if (ended) throw abortError();
                    const message = rawEvent as RarEvent;
                    if (message.type === "entry") {
                        if (current)
                            throw new Error(
                                "RAR entry started before the previous entry ended",
                            );
                        if (entries.length >= MAX_ENTRIES)
                            throw new Error(
                                "RAR contains more than 5000 entries",
                            );
                        if (
                            !Number.isSafeInteger(message.size) ||
                            message.size < 0 ||
                            message.size > MAX_OUTPUT_BYTES ||
                            (message.entryType !== 1 && message.entryType !== 2)
                        )
                            throw new Error("RAR entry metadata is invalid");
                        const directory = message.entryType === 2;
                        const safe = safeEntryPath(message.path, directory);
                        const canonical = safe.normalized
                            .normalize("NFC")
                            .toLowerCase();
                        if (seen.has(canonical))
                            throw new Error(
                                `Duplicate RAR entry: ${message.path}`,
                            );
                        for (const [known, knownType] of seen)
                            if (
                                (canonical.startsWith(`${known}/`) &&
                                    knownType === "file") ||
                                (!directory &&
                                    known.startsWith(`${canonical}/`))
                            )
                                throw new Error(
                                    `RAR file/directory collision: ${message.path}`,
                                );
                        seen.set(canonical, directory ? "directory" : "file");
                        totalBytes += message.size;
                        if (totalBytes > MAX_OUTPUT_BYTES)
                            throw new Error(
                                "RAR expanded size exceeds 256 MiB",
                            );
                        const entry = {
                            path: safe.normalized,
                            size: message.size,
                            directory,
                            verifiedBytes: 0,
                        };
                        entries.push(entry);
                        current = { entry };
                        if (mode === "extract") {
                            const parents = directory
                                ? safe.segments
                                : safe.segments.slice(0, -1);
                            await safeDirectoryChain(extractRoot, parents);
                            if (ended) throw abortError();
                            if (!directory)
                                current.handle = await open(
                                    childPath(extractRoot, ...safe.segments),
                                    "wx",
                                    0o600,
                                );
                            if (ended) throw abortError();
                        }
                    } else if (message.type === "chunk") {
                        if (!current || current.entry.directory)
                            throw new Error("Unexpected RAR data chunk");
                        const bytes = Buffer.from(message.bytes);
                        if (!bytes.length || bytes.length > MAX_CHUNK_BYTES)
                            throw new Error("RAR chunk size is invalid");
                        current.entry.verifiedBytes += bytes.length;
                        if (current.entry.verifiedBytes > current.entry.size)
                            throw new Error(
                                "RAR entry exceeded its declared size",
                            );
                        if (current.handle)
                            await writeAll(current.handle, bytes);
                        if (ended) throw abortError();
                    } else if (message.type === "entry-end") {
                        if (!current)
                            throw new Error("Unexpected RAR entry completion");
                        if (
                            !current.entry.directory &&
                            current.entry.verifiedBytes !== current.entry.size
                        )
                            throw new Error(
                                "RAR entry ended before its declared size",
                            );
                        await current.handle?.close();
                        current = undefined;
                        progress(
                            (entries.length / Math.max(entries.length + 1, 1)) *
                                100,
                        );
                    } else if (message.type === "done") {
                        if (current)
                            throw new Error("RAR finished during an entry");
                        progress(100);
                        void finish();
                    } else if (message.type === "error") {
                        void finish(
                            new Error(message.message || "RAR runtime failed"),
                        );
                    } else {
                        throw new Error("Unknown RAR runtime message");
                    }
                });
                ioQueue = pending.catch(() => {});
                await pending;
            },
        );
        if (signal.aborted) {
            cancel();
            return;
        }
        window.webContents.once("did-finish-load", () => {
            window.webContents.send("oc:rar:start", {
                token,
                callbackChannel,
                runtimeSource,
                wasm: new Uint8Array(wasmBytes),
                input: new Uint8Array(inputBytes),
            });
        });
        window.webContents.once(
            "render-process-gone",
            (_event, details) =>
                void finish(
                    new Error(`RAR runtime stopped: ${details.reason}`),
                ),
        );
        window.loadURL(pageUrl).catch((error) => void finish(error));
    });
}

export function createRarTools({ root }: RarToolOptions): FileToolEngine {
    return {
        recipes: (inputs) => recipes(root, inputs),
        async run(context: ToolContext): Promise<ToolEngineResult> {
            validateOptions(context.recipe, context.options);
            if (context.inputs.length !== 1)
                throw new Error("RAR tools require exactly one input");
            const input = context.inputs[0];
            if (input.extension.toLowerCase().replace(/^\./, "") !== "rar")
                throw new Error("RAR tools require a .rar input");
            const info = await lstat(input.path);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error("RAR input is not a regular file");
            if (info.size > MAX_INPUT_BYTES)
                throw new Error("RAR input exceeds 100 MiB");
            if (context.signal.aborted) throw abortError();
            const outputRoot = await ensureRoot(context.outputDir);
            const before = await hashFile(input.path, context.signal);
            let mode: "extract" | "inspect" | "test";
            if (context.recipe === "archive-rar-extract") mode = "extract";
            else if (context.recipe === "archive-rar-inspect") mode = "inspect";
            else if (context.recipe === "archive-rar-test") mode = "test";
            else if (context.recipe === "archive-rar-convert") {
                const format = context.options.format?.toLowerCase();
                if (!format || !["zip", "tar", "gz"].includes(format))
                    throw new Error(
                        "RAR conversion format must be zip, tar, or gz",
                    );
                const privateRoot = childPath(
                    outputRoot,
                    `.rar-convert-${randomUUID()}`,
                );
                await mkdir(privateRoot);
                try {
                    const extracted = await runRuntime(
                        root,
                        input,
                        privateRoot,
                        "extract",
                        context.signal,
                        (percent) => context.progress(percent * 0.7),
                    );
                    const memberRoot = extracted.extractRoot!;
                    const names = await readdir(memberRoot);
                    const inputs = await Promise.all(
                        names.map(async (name): Promise<ToolInput> => {
                            const path = join(memberRoot, name);
                            const member = await lstat(path);
                            return {
                                id: path,
                                name,
                                path,
                                size: member.size,
                                extension: member.isDirectory()
                                    ? ""
                                    : (name.split(".").at(-1) ?? ""),
                                kind: member.isDirectory() ? "folder" : "other",
                            };
                        }),
                    );
                    const converted = await archiveTools.run({
                        ...context,
                        inputs,
                        recipe: "archive-compress",
                        options: { format },
                        progress: (percent) =>
                            context.progress(70 + percent * 0.3),
                    });
                    const after = await hashFile(input.path, context.signal);
                    if (
                        before.bytes !== after.bytes ||
                        before.hash !== after.hash
                    )
                        throw new Error("RAR source changed during processing");
                    return {
                        ...converted,
                        warnings: [
                            ...(converted.warnings ?? []),
                            "RAR members were repacked in canonical filesystem order",
                        ],
                    };
                } finally {
                    await rm(privateRoot, { recursive: true, force: true });
                }
            } else throw new Error(`Unknown RAR recipe: ${context.recipe}`);
            const result = await runRuntime(
                root,
                input,
                outputRoot,
                mode,
                context.signal,
                context.progress,
            );
            const after = await hashFile(input.path, context.signal);
            if (before.bytes !== after.bytes || before.hash !== after.hash)
                throw new Error("RAR source changed during processing");
            if (mode === "extract") return { paths: [result.extractRoot!] };
            const reportPath = childPath(
                outputRoot,
                mode === "inspect" ? "rar-inspection.json" : "rar-test.json",
            );
            await writeFile(
                reportPath,
                `${JSON.stringify(
                    {
                        format: "rar",
                        source: input.name,
                        valid: true,
                        entries: result.entries,
                        verifiedBytes: result.entries.reduce(
                            (total, entry) => total + entry.verifiedBytes,
                            0,
                        ),
                    },
                    null,
                    2,
                )}\n`,
                { encoding: "utf8", flag: "wx", mode: 0o600 },
            );
            return { paths: [reportPath] };
        },
    };
}
