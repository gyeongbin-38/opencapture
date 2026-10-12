import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createFromBitmap: vi.fn(),
    createSession: vi.fn(),
}));

vi.mock("electron", () => ({
    nativeImage: { createFromBitmap: mocks.createFromBitmap },
}));

vi.mock("onnxruntime-node", () => ({
    InferenceSession: { create: mocks.createSession },
    Tensor: class {
        constructor(
            readonly type: string,
            readonly data: Float32Array,
            readonly dims: number[],
        ) {}
    },
}));

import {
    SuperResolutionCancelledError,
    createSuperResolution,
} from "../src/main/superResolution";

let tempPath = "";

beforeEach(() => {
    tempPath = mkdtempSync(join(tmpdir(), "opencapture-sr-test-"));
    mocks.createFromBitmap.mockReset();
    mocks.createSession.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempPath, { recursive: true, force: true });
});

it("cancels after an active tile without returning a partial image", async () => {
    writeFileSync(join(tempPath, "realesr-general-x4v3.onnx"), "fixture");
    let finishTile: (() => void) | undefined;
    const tileGate = new Promise<void>((resolve) => {
        finishTile = resolve;
    });
    mocks.createSession.mockResolvedValue({
        run: vi.fn(async () => {
            await tileGate;
            return { output: { data: new Float32Array(512 * 4 * 3) } };
        }),
    });
    const image = {
        isEmpty: () => false,
        getSize: () => ({ width: 129, height: 1 }),
        toBitmap: () => Buffer.alloc(129 * 4),
    } as Electron.NativeImage;
    const progress: string[] = [];
    const sr = createSuperResolution(tempPath);

    const result = sr.upscale(image, (event) => progress.push(event.phase));
    await vi.waitFor(() => expect(sr.busy()).toBe(true));
    expect(sr.cancel()).toBe(true);
    finishTile?.();

    await expect(result).rejects.toBeInstanceOf(SuperResolutionCancelledError);
    expect(progress.filter((phase) => phase === "cancelled")).toHaveLength(1);
    expect(mocks.createFromBitmap).not.toHaveBeenCalled();
    expect(sr.busy()).toBe(false);
    expect(sr.cancel()).toBe(false);
});

it("aborts an in-progress model download", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("Aborted", "AbortError")),
                    );
                }),
        ),
    );
    const image = {
        isEmpty: () => false,
        getSize: () => ({ width: 1, height: 1 }),
        toBitmap: () => Buffer.alloc(4),
    } as Electron.NativeImage;
    const progress: string[] = [];
    const sr = createSuperResolution(tempPath);

    const result = sr.upscale(image, (event) => progress.push(event.phase));
    await vi.waitFor(() => expect(sr.busy()).toBe(true));
    expect(sr.cancel()).toBe(true);

    await expect(result).rejects.toMatchObject({
        code: "SUPER_RESOLUTION_CANCELLED",
    });
    expect(progress).toEqual(["download", "cancelled"]);
    expect(sr.busy()).toBe(false);
});
