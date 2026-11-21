import { describe, expect, it } from "vitest";
import format from "../lib/time_format";

describe("time_format", () => {
    const date = new Date(2005, 0, 2, 15, 4, 6, 789);

    it("formats 24h and padded fields", () => {
        expect(format("YYYY-MM-DD HH:mm:ss", date)).toBe(
            "2005-01-02 15:04:06",
        );
    });

    it("formats 12-hour clock with 12 for noon and midnight", () => {
        expect(format("h", new Date(2005, 0, 2, 12))).toBe("12");
        expect(format("hh", new Date(2005, 0, 2, 12))).toBe("12");
        expect(format("h", new Date(2005, 0, 2, 0))).toBe("12");
        expect(format("hh", new Date(2005, 0, 2, 0))).toBe("12");
        expect(format("hh", new Date(2005, 0, 2, 15))).toBe("03");
        expect(format("h", new Date(2005, 0, 2, 15))).toBe("3");
    });

    it("formats two-digit year zero-padded", () => {
        expect(format("YY", date)).toBe("05");
        expect(format("YY", new Date(2099, 0, 2))).toBe("99");
    });
});
