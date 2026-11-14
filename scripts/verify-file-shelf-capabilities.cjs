const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

if (!process.versions.electron) {
    const { spawnSync } = require("node:child_process");
    const env = { ...process.env };
    env.ELECTRON_RUN_AS_NODE = undefined;
    const result = spawnSync(require("electron"), [__filename], {
        cwd: root,
        env,
        stdio: "inherit",
        timeout: 30_000,
        windowsHide: true,
    });
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = require("electron");
const evidence = path.join(
    root,
    ".evidence",
    "macos-code",
    `shelf-${Date.now()}`,
);
const profile = path.join(evidence, "profile");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
process.argv.push(`--userData=${profile}`);
const realConfig = path.join(
    app.getPath("appData"),
    "OpenCapture",
    "config.json",
);
const realBefore = fs.existsSync(realConfig)
    ? fs.readFileSync(realConfig)
    : null;
const report = {
    ok: false,
    scope: "Real production shelf renderer with controlled clipboard capability fixtures; no macOS native clipboard or permission emulation",
    checks: [],
    errors: [],
    realSettingsPreserved: false,
};
const preload = path.join(evidence, "fixture-preload.cjs");
fs.writeFileSync(
    preload,
    `const {contextBridge,ipcRenderer}=require('electron');
const arg=process.argv.find(value=>value.startsWith('--copy-max-files='));
const maximum=Number(arg.split('=')[1]);
contextBridge.exposeInMainWorld('fileShelf',{
 ready:async()=>({files:[{id:'first',name:'first.txt',folder:false,icon:''},{id:'second',name:'second.txt',folder:false,icon:''}],copyMaxFiles:maximum}),
 copy:ids=>ipcRenderer.invoke('qa:shelf-copy',ids),
 copyPath:ids=>ipcRenderer.invoke('qa:shelf-path',ids),
 reveal:async()=>{},drag:()=>({started:false}),close:()=>{},t:text=>text
});`,
);
app.on("window-all-closed", (event) => event.preventDefault());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, label) => {
    for (let index = 0; index < 100; index++) {
        if (await read()) return;
        await pause(20);
    }
    throw Error(`Timed out: ${label}`);
};

app.whenReady().then(async () => {
    try {
        for (const maximum of [1, 100]) {
            const copies = [];
            const paths = [];
            const win = new BrowserWindow({
                show: false,
                width: 320,
                height: 280,
                webPreferences: {
                    preload,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    additionalArguments: [`--copy-max-files=${maximum}`],
                },
            });
            const read = (expression) =>
                win.webContents.executeJavaScript(expression, true);
            const own = (event) => assert.equal(event.sender, win.webContents);
            ipcMain.handle("qa:shelf-copy", (event, ids) => {
                own(event);
                copies.push(ids);
            });
            ipcMain.handle("qa:shelf-path", (event, ids) => {
                own(event);
                paths.push(ids);
            });
            try {
                await win.loadFile(
                    path.join(root, "out/renderer/file_shelf.html"),
                );
                await until(
                    () =>
                        read(
                            "document.querySelectorAll('.file-shelf-row').length===2",
                        ),
                    "shelf rows",
                );
                assert.equal(await read("typeof require"), "undefined");
                assert.equal(
                    await read(
                        "document.querySelector('.file-shelf-actions button').disabled",
                    ),
                    maximum === 1,
                );
                assert.equal(
                    await read(
                        "document.querySelectorAll('.file-shelf-actions button')[1].disabled",
                    ),
                    false,
                );
                await read(
                    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
                );
                fs.writeFileSync(
                    path.join(evidence, `copy-cap-${maximum}-initial.png`),
                    (await win.webContents.capturePage()).toPNG(),
                );
                await read(
                    "document.querySelectorAll('.file-shelf-actions button')[1].click()",
                );
                await until(() => paths.length === 1, "multiple path copy");
                assert.deepEqual(paths[0], ["first", "second"]);
                await until(
                    () =>
                        read(
                            "!document.querySelectorAll('.file-shelf-actions button')[1].disabled",
                        ),
                    "path copy settled",
                );
                if (maximum === 1) {
                    await read(
                        "document.querySelector('.file-shelf-actions button').dispatchEvent(new MouseEvent('click',{bubbles:true}))",
                    );
                    assert.equal(
                        copies.length,
                        0,
                        "Disabled copy must also reject programmatic clicks",
                    );
                    await read(
                        "const checkbox=document.querySelector('.file-shelf-row input');checkbox.checked=false;checkbox.dispatchEvent(new Event('change',{bubbles:true}))",
                    );
                    assert.equal(
                        await read(
                            "document.querySelector('.file-shelf-actions button').disabled",
                        ),
                        false,
                    );
                    await read(
                        "document.querySelector('.file-shelf-actions button').click()",
                    );
                    await until(() => copies.length === 1, "single file copy");
                    assert.deepEqual(copies[0], ["second"]);
                } else {
                    await read(
                        "document.querySelector('.file-shelf-actions button').click()",
                    );
                    await until(
                        () => copies.length === 1,
                        "multiple file copy",
                    );
                    assert.deepEqual(copies[0], ["first", "second"]);
                }
                await read(
                    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
                );
                fs.writeFileSync(
                    path.join(evidence, `copy-cap-${maximum}.png`),
                    (await win.webContents.capturePage()).toPNG(),
                );
                report.checks.push({
                    copyMaxFiles: maximum,
                    pathCopy: "multiple",
                    fileCopy:
                        maximum === 1
                            ? "single; multiple rejected before bridge"
                            : "multiple",
                });
            } finally {
                win.destroy();
                ipcMain.removeHandler("qa:shelf-copy");
                ipcMain.removeHandler("qa:shelf-path");
            }
        }
        report.ok = true;
    } catch (error) {
        report.errors.push(error.stack || error.message);
    } finally {
        const after = fs.existsSync(realConfig)
            ? fs.readFileSync(realConfig)
            : null;
        report.realSettingsPreserved =
            realBefore === null
                ? after === null
                : realBefore.equals(after ?? Buffer.alloc(0));
        report.ok &&= report.realSettingsPreserved;
        fs.writeFileSync(
            path.join(evidence, "report.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify({ evidence, ...report }));
        if (report.ok) console.log("OPENCAPTURE_SHELF_CAPABILITIES_OK");
        app.exit(report.ok ? 0 : 1);
    }
});
