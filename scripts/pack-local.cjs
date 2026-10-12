const { build } = require("electron-builder");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");
const config = require("../electron-builder.config.js");

const root = resolve(__dirname, "..");
const releaseRoot = join(root, "release");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const requested = process.env.OPENCAPTURE_PACKAGE_OUTPUT;
const output = resolve(
    requested
        ? isAbsolute(requested)
            ? requested
            : join(root, requested)
        : join(releaseRoot, `verify-${stamp}`),
);
const relativeOutput = relative(releaseRoot, output);
if (
    relativeOutput.startsWith("..") ||
    isAbsolute(relativeOutput) ||
    !output.startsWith(releaseRoot)
)
    throw new Error("Package verification output must be inside release/.");

mkdirSync(releaseRoot, { recursive: true });
mkdirSync(output, { recursive: false });
const toolDirectory = join(releaseRoot, ".pack-tools");
mkdirSync(toolDirectory, { recursive: true });
writeFileSync(
    join(toolDirectory, "pnpm.cmd"),
    "@echo off\r\ncorepack.cmd pnpm %*\r\n",
);
process.env.PATH = `${toolDirectory};${process.env.PATH ?? ""}`;
process.env.npm_config_user_agent = `pnpm/10.17.0 npm/? node/${process.versions.node} win32 x64`;
process.env.npm_execpath = join(toolDirectory, "pnpm.cmd");
config.electronDist = "node_modules/electron/dist";
config.directories.output = output;
config.win.signAndEditExecutable = false;
console.log(JSON.stringify({ packageOutput: output }));
(async () => {
    const artifacts = await build({ config, dir: true });
    console.log(JSON.stringify({ packageOutput: output, artifacts }));
})()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        rmSync(toolDirectory, { recursive: true, force: true });
    });
