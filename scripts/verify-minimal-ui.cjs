const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const label = process.env.OPENCAPTURE_UI_LABEL || "current";
const evidence = path.join(root, ".evidence", "product-minimal", label);
const profile = path.join(evidence, `profile-${Date.now()}`);
const actualConfig = path.join(
    app.getPath("appData"),
    "OpenCapture",
    "config.json",
);
const configHash = () =>
    fs.existsSync(actualConfig)
        ? createHash("sha256")
              .update(fs.readFileSync(actualConfig))
              .digest("hex")
        : null;
const actualConfigBefore = configHash();
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", profile);
process.argv.push(`--userData=${profile}`);
const report = { checks: [], errors: [], screenshots: [] };
let forcedTranslationStatus;
let forcedInstallResult;
let statusRequests = 0;
let installRequests = 0;
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
    registerHandler(channel, (event, ...args) => {
        if (channel === "oc:translation-status") {
            statusRequests++;
            if (forcedTranslationStatus)
                return structuredClone(forcedTranslationStatus);
        }
        if (channel === "oc:install-models" && forcedInstallResult) {
            installRequests++;
            return structuredClone(forcedInstallResult);
        }
        return listener(event, ...args);
    });
dialog.showMessageBoxSync = (options) => {
    report.errors.push(options?.message || "Unexpected dialog");
    return -1;
};
dialog.showErrorBox = (title, message) =>
    report.errors.push(`${title}: ${message}`);
app.on("browser-window-created", (_, win) => {
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    win.webContents.setBackgroundThrottling(false);
});
app.on("web-contents-created", (_, wc) =>
    wc.on("render-process-gone", (_, details) =>
        report.errors.push(details.reason),
    ),
);
require("../out/main/main.js");
assert.equal(path.resolve(app.getPath("userData")), path.resolve(profile));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
    for (let i = 0; i < 300; i++) {
        const result = await check();
        if (result) return result;
        await pause(50);
    }
    throw Error(message);
}
const finish = (code) => {
    report.realSettingsPreserved = configHash() === actualConfigBefore;
    if (!report.realSettingsPreserved) {
        report.errors.push(
            "Real user settings changed during isolated UI checks",
        );
        report.ok = false;
    }
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(code || (report.realSettingsPreserved ? 0 : 1));
};
const timer = setTimeout(() => {
    report.errors.push("UI verification timed out");
    finish(1);
}, 120000);
app.whenReady().then(async () => {
    try {
        const win = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (w) =>
                        w.webContents.getURL().includes("dashboard.html") &&
                        !w.webContents.isLoading(),
                ),
            "Dashboard missing",
        );
        const run = (code) => win.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    "Boolean(window.openCapture&&document.querySelector('.nav-button'))",
                ),
            "Dashboard not ready",
        );
        await pause(300);
        const firstCapture = await run(`(() => {
            const control=document.querySelector('.minimal-capture-button');
            if(!control)return {available:false};
            const rect=control.getBoundingClientRect();
            const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
            return {available:!!hit&&control.contains(hit),label:control.textContent,blockedBy:hit?.closest('dialog')?.className??null};
        })()`);
        assert.ok(
            firstCapture.available,
            "A fresh profile must allow Capture without dismissing a tutorial",
        );
        report.checks.push({
            name: "fresh profile capture is immediately available",
            ok: true,
            metrics: firstCapture,
        });
        const translationFixture = (runtimeReady, installed) => ({
            runtimeReady,
            modelsReady: installed,
            engine: "local",
            pairs: installed ? ["en-ko", "ko-en"] : [],
            installing: false,
            local: { installed, installing: false, size: 0, languages: [] },
            providers: {
                deepl: { configured: false },
                google: { configured: false },
            },
        });
        const readModelUi = () =>
            run(`(() => {
                const panel=document.querySelector('.model-panel');
                const button=panel.querySelector('button');
                return {ready:panel.querySelector('.status-dot').classList.contains('ready'),label:panel.querySelector('strong').textContent,installHidden:button.hidden,installDisabled:button.disabled};
            })()`);
        const refreshModelUi = async () => {
            const previous = statusRequests;
            await run(
                "document.querySelector('.nav-button[data-page=home]').click();document.querySelector('.nav-button[data-page=translate]').click()",
            );
            await until(
                () => statusRequests > previous,
                "Model status missing",
            );
            await pause(180);
        };
        for (const installed of [false, true]) {
            forcedTranslationStatus = translationFixture(false, installed);
            await refreshModelUi();
            const modelUi = await readModelUi();
            assert.ok(
                !modelUi.ready &&
                    modelUi.installHidden &&
                    modelUi.installDisabled,
                `A missing runtime must not be presented as installable or ready: ${JSON.stringify(modelUi)}`,
            );
            report.checks.push({
                name: `missing translation runtime with models ${installed ? "present" : "absent"}`,
                ok: true,
                metrics: modelUi,
            });
        }
        forcedTranslationStatus = translationFixture(true, false);
        await refreshModelUi();
        forcedInstallResult = translationFixture(false, false);
        await run("document.querySelector('.model-panel button').click()");
        await until(() => installRequests === 1, "Install action missing");
        await pause(180);
        const failedInstallUi = await readModelUi();
        const installToast = await run(
            "document.querySelector('.toast').textContent",
        );
        assert.ok(failedInstallUi.installHidden && !failedInstallUi.ready);
        assert.ok(
            !installToast.includes("설치했습니다"),
            "False install success",
        );
        report.checks.push({
            name: "runtime loss during model installation stays unavailable",
            ok: true,
        });
        win.setMinimumSize(0, 0);
        win.setContentSize(360, 560);
        await pause(200);
        const compactToast = await run(
            "(()=>{const t=document.querySelector('.toast');const r=t.getBoundingClientRect();return {visible:t.classList.contains('visible'),left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,navigationTop:document.querySelector('.sidebar').getBoundingClientRect().top}})()",
        );
        fs.writeFileSync(
            path.join(evidence, "compact-error-toast.png"),
            (await win.webContents.capturePage()).toPNG(),
        );
        report.screenshots.push("compact-error-toast.png");
        assert.ok(
            compactToast.visible &&
                compactToast.left >= 0 &&
                compactToast.right <= compactToast.width &&
                compactToast.bottom <= compactToast.navigationTop,
            `Compact error feedback must remain visible above navigation: ${JSON.stringify(compactToast)}`,
        );
        report.checks.push({
            name: "compact error feedback stays within the viewport above navigation",
            ok: true,
            metrics: compactToast,
        });
        forcedTranslationStatus = undefined;
        forcedInstallResult = undefined;
        await refreshModelUi();
        await run(
            `localStorage.setItem('oc:onboarded','1');for(const d of document.querySelectorAll('dialog[open]'))d.close();const b=document.querySelector('.modal-backdrop');if(b)b.hidden=true;`,
        );
        win.setMinimumSize(360, 500);
        for (const [size, width, height] of [
            ["wide", 1180, 810],
            ["medium", 850, 720],
            ["compact", 380, 560],
            ["minimum", 360, 500],
        ]) {
            win.setContentSize(width, height);
            await pause(100);
            for (const page of [
                "home",
                "library",
                "board",
                "translate",
                "settings",
            ]) {
                await run(
                    `document.querySelector('.nav-button[data-page="${page}"]').click()`,
                );
                await pause(220);
                if (page === "library" && size === "wide") {
                    assert.equal(
                        await run(
                            "document.querySelector('.filter-bar').hidden",
                        ),
                        true,
                    );
                    await run(
                        "document.querySelector('.filter-toggle').click()",
                    );
                    assert.ok(
                        await run(
                            "(()=>{const p=document.querySelector('.filter-bar');return !p.hidden&&p.contains(document.querySelector('.fav-filter'))&&p.contains(document.querySelector('.saved-comparison-button'))})()",
                        ),
                    );
                    await run("document.querySelector('.fav-filter').click()");
                    await until(
                        () =>
                            run(
                                "document.querySelector('.filter-toggle').classList.contains('active')",
                            ),
                        "active favorite filter indicator",
                    );
                    await run(
                        "document.querySelector('.filter-toggle').click()",
                    );
                    assert.equal(
                        await run(
                            "document.querySelector('.filter-toggle').getAttribute('aria-expanded')",
                        ),
                        "false",
                    );
                    assert.equal(
                        await run(
                            "document.querySelector('.filter-toggle').classList.contains('active')",
                        ),
                        true,
                    );
                    await run(
                        "document.querySelector('.filter-toggle').click();document.querySelector('.fav-filter').click()",
                    );
                    await until(
                        () =>
                            run(
                                "!document.querySelector('.filter-toggle').classList.contains('active')",
                            ),
                        "cleared favorite filter indicator",
                    );
                    await run(
                        "document.querySelector('.filter-toggle').click()",
                    );
                    report.checks.push({
                        name: "secondary filters remain reachable with a visible active indicator",
                        ok: true,
                        metrics: await run(
                            "(()=>{const e=document.querySelector('.filter-bar');return {hidden:e.hidden,display:getComputedStyle(e).display,html:e.outerHTML.slice(0,350)}})()",
                        ),
                    });
                }
                if (page === "settings") {
                    const settingGeometry = await run(
                        "(()=>{const s=document.querySelector('[data-ui-language]');return {html:document.querySelector('.language-settings-card')?.outerHTML,rect:s?JSON.stringify(s.getBoundingClientRect()):null,display:s?getComputedStyle(s).display:null}})()",
                    );
                    assert.ok(
                        await run(
                            "(()=>{const s=document.querySelector('[data-ui-language]');if(!s)return false;const r=s.getBoundingClientRect();return r.width>80&&r.left>=0&&r.right<=innerWidth&&r.height>=40})()",
                        ),
                        `language setting must be directly available without opening a disclosure: ${JSON.stringify(settingGeometry)}`,
                    );
                }
                const metrics = await run(`(() => {
                    const active=document.querySelector('.page.active');
                    const nav=[...document.querySelectorAll('.nav-button')];
                    const heading=document.querySelector('.topbar h1')||document.querySelector('.main h1');
                    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,active:!!active,
                        navigation:nav.map(el=>{const rect=el.getBoundingClientRect();const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return {label:el.getAttribute('aria-label'),width:rect.width,unobstructed:!!hit&&el.contains(hit)};}),
                        boardToolbar:(()=>{const toolbar=active?.querySelector('.board-editor__toolbar');const sidebar=document.querySelector('.sidebar');if(!toolbar||!sidebar)return null;const rect=toolbar.getBoundingClientRect();return {bottom:rect.bottom,navigationTop:sidebar.getBoundingClientRect().top};})(),
                        heading:heading?{text:heading.textContent,color:getComputedStyle(heading).color}:null,
                        openDetails:[...document.querySelectorAll('.page.active details[open]')].length};
                })()`);
                assert.ok(
                    metrics.scrollWidth <= metrics.width + 1,
                    `${size}/${page} horizontal overflow: ${JSON.stringify(metrics)}`,
                );
                assert.ok(metrics.active, `${page} active page missing`);
                assert.ok(
                    metrics.navigation.every((n) => n.label),
                    "Unnamed navigation button",
                );
                assert.ok(
                    metrics.navigation.every((n) => n.width >= 40),
                    "Navigation targets are too narrow",
                );
                assert.ok(
                    metrics.navigation.every((n) => n.unobstructed),
                    `${size}/${page} navigation is covered by another control`,
                );
                if (width <= 500 && page === "board") {
                    assert.ok(
                        metrics.boardToolbar &&
                            metrics.boardToolbar.bottom <=
                                metrics.boardToolbar.navigationTop - 8,
                        "Compact board tools overlap the bottom navigation",
                    );
                }
                assert.ok(
                    metrics.heading && metrics.heading.color !== "rgb(0, 0, 0)",
                    "Unreadable page heading",
                );
                const file = `${size}-${page}.png`;
                fs.writeFileSync(
                    path.join(evidence, file),
                    (await win.webContents.capturePage()).toPNG(),
                );
                report.screenshots.push(file);
                report.checks.push({
                    name: `${size}/${page}`,
                    ok: true,
                    metrics,
                });
            }
        }
        win.webContents.debugger.attach("1.3");
        await win.webContents.debugger.sendCommand(
            "Emulation.setEmulatedMedia",
            {
                features: [
                    { name: "prefers-reduced-motion", value: "reduce" },
                    { name: "prefers-reduced-transparency", value: "reduce" },
                ],
            },
        );
        await run(
            "document.querySelector('.nav-button[data-page=home]').click()",
        );
        await pause(180);
        report.checks.push({
            name: "reduced effects",
            ok: await run(
                "matchMedia('(prefers-reduced-motion: reduce)').matches&&matchMedia('(prefers-reduced-transparency: reduce)').matches",
            ),
        });
        fs.writeFileSync(
            path.join(evidence, "compact-reduced-effects.png"),
            (await win.webContents.capturePage()).toPNG(),
        );
        win.webContents.debugger.detach();
        win.setContentSize(820, 680);
        await run(
            "window.openCapture.action('configure-workflow',{autoOcr:false,autoPreview:false,autoClipboard:false})",
        );
        const dataURL = await run(`(() => {
            const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;
            const ctx=canvas.getContext('2d');ctx.fillStyle='#587064';ctx.fillRect(0,0,120,80);
            return canvas.toDataURL('image/png');
        })()`);
        const fixture = path.join(profile, "shelf-source.png");
        fs.writeFileSync(fixture, Buffer.from(dataURL.split(",")[1], "base64"));
        const imported = await run(
            `window.openCapture.importPaths([${JSON.stringify(fixture)}])`,
        );
        const permanent =
            imported.items.find((item) => item.name.includes("shelf-source")) ||
            imported.items[0];
        assert.ok(permanent, "Import fixture missing");
        await run(
            `window.openCapture.action('open-item',${JSON.stringify(permanent.id)})`,
        );
        const capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (w) =>
                        w.webContents.getURL().includes("capture.html") &&
                        !w.webContents.isLoading(),
                ),
            "Capture editor missing",
        );
        const clipRun = (code) =>
            capture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                clipRun(
                    "Boolean(window.captureDraftBridge&&!document.querySelector('#selection_handles')?.hidden)",
                ),
            "Capture draft bridge not ready",
        );
        const staged = await clipRun("window.captureDraftBridge.stage()");
        assert.ok(staged?.id, "Capture did not stage");
        await clipRun("window.captureDraftBridge.flush()");
        await clipRun(
            "require('electron').ipcRenderer.send('ipc','clip_hide',[])",
        );
        const shelf = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (w) =>
                        w.webContents.getURL().includes("capture_shelf.html") &&
                        !w.webContents.isLoading(),
                ),
            "Shelf missing",
        );
        const shelfRun = (code) =>
            shelf.webContents.executeJavaScript(code, true);
        await until(
            () =>
                shelfRun(
                    `Boolean(document.querySelector('.shelf-card[data-item-id="${staged.id}"]'))`,
                ),
            "Staged shelf card missing",
        );
        const denied = await shelfRun(
            `window.openCapture.requestConversion([${JSON.stringify(permanent.id)}]).then(()=>false,()=>true)`,
        );
        assert.equal(denied, true, "Shelf accepted a permanent library item");
        await shelfRun(
            `document.querySelector('.shelf-card[data-item-id="${staged.id}"]').click();document.querySelector('[data-shelf-action=x]').click();`,
        );
        await until(
            () =>
                run("Boolean(document.querySelector('[data-convert-dialog]'))"),
            "Shelf did not open workspace conversion",
        );
        const conversionBounds = await run(`(() => {
            const rect=document.querySelector('[data-convert-dialog]').getBoundingClientRect();
            return {width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};
        })()`);
        assert.ok(shelf.getBounds().height < 250, "Shelf should stay compact");
        assert.ok(
            conversionBounds.width >= 340 && conversionBounds.height > 200,
            "Conversion is trapped in the tiny shelf",
        );
        assert.ok(
            conversionBounds.left >= 0 &&
                conversionBounds.right <= conversionBounds.viewportWidth &&
                conversionBounds.top >= 0 &&
                conversionBounds.bottom <= conversionBounds.viewportHeight,
            "Workspace conversion overflows",
        );
        await pause(250);
        fs.writeFileSync(
            path.join(evidence, "shelf-conversion.png"),
            (await win.webContents.capturePage()).toPNG(),
        );
        report.screenshots.push("shelf-conversion.png");
        report.checks.push({
            name: "shelf conversion opens workspace with scoped temporary items",
            ok: true,
            metrics: conversionBounds,
        });
        await run(
            "document.querySelector('[data-convert-action=close]').click()",
        );
        report.ok =
            report.checks.every((check) => check.ok) && !report.errors.length;
        clearTimeout(timer);
        finish(report.ok ? 0 : 1);
    } catch (error) {
        clearTimeout(timer);
        report.errors.push(error.stack || error.message);
        report.ok = false;
        finish(1);
    }
});
