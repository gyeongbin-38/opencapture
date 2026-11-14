import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { Remarkable } from "remarkable";
import yauzl from "yauzl";
import type { FileToolRecipe } from "../../lib/fileTools";
import { type CreationEntry, createZipArchive } from "./fileToolsArchives";
import type { FileToolEngine, ToolContext, ToolInput } from "./fileToolsTypes";

const RECIPE = "document-text-convert";
const WARNING =
    "Only document text is retained; layout, images and advanced formatting are not preserved.";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_SPINE_ITEMS = 2_000;
const MAX_SPINE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_PARAGRAPHS = 100_000;

function abort(signal: AbortSignal) {
    if (signal.aborted)
        throw new DOMException("Operation aborted", "AbortError");
}

function extension(input: ToolInput) {
    return input.extension.toLowerCase().replace(/^\./, "");
}

function safeName(name: string) {
    const stem = basename(name, extname(name)).replace(/[<>:"/\\|?*]/g, "_");
    return (
        [...stem]
            .map((character) =>
                character.charCodeAt(0) < 32 ? "_" : character,
            )
            .join("") || "document"
    );
}

function escapeXml(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function decodeEntity(value: string) {
    const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
    };
    if (/^#x[0-9a-f]+$/i.test(value))
        return String.fromCodePoint(Number.parseInt(value.slice(2), 16));
    if (/^#\d+$/.test(value))
        return String.fromCodePoint(Number.parseInt(value.slice(1), 10));
    return named[value] ?? `&${value};`;
}

function normalizeDocumentText(value: string) {
    const normalized = value.replaceAll("\f", "\n\n");
    for (let index = 0; index < normalized.length; index++) {
        const code = normalized.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const low = normalized.charCodeAt(index + 1);
            if (!(low >= 0xdc00 && low <= 0xdfff))
                throw new Error("Document text contains an unpaired surrogate");
            index++;
            continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff)
            throw new Error("Document text contains an unpaired surrogate");
        if (
            (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
            code === 0xfffe ||
            code === 0xffff
        )
            throw new Error("Document text contains an illegal XML character");
    }
    return normalized;
}

function rejectActiveMarkup(source: string, allowHtmlDoctype = false) {
    if (/<!ENTITY\b/i.test(source))
        throw new Error("XML entities are unavailable");
    const doctypes = source.match(/<!DOCTYPE[\s\S]*?>/gi) ?? [];
    for (const declaration of doctypes) {
        if (
            !allowHtmlDoctype ||
            !/^<!doctype\s+html\s*>$/i.test(declaration) ||
            /\[|\bSYSTEM\b|\bPUBLIC\b/i.test(declaration)
        )
            throw new Error(
                "External or entity-bearing DOCTYPE is unavailable",
            );
    }
}

function attributes(value: string) {
    const result: Record<string, string> = {};
    const pattern = /([:\w.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    for (const match of value.matchAll(pattern))
        result[match[1].toLowerCase()] = match[3];
    return result;
}

function htmlParagraphs(source: string): string[] {
    const html = normalizeDocumentText(source);
    rejectActiveMarkup(html, true);
    if (/(?:src|href)\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(html))
        throw new Error(
            "External URLs are unavailable in document text conversion",
        );
    let text = "";
    let index = 0;
    let skipped = "";
    const blocks = new Set([
        "address",
        "article",
        "blockquote",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "pre",
        "section",
        "tr",
    ]);
    while (index < html.length) {
        if (html[index] !== "<") {
            const next = html.indexOf("<", index);
            const end = next < 0 ? html.length : next;
            if (!skipped)
                text += html
                    .slice(index, end)
                    .replace(/&([^;\s]{1,32});/g, (_, entity: string) =>
                        decodeEntity(entity),
                    );
            index = end;
            continue;
        }
        if (html.startsWith("<!--", index)) {
            const end = html.indexOf("-->", index + 4);
            if (end < 0) throw new Error("Unterminated HTML comment");
            index = end + 3;
            continue;
        }
        const close = html.indexOf(">", index + 1);
        if (close < 0) throw new Error("Malformed HTML tag");
        const raw = html.slice(index + 1, close).trim();
        const closing = raw.startsWith("/");
        const tag = raw
            .replace(/^\//, "")
            .split(/[\s/>]/, 1)[0]
            .toLowerCase();
        if (tag === "script" || tag === "style") {
            if (closing && skipped === tag) skipped = "";
            else if (!closing && !skipped) skipped = tag;
        } else if (
            !skipped &&
            blocks.has(tag) &&
            text &&
            !text.endsWith("\n")
        ) {
            text += "\n";
        }
        index = close + 1;
    }
    return normalizeDocumentText(text)
        .replaceAll("\r", "")
        .split(/\n+/)
        .map((line) => line.replace(/[\t ]+/g, " ").trim())
        .filter(Boolean);
}

function decodeText(path: string) {
    const initial = statSync(path);
    if (!initial.isFile() || initial.size > MAX_TEXT_BYTES)
        throw new Error("Document text exceeds the 16 MiB limit");
    const bytes = Buffer.allocUnsafe(initial.size + 1);
    const handle = openSync(path, "r");
    let length = 0;
    try {
        while (length < bytes.length) {
            const count = readSync(
                handle,
                bytes,
                length,
                bytes.length - length,
                length,
            );
            if (!count) break;
            length += count;
        }
    } finally {
        closeSync(handle);
    }
    if (length > initial.size || statSync(path).size !== length)
        throw new Error("Document text changed while it was being read");
    const bounded = bytes.subarray(0, length);
    try {
        return normalizeDocumentText(
            new TextDecoder("utf-8", { fatal: true }).decode(
                bounded.subarray(
                    bounded[0] === 0xef &&
                        bounded[1] === 0xbb &&
                        bounded[2] === 0xbf
                        ? 3
                        : 0,
                ),
            ),
        );
    } catch {
        throw new Error("Document text is not valid UTF-8");
    }
}

function textParagraphs(input: ToolInput) {
    const source = decodeText(input.path);
    const ext = extension(input);
    if (ext === "html" || ext === "htm") return htmlParagraphs(source);
    if (ext === "md" || ext === "markdown")
        return htmlParagraphs(
            new Remarkable({ html: false, typographer: false }).render(source),
        );
    return source
        .replaceAll("\r", "")
        .split(/\n{2,}/)
        .map((value) => value.trim())
        .filter(Boolean);
}

function safeZipPath(value: string) {
    let decoded: string;
    try {
        decoded = decodeURIComponent(value.split("#", 1)[0]);
    } catch {
        throw new Error(`Invalid percent-encoded EPUB path: ${value}`);
    }
    if (
        !decoded ||
        decoded.includes("\\") ||
        decoded.startsWith("/") ||
        /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    )
        throw new Error(`Unsafe EPUB path: ${value}`);
    const normalized = posix.normalize(decoded);
    if (
        decoded
            .split("/")
            .some(
                (segment) =>
                    segment === "." ||
                    segment === ".." ||
                    segment.includes(":"),
            ) ||
        normalized === ".." ||
        normalized.startsWith("../")
    )
        throw new Error(`EPUB path traversal: ${value}`);
    return normalized;
}

function readZip(path: string, signal: AbortSignal) {
    return new Promise<Map<string, Buffer>>((resolveZip, rejectZip) => {
        yauzl.open(
            path,
            {
                lazyEntries: true,
                decodeStrings: true,
                strictFileNames: true,
                validateEntrySizes: true,
            },
            (error, zip) => {
                if (error || !zip) {
                    rejectZip(error ?? new Error("Could not open EPUB"));
                    return;
                }
                if (zip.entryCount > MAX_ENTRIES) {
                    zip.close();
                    rejectZip(new Error("EPUB has more than 2000 entries"));
                    return;
                }
                const entries = new Map<string, Buffer>();
                const seen = new Set<string>();
                let expanded = 0;
                const fail = (reason: unknown) => {
                    try {
                        zip.close();
                    } catch {}
                    rejectZip(reason);
                };
                zip.on("error", fail);
                zip.on("end", () => resolveZip(entries));
                zip.on("entry", (entry) => {
                    void (async () => {
                        abort(signal);
                        if (entry.fileName.endsWith("/")) {
                            zip.readEntry();
                            return;
                        }
                        if (entry.generalPurposeBitFlag & 1)
                            throw new Error(
                                "Encrypted EPUB entries are unavailable",
                            );
                        const unixType =
                            (entry.externalFileAttributes >>> 16) &
                            0xffff &
                            0o170000;
                        if (unixType !== 0 && unixType !== 0o100000)
                            throw new Error(
                                `Unsupported EPUB entry type: ${entry.fileName}`,
                            );
                        if (
                            !Number.isSafeInteger(entry.uncompressedSize) ||
                            entry.uncompressedSize < 0
                        )
                            throw new Error("Invalid EPUB entry size");
                        const name = safeZipPath(entry.fileName);
                        const canonical = name.normalize("NFC").toLowerCase();
                        if (seen.has(canonical))
                            throw new Error(
                                `Duplicate EPUB entry: ${entry.fileName}`,
                            );
                        seen.add(canonical);
                        expanded += entry.uncompressedSize;
                        if (expanded > MAX_EXPANDED_BYTES)
                            throw new Error(
                                "EPUB expanded size exceeds 256 MiB",
                            );
                        const data = await new Promise<Buffer>(
                            (resolveData, rejectData) => {
                                zip.openReadStream(
                                    entry,
                                    (streamError, stream) => {
                                        if (streamError || !stream) {
                                            rejectData(
                                                streamError ??
                                                    new Error(
                                                        "Could not read EPUB entry",
                                                    ),
                                            );
                                            return;
                                        }
                                        const chunks: Buffer[] = [];
                                        let size = 0;
                                        stream.on("data", (chunk: Buffer) => {
                                            size += chunk.length;
                                            if (size > entry.uncompressedSize)
                                                stream.destroy(
                                                    new Error(
                                                        "EPUB entry size mismatch",
                                                    ),
                                                );
                                            else
                                                chunks.push(Buffer.from(chunk));
                                        });
                                        stream.on("error", rejectData);
                                        stream.on("end", () => {
                                            const buffer =
                                                Buffer.concat(chunks);
                                            if (
                                                buffer.length !==
                                                    entry.uncompressedSize ||
                                                crc32(buffer) >>> 0 !==
                                                    entry.crc32 >>> 0
                                            ) {
                                                rejectData(
                                                    new Error(
                                                        `EPUB entry integrity check failed: ${entry.fileName}`,
                                                    ),
                                                );
                                            } else resolveData(buffer);
                                        });
                                    },
                                );
                            },
                        );
                        entries.set(name, data);
                        zip.readEntry();
                    })().catch(fail);
                });
                zip.readEntry();
            },
        );
    });
}

function utf8(entry: Buffer | undefined, name: string) {
    if (!entry) throw new Error(`EPUB entry is missing: ${name}`);
    if (entry.length > MAX_TEXT_BYTES)
        throw new Error(`EPUB text entry exceeds 16 MiB: ${name}`);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(entry);
    } catch {
        throw new Error(`EPUB entry is not valid UTF-8: ${name}`);
    }
}

async function epubParagraphs(input: ToolInput, signal: AbortSignal) {
    const entries = await readZip(input.path, signal);
    const container = utf8(
        entries.get("META-INF/container.xml"),
        "META-INF/container.xml",
    );
    rejectActiveMarkup(container);
    const rootfile = /<(?:[\w.-]+:)?rootfile\b([^>]*)\/?\s*>/i.exec(container);
    const rootPathValue = rootfile
        ? attributes(rootfile[1])["full-path"]
        : undefined;
    if (!rootPathValue) throw new Error("EPUB container has no rootfile");
    const opfPath = safeZipPath(rootPathValue);
    const opf = utf8(entries.get(opfPath), opfPath);
    rejectActiveMarkup(opf);
    const manifest = new Map<string, string>();
    for (const match of opf.matchAll(/<(?:[\w.-]+:)?item\b([^>]*)\/?\s*>/gi)) {
        const attrs = attributes(match[1]);
        if (!attrs.id || !attrs.href) continue;
        if (manifest.has(attrs.id))
            throw new Error(`Duplicate EPUB manifest id: ${attrs.id}`);
        const localHref = safeZipPath(attrs.href);
        const href = safeZipPath(posix.join(posix.dirname(opfPath), localHref));
        manifest.set(attrs.id, href);
    }
    const order: string[] = [];
    for (const match of opf.matchAll(
        /<(?:[\w.-]+:)?itemref\b([^>]*)\/?\s*>/gi,
    )) {
        const id = attributes(match[1]).idref;
        if (!id || !manifest.has(id))
            throw new Error(
                `EPUB spine references a missing item: ${id ?? ""}`,
            );
        order.push(manifest.get(id)!);
        if (order.length > MAX_SPINE_ITEMS)
            throw new Error("EPUB spine exceeds 2000 items");
    }
    if (!order.length) throw new Error("EPUB spine is empty");
    const paragraphs: string[] = [];
    let cumulativeBytes = 0;
    for (const item of order) {
        abort(signal);
        const entry = entries.get(item);
        if (!entry) throw new Error(`EPUB entry is missing: ${item}`);
        cumulativeBytes += entry.length;
        if (cumulativeBytes > MAX_SPINE_TEXT_BYTES)
            throw new Error("EPUB spine text exceeds the 16 MiB limit");
        const next = htmlParagraphs(utf8(entry, item));
        if (paragraphs.length + next.length > MAX_PARAGRAPHS)
            throw new Error("Document text exceeds 100000 paragraphs");
        paragraphs.push(...next);
    }
    return paragraphs;
}

function validateParagraphs(paragraphs: string[]) {
    if (paragraphs.length > MAX_PARAGRAPHS)
        throw new Error("Document text exceeds 100000 paragraphs");
    let bytes = 0;
    for (const paragraph of paragraphs) {
        bytes += Buffer.byteLength(paragraph, "utf8");
        if (bytes > MAX_TEXT_BYTES)
            throw new Error("Document text exceeds the 16 MiB limit");
    }
    return paragraphs;
}

function writeStaged(work: string, archivePath: string, value: string) {
    const sourcePath = join(work, ...archivePath.split("/"));
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, value, { encoding: "utf8", flag: "wx" });
    return {
        path: archivePath,
        directory: false,
        sourcePath,
        size: statSync(sourcePath).size,
    } satisfies CreationEntry;
}

async function createDocx(
    paragraphs: string[],
    output: string,
    work: string,
    signal: AbortSignal,
) {
    const entries: CreationEntry[] = [
        writeStaged(
            work,
            "[Content_Types].xml",
            `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        ),
        writeStaged(
            work,
            "_rels/.rels",
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        ),
        writeStaged(
            work,
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`,
        ),
    ];
    await createZipArchive(entries, output, signal, () => {});
}

async function createEpub(
    paragraphs: string[],
    output: string,
    work: string,
    signal: AbortSignal,
) {
    const mimetype = writeStaged(work, "mimetype", "application/epub+zip");
    const entries: CreationEntry[] = [
        mimetype,
        writeStaged(
            work,
            "META-INF/container.xml",
            `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        ),
        writeStaged(
            work,
            "OEBPS/content.opf",
            `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${randomUUID()}</dc:identifier><dc:title>Converted document</dc:title><dc:language>und</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
        ),
        writeStaged(
            work,
            "OEBPS/chapter.xhtml",
            `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Converted document</title></head><body>${paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join("")}</body></html>`,
        ),
    ];
    await createZipArchive(entries, output, signal, () => {});
}

function outputPath(outputDir: string, name: string, format: string) {
    let index = 1;
    let target = join(outputDir, `${name}.${format}`);
    while (existsSync(target)) {
        index++;
        target = join(outputDir, `${name}-${index}.${format}`);
    }
    return target;
}

function recipes(inputs: ToolInput[]): FileToolRecipe[] {
    if (!inputs.length) return [];
    const extensions = inputs.map(extension);
    if (
        !extensions.some((value) =>
            ["txt", "md", "markdown", "html", "htm", "epub"].includes(value),
        )
    )
        return [];
    const supported = extensions.every((value) =>
        ["txt", "md", "markdown", "html", "htm", "epub"].includes(value),
    );
    const formats = extensions.every((value) => value === "epub")
        ? ["txt", "md", "html", "docx", "epub"]
        : ["docx", "epub"];
    return [
        {
            id: RECIPE,
            label: "Convert document text",
            group: "convert",
            formats: supported ? formats : undefined,
            available: supported,
            reason: supported
                ? undefined
                : "Text-only document conversion supports TXT, Markdown, HTML and EPUB inputs.",
        },
    ];
}

export const documentTools: FileToolEngine = {
    recipes,
    async run(context) {
        if (context.recipe !== RECIPE)
            throw new Error(`Unknown recipe: ${context.recipe}`);
        const format = context.options.format?.toLowerCase();
        if (!format) throw new Error("An output format is required");
        const available = recipes(context.inputs)[0];
        if (!available?.available || !available.formats?.includes(format))
            throw new Error(
                "Document text output format is unavailable for this selection",
            );
        mkdirSync(context.outputDir, { recursive: true });
        const paths: string[] = [];
        for (const [index, input] of context.inputs.entries()) {
            abort(context.signal);
            const paragraphs = validateParagraphs(
                extension(input) === "epub"
                    ? await epubParagraphs(input, context.signal)
                    : textParagraphs(input),
            );
            const target = outputPath(
                context.outputDir,
                safeName(input.name),
                format,
            );
            if (format === "txt" || format === "md") {
                writeFileSync(target, `${paragraphs.join("\n\n")}\n`, {
                    encoding: "utf8",
                    flag: "wx",
                });
            } else if (format === "html") {
                writeFileSync(
                    target,
                    `<!doctype html><meta charset="utf-8"><body>${paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join("")}</body>`,
                    { encoding: "utf8", flag: "wx" },
                );
            } else {
                const work = join(
                    context.outputDir,
                    `.document-${randomUUID()}`,
                );
                mkdirSync(work);
                try {
                    if (format === "docx")
                        await createDocx(
                            paragraphs,
                            target,
                            work,
                            context.signal,
                        );
                    else
                        await createEpub(
                            paragraphs,
                            target,
                            work,
                            context.signal,
                        );
                } finally {
                    rmSync(work, { recursive: true, force: true });
                }
            }
            paths.push(target);
            context.progress(((index + 1) / context.inputs.length) * 100);
        }
        return { paths, warnings: [WARNING] };
    },
};
