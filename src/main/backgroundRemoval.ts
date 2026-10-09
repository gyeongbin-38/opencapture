import { join } from "node:path";
import { type NativeImage, nativeImage } from "electron";
import type * as Ort from "onnxruntime-node";

let session: Promise<Ort.InferenceSession> | undefined;
let idleRelease: ReturnType<typeof setTimeout> | undefined;
let active = 0;
export async function removeBackground(
    image: NativeImage,
    root: string,
): Promise<NativeImage> {
    if (idleRelease) clearTimeout(idleRelease);
    const { InferenceSession, Tensor } =
        require("onnxruntime-node") as typeof Ort;
    active++;
    try {
        const originalSize = image.getSize();
        if (
            image.isEmpty() ||
            originalSize.width * originalSize.height > 40_000_000
        )
            throw new Error("이미지가 비어 있거나 너무 큽니다.");
        session ??= InferenceSession.create(
            join(root, "assets/onnx/seg/u2netp.onnx"),
            { executionProviders: ["cpu"], intraOpNumThreads: 2 },
        ).catch((error) => {
            session = undefined;
            throw error;
        });
        const model = await session;
        const bitmap = image.resize({ width: 320, height: 320 }).toBitmap();
        const area = 320 * 320;
        const input = new Float32Array(3 * area);
        const means = [0.485, 0.456, 0.406];
        const deviations = [0.229, 0.224, 0.225];
        for (let pixel = 0; pixel < area; pixel++) {
            for (let channel = 0; channel < 3; channel++)
                input[channel * area + pixel] =
                    (bitmap[pixel * 4 + (2 - channel)] / 255 - means[channel]) /
                    deviations[channel];
        }
        const outputs = await model.run({
            [model.inputNames[0]]: new Tensor(
                "float32",
                input,
                [1, 3, 320, 320],
            ),
        });
        const mask = outputs[model.outputNames[0]].data as Float32Array;
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        for (const value of mask) {
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
        if (!Number.isFinite(high) || high - low < 1e-8)
            throw new Error(
                "피사체를 구분할 수 없습니다. 다른 이미지를 선택해 주세요.",
            );
        const maskBitmap = Buffer.alloc(area * 4);
        for (let i = 0; i < area; i++) {
            const value = Math.max(
                0,
                Math.min(
                    255,
                    Math.round(((mask[i] - low) / (high - low)) * 255),
                ),
            );
            maskBitmap[i * 4] = value;
            maskBitmap[i * 4 + 1] = value;
            maskBitmap[i * 4 + 2] = value;
            maskBitmap[i * 4 + 3] = 255;
        }
        const scaled = nativeImage
            .createFromBitmap(maskBitmap, { width: 320, height: 320 })
            .resize(originalSize)
            .toBitmap();
        const pixels = image.toBitmap();
        for (let i = 0; i < pixels.length; i += 4) {
            const alpha = scaled[i] / 255;
            for (let channel = 0; channel < 4; channel++)
                pixels[i + channel] = Math.round(pixels[i + channel] * alpha);
        }
        return nativeImage.createFromBitmap(pixels, originalSize);
    } finally {
        active--;
        if (active === 0) {
            idleRelease = setTimeout(() => {
                const previous = session;
                session = undefined;
                previous?.then((model) => model.release()).catch(() => {});
            }, 45000);
            idleRelease.unref();
        }
    }
}
