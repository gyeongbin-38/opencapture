import type { BoardNode } from "./captureBoard";

export type BoardLayout = "horizontal" | "vertical" | "grid";
export type BoardAlign =
    | "left"
    | "center"
    | "right"
    | "top"
    | "middle"
    | "bottom";
export type BoardDistribute = "horizontal" | "vertical";
export type SnapGuide = {
    axis: "x" | "y";
    value: number;
    from: number;
    to: number;
};

export function boundsOf(nodes: readonly BoardNode[]) {
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function moveNodes(
    nodes: readonly BoardNode[],
    dx: number,
    dy: number,
): BoardNode[] {
    return nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy }));
}

export function resizeNodes(
    nodes: readonly BoardNode[],
    start: { x: number; y: number; width: number; height: number },
    next: { x: number; y: number; width: number; height: number },
): BoardNode[] {
    const sx = start.width > 0 ? next.width / start.width : 1;
    const sy = start.height > 0 ? next.height / start.height : 1;
    return nodes.map((node) => ({
        ...node,
        x: next.x + (node.x - start.x) * sx,
        y: next.y + (node.y - start.y) * sy,
        width: Math.max(1, node.width * sx),
        height: Math.max(1, node.height * sy),
    }));
}

export function layoutNodes(
    nodes: readonly BoardNode[],
    layout: BoardLayout,
    gap = 24,
): BoardNode[] {
    if (nodes.length === 0) return [];
    const origin = boundsOf(nodes);
    const output = nodes.map((node) => ({ ...node }));
    if (layout === "horizontal") {
        let x = origin.x;
        for (const node of output) {
            node.x = x;
            node.y = origin.y;
            x += node.width + gap;
        }
        return output;
    }
    if (layout === "vertical") {
        let y = origin.y;
        for (const node of output) {
            node.x = origin.x;
            node.y = y;
            y += node.height + gap;
        }
        return output;
    }
    const columns = Math.ceil(Math.sqrt(output.length));
    const cellWidth = Math.max(...output.map((node) => node.width)) + gap;
    const cellHeight = Math.max(...output.map((node) => node.height)) + gap;
    return output.map((node, index) => ({
        ...node,
        x: origin.x + (index % columns) * cellWidth,
        y: origin.y + Math.floor(index / columns) * cellHeight,
    }));
}

export function alignNodes(
    nodes: readonly BoardNode[],
    align: BoardAlign,
): BoardNode[] {
    if (nodes.length < 2) return nodes.map((node) => ({ ...node }));
    const bounds = boundsOf(nodes);
    return nodes.map((node) => {
        const copy = { ...node };
        if (align === "left") copy.x = bounds.x;
        if (align === "center")
            copy.x = bounds.x + (bounds.width - node.width) / 2;
        if (align === "right") copy.x = bounds.x + bounds.width - node.width;
        if (align === "top") copy.y = bounds.y;
        if (align === "middle")
            copy.y = bounds.y + (bounds.height - node.height) / 2;
        if (align === "bottom") copy.y = bounds.y + bounds.height - node.height;
        return copy;
    });
}

export function distributeNodes(
    nodes: readonly BoardNode[],
    axis: BoardDistribute,
): BoardNode[] {
    if (nodes.length < 3) return nodes.map((node) => ({ ...node }));
    const horizontal = axis === "horizontal";
    const sorted = nodes
        .map((node) => ({ ...node }))
        .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const occupied = sorted.reduce(
        (sum, node) => sum + (horizontal ? node.width : node.height),
        0,
    );
    const span = horizontal
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
    const gap = (span - occupied) / (sorted.length - 1);
    let cursor = horizontal ? first.x : first.y;
    for (const node of sorted) {
        if (horizontal) node.x = cursor;
        else node.y = cursor;
        cursor += (horizontal ? node.width : node.height) + gap;
    }
    const byId = new Map(sorted.map((node) => [node.id, node]));
    return nodes.map((node) => byId.get(node.id) ?? { ...node });
}

export function snapNode(
    moving: BoardNode,
    others: readonly BoardNode[],
    threshold = 8,
    bypass = false,
): { node: BoardNode; guides: SnapGuide[] } {
    if (bypass || others.length === 0)
        return { node: { ...moving }, guides: [] };
    const next = { ...moving };
    const guides: SnapGuide[] = [];
    const movingX = [
        moving.x,
        moving.x + moving.width / 2,
        moving.x + moving.width,
    ];
    const movingY = [
        moving.y,
        moving.y + moving.height / 2,
        moving.y + moving.height,
    ];
    const targetX = others.flatMap((node) => [
        node.x,
        node.x + node.width / 2,
        node.x + node.width,
    ]);
    const targetY = others.flatMap((node) => [
        node.y,
        node.y + node.height / 2,
        node.y + node.height,
    ]);
    const nearest = (from: number[], targets: number[]) => {
        let best: { delta: number; target: number } | null = null;
        for (const value of from) {
            for (const target of targets) {
                const delta = target - value;
                if (
                    Math.abs(delta) <= threshold &&
                    (!best || Math.abs(delta) < Math.abs(best.delta))
                ) {
                    best = { delta, target };
                }
            }
        }
        return best;
    };
    const x = nearest(movingX, targetX);
    const y = nearest(movingY, targetY);
    const equalSpacing = (axis: "x" | "y") => {
        const horizontal = axis === "x";
        const start = horizontal ? moving.x : moving.y;
        const size = horizontal ? moving.width : moving.height;
        const before = others
            .filter(
                (node) =>
                    (horizontal ? node.x + node.width : node.y + node.height) <=
                    start + threshold,
            )
            .sort((a, b) =>
                horizontal
                    ? b.x + b.width - (a.x + a.width)
                    : b.y + b.height - (a.y + a.height),
            )[0];
        const after = others
            .filter(
                (node) =>
                    (horizontal ? node.x : node.y) >= start + size - threshold,
            )
            .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))[0];
        if (!before || !after) return null;
        const beforeEnd = horizontal
            ? before.x + before.width
            : before.y + before.height;
        const afterStart = horizontal ? after.x : after.y;
        const target = (beforeEnd + afterStart - size) / 2;
        const delta = target - start;
        return Math.abs(delta) <= threshold
            ? { delta, target: target + size / 2 }
            : null;
    };
    const spacingX = equalSpacing("x");
    const spacingY = equalSpacing("y");
    const snappedX =
        spacingX && (!x || Math.abs(spacingX.delta) < Math.abs(x.delta))
            ? spacingX
            : x;
    const snappedY =
        spacingY && (!y || Math.abs(spacingY.delta) < Math.abs(y.delta))
            ? spacingY
            : y;
    if (snappedX) {
        next.x += snappedX.delta;
        const extent = boundsOf([...others, next]);
        guides.push({
            axis: "x",
            value: snappedX.target,
            from: extent.y,
            to: extent.y + extent.height,
        });
    }
    if (snappedY) {
        next.y += snappedY.delta;
        const extent = boundsOf([...others, next]);
        guides.push({
            axis: "y",
            value: snappedY.target,
            from: extent.x,
            to: extent.x + extent.width,
        });
    }
    return { node: next, guides };
}

export function versionGroups(
    nodes: readonly BoardNode[],
): Map<string, BoardNode[]> {
    const groups = new Map<string, BoardNode[]>();
    for (const node of nodes) {
        if (node.kind !== "image" || !node.source?.areaKey) continue;
        const group = groups.get(node.source.areaKey) ?? [];
        group.push(node);
        groups.set(node.source.areaKey, group);
    }
    return groups;
}
