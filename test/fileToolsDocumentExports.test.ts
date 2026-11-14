import { createHash } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type PdfRenderInput,
    type TextPdfInput,
    createDocumentExports,
} from "../src/main/fileToolsDocumentExports";
import type {
    FileToolEngine,
    ToolContext,
    ToolInput,
} from "../src/main/fileToolsTypes";

const temporary: string[] = [];
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mQAAAABJRU5ErkJggg==",
    "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");

const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "opencapture-document-export-"));
    temporary.push(path);
    return path;
};
const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
const input = (
    path: string,
    extension: string,
    kind: ToolInput["kind"] = "document",
): ToolInput => ({
    id: basename(path),
    name: basename(path),
    path,
    extension,
    kind,
    size: statSync(path).size,
});
const context = (
    source: ToolInput,
    recipe: string,
    format: string,
    outputDir: string,
    signal = new AbortController().signal,
    extra: Record<string, unknown> = {},
): ToolContext => ({
    inputs: [source],
    recipe,
    options: { format, ...extra },
    outputDir,
    signal,
    progress: vi.fn(),
});

const availableOffice = (): FileToolEngine => ({
    recipes: () => [
        {
            id: "office-convert",
            label: "Office",
            group: "convert",
            formats: ["pdf"],
            available: true,
        },
    ],
    async run(value) {
        const path = join(value.outputDir, "office.pdf");
        writeFileSync(path, PDF, { flag: "wx" });
        value.progress(100);
        return { paths: [path], warnings: ["Office layout warning"] };
    },
});

const unavailableOffice = (): FileToolEngine => ({
    recipes: () => [
        {
            id: "office-convert",
            label: "Office",
            group: "convert",
            formats: ["pdf"],
            available: false,
            reason: "LibreOffice is absent.",
        },
    ],
    async run() {
        throw new Error("must not run");
    },
});

const textPdf = (seen: TextPdfInput[]) => async (value: TextPdfInput) => {
    seen.push(value);
    value.signal.throwIfAborted();
    const path = join(value.outputDir, `${value.name}.pdf`);
    writeFileSync(path, PDF, { flag: "wx" });
    value.progress(100);
    return { paths: [path], warnings: ["Text renderer warning"] };
};

const raster = (seen: PdfRenderInput[]) => async (value: PdfRenderInput) => {
    seen.push(value);
    value.signal.throwIfAborted();
    expect(readFileSync(value.path).subarray(0, 5).toString()).toBe("%PDF-");
    const path = join(value.outputDir, `page-001.${value.format}`);
    writeFileSync(
        path,
        value.format === "png" ? PNG : Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        {
            flag: "wx",
        },
    );
    value.progress(100);
    return { paths: [path], warnings: ["Raster warning"] };
};

afterEach(() => {
    for (const path of temporary.splice(0))
        rmSync(path, { recursive: true, force: true });
});

describe("document page export composition", () => {
    it("exports bounded portable text to a real PDF and removes private work", async () => {
        const directory = temp();
        const source = join(directory, "guide.md");
        writeFileSync(source, "# Heading\n\nBody text");
        const original = hash(source);
        const textCalls: TextPdfInput[] = [];
        const engine = createDocumentExports({
            office: unavailableOffice(),
            renderTextPdf: textPdf(textCalls),
            renderPdf: raster([]),
        });
        await expect(engine.recipes([input(source, "md")])).resolves.toEqual([
            expect.objectContaining({
                id: "text-document-pages",
                label: "Export document text pages",
                formats: ["pdf", "png", "jpg"],
                available: true,
            }),
        ]);
        const outputDir = join(directory, "output");
        const result = await engine.run(
            context(
                input(source, "md"),
                "text-document-pages",
                "pdf",
                outputDir,
            ),
        );
        expect(result.paths).toHaveLength(1);
        expect(readFileSync(result.paths[0]).subarray(0, 5).toString()).toBe(
            "%PDF-",
        );
        expect(textCalls[0].text).toContain("Heading");
        expect(result.warnings).toContain(
            "Text-only export preserves document text, not its original layout, fonts, images, or pagination.",
        );
        expect(
            readdirSync(outputDir).some((name) =>
                name.startsWith(".text-document-pages-"),
            ),
        ).toBe(false);
        expect(hash(source)).toBe(original);
    });

    it("renders portable text and available Office PDFs to actual page images", async () => {
        const directory = temp();
        const html = join(directory, "page.html");
        const docx = join(directory, "report.docx");
        writeFileSync(html, "<h1>Hello</h1><p>World</p>");
        writeFileSync(docx, "office fixture");
        const rasterCalls: PdfRenderInput[] = [];
        const engine = createDocumentExports({
            office: availableOffice(),
            renderTextPdf: textPdf([]),
            renderPdf: raster(rasterCalls),
        });
        const textResult = await engine.run(
            context(
                input(html, "html"),
                "text-document-pages",
                "png",
                join(directory, "text-pages"),
            ),
        );
        expect(readFileSync(textResult.paths[0]).subarray(0, 8)).toEqual(
            PNG.subarray(0, 8),
        );

        const officeRecipes = await engine.recipes([input(docx, "docx")]);
        expect(officeRecipes[0]).toMatchObject({
            id: "office-document-pages",
            formats: ["png", "jpg"],
            available: true,
        });
        const original = hash(docx);
        const officeOutput = join(directory, "office-pages");
        const officeResult = await engine.run(
            context(
                input(docx, "docx"),
                "office-document-pages",
                "png",
                officeOutput,
            ),
        );
        expect(readFileSync(officeResult.paths[0]).subarray(0, 8)).toEqual(
            PNG.subarray(0, 8),
        );
        expect(officeResult.warnings).toEqual(
            expect.arrayContaining([
                "Office layout warning",
                "Raster warning",
                "Office pages were rendered through LibreOffice and PDF; layout may differ from the source application.",
            ]),
        );
        expect(rasterCalls).toHaveLength(2);
        expect(
            readdirSync(officeOutput).some((name) =>
                name.startsWith(".office-document-pages-"),
            ),
        ).toBe(false);
        expect(hash(docx)).toBe(original);
    });

    it("inherits Office availability and preserves work on termination errors", async () => {
        const directory = temp();
        const source = join(directory, "report.docx");
        writeFileSync(source, "office fixture");
        const unavailable = createDocumentExports({
            office: unavailableOffice(),
            renderTextPdf: textPdf([]),
            renderPdf: raster([]),
        });
        const recipes = await unavailable.recipes([input(source, "docx")]);
        expect(recipes[0]).toMatchObject({
            available: false,
            reason: "LibreOffice is absent.",
        });

        const termination = Object.assign(new Error("office still alive"), {
            preserveWork: true,
        });
        const preservingOffice: FileToolEngine = {
            recipes: availableOffice().recipes,
            async run(value) {
                writeFileSync(join(value.outputDir, "process-marker"), "live");
                throw termination;
            },
        };
        const engine = createDocumentExports({
            office: preservingOffice,
            renderTextPdf: textPdf([]),
            renderPdf: raster([]),
        });
        const outputDir = join(directory, "preserved");
        await expect(
            engine.run(
                context(
                    input(source, "docx"),
                    "office-document-pages",
                    "png",
                    outputDir,
                ),
            ),
        ).rejects.toBe(termination);
        expect(
            readdirSync(outputDir).some((name) =>
                name.startsWith(".office-document-pages-"),
            ),
        ).toBe(true);
    });

    it("rejects cancellation, extra options, and renderer path escapes", async () => {
        const directory = temp();
        const source = join(directory, "note.txt");
        writeFileSync(source, "note");
        const controller = new AbortController();
        controller.abort();
        const engine = createDocumentExports({
            office: unavailableOffice(),
            renderTextPdf: textPdf([]),
            renderPdf: raster([]),
        });
        await expect(
            engine.run(
                context(
                    input(source, "txt"),
                    "text-document-pages",
                    "pdf",
                    join(directory, "cancelled"),
                    controller.signal,
                ),
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(existsSync(join(directory, "cancelled"))).toBe(false);

        await expect(
            engine.run(
                context(
                    input(source, "txt"),
                    "text-document-pages",
                    "pdf",
                    join(directory, "extra-options"),
                    undefined,
                    { quality: 0.5 },
                ),
            ),
        ).rejects.toThrow(/one file and one format/);

        const outside = join(directory, "outside.pdf");
        const escaping = createDocumentExports({
            office: unavailableOffice(),
            async renderTextPdf() {
                writeFileSync(outside, PDF);
                return { paths: [outside] };
            },
            renderPdf: raster([]),
        });
        const outputDir = join(directory, "escape");
        await expect(
            escaping.run(
                context(
                    input(source, "txt"),
                    "text-document-pages",
                    "pdf",
                    outputDir,
                ),
            ),
        ).rejects.toThrow(/unsafe path/);
        expect(
            readdirSync(outputDir).some((name) =>
                name.startsWith(".text-document-pages-"),
            ),
        ).toBe(false);
    });
});
