export type CaptureSelectionMode = "region" | "window";

export type CaptureSelectionEdge = {
    x: number;
    y: number;
    width: number;
    height: number;
    type: "system" | "image";
};

type Bounds = { x: number; y: number; width: number; height: number };
type NativeWindowBounds = { x: number; y: number; w: number; h: number };
type CanvasSize = { width: number; height: number };

export type NativeMonitorGeometry = Bounds & {
    id: number;
    name?: string;
    scaleFactor: number;
    isPrimary: boolean;
};

export type ElectronDisplayGeometry = {
    id: number;
    label?: string;
    bounds: Bounds;
    scaleFactor: number;
};

const finite = (values: number[]) => values.every(Number.isFinite);

export function dashboardCaptureSelectionMode(
    mode: string,
): CaptureSelectionMode {
    return mode === "window" ? "window" : "region";
}

export function eligibleNativeWindowBounds(
    bounds: NativeWindowBounds,
    isMinimized: boolean,
): NativeWindowBounds | null {
    if (
        isMinimized ||
        !finite([bounds.x, bounds.y, bounds.w, bounds.h]) ||
        bounds.w <= 0 ||
        bounds.h <= 0
    )
        return null;
    return bounds;
}

function normalizedLabel(value?: string) {
    return value?.trim().toLocaleLowerCase() ?? "";
}

function centerRank(bounds: Bounds, all: Bounds[], axis: "x" | "y") {
    const size = axis === "x" ? "width" : "height";
    const center = bounds[axis] + bounds[size] / 2;
    return all.filter(
        (candidate) => candidate[axis] + candidate[size] / 2 < center,
    ).length;
}

/**
 * Pair native physical monitors with Electron DIP displays. Exact platform IDs
 * and unique output labels are authoritative. The fallback compares DIP-sized
 * dimensions, scale, primary status, and relative layout ranks; it deliberately
 * avoids comparing native physical centers directly with Electron DIP centers.
 */
export function matchNativeMonitorsToDisplays(
    nativeMonitors: NativeMonitorGeometry[],
    displays: ElectronDisplayGeometry[],
) {
    const pairs = new Map<number, number>();
    const usedDisplays = new Set<number>();

    const assignUnique = (
        predicate: (
            monitor: NativeMonitorGeometry,
            display: ElectronDisplayGeometry,
        ) => boolean,
        requireMutualMatch = false,
    ) => {
        for (let ni = 0; ni < nativeMonitors.length; ni++) {
            if (pairs.has(ni)) continue;
            const candidates = displays.flatMap((display, di) =>
                !usedDisplays.has(di) && predicate(nativeMonitors[ni], display)
                    ? [di]
                    : [],
            );
            if (candidates.length !== 1) continue;
            if (
                requireMutualMatch &&
                nativeMonitors.filter(
                    (monitor, candidateIndex) =>
                        !pairs.has(candidateIndex) &&
                        predicate(monitor, displays[candidates[0]]),
                ).length !== 1
            )
                continue;
            pairs.set(ni, candidates[0]);
            usedDisplays.add(candidates[0]);
        }
    };

    assignUnique((monitor, display) => monitor.id === display.id);
    assignUnique((monitor, display) => {
        const name = normalizedLabel(monitor.name);
        return name !== "" && name === normalizedLabel(display.label);
    }, true);

    const nativeBounds = nativeMonitors.map((monitor) => ({
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
    }));
    const displayBounds = displays.map((display) => display.bounds);
    const candidates: { ni: number; di: number; score: number }[] = [];
    for (let ni = 0; ni < nativeMonitors.length; ni++) {
        if (pairs.has(ni)) continue;
        const monitor = nativeMonitors[ni];
        const scale =
            Number.isFinite(monitor.scaleFactor) && monitor.scaleFactor > 0
                ? monitor.scaleFactor
                : 1;
        for (let di = 0; di < displays.length; di++) {
            if (usedDisplays.has(di)) continue;
            const display = displays[di];
            const width = monitor.width / scale;
            const height = monitor.height / scale;
            const dimensionDelta =
                Math.abs(width - display.bounds.width) / Math.max(width, 1) +
                Math.abs(height - display.bounds.height) / Math.max(height, 1);
            const scaleDelta = Math.abs(scale - display.scaleFactor);
            const primaryMismatch =
                monitor.isPrimary !==
                (display.bounds.x === 0 && display.bounds.y === 0);
            const rankDelta =
                Math.abs(
                    centerRank(nativeBounds[ni], nativeBounds, "x") -
                        centerRank(display.bounds, displayBounds, "x"),
                ) +
                Math.abs(
                    centerRank(nativeBounds[ni], nativeBounds, "y") -
                        centerRank(display.bounds, displayBounds, "y"),
                );
            candidates.push({
                ni,
                di,
                score:
                    dimensionDelta * 1000 +
                    scaleDelta * 200 +
                    rankDelta * 100 +
                    (primaryMismatch ? 5000 : 0),
            });
        }
    }
    candidates.sort((a, b) => a.score - b.score || a.ni - b.ni || a.di - b.di);
    for (const candidate of candidates) {
        if (pairs.has(candidate.ni) || usedDisplays.has(candidate.di)) continue;
        pairs.set(candidate.ni, candidate.di);
        usedDisplays.add(candidate.di);
    }

    return nativeMonitors.flatMap((monitor, ni) => {
        const di = pairs.get(ni);
        return di === undefined
            ? []
            : [{ nativeId: monitor.id, displayId: displays[di].id }];
    });
}

/**
 * Convert node-screenshots/XCap Windows coordinates into Electron DIP space.
 * XCap 0.4.1 reads Win32 WINDOWINFO coordinates, which are physical pixels in
 * Electron's DPI-aware process. Native monitor bounds provide the physical
 * origin; Electron display bounds provide the corresponding global DIP origin.
 */
export function nativeWindowBoundsToDip(
    windowBounds: NativeWindowBounds,
    nativeMonitor: Bounds,
    electronDisplay: Bounds,
): NativeWindowBounds | null {
    if (
        !finite([
            windowBounds.x,
            windowBounds.y,
            windowBounds.w,
            windowBounds.h,
            nativeMonitor.x,
            nativeMonitor.y,
            nativeMonitor.width,
            nativeMonitor.height,
            electronDisplay.x,
            electronDisplay.y,
            electronDisplay.width,
            electronDisplay.height,
        ]) ||
        windowBounds.w <= 0 ||
        windowBounds.h <= 0 ||
        nativeMonitor.width <= 0 ||
        nativeMonitor.height <= 0 ||
        electronDisplay.width <= 0 ||
        electronDisplay.height <= 0
    )
        return null;
    const scaleX = nativeMonitor.width / electronDisplay.width;
    const scaleY = nativeMonitor.height / electronDisplay.height;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
    return {
        x: electronDisplay.x + (windowBounds.x - nativeMonitor.x) / scaleX,
        y: electronDisplay.y + (windowBounds.y - nativeMonitor.y) / scaleY,
        w: windowBounds.w / scaleX,
        h: windowBounds.h / scaleY,
    };
}

export function nativeWindowBoundsForDisplay(
    windowBounds: NativeWindowBounds,
    nativeMonitor: Bounds,
    electronDisplay: Bounds | undefined,
    hasElectronDisplays: boolean,
) {
    if (!hasElectronDisplays) return windowBounds;
    if (!electronDisplay) return null;
    return nativeWindowBoundsToDip(
        windowBounds,
        nativeMonitor,
        electronDisplay,
    );
}

export function windowBoundsToCanvas(
    windowBounds: NativeWindowBounds,
    displayBounds: Bounds,
    canvas: CanvasSize,
): CaptureSelectionEdge | null {
    // Both input rectangles are global DIPs. The canvas is the captured
    // display's physical pixel buffer, so the per-axis ratio performs the only
    // DIP-to-pixel conversion in this function.
    if (
        !finite([
            windowBounds.x,
            windowBounds.y,
            windowBounds.w,
            windowBounds.h,
            displayBounds.x,
            displayBounds.y,
            displayBounds.width,
            displayBounds.height,
            canvas.width,
            canvas.height,
        ]) ||
        windowBounds.w <= 0 ||
        windowBounds.h <= 0 ||
        displayBounds.width <= 0 ||
        displayBounds.height <= 0 ||
        canvas.width <= 0 ||
        canvas.height <= 0
    )
        return null;

    const left = Math.max(windowBounds.x, displayBounds.x);
    const top = Math.max(windowBounds.y, displayBounds.y);
    const right = Math.min(
        windowBounds.x + windowBounds.w,
        displayBounds.x + displayBounds.width,
    );
    const bottom = Math.min(
        windowBounds.y + windowBounds.h,
        displayBounds.y + displayBounds.height,
    );
    if (right <= left || bottom <= top) return null;

    const scaleX = canvas.width / displayBounds.width;
    const scaleY = canvas.height / displayBounds.height;
    const x = Math.max(
        0,
        Math.min(canvas.width, Math.floor((left - displayBounds.x) * scaleX)),
    );
    const y = Math.max(
        0,
        Math.min(canvas.height, Math.floor((top - displayBounds.y) * scaleY)),
    );
    const pixelRight = Math.max(
        0,
        Math.min(canvas.width, Math.ceil((right - displayBounds.x) * scaleX)),
    );
    const pixelBottom = Math.max(
        0,
        Math.min(canvas.height, Math.ceil((bottom - displayBounds.y) * scaleY)),
    );
    if (pixelRight <= x || pixelBottom <= y) return null;
    return {
        x,
        y,
        width: pixelRight - x,
        height: pixelBottom - y,
        type: "system",
    };
}

export function selectionEdgesForMode(
    edges: CaptureSelectionEdge[],
    mode: CaptureSelectionMode,
    recognizeSystemWindows: boolean,
) {
    if (mode === "window")
        return edges.filter((edge) => edge.type === "system");
    return edges.filter(
        (edge) => edge.type === "image" || recognizeSystemWindows,
    );
}

export function windowEdgeAtPoint(
    edges: CaptureSelectionEdge[],
    point: { x: number; y: number },
) {
    return edges.find(
        (edge) =>
            edge.type === "system" &&
            edge.x < point.x &&
            point.x < edge.x + edge.width &&
            edge.y < point.y &&
            point.y < edge.y + edge.height,
    );
}

function nearestWithin(value: number, candidates: number[], threshold: number) {
    let best: number | null = null;
    let distance = threshold;
    for (const candidate of candidates) {
        const d = Math.abs(candidate - value);
        if (d <= distance) {
            distance = d;
            best = candidate;
        }
    }
    return best;
}

/**
 * Snap the moving corner of a drag selection to candidate edges plus the
 * canvas bounds and midlines. `anchor` is the drag-start corner in canvas
 * pixels; the edges closest to it stay fixed while the opposite edges move.
 */
export function snapDragRect(
    rect: readonly [number, number, number, number],
    anchor: { x: number; y: number },
    edges: CaptureSelectionEdge[],
    canvas: CanvasSize,
    threshold: number,
): {
    rect: [number, number, number, number];
    guideX: number | null;
    guideY: number | null;
} {
    const [x, y, w, h] = rect;
    const none = {
        rect: [x, y, w, h] as [number, number, number, number],
        guideX: null,
        guideY: null,
    };
    if (w <= 0 || h <= 0 || threshold <= 0) return none;
    const xs = [0, canvas.width / 2, canvas.width];
    const ys = [0, canvas.height / 2, canvas.height];
    for (const edge of edges) {
        xs.push(edge.x, edge.x + edge.width);
        ys.push(edge.y, edge.y + edge.height);
    }
    const rightMoves = anchor.x < x + w / 2;
    const bottomMoves = anchor.y < y + h / 2;
    const snappedX = nearestWithin(rightMoves ? x + w : x, xs, threshold);
    const snappedY = nearestWithin(bottomMoves ? y + h : y, ys, threshold);
    if (snappedX == null && snappedY == null) return none;
    let nx = x;
    let ny = y;
    let nw = w;
    let nh = h;
    if (snappedX != null) {
        if (rightMoves) nw = snappedX - x;
        else {
            nw = x + w - snappedX;
            nx = snappedX;
        }
    }
    if (snappedY != null) {
        if (bottomMoves) nh = snappedY - y;
        else {
            nh = y + h - snappedY;
            ny = snappedY;
        }
    }
    if (nw < 1 || nh < 1) return none;
    return { rect: [nx, ny, nw, nh], guideX: snappedX, guideY: snappedY };
}

/**
 * Snap edges of an existing selection while resizing or moving it. Each axis
 * names which edge is being dragged ("left"/"right"/"top"/"bottom") or that
 * the whole rect translates ("translate"), where both edges of the axis can
 * latch onto a candidate without changing the rect's size.
 */
export function snapAdjustRect(
    rect: readonly [number, number, number, number],
    mode: {
        x?: "left" | "right" | "translate";
        y?: "top" | "bottom" | "translate";
    },
    edges: CaptureSelectionEdge[],
    canvas: CanvasSize,
    threshold: number,
): {
    rect: [number, number, number, number];
    guideX: number | null;
    guideY: number | null;
} {
    const [x, y, w, h] = rect;
    let nx = x;
    let ny = y;
    let nw = w;
    let nh = h;
    let guideX: number | null = null;
    let guideY: number | null = null;
    const xs = [0, canvas.width / 2, canvas.width];
    const ys = [0, canvas.height / 2, canvas.height];
    for (const edge of edges) {
        xs.push(edge.x, edge.x + edge.width);
        ys.push(edge.y, edge.y + edge.height);
    }
    if (mode.x === "left" || mode.x === "right") {
        const snapped = nearestWithin(
            mode.x === "left" ? x : x + w,
            xs,
            threshold,
        );
        if (snapped != null) {
            if (mode.x === "left") {
                nw = x + w - snapped;
                nx = snapped;
            } else nw = snapped - x;
            guideX = snapped;
        }
    } else if (mode.x === "translate") {
        const leftHit = nearestWithin(x, xs, threshold);
        const rightHit = nearestWithin(x + w, xs, threshold);
        const leftDelta = leftHit == null ? null : leftHit - x;
        const rightDelta = rightHit == null ? null : rightHit - (x + w);
        const delta =
            leftDelta != null &&
            (rightDelta == null || Math.abs(leftDelta) <= Math.abs(rightDelta))
                ? leftDelta
                : rightDelta;
        if (delta != null) {
            nx = x + delta;
            guideX = delta === leftDelta ? leftHit : rightHit;
        }
    }
    if (mode.y === "top" || mode.y === "bottom") {
        const snapped = nearestWithin(
            mode.y === "top" ? y : y + h,
            ys,
            threshold,
        );
        if (snapped != null) {
            if (mode.y === "top") {
                nh = y + h - snapped;
                ny = snapped;
            } else nh = snapped - y;
            guideY = snapped;
        }
    } else if (mode.y === "translate") {
        const topHit = nearestWithin(y, ys, threshold);
        const bottomHit = nearestWithin(y + h, ys, threshold);
        const topDelta = topHit == null ? null : topHit - y;
        const bottomDelta = bottomHit == null ? null : bottomHit - (y + h);
        const delta =
            topDelta != null &&
            (bottomDelta == null || Math.abs(topDelta) <= Math.abs(bottomDelta))
                ? topDelta
                : bottomDelta;
        if (delta != null) {
            ny = y + delta;
            guideY = delta === topDelta ? topHit : bottomHit;
        }
    }
    if (nw < 1 || nh < 1) {
        return { rect: [x, y, w, h], guideX: null, guideY: null };
    }
    return { rect: [nx, ny, nw, nh], guideX, guideY };
}
