import { describe, expect, it } from "vitest";
import { colorConversion, rgbaCss } from "../lib/captureColor";

describe("colorConversion", () => {
    const red: [number, number, number, number] = [255, 0, 0, 1];

    it("renders hex and rgb for opaque colors", () => {
        expect(colorConversion(red, "HEX")).toBe("#ff0000");
        expect(colorConversion(red, "RGB")).toBe("rgb(255 0 0)");
    });

    it("renders percent-based spaces", () => {
        expect(colorConversion(red, "HSV")).toBe("hsv(0 100% 100%)");
        expect(colorConversion(red, "CMYK")).toBe("cmyk(0% 100% 100% 0%)");
    });

    it("rejects translucent colors and unknown formats", () => {
        expect(colorConversion([255, 0, 0, 0.5], "HEX")).toBe("/");
        expect(colorConversion(null, "HEX")).toBe("/");
        expect(colorConversion(red, "NOPE" as never)).toBe("");
    });
});

describe("rgbaCss", () => {
    it("formats the channel tuple", () => {
        expect(rgbaCss([1, 2, 3, 0.5])).toBe("rgba(1, 2, 3, 0.5)");
    });
});
