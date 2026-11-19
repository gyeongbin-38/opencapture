const { app, BrowserWindow, clipboard, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "capture-controls");
fs.mkdirSync(evidence, { recursive: true });
const profile = path.join(evidence, `profile-${Date.now()}`);
fs.mkdirSync(profile);
process.argv.push(`--userData=${profile}`);
const errors = [];
const fixtures = path.join(evidence, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
app.setPath("pictures", fixtures);
app.on("browser-window-created", (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    const moveOffscreen = () => {
        const b = win.getBounds();
        if (b.x !== -30000)
            win.setBounds({
                x: -30000,
                y: -30000,
                width: b.width,
                height: b.height,
            });
    };
    const origSSF = win.setSimpleFullScreen.bind(win);
    win.setSimpleFullScreen = (flag) => {
        if (flag) moveOffscreen();
        else origSSF(flag);
    };
    const origFS = win.setFullScreen.bind(win);
    win.setFullScreen = (flag) => {
        if (flag) moveOffscreen();
        else origFS(flag);
    };
    win.on("show", moveOffscreen);
});
app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (event) => {
        if (event.level === "error") errors.push(event.message);
    });
});
require("../out/main/main.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
    for (let i = 0; i < 200; i++) {
        const result = await check();
        if (result) return result;
        await pause(100);
    }
    throw new Error(message);
}
function assert(value, message) {
    if (!value) throw new Error(message);
}
const report = { checks: [], errors };
async function shot(window, name) {
    await pause(160);
    try {
        fs.writeFileSync(
            path.join(evidence, `${name}.png`),
            (await window.webContents.capturePage()).toPNG(),
        );
    } catch {
        // hidden windows may not produce compositor frames
    }
}
const timer = setTimeout(() => {
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify({ ...report, timeout: true }, null, 2),
    );
    app.exit(1);
}, 90000);
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
            "Dashboard did not load",
        );
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    'Boolean(window.openCapture && document.querySelector(".nav-button"))',
                ),
            "Dashboard controls missing",
        );
        await run(
            'localStorage.setItem("oc:onboarded", "1"); for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close(); document.querySelector(".modal-backdrop").hidden = true;',
        );
        await run(
            'window.openCapture.action("configure-workflow", { autoOcr: false, autoPreview: false, autoClipboard: false })',
        );
        const paths = [];
        for (let index = 0; index < 3; index++) {
            const data = await run(`(() => {
                const c = document.createElement('canvas'); c.width = 1000; c.height = 620;
                const ctx = c.getContext('2d'); ctx.fillStyle = '#fafafa'; ctx.fillRect(0,0,1000,620);
                ctx.fillStyle = '#18181c'; ctx.fillRect(0,0,1000,48); ctx.fillStyle = '#fff';
                ctx.font = '15px Segoe UI'; ctx.fillText('Reference ${index + 1} / Product workspace',24,30);
                ctx.fillStyle = '#f0f0f2'; ctx.fillRect(0,48,200,572); ctx.fillStyle = '#29292e';
                ctx.font = '26px Segoe UI'; ctx.fillText('A quieter workspace',250,120);
                ctx.font = '14px Segoe UI'; ctx.fillStyle = '#71717a'; ctx.fillText('Capture, annotate and compare.',250,155);
                ctx.fillStyle = ['#e8e8ed','#dedee5','#d4d4de'][${index}]; ctx.fillRect(250,200,680,240);
                ctx.fillStyle = '#18181c'; ctx.fillRect(250 + ${index * 36},478,140,38);
                ctx.fillStyle = '#fff'; ctx.fillText('Continue',275 + ${index * 36},502);
                return c.toDataURL('image/png');
            })()`);
            const file = path.join(evidence, `reference-${index + 1}.png`);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            paths.push(file);
        }
        await run(
            'const fixtureInput = document.createElement("input"); fixtureInput.type="file"; fixtureInput.multiple=true; fixtureInput.id="qa-files"; fixtureInput.hidden=true; document.body.append(fixtureInput);',
        );
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#qa-files" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: paths },
        );
        const state = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#qa-files").files))',
        );
        assert(state.items.length === 3, "Fixture imports failed");
        const id = state.items[0].id;
        await run(
            `window.openCapture.action('open-item', ${JSON.stringify(id)})`,
        );
        const capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Capture did not load",
        );
        const clip = (code) =>
            capture.webContents.executeJavaScript(code, true);
        // Synthetic key presses must pair keydown with keyup: hotkeys-js only
        // fires a shortcut when the held-key set matches exactly, so a keydown
        // without keyup leaves the key "held" and blocks later shortcuts.
        const pressKey = (key, code) =>
            clip(
                `(() => { for (const type of ["keydown","keyup"]) document.dispatchEvent(new KeyboardEvent(type,{key:"${key}",keyCode:${code},which:${code},bubbles:true})); })()`,
            );
        await until(
            () =>
                clip(
                    'document.body.style.opacity !== "0" && Boolean(document.querySelector("#quick_toolbar"))',
                ),
            "Capture initialization failed",
        );
        const hintInitial = await clip(
            '(() => { const h = document.querySelector(".capture-start-hint"); return { exists: Boolean(h), hidden: h?.classList.contains("hint-hidden"), items: h?.querySelectorAll(".capture-start-hint-item").length }; })()',
        );
        assert(hintInitial.exists, "Start hint missing");
        assert(!hintInitial.hidden, "Start hint hidden on first open");
        assert(hintInitial.items >= 5, "Start hint incomplete");
        const primaryTool = await clip(
            'document.querySelector(".capture-tool.is-primary")?.dataset.captureAction ?? null',
        );
        assert(primaryTool, "Primary action button not marked");
        await shot(capture, "capture-start-hint");
        const rectangle = await clip(
            'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
        );
        const start = {
            x: Math.round(rectangle.x + rectangle.width * 0.18),
            y: Math.round(rectangle.y + rectangle.height * 0.15),
        };
        const end = {
            x: Math.round(rectangle.x + rectangle.width * 0.8),
            y: Math.round(rectangle.y + rectangle.height * 0.82),
        };
        capture.webContents.sendInputEvent({ type: "mouseMove", ...start });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...start,
        });
        capture.webContents.sendInputEvent({ type: "mouseMove", ...end });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...end,
        });
        await pause(200);
        const ui = await clip(
            `(() => { const selection=document.querySelector('#selection_handles'); const toolbar=document.querySelector('#quick_toolbar'); const frame=document.querySelector('#selection_frame'); const fcs=getComputedStyle(frame); return { handles:selection.querySelectorAll('.capture-handle').length, hidden:selection.hidden, selection:JSON.parse(JSON.stringify(selection.getBoundingClientRect())), toolbar:JSON.parse(JSON.stringify(toolbar.getBoundingClientRect())), size:[...document.querySelectorAll('.capture-dimensions input')].map(i=>i.value), background:getComputedStyle(toolbar).backgroundColor, colorPanelHidden:document.querySelector('#mouse_bar').classList.contains('mouse_bar_hide'), frame:{display:fcs.display,borderWidth:fcs.borderWidth,outlineWidth:fcs.outlineWidth,rect:JSON.parse(JSON.stringify(frame.getBoundingClientRect()))} } })()`,
        );
        assert(
            ui.handles === 8 && !ui.hidden,
            "Resize handles are not visible",
        );
        assert(ui.size[0] !== "1000", "Selection drag was intercepted");
        assert(
            ui.toolbar.y >= ui.selection.bottom,
            "Toolbar is not below the capture",
        );
        assert(ui.toolbar.height < 50, "Toolbar is too tall");
        assert(
            ui.frame.display !== "none" &&
                parseFloat(ui.frame.borderWidth) > 0 &&
                parseFloat(ui.frame.outlineWidth) > 0 &&
                Math.abs(ui.frame.rect.x - ui.selection.x) < 3,
            `Selection frame is not crisp: ${JSON.stringify(ui.frame)}`,
        );
        assert(
            await clip(
                'document.querySelector(".capture-start-hint").classList.contains("hint-hidden")',
            ),
            "Start hint did not dismiss after drag",
        );
        report.checks.push({ captureLayout: ui, startHint: hintInitial });
        await shot(capture, "capture-toolbar");
        await until(
            () =>
                clip(
                    'Boolean(document.querySelector(".capture-shelf-card .capture-shelf-action"))',
                ),
            "Shelf card actions did not appear",
        );
        const shelfCard = await clip(
            '(() => { const card=document.querySelector(".capture-shelf-card"); return { cards:document.querySelectorAll(".capture-shelf-card").length, actions:card.querySelectorAll(".capture-shelf-action").length, titles:[...card.querySelectorAll(".capture-shelf-action")].map((b)=>b.dataset.title) }; })()',
        );
        assert(
            shelfCard.cards === 1 && shelfCard.actions === 3,
            "Shelf quick actions missing",
        );
        await clip('document.querySelector(".capture-shelf-action").click()');
        await until(
            async () =>
                await clip(
                    '(() => { const s=document.querySelector(".capture-workspace-status"); return Boolean(s && !s.classList.contains("has-error") && s.textContent.includes("이미지를 복사했습니다.")); })()',
                ),
            "Shelf copy action did not confirm",
        );
        report.checks.push({ shelfCard });
        const before = ui.size.map(Number);
        await clip(
            'const widthInput=document.querySelector(".capture-dimensions input"); widthInput.value="480"; widthInput.dispatchEvent(new Event("change",{bubbles:true}));',
        );
        const sizeAfter = await clip(
            '[...document.querySelectorAll(".capture-dimensions input")].map(i=>Number(i.value))',
        );
        assert(sizeAfter[0] === 480, "Width input did not resize capture");
        await clip(
            'const ratioLock=document.querySelector(\'#clip_wh button[aria-label="비율 고정"]\'); ratioLock.click(); if(ratioLock.getAttribute("aria-pressed")!=="true") throw new Error("Ratio lock did not activate"); const heightInput=document.querySelectorAll(".capture-dimensions input")[1]; heightInput.value="250"; heightInput.dispatchEvent(new Event("change",{bubbles:true}));',
        );
        const locked = await clip(
            '[...document.querySelectorAll(".capture-dimensions input")].map(i=>Number(i.value))',
        );
        assert(
            Math.abs(locked[0] / locked[1] - 480 / sizeAfter[1]) < 0.01,
            "Ratio locking failed",
        );
        const handle = await clip(
            'JSON.parse(JSON.stringify(document.querySelector(".handle-se").getBoundingClientRect()))',
        );
        const hp = {
            x: Math.round(handle.x + handle.width / 2),
            y: Math.round(handle.y + handle.height / 2),
        };
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...hp,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: hp.x + 40,
            y: hp.y + 25,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: hp.x + 40,
            y: hp.y + 25,
        });
        await pause(150);
        const dragged = await clip(
            '[...document.querySelectorAll(".capture-dimensions input")].map(i=>Number(i.value))',
        );
        assert(
            dragged[0] > locked[0],
            `Resize handle drag failed: ${JSON.stringify({ locked, dragged, handle, hp })}`,
        );
        report.checks.push({
            numericResize: { before, sizeAfter },
            ratioLocked: locked,
            handleResize: dragged,
        });
        // Drag from outside the active selection toward the canvas midline:
        // the moving right edge should snap and show a guide line.
        const snapStart = {
            x: Math.round(rectangle.x + rectangle.width * 0.03),
            y: Math.round(rectangle.y + rectangle.height * 0.03),
        };
        const snapEnd = {
            x: Math.round(rectangle.x + rectangle.width * 0.5 - 2),
            y: Math.round(rectangle.y + rectangle.height * 0.55),
        };
        capture.webContents.sendInputEvent({ type: "mouseMove", ...snapStart });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...snapStart,
        });
        capture.webContents.sendInputEvent({ type: "mouseMove", ...snapEnd });
        await pause(120);
        const guideCount = await clip(
            'document.querySelectorAll("#capture_snap_guides > *").length',
        );
        assert(guideCount >= 1, "Snap guide did not render near midline");
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...snapEnd,
        });
        await pause(120);
        assert(
            (await clip(
                'document.querySelectorAll("#capture_snap_guides > *").length',
            )) === 0,
            "Snap guide did not clear after drag",
        );
        report.checks.push({ snapGuides: guideCount });
        // Cover the full canvas: the dimensions bar must not overlap the toolbar.
        await clip(
            '(() => { const rl=document.querySelector(\'#clip_wh button[aria-pressed="true"]\'); rl?.click(); const inputs=document.querySelectorAll("#clip_wh input"); for (const [i,v] of [[0,"0"],[1,"0"],[4,String(innerWidth*2)],[5,String(innerHeight*2)]]) { inputs[i].value=v; inputs[i].dispatchEvent(new Event("change",{bubbles:true})); } })()',
        );
        await pause(120);
        const dimBar = await clip(
            '(() => { const wh=document.querySelector("#clip_wh").getBoundingClientRect(); const tb=document.querySelector("#quick_toolbar").getBoundingClientRect(); return { wh:JSON.parse(JSON.stringify(wh)), tb:JSON.parse(JSON.stringify(tb)), intersects: wh.left < tb.right && wh.right > tb.left && wh.top < tb.bottom && wh.bottom > tb.top }; })()',
        );
        assert(
            !dimBar.intersects,
            `Dimensions bar overlaps toolbar on full-screen selection: ${JSON.stringify(dimBar)}`,
        );
        report.checks.push({ dimBar });
        await shot(capture, "capture-fullscreen-dimbar");
        // The dimensions bar can be dragged by its grip and stays pinned.
        const whGripPos = await clip(
            '(() => { const g=document.querySelector("#clip_wh .capture-grip").getBoundingClientRect(); return {x:Math.round(g.left+g.width/2),y:Math.round(g.top+g.height/2)}; })()',
        );
        const whBefore = await clip(
            '(() => { const r=document.querySelector("#clip_wh").getBoundingClientRect(); return {x:r.left,y:r.top}; })()',
        );
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...whGripPos,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...whGripPos,
        });
        for (const step of [1, 2, 3, 4, 5, 6]) {
            capture.webContents.sendInputEvent({
                type: "mouseMove",
                x: whGripPos.x + step * 24,
                y: whGripPos.y + step * 12,
            });
            await pause(40);
        }
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: whGripPos.x + 144,
            y: whGripPos.y + 72,
        });
        await pause(150);
        const whAfter = await clip(
            '(() => { const el=document.querySelector("#clip_wh"); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top,pinned:el.hasAttribute("data-pinned")}; })()',
        );
        assert(
            whAfter.pinned &&
                Math.abs(whAfter.x - whBefore.x - 144) <= 30 &&
                Math.abs(whAfter.y - whBefore.y - 72) <= 30,
            `Dimensions bar drag failed: ${JSON.stringify({ whBefore, whAfter })}`,
        );
        // Resizing the selection re-runs whBar; the pinned bar must stay put.
        await clip(
            '(() => { const inputs=document.querySelectorAll(".capture-dimensions input"); inputs[0].value="640"; inputs[0].dispatchEvent(new Event("change",{bubbles:true})); })()',
        );
        await pause(150);
        const whPinnedNow = await clip(
            '(() => { const r=document.querySelector("#clip_wh").getBoundingClientRect(); return {x:r.left,y:r.top}; })()',
        );
        assert(
            Math.abs(whPinnedNow.x - whAfter.x) <= 1 &&
                Math.abs(whPinnedNow.y - whAfter.y) <= 1,
            `Pinned dimensions bar moved: ${JSON.stringify({ whAfter, whPinnedNow })}`,
        );
        // Double-clicking the grip restores automatic docking.
        await clip(
            'document.querySelector("#clip_wh .capture-grip").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))',
        );
        await pause(150);
        const whReset = await clip(
            '(() => { const el=document.querySelector("#clip_wh"); const r=el.getBoundingClientRect(); return {x:r.left,y:r.top,pinned:el.hasAttribute("data-pinned")}; })()',
        );
        assert(
            !whReset.pinned &&
                (Math.abs(whReset.x - whAfter.x) > 1 ||
                    Math.abs(whReset.y - whAfter.y) > 1),
            `Dimensions bar reset failed: ${JSON.stringify({ whAfter, whReset })}`,
        );
        report.checks.push({ whBarPin: { whBefore, whAfter, whReset } });
        // F toggles rect/free selection mode with visible feedback.
        await pressKey("f", 70);
        await until(
            () =>
                clip(
                    'document.querySelector(".capture-workspace-status")?.textContent.includes("자유 선택")',
                ),
            "Free selection mode status did not appear",
            400,
        );
        await pressKey("f", 70);
        await until(
            () =>
                clip(
                    'document.querySelector(".capture-workspace-status")?.textContent.includes("사각형 선택")',
                ),
            "Rect selection mode status did not appear",
            400,
        );
        report.checks.push({ freeSelectToggle: true });
        // F converts the active rect into a free-form polygon; it gets the
        // crisp SVG frame and moving it snaps the bounding box like rects.
        await pressKey("f", 70);
        await pause(150);
        const polyFrame = await clip(
            `(() => { const svg=document.querySelector('#selection_frame_poly'); const line=svg?.querySelectorAll('path')[1]; const d=line?.getAttribute('d') ?? ''; return { display: svg ? getComputedStyle(svg).display : 'missing', segments: (d.match(/L/g) ?? []).length, closed: d.endsWith('Z'), outline: svg?.querySelector('path')?.getAttribute('stroke-width') ?? '' }; })()`,
        );
        assert(
            polyFrame.display !== "none" &&
                polyFrame.segments >= 3 &&
                polyFrame.closed,
            `Free-form frame missing: ${JSON.stringify(polyFrame)}`,
        );
        report.checks.push({ polyFrame });
        await shot(capture, "capture-freeform-frame");
        // Dragging the polygon snaps its bounding box to the canvas edge.
        const grab = {
            x: Math.round(rectangle.x + rectangle.width * 0.5),
            y: Math.round(rectangle.y + rectangle.height * 0.5),
        };
        capture.webContents.sendInputEvent({ type: "mouseMove", ...grab });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...grab,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: grab.x + 3,
            y: grab.y,
        });
        await pause(120);
        const polyGuides = await clip(
            'document.querySelectorAll("#capture_snap_guides > *").length',
        );
        assert(polyGuides >= 1, "Polygon move did not snap to canvas edge");
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: grab.x + 3,
            y: grab.y,
        });
        await pause(120);
        assert(
            (await clip(
                'document.querySelectorAll("#capture_snap_guides > *").length',
            )) === 0,
            "Polygon snap guides did not clear",
        );
        report.checks.push({ polySnap: polyGuides });
        await pressKey("f", 70);
        await pause(120);
        // Shift+drag stages the current region and reports the running count.
        const pushedRect = await clip(
            '(() => { const r=document.querySelector("#selection_frame").getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()',
        );
        const batchDrag = [
            {
                x: Math.round(rectangle.x + rectangle.width * 0.55),
                y: Math.round(rectangle.y + rectangle.height * 0.55),
            },
            {
                x: Math.round(rectangle.x + rectangle.width * 0.7),
                y: Math.round(rectangle.y + rectangle.height * 0.72),
            },
        ];
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...batchDrag[0],
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            modifiers: ["shift"],
            ...batchDrag[1],
        });
        await pause(80);
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...batchDrag[1],
        });
        const regionStatus = await until(
            () =>
                clip(
                    '(() => { const s=document.querySelector(".capture-workspace-status"); return s?.textContent.includes("영역 보관됨") ? s.textContent : null; })()',
                ),
            "Region count status did not appear",
            400,
        );
        const shelfCount = await clip(
            'document.querySelector(".capture-shelf-count")?.textContent ?? ""',
        );
        report.checks.push({ regionStatus, shelfCount });
        // Each staged region leaves a numbered marker so captured areas
        // stay visible while drawing the next one.
        const staged1 = await clip(
            `(() => [...document.querySelectorAll('#capture_staged > div')].map(b => { const r=b.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,badge:b.querySelector('.capture-staged-badge')?.textContent ?? ''}; }))()`,
        );
        assert(
            staged1.length === 1 &&
                staged1[0].badge === "1" &&
                Math.abs(staged1[0].x - pushedRect.x) <= 4 &&
                Math.abs(staged1[0].y - pushedRect.y) <= 4 &&
                Math.abs(staged1[0].w - pushedRect.w) <= 4 &&
                Math.abs(staged1[0].h - pushedRect.h) <= 4,
            `Staged region marker missing: ${JSON.stringify({ staged1, pushedRect })}`,
        );
        const batchDrag2 = [
            {
                x: Math.round(rectangle.x + rectangle.width * 0.8),
                y: Math.round(rectangle.y + rectangle.height * 0.1),
            },
            {
                x: Math.round(rectangle.x + rectangle.width * 0.92),
                y: Math.round(rectangle.y + rectangle.height * 0.25),
            },
        ];
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...batchDrag2[0],
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            modifiers: ["shift"],
            ...batchDrag2[1],
        });
        await pause(80);
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...batchDrag2[1],
        });
        await pause(150);
        const staged2 = await clip(
            `(() => [...document.querySelectorAll('#capture_staged > div')].map(b => { const r=b.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,badge:b.querySelector('.capture-staged-badge')?.textContent ?? ''}; }))()`,
        );
        assert(
            staged2.length === 2 &&
                staged2[0].badge === "1" &&
                staged2[1].badge === "2" &&
                Math.abs(staged2[1].x - batchDrag[0].x) <= 12 &&
                Math.abs(staged2[1].y - batchDrag[0].y) <= 12,
            `Second staged marker wrong: ${JSON.stringify(staged2)}`,
        );
        report.checks.push({ stagedMarkers: staged2 });
        await shot(capture, "capture-staged-markers");
        // Free-form lasso: while drawing, a marker sits at the start point
        // and is emphasized when the pointer returns near the origin.
        await pressKey("f", 70);
        await pause(150);
        const lassoOrigin = {
            x: Math.round(rectangle.x + rectangle.width * 0.15),
            y: Math.round(rectangle.y + rectangle.height * 0.2),
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...lassoOrigin,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...lassoOrigin,
        });
        for (const [fx, fy] of [
            [0.3, 0.2],
            [0.3, 0.35],
            [0.15, 0.35],
        ]) {
            capture.webContents.sendInputEvent({
                type: "mouseMove",
                x: Math.round(rectangle.x + rectangle.width * fx),
                y: Math.round(rectangle.y + rectangle.height * fy),
            });
            await pause(90);
        }
        const lassoMarker = await clip(
            '(() => { const m=document.querySelector(".capture-free-start"); return { shown: m && getComputedStyle(m).display !== "none" }; })()',
        );
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(rectangle.x + rectangle.width * 0.16),
            y: Math.round(rectangle.y + rectangle.height * 0.21),
        });
        await pause(120);
        const lassoNear = await clip(
            'document.querySelector(".capture-free-start")?.classList.contains("is-near")',
        );
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(rectangle.x + rectangle.width * 0.24),
            y: Math.round(rectangle.y + rectangle.height * 0.29),
        });
        await pause(120);
        const lassoFar = await clip(
            'document.querySelector(".capture-free-start")?.classList.contains("is-near")',
        );
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: Math.round(rectangle.x + rectangle.width * 0.24),
            y: Math.round(rectangle.y + rectangle.height * 0.29),
        });
        await pause(150);
        const lassoGone = await clip(
            '(() => { const m=document.querySelector(".capture-free-start"); return !m || getComputedStyle(m).display === "none"; })()',
        );
        assert(
            lassoMarker?.shown && lassoNear === true && lassoFar === false && lassoGone,
            `Lasso start marker failed: ${JSON.stringify({ lassoMarker, lassoNear, lassoFar, lassoGone })}`,
        );
        report.checks.push({ lassoMarker: true });
        // Releasing a jittery stroke simplifies it: hand-shake points near
        // each leg's chord are dropped, deliberate corners are kept.
        const jx = (f) => Math.round(rectangle.x + rectangle.width * f);
        const jy = (f) => Math.round(rectangle.y + rectangle.height * f);
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: jx(0.45),
            y: jy(0.2),
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: jx(0.45),
            y: jy(0.2),
        });
        for (let i = 1; i <= 6; i++) {
            capture.webContents.sendInputEvent({
                type: "mouseMove",
                x: jx(0.45 + (0.15 * i) / 6),
                y: jy(0.2) + (i % 2 ? 1 : -1),
            });
            await pause(40);
        }
        for (const m of [
            { x: jx(0.6), y: jy(0.4) },
            { x: jx(0.46), y: jy(0.39) },
        ]) {
            capture.webContents.sendInputEvent({ type: "mouseMove", ...m });
            await pause(40);
        }
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: jx(0.46),
            y: jy(0.39),
        });
        await pause(150);
        const lassoSmooth = await clip(
            `(() => { const paths=document.querySelectorAll('#selection_frame_poly path'); const d=paths[paths.length-1]?.getAttribute('d') ?? ''; return { segments: (d.match(/L/g) ?? []).length }; })()`,
        );
        assert(
            lassoSmooth.segments >= 2 && lassoSmooth.segments <= 6,
            `Lasso smoothing left too many vertices: ${JSON.stringify(lassoSmooth)}`,
        );
        report.checks.push({ lassoSmooth: lassoSmooth.segments });
        await pressKey("f", 70);
        await pause(120);
        // W toggles region/window selection modes with visible feedback:
        // either the pick guidance or a "no windows" error.
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(rectangle.x + rectangle.width * 0.05),
            y: Math.round(rectangle.y + rectangle.height * 0.05),
        });
        await pause(120);
        await pressKey("w", 87);
        let windowModeStatus = null;
        let lastStatus = "";
        for (let i = 0; i < 60 && !windowModeStatus; i++) {
            const probe = await clip(
                '(() => { const s=document.querySelector(".capture-workspace-status"); const t=s?.textContent ?? ""; return { t, err: s?.classList.contains("has-error"), hidden: s?.hidden }; })()',
            );
            lastStatus = JSON.stringify(probe);
            if (
                probe.t.includes("창 위로") ||
                probe.err
            )
                windowModeStatus = probe.t;
            else await pause(100);
        }
        assert(
            windowModeStatus,
            `Window-mode toggle produced no status feedback, last=${lastStatus}`,
        );
        report.checks.push({ windowModeStatus });
        // Clear the sticky error (or any message) so later checks read fresh.
        await clip(
            'document.querySelector(".capture-workspace-status.has-error button")?.click()',
        );
        await pause(120);
        // In window mode, hovering a detected window shows a pointer cursor
        // and the emphasized outline. Sweep a grid until a candidate is hit.
        let windowCursor = null;
        let edgeHits = 0;
        outer: for (const fy of [0.15, 0.3, 0.45, 0.6, 0.8])
            for (const fx of [0.12, 0.3, 0.5, 0.7, 0.88]) {
                capture.webContents.sendInputEvent({
                    type: "mouseMove",
                    x: Math.round(rectangle.x + rectangle.width * fx),
                    y: Math.round(rectangle.y + rectangle.height * fy),
                });
                await pause(70);
                const probe = await clip(
                    '({c: document.querySelector("#clip_photo").style.cursor, e: document.querySelectorAll("#capture_edge > *").length})',
                );
                if (probe.e > 0) {
                    edgeHits++;
                    assert(
                        probe.c === "pointer",
                        `Window-mode hover did not show pointer cursor: ${JSON.stringify(probe)}`,
                    );
                    windowCursor = probe.c;
                    break outer;
                }
            }
        report.checks.push({ windowCursor, edgeHits });
        await pressKey("w", 87);
        await pause(120);
        const scrollHint = await clip(
            '(() => { const h=document.querySelector(".capture-scroll-hint"); return { exists: Boolean(h), hidden: h?.hidden ?? null }; })()',
        );
        assert(scrollHint.exists, "Scroll capture hint missing");
        report.checks.push({ scrollHint });
        await clip(
            'document.querySelectorAll("#quick_toolbar button")[4].click();',
        );
        assert(
            await clip('!document.querySelector("#capture_tools").hidden'),
            "More tools did not expand",
        );
        await clip(
            'const sizeInput=document.querySelector(".capture-size-setting input"); sizeInput.value="40";sizeInput.dispatchEvent(new Event("input",{bubbles:true}));',
        );
        const sizeStyle = await clip(
            '(() => {const b=document.querySelector("#quick_toolbar button");const c=getComputedStyle(b);const rules=[];for(const sheet of document.styleSheets)for(const rule of sheet.cssRules){if(rule.selectorText&&b.matches(rule.selectorText)&&rule.style.width)rules.push({selector:rule.selectorText,width:rule.style.width})}return {width:b.getBoundingClientRect().width,barSize:c.getPropertyValue("--bar-size"),rootBarSize:getComputedStyle(document.documentElement).getPropertyValue("--bar-size"),cssWidth:c.width,border:c.border,padding:c.padding,boxSizing:c.boxSizing,html:b.outerHTML,rules}})()',
        );
        assert(
            Math.round(sizeStyle.width) === 40,
            `Toolbar size adjustment failed: ${JSON.stringify(sizeStyle)}`,
        );
        await clip(
            'document.querySelector(".capture-size-setting input").value="32";document.querySelector(".capture-size-setting input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#capture_tools").hidden=true;',
        );
        await clip(
            'document.querySelector("#clip_photo").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:620,clientY:320,button:2}));',
        );
        await pause(350);
        assert(
            await clip(
                'document.querySelectorAll(".radial_item").length === 8',
            ),
            "Right click radial tools missing",
        );
        await shot(capture, "capture-radial");
        await clip(
            '[...document.querySelectorAll(".radial_item")].find(b=>b.getAttribute("aria-label")==="더보기").click();',
        );
        await clip(
            '[...document.querySelectorAll(".radial_item")].find(b=>b.getAttribute("aria-label")==="다음 도구").click();',
        );
        assert(
            await clip(
                '[...document.querySelectorAll(".radial_item")].some(b=>b.getAttribute("aria-label")==="다른 앱에서 열기")',
            ),
            "Additional radial page dropped tools",
        );
        await clip(
            'document.querySelector("#clip_photo").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:620,clientY:320,button:2}));',
        );
        await capture.webContents.debugger.attach("1.3");
        await capture.webContents.debugger.sendCommand(
            "Emulation.setEmulatedMedia",
            { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
        );
        assert(
            await clip(
                '[...document.querySelectorAll(".radial_item")].every(el=>getComputedStyle(el).animationName==="none")',
            ),
            "Reduced motion was ignored",
        );
        await clip(
            'for (const type of ["keydown","keyup"]) document.dispatchEvent(new KeyboardEvent(type,{key:"Escape",keyCode:27,which:27,bubbles:true}));',
        );
        assert(
            await clip(
                'getComputedStyle(document.querySelector("#radial_menu")).display === "none"',
            ),
            "Escape did not dismiss tools",
        );
        report.checks.push({
            radialCount: 8,
            reducedMotion: true,
            toolbarSizeAdjustment: true,
        });
        capture.hide();
        await run('document.querySelectorAll(".nav-button")[1].click();');
        await until(
            () => run('document.querySelectorAll(".item-select").length === 3'),
            "Library fixtures not rendered",
        );
        await run(
            '[...document.querySelectorAll(".selection-actions button")].find(b=>b.textContent.trim()==="표시된 항목 모두 선택").click();',
        );
        assert(
            await run(
                'document.querySelectorAll(".item-select:checked").length===3',
            ),
            "Library selection failed",
        );
        await run(
            '[...document.querySelectorAll(".selection-actions button")].find(b=>b.textContent.trim()==="비교").click();',
        );
        await until(
            () => run('document.querySelector("dialog.rc-dialog[open]")'),
            "Comparison dialog did not open",
        );
        await until(
            () =>
                run(
                    'document.querySelector(".rc-dialog .rc-status")?.textContent.includes("·")',
                ),
            "Comparison images did not load",
        );
        await shot(dashboard, "compare-side");
        await run(
            'document.querySelector(".rc-dialog .compare-mode-button[data-mode=opacity]").click();',
        );
        assert(
            await run(
                'document.querySelector(".rc-dialog .compare-mode-button[data-mode=opacity]").classList.contains("active")',
            ),
            "Opacity mode did not activate",
        );
        await shot(dashboard, "compare-opacity");
        await run(
            'document.querySelector(".rc-dialog .compare-mode-button[data-mode=wipe]").click();',
        );
        await until(
            () =>
                run(
                    '[...document.querySelectorAll(".rc-dialog .rc-range")].filter(l=>!l.hidden).length===1',
                ),
            "Wipe slider did not appear",
        );
        await run(
            'const wipeRange=[...document.querySelectorAll(".rc-dialog .rc-range")].find(l=>!l.hidden);const wipe=wipeRange.querySelector("input");wipe.value="35";wipe.dispatchEvent(new Event("input",{bubbles:true}));',
        );
        assert(
            await run(
                '[...document.querySelectorAll(".rc-dialog .rc-range")].find(l=>!l.hidden).querySelector("input").value==="35"',
            ),
            "Wipe slider did not update",
        );
        await shot(dashboard, "compare-wipe");
        const compareBName = await run(
            'document.querySelectorAll(".rc-dialog .compare-pair-select")[1].options[2].textContent.slice(4)',
        );
        await run(
            'const second=document.querySelectorAll(".rc-dialog .compare-pair-select")[1];second.selectedIndex=2;second.dispatchEvent(new Event("change",{bubbles:true}));',
        );
        await until(
            () =>
                run(
                    `document.querySelector(".rc-dialog .rc-status").textContent.includes(${JSON.stringify(compareBName)})`,
                ),
            "Pair selection did not update",
        );
        report.checks.push({
            comparison: {
                modes: ["side", "opacity", "wipe"],
                selectableReferences: 3,
                wipe: 35,
            },
        });
        await run(
            'document.querySelector(".rc-dialog .rc-header .rc-icon-button").click();[...document.querySelectorAll(".selection-actions button")].find(b=>b.textContent.trim()==="묶음 복사").click();',
        );
        await until(
            () => run('document.querySelector("dialog.bundle-dialog[open]")'),
            "Bundle preview did not open",
        );
        await until(
            () =>
                run(
                    'document.querySelectorAll(".bundle-dialog .bundle-order-chip").length===3',
                ),
            "Bundle preview items missing",
        );
        await run(
            'document.querySelector(".bundle-dialog [data-role=copy]").click();',
        );
        await until(
            () =>
                run(
                    'document.querySelector(".toast").textContent.includes("묶음을 복사")',
                ),
            "Multi-image copy failed",
        );
        const items = await clipboard.read();
        const pngItem = items.find((item) => item.types.includes("image/png"));
        assert(pngItem, "No clipboard image");
        const blob = await pngItem.getType("image/png");
        const image = nativeImage.createFromBuffer(
            Buffer.from(await blob.arrayBuffer()),
        );
        const copiedSize = image.getSize();
        assert(
            copiedSize.width > 1500 && copiedSize.height > 1000,
            "Multi-image bundle dimensions incorrect",
        );
        fs.writeFileSync(
            path.join(evidence, "copied-bundle.png"),
            image.toPNG(),
        );
        report.checks.push({
            multipleCopy: {
                count: 3,
                size: copiedSize,
                format: "single PNG grid",
            },
        });
        assert(
            !errors.length,
            `Renderer errors occurred: ${errors.join("; ")}`,
        );
        report.ok = true;
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.log("CAPTURE_CONTROLS_QA", JSON.stringify(report));
        clearTimeout(timer);
        app.exit(0);
    } catch (error) {
        report.ok = false;
        report.failure = String(error.stack || error);
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.error("CAPTURE_CONTROLS_QA_FAILED", report.failure);
        clearTimeout(timer);
        app.exit(1);
    }
});
