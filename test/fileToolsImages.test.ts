import { createHash } from "node:crypto";
import {
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
import type { FileToolOptions } from "../lib/fileTools";
import { imageTools } from "../src/main/fileToolsImages";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

vi.mock("electron", () => {
    const encode = (
        bitmap: Buffer,
        size: { width: number; height: number },
    ) => {
        const header = Buffer.alloc(8);
        header.writeUInt32LE(size.width, 0);
        header.writeUInt32LE(size.height, 4);
        return Buffer.concat([header, bitmap]);
    };
    const image = (
        bitmap: Buffer,
        size: { width: number; height: number },
    ) => ({
        getSize: () => ({ ...size }),
        isEmpty: () => size.width <= 0 || size.height <= 0,
        toBitmap: () => Buffer.from(bitmap),
        toPNG: () => encode(bitmap, size),
    });
    return {
        nativeImage: {
            createFromBuffer(value: Buffer) {
                const size = {
                    width: value.readUInt32LE(0),
                    height: value.readUInt32LE(4),
                };
                return image(value.subarray(8), size);
            },
            createFromBitmap(
                value: Buffer,
                size: { width: number; height: number },
            ) {
                return image(Buffer.from(value), size);
            },
        },
    };
});

const temporary: string[] = [];

const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "opencapture-image-tools-"));
    temporary.push(path);
    return path;
};

const encodeFixture = (width: number, height: number, bitmap: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(width, 0);
    header.writeUInt32LE(height, 4);
    return Buffer.concat([header, bitmap]);
};

const decodeFixture = (path: string) => {
    const value = readFileSync(path);
    return {
        width: value.readUInt32LE(0),
        height: value.readUInt32LE(4),
        bitmap: value.subarray(8),
    };
};

const coloredBitmap = (width: number, height: number) => {
    const value = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row++)
        for (let column = 0; column < width; column++) {
            const offset = (row * width + column) * 4;
            value.set(
                [column + 10, row + 20, row * width + column, 255],
                offset,
            );
        }
    return value;
};

const fixture = (directory: string, width = 4, height = 4) => {
    const path = join(directory, "colors.png");
    writeFileSync(
        path,
        encodeFixture(width, height, coloredBitmap(width, height)),
    );
    return {
        id: "source",
        name: basename(path),
        path,
        extension: "png",
        kind: "image",
        size: statSync(path).size,
    } satisfies ToolInput;
};

const context = (
    source: ToolInput,
    outputDir: string,
    options: FileToolOptions,
    signal = new AbortController().signal,
    progress = vi.fn(),
) =>
    ({
        inputs: [source],
        recipe: "image-fold",
        options,
        outputDir,
        signal,
        progress,
    }) satisfies ToolContext;

const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true });
});

describe("image fold tool", () => {
    it("advertises one-image fold controls", async () => {
        const directory = temp();
        const source = fixture(directory);
        const recipe = (await imageTools.recipes([source])).find(
            (item) => item.id === "image-fold",
        );
        expect(recipe).toMatchObject({
            label: "Fold image",
            group: "tools",
            available: true,
            options: ["foldAxis", "foldOffset", "foldSize"],
        });
        expect(await imageTools.recipes([source, source])).not.toContainEqual(
            expect.objectContaining({ id: "image-fold" }),
        );
    });

    it("removes a horizontal middle strip and stitches exact BGRA rows", async () => {
        const directory = temp();
        const output = temp();
        const source = fixture(directory, 3, 4);
        const originalHash = hash(source.path);
        const original = coloredBitmap(3, 4);
        const result = await imageTools.run(
            context(source, output, {
                foldAxis: "horizontal",
                foldOffset: 1,
                foldSize: 2,
            }),
        );
        const folded = decodeFixture(result.paths[0]);
        expect(folded).toMatchObject({ width: 3, height: 2 });
        expect(folded.bitmap).toEqual(
            Buffer.concat([
                original.subarray(0, 12),
                original.subarray(36, 48),
            ]),
        );
        expect(hash(source.path)).toBe(originalHash);
    });

    it("removes a vertical middle strip and stitches exact BGRA columns", async () => {
        const directory = temp();
        const output = temp();
        const source = fixture(directory, 4, 3);
        const original = coloredBitmap(4, 3);
        const result = await imageTools.run(
            context(source, output, {
                foldAxis: "vertical",
                foldOffset: 1,
                foldSize: 2,
            }),
        );
        const folded = decodeFixture(result.paths[0]);
        expect(folded).toMatchObject({ width: 2, height: 3 });
        const expected = Buffer.concat(
            [0, 1, 2].flatMap((row) => [
                original.subarray(row * 16, row * 16 + 4),
                original.subarray(row * 16 + 12, row * 16 + 16),
            ]),
        );
        expect(folded.bitmap).toEqual(expected);
    });

    it.each([
        [{ foldAxis: "diagonal", foldOffset: 1, foldSize: 1 }, /axis/],
        [
            { foldAxis: "horizontal", foldOffset: 0, foldSize: 1 },
            /positive integers/,
        ],
        [
            { foldAxis: "horizontal", foldOffset: 1.5, foldSize: 1 },
            /positive integers/,
        ],
        [
            { foldAxis: "horizontal", foldOffset: 1, foldSize: 0 },
            /positive integers/,
        ],
        [
            { foldAxis: "horizontal", foldOffset: 2, foldSize: 2 },
            /interior strip/,
        ],
        [
            { foldAxis: "horizontal", foldOffset: 1, foldSize: 1, width: 2 },
            /Unsupported image-fold option: width/,
        ],
    ])(
        "rejects invalid bounded options without output",
        async (options, error) => {
            const directory = temp();
            const output = temp();
            const source = fixture(directory);
            await expect(
                imageTools.run(
                    context(source, output, options as FileToolOptions),
                ),
            ).rejects.toThrow(error as RegExp);
            expect(readdirSync(output)).toEqual([]);
        },
    );

    it("rejects an invalid decoded bitmap length", async () => {
        const directory = temp();
        const output = temp();
        const source = fixture(directory);
        writeFileSync(source.path, encodeFixture(4, 4, Buffer.alloc(4)));
        await expect(
            imageTools.run(
                context(source, output, {
                    foldAxis: "horizontal",
                    foldOffset: 1,
                    foldSize: 1,
                }),
            ),
        ).rejects.toThrow(/invalid length/);
        expect(readdirSync(output)).toEqual([]);
    });

    it("honors pre-abort and never writes output", async () => {
        const directory = temp();
        const output = temp();
        const source = fixture(directory);
        const controller = new AbortController();
        controller.abort();
        await expect(
            imageTools.run(context(source, output, {}, controller.signal)),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(readdirSync(output)).toEqual([]);
    });

    it("checks cancellation while copying rows", async () => {
        const directory = temp();
        const output = temp();
        const source = fixture(directory, 4, 8);
        const controller = new AbortController();
        const progress = vi.fn(() => controller.abort());
        await expect(
            imageTools.run(
                context(
                    source,
                    output,
                    {
                        foldAxis: "horizontal",
                        foldOffset: 2,
                        foldSize: 2,
                    },
                    controller.signal,
                    progress,
                ),
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(readdirSync(output)).toEqual([]);
    });
});
