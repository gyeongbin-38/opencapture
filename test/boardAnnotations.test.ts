import { describe, expect, it } from "vitest";
import {
    alignBoardNodes,
    anchorPoint,
    applyBoardStyle,
    boardExportPlan,
    distributeBoardNodes,
    renumberBoardSteps,
    resolvedNodePoints,
    setBoardVertex,
    toggleChecklistLine,
} from "../lib/boardAnnotations";
import type {
    BoardDocument,
    BoardNode,
    BoardNodeKind,
} from "../lib/captureBoard";

const node = (
    id: string,
    kind: BoardNodeKind = "rect",
    x = 0,
    y = 0,
): BoardNode => ({
    id,
    kind,
    x,
    y,
    width: 100,
    height: 50,
    rotation: 0,
    visible: true,
    locked: false,
    style: {
        fill: "transparent",
        stroke: "#000000",
        strokeWidth: 2,
        fontSize: 16,
    },
});

const documentWith = (...nodes: BoardNode[]): BoardDocument => ({
    version: 1,
    id: "board",
    revision: 1,
    name: "Board",
    updatedAt: "2026-10-11T00:00:00.000Z",
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { autoAdd: true, focusIds: [], preset: "design" },
    nodes,
    styles: [],
});

describe("board annotation geometry", () => {
    it("keeps a normalized anchor attached after image move and resize", () => {
        const image = node("image", "image", 120, 80);
        image.width = 240;
        image.height = 120;
        expect(anchorPoint({ x: 0.25, y: 0.75 }, image)).toEqual({
            x: 180,
            y: 170,
        });
        image.x = 300;
        image.y = 220;
        image.width = 400;
        image.height = 200;
        expect(anchorPoint({ x: 0.25, y: 0.75 }, image)).toEqual({
            x: 400,
            y: 370,
        });
    });

    it("resolves both endpoints from image anchors", () => {
        const left = node("left", "image", 0, 0);
        const right = node("right", "image", 300, 200);
        const arrow = node("arrow", "arrow", 0, 0);
        arrow.points = [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
        ];
        arrow.anchor = { nodeId: "left", x: 1, y: 0.5 };
        arrow.endAnchor = { nodeId: "right", x: 0, y: 0.5 };
        expect(resolvedNodePoints(arrow, [left, right, arrow])).toEqual([
            { x: 100, y: 25 },
            { x: 300, y: 225 },
        ]);
    });

    it("renumbers step annotations after deletion and reorder", () => {
        const first = node("first", "step");
        const second = node("second", "step");
        const third = node("third", "step");
        const nodes = [third, node("shape"), first];
        renumberBoardSteps(nodes);
        expect(third.text).toBe("1");
        expect(first.text).toBe("2");
        expect(second.text).toBeUndefined();
    });

    it("edits polygon vertices in local coordinates and respects locks", () => {
        const polygon = node("polygon", "polygon", 20, 30);
        polygon.points = [{ x: 5, y: 6 }];
        expect(setBoardVertex(polygon, 0, { x: 90, y: 100 })).toBe(true);
        expect(polygon.points[0]).toEqual({ x: 70, y: 70 });
        polygon.locked = true;
        expect(setBoardVertex(polygon, 0, { x: 0, y: 0 })).toBe(false);
        expect(polygon.points[0]).toEqual({ x: 70, y: 70 });
    });

    it("aligns, distributes, and styles only editable selections", () => {
        const a = node("a", "rect", 10, 10);
        const b = node("b", "ellipse", 130, 30);
        const c = node("c", "text", 410, 70);
        const locked = node("locked", "rect", 999, 999);
        locked.locked = true;
        const document = documentWith(a, b, c, locked);
        alignBoardNodes(document, ["a", "b", "c", "locked"], "top");
        expect([a.y, b.y, c.y]).toEqual([10, 10, 10]);
        expect(locked.y).toBe(999);
        distributeBoardNodes(document, ["a", "b", "c"], "horizontal");
        expect(b.x).toBe(210);
        applyBoardStyle(document, ["a", "b", "locked"], {
            stroke: "#ff0000",
            strokeWidth: 6,
        });
        expect(a.style).toMatchObject({ stroke: "#ff0000", strokeWidth: 6 });
        expect(b.style).toMatchObject({ stroke: "#ff0000", strokeWidth: 6 });
        expect(locked.style.stroke).toBe("#000000");
    });

    it("toggles only valid checklist lines", () => {
        const text = "[ ] 확인하기\n일반 메모\n[x] 완료";
        expect(toggleChecklistLine(text, 0)).toBe(
            "[x] 확인하기\n일반 메모\n[x] 완료",
        );
        expect(toggleChecklistLine(text, 2)).toBe(
            "[ ] 확인하기\n일반 메모\n[ ] 완료",
        );
        expect(toggleChecklistLine(text, 1)).toBe(text);
    });

    it("bounds raster export and excludes hidden geometry", () => {
        const left = node("left", "image", -50, 20);
        left.width = 5000;
        left.height = 2000;
        const hidden = node("hidden", "rect", 50_000, 50_000);
        hidden.visible = false;
        const plan = boardExportPlan([left, hidden], 4_000_000);
        expect(plan.bounds).toEqual({
            x: -50,
            y: 20,
            width: 5000,
            height: 2000,
        });
        expect(plan.width * plan.height).toBeLessThanOrEqual(4_000_000);
        expect(plan.scale).toBeCloseTo(Math.sqrt(0.4));
    });
});
