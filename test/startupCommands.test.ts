import { expect, it, vi } from "vitest";
import { StartupCommandQueue } from "../lib/startupCommands";
it("buffers early broker commands and runs initial startup before them", async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const idle = vi.fn();
    const queue = new StartupCommandQueue(
        async (c) => {
            calls.push(c.argv[0]);
            if (c.first)
                await new Promise<void>((r) => {
                    release = r;
                });
        },
        idle,
        (e) => {
            throw e;
        },
    );
    queue.enqueue(["early-inbox"]);
    queue.enqueue(["early-toggle"]);
    expect(calls).toEqual([]);
    queue.start(["initial"]);
    expect(calls).toEqual(["initial"]);
    expect(queue.pending).toBe(3);
    release?.();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    expect(calls).toEqual(["initial", "early-inbox", "early-toggle"]);
    expect(queue.pending).toBe(0);
});
it("continues later commands after a failure instead of dropping them", async () => {
    const calls: string[] = [];
    const errors = vi.fn();
    const idle = vi.fn();
    const queue = new StartupCommandQueue(
        async (c) => {
            calls.push(c.argv[0]);
            if (c.first) throw Error("first failed");
        },
        idle,
        errors,
    );
    queue.enqueue(["capture"]);
    queue.start(["startup"]);
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    expect(calls).toEqual(["startup", "capture"]);
    expect(errors).toHaveBeenCalledOnce();
});
