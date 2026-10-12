import { randomUUID } from "node:crypto";
import {
    existsSync,
    promises as fsAsync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
    CaptureDraft,
    CaptureDraftManifest,
    CaptureRect,
    CaptureSourceContext,
    StageCaptureInput,
} from "../../lib/openCaptureTypes";
import { replaceFile, replaceFileSync } from "./atomicReplace";

const SOURCE_LIMIT = 64 * 1024 * 1024;
const PREVIEW_LIMIT = 32 * 1024 * 1024;
const CANVAS_LIMIT = 8 * 1024 * 1024;
const PIXEL_LIMIT = 32_000_000;
const OBJECT_LIMIT = 10_000;

function pngBuffer(dataURL: string, maximum: number) {
    const prefix = "data:image/png;base64,";
    if (!dataURL.startsWith(prefix))
        throw new Error("Capture payload must be PNG data.");
    if (dataURL.length > prefix.length + Math.ceil((maximum * 4) / 3) + 4)
        throw new Error("Capture payload exceeds the byte limit.");
    const buffer = Buffer.from(dataURL.slice(prefix.length), "base64");
    if (!buffer.length || buffer.length > maximum)
        throw new Error("Capture payload exceeds the byte limit.");
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG")
        throw new Error("Capture payload has an invalid PNG header.");
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height || width * height > PIXEL_LIMIT)
        throw new Error("Capture image exceeds 32 megapixels.");
    return buffer;
}

function validRect(value: CaptureRect) {
    return (
        [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
        value.x >= 0 &&
        value.y >= 0 &&
        value.width > 0 &&
        value.height > 0
    );
}

function canvasSnapshot(value: unknown) {
    const json = JSON.stringify(value ?? {});
    if (Buffer.byteLength(json) > CANVAS_LIMIT)
        throw new Error("Editable capture data exceeds 8 MiB.");
    const parsed = JSON.parse(json) as { objects?: unknown };
    if (Array.isArray(parsed?.objects) && parsed.objects.length > OBJECT_LIMIT)
        throw new Error("Editable capture data exceeds 10,000 objects.");
    return json;
}

function safeId(value: string) {
    if (!/^[0-9a-f-]{20,64}$/i.test(value))
        throw new Error("Invalid draft id.");
    return value;
}

function defaultSource(): CaptureSourceContext {
    return { kind: "capture", capturedAt: new Date().toISOString() };
}

export class CaptureDraftStore {
    readonly root: string;

    constructor(root: string) {
        this.root = resolve(root);
        mkdirSync(this.root, { recursive: true });
    }

    manifestPath(id: string) {
        return join(this.root, safeId(id), "manifest.json");
    }

    manifest(id: string): CaptureDraftManifest | undefined {
        const path = this.manifestPath(id);
        if (!existsSync(path)) return undefined;
        try {
            const value = JSON.parse(
                readFileSync(path, "utf8"),
            ) as CaptureDraftManifest;
            if (
                value.version !== 1 ||
                value.id !== id ||
                !Number.isSafeInteger(value.revision)
            )
                return undefined;
            for (const ownedPath of [
                value.sourcePath,
                value.previewPath,
                value.canvasPath,
            ]) {
                const resolved = resolve(ownedPath);
                if (
                    !resolved.startsWith(`${join(this.root, id)}\\`) &&
                    !resolved.startsWith(`${join(this.root, id)}/`)
                )
                    return undefined;
                if (!existsSync(resolved)) return undefined;
            }
            return value;
        } catch {
            return undefined;
        }
    }

    async stage(input: StageCaptureInput, liveDraftCount: number) {
        const id = input.id ? safeId(input.id) : randomUUID();
        const previous = this.manifest(id);
        if (!previous && liveDraftCount >= 80)
            throw new Error("At most 80 live drafts are allowed.");
        if (previous && input.expectedRevision !== previous.revision)
            throw new Error("Draft revision is stale.");
        if (!previous && input.expectedRevision !== undefined)
            throw new Error("A new draft cannot specify an expected revision.");
        if (!validRect(input.rect))
            throw new Error("Draft selection rectangle is invalid.");
        const preview = pngBuffer(input.previewDataURL, PREVIEW_LIMIT);
        const canvas = canvasSnapshot(input.canvas);
        const revision = (previous?.revision ?? 0) + 1;
        const generation = `${revision}-${randomUUID()}`;
        const draftDir = join(this.root, id);
        const sourcePath = join(draftDir, "source.png");
        const committed = join(draftDir, generation);
        await fsAsync.mkdir(committed, { recursive: true });
        try {
            if (!previous) {
                if (!input.sourceDataURL)
                    throw new Error(
                        "A new draft requires immutable source data.",
                    );
                const source = pngBuffer(input.sourceDataURL, SOURCE_LIMIT);
                await fsAsync.mkdir(draftDir, { recursive: true });
                if (existsSync(sourcePath)) {
                    if (!source.equals(readFileSync(sourcePath)))
                        throw new Error("Draft source is immutable.");
                } else {
                    await fsAsync.writeFile(`${sourcePath}.tmp`, source, {
                        flag: "wx",
                    });
                    await replaceFile(`${sourcePath}.tmp`, sourcePath);
                }
            } else if (input.sourceDataURL) {
                const source = pngBuffer(input.sourceDataURL, SOURCE_LIMIT);
                if (!source.equals(readFileSync(sourcePath)))
                    throw new Error("Draft source is immutable.");
            }
            const previewPath = join(committed, "preview.png");
            const canvasPath = join(committed, "canvas.json");
            await fsAsync.writeFile(previewPath, preview, { flag: "wx" });
            await fsAsync.writeFile(canvasPath, canvas, { flag: "wx" });
            const manifest: CaptureDraftManifest = {
                version: 1,
                id,
                revision,
                generation,
                sourcePath,
                previewPath: join(committed, "preview.png"),
                canvasPath: join(committed, "canvas.json"),
                rect: { ...input.rect },
                source: previous?.source ?? input.source ?? defaultSource(),
                committedAt: new Date().toISOString(),
            };
            const temporary = join(draftDir, "manifest.json.tmp");
            await fsAsync.writeFile(
                temporary,
                JSON.stringify(manifest, null, 2),
            );
            await replaceFile(temporary, join(draftDir, "manifest.json"));
            return manifest;
        } catch (error) {
            await fsAsync.rm(committed, { recursive: true, force: true });
            throw error;
        }
    }

    get(id: string): CaptureDraft {
        const manifest = this.manifest(id);
        if (!manifest) throw new Error("Draft is missing or corrupt.");
        const dataURL = (path: string) =>
            `data:image/png;base64,${readFileSync(path).toString("base64")}`;
        return {
            id,
            revision: manifest.revision,
            sourceDataURL: dataURL(manifest.sourcePath),
            previewDataURL: dataURL(manifest.previewPath),
            canvas: JSON.parse(readFileSync(manifest.canvasPath, "utf8")),
            rect: manifest.rect,
            source: manifest.source,
        };
    }

    list(): CaptureDraftManifest[] {
        return readdirSync(this.root)
            .filter((id) => /^[0-9a-f-]{20,64}$/i.test(id))
            .flatMap((id) => {
                const manifest = this.manifest(id);
                return manifest ? [manifest] : [];
            });
    }

    finalize(id: string) {
        const current = this.manifest(id);
        if (!current) return;
        const directory = join(this.root, safeId(id));
        for (const entry of readdirSync(directory)) {
            if (
                entry !== current.generation &&
                /^(?:\.pending-)?\d+-[0-9a-f-]{36}$/i.test(entry)
            )
                rmSync(join(directory, entry), {
                    recursive: true,
                    force: true,
                });
        }
    }

    rollback(committed: CaptureDraftManifest, previous?: CaptureDraftManifest) {
        const draftDir = join(this.root, safeId(committed.id));
        if (!previous) {
            rmSync(draftDir, { recursive: true, force: true });
            return;
        }
        const temporary = join(draftDir, "manifest.json.rollback");
        writeFileSync(temporary, JSON.stringify(previous, null, 2));
        replaceFileSync(temporary, this.manifestPath(committed.id));
        rmSync(join(draftDir, committed.generation), {
            recursive: true,
            force: true,
        });
    }
}
