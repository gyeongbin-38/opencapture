import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LatestLiveTranslation,
    normalizeTranslatedTexts,
} from "../src/renderer/clip/openCaptureLiveTranslation";

afterEach(() => vi.useRealTimers());

describe("LatestLiveTranslation", () => {
    it("debounces rapid selection changes", async () => {
        vi.useFakeTimers();
        const published: string[] = [];
        const controller = new LatestLiveTranslation<string>(
            (value) => published.push(value),
            () => undefined,
            100,
        );
        const first = vi.fn(async () => "first");
        const second = vi.fn(async () => "second");

        controller.schedule(first);
        await vi.advanceTimersByTimeAsync(50);
        controller.schedule(second);
        await vi.advanceTimersByTimeAsync(100);

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
        expect(published).toEqual(["second"]);
    });

    it("serializes work and discards a stale result", async () => {
        vi.useFakeTimers();
        const published: string[] = [];
        let finishFirst: ((value: string) => void) | undefined;
        const controller = new LatestLiveTranslation<string>(
            (value) => published.push(value),
            () => undefined,
            10,
        );

        controller.schedule(
            () =>
                new Promise<string>((resolve) => {
                    finishFirst = resolve;
                }),
        );
        await vi.advanceTimersByTimeAsync(10);
        controller.schedule(async () => "latest");
        await vi.advanceTimersByTimeAsync(10);

        expect(published).toEqual([]);
        finishFirst?.("stale");
        await Promise.resolve();
        await Promise.resolve();

        expect(published).toEqual(["latest"]);
    });

    it("cancels pending publication", async () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const controller = new LatestLiveTranslation(
            publish,
            () => undefined,
            10,
        );
        controller.schedule(async () => "ignored");
        controller.cancel();
        await vi.runAllTimersAsync();
        expect(publish).not.toHaveBeenCalled();
    });
});

describe("normalizeTranslatedTexts", () => {
    it("supports the shared translation response shapes", () => {
        expect(normalizeTranslatedTexts("하나")).toEqual(["하나"]);
        expect(normalizeTranslatedTexts(["하나", 2, "둘"])).toEqual([
            "하나",
            "둘",
        ]);
        expect(normalizeTranslatedTexts({ texts: ["하나"] })).toEqual(["하나"]);
    });

    it("rejects malformed responses", () => {
        expect(() => normalizeTranslatedTexts({ text: "하나" })).toThrow(
            "올바르지 않은 응답",
        );
    });
});
