import { describe, expect, it } from "vitest";
import { BOARD_LIMITS, type BoardDocument } from "../lib/captureBoard";
import { parseBrowserPortable, validateBrowserBoard } from "../web/boardApi";

const emptyBoard = (): BoardDocument => ({
    version: 1,
    id: "web-board",
    revision: 0,
    name: "Web board",
    updatedAt: "2026-10-11T00:00:00.000Z",
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { autoAdd: true, focusIds: [], preset: "design" },
    nodes: [],
    styles: [],
});

describe("browser board validation", () => {
    it("accepts a bounded portable board without assets", () => {
        const payload = parseBrowserPortable(
            JSON.stringify({ version: 1, document: emptyBoard(), assets: [] }),
        );
        expect(payload.document.id).toBe("web-board");
        expect(payload.assets).toEqual([]);
    });

    it("rejects portable boards with missing referenced assets", () => {
        const document = emptyBoard();
        document.nodes.push({
            id: "image-node",
            kind: "image",
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            rotation: 0,
            visible: true,
            locked: false,
            style: {
                fill: "transparent",
                stroke: "#fff",
                strokeWidth: 2,
                fontSize: 14,
            },
            assetId: "missing-asset",
        });
        expect(() =>
            parseBrowserPortable(
                JSON.stringify({ version: 1, document, assets: [] }),
            ),
        ).toThrow(/missing an image asset/i);
    });

    it("accepts a referenced bounded PNG asset", () => {
        const document = emptyBoard();
        document.nodes.push({
            id: "image-node",
            kind: "image",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rotation: 0,
            visible: true,
            locked: false,
            style: {
                fill: "transparent",
                stroke: "#fff",
                strokeWidth: 2,
                fontSize: 14,
            },
            assetId: "asset-1",
        });
        const payload = parseBrowserPortable(
            JSON.stringify({
                version: 1,
                document,
                assets: [
                    {
                        id: "asset-1",
                        boardId: document.id,
                        dataURL:
                            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Jf8AAAAASUVORK5CYII=",
                        width: 1,
                        height: 1,
                    },
                ],
            }),
        );
        expect(payload.assets[0]?.id).toBe("asset-1");
    });

    it("rejects node counts beyond the shared board limit", () => {
        const document = emptyBoard();
        document.nodes = Array.from(
            { length: BOARD_LIMITS.nodes + 1 },
            (_, index) => ({
                id: `note-${index}`,
                kind: "note" as const,
                x: index,
                y: 0,
                width: 80,
                height: 40,
                rotation: 0,
                visible: true,
                locked: false,
                text: "note",
                style: {
                    fill: "transparent",
                    stroke: "#fff",
                    strokeWidth: 2,
                    fontSize: 14,
                },
            }),
        );
        expect(() => validateBrowserBoard(document)).toThrow(
            /invalid board document/i,
        );
    });

    it("rejects non-PNG portable asset payloads", () => {
        const document = emptyBoard();
        document.nodes.push({
            id: "image-node",
            kind: "image",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            rotation: 0,
            visible: true,
            locked: false,
            style: {
                fill: "transparent",
                stroke: "#fff",
                strokeWidth: 2,
                fontSize: 14,
            },
            assetId: "asset-1",
        });
        expect(() =>
            parseBrowserPortable(
                JSON.stringify({
                    version: 1,
                    document,
                    assets: [
                        {
                            id: "asset-1",
                            boardId: document.id,
                            dataURL: "data:image/png;base64,bm90LXBuZw==",
                            width: 10,
                            height: 10,
                        },
                    ],
                }),
            ),
        ).toThrow(/invalid portable image asset/i);
    });
});
