import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const filename = new URL(
    "../src/renderer/clip/clip_window.ts",
    import.meta.url,
);
const source = ts.createSourceFile(
    filename.pathname,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

function productionFunction(name: string) {
    const declaration = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    if (!declaration) throw new Error(`Production ${name} declaration missing`);
    return ts.transpileModule(
        `${declaration.getFullText(source)}\nglobalThis.__subject = ${name};`,
        {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        },
    ).outputText;
}

const completeSelectionJavascript =
    productionFunction("requireCaptureSelection") +
    productionFunction("completeSelectionAction");
const runCopyJavascript = productionFunction("runCopy");

type Subject = (...args: unknown[]) => Promise<unknown>;

function evaluate(javascript: string, state: Record<string, unknown>) {
    const context = vm.createContext(state);
    vm.runInContext(javascript, context, { filename: filename.pathname });
    return {
        context,
        subject: context.__subject as Subject,
    };
}

function selectionHarness(options: {
    preset: string;
    autoDo: string;
    runCopy?: () => Promise<boolean>;
    runSave?: () => Promise<void>;
}) {
    const calls: string[] = [];
    const state = {
        captureInitSequence: 1,
        finalRect: [10, 10, 100, 80],
        t: (value: string) => value,
        capturePreferences: { defaultPreset: options.preset },
        autoDo: options.autoDo,
        captureWorkspace: {
            stage: vi.fn(async () => {
                calls.push("stage");
            }),
            showError: vi.fn(),
            showStatus: vi.fn(),
        },
        runCopy:
            options.runCopy ??
            vi.fn(async () => {
                calls.push("copy");
                return true;
            }),
        runSave:
            options.runSave ??
            vi.fn(async () => {
                calls.push("save");
            }),
        setEditType: vi.fn(() => calls.push("annotate")),
        toolsX: {
            copy: { f: vi.fn(async () => calls.push("legacy-copy")) },
            save: { f: vi.fn(async () => calls.push("legacy-save")) },
            ding: { f: vi.fn(() => calls.push("pin")) },
        },
    };
    const evaluated = evaluate(completeSelectionJavascript, state);
    return { ...evaluated, state, calls };
}

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("production capture selection completion", () => {
    it("does not run automatic actions before a selection exists", async () => {
        const h = selectionHarness({ preset: "copy-close", autoDo: "save" });
        h.state.finalRect = [0, 0, 0, 0];
        await h.subject();
        expect(h.calls).toEqual([]);
        expect(h.state.captureWorkspace.showStatus).toHaveBeenCalledOnce();
    });
    it.each([
        ["copy-close", ["copy"]],
        ["annotate", ["annotate"]],
        ["stage-pin", ["stage", "pin"]],
    ])(
        "runs the %s preset without also running legacy autoDo",
        async (preset, expected) => {
            const h = selectionHarness({ preset, autoDo: "save" });
            await h.subject();
            expect(h.calls).toEqual(expected);
            expect(h.state.captureWorkspace.showError).not.toHaveBeenCalled();
        },
    );

    it("runs legacy copy-save in order and only saves after a successful copy", async () => {
        const success = selectionHarness({
            preset: "manual",
            autoDo: "copysave",
        });
        await success.subject();
        expect(success.calls).toEqual(["copy", "save"]);

        const failed = selectionHarness({
            preset: "manual",
            autoDo: "copysave",
            runCopy: vi.fn(async () => false),
        });
        await failed.subject();
        expect(failed.calls).toEqual([]);
    });

    it("does not save a stale legacy copy result", async () => {
        const copy = vi.fn(async () => true);
        const h = selectionHarness({
            preset: "manual",
            autoDo: "copysave",
            runCopy: copy,
        });
        copy.mockImplementation(async () => {
            h.state.captureInitSequence = 2;
            return true;
        });
        await h.subject();
        expect(h.calls).toEqual([]);
    });
});

describe("production capture copy transaction", () => {
    it("snapshots the PNG blob before awaiting draft staging", async () => {
        const stage = deferred<void>();
        const order: string[] = [];
        const blob = { id: "selection-png" };
        const close = vi.fn(() => order.push("close"));
        const state = {
            captureInitSequence: 1,
            getClipPhoto: vi.fn(() => {
                order.push("photo");
                return { id: "selection-canvas" };
            }),
            getBlob: vi.fn(async () => {
                order.push("blob");
                return blob;
            }),
            captureWorkspace: {
                stage: vi.fn(async () => {
                    order.push("stage");
                    await stage.promise;
                }),
                showError: vi.fn(),
            },
            writeImage: vi.fn(async (value) => {
                expect(value).toBe(blob);
                order.push("write");
            }),
            playDoneSound: vi.fn(() => order.push("sound")),
            toolsX: { close: { f: close } },
            t: (value: string) => value,
        };
        const h = evaluate(runCopyJavascript, state);
        const copying = h.subject();
        await vi.waitFor(() =>
            expect(order).toEqual(["photo", "blob", "stage"]),
        );
        expect(state.writeImage).not.toHaveBeenCalled();
        stage.resolve();
        await expect(copying).resolves.toBe(true);
        expect(order).toEqual([
            "photo",
            "blob",
            "stage",
            "write",
            "sound",
            "close",
        ]);
    });

    it("drops a copy when its capture generation changes during staging", async () => {
        const stage = deferred<void>();
        const state = {
            captureInitSequence: 1,
            getClipPhoto: vi.fn(() => ({})),
            getBlob: vi.fn(async () => ({ id: "blob" })),
            captureWorkspace: {
                stage: vi.fn(() => stage.promise),
                showError: vi.fn(),
            },
            writeImage: vi.fn(),
            playDoneSound: vi.fn(),
            toolsX: { close: { f: vi.fn() } },
            t: (value: string) => value,
        };
        const h = evaluate(runCopyJavascript, state);
        const copying = h.subject();
        await vi.waitFor(() =>
            expect(state.captureWorkspace.stage).toHaveBeenCalled(),
        );
        state.captureInitSequence = 2;
        stage.resolve();
        await expect(copying).resolves.toBe(false);
        expect(state.writeImage).not.toHaveBeenCalled();
        expect(state.playDoneSound).not.toHaveBeenCalled();
        expect(state.toolsX.close.f).not.toHaveBeenCalled();
    });

    it("shows copy errors and keeps the capture open", async () => {
        const error = new Error("clipboard unavailable");
        const state = {
            captureInitSequence: 1,
            getClipPhoto: vi.fn(() => ({})),
            getBlob: vi.fn(async () => ({ id: "blob" })),
            captureWorkspace: {
                stage: vi.fn(async () => {}),
                showError: vi.fn(),
            },
            writeImage: vi.fn(async () => {
                throw error;
            }),
            playDoneSound: vi.fn(),
            toolsX: { close: { f: vi.fn() } },
            t: (value: string) => value,
        };
        const h = evaluate(runCopyJavascript, state);
        await expect(h.subject()).resolves.toBe(false);
        expect(state.captureWorkspace.showError).toHaveBeenCalledWith(error);
        expect(state.playDoneSound).not.toHaveBeenCalled();
        expect(state.toolsX.close.f).not.toHaveBeenCalled();
    });
});
