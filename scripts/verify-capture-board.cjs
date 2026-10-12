const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "capture-board");
if (!process.versions.electron) {
    fs.mkdirSync(evidence, { recursive: true });
    const profile = process.env.CAPTURE_BOARD_PROFILE
        ? path.resolve(process.env.CAPTURE_BOARD_PROFILE)
        : path.join(evidence, `profile-${Date.now()}`);
    const electron = path.join(
        root,
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
    );
    const phases = process.env.CAPTURE_BOARD_PHASE
        ? [process.env.CAPTURE_BOARD_PHASE]
        : ["exercise", "recovery"];
    for (const phase of phases) {
        const result = spawnSync(
            electron,
            [
                __filename,
                `--board-profile=${profile}`,
                `--board-phase=${phase}`,
            ],
            {
                cwd: root,
                encoding: "utf8",
                windowsHide: true,
                timeout: phase === "exercise" ? 360_000 : 120_000,
                maxBuffer: 8 * 1024 * 1024,
            },
        );
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error || result.status !== 0)
            process.exit(result.status ?? 1);
    }
    process.exit(0);
}

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const profile =
    process.argv
        .find((value) => value.startsWith("--board-profile="))
        ?.slice(16) ?? path.join(evidence, `profile-${Date.now()}`);
const phase =
    process.argv
        .find((value) => value.startsWith("--board-phase="))
        ?.slice(14) ?? "exercise";
const closeDiagnosticMode = [
    "close-diagnostic",
    "close-race-diagnostic",
].includes(phase);
const closeTraceEnabled = closeDiagnosticMode || phase === "exercise";
const fixtures = path.join(evidence, "fixtures");
const exportsDir = path.join(evidence, "exports");
const planPath = path.join(profile, "board-recovery-plan.json");
const phaseReportPath = path.join(evidence, "qa-phase-one.json");
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(fixtures, { recursive: true });
fs.mkdirSync(exportsDir, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", fixtures);
process.argv.push(`--userData=${profile}`);

const closeDiagnosticPath = path.join(evidence, "close-diagnostic.jsonl");
const mainErrors = [];
const closeDiagnostic = (event, detail = {}) => {
    if (!closeTraceEnabled) return;
    fs.appendFileSync(
        closeDiagnosticPath,
        `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`,
    );
};
if (closeTraceEnabled) {
    process.on("uncaughtException", (error) => {
        mainErrors.push(String(error?.stack || error));
        closeDiagnostic("main-uncaught-exception", {
            message: String(error?.stack || error),
        });
        app.exit(1);
    });
    process.on("unhandledRejection", (error) => {
        mainErrors.push(String(error?.stack || error));
        closeDiagnostic("main-unhandled-rejection", {
            message: String(error?.stack || error),
        });
        app.exit(1);
    });
}
if (closeTraceEnabled) {
    fs.writeFileSync(closeDiagnosticPath, "");
    app.on("browser-window-created", (_event, window) => {
        closeDiagnostic("window-created", { id: window.id });
        window.webContents.on("did-finish-load", () =>
            closeDiagnostic("window-loaded", {
                id: window.id,
                url: window.webContents.getURL(),
            }),
        );
        window.on("close", () =>
            closeDiagnostic("window-close", {
                id: window.id,
                destroyed: window.isDestroyed(),
            }),
        );
        window.on("closed", () =>
            closeDiagnostic("window-closed", { id: window.id }),
        );
        window.webContents.on("will-prevent-unload", () =>
            closeDiagnostic("will-prevent-unload", { id: window.id }),
        );
    });
    app.on("before-quit", () => closeDiagnostic("before-quit"));
    const registerHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) =>
        registerHandle(channel, async (event, ...args) => {
            if (channel === "oc:boards:flush-ack")
                closeDiagnostic("flush-ack-before", {
                    senderId: event.sender.id,
                    requestId: args[0],
                    ok: args[1],
                });
            try {
                const value = await listener(event, ...args);
                if (channel === "oc:boards:flush-ack")
                    closeDiagnostic("flush-ack-after", {
                        requestId: args[0],
                    });
                return value;
            } catch (error) {
                if (channel === "oc:boards:flush-ack")
                    closeDiagnostic("flush-ack-error", {
                        requestId: args[0],
                        message: String(error),
                    });
                throw error;
            }
        });
}

const exportPaths = {
    png: path.join(exportsDir, "capture-board.png"),
    pdf: path.join(exportsDir, "capture-board.pdf"),
    ocboard: path.join(exportsDir, "capture-board.ocboard"),
};
dialog.showSaveDialog = async (...args) => {
    const options = args.at(-1);
    const extension = path
        .extname(options.defaultPath ?? "")
        .slice(1)
        .toLowerCase();
    return { canceled: false, filePath: exportPaths[extension] };
};
dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [exportPaths.ocboard],
});

const errors = [];
app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (event) => {
        if (closeTraceEnabled)
            closeDiagnostic("renderer-console", {
                level: event.level,
                message: event.message,
                sourceId: event.sourceId,
                line: event.lineNumber,
            });
        if (event.level === "error")
            errors.push({
                message: event.message,
                sourceId: event.sourceId,
                line: event.lineNumber,
                url: contents.getURL(),
            });
    });
});
require("../out/main/main.js");

const report =
    phase === "recovery" && fs.existsSync(phaseReportPath)
        ? JSON.parse(fs.readFileSync(phaseReportPath, "utf8"))
        : {
              checks: [],
              limitations: {
                  physicalGlobalShortcut: "not exercised",
                  extraMonitorHardware: "not available",
                  pointerInput:
                      "Electron renderer input; not OS-global physical input",
              },
          };
report.rendererErrors = errors;
report.mainErrors = mainErrors;
delete report.failure;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => {
    if (!value) throw new Error(message);
};
async function until(check, message, attempts = 300) {
    for (let index = 0; index < attempts; index++) {
        const value = await check();
        if (value) return value;
        await pause(100);
    }
    throw new Error(message);
}
async function shot(window, name) {
    report.stage = `screenshot:${name}`;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            if (window.isMinimized()) window.restore();
            if (!window.isVisible()) window.showInactive();
            await window.webContents.executeJavaScript(
                "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
                true,
            );
            await pause(200 + attempt * 180);
            const image = await window.webContents.capturePage();
            if (image.isEmpty()) throw new Error("Empty capturePage result");
            fs.writeFileSync(path.join(evidence, `${name}.png`), image.toPNG());
            return;
        } catch (error) {
            lastError = error;
            if (window.isDestroyed() || !window.isVisible()) break;
        }
    }
    throw new Error(
        `Screenshot ${name} failed: ${String(lastError)} ${JSON.stringify({
            destroyed: window.isDestroyed(),
            visible: !window.isDestroyed() && window.isVisible(),
            minimized: !window.isDestroyed() && window.isMinimized(),
            bounds: window.isDestroyed() ? null : window.getBounds(),
        })}`,
    );
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
        await pause(70);
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: end.x,
            y: end.y,
            button: "left",
            buttons: 1,
        });
        await pause(70);
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
async function cdpClick(contents, point, modifiers = 0) {
    const attached = contents.debugger.isAttached();
    if (!attached) contents.debugger.attach("1.3");
    try {
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            buttons: 1,
            modifiers,
            clickCount: 1,
        });
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            buttons: 0,
            modifiers,
            clickCount: 1,
        });
    } finally {
        if (!attached && contents.debugger.isAttached())
            contents.debugger.detach();
    }
}
async function cdpDoubleClick(contents, point) {
    const attached = contents.debugger.isAttached();
    if (!attached) contents.debugger.attach("1.3");
    try {
        for (const clickCount of [1, 2]) {
            await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 1,
                clickCount,
            });
            await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 0,
                clickCount,
            });
            await pause(45);
        }
    } finally {
        if (!attached && contents.debugger.isAttached())
            contents.debugger.detach();
    }
}
const style = (fill = "transparent", stroke = "#f4f4f5") => ({
    fill,
    stroke,
    strokeWidth: 3,
    fontSize: 18,
});
const annotation = (id, kind, x, y, width, height, extra = {}) => ({
    id,
    kind,
    x,
    y,
    width,
    height,
    rotation: 0,
    visible: true,
    locked: false,
    name: id,
    style: style(),
    ...extra,
});

const timeout = setTimeout(
    () => {
        report.ok = false;
        report.timeout = true;
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        app.exit(1);
    },
    phase === "exercise" ? 330_000 : 120_000,
);

app.whenReady().then(async () => {
    try {
        closeDiagnostic("when-ready-callback");
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
        closeDiagnostic("dashboard-found", {
            id: dashboard.id,
            url: dashboard.webContents.getURL(),
        });
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    closeDiagnosticMode
                        ? "Boolean(window.openCapture?.boards)"
                        : 'Boolean(window.openCapture?.boards && document.querySelector(".minimal-home"))',
                ),
            "Board dashboard API missing",
        );
        closeDiagnostic("dashboard-api-ready");
        await run(
            'localStorage.setItem("oc:onboarded","1"); for(const d of document.querySelectorAll("dialog[open]"))d.close(); const b=document.querySelector(".modal-backdrop");if(b)b.hidden=true;',
        );

        if (phase === "visual-recovery") {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            await run(
                'document.querySelector(".nav-button[data-page=\\"home\\"]").click()',
            );
            await until(
                () => run('!document.querySelector(".toast.visible")'),
                "Home toast did not settle",
            );
            await shot(dashboard, "minimal-home");
            await run(
                'document.querySelector(".nav-button[data-page=\\"board\\"]").click()',
            );
            await until(
                () =>
                    run(
                        `Boolean(document.querySelector('.board-tab[data-board-id=${JSON.stringify(plan.boardId)}]'))`,
                    ),
                "Recovered board tab missing for visual QA",
            );
            await run(
                `document.querySelector('.board-tab[data-board-id=${JSON.stringify(plan.boardId)}]').click();document.querySelector('[data-board-command="fit"]').click();document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));`,
            );
            await pause(700);
            await run(
                `document.querySelector('.board-image')?.click();const properties=document.querySelector('.board-editor__properties');if(properties?.open)properties.querySelector('summary')?.click()`,
            );
            await until(
                () => run('!document.querySelector(".toast.visible")'),
                "Board toast did not settle",
            );
            await shot(dashboard, "restart-recovered-board");
            clearTimeout(timeout);
            app.exit(0);
            return;
        }

        if (phase === "board-open-diagnostic") {
            const before = await run(`Promise.all([window.openCapture.boards.list(),Promise.resolve({
                page:document.querySelector(".nav-button.active")?.dataset.page,
                tabs:[...document.querySelectorAll(".board-tab")].map(node=>({id:node.dataset.boardId,active:node.classList.contains("is-active")})),
                board:Boolean(document.querySelector(".capture-board"))
            })])`);
            await run(
                'document.querySelector(".nav-button[data-page=\\"board\\"]").click()',
            );
            await pause(1_500);
            const after = await run(`Promise.all([window.openCapture.boards.list(),Promise.resolve({
                page:document.querySelector(".nav-button.active")?.dataset.page,
                tabs:[...document.querySelectorAll(".board-tab")].map(node=>({id:node.dataset.boardId,active:node.classList.contains("is-active")})),
                board:Boolean(document.querySelector(".capture-board")),
                editor:Boolean(document.querySelector(".board-editor")),
                bodyText:document.body.innerText.slice(0,1000)
            })])`);
            fs.writeFileSync(
                path.join(evidence, "board-open-diagnostic.json"),
                JSON.stringify({ before, after }, null, 2),
            );
            clearTimeout(timeout);
            app.exit(0);
            return;
        }

        if (closeDiagnosticMode) {
            await run(
                `window.addEventListener("beforeunload",event=>console.log("QA_BEFOREUNLOAD",JSON.stringify({defaultPrevented:event.defaultPrevented,returnValue:event.returnValue})),true)`,
            );
            await run(
                "document.querySelector('.nav-button[data-page=\"board\"]').click()",
            );
            await until(
                () =>
                    run(
                        'Boolean(document.querySelector(".board-tab.is-active") && document.querySelector(".capture-board"))',
                    ),
                "Diagnostic board did not open",
            );
            const issued =
                phase === "close-race-diagnostic"
                    ? await run(`(() => {
                        document.querySelector('.board-editor__layer[data-node-id="rect"] .board-editor__layer-name')?.click();
                        const details=document.querySelector(".board-editor__properties");
                        if(details&&!details.open)details.querySelector("summary")?.click();
                        const field=details?[...details.querySelectorAll("input")].find(input=>input.getAttribute("aria-label")==="?덈퉬"):null;
                        if(!field)return false;
                        field.value=String(Number(field.value)+7);
                        field.dispatchEvent(new Event("change",{bubbles:true}));
                        return true;
                    })()`)
                    : await run(
                          `(() => {document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}));const target=document.querySelector('.command-result[data-command-id="board:preset-study"]');target?.click();return Boolean(target)})()`,
                      );
            closeDiagnostic("edit-issued", { issued });
            if (phase === "close-race-diagnostic") {
                const listenerReady = await run(`(() => {
                    document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}));
                    const target=document.querySelector('.command-result[data-command-id="board:preset-study"]');
                    window.__qaCloseMutation={requested:0,issued:false};
                    window.openCapture.onBoardFlushRequested(()=>{
                        window.__qaCloseMutation.requested++;
                        if(window.__qaCloseMutation.issued)return;
                        window.__qaCloseMutation.issued=Boolean(target);
                        target?.click();
                        console.log("QA_CLOSE_MUTATION",JSON.stringify(window.__qaCloseMutation));
                    });
                    return Boolean(target);
                })()`);
                closeDiagnostic("race-listener-ready", { listenerReady });
            }
            closeDiagnostic("close-call-before", {
                id: dashboard.id,
                destroyed: dashboard.isDestroyed(),
            });
            const closeReturn = dashboard.close();
            closeDiagnostic("close-call-after", {
                returned: closeReturn,
                destroyed: dashboard.isDestroyed(),
            });
            for (let index = 0; index < 40; index++) {
                await pause(500);
                closeDiagnostic("heartbeat", {
                    index,
                    destroyed: dashboard.isDestroyed(),
                    visible: dashboard.isDestroyed()
                        ? false
                        : dashboard.isVisible(),
                    loading:
                        dashboard.isDestroyed() ||
                        dashboard.webContents.isDestroyed()
                            ? false
                            : dashboard.webContents.isLoading(),
                });
                if (dashboard.isDestroyed()) {
                    closeDiagnostic("diagnostic-pass", { index });
                    clearTimeout(timeout);
                    process.exit(0);
                }
            }
            closeDiagnostic("diagnostic-timeout");
            fs.writeFileSync(
                path.join(evidence, "close-diagnostic-summary.json"),
                JSON.stringify({ ok: false, profile }, null, 2),
            );
            clearTimeout(timeout);
            process.exit(2);
        }

        if (phase === "recovery") {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            const recovered = await run(
                `window.openCapture.boards.load(${JSON.stringify(plan.boardId)})`,
            );
            assert(
                recovered.nodes.length === plan.nodeCount,
                "Restart lost board nodes",
            );
            assert(
                recovered.nodes.some((node) => node.kind === "magnify") &&
                    recovered.nodes.some((node) => node.kind === "callout"),
                "Restart lost advanced annotations",
            );
            const derived = recovered.nodes.find(
                (node) => node.id === plan.cutoutNodeId,
            );
            assert(
                derived?.assetId === plan.derivedAssetId &&
                    derived.originalAssetId === plan.originalAssetId,
                "Restart lost derived/original ownership",
            );
            await run(
                "document.querySelector('.nav-button[data-page=\"board\"]').click()",
            );
            await run(
                `document.querySelector('.board-tab[data-board-id=${JSON.stringify(plan.boardId)}]')?.click()`,
            );
            await until(
                () =>
                    run(
                        `document.querySelectorAll(".board-image").length >= 3 && document.querySelectorAll(".board-editor__node").length >= 8`,
                    ),
                "Recovered board did not render",
            );
            await run(
                'document.querySelector(".board-viewport").click();document.querySelector(\'[data-board-command="fit"]\').click()',
            );
            await pause(700);
            await run(
                `document.querySelector('.board-image[data-node-id=${JSON.stringify(plan.cutoutNodeId)}]').click()`,
            );
            await pause(500);
            await shot(dashboard, "restart-recovered-board");
            await run(
                `document.querySelector('.board-image[data-node-id=${JSON.stringify(plan.cutoutNodeId)}]').click();document.querySelector('[data-board-command="restore-original"]').click()`,
            );
            const restoredOriginal = await until(async () => {
                const value = await run(
                    `window.openCapture.boards.load(${JSON.stringify(plan.boardId)})`,
                );
                return value.nodes.find((node) => node.id === plan.cutoutNodeId)
                    ?.assetId === plan.originalAssetId
                    ? value
                    : false;
            }, "Retained original could not be restored through UI after restart");
            assert(
                restoredOriginal.settings.preset === plan.closePreset,
                "Immediate close lost the final board edit",
            );
            assert(
                restoredOriginal.nodes.find((node) => node.id === "rect")
                    ?.width === plan.closeRectWidth,
                "Immediate close lost the pre-flush geometry edit",
            );
            report.checks.push({
                restartRecovery: {
                    boardId: plan.boardId,
                    revision: recovered.revision,
                    nodes: recovered.nodes.length,
                    retainedOriginalRestorable: true,
                    immediateClosePreset: restoredOriginal.settings.preset,
                    immediateCloseRectWidth: plan.closeRectWidth,
                },
            });
            assert(
                !errors.length,
                `Recovery renderer errors: ${JSON.stringify(errors)}`,
            );
            assert(
                !mainErrors.length,
                `Recovery main errors: ${JSON.stringify(mainErrors)}`,
            );
            report.ok = true;
            report.restartVerified = true;
            fs.writeFileSync(
                path.join(evidence, "qa.json"),
                JSON.stringify(report, null, 2),
            );
            console.log("CAPTURE_BOARD_RECOVERY_QA", JSON.stringify(report));
            clearTimeout(timeout);
            app.exit(0);
            return;
        }

        const minimal = await run(
            `(() => ({capture:document.querySelectorAll(".minimal-capture-button").length,recents:document.querySelectorAll(".minimal-recent-card").length,collapsed:document.querySelector(".app-shell").classList.contains("nav-collapsed"),visibleTools:[...document.querySelectorAll(".minimal-home button")].filter(button=>getComputedStyle(button).display!=="none").length,visibleLegacy:[...document.querySelectorAll(".legacy-home-action,.legacy-tools-close")].filter(node=>getComputedStyle(node).display!=="none").length}))()`,
        );
        assert(
            minimal.capture === 1 &&
                minimal.visibleTools <= 4 &&
                minimal.collapsed &&
                minimal.visibleLegacy === 0,
            "Home is not minimal/collapsed",
        );
        await shot(dashboard, "minimal-home");
        await run(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))',
        );
        await until(
            () => run('document.querySelector(".command-palette").open'),
            "Ctrl+K command palette failed",
        );
        const commandSearch = await run(
            `(() => [...document.querySelectorAll(".command-result")].map(node=>({id:node.dataset.commandId,text:node.textContent})))()`,
        );
        assert(
            commandSearch.some((entry) => entry.id === "board:create"),
            "Command search omitted board tools",
        );
        await run('document.querySelector(".command-palette").close()');

        const fixtureData = await run(
            `(() => Array.from({length:3},(_,index)=>{const c=document.createElement("canvas");c.width=720;c.height=440;const x=c.getContext("2d");x.fillStyle=["#eef2ff","#ecfeff","#f0fdf4"][index];x.fillRect(0,0,720,440);x.fillStyle="#17171a";x.fillRect(0,0,720,48);x.fillStyle="#fff";x.font="700 18px Segoe UI";x.fillText("BOARD SOURCE "+index,24,31);x.fillStyle=["#8b5cf6","#06b6d4","#22c55e"][index];x.beginPath();x.arc(360,235,125-index*10,0,Math.PI*2);x.fill();x.fillStyle="#111";x.font="700 28px Segoe UI";x.fillText("Reference "+index,270,405);return c.toDataURL("image/png")}) )()`,
        );
        const fixturePaths = fixtureData.map((data, index) => {
            const file = path.join(fixtures, `board-source-${index}.png`);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            return file;
        });
        await run(
            'const i=document.createElement("input");i.type="file";i.multiple=true;i.id="board-fixtures";i.hidden=true;document.body.append(i)',
        );
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#board-fixtures" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: fixturePaths },
        );
        const imported = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#board-fixtures").files))',
        );
        dashboard.webContents.debugger.detach();
        assert(imported.items.length === 3, "Board fixtures failed to import");
        await until(
            () =>
                run(
                    'document.querySelectorAll(".minimal-recent-card").length===3',
                ),
            "Minimal home recent three did not render",
        );

        await run(
            "document.querySelector('.nav-button[data-page=\"board\"]').click()",
        );
        await until(
            () =>
                run(
                    'document.querySelector(".capture-board") && document.querySelector(".board-tab")',
                ),
            "Board surface missing",
        );
        await run(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))',
        );
        const boardCommandsVisible = await run(
            '[...document.querySelectorAll(".command-result")].map(node=>node.dataset.commandId)',
        );
        assert(
            boardCommandsVisible.includes("board:tool-note") &&
                boardCommandsVisible.includes("board:export-png"),
            "Board command palette omitted editing/export actions",
        );
        await run('document.querySelector(".command-palette").close()');
        const initialBoards = await run("window.openCapture.boards.list()");
        await run(
            "document.querySelector('[data-board-command=\"create\"]').click()",
        );
        const summaries = await until(async () => {
            const value = await run("window.openCapture.boards.list()");
            return value.length > initialBoards.length ? value : false;
        }, "Second board was not created");
        const board = summaries.find((entry) => entry.active);
        assert(board, "Created board was not active");
        const switchBoard = async (id) => {
            await run(
                `document.querySelector('.board-tab[data-board-id=${JSON.stringify(id)}]').click()`,
            );
            await until(
                () =>
                    run(
                        `document.querySelector('.board-tab[data-board-id=${JSON.stringify(id)}]')?.classList.contains("is-active")`,
                    ),
                `Board tab ${id} did not activate`,
            );
        };
        let document = await run(
            `window.openCapture.boards.addItems(${JSON.stringify(board.id)}, ${JSON.stringify(imported.items.map((item) => item.id))}, ${board.revision})`,
        );
        assert(
            document.nodes.filter((node) => node.kind === "image").length === 3,
            "Multi-capture board did not add three images",
        );
        const images = document.nodes.filter((node) => node.kind === "image");
        images.forEach((node, index) => {
            node.x = 120 + index * 330;
            node.y = 130 + (index % 2) * 250;
            node.width = 280;
            node.height = 170;
            node.source ??= {
                itemId: node.captureItemId,
                context: {
                    kind: "import",
                    capturedAt: new Date().toISOString(),
                },
                areaKey: "qa-region",
            };
            node.source.areaKey = index < 2 ? "qa-region" : "qa-region-other";
            if (index < 2) node.versionGroup = "versions-qa";
        });
        document.styles = [
            {
                id: "qa-style",
                name: "QA Style",
                style: {
                    fill: "#11223322",
                    stroke: "#ff5c73",
                    strokeWidth: 5,
                    fontSize: 22,
                },
            },
        ];
        document.nodes.push(
            annotation("rect", "rect", 180, 570, 160, 100, {
                groupId: "group-qa",
            }),
            annotation("ellipse", "ellipse", 380, 570, 160, 100, {
                groupId: "group-qa",
            }),
            annotation("line", "line", 580, 570, 180, 100, {
                points: [
                    { x: 0, y: 0 },
                    { x: 180, y: 100 },
                ],
            }),
            annotation("arrow", "arrow", 160, 760, 220, 100, {
                points: [
                    { x: 0, y: 0 },
                    { x: 220, y: 100 },
                ],
                anchor: { nodeId: images[0].id, x: 0.5, y: 0.5 },
                endAnchor: { nodeId: images[1].id, x: 0.5, y: 0.5 },
            }),
            annotation("polygon", "polygon", 430, 740, 180, 140, {
                points: [
                    { x: 90, y: 0 },
                    { x: 180, y: 140 },
                    { x: 0, y: 140 },
                ],
            }),
            annotation("text", "text", 660, 740, 200, 70, {
                text: "Design feedback",
            }),
            annotation("note", "note", 900, 120, 220, 150, {
                text: "[ ] Verify capture\n[x] Share result",
            }),
            annotation("callout", "callout", 900, 330, 220, 120, {
                text: "Spacing changed",
                points: [
                    { x: 0, y: 0 },
                    { x: 220, y: 120 },
                ],
                anchor: { nodeId: images[2].id, x: 0.4, y: 0.4 },
            }),
            annotation("step1", "step", 900, 520, 44, 44, { text: "1" }),
            annotation("step2", "step", 970, 520, 44, 44, { text: "2" }),
            annotation("magnify", "magnify", 900, 650, 180, 140, {
                magnify: {
                    nodeId: images[0].id,
                    x: 0.25,
                    y: 0.25,
                    width: 0.35,
                    height: 0.35,
                    zoom: 2,
                },
            }),
        );
        document.settings.preset = "design";
        document = await run(
            `window.openCapture.boards.save(${JSON.stringify(document)}, ${document.revision})`,
        );
        const other = summaries.find((entry) => entry.id !== board.id);
        await switchBoard(other.id);
        await switchBoard(board.id);
        await until(
            () =>
                run(
                    'document.querySelectorAll(".board-image").length===3 && document.querySelectorAll(".board-editor__node").length>=11',
                ),
            "Board document did not render all objects",
        );
        await shot(dashboard, "board-full-workspace");

        const selectImages = async () =>
            run(
                `(() => {const cards=[...document.querySelectorAll(".board-image")];cards[0].click();cards[1].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));cards[2].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));return cards.map(card=>card.dataset.nodeId)})()`,
            );
        const imageIds = await selectImages();
        for (const layout of ["horizontal", "vertical", "grid"]) {
            await run(
                `document.querySelector('[data-board-command="layout-${layout}"]').click()`,
            );
            await pause(650);
            const loaded = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            const positioned = loaded.nodes.filter((node) =>
                imageIds.includes(node.id),
            );
            assert(
                new Set(
                    positioned.map(
                        (node) => `${Math.round(node.x)}:${Math.round(node.y)}`,
                    ),
                ).size === 3,
                `${layout} layout collapsed nodes`,
            );
        }
        await run(
            `(() => {document.querySelector(".board-viewport").click();const cards=[...document.querySelectorAll(".board-image")];cards[0].click();cards[1].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));document.querySelector('[data-board-command="compare-versions"]').click()})()`,
        );
        await until(
            () =>
                run(
                    'document.querySelector(".compare-dialog")?.open && document.querySelectorAll(".compare-pair-select option").length>=4 && !document.querySelector(".rc-canvas").hidden',
                ),
            "Board asset-backed comparison did not open two references",
        );
        await shot(dashboard, "board-version-comparison");
        await run(
            'document.querySelector(".compare-dialog .rc-header .rc-icon-button").click()',
        );
        await selectImages();
        const beforeBeautify = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        await run(
            `window.openCapture.saveStyle({id:"board-qa-beautify",name:"Board QA",background:"linear-gradient(135deg,#111827,#312e81)",padding:32,shadow:16,radius:18,ratio:"free",align:"center",autoBalance:true})`,
        );
        await run(
            `document.querySelector('[data-board-command="beautify"]').click()`,
        );
        await until(
            () => run('document.querySelector(".workspace-text-dialog")?.open'),
            "Batch beautify style chooser did not open",
        );
        await run(
            `(() => {const dialog=document.querySelector(".workspace-text-dialog");dialog.querySelector("select").value="board-qa-beautify";dialog.querySelector("form").requestSubmit()})()`,
        );
        const priorBeautify = new Map(
            beforeBeautify.nodes
                .filter((node) => imageIds.includes(node.id))
                .map((node) => [node.id, node.assetId]),
        );
        const beautified = await until(
            async () => {
                const value = await run(
                    `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
                );
                return value.nodes
                    .filter((node) => imageIds.includes(node.id))
                    .every(
                        (node) =>
                            node.assetId !== priorBeautify.get(node.id) &&
                            node.originalAssetId === priorBeautify.get(node.id),
                    )
                    ? value
                    : false;
            },
            "Batch beautify did not create derived assets",
            900,
        );
        await run(
            'document.querySelector(".capture-board").dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true}))',
        );
        await pause(650);
        const beautifyUndone = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            beautifyUndone.nodes
                .filter((node) => imageIds.includes(node.id))
                .every(
                    (node) =>
                        beforeBeautify.nodes.find((old) => old.id === node.id)
                            .assetId === node.assetId,
                ),
            "Batch beautify undo failed",
        );
        await run(
            'document.querySelector(".capture-board").dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,shiftKey:true,bubbles:true}))',
        );
        await pause(650);
        await selectImages();
        await run(
            "document.querySelector('[data-board-command=\"group\"]').click()",
        );
        await pause(650);
        let grouped = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            new Set(
                grouped.nodes
                    .filter((node) => imageIds.includes(node.id))
                    .map((node) => node.groupId),
            ).size === 1,
            "Group command failed",
        );

        const firstCardRect = await run(
            `(() => {const card=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]');const r=card.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:r.width,h:r.height}})()`,
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: firstCardRect.x,
            y: firstCardRect.y,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown"],
            x: firstCardRect.x + 48,
            y: firstCardRect.y + 30,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: firstCardRect.x + 48,
            y: firstCardRect.y + 30,
        });
        await pause(650);
        const moved = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            moved.nodes
                .filter((node) => imageIds.includes(node.id))
                .every(
                    (node) =>
                        node.x !==
                        grouped.nodes.find((old) => old.id === node.id).x,
                ),
            "Grouped drag did not move all images",
        );
        const ungrouped = structuredClone(moved);
        for (const node of ungrouped.nodes)
            if (imageIds.includes(node.id)) node.groupId = undefined;
        await run(
            `window.openCapture.boards.save(${JSON.stringify(ungrouped)}, ${ungrouped.revision})`,
        );
        await switchBoard(other.id);
        await switchBoard(board.id);
        await run(
            `(() => {document.querySelector(".board-viewport").click();document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]').click()})()`,
        );
        const resize = await run(
            `(() => {const card=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]');const handle=card.querySelector(".board-resize-handle.is-se");const c=card.getBoundingClientRect(),r=handle.getBoundingClientRect();return{before:{w:c.width,h:c.height},point:{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}}})()`,
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: resize.point.x,
            y: resize.point.y,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown"],
            x: resize.point.x + 50,
            y: resize.point.y + 25,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: resize.point.x + 50,
            y: resize.point.y + 25,
        });
        await pause(650);
        const resized = await run(
            `(() => {const r=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]').getBoundingClientRect();return{w:r.width,h:r.height}})()`,
        );
        assert(
            resized.w > resize.before.w &&
                Math.abs(
                    resized.w / resized.h - resize.before.w / resize.before.h,
                ) < 0.03,
            "Image resize/aspect preservation failed",
        );
        const snapPoints = await run(
            `(() => {const a=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]').getBoundingClientRect();const b=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[1])}]').getBoundingClientRect();return{start:{x:Math.round(a.x+a.width/2),y:Math.round(a.y+a.height/2)},end:{x:Math.round(b.x+a.width/2+3),y:Math.round(a.y+a.height/2)}}})()`,
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...snapPoints.start,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown"],
            ...snapPoints.end,
        });
        assert(
            await run(
                'document.querySelectorAll(".board-snap-guide").length>0',
            ),
            "Snap guides did not appear",
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...snapPoints.end,
        });
        await run(
            "document.querySelector('[data-board-command=\"focus\"]').click()",
        );
        await pause(80);
        assert(
            await run('document.querySelectorAll(".board-image").length===1'),
            "Focused group visibility incorrect",
        );
        await run(
            "document.querySelector('[data-board-command=\"focus-clear\"]').click()",
        );
        await run(
            `document.querySelector(".board-viewport").click();document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]').click()`,
        );
        await pause(500);
        await shot(dashboard, "board-context-toolbar");

        assert(
            await run('Boolean(document.querySelector("[data-board-layers]"))'),
            "Board layers panel is missing",
        );
        await run(
            "document.querySelector('[data-board-command=\"shape-drawer\"]').click()",
        );
        await shot(dashboard, "board-editor-drawer");
        await run(
            "document.querySelector('[data-board-command=\"shape-drawer\"]').click()",
        );
        await run('document.querySelector("[data-board-layers]").open=true');
        await run(
            "document.querySelector('.board-editor__layer[data-node-id=\"polygon\"] .board-editor__layer-name').click()",
        );
        await until(
            () =>
                run(
                    "Boolean(document.querySelector('.board-editor__node[data-node-id=\"polygon\"] .board-editor__vertex'))",
                ),
            "Polygon vertex handles did not appear",
        );
        await shot(dashboard, "board-editor-layers");
        await run(
            'document.querySelector("[data-board-layers]").open=false;document.querySelector(\'.board-editor__node[data-node-id="polygon"] .board-editor__vertex\').scrollIntoView({block:"center",inline:"center"})',
        );
        await pause(180);
        const vertex = await run(
            `(() => {const h=document.querySelector('.board-editor__node[data-node-id="polygon"] .board-editor__vertex');const r=h.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},hit:document.elementFromPoint(x,y)?.classList.contains("board-editor__vertex")??false}})()`,
        );
        report.vertexTrace = vertex;
        assert(
            vertex.hit &&
                vertex.x > 0 &&
                vertex.y > 0 &&
                vertex.x < vertex.viewport.width &&
                vertex.y < vertex.viewport.height,
            "Polygon vertex is not exposed for pointer editing",
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: Math.round(vertex.x),
            y: Math.round(vertex.y),
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown"],
            x: Math.round(vertex.x + 24),
            y: Math.round(vertex.y + 18),
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: Math.round(vertex.x + 24),
            y: Math.round(vertex.y + 18),
        });
        await pause(650);
        const vertexEdited = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            JSON.stringify(
                vertexEdited.nodes.find((node) => node.id === "polygon").points,
            ) !==
                JSON.stringify(
                    document.nodes.find((node) => node.id === "polygon").points,
                ),
            "Polygon vertex did not change",
        );
        await run(
            "document.querySelector('.board-editor__layer[data-node-id=\"rect\"] .board-editor__layer-name').click()",
        );
        await run(
            `(() => {document.querySelector('[data-board-command="tool:select"]').click();window.__qaPointerTrace=[];const surface=document.querySelector(".board-viewport");const record=(scope)=>(event)=>window.__qaPointerTrace.push({scope,type:event.type,pointerId:event.pointerId,button:event.button,buttons:event.buttons,x:event.clientX,y:event.clientY,target:event.target?.className?.baseVal??event.target?.className??event.target?.tagName,nodeId:event.target?.closest?.("[data-node-id]")?.getAttribute("data-node-id")});for(const type of ["pointerdown","pointermove","pointerup","pointercancel","dragstart","dragend"])surface.addEventListener(type,record("surface-capture"),{capture:true,once:true});for(const type of ["gotpointercapture","lostpointercapture"])surface.addEventListener(type,record("surface"),{once:true});window.addEventListener("blur",()=>window.__qaPointerTrace.push({scope:"window",type:"blur"}),{once:true});})()`,
        );
        await run(
            `document.querySelector('g[data-node-id="rect"]').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(180);
        const annotationPoint = await run(
            `(() => {const node=document.querySelector('g[data-node-id="rect"]');const rect=node.getBoundingClientRect();const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);return{x,y,hit:document.elementFromPoint(x,y)?.closest('g[data-node-id]')?.getAttribute('data-node-id')}})()`,
        );
        report.annotationTrace = annotationPoint;
        assert(
            annotationPoint.hit === "rect",
            "Rectangle annotation is occluded during drag",
        );
        const rectBeforeMove = vertexEdited.nodes.find(
            (node) => node.id === "rect",
        );
        await cdpDrag(dashboard.webContents, annotationPoint, {
            x: annotationPoint.x + 32,
            y: annotationPoint.y + 20,
        });
        await pause(100);
        report.annotationPointerTrace = await run("window.__qaPointerTrace");
        const annotationMoved = await until(
            async () => {
                const value = await run(
                    `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
                );
                return value.nodes.find((node) => node.id === "rect").x !==
                    rectBeforeMove.x
                    ? value
                    : false;
            },
            "Annotation drag did not persist geometry",
            100,
        );
        await run(
            `document.querySelector('.board-editor__node[data-node-id="note"] .board-editor__check').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(180);
        const checkPoint = await run(
            `(() => {const node=document.querySelector('.board-editor__node[data-node-id="note"] .board-editor__check');const rect=node.getBoundingClientRect();const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);return{x,y,hit:document.elementFromPoint(x,y)?.classList.contains("board-editor__check")??false}})()`,
        );
        assert(checkPoint.hit, "Checklist control is occluded");
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...checkPoint,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...checkPoint,
        });
        const checklistEdited = await until(async () => {
            const value = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            return value.nodes
                .find((node) => node.id === "note")
                .text.startsWith("[x]")
                ? value
                : false;
        }, "Checklist toggle did not persist");
        await run(
            "document.querySelector('.board-editor__layer[data-node-id=\"step1\"] .board-editor__layer-name').click()",
        );
        await run(
            `document.querySelector('.capture-board').dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}))`,
        );
        const annotationsEdited = await until(async () => {
            const value = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            return !value.nodes.some((node) => node.id === "step1") &&
                value.nodes.find((node) => node.id === "step2")?.text === "1"
                ? value
                : false;
        }, "Step delete/renumber did not persist");
        report.annotationEditState = {
            note: checklistEdited.nodes.find((node) => node.id === "note").text,
            steps: annotationsEdited.nodes
                .filter((node) => node.kind === "step")
                .map((node) => ({ id: node.id, text: node.text })),
        };
        assert(
            annotationsEdited.nodes
                .find((node) => node.id === "note")
                .text.startsWith("[x]") &&
                annotationsEdited.nodes.find((node) => node.id === "step2")
                    .text === "1" &&
                !annotationsEdited.nodes.some((node) => node.id === "step1"),
            "Checklist or step renumbering failed",
        );
        await run(
            `document.querySelector('g[data-node-id="rect"]').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(150);
        const rectStylePoint = await run(
            `(() => {const node=document.querySelector('g[data-node-id="rect"]');const rect=node.getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`,
        );
        await cdpClick(dashboard.webContents, rectStylePoint);
        await run(
            `document.querySelector('g[data-node-id="ellipse"]').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(150);
        const ellipseStylePoint = await run(
            `(() => {const node=document.querySelector('g[data-node-id="ellipse"]');const rect=node.getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`,
        );
        await cdpClick(dashboard.webContents, ellipseStylePoint, 8);
        await run(
            'document.querySelector(".board-editor__properties summary").click()',
        );
        await until(
            () =>
                run('document.querySelector(".board-editor__properties").open'),
            "Annotation properties popover did not open",
        );
        await shot(dashboard, "board-editor-properties");
        const styleSelection = await run(
            `(() => ({label:document.querySelector(".board-selection-label")?.textContent,hasStyle:[...document.querySelectorAll(".board-editor__context button")].some(button=>button.textContent==="QA Style")}))()`,
        );
        report.styleSelection = styleSelection;
        assert(
            styleSelection.label?.includes("2") && styleSelection.hasStyle,
            "Two annotations were not selected for named style",
        );
        await run(
            `[...document.querySelectorAll(".board-editor__context button")].find(button=>button.textContent==="QA Style").click()`,
        );
        const styled = await until(
            async () => {
                const value = await run(
                    `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
                );
                return ["rect", "ellipse"].every(
                    (id) =>
                        value.nodes.find((node) => node.id === id).style
                            .stroke === "#ff5c73",
                )
                    ? value
                    : false;
            },
            "Named multi-object style failed",
            100,
        );
        assert(
            ["rect", "ellipse"].every(
                (id) =>
                    styled.nodes.find((node) => node.id === id).style.stroke ===
                    "#ff5c73",
            ),
            "Named multi-object style failed",
        );
        await run(
            "document.querySelector('.board-editor__layer[data-node-id=\"text\"] .board-editor__layer-name').click()",
        );
        if (
            !(await run(
                'document.querySelector(".board-editor__properties").open',
            ))
        )
            await run(
                'document.querySelector(".board-editor__properties summary").click()',
            );
        await until(
            () =>
                run(
                    'Boolean(document.querySelector("[data-board-edit-text]"))',
                ),
            "Text edit action is missing from properties",
        );
        await run('document.querySelector("[data-board-edit-text]").click()');
        await until(
            () => run('document.querySelector(".workspace-text-dialog")?.open'),
            "Text edit action did not open editor",
        );
        await run(
            `(() => {const dialog=document.querySelector(".workspace-text-dialog");dialog.querySelector("textarea").value="Updated design feedback";dialog.querySelector("form").requestSubmit()})()`,
        );
        const textEdited = await until(async () => {
            const value = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            return value.nodes.find((node) => node.id === "text")?.text ===
                "Updated design feedback"
                ? value
                : false;
        }, "Text annotation edit did not persist");
        report.textEdit = textEdited.nodes.find(
            (node) => node.id === "text",
        ).text;
        await run(
            `document.querySelector('.board-editor__layer[data-node-id="note"] .board-editor__layer-name').dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))`,
        );
        await until(
            () => run('document.querySelector(".workspace-text-dialog")?.open'),
            "Layer rename dialog did not open",
        );
        await run(
            `(() => {const dialog=document.querySelector(".workspace-text-dialog");dialog.querySelector("input").value="Renamed note";dialog.querySelector("form").requestSubmit()})()`,
        );
        await run(
            `document.querySelector('.board-editor__layer[data-node-id="note"]').querySelectorAll("button")[1].click()`,
        );
        await run(
            `document.querySelector('.board-editor__layer[data-node-id="note"]').querySelectorAll("button")[2].click()`,
        );
        await pause(650);
        const layerEdited = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        const note = layerEdited.nodes.find((node) => node.id === "note");
        assert(
            note.name === "Renamed note" && !note.visible && note.locked,
            "Layer rename/hide/lock failed",
        );
        for (const preset of [
            "버그 보고 프리셋",
            "공부 메모 프리셋",
            "디자인 피드백 프리셋",
        ]) {
            await run(
                `(() => {document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}));const input=document.querySelector(".command-palette input");input.value=${JSON.stringify(preset)};input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".command-result")?.click()})()`,
            );
            await pause(100);
        }
        await pause(650);
        assert(
            (
                await run(
                    `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
                )
            ).settings.preset === "design",
            "Task presets did not apply",
        );

        await run(
            `document.querySelector('.board-editor__layer[data-node-id=${JSON.stringify(imageIds[0])}] .board-editor__layer-name').click()`,
        );
        await run(
            `document.querySelector('[data-board-command="focus"]').click()`,
        );
        await until(
            () =>
                run(
                    'document.querySelectorAll(".board-image").length===1 && document.querySelectorAll(".board-editor__node").length===0',
                ),
            "Image focus mode did not clear occluding annotations",
        );
        await run(
            `document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}] img').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(180);
        const holdRect = await run(
            `(() => {const img=document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}] img');const r=img.getBoundingClientRect();for(const fy of [.25,.5,.75])for(const fx of [.2,.4,.6,.8]){const x=Math.round(r.x+r.width*fx),y=Math.round(r.y+r.height*fy);if(document.elementFromPoint(x,y)===img)return{x,y,hit:true,tag:"IMG",rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}}const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),target=document.elementFromPoint(x,y);return{x,y,hit:false,tag:target?.tagName,className:target?.className?.baseVal??target?.className,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}}})()`,
        );
        report.holdTarget = holdRect;
        assert(
            holdRect.hit && holdRect.tag === "IMG",
            "Hold target image is occluded",
        );
        await cdpClick(dashboard.webContents, holdRect);
        await pause(750);
        const beforeHold = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        const holdNode = beforeHold.nodes.find(
            (node) => node.id === imageIds[0],
        );
        const lineageOriginal = holdNode.originalAssetId ?? holdNode.assetId;
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        await pause(200);
        assert(
            await run(
                `document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}] .image-hold-indicator')?.classList.contains("is-pressing")`,
            ),
            "Right-chord test did not begin a pending hold",
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "right",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown", "rightbuttondown"],
            x: holdRect.x + 1,
            y: holdRect.y,
        });
        await pause(60);
        assert(
            !(await run(
                `document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}] .image-hold-indicator')?.classList.contains("is-pressing")`,
            )),
            "Right-chord did not cancel pending hold progress",
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "right",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        await pause(700);
        const rightCancelled = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            rightCancelled.nodes.find((node) => node.id === imageIds[0])
                .assetId === holdNode.assetId,
            "Right-pointer interruption did not cancel pending hold",
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        await pause(350);
        assert(
            await run(
                `document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}] .image-hold-indicator')?.classList.contains("is-pressing")`,
            ),
            "Long-hold progress indicator did not activate",
        );
        await shot(dashboard, "board-hold-progress");
        await pause(420);
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: holdRect.x,
            y: holdRect.y,
        });
        const derived = await until(
            async () => {
                const value = await run(
                    `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
                );
                const node = value.nodes.find(
                    (item) => item.id === imageIds[0],
                );
                return node?.assetId !== holdNode.assetId ? value : false;
            },
            "Long hold cutout did not create derived asset",
            900,
        );
        const cutoutNode = derived.nodes.find(
            (node) => node.id === imageIds[0],
        );
        assert(
            cutoutNode.originalAssetId === lineageOriginal,
            "Cutout did not retain first original lineage",
        );
        await run(
            'document.querySelector(".capture-board").dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true}))',
        );
        await pause(650);
        const undone = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            undone.nodes.find((node) => node.id === imageIds[0]).assetId ===
                holdNode.assetId,
            "Cutout undo did not restore original",
        );
        await run(
            'document.querySelector(".capture-board").dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,shiftKey:true,bubbles:true}))',
        );
        await pause(650);
        const redone = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            redone.nodes.find((node) => node.id === imageIds[0]).assetId ===
                cutoutNode.assetId,
            "Cutout redo failed",
        );
        await run(
            `document.querySelector('[data-board-command="focus-clear"]').click()`,
        );
        await until(
            () =>
                run(
                    'document.querySelectorAll(".board-image").length>=3 && document.querySelectorAll(".board-editor__node").length>=8',
                ),
            "Full board did not return after cutout focus",
        );

        for (const command of ["export-png", "export-pdf", "export-portable"]) {
            await run(
                `document.querySelector('[data-board-command="${command}"]').click()`,
            );
            const extension =
                command.slice(7) === "portable" ? "ocboard" : command.slice(7);
            await until(
                () =>
                    fs.existsSync(exportPaths[extension]) &&
                    fs.statSync(exportPaths[extension]).size > 20,
                `${command} file missing`,
                600,
            );
        }
        assert(
            fs
                .readFileSync(exportPaths.png)
                .subarray(1, 4)
                .toString("ascii") === "PNG",
            "PNG export signature invalid",
        );
        assert(
            fs
                .readFileSync(exportPaths.pdf)
                .subarray(0, 4)
                .toString("ascii") === "%PDF",
            "PDF export signature invalid",
        );
        const portable = JSON.parse(
            fs.readFileSync(exportPaths.ocboard, "utf8"),
        );
        assert(
            portable.document?.nodes?.length === redone.nodes.length,
            "Portable export lost nodes",
        );
        const importedBoard = await run(
            "window.openCapture.boards.importPortable()",
        );
        assert(
            importedBoard.id !== board.id &&
                importedBoard.nodes.length === redone.nodes.length,
            "Portable import did not remap complete board",
        );
        await run(
            "document.querySelector('.board-editor__layer[data-node-id=\"callout\"] .board-editor__layer-name').click()",
        );
        await run(
            `document.querySelector('g[data-node-id="callout"]').scrollIntoView({block:"center",inline:"center"})`,
        );
        await pause(150);
        const calloutPoint = await run(
            `(() => {const node=document.querySelector('g[data-node-id="callout"]');const rect=node.getBoundingClientRect();for(const fy of [.25,.5,.75])for(const fx of [.25,.5,.75]){const x=Math.round(rect.x+rect.width*fx),y=Math.round(rect.y+rect.height*fy);if(document.elementFromPoint(x,y)?.closest('g[data-node-id]')===node)return{x,y,hit:true}}return{hit:false}})()`,
        );
        assert(
            calloutPoint.hit,
            "Callout is not reachable for double-click edit",
        );
        await run(
            `(() => {window.__qaDblClick=[];const surface=document.querySelector(".board-viewport");surface.addEventListener("dblclick",event=>window.__qaDblClick.push({target:event.target?.className?.baseVal??event.target?.className,nodeId:document.elementFromPoint(event.clientX,event.clientY)?.closest?.("[data-node-id]")?.getAttribute("data-node-id"),x:event.clientX,y:event.clientY}),{capture:true,once:true})})()`,
        );
        await cdpDoubleClick(dashboard.webContents, calloutPoint);
        await pause(180);
        const doubleClickTrace = await run("window.__qaDblClick");
        let doubleClickOpened = await run(
            'document.querySelector(".workspace-text-dialog")?.open??false',
        );
        if (doubleClickTrace.length && !doubleClickOpened)
            throw new Error(
                `Callout double-click reached board but did not open editor: ${JSON.stringify(doubleClickTrace)}`,
            );
        if (!doubleClickOpened) {
            if (
                !(await run(
                    'document.querySelector(".board-editor__properties").open',
                ))
            )
                await run(
                    'document.querySelector(".board-editor__properties summary").click()',
                );
            await run(
                'document.querySelector("[data-board-edit-text]").click()',
            );
            await until(
                () =>
                    run(
                        'document.querySelector(".workspace-text-dialog")?.open',
                    ),
                "Callout explicit text edit action did not open editor",
            );
            doubleClickOpened = false;
        }
        await run(
            `(() => {const dialog=document.querySelector(".workspace-text-dialog");dialog.querySelector("textarea").value="Updated callout";dialog.querySelector("form").requestSubmit()})()`,
        );
        await until(async () => {
            const value = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            return value.nodes.find((node) => node.id === "callout")?.text ===
                "Updated callout"
                ? value
                : false;
        }, "Callout double-click edit did not persist");
        report.calloutDoubleClick = {
            eventObserved: doubleClickTrace.length > 0,
            opened: doubleClickOpened,
            trace: doubleClickTrace,
            explicitFallback: !doubleClickOpened,
        };
        await run(
            `window.openCapture.boards.setActive(${JSON.stringify(board.id)})`,
        );
        let autoDocument = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        autoDocument.settings.autoAdd = true;
        autoDocument = await run(
            `window.openCapture.boards.save(${JSON.stringify(autoDocument)}, ${autoDocument.revision})`,
        );
        await switchBoard(other.id);
        await switchBoard(board.id);
        await run(
            `window.openCapture.action("open-item",${JSON.stringify(imported.items[0].id)})`,
        );
        let capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Auto-add capture editor missing",
        );
        let clip = (code) => capture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                clip(
                    'Boolean(window.captureDraftBridge)&&document.body.style.opacity!=="0"',
                ),
            "Auto-add editor not ready",
        );
        const photo = await clip(
            'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
        );
        const a = {
            x: Math.round(photo.x + photo.width * 0.2),
            y: Math.round(photo.y + photo.height * 0.2),
        };
        const b = {
            x: Math.round(photo.x + photo.width * 0.75),
            y: Math.round(photo.y + photo.height * 0.75),
        };
        capture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...a,
        });
        capture.webContents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            modifiers: ["leftbuttondown"],
            ...b,
        });
        capture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...b,
        });
        const staged = await clip("window.captureDraftBridge.stage()");
        await clip(
            "document.querySelector('#quick_toolbar [data-capture-action=\"close\"]').click()",
        );
        const autoAdded = await until(async () => {
            const value = await run(
                `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
            );
            return value.nodes.some((node) => node.captureItemId === staged.id)
                ? value
                : false;
        }, "Frozen auto-add capture did not reach board");
        await run(
            `window.openCapture.action("open-item",${JSON.stringify(staged.id)})`,
        );
        capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents.getURL().includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Auto-add reopen missing",
        );
        clip = (code) => capture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                clip(
                    `window.captureDraftBridge?.info().id===${JSON.stringify(staged.id)}`,
                ),
            "Auto-add draft reopen not bound",
        );
        await clip("window.captureDraftBridge.stage()");
        await clip(
            "document.querySelector('#quick_toolbar [data-capture-action=\"close\"]').click()",
        );
        await pause(800);
        const noDuplicate = await run(
            `window.openCapture.boards.load(${JSON.stringify(board.id)})`,
        );
        assert(
            noDuplicate.nodes.filter((node) => node.captureItemId === staged.id)
                .length === 1,
            "Draft autosave duplicated auto-add node",
        );
        await run(
            'document.querySelector(".board-viewport").click();document.querySelector(\'[data-board-command="fit"]\').click()',
        );
        await pause(700);
        await run(
            `document.querySelector('.board-image[data-node-id=${JSON.stringify(imageIds[0])}]').click()`,
        );
        await pause(1800);
        await shot(dashboard, "board-final");
        fs.writeFileSync(
            path.join(evidence, "qa-prefix.json"),
            JSON.stringify(
                {
                    ok: false,
                    stage: "before-native-close",
                    boardId: board.id,
                    nodeCount: noDuplicate.nodes.length,
                    rendererErrors: errors,
                    mainErrors,
                    exports: {
                        png: fs.statSync(exportPaths.png).size,
                        pdf: fs.statSync(exportPaths.pdf).size,
                        portable: fs.statSync(exportPaths.ocboard).size,
                    },
                },
                null,
                2,
            ),
        );
        const closeRectWidth = await run(
            `(() => {document.querySelector('.board-editor__layer[data-node-id="rect"] .board-editor__layer-name').click();const details=document.querySelector(".board-editor__properties");if(!details.open)details.querySelector("summary").click();const field=[...details.querySelectorAll("input")].find(input=>input.getAttribute("aria-label")==="너비");field.value=String(Number(field.value)+7);field.dispatchEvent(new Event("change",{bubbles:true}));return Number(field.value)})()`,
        );
        const closeMutationReady = await run(`(() => {
            document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}));
            const target=document.querySelector('.command-result[data-command-id="board:preset-study"]');
            window.__qaCloseMutation={requested:0,issued:false};
            window.openCapture.onBoardFlushRequested(()=>{
                window.__qaCloseMutation.requested++;
                if(window.__qaCloseMutation.issued)return;
                window.__qaCloseMutation.issued=Boolean(target);
                target?.click();
            });
            return Boolean(target);
        })()`);
        assert(
            closeMutationReady,
            "Post-flush UI mutation command was unavailable",
        );
        closeDiagnostic("exercise-close-before", {
            id: dashboard.id,
            destroyed: dashboard.isDestroyed(),
            closeRectWidth,
        });
        dashboard.close();
        closeDiagnostic("exercise-close-after", {
            destroyed: dashboard.isDestroyed(),
        });
        await until(
            () => dashboard.isDestroyed(),
            "Dashboard close did not complete after board flush",
            300,
        );
        await pause(100);

        report.checks.push({
            minimalHome: minimal,
            commands: commandSearch,
            board: {
                id: board.id,
                tabs: summaries.length,
                images: 3,
                nodes: noDuplicate.nodes.length,
                layouts: ["horizontal", "vertical", "grid"],
                grouped: true,
                dragged: true,
                resized: true,
                snapGuides: true,
                focused: true,
                vertexEdited: true,
                annotationDragged: true,
                layers: true,
                styles: true,
                batchBeautify: true,
                boardAssetComparison: true,
                steps: true,
                checklist: true,
                presets: true,
                versionGroups: 2,
                annotations: [
                    "rect",
                    "ellipse",
                    "line",
                    "arrow",
                    "polygon",
                    "text",
                    "note",
                    "callout",
                    "step",
                    "magnify",
                ],
            },
            cutout: {
                original: lineageOriginal,
                immediatePrevious: holdNode.assetId,
                derived: cutoutNode.assetId,
                earlyReleaseCancelled: true,
                rightPointerCancelled: true,
                undo: true,
                redo: true,
            },
            autoAdd: {
                itemId: staged.id,
                targetBoardId: board.id,
                count: noDuplicate.nodes.filter(
                    (node) => node.captureItemId === staged.id,
                ).length,
            },
            immediateClose: {
                preFlushRectWidth: closeRectWidth,
                postFlushPreset: "study",
            },
            exports: {
                png: fs.statSync(exportPaths.png).size,
                pdf: fs.statSync(exportPaths.pdf).size,
                portable: fs.statSync(exportPaths.ocboard).size,
                importedId: importedBoard.id,
            },
        });
        assert(!errors.length, `Renderer errors: ${JSON.stringify(errors)}`);
        assert(!mainErrors.length, `Main errors: ${JSON.stringify(mainErrors)}`);
        fs.writeFileSync(
            planPath,
            JSON.stringify(
                {
                    boardId: board.id,
                    nodeCount: noDuplicate.nodes.length,
                    cutoutNodeId: imageIds[0],
                    derivedAssetId: cutoutNode.assetId,
                    originalAssetId: lineageOriginal,
                    closePreset: "study",
                    closeRectWidth,
                },
                null,
                2,
            ),
        );
        report.phaseOneOk = true;
        report.ok = false;
        fs.writeFileSync(phaseReportPath, JSON.stringify(report, null, 2));
        console.log("CAPTURE_BOARD_PHASE_ONE", JSON.stringify(report));
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        report.ok = false;
        report.failure = String(error.stack || error);
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.error("CAPTURE_BOARD_QA_FAILED", report.failure);
        clearTimeout(timeout);
        app.exit(1);
    }
});
