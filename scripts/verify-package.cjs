const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requested = process.argv[2] || process.env.OPENCAPTURE_PACKAGE_OUTPUT;
const expectDesktopUnavailable = process.argv.includes(
    "--expect-desktop-unavailable",
);
if (!requested)
    throw new Error(
        "Pass a fresh release/verify-* package output to verify-package.cjs.",
    );
const packageRoot = path.resolve(root, requested);
const releaseRoot = path.join(root, "release");
const relativePackage = path.relative(releaseRoot, packageRoot);
if (
    relativePackage.startsWith("..") ||
    path.isAbsolute(relativePackage) ||
    !path.basename(packageRoot).startsWith("verify-")
)
    throw new Error("Package verification only accepts release/verify-*.");

const unpacked = path.join(packageRoot, "win-unpacked");
const exe = path.join(unpacked, "OpenCapture.exe");
const quick = path.join(unpacked, "OpenCaptureQuick.exe");
const runtime = path.join(
    unpacked,
    "resources",
    "app",
    "assets",
    "runtime",
    "win32-x64",
);
const python = path.join(runtime, "python.exe");
const clipboardHelper = path.join(runtime, "clipboard-files.py");
for (const required of [exe, quick, python, clipboardHelper])
    if (!fs.statSync(required).isFile())
        throw new Error(`Packaged runtime asset missing: ${required}`);

const packagedApp = path.join(unpacked, "resources", "app");
const sha256 = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const realConfig = path.join(process.env.APPDATA, "OpenCapture", "config.json");
const configHash = () =>
    fs.existsSync(realConfig) ? sha256(realConfig) : null;
const originalConfigHash = configHash();
const toolAssets = [
    "assets/runtime/win32-x64/capture-worker.py",
    "out/main/main.js",
    "out/preload/dashboard.js",
    "out/preload/fileShelf.js",
    "out/preload/pdfTools.js",
    "out/preload/rarTools.js",
    "out/renderer/file_shelf.html",
    "out/renderer/pdf_tools.html",
    "out/renderer/rar_tools.html",
    ...fs
        .readdirSync(path.join(root, "out/main"))
        .filter((name) => name.endsWith(".js") && name !== "main.js")
        .map((name) => `out/main/${name}`),
    ...fs
        .readdirSync(path.join(root, "out/renderer/assets"))
        .filter(
            (name) =>
                /^(?:pdf_tools-|pdf\.worker\.min-|rar_tools-|file_shelf-)/.test(
                    name,
                ) && !name.endsWith(".map"),
        )
        .map((name) => `out/renderer/assets/${name}`),
    ...fs
        .readdirSync(path.join(root, "assets/runtime/rar-wasm"))
        .filter((name) => /\.(?:mjs|wasm|json)$/.test(name))
        .map((name) => `assets/runtime/rar-wasm/${name}`),
];
const toolAssetHashes = Object.fromEntries(
    toolAssets.map((asset) => {
        const source = path.join(root, asset);
        const packaged = path.join(packagedApp, asset);
        const hash = sha256(source);
        if (sha256(packaged) !== hash)
            throw new Error(
                `Packaged file tool differs from verified output: ${asset}`,
            );
        return [asset, hash];
    }),
);
for (const folder of ["cmaps", "standard_fonts", "wasm"])
    if (
        !fs.readdirSync(
            path.join(packagedApp, "out/renderer/assets/pdfjs", folder),
        ).length
    )
        throw new Error(`Packaged PDF resources missing: ${folder}`);
for (const license of ["LICENSE", "LICENSE.pdf-lib"])
    if (
        !fs.statSync(
            path.join(packagedApp, "out/renderer/assets/pdfjs", license),
        ).size
    )
        throw new Error(`Packaged PDF license missing: ${license}`);
if (!fs.existsSync(path.join(packagedApp, "node_modules/pdf-lib/package.json")))
    throw new Error("Packaged lazy PDF engine is missing");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceRoot = path.join(root, ".evidence", `package-${stamp}`);
const profile = path.join(evidenceRoot, "profile");
fs.mkdirSync(profile, { recursive: true });
const models = path.join(root, ".omx", "smoke-models-phase0");
if (fs.existsSync(models))
    fs.cpSync(models, path.join(profile, "translation", "models"), {
        recursive: true,
    });

function runHelper(args, label) {
    const result = spawnSync(quick, args, {
        windowsHide: true,
        encoding: "utf8",
        timeout: 15_000,
    });
    if (result.status !== 0)
        throw new Error(
            `${label} failed: ${result.stderr || result.error || result.status}`,
        );
}

const helperDiagnostics = path.join(evidenceRoot, "quicklaunch-self-test.json");
runHelper(
    ["--self-test", "--userData", profile, "--diagnostics", helperDiagnostics],
    "Packaged helper self-test",
);
const helperEvidence = JSON.parse(fs.readFileSync(helperDiagnostics, "utf8"));
if (
    helperEvidence.physicalKeyTested !== false ||
    helperEvidence.capture.requested !== "CommandOrControl+Shift+A" ||
    helperEvidence.toggle.requested !== "CommandOrControl+Shift+Space" ||
    helperEvidence.captureDispatch !== "--broker --native-dispatch --capture" ||
    helperEvidence.toggleDispatch !== "--broker --native-dispatch --toggle"
)
    throw new Error("Packaged helper protocol metadata is invalid.");

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" ? address.port : 0;
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

async function until(read, message, timeout = 30_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
        try {
            const value = await read();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function verify() {
    const port = await freePort();
    const coldDiagnostics = path.join(
        evidenceRoot,
        "quicklaunch-cold-dispatch.json",
    );
    runHelper(
        [
            "--dispatch",
            "toggle",
            "--userData",
            profile,
            "--dispatch-extra",
            `--remote-debugging-port=${port}`,
            "--diagnostics",
            coldDiagnostics,
        ],
        "Cold helper dispatch",
    );
    const coldDispatch = JSON.parse(fs.readFileSync(coldDiagnostics, "utf8"));
    if (
        !coldDispatch.dispatched ||
        coldDispatch.action !== "toggle" ||
        !Number.isSafeInteger(coldDispatch.pid)
    )
        throw new Error("Cold helper dispatch evidence is invalid.");
    const appPid = coldDispatch.pid;
    let socket;
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const request = ++id;
            pending.set(request, { resolve, reject });
            socket.send(JSON.stringify({ id: request, method, params }));
        });
    const evaluate = async (expression) => {
        const response = await call("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails)
            throw new Error(JSON.stringify(response.exceptionDetails));
        return response.result.value;
    };

    try {
        const page = await until(async () => {
            const pages = await (
                await fetch(`http://127.0.0.1:${port}/json`)
            ).json();
            return pages.find((entry) => entry.url.includes("dashboard.html"));
        }, "Cold-dispatched packaged dashboard did not appear");
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = reject;
        });
        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (!message.id) return;
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            message.error
                ? request.reject(new Error(message.error.message))
                : request.resolve(message.result);
        };
        await until(
            () => evaluate("typeof window.openCapture === 'object'"),
            "Packaged dashboard bridge did not initialize",
        );
        const fileTools = await until(async () => {
            const value = await evaluate(
                "({bridge:typeof window.openCapture.fileTools?.select,entry:!!document.querySelector('.library-file-tools-button')})",
            );
            return value.bridge === "function" && value.entry ? value : null;
        }, "Packaged file tools entry or bridge did not initialize");

        const warmDiagnostics = path.join(
            evidenceRoot,
            "quicklaunch-warm-dispatch.json",
        );
        runHelper(
            [
                "--dispatch",
                "capture",
                "--userData",
                profile,
                "--diagnostics",
                warmDiagnostics,
            ],
            "Warm helper dispatch",
        );
        const warmDispatch = JSON.parse(
            fs.readFileSync(warmDiagnostics, "utf8"),
        );
        const warmTrace = await until(
            async () => {
                const state = await evaluate("window.openCapture.getState()");
                const trace = state.runtime?.captureDiagnostics ?? [];
                const nativeTrace = trace.filter(
                    (entry) => entry.input === "native-dispatch",
                );
                return nativeTrace.some(
                    (entry) =>
                        entry.phase === "ready" ||
                        entry.phase === "shown" ||
                        entry.phase === "failed",
                )
                    ? nativeTrace
                    : null;
            },
            "Warm helper capture did not reach a terminal preparation state",
            45_000,
        );
        const failedCapture = warmTrace.find(
            (entry) => entry.phase === "failed",
        );
        if (expectDesktopUnavailable) {
            if (
                !failedCapture?.detail?.includes(
                    "Windows 화면이 잠겨 있거나 다른 데스크톱이 활성화되어 있습니다.",
                )
            )
                throw new Error(
                    `Expected an explicit inactive-desktop error: ${JSON.stringify(warmTrace)}`,
                );
        } else if (failedCapture) {
            throw new Error(`Packaged capture failed: ${failedCapture.detail}`);
        }

        const state = await evaluate("window.openCapture.getState()");
        const status = await evaluate("window.openCapture.translationStatus()");
        const translation = await evaluate(
            'window.openCapture.translate({texts:["Hello, how are you?"],from:"en",to:"ko",engine:"local"})',
        );
        const isolation = await evaluate(
            "({require:typeof require,bridge:typeof window.openCapture})",
        );
        await evaluate(
            'document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))',
        );
        const captureShortcutDisplay = await evaluate(
            'document.querySelector(\'.command-result[data-command-id="capture:capture"] kbd\')?.textContent ?? ""',
        );
        const captureShortcutState = state.runtime.shortcuts.find(
            (shortcut) => shortcut.id === "capture",
        );
        if (
            !captureShortcutState ||
            captureShortcutState.requested !== helperEvidence.capture.requested
        )
            throw new Error(
                "Packaged capture shortcut configuration is missing",
            );
        const captureShortcut = captureShortcutState.active ?? "";
        const normalizeShortcut = (value) =>
            value
                .replace(/CommandOrControl/gi, "Ctrl")
                .replace(/Control/gi, "Ctrl")
                .replace(/\s/g, "")
                .toLowerCase();
        if (
            normalizeShortcut(captureShortcutDisplay) !==
            normalizeShortcut(captureShortcut)
        )
            throw new Error(
                "Command palette does not reflect the registered capture shortcut",
            );
        await evaluate('document.querySelector(".command-palette").close()');
        const screenshot = await call("Page.captureScreenshot");
        fs.writeFileSync(
            path.join(evidenceRoot, "dashboard.png"),
            Buffer.from(screenshot.data, "base64"),
        );
        const evidence = {
            packageRoot,
            unpacked: true,
            signedInstallerTested: false,
            physicalKeyTested: false,
            physicalExtraMonitorTested: false,
            simulatedMixedDpiTested: false,
            exe,
            version: state.version,
            captureShortcutDisplay,
            registeredCaptureShortcut: captureShortcut,
            captureShortcutState,
            status,
            translation,
            isolation,
            fileTools,
            toolAssetHashes,
            realSettingsPreserved: configHash() === originalConfigHash,
            nativeDispatch: {
                cold: coldDispatch,
                warm: warmDispatch,
                trace: warmTrace,
                captureOutcome: expectDesktopUnavailable
                    ? "inactive-desktop-error-handled"
                    : "renderer-ready",
                nativeDesktopPixelsVerified: false,
            },
            runtimeAssets: {
                python: {
                    path: python,
                    bytes: fs.statSync(python).size,
                },
                clipboardHelper: {
                    path: clipboardHelper,
                    bytes: fs.statSync(clipboardHelper).size,
                    sha256: sha256(clipboardHelper),
                },
                quickLaunch: {
                    path: quick,
                    bytes: fs.statSync(quick).size,
                    sha256: sha256(quick),
                    selfTest: helperEvidence,
                },
            },
        };
        fs.writeFileSync(
            path.join(evidenceRoot, "package.json"),
            JSON.stringify(evidence, null, 2),
        );
        console.log(JSON.stringify(evidence));
        if (
            !status.runtimeReady ||
            !status.modelsReady ||
            !translation[0] ||
            isolation.require !== "undefined" ||
            !warmDispatch.dispatched ||
            !evidence.realSettingsPreserved
        )
            throw new Error("Package verification failed");
    } finally {
        socket?.close();
        try {
            process.kill(appPid);
        } catch {}
        if (configHash() !== originalConfigHash) {
            process.exitCode = 1;
            console.error("Package verification changed the real app settings");
        }
    }
}

verify().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
