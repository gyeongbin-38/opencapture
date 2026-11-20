import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: [
            "test/**/*.test.ts",
            "web/**/*.test.ts",
            "src/**/*.test.ts",
        ],
        exclude: ["src/renderer/screenShot/test/**"],
    },
});
