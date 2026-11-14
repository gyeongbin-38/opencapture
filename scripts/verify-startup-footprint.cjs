const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const electron = require("electron");
const valueFor = (name, fallback) => {
    const prefix = `--${name}=`;
    const entry = process.argv.find((value) => value.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : fallback;
};
const label = valueFor("label", "manual");
const expectation = valueFor("expect", "record");
const runs = Math.max(1, Number(valueFor("runs", "1")) || 1);
const sampleMs = Math.max(
    2500,
    Number(valueFor("sample-ms", "10500")) || 10500,
);
const includeKeepClip = process.argv.includes("--keep-clip");
const includeCaptureCheck = process.argv.includes("--capture-check");
const evidenceRoot = path.join(root, ".evidence", "startup-footprint");
fs.mkdirSync(evidenceRoot, { recursive: true });

const runProbe = (mode, run, keepClip = false, exerciseCapture = false) =>
    new Promise((resolve, reject) => {
        const token = `${Date.now()}-${process.pid}-${mode}-${run}`;
        const profile = path.join(evidenceRoot, `profile-${token}`);
        fs.mkdirSync(profile, { recursive: true });
        if (keepClip)
            fs.writeFileSync(
                path.join(profile, "config.json"),
                JSON.stringify({ 保留截屏窗口: true }),
            );
        const args = [
            path.join(root, "scripts", "startup-footprint-probe.cjs"),
            `--probe-mode=${keepClip ? "keep-clip" : mode}`,
            `--sample-ms=${sampleMs}`,
            `--userData=${profile}`,
        ];
        if (mode === "background") args.push("--background");
        if (exerciseCapture) args.push("--exercise-capture");
        const child = spawn(electron, args, {
            cwd: root,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const timeout = setTimeout(
            () => {
                child.kill();
                reject(new Error(`${mode} probe timed out (pid ${child.pid})`));
            },
            sampleMs + 20000 + (exerciseCapture ? 30000 : 0),
        );
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("exit", (code) => {
            clearTimeout(timeout);
            const line = stdout
                .split(/\r?\n/)
                .findLast((entry) => entry.startsWith("STARTUP_FOOTPRINT "));
            if (!line)
                return reject(
                    new Error(
                        `${mode} probe returned no report (code ${code})\n${stderr}\n${stdout}`,
                    ),
                );
            const report = JSON.parse(line.slice("STARTUP_FOOTPRINT ".length));
            report.exitCode = code;
            report.profile = profile;
            resolve(report);
        });
    });

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};
const hasClip = (report) =>
    report.samples
        .at(-1)
        .windows.some((window) =>
            /(?:capture|clip)\.html(?:\?|$)/.test(window.url),
        );

(async () => {
    const reports = [];
    for (const mode of ["normal", "background"])
        for (let run = 0; run < runs; run++)
            reports.push(await runProbe(mode, run));
    if (includeKeepClip) reports.push(await runProbe("background", 0, true));
    const captureReport = includeCaptureCheck
        ? await runProbe("normal", 0, false, true)
        : undefined;
    if (captureReport) reports.push(captureReport);

    const defaultReports = reports.filter(
        (report) => report.mode !== "keep-clip",
    );
    const eagerOnnx = defaultReports.some(
        (report) => report.modules["onnxruntime-node"].length > 0,
    );
    const idleClip = defaultReports.some(hasClip);
    const keepClipReport = reports.find(
        (report) => report.mode === "keep-clip",
    );
    const summary = {
        label,
        expectation,
        runs,
        sampleMs,
        eagerOnnx,
        idleClip,
        keepClipPreloaded: keepClipReport ? hasClip(keepClipReport) : undefined,
        captureExercise: captureReport?.captureExercise,
        medianReadyMs: median(defaultReports.map((report) => report.readyMs)),
        medianFinalWorkingSetBytes: median(
            defaultReports.map(
                (report) => report.samples.at(-1).processWorkingSetBytes,
            ),
        ),
        reports,
    };
    const reportPath = path.join(evidenceRoot, `${label}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, reports: undefined, reportPath }));
    if (reports.some((report) => !report.ok || report.exitCode !== 0))
        throw new Error("A startup probe reported an application error");
    if (expectation === "before" && (!eagerOnnx || !idleClip))
        throw new Error(
            "Baseline did not reproduce eager ONNX and delayed clip warmup",
        );
    if (expectation === "after") {
        if (eagerOnnx) throw new Error("ONNX loaded before AI upscale");
        if (idleClip)
            throw new Error("Default startup created a clip renderer");
        if (includeKeepClip && !summary.keepClipPreloaded)
            throw new Error("keepClip=true did not preload the clip renderer");
        if (
            includeCaptureCheck &&
            (!summary.captureExercise?.firstReady ||
                !summary.captureExercise?.repeatReady)
        )
            throw new Error("First or repeat capture did not become ready");
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
