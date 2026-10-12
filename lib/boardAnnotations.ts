import type {
    BoardDocument,
    BoardNode,
    BoardPoint,
    BoardStyle,
} from "./captureBoard";

export type BoardAlignMode =
    | "left"
    | "center"
    | "right"
    | "top"
    | "middle"
    | "bottom";

const annotationKinds = new Set<BoardNode["kind"]>([
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

export const defaultBoardStyle = (): BoardStyle => ({
    fill: "transparent",
    stroke: "#7c5cff",
    strokeWidth: 3,
    fontSize: 18,
});

export const isAnnotationNode = (node: BoardNode) =>
    annotationKinds.has(node.kind);

export const rotatePoint = (
    point: BoardPoint,
    center: BoardPoint,
    degrees: number,
): BoardPoint => {
    const radians = (degrees * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * cosine - dy * sine,
        y: center.y + dx * sine + dy * cosine,
    };
};

export const anchorPoint = (
    anchor: { x: number; y: number },
    target: Pick<BoardNode, "x" | "y" | "width" | "height" | "rotation">,
): BoardPoint =>
    rotatePoint(
        {
            x: target.x + target.width * Math.max(0, Math.min(1, anchor.x)),
            y: target.y + target.height * Math.max(0, Math.min(1, anchor.y)),
        },
        {
            x: target.x + target.width / 2,
            y: target.y + target.height / 2,
        },
        target.rotation,
    );

export const resolvedNodePoints = (
    node: BoardNode,
    nodes: readonly BoardNode[],
): BoardPoint[] => {
    const points = (node.points ?? []).map((point) => ({
        x: node.x + point.x,
        y: node.y + point.y,
    }));
    if (node.anchor) {
        const target = nodes.find(
            (candidate) => candidate.id === node.anchor?.nodeId,
        );
        if (target) points[0] = anchorPoint(node.anchor, target);
    }
    if (node.endAnchor) {
        const target = nodes.find(
            (candidate) => candidate.id === node.endAnchor?.nodeId,
        );
        if (target) {
            const index = Math.max(1, points.length - 1);
            points[index] = anchorPoint(node.endAnchor, target);
        }
    }
    if (points.length > 0) return points;
    return [
        { x: node.x, y: node.y },
        { x: node.x + node.width, y: node.y + node.height },
    ];
};

export const renumberBoardSteps = (nodes: BoardNode[]) => {
    let number = 1;
    for (const node of nodes) {
        if (node.kind === "step") {
            node.text = String(number);
            number += 1;
        }
    }
};

const selectedEditable = (document: BoardDocument, ids: readonly string[]) => {
    const idSet = new Set(ids);
    return document.nodes.filter((node) => idSet.has(node.id) && !node.locked);
};

export const alignBoardNodes = (
    document: BoardDocument,
    ids: readonly string[],
    mode: BoardAlignMode,
) => {
    const nodes = selectedEditable(document, ids);
    if (nodes.length < 2) return;
    const left = Math.min(...nodes.map((node) => node.x));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const top = Math.min(...nodes.map((node) => node.y));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    for (const node of nodes) {
        if (mode === "left") node.x = left;
        if (mode === "right") node.x = right - node.width;
        if (mode === "center") node.x = (left + right - node.width) / 2;
        if (mode === "top") node.y = top;
        if (mode === "bottom") node.y = bottom - node.height;
        if (mode === "middle") node.y = (top + bottom - node.height) / 2;
    }
};

export const distributeBoardNodes = (
    document: BoardDocument,
    ids: readonly string[],
    axis: "horizontal" | "vertical",
) => {
    const nodes = selectedEditable(document, ids).sort((a, b) =>
        axis === "horizontal" ? a.x - b.x : a.y - b.y,
    );
    if (nodes.length < 3) return;
    if (axis === "horizontal") {
        const start = nodes[0].x;
        const end = nodes.at(-1)?.x ?? start;
        nodes.forEach((node, index) => {
            node.x = start + ((end - start) * index) / (nodes.length - 1);
        });
    } else {
        const start = nodes[0].y;
        const end = nodes.at(-1)?.y ?? start;
        nodes.forEach((node, index) => {
            node.y = start + ((end - start) * index) / (nodes.length - 1);
        });
    }
};

export const applyBoardStyle = (
    document: BoardDocument,
    ids: readonly string[],
    style: Partial<BoardStyle>,
) => {
    const idSet = new Set(ids);
    for (const node of document.nodes) {
        if (idSet.has(node.id) && isAnnotationNode(node) && !node.locked) {
            node.style = { ...node.style, ...style };
        }
    }
};

export const boardNodesBounds = (nodes: readonly BoardNode[]) => {
    if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
    const x = Math.min(...nodes.map((node) => node.x));
    const y = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    return {
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
    };
};

export const boardExportPlan = (
    nodes: readonly BoardNode[],
    maxPixels: number,
) => {
    const bounds = boardNodesBounds(nodes.filter((node) => node.visible));
    const scale = Math.min(
        1,
        Math.sqrt(maxPixels / Math.max(1, bounds.width * bounds.height)),
    );
    return {
        bounds,
        scale,
        width: Math.max(1, Math.round(bounds.width * scale)),
        height: Math.max(1, Math.round(bounds.height * scale)),
    };
};

export const setBoardVertex = (
    node: BoardNode,
    index: number,
    worldPoint: BoardPoint,
) => {
    if (node.locked || !node.points?.[index]) return false;
    node.points[index] = {
        x: worldPoint.x - node.x,
        y: worldPoint.y - node.y,
    };
    return true;
};

export const toggleChecklistLine = (text: string, lineIndex: number) => {
    const lines = text.split("\n");
    const line = lines[lineIndex];
    if (line?.startsWith("[ ] ")) lines[lineIndex] = `[x] ${line.slice(4)}`;
    else if (line?.toLowerCase().startsWith("[x] "))
        lines[lineIndex] = `[ ] ${line.slice(4)}`;
    return lines.join("\n");
};
