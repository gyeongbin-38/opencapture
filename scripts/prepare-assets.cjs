#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");

const projectRoot = path.resolve(__dirname, "..");
const defaultManifestPath = path.join(projectRoot, "assets-manifest.json");

function sha256Buffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
}

function assertRelativePath(value, label) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0")
    ) {
        throw new Error(`${label} must be a non-empty path`);
    }
    const portable = value.replaceAll("\\", "/");
    if (
        portable.startsWith("/") ||
        /^[a-zA-Z]:/.test(portable) ||
        portable.split("/").includes("..")
    ) {
        throw new Error(`${label} escapes the asset root: ${value}`);
    }
    const normalized = path.posix.normalize(portable);
    if (normalized === "." || normalized.startsWith("../")) {
        throw new Error(`${label} escapes the asset root: ${value}`);
    }
    return normalized.replace(/^\.\//, "");
}

function normalizeZipEntry(entryName) {
    return assertRelativePath(entryName, "ZIP entry");
}

function selectedForHost(asset, platform, architecture) {
    return (
        (!asset.platforms || asset.platforms.includes(platform)) &&
        (!asset.architectures || asset.architectures.includes(architecture))
    );
}

function outputFiles(asset) {
    if (asset.archive === "zip") return asset.files;
    return [
        {
            path: asset.path,
            sha256: asset.download.sha256,
            size: asset.download.size,
        },
    ];
}

async function fileMatches(filePath, expected) {
    try {
        const stat = await fsp.stat(filePath);
        return (
            stat.isFile() &&
            stat.size === expected.size &&
            (await sha256File(filePath)) === expected.sha256
        );
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

async function downloadAsset(asset, destination, fetchImpl) {
    const response = await fetchImpl(asset.sourceUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
        throw new Error(
            `${asset.id}: download failed with HTTP ${response.status} ${response.statusText}`,
        );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (
        Number.isFinite(contentLength) &&
        (contentLength < asset.download.minBytes ||
            contentLength > asset.download.maxBytes)
    ) {
        throw new Error(
            `${asset.id}: Content-Length ${contentLength} is outside ${asset.download.minBytes}-${asset.download.maxBytes}`,
        );
    }

    const handle = await fsp.open(destination, "wx");
    let bytes = 0;
    const hash = crypto.createHash("sha256");
    try {
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > asset.download.maxBytes) {
                throw new Error(
                    `${asset.id}: response exceeded ${asset.download.maxBytes} bytes`,
                );
            }
            hash.update(chunk);
            await handle.write(chunk);
        }
    } finally {
        await handle.close();
    }

    if (bytes < asset.download.minBytes) {
        throw new Error(
            `${asset.id}: response contained only ${bytes} bytes (minimum ${asset.download.minBytes})`,
        );
    }
    if (bytes !== asset.download.size) {
        throw new Error(
            `${asset.id}: response size ${bytes} does not match pinned size ${asset.download.size}`,
        );
    }
    const actualHash = hash.digest("hex");
    if (actualHash !== asset.download.sha256) {
        throw new Error(
            `${asset.id}: SHA-256 mismatch (${actualHash}, expected ${asset.download.sha256})`,
        );
    }
}

function openZip(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(
            zipPath,
            { lazyEntries: true, autoClose: false },
            (error, zip) => {
                if (error) reject(error);
                else resolve(zip);
            },
        );
    });
}

function openEntryStream(zip, entry) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if (error) reject(error);
            else resolve(stream);
        });
    });
}

async function extractSelectedFiles(asset, zipPath, stagingRoot) {
    const wanted = new Map(
        asset.files.map((file) => [
            normalizeZipEntry(file.archivePath),
            { ...file, found: false },
        ]),
    );
    const zip = await openZip(zipPath);
    let totalUncompressed = 0;
    let entryCount = 0;

    try {
        await new Promise((resolve, reject) => {
            const fail = (error) => {
                zip.close();
                reject(error);
            };
            zip.on("error", fail);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                try {
                    entryCount += 1;
                    if (entryCount > 10000) {
                        throw new Error(
                            `${asset.id}: ZIP contains too many entries`,
                        );
                    }
                    const entryPath = normalizeZipEntry(entry.fileName);
                    totalUncompressed += entry.uncompressedSize;
                    if (totalUncompressed > asset.download.maxBytes * 20) {
                        throw new Error(
                            `${asset.id}: ZIP expansion limit exceeded`,
                        );
                    }
                    const unixType =
                        (entry.externalFileAttributes >>> 16) & 0o170000;
                    if (unixType === 0o120000) {
                        throw new Error(
                            `${asset.id}: symbolic links are not allowed in ZIP files`,
                        );
                    }
                    const expected = wanted.get(entryPath);
                    if (!expected || entryPath.endsWith("/")) {
                        zip.readEntry();
                        return;
                    }
                    if (expected.found) {
                        throw new Error(
                            `${asset.id}: duplicate ZIP entry ${entryPath}`,
                        );
                    }
                    if (entry.uncompressedSize !== expected.size) {
                        throw new Error(
                            `${asset.id}: ${entryPath} size ${entry.uncompressedSize} does not match ${expected.size}`,
                        );
                    }
                    expected.found = true;
                    const stagedPath = path.join(stagingRoot, expected.path);
                    fsp.mkdir(path.dirname(stagedPath), { recursive: true })
                        .then(() => openEntryStream(zip, entry))
                        .then((stream) =>
                            pipeline(
                                stream,
                                fs.createWriteStream(stagedPath, {
                                    flags: "wx",
                                }),
                            ),
                        )
                        .then(() => fileMatches(stagedPath, expected))
                        .then((matches) => {
                            if (!matches) {
                                throw new Error(
                                    `${asset.id}: extracted hash mismatch for ${entryPath}`,
                                );
                            }
                            zip.readEntry();
                        })
                        .catch(fail);
                } catch (error) {
                    fail(error);
                }
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }

    for (const [entryPath, expected] of wanted) {
        if (!expected.found) {
            throw new Error(
                `${asset.id}: expected ZIP entry is missing: ${entryPath}`,
            );
        }
    }
}

async function installFile(stagedPath, targetPath) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryTarget = `${targetPath}.prepare-${process.pid}`;
    await fsp.rm(temporaryTarget, { force: true });
    await fsp.copyFile(stagedPath, temporaryTarget);
    await fsp.rm(targetPath, { force: true });
    await fsp.rename(temporaryTarget, targetPath);
}

async function prepareAsset(asset, options) {
    const { rootDir, fetchImpl, logger, platform, architecture } = options;
    if (!selectedForHost(asset, platform, architecture)) {
        logger(`[assets] ${asset.id}: skipped (${platform}/${architecture})`);
        return "skipped";
    }
    const files = outputFiles(asset);
    for (const file of files)
        assertRelativePath(file.path, `${asset.id} output`);
    if (
        (
            await Promise.all(
                files.map((file) =>
                    fileMatches(path.join(rootDir, file.path), file),
                ),
            )
        ).every(Boolean)
    ) {
        logger(`[assets] ${asset.id}: ready`);
        return "ready";
    }

    logger(`[assets] ${asset.id}: downloading ${asset.sourceUrl}`);
    const temporaryRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), "opencapture-assets-"),
    );
    try {
        const downloadPath = path.join(temporaryRoot, "download");
        await downloadAsset(asset, downloadPath, fetchImpl);
        if (asset.archive === "zip") {
            const extractionRoot = path.join(temporaryRoot, "extracted");
            await fsp.mkdir(extractionRoot);
            await extractSelectedFiles(asset, downloadPath, extractionRoot);
            for (const file of files) {
                await installFile(
                    path.join(extractionRoot, file.path),
                    path.join(rootDir, file.path),
                );
            }
        } else {
            await installFile(downloadPath, path.join(rootDir, asset.path));
        }
    } finally {
        await fsp.rm(temporaryRoot, { recursive: true, force: true });
    }
    logger(`[assets] ${asset.id}: installed`);
    return "installed";
}

async function prepareAssets(options = {}) {
    const rootDir = options.rootDir ?? projectRoot;
    const manifestPath = options.manifestPath ?? defaultManifestPath;
    const manifest =
        options.manifest ??
        JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
        throw new Error("Unsupported assets manifest schema");
    }
    const context = {
        rootDir,
        fetchImpl: options.fetchImpl ?? fetch,
        logger: options.logger ?? console.log,
        platform: options.platform ?? process.platform,
        architecture:
            options.architecture ??
            process.env.npm_config_arch ??
            process.env.M_ARCH ??
            process.arch,
    };
    const results = [];
    for (const asset of manifest.assets) {
        results.push({
            id: asset.id,
            status: await prepareAsset(asset, context),
        });
    }
    return results;
}

if (require.main === module) {
    prepareAssets().catch((error) => {
        console.error(`[assets] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    assertRelativePath,
    downloadAsset,
    normalizeZipEntry,
    prepareAssets,
    sha256Buffer,
};
