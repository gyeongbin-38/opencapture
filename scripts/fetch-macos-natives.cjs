#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const projectRoot = path.resolve(__dirname, "..");
const ortDir = "node_modules/onnxruntime-node/bin/napi-v6/darwin/x64";

// onnxruntime-node stopped shipping darwin/x64 in 1.24.x; 1.23.0 is the last
// release containing the binding. The versioned dylib is staged alongside and
// also aliased to libonnxruntime.1.dylib to cover either install name.
const artifacts = [
    {
        id: "node-screenshots-darwin-x64",
        tarball:
            "https://registry.npmjs.org/node-screenshots-darwin-x64/-/node-screenshots-darwin-x64-0.2.8.tgz",
        sha512: "3WIw4QaEP3pIUtSYh2NThwmzQl00H1bTPwPS7sYRLihAzB3NA/FOnIqRmvtadI0KEnnRGX4apdZgIhfXtgbNZA==",
        maxBytes: 2 * 1024 * 1024,
        expectedDependency: {
            packagePath: "node_modules/node-screenshots/package.json",
            optionalDependency: "node-screenshots-darwin-x64",
            version: "0.2.8",
        },
        files: [
            {
                archivePath: "package/package.json",
                path: "node_modules/node-screenshots-darwin-x64/package.json",
                sha256: "Zdbt4PdKOw/KIpmAE212BWEM0NuXeF+NwdktOK9GkE4=",
                size: 767,
            },
            {
                archivePath: "package/node-screenshots.darwin-x64.node",
                path: "node_modules/node-screenshots-darwin-x64/node-screenshots.darwin-x64.node",
                sha256: "hQN9A4jPuNrvrExsY4dRyUyiVO8VTwkPvLb+is0SjyY=",
                size: 713440,
            },
        ],
    },
    {
        id: "onnxruntime-darwin-x64",
        tarball:
            "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.23.0.tgz",
        sha512: "j7QVuR4ouektZjOopKtXcIGsB3C6R9kVbgS10lc2e5SxoWMUhmCwxNl4qBslpWJaPrFxvrQrQaQLQdqku8V19w==",
        maxBytes: 110 * 1024 * 1024,
        files: [
            {
                archivePath:
                    "package/bin/napi-v6/darwin/x64/onnxruntime_binding.node",
                path: `${ortDir}/onnxruntime_binding.node`,
                sha256: "aqxsRA3shQ4Zb6/NRi6EG/aDNFsdvJOjPV8O72EumF0=",
                size: 226408,
            },
            {
                archivePath:
                    "package/bin/napi-v6/darwin/x64/libonnxruntime.1.23.0.dylib",
                path: `${ortDir}/libonnxruntime.1.23.0.dylib`,
                sha256: "OBKnsWo6lUnSCoX8cEYBbyBvHnBliQL5kMTqTZ7nqSo=",
                size: 39851032,
            },
        ],
        aliases: [
            {
                source: `${ortDir}/libonnxruntime.1.23.0.dylib`,
                path: `${ortDir}/libonnxruntime.1.dylib`,
            },
        ],
    },
];

function sha256Base64(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("base64");
}

async function sha256FileBase64(filePath) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest("base64");
}

function readTarString(buffer, offset, length) {
    const end = buffer.indexOf(0, offset);
    return buffer.toString(
        "utf8",
        offset,
        end >= 0 && end < offset + length ? end : offset + length,
    );
}

function parsePaxPath(data) {
    let position = 0;
    while (position < data.length) {
        const spaceIndex = data.indexOf(0x20, position);
        if (spaceIndex < 0) break;
        const recordLength = Number(
            data.toString("utf8", position, spaceIndex),
        );
        if (!Number.isFinite(recordLength) || recordLength <= 0) break;
        const record = data.toString(
            "utf8",
            spaceIndex + 1,
            position + recordLength - 1,
        );
        if (record.startsWith("path=")) return record.slice(5);
        position += recordLength;
    }
    return undefined;
}

function readTarEntries(tarball) {
    const entries = [];
    let offset = 0;
    let paxPath;
    while (offset + 512 <= tarball.length) {
        const header = tarball.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const type = String.fromCharCode(header[156]);
        const size = Number.parseInt(readTarString(header, 124, 12), 8);
        if (!Number.isFinite(size) || size < 0)
            throw new Error("Invalid tar entry size");
        const prefix = readTarString(header, 345, 155);
        const baseName = readTarString(header, 0, 100);
        const name = paxPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
        paxPath = undefined;
        const bodyStart = offset + 512;
        const bodyEnd = bodyStart + size;
        if (bodyEnd > tarball.length)
            throw new Error(`Truncated tar entry: ${name}`);
        if (type === "x") {
            paxPath = parsePaxPath(tarball.subarray(bodyStart, bodyEnd));
        } else if (type === "0" || type === "") {
            entries.push({
                name,
                data: tarball.subarray(bodyStart, bodyEnd),
            });
        } else if (type === "1" || type === "2") {
            throw new Error(`Links are not allowed in npm tarballs: ${name}`);
        }
        offset = bodyStart + Math.ceil(size / 512) * 512;
    }
    return entries;
}

async function fileMatches(filePath, expected) {
    try {
        const stat = await fsp.stat(filePath);
        return (
            stat.isFile() &&
            stat.size === expected.size &&
            (await sha256FileBase64(filePath)) === expected.sha256
        );
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

async function installFile(source, targetPath) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryTarget = `${targetPath}.stage-${process.pid}`;
    await fsp.rm(temporaryTarget, { force: true });
    await fsp.writeFile(temporaryTarget, source, { flag: "wx" });
    await fsp.rm(targetPath, { force: true });
    await fsp.rename(temporaryTarget, targetPath);
}

async function fetchTarball(artifact) {
    const response = await fetch(artifact.tarball, { redirect: "follow" });
    if (!response.ok || !response.body)
        throw new Error(
            `${artifact.id}: download failed with HTTP ${response.status}`,
        );
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > artifact.maxBytes)
            throw new Error(
                `${artifact.id}: response exceeded ${artifact.maxBytes} bytes`,
            );
        chunks.push(chunk);
    }
    const compressed = Buffer.concat(chunks);
    const actual = crypto
        .createHash("sha512")
        .update(compressed)
        .digest("base64");
    if (actual !== artifact.sha512)
        throw new Error(`${artifact.id}: tarball sha512 mismatch`);
    return zlib.gunzipSync(compressed);
}

function checkExpectedDependency(artifact) {
    const expected = artifact.expectedDependency;
    if (!expected) return;
    const manifestPath = path.join(projectRoot, expected.packagePath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const wanted = manifest.optionalDependencies?.[expected.optionalDependency];
    if (wanted !== expected.version)
        throw new Error(
            `${artifact.id}: installed ${expected.optionalDependency} requirement is ${wanted}, pinned staging expects ${expected.version}`,
        );
}

async function stageArtifact(artifact, logger) {
    checkExpectedDependency(artifact);
    if (
        (
            await Promise.all(
                artifact.files.map((file) =>
                    fileMatches(path.join(projectRoot, file.path), file),
                ),
            )
        ).every(Boolean)
    ) {
        logger(`[macos-natives] ${artifact.id}: ready`);
        return;
    }
    logger(`[macos-natives] ${artifact.id}: fetching ${artifact.tarball}`);
    const tarball = await fetchTarball(artifact);
    const entries = new Map(readTarEntries(tarball).map((e) => [e.name, e]));
    for (const file of artifact.files) {
        const entry = entries.get(file.archivePath);
        if (!entry)
            throw new Error(
                `${artifact.id}: missing tarball entry ${file.archivePath}`,
            );
        if (entry.data.length !== file.size)
            throw new Error(
                `${artifact.id}: ${file.archivePath} size ${entry.data.length} does not match ${file.size}`,
            );
        if (sha256Base64(entry.data) !== file.sha256)
            throw new Error(
                `${artifact.id}: ${file.archivePath} sha256 mismatch`,
            );
        await installFile(entry.data, path.join(projectRoot, file.path));
    }
    for (const alias of artifact.aliases ?? []) {
        const source = path.join(projectRoot, alias.source);
        const target = path.join(projectRoot, alias.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(source, target);
    }
    logger(`[macos-natives] ${artifact.id}: staged`);
}

async function main() {
    const logger = console.log;
    for (const artifact of artifacts) await stageArtifact(artifact, logger);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[macos-natives] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { readTarEntries };
