import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeImage } from "electron";
import * as ort from "onnxruntime-node";

const MODEL_URL =
    "https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx";
const MODEL_SHA256 =
    "1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112";
const MODEL_NAME = "realesr-general-x4v3.onnx";

const SCALE = 4;
const TILE_SIZE = 128;
const MAX_INPUT_PIXELS = 4_000_000;
const MAX_OUTPUT_PIXELS = 80_000_000;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export type SuperResolutionProgress = {
    phase: "download" | "run" | "done";
    percent: number;
};

export type SuperResolution = {
    upscale(
        image: Electron.NativeImage,
        onProgress?: (progress: SuperResolutionProgress) => void,
    ): Promise<Electron.NativeImage>;
    busy(): boolean;
};

export function createSuperResolution(modelDir: string): SuperResolution {
    const modelPath = join(modelDir, MODEL_NAME);
    let sessionPromise: Promise<ort.InferenceSession> | undefined;
    let installPromise: Promise<void> | undefined;
    let running = false;

    const report = (
        onProgress: ((p: SuperResolutionProgress) => void) | undefined,
        phase: SuperResolutionProgress["phase"],
        percent: number,
    ) => onProgress?.({ phase, percent });

    async function installModel(
        onProgress?: (p: SuperResolutionProgress) => void,
    ): Promise<void> {
        if (existsSync(modelPath)) return;
        installPromise ??= (async () => {
            mkdirSync(modelDir, { recursive: true });
            const response = await fetch(MODEL_URL, {
                redirect: "follow",
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok)
                throw new Error(`AI 모델 다운로드 실패 (${response.status})`);
            const length = Number(response.headers.get("content-length") || 0);
            if (length > MAX_MODEL_BYTES)
                throw new Error("AI 모델 파일이 너무 큽니다.");
            const data = Buffer.from(await response.arrayBuffer());
            if (data.byteLength > MAX_MODEL_BYTES)
                throw new Error("AI 모델 파일이 너무 큽니다.");
            const actual = createHash("sha256").update(data).digest("hex");
            if (actual !== MODEL_SHA256)
                throw new Error("AI 모델 검증에 실패했습니다.");
            const staging = join(modelDir, `.${MODEL_NAME}.${Date.now()}`);
            await writeFile(staging, data, { flag: "wx" });
            renameSync(staging, modelPath);
            report(onProgress, "download", 100);
        })().finally(() => {
            installPromise = undefined;
        });
        return installPromise;
    }

    function session(): Promise<ort.InferenceSession> {
        sessionPromise ??= ort.InferenceSession.create(modelPath).catch(
            (error) => {
                sessionPromise = undefined;
                throw error;
            },
        );
        return sessionPromise;
    }

    async function upscale(
        image: Electron.NativeImage,
        onProgress?: (p: SuperResolutionProgress) => void,
    ): Promise<Electron.NativeImage> {
        if (running) throw new Error("이미 AI 업스케일이 실행 중입니다.");
        if (image.isEmpty()) throw new Error("이미지를 읽을 수 없습니다.");
        const { width, height } = image.getSize();
        if (width * height > MAX_INPUT_PIXELS)
            throw new Error("이미지가 너무 커서 AI 업스케일할 수 없습니다.");
        if (width * height * SCALE * SCALE > MAX_OUTPUT_PIXELS)
            throw new Error("결과 이미지가 너무 큽니다.");
        running = true;
        try {
            if (!existsSync(modelPath)) {
                report(onProgress, "download", 0);
                await installModel(onProgress);
            }
            const ortSession = await session();
            const bitmap = image.toBitmap();
            const outWidth = width * SCALE;
            const outHeight = height * SCALE;
            const output = Buffer.alloc(outWidth * outHeight * 4);
            const cols = Math.ceil(width / TILE_SIZE);
            const rows = Math.ceil(height / TILE_SIZE);
            const total = cols * rows;
            let done = 0;
            for (let ty = 0; ty < rows; ty++) {
                for (let tx = 0; tx < cols; tx++) {
                    const tw = Math.min(TILE_SIZE, width - tx * TILE_SIZE);
                    const th = Math.min(TILE_SIZE, height - ty * TILE_SIZE);
                    const input = new Float32Array(3 * tw * th);
                    for (let y = 0; y < th; y++) {
                        const rowStart =
                            ((ty * TILE_SIZE + y) * width + tx * TILE_SIZE) * 4;
                        for (let x = 0; x < tw; x++) {
                            const s = rowStart + x * 4;
                            const d = y * tw + x;
                            input[d] = bitmap[s + 2] / 255;
                            input[tw * th + d] = bitmap[s + 1] / 255;
                            input[2 * tw * th + d] = bitmap[s] / 255;
                        }
                    }
                    const tensor = new ort.Tensor("float32", input, [
                        1,
                        3,
                        th,
                        tw,
                    ]);
                    const result = await ortSession.run({ input: tensor });
                    const out = result.output.data as Float32Array;
                    const ow = tw * SCALE;
                    const oh = th * SCALE;
                    const plane = ow * oh;
                    for (let y = 0; y < oh; y++) {
                        const destRow =
                            ((ty * TILE_SIZE * SCALE + y) * outWidth +
                                tx * TILE_SIZE * SCALE) *
                            4;
                        for (let x = 0; x < ow; x++) {
                            const d = y * ow + x;
                            const o = destRow + x * 4;
                            output[o] = Math.round(
                                Math.min(1, Math.max(0, out[2 * plane + d])) *
                                    255,
                            );
                            output[o + 1] = Math.round(
                                Math.min(1, Math.max(0, out[plane + d])) * 255,
                            );
                            output[o + 2] = Math.round(
                                Math.min(1, Math.max(0, out[d])) * 255,
                            );
                            output[o + 3] = 255;
                        }
                    }
                    done++;
                    report(onProgress, "run", Math.round((done / total) * 100));
                }
            }
            report(onProgress, "done", 100);
            return nativeImage.createFromBitmap(output, {
                width: outWidth,
                height: outHeight,
            });
        } finally {
            running = false;
        }
    }

    return { upscale, busy: () => running };
}
