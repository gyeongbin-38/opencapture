import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    app,
    clipboard,
    ipcMain,
    nativeImage,
    session,
    shell,
} from "electron";
import type { FileShelfEntry } from "../../lib/fileShelf";
import { tLan } from "../../lib/translate/translate";
import type { ToolInput } from "./fileToolsTypes";

type ShelfFile = FileShelfEntry & {
    path: string;
    dragIcon: Electron.NativeImage;
};

const copyMaxFiles = () => (process.platform === "darwin" ? 1 : 100);

export function createFileShelf({
    root,
    copy,
    language,
}: {
    root: string;
    copy: (
        owner: BrowserWindow,
        paths: string[],
        signal?: AbortSignal,
    ) => Promise<void>;
    language?: () => string;
}): (inputs: ToolInput[], signal?: AbortSignal) => Promise<void> {
    return async (inputs: ToolInput[], signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100)
            throw new Error("Float accepts between 1 and 100 files.");

        const canonical = new Map<string, { path: string; folder: boolean }>();
        for (const input of inputs) {
            if (
                !input ||
                typeof input.path !== "string" ||
                !isAbsolute(input.path)
            )
                throw new Error("Float needs app-selected local paths.");
            const path = realpathSync.native(input.path);
            const stats = lstatSync(path);
            if (!stats.isFile() && !stats.isDirectory())
                throw new Error(
                    "Float supports regular files and folders only.",
                );
            canonical.set(
                process.platform === "win32" ? path.toLowerCase() : path,
                { path, folder: stats.isDirectory() },
            );
        }
        if (!canonical.size) throw new Error("Float has no usable files.");

        const applicationIcon = nativeImage.createFromPath(
            join(root, "assets", "logo", "64x64.png"),
        );
        const files: ShelfFile[] = await Promise.all(
            [...canonical.values()].map(async ({ path, folder }) => {
                signal?.throwIfAborted();
                let dragIcon = await app.getFileIcon(path, { size: "normal" });
                signal?.throwIfAborted();
                if (dragIcon.isEmpty()) dragIcon = applicationIcon;
                if (!dragIcon.isEmpty()) {
                    const size = dragIcon.getSize();
                    const scale = Math.min(
                        1,
                        48 / Math.max(size.width, size.height),
                    );
                    if (scale < 1)
                        dragIcon = dragIcon.resize({
                            width: Math.max(1, Math.round(size.width * scale)),
                            height: Math.max(
                                1,
                                Math.round(size.height * scale),
                            ),
                        });
                }
                return {
                    id: randomUUID(),
                    name: basename(path),
                    folder,
                    icon: dragIcon.isEmpty()
                        ? "data:image/png;base64,"
                        : dragIcon.toDataURL(),
                    path,
                    dragIcon,
                };
            }),
        );
        signal?.throwIfAborted();

        const token = randomUUID();
        const rawLanguage = language?.() ?? "ko";
        const shelfLanguage = [
            "ar",
            "en",
            "eo",
            "es",
            "fr",
            "ko",
            "ru",
            "zh-HANS",
            "zh-HANT",
        ].includes(rawLanguage)
            ? rawLanguage
            : "ko";
        const partition = `file-shelf-${token}`;
        const shelfSession = session.fromPartition(partition);
        const rendererRoot = resolve(root, "out", "renderer");
        const page = resolve(rendererRoot, "file_shelf.html");
        const preload = resolve(root, "out", "preload", "fileShelf.js");
        const byId = new Map(files.map((file) => [file.id, file]));
        const copyControllers = new Set<AbortController>();
        const channel = (name: string) => `oc:file-shelf:${token}:${name}`;

        shelfSession.setPermissionRequestHandler(
            (_contents, _permission, callback) => callback(false),
        );
        shelfSession.setPermissionCheckHandler(() => false);
        shelfSession.webRequest.onBeforeRequest(
            { urls: ["<all_urls>"] },
            (details, callback) => {
                let allowed = false;
                try {
                    const url = new URL(details.url);
                    if (url.protocol === "file:") {
                        const path = resolve(fileURLToPath(url));
                        const part = relative(rendererRoot, path);
                        allowed =
                            !isAbsolute(part) &&
                            part !== ".." &&
                            !part.startsWith(`..${sep}`);
                    } else allowed = url.protocol === "data:";
                } catch {}
                callback({ cancel: !allowed });
            },
        );

        const win = new BrowserWindow({
            show: false,
            width: 340,
            height: 420,
            minWidth: 240,
            minHeight: 220,
            frame: false,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            backgroundColor: "#111113",
            webPreferences: {
                preload,
                additionalArguments: [
                    `--file-shelf-token=${token}`,
                    `--file-shelf-lang=${shelfLanguage}`,
                ],
                partition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        win.setAlwaysOnTop(true, "floating");
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.on("will-attach-webview", (event) =>
            event.preventDefault(),
        );
        shelfSession.on("will-download", (event) => event.preventDefault());

        const assertShelf = (event: IpcMainEvent | IpcMainInvokeEvent) => {
            let framePath = "";
            try {
                const frameUrl = new URL(event.senderFrame?.url ?? "");
                if (frameUrl.protocol === "file:")
                    framePath = resolve(fileURLToPath(frameUrl));
            } catch {}
            if (
                win.isDestroyed() ||
                event.sender !== win.webContents ||
                event.senderFrame !== win.webContents.mainFrame ||
                framePath !== page
            )
                throw new Error("Unknown file shelf.");
        };
        const selected = (ids: unknown, multiple = true) => {
            if (
                !Array.isArray(ids) ||
                ids.length < 1 ||
                ids.length > files.length ||
                (!multiple && ids.length !== 1) ||
                ids.some((id) => typeof id !== "string") ||
                new Set(ids).size !== ids.length
            )
                throw new Error("Invalid file shelf selection.");
            return (ids as string[]).map((id) => {
                const file = byId.get(id);
                if (!file) throw new Error("Unknown file shelf item.");
                return file;
            });
        };

        ipcMain.handle(channel("ready"), (event) => {
            assertShelf(event);
            return {
                files: files.map(({ id, name, folder, icon }) => ({
                    id,
                    name,
                    folder,
                    icon,
                })),
                copyMaxFiles: copyMaxFiles(),
            };
        });
        ipcMain.handle(channel("copy"), async (event, ids: unknown) => {
            assertShelf(event);
            const paths = selected(ids).map((file) => file.path);
            if (paths.length > copyMaxFiles())
                throw new Error("Copy one file at a time on macOS.");
            const controller = new AbortController();
            copyControllers.add(controller);
            try {
                await copy(win, paths, controller.signal);
            } catch (error) {
                if (controller.signal.aborted)
                    throw new Error("File copy cancelled.");
                throw new Error("File copy failed.");
            } finally {
                copyControllers.delete(controller);
            }
        });
        ipcMain.handle(channel("copy-path"), async (event, ids: unknown) => {
            assertShelf(event);
            await clipboard.writeText(
                selected(ids)
                    .map((file) => file.path)
                    .join("\n"),
            );
        });
        ipcMain.handle(channel("reveal"), (event, id: unknown) => {
            assertShelf(event);
            const [file] = selected([id], false);
            shell.showItemInFolder(file.path);
        });
        ipcMain.on(channel("drag"), (event, ids: unknown) => {
            try {
                assertShelf(event);
                const selectedFiles = selected(ids);
                const icon = selectedFiles.find(
                    (file) => !file.dragIcon.isEmpty(),
                )?.dragIcon;
                if (!icon) throw new Error("A drag icon is unavailable.");
                event.sender.startDrag({
                    file: selectedFiles[0].path,
                    files: selectedFiles.map((file) => file.path),
                    icon,
                });
                event.returnValue = { started: true };
            } catch {
                event.returnValue = {
                    started: false,
                    error: "Native drag could not start.",
                };
            }
        });
        ipcMain.on(channel("translate"), (event, text: unknown) => {
            try {
                assertShelf(event);
                if (
                    typeof text !== "string" ||
                    text.length > 1000 ||
                    text.includes("\0")
                ) {
                    event.returnValue = "";
                    return;
                }
                event.returnValue = tLan(text, shelfLanguage).slice(0, 4000);
            } catch {
                event.returnValue = "";
            }
        });
        ipcMain.on(channel("close"), (event) => {
            try {
                assertShelf(event);
                win.close();
            } catch {}
        });

        const cleanup = () => {
            for (const controller of copyControllers) controller.abort();
            copyControllers.clear();
            for (const name of ["ready", "copy", "copy-path", "reveal"])
                ipcMain.removeHandler(channel(name));
            for (const name of ["drag", "translate", "close"])
                ipcMain.removeAllListeners(channel(name));
            shelfSession.webRequest.onBeforeRequest(null);
            void shelfSession.clearStorageData().catch(() => {});
            byId.clear();
        };
        win.once("closed", cleanup);
        win.webContents.once("render-process-gone", () => {
            if (!win.isDestroyed()) win.destroy();
        });
        win.once("ready-to-show", () => {
            if (!win.isDestroyed()) win.showInactive();
        });
        const cancelCreation = () => {
            if (!win.isDestroyed()) win.destroy();
        };
        signal?.addEventListener("abort", cancelCreation, { once: true });
        try {
            await win.loadFile(page);
            signal?.throwIfAborted();
        } catch (error) {
            if (!win.isDestroyed()) win.destroy();
            if (signal?.aborted) signal.throwIfAborted();
            throw error;
        } finally {
            signal?.removeEventListener("abort", cancelCreation);
        }
    };
}
