import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
    selectionEdgesForMode,
    windowEdgeAtPoint,
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
    ts.ScriptKind.TS,
);
const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.getText(source) === "inEdge",
);
if (!declaration)
    throw new Error("Production inEdge declaration missing");
const javascript = ts.transpileModule(
    `globalThis.inEdge = ${declaration.getText(source)};`,
    {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
        },
    },
).outputText;

function harness() {
    const setClipCursor = vi.fn();
    const setEdge = vi.fn();
    const state = {
        captureSelectionMode: "window",
        rectSelect: false,
        direction: "",
        edgeRect: [
            { x: 10, y: 10, width: 100, height: 100, type: "system" },
            { x: 200, y: 200, width: 50, height: 50, type: "image" },
        ],
        rectInRect: [],
        识别窗口: true,
        setClipCursor,
        setEdge,
        windowEdgeAtPoint,
        selectionEdgesForMode,
    };
    const context = vm.createContext(state);
    vm.runInContext(javascript, context, { filename: filename.pathname });
    return {
        state,
        inEdge: context.inEdge as (p: { x: number; y: number }) => void,
    };
}

describe("production inEdge window-mode cursor", () => {
    it("shows a pointer over a system window candidate", () => {
        const h = harness();
        h.inEdge({ x: 50, y: 50 });
        expect(h.state.setEdge).toHaveBeenCalledWith([[10, 10, 100, 100]], true);
        expect(h.state.setClipCursor).toHaveBeenCalledWith("pointer");
    });

    it("keeps the crosshair when no candidate is under the pointer", () => {
        const h = harness();
        h.inEdge({ x: 150, y: 150 });
        expect(h.state.setEdge).toHaveBeenCalledWith([], true);
        expect(h.state.setClipCursor).toHaveBeenCalledWith("crosshair");
    });

    it("does not override resize/move cursors while direction is active", () => {
        const h = harness();
        h.state.direction = "nw";
        h.inEdge({ x: 50, y: 50 });
        expect(h.state.setEdge).toHaveBeenCalledWith([[10, 10, 100, 100]], true);
        expect(h.state.setClipCursor).not.toHaveBeenCalled();
    });

    it("still previews window candidates when a rect selection exists", () => {
        const h = harness();
        h.state.rectSelect = true;
        h.inEdge({ x: 50, y: 50 });
        expect(h.state.setEdge).toHaveBeenCalledWith([[10, 10, 100, 100]], true);
        expect(h.state.setClipCursor).toHaveBeenCalledWith("pointer");
    });

    it("region mode clears edges under an existing selection", () => {
        const h = harness();
        h.state.captureSelectionMode = "region";
        h.state.rectSelect = true;
        h.inEdge({ x: 50, y: 50 });
        expect(h.state.setEdge).toHaveBeenCalledWith([]);
        expect(h.state.setClipCursor).not.toHaveBeenCalled();
    });
});
