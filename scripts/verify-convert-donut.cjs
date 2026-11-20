const { app, BrowserWindow, clipboard, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "convert-donut");
const fixtures = path.join(evidence, "fixtures");
const outDir = path.join(evidence, `converted-out-${Date.now()}`);
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

const originalPicker = dialog.showOpenDialog;
dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [outDir],
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
                const c = document.createElement('canvas'); c.width = 420; c.height = 300;
                const x = c.getContext('2d');
                x.fillStyle = variant ? '#0f172a' : '#f8fafc'; x.fillRect(0,0,c.width,c.height);
                x.fillStyle = variant ? '#38bdf8' : '#dc2626';
                x.fillRect(50,60,140,140);
                x.fillStyle = variant ? '#facc15' : '#16a34a';
                x.beginPath(); x.arc(300,150,70,0,Math.PI*2); x.fill();
                x.font='700 30px Segoe UI';
                x.fillStyle = variant ? '#fff' : '#111';
                x.fillText(variant ? 'DONUT-B' : 'DONUT-A', 60, 260);
                return c.toDataURL('image/png');
            };
            return [make(0), make(1)];
        })()`);
        const paths = fixtureData.map((data, index) => {
            const file = path.join(fixtures, `donut-${index + 1}.png`);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            return file;
        });

        await run(`(() => { const input=document.createElement('input'); input.type='file'; input.multiple=true;
            input.id='donut-qa-files'; input.hidden=true; document.body.append(input); })()`);
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#donut-qa-files" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            { nodeId, files: paths },
        );
        const state = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#donut-qa-files").files))',
        );
        assert(state.items.length === 2, "Donut fixture imports failed");

        await run('document.querySelectorAll(".nav-button")[1].click()');
        await until(
            () => run('document.querySelectorAll(".item-select").length === 2'),
            "Library fixtures did not render",
        );
        for (let index = 0; index < 2; index++)
            await run(
                `document.querySelectorAll('.item-select')[${index}].click()`,
            );
        const checkedCount = await run(
            'document.querySelectorAll(".item-select:checked").length',
        );
        assert(
            checkedCount === 2,
            `Expected 2 selected items, saw ${checkedCount}`,
        );
        await run(
            '[...document.querySelectorAll(".bulk-action")].find((b)=>b.textContent.trim().startsWith("변환"))?.click()',
        );
        await until(
            () => run('Boolean(document.querySelector(".convert-donut"))'),
            "Convert donut did not open",
        );

        const configured = await run(`(() => {
            const donut=document.querySelector('.convert-donut');
            const details=donut.querySelector('.convert-donut-options');
            details.open=true;
            const formatSelect=donut.querySelector('.convert-donut-controls select');
            formatSelect.value='webp';
            formatSelect.dispatchEvent(new Event('change',{bubbles:true}));
            const checked=[];
            for (const wrap of donut.querySelectorAll('.convert-donut-format-check')) {
                const label=wrap.querySelector('span').textContent.toLowerCase();
                const input=wrap.querySelector('input');
                if (['png','jpg','avif'].includes(label) && !input.checked) input.click();
                if (input.checked) checked.push(label);
            }
            const checks=[...donut.querySelectorAll('.convert-donut-option-grid .convert-donut-check input')];
            for (const box of checks) if (!box.checked) box.click();
            const dirRow=[...donut.querySelectorAll('[data-convert-out-dir]')][0].closest('.convert-donut-inline-actions');
            const [pick]=dirRow.querySelectorAll('button');
            pick.click();
            return {format:formatSelect.value,extra:checked,checks:checks.map((c)=>c.checked)};
        })()`);
        assert(
            configured.format === "webp" &&
                configured.extra.includes("png") &&
                configured.extra.includes("jpg") &&
                configured.extra.includes("avif") &&
                configured.checks.every(Boolean),
            `Donut controls did not configure: ${JSON.stringify(configured)}`,
        );
        await until(
            () =>
                run(
                    'document.querySelector("[data-convert-out-dir]")?.textContent.trim().length > 0',
                ),
            "Output directory was not picked",
        );

        await run(
            'document.querySelector("[data-convert-action=convert]").click()',
        );
        try {
            await until(
                () =>
                    run(`(() => {
                    const rows=[...document.querySelectorAll('.convert-donut-result-row')];
                    if (rows.length !== 8) return false;
                    return rows.every((row)=>!['pending','converting'].includes(row.dataset.status))
                        && document.querySelector('[data-convert-action=convert]').disabled === false;
                })()`),
                "Conversion rows did not settle",
            );
        } catch (error) {
            const dump = await run(`(() => ({
                error: document.querySelector('.convert-donut-error')?.textContent ?? '',
                rows: [...document.querySelectorAll('.convert-donut-result-row')].map((row)=>row.dataset.status),
                disabled: document.querySelector('[data-convert-action=convert]')?.disabled,
                summary: document.querySelector('.convert-donut-results-header span')?.textContent ?? '',
            }))()`);
            throw new Error(
                `${error} :: ${JSON.stringify(dump)}`,
            );
        }
        const rows = await run(
            `[...document.querySelectorAll('.convert-donut-result-row')].map((row)=>({status:row.dataset.status,output:row.dataset.outputPath??"",format:row.querySelector('strong')?.textContent??"",registration:row.querySelector('.convert-donut-row-status')?.dataset.registrationStatus??""}))`,
        );
        const written = rows.filter((row) => row.status === "written");
        assert(
            written.length === 8,
            `Expected 8 written rows, saw ${JSON.stringify(rows)}`,
        );
        assert(
            written.every((row) => row.output.startsWith(outDir)),
            `Rows were not written into the picked directory: ${JSON.stringify(written.map((row) => row.output))}`,
        );
        const extensions = new Set(
            written.map((row) => path.extname(row.output).slice(1)),
        );
        assert(
            extensions.has("webp") &&
                extensions.has("png") &&
                extensions.has("avif") &&
                (extensions.has("jpg") || extensions.has("jpeg")),
            `Missing converted formats: ${JSON.stringify([...extensions])}`,
        );
        const files = fs.readdirSync(outDir);
        assert(
            files.length === 8,
            `Expected 8 files in outDir, saw ${files.length}: ${JSON.stringify(files)}`,
        );
        const signatures = {
            png: (b) =>
                b.length > 8 && b.toString("hex", 0, 8) === "89504e470d0a1a0a",
            jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
            jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
            webp: (b) =>
                b.length > 12 &&
                b.toString("ascii", 0, 4) === "RIFF" &&
                b.toString("ascii", 8, 12) === "WEBP",
            avif: (b) =>
                b.length > 12 &&
                b.toString("ascii", 4, 8) === "ftyp" &&
                /^(avif|avis)$/.test(b.toString("ascii", 8, 12)),
        };
        for (const row of written) {
            const ext = path.extname(row.output).slice(1).toLowerCase();
            const check = signatures[ext];
            if (!check) continue;
            assert(
                check(fs.readFileSync(row.output)),
                `Signature mismatch for ${row.output}`,
            );
        }
        await shot(dashboard, "convert-donut-results");

        const copied = await until(
            async () => {
                const items = await clipboard.read();
                const imageItem = items.find((item) =>
                    item.types.some((type) => type.startsWith("image/")),
                );
                return imageItem ? imageItem.types : false;
            },
            "First converted result was not copied to the clipboard",
        );
        const registered = written.filter(
            (row) =>
                row.registration === "registered" ||
                row.registration === "duplicate",
        ).length;
        report.checks.push({
            convertDonut: {
                rows: rows.map((row) => ({
                    status: row.status,
                    format: row.format,
                    registration: row.registration,
                })),
                outDirFiles: files,
                extensions: [...extensions],
                registeredRows: registered,
                clipboardTypes: copied,
            },
        });
        dialog.showOpenDialog = originalPicker;

        report.ok = true;
        report.checks.push({ rendererErrorCount: rendererErrors.length });
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        clearTimeout(timer);
        app.exit(rendererErrors.length ? 2 : 0);
    } catch (error) {
        dialog.showOpenDialog = originalPicker;
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
