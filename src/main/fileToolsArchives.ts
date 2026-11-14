import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { type Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    crc32,
    createBrotliCompress,
    createBrotliDecompress,
    createGunzip,
    createGzip,
} from "node:zlib";
import yauzl from "yauzl";
import type { FileToolRecipe } from "../../lib/fileTools";
import type {
    FileToolEngine,
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "./fileToolsTypes";

const MAX_ENTRIES = 5_000;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_NAME_LENGTH = 1_024;
const MAX_COMPRESSION_RATIO = 1_000;

type ArchiveFormat = "zip" | "tar" | "gzip" | "br" | "targzip" | "tarbr";
type ZipEntryInfo = {
    path: string;
    directory: boolean;
    compressedSize: number;
    uncompressedSize: number;
    crc32: number;
};

function abortError() {
    const error = new Error("Archive operation cancelled");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw abortError();
}

function extensionOf(input: ToolInput) {
    return input.extension.toLowerCase().replace(/^\./, "");
}

function archiveFormat(input: ToolInput): ArchiveFormat | null {
    const extension = extensionOf(input);
    if (extension === "zip") return "zip";
    if (extension === "tar") return "tar";
    if (extension === "tgz" || /\.tar\.(?:gz|gzip)$/i.test(input.name))
        return "targzip";
    if (/\.tar\.br$/i.test(input.name)) return "tarbr";
    if (extension === "gz" || extension === "gzip") return "gzip";
    if (extension === "br") return "br";
    return null;
}

function unavailableReason(input: ToolInput | undefined) {
    if (!input) return "Select one supported archive";
    const extension = extensionOf(input);
    if (extension === "rar")
        return "RAR is unavailable because no reviewed RAR engine is bundled";
    return "Supported archives are ZIP, TAR, GZIP, and Brotli";
}

function recipes(inputs: ToolInput[]): FileToolRecipe[] {
    const input = inputs.length === 1 ? inputs[0] : undefined;
    const supported = input ? archiveFormat(input) !== null : false;
    const reason = supported ? undefined : unavailableReason(input);
    return [
        {
            id: "archive-extract",
            label: "Extract archive",
            group: "tools",
            available: supported,
            reason,
        },
        {
            id: "archive-inspect",
            label: "List archive contents",
            group: "tools",
            available: supported,
            reason,
        },
        {
            id: "archive-test",
            label: "Test archive integrity",
            group: "tools",
            available: supported,
            reason,
        },
        {
            id: "archive-compress",
            label: "Compress files",
            group: "convert",
            formats: ["zip", "tar", "gz", "br"],
            multiple: true,
            available: inputs.length > 0,
            reason: inputs.length ? undefined : "Select one or more files",
        },
    ];
}

async function ensureOutputRoot(outputDir: string) {
    await mkdir(outputDir, { recursive: true });
    const info = await lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Archive output directory is not a safe directory");
    return resolve(outputDir);
}

function outputPath(outputRoot: string, ...segments: string[]) {
    const target = resolve(outputRoot, ...segments);
    if (
        target !== outputRoot &&
        !target.startsWith(`${outputRoot}\\`) &&
        !target.startsWith(`${outputRoot}/`)
    )
        throw new Error("Archive output escaped its staging directory");
    return target;
}

async function ensureDirectoryChain(root: string, segments: string[]) {
    let current = root;
    for (const segment of segments) {
        current = outputPath(root, relative(root, current), segment);
        try {
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error(`Unsafe archive output path: ${segment}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await mkdir(current);
        }
    }
    return current;
}

function safeOutputName(value: string) {
    const normalized = value
        .normalize("NFC")
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim();
    const safe = Array.from(normalized, (character) =>
        character.charCodeAt(0) < 32 ? "-" : character,
    ).join("");
    return safe || "archive-output";
}

async function uniqueOutputPath(
    outputRoot: string,
    requestedName: string,
    reserved: Set<string>,
) {
    const extension = extname(requestedName);
    const stem = requestedName.slice(
        0,
        requestedName.length - extension.length,
    );
    for (let index = 0; index < 10_000; index += 1) {
        const name = index ? `${stem}-${index + 1}${extension}` : requestedName;
        const canonical = name.normalize("NFC").toLowerCase();
        if (reserved.has(canonical)) continue;
        const target = outputPath(outputRoot, name);
        try {
            await lstat(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reserved.add(canonical);
                return target;
            }
            throw error;
        }
    }
    throw new Error("Could not allocate a unique archive output name");
}

function openZip(path: string) {
    return new Promise<yauzl.ZipFile>((resolveZip, reject) => {
        yauzl.open(
            path,
            {
                autoClose: true,
                lazyEntries: true,
                decodeStrings: true,
                strictFileNames: true,
                validateEntrySizes: true,
            },
            (error, zip) => {
                if (error) reject(error);
                else if (!zip) reject(new Error("Could not open ZIP archive"));
                else resolveZip(zip);
            },
        );
    });
}

function validateZipPath(name: string) {
    if (
        !name ||
        name.length > MAX_NAME_LENGTH ||
        name.includes("\0") ||
        name.includes("\\") ||
        name.startsWith("/") ||
        /^[a-zA-Z]:/.test(name)
    )
        throw new Error(`Unsafe ZIP entry path: ${name}`);
    const directory = name.endsWith("/");
    const withoutSlash = directory ? name.slice(0, -1) : name;
    const segments = withoutSlash.split("/");
    if (
        !withoutSlash ||
        segments.some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".." ||
                segment.includes(":") ||
                /[. ]$/.test(segment) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
        )
    )
        throw new Error(`Unsafe ZIP entry path: ${name}`);
    return { directory, segments, normalized: segments.join("/") };
}

function validateZipEntryType(entry: yauzl.Entry, directory: boolean) {
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const type = unixMode & 0o170000;
    if (type === 0) return;
    if (directory && type === 0o040000) return;
    if (!directory && type === 0o100000) return;
    throw new Error(`Unsupported ZIP entry type: ${entry.fileName}`);
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry) {
    return new Promise<Readable>((resolveStream, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if (error) reject(error);
            else if (!stream) reject(new Error("Could not read ZIP entry"));
            else resolveStream(stream as Readable);
        });
    });
}

async function verifyOrExtractEntry(
    zip: yauzl.ZipFile,
    entry: yauzl.Entry,
    destination: string | undefined,
    signal: AbortSignal,
) {
    throwIfAborted(signal);
    const stream = await openEntryStream(zip, entry);
    let actualSize = 0;
    let actualCrc = 0;
    const validator = new Transform({
        transform(value, _encoding, callback) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            actualSize += chunk.length;
            if (
                actualSize > entry.uncompressedSize ||
                actualSize > MAX_EXPANDED_BYTES
            ) {
                callback(
                    new Error(
                        `ZIP entry exceeded its declared size: ${entry.fileName}`,
                    ),
                );
                return;
            }
            actualCrc = crc32(chunk, actualCrc);
            callback(null, chunk);
        },
    });
    const destinationStream = destination
        ? createWriteStream(destination, { flags: "wx", mode: 0o600 })
        : new Writable({
              write(_value, _encoding, callback) {
                  callback();
              },
          });
    try {
        await pipeline(stream, validator, destinationStream, { signal });
    } catch (error) {
        if (destination) await rm(destination, { force: true });
        throw error;
    }
    if (actualSize !== entry.uncompressedSize) {
        if (destination) await rm(destination, { force: true });
        throw new Error(`ZIP entry size mismatch: ${entry.fileName}`);
    }
    if (actualCrc >>> 0 !== entry.crc32 >>> 0) {
        if (destination) await rm(destination, { force: true });
        throw new Error(`ZIP entry CRC mismatch: ${entry.fileName}`);
    }
}

async function scanZip(
    input: ToolInput,
    options: {
        extractRoot?: string;
        verifyData: boolean;
        signal: AbortSignal;
        progress: (percent: number) => void;
    },
) {
    await regularInput(input);
    const zip = await openZip(input.path);
    if (zip.entryCount > MAX_ENTRIES) {
        zip.close();
        throw new Error(`ZIP has more than ${MAX_ENTRIES} entries`);
    }
    const entries: ZipEntryInfo[] = [];
    const seen = new Map<string, "file" | "directory">();
    let expandedBytes = 0;
    let completed = 0;
    return await new Promise<ZipEntryInfo[]>((resolveScan, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            try {
                zip.close();
            } catch {}
            reject(error);
        };
        zip.once("error", fail);
        zip.once("end", () => {
            if (settled) return;
            settled = true;
            options.progress(100);
            resolveScan(entries);
        });
        zip.on("entry", (entry) => {
            void (async () => {
                throwIfAborted(options.signal);
                if (entry.generalPurposeBitFlag & 1)
                    throw new Error(
                        `Encrypted ZIP entries are unavailable: ${entry.fileName}`,
                    );
                const safe = validateZipPath(entry.fileName);
                validateZipEntryType(entry, safe.directory);
                if (
                    !Number.isSafeInteger(entry.compressedSize) ||
                    !Number.isSafeInteger(entry.uncompressedSize) ||
                    entry.compressedSize < 0 ||
                    entry.uncompressedSize < 0
                )
                    throw new Error(
                        `Invalid ZIP entry size: ${entry.fileName}`,
                    );
                expandedBytes += entry.uncompressedSize;
                if (expandedBytes > MAX_EXPANDED_BYTES)
                    throw new Error("ZIP expanded size exceeds 256 MiB");
                if (
                    entry.uncompressedSize > 1024 * 1024 &&
                    (entry.compressedSize === 0 ||
                        entry.uncompressedSize / entry.compressedSize >
                            MAX_COMPRESSION_RATIO)
                )
                    throw new Error(
                        `ZIP compression ratio is unsafe: ${entry.fileName}`,
                    );
                const canonical = safe.normalized
                    .normalize("NFC")
                    .toLowerCase();
                if (seen.has(canonical))
                    throw new Error(`Duplicate ZIP entry: ${entry.fileName}`);
                for (const [known, knownType] of seen) {
                    if (
                        (canonical.startsWith(`${known}/`) &&
                            knownType === "file") ||
                        (!safe.directory && known.startsWith(`${canonical}/`))
                    )
                        throw new Error(
                            `ZIP file/directory collision: ${entry.fileName}`,
                        );
                }
                seen.set(canonical, safe.directory ? "directory" : "file");
                entries.push({
                    path: safe.normalized,
                    directory: safe.directory,
                    compressedSize: entry.compressedSize,
                    uncompressedSize: entry.uncompressedSize,
                    crc32: entry.crc32 >>> 0,
                });
                if (options.extractRoot) {
                    const parentSegments = safe.directory
                        ? safe.segments
                        : safe.segments.slice(0, -1);
                    await ensureDirectoryChain(
                        options.extractRoot,
                        parentSegments,
                    );
                    if (!safe.directory) {
                        const destination = outputPath(
                            options.extractRoot,
                            ...safe.segments,
                        );
                        await verifyOrExtractEntry(
                            zip,
                            entry,
                            destination,
                            options.signal,
                        );
                    }
                } else if (options.verifyData && !safe.directory) {
                    await verifyOrExtractEntry(
                        zip,
                        entry,
                        undefined,
                        options.signal,
                    );
                }
                completed += 1;
                options.progress(
                    zip.entryCount ? (completed / zip.entryCount) * 100 : 100,
                );
                zip.readEntry();
            })().catch(fail);
        });
        zip.readEntry();
    });
}

export type CreationEntry = {
    path: string;
    directory: boolean;
    sourcePath?: string;
    size: number;
    crc32?: number;
};

async function collectCreationEntries(
    inputs: ToolInput[],
    signal: AbortSignal,
) {
    const entries: CreationEntry[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const add = (entry: CreationEntry) => {
        if (entries.length >= MAX_ENTRIES)
            throw new Error(`Archive creation exceeds ${MAX_ENTRIES} entries`);
        const pathForValidation = entry.directory
            ? `${entry.path}/`
            : entry.path;
        validateZipPath(pathForValidation);
        const canonical = entry.path.normalize("NFC").toLowerCase();
        if (seen.has(canonical))
            throw new Error(`Duplicate archive creation path: ${entry.path}`);
        for (const known of seen) {
            const knownEntry = entries.find(
                (candidate) =>
                    candidate.path.normalize("NFC").toLowerCase() === known,
            );
            if (
                (canonical.startsWith(`${known}/`) && !knownEntry?.directory) ||
                (!entry.directory && known.startsWith(`${canonical}/`))
            )
                throw new Error(
                    `Archive creation file/directory collision: ${entry.path}`,
                );
        }
        seen.add(canonical);
        totalBytes += entry.size;
        if (totalBytes > MAX_EXPANDED_BYTES)
            throw new Error("Archive creation exceeds 256 MiB");
        entries.push(entry);
    };
    const walk = async (sourcePath: string, archivePath: string) => {
        throwIfAborted(signal);
        const info = await lstat(sourcePath);
        if (info.isSymbolicLink())
            throw new Error(
                `Archive creation rejects symlinks: ${archivePath}`,
            );
        if (info.isDirectory()) {
            add({ path: archivePath, directory: true, size: 0 });
            const children = await readdir(sourcePath, { withFileTypes: true });
            children.sort((a, b) => a.name.localeCompare(b.name));
            for (const child of children) {
                if (child.isSymbolicLink())
                    throw new Error(
                        `Archive creation rejects symlinks: ${archivePath}/${child.name}`,
                    );
                await walk(
                    join(sourcePath, child.name),
                    `${archivePath}/${safeOutputName(child.name)}`,
                );
            }
            return;
        }
        if (!info.isFile())
            throw new Error(
                `Archive creation accepts only regular files and directories: ${archivePath}`,
            );
        add({
            path: archivePath,
            directory: false,
            sourcePath,
            size: info.size,
        });
    };
    for (const input of inputs)
        await walk(input.path, safeOutputName(basename(input.path)));
    return entries;
}

async function crcFile(path: string, signal: AbortSignal) {
    let checksum = 0;
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const value of createReadStream(path)) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_EXPANDED_BYTES)
            throw new Error("Archive source exceeds 256 MiB");
        checksum = crc32(chunk, checksum);
        hash.update(chunk);
    }
    return { checksum: checksum >>> 0, bytes, hash: hash.digest("hex") };
}

async function writeFileToHandle(
    handle: Awaited<ReturnType<typeof open>>,
    sourcePath: string,
    signal: AbortSignal,
) {
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const value of createReadStream(sourcePath)) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        hash.update(chunk);
        await handle.write(chunk);
    }
    return { bytes, hash: hash.digest("hex") };
}

export async function createZipArchive(
    entries: CreationEntry[],
    output: string,
    signal: AbortSignal,
    progress: (percent: number) => void,
) {
    const handle = await open(output, "wx", 0o600);
    const central: Buffer[] = [];
    let offset = 0;
    try {
        for (const [index, entry] of entries.entries()) {
            throwIfAborted(signal);
            const name = Buffer.from(
                entry.directory ? `${entry.path}/` : entry.path,
                "utf8",
            );
            const checked = entry.directory
                ? { checksum: 0, bytes: 0, hash: "" }
                : await crcFile(entry.sourcePath!, signal);
            if (checked.bytes !== entry.size)
                throw new Error(
                    `Archive source changed while reading: ${entry.path}`,
                );
            entry.crc32 = checked.checksum;
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x0800, 6);
            local.writeUInt32LE(checked.checksum, 14);
            local.writeUInt32LE(checked.bytes, 18);
            local.writeUInt32LE(checked.bytes, 22);
            local.writeUInt16LE(name.length, 26);
            await handle.write(local);
            await handle.write(name);
            if (!entry.directory) {
                const written = await writeFileToHandle(
                    handle,
                    entry.sourcePath!,
                    signal,
                );
                if (
                    written.bytes !== checked.bytes ||
                    written.hash !== checked.hash
                )
                    throw new Error(
                        `Archive source changed while writing: ${entry.path}`,
                    );
            }
            const record = Buffer.alloc(46);
            record.writeUInt32LE(0x02014b50, 0);
            record.writeUInt16LE(0x0314, 4);
            record.writeUInt16LE(20, 6);
            record.writeUInt16LE(0x0800, 8);
            record.writeUInt32LE(checked.checksum, 16);
            record.writeUInt32LE(checked.bytes, 20);
            record.writeUInt32LE(checked.bytes, 24);
            record.writeUInt16LE(name.length, 28);
            record.writeUInt32LE(
                ((entry.directory ? 0o040755 : 0o100644) << 16) >>> 0,
                38,
            );
            record.writeUInt32LE(offset, 42);
            central.push(record, name);
            offset += local.length + name.length + checked.bytes;
            progress(((index + 0.5) / entries.length) * 100);
        }
        const centralOffset = offset;
        for (const value of central) {
            await handle.write(value);
            offset += value.length;
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(entries.length, 8);
        end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(offset - centralOffset, 12);
        end.writeUInt32LE(centralOffset, 16);
        await handle.write(end);
    } finally {
        await handle.close();
    }
    const verified = await scanZip(
        {
            id: output,
            name: basename(output),
            path: output,
            size: (await stat(output)).size,
            extension: "zip",
            kind: "archive",
        },
        { verifyData: true, signal, progress },
    );
    const expected = entries.map((entry) => ({
        path: entry.path,
        directory: entry.directory,
        size: entry.size,
        crc32: entry.crc32 ?? 0,
    }));
    const actual = verified.map((entry) => ({
        path: entry.path,
        directory: entry.directory,
        size: entry.uncompressedSize,
        crc32: entry.crc32,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error("Created ZIP did not match its source manifest");
}

function writeTarOctal(
    buffer: Buffer,
    offset: number,
    length: number,
    value: number,
) {
    const octal = value.toString(8);
    if (octal.length > length - 1)
        throw new Error("USTAR numeric field overflow");
    buffer.write(
        `${octal.padStart(length - 1, "0")}\0`,
        offset,
        length,
        "ascii",
    );
}

function tarPathFields(value: string) {
    const encoded = Buffer.from(value);
    if (encoded.length <= 100)
        return { name: encoded, prefix: Buffer.alloc(0) };
    for (
        let index = value.lastIndexOf("/");
        index > 0;
        index = value.lastIndexOf("/", index - 1)
    ) {
        const prefix = Buffer.from(value.slice(0, index));
        const name = Buffer.from(value.slice(index + 1));
        if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
    }
    throw new Error(`USTAR path is longer than name/prefix fields: ${value}`);
}

function tarHeader(entry: CreationEntry) {
    const header = Buffer.alloc(512);
    const fields = tarPathFields(entry.path);
    fields.name.copy(header, 0);
    writeTarOctal(header, 100, 8, entry.directory ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.size);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.directory ? "5" : "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write("OpenCapture", 265, 11, "ascii");
    header.write("OpenCapture", 297, 11, "ascii");
    fields.prefix.copy(header, 345);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

async function createTarArchive(
    entries: CreationEntry[],
    output: string,
    signal: AbortSignal,
    progress: (percent: number) => void,
) {
    const handle = await open(output, "wx", 0o600);
    try {
        for (const [index, entry] of entries.entries()) {
            throwIfAborted(signal);
            await handle.write(tarHeader(entry));
            if (!entry.directory) {
                const checked = await fileHash(entry.sourcePath!, signal);
                if (checked.bytes !== entry.size)
                    throw new Error(
                        `Archive source changed before writing: ${entry.path}`,
                    );
                const written = await writeFileToHandle(
                    handle,
                    entry.sourcePath!,
                    signal,
                );
                if (
                    written.bytes !== checked.bytes ||
                    written.hash !== checked.hash
                )
                    throw new Error(
                        `Archive source changed while writing: ${entry.path}`,
                    );
                const padding = (512 - (written.bytes % 512)) % 512;
                if (padding) await handle.write(Buffer.alloc(padding));
            }
            progress(((index + 1) / entries.length) * 100);
        }
        await handle.write(Buffer.alloc(1024));
    } finally {
        await handle.close();
    }
    const verified = await scanTar(
        {
            id: output,
            name: basename(output),
            path: output,
            size: (await stat(output)).size,
            extension: "tar",
            kind: "archive",
        },
        { verifyData: true, signal, progress },
    );
    const expected = entries.map((entry) => ({
        path: entry.path,
        directory: entry.directory,
        size: entry.size,
    }));
    const actual = verified.map((entry) => ({
        path: entry.path,
        directory: entry.directory,
        size: entry.uncompressedSize,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error("Created TAR did not match its source manifest");
}

function parseTarOctal(buffer: Buffer, offset: number, length: number) {
    const raw = buffer
        .subarray(offset, offset + length)
        .toString("ascii")
        .replace(/\0.*$/s, "")
        .trim();
    if (!raw) return 0;
    if (!/^[0-7]+$/.test(raw)) throw new Error("Invalid USTAR octal field");
    const value = Number.parseInt(raw, 8);
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid USTAR numeric value");
    return value;
}

function decodeTarText(buffer: Buffer, offset: number, length: number) {
    const field = buffer.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return new TextDecoder("utf-8", { fatal: true }).decode(
        end === -1 ? field : field.subarray(0, end),
    );
}

async function readExactly(
    handle: Awaited<ReturnType<typeof open>>,
    length: number,
    position: number,
) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const result = await handle.read(
            buffer,
            offset,
            length - offset,
            position + offset,
        );
        if (!result.bytesRead) throw new Error("Truncated USTAR archive");
        offset += result.bytesRead;
    }
    return buffer;
}

async function copyTarPayload(
    handle: Awaited<ReturnType<typeof open>>,
    position: number,
    size: number,
    destination: string | undefined,
    signal: AbortSignal,
) {
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let copied = 0;
    try {
        if (destination) output = await open(destination, "wx", 0o600);
        while (copied < size) {
            throwIfAborted(signal);
            const length = Math.min(64 * 1024, size - copied);
            const chunk = await readExactly(handle, length, position + copied);
            if (output) await output.write(chunk);
            copied += chunk.length;
        }
    } catch (error) {
        if (destination) await rm(destination, { force: true });
        throw error;
    } finally {
        await output?.close();
    }
}

async function scanTar(
    input: ToolInput,
    options: {
        extractRoot?: string;
        verifyData: boolean;
        signal: AbortSignal;
        progress: (percent: number) => void;
    },
) {
    const inputInfo = await regularInput(input);
    const handle = await open(input.path, "r");
    const entries: ZipEntryInfo[] = [];
    const seen = new Map<string, "file" | "directory">();
    let position = 0;
    let expandedBytes = 0;
    let zeroBlocks = 0;
    try {
        while (position < inputInfo.size) {
            throwIfAborted(options.signal);
            const header = await readExactly(handle, 512, position);
            position += 512;
            if (header.every((byte) => byte === 0)) {
                zeroBlocks += 1;
                if (zeroBlocks >= 2) {
                    while (position < inputInfo.size) {
                        const trailing = await readExactly(
                            handle,
                            Math.min(512, inputInfo.size - position),
                            position,
                        );
                        if (!trailing.every((byte) => byte === 0))
                            throw new Error("USTAR has non-zero trailing data");
                        position += trailing.length;
                    }
                    break;
                }
                continue;
            }
            if (zeroBlocks)
                throw new Error("USTAR has data after an end marker");
            if (entries.length >= MAX_ENTRIES)
                throw new Error(`USTAR has more than ${MAX_ENTRIES} entries`);
            const storedChecksum = parseTarOctal(header, 148, 8);
            const checksumHeader = Buffer.from(header);
            checksumHeader.fill(0x20, 148, 156);
            const calculatedChecksum = checksumHeader.reduce(
                (total, byte) => total + byte,
                0,
            );
            if (storedChecksum !== calculatedChecksum)
                throw new Error("USTAR header checksum mismatch");
            const magic = header.subarray(257, 263).toString("ascii");
            const version = header.subarray(263, 265).toString("ascii");
            if (magic !== "ustar\0" || version !== "00")
                throw new Error(
                    "Only POSIX USTAR archives are supported; GNU, PAX, and legacy TAR are unavailable",
                );
            const type = String.fromCharCode(header[156] || 0x30);
            if (type !== "0" && type !== "5")
                throw new Error(
                    `Unsupported USTAR entry type ${JSON.stringify(type)}; links, devices, sparse files, and extensions are unavailable`,
                );
            const name = decodeTarText(header, 0, 100);
            const prefix = decodeTarText(header, 345, 155);
            const fullName = prefix ? `${prefix}/${name}` : name;
            const pathForValidation =
                type === "5" && !fullName.endsWith("/")
                    ? `${fullName}/`
                    : fullName;
            const safe = validateZipPath(pathForValidation);
            if (safe.directory !== (type === "5"))
                throw new Error(`USTAR entry type/path mismatch: ${fullName}`);
            const size = parseTarOctal(header, 124, 12);
            if (type === "5" && size !== 0)
                throw new Error(`USTAR directory has data: ${fullName}`);
            expandedBytes += size;
            if (expandedBytes > MAX_EXPANDED_BYTES)
                throw new Error("USTAR expanded size exceeds 256 MiB");
            const canonical = safe.normalized.normalize("NFC").toLowerCase();
            if (seen.has(canonical))
                throw new Error(`Duplicate USTAR entry: ${fullName}`);
            for (const [known, knownType] of seen)
                if (
                    (canonical.startsWith(`${known}/`) &&
                        knownType === "file") ||
                    (type !== "5" && known.startsWith(`${canonical}/`))
                )
                    throw new Error(
                        `USTAR file/directory collision: ${fullName}`,
                    );
            seen.set(canonical, type === "5" ? "directory" : "file");
            const paddedSize = Math.ceil(size / 512) * 512;
            if (position + paddedSize > inputInfo.size)
                throw new Error(`Truncated USTAR entry: ${fullName}`);
            entries.push({
                path: safe.normalized,
                directory: type === "5",
                compressedSize: size,
                uncompressedSize: size,
                crc32: 0,
            });
            if (options.extractRoot) {
                const parentSegments =
                    type === "5" ? safe.segments : safe.segments.slice(0, -1);
                await ensureDirectoryChain(options.extractRoot, parentSegments);
                if (type !== "5")
                    await copyTarPayload(
                        handle,
                        position,
                        size,
                        outputPath(options.extractRoot, ...safe.segments),
                        options.signal,
                    );
            } else if (options.verifyData && type !== "5") {
                await copyTarPayload(
                    handle,
                    position,
                    size,
                    undefined,
                    options.signal,
                );
            }
            position += paddedSize;
            options.progress((position / inputInfo.size) * 100);
        }
        if (zeroBlocks < 2)
            throw new Error("USTAR end-of-archive marker is missing");
        options.progress(100);
        return entries;
    } finally {
        await handle.close();
    }
}

function decoder(format: "gzip" | "br") {
    return format === "gzip" ? createGunzip() : createBrotliDecompress();
}

function encoder(format: "gzip" | "br") {
    return format === "gzip" ? createGzip() : createBrotliCompress();
}

async function regularInput(input: ToolInput) {
    const info = await lstat(input.path);
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Archive input is not a regular file: ${input.name}`);
    if (info.size > MAX_EXPANDED_BYTES)
        throw new Error(`Archive input exceeds 256 MiB: ${input.name}`);
    return info;
}

function boundedSink(maximum: number, onChunk?: (chunk: Buffer) => void) {
    let bytes = 0;
    return {
        stream: new Writable({
            write(value, _encoding, callback) {
                const chunk = Buffer.isBuffer(value)
                    ? value
                    : Buffer.from(value);
                bytes += chunk.length;
                if (bytes > maximum) {
                    callback(new Error("Expanded archive exceeds 256 MiB"));
                    return;
                }
                onChunk?.(chunk);
                callback();
            },
        }),
        bytes: () => bytes,
    };
}

async function decodedHash(
    archivePath: string,
    format: "gzip" | "br",
    signal: AbortSignal,
) {
    const hash = createHash("sha256");
    const sink = boundedSink(MAX_EXPANDED_BYTES, (chunk) => hash.update(chunk));
    await pipeline(
        createReadStream(archivePath),
        decoder(format),
        sink.stream,
        {
            signal,
        },
    );
    return { hash: hash.digest("hex"), bytes: sink.bytes() };
}

async function fileHash(path: string, signal: AbortSignal) {
    const hash = createHash("sha256");
    const sink = boundedSink(MAX_EXPANDED_BYTES, (chunk) => hash.update(chunk));
    await pipeline(createReadStream(path), sink.stream, { signal });
    return { hash: hash.digest("hex"), bytes: sink.bytes() };
}

function archiveStem(input: ToolInput) {
    return safeOutputName(
        basename(input.path)
            .replace(/\.tar\.(?:gz|gzip|br)$/i, "")
            .replace(/\.(?:zip|tar|tgz|gz|gzip|br)$/i, ""),
    );
}

async function toolInput(path: string, extension?: string): Promise<ToolInput> {
    const info = await stat(path);
    const name = basename(path);
    return {
        id: path,
        name,
        path,
        size: info.size,
        extension: extension ?? name.split(".").at(-1) ?? "",
        kind: info.isDirectory() ? "folder" : "other",
    };
}

async function extractForRepack(
    input: ToolInput,
    temporaryRoot: string,
    signal: AbortSignal,
    progress: (percent: number) => void,
) {
    const format = archiveFormat(input);
    if (!format) return [input];
    const membersRoot = outputPath(temporaryRoot, "members");
    await mkdir(membersRoot);
    if (format === "zip") {
        await scanZip(input, {
            extractRoot: membersRoot,
            verifyData: true,
            signal,
            progress,
        });
    } else if (format === "tar") {
        await scanTar(input, {
            extractRoot: membersRoot,
            verifyData: true,
            signal,
            progress,
        });
    } else if (format === "targzip" || format === "tarbr") {
        const tarPath = outputPath(temporaryRoot, "source.tar");
        await decompressStream(
            input,
            format === "targzip" ? "gzip" : "br",
            tarPath,
            signal,
        );
        await scanTar(await toolInput(tarPath, "tar"), {
            extractRoot: membersRoot,
            verifyData: true,
            signal,
            progress,
        });
    } else {
        const memberName = safeOutputName(
            basename(input.path).replace(/\.(?:gz|gzip|br)$/i, ""),
        );
        await decompressStream(
            input,
            format,
            outputPath(membersRoot, memberName),
            signal,
        );
    }
    const children = await readdir(membersRoot);
    return await Promise.all(
        children.map((name) => toolInput(join(membersRoot, name))),
    );
}

async function compressFileVerified(
    sourcePath: string,
    output: string,
    format: "gzip" | "br",
    signal: AbortSignal,
) {
    try {
        await pipeline(
            createReadStream(sourcePath),
            encoder(format),
            createWriteStream(output, { flags: "wx", mode: 0o600 }),
            { signal },
        );
        const [source, decoded] = await Promise.all([
            fileHash(sourcePath, signal),
            decodedHash(output, format, signal),
        ]);
        if (source.bytes !== decoded.bytes || source.hash !== decoded.hash)
            throw new Error("Compressed output verification failed");
    } catch (error) {
        await rm(output, { force: true });
        throw error;
    }
}

async function compressFiles(context: ToolContext, outputRoot: string) {
    if (!context.inputs.length)
        throw new Error("Select one or more files to compress");
    const requestedFormat = context.options.format?.toLowerCase() ?? "gz";
    if (!["zip", "tar", "gz", "gzip", "br"].includes(requestedFormat))
        throw new Error(
            `Unsupported archive compression format: ${requestedFormat}`,
        );
    const targetFormat = (
        requestedFormat === "gz" ? "gzip" : requestedFormat
    ) as "zip" | "tar" | "gzip" | "br";
    const directStream =
        (targetFormat === "gzip" || targetFormat === "br") &&
        context.inputs.length === 1 &&
        archiveFormat(context.inputs[0]) === null &&
        (await lstat(context.inputs[0].path)).isFile();
    const baseName =
        context.inputs.length === 1
            ? archiveStem(context.inputs[0])
            : "archive";
    if (directStream) {
        await regularInput(context.inputs[0]);
        const suffix = targetFormat === "gzip" ? ".gz" : ".br";
        const output = await uniqueOutputPath(
            outputRoot,
            `${safeOutputName(basename(context.inputs[0].path))}${suffix}`,
            new Set(),
        );
        await compressFileVerified(
            context.inputs[0].path,
            output,
            targetFormat,
            context.signal,
        );
        context.progress(100);
        return [output];
    }

    const temporaryRoot = outputPath(
        outputRoot,
        `.archive-repack-${randomUUID()}`,
    );
    await mkdir(temporaryRoot);
    try {
        const creationInputs =
            context.inputs.length === 1 && archiveFormat(context.inputs[0])
                ? await extractForRepack(
                      context.inputs[0],
                      temporaryRoot,
                      context.signal,
                      context.progress,
                  )
                : context.inputs;
        const entries = await collectCreationEntries(
            creationInputs,
            context.signal,
        );
        let outputName: string;
        if (targetFormat === "zip") outputName = `${baseName}.zip`;
        else if (targetFormat === "tar") outputName = `${baseName}.tar`;
        else
            outputName = `${baseName}.tar.${targetFormat === "gzip" ? "gz" : "br"}`;
        const output = await uniqueOutputPath(
            outputRoot,
            outputName,
            new Set(),
        );
        try {
            if (targetFormat === "zip")
                await createZipArchive(
                    entries,
                    output,
                    context.signal,
                    context.progress,
                );
            else if (targetFormat === "tar")
                await createTarArchive(
                    entries,
                    output,
                    context.signal,
                    context.progress,
                );
            else {
                const tarPath = outputPath(temporaryRoot, "payload.tar");
                await createTarArchive(
                    entries,
                    tarPath,
                    context.signal,
                    context.progress,
                );
                await compressFileVerified(
                    tarPath,
                    output,
                    targetFormat,
                    context.signal,
                );
            }
            return [output];
        } catch (error) {
            await rm(output, { force: true });
            throw error;
        }
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function decompressStream(
    input: ToolInput,
    format: "gzip" | "br",
    output: string,
    signal: AbortSignal,
) {
    await regularInput(input);
    let expanded = 0;
    const limiter = new Transform({
        transform(value, _encoding, callback) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            expanded += chunk.length;
            callback(
                expanded > MAX_EXPANDED_BYTES
                    ? new Error("Expanded archive exceeds 256 MiB")
                    : null,
                chunk,
            );
        },
    });
    try {
        await pipeline(
            createReadStream(input.path),
            decoder(format),
            limiter,
            createWriteStream(output, { flags: "wx", mode: 0o600 }),
            { signal },
        );
    } catch (error) {
        await rm(output, { force: true });
        throw error;
    }
    return expanded;
}

async function writeReport(outputRoot: string, name: string, value: unknown) {
    const target = outputPath(outputRoot, name);
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
    });
    return target;
}

async function withTarInput<T>(
    input: ToolInput,
    format: "tar" | "targzip" | "tarbr",
    outputRoot: string,
    signal: AbortSignal,
    runWithTar: (tar: ToolInput) => Promise<T>,
) {
    if (format === "tar") return await runWithTar(input);
    const temporary = outputPath(outputRoot, `.tar-source-${randomUUID()}.tar`);
    try {
        await decompressStream(
            input,
            format === "targzip" ? "gzip" : "br",
            temporary,
            signal,
        );
        return await runWithTar(await toolInput(temporary, "tar"));
    } finally {
        await rm(temporary, { force: true });
    }
}

async function run(context: ToolContext): Promise<ToolEngineResult> {
    const outputRoot = await ensureOutputRoot(context.outputDir);
    throwIfAborted(context.signal);
    if (context.recipe === "archive-compress")
        return { paths: await compressFiles(context, outputRoot) };
    if (context.inputs.length !== 1)
        throw new Error("This archive operation requires exactly one input");
    const input = context.inputs[0];
    const format = archiveFormat(input);
    if (!format) throw new Error(unavailableReason(input));
    await regularInput(input);

    if (context.recipe === "archive-extract") {
        if (format === "zip") {
            const stem = safeOutputName(
                basename(input.path, extname(input.path)),
            );
            const extractRoot = outputPath(outputRoot, `${stem}-extracted`);
            await mkdir(extractRoot, { recursive: false });
            await scanZip(input, {
                extractRoot,
                verifyData: true,
                signal: context.signal,
                progress: context.progress,
            });
            return { paths: [extractRoot] };
        }
        if (format === "tar" || format === "targzip" || format === "tarbr") {
            const extractRoot = outputPath(
                outputRoot,
                `${archiveStem(input)}-extracted`,
            );
            await mkdir(extractRoot, { recursive: false });
            await withTarInput(
                input,
                format,
                outputRoot,
                context.signal,
                async (tar) =>
                    await scanTar(tar, {
                        extractRoot,
                        verifyData: true,
                        signal: context.signal,
                        progress: context.progress,
                    }),
            );
            return { paths: [extractRoot] };
        }
        const suffix = format === "gzip" ? /\.(?:gz|gzip)$/i : /\.br$/i;
        const requested = safeOutputName(
            basename(input.path).replace(suffix, ""),
        );
        const output = await uniqueOutputPath(outputRoot, requested, new Set());
        await decompressStream(input, format, output, context.signal);
        context.progress(100);
        return { paths: [output] };
    }

    if (context.recipe === "archive-inspect") {
        let value: unknown;
        if (format === "zip")
            value = {
                format: "zip",
                source: input.name,
                entries: await scanZip(input, {
                    verifyData: false,
                    signal: context.signal,
                    progress: context.progress,
                }),
            };
        else if (format === "tar" || format === "targzip" || format === "tarbr")
            value = {
                format,
                source: input.name,
                entries: await withTarInput(
                    input,
                    format,
                    outputRoot,
                    context.signal,
                    async (tar) =>
                        await scanTar(tar, {
                            verifyData: false,
                            signal: context.signal,
                            progress: context.progress,
                        }),
                ),
            };
        else
            value = {
                format,
                source: input.name,
                compressedBytes: (await stat(input.path)).size,
            };
        return {
            paths: [
                await writeReport(outputRoot, "archive-inspection.json", value),
            ],
        };
    }

    if (context.recipe === "archive-test") {
        let detail: unknown;
        if (
            format === "zip" ||
            format === "tar" ||
            format === "targzip" ||
            format === "tarbr"
        ) {
            const entries =
                format === "zip"
                    ? await scanZip(input, {
                          verifyData: true,
                          signal: context.signal,
                          progress: context.progress,
                      })
                    : await withTarInput(
                          input,
                          format,
                          outputRoot,
                          context.signal,
                          async (tar) =>
                              await scanTar(tar, {
                                  verifyData: true,
                                  signal: context.signal,
                                  progress: context.progress,
                              }),
                      );
            detail = {
                format,
                source: input.name,
                valid: true,
                entries: entries.length,
                expandedBytes: entries.reduce(
                    (total, entry) => total + entry.uncompressedSize,
                    0,
                ),
            };
        } else {
            const decoded = await decodedHash(
                input.path,
                format,
                context.signal,
            );
            context.progress(100);
            detail = {
                format,
                source: input.name,
                valid: true,
                expandedBytes: decoded.bytes,
                sha256: decoded.hash,
            };
        }
        return {
            paths: [await writeReport(outputRoot, "archive-test.json", detail)],
        };
    }
    throw new Error(`Unknown archive recipe: ${context.recipe}`);
}

export const archiveTools: FileToolEngine = { recipes, run };
