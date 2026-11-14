import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRawStream,
    StandardFonts,
    decodePDFRawStream,
    degrees,
    rgb,
} from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileToolOptions } from "../lib/fileTools";
import { createPdfTools } from "../src/main/fileToolsPdf";
import type {
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "../src/main/fileToolsTypes";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(
        roots
            .splice(0)
            .map((root) => rm(root, { recursive: true, force: true })),
    );
});

async function fixtureRoot() {
    const root = await mkdtemp(join(tmpdir(), "opencapture-pdf-"));
    roots.push(root);
    return root;
}

function source(path: string): ToolInput {
    return {
        id: path,
        name: path.split(/[\\/]/).at(-1) ?? "source.pdf",
        path,
        size: 0,
        extension: "pdf",
        kind: "pdf",
    };
}

async function operation(
    root: string,
    inputs: ToolInput[],
    recipe: string,
    options: FileToolOptions = {},
    signal = new AbortController().signal,
) {
    const outputDir = join(root, `output-${recipe}-${Math.random()}`);
    await mkdir(outputDir);
    return {
        inputs,
        recipe,
        options,
        outputDir,
        signal,
        progress: vi.fn(),
    } satisfies ToolContext;
}

async function makePdf(path: string, pageCount: number, metadata = false) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < pageCount; index += 1) {
        const page = document.addPage([200 + index * 37, 300 + index * 29]);
        page.drawRectangle({
            x: 0,
            y: 0,
            width: page.getWidth(),
            height: page.getHeight(),
            color: rgb((index + 1) / (pageCount + 1), 0.25, 0.7),
        });
        page.drawText(`PAGE-${index + 1}`, {
            x: 24,
            y: 40,
            size: 18,
            font,
            color: rgb(1, 1, 1),
        });
        page.setRotation(degrees((index * 90) % 360));
    }
    if (metadata) {
        document.setTitle("Private title");
        document.setAuthor("Private author");
        document.setSubject("Private subject");
        document.setKeywords(["private", "keyword"]);
        document.setProducer("Private producer");
        document.setCreator("Private creator");
        document.setCreationDate(new Date("2020-01-02T03:04:05Z"));
        document.setModificationDate(new Date("2021-02-03T04:05:06Z"));
    }
    await writeFile(path, await document.save({ useObjectStreams: false }));
}

async function load(path: string) {
    return await PDFDocument.load(await readFile(path), {
        updateMetadata: false,
        ignoreEncryption: false,
    });
}

async function addSecretMetadata(path: string) {
    const document = await load(path);
    const infoRef = document.context.trailerInfo.Info;
    const info = infoRef
        ? document.context.lookup(infoRef, PDFDict)
        : undefined;
    info?.set(
        PDFName.of("CustomSecret"),
        PDFHexString.fromText("CUSTOM_INFO_SECRET_8D52"),
    );
    const catalogXmp = document.context.flateStream(
        Buffer.from("<xmp>COMPRESSED_XMP_SECRET_91AF</xmp>"),
        { Type: "Metadata", Subtype: "XML" },
    );
    document.catalog.set(
        PDFName.of("Metadata"),
        document.context.register(catalogXmp),
    );
    const pageXmp = document.context.stream(
        Buffer.from("<xmp>PAGE_XMP_SECRET_41CE</xmp>"),
        { Type: "Metadata", Subtype: "XML" },
    );
    document
        .getPage(0)
        .node.set(PDFName.of("Metadata"), document.context.register(pageXmp));
    document.context.register(
        document.context.stream(
            Buffer.from("<xmp>ORPHAN_XMP_SECRET_772B</xmp>"),
            { Type: "Metadata", Subtype: "XML" },
        ),
    );
    await writeFile(path, await document.save({ useObjectStreams: false }));
}

function digest(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
}

function tools(
    render?: (
        input: Parameters<Parameters<typeof createPdfTools>[0]["render"]>[0],
    ) => Promise<ToolEngineResult>,
) {
    return createPdfTools({
        render:
            render ??
            (async () => {
                throw new Error("Renderer should not be called");
            }),
    });
}

describe("createPdfTools recipes", () => {
    it("publishes truthful single and multiple PDF recipes", async () => {
        const one = source("one.pdf");
        const recipes = await tools().recipes([one]);
        expect(recipes.map((recipe) => recipe.id)).toEqual([
            "pdf-convert",
            "pdf-split",
            "pdf-organize",
            "pdf-merge",
            "pdf-remove-metadata",
            "pdf-compress",
        ]);
        expect(
            recipes.find((recipe) => recipe.id === "pdf-convert"),
        ).toMatchObject({
            available: true,
            formats: ["png", "jpg", "txt", "md"],
        });
        expect(
            recipes.find((recipe) => recipe.id === "pdf-merge"),
        ).toMatchObject({
            available: false,
            multiple: true,
        });
        const multiple = await tools().recipes([one, source("two.pdf")]);
        expect(
            multiple.find((recipe) => recipe.id === "pdf-merge"),
        ).toMatchObject({
            available: true,
        });
    });
});

describe("createPdfTools structural operations", () => {
    it("splits a normalized page selection into genuine one-page PDFs", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 3);
        const result = await tools().run(
            await operation(root, [source(path)], "pdf-split", {
                pages: "3-1,2",
            }),
        );
        expect(result.paths).toHaveLength(3);
        for (const [index, output] of result.paths.entries()) {
            const document = await load(output);
            expect(document.getPageCount()).toBe(1);
            expect(document.getPage(0).getWidth()).toBe(200 + index * 37);
            expect(document.getPage(0).node.Contents()).toBeDefined();
        }
    });

    it("organizes duplicate pages in requested order and adds rotation", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 3);
        const before = await readFile(path);
        const result = await tools().run(
            await operation(root, [source(path)], "pdf-organize", {
                pages: "3,1,3",
                angle: 90,
            }),
        );
        const document = await load(result.paths[0]);
        expect(document.getPages().map((page) => page.getWidth())).toEqual([
            274, 200, 274,
        ]);
        expect(
            document.getPages().map((page) => page.getRotation().angle),
        ).toEqual([270, 90, 270]);
        expect(document.getPages().every((page) => page.node.Contents())).toBe(
            true,
        );
        expect(digest(await readFile(path))).toBe(digest(before));
    });

    it("merges PDFs in source and page order", async () => {
        const root = await fixtureRoot();
        const first = join(root, "first.pdf");
        const second = join(root, "second.pdf");
        await makePdf(first, 2);
        await makePdf(second, 1);
        const result = await tools().run(
            await operation(root, [source(first), source(second)], "pdf-merge"),
        );
        const document = await load(result.paths[0]);
        expect(document.getPages().map((page) => page.getWidth())).toEqual([
            200, 237, 200,
        ]);
    });

    it("removes document info and XMP metadata without flattening pages", async () => {
        const root = await fixtureRoot();
        const path = join(root, "metadata.pdf");
        await makePdf(path, 2, true);
        await addSecretMetadata(path);
        const result = await tools().run(
            await operation(root, [source(path)], "pdf-remove-metadata"),
        );
        const document = await load(result.paths[0]);
        expect(document.context.trailerInfo.Info).toBeUndefined();
        expect(document.getTitle()).toBeUndefined();
        expect(document.getAuthor()).toBeUndefined();
        expect(document.getSubject()).toBeUndefined();
        expect(document.getKeywords()).toBeUndefined();
        expect(document.getProducer()).toBeUndefined();
        expect(document.getCreator()).toBeUndefined();
        expect(document.getCreationDate()).toBeUndefined();
        expect(document.getModificationDate()).toBeUndefined();
        expect(document.getPageCount()).toBe(2);
        expect(document.getPages().every((page) => page.node.Contents())).toBe(
            true,
        );
        expect(document.catalog.get(PDFName.of("Metadata"))).toBeUndefined();
        expect(
            document
                .getPages()
                .every(
                    (page) =>
                        page.node.get(PDFName.of("Metadata")) === undefined,
                ),
        ).toBe(true);
        const raw = (await readFile(result.paths[0])).toString("latin1");
        for (const secret of [
            "CUSTOM_INFO_SECRET_8D52",
            "COMPRESSED_XMP_SECRET_91AF",
            "PAGE_XMP_SECRET_41CE",
            "ORPHAN_XMP_SECRET_772B",
        ])
            expect(raw).not.toContain(secret);
        const decodedStreams: string[] = [];
        for (const [, object] of document.context.enumerateIndirectObjects())
            if (object instanceof PDFRawStream)
                try {
                    decodedStreams.push(
                        Buffer.from(
                            decodePDFRawStream(object).decode(),
                        ).toString("utf8"),
                    );
                } catch {
                    decodedStreams.push(
                        Buffer.from(object.contents).toString("utf8"),
                    );
                }
        const decoded = decodedStreams.join("\n");
        for (const secret of [
            "COMPRESSED_XMP_SECRET_91AF",
            "PAGE_XMP_SECRET_41CE",
            "ORPHAN_XMP_SECRET_772B",
        ])
            expect(decoded).not.toContain(secret);
    });

    it("optimizes structure and reports honestly when output is not smaller", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 1);
        const inputSize = (await stat(path)).size;
        const result = await tools().run(
            await operation(root, [source(path)], "pdf-compress"),
        );
        const outputSize = (await stat(result.paths[0])).size;
        expect((await load(result.paths[0])).getPageCount()).toBe(1);
        expect(Boolean(result.warnings?.length)).toBe(outputSize >= inputSize);
    });
});

describe("createPdfTools conversion bridge and validation", () => {
    it("delegates conversion and validates renderer outputs inside staging", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 2);
        const render = vi.fn(async (request) => {
            const output = join(request.outputDir, "pages.txt");
            await writeFile(output, "PAGE-1\nPAGE-2\n");
            request.progress(100);
            return { paths: [output] };
        });
        const result = await tools(render).run(
            await operation(root, [source(path)], "pdf-convert", {
                format: "txt",
            }),
        );
        expect(await readFile(result.paths[0], "utf8")).toContain("PAGE-2");
        expect(render).toHaveBeenCalledWith(
            expect.objectContaining({ path, format: "txt" }),
        );
    });

    it("rejects renderer paths outside outputDir", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        const outside = join(root, "outside.txt");
        await makePdf(path, 1);
        await writeFile(outside, "outside");
        await expect(
            tools(async () => ({ paths: [outside] })).run(
                await operation(root, [source(path)], "pdf-convert", {
                    format: "txt",
                }),
            ),
        ).rejects.toThrow(/escaped/);
    });

    it.each([
        ["malformed range", "pdf-split", { pages: "1--2" }],
        ["out-of-range page", "pdf-split", { pages: "9" }],
        ["invalid rotation", "pdf-organize", { angle: 45 }],
        ["unknown option", "pdf-split", { speed: 2 }],
        ["invalid convert format", "pdf-convert", { format: "svg" }],
    ])("rejects %s", async (_label, recipe, options) => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 2);
        await expect(
            tools().run(
                await operation(
                    root,
                    [source(path)],
                    recipe,
                    options as FileToolOptions,
                ),
            ),
        ).rejects.toThrow();
    });

    it("rejects encrypted PDFs explicitly", async () => {
        const root = await fixtureRoot();
        const path = join(root, "encrypted.pdf");
        const document = await PDFDocument.create();
        document.addPage();
        document.context.trailerInfo.Encrypt = document.context.register(
            document.context.obj({ Filter: "Standard" }),
        );
        await writeFile(path, await document.save());
        await expect(
            tools().run(await operation(root, [source(path)], "pdf-split")),
        ).rejects.toThrow(/Encrypted PDFs are unavailable/);
    });

    it("rejects more than 200 pages and combined inputs above 100 MiB", async () => {
        const root = await fixtureRoot();
        const manyPages = join(root, "many.pdf");
        await makePdf(manyPages, 201);
        await expect(
            tools().run(
                await operation(root, [source(manyPages)], "pdf-split"),
            ),
        ).rejects.toThrow(/200 pages/);

        const huge = join(root, "huge.pdf");
        await writeFile(huge, "%PDF-1.7\n");
        await truncate(huge, 100 * 1024 * 1024 + 1);
        await expect(
            tools().run(await operation(root, [source(huge)], "pdf-split")),
        ).rejects.toThrow(/100 MiB/);
    });

    it("honors cancellation before loading PDF data", async () => {
        const root = await fixtureRoot();
        const path = join(root, "source.pdf");
        await makePdf(path, 2);
        const controller = new AbortController();
        controller.abort();
        await expect(
            tools().run(
                await operation(
                    root,
                    [source(path)],
                    "pdf-split",
                    {},
                    controller.signal,
                ),
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
