import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 4_096;

export class ThumbnailDiskCache {
    constructor(readonly root: string) {
        mkdirSync(root, { recursive: true });
    }

    pathFor(key: string) {
        return join(
            this.root,
            `${createHash("sha256").update(key).digest("hex")}.png`,
        );
    }

    get(key: string) {
        const path = this.pathFor(key);
        return existsSync(path) ? path : undefined;
    }

    put(key: string, png: Buffer) {
        const path = this.pathFor(key);
        if (!existsSync(path)) writeFileSync(path, png, { flag: "wx" });
        this.evict();
        return path;
    }

    evict() {
        const entries = readdirSync(this.root)
            .filter((name) => /^[0-9a-f]{64}\.png$/.test(name))
            .map((name) => {
                const path = join(this.root, name);
                const stat = statSync(path);
                return { path, size: stat.size, time: stat.mtimeMs };
            })
            .sort((a, b) => b.time - a.time);
        let bytes = 0;
        for (let index = 0; index < entries.length; index++) {
            bytes += entries[index].size;
            if (index >= MAX_FILES || bytes > MAX_BYTES)
                rmSync(entries[index].path, { force: true });
        }
    }
}
