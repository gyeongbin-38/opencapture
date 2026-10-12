import { describe, expect, it } from "vitest";
import {
    REFERENCE_MAX_NOTES,
    type ReferencePixels,
    boundedPixels,
    computeAlignment,
    computePixelDiff,
    fromSavedComparisonSession,
    isReferenceComparisonSession,
    normalizeReferenceNotes,
    toSavedComparisonSession,
} from "../lib/referenceComparison";

const fixture = (
    width: number,
    height: number,
    sample: (x: number, y: number) => number,
): ReferencePixels => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const value = sample(x, y);
            const index = (y * width + x) * 4;
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
            data[index + 3] = 255;
        }
    }
    return { width, height, data };
};

const pattern = (x: number, y: number) =>
    (x * 17 + y * 29 + ((x >> 3) ^ (y >> 2)) * 43 + ((x * y) % 71)) % 256;

describe("reference alignment", () => {
    it("recovers a known translation with useful confidence", () => {
        const a = fixture(144, 112, pattern);
        const shiftX = 12;
        const shiftY = -8;
        const b = fixture(144, 112, (x, y) => pattern(x - shiftX, y - shiftY));
        const result = computeAlignment(a, b);
        expect(result.ok).toBe(true);
        expect(result.offsetX).toBeCloseTo(-shiftX, 0);
        expect(result.offsetY).toBeCloseTo(-shiftY, 0);
        expect(result.score).toBeGreaterThan(0.75);
    });

    it("returns an honest no-match result for unrelated flat images", () => {
        const a = fixture(128, 96, () => 10);
        const b = fixture(128, 96, () => 240);
        const result = computeAlignment(a, b);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no-match");
    });

    it("tests limited scale hypotheses without unbounded source buffers", () => {
        const smooth = (x: number, y: number) =>
            128 +
            55 * Math.sin(x / 9) +
            38 * Math.cos(y / 7) +
            24 * Math.sin((x + y) / 13);
        const a = fixture(160, 128, smooth);
        const expectedScale = 1.04;
        const b = fixture(160, 128, (x, y) =>
            smooth(x * expectedScale, y * expectedScale),
        );
        const result = computeAlignment(a, b);
        expect(result.ok).toBe(true);
        expect(result.scale).toBeCloseTo(expectedScale, 1);
    });

    it("keeps working buffers within the longest-edge bound", () => {
        const image = fixture(1600, 800, pattern);
        const bounded = boundedPixels(image, 400);
        expect(bounded.width).toBe(400);
        expect(bounded.height).toBe(200);
        expect(bounded.data).toHaveLength(400 * 200 * 4);
    });
});

describe("pixel difference", () => {
    it("keeps equal pixels muted and highlights changed pixels", () => {
        const a = fixture(8, 8, () => 60);
        const b = { ...a, data: new Uint8ClampedArray(a.data) };
        b.data[(3 * 8 + 4) * 4] = 255;
        const diff = computePixelDiff(a, b, { threshold: 20 });
        const equal = (1 * 8 + 1) * 4;
        const changed = (3 * 8 + 4) * 4;
        expect(diff.data[equal]).toBeLessThan(100);
        expect(diff.data[changed]).toBe(255);
        expect(diff.data[changed + 3]).toBe(235);
    });
});

describe("comparison session boundaries", () => {
    it("normalizes coordinates, text, and note count", () => {
        const notes = Array.from(
            { length: REFERENCE_MAX_NOTES + 5 },
            (_, index) => ({
                id: `n${index}`,
                x: index % 2 ? -1 : 2,
                y: 0.5,
                text: ` note ${index} `,
            }),
        );
        const normalized = normalizeReferenceNotes(notes);
        expect(normalized).toHaveLength(REFERENCE_MAX_NOTES);
        expect(normalized[0].x).toBe(1);
        expect(normalized[0].text).toBe("note 0");
        expect(normalized[1].x).toBe(0);
    });

    it("rejects malformed sessions", () => {
        expect(isReferenceComparisonSession({ id: "x" })).toBe(false);
        expect(
            isReferenceComparisonSession({
                id: "s",
                name: "Review",
                aId: "a",
                bId: "b",
                mode: "wipe",
                zoomMode: "fit",
                zoom: 1,
                scaleB: 1,
                opacity: 50,
                wipe: 50,
                threshold: 12,
                notes: [],
            }),
        ).toBe(true);
    });

    it("round-trips the persisted backend session contract", () => {
        const session = {
            id: "session-1",
            name: "Before and after",
            aId: "a",
            bId: "b",
            mode: "diff" as const,
            zoomMode: "actual" as const,
            zoom: 1.5,
            pan: { x: 4, y: -3 },
            offsetB: { x: 9, y: -2 },
            scaleB: 1.04,
            opacity: 42,
            wipe: 61,
            threshold: 18,
            notes: [{ id: "n1", x: 0.2, y: 0.8, text: "Spacing" }],
            updatedAt: Date.now(),
        };
        const saved = toSavedComparisonSession(session);
        expect(saved.itemIds).toEqual(["a", "b"]);
        expect(saved.mode).toBe("difference");
        expect(saved.zoomMode).toBe("actual");
        expect(fromSavedComparisonSession(saved)).toMatchObject({
            aId: "a",
            bId: "b",
            mode: "diff",
            zoomMode: "actual",
            offsetB: { x: 9, y: -2 },
        });
    });
});
