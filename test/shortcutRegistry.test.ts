import { describe, expect, it, vi } from "vitest";
import { registerShortcuts } from "../lib/shortcutRegistry";
describe("non-destructive shortcut registration", () => {
    it("falls back when another application owns the requested combination", () => {
        const run = vi.fn();
        const register = vi.fn((key: string) => key === "Ctrl+Alt+A");
        const requests = [
            {
                id: "capture",
                label: "Capture",
                keys: ["Ctrl+Shift+A", "Ctrl+Alt+A"],
                run,
            },
        ];
        expect(registerShortcuts(requests, register)[0].active).toBe(
            "Ctrl+Alt+A",
        );
        expect(requests[0].keys[0]).toBe("Ctrl+Shift+A");
        expect(run).not.toHaveBeenCalled();
    });
    it("reports unavailable without throwing or unregistering external keys", () => {
        expect(
            registerShortcuts(
                [{ id: "x", label: "X", keys: ["bad"], run: () => {} }],
                () => {
                    throw Error("reserved");
                },
            )[0].available,
        ).toBe(false);
    });
});
