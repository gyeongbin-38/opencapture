import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "../lib/captureBoard";
import type { OpenCaptureItem } from "../lib/openCaptureTypes";
import {
    CaptureBoardStore,
    validateBoardDocument,
} from "../src/main/captureBoardStore";

const png = (seed = 0) =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);
const item = (
    id: string,
    kind: "capture" | "import" = "capture",
): OpenCaptureItem => ({
    id,
    name: `${id}.png`,
    path: `C:/capture/${id}.png`,
    createdAt: "2026-10-11T00:00:00.000Z",
    collectionId: "default",
    status: "temporary",
    source: {
        kind,
        displayId: "primary",
        capturedAt: "2026-10-11T00:00:00.000Z",
    },
});
const tempRoots: string[] = [];
afterAll(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "capture-board-"));
    tempRoots.push(root);
    const snapshots = new Map([
        ["one", { item: item("one"), png: png(1), width: 400, height: 200 }],
        ["two", { item: item("two"), png: png(2), width: 300, height: 300 }],
        [
            "import-a",
            {
                item: item("import-a", "import"),
                png: png(5),
                width: 100,
                height: 100,
            },
        ],
        [
            "import-b",
            {
                item: item("import-b", "import"),
                png: png(6),
                width: 100,
                height: 100,
            },
        ],
    ]);
    const onCaptureAdded = vi.fn();
    const store = new CaptureBoardStore({
        root,
        inspect: (value) => ({ png: value, width: 400, height: 200 }),
        resolveItem: (id) => {
            const value = snapshots.get(id);
            if (!value) throw new Error("missing");
            return value;
        },
        prepareCutout: async (value) => ({
            png: Buffer.concat([value, Buffer.from([3])]),
            width: 400,
            height: 200,
        }),
        prepareBeautify: async (value) => ({
            png: Buffer.concat([value, Buffer.from([4])]),
            width: 420,
            height: 220,
        }),
        onCaptureAdded,
    });
    return { root, store, onCaptureAdded };
};

describe("capture board store", () => {
    it("publishes revisions atomically and rejects stale saves", () => {
        const { root, store } = setup();
        const created = store.create("Design");
        const saved = store.save(
            { ...created, viewport: { x: 12, y: 20, zoom: 1.5 } },
            0,
        );
        expect(saved).toMatchObject({ revision: 1, viewport: { x: 12 } });
        expect(() => store.save(created, 0)).toThrow(/revision conflict/i);
        const restored = new CaptureBoardStore({
            root,
            resolveItem: () => {
                throw new Error("unused");
            },
            prepareCutout: async () => {
                throw new Error("unused");
            },
            prepareBeautify: async () => {
                throw new Error("unused");
            },
        });
        expect(restored.load(created.id)).toEqual(saved);
    });

    it("owns snapshots, dedupes capture identities and validates assets", () => {
        const { store } = setup();
        const board = store.create();
        const first = store.addItems(board.id, ["one", "one", "two"], 0);
        expect(first.nodes).toHaveLength(2);
        expect(first.nodes.map((node) => node.captureItemId)).toEqual([
            "one",
            "two",
        ]);
        const unchanged = store.addItems(board.id, ["one"], first.revision);
        expect(unchanged.nodes).toHaveLength(2);
        expect(
            store.assetData(board.id, first.nodes[0].assetId as string),
        ).toMatch(/^data:image\/png;base64,/);
        const foreign = store.create("Other");
        expect(() =>
            store.save(
                {
                    ...foreign,
                    nodes: [{ ...first.nodes[0], id: "foreign-node" }],
                },
                0,
            ),
        ).toThrow(/unowned asset/i);
    });

    it("groups repeated capture areas but keeps unrelated imports separate", () => {
        const { store } = setup();
        const created = store.create();
        const board = store.addItems(
            created.id,
            ["one", "two", "import-a", "import-b"],
            0,
        );
        expect(board.nodes[0].versionGroup).toBe(board.nodes[1].versionGroup);
        expect(board.nodes[2].versionGroup).not.toBe(
            board.nodes[3].versionGroup,
        );
        expect(board.nodes[2].versionGroup).toBe("import:import-a");
    });

    it("freezes first-commit pending captures and acknowledges after adoption", () => {
        const { store, onCaptureAdded } = setup();
        const created = store.create("Auto");
        const enabled = store.save(
            {
                ...created,
                settings: { ...created.settings, autoAdd: true },
            },
            0,
        );
        store.setActive(enabled.id);
        const snapshot = {
            item: item("one"),
            png: png(8),
            width: 400,
            height: 200,
            region: { x: 10, y: 20, width: 400, height: 200 },
        };
        store.queueCapture(snapshot);
        snapshot.png[8] = 99;
        store.queueCapture(snapshot);
        expect(store.pendingCaptures()).toEqual([
            {
                itemId: "one",
                targetBoardId: enabled.id,
                region: snapshot.region,
            },
        ]);
        expect(onCaptureAdded).toHaveBeenCalledTimes(1);
        const adopted = store.adoptPending("one", enabled.id, enabled.revision);
        expect(adopted.nodes).toHaveLength(1);
        expect(adopted.nodes[0].source?.areaKey).toContain("10:20:400:200");
        expect(store.pendingCaptures()).toEqual([]);
    });

    it("prepares source-matched derivations without mutating the document", async () => {
        const { root, store } = setup();
        const created = store.create();
        const board = store.addItems(created.id, ["one"], 0);
        const node = board.nodes[0];
        const result = await store.cutout(
            board.id,
            node.id,
            node.assetId as string,
        );
        expect(result.nodes[0]).toMatchObject({
            nodeId: node.id,
            sourceAssetId: node.assetId,
        });
        expect(store.load(board.id)).toEqual(board);
        expect(() =>
            store.cutout(board.id, node.id, "stale-source"),
        ).rejects.toThrow(/no longer matches/i);
        const disposable = await store.cutout(
            board.id,
            node.id,
            node.assetId as string,
        );
        store.discardDerived(board.id, [disposable.nodes[0].assetId]);
        expect(() =>
            store.assetData(board.id, disposable.nodes[0].assetId),
        ).toThrow(/not found/i);
        expect(store.assetData(board.id, node.assetId as string)).toContain(
            png(1).toString("base64"),
        );
        const applied = store.save(
            {
                ...board,
                nodes: board.nodes.map((candidate) =>
                    candidate.id === node.id
                        ? {
                              ...candidate,
                              assetId: result.nodes[0].assetId,
                              originalAssetId: candidate.assetId,
                          }
                        : candidate,
                ),
            },
            board.revision,
        );
        const restarted = new CaptureBoardStore({
            root,
            resolveItem: () => {
                throw new Error("unused");
            },
            prepareCutout: async () => {
                throw new Error("unused");
            },
            prepareBeautify: async () => {
                throw new Error("unused");
            },
        });
        expect(restarted.load(board.id)).toEqual(applied);
        expect(
            restarted.assetData(board.id, node.assetId as string, "original"),
        ).toContain(png(1).toString("base64"));
        expect(
            restarted.assetData(board.id, result.nodes[0].assetId, "original"),
        ).toMatch(/^data:image\/png;base64,/);
        expect(() =>
            restarted.discardDerived(board.id, [node.assetId as string]),
        ).toThrow(/prepared assets/i);
    });

    it("roundtrips portable boards with private remapped assets", () => {
        const { store } = setup();
        const created = store.create("Portable");
        const images = store.addItems(created.id, ["one", "two"], 0);
        const board = store.save(
            {
                ...images,
                settings: {
                    ...images.settings,
                    focusIds: [images.nodes[0].id],
                },
                nodes: [
                    ...images.nodes,
                    {
                        id: "anchored-arrow",
                        kind: "arrow",
                        x: 0,
                        y: 0,
                        width: 100,
                        height: 100,
                        rotation: 0,
                        visible: true,
                        locked: false,
                        style: {
                            fill: "#00000000",
                            stroke: "#fff",
                            strokeWidth: 2,
                            fontSize: 18,
                        },
                        anchor: {
                            nodeId: images.nodes[0].id,
                            x: 0.5,
                            y: 0.5,
                        },
                    },
                ],
            },
            images.revision,
        );
        const portable = store.portable(board.id);
        const imported = store.importPortable(portable);
        expect(imported.id).not.toBe(board.id);
        expect(imported.nodes).toHaveLength(3);
        expect(imported.nodes[0].assetId).not.toBe(board.nodes[0].assetId);
        expect(imported.settings.focusIds).toEqual([imported.nodes[0].id]);
        expect(imported.nodes[2].anchor?.nodeId).toBe(imported.nodes[0].id);
        expect(
            store.assetData(imported.id, imported.nodes[0].assetId as string),
        ).toMatch(/^data:image\/png;base64,/);
    });

    it("rejects duplicate and missing portable assets before publication", () => {
        const { store } = setup();
        const created = store.create("Portable validation");
        const board = store.addItems(created.id, ["one"], 0);
        const portable = JSON.parse(store.portable(board.id)) as {
            document: BoardDocument;
            assets: Array<Record<string, unknown>>;
        };
        const before = store.list().length;
        portable.assets.push({ ...portable.assets[0] });
        expect(() => store.importPortable(JSON.stringify(portable))).toThrow(
            /duplicate portable/i,
        );
        portable.assets.pop();
        portable.document.nodes[0].originalAssetId = "missing-original";
        expect(() => store.importPortable(JSON.stringify(portable))).toThrow(
            /missing a referenced asset/i,
        );
        expect(store.list()).toHaveLength(before);
    });

    it("recovers referenced assets read-only when the index is corrupt", () => {
        const { root, store } = setup();
        const created = store.create("Recovery");
        const board = store.addItems(created.id, ["one"], 0);
        writeFileSync(join(root, "index.json"), "{broken-index");
        const recovered = new CaptureBoardStore({
            root,
            inspect: (value) => ({ png: value, width: 400, height: 200 }),
            resolveItem: () => {
                throw new Error("unused");
            },
            prepareCutout: async () => {
                throw new Error("unused");
            },
            prepareBeautify: async () => {
                throw new Error("unused");
            },
        });
        expect(recovered.status()).toMatchObject({ readOnly: true });
        expect(recovered.list().map((entry) => entry.id)).toContain(board.id);
        expect(
            recovered.assetData(board.id, board.nodes[0].assetId as string),
        ).toMatch(/^data:image\/png;base64,/);
        expect(() => recovered.create("Must not overwrite")).toThrow(
            /corrupt/i,
        );
        expect(readFileSync(join(root, "index.json"), "utf8")).toBe(
            "{broken-index",
        );
        expect(
            readdirSync(root).some((name) =>
                name.startsWith("index.json.corrupt-"),
            ),
        ).toBe(true);
    });
});

it("rejects oversized, dangling and over-vertex board documents", () => {
    const { store } = setup();
    const board = store.create();
    const base = {
        id: "shape",
        kind: "polygon" as const,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        visible: true,
        locked: false,
        style: {
            fill: "#00000000",
            stroke: "#fff",
            strokeWidth: 2,
            fontSize: 18,
        },
    };
    const pixelLocal = store.save(
        {
            ...board,
            nodes: [
                {
                    ...base,
                    width: 1920,
                    height: 1080,
                    points: [
                        { x: 0, y: 0 },
                        { x: 1440, y: 900 },
                        { x: 1919, y: 1079 },
                    ],
                },
            ],
        },
        0,
    );
    expect(store.load(board.id).nodes[0].points).toEqual(
        pixelLocal.nodes[0].points,
    );
    expect(() =>
        validateBoardDocument({
            ...board,
            nodes: [
                {
                    ...base,
                    points: Array.from({ length: 129 }, () => ({ x: 0, y: 0 })),
                },
            ],
        } satisfies BoardDocument),
    ).toThrow(/invalid board node/i);
    expect(() =>
        validateBoardDocument({
            ...board,
            nodes: [
                {
                    ...base,
                    kind: "arrow",
                    anchor: { nodeId: "missing", x: 0.5, y: 0.5 },
                },
            ],
        } satisfies BoardDocument),
    ).toThrow(/missing node/i);
});
