import { BOARD_LIMITS } from "../lib/captureBoard";
import type { NamedBeautifyStyle } from "../lib/openCaptureTypes";

export type BrowserImage = {
    dataURL: string;
    width: number;
    height: number;
    bytes: number;
};

const bytesToDataURL = (bytes: Uint8Array, type: string) => {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk)
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    return `data:${type};base64,${btoa(binary)}`;
};

export function dataURLBytes(dataURL: string) {
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataURL);
    if (!match) throw new Error("A base64 image data URL is required.");
    const binary = atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
    return { type: match[1].toLowerCase(), bytes };
}

export function dataURLBlob(dataURL: string) {
    const decoded = dataURLBytes(dataURL);
    return new Blob([decoded.bytes], { type: decoded.type });
}

const blobDataURL = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
            reject(reader.error ?? new Error("Image read failed."));
        reader.readAsDataURL(blob);
    });

const canvasBlob = (
    canvas: HTMLCanvasElement,
    type: string,
    quality?: number,
) =>
    new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
            (blob) =>
                blob
                    ? resolve(blob)
                    : reject(new Error("Image encoding failed.")),
            type,
            quality,
        ),
    );

const loadBitmap = async (dataURL: string) => {
    const blob = dataURLBlob(dataURL);
    if (blob.size <= 0 || blob.size > BOARD_LIMITS.assetBytes)
        throw new Error("Image exceeds 32 MiB.");
    const bitmap = await createImageBitmap(blob);
    if (
        bitmap.width <= 0 ||
        bitmap.height <= 0 ||
        bitmap.width * bitmap.height > BOARD_LIMITS.assetPixels
    ) {
        bitmap.close();
        throw new Error("Image exceeds 32 megapixels.");
    }
    return bitmap;
};

const canvasFor = (width: number, height: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
};

export async function normalizeImage(dataURL: string): Promise<BrowserImage> {
    const bitmap = await loadBitmap(dataURL);
    try {
        const canvas = canvasFor(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Canvas is unavailable.");
        context.drawImage(bitmap, 0, 0);
        const blob = await canvasBlob(canvas, "image/png");
        if (blob.size > BOARD_LIMITS.assetBytes)
            throw new Error("Normalized image exceeds 32 MiB.");
        return {
            dataURL: await blobDataURL(blob),
            width: bitmap.width,
            height: bitmap.height,
            bytes: blob.size,
        };
    } finally {
        bitmap.close();
    }
}

export async function resizeImage(
    dataURL: string,
    maxEdge = BOARD_LIMITS.previewEdge,
) {
    const bitmap = await loadBitmap(dataURL);
    try {
        const scale = Math.min(
            1,
            maxEdge / Math.max(bitmap.width, bitmap.height),
        );
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = canvasFor(width, height);
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Canvas is unavailable.");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, width, height);
        return blobDataURL(await canvasBlob(canvas, "image/png"));
    } finally {
        bitmap.close();
    }
}

const roundedPath = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
) => {
    const r = Math.min(Math.max(0, radius), width / 2, height / 2);
    context.beginPath();
    context.roundRect(x, y, width, height, r);
};

export async function beautifyImage(
    dataURL: string,
    style: NamedBeautifyStyle,
): Promise<BrowserImage> {
    const bitmap = await loadBitmap(dataURL);
    try {
        const padding = Math.max(0, Math.min(256, Math.round(style.padding)));
        let scale = 1;
        let width = bitmap.width + padding * 2;
        let height = bitmap.height + padding * 2;
        if (width * height > BOARD_LIMITS.assetPixels) {
            scale = Math.sqrt(
                BOARD_LIMITS.assetPixels / Math.max(1, width * height),
            );
            width = Math.max(1, Math.floor(bitmap.width * scale)) + padding * 2;
            height =
                Math.max(1, Math.floor(bitmap.height * scale)) + padding * 2;
        }
        const canvas = canvasFor(width, height);
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Canvas is unavailable.");
        context.fillStyle = /^#[0-9a-f]{6,8}$/i.test(style.background)
            ? style.background
            : "#f6f6f6";
        context.fillRect(0, 0, width, height);
        const imageWidth = Math.max(1, Math.floor(bitmap.width * scale));
        const imageHeight = Math.max(1, Math.floor(bitmap.height * scale));
        context.save();
        context.shadowColor = "rgba(0,0,0,.38)";
        context.shadowBlur = Math.max(0, Math.min(64, style.shadow));
        context.shadowOffsetY = Math.max(0, Math.min(24, style.shadow / 3));
        roundedPath(
            context,
            padding,
            padding,
            imageWidth,
            imageHeight,
            Math.max(0, Math.min(128, style.radius)),
        );
        context.clip();
        context.drawImage(bitmap, padding, padding, imageWidth, imageHeight);
        context.restore();
        const blob = await canvasBlob(canvas, "image/png");
        if (blob.size > BOARD_LIMITS.assetBytes)
            throw new Error("Styled image exceeds 32 MiB.");
        return {
            dataURL: await blobDataURL(blob),
            width,
            height,
            bytes: blob.size,
        };
    } finally {
        bitmap.close();
    }
}

const concat = (parts: Uint8Array[]) => {
    const output = new Uint8Array(
        parts.reduce((total, part) => total + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
};

export async function imagePdf(dataURL: string) {
    const bitmap = await loadBitmap(dataURL);
    try {
        if (bitmap.width * bitmap.height > BOARD_LIMITS.exportPixels)
            throw new Error("PDF export exceeds 16 megapixels.");
        const canvas = canvasFor(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, bitmap.width, bitmap.height);
        context.drawImage(bitmap, 0, 0);
        const jpeg = new Uint8Array(
            await (await canvasBlob(canvas, "image/jpeg", 0.92)).arrayBuffer(),
        );
        const encode = (value: string) => new TextEncoder().encode(value);
        const content = encode(
            `q ${bitmap.width} 0 0 ${bitmap.height} 0 0 cm /Im0 Do Q`,
        );
        const objects = [
            encode("<< /Type /Catalog /Pages 2 0 R >>"),
            encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
            encode(
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${bitmap.width} ${bitmap.height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
            ),
            concat([
                encode(
                    `<< /Type /XObject /Subtype /Image /Width ${bitmap.width} /Height ${bitmap.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
                ),
                jpeg,
                encode("\nendstream"),
            ]),
            concat([
                encode(`<< /Length ${content.byteLength} >>\nstream\n`),
                content,
                encode("\nendstream"),
            ]),
        ];
        const parts = [encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
        const offsets = [0];
        for (let index = 0; index < objects.length; index += 1) {
            offsets.push(parts.reduce((sum, part) => sum + part.byteLength, 0));
            parts.push(
                encode(`${index + 1} 0 obj\n`),
                objects[index],
                encode("\nendobj\n"),
            );
        }
        const xref = parts.reduce((sum, part) => sum + part.byteLength, 0);
        parts.push(encode(`xref\n0 ${objects.length + 1}\n`));
        parts.push(encode("0000000000 65535 f \n"));
        for (const offset of offsets.slice(1))
            parts.push(
                encode(`${String(offset).padStart(10, "0")} 00000 n \n`),
            );
        parts.push(
            encode(
                `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
            ),
        );
        return new Blob([concat(parts)], { type: "application/pdf" });
    } finally {
        bitmap.close();
    }
}

export function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadDataURL(dataURL: string, name: string) {
    downloadBlob(dataURLBlob(dataURL), name);
}

export function pickTextFile(accept = ".json,.ocboard") {
    return new Promise<string | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = async () => {
            const file = input.files?.[0];
            resolve(file ? file.text() : null);
        };
        input.addEventListener("cancel", () => resolve(null), { once: true });
        input.click();
    });
}

export const rawDataURL = (bytes: Uint8Array, type: string) =>
    bytesToDataURL(bytes, type);
