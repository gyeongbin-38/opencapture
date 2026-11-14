#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const readArgument = (name, fallback) => {
    const equals = args.find((arg) => arg.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
};
const channel = readArgument("--channel", "darwin");
const requestedArch = readArgument("--arch", "all");
const configOnly = args.includes("--config-only");
if (!["darwin", "mas"].includes(channel))
    throw new Error(`Unsupported channel: ${channel}`);
if (!["all", "arm64", "x64"].includes(requestedArch))
    throw new Error(`Unsupported architecture: ${requestedArch}`);

const report = {
    channel,
    architectures: requestedArch === "all" ? ["arm64", "x64"] : [requestedArch],
    host: `${process.platform}-${process.arch}`,
    configOnly,
    checks: [],
    warnings: [],
    blockers: [],
};
const pass = (name, detail) =>
    report.checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
const block = (code, message) => report.blockers.push({ code, message });
const warn = (code, message) => report.warnings.push({ code, message });
const expect = (condition, name, message) => {
    if (condition) pass(name);
    else block(name, message);
};

function loadWithoutChildProcess(configPath, environment) {
    const childProcess = require("node:child_process");
    const originalExec = childProcess.execSync;
    const originalExecFile = childProcess.execFileSync;
    const originalExecAsync = childProcess.exec;
    const originalExecFileAsync = childProcess.execFile;
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;
    const calls = [];
    const reject =
        (kind) =>
        (...command) => {
            calls.push({ kind, command: String(command[0]) });
            throw new Error(`Configuration load attempted ${kind}`);
        };
    const previous = {};
    for (const [key, value] of Object.entries(environment)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    childProcess.execSync = reject("execSync");
    childProcess.execFileSync = reject("execFileSync");
    // @ts-expect-error Test trap intentionally omits Node's promisified overload.
    childProcess.exec = reject("exec");
    // @ts-expect-error Test trap intentionally omits Node's promisified overload.
    childProcess.execFile = reject("execFile");
    childProcess.spawn = reject("spawn");
    childProcess.spawnSync = reject("spawnSync");
    let config;
    try {
        delete require.cache[require.resolve(configPath)];
        const basePath = path.join(root, "electron-builder.config.js");
        if (require.cache[require.resolve(basePath)])
            delete require.cache[require.resolve(basePath)];
        config = require(configPath);
    } finally {
        childProcess.execSync = originalExec;
        childProcess.execFileSync = originalExecFile;
        childProcess.exec = originalExecAsync;
        childProcess.execFile = originalExecFileAsync;
        childProcess.spawn = originalSpawn;
        childProcess.spawnSync = originalSpawnSync;
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    return { config, calls };
}

function targetArchitectures(targets, targetName) {
    const result = new Set();
    for (const target of targets ?? []) {
        if (typeof target === "string") continue;
        if (target.target !== targetName) continue;
        for (const architecture of Array.isArray(target.arch)
            ? target.arch
            : [target.arch]) {
            if (architecture) result.add(architecture);
        }
    }
    return result;
}

function hasAllArchitectures(targets, names) {
    return names.every((name) => {
        const architectures = targetArchitectures(targets, name);
        return architectures.has("arm64") && architectures.has("x64");
    });
}

function validatePlist(relativePath, requiredKeys) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
        block("plist-missing", `${relativePath} is missing`);
        return;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    const structurallyValid =
        source.includes("<?xml") &&
        source.includes("<!DOCTYPE plist") &&
        source.includes('<plist version="1.0">') &&
        source.includes("<dict>") &&
        source.includes("</dict>") &&
        source.includes("</plist>");
    expect(
        structurallyValid,
        `plist:${relativePath}`,
        `${relativePath} is not a complete XML property list`,
    );
    for (const key of requiredKeys)
        expect(
            source.includes(`<key>${key}</key>`),
            `plist-key:${key}`,
            `${relativePath} does not declare ${key}`,
        );
}

const MACH_CPU = { x64: 0x01000007, arm64: 0x0100000c };
function inspectMachOBuffer(buffer, architecture) {
    if (buffer.length < 12) return { ok: false, reason: "file is too small" };
    if (buffer[0] === 0x4d && buffer[1] === 0x5a)
        return { ok: false, reason: "file is a Windows PE executable" };
    const magic = buffer.readUInt32BE(0);
    const expectedCpu = MACH_CPU[architecture];
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
        const cpu = buffer.readUInt32LE(4);
        return cpu === expectedCpu
            ? { ok: true, format: "Mach-O" }
            : { ok: false, reason: `Mach-O CPU ${cpu} does not match` };
    }
    if (magic === 0xfeedfacf || magic === 0xfeedface) {
        const cpu = buffer.readUInt32BE(4);
        return cpu === expectedCpu
            ? { ok: true, format: "Mach-O" }
            : { ok: false, reason: `Mach-O CPU ${cpu} does not match` };
    }
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
        const littleEndian = magic === 0xbebafeca;
        const read = littleEndian
            ? (offset) => buffer.readUInt32LE(offset)
            : (offset) => buffer.readUInt32BE(offset);
        const count = read(4);
        if (count > 32 || buffer.length < 8 + count * 20)
            return { ok: false, reason: "invalid fat Mach-O header" };
        for (let index = 0; index < count; index += 1)
            if (read(8 + index * 20) === expectedCpu)
                return { ok: true, format: "fat Mach-O" };
        return {
            ok: false,
            reason: `fat Mach-O does not contain ${architecture}`,
        };
    }
    return { ok: false, reason: "file is not a recognized Mach-O binary" };
}

function inspectMachOFile(filePath, architecture) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.size < 12)
            return {
                ok: false,
                reason: "path is not a non-empty regular file",
            };
        const descriptor = fs.openSync(filePath, "r");
        try {
            const header = Buffer.alloc(Math.min(stats.size, 4096));
            fs.readSync(descriptor, header, 0, header.length, 0);
            return inspectMachOBuffer(header, architecture);
        } finally {
            fs.closeSync(descriptor);
        }
    } catch (error) {
        return { ok: false, reason: error.code ?? error.message };
    }
}

function nativeCandidates(relativePath, extension) {
    const absolutePath = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(root, relativePath);
    try {
        const stats = fs.statSync(absolutePath);
        if (stats.isFile())
            return !extension || absolutePath.endsWith(extension)
                ? [absolutePath]
                : [];
        if (!stats.isDirectory()) return [];
    } catch {
        return [];
    }
    const found = [];
    const pending = [absolutePath];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
        })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(entryPath);
            else if (
                entry.isFile() &&
                (!extension || entry.name.endsWith(extension))
            )
                found.push(entryPath);
        }
    }
    return found;
}

function validateNativeArtifact(code, relativePath, architecture, extension) {
    const candidates = nativeCandidates(relativePath, extension);
    if (!candidates.length) {
        block(
            `native:${code}:${architecture}`,
            `${relativePath} has no ${extension ?? "native"} regular file for ${architecture}`,
        );
        return;
    }
    const inspected = candidates.map((file) => ({
        file,
        result: inspectMachOFile(file, architecture),
    }));
    const matching = inspected.find(({ result }) => result.ok);
    if (!matching) {
        block(
            `native:${code}:${architecture}`,
            `${relativePath} has no ${architecture} Mach-O artifact (${inspected.map(({ result }) => result.reason).join("; ")})`,
        );
        return;
    }
    pass(
        `native:${code}:${architecture}`,
        `${path.relative(root, matching.file)} is a ${matching.result.format} artifact; runtime loading and signing remain unverified until tested on macOS`,
    );
}

const basePath = path.join(root, "electron-builder.config.js");
const macPath = path.join(root, "electron-builder.mac.config.cjs");
try {
    const screenshotPackages = [
        "win32-x64-msvc",
        "win32-ia32-msvc",
        "win32-arm64-msvc",
        "linux-x64-gnu",
        "linux-x64-musl",
        "linux-arm64-gnu",
        "linux-loong64-gnu",
    ];
    for (const architecture of ["arm64", "x64"]) {
        const baseLoad = loadWithoutChildProcess(basePath, {
            M_ARCH: architecture,
        });
        expect(
            baseLoad.calls.length === 0,
            `config-load-side-effects:base:${architecture}`,
            `Base configuration executed child processes: ${JSON.stringify(baseLoad.calls)}`,
        );
        for (const [platform, files] of [
            ["win32", baseLoad.config.win?.files ?? []],
            ["linux", baseLoad.config.linux?.files ?? []],
        ]) {
            for (const packageName of screenshotPackages) {
                const exclusion = `!node_modules/node-screenshots-${packageName}`;
                const shouldExclude = !packageName.startsWith(
                    `${platform}-${architecture}`,
                );
                expect(
                    Array.isArray(files) &&
                        files.includes(exclusion) === shouldExclude,
                    `node-screenshots-filter:${platform}:${architecture}:${packageName}`,
                    `${platform}/${architecture} node-screenshots filter is wrong for ${packageName}`,
                );
            }
        }
    }
    const source = fs.readFileSync(basePath, "utf8");
    expect(
        !/pnpm\s+install|npm\s+install|yarn\s+install/.test(source),
        "config-load-installs",
        "Base configuration still contains a dependency installation command",
    );
} catch (error) {
    block("base-config-load", error.message);
}

let normalConfig;
let masConfig;
try {
    const normalLoad = loadWithoutChildProcess(macPath, {
        OPENCAPTURE_MAC_CHANNEL: "darwin",
        OPENCAPTURE_MAC_ARCH: undefined,
    });
    normalConfig = normalLoad.config;
    expect(
        normalLoad.calls.length === 0,
        "config-load-side-effects:mac",
        `Mac configuration executed child processes: ${JSON.stringify(normalLoad.calls)}`,
    );
} catch (error) {
    block("mac-config-load", error.message);
}
try {
    const masLoad = loadWithoutChildProcess(macPath, {
        OPENCAPTURE_MAC_CHANNEL: "mas",
        OPENCAPTURE_MAC_ARCH: undefined,
    });
    masConfig = masLoad.config;
    expect(
        masLoad.calls.length === 0,
        "config-load-side-effects:mas",
        `MAS configuration executed child processes: ${JSON.stringify(masLoad.calls)}`,
    );
} catch (error) {
    block("mas-config-load", error.message);
}

if (normalConfig) {
    expect(
        hasAllArchitectures(normalConfig.mac?.target, ["dmg", "zip"]),
        "darwin-targets",
        "Normal macOS configuration must target dmg+zip for arm64 and x64",
    );
    const files = normalConfig.mac?.files ?? [];
    for (const excluded of [
        "!native/**",
        "!lib/copy.exe",
        "!lib/ffmpeg/ffmpeg.exe",
        "!assets/runtime/win32-x64/**",
        "!node_modules/onnxruntime-node/bin/napi-v6/win32/**",
        "!node_modules/uiohook-napi/prebuilds/win32-*",
        "!node_modules/node-screenshots-win32-*",
    ])
        expect(
            files.includes(excluded),
            `mac-excludes:${excluded}`,
            `Normal macOS package does not exclude ${excluded}`,
        );
    expect(
        !files.includes("!lib/ffmpeg/**") &&
            !files.includes("!lib/ffmpeg/ffmpeg"),
        "mac-includes-native-ffmpeg",
        "The future native lib/ffmpeg/ffmpeg path is excluded from the macOS package",
    );
    expect(
        normalConfig.mac?.entitlements === "entitlements/mac.plist",
        "darwin-entitlements-config",
        "Normal macOS configuration does not point to the reviewed entitlements",
    );
    expect(
        !(normalConfig.extraFiles ?? []).some((entry) =>
            String(typeof entry === "string" ? entry : entry?.from).endsWith(
                ".exe",
            ),
        ),
        "darwin-extra-files",
        "A Windows executable is present in the common macOS extraFiles set",
    );
    const info = normalConfig.mac?.extendInfo ?? {};
    for (const key of [
        "NSCameraUsageDescription",
        "NSMicrophoneUsageDescription",
        "NSAudioCaptureUsageDescription",
        "NSScreenCaptureUsageDescription",
    ])
        expect(
            typeof info[key] === "string" && info[key].length > 10,
            `info-plist:${key}`,
            `Normal macOS configuration is missing ${key}`,
        );
}

if (masConfig) {
    expect(
        hasAllArchitectures(masConfig.mac?.target, ["mas"]),
        "mas-targets",
        "MAS configuration must target mas for arm64 and x64",
    );
    expect(
        masConfig.mas?.entitlements === "entitlements/mas.plist",
        "mas-entitlements-config",
        "MAS configuration does not point to the reviewed app entitlements",
    );
    expect(
        masConfig.mas?.entitlementsInherit === "entitlements/mas.inherit.plist",
        "mas-inherit-config",
        "MAS configuration does not point to inherited helper entitlements",
    );
}

validatePlist("entitlements/mac.plist", ["com.apple.security.cs.allow-jit"]);
validatePlist("entitlements/mas.plist", [
    "com.apple.security.app-sandbox",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.files.user-selected.read-write",
]);
validatePlist("entitlements/mas.inherit.plist", [
    "com.apple.security.app-sandbox",
    "com.apple.security.inherit",
]);
const assetManifest = JSON.parse(
    fs.readFileSync(path.join(root, "assets-manifest.json"), "utf8"),
);
const windowsFfmpeg = assetManifest.assets?.find(
    (asset) => asset.id === "ffmpeg-windows-x64",
);
expect(
    windowsFfmpeg?.platforms?.length === 1 &&
        windowsFfmpeg.platforms[0] === "win32" &&
        windowsFfmpeg.files?.some(
            (file) => file.path === "lib/ffmpeg/ffmpeg.exe",
        ),
    "manifest-windows-ffmpeg-scope",
    "The existing FFmpeg manifest entry is not restricted to the Windows .exe path",
);

const negativeNativeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "opencapture-mac-readiness-"),
);
try {
    expect(
        nativeCandidates(negativeNativeRoot, ".node").length === 0,
        "native-negative:empty-directory",
        "An empty directory was accepted as a native artifact",
    );
    const pePath = path.join(negativeNativeRoot, "wrong.node");
    const pe = Buffer.alloc(64);
    pe.write("MZ");
    fs.writeFileSync(pePath, pe);
    expect(
        !inspectMachOFile(pePath, "x64").ok,
        "native-negative:windows-pe",
        "A Windows PE file was accepted as a macOS native artifact",
    );
    const armHeader = Buffer.alloc(64);
    armHeader.writeUInt32BE(0xcffaedfe, 0);
    armHeader.writeUInt32LE(MACH_CPU.arm64, 4);
    expect(
        inspectMachOBuffer(armHeader, "arm64").ok &&
            !inspectMachOBuffer(armHeader, "x64").ok,
        "native-negative:architecture",
        "Mach-O architecture validation did not reject a mismatched target",
    );
} finally {
    fs.rmSync(negativeNativeRoot, { recursive: true, force: true });
}

if (!configOnly) {
    expect(
        fs.existsSync(path.join(root, "out", "main", "main.js")),
        "compiled-app",
        "out/main/main.js is missing; build the application before packaging",
    );
    expect(
        fs.existsSync(path.join(root, "assets", "logo", "icon.icns")),
        "mac-icon",
        "assets/logo/icon.icns is missing",
    );
    for (const architecture of report.architectures) {
        validateNativeArtifact(
            "onnxruntime",
            `node_modules/onnxruntime-node/bin/napi-v6/darwin/${architecture}/onnxruntime_binding.node`,
            architecture,
            ".node",
        );
        validateNativeArtifact(
            "node-screenshots",
            `node_modules/node-screenshots-darwin-${architecture}`,
            architecture,
            ".node",
        );
        validateNativeArtifact(
            "uiohook",
            `node_modules/uiohook-napi/prebuilds/darwin-${architecture}`,
            architecture,
            ".node",
        );
        validateNativeArtifact("ffmpeg", "lib/ffmpeg/ffmpeg", architecture);
    }
    if (!fs.existsSync(path.join(root, "assets", "runtime", "darwin")))
        warn(
            "local-translation-runtime",
            "No pinned macOS Python/local-translation runtime exists; local translation must remain unavailable on macOS.",
        );
}

if (channel === "mas") {
    block(
        "mas-security-scoped-bookmarks",
        "Persistent access to user-selected external folders has no implemented security-scoped bookmark lifecycle.",
    );
    const guards = require("node:child_process").spawnSync(
        process.execPath,
        [path.join(root, "scripts", "verify-mas-guards.cjs")],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (guards.status !== 0)
        block(
            "mas-isolated-code-guards",
            `Isolated production guard verification failed: ${guards.error?.message ?? guards.stderr}`,
        );
    else {
        const result = JSON.parse(guards.stdout);
        expect(
            result.ok === true,
            "mas-isolated-code-guards",
            "MAS guards did not return a successful report.",
        );
        for (const detail of result.checks ?? [])
            pass("mas-production-guard", detail);
    }
    block(
        "mas-application-group",
        "A real Apple Team ID/application group entitlement and matching provisioning profile are not configured.",
    );
    block(
        "mas-native-assets",
        "Darwin native modules and their nested code signatures have not been verified inside a signed MAS bundle on macOS.",
    );
    block(
        "mas-signing",
        "MAS signing certificates, provisioning profile, sandbox runtime verification, and App Store review assets require a macOS signing host and Apple account.",
    );
}

report.ok = report.blockers.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
