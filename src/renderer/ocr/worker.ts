type ElectronModule = typeof import("electron");
const { ipcRenderer, nativeImage } = require("electron") as ElectronModule;
import store from "../../../lib/store/renderStore";
import { defaultOcrId, loadOCR } from "./ocr";

let ocrPromise: ReturnType<typeof getOcr> | null = null;

async function getOcr() {
    const loaded = loadOCR(store, store.get("OCR.类型") || defaultOcrId);
    if (!loaded) throw new Error("OCR model unavailable");
    return loaded.ocr.init(loaded.config);
}

ipcRenderer.on(
    "oc:ocr-job",
    async (
        _event,
        job: {
            jobId?: unknown;
            itemId?: unknown;
            revision?: unknown;
            path?: unknown;
        },
    ) => {
        let ok = false;
        let text = "";
        let width = 0;
        let height = 0;
        let lines: Array<{
            text: string;
            box: { x: number; y: number; width: number; height: number };
            confidence?: number;
        }> = [];
        let error: string | undefined;
        try {
            if (
                typeof job?.jobId === "string" &&
                typeof job?.itemId === "string" &&
                Number.isSafeInteger(job?.revision) &&
                typeof job?.path === "string"
            ) {
                const image = nativeImage.createFromPath(job.path);
                if (!image.isEmpty()) {
                    ({ width, height } = image.getSize());
                    ocrPromise ??= getOcr();
                    const ocr = await ocrPromise;
                    const result = await ocr.ocr(image.toDataURL());
                    lines = result.src
                        .map((line) => {
                            const value = line.text.trim();
                            const xs = line.box.map((point) => point[0]);
                            const ys = line.box.map((point) => point[1]);
                            const x = Math.max(0, Math.min(...xs));
                            const y = Math.max(0, Math.min(...ys));
                            return {
                                text: value,
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
                    text = lines
                        .map((line) => line.text)
                        .join("\n")
                        .slice(0, 50_000);
                    ok = true;
                }
            }
        } catch (cause) {
            console.error("ocr worker failed", cause);
            error = cause instanceof Error ? cause.message : String(cause);
        }
        ipcRenderer.send("oc:ocr-result", {
            jobId: job?.jobId,
            itemId: job?.itemId,
            revision: job?.revision,
            width,
            height,
            lines,
            text,
            ok,
            error,
        });
    },
);
