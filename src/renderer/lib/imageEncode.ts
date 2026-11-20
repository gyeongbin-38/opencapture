import { GIFEncoder, applyPalette, quantize } from "gifenc";

const canvasBytes = (canvas: HTMLCanvasElement, mime = "image/png") =>
    new Promise<Uint8Array | null>((resolve) =>
        canvas.toBlob(
            (blob) =>
                blob
                    ? resolve(blob.arrayBuffer().then((b) => new Uint8Array(b)))
                    : resolve(null),
            mime,
        ),
    );

export function packIco(entries: { size: number; png: Uint8Array }[]) {
    const header = new Uint8Array(6);
    const view = new DataView(header.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, entries.length, true);
    const dir = new Uint8Array(16 * entries.length);
    const dirView = new DataView(dir.buffer);
    let offset = 6 + dir.length;
    for (const [index, entry] of entries.entries()) {
        const at = index * 16;
        const dim = entry.size >= 256 ? 0 : entry.size;
        dir[at] = dim;
        dir[at + 1] = dim;
        dirView.setUint16(at + 4, 1, true);
        dirView.setUint16(at + 6, 32, true);
        dirView.setUint32(at + 8, entry.png.length, true);
        dirView.setUint32(at + 12, offset, true);
        offset += entry.png.length;
    }
    const out = new Uint8Array(offset);
    out.set(header);
    out.set(dir, 6);
    let at = 6 + dir.length;
    for (const entry of entries) {
        out.set(entry.png, at);
        at += entry.png.length;
    }
    return out;
}

export async function encodeIco(source: HTMLCanvasElement) {
    const entries: { size: number; png: Uint8Array }[] = [];
    for (const dim of [16, 32, 48]) {
        const canvas = document.createElement("canvas");
        canvas.width = dim;
        canvas.height = dim;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas context is null");
        ctx.drawImage(source, 0, 0, dim, dim);
        const png = await canvasBytes(canvas);
        if (!png) throw new Error("canvas encode failed");
        entries.push({ size: dim, png });
    }
    return packIco(entries);
}

export function encodeGif(source: HTMLCanvasElement) {
    const ctx = source.getContext("2d");
    if (!ctx) throw new Error("canvas context is null");
    const data = ctx.getImageData(0, 0, source.width, source.height);
    const palette = quantize(data.data, 256);
    const index = applyPalette(data.data, palette);
    const gif = GIFEncoder();
    gif.writeFrame(index, source.width, source.height, { palette });
    gif.finish();
    return gif.bytes();
}

export { canvasBytes };
