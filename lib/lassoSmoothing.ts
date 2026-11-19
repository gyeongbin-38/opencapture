export type LassoPoint = { x: number; y: number };

export type LassoSmoothingLevel = "off" | "light" | "normal";

/**
 * Tolerance for a smoothing level in canvas px. `off` disables
 * simplification outright; `light` halves the base so deliberate detail
 * survives. The base scales with zoom so the effective smoothing stays
 * roughly 3 screen px at any magnification.
 */
export function lassoTolerance(level: LassoSmoothingLevel, zoom: number) {
    if (level === "off") return 0;
    const base = Math.max(1.2, 3 / zoom);
    return level === "light" ? base * 0.5 : base;
}

function distanceToSegmentSq(p: LassoPoint, a: LassoPoint, b: LassoPoint) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        const px = p.x - a.x;
        const py = p.y - a.y;
        return px * px + py * py;
    }
    const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
    );
    const qx = a.x + t * dx - p.x;
    const qy = a.y + t * dy - p.y;
    return qx * qx + qy * qy;
}

/**
 * Douglas-Peucker simplification for a hand-drawn lasso stroke.
 * Keeps both endpoints and every point farther than `tolerance` from the
 * straight chord between its neighbours, so hand jitter disappears while
 * deliberate corners survive. Returns a copy; the input is untouched.
 */
export function simplifyLassoPoints(
    points: readonly LassoPoint[],
    tolerance: number,
): LassoPoint[] {
    if (points.length <= 3 || tolerance <= 0) return [...points];
    const tolSq = tolerance * tolerance;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop() as [number, number];
        let maxSq = tolSq;
        let index = -1;
        for (let i = a + 1; i < b; i++) {
            const d = distanceToSegmentSq(points[i], points[a], points[b]);
            if (d > maxSq) {
                maxSq = d;
                index = i;
            }
        }
        if (index >= 0) {
            keep[index] = 1;
            stack.push([a, index], [index, b]);
        }
    }
    const out = points.filter((_, i) => keep[i]);
    // A polygon needs at least 3 vertices; if the stroke was so thin that
    // everything collapses onto the chord, keep the raw points instead.
    return out.length >= 3 ? out : [...points];
}
