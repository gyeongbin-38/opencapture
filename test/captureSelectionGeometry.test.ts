import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
    selectionEdgesForMode,
    snapAdjustRect,
} from "../lib/captureWindowSelection";

const filename = new URL(
    "../src/renderer/clip/clip_window.ts",
    import.meta.url,
);
const source = ts.createSourceFile(
    filename.pathname,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
);
function production(
    name: string,
    globals: Record<string, unknown>,
    dependencies: string[] = [],
) {
    const node = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    if (!node) throw new Error(`Missing production function ${name}`);
    const context = vm.createContext(globals);
    const helpers = source.statements
        .filter(
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                Boolean(node.name && dependencies.includes(node.name.text)),
        )
        .map((node) => node.getFullText(source))
        .join("\n");
    vm.runInContext(
        ts.transpileModule(
            `${helpers}\n${node.getFullText(source)}\nglobalThis.subject = ${name}`,
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            },
        ).outputText,
        context,
    );
    return context as typeof globals & {
        subject: (...args: unknown[]) => unknown;
    };
}

describe("production capture selection geometry", () => {
    it.each([
        [{ x: -100, y: -100 }, [0, 0, 40, 30]],
        [{ x: 200, y: 200 }, [60, 50, 40, 30]],
    ])(
        "preserves selection size while moving against an edge",
        (point, expected) => {
            const h = production(
                "moveRect",
                {
                    finalRect: [30, 20, 40, 30],
                    mainCanvas: { width: 100, height: 80 },
                    direction: "move",
                    ratioLock: false,
                    ratioLockValue: 0,
                    adjustSnapMode: {
                        move: { x: "translate", y: "translate" },
                    },
                    snapAdjustRect,
                    selectionEdgesForMode,
                    edgeRect: [],
                    captureSelectionMode: "region",
                    识别窗口: false,
                    选区吸附: true,
                    吸附距离: 6,
                    batchRegions: [],
                    editorP: { zoom: 1 },
                    setSnapGuides: vi.fn(),
                },
                ["finalRectFix", "snapEdges"],
            );
            h.subject([30, 20, 40, 30], { x: 0, y: 0 }, point);
            expect(h.finalRect).toEqual(expected);
        },
    );
    it.each([
        [
            [-10, -5, 40, 30],
            [0, 0, 30, 25],
        ],
        [
            [110, 20, 30, 30],
            [100, 20, 0, 30],
        ],
        [
            [20, 90, 20, 20],
            [20, 80, 20, 0],
        ],
        [
            [-50, 10, 10, 20],
            [0, 10, 0, 20],
        ],
        [
            [70, 60, -100, -80],
            [0, 0, 70, 60],
        ],
        [
            [90, 70, 40, 30],
            [90, 70, 10, 10],
        ],
        [
            [10, 10, 20, 20],
            [10, 10, 20, 20],
        ],
    ])("clips %j to its visible intersection", (rect, expected) => {
        const h = production("finalRectFix", {
            finalRect: rect,
            mainCanvas: { width: 100, height: 80 },
        });
        h.subject();
        expect(h.finalRect).toEqual(expected);
    });
    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "does not pass %s into canvas extraction",
        (invalid) => {
            const h = production("finalRectFix", {
                finalRect: [invalid, 10, 20, 20],
                mainCanvas: { width: 100, height: 80 },
            });
            h.subject();
            expect(h.finalRect).toEqual([0, 0, 0, 0]);
        },
    );
    it("does not hit-test a zero-sized selection at the origin", () => {
        const h = production("isInClipRect", {
            finalRect: [0, 0, 0, 0],
            mainCanvas: { width: 100, height: 80 },
            direction: "东南",
            setClipCursor: vi.fn(),
            inRange: (a: number, v: number, b: number) => a <= v && v <= b,
            editorP: { zoom: 1 },
        });
        expect(h.subject({ x: 0, y: 0 })).toBe(false);
        expect(h.direction).toBe("");
    });
    it("restores the previous selection and polygon when a drag is interrupted", () => {
        const saved = {
            rect: [10, 20, 40, 30],
            points: [
                { x: 10, y: 20 },
                { x: 50, y: 20 },
                { x: 30, y: 50 },
            ],
            manual: true,
        };
        const h = production("cancelSelectionInteraction", {
            down: true,
            moved: true,
            selecting: true,
            moving: false,
            oFinalRect: null,
            oPoly: null,
            direction: "东南",
            selectionBeforeDrag: saved,
            finalRect: [30, 30, 5, 5],
            freeSelect: [],
            rectSelect: false,
            mouseBarEl: { el: { classList: { add: vi.fn() } } },
            drawClip: vi.fn(),
            showBars: vi.fn(),
            followBar: vi.fn(),
            isShowBars: true,
            finishHandleResize: vi.fn(),
            setSnapGuides: vi.fn(),
        });
        h.subject();
        expect(h.finalRect).toEqual(saved.rect);
        expect(h.freeSelect).toEqual(saved.points);
        expect([h.down, h.moved, h.selecting, h.moving]).toEqual([
            false,
            false,
            false,
            false,
        ]);
        expect(h.selectionBeforeDrag).toBeNull();
        expect(h.rectSelect).toBe(true);
    });
    it("rolls back a cancelled handle resize without committing history", () => {
        const releasePointerCapture = vi.fn();
        const h = production(
            "finishHandleResize",
            {
                handleDrag: {
                    rect: [10, 20, 40, 30],
                    pointerId: 7,
                    handle: {
                        hasPointerCapture: () => true,
                        releasePointerCapture,
                    },
                },
                finalRect: [15, 25, 20, 15],
                direction: "东南",
                mainCanvas: { width: 100, height: 80 },
                rememberLastRect: vi.fn(),
                hisPush: vi.fn(),
                drawClip: vi.fn(),
                followBar: vi.fn(),
                setSnapGuides: vi.fn(),
            },
            ["finalRectFix"],
        );
        h.subject(false);
        expect(h.finalRect).toEqual([10, 20, 40, 30]);
        expect(h.handleDrag).toBeNull();
        expect(h.hisPush).not.toHaveBeenCalled();
        expect(h.rememberLastRect).not.toHaveBeenCalled();
        expect(releasePointerCapture).toHaveBeenCalledWith(7);
    });
    it("commits the resized region only on a completed handle release", () => {
        const h = production(
            "finishHandleResize",
            {
                handleDrag: {
                    rect: [10, 20, 40, 30],
                    pointerId: 7,
                    handle: { hasPointerCapture: () => false },
                },
                finalRect: [15, 25, 20, 15],
                direction: "东南",
                mainCanvas: { width: 100, height: 80 },
                rememberLastRect: vi.fn(),
                hisPush: vi.fn(),
                drawClip: vi.fn(),
                followBar: vi.fn(),
                setSnapGuides: vi.fn(),
            },
            ["finalRectFix"],
        );
        h.subject(true);
        expect(h.finalRect).toEqual([15, 25, 20, 15]);
        expect(h.hisPush).toHaveBeenCalledOnce();
        expect(h.rememberLastRect).toHaveBeenCalledOnce();
    });
});
