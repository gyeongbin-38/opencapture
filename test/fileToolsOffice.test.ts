import { EventEmitter } from "node:events";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({
    spawn: mocks.spawn,
    spawnSync: mocks.spawnSync,
}));

import { createOfficeTools } from "../src/main/fileToolsOffice";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

let fixture = "";
let outputDir = "";
let executable = "";
const originalMasDescriptor = Object.getOwnPropertyDescriptor(process, "mas");

function setMas(value: boolean) {
    Object.defineProperty(process, "mas", {
        configurable: true,
        value,
    });
}

beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "opencapture-office-test-"));
    outputDir = join(fixture, "output");
    executable = join(fixture, "soffice.exe");
    writeFileSync(executable, "fixture");
    mocks.spawn.mockReset();
    mocks.spawnSync.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalMasDescriptor)
        Object.defineProperty(process, "mas", originalMasDescriptor);
    else Reflect.deleteProperty(process, "mas");
    rmSync(fixture, { recursive: true, force: true });
});

function source(name: string, content = "fixture"): ToolInput {
    const path = join(fixture, name);
    writeFileSync(path, content);
    return {
        id: name,
        name,
        path,
        size: Buffer.byteLength(content),
        extension: name.slice(name.lastIndexOf(".") + 1),
        kind: "document",
    };
}

function context(
    input: ToolInput,
    format: string,
    signal = new AbortController().signal,
): ToolContext {
    return {
        inputs: [input],
        recipe: "office-convert",
        options: { format },
        outputDir,
        signal,
        progress: vi.fn(),
    };
}

function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
        pid: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.pid = 98765;
    return child;
}

function mockOwnedProcessTermination(success = true) {
    vi.spyOn(process, "kill").mockImplementation(((
        _pid: number,
        signal?: NodeJS.Signals | number,
    ) => {
        if (signal === 0 || success) return true;
        throw new Error("termination denied");
    }) as never);
    mocks.spawnSync.mockReturnValue({ status: success ? 0 : 1 });
}

function convertSuccessfully(
    content: string | Buffer,
    onLaunch?: (args: string[]) => void,
) {
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
        const child = fakeChild();
        const outdir = args[args.indexOf("--outdir") + 1];
        const input = args.at(-1) as string;
        const format = args[args.indexOf("--convert-to") + 1].split(":", 1)[0];
        mkdirSync(outdir, { recursive: true });
        writeFileSync(
            join(
                outdir,
                `${basename(input, `.${input.split(".").at(-1)}`)}.${format}`,
            ),
            content,
        );
        onLaunch?.(args);
        setImmediate(() => child.emit("close", 0));
        return child;
    });
}

describe("LibreOffice recipe availability", () => {
    it("blocks discovery and execution inside the Mac App Store sandbox", async () => {
        setMas(true);
        const engine = createOfficeTools({ executable });
        const input = source("document.docx");
        expect(engine.recipes([input])).toEqual([
            expect.objectContaining({
                id: "office-convert",
                available: false,
                reason: "LibreOffice conversion is unavailable in the Mac App Store sandbox.",
            }),
        ]);
        await expect(engine.run(context(input, "pdf"))).rejects.toThrow(
            "LibreOffice conversion is unavailable in the Mac App Store sandbox.",
        );
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.spawnSync).not.toHaveBeenCalled();
        expect(existsSync(outputDir)).toBe(false);
    });

    it("detects availability lazily without spawning and exposes fixed families", () => {
        const engine = createOfficeTools({ executable });
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(engine.recipes([source("document.docx")])).toEqual([
            expect.objectContaining({
                id: "office-convert",
                available: true,
                formats: ["docx", "odt", "rtf", "txt", "html", "pdf", "epub"],
            }),
        ]);
        expect(engine.recipes([source("sheet.xlsx")])).toEqual([
            expect.objectContaining({
                formats: ["xlsx", "ods", "csv", "tsv", "pdf"],
            }),
        ]);
        expect(engine.recipes([source("slides.pptx")])).toEqual([
            expect.objectContaining({ formats: ["pptx", "odp", "pdf"] }),
        ]);
        expect(engine.recipes([source("legacy.pages")])).toEqual([
            expect.objectContaining({
                formats: expect.not.arrayContaining(["pages"]),
            }),
        ]);
        expect(engine.recipes([source("book.epub")])).toEqual([]);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("returns an explicit unavailable recipe when LibreOffice is absent", () => {
        const engine = createOfficeTools({
            executable: join(fixture, "missing-soffice"),
        });
        expect(engine.recipes([source("document.docx")])).toEqual([
            expect.objectContaining({
                id: "office-convert",
                available: false,
                reason: "LibreOffice is not installed or could not be found.",
            }),
        ]);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("uses only formats shared by a mixed selection", () => {
        const engine = createOfficeTools({ executable });
        expect(
            engine.recipes([source("document.docx"), source("sheet.xlsx")]),
        ).toEqual([
            expect.objectContaining({ formats: ["pdf"], available: true }),
        ]);
    });
});

describe("LibreOffice execution", () => {
    it("runs a fixed headless PDF conversion in an isolated secure profile", async () => {
        let registry = "";
        convertSuccessfully("%PDF-1.7\nfixture", (args) => {
            const profile = new URL(
                args[0].slice("-env:UserInstallation=".length),
            );
            registry = readFileSync(
                join(
                    fileURLToPath(profile),
                    "user",
                    "registrymodifications.xcu",
                ),
                "utf8",
            );
        });
        const progress = vi.fn();
        const runContext = context(source("document.docx"), "pdf");
        runContext.progress = progress;
        const result = await createOfficeTools({ executable }).run(runContext);

        expect(result.paths.map((path) => basename(path))).toEqual([
            "document.pdf",
        ]);
        expect(readFileSync(result.paths[0], "utf8")).toContain("%PDF-1.7");
        expect(result.warnings).toEqual([
            "Layout may change when converting between office formats.",
        ]);
        expect(progress).toHaveBeenCalledWith(100);
        const [command, args, options] = mocks.spawn.mock.calls[0];
        expect(command).toBe(executable);
        expect(options).toMatchObject({ shell: false, windowsHide: true });
        expect(args).toEqual(
            expect.arrayContaining([
                "--headless",
                "--nologo",
                "--nodefault",
                "--nofirststartwizard",
                "--norestore",
                "--convert-to",
                "pdf:writer_pdf_Export",
                "--outdir",
            ]),
        );
        expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\//);
        expect(registry).toContain("MacroSecurityLevel");
        expect(registry).toContain(">3<");
        expect(registry).toContain("Office.Calc/Content/Update");
        expect(args.at(-1)).toMatch(
            /\.office-[^\\/]+[\\/]input[\\/]document\.docx$/,
        );
        expect(existsSync(args.at(-1) as string)).toBe(false);
    });

    it("uses official fixed Calc and Impress filters", async () => {
        convertSuccessfully("a,b\n1,2\n");
        await createOfficeTools({ executable }).run(
            context(source("sheet.xlsx"), "csv"),
        );
        expect(mocks.spawn.mock.calls[0][1]).toContain(
            "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,0,false,false",
        );

        mocks.spawn.mockReset();
        convertSuccessfully("%PDF-1.7\nslides");
        await createOfficeTools({ executable }).run(
            context(source("slides.pptx"), "pdf"),
        );
        expect(mocks.spawn.mock.calls[0][1]).toContain(
            "pdf:impress_pdf_Export",
        );
    });

    it("rejects invalid source metadata and destination formats before spawning", async () => {
        const engine = createOfficeTools({ executable });
        const mismatch = source("document.docx");
        mismatch.extension = "odt";
        await expect(engine.run(context(mismatch, "pdf"))).rejects.toThrow(
            "does not match",
        );
        await expect(
            engine.run(context(source("document.docx"), "pages")),
        ).rejects.toThrow("not valid");
        await expect(
            engine.run(context(source("book.epub"), "pdf")),
        ).rejects.toThrow("not valid");
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("honors cancellation before launch and waits for owned process close", async () => {
        const engine = createOfficeTools({ executable });
        const before = new AbortController();
        before.abort();
        await expect(
            engine.run(context(source("before.docx"), "pdf", before.signal)),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.spawn).not.toHaveBeenCalled();

        const child = fakeChild();
        mocks.spawn.mockReturnValue(child);
        mockOwnedProcessTermination();
        const active = new AbortController();
        const promise = engine.run(
            context(source("active.docx"), "pdf", active.signal),
        );
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
        active.abort();
        if (process.platform === "win32") {
            expect(mocks.spawnSync).toHaveBeenCalledWith(
                expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/i),
                ["/PID", "98765", "/T", "/F"],
                expect.objectContaining({ shell: false, windowsHide: true }),
            );
        } else {
            expect(process.kill).toHaveBeenCalledWith(-98765, "SIGTERM");
        }
        let settled = false;
        void promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(
            readdirSync(outputDir).some((name) => name.startsWith(".office-")),
        ).toBe(true);
        child.emit("close", null);
        await expect(promise).rejects.toMatchObject({ name: "AbortError" });
        expect(
            readdirSync(outputDir).some((name) => name.startsWith(".office-")),
        ).toBe(false);
    });

    it("waits for close after timeout before rejecting and cleaning work", async () => {
        vi.useFakeTimers();
        const child = fakeChild();
        mocks.spawn.mockReturnValue(child);
        mockOwnedProcessTermination();
        const promise = createOfficeTools({ executable }).run(
            context(source("timeout.docx"), "pdf"),
        );
        void promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(120_000);
        let settled = false;
        void promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        expect(
            readdirSync(outputDir).some((name) => name.startsWith(".office-")),
        ).toBe(true);
        child.emit("close", null);
        await expect(promise).rejects.toThrow("timed out");
        expect(
            readdirSync(outputDir).some((name) => name.startsWith(".office-")),
        ).toBe(false);
    });

    it("preserves work when the owned process cannot be terminated", async () => {
        vi.useFakeTimers();
        const child = fakeChild();
        mocks.spawn.mockReturnValue(child);
        mockOwnedProcessTermination(false);
        const active = new AbortController();
        const promise = createOfficeTools({ executable }).run(
            context(source("stuck.docx"), "pdf", active.signal),
        );
        void promise.catch(() => {});
        active.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(promise).rejects.toThrow("work was preserved");
        expect(
            readdirSync(outputDir).some((name) => name.startsWith(".office-")),
        ).toBe(true);
    });

    it("rejects successful exits with malformed output signatures", async () => {
        convertSuccessfully(Buffer.from("PK malformed archive"));
        await expect(
            createOfficeTools({ executable }).run(
                context(source("document.odt"), "docx"),
            ),
        ).rejects.toThrow(/invalid ZIP|Invalid/);
    });

    it("rejects HTML conversions that emit external files", async () => {
        mocks.spawn.mockImplementation((_command: string, args: string[]) => {
            const child = fakeChild();
            const outdir = args[args.indexOf("--outdir") + 1];
            mkdirSync(outdir, { recursive: true });
            writeFileSync(
                join(outdir, "document.html"),
                "<!doctype html><p>ok</p>",
            );
            writeFileSync(join(outdir, "document_html_abc.png"), "image");
            setImmediate(() => child.emit("close", 0));
            return child;
        });
        await expect(
            createOfficeTools({ executable }).run(
                context(source("document.docx"), "html"),
            ),
        ).rejects.toThrow("unsafe external files");
    });
});

it.runIf(Boolean(process.env.OPENCAPTURE_TEST_LIBREOFFICE))(
    "runs an opt-in installed LibreOffice probe",
    async () => {
        const configured = process.env.OPENCAPTURE_TEST_LIBREOFFICE as string;
        expect(
            createOfficeTools({ executable: configured }).recipes([
                source("probe.odt"),
            ]),
        ).toEqual([expect.objectContaining({ available: true })]);
    },
);
