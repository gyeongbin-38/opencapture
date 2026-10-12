import {
    existsSync,
    mkdirSync,
    readlinkSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { type Socket, createConnection } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BrowserWindow, app, ipcMain, nativeImage } from "electron";
import { removeBackground } from "../../src/main/backgroundRemoval";
import { createTranslationService } from "../../src/main/localTranslation";
import { createSuperResolution } from "../../src/main/superResolution";
import { maskSensitiveLinePixels } from "./redaction";

const PREFIX = "OPEN_CAPTURE_LAB:";
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_DATA_URL_BYTES = 16 * 1024 * 1024;
const root = resolve(
    process.env.OPEN_CAPTURE_LAB_ROOT ?? join(__dirname, "../.."),
);
const srRoot = join(root, ".omx", "web-lab-sr");
const profileRoot = join(root, ".omx", "web-lab-profile");
const translationModels = join(profileRoot, "translation", "models");
let responseSocket: Socket | undefined;

type Operation = "cutout" | "ocr" | "upscale" | "translate" | "redact";
type Request = {
    id: number;
    operation: Operation | "status";
    dataURL?: string;
    text?: string;
    from?: string;
    to?: string;
};
type OcrLine = {
    text: string;
    box: { x: number; y: number; width: number; height: number };
    confidence?: number;
};

const write = (value: unknown) => {
    const line = `${PREFIX}${JSON.stringify(value)}\n`;
    process.stdout.write(line);
    responseSocket?.write(line);
};

function modelPairReady(path: string) {
    return (
        existsSync(join(path, "model", "model.bin")) &&
        existsSync(join(path, "model", "shared_vocabulary.txt")) &&
        existsSync(join(path, "sentencepiece.model"))
    );
}

function findTranslationModels(): string | undefined {
    const candidates = [
        join(
            root,
            ".evidence",
            "package-2026-10-11T11-09-41-124Z",
            "profile",
            "translation",
            "models",
        ),
        join(root, ".omx", "smoke-models-phase0"),
    ];
    return candidates.find(
        (candidate) =>
            modelPairReady(join(candidate, "en-ko")) &&
            modelPairReady(join(candidate, "ko-en")),
    );
}

function prepareTranslationModels(): string | undefined {
    const source = findTranslationModels();
    if (!source) return undefined;
    mkdirSync(join(profileRoot, "translation"), { recursive: true });
    if (existsSync(translationModels)) {
        try {
            if (resolve(readlinkSync(translationModels)) === resolve(source))
                return source;
        } catch {}
        rmSync(translationModels, { recursive: true, force: true });
    }
    symlinkSync(source, translationModels, "junction");
    return source;
}

const translationSource = prepareTranslationModels();
mkdirSync(profileRoot, { recursive: true });
app.setPath("userData", profileRoot);

let ocrWindow: BrowserWindow | undefined;
let ocrReady: Promise<void> | undefined;
let resolveOcrReady: (() => void) | undefined;
let nextOcrId = 1;
const ocrPending = new Map<
    number,
    {
        resolve: (value: { text: string; lines: OcrLine[] }) => void;
        reject: (error: Error) => void;
    }
>();

function createOcrWindow() {
    if (ocrWindow && !ocrWindow.isDestroyed()) return;
    ocrReady = new Promise((resolvePromise) => {
        resolveOcrReady = resolvePromise;
    });
    ocrWindow = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
            preload: join(__dirname, "ocrRenderer.cjs"),
            contextIsolation: false,
            nodeIntegration: true,
            sandbox: false,
        },
    });
    ocrWindow.on("closed", () => {
        ocrWindow = undefined;
        ocrReady = undefined;
        for (const pending of ocrPending.values())
            pending.reject(new Error("OCR renderer closed"));
        ocrPending.clear();
    });
    void ocrWindow.loadURL("about:blank");
}

ipcMain.on("lab:ocr-ready", () => {
    resolveOcrReady?.();
    resolveOcrReady = undefined;
});

ipcMain.on(
    "lab:ocr-result",
    (
        _event,
        response: {
            id: number;
            ok: boolean;
            text?: string;
            lines?: OcrLine[];
            error?: string;
        },
    ) => {
        const pending = ocrPending.get(response.id);
        if (!pending) return;
        ocrPending.delete(response.id);
        if (response.ok && typeof response.text === "string")
            pending.resolve({
                text: response.text,
                lines: response.lines ?? [],
            });
        else pending.reject(new Error(response.error ?? "OCR failed"));
    },
);

async function recognize(dataURL: string) {
    createOcrWindow();
    await ocrReady;
    const id = nextOcrId++;
    return new Promise<{ text: string; lines: OcrLine[] }>(
        (resolve, reject) => {
            ocrPending.set(id, { resolve, reject });
            ocrWindow?.webContents.send("lab:ocr-request", { id, dataURL });
        },
    );
}

function readImage(dataURL: unknown) {
    if (
        typeof dataURL !== "string" ||
        !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(dataURL) ||
        Buffer.byteLength(dataURL, "utf8") > MAX_DATA_URL_BYTES
    ) {
        throw new Error(
            "A PNG, JPEG, or WebP data URL under 16 MiB is required",
        );
    }
    const image = nativeImage.createFromDataURL(dataURL);
    if (image.isEmpty()) throw new Error("The image could not be decoded");
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS)
        throw new Error("Image exceeds the 16 megapixel processing limit");
    return { image, width, height };
}

function encodeImage(image: Electron.NativeImage) {
    const { width, height } = image.getSize();
    return { dataURL: image.toDataURL(), width, height };
}

function redactLines(image: Electron.NativeImage, lines: OcrLine[]) {
    const size = image.getSize();
    const pixels = image.toBitmap();
    const sensitiveLines = maskSensitiveLinePixels(
        pixels,
        size.width,
        size.height,
        lines,
    );
    return {
        image: nativeImage.createFromBitmap(pixels, size),
        sensitiveLines,
    };
}

const sr = createSuperResolution(srRoot);
const translation = createTranslationService({ root, userData: profileRoot });

function status() {
    const ocrFiles = [
        "ppocr6_small_det.onnx",
        "ppocr6_small_rec.onnx",
        "dic.txt",
    ].map((name) => join(root, "assets", "onnx", "ppocr", name));
    const cutoutModel = join(root, "assets", "onnx", "seg", "u2netp.onnx");
    const srModel = join(srRoot, "realesr-general-x4v3.onnx");
    const translationStatus = translation.status();
    return {
        ready: true,
        localOnly: true,
        network: {
            processingRequests: false,
            upscaleModelDownload: !existsSync(srModel),
        },
        limits: {
            bodyBytes: MAX_DATA_URL_BYTES,
            imagePixels: MAX_IMAGE_PIXELS,
        },
        capabilities: {
            cutout: {
                available: existsSync(cutoutModel),
                message: existsSync(cutoutModel)
                    ? undefined
                    : "U2Net model is missing",
            },
            ocr: {
                available: ocrFiles.every(existsSync),
                message: ocrFiles.every(existsSync)
                    ? undefined
                    : "OCR model files are missing",
            },
            upscale: {
                available: true,
                modelReady: existsSync(srModel),
                mayDownloadModel: true,
                message: existsSync(srModel)
                    ? undefined
                    : "The shared 5 MB super-resolution model downloads on first use",
            },
            translate: {
                available:
                    Boolean(translationSource) &&
                    translationStatus.runtimeReady &&
                    translationStatus.modelsReady,
                languages: translationStatus.modelsReady ? ["en", "ko"] : [],
                message: translationSource
                    ? translationStatus.message
                    : "Verified local translation models are missing",
            },
            redact: {
                available: ocrFiles.every(existsSync),
                message: ocrFiles.every(existsSync)
                    ? undefined
                    : "OCR model files are missing",
            },
        },
    };
}

async function processRequest(request: Request): Promise<unknown> {
    if (request.operation === "status") return status();
    if (request.operation === "translate") {
        if (typeof request.text !== "string" || !request.text.trim())
            throw new Error("Translation text is required");
        const from = request.from ?? "auto";
        const to = request.to ?? "ko";
        if (!(from === "auto" || from === "en" || from === "ko"))
            throw new Error("Translation source must be auto, en, or ko");
        if (!(to === "en" || to === "ko"))
            throw new Error("Translation target must be en or ko");
        if (from === to) return { text: request.text, from, to };
        const [text] = await translation.translate({
            texts: [request.text],
            from,
            to,
            engine: "local",
        });
        return { text, from, to };
    }
    const decoded = readImage(request.dataURL);
    if (request.operation === "cutout") {
        return encodeImage(await removeBackground(decoded.image, root));
    }
    if (request.operation === "upscale") {
        return encodeImage(await sr.upscale(decoded.image));
    }
    const recognized = await recognize(request.dataURL as string);
    if (request.operation === "ocr")
        return { ...recognized, width: decoded.width, height: decoded.height };
    if (request.operation === "redact") {
        const redaction = redactLines(decoded.image, recognized.lines);
        return {
            ...encodeImage(redaction.image),
            lines: recognized.lines,
            redacted: redaction.sensitiveLines.length,
        };
    }
    throw new Error("Unsupported processing operation");
}

let queue: Promise<void> = Promise.resolve();

function enqueue(request: Request) {
    queue = queue.then(async () => {
        try {
            write({
                id: request.id,
                ok: true,
                result: await processRequest(request),
            });
        } catch (error) {
            write({
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

function shutdown() {
    translation.dispose();
    ocrWindow?.destroy();
    app.quit();
}

app.whenReady().then(() => {
    createOcrWindow();
    const port = Number(process.env.OPEN_CAPTURE_LAB_PORT);
    const secret = process.env.OPEN_CAPTURE_LAB_SECRET;
    const input =
        Number.isSafeInteger(port) && port > 0 && secret
            ? createConnection({ host: "127.0.0.1", port })
            : process.stdin;
    if (input !== process.stdin) {
        responseSocket = input as Socket;
        responseSocket.write(`${JSON.stringify({ secret })}\n`);
        responseSocket.on("error", shutdown);
        responseSocket.on("close", shutdown);
    }
    write({ event: "ready", status: status() });
    const lines = createInterface({ input });
    lines.on("line", (line) => {
        try {
            const request = JSON.parse(line) as Request;
            if (!Number.isSafeInteger(request.id))
                throw new Error("A numeric request id is required");
            enqueue(request);
        } catch (error) {
            write({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    lines.on("close", shutdown);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
