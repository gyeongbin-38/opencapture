import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Remarkable } from "remarkable";
import type { FileToolRecipe } from "../../lib/fileTools";
import type { FileToolEngine, ToolContext, ToolInput } from "./fileToolsTypes";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 500_000;
const MAX_LINE_LENGTH = 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 4096;
const MAX_CUES = 100_000;

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "html", "htm"]);
const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt", "ass", "ssa"]);
const TABLE_EXTENSIONS = new Set(["csv", "tsv", "json"]);
const UNAVAILABLE_TEXT = new Set([
    "docx",
    "pages",
    "epub",
    "ppt",
    "pptx",
    "pdf",
]);
const UNAVAILABLE_TABLE = new Set(["xls", "xlsx", "ods"]);

type Cue = { start: number; end: number; text: string };

function extension(input: ToolInput): string {
    return input.extension.toLowerCase().replace(/^\./, "");
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted)
        throw new DOMException("Operation aborted", "AbortError");
}

function decodeInput(input: ToolInput): string {
    const bytes = readFileSync(input.path);
    if (bytes.byteLength > MAX_BYTES)
        throw new Error(
            `Input exceeds the ${MAX_BYTES / 1024 / 1024} MiB limit`,
        );
    let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
    let offset = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offset = 3;
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = "utf-16le";
        offset = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = "utf-16be";
        offset = 2;
    }
    let text: string;
    try {
        text = new TextDecoder(encoding, { fatal: true }).decode(
            bytes.subarray(offset),
        );
    } catch {
        throw new Error(
            "Input is not valid UTF-8 or BOM-declared Unicode text",
        );
    }
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > MAX_LINES) throw new Error("Input has too many lines");
    if (lines.some((line) => line.length > MAX_LINE_LENGTH))
        throw new Error("Input contains an excessively long line");
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function decodeEntity(entity: string): string {
    const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
    };
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const value = Number.parseInt(entity.slice(2), 16);
        if (Number.isFinite(value) && value <= 0x10ffff)
            return String.fromCodePoint(value);
    } else if (entity.startsWith("#")) {
        const value = Number.parseInt(entity.slice(1), 10);
        if (Number.isFinite(value) && value <= 0x10ffff)
            return String.fromCodePoint(value);
    }
    return named[entity] ?? `&${entity};`;
}

function htmlToText(source: string): string {
    let output = "";
    let index = 0;
    let skipped = "";
    const blockTags = new Set([
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
        "tr",
    ]);
    while (index < source.length) {
        if (source[index] !== "<") {
            const next = source.indexOf("<", index);
            const end = next < 0 ? source.length : next;
            if (!skipped) {
                output += source
                    .slice(index, end)
                    .replace(/&([^;\s]{1,32});/g, (_, entity: string) =>
                        decodeEntity(entity),
                    );
            }
            index = end;
            continue;
        }
        const close = source.indexOf(">", index + 1);
        if (close < 0) throw new Error("Malformed HTML tag");
        const raw = source.slice(index + 1, close).trim();
        if (raw.startsWith("!--")) {
            const commentEnd = source.indexOf("-->", index + 4);
            if (commentEnd < 0) throw new Error("Unterminated HTML comment");
            index = commentEnd + 3;
            continue;
        }
        const closing = raw.startsWith("/");
        const tag = raw
            .replace(/^\//, "")
            .split(/[\s/>]/, 1)[0]
            .toLowerCase();
        if (tag === "script" || tag === "style") {
            if (closing && skipped === tag) skipped = "";
            else if (!closing && !skipped) skipped = tag;
        } else if (!skipped && blockTags.has(tag)) {
            if (output && !output.endsWith("\n")) output += "\n";
            if (tag === "li" && !closing) output += "- ";
        }
        index = close + 1;
    }
    return output
        .split("\n")
        .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function convertText(source: string, from: string, to: string): string {
    const markdown = from === "md" || from === "markdown";
    const plain =
        from === "html" || from === "htm"
            ? htmlToText(source)
            : markdown
              ? htmlToText(
                    new Remarkable({ html: false, typographer: false }).render(
                        source,
                    ),
                )
              : source;
    if (to === "txt") return plain;
    if (to === "md") return plain;
    if (to === "html") {
        if (markdown) {
            return new Remarkable({ html: false, typographer: false }).render(
                source,
            );
        }
        return `<!doctype html>\n<meta charset="utf-8">\n<pre>${escapeHtml(plain)}</pre>\n`;
    }
    throw new Error(`Unsupported text output format: ${to}`);
}

function parseSrtTimestamp(value: string): number {
    const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value.trim());
    if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
    const [, h, m, s, ms] = match.map(Number);
    if (m > 59 || s > 59) throw new Error(`Invalid SRT timestamp: ${value}`);
    return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

function parseVttTimestamp(value: string): number {
    const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value.trim());
    if (!match) throw new Error(`Invalid VTT timestamp: ${value}`);
    const h = Number(match[1] ?? 0);
    const m = Number(match[2]);
    const s = Number(match[3]);
    const ms = Number(match[4]);
    if (m > 59 || s > 59) throw new Error(`Invalid VTT timestamp: ${value}`);
    return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

function validCue(start: number, end: number, text: string): Cue {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        throw new Error("Subtitle cue end must be after its start");
    return { start, end, text };
}

function parseSrt(source: string): Cue[] {
    const blocks = source.trim().split(/\n{2,}/);
    const cues: Cue[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
        const timing = lines.shift()?.split(/\s+-->\s+/);
        if (!timing || timing.length !== 2)
            throw new Error("Invalid SRT cue timing");
        cues.push(
            validCue(
                parseSrtTimestamp(timing[0]),
                parseSrtTimestamp(timing[1]),
                lines.join("\n"),
            ),
        );
        if (cues.length > MAX_CUES) throw new Error("Too many subtitle cues");
    }
    return cues;
}

function parseVtt(source: string): Cue[] {
    const normalized = source.replace(/^\uFEFF/, "");
    if (!normalized.startsWith("WEBVTT"))
        throw new Error("Missing WEBVTT header");
    const blocks = normalized
        .slice(normalized.indexOf("\n") + 1)
        .trim()
        .split(/\n{2,}/);
    const cues: Cue[] = [];
    for (const block of blocks.filter(Boolean)) {
        const lines = block.split("\n");
        if (!lines[0].includes("-->")) lines.shift();
        const timing = lines.shift()?.split(/\s+-->\s+/);
        if (!timing || timing.length !== 2)
            throw new Error("Invalid VTT cue timing");
        const end = timing[1].split(/\s+/, 1)[0];
        cues.push(
            validCue(
                parseVttTimestamp(timing[0]),
                parseVttTimestamp(end),
                lines.join("\n"),
            ),
        );
        if (cues.length > MAX_CUES) throw new Error("Too many subtitle cues");
    }
    return cues;
}

function parseAssTimestamp(value: string): number {
    const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim());
    if (!match) throw new Error(`Invalid ASS timestamp: ${value}`);
    const [, h, m, s, cs] = match.map(Number);
    if (m > 59 || s > 59) throw new Error(`Invalid ASS timestamp: ${value}`);
    return ((h * 60 + m) * 60 + s) * 1000 + cs * 10;
}

function parseAss(source: string): Cue[] {
    let inEvents = false;
    let fields: string[] = [];
    const cues: Cue[] = [];
    for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (/^\[events\]$/i.test(trimmed)) {
            inEvents = true;
            continue;
        }
        if (/^\[/.test(trimmed)) inEvents = false;
        if (!inEvents) continue;
        if (/^format:/i.test(trimmed)) {
            fields = trimmed
                .slice(trimmed.indexOf(":") + 1)
                .split(",")
                .map((field) => field.trim().toLowerCase());
            continue;
        }
        if (!/^dialogue:/i.test(trimmed)) continue;
        if (!fields.length) throw new Error("ASS Events format is missing");
        const values: string[] = [];
        let remainder = trimmed.slice(trimmed.indexOf(":") + 1);
        for (let index = 1; index < fields.length; index++) {
            const comma = remainder.indexOf(",");
            if (comma < 0) throw new Error("Invalid ASS dialogue");
            values.push(remainder.slice(0, comma));
            remainder = remainder.slice(comma + 1);
        }
        values.push(remainder);
        const start = values[fields.indexOf("start")];
        const end = values[fields.indexOf("end")];
        const textIndex = fields.indexOf("text");
        if (textIndex < 0 || start === undefined || end === undefined)
            throw new Error(
                "ASS Events format needs Start, End and Text fields",
            );
        if (textIndex !== fields.length - 1)
            throw new Error("ASS Text field must be last");
        const text = values[textIndex]
            .replaceAll("\\N", "\n")
            .replaceAll("\\n", "\n")
            .replace(/\{[^}]*\}/g, "");
        cues.push(
            validCue(parseAssTimestamp(start), parseAssTimestamp(end), text),
        );
        if (cues.length > MAX_CUES) throw new Error("Too many subtitle cues");
    }
    return cues;
}

function pad(value: number, size = 2): string {
    return String(value).padStart(size, "0");
}

function subtitleTime(value: number, separator: "," | "."): string {
    const hours = Math.floor(value / 3_600_000);
    const minutes = Math.floor((value % 3_600_000) / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    const millis = value % 1000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

function renderSubtitles(cues: Cue[], format: string): string {
    if (format === "txt")
        return `${cues.map((cue) => cue.text).join("\n\n")}\n`;
    if (format === "srt") {
        return `${cues
            .map(
                (cue, index) =>
                    `${index + 1}\n${subtitleTime(cue.start, ",")} --> ${subtitleTime(cue.end, ",")}\n${cue.text}`,
            )
            .join("\n\n")}\n`;
    }
    if (format === "vtt") {
        return `WEBVTT\n\n${cues
            .map(
                (cue) =>
                    `${subtitleTime(cue.start, ".")} --> ${subtitleTime(cue.end, ".")}\n${cue.text}`,
            )
            .join("\n\n")}\n`;
    }
    throw new Error(`Unsupported subtitle output format: ${format}`);
}

function parseDelimited(source: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let value = "";
    let quoted = false;
    let quoteClosed = false;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            if (character === '"') {
                if (source[index + 1] === '"') {
                    value += '"';
                    index++;
                } else {
                    quoted = false;
                    quoteClosed = true;
                }
            } else value += character;
            continue;
        }
        if (quoteClosed) {
            if (character !== delimiter && character !== "\n")
                throw new Error("Unexpected character after quoted field");
        } else if (character === '"') {
            if (value) throw new Error("Unexpected quote in unquoted field");
            quoted = true;
            continue;
        }
        if (character === delimiter) {
            row.push(value);
            value = "";
            quoteClosed = false;
            if (row.length > MAX_COLUMNS) throw new Error("Too many columns");
        } else if (character === "\n") {
            row.push(value);
            rows.push(row);
            row = [];
            value = "";
            quoteClosed = false;
            if (rows.length > MAX_ROWS) throw new Error("Too many rows");
        } else if (!quoteClosed) value += character;
    }
    if (quoted) throw new Error("Unterminated quoted field");
    if (value || row.length) {
        row.push(value);
        rows.push(row);
    }
    if (rows.some((item) => item.length > MAX_COLUMNS))
        throw new Error("Too many columns");
    return rows;
}

function parseJsonTable(source: string): string[][] {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error("Invalid JSON table");
    }
    if (!Array.isArray(value)) throw new Error("JSON table must be an array");
    if (value.length > MAX_ROWS) throw new Error("Too many rows");
    if (value.length === 0) return [];
    if (value.every(Array.isArray)) {
        const rows = value.map((row) =>
            row.map((cell) => (cell == null ? "" : String(cell))),
        );
        if (rows.some((row) => row.length > MAX_COLUMNS))
            throw new Error("Too many columns");
        return rows;
    }
    if (
        !value.every(
            (row) => row && typeof row === "object" && !Array.isArray(row),
        )
    ) {
        throw new Error("JSON rows must all be arrays or all be objects");
    }
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const row of value as Record<string, unknown>[]) {
        for (const key of Object.keys(row)) {
            if (!seen.has(key)) {
                seen.add(key);
                headers.push(key);
            }
        }
    }
    if (headers.length > MAX_COLUMNS) throw new Error("Too many columns");
    return [
        headers,
        ...(value as Record<string, unknown>[]).map((row) =>
            headers.map((header) => {
                const cell = row[header];
                return cell == null
                    ? ""
                    : typeof cell === "object"
                      ? JSON.stringify(cell)
                      : String(cell);
            }),
        ),
    ];
}

function quoteCell(value: string, delimiter: string): string {
    return value.includes(delimiter) || /["\n\r]/.test(value)
        ? `"${value.replaceAll('"', '""')}"`
        : value;
}

function renderTable(rows: string[][], format: string): string {
    if (format === "json") {
        if (rows.length === 0) return "[]\n";
        const [headers, ...data] = rows;
        const unique = new Set(headers).size === headers.length;
        if (unique && headers.every(Boolean)) {
            return `${JSON.stringify(
                data.map((row) =>
                    Object.fromEntries(
                        headers.map((header, index) => [
                            header,
                            row[index] ?? "",
                        ]),
                    ),
                ),
                null,
                2,
            )}\n`;
        }
        return `${JSON.stringify(rows, null, 2)}\n`;
    }
    const delimiter = format === "csv" ? "," : format === "tsv" ? "\t" : "";
    if (!delimiter)
        throw new Error(`Unsupported table output format: ${format}`);
    return `${rows
        .map((row) =>
            row.map((cell) => quoteCell(cell, delimiter)).join(delimiter),
        )
        .join("\n")}\n`;
}

function formulaWarning(rows: string[][]): string[] | undefined {
    return rows.some((row) => row.some((cell) => /^[=+\-@]/.test(cell)))
        ? [
              "Formula-like cell values were preserved; spreadsheet applications may evaluate them.",
          ]
        : undefined;
}

function unavailableRecipe(
    id: string,
    label: string,
    extensions: string[],
): FileToolRecipe {
    return {
        id,
        label,
        group: "convert",
        available: false,
        reason: `Conversion is unavailable for ${extensions.map((item) => `.${item}`).join(", ")}`,
    };
}

function recipeFor(inputs: ToolInput[]): FileToolRecipe[] {
    if (!inputs.length) return [];
    const extensions = [...new Set(inputs.map(extension))];
    if (extensions.every((item) => TEXT_EXTENSIONS.has(item))) {
        return [
            {
                id: "text-convert",
                label: "Convert text document",
                group: "convert",
                formats: ["txt", "md", "html"],
                available: true,
            },
        ];
    }
    if (extensions.every((item) => SUBTITLE_EXTENSIONS.has(item))) {
        return [
            {
                id: "subtitle-convert",
                label: "Convert subtitles",
                group: "convert",
                formats: ["srt", "vtt", "txt"],
                available: true,
            },
        ];
    }
    if (extensions.every((item) => TABLE_EXTENSIONS.has(item))) {
        return [
            {
                id: "table-convert",
                label: "Convert table data",
                group: "convert",
                formats: ["csv", "tsv", "json"],
                available: true,
            },
        ];
    }
    const textUnavailable = extensions.filter((item) =>
        UNAVAILABLE_TEXT.has(item),
    );
    if (textUnavailable.length)
        return [
            unavailableRecipe(
                "text-convert",
                "Convert text document",
                textUnavailable,
            ),
        ];
    const tableUnavailable = extensions.filter((item) =>
        UNAVAILABLE_TABLE.has(item),
    );
    if (tableUnavailable.length)
        return [
            unavailableRecipe(
                "table-convert",
                "Convert table data",
                tableUnavailable,
            ),
        ];
    return [];
}

function nextOutputPath(
    context: ToolContext,
    input: ToolInput,
    format: string,
    reserved: Set<string>,
): string {
    const originalExtension = extname(input.name);
    const visibleStem = basename(input.name, originalExtension).replace(
        /[<>:"/\\|?*]/g,
        "_",
    );
    const stem = [...visibleStem]
        .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
        .join("");
    let suffix = 1;
    let candidate = join(context.outputDir, `${stem || "output"}.${format}`);
    while (reserved.has(candidate) || existsSync(candidate)) {
        suffix++;
        candidate = join(
            context.outputDir,
            `${stem || "output"}-${suffix}.${format}`,
        );
    }
    reserved.add(candidate);
    return candidate;
}

export const textTools: FileToolEngine = {
    recipes: recipeFor,
    async run(context) {
        const format = context.options.format?.toLowerCase();
        if (!format) throw new Error("An output format is required");
        if (!context.inputs.length) throw new Error("No input files selected");
        const recipe = recipeFor(context.inputs).find(
            (item) => item.id === context.recipe,
        );
        if (!recipe?.available)
            throw new Error(
                recipe?.reason ?? "Recipe is unavailable for these files",
            );
        if (!recipe.formats?.includes(format))
            throw new Error(
                `Output format ${format} is not valid for this recipe`,
            );
        mkdirSync(context.outputDir, { recursive: true });
        const paths: string[] = [];
        const warnings = new Set<string>();
        const reserved = new Set<string>();
        for (const [index, input] of context.inputs.entries()) {
            throwIfAborted(context.signal);
            const from = extension(input);
            const source = decodeInput(input);
            let output: string;
            if (context.recipe === "text-convert") {
                if (!TEXT_EXTENSIONS.has(from))
                    throw new Error(`Unsupported text input format: ${from}`);
                output = convertText(source, from, format);
            } else if (context.recipe === "subtitle-convert") {
                if (!SUBTITLE_EXTENSIONS.has(from))
                    throw new Error(
                        `Unsupported subtitle input format: ${from}`,
                    );
                const cues =
                    from === "srt"
                        ? parseSrt(source)
                        : from === "vtt"
                          ? parseVtt(source)
                          : parseAss(source);
                output = renderSubtitles(cues, format);
            } else if (context.recipe === "table-convert") {
                if (!TABLE_EXTENSIONS.has(from))
                    throw new Error(`Unsupported table input format: ${from}`);
                const rows =
                    from === "json"
                        ? parseJsonTable(source)
                        : parseDelimited(source, from === "csv" ? "," : "\t");
                for (const warning of formulaWarning(rows) ?? [])
                    warnings.add(warning);
                output = renderTable(rows, format);
            } else {
                throw new Error(`Unknown recipe: ${context.recipe}`);
            }
            throwIfAborted(context.signal);
            const outputPath = nextOutputPath(context, input, format, reserved);
            writeFileSync(outputPath, output, { encoding: "utf8", flag: "wx" });
            paths.push(outputPath);
            context.progress(((index + 1) / context.inputs.length) * 100);
        }
        return {
            paths,
            ...(warnings.size ? { warnings: [...warnings] } : {}),
        };
    },
};
