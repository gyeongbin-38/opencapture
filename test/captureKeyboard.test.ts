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
        drawBarOpen: false,
        fabricCanvas: {
            getActiveObject: vi.fn(() => null),
            requestRenderAll: vi.fn(),
        },
        nudgePushSoon: vi.fn(),
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
    it.each(["a", "d", "ArrowUp", "ArrowLeft"])(
        "does not alter a system window with %s",
        (key) => {
            const h = harness();
            h.state.captureSelectionMode = "window";
            h.handleKey(keyEvent(key));
            expect(h.state.moveRect).not.toHaveBeenCalled();
            expect(h.state.captureWorkspace.showStatus).toHaveBeenCalledOnce();
        },
    );
    it.each(["w", "s"])(
        "leaves %s for the mode hotkeys in window mode",
        (key) => {
            const h = harness();
            h.state.captureSelectionMode = "window";
            const event = keyEvent(key);
            h.handleKey(event);
            expect(h.state.moveRect).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
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

    it.each(["w", "a", "s", "d"])(
        "leaves unmodified %s for letter hotkeys instead of nudging",
        (key) => {
            const h = harness();
            const event = keyEvent(key);
            h.handleKey(event);
            expect(h.state.moveRect).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["ArrowUp", { x: 100, y: 99 }],
        ["ArrowLeft", { x: 99, y: 100 }],
        ["ArrowDown", { x: 100, y: 101 }],
        ["ArrowRight", { x: 101, y: 100 }],
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
        expect(event.stopPropagation).not.toHaveBeenCalled();
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

    it("nudges the active fabric object with arrows while annotating", () => {
        const h = harness();
        const obj = {
            left: 50,
            top: 60,
            set: vi.fn(function (
                this: { left: number; top: number },
                key: string,
                value: number,
            ) {
                this[key as "left" | "top"] = value;
            }),
            setCoords: vi.fn(),
        };
        Object.assign(h.state, {
            drawBarOpen: true,
            direction: "",
            fabricCanvas: {
                getActiveObject: () => obj,
                requestRenderAll: vi.fn(),
            },
        });
        const event = keyEvent("ArrowRight", { shiftKey: true });
        h.handleKey(event);
        expect(obj.left).toBe(60);
        expect(obj.top).toBe(60);
        expect(obj.setCoords).toHaveBeenCalledOnce();
        expect(h.state.nudgePushSoon).toHaveBeenCalledOnce();
        expect(h.state.moveRect).not.toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });

    it("keeps selection movement when the draw bar is closed", () => {
        const h = harness();
        Object.assign(h.state, {
            fabricCanvas: {
                getActiveObject: () => ({ left: 0, top: 0 }),
                requestRenderAll: vi.fn(),
            },
        });
        const event = keyEvent("ArrowRight");
        h.handleKey(event);
        expect(h.state.moveRect).toHaveBeenCalledOnce();
    });
});
