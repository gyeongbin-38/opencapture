import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorage = vi.hoisted(() => ({
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock("electron", () => ({ safeStorage }));

import { createTranslationService } from "../src/main/localTranslation";

let fixture = "";
let root = "";
let userData = "";

function writeWindowsRuntime() {
    const runtime = join(root, "assets", "runtime", "win32-x64");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "python.exe"), "fixture");
    writeFileSync(join(runtime, "translation-worker.py"), "fixture");
}

function writeModels() {
    for (const pair of ["en-ko", "ko-en"]) {
        const destination = join(userData, "translation", "models", pair);
        mkdirSync(join(destination, "model"), { recursive: true });
        writeFileSync(join(destination, "model", "model.bin"), "fixture");
        writeFileSync(
            join(destination, "model", "shared_vocabulary.txt"),
            "fixture",
        );
        writeFileSync(join(destination, "sentencepiece.model"), "fixture");
    }
}

beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "opencapture-translation-test-"));
    root = join(fixture, "root");
    userData = join(fixture, "user-data");
    mkdirSync(root, { recursive: true });
    vi.unstubAllGlobals();
    safeStorage.decryptString.mockClear();
    safeStorage.encryptString.mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(fixture, { recursive: true, force: true });
});

describe("local translation runtime support", () => {
    it("recognizes the bundled Windows x64 runtime", () => {
        writeWindowsRuntime();
        const service = createTranslationService({
            root,
            userData,
            platform: "win32",
            arch: "x64",
        });

        expect(service.status()).toMatchObject({
            runtimeReady: true,
            modelsReady: false,
            message: "Install the English/Korean translation models",
        });
        service.dispose();
    });

    it.each([
        ["darwin", "arm64"],
        ["darwin", "x64"],
        ["linux", "x64"],
        ["win32", "arm64"],
    ] as const)(
        "does not treat Windows files as a %s-%s runtime",
        (platform, arch) => {
            writeWindowsRuntime();
            const service = createTranslationService({
                root,
                userData,
                platform,
                arch,
            });

            expect(service.status()).toMatchObject({
                runtimeReady: false,
                message: "Local translation runtime is unavailable",
            });
            service.dispose();
        },
    );

    it("does not download models when the local runtime is unavailable", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const service = createTranslationService({
            root,
            userData,
            platform: "darwin",
            arch: "arm64",
        });

        await expect(service.installModels()).resolves.toMatchObject({
            runtimeReady: false,
            modelsReady: false,
            installing: false,
            message: "Local translation runtime is unavailable",
        });
        expect(fetchMock).not.toHaveBeenCalled();
        service.dispose();
    });

    it("keeps model readiness separate from runtime support", async () => {
        writeWindowsRuntime();
        writeModels();
        const service = createTranslationService({
            root,
            userData,
            platform: "darwin",
            arch: "arm64",
        });

        expect(service.status()).toMatchObject({
            runtimeReady: false,
            modelsReady: true,
            local: { installed: true, languages: ["en", "ko"] },
            message: "Local translation runtime is unavailable",
        });
        await expect(
            service.translate({ texts: ["Hello"], from: "en", to: "ko" }),
        ).rejects.toThrow("Local translation runtime is unavailable");
        service.dispose();
    });

    it("keeps Google and DeepL available without a local runtime", async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("googleapis.com")) {
                return new Response(
                    JSON.stringify({
                        data: { translations: [{ translatedText: "안녕" }] },
                    }),
                    { status: 200 },
                );
            }
            return new Response(
                JSON.stringify({ translations: [{ text: "Hello" }] }),
                { status: 200 },
            );
        });
        vi.stubGlobal("fetch", fetchMock);
        const service = createTranslationService({
            root,
            userData,
            platform: "darwin",
            arch: "arm64",
        });
        service.configure({ engine: "google", apiKey: "google-key" });
        service.configure({ engine: "deepl", apiKey: "deepl-key" });

        await expect(
            service.translate({
                texts: ["Hello"],
                from: "en",
                to: "ko",
                engine: "google",
            }),
        ).resolves.toEqual(["안녕"]);
        await expect(
            service.translate({
                texts: ["안녕"],
                from: "ko",
                to: "en",
                engine: "deepl",
            }),
        ).resolves.toEqual(["Hello"]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(service.status()).toMatchObject({
            runtimeReady: false,
            providers: {
                google: { configured: true },
                deepl: { configured: true },
            },
        });
        service.dispose();
    });
});
