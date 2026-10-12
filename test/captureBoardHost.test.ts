// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
    BoardDocument,
    BoardSummary,
    CaptureBoardApi,
} from "../lib/captureBoard";
import { createCaptureBoard } from "../src/renderer/dashboard/captureBoard";

class TestResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
});

Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value },
});

class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: MouseEventInit & { pointerId: number }) {
        super(type, init);
        this.pointerId = init.pointerId;
    }
}

Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: TestPointerEvent,
});

const pointer = (
    type: string,
    pointerId: number,
    clientX: number,
    clientY: number,
) =>
    new TestPointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId,
    });

Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value() {} },
    releasePointerCapture: { configurable: true, value() {} },
    hasPointerCapture: { configurable: true, value: () => true },
    scrollTo: { configurable: true, value() {} },
    scrollIntoView: { configurable: true, value() {} },
});

const board = (): BoardDocument => ({
    version: 1,
    id: "board-1",
    revision: 0,
    name: "테스트 보드",
    updatedAt: "2026-10-11T00:00:00.000Z",
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { autoAdd: true, focusIds: [], preset: "design" },
    nodes: [
        {
            id: "rect-1",
            kind: "rect",
            x: 10,
            y: 20,
            width: 100,
            height: 50,
            rotation: 0,
            visible: true,
            locked: false,
            style: {
                fill: "transparent",
                stroke: "#ffffff",
                strokeWidth: 2,
                fontSize: 14,
            },
        },
        {
            id: "polygon-1",
            kind: "polygon",
            x: 200,
            y: 100,
            width: 50,
            height: 60,
            rotation: 0,
            visible: true,
            locked: false,
            points: [
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 25, y: 60 },
            ],
            style: {
                fill: "transparent",
                stroke: "#ffffff",
                strokeWidth: 2,
                fontSize: 14,
            },
        },
    ],
    styles: [],
});

describe("capture board host", () => {
    it("creates and opens the first board for an empty profile", async () => {
        let stored: BoardDocument | null = null;
        let createCalls = 0;
        const api = {
            list: async () =>
                stored
                    ? [
                          {
                              id: stored.id,
                              name: stored.name,
                              revision: stored.revision,
                              updatedAt: stored.updatedAt,
                              nodeCount: stored.nodes.length,
                              imageCount: 0,
                              active: true,
                          },
                      ]
                    : [],
            create: async () => {
                createCalls += 1;
                stored = board();
                return structuredClone(stored);
            },
            load: async () => structuredClone(stored as BoardDocument),
            save: async (document: BoardDocument, expected: number) => ({
                ...structuredClone(document),
                revision: expected + 1,
            }),
            setActive: async () => undefined,
            addItems: async () => structuredClone(stored as BoardDocument),
            assetData: async () => "data:image/png;base64,",
            cutout: async () => ({ boardId: "board-1", nodes: [] }),
            beautify: async () => ({ boardId: "board-1", nodes: [] }),
            discardDerived: async () => undefined,
            exportFile: async () => ({ saved: false }),
            exportPortable: async () => ({ saved: false }),
            importPortable: async () => null,
            pendingCaptures: async () => [],
            ackCapture: async () => undefined,
            onCaptureAdded: () => () => undefined,
        } as unknown as CaptureBoardApi;
        const controller = createCaptureBoard({
            api,
            announce: () => undefined,
        });
        document.body.append(controller.root);
        await controller.ready();
        expect(createCalls).toBe(1);
        expect(controller.getDocument()?.id).toBe("board-1");
        expect(
            controller.root.querySelector(
                '.board-tab[data-board-id="board-1"]',
            ),
        ).toBeInstanceOf(HTMLButtonElement);
        await controller.flush();
        controller.destroy();
    });

    it("keeps editor controls mounted across host selection renders", async () => {
        let stored = board();
        const summary = (): BoardSummary => ({
            id: stored.id,
            name: stored.name,
            revision: stored.revision,
            updatedAt: stored.updatedAt,
            nodeCount: stored.nodes.length,
            imageCount: 0,
            active: true,
        });
        const api = {
            list: async () => [summary()],
            create: async () => structuredClone(stored),
            load: async () => structuredClone(stored),
            save: async (document: BoardDocument, expected: number) => {
                expect(document.revision).toBe(expected);
                stored = {
                    ...structuredClone(document),
                    revision: expected + 1,
                };
                return structuredClone(stored);
            },
            setActive: async () => undefined,
            addItems: async () => structuredClone(stored),
            assetData: async () => "data:image/png;base64,",
            cutout: async () => ({ boardId: stored.id, nodes: [] }),
            beautify: async () => ({ boardId: stored.id, nodes: [] }),
            discardDerived: async () => undefined,
            exportFile: async () => ({ saved: false }),
            exportPortable: async () => ({ saved: false }),
            importPortable: async () => null,
            pendingCaptures: async () => [],
            ackCapture: async () => undefined,
            onCaptureAdded: () => () => undefined,
        } as unknown as CaptureBoardApi;
        const controller = createCaptureBoard({
            api,
            announce: () => undefined,
        });
        document.body.append(controller.root);
        await controller.ready();
        const toolbar = controller.root.querySelector(".board-editor__toolbar");
        expect(toolbar).toBeInstanceOf(HTMLElement);
        await controller.command("select-all");
        await controller.command("focus-clear");
        expect(controller.root.querySelector(".board-editor__toolbar")).toBe(
            toolbar,
        );
        expect(toolbar?.isConnected).toBe(true);
        await controller.flush();
        controller.destroy();
    });

    it("commits shape drag and vertex edits after host rerenders the SVG", async () => {
        let stored = board();
        const api = {
            list: async () => [
                {
                    id: stored.id,
                    name: stored.name,
                    revision: stored.revision,
                    updatedAt: stored.updatedAt,
                    nodeCount: stored.nodes.length,
                    imageCount: 0,
                    active: true,
                },
            ],
            create: async () => structuredClone(stored),
            load: async () => structuredClone(stored),
            save: async (document: BoardDocument, expected: number) => {
                stored = {
                    ...structuredClone(document),
                    revision: expected + 1,
                };
                return structuredClone(stored);
            },
            setActive: async () => undefined,
            addItems: async () => structuredClone(stored),
            assetData: async () => "data:image/png;base64,",
            cutout: async () => ({ boardId: stored.id, nodes: [] }),
            beautify: async () => ({ boardId: stored.id, nodes: [] }),
            discardDerived: async () => undefined,
            exportFile: async () => ({ saved: false }),
            exportPortable: async () => ({ saved: false }),
            importPortable: async () => null,
            pendingCaptures: async () => [],
            ackCapture: async () => undefined,
            onCaptureAdded: () => () => undefined,
        } as unknown as CaptureBoardApi;
        const controller = createCaptureBoard({
            api,
            announce: () => undefined,
        });
        document.body.append(controller.root);
        await controller.ready();
        const surface = controller.root.querySelector(
            ".board-viewport",
        ) as HTMLElement;
        const originalRect = controller.root.querySelector(
            '.board-editor__node[data-node-id="rect-1"] g[data-node-id]',
        ) as SVGGElement;
        expect(originalRect.onpointerdown).toBeTypeOf("function");
        const rectDown = pointer("pointerdown", 1, 20, 30);
        originalRect.onpointerdown?.(rectDown as unknown as PointerEvent);
        expect(rectDown.defaultPrevented).toBe(true);
        expect(originalRect.isConnected).toBe(false);
        surface.dispatchEvent(pointer("pointermove", 1, 50, 70));
        surface.dispatchEvent(pointer("pointerup", 1, 50, 70));
        expect(
            controller
                .getDocument()
                ?.nodes.find((node) => node.id === "rect-1"),
        ).toMatchObject({ x: 40, y: 60 });
        await controller.command("undo");
        expect(
            controller
                .getDocument()
                ?.nodes.find((node) => node.id === "rect-1"),
        ).toMatchObject({ x: 10, y: 20 });

        const polygon = controller.root.querySelector(
            '.board-editor__node[data-node-id="polygon-1"] g[data-node-id]',
        ) as SVGGElement;
        polygon.onpointerdown?.(
            pointer("pointerdown", 2, 200, 100) as unknown as PointerEvent,
        );
        surface.dispatchEvent(pointer("pointerup", 2, 200, 100));
        const vertex = controller.root.querySelector(
            '.board-editor__node[data-node-id="polygon-1"] [data-vertex-index="0"]',
        ) as SVGCircleElement;
        const vertexDown = pointer("pointerdown", 3, 200, 100);
        vertex.onpointerdown?.(vertexDown as unknown as PointerEvent);
        expect(vertexDown.defaultPrevented).toBe(true);
        surface.dispatchEvent(pointer("pointermove", 3, 220, 130));
        surface.dispatchEvent(pointer("pointerup", 3, 220, 130));
        expect(
            controller
                .getDocument()
                ?.nodes.find((node) => node.id === "polygon-1")?.points?.[0],
        ).toEqual({ x: 20, y: 30 });
        await controller.flush();
        controller.destroy();
    });

    it("preserves local geometry changed while addItems is pending", async () => {
        let stored = board();
        let resolveAdd!: (document: BoardDocument) => void;
        let markAddStarted!: () => void;
        const addStarted = new Promise<void>((resolve) => {
            markAddStarted = resolve;
        });
        const api = {
            list: async () => [
                {
                    id: stored.id,
                    name: stored.name,
                    revision: stored.revision,
                    updatedAt: stored.updatedAt,
                    nodeCount: stored.nodes.length,
                    imageCount: 0,
                    active: true,
                },
            ],
            create: async () => structuredClone(stored),
            load: async () => structuredClone(stored),
            save: async (document: BoardDocument, expected: number) => {
                expect(document.revision).toBe(expected);
                stored = {
                    ...structuredClone(document),
                    revision: expected + 1,
                };
                return structuredClone(stored);
            },
            setActive: async () => undefined,
            addItems: async () => {
                markAddStarted();
                return new Promise<BoardDocument>((resolve) => {
                    resolveAdd = resolve;
                });
            },
            assetData: async () => "data:image/png;base64,",
            cutout: async () => ({ boardId: stored.id, nodes: [] }),
            beautify: async () => ({ boardId: stored.id, nodes: [] }),
            discardDerived: async () => undefined,
            exportFile: async () => ({ saved: false }),
            exportPortable: async () => ({ saved: false }),
            importPortable: async () => null,
            pendingCaptures: async () => [],
            ackCapture: async () => undefined,
            onCaptureAdded: () => () => undefined,
        } as unknown as CaptureBoardApi;
        const controller = createCaptureBoard({
            api,
            announce: () => undefined,
        });
        document.body.append(controller.root);
        await controller.ready();
        const adding = controller.addItems(["item-new"]);
        await addStarted;
        const surface = controller.root.querySelector(
            ".board-viewport",
        ) as HTMLElement;
        const rect = controller.root.querySelector(
            '.board-editor__node[data-node-id="rect-1"] g[data-node-id]',
        ) as SVGGElement;
        rect.onpointerdown?.(
            pointer("pointerdown", 9, 20, 30) as unknown as PointerEvent,
        );
        surface.dispatchEvent(pointer("pointermove", 9, 55, 75));
        surface.dispatchEvent(pointer("pointerup", 9, 55, 75));
        const serverDocument = board();
        serverDocument.revision = 1;
        serverDocument.nodes.push({
            id: "image-new",
            kind: "image",
            x: 32,
            y: 32,
            width: 160,
            height: 90,
            rotation: 0,
            visible: true,
            locked: false,
            style: {
                fill: "transparent",
                stroke: "#ffffff",
                strokeWidth: 2,
                fontSize: 14,
            },
            assetId: "asset-new",
            originalAssetId: "asset-new",
            captureItemId: "item-new",
        });
        let flushDone = false;
        const flushing = controller.flush().then(() => {
            flushDone = true;
        });
        await Promise.resolve();
        expect(flushDone).toBe(false);
        resolveAdd(serverDocument);
        await adding;
        expect(
            controller
                .getDocument()
                ?.nodes.find((node) => node.id === "rect-1"),
        ).toMatchObject({ x: 45, y: 65 });
        expect(
            controller
                .getDocument()
                ?.nodes.some((node) => node.id === "image-new"),
        ).toBe(true);
        await flushing;
        expect(stored.nodes.find((node) => node.id === "rect-1")).toMatchObject(
            { x: 45, y: 65 },
        );
        expect(stored.nodes.some((node) => node.id === "image-new")).toBe(true);
        controller.destroy();
    });

    it("flush waits for an add queued while an earlier save is blocked", async () => {
        let stored = board();
        let saveCalls = 0;
        let releaseSave!: () => void;
        let markSaveStarted!: () => void;
        let releaseAdd!: () => void;
        let markAddStarted!: () => void;
        const saveStarted = new Promise<void>((resolve) => {
            markSaveStarted = resolve;
        });
        const blockedSave = new Promise<void>((resolve) => {
            releaseSave = resolve;
        });
        const addStarted = new Promise<void>((resolve) => {
            markAddStarted = resolve;
        });
        const blockedAdd = new Promise<void>((resolve) => {
            releaseAdd = resolve;
        });
        const api = {
            list: async () => [
                {
                    id: stored.id,
                    name: stored.name,
                    revision: stored.revision,
                    updatedAt: stored.updatedAt,
                    nodeCount: stored.nodes.length,
                    imageCount: 0,
                    active: true,
                },
            ],
            create: async () => structuredClone(stored),
            load: async () => structuredClone(stored),
            save: async (document: BoardDocument, expected: number) => {
                saveCalls += 1;
                if (saveCalls === 1) {
                    markSaveStarted();
                    await blockedSave;
                }
                stored = {
                    ...structuredClone(document),
                    revision: expected + 1,
                };
                return structuredClone(stored);
            },
            setActive: async () => undefined,
            addItems: async () => {
                markAddStarted();
                await blockedAdd;
                const added = structuredClone(stored);
                added.revision += 1;
                added.nodes.push({
                    id: "late-image",
                    kind: "image",
                    x: 20,
                    y: 20,
                    width: 120,
                    height: 80,
                    rotation: 0,
                    visible: true,
                    locked: false,
                    style: {
                        fill: "transparent",
                        stroke: "#ffffff",
                        strokeWidth: 2,
                        fontSize: 14,
                    },
                    assetId: "late-asset",
                    originalAssetId: "late-asset",
                    captureItemId: "late-item",
                });
                stored = structuredClone(added);
                return added;
            },
            assetData: async () => "data:image/png;base64,",
            cutout: async () => ({ boardId: stored.id, nodes: [] }),
            beautify: async () => ({ boardId: stored.id, nodes: [] }),
            discardDerived: async () => undefined,
            exportFile: async () => ({ saved: false }),
            exportPortable: async () => ({ saved: false }),
            importPortable: async () => null,
            pendingCaptures: async () => [],
            ackCapture: async () => undefined,
            onCaptureAdded: () => () => undefined,
        } as unknown as CaptureBoardApi;
        const controller = createCaptureBoard({
            api,
            announce: () => undefined,
        });
        document.body.append(controller.root);
        await controller.ready();
        await controller.command("focus-clear");
        let flushSettled = false;
        const flushing = controller.flush().then(() => {
            flushSettled = true;
        });
        await saveStarted;
        const adding = controller.addItems(["late-item"]);
        releaseSave();
        await addStarted;
        await Promise.resolve();
        expect(flushSettled).toBe(false);
        releaseAdd();
        await flushing;
        expect(saveCalls).toBeGreaterThanOrEqual(2);
        expect(stored.nodes.some((node) => node.id === "late-image")).toBe(
            true,
        );
        await adding;
        expect(controller.hasPendingChanges()).toBe(false);
        controller.destroy();
    });
});
