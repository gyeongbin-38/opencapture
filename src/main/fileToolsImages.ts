import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { nativeImage } from "electron";
import type { FileToolRecipe } from "../../lib/fileTools";
import { beautifyPng, imagesPdf } from "./captureBoardImages";
import type { FileToolEngine, ToolInput } from "./fileToolsTypes";

async function readImage(input: ToolInput) {
    const stat = await fs.stat(input.path);
    if (!stat.isFile() || stat.size > 32 * 1024 ** 2)
        throw new Error("Image exceeds 32 MiB.");
    const image = nativeImage.createFromBuffer(await fs.readFile(input.path));
    const size = image.getSize();
    if (
        image.isEmpty() ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width * size.height > 16_000_000
    )
        throw new Error(
            "A decodable image of at most 16 megapixels is required.",
        );
    return image;
}

function dimension(value: unknown, fallback: number) {
    if (value === undefined) return fallback;
    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > 8192
    )
        throw new Error("Invalid image dimension.");
    return value as number;
}

export const imageTools: FileToolEngine = {
    recipes(inputs) {
        if (!inputs.length || inputs.some((input) => input.kind !== "image"))
            return [];
        const single = inputs.length === 1;
        const recipes: FileToolRecipe[] = [
            {
                id: "image-pdf",
                label: "Create image PDF",
                group: "tools",
                available: true,
                multiple: inputs.length > 1,
            },
            ...(inputs.length > 1
                ? [
                      {
                          id: "image-collage",
                          minSources: 2,
                          label: "Create collage",
                          group: "tools" as const,
                          available: true,
                          multiple: true,
                          options: ["width", "height"] as (
                              | "width"
                              | "height"
                          )[],
                      },
                  ]
                : []),
        ];
        if (single)
            recipes.push(
                {
                    id: "image-frame",
                    label: "Frame image",
                    group: "tools",
                    available: true,
                },
                {
                    id: "image-redact",
                    label: "Redact image",
                    group: "tools",
                    available: true,
                    options: ["x", "y", "width", "height"],
                },
                {
                    id: "image-fold",
                    label: "Fold image",
                    group: "tools",
                    available: true,
                    options: ["foldAxis", "foldOffset", "foldSize"],
                },
            );
        return recipes;
    },
    async run(context) {
        const { inputs, recipe, options, signal, outputDir } = context;
        if (
            !inputs.length ||
            inputs.length > 100 ||
            inputs.some((input) => input.kind !== "image")
        )
            throw new Error("Choose 1–100 images.");
        signal.throwIfAborted();
        const stem = basename(inputs[0].name, extname(inputs[0].name)).slice(
            0,
            100,
        );
        let bytes: Buffer;
        let name: string;
        if (recipe === "image-pdf") {
            const data: string[] = [];
            let total = 0;
            for (const [index, input] of inputs.entries()) {
                signal.throwIfAborted();
                const image = await readImage(input);
                const dataURL = image.toDataURL();
                total += dataURL.length;
                if (total > 128 * 1024 ** 2)
                    throw new Error("PDF source images exceed 128 MiB.");
                data.push(dataURL);
                context.progress(((index + 1) / inputs.length) * 80);
            }
            bytes = imagesPdf(data);
            name = `${stem}-images.pdf`;
        } else if (recipe === "image-collage") {
            const width = dimension(options.width, 1920);
            const height = dimension(options.height, 1080);
            if (width * height > 16_000_000 || inputs.length < 2)
                throw new Error(
                    "Collage requires 2–100 images and at most 16 megapixels.",
                );
            const columns = Math.ceil(
                Math.sqrt((inputs.length * width) / height),
            );
            const rows = Math.ceil(inputs.length / columns);
            const cellWidth = Math.floor(width / columns);
            const cellHeight = Math.floor(height / rows);
            if (cellWidth < 12 || cellHeight < 12)
                throw new Error("Choose a larger collage size.");
            const bitmap = Buffer.alloc(width * height * 4);
            for (const [index, input] of inputs.entries()) {
                signal.throwIfAborted();
                const image = await readImage(input);
                const source = image.getSize();
                const scale = Math.min(
                    (cellWidth - 8) / source.width,
                    (cellHeight - 8) / source.height,
                );
                const thumbnail = image.resize({
                    width: Math.max(1, Math.floor(source.width * scale)),
                    height: Math.max(1, Math.floor(source.height * scale)),
                    quality: "best",
                });
                const size = thumbnail.getSize();
                const sourceBytes = thumbnail.toBitmap();
                const left =
                    (index % columns) * cellWidth +
                    Math.floor((cellWidth - size.width) / 2);
                const top =
                    Math.floor(index / columns) * cellHeight +
                    Math.floor((cellHeight - size.height) / 2);
                for (let row = 0; row < size.height; row++)
                    sourceBytes.copy(
                        bitmap,
                        ((top + row) * width + left) * 4,
                        row * size.width * 4,
                        (row + 1) * size.width * 4,
                    );
                context.progress(((index + 1) / inputs.length) * 95);
            }
            bytes = nativeImage
                .createFromBitmap(bitmap, { width, height })
                .toPNG();
            name = `${stem}-collage.png`;
        } else if (recipe === "image-frame") {
            if (inputs.length !== 1)
                throw new Error("Frame one image at a time.");
            const image = await readImage(inputs[0]);
            bytes = beautifyPng(image.toPNG(), {
                id: "file-tools",
                name: "Frame",
                background: "#18181c",
                padding: 32,
                shadow: 0,
                radius: 0,
                ratio: "auto",
                align: "center",
                autoBalance: false,
            }).png;
            name = `${stem}-frame.png`;
        } else if (recipe === "image-redact") {
            if (inputs.length !== 1)
                throw new Error("Redact one image at a time.");
            const image = await readImage(inputs[0]);
            const size = image.getSize();
            const x = options.x ?? 0;
            const y = options.y ?? 0;
            const width = dimension(options.width, Math.min(100, size.width));
            const height = dimension(
                options.height,
                Math.min(100, size.height),
            );
            if (
                !Number.isSafeInteger(x) ||
                !Number.isSafeInteger(y) ||
                x < 0 ||
                y < 0 ||
                x + width > size.width ||
                y + height > size.height
            )
                throw new Error("Redaction must fit inside the source image.");
            const bitmap = image.toBitmap();
            for (let row = y; row < y + height; row++)
                for (let column = x; column < x + width; column++) {
                    const offset = (row * size.width + column) * 4;
                    bitmap[offset] =
                        bitmap[offset + 1] =
                        bitmap[offset + 2] =
                            0;
                    bitmap[offset + 3] = 255;
                }
            bytes = nativeImage.createFromBitmap(bitmap, size).toPNG();
            name = `${stem}-redacted.png`;
        } else if (recipe === "image-fold") {
            if (inputs.length !== 1)
                throw new Error("Fold one image at a time.");
            const allowed = new Set(["foldAxis", "foldOffset", "foldSize"]);
            const unsupported = Object.keys(options).find(
                (key) => !allowed.has(key),
            );
            if (unsupported)
                throw new Error(
                    `Unsupported image-fold option: ${unsupported}`,
                );
            const axis = options.foldAxis ?? "horizontal";
            const offset = options.foldOffset ?? 1;
            const foldSize = options.foldSize ?? 1;
            if (axis !== "horizontal" && axis !== "vertical")
                throw new Error("Invalid fold axis.");
            if (
                !Number.isSafeInteger(offset) ||
                !Number.isSafeInteger(foldSize) ||
                offset < 1 ||
                foldSize < 1
            )
                throw new Error(
                    "Fold offset and size must be positive integers.",
                );
            signal.throwIfAborted();
            const image = await readImage(inputs[0]);
            signal.throwIfAborted();
            const size = image.getSize();
            const axisLength = axis === "horizontal" ? size.height : size.width;
            if (offset + foldSize >= axisLength)
                throw new Error(
                    "Fold must remove an interior strip and retain both sides.",
                );
            signal.throwIfAborted();
            const source = image.toBitmap();
            const sourceLength = size.width * size.height * 4;
            if (source.length !== sourceLength)
                throw new Error("Decoded image bitmap has an invalid length.");
            const outputSize = {
                width: axis === "vertical" ? size.width - foldSize : size.width,
                height:
                    axis === "horizontal"
                        ? size.height - foldSize
                        : size.height,
            };
            signal.throwIfAborted();
            const output = Buffer.alloc(
                outputSize.width * outputSize.height * 4,
            );
            const progressStep = Math.max(1, Math.floor(size.height / 100));
            for (let row = 0; row < outputSize.height; row++) {
                signal.throwIfAborted();
                if (axis === "horizontal") {
                    const sourceRow = row < offset ? row : row + foldSize;
                    source.copy(
                        output,
                        row * outputSize.width * 4,
                        sourceRow * size.width * 4,
                        (sourceRow + 1) * size.width * 4,
                    );
                } else {
                    const sourceStart = row * size.width * 4;
                    const outputStart = row * outputSize.width * 4;
                    source.copy(
                        output,
                        outputStart,
                        sourceStart,
                        sourceStart + offset * 4,
                    );
                    source.copy(
                        output,
                        outputStart + offset * 4,
                        sourceStart + (offset + foldSize) * 4,
                        sourceStart + size.width * 4,
                    );
                }
                if (row % progressStep === 0)
                    context.progress((row / outputSize.height) * 95);
            }
            signal.throwIfAborted();
            bytes = nativeImage.createFromBitmap(output, outputSize).toPNG();
            signal.throwIfAborted();
            name = `${stem}-folded.png`;
        } else throw new Error("Unknown image tool.");
        signal.throwIfAborted();
        const path = join(outputDir, name);
        await fs.writeFile(path, bytes, { flag: "wx", signal });
        context.progress(100);
        return {
            paths: [path],
            warnings:
                recipe === "image-pdf"
                    ? [
                          "Image PDF pages are rasterized; original editable metadata is not retained.",
                      ]
                    : undefined,
        };
    },
};
