import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ipcRenderer } from "electron";

type OcrLine = {
    text: string;
    box: { x: number; y: number; width: number; height: number };
    confidence?: number;
};

type OcrEngine = Awaited<ReturnType<typeof import("esearch-ocr")["init"]>>;

const root = process.env.OPEN_CAPTURE_LAB_ROOT;
let enginePromise: Promise<OcrEngine> | undefined;

function getEngine(): Promise<OcrEngine> {
    if (!root)
        return Promise.reject(new Error("Lab workspace root is missing"));
    const modelRoot = join(root, "assets", "onnx", "ppocr");
    enginePromise ??= import("esearch-ocr").then(({ init }) =>
        init({
            det: {
                input: join(modelRoot, "ppocr6_small_det.onnx"),
                ratio: 0.75,
            },
            rec: {
                input: join(modelRoot, "ppocr6_small_rec.onnx"),
                decodeDic: readFileSync(join(modelRoot, "dic.txt"), "utf8"),
            },
            ort: require("onnxruntime-node"),
            ortOption: {
                executionProviders: ["cpu"],
                intraOpNumThreads: 2,
            },
        }),
    );
    return enginePromise;
}

ipcRenderer.on(
    "lab:ocr-request",
    async (_event, request: { id: number; dataURL: string }) => {
        try {
            const engine = await getEngine();
            const result = await engine.ocr(request.dataURL);
            const lines: OcrLine[] = result.src
                .map((line) => {
                    const xs = line.box.map((point) => point[0]);
                    const ys = line.box.map((point) => point[1]);
                    const x = Math.max(0, Math.min(...xs));
                    const y = Math.max(0, Math.min(...ys));
                    return {
                        text: line.text.trim(),
                        box: {
                            x,
                            y,
                            width: Math.max(0, Math.max(...xs) - x),
                            height: Math.max(0, Math.max(...ys) - y),
                        },
                        confidence: line.mean,
                    };
                })
                .filter((line) => line.text)
                .slice(0, 2_000);
            ipcRenderer.send("lab:ocr-result", {
                id: request.id,
                ok: true,
                lines,
                text: lines
                    .map((line) => line.text)
                    .join("\n")
                    .slice(0, 50_000),
            });
        } catch (error) {
            enginePromise = undefined;
            ipcRenderer.send("lab:ocr-result", {
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    },
);

window.addEventListener("DOMContentLoaded", () => {
    ipcRenderer.send("lab:ocr-ready");
});
