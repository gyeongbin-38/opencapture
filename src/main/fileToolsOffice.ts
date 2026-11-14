import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    constants,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    delimiter,
    extname,
    isAbsolute,
    join,
    resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import yauzl from "yauzl";
import type { FileToolRecipe } from "../../lib/fileTools";
import type { FileToolEngine, ToolContext, ToolInput } from "./fileToolsTypes";

const RECIPE_ID = "office-convert";
const TIMEOUT_MS = 120_000;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const LAYOUT_WARNING =
    "Layout may change when converting between office formats.";
const MAS_UNAVAILABLE_REASON =
    "LibreOffice conversion is unavailable in the Mac App Store sandbox.";
const TERMINATION_GRACE_MS = 5_000;

type Family = "writer" | "calc" | "impress";
type Filter = { extension: string; name: string };

const INPUT_FAMILIES: Record<string, Family> = {
    doc: "writer",
    docx: "writer",
    odt: "writer",
    rtf: "writer",
    pages: "writer",
    xls: "calc",
    xlsx: "calc",
    ods: "calc",
    csv: "calc",
    tsv: "calc",
    ppt: "impress",
    pptx: "impress",
    odp: "impress",
};

const FILTERS: Record<Family, Record<string, Filter>> = {
    writer: {
        docx: { extension: "docx", name: "Office Open XML Text" },
        odt: { extension: "odt", name: "writer8" },
        rtf: { extension: "rtf", name: "Rich Text Format" },
        txt: { extension: "txt", name: "Text (encoded):UTF8" },
        html: { extension: "html", name: "HTML (StarWriter)" },
        pdf: { extension: "pdf", name: "writer_pdf_Export" },
        epub: { extension: "epub", name: "EPUB" },
    },
    calc: {
        xlsx: { extension: "xlsx", name: "Calc Office Open XML" },
        ods: { extension: "ods", name: "calc8" },
        csv: {
            extension: "csv",
            name: "Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,0,false,false",
        },
        tsv: {
            extension: "tsv",
            name: "Text - txt - csv (StarCalc):9,34,76,1,,0,false,true,true,false,false,0,false,false",
        },
        pdf: { extension: "pdf", name: "calc_pdf_Export" },
    },
    impress: {
        pptx: { extension: "pptx", name: "Impress Office Open XML" },
        odp: { extension: "odp", name: "impress8" },
        pdf: { extension: "pdf", name: "impress_pdf_Export" },
    },
};

function normalizedExtension(input: ToolInput): string {
    return input.extension.toLowerCase().replace(/^\./, "");
}

function isExecutable(path: string | undefined): path is string {
    if (!path || !isAbsolute(path) || !existsSync(path)) return false;
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function executableCandidates(): string[] {
    const candidates: string[] = [];
    if (process.platform === "win32") {
        for (const root of [
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
        ]) {
            if (root) {
                candidates.push(
                    join(root, "LibreOffice", "program", "soffice.com"),
                    join(root, "LibreOffice", "program", "soffice.exe"),
                );
            }
        }
    } else if (process.platform === "darwin") {
        candidates.push(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            join(
                process.env.HOME ?? "",
                "Applications/LibreOffice.app/Contents/MacOS/soffice",
            ),
        );
    } else {
        candidates.push(
            "/usr/bin/libreoffice",
            "/usr/bin/soffice",
            "/usr/local/bin/libreoffice",
            "/usr/local/bin/soffice",
            "/snap/bin/libreoffice",
        );
    }
    const names =
        process.platform === "win32"
            ? ["soffice.com", "soffice.exe"]
            : ["libreoffice", "soffice"];
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!directory) continue;
        for (const name of names) candidates.push(resolve(directory, name));
    }
    return [...new Set(candidates)];
}

function findExecutable(explicit?: string): string | undefined {
    if (explicit !== undefined)
        return isExecutable(explicit) ? explicit : undefined;
    return executableCandidates().find(isExecutable);
}

function supportedFormats(inputs: ToolInput[]): string[] {
    if (!inputs.length) return [];
    const families = inputs.map(
        (input) => INPUT_FAMILIES[normalizedExtension(input)],
    );
    if (families.some((family) => !family)) return [];
    return Object.keys(FILTERS[families[0]]).filter((format) =>
        families.every((family) => Boolean(FILTERS[family][format])),
    );
}

function recipe(
    inputs: ToolInput[],
    executable?: string,
    unavailableReason?: string,
): FileToolRecipe[] {
    if (!inputs.some((input) => INPUT_FAMILIES[normalizedExtension(input)]))
        return [];
    const formats = supportedFormats(inputs);
    if (!formats.length) {
        return [
            {
                id: RECIPE_ID,
                label: "Convert office document",
                group: "convert",
                available: false,
                reason: "These office file types cannot be converted together.",
            },
        ];
    }
    if (!executable) {
        return [
            {
                id: RECIPE_ID,
                label: "Convert office document",
                group: "convert",
                formats,
                available: false,
                reason:
                    unavailableReason ??
                    "LibreOffice is not installed or could not be found.",
            },
        ];
    }
    return [
        {
            id: RECIPE_ID,
            label: "Convert office document",
            group: "convert",
            formats,
            available: true,
        },
    ];
}

function safeStem(name: string): string {
    const original = basename(name, extname(name)).replace(
        /[<>:"/\\|?*]/g,
        "_",
    );
    return (
        [...original]
            .map((character) =>
                character.charCodeAt(0) < 32 ? "_" : character,
            )
            .join("") || "document"
    );
}

function assertInput(input: ToolInput): Family {
    const family = INPUT_FAMILIES[normalizedExtension(input)];
    if (!family)
        throw new Error(`Unsupported office input format: ${input.extension}`);
    if (
        !isAbsolute(input.path) ||
        !existsSync(input.path) ||
        !statSync(input.path).isFile()
    )
        throw new Error("Office input must be an existing absolute file path");
    if (
        extname(input.path).slice(1).toLowerCase() !==
        normalizedExtension(input)
    )
        throw new Error(
            "Office input extension does not match its source metadata",
        );
    if (statSync(input.path).size > MAX_INPUT_BYTES)
        throw new Error("Office input exceeds the 512 MiB limit");
    return family;
}

function writeSecureProfile(profile: string): void {
    mkdirSync(join(profile, "user"), { recursive: true });
    writeFileSync(
        join(profile, "user", "registrymodifications.xcu"),
        `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
  <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`,
        { encoding: "utf8", flag: "wx" },
    );
}

class OfficeProcessTerminationError extends Error {
    readonly preserveWork = true;
}

function pidIsLive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function terminateOwnedProcess(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (!pidIsLive(pid)) return true;
    if (process.platform === "win32") {
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot) return false;
        const taskkill = join(systemRoot, "System32", "taskkill.exe");
        if (!existsSync(taskkill)) return false;
        const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
        });
        return result.status === 0 || !pidIsLive(pid);
    }
    try {
        process.kill(-pid, "SIGTERM");
        return true;
    } catch {
        return !pidIsLive(pid);
    }
}

function runProcess(
    executable: string,
    args: string[],
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted)
        return Promise.reject(
            new DOMException("Operation aborted", "AbortError"),
        );
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(executable, args, {
            detached: process.platform !== "win32",
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let settled = false;
        let terminationError: Error | undefined;
        let terminationGuard: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(terminationGuard);
            signal.removeEventListener("abort", abort);
            if (error) rejectPromise(error);
            else resolvePromise();
        };
        const requestTermination = (error: Error) => {
            if (terminationError || settled) return;
            terminationError = error;
            const pid = child.pid;
            const requested =
                typeof pid === "number" && terminateOwnedProcess(pid);
            terminationGuard = setTimeout(() => {
                if (settled) return;
                finish(
                    new OfficeProcessTerminationError(
                        requested
                            ? "LibreOffice did not close after termination was requested; temporary work was preserved."
                            : "LibreOffice could not be terminated safely; temporary work was preserved.",
                    ),
                );
            }, TERMINATION_GRACE_MS);
            terminationGuard.unref();
        };
        const abort = () =>
            requestTermination(
                new DOMException("Operation aborted", "AbortError"),
            );
        const timer = setTimeout(() => {
            requestTermination(new Error("LibreOffice conversion timed out"));
        }, TIMEOUT_MS);
        timer.unref();
        signal.addEventListener("abort", abort, { once: true });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
            if (terminationError) finish(terminationError);
            else if (code === 0) finish();
            else
                finish(
                    new Error(
                        `LibreOffice conversion failed (${String(code)})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
                    ),
                );
        });
    });
}

function zipEntries(path: string): Promise<Set<string>> {
    return new Promise((resolvePromise, rejectPromise) => {
        yauzl.open(path, { lazyEntries: true }, (error, archive) => {
            if (error || !archive) {
                rejectPromise(new Error("Invalid ZIP office output"));
                return;
            }
            const entries = new Set<string>();
            archive.on("error", () =>
                rejectPromise(new Error("Invalid ZIP office output")),
            );
            archive.on("entry", (entry) => {
                entries.add(entry.fileName.replaceAll("\\", "/"));
                archive.readEntry();
            });
            archive.on("end", () => resolvePromise(entries));
            archive.readEntry();
        });
    });
}

async function validateOutput(
    path: string,
    format: string,
    directory: string,
): Promise<void> {
    if (
        !existsSync(path) ||
        !statSync(path).isFile() ||
        statSync(path).size === 0
    )
        throw new Error("LibreOffice did not produce an output file");
    if (statSync(path).size > MAX_OUTPUT_BYTES)
        throw new Error("Office output exceeds the 1 GiB limit");
    const header = readFileSync(path).subarray(0, 8);
    if (format === "pdf" && !header.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new Error("LibreOffice produced an invalid PDF");
    if (
        ["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"].includes(format)
    ) {
        if (header[0] !== 0x50 || header[1] !== 0x4b)
            throw new Error(
                "LibreOffice produced an invalid ZIP office document",
            );
        const entries = await zipEntries(path);
        const required: Record<string, string[]> = {
            docx: ["[Content_Types].xml", "word/document.xml"],
            xlsx: ["[Content_Types].xml", "xl/workbook.xml"],
            pptx: ["[Content_Types].xml", "ppt/presentation.xml"],
            odt: ["mimetype", "content.xml"],
            ods: ["mimetype", "content.xml"],
            odp: ["mimetype", "content.xml"],
            epub: ["mimetype", "META-INF/container.xml"],
        };
        if (required[format].some((entry) => !entries.has(entry)))
            throw new Error(
                `LibreOffice produced an incomplete ${format.toUpperCase()} file`,
            );
    }
    if (
        format === "rtf" &&
        !readFileSync(path).subarray(0, 5).equals(Buffer.from("{\\rtf"))
    )
        throw new Error("LibreOffice produced an invalid RTF file");
    if (format === "html") {
        const siblings = readdirSync(directory).filter(
            (name) => resolve(directory, name) !== resolve(path),
        );
        if (siblings.length)
            throw new Error("HTML conversion produced unsafe external files");
        const html = readFileSync(path, "utf8");
        if (!/<(?:!doctype|html|head|body)\b/i.test(html))
            throw new Error("LibreOffice produced invalid HTML");
        if (/(?:src|href)\s*=\s*["'](?:file:|\/|\\|\.\.)/i.test(html))
            throw new Error(
                "HTML conversion contains an unsafe external file path",
            );
    }
    if (["txt", "csv", "tsv"].includes(format)) {
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(
                readFileSync(path),
            );
        } catch {
            throw new Error("LibreOffice produced invalid UTF-8 text");
        }
    }
}

function finalOutputPath(
    outputDir: string,
    stem: string,
    format: string,
): string {
    let index = 1;
    let candidate = join(outputDir, `${stem}.${format}`);
    while (existsSync(candidate)) {
        index++;
        candidate = join(outputDir, `${stem}-${index}.${format}`);
    }
    return candidate;
}

export function createOfficeTools({
    executable: configuredExecutable,
}: { executable?: string } = {}): FileToolEngine {
    const masRestricted = Boolean(process.mas);
    let detected = false;
    let executable: string | undefined;
    const resolveExecutable = () => {
        if (masRestricted) return undefined;
        if (!detected) {
            executable = findExecutable(configuredExecutable);
            detected = true;
        }
        return executable;
    };

    return {
        recipes(inputs) {
            return recipe(
                inputs,
                resolveExecutable(),
                masRestricted ? MAS_UNAVAILABLE_REASON : undefined,
            );
        },
        async run(context: ToolContext) {
            if (masRestricted) throw new Error(MAS_UNAVAILABLE_REASON);
            if (context.recipe !== RECIPE_ID)
                throw new Error(`Unknown recipe: ${context.recipe}`);
            const office = resolveExecutable();
            if (!office)
                throw new Error(
                    "LibreOffice is not installed or could not be found.",
                );
            const format = context.options.format?.toLowerCase();
            if (!format) throw new Error("An output format is required");
            if (!context.inputs.length)
                throw new Error("No input files selected");
            const formats = supportedFormats(context.inputs);
            if (!formats.includes(format))
                throw new Error(
                    `Office output format ${format} is not valid for this selection`,
                );
            mkdirSync(context.outputDir, { recursive: true });
            const paths: string[] = [];
            for (const [index, input] of context.inputs.entries()) {
                if (context.signal.aborted)
                    throw new DOMException("Operation aborted", "AbortError");
                const family = assertInput(input);
                const filter = FILTERS[family][format];
                const work = join(context.outputDir, `.office-${randomUUID()}`);
                const inputDir = join(work, "input");
                const convertedDir = join(work, "converted");
                const profile = join(work, "profile");
                mkdirSync(inputDir, { recursive: true });
                mkdirSync(convertedDir, { recursive: true });
                writeSecureProfile(profile);
                const sourceName = `${safeStem(input.name)}.${normalizedExtension(input)}`;
                const stagedInput = join(inputDir, sourceName);
                copyFileSync(input.path, stagedInput, constants.COPYFILE_EXCL);
                let preserveWork = false;
                try {
                    await runProcess(
                        office,
                        [
                            `-env:UserInstallation=${pathToFileURL(profile).href}`,
                            "--headless",
                            "--nologo",
                            "--nodefault",
                            "--nofirststartwizard",
                            "--norestore",
                            "--convert-to",
                            `${filter.extension}:${filter.name}`,
                            "--outdir",
                            convertedDir,
                            stagedInput,
                        ],
                        context.signal,
                    );
                    if (context.signal.aborted)
                        throw new DOMException(
                            "Operation aborted",
                            "AbortError",
                        );
                    const produced = join(
                        convertedDir,
                        `${safeStem(input.name)}.${format}`,
                    );
                    await validateOutput(produced, format, convertedDir);
                    const destination = finalOutputPath(
                        context.outputDir,
                        safeStem(input.name),
                        format,
                    );
                    copyFileSync(
                        produced,
                        destination,
                        constants.COPYFILE_EXCL,
                    );
                    paths.push(destination);
                    context.progress(
                        ((index + 1) / context.inputs.length) * 100,
                    );
                } catch (error) {
                    preserveWork =
                        error instanceof OfficeProcessTerminationError &&
                        error.preserveWork;
                    throw error;
                } finally {
                    if (!preserveWork)
                        rmSync(work, { recursive: true, force: true });
                }
            }
            return { paths, warnings: [LAYOUT_WARNING] };
        },
    };
}
