import { describe, expect, it } from "vitest";
import { BoardRevisionQueue } from "../lib/boardRevisionQueue";

type Snapshot = { revision: number; value: string };

describe("BoardRevisionQueue", () => {
    it("serializes saves using the latest committed revision", async () => {
        const queue = new BoardRevisionQueue<Snapshot>();
        queue.reset(4);
        const expected: number[] = [];
        const documents: number[] = [];
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const save = async (snapshot: Snapshot, revision: number) => {
            expected.push(revision);
            documents.push(snapshot.revision);
            if (snapshot.value === "first") await firstBlocked;
            return { ...snapshot, revision: revision + 1 };
        };
        const first = queue.enqueue({ revision: 0, value: "first" }, save);
        const second = queue.enqueue({ revision: 0, value: "second" }, save);
        releaseFirst();
        await expect(first).resolves.toMatchObject({ revision: 5 });
        await expect(second).resolves.toMatchObject({ revision: 6 });
        await queue.flush();
        expect(expected).toEqual([4, 5]);
        expect(documents).toEqual([4, 5]);
        expect(queue.revision()).toBe(6);
    });

    it("retries after failure without advancing revision", async () => {
        const queue = new BoardRevisionQueue<Snapshot>();
        queue.reset(2);
        const failed = queue.enqueue(
            { revision: 2, value: "draft" },
            async () => {
                throw new Error("offline");
            },
        );
        await expect(failed).rejects.toThrow("offline");
        await expect(queue.flush()).rejects.toThrow("offline");
        const retried = queue.enqueue(
            { revision: 2, value: "draft" },
            async (snapshot, revision) => ({
                ...snapshot,
                revision: revision + 1,
            }),
        );
        await expect(retried).resolves.toMatchObject({ revision: 3 });
        await expect(queue.flush()).resolves.toBeUndefined();
    });

    it("flush waits for work enqueued while an earlier save is pending", async () => {
        const queue = new BoardRevisionQueue<Snapshot>();
        queue.reset(0);
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const committed: string[] = [];
        const save = async (snapshot: Snapshot, revision: number) => {
            if (snapshot.value === "first") {
                firstStarted();
                await blocked;
            }
            committed.push(snapshot.value);
            return { ...snapshot, revision: revision + 1 };
        };
        void queue.enqueue({ revision: 0, value: "first" }, save);
        await started;
        const flushing = queue.flush();
        void queue.enqueue({ revision: 0, value: "second" }, save);
        releaseFirst();
        await flushing;
        expect(committed).toEqual(["first", "second"]);
        expect(queue.revision()).toBe(2);
    });
});
