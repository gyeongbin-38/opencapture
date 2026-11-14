import type * as ChildProcess from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ renderSendSync: vi.fn() }));
vi.mock("../lib/translate/translate", () => ({ t: (value: string) => value }));

import { type OpenWithRuntime, openWithRuntime } from "../lib/open_with";

const execFileMock = vi.fn();

function runtime(
    platform: NodeJS.Platform,
    options: {
        desktop?: string;
        runPath?: unknown;
        selection?: unknown;
    } = {},
): OpenWithRuntime {
    return {
        platform,
        desktop: options.desktop,
        execFile: execFileMock as unknown as typeof ChildProcess.execFile,
        join,
        runPath: () => options.runPath,
        chooseMacApp: () => options.selection,
    };
}

beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(null, "", "");
        return {};
    });
});

describe("open with process boundaries", () => {
    it("rejects an empty file path without starting a process", async () => {
        await expect(openWithRuntime("  ", runtime("win32"))).rejects.toThrow(
            "file path",
        );
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it("passes a Windows path as one opaque argument", async () => {
        const file = 'C:\\QA files\\capture & calc "draft".png';
        await openWithRuntime(file, runtime("win32"));
        expect(execFileMock).toHaveBeenCalledWith(
            "rundll32.exe",
            ["C:\\Windows\\system32\\shell32.dll,OpenAs_RunDLL", file],
            { cwd: undefined, windowsHide: true },
            expect.any(Function),
        );
    });

    it.each([
        ["KDE", "kde-open-with"],
        ["plasma:wayland", "kde-open-with"],
        ["GNOME", "gtk-open-with"],
    ])(
        "uses the %s Linux desktop helper without a shell",
        async (desktop, helper) => {
            const runPath = join("opt", "Open Capture with spaces");
            const file = "/tmp/capture; touch injected.png";
            await openWithRuntime(file, runtime("linux", { desktop, runPath }));
            const directory = join(runPath, "lib");
            expect(execFileMock).toHaveBeenCalledWith(
                join(directory, helper),
                [file],
                { cwd: directory, windowsHide: true },
                expect.any(Function),
            );
        },
    );

    it("returns safely when the macOS picker is cancelled or empty", async () => {
        for (const selection of [
            { canceled: true, filePaths: [] },
            { canceled: false, filePaths: [] },
            { canceled: false, filePaths: [""] },
            null,
        ])
            await expect(
                openWithRuntime(
                    "/tmp/capture.png",
                    runtime("darwin", { selection }),
                ),
            ).resolves.toBeUndefined();
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it("passes the selected macOS app and file as separate arguments", async () => {
        const app = "/Applications/Preview & Review.app";
        const file = "/tmp/capture $(unsafe).png";
        await openWithRuntime(
            file,
            runtime("darwin", {
                selection: { canceled: false, filePaths: [app] },
            }),
        );
        expect(execFileMock).toHaveBeenCalledWith(
            "open",
            ["-a", app, file],
            { cwd: undefined, windowsHide: true },
            expect.any(Function),
        );
    });

    it("reports process launch failures to its caller", async () => {
        const error = new Error("launcher unavailable");
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            callback(error, "", "");
            return {};
        });
        await expect(
            openWithRuntime("C:\\capture.png", runtime("win32")),
        ).rejects.toBe(error);
    });
});
