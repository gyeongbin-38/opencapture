import { describe, expect, it } from "vitest";
import {
    dashboardCaptureSelectionMode,
    eligibleNativeWindowBounds,
    matchNativeMonitorsToDisplays,
    nativeWindowBoundsForDisplay,
    nativeWindowBoundsToDip,
    selectionEdgesForMode,
    windowBoundsToCanvas,
    windowEdgeAtPoint,
} from "../lib/captureWindowSelection";

describe("capture window selection", () => {
    it("routes only the explicit dashboard window request to window mode", () => {
        expect(dashboardCaptureSelectionMode("window")).toBe("window");
        for (const mode of [
            "capture",
            "scroll",
            "record",
            "ocr",
            "screen-translate",
            "unknown",
        ])
            expect(dashboardCaptureSelectionMode(mode)).toBe("region");
    });

    it("forces system hints in window mode independently of the preference", () => {
        const system = {
            x: 10,
            y: 20,
            width: 200,
            height: 100,
            type: "system" as const,
        };
        const image = {
            x: 30,
            y: 40,
            width: 50,
            height: 30,
            type: "image" as const,
        };
        expect(selectionEdgesForMode([system, image], "window", false)).toEqual(
            [system],
        );
        expect(selectionEdgesForMode([system, image], "region", false)).toEqual(
            [image],
        );
        expect(selectionEdgesForMode([system, image], "region", true)).toEqual([
            system,
            image,
        ]);
    });

    it("maps a window on a scaled secondary display into capture pixels", () => {
        expect(
            windowBoundsToCanvas(
                { x: 2200, y: 200, w: 400, h: 300 },
                { x: 1920, y: 0, width: 1280, height: 720 },
                { width: 2560, height: 1440 },
            ),
        ).toEqual({
            x: 560,
            y: 400,
            width: 800,
            height: 600,
            type: "system",
        });
    });

    it("normalizes physical Windows bounds on a negative-origin 125% display", () => {
        const dip = nativeWindowBoundsToDip(
            { x: -1500, y: 125, w: 500, h: 375 },
            { x: -1600, y: 0, width: 1600, height: 900 },
            { x: -1280, y: 0, width: 1280, height: 720 },
        );
        expect(dip).toEqual({ x: -1200, y: 100, w: 400, h: 300 });
        expect(
            dip &&
                windowBoundsToCanvas(
                    dip,
                    { x: -1280, y: 0, width: 1280, height: 720 },
                    { width: 1600, height: 900 },
                ),
        ).toEqual({
            x: 100,
            y: 125,
            width: 500,
            height: 375,
            type: "system",
        });
    });

    it("never exposes unmatched 125% physical bounds as Electron DIP bounds", () => {
        const windowBounds = { x: -1500, y: 125, w: 500, h: 375 };
        const nativeMonitor = {
            x: -1600,
            y: 0,
            width: 1600,
            height: 900,
        };
        expect(
            nativeWindowBoundsForDisplay(
                windowBounds,
                nativeMonitor,
                undefined,
                true,
            ),
        ).toBeNull();
        expect(
            nativeWindowBoundsForDisplay(
                windowBounds,
                nativeMonitor,
                undefined,
                false,
            ),
        ).toEqual(windowBounds);
    });

    it("matches reversed mixed-DPI monitors without comparing physical and DIP centers directly", () => {
        expect(
            matchNativeMonitorsToDisplays(
                [
                    {
                        id: 91,
                        name: "native-secondary",
                        x: -2560,
                        y: 0,
                        width: 2560,
                        height: 1440,
                        scaleFactor: 2,
                        isPrimary: false,
                    },
                    {
                        id: 90,
                        name: "native-primary",
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: true,
                    },
                ],
                [
                    {
                        id: 700,
                        label: "electron-primary",
                        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                    {
                        id: 701,
                        label: "electron-secondary",
                        bounds: { x: -1280, y: 0, width: 1280, height: 720 },
                        scaleFactor: 2,
                    },
                ],
            ),
        ).toEqual([
            { nativeId: 91, displayId: 701 },
            { nativeId: 90, displayId: 700 },
        ]);
    });

    it("uses unique monitor labels before ambiguous geometry", () => {
        expect(
            matchNativeMonitorsToDisplays(
                [
                    {
                        id: 10,
                        name: "Panel Right",
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: false,
                    },
                    {
                        id: 11,
                        name: "Panel Left",
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: false,
                    },
                ],
                [
                    {
                        id: 100,
                        label: "panel left",
                        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                    {
                        id: 101,
                        label: "PANEL RIGHT",
                        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                ],
            ),
        ).toEqual([
            { nativeId: 10, displayId: 101 },
            { nativeId: 11, displayId: 100 },
        ]);
    });

    it("keeps exact monitor IDs authoritative when labels and list order disagree", () => {
        expect(
            matchNativeMonitorsToDisplays(
                [
                    {
                        id: 2,
                        name: "stale-label-a",
                        x: 1920,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: false,
                    },
                    {
                        id: 1,
                        name: "stale-label-b",
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: true,
                    },
                ],
                [
                    {
                        id: 1,
                        label: "other",
                        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                    {
                        id: 2,
                        label: "other",
                        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                ],
            ),
        ).toEqual([
            { nativeId: 2, displayId: 2 },
            { nativeId: 1, displayId: 1 },
        ]);
    });

    it("keeps known matches when native and Electron monitor counts differ", () => {
        expect(
            matchNativeMonitorsToDisplays(
                [
                    {
                        id: 20,
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                        scaleFactor: 1,
                        isPrimary: true,
                    },
                    {
                        id: 21,
                        x: 1920,
                        y: 0,
                        width: 2560,
                        height: 1440,
                        scaleFactor: 2,
                        isPrimary: false,
                    },
                    {
                        id: 999,
                        x: 4480,
                        y: 0,
                        width: 1024,
                        height: 768,
                        scaleFactor: 1,
                        isPrimary: false,
                    },
                ],
                [
                    {
                        id: 21,
                        bounds: { x: 1920, y: 0, width: 1280, height: 720 },
                        scaleFactor: 2,
                    },
                    {
                        id: 20,
                        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                        scaleFactor: 1,
                    },
                ],
            ),
        ).toEqual([
            { nativeId: 20, displayId: 20 },
            { nativeId: 21, displayId: 21 },
        ]);
    });

    it("rejects minimized, non-finite, and non-positive native window candidates", () => {
        expect(
            eligibleNativeWindowBounds({ x: 10, y: 20, w: 300, h: 200 }, false),
        ).toEqual({ x: 10, y: 20, w: 300, h: 200 });
        expect(
            eligibleNativeWindowBounds({ x: 10, y: 20, w: 300, h: 200 }, true),
        ).toBeNull();
        expect(
            eligibleNativeWindowBounds(
                { x: Number.NaN, y: 20, w: 300, h: 200 },
                false,
            ),
        ).toBeNull();
        expect(
            eligibleNativeWindowBounds({ x: 10, y: 20, w: 0, h: 200 }, false),
        ).toBeNull();
    });

    it("clamps a partially visible window to the active display", () => {
        expect(
            windowBoundsToCanvas(
                { x: -100, y: 50, w: 300, h: 700 },
                { x: 0, y: 0, width: 800, height: 600 },
                { width: 800, height: 600 },
            ),
        ).toEqual({
            x: 0,
            y: 50,
            width: 200,
            height: 550,
            type: "system",
        });
    });

    it.each([
        { x: 0, y: 0, w: 0, h: 10 },
        { x: 0, y: 0, w: 10, h: -1 },
        { x: Number.NaN, y: 0, w: 10, h: 10 },
        { x: 900, y: 0, w: 10, h: 10 },
    ])("rejects invalid or off-display native bounds", (bounds) => {
        expect(
            windowBoundsToCanvas(
                bounds,
                { x: 0, y: 0, width: 800, height: 600 },
                { width: 800, height: 600 },
            ),
        ).toBeNull();
    });

    it("chooses the first native window under the pointer", () => {
        const front = {
            x: 10,
            y: 10,
            width: 100,
            height: 100,
            type: "system" as const,
        };
        const back = {
            x: 0,
            y: 0,
            width: 300,
            height: 300,
            type: "system" as const,
        };
        expect(windowEdgeAtPoint([front, back], { x: 50, y: 50 })).toBe(front);
        expect(
            windowEdgeAtPoint([front, back], { x: 400, y: 400 }),
        ).toBeUndefined();
    });
});
