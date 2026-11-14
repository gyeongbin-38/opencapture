const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const recordFatal = (error) => {
    fs.writeFileSync(
        path.join(root, ".evidence", "rar-e2e", "report.json"),
        JSON.stringify(
            {
                ok: false,
                error: error instanceof Error ? error.stack : String(error),
            },
            null,
            2,
        ),
    );
};
process.on("uncaughtException", recordFatal);
process.on("unhandledRejection", recordFatal);
if (!process.versions.electron) {
    const { spawnSync } = require("node:child_process");
    const profile = fs.mkdtempSync(
        path.join(os.tmpdir(), "opencapture-rar-e2e-"),
    );
    const result = spawnSync(require("electron"), [__filename], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, OPENCAPTURE_RAR_E2E_PROFILE: profile },
    });
    fs.rmSync(profile, { recursive: true, force: true });
    process.exit(result.status ?? 1);
}

const { app } = require("electron");
app.on("window-all-closed", (event) => event.preventDefault());
const profile = process.env.OPENCAPTURE_RAR_E2E_PROFILE;
assert.ok(profile, "The Node E2E coordinator must provide an isolated profile");
app.setPath("userData", profile);

function input(file) {
    return {
        id: file,
        name: path.basename(file),
        path: file,
        size: fs.statSync(file).size,
        extension: "rar",
        kind: "archive",
    };
}

function context(
    source,
    recipe,
    outputDir,
    options = {},
    signal = new AbortController().signal,
) {
    fs.mkdirSync(outputDir, { recursive: true });
    return {
        inputs: [source],
        recipe,
        options,
        outputDir,
        signal,
        progress() {},
    };
}

app.whenReady().then(async () => {
    try {
        const modulePath = path.join(
            root,
            ".evidence",
            "rar-e2e",
            "src",
            "main",
            "fileToolsRar.js",
        );
        assert.ok(
            fs.existsSync(modulePath),
            "Compile fileToolsRar.ts to .evidence/rar-e2e before this test",
        );
        const { createRarTools } = require(modulePath);
        const tools = createRarTools({ root });
        const report = [];
        for (const version of ["rar4", "rar5"]) {
            const file = path.join(
                root,
                "test",
                "fixtures",
                "rar",
                `${version}.rar`,
            );
            const source = input(file);
            const inspected = await tools.run(
                context(
                    source,
                    "archive-rar-inspect",
                    path.join(profile, `${version}-inspect`),
                ),
            );
            const inspection = JSON.parse(
                fs.readFileSync(inspected.paths[0], "utf8"),
            );
            assert.ok(inspection.valid && inspection.verifiedBytes > 0);
            const extracted = await tools.run(
                context(
                    source,
                    "archive-rar-extract",
                    path.join(profile, `${version}-extract`),
                ),
            );
            assert.ok(fs.statSync(extracted.paths[0]).isDirectory());
            report.push({
                version,
                entries: inspection.entries.length,
                bytes: inspection.verifiedBytes,
            });
        }
        for (const version of ["rar4", "rar5"]) {
            const file = path.join(
                root,
                "test",
                "fixtures",
                "rar",
                `${version}-encrypted.rar`,
            );
            await assert.rejects(
                tools.run(
                    context(
                        input(file),
                        "archive-rar-test",
                        path.join(profile, `${version}-encrypted`),
                    ),
                ),
                /Encrypted RAR archives are unavailable/,
            );
        }
        const cancelController = new AbortController();
        const cancelFile = path.join(
            root,
            "test",
            "fixtures",
            "rar",
            "rar4.rar",
        );
        const cancelContext = context(
            input(cancelFile),
            "archive-rar-extract",
            path.join(profile, "cancel"),
            {},
            cancelController.signal,
        );
        cancelContext.progress = (percent) => {
            if (percent > 0) cancelController.abort();
        };
        await assert.rejects(tools.run(cancelContext), { name: "AbortError" });
        fs.writeFileSync(
            path.join(root, ".evidence", "rar-e2e", "report.json"),
            JSON.stringify({ ok: true, report, cancellation: "pass" }, null, 2),
        );
        console.log(JSON.stringify({ ok: true, report }));
        app.exit(0);
    } catch (error) {
        fs.writeFileSync(
            path.join(root, ".evidence", "rar-e2e", "report.json"),
            JSON.stringify(
                {
                    ok: false,
                    error: error instanceof Error ? error.stack : String(error),
                },
                null,
                2,
            ),
        );
        console.error(error);
        app.exit(1);
    }
});
