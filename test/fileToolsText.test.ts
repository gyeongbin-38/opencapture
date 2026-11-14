import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textTools } from "../src/main/fileToolsText";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

let fixture = "";
let outputDir = "";

beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "opencapture-text-tools-"));
    outputDir = join(fixture, "output");
    mkdirSync(outputDir);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function input(name: string, content: string | Uint8Array): ToolInput {
    const path = join(fixture, name);
    writeFileSync(path, content);
    return {
        id: name,
        name,
        path,
        size: Buffer.byteLength(content),
        extension: name.slice(name.lastIndexOf(".") + 1),
        kind: "document",
    };
}

async function run(
    source: ToolInput,
    recipe: string,
    format: string,
    signal = new AbortController().signal,
) {
    const progress: number[] = [];
    const context: ToolContext = {
        inputs: [source],
        recipe,
        options: { format },
        outputDir,
        signal,
        progress: (value) => progress.push(value),
    };
    const result = await textTools.run(context);
    return {
        ...result,
        progress,
        text: readFileSync(result.paths[0], "utf8"),
    };
}

describe("text recipes", () => {
    it("advertises fixed supported recipes and honest unavailable formats", () => {
        const supported = textTools.recipes([input("notes.md", "# Notes")]);
        expect(supported).toEqual([
            expect.objectContaining({
                id: "text-convert",
                formats: ["txt", "md", "html"],
                available: true,
            }),
        ]);

        for (const extension of [
            "docx",
            "pages",
            "epub",
            "ppt",
            "pptx",
            "pdf",
        ]) {
            expect(
                textTools.recipes([input(`source.${extension}`, "fixture")]),
            ).toEqual([
                expect.objectContaining({
                    id: "text-convert",
                    available: false,
                    reason: expect.stringContaining(`.${extension}`),
                }),
            ]);
        }
        for (const extension of ["xls", "xlsx", "ods"]) {
            expect(
                textTools.recipes([input(`source.${extension}`, "fixture")]),
            ).toEqual([
                expect.objectContaining({
                    id: "table-convert",
                    available: false,
                    reason: expect.stringContaining(`.${extension}`),
                }),
            ]);
        }
    });

    it("renders Markdown without allowing raw HTML through", async () => {
        const result = await run(
            input(
                "unsafe.md",
                "# Title\n\n**safe** <script>globalThis.pwned = true</script>",
            ),
            "text-convert",
            "html",
        );

        expect(result.text).toContain("<h1>Title</h1>");
        expect(result.text).toContain("<strong>safe</strong>");
        expect(result.text).not.toContain("<script>");
        expect(result.text).toContain("&lt;script&gt;");
        expect(result.progress).toEqual([100]);

        const plain = await run(
            input(
                "plain.md",
                "# Heading\n\n**bold** and [link](https://example.com)",
            ),
            "text-convert",
            "txt",
        );
        expect(plain.text).toBe("Heading\n\nbold and link");
    });

    it("extracts HTML text with entities without evaluating hidden code", async () => {
        const result = await run(
            input(
                "unsafe.html",
                '<h1>Hello &amp; 안녕</h1><script>throw new Error("executed")</script><p>Next<br>line</p>',
            ),
            "text-convert",
            "txt",
        );

        expect(result.text).toBe("Hello & 안녕\nNext\nline");
        expect(result.text).not.toContain("executed");
    });

    it("accepts BOM-declared Unicode and rejects malformed encoding", async () => {
        const bom = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from("한글 😀", "utf8"),
        ]);
        expect(
            (await run(input("bom.txt", bom), "text-convert", "md")).text,
        ).toBe("한글 😀");

        await expect(
            run(
                input("broken.txt", Uint8Array.from([0xc3, 0x28])),
                "text-convert",
                "md",
            ),
        ).rejects.toThrow("valid UTF-8");
    });

    it("validates destination format and aborts before writing", async () => {
        await expect(
            run(input("notes.txt", "hello"), "text-convert", "pdf"),
        ).rejects.toThrow("not valid");
        const controller = new AbortController();
        controller.abort();
        await expect(
            run(
                input("cancel.txt", "hello"),
                "text-convert",
                "html",
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(readdirSync(outputDir)).toEqual([]);
    });
});

describe("subtitle recipes", () => {
    it("converts SRT to VTT with validated timestamps", async () => {
        const result = await run(
            input(
                "captions.srt",
                "1\n00:00:01,250 --> 00:00:03,500\nHello\nworld\n\n2\n00:01:00,000 --> 00:01:02,010\n끝\n",
            ),
            "subtitle-convert",
            "vtt",
        );
        expect(result.text).toBe(
            "WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nHello\nworld\n\n00:01:00.000 --> 00:01:02.010\n끝\n",
        );
    });

    it("converts ASS dialogue text and preserves commas", async () => {
        const result = await run(
            input(
                "captions.ass",
                "[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,{\\i1}Hello, world\\N둘째 줄\n",
            ),
            "subtitle-convert",
            "txt",
        );
        expect(result.text).toBe("Hello, world\n둘째 줄\n");
    });

    it("rejects malformed or reversed subtitle timestamps", async () => {
        await expect(
            run(
                input(
                    "bad.srt",
                    "1\n00:00:03,000 --> 00:00:02,000\nBackwards\n",
                ),
                "subtitle-convert",
                "vtt",
            ),
        ).rejects.toThrow("after its start");
        await expect(
            run(
                input("bad.vtt", "WEBVTT\n\n00:99.000 --> 00:02.000\nBad\n"),
                "subtitle-convert",
                "srt",
            ),
        ).rejects.toThrow("Invalid VTT timestamp");
    });
});

describe("table recipes", () => {
    it("round-trips quoted CSV fields through TSV and JSON", async () => {
        const csv = input(
            "table.csv",
            'name,note,value\n"A, B","line 1\nline 2","say ""hello"""\n',
        );
        const tsv = await run(csv, "table-convert", "tsv");
        expect(tsv.text).toBe(
            'name\tnote\tvalue\nA, B\t"line 1\nline 2"\t"say ""hello"""\n',
        );

        const tsvInput: ToolInput = {
            ...csv,
            id: "table.tsv",
            name: "table.tsv",
            path: tsv.paths[0],
            extension: "tsv",
            size: Buffer.byteLength(tsv.text),
        };
        const json = await run(tsvInput, "table-convert", "json");
        expect(JSON.parse(json.text)).toEqual([
            {
                name: "A, B",
                note: "line 1\nline 2",
                value: 'say "hello"',
            },
        ]);
    });

    it("converts object JSON and preserves formula-like text with a warning", async () => {
        const result = await run(
            input(
                "rows.json",
                JSON.stringify([
                    { name: "Alice", value: "=1+1" },
                    { name: "Bob", value: "@user" },
                ]),
            ),
            "table-convert",
            "csv",
        );
        expect(result.text).toBe("name,value\nAlice,=1+1\nBob,@user\n");
        expect(result.warnings).toEqual([
            "Formula-like cell values were preserved; spreadsheet applications may evaluate them.",
        ]);
    });

    it("rejects unterminated quoted data", async () => {
        await expect(
            run(
                input("bad.tsv", 'a\tb\n"unterminated\tvalue'),
                "table-convert",
                "json",
            ),
        ).rejects.toThrow("Unterminated quoted field");
        await expect(
            run(
                input("bad.csv", 'a,b\n"closed"junk,value'),
                "table-convert",
                "json",
            ),
        ).rejects.toThrow("Unexpected character after quoted field");
    });

    it("enforces row and column bounds", async () => {
        await expect(
            run(
                input("wide.csv", `${"x,".repeat(4096)}x\n`),
                "table-convert",
                "json",
            ),
        ).rejects.toThrow("Too many columns");
        await expect(
            run(
                input("long.csv", "x\n".repeat(100_001)),
                "table-convert",
                "json",
            ),
        ).rejects.toThrow("Too many rows");
    });

    it("writes only unique files inside the staging directory", async () => {
        const first = input("same.txt", "one");
        const secondPath = join(fixture, "other", "same.txt");
        mkdirSync(join(fixture, "other"));
        writeFileSync(secondPath, "two");
        const second = { ...first, id: "two", path: secondPath };
        const context: ToolContext = {
            inputs: [first, second],
            recipe: "text-convert",
            options: { format: "html" },
            outputDir,
            signal: new AbortController().signal,
            progress: () => {},
        };
        const result = await textTools.run(context);
        expect(result.paths.map((path) => basename(path))).toEqual([
            "same.html",
            "same-2.html",
        ]);
        expect(
            result.paths.every((path) => path.startsWith(`${outputDir}\\`)),
        ).toBe(true);
    });
});
