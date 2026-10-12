import { resolve } from "node:path";
import { defineConfig } from "vite";
import { createLabProcessingPlugin } from "./web/server/processingBridge";

export default defineConfig({
    root: resolve(__dirname, "web"),
    plugins: [createLabProcessingPlugin()],
    server: {
        host: "127.0.0.1",
        port: 5187,
        strictPort: true,
        fs: { allow: [resolve(__dirname)] },
    },
    preview: { host: "127.0.0.1", port: 5187, strictPort: true },
    build: {
        outDir: resolve(__dirname, "web-dist"),
        emptyOutDir: true,
        target: "es2022",
        sourcemap: true,
    },
});
