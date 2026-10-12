import { describe, expect, it } from "vitest";
import {
    pinOutputSize,
    transformPinPoint,
    withDerivedPinImage,
} from "../src/renderer/ding/pinRendering";

describe("pin rendering geometry", () => {
    it("swaps landscape dimensions for a quarter turn", () => {
        expect(pinOutputSize(1200, 600, 90)).toEqual({
            width: 600,
            height: 1200,
        });
        expect(pinOutputSize(1200, 600, 270)).toEqual({
            width: 600,
            height: 1200,
        });
    });

    it("applies the same quarter-turn transform to annotation points", () => {
        const source = { width: 100, height: 50 };
        expect(transformPinPoint([0, 0], source, 90, false)).toEqual({
            x: 50,
            y: 0,
        });
        expect(transformPinPoint([1, 1], source, 90, false)).toEqual({
            x: 0,
            y: 100,
        });
    });

    it("mirrors before rotating, matching the canvas transform", () => {
        expect(
            transformPinPoint([0, 0], { width: 100, height: 50 }, 90, true),
        ).toEqual({ x: 50, y: 100 });
    });

    it("replaces source pixels without double-applying rotation or annotations", () => {
        const strokes = [{ pts: [[0.1, 0.2] as const] }];
        const result = withDerivedPinImage(
            {
                url: "original",
                translation: "translated",
                isTranslate: true,
                rotation: 90,
                flip: true,
                strokes,
            },
            "cutout",
        );
        expect(result).toEqual({
            url: "cutout",
            translation: "",
            isTranslate: false,
            rotation: 90,
            flip: true,
            strokes,
        });
        expect(pinOutputSize(1200, 600, result.rotation)).toEqual({
            width: 600,
            height: 1200,
        });
    });
});
