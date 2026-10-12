import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
    BrowserWindow: {},
    ClipboardItem: {},
    app: {},
    clipboard: {},
    dialog: {},
    ipcMain: {},
    nativeImage: {},
    shell: {},
}));
vi.mock("onnxruntime-node", () => ({ InferenceSession: {}, Tensor: {} }));
import {
    CaptureWorkflowQueue,
    defaultCaptureWorkflowPreferences,
    parseCaptureWorkflowPreferences,
    planImageCombination,
} from "../lib/captureWorkflow";
import { validateCaptureReceipt } from "../src/main/openCapture";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CaptureWorkflowQueue", () => {
    it("serializes captures while preserving the settings active when queued", async () => {
        const events: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const firstBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const queue = new CaptureWorkflowQueue<string>({
            copy: async (path) => {
                events.push(`copy:start:${path}`);
                if (path === "first.png") await firstBlocked;
                events.push(`copy:end:${path}`);
            },
            removeBackground: async (path) => `cutout:${path}`,
            saveDerived: async (value, originalPath) => {
                events.push(`save:${value}:from:${originalPath}`);
                return value.replace("cutout:", "saved:");
            },
            pin: async (path) => {
                events.push(`pin:${path}`);
            },
            onError: vi.fn(),
        });

        queue.enqueue("first.png", {
            autoCopy: true,
            autoRemoveBackground: false,
            autoPin: false,
            autoOcr: false,
            autoPreview: false,
            autoClipboard: false,
        });
        const mutable = {
            autoCopy: true,
            autoRemoveBackground: true,
            autoPin: true,
            autoOcr: false,
            autoPreview: false,
        };
        queue.enqueue("second.png", mutable);
        mutable.autoCopy = false;
        mutable.autoRemoveBackground = false;
        mutable.autoPin = false;
        await tick();
        expect(events).toEqual(["copy:start:first.png"]);

        releaseFirst?.();
        await queue.whenIdle();
        expect(events).toEqual([
            "copy:start:first.png",
            "copy:end:first.png",
            "save:cutout:second.png:from:second.png",
            "copy:start:saved:second.png",
            "copy:end:saved:second.png",
            "pin:saved:second.png",
        ]);
    });

    it("reports a failed derivative without losing later work on the original", async () => {
        const errors: Array<[string, string]> = [];
        const copies: string[] = [];
        const pins: string[] = [];
        const saveDerived = vi.fn();
        const queue = new CaptureWorkflowQueue<string>({
            copy: async (path) => {
                copies.push(path);
            },
            removeBackground: async () => {
                throw new Error("model unavailable");
            },
            saveDerived,
            pin: async (path) => {
                pins.push(path);
            },
            onError: (path, step) => errors.push([path, step]),
        });

        queue.enqueue("original.png", {
            autoCopy: true,
            autoRemoveBackground: true,
            autoPin: true,
            autoOcr: false,
            autoPreview: false,
        });
        await queue.whenIdle();

        expect(errors).toEqual([["original.png", "remove-background"]]);
        expect(saveDerived).not.toHaveBeenCalled();
        expect(copies).toEqual(["original.png"]);
        expect(pins).toEqual(["original.png"]);
    });

    it("bounds pending work without interrupting captures already queued", async () => {
        let releaseFirst: (() => void) | undefined;
        const firstBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const copied: string[] = [];
        const errors: Array<[string, string]> = [];
        const queue = new CaptureWorkflowQueue<string>(
            {
                copy: async (path) => {
                    if (path === "first.png") await firstBlocked;
                    copied.push(path);
                },
                removeBackground: vi.fn(),
                saveDerived: async () => "derived.png",
                pin: vi.fn(),
                onError: (path, step) => errors.push([path, step]),
            },
            1,
        );
        const preferences = {
            autoCopy: true,
            autoRemoveBackground: false,
            autoPin: false,
            autoOcr: false,
            autoPreview: false,
        };

        expect(queue.enqueue("first.png", preferences)).toBe(true);
        expect(queue.enqueue("second.png", preferences)).toBe(true);
        expect(queue.enqueue("overflow.png", preferences)).toBe(false);
        releaseFirst?.();
        await queue.whenIdle();

        expect(copied).toEqual(["first.png", "second.png"]);
        expect(errors).toEqual([["overflow.png", "queue"]]);
    });
});

describe("parseCaptureWorkflowPreferences", () => {
    it("merges partial changes but rejects unknown and non-boolean values", () => {
        expect(
            parseCaptureWorkflowPreferences(
                { autoPin: true },
                defaultCaptureWorkflowPreferences,
            ),
        ).toEqual({
            autoCopy: false,
            autoRemoveBackground: false,
            autoPin: true,
            autoOcr: true,
            autoPreview: false,
            autoClipboard: false,
        });
        expect(() =>
            parseCaptureWorkflowPreferences({ upload: true }),
        ).toThrow();
        expect(() =>
            parseCaptureWorkflowPreferences({ autoCopy: "yes" }),
        ).toThrow();
    });
});

describe("planImageCombination", () => {
    it("calculates layouts while enforcing aggregate source and output limits", () => {
        expect(
            planImageCombination(
                [
                    { width: 2000, height: 2000 },
                    { width: 1000, height: 2000 },
                ],
                "horizontal",
            ),
        ).toEqual({ width: 3000, height: 2000, sourcePixels: 6_000_000 });
        expect(() =>
            planImageCombination(
                [
                    { width: 4000, height: 3000 },
                    { width: 3000, height: 3000 },
                ],
                "vertical",
            ),
        ).toThrow("20MP source limit");
        expect(() =>
            planImageCombination(
                [
                    { width: 100, height: 10_000 },
                    { width: 10_000, height: 100 },
                ],
                "horizontal",
            ),
        ).toThrow("40MP output limit");
    });
});

describe("validateCaptureReceipt", () => {
    const folder = resolve("capture-receipt-fixture", "shots");
    const path = join(folder, "Capture-1.png");
    const receipt = {
        version: 1,
        path,
        createdAt: "2026-10-09T12:00:00.0000000Z",
    };

    it("accepts a bounded PNG directly inside a configured collection", () => {
        const imageStat = vi.fn(() => ({
            size: 1024,
            isFile: () => true,
        }));

        expect(
            validateCaptureReceipt(receipt, 256, [folder], imageStat),
        ).toEqual(receipt);
        expect(imageStat).toHaveBeenCalledWith(path);
    });

    it("rejects oversized receipts or images outside configured collections", () => {
        const imageStat = vi.fn(() => ({
            size: 1024,
            isFile: () => true,
        }));

        expect(() =>
            validateCaptureReceipt(receipt, 8 * 1024 + 1, [folder], imageStat),
        ).toThrow("too large");
        expect(() =>
            validateCaptureReceipt(
                { ...receipt, path: resolve("other", "Capture-1.png") },
                256,
                [folder],
                imageStat,
            ),
        ).toThrow("outside the image library");
        expect(() =>
            validateCaptureReceipt(receipt, 256, [folder], () => ({
                size: 50 * 1024 * 1024 + 1,
                isFile: () => true,
            })),
        ).toThrow("invalid or too large");
    });
});
