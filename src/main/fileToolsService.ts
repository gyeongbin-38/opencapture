import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
    BrowserWindow,
    ClipboardItem,
    ShareMenu,
    type WebContents,
    app,
    clipboard,
    dialog,
    nativeImage,
    shell,
} from "electron";
import {
    type FileToolOptions,
    type FileToolRecipe,
    type FileToolResult,
    type FileToolSelection,
    fileToolKind,
} from "../../lib/fileTools";
import { copyPathsToWindowsClipboard } from "./captureFileClipboard";
import { archiveTools } from "./fileToolsArchives";
import { createDocumentExports } from "./fileToolsDocumentExports";
import { documentTools } from "./fileToolsDocuments";
import { imageTools } from "./fileToolsImages";
import { createMediaTools } from "./fileToolsMedia";
import { createOfficeTools } from "./fileToolsOffice";
import { createPdfTools } from "./fileToolsPdf";
import { createPdfTextDocuments } from "./fileToolsPdfDocuments";
import { createPdfRenderer } from "./fileToolsPdfRenderer";
import { createRarTools } from "./fileToolsRar";
import { createFileShelf } from "./fileToolsShelf";
import { textTools } from "./fileToolsText";
import { createTextPdfRenderer } from "./fileToolsTextPdf";
import type { FileToolEngine, ToolInput } from "./fileToolsTypes";

const MAX_SOURCES = 100;
const MAX_BYTES = 2 * 1024 ** 3;
const MAX_OUTPUTS = 5000;
const copyMaxFiles = () => (process.platform === "darwin" ? 1 : 100);
const assertCopyCount = (paths: string[]) => {
    if (paths.length > copyMaxFiles())
        throw new Error("Copy one file at a time on macOS.");
};
const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
const inside = (parent: string, child: string) => {
    const part = relative(parent, child);
    return (
        !!part &&
        part !== ".." &&
        !part.startsWith(`..${sep}`) &&
        !isAbsolute(part)
    );
};

interface Session {
    alive: boolean;
    sources: Map<string, ToolInput>;
    outputs: Map<string, string>;
    jobs: Map<string, AbortController>;
}

export function createFileToolsService(options: {
    root: string;
    userData: string;
    pin: (path: string) => Promise<void>;
    edit: (path: string) => void;
    language?: () => string;
    engines?: FileToolEngine[];
    destinations?: () => { id: string; name: string; path: string }[];
}) {
    const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const bundled = join(options.root, "lib", "ffmpeg", binary);
    const systemFfmpeg =
        process.platform === "linux"
            ? (process.env.PATH ?? "")
                  .split(":")
                  .filter(isAbsolute)
                  .map((directory) => join(directory, "ffmpeg"))
                  .find((path) => {
                      try {
                          return existsSync(path);
                      } catch {
                          return false;
                      }
                  })
            : undefined;
    const ffmpegPath = existsSync(bundled)
        ? bundled
        : (systemFfmpeg ?? bundled);
    const renderPdf = createPdfRenderer(options.root);
    const office = createOfficeTools();
    const engines = options.engines ?? [
        createMediaTools({ ffmpegPath }),
        imageTools,
        createPdfTools({ render: renderPdf }),
        createPdfTextDocuments(renderPdf),
        createDocumentExports({
            office,
            renderPdf,
            renderTextPdf: createTextPdfRenderer(),
        }),
        documentTools,
        office,
        createRarTools({ root: options.root }),
        textTools,
        archiveTools,
    ];
    const savedDestinationReason =
        "Select the folder again in the Mac App Store build.";
    const destinations = () =>
        (options.destinations?.() ?? []).slice(0, 6).map(({ id, name }) => ({
            id,
            name,
            available: !process.mas,
            ...(process.mas ? { reason: savedDestinationReason } : {}),
        }));
    const sessions = new Map<number, Session>();
    const stagingRoot = join(options.userData, "file-tools", "staging");
    const session = (sender: WebContents) => {
        let value = sessions.get(sender.id);
        if (!value) {
            value = {
                alive: true,
                sources: new Map(),
                outputs: new Map(),
                jobs: new Map(),
            };
            sessions.set(sender.id, value);
            const current = value;
            const release = () => {
                current.alive = false;
                for (const job of current.jobs.values()) job.abort();
                current.sources.clear();
                current.outputs.clear();
                if (sessions.get(sender.id) === current)
                    sessions.delete(sender.id);
            };
            sender.once("destroyed", release);
            sender.once("did-start-navigation", release);
        }
        return value;
    };
    const owner = (sender: WebContents) => {
        const window = BrowserWindow.fromWebContents(sender);
        if (!window || window.isDestroyed())
            throw new Error("The file tools window is closed.");
        return window;
    };
    const check = (current: Session, signal?: AbortSignal) => {
        if (!current.alive || signal?.aborted) throw new Error("Cancelled");
    };
    const getSources = (current: Session, ids: unknown) => {
        if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > MAX_SOURCES ||
            new Set(ids).size !== ids.length
        )
            throw new Error("Choose between 1 and 100 different files.");
        return ids.map((id) => {
            const source =
                typeof id === "string" ? current.sources.get(id) : undefined;
            if (!source)
                throw new Error(
                    "This source is no longer available. Choose the file again.",
                );
            return source;
        });
    };
    const recipesFor = async (inputs: ToolInput[]) => {
        const all = await Promise.all(
            engines.map(async (engine) => ({
                engine,
                recipes: await engine.recipes(inputs),
            })),
        );
        const result = all.flatMap(({ engine, recipes }) =>
            recipes.map((recipe) => ({ engine, recipe })),
        );
        const rar = result.some(
            ({ recipe }) => recipe.id === "archive-rar-convert",
        );
        const visible = rar
            ? result.filter(
                  ({ recipe }) =>
                      ![
                          "archive-extract",
                          "archive-inspect",
                          "archive-test",
                          "archive-compress",
                      ].includes(recipe.id),
              )
            : result;
        const specialized = visible.some(
            ({ recipe }) =>
                recipe.id === "pdf-convert" ||
                recipe.id === "office-convert" ||
                recipe.id === "document-text-convert",
        );
        return specialized
            ? visible.filter(
                  ({ recipe }) =>
                      recipe.available ||
                      !["text-convert", "table-convert"].includes(recipe.id),
              )
            : visible;
    };
    const recipes = async (inputs: ToolInput[]) => {
        const output = new Map<string, FileToolRecipe>();
        for (const source of inputs) {
            for (const { recipe } of await recipesFor([source])) {
                const existing = output.get(recipe.id);
                if (existing) {
                    existing.sourceIds?.push(source.id);
                    existing.formats = [
                        ...new Set([
                            ...(existing.formats ?? []),
                            ...(recipe.formats ?? []),
                        ]),
                    ];
                    if (recipe.available) {
                        existing.available = true;
                        existing.reason = undefined;
                    }
                } else
                    output.set(recipe.id, {
                        ...recipe,
                        sourceIds: [source.id],
                    });
            }
        }
        if (inputs.length > 1) {
            const kinds = new Map<string, ToolInput[]>();
            for (const input of inputs) {
                const group = kinds.get(input.kind) ?? [];
                group.push(input);
                kinds.set(input.kind, group);
            }
            const groups = [
                inputs,
                ...[...kinds.values()].filter(
                    (group) => group.length > 1 && group.length < inputs.length,
                ),
            ];
            for (const group of groups) {
                for (const { recipe } of await recipesFor(group)) {
                    const existing = output.get(recipe.id);
                    if (
                        !recipe.multiple ||
                        (existing &&
                            (!recipe.available ||
                                (existing.available &&
                                    (existing.sourceIds?.length ?? 0) >
                                        group.length)))
                    )
                        continue;
                    output.set(recipe.id, {
                        ...recipe,
                        sourceIds: group.map((item) => item.id),
                    });
                }
            }
        }
        return [...output.values()];
    };
    const select = async (
        sender: WebContents,
        paths?: unknown,
        mode?: unknown,
    ): Promise<FileToolSelection> => {
        const current = session(sender);
        let requested: unknown = paths;
        if (paths === undefined) {
            const chosen = await dialog.showOpenDialog(owner(sender), {
                title: "File tools",
                properties: [
                    mode === "folders" ? "openDirectory" : "openFile",
                    "multiSelections",
                ],
            });
            if (chosen.canceled)
                return {
                    sources: [],
                    recipes: [],
                    rejected: [],
                    copyMaxFiles: copyMaxFiles(),
                    destinations: destinations(),
                };
            requested = chosen.filePaths;
        }
        if (!Array.isArray(requested) || requested.length > MAX_SOURCES)
            throw new Error("Choose up to 100 files.");
        check(current);
        const sources: ToolInput[] = [];
        const rejected: FileToolSelection["rejected"] = [];
        for (const target of requested) {
            try {
                if (
                    typeof target !== "string" ||
                    !isAbsolute(target) ||
                    target.includes("\0")
                )
                    throw new Error("Invalid file path.");
                const path = await fs.realpath(target);
                const stat = await fs.lstat(path);
                if (!stat.isFile() && !stat.isDirectory())
                    throw new Error("Choose a regular file or folder.");
                if (stat.size > MAX_BYTES)
                    throw new Error("The file exceeds 2 GiB.");
                if (sources.some((item) => item.path === path)) continue;
                const extension = extname(path).slice(1).toLowerCase();
                const existing = [...current.sources.values()].find(
                    (item) => item.path === path,
                );
                const source: ToolInput = {
                    id: existing?.id ?? randomUUID(),
                    path,
                    name: basename(path),
                    size: stat.size,
                    extension,
                    kind: stat.isDirectory()
                        ? "folder"
                        : fileToolKind(extension),
                };
                if (!existing && current.sources.size >= 500)
                    throw new Error(
                        "Close and reopen file tools to choose more files.",
                    );
                current.sources.set(source.id, source);
                sources.push(source);
            } catch (error) {
                rejected.push({
                    name: typeof target === "string" ? basename(target) : "",
                    reason: message(error),
                });
            }
        }
        check(current);
        return {
            sources: sources.map(({ path: _path, ...source }) => source),
            recipes: await recipes(sources),
            rejected,
            copyMaxFiles: copyMaxFiles(),
            destinations: destinations(),
            unavailableActions: [
                ...(process.platform === "darwin" ? [] : ["share"]),
                ...(process.platform === "win32" ? [] : ["move-to"]),
                ...(process.platform === "linux" || process.mas
                    ? ["terminal"]
                    : []),
            ],
        };
    };
    const chooseDestination = async (
        sender: WebContents,
        destinationId?: unknown,
    ) => {
        if (destinationId !== undefined) {
            if (
                typeof destinationId !== "string" ||
                !destinationId ||
                destinationId.length > 80
            )
                throw new Error("Invalid saved folder.");
            if (process.mas) throw new Error(savedDestinationReason);
            const saved = options
                .destinations?.()
                .find((folder) => folder.id === destinationId);
            if (!saved)
                throw new Error("The saved folder is no longer available.");
            try {
                if (!isAbsolute(saved.path))
                    throw new Error("Not an absolute folder");
                const path = await fs.realpath(saved.path);
                if (!(await fs.stat(path)).isDirectory())
                    throw new Error("Not a folder");
                return path;
            } catch {
                throw new Error(
                    "The saved folder is unavailable. Choose another folder.",
                );
            }
        }
        const choice = await dialog.showOpenDialog(owner(sender), {
            title: "Save results to",
            properties: ["openDirectory", "createDirectory"],
        });
        return choice.canceled
            ? undefined
            : await fs.realpath(choice.filePaths[0]);
    };
    const validateTree = async (root: string, signal: AbortSignal) => {
        let bytes = 0;
        let count = 0;
        const visit = async (path: string) => {
            signal.throwIfAborted();
            const stat = await fs.lstat(path);
            if (
                ++count > 20000 ||
                stat.isSymbolicLink() ||
                (!stat.isFile() && !stat.isDirectory())
            )
                throw new Error("Unsupported file tree.");
            if (stat.isFile()) {
                bytes += stat.size;
                if (bytes > MAX_BYTES) throw new Error("Results exceed 2 GiB.");
            } else {
                for (const entry of await fs.readdir(path))
                    await visit(join(path, entry));
            }
        };
        await visit(root);
        return bytes;
    };
    type CreatedEntry = {
        path: string;
        dev: number;
        ino: number;
        directory: boolean;
    };
    const copyTree = async (
        from: string,
        to: string,
        signal: AbortSignal,
        createdEntries: CreatedEntry[],
    ) => {
        signal.throwIfAborted();
        const stat = await fs.lstat(from);
        if (stat.isSymbolicLink())
            throw new Error("Symbolic links are not supported.");
        if (stat.isDirectory()) {
            await fs.mkdir(to);
            const created = await fs.lstat(to);
            createdEntries.push({
                path: to,
                dev: created.dev,
                ino: created.ino,
                directory: true,
            });
            for (const child of await fs.readdir(from))
                await copyTree(
                    join(from, child),
                    join(to, child),
                    signal,
                    createdEntries,
                );
        } else if (stat.isFile()) {
            const file = await fs.open(to, "wx");
            const created = await file.stat();
            createdEntries.push({
                path: to,
                dev: created.dev,
                ino: created.ino,
                directory: false,
            });
            try {
                await pipeline(
                    createReadStream(from),
                    file.createWriteStream(),
                    { signal },
                );
            } finally {
                await file.close().catch(() => {});
            }
        } else throw new Error("Unsupported file type.");
    };
    const publish = async (
        path: string,
        destination: string,
        signal: AbortSignal,
    ) => {
        const name = basename(path);
        const suffix = extname(name);
        const stem = basename(name, suffix);
        for (let attempt = 0; attempt < 100; attempt++) {
            const target = join(
                destination,
                attempt ? `${stem}-${randomUUID().slice(0, 8)}${suffix}` : name,
            );
            const created: CreatedEntry[] = [];
            try {
                await copyTree(path, target, signal, created);
                return target;
            } catch (error) {
                if (
                    !created.length &&
                    (error as NodeJS.ErrnoException).code === "EEXIST"
                )
                    continue;
                for (const entry of created.reverse()) {
                    try {
                        const stat = await fs.lstat(entry.path);
                        if (
                            stat.dev !== entry.dev ||
                            stat.ino !== entry.ino ||
                            stat.isSymbolicLink()
                        )
                            continue;
                        if (entry.directory) await fs.rmdir(entry.path);
                        else await fs.unlink(entry.path);
                    } catch {}
                }
                throw error;
            }
        }
        throw new Error("Could not choose a unique output name.");
    };
    const run = async (
        sender: WebContents,
        raw: unknown,
    ): Promise<FileToolResult[]> => {
        const current = session(sender);
        if (!raw || typeof raw !== "object")
            throw new Error("Invalid file tools request.");
        const input = raw as {
            jobId?: unknown;
            sourceIds?: unknown;
            recipe?: unknown;
            options?: unknown;
            destinationId?: unknown;
        };
        if (
            typeof input.jobId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(input.jobId) ||
            typeof input.recipe !== "string"
        )
            throw new Error("Invalid job.");
        if (current.jobs.size)
            throw new Error("Wait for the current job to finish.");
        const sources = getSources(current, input.sourceIds);
        const recipeId = input.recipe;
        const toolOptions =
            input.options &&
            typeof input.options === "object" &&
            !Array.isArray(input.options)
                ? (input.options as FileToolOptions)
                : {};
        const controller = new AbortController();
        const jobId = input.jobId;
        current.jobs.set(jobId, controller);
        const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        const results: FileToolResult[] = [];
        let outputBytes = 0;
        let stage: string | undefined;
        try {
            const destination = await chooseDestination(
                sender,
                input.destinationId,
            );
            if (!destination) controller.abort();
            check(current, controller.signal);
            const combined = (await recipesFor(sources)).find(
                ({ recipe }) =>
                    recipe.id === recipeId &&
                    recipe.multiple &&
                    recipe.available,
            );
            const batches = combined
                ? [sources]
                : sources.map((source) => [source]);
            for (let index = 0; index < batches.length; index++) {
                const batch = batches[index];
                const result: FileToolResult = {
                    sourceId: batch[0].id,
                    name: batch.map((source) => source.name).join(", "),
                    status: "error",
                    outputs: [],
                };
                results.push(result);
                let preserveStaging = false;
                try {
                    check(current, controller.signal);
                    const available = (await recipesFor(batch)).find(
                        ({ recipe }) => recipe.id === recipeId,
                    );
                    if (!available || !available.recipe.available)
                        throw new Error(
                            available?.recipe.reason ??
                                "This tool does not support the selected files.",
                        );
                    if (
                        toolOptions.format &&
                        !available.recipe.formats?.includes(toolOptions.format)
                    )
                        throw new Error(
                            "This output format is not supported for this source.",
                        );
                    await fs.mkdir(stagingRoot, { recursive: true });
                    stage = await fs.mkdtemp(join(stagingRoot, "job-"));
                    const engineOutput = await available.engine.run({
                        inputs: batch,
                        recipe: recipeId,
                        options: toolOptions,
                        outputDir: stage,
                        signal: controller.signal,
                        progress: (percent) => {
                            if (current.alive && !sender.isDestroyed())
                                sender.send("oc:file-tools:progress", {
                                    jobId,
                                    completed: index,
                                    total: batches.length,
                                    percent: Math.max(
                                        0,
                                        Math.min(
                                            100,
                                            Number.isFinite(percent)
                                                ? percent
                                                : 0,
                                        ),
                                    ),
                                });
                        },
                    });
                    if (
                        !engineOutput.paths.length ||
                        engineOutput.paths.length > MAX_OUTPUTS ||
                        current.outputs.size + engineOutput.paths.length >
                            MAX_OUTPUTS
                    )
                        throw new Error(
                            "The tool produced too many results or no result.",
                        );
                    const canonicalStage = await fs.realpath(stage);
                    const verified: { path: string; size: number }[] = [];
                    for (const candidate of engineOutput.paths) {
                        if (!inside(stage, resolve(candidate)))
                            throw new Error(
                                "The result is outside the job directory.",
                            );
                        const path = await fs.realpath(candidate);
                        if (
                            !inside(canonicalStage, path) ||
                            (await fs.lstat(candidate)).isSymbolicLink()
                        )
                            throw new Error("Invalid result path.");
                        const size = await validateTree(
                            path,
                            controller.signal,
                        );
                        outputBytes += size;
                        if (outputBytes > MAX_BYTES)
                            throw new Error("Results exceed 2 GiB.");
                        verified.push({ path, size });
                    }
                    for (const file of verified) {
                        check(current, controller.signal);
                        const path = await publish(
                            file.path,
                            destination as string,
                            controller.signal,
                        );
                        const id = randomUUID();
                        current.outputs.set(id, path);
                        result.outputs.push({
                            id,
                            name: basename(path),
                            size: file.size,
                        });
                    }
                    result.status = "success";
                    result.warnings = engineOutput.warnings;
                } catch (error) {
                    preserveStaging =
                        error instanceof Error &&
                        "preserveWork" in error &&
                        error.preserveWork === true;
                    result.status =
                        !preserveStaging &&
                        (controller.signal.aborted || !current.alive)
                            ? "cancelled"
                            : "error";
                    result.error =
                        result.status === "error" ? message(error) : undefined;
                } finally {
                    if (stage && !preserveStaging)
                        await fs
                            .rm(stage, { recursive: true, force: true })
                            .catch(() => {});
                    stage = undefined;
                    if (current.alive && !sender.isDestroyed())
                        sender.send("oc:file-tools:progress", {
                            jobId,
                            completed: index + 1,
                            total: batches.length,
                            percent: 100,
                        });
                }
            }
            return results;
        } catch (error) {
            if (!controller.signal.aborted && current.alive) throw error;
            return sources.map((source) => ({
                sourceId: source.id,
                name: source.name,
                status: "cancelled",
                outputs: [],
            }));
        } finally {
            clearTimeout(timeout);
            current.jobs.delete(jobId);
        }
    };
    const copyForOwner = async (
        window: BrowserWindow,
        paths: string[],
        signal?: AbortSignal,
    ) => {
        assertCopyCount(paths);
        if (process.platform === "win32")
            await copyPathsToWindowsClipboard(
                options.root,
                window,
                paths,
                signal,
            );
        else if (process.platform === "darwin") {
            if (paths.length !== 1)
                throw new Error("Copy one file at a time on macOS.");
            const escaped = pathToFileURL(paths[0]).href;
            await clipboard.write([
                new ClipboardItem({
                    'electron application/osclipboard;format="public.file-url"':
                        escaped,
                }),
            ]);
        } else
            await clipboard.write([
                new ClipboardItem({
                    "text/uri-list": paths
                        .map((path) => pathToFileURL(path).href)
                        .join("\r\n"),
                }),
            ]);
    };
    const copyFiles = (
        sender: WebContents,
        paths: string[],
        signal?: AbortSignal,
    ) => copyForOwner(owner(sender), paths, signal);
    const floatFiles = createFileShelf({
        root: options.root,
        copy: copyForOwner,
        language: options.language,
    });
    const outputAction = async (
        sender: WebContents,
        id: unknown,
        action: unknown,
    ) => {
        const current = session(sender);
        const path =
            typeof id === "string" ? current.outputs.get(id) : undefined;
        if (!path || !existsSync(path))
            throw new Error("The output is no longer available.");
        if (action === "reveal") shell.showItemInFolder(path);
        else if (action === "copy-path") await clipboard.writeText(path);
        else if (action === "copy") await copyFiles(sender, [path]);
        else if (action === "drag") {
            const image = await app.getFileIcon(path, { size: "small" });
            check(current);
            sender.startDrag({
                file: path,
                icon: image.isEmpty()
                    ? nativeImage.createFromPath(path).resize({ width: 32 })
                    : image,
            });
        } else throw new Error("Unknown file action.");
        return true;
    };
    const sourceAction = async (
        sender: WebContents,
        ids: unknown,
        action: unknown,
        requestedJobId?: unknown,
        destinationId?: unknown,
    ) => {
        const current = session(sender);
        const sources = getSources(current, ids);
        if (
            destinationId !== undefined &&
            action !== "copy-to" &&
            action !== "move-to"
        )
            throw new Error(
                "A saved folder is only available for copy or move.",
            );
        if (current.jobs.size)
            throw new Error("Wait for the current job to finish.");
        const jobId =
            typeof requestedJobId === "string" &&
            /^[a-zA-Z0-9_-]{1,80}$/.test(requestedJobId)
                ? requestedJobId
                : "file-action";
        const controller = new AbortController();
        current.jobs.set(jobId, controller);
        const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        try {
            if (action === "copy-path")
                await clipboard.writeText(
                    sources.map((source) => source.path).join("\n"),
                );
            else if (action === "copy")
                await copyFiles(
                    sender,
                    sources.map((source) => source.path),
                    controller.signal,
                );
            else if (action === "reveal")
                shell.showItemInFolder(sources[0].path);
            else if (action === "float") {
                check(current, controller.signal);
                await floatFiles(sources, controller.signal);
            } else if (action === "edit") {
                if (sources.length !== 1 || sources[0].kind !== "image")
                    throw new Error("Choose one image to edit.");
                options.edit(sources[0].path);
            } else if (action === "share") {
                if (process.platform !== "darwin")
                    throw new Error("AirDrop is available on macOS.");
                new ShareMenu({
                    filePaths: sources.map((source) => source.path),
                }).popup({ window: owner(sender) });
            } else if (action === "terminal") {
                if (process.mas)
                    throw new Error(
                        "Opening Terminal is unavailable in the sandboxed distribution.",
                    );
                const path =
                    sources[0].kind === "folder"
                        ? sources[0].path
                        : dirname(sources[0].path);
                if (process.platform === "win32") {
                    const code = `Set-Location -LiteralPath '${path.replaceAll("'", "''")}'`;
                    const child = spawn(
                        "powershell.exe",
                        [
                            "-NoProfile",
                            "-NoExit",
                            "-EncodedCommand",
                            Buffer.from(code, "utf16le").toString("base64"),
                        ],
                        { detached: true, stdio: "ignore", windowsHide: false },
                    );
                    await new Promise<void>((done, reject) => {
                        child.once("spawn", done);
                        child.once("error", reject);
                    });
                    child.unref();
                } else if (process.platform === "darwin") {
                    await new Promise<void>((done, reject) => {
                        const child = spawn(
                            "/usr/bin/open",
                            ["-a", "Terminal", path],
                            { stdio: "ignore" },
                        );
                        child.on("error", reject);
                        child.on("exit", (code) =>
                            code === 0
                                ? done()
                                : reject(new Error("Could not open Terminal.")),
                        );
                    });
                } else
                    throw new Error(
                        "Opening Terminal is not supported on this system.",
                    );
            } else if (action === "copy-to" || action === "move-to") {
                const destination = await chooseDestination(
                    sender,
                    destinationId,
                );
                if (!destination) return { ok: false };
                check(current, controller.signal);
                for (const source of sources) {
                    check(current, controller.signal);
                    if (
                        source.kind === "folder" &&
                        (destination === source.path ||
                            inside(source.path, destination))
                    )
                        throw new Error(
                            "Choose a destination outside the source folder.",
                        );
                    if (action === "move-to") {
                        if (process.platform !== "win32")
                            throw new Error(
                                "Safe native file moving is unavailable on this platform. Copy the files instead.",
                            );
                        if (
                            dirname(source.path).toLowerCase() ===
                            destination.toLowerCase()
                        )
                            continue;
                        if (
                            (await fs.stat(source.path)).dev !==
                            (await fs.stat(destination)).dev
                        )
                            throw new Error(
                                "Moving between disks is unavailable. Copy the files instead; originals were preserved.",
                            );
                        if (
                            dirname(source.path) === source.path ||
                            source.path === options.root ||
                            source.path === options.userData ||
                            inside(source.path, options.userData) ||
                            inside(source.path, options.root)
                        )
                            throw new Error(
                                "The application, profile and filesystem root cannot be moved.",
                            );
                        const extension = extname(source.name);
                        const preferred = join(destination, source.name);
                        const target = existsSync(preferred)
                            ? join(
                                  destination,
                                  `${basename(source.name, extension)}-${randomUUID()}${extension}`,
                              )
                            : preferred;
                        if (!inside(destination, target))
                            throw new Error("Invalid destination.");
                        try {
                            await fs.lstat(target);
                            throw new Error("The destination already exists.");
                        } catch (error) {
                            if (
                                (error as NodeJS.ErrnoException).code !==
                                "ENOENT"
                            )
                                throw error;
                        }
                        check(current, controller.signal);
                        const literal = (path: string) =>
                            `'${path.replaceAll("'", "''")}'`;
                        const type =
                            source.kind === "folder" ? "Directory" : "File";
                        const code = `$ErrorActionPreference='Stop'; try { [System.IO.${type}]::Move(${literal(source.path)},${literal(target)}); [Console]::Write('MOVED') } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }`;
                        await new Promise<void>((done, reject) => {
                            execFile(
                                "powershell.exe",
                                [
                                    "-NoProfile",
                                    "-NonInteractive",
                                    "-EncodedCommand",
                                    Buffer.from(code, "utf16le").toString(
                                        "base64",
                                    ),
                                ],
                                {
                                    windowsHide: true,
                                    signal: controller.signal,
                                    timeout: 30000,
                                    maxBuffer: 8192,
                                },
                                (error, stdout, stderr) => {
                                    if (error || stdout !== "MOVED")
                                        reject(
                                            new Error(
                                                stderr.trim() ||
                                                    message(
                                                        error ??
                                                            "The file was not moved.",
                                                    ),
                                            ),
                                        );
                                    else done();
                                },
                            );
                        });
                        source.path = target;
                        source.name = basename(target);
                    } else {
                        await validateTree(source.path, controller.signal);
                        await publish(
                            source.path,
                            destination,
                            controller.signal,
                        );
                    }
                }
            } else throw new Error("Unknown file action.");
            return {
                ok: true,
                ...(action === "move-to"
                    ? {
                          sources: sources.map(
                              ({ path: _path, ...source }) => source,
                          ),
                      }
                    : {}),
            };
        } finally {
            clearTimeout(timeout);
            current.jobs.delete(jobId);
        }
    };
    return {
        select,
        run,
        outputAction,
        sourceAction,
        cancel: (sender: WebContents, id: unknown) => {
            const job =
                typeof id === "string"
                    ? sessions.get(sender.id)?.jobs.get(id)
                    : undefined;
            if (!job) return false;
            job.abort();
            return true;
        },
    };
}
