const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "dashboard-language");
const profile = path.join(evidence, "profile");
const outputs = path.join(evidence, "outputs");
const fixture = path.join(evidence, "language-job.mp4");
const realConfig = process.env.APPDATA
    ? path.join(process.env.APPDATA, "OpenCapture", "config.json")
    : "";
const hash = (target) =>
    target && fs.existsSync(target)
        ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
        : null;
const realHashBefore = hash(realConfig);

const isElectronMain = Boolean(process.versions.electron);
if (!isElectronMain) {
    fs.mkdirSync(evidence, { recursive: true });
    for (const target of [profile, outputs]) {
        const resolved = path.resolve(target);
        if (!resolved.startsWith(`${path.resolve(evidence)}${path.sep}`))
            throw new Error("Unsafe language verifier path");
        if (fs.existsSync(resolved))
            fs.rmSync(resolved, { recursive: true, force: true });
    }
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(outputs, { recursive: true });
    const ffmpeg = path.join(root, "lib", "ffmpeg", "ffmpeg.exe");
    execFileSync(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=1280x720:rate=30:duration=8",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            fixture,
        ],
        { windowsHide: true, timeout: 60_000 },
    );
    const electron = require("electron");
    const phases = [
        ["ko", "en"],
        ["en", "ar"],
        ["ar", "fr"],
        ["fr", "ru"],
        ["ru", "ko"],
        ["ko", ""],
    ];
    const results = [];
    for (const [active, next] of phases) {
        const environment = {
            ...process.env,
            OPENCAPTURE_LANGUAGE_CHILD: "1",
            OPENCAPTURE_LANGUAGE_ACTIVE: active,
            OPENCAPTURE_LANGUAGE_NEXT: next,
            OPENCAPTURE_LANGUAGE_PROFILE: profile,
            OPENCAPTURE_LANGUAGE_OUTPUTS: outputs,
            OPENCAPTURE_LANGUAGE_FIXTURE: fixture,
        };
        environment.ELECTRON_RUN_AS_NODE = undefined;
        const child = spawnSync(electron, [__filename], {
            cwd: root,
            env: environment,
            encoding: "utf8",
            windowsHide: true,
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
        });
        if (child.status !== 0)
            throw new Error(
                `Language phase ${active}->${next || "done"} failed:\n${child.stdout}\n${child.stderr}`,
            );
        const marker = child.stdout
            .split(/\r?\n/)
            .find((line) => line.startsWith("OPENCAPTURE_LANGUAGE_PHASE "));
        if (!marker) throw new Error(`Missing phase evidence for ${active}`);
        results.push(
            JSON.parse(marker.slice("OPENCAPTURE_LANGUAGE_PHASE ".length)),
        );
    }
    const realHashAfter = hash(realConfig);
    assert.equal(
        realHashAfter,
        realHashBefore,
        "Real OpenCapture settings changed",
    );
    const report = {
        ok: true,
        phases: results,
        realConfig: {
            path: realConfig || null,
            before: realHashBefore,
            after: realHashAfter,
            preserved: true,
        },
    };
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    console.log("OPENCAPTURE_DASHBOARD_LANGUAGE_OK");
    process.exit(0);
}

const {
    app,
    BrowserWindow,
    ClipboardItem,
    clipboard,
    dialog,
    nativeImage,
} = require("electron");
const active = process.env.OPENCAPTURE_LANGUAGE_ACTIVE;
const next = process.env.OPENCAPTURE_LANGUAGE_NEXT;
const childProfile = path.resolve(process.env.OPENCAPTURE_LANGUAGE_PROFILE);
const childOutputs = path.resolve(process.env.OPENCAPTURE_LANGUAGE_OUTPUTS);
const childFixture = path.resolve(process.env.OPENCAPTURE_LANGUAGE_FIXTURE);
app.setPath("userData", childProfile);
app.setPath("pictures", childProfile);
process.argv.push(`--userData=${childProfile}`);
dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [childOutputs],
});
dialog.showMessageBoxSync = () => -1;
dialog.showErrorBox = () => undefined;
app.on("browser-window-created", (_event, window) => {
    window.setSkipTaskbar(true);
    window.webContents.setBackgroundThrottling(false);
});
require("../out/main/main.js");
assert.equal(path.resolve(app.getPath("userData")), childProfile);

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (condition, label) => {
    for (let attempt = 0; attempt < 300; attempt++) {
        const value = await condition();
        if (value) return value;
        await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
};
const config = () =>
    JSON.parse(fs.readFileSync(path.join(childProfile, "config.json"), "utf8"));
const withoutLanguage = (value) => {
    const copy = structuredClone(value);
    copy.语言 ??= {};
    copy.语言.语言 = "<language>";
    return copy;
};
const timer = setTimeout(() => app.exit(1), 150_000);

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
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    "Boolean(window.openCapture?.getLanguageSettings && document.querySelector('[data-ui-language]'))",
                ),
            "language settings UI",
        );
        await run(
            "document.querySelector('.nav-button[data-page=\"settings\"]').click()",
        );
        const settings = await run("window.openCapture.getLanguageSettings()");
        assert.equal(settings.active, active);
        assert.equal(settings.configured, active);
        assert.equal(settings.pending, false);
        const ui = await run(`(() => ({
            lang:document.documentElement.lang,
            dir:document.documentElement.dir,
            preloadLang:window.openCapture.lang,
            heading:document.querySelector('.language-settings-card h2').textContent.trim(),
            select:document.querySelector('[data-ui-language]').value,
            noteHidden:document.querySelector('#language-apply-note').hidden,
            bodySettings:document.querySelector('.nav-button[data-page="settings"] span').textContent.trim()
        }))()`);
        assert.equal(ui.lang, active);
        assert.equal(ui.dir, active === "ar" ? "rtl" : "ltr");
        assert.equal(ui.preloadLang, active);
        assert.equal(ui.select, active);
        assert.equal(ui.noteHidden, true);
        assert.equal(ui.heading, await run('window.openCapture.t("앱 언어")'));
        if (active !== "ko") assert.notEqual(ui.heading, "앱 언어");
        let commandSearch = null;
        if (active === "en") {
            commandSearch = await run(`(() => {
                document.querySelector('.command-trigger').click();
                const input=document.querySelector('.command-palette input[type=search]');
                input.value='new board';
                input.dispatchEvent(new Event('input',{bubbles:true}));
                const result=document.querySelector('[data-command-id="board:create"] strong');
                return {found:Boolean(result),label:result?.textContent?.trim() ?? ''};
            })()`);
            assert.equal(commandSearch.found, true);
            assert.notEqual(commandSearch.label, "새 보드");
        }
        let responsiveLayouts = null;
        if (["ar", "fr", "ru"].includes(active)) {
            responsiveLayouts = [];
            dashboard.setMinimumSize(0, 0);
            for (const [width, height] of [
                [360, 560],
                [851, 650],
            ]) {
                dashboard.setSize(width, height);
                await pause(140);
                const pages = [];
                for (const page of [
                    "home",
                    "library",
                    "board",
                    "translate",
                    "settings",
                ]) {
                    const metrics = await run(`(() => {
                        document.querySelector('.nav-button[data-page=${JSON.stringify(page)}]').click();
                        const active=document.querySelector('.page[data-page=${JSON.stringify(page)}]');
                        const nav=[...document.querySelectorAll('.nav-button')].map(button=>({
                            name:button.getAttribute('aria-label') ?? '',
                            width:button.getBoundingClientRect().width,
                            height:button.getBoundingClientRect().height
                        }));
                        return {
                            page:${JSON.stringify(page)},
                            viewport:[innerWidth,innerHeight],
                            documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
                            pageOverflow:active.scrollWidth-active.clientWidth,
                            nav
                        };
                    })()`);
                    assert.ok(
                        metrics.documentOverflow <= 1 &&
                            metrics.pageOverflow <= 1,
                        `${active} ${width}px ${page} overflowed`,
                    );
                    assert.ok(
                        metrics.nav.every(
                            (item) => item.name && item.height >= 40,
                        ),
                        `${active} ${width}px navigation lost names or hit targets`,
                    );
                    pages.push(metrics);
                }
                await run(`(() => {
                    document.querySelector('.nav-button[data-page="home"]').focus();
                })()`);
                dashboard.webContents.sendInputEvent({
                    type: "keyDown",
                    keyCode: "Tab",
                });
                dashboard.webContents.sendInputEvent({
                    type: "keyUp",
                    keyCode: "Tab",
                });
                await pause(40);
                const tab = await run(`(() => ({
                    tag:document.activeElement?.tagName ?? '',
                    page:document.activeElement?.dataset?.page ?? '',
                    label:document.activeElement?.getAttribute?.('aria-label') ?? ''
                }))()`);
                assert.ok(
                    tab.tag === "BUTTON" && tab.label,
                    `${active} ${width}px Tab navigation failed`,
                );
                responsiveLayouts.push({ width, height, pages, tab });
            }
            await run(
                "document.querySelector('.nav-button[data-page=\"settings\"]').click()",
            );
        }

        const noOpHash = hash(path.join(childProfile, "config.json"));
        const noOp = await run(
            `window.openCapture.setLanguage(${JSON.stringify(active)})`,
        );
        assert.equal(noOp.pending, false);
        assert.equal(hash(path.join(childProfile, "config.json")), noOpHash);

        const rejected = await run(`Promise.all([
            window.openCapture.setLanguage('../en').then(()=>false,()=>true),
            window.openCapture.setLanguage({polluted:true}).then(()=>false,()=>true)
        ])`);
        assert.deepEqual(rejected, [true, true]);
        assert.equal(
            (await run("window.openCapture.getLanguageSettings()")).configured,
            active,
        );

        let pinId = null;
        let pinWindow = null;
        const dashboardId = dashboard.webContents.id;
        const beforeConfig = config();
        let fileJob = null;
        let pendingCompact = null;
        if (active === "ko" && next === "en") {
            const pinImage = nativeImage.createFromBitmap(
                Buffer.alloc(48 * 32 * 4, 180),
                { width: 48, height: 32 },
            );
            await clipboard.write([
                new ClipboardItem({
                    "image/png": new Blob([pinImage.toPNG()], {
                        type: "image/png",
                    }),
                }),
            ]);
            await run('window.openCapture.action("pin-clipboard")');
            pinWindow = await until(
                () =>
                    BrowserWindow.getAllWindows().find(
                        (window) =>
                            window.webContents.getURL().includes("ding.html") &&
                            !window.webContents.isLoading(),
                    ),
                "pin",
            );
            pinId = pinWindow.webContents.id;
            const selection = await run(
                `window.openCapture.fileTools.select([${JSON.stringify(childFixture)}])`,
            );
            const sourceId = selection.sources[0].id;
            await run(`(() => {
                window.__languageProgress=[];
                window.__languageUnsubscribe=window.openCapture.fileTools.onProgress(v=>window.__languageProgress.push(v));
                window.__languageJob=window.openCapture.fileTools.run({
                    jobId:${JSON.stringify(randomUUID())},
                    sourceIds:[${JSON.stringify(sourceId)}],
                    recipe:'media-convert',
                    options:{format:'webm',quality:1}
                });
            })()`);
            await until(
                () => run("window.__languageProgress.length > 0"),
                "active file job",
            );
            fileJob = true;
        }

        if (next) {
            await run(`(() => {
                const select=document.querySelector('[data-ui-language]');
                select.value=${JSON.stringify(next)};
                select.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
            const pending = await until(async () => {
                const value = await run(
                    "window.openCapture.getLanguageSettings()",
                );
                return value.configured === next && value.pending
                    ? value
                    : null;
            }, "pending language setting");
            const pendingUi = await run(`(() => ({
                noteHidden:document.querySelector('#language-apply-note').hidden,
                value:document.querySelector('[data-ui-language]').value,
                lang:document.documentElement.lang,
                dir:document.documentElement.dir
            }))()`);
            assert.equal(pending.active, active);
            assert.equal(pendingUi.noteHidden, false);
            assert.equal(pendingUi.value, next);
            assert.equal(pendingUi.lang, active);
            assert.equal(pendingUi.dir, active === "ar" ? "rtl" : "ltr");
            assert.equal(dashboard.webContents.id, dashboardId);
            if (active === "ko" && next === "en") {
                dashboard.setMinimumSize(0, 0);
                dashboard.setSize(360, 560);
                await pause(180);
                pendingCompact = await run(`(() => {
                    const row=document.querySelector('.language-settings-row');
                    const select=document.querySelector('[data-ui-language]');
                    const note=document.querySelector('#language-apply-note');
                    const card=document.querySelector('.language-settings-card');
                    const rect=e=>JSON.parse(JSON.stringify(e.getBoundingClientRect()));
                    return {
                        viewport:[innerWidth,innerHeight],
                        row:{clientWidth:row.clientWidth,scrollWidth:row.scrollWidth,display:getComputedStyle(row).display,flexWrap:getComputedStyle(row).flexWrap,rect:rect(row)},
                        select:rect(select),note:rect(note),card:rect(card),noteHidden:note.hidden,
                        documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth
                    };
                })()`);
                assert.equal(pendingCompact.noteHidden, false);
                assert.ok(
                    pendingCompact.row.scrollWidth <=
                        pendingCompact.row.clientWidth + 1,
                    "Compact language row overflowed",
                );
                fs.writeFileSync(
                    path.join(evidence, "pending-language-360.png"),
                    (await dashboard.webContents.capturePage()).toPNG(),
                );
            }
            if (pinId !== null)
                assert.ok(
                    BrowserWindow.getAllWindows().some(
                        (window) =>
                            window.webContents.id === pinId &&
                            !window.isDestroyed(),
                    ),
                    "Language save closed the active pin",
                );
            if (pinWindow) {
                const pinDocument =
                    await pinWindow.webContents.executeJavaScript(
                        "({lang:document.documentElement.lang,dir:document.documentElement.dir})",
                        true,
                    );
                assert.equal(pinDocument.lang, active);
                assert.equal(pinDocument.dir, active === "ar" ? "rtl" : "ltr");
            }
            if (fileJob) {
                const results = await run("window.__languageJob");
                assert.equal(results[0].status, "success");
                await run(
                    "window.__languageUnsubscribe(); delete window.__languageJob",
                );
            }
            const afterConfig = config();
            assert.deepEqual(
                withoutLanguage(afterConfig),
                withoutLanguage(beforeConfig),
            );
            assert.equal(afterConfig.语言.语言, next);
        }

        const result = {
            active,
            next: next || null,
            ui,
            activePinPreserved: pinId !== null ? true : null,
            activeFileJobCompleted: fileJob !== null ? true : null,
            commandSearch,
            pendingCompact,
            responsiveLayouts,
        };
        console.log(`OPENCAPTURE_LANGUAGE_PHASE ${JSON.stringify(result)}`);
        clearTimeout(timer);
        app.exit(0);
    })
    .catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        clearTimeout(timer);
        app.exit(1);
    });
