// @ts-check
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const arch =
    (process.env.npm_config_arch || process.env.M_ARCH || process.arch) ===
    "arm64"
        ? "arm64"
        : "x64";

const beforePack = async () => {
    await require("./scripts/prepare-assets.cjs").prepareAssets();
    if (process.platform === "win32")
        execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path.join(__dirname, "scripts/build-quicklaunch.ps1"),
            ],
            { stdio: "inherit" },
        );
};

/**
 * @type import("electron-builder").Configuration
 */
const build = {
    appId: "org.opencapture.desktop",
    extraFiles: ["LICENSE", "THIRD_PARTY_NOTICES.md", "README_OPENCAPTURE.md"],
    executableName: "OpenCapture",
    directories: {
        output: "build",
    },
    icon: "./assets/logo",
    electronDownload: {
        mirror: "https://github.com/electron/electron/releases/download/",
    },
    npmRebuild: false,
    electronFuses: {
        runAsNode: false,
    },
    electronLanguages: fs
        .readdirSync(path.join(__dirname, "lib/translate"))
        .filter((file) => {
            return (
                file.endsWith(".json") &&
                !file.startsWith("source") &&
                !file.startsWith(".")
            );
        })
        .map((i) => i.replace(".json", ""))
        .concat("zh-HANS")
        .map((i) => i.split("-")[0]),
    fileAssociations: [
        {
            ext: "svg",
            mimeType: "image/svg+xml",
            role: "Editor",
        },
        {
            ext: "png",
            mimeType: "image/png",
            role: "Editor",
        },
        {
            ext: "jpg",
            mimeType: "image/jpeg",
            role: "Editor",
        },
    ],
    asar: false,
    artifactName: `\${productName}-\${version}-\${platform}-${arch}.\${ext}`,
    beforePack: beforePack,
    linux: {
        category: "Utility",
        target: [
            { target: "tar.gz", arch },
            { target: "deb", arch },
            { target: "rpm", arch },
            { target: "AppImage", arch },
        ],
        files: [
            "!assets/logo/icon.icns",
            "!assets/logo/icon.ico",
            "!node_modules/onnxruntime-node/bin/napi-v6/win32",
            "!node_modules/onnxruntime-node/bin/napi-v6/darwin",
        ],
    },
    deb: {
        depends: ["ffmpeg"],
    },
    rpm: {
        depends: ["ffmpeg-free"],
    },
    mac: {
        category: "public.app-category.utilities",
        icon: "./assets/logo/icon.icns",
        files: [
            "!native/**",
            "!lib/copy.exe",
            "!lib/ffmpeg/ffmpeg.exe",
            "!assets/runtime/win32-x64/**",
            "!lib/gtk-open-with",
            "!lib/kde-open-with",
            "!assets/logo/1024x1024.png",
            "!assets/logo/512x512.png",
            "!assets/logo/icon.ico",
            "!node_modules/onnxruntime-node/bin/napi-v6/win32/**",
            "!node_modules/onnxruntime-node/bin/napi-v6/linux/**",
            "!node_modules/uiohook-napi/prebuilds/win32-*",
            "!node_modules/uiohook-napi/prebuilds/linux-*",
            "!node_modules/node-screenshots-win32-*",
            "!node_modules/node-screenshots-linux-*",
        ],
        target: [
            {
                target: "dmg",
                arch: ["arm64", "x64"],
            },
            {
                target: "zip",
                arch: ["arm64", "x64"],
            },
        ],
        entitlements: "entitlements/mac.plist",
        hardenedRuntime: true,
        extendInfo: {
            NSCameraUsageDescription:
                "OpenCapture uses the camera only when you enable a camera overlay while recording.",
            NSMicrophoneUsageDescription:
                "OpenCapture uses the microphone only when you enable microphone audio while recording.",
            NSAudioCaptureUsageDescription:
                "OpenCapture captures system audio only when you enable system audio in a recording.",
            NSScreenCaptureUsageDescription:
                "OpenCapture needs screen recording access to capture screenshots and recordings you request.",
        },
    },
    dmg: {
        writeUpdateInfo: false,
    },
    win: {
        icon: "./assets/logo/icon.ico",
        extraFiles: [
            {
                from: "native/bin/OpenCaptureQuick.exe",
                to: "OpenCaptureQuick.exe",
            },
        ],
        target: [
            {
                target: "nsis",
                arch: arch,
            },
            {
                target: "zip",
                arch: arch,
            },
        ],
        files: [
            "!lib/gtk-open-with",
            "!lib/kde-open-with",
            "!assets/logo/icon.icns",
            "!assets/logo/1024x1024.png",
            "!assets/logo/512x512.png",
            "!node_modules/onnxruntime-node/bin/napi-v6/linux",
            "!node_modules/onnxruntime-node/bin/napi-v6/darwin",
        ],
    },
    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        differentialPackage: false,
    },
};

const nodeScreenshotsList = [
    "win32-x64-msvc",
    "win32-ia32-msvc",
    "win32-arm64-msvc",
    "linux-x64-gnu",
    "linux-x64-musl",
    "linux-arm64-gnu",
    "linux-loong64-gnu",
    "darwin-x64",
    "darwin-arm64",
];
const platformFiles = {
    linux: build.linux?.files,
    win32: build.win?.files,
    darwin: build.mac?.files,
};
for (const [targetPlatform, patterns] of Object.entries(platformFiles)) {
    if (!Array.isArray(patterns)) continue;
    for (const nativePlatform of ["linux", "win32", "darwin"])
        if (nativePlatform !== targetPlatform)
            patterns.push(
                `!node_modules/uiohook-napi/prebuilds/${nativePlatform}-*`,
            );
    for (const packageName of nodeScreenshotsList) {
        const belongsToPlatform = packageName.startsWith(`${targetPlatform}-`);
        const matchesArchitecture = packageName.startsWith(
            `${targetPlatform}-${arch}`,
        );
        if (
            !belongsToPlatform ||
            (targetPlatform !== "darwin" && !matchesArchitecture)
        )
            patterns.push(`!node_modules/node-screenshots-${packageName}`);
    }
    if (targetPlatform !== "darwin") {
        const otherArch = arch === "arm64" ? "x64" : "arm64";
        patterns.push(
            `!node_modules/onnxruntime-node/bin/napi-v6/${targetPlatform}/${otherArch}`,
            `!node_modules/uiohook-napi/prebuilds/${targetPlatform}-${otherArch}`,
        );
    }
}

const ignoreDir = [
    "native",
    "lib/copy.exe",
    "build",
    "build-alt",
    "release",
    "release/verify-*",
    "scripts",
    ".*",
    "tsconfig*",
    "*.md",
    "*.js",
    "*.yaml",
    "**/*.map",
    "**/*.ts",
    "src",
    "docs",
    "script",
    "test",
    "node_modules/**/*.flow",
    "node_modules/**/*.md",
    "node_modules/**/*.h", // uiohook
    "node_modules/**/*.c", // uiohook
    "node_modules/**/demo*", // js-clipper
    "node_modules/js-clipper/vendor",
    "node_modules/onnxruntime-node/script",
    "node_modules/**/**esm**",
    "node_modules/**/*.es*",
    "node_modules/esearch-ocr/dist/esearch-ocr.js",
];
const ignoreModule = [
    "pdfjs-dist",
    "@napi-rs/canvas*",
    "qr-scanner-wechat",
    "tar",
    "hotkeys-js",
    "hex-to-css-filter",
    "dkh-ui",
    "xtranslator",
    "fabric",
    "jsdom",
    "canvas",
    "remarkable",
    "autolinker",
    "chroma-js",
    "parse5",
    "source-map",
    "acorn",
    "cssstyle",
    "psl",
    "js-clipper",
    "iso-639-3-to-1",
    "fuse.js",
    "iconv-lite",
    "esprima",
    "decimal.js",
    "@xushengfeng/fasttext_wasm",
    "tar-fs",
    "node-abi",
    "tr46",
    "argparse",
    "mediabunny",
    "picture_match",
];
for (const i of ignoreModule) {
    ignoreDir.push(`node_modules/${i}`);
}
for (const ignored of ignoreDir)
    for (const patterns of Object.values(platformFiles))
        if (Array.isArray(patterns)) patterns.push(`!${ignored}`);

module.exports = build;
