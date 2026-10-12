import { nativeImage } from "electron";
import type { NamedBeautifyStyle } from "../../lib/openCaptureTypes";
import type { BoardDerivedImage } from "./captureBoardStore";

export function decodeBoundedImageDataURL(dataURL: unknown): BoardDerivedImage {
    if (
        typeof dataURL !== "string" ||
        !/^data:image\/(?:png|jpeg);base64,/.test(dataURL) ||
        Buffer.byteLength(dataURL) > 44 * 1024 * 1024
    )
        throw new Error("A bounded PNG or JPEG image is required.");
    const image = nativeImage.createFromDataURL(dataURL);
    const size = image.getSize();
    if (
        image.isEmpty() ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width * size.height > 32_000_000
    )
        throw new Error("Image exceeds 32 megapixels.");
    const png = image.toPNG();
    if (png.length > 32 * 1024 * 1024) throw new Error("Image exceeds 32 MiB.");
    return { png, width: size.width, height: size.height };
}

export function inspectPng(png: Buffer): BoardDerivedImage {
    if (png.length <= 0 || png.length > 32 * 1024 * 1024)
        throw new Error("Image exceeds 32 MiB.");
    const image = nativeImage.createFromBuffer(png);
    const size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 32_000_000)
        throw new Error("Image exceeds 32 megapixels.");
    return { png: image.toPNG(), width: size.width, height: size.height };
}

const parseColor = (value: string) => {
    const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    if (!match) return [246, 246, 246, 255] as const;
    const rgb = Number.parseInt(match[1], 16);
    return [
        (rgb >> 16) & 255,
        (rgb >> 8) & 255,
        rgb & 255,
        match[2] ? Number.parseInt(match[2], 16) : 255,
    ] as const;
};

export function beautifyPng(
    png: Buffer,
    style: NamedBeautifyStyle,
): BoardDerivedImage {
    const source = nativeImage.createFromBuffer(png);
    const sourceSize = source.getSize();
    if (source.isEmpty()) throw new Error("Board image could not be decoded.");
    const padding = Math.max(0, Math.min(256, Math.round(style.padding)));
    let width = sourceSize.width + padding * 2;
    let height = sourceSize.height + padding * 2;
    let working = source;
    if (width * height > 32_000_000) {
        const scale = Math.sqrt(32_000_000 / (width * height));
        working = source.resize({
            width: Math.max(1, Math.floor(sourceSize.width * scale)),
            height: Math.max(1, Math.floor(sourceSize.height * scale)),
            quality: "best",
        });
        const resized = working.getSize();
        width = resized.width + padding * 2;
        height = resized.height + padding * 2;
    }
    const [red, green, blue, alpha] = parseColor(style.background);
    const output = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < output.length; offset += 4) {
        output[offset] = blue;
        output[offset + 1] = green;
        output[offset + 2] = red;
        output[offset + 3] = alpha;
    }
    const bitmap = working.toBitmap();
    const size = working.getSize();
    for (let y = 0; y < size.height; y++) {
        const sourceOffset = y * size.width * 4;
        const targetOffset = ((y + padding) * width + padding) * 4;
        bitmap.copy(
            output,
            targetOffset,
            sourceOffset,
            sourceOffset + size.width * 4,
        );
    }
    const result = nativeImage.createFromBitmap(output, { width, height });
    return { png: result.toPNG(), width, height };
}

export function imagePdf(dataURL: string) {
    const image = nativeImage.createFromDataURL(dataURL);
    const size = image.getSize();
    if (
        image.isEmpty() ||
        size.width * size.height <= 0 ||
        size.width * size.height > 16_000_000
    )
        throw new Error("PDF export exceeds 16 megapixels.");
    const jpeg = image.toJPEG(92);
    const objects: Buffer[] = [];
    const add = (value: string | Buffer) =>
        objects.push(
            Buffer.isBuffer(value) ? value : Buffer.from(value, "binary"),
        );
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    );
    add(
        Buffer.concat([
            Buffer.from(
                `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
                "binary",
            ),
            jpeg,
            Buffer.from("\nendstream", "binary"),
        ]),
    );
    const content = Buffer.from(
        `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`,
        "binary",
    );
    add(
        Buffer.concat([
            Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "binary"),
            content,
            Buffer.from("\nendstream", "binary"),
        ]),
    );
    const parts: Buffer[] = [
        Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary"),
    ];
    const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
        offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
        parts.push(
            Buffer.from(`${index + 1} 0 obj\n`, "binary"),
            objects[index],
            Buffer.from("\nendobj\n", "binary"),
        );
    }
    const xref = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n`, "binary"));
    parts.push(Buffer.from("0000000000 65535 f \n", "binary"));
    for (const offset of offsets.slice(1))
        parts.push(
            Buffer.from(
                `${String(offset).padStart(10, "0")} 00000 n \n`,
                "binary",
            ),
        );
    parts.push(
        Buffer.from(
            `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
            "binary",
        ),
    );
    return Buffer.concat(parts);
}
