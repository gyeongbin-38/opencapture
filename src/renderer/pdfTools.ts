import {
    GlobalWorkerOptions,
    type PDFDocumentProxy,
    type PDFPageProxy,
    getDocument,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfTask = {
    bytes: Uint8Array;
    format: "png" | "jpg" | "txt" | "md";
};

type PdfPageOutput = {
    index: number;
    bytes?: Uint8Array;
    width?: number;
    height?: number;
    text?: string;
};

type PdfToolsBridge = {
    ready(): Promise<PdfTask>;
    emit(output: PdfPageOutput): Promise<void>;
    done(): Promise<void>;
    fail(message: string): void;
};

type PdfTextItem = {
    str: string;
    hasEOL: boolean;
};

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_PAGE_PIXELS = 16_000_000;
const MAX_PAGE_TEXT = 10_000_000;
const MAX_PAGE_OUTPUT = 100 * 1024 * 1024;
const RASTER_SCALE = 300 / 72;

const api = (
    window as Window & {
        pdfTools?: PdfToolsBridge;
    }
).pdfTools;

let terminal = false;

const errorMessage = (error: unknown) => {
    if (error instanceof Error && error.message.trim()) return error.message;
    const text = String(error).trim();
    return text && text !== "[object Object]" ? text : "PDF processing failed.";
};

const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true;
    api?.fail(errorMessage(error));
};

const localAssetUrl = (folder: string) =>
    new URL(`./assets/pdfjs/${folder}/`, window.location.href).href;

const dimensions = (page: PDFPageProxy) => {
    const viewport = page.getViewport({ scale: RASTER_SCALE });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > 32768 ||
        height > 32768 ||
        width * height > MAX_PAGE_PIXELS
    )
        throw new Error(
            `Page exceeds the 16 megapixel render limit (${width} × ${height}).`,
        );
    return { viewport, width, height };
};

const canvasBlob = (canvas: HTMLCanvasElement, format: "png" | "jpg") =>
    new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (blob) =>
                blob
                    ? resolve(blob)
                    : reject(new Error("Could not encode the PDF page.")),
            format === "png" ? "image/png" : "image/jpeg",
            format === "jpg" ? 0.92 : undefined,
        );
    });

async function renderPage(
    page: PDFPageProxy,
    index: number,
    format: "png" | "jpg",
) {
    const { viewport, width, height } = dimensions(page);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: format === "png" });
    if (!context) throw new Error("Canvas rendering is unavailable.");
    if (format === "jpg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
    }
    try {
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await canvasBlob(canvas, format);
        if (blob.size > MAX_PAGE_OUTPUT)
            throw new Error("Encoded PDF page exceeds 100 MiB.");
        await api?.emit({
            index,
            bytes: new Uint8Array(await blob.arrayBuffer()),
            width,
            height,
        });
    } finally {
        context.clearRect(0, 0, width, height);
        canvas.width = 1;
        canvas.height = 1;
    }
}

const pageText = async (page: PDFPageProxy, markdown: boolean) => {
    const content = await page.getTextContent({
        disableNormalization: false,
        includeMarkedContent: false,
    });
    const lines: string[] = [];
    let line = "";
    for (const item of content.items) {
        if (!("str" in item)) continue;
        const text = (item as PdfTextItem).str;
        line += text;
        if ((item as PdfTextItem).hasEOL) {
            lines.push(line.trimEnd());
            line = "";
        }
        if (line.length > MAX_PAGE_TEXT)
            throw new Error(
                "Extracted page text exceeds 10 million characters.",
            );
    }
    if (line || !lines.length) lines.push(line.trimEnd());
    const text = markdown
        ? lines
              .map((value) => value.trim())
              .filter(Boolean)
              .join("\n\n")
        : lines.join("\n");
    if (text.length > MAX_PAGE_TEXT)
        throw new Error("Extracted page text exceeds 10 million characters.");
    return text;
};

async function extractPage(
    page: PDFPageProxy,
    index: number,
    format: "txt" | "md",
) {
    await api?.emit({
        index,
        text: await pageText(page, format === "md"),
    });
}

async function processDocument(document: PDFDocumentProxy, task: PdfTask) {
    if (document.numPages < 1) throw new Error("The PDF has no pages.");
    if (document.numPages > MAX_PAGES)
        throw new Error(`PDF exceeds the ${MAX_PAGES} page limit.`);
    for (let index = 0; index < document.numPages; index++) {
        const page = await document.getPage(index + 1);
        try {
            if (task.format === "png" || task.format === "jpg")
                await renderPage(page, index, task.format);
            else await extractPage(page, index, task.format);
        } finally {
            page.cleanup();
        }
    }
}

async function run() {
    if (!api) throw new Error("PDF tools bridge is unavailable.");
    GlobalWorkerOptions.workerSrc = workerUrl;
    const task = await api.ready();
    if (
        !task ||
        !(task.bytes instanceof Uint8Array) ||
        !["png", "jpg", "txt", "md"].includes(task.format)
    )
        throw new Error("Invalid PDF task.");
    if (!task.bytes.byteLength || task.bytes.byteLength > MAX_INPUT_BYTES)
        throw new Error("PDF input must be between 1 byte and 100 MiB.");

    const loadingTask = getDocument({
        data: new Uint8Array(task.bytes),
        stopAtErrors: true,
        disableAutoFetch: true,
        disableStream: true,
        disableRange: true,
        cMapUrl: localAssetUrl("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: localAssetUrl("standard_fonts"),
        wasmUrl: localAssetUrl("wasm"),
        useWorkerFetch: true,
        useSystemFonts: false,
    });
    try {
        const document = await loadingTask.promise;
        await processDocument(document, task);
        await api.done();
        terminal = true;
    } finally {
        await loadingTask.destroy().catch(() => undefined);
    }
}

void run().catch(fail);
