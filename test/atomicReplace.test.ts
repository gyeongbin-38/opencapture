import { describe, expect, it } from "vitest";
import { replaceFileSync } from "../src/main/atomicReplace";

describe("Windows atomic replacement", () => {
    it("retries a transient sharing lock without deleting the previous target", () => {
        let calls = 0;
        const error = Object.assign(new Error("locked"), { code: "EPERM" });
        replaceFileSync("draft.tmp", "draft.json", (source, target) => {
            expect([source, target]).toEqual(["draft.tmp", "draft.json"]);
            if (++calls < 3) throw error;
        });
        expect(calls).toBe(3);
    });
    it("does not retry missing or invalid files", () => {
        let calls = 0;
        expect(() =>
            replaceFileSync("missing", "target", () => {
                calls++;
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
            }),
        ).toThrow("missing");
        expect(calls).toBe(1);
    });
});
