import type {
    BoardDocument,
    BoardNode,
    BoardPoint,
    BoardViewport,
    CaptureBoardApi,
} from "./captureBoard";
import type { NamedBeautifyStyle } from "./openCaptureTypes";

export type BoardTool =
    | "select"
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
export interface BoardEditorOptions {
    surface: HTMLElement;
    stage: HTMLElement;
    controls: HTMLElement;
    getDocument(): BoardDocument | null;
    getSelection(): string[];
    select(ids: string[]): void;
    mutate(change: (document: BoardDocument) => void, label?: string): void;
    getViewport(): BoardViewport;
    screenToWorld(point: BoardPoint): BoardPoint;
    assetData(
        assetId: string,
        quality?: "preview" | "original",
    ): Promise<string>;
    announce(message: string, error?: boolean): void;
    changed?(): void;
}
export interface BoardEditorController {
    root: HTMLElement;
    setSelection(ids: string[]): void;
    setTool(tool: BoardTool): void;
    getTool(): BoardTool;
    render(): void;
    exportRaster(options?: {
        background?: string;
        selectionOnly?: boolean;
    }): Promise<string>;
    command(id: string): unknown;
    destroy(): void;
}
export interface CaptureBoardOptions {
    loadBeautifyStyles?(): Promise<NamedBeautifyStyle[]>;
    api: CaptureBoardApi;
    announce(message: string, error?: boolean): void;
    compareItems?(ids: string[]): unknown;
    capture?(): unknown;
    changed?(): void;
}
export interface CaptureBoardController {
    root: HTMLElement;
    ready(): Promise<void>;
    open(id?: string): Promise<void>;
    addItems(ids: string[]): Promise<void>;
    flush(): Promise<void>;
    hasPendingChanges(): boolean;
    command(id: string): unknown;
    getDocument(): BoardDocument | null;
    getSelection(): BoardNode[];
    destroy(): void;
}
