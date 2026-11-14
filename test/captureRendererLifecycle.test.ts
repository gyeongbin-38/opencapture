import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

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
const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "setScreen",
);
if (!declaration) throw new Error("Production setScreen declaration missing");
const javascript = ts.transpileModule(
    `${declaration.getFullText(source)}\nglobalThis.applyScreen = setScreen;`,
    {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
        },
    },
).outputText;

function harness() {
    const state = {
        captureInitSequence: 1,
        screenRequestSequence: 0,
        screenShotCache: new Map(),
        mainCanvas: { width: 100, height: 80 },
        drawCanvas: { width: 100, height: 80 },
        fabricCanvas: {
            width: 100,
            height: 80,
            setDimensions(size: { width: number; height: number }) {
                this.width = size.width;
                this.height = size.height;
            },
        },
        nowScreenId: 1,
        captureSelectionMode: "region",
        captureSourceContext: { kind: "capture" },
        rectSelect: true,
        finalRect: [10, 10, 20, 20],
        记忆框选: false,
        edgeRect: [],
        setClipSize: vi.fn(),
        toCanvas: vi.fn(),
        getWin: vi.fn(),
        drawClipRect: vi.fn(),
        showBars: vi.fn(),
        t: (value: string) => value,
        window: { innerWidth: 800, innerHeight: 600 },
        document: { body: { classList: { add: vi.fn() } } },
        console: { error: vi.fn() },
    };
    const context = vm.createContext(state);
    vm.runInContext(javascript, context);
    return context as typeof state & {
        applyScreen(screen: {
            id: number;
            capture(): Promise<unknown>;
        }): Promise<boolean>;
    };
}
const frame = (width = 4, height = 3) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
});
const screen = (id: number, image = frame()) => ({
    id,
    capture: async () => ({ toImageData: () => image }),
});

describe("production capture renderer acquisition", () => {
    it("reports provider errors without replacing the current pixels or screen", async () => {
        const h = harness();
        await expect(
            h.applyScreen({
                id: 2,
                capture: async () => {
                    throw new Error("native capture failed");
                },
            }),
        ).rejects.toThrow("native capture failed");
        expect(h.mainCanvas).toEqual({ width: 100, height: 80 });
        expect(h.nowScreenId).toBe(1);
        expect(h.toCanvas).not.toHaveBeenCalled();
    });

    it("rejects empty and malformed frames before changing the current canvas", async () => {
        for (const image of [
            frame(0, 0),
            { ...frame(), data: new Uint8ClampedArray(1) },
        ]) {
            const h = harness();
            await expect(h.applyScreen(screen(2, image))).rejects.toThrow();
            expect(h.mainCanvas).toEqual({ width: 100, height: 80 });
            expect(h.nowScreenId).toBe(1);
            expect(h.toCanvas).not.toHaveBeenCalled();
        }
    });

    it("commits a valid acquired frame exactly once", async () => {
        const h = harness();
        expect(await h.applyScreen(screen(2))).toBe(true);
        expect(h.mainCanvas).toEqual({ width: 4, height: 3 });
        expect([h.fabricCanvas.width, h.fabricCanvas.height]).toEqual([4, 3]);
        expect(h.nowScreenId).toBe(2);
        expect(h.toCanvas).toHaveBeenCalledTimes(1);
    });

    it("starts a new screen capture without a preselected rectangle", async () => {
        const h = harness();
        await h.applyScreen(screen(2));
        expect(h.finalRect).toEqual([0, 0, 0, 0]);
        expect(h.rectSelect).toBe(false);
    });

    it("keeps the full image selected when opening an imported image", async () => {
        const h = harness();
        h.captureSourceContext.kind = "import";
        await h.applyScreen(screen(2));
        expect(h.finalRect).toEqual([0, 0, 4, 3]);
    });

    it("discards a late previous screen result", async () => {
        const h = harness();
        let release: (value: unknown) => void = () => {};
        const first = h.applyScreen({
            id: 2,
            capture: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        await h.applyScreen(screen(3));
        release({ toImageData: () => frame(8, 6) });
        expect(await first).toBe(false);
        expect(h.nowScreenId).toBe(3);
        expect(h.mainCanvas).toEqual({ width: 4, height: 3 });
        expect(h.toCanvas).toHaveBeenCalledTimes(1);
    });
});
