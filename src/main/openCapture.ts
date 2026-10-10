import { randomUUID } from "node:crypto";
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
    app,
    clipboard,
    dialog,
    ipcMain,
    nativeImage,
    shell,
} from "electron";
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
import { removeBackground } from "./backgroundRemoval";
import { createSuperResolution } from "./superResolution";

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
};
type PinSet = { id: string; name: string; itemIds: string[] };
type Library = {
    collections: Collection[];
    items: Item[];
    activeCollectionId: string;
    workflow: CaptureWorkflowPreferences;
    pinSets?: PinSet[];
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
                (i.thumbnail === undefined || typeof i.thumbnail === "string"),
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
                )))
    );
}
type Hooks = {
    capture: (mode: string) => Promise<void>;
    pin: (path?: string) => Promise<void>;
    edit: (path: string) => void;
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
    mkdirSync(defaultFolder, { recursive: true });
    mkdirSync(inboxPath, { recursive: true });
    let library: Library = {
        collections: [
            { id: "default", name: "모든 캡처", path: defaultFolder },
        ],
        items: [],
        activeCollectionId: "default",
        workflow: { ...defaultCaptureWorkflowPreferences },
    };
    let recoveryWarning: string | undefined;
    if (existsSync(dataPath)) {
        try {
            const data = JSON.parse(readFileSync(dataPath, "utf8"));
            if (!isLibrary(data)) throw new Error("Invalid library index");
            library = {
                ...data,
                items: data.items.map(
                    ({ thumbnail: _thumbnail, ...item }) => item,
                ),
                workflow: parseCaptureWorkflowPreferences(
                    data.workflow ?? {},
                    defaultCaptureWorkflowPreferences,
                ),
            };
        } catch {
            const backup = `${dataPath}.recovery-${randomUUID()}`;
            renameSync(dataPath, backup);
            recoveryWarning = `라이브러리 목록을 읽지 못해 원본을 보존했습니다: ${backup}. 이미지 파일은 변경하지 않았습니다.`;
        }
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
        renameSync(temporary, dataPath);
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
            renameSync(temporary, captureSettingsPath);
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
            (item) => item.collectionId === library.activeCollectionId,
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
    const getItem = (id: unknown) => {
        const item = library.items.find((i) => i.id === id);
        if (!item || !existsSync(item.path))
            throw new Error("파일을 찾을 수 없습니다. 다시 가져와 주세요.");
        return item;
    };
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
    const writeClipboardImage = async (path: string) => {
        const image = nativeImage.createFromPath(path);
        if (image.isEmpty()) throw new Error("The image could not be read.");
        await clipboard.write([
            new ClipboardItem({
                "image/png": new Blob([image.toPNG()], { type: "image/png" }),
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
        let plan = planImageCombination(sizes, direction);
        for (const item of items) {
            const image = nativeImage.createFromPath(item.path);
            if (image.isEmpty())
                throw new Error(
                    "One of the selected images could not be read.",
                );
            const size = image.getSize();
            plan = planImageCombination([...sizes, size], direction);
            images.push(image);
            sizes.push(size);
        }
        const { width, height } = plan;
        const output = Buffer.alloc(width * height * 4);
        let offsetX = 0;
        let offsetY = 0;
        for (let index = 0; index < images.length; index++) {
            const source = images[index].toBitmap();
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
            if (direction === "horizontal") offsetX += size.width;
            else offsetY += size.height;
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
    function remember(
        path: string,
        createdAt = new Date().toISOString(),
        queueWorkflow = true,
        preview = false,
    ) {
        if (!existsSync(path)) return false;
        const image = nativeImage.createFromPath(path);
        if (image.isEmpty()) return false;
        const existing = library.items.find(
            (item) => pathKey(item.path) === pathKey(path),
        );
        if (existing) return true;
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
        };
        const createdTime = Date.parse(createdAt);
        const insertion = library.items.findIndex(
            (existingItem) => Date.parse(existingItem.createdAt) < createdTime,
        );
        const index = insertion < 0 ? library.items.length : insertion;
        library.items.splice(index, 0, item);
        try {
            persist();
        } catch (error) {
            library.items.splice(index, 1);
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
    ) {
        if (image.isEmpty()) throw new Error("비어 있는 이미지입니다.");
        mkdirSync(destinationFolder, { recursive: true });
        const path = join(
            destinationFolder,
            `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}.png`,
        );
        writeFileSync(path, image.toPNG(), { flag: "wx" });
        if (applyWorkflow)
            remember(path, undefined, true, library.workflow.autoPreview);
        else insertSavedItem(path, tags);
        return path;
    }
    function insertSavedItem(path: string, tags?: string[]) {
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
        });
        persist();
        notifyLibraryUpdated();
    }
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
    const ocrQueue: string[] = [];
    let ocrWorker: BrowserWindow | null = null;
    let ocrBusy = false;
    let ocrJobTimer: ReturnType<typeof setTimeout> | undefined;
    let ocrWorkerReady = false;
    const pumpOcrQueue = () => {
        if (ocrBusy) return;
        const id = ocrQueue.shift();
        if (id === undefined) return;
        const item = library.items.find((i) => i.id === id);
        if (!item || !existsSync(item.path)) {
            pumpOcrQueue();
            return;
        }
        ocrBusy = true;
        if (ocrJobTimer) clearTimeout(ocrJobTimer);
        ocrJobTimer = setTimeout(() => {
            ocrJobTimer = undefined;
            ocrBusy = false;
            ocrWorker?.destroy();
            ocrWorker = null;
            ocrWorkerReady = false;
            pumpOcrQueue();
        }, 120_000);
        ocrJobTimer.unref();
        const dispatch = () => {
            if (!ocrWorker || ocrWorker.isDestroyed()) return;
            ocrWorker.webContents.send("oc:ocr-job", {
                id: item.id,
                path: item.path,
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
                if (ocrJobTimer) clearTimeout(ocrJobTimer);
                ocrJobTimer = undefined;
                ocrBusy = false;
                ocrWorkerReady = false;
                ocrWorker = null;
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
        if (!item || ocrQueue.includes(id) || ocrQueue.length >= 200) return;
        ocrQueue.push(id);
        pumpOcrQueue();
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
        const job = payload as { id?: unknown; ok?: unknown; text?: unknown };
        const item = library.items.find((i) => i.id === job?.id);
        if (item && job.ok === true) {
            item.ocrDone = true;
            const text =
                typeof job.text === "string"
                    ? job.text.slice(0, OCR_TEXT_LIMIT)
                    : "";
            item.ocrText = text || undefined;
            persist();
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
    function importPaths(paths: unknown) {
        if (
            !Array.isArray(paths) ||
            paths.length > 20 ||
            paths.some((p) => typeof p !== "string")
        )
            throw new Error("이미지를 한 번에 20개까지 가져올 수 있습니다.");
        for (const path of paths) {
            if (
                !/\.(png|jpe?g|webp|bmp|gif)$/i.test(extname(path)) ||
                statSync(path).size > 50 * 1024 * 1024
            )
                throw new Error(
                    "50MB 이하 PNG/JPEG/WebP/BMP/GIF 파일을 선택해 주세요.",
                );
            const image = nativeImage.createFromPath(path);
            if (image.isEmpty()) throw new Error("읽을 수 없는 이미지입니다.");
            const size = image.getSize();
            if (size.width * size.height > 80_000_000)
                throw new Error("이미지 해상도가 너무 큽니다.");
            const label = basename(path, extname(path))
                .replace(/[^\p{L}\p{N}_-]/gu, "_")
                .slice(0, 60);
            if (extname(path).toLowerCase() === ".gif") {
                mkdirSync(active().path, { recursive: true });
                const target = uniqueExportPath(
                    active().path,
                    `${label || "capture"}.gif`,
                );
                copyFileSync(path, target);
                remember(target);
            } else saveImage(image, label);
        }
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
        dashboard.webContents.on("will-navigate", (event) =>
            event.preventDefault(),
        );
        dashboard.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        dashboard.once("ready-to-show", () =>
            inactive ? dashboard?.showInactive() : dashboard?.show(),
        );
        dashboard.on("closed", () => {
            dashboard = null;
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
    ipcMain.handle("oc:state", (event) => {
        assertSender(event, true);
        return state();
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
            assertSender(event, true);
            const item = getItem(id);
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
                            name: "이미지",
                            extensions: [
                                "png",
                                "jpg",
                                "jpeg",
                                "webp",
                                "bmp",
                                "gif",
                            ],
                        },
                    ],
                });
                if (!picked.canceled) importPaths(picked.filePaths);
            } else if (name === "open-item") hooks.edit(getItem(payload).path);
            else if (name === "pin-item")
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
                persist();
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
                persist();
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
                persist();
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
                persist();
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
        saveImage,
        state,
        importPaths,
        activeFolder: () => active().path,
    };
}
