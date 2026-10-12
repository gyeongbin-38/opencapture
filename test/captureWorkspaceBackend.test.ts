import {
    existsSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_CAPTURE_EXPERIENCE,
    parseCaptureExperience,
} from "../lib/captureExperience";
import type {
    OpenCaptureItem,
    StageCaptureInput,
} from "../lib/openCaptureTypes";
import {
    applyCaptureTransition,
    queryCaptureItems,
    shouldRemoveOwnedDuplicate,
} from "../src/main/captureCatalogQuery";
import { CaptureDraftStore } from "../src/main/captureDraftStore";
import {
    encodeWindowsDropFiles,
    validateSourceFiles,
} from "../src/main/captureFileClipboard";

const roots: string[] = [];
const temporary = () => {
    const path = mkdtempSync(join(tmpdir(), "capture-workspace-"));
    roots.push(path);
    return path;
};

afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});

function png(width = 2, height = 2) {
    const buffer = Buffer.alloc(24);
    buffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return `data:image/png;base64,${buffer.toString("base64")}`;
}

function input(overrides: Partial<StageCaptureInput> = {}): StageCaptureInput {
    return {
        sourceDataURL: png(),
        previewDataURL: png(),
        canvas: { version: "6", objects: [] },
        rect: { x: 0, y: 0, width: 2, height: 2 },
        source: { kind: "capture", capturedAt: "2026-10-11T00:00:00.000Z" },
        ...overrides,
    };
}

describe("capture experience contract", () => {
    it("keeps quiet feedback defaults and filters tool lists", () => {
        expect(DEFAULT_CAPTURE_EXPERIENCE.feedback).toEqual({
            visual: true,
            sound: false,
            motion: "system",
        });
        const parsed = parseCaptureExperience({
            toolbarOrder: ["copy", "copy", "bad", "save"],
            radialOrder: [],
            feedback: { sound: true, motion: "reduced" },
        });
        expect(parsed.toolbarOrder).toEqual(["copy", "save"]);
        expect(parsed.radialOrder).toEqual(
            DEFAULT_CAPTURE_EXPERIENCE.radialOrder,
        );
        expect(parsed.feedback).toEqual({
            visual: true,
            sound: true,
            motion: "reduced",
        });
    });
});

describe("capture draft generations", async () => {
    it("bounds old generations after catalog commit and discovers crash-orphan manifests", async () => {
        const root = temporary();
        const store = new CaptureDraftStore(root);
        let current = await store.stage(input(), 0);
        const immutable = current.sourcePath;
        for (let revision = 1; revision < 8; revision++) {
            current = await store.stage(
                input({
                    id: current.id,
                    expectedRevision: revision,
                    sourceDataURL: undefined,
                }),
                1,
            );
            store.finalize(current.id);
        }
        const generations = readdirSync(join(root, current.id)).filter((name) =>
            /^\d+-/.test(name),
        );
        expect(generations).toEqual([current.generation]);
        expect(existsSync(immutable)).toBe(true);
        const restored = new CaptureDraftStore(root);
        expect(restored.list()).toHaveLength(1);
        expect(restored.list()[0].revision).toBe(8);
    });
    it("commits revisions and rejects stale or changed immutable sources", async () => {
        const store = new CaptureDraftStore(temporary());
        const first = await store.stage(input(), 0);
        const second = await store.stage(
            input({
                id: first.id,
                expectedRevision: 1,
                sourceDataURL: undefined,
                canvas: { objects: [{ type: "rect" }] },
            }),
            1,
        );
        expect(second.revision).toBe(2);
        expect(store.get(first.id).canvas).toEqual({
            objects: [{ type: "rect" }],
        });
        await expect(
            store.stage(input({ id: first.id, expectedRevision: 1 }), 1),
        ).rejects.toThrow(/stale/i);
        await expect(
            store.stage(
                input({
                    id: first.id,
                    expectedRevision: 2,
                    sourceDataURL: png(3, 2),
                }),
                1,
            ),
        ).rejects.toThrow(/immutable/i);
    });

    it("enforces image and live-draft caps before commit", async () => {
        const store = new CaptureDraftStore(temporary());
        await expect(store.stage(input(), 80)).rejects.toThrow(
            /80 live drafts/i,
        );
        await expect(
            store.stage(input({ previewDataURL: png(8_001, 4_000) }), 0),
        ).rejects.toThrow(/32 megapixels/i);
    });

    it("can restore the previous committed manifest after a catalog failure", async () => {
        const store = new CaptureDraftStore(temporary());
        const first = await store.stage(input(), 0);
        const previous = store.manifest(first.id);
        const second = await store.stage(
            input({
                id: first.id,
                expectedRevision: 1,
                sourceDataURL: undefined,
                canvas: { objects: [{ type: "text" }] },
            }),
            1,
        );
        store.rollback(second, previous);
        expect(store.get(first.id)).toMatchObject({
            revision: 1,
            canvas: { version: "6", objects: [] },
        });
    });
});

describe("full-catalog queries", () => {
    const catalog: OpenCaptureItem[] = Array.from(
        { length: 130 },
        (_, index) => ({
            id: String(index),
            name: index === 101 ? "needle capture.png" : `capture-${index}.png`,
            path: `C:/captures/${index}.png`,
            createdAt: new Date(1_700_000_000_000 + index).toISOString(),
            collectionId: "default",
            status: index % 3 === 0 ? "temporary" : "library",
            tags: index === 90 ? [] : ["tag"],
        }),
    );

    it("filters before pagination and returns stable query metadata", () => {
        const result = queryCaptureItems(
            catalog,
            {
                scope: "library",
                search: "needle",
                sort: "newest",
                offset: 0,
                limit: 20,
                queryId: "q2",
            },
            [],
            17,
        );
        expect(result.items.map((item) => item.id)).toEqual(["101"]);
        expect(result).toMatchObject({
            total: 1,
            queryId: "q2",
            catalogRevision: 17,
        });
    });

    it("supports reserved smart filters without saving hidden records", () => {
        const result = queryCaptureItems(
            catalog,
            {
                scope: "all",
                smartId: "builtin:uncategorized",
                sort: "newest",
                offset: 0,
                limit: 20,
                queryId: "smart",
            },
            [],
            1,
        );
        expect(result.items.map((item) => item.id)).toContain("90");
    });

    it("rejects stale follow-up pages", () => {
        expect(() =>
            queryCaptureItems(
                catalog,
                {
                    scope: "all",
                    sort: "newest",
                    offset: 20,
                    limit: 20,
                    queryId: "stale",
                    catalogRevision: 4,
                },
                [],
                5,
            ),
        ).toThrow(/catalog changed/i);
    });
});

it("promotes and trash-restores identities without changing paths", () => {
    const item: OpenCaptureItem = {
        id: "draft",
        name: "draft.png",
        path: "C:/drafts/rev-2.png",
        createdAt: "2026-10-11T00:00:00.000Z",
        collectionId: "default",
        status: "temporary",
    };
    applyCaptureTransition([item], [item.id], "promote");
    expect(item).toMatchObject({
        status: "library",
        path: "C:/drafts/rev-2.png",
    });
    applyCaptureTransition([item], [item.id], "trash");
    expect(item).toMatchObject({
        status: "trash",
        previousStatus: "library",
    });
    applyCaptureTransition([item], [item.id], "restore");
    expect(item).toMatchObject({
        status: "library",
        path: "C:/drafts/rev-2.png",
    });
    const other = { ...item, id: "other", status: "library" as const };
    item.status = "temporary";
    expect(() =>
        applyCaptureTransition([item, other], [item.id, other.id], "promote"),
    ).toThrow(/temporary/i);
    expect(item.status).toBe("temporary");
});

it("validates bounded source-file lists including Korean names", () => {
    const root = temporary();
    const file = join(root, "캡처 원본.png");
    writeFileSync(file, Buffer.from("png"));
    expect(validateSourceFiles([file])).toEqual([file]);
    expect(() =>
        validateSourceFiles(Array.from({ length: 51 }, () => file)),
    ).toThrow(/50 files/i);
    const payload = encodeWindowsDropFiles([file]);
    expect(payload.readUInt32LE(0)).toBe(20);
    expect(payload.readUInt32LE(16)).toBe(1);
    expect(payload.subarray(20).toString("utf16le")).toBe(`${file}\0\0`);
});

it("never removes an indexed original when dedupe sees the same path", () => {
    const original = "C:/Pictures/OpenCapture/original.png";
    expect(
        shouldRemoveOwnedDuplicate(
            original,
            original,
            [original],
            ["C:/Pictures/OpenCapture"],
        ),
    ).toBe(false);
    expect(
        shouldRemoveOwnedDuplicate(
            "C:/Pictures/OpenCapture/new.png",
            original,
            [original],
            ["C:/Pictures/OpenCapture"],
        ),
    ).toBe(true);
});
