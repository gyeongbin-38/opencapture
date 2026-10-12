import {
    type BoardAlign,
    type BoardDistribute,
    type BoardLayout,
    alignNodes,
    boundsOf,
    distributeNodes,
    layoutNodes,
    resizeNodes,
    snapNode,
    versionGroups,
} from "../../../lib/boardGeometry";
import type {
    BoardEditorController,
    BoardTool,
    CaptureBoardController,
    CaptureBoardOptions,
} from "../../../lib/boardPorts";
import { BoardRevisionQueue } from "../../../lib/boardRevisionQueue";
import type {
    BoardCaptureEvent,
    BoardDerivation,
    BoardDocument,
    BoardNode,
    BoardSummary,
} from "../../../lib/captureBoard";
import type { NamedBeautifyStyle } from "../../../lib/openCaptureTypes";
import { type ImageHoldHandle, createImageHold } from "../lib/imageHold";
import { requestChoice, requestText } from "../lib/textDialog";
import { createBoardEditor } from "./boardEditor";
import "./captureBoard.css";

const SAVE_DELAY = 500;
const MAX_UNDO = 50;
const WORLD_SIZE = 10_000;
const DEFAULT_STYLE: NamedBeautifyStyle = {
    id: "board-default",
    name: "Board",
    background: "#151518",
    padding: 40,
    shadow: 18,
    radius: 18,
    ratio: "free",
    align: "center",
    autoBalance: true,
};

const clone = <T>(value: T): T => structuredClone(value);
const byId = (document: BoardDocument, ids: ReadonlySet<string>) =>
    document.nodes.filter((node) => ids.has(node.id));
const imageNodes = (nodes: readonly BoardNode[]) =>
    nodes.filter((node) => node.kind === "image" && node.assetId);
const imageDimensions = (source: string) =>
    new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () =>
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () =>
            reject(new Error("원본 이미지를 불러오지 못했습니다."));
        image.src = source;
    });

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function iconButton(label: string, command: string, glyph: string) {
    const button = element("button", "board-icon-button");
    button.type = "button";
    button.dataset.boardCommand = command;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.textContent = glyph;
    return button;
}

function hash(value: string) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
}

function assignVersionGroups(document: BoardDocument) {
    for (const [areaKey, nodes] of versionGroups(document.nodes)) {
        if (nodes.length < 2) continue;
        const group =
            nodes.find((node) => node.versionGroup)?.versionGroup ??
            `version-${hash(areaKey)}`;
        for (const node of nodes) node.versionGroup = group;
    }
}

export function createCaptureBoard(
    options: CaptureBoardOptions,
): CaptureBoardController {
    const root = element("section", "capture-board");
    root.setAttribute("aria-label", "캡처 보드");
    root.tabIndex = -1;
    const header = element("header", "board-header");
    const tabScroller = element("div", "board-tabs");
    tabScroller.setAttribute("role", "tablist");
    const headerActions = element("div", "board-header-actions");
    const addBoardButton = iconButton("새 보드", "create", "+");
    const renameButton = iconButton("보드 이름 바꾸기", "rename", "Aa");
    const moreButton = iconButton("보드 도구", "more", "•••");
    headerActions.append(addBoardButton, renameButton, moreButton);
    header.append(tabScroller, headerActions);

    const toolDrawer = element("div", "board-tool-drawer");
    toolDrawer.hidden = true;
    const toolCommands: Array<[string, string, string]> = [
        ["capture", "새 캡처", "⌁"],
        ["layout-grid", "격자 정렬", "▦"],
        ["layout-horizontal", "가로 정렬", "↔"],
        ["layout-vertical", "세로 정렬", "↕"],
        ["group", "그룹", "⌘"],
        ["focus", "선택만 보기", "◎"],
        ["focus-clear", "전체 보기", "○"],
        ["fit", "화면에 맞추기", "□"],
        ["auto-add", "새 캡처 자동 추가", "＋"],
        ["undo", "실행 취소", "↶"],
        ["redo", "다시 실행", "↷"],
        ["export-png", "PNG 내보내기", "⇩"],
        ["export-pdf", "PDF 내보내기", "P"],
        ["export-portable", "편집 파일 내보내기", "◇"],
        ["import-portable", "편집 파일 가져오기", "⇧"],
    ];
    for (const [command, label, glyph] of toolCommands)
        toolDrawer.append(iconButton(label, command, glyph));

    const viewport = element("div", "board-viewport");
    viewport.tabIndex = 0;
    viewport.setAttribute("aria-label", "캡처 배치 영역");
    const stage = element("div", "board-stage");
    stage.style.width = `${WORLD_SIZE}px`;
    stage.style.height = `${WORLD_SIZE}px`;
    const imageLayer = element("div", "board-image-layer");
    const guideLayer = element("div", "board-guide-layer");
    stage.append(imageLayer, guideLayer);
    viewport.append(stage);

    const editorControls = element("div", "board-editor-controls");
    editorControls.dataset.boardEditorControls = "";
    const contextToolbar = element("div", "board-context-toolbar");
    contextToolbar.dataset.boardSelectionActions = "";
    contextToolbar.hidden = true;
    const selectionLabel = element("span", "board-selection-label");
    contextToolbar.append(selectionLabel);

    const empty = element("div", "board-empty");
    const emptyTitle = element("strong", "", "캡처를 한곳에 모아보세요");
    const emptyText = element(
        "span",
        "",
        "새 캡처가 현재 보드에 자동으로 추가됩니다.",
    );
    const emptyCapture = element("button", "board-primary-button", "캡처하기");
    emptyCapture.type = "button";
    emptyCapture.dataset.boardCommand = "capture";
    empty.append(emptyTitle, emptyText, emptyCapture);
    root.append(
        header,
        toolDrawer,
        viewport,
        editorControls,
        contextToolbar,
        empty,
    );

    let summaries: BoardSummary[] = [];
    let current: BoardDocument | null = null;
    let selection = new Set<string>();
    let editor: BoardEditorController | null = null;
    let destroyed = false;
    let renderGeneration = 0;
    let mutationGeneration = 0;
    let persistedGeneration = 0;
    let enqueuedGeneration = 0;
    let saveTimer = 0;
    let renderFrame = 0;
    const revisionQueue = new BoardRevisionQueue<BoardDocument>();
    let saveChain = Promise.resolve();
    let saveFailure: unknown = null;
    let savesInFlight = 0;
    let mergeInFlight = 0;
    let transitionInFlight = 0;
    let externalInFlight = 0;
    let externalChain = Promise.resolve();
    const undoStack: BoardDocument[] = [];
    const redoStack: BoardDocument[] = [];
    const previewCache = new Map<string, string>();
    const imageElements = new Map<string, HTMLElement>();
    const holdHandles = new Map<string, ImageHoldHandle>();
    const busyNodeIds = new Set<string>();
    const captureChains = new Map<string, Promise<void>>();
    let gesture: {
        mode: "move" | "resize";
        pointerId: number;
        startX: number;
        startY: number;
        snapshot: BoardDocument;
        ids: Set<string>;
        nodeId: string;
        handle?: string;
        started: boolean;
    } | null = null;

    const activeNodes = () => (current ? byId(current, selection) : []);
    const screenToWorld = (point: { x: number; y: number }) => {
        const rect = stage.getBoundingClientRect();
        const zoom = current?.viewport.zoom ?? 1;
        return {
            x: (point.x - rect.left) / zoom,
            y: (point.y - rect.top) / zoom,
        };
    };
    const syncTransform = () => {
        const view = current?.viewport ?? { x: 0, y: 0, zoom: 1 };
        stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    };

    const pushUndo = () => {
        if (!current) return;
        undoStack.push(clone(current));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
    };
    const scheduleAutosave = (delay = SAVE_DELAY) => {
        if (mergeInFlight > 0 || transitionInFlight > 0 || destroyed) return;
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void enqueueSave(), delay);
    };
    const dirty = () => {
        mutationGeneration += 1;
        scheduleAutosave();
        options.changed?.();
    };
    const mutate = (
        change: (document: BoardDocument) => void,
        _label = "보드 편집",
        recordUndo = true,
    ) => {
        if (!current) return;
        if (transitionInFlight > 0) {
            options.announce("보드를 전환하는 중입니다.");
            return;
        }
        if (recordUndo) pushUndo();
        change(current);
        current.updatedAt = new Date().toISOString();
        dirty();
        render();
    };

    const enqueueSave = () => {
        if (
            !current ||
            mergeInFlight > 0 ||
            enqueuedGeneration >= mutationGeneration
        )
            return saveChain;
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = 0;
        const boardId = current.id;
        const targetGeneration = mutationGeneration;
        enqueuedGeneration = targetGeneration;
        const snapshot = clone(current);
        savesInFlight += 1;
        const operation = saveChain
            .catch(() => undefined)
            .then(async () => {
                if (destroyed) return;
                try {
                    const saved = await revisionQueue.enqueue(
                        snapshot,
                        (document, expectedRevision) =>
                            options.api.save(document, expectedRevision),
                    );
                    saveFailure = null;
                    if (current?.id === boardId) {
                        current.revision = saved.revision;
                        persistedGeneration = Math.max(
                            persistedGeneration,
                            targetGeneration,
                        );
                    }
                    const summary = summaries.find(
                        (item) => item.id === boardId,
                    );
                    if (summary) {
                        summary.revision = saved.revision;
                        summary.updatedAt = saved.updatedAt;
                        summary.nodeCount = saved.nodes.length;
                        summary.imageCount = imageNodes(saved.nodes).length;
                    }
                    renderTabs();
                } catch (error) {
                    saveFailure = error;
                    if (enqueuedGeneration === targetGeneration)
                        enqueuedGeneration = persistedGeneration;
                    options.announce(
                        error instanceof Error
                            ? error.message
                            : "보드를 저장하지 못했습니다.",
                        true,
                    );
                    throw error;
                }
            })
            .finally(() => {
                savesInFlight = Math.max(0, savesInFlight - 1);
            });
        saveChain = operation.catch(() => undefined);
        return operation;
    };

    const flushSaves = async () => {
        while (true) {
            if (saveTimer) window.clearTimeout(saveTimer);
            saveTimer = 0;
            if (enqueuedGeneration < mutationGeneration) await enqueueSave();
            const pending = saveChain;
            await pending;
            if (saveFailure) throw saveFailure;
            if (
                pending === saveChain &&
                persistedGeneration >= mutationGeneration &&
                savesInFlight === 0
            )
                return;
        }
    };

    const scheduleExternal = <T>(operation: () => Promise<T>) => {
        externalInFlight += 1;
        const task = externalChain
            .catch(() => undefined)
            .then(operation)
            .finally(() => {
                externalInFlight = Math.max(0, externalInFlight - 1);
            });
        externalChain = task.then(
            () => undefined,
            () => undefined,
        );
        return task;
    };

    const flush = async () => {
        while (true) {
            const external = externalChain;
            await external;
            await flushSaves();
            if (
                external === externalChain &&
                externalInFlight === 0 &&
                persistedGeneration >= mutationGeneration &&
                savesInFlight === 0
            )
                return;
        }
    };

    function cancelActiveGesture() {
        for (const hold of holdHandles.values()) hold.cancel("manual");
        if (!gesture) return;
        const active = gesture;
        for (const target of root.querySelectorAll<HTMLElement>(
            "[data-image-hold], .board-resize-handle",
        )) {
            if (target.hasPointerCapture(active.pointerId))
                target.releasePointerCapture(active.pointerId);
        }
        if (active.started && current?.id === active.snapshot.id) {
            const original = new Map(
                active.snapshot.nodes
                    .filter((node) => active.ids.has(node.id))
                    .map((node) => [node.id, node]),
            );
            current.nodes = current.nodes.map(
                (node) => original.get(node.id) ?? node,
            );
            const undoIndex = undoStack.lastIndexOf(active.snapshot);
            if (undoIndex >= 0) undoStack.splice(undoIndex, 1);
        }
        gesture = null;
        guideLayer.replaceChildren();
        render();
    }

    const setTransitioning = (active: boolean) => {
        if (active && transitionInFlight === 0) cancelActiveGesture();
        transitionInFlight += active ? 1 : -1;
        transitionInFlight = Math.max(0, transitionInFlight);
        if (active && transitionInFlight === 1)
            options.announce("보드를 전환하는 중입니다.");
        root.classList.toggle("is-transitioning", transitionInFlight > 0);
        root.setAttribute("aria-busy", String(transitionInFlight > 0));
        viewport.inert = transitionInFlight > 0;
    };

    const renderTabs = () => {
        tabScroller.replaceChildren();
        for (const summary of summaries) {
            const tab = element(
                "button",
                "board-tab",
                current?.id === summary.id ? current.name : summary.name,
            );
            tab.type = "button";
            tab.dataset.boardId = summary.id;
            tab.setAttribute("role", "tab");
            tab.setAttribute(
                "aria-selected",
                String(current?.id === summary.id),
            );
            if (current?.id === summary.id) tab.classList.add("is-active");
            tab.addEventListener("click", () => void open(summary.id));
            tabScroller.append(tab);
        }
    };

    const selectedVisible = (node: BoardNode) =>
        node.visible &&
        (!current?.settings.focusIds.length ||
            current.settings.focusIds.includes(node.id));

    const renderGuides = (
        guides: ReturnType<typeof snapNode>["guides"] = [],
    ) => {
        guideLayer.replaceChildren();
        for (const guide of guides) {
            const line = element("span", `board-snap-guide is-${guide.axis}`);
            if (guide.axis === "x") {
                line.style.left = `${guide.value}px`;
                line.style.top = `${guide.from}px`;
                line.style.height = `${guide.to - guide.from}px`;
            } else {
                line.style.top = `${guide.value}px`;
                line.style.left = `${guide.from}px`;
                line.style.width = `${guide.to - guide.from}px`;
            }
            guideLayer.append(line);
        }
    };

    const updateImageFrames = () => {
        if (!current) return;
        for (const node of imageNodes(current.nodes)) {
            const card = imageElements.get(node.id);
            if (!card) continue;
            card.style.left = `${node.x}px`;
            card.style.top = `${node.y}px`;
            card.style.width = `${node.width}px`;
            card.style.height = `${node.height}px`;
            card.style.transform = `rotate(${node.rotation}deg)`;
            card.style.zIndex = String(
                Math.max(
                    1,
                    current.nodes.findIndex((item) => item.id === node.id) + 1,
                ),
            );
        }
    };

    const beginGesture = (
        event: PointerEvent,
        nodeId: string,
        mode: "move" | "resize",
        handle?: string,
    ) => {
        if (
            !current ||
            transitionInFlight > 0 ||
            editor?.getTool() !== "select"
        )
            return;
        const node = current.nodes.find((item) => item.id === nodeId);
        if (!node || node.locked) return;
        if (!selection.has(nodeId)) {
            selection = new Set(
                node.groupId
                    ? current.nodes
                          .filter((item) => item.groupId === node.groupId)
                          .map((item) => item.id)
                    : [nodeId],
            );
            for (const [id, card] of imageElements)
                card.classList.toggle("is-selected", selection.has(id));
            renderContextToolbar();
            editor?.setSelection([...selection]);
        }
        gesture = {
            mode,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            snapshot: clone(current),
            ids: new Set(selection),
            nodeId,
            handle,
            started: false,
        };
    };

    const applyGesture = (event: PointerEvent) => {
        if (!gesture || !current || event.pointerId !== gesture.pointerId)
            return;
        const zoom = current.viewport.zoom || 1;
        const dx = (event.clientX - gesture.startX) / zoom;
        const dy = (event.clientY - gesture.startY) / zoom;
        if (!gesture.started) {
            gesture.started = true;
            undoStack.push(gesture.snapshot);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack.length = 0;
        }
        const sourceNodes = byId(gesture.snapshot, gesture.ids);
        if (gesture.mode === "move") {
            const updated = sourceNodes.map((node) => ({
                ...node,
                x: node.x + dx,
                y: node.y + dy,
            }));
            const primary = updated.find((node) => node.id === gesture?.nodeId);
            let guides: ReturnType<typeof snapNode>["guides"] = [];
            if (primary && sourceNodes.length === 1) {
                const snapped = snapNode(
                    primary,
                    current.nodes.filter((node) => !gesture?.ids.has(node.id)),
                    8 / zoom,
                    event.altKey,
                );
                updated[0] = snapped.node;
                guides = snapped.guides;
            }
            for (const updatedNode of updated) {
                const index = current.nodes.findIndex(
                    (node) => node.id === updatedNode.id,
                );
                if (index >= 0) current.nodes[index] = updatedNode;
            }
            renderGuides(guides);
        } else {
            const startBounds = boundsOf(sourceNodes);
            const minimum = 24;
            const next = { ...startBounds };
            if (gesture.handle?.includes("e"))
                next.width = Math.max(minimum, startBounds.width + dx);
            if (gesture.handle?.includes("s"))
                next.height = Math.max(minimum, startBounds.height + dy);
            if (gesture.handle?.includes("w")) {
                next.x = Math.min(
                    startBounds.x + startBounds.width - minimum,
                    startBounds.x + dx,
                );
                next.width = startBounds.width + startBounds.x - next.x;
            }
            if (gesture.handle?.includes("n")) {
                next.y = Math.min(
                    startBounds.y + startBounds.height - minimum,
                    startBounds.y + dy,
                );
                next.height = startBounds.height + startBounds.y - next.y;
            }
            const preserveAspect =
                sourceNodes.length === 1 && sourceNodes[0]?.kind === "image"
                    ? !event.shiftKey
                    : event.shiftKey;
            if (preserveAspect) {
                const ratio =
                    startBounds.width / Math.max(1, startBounds.height);
                if (Math.abs(dx) > Math.abs(dy))
                    next.height = next.width / ratio;
                else next.width = next.height * ratio;
            }
            for (const updatedNode of resizeNodes(
                sourceNodes,
                startBounds,
                next,
            )) {
                const index = current.nodes.findIndex(
                    (node) => node.id === updatedNode.id,
                );
                if (index >= 0) current.nodes[index] = updatedNode;
            }
        }
        updateImageFrames();
        editor?.render();
    };

    const endGesture = (event: PointerEvent) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        renderGuides();
        if (gesture.started) {
            dirty();
            render();
        }
        gesture = null;
    };

    const applyDerivation = (
        boardId: string,
        derivation: BoardDerivation,
        expected: Map<string, string>,
        label: string,
    ) => {
        if (transitionInFlight > 0 || !current || current.id !== boardId)
            return {
                applied: false,
                staleAssetIds: derivation.nodes.map((node) => node.assetId),
            };
        const applicable = derivation.nodes.filter((result) => {
            const node = current?.nodes.find(
                (item) => item.id === result.nodeId,
            );
            return (
                node?.assetId === expected.get(result.nodeId) &&
                result.sourceAssetId === expected.get(result.nodeId)
            );
        });
        const applicableIds = new Set(
            applicable.map((result) => result.assetId),
        );
        const staleAssetIds = derivation.nodes
            .filter((result) => !applicableIds.has(result.assetId))
            .map((result) => result.assetId);
        if (!applicable.length) return { applied: false, staleAssetIds };
        mutate((document) => {
            for (const result of applicable) {
                const node = document.nodes.find(
                    (item) => item.id === result.nodeId,
                );
                if (!node || node.assetId !== result.sourceAssetId) continue;
                node.originalAssetId ??= node.assetId;
                node.assetId = result.assetId;
                const centerX = node.x + node.width / 2;
                const centerY = node.y + node.height / 2;
                const ratio = result.width / Math.max(1, result.height);
                let width = node.width;
                let height = width / ratio;
                if (height > node.height * 1.5) {
                    height = node.height;
                    width = height * ratio;
                }
                node.width = width;
                node.height = height;
                node.x = centerX - width / 2;
                node.y = centerY - height / 2;
            }
        }, label);
        return { applied: true, staleAssetIds };
    };

    const cutoutNode = async (nodeId: string, handle?: ImageHoldHandle) => {
        const document = current;
        const node = document?.nodes.find((item) => item.id === nodeId);
        if (!document || !node?.assetId) return;
        const boardId = document.id;
        const sourceAssetId = node.assetId;
        busyNodeIds.add(nodeId);
        handle?.setBusy(true);
        try {
            const derivation = await options.api.cutout(
                boardId,
                nodeId,
                sourceAssetId,
            );
            const application = applyDerivation(
                boardId,
                derivation,
                new Map([[nodeId, sourceAssetId]]),
                "배경 제거",
            );
            if (application.staleAssetIds.length)
                await options.api.discardDerived(
                    boardId,
                    application.staleAssetIds,
                );
            if (application.applied) options.announce("배경을 제거했습니다.");
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : "배경을 제거하지 못했습니다.",
                true,
            );
        } finally {
            busyNodeIds.delete(nodeId);
            holdHandles.get(nodeId)?.setBusy(false);
            handle?.setBusy(false);
        }
    };

    const installImageInteraction = (
        card: HTMLElement,
        holdTarget: HTMLElement,
        node: BoardNode,
    ) => {
        const holdRef: { current?: ImageHoldHandle } = {};
        const hold = createImageHold(holdTarget, {
            disabled: () => editor?.getTool() !== "select" || node.locked,
            progressLabel: "길게 눌러 배경 제거",
            onHold: () => cutoutNode(node.id, holdRef.current),
            onDragStart: ({ event }) => beginGesture(event, node.id, "move"),
        });
        holdRef.current = hold;
        if (busyNodeIds.has(node.id)) hold.setBusy(true);
        holdHandles.set(node.id, hold);
        card.addEventListener("pointermove", applyGesture);
        card.addEventListener("pointerup", endGesture);
        card.addEventListener("pointercancel", endGesture);
        card.addEventListener("click", (event) => {
            if (gesture) return;
            const next = new Set(
                event.shiftKey || event.ctrlKey ? selection : [],
            );
            if (next.has(node.id)) next.delete(node.id);
            else {
                next.add(node.id);
                if (node.groupId && !event.shiftKey && !event.ctrlKey)
                    for (const item of current?.nodes ?? [])
                        if (item.groupId === node.groupId) next.add(item.id);
            }
            selection = next;
            render();
        });
        card.addEventListener("dblclick", () => editor?.setTool("select"));
        card.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            selection = new Set([node.id]);
            renderContextToolbar();
        });
    };

    const renderImages = () => {
        for (const handle of holdHandles.values()) handle.dispose();
        holdHandles.clear();
        imageElements.clear();
        imageLayer.replaceChildren();
        if (!current) return;
        const nodes = imageNodes(current.nodes).filter(selectedVisible);
        const zoom = current.viewport.zoom || 1;
        const view = {
            x: (viewport.scrollLeft - current.viewport.x) / zoom,
            y: (viewport.scrollTop - current.viewport.y) / zoom,
            width: viewport.clientWidth / zoom,
            height: viewport.clientHeight / zoom,
        };
        const inView = nodes.filter(
            (node) =>
                node.x + node.width >= view.x &&
                node.y + node.height >= view.y &&
                node.x <= view.x + view.width &&
                node.y <= view.y + view.height,
        );
        const visible = (inView.length ? inView : nodes).slice(0, 12);
        const generation = ++renderGeneration;
        for (const node of nodes) {
            const card = element("article", "board-image");
            card.dataset.nodeId = node.id;
            card.tabIndex = 0;
            card.setAttribute("aria-label", node.name ?? "캡처 이미지");
            card.classList.toggle("is-selected", selection.has(node.id));
            card.style.left = `${node.x}px`;
            card.style.top = `${node.y}px`;
            card.style.width = `${node.width}px`;
            card.style.height = `${node.height}px`;
            card.style.transform = `rotate(${node.rotation}deg)`;
            card.style.zIndex = String(
                Math.max(
                    1,
                    current.nodes.findIndex((item) => item.id === node.id) + 1,
                ),
            );
            if (!visible.includes(node))
                card.classList.add("is-preview-deferred");
            const img = element("img");
            img.alt = node.name ?? "";
            img.draggable = false;
            const cached = node.assetId
                ? previewCache.get(node.assetId)
                : undefined;
            if (cached) img.src = cached;
            else if (node.assetId && visible.includes(node)) {
                const assetId = node.assetId;
                void options.api
                    .assetData(current.id, assetId, "preview")
                    .then((data) => {
                        if (
                            destroyed ||
                            renderGeneration !== generation ||
                            !card.isConnected
                        )
                            return;
                        previewCache.set(assetId, data);
                        if (previewCache.size > 24)
                            previewCache.delete(
                                previewCache.keys().next().value as string,
                            );
                        img.src = data;
                    })
                    .catch(() => card.classList.add("is-load-error"));
            }
            card.append(img);
            if (selection.has(node.id)) {
                for (const direction of ["nw", "ne", "sw", "se"]) {
                    const handle = element(
                        "button",
                        `board-resize-handle is-${direction}`,
                    );
                    handle.type = "button";
                    handle.dataset.noImageHold = "true";
                    handle.setAttribute("aria-label", `크기 조절 ${direction}`);
                    handle.addEventListener("pointerdown", (event) => {
                        event.stopPropagation();
                        beginGesture(event, node.id, "resize", direction);
                        handle.setPointerCapture(event.pointerId);
                    });
                    handle.addEventListener("pointermove", applyGesture);
                    handle.addEventListener("pointerup", endGesture);
                    card.append(handle);
                }
            }
            installImageInteraction(card, img, node);
            imageLayer.append(card);
            imageElements.set(node.id, card);
        }
    };

    const toolbarActions = (items: Array<[string, string, string]>) => {
        for (const [command, label, glyph] of items)
            contextToolbar.append(iconButton(label, command, glyph));
    };
    const renderContextToolbar = () => {
        contextToolbar.replaceChildren(selectionLabel);
        const nodes = activeNodes();
        contextToolbar.hidden = nodes.length === 0;
        if (!nodes.length) return;
        selectionLabel.textContent = `${nodes.length}개 선택`;
        if (imageNodes(nodes).length === nodes.length) {
            toolbarActions([
                ["cutout", "배경 제거", "✦"],
                ["beautify", "같은 스타일 적용", "◇"],
                ["compare-versions", "버전 비교", "◐"],
                ["focus", "선택만 보기", "◎"],
            ]);
            if (
                imageNodes(nodes).some(
                    (node) =>
                        node.originalAssetId &&
                        node.assetId !== node.originalAssetId,
                )
            )
                toolbarActions([["restore-original", "원본 복원", "↺"]]);
        }
        toolbarActions([
            ["group", "그룹", "⌘"],
            ["delete", "삭제", "×"],
        ]);
    };

    const render = () => {
        syncTransform();
        renderTabs();
        renderImages();
        renderContextToolbar();
        empty.hidden = Boolean(current?.nodes.length);
        editor?.setSelection([...selection]);
        editor?.render();
    };

    editor = createBoardEditor({
        surface: viewport,
        stage,
        controls: editorControls,
        getDocument: () => current,
        getSelection: () => [...selection],
        select(ids) {
            selection = new Set(ids);
            if (current) {
                const groups = new Set(
                    current.nodes
                        .filter(
                            (node) => selection.has(node.id) && node.groupId,
                        )
                        .map((node) => node.groupId as string),
                );
                for (const node of current.nodes)
                    if (node.groupId && groups.has(node.groupId))
                        selection.add(node.id);
            }
            render();
        },
        mutate,
        getViewport: () => current?.viewport ?? { x: 0, y: 0, zoom: 1 },
        screenToWorld,
        assetData: (assetId, quality) => {
            if (!current)
                return Promise.reject(new Error("열린 보드가 없습니다."));
            return options.api.assetData(current.id, assetId, quality);
        },
        announce: options.announce,
    });
    stage.append(editor.root);

    const adopt = async (document: BoardDocument) => {
        current = clone(document);
        revisionQueue.reset(document.revision);
        mutationGeneration = 0;
        persistedGeneration = 0;
        enqueuedGeneration = 0;
        saveFailure = null;
        selection.clear();
        undoStack.length = 0;
        redoStack.length = 0;
        render();
        await options.api.setActive(document.id);
    };

    async function performOpen(id?: string) {
        const target =
            id ??
            summaries.find((summary) => summary.active)?.id ??
            summaries[0]?.id;
        if (current && current.id === target) return;
        setTransitioning(true);
        try {
            await flushSaves();
            if (!target) {
                const created = await options.api.create("새 보드");
                summaries = await options.api.list();
                await adopt(created);
                return;
            }
            await adopt(await options.api.load(target));
        } finally {
            setTransitioning(false);
        }
    }

    function open(id?: string) {
        return scheduleExternal(() => performOpen(id));
    }

    async function performCreateBoard() {
        setTransitioning(true);
        try {
            await flushSaves();
            const number = summaries.length + 1;
            const created = await options.api.create(`보드 ${number}`);
            summaries = await options.api.list();
            await adopt(created);
        } finally {
            setTransitioning(false);
        }
    }

    function createBoard() {
        return scheduleExternal(performCreateBoard);
    }

    async function performAddItems(ids: string[]) {
        if (!current || ids.length === 0) return;
        await flushSaves();
        if (!current) return;
        const boardId = current.id;
        const unique = ids.filter(
            (id) =>
                !current?.nodes.some(
                    (node) =>
                        node.captureItemId === id || node.source?.itemId === id,
                ),
        );
        if (!unique.length) return;
        const baseNodeIds = new Set(current.nodes.map((node) => node.id));
        mergeInFlight += 1;
        try {
            const added = await options.api.addItems(
                boardId,
                unique,
                revisionQueue.revision(),
            );
            if (!current || current.id !== boardId) return;
            const live = current;
            const liveNodeIds = new Set(live.nodes.map((node) => node.id));
            const addedNodes = added.nodes.filter(
                (node) =>
                    !baseNodeIds.has(node.id) && !liveNodeIds.has(node.id),
            );
            const previousImages = imageNodes(live.nodes);
            pushUndo();
            current = {
                ...live,
                revision: added.revision,
                updatedAt: new Date().toISOString(),
                nodes: [...live.nodes, ...addedNodes],
            };
            revisionQueue.reset(added.revision);
            saveFailure = null;
            const addedImages = imageNodes(addedNodes);
            if (previousImages.length === 0) {
                const allImages = imageNodes(current.nodes);
                const arranged =
                    allImages.length > 1
                        ? layoutNodes(allImages, "grid", 24)
                        : allImages;
                const map = new Map(arranged.map((node) => [node.id, node]));
                current.nodes = current.nodes.map(
                    (node) => map.get(node.id) ?? node,
                );
                fitViewport(current, arranged);
            } else if (addedImages.length) {
                const bounds = boundsOf(previousImages);
                let y = bounds.y;
                for (const node of addedImages) {
                    node.x = bounds.x + bounds.width + 48;
                    node.y = y;
                    y += node.height + 24;
                }
            }
            assignVersionGroups(current);
            dirty();
            render();
            const summary = summaries.find((item) => item.id === boardId);
            if (summary) {
                summary.revision = added.revision;
                summary.updatedAt = current.updatedAt;
                summary.nodeCount = current.nodes.length;
                summary.imageCount = imageNodes(current.nodes).length;
            }
            const arrivalId = addedImages[0]?.id;
            if (arrivalId && previousImages.length)
                requestAnimationFrame(() =>
                    imageElements
                        .get(arrivalId)
                        ?.scrollIntoView({ block: "center", inline: "center" }),
                );
        } finally {
            mergeInFlight = Math.max(0, mergeInFlight - 1);
            if (mutationGeneration > enqueuedGeneration) scheduleAutosave(0);
        }
    }

    function addItems(ids: string[]) {
        return scheduleExternal(() => performAddItems(ids));
    }

    const addCaptureToTarget = (event: BoardCaptureEvent) => {
        const previous =
            captureChains.get(event.targetBoardId) ?? Promise.resolve();
        const task = previous
            .then(async () => {
                if (destroyed) return;
                if (current?.id === event.targetBoardId) {
                    await addItems([event.itemId]);
                } else {
                    let document = await options.api.load(event.targetBoardId);
                    if (
                        !document.nodes.some(
                            (node) =>
                                node.captureItemId === event.itemId ||
                                node.source?.itemId === event.itemId,
                        )
                    ) {
                        document = await options.api.addItems(
                            document.id,
                            [event.itemId],
                            document.revision,
                        );
                        assignVersionGroups(document);
                        document = await options.api.save(
                            document,
                            document.revision,
                        );
                        const summary = summaries.find(
                            (item) => item.id === document.id,
                        );
                        if (summary)
                            Object.assign(summary, {
                                revision: document.revision,
                                updatedAt: document.updatedAt,
                                nodeCount: document.nodes.length,
                                imageCount: imageNodes(document.nodes).length,
                            });
                        renderTabs();
                    }
                }
                await options.api.ackCapture(event.itemId, event.targetBoardId);
            })
            .catch((error) =>
                options.announce(
                    error instanceof Error
                        ? error.message
                        : "캡처를 보드에 추가하지 못했습니다.",
                    true,
                ),
            );
        captureChains.set(event.targetBoardId, task);
    };

    const replaceNodes = (updated: BoardNode[], label: string) =>
        mutate((document) => {
            const map = new Map(updated.map((node) => [node.id, node]));
            document.nodes = document.nodes.map(
                (node) => map.get(node.id) ?? node,
            );
        }, label);

    const fitViewport = (
        document: BoardDocument,
        nodes: readonly BoardNode[],
    ) => {
        if (!nodes.length) return;
        const bounds = boundsOf(nodes);
        const width = Math.max(360, viewport.clientWidth || 1000);
        const height = Math.max(280, viewport.clientHeight || 700);
        const zoom = Math.min(
            1.25,
            Math.max(
                0.2,
                Math.min(
                    (width - 80) / Math.max(1, bounds.width),
                    (height - 80) / Math.max(1, bounds.height),
                ),
            ),
        );
        document.viewport = {
            zoom,
            x: 40 - bounds.x * zoom,
            y: 40 - bounds.y * zoom,
        };
        viewport.scrollTo({ left: 0, top: 0 });
    };

    const doLayout = (layout: BoardLayout) => {
        const selected = activeNodes();
        const nodes = selected.length
            ? selected
            : (current?.nodes.filter(selectedVisible) ?? []);
        if (nodes.length < 2) return;
        const updated = layoutNodes(nodes, layout);
        mutate((document) => {
            const map = new Map(updated.map((node) => [node.id, node]));
            document.nodes = document.nodes.map(
                (node) => map.get(node.id) ?? node,
            );
            fitViewport(document, updated);
        }, "자동 배치");
    };
    const doAlign = (alignment: BoardAlign) => {
        const nodes = activeNodes();
        if (nodes.length < 2) return;
        replaceNodes(alignNodes(nodes, alignment), "정렬");
    };
    const doDistribute = (axis: BoardDistribute) => {
        const nodes = activeNodes();
        if (nodes.length < 3) return;
        replaceNodes(distributeNodes(nodes, axis), "간격 맞추기");
    };

    const beautify = async () => {
        const document = current;
        const nodes = imageNodes(activeNodes());
        if (!document || !nodes.length) return;
        let style = DEFAULT_STYLE;
        try {
            const saved = (await options.loadBeautifyStyles?.()) ?? [];
            const styles = [
                DEFAULT_STYLE,
                ...saved.filter((item) => item.id !== DEFAULT_STYLE.id),
            ];
            if (styles.length > 1) {
                const selected = await requestChoice({
                    title: "적용할 스타일",
                    value: DEFAULT_STYLE.id,
                    choices: styles.map((item) => ({
                        value: item.id,
                        label: item.name,
                    })),
                });
                if (!selected) return;
                style =
                    styles.find((item) => item.id === selected) ??
                    DEFAULT_STYLE;
            }
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : "스타일을 불러오지 못했습니다.",
                true,
            );
            return;
        }
        if (current?.id !== document.id) return;
        const expected = new Map(
            nodes.flatMap((node) =>
                node.assetId ? [[node.id, node.assetId] as const] : [],
            ),
        );
        try {
            const result = await options.api.beautify(
                document.id,
                nodes.flatMap((node) =>
                    node.assetId
                        ? [{ nodeId: node.id, sourceAssetId: node.assetId }]
                        : [],
                ),
                style,
            );
            const application = applyDerivation(
                document.id,
                result,
                expected,
                "일괄 꾸미기",
            );
            if (application.staleAssetIds.length)
                await options.api.discardDerived(
                    document.id,
                    application.staleAssetIds,
                );
            if (application.applied)
                options.announce("선택한 캡처에 같은 스타일을 적용했습니다.");
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : "스타일을 적용하지 못했습니다.",
                true,
            );
        }
    };

    const undo = () => {
        if (transitionInFlight > 0) {
            options.announce("보드를 전환하는 중입니다.");
            return;
        }
        if (!current || !undoStack.length) return;
        redoStack.push(clone(current));
        current = undoStack.pop() ?? current;
        dirty();
        render();
    };
    const redo = () => {
        if (transitionInFlight > 0) {
            options.announce("보드를 전환하는 중입니다.");
            return;
        }
        if (!current || !redoStack.length) return;
        undoStack.push(clone(current));
        current = redoStack.pop() ?? current;
        dirty();
        render();
    };

    const exportBoard = async (format: "png" | "pdf") => {
        if (!current || !editor) return;
        await flush();
        const dataURL = await editor.exportRaster({
            selectionOnly: current.settings.focusIds.length > 0,
        });
        const result = await options.api.exportFile(
            current.id,
            format,
            dataURL,
        );
        options.announce(
            result.saved
                ? `${format.toUpperCase()}로 저장했습니다.`
                : "내보내기를 취소했습니다.",
        );
    };

    async function command(id: string): Promise<unknown> {
        if (transitionInFlight > 0) {
            options.announce("보드를 전환하는 중입니다.");
            return;
        }
        if (id.startsWith("tool:")) {
            editor?.setTool(id.slice(5) as BoardTool);
            return;
        }
        if (id === "create") return createBoard();
        if (id === "rename" && current) {
            const boardId = current.id;
            const name = (
                await requestText({
                    title: "보드 이름",
                    value: current.name,
                    maxLength: 80,
                })
            )?.trim();
            if (current?.id !== boardId) return;
            if (name) {
                mutate((document) => {
                    document.name = name.slice(0, 80);
                }, "이름 변경");
                const summary = summaries.find(
                    (item) => item.id === current?.id,
                );
                if (summary) summary.name = name.slice(0, 80);
                renderTabs();
            }
            return;
        }
        if (id === "capture") return options.capture?.();
        if (id.startsWith("preset:") && current) {
            const preset = id.slice(7);
            if (preset !== "design" && preset !== "bug" && preset !== "study")
                return;
            mutate((document) => {
                document.settings.preset = preset;
            }, "작업 프리셋");
            editor?.setTool(
                preset === "bug"
                    ? "arrow"
                    : preset === "study"
                      ? "note"
                      : "select",
            );
            options.announce(
                preset === "bug"
                    ? "버그 보고 도구를 준비했습니다."
                    : preset === "study"
                      ? "공부 메모 도구를 준비했습니다."
                      : "디자인 검토 도구를 준비했습니다.",
            );
            return;
        }
        if (id === "more") {
            toolDrawer.hidden = !toolDrawer.hidden;
            moreButton.setAttribute(
                "aria-expanded",
                String(!toolDrawer.hidden),
            );
            return;
        }
        if (id === "layout-horizontal") return doLayout("horizontal");
        if (id === "layout-vertical") return doLayout("vertical");
        if (id === "layout-grid") return doLayout("grid");
        if (id.startsWith("align-")) return doAlign(id.slice(6) as BoardAlign);
        if (id.startsWith("distribute-"))
            return doDistribute(id.slice(11) as BoardDistribute);
        if (id === "group") {
            if (selection.size < 2) return;
            const groupId = crypto.randomUUID();
            mutate((document) => {
                for (const node of document.nodes)
                    if (selection.has(node.id)) node.groupId = groupId;
            }, "그룹 만들기");
            return;
        }
        if (id === "ungroup") {
            mutate((document) => {
                for (const node of document.nodes)
                    if (selection.has(node.id)) node.groupId = undefined;
            }, "그룹 해제");
            return;
        }
        if (id === "focus" && current) {
            mutate((document) => {
                document.settings.focusIds = [...selection];
            }, "집중 보기");
            return;
        }
        if (id === "focus-clear" && current) {
            mutate((document) => {
                document.settings.focusIds = [];
            }, "전체 보기");
            return;
        }
        if (id === "fit" && current) {
            const nodes = activeNodes().length
                ? activeNodes()
                : current.nodes.filter(selectedVisible);
            mutate((document) => fitViewport(document, nodes), "화면 맞춤");
            return;
        }
        if (id === "auto-add" && current) {
            mutate((document) => {
                document.settings.autoAdd = !document.settings.autoAdd;
            }, "자동 추가 설정");
            options.announce(
                current.settings.autoAdd
                    ? "새 캡처를 이 보드에 자동으로 추가합니다."
                    : "새 캡처 자동 추가를 껐습니다.",
            );
            return;
        }
        if (id === "cutout") {
            for (const node of imageNodes(activeNodes()))
                await cutoutNode(node.id);
            return;
        }
        if (id === "beautify") return beautify();
        if (id === "restore-original") {
            const board = current;
            if (!board) return;
            const targets = imageNodes(activeNodes()).flatMap((node) =>
                node.originalAssetId && node.assetId !== node.originalAssetId
                    ? [
                          {
                              nodeId: node.id,
                              derivedAssetId: node.assetId as string,
                              originalAssetId: node.originalAssetId,
                          },
                      ]
                    : [],
            );
            try {
                const prepared = [] as Array<
                    (typeof targets)[number] & { width: number; height: number }
                >;
                for (const target of targets) {
                    const data = await options.api.assetData(
                        board.id,
                        target.originalAssetId,
                        "preview",
                    );
                    prepared.push({
                        ...target,
                        ...(await imageDimensions(data)),
                    });
                }
                if (current?.id !== board.id) return;
                mutate((document) => {
                    for (const restored of prepared) {
                        const node = document.nodes.find(
                            (item) => item.id === restored.nodeId,
                        );
                        if (!node || node.assetId !== restored.derivedAssetId)
                            continue;
                        const centerX = node.x + node.width / 2;
                        const centerY = node.y + node.height / 2;
                        const ratio = restored.width / restored.height;
                        const area = Math.max(1, node.width * node.height);
                        node.width = Math.sqrt(area * ratio);
                        node.height = node.width / ratio;
                        node.x = centerX - node.width / 2;
                        node.y = centerY - node.height / 2;
                        node.assetId = restored.originalAssetId;
                    }
                }, "원본 복원");
                options.announce("원본 이미지를 복원했습니다.");
            } catch (error) {
                options.announce(
                    error instanceof Error
                        ? error.message
                        : "원본 이미지를 복원하지 못했습니다.",
                    true,
                );
            }
            return;
        }
        if (id === "compare-versions") {
            const selected = imageNodes(activeNodes());
            const group = selected[0]?.versionGroup;
            const candidates =
                group && current
                    ? imageNodes(current.nodes).filter(
                          (node) => node.versionGroup === group,
                      )
                    : selected;
            const ids = candidates.flatMap((node) =>
                node.assetId && current
                    ? [
                          `board:${encodeURIComponent(current.id)}:${encodeURIComponent(node.assetId)}`,
                      ]
                    : [],
            );
            if (ids.length >= 2) return options.compareItems?.(ids);
            options.announce("비교할 버전이 두 개 이상 필요합니다.", true);
            return;
        }
        if (id === "delete") {
            mutate((document) => {
                document.nodes = document.nodes.filter(
                    (node) => !selection.has(node.id) || node.locked,
                );
            }, "삭제");
            selection.clear();
            return;
        }
        if (id === "select-all" && current) {
            selection = new Set(
                current.nodes.filter(selectedVisible).map((node) => node.id),
            );
            render();
            return;
        }
        if (id === "undo") return undo();
        if (id === "redo") return redo();
        if (id === "export-png") return exportBoard("png");
        if (id === "export-pdf") return exportBoard("pdf");
        if (id === "export-portable" && current) {
            await flush();
            return options.api.exportPortable(current.id);
        }
        if (id === "import-portable") {
            return scheduleExternal(async () => {
                setTransitioning(true);
                try {
                    await flushSaves();
                    const imported = await options.api.importPortable();
                    if (imported) {
                        summaries = await options.api.list();
                        await adopt(imported);
                    }
                    return imported;
                } finally {
                    setTransitioning(false);
                }
            });
        }
        return editor?.command(id);
    }

    root.addEventListener("click", (event) => {
        const target =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-board-command]")
                : null;
        if (target?.closest(".board-editor__toolbar")) return;
        const id = target?.dataset.boardCommand;
        if (id) void command(id);
    });
    viewport.addEventListener("pointerdown", (event) => {
        if (
            event.target === viewport ||
            event.target === stage ||
            event.target === imageLayer
        ) {
            selection.clear();
            render();
        }
    });
    viewport.addEventListener(
        "wheel",
        (event) => {
            if (!current || !event.ctrlKey) return;
            event.preventDefault();
            const next = Math.min(
                2.5,
                Math.max(
                    0.2,
                    current.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
                ),
            );
            current.viewport.zoom = next;
            dirty();
            render();
        },
        { passive: false },
    );
    const refreshVisibleImages = () => {
        if (renderFrame) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = 0;
            renderImages();
        });
    };
    viewport.addEventListener("scroll", refreshVisibleImages, {
        passive: true,
    });
    const viewportObserver = new ResizeObserver(refreshVisibleImages);
    viewportObserver.observe(viewport);
    root.addEventListener("keydown", (event) => {
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "z"
        ) {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
        }
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a"
        ) {
            event.preventDefault();
            void command("select-all");
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "0") {
            event.preventDefault();
            void command("fit");
        }
        if (event.key === "Escape") {
            toolDrawer.hidden = true;
            if (current?.settings.focusIds.length) void command("focus-clear");
            else {
                selection.clear();
                render();
            }
        }
    });

    const removeCaptureListener =
        options.api.onCaptureAdded(addCaptureToTarget);

    const controller: CaptureBoardController & {
        hasPendingChanges(): boolean;
    } = {
        root,
        async ready() {
            summaries = await options.api.list();
            await open();
            const pending = await options.api.pendingCaptures();
            for (const event of pending) addCaptureToTarget(event);
        },
        open,
        addItems,
        flush,
        command,
        getDocument: () => current,
        getSelection: () => activeNodes(),
        hasPendingChanges: () =>
            mutationGeneration > persistedGeneration ||
            enqueuedGeneration > persistedGeneration ||
            savesInFlight > 0 ||
            externalInFlight > 0 ||
            mergeInFlight > 0 ||
            transitionInFlight > 0 ||
            saveTimer !== 0 ||
            saveFailure !== null,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            if (saveTimer) window.clearTimeout(saveTimer);
            if (renderFrame) cancelAnimationFrame(renderFrame);
            viewportObserver.disconnect();
            removeCaptureListener();
            for (const hold of holdHandles.values()) hold.dispose();
            editor?.destroy();
            root.remove();
        },
    };
    return controller;
}
