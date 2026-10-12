const path = require("node:path");
const { build } = require("vite");

const root = path.resolve(__dirname, "..");

build({
    root,
    configFile: false,
    logLevel: "info",
    build: {
        outDir: path.join(root, ".omx", "web-lab-worker"),
        emptyOutDir: false,
        target: "node20",
        minify: false,
        sourcemap: true,
        ssr: true,
        rollupOptions: {
            input: {
                worker: path.join(root, "web", "server", "workerMain.ts"),
                ocrRenderer: path.join(root, "web", "server", "ocrRenderer.ts"),
            },
            external: [
                "electron",
                "onnxruntime-node",
                "esearch-ocr",
                "xtranslator",
                "yauzl",
            ],
            output: {
                format: "cjs",
                entryFileNames: "[name].cjs",
                chunkFileNames: "chunks/[name]-[hash].cjs",
            },
        },
    },
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
