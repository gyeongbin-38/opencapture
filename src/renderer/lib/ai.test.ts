import { describe, expect, it, vi } from "vitest";
import { runAI } from "./ai";

const enc = new TextEncoder();
const cfg = { config: {}, url: "https://x.test/v1/", key: "k", model: "m" };
const msg = [{ role: "user" as const, content: { text: "hi" } }];

function sseResponse(chunks: string[]) {
    return new Response(
        new ReadableStream<Uint8Array>({
            start(c) {
                for (const t of chunks) c.enqueue(enc.encode(t));
                c.close();
            },
        }),
        { status: 200 },
    );
}

const delta = (content: string) =>
    `data: {"choices":[{"delta":{"content":"${content}"}}]}\n`;

describe("runAI", () => {
    it("streams deltas and resolves the full text on [DONE]", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                sseResponse([delta("he"), delta("llo"), "data: [DONE]\n"]),
            ),
        );
        const r = runAI(msg, cfg);
        const events: boolean[] = [];
        r.stream((_t, end) => events.push(end));
        await expect(r.text).resolves.toBe("hello");
        expect(events.at(-1)).toBe(true);
    });

    it("rejects with the server error message on HTTP failure", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({ error: { message: "bad key" } }),
                        { status: 401 },
                    ),
            ),
        );
        await expect(runAI(msg, cfg).text).rejects.toThrow("bad key");
    });

    it("resolves when the stream ends without [DONE]", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => sseResponse([delta("x")])),
        );
        await expect(runAI(msg, cfg).text).resolves.toBe("x");
    });

    it("rejects on network failure", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("net down");
            }),
        );
        await expect(runAI(msg, cfg).text).rejects.toThrow("net down");
    });

    it("stop() resolves with the partial text", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: unknown, init: { signal?: AbortSignal }) => {
                const stream = new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(enc.encode(delta("part")));
                        init.signal?.addEventListener("abort", () =>
                            c.error(new DOMException("aborted", "AbortError")),
                        );
                    },
                });
                return new Response(stream, { status: 200 });
            }),
        );
        const r = runAI(msg, cfg);
        const events: boolean[] = [];
        r.stream((_t, end) => events.push(end));
        await new Promise((r) => setTimeout(r, 10));
        r.stop();
        await expect(r.text).resolves.toBe("part");
        expect(events.at(-1)).toBe(true);
    });
});
