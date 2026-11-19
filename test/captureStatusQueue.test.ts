import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureStatusQueue } from "../lib/captureStatusQueue";

function createQueue() {
    const events: string[] = [];
    const queue = new CaptureStatusQueue(
        {
            show: (text) => events.push(`show:${text}`),
            hide: () => events.push("hide"),
            showError: (text) => events.push(`error:${text}`),
        },
        { holdMs: 100, progressMs: 300 },
    );
    return { events, queue };
}

describe("capture status queue", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("shows info messages sequentially without dropping", () => {
        const { events, queue } = createQueue();
        queue.push("first");
        queue.push("second");
        expect(events).toEqual(["show:first"]);
        vi.advanceTimersByTime(100);
        expect(events).toEqual(["show:first", "show:second"]);
        vi.advanceTimersByTime(100);
        expect(events).toEqual(["show:first", "show:second", "hide"]);
    });

    it("dedupes consecutive identical messages", () => {
        const { events, queue } = createQueue();
        queue.push("same");
        queue.push("same");
        vi.advanceTimersByTime(100);
        queue.push("same");
        expect(events).toEqual(["show:same", "hide", "show:same"]);
    });

    it("keeps an error visible instead of being stomped by info", () => {
        const { events, queue } = createQueue();
        queue.fail(new Error("boom"));
        queue.push("info");
        expect(events).toEqual(["error:boom"]);
        queue.clearError();
        expect(events).toEqual(["error:boom", "show:info"]);
    });

    it("replaces a progress message with the next result immediately", () => {
        const { events, queue } = createQueue();
        queue.push("saving…");
        queue.push("saved");
        expect(events).toEqual(["show:saving…", "show:saved"]);
    });

    it("preempts an info message with a newer progress message", () => {
        const { events, queue } = createQueue();
        queue.push("copied");
        queue.push("recognizing…");
        expect(events).toEqual(["show:copied", "show:recognizing…"]);
        vi.advanceTimersByTime(300);
        expect(events).toEqual(["show:copied", "show:recognizing…", "hide"]);
    });

    it("clears queued and current state on reset", () => {
        const { events, queue } = createQueue();
        queue.push("one");
        queue.push("two");
        queue.reset();
        expect(events).toEqual(["show:one", "hide"]);
        vi.advanceTimersByTime(1000);
        expect(events).toEqual(["show:one", "hide"]);
    });
});
