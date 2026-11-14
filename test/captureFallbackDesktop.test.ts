import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    ipcRenderer: undefined,
    nativeImage: {},
    shell: {},
    dialog: {},
}));

vi.mock("myde-dbus", () => ({
    dbusClient: class {},
    dbusIO: class {},
}));

import {
    WINDOWS_DESKTOP_UNAVAILABLE_MARKER,
    WINDOWS_DESKTOP_UNAVAILABLE_MESSAGE,
    isWindowsDesktopUnavailable,
    windowsDesktopUnavailableError,
} from "../src/renderer/screenShot/screenShot";

const root = resolve(import.meta.dirname, "..");
const canonicalWorker = resolve(root, "scripts/capture-worker.py");
const runtimeWorker = resolve(
    root,
    "assets/runtime/win32-x64/capture-worker.py",
);
const bundledPython = resolve(root, "assets/runtime/win32-x64/python.exe");
const harness = resolve(root, "test/fixtures/capture-worker-harness.py");
const python = [
    process.platform === "win32" && existsSync(bundledPython)
        ? bundledPython
        : null,
    "python3",
    "python",
].find(
    (candidate) =>
        candidate &&
        spawnSync(candidate, ["--version"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000,
        }).status === 0,
);

describe("Windows GDI fallback desktop preflight", () => {
    it.runIf(existsSync(runtimeWorker))(
        "keeps the packaged worker identical to its canonical source",
        () => {
            expect(readFileSync(runtimeWorker)).toEqual(
                readFileSync(canonicalWorker),
            );
        },
    );

    it.runIf(Boolean(python))(
        "allows a legitimate black frame on the same desktop and blocks mismatches before capture",
        () => {
            const result = spawnSync(python, [harness, canonicalWorker], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 15000,
            });
            expect(result.status, result.stderr).toBe(0);
            const report = JSON.parse(result.stdout);
            expect(report.sameDesktop).toEqual({
                code: 0,
                captured: true,
                output: "BLACK_FRAME_OK",
            });
            expect(report.mismatch.code).toBe(3);
            expect(report.mismatch.stdoutBytes).toBe(0);
            expect(report.mismatch.stderr).toContain(
                WINDOWS_DESKTOP_UNAVAILABLE_MARKER,
            );
            expect(report.mismatch.stderr).toContain(
                '"reason":"desktop-mismatch"',
            );
            expect(report.denied).toEqual({
                reason: "input-desktop-denied",
                inputError: 5,
            });
        },
    );

    it("recognizes only the structured worker marker", () => {
        expect(
            isWindowsDesktopUnavailable(
                Buffer.from(
                    `${WINDOWS_DESKTOP_UNAVAILABLE_MARKER}{"reason":"desktop-mismatch"}`,
                ),
            ),
        ).toBe(true);
        expect(
            isWindowsDesktopUnavailable("generic Python capture failure"),
        ).toBe(false);
        expect(isWindowsDesktopUnavailable(null)).toBe(false);
    });

    it("propagates the worker marker as the translated actionable error", () => {
        const cause = new Error("worker exited 3");
        const translated = windowsDesktopUnavailableError(
            `${WINDOWS_DESKTOP_UNAVAILABLE_MARKER}{"reason":"desktop-mismatch"}`,
            (text) => `translated:${text}`,
            cause,
        );
        expect(translated?.message).toBe(
            `translated:${WINDOWS_DESKTOP_UNAVAILABLE_MESSAGE}`,
        );
        expect(translated?.cause).toBe(cause);
        expect(
            windowsDesktopUnavailableError(
                "other failure",
                (text) => text,
                cause,
            ),
        ).toBeNull();
    });
});
