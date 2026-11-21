import { describe, expect, it } from "vitest";
import xhistory from "./history";

describe("xhistory", () => {
    it("records a change to falsy data like an empty string", () => {
        const h = new xhistory<string>([], "abc");
        h.setData("");
        h.apply();
        expect(h.getData()).toBe("");
        h.undo();
        expect(h.getData()).toBe("abc");
    });

    it("keeps the cursor position on a no-op apply", () => {
        const h = new xhistory<string>([], "a");
        h.setData("b");
        h.apply();
        h.setData("c");
        h.apply();
        h.undo();
        h.apply();
        expect(h.index).toBe(1);
        expect(h.getData()).toBe("b");
        h.unundo();
        expect(h.getData()).toBe("c");
    });

    it("resolves deep delta chains and caches replays", () => {
        const h = new xhistory<number>([], 0);
        for (let i = 1; i <= 20; i++) {
            h.setData(i);
            h.apply();
        }
        h.jump(3);
        expect(h.getData()).toBe(3);
        expect(h.getData()).toBe(3);
        h.jump(20);
        expect(h.getData()).toBe(20);
    });
});
