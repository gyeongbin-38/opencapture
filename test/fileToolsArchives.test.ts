import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
    brotliDecompressSync,
    crc32,
    deflateRawSync,
    gunzipSync,
} from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FileToolOptions } from "../lib/fileTools";
import { archiveTools } from "../src/main/fileToolsArchives";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(
        roots
            .splice(0)
            .map((root) => rm(root, { recursive: true, force: true })),
    );
});

async function fixtureRoot() {
    const root = await mkdtemp(join(tmpdir(), "opencapture-archives-"));
    roots.push(root);
    return root;
}

function input(path: string, extension?: string): ToolInput {
    const name = basename(path);
    const ext = extension ?? name.split(".").at(-1) ?? "";
    return {
        id: name,
        name,
        path,
        size: 0,
        extension: ext,
        kind: ["zip", "gz", "gzip", "br", "rar", "tar"].includes(ext)
            ? "archive"
            : "other",
    };
}

async function context(
    root: string,
    inputs: ToolInput[],
    recipe: string,
    options: FileToolOptions = {},
    signal = new AbortController().signal,
): Promise<ToolContext> {
    const outputDir = join(root, `output-${recipe}-${Math.random()}`);
    await mkdir(outputDir);
    return {
        inputs,
        recipe,
        options,
        outputDir,
        signal,
        progress: () => {},
    };
}

type ZipFixture = {
    name: string;
    data?: Buffer | string;
    mode?: number;
    crc?: number;
    declaredSize?: number;
    compress?: boolean;
};

function zipFixture(entries: ZipFixture[]) {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const data = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data ?? "");
        const archivedData = entry.compress ? deflateRawSync(data) : data;
        const method = entry.compress ? 8 : 0;
        const checksum = entry.crc ?? crc32(data);
        const declaredSize = entry.declaredSize ?? data.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(checksum >>> 0, 14);
        local.writeUInt32LE(archivedData.length, 18);
        local.writeUInt32LE(declaredSize, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, archivedData);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x0314, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum >>> 0, 16);
        central.writeUInt32LE(archivedData.length, 20);
        central.writeUInt32LE(declaredSize, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + archivedData.length;
    }
    const central = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, central, end]);
}

type TarFixture = {
    name: string;
    data?: Buffer | string;
    type?: string;
    corruptChecksum?: boolean;
};

function writeTarOctal(
    buffer: Buffer,
    offset: number,
    length: number,
    value: number,
) {
    buffer.write(
        `${value.toString(8).padStart(length - 1, "0")}\0`,
        offset,
        length,
        "ascii",
    );
}

function tarFixture(entries: TarFixture[]) {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        const data = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data ?? "");
        const header = Buffer.alloc(512);
        let name = Buffer.from(entry.name);
        let prefix = Buffer.alloc(0);
        if (name.length > 100) {
            const split = entry.name.lastIndexOf("/");
            prefix = Buffer.from(entry.name.slice(0, split));
            name = Buffer.from(entry.name.slice(split + 1));
        }
        name.copy(header, 0);
        writeTarOctal(header, 100, 8, 0o644);
        writeTarOctal(header, 108, 8, 0);
        writeTarOctal(header, 116, 8, 0);
        writeTarOctal(header, 124, 12, data.length);
        writeTarOctal(header, 136, 12, 0);
        header.fill(0x20, 148, 156);
        header.write(entry.type ?? "0", 156, 1, "ascii");
        header.write("ustar\0", 257, 6, "ascii");
        header.write("00", 263, 2, "ascii");
        prefix.copy(header, 345);
        const checksum = header.reduce((total, byte) => total + byte, 0);
        header.write(
            (entry.corruptChecksum ? checksum + 1 : checksum)
                .toString(8)
                .padStart(6, "0"),
            148,
            6,
            "ascii",
        );
        header[154] = 0;
        header[155] = 0x20;
        const padding = (512 - (data.length % 512)) % 512;
        parts.push(header, data, Buffer.alloc(padding));
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

describe("archiveTools recipes", () => {
    it("publishes fixed recipes, enables TAR, and keeps RAR unavailable", async () => {
        const rar = input("sample.rar");
        const recipes = await archiveTools.recipes([rar]);
        expect(recipes.map((recipe) => recipe.id)).toEqual([
            "archive-extract",
            "archive-inspect",
            "archive-test",
            "archive-compress",
        ]);
        expect(
            recipes.find((recipe) => recipe.id === "archive-extract"),
        ).toMatchObject({
            available: false,
            reason: expect.stringContaining("RAR"),
        });
        expect(
            recipes.find((recipe) => recipe.id === "archive-compress"),
        ).toMatchObject({
            available: true,
            multiple: true,
            formats: ["zip", "tar", "gz", "br"],
        });

        const tarRecipes = await archiveTools.recipes([input("sample.tar")]);
        expect(tarRecipes[0]).toMatchObject({ available: true });
    });
});

describe("archiveTools compression", () => {
    it("creates a genuine TAR.GZ for multiple inputs and extracts its members", async () => {
        const root = await fixtureRoot();
        const first = join(root, "first.txt");
        const second = join(root, "second.txt");
        const firstData = Buffer.from("first source\n".repeat(80));
        const secondData = Buffer.from("둘째🙂\n".repeat(60));
        await writeFile(first, firstData);
        await writeFile(second, secondData);
        const compressed = await archiveTools.run(
            await context(
                root,
                [input(first, "txt"), input(second, "txt")],
                "archive-compress",
                { format: "gz" },
            ),
        );
        expect(compressed.paths).toHaveLength(1);
        expect(compressed.paths[0]).toMatch(/\.tar\.gz$/);
        const tarBytes = gunzipSync(await readFile(compressed.paths[0]));
        expect(tarBytes.subarray(257, 263).toString("ascii")).toBe("ustar\0");

        const extracted = await archiveTools.run(
            await context(
                root,
                [input(compressed.paths[0], "gz")],
                "archive-extract",
            ),
        );
        expect((await stat(extracted.paths[0])).isDirectory()).toBe(true);
        expect(await readFile(join(extracted.paths[0], "first.txt"))).toEqual(
            firstData,
        );
        expect(await readFile(join(extracted.paths[0], "second.txt"))).toEqual(
            secondData,
        );
    });

    it("creates and verifies Brotli without changing source bytes", async () => {
        const root = await fixtureRoot();
        const source = join(root, "source.bin");
        const data = Buffer.from(
            Array.from({ length: 4096 }, (_, i) => i % 251),
        );
        await writeFile(source, data);
        const result = await archiveTools.run(
            await context(root, [input(source, "bin")], "archive-compress", {
                format: "br",
            }),
        );
        expect(brotliDecompressSync(await readFile(result.paths[0]))).toEqual(
            data,
        );
        const tested = await archiveTools.run(
            await context(root, [input(result.paths[0], "br")], "archive-test"),
        );
        const report = JSON.parse(await readFile(tested.paths[0], "utf8"));
        expect(report).toMatchObject({
            valid: true,
            expandedBytes: data.length,
        });
    });

    it.each(["zip", "tar"])(
        "creates and extracts a genuine %s archive for one regular file",
        async (format) => {
            const root = await fixtureRoot();
            const source = join(root, "source.txt");
            const data = Buffer.from("standalone archive\n한글🙂");
            await writeFile(source, data);
            const created = await archiveTools.run(
                await context(
                    root,
                    [input(source, "txt")],
                    "archive-compress",
                    { format },
                ),
            );
            const bytes = await readFile(created.paths[0]);
            if (format === "zip")
                expect(bytes.subarray(0, 4)).toEqual(
                    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
                );
            else
                expect(bytes.subarray(257, 263).toString("ascii")).toBe(
                    "ustar\0",
                );
            const extracted = await archiveTools.run(
                await context(
                    root,
                    [input(created.paths[0], format)],
                    "archive-extract",
                ),
            );
            expect(
                await readFile(join(extracted.paths[0], "source.txt")),
            ).toEqual(data);
        },
    );

    it("recursively archives a bounded folder without following links", async () => {
        const root = await fixtureRoot();
        const folder = join(root, "folder");
        const nested = ["한글".repeat(10), `경로${"한글".repeat(9)}`];
        await mkdir(join(folder, ...nested), { recursive: true });
        await writeFile(join(folder, ...nested, "value.txt"), "nested value");
        for (const format of ["zip", "tar"]) {
            const created = await archiveTools.run(
                await context(
                    root,
                    [
                        {
                            ...input(folder, ""),
                            kind: "folder",
                        },
                    ],
                    "archive-compress",
                    { format },
                ),
            );
            const extracted = await archiveTools.run(
                await context(
                    root,
                    [input(created.paths[0], format)],
                    "archive-extract",
                ),
            );
            expect(
                await readFile(
                    join(extracted.paths[0], "folder", ...nested, "value.txt"),
                    "utf8",
                ),
            ).toBe("nested value");
        }
    });

    it("repackages ZIP members into TAR, ZIP, and TAR.GZ instead of wrapping archive bytes", async () => {
        const root = await fixtureRoot();
        const foreignZip = join(root, "foreign.zip");
        await writeFile(
            foreignZip,
            zipFixture([
                { name: "member.txt", data: "member data", compress: true },
            ]),
        );
        for (const format of ["tar", "zip", "gz"]) {
            const converted = await archiveTools.run(
                await context(
                    root,
                    [input(foreignZip, "zip")],
                    "archive-compress",
                    { format },
                ),
            );
            const convertedInput = input(
                converted.paths[0],
                format === "gz" ? "gz" : format,
            );
            const extracted = await archiveTools.run(
                await context(root, [convertedInput], "archive-extract"),
            );
            expect(
                await readFile(join(extracted.paths[0], "member.txt"), "utf8"),
            ).toBe("member data");
        }
    });

    it("honors an already-aborted signal without producing output", async () => {
        const root = await fixtureRoot();
        const source = join(root, "source.txt");
        await writeFile(source, "cancel me");
        const controller = new AbortController();
        controller.abort();
        const operation = await context(
            root,
            [input(source, "txt")],
            "archive-compress",
            { format: "gz" },
            controller.signal,
        );
        await expect(archiveTools.run(operation)).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(await stat(operation.outputDir)).toBeTruthy();
    });

    it("cancels ZIP creation between entries and removes the partial archive", async () => {
        const root = await fixtureRoot();
        const first = join(root, "first.bin");
        const second = join(root, "second.bin");
        await writeFile(first, Buffer.alloc(128 * 1024, 1));
        await writeFile(second, Buffer.alloc(128 * 1024, 2));
        const controller = new AbortController();
        const operation = await context(
            root,
            [input(first, "bin"), input(second, "bin")],
            "archive-compress",
            { format: "zip" },
            controller.signal,
        );
        operation.progress = (percent) => {
            if (percent > 0) controller.abort();
        };
        await expect(archiveTools.run(operation)).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(
            (await readdir(operation.outputDir)).filter((name) =>
                name.endsWith(".zip"),
            ),
        ).toEqual([]);
    });

    it("rejects an unsupported creation format instead of silently using GZIP", async () => {
        const root = await fixtureRoot();
        const source = join(root, "source.txt");
        await writeFile(source, "format");
        await expect(
            archiveTools.run(
                await context(
                    root,
                    [input(source, "txt")],
                    "archive-compress",
                    { format: "7z" },
                ),
            ),
        ).rejects.toThrow(/Unsupported archive compression format/);
    });
});

describe("archiveTools ZIP", () => {
    it("lists, tests, and extracts a valid nested ZIP", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "safe.zip");
        await writeFile(
            archive,
            zipFixture([
                { name: "folder/", mode: 0o040755 },
                { name: "folder/hello.txt", data: "hello zip", compress: true },
                { name: "root.txt", data: "root" },
            ]),
        );
        const source = input(archive, "zip");
        const inspected = await archiveTools.run(
            await context(root, [source], "archive-inspect"),
        );
        const listing = JSON.parse(await readFile(inspected.paths[0], "utf8"));
        expect(
            listing.entries.map((entry: { path: string }) => entry.path),
        ).toEqual(["folder", "folder/hello.txt", "root.txt"]);

        const tested = await archiveTools.run(
            await context(root, [source], "archive-test"),
        );
        expect(
            JSON.parse(await readFile(tested.paths[0], "utf8")),
        ).toMatchObject({
            valid: true,
            entries: 3,
        });

        const extracted = await archiveTools.run(
            await context(root, [source], "archive-extract"),
        );
        expect((await stat(extracted.paths[0])).isDirectory()).toBe(true);
        expect(
            await readFile(
                join(extracted.paths[0], "folder", "hello.txt"),
                "utf8",
            ),
        ).toBe("hello zip");
        expect(
            await readFile(join(extracted.paths[0], "root.txt"), "utf8"),
        ).toBe("root");
    });

    it.each([
        ["parent traversal", "../escape.txt"],
        ["absolute path", "/absolute.txt"],
        ["Windows drive", "C:/escape.txt"],
        ["backslash path", "folder\\escape.txt"],
        ["Windows device name", "CON.txt"],
        ["trailing-dot collision", "folder/file.txt."],
    ])(
        "rejects %s entries without writing outside outputDir",
        async (_name, name) => {
            const root = await fixtureRoot();
            const archive = join(root, "malicious.zip");
            await writeFile(archive, zipFixture([{ name, data: "escape" }]));
            await expect(
                archiveTools.run(
                    await context(
                        root,
                        [input(archive, "zip")],
                        "archive-extract",
                    ),
                ),
            ).rejects.toThrow();
            await expect(stat(join(root, "escape.txt"))).rejects.toMatchObject({
                code: "ENOENT",
            });
        },
    );

    it("rejects symlinks, case collisions, corrupt CRC, and oversized entries", async () => {
        const root = await fixtureRoot();
        const fixtures: [string, Buffer][] = [
            [
                "symlink.zip",
                zipFixture([{ name: "link", data: "target", mode: 0o120777 }]),
            ],
            [
                "collision.zip",
                zipFixture([
                    { name: "Readme.txt", data: "a" },
                    { name: "README.TXT", data: "b" },
                ]),
            ],
            ["crc.zip", zipFixture([{ name: "bad.txt", data: "bad", crc: 0 }])],
            [
                "bomb.zip",
                zipFixture([
                    {
                        name: "bomb.bin",
                        data: Buffer.alloc(2 * 1024 * 1024),
                        compress: true,
                    },
                ]),
            ],
        ];
        for (const [name, bytes] of fixtures) {
            const archive = join(root, name);
            await writeFile(archive, bytes);
            await expect(
                archiveTools.run(
                    await context(
                        root,
                        [input(archive, "zip")],
                        "archive-test",
                    ),
                ),
            ).rejects.toThrow();
        }
    });

    it("rejects archives above the entry limit", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "many.zip");
        await writeFile(
            archive,
            zipFixture(
                Array.from({ length: 5_001 }, (_, index) => ({
                    name: `empty-${index}.txt`,
                })),
            ),
        );
        await expect(
            archiveTools.run(
                await context(root, [input(archive, "zip")], "archive-test"),
            ),
        ).rejects.toThrow(/5000/);
    });
});

describe("archiveTools USTAR", () => {
    it("lists, tests, and extracts a foreign UTF-8 USTAR with a prefix path", async () => {
        const root = await fixtureRoot();
        const longPath = `${"긴경로".repeat(14)}/파일.txt`;
        const archive = join(root, "foreign.tar");
        await writeFile(
            archive,
            tarFixture([
                { name: "folder/", type: "5" },
                { name: "folder/child.txt", data: "directory child" },
                { name: longPath, data: "foreign ustar" },
            ]),
        );
        const source = input(archive, "tar");
        const inspected = await archiveTools.run(
            await context(root, [source], "archive-inspect"),
        );
        const listing = JSON.parse(await readFile(inspected.paths[0], "utf8"));
        expect(
            listing.entries.map((entry: { path: string }) => entry.path),
        ).toEqual(["folder", "folder/child.txt", longPath]);
        const tested = await archiveTools.run(
            await context(root, [source], "archive-test"),
        );
        expect(
            JSON.parse(await readFile(tested.paths[0], "utf8")),
        ).toMatchObject({
            valid: true,
            entries: 3,
        });
        const extracted = await archiveTools.run(
            await context(root, [source], "archive-extract"),
        );
        expect(
            await readFile(
                join(extracted.paths[0], ...longPath.split("/")),
                "utf8",
            ),
        ).toBe("foreign ustar");
        expect(
            await readFile(
                join(extracted.paths[0], "folder", "child.txt"),
                "utf8",
            ),
        ).toBe("directory child");
    });

    it("repackages TAR members into ZIP and TAR.GZ", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "source.tar");
        await writeFile(
            archive,
            tarFixture([{ name: "inside.txt", data: "inside tar" }]),
        );
        for (const format of ["zip", "gz"]) {
            const converted = await archiveTools.run(
                await context(
                    root,
                    [input(archive, "tar")],
                    "archive-compress",
                    { format },
                ),
            );
            const extracted = await archiveTools.run(
                await context(
                    root,
                    [input(converted.paths[0], format)],
                    "archive-extract",
                ),
            );
            expect(
                await readFile(join(extracted.paths[0], "inside.txt"), "utf8"),
            ).toBe("inside tar");
        }
    });

    it.each([
        ["unsafe path", { name: "../escape.txt", data: "x" }],
        ["symbolic link", { name: "link", type: "2" }],
        ["PAX extension", { name: "pax", type: "x" }],
        [
            "bad checksum",
            { name: "bad.txt", data: "bad", corruptChecksum: true },
        ],
    ])("rejects %s without extracting data", async (_label, entry) => {
        const root = await fixtureRoot();
        const archive = join(root, "unsafe.tar");
        await writeFile(archive, tarFixture([entry]));
        await expect(
            archiveTools.run(
                await context(root, [input(archive, "tar")], "archive-extract"),
            ),
        ).rejects.toThrow();
        await expect(stat(join(root, "escape.txt"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("cancels before reading a TAR", async () => {
        const root = await fixtureRoot();
        const archive = join(root, "cancel.tar");
        await writeFile(archive, tarFixture([{ name: "file", data: "x" }]));
        const controller = new AbortController();
        controller.abort();
        await expect(
            archiveTools.run(
                await context(
                    root,
                    [input(archive, "tar")],
                    "archive-test",
                    {},
                    controller.signal,
                ),
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
