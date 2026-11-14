import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LatestLiveTranslation,
    normalizeTranslatedTexts,
} from "../src/renderer/clip/openCaptureLiveTranslation";

const clipSourcePath = resolve(
    __dirname,
    "../src/renderer/clip/clip_window.ts",
);
const clipSourceText = readFileSync(clipSourcePath, "utf8");
const clipSource = ts.createSourceFile(
    clipSourcePath,
    clipSourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

const translateDeclaration = clipSource.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "translateCurrentSelection",
);
if (!translateDeclaration)
    throw new Error("translateCurrentSelection production function is missing");

function productionTranslateCurrentSelection(globals: Record<string, unknown>) {
    const source = `${translateDeclaration.getFullText(clipSource)}\nglobalThis.translateCurrentSelection = translateCurrentSelection;`;
    const javascript = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const context = createContext({ Promise, ...globals });
    runInContext(javascript, context, { filename: clipSourcePath });
    return context.translateCurrentSelection as (
        isCurrent?: () => boolean,
    ) => Promise<string>;
}

function productionSchedule(globals: Record<string, unknown>) {
    const declaration = clipSource.statements.find(
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === "scheduleLiveTranslation",
    );
    if (!declaration) throw new Error("Production selection scheduler missing");
    const context = createContext(globals);
    runInContext(
        ts.transpileModule(
            `${declaration.getFullText(clipSource)}\nglobalThis.schedule = scheduleLiveTranslation;`,
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            },
        ).outputText,
        context,
    );
    return context as typeof globals & { schedule: () => void };
}

const ocrResult = (...texts: string[]) => ({
    columns: [
        {
            parragraphs: texts.map((text) => ({ parse: { text } })),
        },
    ],
});

afterEach(() => vi.useRealTimers());

describe("LatestLiveTranslation", () => {
    it("debounces rapid selection changes", async () => {
        vi.useFakeTimers();
        const published: string[] = [];
        const controller = new LatestLiveTranslation<string>(
            (value) => published.push(value),
            () => undefined,
            100,
        );
        const first = vi.fn(async () => "first");
        const second = vi.fn(async () => "second");

        controller.schedule(first);
        await vi.advanceTimersByTimeAsync(50);
        controller.schedule(second);
        await vi.advanceTimersByTimeAsync(100);

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
        expect(published).toEqual(["second"]);
    });

    it("serializes work and discards a stale result", async () => {
        vi.useFakeTimers();
        const published: string[] = [];
        let finishFirst: ((value: string) => void) | undefined;
        const controller = new LatestLiveTranslation<string>(
            (value) => published.push(value),
            () => undefined,
            10,
        );

        controller.schedule(
            () =>
                new Promise<string>((resolve) => {
                    finishFirst = resolve;
                }),
        );
        await vi.advanceTimersByTimeAsync(10);
        controller.schedule(async () => "latest");
        await vi.advanceTimersByTimeAsync(10);

        expect(published).toEqual([]);
        finishFirst?.("stale");
        await Promise.resolve();
        await Promise.resolve();

        expect(published).toEqual(["latest"]);
    });

    it("cancels pending publication", async () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const controller = new LatestLiveTranslation(
            publish,
            () => undefined,
            10,
        );
        controller.schedule(async () => "ignored");
        controller.cancel();
        await vi.runAllTimersAsync();
        expect(publish).not.toHaveBeenCalled();
    });

    it("invalidates a running task before it starts the next expensive step", async () => {
        vi.useFakeTimers();
        let isCurrent: (() => boolean) | undefined;
        let complete: ((value: string) => void) | undefined;
        const publish = vi.fn();
        const controller = new LatestLiveTranslation<string>(
            publish,
            vi.fn(),
            10,
        );
        controller.schedule((current: () => boolean) => {
            isCurrent = current;
            return new Promise<string>((resolve) => {
                complete = resolve;
            });
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(isCurrent?.()).toBe(true);
        controller.cancel();
        expect(isCurrent?.()).toBe(false);
        complete?.("old");
        await vi.runAllTimersAsync();
        expect(publish).not.toHaveBeenCalled();
    });
});

describe("normalizeTranslatedTexts", () => {
    it("supports the shared translation response shapes", () => {
        expect(normalizeTranslatedTexts("하나")).toEqual(["하나"]);
        expect(normalizeTranslatedTexts(["하나", 2, "둘"])).toEqual([
            "하나",
            "둘",
        ]);
        expect(normalizeTranslatedTexts({ texts: ["하나"] })).toEqual(["하나"]);
    });

    it("rejects malformed responses", () => {
        expect(() => normalizeTranslatedTexts({ text: "하나" })).toThrow(
            "올바르지 않은 응답",
        );
    });
});

describe("translateCurrentSelection production integration", () => {
    it("does not run OCR after the selection was invalidated during initialization", async () => {
        let finish:
            | ((value: { ocr: ReturnType<typeof vi.fn> }) => void)
            | undefined;
        const pending = new Promise<{ ocr: ReturnType<typeof vi.fn> }>(
            (resolve) => {
                finish = resolve;
            },
        );
        const ocr = vi.fn().mockResolvedValue(ocrResult("old"));
        const invoke = vi.fn().mockResolvedValue("old");
        let current = true;
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 20, 20],
            getClipPhoto: () => ({ toDataURL: () => "old:data" }),
            getLiveOcr: () => pending,
            store: { get: () => "" },
            ipcRenderer: { invoke },
            normalizeTranslatedTexts,
        });
        const result = translate(() => current);
        current = false;
        finish?.({ ocr });
        await expect(result).resolves.toBe("");
        expect(ocr).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("does not send stale OCR text to a translation provider", async () => {
        let finish: ((value: ReturnType<typeof ocrResult>) => void) | undefined;
        const pending = new Promise<ReturnType<typeof ocrResult>>((resolve) => {
            finish = resolve;
        });
        const invoke = vi.fn().mockResolvedValue("old");
        let current = true;
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 20, 20],
            getClipPhoto: () => ({ toDataURL: () => "old:data" }),
            getLiveOcr: async () => ({ ocr: () => pending }),
            store: { get: () => "" },
            ipcRenderer: { invoke },
            normalizeTranslatedTexts,
        });
        const result = translate(() => current);
        await Promise.resolve();
        current = false;
        finish?.(ocrResult("old"));
        await expect(result).resolves.toBe("");
        expect(invoke).not.toHaveBeenCalled();
    });
    it("normalizes OCR paragraphs and forwards configured Korean to English", async () => {
        const invoke = vi
            .fn()
            .mockResolvedValue({ texts: ["translated one", "translated two"] });
        const ocr = vi
            .fn()
            .mockResolvedValue(ocrResult(" 첫 문단 ", "   ", "둘째 문단"));
        const storeValues: Record<string, string> = {
            "屏幕翻译.语言.from": "ko",
            "屏幕翻译.语言.to": "en",
        };
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 80, 40],
            getClipPhoto: () => ({ toDataURL: () => "capture:data" }),
            getLiveOcr: () => Promise.resolve({ ocr }),
            store: { get: (key: string) => storeValues[key] },
            ipcRenderer: { invoke },
            normalizeTranslatedTexts,
        });

        await expect(translate()).resolves.toBe(
            "translated one\ntranslated two",
        );
        expect(ocr).toHaveBeenCalledWith("capture:data");
        expect(invoke).toHaveBeenCalledWith("oc:translate", {
            texts: ["첫 문단", "둘째 문단"],
            from: "ko",
            to: "en",
        });
    });

    it("uses auto to Korean defaults when preferences are empty", async () => {
        const invoke = vi.fn().mockResolvedValue("기본 번역");
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 20, 20],
            getClipPhoto: () => ({ toDataURL: () => "default:data" }),
            getLiveOcr: () =>
                Promise.resolve({
                    ocr: vi.fn().mockResolvedValue(ocrResult("hello")),
                }),
            store: { get: () => "" },
            ipcRenderer: { invoke },
            normalizeTranslatedTexts,
        });

        await expect(translate()).resolves.toBe("기본 번역");
        expect(invoke).toHaveBeenCalledWith("oc:translate", {
            texts: ["hello"],
            from: "auto",
            to: "ko",
        });
    });

    it("does not invoke translation when OCR has no text", async () => {
        const invoke = vi.fn();
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 20, 20],
            getClipPhoto: () => ({ toDataURL: () => "blank:data" }),
            getLiveOcr: () =>
                Promise.resolve({
                    ocr: vi.fn().mockResolvedValue(ocrResult(" ", "\n", "\t")),
                }),
            store: { get: () => "" },
            ipcRenderer: { invoke },
            normalizeTranslatedTexts,
        });

        await expect(translate()).resolves.toBe("");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("snapshots the crop before delayed OCR initialization", async () => {
        let resolveOcr:
            | ((value: { ocr: ReturnType<typeof vi.fn> }) => void)
            | undefined;
        const initialized = new Promise<{ ocr: ReturnType<typeof vi.fn> }>(
            (resolve) => {
                resolveOcr = resolve;
            },
        );
        let currentCrop = "first:data";
        const getClipPhoto = vi.fn(() => ({
            toDataURL: () => currentCrop,
        }));
        const recognize = vi.fn().mockResolvedValue(ocrResult("hello"));
        const translate = productionTranslateCurrentSelection({
            finalRect: [0, 0, 20, 20],
            getClipPhoto,
            getLiveOcr: () => initialized,
            store: { get: () => "" },
            ipcRenderer: { invoke: vi.fn().mockResolvedValue("안녕") },
            normalizeTranslatedTexts,
        });

        const pending = translate();
        currentCrop = "changed:data";
        resolveOcr?.({ ocr: recognize });

        await expect(pending).resolves.toBe("안녕");
        expect(getClipPhoto).toHaveBeenCalledOnce();
        expect(recognize).toHaveBeenCalledWith("first:data");
    });
});

describe("selection translation invalidation", () => {
    it.each(["selecting", "moving", "longRunning"])(
        "discards a result while %s is active",
        async (flag) => {
            vi.useFakeTimers();
            let finish: ((value: string) => void) | undefined;
            const publish = vi.fn();
            const controller = new LatestLiveTranslation<string>(
                publish,
                vi.fn(),
                10,
            );
            controller.schedule(
                () =>
                    new Promise<string>((resolve) => {
                        finish = resolve;
                    }),
            );
            await vi.advanceTimersByTimeAsync(10);
            const h = productionSchedule({
                liveTranslationEnabled: true,
                selecting: false,
                moving: false,
                longRunning: false,
                [flag]: true,
                finalRect: [0, 0, 50, 50],
                liveTranslationPreview: { el: { textContent: "old" } },
                liveTranslationController: controller,
                translateCurrentSelection: async () => "new",
            });
            h.schedule();
            finish?.("old");
            await vi.runAllTimersAsync();
            expect(publish).not.toHaveBeenCalled();
        },
    );
});
