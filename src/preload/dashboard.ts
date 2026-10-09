import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
    OpenCaptureActionName,
    OpenCaptureApi,
    TranslationConfiguration,
    TranslationOptions,
} from "../../lib/openCaptureTypes";

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
    startDrag: (id: string) => ipcRenderer.send("oc:drag", id),
};

contextBridge.exposeInMainWorld("openCapture", api);
