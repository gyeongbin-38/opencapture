import {
    alignBoardNodes,
    applyBoardStyle,
    boardExportPlan,
    defaultBoardStyle,
    distributeBoardNodes,
    isAnnotationNode,
    renumberBoardSteps,
    resolvedNodePoints,
    setBoardVertex,
    toggleChecklistLine,
} from "../../../lib/boardAnnotations";
import type {
    BoardEditorController,
    BoardEditorOptions,
    BoardTool,
} from "../../../lib/boardPorts";
import { BOARD_LIMITS, type BoardNode } from "../../../lib/captureBoard";
import "../css/boardEditor.css";
import { lt } from "../lib/labText";
import { requestText } from "../lib/textDialog";

const svgNamespace = "http://www.w3.org/2000/svg";
const shapeTools: BoardTool[] = [
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
];

const labels: Record<BoardTool, string> = {
    select: lt("선택"),
    rect: lt("사각형"),
    ellipse: lt("원"),
    line: lt("선"),
    arrow: lt("화살표"),
    polygon: lt("다각형"),
    text: lt("텍스트"),
    note: lt("메모"),
    callout: lt("말풍선"),
    step: lt("단계"),
    magnify: lt("부분 확대"),
};

const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
};

const svg = <K extends keyof SVGElementTagNameMap>(tag: K) =>
    document.createElementNS(svgNamespace, tag);

const setAttributes = (
    element: Element,
    attributes: Record<string, string | number>,
) => {
    for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
    }
};

const id = () => crypto.randomUUID();

const createNode = (
    tool: Exclude<BoardTool, "select">,
    x: number,
    y: number,
    width: number,
    height: number,
    text?: string,
): BoardNode => {
    const node: BoardNode = {
        id: id(),
        kind: tool,
        x,
        y,
        width,
        height,
        rotation: 0,
        visible: true,
        locked: false,
        name: labels[tool],
        style: defaultBoardStyle(),
    };
    if (["line", "arrow", "callout"].includes(tool)) {
        node.points = [
            { x: 0, y: 0 },
            { x: width, y: height },
        ];
    }
    if (tool === "polygon") {
        node.points = [
            { x: width / 2, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
        ];
    }
    if (["text", "note", "callout"].includes(tool)) {
        node.text = (text ?? labels[tool]).slice(0, BOARD_LIMITS.text);
    }
    if (tool === "step") node.text = "1";
    return node;
};

const loadImage = (source: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () =>
            reject(new Error(lt("이미지를 불러오지 못했습니다.")));
        image.src = source;
    });

const canvasText = (
    context: CanvasRenderingContext2D,
    node: BoardNode,
    text: string,
    offsetX: number,
    offsetY: number,
) => {
    context.fillStyle =
        node.style.fill === "transparent" ? node.style.stroke : node.style.fill;
    context.font = `${node.style.fontSize}px system-ui, sans-serif`;
    context.textBaseline = "top";
    const lines = text.split("\n");
    lines.forEach((line, index) => {
        const checklist = node.kind === "note" && /^\[[ xX]\] /.test(line);
        const top = node.y - offsetY + 7 + index * node.style.fontSize * 1.25;
        if (checklist) {
            const size = node.style.fontSize * 0.75;
            context.strokeStyle = node.style.stroke;
            context.lineWidth = 1.5;
            context.strokeRect(node.x - offsetX + 8, top, size, size);
            if (/^\[[xX]\] /.test(line)) {
                context.beginPath();
                context.moveTo(node.x - offsetX + 10, top + size * 0.55);
                context.lineTo(node.x - offsetX + 13, top + size * 0.8);
                context.lineTo(node.x - offsetX + 19, top + size * 0.2);
                context.stroke();
            }
        }
        context.fillText(
            checklist ? line.slice(4) : line,
            node.x - offsetX + (checklist ? node.style.fontSize + 13 : 8),
            top,
            Math.max(1, node.width - 16),
        );
    });
};

export const createBoardEditor = (
    options: BoardEditorOptions,
): BoardEditorController => {
    const root = create("div", "board-editor");
    root.dataset.boardEditor = "";
    const overlay = svg("svg");
    overlay.classList.add("board-editor__overlay");
    overlay.setAttribute("aria-label", lt("보드 주석"));
    const definitions = svg("defs");
    const marker = svg("marker");
    setAttributes(marker, {
        id: "board-editor-arrow",
        markerWidth: 8,
        markerHeight: 8,
        refX: 7,
        refY: 4,
        orient: "auto",
    });
    const arrowPath = svg("path");
    arrowPath.setAttribute("d", "M0,0 L8,4 L0,8 z");
    arrowPath.setAttribute("fill", "context-stroke");
    marker.append(arrowPath);
    definitions.append(marker);
    overlay.append(definitions);
    root.append(overlay);
    options.stage.append(root);

    const toolbar = create("div", "board-editor__toolbar");
    const shapeButton = create("button", "board-editor__primary");
    shapeButton.type = "button";
    shapeButton.textContent = lt("도형");
    shapeButton.dataset.boardCommand = "shape-drawer";
    shapeButton.setAttribute("aria-expanded", "false");
    const drawer = create("div", "board-editor__drawer");
    drawer.hidden = true;
    const selectButton = create("button");
    selectButton.type = "button";
    selectButton.textContent = lt("선택");
    selectButton.dataset.boardCommand = "tool:select";
    const propertyPanel = create("details", "board-editor__properties");
    const propertySummary = create("summary");
    propertySummary.textContent = lt("속성");
    const contextBar = create("div", "board-editor__context");
    propertyPanel.append(propertySummary, contextBar);
    const layerPanel = create("details", "board-editor__layers");
    layerPanel.dataset.boardLayers = "";
    const layerSummary = create("summary");
    layerSummary.textContent = lt("레이어");
    const layerList = create("div", "board-editor__layer-list");
    layerPanel.append(layerSummary, layerList);
    toolbar.append(
        shapeButton,
        drawer,
        selectButton,
        propertyPanel,
        layerPanel,
    );
    options.controls.append(toolbar);

    let activeTool: BoardTool = "select";
    let selection = options.getSelection();
    let startPoint: { x: number; y: number } | null = null;
    let previewNode: BoardNode | null = null;
    let destroyed = false;
    type PointerSession =
        | {
              type: "move";
              pointerId: number;
              boardId: string;
              nodeIds: string[];
              origin: { x: number; y: number };
              current: { x: number; y: number };
          }
        | {
              type: "vertex";
              pointerId: number;
              boardId: string;
              nodeId: string;
              vertexIndex: number;
              current: { x: number; y: number };
          };
    let pointerSession: PointerSession | null = null;

    const setTool = (tool: BoardTool) => {
        activeTool = tool;
        drawer.hidden = true;
        shapeButton.setAttribute("aria-expanded", "false");
        overlay.classList.toggle("is-drawing", tool !== "select");
        renderControls();
    };

    const mutate = (
        change: (
            document: NonNullable<ReturnType<typeof options.getDocument>>,
        ) => void,
        label: string,
    ) => {
        options.mutate((document) => {
            change(document);
            renumberBoardSteps(document.nodes);
        }, label);
        options.changed?.();
        render();
    };

    const clearPointerPreview = (session: PointerSession) => {
        if (session.type === "move") {
            for (const nodeId of session.nodeIds) {
                root.querySelector(
                    `.board-editor__node[data-node-id="${CSS.escape(nodeId)}"] g[data-node-id]`,
                )?.removeAttribute("transform");
            }
        } else {
            render();
        }
    };

    const finishPointerSession = (commit: boolean) => {
        const session = pointerSession;
        if (!session) return;
        pointerSession = null;
        if (options.surface.hasPointerCapture(session.pointerId))
            options.surface.releasePointerCapture(session.pointerId);
        clearPointerPreview(session);
        if (!commit || options.getDocument()?.id !== session.boardId) return;
        if (session.type === "move") {
            const dx = session.current.x - session.origin.x;
            const dy = session.current.y - session.origin.y;
            if (Math.hypot(dx, dy) < 1) return;
            mutate((document) => {
                const movingIds = new Set(session.nodeIds);
                for (const candidate of document.nodes) {
                    if (movingIds.has(candidate.id) && !candidate.locked) {
                        candidate.x += dx;
                        candidate.y += dy;
                    }
                }
            }, lt("주석 이동"));
        } else {
            mutate((document) => {
                const target = document.nodes.find(
                    (candidate) => candidate.id === session.nodeId,
                );
                if (target)
                    setBoardVertex(
                        target,
                        session.vertexIndex,
                        session.current,
                    );
            }, lt("꼭짓점 이동"));
        }
    };

    const surfacePointerMove = (event: PointerEvent) => {
        const session = pointerSession;
        if (!session || event.pointerId !== session.pointerId) return;
        session.current = options.screenToWorld({
            x: event.clientX,
            y: event.clientY,
        });
        if (session.type === "move") {
            const dx = session.current.x - session.origin.x;
            const dy = session.current.y - session.origin.y;
            for (const nodeId of session.nodeIds) {
                root.querySelector(
                    `.board-editor__node[data-node-id="${CSS.escape(nodeId)}"] g[data-node-id]`,
                )?.setAttribute("transform", `translate(${dx} ${dy})`);
            }
        } else {
            const handle = root.querySelector(
                `.board-editor__node[data-node-id="${CSS.escape(session.nodeId)}"] [data-vertex-index="${session.vertexIndex}"]`,
            );
            handle?.setAttribute("cx", String(session.current.x));
            handle?.setAttribute("cy", String(session.current.y));
        }
    };
    const surfacePointerUp = (event: PointerEvent) => {
        if (pointerSession?.pointerId === event.pointerId)
            finishPointerSession(true);
    };
    const surfacePointerCancel = (event: PointerEvent) => {
        if (pointerSession?.pointerId === event.pointerId)
            finishPointerSession(false);
    };
    const surfaceLostPointerCapture = (event: PointerEvent) => {
        if (pointerSession?.pointerId === event.pointerId)
            finishPointerSession(false);
    };
    const windowBlur = () => finishPointerSession(false);
    const surfaceDoubleClick = (event: MouseEvent) => {
        if (event.button !== 0 || activeTool !== "select") return;
        const eventElement =
            event.target instanceof Element ? event.target : null;
        const pointedElement = globalThis.document.elementFromPoint(
            event.clientX,
            event.clientY,
        );
        const nodeElement =
            eventElement?.closest<HTMLElement>("[data-node-id]") ??
            pointedElement?.closest<HTMLElement>("[data-node-id]");
        const nodeId = nodeElement?.dataset.nodeId;
        if (!nodeId) return;
        const node = options
            .getDocument()
            ?.nodes.find((candidate) => candidate.id === nodeId);
        if (
            !node ||
            node.locked ||
            !["text", "note", "callout"].includes(node.kind)
        )
            return;
        event.preventDefault();
        event.stopPropagation();
        void editAnnotationText(nodeId);
    };
    options.surface.addEventListener("pointermove", surfacePointerMove);
    options.surface.addEventListener("pointerup", surfacePointerUp);
    options.surface.addEventListener("pointercancel", surfacePointerCancel);
    options.surface.addEventListener(
        "lostpointercapture",
        surfaceLostPointerCapture,
    );
    options.surface.addEventListener("dblclick", surfaceDoubleClick);
    window.addEventListener("blur", windowBlur);

    const renameNode = async (nodeId: string) => {
        const currentDocument = options.getDocument();
        const boardId = currentDocument?.id;
        const node = currentDocument?.nodes.find(
            (candidate) => candidate.id === nodeId,
        );
        if (!node) return;
        const value = await requestText({
            title: lt("레이어 이름"),
            value: node.name ?? labels[node.kind as BoardTool],
            maxLength: 80,
        });
        if (
            value === null ||
            options.getDocument()?.id !== boardId ||
            !options
                .getDocument()
                ?.nodes.some((candidate) => candidate.id === nodeId)
        )
            return;
        mutate((document) => {
            const target = document.nodes.find(
                (candidate) => candidate.id === nodeId,
            );
            if (target) target.name = value.slice(0, 80);
        }, lt("레이어 이름 변경"));
    };

    const editAnnotationText = async (nodeId: string) => {
        const currentDocument = options.getDocument();
        const boardId = currentDocument?.id;
        const node = currentDocument?.nodes.find(
            (candidate) => candidate.id === nodeId,
        );
        if (
            !node ||
            node.locked ||
            !["text", "note", "callout"].includes(node.kind)
        )
            return;
        const value = await requestText({
            title: lt("내용 편집"),
            value: node.text ?? "",
            multiline: true,
            maxLength: BOARD_LIMITS.text,
        });
        const latest = options
            .getDocument()
            ?.nodes.find((candidate) => candidate.id === nodeId);
        if (
            value === null ||
            options.getDocument()?.id !== boardId ||
            !latest ||
            latest.locked
        )
            return;
        mutate((document) => {
            const target = document.nodes.find(
                (candidate) => candidate.id === nodeId,
            );
            if (target && !target.locked)
                target.text = value.slice(0, BOARD_LIMITS.text);
        }, lt("주석 내용 변경"));
    };

    const selectedAnnotations = () => {
        const selected = new Set(selection);
        return (options.getDocument()?.nodes ?? []).filter(
            (node) => selected.has(node.id) && isAnnotationNode(node),
        );
    };

    const anchorAt = (point: { x: number; y: number }) => {
        const image = [...(options.getDocument()?.nodes ?? [])]
            .reverse()
            .find(
                (node) =>
                    node.kind === "image" &&
                    node.visible &&
                    point.x >= node.x &&
                    point.x <= node.x + node.width &&
                    point.y >= node.y &&
                    point.y <= node.y + node.height,
            );
        if (!image) return undefined;
        return {
            nodeId: image.id,
            x: (point.x - image.x) / image.width,
            y: (point.y - image.y) / image.height,
        };
    };

    const styleButton = (
        label: string,
        change: Partial<BoardNode["style"]>,
    ) => {
        const button = create("button");
        button.type = "button";
        button.textContent = label;
        button.onclick = () =>
            mutate(
                (document) => applyBoardStyle(document, selection, change),
                lt("주석 스타일 변경"),
            );
        return button;
    };

    const renderControls = () => {
        contextBar.replaceChildren();
        selectButton.classList.toggle("is-active", activeTool === "select");
        selectButton.onclick = () => setTool("select");
        propertyPanel.hidden = selectedAnnotations().length === 0;
        if (propertyPanel.hidden) propertyPanel.open = false;
        if (selectedAnnotations().length > 0) {
            const annotation = selectedAnnotations()[0];
            const controlGroup = (title: string) => {
                const group = create("section", "board-editor__control-group");
                const heading = create("span", "board-editor__control-title");
                heading.textContent = title;
                group.append(heading);
                return group;
            };
            const sizeGroup = controlGroup(lt("크기"));
            const appearanceGroup = controlGroup(lt("모양"));
            const actionGroup = controlGroup(lt("작업"));
            contextBar.append(sizeGroup, appearanceGroup, actionGroup);
            const numberControl = (
                title: string,
                value: number,
                minimum: number,
                maximum: number,
                apply: (node: BoardNode, next: number) => void,
            ) => {
                const field = create("input", "board-editor__number");
                field.type = "number";
                field.title = title;
                field.setAttribute("aria-label", title);
                field.min = String(minimum);
                field.max = String(maximum);
                field.value = String(Math.round(value));
                field.onchange = () => {
                    const next = Math.max(
                        minimum,
                        Math.min(maximum, Number(field.value)),
                    );
                    if (!Number.isFinite(next)) return;
                    mutate(
                        (document) => {
                            const target = document.nodes.find(
                                (candidate) => candidate.id === annotation.id,
                            );
                            if (target && !target.locked) apply(target, next);
                        },
                        lt(`${title} 변경`, `Change ${title}`),
                    );
                };
                const wrapper = create("label", "board-editor__field");
                const caption = create("span");
                caption.textContent = title;
                wrapper.append(caption, field);
                return wrapper;
            };
            const stroke = create("input", "board-editor__color");
            stroke.type = "color";
            stroke.title = lt("선 색상");
            stroke.setAttribute("aria-label", lt("선 색상"));
            stroke.value = /^#[0-9a-f]{6}$/i.test(annotation.style.stroke)
                ? annotation.style.stroke
                : "#7c5cff";
            stroke.onchange = () =>
                mutate(
                    (document) =>
                        applyBoardStyle(document, selection, {
                            stroke: stroke.value,
                        }),
                    lt("선 색상 변경"),
                );
            const strokeWrapper = create("label", "board-editor__field");
            const strokeCaption = create("span");
            strokeCaption.textContent = lt("색");
            strokeWrapper.append(strokeCaption, stroke);
            sizeGroup.append(
                numberControl(
                    "X",
                    annotation.x,
                    -100_000,
                    100_000,
                    (node, value) => {
                        node.x = value;
                    },
                ),
                numberControl(
                    "Y",
                    annotation.y,
                    -100_000,
                    100_000,
                    (node, value) => {
                        node.y = value;
                    },
                ),
                numberControl(
                    lt("너비"),
                    annotation.width,
                    1,
                    10_000,
                    (node, value) => {
                        const ratio = value / Math.max(1, node.width);
                        for (const point of node.points ?? []) point.x *= ratio;
                        node.width = value;
                    },
                ),
                numberControl(
                    lt("높이"),
                    annotation.height,
                    1,
                    10_000,
                    (node, value) => {
                        const ratio = value / Math.max(1, node.height);
                        for (const point of node.points ?? []) point.y *= ratio;
                        node.height = value;
                    },
                ),
            );
            appearanceGroup.append(
                strokeWrapper,
                numberControl(
                    lt("선 두께"),
                    annotation.style.strokeWidth,
                    1,
                    64,
                    (node, value) => {
                        node.style.strokeWidth = value;
                    },
                ),
                numberControl(
                    lt("글자 크기"),
                    annotation.style.fontSize,
                    8,
                    160,
                    (node, value) => {
                        node.style.fontSize = value;
                    },
                ),
            );
            if (
                selectedAnnotations().length === 1 &&
                ["text", "note", "callout"].includes(annotation.kind)
            ) {
                const editText = create("button");
                editText.type = "button";
                editText.textContent = lt("내용 편집");
                editText.dataset.boardEditText = "";
                editText.onclick = () => editAnnotationText(annotation.id);
                actionGroup.append(editText);
            }
            appearanceGroup.append(
                styleButton(lt("보라"), { stroke: "#7c5cff" }),
                styleButton(lt("빨강"), { stroke: "#ff5c73" }),
                styleButton(lt("얇게"), { strokeWidth: 2 }),
                styleButton(lt("굵게"), { strokeWidth: 5 }),
            );
            const saveStyle = create("button");
            saveStyle.type = "button";
            saveStyle.textContent = lt("스타일 저장");
            saveStyle.dataset.boardCommand = "style:save";
            saveStyle.onclick = async () => {
                const node = selectedAnnotations()[0];
                const boardId = options.getDocument()?.id;
                const name =
                    node &&
                    (await requestText({
                        title: lt("스타일 이름"),
                        value: lt("내 주석"),
                        maxLength: 60,
                    }));
                if (options.getDocument()?.id !== boardId) return;
                if (!node || !name) return;
                mutate((document) => {
                    document.styles.push({
                        id: id(),
                        name: name.slice(0, 60),
                        style: { ...node.style },
                    });
                }, lt("주석 스타일 저장"));
            };
            actionGroup.append(saveStyle);
            for (const named of options.getDocument()?.styles.slice(-4) ?? []) {
                const apply = create("button");
                apply.type = "button";
                apply.textContent = named.name;
                apply.dataset.boardCommand = `style:${named.id}`;
                apply.onclick = () => command(`style:${named.id}`);
                actionGroup.append(apply);
            }
        }
        if (selection.length >= 2) {
            for (const [title, action] of [
                [lt("왼쪽 맞춤"), "align:left"],
                [lt("위 맞춤"), "align:top"],
                [lt("가로 간격"), "distribute:horizontal"],
                [lt("세로 간격"), "distribute:vertical"],
            ] as const) {
                const actionButton = create("button");
                actionButton.type = "button";
                actionButton.textContent = title;
                actionButton.dataset.boardCommand = action;
                actionButton.onclick = () => command(action);
                const actionGroup = contextBar.querySelector(
                    ".board-editor__control-group:last-child",
                );
                actionGroup?.append(actionButton);
            }
        }
    };

    for (const tool of shapeTools) {
        const button = create("button");
        button.type = "button";
        button.textContent = labels[tool];
        button.dataset.boardTool = tool;
        button.onclick = () => setTool(tool);
        drawer.append(button);
    }
    shapeButton.onclick = () => {
        if (drawer.hidden) {
            layerPanel.open = false;
            propertyPanel.open = false;
        }
        drawer.hidden = !drawer.hidden;
        shapeButton.setAttribute("aria-expanded", String(!drawer.hidden));
    };
    propertyPanel.addEventListener("toggle", () => {
        if (!propertyPanel.open) return;
        layerPanel.open = false;
        drawer.hidden = true;
        shapeButton.setAttribute("aria-expanded", "false");
    });
    layerPanel.addEventListener("toggle", () => {
        if (!layerPanel.open) return;
        propertyPanel.open = false;
        drawer.hidden = true;
        shapeButton.setAttribute("aria-expanded", "false");
    });

    const renderLayers = () => {
        layerList.replaceChildren();
        const document = options.getDocument();
        if (!document) return;
        for (const node of [...document.nodes].reverse()) {
            const row = create("div", "board-editor__layer");
            row.dataset.nodeId = node.id;
            const choose = create("button", "board-editor__layer-name");
            choose.type = "button";
            choose.textContent =
                node.name ??
                (node.kind === "image"
                    ? lt("이미지")
                    : labels[node.kind as BoardTool]);
            choose.onclick = () => options.select([node.id]);
            choose.ondblclick = () => renameNode(node.id);
            const visible = create("button");
            visible.type = "button";
            visible.textContent = node.visible ? lt("표시") : lt("숨김");
            visible.onclick = () =>
                mutate((current) => {
                    const target = current.nodes.find(
                        (candidate) => candidate.id === node.id,
                    );
                    if (target) target.visible = !target.visible;
                }, lt("레이어 표시 전환"));
            const lock = create("button");
            lock.type = "button";
            lock.textContent = node.locked ? lt("잠금") : lt("열림");
            lock.onclick = () =>
                mutate((current) => {
                    const target = current.nodes.find(
                        (candidate) => candidate.id === node.id,
                    );
                    if (target) target.locked = !target.locked;
                }, lt("레이어 잠금 전환"));
            row.draggable = true;
            row.ondragstart = (event) =>
                event.dataTransfer?.setData("text/plain", node.id);
            row.ondragover = (event) => event.preventDefault();
            row.ondrop = (event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer?.getData("text/plain");
                if (!sourceId || sourceId === node.id) return;
                mutate((current) => {
                    const sourceIndex = current.nodes.findIndex(
                        (candidate) => candidate.id === sourceId,
                    );
                    const targetIndex = current.nodes.findIndex(
                        (candidate) => candidate.id === node.id,
                    );
                    if (sourceIndex < 0 || targetIndex < 0) return;
                    const [source] = current.nodes.splice(sourceIndex, 1);
                    current.nodes.splice(targetIndex, 0, source);
                }, lt("레이어 순서 변경"));
            };
            row.append(choose, visible, lock);
            layerList.append(row);
        }
    };

    const appendShape = (node: BoardNode, temporary = false) => {
        if (!node.visible) return;
        const group = svg("g");
        group.dataset.nodeId = node.id;
        group.classList.toggle("is-selected", selection.includes(node.id));
        group.classList.toggle("is-temporary", temporary);
        group.style.pointerEvents = node.locked ? "none" : "auto";
        const common = {
            fill: node.style.fill,
            stroke: node.style.stroke,
            "stroke-width": node.style.strokeWidth,
            "vector-effect": "non-scaling-stroke",
        };
        if (node.kind === "magnify" && node.magnify) {
            const source = options
                .getDocument()
                ?.nodes.find(
                    (candidate) => candidate.id === node.magnify?.nodeId,
                );
            const sourceElement = source
                ? options.stage.querySelector(
                      `.board-image[data-node-id="${CSS.escape(source.id)}"]`,
                  )
                : null;
            const sourceImage =
                sourceElement instanceof HTMLImageElement
                    ? sourceElement
                    : sourceElement?.querySelector("img");
            if (source && sourceImage?.src) {
                const nested = svg("svg");
                setAttributes(nested, {
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    viewBox: `${source.x + node.magnify.x * source.width} ${source.y + node.magnify.y * source.height} ${Math.max(1, node.magnify.width * source.width)} ${Math.max(1, node.magnify.height * source.height)}`,
                    preserveAspectRatio: "xMidYMid slice",
                });
                const image = svg("image");
                setAttributes(image, {
                    href: sourceImage.src,
                    x: source.x,
                    y: source.y,
                    width: source.width,
                    height: source.height,
                });
                nested.append(image);
                group.append(nested);
            }
        }
        if (node.kind === "rect" || node.kind === "note") {
            const element = svg("rect");
            setAttributes(element, {
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
                rx: node.kind === "note" ? 10 : 3,
                ...common,
            });
            group.append(element);
        } else if (
            node.kind === "ellipse" ||
            node.kind === "step" ||
            node.kind === "magnify"
        ) {
            const element = svg("ellipse");
            setAttributes(element, {
                cx: node.x + node.width / 2,
                cy: node.y + node.height / 2,
                rx: node.width / 2,
                ry: node.height / 2,
                ...common,
            });
            group.append(element);
        } else if (
            ["line", "arrow", "callout", "polygon"].includes(node.kind)
        ) {
            if (node.kind === "callout") {
                const box = svg("rect");
                setAttributes(box, {
                    x: node.x,
                    y: node.y,
                    width: Math.max(48, node.width * 0.72),
                    height: Math.max(32, Math.min(node.height, 72)),
                    rx: 9,
                    fill:
                        node.style.fill === "transparent"
                            ? "#17191f"
                            : node.style.fill,
                    stroke: node.style.stroke,
                    "stroke-width": node.style.strokeWidth,
                });
                group.append(box);
            }
            const points = resolvedNodePoints(
                node,
                options.getDocument()?.nodes ?? [],
            );
            const element = svg(
                node.kind === "polygon" ? "polygon" : "polyline",
            );
            setAttributes(element, {
                points: points
                    .map((point) => `${point.x},${point.y}`)
                    .join(" "),
                ...common,
                fill: node.kind === "polygon" ? node.style.fill : "none",
            });
            if (node.kind === "arrow" || node.kind === "callout")
                element.setAttribute("marker-end", "url(#board-editor-arrow)");
            group.append(element);
        }
        if (["text", "note", "callout", "step"].includes(node.kind)) {
            const lines = (node.text ?? "").split("\n");
            lines.forEach((line, index) => {
                const checklist =
                    node.kind === "note" && /^\[[ xX]\] /.test(line);
                if (checklist) {
                    const box = svg("rect");
                    setAttributes(box, {
                        x: node.x + 8,
                        y: node.y + 7 + index * node.style.fontSize * 1.25,
                        width: node.style.fontSize * 0.75,
                        height: node.style.fontSize * 0.75,
                        rx: 2,
                        fill: "transparent",
                        stroke: node.style.stroke,
                        "stroke-width": 1.5,
                        class: "board-editor__check",
                        "data-check-index": index,
                    });
                    box.onclick = (event) => {
                        event.stopPropagation();
                        mutate((document) => {
                            const target = document.nodes.find(
                                (candidate) => candidate.id === node.id,
                            );
                            if (target)
                                target.text = toggleChecklistLine(
                                    target.text ?? "",
                                    index,
                                );
                        }, lt("체크리스트 전환"));
                    };
                    box.onpointerdown = (event) => event.stopPropagation();
                    group.append(box);
                    if (/^\[[xX]\] /.test(line)) {
                        const check = svg("path");
                        check.setAttribute(
                            "d",
                            `M${node.x + 10} ${node.y + 12 + index * node.style.fontSize * 1.25} l3 3 l6 -7`,
                        );
                        setAttributes(check, {
                            fill: "none",
                            stroke: node.style.stroke,
                            "stroke-width": 2,
                            "pointer-events": "none",
                        });
                        group.append(check);
                    }
                }
                const text = svg("text");
                text.textContent = checklist ? line.slice(4) : line;
                setAttributes(text, {
                    x:
                        node.kind === "step"
                            ? node.x + node.width / 2
                            : node.x +
                              (checklist ? node.style.fontSize + 13 : 8),
                    y:
                        node.kind === "step"
                            ? node.y + node.height / 2
                            : node.y +
                              node.style.fontSize +
                              6 +
                              index * node.style.fontSize * 1.25,
                    fill:
                        node.style.fill === "transparent"
                            ? node.style.stroke
                            : node.style.fill,
                    "font-size": node.style.fontSize,
                    "text-anchor": node.kind === "step" ? "middle" : "start",
                    "dominant-baseline":
                        node.kind === "step" ? "middle" : "auto",
                });
                group.append(text);
            });
        }
        group.onpointerdown = (event) => {
            if (activeTool !== "select" || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const document = options.getDocument();
            const relatedIds = node.groupId
                ? (document?.nodes ?? [])
                      .filter((candidate) => candidate.groupId === node.groupId)
                      .map((candidate) => candidate.id)
                : [node.id];
            const next = event.shiftKey
                ? [...new Set([...selection, ...relatedIds])]
                : relatedIds;
            const origin = options.screenToWorld({
                x: event.clientX,
                y: event.clientY,
            });
            const hasMovableNode = document?.nodes.some(
                (candidate) => next.includes(candidate.id) && !candidate.locked,
            );
            if (hasMovableNode && document) {
                finishPointerSession(false);
                pointerSession = {
                    type: "move",
                    pointerId: event.pointerId,
                    boardId: document.id,
                    nodeIds: next,
                    origin,
                    current: origin,
                };
                options.surface.setPointerCapture(event.pointerId);
            }
            options.select(next);
        };
        if (selection.includes(node.id) && node.points) {
            resolvedNodePoints(
                node,
                options.getDocument()?.nodes ?? [],
            ).forEach((point, index) => {
                const handle = svg("circle");
                setAttributes(handle, {
                    cx: point.x,
                    cy: point.y,
                    r: 5,
                    class: "board-editor__vertex",
                });
                handle.onpointerdown = (event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const document = options.getDocument();
                    if (!document || node.locked) return;
                    finishPointerSession(false);
                    pointerSession = {
                        type: "vertex",
                        pointerId: event.pointerId,
                        boardId: document.id,
                        nodeId: node.id,
                        vertexIndex: index,
                        current: point,
                    };
                    options.surface.setPointerCapture(event.pointerId);
                };
                handle.dataset.vertexIndex = String(index);
                group.append(handle);
            });
        }
        if (temporary) {
            overlay.append(group);
        } else {
            const nodeLayer = svg("svg");
            nodeLayer.classList.add("board-editor__node");
            nodeLayer.dataset.nodeId = node.id;
            const nodeIndex =
                options
                    .getDocument()
                    ?.nodes.findIndex(
                        (candidate) => candidate.id === node.id,
                    ) ?? 0;
            nodeLayer.style.zIndex = String(nodeIndex + 1);
            nodeLayer.append(group);
            root.append(nodeLayer);
        }
    };

    const render = () => {
        if (destroyed) return;
        const currentDocument = options.getDocument();
        if (pointerSession && currentDocument?.id !== pointerSession.boardId) {
            const stalePointerId = pointerSession.pointerId;
            pointerSession = null;
            if (options.surface.hasPointerCapture(stalePointerId))
                options.surface.releasePointerCapture(stalePointerId);
        }
        for (const element of root.querySelectorAll(".board-editor__node")) {
            element.remove();
        }
        for (const element of overlay.querySelectorAll("g[data-node-id]")) {
            element.remove();
        }
        const document = options.getDocument();
        if (document) {
            const focusIds = new Set(document.settings.focusIds);
            for (const node of document.nodes) {
                if (
                    isAnnotationNode(node) &&
                    (focusIds.size === 0 || focusIds.has(node.id))
                )
                    appendShape(node);
            }
        }
        if (previewNode) appendShape(previewNode, true);
        renderLayers();
        renderControls();
    };

    overlay.onpointerdown = (event) => {
        if (event.button !== 0) return;
        if (activeTool === "select") {
            if (event.target === overlay) options.select([]);
            return;
        }
        event.preventDefault();
        overlay.setPointerCapture(event.pointerId);
        startPoint = options.screenToWorld({
            x: event.clientX,
            y: event.clientY,
        });
        previewNode = createNode(activeTool, startPoint.x, startPoint.y, 1, 1);
        render();
    };
    overlay.onpointermove = (event) => {
        if (!startPoint || !previewNode) return;
        const world = options.screenToWorld({
            x: event.clientX,
            y: event.clientY,
        });
        previewNode.x = Math.min(startPoint.x, world.x);
        previewNode.y = Math.min(startPoint.y, world.y);
        previewNode.width = Math.max(1, Math.abs(world.x - startPoint.x));
        previewNode.height = Math.max(1, Math.abs(world.y - startPoint.y));
        if (previewNode.points) {
            previewNode.points =
                previewNode.kind === "polygon"
                    ? [
                          { x: previewNode.width / 2, y: 0 },
                          { x: previewNode.width, y: previewNode.height },
                          { x: 0, y: previewNode.height },
                      ]
                    : [
                          { x: 0, y: 0 },
                          { x: previewNode.width, y: previewNode.height },
                      ];
        }
        render();
    };
    overlay.onpointerup = async () => {
        if (!previewNode || !startPoint) return;
        const node = previewNode;
        previewNode = null;
        startPoint = null;
        if (node.width < 3 && node.height < 3) return render();
        if (["text", "note", "callout"].includes(node.kind)) {
            const boardId = options.getDocument()?.id;
            const value = await requestText({
                title: labels[node.kind as BoardTool],
                value: node.kind === "note" ? lt("[ ] 할 일") : lt("설명"),
                multiline: node.kind === "note",
                maxLength: BOARD_LIMITS.text,
            });
            if (value === null || options.getDocument()?.id !== boardId)
                return render();
            node.text = value.slice(0, BOARD_LIMITS.text);
        }
        if (["line", "arrow", "callout"].includes(node.kind)) {
            node.anchor = anchorAt({ x: node.x, y: node.y });
            node.endAnchor = anchorAt({
                x: node.x + node.width,
                y: node.y + node.height,
            });
        }
        if (node.kind === "magnify") {
            const source = (options.getDocument()?.nodes ?? []).find(
                (candidate) =>
                    candidate.kind === "image" &&
                    node.x + node.width / 2 >= candidate.x &&
                    node.x + node.width / 2 <= candidate.x + candidate.width &&
                    node.y + node.height / 2 >= candidate.y &&
                    node.y + node.height / 2 <= candidate.y + candidate.height,
            );
            if (source) {
                node.magnify = {
                    nodeId: source.id,
                    x: Math.max(0, (node.x - source.x) / source.width),
                    y: Math.max(0, (node.y - source.y) / source.height),
                    width: Math.min(1, node.width / source.width),
                    height: Math.min(1, node.height / source.height),
                    zoom: 2,
                };
            }
        }
        mutate(
            (document) => document.nodes.push(node),
            lt(
                `${labels[node.kind as BoardTool]} 추가`,
                `Add ${labels[node.kind as BoardTool]}`,
            ),
        );
        options.select([node.id]);
        setTool("select");
    };
    overlay.onpointercancel = () => {
        previewNode = null;
        startPoint = null;
        render();
    };

    const deleteSelection = () => {
        if (selection.length === 0) return;
        const ids = new Set(selection);
        mutate((document) => {
            document.nodes = document.nodes.filter(
                (node) => !ids.has(node.id) || node.locked,
            );
        }, lt("주석 삭제"));
        options.select([]);
    };

    const command = (commandId: string) => {
        if (commandId.startsWith("tool:"))
            return setTool(commandId.slice(5) as BoardTool);
        if (commandId === "delete") return deleteSelection();
        if (commandId.startsWith("align:")) {
            return mutate(
                (document) =>
                    alignBoardNodes(
                        document,
                        selection,
                        commandId.slice(6) as Parameters<
                            typeof alignBoardNodes
                        >[2],
                    ),
                lt("주석 정렬"),
            );
        }
        if (
            commandId === "distribute:horizontal" ||
            commandId === "distribute:vertical"
        ) {
            return mutate(
                (document) =>
                    distributeBoardNodes(
                        document,
                        selection,
                        commandId.endsWith("horizontal")
                            ? "horizontal"
                            : "vertical",
                    ),
                lt("주석 간격 맞춤"),
            );
        }
        if (commandId.startsWith("style:")) {
            const styleId = commandId.slice(6);
            return mutate((document) => {
                const style = document.styles.find(
                    (candidate) => candidate.id === styleId,
                );
                if (style) applyBoardStyle(document, selection, style.style);
            }, lt("저장 스타일 적용"));
        }
    };

    const drawAnnotation = (
        context: CanvasRenderingContext2D,
        node: BoardNode,
        allNodes: BoardNode[],
        offsetX: number,
        offsetY: number,
    ) => {
        context.save();
        context.strokeStyle = node.style.stroke;
        context.fillStyle = node.style.fill;
        context.lineWidth = node.style.strokeWidth;
        const x = node.x - offsetX;
        const y = node.y - offsetY;
        if (node.kind === "rect" || node.kind === "note") {
            if (node.style.fill !== "transparent")
                context.fillRect(x, y, node.width, node.height);
            context.strokeRect(x, y, node.width, node.height);
        } else if (["ellipse", "step", "magnify"].includes(node.kind)) {
            context.beginPath();
            context.ellipse(
                x + node.width / 2,
                y + node.height / 2,
                node.width / 2,
                node.height / 2,
                0,
                0,
                Math.PI * 2,
            );
            if (node.style.fill !== "transparent") context.fill();
            context.stroke();
        } else if (
            ["line", "arrow", "callout", "polygon"].includes(node.kind)
        ) {
            if (node.kind === "callout") {
                context.fillStyle =
                    node.style.fill === "transparent"
                        ? "#17191f"
                        : node.style.fill;
                context.fillRect(
                    x,
                    y,
                    Math.max(48, node.width * 0.72),
                    Math.max(32, Math.min(node.height, 72)),
                );
                context.strokeRect(
                    x,
                    y,
                    Math.max(48, node.width * 0.72),
                    Math.max(32, Math.min(node.height, 72)),
                );
            }
            const points = resolvedNodePoints(node, allNodes);
            context.beginPath();
            points.forEach((point, index) => {
                const px = point.x - offsetX;
                const py = point.y - offsetY;
                if (index === 0) context.moveTo(px, py);
                else context.lineTo(px, py);
            });
            if (node.kind === "polygon") context.closePath();
            if (node.kind === "polygon" && node.style.fill !== "transparent")
                context.fill();
            context.stroke();
            if (
                (node.kind === "arrow" || node.kind === "callout") &&
                points.length > 1
            ) {
                const end = points.at(-1) as { x: number; y: number };
                const before = points.at(-2) as { x: number; y: number };
                const angle = Math.atan2(end.y - before.y, end.x - before.x);
                context.beginPath();
                context.moveTo(end.x - offsetX, end.y - offsetY);
                context.lineTo(
                    end.x - offsetX - 12 * Math.cos(angle - 0.5),
                    end.y - offsetY - 12 * Math.sin(angle - 0.5),
                );
                context.lineTo(
                    end.x - offsetX - 12 * Math.cos(angle + 0.5),
                    end.y - offsetY - 12 * Math.sin(angle + 0.5),
                );
                context.closePath();
                context.fillStyle = node.style.stroke;
                context.fill();
            }
        }
        if (["text", "note", "callout", "step"].includes(node.kind)) {
            canvasText(context, node, node.text ?? "", offsetX, offsetY);
        }
        context.restore();
    };

    const exportRaster: BoardEditorController["exportRaster"] = async (
        exportOptions = {},
    ) => {
        const boardDocument = options.getDocument();
        if (!boardDocument) throw new Error(lt("열린 보드가 없습니다."));
        const selectedIds = new Set(selection);
        const focusIds = new Set(boardDocument.settings.focusIds);
        const visible = boardDocument.nodes.filter((node) => {
            if (!node.visible) return false;
            if (exportOptions.selectionOnly) return selectedIds.has(node.id);
            return focusIds.size === 0 || focusIds.has(node.id);
        });
        const plan = boardExportPlan(visible, BOARD_LIMITS.exportPixels);
        const { bounds, scale } = plan;
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = plan.width;
        canvas.height = plan.height;
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error(lt("내보내기 캔버스를 만들지 못했습니다."));
        context.scale(scale, scale);
        if (exportOptions.background) {
            context.fillStyle = exportOptions.background;
            context.fillRect(0, 0, bounds.width, bounds.height);
        }
        let decodedAssetId: string | null = null;
        let decodedImage: HTMLImageElement | null = null;
        const originalImage = async (assetId: string) => {
            if (decodedAssetId === assetId && decodedImage) return decodedImage;
            if (decodedImage) decodedImage.src = "";
            decodedAssetId = assetId;
            decodedImage = await loadImage(
                await options.assetData(assetId, "original"),
            );
            return decodedImage;
        };
        try {
            for (const node of visible) {
                if (node.kind === "image") {
                    if (!node.assetId) continue;
                    const image = await originalImage(node.assetId);
                    context.save();
                    context.translate(
                        node.x - bounds.x + node.width / 2,
                        node.y - bounds.y + node.height / 2,
                    );
                    context.rotate((node.rotation * Math.PI) / 180);
                    context.drawImage(
                        image,
                        -node.width / 2,
                        -node.height / 2,
                        node.width,
                        node.height,
                    );
                    context.restore();
                    continue;
                }
                if (node.kind === "magnify" && node.magnify) {
                    const sourceNode = boardDocument.nodes.find(
                        (candidate) => candidate.id === node.magnify?.nodeId,
                    );
                    if (sourceNode?.assetId) {
                        const sourceImage = await originalImage(
                            sourceNode.assetId,
                        );
                        context.save();
                        context.beginPath();
                        context.ellipse(
                            node.x - bounds.x + node.width / 2,
                            node.y - bounds.y + node.height / 2,
                            node.width / 2,
                            node.height / 2,
                            0,
                            0,
                            Math.PI * 2,
                        );
                        context.clip();
                        context.drawImage(
                            sourceImage,
                            node.magnify.x * sourceImage.naturalWidth,
                            node.magnify.y * sourceImage.naturalHeight,
                            Math.max(
                                1,
                                node.magnify.width * sourceImage.naturalWidth,
                            ),
                            Math.max(
                                1,
                                node.magnify.height * sourceImage.naturalHeight,
                            ),
                            node.x - bounds.x,
                            node.y - bounds.y,
                            node.width,
                            node.height,
                        );
                        context.restore();
                    }
                }
                drawAnnotation(
                    context,
                    node,
                    boardDocument.nodes,
                    bounds.x,
                    bounds.y,
                );
            }
            return canvas.toDataURL("image/png");
        } finally {
            const finalImage = decodedImage as HTMLImageElement | null;
            if (finalImage) finalImage.src = "";
        }
    };

    const keydown = (event: KeyboardEvent) => {
        if (
            !root.isConnected ||
            root.closest("[hidden]") ||
            options.surface.closest("[hidden]") ||
            options.surface.getClientRects().length === 0
        )
            return;
        if (
            (event.key === "Delete" || event.key === "Backspace") &&
            !(event.target instanceof HTMLInputElement) &&
            !(event.target instanceof HTMLTextAreaElement)
        ) {
            event.preventDefault();
            deleteSelection();
        }
        if (event.key === "Escape") {
            finishPointerSession(false);
            if (activeTool !== "select") setTool("select");
        }
    };
    window.addEventListener("keydown", keydown);
    render();

    return {
        root,
        setSelection(ids) {
            selection = [...ids];
            render();
        },
        setTool,
        getTool: () => activeTool,
        render,
        exportRaster,
        command,
        destroy() {
            destroyed = true;
            finishPointerSession(false);
            window.removeEventListener("keydown", keydown);
            options.surface.removeEventListener(
                "pointermove",
                surfacePointerMove,
            );
            options.surface.removeEventListener("pointerup", surfacePointerUp);
            options.surface.removeEventListener(
                "pointercancel",
                surfacePointerCancel,
            );
            options.surface.removeEventListener(
                "lostpointercapture",
                surfaceLostPointerCapture,
            );
            options.surface.removeEventListener("dblclick", surfaceDoubleClick);
            window.removeEventListener("blur", windowBlur);
            overlay.remove();
            toolbar.remove();
        },
    };
};
