const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "capture-import");

if (!process.versions.electron) {
    fs.mkdirSync(evidence, { recursive: true });
    const profile = path.join(evidence, `profile-${Date.now()}`);
    fs.mkdirSync(profile, { recursive: true });
    const electron = path.join(
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
        [__filename, `--capture-import-profile=${profile}`],
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

const { app, BrowserWindow, dialog } = require("electron");
const profile = path.resolve(
    process.argv
        .find((value) => value.startsWith("--capture-import-profile="))
        ?.slice("--capture-import-profile=".length) ??
        path.join(evidence, `profile-${Date.now()}`),
);
const hash = (file) =>
    file && fs.existsSync(file)
        ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
        : null;
const realConfig = process.env.APPDATA
    ? path.join(process.env.APPDATA, "OpenCapture", "config.json")
    : "";
const configHashBefore = hash(realConfig);
const report = {
    ok: false,
    isolatedProfile: profile,
    fixture: null,
    checks: [],
    rendererErrors: [],
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
    report.rendererErrors.push({ title, message, source: "dialog" });
app.on("browser-window-created", (_event, window) => {
    window.setSkipTaskbar(true);
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on("console-message", (event) => {
        if (event.level === "error")
            report.rendererErrors.push({
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
async function until(check, message, attempts = 300) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await check();
        if (value) return value;
        await pause(50);
    }
    throw new Error(message);
}
async function shot(window, name) {
    await pause(180);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(evidence, `${name}.png`), image.toPNG());
}
const objects = (draft) =>
    Array.isArray(draft?.canvas?.objects) ? draft.canvas.objects : [];
const objectGeometry = (draft) =>
    objects(draft).map(
        ({ type, left, top, width, height, scaleX, scaleY }) => ({
            type,
            left,
            top,
            width,
            height,
            scaleX,
            scaleY,
        }),
    );
function assertFabricCanvasAligned(state) {
    const [main, draw, lower, upper] = state.canvases;
    for (const canvas of [draw, lower, upper]) {
        assert.ok(canvas, "Fabric canvas layer is missing.");
        assert.equal(canvas.clientWidth, main.clientWidth);
        assert.equal(canvas.clientHeight, main.clientHeight);
        assert.ok(Math.abs(canvas.rect.width - main.rect.width) <= 1);
        assert.ok(Math.abs(canvas.rect.height - main.rect.height) <= 1);
    }
    for (const canvas of [draw, lower, upper])
        assert.ok(Math.abs(canvas.width / canvas.height - 720 / 420) < 0.001);
    return true;
}
const toolbarStateScript = `(() => {
    const toolbar=document.querySelector("#quick_toolbar");
    const photo=document.querySelector("#main_photo");
    const handles=document.querySelector("#selection_handles");
    const centerBar=document.querySelector("#center_bar");
    const captureHelp=document.querySelector(".capture-help");
    const dimensions=[...document.querySelectorAll(".capture-dimensions input")].map(input=>Number(input.value));
    const toolbarRect=toolbar?.getBoundingClientRect();
    const photoRect=photo?.getBoundingClientRect();
    const selectionRect=handles?.getBoundingClientRect();
    const style=toolbar ? getComputedStyle(toolbar) : null;
    const centerStyle=centerBar ? getComputedStyle(centerBar) : null;
    const canvas=(selector)=>{const node=document.querySelector(selector);if(!node)return null;const rect=node.getBoundingClientRect();const computed=getComputedStyle(node);return {selector,width:node.width,height:node.height,clientWidth:node.clientWidth,clientHeight:node.clientHeight,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},style:{width:node.style.width,height:node.style.height},computed:{width:computed.width,height:computed.height}}};
    return {
        bodyVisible:document.body.style.opacity !== "0",
        toolbarVisible:Boolean(toolbar && toolbarRect.width > 0 && toolbarRect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0),
        toolbarPointer:style?.pointerEvents ?? null,
        toolbarActions:toolbar ? [...toolbar.querySelectorAll("[data-capture-action]")].map(node=>node.dataset.captureAction) : [],
        selectionVisible:Boolean(handles && !handles.hidden),
        selection:selectionRect ? {x:selectionRect.x,y:selectionRect.y,width:selectionRect.width,height:selectionRect.height} : null,
        dimensions,
        centerBarVisible:Boolean(centerBar && centerStyle?.display !== "none" && Number(centerStyle?.opacity) > 0 && centerStyle?.pointerEvents !== "none"),
        captureHelpHidden:captureHelp?.hidden ?? null,
        photo:photoRect ? {x:photoRect.x,y:photoRect.y,width:photoRect.width,height:photoRect.height} : null,
        canvases:[canvas("#main_photo"),canvas("#draw_photo"),canvas(".lower-canvas"),canvas(".upper-canvas")],
        draft:window.captureDraftBridge?.info()
    };
})()`;

const timeout = setTimeout(() => {
    report.timeout = true;
    report.realConfig.after = hash(realConfig);
    report.realConfig.preserved =
        report.realConfig.before === report.realConfig.after;
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    app.exit(1);
}, 100_000);

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
            for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();`);

        const fixtureData = await dashboardRun(`(() => {
            const canvas=document.createElement("canvas");
            canvas.width=720; canvas.height=420;
            const context=canvas.getContext("2d");
            context.fillStyle="#f5f5f4"; context.fillRect(0,0,720,420);
            context.fillStyle="#18181b"; context.fillRect(0,0,720,56);
            context.fillStyle="#ffffff"; context.font="600 18px Segoe UI";
            context.fillText("CAPTURE IMPORT BUFFER QA",24,35);
            context.fillStyle="#dbeafe"; context.fillRect(48,96,250,260);
            context.fillStyle="#2563eb"; context.fillRect(350,118,310,82);
            context.fillStyle="#111827"; context.font="700 28px Segoe UI";
            context.fillText("720 × 420",382,172);
            return canvas.toDataURL("image/png");
        })()`);
        const fixture = path.join(profile, "capture-import-buffer.png");
        fs.writeFileSync(
            fixture,
            Buffer.from(fixtureData.split(",")[1], "base64"),
        );
        report.fixture = {
            path: fixture,
            sha256: hash(fixture),
            width: 720,
            height: 420,
        };

        const imported = await dashboardRun(
            `window.openCapture.importPaths([${JSON.stringify(fixture)}])`,
        );
        const item = imported.items.find((candidate) =>
            candidate.name.includes("capture-import-buffer"),
        );
        assert.ok(item?.id, "Imported fixture was not added to the library.");
        await dashboardRun(
            `window.openCapture.action("open-item", ${JSON.stringify(item.id)})`,
        );
        let capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Imported image did not open in the capture editor.",
        );
        let clip = (code) => capture.webContents.executeJavaScript(code, true);
        const initial = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.bodyVisible && value.toolbarVisible
                ? value
                : undefined;
        }, "Imported image editor did not become visible.");
        assert.equal(initial.selectionVisible, true);
        assert.deepEqual(initial.dimensions, [720, 420]);
        assert.ok(initial.toolbarActions.includes("stage"));
        assert.ok(
            initial.photo,
            "Imported image canvas has no visible bounds.",
        );
        assert.ok(
            initial.selection,
            "Imported image selection has no visible bounds.",
        );
        const initialCanvasAligned = assertFabricCanvasAligned(initial);
        const diagnostics = await until(async () => {
            const records = await dashboardRun(
                "window.openCapture.getState().then(state => state.runtime.captureDiagnostics)",
            );
            const input = [...records]
                .reverse()
                .find(
                    (trace) =>
                        trace.phase === "input" && trace.input === "import",
                );
            return input?.requestId &&
                records.some(
                    (trace) =>
                        trace.requestId === input.requestId &&
                        trace.phase === "shown",
                )
                ? records
                : undefined;
        }, "Imported capture never reached the shown phase.");
        const importInput = [...diagnostics]
            .reverse()
            .find(
                (trace) => trace.phase === "input" && trace.input === "import",
            );
        assert.ok(
            importInput?.requestId,
            "Import capture request was not diagnosed.",
        );
        assert.ok(
            diagnostics.some(
                (trace) =>
                    trace.requestId === importInput.requestId &&
                    trace.phase === "shown",
            ),
            "Imported capture never reached the shown phase.",
        );
        report.checks.push({
            importEditor: {
                itemId: item.id,
                requestId: importInput.requestId,
                selection: initial.dimensions,
                toolbarActions: initial.toolbarActions,
                canvases: initial.canvases,
                canvasAligned: initialCanvasAligned,
                shown: true,
            },
        });
        await shot(capture, "import-full-selection");

        const interactionProbe = await clip(`(() => {
            window.__qaImportBlur=0;
            window.__qaImportClipboardWrites=0;
            addEventListener("blur",()=>window.__qaImportBlur++);
            const clipboard=navigator.clipboard;
            if(clipboard?.write) clipboard.write=async()=>{window.__qaImportClipboardWrites++;};
            return {draft:window.captureDraftBridge?.info()};
        })()`);
        const cancelledStart = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.16),
            y: Math.round(initial.selection.y + initial.selection.height * 0.2),
        };
        const cancelledEnd = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.54),
            y: Math.round(
                initial.selection.y + initial.selection.height * 0.58,
            ),
        };
        for (const event of [
            { type: "mouseMove", ...cancelledStart },
            {
                type: "mouseDown",
                button: "left",
                clickCount: 1,
                ...cancelledStart,
            },
            { type: "mouseMove", ...cancelledEnd },
        ])
            capture.webContents.sendInputEvent(event);
        const interrupted = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] > 1 &&
                value.dimensions[1] > 1 &&
                (value.dimensions[0] !== 720 || value.dimensions[1] !== 420)
                ? value
                : undefined;
        }, "Native import selection drag did not begin.");
        capture.hide();
        await until(
            () => clip("window.__qaImportBlur > 0"),
            "Capture renderer did not receive window blur.",
        );
        capture.show();
        capture.focus();
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...cancelledEnd,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: cancelledEnd.x + 12,
            y: cancelledEnd.y + 12,
        });
        const cancelled = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] === 720 &&
                value.dimensions[1] === 420 &&
                value.toolbarPointer === "auto"
                ? value
                : undefined;
        }, "Interrupted selection did not restore the imported full image.");
        const cancelledEffects = await clip(`({
            blur:window.__qaImportBlur,
            clipboardWrites:window.__qaImportClipboardWrites,
            draft:window.captureDraftBridge?.info()
        })`);
        assert.equal(cancelledEffects.clipboardWrites, 0);
        assert.deepEqual(cancelledEffects.draft, interactionProbe.draft);

        capture.focus();
        const freshStart = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.1),
            y: Math.round(
                initial.selection.y + initial.selection.height * 0.12,
            ),
        };
        const freshEnd = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.65),
            y: Math.round(initial.selection.y + initial.selection.height * 0.7),
        };
        for (const event of [
            { type: "mouseMove", ...freshStart },
            {
                type: "mouseDown",
                button: "left",
                clickCount: 1,
                ...freshStart,
            },
            { type: "mouseMove", ...freshEnd },
            {
                type: "mouseUp",
                button: "left",
                clickCount: 1,
                ...freshEnd,
            },
        ])
            capture.webContents.sendInputEvent(event);
        const freshDrag = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] > 1 &&
                value.dimensions[1] > 1 &&
                value.dimensions[0] < 720 &&
                value.dimensions[1] < 420
                ? value
                : undefined;
        }, "A fresh selection drag did not work after cancellation.");
        capture.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "A",
            modifiers: ["control"],
        });
        capture.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "A",
            modifiers: ["control"],
        });
        const fullSelectionRestored = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] === 720 && value.dimensions[1] === 420
                ? value
                : undefined;
        }, "Ctrl+A did not restore the full imported selection.");
        const resizeHandle = await clip(`(() => {
            const handle=document.querySelector("#selection_handles .handle-se");
            const rect=handle?.getBoundingClientRect();
            return rect ? {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)} : null;
        })()`);
        assert.ok(resizeHandle, "Imported selection resize handle is missing.");
        capture.webContents.debugger.attach("1.3");
        await capture.webContents.debugger.sendCommand(
            "Emulation.setTouchEmulationEnabled",
            { enabled: true, maxTouchPoints: 1 },
        );
        const touchPoint = (x, y) => ({
            x,
            y,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
        });
        await capture.webContents.debugger.sendCommand(
            "Input.dispatchTouchEvent",
            {
                type: "touchStart",
                touchPoints: [touchPoint(resizeHandle.x, resizeHandle.y)],
            },
        );
        await capture.webContents.debugger.sendCommand(
            "Input.dispatchTouchEvent",
            {
                type: "touchMove",
                touchPoints: [
                    touchPoint(resizeHandle.x - 110, resizeHandle.y - 70),
                ],
            },
        );
        const resizeDuring = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] < 720 && value.dimensions[1] < 420
                ? value
                : undefined;
        }, "Native resize handle drag did not begin.");
        await capture.webContents.debugger.sendCommand(
            "Input.dispatchTouchEvent",
            { type: "touchCancel", touchPoints: [] },
        );
        const resizeCancelled = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.dimensions[0] === 720 && value.dimensions[1] === 420
                ? value
                : undefined;
        }, "Pointer cancellation did not restore the pre-resize selection.");
        await capture.webContents.debugger.sendCommand(
            "Emulation.setTouchEmulationEnabled",
            { enabled: false },
        );
        capture.webContents.debugger.detach();
        report.checks.push({
            interruptedSelection: {
                original: initial.dimensions,
                during: interrupted.dimensions,
                restored: cancelled.dimensions,
                blurEvents: cancelledEffects.blur,
                clipboardWrites: cancelledEffects.clipboardWrites,
                draftUnchanged:
                    JSON.stringify(cancelledEffects.draft) ===
                    JSON.stringify(interactionProbe.draft),
                freshDrag: freshDrag.dimensions,
                fullSelectionRestored: fullSelectionRestored.dimensions,
                resizeDuring: resizeDuring.dimensions,
                resizeCancelled: resizeCancelled.dimensions,
            },
        });

        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=draw]").click(); document.querySelector("#draw_shapes").click(); document.querySelector("#draw_shapes_rect").click();',
        );
        const start = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.2),
            y: Math.round(
                initial.selection.y + initial.selection.height * 0.25,
            ),
        };
        const end = {
            x: Math.round(initial.selection.x + initial.selection.width * 0.62),
            y: Math.round(
                initial.selection.y + initial.selection.height * 0.63,
            ),
        };
        for (const event of [
            { type: "mouseMove", ...start },
            { type: "mouseDown", button: "left", clickCount: 1, ...start },
            { type: "mouseMove", ...end },
            { type: "mouseUp", button: "left", clickCount: 1, ...end },
        ])
            capture.webContents.sendInputEvent(event);
        await pause(200);
        const staged = await clip("window.captureDraftBridge.stage()");
        assert.ok(staged?.id, "Annotated import did not save as a draft.");
        const firstDraft = await dashboardRun(
            `window.openCapture.getDraft(${JSON.stringify(staged.id)})`,
        );
        assert.equal(firstDraft.source.kind, "import");
        assert.deepEqual(firstDraft.rect, {
            x: 0,
            y: 0,
            width: 720,
            height: 420,
        });
        assert.ok(objects(firstDraft).length > 0, "Annotation was not saved.");
        const firstGeometry = objectGeometry(firstDraft);
        const previewPixels = await dashboardRun(`Promise.all([
            ${JSON.stringify(firstDraft.sourceDataURL)},
            ${JSON.stringify(firstDraft.previewDataURL)}
        ].map(src => new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext("2d");context.drawImage(image,0,0);resolve({size:[canvas.width,canvas.height],center:[...context.getImageData(295,185,1,1).data]});};image.onerror=reject;image.src=src;})))`);
        const annotationsInsideSelection = firstGeometry.every(
            (object) =>
                object.left >= 0 &&
                object.top >= 0 &&
                object.left + object.width * (object.scaleX ?? 1) <= 720 &&
                object.top + object.height * (object.scaleY ?? 1) <= 420,
        );
        assert.equal(
            annotationsInsideSelection,
            true,
            "Annotation was saved outside the imported image selection.",
        );
        const pixelsBeforePanelReopen = await clip(`(() => {
            const canvas=document.querySelector("#main_photo");
            return {
                size:[canvas.width,canvas.height],
                header:[...canvas.getContext("2d").getImageData(24,24,1,1).data],
                body:[...canvas.getContext("2d").getImageData(400,150,1,1).data]
            };
        })()`);
        await clip(
            'document.querySelector(".capture-help").hidden=false; true',
        );
        const moreButton = await clip(`(() => {
            const button=document.querySelector('#quick_toolbar [data-capture-action="more"]');
            const rect=button?.getBoundingClientRect();
            return rect ? {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)} : null;
        })()`);
        assert.ok(moreButton, "Toolbar More action is missing.");
        for (const event of [
            { type: "mouseMove", ...moreButton },
            {
                type: "mouseDown",
                button: "left",
                clickCount: 1,
                ...moreButton,
            },
            {
                type: "mouseUp",
                button: "left",
                clickCount: 1,
                ...moreButton,
            },
        ])
            capture.webContents.sendInputEvent(event);
        const saveButton = await clip(`(() => {
            const button=[...document.querySelectorAll('[data-capture-action="save"]')].find(node=>{const style=getComputedStyle(node);const rect=node.getBoundingClientRect();return style.display!=="none"&&style.visibility!=="hidden"&&rect.width>0&&rect.height>0});
            const rect=button?.getBoundingClientRect();
            return rect ? {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)} : null;
        })()`);
        assert.ok(saveButton, "Local Save action is missing from the toolbar.");
        for (const event of [
            { type: "mouseMove", ...saveButton },
            {
                type: "mouseDown",
                button: "left",
                clickCount: 1,
                ...saveButton,
            },
            {
                type: "mouseUp",
                button: "left",
                clickCount: 1,
                ...saveButton,
            },
        ])
            capture.webContents.sendInputEvent(event);
        const savePanel = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.centerBarVisible && value.captureHelpHidden === false
                ? value
                : undefined;
        }, "Local Save did not open the format panel.");
        const shownBeforeReopen = (
            await dashboardRun(
                "window.openCapture.getState().then(state => state.runtime.captureDiagnostics)",
            )
        ).filter((trace) => trace.phase === "shown").length;
        await dashboardRun(
            `window.openCapture.action("open-item", ${JSON.stringify(staged.id)})`,
        );
        await until(
            () =>
                dashboardRun(
                    `window.openCapture.getState().then(state => (state.runtime.captureDiagnostics ?? []).filter(trace => trace.phase === "shown").length > ${shownBeforeReopen})`,
                ),
            "Reopening the active item did not produce a new shown phase.",
        );
        const panelReopened = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.draft?.id === staged.id &&
                value.dimensions[0] === 720 &&
                value.dimensions[1] === 420 &&
                !value.centerBarVisible &&
                value.captureHelpHidden === true &&
                value.toolbarVisible &&
                value.toolbarPointer === "auto"
                ? value
                : undefined;
        }, "Reopened item retained stale Save or Help UI state.");
        const pixelsAfterPanelReopen = await clip(`(() => {
            const canvas=document.querySelector("#main_photo");
            return {
                size:[canvas.width,canvas.height],
                header:[...canvas.getContext("2d").getImageData(24,24,1,1).data],
                body:[...canvas.getContext("2d").getImageData(400,150,1,1).data]
            };
        })()`);
        assert.deepEqual(pixelsAfterPanelReopen, pixelsBeforePanelReopen);
        const panelReopenedAligned = assertFabricCanvasAligned(panelReopened);
        report.checks.push({
            savePanelReopen: {
                panelWasVisible: savePanel.centerBarVisible,
                helpWasVisible: savePanel.captureHelpHidden === false,
                panelHiddenAfterReopen: !panelReopened.centerBarVisible,
                helpHiddenAfterReopen: panelReopened.captureHelpHidden,
                toolbarVisible: panelReopened.toolbarVisible,
                toolbarPointer: panelReopened.toolbarPointer,
                rect: panelReopened.dimensions,
                pixelsPreserved: true,
                canvases: panelReopened.canvases,
                canvasAligned: panelReopenedAligned,
            },
        });
        await shot(capture, "import-annotated-draft");
        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=close]").click()',
        );
        await until(
            () => capture.isDestroyed() || !capture.isVisible(),
            "Capture editor did not close after staging.",
        );

        await dashboardRun(
            `window.openCapture.action("open-item", ${JSON.stringify(staged.id)})`,
        );
        capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading() &&
                        window.isVisible(),
                ),
            "Saved draft did not reopen in the capture editor.",
        );
        clip = (code) => capture.webContents.executeJavaScript(code, true);
        const reopened = await until(async () => {
            const value = await clip(toolbarStateScript);
            return value.draft?.id === staged.id && value.toolbarVisible
                ? value
                : undefined;
        }, "Reopened editor did not bind the staged draft.");
        assert.deepEqual(reopened.dimensions, [720, 420]);
        const reopenedCanvasAligned = assertFabricCanvasAligned(reopened);
        const restaged = await clip("window.captureDraftBridge.stage()");
        assert.equal(restaged.id, staged.id);
        const reopenedDraft = await dashboardRun(
            `window.openCapture.getDraft(${JSON.stringify(staged.id)})`,
        );
        assert.deepEqual(reopenedDraft.rect, firstDraft.rect);
        assert.deepEqual(objectGeometry(reopenedDraft), firstGeometry);
        await shot(capture, "import-reopened-draft");
        report.checks.push({
            draftReopen: {
                id: staged.id,
                source: reopenedDraft.source,
                rect: reopenedDraft.rect,
                annotations: objects(reopenedDraft).length,
                annotationGeometry: firstGeometry,
                annotationsInsideSelection,
                previewPixels: {
                    source: previewPixels[0],
                    annotated: previewPixels[1],
                },
                canvases: reopened.canvases,
                canvasAligned: reopenedCanvasAligned,
                toolbarActions: reopened.toolbarActions,
            },
        });

        report.realConfig.after = hash(realConfig);
        report.realConfig.preserved =
            report.realConfig.before === report.realConfig.after;
        assert.equal(
            report.realConfig.preserved,
            true,
            "Real user config changed during isolated QA.",
        );
        assert.deepEqual(report.rendererErrors, []);
        report.ok = true;
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.log("CAPTURE_IMPORT_QA", JSON.stringify(report));
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        report.failure = error instanceof Error ? error.stack : String(error);
        report.realConfig.after = hash(realConfig);
        report.realConfig.preserved =
            report.realConfig.before === report.realConfig.after;
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
    }
});
