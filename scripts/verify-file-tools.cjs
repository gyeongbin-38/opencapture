const { app, BrowserWindow, dialog, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
for (const preload of [
    "dashboard.js",
    "fileShelf.js",
    "pdfTools.js",
    "rarTools.js",
]) {
    const source = fs.readFileSync(
        path.join(root, "out/preload", preload),
        "utf8",
    );
    assert.equal(
        /require\(["']\.\//.test(source),
        false,
        `${preload} must be self-contained for sandbox loading`,
    );
}
const evidence = path.join(
    root,
    ".evidence",
    "tangerine",
    `runtime-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const profile = path.join(evidence, "profile");
const fixtures = path.join(evidence, "fixtures");
const outputs = path.join(evidence, "outputs");
for (const directory of [profile, fixtures, outputs])
    fs.mkdirSync(directory, { recursive: true });
const actualConfig = path.join(
    app.getPath("appData"),
    "OpenCapture",
    "config.json",
);
const hash = (target) =>
    fs.existsSync(target)
        ? crypto
              .createHash("sha256")
              .update(fs.readFileSync(target))
              .digest("hex")
        : null;
const actualHash = hash(actualConfig);
app.setPath("userData", profile);
app.setPath("pictures", profile);
process.argv.push(`--userData=${profile}`);
const report = {
    checks: [],
    errors: [],
    screenshots: [],
    effectiveProfile: profile,
};
let pick = [];
let cancelledDestination = false;
let destinationPrompts = 0;
dialog.showOpenDialog = async (_window, settings) => {
    const options = settings ?? _window;
    if (options.title === "File tools")
        return { canceled: !pick.length, filePaths: pick };
    destinationPrompts++;
    return {
        canceled: cancelledDestination,
        filePaths: cancelledDestination ? [] : [outputs],
    };
};
dialog.showMessageBoxSync = () => -1;
dialog.showErrorBox = (title, message) =>
    report.errors.push(`${title}: ${message}`);
app.on("browser-window-created", (_event, win) => {
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    win.webContents.setBackgroundThrottling(false);
});
require("../out/main/main.js");
assert.equal(
    path.resolve(app.getPath("userData")),
    profile,
    "production main must retain the isolated profile",
);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (condition, label) => {
    for (let index = 0; index < 200; index++) {
        const value = await condition();
        if (value) return value;
        await pause(50);
    }
    throw Error(`Timed out: ${label}`);
};
const timer = setTimeout(() => finish(1, "Verification timed out"), 150000);
function finish(code, error) {
    let exitCode = code;
    clearTimeout(timer);
    if (error) report.errors.push(error);
    try {
        assert.equal(
            hash(actualConfig),
            actualHash,
            "real app settings changed",
        );
        report.realSettingsPreserved = true;
    } catch (failure) {
        report.errors.push(failure.message);
        exitCode = 1;
    }
    fs.writeFileSync(
        path.join(evidence, "qa.json"),
        JSON.stringify(report, null, 2),
    );
    console.log(
        JSON.stringify({
            evidence,
            checks: report.checks,
            errors: report.errors,
            realSettingsPreserved: report.realSettingsPreserved,
        }),
    );
    if (!exitCode) console.log("OPENCAPTURE_FILE_TOOLS_OK");
    app.exit(exitCode);
}

app.whenReady().then(async () => {
    try {
        const win = await until(
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
        const run = (code) => win.webContents.executeJavaScript(code, true);
        await until(
            () =>
                run(
                    "!!window.openCapture?.fileTools && !!document.querySelector('.library-file-tools-button')",
                ),
            "file tools preload",
        );
        assert.equal(await run("typeof require"), "undefined");
        const invoke = (method, ...args) =>
            run(
                `window.openCapture.fileTools[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
            );
        const libraryBefore = await run("window.openCapture.getState()");
        await run("window.openCapture.action('add-collection')");
        const libraryAfter = await run("window.openCapture.getState()");
        assert.equal(
            libraryAfter.activeCollectionId,
            libraryBefore.activeCollectionId,
            "adding a destination must retain the active collection",
        );
        const write = (name, bytes) => {
            const target = path.join(fixtures, name);
            fs.writeFileSync(target, bytes);
            return target;
        };
        const txt = write("한글.txt", "안녕하세요\n<safe>& text\n");
        const csv = write("table.csv", 'name,note\n"가나다","a,b\nquoted"\n');
        const srt = write(
            "captions.srt",
            "1\n00:00:00,000 --> 00:00:01,500\n안녕하세요\n",
        );
        const bitmap = Buffer.alloc(64 * 48 * 4, 255);
        const png = write(
            "first.png",
            nativeImage
                .createFromBitmap(bitmap, { width: 64, height: 48 })
                .toPNG(),
        );
        const png2 = write(
            "second.png",
            nativeImage
                .createFromBitmap(Buffer.alloc(32 * 32 * 4, 128), {
                    width: 32,
                    height: 32,
                })
                .toPNG(),
        );
        const originals = new Map(
            [txt, csv, srt, png, png2].map((file) => [file, hash(file)]),
        );
        const convert = async (files, recipe, options = {}) => {
            const selection = await invoke("select", files);
            assert.equal(selection.rejected.length, 0);
            const results = await invoke("run", {
                jobId: crypto.randomUUID(),
                sourceIds: selection.sources.map((source) => source.id),
                recipe,
                options,
            });
            for (const result of results)
                assert.equal(
                    result.status,
                    "success",
                    `${recipe}: ${result.error}`,
                );
            return results
                .flatMap((result) => result.outputs)
                .map((output) => ({
                    ...output,
                    path: path.join(outputs, output.name),
                }));
        };
        const mixedCapabilities = await invoke("select", [txt, png]);
        const savedDestination = mixedCapabilities.destinations.find(
            (folder) => folder.name === path.basename(outputs),
        );
        assert.ok(savedDestination?.available);
        assert.equal("path" in savedDestination, false);
        const promptsBeforeSaved = destinationPrompts;
        const savedExport = await invoke("run", {
            jobId: crypto.randomUUID(),
            sourceIds: [mixedCapabilities.sources[0].id],
            recipe: "text-convert",
            options: { format: "html" },
            destinationId: savedDestination.id,
        });
        assert.equal(savedExport[0].status, "success");
        assert.ok(
            fs.existsSync(path.join(outputs, savedExport[0].outputs[0].name)),
        );
        const savedCopy = await invoke(
            "sourceAction",
            [mixedCapabilities.sources[0].id],
            "copy-to",
            crypto.randomUUID(),
            savedDestination.id,
        );
        assert.equal(savedCopy.ok, true);
        assert.equal(
            destinationPrompts,
            promptsBeforeSaved,
            "saved destinations must bypass the picker",
        );
        assert.equal(
            (await run("window.openCapture.getState()")).activeCollectionId,
            libraryBefore.activeCollectionId,
        );
        report.checks.push(
            "saved destination export and copy reuse safe jobs without a picker or active-folder change",
        );
        assert.equal(
            mixedCapabilities.recipes.some(
                (recipe) =>
                    recipe.id.startsWith("pdf-") ||
                    recipe.id.startsWith("office-"),
            ),
            false,
        );
        assert.deepEqual(
            mixedCapabilities.recipes.find(
                (recipe) => recipe.id === "document-text-convert",
            ).sourceIds,
            [mixedCapabilities.sources[0].id],
        );
        const [html] = await convert([txt], "text-convert", { format: "html" });
        assert.match(fs.readFileSync(html.path, "utf8"), /&lt;safe&gt;/);
        report.checks.push("UTF-8 text to inert HTML");
        const [vtt] = await convert([srt], "subtitle-convert", {
            format: "vtt",
        });
        assert.match(fs.readFileSync(vtt.path, "utf8"), /^WEBVTT/);
        report.checks.push("SRT to WebVTT timestamps");
        const [tsv] = await convert([csv], "table-convert", { format: "tsv" });
        assert.match(fs.readFileSync(tsv.path, "utf8"), /가나다/);
        report.checks.push("quoted Unicode table conversion");
        const [pdf] = await convert([png, png2], "image-pdf");
        const pdfBytes = fs.readFileSync(pdf.path);
        assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
        assert.match(pdfBytes.toString("latin1"), /\/Count 2/);
        report.checks.push("two image PDF pages");
        const { PDFDocument, StandardFonts } = require("pdf-lib");
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        document
            .addPage([144, 72])
            .drawText("Hello PDF", { x: 8, y: 30, font, size: 12 });
        document
            .addPage([72, 144])
            .drawText("Second", { x: 8, y: 30, font, size: 12 });
        const editablePdf = write("editable.pdf", await document.save());
        originals.set(editablePdf, hash(editablePdf));
        const [extracted] = await convert([editablePdf], "pdf-convert", {
            format: "txt",
        });
        const extractedText = fs.readFileSync(extracted.path, "utf8");
        assert.match(extractedText, /Hello PDF/);
        assert.match(extractedText, /Second/);
        report.checks.push("isolated PDF.js text extraction");
        const renderedPages = await convert([editablePdf], "pdf-convert", {
            format: "png",
        });
        assert.equal(renderedPages.length, 2);
        assert.deepEqual(
            nativeImage.createFromPath(renderedPages[0].path).getSize(),
            { width: 600, height: 300 },
        );
        assert.deepEqual(
            nativeImage.createFromPath(renderedPages[1].path).getSize(),
            { width: 300, height: 600 },
        );
        report.checks.push("all PDF pages rasterized at 300 DPI");
        const splitPages = await convert([editablePdf], "pdf-split", {
            pages: "1-2",
        });
        assert.equal(splitPages.length, 2);
        assert.equal(
            (
                await PDFDocument.load(fs.readFileSync(splitPages[0].path))
            ).getPageCount(),
            1,
        );
        const [organized] = await convert([editablePdf], "pdf-organize", {
            pages: "2,1,2",
            angle: 90,
        });
        const organizedPdf = await PDFDocument.load(
            fs.readFileSync(organized.path),
        );
        assert.equal(organizedPdf.getPageCount(), 3);
        assert.equal(organizedPdf.getPage(0).getWidth(), 72);
        assert.equal(organizedPdf.getPage(0).getRotation().angle, 90);
        const [merged] = await convert([editablePdf, pdf.path], "pdf-merge");
        assert.equal(
            (
                await PDFDocument.load(fs.readFileSync(merged.path))
            ).getPageCount(),
            4,
        );
        report.checks.push("PDF split, reorder, duplicate, rotate and merge");
        const [docx] = await convert([editablePdf], "pdf-text-document", {
            format: "docx",
        });
        assert.equal(
            fs.readFileSync(docx.path).subarray(0, 2).toString(),
            "PK",
        );
        assert.ok(
            fs.readFileSync(docx.path).includes(Buffer.from("Hello PDF")),
        );
        const [epub] = await convert([txt], "document-text-convert", {
            format: "epub",
        });
        const [bookText] = await convert([epub.path], "document-text-convert", {
            format: "txt",
        });
        assert.match(fs.readFileSync(bookText.path, "utf8"), /안녕하세요/);
        report.checks.push("text-only PDF to DOCX and portable EPUB roundtrip");
        const pagedText = write(
            "두 페이지.txt",
            "안녕하세요 첫 페이지\n<safe>& text\f한국어 두 번째 페이지",
        );
        originals.set(pagedText, hash(pagedText));
        const [textPdf] = await convert([pagedText], "text-document-pages", {
            format: "pdf",
        });
        assert.equal(
            (
                await PDFDocument.load(fs.readFileSync(textPdf.path))
            ).getPageCount(),
            2,
        );
        const [textPdfExtracted] = await convert(
            [textPdf.path],
            "pdf-convert",
            { format: "txt" },
        );
        assert.match(
            fs.readFileSync(textPdfExtracted.path, "utf8"),
            /안녕하세요/,
        );
        assert.match(fs.readFileSync(textPdfExtracted.path, "utf8"), /한국어/);
        const textPages = await convert([pagedText], "text-document-pages", {
            format: "png",
        });
        assert.equal(textPages.length, 2);
        for (const page of textPages) {
            const size = nativeImage.createFromPath(page.path).getSize();
            assert.ok(
                size.width > 2400 && size.height > 3400,
                "A4 text pages must render at 300 DPI",
            );
        }
        const [epubPdf] = await convert([epub.path], "text-document-pages", {
            format: "pdf",
        });
        assert.equal(
            (
                await PDFDocument.load(fs.readFileSync(epubPdf.path))
            ).getPageCount(),
            1,
        );
        report.checks.push(
            "real Korean text and EPUB PDF printing with all 300 DPI pages",
        );
        const [collage] = await convert([png, png2], "image-collage", {
            width: 320,
            height: 240,
        });
        assert.deepEqual(nativeImage.createFromPath(collage.path).getSize(), {
            width: 320,
            height: 240,
        });
        report.checks.push("real collage bitmap");
        const [frame] = await convert([png], "image-frame");
        assert.deepEqual(nativeImage.createFromPath(frame.path).getSize(), {
            width: 128,
            height: 112,
        });
        const [redacted] = await convert([png], "image-redact", {
            x: 2,
            y: 3,
            width: 10,
            height: 8,
        });
        const redactedBitmap = nativeImage
            .createFromPath(redacted.path)
            .toBitmap();
        assert.deepEqual(
            [
                ...redactedBitmap.subarray(
                    (3 * 64 + 2) * 4,
                    (3 * 64 + 2) * 4 + 4,
                ),
            ],
            [0, 0, 0, 255],
        );
        report.checks.push("framing and solid image redaction");
        const foldPixels = Buffer.alloc(6 * 5 * 4);
        for (let y = 0; y < 5; y++)
            for (let x = 0; x < 6; x++) {
                const offset = (y * 6 + x) * 4;
                foldPixels.set([x * 30, y * 40, 90, 255], offset);
            }
        const foldSource = write(
            "fold-source.png",
            nativeImage
                .createFromBitmap(foldPixels, { width: 6, height: 5 })
                .toPNG(),
        );
        originals.set(foldSource, hash(foldSource));
        for (const axis of ["horizontal", "vertical"]) {
            const [folded] = await convert([foldSource], "image-fold", {
                foldAxis: axis,
                foldOffset: 1,
                foldSize: 2,
            });
            const image = nativeImage.createFromPath(folded.path);
            const size = image.getSize();
            assert.deepEqual(
                size,
                axis === "horizontal"
                    ? { width: 6, height: 3 }
                    : { width: 4, height: 5 },
            );
            const actual = image.toBitmap();
            for (let y = 0; y < size.height; y++)
                for (let x = 0; x < size.width; x++) {
                    const sourceX = axis === "vertical" && x >= 1 ? x + 2 : x;
                    const sourceY = axis === "horizontal" && y >= 1 ? y + 2 : y;
                    const expectedOffset = (sourceY * 6 + sourceX) * 4;
                    const actualOffset = (y * size.width + x) * 4;
                    assert.deepEqual(
                        actual.subarray(actualOffset, actualOffset + 4),
                        foldPixels.subarray(expectedOffset, expectedOffset + 4),
                    );
                }
        }
        report.checks.push(
            "image folding removes both interior strip axes with exact PNG pixels",
        );
        const media = path.join(fixtures, "tone.wav");
        const ffmpeg = path.join(root, "lib", "ffmpeg", "ffmpeg.exe");
        const generated = spawnSync(
            ffmpeg,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-ac",
                "2",
                media,
            ],
            { windowsHide: true, encoding: "utf8", timeout: 20000 },
        );
        assert.equal(generated.status, 0, generated.stderr);
        originals.set(media, hash(media));
        const [mp3] = await convert([media], "media-convert", {
            format: "mp3",
            quality: 0.7,
        });
        const decoded = spawnSync(
            ffmpeg,
            ["-hide_banner", "-v", "error", "-i", mp3.path, "-f", "null", "-"],
            { windowsHide: true, encoding: "utf8", timeout: 20000 },
        );
        assert.equal(decoded.status, 0, decoded.stderr);
        report.checks.push("audio conversion through real preload and FFmpeg");
        const [gzip] = await convert([txt], "archive-compress", {
            format: "gz",
        });
        const unpacked = await convert([gzip.path], "archive-extract");
        assert.equal(hash(unpacked[0].path), hash(txt));
        report.checks.push("archive compression and extraction roundtrip");
        const rar4 = path.join(root, "test/fixtures/rar/rar4.rar");
        const rar5 = path.join(root, "test/fixtures/rar/rar5.rar");
        originals.set(rar4, hash(rar4));
        originals.set(rar5, hash(rar5));
        for (const rar of [rar4, rar5]) {
            const [inspection] = await convert([rar], "archive-rar-inspect");
            assert.ok(fs.readFileSync(inspection.path, "utf8").length > 10);
        }
        const [rarZip] = await convert([rar4], "archive-rar-convert", {
            format: "zip",
        });
        assert.equal(
            fs.readFileSync(rarZip.path).subarray(0, 2).toString(),
            "PK",
        );
        await convert([rarZip.path], "archive-test");
        report.checks.push(
            "bounded RAR4/RAR5 inspection and real ZIP conversion",
        );
        const mixed = await invoke("select", [txt, png]);
        const outcomes = await invoke("run", {
            jobId: crypto.randomUUID(),
            sourceIds: mixed.sources.map((source) => source.id),
            recipe: "text-convert",
            options: { format: "html" },
        });
        assert.deepEqual(
            outcomes.map((outcome) => outcome.status),
            ["success", "error"],
        );
        report.checks.push("mixed files retain individual outcomes");
        cancelledDestination = true;
        const cancelled = await invoke("run", {
            jobId: crypto.randomUUID(),
            sourceIds: [mixed.sources[0].id],
            recipe: "text-convert",
            options: { format: "html" },
        });
        assert.equal(cancelled[0].status, "cancelled");
        cancelledDestination = false;
        report.checks.push("destination cancellation has no output");
        pick = [media];
        await run(
            "document.querySelector('.library-file-tools-button').click()",
        );
        await until(
            () =>
                run(
                    "!!document.querySelector('[data-recipe-id=media-convert]')",
                ),
            "media UI recipe",
        );
        await run(
            `document.querySelector('[data-file-tools-destination]').value=${JSON.stringify(savedDestination.id)}`,
        );
        const promptsBeforeUi = destinationPrompts;
        await run(
            "document.querySelector('[data-recipe-id=media-convert]').click();const f=document.querySelector('[data-file-tool-option=format]');f.value='mp3';f.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-file-tool-option=quality]').value='70';document.querySelector('[data-file-tools-action=run]').click()",
        );
        await until(
            () =>
                run("!!document.querySelector('[data-result-status=success]')"),
            "UI-driven conversion",
        );
        assert.equal(
            await run(
                "document.querySelectorAll('[data-result-status=error]').length",
            ),
            0,
        );
        assert.equal(
            destinationPrompts,
            promptsBeforeUi,
            "UI saved destination must reach the real export pipeline",
        );
        report.checks.push(
            "saved destination selection executes through the actual UI",
        );
        report.checks.push("UI percent options execute real MP3 conversion");
        await run(
            "document.querySelector('[data-file-tools-action=close]').click()",
        );
        const beforeFoldUi = new Set(fs.readdirSync(outputs));
        pick = [foldSource];
        await run(
            "document.querySelector('.library-file-tools-button').click()",
        );
        await until(
            () =>
                run(
                    "document.querySelectorAll('.file-tools-source-row').length===1",
                ),
            "fold source selection",
        );
        await run(
            "document.querySelector('[data-file-tools-mode=tools]').click();document.querySelector('[data-recipe-id=image-fold]').click()",
        );
        assert.equal(
            await run("document.querySelector('.file-tools-recipes').hidden"),
            true,
        );
        await run(
            "document.querySelector('[data-file-tools-action=change-recipe]').click()",
        );
        assert.equal(
            await run("document.querySelector('.file-tools-recipes').hidden"),
            false,
        );
        await run(
            "document.querySelector('[data-recipe-id=image-fold]').click()",
        );
        assert.ok(
            (
                await run(
                    "document.querySelector('.file-tools-options h3').textContent",
                )
            ).includes("접기"),
        );
        report.checks.push(
            "selected operation replaces the picker with named options and can be changed",
        );
        await run(
            "document.querySelector('[data-file-tool-option=foldAxis]').value='vertical';document.querySelector('[data-file-tool-option=foldOffset]').value='1';document.querySelector('[data-file-tool-option=foldSize]').value='2'",
        );
        win.setMinimumSize(0, 0);
        for (const width of [850, 360]) {
            win.setContentSize(width, 700);
            await run(
                "document.querySelector('[data-file-tools-options]').scrollIntoView({block:'nearest'})",
            );
            await pause(100);
            assert.equal(
                await run(
                    "document.querySelectorAll('[data-file-tools-options] input,[data-file-tools-options] select').length",
                ),
                3,
            );
            assert.ok(
                await run(
                    "Array.from(document.querySelectorAll('[data-file-tools-options] input,[data-file-tools-options] select')).every(input=>{const r=input.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight})",
                ),
                "fold options must remain reachable at compact widths",
            );
            const file = `fold-options-${width}.png`;
            fs.writeFileSync(
                path.join(evidence, file),
                (await win.webContents.capturePage()).toPNG(),
            );
            report.screenshots.push(file);
        }
        await run(
            "document.querySelector('[data-file-tools-action=run]').click()",
        );
        await until(
            () =>
                run("!!document.querySelector('[data-result-status=success]')"),
            "UI-driven image fold",
        );
        assert.equal(
            await run(
                "document.querySelectorAll('[data-result-status=error]').length",
            ),
            0,
        );
        const newFoldUi = fs
            .readdirSync(outputs)
            .filter((name) => !beforeFoldUi.has(name));
        assert.equal(newFoldUi.length, 1);
        assert.deepEqual(
            nativeImage
                .createFromPath(path.join(outputs, newFoldUi[0]))
                .getSize(),
            { width: 4, height: 5 },
        );
        report.checks.push(
            "image fold direction and pixels execute through the real options UI",
        );
        await run(
            "document.querySelector('[data-file-tools-action=close]').click()",
        );
        pick = [txt, png];
        await run(
            "document.querySelector('[data-page=library]')?.click(); document.querySelector('.library-file-tools-button').click()",
        );
        await until(
            () =>
                run(
                    "document.querySelectorAll('.file-tools-source-row').length===2",
                ),
            "file tools selection",
        );
        assert.ok(
            (
                await run(
                    "document.querySelector('.file-tools-dialog').textContent",
                )
            ).includes("파일"),
        );
        assert.equal(
            await run(
                "document.querySelector('.file-tools-source-list').hidden",
            ),
            true,
        );
        await run(
            "document.querySelector('[data-file-tools-action=toggle-sources]').click();document.querySelector('.file-tools-source-row input').click()",
        );
        assert.equal(
            await run(
                "document.querySelector('[data-file-tools-action=toggle-sources]').getAttribute('aria-expanded')",
            ),
            "true",
        );
        assert.ok(
            (
                await run(
                    "document.querySelector('[data-file-tools-action=toggle-sources]').textContent",
                )
            ).includes("1/2"),
        );
        await run(
            "document.querySelector('.file-tools-source-row input').click();document.querySelector('[data-file-tools-action=toggle-sources]').click()",
        );
        assert.ok(
            (
                await run(
                    "document.querySelector('[data-file-tools-action=toggle-sources]').textContent",
                )
            ).includes("2/2"),
        );
        report.checks.push(
            "collapsible source list retains individual selection and selected counts",
        );
        win.setMinimumSize(0, 0);
        for (const [width, height] of [
            [1180, 810],
            [850, 700],
            [380, 640],
            [360, 600],
        ]) {
            win.setContentSize(width, height);
            await pause(100);
            const metrics = await run(
                `(() => { const d=document.querySelector('.file-tools-dialog');const r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:d.scrollWidth-d.clientWidth};})()`,
            );
            assert.ok(
                Math.abs(metrics.width - width) <= 1,
                "verification must use the requested content width",
            );
            assert.ok(
                Math.abs(metrics.height - height) <= 2,
                `content height mismatch: ${JSON.stringify({ requested: [width, height], actual: metrics, content: win.getContentSize() })}`,
            );
            assert.ok(
                metrics.left >= -1 &&
                    metrics.right <= metrics.width + 1 &&
                    metrics.top >= -1 &&
                    metrics.bottom <= metrics.height + 1 &&
                    metrics.overflow <= 1,
                JSON.stringify(metrics),
            );
            assert.equal(
                await run(
                    "document.querySelector('.file-tools-source-list').hidden",
                ),
                true,
            );
            assert.ok(
                await run(
                    "(()=>{const r=document.querySelector('.file-tools-recipe').getBoundingClientRect();return r.top>=0&&r.bottom<document.querySelector('.file-tools-footer').getBoundingClientRect().top})()",
                ),
                "first operation must be visible above the fixed footer",
            );
            assert.ok(
                await run(
                    "(()=>{const r=document.querySelector('[data-file-tools-destination]').getBoundingClientRect();return r.width>80&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight})()",
                ),
                "saved destination must remain reachable",
            );
            const file = `file-tools-${width}.png`;
            fs.writeFileSync(
                path.join(evidence, file),
                (await win.webContents.capturePage()).toPNG(),
            );
            report.screenshots.push(file);
        }
        report.checks.push("responsive file tools at four widths");
        await run(
            "document.querySelector('[data-file-tools-mode=tools]').click()",
        );
        await run(
            "document.querySelector('[data-file-tools-mode=actions]').click()",
        );
        assert.ok(
            await run(
                "document.querySelector('[data-source-action=copy-path]')!==null",
            ),
        );
        assert.equal(
            await run(
                "document.querySelector('[data-source-action=share]').disabled",
            ),
            true,
        );
        await run(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}))",
        );
        assert.equal(
            await run(
                "document.querySelector('[data-file-tools-mode=actions]').getAttribute('aria-selected')",
            ),
            "true",
        );
        await run(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',altKey:true,bubbles:true}))",
        );
        assert.equal(
            await run(
                "document.querySelector('[data-file-tools-mode=convert]').getAttribute('aria-selected')",
            ),
            "true",
        );
        await run(
            "document.querySelector('[data-file-tools-action=close]').click()",
        );
        assert.equal(
            await run("document.querySelector('.file-tools-dialog')===null"),
            true,
        );
        report.checks.push("tabs, actions and close");
        const floating = await invoke("select", [txt, png, fixtures]);
        await invoke(
            "sourceAction",
            floating.sources.map((source) => source.id),
            "float",
            crypto.randomUUID(),
        );
        const shelf = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (window) =>
                        window.webContents
                            .getURL()
                            .includes("file_shelf.html") &&
                        !window.webContents.isLoading(),
                ),
            "floating files window",
        );
        const shelfRun = (code) =>
            shelf.webContents.executeJavaScript(code, true);
        await until(
            () =>
                shelfRun(
                    "!!window.fileShelf && document.querySelectorAll('.file-shelf-row').length===3",
                ),
            "floating file rows",
        );
        const shelfState = await shelfRun("window.fileShelf.ready()");
        assert.equal(shelfState.files.length, 3);
        assert.ok(shelfState.files.some((file) => file.folder));
        assert.equal(
            shelfState.files.some((file) => "path" in file),
            false,
        );
        assert.equal(await shelfRun("typeof require"), "undefined");
        assert.ok(
            (await shelfRun("document.body.textContent")).includes("파일"),
        );
        assert.ok(
            await shelfRun(
                "Array.from(document.querySelectorAll('.file-shelf-drag')).every(button=>button.getAttribute('aria-label')&&button.querySelector('svg')&&!button.textContent.trim())",
            ),
            "compact drag handles retain accessible file-specific labels",
        );
        for (const [width, height] of [
            [320, 280],
            [240, 220],
        ]) {
            shelf.setMinimumSize(0, 0);
            shelf.setContentSize(width, height);
            await pause(100);
            const metrics = await shelfRun(
                "({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth})",
            );
            assert.ok(
                Math.abs(metrics.width - width) <= 1 &&
                    Math.abs(metrics.height - height) <= 2 &&
                    metrics.overflow <= 1,
                JSON.stringify(metrics),
            );
            const file = `file-shelf-${width}.png`;
            fs.writeFileSync(
                path.join(evidence, file),
                (await shelf.webContents.capturePage()).toPNG(),
            );
            report.screenshots.push(file);
        }
        await shelfRun("window.fileShelf.close()");
        await until(() => shelf.isDestroyed(), "floating shelf close");
        report.checks.push(
            "arbitrary files and folders in isolated responsive floating shelf",
        );
        await run(
            "document.querySelector('.command-trigger').click();const s=document.querySelector('.command-search input');s.value='convert';s.dispatchEvent(new Event('input',{bubbles:true}))",
        );
        await until(
            () =>
                run(
                    "!!document.querySelector('[data-command-id=\"workspace:file-tools\"]')",
                ),
            "file tools command search",
        );
        assert.ok(
            (
                await run(
                    "document.querySelector('[data-command-id=\"workspace:file-tools\"]').textContent",
                )
            ).includes("파일 도구"),
        );
        await run(
            "document.querySelector('[data-command-id=\"workspace:file-tools\"]').click()",
        );
        await until(
            () =>
                run(
                    "document.querySelectorAll('.file-tools-source-row').length===2",
                ),
            "command opens file tools",
        );
        await run(
            "document.querySelector('[data-file-tools-action=close]').click()",
        );
        report.checks.push("localized file tools command search and open");
        for (const [file, before] of originals)
            assert.equal(
                hash(file),
                before,
                `original changed: ${path.basename(file)}`,
            );
        report.checks.push("all fixture source hashes preserved");
        finish(0);
    } catch (error) {
        finish(1, error.stack || String(error));
    }
});
