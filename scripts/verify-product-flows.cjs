const { app, BrowserWindow, dialog, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".evidence", "product-minimal");
const label = process.env.OPENCAPTURE_VERIFY_LABEL || "conversion-current";
const profile = path.join(evidence, `profile-${Date.now()}`);
const fixtures = path.join(profile, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
app.setPath("userData", profile);
app.setPath("pictures", fixtures);
process.argv.push(`--userData=${profile}`);

const report = { checks: [], errors: [], coverage: {} };
const AVIF_16_RED_BASE64 =
    "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGAz/2wCAMhMYAAAAUAAAAACpjmy2qrHGtoVA";
const traceFile = path.join(evidence, `${label}-trace.log`);
const trace = (message) => fs.appendFileSync(traceFile, `${message}\n`);
const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

dialog.showMessageBoxSync = (options) => {
    report.errors.push(options?.message || "Unexpected dialog");
    return -1;
};
dialog.showErrorBox = (title, message) => {
    report.errors.push(`${title}: ${message}`);
};
app.on("browser-window-created", (_, win) => {
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    win.webContents.setBackgroundThrottling(false);
});
app.on("web-contents-created", (_, contents) => {
    contents.on("render-process-gone", (_, details) =>
        report.errors.push(`Renderer exited: ${details.reason}`),
    );
});

require("../out/main/main.js");

async function until(check, message, attempts = 160) {
    for (let index = 0; index < attempts; index++) {
        const value = await check();
        if (value) return value;
        await pause(50);
    }
    throw new Error(message);
}

const finish = (code) => {
    fs.writeFileSync(
        path.join(evidence, `${label}.json`),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(code);
};

const timer = setTimeout(() => {
    report.errors.push("Verification timed out");
    finish(1);
}, 240_000);

async function resolveConversionModule() {
    const assetDirectory = path.join(root, "out", "renderer", "assets");
    const sharedChunk = fs
        .readdirSync(assetDirectory)
        .find((name) => /^convertDonut-.*\.js$/.test(name));
    if (sharedChunk) {
        report.coverage.rendererModule = "fresh shared production chunk";
        const sharedPath = path.join(assetDirectory, sharedChunk);
        report.coverage.rendererModuleSha256 = hash(sharedPath);
        return sharedPath;
    }
    const harnessDirectory = path.join(profile, "renderer-harness");
    const { build } = await import("vite");
    await build({
        root,
        configFile: false,
        publicDir: false,
        logLevel: "silent",
        build: {
            outDir: harnessDirectory,
            emptyOutDir: true,
            lib: {
                entry: path.join(
                    root,
                    "src",
                    "renderer",
                    "lib",
                    "convertDonut.ts",
                ),
                formats: ["es"],
                fileName: () => "convert-harness.js",
            },
        },
    });
    report.coverage.rendererModule =
        "isolated bundle of the source included by the fresh production build";
    const harnessPath = path.join(harnessDirectory, "convert-harness.js");
    report.coverage.rendererModuleSha256 = hash(harnessPath);
    return harnessPath;
}

app.whenReady().then(async () => {
    try {
        const dashboard = await until(
            () =>
                BrowserWindow.getAllWindows().find(
                    (win) =>
                        win.webContents.getURL().includes("dashboard.html") &&
                        !win.webContents.isLoading(),
                ),
            "Dashboard did not load",
            400,
        );
        const run = (code) =>
            dashboard.webContents.executeJavaScript(code, true);
        await until(
            () => run("Boolean(window.openCapture)"),
            "Dashboard preload unavailable",
        );

        const moduleUrl = pathToFileURL(await resolveConversionModule()).href;
        const conversionCss = fs.readFileSync(
            path.join(root, "src", "renderer", "lib", "convertDonut.css"),
            "utf8",
        );

        await run(`(async () => {
            const qaStyle = document.createElement('style');
            qaStyle.dataset.conversionQaStyle = '';
            qaStyle.textContent = ${JSON.stringify(conversionCss)};
            document.head.append(qaStyle);
            localStorage.setItem('oc:onboarded', '1');
            for (const node of document.querySelectorAll('dialog[open]')) node.close();
            document.querySelector('.modal-backdrop')?.setAttribute('hidden', '');
            await window.openCapture.action('configure-workflow', {
                autoOcr:false, autoPreview:false, autoClipboard:false
            });
            const module = await import(${JSON.stringify(moduleUrl)});
            window.__conversion = module.openConvertDonut ?? module.o ??
                Object.values(module).find(value => typeof value === 'function');
            if (typeof window.__conversion !== 'function') throw Error('Conversion export missing');
            window.__qaOpener = document.createElement('button');
            window.__qaOpener.textContent = 'Conversion fixture';
            window.__qaOpener.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0';
            document.body.append(window.__qaOpener);
            window.__qaOpen = (config = {}) => {
                window.__qa?.releaseAll?.();
                window.__qa?.close?.();
                if (!config.keepStorage) {
                    localStorage.removeItem('oc:convert-settings-v2');
                    localStorage.removeItem('oc:convert-named-presets-v1');
                    localStorage.removeItem('oc:convert-options-open');
                    localStorage.removeItem('oc:convert-preset');
                }
                if (config.settings)
                    localStorage.setItem('oc:convert-settings-v2', JSON.stringify(config.settings));
                window.__qaOpener.focus();
                const state = window.__qa = {
                    config,
                    convertCalls:[], previewCalls:[], previewValues:[],
                    registerCalls:[], dragCalls:[], results:[], errors:[],
                    releases:{}, failedPaths:new Set(), delayedPaths:new Set(),
                };
                state.waitFor = key => new Promise(resolve => state.releases[key] = resolve);
                state.release = key => { state.releases[key]?.(); delete state.releases[key]; };
                state.releaseAll = () => {
                    for (const release of Object.values(state.releases)) release();
                    state.releases = {};
                };
                const api = {
                    convertPath: async (...args) => {
                        const source = args[0];
                        state.convertCalls.push(args);
                        if (config.failPathsOnce?.includes(source) && !state.failedPaths.has(source)) {
                            state.failedPaths.add(source);
                            throw Error('Fixture conversion failure');
                        }
                        if (config.delayPathsOnce?.includes(source) && !state.delayedPaths.has(source)) {
                            state.delayedPaths.add(source);
                            await state.waitFor('convert:' + source);
                        }
                        return window.openCapture.convertPath(...args);
                    },
                    previewPath: async (...args) => {
                        state.previewCalls.push(args);
                        const value = await window.openCapture.previewPath(...args);
                        state.previewValues.push(value);
                        if (config.delayFirstPreview && state.previewCalls.length === 1)
                            await state.waitFor('preview:first');
                        return value;
                    },
                    readFilePath: source => window.openCapture.readFilePath(source),
                    registerConvertedPaths: async paths => {
                        state.registerCalls.push([...paths]);
                        if (config.failFirstRegistration && state.registerCalls.length === 1)
                            return paths.map(path => ({path,status:'failed',error:'Fixture registration failure'}));
                        return window.openCapture.registerConvertedPaths(paths);
                    },
                    dragConvertedPath: async path => {
                        state.dragCalls.push(path);
                        return window.openCapture.dragConvertedPath(path);
                    },
                    revealPath: path => window.openCapture.revealPath(path),
                };
                state.close = window.__conversion({
                    point:{x:innerWidth / 2, y:innerHeight / 2},
                    targets:config.targets,
                    api,
                    presets:true,
                    register:Boolean(config.register),
                    onDone:result => state.results.push(result),
                    onError:message => state.errors.push(message),
                });
                return state;
            };
            window.__qaSelectFormat = format => {
                const select = document.querySelector('[data-convert-format]');
                select.value = format;
                select.dispatchEvent(new Event('change', {bubbles:true}));
            };
            window.__qaSet = (name, value) => {
                const input = document.querySelector('[data-convert-option="' + name + '"]');
                if (input.type === 'checkbox') input.checked = Boolean(value);
                else input.value = String(value);
                input.dispatchEvent(new Event('input', {bubbles:true}));
                input.dispatchEvent(new Event('change', {bubbles:true}));
            };
            window.__qaClick = action =>
                document.querySelector('[data-convert-action="' + action + '"]').click();
            window.__qaKey = (key, target = document.activeElement, shiftKey = false) => {
                const event = new KeyboardEvent('keydown', {key,shiftKey,bubbles:true,cancelable:true});
                target.dispatchEvent(event);
                return event.defaultPrevented;
            };
            const canvas = document.createElement('canvas');
            canvas.width = 120; canvas.height = 80;
            const context = canvas.getContext('2d');
            context.fillStyle = '#d02030'; context.fillRect(0,0,60,80);
            context.fillStyle = '#2050d0'; context.fillRect(60,0,60,80);
            window.__fixturePng = canvas.toDataURL('image/png');
            window.__fixtureAvif = await new Promise(resolve => canvas.toBlob(blob => {
                if (!blob || blob.type !== 'image/avif') return resolve('');
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            }, 'image/avif', 0.9));
        })()`);

        const original = Buffer.from(
            (await run("window.__fixturePng")).split(",")[1],
            "base64",
        );
        const source = path.join(fixtures, "original.png");
        const sourceA = path.join(fixtures, "source-a.png");
        const sourceB = path.join(fixtures, "source-b.png");
        const sourceC = path.join(fixtures, "source-c.png");
        for (const file of [source, sourceA, sourceB, sourceC])
            fs.writeFileSync(file, original);
        const largeSource = path.join(fixtures, "large.png");
        fs.writeFileSync(
            largeSource,
            nativeImage
                .createFromBuffer(original)
                .resize({ width: 3000 })
                .toPNG(),
        );
        const svgSource = path.join(fixtures, "vector.svg");
        fs.writeFileSync(
            svgSource,
            '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#18181c"/><circle cx="48" cy="32" r="22" fill="#f4f4f5"/></svg>',
        );
        const rendererAvifData = await run("window.__fixtureAvif");
        const avifSource = path.join(fixtures, "original.avif");
        fs.writeFileSync(avifSource, Buffer.from(AVIF_16_RED_BASE64, "base64"));
        report.coverage.avifOutputEncoder = rendererAvifData
            ? "available"
            : "unavailable";
        const originalHashes = new Map(
            [
                source,
                sourceA,
                sourceB,
                sourceC,
                largeSource,
                svgSource,
                avifSource,
            ].map((file) => [file, hash(file)]),
        );
        const target = (file) => ({ path: file, name: path.basename(file) });

        const open = async (config = {}) => {
            const value = {
                targets: [target(source)],
                ...config,
            };
            await run(`void window.__qaOpen(${JSON.stringify(value)})`);
            await until(
                () =>
                    run(
                        "Boolean(document.querySelector('[data-convert-dialog]'))",
                    ),
                "Conversion dialog did not open",
            );
        };
        const select = async (format) => {
            const before = await run("window.__qa.previewCalls.length");
            await run(`window.__qaSelectFormat(${JSON.stringify(format)})`);
            await until(
                () => run(`window.__qa.previewCalls.length > ${before}`),
                "Preview did not start",
            );
        };
        const waitIdle = () =>
            until(
                () =>
                    run(
                        "document.querySelectorAll('[data-convert-row]').length > 0 && !document.querySelector('[data-convert-action=\"convert\"]').disabled && !document.querySelector('[data-convert-row][data-status=\"converting\"], [data-convert-row][data-status=\"pending\"]')",
                    ),
                "Conversion did not become idle",
                800,
            );
        const closeAndResult = async () => {
            await run("window.__qaClick('close')");
            return until(
                () => run("window.__qa.results[0]"),
                "Final callback did not settle",
            );
        };
        const check = async (name, body) => {
            trace(name);
            try {
                await body();
                report.checks.push({ name, ok: true });
            } catch (error) {
                report.checks.push({
                    name,
                    ok: false,
                    error: error.stack || error.message,
                });
            } finally {
                await run(`(() => {
                    window.__qa?.releaseAll?.();
                    const close = document.querySelector('[data-convert-action="close"]');
                    close?.click(); close?.click();
                    window.__qa?.close?.(); window.__qa?.close?.();
                })()`);
                await pause(30);
            }
        };
        const capture = async (name) => {
            await pause(200);
            fs.writeFileSync(
                path.join(evidence, `${label}-${name}.png`),
                (await dashboard.webContents.capturePage()).toPNG(),
            );
        };

        await check(
            "preview and source comparison create no files",
            async () => {
                const before = new Set(fs.readdirSync(fixtures));
                await open();
                await until(
                    () => run("window.__qa.previewValues.length > 0"),
                    "Initial preview missing",
                );
                assert.equal(await run("window.__qa.convertCalls.length"), 0);
                assert.equal(await run("window.__qa.registerCalls.length"), 0);
                assert.deepEqual(new Set(fs.readdirSync(fixtures)), before);
                await run(
                    "document.querySelector('[data-convert-preview-tab=\"source\"]').click()",
                );
                assert.equal(
                    await run(
                        "document.querySelector('[data-convert-preview]').dataset.convertPreviewView",
                    ),
                    "source",
                );
                await until(
                    () =>
                        run(
                            "document.querySelector('[data-convert-preview-image]').src.startsWith('blob:')",
                        ),
                    "Source preview image missing",
                );
                await capture("preview-source");
                await run(
                    "document.querySelector('[data-convert-preview-tab=\"result\"]').click(); window.__qaSet('scale', 75); window.__qaSet('signature', 'QA')",
                );
                await until(
                    () => run("window.__qa.previewCalls.length >= 2"),
                    "Edited preview missing",
                );
                assert.deepEqual(new Set(fs.readdirSync(fixtures)), before);
            },
        );

        await check(
            "one explicit Convert writes once and settles on close",
            async () => {
                const before = fs.readdirSync(fixtures).length;
                await open();
                await select("jpg");
                await run("window.__qaClick('convert')");
                await waitIdle();
                assert.equal(await run("window.__qa.convertCalls.length"), 1);
                assert.equal(await run("window.__qa.results.length"), 0);
                assert.equal(fs.readdirSync(fixtures).length - before, 1);
                await capture("success");
                const result = await closeAndResult();
                assert.equal(result.cancelled, false);
                assert.equal(result.written.length, 1);
                assert.ok(result.bytes > 0);
                await run("window.__qa.close()");
                assert.equal(await run("window.__qa.results.length"), 1);
            },
        );

        await check(
            "idle Escape restores focus and inputs own keys",
            async () => {
                await open();
                await run(`
                const details = document.querySelector('[data-convert-options]');
                details.open = true;
                const input = document.querySelector('[data-convert-option="signature"]');
                input.focus(); input.value = '2026';
                window.__qaKey('2', input); window.__qaKey('ArrowLeft', input);
            `);
                assert.equal(await run("window.__qa.convertCalls.length"), 0);
                dashboard.webContents.sendInputEvent({
                    type: "keyDown",
                    keyCode: "Tab",
                });
                dashboard.webContents.sendInputEvent({
                    type: "keyUp",
                    keyCode: "Tab",
                });
                assert.equal(
                    await run(
                        "document.activeElement.closest('[data-convert-dialog]') !== null",
                    ),
                    true,
                );
                await run(
                    "document.querySelector('[data-convert-options]').open=false; window.__qaKey('Escape')",
                );
                const result = await until(
                    () => run("window.__qa.results[0]"),
                    "Escape did not dismiss",
                );
                assert.equal(result.cancelled, true);
                await until(
                    () => run("document.activeElement === window.__qaOpener"),
                    "Focus was not restored to the opener",
                    20,
                );
            },
        );

        await check(
            "same-format 50 percent and PNG/WebP sizing agree",
            async () => {
                await open();
                await run("window.__qaClick('convert')");
                await waitIdle();
                let result = await closeAndResult();
                assert.equal(result.skipped, 1);
                assert.equal(result.rows[0].status, "skipped");
                assert.equal(result.written.length, 0);

                await open();
                await run(
                    "window.__qaSet('scale', 50); window.__qaClick('convert')",
                );
                await waitIdle();
                result = await closeAndResult();
                assert.deepEqual(
                    nativeImage.createFromPath(result.written[0]).getSize(),
                    {
                        width: 60,
                        height: 40,
                    },
                );
                for (const format of ["png", "webp"]) {
                    await open({ targets: [target(largeSource)] });
                    await select(format);
                    await run(
                        "window.__qaSet('scale', 50); window.__qaSet('max-width', 1280); window.__qaClick('convert')",
                    );
                    await waitIdle();
                    result = await closeAndResult();
                    const width = await run(`(async () => {
                    const bytes = await window.openCapture.readFilePath(${JSON.stringify(result.written[0])});
                    const bitmap = await createImageBitmap(new Blob([bytes]));
                    const width = bitmap.width; bitmap.close(); return width;
                })()`);
                    assert.equal(width, 1280, format);
                }
            },
        );

        await check(
            "PDF and ICO previews report display and export facts",
            async () => {
                for (const format of ["pdf", "ico"]) {
                    await open();
                    await select(format);
                    await until(
                        () => run("window.__qa.previewValues.length >= 1"),
                        `${format} preview missing`,
                    );
                    const value = await run("window.__qa.previewValues.at(-1)");
                    assert.equal(value.previewMime, "image/png");
                    if (format === "pdf")
                        assert.equal(value.exportMime, "application/pdf");
                    else assert.match(value.exportMime, /icon/);
                    assert.ok((value.data.length || value.data.byteLength) > 0);
                    assert.ok(value.outputBytes > 0);
                    assert.equal(value.approximate, true);
                }
            },
        );

        await check(
            "SVG converts through real PNG and WebP paths",
            async () => {
                for (const format of ["png", "webp"]) {
                    await open({ targets: [target(svgSource)] });
                    await select(format);
                    await run(
                        "window.__qaSet('name-pattern', '{name}-{wxh}'); window.__qaClick('convert')",
                    );
                    await waitIdle();
                    const result = await closeAndResult();
                    assert.equal(result.written.length, 1);
                    assert.match(path.basename(result.written[0]), /96x64/);
                    const dimensions = await run(`(async () => {
                    const bytes = await window.openCapture.readFilePath(${JSON.stringify(result.written[0])});
                    const bitmap = await createImageBitmap(new Blob([bytes]));
                    const value = [bitmap.width, bitmap.height]; bitmap.close(); return value;
                })()`);
                    assert.deepEqual(dimensions, [96, 64]);
                }
            },
        );

        await check(
            "AVIF input is converted when the runtime supports it",
            async () => {
                for (const format of ["png", "webp"]) {
                    await open({ targets: [target(avifSource)] });
                    await select(format);
                    await run("window.__qaClick('convert')");
                    await waitIdle();
                    const result = await closeAndResult();
                    assert.equal(result.written.length, 1);
                    const dimensions = await run(`(async () => {
                        const bytes = await window.openCapture.readFilePath(${JSON.stringify(result.written[0])});
                        const bitmap = await createImageBitmap(new Blob([bytes]));
                        const value = [bitmap.width, bitmap.height]; bitmap.close(); return value;
                    })()`);
                    assert.deepEqual(dimensions, [16, 16]);
                }
                report.coverage.avifSource = "PNG and WebP";
            },
        );

        await check(
            "failed conversion retry preserves successful outputs",
            async () => {
                await open({
                    targets: [
                        target(sourceA),
                        target(sourceB),
                        target(sourceC),
                    ],
                    failPathsOnce: [sourceB],
                    settings: {
                        format: "jpg",
                        scale: 0.75,
                        quality: 0.92,
                        maxWidth: 0,
                        background: "",
                        namePattern: "{name}",
                        signature: "",
                        register: false,
                    },
                });
                await run("window.__qaClick('convert')");
                await waitIdle();
                assert.equal(
                    await run(
                        "document.querySelectorAll('[data-convert-row][data-status=\"failed\"]').length",
                    ),
                    1,
                );
                await capture("partial-failure");
                const successful = await run(
                    "[...document.querySelectorAll('[data-convert-row][data-status=\"written\"]')].map(row=>row.dataset.outputPath)",
                );
                const stamps = successful.map(
                    (file) => fs.statSync(file).mtimeMs,
                );
                await run(
                    "window.__qaSet('scale', 25); window.__qaClick('retry-convert')",
                );
                await waitIdle();
                assert.equal(await run("window.__qa.convertCalls.length"), 4);
                assert.deepEqual(
                    successful.map((file) => fs.statSync(file).mtimeMs),
                    stamps,
                );
                assert.equal(
                    await run(
                        "document.querySelectorAll('[data-convert-row][data-status=\"written\"]').length",
                    ),
                    3,
                );
            },
        );

        await check("busy retry cannot erase an earlier failure", async () => {
            await open({
                targets: [target(sourceA), target(sourceB)],
                failPathsOnce: [sourceA],
                delayPathsOnce: [sourceB],
                settings: { ...defaultSettings("jpg") },
            });
            await run("window.__qaClick('convert')");
            await until(
                () =>
                    run(
                        "Boolean(window.__qa.releases['convert:' + window.__qa.config.targets[1].path])",
                    ),
                "Second conversion was not deferred",
            );
            await run(
                "document.querySelector('[data-convert-action=\"retry-convert\"]').click()",
            );
            assert.equal(
                await run(
                    "document.querySelectorAll('[data-convert-row][data-status=\"failed\"]').length",
                ),
                1,
            );
            await run(
                "window.__qa.release('convert:' + window.__qa.config.targets[1].path)",
            );
            await waitIdle();
            await run("window.__qaClick('retry-convert')");
            await waitIdle();
            assert.equal(await run("window.__qa.convertCalls.length"), 3);
        });

        await check(
            "all 45 outputs receive ordered registration outcomes",
            async () => {
                const bulk = [];
                for (let index = 0; index < 45; index++) {
                    const file = path.join(fixtures, `bulk-${index}.png`);
                    fs.writeFileSync(file, original);
                    bulk.push(target(file));
                }
                await open({
                    targets: bulk,
                    register: true,
                    settings: { ...defaultSettings("jpg"), register: true },
                });
                await run("window.__qaClick('convert')");
                await waitIdle();
                assert.equal(await run("window.__qa.convertCalls.length"), 45);
                assert.equal(
                    await run("window.__qa.registerCalls[0].length"),
                    45,
                );
                assert.equal(
                    await run(
                        "document.querySelectorAll('[data-registration-status]').length",
                    ),
                    45,
                );
                const result = await closeAndResult();
                assert.equal(result.registration.length, 45);
                assert.deepEqual(
                    result.registration.map((outcome) => outcome.path),
                    result.written,
                );
            },
        );

        await check("registration retry reuses written paths", async () => {
            await open({
                targets: [target(sourceA), target(sourceB)],
                register: true,
                failFirstRegistration: true,
                settings: { ...defaultSettings("jpg"), register: true },
            });
            await run("window.__qaClick('convert')");
            await waitIdle();
            const outputs = await run(
                "[...document.querySelectorAll('[data-output-path]')].map(row=>row.dataset.outputPath)",
            );
            const stamps = outputs.map((file) => fs.statSync(file).mtimeMs);
            assert.equal(await run("window.__qa.convertCalls.length"), 2);
            await run("window.__qaClick('retry-registration')");
            await waitIdle();
            assert.equal(await run("window.__qa.convertCalls.length"), 2);
            assert.deepEqual(
                await run("window.__qa.registerCalls[1]"),
                outputs,
            );
            assert.deepEqual(
                outputs.map((file) => fs.statSync(file).mtimeMs),
                stamps,
            );
        });

        await check(
            "cancelling in flight preserves commits and stops next",
            async () => {
                await open({
                    targets: [
                        target(sourceA),
                        target(sourceB),
                        target(sourceC),
                    ],
                    delayPathsOnce: [sourceB],
                    settings: { ...defaultSettings("jpg") },
                });
                await run("window.__qaClick('convert')");
                await until(
                    () =>
                        run(
                            "Boolean(window.__qa.releases['convert:' + window.__qa.config.targets[1].path])",
                        ),
                    "Second conversion was not deferred",
                );
                await run(
                    "window.__qaClick('cancel'); window.__qa.release('convert:' + window.__qa.config.targets[1].path)",
                );
                await waitIdle();
                assert.equal(await run("window.__qa.convertCalls.length"), 2);
                await capture("cancelled");
                const result = await closeAndResult();
                assert.equal(result.cancelled, true);
                assert.equal(result.written.length, 2);
                assert.equal(result.rows[2].status, "cancelled");
            },
        );

        const originalStartDrag = dashboard.webContents.startDrag.bind(
            dashboard.webContents,
        );
        const nativeDragPaths = [];
        let rejectFirstDrag = true;
        dashboard.webContents.startDrag = (item) => {
            nativeDragPaths.push(item.file);
            if (rejectFirstDrag) {
                rejectFirstDrag = false;
                throw new Error("Fixture native drag rejection");
            }
        };
        await check(
            "drag cancel and dispatch retry reuse one prepared file",
            async () => {
                const before = fs.readdirSync(fixtures).length;
                await open({
                    delayPathsOnce: [source],
                    settings: { ...defaultSettings("jpg") },
                });
                assert.equal(
                    await run(
                        "document.querySelector('[data-convert-options]').open",
                    ),
                    false,
                );
                await pause(180);
                assert.equal(fs.readdirSync(fixtures).length, before);
                await run(
                    "document.querySelector('[data-convert-options]').open=true",
                );
                await run(
                    "document.querySelector('[data-convert-action=\"prepare-drag\"]').dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))",
                );
                assert.equal(fs.readdirSync(fixtures).length, before);
                await run("window.__qaClick('prepare-drag')");
                await until(
                    () =>
                        run(
                            "document.querySelector('[data-drag-status]').dataset.dragStatus === 'preparing'",
                        ),
                    "Drag did not enter preparing",
                );
                await run(
                    "window.__qaClick('cancel-drag'); window.__qa.release('convert:' + window.__qa.config.targets[0].path)",
                );
                await waitIdle();
                assert.equal(await run("window.__qa.dragCalls.length"), 0);

                await open({ settings: { ...defaultSettings("jpg") } });
                await run(
                    "document.querySelector('[data-convert-options]').open=true",
                );
                await run("window.__qaClick('prepare-drag')");
                await until(
                    () =>
                        run(
                            "document.querySelector('[data-drag-status]').dataset.dragStatus === 'ready'",
                        ),
                    "Drag file did not become ready",
                );
                const preparedPath = await run(
                    "document.querySelector('[data-drag-status]').dataset.preparedPath",
                );
                await run("window.__qaClick('dispatch-drag')");
                await until(
                    () =>
                        run(
                            "document.querySelector('[data-drag-status]').dataset.dragStatus === 'error'",
                        ),
                    "Native rejection was not shown",
                );
                await capture("drag-error");
                await run("window.__qaClick('dispatch-drag')");
                await until(
                    () => run("window.__qa.dragCalls.length === 2"),
                    "Drag retry did not dispatch",
                );
                assert.deepEqual(await run("window.__qa.dragCalls"), [
                    preparedPath,
                    preparedPath,
                ]);
                assert.equal(await run("window.__qa.convertCalls.length"), 1);
                assert.deepEqual(nativeDragPaths.slice(-2), [
                    preparedPath,
                    preparedPath,
                ]);
            },
        );
        dashboard.webContents.startDrag = originalStartDrag;

        await check(
            "built-in and named presets survive overwrite and corruption",
            async () => {
                await open();
                await run(`(() => {
                const preset = document.querySelector('[data-convert-preset]');
                preset.value='builtin:1'; preset.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
                assert.equal(
                    await run(
                        "document.querySelector('[data-convert-format]').value",
                    ),
                    "webp",
                );
                await run(`
                window.__qaSet('scale', 75);
                document.querySelector('[data-convert-preset-name]').value='QA';
                window.__qaClick('save-preset');
                window.__qaSet('scale', 50);
                window.__qaClick('save-preset');
            `);
                assert.equal(
                    await run(
                        "JSON.parse(localStorage.getItem('oc:convert-named-presets-v1')).length",
                    ),
                    1,
                );
                await run(
                    "window.__qaClick('close'); void window.__qaOpen({targets:window.__qa.config.targets,keepStorage:true})",
                );
                await run(`(() => {
                const preset = document.querySelector('[data-convert-preset]');
                preset.value='local:0'; preset.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
                assert.equal(
                    await run(
                        "document.querySelector('[data-convert-option=\"scale\"]').value",
                    ),
                    "50",
                );
                await run("window.__qaClick('delete-preset')");
                assert.equal(
                    await run(
                        "JSON.parse(localStorage.getItem('oc:convert-named-presets-v1')).length",
                    ),
                    0,
                );
                await run(`
                window.__qaClick('close');
                localStorage.setItem('oc:convert-named-presets-v1','{bad');
                void window.__qaOpen({targets:[{path:${JSON.stringify(source)},name:'original.png'}],keepStorage:true});
            `);
                assert.equal(
                    await run(
                        "document.querySelector('[data-convert-preset]').options.length",
                    ),
                    3,
                );
            },
        );

        await check(
            "stale preview cannot replace the latest format",
            async () => {
                await open({ delayFirstPreview: true });
                await until(
                    () => run("Boolean(window.__qa.releases['preview:first'])"),
                    "First preview was not deferred",
                );
                await capture("preview-loading");
                await run("window.__qaSelectFormat('jpg')");
                await until(
                    () =>
                        run(
                            "window.__qa.previewCalls.length >= 2 && document.querySelector('.convert-donut-preview-meta small').textContent.includes('JPG')",
                        ),
                    "Second preview was not visible",
                );
                await run("window.__qa.release('preview:first')");
                await pause(100);
                assert.match(
                    await run(
                        "document.querySelector('.convert-donut-preview-meta small').textContent",
                    ),
                    /JPG/,
                );
                assert.equal(await run("window.__qa.convertCalls.length"), 0);
            },
        );

        await check(
            "invalid options block conversion with an inline error",
            async () => {
                await open();
                await run(
                    "window.__qaSet('background', 'red'); window.__qaClick('convert')",
                );
                assert.equal(await run("window.__qa.convertCalls.length"), 0);
                assert.equal(
                    await run(
                        "document.querySelector('.convert-donut-error').hidden",
                    ),
                    false,
                );
                await run(
                    "window.__qaSet('background', ''); window.__qaSet('scale', 101); window.__qaClick('convert')",
                );
                assert.equal(await run("window.__qa.convertCalls.length"), 0);
            },
        );

        await check(
            "compact dialog stays reachable at 380 by 560",
            async () => {
                dashboard.setMinimumSize(360, 500);
                dashboard.setContentSize(380, 560);
                await pause(100);
                await open();
                await run(
                    "document.querySelector('.toast.visible')?.classList.remove('visible')",
                );
                const metrics = await run(`(() => {
                const dialog=document.querySelector('[data-convert-dialog]');
                const rect=dialog.getBoundingClientRect();
                const convert=document.querySelector('[data-convert-action="convert"]').getBoundingClientRect();
                return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
                    viewportWidth:innerWidth,viewportHeight:innerHeight,
                    scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth,
                    convertBottom:convert.bottom};
            })()`);
                assert.ok(
                    metrics.left >= 0 && metrics.right <= metrics.viewportWidth,
                );
                assert.ok(
                    metrics.top >= 0 &&
                        metrics.bottom <= metrics.viewportHeight,
                );
                assert.ok(metrics.scrollWidth <= metrics.clientWidth);
                assert.ok(metrics.convertBottom <= metrics.viewportHeight);
                await capture("compact");
                const optionsReachable = await run(`(() => {
                    const details=document.querySelector('[data-convert-options]');
                    details.open=true;
                    const scale=document.querySelector('[data-convert-option="scale"]');
                    scale.scrollIntoView({block:'nearest'});
                    const rect=scale.getBoundingClientRect();
                    const reachable=rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;
                    details.open=false;
                    document.querySelector('.convert-donut-body').scrollTop=0;
                    return reachable;
                })()`);
                assert.equal(optionsReachable, true);
                if (!dashboard.webContents.debugger.isAttached())
                    dashboard.webContents.debugger.attach("1.3");
                await dashboard.webContents.debugger.sendCommand(
                    "Emulation.setEmulatedMedia",
                    {
                        features: [
                            { name: "prefers-reduced-motion", value: "reduce" },
                            { name: "forced-colors", value: "active" },
                        ],
                    },
                );
                await pause(100);
                assert.equal(
                    await run(
                        "getComputedStyle(document.querySelector('[data-convert-dialog]')).animationName",
                    ),
                    "none",
                );
                await capture("compact-accessibility");
                dashboard.webContents.debugger.detach();
            },
        );

        for (const [file, expected] of originalHashes)
            assert.equal(
                hash(file),
                expected,
                `${path.basename(file)} changed`,
            );
        report.originalsPreserved = true;
        const dashboardAsset = fs
            .readdirSync(path.join(root, "out", "renderer", "assets"))
            .find((name) => /^dashboard-.*\.js$/.test(name));
        const stamp = (file) => ({
            path: path.relative(root, file),
            modified: fs.statSync(file).mtime.toISOString(),
            sha256: hash(file),
        });
        report.sourceBuildStamps = {
            convertSource: stamp(
                path.join(root, "src", "renderer", "lib", "convertDonut.ts"),
            ),
            convertStyles: stamp(
                path.join(root, "src", "renderer", "lib", "convertDonut.css"),
            ),
            dashboardBundle: stamp(
                path.join(root, "out", "renderer", "assets", dashboardAsset),
            ),
            mainBundle: stamp(path.join(root, "out", "main", "main.js")),
        };
        report.coverage = {
            ...report.coverage,
            checks: report.checks.length,
            bulkRegistration: 45,
            sourceResultComparison: true,
            nativeDrag: "dispatch acceptance/rejection only",
            compactViewport: "380x560",
        };
        report.ok =
            report.checks.every((item) => item.ok) && !report.errors.length;
        clearTimeout(timer);
        finish(report.ok ? 0 : 1);
    } catch (error) {
        clearTimeout(timer);
        report.errors.push(error.stack || error.message);
        report.ok = false;
        finish(1);
    }
});

function defaultSettings(format) {
    return {
        format,
        scale: 1,
        quality: 0.92,
        maxWidth: 0,
        background: "",
        namePattern: "{name}",
        signature: "",
        register: false,
    };
}
