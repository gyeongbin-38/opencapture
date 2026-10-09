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
    async (_event, job: { id?: unknown; path?: unknown }) => {
        let ok = false;
        let text = "";
        try {
            if (typeof job?.id === "string" && typeof job?.path === "string") {
                const image = nativeImage.createFromPath(job.path);
                if (!image.isEmpty()) {
                    ocrPromise ??= getOcr();
                    const ocr = await ocrPromise;
                    const result = await ocr.ocr(image.toDataURL());
                    text = result.src
                        .map((line) => line.text.trim())
                        .filter(Boolean)
                        .join("\n")
                        .slice(0, 50_000);
                    ok = true;
                }
            }
        } catch (error) {
            console.error("ocr worker failed", error);
        }
        ipcRenderer.send("oc:ocr-result", { id: job?.id, ok, text });
    },
);
