import { describe, expect, it } from "vitest";
import {
    type StagedRegion,
    stagedRegionAt,
} from "../src/renderer/clip/captureStaging";

const tri: StagedRegion = {
    rect: [100, 100, 100, 100],
    key: 1,
    points: [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 100, y: 200 },
    ],
};

describe("stagedRegionAt", () => {
    it("hits a rect region inside its bounds", () => {
        const r: StagedRegion = { rect: [10, 20, 30, 40], key: 2 };
        expect(stagedRegionAt([r], 15, 25)).toBe(r);
        expect(stagedRegionAt([r], 40, 60)).toBe(r);
    });

    it("misses outside bounds and on empty list", () => {
        const r: StagedRegion = { rect: [10, 20, 30, 40] };
        expect(stagedRegionAt([r], 9, 25)).toBeNull();
        expect(stagedRegionAt([r], 15, 61)).toBeNull();
        expect(stagedRegionAt([], 15, 25)).toBeNull();
    });

    it("prefers the topmost (later) region on overlap", () => {
        const below: StagedRegion = { rect: [0, 0, 100, 100], key: 1 };
        const above: StagedRegion = { rect: [50, 50, 100, 100], key: 2 };
        expect(stagedRegionAt([below, above], 75, 75)).toBe(above);
        expect(stagedRegionAt([below, above], 10, 10)).toBe(below);
    });

    it("respects polygon containment inside a bounding box", () => {
        expect(stagedRegionAt([tri], 110, 110)).toBe(tri);
        expect(stagedRegionAt([tri], 190, 190)).toBeNull();
    });

    it("skips a top polygon miss and returns the rect beneath", () => {
        const below: StagedRegion = { rect: [0, 0, 300, 300], key: 0 };
        expect(stagedRegionAt([below, tri], 190, 190)).toBe(below);
        expect(stagedRegionAt([below, tri], 110, 110)).toBe(tri);
    });
});
