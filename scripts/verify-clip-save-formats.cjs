const { app, BrowserWindow, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "clip-save-formats");
const fixtures = path.join(evidence, "fixtures");
const outDir = path.join(evidence, `saved-${Date.now()}`);
const profile = path.join(evidence, `profile-${Date.now()}`);
for (const dir of [fixtures, outDir, profile])
    fs.mkdirSync(dir, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", fixtures);
process.argv.push(`--userData=${profile}`);

const rendererErrors = [];
app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (event) => {
        if (event.level === "error") rendererErrors.push(event.message);
    });
});

require("../out/main/main.js");

let pendingSavePath = "";
const originalSaveDialog = dialog.showSaveDialog;
dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: pendingSavePath,
});

const report = { checks: [], rendererErrors };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => {
    if (!value) throw new Error(message);
};
async function until(check, message, attempts = 240) {
    for (let index = 0; index < attempts; index++) {
        const result = await check();
        if (result) return result;
        await pause(100);
    }
    throw new Error(message);
}

const timer = setTimeout(() => {
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
            "Dashboard did not load",
        );
        dashboard.show();
        dashboard.focus();
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    'Boolean(window.openCapture && document.querySelector(".nav-button"))',
                ),
            "Dashboard API did not initialize",
        );
        await run(`localStorage.setItem("oc:onboarded", "1");
            for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
            const backdrop = document.querySelector(".modal-backdrop"); if (backdrop) backdrop.hidden = true;`);
        await run(
            'window.openCapture.action("configure-workflow", { autoOcr:false, autoPreview:false, autoClipboard:false })',
        );

        const fixtureData = await run(`(() => {
            const c = document.createElement('canvas'); c.width = 360; c.height = 260;
            const x = c.getContext('2d');
            x.fillStyle = '#f4f4f5'; x.fillRect(0,0,c.width,c.height);
            x.fillStyle = '#7c3aed'; x.fillRect(40,40,120,120);
            x.fillStyle = '#0ea5e9'; x.beginPath(); x.arc(260,140,70,0,Math.PI*2); x.fill();
            x.font='700 28px Segoe UI'; x.fillStyle = '#111'; x.fillText('SAVE', 60, 220);
            return c.toDataURL('image/png');
        })()`);
        const file = path.join(fixtures, "save-source.png");
        fs.writeFileSync(file, Buffer.from(fixtureData.split(",")[1], "base64"));

        await run(`(() => { const input=document.createElement('input'); input.type='file'; input.id='save-qa-file'; input.hidden=true; document.body.append(input); })()`);
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#save-qa-file" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: [file] },
        );
        const state = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#save-qa-file").files))',
        );
        assert(state.items.length === 1, "Save fixture import failed");
        const itemId = state.items[0].id;

        const signatures = {
            avif: (bytes) =>
                bytes.length > 12 &&
                bytes.toString("ascii", 4, 8) === "ftyp" &&
                /^(avif|avis)$/.test(bytes.toString("ascii", 8, 12)),
            ico: (bytes) =>
                bytes.length >= 4 &&
                bytes[0] === 0 &&
                bytes[1] === 0 &&
                bytes[2] === 1 &&
                bytes[3] === 0,
            gif: (bytes) =>
                bytes.length >= 6 &&
                /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6)),
        };
        const results = {};
        for (const format of ["avif", "ico", "gif"]) {
            pendingSavePath = path.join(outDir, `qa-save.${format}`);
            await run(
                `window.openCapture.action("open-item", ${JSON.stringify(itemId)})`,
            );
            const capture = await until(
                () =>
                    BrowserWindow.getAllWindows().find(
                        (window) =>
                            window.webContents
                                .getURL()
                                .includes("capture.html") &&
                            !window.webContents.isLoading() &&
                            window.isVisible(),
                    ),
                `Capture editor did not open for ${format}`,
            );
            const clip = (code) =>
                capture.webContents.executeJavaScript(code, true);
            await until(
                () =>
                    clip(
                        'Boolean(window.captureDraftBridge && document.querySelector("#quick_toolbar") && document.body.style.opacity !== "0")',
                    ),
                `Workspace did not initialize for ${format}`,
            );
            const photo = await clip(
                'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
            );
            const start = {
                x: Math.round(photo.x + photo.width * 0.15),
                y: Math.round(photo.y + photo.height * 0.15),
            };
            const end = {
                x: Math.round(photo.x + photo.width * 0.8),
                y: Math.round(photo.y + photo.height * 0.8),
            };
            capture.webContents.sendInputEvent({
                type: "mouseMove",
                ...start,
            });
            capture.webContents.sendInputEvent({
                type: "mouseDown",
                button: "left",
                clickCount: 1,
                ...start,
            });
            capture.webContents.sendInputEvent({
                type: "mouseMove",
                ...end,
            });
            capture.webContents.sendInputEvent({
                type: "mouseUp",
                button: "left",
                clickCount: 1,
                ...end,
            });
            await until(
                () =>
                    clip(
                        'document.querySelector("#selection_handles")?.hidden === false',
                    ),
                `Selection was not created for ${format}`,
            );
            await clip(`(() => {
                const save=document.querySelector('#quick_toolbar [data-capture-action="save"]');
                if (save) { save.click(); return true; }
                document.querySelector('#quick_toolbar [data-capture-action="more"]')?.click();
                const tool=[...document.querySelectorAll('#capture_tools [data-capture-action="save"]')][0];
                if (!tool) return false;
                tool.click();
                return true;
            })()`);
            await until(
                () =>
                    clip(
                        `Boolean([...document.querySelectorAll('#suffix [data-value]')].find((n)=>n.dataset.value===${JSON.stringify(format)}))`,
                    ),
                `Save bar did not expose ${format}`,
            );
            await clip(
                `document.querySelector('#suffix [data-value="${format}"]').click()`,
            );
            await until(
                () =>
                    fs.existsSync(pendingSavePath) &&
                    fs.statSync(pendingSavePath).size > 100,
                `${format} file was not written`,
            );
            const bytes = fs.readFileSync(pendingSavePath);
            assert(
                signatures[format](bytes),
                `${format} signature mismatch (head: ${bytes.subarray(0, 16).toString("hex")})`,
            );
            results[format] = bytes.length;
            await until(
                () => capture.isDestroyed() || !capture.isVisible(),
                `Capture did not close after ${format} save`,
            );
        }
        report.checks.push({ clipSaveFormats: results });

        pendingSavePath = path.join(outDir, "no-such-dir", "qa-fail.png");
        await run(
            `window.openCapture.action("open-item", ${JSON.stringify(itemId)})`,
        );
        const failCapture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("capture.html") &&
                        !window.webContents.isLoading() &&
                        window.isVisible(),
                ),
            "Capture editor did not open for save failure case",
        );
        const failClip = (code) =>
            failCapture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                failClip(
                    'Boolean(window.captureDraftBridge && document.querySelector("#quick_toolbar") && document.body.style.opacity !== "0")',
                ),
            "Workspace did not initialize for save failure case",
        );
        const failPhoto = await failClip(
            'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
        );
        failCapture.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(failPhoto.x + failPhoto.width * 0.15),
            y: Math.round(failPhoto.y + failPhoto.height * 0.15),
        });
        failCapture.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            x: Math.round(failPhoto.x + failPhoto.width * 0.15),
            y: Math.round(failPhoto.y + failPhoto.height * 0.15),
        });
        failCapture.webContents.sendInputEvent({
            type: "mouseMove",
            x: Math.round(failPhoto.x + failPhoto.width * 0.8),
            y: Math.round(failPhoto.y + failPhoto.height * 0.8),
        });
        failCapture.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: Math.round(failPhoto.x + failPhoto.width * 0.8),
            y: Math.round(failPhoto.y + failPhoto.height * 0.8),
        });
        await until(
            () =>
                failClip(
                    'document.querySelector("#selection_handles")?.hidden === false',
                ),
            "Selection was not created for save failure case",
        );
        await failClip(`(() => {
            const save=document.querySelector('#quick_toolbar [data-capture-action="save"]');
            if (save) { save.click(); return true; }
            document.querySelector('#quick_toolbar [data-capture-action="more"]')?.click();
            const tool=[...document.querySelectorAll('#capture_tools [data-capture-action="save"]')][0];
            if (!tool) return false;
            tool.click();
            return true;
        })()`);
        await until(
            () =>
                failClip(
                    `Boolean([...document.querySelectorAll('#suffix [data-value]')].find((n)=>n.dataset.value==='png'))`,
                ),
            "Save bar did not expose png",
        );
        await failClip(
            `document.querySelector('#suffix [data-value="png"]').click()`,
        );
        await pause(1500);
        assert(
            !fs.existsSync(pendingSavePath),
            "Save failure case unexpectedly wrote a file",
        );
        assert(
            !failCapture.isDestroyed() && failCapture.isVisible(),
            `Capture lost after failed save (destroyed=${failCapture.isDestroyed()}, visible=${failCapture.isDestroyed() ? "n/a" : failCapture.isVisible()})`,
        );
        report.checks.push({ saveFailureKeepsEditor: true });
        await failClip(
            "document.querySelector('#quick_toolbar [data-capture-action=close]')?.click()",
        );
        await until(
            () => failCapture.isDestroyed() || !failCapture.isVisible(),
            "Capture did not close after save failure case",
        );
        dialog.showSaveDialog = originalSaveDialog;

        report.ok = true;
        report.checks.push({ rendererErrorCount: rendererErrors.length });
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        clearTimeout(timer);
        app.exit(rendererErrors.length ? 2 : 0);
    } catch (error) {
        dialog.showSaveDialog = originalSaveDialog;
        report.ok = false;
        report.failure = String(error);
        report.checks.push({ rendererErrorCount: rendererErrors.length });
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        clearTimeout(timer);
        app.exit(1);
    }
});
