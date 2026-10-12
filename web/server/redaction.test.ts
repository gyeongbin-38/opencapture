import { describe, expect, it } from "vitest";
import { maskSensitiveLinePixels, selectSensitiveOcrLines } from "./redaction";

describe("lab sensitive-information redaction", () => {
    it("preserves ordinary OCR lines and selects email lines for masking", () => {
        const ordinary = {
            text: "Quarterly report is ready",
            box: { x: 1, y: 2, width: 100, height: 20 },
        };
        const email = {
            text: "Contact owner@example.com",
            box: { x: 1, y: 30, width: 160, height: 20 },
        };

        expect(selectSensitiveOcrLines([ordinary, email])).toEqual([email]);
    });

    it("leaves ordinary-line pixels intact and masks email-line pixels", () => {
        const pixels = new Uint8Array(4 * 2 * 4).fill(255);
        const ordinary = {
            text: "Public heading",
            box: { x: 0, y: 0, width: 2, height: 2 },
        };
        const email = {
            text: "owner@example.com",
            box: { x: 2, y: 0, width: 2, height: 2 },
        };

        const masked = maskSensitiveLinePixels(pixels, 4, 2, [ordinary, email]);

        expect(masked).toEqual([email]);
        expect([...pixels.slice(0, 8)]).toEqual(new Array(8).fill(255));
        expect([...pixels.slice(8, 12)]).toEqual([20, 20, 20, 255]);
    });
});
