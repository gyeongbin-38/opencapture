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
            `(() => { const selection=document.querySelector('#selection_handles'); const toolbar=document.querySelector('#quick_toolbar'); return { handles:selection.querySelectorAll('button').length, hidden:selection.hidden, selection:JSON.parse(JSON.stringify(selection.getBoundingClientRect())), toolbar:JSON.parse(JSON.stringify(toolbar.getBoundingClientRect())), size:[...document.querySelectorAll('.capture-dimensions input')].map(i=>i.value), background:getComputedStyle(toolbar).backgroundColor, colorPanelHidden:document.querySelector('#mouse_bar').classList.contains('mouse_bar_hide') } })()`,
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
            await clip(
                'document.querySelector(".capture-start-hint").classList.contains("hint-hidden")',
            ),
            "Start hint did not dismiss after drag",
        );
        report.checks.push({ captureLayout: ui, startHint: hintInitial });
        await shot(capture, "capture-toolbar");
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
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));',
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
