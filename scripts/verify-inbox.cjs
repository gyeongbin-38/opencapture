const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const profile = path.join(root, ".evidence/inbox-profile");
const folder = path.join(profile, "shots");
const inbox = path.join(profile, "capture-inbox");
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });
const image = path.join(folder, "native-fixture.png");
fs.copyFileSync(path.join(root, ".evidence/red.png"), image);
fs.writeFileSync(
    path.join(profile, "library.json"),
    JSON.stringify({
        collections: [
            { id: "a", name: "A", path: folder },
            { id: "b", name: "B", path: path.join(profile, "other") },
        ],
        items: [],
        activeCollectionId: "b",
        workflow: {
            autoCopy: false,
            autoPin: false,
            autoRemoveBackground: false,
        },
    }),
);
const capturedAt = "2026-10-09T12:00:00.1234567Z";
for (const name of ["a", "b"])
    fs.writeFileSync(
        path.join(inbox, `${name}.json`),
        JSON.stringify({ version: 1, path: image, createdAt: capturedAt }),
    );
const expectedCount = process.argv.includes("--backlog") ? 125 : 1;
for (let i = 1; i < expectedCount; i++) {
    const p = path.join(folder, `native-${i}.png`);
    fs.copyFileSync(image, p);
    fs.writeFileSync(
        path.join(inbox, `backlog-${i}.json`),
        JSON.stringify({ version: 1, path: p, createdAt: capturedAt }),
    );
}
fs.writeFileSync(path.join(inbox, "invalid.json"), "{");
const child = spawn(
    path.join(root, "release/win-unpacked/OpenCapture.exe"),
    ["--broker", "--process-inbox", `--userData=${profile}`],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const timer = setTimeout(() => {
    child.kill();
    console.error("Inbox process timed out", log);
    process.exitCode = 1;
}, 30000);
child.on("exit", (code) => {
    clearTimeout(timer);
    try {
        if (code !== 0) throw Error("Inbox process failed: " + log);
        const library = JSON.parse(
            fs.readFileSync(path.join(profile, "library.json"), "utf8"),
        );
        if (
            library.items.length !== expectedCount ||
            !library.items.every(
                (i) =>
                    i.collectionId === "a" &&
                    i.createdAt === capturedAt &&
                    i.workflowComplete === true,
            )
        )
            throw Error(
                "Receipt attribution, workflow completion, time or dedup failed",
            );
        if (
            !fs.existsSync(image) ||
            fs.existsSync(path.join(inbox, "a.json")) ||
            !fs.existsSync(path.join(inbox, "invalid.json.invalid"))
        )
            throw Error("Receipt cleanup/preservation failed");
        const evidence = {
            exitCode: code,
            itemCount: library.items.length,
            item: library.items[0],
            originalPreserved: true,
            duplicateDeduplicated: true,
            invalidQuarantined: true,
        };
        fs.writeFileSync(
            path.join(root, ".evidence/inbox.json"),
            JSON.stringify(evidence, null, 2),
        );
        console.log(JSON.stringify(evidence));
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
});
