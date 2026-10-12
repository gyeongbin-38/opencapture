const { spawn } = require("node:child_process");
const {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

if (process.platform !== "win32") {
    console.log("Quick Launch verification skipped: Windows only.");
    process.exit(0);
}

const root = resolve(__dirname, "..");
const executable = join(root, "native", "bin", "OpenCaptureQuick.exe");
if (!existsSync(executable))
    throw new Error("Build OpenCaptureQuick.exe before verification.");

const profile = mkdtempSync(join(tmpdir(), "opencapture-quick-"));
const diagnostics = join(profile, "self-test.json");
const statePath = join(profile, "hotkey-helper-state.json");
const ownerPath = join(profile, "hotkey-owner.json");
const configPath = join(profile, "config.json");

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

async function until(read, message, timeout = 5_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
        try {
            const value = read();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function run() {
    writeFileSync(
        configPath,
        JSON.stringify({
            起始页快捷键: {
                capture: "Ctrl+Shift+F22",
                toggle: "Meta+Alt+F23",
            },
        }),
    );
    const selfTest = spawn(
        executable,
        ["--self-test", "--userData", profile, "--diagnostics", diagnostics],
        { windowsHide: true, stdio: "ignore" },
    );
    const selfExit = await new Promise((resolveExit, reject) => {
        selfTest.once("error", reject);
        selfTest.once("exit", resolveExit);
    });
    if (selfExit !== 0)
        throw new Error(`Quick Launch self-test exited ${selfExit}`);
    const selfEvidence = readJson(diagnostics);
    if (
        selfEvidence.physicalKeyTested !== false ||
        selfEvidence.capture.requested !== "Ctrl+Shift+F22" ||
        selfEvidence.toggle.requested !== "Meta+Alt+F23" ||
        !selfEvidence.metaParsed
    )
        throw new Error("Quick Launch parser/self-test evidence is invalid.");

    const helper = spawn(
        executable,
        ["--userData", profile, "--test-instance", `verify-${process.pid}`],
        { windowsHide: true, stdio: "ignore" },
    );
    try {
        const initial = await until(() => {
            const state = readJson(statePath);
            return state.owner === "helper" && state.registered ? state : null;
        }, "Helper did not register configured keys");

        writeFileSync(configPath, "{");
        const retainedOnInvalidConfig = await until(() => {
            const state = readJson(statePath);
            return state.configError &&
                state.capture.requested === "Ctrl+Shift+F22" &&
                state.keys.toggle === "Meta+Alt+F23"
                ? state
                : null;
        }, "Helper replaced valid keys during a partial config write");
        writeFileSync(
            configPath,
            JSON.stringify({
                起始页快捷键: {
                    capture: "Ctrl+Shift+F22",
                    toggle: "Meta+Alt+F23",
                },
            }),
        );

        writeFileSync(
            ownerPath,
            JSON.stringify({
                version: 1,
                pid: process.pid,
                mode: "electron",
                keys: {
                    capture: "Ctrl+Shift+F22",
                    toggle: "Meta+Alt+F23",
                },
                updatedAt: Date.now(),
            }),
        );
        const relinquished = await until(() => {
            const state = readJson(statePath);
            return state.owner === "electron" && !state.registered
                ? state
                : null;
        }, "Helper did not relinquish keys to Electron");

        writeFileSync(
            ownerPath,
            JSON.stringify({
                version: 1,
                pid: 2_147_483_646,
                mode: "electron",
                updatedAt: Date.now(),
            }),
        );
        const staleOwnerRecovered = await until(() => {
            const state = readJson(statePath);
            return state.owner === "helper" && state.capture.registered
                ? state
                : null;
        }, "Helper did not recover keys from a stale owner marker");
        rmSync(ownerPath, { force: true });
        writeFileSync(
            configPath,
            JSON.stringify({
                起始页快捷键: {
                    capture: "",
                    toggle: "Ctrl+Alt+F21",
                },
            }),
        );
        const rebound = await until(() => {
            const state = readJson(statePath);
            return state.owner === "helper" &&
                state.capture.requested === "" &&
                !state.capture.registered &&
                state.toggle.requested === "Ctrl+Alt+F21" &&
                state.toggle.registered
                ? state
                : null;
        }, "Helper did not reload disabled/custom keys");

        writeFileSync(
            configPath,
            JSON.stringify({
                起始页快捷键: {
                    capture: "",
                    toggle: "Ctrl+Banana",
                },
            }),
        );
        const invalidKey = await until(() => {
            const state = readJson(statePath);
            return state.toggle.requested === "Ctrl+Banana" &&
                !state.toggle.registered &&
                String(state.toggle.error).includes("Unsupported accelerator")
                ? state
                : null;
        }, "Helper did not report an invalid configured accelerator");

        console.log(
            JSON.stringify({
                physicalKeyTested: false,
                selfTest: selfEvidence,
                initial,
                retainedOnInvalidConfig,
                relinquished,
                staleOwnerRecovered,
                rebound,
                invalidKey,
            }),
        );
    } finally {
        helper.kill();
        await new Promise((resolveExit) => {
            const timer = setTimeout(resolveExit, 1_000);
            helper.once("exit", () => {
                clearTimeout(timer);
                resolveExit();
            });
        });
    }
}

run()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        rmSync(profile, { recursive: true, force: true });
    });
