import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import {
    type CreationEntry,
    createZipArchive,
} from "../src/main/fileToolsArchives";
import { documentTools } from "../src/main/fileToolsDocuments";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

let fixture = "";
let outputDir = "";

function hash(path: string) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "opencapture-documents-test-"));
    outputDir = join(fixture, "output");
    mkdirSync(outputDir);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function source(name: string, value: string | Buffer): ToolInput {
    const path = join(fixture, name);
    writeFileSync(path, value);
    return {
        id: name,
        name,
        path,
        size: statSync(path).size,
        extension: name.slice(name.lastIndexOf(".") + 1),
        kind: "document",
    };
}

async function run(input: ToolInput, format: string) {
    const progress: number[] = [];
    const result = await documentTools.run({
        inputs: [input],
        recipe: "document-text-convert",
        options: { format },
        outputDir,
        signal: new AbortController().signal,
        progress: (value) => progress.push(value),
    });
    return { ...result, progress };
}

function zipEntries(path: string) {
    return new Promise<
        { name: string; compressionMethod: number; data: Buffer }[]
    >((resolvePromise, rejectPromise) => {
        yauzl.open(path, { lazyEntries: true }, (error, zip) => {
            if (error || !zip) {
                rejectPromise(error);
                return;
            }
            const result: {
                name: string;
                compressionMethod: number;
                data: Buffer;
            }[] = [];
            zip.on("entry", (entry) => {
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        rejectPromise(streamError);
                        return;
                    }
                    const chunks: Buffer[] = [];
                    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                    stream.on("end", () => {
                        result.push({
                            name: entry.fileName,
                            compressionMethod: entry.compressionMethod,
                            data: Buffer.concat(chunks),
                        });
                        zip.readEntry();
                    });
                });
            });
            zip.on("end", () => resolvePromise(result));
            zip.on("error", rejectPromise);
            zip.readEntry();
        });
    });
}

async function makeEpub(
    name: string,
    files: { path: string; value: string }[],
) {
    const staging = join(fixture, `${name}-staging`);
    mkdirSync(staging);
    const entries: CreationEntry[] = [];
    for (const [index, file] of files.entries()) {
        const staged = join(staging, `file-${index}`);
        writeFileSync(staged, file.value);
        entries.push({
            path: file.path,
            directory: false,
            sourcePath: staged,
            size: statSync(staged).size,
        });
    }
    const output = join(fixture, name);
    await createZipArchive(
        entries,
        output,
        new AbortController().signal,
        () => {},
    );
    return source(name, readFileSync(output));
}

function epubFiles(opf: string, chapters: { path: string; value: string }[]) {
    return [
        { path: "mimetype", value: "application/epub+zip" },
        {
            path: "META-INF/container.xml",
            value: `<?xml version="1.0"?><container><rootfiles><rootfile full-path='OPS/content.opf'/></rootfiles></container>`,
        },
        { path: "OPS/content.opf", value: opf },
        ...chapters,
    ];
}

describe("minimal document writers", () => {
    it("creates a real DOCX package with exact Unicode paragraphs", async () => {
        const input = source(
            "notes.txt",
            "첫 문단 😀\n\nSecond <safe> paragraph",
        );
        const result = await run(input, "docx");
        const entries = await zipEntries(result.paths[0]);
        expect(entries.map((entry) => entry.name)).toEqual([
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
        ]);
        const document = entries
            .find((entry) => entry.name === "word/document.xml")!
            .data.toString("utf8");
        expect(document).toContain("첫 문단 😀");
        expect(document).toContain("Second &lt;safe&gt; paragraph");
        expect(result.warnings).toEqual([
            "Only document text is retained; layout, images and advanced formatting are not preserved.",
        ]);
        expect(result.progress).toEqual([100]);
    });

    it("creates a valid minimal EPUB with mimetype first and stored", async () => {
        const result = await run(
            source("notes.md", "# 제목\n\n본문 Unicode 😀"),
            "epub",
        );
        const entries = await zipEntries(result.paths[0]);
        expect(entries[0]).toMatchObject({
            name: "mimetype",
            compressionMethod: 0,
        });
        expect(entries[0].data.toString()).toBe("application/epub+zip");
        expect(entries.map((entry) => entry.name)).toEqual([
            "mimetype",
            "META-INF/container.xml",
            "OEBPS/content.opf",
            "OEBPS/chapter.xhtml",
        ]);
        expect(entries.at(-1)!.data.toString("utf8")).toContain(
            "본문 Unicode 😀",
        );
    });

    it("turns PDF page formfeeds into paragraphs and rejects illegal XML text", async () => {
        const formfeed = source(
            "pages.txt",
            "Page one 한글\fPage two 😀\fPage three",
        );
        const docx = await run(formfeed, "docx");
        const document = (await zipEntries(docx.paths[0]))
            .find((entry) => entry.name === "word/document.xml")!
            .data.toString("utf8");
        expect(document).not.toContain("\f");
        expect(document.match(/<w:p>/g)).toHaveLength(3);
        expect(document).toContain("Page one 한글");
        expect(document).toContain("Page two 😀");

        const epub = await run(formfeed, "epub");
        const chapter = (await zipEntries(epub.paths[0]))
            .find((entry) => entry.name === "OEBPS/chapter.xhtml")!
            .data.toString("utf8");
        expect(chapter.match(/<p>/g)).toHaveLength(3);
        expect(chapter).not.toContain("\f");

        await expect(
            run(source("control.html", "<p>bad &#1;</p>"), "docx"),
        ).rejects.toThrow("illegal XML character");
        await expect(
            run(source("surrogate.html", "<p>bad &#55296;</p>"), "epub"),
        ).rejects.toThrow("unpaired surrogate");
    });
});

describe("strict EPUB text extraction", () => {
    it("follows namespaced OPF spine order and preserves Unicode", async () => {
        const epub = await makeEpub(
            "ordered.epub",
            epubFiles(
                `<?xml version="1.0"?><opf:package xmlns:opf="urn:oasis:names:tc:opendocument:xmlns:opf:1.0"><opf:manifest><opf:item id='two' href='chapter%202.xhtml'/><opf:item id='one' href='chapter1.xhtml'/></opf:manifest><opf:spine><opf:itemref idref='one'/><opf:itemref idref='two'/></opf:spine></opf:package>`,
                [
                    {
                        path: "OPS/chapter 2.xhtml",
                        value: "<!DOCTYPE html><html><body><p>둘째 😀</p><script>bad()</script></body></html>",
                    },
                    {
                        path: "OPS/chapter1.xhtml",
                        value: "<!doctype html><html><body><p>First</p><style>bad{}</style></body></html>",
                    },
                ],
            ),
        );
        const result = await run(epub, "txt");
        expect(readFileSync(result.paths[0], "utf8")).toBe(
            "First\n\n둘째 😀\n",
        );
    });

    it("supports EPUB text routed into real DOCX and EPUB packages", async () => {
        const created = await run(
            source("source.txt", "One\n\nTwo 한글"),
            "epub",
        );
        const epubInput: ToolInput = {
            ...source("placeholder.epub", readFileSync(created.paths[0])),
            path: created.paths[0],
        };
        const docx = await run(epubInput, "docx");
        const docxEntries = await zipEntries(docx.paths[0]);
        expect(
            docxEntries
                .find((entry) => entry.name === "word/document.xml")!
                .data.toString("utf8"),
        ).toContain("Two 한글");
    });

    it.each([
        [
            "traversal.epub",
            `<?xml version="1.0"?><package><manifest><item id='x' href='%2e%2e/evil.xhtml'/></manifest><spine><itemref idref='x'/></spine></package>`,
            "EPUB path traversal",
        ],
        [
            "external.epub",
            `<?xml version="1.0"?><package><manifest><item id='x' href='https%3A%2F%2Fevil.example%2Fx.xhtml'/></manifest><spine><itemref idref='x'/></spine></package>`,
            "Unsafe EPUB path",
        ],
        [
            "entity.epub",
            `<?xml version="1.0"?><!DOCTYPE package [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><package><manifest/><spine/></package>`,
            "entities are unavailable",
        ],
    ])("rejects hostile OPF input %s", async (name, opf, message) => {
        const epub = await makeEpub(name, epubFiles(opf, []));
        await expect(run(epub, "txt")).rejects.toThrow(message);
    });

    it("rejects remote links in spine XHTML", async () => {
        const epub = await makeEpub(
            "remote.epub",
            epubFiles(
                `<package><manifest><item id='x' href='x.xhtml'/></manifest><spine><itemref idref='x'/></spine></package>`,
                [
                    {
                        path: "OPS/x.xhtml",
                        value: "<!doctype html><html><body><a href='https://evil.example'>remote</a></body></html>",
                    },
                ],
            ),
        );
        await expect(run(epub, "txt")).rejects.toThrow(
            "External URLs are unavailable",
        );
    });

    it("rejects duplicate case-folded ZIP entries", async () => {
        const epub = await makeEpub(
            "duplicate.epub",
            epubFiles(
                `<package><manifest><item id='a' href='A.xhtml'/><item id='b' href='b.xhtml'/></manifest><spine><itemref idref='a'/></spine></package>`,
                [
                    { path: "OPS/A.xhtml", value: "<p>A</p>" },
                    { path: "OPS/b.xhtml", value: "<p>B</p>" },
                ],
            ),
        );
        const bytes = readFileSync(epub.path);
        const original = Buffer.from("OPS/b.xhtml");
        const replacement = Buffer.from("OPS/a.xhtml");
        let offset = bytes.indexOf(original);
        while (offset >= 0) {
            replacement.copy(bytes, offset);
            offset += replacement.length;
            offset = bytes.indexOf(original, offset);
        }
        writeFileSync(epub.path, bytes);
        await expect(run(epub, "txt")).rejects.toThrow("Duplicate EPUB entry");
    });

    it("rejects a repetitive spine before cumulative text expansion", async () => {
        const repeated = Array.from(
            { length: 900 },
            () => "<itemref idref='chapter'/>",
        ).join("");
        const epub = await makeEpub(
            "repeated.epub",
            epubFiles(
                `<package><manifest><item id='chapter' href='chapter.xhtml'/></manifest><spine>${repeated}</spine></package>`,
                [
                    {
                        path: "OPS/chapter.xhtml",
                        value: `<html><body><p>${"x".repeat(20 * 1024)}</p></body></html>`,
                    },
                ],
            ),
        );
        const before = hash(epub.path);
        await expect(run(epub, "txt")).rejects.toThrow(
            "spine text exceeds the 16 MiB limit",
        );
        expect(hash(epub.path)).toBe(before);
        expect(readdirSync(outputDir)).toEqual([]);
    });
});

it("rejects oversized sparse text before allocating or writing output", async () => {
    const sparse = join(fixture, "huge.txt");
    writeFileSync(sparse, "x");
    truncateSync(sparse, 16 * 1024 * 1024 + 1);
    const input: ToolInput = {
        id: "huge",
        name: "huge.txt",
        path: sparse,
        size: statSync(sparse).size,
        extension: "txt",
        kind: "document",
    };
    const before = hash(sparse);
    await expect(run(input, "docx")).rejects.toThrow("16 MiB limit");
    expect(hash(sparse)).toBe(before);
    expect(readdirSync(outputDir)).toEqual([]);
});

it("advertises only honest text-only formats and honors pre-abort", async () => {
    const text = source("notes.txt", "hello");
    expect(documentTools.recipes([text])).toEqual([
        expect.objectContaining({
            id: "document-text-convert",
            label: "Convert document text",
            formats: ["docx", "epub"],
        }),
    ]);
    const epub = { ...text, extension: "epub", name: "book.epub" };
    expect(documentTools.recipes([epub])).toEqual([
        expect.objectContaining({
            formats: ["txt", "md", "html", "docx", "epub"],
        }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const context: ToolContext = {
        inputs: [text],
        recipe: "document-text-convert",
        options: { format: "docx" },
        outputDir,
        signal: controller.signal,
        progress: () => {},
    };
    await expect(documentTools.run(context)).rejects.toMatchObject({
        name: "AbortError",
    });
});
