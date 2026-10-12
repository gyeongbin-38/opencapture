import { describe, expect, it, vi } from "vitest";
import { createLongPressController } from "../lib/longPress";

describe("long press controller", () => {
    it("fires exactly once after 650ms while movement stays within 8px", () => {
        vi.useFakeTimers();
        const hold = vi.fn();
        const controller = createLongPressController({ onHold: hold });
        controller.pointerDown({ pointerId: 1, x: 10, y: 10 });
        controller.pointerMove({ pointerId: 1, x: 16, y: 15 });
        vi.advanceTimersByTime(650);
        vi.advanceTimersByTime(650);
        expect(hold).toHaveBeenCalledTimes(1);
        expect(controller.state()).toBe("held");
        controller.pointerUp(1);
        expect(controller.state()).toBe("idle");
        vi.useRealTimers();
    });

    it("hands movement over to drag once the threshold is crossed", () => {
        vi.useFakeTimers();
        const hold = vi.fn();
        const drag = vi.fn();
        const cancel = vi.fn();
        const controller = createLongPressController({
            onHold: hold,
            onDragStart: drag,
            onCancel: cancel,
        });
        controller.pointerDown({ pointerId: 4, x: 20, y: 30 });
        controller.pointerMove({ pointerId: 4, x: 29, y: 30 });
        vi.advanceTimersByTime(800);
        expect(hold).not.toHaveBeenCalled();
        expect(drag).toHaveBeenCalledWith(
            expect.objectContaining({ pointerId: 4, dx: 9, dy: 0 }),
        );
        expect(cancel).toHaveBeenCalledWith("move");
        expect(controller.state()).toBe("dragging");
        vi.useRealTimers();
    });

    it.each([
        [
            "release",
            (controller: ReturnType<typeof createLongPressController>) =>
                controller.pointerUp(2),
        ],
        [
            "pointercancel",
            (controller: ReturnType<typeof createLongPressController>) =>
                controller.pointerCancel(2),
        ],
        [
            "escape",
            (controller: ReturnType<typeof createLongPressController>) =>
                controller.cancel("escape"),
        ],
        [
            "blur",
            (controller: ReturnType<typeof createLongPressController>) =>
                controller.cancel("blur"),
        ],
    ] as const)("cancels on %s", (reason, stop) => {
        vi.useFakeTimers();
        const hold = vi.fn();
        const cancel = vi.fn();
        const controller = createLongPressController({
            onHold: hold,
            onCancel: cancel,
        });
        controller.pointerDown({ pointerId: 2, x: 0, y: 0 });
        stop(controller);
        vi.advanceTimersByTime(700);
        expect(hold).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledWith(reason);
        expect(controller.state()).toBe("idle");
        vi.useRealTimers();
    });

    it("ignores unrelated pointers and rejects a second active press", () => {
        vi.useFakeTimers();
        const hold = vi.fn();
        const controller = createLongPressController({ onHold: hold });
        expect(controller.pointerDown({ pointerId: 1, x: 0, y: 0 })).toBe(true);
        expect(controller.pointerDown({ pointerId: 2, x: 0, y: 0 })).toBe(
            false,
        );
        controller.pointerUp(2);
        vi.advanceTimersByTime(650);
        expect(hold).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});
