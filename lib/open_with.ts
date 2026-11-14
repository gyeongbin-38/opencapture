import type * as ChildProcess from "node:child_process";
import type * as Path from "node:path";
import { renderSendSync } from "./ipc";
import { t } from "./translate/translate";

export type OpenWithRuntime = {
    platform: NodeJS.Platform;
    desktop?: string;
    execFile: typeof ChildProcess.execFile;
    join: typeof Path.join;
    runPath(): unknown;
    chooseMacApp(): unknown;
};

function execute(
    execFile: typeof ChildProcess.execFile,
    file: string,
    args: string[],
    cwd?: string,
) {
    return new Promise<void>((resolve, reject) => {
        execFile(
            file,
            args,
            { cwd, windowsHide: true },
            (error: Error | null) => {
                if (error) reject(error);
                else resolve();
            },
        );
    });
}

export async function openWithRuntime(
    path: string,
    runtime: OpenWithRuntime,
): Promise<void> {
    if (typeof path !== "string" || !path.trim())
        throw new Error(t("A file path is required."));

    switch (runtime.platform) {
        case "win32":
            await execute(runtime.execFile, "rundll32.exe", [
                "C:\\Windows\\system32\\shell32.dll,OpenAs_RunDLL",
                path,
            ]);
            break;
        case "linux": {
            const runPath = runtime.runPath();
            if (typeof runPath !== "string" || !runPath.trim())
                throw new Error(
                    t("The application runtime path is unavailable."),
                );
            const directory = runtime.join(runPath, "lib");
            const desktop = (runtime.desktop ?? "").toLowerCase();
            const helper =
                desktop.includes("kde") || desktop.includes("plasma")
                    ? "kde-open-with"
                    : "gtk-open-with";
            await execute(
                runtime.execFile,
                runtime.join(directory, helper),
                [path],
                directory,
            );
            break;
        }
        case "darwin": {
            const selection = runtime.chooseMacApp() as
                | { canceled?: unknown; filePaths?: unknown }
                | null
                | undefined;
            if (selection?.canceled !== false) return;
            const appPath = Array.isArray(selection.filePaths)
                ? selection.filePaths.find(
                      (value): value is string =>
                          typeof value === "string" && Boolean(value.trim()),
                  )
                : undefined;
            if (!appPath) return;
            await execute(runtime.execFile, "open", ["-a", appPath, path]);
            break;
        }
    }
}

async function open(path: string): Promise<void> {
    const childProcess = require("node:child_process") as typeof ChildProcess;
    const nodePath = require("node:path") as typeof Path;
    return openWithRuntime(path, {
        platform: process.platform,
        desktop: process.env.XDG_SESSION_DESKTOP,
        execFile: childProcess.execFile,
        join: nodePath.join,
        runPath: () => renderSendSync("runPath", []),
        chooseMacApp: () => renderSendSync("clip_mac_app", []),
    });
}

export default open;
