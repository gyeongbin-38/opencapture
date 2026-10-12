import { describe, expect, it } from "vitest";
import {
    virtualLibraryRange,
    virtualLibrarySlots,
} from "../src/renderer/dashboard/virtualLibrary";

describe("virtualLibraryRange", () => {
    it("keeps the live range bounded for a large catalog", () => {
        const range = virtualLibraryRange({
            total: 1_000,
            viewportTop: 20_000,
            viewportHeight: 800,
            gridTop: 300,
            gridWidth: 960,
            cardWidth: 220,
            rowHeight: 250,
            gap: 16,
            overscanRows: 3,
        });
        expect(range.columns).toBe(4);
        expect(range.end - range.start).toBeLessThanOrEqual(40);
        expect(range.start).toBeGreaterThan(0);
        expect(range.bottom).toBeGreaterThan(0);
    });

    it("clamps the first and final windows", () => {
        const first = virtualLibraryRange({
            total: 9,
            viewportTop: 0,
            viewportHeight: 600,
            gridTop: 100,
            gridWidth: 700,
            cardWidth: 210,
            rowHeight: 240,
            gap: 16,
        });
        expect(first.start).toBe(0);
        expect(first.end).toBe(9);
        expect(first.top).toBe(0);

        const last = virtualLibraryRange({
            total: 1_000,
            viewportTop: 100_000,
            viewportHeight: 700,
            gridTop: 100,
            gridWidth: 700,
            cardWidth: 210,
            rowHeight: 240,
            gap: 16,
        });
        expect(last.end).toBe(1_000);
        expect(last.start).toBeLessThan(last.end);
    });

    it("preserves sparse absolute slots while pages are loading", () => {
        const items = ["a", undefined, "c", undefined, "e"];
        expect(virtualLibrarySlots(items, 1, 5)).toEqual([
            { index: 1, item: undefined },
            { index: 2, item: "c" },
            { index: 3, item: undefined },
            { index: 4, item: "e" },
        ]);
    });
});
