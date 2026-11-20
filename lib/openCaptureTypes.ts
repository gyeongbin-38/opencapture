import type {
    CaptureBoardApi,
    CaptureCutoutInput,
    CaptureCutoutResult,
} from "./captureBoard";
import type { DashboardLanguageSettings } from "./dashboardLanguage";
import type { FileToolsApi } from "./fileTools";

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
    | "pin-stack"
    | "combine-items"
    | "combine-pdf"
    | "load-items"
    | "toggle-compact"
    | "hide-window"
    | "configure-runtime"
    | "toggle-favorite"
    | "rename-item"
    | "duplicate-item"
    | "copy-composed"
    | "save-composed"
    | "set-note"
    | "set-tags"
    | "ai-upscale"
    | "save-gif"
    | "index-ocr"
    | "save-pin-set"
    | "remove-pin-set"
    | "export-settings"
    | "import-settings"
    | "pin-set";

export type CaptureItemStatus = "temporary" | "library" | "trash";
export type CaptureRendererRole =
    | "dashboard"
    | "clip"
    | "shelf"
    | "pin"
    | "ocr-worker";
export type CaptureToolId =
    | "copy"
    | "save"
    | "stage"
    | "annotate"
    | "pin"
    | "color"
    | "scroll"
    | "record"
    | "search"
    | "qr"
    | "open"
    | "screens"
    | "ocr"
    | "redact"
    | "compare"
    | "promote"
    | "trash"
    | "more";

export interface CaptureRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface CaptureSourceContext {
    kind: "capture" | "import" | "clipboard";
    appName?: string;
    windowTitle?: string;
    displayId?: string;
    capturedAt: string;
}

export interface CaptureDraftManifest {
    version: 1;
    id: string;
    revision: number;
    generation: string;
    sourcePath: string;
    previewPath: string;
    canvasPath: string;
    rect: CaptureRect;
    source: CaptureSourceContext;
    committedAt: string;
}

export interface StageCaptureInput {
    id?: string;
    expectedRevision?: number;
    sourceDataURL?: string;
    previewDataURL: string;
    canvas: unknown;
    rect: CaptureRect;
    source?: CaptureSourceContext;
}

export interface CaptureDraft {
    id: string;
    revision: number;
    sourceDataURL: string;
    previewDataURL: string;
    canvas: unknown;
    rect: CaptureRect;
    source: CaptureSourceContext;
}

export interface StageCaptureResult {
    id: string;
    revision: number;
    item: OpenCaptureItem;
}

export type CaptureQueryScope = "temporary" | "library" | "trash" | "all";
export type CaptureSort = "newest" | "oldest" | "name" | "size";

export interface CaptureItemsQuery {
    scope: CaptureQueryScope;
    collectionId?: string;
    search?: string;
    tags?: string[];
    smartId?: string;
    favorites?: boolean;
    ocrOnly?: boolean;
    sort: CaptureSort;
    offset: number;
    limit: number;
    queryId: string;
    catalogRevision?: number;
}

export interface CaptureItemsQueryResult {
    items: OpenCaptureItem[];
    total: number;
    queryId: string;
    catalogRevision: number;
}

export interface CaptureFeedbackPreferences {
    visual: boolean;
    sound: boolean;
    soundTone: "chime" | "shutter";
    motion: "system" | "full" | "reduced";
}

export interface CaptureExperiencePreferences {
    version: 1;
    toolbarOrder: CaptureToolId[];
    radialOrder: CaptureToolId[];
    feedback: CaptureFeedbackPreferences;
    defaultPreset: "copy-close" | "stage-only" | "stage-pin" | "annotate";
    shelfEnabled: boolean;
    trashRetentionDays: number;
}

export interface NamedBeautifyStyle {
    id: string;
    name: string;
    background: string;
    padding: number;
    shadow: number;
    radius: number;
    ratio: string;
    align: string;
    autoBalance: boolean;
}

export interface SavedSmartFilter {
    id: string;
    name: string;
    tags?: string[];
    date?: "today" | "week" | "month";
    type?: "image" | "video" | "gif" | "project";
    favorites?: boolean;
    ocrOnly?: boolean;
}

export interface ComparisonPointNote {
    id: string;
    x: number;
    y: number;
    text: string;
}

export interface SavedComparisonSession {
    id: string;
    name: string;
    itemIds: string[];
    mode: "side-by-side" | "overlay" | "slider" | "difference";
    zoom: number;
    zoomMode?: "fit" | "actual";
    opacity?: number;
    wipe?: number;
    panX: number;
    panY: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    threshold: number;
    notes: ComparisonPointNote[];
    updatedAt: string;
}

export interface CaptureColorSample {
    value: string;
    sampledAt: string;
}

export interface OcrTextBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface OcrTextLine {
    text: string;
    box: OcrTextBox;
    confidence?: number;
}

export interface OcrJobResult {
    jobId: string;
    itemId: string;
    revision: number;
    width: number;
    height: number;
    lines: OcrTextLine[];
    text: string;
    cancelled?: boolean;
    error?: string;
}

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
    ocrLines?: OcrTextLine[];
    status?: CaptureItemStatus;
    previousStatus?: Exclude<CaptureItemStatus, "trash">;
    draftRevision?: number;
    draftCorrupt?: boolean;
    draftManifestPath?: string;
    source?: CaptureSourceContext;
    thumbnailPath?: string;
    size?: number;
}

export interface OpenCaptureWorkflow {
    autoCopy: boolean;
    autoRemoveBackground: boolean;
    autoPin: boolean;
    autoOcr: boolean;
    autoPreview: boolean;
    autoClipboard: boolean;
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
    lastUsed?: number | null;
}

export interface CaptureDiagnosticTrace {
    requestId: string;
    phase: "input" | "preparing" | "ready" | "shown" | "committed" | "failed";
    input?: string;
    detail?: string;
    at: string;
}

export type MouseChordAction = "关闭" | "截屏" | "快速截屏" | "录屏" | "起始页";

export interface OpenCaptureRuntime {
    startAtLogin: boolean;
    shortcuts: OpenCaptureShortcut[];
    mouseChord?: MouseChordAction;
    radialMenu?: {
        enabled: boolean;
        actions: string[];
        trigger?: "wheel" | "back" | "both";
        hookFailed?: boolean;
        stats?: Record<string, number>;
    };
    stepCapture?: boolean;
    captureDiagnostics?: CaptureDiagnosticTrace[];
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
    experience?: CaptureExperiencePreferences;
    comparisons?: SavedComparisonSession[];
    styles?: NamedBeautifyStyle[];
    smartFilters?: SavedSmartFilter[];
    colors?: CaptureColorSample[];
    catalogRevision?: number;
}

export interface TranslationOptions {
    texts: string[];
    from: string;
    to: string;
    engine?: TranslationEngine;
}

export interface TranslationStatus {
    runtimeReady: boolean;
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

export interface DashboardPin {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    src: string;
    opacity: number;
    visible: boolean;
    ignored: boolean;
}

export interface PinWorkspaceSummary {
    name: string;
    count: number;
}

export type CaptureConvertFormat =
    | "png"
    | "jpg"
    | "webp"
    | "avif"
    | "bmp"
    | "ico"
    | "gif"
    | "pdf";

export interface CaptureConvertOptions {
    scale?: number;
    quality?: number;
    background?: string;
    maxWidth?: number;
    pngData?: boolean;
    namePattern?: string;
    encodedSize?: { width: number; height: number };
}

export interface CaptureConvertOutput {
    path: string;
    bytes: number;
    width: number;
    height: number;
}

export interface CaptureConvertPreview {
    data: Uint8Array;
    previewMime: string;
    exportMime: string;
    outputBytes?: number;
    width: number;
    height: number;
    approximate: boolean;
}

export interface CaptureRegistrationOutcome {
    path: string;
    status: "registered" | "duplicate" | "unsupported" | "failed";
    itemId?: string;
    error?: string;
}

export interface CaptureDragAcknowledgement {
    started: boolean;
    error?: string;
}

export interface OpenCaptureApi {
    fileTools: FileToolsApi;
    boards: CaptureBoardApi;
    cutoutImage(input: CaptureCutoutInput): Promise<CaptureCutoutResult>;
    onBoardFlushRequested(callback: (requestId: string) => void): () => void;
    ackBoardFlush(
        requestId: string,
        ok: boolean,
        message?: string,
    ): Promise<void>;
    finishBoardClose(): Promise<void>;
    shelfAction(name: "copy" | "edit" | "pin", id: string): Promise<boolean>;
    listPins(): Promise<DashboardPin[]>;
    pinAction(
        action:
            | "close"
            | "blink"
            | "restore"
            | "closeAll"
            | "hideAll"
            | "toggleBelow",
        id?: string,
    ): Promise<unknown>;
    pinWorkspace(
        op: "save" | "restore" | "delete" | "list",
        name?: string,
        opts?: { keep?: boolean },
    ): Promise<PinWorkspaceSummary[]>;
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
    convertItem(
        id: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertOutput>;
    convertPath(
        path: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertOutput>;
    previewItem(
        id: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertPreview>;
    previewPath(
        path: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertPreview>;
    registerConvertedPaths(
        paths: string[],
    ): Promise<CaptureRegistrationOutcome[]>;
    dragConvertedPath(path: string): Promise<CaptureDragAcknowledgement>;
    revealPath(path: string): Promise<boolean>;
    importPaths(paths: string[]): Promise<OpenCaptureState>;
    pathForFile(file: File): string;
    readFilePath(path: string): Promise<Uint8Array>;
    dragFilePath(path: string): void;
    startDrag(id: string | string[]): void;
    getLanguageSettings(): Promise<DashboardLanguageSettings>;
    setLanguage(language: string): Promise<DashboardLanguageSettings>;
    t(text: string): string;
    lang: string;
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
    getPreferences(): Promise<CaptureExperiencePreferences>;
    configureExperience(
        patch: Partial<CaptureExperiencePreferences>,
    ): Promise<CaptureExperiencePreferences>;
    stageCapture(input: StageCaptureInput): Promise<StageCaptureResult>;
    getDraft(id: string): Promise<CaptureDraft>;
    recognizeItem(id: string): Promise<OcrJobResult>;
    requestComparison(ids: string[]): Promise<void>;
    requestConversion(ids: string[]): Promise<void>;
    onConversionRequested(
        callback: (
            items: Pick<OpenCaptureItem, "id" | "path" | "name">[],
        ) => void,
    ): () => void;
    onCompareRequested(callback: (ids: string[]) => void): () => void;
    queryItems(query: CaptureItemsQuery): Promise<CaptureItemsQueryResult>;
    promoteItems(ids: string[]): Promise<OpenCaptureState>;
    repairDraft(id: string): Promise<OpenCaptureState>;
    trashItems(ids: string[]): Promise<OpenCaptureState>;
    restoreItems(ids: string[]): Promise<OpenCaptureState>;
    copySourceFiles(ids: string[]): Promise<{ copied: number }>;
    saveComparison(
        session: SavedComparisonSession,
    ): Promise<SavedComparisonSession>;
    listComparisons(): Promise<SavedComparisonSession[]>;
    removeComparison(id: string): Promise<void>;
    saveStyle(style: NamedBeautifyStyle): Promise<NamedBeautifyStyle>;
    listStyles(): Promise<NamedBeautifyStyle[]>;
    removeStyle(id: string): Promise<void>;
    saveSmartFilter(filter: SavedSmartFilter): Promise<SavedSmartFilter>;
    listSmartFilters(): Promise<SavedSmartFilter[]>;
    removeSmartFilter(id: string): Promise<void>;
    addSampledColor(value: string): Promise<CaptureColorSample[]>;
    getSampledColors(): Promise<CaptureColorSample[]>;
    cancelJob(jobId: string): Promise<boolean>;
}

declare global {
    interface Window {
        openCapture: OpenCaptureApi;
    }
}
