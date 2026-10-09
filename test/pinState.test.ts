import { afterEach, describe, expect, it, vi } from "vitest";

import { PinBlinkController, PinFocusState } from "../lib/pinState";

describe("PinFocusState", () => {
    it("restores each pin's visibility after focus, including a pre-hidden pin", () => {
        const state = new PinFocusState();
        const pins = [
            { id: "selected", visible: true },
            { id: "visible", visible: true },
            { id: "minimized", visible: false },
        ];

        expect(state.toggle("selected", pins)).toEqual([
            { id: "selected", visible: true },
            { id: "visible", visible: false },
            { id: "minimized", visible: false },
        ]);
        expect(state.restore()).toEqual(pins);
    });

    it("keeps the original snapshot when focus switches and tracks new pins", () => {
        const state = new PinFocusState();
        state.toggle("first", [
            { id: "first", visible: true },
            { id: "second", visible: true },
        ]);

        expect(
            state.toggle("second", [
                { id: "first", visible: true },
                { id: "second", visible: false },
                { id: "new", visible: true },
            ]),
        ).toEqual([
            { id: "first", visible: false },
            { id: "second", visible: true },
            { id: "new", visible: false },
        ]);
        expect(state.restore()).toEqual([
            { id: "first", visible: true },
            { id: "second", visible: true },
            { id: "new", visible: true },
        ]);
    });
});

describe("PinBlinkController", () => {
    afterEach(() => vi.useRealTimers());

    it("blinks every 500ms and restores the image when stopped", () => {
        vi.useFakeTimers();
        const changes: Array<[string, boolean]> = [];
        const state = new PinBlinkController(
            (id, visible) => changes.push([id, visible]),
            500,
        );

        expect(state.toggle("pin")).toBe(true);
        vi.advanceTimersByTime(1_000);
        expect(changes).toEqual([
            ["pin", false],
            ["pin", true],
        ]);

        state.clear();
        vi.advanceTimersByTime(1_000);
        expect(changes.at(-1)).toEqual(["pin", true]);
        expect(state.isAnyActive).toBe(false);
    });
});
