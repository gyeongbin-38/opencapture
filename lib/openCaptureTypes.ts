export type OpenCaptureActionName =
    | "capture"
    | "steps"
    | "fullscreen"
    | "window"
    | "previous"
    | "scroll"
    | "record"
    | "ocr"
    | "screen-translate"
    | "pin-clipboard"
    | "open-image"
    | "settings"
    | "restore-pins"
    | "dropzone"
    | "add-collection"
    | "choose-collection"
    | "open-item"
    | "pin-item"
    | "reveal-item"
    | "copy-item"
    | "remove-background"
    | "cheatsheet"
    | "configure-workflow"
    | "export-items"
    | "pin-items"
    | "combine-items"
    | "load-items"
    | "toggle-compact"
    | "hide-window"
    | "configure-runtime"
    | "toggle-favorite"
    | "rename-item"
    | "duplicate-item"
    | "save-composed"
    | "set-note"
    | "set-tags"
    | "ai-upscale"
    | "save-gif"
    | "index-ocr"
    | "save-pin-set"
    | "remove-pin-set"
    | "pin-set";

export type TranslationEngine = "local" | "deepl" | "google";

export interface OpenCaptureCollection {
    id: string;
    name: string;
    path: string;
}

export interface OpenCaptureItem {
    id: string;
    name: string;
    path: string;
    thumbnail?: string;
    createdAt: string;
    collectionId: string;
    favorite?: boolean;
    note?: string;
    tags?: string[];
    ocrText?: string;
    ocrDone?: boolean;
}

export interface OpenCaptureWorkflow {
    autoCopy: boolean;
    autoRemoveBackground: boolean;
    autoPin: boolean;
    autoOcr: boolean;
    autoPreview: boolean;
}

export interface OpenCapturePinSet {
    id: string;
    name: string;
    itemIds: string[];
}

export interface OpenCaptureShortcut {
    id: string;
    label: string;
    requested: string;
    active: string | null;
    available: boolean;
    custom?: string | null;
    default?: string;
}

export type MouseChordAction = "关闭" | "截屏" | "快速截屏" | "录屏" | "起始页";

export interface OpenCaptureRuntime {
    startAtLogin: boolean;
    shortcuts: OpenCaptureShortcut[];
    mouseChord?: MouseChordAction;
    stepCapture?: boolean;
}

export interface OpenCaptureItemsPage {
    items: OpenCaptureItem[];
    totalItemCount: number;
}

export interface OpenCaptureState {
    collections: OpenCaptureCollection[];
    items: OpenCaptureItem[];
    activeCollectionId: string | null;
    defaultFolder: string;
    version: string;
    totalItemCount: number;
    workflow: OpenCaptureWorkflow;
    runtime: OpenCaptureRuntime;
    recoveryWarning?: string;
    previewItemId?: string;
    pinSets?: OpenCapturePinSet[];
}

export interface TranslationOptions {
    texts: string[];
    from: string;
    to: string;
    engine?: TranslationEngine;
}

export interface TranslationStatus {
    engine?: TranslationEngine;
    local: {
        installed: boolean;
        installing?: boolean;
        size?: number;
        languages?: string[];
    };
    providers: {
        deepl: { configured: boolean };
        google: { configured: boolean };
    };
}

export interface TranslationConfiguration {
    engine: TranslationEngine;
    apiKey?: string;
}

export interface OpenCaptureApi {
    action(name: OpenCaptureActionName, payload?: unknown): Promise<unknown>;
    getState(): Promise<OpenCaptureState>;
    translate(options: TranslationOptions): Promise<string[]>;
    translationStatus(): Promise<TranslationStatus>;
    installModels(): Promise<TranslationStatus>;
    configureTranslation(
        config: TranslationConfiguration,
    ): Promise<TranslationStatus>;
    importFiles(files: File[]): Promise<OpenCaptureState>;
    getItemData(id: string): Promise<string>;
    getItemFile(id: string): Promise<Uint8Array>;
    startDrag(id: string): void;
    t(text: string): string;
    onShowLibrary(callback: () => void): () => void;
    onLibraryChanged(callback: () => void): () => void;
    onWorkflowError(callback: (message: string) => void): () => void;
    onPreviewItem(callback: (id: string) => void): () => void;
    onSrProgress(
        callback: (progress: {
            id: string;
            phase: string;
            percent: number;
        }) => void,
    ): () => void;
}

declare global {
    interface Window {
        openCapture: OpenCaptureApi;
    }
}
