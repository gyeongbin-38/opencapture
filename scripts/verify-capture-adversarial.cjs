const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, screen } = require("electron");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "capture-adversarial");
const profile = path.join(evidence, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const realConfig = process.env.APPDATA
    ? path.join(process.env.APPDATA, "OpenCapture", "config.json")
    : "";
const hash = (target) =>
    target && fs.existsSync(target)
        ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
        : null;
const realHashBefore = hash(realConfig);
const report = {
    baseline: true,
    checks: [],
    diagnostics: [],
    failures: [],
    errors: [],
    profile,
    realConfig: {
        path: realConfig || null,
        before: realHashBefore,
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
assert.equal(path.resolve(app.getPath("userData")), path.resolve(profile));

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (condition, label) => {
    for (let attempt = 0; attempt < 300; attempt++) {
        const value = await condition();
        if (value) return value;
        await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
};
const record = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.failures.push({ name, detail });
};
const sameSelection = (left, right, tolerance = 1) =>
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]) <= tolerance);

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
    report.ok =
        exitCode === 0 &&
        report.failures.length === 0 &&
        report.errors.length === 0;
    fs.writeFileSync(
        path.join(evidence, "baseline.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    console.log(
        report.ok
            ? "OPENCAPTURE_CAPTURE_ADVERSARIAL_OK"
            : "OPENCAPTURE_CAPTURE_ADVERSARIAL_BASELINE_FAIL",
    );
    app.exit(report.ok ? 0 : 1);
};
const timeout = setTimeout(
    () => finish(1, new Error("Adversarial capture verification timed out")),
    120_000,
);

app.whenReady()
    .then(async () => {
        const dashboard = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("dashboard.html") &&
                        !window.webContents.isLoading(),
                ),
            "dashboard",
        );
        const dashboardRun = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                dashboardRun(
                    "Boolean(window.openCapture && document.querySelector('[data-action=\"capture\"]'))",
                ),
            "capture action",
        );
        await dashboardRun(
            "document.querySelector('[data-action=\"capture\"]').click(); true",
        );
        const capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading() &&
                        window.isVisible(),
                ),
            "capture renderer",
        );
        const clip = (code) =>
            capture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                clip(
                    'document.body.style.opacity !== "0" && document.querySelector("#main_photo")?.width > 0',
                ),
            "capture initialization",
        );
        await clip(`(() => {
            window.__qaContextMenus=0;
            document.addEventListener('contextmenu',()=>window.__qaContextMenus++,true);
        })()`);
        capture.webContents.debugger.attach("1.3");
        const cdpMouse = (type, x, y, button = "none", buttons = 0) =>
            capture.webContents.debugger.sendCommand(
                "Input.dispatchMouseEvent",
                {
                    type,
                    x,
                    y,
                    button,
                    buttons,
                    clickCount: button === "none" ? 0 : 1,
                    pointerType: "mouse",
                },
            );
        const rightClick = async (x, y) => {
            const before = await clip("window.__qaContextMenus");
            await cdpMouse("mouseMoved", x, y);
            await cdpMouse("mousePressed", x, y, "right", 2);
            await cdpMouse("mouseReleased", x, y, "right", 0);
            await pause(180);
            const state = await clip(`(() => ({
                contexts:window.__qaContextMenus,
                radialDisplay:getComputedStyle(document.querySelector('#radial_menu')).display,
                radialItems:document.querySelectorAll('#radial_menu .radial_item').length,
                selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
                toolbar:{display:getComputedStyle(document.querySelector('#quick_toolbar')).display,opacity:getComputedStyle(document.querySelector('#quick_toolbar')).opacity,pointer:getComputedStyle(document.querySelector('#quick_toolbar')).pointerEvents},
                activeAction:document.activeElement?.dataset?.captureAction ?? ''
            }))()`);
            return { before, ...state };
        };
        const leftClick = async (x, y) => {
            await cdpMouse("mouseMoved", x, y);
            await cdpMouse("mousePressed", x, y, "left", 1);
            await cdpMouse("mouseReleased", x, y, "left", 0);
            await pause(140);
        };
        const canvas = await clip(
            'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
        );
        const initialSelection = await clip(
            '[...document.querySelectorAll(".capture-dimensions input")].map(i=>Number(i.value))',
        );
        const magnifier = await clip(`(() => {
            const element=document.querySelector('#mouse_bar');
            const style=getComputedStyle(element);
            return {
                borderRadius:style.borderRadius,
                boxShadow:style.boxShadow,
                width:element.getBoundingClientRect().width,
                height:element.getBoundingClientRect().height
            };
        })()`);
        record(
            "a fresh ordinary capture starts without an arbitrary full-screen selection",
            initialSelection[0] === 0 && initialSelection[1] === 0,
            { initialSelection },
        );
        record(
            "the color magnifier uses a compact angular surface",
            Number.parseFloat(magnifier.borderRadius) <= 6 &&
                magnifier.boxShadow === "none",
            magnifier,
        );
        const center = {
            x: Math.round(canvas.left + canvas.width / 2),
            y: Math.round(canvas.top + canvas.height / 2),
        };
        const sourcePixels = await clip(`(() => {
            const canvas=document.querySelector('#main_photo');
            const context=canvas.getContext('2d');
            const colors=new Set();
            let nonBlack=0;
            let samples=0;
            for(let y=0;y<canvas.height;y+=64)for(let x=0;x<canvas.width;x+=64){
                const pixel=context.getImageData(x,y,1,1).data;
                colors.add([...pixel].join(','));
                if(pixel[0]||pixel[1]||pixel[2])nonBlack++;
                samples++;
            }
            return {samples,uniqueColors:colors.size,nonBlack};
        })()`);
        record(
            "the captured source canvas contains real nonuniform pixels",
            sourcePixels.nonBlack > 0 && sourcePixels.uniqueColors > 1,
            sourcePixels,
        );
        const readMore = () =>
            clip(`(() => {
                const element=document.querySelector('#radial_menu [data-capture-action="more"]');
                if(!element)return null;
                const r=element.getBoundingClientRect();
                return {x:r.x+r.width/2,y:r.y+r.height/2,labels:[...document.querySelectorAll('#radial_menu .radial_item')].map(e=>e.getAttribute('aria-label'))};
            })()`);
        const pageCycle = async () => {
            await rightClick(center.x, center.y);
            const pages = [];
            let more = await readMore();
            for (let page = 0; page < 3; page++) {
                if (!more) break;
                await leftClick(Math.round(more.x), Math.round(more.y));
                more = await readMore();
                if (more) pages.push(more.labels);
            }
            return pages;
        };
        const beforeSelection = await rightClick(center.x, center.y);
        record(
            "native right click before a manual selection opens and retains the radial menu",
            beforeSelection.contexts === beforeSelection.before + 1 &&
                beforeSelection.radialDisplay !== "none" &&
                beforeSelection.radialItems === 8 &&
                sameSelection(beforeSelection.selection, initialSelection),
            beforeSelection,
        );
        const centerBefore = await clip(`(() => {
            const r=document.querySelector('#radial_menu .radial-center').getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};
        })()`);
        await cdpMouse(
            "mouseMoved",
            Math.round(centerBefore.cx),
            Math.round(centerBefore.cy),
        );
        await cdpMouse(
            "mousePressed",
            Math.round(centerBefore.cx),
            Math.round(centerBefore.cy),
            "left",
            1,
        );
        await pause(60);
        const centerDuring = await clip(`(() => {
            const r=document.querySelector('#radial_menu .radial-center').getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};
        })()`);
        await cdpMouse(
            "mouseMoved",
            Math.round(centerBefore.cx + 80),
            Math.round(centerBefore.cy + 80),
            "left",
            1,
        );
        await cdpMouse(
            "mouseReleased",
            Math.round(centerBefore.cx + 80),
            Math.round(centerBefore.cy + 80),
            "left",
            0,
        );
        await pause(180);
        const centerAfter = await clip(`(() => {
            const element=document.querySelector('#radial_menu .radial-center');
            if(!element)return null;
            const r=element.getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};
        })()`);
        const pressShift = Math.hypot(
            centerDuring.cx - centerBefore.cx,
            centerDuring.cy - centerBefore.cy,
        );
        record(
            "pressing the radial X keeps its visual center fixed",
            pressShift <= 1 &&
                Boolean(centerAfter) &&
                Math.hypot(
                    centerAfter.cx - centerBefore.cx,
                    centerAfter.cy - centerBefore.cy,
                ) <= 1,
            {
                before: centerBefore,
                during: centerDuring,
                after: centerAfter,
                pressShift,
            },
        );
        await clip(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
        );
        const gesturePages = await pageCycle();
        const uniqueGesturePages = new Set(
            gesturePages.map((labels) => labels.join("|")),
        ).size;
        record(
            "native right click opens More and real clicks cycle pages 1 to 2 to the first page",
            gesturePages.length === 3 && uniqueGesturePages === 3,
            { gesturePages, uniqueGesturePages },
        );
        report.diagnostics.push({
            name: "held-right More gesture automation",
            verified: false,
            reason: "Electron CDP/webContents mouse injection did not surface the renderer pointerdown hold state; native release context and real More clicks were verified separately.",
        });
        await clip(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
        );

        const start = {
            x: Math.round(canvas.left + canvas.width * 0.24),
            y: Math.round(canvas.top + canvas.height * 0.22),
        };
        const end = {
            x: Math.round(canvas.left + canvas.width * 0.68),
            y: Math.round(canvas.top + canvas.height * 0.7),
        };
        await cdpMouse("mouseMoved", start.x, start.y);
        await cdpMouse("mousePressed", start.x, start.y, "left", 1);
        await cdpMouse("mouseMoved", end.x, end.y, "left", 1);
        await pause(100);
        const dragMagnifier = await clip(`(() => {
            const box=document.querySelector('#mouse_bar');
            const color=document.querySelector('#point_color');
            const marker=document.querySelector('#point_color > div');
            const row=document.querySelector('#clip_copy');
            const rect=element=>JSON.parse(JSON.stringify(element.getBoundingClientRect()));
            const colorRect=rect(color);
            const markerRect=rect(marker);
            return {
                box:rect(box),color:colorRect,marker:markerRect,row:rect(row),
                opacity:getComputedStyle(box).opacity,
                markerOffset:{
                    x:markerRect.x+markerRect.width/2-(colorRect.x+colorRect.width/2),
                    y:markerRect.y+markerRect.height/2-(colorRect.y+colorRect.height/2)
                }
            };
        })()`);
        fs.writeFileSync(
            path.join(evidence, "magnifier-drag.png"),
            (await capture.webContents.capturePage()).toPNG(),
        );
        record(
            "drag magnifier is a visible 96px square with a centered marker and 24px value row",
            Number(dragMagnifier.opacity) > 0.9 &&
                Math.abs(dragMagnifier.color.width - 96) <= 2 &&
                Math.abs(dragMagnifier.color.height - 96) <= 2 &&
                Math.abs(dragMagnifier.markerOffset.x) <= 1 &&
                Math.abs(dragMagnifier.markerOffset.y) <= 1 &&
                Math.abs(dragMagnifier.row.height - 24) <= 1,
            dragMagnifier,
        );
        await cdpMouse("mouseReleased", end.x, end.y, "left", 0);
        await pause(180);
        const selected = await clip(
            '[...document.querySelectorAll(".capture-dimensions input")].map(i=>Number(i.value))',
        );
        record(
            "ordinary region drag produces sensible capture pixels",
            selected[0] > 100 &&
                selected[1] > 100 &&
                selected[0] <
                    (await clip(
                        'document.querySelector("#main_photo").width',
                    )) &&
                selected[1] <
                    (await clip(
                        'document.querySelector("#main_photo").height',
                    )),
            { start, end, selected },
        );

        const viewport = await clip("({width:innerWidth,height:innerHeight})");
        const edgePoints = [
            { name: "top-left", x: 18, y: 18 },
            { name: "top-right", x: viewport.width - 18, y: 18 },
            { name: "bottom-left", x: 18, y: viewport.height - 18 },
            {
                name: "bottom-right",
                x: viewport.width - 18,
                y: viewport.height - 18,
            },
        ];
        for (const point of edgePoints) {
            const state = await rightClick(point.x, point.y);
            record(
                `right click near ${point.name} keeps the menu and selection`,
                state.contexts === state.before + 1 &&
                    state.radialDisplay !== "none" &&
                    state.radialItems === 8 &&
                    sameSelection(state.selection, selected),
                state,
            );
            await clip(
                'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
            );
        }

        const first = await rightClick(center.x - 80, center.y - 40);
        const second = await rightClick(center.x + 90, center.y + 55);
        record(
            "a second native right click reopens the menu without changing selection",
            first.radialDisplay !== "none" &&
                second.contexts === first.contexts + 1 &&
                second.radialDisplay !== "none" &&
                second.radialItems === 8 &&
                sameSelection(second.selection, selected),
            { first, second },
        );

        await cdpMouse("mouseMoved", center.x, center.y);
        await cdpMouse("mousePressed", center.x, center.y, "right", 2);
        await pause(80);
        dashboard.focus();
        await pause(120);
        capture.focus();
        const afterBlur = await rightClick(center.x, center.y);
        record(
            "a right-button blur cleanup permits the next native right click",
            afterBlur.radialDisplay !== "none" &&
                afterBlur.radialItems === 8 &&
                sameSelection(afterBlur.selection, selected),
            afterBlur,
        );

        const drawButton = await clip(`(() => {
            const button=document.querySelector('#radial_menu [data-capture-action="draw"]');
            return button ? JSON.parse(JSON.stringify(button.getBoundingClientRect())) : null;
        })()`);
        if (drawButton) {
            await leftClick(
                Math.round(drawButton.left + drawButton.width / 2),
                Math.round(drawButton.top + drawButton.height / 2),
            );
        }
        const toolState = await clip(`(() => ({
            selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
            radialDisplay:getComputedStyle(document.querySelector('#radial_menu')).display,
            drawDisplay:getComputedStyle(document.querySelector('#draw_bar')).display,
            drawOpacity:getComputedStyle(document.querySelector('#draw_bar')).opacity
        }))()`);
        record(
            "a real radial tool click is selectable without altering the capture",
            Boolean(drawButton) &&
                toolState.radialDisplay === "none" &&
                toolState.drawDisplay !== "none" &&
                Number(toolState.drawOpacity) > 0 &&
                sameSelection(toolState.selection, selected),
            { drawButton, toolState },
        );

        capture.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Escape",
        });
        capture.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "Escape",
        });
        await pause(300);
        const afterEscape = await clip(`(() => ({
            radialDisplay:getComputedStyle(document.querySelector('#radial_menu')).display,
            drawOpacity:getComputedStyle(document.querySelector('#draw_bar')).opacity,
            selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value))
        }))()`);
        const reopened = await rightClick(center.x, center.y);
        record(
            "Escape dismisses tools and the radial menu reopens on native right click",
            afterEscape.radialDisplay === "none" &&
                Number(afterEscape.drawOpacity) === 0 &&
                reopened.radialDisplay !== "none" &&
                reopened.radialItems === 8 &&
                sameSelection(afterEscape.selection, selected) &&
                sameSelection(reopened.selection, selected),
            { afterEscape, reopened },
        );

        await clip(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
        );
        const handle = await clip(`(() => {
            const element=document.querySelector('.handle-se');
            if(!element)return null;
            const r=element.getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()`);
        if (handle) {
            await cdpMouse(
                "mouseMoved",
                Math.round(handle.x),
                Math.round(handle.y),
            );
            await cdpMouse(
                "mousePressed",
                Math.round(handle.x),
                Math.round(handle.y),
                "left",
                1,
            );
            await cdpMouse(
                "mouseMoved",
                Math.round(handle.x + 48),
                Math.round(handle.y + 32),
                "left",
                1,
            );
            await cdpMouse(
                "mouseReleased",
                Math.round(handle.x + 48),
                Math.round(handle.y + 32),
                "left",
                0,
            );
            await pause(180);
        }
        const resized = await clip(`(() => ({
            selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
            rect:JSON.parse(JSON.stringify(document.querySelector('#selection_handles').getBoundingClientRect()))
        }))()`);
        const isolatedConfig = JSON.parse(
            fs.readFileSync(path.join(profile, "config.json"), "utf8"),
        );
        const savedRect = isolatedConfig.捕获?.上次区域;
        const display = screen.getDisplayNearestPoint({
            x: resized.rect.x + resized.rect.width / 2,
            y: resized.rect.y + resized.rect.height / 2,
        });
        record(
            "handle resize persists the last region in display DIP coordinates",
            Boolean(handle && savedRect) &&
                Math.abs(savedRect.x - (display.bounds.x + resized.rect.x)) <=
                    2 &&
                Math.abs(savedRect.y - (display.bounds.y + resized.rect.y)) <=
                    2 &&
                Math.abs(savedRect.w - resized.rect.width) <= 2 &&
                Math.abs(savedRect.h - resized.rect.height) <= 2,
            { handle, resized, savedRect, display: display.bounds },
        );

        const sendEscape = async () => {
            capture.webContents.sendInputEvent({
                type: "keyDown",
                keyCode: "Escape",
            });
            capture.webContents.sendInputEvent({
                type: "keyUp",
                keyCode: "Escape",
            });
            await pause(180);
        };
        await sendEscape();
        await until(() => !capture.isVisible(), "capture close through Escape");
        const reusedId = capture.webContents.id;
        const shownBefore = await dashboardRun(
            "window.openCapture.getState().then(state=>(state.runtime.captureDiagnostics ?? []).filter(trace=>trace.phase==='shown').length)",
        );
        await dashboardRun(
            "document.querySelector('[data-action=\"capture\"]').click(); true",
        );
        await until(
            () =>
                dashboardRun(
                    `window.openCapture.getState().then(state=>(state.runtime.captureDiagnostics ?? []).filter(trace=>trace.phase==='shown').length>${shownBefore})`,
                ),
            "new capture shown diagnostic",
        );
        const reopenedCapture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.id === reusedId &&
                        window.isVisible() &&
                        !window.webContents.isLoading(),
                ),
            "reused capture renderer",
        );
        assert.equal(reopenedCapture, capture);
        await until(
            () =>
                clip(
                    'document.body.style.opacity !== "0" && document.querySelector("#main_photo")?.width > 0',
                ),
            "reused capture initialization",
        );
        await pause(400);
        const reuseState = await clip(`(() => ({
            documentDisplay:getComputedStyle(document.documentElement).display,
            bodyDisplay:getComputedStyle(document.body).display,
            selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
            handlesHidden:document.querySelector('#selection_handles').hidden,
            toolbarOpacity:getComputedStyle(document.querySelector('#quick_toolbar')).opacity
        }))()`);
        record(
            "Escape closes and the same capture renderer reopens visibly with a blank selection",
            reuseState.documentDisplay !== "none" &&
                reuseState.bodyDisplay !== "none" &&
                reuseState.selection[0] === 0 &&
                reuseState.selection[1] === 0 &&
                reuseState.handlesHidden &&
                Number(reuseState.toolbarOpacity) === 0,
            { reusedId, reuseState },
        );

        const instrumentation = await clip(`(() => {
            window.__zeroSelection={ipc:[],errors:[]};
            const ipc=require('electron').ipcRenderer;
            const send=ipc.send.bind(ipc);
            const invoke=ipc.invoke.bind(ipc);
            ipc.send=(channel,...args)=>{window.__zeroSelection.ipc.push(['send',channel]);return send(channel,...args)};
            ipc.invoke=(channel,...args)=>{window.__zeroSelection.ipc.push(['invoke',channel]);return invoke(channel,...args)};
            addEventListener('error',event=>window.__zeroSelection.errors.push(event.message));
            addEventListener('unhandledrejection',event=>window.__zeroSelection.errors.push(String(event.reason)));
            return true;
        })()`);
        assert.equal(instrumentation, true);
        const clickZeroAction = (action) =>
            clip(`(() => {
                document.querySelector('#clip_photo').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${center.x},clientY:${center.y},button:2}));
                for(let page=0;page<4;page++){
                    const target=document.querySelector('#radial_menu [data-capture-action=${JSON.stringify(action)}]');
                    if(target){target.click();return true}
                    const more=document.querySelector('#radial_menu [data-capture-action="more"]');
                    if(!more)return false;
                    more.click();
                }
                return false;
            })()`);
        const readZeroState = () =>
            clip(`(() => ({
                selection:[...document.querySelectorAll('.capture-dimensions input')].map(i=>Number(i.value)),
                ipc:[...window.__zeroSelection.ipc],
                errors:[...window.__zeroSelection.errors]
            }))()`);
        const ipcDelta = (before, after) =>
            after.ipc
                .slice(before.ipc.length)
                .filter(([, channel]) => channel !== "store");
        const isZeroArea = ([width, height]) => width * height === 0;
        const zeroActions = {};
        for (const action of ["ocr", "QR", "ding", "editor", "save", "copy"]) {
            const before = await readZeroState();
            const clicked = await clickZeroAction(action);
            await pause(80);
            const after = await readZeroState();
            zeroActions[action] = {
                clicked,
                before: before.selection,
                after: after.selection,
                ipc: ipcDelta(before, after),
                errors: after.errors.slice(before.errors.length),
            };
        }
        const shortcutResults = {};
        let shortcutBefore = await readZeroState();
        capture.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Enter",
        });
        capture.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "Enter",
        });
        await pause(80);
        let shortcutAfter = await readZeroState();
        shortcutResults.Enter = {
            before: shortcutBefore.selection,
            after: shortcutAfter.selection,
            ipc: ipcDelta(shortcutBefore, shortcutAfter),
            errors: shortcutAfter.errors.slice(shortcutBefore.errors.length),
        };
        for (const keyCode of ["C", "S"]) {
            shortcutBefore = await readZeroState();
            capture.webContents.sendInputEvent({
                type: "keyDown",
                keyCode,
                modifiers: ["control"],
            });
            capture.webContents.sendInputEvent({
                type: "keyUp",
                keyCode,
                modifiers: ["control"],
            });
            await pause(80);
            shortcutAfter = await readZeroState();
            shortcutResults[`Ctrl${keyCode}`] = {
                before: shortcutBefore.selection,
                after: shortcutAfter.selection,
                ipc: ipcDelta(shortcutBefore, shortcutAfter),
                errors: shortcutAfter.errors.slice(
                    shortcutBefore.errors.length,
                ),
            };
        }
        await pause(100);
        const zeroResult = await clip("window.__zeroSelection");
        const workIpc = zeroResult.ipc.filter(
            ([, channel]) => channel !== "store",
        );
        const zeroStatus = await clip(
            "[...document.querySelectorAll('.capture-workspace-status')].find(e=>!e.hidden)?.textContent?.trim() ?? ''",
        );
        record(
            "zero-selection tools and shortcuts do not emit work or errors",
            Object.values(zeroActions).every(
                ({ clicked, before, after, ipc, errors }) =>
                    clicked &&
                    isZeroArea(before) &&
                    isZeroArea(after) &&
                    ipc.length === 0 &&
                    errors.length === 0,
            ) &&
                Object.values(shortcutResults).every(
                    ({ before, after, ipc, errors }) =>
                        isZeroArea(before) &&
                        isZeroArea(after) &&
                        ipc.length === 0 &&
                        errors.length === 0,
                ) &&
                workIpc.length === 0 &&
                zeroResult.errors.length === 0 &&
                zeroStatus.includes("영역"),
            {
                zeroActions,
                shortcutResults,
                zeroResult,
                workIpc,
                zeroStatus,
            },
        );

        fs.writeFileSync(
            path.join(evidence, "baseline.png"),
            (await capture.webContents.capturePage()).toPNG(),
        );
        if (capture.webContents.debugger.isAttached())
            capture.webContents.debugger.detach();
        await clip('require("electron").ipcRenderer.send("clip_close"); true');
        finish(report.failures.length ? 1 : 0);
    })
    .catch((error) => finish(1, error));
