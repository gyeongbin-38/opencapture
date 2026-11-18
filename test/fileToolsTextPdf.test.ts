import type { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RequestCallback = (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void,
) => void;
const state = vi.hoisted(() => ({
    windows: [] as FakeWindow[],
    sessions: [] as FakeSession[],
    printPromise: undefined as Promise<Buffer> | undefined,
}));

type FakeSession = EventEmitter & {
    permissionRequest?: unknown;
    permissionCheck?: unknown;
    request?: RequestCallback | null;
    clearStorageData: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
};
type FakeContents = EventEmitter & {
    loadedUrl: string;
    printToPDF: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
};
type FakeWindow = EventEmitter & {
    destroyed: boolean;
    webContents: FakeContents;
    isDestroyed(): boolean;
    destroy(): void;
    loadURL(url: string): Promise<void>;
};

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        BrowserWindow: class extends EventEmitter {
            destroyed = false;
            webContents = Object.assign(new EventEmitter(), {
                loadedUrl: "",
                printToPDF: vi.fn(() => state.printPromise),
                setWindowOpenHandler: vi.fn(),
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
            async loadURL(url: string) {
                this.webContents.loadedUrl = url;
            }
        },
        session: {
            fromPartition: vi.fn(() => {
                const value = Object.assign(new EventEmitter(), {
                    setPermissionRequestHandler(handler: unknown) {
                        this.permissionRequest = handler;
                    },
                    setPermissionCheckHandler(handler: unknown) {
                        this.permissionCheck = handler;
                    },
                    webRequest: {
                        onBeforeRequest(
                            _filter: unknown,
                            callback?: RequestCallback,
                        ) {
                            value.request = callback ?? null;
                        },
                    },
                    clearStorageData: vi.fn(async () => {}),
                    clearCache: vi.fn(async () => {}),
                });
                state.sessions.push(value);
                return value;
            }),
        },
    };
});

import { createTextPdfRenderer } from "../src/main/fileToolsTextPdf";

let root = "";
let outputDir = "";

beforeEach(async () => {
    state.windows.length = 0;
    state.sessions.length = 0;
    state.printPromise = undefined;
    root = await fs.mkdtemp(join(tmpdir(), "oc-text-pdf-"));
    outputDir = join(root, "output");
});

afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
});

async function pdf(pages = 1) {
    const document = await PDFDocument.create();
    for (let index = 0; index < pages; index++) document.addPage();
    return Buffer.from(await document.save());
}

async function waitForPrint() {
    await vi.waitFor(() =>
        expect(state.windows[0]?.webContents.printToPDF).toHaveBeenCalledOnce(),
    );
    return state.windows[0];
}

function render(
    text: string,
    signal = new AbortController().signal,
    progress = vi.fn(),
) {
    return createTextPdfRenderer(root)({
        text,
        name: "unsafe<script>.txt",
        outputDir,
        signal,
        progress,
    });
}

describe("plain text PDF renderer", () => {
    it("renders only escaped text in a locked private session", async () => {
        const progress = vi.fn();
        let resolvePrint!: (value: Buffer) => void;
        state.printPromise = new Promise<Buffer>((resolve) => {
            resolvePrint = resolve;
        });
        const running = render(
            "<script>globalThis.pwned=true</script>\n안녕하세요 😀",
            new AbortController().signal,
            progress,
        );
        const window = await waitForPrint();
        const html = decodeURIComponent(
            window.webContents.loadedUrl.slice(
                "data:text/html;charset=utf-8,".length,
            ),
        );
        expect(html).toContain("default-src 'none'");
        expect(html).toContain(
            "&lt;script&gt;globalThis.pwned=true&lt;/script&gt;",
        );
        expect(html).not.toContain("<script>");
        expect(html).toContain("안녕하세요 😀");
        const session = state.sessions[0];
        expect(session.permissionRequest).toBeTypeOf("function");
        expect(session.permissionCheck).toBeTypeOf("function");
        let ownRequest: { cancel: boolean } | undefined;
        session.request?.({ url: window.webContents.loadedUrl }, (result) => {
            ownRequest = result;
        });
        expect(ownRequest).toEqual({ cancel: false });
        let networkRequest: { cancel: boolean } | undefined;
        session.request?.({ url: "https://example.com/" }, (result) => {
            networkRequest = result;
        });
        expect(networkRequest).toEqual({ cancel: true });
        resolvePrint(await pdf());
        const result = await running;
        expect(result.paths.map((path) => basename(path))).toEqual([
            "unsafe-script-.pdf",
        ]);
        expect(
            (await fs.readFile(result.paths[0])).subarray(0, 5).toString(),
        ).toBe("%PDF-");
        expect(result.warnings).toEqual([
            "Only document text is retained; layout, images and advanced formatting are not preserved.",
        ]);
        expect(progress).toHaveBeenCalledWith(25);
        expect(progress).toHaveBeenCalledWith(100);
        expect(window.destroyed).toBe(true);
        expect(session.clearStorageData).toHaveBeenCalledOnce();
        expect(session.clearCache).toHaveBeenCalledOnce();
    });

    it("destroys its window on cancellation but waits for print settlement", async () => {
        let resolvePrint!: (value: Buffer) => void;
        const pendingPrint = new Promise<Buffer>((resolve) => {
            resolvePrint = resolve;
        });
        const controller = new AbortController();
        state.printPromise = pendingPrint;
        const running = render("pending print", controller.signal);
        const window = await waitForPrint();
        let settled = false;
        void running.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        controller.abort();
        await new Promise((resolve) => setImmediate(resolve));
        expect(window.destroyed).toBe(true);
        expect(settled).toBe(false);
        expect(state.sessions[0].clearStorageData).not.toHaveBeenCalled();
        resolvePrint(await pdf());
        await expect(running).rejects.toMatchObject({ name: "AbortError" });
        expect(state.sessions[0].clearStorageData).toHaveBeenCalledOnce();
        await expect(fs.readdir(outputDir)).resolves.toEqual([]);
    });

    it("rejects input and page bounds without writing output", async () => {
        await expect(render("x".repeat(128 * 1024 + 1))).rejects.toThrow(
            "128 KiB",
        );
        await expect(render("wrapped line\n".repeat(4_001))).rejects.toThrow(
            "4000-line",
        );
        expect(state.windows).toHaveLength(0);

        state.printPromise = pdf(201);
        const running = render("too many pages");
        const rejection = expect(running).rejects.toThrow("200-page");
        await waitForPrint();
        await rejection;
        await expect(fs.readdir(outputDir)).resolves.toEqual([]);
    });
});
