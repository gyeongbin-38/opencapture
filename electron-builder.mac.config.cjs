// @ts-check

const path = require("node:path");
const base = require("./electron-builder.config.js");

const channel = process.env.OPENCAPTURE_MAC_CHANNEL ?? "darwin";
if (channel !== "darwin" && channel !== "mas")
    throw new Error(`Unsupported OPENCAPTURE_MAC_CHANNEL: ${channel}`);
const selectedArch = process.env.OPENCAPTURE_MAC_ARCH;
if (
    selectedArch !== undefined &&
    selectedArch !== "arm64" &&
    selectedArch !== "x64"
)
    throw new Error(`Unsupported OPENCAPTURE_MAC_ARCH: ${selectedArch}`);
/** @type {Array<"arm64" | "x64">} */
const architectures = selectedArch
    ? [/** @type {"arm64" | "x64"} */ (selectedArch)]
    : ["arm64", "x64"];
const otherArch = selectedArch === "arm64" ? "x64" : "arm64";

const baseMacFiles = Array.isArray(base.mac?.files)
    ? base.mac.files
    : base.mac?.files
      ? [base.mac.files]
      : [];
const macFiles = [
    ...baseMacFiles,
    ...(selectedArch
        ? [
              `!node_modules/onnxruntime-node/bin/napi-v6/darwin/${otherArch}`,
              `!node_modules/uiohook-napi/prebuilds/darwin-${otherArch}`,
              `!node_modules/node-screenshots-darwin-${otherArch}`,
          ]
        : []),
];

/** @type {NonNullable<import("electron-builder").Configuration["mac"]>} */
const mac = {
    ...base.mac,
    files: macFiles,
    target:
        channel === "mas"
            ? [{ target: "mas", arch: architectures }]
            : [
                  { target: "dmg", arch: architectures },
                  { target: "zip", arch: architectures },
              ],
};

const mas =
    channel === "mas"
        ? {
              ...base.mas,
              category: "public.app-category.utilities",
              entitlements: "entitlements/mas.plist",
              entitlementsInherit: "entitlements/mas.inherit.plist",
              entitlementsLoginHelper: "entitlements/mas.plist",
              hardenedRuntime: false,
              extendInfo: {
                  ...(base.mac?.extendInfo ?? {}),
                  ...(process.env.APPLE_TEAM_ID
                      ? { ElectronTeamID: process.env.APPLE_TEAM_ID }
                      : {}),
              },
              ...(process.env.OPENCAPTURE_MAS_PROVISIONING_PROFILE
                  ? {
                        provisioningProfile:
                            process.env.OPENCAPTURE_MAS_PROVISIONING_PROFILE,
                    }
                  : {}),
          }
        : undefined;

/** @type {import("electron-builder").Configuration} */
const config = {
    ...base,
    directories: {
        ...base.directories,
        output:
            process.env.OPENCAPTURE_MAC_OUTPUT ??
            path.join("release", "macos", channel),
    },
    artifactName: "${productName}-${version}-${platform}-${arch}.${ext}",
    mac,
    ...(mas ? { mas } : {}),
};

module.exports = config;
