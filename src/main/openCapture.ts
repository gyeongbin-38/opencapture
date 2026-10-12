import { createHash, randomUUID } from "node:crypto";
import {
    constants,
    type FSWatcher,
    appendFileSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    watch,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
    BrowserWindow,
    ClipboardItem,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    type WebContents,
    app,
    clipboard,
    dialog,
    ipcMain,
    nativeImage,
    shell,
} from "electron";
import type {
    BoardCaptureEvent,
    BoardDocument,
    CaptureCutoutInput,
} from "../../lib/captureBoard";
import {
    DEFAULT_CAPTURE_EXPERIENCE,
    parseCaptureExperience,
} from "../../lib/captureExperience";
import {
    type CaptureWorkflowPreferences,
    CaptureWorkflowQueue,
    defaultCaptureWorkflowPreferences,
    parseCaptureWorkflowPreferences,
    planImageCombination,
} from "../../lib/captureWorkflow";
import {
    NOTE_MAX_LENGTH,
    OCR_TEXT_LIMIT,
    isValidTags,
    normalizeTags,
} from "../../lib/itemMeta";
import type {
    CaptureColorSample,
    CaptureDraft,
    CaptureDraftManifest,
    CaptureExperiencePreferences,
    CaptureItemsQuery,
    CaptureRendererRole,
    NamedBeautifyStyle,
    OcrJobResult,
    OcrTextLine,
    OpenCaptureItem,
    SavedComparisonSession,
    SavedSmartFilter,
    StageCaptureInput,
} from "../../lib/openCaptureTypes";
import { replaceFileSync } from "./atomicReplace";
import { removeBackground } from "./backgroundRemoval";
import {
    beautifyPng,
    decodeBoundedImageDataURL,
    imagePdf,
    inspectPng,
} from "./captureBoardImages";
import { CaptureBoardStore } from "./captureBoardStore";
import {
    applyCaptureTransition,
    queryCaptureItems,
    shouldRemoveOwnedDuplicate,
} from "./captureCatalogQuery";
import { CaptureDraftStore } from "./captureDraftStore";
import { copyFilesToWindowsClipboard } from "./captureFileClipboard";
import { createSuperResolution } from "./superResolution";
import { ThumbnailDiskCache } from "./thumbnailDiskCache";

const VIDEO_EXTENSIONS = new Set([
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".avi",
    ".ts",
]);
const isVideoPath = (path: string) =>
    VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
const isProjectPath = (path: string) => extname(path).toLowerCase() === ".ocap";

type Collection = { id: string; name: string; path: string };
type Item = {
    id: string;
    name: string;
    path: string;
    thumbnail?: string;
    createdAt: string;
    collectionId: string;
    workflowComplete?: boolean;
    favorite?: boolean;
    note?: string;
    tags?: string[];
    ocrText?: string;
    ocrDone?: boolean;
    ocrLines?: OcrTextLine[];
    hash?: string;
    status?: "temporary" | "library" | "trash";
    previousStatus?: "temporary" | "library";
    draftRevision?: number;
    draftCorrupt?: boolean;
    draftManifestPath?: string;
    source?: OpenCaptureItem["source"];
    thumbnailPath?: string;
};
type PinSet = { id: string; name: string; itemIds: string[] };
type Library = {
    collections: Collection[];
    items: Item[];
    activeCollectionId: string;
    workflow: CaptureWorkflowPreferences;
    pinSets?: PinSet[];
    experience?: CaptureExperiencePreferences;
    comparisons?: SavedComparisonSession[];
    styles?: NamedBeautifyStyle[];
    smartFilters?: SavedSmartFilter[];
    colors?: CaptureColorSample[];
    catalogRevision?: number;
};

type CaptureReceipt = {
    version: 1;
    path: string;
    createdAt: string;
};

type ReceiptImageStat = {
    size: number;
    isFile: () => boolean;
};

const pathKey = (path: string) => {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function validateCaptureReceipt(
    value: unknown,
    receiptSize: number,
    allowedFolders: readonly string[],
    imageStat: (path: string) => ReceiptImageStat = lstatSync,
): CaptureReceipt {
    if (receiptSize <= 0 || receiptSize > 8 * 1024)
        throw new Error("Capture receipt is too large.");
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Capture receipt must be an object.");
    const receipt = value as Record<string, unknown>;
    const keys = Object.keys(receipt);
    if (
        keys.length !== 3 ||
        keys.some((key) => !["version", "path", "createdAt"].includes(key)) ||
        receipt.version !== 1 ||
        typeof receipt.path !== "string" ||
        typeof receipt.createdAt !== "string"
    )
        throw new Error("Capture receipt has an invalid schema.");
    if (
        !isAbsolute(receipt.path) ||
        extname(receipt.path).toLowerCase() !== ".png"
    )
        throw new Error("Capture receipt path must be an absolute PNG path.");
    if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
            receipt.createdAt,
        ) ||
        Number.isNaN(Date.parse(receipt.createdAt))
    )
        throw new Error("Capture receipt has an invalid creation time.");
    const allowed = new Set(allowedFolders.map(pathKey));
    if (!allowed.has(pathKey(dirname(receipt.path))))
        throw new Error("Capture receipt is outside the image library.");
    const stats = imageStat(receipt.path);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 50 * 1024 * 1024)
        throw new Error("Capture receipt image is invalid or too large.");
    return receipt as CaptureReceipt;
}

export function isLibrary(value: unknown): value is Library {
    if (!value || typeof value !== "object") return false;
    const data = value as Library;
    return (
        Array.isArray(data.collections) &&
        data.collections.length > 0 &&
        data.collections.length <= 6 &&
        data.collections.every(
            (c) =>
                c &&
                typeof c.id === "string" &&
                typeof c.name === "string" &&
                typeof c.path === "string" &&
                c.path.length > 0,
        ) &&
        new Set(data.collections.map((c) => c.id)).size ===
            data.collections.length &&
        data.collections.some((c) => c.id === data.activeCollectionId) &&
        Array.isArray(data.items) &&
        data.items.every(
            (i) =>
                i &&
                typeof i.id === "string" &&
                typeof i.path === "string" &&
                typeof i.name === "string" &&
                typeof i.createdAt === "string" &&
                typeof i.collectionId === "string" &&
                (i.workflowComplete === undefined ||
                    typeof i.workflowComplete === "boolean") &&
                (i.favorite === undefined || typeof i.favorite === "boolean") &&
                (i.note === undefined ||
                    (typeof i.note === "string" &&
                        i.note.length <= NOTE_MAX_LENGTH)) &&
                (i.tags === undefined || isValidTags(i.tags)) &&
                (i.ocrText === undefined ||
                    (typeof i.ocrText === "string" &&
                        i.ocrText.length <= OCR_TEXT_LIMIT)) &&
                (i.ocrDone === undefined || typeof i.ocrDone === "boolean") &&
                (i.ocrLines === undefined ||
                    (Array.isArray(i.ocrLines) &&
                        i.ocrLines.length <= 2_000 &&
                        i.ocrLines.every(
                            (line) =>
                                line &&
                                typeof line.text === "string" &&
                                line.text.length <= 10_000 &&
                                line.box &&
                                [
                                    line.box.x,
                                    line.box.y,
                                    line.box.width,
                                    line.box.height,
                                ].every(Number.isFinite),
                        ))) &&
                (i.thumbnail === undefined ||
                    typeof i.thumbnail === "string") &&
                (i.hash === undefined ||
                    (typeof i.hash === "string" && i.hash.length <= 64)) &&
                (i.status === undefined ||
                    ["temporary", "library", "trash"].includes(i.status)) &&
                (i.previousStatus === undefined ||
                    ["temporary", "library"].includes(i.previousStatus)) &&
                (i.draftRevision === undefined ||
                    (Number.isSafeInteger(i.draftRevision) &&
                        i.draftRevision > 0)) &&
                (i.draftCorrupt === undefined ||
                    typeof i.draftCorrupt === "boolean") &&
                (i.draftManifestPath === undefined ||
                    typeof i.draftManifestPath === "string"),
        ) &&
        (data.workflow === undefined ||
            (typeof data.workflow === "object" &&
                data.workflow !== null &&
                !Array.isArray(data.workflow) &&
                Object.values(data.workflow).every(
                    (value) => typeof value === "boolean",
                ))) &&
        (data.pinSets === undefined ||
            (Array.isArray(data.pinSets) &&
                data.pinSets.length <= 50 &&
                data.pinSets.every(
                    (s) =>
                        s &&
                        typeof s.id === "string" &&
                        typeof s.name === "string" &&
                        s.name.length <= 40 &&
                        Array.isArray(s.itemIds) &&
                        s.itemIds.length <= 50 &&
                        s.itemIds.every((id) => typeof id === "string"),
                ))) &&
        (data.comparisons === undefined ||
            (Array.isArray(data.comparisons) &&
                data.comparisons.length <= 50 &&
                data.comparisons.every(
                    (session) =>
                        session &&
                        typeof session.id === "string" &&
                        typeof session.name === "string" &&
                        [
                            "side-by-side",
                            "overlay",
                            "slider",
                            "difference",
                        ].includes(session.mode) &&
                        Array.isArray(session.itemIds) &&
                        session.itemIds.length >= 2 &&
                        session.itemIds.length <= 20 &&
                        Array.isArray(session.notes) &&
                        session.notes.length <= 50 &&
                        [
                            session.zoom,
                            session.panX,
                            session.panY,
                            session.offsetX,
                            session.offsetY,
                            session.scale,
                            session.threshold,
                        ].every(Number.isFinite),
                ))) &&
        (data.styles === undefined ||
            (Array.isArray(data.styles) &&
                data.styles.length <= 30 &&
                data.styles.every(
                    (style) =>
                        style &&
                        typeof style.id === "string" &&
                        typeof style.name === "string" &&
                        typeof style.background === "string" &&
                        [style.padding, style.shadow, style.radius].every(
                            Number.isFinite,
                        ),
                ))) &&
        (data.smartFilters === undefined ||
            (Array.isArray(data.smartFilters) &&
                data.smartFilters.length <= 50 &&
                data.smartFilters.every(
                    (filter) =>
                        filter &&
                        typeof filter.id === "string" &&
                        typeof filter.name === "string" &&
                        (filter.tags === undefined || isValidTags(filter.tags)),
                ))) &&
        (data.colors === undefined ||
            (Array.isArray(data.colors) &&
                data.colors.length <= 24 &&
                data.colors.every(
                    (color) =>
                        color &&
                        typeof color.value === "string" &&
                        /^#[0-9a-f]{6,8}$/i.test(color.value) &&
                        typeof color.sampledAt === "string",
                ))) &&
        (data.catalogRevision === undefined ||
            (Number.isSafeInteger(data.catalogRevision) &&
                data.catalogRevision >= 0))
    );
}
type Hooks = {
    quit?: () => void;
    capture: (mode: string) => Promise<void>;
    pin: (path?: string) => Promise<void>;
    edit: (path: string) => void;
    openProject?: (path: string) => void | Promise<void>;
    openDraft?: (document: CaptureDraft) => void | Promise<void>;
    shelfChanged?: () => void;
    settings: () => void;
    setSaveFolder: (path: string) => void;
    restorePins: () => void;
    translate: (input: unknown) => Promise<string[]>;
    translationStatus: () => unknown;
    installModels: () => Promise<unknown>;
    configureTranslation: (input: unknown) => unknown;
    runtimeState?: () => object;
    configureRuntime?: (input: unknown) => object | Promise<object>;
    steps?: () => void;
    language?: () => string;
};

export function isTrustedPage(pageUrl: string, root: string, devUrl?: string) {
    try {
        const parsed = new URL(pageUrl);
        if (devUrl) {
            const dev = new URL(devUrl);
            if (
                parsed.origin === dev.origin &&
                ["localhost", "127.0.0.1"].includes(parsed.hostname)
            )
                return true;
        }
        if (parsed.protocol !== "file:") return false;
        const page = resolve(fileURLToPath(parsed));
        const renderer = resolve(root, "out/renderer");
        return (
            page.startsWith(`${renderer}\\`) || page.startsWith(`${renderer}/`)
        );
    } catch {
        return false;
    }
}

export function installOpenCapture(root: string, hooks: Hooks) {
    const userData = app.getPath("userData");
    const dataPath = join(userData, "library.json");
    const captureSettingsPath = join(userData, "capture-settings.json");
    const workflowErrorPath = join(userData, "workflow-errors.jsonl");
    const inboxPath = join(userData, "capture-inbox");
    const defaultFolder = join(app.getPath("pictures"), "OpenCapture");
    const draftStore = new CaptureDraftStore(join(userData, "capture-drafts"));
    const diskThumbnailCache = new ThumbnailDiskCache(
        join(userData, "thumbnail-cache"),
    );
    mkdirSync(defaultFolder, { recursive: true });
    mkdirSync(inboxPath, { recursive: true });
    let library: Library = {
        collections: [
            { id: "default", name: "모든 캡처", path: defaultFolder },
        ],
        items: [],
        activeCollectionId: "default",
        workflow: { ...defaultCaptureWorkflowPreferences },
        experience: { ...DEFAULT_CAPTURE_EXPERIENCE },
        catalogRevision: 1,
    };
    let recoveryWarning: string | undefined;
    if (existsSync(dataPath)) {
        try {
            const data = JSON.parse(readFileSync(dataPath, "utf8"));
            if (!isLibrary(data)) throw new Error("Invalid library index");
            library = {
                ...data,
                items: data.items.map(({ thumbnail: _thumbnail, ...item }) =>
                    item.draftRevision && !draftStore.manifest(item.id)
                        ? { ...item, draftCorrupt: true }
                        : item,
                ),
                workflow: parseCaptureWorkflowPreferences(
                    data.workflow ?? {},
                    defaultCaptureWorkflowPreferences,
                ),
                experience: parseCaptureExperience(data.experience),
                comparisons: Array.isArray(data.comparisons)
                    ? data.comparisons
                    : [],
                styles: Array.isArray(data.styles) ? data.styles : [],
                smartFilters: Array.isArray(data.smartFilters)
                    ? data.smartFilters
                    : [],
                colors: Array.isArray(data.colors) ? data.colors : [],
                catalogRevision: Number.isSafeInteger(data.catalogRevision)
                    ? data.catalogRevision
                    : 1,
            };
        } catch {
            const backup = `${dataPath}.recovery-${randomUUID()}`;
            renameSync(dataPath, backup);
            recoveryWarning = `라이브러리 목록을 읽지 못해 원본을 보존했습니다: ${backup}. 이미지 파일은 변경하지 않았습니다.`;
        }
    }
    for (const manifest of draftStore.list()) {
        const existing = library.items.find((item) => item.id === manifest.id);
        if (existing) {
            existing.path = manifest.previewPath;
            existing.draftRevision = manifest.revision;
            existing.draftCorrupt = undefined;
        } else {
            library.items.unshift({
                id: manifest.id,
                name: `Capture-${manifest.id.slice(0, 8)}.png`,
                path: manifest.previewPath,
                createdAt: manifest.committedAt,
                collectionId: library.activeCollectionId,
                status: "temporary",
                draftRevision: manifest.revision,
                draftManifestPath: draftStore.manifestPath(manifest.id),
                source: manifest.source,
            });
        }
        try {
            draftStore.finalize(manifest.id);
        } catch {}
    }
    const addRecoveryWarning = (message: string) => {
        recoveryWarning = recoveryWarning
            ? `${recoveryWarning}\n${message}`
            : message;
    };
    if (existsSync(workflowErrorPath)) {
        try {
            const recentErrors = readFileSync(workflowErrorPath, "utf8")
                .trim()
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-5)
                .map((line) => {
                    const entry = JSON.parse(line) as { message?: unknown };
                    return typeof entry.message === "string"
                        ? entry.message
                        : "Capture workflow failed.";
                });
            if (recentErrors.length > 0)
                addRecoveryWarning(recentErrors.join("\n"));
        } catch {
            addRecoveryWarning("Capture workflow error log could not be read.");
        }
    }
    let dashboard: BrowserWindow | null = null;
    let dashboardReady = false;
    let boardWindowCloseAllowed = false;
    let boardCloseIntent: "close" | "quit" | null = null;
    let dashboardCloseInFlight = false;
    const pendingBoardFlushes = new Map<
        string,
        {
            senderId: number;
            timer: ReturnType<typeof setTimeout>;
            settle: (result: { ok: boolean; message?: string }) => void;
        }
    >();
    const requestBoardFlush = (
        timeoutMs = 3_000,
    ): Promise<{ ok: boolean; message?: string }> => {
        const window = dashboard;
        if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            !dashboardReady ||
            window.webContents.isLoading()
        )
            return Promise.resolve({ ok: true });
        const requestId = randomUUID();
        return new Promise<{ ok: boolean; message?: string }>((settle) => {
            const timer = setTimeout(
                () => {
                    pendingBoardFlushes.delete(requestId);
                    settle({
                        ok: false,
                        message:
                            "Board save timed out. The window remains open.",
                    });
                },
                Math.max(500, Math.min(10_000, timeoutMs)),
            );
            timer.unref();
            pendingBoardFlushes.set(requestId, {
                senderId: window.webContents.id,
                timer,
                settle,
            });
            window.webContents.send("oc:boards:flush-requested", requestId);
        });
    };
    const allowBoardWindowClose = (intent: "close" | "quit" = "close") => {
        boardWindowCloseAllowed = true;
        boardCloseIntent = intent;
    };
    const renderers = new Map<
        number,
        {
            role: CaptureRendererRole;
            url: string;
            draftId?: string;
            ownedDraftIds: Set<string>;
        }
    >();
    const registerRenderer = (
        webContents: WebContents,
        role: CaptureRendererRole,
        draftId?: string,
    ) => {
        const frame = webContents.mainFrame;
        if (
            !frame ||
            !isTrustedPage(frame.url, root, process.env.ELECTRON_RENDERER_URL)
        )
            throw new Error(
                "Renderer must be loaded from an app-owned page before registration.",
            );
        const previous = renderers.get(webContents.id);
        const ownedDraftIds =
            previous?.role === "clip"
                ? previous.ownedDraftIds
                : new Set<string>();
        if (role === "clip" && draftId) ownedDraftIds.add(draftId);
        const activeDraftId = role === "clip" ? draftId : undefined;
        renderers.set(webContents.id, {
            role,
            url: frame.url,
            ...(activeDraftId ? { draftId: activeDraftId } : {}),
            ownedDraftIds,
        });
        if (!previous)
            webContents.once("destroyed", () =>
                renderers.delete(webContents.id),
            );
    };
    let compact = false;
    const thumbnailCache = new Map<
        string,
        { value?: string; expiresAt?: number }
    >();
    const thumbnailDecodeWaiters: Array<() => void> = [];
    let thumbnailDecodeActive = 0;
    let thumbnailCacheGeneration = 0;
    const withThumbnailDecodeSlot = async <T>(operation: () => Promise<T>) => {
        if (thumbnailDecodeActive >= 4)
            await new Promise<void>((resolve) =>
                thumbnailDecodeWaiters.push(resolve),
            );
        thumbnailDecodeActive++;
        try {
            return await operation();
        } finally {
            thumbnailDecodeActive--;
            thumbnailDecodeWaiters.shift()?.();
        }
    };
    const cacheThumbnail = (
        key: string,
        value?: string,
        expiresAt?: number,
    ) => {
        thumbnailCache.delete(key);
        thumbnailCache.set(key, { value, expiresAt });
        while (thumbnailCache.size > 200) {
            const oldest = thumbnailCache.keys().next().value;
            if (oldest === undefined) break;
            thumbnailCache.delete(oldest);
        }
    };
    const cachedThumbnail = (key: string) => {
        const cached = thumbnailCache.get(key);
        if (!cached) return undefined;
        if (cached.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
            thumbnailCache.delete(key);
            return undefined;
        }
        thumbnailCache.delete(key);
        thumbnailCache.set(key, cached);
        return cached;
    };
    const persist = () => {
        mkdirSync(userData, { recursive: true });
        const temporary = `${dataPath}.tmp`;
        writeFileSync(
            temporary,
            JSON.stringify(
                {
                    ...library,
                    items: library.items.map(
                        ({ thumbnail: _thumbnail, ...item }) => item,
                    ),
                },
                null,
                2,
            ),
        );
        replaceFileSync(temporary, dataPath);
    };
    const touchCatalog = () => {
        library.catalogRevision = (library.catalogRevision ?? 0) + 1;
        persist();
    };
    const active = () =>
        library.collections.find((c) => c.id === library.activeCollectionId) ??
        library.collections[0];
    const persistCaptureSettings = () => {
        const temporary = `${captureSettingsPath}.tmp`;
        try {
            mkdirSync(userData, { recursive: true });
            const snapshot = JSON.stringify({
                version: 1,
                folder: active().path,
                workflow: library.workflow,
            });
            if (Buffer.byteLength(snapshot) > 16 * 1024)
                throw new Error("Capture helper settings exceed 16KB.");
            writeFileSync(temporary, snapshot);
            replaceFileSync(temporary, captureSettingsPath);
        } catch (error) {
            addRecoveryWarning(
                `Capture helper settings could not be updated: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };
    persistCaptureSettings();
    const thumbnailForItem = async (item: Item) => {
        const generation = thumbnailCacheGeneration;
        const missingKey = `${item.path}\0missing`;
        if (cachedThumbnail(missingKey)) return undefined;
        let stats: ReturnType<typeof statSync>;
        try {
            stats = statSync(item.path);
        } catch {
            cacheThumbnail(missingKey, "missing", Date.now() + 5_000);
            return undefined;
        }
        const key = `${item.path}\0${stats.mtimeMs}\0${stats.size}`;
        const cached = cachedThumbnail(key);
        if (cached) return cached.value;
        const diskPath = diskThumbnailCache.get(key);
        if (diskPath) {
            const diskImage = nativeImage.createFromPath(diskPath);
            if (!diskImage.isEmpty()) {
                const value = diskImage.toDataURL();
                cacheThumbnail(key, value);
                return value;
            }
        }
        if (isProjectPath(item.path)) {
            try {
                const raw = JSON.parse(readFileSync(item.path, "utf8"));
                if (typeof raw?.img === "string") {
                    const image = nativeImage.createFromDataURL(raw.img);
                    if (!image.isEmpty()) {
                        const thumb = image
                            .resize({ width: 280, quality: "good" })
                            .toDataURL();
                        diskThumbnailCache.put(
                            key,
                            image
                                .resize({ width: 280, quality: "good" })
                                .toPNG(),
                        );
                        cacheThumbnail(key, thumb);
                        return thumb;
                    }
                }
            } catch {}
            cacheThumbnail(key, undefined, Date.now() + 5_000);
            return undefined;
        }
        try {
            const image = await withThumbnailDecodeSlot(async () => {
                if (generation !== thumbnailCacheGeneration) return undefined;
                return nativeImage.createThumbnailFromPath(item.path, {
                    width: 280,
                    height: 280,
                });
            });
            if (!image) return undefined;
            if (generation !== thumbnailCacheGeneration) return undefined;
            if (image.isEmpty()) {
                cacheThumbnail(key, undefined, Date.now() + 5_000);
                return undefined;
            }
            const thumbnail = image.toDataURL();
            diskThumbnailCache.put(key, image.toPNG());
            cacheThumbnail(key, thumbnail);
            return thumbnail;
        } catch {
            if (generation === thumbnailCacheGeneration)
                cacheThumbnail(key, undefined, Date.now() + 5_000);
            return undefined;
        }
    };
    const activeItems = () =>
        library.items.filter(
            (item) =>
                item.collectionId === library.activeCollectionId &&
                (item.status ?? "library") === "library",
        );
    const itemsPage = async (offset: number, limit: number) => {
        const items = activeItems().slice(offset, offset + limit);
        const output: Item[] = new Array(items.length);
        let next = 0;
        const worker = async () => {
            while (next < items.length) {
                const index = next++;
                const item = items[index];
                const thumbnail = await thumbnailForItem(item);
                output[index] = thumbnail ? { ...item, thumbnail } : item;
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(4, items.length) }, () => worker()),
        );
        return output;
    };
    const state = async () => {
        void ingestInbox().catch((error) =>
            addRecoveryWarning(`Capture inbox: ${String(error)}`),
        );
        const scopedItemCount = activeItems().length;
        const previewItemId = pendingPreviewItem;
        pendingPreviewItem = undefined;
        return {
            ...library,
            items: await itemsPage(0, 80),
            totalItemCount: scopedItemCount,
            allItemCount: library.items.length,
            defaultFolder: active().path,
            version: app.getVersion(),
            recoveryWarning,
            runtime: hooks.runtimeState?.() ?? {},
            pinSets: library.pinSets ?? [],
            ...(previewItemId ? { previewItemId } : {}),
        };
    };
    const assertSender = (
        event: IpcMainEvent | IpcMainInvokeEvent,
        dashboardOnly = false,
    ) => {
        const frame = event.senderFrame;
        if (
            !frame ||
            frame !== event.sender.mainFrame ||
            !isTrustedPage(frame.url, root, process.env.ELECTRON_RENDERER_URL)
        )
            throw new Error("허용되지 않은 요청입니다.");
        if (dashboardOnly && event.sender.id !== dashboard?.webContents.id)
            throw new Error("시작 화면에서 실행해 주세요.");
    };
    const assertRole = (
        event: IpcMainEvent | IpcMainInvokeEvent,
        roles: CaptureRendererRole[],
    ) => {
        assertSender(event);
        const registration = renderers.get(event.sender.id);
        const frame = event.senderFrame;
        if (
            !registration ||
            !frame ||
            registration.url !== frame.url ||
            !roles.includes(registration.role)
        )
            throw new Error(
                "Renderer capability is not registered for this operation.",
            );
        return registration.role;
    };
    const getItem = (id: unknown) => {
        const item = library.items.find((i) => i.id === id);
        if (!item || !existsSync(item.path))
            throw new Error("파일을 찾을 수 없습니다. 다시 가져와 주세요.");
        return item;
    };
    const boardStore = new CaptureBoardStore({
        root: join(userData, "capture-boards"),
        inspect: inspectPng,
        resolveItem: (id) => {
            const item = getItem(id);
            const manifest = item.draftRevision
                ? draftStore.manifest(item.id)
                : undefined;
            const path = manifest?.sourcePath ?? item.path;
            const image = inspectPng(readFileSync(path));
            return {
                item,
                ...image,
                ...(manifest?.rect ? { region: manifest.rect } : {}),
            };
        },
        prepareCutout: async (png) => {
            const image = nativeImage.createFromBuffer(png);
            if (image.isEmpty())
                throw new Error("Board image could not be decoded.");
            const result = await removeBackground(image, root);
            return inspectPng(result.toPNG());
        },
        prepareBeautify: async (png, style) => beautifyPng(png, style),
        preview: (png, maxEdge) => {
            const image = nativeImage.createFromBuffer(png);
            const size = image.getSize();
            if (image.isEmpty())
                throw new Error("Board image could not be decoded.");
            if (Math.max(size.width, size.height) <= maxEdge)
                return { png, width: size.width, height: size.height };
            const scale = maxEdge / Math.max(size.width, size.height);
            const resized = image.resize({
                width: Math.max(1, Math.round(size.width * scale)),
                height: Math.max(1, Math.round(size.height * scale)),
                quality: "good",
            });
            const resizedSize = resized.getSize();
            return {
                png: resized.toPNG(),
                width: resizedSize.width,
                height: resizedSize.height,
            };
        },
        onCaptureAdded: (captureEvent) => {
            if (
                dashboard &&
                !dashboard.isDestroyed() &&
                !dashboard.webContents.isDestroyed()
            )
                dashboard.webContents.send(
                    "oc:boards:capture-added",
                    captureEvent,
                );
        },
    });
    const selectedItems = (payload: unknown, maximum = 200) => {
        if (!payload || typeof payload !== "object")
            throw new Error("Selected items are required.");
        const ids = (payload as { ids?: unknown }).ids;
        if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            ids.length > maximum ||
            ids.some((id) => typeof id !== "string") ||
            new Set(ids).size !== ids.length
        )
            throw new Error(`Select between 1 and ${maximum} unique items.`);
        return ids.map(getItem);
    };
    const getPinSet = (payload: unknown) => {
        const id =
            typeof payload === "string"
                ? payload
                : payload && typeof payload === "object"
                  ? (payload as { id?: unknown }).id
                  : undefined;
        const set = (library.pinSets ?? []).find((s) => s.id === id);
        if (!set) throw new Error("핀 세트를 찾을 수 없습니다.");
        return set;
    };
    let ownClipboardSig: string | undefined;
    const writeClipboardImage = async (path: string) => {
        const image = nativeImage.createFromPath(path);
        if (image.isEmpty()) throw new Error("The image could not be read.");
        const png = image.toPNG();
        ownClipboardSig = createHash("sha1").update(png).digest("hex");
        await clipboard.write([
            new ClipboardItem({
                "image/png": new Blob([png], { type: "image/png" }),
            }),
        ]);
    };
    const uniqueExportPath = (folder: string, name: string) => {
        const safeName = basename(name) || "capture.png";
        const extension = extname(safeName);
        const stem = basename(safeName, extension);
        let destination = join(folder, safeName);
        let suffix = 2;
        while (existsSync(destination)) {
            destination = join(folder, `${stem} (${suffix})${extension}`);
            suffix++;
        }
        return destination;
    };
    const combineImages = (
        items: Item[],
        direction: "vertical" | "horizontal",
    ) => {
        const images: Electron.NativeImage[] = [];
        const sizes: Electron.Size[] = [];
        for (const item of items) {
            const image = nativeImage.createFromPath(item.path);
            if (image.isEmpty())
                throw new Error(
                    "One of the selected images could not be read.",
                );
            const size = image.getSize();
            planImageCombination([...sizes, size], direction);
            images.push(image);
            sizes.push(size);
        }
        /** 이어진 두 이미지의 겹침 품질 — 스크롤 캡처 이어붙이기용 경계 대역 비교 */
        const bandDiff = (
            a: Buffer,
            aw: number,
            ah: number,
            b: Buffer,
            bw: number,
            bh: number,
            overlap: number,
            vertical: boolean,
        ) => {
            const band = Math.min(16, overlap);
            let sum = 0;
            let count = 0;
            const diff = (ai: number, bi: number) => {
                sum +=
                    Math.abs(a[ai] - b[bi]) +
                    Math.abs(a[ai + 1] - b[bi + 1]) +
                    Math.abs(a[ai + 2] - b[bi + 2]);
                count += 3;
            };
            if (vertical) {
                const w = Math.min(aw, bw);
                for (let y = 0; y < band; y += 2)
                    for (let x = 0; x < w; x += 6)
                        diff(
                            ((ah - overlap + y) * aw + x) * 4,
                            (y * bw + x) * 4,
                        );
            } else {
                const h = Math.min(ah, bh);
                for (let y = 0; y < h; y += 2)
                    for (let x = 0; x < band; x += 2)
                        diff((y * aw + aw - overlap + x) * 4, (y * bw + x) * 4);
            }
            return count ? sum / count : Number.POSITIVE_INFINITY;
        };
        const findOverlap = (
            a: Buffer,
            aw: number,
            ah: number,
            b: Buffer,
            bw: number,
            bh: number,
            vertical: boolean,
        ) => {
            const along = vertical ? Math.min(ah, bh) : Math.min(aw, bw);
            const maxK = Math.min(along, 600);
            let bestK = 0;
            let bestDiff = Number.POSITIVE_INFINITY;
            for (let k = maxK; k >= 8; k -= 4) {
                const d = bandDiff(a, aw, ah, b, bw, bh, k, vertical);
                if (d < bestDiff) {
                    bestDiff = d;
                    bestK = k;
                }
                if (d < 2) break;
            }
            return bestDiff < 6 ? bestK : 0;
        };
        const bitmaps = images.map((i) => i.toBitmap());
        const vertical = direction === "vertical";
        const overlaps = bitmaps.map((b, i) =>
            i === 0
                ? 0
                : findOverlap(
                      bitmaps[i - 1],
                      sizes[i - 1].width,
                      sizes[i - 1].height,
                      b,
                      sizes[i].width,
                      sizes[i].height,
                      vertical,
                  ),
        );
        const totalSpan = sizes.reduce(
            (s, size, i) =>
                s + (vertical ? size.height : size.width) - overlaps[i],
            0,
        );
        const across = sizes.reduce(
            (m, size) => Math.max(m, vertical ? size.width : size.height),
            0,
        );
        const width = vertical ? across : totalSpan;
        const height = vertical ? totalSpan : across;
        if (width * height > 40_000_000)
            throw new Error(
                "The combined image exceeds the 40MP output limit.",
            );
        const output = Buffer.alloc(width * height * 4);
        let offsetX = 0;
        let offsetY = 0;
        for (let index = 0; index < images.length; index++) {
            const source = bitmaps[index];
            const size = sizes[index];
            for (let row = 0; row < size.height; row++) {
                const sourceStart = row * size.width * 4;
                const targetStart = ((offsetY + row) * width + offsetX) * 4;
                source.copy(
                    output,
                    targetStart,
                    sourceStart,
                    sourceStart + size.width * 4,
                );
            }
            if (vertical) offsetY += size.height - overlaps[index];
            else offsetX += size.width - overlaps[index];
        }
        return nativeImage.createFromBitmap(output, { width, height });
    };
    const notifyLibraryUpdated = () => {
        if (
            dashboard &&
            !dashboard.isDestroyed() &&
            !dashboard.webContents.isDestroyed()
        )
            dashboard.webContents.send("oc:library-updated");
    };
    let pendingPreviewItem: string | undefined;
    const requestPreview = (id: string) => {
        pendingPreviewItem = id;
        const win = show();
        const deliver = () => {
            if (pendingPreviewItem !== id || win.isDestroyed()) return;
            pendingPreviewItem = undefined;
            win.webContents.send("oc:preview-item", id);
        };
        if (win.webContents.isLoading())
            win.webContents.once("did-finish-load", deliver);
        else deliver();
    };
    const hashFile = (path: string): string | undefined => {
        try {
            return createHash("sha1").update(readFileSync(path)).digest("hex");
        } catch {
            return undefined;
        }
    };
    /** 같은 바이트 크기 후보만 해시 비교 — 라이브러리 전체를 매번 해시하지 않는다 */
    const findDuplicate = (path: string): Item | undefined => {
        let size: number;
        try {
            size = statSync(path).size;
        } catch {
            return undefined;
        }
        const candidates = library.items.filter((item) => {
            if ((item.status ?? "library") !== "library" || item.draftRevision)
                return false;
            try {
                return statSync(item.path).size === size;
            } catch {
                return false;
            }
        });
        if (!candidates.length) return undefined;
        const hash = hashFile(path);
        if (!hash) return undefined;
        for (const item of candidates) {
            if (!item.hash) item.hash = hashFile(item.path);
            if (item.hash === hash) return item;
        }
        return undefined;
    };
    function remember(
        path: string,
        createdAt = new Date().toISOString(),
        queueWorkflow = true,
        preview = false,
        source?: OpenCaptureItem["source"],
    ) {
        if (!existsSync(path)) return false;
        const existing = library.items.find(
            (item) => pathKey(item.path) === pathKey(path),
        );
        if (existing) return true;
        const duplicate = findDuplicate(path);
        if (duplicate) {
            const ownedFolders = [
                ...library.collections.map((entry) => entry.path),
                inboxPath,
            ];
            if (
                shouldRemoveOwnedDuplicate(
                    path,
                    duplicate.path,
                    library.items.map((item) => item.path),
                    ownedFolders,
                )
            ) {
                try {
                    unlinkSync(path);
                } catch {}
            }
            if (queueWorkflow)
                workflowQueue.enqueue(duplicate.path, library.workflow);
            if (preview) requestPreview(duplicate.id);
            notifyLibraryUpdated();
            return true;
        }
        const image = nativeImage.createFromPath(path);
        if (image.isEmpty()) return false;
        const imageFolder = pathKey(dirname(path));
        const collection =
            library.collections.find(
                (candidate) => pathKey(candidate.path) === imageFolder,
            ) ??
            (pathKey(defaultFolder) === imageFolder
                ? library.collections[0]
                : active());
        const item: Item = {
            id: randomUUID(),
            name: basename(path),
            path,
            createdAt,
            collectionId: collection.id,
            workflowComplete: queueWorkflow ? undefined : false,
            ...(source ? { source } : {}),
        };
        const createdTime = Date.parse(createdAt);
        const insertion = library.items.findIndex(
            (existingItem) => Date.parse(existingItem.createdAt) < createdTime,
        );
        const index = insertion < 0 ? library.items.length : insertion;
        library.items.splice(index, 0, item);
        try {
            library.catalogRevision = (library.catalogRevision ?? 0) + 1;
            persist();
        } catch (error) {
            library.items.splice(index, 1);
            library.catalogRevision = Math.max(
                0,
                (library.catalogRevision ?? 1) - 1,
            );
            throw error;
        }
        notifyLibraryUpdated();
        if (queueWorkflow) workflowQueue.enqueue(path, library.workflow);
        if (preview) requestPreview(item.id);
        return true;
    }
    function saveImage(
        image: Electron.NativeImage,
        label = "Capture",
        applyWorkflow = true,
        destinationFolder = active().path,
        tags?: string[],
        source?: OpenCaptureItem["source"],
    ) {
        if (image.isEmpty()) throw new Error("비어 있는 이미지입니다.");
        mkdirSync(destinationFolder, { recursive: true });
        const path = join(
            destinationFolder,
            `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}.png`,
        );
        writeFileSync(path, image.toPNG(), { flag: "wx" });
        if (applyWorkflow)
            remember(
                path,
                undefined,
                true,
                library.workflow.autoPreview,
                source,
            );
        else insertSavedItem(path, tags, source);
        return path;
    }
    const cutoutImage = async (input: CaptureCutoutInput) => {
        if (
            !input ||
            typeof input !== "object" ||
            Boolean(input.itemId) === Boolean(input.dataURL)
        )
            throw new Error("Provide exactly one image source.");
        const sourceItem = input.itemId ? getItem(input.itemId) : undefined;
        const source = sourceItem
            ? inspectPng(
                  readFileSync(
                      (sourceItem.draftRevision
                          ? draftStore.manifest(sourceItem.id)?.sourcePath
                          : undefined) ?? sourceItem.path,
                  ),
              )
            : decodeBoundedImageDataURL(input.dataURL);
        const removed = await removeBackground(
            nativeImage.createFromBuffer(source.png),
            root,
        );
        const dataURL = removed.toDataURL();
        const path = saveImage(
            removed,
            "Cutout",
            false,
            active().path,
            undefined,
            sourceItem?.source ?? {
                kind: input.itemId ? "import" : "clipboard",
                capturedAt: new Date().toISOString(),
            },
        );
        const item = library.items.find(
            (candidate) => pathKey(candidate.path) === pathKey(path),
        );
        if (!item) throw new Error("Cutout catalog item could not be created.");
        return { itemId: item.id, dataURL, item };
    };
    function rememberMedia(path: string, source?: OpenCaptureItem["source"]) {
        if (!existsSync(path) || !isVideoPath(path)) return false;
        const existing = library.items.find(
            (item) => pathKey(item.path) === pathKey(path),
        );
        if (existing || findDuplicate(path)) return true;
        insertSavedItem(path, undefined, source);
        return true;
    }
    function insertSavedItem(
        path: string,
        tags?: string[],
        source?: OpenCaptureItem["source"],
    ) {
        const collection =
            library.collections.find(
                (candidate) =>
                    pathKey(candidate.path) === pathKey(dirname(path)),
            ) ?? active();
        library.items.unshift({
            id: randomUUID(),
            name: basename(path),
            path,
            createdAt: new Date().toISOString(),
            collectionId: collection.id,
            ...(tags?.length ? { tags } : {}),
            ...(source ? { source } : {}),
        });
        touchCatalog();
        notifyLibraryUpdated();
    }
    let clipboardWatcher: NodeJS.Timeout | undefined;
    let lastClipboardSig: string | undefined;
    const updateClipboardWatch = () => {
        if (library.workflow.autoClipboard && !clipboardWatcher) {
            let busy = false;
            clipboardWatcher = setInterval(() => {
                if (busy) return;
                busy = true;
                void clipboard
                    .read()
                    .then(async (items) => {
                        const item = items.find((i) =>
                            i.types.includes("image/png"),
                        );
                        if (!item) {
                            lastClipboardSig = undefined;
                            return;
                        }
                        const data = await item.getType("image/png");
                        if (!(data instanceof Blob)) return;
                        const png = Buffer.from(await data.arrayBuffer());
                        const sig = createHash("sha1")
                            .update(png)
                            .digest("hex");
                        if (sig === lastClipboardSig || sig === ownClipboardSig)
                            return;
                        lastClipboardSig = sig;
                        mkdirSync(active().path, { recursive: true });
                        const path = join(
                            active().path,
                            `Clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}.png`,
                        );
                        writeFileSync(path, png, { flag: "wx" });
                        remember(path, undefined, false, false, {
                            kind: "clipboard",
                            capturedAt: new Date().toISOString(),
                        });
                    })
                    .catch(() => {})
                    .finally(() => {
                        busy = false;
                    });
            }, 2000);
        } else if (!library.workflow.autoClipboard && clipboardWatcher) {
            clearInterval(clipboardWatcher);
            clipboardWatcher = undefined;
        }
    };
    const recordWorkflowError = (
        path: string,
        step: string,
        error: unknown,
    ) => {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `${step}: ${detail} (${basename(path)})`;
        addRecoveryWarning(message);
        try {
            const line = `${JSON.stringify({ createdAt: new Date().toISOString(), path, step, message })}\n`;
            if (
                existsSync(workflowErrorPath) &&
                statSync(workflowErrorPath).size > 256 * 1024
            )
                writeFileSync(workflowErrorPath, line);
            else appendFileSync(workflowErrorPath, line);
        } catch (logError) {
            addRecoveryWarning(
                `Capture workflow error could not be logged: ${logError instanceof Error ? logError.message : String(logError)}`,
            );
        }
        if (
            dashboard &&
            !dashboard.isDestroyed() &&
            !dashboard.webContents.isDestroyed()
        )
            dashboard.webContents.send("oc:workflow-error", message);
    };
    type OcrJob = {
        jobId: string;
        itemId: string;
        revision: number;
        path: string;
        settle?: (result: OcrJobResult) => void;
    };
    const ocrQueue: OcrJob[] = [];
    let ocrCurrentJob: OcrJob | undefined;
    let ocrWorker: BrowserWindow | null = null;
    let ocrBusy = false;
    let ocrJobTimer: ReturnType<typeof setTimeout> | undefined;
    let ocrWorkerReady = false;
    const ocrQueueFull = () => ocrQueue.length + (ocrBusy ? 1 : 0) >= 40;
    const pumpOcrQueue = () => {
        if (ocrBusy) return;
        const job = ocrQueue.shift();
        if (!job) return;
        if (!existsSync(job.path)) {
            job.settle?.({
                jobId: job.jobId,
                itemId: job.itemId,
                revision: job.revision,
                width: 0,
                height: 0,
                lines: [],
                text: "",
                error: "OCR source is missing.",
            });
            pumpOcrQueue();
            return;
        }
        ocrCurrentJob = job;
        ocrBusy = true;
        if (ocrJobTimer) clearTimeout(ocrJobTimer);
        ocrJobTimer = setTimeout(() => {
            ocrJobTimer = undefined;
            ocrBusy = false;
            if (ocrCurrentJob)
                ocrCurrentJob.settle?.({
                    jobId: ocrCurrentJob.jobId,
                    itemId: ocrCurrentJob.itemId,
                    revision: ocrCurrentJob.revision,
                    width: 0,
                    height: 0,
                    lines: [],
                    text: "",
                    error: "OCR timed out.",
                });
            ocrCurrentJob = undefined;
            const timedOutWorker = ocrWorker;
            ocrWorker = null;
            ocrWorkerReady = false;
            timedOutWorker?.destroy();
            pumpOcrQueue();
        }, 45_000);
        ocrJobTimer.unref();
        const dispatch = () => {
            if (!ocrWorker || ocrWorker.isDestroyed()) return;
            ocrWorker.webContents.send("oc:ocr-job", {
                jobId: job.jobId,
                itemId: job.itemId,
                revision: job.revision,
                path: job.path,
            });
        };
        if (ocrWorker && !ocrWorker.isDestroyed() && ocrWorkerReady) dispatch();
        else {
            if (ocrWorker && !ocrWorker.isDestroyed() && !ocrWorkerReady) {
                ocrWorker.webContents.once("did-finish-load", dispatch);
                return;
            }
            ocrWorkerReady = false;
            ocrWorker = new BrowserWindow({
                show: false,
                width: 16,
                height: 16,
                skipTaskbar: true,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                },
            });
            const worker = ocrWorker;
            ocrWorker.webContents.setWindowOpenHandler(() => ({
                action: "deny",
            }));
            ocrWorker.webContents.on("will-navigate", (event) =>
                event.preventDefault(),
            );
            ocrWorker.webContents.once("did-finish-load", () => {
                ocrWorkerReady = true;
                dispatch();
            });
            ocrWorker.webContents.on("render-process-gone", () => {
                if (ocrWorker !== worker) return;
                if (ocrJobTimer) clearTimeout(ocrJobTimer);
                ocrJobTimer = undefined;
                ocrBusy = false;
                ocrWorkerReady = false;
                ocrWorker = null;
                const failed =
                    ocrCurrentJob?.jobId === job.jobId
                        ? ocrCurrentJob
                        : undefined;
                if (failed) ocrCurrentJob = undefined;
                failed?.settle?.({
                    jobId: failed.jobId,
                    itemId: failed.itemId,
                    revision: failed.revision,
                    width: 0,
                    height: 0,
                    lines: [],
                    text: "",
                    error: "OCR worker stopped.",
                });
                pumpOcrQueue();
            });
            if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
                ocrWorker.loadURL(
                    `${process.env.ELECTRON_RENDERER_URL}/ocr_worker.html`,
                );
            else ocrWorker.loadFile(join(root, "out/renderer/ocr_worker.html"));
        }
    };
    const enqueueOcrIndex = (id: string) => {
        const item = library.items.find((i) => i.id === id);
        if (
            !item ||
            ocrCurrentJob?.itemId === id ||
            ocrQueue.some((job) => job.itemId === id) ||
            ocrQueueFull()
        )
            return;
        ocrQueue.push({
            jobId: randomUUID(),
            itemId: item.id,
            revision: item.draftRevision ?? 0,
            path: item.path,
        });
        pumpOcrQueue();
    };
    const ocrOnce = (path: string) =>
        new Promise<string>((resolve, reject) => {
            if (ocrQueueFull()) {
                reject(new Error("OCR queue is full."));
                return;
            }
            ocrQueue.push({
                jobId: randomUUID(),
                itemId: `once-${randomUUID()}`,
                revision: 0,
                path,
                settle: (result) =>
                    result.error
                        ? reject(new Error("텍스트를 인식하지 못했습니다."))
                        : resolve(result.text),
            });
            pumpOcrQueue();
        });
    const recognizeItem = (id: string) =>
        new Promise<OcrJobResult>((resolve, reject) => {
            const item = getItem(id);
            if (ocrQueueFull()) {
                reject(new Error("OCR queue is full."));
                return;
            }
            ocrQueue.push({
                jobId: randomUUID(),
                itemId: item.id,
                revision: item.draftRevision ?? 0,
                path: item.path,
                settle: resolve,
            });
            pumpOcrQueue();
        });
    const cancelOcrJob = (jobId: string) => {
        const queuedIndex = ocrQueue.findIndex((job) => job.jobId === jobId);
        if (queuedIndex >= 0) {
            const [job] = ocrQueue.splice(queuedIndex, 1);
            job.settle?.({
                jobId: job.jobId,
                itemId: job.itemId,
                revision: job.revision,
                width: 0,
                height: 0,
                lines: [],
                text: "",
                cancelled: true,
            });
            return true;
        }
        if (ocrCurrentJob?.jobId !== jobId) return false;
        const job = ocrCurrentJob;
        ocrCurrentJob = undefined;
        ocrBusy = false;
        if (ocrJobTimer) clearTimeout(ocrJobTimer);
        ocrJobTimer = undefined;
        job.settle?.({
            jobId: job.jobId,
            itemId: job.itemId,
            revision: job.revision,
            width: 0,
            height: 0,
            lines: [],
            text: "",
            cancelled: true,
        });
        ocrWorker?.destroy();
        ocrWorker = null;
        ocrWorkerReady = false;
        pumpOcrQueue();
        return true;
    };
    ipcMain.on("oc:ocr-result", (event, payload: unknown) => {
        if (
            !ocrWorker ||
            ocrWorker.isDestroyed() ||
            event.sender.id !== ocrWorker.webContents.id
        )
            return;
        if (ocrJobTimer) clearTimeout(ocrJobTimer);
        ocrJobTimer = undefined;
        ocrBusy = false;
        const result = payload as OcrJobResult & {
            ok?: unknown;
        };
        const currentJob = ocrCurrentJob;
        ocrCurrentJob = undefined;
        if (
            !currentJob ||
            result.jobId !== currentJob.jobId ||
            result.itemId !== currentJob.itemId ||
            result.revision !== currentJob.revision
        ) {
            pumpOcrQueue();
            return;
        }
        const normalized =
            result.ok === true &&
            typeof result.text === "string" &&
            Number.isSafeInteger(result.width) &&
            Number.isSafeInteger(result.height) &&
            result.width > 0 &&
            result.height > 0 &&
            result.width * result.height <= 32_000_000 &&
            Array.isArray(result.lines) &&
            result.lines.length <= 2_000 &&
            result.lines.every(
                (line) =>
                    line &&
                    typeof line.text === "string" &&
                    line.text.length <= 10_000 &&
                    line.box &&
                    [
                        line.box.x,
                        line.box.y,
                        line.box.width,
                        line.box.height,
                    ].every(Number.isFinite) &&
                    line.box.x >= 0 &&
                    line.box.y >= 0 &&
                    line.box.width >= 0 &&
                    line.box.height >= 0 &&
                    line.box.x + line.box.width <= result.width + 1 &&
                    line.box.y + line.box.height <= result.height + 1,
            )
                ? {
                      ...result,
                      text: result.text.slice(0, OCR_TEXT_LIMIT),
                      lines: result.lines.slice(0, 2_000),
                  }
                : {
                      ...result,
                      text: "",
                      lines: [],
                      error: result.error || "OCR failed.",
                  };
        currentJob.settle?.(normalized);
        const item = library.items.find((i) => i.id === currentJob.itemId);
        if (
            item &&
            !normalized.error &&
            !normalized.cancelled &&
            (item.draftRevision ?? 0) === currentJob.revision
        ) {
            item.ocrDone = true;
            item.ocrText = normalized.text || undefined;
            item.ocrLines = normalized.lines;
            touchCatalog();
            notifyLibraryUpdated();
        }
        pumpOcrQueue();
    });
    const workflowQueue = new CaptureWorkflowQueue<Electron.NativeImage>({
        copy: writeClipboardImage,
        removeBackground: async (path) =>
            removeBackground(nativeImage.createFromPath(path), root),
        saveDerived: async (image, originalPath) =>
            saveImage(image, "Cutout", false, dirname(originalPath)),
        pin: hooks.pin,
        indexText: async (path) => {
            const item = library.items.find(
                (candidate) => pathKey(candidate.path) === pathKey(path),
            );
            if (item) enqueueOcrIndex(item.id);
        },
        onError: recordWorkflowError,
    });
    const superResolution = createSuperResolution(join(userData, "sr"));
    const sendSrProgress = (id: string, phase: string, percent: number) => {
        if (
            dashboard &&
            !dashboard.isDestroyed() &&
            !dashboard.webContents.isDestroyed()
        )
            dashboard.webContents.send("oc:sr-progress", {
                id,
                phase,
                percent,
            });
    };
    const ignoredReceipts = new Set<string>();
    let inboxInFlight: Promise<void> | undefined;
    const quarantineReceipt = (path: string, reason: unknown) => {
        const message =
            reason instanceof Error ? reason.message : String(reason);
        let invalidPath = `${path}.invalid`;
        if (existsSync(invalidPath))
            invalidPath = `${path}.${randomUUID()}.invalid`;
        try {
            renameSync(path, invalidPath);
        } catch {
            ignoredReceipts.add(path);
        }
        addRecoveryWarning(
            `Capture receipt ${basename(path)} was quarantined: ${message}`,
        );
    };
    const processInbox = async () => {
        if (!existsSync(inboxPath)) return;
        const attempted = new Set<string>();
        while (true) {
            let receipts: string[];
            try {
                receipts = readdirSync(inboxPath, { withFileTypes: true })
                    .filter((entry) => {
                        const receiptPath = join(inboxPath, entry.name);
                        return (
                            entry.isFile() &&
                            entry.name.endsWith(".json") &&
                            !attempted.has(receiptPath) &&
                            !ignoredReceipts.has(receiptPath)
                        );
                    })
                    .map((entry) => entry.name)
                    .sort()
                    .slice(0, 100);
            } catch (error) {
                addRecoveryWarning(
                    `Capture inbox could not be read: ${error instanceof Error ? error.message : String(error)}`,
                );
                return;
            }
            if (receipts.length === 0) return;
            for (const name of receipts) {
                const receiptPath = join(inboxPath, name);
                attempted.add(receiptPath);
                let receipt: CaptureReceipt;
                try {
                    const receiptStats = statSync(receiptPath);
                    if (!receiptStats.isFile())
                        throw new Error("Capture receipt is not a file.");
                    if (receiptStats.size <= 0 || receiptStats.size > 8 * 1024)
                        throw new Error("Capture receipt is too large.");
                    const raw = readFileSync(receiptPath, "utf8");
                    receipt = validateCaptureReceipt(
                        JSON.parse(raw),
                        receiptStats.size,
                        [
                            ...library.collections.map(
                                (collection) => collection.path,
                            ),
                            defaultFolder,
                        ],
                    );
                } catch (error) {
                    quarantineReceipt(receiptPath, error);
                    continue;
                }
                let item = library.items.find(
                    (candidate) =>
                        pathKey(candidate.path) === pathKey(receipt.path),
                );
                if (!item) {
                    try {
                        if (!remember(receipt.path, receipt.createdAt, false)) {
                            quarantineReceipt(
                                receiptPath,
                                new Error(
                                    "Capture receipt image could not be decoded.",
                                ),
                            );
                            continue;
                        }
                        item = library.items.find(
                            (candidate) =>
                                pathKey(candidate.path) ===
                                pathKey(receipt.path),
                        );
                    } catch (error) {
                        addRecoveryWarning(
                            `Capture receipt ${name} could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        continue;
                    }
                }
                if (!item) continue;
                if (item.workflowComplete !== true) {
                    await workflowQueue.whenIdle();
                    if (!workflowQueue.enqueue(receipt.path, library.workflow))
                        continue;
                    if (library.workflow.autoPreview) requestPreview(item.id);
                    await workflowQueue.whenIdle();
                    const previous = item.workflowComplete;
                    item.workflowComplete = true;
                    try {
                        persist();
                    } catch (error) {
                        item.workflowComplete = previous;
                        addRecoveryWarning(
                            `Capture receipt ${name} workflow state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        continue;
                    }
                }
                try {
                    unlinkSync(receiptPath);
                } catch (error) {
                    ignoredReceipts.add(receiptPath);
                    addRecoveryWarning(
                        `Capture receipt ${name} was imported but could not be removed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    };
    const ingestInbox = () => {
        inboxInFlight ??= processInbox().finally(() => {
            inboxInFlight = undefined;
        });
        return inboxInFlight;
    };
    let inboxWatcher: FSWatcher | undefined;
    let inboxTimer: ReturnType<typeof setTimeout> | undefined;
    const stopInboxWatcher = () => {
        if (inboxTimer) clearTimeout(inboxTimer);
        inboxTimer = undefined;
        inboxWatcher?.close();
        inboxWatcher = undefined;
    };
    try {
        inboxWatcher = watch(
            inboxPath,
            { persistent: false },
            (_event, filename) => {
                if (!filename?.toString().endsWith(".json")) return;
                if (inboxTimer) clearTimeout(inboxTimer);
                inboxTimer = setTimeout(() => {
                    inboxTimer = undefined;
                    void ingestInbox().catch((error) =>
                        addRecoveryWarning(
                            `Capture inbox could not be processed: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                    );
                }, 150);
                inboxTimer.unref();
            },
        );
        inboxWatcher.on("error", (error) => {
            addRecoveryWarning(
                `Capture inbox watcher failed: ${error.message}`,
            );
            stopInboxWatcher();
        });
        app.once("will-quit", stopInboxWatcher);
    } catch (error) {
        addRecoveryWarning(
            `Capture inbox watcher could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    updateClipboardWatch();
    app.once("will-quit", () => {
        if (clipboardWatcher) clearInterval(clipboardWatcher);
        clipboardWatcher = undefined;
    });
    function importPaths(paths: unknown) {
        if (
            !Array.isArray(paths) ||
            paths.length > 20 ||
            paths.some((p) => typeof p !== "string")
        )
            throw new Error("이미지를 한 번에 20개까지 가져올 수 있습니다.");
        let skipped = 0;
        for (const path of paths) {
            const video = isVideoPath(path);
            const fileSize = statSync(path).size;
            if (
                (!video &&
                    !/\.(png|jpe?g|webp|bmp|gif)$/i.test(extname(path))) ||
                fileSize > (video ? 500 * 1024 * 1024 : 50 * 1024 * 1024)
            )
                throw new Error(
                    "50MB 이하 이미지 또는 500MB 이하 영상 파일을 선택해 주세요.",
                );
            const label = basename(path, extname(path))
                .replace(/[^\p{L}\p{N}_-]/gu, "_")
                .slice(0, 60);
            if (findDuplicate(path)) {
                skipped++;
                continue;
            }
            if (video) {
                mkdirSync(active().path, { recursive: true });
                const target = uniqueExportPath(
                    active().path,
                    `${label || "recording"}${extname(path).toLowerCase()}`,
                );
                copyFileSync(path, target);
                insertSavedItem(target, undefined, {
                    kind: "import",
                    capturedAt: new Date().toISOString(),
                });
                continue;
            }
            const image = nativeImage.createFromPath(path);
            if (image.isEmpty()) throw new Error("읽을 수 없는 이미지입니다.");
            const size = image.getSize();
            if (size.width * size.height > 80_000_000)
                throw new Error("이미지 해상도가 너무 큽니다.");
            if (extname(path).toLowerCase() === ".gif") {
                mkdirSync(active().path, { recursive: true });
                const target = uniqueExportPath(
                    active().path,
                    `${label || "capture"}.gif`,
                );
                copyFileSync(path, target);
                remember(target, undefined, true, false, {
                    kind: "import",
                    capturedAt: new Date().toISOString(),
                });
            } else
                saveImage(image, label, true, active().path, undefined, {
                    kind: "import",
                    capturedAt: new Date().toISOString(),
                });
        }
        if (skipped)
            dashboard?.webContents.send(
                "oc:workflow-error",
                `중복 이미지 ${skipped}개는 건너뛰었습니다.`,
            );
        return state();
    }
    function show(inactive = false) {
        if (dashboard && !dashboard.isDestroyed()) {
            if (inactive) dashboard.showInactive();
            else {
                dashboard.show();
                dashboard.focus();
            }
            return dashboard;
        }
        dashboardReady = false;
        boardWindowCloseAllowed = false;
        dashboardCloseInFlight = false;
        dashboard = new BrowserWindow({
            title: "OpenCapture",
            width: compact ? 420 : 1180,
            height: compact ? 560 : 810,
            minWidth: compact ? 360 : 850,
            minHeight: compact ? 480 : 640,
            backgroundColor: "#0c0c0e",
            ...(process.platform === "win32"
                ? {
                      titleBarStyle: "hidden" as const,
                      titleBarOverlay: {
                          color: "#0c0c0e",
                          symbolColor: "#f2f2f4",
                          height: 36,
                      },
                  }
                : {}),
            autoHideMenuBar: true,
            show: false,
            webPreferences: {
                preload: join(root, "out/preload/dashboard.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        const dashboardSenderId = dashboard.webContents.id;
        dashboard.webContents.on("will-navigate", (event) =>
            event.preventDefault(),
        );
        dashboard.webContents.on("console-message", (d) => {
            if (d.level === "error" || d.level === "warning")
                console.log(
                    "[dashboard]",
                    d.message,
                    `(${d.sourceId}:${d.lineNumber})`,
                );
        });
        dashboard.webContents.on("preload-error", (_e, p, err) => {
            dashboardReady = false;
            console.log("[dashboard preload error]", p, err);
        });
        dashboard.webContents.on("will-prevent-unload", () => {
            boardWindowCloseAllowed = false;
        });
        dashboard.webContents.on("render-process-gone", (_e, d) => {
            dashboardReady = false;
            console.log("[dashboard gone]", JSON.stringify(d));
        });
        dashboard.webContents.on("did-navigate", () => {
            if (dashboard && !dashboard.isDestroyed())
                registerRenderer(dashboard.webContents, "dashboard");
        });
        dashboard.webContents.on("did-finish-load", () => {
            if (dashboard && !dashboard.isDestroyed()) {
                dashboardReady = true;
                registerRenderer(dashboard.webContents, "dashboard");
            }
        });
        dashboard.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        dashboard.once("ready-to-show", () =>
            inactive ? dashboard?.showInactive() : dashboard?.show(),
        );
        dashboard.on("close", (event) => {
            if (boardWindowCloseAllowed) return;
            if (dashboardCloseInFlight) {
                event.preventDefault();
                return;
            }
            event.preventDefault();
            dashboardCloseInFlight = true;
            void requestBoardFlush().then((result) => {
                dashboardCloseInFlight = false;
                if (result.ok) {
                    allowBoardWindowClose();
                    dashboard?.close();
                    return;
                }
                dashboard?.webContents.send(
                    "oc:workflow-error",
                    result.message ??
                        "Board save failed. The window remains open.",
                );
            });
        });
        dashboard.on("closed", () => {
            boardCloseIntent = null;
            for (const [requestId, pending] of pendingBoardFlushes)
                if (pending.senderId === dashboardSenderId) {
                    clearTimeout(pending.timer);
                    pendingBoardFlushes.delete(requestId);
                    pending.settle({
                        ok: false,
                        message: "Board window closed before save completed.",
                    });
                }
            dashboard = null;
            dashboardReady = false;
            boardWindowCloseAllowed = false;
            dashboardCloseInFlight = false;
            thumbnailCacheGeneration++;
            thumbnailCache.clear();
        });
        if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
            dashboard.loadURL(
                `${process.env.ELECTRON_RENDERER_URL}/dashboard.html`,
            );
        else dashboard.loadFile(join(root, "out/renderer/dashboard.html"));
        return dashboard;
    }
    const toggleCompact = () => {
        compact = !compact;
        if (dashboard && !dashboard.isDestroyed()) {
            dashboard.setMinimumSize(compact ? 360 : 850, compact ? 480 : 640);
            dashboard.setSize(compact ? 420 : 1180, compact ? 560 : 810);
        }
    };
    const toggle = () => {
        if (dashboard && !dashboard.isDestroyed() && dashboard.isVisible())
            dashboard.close();
        else show();
    };
    const getPreferences = () => parseCaptureExperience(library.experience);
    const commitCapture = async (input: StageCaptureInput) => {
        const existing = input.id
            ? library.items.find(
                  (item) => item.id === input.id && item.draftRevision,
              )
            : undefined;
        if (input.id && !existing) throw new Error("Draft item was not found.");
        const liveDraftCount = library.items.filter(
            (item) => item.draftRevision && item.status === "temporary",
        ).length;
        const previousManifest: CaptureDraftManifest | undefined = input.id
            ? draftStore.manifest(input.id)
            : undefined;
        const manifest = await draftStore.stage(input, liveDraftCount);
        const item: Item = existing ?? {
            id: manifest.id,
            name: `Capture-${manifest.id.slice(0, 8)}.png`,
            path: manifest.previewPath,
            createdAt: manifest.committedAt,
            collectionId: library.activeCollectionId,
            status: "temporary",
        };
        const itemSnapshot = existing ? { ...existing } : undefined;
        const previousCatalogRevision = library.catalogRevision;
        item.path = manifest.previewPath;
        item.draftRevision = manifest.revision;
        item.draftCorrupt = undefined;
        item.draftManifestPath = draftStore.manifestPath(item.id);
        item.source = manifest.source;
        item.status ??= "temporary";
        if (!existing) library.items.unshift(item);
        try {
            library.catalogRevision = (library.catalogRevision ?? 0) + 1;
            if (!existing) persist();
        } catch (error) {
            library.catalogRevision = previousCatalogRevision;
            draftStore.rollback(manifest, previousManifest);
            if (existing && itemSnapshot) Object.assign(existing, itemSnapshot);
            else
                library.items = library.items.filter(
                    (candidate) => candidate.id !== item.id,
                );
            throw error;
        }
        notifyLibraryUpdated();
        if (!existing) {
            try {
                const image = inspectPng(readFileSync(manifest.sourcePath));
                boardStore.queueCapture(
                    {
                        item,
                        ...image,
                        region: manifest.rect,
                    },
                    boardStore.activeBoardId() ?? undefined,
                );
            } catch (error) {
                recordWorkflowError(item.path, "board auto-add", error);
            }
        }
        try {
            hooks.shelfChanged?.();
        } catch (error) {
            recordWorkflowError(item.path, "shelf notification", error);
        }
        try {
            draftStore.finalize(manifest.id);
        } catch (error) {
            recordWorkflowError(item.path, "draft cleanup", error);
        }
        return { id: item.id, revision: manifest.revision, item };
    };
    let draftStageQueue: Promise<unknown> = Promise.resolve();
    const stageCapture = (input: StageCaptureInput) => {
        const next = draftStageQueue
            .catch(() => undefined)
            .then(() => commitCapture(input));
        draftStageQueue = next;
        return next;
    };
    const getDraft = (id: string) => draftStore.get(id);
    const queryItems = async (request: CaptureItemsQuery) => {
        const result = queryCaptureItems(
            library.items,
            request,
            library.smartFilters ?? [],
            library.catalogRevision ?? 0,
        );
        const items = await Promise.all(
            result.items.map(async (item) => {
                const thumbnail = await thumbnailForItem(item);
                return thumbnail ? { ...item, thumbnail } : item;
            }),
        );
        return { ...result, items };
    };
    const transitionItems = (
        ids: unknown,
        transition: "promote" | "trash" | "restore",
    ) => {
        if (
            !Array.isArray(ids) ||
            ids.length < 1 ||
            ids.length > 200 ||
            ids.some((id) => typeof id !== "string") ||
            new Set(ids).size !== ids.length
        )
            throw new Error("Choose valid unique capture items.");
        const snapshot = applyCaptureTransition(
            library.items,
            ids as string[],
            transition,
        );
        const previousRevision = library.catalogRevision;
        try {
            touchCatalog();
        } catch (error) {
            library.catalogRevision = previousRevision;
            for (const previous of snapshot) {
                previous.item.status = previous.status;
                previous.item.previousStatus = previous.previousStatus;
            }
            throw error;
        }
        notifyLibraryUpdated();
        try {
            hooks.shelfChanged?.();
        } catch (error) {
            recordWorkflowError("workspace", "shelf notification", error);
        }
    };
    const boundedName = (value: unknown) => {
        if (typeof value !== "string") throw new Error("A name is required.");
        const name = value.trim().slice(0, 80);
        if (!name) throw new Error("A name is required.");
        return name;
    };
    const saveComparison = (value: SavedComparisonSession) => {
        if (
            !value ||
            typeof value !== "object" ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 100 ||
            !Array.isArray(value.itemIds) ||
            value.itemIds.length < 2 ||
            value.itemIds.length > 20 ||
            new Set(value.itemIds).size !== value.itemIds.length ||
            value.itemIds.some(
                (id) =>
                    typeof id !== "string" ||
                    !library.items.some((item) => item.id === id),
            ) ||
            !Array.isArray(value.notes) ||
            value.notes.length > 50 ||
            ![
                value.zoom,
                value.panX,
                value.panY,
                value.offsetX,
                value.offsetY,
                value.scale,
                value.threshold,
            ].every(Number.isFinite) ||
            !["side-by-side", "overlay", "slider", "difference"].includes(
                value.mode,
            )
        )
            throw new Error("Invalid comparison session.");
        const notes = value.notes.map((note) => {
            if (
                !note ||
                typeof note.id !== "string" ||
                !Number.isFinite(note.x) ||
                !Number.isFinite(note.y) ||
                note.x < 0 ||
                note.x > 1 ||
                note.y < 0 ||
                note.y > 1 ||
                typeof note.text !== "string"
            )
                throw new Error("Invalid comparison note.");
            return { ...note, text: note.text.slice(0, 500) };
        });
        library.comparisons ??= [];
        const session: SavedComparisonSession = {
            ...value,
            name: boundedName(value.name),
            notes,
            zoomMode: value.zoomMode === "actual" ? "actual" : "fit",
            opacity: Number.isFinite(value.opacity)
                ? Math.min(100, Math.max(0, value.opacity as number))
                : 50,
            wipe: Number.isFinite(value.wipe)
                ? Math.min(100, Math.max(0, value.wipe as number))
                : 50,
            updatedAt: new Date().toISOString(),
        };
        const index = library.comparisons.findIndex(
            (entry) => entry.id === value.id,
        );
        if (index >= 0) library.comparisons[index] = session;
        else {
            if (library.comparisons.length >= 50)
                throw new Error("At most 50 comparison sessions are allowed.");
            library.comparisons.unshift(session);
        }
        persist();
        return session;
    };
    const saveStyle = (value: NamedBeautifyStyle) => {
        if (
            !value ||
            typeof value !== "object" ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 100 ||
            typeof value.background !== "string" ||
            value.background.length > 500 ||
            ![value.padding, value.shadow, value.radius].every(
                Number.isFinite,
            ) ||
            value.padding < 0 ||
            value.padding > 512 ||
            value.shadow < 0 ||
            value.shadow > 100 ||
            value.radius < 0 ||
            value.radius > 256 ||
            typeof value.ratio !== "string" ||
            value.ratio.length > 20 ||
            typeof value.align !== "string" ||
            value.align.length > 30 ||
            typeof value.autoBalance !== "boolean"
        )
            throw new Error("Invalid style preset.");
        library.styles ??= [];
        const style = { ...value, name: boundedName(value.name) };
        const index = library.styles.findIndex(
            (entry) => entry.id === value.id,
        );
        if (index >= 0) library.styles[index] = style;
        else {
            if (library.styles.length >= 30)
                throw new Error("At most 30 styles are allowed.");
            library.styles.unshift(style);
        }
        persist();
        return style;
    };
    const saveSmartFilter = (value: SavedSmartFilter) => {
        if (
            !value ||
            typeof value !== "object" ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 100 ||
            (value.tags !== undefined && !isValidTags(value.tags)) ||
            (value.date !== undefined &&
                !["today", "week", "month"].includes(value.date)) ||
            (value.type !== undefined &&
                !["image", "video", "gif", "project"].includes(value.type))
        )
            throw new Error("Invalid smart filter.");
        library.smartFilters ??= [];
        const filter = {
            ...value,
            name: boundedName(value.name),
            tags: value.tags ? normalizeTags(value.tags) : undefined,
        };
        const index = library.smartFilters.findIndex(
            (entry) => entry.id === value.id,
        );
        if (index >= 0) library.smartFilters[index] = filter;
        else {
            if (library.smartFilters.length >= 50)
                throw new Error("At most 50 smart filters are allowed.");
            library.smartFilters.unshift(filter);
        }
        persist();
        return filter;
    };
    const removeNamed = (
        key: "comparisons" | "styles" | "smartFilters",
        id: unknown,
    ) => {
        if (typeof id !== "string")
            throw new Error("A saved item id is required.");
        const values = library[key] ?? [];
        library[key] = values.filter((entry) => entry.id !== id) as never;
        persist();
    };
    const shelfItem = (id: unknown) => {
        const item = getItem(id);
        if (item.status !== "temporary")
            throw new Error("Shelf actions require a temporary capture.");
        return item;
    };
    ipcMain.handle("oc:preferences:get", (event) => {
        assertRole(event, ["dashboard", "clip", "shelf", "pin"]);
        return getPreferences();
    });
    ipcMain.handle("oc:preferences:configure", (event, patch: unknown) => {
        assertRole(event, ["dashboard"]);
        const current = getPreferences();
        if (!patch || typeof patch !== "object")
            throw new Error("Invalid experience preferences.");
        library.experience = parseCaptureExperience({ ...current, ...patch });
        persist();
        return library.experience;
    });
    ipcMain.handle(
        "oc:draft:stage",
        async (event, input: StageCaptureInput) => {
            assertRole(event, ["clip"]);
            const registration = renderers.get(event.sender.id);
            if (
                input.id &&
                registration &&
                !registration.ownedDraftIds.has(input.id)
            )
                throw new Error("Clip renderer does not own this draft.");
            const result = await stageCapture(input);
            if (registration) {
                registration.ownedDraftIds.add(result.id);
                registration.draftId = result.id;
            }
            return result;
        },
    );
    ipcMain.handle("oc:draft:get", (event, id: unknown) => {
        const role = assertRole(event, ["dashboard", "clip"]);
        if (typeof id !== "string") throw new Error("Draft id is required.");
        const item = library.items.find((candidate) => candidate.id === id);
        if (!item?.draftRevision) throw new Error("Draft item was not found.");
        if (role === "clip") {
            const registration = renderers.get(event.sender.id);
            if (!registration?.draftId || registration.draftId !== id)
                throw new Error("Clip renderer is bound to another draft.");
            if (item.status === "trash")
                throw new Error("Trashed drafts cannot be edited.");
        }
        return getDraft(id);
    });
    ipcMain.handle("oc:clip:open-draft", async (event, id: unknown) => {
        assertRole(event, ["clip"]);
        if (typeof id !== "string") throw new Error("Draft id is required.");
        const registration = renderers.get(event.sender.id);
        if (!registration?.ownedDraftIds.has(id))
            throw new Error("Clip renderer does not own this draft.");
        shelfItem(id);
        registration.draftId = id;
        if (!hooks.openDraft) throw new Error("Editable draft is unavailable.");
        await hooks.openDraft(getDraft(id));
    });
    ipcMain.handle("oc:ocr:recognize", (event, id: unknown) => {
        const role = assertRole(event, ["dashboard", "clip", "shelf"]);
        if (typeof id !== "string")
            throw new Error("Capture item id is required.");
        if (role === "shelf") shelfItem(id);
        if (
            role === "clip" &&
            !renderers.get(event.sender.id)?.ownedDraftIds.has(id)
        )
            throw new Error("Clip renderer is bound to another draft.");
        return recognizeItem(id);
    });
    ipcMain.handle(
        "oc:items:query",
        async (event, request: CaptureItemsQuery) => {
            const role = assertRole(event, ["dashboard", "shelf"]);
            if (role === "shelf" && request?.scope !== "temporary")
                throw new Error("Shelf can query temporary captures only.");
            return queryItems(request);
        },
    );
    ipcMain.handle("oc:items:repair-draft", (event, id: unknown) => {
        assertRole(event, ["dashboard"]);
        const item = library.items.find((candidate) => candidate.id === id);
        if (!item?.draftCorrupt)
            throw new Error("손상된 항목이 아닙니다.");
        const draftDir = join(draftStore.root, item.id);
        const candidates = [
            join(draftDir, "source.png"),
            item.path,
            ...(existsSync(draftDir)
                ? readdirSync(draftDir)
                      .filter((entry) =>
                          existsSync(join(draftDir, entry, "preview.png")),
                      )
                      .sort()
                      .reverse()
                      .map((entry) => join(draftDir, entry, "preview.png"))
                : []),
        ];
        const surviving = candidates.find(
            (candidate) =>
                candidate &&
                existsSync(candidate) &&
                !nativeImage.createFromPath(candidate).isEmpty(),
        );
        if (!surviving)
            throw new Error("복구할 파일이 남아 있지 않습니다.");
        const collection =
            library.collections.find(
                (candidate) => candidate.id === item.collectionId,
            ) ?? library.collections[0];
        mkdirSync(collection.path, { recursive: true });
        const target = uniqueExportPath(
            collection.path,
            item.name.toLowerCase().endsWith(".png")
                ? item.name
                : `${item.name}.png`,
        );
        copyFileSync(surviving, target);
        item.path = target;
        item.status = "library";
        item.previousStatus = undefined;
        item.draftRevision = undefined;
        item.draftCorrupt = undefined;
        item.draftManifestPath = undefined;
        item.thumbnailPath = undefined;
        touchCatalog();
        try {
            hooks.shelfChanged?.();
        } catch (error) {
            recordWorkflowError(item.path, "shelf notification", error);
        }
        return state();
    });
    ipcMain.handle("oc:items:promote", (event, ids: unknown) => {
        const role = assertRole(event, ["dashboard", "clip", "shelf"]);
        if (role === "shelf" && Array.isArray(ids))
            for (const id of ids) shelfItem(id);
        if (role === "clip" && Array.isArray(ids))
            for (const id of ids)
                if (!renderers.get(event.sender.id)?.ownedDraftIds.has(id))
                    throw new Error("Clip renderer does not own this draft.");
        transitionItems(ids, "promote");
        return role === "clip" ? true : state();
    });
    ipcMain.handle("oc:items:trash", (event, ids: unknown) => {
        const role = assertRole(event, ["dashboard", "clip", "shelf"]);
        if (role === "shelf" && Array.isArray(ids))
            for (const id of ids) shelfItem(id);
        if (role === "clip" && Array.isArray(ids))
            for (const id of ids)
                if (!renderers.get(event.sender.id)?.ownedDraftIds.has(id))
                    throw new Error("Clip renderer does not own this draft.");
        transitionItems(ids, "trash");
        return role === "clip" ? true : state();
    });
    ipcMain.handle("oc:items:restore", (event, ids: unknown) => {
        assertRole(event, ["dashboard"]);
        transitionItems(ids, "restore");
        return state();
    });
    ipcMain.handle("oc:items:copy-source", (event, ids: unknown) => {
        const role = assertRole(event, ["dashboard", "shelf"]);
        if (!Array.isArray(ids)) throw new Error("Choose source files.");
        const items = ids.map((id) =>
            role === "shelf" ? shelfItem(id) : getItem(id),
        );
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) throw new Error("Clipboard owner window is unavailable.");
        return copyFilesToWindowsClipboard(
            root,
            owner,
            items.map((item) => item.path),
            join(userData, "clipboard-files"),
        );
    });
    ipcMain.handle(
        "oc:shelf:action",
        async (event, name: unknown, id: unknown) => {
            assertRole(event, ["shelf"]);
            const item = shelfItem(id);
            if (name === "copy") await writeClipboardImage(item.path);
            else if (name === "pin") await hooks.pin(item.path);
            else if (name === "edit") {
                if (!hooks.openDraft || !item.draftRevision)
                    throw new Error("Editable draft is unavailable.");
                await hooks.openDraft(getDraft(item.id));
            } else throw new Error("Shelf action is not permitted.");
            return true;
        },
    );
    ipcMain.handle("oc:compare:open", (event, ids: unknown) => {
        const role = assertRole(event, ["dashboard", "clip", "shelf"]);
        if (
            !Array.isArray(ids) ||
            ids.length < 2 ||
            ids.length > 20 ||
            ids.some((id) => typeof id !== "string") ||
            new Set(ids).size !== ids.length
        )
            throw new Error("Choose between 2 and 20 unique references.");
        if (role === "shelf") for (const id of ids) shelfItem(id);
        if (role === "clip") {
            const owned = renderers.get(event.sender.id)?.ownedDraftIds;
            if (!owned || ids.some((id) => !owned.has(id)))
                throw new Error(
                    "Clip renderer can compare only its staged drafts.",
                );
            for (const id of ids) shelfItem(id);
        }
        const window = show();
        const notify = () =>
            window.webContents.send("oc:compare:requested", ids);
        if (window.webContents.isLoading())
            window.webContents.once("did-finish-load", notify);
        else notify();
    });
    ipcMain.handle("oc:comparisons:save", (event, value) => {
        assertRole(event, ["dashboard"]);
        return saveComparison(value);
    });
    ipcMain.handle("oc:comparisons:list", (event) => {
        assertRole(event, ["dashboard"]);
        return library.comparisons ?? [];
    });
    ipcMain.handle("oc:comparisons:remove", (event, id) => {
        assertRole(event, ["dashboard"]);
        removeNamed("comparisons", id);
    });
    ipcMain.handle("oc:styles:save", (event, value) => {
        assertRole(event, ["dashboard"]);
        return saveStyle(value);
    });
    ipcMain.handle("oc:styles:list", (event) => {
        assertRole(event, ["dashboard"]);
        return library.styles ?? [];
    });
    ipcMain.handle("oc:styles:remove", (event, id) => {
        assertRole(event, ["dashboard"]);
        removeNamed("styles", id);
    });
    ipcMain.handle("oc:smart-filters:save", (event, value) => {
        assertRole(event, ["dashboard"]);
        return saveSmartFilter(value);
    });
    ipcMain.handle("oc:smart-filters:list", (event) => {
        assertRole(event, ["dashboard"]);
        return library.smartFilters ?? [];
    });
    ipcMain.handle("oc:smart-filters:remove", (event, id) => {
        assertRole(event, ["dashboard"]);
        removeNamed("smartFilters", id);
    });
    ipcMain.handle("oc:colors:add", (event, value: unknown) => {
        assertRole(event, ["dashboard", "clip"]);
        if (typeof value !== "string" || !/^#[0-9a-f]{6,8}$/i.test(value))
            throw new Error("Sampled color must be a hex color.");
        library.colors ??= [];
        library.colors = [
            { value: value.toUpperCase(), sampledAt: new Date().toISOString() },
            ...library.colors.filter(
                (entry) => entry.value.toUpperCase() !== value.toUpperCase(),
            ),
        ].slice(0, 24);
        persist();
        return library.colors;
    });
    ipcMain.handle("oc:colors:list", (event) => {
        assertRole(event, ["dashboard", "clip"]);
        return library.colors ?? [];
    });
    ipcMain.handle("oc:jobs:cancel", (event, jobId: unknown) => {
        assertRole(event, ["dashboard", "shelf"]);
        if (typeof jobId !== "string") return false;
        return cancelOcrJob(jobId) || superResolution.cancel();
    });
    const assertDashboard = (event: IpcMainInvokeEvent) =>
        assertRole(event, ["dashboard"]);
    ipcMain.handle("oc:boards:finish-close", (event) => {
        assertDashboard(event);
        if (
            !dashboard ||
            dashboard.isDestroyed() ||
            event.sender !== dashboard.webContents ||
            !boardCloseIntent
        )
            throw new Error("No pending board close.");
        if (boardCloseIntent === "quit") {
            if (!hooks.quit) throw new Error("App quit is unavailable.");
            hooks.quit();
        } else {
            boardWindowCloseAllowed = false;
            dashboard.close();
        }
    });
    ipcMain.handle(
        "oc:boards:flush-ack",
        (event, requestId: unknown, ok: unknown, message: unknown) => {
            assertDashboard(event);
            if (
                typeof requestId !== "string" ||
                typeof ok !== "boolean" ||
                (message !== undefined &&
                    (typeof message !== "string" || message.length > 500))
            )
                throw new Error("Invalid board flush acknowledgement.");
            const pending = pendingBoardFlushes.get(requestId);
            if (!pending || pending.senderId !== event.sender.id)
                throw new Error("Board save acknowledgement expired.");
            clearTimeout(pending.timer);
            pendingBoardFlushes.delete(requestId);
            pending.settle({
                ok,
                ...(typeof message === "string" && message ? { message } : {}),
            });
        },
    );
    ipcMain.handle("oc:boards:status", (event) => {
        assertDashboard(event);
        return boardStore.status();
    });
    ipcMain.handle("oc:boards:list", (event) => {
        assertDashboard(event);
        return boardStore.list();
    });
    ipcMain.handle("oc:boards:create", (event, name: unknown) => {
        assertDashboard(event);
        if (name !== undefined && typeof name !== "string")
            throw new Error("Board name must be text.");
        return boardStore.create(name);
    });
    ipcMain.handle("oc:boards:load", (event, id: unknown) => {
        assertDashboard(event);
        if (typeof id !== "string") throw new Error("Board id is required.");
        return boardStore.load(id);
    });
    ipcMain.handle(
        "oc:boards:save",
        (event, document: BoardDocument, expectedRevision: unknown) => {
            assertDashboard(event);
            if (
                !Number.isSafeInteger(expectedRevision) ||
                (expectedRevision as number) < 0
            )
                throw new Error("Expected board revision is required.");
            return boardStore.save(document, expectedRevision as number);
        },
    );
    ipcMain.handle("oc:boards:set-active", (event, id: unknown) => {
        assertDashboard(event);
        if (id !== null && typeof id !== "string")
            throw new Error("Board id must be text or null.");
        boardStore.setActive(id as string | null);
    });
    ipcMain.handle(
        "oc:boards:add-items",
        (
            event,
            boardId: unknown,
            itemIds: unknown,
            expectedRevision: unknown,
        ) => {
            assertDashboard(event);
            if (
                typeof boardId !== "string" ||
                !Array.isArray(itemIds) ||
                itemIds.some((id) => typeof id !== "string") ||
                !Number.isSafeInteger(expectedRevision)
            )
                throw new Error("Invalid board item request.");
            let revision = expectedRevision as number;
            let document = boardStore.load(boardId);
            const pending = new Set(
                boardStore
                    .pendingCaptures()
                    .filter((entry) => entry.targetBoardId === boardId)
                    .map((entry) => entry.itemId),
            );
            for (const itemId of itemIds as string[])
                if (pending.has(itemId)) {
                    document = boardStore.adoptPending(
                        itemId,
                        boardId,
                        revision,
                    );
                    revision = document.revision;
                }
            const remaining = (itemIds as string[]).filter(
                (itemId) => !pending.has(itemId),
            );
            return remaining.length
                ? boardStore.addItems(boardId, remaining, revision)
                : document;
        },
    );
    ipcMain.handle(
        "oc:boards:asset-data",
        (event, boardId: unknown, assetId: unknown, quality: unknown) => {
            assertDashboard(event);
            if (typeof boardId !== "string" || typeof assetId !== "string")
                throw new Error("Board and asset ids are required.");
            if (
                quality !== undefined &&
                !["preview", "original"].includes(quality as string)
            )
                throw new Error("Invalid board asset quality.");
            return boardStore.assetData(
                boardId,
                assetId,
                quality as "preview" | "original" | undefined,
            );
        },
    );
    ipcMain.handle(
        "oc:boards:cutout",
        (event, boardId: unknown, nodeId: unknown, sourceAssetId: unknown) => {
            assertDashboard(event);
            if (
                typeof boardId !== "string" ||
                typeof nodeId !== "string" ||
                typeof sourceAssetId !== "string"
            )
                throw new Error("Board cutout ids are required.");
            return boardStore.cutout(boardId, nodeId, sourceAssetId);
        },
    );
    ipcMain.handle(
        "oc:boards:beautify",
        (event, boardId: unknown, images: unknown, style: unknown) => {
            assertDashboard(event);
            if (typeof boardId !== "string" || !Array.isArray(images))
                throw new Error("Invalid board beautify request.");
            return boardStore.beautify(
                boardId,
                images as Array<{ nodeId: string; sourceAssetId: string }>,
                style as NamedBeautifyStyle,
            );
        },
    );
    ipcMain.handle(
        "oc:boards:discard-derived",
        (event, boardId: unknown, assetIds: unknown) => {
            assertDashboard(event);
            if (
                typeof boardId !== "string" ||
                !Array.isArray(assetIds) ||
                assetIds.some((id) => typeof id !== "string")
            )
                throw new Error("Invalid derived asset discard request.");
            boardStore.discardDerived(boardId, assetIds as string[]);
        },
    );
    ipcMain.handle(
        "oc:boards:export-file",
        async (event, boardId: unknown, format: unknown, dataURL: unknown) => {
            assertDashboard(event);
            if (
                typeof boardId !== "string" ||
                !["png", "pdf"].includes(format as string) ||
                typeof dataURL !== "string"
            )
                throw new Error("Invalid board export request.");
            const board = boardStore.load(boardId);
            const exportFormat = format as "png" | "pdf";
            const options = {
                defaultPath: `${board.name}.${exportFormat}`,
                filters: [
                    {
                        name: exportFormat.toUpperCase(),
                        extensions: [exportFormat],
                    },
                ],
            };
            const picked = dashboard
                ? await dialog.showSaveDialog(dashboard, options)
                : await dialog.showSaveDialog(options);
            if (picked.canceled || !picked.filePath) return { saved: false };
            const decoded = decodeBoundedImageDataURL(dataURL);
            if (decoded.width * decoded.height > 16_000_000)
                throw new Error("Board export exceeds 16 megapixels.");
            const bytes =
                exportFormat === "pdf" ? imagePdf(dataURL) : decoded.png;
            writeFileSync(picked.filePath, bytes);
            return { saved: true, path: picked.filePath };
        },
    );
    ipcMain.handle(
        "oc:boards:export-portable",
        async (event, boardId: unknown) => {
            assertDashboard(event);
            if (typeof boardId !== "string")
                throw new Error("Board id is required.");
            const board = boardStore.load(boardId);
            const options = {
                defaultPath: `${board.name}.ocboard`,
                filters: [
                    { name: "OpenCapture Board", extensions: ["ocboard"] },
                ],
            };
            const picked = dashboard
                ? await dialog.showSaveDialog(dashboard, options)
                : await dialog.showSaveDialog(options);
            if (picked.canceled || !picked.filePath) return { saved: false };
            writeFileSync(picked.filePath, boardStore.portable(boardId));
            return { saved: true, path: picked.filePath };
        },
    );
    ipcMain.handle("oc:boards:import-portable", async (event) => {
        assertDashboard(event);
        const options = {
            properties: ["openFile"] as Array<"openFile">,
            filters: [{ name: "OpenCapture Board", extensions: ["ocboard"] }],
        };
        const picked = dashboard
            ? await dialog.showOpenDialog(dashboard, options)
            : await dialog.showOpenDialog(options);
        if (picked.canceled || !picked.filePaths[0]) return null;
        const file = picked.filePaths[0];
        if (statSync(file).size > 96 * 1024 * 1024)
            throw new Error("Portable board exceeds 96 MiB.");
        return boardStore.importPortable(readFileSync(file, "utf8"));
    });
    ipcMain.handle("oc:boards:pending-captures", (event) => {
        assertDashboard(event);
        return boardStore.pendingCaptures();
    });
    ipcMain.handle(
        "oc:boards:ack-capture",
        (event, itemId: unknown, targetBoardId: unknown) => {
            assertDashboard(event);
            if (typeof itemId !== "string" || typeof targetBoardId !== "string")
                throw new Error("Capture and board ids are required.");
            boardStore.ackCapture(itemId, targetBoardId);
        },
    );
    ipcMain.handle("oc:image:cutout", (event, input: CaptureCutoutInput) => {
        const role = assertRole(event, ["dashboard", "pin"]);
        if (role === "pin" && input?.itemId)
            throw new Error("Pins may cut out only their registered raster.");
        return cutoutImage(input);
    });
    ipcMain.handle("oc:state", (event) => {
        assertSender(event, true);
        return state();
    });
    ipcMain.on("oc:lang", (event) => {
        try {
            assertSender(event, true);
            event.returnValue = hooks.language?.() ?? "ko";
        } catch {
            event.returnValue = "ko";
        }
    });
    ipcMain.handle("oc:import-files", (event, paths) => {
        assertSender(event, true);
        try {
            return importPaths(paths);
        } finally {
            dashboard?.setAlwaysOnTop(false);
        }
    });
    ipcMain.handle("oc:translate", (event, input) => {
        assertSender(event);
        return hooks.translate(input);
    });
    ipcMain.handle("oc:translation-status", (event) => {
        assertSender(event);
        return hooks.translationStatus();
    });
    ipcMain.handle("oc:install-models", (event) => {
        assertSender(event, true);
        return hooks.installModels();
    });
    ipcMain.handle("oc:configure-translation", (event, input) => {
        assertSender(event, true);
        return hooks.configureTranslation(input);
    });
    ipcMain.handle("oc:item-data", (event, id) => {
        assertSender(event, true);
        const item = getItem(id);
        const image = nativeImage.createFromPath(item.path);
        if (image.isEmpty()) throw new Error("읽을 수 없는 이미지입니다.");
        const size = image.getSize();
        if (size.width * size.height > 80_000_000)
            throw new Error("이미지 해상도가 너무 큽니다.");
        return image.toDataURL();
    });
    ipcMain.handle("oc:item-file", (event, id) => {
        assertSender(event, true);
        const item = getItem(id);
        const stat = statSync(item.path);
        if (stat.size > 50 * 1024 * 1024)
            throw new Error("파일이 너무 큽니다.");
        return readFileSync(item.path);
    });
    ipcMain.on("oc:drag", (event, id) => {
        try {
            assertSender(event);
            let item: Item;
            if (event.sender.id === dashboard?.webContents.id)
                item = getItem(id);
            else {
                assertRole(event, ["shelf"]);
                item = shelfItem(id);
            }
            const source = nativeImage.createFromPath(item.path);
            const size = source.getSize();
            const scale = Math.min(1, 128 / Math.max(size.width, size.height));
            const icon =
                scale < 1
                    ? source.resize({
                          width: Math.round(size.width * scale),
                          height: Math.round(size.height * scale),
                      })
                    : source;
            event.sender.startDrag({ file: item.path, icon });
        } catch {
            // Drag requests from untrusted frames or missing files are ignored.
        }
    });
    ipcMain.handle(
        "oc:action",
        async (event, name: unknown, payload: unknown) => {
            assertSender(event, true);
            if (typeof name !== "string")
                throw new Error("알 수 없는 동작입니다.");
            if (
                [
                    "capture",
                    "fullscreen",
                    "previous",
                    "window",
                    "scroll",
                    "record",
                    "ocr",
                    "screen-translate",
                ].includes(name)
            ) {
                dashboard?.hide();
                await new Promise((r) => setTimeout(r, 220));
                try {
                    await hooks.capture(name);
                } catch (error) {
                    show();
                    throw error;
                }
            } else if (name === "pin-clipboard") await hooks.pin();
            else if (name === "settings") hooks.settings();
            else if (name === "restore-pins") hooks.restorePins();
            else if (name === "steps") hooks.steps?.();
            else if (name === "configure-workflow") {
                library.workflow = parseCaptureWorkflowPreferences(
                    payload,
                    library.workflow,
                );
                persist();
                persistCaptureSettings();
                updateClipboardWatch();
            } else if (name === "configure-runtime") {
                if (!hooks.configureRuntime)
                    throw new Error("Runtime settings are unavailable.");
                await hooks.configureRuntime(payload);
            } else if (name === "toggle-compact") toggleCompact();
            else if (name === "hide-window") dashboard?.close();
            else if (name === "load-items") {
                if (!payload || typeof payload !== "object")
                    throw new Error("A page request is required.");
                const { offset, limit = 200 } = payload as {
                    offset?: unknown;
                    limit?: unknown;
                };
                if (
                    !Number.isSafeInteger(offset) ||
                    (offset as number) < 0 ||
                    !Number.isSafeInteger(limit) ||
                    (limit as number) < 1 ||
                    (limit as number) > 200
                )
                    throw new Error("Invalid library page.");
                return {
                    items: await itemsPage(offset as number, limit as number),
                    totalItemCount: activeItems().length,
                    allItemCount: library.items.length,
                };
            } else if (name === "export-items") {
                const items = selectedItems(payload);
                const picked = await dialog.showOpenDialog({
                    properties: ["openDirectory", "createDirectory"],
                });
                if (!picked.canceled && picked.filePaths[0]) {
                    const folder = picked.filePaths[0];
                    for (const item of items)
                        copyFileSync(
                            item.path,
                            uniqueExportPath(folder, item.name),
                            constants.COPYFILE_EXCL,
                        );
                }
            } else if (name === "pin-items") {
                for (const item of selectedItems(payload))
                    await hooks.pin(item.path);
            } else if (name === "combine-items") {
                const items = selectedItems(payload, 20);
                if (items.length < 2)
                    throw new Error("Select at least two images to combine.");
                const direction = (payload as { direction?: unknown })
                    .direction;
                if (direction !== "vertical" && direction !== "horizontal")
                    throw new Error("Choose a valid combine direction.");
                saveImage(combineImages(items, direction), "Combined", false);
            } else if (name === "add-collection") {
                if (library.collections.length >= 6)
                    throw new Error(
                        "기본 폴더 외에 5개까지 추가할 수 있습니다.",
                    );
                const picked = await dialog.showOpenDialog({
                    properties: ["openDirectory", "createDirectory"],
                });
                if (!picked.canceled && picked.filePaths[0]) {
                    const path = picked.filePaths[0];
                    if (!library.collections.some((c) => c.path === path))
                        library.collections.push({
                            id: randomUUID(),
                            name: basename(path),
                            path,
                        });
                    persist();
                }
            } else if (name === "choose-collection") {
                const collection = library.collections.find(
                    (c) => c.id === payload,
                );
                if (!collection) throw new Error("컬렉션을 찾을 수 없습니다.");
                library.activeCollectionId = collection.id;
                hooks.setSaveFolder(collection.path);
                persist();
                persistCaptureSettings();
            } else if (name === "open-image") {
                const picked = await dialog.showOpenDialog({
                    properties: ["openFile", "multiSelections"],
                    filters: [
                        {
                            name: "이미지·영상",
                            extensions: [
                                "png",
                                "jpg",
                                "jpeg",
                                "webp",
                                "bmp",
                                "gif",
                                ...[...VIDEO_EXTENSIONS].map((e) => e.slice(1)),
                            ],
                        },
                    ],
                });
                if (!picked.canceled) importPaths(picked.filePaths);
            } else if (name === "open-item") {
                const item = getItem(payload);
                if (item.draftRevision && hooks.openDraft)
                    await hooks.openDraft(getDraft(item.id));
                else if (isProjectPath(item.path) && hooks.openProject)
                    await hooks.openProject(item.path);
                else if (isVideoPath(item.path))
                    await shell.openPath(item.path);
                else hooks.edit(item.path);
            } else if (name === "pin-item")
                await hooks.pin(getItem(payload).path);
            else if (name === "reveal-item")
                shell.showItemInFolder(getItem(payload).path);
            else if (name === "copy-item")
                await writeClipboardImage(getItem(payload).path);
            else if (
                name === "dropzone" ||
                name === "library" ||
                name === "cheatsheet"
            )
                show();
            else if (name === "remove-background") {
                const source = getItem(payload);
                const original = nativeImage.createFromPath(source.path);
                const result = await removeBackground(original, root);
                saveImage(result, "Cutout", false, dirname(source.path));
            } else if (name === "toggle-favorite") {
                const item = getItem(payload);
                item.favorite = !item.favorite;
                touchCatalog();
            } else if (name === "rename-item") {
                if (!payload || typeof payload !== "object")
                    throw new Error("이름 변경 요청이 올바르지 않습니다.");
                const { id, name: rawName } = payload as {
                    id?: unknown;
                    name?: unknown;
                };
                const item = getItem(id);
                if (typeof rawName !== "string")
                    throw new Error("새 이름을 입력해 주세요.");
                const extension = extname(item.path);
                let next = rawName
                    .trim()
                    .replace(/[\\/:*?"<>|]/g, "")
                    .replace(/\p{C}/gu, "");
                if (!next.toLowerCase().endsWith(extension.toLowerCase()))
                    next = `${next}${extension}`;
                next = next.slice(0, 100);
                if (!next || next === extension)
                    throw new Error("새 이름을 입력해 주세요.");
                const target = join(dirname(item.path), next);
                if (pathKey(target) !== pathKey(item.path)) {
                    if (existsSync(target))
                        throw new Error("같은 이름의 파일이 이미 있습니다.");
                    renameSync(item.path, target);
                    item.path = target;
                }
                item.name = next;
                touchCatalog();
            } else if (name === "duplicate-item") {
                const item = getItem(payload);
                const target = uniqueExportPath(dirname(item.path), item.name);
                copyFileSync(item.path, target, constants.COPYFILE_EXCL);
                remember(target);
            } else if (name === "set-note") {
                if (!payload || typeof payload !== "object")
                    throw new Error("메모 요청이 올바르지 않습니다.");
                const { id, note: rawNote } = payload as {
                    id?: unknown;
                    note?: unknown;
                };
                const item = getItem(id);
                const note =
                    typeof rawNote === "string"
                        ? rawNote.trim().slice(0, 2000)
                        : "";
                if (note) item.note = note;
                else item.note = undefined;
                touchCatalog();
            } else if (name === "set-tags") {
                if (!payload || typeof payload !== "object")
                    throw new Error("태그 요청이 올바르지 않습니다.");
                const { id, tags: rawTags } = payload as {
                    id?: unknown;
                    tags?: unknown;
                };
                const item = getItem(id);
                if (!Array.isArray(rawTags))
                    throw new Error("태그 목록이 올바르지 않습니다.");
                item.tags = normalizeTags(rawTags);
                touchCatalog();
            } else if (name === "save-pin-set") {
                const ids = selectedItems(payload, 50).map((i) => i.id);
                if (!ids.length)
                    throw new Error("핀 세트에 넣을 항목을 선택해 주세요.");
                library.pinSets ??= [];
                if (library.pinSets.length >= 50)
                    throw new Error("핀 세트는 최대 50개까지 저장됩니다.");
                library.pinSets.unshift({
                    id: randomUUID(),
                    name: `핀 세트 ${library.pinSets.length + 1}`,
                    itemIds: ids,
                });
                persist();
            } else if (name === "pin-set") {
                const set = getPinSet(payload);
                for (const itemId of set.itemIds) {
                    const item = library.items.find((i) => i.id === itemId);
                    if (item && existsSync(item.path))
                        await hooks.pin(item.path);
                }
            } else if (name === "remove-pin-set") {
                const set = getPinSet(payload);
                library.pinSets = (library.pinSets ?? []).filter(
                    (s) => s.id !== set.id,
                );
                persist();
            } else if (name === "ai-upscale") {
                const item = getItem(payload);
                const image = nativeImage.createFromPath(item.path);
                if (image.isEmpty())
                    throw new Error("이미지를 읽을 수 없습니다.");
                try {
                    const result = await superResolution.upscale(
                        image,
                        (progress) =>
                            sendSrProgress(
                                item.id,
                                progress.phase,
                                progress.percent,
                            ),
                    );
                    saveImage(result, "AI", false, dirname(item.path));
                } catch (error) {
                    if (
                        error &&
                        typeof error === "object" &&
                        "code" in error &&
                        error.code === "SUPER_RESOLUTION_CANCELLED"
                    )
                        return state();
                    sendSrProgress(item.id, "error", 0);
                    throw error;
                }
            } else if (name === "save-gif") {
                if (!payload || typeof payload !== "object")
                    throw new Error("저장 요청이 올바르지 않습니다.");
                const { id, dataURL } = payload as {
                    id?: unknown;
                    dataURL?: unknown;
                };
                const item = getItem(id);
                if (
                    typeof dataURL !== "string" ||
                    !dataURL.startsWith("data:image/gif;base64,")
                )
                    throw new Error("GIF 데이터가 올바르지 않습니다.");
                const data = Buffer.from(
                    dataURL.slice("data:image/gif;base64,".length),
                    "base64",
                );
                if (data.byteLength === 0 || data.byteLength > 50 * 1024 * 1024)
                    throw new Error("GIF 파일 크기가 올바르지 않습니다.");
                if (data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46)
                    throw new Error("GIF 데이터가 올바르지 않습니다.");
                const target = join(
                    dirname(item.path),
                    `GifClip-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}.gif`,
                );
                writeFileSync(target, data, { flag: "wx" });
                insertSavedItem(target);
            } else if (name === "copy-composed") {
                if (!payload || typeof payload !== "object")
                    throw new Error("복사 요청이 올바르지 않습니다.");
                const { dataURL } = payload as { dataURL?: unknown };
                if (
                    typeof dataURL !== "string" ||
                    !dataURL.startsWith("data:image/png;base64,") ||
                    dataURL.length > 120_000_000
                )
                    throw new Error("묶음 이미지 데이터가 올바르지 않습니다.");
                const image = nativeImage.createFromDataURL(dataURL);
                if (image.isEmpty())
                    throw new Error("묶음 이미지를 읽을 수 없습니다.");
                const size = image.getSize();
                if (
                    size.width <= 0 ||
                    size.height <= 0 ||
                    size.width * size.height > 80_000_000
                )
                    throw new Error("묶음 이미지 해상도가 너무 큽니다.");
                const png = image.toPNG();
                ownClipboardSig = createHash("sha1").update(png).digest("hex");
                await clipboard.write([
                    new ClipboardItem({
                        "image/png": new Blob([png], { type: "image/png" }),
                    }),
                ]);
            } else if (name === "index-ocr") {
                const ids =
                    typeof payload === "string"
                        ? [getItem(payload).id]
                        : selectedItems(payload, 200).map((i) => i.id);
                for (const id of ids) enqueueOcrIndex(id);
            } else if (name === "save-composed") {
                if (!payload || typeof payload !== "object")
                    throw new Error("저장 요청이 올바르지 않습니다.");
                const { id, dataURL, label } = payload as {
                    id?: unknown;
                    dataURL?: unknown;
                    label?: unknown;
                };
                const item = getItem(id);
                if (
                    typeof dataURL !== "string" ||
                    !dataURL.startsWith("data:image/png;base64,") ||
                    dataURL.length > 120_000_000
                )
                    throw new Error("합성 이미지 데이터가 올바르지 않습니다.");
                const image = nativeImage.createFromDataURL(dataURL);
                if (image.isEmpty())
                    throw new Error("합성 이미지를 읽을 수 없습니다.");
                const size = image.getSize();
                if (size.width * size.height > 80_000_000)
                    throw new Error("이미지 해상도가 너무 큽니다.");
                const fileLabel = [
                    "Upscale",
                    "Annotated",
                    "Steps",
                    "Crop",
                    "Folded",
                ].includes(label as string)
                    ? (label as string)
                    : "Framed";
                saveImage(image, fileLabel, false, dirname(item.path));
            } else throw new Error("지원하지 않는 동작입니다.");
            return state();
        },
    );
    return {
        registerRenderer,
        getPreferences,
        stageCapture,
        getDraft,
        recognizeItem,
        queryItems,
        requestBoardFlush,
        allowBoardWindowClose,
        show,
        toggle,
        ingestInbox,
        whenIdle: async () => {
            await inboxInFlight;
            await workflowQueue.whenIdle();
        },
        showDropzone: () => {
            const window = show(true);
            window.setAlwaysOnTop(true);
            const notify = () => window.webContents.send("oc:show-library");
            if (window.webContents.isLoading())
                window.webContents.once("did-finish-load", notify);
            else notify();
        },
        remember,
        rememberMedia,
        rememberProject: (path: string) => insertSavedItem(path, undefined),
        saveImage,
        ocrOnce,
        state,
        importPaths,
        activeFolder: () => active().path,
    };
}
