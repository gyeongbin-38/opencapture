#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const readArgument = (name, fallback) => {
    const equals = args.find((arg) => arg.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
};
const channel = has("--mas") ? "mas" : readArgument("--channel", "darwin");
const defaultArch = has("--check") ? "all" : process.arch;
const requestedArch = readArgument("--arch", defaultArch);
if (!["darwin", "mas"].includes(channel))
    throw new Error(`Unsupported channel: ${channel}`);
if (!["all", "arm64", "x64"].includes(requestedArch))
    throw new Error(`Unsupported architecture: ${requestedArch}`);
if (!has("--check") && process.platform !== "darwin") {
    console.error(
        "macOS packaging requires a macOS host with Xcode and the matching native optional dependencies. Run with --check on other platforms.",
    );
    process.exit(1);
}

const readinessArgs = [
    path.join(root, "scripts", "check-macos-readiness.cjs"),
    "--channel",
    channel,
    "--arch",
    requestedArch,
];
if (has("--check") && !has("--full")) readinessArgs.push("--config-only");
const readiness = spawnSync(process.execPath, readinessArgs, {
    cwd: root,
    stdio: "inherit",
});
if (readiness.status !== 0) process.exit(readiness.status ?? 1);
if (has("--check")) process.exit(0);

const builderCli = require.resolve("electron-builder/out/cli/cli.js");
const architectures =
    requestedArch === "all" ? ["arm64", "x64"] : [requestedArch];
for (const architecture of architectures) {
    const targets = channel === "mas" ? ["mas"] : ["dmg", "zip"];
    const result = spawnSync(
        process.execPath,
        [
            builderCli,
            "--mac",
            ...targets,
            `--${architecture}`,
            "--config",
            "electron-builder.mac.config.cjs",
            "--publish",
            "never",
        ],
        {
            cwd: root,
            stdio: "inherit",
            env: {
                ...process.env,
                OPENCAPTURE_MAC_CHANNEL: channel,
                OPENCAPTURE_MAC_ARCH: architecture,
            },
        },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
}
