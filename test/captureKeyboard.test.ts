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
    ts.ScriptKind.TS,
);
const assignment = source.statements.find(
    (node): node is ts.ExpressionStatement =>
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.expression.left.getText(source) === "document.body.onkeydown" &&
        ts.isArrowFunction(node.expression.right),
);
if (!assignment || !ts.isBinaryExpression(assignment.expression))
    throw new Error("Production document.body.onkeydown assignment missing");
const handler = assignment.expression.right;
const javascript = ts.transpileModule(
    `globalThis.handleKey = ${handler.getText(source)};`,
    {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
        },
    },
).outputText;

function harness() {
    const moveRect = vi.fn();
    const state = {
        captureHelp: { el: { hidden: true } },
        longRunning: false,
        hotkeys: { getScope: () => "all" },
        captureSelectionMode: "region",
        captureWorkspace: { showStatus: vi.fn() },
        nowType: "select",
        direction: "move",
        nowMouseE: { offsetX: 100, offsetY: 100 },
        isRect: true,
        finalRect: [10, 20, 80, 60],
        freeSelect: [],
        mainCanvas: { width: 640, height: 480 },
        editorP: { x: 0, y: 0, zoom: 1 },
        rectSelect: true,
        strokeWidthEl: { gv: 2 },
        strokeWidthF: { set: vi.fn() },
        moveRect,
        movePoly: vi.fn(),
        drawClip: vi.fn(),
        ckx: vi.fn(),
        e2srcPoint: vi.fn(() => ({ x: 100, y: 100 })),
        finalRectFix: vi.fn(),
        followBar: vi.fn(),
        setEditorP: vi.fn(),
        mouseBar: vi.fn(),
        document: {
            body: { classList: { add: vi.fn() } },
        },
        Math,
    };
    const context = vm.createContext(state);
    vm.runInContext(javascript, context, { filename: filename.pathname });
    return {
        state,
        handleKey: context.handleKey as (event: KeyboardEvent) => void,
    };
}

function keyEvent(
    key: string,
    modifiers: Partial<
        Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
    > = {},
) {
    return {
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: { tagName: "BODY", isContentEditable: false },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...modifiers,
    } as unknown as KeyboardEvent;
}

describe("production capture keyboard movement", () => {
    it("can adjust a selection before the first pointer movement", () => {
        const h = harness();
        Object.assign(h.state, { nowMouseE: undefined });
        expect(() => h.handleKey(keyEvent("ArrowDown"))).not.toThrow();
        expect(h.state.moveRect).toHaveBeenCalledOnce();
    });
    it.each(["w", "a", "s", "d"])(
        "does not alter a system window with %s",
        (key) => {
            const h = harness();
            h.state.captureSelectionMode = "window";
            h.handleKey(keyEvent(key));
            expect(h.state.moveRect).not.toHaveBeenCalled();
            expect(h.state.captureWorkspace.showStatus).toHaveBeenCalledOnce();
        },
    );
    it.each([
        ["s", { ctrlKey: true }],
        ["a", { ctrlKey: true }],
        ["s", { metaKey: true }],
        ["a", { metaKey: true }],
        ["d", { altKey: true }],
    ])(
        "leaves modified %s shortcuts for their command handlers",
        (key, modifiers) => {
            const h = harness();
            const event = keyEvent(key, modifiers);
            h.handleKey(event);
            expect(h.state.moveRect).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["w", { x: 100, y: 99 }],
        ["a", { x: 99, y: 100 }],
        ["s", { x: 100, y: 101 }],
        ["d", { x: 101, y: 100 }],
    ])("preserves unmodified %s movement", (key, expected) => {
        const h = harness();
        const event = keyEvent(key);
        h.handleKey(event);
        expect(h.state.moveRect).toHaveBeenCalledWith(
            h.state.finalRect,
            { x: 100, y: 100 },
            expected,
        );
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it("preserves Ctrl+Arrow movement at five pixels", () => {
        const h = harness();
        const event = keyEvent("ArrowDown", { ctrlKey: true });
        h.handleKey(event);
        expect(h.state.moveRect).toHaveBeenCalledWith(
            h.state.finalRect,
            { x: 100, y: 100 },
            { x: 100, y: 105 },
        );
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it("preserves Shift+Arrow movement at ten pixels", () => {
        const h = harness();
        const event = keyEvent("ArrowRight", { shiftKey: true });
        h.handleKey(event);
        expect(h.state.moveRect).toHaveBeenCalledWith(
            h.state.finalRect,
            { x: 100, y: 100 },
            { x: 110, y: 100 },
        );
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });
});
