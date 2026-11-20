import { describe, expect, it } from "vitest";
import { CaptureDraftQueue } from "../lib/captureDraftQueue";
import type { DraftSnapshot } from "../lib/captureDraftQueue";
import type {
    StageCaptureInput,
    StageCaptureResult,
} from "../lib/openCaptureTypes";

const snapshot = (width = 20): DraftSnapshot => ({
    sourceDataURL: "source",
    previewDataURL: "preview",
    canvas: { objects: [] },
    rect: { x: 0, y: 0, width, height: 20 },
});
const result = (id: string, revision: number): StageCaptureResult => ({
    id,
    revision,
    item: {
        id,
        name: id,
        path: id,
        collectionId: "default",
        createdAt: new Date().toISOString(),
    },
});

describe("editable capture save queue", () => {
    it("tracks edits while an older revision is pending so OCR cannot treat it as current", async () => {
        let release: (() => void) | undefined;
        let calls = 0;
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(),
            stage: async () => {
                calls++;
                if (calls === 2)
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                return result("draft", calls);
            },
        });
        queue.begin();
        queue.initialized();
        await queue.save(true);
        const recognizedEpoch = queue.current!.editEpoch;
        queue.changed();
        const pending = queue.save();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(queue.current?.pending).toBe(true);
        expect(queue.current?.dirty).toBe(false);
        expect(queue.current?.editEpoch).toBeGreaterThan(recognizedEpoch);
        queue.changed();
        release?.();
        await pending;
        expect(queue.current?.dirty).toBe(true);
        await queue.flush();
        expect(queue.current?.revision).toBe(3);
        queue.dispose();
    });
    it("retries the latest edits rather than clearing dirty changes after a failure", async () => {
        let failed = true;
        let width = 20;
        let received = 0;
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(width),
            stage: async (value) => {
                if (failed) throw new Error("disk full");
                received = value.rect.width;
                return result("latest", 1);
            },
        });
        queue.begin();
        queue.initialized();
        await expect(queue.save(true)).rejects.toThrow("disk full");
        width = 80;
        queue.changed();
        failed = false;
        await queue.retry();
        expect(received).toBe(80);
        expect(queue.current?.dirty).toBe(false);
        queue.dispose();
    });

    it("reports snapshot limits as rejected saves while preserving edits", async () => {
        const queue = new CaptureDraftQueue({
            snapshot: () => {
                throw new Error("image limit");
            },
            stage: async () => result("unused", 1),
        });
        queue.begin();
        queue.initialized();
        queue.changed();
        await expect(queue.save()).rejects.toThrow("image limit");
        expect(queue.current?.dirty).toBe(true);
        queue.dispose();
    });
    it("freezes the old capture while a new one is selected", async () => {
        let release: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const calls: StageCaptureInput[] = [];
        let width = 20;
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(width),
            stage: async (input) => {
                calls.push(input);
                if (calls.length === 1) await blocked;
                return result(`draft-${calls.length}`, 1);
            },
        });
        queue.begin();
        queue.initialized();
        const first = queue.save(true);
        await Promise.resolve();
        width = 50;
        queue.begin();
        queue.initialized();
        const second = queue.save(true);
        release?.();
        await Promise.all([first, second]);
        expect(calls.map((call) => call.rect.width)).toEqual([20, 50]);
        expect(queue.savedIds).toHaveLength(2);
        queue.dispose();
    });

    it("serializes revisions and sends immutable source only on creation", async () => {
        const calls: StageCaptureInput[] = [];
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(),
            stage: async (input) => {
                calls.push(input);
                return result("draft", calls.length);
            },
        });
        queue.begin();
        queue.initialized();
        await Promise.all([queue.save(true), queue.save(true)]);
        expect(calls[0].sourceDataURL).toBe("source");
        expect(calls[1].sourceDataURL).toBeUndefined();
        expect(calls[1].expectedRevision).toBe(1);
        queue.dispose();
    });

    it("reuses the same record key when a saved draft is reopened", async () => {
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(),
            stage: async (input) => result(input.id ?? "draft", 1),
        });
        queue.begin();
        queue.initialized();
        await queue.save(true);
        const key = queue.current!.key;
        expect(queue.current?.id).toBe("draft");
        queue.begin();
        queue.initialized();
        const reopened = queue.begin({ id: "draft", revision: 1 });
        expect(reopened).toBe(queue.current);
        expect(reopened.key).toBe(key);
        queue.dispose();
    });

    it("keeps the failed snapshot available for retry and blocks a successful close", async () => {
        let failed = true;
        const queue = new CaptureDraftQueue({
            snapshot: () => snapshot(),
            stage: async () => {
                if (failed) throw new Error("disk full");
                return result("draft", 1);
            },
        });
        queue.begin();
        queue.initialized();
        await expect(queue.save(true)).rejects.toThrow("disk full");
        expect(queue.current?.error).toBeDefined();
        failed = false;
        await queue.retry();
        expect(queue.current?.id).toBe("draft");
        expect(queue.current?.error).toBeUndefined();
        queue.dispose();
    });
});
