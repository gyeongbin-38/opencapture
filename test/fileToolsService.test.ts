import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileToolEngine } from "../src/main/fileToolsTypes";

const electron = vi.hoisted(() => ({
    choose: vi.fn(),
    reveal: vi.fn(),
    writeText: vi.fn(),
    write: vi.fn(),
    owner: {
        isDestroyed: () => false,
        getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    },
}));
vi.mock("node:child_process", { spy: true });
vi.mock("electron", () => ({
    BrowserWindow: { fromWebContents: () => electron.owner },
    ShareMenu: class {},
    ClipboardItem: class {},
    app: { getFileIcon: vi.fn() },
    dialog: { showOpenDialog: electron.choose },
    shell: { showItemInFolder: electron.reveal },
    clipboard: { writeText: electron.writeText, write: electron.write },
    nativeImage: {},
}));
import { createFileToolsService } from "../src/main/fileToolsService";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const stubPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: platform,
    });

class Sender extends EventEmitter {
    constructor(readonly id: number) {
        super();
    }
    isDestroyed() {
        return false;
    }
    send = vi.fn();
}

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

describe("file tools ownership and publication", () => {
    const originalMas = Object.getOwnPropertyDescriptor(process, "mas");
    const originalResourcesPath = Object.getOwnPropertyDescriptor(
        process,
        "resourcesPath",
    );
    let directory: string;
    let destination: string;
    let input: string;
    let sender: Sender;
    let engine: FileToolEngine;
    let savedFolders: { id: string; name: string; path: string }[];
    const asSender = (value: Sender) =>
        value as unknown as import("electron").WebContents;
    const service = () =>
        createFileToolsService({
            root: join(directory, "app"),
            userData: join(directory, "profile"),
            pin: vi.fn(),
            edit: vi.fn(),
            engines: [engine],
            destinations: () => savedFolders,
        });
    beforeEach(async () => {
        const realChildProcess =
            await vi.importActual<typeof import("node:child_process")>(
                "node:child_process",
            );
        vi.mocked(childProcess.execFile)
            .mockReset()
            .mockImplementation(realChildProcess.execFile);
        directory = await fs.mkdtemp(join(tmpdir(), "oc-file-tools-"));
        Object.defineProperty(process, "resourcesPath", {
            configurable: true,
            value: directory,
        });
        destination = join(directory, "destination");
        savedFolders = [];
        await fs.mkdir(destination);
        input = join(directory, "original.txt");
        await fs.writeFile(input, "source unchanged");
        sender = new Sender(1);
        electron.choose
            .mockReset()
            .mockResolvedValue({ canceled: false, filePaths: [destination] });
        electron.write.mockReset().mockResolvedValue(undefined);
        engine = {
            recipes: () => [
                {
                    id: "test-convert",
                    label: "Test",
                    group: "convert",
                    formats: ["txt"],
                    available: true,
                },
            ],
            run: async (context) => {
                const path = join(context.outputDir, "result.txt");
                await fs.writeFile(path, "converted", { flag: "wx" });
                return { paths: [path] };
            },
        };
    });
    afterEach(async () => {
        if (originalMas) Object.defineProperty(process, "mas", originalMas);
        else Reflect.deleteProperty(process, "mas");
        vi.restoreAllMocks();
        if (originalResourcesPath)
            Object.defineProperty(
                process,
                "resourcesPath",
                originalResourcesPath,
            );
        else Reflect.deleteProperty(process, "resourcesPath");
        if (originalPlatform)
            Object.defineProperty(process, "platform", originalPlatform);
        if (
            directory &&
            resolve(directory).startsWith(resolve(tmpdir())) &&
            basename(directory).startsWith("oc-file-tools-")
        )
            await fs.rm(directory, { recursive: true, force: true });
    });
    const request = (sourceIds: string[], jobId = "job-1") => ({
        jobId,
        sourceIds,
        recipe: "test-convert",
        options: { format: "txt" },
    });

    it("reports and independently enforces the macOS copy limit", async () => {
        stubPlatform("darwin");
        const second = join(directory, "second.txt");
        await fs.writeFile(second, "second");
        const api = service();
        const selected = await api.select(asSender(sender), [input, second]);
        expect(selected.copyMaxFiles).toBe(1);
        await expect(
            api.sourceAction(
                asSender(sender),
                selected.sources.map((source) => source.id),
                "copy",
                "mac-copy-many",
            ),
        ).rejects.toThrow("Copy one file at a time on macOS.");
        expect(electron.write).not.toHaveBeenCalled();
        await expect(
            api.sourceAction(
                asSender(sender),
                selected.sources.map((source) => source.id),
                "copy-path",
                "mac-copy-paths",
            ),
        ).resolves.toEqual({ ok: true });
        expect(electron.writeText).toHaveBeenLastCalledWith(
            [input, second].join("\n"),
        );
        await expect(
            api.sourceAction(
                asSender(sender),
                [selected.sources[0].id],
                "copy",
                "mac-copy-one",
            ),
        ).resolves.toEqual({ ok: true });
        expect(electron.write).toHaveBeenCalledOnce();
    });

    it("reports the Windows 100-file copy capability", async () => {
        stubPlatform("win32");
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        expect(selected.copyMaxFiles).toBe(100);
    });

    it("grants source tokens, preserves originals and never overwrites a colliding output", async () => {
        const api = service();
        const selection = await api.select(asSender(sender), [input]);
        expect(selection.sources).toHaveLength(1);
        expect(selection.sources[0]).not.toHaveProperty("path");
        await fs.writeFile(
            join(destination, "result.txt"),
            "existing user file",
        );
        const [result] = await api.run(
            asSender(sender),
            request([selection.sources[0].id]),
        );
        expect(result.status).toBe("success");
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
        expect(await fs.readFile(join(destination, "result.txt"), "utf8")).toBe(
            "existing user file",
        );
        expect(
            await fs.readFile(
                join(destination, result.outputs[0].name),
                "utf8",
            ),
        ).toBe("converted");
        await expect(
            api.outputAction(
                asSender(new Sender(2)),
                result.outputs[0].id,
                "reveal",
            ),
        ).rejects.toThrow("no longer available");
    });

    it("keeps file and folder picker intent separate", async () => {
        const api = service();
        electron.choose.mockResolvedValue({ canceled: true, filePaths: [] });
        await api.select(asSender(sender));
        expect(electron.choose.mock.calls[0][1].properties).toEqual([
            "openFile",
            "multiSelections",
        ]);
        await api.select(asSender(sender), undefined, "folders");
        expect(electron.choose.mock.calls[1][1].properties).toEqual([
            "openDirectory",
            "multiSelections",
        ]);
    });

    it("exports to an opaque saved folder without prompting or overwriting", async () => {
        savedFolders = [{ id: "saved", name: "Work", path: destination }];
        const api = service();
        const selection = await api.select(asSender(sender), [input]);
        expect(selection.destinations).toEqual([
            { id: "saved", name: "Work", available: true },
        ]);
        expect(selection.destinations?.[0]).not.toHaveProperty("path");
        await fs.writeFile(join(destination, "result.txt"), "existing");
        const [result] = await api.run(asSender(sender), {
            ...request([selection.sources[0].id]),
            destinationId: "saved",
        });
        expect(result.status).toBe("success");
        expect(electron.choose).not.toHaveBeenCalled();
        expect(await fs.readFile(join(destination, "result.txt"), "utf8")).toBe(
            "existing",
        );
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
        expect(
            await fs.readFile(
                join(destination, result.outputs[0].name),
                "utf8",
            ),
        ).toBe("converted");
    });

    it("copies to a saved folder and rejects unknown or stale destinations", async () => {
        savedFolders = [{ id: "saved", name: "Work", path: destination }];
        const api = service();
        const selection = await api.select(asSender(sender), [input]);
        const ids = [selection.sources[0].id];
        await expect(
            api.sourceAction(
                asSender(sender),
                ids,
                "copy-to",
                "copy-saved",
                "saved",
            ),
        ).resolves.toMatchObject({ ok: true });
        const copied = (await fs.readdir(destination)).filter((name) =>
            name.endsWith(".txt"),
        );
        expect(copied).toHaveLength(1);
        expect(await fs.readFile(join(destination, copied[0]), "utf8")).toBe(
            "source unchanged",
        );
        await expect(
            api.sourceAction(
                asSender(sender),
                ids,
                "copy-to",
                "unknown",
                "../outside",
            ),
        ).rejects.toThrow("no longer available");
        savedFolders[0].path = join(directory, "missing-folder");
        await expect(
            api.sourceAction(
                asSender(sender),
                ids,
                "copy-to",
                "missing",
                "saved",
            ),
        ).rejects.toThrow("Choose another folder");
        expect(electron.choose).not.toHaveBeenCalled();
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
    });

    it("does not reuse a cached external folder in the MAS distribution", async () => {
        Object.defineProperty(process, "mas", {
            configurable: true,
            value: true,
        });
        savedFolders = [{ id: "saved", name: "Work", path: destination }];
        const api = service();
        const selection = await api.select(asSender(sender), [input]);
        expect(selection.destinations?.[0]).toMatchObject({ available: false });
        await expect(
            api.sourceAction(
                asSender(sender),
                [selection.sources[0].id],
                "copy-to",
                "mas-copy",
                "saved",
            ),
        ).rejects.toThrow("Select the folder again");
        expect(await fs.readdir(destination)).toEqual([]);
        expect(electron.choose).not.toHaveBeenCalled();
    });

    it("keeps a multi-file recipe scoped to compatible sources in a mixed selection", async () => {
        const first = join(directory, "first.pdf");
        const second = join(directory, "second.pdf");
        await fs.writeFile(first, "pdf fixture");
        await fs.writeFile(second, "pdf fixture");
        engine.recipes = (inputs) =>
            inputs.some((item) => item.kind === "pdf")
                ? [
                      {
                          id: "pdf-merge",
                          label: "Merge PDFs",
                          group: "tools",
                          multiple: true,
                          minSources: 2,
                          available:
                              inputs.length >= 2 &&
                              inputs.every((item) => item.kind === "pdf"),
                      },
                  ]
                : [];
        const selection = await service().select(asSender(sender), [
            input,
            first,
            second,
        ]);
        const merge = selection.recipes.find(
            (recipe) => recipe.id === "pdf-merge",
        );
        expect(merge?.available).toBe(true);
        expect(merge?.sourceIds).toEqual(
            selection.sources
                .filter((source) => source.kind === "pdf")
                .map((source) => source.id),
        );
    });

    it("copies a mixed file/folder selection using native path data without altering originals", async () => {
        const runtime = join(
            directory,
            "app",
            "assets",
            "runtime",
            "win32-x64",
        );
        await fs.mkdir(runtime, { recursive: true });
        await fs.writeFile(join(runtime, "python.exe"), "test stub");
        await fs.writeFile(join(runtime, "clipboard-files.py"), "test stub");
        const folder = join(directory, "folder");
        await fs.mkdir(folder);
        let payload: { files?: string[] } = {};
        vi.mocked(childProcess.execFile).mockImplementation(((
            file,
            args,
            options,
            callback,
        ) => {
            expect(String(file)).toContain("python.exe");
            return {
                stdin: {
                    on: () => {},
                    end: (value: string) => {
                        payload = JSON.parse(value);
                        queueMicrotask(() =>
                            callback(
                                null,
                                JSON.stringify({ ok: true, count: 2 }),
                                "",
                            ),
                        );
                    },
                },
            } as unknown as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);
        const api = service();
        const selected = await api.select(asSender(sender), [input, folder]);
        expect(
            await api.sourceAction(
                asSender(sender),
                selected.sources.map((source) => source.id),
                "copy",
                "copy-1",
            ),
        ).toEqual({ ok: true });
        expect(payload.files).toEqual([
            await fs.realpath(input),
            await fs.realpath(folder),
        ]);
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
    });

    it("rejects foreign handles and unexpected output paths", async () => {
        const api = service();
        const selection = await api.select(asSender(sender), [input]);
        await expect(
            api.run(
                asSender(new Sender(2)),
                request([selection.sources[0].id]),
            ),
        ).rejects.toThrow("no longer available");
        engine.run = async () => ({ paths: [input] });
        const [result] = await api.run(
            asSender(sender),
            request([selection.sources[0].id]),
        );
        expect(result.status).toBe("error");
        expect(result.error).toContain("outside");
        expect(await fs.readdir(destination)).toEqual([]);
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
    });

    it("cancels an owned job, removes staging and never publishes", async () => {
        const entered = deferred();
        engine.run = async ({ signal }) => {
            entered.resolve();
            await new Promise<void>((_resolve, reject) =>
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("abort")),
                    { once: true },
                ),
            );
            return { paths: [] };
        };
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const running = api.run(
            asSender(sender),
            request([selected.sources[0].id]),
        );
        await entered.promise;
        expect(api.cancel(asSender(new Sender(2)), "job-1")).toBe(false);
        expect(api.cancel(asSender(sender), "job-1")).toBe(true);
        expect((await running)[0].status).toBe("cancelled");
        expect(await fs.readdir(destination)).toEqual([]);
        expect(
            await fs.readdir(
                join(directory, "profile", "file-tools", "staging"),
            ),
        ).toEqual([]);
    });

    it("preserves staging when an external engine cannot confirm process termination", async () => {
        engine.run = async ({ outputDir }) => {
            await fs.writeFile(
                join(outputDir, "recovery.txt"),
                "still owned by the engine",
            );
            throw Object.assign(
                new Error(
                    "Process termination unconfirmed; temporary work preserved.",
                ),
                { preserveWork: true },
            );
        };
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const [result] = await api.run(
            asSender(sender),
            request([selected.sources[0].id]),
        );
        expect(result.status).toBe("error");
        const staging = join(directory, "profile", "file-tools", "staging");
        const [job] = await fs.readdir(staging);
        expect(
            await fs.readFile(join(staging, job, "recovery.txt"), "utf8"),
        ).toBe("still owned by the engine");
        expect(await fs.readdir(destination)).toEqual([]);
    });

    it("revokes handles and aborts work when the document navigates", async () => {
        const entered = deferred();
        engine.run = async ({ signal }) => {
            entered.resolve();
            await new Promise<void>((_resolve, reject) =>
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("abort")),
                    { once: true },
                ),
            );
            return { paths: [] };
        };
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const running = api.run(
            asSender(sender),
            request([selected.sources[0].id]),
        );
        await entered.promise;
        sender.emit("did-start-navigation");
        expect((await running)[0].status).toBe("cancelled");
        await expect(
            api.sourceAction(
                asSender(sender),
                [selected.sources[0].id],
                "copy-path",
            ),
        ).rejects.toThrow("no longer available");
    });

    it("preserves foreign children created during a failing directory publication", async () => {
        engine.run = async ({ outputDir }) => {
            const path = join(outputDir, "extracted");
            await fs.mkdir(path);
            await fs.writeFile(join(path, "shared.txt"), "engine data");
            return { paths: [path] };
        };
        const originalMkdir = fs.mkdir.bind(fs);
        vi.spyOn(fs, "mkdir").mockImplementation((async (path, options) => {
            const result = await originalMkdir(
                path,
                options as { recursive: true },
            );
            if (String(path) === join(destination, "extracted"))
                await fs.writeFile(
                    join(String(path), "shared.txt"),
                    "foreign user data",
                );
            return result;
        }) as typeof fs.mkdir);
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const [result] = await api.run(
            asSender(sender),
            request([selected.sources[0].id]),
        );
        expect(result.status).toBe("error");
        expect(
            await fs.readFile(
                join(destination, "extracted", "shared.txt"),
                "utf8",
            ),
        ).toBe("foreign user data");
    });

    it("moves a changing folder atomically without dropping newly created files", async () => {
        const folder = join(directory, "folder");
        await fs.mkdir(folder);
        await fs.writeFile(join(folder, "first.txt"), "first");
        const originalExec = (
            await vi.importActual<typeof import("node:child_process")>(
                "node:child_process",
            )
        ).execFile;
        vi.mocked(childProcess.execFile).mockImplementation(((
            file,
            args,
            options,
            callback,
        ) => {
            const code = Buffer.from(args[3], "base64").toString("utf16le");
            const source = /::Move\('([^']+)'/.exec(code)?.[1];
            if (source)
                require("node:fs").writeFileSync(
                    join(source, "new.txt"),
                    "new content",
                );
            return originalExec(file, args, options, callback);
        }) as typeof childProcess.execFile);
        const api = service();
        const selected = await api.select(asSender(sender), [folder]);
        await api.sourceAction(
            asSender(sender),
            [selected.sources[0].id],
            "move-to",
            "action-1",
        );
        const [moved] = await fs.readdir(destination);
        expect(
            await fs.readFile(join(destination, moved, "new.txt"), "utf8"),
        ).toBe("new content");
        expect(
            await fs.readFile(join(destination, moved, "first.txt"), "utf8"),
        ).toBe("first");
    });

    it("never overwrites a target created after destination checking", async () => {
        const originalExec = (
            await vi.importActual<typeof import("node:child_process")>(
                "node:child_process",
            )
        ).execFile;
        let target = "";
        vi.mocked(childProcess.execFile).mockImplementation(((
            file,
            args,
            options,
            callback,
        ) => {
            const code = Buffer.from(args[3], "base64").toString("utf16le");
            target = /::Move\('[^']+','([^']+)'/.exec(code)?.[1] ?? "";
            require("node:fs").writeFileSync(target, "foreign user file");
            return originalExec(file, args, options, callback);
        }) as typeof childProcess.execFile);
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        await expect(
            api.sourceAction(
                asSender(sender),
                [selected.sources[0].id],
                "move-to",
                "action-1",
            ),
        ).rejects.toThrow();
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
        expect(await fs.readFile(target, "utf8")).toBe("foreign user file");
    });

    it("keeps the file name and handle usable after a native move", async () => {
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const outcome = await api.sourceAction(
            asSender(sender),
            [selected.sources[0].id],
            "move-to",
            "move-name",
        );
        expect(outcome.sources?.[0].name).toBe("original.txt");
        expect(
            await fs.readFile(join(destination, "original.txt"), "utf8"),
        ).toBe("source unchanged");
        await api.sourceAction(
            asSender(sender),
            [selected.sources[0].id],
            "copy-path",
        );
        expect(electron.writeText).toHaveBeenLastCalledWith(
            join(destination, "original.txt"),
        );
    });

    it("does not rename a file when moving to its current folder", async () => {
        electron.choose.mockResolvedValue({
            canceled: false,
            filePaths: [directory],
        });
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        await api.sourceAction(
            asSender(sender),
            [selected.sources[0].id],
            "move-to",
            "same-folder",
        );
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
        expect(await fs.readdir(directory)).toContain("original.txt");
    });

    it("tracks file actions for cancellation and blocks overlapping jobs", async () => {
        const entered = deferred();
        const resume = deferred();
        const originalOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation((async (path, flags, mode) => {
            const handle = await originalOpen(path, flags, mode);
            if (dirname(String(path)) === destination) {
                entered.resolve();
                await resume.promise;
            }
            return handle;
        }) as typeof fs.open);
        const api = service();
        const selected = await api.select(asSender(sender), [input]);
        const copying = api.sourceAction(
            asSender(sender),
            [selected.sources[0].id],
            "copy-to",
            "action-1",
        );
        await entered.promise;
        await expect(
            api.run(asSender(sender), request([selected.sources[0].id])),
        ).rejects.toThrow("current job");
        expect(api.cancel(asSender(sender), "action-1")).toBe(true);
        resume.resolve();
        await expect(copying).rejects.toThrow();
        expect(await fs.readdir(destination)).toEqual([]);
        expect(await fs.readFile(input, "utf8")).toBe("source unchanged");
    });
});
