const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "compare-entry");
const fixtures = path.join(evidence, "fixtures");
const profile = path.join(evidence, `profile-${Date.now()}`);
fs.mkdirSync(fixtures, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
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
async function shot(window, name) {
    await pause(200);
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(evidence, `${name}.png`), image.toPNG());
}

const timer = setTimeout(() => {
    report.ok = false;
    report.timeout = true;
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    app.exit(1);
}, 120_000);

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
            const make = (variant) => {
                const c = document.createElement('canvas'); c.width = 640; c.height = 400;
                const x = c.getContext('2d');
                x.fillStyle = variant ? '#101828' : '#f2f4f7'; x.fillRect(0,0,c.width,c.height);
                x.fillStyle = variant ? '#f2f4f7' : '#101828';
                x.fillRect(40,40,240,120);
                x.fillStyle = variant ? '#7c3aed' : '#0ea5e9';
                x.beginPath(); x.arc(430,220,90,0,Math.PI*2); x.fill();
                x.font='700 40px Segoe UI';
                x.fillStyle = variant ? '#fff' : '#000';
                x.fillText(variant ? 'ENTRY-B' : 'ENTRY-A', 60, 320);
                return c.toDataURL('image/png');
            };
            return [make(0), make(1)];
        })()`);
        const paths = fixtureData.map((data, index) => {
            const file = path.join(fixtures, `entry-${index + 1}.png`);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            return file;
        });

        await run(`(() => { const input=document.createElement('input'); input.type='file'; input.multiple=true;
            input.id='compare-entry-files'; input.hidden=true; document.body.append(input); })()`);
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#compare-entry-files" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: paths },
        );
        const state = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#compare-entry-files").files))',
        );
        assert(state.items.length === 2, "Fixture imports failed");
        const itemIds = state.items.map((item) => item.id);
        assert(
            itemIds.every(Boolean),
            `Imported item ids missing: ${JSON.stringify(state.items)}`,
        );

        await run(
            `window.openCapture.action("open-item", ${JSON.stringify(itemIds[0])})`,
        );
        const capture = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("capture.html") &&
                        !window.webContents.isLoading(),
                ),
            "Capture editor did not load",
        );
        const clip = (code) =>
            capture.webContents.executeJavaScript(code, true);
        await until(
            () =>
                clip(
                    'Boolean(window.captureDraftBridge && document.querySelector("#quick_toolbar") && document.body.style.opacity !== "0")',
                ),
            "Capture workspace did not initialize",
        );
        const selectRegion = async (fromX, fromY, sizeX, sizeY) => {
            const photo = await clip(
                'JSON.parse(JSON.stringify(document.querySelector("#main_photo").getBoundingClientRect()))',
            );
            const start = {
                x: Math.round(photo.x + photo.width * fromX),
                y: Math.round(photo.y + photo.height * fromY),
            };
            const end = {
                x: Math.round(start.x + photo.width * sizeX),
                y: Math.round(start.y + photo.height * sizeY),
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
                "Region selection was not created",
            );
        };
        await selectRegion(0.12, 0.15, 0.6, 0.55);
        const stagedA = await clip("window.captureDraftBridge.stage()");
        assert(stagedA?.id, "First draft did not stage");
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length >= 1',
                ),
            "First staged draft missing from inline shelf",
        );

        await run(
            `window.openCapture.action("open-item", ${JSON.stringify(itemIds[1])})`,
        );
        await until(
            async () => {
                const info = await clip("window.captureDraftBridge.info()");
                return info && info.id !== stagedA.id ? info : false;
            },
            "Second image did not load into the capture editor",
        );
        await until(
            () =>
                clip(
                    'document.body.style.opacity !== "0" && Boolean(document.querySelector("#main_photo"))',
                ),
            "Second image did not finish rendering",
        );
        await selectRegion(0.2, 0.2, 0.5, 0.5);
        const stagedB = await clip("window.captureDraftBridge.stage()");
        assert(
            stagedB?.id && stagedB.id !== stagedA.id,
            "Second draft did not stage a distinct id",
        );
        await until(
            () =>
                clip(
                    'document.querySelectorAll("#capture_inline_shelf .capture-shelf-thumb").length >= 2',
                ),
            "Second staged draft missing from inline shelf",
        );

        await run(`(() => {
            const search=document.querySelector('.search-input');
            search.value='qa-no-match-filter';
            search.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);
        await until(
            () =>
                run('document.querySelectorAll(".item-select").length === 0'),
            "Active search filter did not empty the catalog",
        );

        await clip(`(() => {
            const compare=document.querySelector('#quick_toolbar [data-capture-action="compare"]');
            if (compare) { compare.click(); return true; }
            document.querySelector('#quick_toolbar [data-capture-action="more"]')?.click();
            const tool=[...document.querySelectorAll('#capture_tools [data-capture-action="compare"]')][0];
            if (!tool) return false;
            tool.click();
            return true;
        })()`);
        const dialogOpened = await until(
            () => run('Boolean(document.querySelector(".rc-dialog[open]"))'),
            "Comparison dialog did not open through the clip entry path",
        );
        assert(dialogOpened, "Comparison dialog did not open");
        await until(
            () => run('!document.querySelector(".rc-canvas").hidden'),
            "Comparison images did not decode",
        );
        const pair = await run(`(() => {
            const [a,b]=document.querySelectorAll('.compare-pair-select');
            return {a:a.value,b:b.value,options:a.options.length};
        })()`);
        assert(
            pair.a === stagedA.id && pair.b === stagedB.id,
            `Requested pair did not load: ${JSON.stringify(pair)} expected ${stagedA.id}/${stagedB.id}`,
        );
        await shot(dashboard, "compare-entry-dialog");
        report.checks.push({
            clipCompareEntry: {
                staged: [stagedA.id, stagedB.id],
                pair,
                filterBypassed: true,
            },
        });

        await run('document.querySelector(".rc-dialog[open]")?.close()');
        await clip(
            "document.querySelector('#quick_toolbar [data-capture-action=close]')?.click()",
        );

        report.ok = true;
        report.checks.push({ rendererErrorCount: rendererErrors.length });
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        clearTimeout(timer);
        app.exit(rendererErrors.length ? 2 : 0);
    } catch (error) {
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
