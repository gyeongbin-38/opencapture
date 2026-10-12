import { describe, expect, it } from "vitest";
import {
    captureDock,
    fitCaptureToolbar,
    radialLayout,
} from "../lib/captureControls";

describe("capture toolbar sizing", () => {
    const favorites = [
        "copy",
        "stage",
        "annotate",
        "pin",
        "ocr",
        "redact",
        "compare",
        "save",
    ] as const;
    const fixedWidth = 113;

    it("keeps required controls and fitting favorites within a 360px viewport", () => {
        const fit = fitCaptureToolbar(favorites, {
            viewportWidth: 360,
            favoriteWidth: 44,
            fixedWidth,
            gap: 2,
        });

        expect(fixedWidth + fit.visible.length * (44 + 2)).toBeLessThanOrEqual(
            360 - 24,
        );
        expect(fit.visible.length).toBeGreaterThan(0);
        expect([...fit.visible, ...fit.overflow]).toEqual(favorites);
        expect(fit.overflow.length).toBeGreaterThan(0);
    });

    it("shows every favorite when the viewport has room", () => {
        const fit = fitCaptureToolbar(favorites, {
            viewportWidth: 1024,
            favoriteWidth: 44,
            fixedWidth,
            gap: 2,
        });

        expect(fit.visible).toEqual(favorites);
        expect(fit.overflow).toEqual([]);
    });
});

describe("capture controls at screen edges", () => {
    it("places actions beneath the capture and flips above near the bottom", () => {
        const viewport = { width: 1200, height: 800 };
        const toolbar = { width: 260, height: 44 };
        expect(
            captureDock(
                { x: 200, y: 150, width: 500, height: 300 },
                viewport,
                toolbar,
            ),
        ).toEqual({ x: 320, y: 462 });
        expect(
            captureDock(
                { x: 900, y: 700, width: 300, height: 90 },
                viewport,
                toolbar,
            ),
        ).toEqual({ x: 920, y: 644 });
    });

    it("keeps the whole toolbar reachable for tiny selections at either edge", () => {
        const viewport = { width: 360, height: 300 };
        const toolbar = { width: 260, height: 44 };
        for (const x of [0, 355]) {
            const dock = captureDock(
                { x, y: 0, width: 5, height: 5 },
                viewport,
                toolbar,
            );
            expect(dock.x).toBeGreaterThanOrEqual(12);
            expect(dock.x + toolbar.width).toBeLessThanOrEqual(348);
            expect(dock.y).toBeGreaterThanOrEqual(12);
        }
    });

    it("moves the radial center as a group without overlapping edge buttons", () => {
        for (const pointer of [
            { x: 0, y: 0 },
            { x: 1920, y: 1080 },
        ]) {
            const layout = radialLayout(
                pointer,
                { width: 1920, height: 1080 },
                8,
                44,
            );
            for (const point of layout.points) {
                expect(point.x - 22).toBeGreaterThanOrEqual(12);
                expect(point.y - 22).toBeGreaterThanOrEqual(12);
                expect(point.x + 22).toBeLessThanOrEqual(1908);
                expect(point.y + 22).toBeLessThanOrEqual(1068);
            }
            for (let i = 0; i < layout.points.length; i++) {
                const a = layout.points[i];
                const b = layout.points[(i + 1) % layout.points.length];
                expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(48);
            }
        }
    });
});
