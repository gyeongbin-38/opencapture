import type { SavedComparisonSession } from "./openCaptureTypes";

export const REFERENCE_MAX_ITEMS = 20;
export const REFERENCE_MAX_NOTES = 50;
export const REFERENCE_MAX_SESSIONS = 50;
export const REFERENCE_WORK_EDGE = 1024;
export const REFERENCE_EXPORT_PIXELS = 16_000_000;

export type ReferencePixels = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
};

export type ReferenceAlignment = {
    ok: boolean;
    offsetX: number;
    offsetY: number;
    scale: number;
    score: number;
    overlap: number;
    reason?: "no-match" | "invalid";
};

export type ReferencePointNote = {
    id: string;
    x: number;
    y: number;
    text: string;
};

export type ReferenceCompareMode = "side" | "opacity" | "wipe" | "diff";
export type ReferenceZoomMode = "fit" | "actual";

export type ReferenceComparisonSession = {
    id: string;
    name: string;
    aId: string;
    bId: string;
    mode: ReferenceCompareMode;
    zoomMode: ReferenceZoomMode;
    zoom: number;
    pan: { x: number; y: number };
    offsetB: { x: number; y: number };
    scaleB: number;
    opacity: number;
    wipe: number;
    threshold: number;
    notes: ReferencePointNote[];
    updatedAt: number;
};

const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

const luminance = (pixels: ReferencePixels, x: number, y: number) => {
    const sx = clamp(Math.round(x), 0, pixels.width - 1);
    const sy = clamp(Math.round(y), 0, pixels.height - 1);
    const index = (sy * pixels.width + sx) * 4;
    return (
        pixels.data[index] * 0.299 +
        pixels.data[index + 1] * 0.587 +
        pixels.data[index + 2] * 0.114
    );
};

export function boundedPixels(
    source: ReferencePixels,
    longestEdge = REFERENCE_WORK_EDGE,
): ReferencePixels {
    if (
        source.width <= 0 ||
        source.height <= 0 ||
        source.data.length < source.width * source.height * 4
    ) {
        throw new Error("Invalid reference image buffer");
    }
    const factor = Math.min(
        1,
        longestEdge / Math.max(source.width, source.height),
    );
    if (factor === 1) return source;
    const width = Math.max(1, Math.round(source.width * factor));
    const height = Math.max(1, Math.round(source.height * factor));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = Math.min(source.width - 1, Math.floor(x / factor));
            const sy = Math.min(source.height - 1, Math.floor(y / factor));
            const from = (sy * source.width + sx) * 4;
            const to = (y * width + x) * 4;
            data[to] = source.data[from];
            data[to + 1] = source.data[from + 1];
            data[to + 2] = source.data[from + 2];
            data[to + 3] = source.data[from + 3];
        }
    }
    return { width, height, data };
}

type Candidate = {
    dx: number;
    dy: number;
    scale: number;
    error: number;
    overlap: number;
};

function scoreCandidate(
    a: ReferencePixels,
    b: ReferencePixels,
    dx: number,
    dy: number,
    scale: number,
    sampleStep: number,
): Candidate {
    let sumA = 0;
    let sumB = 0;
    let sumAA = 0;
    let sumBB = 0;
    let sumAB = 0;
    let count = 0;
    const margin = Math.max(2, sampleStep);
    for (let ay = margin; ay < a.height - margin; ay += sampleStep) {
        for (let ax = margin; ax < a.width - margin; ax += sampleStep) {
            const bx = (ax - dx) / scale;
            const by = (ay - dy) / scale;
            if (
                bx < margin ||
                by < margin ||
                bx >= b.width - margin ||
                by >= b.height - margin
            ) {
                continue;
            }
            const av = luminance(a, ax, ay);
            const bv = luminance(b, bx, by);
            sumA += av;
            sumB += bv;
            sumAA += av * av;
            sumBB += bv * bv;
            sumAB += av * bv;
            count++;
        }
    }
    const expected =
        Math.ceil(a.width / sampleStep) * Math.ceil(a.height / sampleStep);
    const overlap = count / Math.max(1, expected);
    if (count < 24 || overlap < 0.28) {
        return { dx, dy, scale, error: Number.POSITIVE_INFINITY, overlap };
    }
    const covariance = sumAB - (sumA * sumB) / count;
    const varianceA = sumAA - (sumA * sumA) / count;
    const varianceB = sumBB - (sumB * sumB) / count;
    const denominator = Math.sqrt(Math.max(1e-6, varianceA * varianceB));
    const correlation = clamp(covariance / denominator, -1, 1);
    return { dx, dy, scale, error: 1 - correlation, overlap };
}

export function computeAlignment(
    sourceA: ReferencePixels,
    sourceB: ReferencePixels,
): ReferenceAlignment {
    let a: ReferencePixels;
    let b: ReferencePixels;
    try {
        a = boundedPixels(sourceA);
        b = boundedPixels(sourceB);
    } catch {
        return {
            ok: false,
            offsetX: 0,
            offsetY: 0,
            scale: 1,
            score: 0,
            overlap: 0,
            reason: "invalid",
        };
    }
    const mapX = sourceA.width / a.width;
    const mapY = sourceA.height / a.height;
    const maxShiftX = Math.min(Math.round(a.width * 0.28), 192);
    const maxShiftY = Math.min(Math.round(a.height * 0.28), 192);
    const scaleHypotheses = [0.92, 0.96, 1, 1.04, 1.08];
    const coarseStep = Math.max(2, Math.ceil(Math.max(a.width, a.height) / 96));
    const shiftStep = Math.max(2, Math.ceil(Math.max(a.width, a.height) / 48));
    let best: Candidate = {
        dx: 0,
        dy: 0,
        scale: 1,
        error: Number.POSITIVE_INFINITY,
        overlap: 0,
    };
    const seeds: Candidate[] = [];
    for (const scale of scaleHypotheses) {
        let seed: Candidate = {
            ...best,
            scale,
            error: Number.POSITIVE_INFINITY,
        };
        for (let dy = -maxShiftY; dy <= maxShiftY; dy += shiftStep) {
            for (let dx = -maxShiftX; dx <= maxShiftX; dx += shiftStep) {
                const candidate = scoreCandidate(
                    a,
                    b,
                    dx,
                    dy,
                    scale,
                    coarseStep,
                );
                if (candidate.error < seed.error) seed = candidate;
            }
        }
        seeds.push(seed);
    }
    for (const seed of seeds) {
        for (const scale of [
            seed.scale - 0.01,
            seed.scale,
            seed.scale + 0.01,
        ]) {
            for (
                let dy = seed.dy - shiftStep;
                dy <= seed.dy + shiftStep;
                dy += Math.max(1, Math.floor(shiftStep / 4))
            ) {
                for (
                    let dx = seed.dx - shiftStep;
                    dx <= seed.dx + shiftStep;
                    dx += Math.max(1, Math.floor(shiftStep / 4))
                ) {
                    const candidate = scoreCandidate(
                        a,
                        b,
                        dx,
                        dy,
                        scale,
                        Math.max(2, Math.floor(coarseStep / 2)),
                    );
                    if (candidate.error < best.error) best = candidate;
                }
            }
        }
    }
    const refined = { ...best };
    for (let dy = refined.dy - 3; dy <= refined.dy + 3; dy++) {
        for (let dx = refined.dx - 3; dx <= refined.dx + 3; dx++) {
            const candidate = scoreCandidate(
                a,
                b,
                dx,
                dy,
                refined.scale,
                Math.max(2, Math.floor(coarseStep / 2)),
            );
            if (candidate.error < best.error) best = candidate;
        }
    }
    const score = clamp(1 - best.error, 0, 1);
    const ok =
        Number.isFinite(best.error) && score >= 0.58 && best.overlap >= 0.3;
    return {
        ok,
        offsetX: best.dx * mapX,
        offsetY: best.dy * mapY,
        scale:
            (best.scale * (sourceA.width / a.width)) /
            (sourceB.width / b.width),
        score,
        overlap: best.overlap,
        reason: ok ? undefined : "no-match",
    };
}

export function computePixelDiff(
    a: ReferencePixels,
    b: ReferencePixels,
    options: {
        offsetX?: number;
        offsetY?: number;
        scale?: number;
        threshold?: number;
    } = {},
): ReferencePixels {
    const width = a.width;
    const height = a.height;
    if (width * height > REFERENCE_EXPORT_PIXELS)
        throw new Error("Difference image exceeds 16MP");
    const data = new Uint8ClampedArray(width * height * 4);
    const offsetX = options.offsetX ?? 0;
    const offsetY = options.offsetY ?? 0;
    const scale = options.scale ?? 1;
    const threshold = clamp(options.threshold ?? 24, 0, 255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const bx = Math.round((x - offsetX) / scale);
            const by = Math.round((y - offsetY) / scale);
            const out = (y * width + x) * 4;
            if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) {
                data[out] = 255;
                data[out + 1] = 64;
                data[out + 2] = 64;
                data[out + 3] = 220;
                continue;
            }
            const ai = out;
            const bi = (by * b.width + bx) * 4;
            const difference = Math.max(
                Math.abs(a.data[ai] - b.data[bi]),
                Math.abs(a.data[ai + 1] - b.data[bi + 1]),
                Math.abs(a.data[ai + 2] - b.data[bi + 2]),
            );
            if (difference >= threshold) {
                data[out] = 255;
                data[out + 1] = Math.max(28, 196 - difference / 2);
                data[out + 2] = 72;
                data[out + 3] = 235;
            } else {
                const gray = Math.round(luminance(a, x, y) * 0.28);
                data[out] = gray;
                data[out + 1] = gray;
                data[out + 2] = gray;
                data[out + 3] = 190;
            }
        }
    }
    return { width, height, data };
}

export function normalizeReferenceNotes(value: unknown): ReferencePointNote[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, REFERENCE_MAX_NOTES).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const note = entry as Partial<ReferencePointNote>;
        if (typeof note.id !== "string" || typeof note.text !== "string")
            return [];
        if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) return [];
        return [
            {
                id: note.id.slice(0, 80),
                x: clamp(note.x as number, 0, 1),
                y: clamp(note.y as number, 0, 1),
                text: note.text.trim().slice(0, 500),
            },
        ];
    });
}

export function isReferenceComparisonSession(
    value: unknown,
): value is ReferenceComparisonSession {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<ReferenceComparisonSession>;
    return (
        typeof session.id === "string" &&
        typeof session.name === "string" &&
        typeof session.aId === "string" &&
        typeof session.bId === "string" &&
        ["side", "opacity", "wipe", "diff"].includes(session.mode ?? "") &&
        ["fit", "actual"].includes(session.zoomMode ?? "") &&
        Number.isFinite(session.zoom) &&
        Number.isFinite(session.scaleB) &&
        Number.isFinite(session.opacity) &&
        Number.isFinite(session.wipe) &&
        Number.isFinite(session.threshold) &&
        normalizeReferenceNotes(session.notes).length ===
            (session.notes?.length ?? 0)
    );
}

const toSavedMode = (
    mode: ReferenceCompareMode,
): SavedComparisonSession["mode"] =>
    ({
        side: "side-by-side",
        opacity: "overlay",
        wipe: "slider",
        diff: "difference",
    })[mode] as SavedComparisonSession["mode"];

const fromSavedMode = (
    mode: SavedComparisonSession["mode"],
): ReferenceCompareMode =>
    ({
        "side-by-side": "side",
        overlay: "opacity",
        slider: "wipe",
        difference: "diff",
    })[mode] as ReferenceCompareMode;

export function toSavedComparisonSession(
    session: ReferenceComparisonSession,
): SavedComparisonSession {
    return {
        id: session.id,
        name: session.name,
        itemIds: [session.aId, session.bId],
        mode: toSavedMode(session.mode),
        zoomMode: session.zoomMode,
        zoom: session.zoom,
        panX: session.pan.x,
        panY: session.pan.y,
        offsetX: session.offsetB.x,
        offsetY: session.offsetB.y,
        scale: session.scaleB,
        opacity: session.opacity,
        wipe: session.wipe,
        threshold: session.threshold,
        notes: normalizeReferenceNotes(session.notes),
        updatedAt: new Date(session.updatedAt).toISOString(),
    };
}

export function fromSavedComparisonSession(
    session: SavedComparisonSession,
): ReferenceComparisonSession | null {
    if (!Array.isArray(session.itemIds) || session.itemIds.length < 2)
        return null;
    return {
        id: session.id,
        name: session.name,
        aId: session.itemIds[0],
        bId: session.itemIds[1],
        mode: fromSavedMode(session.mode),
        zoomMode: session.zoomMode ?? "fit",
        zoom: clamp(session.zoom, 0.1, 8),
        pan: { x: session.panX, y: session.panY },
        offsetB: { x: session.offsetX, y: session.offsetY },
        scaleB: clamp(session.scale, 0.5, 2),
        opacity: clamp(session.opacity ?? 50, 0, 100),
        wipe: clamp(session.wipe ?? 50, 0, 100),
        threshold: clamp(session.threshold, 0, 100),
        notes: normalizeReferenceNotes(session.notes),
        updatedAt: Date.parse(session.updatedAt) || Date.now(),
    };
}
