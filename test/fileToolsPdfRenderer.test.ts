import type { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WorkerEvent = { sender: FakeContents; senderFrame: { url: string } };
type Handler = (event: WorkerEvent, payload?: unknown) => unknown;
type FakeContents = EventEmitter & {
    mainFrame: { url: string };
    setWindowOpenHandler(): void;
};
type FakeWindow = EventEmitter & {
    destroyed: boolean;
    webContents: FakeContents;
    isDestroyed(): boolean;
    destroy(): void;
    loadFile(path: string): Promise<void>;
};
const state = vi.hoisted(() => ({
    handlers: new Map<string, Handler>(),
    windows: [] as FakeWindow[],
}));
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        BrowserWindow: class extends EventEmitter {
            destroyed = false;
            webContents = Object.assign(new EventEmitter(), {
                mainFrame: { url: "" },
                setWindowOpenHandler: () => {},
            });
            constructor() {
                super();
                state.windows.push(this);
            }
            isDestroyed() {
                return this.destroyed;
            }
            destroy() {
                this.destroyed = true;
                this.emit("closed");
            }
            async loadFile(path: string) {
                this.webContents.mainFrame.url = pathToFileURL(path).href;
            }
        },
        ipcMain: {
            handle: (key: string, handler: Handler) =>
                state.handlers.set(key, handler),
            removeHandler: (key: string) => state.handlers.delete(key),
            on: () => {},
            removeAllListeners: () => {},
        },
        nativeImage: {},
        session: {
            fromPartition: () =>
                Object.assign(new EventEmitter(), {
                    setPermissionRequestHandler: () => {},
                    setPermissionCheckHandler: () => {},
                    webRequest: { onBeforeRequest: () => {} },
                    clearStorageData: async () => {},
                }),
        },
    };
});
import { createPdfRenderer } from "../src/main/fileToolsPdfRenderer";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const waitForHandlers = async () => {
    for (let count = 0; count < 400; count++) {
        if (
            state.handlers.size === 3 &&
            state.windows[0]?.webContents.mainFrame.url
        )
            return;
        await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error("PDF worker not ready");
};
const handler = (method: string) => {
    const entry = [...state.handlers].find(([key]) =>
        key.endsWith(`:${method}`),
    );
    if (!entry) throw new Error(`Handler not found: ${method}`);
    return entry[1];
};
const event = () => {
    const wc = state.windows[0].webContents;
    return { sender: wc, senderFrame: wc.mainFrame };
};

describe("PDF renderer I/O lifetime", () => {
    let root: string;
    let source: string;
    let outputDir: string;
    beforeEach(async () => {
        state.handlers.clear();
        state.windows.length = 0;
        root = await fs.mkdtemp(join(tmpdir(), "oc-pdf-renderer-"));
        source = join(root, "input.pdf");
        outputDir = join(root, "output");
        await fs.mkdir(outputDir);
        await fs.writeFile(source, "%PDF-1.7 test fixture");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (basename(root).startsWith("oc-pdf-renderer-"))
            await fs.rm(root, { recursive: true, force: true });
    });
    for (const cause of ["cancel", "timeout"] as const) {
        it(`waits for pending writes before returning ${cause}`, async () => {
            const entered = deferred();
            const release = deferred();
            const originalWrite = fs.writeFile.bind(fs);
            vi.spyOn(fs, "writeFile").mockImplementation((async (...args) => {
                entered.resolve();
                await release.promise;
                return await originalWrite(...args);
            }) as typeof fs.writeFile);
            const controller = new AbortController();
            let settled = false;
            const running = createPdfRenderer(root, {
                timeoutMs: cause === "timeout" ? 100 : 5000,
            })({
                path: source,
                format: "txt",
                outputDir,
                signal: controller.signal,
                progress: () => {},
            }).then(
                (value) => {
                    settled = true;
                    return value;
                },
                (error) => {
                    settled = true;
                    return error;
                },
            );
            await waitForHandlers();
            handler("ready")(event());
            await handler("page")(event(), { index: 0, text: "test content" });
            const writing = Promise.resolve(handler("done")(event())).catch(
                (error) => error,
            );
            await entered.promise;
            if (cause === "cancel") controller.abort();
            else await new Promise((done) => setTimeout(done, 130));
            expect(state.windows[0].destroyed).toBe(true);
            expect(settled).toBe(false);
            release.resolve();
            expect(await running).toBeInstanceOf(Error);
            await writing;
            expect(await fs.readdir(outputDir)).toEqual([]);
            expect(state.handlers.size).toBe(0);
        });
    }
    it("accepts only its own main frame and closes after successful text output", async () => {
        const running = createPdfRenderer(root)({
            path: source,
            format: "txt",
            outputDir,
            signal: new AbortController().signal,
            progress: () => {},
        });
        await waitForHandlers();
        expect(() =>
            handler("ready")({
                ...event(),
                senderFrame: { url: "file:///foreign.html" },
            }),
        ).toThrow("Unknown PDF worker");
        handler("ready")(event());
        await handler("page")(event(), { index: 0, text: "Hello" });
        await handler("done")(event());
        const result = await running;
        expect(await fs.readFile(result.paths[0], "utf8")).toBe("Hello");
        expect(state.windows[0].destroyed).toBe(true);
        expect(state.handlers.size).toBe(0);
    });
});
