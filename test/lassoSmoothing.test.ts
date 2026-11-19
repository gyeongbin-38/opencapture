import { describe, expect, it } from "vitest";
import { simplifyLassoPoints } from "../lib/lassoSmoothing";

describe("lasso smoothing", () => {
    it("collapses each straight leg to its endpoints", () => {
        const points = [
            { x: 0, y: 0 },
            { x: 25, y: 4.1 },
            { x: 50, y: 8 },
            { x: 75, y: 3.9 },
            { x: 100, y: 0 },
        ];
        expect(simplifyLassoPoints(points, 2)).toEqual([
            { x: 0, y: 0 },
            { x: 50, y: 8 },
            { x: 100, y: 0 },
        ]);
    });

    it("keeps deliberate corners while removing jitter", () => {
        const points = [
            { x: 0, y: 0 },
            { x: 25, y: 0.4 },
            { x: 50, y: -0.4 },
            { x: 75, y: 0.3 },
            { x: 100, y: 0 },
            { x: 100.4, y: 20 },
            { x: 99.7, y: 40 },
            { x: 100, y: 60 },
        ];
        expect(simplifyLassoPoints(points, 2)).toEqual([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 60 },
        ]);
    });

    it("always preserves the first and last point", () => {
        const points = Array.from({ length: 40 }, (_, i) => ({
            x: i * 3,
            y: Math.sin(i / 3) * 12,
        }));
        const out = simplifyLassoPoints(points, 4);
        expect(out[0]).toEqual(points[0]);
        expect(out.at(-1)).toEqual(points.at(-1));
        expect(out.length).toBeLessThan(points.length);
    });

    it("returns the stroke untouched when too few points exist", () => {
        for (const points of [
            [],
            [{ x: 1, y: 1 }],
            [
                { x: 0, y: 0 },
                { x: 5, y: 5 },
            ],
            [
                { x: 0, y: 0 },
                { x: 5, y: 5 },
                { x: 9, y: 0 },
            ],
        ]) {
            expect(simplifyLassoPoints(points, 5)).toEqual(points);
        }
    });

    it("keeps a degenerate near-line stroke valid instead of collapsing it", () => {
        const points = [
            { x: 0, y: 0 },
            { x: 10, y: 0.1 },
            { x: 20, y: 0 },
            { x: 30, y: -0.1 },
            { x: 40, y: 0 },
        ];
        const out = simplifyLassoPoints(points, 2);
        expect(out.length).toBe(points.length);
    });

    it("passes every point through at zero or negative tolerance", () => {
        const points = [
            { x: 0, y: 0 },
            { x: 10, y: 0.1 },
            { x: 20, y: 0 },
            { x: 30, y: -0.1 },
            { x: 40, y: 0 },
        ];
        expect(simplifyLassoPoints(points, 0)).toEqual(points);
        expect(simplifyLassoPoints(points, -1)).toEqual(points);
    });

    it("does not mutate the input stroke", () => {
        const points = [
            { x: 0, y: 0 },
            { x: 10, y: 0.1 },
            { x: 20, y: 0 },
            { x: 30, y: -0.1 },
            { x: 40, y: 0 },
        ];
        const snapshot = [...points];
        simplifyLassoPoints(points, 2);
        expect(points).toEqual(snapshot);
    });
});
