import {
    BOARD_LIMITS,
    type BoardCaptureEvent,
    type BoardDerivation,
    type BoardDocument,
    type BoardNode,
    type BoardSummary,
    type CaptureBoardApi,
} from "../lib/captureBoard";
import type { NamedBeautifyStyle } from "../lib/openCaptureTypes";
import { lt } from "./i18n";
import {
    beautifyImage,
    dataURLBlob,
    dataURLBytes,
    downloadBlob,
    downloadDataURL,
    imagePdf,
    normalizeImage,
    pickTextFile,
    resizeImage,
} from "./imageOps";

export type BrowserItem = {
    id: string;
    name: string;
    dataURL: string;
    width: number;
    height: number;
    createdAt: string;
    note?: string;
    tags?: string[];
};

export type BrowserAssetSnapshot = {
    id: string;
    boardId: string;
    dataURL: string;
    width: number;
    height: number;
};

export interface BrowserBoardApi extends CaptureBoardApi {
    dispose(): Promise<void>;
    importImage(dataURL: string, name: string): Promise<BrowserItem>;
    deriveItem(
        id: string,
        dataURL: string,
        label: string,
    ): Promise<BrowserItem>;
    listItems(): Promise<BrowserItem[]>;
    readItem(id: string): Promise<BrowserItem | null>;
    deleteItem(id: string): Promise<void>;
    snapshotAsset(id: string): Promise<BrowserAssetSnapshot | null>;
}

type BrowserAssetRecord = BrowserAssetSnapshot & {
    bytes: number;
    state: "owned" | "derived";
};
type PendingRecord = BoardCaptureEvent & { key: string };
type PortableAsset = BrowserAssetSnapshot;
export type BrowserPortableBoard = {
    version: 1;
    document: BoardDocument;
    assets: PortableAsset[];
};

const DB_VERSION = 1;
const DEFAULT_DB = "opencapture-board-lab";
const ids = /^[a-zA-Z0-9_-]{1,100}$/;
const nodeKinds = new Set([
    "image",
    "rect",
    "ellipse",
    "line",
    "arrow",
    "polygon",
    "text",
    "note",
    "callout",
    "step",
    "magnify",
]);
const finite = (value: unknown, min: number, max: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
const safeId: (value: unknown, label: string) => asserts value is string = (
    value,
    label,
) => {
    if (typeof value !== "string" || !ids.test(value))
        throw new Error(`Invalid ${label}.`);
};
const clone = <T>(value: T): T => structuredClone(value);
const byteLength = (value: string) =>
    new TextEncoder().encode(value).byteLength;
const request = <T>(value: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        value.onsuccess = () => resolve(value.result);
        value.onerror = () =>
            reject(value.error ?? new Error("IndexedDB request failed."));
    });
const complete = (transaction: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
            reject(
                transaction.error ??
                    new Error("IndexedDB transaction aborted."),
            );
        transaction.onerror = () =>
            reject(
                transaction.error ?? new Error("IndexedDB transaction failed."),
            );
    });

export function validateBrowserBoard(value: unknown): BoardDocument {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Board document must be an object.");
    const document = value as BoardDocument;
    safeId(document.id, "board id");
    if (
        document.version !== 1 ||
        !Number.isSafeInteger(document.revision) ||
        document.revision < 0 ||
        typeof document.name !== "string" ||
        document.name.trim().length === 0 ||
        document.name.length > 80 ||
        Number.isNaN(Date.parse(document.updatedAt)) ||
        !finite(document.viewport?.x, -100_000, 100_000) ||
        !finite(document.viewport?.y, -100_000, 100_000) ||
        !finite(document.viewport?.zoom, 0.05, 32) ||
        typeof document.settings?.autoAdd !== "boolean" ||
        !Array.isArray(document.settings?.focusIds) ||
        document.settings.focusIds.length > BOARD_LIMITS.nodes ||
        !["design", "bug", "study"].includes(document.settings?.preset) ||
        !Array.isArray(document.nodes) ||
        document.nodes.length > BOARD_LIMITS.nodes ||
        !Array.isArray(document.styles) ||
        document.styles.length > 30
    )
        throw new Error("Invalid board document.");
    const seen = new Set<string>();
    const byId = new Map<string, BoardNode>();
    let images = 0;
    for (const node of document.nodes) {
        safeId(node.id, "node id");
        if (seen.has(node.id))
            throw new Error("Board node ids must be unique.");
        seen.add(node.id);
        byId.set(node.id, node);
        if (
            !nodeKinds.has(node.kind) ||
            !finite(node.x, -100_000, 100_000) ||
            !finite(node.y, -100_000, 100_000) ||
            !finite(node.width, 0.01, 10_000) ||
            !finite(node.height, 0.01, 10_000) ||
            !finite(node.rotation, -360_000, 360_000) ||
            typeof node.visible !== "boolean" ||
            typeof node.locked !== "boolean" ||
            typeof node.style?.fill !== "string" ||
            node.style.fill.length > 100 ||
            typeof node.style?.stroke !== "string" ||
            node.style.stroke.length > 100 ||
            !finite(node.style?.strokeWidth, 0, 100) ||
            !finite(node.style?.fontSize, 1, 500) ||
            (node.text !== undefined &&
                (typeof node.text !== "string" ||
                    node.text.length > BOARD_LIMITS.text)) ||
            (node.points !== undefined &&
                (!Array.isArray(node.points) ||
                    node.points.length > BOARD_LIMITS.vertices ||
                    node.points.some(
                        (point) =>
                            !finite(point?.x, -10_000, 10_000) ||
                            !finite(point?.y, -10_000, 10_000),
                    )))
        )
            throw new Error(`Invalid board node ${node.id}.`);
        if (
            (node.name !== undefined &&
                (typeof node.name !== "string" || node.name.length > 100)) ||
            (node.versionGroup !== undefined &&
                (typeof node.versionGroup !== "string" ||
                    node.versionGroup.length > 500)) ||
            (node.captureItemId !== undefined && !ids.test(node.captureItemId))
        )
            throw new Error(`Invalid board node metadata ${node.id}.`);
        if (node.kind === "image") {
            images += 1;
            safeId(node.assetId, "image asset id");
        }
        if (node.assetId) safeId(node.assetId, "asset id");
        if (node.originalAssetId)
            safeId(node.originalAssetId, "original asset id");
        if (node.groupId) safeId(node.groupId, "group id");
        if (node.source) {
            safeId(node.source.itemId, "source item id");
            const context = node.source.context;
            const region = node.source.region;
            if (
                !context ||
                !["capture", "import", "clipboard"].includes(context.kind) ||
                typeof context.capturedAt !== "string" ||
                Number.isNaN(Date.parse(context.capturedAt)) ||
                (context.appName !== undefined &&
                    (typeof context.appName !== "string" ||
                        context.appName.length > 300)) ||
                (context.windowTitle !== undefined &&
                    (typeof context.windowTitle !== "string" ||
                        context.windowTitle.length > 500)) ||
                (context.displayId !== undefined &&
                    (typeof context.displayId !== "string" ||
                        context.displayId.length > 100)) ||
                typeof node.source.areaKey !== "string" ||
                node.source.areaKey.length > 500 ||
                (region !== undefined &&
                    (!finite(region.x, -100_000, 100_000) ||
                        !finite(region.y, -100_000, 100_000) ||
                        !finite(region.width, 0.01, 10_000) ||
                        !finite(region.height, 0.01, 10_000)))
            )
                throw new Error("Invalid board image source metadata.");
        }
    }
    if (images > BOARD_LIMITS.images)
        throw new Error(
            `Boards support at most ${BOARD_LIMITS.images} images.`,
        );
    for (const node of document.nodes) {
        const relations = [
            node.anchor?.nodeId,
            node.endAnchor?.nodeId,
            node.magnify?.nodeId,
        ].filter(Boolean) as string[];
        if (relations.some((id) => !seen.has(id)))
            throw new Error("Board relation points to a missing node.");
        for (const anchor of [node.anchor, node.endAnchor])
            if (
                anchor &&
                (byId.get(anchor.nodeId)?.kind !== "image" ||
                    !finite(anchor.x, 0, 1) ||
                    !finite(anchor.y, 0, 1))
            )
                throw new Error("Board anchor must target an image.");
        if (
            node.magnify &&
            (byId.get(node.magnify.nodeId)?.kind !== "image" ||
                !finite(node.magnify.x, 0, 1) ||
                !finite(node.magnify.y, 0, 1) ||
                !finite(node.magnify.width, 0.001, 1) ||
                !finite(node.magnify.height, 0.001, 1) ||
                !finite(node.magnify.zoom, 1, 32))
        )
            throw new Error("Board magnifier must target an image.");
    }
    if (document.settings.focusIds.some((id) => !seen.has(id)))
        throw new Error("Board focus points to a missing node.");
    const styleIds = new Set<string>();
    for (const style of document.styles) {
        safeId(style.id, "style id");
        if (
            styleIds.has(style.id) ||
            typeof style.name !== "string" ||
            style.name.length === 0 ||
            style.name.length > 80 ||
            typeof style.style?.fill !== "string" ||
            style.style.fill.length > 100 ||
            typeof style.style?.stroke !== "string" ||
            style.style.stroke.length > 100 ||
            !finite(style.style?.strokeWidth, 0, 100) ||
            !finite(style.style?.fontSize, 1, 500)
        )
            throw new Error("Invalid board style.");
        styleIds.add(style.id);
    }
    if (byteLength(JSON.stringify(document)) > BOARD_LIMITS.metadataBytes)
        throw new Error("Board metadata exceeds 2 MiB.");
    return clone(document);
}

export function parseBrowserPortable(text: string): BrowserPortableBoard {
    if (byteLength(text) > BOARD_LIMITS.portableBytes)
        throw new Error("Portable board exceeds 96 MiB.");
    const parsed = JSON.parse(text) as BrowserPortableBoard;
    if (parsed?.version !== 1 || !Array.isArray(parsed.assets))
        throw new Error("Invalid portable board.");
    const document = validateBrowserBoard(parsed.document);
    if (parsed.assets.length > BOARD_LIMITS.images * 2)
        throw new Error("Portable board has too many assets.");
    const assetIds = new Set<string>();
    const assets = parsed.assets.map((asset) => {
        safeId(asset.id, "portable asset id");
        if (assetIds.has(asset.id))
            throw new Error("Portable asset ids must be unique.");
        assetIds.add(asset.id);
        const decoded = dataURLBytes(asset.dataURL);
        const signature = [...decoded.bytes.subarray(0, 8)]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
        if (
            decoded.type !== "image/png" ||
            signature !== "89504e470d0a1a0a" ||
            decoded.bytes.byteLength > BOARD_LIMITS.assetBytes ||
            !finite(asset.width, 1, 32_000) ||
            !finite(asset.height, 1, 32_000) ||
            asset.width * asset.height > BOARD_LIMITS.assetPixels
        )
            throw new Error("Invalid portable image asset.");
        return { ...asset, dataURL: asset.dataURL };
    });
    const referenced = new Set(
        document.nodes
            .flatMap((node) => [node.assetId, node.originalAssetId])
            .filter(Boolean),
    );
    if ([...referenced].some((id) => !assetIds.has(id as string)))
        throw new Error("Portable board is missing an image asset.");
    return { version: 1, document, assets };
}

const emptyDocument = (name: string): BoardDocument => ({
    version: 1,
    id: crypto.randomUUID(),
    revision: 0,
    name: name.trim().slice(0, 80) || lt("새 보드"),
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { autoAdd: true, focusIds: [], preset: "design" },
    nodes: [],
    styles: [],
});

const assetIdsFor = (document: BoardDocument) =>
    [
        ...new Set(
            document.nodes
                .flatMap((node) => [node.assetId, node.originalAssetId])
                .filter(Boolean),
        ),
    ] as string[];

const portableName = (value: string) =>
    value
        .split("")
        .map((character) =>
            character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character)
                ? "-"
                : character,
        )
        .join("")
        .trim()
        .slice(0, 80) || "board";

export function createBrowserBoardApi(
    options: { databaseName?: string; processEndpoint?: string } = {},
): BrowserBoardApi {
    const databaseName = options.databaseName ?? DEFAULT_DB;
    const processEndpoint = options.processEndpoint ?? "/api/process";
    const listeners = new Set<(event: BoardCaptureEvent) => void>();
    const channel =
        typeof BroadcastChannel === "undefined"
            ? null
            : new BroadcastChannel(`${databaseName}:capture`);
    channel?.addEventListener("message", (message) => {
        const event = message.data as BoardCaptureEvent;
        if (event?.itemId && event?.targetBoardId)
            for (const listener of listeners) listener(clone(event));
    });

    const database = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open(databaseName, DB_VERSION);
        opening.onupgradeneeded = () => {
            const db = opening.result;
            if (!db.objectStoreNames.contains("meta"))
                db.createObjectStore("meta", { keyPath: "key" });
            if (!db.objectStoreNames.contains("boards"))
                db.createObjectStore("boards", { keyPath: "id" });
            if (!db.objectStoreNames.contains("assets")) {
                const assets = db.createObjectStore("assets", {
                    keyPath: "id",
                });
                assets.createIndex("boardId", "boardId", { unique: false });
            }
            if (!db.objectStoreNames.contains("items"))
                db.createObjectStore("items", { keyPath: "id" });
            if (!db.objectStoreNames.contains("pending")) {
                const pending = db.createObjectStore("pending", {
                    keyPath: "key",
                });
                pending.createIndex("targetBoardId", "targetBoardId", {
                    unique: false,
                });
            }
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () =>
            reject(
                opening.error ?? new Error("IndexedDB could not be opened."),
            );
        opening.onblocked = () =>
            reject(new Error("IndexedDB upgrade is blocked by another tab."));
    });

    const stores = async (names: string[], mode: IDBTransactionMode) => {
        const db = await database;
        return db.transaction(names, mode);
    };
    const activeId = async () => {
        const transaction = await stores(["meta"], "readonly");
        const row = await request<
            { key: string; value: string | null } | undefined
        >(transaction.objectStore("meta").get("activeBoardId"));
        await complete(transaction);
        return row?.value ?? null;
    };
    const loadBoard = async (id: string) => {
        safeId(id, "board id");
        const transaction = await stores(["boards"], "readonly");
        const value = await request<BoardDocument | undefined>(
            transaction.objectStore("boards").get(id),
        );
        await complete(transaction);
        if (!value) throw new Error("Board was not found.");
        return validateBrowserBoard(value);
    };
    const getAsset = async (id: string) => {
        safeId(id, "asset id");
        const transaction = await stores(["assets"], "readonly");
        const value = await request<BrowserAssetRecord | undefined>(
            transaction.objectStore("assets").get(id),
        );
        await complete(transaction);
        return value ?? null;
    };
    const quota = async (assetStore: IDBObjectStore, incoming: number) => {
        const all = await request<BrowserAssetRecord[]>(assetStore.getAll());
        const total = all.reduce((sum, asset) => sum + asset.bytes, 0);
        if (total + incoming > BOARD_LIMITS.storageBytes)
            throw new Error("Board image storage exceeds 512 MiB.");
    };
    const putItem = async (
        dataURL: string,
        name: string,
        queueCapture: boolean,
        metadata?: Pick<BrowserItem, "note" | "tags">,
    ) => {
        const image = await normalizeImage(dataURL);
        const item: BrowserItem = {
            id: crypto.randomUUID(),
            name: name.trim().slice(0, 120) || "image.png",
            dataURL: image.dataURL,
            width: image.width,
            height: image.height,
            createdAt: new Date().toISOString(),
            ...(metadata?.note ? { note: metadata.note.slice(0, 2000) } : {}),
            ...(metadata?.tags?.length
                ? {
                      tags: metadata.tags
                          .slice(0, 20)
                          .map((tag) => tag.slice(0, 50)),
                  }
                : {}),
        };
        const target = queueCapture ? await activeId() : null;
        const transaction = await stores(
            ["items", "boards", "pending"],
            "readwrite",
        );
        transaction.objectStore("items").put(item);
        let event: BoardCaptureEvent | null = null;
        if (target) {
            const board = await request<BoardDocument | undefined>(
                transaction.objectStore("boards").get(target),
            );
            if (board?.settings.autoAdd) {
                event = { itemId: item.id, targetBoardId: board.id };
                transaction.objectStore("pending").put({
                    ...event,
                    key: `${board.id}:${item.id}`,
                } satisfies PendingRecord);
            }
        }
        await complete(transaction);
        if (event) {
            for (const listener of listeners) listener(clone(event));
            channel?.postMessage(event);
        }
        return item;
    };

    const api: BrowserBoardApi = {
        async dispose() {
            listeners.clear();
            channel?.close();
            (await database).close();
        },
        async status() {
            try {
                await database;
                return { readOnly: false };
            } catch (error) {
                return {
                    readOnly: true,
                    error:
                        error instanceof Error
                            ? error.message
                            : "IndexedDB is unavailable.",
                };
            }
        },
        async list() {
            const transaction = await stores(["boards", "meta"], "readonly");
            const [documents, meta] = await Promise.all([
                request<BoardDocument[]>(
                    transaction.objectStore("boards").getAll(),
                ),
                request<{ key: string; value: string | null } | undefined>(
                    transaction.objectStore("meta").get("activeBoardId"),
                ),
            ]);
            await complete(transaction);
            return documents
                .map(
                    (document): BoardSummary => ({
                        id: document.id,
                        name: document.name,
                        revision: document.revision,
                        updatedAt: document.updatedAt,
                        nodeCount: document.nodes.length,
                        imageCount: document.nodes.filter(
                            (node) => node.kind === "image",
                        ).length,
                        active: meta?.value === document.id,
                    }),
                )
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
        async create(name = lt("새 보드")) {
            const document = emptyDocument(name);
            const transaction = await stores(["boards", "meta"], "readwrite");
            const count = await request<number>(
                transaction.objectStore("boards").count(),
            );
            if (count >= BOARD_LIMITS.boards) {
                transaction.abort();
                throw new Error(
                    `At most ${BOARD_LIMITS.boards} boards are allowed.`,
                );
            }
            transaction.objectStore("boards").add(document);
            const active = await request<
                { key: string; value: string | null } | undefined
            >(transaction.objectStore("meta").get("activeBoardId"));
            if (!active?.value)
                transaction
                    .objectStore("meta")
                    .put({ key: "activeBoardId", value: document.id });
            await complete(transaction);
            return clone(document);
        },
        load: loadBoard,
        async save(value, expectedRevision) {
            const document = validateBrowserBoard(value);
            const transaction = await stores(["boards", "assets"], "readwrite");
            const current = await request<BoardDocument | undefined>(
                transaction.objectStore("boards").get(document.id),
            );
            if (
                !current ||
                current.revision !== expectedRevision ||
                document.revision !== expectedRevision
            ) {
                transaction.abort();
                throw new Error(
                    `Board revision conflict: expected ${current?.revision ?? "missing"}.`,
                );
            }
            const assetRequests = assetIdsFor(document).map((id) =>
                request<BrowserAssetRecord | undefined>(
                    transaction.objectStore("assets").get(id),
                ),
            );
            const assets = await Promise.all(assetRequests);
            if (
                assets.some((asset) => !asset || asset.boardId !== document.id)
            ) {
                transaction.abort();
                throw new Error("Board references an unowned image asset.");
            }
            const saved = validateBrowserBoard({
                ...document,
                revision: expectedRevision + 1,
                updatedAt: new Date().toISOString(),
            });
            transaction.objectStore("boards").put(saved);
            await complete(transaction);
            return saved;
        },
        async setActive(id) {
            if (id) await loadBoard(id);
            const transaction = await stores(["meta"], "readwrite");
            transaction
                .objectStore("meta")
                .put({ key: "activeBoardId", value: id });
            await complete(transaction);
        },
        async addItems(boardId, itemIds, expectedRevision) {
            if (!itemIds.length || itemIds.length > BOARD_LIMITS.images)
                throw new Error("Select one or more valid images.");
            const transaction = await stores(
                ["boards", "items", "assets"],
                "readwrite",
            );
            const document = await request<BoardDocument | undefined>(
                transaction.objectStore("boards").get(boardId),
            );
            if (!document || document.revision !== expectedRevision) {
                transaction.abort();
                throw new Error(
                    `Board revision conflict: expected ${document?.revision ?? "missing"}.`,
                );
            }
            const existing = new Set(
                document.nodes
                    .map((node) => node.captureItemId)
                    .filter(Boolean),
            );
            const unique = [...new Set(itemIds)].filter(
                (id) => !existing.has(id),
            );
            const items = await Promise.all(
                unique.map((id) =>
                    request<BrowserItem | undefined>(
                        transaction.objectStore("items").get(id),
                    ),
                ),
            );
            if (items.some((item) => !item)) {
                transaction.abort();
                throw new Error("An imported image was not found.");
            }
            const currentImages = document.nodes.filter(
                (node) => node.kind === "image",
            ).length;
            if (currentImages + unique.length > BOARD_LIMITS.images) {
                transaction.abort();
                throw new Error(
                    `Boards support at most ${BOARD_LIMITS.images} images.`,
                );
            }
            if (document.nodes.length + unique.length > BOARD_LIMITS.nodes) {
                transaction.abort();
                throw new Error(
                    `Boards support at most ${BOARD_LIMITS.nodes} nodes.`,
                );
            }
            const nodes: BoardNode[] = [];
            const assetRecords: BrowserAssetRecord[] = [];
            for (const [index, item] of (items as BrowserItem[]).entries()) {
                const assetId = crypto.randomUUID();
                const bytes = dataURLBytes(item.dataURL).bytes.byteLength;
                assetRecords.push({
                    id: assetId,
                    boardId,
                    dataURL: item.dataURL,
                    width: item.width,
                    height: item.height,
                    bytes,
                    state: "owned",
                });
                const scale = Math.min(
                    1,
                    720 / Math.max(1, item.width),
                    720 / Math.max(1, item.height),
                );
                nodes.push({
                    id: crypto.randomUUID(),
                    kind: "image",
                    x: 32 + ((document.nodes.length + index) % 5) * 36,
                    y: 32 + ((document.nodes.length + index) % 5) * 32,
                    width: Math.max(1, item.width * scale),
                    height: Math.max(1, item.height * scale),
                    rotation: 0,
                    visible: true,
                    locked: false,
                    style: {
                        fill: "transparent",
                        stroke: "#ffffff",
                        strokeWidth: 2,
                        fontSize: 14,
                    },
                    assetId,
                    originalAssetId: assetId,
                    captureItemId: item.id,
                    source: {
                        itemId: item.id,
                        context: { kind: "import", capturedAt: item.createdAt },
                        areaKey: `import:${item.id}`,
                    },
                    versionGroup: `import:${item.id}`,
                });
            }
            const saved = validateBrowserBoard({
                ...document,
                revision: expectedRevision + 1,
                updatedAt: new Date().toISOString(),
                nodes: [...document.nodes, ...nodes],
            });
            await quota(
                transaction.objectStore("assets"),
                assetRecords.reduce((sum, asset) => sum + asset.bytes, 0),
            );
            for (const asset of assetRecords)
                transaction.objectStore("assets").add(asset);
            transaction.objectStore("boards").put(saved);
            await complete(transaction);
            return saved;
        },
        async assetData(boardId, assetId, quality = "preview") {
            const asset = await getAsset(assetId);
            if (!asset || asset.boardId !== boardId)
                throw new Error("Board image was not found.");
            return quality === "preview"
                ? resizeImage(asset.dataURL)
                : asset.dataURL;
        },
        async cutout(boardId, nodeId, sourceAssetId) {
            const document = await loadBoard(boardId);
            const node = document.nodes.find(
                (candidate) => candidate.id === nodeId,
            );
            if (
                !node ||
                node.kind !== "image" ||
                node.assetId !== sourceAssetId
            )
                throw new Error(
                    "Cutout source no longer matches the board image.",
                );
            const source = await getAsset(sourceAssetId);
            if (!source || source.boardId !== boardId)
                throw new Error("Cutout source was not found.");
            const response = await fetch(processEndpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    operation: "cutout",
                    dataURL: source.dataURL,
                }),
            });
            if (!response.ok)
                throw new Error(`Cutout service failed (${response.status}).`);
            const payload = (await response.json()) as { dataURL?: unknown };
            if (typeof payload.dataURL !== "string")
                throw new Error("Cutout service returned no image.");
            const image = await normalizeImage(payload.dataURL);
            const assetId = crypto.randomUUID();
            const transaction = await stores(["boards", "assets"], "readwrite");
            const existing = await request<BoardDocument | undefined>(
                transaction.objectStore("boards").get(boardId),
            );
            if (!existing) {
                transaction.abort();
                throw new Error("Board was not found.");
            }
            await quota(transaction.objectStore("assets"), image.bytes);
            transaction.objectStore("assets").add({
                id: assetId,
                boardId,
                ...image,
                state: "derived",
            } satisfies BrowserAssetRecord);
            await complete(transaction);
            return {
                boardId,
                nodes: [
                    {
                        nodeId,
                        sourceAssetId,
                        assetId,
                        width: image.width,
                        height: image.height,
                    },
                ],
            } satisfies BoardDerivation;
        },
        async beautify(boardId, images, style) {
            if (!images.length || images.length > BOARD_LIMITS.images)
                throw new Error("Select one or more board images.");
            const document = await loadBoard(boardId);
            const derived: Array<{
                nodeId: string;
                sourceAssetId: string;
                image: Awaited<ReturnType<typeof beautifyImage>>;
            }> = [];
            for (const input of images) {
                const node = document.nodes.find(
                    (candidate) => candidate.id === input.nodeId,
                );
                if (!node || node.assetId !== input.sourceAssetId)
                    throw new Error(
                        "Beautify source no longer matches the board image.",
                    );
                const source = await getAsset(input.sourceAssetId);
                if (!source || source.boardId !== boardId)
                    throw new Error("Board image was not found.");
                derived.push({
                    ...input,
                    image: await beautifyImage(source.dataURL, style),
                });
            }
            const transaction = await stores(["boards", "assets"], "readwrite");
            if (
                !(await request(transaction.objectStore("boards").get(boardId)))
            ) {
                transaction.abort();
                throw new Error("Board was not found.");
            }
            await quota(
                transaction.objectStore("assets"),
                derived.reduce((sum, value) => sum + value.image.bytes, 0),
            );
            const result: BoardDerivation = { boardId, nodes: [] };
            for (const value of derived) {
                const assetId = crypto.randomUUID();
                transaction.objectStore("assets").add({
                    id: assetId,
                    boardId,
                    ...value.image,
                    state: "derived",
                } satisfies BrowserAssetRecord);
                result.nodes.push({
                    nodeId: value.nodeId,
                    sourceAssetId: value.sourceAssetId,
                    assetId,
                    width: value.image.width,
                    height: value.image.height,
                });
            }
            await complete(transaction);
            return result;
        },
        async discardDerived(boardId, assetIds) {
            const transaction = await stores(["boards", "assets"], "readwrite");
            const document = await request<BoardDocument | undefined>(
                transaction.objectStore("boards").get(boardId),
            );
            if (!document) {
                transaction.abort();
                throw new Error("Board was not found.");
            }
            const referenced = new Set(assetIdsFor(document));
            for (const id of [...new Set(assetIds)].slice(
                0,
                BOARD_LIMITS.images,
            )) {
                const asset = await request<BrowserAssetRecord | undefined>(
                    transaction.objectStore("assets").get(id),
                );
                if (
                    asset?.boardId === boardId &&
                    asset.state === "derived" &&
                    !referenced.has(id)
                )
                    transaction.objectStore("assets").delete(id);
            }
            await complete(transaction);
        },
        async exportFile(boardId, format, dataURL) {
            const document = await loadBoard(boardId);
            const name = `${portableName(document.name)}.${format}`;
            if (format === "pdf") downloadBlob(await imagePdf(dataURL), name);
            else {
                const image = await normalizeImage(dataURL);
                if (image.width * image.height > BOARD_LIMITS.exportPixels)
                    throw new Error("PNG export exceeds 16 megapixels.");
                downloadDataURL(image.dataURL, name);
            }
            return { saved: true, path: name };
        },
        async exportPortable(boardId) {
            const document = await loadBoard(boardId);
            const assets = await Promise.all(
                assetIdsFor(document).map(async (id) => {
                    const asset = await getAsset(id);
                    if (!asset || asset.boardId !== boardId)
                        throw new Error("Board image was not found.");
                    return {
                        id: asset.id,
                        boardId,
                        dataURL: asset.dataURL,
                        width: asset.width,
                        height: asset.height,
                    } satisfies PortableAsset;
                }),
            );
            const text = JSON.stringify({ version: 1, document, assets });
            if (byteLength(text) > BOARD_LIMITS.portableBytes)
                throw new Error("Portable board exceeds 96 MiB.");
            const name = `${portableName(document.name)}.ocboard`;
            downloadBlob(new Blob([text], { type: "application/json" }), name);
            return { saved: true, path: name };
        },
        async importPortable() {
            const text = await pickTextFile();
            if (text === null) return null;
            const portable = parseBrowserPortable(text);
            const normalized = [] as Array<{
                originalId: string;
                image: Awaited<ReturnType<typeof normalizeImage>>;
            }>;
            for (const asset of portable.assets)
                normalized.push({
                    originalId: asset.id,
                    image: await normalizeImage(asset.dataURL),
                });
            const board = emptyDocument(
                lt(
                    `${portable.document.name} 복사본`,
                    `${portable.document.name} copy`,
                ),
            );
            board.viewport = clone(portable.document.viewport);
            board.settings = clone(portable.document.settings);
            board.styles = clone(portable.document.styles);
            const remap = new Map<string, string>();
            for (const asset of normalized)
                remap.set(asset.originalId, crypto.randomUUID());
            board.nodes = portable.document.nodes.map((node) => ({
                ...clone(node),
                assetId: node.assetId ? remap.get(node.assetId) : undefined,
                originalAssetId: node.originalAssetId
                    ? remap.get(node.originalAssetId)
                    : undefined,
            }));
            validateBrowserBoard(board);
            const transaction = await stores(
                ["boards", "assets", "meta"],
                "readwrite",
            );
            const count = await request<number>(
                transaction.objectStore("boards").count(),
            );
            if (count >= BOARD_LIMITS.boards) {
                transaction.abort();
                throw new Error(
                    `At most ${BOARD_LIMITS.boards} boards are allowed.`,
                );
            }
            await quota(
                transaction.objectStore("assets"),
                normalized.reduce((sum, asset) => sum + asset.image.bytes, 0),
            );
            for (const asset of normalized) {
                const id = remap.get(asset.originalId) as string;
                transaction.objectStore("assets").add({
                    id,
                    boardId: board.id,
                    ...asset.image,
                    state: "owned",
                } satisfies BrowserAssetRecord);
            }
            transaction.objectStore("boards").add(board);
            transaction
                .objectStore("meta")
                .put({ key: "activeBoardId", value: board.id });
            await complete(transaction);
            return board;
        },
        async pendingCaptures() {
            const transaction = await stores(["pending"], "readonly");
            const pending = await request<PendingRecord[]>(
                transaction.objectStore("pending").getAll(),
            );
            await complete(transaction);
            return pending.map(({ itemId, targetBoardId, region }) => ({
                itemId,
                targetBoardId,
                ...(region ? { region } : {}),
            }));
        },
        async ackCapture(itemId, targetBoardId) {
            const transaction = await stores(["pending"], "readwrite");
            transaction
                .objectStore("pending")
                .delete(`${targetBoardId}:${itemId}`);
            await complete(transaction);
        },
        onCaptureAdded(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
        importImage: (dataURL, name) => putItem(dataURL, name, true),
        async deriveItem(id, dataURL, label) {
            const source = await api.readItem(id);
            if (!source) throw new Error("Source image was not found.");
            return putItem(dataURL, `${label}-${source.name}`, false, {
                note: source.note,
                tags: source.tags,
            });
        },
        async listItems() {
            const transaction = await stores(["items"], "readonly");
            const items = await request<BrowserItem[]>(
                transaction.objectStore("items").getAll(),
            );
            await complete(transaction);
            return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
        async readItem(id) {
            safeId(id, "item id");
            const transaction = await stores(["items"], "readonly");
            const item = await request<BrowserItem | undefined>(
                transaction.objectStore("items").get(id),
            );
            await complete(transaction);
            return item ?? null;
        },
        async deleteItem(id) {
            safeId(id, "item id");
            const transaction = await stores(["items", "pending"], "readwrite");
            transaction.objectStore("items").delete(id);
            const pending = await request<PendingRecord[]>(
                transaction.objectStore("pending").getAll(),
            );
            for (const entry of pending)
                if (entry.itemId === id)
                    transaction.objectStore("pending").delete(entry.key);
            await complete(transaction);
        },
        async snapshotAsset(id) {
            const asset = await getAsset(id);
            if (!asset) return null;
            return {
                id: asset.id,
                boardId: asset.boardId,
                dataURL: asset.dataURL,
                width: asset.width,
                height: asset.height,
            };
        },
    };
    return api;
}
