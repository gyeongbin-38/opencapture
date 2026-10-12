import { randomUUID } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
    BoardCaptureEvent,
    BoardDerivation,
    BoardDocument,
    BoardNode,
    BoardSummary,
} from "../../lib/captureBoard";
import { BOARD_LIMITS } from "../../lib/captureBoard";
import type {
    CaptureRect,
    CaptureSourceContext,
    NamedBeautifyStyle,
    OpenCaptureItem,
} from "../../lib/openCaptureTypes";
import { replaceFileSync } from "./atomicReplace";

type AssetRecord = {
    id: string;
    boardId: string;
    width: number;
    height: number;
    bytes: number;
    state: "owned" | "prepared" | "pending";
};

type BoardIndex = {
    version: 1;
    activeBoardId: string | null;
    assets: AssetRecord[];
};

type PendingCapture = BoardCaptureEvent & {
    version: 1;
    assetId: string;
    source: CaptureSourceContext;
    areaKey: string;
    capturedAt: string;
};

export type BoardItemSnapshot = {
    item: OpenCaptureItem;
    png: Buffer;
    width: number;
    height: number;
    region?: CaptureRect;
};

export type BoardDerivedImage = {
    png: Buffer;
    width: number;
    height: number;
};

export type CaptureBoardStoreOptions = {
    root: string;
    resolveItem(id: string): BoardItemSnapshot;
    inspect?(png: Buffer): BoardDerivedImage;
    prepareCutout(png: Buffer): Promise<BoardDerivedImage>;
    prepareBeautify(
        png: Buffer,
        style: NamedBeautifyStyle,
    ): Promise<BoardDerivedImage>;
    preview?(png: Buffer, maxEdge: number): BoardDerivedImage;
    onCaptureAdded?(event: BoardCaptureEvent): void;
};

const DEFAULT_STYLE = {
    fill: "#00000000",
    stroke: "#ffffff",
    strokeWidth: 2,
    fontSize: 18,
};
const safeId = (value: unknown, label = "id") => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
        throw new Error(`Invalid ${label}.`);
    return value;
};
const finite = (value: unknown, min: number, max: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
const areaKey = (
    source: CaptureSourceContext,
    region: CaptureRect | undefined,
    itemId: string,
) =>
    source.kind === "capture"
        ? [
              source.kind,
              source.displayId ?? "",
              source.appName ?? "",
              region
                  ? [region.x, region.y, region.width, region.height]
                        .map((value) => Math.round(value))
                        .join(":")
                  : "full",
          ].join("|")
        : `${source.kind}:${itemId}`;

export function validateBoardDocument(value: unknown): BoardDocument {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Board document must be an object.");
    const document = value as BoardDocument;
    if (
        document.version !== 1 ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(document.id) ||
        !Number.isSafeInteger(document.revision) ||
        document.revision < 0 ||
        typeof document.name !== "string" ||
        document.name.trim().length === 0 ||
        document.name.length > 80 ||
        typeof document.updatedAt !== "string" ||
        Number.isNaN(Date.parse(document.updatedAt)) ||
        !document.viewport ||
        !finite(document.viewport.x, -100_000, 100_000) ||
        !finite(document.viewport.y, -100_000, 100_000) ||
        !finite(document.viewport.zoom, 0.05, 32) ||
        !document.settings ||
        typeof document.settings.autoAdd !== "boolean" ||
        !Array.isArray(document.settings.focusIds) ||
        document.settings.focusIds.length > BOARD_LIMITS.nodes ||
        !["design", "bug", "study"].includes(document.settings.preset) ||
        !Array.isArray(document.nodes) ||
        document.nodes.length > BOARD_LIMITS.nodes ||
        !Array.isArray(document.styles) ||
        document.styles.length > 30
    )
        throw new Error("Invalid board document.");
    const ids = new Set<string>();
    const nodesById = new Map<string, BoardNode>();
    let imageCount = 0;
    for (const node of document.nodes) {
        safeId(node.id, "node id");
        if (ids.has(node.id)) throw new Error("Board node ids must be unique.");
        ids.add(node.id);
        nodesById.set(node.id, node);
        if (
            ![
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
            ].includes(node.kind) ||
            !finite(node.x, -100_000, 100_000) ||
            !finite(node.y, -100_000, 100_000) ||
            !finite(node.width, 0.01, 10_000) ||
            !finite(node.height, 0.01, 10_000) ||
            !finite(node.rotation, -360_000, 360_000) ||
            typeof node.visible !== "boolean" ||
            typeof node.locked !== "boolean" ||
            !node.style ||
            typeof node.style.fill !== "string" ||
            node.style.fill.length > 100 ||
            typeof node.style.stroke !== "string" ||
            node.style.stroke.length > 100 ||
            !finite(node.style.strokeWidth, 0, 100) ||
            !finite(node.style.fontSize, 1, 500) ||
            (node.text !== undefined &&
                (typeof node.text !== "string" ||
                    node.text.length > BOARD_LIMITS.text)) ||
            (node.name !== undefined &&
                (typeof node.name !== "string" || node.name.length > 100)) ||
            (node.groupId !== undefined &&
                (typeof node.groupId !== "string" ||
                    !/^[a-zA-Z0-9_-]{1,100}$/.test(node.groupId))) ||
            (node.captureItemId !== undefined &&
                (typeof node.captureItemId !== "string" ||
                    !/^[a-zA-Z0-9_-]{1,100}$/.test(node.captureItemId))) ||
            (node.versionGroup !== undefined &&
                (typeof node.versionGroup !== "string" ||
                    node.versionGroup.length > 500)) ||
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
        if (node.kind === "image") {
            imageCount++;
            if (!node.assetId) throw new Error("Image nodes require an asset.");
            safeId(node.assetId, "asset id");
        }
        if (node.assetId) safeId(node.assetId, "asset id");
        if (node.originalAssetId)
            safeId(node.originalAssetId, "original asset id");
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
    if (imageCount > BOARD_LIMITS.images)
        throw new Error(
            `Boards support at most ${BOARD_LIMITS.images} images.`,
        );
    const relations = (node: BoardNode) =>
        [
            node.anchor?.nodeId,
            node.endAnchor?.nodeId,
            node.magnify?.nodeId,
        ].filter(Boolean) as string[];
    for (const node of document.nodes) {
        if (relations(node).some((id) => !ids.has(id)))
            throw new Error("Board relation points to a missing node.");
        for (const anchor of [node.anchor, node.endAnchor])
            if (
                anchor &&
                (nodesById.get(anchor.nodeId)?.kind !== "image" ||
                    !finite(anchor.x, 0, 1) ||
                    !finite(anchor.y, 0, 1))
            )
                throw new Error("Board anchor must target an image.");
        if (
            node.magnify &&
            (nodesById.get(node.magnify.nodeId)?.kind !== "image" ||
                !finite(node.magnify.x, 0, 1) ||
                !finite(node.magnify.y, 0, 1) ||
                !finite(node.magnify.width, 0.001, 1) ||
                !finite(node.magnify.height, 0.001, 1) ||
                !finite(node.magnify.zoom, 1, 32))
        )
            throw new Error("Board magnifier must target an image.");
    }
    if (document.settings.focusIds.some((id) => !ids.has(id)))
        throw new Error("Board focus points to a missing node.");
    const styleIds = new Set<string>();
    for (const preset of document.styles) {
        safeId(preset.id, "style id");
        if (
            styleIds.has(preset.id) ||
            typeof preset.name !== "string" ||
            preset.name.length === 0 ||
            preset.name.length > 80 ||
            !preset.style ||
            typeof preset.style.fill !== "string" ||
            typeof preset.style.stroke !== "string" ||
            !finite(preset.style.strokeWidth, 0, 100) ||
            !finite(preset.style.fontSize, 1, 500)
        )
            throw new Error("Invalid board style preset.");
        styleIds.add(preset.id);
    }
    if (
        Buffer.byteLength(JSON.stringify(document)) > BOARD_LIMITS.metadataBytes
    )
        throw new Error("Board metadata exceeds 2 MiB.");
    return structuredClone(document);
}

const emptyDocument = (id: string, name: string): BoardDocument => ({
    version: 1,
    id,
    revision: 0,
    name,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { autoAdd: false, focusIds: [], preset: "design" },
    nodes: [],
    styles: [],
});

export class CaptureBoardStore {
    readonly #root: string;
    readonly #documents: string;
    readonly #assets: string;
    readonly #pending: string;
    readonly #options: CaptureBoardStoreOptions;
    #readOnlyReason?: string;
    #index: BoardIndex;

    constructor(options: CaptureBoardStoreOptions) {
        this.#options = options;
        this.#root = options.root;
        this.#documents = join(options.root, "documents");
        this.#assets = join(options.root, "assets");
        this.#pending = join(options.root, "pending");
        for (const directory of [
            this.#root,
            this.#documents,
            this.#assets,
            this.#pending,
        ])
            mkdirSync(directory, { recursive: true });
        this.#index = this.#readIndex();
    }

    #indexPath() {
        return join(this.#root, "index.json");
    }
    #documentPath(id: string) {
        return join(this.#documents, `${safeId(id)}.json`);
    }
    #assetPath(id: string) {
        return join(this.#assets, `${safeId(id)}.png`);
    }
    #pendingPath(itemId: string, boardId: string) {
        return join(this.#pending, `${safeId(boardId)}-${safeId(itemId)}.json`);
    }
    #readIndex(): BoardIndex {
        const indexPath = this.#indexPath();
        if (!existsSync(indexPath))
            return { version: 1, activeBoardId: null, assets: [] };
        try {
            const data = JSON.parse(
                readFileSync(indexPath, "utf8"),
            ) as BoardIndex;
            if (
                data.version === 1 &&
                (data.activeBoardId === null ||
                    (typeof data.activeBoardId === "string" &&
                        /^[a-zA-Z0-9_-]{1,100}$/.test(data.activeBoardId))) &&
                Array.isArray(data.assets) &&
                data.assets.every(
                    (asset) =>
                        asset &&
                        /^[a-zA-Z0-9_-]{1,100}$/.test(asset.id) &&
                        /^[a-zA-Z0-9_-]{1,100}$/.test(asset.boardId) &&
                        finite(asset.width, 1, 100_000) &&
                        finite(asset.height, 1, 100_000) &&
                        finite(asset.bytes, 1, BOARD_LIMITS.assetBytes) &&
                        ["owned", "prepared", "pending"].includes(asset.state),
                ) &&
                new Set(data.assets.map((asset) => asset.id)).size ===
                    data.assets.length
            )
                return data;
            throw new Error("Board asset index has an invalid schema.");
        } catch (error) {
            const backup = `${indexPath}.corrupt-${Date.now()}-${randomUUID()}`;
            try {
                copyFileSync(indexPath, backup);
            } catch {}
            this.#readOnlyReason = `Board asset index is corrupt. A backup was preserved at ${backup}. ${
                error instanceof Error ? error.message : String(error)
            }`;
            return this.#recoverReadOnlyIndex();
        }
    }
    #recoverReadOnlyIndex(): BoardIndex {
        const assets = new Map<string, AssetRecord>();
        const recover = (
            id: string,
            boardId: string,
            state: AssetRecord["state"],
        ) => {
            if (assets.has(id) || !this.#options.inspect) return;
            try {
                const image = this.#options.inspect(
                    readFileSync(this.#assetPath(id)),
                );
                assets.set(id, {
                    id,
                    boardId,
                    width: image.width,
                    height: image.height,
                    bytes: image.png.length,
                    state,
                });
            } catch {}
        };
        for (const name of readdirSync(this.#documents)) {
            if (!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(name)) continue;
            try {
                const document = validateBoardDocument(
                    JSON.parse(
                        readFileSync(join(this.#documents, name), "utf8"),
                    ),
                );
                for (const id of document.nodes
                    .flatMap((node) => [node.assetId, node.originalAssetId])
                    .filter((id): id is string => Boolean(id)))
                    recover(id, document.id, "owned");
            } catch {}
        }
        for (const name of readdirSync(this.#pending)) {
            if (!name.endsWith(".json")) continue;
            try {
                const pending = JSON.parse(
                    readFileSync(join(this.#pending, name), "utf8"),
                ) as PendingCapture;
                safeId(pending.assetId, "pending asset id");
                safeId(pending.targetBoardId, "pending board id");
                recover(pending.assetId, pending.targetBoardId, "pending");
            } catch {}
        }
        return {
            version: 1,
            activeBoardId: null,
            assets: [...assets.values()],
        };
    }
    #assertWritable() {
        if (this.#readOnlyReason) throw new Error(this.#readOnlyReason);
    }
    #atomicJson(path: string, value: unknown) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(value, null, 2), {
            flag: "wx",
        });
        replaceFileSync(temporary, path);
    }
    #persistIndex() {
        this.#assertWritable();
        this.#atomicJson(this.#indexPath(), this.#index);
    }
    #writeDocument(document: BoardDocument) {
        this.#assertWritable();
        this.#atomicJson(this.#documentPath(document.id), document);
    }
    #documentsList() {
        return readdirSync(this.#documents)
            .filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))
            .map((name) => {
                try {
                    return validateBoardDocument(
                        JSON.parse(
                            readFileSync(join(this.#documents, name), "utf8"),
                        ),
                    );
                } catch {
                    return undefined;
                }
            })
            .filter((value): value is BoardDocument => Boolean(value));
    }
    #assetRecord(boardId: string, assetId: string) {
        const asset = this.#index.assets.find(
            (candidate) =>
                candidate.id === assetId && candidate.boardId === boardId,
        );
        if (!asset || !existsSync(this.#assetPath(asset.id)))
            throw new Error("Board asset was not found.");
        return asset;
    }
    #ownedBytes() {
        return this.#index.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    }
    #storeAsset(
        boardId: string,
        image: BoardDerivedImage,
        state: AssetRecord["state"],
    ) {
        safeId(boardId, "board id");
        const verified = this.#options.inspect
            ? this.#options.inspect(image.png)
            : image;
        if (
            verified.png.length <= 0 ||
            verified.png.length > BOARD_LIMITS.assetBytes ||
            verified.png.subarray(0, 8).toString("hex") !==
                "89504e470d0a1a0a" ||
            !finite(verified.width, 1, 100_000) ||
            !finite(verified.height, 1, 100_000) ||
            verified.width * verified.height > BOARD_LIMITS.assetPixels
        )
            throw new Error("Board image exceeds the asset limits.");
        if (
            this.#ownedBytes() + verified.png.length >
            BOARD_LIMITS.storageBytes
        )
            throw new Error("Board storage exceeds 512 MiB.");
        const id = randomUUID();
        writeFileSync(this.#assetPath(id), verified.png, { flag: "wx" });
        const record: AssetRecord = {
            id,
            boardId,
            width: verified.width,
            height: verified.height,
            bytes: verified.png.length,
            state,
        };
        this.#index.assets.push(record);
        try {
            this.#persistIndex();
        } catch (error) {
            this.#index.assets = this.#index.assets.filter(
                (asset) => asset.id !== id,
            );
            try {
                unlinkSync(this.#assetPath(id));
            } catch {}
            throw error;
        }
        return this.#assetRecord(boardId, id);
    }
    #removeAsset(id: string) {
        const previous = this.#index.assets;
        this.#index.assets = previous.filter((asset) => asset.id !== id);
        try {
            this.#persistIndex();
        } catch (error) {
            this.#index.assets = previous;
            throw error;
        }
        try {
            unlinkSync(this.#assetPath(id));
        } catch {}
    }

    status() {
        return {
            readOnly: Boolean(this.#readOnlyReason),
            ...(this.#readOnlyReason ? { error: this.#readOnlyReason } : {}),
        };
    }
    list(): BoardSummary[] {
        return this.#documentsList()
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((document) => ({
                id: document.id,
                name: document.name,
                revision: document.revision,
                updatedAt: document.updatedAt,
                nodeCount: document.nodes.length,
                imageCount: document.nodes.filter(
                    (node) => node.kind === "image",
                ).length,
                active: document.id === this.#index.activeBoardId,
            }));
    }
    create(name = "새 보드") {
        if (this.list().length >= BOARD_LIMITS.boards)
            throw new Error(
                `At most ${BOARD_LIMITS.boards} boards are allowed.`,
            );
        const document = emptyDocument(
            randomUUID(),
            name.trim().slice(0, 80) || "새 보드",
        );
        this.#writeDocument(document);
        if (!this.#index.activeBoardId) {
            this.#index.activeBoardId = document.id;
            this.#persistIndex();
        }
        return document;
    }
    load(id: string) {
        safeId(id, "board id");
        if (!existsSync(this.#documentPath(id)))
            throw new Error("Board was not found.");
        return validateBoardDocument(
            JSON.parse(readFileSync(this.#documentPath(id), "utf8")),
        );
    }
    save(value: BoardDocument, expectedRevision: number) {
        const document = validateBoardDocument(value);
        const current = this.load(document.id);
        if (
            current.revision !== expectedRevision ||
            document.revision !== expectedRevision
        )
            throw new Error(
                `Board revision conflict: expected ${current.revision}.`,
            );
        const assets = new Set(
            this.#index.assets
                .filter((asset) => asset.boardId === document.id)
                .map((asset) => asset.id),
        );
        for (const node of document.nodes) {
            if (node.assetId && !assets.has(node.assetId))
                throw new Error("Board document references an unowned asset.");
            if (node.originalAssetId && !assets.has(node.originalAssetId))
                throw new Error(
                    "Board document references an unowned original.",
                );
        }
        const saved = {
            ...document,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
        };
        this.#writeDocument(saved);
        const referenced = new Set(
            saved.nodes
                .flatMap((node) => [node.assetId, node.originalAssetId])
                .filter(Boolean),
        );
        let changed = false;
        for (const asset of this.#index.assets)
            if (
                asset.boardId === saved.id &&
                referenced.has(asset.id) &&
                asset.state !== "owned"
            ) {
                asset.state = "owned";
                changed = true;
            }
        if (changed) this.#persistIndex();
        return saved;
    }
    setActive(id: string | null) {
        if (id !== null) this.load(id);
        const previous = this.#index.activeBoardId;
        this.#index.activeBoardId = id;
        try {
            this.#persistIndex();
        } catch (error) {
            this.#index.activeBoardId = previous;
            throw error;
        }
    }
    activeBoardId() {
        return this.#index.activeBoardId;
    }
    addItems(boardId: string, itemIds: string[], expectedRevision: number) {
        if (
            !Array.isArray(itemIds) ||
            itemIds.length === 0 ||
            itemIds.length > BOARD_LIMITS.images ||
            itemIds.some((id) => typeof id !== "string")
        )
            throw new Error("Select one or more valid capture items.");
        const document = this.load(boardId);
        if (document.revision !== expectedRevision)
            throw new Error(
                `Board revision conflict: expected ${document.revision}.`,
            );
        const existing = new Set(
            document.nodes.map((node) => node.captureItemId).filter(Boolean),
        );
        const unique = [...new Set(itemIds)].filter((id) => !existing.has(id));
        if (
            document.nodes.filter((node) => node.kind === "image").length +
                unique.length >
            BOARD_LIMITS.images
        )
            throw new Error(
                `Boards support at most ${BOARD_LIMITS.images} images.`,
            );
        const created: string[] = [];
        const nodes: BoardNode[] = [];
        try {
            for (const [index, itemId] of unique.entries()) {
                const snapshot = this.#options.resolveItem(itemId);
                const asset = this.#storeAsset(boardId, snapshot, "owned");
                created.push(asset.id);
                const key = areaKey(
                    snapshot.item.source ?? {
                        kind: "import",
                        capturedAt: snapshot.item.createdAt,
                    },
                    snapshot.region,
                    itemId,
                );
                nodes.push({
                    id: randomUUID(),
                    kind: "image",
                    x: 32 + ((document.nodes.length + index) % 5) * 36,
                    y: 32 + ((document.nodes.length + index) % 5) * 32,
                    width: Math.min(720, asset.width),
                    height:
                        Math.min(720, asset.width) *
                        (asset.height / asset.width),
                    rotation: 0,
                    visible: true,
                    locked: false,
                    style: { ...DEFAULT_STYLE },
                    assetId: asset.id,
                    originalAssetId: asset.id,
                    captureItemId: itemId,
                    source: {
                        itemId,
                        captureRevision: snapshot.item.draftRevision,
                        context: snapshot.item.source ?? {
                            kind: "import",
                            capturedAt: snapshot.item.createdAt,
                        },
                        ...(snapshot.region ? { region: snapshot.region } : {}),
                        areaKey: key,
                    },
                    versionGroup: key,
                });
            }
            return this.save(
                { ...document, nodes: [...document.nodes, ...nodes] },
                expectedRevision,
            );
        } catch (error) {
            for (const id of created) this.#removeAsset(id);
            throw error;
        }
    }
    assetData(
        boardId: string,
        assetId: string,
        quality: "preview" | "original" = "preview",
    ) {
        this.load(boardId);
        this.#assetRecord(boardId, assetId);
        const png = readFileSync(this.#assetPath(assetId));
        const output =
            quality === "preview" && this.#options.preview
                ? this.#options.preview(png, BOARD_LIMITS.previewEdge).png
                : png;
        return `data:image/png;base64,${output.toString("base64")}`;
    }
    async cutout(
        boardId: string,
        nodeId: string,
        sourceAssetId: string,
    ): Promise<BoardDerivation> {
        const document = this.load(boardId);
        const node = document.nodes.find(
            (candidate) => candidate.id === nodeId,
        );
        if (!node || node.kind !== "image" || node.assetId !== sourceAssetId)
            throw new Error("Cutout source no longer matches the board image.");
        this.#assetRecord(boardId, sourceAssetId);
        const image = await this.#options.prepareCutout(
            readFileSync(this.#assetPath(sourceAssetId)),
        );
        const asset = this.#storeAsset(boardId, image, "prepared");
        return {
            boardId,
            nodes: [
                {
                    nodeId,
                    sourceAssetId,
                    assetId: asset.id,
                    width: asset.width,
                    height: asset.height,
                },
            ],
        };
    }
    async beautify(
        boardId: string,
        images: Array<{ nodeId: string; sourceAssetId: string }>,
        style: NamedBeautifyStyle,
    ): Promise<BoardDerivation> {
        const document = this.load(boardId);
        if (
            !Array.isArray(images) ||
            images.length === 0 ||
            images.length > BOARD_LIMITS.images
        )
            throw new Error("Select one or more board images.");
        if (
            !style ||
            typeof style.id !== "string" ||
            style.id.length > 100 ||
            typeof style.name !== "string" ||
            style.name.length > 80 ||
            typeof style.background !== "string" ||
            style.background.length > 100 ||
            ![style.padding, style.shadow, style.radius].every(
                (value) => typeof value === "number" && Number.isFinite(value),
            ) ||
            style.padding < 0 ||
            style.padding > 256
        )
            throw new Error("Invalid board beautify style.");
        const result: BoardDerivation = { boardId, nodes: [] };
        const created: string[] = [];
        try {
            for (const input of images) {
                const node = document.nodes.find(
                    (candidate) => candidate.id === input.nodeId,
                );
                if (
                    !node ||
                    node.kind !== "image" ||
                    node.assetId !== input.sourceAssetId
                )
                    throw new Error(
                        "Beautify source no longer matches the board image.",
                    );
                this.#assetRecord(boardId, input.sourceAssetId);
                const image = await this.#options.prepareBeautify(
                    readFileSync(this.#assetPath(input.sourceAssetId)),
                    style,
                );
                const asset = this.#storeAsset(boardId, image, "prepared");
                created.push(asset.id);
                result.nodes.push({
                    nodeId: input.nodeId,
                    sourceAssetId: input.sourceAssetId,
                    assetId: asset.id,
                    width: asset.width,
                    height: asset.height,
                });
            }
            return result;
        } catch (error) {
            for (const id of created) this.#removeAsset(id);
            throw error;
        }
    }
    discardDerived(boardId: string, assetIds: string[]) {
        this.#assertWritable();
        const document = this.load(boardId);
        if (
            !Array.isArray(assetIds) ||
            assetIds.length === 0 ||
            assetIds.length > BOARD_LIMITS.images ||
            assetIds.some((id) => typeof id !== "string") ||
            new Set(assetIds).size !== assetIds.length
        )
            throw new Error("Select prepared board assets to discard.");
        const retained = new Set(
            document.nodes
                .flatMap((node) => [node.assetId, node.originalAssetId])
                .filter(Boolean),
        );
        const records = assetIds.map((id) => this.#assetRecord(boardId, id));
        if (
            records.some(
                (asset) => asset.state !== "prepared" || retained.has(asset.id),
            )
        )
            throw new Error(
                "Only unreferenced prepared assets can be discarded.",
            );
        for (const asset of records) this.#removeAsset(asset.id);
    }
    queueCapture(snapshot: BoardItemSnapshot, targetBoardId?: string) {
        const boardId = targetBoardId ?? this.#index.activeBoardId;
        if (!boardId) return undefined;
        const document = this.load(boardId);
        if (!document.settings.autoAdd) return undefined;
        const path = this.#pendingPath(snapshot.item.id, boardId);
        if (existsSync(path))
            return JSON.parse(readFileSync(path, "utf8")) as PendingCapture;
        const asset = this.#storeAsset(boardId, snapshot, "pending");
        const source = snapshot.item.source ?? {
            kind: "capture" as const,
            capturedAt: snapshot.item.createdAt,
        };
        const pending: PendingCapture = {
            version: 1,
            itemId: snapshot.item.id,
            targetBoardId: boardId,
            ...(snapshot.region ? { region: snapshot.region } : {}),
            assetId: asset.id,
            source,
            areaKey: areaKey(source, snapshot.region, snapshot.item.id),
            capturedAt: snapshot.item.createdAt,
        };
        try {
            this.#atomicJson(path, pending);
        } catch (error) {
            this.#removeAsset(asset.id);
            throw error;
        }
        this.#options.onCaptureAdded?.({
            itemId: pending.itemId,
            targetBoardId: pending.targetBoardId,
            ...(pending.region ? { region: pending.region } : {}),
        });
        return pending;
    }
    pendingCaptures(): BoardCaptureEvent[] {
        return readdirSync(this.#pending)
            .filter((name) => name.endsWith(".json"))
            .flatMap((name) => {
                try {
                    const pending = JSON.parse(
                        readFileSync(join(this.#pending, name), "utf8"),
                    ) as PendingCapture;
                    this.load(pending.targetBoardId);
                    this.#assetRecord(pending.targetBoardId, pending.assetId);
                    return [
                        {
                            itemId: pending.itemId,
                            targetBoardId: pending.targetBoardId,
                            ...(pending.region
                                ? { region: pending.region }
                                : {}),
                        },
                    ];
                } catch {
                    return [];
                }
            });
    }
    adoptPending(
        itemId: string,
        targetBoardId: string,
        expectedRevision: number,
    ) {
        const path = this.#pendingPath(itemId, targetBoardId);
        if (!existsSync(path)) return this.load(targetBoardId);
        const pending = JSON.parse(
            readFileSync(path, "utf8"),
        ) as PendingCapture;
        const document = this.load(targetBoardId);
        if (document.nodes.some((node) => node.captureItemId === itemId)) {
            this.ackCapture(itemId, targetBoardId);
            return document;
        }
        const asset = this.#assetRecord(targetBoardId, pending.assetId);
        const node: BoardNode = {
            id: randomUUID(),
            kind: "image",
            x: 32 + (document.nodes.length % 5) * 36,
            y: 32 + (document.nodes.length % 5) * 32,
            width: Math.min(720, asset.width),
            height: Math.min(720, asset.width) * (asset.height / asset.width),
            rotation: 0,
            visible: true,
            locked: false,
            style: { ...DEFAULT_STYLE },
            assetId: asset.id,
            originalAssetId: asset.id,
            captureItemId: itemId,
            source: {
                itemId,
                context: pending.source,
                ...(pending.region ? { region: pending.region } : {}),
                areaKey: pending.areaKey,
            },
            versionGroup: pending.areaKey,
        };
        const saved = this.save(
            { ...document, nodes: [...document.nodes, node] },
            expectedRevision,
        );
        this.ackCapture(itemId, targetBoardId);
        return saved;
    }
    ackCapture(itemId: string, targetBoardId: string) {
        const path = this.#pendingPath(itemId, targetBoardId);
        if (!existsSync(path)) return;
        const pending = JSON.parse(
            readFileSync(path, "utf8"),
        ) as PendingCapture;
        const asset = this.#index.assets.find(
            (candidate) => candidate.id === pending.assetId,
        );
        if (asset) {
            const previous = asset.state;
            asset.state = "owned";
            try {
                this.#persistIndex();
            } catch (error) {
                asset.state = previous;
                throw error;
            }
        }
        try {
            unlinkSync(path);
        } catch {}
    }
    portable(boardId: string) {
        const document = this.load(boardId);
        const ids = new Set(
            document.nodes
                .flatMap((node) => [node.assetId, node.originalAssetId])
                .filter(Boolean),
        );
        const assets = [...ids].map((id) => {
            const asset = this.#assetRecord(boardId, id as string);
            return {
                id: asset.id,
                width: asset.width,
                height: asset.height,
                data: readFileSync(this.#assetPath(asset.id)).toString(
                    "base64",
                ),
            };
        });
        const value = JSON.stringify({ version: 1, document, assets });
        if (Buffer.byteLength(value) > BOARD_LIMITS.portableBytes)
            throw new Error("Portable board exceeds 96 MiB.");
        return value;
    }
    importPortable(value: string) {
        if (Buffer.byteLength(value) > BOARD_LIMITS.portableBytes)
            throw new Error("Portable board exceeds 96 MiB.");
        const parsed = JSON.parse(value) as {
            version?: unknown;
            document?: unknown;
            assets?: unknown;
        };
        if (parsed.version !== 1 || !Array.isArray(parsed.assets))
            throw new Error("Invalid portable board.");
        if (this.list().length >= BOARD_LIMITS.boards)
            throw new Error(
                `At most ${BOARD_LIMITS.boards} boards are allowed.`,
            );
        if (parsed.assets.length > BOARD_LIMITS.images * 2)
            throw new Error("Portable board has too many assets.");
        const original = validateBoardDocument(parsed.document);
        const rawAssets = parsed.assets as Array<Record<string, unknown>>;
        const portableIds = new Set<string>();
        for (const raw of rawAssets) {
            if (
                typeof raw.id !== "string" ||
                portableIds.has(raw.id) ||
                typeof raw.data !== "string" ||
                !finite(raw.width, 1, 100_000) ||
                !finite(raw.height, 1, 100_000)
            )
                throw new Error("Invalid or duplicate portable board asset.");
            safeId(raw.id, "portable asset id");
            portableIds.add(raw.id);
        }
        const referencedAssets = original.nodes
            .flatMap((node) => [node.assetId, node.originalAssetId])
            .filter((id): id is string => Boolean(id));
        if (referencedAssets.some((id) => !portableIds.has(id)))
            throw new Error("Portable board is missing a referenced asset.");
        const board = emptyDocument(randomUUID(), `${original.name} 복사본`);
        const remap = new Map<string, string>();
        const created: string[] = [];
        try {
            for (const raw of rawAssets) {
                const rawId = raw.id as string;
                const png = Buffer.from(raw.data as string, "base64");
                const asset = this.#storeAsset(
                    board.id,
                    {
                        png,
                        width: raw.width as number,
                        height: raw.height as number,
                    },
                    "owned",
                );
                remap.set(rawId, asset.id);
                created.push(asset.id);
            }
            board.viewport = original.viewport;
            board.styles = original.styles;
            const nodeIds = new Map(
                original.nodes.map((node) => [node.id, randomUUID()]),
            );
            board.settings = {
                ...original.settings,
                focusIds: original.settings.focusIds.map(
                    (id) => nodeIds.get(id) as string,
                ),
            };
            board.nodes = original.nodes.map((node) => ({
                ...node,
                id: nodeIds.get(node.id) as string,
                assetId: node.assetId ? remap.get(node.assetId) : undefined,
                originalAssetId: node.originalAssetId
                    ? remap.get(node.originalAssetId)
                    : undefined,
                anchor: node.anchor
                    ? {
                          ...node.anchor,
                          nodeId: nodeIds.get(node.anchor.nodeId) as string,
                      }
                    : undefined,
                endAnchor: node.endAnchor
                    ? {
                          ...node.endAnchor,
                          nodeId: nodeIds.get(node.endAnchor.nodeId) as string,
                      }
                    : undefined,
                magnify: node.magnify
                    ? {
                          ...node.magnify,
                          nodeId: nodeIds.get(node.magnify.nodeId) as string,
                      }
                    : undefined,
            }));
            validateBoardDocument(board);
            this.#writeDocument(board);
            return board;
        } catch (error) {
            for (const id of created) this.#removeAsset(id);
            throw error;
        }
    }
}
