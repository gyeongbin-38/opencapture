const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "main", "main.ts");
const sourceText = fs.readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

function extractDeclarations(functionNames, variableNames = []) {
    const wantedFunctions = new Set(functionNames);
    const wantedVariables = new Set(variableNames);
    const foundFunctions = new Set();
    const foundVariables = new Set();
    const declarations = [];

    for (const statement of sourceFile.statements) {
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name &&
            wantedFunctions.has(statement.name.text)
        ) {
            declarations.push(statement.getFullText(sourceFile));
            foundFunctions.add(statement.name.text);
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            const names = statement.declarationList.declarations
                .map((declaration) =>
                    ts.isIdentifier(declaration.name)
                        ? declaration.name.text
                        : undefined,
                )
                .filter(Boolean);
            if (names.some((name) => wantedVariables.has(name))) {
                declarations.push(statement.getFullText(sourceFile));
                for (const name of names) {
                    if (wantedVariables.has(name)) foundVariables.add(name);
                }
            }
        }
    }

    assert.deepEqual(
        [...foundFunctions].sort(),
        [...wantedFunctions].sort(),
        "all requested production functions must be extracted",
    );
    assert.deepEqual(
        [...foundVariables].sort(),
        [...wantedVariables].sort(),
        "all requested production state must be extracted",
    );
    return declarations.join("\n");
}

function extractMainOnCallback(key) {
    for (const statement of sourceFile.statements) {
        if (!ts.isExpressionStatement(statement)) continue;
        const call = statement.expression;
        if (
            !ts.isCallExpression(call) ||
            call.expression.getText(sourceFile) !== "mainOn" ||
            call.arguments[0]?.getText(sourceFile) !== JSON.stringify(key) ||
            !call.arguments[1]
        )
            continue;
        return call.arguments[1].getText(sourceFile);
    }
    throw new Error(`Production mainOn callback missing: ${key}`);
}

function evaluateProduction(code, globals, exports) {
    const expose = exports
        .map((name) => `globalThis.${name} = ${name};`)
        .join("\n");
    const javascript = ts.transpileModule(`${code}\n${expose}`, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const context = vm.createContext({
        console,
        Math,
        Number,
        Date,
        Promise,
        ...globals,
    });
    vm.runInContext(javascript, context, { filename: sourcePath });
    return context;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

async function flushMicrotasks(rounds = 8) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createFakeTimers() {
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeout(callback, delay) {
            const id = nextId++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        pending() {
            return [...timers.values()].map(({ delay }) => delay);
        },
        async runNext() {
            const next = timers.entries().next();
            assert.equal(next.done, false, "expected a pending fake timer");
            const [id, timer] = next.value;
            timers.delete(id);
            timer.callback();
            await flushMicrotasks();
        },
    };
}

const captureCode = extractDeclarations(["captureRegion"]);
const sendCaptureCode = extractDeclarations(["sendCaptureEvent"]);
const quickClipCode = extractDeclarations(["quickClip"]);
const clipSaveCode = extractMainOnCallback("clip_save");
const recordSavePathCode = extractMainOnCallback("recordSavePath");
const recaptureCode = extractDeclarations(["recaptureLast"]);
const recorderCode = extractDeclarations(
    ["createRecorderWindow"],
    ["recorderWinW", "recorderWinH"],
);
const fullScreenCode = extractDeclarations(
    ["fullScreen"],
    ["pendingClipInit", "captureAcquireSequence"],
);
const shelfCode = extractDeclarations(
    ["hideCaptureShelf", "restoreCaptureShelf"],
    ["captureShelfWindow", "shelfPendingReshow", "shelfVisibilitySequence"],
);
const watchdogCode = extractDeclarations(
    ["clearCaptureInitWatchdog", "startCaptureInitWatchdog"],
    ["captureInitWatchdog", "pendingClipInit", "captureAcquireSequence"],
);
const radialCode = extractDeclarations(
    ["showRadial", "radialTrack"],
    ["RADIAL_SIZE", "radialState"],
);
const repeatCode = extractDeclarations(
    [
        "updateRepeatUi",
        "stopRepeatJob",
        "waitForRepeat",
        "runRepeatJob",
        "repeatLastRegion",
    ],
    ["repeatJob"],
);

async function testCaptureRegionUsesRasterDimensionsAndSelectedDisplay() {
    const displays = [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, bounds: { x: -1000, y: 100, width: 1000, height: 800 } },
    ];
    const cropCalls = [];
    const clipboard = [];
    const saved = [];
    const raster = {
        isEmpty: () => false,
        getSize: () => ({ width: 1500, height: 1600 }),
        crop(rect) {
            cropCalls.push(rect);
            return { isEmpty: () => false, marker: "cropped" };
        },
    };
    let displaysPassedToCapture;
    const context = evaluateProduction(
        captureCode,
        {
            screen: {
                getAllDisplays: () => displays,
                getDisplayNearestPoint: () => {
                    throw new Error(
                        "saved display id should select the display",
                    );
                },
            },
            screenShotArgs: ["mock-option"],
            initScreenShots: (...args) => {
                assert.deepEqual(args, ["mock-option"]);
                return async (receivedDisplays) => {
                    displaysPassedToCapture = receivedDisplays;
                    return {
                        screen: [
                            {
                                id: 2,
                                capture: async () => ({
                                    toNativeImage: () => raster,
                                }),
                            },
                        ],
                    };
                };
            },
            writeImageToClipboard: async (image) => clipboard.push(image),
            openCapture: { saveImage: (...args) => saved.push(args) },
        },
        ["captureRegion"],
    );

    const ok = await context.captureRegion({
        displayId: 2,
        x: -750,
        y: 300,
        w: 100,
        h: 50,
    });

    assert.equal(ok, true);
    assert.equal(displaysPassedToCapture, displays);
    assert.deepEqual(plain(cropCalls), [
        { x: 375, y: 400, width: 150, height: 100 },
    ]);
    assert.equal(clipboard.length, 1);
    assert.deepEqual(saved, [[clipboard[0], "Recapture"]]);
}

async function testCaptureRegionAtCommonScaleFactors() {
    const display = {
        id: 7,
        bounds: { x: -1280, y: -720, width: 1280, height: 720 },
    };
    for (const [rasterSize, expected] of [
        [
            { width: 1280, height: 720 },
            { x: 20, y: 30, width: 160, height: 80 },
        ],
        [
            { width: 1600, height: 900 },
            { x: 25, y: 37, width: 200, height: 101 },
        ],
        [
            { width: 2560, height: 1440 },
            { x: 40, y: 60, width: 320, height: 160 },
        ],
    ]) {
        let crop;
        const raster = {
            isEmpty: () => false,
            getSize: () => rasterSize,
            crop: (rect) => {
                crop = plain(rect);
                return { isEmpty: () => false };
            },
        };
        const context = evaluateProduction(
            captureCode,
            {
                screen: {
                    getAllDisplays: () => [display],
                    getDisplayNearestPoint: () => display,
                },
                screenShotArgs: [],
                initScreenShots: () => async () => ({
                    screen: [
                        {
                            id: 7,
                            capture: async () => ({
                                toNativeImage: () => raster,
                            }),
                        },
                    ],
                }),
                writeImageToClipboard: async () => {},
                openCapture: { saveImage: () => {} },
            },
            ["captureRegion"],
        );
        assert.equal(
            await context.captureRegion({
                displayId: 7,
                x: -1260,
                y: -690,
                w: 160,
                h: 80,
            }),
            true,
        );
        assert.deepEqual(crop, expected);
    }
}

async function testCaptureRegionHandlesUnavailableCapture() {
    let initialized = 0;
    const emptyContext = evaluateProduction(
        captureCode,
        {
            screen: {
                getAllDisplays: () => [],
                getDisplayNearestPoint: () => null,
            },
            screenShotArgs: [],
            initScreenShots: () => {
                initialized += 1;
                return async () => ({ screen: [] });
            },
            writeImageToClipboard: async () => {},
            openCapture: null,
        },
        ["captureRegion"],
    );
    assert.equal(
        await emptyContext.captureRegion({ x: 0, y: 0, w: 10, h: 10 }),
        false,
    );
    assert.equal(initialized, 0);

    const display = { id: 9, bounds: { x: 0, y: 0, width: 100, height: 100 } };
    let clipboardWrites = 0;
    const missingContext = evaluateProduction(
        captureCode,
        {
            screen: {
                getAllDisplays: () => [display],
                getDisplayNearestPoint: () => display,
            },
            screenShotArgs: [],
            initScreenShots: () => async () => ({ screen: [] }),
            writeImageToClipboard: async () => {
                clipboardWrites += 1;
            },
            openCapture: null,
        },
        ["captureRegion"],
    );
    assert.equal(
        await missingContext.captureRegion({ x: 0, y: 0, w: 10, h: 10 }),
        false,
    );
    assert.equal(clipboardWrites, 0);
}

async function testDelayedCaptureSelectsDisplayAtAcquisitionAndFreezesIt() {
    const clipWindowReady = deferred();
    const delivered = [];
    const displayCalls = [];
    let cursorDisplayId = 1;
    let releaseDelay;
    const context = evaluateProduction(
        sendCaptureCode,
        {
            captureAcquireSequence: 0,
            capturePrepareQueue: Promise.resolve(),
            pendingClipInit: null,
            captureDiagnostics: [],
            clipWindowLoaded: true,
            clipWindow: { isDestroyed: () => false },
            clearCaptureInitWatchdog: () => {},
            randomUUID: () => "request",
            captureInput: { getStore: () => undefined },
            nativeDispatch: false,
            currentCaptureSource: () => ({
                kind: "capture",
                capturedAt: "2026-10-29T00:00:00.000Z",
            }),
            addCaptureDiagnostic: () => {},
            store: { get: (key) => (key === "框选.延迟" ? 3 : undefined) },
            setTimeout: (callback) => {
                releaseDelay = callback;
                return 1;
            },
            flushCaptureDraft: async () => true,
            diagnosticInput: () => "test",
            hideCaptureShelf: () => 4,
            restoreCaptureShelf: () => {},
            screen: {
                getCursorScreenPoint: () => ({
                    x: cursorDisplayId * 100,
                    y: 0,
                }),
                getDisplayNearestPoint: () => {
                    displayCalls.push(cursorDisplayId);
                    return { id: cursorDisplayId };
                },
            },
            getClipWin: () => clipWindowReady.promise,
            deliverClipInit: (_win, pending) => delivered.push(pending),
        },
        ["sendCaptureEvent"],
    );

    const capture = context.sendCaptureEvent();
    await flushMicrotasks();
    assert.equal(typeof releaseDelay, "function");
    assert.deepEqual(displayCalls, []);

    cursorDisplayId = 2;
    releaseDelay();
    await flushMicrotasks();
    assert.deepEqual(displayCalls, [2]);

    cursorDisplayId = 3;
    clipWindowReady.resolve({});
    await capture;
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].displayId, 2);
    assert.deepEqual(displayCalls, [2]);
}

function captureArbitrationHarness(options = {}) {
    const delivered = [];
    const clipboard = [];
    let releaseDelay;
    const screenShots =
        options.screenShots ??
        Promise.resolve({
            screen: [
                {
                    id: 1,
                    capture: async () => ({
                        toNativeImage: () => ({ isEmpty: () => false, id: 1 }),
                    }),
                },
            ],
        });
    const context = evaluateProduction(
        `${sendCaptureCode}\n${quickClipCode}`,
        {
            captureAcquireSequence: 0,
            capturePrepareQueue: Promise.resolve(),
            pendingClipInit: null,
            captureDiagnostics: [],
            clipWindowLoaded: true,
            clipWindow: { isDestroyed: () => false },
            clearCaptureInitWatchdog: () => {},
            randomUUID: () => `request-${delivered.length + 1}`,
            captureInput: { getStore: () => undefined },
            nativeDispatch: false,
            currentCaptureSource: () => ({
                kind: "capture",
                capturedAt: "2026-10-30T00:00:00.000Z",
            }),
            addCaptureDiagnostic: () => {},
            diagnosticInput: () => "test",
            store: {
                get: (key) => {
                    if (key === "框选.延迟") return options.delay ?? 0;
                    if (key === "快速截屏.模式") return "clip";
                    return "";
                },
            },
            setTimeout: (callback) => {
                releaseDelay = callback;
                return 1;
            },
            flushCaptureDraft: async () => true,
            hideCaptureShelf: () => 4,
            restoreCaptureShelf: () => {},
            screen: {
                getAllDisplays: () => [{ id: 1 }],
                getCursorScreenPoint: () => ({ x: 10, y: 10 }),
                getDisplayNearestPoint: () => ({ id: 1 }),
            },
            getClipWin: async () => ({}),
            deliverClipInit: (_win, pending) => delivered.push(pending),
            screenShotArgs: [],
            initScreenShots: () => async () => screenShots,
            writeImageToClipboard: async (image) => clipboard.push(image.id),
            Notification: class {
                show() {}
            },
            app: { name: "OpenCapture" },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            runPath: "run",
            console: { error() {} },
        },
        ["sendCaptureEvent", "quickClip"],
    );
    return {
        context,
        delivered,
        clipboard,
        releaseDelay: () => releaseDelay,
    };
}

async function testQuickCaptureSupersedesDelayedInteractiveCapture() {
    const h = captureArbitrationHarness({ delay: 3 });
    const delayed = h.context.sendCaptureEvent();
    await flushMicrotasks();
    assert.equal(typeof h.releaseDelay(), "function");
    assert.equal(await h.context.quickClip(), true);
    h.releaseDelay()();
    await delayed;
    assert.deepEqual(h.clipboard, [1]);
    assert.deepEqual(h.delivered, []);
}

async function testInteractiveCaptureSupersedesUnfinishedQuickCapture() {
    const provider = deferred();
    const h = captureArbitrationHarness({ screenShots: provider.promise });
    const quick = h.context.quickClip();
    await flushMicrotasks();
    const interactive = h.context.sendCaptureEvent();
    await interactive;
    provider.resolve({
        screen: [
            {
                id: 1,
                capture: async () => ({
                    toNativeImage: () => ({ isEmpty: () => false, id: 1 }),
                }),
            },
        ],
    });
    assert.equal(await quick, false);
    assert.deepEqual(h.clipboard, []);
    assert.equal(h.delivered.length, 1);
}

async function testCancelledSaveDoesNotResurrectSupersededCapture() {
    const picked = deferred();
    const shown = [];
    const sender = {};
    const context = evaluateProduction(
        `globalThis.clipSaveHandler = ${clipSaveCode};`,
        {
            captureAcquireSequence: 1,
            store: { get: () => "" },
            dialog: { showSaveDialog: () => picked.promise },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            getFileName: () => "capture",
            app: { name: "OpenCapture" },
            runPath: "run",
            Notification: class {
                show() {}
            },
            clipWindow: {
                webContents: sender,
                isDestroyed: () => false,
                show: () => shown.push("show"),
                setSimpleFullScreen: (value) =>
                    shown.push(["fullscreen", value]),
            },
        },
        ["clipSaveHandler"],
    );
    const saving = context.clipSaveHandler(["png"], { sender });
    context.captureAcquireSequence = 2;
    picked.resolve({ canceled: true });
    await saving;
    assert.deepEqual(shown, []);
    await context.clipSaveHandler(["png"], { sender });
    assert.deepEqual(shown, ["show", ["fullscreen", true]]);
}

async function testRecorderControlsUseSelectedDisplayAndCompactBounds() {
    const configs = [];
    const handlers = [];
    const recorderContents = [];
    const shortcutCalls = [];
    const ipcHandlers = {};
    const sent = [];
    let sources = [
        { id: "screen:1", display_id: "1" },
        { id: "screen:3", display_id: "3" },
    ];
    let displays = [
        { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { id: 2, bounds: { x: 1000, y: 0, width: 800, height: 600 } },
    ];
    class BrowserWindow {
        constructor(config) {
            configs.push(config);
            this.webContents = {};
            recorderContents.push(this.webContents);
            this.handlers = {};
            handlers.push(this.handlers);
        }
        on(name, callback) {
            this.handlers[name] = callback;
        }
        isDestroyed() {
            return false;
        }
        show() {}
        focus() {}
        getBounds() {
            return configs[0];
        }
    }
    const context = evaluateProduction(
        recorderCode,
        {
            screen: {
                getCursorScreenPoint: () => ({ x: 50, y: 50 }),
                getAllDisplays: () => displays,
                getDisplayNearestPoint: () => ({
                    id: 1,
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                }),
            },
            BrowserWindow,
            baseWinConfig: () => ({ show: false }),
            _recorder: undefined,
            _recorderTipWin: undefined,
            showWhenReady: () => {},
            rendererPath: () => {},
            dev: false,
            store: { set: () => {} },
            mainOn: (name, callback) => {
                ipcHandlers[name] = callback;
            },
            desktopCapturer: { getSources: async () => sources },
            mainSend: (_contents, event, data) => sent.push([event, data]),
            globalShortcut: {
                register: (key) => shortcutCalls.push(["register", key]),
                unregister: (key) => shortcutCalls.push(["unregister", key]),
            },
            createRecorderTipWindow: () => ({ close() {} }),
            recording: false,
            checkWin: (window) => window && !window.isDestroyed(),
        },
        ["createRecorderWindow"],
    );

    context.createRecorderWindow([100, 100, 200, 150], {
        id: "2",
        w: 800,
        h: 600,
        r: 1,
    });
    assert.deepEqual(plain(configs[0]), {
        show: false,
        x: 1100,
        y: 52,
        width: 340,
        height: 40,
    });
    await ipcHandlers.recorderReady([], {
        sender: recorderContents[0],
    });
    assert.deepEqual(plain(sent), [["recordInitError", []]]);
    sent.length = 0;
    sources = [
        { id: "screen:1", display_id: "1" },
        { id: "screen:2", display_id: "2" },
    ];
    await ipcHandlers.recorderReady([], {
        sender: recorderContents[0],
    });
    assert.deepEqual(plain(sent), [
        ["recordInit", ["screen:2", [100, 100, 200, 150], 800, 600]],
    ]);
    sent.length = 0;
    sources = [{ id: "screen:only", display_id: "legacy" }];
    displays = [displays[1]];
    await ipcHandlers.recorderReady([], {
        sender: recorderContents[0],
    });
    assert.deepEqual(plain(sent), [
        ["recordInit", ["screen:only", [100, 100, 200, 150], 800, 600]],
    ]);
    context.createRecorderWindow([100, 100, 200, 150], {
        id: "2",
        w: 800,
        h: 600,
        r: 1,
    });
    assert.equal(configs.length, 1);
    handlers[0].close();
    assert.equal(context.recording, false);
    assert.deepEqual(shortcutCalls, [
        ["register", "Super+R"],
        ["unregister", "Super+R"],
    ]);
}

async function testQuickPathModeRequiresDestinationBeforeCapture() {
    let acquisitions = 0;
    let writes = 0;
    const notifications = [];
    class Notification {
        constructor(options) {
            this.options = options;
        }
        show() {
            notifications.push(this.options);
        }
    }
    const context = evaluateProduction(
        quickClipCode,
        {
            captureAcquireSequence: 0,
            pendingClipInit: null,
            clearCaptureInitWatchdog: () => {},
            flushCaptureDraft: async () => true,
            hideCaptureShelf: () => 1,
            restoreCaptureShelf: () => {},
            store: {
                get: (key) => (key === "快速截屏.模式" ? "path" : ""),
            },
            screen: {
                getAllDisplays: () => [{ id: 1 }],
                getCursorScreenPoint: () => ({ x: 0, y: 0 }),
                getDisplayNearestPoint: () => ({ id: 1 }),
            },
            screenShotArgs: [],
            initScreenShots: () => async () => {
                acquisitions += 1;
                return { screen: [] };
            },
            writeImageToClipboard: async () => {
                writes += 1;
            },
            writeFileSync: () => {
                writes += 1;
            },
            Notification,
            app: { name: "OpenCapture" },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            runPath: "run",
            console: { error() {} },
        },
        ["quickClip"],
    );

    assert.equal(await context.quickClip(), false);
    assert.equal(acquisitions, 0);
    assert.equal(writes, 0);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].body, /저장 폴더/);
}

async function testRecorderSaveExtensionUsesFilenameOnly() {
    for (const [picked, expected, ext = "mp4"] of [
        ["C:\\work.v2\\capture", "C:\\work.v2\\capture.mp4"],
        ["C:\\work.v2\\capture.webm", "C:\\work.v2\\capture.webm"],
        ["C:\\work.v2\\capture-two", "C:\\work.v2\\capture-two.mp4", ".MP4"],
    ]) {
        const sent = [];
        const recorder = { webContents: {} };
        const context = evaluateProduction(
            `globalThis.recordSavePathHandler = ${recordSavePathCode};`,
            {
                store: { get: () => "" },
                dialog: {
                    showSaveDialog: async () => ({ filePath: picked }),
                },
                t: (value) => value,
                join: (...parts) => parts.join("/"),
                getFileName: () => "capture",
                extname: (value) => {
                    const name = value.split(/[\\/]/).at(-1);
                    const index = name.lastIndexOf(".");
                    return index > 0 ? name.slice(index) : "";
                },
                checkWin: () => true,
                _recorder: recorder,
                mainSend: (_contents, event, data) => sent.push([event, data]),
            },
            ["recordSavePathHandler"],
        );
        context.recordSavePathHandler([ext], {});
        await flushMicrotasks();
        assert.deepEqual(plain(sent), [
            ["recordSavePathReturn", [{ status: "selected", path: expected }]],
        ]);
    }
}

async function testQuickClipboardCapturesOnlyCursorDisplay() {
    const clipboard = [];
    const context = evaluateProduction(
        quickClipCode,
        {
            captureAcquireSequence: 0,
            pendingClipInit: null,
            clearCaptureInitWatchdog: () => {},
            flushCaptureDraft: async () => true,
            hideCaptureShelf: () => {},
            restoreCaptureShelf: () => {},
            screen: {
                getCursorScreenPoint: () => ({ x: 150, y: 20 }),
                getDisplayNearestPoint: () => ({ id: 2 }),
                getAllDisplays: () => [{ id: 1 }, { id: 2 }],
            },
            screenShotArgs: [],
            initScreenShots: () => async () => ({
                screen: [
                    {
                        id: 1,
                        capture: async () => ({
                            toNativeImage: () => ({
                                isEmpty: () => false,
                                id: 1,
                            }),
                        }),
                    },
                    {
                        id: 2,
                        capture: async () => ({
                            toNativeImage: () => ({
                                isEmpty: () => false,
                                id: 2,
                            }),
                        }),
                    },
                ],
            }),
            store: { get: (key) => (key === "快速截屏.模式" ? "clip" : "") },
            writeImageToClipboard: async (image) => clipboard.push(image.id),
            Notification: class {
                show() {}
            },
            app: { name: "OpenCapture" },
            t: (value) => value,
        },
        ["quickClip"],
    );

    await context.quickClip();
    assert.deepEqual(clipboard, [2]);
}

async function testQuickCaptureReportsEmptyImageAndRestoresShelf() {
    const notifications = [];
    let restores = 0;
    class Notification {
        constructor(options) {
            this.options = options;
        }
        show() {
            notifications.push(this.options);
        }
    }
    const context = evaluateProduction(
        quickClipCode,
        {
            captureAcquireSequence: 0,
            pendingClipInit: null,
            clearCaptureInitWatchdog: () => {},
            flushCaptureDraft: async () => true,
            hideCaptureShelf: () => 7,
            restoreCaptureShelf: (sequence) => {
                assert.equal(sequence, 7);
                restores += 1;
            },
            screen: {
                getCursorScreenPoint: () => ({ x: 10, y: 10 }),
                getDisplayNearestPoint: () => ({ id: 1 }),
                getAllDisplays: () => [{ id: 1 }],
            },
            screenShotArgs: [],
            initScreenShots: () => async () => ({
                screen: [
                    {
                        id: 1,
                        capture: async () => ({
                            toNativeImage: () => ({ isEmpty: () => true }),
                        }),
                    },
                ],
            }),
            store: { get: (key) => (key === "快速截屏.模式" ? "clip" : "") },
            writeImageToClipboard: async () =>
                assert.fail("empty image copied"),
            Notification,
            app: { name: "OpenCapture" },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            runPath: "run",
            console: { error() {} },
        },
        ["quickClip"],
    );

    assert.equal(await context.quickClip(), false);
    assert.equal(restores, 1);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].body, /empty image/i);
}

async function testCaptureOverlayUsesFrozenDisplay() {
    const calls = [];
    const context = evaluateProduction(
        `${fullScreenCode}\nglobalThis.__setPending = (value) => { pendingClipInit = value; };\nglobalThis.__setSequence = (value) => { captureAcquireSequence = value; };`,
        {
            getClipWin: async () => ({
                setBounds: (bounds) => calls.push(["bounds", bounds]),
                show: () => calls.push(["show"]),
                setSimpleFullScreen: (value) =>
                    calls.push(["fullscreen", value]),
            }),
            screen: {
                getAllDisplays: () => [
                    { id: 1, bounds: { x: 0, y: 0 } },
                    { id: 2, bounds: { x: 100, y: -20 } },
                ],
            },
        },
        ["fullScreen"],
    );
    context.__setPending({
        sequence: 1,
        displayId: 2,
        context: { requestId: "request" },
    });
    context.__setSequence(1);
    await context.fullScreen("request", 2);
    assert.deepEqual(plain(calls), [
        ["bounds", { x: 100, y: -20 }],
        ["show"],
        ["fullscreen", true],
    ]);
}

async function testSupersededShowCannotResurrectOverlay() {
    const ready = deferred();
    const calls = [];
    const context = evaluateProduction(
        `${fullScreenCode}\nglobalThis.__setPending = (value) => { pendingClipInit = value; };\nglobalThis.__setSequence = (value) => { captureAcquireSequence = value; };`,
        {
            getClipWin: () => ready.promise,
            screen: {
                getAllDisplays: () => [
                    { id: 1, bounds: { x: 0, y: 0 } },
                    { id: 2, bounds: { x: 100, y: 0 } },
                ],
                getCursorScreenPoint: () => ({ x: 10, y: 10 }),
                getDisplayNearestPoint: () => ({
                    id: 1,
                    bounds: { x: 0, y: 0 },
                }),
            },
        },
        ["fullScreen"],
    );
    context.__setPending({
        sequence: 1,
        displayId: 1,
        context: { requestId: "old" },
    });
    context.__setSequence(1);
    const showing = context.fullScreen("old", 1);
    context.__setPending({
        sequence: 2,
        displayId: 2,
        context: { requestId: "new" },
    });
    context.__setSequence(2);
    ready.resolve({
        setBounds: (bounds) => calls.push(["bounds", bounds]),
        show: () => calls.push(["show"]),
        setSimpleFullScreen: (value) => calls.push(["fullscreen", value]),
    });
    await showing;
    assert.deepEqual(calls, []);
}

async function testRecaptureFallsBackWhenSavedRegionIsStale() {
    const fallbacks = [];
    const context = evaluateProduction(
        recaptureCode,
        {
            store: {
                get: () => ({ displayId: 99, x: 0, y: 0, w: 20, h: 20 }),
            },
            captureRegion: async () => false,
            captureInput: {
                run: (input, run) => {
                    fallbacks.push(input);
                    return run();
                },
            },
            sendCaptureEvent: async () => fallbacks.push("interactive"),
            Notification: class {
                show() {}
            },
            app: { name: "OpenCapture" },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            runPath: "run",
            console,
        },
        ["recaptureLast"],
    );

    await context.recaptureLast();
    assert.deepEqual(fallbacks, ["recapture", "interactive"]);
}

async function testOnlyLatestShelfHideCanRestore() {
    let visible = true;
    let restores = 0;
    const shelf = {
        isDestroyed: () => false,
        isVisible: () => visible,
        hide: () => {
            visible = false;
        },
    };
    const context = evaluateProduction(
        `${shelfCode}\ncaptureShelfWindow = globalThis.__shelf;\nglobalThis.__setPendingReshow = (value) => { shelfPendingReshow = value; };`,
        {
            __shelf: shelf,
            showCaptureShelf: async () => {
                restores += 1;
            },
            console,
        },
        ["hideCaptureShelf", "restoreCaptureShelf"],
    );
    const stale = context.hideCaptureShelf();
    context.__setPendingReshow(true);
    const latest = context.hideCaptureShelf();
    context.restoreCaptureShelf(stale);
    await flushMicrotasks();
    assert.equal(restores, 0);
    context.restoreCaptureShelf(latest);
    await flushMicrotasks();
    assert.equal(restores, 1);
}

async function testStaleWatchdogCannotFailNewRequest() {
    const timers = createFakeTimers();
    const failures = [];
    const context = evaluateProduction(
        `${watchdogCode}\nglobalThis.__setPending = (value) => { pendingClipInit = value; };\nglobalThis.__setSequence = (value) => { captureAcquireSequence = value; };`,
        {
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            failPendingCapture: (...args) => failures.push(args),
        },
        ["startCaptureInitWatchdog"],
    );
    const oldRequest = { sequence: 1, context: { requestId: "old" } };
    context.__setPending(oldRequest);
    context.__setSequence(1);
    context.startCaptureInitWatchdog(oldRequest);
    context.__setPending({ sequence: 2, context: { requestId: "new" } });
    context.__setSequence(2);
    await timers.runNext();
    assert.deepEqual(failures, []);
}

function testRadialUsesVisibleDipCenterAtScreenEdge() {
    const sent = [];
    const boundsCalls = [];
    const win = {
        webContents: { isLoading: () => false },
        setBounds: (bounds) => boundsCalls.push(bounds),
        showInactive() {},
    };
    const context = evaluateProduction(
        radialCode,
        {
            radialItems: () => ["copy", "save", "pin", "ocr"],
            ensureRadialWin: () => win,
            screen: {
                screenToDipPoint: ({ x, y }) => ({ x: x / 2, y: y / 2 }),
                getDisplayNearestPoint: () => ({
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                }),
            },
            mainSend: (_contents, event, args) => sent.push([event, args]),
            radialWin: win,
        },
        ["showRadial", "radialTrack", "radialState"],
    );

    context.showRadial(1590, 1190);
    assert.deepEqual(plain(boundsCalls), [
        { x: 540, y: 340, width: 260, height: 260 },
    ]);
    assert.equal(context.radialState.centerX, 670);
    assert.equal(context.radialState.centerY, 470);

    context.radialTrack(1340, 940);
    assert.equal(context.radialState.index, -1);
    assert.deepEqual(plain(sent.at(-1)), ["radialHighlight", [-1]]);
}

function makeRepeatHarness(captureRegion, count = 2) {
    const timers = createFakeTimers();
    const progress = [];
    const notifications = [];
    const errors = [];
    const values = new Map([
        ["捕获.上次区域", { displayId: 1, x: 0, y: 0, w: 20, h: 20 }],
        ["连拍.间隔", 5],
        ["连拍.数", count],
    ]);
    class Notification {
        constructor(options) {
            this.options = options;
        }
        show() {
            notifications.push(this.options);
        }
    }
    const context = evaluateProduction(
        `${repeatCode}\nglobalThis.__getRepeatJob = () => repeatJob;\nglobalThis.__setRepeatJob = (value) => { repeatJob = value; };`,
        {
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            captureRegion,
            openCapture: { progressBar: (value) => progress.push(value) },
            scheduleTrayRefresh() {},
            Notification,
            app: { name: "OpenCapture" },
            t: (value) => value,
            join: (...parts) => parts.join("/"),
            runPath: "run",
            store: { get: (key) => values.get(key) },
            captureInput: {
                run: () => assert.fail("unexpected capture fallback"),
            },
            sendCaptureEvent: () => {},
            console: { error: (...args) => errors.push(args) },
        },
        ["repeatLastRegion", "stopRepeatJob"],
    );
    return { context, timers, progress, notifications, errors };
}

async function testRepeatIsSerializedWhenCaptureIsSlow() {
    const captures = [];
    const harness = makeRepeatHarness(() => {
        const call = deferred();
        captures.push(call);
        return call.promise;
    });

    harness.context.repeatLastRegion();
    await flushMicrotasks();
    assert.equal(captures.length, 1);
    assert.deepEqual(harness.timers.pending(), []);

    captures[0].resolve(true);
    await flushMicrotasks();
    assert.deepEqual(harness.timers.pending(), [100]);
    assert.equal(captures.length, 1);

    await harness.timers.runNext();
    assert.equal(captures.length, 2);
    captures[1].resolve(true);
    await flushMicrotasks();

    assert.equal(harness.context.__getRepeatJob(), null);
    assert.deepEqual(harness.progress, [0, 0.5, 1, -1]);
    assert.equal(harness.notifications.length, 1);
}

async function testRepeatCountsThrownCaptureAsFailure() {
    let call = 0;
    const harness = makeRepeatHarness(async () => {
        call += 1;
        if (call === 1) throw new Error("capture failed");
        return true;
    });

    harness.context.repeatLastRegion();
    await flushMicrotasks();
    assert.equal(harness.errors.length, 1);
    await harness.timers.runNext();
    await flushMicrotasks();

    assert.equal(harness.context.__getRepeatJob(), null);
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0].body, /1\/2/);
    assert.match(harness.notifications[0].body, /실패 1/);
}

async function testCancelledJobCannotClearRestartedJob() {
    const captures = [];
    const harness = makeRepeatHarness(() => {
        const call = deferred();
        captures.push(call);
        return call.promise;
    });

    harness.context.repeatLastRegion();
    await flushMicrotasks();
    const oldJob = harness.context.__getRepeatJob();
    harness.context.stopRepeatJob();
    harness.context.repeatLastRegion();
    await flushMicrotasks();
    const newJob = harness.context.__getRepeatJob();
    assert.notEqual(newJob, oldJob);
    assert.equal(captures.length, 2);

    const progressBeforeOldSettles = harness.progress.length;
    captures[0].resolve(true);
    await flushMicrotasks();
    assert.equal(harness.context.__getRepeatJob(), newJob);
    assert.equal(harness.progress.length, progressBeforeOldSettles);
    assert.equal(harness.progress.at(-1), 0);

    harness.context.stopRepeatJob();
    captures[1].resolve(true);
    await flushMicrotasks();
    assert.equal(harness.context.__getRepeatJob(), null);
}

const tests = [
    [
        "captureRegion maps selected mixed-DPI display using actual raster size",
        testCaptureRegionUsesRasterDimensionsAndSelectedDisplay,
    ],
    [
        "negative display origins preserve 100%, 125% and 200% crop geometry",
        testCaptureRegionAtCommonScaleFactors,
    ],
    [
        "captureRegion safely handles no displays and missing capture target",
        testCaptureRegionHandlesUnavailableCapture,
    ],
    [
        "delayed capture chooses the acquisition display and freezes it afterward",
        testDelayedCaptureSelectsDisplayAtAcquisitionAndFreezesIt,
    ],
    [
        "quick capture supersedes an older delayed interactive capture",
        testQuickCaptureSupersedesDelayedInteractiveCapture,
    ],
    [
        "interactive capture supersedes an unfinished quick capture",
        testInteractiveCaptureSupersedesUnfinishedQuickCapture,
    ],
    [
        "cancelled save cannot resurrect a superseded capture overlay",
        testCancelledSaveDoesNotResurrectSupersededCapture,
    ],
    [
        "recorder controls use the selected display and compact bounds",
        testRecorderControlsUseSelectedDisplayAndCompactBounds,
    ],
    [
        "recorder save extension is based on the filename, not parent folders",
        testRecorderSaveExtensionUsesFilenameOnly,
    ],
    [
        "quick path mode requires a destination before acquiring screens",
        testQuickPathModeRequiresDestinationBeforeCapture,
    ],
    [
        "quick clipboard capture uses only the cursor display",
        testQuickClipboardCapturesOnlyCursorDisplay,
    ],
    [
        "quick capture reports an empty frame and restores the shelf",
        testQuickCaptureReportsEmptyImageAndRestoresShelf,
    ],
    [
        "capture overlay uses the display frozen at acquisition",
        testCaptureOverlayUsesFrozenDisplay,
    ],
    [
        "a superseded request cannot show the capture overlay after an await",
        testSupersededShowCannotResurrectOverlay,
    ],
    [
        "stale saved-region recapture falls back to interactive capture",
        testRecaptureFallsBackWhenSavedRegionIsStale,
    ],
    [
        "only the latest shelf hide operation can restore the shelf",
        testOnlyLatestShelfHideCanRestore,
    ],
    [
        "a stale acquisition watchdog cannot fail a newer request",
        testStaleWatchdogCannotFailNewRequest,
    ],
    [
        "radial edge placement keeps the visible physical-to-DIP center as cancel",
        testRadialUsesVisibleDipCenterAtScreenEdge,
    ],
    [
        "repeatLastRegion serializes captures slower than its interval",
        testRepeatIsSerializedWhenCaptureIsSlow,
    ],
    [
        "repeatLastRegion catches thrown captures and reports a failure",
        testRepeatCountsThrownCaptureAsFailure,
    ],
    [
        "stopRepeatJob prevents a cancelled job from clearing a restarted job",
        testCancelledJobCannotClearRestartedJob,
    ],
];

(async () => {
    let passed = 0;
    for (const [name, test] of tests) {
        try {
            await test();
            passed += 1;
            console.log(`PASS ${name}`);
        } catch (error) {
            console.error(`FAIL ${name}`);
            console.error(error);
            process.exitCode = 1;
        }
    }
    console.log(`${passed}/${tests.length} capture action checks passed`);
})();
