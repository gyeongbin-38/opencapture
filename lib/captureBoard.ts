import type {
    CaptureRect,
    CaptureSourceContext,
    NamedBeautifyStyle,
    OpenCaptureItem,
} from "./openCaptureTypes";

export const BOARD_LIMITS = {
    boards: 30,
    nodes: 300,
    images: 40,
    vertices: 128,
    text: 2000,
    metadataBytes: 2 * 1024 * 1024,
    assetBytes: 32 * 1024 * 1024,
    assetPixels: 32_000_000,
    storageBytes: 512 * 1024 * 1024,
    portableBytes: 96 * 1024 * 1024,
    previewEdge: 1024,
    decodedImages: 12,
    exportPixels: 16_000_000,
} as const;
export type BoardNodeKind =
    | "image"
    | "rect"
    | "ellipse"
    | "line"
    | "arrow"
    | "polygon"
    | "text"
    | "note"
    | "callout"
    | "step"
    | "magnify";
export type BoardPoint = { x: number; y: number };
export type BoardStyle = {
    fill: string;
    stroke: string;
    strokeWidth: number;
    fontSize: number;
};
export type BoardNamedStyle = { id: string; name: string; style: BoardStyle };
export type BoardAnchor = { nodeId: string; x: number; y: number };
export type BoardImageSource = {
    itemId: string;
    captureRevision?: number;
    context: CaptureSourceContext;
    region?: CaptureRect;
    areaKey: string;
};
export type BoardNode = {
    id: string;
    kind: BoardNodeKind;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    visible: boolean;
    locked: boolean;
    name?: string;
    groupId?: string;
    style: BoardStyle;
    points?: BoardPoint[];
    text?: string;
    assetId?: string;
    originalAssetId?: string;
    captureItemId?: string;
    source?: BoardImageSource;
    versionGroup?: string;
    anchor?: BoardAnchor;
    endAnchor?: BoardAnchor;
    magnify?: {
        nodeId: string;
        x: number;
        y: number;
        width: number;
        height: number;
        zoom: number;
    };
};
export type BoardViewport = { x: number; y: number; zoom: number };
export type BoardDocument = {
    version: 1;
    id: string;
    revision: number;
    name: string;
    updatedAt: string;
    viewport: BoardViewport;
    settings: {
        autoAdd: boolean;
        focusIds: string[];
        preset: "design" | "bug" | "study";
    };
    nodes: BoardNode[];
    styles: BoardNamedStyle[];
};
export type BoardSummary = {
    id: string;
    name: string;
    revision: number;
    updatedAt: string;
    nodeCount: number;
    imageCount: number;
    active?: boolean;
};
export type BoardDerivation = {
    boardId: string;
    nodes: Array<{
        nodeId: string;
        sourceAssetId: string;
        assetId: string;
        width: number;
        height: number;
    }>;
};
export type BoardCaptureEvent = {
    itemId: string;
    targetBoardId: string;
    region?: CaptureRect;
};
export type CaptureCutoutInput = { itemId?: string; dataURL?: string };
export type CaptureCutoutResult = {
    itemId: string;
    dataURL: string;
    item: OpenCaptureItem;
};
export interface CaptureBoardApi {
    status(): Promise<{ readOnly: boolean; error?: string }>;
    list(): Promise<BoardSummary[]>;
    create(name?: string): Promise<BoardDocument>;
    load(id: string): Promise<BoardDocument>;
    save(
        document: BoardDocument,
        expectedRevision: number,
    ): Promise<BoardDocument>;
    setActive(id: string | null): Promise<void>;
    addItems(
        boardId: string,
        itemIds: string[],
        expectedRevision: number,
    ): Promise<BoardDocument>;
    assetData(
        boardId: string,
        assetId: string,
        quality?: "preview" | "original",
    ): Promise<string>;
    cutout(
        boardId: string,
        nodeId: string,
        sourceAssetId: string,
    ): Promise<BoardDerivation>;
    beautify(
        boardId: string,
        images: Array<{ nodeId: string; sourceAssetId: string }>,
        style: NamedBeautifyStyle,
    ): Promise<BoardDerivation>;
    discardDerived(boardId: string, assetIds: string[]): Promise<void>;
    exportFile(
        boardId: string,
        format: "png" | "pdf",
        dataURL: string,
    ): Promise<{ saved: boolean; path?: string }>;
    exportPortable(boardId: string): Promise<{ saved: boolean; path?: string }>;
    importPortable(): Promise<BoardDocument | null>;
    pendingCaptures(): Promise<BoardCaptureEvent[]>;
    ackCapture(itemId: string, targetBoardId: string): Promise<void>;
    onCaptureAdded(callback: (event: BoardCaptureEvent) => void): () => void;
}
