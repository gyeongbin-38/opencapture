import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defineConfig } from "electron-vite";
import { analyzer } from "vite-bundle-analyzer";
import { ViteImageOptimizer } from "vite-plugin-image-optimizer";

export default defineConfig(({ mode }) => ({
    main: {
        build: {
            minify: false,
            rollupOptions: { external: ["onnxruntime-node"] },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                input: {
                    dashboard: path.resolve(
                        __dirname,
                        "src/preload/dashboard.ts",
                    ),
                    fileShelf: path.resolve(
                        __dirname,
                        "src/preload/fileShelf.ts",
                    ),
                    rarTools: path.resolve(
                        __dirname,
                        "src/preload/rarTools.ts",
                    ),
                    pdfTools: path.resolve(
                        __dirname,
                        "src/preload/pdfTools.ts",
                    ),
                },
                output: { entryFileNames: "[name].js", format: "cjs" },
            },
        },
    },
    renderer: {
        build: {
            rollupOptions: {
                input: {
                    dashboard: path.resolve(
                        __dirname,
                        "src/renderer/dashboard.html",
                    ),
                    file_shelf: path.resolve(
                        __dirname,
                        "src/renderer/file_shelf.html",
                    ),
                    rar_tools: path.resolve(
                        __dirname,
                        "src/renderer/rar_tools.html",
                    ),
                    pdf_tools: path.resolve(
                        __dirname,
                        "src/renderer/pdf_tools.html",
                    ),
                    capture_shelf: path.resolve(
                        __dirname,
                        "src/renderer/capture_shelf.html",
                    ),
                    editor: path.resolve(__dirname, "src/renderer/editor.html"),
                    clip: path.resolve(__dirname, "src/renderer/capture.html"),
                    captureDelay: path.resolve(
                        __dirname,
                        "src/renderer/captureDelay.html",
                    ),
                    setting: path.resolve(
                        __dirname,
                        "src/renderer/setting.html",
                    ),
                    ding: path.resolve(__dirname, "src/renderer/ding.html"),
                    radial: path.resolve(__dirname, "src/renderer/radial.html"),
                    recorder: path.resolve(
                        __dirname,
                        "src/renderer/recorder.html",
                    ),
                    recorderTip: path.resolve(
                        __dirname,
                        "src/renderer/recorderTip.html",
                    ),
                    dropzone: path.resolve(
                        __dirname,
                        "src/renderer/dropzone.html",
                    ),
                    browser_bg: path.resolve(
                        __dirname,
                        "src/renderer/browser_bg.html",
                    ),
                    translator: path.resolve(
                        __dirname,
                        "src/renderer/translator.html",
                    ),
                    translate: path.resolve(
                        __dirname,
                        "src/renderer/translate.html",
                    ),
                    photoEditor: path.resolve(
                        __dirname,
                        "src/renderer/photoEditor.html",
                    ),
                    videoEditor: path.resolve(
                        __dirname,
                        "src/renderer/videoEditor.html",
                    ),
                    aiVision: path.resolve(
                        __dirname,
                        "src/renderer/aiVision.html",
                    ),
                    ocr_worker: path.resolve(
                        __dirname,
                        "src/renderer/ocr_worker.html",
                    ),
                },
            },
            assetsInlineLimit: 0,
            minify: false,
            sourcemap: true,
        },
        optimizeDeps: {
            exclude: ["node-screenshots", "onnxruntime-node"],
            include: [
                "@erase2d/fabric",
                "@pdf-lib/upng",
                "bmp-js",
                "chroma-js",
                "diff-match-patch",
                "diff-match-patch-line-and-word",
                "dkh-ui",
                "edge_det",
                "fabric",
                "fuse.js",
                "gifenc",
                "hex-to-css-filter",
                "hotkeys-js",
                "mediabunny",
                "myde-dbus",
                "picture_match",
                "remarkable",
                "xtranslator",
            ],
        },
        plugins: [
            {
                name: "local-pdf-assets",
                writeBundle() {
                    const source = path.dirname(
                        createRequire(import.meta.url).resolve(
                            "pdfjs-dist/package.json",
                        ),
                    );
                    const destination = path.resolve(
                        __dirname,
                        "out/renderer/assets/pdfjs",
                    );
                    mkdirSync(destination, { recursive: true });
                    for (const directory of ["cmaps", "standard_fonts", "wasm"])
                        cpSync(
                            path.join(source, directory),
                            path.join(destination, directory),
                            { recursive: true },
                        );
                    cpSync(
                        path.join(source, "LICENSE"),
                        path.join(destination, "LICENSE"),
                    );
                    cpSync(
                        path.join(
                            path.dirname(
                                createRequire(import.meta.url).resolve(
                                    "pdf-lib/package.json",
                                ),
                            ),
                            "LICENSE.md",
                        ),
                        path.join(destination, "LICENSE.pdf-lib"),
                    );
                },
            },
            ViteImageOptimizer({
                cache: true,
                cacheLocation: path.join(tmpdir(), "eSearch_build"),
                logStats: false,
                include: /.*\svg$/,
            }),
            mode === "analyze" ? analyzer() : undefined,
        ],
    },
}));
