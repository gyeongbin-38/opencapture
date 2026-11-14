import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const file = new URL("../src/renderer/clip/clip_window.ts", import.meta.url);
const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
);
const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "openApp",
);
if (!declaration) throw new Error("Production external-open function missing");
const code = ts.transpileModule(
    `${declaration.getFullText(source)}\nglobalThis.openCapture = openApp`,
    {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
        },
    },
).outputText;
function harness(write: () => Promise<void> = async () => {}) {
    let id = 0;
    const fs = {
        promises: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(write) },
        writeFile: vi.fn(
            (
                _path: string,
                _data: Buffer,
                callback: (error?: unknown) => void,
            ) => {
                void write()
                    .then(() => callback())
                    .catch(callback);
            },
        ),
    };
    const opened = vi.fn(async (_path: string) => {});
    const showError = vi.fn();
    const context = vm.createContext({
        Buffer,
        require: (name: string) => {
            if (name === "node:path") return path;
            if (name === "node:os")
                return { tmpdir: () => path.resolve("capture-test-temp") };
            if (name === "node:fs") return fs;
            if (name === "node:crypto")
                return { randomUUID: () => `id-${++id}` };
            throw Error(name);
        },
        getClipPhoto: () => ({
            toDataURL: () => "data:image/png;base64,aW1hZ2U=",
        }),
        open_with: opened,
        captureWorkspace: { showError },
    });
    vm.runInContext(code, context);
    return {
        fs,
        opened,
        showError,
        open: context.openCapture as () => Promise<void>,
    };
}
describe("production capture external open", () => {
    it("creates the managed folder and finishes writing before opening", async () => {
        let finish!: () => void;
        const h = harness(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = h.open();
        await vi.waitFor(() =>
            expect(h.fs.promises.writeFile).toHaveBeenCalledOnce(),
        );
        expect(h.opened).not.toHaveBeenCalled();
        expect(h.fs.promises.mkdir).toHaveBeenCalledOnce();
        finish();
        await pending;
        expect(h.opened).toHaveBeenCalledWith(
            expect.stringContaining("OpenCapture"),
        );
        expect(h.showError).not.toHaveBeenCalled();
    });
    it("never opens a stale image after a failed write", async () => {
        const error = Error("disk unavailable");
        const h = harness(async () => {
            throw error;
        });
        await h.open();
        expect(h.opened).not.toHaveBeenCalled();
        expect(h.showError).toHaveBeenCalledWith(error);
    });
    it("keeps independent captures in different files", async () => {
        const h = harness();
        await h.open();
        await h.open();
        expect(h.opened.mock.calls[0]?.[0]).not.toBe(
            h.opened.mock.calls[1]?.[0],
        );
    });
});
