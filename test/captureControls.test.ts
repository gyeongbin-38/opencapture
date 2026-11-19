import { describe, expect, it } from "vitest";
import {
    captureDock,
    dimBarX,
    dimBarY,
    evalDimExpression,
    fitCaptureToolbar,
    radialLayout,
    rectsOverlap,
    toolbarDock,
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

    it("docks the dimensions bar above or below per preference", () => {
        const noOverlap = () => false;
        const selection = { y: 200, height: 100 };
        expect(dimBarY(selection, 800, 30, false, noOverlap)).toBe(162);
        expect(dimBarY(selection, 800, 30, true, noOverlap)).toBe(308);
    });

    it("moves the dimensions bar inside toward the preferred edge", () => {
        const noOverlap = () => false;
        const tall = { y: 10, height: 560 };
        expect(dimBarY(tall, 600, 30, false, noOverlap)).toBe(18);
        expect(dimBarY(tall, 600, 30, true, noOverlap)).toBe(532);
    });

    it("avoids the toolbar and falls back to the far inside edge", () => {
        const selection = { y: 200, height: 100 };
        const toolbarAbove = (cy: number) => cy < 215;
        expect(dimBarY(selection, 800, 30, false, toolbarAbove)).toBe(
            200 + 100 - 30 - 8,
        );
        const toolbarInsideBottom = (cy: number) => cy > 230;
        expect(dimBarY(selection, 800, 30, true, toolbarInsideBottom)).toBe(
            200 + 8,
        );
    });

    it("clamps the dimensions bar inside the viewport for edge selections", () => {
        const noOverlap = () => false;
        expect(dimBarY({ y: 4, height: 20 }, 300, 30, false, noOverlap)).toBe(
            8,
        );
        expect(
            dimBarY({ y: 270, height: 20 }, 300, 30, true, noOverlap),
        ).toBe(300 - 30 - 8);
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

describe("dimBarX", () => {
    it("centers on the selection and clamps inside the viewport", () => {
        expect(
            dimBarX({ x: 100, width: 400 }, 1000, 200, 8),
        ).toBe(200);
        expect(dimBarX({ x: 0, width: 100 }, 1000, 200, 8)).toBe(8);
        expect(dimBarX({ x: 950, width: 40 }, 1000, 200, 8)).toBe(792);
    });
});

describe("toolbarDock", () => {
    const selection = { x: 100, y: 100, width: 300, height: 200 };
    const viewport = { width: 1000, height: 800 };
    const toolbar = { width: 240, height: 40 };

    it("clamps a pinned position inside the viewport", () => {
        expect(
            toolbarDock(selection, viewport, toolbar, {
                left: 2000,
                top: -50,
            }),
        ).toEqual({ x: 760, y: 0 });
    });

    it("falls back to captureDock without a pin", () => {
        expect(toolbarDock(selection, viewport, toolbar, null)).toEqual(
            captureDock(selection, viewport, toolbar),
        );
    });
});

describe("rectsOverlap", () => {
    it("detects intersection and edge-touch separation", () => {
        const a = { x: 0, y: 0, width: 100, height: 50 };
        expect(
            rectsOverlap(a, { x: 50, y: 25, width: 100, height: 50 }),
        ).toBe(true);
        expect(
            rectsOverlap(a, { x: 100, y: 0, width: 50, height: 50 }),
        ).toBe(false);
        expect(rectsOverlap(a, { x: 0, y: 50, width: 50, height: 50 })).toBe(
            false,
        );
    });
});

describe("evalDimExpression", () => {
    it("evaluates arithmetic and rejects anything else", () => {
        expect(evalDimExpression("300")).toBe(300);
        expect(evalDimExpression("100+50*2")).toBe(200);
        expect(evalDimExpression("(8-3)/5")).toBe(1);
        expect(evalDimExpression("alert(1)")).toBeNull();
        expect(evalDimExpression("1e3")).toBeNull();
        expect(evalDimExpression("")).toBeNull();
        expect(evalDimExpression("1/0")).toBeNull();
    });
});
