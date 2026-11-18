const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeZipEntry, prepareAssets } = require("./prepare-assets.cjs");

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function withServer(handler, callback) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        await callback(`http://127.0.0.1:${address.port}/asset`);
    } finally {
        await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

test("reports install, ready, and tamper-repair status", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assets-test-"));
    const payload = Buffer.from("trusted asset payload");
    let requests = 0;
    try {
        await withServer(
            (_request, response) => {
                requests += 1;
                response.writeHead(200, { "Content-Length": payload.length });
                response.end(payload);
            },
            async (sourceUrl) => {
                const manifest = {
                    schemaVersion: 1,
                    assets: [
                        {
                            id: "fixture",
                            sourceUrl,
                            download: {
                                sha256: sha256(payload),
                                size: payload.length,
                                minBytes: payload.length,
                                maxBytes: payload.length,
                            },
                            path: "assets/fixture.bin",
                        },
                    ],
                };
                const messages = [];
                const options = {
                    rootDir,
                    manifest,
                    logger: (message) => messages.push(message),
                };
                assert.equal(
                    (await prepareAssets(options))[0].status,
                    "installed",
                );
                assert.equal((await prepareAssets(options))[0].status, "ready");
                await fsp.writeFile(
                    path.join(rootDir, "assets/fixture.bin"),
                    "tampered",
                );
                assert.equal(
                    (await prepareAssets(options))[0].status,
                    "installed",
                );
                assert.equal(requests, 2);
                assert(messages.some((message) => message.endsWith(": ready")));
            },
        );
    } finally {
        await fsp.rm(rootDir, { recursive: true, force: true });
    }
});

test("installs from a chunked response without Content-Length", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assets-test-"));
    const payload = Buffer.from("chunked asset payload");
    try {
        await withServer(
            (_request, response) => {
                response.writeHead(200, {
                    "Transfer-Encoding": "chunked",
                });
                response.write(payload);
                response.end();
            },
            async (sourceUrl) => {
                const result = await prepareAssets({
                    rootDir,
                    logger: () => {},
                    manifest: {
                        schemaVersion: 1,
                        assets: [
                            {
                                id: "chunked",
                                sourceUrl,
                                download: {
                                    sha256: sha256(payload),
                                    size: payload.length,
                                    minBytes: payload.length,
                                    maxBytes: payload.length,
                                },
                                path: "assets/chunked.bin",
                            },
                        ],
                    },
                });
                assert.equal(result[0].status, "installed");
            },
        );
    } finally {
        await fsp.rm(rootDir, { recursive: true, force: true });
    }
});

test("rejects a response outside the declared size bounds", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assets-test-"));
    const payload = Buffer.from("too large");
    try {
        await withServer(
            (_request, response) => {
                response.writeHead(200, { "Content-Length": payload.length });
                response.end(payload);
            },
            async (sourceUrl) => {
                await assert.rejects(
                    prepareAssets({
                        rootDir,
                        logger: () => {},
                        manifest: {
                            schemaVersion: 1,
                            assets: [
                                {
                                    id: "oversize",
                                    sourceUrl,
                                    download: {
                                        sha256: sha256(payload),
                                        size: payload.length,
                                        minBytes: 1,
                                        maxBytes: payload.length - 1,
                                    },
                                    path: "asset.bin",
                                },
                            ],
                        },
                    }),
                    /outside/,
                );
            },
        );
    } finally {
        await fsp.rm(rootDir, { recursive: true, force: true });
    }
});

test("rejects a hash mismatch without installing the file", async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assets-test-"));
    const payload = Buffer.from("unexpected payload");
    try {
        await withServer(
            (_request, response) => {
                response.writeHead(200, { "Content-Length": payload.length });
                response.end(payload);
            },
            async (sourceUrl) => {
                await assert.rejects(
                    prepareAssets({
                        rootDir,
                        logger: () => {},
                        manifest: {
                            schemaVersion: 1,
                            assets: [
                                {
                                    id: "bad-hash",
                                    sourceUrl,
                                    download: {
                                        sha256: "0".repeat(64),
                                        size: payload.length,
                                        minBytes: payload.length,
                                        maxBytes: payload.length,
                                    },
                                    path: "asset.bin",
                                },
                            ],
                        },
                    }),
                    /SHA-256 mismatch/,
                );
                await assert.rejects(
                    fsp.stat(path.join(rootDir, "asset.bin")),
                    /ENOENT/,
                );
            },
        );
    } finally {
        await fsp.rm(rootDir, { recursive: true, force: true });
    }
});

test("rejects ZIP traversal and absolute entry names", () => {
    for (const entry of [
        "../escape",
        "a/../../escape",
        "/absolute",
        "C:\\escape",
    ]) {
        assert.throws(() => normalizeZipEntry(entry), /escapes/);
    }
    assert.equal(
        normalizeZipEntry("models\\korean_rec.onnx"),
        "models/korean_rec.onnx",
    );
});
