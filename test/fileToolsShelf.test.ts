import type { EventEmitter } from "node:events";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileShelfEntry } from "../lib/fileShelf";
import type { ToolInput } from "../src/main/fileToolsTypes";

type Handler = (...args: unknown[]) => unknown;
type MockFrame = { url: string };
type MockContents = EventEmitter & {
    mainFrame: MockFrame;
    windowOpenHandler?: () => unknown;
    startDrag(value: unknown): void;
};
type MockWindow = EventEmitter & {
    webContents: MockContents;
    options: unknown;
    destroyed: boolean;
    inactiveShows: number;
    isDestroyed(): boolean;
    close(): void;
    destroy(): void;
};
type MockIcon = {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(): MockIcon;
    toDataURL(): string;
};
type PermissionRequest = (
    contents: unknown,
    permission: unknown,
    callback: (value: boolean) => void,
) => void;
type MockSession = EventEmitter & {
    permissionRequest?: PermissionRequest;
    permissionCheck?: () => boolean;
    beforeRequest?: (
        details: { url: string },
        callback: (value: unknown) => void,
    ) => void;
    cleared: boolean;
};

const mocks = vi.hoisted(() => ({
    windows: [] as MockWindow[],
    sessions: [] as MockSession[],
    handlers: new Map<string, Handler>(),
    listeners: new Map<string, Handler>(),
    clipboardText: "",
    revealPath: "",
    drag: undefined as unknown,
    fileIcon: undefined as MockIcon | undefined,
    getFileIcon: vi.fn(),
    loadFile: vi.fn(),
}));

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    const icon = {
        isEmpty: () => false,
        getSize: () => ({ width: 32, height: 32 }),
        resize: () => icon,
        toDataURL: () => "data:image/png;base64,aWNvbg==",
    };
    mocks.fileIcon = icon;
    mocks.getFileIcon.mockResolvedValue(icon);
    mocks.loadFile.mockResolvedValue(undefined);
    class MockWebContents extends EventEmitter {
        mainFrame = { url: "about:blank" };
        windowOpenHandler?: () => unknown;
        startDrag(value: unknown) {
            mocks.drag = value;
        }
        setWindowOpenHandler(handler: () => unknown) {
            this.windowOpenHandler = handler;
        }
    }
    class MockBrowserWindow extends EventEmitter {
        readonly webContents = new MockWebContents();
        destroyed = false;
        inactiveShows = 0;
        alwaysOnTop: unknown;
        constructor(readonly options: unknown) {
            super();
            mocks.windows.push(this);
        }
        isDestroyed() {
            return this.destroyed;
        }
        setAlwaysOnTop(...value: unknown[]) {
            this.alwaysOnTop = value;
        }
        showInactive() {
            this.inactiveShows++;
        }
        close() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.emit("closed");
        }
        destroy() {
            this.close();
        }
        async loadFile(path: string) {
            this.webContents.mainFrame.url = pathToFileURL(path).href;
            await mocks.loadFile(this, path);
            if (!this.destroyed) this.emit("ready-to-show");
        }
    }
    return {
        BrowserWindow: MockBrowserWindow,
        app: { getFileIcon: mocks.getFileIcon },
        clipboard: {
            writeText: vi.fn((value: string) => {
                mocks.clipboardText = value;
            }),
        },
        ipcMain: {
            handle: (name: string, handler: Handler) =>
                mocks.handlers.set(name, handler),
            on: (name: string, listener: Handler) =>
                mocks.listeners.set(name, listener),
            removeHandler: (name: string) => mocks.handlers.delete(name),
            removeAllListeners: (name: string) => mocks.listeners.delete(name),
        },
        nativeImage: { createFromPath: () => icon },
        session: {
            fromPartition: vi.fn((partition: string) => {
                const value = Object.assign(new EventEmitter(), {
                    partition,
                    permissionRequest: undefined as
                        | PermissionRequest
                        | undefined,
                    permissionCheck: undefined as (() => boolean) | undefined,
                    beforeRequest: undefined as
                        | MockSession["beforeRequest"]
                        | undefined,
                    cleared: false,
                    setPermissionRequestHandler(handler: unknown) {
                        this.permissionRequest = handler;
                    },
                    setPermissionCheckHandler(handler: unknown) {
                        this.permissionCheck = handler;
                    },
                    webRequest: {
                        onBeforeRequest: (
                            _filter: unknown,
                            handler?: unknown,
                        ) => {
                            value.beforeRequest = handler;
                        },
                    },
                    async clearStorageData() {
                        this.cleared = true;
                    },
                });
                mocks.sessions.push(value);
                return value;
            }),
        },
        shell: {
            showItemInFolder: vi.fn((path: string) => {
                mocks.revealPath = path;
            }),
        },
    };
});

import { createFileShelf } from "../src/main/fileToolsShelf";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const stubPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: platform,
    });

const temporary: string[] = [];
const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "opencapture-file-shelf-"));
    temporary.push(path);
    return path;
};
const toolInput = (path: string, id: string): ToolInput => ({
    id,
    path,
    name: "renderer-controlled-name",
    size: 0,
    extension: "txt",
    kind: "other",
});
const channel = (suffix: string, map = mocks.handlers) => {
    const entry = [...map].find(([name]) => name.endsWith(`:${suffix}`));
    if (!entry) throw new Error(`Missing ${suffix} channel`);
    return entry;
};
const eventFor = (window: MockWindow) => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
    returnValue: undefined as unknown,
});

beforeEach(() => {
    mocks.windows.length = 0;
    mocks.sessions.length = 0;
    mocks.handlers.clear();
    mocks.listeners.clear();
    mocks.clipboardText = "";
    mocks.revealPath = "";
    mocks.drag = undefined;
    mocks.getFileIcon.mockReset();
    mocks.getFileIcon.mockResolvedValue(mocks.fileIcon);
    mocks.loadFile.mockReset();
    mocks.loadFile.mockResolvedValue(undefined);
});

afterEach(() => {
    if (originalPlatform)
        Object.defineProperty(process, "platform", originalPlatform);
    for (const path of temporary.splice(0))
        rmSync(path, { recursive: true, force: true });
});

describe("file tools floating shelf", () => {
    it("does not create a window when icon preparation is cancelled", async () => {
        const root = temp();
        const file = join(root, "slow-icon.txt");
        writeFileSync(file, "slow");
        let releaseIcon: ((icon: MockIcon) => void) | undefined;
        mocks.getFileIcon.mockImplementation(
            () =>
                new Promise<MockIcon>((resolveIcon) => {
                    releaseIcon = resolveIcon;
                }),
        );
        const controller = new AbortController();
        const float = createFileShelf({
            root,
            copy: vi.fn(async () => undefined),
        });
        const pending = float([toolInput(file, "source")], controller.signal);
        await vi.waitFor(() => expect(releaseIcon).toBeTypeOf("function"));
        controller.abort();
        releaseIcon?.(mocks.fileIcon!);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.windows).toHaveLength(0);
        expect(mocks.handlers.size).toBe(0);
    });

    it("destroys and cleans a window cancelled while its page loads", async () => {
        const root = temp();
        const file = join(root, "slow-page.txt");
        writeFileSync(file, "slow");
        mocks.loadFile.mockImplementation(
            (window: MockWindow) =>
                new Promise<void>((_resolve, reject) =>
                    window.once("closed", () => reject(new Error("destroyed"))),
                ),
        );
        const controller = new AbortController();
        const float = createFileShelf({
            root,
            copy: vi.fn(async () => undefined),
        });
        const pending = float([toolInput(file, "source")], controller.signal);
        await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
        await vi.waitFor(() => expect(mocks.handlers.size).toBeGreaterThan(0));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.windows[0].destroyed).toBe(true);
        expect(mocks.handlers.size).toBe(0);
        expect(mocks.listeners.size).toBe(0);
        await vi.waitFor(() => expect(mocks.sessions[0].cleared).toBe(true));
    });

    it("creates no eager window and exposes only opaque display entries", async () => {
        const root = temp();
        const sourceRoot = join(root, "sources");
        const folder = join(sourceRoot, "Folder");
        mkdirSync(folder, { recursive: true });
        const file = join(sourceRoot, "note.txt");
        writeFileSync(file, "private text");
        const copy = vi.fn(async () => undefined);
        const float = createFileShelf({
            root,
            copy,
            language: () => "unsupported-language",
        });
        expect(mocks.windows).toHaveLength(0);

        await float([
            toolInput(join(sourceRoot, "Folder", "..", "note.txt"), "source-a"),
            toolInput(folder, "source-b"),
        ]);
        expect(mocks.windows).toHaveLength(1);
        const window = mocks.windows[0];
        const windowOptions = window.options as {
            webPreferences: { additionalArguments: string[] };
        };
        expect(windowOptions).toMatchObject({
            show: false,
            frame: false,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            minWidth: 240,
            minHeight: 220,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        expect(windowOptions.webPreferences.additionalArguments).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^--file-shelf-token=/),
                "--file-shelf-lang=ko",
            ]),
        );
        expect(window.inactiveShows).toBe(1);
        const [readyName, ready] = channel("ready");
        expect(readyName).toMatch(/^oc:file-shelf:[0-9a-f-]{36}:ready$/);
        const state = ready(eventFor(window)) as {
            files: FileShelfEntry[];
            copyMaxFiles: number;
        };
        expect(state.copyMaxFiles).toBe(100);
        expect(state.files).toHaveLength(2);
        expect(JSON.stringify(state)).not.toContain(sourceRoot);
        expect(state.files.map((entry) => entry.id)).not.toContain("source-a");
        expect(state.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "note.txt",
                    folder: false,
                    icon: expect.stringMatching(/^data:image\/png/),
                }),
                expect.objectContaining({ name: "Folder", folder: true }),
            ]),
        );

        expect(() =>
            ready({
                sender: window.webContents,
                senderFrame: { ...window.webContents.mainFrame },
            }),
        ).toThrow(/Unknown file shelf/);
        expect(() =>
            ready({ sender: {}, senderFrame: window.webContents.mainFrame }),
        ).toThrow(/Unknown file shelf/);

        const translate = channel("translate", mocks.listeners)[1];
        const translated = eventFor(window);
        translate(translated, "shelf-fallback-test");
        expect(translated.returnValue).toBe("shelf-fallback-test");
        const oversizedTranslation = eventFor(window);
        translate(oversizedTranslation, "x".repeat(1001));
        expect(oversizedTranslation.returnValue).toBe("");
        const foreignTranslation = {
            sender: {},
            senderFrame: window.webContents.mainFrame,
            returnValue: undefined as unknown,
        };
        translate(foreignTranslation, "shelf-fallback-test");
        expect(foreignTranslation.returnValue).toBe("");

        const navigation = { preventDefault: vi.fn() };
        window.webContents.emit("will-navigate", navigation);
        expect(navigation.preventDefault).toHaveBeenCalledOnce();
        expect(window.webContents.windowOpenHandler()).toEqual({
            action: "deny",
        });
        const session = mocks.sessions[0];
        let permission = true;
        session.permissionRequest(null, null, (value: boolean) => {
            permission = value;
        });
        expect(permission).toBe(false);
        expect(session.permissionCheck()).toBe(false);
        let networkResult: unknown;
        session.beforeRequest(
            { url: "https://example.com/icon.png" },
            (value: unknown) => {
                networkResult = value;
            },
        );
        expect(networkResult).toEqual({ cancel: true });

        const note = state.files.find((entry) => !entry.folder);
        const folderEntry = state.files.find((entry) => entry.folder);
        expect(note).toBeDefined();
        expect(folderEntry).toBeDefined();
        const copyHandler = channel("copy")[1];
        await copyHandler(eventFor(window), [note!.id, folderEntry!.id]);
        expect(copy).toHaveBeenCalledWith(
            window,
            [realpathSync.native(file), realpathSync.native(folder)],
            expect.any(AbortSignal),
        );
        const copyPath = channel("copy-path")[1];
        await copyPath(eventFor(window), [note!.id]);
        expect(mocks.clipboardText).toBe(realpathSync.native(file));
        channel("reveal")[1](eventFor(window), note!.id);
        expect(mocks.revealPath).toBe(realpathSync.native(file));

        const drag = channel("drag", mocks.listeners)[1];
        const denied = eventFor(window);
        drag(denied, ["unknown"]);
        expect(denied.returnValue).toMatchObject({ started: false });
        const accepted = eventFor(window);
        drag(accepted, [note!.id, folderEntry!.id]);
        expect(accepted.returnValue).toEqual({ started: true });
        expect(mocks.drag).toMatchObject({
            file: realpathSync.native(file),
            files: [realpathSync.native(file), realpathSync.native(folder)],
        });
    });

    it("reports and enforces the macOS one-file copy capability", async () => {
        stubPlatform("darwin");
        const root = temp();
        const first = join(root, "first.txt");
        const second = join(root, "second.txt");
        writeFileSync(first, "first");
        writeFileSync(second, "second");
        const copy = vi.fn(async () => undefined);
        const float = createFileShelf({ root, copy: copy as never });
        await float([toolInput(first, "first"), toolInput(second, "second")]);
        const window = mocks.windows[0];
        const state = channel("ready")[1](eventFor(window)) as {
            files: FileShelfEntry[];
            copyMaxFiles: number;
        };
        expect(state.copyMaxFiles).toBe(1);
        const copyHandler = channel("copy")[1];
        await expect(
            copyHandler(
                eventFor(window),
                state.files.map((file) => file.id),
            ),
        ).rejects.toThrow("Copy one file at a time on macOS.");
        expect(copy).not.toHaveBeenCalled();
        await channel("copy-path")[1](
            eventFor(window),
            state.files.map((file) => file.id),
        );
        expect(mocks.clipboardText.split("\n")).toHaveLength(2);
        await copyHandler(eventFor(window), [state.files[0].id]);
        expect(copy).toHaveBeenCalledOnce();
    });

    it("reports the Windows 100-file copy capability", async () => {
        stubPlatform("win32");
        const root = temp();
        const file = join(root, "file.txt");
        writeFileSync(file, "file");
        const copy = vi.fn(async () => undefined);
        const float = createFileShelf({ root, copy: copy as never });
        await float([toolInput(file, "file")]);
        const state = channel("ready")[1](eventFor(mocks.windows[0])) as {
            copyMaxFiles: number;
        };
        expect(state.copyMaxFiles).toBe(100);
    });

    it("aborts copy work and removes token handlers when the shelf closes", async () => {
        const root = temp();
        const file = join(root, "secret.txt");
        writeFileSync(file, "secret");
        let copySignal: AbortSignal | undefined;
        const copy = vi.fn(
            async (_owner: unknown, _paths: string[], signal?: AbortSignal) => {
                copySignal = signal;
                await new Promise<void>((_resolve, reject) =>
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    ),
                );
            },
        );
        const float = createFileShelf({ root, copy: copy as never });
        await float([toolInput(file, "source")]);
        const window = mocks.windows[0];
        const state = channel("ready")[1](eventFor(window)) as {
            files: FileShelfEntry[];
        };
        const pending = channel("copy")[1](eventFor(window), [
            state.files[0].id,
        ]);
        await Promise.resolve();
        expect(copySignal?.aborted).toBe(false);

        channel("close", mocks.listeners)[1](eventFor(window));
        await expect(pending).rejects.toThrow("File copy cancelled.");
        expect(copySignal?.aborted).toBe(true);
        expect(mocks.handlers.size).toBe(0);
        expect(mocks.listeners.size).toBe(0);
        expect(mocks.sessions[0].beforeRequest).toBeUndefined();
        await vi.waitFor(() => expect(mocks.sessions[0].cleared).toBe(true));
    });
});
