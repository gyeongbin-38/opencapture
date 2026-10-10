import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
    OpenCaptureActionName,
    OpenCaptureApi,
    TranslationConfiguration,
    TranslationOptions,
} from "../../lib/openCaptureTypes";
import koStrings from "../../lib/translate/ko.json";
import sourceStrings from "../../lib/translate/source.json";

const langMaps: Record<string, Record<string, string>> = {
    ko: koStrings as Record<string, string>,
};
const source = sourceStrings as Record<string, string>;
let dashboardLang = "ko";
try {
    const stored = ipcRenderer.sendSync("oc:lang");
    if (typeof stored === "string" && stored) dashboardLang = stored;
} catch {}
const translations =
    dashboardLang === "zh-HANS" ? null : (langMaps[dashboardLang] ?? null);
const t = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !translations) return text;
    const id = source[trimmed];
    return id ? (translations[id] ?? text) : text;
};

const api: OpenCaptureApi = {
    onLibraryChanged: (callback) => {
        const listener = () => callback();
        ipcRenderer.on("oc:library-updated", listener);
        return () => ipcRenderer.removeListener("oc:library-updated", listener);
    },
    onShowLibrary: (callback) => {
        const listener = () => callback();
        ipcRenderer.on("oc:show-library", listener);
        return () => ipcRenderer.removeListener("oc:show-library", listener);
    },
    onWorkflowError: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            value: unknown,
        ) => {
            if (typeof value === "string") callback(value);
            else if (
                value &&
                typeof value === "object" &&
                "message" in value &&
                typeof value.message === "string"
            )
                callback(value.message);
        };
        ipcRenderer.on("oc:workflow-error", listener);
        return () => ipcRenderer.removeListener("oc:workflow-error", listener);
    },
    onPreviewItem: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            value: unknown,
        ) => {
            if (typeof value === "string") callback(value);
        };
        ipcRenderer.on("oc:preview-item", listener);
        return () => ipcRenderer.removeListener("oc:preview-item", listener);
    },
    onSrProgress: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            value: unknown,
        ) => {
            if (!value || typeof value !== "object") return;
            const progress = value as {
                id?: unknown;
                phase?: unknown;
                percent?: unknown;
            };
            if (
                typeof progress.id === "string" &&
                typeof progress.phase === "string" &&
                typeof progress.percent === "number"
            )
                callback({
                    id: progress.id,
                    phase: progress.phase,
                    percent: progress.percent,
                });
        };
        ipcRenderer.on("oc:sr-progress", listener);
        return () => ipcRenderer.removeListener("oc:sr-progress", listener);
    },
    action: (name: OpenCaptureActionName, payload?: unknown) =>
        ipcRenderer.invoke("oc:action", name, payload),
    getState: () => ipcRenderer.invoke("oc:state"),
    translate: (options: TranslationOptions) =>
        ipcRenderer.invoke("oc:translate", options),
    translationStatus: () => ipcRenderer.invoke("oc:translation-status"),
    installModels: () => ipcRenderer.invoke("oc:install-models"),
    configureTranslation: (config: TranslationConfiguration) =>
        ipcRenderer.invoke("oc:configure-translation", config),
    importFiles: (files: File[]) =>
        ipcRenderer.invoke(
            "oc:import-files",
            files.map((file) => webUtils.getPathForFile(file)),
        ),
    getItemData: (id: string) => ipcRenderer.invoke("oc:item-data", id),
    getItemFile: (id: string) => ipcRenderer.invoke("oc:item-file", id),
    startDrag: (id: string) => ipcRenderer.send("oc:drag", id),
    t,
};

contextBridge.exposeInMainWorld("openCapture", api);
