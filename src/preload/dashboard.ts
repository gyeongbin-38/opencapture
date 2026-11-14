import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
    OpenCaptureActionName,
    OpenCaptureApi,
    TranslationConfiguration,
    TranslationOptions,
} from "../../lib/openCaptureTypes";
import arStrings from "../../lib/translate/ar.json";
import enStrings from "../../lib/translate/en.json";
import eoStrings from "../../lib/translate/eo.json";
import esStrings from "../../lib/translate/es.json";
import frStrings from "../../lib/translate/fr.json";
import koStrings from "../../lib/translate/ko.json";
import ruStrings from "../../lib/translate/ru.json";
import sourceStrings from "../../lib/translate/source.json";
import zhHantStrings from "../../lib/translate/zh-HANT.json";

const langMaps: Record<string, Record<string, string>> = {
    ar: arStrings as Record<string, string>,
    en: enStrings as Record<string, string>,
    eo: eoStrings as Record<string, string>,
    es: esStrings as Record<string, string>,
    fr: frStrings as Record<string, string>,
    ko: koStrings as Record<string, string>,
    ru: ruStrings as Record<string, string>,
    "zh-HANT": zhHantStrings as Record<string, string>,
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
    fileTools: {
        select: (paths, mode) =>
            ipcRenderer.invoke("oc:file-tools:select", paths, mode),
        run: (input) => ipcRenderer.invoke("oc:file-tools:run", input),
        cancel: (id) => ipcRenderer.invoke("oc:file-tools:cancel", id),
        outputAction: (id, action) =>
            ipcRenderer.invoke("oc:file-tools:output-action", id, action),
        sourceAction: (ids, action, jobId, destinationId) =>
            ipcRenderer.invoke(
                "oc:file-tools:source-action",
                ids,
                action,
                jobId,
                destinationId,
            ),
        onProgress: (callback) => {
            const listener = (
                _event: Electron.IpcRendererEvent,
                value: unknown,
            ) => {
                if (!value || typeof value !== "object") return;
                const progress = value as Record<string, unknown>;
                if (
                    typeof progress.jobId !== "string" ||
                    ![
                        progress.completed,
                        progress.total,
                        progress.percent,
                    ].every(
                        (number) =>
                            typeof number === "number" &&
                            Number.isFinite(number),
                    )
                )
                    return;
                callback(
                    value as import("../../lib/fileTools").FileToolProgress,
                );
            };
            ipcRenderer.on("oc:file-tools:progress", listener);
            return () =>
                ipcRenderer.removeListener("oc:file-tools:progress", listener);
        },
    },
    boards: {
        status: () => ipcRenderer.invoke("oc:boards:status"),
        list: () => ipcRenderer.invoke("oc:boards:list"),
        create: (name) => ipcRenderer.invoke("oc:boards:create", name),
        load: (id) => ipcRenderer.invoke("oc:boards:load", id),
        save: (document, expectedRevision) =>
            ipcRenderer.invoke("oc:boards:save", document, expectedRevision),
        setActive: (id) => ipcRenderer.invoke("oc:boards:set-active", id),
        addItems: (boardId, itemIds, expectedRevision) =>
            ipcRenderer.invoke(
                "oc:boards:add-items",
                boardId,
                itemIds,
                expectedRevision,
            ),
        assetData: (boardId, assetId, quality) =>
            ipcRenderer.invoke(
                "oc:boards:asset-data",
                boardId,
                assetId,
                quality,
            ),
        cutout: (boardId, nodeId, sourceAssetId) =>
            ipcRenderer.invoke(
                "oc:boards:cutout",
                boardId,
                nodeId,
                sourceAssetId,
            ),
        beautify: (boardId, images, style) =>
            ipcRenderer.invoke("oc:boards:beautify", boardId, images, style),
        exportFile: (boardId, format, dataURL) =>
            ipcRenderer.invoke(
                "oc:boards:export-file",
                boardId,
                format,
                dataURL,
            ),
        discardDerived: (boardId, assetIds) =>
            ipcRenderer.invoke("oc:boards:discard-derived", boardId, assetIds),
        exportPortable: (boardId) =>
            ipcRenderer.invoke("oc:boards:export-portable", boardId),
        importPortable: () => ipcRenderer.invoke("oc:boards:import-portable"),
        pendingCaptures: () => ipcRenderer.invoke("oc:boards:pending-captures"),
        ackCapture: (itemId, targetBoardId) =>
            ipcRenderer.invoke("oc:boards:ack-capture", itemId, targetBoardId),
        onCaptureAdded: (callback) => {
            const listener = (
                _event: Electron.IpcRendererEvent,
                value: unknown,
            ) => {
                if (
                    value &&
                    typeof value === "object" &&
                    "itemId" in value &&
                    "targetBoardId" in value &&
                    typeof value.itemId === "string" &&
                    typeof value.targetBoardId === "string"
                )
                    callback(value as Parameters<typeof callback>[0]);
            };
            ipcRenderer.on("oc:boards:capture-added", listener);
            return () =>
                ipcRenderer.removeListener("oc:boards:capture-added", listener);
        },
    },
    cutoutImage: (input) => ipcRenderer.invoke("oc:image:cutout", input),
    onBoardFlushRequested: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            requestId: unknown,
        ) => {
            if (typeof requestId === "string") callback(requestId);
        };
        ipcRenderer.on("oc:boards:flush-requested", listener);
        return () =>
            ipcRenderer.removeListener("oc:boards:flush-requested", listener);
    },
    ackBoardFlush: (requestId, ok, message) =>
        ipcRenderer.invoke("oc:boards:flush-ack", requestId, ok, message),
    finishBoardClose: () => ipcRenderer.invoke("oc:boards:finish-close"),
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
    convertItem: (
        id: string,
        format: string,
        data?: Uint8Array,
        options?: unknown,
    ) => ipcRenderer.invoke("oc:items:convert", { id, format, data, options }),
    convertPath: (
        path: string,
        format: string,
        data?: Uint8Array,
        options?: unknown,
    ) =>
        ipcRenderer.invoke("oc:paths:convert", { path, format, data, options }),
    previewItem: (
        id: string,
        format: string,
        data?: Uint8Array,
        options?: unknown,
    ) => ipcRenderer.invoke("oc:items:preview", { id, format, data, options }),
    previewPath: (
        path: string,
        format: string,
        data?: Uint8Array,
        options?: unknown,
    ) =>
        ipcRenderer.invoke("oc:paths:preview", { path, format, data, options }),
    registerConvertedPaths: (paths: string[]) =>
        ipcRenderer.invoke("oc:converted:register", paths),
    dragConvertedPath: (path: string) =>
        ipcRenderer.invoke("oc:converted:drag", path),
    revealPath: (path: string) => ipcRenderer.invoke("oc:reveal-path", path),
    importPaths: (paths: string[]) =>
        ipcRenderer.invoke("oc:import-files", paths),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    readFilePath: (path: string) => ipcRenderer.invoke("oc:file:read", path),
    dragFilePath: (path: string) => ipcRenderer.send("oc:drag-path", path),
    startDrag: (id: string) => ipcRenderer.send("oc:drag", id),
    getLanguageSettings: () => ipcRenderer.invoke("oc:language:get"),
    setLanguage: (language) => ipcRenderer.invoke("oc:language:set", language),
    shelfAction: (name, id) => ipcRenderer.invoke("oc:shelf:action", name, id),
    listPins: () => ipcRenderer.invoke("oc:pins:list"),
    pinAction: (action, id) => ipcRenderer.invoke("oc:pins:action", action, id),
    pinWorkspace: (op, name, opts) =>
        ipcRenderer.invoke("oc:pins:workspace", op, name, opts),
    getPreferences: () => ipcRenderer.invoke("oc:preferences:get"),
    configureExperience: (patch) =>
        ipcRenderer.invoke("oc:preferences:configure", patch),
    stageCapture: (input) => ipcRenderer.invoke("oc:draft:stage", input),
    getDraft: (id) => ipcRenderer.invoke("oc:draft:get", id),
    recognizeItem: (id) => ipcRenderer.invoke("oc:ocr:recognize", id),
    queryItems: (query) => ipcRenderer.invoke("oc:items:query", query),
    promoteItems: (ids) => ipcRenderer.invoke("oc:items:promote", ids),
    repairDraft: (id: string) =>
        ipcRenderer.invoke("oc:items:repair-draft", id),
    trashItems: (ids) => ipcRenderer.invoke("oc:items:trash", ids),
    restoreItems: (ids) => ipcRenderer.invoke("oc:items:restore", ids),
    copySourceFiles: (ids) => ipcRenderer.invoke("oc:items:copy-source", ids),
    requestComparison: (ids) => ipcRenderer.invoke("oc:compare:open", ids),
    requestConversion: (ids) => ipcRenderer.invoke("oc:conversion:open", ids),
    onConversionRequested: (callback) => {
        const listener = (
            _event: Electron.IpcRendererEvent,
            items: unknown,
        ) => {
            if (
                Array.isArray(items) &&
                items.length <= 1000 &&
                items.every(
                    (item) =>
                        item &&
                        typeof item.id === "string" &&
                        typeof item.path === "string" &&
                        typeof item.name === "string",
                )
            )
                callback(items);
        };
        ipcRenderer.on("oc:conversion:requested", listener);
        return () =>
            ipcRenderer.removeListener("oc:conversion:requested", listener);
    },
    onCompareRequested: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, ids: unknown) => {
            if (Array.isArray(ids) && ids.every((id) => typeof id === "string"))
                callback(ids);
        };
        ipcRenderer.on("oc:compare:requested", listener);
        return () =>
            ipcRenderer.removeListener("oc:compare:requested", listener);
    },
    saveComparison: (session) =>
        ipcRenderer.invoke("oc:comparisons:save", session),
    listComparisons: () => ipcRenderer.invoke("oc:comparisons:list"),
    removeComparison: (id) => ipcRenderer.invoke("oc:comparisons:remove", id),
    saveStyle: (style) => ipcRenderer.invoke("oc:styles:save", style),
    listStyles: () => ipcRenderer.invoke("oc:styles:list"),
    removeStyle: (id) => ipcRenderer.invoke("oc:styles:remove", id),
    saveSmartFilter: (filter) =>
        ipcRenderer.invoke("oc:smart-filters:save", filter),
    listSmartFilters: () => ipcRenderer.invoke("oc:smart-filters:list"),
    removeSmartFilter: (id) =>
        ipcRenderer.invoke("oc:smart-filters:remove", id),
    addSampledColor: (value) => ipcRenderer.invoke("oc:colors:add", value),
    getSampledColors: () => ipcRenderer.invoke("oc:colors:list"),
    cancelJob: (jobId) => ipcRenderer.invoke("oc:jobs:cancel", jobId),
    t,
    lang: dashboardLang,
};

contextBridge.exposeInMainWorld("openCapture", api);
