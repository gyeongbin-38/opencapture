import { describe, expect, it } from "vitest";
import {
    alignNodes,
    boundsOf,
    distributeNodes,
    layoutNodes,
    resizeNodes,
    snapNode,
    versionGroups,
} from "../lib/boardGeometry";
import type { BoardNode } from "../lib/captureBoard";

const image = (
    id: string,
    x: number,
    y: number,
    width = 100,
    height = 80,
): BoardNode => ({
    id,
    kind: "image",
    x,
    y,
    width,
    height,
    rotation: 0,
    visible: true,
    locked: false,
    assetId: `asset-${id}`,
    style: {
        fill: "transparent",
        stroke: "#fff",
        strokeWidth: 2,
        fontSize: 14,
    },
});

describe("board geometry", () => {
    it("lays captures out without changing dimensions or identities", () => {
        const nodes = [
            image("a", 20, 30),
            image("b", 300, 90, 120, 60),
            image("c", 50, 400),
        ];
        const grid = layoutNodes(nodes, "grid", 16);
        expect(
            grid.map(({ id, width, height }) => ({ id, width, height })),
        ).toEqual(
            nodes.map(({ id, width, height }) => ({ id, width, height })),
        );
        expect(grid.map(({ x, y }) => [x, y])).toEqual([
            [20, 30],
            [156, 30],
            [20, 126],
        ]);
    });

    it("snaps edges and centers but Alt bypass leaves geometry untouched", () => {
        const moving = image("moving", 196, 116, 100, 80);
        const target = image("target", 300, 40, 100, 160);
        const snapped = snapNode(moving, [target], 6);
        expect(snapped.node.x).toBe(200);
        expect(snapped.node.y).toBe(120);
        expect(snapped.guides.map((guide) => guide.axis)).toEqual(["x", "y"]);
        expect(snapNode(moving, [target], 6, true)).toEqual({
            node: moving,
            guides: [],
        });
    });

    it("snaps a capture to equal spacing between two references", () => {
        const moving = image("moving", 146, 20, 40, 40);
        const left = image("left", 20, 20, 80, 40);
        const right = image("right", 230, 20, 80, 40);
        const snapped = snapNode(moving, [left, right], 10);
        expect(snapped.node.x).toBe(145);
        expect(snapped.node.x - (left.x + left.width)).toBe(
            right.x - (snapped.node.x + snapped.node.width),
        );
    });

    it("resizes a group around its common bounds", () => {
        const nodes = [image("a", 10, 20, 40, 20), image("b", 70, 40, 40, 40)];
        const resized = resizeNodes(nodes, boundsOf(nodes), {
            x: 10,
            y: 20,
            width: 200,
            height: 120,
        });
        expect(resized[0]).toMatchObject({
            x: 10,
            y: 20,
            width: 80,
            height: 40,
        });
        expect(resized[1]).toMatchObject({
            x: 130,
            y: 60,
            width: 80,
            height: 80,
        });
    });

    it("aligns and distributes selected objects without reordering callers", () => {
        const nodes = [
            image("c", 260, 70, 40, 30),
            image("a", 20, 20, 40, 30),
            image("b", 160, 50, 40, 30),
        ];
        expect(alignNodes(nodes, "middle").map((node) => node.y)).toEqual([
            45, 45, 45,
        ]);
        const distributed = distributeNodes(nodes, "horizontal");
        expect(distributed.map((node) => node.id)).toEqual(["c", "a", "b"]);
        expect(distributed.find((node) => node.id === "b")?.x).toBe(140);
    });

    it("groups only image versions from the same canonical area", () => {
        const a = image("a", 0, 0);
        const b = image("b", 0, 0);
        const c = image("c", 0, 0);
        a.source = {
            itemId: "1",
            context: { kind: "capture" },
            areaKey: "screen:0:10,10,100,80",
        };
        b.source = {
            itemId: "2",
            context: { kind: "capture" },
            areaKey: "screen:0:10,10,100,80",
        };
        c.source = {
            itemId: "3",
            context: { kind: "capture" },
            areaKey: "screen:0:20,20,100,80",
        };
        const groups = versionGroups([a, b, c]);
        expect(groups.get(a.source.areaKey)?.map((node) => node.id)).toEqual([
            "a",
            "b",
        ]);
        expect(groups.get(c.source.areaKey)?.map((node) => node.id)).toEqual([
            "c",
        ]);
    });
});
