import { describe, expect, it } from "vitest";
import { ele2jsKeyCode, jsKeyCodeDisplay } from "../lib/key";

describe("key maps", () => {
    it("covers all KeyX letter codes including Z", () => {
        for (let i = 0; i < 26; i++) {
            const k = String.fromCharCode(65 + i);
            expect(jsKeyCodeDisplay(`Key${k}`).primary).toBe(k);
        }
    });

    it("maps CommandOrControl to the platform modifier", () => {
        const expected =
            process.platform === "darwin" ? "Meta" : "Control";
        expect(ele2jsKeyCode("CommandOrControl")).toBe(expected);
        expect(ele2jsKeyCode("CmdOrCtrl")).toBe(expected);
        expect(ele2jsKeyCode("Ctrl")).toBe("Control");
    });

    it("shows unshifted quote as primary", () => {
        const q = jsKeyCodeDisplay("Quote");
        expect(q.primary).toBe("'");
        expect(q.secondary).toBe('"');
    });
});
