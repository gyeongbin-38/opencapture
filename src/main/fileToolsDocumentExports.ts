import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import {
    basename,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import type { FileToolRecipe } from "../../lib/fileTools";
import { documentTools } from "./fileToolsDocuments";
import { textTools } from "./fileToolsText";
import type {
    FileToolEngine,
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "./fileToolsTypes";

const TEXT_RECIPE = "text-document-pages";
const OFFICE_RECIPE = "office-document-pages";
const TEXT_EXTENSIONS = new Set([
    "txt",
    "md",
    "markdown",
    "html",
    "htm",
    "epub",
]);
const OFFICE_EXTENSIONS = new Set([
    "doc",
    "docx",
    "odt",
    "rtf",
    "pages",
    "xls",
    "xlsx",
    "ods",
    "csv",
    "tsv",
    "ppt",
    "pptx",
    "odp",
]);
const TEXT_WARNING =
    "Text-only export preserves document text, not its original layout, fonts, images, or pagination.";
const OFFICE_WARNING =
    "Office pages were rendered through LibreOffice and PDF; layout may differ from the source application.";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export type PdfRenderInput = {
    path: string;
    format: "png" | "jpg" | "txt" | "md";
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
};

export type TextPdfInput = {
    text: string;
    name: string;
    outputDir: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
};

const extension = (input: ToolInput) =>
    input.extension.toLowerCase().replace(/^\./, "");

const inside = (parent: string, child: string) => {
    const part = relative(parent, child);
    return (
        !!part &&
        part !== ".." &&
        !part.startsWith(`..${sep}`) &&
        !isAbsolute(part)
    );
};

const preservesWork = (error: unknown) =>
    Boolean(
        error &&
            typeof error === "object" &&
            "preserveWork" in error &&
            error.preserveWork === true,
    );

const warnings = (...values: Array<string[] | undefined>) => [
    ...new Set(values.flatMap((value) => value ?? [])),
];

const assertOptions = (context: ToolContext) => {
    if (
        context.inputs.length !== 1 ||
        Object.keys(context.options).some((key) => key !== "format")
    )
        throw new Error("Document page export needs one file and one format.");
    const format = context.options.format?.toLowerCase();
    if (format !== "pdf" && format !== "png" && format !== "jpg")
        throw new Error("Document page output must be PDF, PNG, or JPG.");
    if (!isAbsolute(context.outputDir))
        throw new Error("Document output directory must be absolute.");
    return format;
};

const safeName = (input: ToolInput) =>
    basename(input.name, extname(input.name))
        .replace(/[\\/:*?"<>|\p{C}]/gu, "-")
        .trim()
        .slice(0, 100) || "document";

const finalPath = async (outputDir: string, name: string, format: string) => {
    for (let index = 0; index < 10_000; index++) {
        const path = join(
            outputDir,
            `${name}${index ? `-${index + 1}` : ""}.${format}`,
        );
        try {
            await fs.access(path);
        } catch {
            return path;
        }
    }
    throw new Error("Unable to allocate a document output filename.");
};

const oneOwnedPath = async (
    result: ToolEngineResult,
    directory: string,
    label: string,
) => {
    if (result.paths.length !== 1)
        throw new Error(`${label} did not produce one file.`);
    const root = await fs.realpath(directory);
    const path = await fs.realpath(result.paths[0]);
    if (!inside(root, path))
        throw new Error(`${label} returned an unsafe path.`);
    const stats = await fs.stat(path);
    if (!stats.isFile() || stats.size <= 0)
        throw new Error(`${label} returned an empty file.`);
    return { path, size: stats.size };
};

const assertPdf = async (path: string) => {
    const handle = await fs.open(path, "r");
    try {
        const header = Buffer.alloc(5);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead !== 5 || header.toString("ascii") !== "%PDF-")
            throw new Error("Document renderer returned an invalid PDF.");
    } finally {
        await handle.close();
    }
};

const validateRasterOutputs = async (
    result: ToolEngineResult,
    outputDir: string,
    format: "png" | "jpg",
) => {
    if (!result.paths.length || result.paths.length > 200)
        throw new Error("Document raster output count is invalid.");
    const root = await fs.realpath(outputDir);
    const paths: string[] = [];
    for (const candidate of result.paths) {
        const path = await fs.realpath(candidate);
        if (!inside(root, path))
            throw new Error(
                "Document raster renderer returned an unsafe path.",
            );
        const stats = await fs.stat(path);
        if (!stats.isFile() || stats.size <= 0)
            throw new Error("Document raster renderer returned an empty file.");
        const handle = await fs.open(path, "r");
        try {
            const header = Buffer.alloc(8);
            const { bytesRead } = await handle.read(
                header,
                0,
                header.length,
                0,
            );
            const valid =
                format === "png"
                    ? bytesRead === 8 &&
                      header.toString("hex") === "89504e470d0a1a0a"
                    : bytesRead >= 2 &&
                      header[0] === 0xff &&
                      header[1] === 0xd8;
            if (!valid) throw new Error("Document raster encoding is invalid.");
        } finally {
            await handle.close();
        }
        paths.push(path);
    }
    return paths;
};

export function createDocumentExports({
    office,
    renderPdf,
    renderTextPdf,
}: {
    office: FileToolEngine;
    renderPdf: (input: PdfRenderInput) => Promise<ToolEngineResult>;
    renderTextPdf: (input: TextPdfInput) => Promise<ToolEngineResult>;
}): FileToolEngine {
    const recipes = async (inputs: ToolInput[]): Promise<FileToolRecipe[]> => {
        if (inputs.length !== 1) return [];
        const inputExtension = extension(inputs[0]);
        if (TEXT_EXTENSIONS.has(inputExtension))
            return [
                {
                    id: TEXT_RECIPE,
                    label: "Export document text pages",
                    group: "convert",
                    formats: ["pdf", "png", "jpg"],
                    available: true,
                },
            ];
        if (!OFFICE_EXTENSIONS.has(inputExtension)) return [];
        const officeRecipes = await office.recipes(inputs);
        const conversion = officeRecipes.find(
            (recipe) => recipe.id === "office-convert",
        );
        const available = Boolean(
            conversion?.available && conversion.formats?.includes("pdf"),
        );
        return [
            {
                id: OFFICE_RECIPE,
                label: "Export office document pages",
                group: "convert",
                formats: ["png", "jpg"],
                available,
                ...(!available
                    ? {
                          reason:
                              conversion?.reason ??
                              "LibreOffice PDF conversion is unavailable.",
                      }
                    : {}),
            },
        ];
    };

    return {
        recipes,
        async run(context) {
            const format = assertOptions(context);
            const input = context.inputs[0];
            const inputExtension = extension(input);
            context.signal.throwIfAborted();
            await fs.mkdir(context.outputDir, { recursive: true });
            let preservePrivateWork = false;
            const privateDirectory = await fs.mkdtemp(
                join(
                    context.outputDir,
                    context.recipe === OFFICE_RECIPE
                        ? ".office-document-pages-"
                        : ".text-document-pages-",
                ),
            );
            try {
                if (context.recipe === TEXT_RECIPE) {
                    if (!TEXT_EXTENSIONS.has(inputExtension))
                        throw new Error(
                            "Text document page export is unavailable for this file.",
                        );
                    const textDirectory = join(privateDirectory, "text");
                    const pdfDirectory = join(privateDirectory, "pdf");
                    await fs.mkdir(textDirectory);
                    await fs.mkdir(pdfDirectory);
                    const textResult = await (inputExtension === "epub"
                        ? documentTools
                        : textTools
                    ).run({
                        ...context,
                        recipe:
                            inputExtension === "epub"
                                ? "document-text-convert"
                                : "text-convert",
                        options: { format: "txt" },
                        outputDir: textDirectory,
                        progress: (percent) => context.progress(percent * 0.25),
                    });
                    context.signal.throwIfAborted();
                    const textFile = await oneOwnedPath(
                        textResult,
                        textDirectory,
                        "Text conversion",
                    );
                    if (textFile.size > MAX_TEXT_BYTES)
                        throw new Error("Document text exceeds 16 MiB.");
                    const text = await fs.readFile(textFile.path, "utf8");
                    context.signal.throwIfAborted();
                    const pdfResult = await renderTextPdf({
                        text,
                        name: safeName(input),
                        outputDir: pdfDirectory,
                        signal: context.signal,
                        progress: (percent) =>
                            context.progress(25 + percent * 0.4),
                    });
                    const pdf = await oneOwnedPath(
                        pdfResult,
                        pdfDirectory,
                        "Text PDF rendering",
                    );
                    await assertPdf(pdf.path);
                    context.signal.throwIfAborted();
                    if (format === "pdf") {
                        const target = await finalPath(
                            context.outputDir,
                            safeName(input),
                            "pdf",
                        );
                        await fs.copyFile(
                            pdf.path,
                            target,
                            constants.COPYFILE_EXCL,
                        );
                        context.signal.throwIfAborted();
                        context.progress(100);
                        return {
                            paths: [target],
                            warnings: warnings(
                                textResult.warnings,
                                pdfResult.warnings,
                                [TEXT_WARNING],
                            ),
                        };
                    }
                    const rasterResult = await renderPdf({
                        path: pdf.path,
                        format,
                        outputDir: context.outputDir,
                        signal: context.signal,
                        progress: (percent) =>
                            context.progress(65 + percent * 0.35),
                    });
                    context.signal.throwIfAborted();
                    const paths = await validateRasterOutputs(
                        rasterResult,
                        context.outputDir,
                        format,
                    );
                    context.signal.throwIfAborted();
                    return {
                        paths,
                        warnings: warnings(
                            textResult.warnings,
                            pdfResult.warnings,
                            rasterResult.warnings,
                            [TEXT_WARNING],
                        ),
                    };
                }

                if (context.recipe !== OFFICE_RECIPE)
                    throw new Error(
                        `Unknown document export recipe: ${context.recipe}`,
                    );
                if (format === "pdf")
                    throw new Error(
                        "Office page export supports PNG or JPG pages.",
                    );
                if (!OFFICE_EXTENSIONS.has(inputExtension))
                    throw new Error(
                        "Office page export is unavailable for this file.",
                    );
                const available = (await recipes(context.inputs))[0];
                if (!available?.available)
                    throw new Error(
                        available?.reason ??
                            "Office page export is unavailable.",
                    );
                const officeResult = await office.run({
                    ...context,
                    recipe: "office-convert",
                    options: { format: "pdf" },
                    outputDir: privateDirectory,
                    progress: (percent) => context.progress(percent * 0.5),
                });
                context.signal.throwIfAborted();
                const pdf = await oneOwnedPath(
                    officeResult,
                    privateDirectory,
                    "Office PDF conversion",
                );
                await assertPdf(pdf.path);
                const rasterResult = await renderPdf({
                    path: pdf.path,
                    format,
                    outputDir: context.outputDir,
                    signal: context.signal,
                    progress: (percent) => context.progress(50 + percent * 0.5),
                });
                context.signal.throwIfAborted();
                const paths = await validateRasterOutputs(
                    rasterResult,
                    context.outputDir,
                    format,
                );
                context.signal.throwIfAborted();
                return {
                    paths,
                    warnings: warnings(
                        officeResult.warnings,
                        rasterResult.warnings,
                        [OFFICE_WARNING],
                    ),
                };
            } catch (error) {
                preservePrivateWork = preservesWork(error);
                throw error;
            } finally {
                if (!preservePrivateWork)
                    await fs.rm(privateDirectory, {
                        recursive: true,
                        force: true,
                    });
            }
        },
    };
}
