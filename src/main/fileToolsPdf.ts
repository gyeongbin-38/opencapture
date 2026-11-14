import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { FileToolOptions, FileToolRecipe } from "../../lib/fileTools";
import type {
    FileToolEngine,
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "./fileToolsTypes";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 200;

type RenderInput = {
    path: string;
    format: "png" | "jpg" | "txt" | "md";
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
};

type PdfToolsOptions = {
    render: (input: RenderInput) => Promise<ToolEngineResult>;
};

let pdfLibPromise: Promise<typeof import("pdf-lib")> | undefined;
function pdfLib() {
    pdfLibPromise ??= import("pdf-lib");
    return pdfLibPromise;
}

function abortError() {
    const error = new Error("PDF operation cancelled");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw abortError();
}

function isPdf(input: ToolInput) {
    return (
        input.kind === "pdf" ||
        input.extension.toLowerCase().replace(/^\./, "") === "pdf"
    );
}

function recipeList(inputs: ToolInput[]): FileToolRecipe[] {
    if (!inputs.some(isPdf)) return [];
    const allPdf = inputs.length > 0 && inputs.every(isPdf);
    const single = allPdf && inputs.length === 1;
    return [
        {
            id: "pdf-convert",
            label: "Convert PDF",
            group: "convert",
            formats: ["png", "jpg", "txt", "md"],
            available: single,
            reason: single ? undefined : "Select one PDF",
        },
        {
            id: "pdf-split",
            label: "Split PDF",
            group: "tools",
            options: ["pages"],
            available: single,
            reason: single ? undefined : "Select one PDF",
        },
        {
            id: "pdf-organize",
            label: "Organize PDF pages",
            group: "tools",
            options: ["pages", "angle"],
            available: single,
            reason: single ? undefined : "Select one PDF",
        },
        {
            id: "pdf-merge",
            minSources: 2,
            label: "Merge PDFs",
            group: "tools",
            multiple: true,
            available: allPdf && inputs.length >= 2,
            reason:
                allPdf && inputs.length >= 2
                    ? undefined
                    : "Select at least two PDFs",
        },
        {
            id: "pdf-remove-metadata",
            label: "Remove PDF metadata",
            group: "tools",
            available: single,
            reason: single ? undefined : "Select one PDF",
        },
        {
            id: "pdf-compress",
            label: "Optimize PDF structure",
            group: "tools",
            available: single,
            reason: single ? undefined : "Select one PDF",
        },
    ];
}

const allowedOptions: Record<string, Set<keyof FileToolOptions>> = {
    "pdf-convert": new Set(["format"]),
    "pdf-split": new Set(["pages"]),
    "pdf-organize": new Set(["pages", "angle"]),
    "pdf-merge": new Set(),
    "pdf-remove-metadata": new Set(),
    "pdf-compress": new Set(),
};

function validateOptions(recipe: string, options: FileToolOptions) {
    const allowed = allowedOptions[recipe];
    if (!allowed) throw new Error(`Unknown PDF recipe: ${recipe}`);
    for (const key of Object.keys(options))
        if (!allowed.has(key as keyof FileToolOptions))
            throw new Error(`Unsupported ${recipe} option: ${key}`);
}

async function ensureOutputRoot(outputDir: string) {
    await mkdir(outputDir, { recursive: true });
    const info = await lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("PDF output directory is not a safe directory");
    return resolve(outputDir);
}

function withinOutput(outputRoot: string, candidate: string) {
    const target = resolve(candidate);
    if (
        target !== outputRoot &&
        !target.startsWith(`${outputRoot}\\`) &&
        !target.startsWith(`${outputRoot}/`)
    )
        throw new Error("PDF output escaped its staging directory");
    return target;
}

function safeStem(input: ToolInput) {
    const normalized = basename(input.path, extname(input.path))
        .normalize("NFC")
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim();
    const value = Array.from(normalized, (character) =>
        character.charCodeAt(0) < 32 ? "-" : character,
    ).join("");
    return value || "document";
}

async function uniqueOutputPath(outputRoot: string, requested: string) {
    const extension = extname(requested);
    const stem = requested.slice(0, requested.length - extension.length);
    for (let index = 0; index < 10_000; index += 1) {
        const name = index ? `${stem}-${index + 1}${extension}` : requested;
        const target = withinOutput(outputRoot, resolve(outputRoot, name));
        try {
            await lstat(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return target;
            throw error;
        }
    }
    throw new Error("Could not allocate a unique PDF output name");
}

async function hashFile(path: string, signal: AbortSignal) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const value of createReadStream(path)) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_PDF_BYTES) throw new Error("PDF input exceeds 100 MiB");
        hash.update(chunk);
    }
    return { bytes, hash: hash.digest("hex") };
}

async function snapshotInputs(inputs: ToolInput[], signal: AbortSignal) {
    let total = 0;
    const snapshots = [];
    for (const input of inputs) {
        throwIfAborted(signal);
        if (!isPdf(input)) throw new Error(`${input.name} is not a PDF`);
        const info = await lstat(input.path);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`PDF input is not a regular file: ${input.name}`);
        total += info.size;
        if (total > MAX_PDF_BYTES)
            throw new Error("Combined PDF input exceeds 100 MiB");
        snapshots.push({ input, ...(await hashFile(input.path, signal)) });
    }
    return snapshots;
}

async function verifySnapshots(
    snapshots: Awaited<ReturnType<typeof snapshotInputs>>,
    signal: AbortSignal,
) {
    for (const snapshot of snapshots) {
        const after = await hashFile(snapshot.input.path, signal);
        if (after.bytes !== snapshot.bytes || after.hash !== snapshot.hash)
            throw new Error(
                `PDF source changed during processing: ${snapshot.input.name}`,
            );
    }
}

async function loadPdf(input: ToolInput, signal: AbortSignal) {
    throwIfAborted(signal);
    const bytes = await readFile(input.path);
    throwIfAborted(signal);
    const { PDFDocument } = await pdfLib();
    try {
        const document = await PDFDocument.load(bytes, {
            ignoreEncryption: false,
            updateMetadata: false,
        });
        if (document.isEncrypted)
            throw new Error("Encrypted PDFs are unavailable");
        if (document.getPageCount() > MAX_PAGES)
            throw new Error(`PDF exceeds ${MAX_PAGES} pages`);
        return document;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/encrypt/i.test(message))
            throw new Error("Encrypted PDFs are unavailable");
        throw new Error(`Could not read PDF: ${message}`);
    }
}

function pageSelection(
    value: string | undefined,
    pageCount: number,
    preserveOrder: boolean,
) {
    if (!value?.trim())
        return Array.from({ length: pageCount }, (_, index) => index);
    const pages: number[] = [];
    for (const raw of value.split(",")) {
        const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(raw);
        if (!match) throw new Error(`Invalid page range: ${raw.trim()}`);
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : start;
        if (start < 1 || end < 1 || start > pageCount || end > pageCount)
            throw new Error(`Page range is outside 1-${pageCount}`);
        const direction = start <= end ? 1 : -1;
        for (let page = start; ; page += direction) {
            pages.push(page - 1);
            if (page === end) break;
            if (pages.length > MAX_PAGES)
                throw new Error(`Page selection exceeds ${MAX_PAGES} pages`);
        }
    }
    const selected = preserveOrder
        ? pages
        : [...new Set(pages)].sort((a, b) => a - b);
    if (!selected.length) throw new Error("Select at least one page");
    if (selected.length > MAX_PAGES)
        throw new Error(`Page selection exceeds ${MAX_PAGES} pages`);
    return selected;
}

function rotation(value: number | undefined) {
    const angle = value ?? 0;
    if (![0, 90, 180, 270].includes(angle))
        throw new Error("PDF rotation must be 0, 90, 180, or 270 degrees");
    return angle;
}

async function savePdf(
    document: Awaited<ReturnType<typeof loadPdf>>,
    output: string,
    signal: AbortSignal,
) {
    throwIfAborted(signal);
    const bytes = await document.save({ useObjectStreams: true });
    throwIfAborted(signal);
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    return bytes.length;
}

async function validateRenderedOutputs(
    result: ToolEngineResult,
    outputRoot: string,
) {
    if (!result.paths.length || result.paths.length > MAX_PAGES)
        throw new Error("PDF renderer returned an invalid output count");
    for (const path of result.paths) {
        const target = withinOutput(outputRoot, path);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error("PDF renderer returned an unsafe output");
    }
    return result;
}

export function createPdfTools({ render }: PdfToolsOptions): FileToolEngine {
    return {
        recipes: recipeList,
        async run(context: ToolContext): Promise<ToolEngineResult> {
            validateOptions(context.recipe, context.options);
            const outputRoot = await ensureOutputRoot(context.outputDir);
            const snapshots = await snapshotInputs(
                context.inputs,
                context.signal,
            );
            try {
                if (context.recipe === "pdf-convert") {
                    if (context.inputs.length !== 1)
                        throw new Error("PDF conversion requires one input");
                    const format = context.options.format?.toLowerCase();
                    if (
                        !format ||
                        !["png", "jpg", "txt", "md"].includes(format)
                    )
                        throw new Error("PDF conversion format is invalid");
                    await loadPdf(context.inputs[0], context.signal);
                    const result = await render({
                        path: context.inputs[0].path,
                        format: format as RenderInput["format"],
                        outputDir: outputRoot,
                        signal: context.signal,
                        progress: context.progress,
                    });
                    return await validateRenderedOutputs(result, outputRoot);
                }

                if (context.recipe === "pdf-split") {
                    if (context.inputs.length !== 1)
                        throw new Error("PDF split requires one input");
                    const source = await loadPdf(
                        context.inputs[0],
                        context.signal,
                    );
                    const selected = pageSelection(
                        context.options.pages,
                        source.getPageCount(),
                        false,
                    );
                    const { PDFDocument } = await pdfLib();
                    const paths: string[] = [];
                    for (const [index, pageIndex] of selected.entries()) {
                        throwIfAborted(context.signal);
                        const outputDocument = await PDFDocument.create();
                        const [page] = await outputDocument.copyPages(source, [
                            pageIndex,
                        ]);
                        outputDocument.addPage(page);
                        const output = await uniqueOutputPath(
                            outputRoot,
                            `${safeStem(context.inputs[0])}-page-${pageIndex + 1}.pdf`,
                        );
                        await savePdf(
                            outputDocument as typeof source,
                            output,
                            context.signal,
                        );
                        paths.push(output);
                        context.progress(((index + 1) / selected.length) * 100);
                    }
                    return { paths };
                }

                if (context.recipe === "pdf-organize") {
                    if (context.inputs.length !== 1)
                        throw new Error("PDF organization requires one input");
                    const source = await loadPdf(
                        context.inputs[0],
                        context.signal,
                    );
                    const selected = pageSelection(
                        context.options.pages,
                        source.getPageCount(),
                        true,
                    );
                    const angle = rotation(context.options.angle);
                    const { PDFDocument, degrees } = await pdfLib();
                    const outputDocument = await PDFDocument.create();
                    for (const [index, pageIndex] of selected.entries()) {
                        throwIfAborted(context.signal);
                        const [page] = await outputDocument.copyPages(source, [
                            pageIndex,
                        ]);
                        if (angle) {
                            const existing = page.getRotation().angle;
                            page.setRotation(degrees((existing + angle) % 360));
                        }
                        outputDocument.addPage(page);
                        context.progress(((index + 1) / selected.length) * 100);
                    }
                    const output = await uniqueOutputPath(
                        outputRoot,
                        `${safeStem(context.inputs[0])}-organized.pdf`,
                    );
                    await savePdf(
                        outputDocument as typeof source,
                        output,
                        context.signal,
                    );
                    return { paths: [output] };
                }

                if (context.recipe === "pdf-merge") {
                    if (context.inputs.length < 2)
                        throw new Error(
                            "PDF merge requires at least two inputs",
                        );
                    const { PDFDocument } = await pdfLib();
                    const outputDocument = await PDFDocument.create();
                    let pageTotal = 0;
                    for (const [
                        inputIndex,
                        input,
                    ] of context.inputs.entries()) {
                        const source = await loadPdf(input, context.signal);
                        pageTotal += source.getPageCount();
                        if (pageTotal > MAX_PAGES)
                            throw new Error(
                                `Merged PDF exceeds ${MAX_PAGES} pages`,
                            );
                        const indices = source.getPageIndices();
                        const pages = await outputDocument.copyPages(
                            source,
                            indices,
                        );
                        for (const page of pages) outputDocument.addPage(page);
                        context.progress(
                            ((inputIndex + 1) / context.inputs.length) * 100,
                        );
                    }
                    const output = await uniqueOutputPath(
                        outputRoot,
                        "merged.pdf",
                    );
                    await savePdf(
                        outputDocument as Awaited<ReturnType<typeof loadPdf>>,
                        output,
                        context.signal,
                    );
                    return { paths: [output] };
                }

                if (context.recipe === "pdf-remove-metadata") {
                    if (context.inputs.length !== 1)
                        throw new Error("Metadata removal requires one PDF");
                    const document = await loadPdf(
                        context.inputs[0],
                        context.signal,
                    );
                    const { PDFDict, PDFName, PDFRef, PDFStream } =
                        await pdfLib();
                    const metadataName = PDFName.of("Metadata");
                    const infoRef = document.context.trailerInfo.Info;
                    if (infoRef) {
                        if (infoRef instanceof PDFRef)
                            document.context.delete(infoRef);
                        document.context.trailerInfo.Info = undefined;
                    }
                    const removeMetadataEntry = (
                        dictionary: import("pdf-lib").PDFDict,
                    ) => {
                        const metadata = dictionary.get(metadataName);
                        dictionary.delete(metadataName);
                        if (metadata instanceof PDFRef)
                            document.context.delete(metadata);
                    };
                    removeMetadataEntry(document.catalog);
                    for (const page of document.getPages())
                        removeMetadataEntry(page.node);
                    for (const [reference, object] of [
                        ...document.context.enumerateIndirectObjects(),
                    ]) {
                        if (object instanceof PDFDict)
                            removeMetadataEntry(object);
                        if (object instanceof PDFStream) {
                            removeMetadataEntry(object.dict);
                            if (
                                object.dict.lookup(PDFName.of("Type")) ===
                                metadataName
                            )
                                document.context.delete(reference);
                        }
                    }
                    const output = await uniqueOutputPath(
                        outputRoot,
                        `${safeStem(context.inputs[0])}-clean.pdf`,
                    );
                    await savePdf(document, output, context.signal);
                    context.progress(100);
                    return { paths: [output] };
                }

                if (context.recipe === "pdf-compress") {
                    if (context.inputs.length !== 1)
                        throw new Error("PDF optimization requires one input");
                    const document = await loadPdf(
                        context.inputs[0],
                        context.signal,
                    );
                    const output = await uniqueOutputPath(
                        outputRoot,
                        `${safeStem(context.inputs[0])}-compressed.pdf`,
                    );
                    const outputBytes = await savePdf(
                        document,
                        output,
                        context.signal,
                    );
                    context.progress(100);
                    return {
                        paths: [output],
                        warnings:
                            outputBytes >= snapshots[0].bytes
                                ? [
                                      "Structural optimization completed, but the PDF did not become smaller",
                                  ]
                                : undefined,
                    };
                }
                throw new Error(`Unknown PDF recipe: ${context.recipe}`);
            } finally {
                await verifySnapshots(snapshots, context.signal);
            }
        },
    };
}
