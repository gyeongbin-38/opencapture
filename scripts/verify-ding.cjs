const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const builtPage = path.join(root, "out", "renderer", "ding.html");

if (!process.versions.electron) {
    const { spawnSync } = require("node:child_process");
    const electron = require("electron");
    const child = spawnSync(electron, [__filename, "--electron-child"], {
        cwd: root,
        stdio: "inherit",
        env: {
            ...process.env,
            ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        },
    });
    process.exit(child.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = require("electron");
const { pathToFileURL } = require("node:url");
const evidence = path.join(root, ".evidence", "ding-e2e");
const profile = path.join(evidence, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
const report = { checks: [], errors: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, attempts = 160) {
    for (let index = 0; index < attempts; index += 1) {
        const result = await check();
        if (result) return result;
        await pause(50);
    }
    throw new Error(message);
}
async function check(name, run) {
    try {
        const detail = await run();
        report.checks.push({ name, ok: true, ...detail });
    } catch (error) {
        report.checks.push({
            name,
            ok: false,
            error: error.stack || error.message,
        });
    }
}

const PNG_A =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_C =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let sessionSaved = [];
let sessionRestore = [];
let latestPins = [];
let pinQueryRevision = 0;
const dingShareMessages = [];
const store = new Map([
    ["全局.模糊", 0],
    ["全局.不透明度", 1],
    [
        "全局.主题",
        {
            light: {
                emphasis: "#d7e3f8",
                barbg: "#ffffff",
                bg: "#fafaff",
                fontColor: "#1a1c1e",
                fontInEmphasis: "#1a1c1e",
                iconColor: "none",
            },
            dark: {
                emphasis: "#3b4858",
                barbg: "#17171a",
                bg: "#1a1c1e",
                fontColor: "#fafaff",
                fontInEmphasis: "#fafaff",
                iconColor: "invert(1)",
            },
        },
    ],
    ["字体", { 主要字体: "system-ui", 等宽字体: "monospace" }],
    ["语言.语言", "zh-HANS"],
    ["贴图.窗口.变换", []],
    ["贴图.窗口.提示", false],
    ["贴图.窗口.双击", "关闭"],
    ["ding_dock", [0, 0]],
]);
ipcMain.on("store", (event, request) => {
    if (request?.type === "get")
        event.returnValue = store.get(request.path) ?? null;
    else if (request?.type === "set") {
        store.set(request.path, request.value);
        event.returnValue = undefined;
    } else if (request?.type === "getAll") event.returnValue = {};
    else if (request?.type === "path") event.returnValue = profile;
});
ipcMain.on("ipc", (event, key, data) => {
    if (key === "dingQueryResult") {
        latestPins = data[0];
        pinQueryRevision += 1;
    }
    if (key === "dingShare") {
        dingShareMessages.push(...(Array.isArray(data) ? data : [data]));
        event.returnValue = null;
        return;
    }
    if (key === "active_language") {
        event.returnValue = store.get("语言.语言") ?? "zh-HANS";
        return;
    }
    if (event.returnValue === undefined) event.returnValue = null;
});
ipcMain.handle("ding:session:get", () => sessionRestore);
ipcMain.handle("ding:session:save", (_event, pins) => {
    sessionSaved = JSON.parse(JSON.stringify(pins));
});
ipcMain.handle("oc:preferences:get", () => ({
    feedback: { visual: true, motion: "reduced" },
}));

assert.ok(fs.existsSync(builtPage), "Build missing: run pnpm run build first");
const finish = async (code) => {
    report.ok = report.checks.every((item) => item.ok) && !report.errors.length;
    fs.writeFileSync(
        path.join(evidence, "ding-report.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(code);
};
const timeout = setTimeout(() => {
    report.errors.push("Ding verification timed out");
    void finish(1);
}, 120_000);

app.whenReady().then(async () => {
    const rendererMessages = [];
    const win = new BrowserWindow({
        show: true,
        width: 900,
        height: 700,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.webContents.on("console-message", (details) => {
        if (details.message) rendererMessages.push(details.message);
    });
    win.webContents.on("did-fail-load", (_event, code, description) =>
        report.errors.push(`renderer load ${code}: ${description}`),
    );
    const js = (code) => win.webContents.executeJavaScript(code);
    const key = (id, init) =>
        js(`document.getElementById(${JSON.stringify(String(id))})` +
            `.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`);
    const load = async () => {
        await win.loadURL(pathToFileURL(builtPage).href);
        await until(
            () => js("Boolean(document.body)"),
            "Ding renderer did not load",
        );
        const revision = pinQueryRevision;
        await until(async () => {
            win.webContents.send("ipc", "dingQuery", []);
            await pause(20);
            return pinQueryRevision > revision;
        }, "Ding IPC listeners did not become ready");
    };
    const sendPin = (id, opts = {}) => {
        win.webContents.send("ipc", "addDing", [
            String(id),
            opts.x ?? 120,
            opts.y ?? 120,
            opts.w ?? 200,
            opts.h ?? 140,
            opts.src ?? PNG_A,
            "ding",
            opts,
        ]);
    };

    try {
        sessionRestore = [
            {
                x: 60,
                y: 80,
                w: 150,
                h: 100,
                src: PNG_B,
                opacity: 0.7,
                z: 5,
                stack: [PNG_B, PNG_A],
                label: "memo",
            },
            {
                x: 300,
                y: 460,
                w: 100,
                h: 60,
                src: PNG_C,
                opacity: 1,
                z: 6,
                collapsed: true,
            },
        ];
        await load();

        await check("session restore positions, opacity, collapse", async () => {
            await until(
                () =>
                    js(
                        `document.querySelectorAll('[id^="restored-"]').length>=2`,
                    ),
                "Restored pins missing",
            );
            const restored = await js(`(()=>{
                const els=[...document.querySelectorAll('[id^="restored-"]')];
                return els.map(e=>({id:e.id,x:e.offsetLeft,y:e.offsetTop,
                    w:e.offsetWidth,h:e.offsetHeight,z:e.style.zIndex,
                    sh:e.style.height,sw:e.style.width,
                    collapsed:e.classList.contains('pin-collapsed'),
                    op:e.querySelector('.img > img')?.style.opacity,
                    src:e.querySelector('.img > img')?.src,
                    label:[...e.querySelectorAll('*')].map(n=>n.textContent).find(t=>/^\\d\\/\\d$/.test(t))}))})()`);
            const r1 = restored.find((r) => r.x === 60);
            const r2 = restored.find((r) => r.x === 300);
            assert.ok(r1, "First restored pin not found");
            assert.equal(r1.y, 80);
            assert.equal(r1.w, 150);
            assert.equal(r1.h, 100);
            assert.equal(r1.z, "5");
            assert.equal(r1.op, "0.7", "Opacity not restored");
            assert.equal(r1.src, PNG_B);
            assert.equal(r1.label, "1/2", "Stack not restored");
            assert.ok(r2, "Second restored pin not found");
            assert.equal(r2.h, 8, `Collapsed height not applied: ${JSON.stringify(restored)}`);
            assert.equal(r2.collapsed, true, "Collapsed class missing");
            return { count: restored.length, first: r1.id };
        });

        await check("session save collects live pins", async () => {
            await js(
                `document.querySelector('[id^="restored-"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
            );
            await until(
                () => sessionSaved.length > 0,
                "Session save never invoked",
            );
            const saved = sessionSaved.find((p) => p.src === PNG_B);
            assert.ok(saved, "Restored pin missing from saved session");
            assert.deepEqual(saved.stack, [PNG_B, PNG_A]);
            assert.equal(saved.opacity, 0.7);
            return { saved: sessionSaved.length };
        });

        sendPin("stack", { stack: [PNG_A, PNG_B, PNG_C] });
        await check("stack keys [ and ] cycle images", async () => {
            await until(
                () =>
                    js(
                        "document.querySelectorAll('#stack .pin-controls-panel *').length>0",
                    ),
                "Stack controls missing",
            );
            const read = () =>
                js(`(()=>{const img=document.getElementById('stack').querySelector('.img > img');
                    const label=[...document.querySelectorAll('#stack *')].map(e=>e.textContent).find(t=>/^\\d\\/\\d$/.test(t));
                    return {src:img.src,label}})()`);
            const p0 = await read();
            await key("stack", { key: "]" });
            const p1 = await read();
            await key("stack", { key: "]" });
            const p2 = await read();
            await key("stack", { key: "[" });
            const p3 = await read();
            assert.equal(p1.src, PNG_B);
            assert.equal(p2.src, PNG_C);
            assert.equal(p3.src, PNG_B);
            assert.equal(p2.label, "3/3");
            return { labels: [p0.label, p1.label, p2.label] };
        });

        sendPin("draw", { w: 220, h: 160, y: 320 });
        await check("stroke undo via Ctrl+Z and right-click", async () => {
            await until(
                () =>
                    js(
                        "Boolean(document.getElementById('draw')?.querySelector('.img canvas'))",
                    ),
                "Draw canvas missing",
            );
            const ink = () =>
                js(`(()=>{const c=document.getElementById('draw').querySelector('.img canvas');
                    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                    let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;return n})()`);
            const strokes = () =>
                js(`document.getElementById('draw').querySelector('.img canvas').dataset.strokes`);
            const pts = () =>
                js(`document.getElementById('draw').querySelector('.img canvas').dataset.pts`);
            // Synthetic pointer events report offsetX/offsetY in the canvas'
            // local (transformed) space, which differs from client coordinates
            // when an ancestor is scaled. Calibrate the affine map with probe
            // pointerdowns while draw mode is off (handler returns early).
            const cal = await js(`(()=>{const c=document.getElementById('draw').querySelector('.img canvas');
                c.setPointerCapture=()=>{};window.__cal=[];
                const h=e=>window.__cal.push([e.clientX,e.clientY,e.offsetX,e.offsetY]);
                c.addEventListener('pointerdown',h);
                const r=c.getBoundingClientRect();
                const o={bubbles:true,button:0,pointerId:9};
                c.dispatchEvent(new PointerEvent('pointerdown',{...o,clientX:r.left+40,clientY:r.top+40}));
                c.dispatchEvent(new PointerEvent('pointerdown',{...o,clientX:r.left+120,clientY:r.top+120}));
                c.removeEventListener('pointerdown',h);
                return window.__cal})()`);
            assert.equal(cal.length, 2, "Calibration probes did not run");
            const ax = (cal[1][2] - cal[0][2]) / (cal[1][0] - cal[0][0]);
            const bx = cal[0][2] - ax * cal[0][0];
            const ay = (cal[1][3] - cal[0][3]) / (cal[1][1] - cal[0][1]);
            const by = cal[0][3] - ay * cal[0][1];
            const cx = (ox) => (ox - bx) / ax;
            const cy = (oy) => (oy - by) / ay;
            const drawStroke = (x1, y1, x2, y2) =>
                js(`(()=>{const c=document.getElementById('draw').querySelector('.img canvas');
                    c.setPointerCapture=()=>{};
                    const opts={bubbles:true,button:0,pointerId:7};
                    c.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:${cx(x1)},clientY:${cy(y1)}}));
                    c.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:${cx(x2)},clientY:${cy(y2)}}));
                    c.dispatchEvent(new PointerEvent('pointerup',opts));
                    return true})()`);
            await js(
                `document.getElementById('draw').querySelector('img[src*="/draw-"]').closest('button').click()`,
            );
            assert.equal(
                await js(
                    `getComputedStyle(document.getElementById('draw').querySelector('.img canvas')).pointerEvents`,
                ),
                "auto",
            );
            await drawStroke(20, 20, 120, 120);
            const inked = await ink();
            assert.ok(inked > 0, "Stroke drew no ink");
            await key("draw", { key: "z", ctrlKey: true });
            assert.equal(await ink(), 0, "Ctrl+Z did not undo stroke");

            await drawStroke(30, 30, 130, 60);
            await drawStroke(30, 60, 130, 130);
            const two = await ink();
            assert.equal(await strokes(), "2", "Two strokes not recorded");
            await js(
                `document.getElementById('draw').querySelector('.img canvas').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
            );
            const one = await ink();
            const oneCount = await strokes();
            assert.equal(
                oneCount,
                "1",
                `Right-click pop failed: count=${oneCount} pts=${await pts()} one=${one} two=${two}`,
            );
            assert.ok(
                one > 0 && one <= two,
                `Pop ink wrong: one=${one} two=${two} pts=${await pts()}`,
            );
            await drawStroke(10, 10, 30, 30);
            await js(
                `document.getElementById('draw').querySelector('.img canvas').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,shiftKey:true}))`,
            );
            assert.equal(await strokes(), "0", "Shift+right-click count");
            assert.equal(await ink(), 0, "Shift+right-click did not clear all");

            await key("draw", { key: "Escape" });
            assert.equal(
                await js(
                    `getComputedStyle(document.getElementById('draw').querySelector('.img canvas')).pointerEvents`,
                ),
                "none",
                "Esc did not exit draw mode",
            );
            return { inked, two, one };
        });

        await check("? opens shortcut help sheet", async () => {
            await key("draw", { key: "?" });
            await until(
                () => js(`Boolean(document.querySelector('.pin-help-dialog[open]'))`),
                "Help dialog did not open",
            );
            const rows = await js(
                `document.querySelectorAll('.pin-help-dialog .pin-help-row').length`,
            );
            assert.ok(rows >= 15, `Help rows: ${rows}`);
            const groups = await js(
                `document.querySelectorAll('.pin-help-dialog .pin-help-group').length`,
            );
            assert.ok(groups >= 4, `Help groups: ${groups}`);
            await key("draw", { key: "?" });
            assert.equal(
                await js(
                    `Boolean(document.querySelector('.pin-help-dialog[open]'))`,
                ),
                false,
                "Second ? did not close help",
            );
            return { rows, groups };
        });

        sendPin("esc", { x: 420 });
        await check("Esc ladder: radial, then close", async () => {
            await until(
                () =>
                    js(
                        "Boolean(document.getElementById('esc')?.querySelector('.img'))",
                    ),
                "Esc pin missing",
            );
            dingShareMessages.length = 0;
            await js(
                `document.getElementById('esc').querySelector('.img').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:420,clientY:220}))`,
            );
            assert.equal(
                await js(
                    `document.getElementById('esc').querySelector('.pin-radial-menu').classList.contains('is-open')`,
                ),
                true,
                "Context menu did not open radial",
            );
            const actions = await js(
                `document.getElementById('esc').querySelectorAll('.pin-radial-action').length`,
            );
            assert.ok(actions >= 10, `Radial actions: ${actions}`);
            await key("esc", { key: "Escape" });
            assert.equal(
                await js(
                    `document.getElementById('esc').querySelector('.pin-radial-menu').classList.contains('is-open')`,
                ),
                false,
                "Esc did not close radial",
            );
            assert.equal(
                dingShareMessages.filter((m) => m.type === "close").length,
                0,
                "Esc closed pin while radial was open",
            );
            await key("esc", { key: "Escape" });
            const closeMsg = dingShareMessages.find(
                (m) => m.type === "close" && m.id === "esc",
            );
            assert.ok(closeMsg, "Second Esc did not close the pin");
            return { actions };
        });

        fs.writeFileSync(
            path.join(evidence, "ding.png"),
            (await win.webContents.capturePage()).toPNG(),
        );
        clearTimeout(timeout);
        await finish(report.checks.every((item) => item.ok) ? 0 : 1);
    } catch (error) {
        clearTimeout(timeout);
        report.errors.push(error.stack || error.message);
        report.errors.push(
            ...rendererMessages
                .slice(-8)
                .map((message) => `renderer: ${message}`),
        );
        await finish(1);
    }
});
