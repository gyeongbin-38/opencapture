// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ImageHoldHandle,
    createImageHold,
} from "../src/renderer/lib/imageHold";

const handles: ImageHoldHandle[] = [];
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: false })));

function pointer(type: string, buttons: number) {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: type === "pointerdown" ? 0 : -1,
        buttons,
        clientX: 40,
        clientY: 40,
    });
    Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true },
    });
    return event;
}

afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("image hold button states", () => {
    it("positions the ring in its containing block after image centering and zoom", () => {
        const container = document.createElement("div");
        const target = document.createElement("img");
        container.append(target);
        document.body.append(container);
        container.getBoundingClientRect = () =>
            ({ left: 20, top: 10, width: 200, height: 200 }) as DOMRect;
        Object.defineProperties(container, {
            offsetWidth: { value: 100 },
            offsetHeight: { value: 100 },
        });
        const handle = createImageHold(target, { onHold: vi.fn() });
        handles.push(handle);
        target.dispatchEvent(pointer("pointerdown", 1));
        const ring = container.querySelector<HTMLElement>(
            ".image-hold-indicator",
        );
        expect(ring?.style.left).toBe("10px");
        expect(ring?.style.top).toBe("15px");
    });
    it("cancels a pending hold when right joins the held left button", () => {
        vi.useFakeTimers();
        const target = document.createElement("img");
        document.body.append(target);
        const onHold = vi.fn();
        const handle = createImageHold(target, { onHold });
        handles.push(handle);
        target.dispatchEvent(pointer("pointerdown", 1));
        vi.advanceTimersByTime(200);
        target.dispatchEvent(pointer("pointermove", 3));
        vi.advanceTimersByTime(800);
        expect(onHold).not.toHaveBeenCalled();
        handle.dispose();
    });

    it("keeps a stationary left-only hold eligible", () => {
        vi.useFakeTimers();
        const target = document.createElement("img");
        document.body.append(target);
        const onHold = vi.fn();
        const handle = createImageHold(target, { onHold });
        handles.push(handle);
        target.dispatchEvent(pointer("pointerdown", 1));
        vi.advanceTimersByTime(200);
        target.dispatchEvent(pointer("pointermove", 1));
        vi.advanceTimersByTime(500);
        expect(onHold).toHaveBeenCalledTimes(1);
        handle.dispose();
    });
});
