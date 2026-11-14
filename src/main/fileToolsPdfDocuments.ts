import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { documentTools } from "./fileToolsDocuments";
import type { FileToolEngine, ToolEngineResult } from "./fileToolsTypes";

export function createPdfTextDocuments(
    render: (input: {
        path: string;
        format: "txt";
        outputDir: string;
        signal: AbortSignal;
        progress: (percent: number) => void;
    }) => Promise<ToolEngineResult>,
): FileToolEngine {
    return {
        recipes(inputs) {
            return inputs.length &&
                inputs.every((input) => input.kind === "pdf")
                ? [
                      {
                          id: "pdf-text-document",
                          label: "Convert PDF document text",
                          group: "convert",
                          formats: ["docx", "epub"],
                          available: true,
                      },
                  ]
                : [];
        },
        async run(context) {
            if (
                context.inputs.length !== 1 ||
                context.inputs[0].kind !== "pdf" ||
                !["docx", "epub"].includes(context.options.format ?? "") ||
                Object.keys(context.options).some((key) => key !== "format")
            )
                throw new Error(
                    "Choose one PDF and a text-only DOCX or EPUB output.",
                );
            context.signal.throwIfAborted();
            const temporary = await fs.mkdtemp(
                join(context.outputDir, ".pdf-text-"),
            );
            try {
                const result = await render({
                    path: context.inputs[0].path,
                    format: "txt",
                    outputDir: temporary,
                    signal: context.signal,
                    progress: (percent) => context.progress(percent * 0.6),
                });
                if (result.paths.length !== 1)
                    throw new Error(
                        "PDF text extraction did not produce one document.",
                    );
                const textPath = await fs.realpath(result.paths[0]);
                const inside = relative(await fs.realpath(temporary), textPath);
                if (
                    !inside ||
                    inside === ".." ||
                    inside.startsWith(`..${sep}`) ||
                    isAbsolute(inside)
                )
                    throw new Error("Invalid extracted document path.");
                const size = await fs.stat(textPath);
                if (!size.isFile() || size.size > 16 * 1024 ** 2)
                    throw new Error("Extracted document text exceeds 16 MiB.");
                const name = `${basename(context.inputs[0].name, extname(context.inputs[0].name))}.txt`;
                return await documentTools.run({
                    ...context,
                    recipe: "document-text-convert",
                    inputs: [
                        {
                            ...context.inputs[0],
                            path: textPath,
                            name,
                            extension: "txt",
                            kind: "document",
                            size: size.size,
                        },
                    ],
                    progress: (percent) => context.progress(60 + percent * 0.4),
                });
            } finally {
                await fs.rm(temporary, { force: true, recursive: true });
            }
        },
    };
}
