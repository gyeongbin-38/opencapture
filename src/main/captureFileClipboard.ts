import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    existsSync,
    promises as fsAsync,
    realpathSync,
    statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BrowserWindow } from "electron";

const FILE_LIMIT = 50;
const BYTE_LIMIT = 200 * 1024 * 1024;

export function encodeWindowsDropFiles(paths: string[]) {
    const names = Buffer.from(`${paths.join("\0")}\0\0`, "utf16le");
    const header = Buffer.alloc(20);
    header.writeUInt32LE(20, 0);
    header.writeUInt32LE(1, 16);
    return Buffer.concat([header, names]);
}

function nativeHandle(window: BrowserWindow) {
    const bytes = window.getNativeWindowHandle();
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--)
        value = (value << 8n) | BigInt(bytes[index]);
    if (!value) throw new Error("A valid clipboard owner window is required.");
    return value.toString();
}

function runtimePaths(root: string) {
    const base = join("assets", "runtime", "win32-x64");
    const roots = [
        root,
        join(process.resourcesPath, "app"),
        process.resourcesPath,
    ];
    for (const candidate of roots) {
        const python = join(candidate, base, "python.exe");
        const script = join(candidate, base, "clipboard-files.py");
        if (existsSync(python) && existsSync(script)) return { python, script };
    }
    throw new Error("The bundled Windows clipboard helper is unavailable.");
}

export function validateSourceFiles(paths: string[]) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > FILE_LIMIT)
        throw new Error(`Choose between 1 and ${FILE_LIMIT} files.`);
    const output: string[] = [];
    let total = 0;
    for (const path of paths) {
        if (typeof path !== "string" || !existsSync(path))
            throw new Error("A source file is missing.");
        const canonical = realpathSync(resolve(path));
        const stat = statSync(canonical);
        if (!stat.isFile()) throw new Error("Clipboard sources must be files.");
        total += stat.size;
        if (total > BYTE_LIMIT) throw new Error("Source files exceed 200 MiB.");
        if (!output.includes(canonical)) output.push(canonical);
    }
    return output;
}

export async function copyPathsToWindowsClipboard(
    root: string,
    owner: BrowserWindow,
    paths: string[],
    signal?: AbortSignal,
) {
    if (process.platform !== "win32")
        throw new Error("Windows clipboard is unavailable.");
    if (!paths.length || paths.length > 100)
        throw new Error("Choose up to 100 files or folders.");
    const files = paths.map((path) => {
        const canonical = realpathSync(resolve(path));
        const stat = statSync(canonical);
        if (!stat.isFile() && !stat.isDirectory())
            throw new Error("Choose regular files or folders.");
        return canonical;
    });
    const runtime = runtimePaths(root);
    signal?.throwIfAborted();
    const result = await new Promise<{
        error: Error | null;
        stdout: string;
        stderr: string;
    }>((done) => {
        const child = execFile(
            runtime.python,
            ["-X", "utf8", runtime.script],
            {
                encoding: "utf8",
                timeout: 10000,
                windowsHide: true,
                maxBuffer: 1024 * 1024,
                signal,
            },
            (error, stdout, stderr) => done({ error, stdout, stderr }),
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify({ hwnd: nativeHandle(owner), files }));
    });
    if (result.error) throw result.error;
    let response: { ok?: boolean; count?: number; error?: string };
    try {
        response = JSON.parse(result.stdout.trim());
    } catch {
        throw new Error(
            result.stderr.trim() || "Clipboard helper returned invalid output.",
        );
    }
    if (!response.ok || response.count !== files.length)
        throw new Error(
            response.error || "Windows rejected the file-list clipboard data.",
        );
    return { copied: files.length };
}

export async function copyFilesToWindowsClipboard(
    root: string,
    owner: BrowserWindow,
    paths: string[],
    snapshotRoot: string,
) {
    if (process.platform !== "win32")
        throw new Error(
            "Native source-file copy is available on Windows only.",
        );
    const files = validateSourceFiles(paths);
    const runtime = runtimePaths(root);
    const generation = randomUUID();
    const directory = join(snapshotRoot, generation);
    await fsAsync.mkdir(directory, { recursive: true });
    const snapshots: string[] = [];
    let published = false;
    try {
        for (const [index, source] of files.entries()) {
            const target = join(directory, `${index + 1}-${basename(source)}`);
            await fsAsync.copyFile(source, target);
            snapshots.push(target);
        }
        const result = await new Promise<{
            error: Error | null;
            status: number;
            stdout: string;
            stderr: string;
        }>((resolveResult) => {
            const process = execFile(
                runtime.python,
                ["-X", "utf8", runtime.script],
                {
                    encoding: "utf8",
                    timeout: 10_000,
                    windowsHide: true,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout, stderr) =>
                    resolveResult({
                        error,
                        status: error ? 1 : 0,
                        stdout,
                        stderr,
                    }),
            );
            process.stdin?.on("error", () => {});
            process.stdin?.end(
                JSON.stringify({ hwnd: nativeHandle(owner), files: snapshots }),
            );
        });
        if (result.error) throw result.error;
        let response: { ok?: boolean; count?: number; error?: string } = {};
        try {
            response = JSON.parse(result.stdout.trim());
        } catch {
            throw new Error(
                result.stderr.trim() ||
                    "Clipboard helper returned invalid output.",
            );
        }
        if (
            result.status !== 0 ||
            !response.ok ||
            response.count !== files.length
        )
            throw new Error(
                response.error ||
                    "Windows rejected the file-list clipboard data.",
            );
        published = true;
        const previous = (
            await fsAsync
                .readdir(snapshotRoot, { withFileTypes: true })
                .catch(() => [])
        ).filter(
            (entry) =>
                entry.isDirectory() &&
                entry.name !== generation &&
                /^[0-9a-f-]{36}$/i.test(entry.name),
        );
        const dated = await Promise.all(
            previous.map(async (entry) => ({
                name: entry.name,
                time: (
                    await fsAsync
                        .stat(join(snapshotRoot, entry.name))
                        .catch(() => ({ mtimeMs: 0 }))
                ).mtimeMs,
            })),
        );
        dated.sort((a, b) => b.time - a.time);
        for (const entry of dated.slice(1)) {
            await fsAsync
                .rm(join(snapshotRoot, entry.name), {
                    recursive: true,
                    force: true,
                })
                .catch(() => undefined);
        }
        return { copied: files.length };
    } catch (error) {
        if (!published)
            await fsAsync
                .rm(directory, { recursive: true, force: true })
                .catch(() => undefined);
        throw error;
    }
}
