const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const scenarioArg = process.argv.find((arg) => arg.startsWith("--scenario="));

if (!process.versions.electron) {
    const electron = require("electron");
    const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const requested = process.argv.find((arg) => arg.startsWith("--only="));
    const scenarios = requested
        ? [requested.slice("--only=".length)]
        : [
              "happy",
              "trimmed-happy",
              "acquisition-denied",
              "media-unsupported",
              "save-cancel",
              "save-error",
              "source-list-empty",
              "source-list-denied",
              "segment-tail",
          ];
    for (const scenario of scenarios) {
        const childProfile = path.join(
            root,
            ".evidence",
            `recorder-${runId}`,
            scenario,
            "profile",
        );
        fs.mkdirSync(childProfile, { recursive: true });
        fs.writeFileSync(
            path.join(childProfile, "config.json"),
            JSON.stringify({
                录屏: {
                    自动录制: false,
                    转换: { 分段: scenario === "segment-tail" ? 1 : 0 },
                },
            }),
        );
        const child = spawnSync(
            electron,
            [__filename, `--userData=${childProfile}`],
            {
                cwd: root,
                encoding: "utf8",
                env: {
                    ...process.env,
                    OPENCAPTURE_RECORDER_VERIFY_RUN: runId,
                    OPENCAPTURE_RECORDER_SCENARIO: scenario,
                    ELECTRON_RENDERER_URL: "",
                },
                timeout: 120000,
            },
        );
        process.stdout.write(child.stdout || "");
        process.stderr.write(child.stderr || "");
        const completionMarker = `RECORDER ${scenario} OK`;
        if (child.status !== 0 || !child.stdout?.includes(completionMarker)) {
            console.error(
                `RECORDER ${scenario} failed with ${child.status ?? child.error}; marker=${child.stdout?.includes(completionMarker) ?? false}`,
            );
            process.exit(1);
        }
    }
    console.log(`RECORDER VERIFIED ${scenarios.join(", ")}`);
    process.exit(0);
}

const scenario =
    scenarioArg?.slice("--scenario=".length) ||
    process.env.OPENCAPTURE_RECORDER_SCENARIO;
if (!scenario) throw new Error("Recorder verification scenario is required");

const electronApi = require("electron");
const OriginalBrowserWindow = electronApi.BrowserWindow;
const fixturePreload = path.join(
    __dirname,
    "fixtures",
    "recorder-media-preload.cjs",
);
class RecorderFixtureBrowserWindow extends OriginalBrowserWindow {
    constructor(options = {}) {
        super({
            ...options,
            webPreferences: {
                ...options.webPreferences,
                preload: options.webPreferences?.preload || fixturePreload,
            },
        });
    }
}
const { app, BrowserWindow, ipcMain, dialog, screen } = electronApi;
const electronForApp = Object.create(electronApi);
Object.defineProperty(electronForApp, "BrowserWindow", {
    value: RecorderFixtureBrowserWindow,
});
const originalGetSources = electronApi.desktopCapturer.getSources.bind(
    electronApi.desktopCapturer,
);
let sourceFailureArmed = false;
let sourceCalls = 0;
const desktopCapturerForApp = Object.create(electronApi.desktopCapturer);
desktopCapturerForApp.getSources = async (options) => {
    if (sourceFailureArmed && options?.types?.includes("screen")) {
        sourceCalls++;
        if (sourceCalls === 1) {
            if (scenario === "source-list-empty") return [];
            if (scenario === "source-list-denied")
                throw new Error("Synthetic source-list denial");
        }
    }
    return originalGetSources(options);
};
Object.defineProperty(electronForApp, "desktopCapturer", {
    value: desktopCapturerForApp,
});
const originalModuleLoad = Module._load;
Module._load = function recorderFixtureModuleLoad(request, parent, isMain) {
    if (request === "electron") return electronForApp;
    return originalModuleLoad.call(this, request, parent, isMain);
};
const runId = process.env.OPENCAPTURE_RECORDER_VERIFY_RUN || String(Date.now());
const evidenceDir = path.join(root, ".evidence", `recorder-${runId}`, scenario);
const profileDir = path.join(evidenceDir, "profile");
fs.mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);

const exportedPath = path.join(evidenceDir, "recording.webm");
const delayedParent = path.join(evidenceDir, "write-enabled-after-error");
const failedThenExportedPath = path.join(delayedParent, "recording.webm");
const errors = [];
let dialogCalls = 0;
const trackedWindows = new Set();

app.on("browser-window-created", (_, win) => {
    trackedWindows.add(win);
    win.once("closed", () => trackedWindows.delete(win));
});

dialog.showMessageBoxSync = () => {
    dialogCalls++;
    return 0;
};
dialog.showSaveDialog = async () => {
    dialogCalls++;
    if (scenario === "save-cancel")
        return { canceled: true, filePath: undefined };
    return {
        canceled: false,
        filePath:
            scenario === "save-error" ? failedThenExportedPath : exportedPath,
    };
};

app.on("web-contents-created", (_, webContents) => {
    webContents.on("console-message", (_, level, message) => {
        if (level >= 3) errors.push(message);
    });
    webContents.on("render-process-gone", (_, details) =>
        errors.push(JSON.stringify(details)),
    );
});

require("../out/main/main.js");
if (path.resolve(app.getPath("userData")) !== path.resolve(profileDir)) {
    throw new Error(
        `Recorder profile isolation failed: ${app.getPath("userData")} !== ${profileDir}`,
    );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function findWindow(match, tries = 120) {
    for (let i = 0; i < tries; i++) {
        const win = [...trackedWindows].find(
            (candidate) =>
                !candidate.isDestroyed() &&
                candidate.webContents.getURL().includes(match),
        );
        if (win) {
            try {
                if (
                    await win.webContents.executeJavaScript(
                        `document.readyState !== "loading"`,
                    )
                )
                    return win;
            } catch {}
        }
        await wait(250);
    }
    const urls = [...trackedWindows].map((win) => win.webContents.getURL());
    throw new Error(`${match} window missing: ${JSON.stringify(urls)}`);
}

async function waitFor(win, expression, label, tries = 240) {
    for (let i = 0; i < tries; i++) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await wait(250);
    }
    const state = await win.webContents.executeJavaScript(`({
        state: document.body.dataset.recorderState,
        status: document.querySelector("#record_status")?.textContent,
        transcode: document.querySelector("#pr_ts")?.textContent,
        clip: document.querySelector("#pr_clip")?.textContent,
        join: document.querySelector("#pr_join")?.textContent,
        log: document.querySelector("#log")?.value,
    })`);
    throw new Error(`${label} timeout: ${JSON.stringify(state)}`);
}

async function click(win, selector) {
    await win.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error(${JSON.stringify(selector)} + " missing");
        element.click();
    })()`);
}

async function openRecorder() {
    const dashboard = await findWindow("dashboard.html", 20).catch(() =>
        findWindow(""),
    );
    const display = screen.getAllDisplays()[0];
    sourceFailureArmed = scenario.startsWith("source-list-");
    ipcMain.emit(
        "ipc",
        { sender: dashboard.webContents, returnValue: undefined },
        "clip_record",
        [
            [20, 20, 320, 240],
            String(display.id),
            800,
            600,
            display.scaleFactor || 1,
        ],
    );
    return findWindow("recorder.html");
}

async function recordToEditor(recorder) {
    await waitFor(
        recorder,
        `document.body.dataset.recorderState === "ready" && !!window.__recorderSynthetic`,
        "recorder ready",
    );
    await recorder.webContents.executeJavaScript(`(() => {
        const format = document.querySelector("#rec_options select");
        format.value = "webm";
        format.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await click(recorder, "#start_stop");
    await waitFor(
        recorder,
        `document.body.dataset.recorderState === "recording"`,
        "recording",
    );
    await wait(1200);
    await click(recorder, "#rec_setting button:nth-of-type(2)");
    await waitFor(
        recorder,
        `document.body.dataset.recorderState === "paused"`,
        "paused",
    );
    await click(recorder, "#rec_setting button:nth-of-type(2)");
    await waitFor(
        recorder,
        `document.body.dataset.recorderState === "recording"`,
        "resumed",
    );
    await wait(900);
    await click(recorder, "#start_stop");
    await waitFor(
        recorder,
        `document.body.dataset.recorderState === "ready" && !document.querySelector("#save")?.disabled`,
        "processing complete",
    );
    const range = await recorder.webContents.executeJavaScript(`({
        start: Number(document.querySelector("#t_start input")?.value),
        end: Number(document.querySelector("#t_end input")?.value),
    })`);
    if (!(range.end > range.start))
        throw new Error(`invalid editor range: ${JSON.stringify(range)}`);
    console.log(`RECORDER ${scenario} RANGE ${JSON.stringify(range)}`);
    return range;
}

async function verifyExportPlayback(recorder, target) {
    const stat = fs.statSync(target);
    if (stat.size <= 0) throw new Error("exported recording is empty");
    const exportUrl = pathToFileURL(target).href;
    const playback =
        await recorder.webContents.executeJavaScript(`(async () => {
        const productVideo = document.querySelector("video");
        if (productVideo.src !== ${JSON.stringify(exportUrl)})
            throw new Error("product preview did not retain the exported file");
        const video = document.createElement("video");
        video.src = ${JSON.stringify(exportUrl)};
        video.muted = true;
        video.style.position = "fixed";
        video.style.left = "-10000px";
        document.body.append(video);
        if (video.readyState < 1) await new Promise((resolve, reject) => {
            video.addEventListener("loadedmetadata", resolve, { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
        });
        const before = video.currentTime;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 600));
        video.pause();
        video.remove();
        document.querySelector("#s").scrollTop = 0;
        const status = document.querySelector("#record_status");
        const statusStyle = getComputedStyle(status);
        return {
            src: video.src,
            bytes: ${stat.size},
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            before,
            after: video.currentTime,
            status: status.textContent,
            statusVisible: status.getBoundingClientRect().height > 0 && statusStyle.display !== "none",
            saveLabel: document.querySelector("#save")?.textContent?.trim(),
            ffmpegSpawns: window.__recorderFfmpegSpawns,
        };
    })()`);
    if (
        !Number.isFinite(playback.duration) ||
        playback.duration <= 0 ||
        playback.width <= 0 ||
        playback.height <= 0 ||
        playback.after <= playback.before ||
        !playback.statusVisible ||
        !playback.saveLabel
    ) {
        throw new Error(
            `invalid exported playback: ${JSON.stringify(playback)}`,
        );
    }
    return playback;
}

async function verifyProductExportReplay(recorder, target) {
    const exportUrl = pathToFileURL(target).href;
    return recorder.webContents.executeJavaScript(`(async () => {
        const video = document.querySelector("video");
        const expected = ${JSON.stringify(exportUrl)};
        if (video.src !== expected) throw new Error("product preview source changed before playback");
        if (video.readyState < 1) await new Promise((resolve, reject) => {
            video.addEventListener("loadedmetadata", resolve, { once: true });
            video.addEventListener("error", () => reject(video.error), { once: true });
        });
        video.currentTime = 0;
        await video.play();
        await Promise.race([
            new Promise((resolve) => video.addEventListener("ended", resolve, { once: true })),
            new Promise((_, reject) => setTimeout(() => reject(new Error("product preview did not end")), 5000)),
        ]);
        if (video.src !== expected) throw new Error("product preview switched back to a raw segment");
        video.currentTime = 0;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 250));
        video.pause();
        if (video.currentTime <= 0 || video.src !== expected)
            throw new Error("product preview could not replay the exported file");
        return {
            src: video.src,
            duration: video.duration,
            replayTime: video.currentTime,
        };
    })()`);
}

const timeout = setTimeout(() => {
    console.error(`RECORDER ${scenario} TIMEOUT`);
    app.exit(1);
}, 180000);

app.whenReady().then(async () => {
    try {
        const recorder = await openRecorder();
        let result;
        if (scenario === "segment-tail") {
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "ready" && !!window.__recorderSynthetic`,
                "segment recorder ready",
            );
            await recorder.webContents.executeJavaScript(`(() => {
                const format = document.querySelector("#rec_options select");
                format.value = "webm";
                format.dispatchEvent(new Event("change", { bubbles: true }));
            })()`);
            await click(recorder, "#start_stop");
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "recording" && window.__recorderFfmpegSpawns >= 2`,
                "automatic segment restart",
                120,
            );
            await click(recorder, "#start_stop");
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "ready" && !document.querySelector("#save")?.disabled`,
                "segment tail processing",
            );
            await click(recorder, "#save");
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "saved"`,
                "segment tail save",
            );
            result = await verifyExportPlayback(recorder, exportedPath);
            const productReplay = await verifyProductExportReplay(
                recorder,
                exportedPath,
            );
            result.productReplay = productReplay;
            if (result.ffmpegSpawns < 5)
                throw new Error(
                    `automatic segment route not proven: ${JSON.stringify(result)}`,
                );
        } else if (scenario.startsWith("source-list-")) {
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "error" && document.querySelector("#record_retry")?.offsetParent !== null`,
                "source-list error",
                80,
            );
            const failure = await recorder.webContents.executeJavaScript(`({
                state: document.body.dataset.recorderState,
                retryVisible: document.querySelector("#record_retry")?.offsetParent !== null,
                status: document.querySelector("#record_status")?.textContent,
                tracksEnded: !window.__recorderSynthetic || window.__recorderSynthetic.stream
                    .getTracks().every((track) => track.readyState === "ended"),
            })`);
            if (!failure.tracksEnded)
                throw new Error("source-list failure leaked tracks");
            console.log(`RECORDER ${scenario} FAILURE STATE OK`);
            await click(recorder, "#record_retry");
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "ready" && !!window.__recorderSynthetic`,
                "source-list retry",
                120,
            );
            if (sourceCalls < 2)
                throw new Error("source-list retry did not reacquire sources");
            console.log(`RECORDER ${scenario} RETRY READY`);
            await recordToEditor(recorder);
            console.log(`RECORDER ${scenario} RECORDING PROCESSED`);
            await click(recorder, "#save");
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "saved"`,
                "source-list recovered save",
                120,
            );
            const recovered = await verifyExportPlayback(
                recorder,
                exportedPath,
            );
            result = { failure, recovered, sourceCalls };
        } else if (
            scenario === "acquisition-denied" ||
            scenario === "media-unsupported"
        ) {
            await waitFor(
                recorder,
                `document.body.dataset.recorderState === "error" && document.querySelector("#record_retry")?.offsetParent !== null`,
                "acquisition error",
            );
            result = await recorder.webContents.executeJavaScript(`({
                state: document.body.dataset.recorderState,
                retryVisible: document.querySelector("#record_retry")?.offsetParent !== null,
                status: document.querySelector("#record_status")?.textContent,
                tracksEnded: !window.__recorderSynthetic || window.__recorderSynthetic.stream
                    .getTracks().every((track) => track.readyState === "ended"),
            })`);
            if (!result.tracksEnded)
                throw new Error("failed recorder initialization leaked tracks");
        } else {
            await recordToEditor(recorder);
            let originalDurationMs = 0;
            if (scenario === "trimmed-happy") {
                originalDurationMs =
                    await recorder.webContents.executeJavaScript(`(() => {
                        const input = document.querySelector("#t_end input");
                        const original = Number(input.value);
                        input.value = String(Math.max(250, Math.floor(original / 2)));
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                        return original;
                    })()`);
            }
            await click(recorder, "#save");
            if (scenario === "save-cancel") {
                await waitFor(
                    recorder,
                    `document.body.dataset.recorderState === "cancelled" && document.querySelector("#record_retry")?.offsetParent !== null`,
                    "save cancellation",
                );
                result = await recorder.webContents.executeJavaScript(`({
                    state: document.body.dataset.recorderState,
                    retryVisible: document.querySelector("#record_retry")?.offsetParent !== null,
                    status: document.querySelector("#record_status")?.textContent,
                })`);
                if (fs.existsSync(exportedPath))
                    throw new Error("cancelled save created an output file");
            } else if (scenario === "save-error") {
                await waitFor(
                    recorder,
                    `document.body.dataset.recorderState === "error" && document.querySelector("#record_retry")?.offsetParent !== null`,
                    "save error",
                );
                fs.mkdirSync(delayedParent, { recursive: true });
                await click(recorder, "#record_retry");
                await waitFor(
                    recorder,
                    `document.body.dataset.recorderState === "saved"`,
                    "save retry",
                );
                result = await verifyExportPlayback(
                    recorder,
                    failedThenExportedPath,
                );
            } else {
                await waitFor(
                    recorder,
                    `document.body.dataset.recorderState === "saved"`,
                    "saved",
                );
                result = await verifyExportPlayback(recorder, exportedPath);
                if (
                    scenario === "trimmed-happy" &&
                    (result.duration >= originalDurationMs / 1000 - 0.1 ||
                        result.ffmpegSpawns < 3)
                ) {
                    throw new Error(
                        `trim route not proven: ${JSON.stringify({ originalDurationMs, result })}`,
                    );
                }
            }
        }
        fs.writeFileSync(
            path.join(evidenceDir, "recorder.png"),
            (await recorder.webContents.capturePage()).toPNG(),
        );
        fs.writeFileSync(
            path.join(evidenceDir, "result.json"),
            JSON.stringify({ scenario, result, dialogCalls, errors }, null, 2),
        );
        const expectedError =
            scenario === "acquisition-denied"
                ? "Synthetic permission denial"
                : scenario === "media-unsupported"
                  ? "Synthetic codec rejection"
                  : "";
        const unexpectedErrors = errors.filter(
            (message) =>
                !expectedError ||
                (!message.includes(expectedError) &&
                    message !== "[object DOMException]"),
        );
        if (unexpectedErrors.length)
            throw new Error(`renderer errors: ${unexpectedErrors.join(" | ")}`);
        console.log(`RECORDER ${scenario} OK ${JSON.stringify(result)}`);
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
    }
});
