import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

type RuntimeEvent = Record<string, unknown>;
const fsMock = vi.hoisted(() => ({
    delayArchiveRead: false,
    readStarted: undefined as (() => void) | undefined,
    openGate: undefined as Promise<void> | undefined,
    openStarted: undefined as (() => void) | undefined,
    openHandles: 0,
}));
const electronMock = vi.hoisted(() => {
    const handlers = new Map<
        string,
        (event: unknown, token: unknown, message: unknown) => Promise<void>
    >();
    return {
        handlers,
        events: [] as RuntimeEvent[],
        windows: [] as unknown[],
    };
});

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        async readFile(...args: Parameters<typeof actual.readFile>) {
            if (
                fsMock.delayArchiveRead &&
                /[\\/]archive\.rar$/.test(String(args[0]))
            ) {
                fsMock.readStarted?.();
                const options = args[1];
                const signal =
                    typeof options === "object" &&
                    options !== null &&
                    "signal" in options
                        ? options.signal
                        : undefined;
                if (!signal)
                    throw new Error("RAR input read did not receive a signal");
                await new Promise<void>((_resolve, reject) => {
                    const abort = () => {
                        const error = new Error("The operation was aborted");
                        error.name = "AbortError";
                        reject(error);
                    };
                    if (signal.aborted) abort();
                    else
                        signal.addEventListener("abort", abort, { once: true });
                });
            }
            return actual.readFile(...args);
        },
        async open(...args: Parameters<typeof actual.open>) {
            if (fsMock.openGate && /[\\/]value\.txt$/.test(String(args[0]))) {
                fsMock.openStarted?.();
                await fsMock.openGate;
            }
            const handle = await actual.open(...args);
            fsMock.openHandles += 1;
            const close = handle.close.bind(handle);
            let closed = false;
            handle.close = async () => {
                try {
                    return await close();
                } finally {
                    if (!closed) {
                        closed = true;
                        fsMock.openHandles -= 1;
                    }
                }
            };
            return handle;
        },
    };
});

vi.mock("electron", () => {
    class Emitter {
        listeners = new Map<string, ((...args: unknown[]) => void)[]>();
        on(name: string, callback: (...args: unknown[]) => void) {
            this.listeners.set(name, [
                ...(this.listeners.get(name) ?? []),
                callback,
            ]);
        }
        once(name: string, callback: (...args: unknown[]) => void) {
            const once = (...args: unknown[]) => {
                this.listeners.set(
                    name,
                    (this.listeners.get(name) ?? []).filter(
                        (candidate) => candidate !== once,
                    ),
                );
                callback(...args);
            };
            this.listeners.set(name, [
                ...(this.listeners.get(name) ?? []),
                once,
            ]);
        }
        emit(name: string, ...args: unknown[]) {
            for (const callback of this.listeners.get(name) ?? [])
                callback(...args);
        }
    }
    class FakeWebContents extends Emitter {
        mainFrame = { url: "" };
        session = Object.assign(new Emitter(), {
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            webRequest: { onBeforeRequest: vi.fn() },
            on: vi.fn(),
        });
        setWindowOpenHandler = vi.fn();
        send(
            _channel: string,
            command: { token: string; callbackChannel: string },
        ) {
            queueMicrotask(async () => {
                const handler = electronMock.handlers.get(
                    command.callbackChannel,
                )!;
                const event = { sender: this, senderFrame: this.mainFrame };
                for (const message of electronMock.events) {
                    try {
                        await handler(event, command.token, message);
                    } catch (error) {
                        const currentHandler = electronMock.handlers.get(
                            command.callbackChannel,
                        );
                        if (currentHandler)
                            await currentHandler(event, command.token, {
                                type: "error",
                                message:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            }).catch(() => {});
                        break;
                    }
                }
            });
        }
    }
    class BrowserWindow {
        webContents = new FakeWebContents();
        destroyed = false;
        constructor() {
            electronMock.windows.push(this);
        }
        isDestroyed() {
            return this.destroyed;
        }
        destroy() {
            this.destroyed = true;
        }
        async loadURL(url: string) {
            this.webContents.mainFrame.url = url;
            this.webContents.emit("did-finish-load");
        }
    }
    return {
        BrowserWindow,
        ipcMain: {
            handle: (
                channel: string,
                callback: (
                    event: unknown,
                    token: unknown,
                    message: unknown,
                ) => Promise<void>,
            ) => electronMock.handlers.set(channel, callback),
            removeHandler: (channel: string) =>
                electronMock.handlers.delete(channel),
        },
    };
});

import { archiveTools } from "../src/main/fileToolsArchives";
import { createRarTools } from "../src/main/fileToolsRar";

const roots: string[] = [];
const repoRoot = resolve(__dirname, "..");

afterEach(async () => {
    electronMock.events = [];
    electronMock.handlers.clear();
    electronMock.windows = [];
    fsMock.delayArchiveRead = false;
    fsMock.readStarted = undefined;
    fsMock.openGate = undefined;
    fsMock.openStarted = undefined;
    expect(fsMock.openHandles).toBe(0);
    await Promise.all(
        roots
            .splice(0)
            .map((root) => rm(root, { recursive: true, force: true })),
    );
});

async function fixtureRoot(includeRuntime = true) {
    const root = await mkdtemp(join(tmpdir(), "opencapture-rar-"));
    roots.push(root);
    await mkdir(join(root, "out", "renderer"), { recursive: true });
    await mkdir(join(root, "out", "preload"), { recursive: true });
    await writeFile(join(root, "out", "renderer", "rar_tools.html"), "html");
    await writeFile(join(root, "out", "preload", "rarTools.js"), "preload");
    if (includeRuntime) {
        const runtime = join(root, "assets", "runtime", "rar-wasm");
        await mkdir(runtime, { recursive: true });
        for (const name of ["rar-runtime.mjs", "rar-runtime.wasm"])
            await copyFile(
                join(repoRoot, "assets", "runtime", "rar-wasm", name),
                join(runtime, name),
            );
    }
    return root;
}

function input(path: string): ToolInput {
    return {
        id: path,
        name: path.split(/[\\/]/).at(-1) ?? "archive.rar",
        path,
        size: 0,
        extension: "rar",
        kind: "archive",
    };
}

async function operation(
    root: string,
    source: ToolInput,
    recipe: string,
    options: ToolContext["options"] = {},
) {
    const outputDir = join(root, `output-${recipe}-${Math.random()}`);
    await mkdir(outputDir);
    return {
        inputs: [source],
        recipe,
        options,
        outputDir,
        signal: new AbortController().signal,
        progress: vi.fn(),
    } satisfies ToolContext;
}

function regularEvents() {
    return [
        { type: "entry", path: "folder/value.txt", size: 5, entryType: 1 },
        { type: "chunk", bytes: new Uint8Array(Buffer.from("value")) },
        { type: "entry-end" },
        { type: "done" },
    ];
}

describe("createRarTools", () => {
    it("hides recipes for non-RAR input and reports missing runtime assets", async () => {
        const missing = await fixtureRoot(false);
        const missingRecipes = await createRarTools({ root: missing }).recipes([
            input(join(missing, "archive.rar")),
        ]);
        expect(missingRecipes).toHaveLength(4);
        expect(missingRecipes.every((recipe) => !recipe.available)).toBe(true);
        expect(missingRecipes[0].reason).toContain("runtime assets");
        expect(
            await createRarTools({ root: missing }).recipes([
                { ...input("image.png"), extension: "png", kind: "image" },
            ]),
        ).toEqual([]);
    });

    it("extracts validated streamed chunks beneath the staging directory", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "archive.rar");
        await writeFile(archive, "fixture");
        electronMock.events = regularEvents();
        const result = await createRarTools({ root }).run(
            await operation(root, input(archive), "archive-rar-extract"),
        );
        expect((await stat(result.paths[0])).isDirectory()).toBe(true);
        expect(
            await readFile(
                join(result.paths[0], "folder", "value.txt"),
                "utf8",
            ),
        ).toBe("value");
        expect(electronMock.handlers.size).toBe(0);
    });

    it("writes verified inspect and test reports", async () => {
        for (const recipe of ["archive-rar-inspect", "archive-rar-test"]) {
            const root = await fixtureRoot();
            const archive = join(root, "archive.rar");
            await writeFile(archive, "fixture");
            electronMock.events = regularEvents();
            const result = await createRarTools({ root }).run(
                await operation(root, input(archive), recipe),
            );
            const report = JSON.parse(await readFile(result.paths[0], "utf8"));
            expect(report).toMatchObject({
                format: "rar",
                valid: true,
                verifiedBytes: 5,
            });
        }
    });

    it.each(["zip", "tar", "gz"])(
        "repackages extracted members as %s rather than wrapping RAR bytes",
        async (format) => {
            const root = await fixtureRoot();
            const archive = join(root, "archive.rar");
            await writeFile(archive, "fixture");
            electronMock.events = regularEvents();
            const result = await createRarTools({ root }).run(
                await operation(root, input(archive), "archive-rar-convert", {
                    format,
                }),
            );
            expect(result.warnings).toContain(
                "RAR members were repacked in canonical filesystem order",
            );
            const extractedRoot = join(root, `verify-${format}`);
            await mkdir(extractedRoot);
            const extracted = await archiveTools.run({
                inputs: [
                    {
                        ...input(result.paths[0]),
                        extension: format === "gz" ? "gz" : format,
                    },
                ],
                recipe: "archive-extract",
                options: {},
                outputDir: extractedRoot,
                signal: new AbortController().signal,
                progress: () => {},
            });
            expect(
                await readFile(
                    join(extracted.paths[0], "folder", "value.txt"),
                    "utf8",
                ),
            ).toBe("value");
        },
    );

    it.each([
        [
            "path traversal",
            [
                { type: "entry", path: "../escape", size: 1, entryType: 1 },
                { type: "done" },
            ],
        ],
        [
            "duplicate path",
            [
                { type: "entry", path: "same", size: 0, entryType: 1 },
                { type: "entry-end" },
                { type: "entry", path: "SAME", size: 0, entryType: 1 },
                { type: "done" },
            ],
        ],
        [
            "oversized chunk",
            [
                { type: "entry", path: "file", size: 1, entryType: 1 },
                {
                    type: "chunk",
                    bytes: new Uint8Array(1024 * 1024 + 1),
                },
                { type: "done" },
            ],
        ],
    ])("rejects %s", async (_label, events) => {
        const root = await fixtureRoot();
        const archive = join(root, "archive.rar");
        await writeFile(archive, "fixture");
        electronMock.events = events;
        await expect(
            createRarTools({ root }).run(
                await operation(root, input(archive), "archive-rar-extract"),
            ),
        ).rejects.toThrow();
    });

    it("aborts while the initial RAR read is pending", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "archive.rar");
        await writeFile(archive, "fixture");
        const controller = new AbortController();
        const context = await operation(
            root,
            input(archive),
            "archive-rar-extract",
        );
        context.signal = controller.signal;
        fsMock.delayArchiveRead = true;
        const readStarted = new Promise<void>((resolve) => {
            fsMock.readStarted = resolve;
        });

        const result = createRarTools({ root }).run(context);
        await readStarted;
        controller.abort();

        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(electronMock.windows).toHaveLength(0);
        expect(electronMock.handlers.size).toBe(0);
    });

    it("waits for a delayed output open and closes it before cancelling", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "archive.rar");
        await writeFile(archive, "fixture");
        electronMock.events = regularEvents();
        const controller = new AbortController();
        const context = await operation(
            root,
            input(archive),
            "archive-rar-extract",
        );
        context.signal = controller.signal;
        let releaseOpen = () => {};
        fsMock.openGate = new Promise<void>((resolve) => {
            releaseOpen = resolve;
        });
        const openStarted = new Promise<void>((resolve) => {
            fsMock.openStarted = resolve;
        });

        const result = createRarTools({ root }).run(context);
        let settled = false;
        void result.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await openStarted;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(settled).toBe(false);

        releaseOpen();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(fsMock.openHandles).toBe(0);
        const partial = join(
            context.outputDir,
            "archive-extracted",
            "folder",
            "value.txt",
        );
        const returnedState = await stat(partial);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await stat(partial)).toEqual(returnedState);
    });

    it("pins production runtime hashes and real upstream RAR fixtures", async () => {
        const manifest = JSON.parse(
            await readFile(
                join(repoRoot, "assets/runtime/rar-wasm/manifest.json"),
                "utf8",
            ),
        );
        for (const [name, expected] of Object.entries<string>(
            manifest.artifacts,
        )) {
            const bytes = await readFile(
                join(repoRoot, "assets/runtime/rar-wasm", name),
            );
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(
                expected,
            );
        }
        for (const [name, signature] of [
            ["rar4.rar", "526172211a0700"],
            ["rar5.rar", "526172211a070100"],
        ]) {
            const bytes = await readFile(
                join(repoRoot, "test/fixtures/rar", name),
            );
            expect(
                bytes.subarray(0, signature.length / 2).toString("hex"),
            ).toBe(signature);
        }
    });
});
