const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { app, BrowserWindow, dialog, screen } = require("electron");
const { Monitor, Window } = require("node-screenshots");

const root = resolve(__dirname, "..");
const evidence = join(root, ".evidence", "window-capture");
mkdirSync(evidence, { recursive: true });
const profile = resolve(
    mkdtempSync(join(tmpdir(), "opencapture-window-capture-")),
);
const tempRoot = `${resolve(tmpdir())}\\`;
if (!profile.startsWith(tempRoot))
    throw new Error("Unsafe isolated profile path");
const realConfig = process.env.APPDATA
    ? join(process.env.APPDATA, "OpenCapture", "config.json")
    : "";
const hash = (path) =>
    path && existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : null;
const configHashBefore = hash(realConfig);
const report = {
    ok: false,
    checks: [],
    errors: [],
    isolatedProfile: profile,
    realConfig: {
        path: realConfig || null,
        before: configHashBefore,
        after: null,
        preserved: false,
    },
};

app.setPath("userData", profile);
app.setPath("pictures", profile);
process.argv.push(`--userData=${profile}`);
dialog.showMessageBoxSync = () => -1;
dialog.showErrorBox = (title, message) =>
    report.errors.push(`${title}: ${message}`);
app.on("browser-window-created", (_event, window) => {
    window.setSkipTaskbar(true);
    window.webContents.setBackgroundThrottling(false);
});

require("../out/main/main.js");
assert.equal(
    resolve(app.getPath("userData")),
    profile,
    "production main must retain the isolated profile",
);

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (condition, label) => {
    for (let attempt = 0; attempt < 300; attempt++) {
        const value = await condition();
        if (value) return value;
        await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
};
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

function nativeWindows() {
    return Window.all().flatMap((candidate) => {
        const monitor = candidate.currentMonitor();
        const raw = {
            x: candidate.x(),
            y: candidate.y(),
            width: candidate.width(),
            height: candidate.height(),
        };
        if (raw.width <= 0 || raw.height <= 0) return [];
        const dip = screen.screenToDipRect(null, raw);
        const display = screen.getDisplayMatching(dip);
        const nativeMonitor = {
            x: monitor.x(),
            y: monitor.y(),
            width: monitor.width(),
            height: monitor.height(),
        };
        const scaleX = nativeMonitor.width / display.bounds.width;
        const scaleY = nativeMonitor.height / display.bounds.height;
        const normalized = {
            x: display.bounds.x + (raw.x - nativeMonitor.x) / scaleX,
            y: display.bounds.y + (raw.y - nativeMonitor.y) / scaleY,
            width: raw.width / scaleX,
            height: raw.height / scaleY,
        };
        const roundTrip = screen.dipToScreenRect(null, {
            x: Math.round(normalized.x),
            y: Math.round(normalized.y),
            width: Math.round(normalized.width),
            height: Math.round(normalized.height),
        });
        return [
            {
                raw,
                nativeMonitor,
                monitorScaleFactor: monitor.scaleFactor(),
                display,
                dip,
                normalized,
                roundTrip,
                agrees:
                    near(normalized.x, dip.x) &&
                    near(normalized.y, dip.y) &&
                    near(normalized.width, dip.width) &&
                    near(normalized.height, dip.height) &&
                    near(roundTrip.x, raw.x) &&
                    near(roundTrip.y, raw.y) &&
                    near(roundTrip.width, raw.width) &&
                    near(roundTrip.height, raw.height),
            },
        ];
    });
}

function canvasRect(candidate) {
    const display = candidate.display.bounds;
    const canvas = candidate.nativeMonitor;
    const left = Math.max(candidate.normalized.x, display.x);
    const top = Math.max(candidate.normalized.y, display.y);
    const right = Math.min(
        candidate.normalized.x + candidate.normalized.width,
        display.x + display.width,
    );
    const bottom = Math.min(
        candidate.normalized.y + candidate.normalized.height,
        display.y + display.height,
    );
    const scaleX = canvas.width / display.width;
    const scaleY = canvas.height / display.height;
    const x = Math.max(0, Math.floor((left - display.x) * scaleX));
    const y = Math.max(0, Math.floor((top - display.y) * scaleY));
    const pixelRight = Math.min(
        canvas.width,
        Math.ceil((right - display.x) * scaleX),
    );
    const pixelBottom = Math.min(
        canvas.height,
        Math.ceil((bottom - display.y) * scaleY),
    );
    return { x, y, width: pixelRight - x, height: pixelBottom - y };
}

const contains = (candidate, point) =>
    candidate.display.id === point.displayId &&
    candidate.normalized.x < point.x &&
    point.x < candidate.normalized.x + candidate.normalized.width &&
    candidate.normalized.y < point.y &&
    point.y < candidate.normalized.y + candidate.normalized.height;

async function verifyCoordinates() {
    const displays = screen.getAllDisplays();
    const monitors = Monitor.all();
    const samples = nativeWindows().slice(0, 8);
    assert.ok(
        displays.length && monitors.length,
        "Display inventory is unavailable",
    );
    assert.ok(
        samples.some((sample) => sample.agrees),
        "No native window coordinate sample matched Electron DIP conversion",
    );
    report.checks.push({
        name: "native physical window coordinates normalize to Electron DIP",
        displays: displays.map((display) => ({
            id: display.id,
            bounds: display.bounds,
            scaleFactor: display.scaleFactor,
        })),
        monitors: monitors.map((monitor) => ({
            id: monitor.id(),
            x: monitor.x(),
            y: monitor.y(),
            width: monitor.width(),
            height: monitor.height(),
            scaleFactor: monitor.scaleFactor(),
        })),
        samples: samples.map((sample) => ({
            raw: sample.raw,
            normalized: sample.normalized,
            electronDip: sample.dip,
            roundTrip: sample.roundTrip,
            agrees: sample.agrees,
        })),
    });
}

async function verifyProductionWindowRoute() {
    const dashboard = await until(
        () =>
            BrowserWindow.getAllWindows().find(
                (window) =>
                    window.webContents.getURL().includes("dashboard.html") &&
                    !window.webContents.isLoading(),
            ),
        "dashboard",
    );
    const dashboardRun = (code) =>
        dashboard.webContents.executeJavaScript(code, true);
    await until(
        () =>
            dashboardRun(
                "Boolean(window.openCapture && document.querySelector('[data-action=\"window\"]'))",
            ),
        "dashboard window capture action",
    );

    const cursorDisplay = screen.getDisplayNearestPoint(
        screen.getCursorScreenPoint(),
    );
    const candidates = nativeWindows().filter(
        (candidate) =>
            candidate.display.id === cursorDisplay.id &&
            candidate.normalized.width >= 160 &&
            candidate.normalized.height >= 100,
    );
    assert.ok(
        candidates.length,
        "No real system window is available for selection",
    );
    const proposed = candidates[0];
    const point = {
        x: proposed.normalized.x + proposed.normalized.width / 2,
        y: proposed.normalized.y + proposed.normalized.height / 2,
        displayId: cursorDisplay.id,
    };
    const selected = nativeWindows().find((candidate) =>
        contains(candidate, point),
    );
    assert.ok(selected, "The controlled window point has no native candidate");
    const localPoint = {
        x: Math.round(point.x - cursorDisplay.bounds.x),
        y: Math.round(point.y - cursorDisplay.bounds.y),
    };
    assert.ok(
        localPoint.x > 0 &&
            localPoint.x < cursorDisplay.bounds.width &&
            localPoint.y > 0 &&
            localPoint.y < cursorDisplay.bounds.height,
        "The controlled window point is outside the capture display",
    );

    await dashboardRun(
        "document.querySelector('[data-action=\"window\"]').click(); true",
    );
    const capture = await until(
        () =>
            BrowserWindow.getAllWindows().find(
                (window) =>
                    window.webContents.getURL().includes("capture.html") &&
                    !window.webContents.isLoading() &&
                    window.isVisible(),
            ),
        "window capture renderer",
    );
    const clip = (code) => capture.webContents.executeJavaScript(code, true);
    await until(
        () =>
            clip(
                'document.body.style.opacity !== "0" && document.querySelector("#main_photo")?.width > 0',
            ),
        "window capture initialization",
    );
    const initial = await clip(`(() => ({
        size:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
        handlesHidden:document.querySelector('#selection_handles').hidden,
        status:[...document.querySelectorAll('.capture-workspace-status')].find(e=>!e.hidden)?.textContent?.trim() ?? ''
    }))()`);
    assert.deepEqual(
        initial.size,
        [0, 0],
        "Window mode must start without an arbitrary region",
    );
    assert.equal(
        initial.handlesHidden,
        true,
        "Window mode resize handles must stay hidden",
    );
    assert.match(
        initial.status,
        /창.*클릭/,
        "Window selection instruction is missing",
    );

    capture.webContents.sendInputEvent({ type: "mouseMove", ...localPoint });
    const hover = await until(
        () =>
            clip(`(() => {
                const layer=[...document.querySelectorAll('#clip_photo > div')]
                    .find(e=>e.style.width==='100%'&&e.style.height==='100%');
                return layer?.children.length ? {count:layer.children.length, rects:[...layer.children].map(e=>({left:e.style.left,top:e.style.top,width:e.style.width,height:e.style.height}))} : null;
            })()`),
        "native window hover outline",
    );
    capture.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...localPoint,
    });
    capture.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...localPoint,
    });
    const expected = canvasRect(selected);
    const chosen = await until(async () => {
        const value = await clip(`(() => ({
            size:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
            handlesHidden:document.querySelector('#selection_handles').hidden
        }))()`);
        return value.size[0] > 0 && value.size[1] > 0 ? value : null;
    }, "native window click selection");
    assert.ok(
        near(chosen.size[0], expected.width, 3) &&
            near(chosen.size[1], expected.height, 3),
        `Selected window size ${chosen.size.join("x")} did not match ${expected.width}x${expected.height}`,
    );
    assert.equal(
        chosen.handlesHidden,
        true,
        "Window bounds must not expose resize handles",
    );
    report.checks.push({
        name: "dashboard Window capture shows native-only hover and selects exact bounds",
        actionLabel: await dashboardRun(
            "document.querySelector('[data-action=\"window\"]').textContent.trim()",
        ),
        initial,
        hover,
        clickPoint: localPoint,
        expected,
        chosen,
    });

    await dashboardRun(
        "document.querySelector('[data-action=\"capture\"]').click(); true",
    );
    const region = await until(async () => {
        const value = await clip(`(() => ({
            size:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
            canvas:[document.querySelector('#main_photo').width,document.querySelector('#main_photo').height],
            handlesHidden:document.querySelector('#selection_handles').hidden,
            toolbarOpacity:getComputedStyle(document.querySelector('#quick_toolbar')).opacity,
            toolbarPointer:getComputedStyle(document.querySelector('#quick_toolbar')).pointerEvents
        }))()`);
        return value.size[0] === 0 &&
            value.size[1] === 0 &&
            value.handlesHidden &&
            Number(value.toolbarOpacity) === 0 &&
            value.toolbarPointer === "none"
            ? value
            : null;
    }, "ordinary region mode reset");
    report.checks.push({
        name: "ordinary Area capture resets to a blank region selection mode",
        actionLabel: await dashboardRun(
            "document.querySelector('[data-action=\"capture\"]').textContent.trim()",
        ),
        region,
    });
    await clip('require("electron").ipcRenderer.send("clip_close"); true');
}

let finished = false;
const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (error)
        report.errors.push(
            error instanceof Error ? error.stack : String(error),
        );
    report.realConfig.after = hash(realConfig);
    report.realConfig.preserved =
        report.realConfig.after === report.realConfig.before;
    let exitCode = code;
    if (!report.realConfig.preserved) {
        report.errors.push("The real OpenCapture profile changed");
        exitCode = 1;
    }
    report.ok = exitCode === 0 && report.errors.length === 0;
    writeFileSync(join(evidence, "qa.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.ok) console.log("OPENCAPTURE_WINDOW_CAPTURE_OK");
    app.exit(report.ok ? 0 : 1);
};
const timeout = setTimeout(
    () => finish(1, new Error("Window capture verification timed out")),
    150_000,
);

app.whenReady()
    .then(async () => {
        assert.equal(resolve(app.getPath("userData")), profile);
        await verifyCoordinates();
        await verifyProductionWindowRoute();
        finish(0);
    })
    .catch((error) => finish(1, error));

app.on("quit", () => {
    if (!profile.startsWith(tempRoot)) return;
    try {
        rmSync(profile, { recursive: true, force: true });
    } catch {}
});
