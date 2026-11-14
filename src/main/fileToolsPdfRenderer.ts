import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
    basename,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
    BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    ipcMain,
    nativeImage,
    session,
} from "electron";
import type { ToolEngineResult } from "./fileToolsTypes";

type PdfRenderInput = {
    path: string;
    format: "png" | "jpg" | "txt" | "md";
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
};

export function createPdfRenderer(
    root: string,
    settings: { timeoutMs?: number } = {},
) {
    return async (input: PdfRenderInput): Promise<ToolEngineResult> => {
        input.signal.throwIfAborted();
        const stat = await fs.stat(input.path);
        if (
            !stat.isFile() ||
            stat.size > 100 * 1024 ** 2 ||
            !isAbsolute(input.outputDir)
        )
            throw new Error("PDF input exceeds 100 MiB.");
        const bytes = await fs.readFile(input.path);
        if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
            throw new Error("Invalid PDF file.");
        const token = randomUUID();
        const ioController = new AbortController();
        const pendingWrites = new Set<Promise<void>>();
        const writeOutput = async (path: string, data: Buffer | string) => {
            const operation = fs.writeFile(path, data, {
                flag: "wx",
                signal: ioController.signal,
            });
            pendingWrites.add(operation);
            try {
                await operation;
            } finally {
                pendingWrites.delete(operation);
            }
        };
        const partition = `pdf-tools-${token}`;
        const workerSession = session.fromPartition(partition);
        const rendererRoot = resolve(root, "out", "renderer");
        const workerPage = join(rendererRoot, "pdf_tools.html");
        workerSession.setPermissionRequestHandler(
            (_wc, _permission, callback) => callback(false),
        );
        workerSession.setPermissionCheckHandler(() => false);
        workerSession.webRequest.onBeforeRequest(
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
                    } else
                        allowed =
                            url.protocol === "blob:" ||
                            url.protocol === "data:";
                } catch {}
                callback({ cancel: !allowed });
            },
        );
        const win = new BrowserWindow({
            show: false,
            width: 32,
            height: 32,
            webPreferences: {
                preload: join(root, "out", "preload", "pdfTools.js"),
                additionalArguments: [`--pdf-tools-token=${token}`],
                partition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,
            },
        });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        workerSession.on("will-download", (event) => event.preventDefault());
        const channel = (name: string) => `oc:pdf-worker:${token}:${name}`;
        const assertWorker = (event: IpcMainEvent | IpcMainInvokeEvent) => {
            if (
                win.isDestroyed() ||
                event.sender !== win.webContents ||
                event.senderFrame !== win.webContents.mainFrame ||
                fileURLToPath(event.senderFrame.url) !== workerPage
            )
                throw new Error("Unknown PDF worker.");
            input.signal.throwIfAborted();
            ioController.signal.throwIfAborted();
        };
        return await new Promise<ToolEngineResult>((done, reject) => {
            let settled = false;
            let ready = false;
            let receiving = false;
            let nextPage = 0;
            let totalBytes = 0;
            const paths: string[] = [];
            const text: string[] = [];
            const stem =
                basename(input.path, extname(input.path))
                    .replace(/[\\/:*?"<>|\p{C}]/gu, "-")
                    .slice(0, 100) || "document";
            const cleanup = () => {
                clearTimeout(timeout);
                input.signal.removeEventListener("abort", cancel);
                for (const name of ["ready", "page", "done"])
                    ipcMain.removeHandler(channel(name));
                ipcMain.removeAllListeners(channel("error"));
                workerSession.webRequest.onBeforeRequest(null);
                if (!win.isDestroyed()) win.destroy();
                void workerSession.clearStorageData().catch(() => {});
            };
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (error) ioController.abort();
                cleanup();
                void Promise.allSettled([...pendingWrites]).then(() => {
                    if (error) reject(error);
                    else
                        done({
                            paths,
                            warnings:
                                input.format === "txt" || input.format === "md"
                                    ? [
                                          "PDF text extraction preserves text, not the original document layout.",
                                      ]
                                    : undefined,
                        });
                });
            };
            const cancel = () => finish(new Error("PDF conversion cancelled."));
            const timeout = setTimeout(
                () => finish(new Error("PDF conversion timed out.")),
                settings.timeoutMs ?? 180000,
            );
            input.signal.addEventListener("abort", cancel, { once: true });
            win.once("closed", () => {
                if (!settled) finish(new Error("PDF worker closed."));
            });
            win.webContents.on("render-process-gone", () =>
                finish(new Error("PDF worker stopped.")),
            );
            ipcMain.handle(channel("ready"), (event) => {
                assertWorker(event);
                if (ready)
                    throw new Error("PDF worker was already initialized.");
                ready = true;
                return { bytes: new Uint8Array(bytes), format: input.format };
            });
            ipcMain.handle(channel("page"), async (event, raw: unknown) => {
                assertWorker(event);
                if (!ready || receiving || !raw || typeof raw !== "object")
                    throw new Error("Invalid PDF page.");
                const page = raw as {
                    index?: unknown;
                    bytes?: unknown;
                    width?: unknown;
                    height?: unknown;
                    text?: unknown;
                };
                if (page.index !== nextPage || nextPage >= 200)
                    throw new Error("PDF page limit or order exceeded.");
                receiving = true;
                try {
                    if (input.format === "png" || input.format === "jpg") {
                        if (
                            !(page.bytes instanceof Uint8Array) ||
                            page.bytes.byteLength > 100 * 1024 ** 2 ||
                            !Number.isSafeInteger(page.width) ||
                            !Number.isSafeInteger(page.height) ||
                            (page.width as number) <= 0 ||
                            (page.height as number) <= 0 ||
                            (page.width as number) * (page.height as number) >
                                16_000_000
                        )
                            throw new Error("Invalid PDF raster page.");
                        const data = Buffer.from(page.bytes);
                        const size = nativeImage
                            .createFromBuffer(data)
                            .getSize();
                        if (
                            size.width !== page.width ||
                            size.height !== page.height ||
                            (input.format === "png"
                                ? data.subarray(0, 8).toString("hex") !==
                                  "89504e470d0a1a0a"
                                : data[0] !== 255 || data[1] !== 216)
                        )
                            throw new Error("Invalid PDF image encoding.");
                        totalBytes += data.byteLength;
                        if (totalBytes > 512 * 1024 ** 2)
                            throw new Error("PDF results exceed 512 MiB.");
                        const path = join(
                            input.outputDir,
                            `${stem}-${String(nextPage + 1).padStart(3, "0")}.${input.format}`,
                        );
                        await writeOutput(path, data);
                        paths.push(path);
                    } else {
                        if (
                            typeof page.text !== "string" ||
                            page.text.length > 10_000_000
                        )
                            throw new Error("PDF page text exceeds the limit.");
                        totalBytes += Buffer.byteLength(page.text);
                        if (totalBytes > 32 * 1024 ** 2)
                            throw new Error("PDF text exceeds 32 MiB.");
                        text.push(page.text);
                    }
                    input.signal.throwIfAborted();
                    nextPage++;
                    input.progress(Math.min(95, nextPage));
                } finally {
                    receiving = false;
                }
            });
            ipcMain.handle(channel("done"), async (event) => {
                assertWorker(event);
                if (!ready || receiving || !nextPage)
                    throw new Error("PDF contained no pages.");
                if (input.format === "txt" || input.format === "md") {
                    if (!text.some((page) => page.trim())) {
                        finish(
                            new Error(
                                "This PDF has no extractable text. Use OCR on its page images.",
                            ),
                        );
                        return;
                    }
                    const path = join(
                        input.outputDir,
                        `${stem}.${input.format}`,
                    );
                    await writeOutput(
                        path,
                        text.join(
                            input.format === "md"
                                ? "\n\n---\n\n"
                                : "\n\n\f\n\n",
                        ),
                    );
                    paths.push(path);
                }
                input.progress(100);
                finish();
            });
            ipcMain.on(channel("error"), (event, message: unknown) => {
                try {
                    assertWorker(event);
                    finish(
                        new Error(
                            typeof message === "string"
                                ? message.slice(0, 1000)
                                : "PDF processing failed.",
                        ),
                    );
                } catch (error) {
                    finish(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
            });
            if (input.signal.aborted) cancel();
            else void win.loadFile(workerPage).catch((error) => finish(error));
        });
    };
}
