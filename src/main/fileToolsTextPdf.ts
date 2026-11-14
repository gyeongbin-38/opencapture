import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { BrowserWindow, session } from "electron";
import type { ToolEngineResult } from "./fileToolsTypes";

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_VISUAL_LINES = 4_000;
const MAX_PAGES = 200;
const PRINT_TIMEOUT_MS = 180_000;
const WARNING =
    "Only document text is retained; layout, images and advanced formatting are not preserved.";

type TextPdfInput = {
    text: string;
    name: string;
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
};

let pdfLibPromise: Promise<typeof import("pdf-lib")> | undefined;
function pdfLib() {
    pdfLibPromise ??= import("pdf-lib");
    return pdfLibPromise;
}

function escaped(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function validateText(value: string) {
    if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES)
        throw new Error("Document text exceeds the 128 KiB PDF limit");
    let visualLines = 0;
    for (const page of value.replaceAll("\r", "").split("\f")) {
        for (const line of page.split("\n")) {
            visualLines += Math.max(1, Math.ceil([...line].length / 90));
            if (visualLines > MAX_VISUAL_LINES)
                throw new Error(
                    "Document text exceeds the 4000-line PDF limit",
                );
        }
    }
    return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function htmlFor(text: string) {
    const pages = text.split("\f");
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>@page{size:A4;margin:18mm 16mm}html,body{margin:0;padding:0;background:#fff;color:#111}body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans CJK KR","Malgun Gothic",sans-serif;font-size:10.5pt;line-height:1.5}.page{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.page:not(:last-child){break-after:page}</style></head><body>${pages
        .map((page) => `<pre class="page">${escaped(page)}</pre>`)
        .join("")}</body></html>`;
}

function safeStem(name: string) {
    const raw = basename(name, extname(name)).replace(/[<>:"/\\|?*]/g, "-");
    const cleaned = [...raw]
        .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
        .join("")
        .trim()
        .slice(0, 100);
    return cleaned || "document";
}

async function uniqueOutput(outputDir: string, name: string) {
    const root = resolve(outputDir);
    for (let index = 0; index < 10_000; index++) {
        const suffix = index ? `-${index + 1}` : "";
        const target = resolve(root, `${name}${suffix}.pdf`);
        if (
            target !== root &&
            !target.startsWith(`${root}\\`) &&
            !target.startsWith(`${root}/`)
        )
            throw new Error("PDF output escaped its staging directory");
        try {
            await fs.stat(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return target;
            throw error;
        }
    }
    throw new Error("Could not allocate a PDF output path");
}

export function createTextPdfRenderer(_root?: string) {
    return async (input: TextPdfInput): Promise<ToolEngineResult> => {
        input.signal.throwIfAborted();
        if (!isAbsolute(input.outputDir))
            throw new Error("PDF output directory must be absolute");
        const text = validateText(input.text);
        await fs.mkdir(input.outputDir, { recursive: true });
        const token = randomUUID();
        const partition = `text-pdf-${token}`;
        const workerSession = session.fromPartition(partition, {
            cache: false,
        });
        workerSession.setPermissionRequestHandler(
            (_contents, _permission, callback) => callback(false),
        );
        workerSession.setPermissionCheckHandler(() => false);
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(htmlFor(text))}`;
        workerSession.webRequest.onBeforeRequest(
            { urls: ["<all_urls>"] },
            (details, callback) => callback({ cancel: details.url !== url }),
        );
        workerSession.on("will-download", (event) => event.preventDefault());
        const win = new BrowserWindow({
            show: false,
            width: 794,
            height: 1123,
            webPreferences: {
                partition,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webSecurity: true,
                backgroundThrottling: false,
            },
        });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event, target) => {
            if (target !== url) event.preventDefault();
        });
        let terminalError: Error | undefined;
        const terminate = (error: Error) => {
            terminalError ??= error;
            if (!win.isDestroyed()) win.destroy();
        };
        const cancel = () =>
            terminate(
                new DOMException("PDF conversion cancelled", "AbortError"),
            );
        const timeout = setTimeout(
            () => terminate(new Error("PDF conversion timed out")),
            PRINT_TIMEOUT_MS,
        );
        timeout.unref();
        input.signal.addEventListener("abort", cancel, { once: true });
        try {
            let bytes: Buffer;
            try {
                await win.loadURL(url);
                input.signal.throwIfAborted();
                input.progress(25);
                bytes = await win.webContents.printToPDF({
                    pageSize: "A4",
                    printBackground: false,
                    preferCSSPageSize: true,
                });
            } catch (error) {
                if (!terminalError)
                    terminalError =
                        error instanceof Error
                            ? error
                            : new Error(String(error));
                bytes = Buffer.alloc(0);
            }
            if (terminalError) throw terminalError;
            input.signal.throwIfAborted();
            if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
                throw new Error("Text renderer produced an invalid PDF");
            const { PDFDocument } = await pdfLib();
            const document = await PDFDocument.load(bytes, {
                ignoreEncryption: false,
                updateMetadata: false,
                throwOnInvalidObject: true,
            });
            const pages = document.getPageCount();
            if (pages < 1 || pages > MAX_PAGES)
                throw new Error("Text PDF exceeds the 200-page limit");
            input.signal.throwIfAborted();
            const output = await uniqueOutput(
                input.outputDir,
                safeStem(input.name),
            );
            try {
                await fs.writeFile(output, bytes, {
                    flag: "wx",
                    signal: input.signal,
                });
            } catch (error) {
                await fs.rm(output, { force: true });
                throw error;
            }
            input.progress(100);
            return { paths: [output], warnings: [WARNING] };
        } finally {
            clearTimeout(timeout);
            input.signal.removeEventListener("abort", cancel);
            workerSession.webRequest.onBeforeRequest(null);
            if (!win.isDestroyed()) win.destroy();
            await workerSession.clearStorageData().catch(() => {});
            await workerSession.clearCache().catch(() => {});
        }
    };
}
