const { app, BrowserWindow, clipboard, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "workspace-comparison");
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
                const c = document.createElement('canvas'); c.width = 720; c.height = 460;
                const x = c.getContext('2d');
                x.fillStyle = variant === 2 ? '#141823' : '#f6f6f7'; x.fillRect(0,0,c.width,c.height);
                if (variant === 2) {
                    x.fillStyle='#7c3aed'; for(let i=0;i<18;i++){x.beginPath();x.arc(30+i*39,40+(i%4)*87,10+(i%3)*8,0,Math.PI*2);x.fill();}
                    x.fillStyle='#fff';x.font='700 34px Segoe UI';x.fillText('NO COMMON LAYOUT',150,225);
                    return c.toDataURL('image/png');
                }
                const dx = variant === 1 ? 24 : 0, dy = variant === 1 ? -14 : 0;
                x.save();x.translate(dx,dy);
                x.fillStyle='#17171a';x.fillRect(0,0,720,52);
                x.fillStyle='#fff';x.font='600 17px Segoe UI';x.fillText('Workspace reference',24,33);
                x.fillStyle='#e5e5e9';x.fillRect(20,76,176,356);
                x.fillStyle='#27272a';x.fillRect(230,85,420,38);
                x.fillStyle='#6b7280';x.fillRect(230,145,310,15);
                x.fillStyle='#d4d4da';x.fillRect(230,190,440,130);
                x.fillStyle='#18181b';x.fillRect(230,350,130,44);
                x.fillStyle='#fff';x.font='14px Segoe UI';x.fillText('Continue',265,378);
                x.strokeStyle='#52525b';x.lineWidth=3;x.strokeRect(386,340,210,64);
                x.restore();
                return c.toDataURL('image/png');
            };
            return [make(0),make(1),make(2)];
        })()`);
        const paths = fixtureData.map((data, index) => {
            const file = path.join(fixtures, `comparison-${index + 1}.png`);
            fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
            return file;
        });

        await run(`(() => { const input=document.createElement('input'); input.type='file'; input.multiple=true;
            input.id='comparison-qa-files'; input.hidden=true; document.body.append(input); })()`);
        dashboard.webContents.debugger.attach("1.3");
        const { root: documentRoot } =
            await dashboard.webContents.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await dashboard.webContents.debugger.sendCommand(
            "DOM.querySelector",
            { nodeId: documentRoot.nodeId, selector: "#comparison-qa-files" },
        );
        await dashboard.webContents.debugger.sendCommand(
            "DOM.setFileInputFiles",
            {
                nodeId,
                files: paths,
            },
        );
        const state = await run(
            'window.openCapture.importFiles(Array.from(document.querySelector("#comparison-qa-files").files))',
        );
        assert(state.items.length === 3, "Comparison fixture imports failed");

        await run('document.querySelectorAll(".nav-button")[1].click()');
        await until(
            () => run('document.querySelectorAll(".item-select").length === 3'),
            "Library fixtures did not render",
        );
        for (let index = 0; index < 3; index++) {
            await run(
                `document.querySelectorAll('.item-select')[${index}].click()`,
            );
        }
        assert(
            await run(
                'document.querySelectorAll(".item-select:checked").length === 3',
            ),
            "Reference selection failed",
        );
        await run('document.querySelector(".compare-action").click()');
        await until(
            () => run('Boolean(document.querySelector(".rc-dialog[open]"))'),
            "Reference comparison dialog did not open",
        );
        await until(
            () => run('!document.querySelector(".rc-canvas").hidden'),
            "Reference images did not decode",
        );
        const selectable = await run(
            '[...document.querySelectorAll(".compare-pair-select")].map(s=>s.options.length)',
        );
        assert(
            selectable.every((count) => count === 3),
            "Not all references are selectable",
        );
        await run(`(() => {
            const [a,b]=document.querySelectorAll('.compare-pair-select');
            a.value=[...a.options].find(o=>o.textContent.includes('comparison-1')).value;
            b.value=[...b.options].find(o=>o.textContent.includes('comparison-2')).value;
            a.dispatchEvent(new Event('change',{bubbles:true}));
            b.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await until(
            () => run('!document.querySelector(".rc-canvas").hidden'),
            "Known alignment pair did not load",
        );
        await shot(dashboard, "initial-side");

        await run(
            '[...document.querySelectorAll(".rc-panel button")].find(b=>b.textContent.includes("자동 정렬")).click()',
        );
        await until(
            () => run('!document.querySelector(".rc-panel button").disabled'),
            "Automatic alignment did not settle",
        );
        const aligned =
            await run(`(() => { const inputs=document.querySelectorAll('.rc-field-grid input');
            return {x:Number(inputs[0].value),y:Number(inputs[1].value),scale:Number(inputs[2].value),feedback:document.querySelector('.rc-panel .rc-help').textContent}; })()`);
        assert(
            Math.abs(aligned.x + 24) <= 5,
            `Alignment X is inaccurate: ${JSON.stringify(aligned)}`,
        );
        assert(
            Math.abs(aligned.y - 14) <= 5,
            `Alignment Y is inaccurate: ${JSON.stringify(aligned)}`,
        );
        assert(
            aligned.feedback.includes("정렬"),
            "Alignment success feedback missing",
        );
        report.checks.push({ automaticAlignment: aligned });

        const canvasRect = await run(
            'JSON.parse(JSON.stringify(document.querySelector(".rc-canvas").getBoundingClientRect()))',
        );
        const center = {
            x: Math.round(canvasRect.x + canvasRect.width / 2),
            y: Math.round(canvasRect.y + canvasRect.height / 2),
        };
        const beforePan = await run(
            'document.querySelector(".rc-canvas").toDataURL()',
        );
        dashboard.focus();
        dashboard.webContents.focus();
        await pause(200);
        dashboard.webContents.sendInputEvent({
            type: "mouseWheel",
            ...center,
            deltaY: -160,
        });
        await pause(120);
        const zoomText = await run(
            'document.querySelector(".rc-zoom-label").textContent',
        );
        const inputDiagnostic = await run(
            `(()=>{const c=document.querySelector('.rc-canvas'),r=c.getBoundingClientRect();return {status:document.querySelector('.rc-status').textContent,hidden:c.hidden,rect:{x:r.x,y:r.y,width:r.width,height:r.height},emptyHidden:document.querySelector('.rc-empty').hidden,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,300),zoom:getComputedStyle(document.body).zoom,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.className)};})()`,
        );
        assert(
            !zoomText.startsWith("100%"),
            `Linked zoom did not change: ${JSON.stringify({ inputDiagnostic, visible: dashboard.isVisible(), focused: dashboard.isFocused() })}`,
        );
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...center,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseMove",
            x: center.x + 34,
            y: center.y + 18,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            x: center.x + 34,
            y: center.y + 18,
        });
        await pause(120);
        const afterPan = await run(
            'document.querySelector(".rc-canvas").toDataURL()',
        );
        assert(
            beforePan !== afterPan,
            "Synchronized pan/zoom did not repaint both panes",
        );
        report.checks.push({ linkedPanZoom: { zoomText, repainted: true } });

        const beforeNudge = await run(
            'Number(document.querySelectorAll(".rc-field-grid input")[0].value)',
        );
        await run(`(() => { const c=document.querySelector('.rc-canvas'); c.focus();
            c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true})); })()`);
        const afterNudge = await run(
            'Number(document.querySelectorAll(".rc-field-grid input")[0].value)',
        );
        assert(
            afterNudge === beforeNudge + 10,
            "Shift+arrow did not nudge B by 10px",
        );

        await run(
            '[...document.querySelectorAll(".compare-mode-button")].find(b=>b.dataset.mode==="diff").click()',
        );
        const diffRange =
            await run(`(() => { const ranges=[...document.querySelectorAll('.rc-range')];
            const row=ranges.find(r=>r.textContent.includes('차이')); return {min:row.querySelector('input').min,max:row.querySelector('input').max}; })()`);
        const diffBefore = await run(
            'document.querySelector(".rc-canvas").toDataURL()',
        );
        await run(`(() => { const row=[...document.querySelectorAll('.rc-range')].find(r=>r.textContent.includes('차이'));
            const input=row.querySelector('input'); input.value='62'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        const diffAfter = await run(
            'document.querySelector(".rc-canvas").toDataURL()',
        );
        assert(
            diffBefore !== diffAfter,
            "Difference threshold did not change output",
        );
        report.checks.push({ difference: { ...diffRange, changed: true } });
        await shot(dashboard, "difference-view");

        await run(
            '[...document.querySelectorAll(".rc-zoom-mode button")].find(b=>b.textContent==="1:1").click()',
        );
        assert(
            await run(
                'document.querySelector(".rc-zoom-label").textContent.includes("1:1")',
            ),
            "Actual pixel mode is not explicit",
        );
        await run(
            '[...document.querySelectorAll(".rc-zoom-mode button")].find(b=>b.textContent.includes("맞춤")).click()',
        );
        assert(
            !(await run(
                'document.querySelector(".rc-zoom-label").textContent.includes("1:1")',
            )),
            "Fit mode did not replace actual pixel mode",
        );

        await run(
            '[...document.querySelectorAll(".compare-mode-button")].find(b=>b.dataset.mode==="opacity").click()',
        );
        await run(`(() => { const range=[...document.querySelectorAll('.rc-range')].find(r=>r.textContent.includes('불투명도')).querySelector('input');
            range.value='37'; range.dispatchEvent(new Event('input',{bubbles:true}));
            document.querySelector('.rc-text-input').value='QA reference session';
        })()`);
        await run(
            '[...document.querySelectorAll(".rc-footer button")].find(b=>b.textContent.includes("복사") && !b.hidden).click()',
        );
        await pause(250);
        const beforeNoteItems = await clipboard.read();
        const beforeNotePngItem = beforeNoteItems.find((item) =>
            item.types.includes("image/png"),
        );
        assert(beforeNotePngItem, "Baseline comparison export is unavailable");
        const beforeNoteBlob = await beforeNotePngItem.getType("image/png");
        const exportWithoutNote = Buffer.from(
            await beforeNoteBlob.arrayBuffer(),
        );
        await run(
            'document.querySelector(".rc-notes-panel .rc-secondary").click()',
        );
        const notePoint = {
            x: Math.round(canvasRect.x + canvasRect.width * 0.3),
            y: Math.round(canvasRect.y + canvasRect.height * 0.35),
        };
        dashboard.webContents.sendInputEvent({
            type: "mouseDown",
            button: "left",
            clickCount: 1,
            ...notePoint,
        });
        dashboard.webContents.sendInputEvent({
            type: "mouseUp",
            button: "left",
            clickCount: 1,
            ...notePoint,
        });
        await until(
            () => run('document.querySelectorAll(".rc-note-row").length === 1'),
            "Point note was not placed",
        );
        await run(`(() => { const input=document.querySelector('.rc-note-input'); input.value='Changed spacing';
            input.dispatchEvent(new Event('change',{bubbles:true}));
            [...document.querySelectorAll('.rc-panel button')].find(b=>b.textContent.includes('세션 저장')).click(); })()`);
        await until(
            () =>
                run(
                    'window.openCapture.listComparisons().then(s=>s.some(x=>x.name==="QA reference session"))',
                ),
            "Comparison session was not persisted through public API",
        );
        const saved = await run(
            'window.openCapture.listComparisons().then(s=>s.find(x=>x.name==="QA reference session"))',
        );
        assert(saved.zoomMode === "fit", "Session lost zoomMode");
        assert(saved.opacity === 37, "Session lost opacity");
        assert(
            saved.notes.length === 1 &&
                saved.notes[0].text === "Changed spacing",
            "Session lost point note",
        );

        await until(
            () =>
                run(
                    '[...document.querySelector(".rc-session-select").options].some(o=>o.textContent==="QA reference session")',
                ),
            "Saved session did not appear in the session picker",
        );

        await run(`(() => { document.querySelectorAll('.rc-field-grid input')[0].value='99';
            const select=document.querySelector('.rc-session-select'); select.value=[...select.options].find(o=>o.textContent==='QA reference session').value;
            select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await until(
            () =>
                run(
                    'Number(document.querySelectorAll(".rc-field-grid input")[0].value)!==99',
                ),
            "Saved comparison did not reopen",
        );
        assert(
            await run(
                'document.querySelectorAll(".rc-note-row").length===1 && document.querySelector(".rc-note-input").value==="Changed spacing"',
            ),
            "Reopened comparison did not restore note state",
        );
        report.checks.push({
            session: {
                mode: saved.mode,
                zoomMode: saved.zoomMode,
                opacity: saved.opacity,
                notes: saved.notes.length,
            },
        });

        await run(`(() => { const select=document.querySelectorAll('.compare-pair-select')[1];
            select.value=[...select.options].find(o=>o.textContent.includes('comparison-3')).value;
            select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await until(
            () => run('!document.querySelector(".rc-canvas").hidden'),
            "No-match reference did not load",
        );
        await run(
            '[...document.querySelectorAll(".rc-panel button")].find(b=>b.textContent.includes("자동 정렬")).click()',
        );
        await until(
            () =>
                run(
                    'document.querySelector(".rc-panel .rc-help").textContent.includes("찾지 못")',
                ),
            "No-match alignment did not report failure",
        );
        report.checks.push({ noMatchFeedback: true });

        await run(`(() => { const select=document.querySelectorAll('.compare-pair-select')[1];
            select.value=[...select.options].find(o=>o.textContent.includes('comparison-2')).value;
            select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await until(
            () => run('!document.querySelector(".rc-canvas").hidden'),
            "Export pair did not reload",
        );
        const copyButtonVisible = await run(
            'Boolean([...document.querySelectorAll(".rc-footer button")].find(b=>b.textContent.includes("복사") && !b.hidden))',
        );
        assert(copyButtonVisible, "Comparison PNG copy action is unavailable");
        await run(
            '[...document.querySelectorAll(".rc-footer button")].find(b=>b.textContent.includes("복사") && !b.hidden).click()',
        );
        await pause(350);
        const clipboardItems = await clipboard.read();
        const pngItem = clipboardItems.find((item) =>
            item.types.includes("image/png"),
        );
        assert(pngItem, "Comparison export did not write PNG clipboard data");
        const blob = await pngItem.getType("image/png");
        const png = Buffer.from(await blob.arrayBuffer());
        assert(
            !png.equals(exportWithoutNote),
            "Point note was not painted into comparison PNG export",
        );
        const exported = nativeImage.createFromBuffer(png);
        const exportedSize = exported.getSize();
        assert(
            exportedSize.width * exportedSize.height <= 16_000_000,
            "Comparison export exceeds 16MP",
        );
        fs.writeFileSync(path.join(evidence, "comparison-export.png"), png);
        report.checks.push({
            export: {
                ...exportedSize,
                pixels: exportedSize.width * exportedSize.height,
                noteIncluded: !png.equals(exportWithoutNote),
            },
        });
        await shot(dashboard, "session-notes");
        await run(`document.querySelector('.rc-header button').click()`);
        await run(`document.querySelector('.saved-comparison-button').click()`);
        await until(
            () =>
                run(
                    `document.querySelector('.rc-dialog[open]') && document.querySelector('.rc-note-input')?.value === 'Changed spacing'`,
                ),
            "Saved comparison did not reopen without image selection",
        );
        report.checks.push({ independentSessionReopen: true });

        assert(
            !rendererErrors.length,
            `Renderer errors occurred: ${rendererErrors.join("; ")}`,
        );
        report.ok = true;
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.log("WORKSPACE_COMPARISON_QA", JSON.stringify(report));
        clearTimeout(timer);
        app.exit(0);
    } catch (error) {
        report.ok = false;
        report.failure = String(error.stack || error);
        fs.writeFileSync(
            path.join(evidence, "qa.json"),
            JSON.stringify(report, null, 2),
        );
        console.error("WORKSPACE_COMPARISON_QA_FAILED", report.failure);
        clearTimeout(timer);
        app.exit(1);
    }
});
