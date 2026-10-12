import { filterSensitiveLines } from "../../lib/redact";

export function selectSensitiveOcrLines<T extends { text: string }>(
    lines: readonly T[],
): T[] {
    return filterSensitiveLines(lines);
}

type BoxedText = {
    text: string;
    box: { x: number; y: number; width: number; height: number };
};

export function maskSensitiveLinePixels<T extends BoxedText>(
    pixels: Uint8Array,
    width: number,
    height: number,
    lines: readonly T[],
): T[] {
    const sensitiveLines = selectSensitiveOcrLines(lines);
    for (const { box } of sensitiveLines) {
        const left = Math.max(0, Math.floor(box.x));
        const top = Math.max(0, Math.floor(box.y));
        const right = Math.min(width, Math.ceil(box.x + box.width));
        const bottom = Math.min(height, Math.ceil(box.y + box.height));
        for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
                const offset = (y * width + x) * 4;
                pixels[offset] = 20;
                pixels[offset + 1] = 20;
                pixels[offset + 2] = 20;
                pixels[offset + 3] = 255;
            }
        }
    }
    return sensitiveLines;
}
