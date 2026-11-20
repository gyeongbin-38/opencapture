const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "workspace-e2e");
if (!process.versions.electron) {
    fs.mkdirSync(evidence, { recursive: true });
    const runProfile = path.join(evidence, `profile-${Date.now()}`);
    const electron = path.join(
        root,
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
    );
    for (const phase of ["exercise", "recovery"]) {
        const result = spawnSync(
            electron,
            [
                __filename,
                `--workspace-profile=${runProfile}`,
                `--workspace-phase=${phase}`,
            ],
            {
                cwd: root,
                encoding: "utf8",
                windowsHide: true,
                timeout: phase === "exercise" ? 150_000 : 90_000,
                maxBuffer: 8 * 1024 * 1024,
            },
        );
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error || result.status !== 0) {
            if (result.error) console.error(result.error);
            process.exit(result.status ?? 1);
        }
    }
    process.exit(0);
}

const { app, BrowserWindow, clipboard, nativeImage } = require("electron");
const fixtures = path.join(evidence, "fixtures");
const profile =
    process.argv
        .find((value) => value.startsWith("--workspace-profile="))
        ?.slice("--workspace-profile=".length) ??
    path.join(evidence, `profile-${Date.now()}`);
const phase =
    process.argv
        .find((value) => value.startsWith("--workspace-phase="))
        ?.slice("--workspace-phase=".length) ?? "exercise";
const recoveryPlanPath = path.join(profile, "workspace-recovery-plan.json");
fs.mkdirSync(fixtures, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", fixtures);
process.argv.push(`--userData=${profile}`);

const rendererErrors = [];
app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (event) => {
        if (event.level === "error")
            rendererErrors.push({
                message: event.message,
                sourceId: event.sourceId,
                lineNumber: event.lineNumber,
                url: contents.getURL(),
            });
    });
});

require("../out/main/main.js");

const phaseOneReportPath = path.join(evidence, "qa-phase-one.json");
const report =
    phase === "recovery" && fs.existsSync(phaseOneReportPath)
        ? JSON.parse(fs.readFileSync(phaseOneReportPath, "utf8"))
        : {
              checks: [],
              limitations: {
                  physicalGlobalShortcut:
                      "not exercised; renderer input is synthetic",
                  physicalExplorerPaste:
                      "not exercised; native CF_HDROP helper readback is exercised",
              },
          };
report.rendererErrors = rendererErrors;
delete report.failure;
delete report.timeout;
const pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (value, message) => {
    if (!value) throw new Error(message);
};
async function until(check, message, attempts = 240) {
    for (let index = 0; index < attempts; index++) {
        const value = await check();
        if (value) return value;
        await pause(100);
    }
    throw new Error(message);
}
async function shot(window, name) {
    await pause(220);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(evidence, `${name}.png`), image.toPNG());
}
async function clipboardPng() {
    const items = await clipboard.read();
    const pngItem = items.find((item) => item.types.includes("image/png"));
    if (!pngItem) return nativeImage.createEmpty();
    const blob = await pngItem.getType("image/png");
    return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
}
function dataObjects(draft) {
    return Array.isArray(draft?.canvas?.objects) ? draft.canvas.objects : [];
}
function nativeHandle(window) {
    const bytes = window.getNativeWindowHandle();
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[index]);
    return value.toString();
}
function readWindowsDropFiles(owner) {
    const runtime = path.join(
        root,
        "assets",
        "runtime",
        "win32-x64",
        "python.exe",
    );
    const code = `import ctypes,json,sys
u=ctypes.WinDLL("user32",use_last_error=True);s=ctypes.WinDLL("shell32",use_last_error=True)
u.OpenClipboard.argtypes=[ctypes.c_void_p];u.OpenClipboard.restype=ctypes.c_bool
u.GetClipboardData.argtypes=[ctypes.c_uint];u.GetClipboardData.restype=ctypes.c_void_p
s.DragQueryFileW.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_wchar_p,ctypes.c_uint];s.DragQueryFileW.restype=ctypes.c_uint
if not u.OpenClipboard(ctypes.c_void_p(int(sys.argv[1]))): raise SystemExit("open failed")
try:
 h=u.GetClipboardData(15);n=s.DragQueryFileW(h,0xffffffff,None,0);out=[]
 for i in range(n):
  length=s.DragQueryFileW(h,i,None,0);buf=ctypes.create_unicode_buffer(length+1);s.DragQueryFileW(h,i,buf,length+1);out.append(buf.value)
 print(json.dumps(out,ensure_ascii=False))
finally:u.CloseClipboard()`;
    const result = spawnSync(
        runtime,
        ["-X", "utf8", "-c", code, nativeHandle(owner)],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (result.status !== 0)
        throw new Error(
            result.stderr.trim() ||
                result.stdout.trim() ||
                "CF_HDROP readback failed.",
        );
    return JSON.parse(result.stdout.trim());
}

const timeout = setTimeout(() => {
    report.ok = false;
    report.timeout = true;
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    app.exit(1);
}, 150_000);

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
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    'Boolean(window.openCapture && document.querySelector(".nav-button"))',
                ),
            "Dashboard API did not initialize.",
        );
        if (phase === "recovery") {
            const plan = JSON.parse(fs.readFileSync(recoveryPlanPath, "utf8"));
            const recovered = await run(`Promise.all([
                window.openCapture.queryItems({scope:"library",sort:"newest",offset:0,limit:200,queryId:"restart-library"}),
                window.openCapture.queryItems({scope:"temporary",sort:"newest",offset:0,limit:200,queryId:"restart-temporary"}),
                window.openCapture.getDraft(${JSON.stringify(plan.firstId)})
            ]).then(([library,temporary,draft])=>({library:library.items.map(item=>item.id),temporary:temporary.items.map(item=>item.id),draft}))`);
            assert(
                recovered.library.includes(plan.firstId) &&
                    recovered.temporary.includes(plan.secondId),
                "Restart did not recover promoted and temporary draft identities.",
            );
            assert(
                dataObjects(recovered.draft).length === plan.fabricObjects &&
                    JSON.stringify(recovered.draft.rect) ===
                        JSON.stringify(plan.rect) &&
                    recovered.draft.source.kind === plan.source.kind,
                "Restart changed editable draft payload, selection, or source context.",
            );
            await run(
                `window.openCapture.action("open-item", ${JSON.stringify(plan.firstId)})`,
            );
            const recoveredEditor = await until(
                () =>
                    BrowserWindow.getAllWindows().find(
                        (window) =>
                            window.webContents
                                .getURL()
                                .includes("capture.html") &&
                            !window.webContents.isLoading(),
                    ),
                "Restart recovery did not reopen the capture editor.",
            );
            const recoveredRun = (code) =>
                recoveredEditor.webContents.executeJavaScript(code, true);
            await until(
                () =>
                    recoveredRun(
                        `window.captureDraftBridge?.info().id === ${JSON.stringify(plan.firstId)} && document.querySelector("#selection_handles")?.hidden === false`,
                    ),
                "Restarted editor did not bind the recovered draft.",
            );
            const recoveredUi = await recoveredRun(`(() => ({
                id:window.captureDraftBridge.info().id,
                size:[...document.querySelectorAll(".capture-dimensions input")].map(input=>Number(input.value)),
                temporaryThumbs:document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length
            }))()`);
            assert(
                Math.abs(recoveredUi.size[0] - plan.rect.width) <= 1 &&
                    Math.abs(recoveredUi.size[1] - plan.rect.height) <= 1,
                "Restarted editor selection dimensions changed.",
            );
            await shot(recoveredEditor, "restart-recovered-draft");
            report.checks.push({
                restartRecovery: {
                    profile,
                    firstId: plan.firstId,
                    secondId: plan.secondId,
                    revision: recovered.draft.revision,
                    rect: recovered.draft.rect,
                    fabricObjects: dataObjects(recovered.draft).length,
                    source: recovered.draft.source,
                    editor: recoveredUi,
                },
            });
            assert(
                !rendererErrors.length,
                `Recovery renderer errors occurred: ${JSON.stringify(rendererErrors)}`,
            );
            report.ok = true;
            report.restartVerified = true;
            fs.writeFileSync(
                path.join(evidence, "qa.json"),
                JSON.stringify(report, null, 2),
            );
            console.log(
                "CAPTURE_WORKSPACE_RECOVERY_QA",
                JSON.stringify(report),
            );
            clearTimeout(timeout);
            app.exit(0);
            return;
        }
        await run(`localStorage.setItem("oc:onboarded", "1");
            for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
            const backdrop = document.querySelector(".modal-backdrop"); if (backdrop) backdrop.hidden = true;`);
        await run(
            'window.openCapture.action("configure-workflow", { autoOcr:false, autoPreview:false, autoClipboard:false })',
        );

        const configured = await run(`window.openCapture.configureExperience({
            toolbarOrder:["stage","annotate","copy","pin","more"],
            radialOrder:["compare","annotate","stage","ocr","redact","pin","more"],
            feedback:{visual:true,sound:false,motion:"reduced"},
            defaultPreset:"stage-only",
            shelfEnabled:true
        })`);
        assert(
            configured.toolbarOrder.join(",") ===
                "stage,annotate,copy,pin,more",
            "Toolbar preference order did not persist.",
        );
        assert(
            configured.radialOrder.join(",") ===
                "compare,annotate,stage,ocr,redact,pin,more",
            "Radial preference order did not persist.",
        );
        assert(
            configured.feedback.motion === "reduced" &&
                configured.feedback.sound === false,
            "Reduced-motion or sound preference did not persist.",
        );
        report.checks.push({
            preferences: {
                toolbarOrder: configured.toolbarOrder,
                radialOrder: configured.radialOrder,
                feedback: configured.feedback,
                defaultPreset: configured.defaultPreset,
            },
        });

        const fixtureData =
            await run(`(() => Array.from({length:16}, (_, index) => {
            const canvas = document.createElement("canvas"); canvas.width=920; canvas.height=580;
            const context = canvas.getContext("2d");
            context.fillStyle = index % 2 ? "#f7f7f8" : "#ececf0"; context.fillRect(0,0,920,580);
            context.fillStyle = "#17171a"; context.fillRect(0,0,920,54);
            context.fillStyle = "#ffffff"; context.font = "600 17px Segoe UI";
            context.fillText(index === 0 ? "QUERY TARGET SPECIAL" : "Workspace fixture " + index, 24,34);
            context.fillStyle = "#111111"; context.font = "700 26px Segoe UI";
            context.fillText(index === 0 ? "qa@example.com" : "REFERENCE " + index, 470,112);
            context.fillStyle = "#d8d8df"; context.fillRect(28,86,210,448);
            context.fillStyle = ["#a78bfa","#67e8f9","#86efac","#fda4af"][index % 4];
            context.fillRect(280 + (index % 3) * 7,132,552,246);
            context.fillStyle = "#27272a"; context.fillRect(280,422,160,46);
            context.fillStyle = "#ffffff"; context.font = "15px Segoe UI"; context.fillText("Continue",325,451);
            return canvas.toDataURL("image/png");
        }))()`);
        const fixturePaths = fixtureData.map((data, index) => {
            const name =
                index === 0
                    ? "query-target-special.png"
                    : `workspace-fixture-${String(index).padStart(2, "0")}.png`;
            const file = path.join(fixtures, name);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            return file;
        });
        await run(`(() => { const input=document.createElement("input");
            input.type="file"; input.multiple=true; input.id="workspace-fixtures";
            input.hidden=true; document.body.append(input); })()`);
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            {
                nodeId: documentRoot.nodeId,
                selector: "#workspace-fixtures",
            },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: fixturePaths },
        );
        const imported = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#workspace-fixtures").files))',
        );
        dashboard.webContents.debugger.detach();
        assert(
            imported.items.length === 16,
            "Fixture import count was not 16.",
        );
        const target = imported.items.find((item) =>
            item.name.includes("query-target-special"),
        );
        assert(target, "Query target fixture is missing.");

        const firstPage = await run(`window.openCapture.queryItems({
            scope:"library",sort:"newest",offset:0,limit:5,queryId:"before-filter"
        })`);
        const targetIndex = await run(`window.openCapture.queryItems({
            scope:"library",sort:"newest",offset:0,limit:200,queryId:"target-position"
        }).then(result => result.items.findIndex(item => item.id === ${JSON.stringify(target.id)}))`);
        assert(
            targetIndex >= 5,
            `Fixture target was not beyond page one: ${targetIndex}.`,
        );
        const filtered = await run(`window.openCapture.queryItems({
            scope:"library",search:"query-target-special",sort:"newest",offset:0,limit:1,queryId:"filtered"
        })`);
        assert(
            filtered.total === 1 && filtered.items[0]?.id === target.id,
            "Search was paginated before filtering.",
        );
        report.checks.push({
            queryBeforePagination: {
                targetIndex,
                pageSize: firstPage.items.length,
                filteredTotal: filtered.total,
                filteredId: filtered.items[0].id,
            },
        });

        const workspaceRecords = await run(`(async () => {
            const style={id:"qa-style",name:"QA Minimal",background:"#111111",padding:24,shadow:18,radius:12,ratio:"free",align:"center",autoBalance:true};
            const filter={id:"qa-smart",name:"QA Today Images",date:"today",type:"image"};
            await window.openCapture.saveStyle(style);
            await window.openCapture.saveSmartFilter(filter);
            await window.openCapture.addSampledColor("#112233");
            await window.openCapture.addSampledColor("#AABBCC");
            const styles=await window.openCapture.listStyles();
            const filters=await window.openCapture.listSmartFilters();
            const colors=await window.openCapture.getSampledColors();
            const applied=await window.openCapture.queryItems({scope:"library",smartId:filter.id,sort:"newest",offset:0,limit:200,queryId:"qa-smart-applied"});
            await window.openCapture.removeStyle(style.id);
            await window.openCapture.removeSmartFilter(filter.id);
            return {styleSaved:styles.some(value=>value.id===style.id),filterSaved:filters.some(value=>value.id===filter.id),colors,applied:applied.items.map(item=>item.id),styleRemoved:!(await window.openCapture.listStyles()).some(value=>value.id===style.id),filterRemoved:!(await window.openCapture.listSmartFilters()).some(value=>value.id===filter.id)};
        })()`);
        assert(
            workspaceRecords.styleSaved && workspaceRecords.styleRemoved,
            "Named beautify style did not complete save/list/delete.",
        );
        assert(
            workspaceRecords.filterSaved &&
                workspaceRecords.filterRemoved &&
                workspaceRecords.applied.length === 16,
            "Saved smart filter did not complete save/list/apply/delete.",
        );
        assert(
            workspaceRecords.colors[0]?.value === "#AABBCC" &&
                workspaceRecords.colors[1]?.value === "#112233",
            "Recent sampled color palette order was not persisted.",
        );
        report.checks.push({ workspaceRecords });

        await run('document.querySelectorAll(".nav-button")[1].click()');
        await until(
            () => run('document.querySelectorAll(".item-select").length >= 3'),
            "Library cards did not render for bundle verification.",
        );
        const bundleOpenState = await run(`(() => {
            const titles=[...document.querySelectorAll(".item-select")].slice(0,3).map(box=>box.title);
            for (const title of titles) {
                const box=[...document.querySelectorAll(".item-select")].find(candidate=>candidate.title===title);
                if (box && !box.checked) box.click();
            }
            const button=[...document.querySelectorAll(".selection-actions button")].find(candidate=>candidate.title.includes("격자"));
            const state={titles,checked:document.querySelectorAll(".item-select:checked").length,disabled:button.disabled};
            button.click(); return state;
        })()`);
        assert(
            bundleOpenState.checked === 3 && !bundleOpenState.disabled,
            `Bundle selection was not ready: ${JSON.stringify(bundleOpenState)}.`,
        );
        await until(
            () =>
                run(
                    'document.querySelector(".bundle-dialog")?.open === true && document.querySelectorAll(".bundle-order-chip").length === 3',
                ),
            "Bundle composer did not open with three images.",
        );
        const bundleLayouts = await run(`(async () => {
            const dialog=document.querySelector(".bundle-dialog");
            const layout=dialog.querySelector('[data-role="layout"]');
            const canvas=dialog.querySelector('[data-role="canvas"]');
            const meta=dialog.querySelector('.bundle-preview small');
            const result={};
            for (const value of ["grid","horizontal","vertical"]) {
                layout.value=value; layout.dispatchEvent(new Event("input",{bubbles:true}));
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                result[value]={width:canvas.width,height:canvas.height,meta:meta.textContent};
            }
            layout.value="grid"; layout.dispatchEvent(new Event("input",{bubbles:true}));
            const chips=[...dialog.querySelectorAll(".bundle-order-chip")];
            const before=chips.map(chip=>chip.querySelector("strong").textContent);
            const transfer=new DataTransfer();
            chips[0].dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}));
            chips[2].dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}));
            const after=[...dialog.querySelectorAll(".bundle-order-chip strong")].map(node=>node.textContent);
            return {result,before,after};
        })()`);
        assert(
            bundleLayouts.result.horizontal.width >
                bundleLayouts.result.horizontal.height &&
                bundleLayouts.result.vertical.height >
                    bundleLayouts.result.vertical.width &&
                bundleLayouts.result.grid.width > 0 &&
                bundleLayouts.result.grid.height > 0,
            `Bundle layouts did not redraw: ${JSON.stringify(bundleLayouts.result)}.`,
        );
        assert(
            bundleLayouts.before[0] !== bundleLayouts.after[0] &&
                bundleLayouts.after[2] === bundleLayouts.before[0],
            "Bundle drag reorder did not change the image order.",
        );
        await shot(dashboard, "bundle-grid-reordered");
        await run(
            'document.querySelector(".bundle-dialog [data-role=copy]").click()',
        );
        await until(
            () => run('document.querySelector(".bundle-dialog")?.open === false'),
            "Bundle copy did not finish.",
        );
        const bundleImage = await clipboardPng();
        assert(
            !bundleImage.isEmpty(),
            "Bundle copy did not write a PNG image.",
        );
        report.checks.push({
            bundleComposer: {
                layouts: bundleLayouts.result,
                reorder: bundleLayouts.after,
                copiedSize: bundleImage.getSize(),
            },
        });

        await run(
            `window.openCapture.action("open-item", ${JSON.stringify(target.id)})`,
        );
        let capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Capture editor did not load.",
        );
        const clip = (code) =>
            capture.webContents.executeJavaScript(code, true);
        await clip(
            `window.addEventListener("error",e=>console.error("CLIP_STACK:"+(e.error&&e.error.stack||e.message)),true)`,
        ).catch(() => {});
        await until(
            () =>
                clip(
                    'document.body.style.opacity !== "0" && Boolean(window.captureDraftBridge && document.querySelector("#quick_toolbar"))',
                ),
            "Capture workspace did not initialize.",
        );
        const editorPreferences = await clip(`(() => ({
            toolbar:[...document.querySelectorAll("#quick_toolbar [data-capture-action]")].map(node=>node.dataset.captureAction),
            reduced:document.body.classList.contains("capture-motion-reduced"),
            soundOff:!document.body.classList.contains("capture-sound-enabled")
        }))()`);
        assert(
            editorPreferences.toolbar.slice(0, 5).join(",") ===
                "stage,draw,copy,ding,more",
            `Editor toolbar ignored configured order: ${JSON.stringify(editorPreferences.toolbar)}.`,
        );
        assert(
            editorPreferences.reduced,
            "Editor reduced-motion class is absent.",
        );

        const photo = await clip(
            'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
        );
        const firstStart = {
            x: Math.round(photo.x + photo.width * 0.12),
            y: Math.round(photo.y + photo.height * 0.15),
        };
        const firstEnd = {
            x: Math.round(photo.x + photo.width * 0.72),
            y: Math.round(photo.y + photo.height * 0.72),
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...firstStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...firstStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...firstEnd,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...firstEnd,
        });
        await until(
            () =>
                clip(
                    'document.querySelector("#selection_handles")?.hidden === false && Number(document.querySelector(".capture-dimensions input")?.value) > 10',
                ),
            "First selection was not created.",
        );
        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=draw]").click(); document.querySelector("#draw_shapes").click(); document.querySelector("#draw_shapes_rect").click();',
        );
        const annotationStart = {
            x: firstStart.x + 70,
            y: firstStart.y + 55,
        };
        const annotationEnd = {
            x: annotationStart.x + 150,
            y: annotationStart.y + 95,
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...annotationStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...annotationStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...annotationEnd,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...annotationEnd,
        });
        await pause(180);
        const firstStage = await clip("window.captureDraftBridge.stage()");
        assert(firstStage?.id, "First draft did not stage.");
        const firstDraft = await run(
            `window.openCapture.getDraft(${JSON.stringify(firstStage.id)})`,
        );
        assert(
            dataObjects(firstDraft).length > 0,
            "Fabric annotation was not persisted in the first draft.",
        );
        assert(
            firstDraft.source.kind === "import",
            `Draft source context was lost: ${JSON.stringify(firstDraft.source)}.`,
        );

        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=draw]").click()',
        );
        const secondStart = {
            x: Math.round(photo.x + photo.width * 0.24),
            y: Math.round(photo.y + photo.height * 0.25),
        };
        const secondEnd = {
            x: Math.round(photo.x + photo.width * 0.88),
            y: Math.round(photo.y + photo.height * 0.86),
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...secondStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...secondStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            modifiers: ["shift"],
            ...secondEnd,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...secondEnd,
        });
        await pause(250);
        const secondStage = await clip("window.captureDraftBridge.stage()");
        assert(secondStage?.id, "Second draft did not stage.");
        assert(
            firstStage.id !== secondStage.id,
            "Shift multi-region capture reused the first draft identity.",
        );
        await clip("window.captureDraftBridge.flush()");
        await shot(capture, "multi-region-editor");
        let inlineDragPayload = null;
        const originalInlineDrag =
            capture.webContents.startDrag.bind(capture.webContents);
        capture.webContents.startDrag = (item) => {
            inlineDragPayload = item;
        };
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length >= 2',
                ),
            "Inline shelf did not render both staged drafts.",
        );
        const inlineDraggable = await clip(`(() => {
            const thumb=document.querySelector("#capture_inline_shelf .capture-shelf-thumb");
            if (!thumb?.draggable) return false;
            thumb.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true}));
            return true;
        })()`);
        await until(
            () => inlineDragPayload !== null,
            "Inline shelf thumb drag did not reach the main process.",
        );
        assert(
            inlineDraggable &&
                Array.isArray(inlineDragPayload?.files) &&
                inlineDragPayload.files.length === 1 &&
                inlineDragPayload.files.every((file) => fs.existsSync(file)),
            `Inline shelf drag payload was invalid: ${JSON.stringify(inlineDragPayload)}.`,
        );
        capture.webContents.startDrag = originalInlineDrag;
        report.checks.push({
            inlineShelfDrag: { files: inlineDragPayload.files.length },
        });

        const thumbIds = await clip(
            '[...document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb")].map(node=>node.dataset.itemId)',
        );
        assert(
            thumbIds.includes(firstStage.id) &&
                thumbIds.includes(secondStage.id),
            `Inline shelf thumbs lack stable item ids: ${JSON.stringify(thumbIds)}.`,
        );
        const stagedBeforeDiscard = await clip(
            'document.querySelectorAll("#capture_staged .capture-staged-box").length',
        );
        assert(
            stagedBeforeDiscard === 1,
            `Expected one staged marker before discard, saw ${stagedBeforeDiscard}.`,
        );
        await clip(`(() => {
            const thumb=document.querySelector('#capture_inline_shelf .capture-shelf-thumb[data-item-id=${JSON.stringify(firstStage.id)}]');
            thumb.dispatchEvent(new PointerEvent("pointerdown",{button:1,bubbles:true}));
            thumb.dispatchEvent(new PointerEvent("pointerup",{button:1,bubbles:true}));
            thumb.dispatchEvent(new MouseEvent("auxclick",{button:1,bubbles:true}));
        })()`);
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 1',
                ),
            "Middle-click did not discard the inline shelf thumbnail.",
        );
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_staged .capture-staged-box").length === 0',
                ),
            "Middle-click discard did not clear the staged marker.",
        );
        await clip(`(() => {
            const thumb=document.querySelector('#capture_inline_shelf .capture-shelf-thumb[data-item-id=${JSON.stringify(secondStage.id)}]');
            thumb.focus();
            thumb.dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}));
        })()`);
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 0 && document.querySelector("#capture_inline_shelf")?.hidden === true',
                ),
            "Delete key did not discard the remaining inline shelf thumbnail.",
        );

        await clip("window.captureDraftBridge.stage()");
        await pause(700);
        const discardedStaysDiscarded = await clip(
            'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 0',
        );
        assert(
            discardedStaysDiscarded,
            "Discarded thumbnail resurrected on the first silent recommit.",
        );
        await clip("window.captureDraftBridge.stage()");
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 1',
                ),
            "Explicit restage did not return a thumbnail to the inline shelf.",
        );
        const thirdStart = {
            x: Math.round(photo.x + photo.width * 0.3),
            y: Math.round(photo.y + photo.height * 0.32),
        };
        const thirdEnd = {
            x: Math.round(photo.x + photo.width * 0.8),
            y: Math.round(photo.y + photo.height * 0.82),
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...thirdStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...thirdStart,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            modifiers: ["shift"],
            ...thirdEnd,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            modifiers: ["shift"],
            ...thirdEnd,
        });
        await pause(250);
        const thirdStage = await clip("window.captureDraftBridge.stage()");
        assert(
            thirdStage?.id &&
                thirdStage.id !== firstStage.id &&
                thirdStage.id !== secondStage.id,
            "Third staged draft did not get a distinct id.",
        );
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 2 && document.querySelectorAll("#capture_staged .capture-staged-box").length === 1',
                ),
            "Third region did not render a thumbnail with a staged marker.",
        );
        await until(
            () =>
                clip(
                    'document.querySelector("#capture_inline_shelf [data-shelf-clear]") !== null',
                ),
            "Inline shelf clear-all control did not render.",
        );
        await clip(
            'document.querySelector("#capture_inline_shelf [data-shelf-clear]").click()',
        );
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length === 0 && document.querySelector("#capture_inline_shelf")?.hidden === true && document.querySelectorAll("#capture_staged .capture-staged-box").length === 0',
                ),
            "Clear-all did not empty the inline shelf and staged markers.",
        );
        const discardedIds = await run(`window.openCapture.queryItems({
            scope:"trash",sort:"newest",offset:0,limit:200,queryId:"shelf-discard-trash"
        }).then(result => result.items.map(item => item.id))`);
        assert(
            [firstStage.id, secondStage.id, thirdStage.id].every((id) =>
                discardedIds.includes(id),
            ),
            `Clear-all did not trash every staged draft: ${JSON.stringify(discardedIds)}.`,
        );
        await run(
            `window.openCapture.restoreItems(${JSON.stringify([firstStage.id, secondStage.id])})`,
        );
        await shot(capture, "inline-shelf-cleared");
        report.checks.push({
            inlineShelfDiscard: {
                middleClick: firstStage.id,
                deleteKey: secondStage.id,
                clearAll: [secondStage.id, thirdStage.id],
                stagedMarkersCleared: stagedBeforeDiscard,
            },
        });
        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=close]").click()',
        );
        await until(
            () => capture.isDestroyed() || !capture.isVisible(),
            "Capture editor did not close after staging the regions.",
        );
        const shelf = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("capture_shelf.html") &&
                        !window.webContents.isLoading(),
                ),
            "Temporary capture shelf did not load.",
        );
        const shelfRun = (code) =>
            shelf.webContents.executeJavaScript(code, true);
        await until(
            () =>
                shelfRun(
                    'Boolean(window.openCapture && document.querySelectorAll(".shelf-card").length >= 2)',
                ),
            "Shelf did not render both temporary drafts.",
        );
        const shelfQuery = await shelfRun(`window.openCapture.queryItems({
            scope:"temporary",sort:"newest",offset:0,limit:80,queryId:"shelf-e2e"
        })`);
        assert(
            shelfQuery.items.some((item) => item.id === firstStage.id) &&
                shelfQuery.items.some((item) => item.id === secondStage.id),
            "Shelf temporary scope dropped a staged draft.",
        );
        const deniedShelfScope = await shelfRun(`window.openCapture.queryItems({
            scope:"library",sort:"newest",offset:0,limit:1,queryId:"shelf-denied"
        }).then(() => "allowed", error => String(error.message || error))`);
        assert(
            deniedShelfScope !== "allowed" &&
                deniedShelfScope.includes("temporary"),
            `Shelf escaped temporary scope: ${deniedShelfScope}.`,
        );
        const copiedPreview = await shelfRun(
            `window.openCapture.shelfAction("copy", ${JSON.stringify(firstStage.id)})`,
        );
        assert(copiedPreview === true, "Shelf single-image copy was rejected.");
        const previewClipboard = await clipboardPng();
        assert(
            !previewClipboard.isEmpty(),
            "Shelf single-image copy did not write an image.",
        );
        const previewClipboardSize = previewClipboard.getSize();
        const pinned = await shelfRun(
            `window.openCapture.shelfAction("pin", ${JSON.stringify(firstStage.id)})`,
        );
        assert(pinned === true, "Shelf pin action was rejected.");
        const pinWindow = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("ding.html") &&
                        !window.webContents.isLoading(),
                ),
            "Shelf pin action did not open the pin renderer.",
        );
        assert(!pinWindow.isDestroyed(), "Pin renderer closed unexpectedly.");
        const expectedPreviewData = await run(
            `Promise.all(${JSON.stringify([firstStage.id, secondStage.id])}.map(id=>window.openCapture.getDraft(id))).then(drafts=>drafts.map(draft=>draft.previewDataURL))`,
        );
        const copiedFiles = await shelfRun(
            `window.openCapture.copySourceFiles(${JSON.stringify([firstStage.id, secondStage.id])})`,
        );
        assert(
            copiedFiles.copied === 2,
            "Shelf native source-file copy did not validate two files.",
        );
        const dropFiles = readWindowsDropFiles(shelf);
        const copiedPreviewMatches = dropFiles.map((file, index) =>
            fs
                .readFileSync(file)
                .equals(
                    Buffer.from(
                        expectedPreviewData[index].split(",")[1],
                        "base64",
                    ),
                ),
        );
        assert(
            dropFiles.length === 2 &&
                new Set(dropFiles.map((file) => file.toLowerCase())).size ===
                    2 &&
                copiedPreviewMatches.every(Boolean) &&
                dropFiles.every((file) =>
                    file
                        .toLowerCase()
                        .includes(
                            `${path.sep}clipboard-files${path.sep}`.toLowerCase(),
                        ),
                ),
            `CF_HDROP did not contain both owned preview snapshots: ${JSON.stringify({ dropFiles, copiedPreviewMatches })}.`,
        );
        const shelfCards =
            await shelfRun(`[...document.querySelectorAll(".shelf-card")].map(card=>({
            id:card.dataset.itemId, draggable:card.draggable, selected:card.getAttribute("aria-pressed")
        }))`);
        await shot(shelf, "temporary-shelf");
        report.checks.push({
            temporaryShelf: {
                count: shelfQuery.total,
                ids: shelfQuery.items.map((item) => item.id),
                deniedLibraryScope: deniedShelfScope,
                singlePreviewCopy: previewClipboardSize,
                pinRenderer: path.basename(pinWindow.webContents.getURL()),
                nativeFileListReadback: copiedFiles.copied,
                nativeFileListPaths: dropFiles,
                copiedPreviewMatches,
                clipboardFormat: "CF_HDROP",
                cards: shelfCards,
            },
        });

        let shelfDragPayload = null;
        const originalShelfDrag = shelf.webContents.startDrag.bind(
            shelf.webContents,
        );
        shelf.webContents.startDrag = (item) => {
            shelfDragPayload = item;
        };
        await shelfRun(`(() => {
            const cards=[...document.querySelectorAll(".shelf-card")];
            cards[0].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0}));
            cards[1].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,ctrlKey:true}));
            cards[1].dispatchEvent(new DragEvent("dragstart",{bubbles:true}));
        })()`);
        await until(
            () => shelfDragPayload !== null,
            "Shelf multi-select drag did not reach startDrag.",
        );
        assert(
            Array.isArray(shelfDragPayload?.files) &&
                shelfDragPayload.files.length === 2 &&
                shelfDragPayload.files.every((file) => fs.existsSync(file)),
            `Shelf multi-drag did not carry both files: ${JSON.stringify(shelfDragPayload)}.`,
        );
        shelf.webContents.startDrag = originalShelfDrag;
        report.checks.push({
            shelfMultiDrag: { files: shelfDragPayload.files.length },
        });

        const rangeSel = await shelfRun(`(() => {
            const cards=[...document.querySelectorAll(".shelf-card")];
            cards[0].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0}));
            cards[1].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,shiftKey:true}));
            return [...document.querySelectorAll(".shelf-card")].map(c=>c.getAttribute("aria-pressed"));
        })()`);
        assert(
            rangeSel.length === 2 && rangeSel.every((v) => v === "true"),
            `Shift-click did not range-select the shelf: ${JSON.stringify(rangeSel)}.`,
        );
        report.checks.push({ shelfRangeSelect: rangeSel });

        const arrowNav = await shelfRun(`(() => {
            const cards=document.querySelectorAll(".shelf-card");
            cards[cards.length-1].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0}));
            const press=(key)=>document.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true}));
            const sel=()=>[...document.querySelectorAll(".shelf-card")].findIndex(c=>c.getAttribute("aria-pressed")==="true");
            const last=cards.length-1;
            press("ArrowLeft");
            const afterLeft=sel();
            press("ArrowRight");
            const afterRight=sel();
            press("ArrowLeft");
            cards[0].dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,shiftKey:true}));
            const ranged=[...document.querySelectorAll(".shelf-card")].filter(c=>c.getAttribute("aria-pressed")==="true").length;
            press("End");
            const afterEnd=sel();
            press("Home");
            const afterHome=sel();
            return {last,afterLeft,afterRight,ranged,afterEnd,afterHome};
        })()`);
        assert(
            arrowNav.afterLeft === arrowNav.last - 1 &&
                arrowNav.afterRight === arrowNav.last,
            `Shelf arrow navigation did not move the selection: ${JSON.stringify(arrowNav)}.`,
        );
        assert(
            arrowNav.afterEnd === arrowNav.last && arrowNav.afterHome === 0,
            `Shelf Home/End did not jump the selection: ${JSON.stringify(arrowNav)}.`,
        );
        assert(
            arrowNav.ranged === arrowNav.last,
            `Shift-click must anchor at the arrow-selected card: ${JSON.stringify(arrowNav)}.`,
        );
        await shelfRun(`(() => {
            document
                .querySelector('.shelf-card[data-item-id=${JSON.stringify(secondStage.id)}]')
                .dispatchEvent(new MouseEvent("click",{bubbles:true,button:0}));
            document.querySelector('[data-shelf-action="d"]').click();
        })()`);
        await until(
            async () =>
                (await shelfRun(
                    'document.querySelectorAll(".shelf-card").length',
                )) === arrowNav.last,
            "Shelf trash action did not remove the selected draft.",
        );
        report.checks.push({
            shelfTrash: {
                arrowNav,
                trashed: secondStage.id,
                remaining: arrowNav.last,
            },
        });

        await shelfRun(
            'document.querySelector(\'[data-shelf-action="d"]\').click()',
        );
        await until(
            async () =>
                (await shelfRun(
                    'document.querySelectorAll(".shelf-card").length',
                )) === 0,
            "Shelf did not empty after trashing the last draft.",
        );
        const shelfEmpty = await shelfRun(
            'document.querySelector(".shelf-empty")?.textContent ?? ""',
        );
        assert(
            shelfEmpty.length > 0,
            "Shelf empty state did not render a message.",
        );
        await run(
            `window.openCapture.restoreItems(${JSON.stringify([firstStage.id])})`,
        );
        await until(
            async () =>
                (await shelfRun(
                    'document.querySelectorAll(".shelf-card").length',
                )) === 1,
            "Restored draft did not return to the shelf.",
        );
        report.checks.push({ shelfEmpty });

        await shelfRun(`(() => {
            const card=document.querySelector('.shelf-card[data-item-id=${JSON.stringify(firstStage.id)}]');
            card.dispatchEvent(new MouseEvent("dblclick", {bubbles:true,button:0}));
        })()`);
        capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Shelf double-click did not create the capture editor.",
        );
        await until(
            () =>
                capture.isVisible() &&
                clip(
                    `window.captureDraftBridge.info().id === ${JSON.stringify(firstStage.id)}`,
                ),
            "Shelf double-click did not reopen the editable draft.",
        );
        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=close]").click()',
        );
        await until(
            () => capture.isDestroyed() || !capture.isVisible(),
            "Shelf-opened editor did not close cleanly.",
        );
        report.checks.push({ shelfEditableDoubleClick: firstStage.id });

        await shelfRun(`(() => {
            document
                .querySelector('.shelf-card[data-item-id=${JSON.stringify(firstStage.id)}]')
                .dispatchEvent(new MouseEvent("click",{bubbles:true,button:0}));
            document.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
        })()`);
        capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Shelf Enter key did not create the capture editor.",
        );
        await until(
            () =>
                capture.isVisible() &&
                clip(
                    `window.captureDraftBridge.info().id === ${JSON.stringify(firstStage.id)}`,
                ),
            "Shelf Enter key did not reopen the editable draft.",
        );
        await clip(
            'document.querySelector("#quick_toolbar [data-capture-action=close]").click()',
        );
        await until(
            () => capture.isDestroyed() || !capture.isVisible(),
            "Enter-opened editor did not close cleanly.",
        );
        report.checks.push({ shelfEnterOpen: firstStage.id });

        const beforeMutationRevision = firstPage.catalogRevision;
        await run(
            `window.openCapture.promoteItems(${JSON.stringify([firstStage.id])})`,
        );
        await run(
            `window.openCapture.trashItems(${JSON.stringify([secondStage.id])})`,
        );
        const statuses = await run(`Promise.all([
            window.openCapture.queryItems({scope:"library",sort:"newest",offset:0,limit:200,queryId:"status-library"}),
            window.openCapture.queryItems({scope:"trash",sort:"newest",offset:0,limit:200,queryId:"status-trash"})
        ]).then(([library,trash])=>({library:library.items.map(item=>item.id),trash:trash.items.map(item=>item.id)}))`);
        assert(
            statuses.library.includes(firstStage.id) &&
                statuses.trash.includes(secondStage.id),
            "Promote or trash transition lost stable draft ids.",
        );
        await run(
            `window.openCapture.restoreItems(${JSON.stringify([secondStage.id])})`,
        );
        const restored = await run(`window.openCapture.queryItems({
            scope:"temporary",sort:"newest",offset:0,limit:200,queryId:"status-restored"
        })`);
        assert(
            restored.items.some((item) => item.id === secondStage.id),
            "Restored draft did not return to its temporary status.",
        );
        const stalePage = await run(`window.openCapture.queryItems({
            scope:"library",sort:"newest",offset:5,limit:5,queryId:"stale-page",catalogRevision:${beforeMutationRevision}
        }).then(() => "allowed", error => String(error.message || error))`);
        assert(
            stalePage !== "allowed" && stalePage.includes("changed"),
            `Stale pagination was accepted: ${stalePage}.`,
        );
        report.checks.push({
            stableTransitions: {
                promoted: firstStage.id,
                trashedThenRestored: secondStage.id,
                staleCatalogRejected: true,
            },
        });

        await run(
            `window.openCapture.action("open-item", ${JSON.stringify(firstStage.id)})`,
        );
        capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Restored draft did not create the capture editor.",
        );
        await until(
            () =>
                clip(
                    `window.captureDraftBridge.info().id === ${JSON.stringify(firstStage.id)} && document.querySelector("#selection_handles")?.hidden === false`,
                ),
            "First draft did not reopen in the capture editor.",
        );
        const reopened = await clip(`(() => ({
            info:window.captureDraftBridge.info(),
            size:[...document.querySelectorAll(".capture-dimensions input")].map(input=>Number(input.value)),
            toolbar:[...document.querySelectorAll("#quick_toolbar [data-capture-action]")].map(node=>node.dataset.captureAction),
            reduced:document.body.classList.contains("capture-motion-reduced")
        }))()`);
        assert(
            Math.abs(reopened.size[0] - firstDraft.rect.width) <= 1 &&
                Math.abs(reopened.size[1] - firstDraft.rect.height) <= 1,
            `Reopened selection rect changed: ${JSON.stringify({ expected: firstDraft.rect, actual: reopened.size })}.`,
        );
        const restaged = await clip("window.captureDraftBridge.stage()");
        const reopenedDraft = await run(
            `window.openCapture.getDraft(${JSON.stringify(firstStage.id)})`,
        );
        assert(
            restaged.id === firstStage.id &&
                restaged.revision > firstStage.revision &&
                dataObjects(reopenedDraft).length ===
                    dataObjects(firstDraft).length,
            "Reopening and flushing did not preserve editable Fabric state.",
        );

        await clip(`(() => {
            document.querySelector('#quick_toolbar [data-capture-action="more"]').click();
            document.querySelector('#capture_tools [data-capture-action="textselect"]').click();
        })()`);
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_text_layer .capture-text-box").length > 0',
                ),
            "Actual OCR did not create on-image text boxes.",
            600,
        );
        const ocrBoxes =
            await clip(`(() => [...document.querySelectorAll("#capture_text_layer .capture-text-box")].map(node=>({
            text:node.getAttribute("data-title"), left:node.style.left, top:node.style.top,
            width:node.style.width, height:node.style.height
        })))()`);
        assert(
            ocrBoxes.some((box) =>
                /example|query|target/i.test(box.text ?? ""),
            ),
            `OCR boxes did not contain recognizable fixture text: ${JSON.stringify(ocrBoxes)}.`,
        );
        await shot(capture, "on-image-ocr-boxes");
        await clip(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
        );
        await clip(`(() => {
            document.querySelector('#quick_toolbar [data-capture-action="more"]').click();
            document.querySelector('#capture_tools [data-capture-action="redact"]').click();
        })()`);
        await until(
            () =>
                clip(`(() => {
                    const review=document.querySelector("#capture_redact_review");
                    const status=document.querySelector(".capture-workspace-status");
                    return (review && review.open) || (status && !status.hidden && (status.classList.contains("has-error") || /찾지 못|변경되었습니다/.test(status.textContent)));
                })()`),
            "Smart-redact review did not return a visible result.",
            600,
        );
        const redactReview = await clip(`(() => {
            const dialog=document.querySelector("#capture_redact_review");
            const rect=dialog.getBoundingClientRect();
            const cs=getComputedStyle(dialog);
            const kids=[...dialog.children].map(k=>({tag:k.tagName,cls:k.className,h:k.getBoundingClientRect().height}));
            return {open:dialog.open, candidates:dialog.querySelectorAll(".capture-review-line").length,
                rect:{w:rect.width,h:rect.height},
                computed:{display:cs.display,height:cs.height,minHeight:cs.minHeight,maxHeight:cs.maxHeight,position:cs.position,alignItems:cs.alignItems,flexDirection:cs.flexDirection},
                kids,
                status:document.querySelector(".capture-workspace-status").textContent};
        })()`);
        assert(
            redactReview.open && redactReview.candidates > 0,
            `Fixture email was not offered for redaction review: ${JSON.stringify(redactReview)}.`,
        );
        assert(
            !redactReview.rect || redactReview.rect.h <= 400,
            `Redact review dialog is oversized for ${redactReview.candidates} candidates: ${JSON.stringify(redactReview)}.`,
        );
        await shot(capture, "redaction-candidate-review");
        await clip(
            'document.querySelector("#capture_redact_review .capture-review-actions button").click()',
        );
        report.checks.push({
            actualOcr: {
                boxes: ocrBoxes,
                redactionCandidates: redactReview.candidates,
            },
        });

        const gestureOrigin = {
            x: Math.round(photo.x + photo.width * 0.51),
            y: Math.round(photo.y + photo.height * 0.46),
        };
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            ...gestureOrigin,
        });
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "right",
            clickCount: 1,
            ...gestureOrigin,
        });
        await until(
            () =>
                clip(
                    'document.querySelector("#radial_menu")?.style.display === "block" && document.querySelectorAll(".radial_item").length === 7',
                ),
            "Right-button radial menu did not open.",
        );
        await clip(
            `window.__pm=[];["pointermove","pointerup","pointerdown"].forEach(t=>document.addEventListener(t,e=>window.__pm.push({t,b:e.buttons,pid:e.pointerId,x:e.clientX,y:e.clientY}),true))`,
        );
        const radialOrder = await clip(
            '[...document.querySelectorAll(".radial_item")].map(node=>node.dataset.captureAction)',
        );
        assert(
            radialOrder.join(",") ===
                "compare,draw,stage,textselect,redact,ding,more",
            `Editor radial menu ignored configured order: ${JSON.stringify(radialOrder)}.`,
        );
        const radialPaging = await clip(`(() => {
            const dots=()=>[...document.querySelectorAll("#radial_menu [data-radial-page]")];
            const active=()=>dots().findIndex(node=>node.getAttribute("aria-current")==="page");
            const items=()=>document.querySelectorAll("#radial_menu .radial_item").length;
            const order=()=>[...document.querySelectorAll("#radial_menu .radial_item")].map(node=>node.dataset.captureAction);
            const clickMore=()=>document.querySelector('#radial_menu .radial_item[data-capture-action="more"]').click();
            const page0={dots:dots().length,active:active(),items:items()};
            clickMore();
            const page1={active:active(),items:items()};
            clickMore();
            const page2={active:active(),items:items()};
            clickMore();
            const back={active:active(),items:items(),order:order()};
            return {page0,page1,page2,back};
        })()`);
        assert(
            radialPaging.page0.dots === 3 &&
                radialPaging.page0.active === 0,
            `Radial page indicator missing on the primary page: ${JSON.stringify(radialPaging)}.`,
        );
        assert(
            radialPaging.page1.active === 1 &&
                radialPaging.page1.items === 8 &&
                radialPaging.page2.active === 2 &&
                radialPaging.page2.items >= 7,
            `Radial paging did not advance the active dot: ${JSON.stringify(radialPaging)}.`,
        );
        assert(
            radialPaging.back.active === 0 &&
                radialPaging.back.order.join(",") ===
                    "compare,draw,stage,textselect,redact,ding,more",
            `Radial did not wrap back to the primary page: ${JSON.stringify(radialPaging)}.`,
        );
        report.checks.push({ radialPaging });
        const drawTarget =
            await clip(`(() => { const node=document.querySelector('.radial_item[data-capture-action="draw"]');
            const rect=node.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2),animation:getComputedStyle(node).animationName}; })()`);
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            x: drawTarget.x,
            y: drawTarget.y,
            modifiers: ["rightButtonDown"],
        });
        const gestureProbe = await until(
            () =>
                clip(
                    `(()=>{const hit=document.querySelector(".radial_item[data-capture-action=draw]")?.classList.contains("is-gesture-target");return hit?{hit,pm:window.__pm}:null})()`,
                ),
            "Right-hold gesture did not highlight its nearest tool.",
            30,
        ).catch(async () => {
            report.gestureDebug = await clip(
                `({items:document.querySelectorAll(".radial_item").length,display:document.querySelector("#radial_menu")?.style.display,pm:window.__pm})`,
            );
            return null;
        });
        assert(gestureProbe, "Right-hold gesture did not highlight its nearest tool.");
        assert(
            drawTarget.animation === "none",
            `Reduced motion left radial animation enabled: ${drawTarget.animation}.`,
        );
        await shot(capture, "right-hold-radial");
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "right",
            clickCount: 1,
            x: drawTarget.x,
            y: drawTarget.y,
        });
        await until(
            () =>
                clip(
                    'document.querySelector("#draw_bar") && getComputedStyle(document.querySelector("#draw_bar")).opacity === "1"',
                ),
            "Right-hold release did not execute the highlighted annotation tool.",
        );
        await shot(capture, "reopened-editable-draft");
        report.checks.push({
            editableRecovery: {
                id: firstStage.id,
                initialRevision: firstStage.revision,
                reopenedRevision: restaged.revision,
                rect: firstDraft.rect,
                fabricObjects: dataObjects(reopenedDraft).length,
                source: reopenedDraft.source,
            },
            multiRegion: {
                ids: [firstStage.id, secondStage.id],
                distinct: firstStage.id !== secondStage.id,
            },
            gesture: {
                radialOrder,
                highlighted: "draw",
                releaseExecuted: true,
                reducedMotionAnimation: drawTarget.animation,
                syntheticRendererInput: true,
            },
        });

        assert(
            !rendererErrors.length,
            `Renderer errors occurred: ${JSON.stringify(rendererErrors)}`,
        );
        fs.writeFileSync(
            recoveryPlanPath,
            JSON.stringify(
                {
                    firstId: firstStage.id,
                    secondId: secondStage.id,
                    revision: reopenedDraft.revision,
                    rect: reopenedDraft.rect,
                    fabricObjects: dataObjects(reopenedDraft).length,
                    source: reopenedDraft.source,
                },
                null,
                2,
            ),
        );
        report.phaseOneOk = true;
        report.ok = false;
        fs.writeFileSync(phaseOneReportPath, JSON.stringify(report, null, 2));
        console.log("CAPTURE_WORKSPACE_PHASE_ONE", JSON.stringify(report));
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        report.ok = false;
        report.failure = String(error.stack || error);
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.error("CAPTURE_WORKSPACE_QA_FAILED", report.failure);
        clearTimeout(timeout);
        app.exit(1);
    }
});
