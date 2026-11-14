const Module = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const valueFor = (name, fallback) => {
    const prefix = `--${name}=`;
    const entry = process.argv.find((value) => value.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : fallback;
};
const mode = valueFor("probe-mode", "normal");
const sampleMs = Number(valueFor("sample-ms", "10500"));
const exerciseCapture = process.argv.includes("--exercise-capture");
const startedAt = performance.now();
const watched = new Map(
    ["onnxruntime-node", "node-screenshots", "uiohook-napi"].map((name) => [
        name,
        [],
    ]),
);
const originalLoad = Module._load;
Module._load = function trackedLoad(request, parent, isMain) {
    if (watched.has(request))
        watched.get(request).push(Math.round(performance.now() - startedAt));
    return originalLoad.call(this, request, parent, isMain);
};

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
const { app, BrowserWindow } = require("electron");
const errors = [];
const created = [];
app.on("web-contents-created", (_event, contents) => {
    created.push({
        id: contents.id,
        atMs: Math.round(performance.now() - startedAt),
    });
    contents.on("render-process-gone", (_goneEvent, details) =>
        errors.push(`renderer:${JSON.stringify(details)}`),
    );
});
process.on("uncaughtException", (error) =>
    errors.push(String(error?.stack ?? error)),
);
process.on("unhandledRejection", (error) => errors.push(String(error)));

require(path.join(root, "out/main/main.js"));

const exitProbe = (code) => {
    app.removeAllListeners("before-quit");
    app.exit(code);
};

const snapshot = (label) => {
    const windows = BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
        url: window.webContents.getURL(),
    }));
    const metrics = app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        workingSetBytes: (metric.memory?.workingSetSize ?? 0) * 1024,
    }));
    return {
        label,
        atMs: Math.round(performance.now() - startedAt),
        mainRssBytes: process.memoryUsage().rss,
        processWorkingSetBytes: metrics.reduce(
            (total, metric) => total + metric.workingSetBytes,
            0,
        ),
        processCount: metrics.length,
        metrics,
        windows,
    };
};

const exerciseAllowanceMs = exerciseCapture ? 30000 : 0;
const timer = setTimeout(
    () => {
        const report = {
            ok: false,
            mode,
            error: `Probe timed out after ${sampleMs + 10000 + exerciseAllowanceMs}ms`,
            errors,
        };
        console.log(`STARTUP_FOOTPRINT ${JSON.stringify(report)}`);
        exitProbe(1);
    },
    sampleMs + 10000 + exerciseAllowanceMs,
);
timer.unref();

app.whenReady().then(() => {
    const readyMs = Math.round(performance.now() - startedAt);
    const samples = [];
    setTimeout(() => samples.push(snapshot("2s")), Math.min(2000, sampleMs));
    setTimeout(async () => {
        samples.push(snapshot("final"));
        let captureExercise;
        if (exerciseCapture) {
            const pause = (ms) =>
                new Promise((resolve) => setTimeout(resolve, ms));
            const until = async (read, message, timeoutMs = 12000) => {
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline) {
                    const value = read();
                    if (value) return value;
                    await pause(100);
                }
                throw new Error(message);
            };
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
                    "Dashboard was not ready for capture exercise",
                );
                const openCapture = async () => {
                    await dashboard.webContents.executeJavaScript(
                        'window.openCapture.action("capture")',
                        true,
                    );
                    return until(
                        () =>
                            BrowserWindow.getAllWindows().find(
                                (window) =>
                                    window.webContents
                                        .getURL()
                                        .includes("capture.html") &&
                                    !window.webContents.isLoading() &&
                                    window.isVisible(),
                            ),
                        "Capture editor did not become ready",
                    );
                };
                const first = await openCapture();
                first.webContents.sendInputEvent({
                    type: "keyDown",
                    keyCode: "Escape",
                });
                first.webContents.sendInputEvent({
                    type: "keyUp",
                    keyCode: "Escape",
                });
                await until(
                    () => first.isDestroyed() || !first.isVisible(),
                    "First capture did not close on Escape",
                );
                const repeat = await openCapture();
                captureExercise = {
                    firstReady: true,
                    repeatReady: true,
                    reusedWindow: first.id === repeat.id,
                };
                repeat.webContents.sendInputEvent({
                    type: "keyDown",
                    keyCode: "Escape",
                });
                repeat.webContents.sendInputEvent({
                    type: "keyUp",
                    keyCode: "Escape",
                });
            } catch (error) {
                errors.push(
                    `capture:${error instanceof Error ? error.stack : error}`,
                );
                captureExercise = { firstReady: false, repeatReady: false };
            }
        }
        const modules = Object.fromEntries(
            [...watched].map(([name, times]) => [name, times]),
        );
        const report = {
            ok: errors.length === 0,
            mode,
            readyMs,
            sampleMs,
            modules,
            created,
            samples,
            captureExercise,
            errors,
        };
        console.log(`STARTUP_FOOTPRINT ${JSON.stringify(report)}`);
        clearTimeout(timer);
        exitProbe(report.ok ? 0 : 1);
    }, sampleMs);
});
