const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.resolve(root, ".evidence", "capture-desktop-failure");
const expectedMessage =
    "Windows 화면이 잠겨 있거나 다른 데스크톱이 활성화되어 있습니다. 잠금을 해제한 뒤 다시 캡처해 주세요.";

if (!process.versions.electron) {
    fs.mkdirSync(evidence, { recursive: true });
    const profile = path.resolve(evidence, `profile-${Date.now()}`);
    fs.mkdirSync(profile, { recursive: true });
    const electron = path.resolve(
        root,
        "node_modules",
        "electron",
        "dist",
        process.platform === "win32" ? "electron.exe" : "electron",
    );
    const childEnv = { ...process.env };
    childEnv.ELECTRON_RUN_AS_NODE = undefined;
    const result = spawnSync(
        electron,
        [__filename, `--capture-desktop-failure-profile=${profile}`],
        {
            cwd: root,
            encoding: "utf8",
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            env: childEnv,
        },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
        if (result.error) console.error(result.error);
        process.exit(result.status ?? 1);
    }
    process.exit(0);
}

const electronApi = require("electron");
const { app, BrowserWindow, dialog, Notification } = electronApi;
const profile = path.resolve(
    process.argv
        .find((value) => value.startsWith("--capture-desktop-failure-profile="))
        ?.slice("--capture-desktop-failure-profile=".length) ??
        path.resolve(evidence, `profile-${Date.now()}`),
);
const realConfig = process.env.APPDATA
    ? path.resolve(process.env.APPDATA, "OpenCapture", "config.json")
    : "";
const hash = (file) =>
    file && fs.existsSync(file)
        ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
        : null;
const configHashBefore = hash(realConfig);
const notifications = [];
const rendererErrors = [];
const originalNotificationShow = Notification.prototype.show;
Notification.prototype.show = function showInterceptedNotification() {
    notifications.push({ title: this.title, body: this.body });
};

const report = {
    ok: false,
    isolatedProfile: profile,
    expectedMessage,
    attempts: [],
    notifications,
    rendererErrors,
    temporaryItems: { before: [], after: [] },
    realConfig: {
        path: realConfig || null,
        before: configHashBefore,
        after: null,
        preserved: false,
    },
};

fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", profile);
process.argv.push(`--userData=${profile}`);
dialog.showMessageBoxSync = () => -1;
dialog.showErrorBox = (title, message) =>
    rendererErrors.push({ title, message, source: "dialog" });
app.on("browser-window-created", (_event, window) => {
    window.setSkipTaskbar(true);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on("console-message", (event) => {
        if (event.level === "error")
            rendererErrors.push({
                message: event.message,
                sourceId: event.sourceId,
                lineNumber: event.lineNumber,
                url: window.webContents.getURL(),
            });
    });
});

require("../out/main/main.js");
assert.equal(path.resolve(app.getPath("userData")), profile);

const pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(check, message, attempts = 400) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await pause(50);
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}
const captureWindows = () =>
    BrowserWindow.getAllWindows().filter((window) =>
        window.webContents.getURL().includes("capture.html"),
    );

let finished = false;
const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (error)
        report.failure = error instanceof Error ? error.stack : String(error);
    report.realConfig.after = hash(realConfig);
    report.realConfig.preserved =
        report.realConfig.before === report.realConfig.after;
    let exitCode = code;
    if (!report.realConfig.preserved) {
        report.failure =
            `${report.failure ?? ""}\nReal user config changed.`.trim();
        exitCode = 1;
    }
    report.ok = exitCode === 0 && !report.failure;
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(
        path.resolve(evidence, "qa.json"),
        `${JSON.stringify(report, null, 2)}\n`,
    );
    Notification.prototype.show = originalNotificationShow;
    console.log(
        report.ok
            ? "OPENCAPTURE_CAPTURE_DESKTOP_FAILURE_OK"
            : "OPENCAPTURE_CAPTURE_DESKTOP_FAILURE_FAILED",
        JSON.stringify(report),
    );
    app.exit(report.ok ? 0 : 1);
};
const timeout = setTimeout(
    () => finish(1, new Error("Desktop capture failure QA timed out.")),
    100_000,
);

app.whenReady().then(async () => {
    try {
        const dashboard = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("dashboard.html") &&
                        !window.webContents.isLoading(),
                ),
            "Dashboard did not load.",
        );
        const dashboardRun = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () => dashboardRun("Boolean(window.openCapture)"),
            "Dashboard API did not initialize.",
        );
        await dashboardRun(`localStorage.setItem("oc:onboarded", "1");
            for (const modal of document.querySelectorAll("dialog[open]")) modal.close();`);

        const temporaryIds = async (queryId) => {
            const result = await dashboardRun(`window.openCapture.queryItems({
                scope:"temporary",sort:"newest",offset:0,limit:200,
                queryId:${JSON.stringify(queryId)}
            })`);
            return result.items.map((item) => item.id).sort();
        };
        report.temporaryItems.before = await temporaryIds(
            "desktop-failure-before",
        );

        const requestFailure = async (label) => {
            const beforeState = await dashboardRun(
                "window.openCapture.getState()",
            );
            const beforeIds = new Set(
                (beforeState.runtime.captureDiagnostics ?? []).map(
                    (trace) => trace.requestId,
                ),
            );
            const notificationStart = notifications.length;
            let overlayEverVisible = false;
            const startedAt = Date.now();
            const action = await dashboardRun(`window.openCapture
                .action("capture")
                .then(()=>({resolved:true}),error=>({resolved:false,message:String(error?.message ?? error)}))`);
            const input = await until(async () => {
                overlayEverVisible ||= captureWindows().some((window) =>
                    window.isVisible(),
                );
                const state = await dashboardRun(
                    "window.openCapture.getState()",
                );
                return (state.runtime.captureDiagnostics ?? []).find(
                    (trace) =>
                        !beforeIds.has(trace.requestId) &&
                        trace.phase === "input" &&
                        trace.input === "dashboard:capture",
                );
            }, `${label} did not create a capture request.`);
            const failed = await until(async () => {
                overlayEverVisible ||= captureWindows().some((window) =>
                    window.isVisible(),
                );
                const state = await dashboardRun(
                    "window.openCapture.getState()",
                );
                return (state.runtime.captureDiagnostics ?? []).find(
                    (trace) =>
                        trace.requestId === input.requestId &&
                        trace.phase === "failed",
                );
            }, `${label} did not reach a terminal failure.`);
            const notification = await until(
                () =>
                    notifications
                        .slice(notificationStart)
                        .find((value) => value.body === expectedMessage),
                `${label} did not report the actionable notification.`,
            );
            await pause(250);
            const terminalWindows = captureWindows();
            assert.ok(
                terminalWindows.every((window) => !window.isVisible()),
                `${label} left the capture overlay visible.`,
            );
            assert.equal(
                overlayEverVisible,
                false,
                `${label} briefly exposed a stale capture overlay.`,
            );
            assert.equal(failed.detail, expectedMessage);
            const elapsedMs = Date.now() - startedAt;
            assert.ok(elapsedMs < 10_000, `${label} hung for ${elapsedMs}ms.`);
            const diagnostics = (
                await dashboardRun("window.openCapture.getState()")
            ).runtime.captureDiagnostics;
            assert.equal(
                diagnostics.some(
                    (trace) =>
                        trace.requestId === input.requestId &&
                        trace.phase === "shown",
                ),
                false,
                `${label} marked a failed capture as shown.`,
            );
            return {
                label,
                requestId: input.requestId,
                action,
                failed,
                notification,
                elapsedMs,
                captureWindowIds: terminalWindows.map(
                    (window) => window.webContents.id,
                ),
                terminalHidden: true,
                overlayEverVisible,
            };
        };

        report.attempts.push(await requestFailure("first request"));
        report.attempts.push(await requestFailure("retry request"));
        assert.notEqual(
            report.attempts[0].requestId,
            report.attempts[1].requestId,
            "Retry reused the failed request identity.",
        );
        report.temporaryItems.after = await temporaryIds(
            "desktop-failure-after",
        );
        assert.deepEqual(
            report.temporaryItems.after,
            report.temporaryItems.before,
            "A failed desktop capture saved an empty draft.",
        );
        assert.equal(
            notifications.filter((value) => value.body === expectedMessage)
                .length,
            2,
            "Each failed request must report exactly one actionable notification.",
        );
        finish(0);
    } catch (error) {
        finish(1, error);
    }
});
