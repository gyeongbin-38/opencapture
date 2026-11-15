const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const mainFile = path.join(root, "src", "main", "main.ts");
const dingFile = path.join(root, "src", "renderer", "ding", "ding.ts");

function sourceFile(file) {
    const source = fs.readFileSync(file, "utf8");
    return {
        source,
        ast: ts.createSourceFile(
            file,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        ),
    };
}

function extractProductionSanitizer() {
    const { ast } = sourceFile(mainFile);
    const names = new Set([
        "CARD_TEXT_LIMIT",
        "CARD_ERROR_LIMIT",
        "retainCardText",
        "sanitizeCardPinMetadata",
    ]);
    const parts = [];
    for (const statement of ast.statements) {
        if (ts.isVariableStatement(statement)) {
            const declarations = statement.declarationList.declarations.filter(
                (declaration) =>
                    ts.isIdentifier(declaration.name) &&
                    names.has(declaration.name.text),
            );
            if (declarations.length)
                parts.push(
                    `${statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${declarations.map((declaration) => declaration.getText(ast)).join(",")};`,
                );
        }
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name &&
            names.has(statement.name.text)
        )
            parts.push(statement.getText(ast));
    }
    assert.equal(parts.length, 4, "Production card sanitizer was not found");
    const compiled = ts.transpileModule(
        `${parts.join("\n")}\nmodule.exports={retainCardText,sanitizeCardPinMetadata};`,
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports });
    return module.exports;
}

function typeHasCard(ast, name) {
    const declaration = ast.statements.find(
        (statement) =>
            ts.isTypeAliasDeclaration(statement) &&
            statement.name.text === name,
    );
    return Boolean(
        declaration &&
            ts.isTypeLiteralNode(declaration.type) &&
            declaration.type.members.some(
                (member) =>
                    ts.isPropertySignature(member) &&
                    member.name.getText(ast) === "card",
            ),
    );
}

function staticVerification() {
    const main = sourceFile(mainFile);
    const ding = sourceFile(dingFile);
    assert.ok(typeHasCard(main.ast, "SavedDingPin"));
    assert.ok(typeHasCard(main.ast, "PinWorkspaceEntry"));
    assert.ok(typeHasCard(ding.ast, "SavedDingPin"));
    for (const required of [
        "card: sanitizeCardPinMetadata(p.card)",
        "card: sanitizeCardPinMetadata(pin.card)",
        "card?: CardPinMetadata",
    ])
        assert.ok(
            main.source.includes(required),
            `Missing main wiring: ${required}`,
        );
    for (const required of [
        "card: data.card",
        "pin.card",
        "showCardText(current",
        "더 많은 내용 · 전체 텍스트 보기",
        "metadata.qrError = result.ok ? undefined : result.error",
    ])
        assert.ok(
            ding.source.includes(required),
            `Missing renderer wiring: ${required}`,
        );

    const { retainCardText, sanitizeCardPinMetadata } =
        extractProductionSanitizer();
    const htmlUnicode = "<img id=unsafe onerror=alert(1)>🙂한글";
    const retained = retainCardText(htmlUnicode.repeat(520));
    assert.equal(retained.text, htmlUnicode.repeat(520));
    assert.equal(retained.truncated, false);
    assert.equal(retained.retainedLength, Array.from(retained.text).length);

    const overLimit = `${"🙂".repeat(200_000)}끝`;
    const capped = sanitizeCardPinMetadata({
        kind: "text",
        text: overLimit,
        sourceLength: 200_001,
        retainedLength: 200_001,
        truncated: false,
    });
    assert.equal(Array.from(capped.text).length, 200_000);
    assert.equal(capped.text.endsWith("🙂"), true, "Unicode was split at cap");
    assert.equal(capped.sourceLength, 200_001);
    assert.equal(capped.retainedLength, 200_000);
    assert.equal(capped.truncated, true);
    assert.equal(sanitizeCardPinMetadata(null), undefined);
    assert.equal(
        sanitizeCardPinMetadata({ kind: "image", text: "x" }),
        undefined,
    );
    assert.equal(sanitizeCardPinMetadata({ kind: "text" }), undefined);
    const qr = sanitizeCardPinMetadata({
        kind: "qrcode",
        text: "safe",
        sourceLength: 4,
        retainedLength: 4,
        truncated: false,
        qrError: "e".repeat(300),
    });
    assert.equal(Array.from(qr.qrError).length, 240);
    return {
        name: "production sanitizer and serializer wiring",
        ok: true,
        cap: capped.retainedLength,
    };
}

if (!process.versions.electron) {
    const check = staticVerification();
    if (process.argv.includes("--static")) {
        console.log(JSON.stringify({ ok: true, checks: [check] }, null, 2));
        process.exit(0);
    }
    const { spawnSync } = require("node:child_process");
    const electron = require("electron");
    const childArgs = [__filename, "--electron-child"];
    if (process.argv.includes("--contrast-only"))
        childArgs.push("--contrast-only");
    const child = spawnSync(electron, childArgs, {
        cwd: root,
        stdio: "inherit",
        env: {
            ...process.env,
            ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        },
    });
    process.exit(child.status ?? 1);
}

const { app, BrowserWindow, clipboard, ipcMain } = require("electron");
const { pathToFileURL } = require("node:url");
const evidence = path.join(root, ".evidence", "pin-cards");
const profile = path.join(evidence, `profile-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
const report = { checks: [staticVerification()], errors: [], screenshots: [] };
let originalClipboard = "";
let lastCopiedFixture = "";
const textHash = (value) =>
    createHash("sha256").update(value).digest("hex").slice(0, 12);
const normalizeClipboardText = (value) => value.replace(/\r\n/g, "\n");
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
let sessionSaved = [];
let sessionRestore = [];
let latestPins = [];
let pinQueryRevision = 0;
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

const builtPage = path.join(root, "out", "renderer", "ding.html");
assert.ok(fs.existsSync(builtPage), "Build missing: run pnpm run build first");
const finish = async (code) => {
    report.ok = report.checks.every((item) => item.ok) && !report.errors.length;
    if (lastCopiedFixture) {
        const current = await clipboard.readText();
        if (current === lastCopiedFixture)
            await clipboard.writeText(originalClipboard);
    }
    fs.writeFileSync(
        path.join(evidence, "report.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(code);
};
const timeout = setTimeout(() => {
    report.errors.push("Pin card verification timed out");
    void finish(1);
}, 120_000);

app.whenReady().then(async () => {
    const contrastOnly = process.argv.includes("--contrast-only");
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
    win.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(true),
    );
    const load = async () => {
        await win.loadURL(pathToFileURL(builtPage).href);
        await until(
            () => win.webContents.executeJavaScript("Boolean(document.body)"),
            "Ding renderer did not load",
        );
        const revision = pinQueryRevision;
        await until(async () => {
            win.webContents.send("ipc", "dingQuery", []);
            await pause(20);
            return pinQueryRevision > revision;
        }, "Ding IPC listeners did not become ready");
    };
    const sendPin = (id, type, card, visual = {}) => {
        win.webContents.send("ipc", "addDing", [
            id,
            visual.x ?? 320,
            visual.y ?? 260,
            visual.w ?? 0,
            visual.h ?? 0,
            visual.src ?? "",
            type,
            { text: card.text, card },
        ]);
    };
    const queryPins = async () => {
        const revision = pinQueryRevision;
        win.webContents.send("ipc", "dingQuery", []);
        await until(
            () => pinQueryRevision > revision,
            "Pin query did not return",
        );
        return latestPins;
    };
    const openText = async (id) => {
        await win.webContents.executeJavaScript(
            "for(const dialog of document.querySelectorAll('.pin-card-dialog[open]')) dialog.close()",
        );
        await until(
            () =>
                win.webContents.executeJavaScript(
                    "!document.querySelector('.pin-card-dialog[open]')",
                ),
            "Previous text dialog did not close",
        );
        win.show();
        win.focus();
        await win.webContents.executeJavaScript(
            `document.getElementById(${JSON.stringify(String(id))}).querySelector('.pin-card-actions button').click()`,
        );
        await until(
            () =>
                win.webContents.executeJavaScript(
                    "Boolean(document.querySelector('.pin-card-dialog[open]'))",
                ),
            "Full text dialog did not open",
        );
        return await win.webContents.executeJavaScript(`(() => {
            const dialog=document.querySelector('.pin-card-dialog[open]');
            return {value:dialog.querySelector('textarea').value,note:dialog.querySelector('.pin-card-dialog-note').textContent,
                buttons:[...dialog.querySelectorAll('button')].map(button=>button.textContent)};
        })()`);
    };
    const copyFromDialog = async (expected) => {
        await win.webContents.executeJavaScript(
            "document.querySelector('.pin-card-dialog[open] .pin-card-dialog-actions button').click()",
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await pause(50);
            const rendererClipboard = await win.webContents.executeJavaScript(
                "navigator.clipboard.readText()",
            );
            if (normalizeClipboardText(rendererClipboard) === expected) {
                lastCopiedFixture = rendererClipboard;
                return;
            }
        }
        const status = await win.webContents.executeJavaScript(
            "document.querySelector('.pin-card-dialog[open] .pin-card-dialog-status')?.textContent",
        );
        const observed = await win.webContents.executeJavaScript(
            "navigator.clipboard.readText()",
        );
        throw new Error(
            `Clipboard mismatch after 2s: expected=${expected.length}/${textHash(expected)} observed=${observed.length}/${textHash(observed)} normalized=${normalizeClipboardText(observed).length}/${textHash(normalizeClipboardText(observed))} status=${status}`,
        );
    };
    const closeDialog = () =>
        win.webContents.executeJavaScript(
            "document.querySelector('.pin-card-dialog[open]')?.close()",
        );

    try {
        await load();
        sendPin(77, "text", {
            kind: "text",
            text: "Readable Aa 123",
            sourceLength: 15,
            retainedLength: 15,
            truncated: false,
        });
        await check("default theme text card contrast", async () => {
            await until(
                () =>
                    win.webContents.executeJavaScript(
                        "Boolean(document.getElementById('77')?.querySelector('.img > img')?.complete)",
                    ),
                "Default theme card did not render",
            );
            const colors = await win.webContents.executeJavaScript(`(() => {
                const root=getComputedStyle(document.documentElement);
                const image=document.getElementById('77').querySelector('.img > img');
                const canvas=document.createElement('canvas');
                canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
                const context=canvas.getContext('2d'); context.drawImage(image,0,0);
                const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
                const counts=new Map();
                for(let i=0;i<pixels.length;i+=4){
                    if(pixels[i+3]<250)continue;
                    const key=(pixels[i]<<16)|(pixels[i+1]<<8)|pixels[i+2];
                    counts.set(key,(counts.get(key)||0)+1);
                }
                const background=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
                const rgb=key=>[(key>>16)&255,(key>>8)&255,key&255];
                const luminance=key=>{
                    const values=rgb(key).map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});
                    return .2126*values[0]+.7152*values[1]+.0722*values[2];
                };
                const base=luminance(background); let maxContrast=1; let readablePixels=0;
                for(const [key,count] of counts){
                    const value=luminance(key); const ratio=(Math.max(base,value)+.05)/(Math.min(base,value)+.05);
                    maxContrast=Math.max(maxContrast,ratio); if(ratio>=4.5)readablePixels+=count;
                }
                return {background:rgb(background),maxContrast,readablePixels,
                    cssBackground:root.getPropertyValue('--bg').trim(),cssForeground:root.getPropertyValue('--font-color').trim(),
                    prefersDark:matchMedia('(prefers-color-scheme: dark)').matches};
            })()`);
            win.webContents.send("ipc", "dingShare", [
                { type: "close", id: "77", closeAll: false },
            ]);
            await until(
                () =>
                    win.webContents.executeJavaScript(
                        "!document.getElementById('77')",
                    ),
                "Default theme fixture did not close",
            );
            assert.ok(colors.maxContrast >= 4.5, JSON.stringify(colors));
            assert.ok(colors.readablePixels >= 12, JSON.stringify(colors));
            return colors;
        });
        if (contrastOnly) {
            clearTimeout(timeout);
            await finish(report.checks.every((item) => item.ok) ? 0 : 1);
            return;
        }
        originalClipboard = await clipboard.readText();
        const html = "<img id=unsafe onerror=alert(1)>";
        const longText = `${html}\n${Array.from({ length: 23 }, (_, i) => `줄-${i}-🙂`).join("\n")}\n${"한글🙂".repeat(7000)}`;
        const longLength = Array.from(longText).length;
        sendPin(101, "text", {
            kind: "text",
            text: longText,
            sourceLength: longLength,
            retainedLength: longLength,
            truncated: false,
        });
        await until(
            () =>
                win.webContents.executeJavaScript(
                    "document.querySelectorAll('.pin-card-actions').length===1",
                ),
            "Long text pin missing",
        );
        await check("long Unicode/HTML text viewer and copy", async () => {
            const view = await openText(101);
            assert.equal(view.value, longText);
            assert.equal(
                await win.webContents.executeJavaScript(
                    "Boolean(document.getElementById('unsafe'))",
                ),
                false,
            );
            await copyFromDialog(longText);
            await closeDialog();
            return { retained: longLength, lines: 25 };
        });

        await until(
            () => sessionSaved.length === 1,
            "Session was not saved",
            90,
        );
        await check("session metadata restore and copy", async () => {
            const saved = sessionSaved[0];
            assert.deepEqual(saved.card, {
                kind: "text",
                text: longText,
                sourceLength: longLength,
                retainedLength: longLength,
                truncated: false,
            });
            sessionRestore = sessionSaved;
            await load();
            await until(
                () =>
                    win.webContents.executeJavaScript(
                        "document.querySelectorAll('.pin-card-actions').length===1",
                    ),
                "Restored card actions missing",
            );
            const restored = await queryPins();
            assert.deepEqual(restored[0].card, saved.card);
            const view = await openText(restored[0].id);
            assert.equal(view.value, longText);
            await copyFromDialog(longText);
            await closeDialog();
            return { restored: true };
        });

        await check(
            "workspace payload restore preserves card metadata",
            async () => {
                const workspacePin = (await queryPins())[0];
                sendPin(202, "ding", workspacePin.card, workspacePin);
                await until(
                    () =>
                        win.webContents.executeJavaScript(
                            "document.querySelectorAll('.pin-card-actions').length===2",
                        ),
                    "Workspace-restored card missing",
                );
                const pins = await queryPins();
                assert.deepEqual(
                    pins.find((pin) => pin.id === "202").card,
                    workspacePin.card,
                );
                return { restored: true };
            },
        );

        const qrText = `QR-${"용량초과🙂".repeat(1200)}`;
        const qrLength = Array.from(qrText).length;
        sendPin(303, "qrcode", {
            kind: "qrcode",
            text: qrText,
            sourceLength: qrLength,
            retainedLength: qrLength,
            truncated: false,
        });
        await check(
            "QR capacity failure is explicit and copyable",
            async () => {
                const pins = await until(async () => {
                    const queried = await queryPins();
                    const pin = queried.find((item) => item.id === "303");
                    return pin?.card?.qrError ? queried : null;
                }, "QR error state missing");
                const qr = pins.find((pin) => pin.id === "303");
                assert.ok(qr.card.qrError);
                const actionCount = await win.webContents.executeJavaScript(
                    "document.getElementById('303').querySelectorAll('.pin-card-actions button').length",
                );
                assert.equal(actionCount, 3, "QR retry action missing");
                const view = await openText(303);
                assert.equal(view.value, qrText);
                assert.ok(view.note.includes(qr.card.qrError));
                await copyFromDialog(qrText);
                await closeDialog();
                return { error: qr.card.qrError };
            },
        );

        const cappedText = "🙂".repeat(200_000);
        sendPin(404, "text", {
            kind: "text",
            text: cappedText,
            sourceLength: 200_001,
            retainedLength: 200_000,
            truncated: true,
        });
        await check("200k retention boundary is disclosed", async () => {
            await until(
                () =>
                    win.webContents.executeJavaScript(
                        "Boolean(document.getElementById('404')?.querySelector('.pin-card-actions'))",
                    ),
                "Capped text pin missing",
            );
            const view = await openText(404);
            assert.equal(Array.from(view.value).length, 200_000);
            assert.ok(
                view.note.includes("200,001") || view.note.includes("200001"),
            );
            assert.ok(
                view.note.includes("200,000") || view.note.includes("200000"),
            );
            await closeDialog();
            return { retained: 200_000, source: 200_001 };
        });

        fs.writeFileSync(
            path.join(evidence, "pin-cards.png"),
            (await win.webContents.capturePage()).toPNG(),
        );
        report.screenshots.push("pin-cards.png");
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
