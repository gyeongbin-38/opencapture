import { describe, expect, it } from "vitest";
import {
    isValidTags,
    normalizeTags,
    TAG_LIMIT,
    TAG_MAX_LENGTH,
} from "../lib/itemMeta";

describe("normalizeTags", () => {
    it("trims, dedupes, and drops empties", () => {
        expect(normalizeTags([" ui ", "ui", "bug", ""])).toEqual(["ui", "bug"]);
    });
    it("clamps count and length", () => {
        const many = Array.from({ length: TAG_LIMIT + 4 }, (_, i) => `t${i}`);
        expect(normalizeTags(many)).toHaveLength(TAG_LIMIT);
        const long = "x".repeat(TAG_MAX_LENGTH + 10);
        expect(normalizeTags([long])?.[0]).toHaveLength(TAG_MAX_LENGTH);
    });
    it("returns undefined for non-arrays or empty results", () => {
        expect(normalizeTags("tag")).toBeUndefined();
        expect(normalizeTags([123, null])).toBeUndefined();
        expect(normalizeTags([])).toBeUndefined();
    });
    it("strips control characters", () => {
        expect(normalizeTags(["ab"])).toEqual(["ab"]);
    });
});

describe("isValidTags", () => {
    it("accepts in-bounds arrays only", () => {
        expect(isValidTags(["a", "b"])).toBe(true);
        expect(isValidTags([])).toBe(true);
        expect(isValidTags(Array(TAG_LIMIT + 1).fill("x"))).toBe(false);
        expect(isValidTags(["x".repeat(TAG_MAX_LENGTH + 1)])).toBe(false);
        expect(isValidTags("a")).toBe(false);
    });
});
