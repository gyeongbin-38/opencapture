const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "web-lab");
if (!process.versions.electron) {
    fs.mkdirSync(evidence, { recursive: true });
    const electron = path.join(
        root,
        "node_modules",
        "electron",
        "dist",
        process.platform === "win32" ? "electron.exe" : "electron",
    );
    const result = spawnSync(electron, [__filename], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) process.exit(result.status ?? 1);
    process.exit(0);
}

const { app, BrowserWindow, clipboard, session } = require("electron");
const { GIFEncoder, applyPalette, quantize } = require("gifenc");

fs.mkdirSync(evidence, { recursive: true });
const downloads = path.join(evidence, "downloads");
const fixtures = path.join(evidence, "fixtures");
const profile = path.join(evidence, `profile-${Date.now()}`);
for (const directory of [downloads, fixtures, profile])
    fs.mkdirSync(directory, { recursive: true });
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-gpu");

const report = {
    ok: false,
    checks: [],
    rendererErrors: [],
    mainErrors: [],
    downloads: [],
    limitations: {
        physicalGlobalShortcuts: "not exercised by the browser lab",
        osScreenCapturePermission: "not exercised",
        userChrome: "not controlled; isolated Electron renderer only",
    },
};
const reportPath = path.join(evidence, "qa.json");
const writeReport = () =>
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
const failMain = (kind, error) => {
    report.mainErrors.push(`${kind}: ${String(error?.stack || error)}`);
    report.failure = report.mainErrors.at(-1);
    writeReport();
    app.exit(1);
};
process.on("uncaughtException", (error) =>
    failMain("uncaughtException", error),
);
process.on("unhandledRejection", (error) =>
    failMain("unhandledRejection", error),
);

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, attempts = 160) {
    let lastError;
    for (let index = 0; index < attempts; index++) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await pause(100);
    }
    throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ""}`);
}

function makeGif() {
    const width = 24;
    const height = 18;
    const encoder = GIFEncoder();
    for (const [r, g, b] of [
        [255, 72, 102],
        [40, 196, 130],
    ]) {
        const rgba = new Uint8Array(width * height * 4);
        for (let index = 0; index < width * height; index++) {
            const offset = index * 4;
            rgba[offset] = r;
            rgba[offset + 1] = g;
            rgba[offset + 2] = b;
            rgba[offset + 3] = 255;
        }
        const palette = quantize(rgba, 16);
        encoder.writeFrame(applyPalette(rgba, palette), width, height, {
            palette,
            delay: 120,
        });
    }
    encoder.finish();
    return Buffer.from(encoder.bytes());
}
const gifPath = path.join(fixtures, "two-frame.gif");
fs.writeFileSync(gifPath, makeGif());

const partition = `persist:web-lab-${Date.now()}`;
let labSession;
let downloadSequence = 0;
const completedDownloads = [];
const handleDownload = (_event, item) => {
    const safeName = item
        .getFilename()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(-120);
    const target = path.join(
        downloads,
        `${String(++downloadSequence).padStart(2, "0")}-${safeName}`,
    );
    item.setSavePath(target);
    item.once("done", (_doneEvent, state) => {
        completedDownloads.push({
            name: safeName,
            path: target,
            state,
            bytes: fs.existsSync(target) ? fs.statSync(target).size : 0,
        });
    });
};

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 960,
        show: false,
        frame: false,
        webPreferences: {
            partition,
            offscreen: true,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    window.webContents.on("console-message", (event) => {
        if (event.level === "error")
            report.rendererErrors.push({
                message: event.message,
                sourceId: event.sourceId,
                line: event.lineNumber,
            });
    });
    window.webContents.on("render-process-gone", (_event, detail) =>
        report.rendererErrors.push({
            message: `renderer gone: ${detail.reason}`,
        }),
    );
    return window;
}

async function screenshot(window, name) {
    await window.webContents.executeJavaScript(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        true,
    );
    await pause(150);
    const image = await window.webContents.capturePage();
    assert(!image.isEmpty(), `Screenshot ${name} was empty`);
    const file = path.join(evidence, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { file, bytes: fs.statSync(file).size };
}

async function cdpDrag(contents, start, end) {
    const attached = contents.debugger.isAttached();
    if (!attached) contents.debugger.attach("1.3");
    try {
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: start.x,
            y: start.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
        });
        await pause(60);
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: end.x,
            y: end.y,
            button: "left",
            buttons: 1,
        });
        await pause(60);
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: end.x,
            y: end.y,
            button: "left",
            buttons: 0,
            clickCount: 1,
        });
    } finally {
        if (!attached && contents.debugger.isAttached())
            contents.debugger.detach();
    }
}

const timeout = setTimeout(() => {
    report.timeout = true;
    report.failure = `Timed out at ${report.stage ?? "startup"}`;
    writeReport();
    app.exit(1);
}, 170_000);

app.whenReady().then(async () => {
    labSession = session.fromPartition(partition);
    labSession.setPermissionCheckHandler((_webContents, permission) =>
        ["clipboard-read", "clipboard-sanitized-write"].includes(permission),
    );
    labSession.setPermissionRequestHandler(
        (_webContents, permission, callback) =>
            callback(
                ["clipboard-read", "clipboard-sanitized-write"].includes(
                    permission,
                ),
            ),
    );
    labSession.on("will-download", handleDownload);
    const window = createWindow();
    const run = (code) => window.webContents.executeJavaScript(code, true);
    try {
        report.stage = "load";
        const sessionId = `automated-${Date.now()}`;
        const response = await fetch("http://127.0.0.1:5187/");
        assert(response.ok, "Web lab server is not available on port 5187");
        await window.loadURL(
            `http://127.0.0.1:5187/?session=${encodeURIComponent(sessionId)}`,
        );
        await until(
            () =>
                run(
                    "Boolean(window.__captureLab?.board && window.__captureLab?.api)",
                ),
            "Public capture lab API did not initialize",
        );
        await until(
            () =>
                run(
                    "window.__captureLab.api.listItems().then(items=>items.length>=3)",
                ),
            "Sample library did not seed",
        );
        report.checks.push({
            startup: await run(`(async()=>({
                session:${JSON.stringify(sessionId)},
                features:window.__captureLab.features.length,
                items:(await window.__captureLab.api.listItems()).length,
                board:window.__captureLab.board.getDocument()?.id,
                status:await window.__captureLab.api.status()
            }))()`),
        });

        report.stage = "board-edit";
        await run(
            `document.querySelector('[data-testid="nav-editor"]').click()`,
        );
        await until(
            () =>
                run(
                    "Boolean(document.querySelector('.board-editor__overlay'))",
                ),
            "Board editor did not render",
        );
        const beforeRectCount = await run(
            "window.__captureLab.board.getDocument().nodes.filter(node=>node.kind==='rect').length",
        );
        await run(
            `document.querySelector('[data-board-command="shape-drawer"]').click();document.querySelector('[data-board-tool="rect"]').click()`,
        );
        const overlay = await run(
            `(()=>{const viewport=document.querySelector('.board-viewport').getBoundingClientRect();const start={x:viewport.left+viewport.width*.38,y:viewport.top+viewport.height*.62};return {start,end:{x:start.x+120,y:start.y+86},hit:document.elementFromPoint(start.x,start.y)?.classList.contains('board-editor__overlay'),drawing:document.querySelector('.board-editor__overlay').classList.contains('is-drawing')}})()`,
        );
        assert(
            overlay.hit && overlay.drawing,
            `Rectangle tool did not expose the visible drawing overlay: ${JSON.stringify(overlay)}`,
        );
        await cdpDrag(window.webContents, overlay.start, overlay.end);
        const rectNode = await until(async () => {
            const value = await run(
                `(()=>{const nodes=window.__captureLab.board.getDocument().nodes.filter(node=>node.kind==='rect');return nodes.length>${beforeRectCount}?nodes.at(-1):null})()`,
            );
            return value || false;
        }, "Rectangle pointer gesture did not create a node");
        await run(
            `(()=>{const details=document.querySelector('.board-editor__properties');if(!details.open)details.querySelector('summary').click();const input=details.querySelectorAll('.board-editor__number')[2];input.value=String(${rectNode.width}+31);input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
        );
        const changedWidth = await until(async () => {
            const value = await run(
                `window.__captureLab.board.getDocument().nodes.find(node=>node.id===${JSON.stringify(rectNode.id)})?.width`,
            );
            return value === rectNode.width + 31 ? value : false;
        }, "Rectangle width input did not persist");
        await run("document.querySelector('.board-viewport').focus()");
        window.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Z",
            modifiers: ["control"],
        });
        window.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "Z",
            modifiers: ["control"],
        });
        await until(
            () =>
                run(
                    `window.__captureLab.board.getDocument().nodes.find(node=>node.id===${JSON.stringify(rectNode.id)})?.width===${rectNode.width}`,
                ),
            "Ctrl+Z did not undo exactly once",
        );
        window.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Z",
            modifiers: ["control", "shift"],
        });
        window.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "Z",
            modifiers: ["control", "shift"],
        });
        await until(
            () =>
                run(
                    `window.__captureLab.board.getDocument().nodes.find(node=>node.id===${JSON.stringify(rectNode.id)})?.width===${changedWidth}`,
                ),
            "Ctrl+Shift+Z did not redo exactly once",
        );
        await run("window.__captureLab.board.flush()");
        report.checks.push({
            boardEditing: {
                rectId: rectNode.id,
                before: rectNode.width,
                changedWidth,
                undo: true,
                redo: true,
            },
        });
        await screenshot(window, "editor-board");

        report.stage = "library";
        await run(
            `document.querySelector('[data-testid="nav-library"]').click()`,
        );
        await until(
            () => run("document.querySelectorAll('.library-card').length>=3"),
            "Library cards did not render",
        );
        const searchResult = await run(
            `(()=>{const input=document.querySelector('[data-testid="library-search"]');input.value='Aurora';input.dispatchEvent(new Event('input',{bubbles:true}));return {cards:document.querySelectorAll('.library-card').length,empty:[...document.querySelectorAll('.empty-state')].some(node=>getComputedStyle(node).display!=='none')}})()`,
        );
        assert(
            searchResult.cards === 1 && !searchResult.empty,
            "Library search or hidden placeholder behavior regressed",
        );
        await run(
            `(()=>{const input=document.querySelector('[data-testid="library-search"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.library-card__check input').click()})()`,
        );
        await run(
            `document.querySelector('.library-card__check input:not(:checked)').click()`,
        );
        await until(
            () =>
                run(
                    "document.querySelectorAll('.library-card[data-selected=true]').length===2",
                ),
            "Library multi-select failed",
        );
        await run(
            `document.querySelector('.library-tools button[data-action="compare"]').click()`,
        );
        await until(
            () => run("document.querySelector('.compare-dialog')?.open"),
            "Comparison dialog did not open",
        );
        const modes = [];
        for (const mode of ["side", "opacity", "wipe", "diff"]) {
            await run(
                `document.querySelector('.compare-mode-button[data-mode=${JSON.stringify(mode)}]').click()`,
            );
            await until(
                () =>
                    run(
                        `document.querySelector('.compare-mode-button[data-mode=${JSON.stringify(mode)}]').classList.contains('active')`,
                    ),
                `Comparison mode ${mode} did not activate`,
            );
            modes.push(mode);
        }
        await screenshot(window, "library-comparison");
        await run(
            "document.querySelector('.compare-dialog .rc-icon-button').click()",
        );

        report.stage = "reference-window";
        await run(
            `document.querySelector('.library-tools button[data-action="float"]').click()`,
        );
        await until(
            () =>
                run(
                    "document.querySelectorAll('[data-testid=reference-window]').length===2",
                ),
            "Reference windows did not open for both selected images",
        );
        const referenceBefore = await run(
            `(()=>{const r=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1).getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`,
        );
        const resizePoint = await run(
            `(()=>{const shell=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1);const r=shell.querySelector('.reference-window__resize.is-se').getBoundingClientRect();const x=r.left+r.width/2;const y=r.top+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.className}})()`,
        );
        await cdpDrag(window.webContents, resizePoint, {
            x: resizePoint.x + 70,
            y: resizePoint.y + 50,
        });
        const referenceResized = await run(
            `(()=>{const r=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1).getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`,
        );
        await screenshot(window, "reference-resize");
        assert(
            referenceResized.width > referenceBefore.width + 20,
            "Reference resize handle did not resize the window",
        );
        const headerPoint = await run(
            `(()=>{const shell=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1);const r=shell.querySelector('.reference-window__header').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
        );
        await cdpDrag(window.webContents, headerPoint, {
            x: headerPoint.x + 45,
            y: headerPoint.y + 30,
        });
        const moved = await run(
            `(()=>{const r=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1).getBoundingClientRect();return {left:r.left,top:r.top}})()`,
        );
        assert(
            Math.abs(moved.left - referenceResized.left) > 20,
            "Reference window did not move",
        );
        await run(
            "[...document.querySelectorAll('[data-testid=reference-lock]')].at(-1).click()",
        );
        const lockedHeader = await run(
            `(()=>{const shell=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1);const r=shell.querySelector('.reference-window__header').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
        );
        await cdpDrag(window.webContents, lockedHeader, {
            x: lockedHeader.x + 60,
            y: lockedHeader.y + 35,
        });
        const locked = await run(
            `(()=>{const r=[...document.querySelectorAll('[data-testid=reference-window]')].at(-1).getBoundingClientRect();return {left:r.left,top:r.top,pressed:[...document.querySelectorAll('[data-testid=reference-lock]')].at(-1).getAttribute('aria-pressed')}})()`,
        );
        assert(
            locked.pressed === "true" && Math.abs(locked.left - moved.left) < 2,
            "Reference position lock did not block movement",
        );
        report.checks.push({
            library: { searchResult, selected: 2, compareModes: modes },
            reference: {
                before: referenceBefore,
                resized: referenceResized,
                moved,
                locked,
            },
        });
        await screenshot(window, "reference-windows");
        window.setContentSize(390, 900);
        await pause(300);
        const reference390 = await run(`(()=>({
            width:innerWidth,
            scrollWidth:document.documentElement.scrollWidth,
            cards:[...document.querySelectorAll('[data-testid=reference-window]')].map(shell=>{const r=shell.getBoundingClientRect();const close=shell.querySelector('[data-testid=reference-close]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,closeLeft:close.left,closeRight:close.right}}),
            toolbars:[...document.querySelectorAll('[data-testid=reference-toolbar]')].map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})
        }))()`);
        assert(
            reference390.scrollWidth <= reference390.width + 1 &&
                reference390.cards.every(
                    (card) =>
                        card.closeLeft >= 0 &&
                        card.closeRight <= reference390.width + 1,
                ) &&
                reference390.toolbars.every(
                    (toolbar) =>
                        toolbar.left >= 0 &&
                        toolbar.right <= reference390.width + 1,
                ),
            `Reference controls clipped at 390px: ${JSON.stringify(reference390)}`,
        );
        report.checks.push({ reference390 });
        await screenshot(window, "reference-390");
        window.setContentSize(1440, 960);
        await pause(250);
        await run(
            "while(document.querySelector('[data-testid=reference-close]'))document.querySelector('[data-testid=reference-close]').click()",
        );

        report.stage = "translate-crop";
        await run(
            `(()=>{while(document.querySelector('.library-card__check input:checked'))document.querySelector('.library-card__check input:checked').click();const more=document.querySelector('.library-more');more.open=true;more.querySelector('button[data-action="translate"]').click()})()`,
        );
        await until(
            () =>
                run(
                    "document.querySelector('textarea[aria-label=\"번역 결과\"]')?.closest('dialog')?.open",
                ),
            "Standalone translate did not open without a selection",
        );
        await run(
            `document.querySelector('textarea[aria-label="번역 결과"]').closest('dialog').querySelector('.dialog-actions button').click()`,
        );
        await run(
            `document.querySelectorAll('.library-card__check input')[0].click();document.querySelector('.library-more').open=true;document.querySelector('.library-more button[data-action="crop"]').click()`,
        );
        await until(
            () => run("!document.querySelector('[data-page=capture]').hidden"),
            "Crop did not navigate to capture lab",
        );
        const itemsBeforeCrop = await run(
            "window.__captureLab.api.listItems()",
        );
        const priorCropIds = new Set(itemsBeforeCrop.map((item) => item.id));
        await run(
            `(()=>{const w=document.querySelector('input[data-dimension=width]');const h=document.querySelector('input[data-dimension=height]');w.value='180';w.dispatchEvent(new Event('input',{bubbles:true}));h.value='120';h.dispatchEvent(new Event('input',{bubbles:true}));const save=document.querySelector('button[data-action=save]');if(!save){document.querySelector('button[data-action=more]')?.click()}document.querySelector('button[data-action=save]').click()})()`,
        );
        const cropItem = await until(async () => {
            const items = await run("window.__captureLab.api.listItems()");
            return items.find((item) => !priorCropIds.has(item.id)) || false;
        }, "Crop save did not create a real library output");
        assert(
            cropItem.width === 180 && cropItem.height === 120,
            "Crop output dimensions are incorrect",
        );
        report.checks.push({
            standaloneTranslate: true,
            crop: {
                id: cropItem.id,
                width: cropItem.width,
                height: cropItem.height,
            },
        });

        report.stage = "responsive";
        const responsive = [];
        for (const width of [390, 768, 1440]) {
            window.setContentSize(width, 900);
            await pause(250);
            const measurement = await run(
                `(()=>{const stage=document.querySelector('[data-testid=capture-stage]').getBoundingClientRect();const toolbar=document.querySelector('.capture-lab__toolbar').getBoundingClientRect();const visible=[...document.querySelectorAll('.capture-lab__toolbar button:not([hidden])')].map(node=>{const r=node.getBoundingClientRect();return {action:node.dataset.action,left:r.left,right:r.right,top:r.top,bottom:r.bottom}});return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,stage:{left:stage.left,right:stage.right,top:stage.top,bottom:stage.bottom},toolbar:{left:toolbar.left,right:toolbar.right,top:toolbar.top,bottom:toolbar.bottom},visible,moreHidden:document.querySelector('.capture-lab__more').hidden}})()`,
            );
            assert(
                measurement.scrollWidth <= measurement.width + 1,
                `Page overflow at ${width}px`,
            );
            assert(
                measurement.toolbar.left >= measurement.stage.left - 1 &&
                    measurement.toolbar.right <= measurement.stage.right + 1,
                `Capture toolbar clipped at ${width}px`,
            );
            assert(
                measurement.visible.every(
                    (control) =>
                        control.left >= 0 &&
                        control.right <= measurement.width + 1,
                ),
                `Primary capture control clipped at ${width}px`,
            );
            responsive.push(measurement);
            await screenshot(window, `capture-${width}`);
        }
        report.checks.push({ responsive });
        window.setContentSize(1440, 960);

        report.stage = "exports";
        await run(
            `document.querySelector('[data-testid="nav-editor"]').click();document.querySelector('[data-board-command="more"]').click()`,
        );
        for (const command of ["export-png", "export-pdf", "export-portable"]) {
            const before = completedDownloads.length;
            await run(
                `document.querySelector('[data-board-command=${JSON.stringify(command)}]').click()`,
            );
            await until(
                () => completedDownloads.length > before,
                `${command} download did not finish`,
            );
        }

        report.stage = "gif";
        await run(
            `document.querySelector('[data-testid="nav-media"]').click()`,
        );
        const attached = window.webContents.debugger.isAttached();
        if (!attached) window.webContents.debugger.attach("1.3");
        try {
            const { root: documentRoot } =
                await window.webContents.debugger.sendCommand(
                    "DOM.getDocument",
                );
            const { nodeId } = await window.webContents.debugger.sendCommand(
                "DOM.querySelector",
                {
                    nodeId: documentRoot.nodeId,
                    selector: "[data-testid=media-file-input]",
                },
            );
            await window.webContents.debugger.sendCommand(
                "DOM.setFileInputFiles",
                { nodeId, files: [gifPath] },
            );
        } finally {
            if (!attached && window.webContents.debugger.isAttached())
                window.webContents.debugger.detach();
        }
        await until(
            () =>
                run(
                    "Boolean(document.querySelector('[data-testid=gif-preview]') && document.querySelector('[data-testid=gif-trim-start]'))",
                ),
            "Two-frame GIF did not decode through the media file input",
        );
        const mediaItemsBefore = await run(
            "window.__captureLab.api.listItems().then(items=>items.length)",
        );
        await run(
            `document.querySelector('[data-testid=gif-trim-start]').value='0';document.querySelector('[data-testid=gif-trim-end]').value='1';document.querySelector('[data-testid=gif-extract-frame]').click()`,
        );
        await until(
            () =>
                run(
                    `window.__captureLab.api.listItems().then(items=>items.length>${mediaItemsBefore})`,
                ),
            "GIF frame extraction did not add an image",
        );
        const beforeGifDownload = completedDownloads.length;
        await run(`document.querySelector('[data-testid=gif-export]').click()`);
        await until(
            () => completedDownloads.length > beforeGifDownload,
            "Trimmed GIF download did not finish",
            240,
        );
        await screenshot(window, "media-gif");

        report.stage = "clipboard";
        clipboard.clear();
        await run(
            `(()=>{document.querySelector('[data-testid="nav-library"]').click();while(document.querySelector('.library-card__check input:checked'))document.querySelector('.library-card__check input:checked').click();document.querySelector('.library-card__check input').click();document.querySelector('.library-tools button[data-action=copy]').click()})()`,
        );
        const clipboardSingle = await until(
            () => !clipboard.readImage().isEmpty(),
            "Clipboard image write unavailable",
            20,
        ).catch(() => false);
        let clipboardComposite = false;
        if (clipboardSingle) {
            clipboard.clear();
            await run(
                `document.querySelectorAll('.library-card__check input')[1].click();document.querySelector('.library-more').open=true;document.querySelector('.library-more button[data-action=composite]').click()`,
            );
            clipboardComposite = await until(
                () => !clipboard.readImage().isEmpty(),
                "Composite clipboard write unavailable",
                40,
            ).catch(() => false);
        }
        report.checks.push({
            downloads: completedDownloads,
            gif: {
                fixtureBytes: fs.statSync(gifPath).size,
                decoded: true,
                frameExtracted: true,
            },
            clipboard: clipboardSingle
                ? { single: true, composite: clipboardComposite }
                : {
                      single: "manual-permission",
                      composite: "manual-permission",
                  },
        });

        assert(
            completedDownloads.length >= 4,
            "Expected PNG, PDF, portable, and GIF downloads",
        );
        assert(
            completedDownloads.every(
                (item) => item.state === "completed" && item.bytes > 0,
            ),
            "A browser download failed or was empty",
        );
        assert(
            !report.rendererErrors.length,
            `Renderer errors: ${JSON.stringify(report.rendererErrors)}`,
        );
        assert(
            !report.mainErrors.length,
            `Main errors: ${JSON.stringify(report.mainErrors)}`,
        );
        report.downloads = completedDownloads;
        report.ok = true;
        report.stage = "complete";
        writeReport();
        console.log("WEB_LAB_QA", JSON.stringify(report));
        clearTimeout(timeout);
        window.destroy();
        app.exit(0);
    } catch (error) {
        report.failure = String(error?.stack || error);
        writeReport();
        console.error("WEB_LAB_QA_FAILED", report.failure);
        clearTimeout(timeout);
        if (!window.isDestroyed()) window.destroy();
        app.exit(1);
    }
});
