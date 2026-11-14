import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { safeStorage } from "electron";
import yauzl from "yauzl";

export type TranslationEngine = "local" | "deepl" | "google";

export type TranslationRequest = {
    texts: string[];
    from: "auto" | "en" | "ko";
    to: "en" | "ko";
    engine?: TranslationEngine;
};

export type TranslationStatus = {
    runtimeReady: boolean;
    modelsReady: boolean;
    engine: TranslationEngine;
    pairs: string[];
    installing: boolean;
    message?: string;
    local: {
        installed: boolean;
        installing: boolean;
        size: number;
        languages: string[];
    };
    providers: {
        deepl: { configured: boolean };
        google: { configured: boolean };
    };
};

type ServiceOptions = {
    root: string;
    userData: string;
    platform?: NodeJS.Platform;
    arch?: string;
};
type ConfigureRequest = {
    engine: TranslationEngine;
    apiKey?: string;
    deeplFree?: boolean;
};
type StoredConfig = {
    engine: TranslationEngine;
    deeplFree: boolean;
    keys: Partial<Record<"deepl" | "google", string>>;
};

const MODEL_ASSETS = {
    "en-ko": {
        archiveRoot: "en_ko",
        url: "https://argos-net.com/v1/translate-en_ko-1_1.argosmodel",
        sha256: "e03d8e65e6d44525ec5808c3409fcf8728c76c2c76925372b6d3dc3278de17fc",
    },
    "ko-en": {
        archiveRoot: "ko_en",
        url: "https://argos-net.com/v1/translate-ko_en-1_1.argosmodel",
        sha256: "6da8f3db6ca40f42b1875570a1c06856f6e17c7ef62845d85de217ba548c1471",
    },
} as const;

const MAX_TEXTS = 64;
const MAX_TEXT_LENGTH = 10_000;
const MAX_TOTAL_LENGTH = 40_000;
const MAX_QUEUE = 16;
const TRANSLATION_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_MODEL_BYTES = 160 * 1024 * 1024;

function defaultConfig(): StoredConfig {
    return { engine: "local", deeplFree: true, keys: {} };
}

function validateRequest(request: TranslationRequest): void {
    if (!request || !Array.isArray(request.texts)) {
        throw new Error("texts must be an array");
    }
    if (request.texts.length < 1 || request.texts.length > MAX_TEXTS) {
        throw new Error(`texts must contain 1-${MAX_TEXTS} items`);
    }
    if (!request.texts.every((text) => typeof text === "string")) {
        throw new Error("texts must contain only strings");
    }
    if (
        request.texts.some((text) => text.length > MAX_TEXT_LENGTH) ||
        request.texts.reduce((sum, text) => sum + text.length, 0) >
            MAX_TOTAL_LENGTH
    ) {
        throw new Error("Translation request is too large");
    }
    if (!(["auto", "en", "ko"] as const).includes(request.from)) {
        throw new Error("Unsupported source language");
    }
    if (!(["en", "ko"] as const).includes(request.to)) {
        throw new Error("Unsupported target language");
    }
    if (
        request.engine !== undefined &&
        !(["local", "deepl", "google"] as const).includes(request.engine)
    ) {
        throw new Error("Unsupported translation engine");
    }
}

function isModelReady(path: string): boolean {
    return (
        existsSync(join(path, "model", "model.bin")) &&
        existsSync(join(path, "model", "shared_vocabulary.txt")) &&
        existsSync(join(path, "sentencepiece.model"))
    );
}

function directorySize(path: string): number {
    if (!existsSync(path)) return 0;
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    let size = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const entryPath = join(path, entry.name);
        size += entry.isDirectory()
            ? directorySize(entryPath)
            : statSync(entryPath).size;
    }
    return size;
}

async function downloadModel(
    url: string,
    destination: string,
    expectedSha256: string,
): Promise<void> {
    const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`Model download failed (${response.status})`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_MODEL_BYTES)
        throw new Error("Model download is too large");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_MODEL_BYTES)
        throw new Error("Model download is too large");
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expectedSha256)
        throw new Error("Model checksum verification failed");
    writeFileSync(destination, data, { flag: "wx" });
}

function extractModel(
    archive: string,
    destination: string,
    expectedRoot: string,
): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        yauzl.open(archive, { lazyEntries: true }, (openError, zip) => {
            if (openError || !zip) {
                rejectPromise(
                    openError ?? new Error("Unable to open model archive"),
                );
                return;
            }
            let settled = false;
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                zip.close();
                rejectPromise(error);
            };
            zip.on("error", fail);
            zip.on("entry", (entry) => {
                const normalized = entry.fileName.replaceAll("\\", "/");
                const parts = normalized.split("/").filter(Boolean);
                if (
                    parts[0] !== expectedRoot ||
                    parts.some((part: string) => part === "..")
                ) {
                    fail(new Error("Unsafe model archive path"));
                    return;
                }
                const target = resolve(destination, ...parts.slice(1));
                const rel = relative(resolve(destination), target);
                if (rel.startsWith(`..${sep}`) || rel === "..") {
                    fail(new Error("Unsafe model archive path"));
                    return;
                }
                if (normalized.endsWith("/")) {
                    mkdirSync(target, { recursive: true });
                    zip.readEntry();
                    return;
                }
                mkdirSync(dirname(target), { recursive: true });
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        fail(
                            streamError ??
                                new Error("Unable to read model archive"),
                        );
                        return;
                    }
                    const output = createWriteStream(target, { flags: "wx" });
                    stream.on("error", fail);
                    output.on("error", fail);
                    output.on("finish", () => zip.readEntry());
                    stream.pipe(output);
                });
            });
            zip.on("end", () => {
                if (!settled) {
                    settled = true;
                    resolvePromise();
                }
            });
            zip.readEntry();
        });
    });
}

class LocalWorker {
    private idleTimer: ReturnType<typeof setTimeout> | undefined;
    private lastError = "";
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private output = "";
    private pending = new Map<
        number,
        {
            resolve: (translations: string[]) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    constructor(
        private readonly executable: string,
        private readonly workerPath: string,
        private readonly modelsDir: string,
    ) {}

    translate(request: TranslationRequest): Promise<string[]> {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.pending.size >= MAX_QUEUE) {
            return Promise.reject(new Error("Translation queue is full"));
        }
        this.ensureStarted();
        const child = this.child;
        if (!child)
            return Promise.reject(
                new Error("Translation worker failed to start"),
            );
        const id = this.nextId++;
        return new Promise((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectPromise(new Error("Local translation timed out"));
                this.stop();
            }, TRANSLATION_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: resolvePromise,
                reject: rejectPromise,
                timer,
            });
            child.stdin.write(
                `${JSON.stringify({
                    id,
                    texts: request.texts,
                    from: request.from,
                    to: request.to,
                    modelsDir: this.modelsDir,
                })}\n`,
            );
        });
    }

    stop(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.output = "";
        const child = this.child;
        this.child = null;
        if (child && !child.killed) child.kill();
        this.rejectAll(new Error("Local translation worker stopped"));
    }

    private ensureStarted(): void {
        if (this.child) return;
        if (!existsSync(this.executable) || !existsSync(this.workerPath)) {
            throw new Error("Local translation runtime is unavailable");
        }
        this.lastError = "";
        const child = spawn(this.executable, [this.workerPath], {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PYTHONUTF8: "1",
                PYTHONNOUSERSITE: "1",
            },
        });
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (this.child === child) this.consume(chunk);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            if (this.child !== child) return;
            this.lastError = (this.lastError + chunk).slice(-2048);
        });
        child.on("error", (error) => {
            if (this.child !== child) return;
            this.child = null;
            this.rejectAll(error);
        });
        child.on("exit", () => {
            if (this.child !== child) return;
            this.child = null;
            const diagnostic = this.lastError
                .split("")
                .filter(
                    (character) =>
                        character.charCodeAt(0) >= 32 ||
                        character === "\n" ||
                        character === "\t",
                )
                .join("")
                .slice(-1024);
            this.rejectAll(
                new Error(
                    `Local translation worker exited${diagnostic ? `: ${diagnostic}` : ""}`,
                ),
            );
        });
    }

    private consume(chunk: string): void {
        this.output += chunk;
        while (this.output.includes("\n")) {
            const index = this.output.indexOf("\n");
            const line = this.output.slice(0, index);
            this.output = this.output.slice(index + 1);
            if (!line) continue;
            let response: {
                id?: number;
                translations?: string[];
                error?: string;
            };
            try {
                response = JSON.parse(line);
            } catch {
                this.stop();
                return;
            }
            if (typeof response.id !== "number") continue;
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (this.pending.size === 0) {
                this.idleTimer = setTimeout(() => this.stop(), 45000);
                this.idleTimer.unref();
            }
            if (response.error) pending.reject(new Error(response.error));
            else if (Array.isArray(response.translations))
                pending.resolve(response.translations);
            else
                pending.reject(
                    new Error("Invalid response from translation worker"),
                );
        }
    }

    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

export function createTranslationService({
    root,
    userData,
    platform = process.platform,
    arch = process.arch,
}: ServiceOptions) {
    const runtimeDir = join(root, "assets", "runtime", "win32-x64");
    const pythonPath = join(runtimeDir, "python.exe");
    const workerPath = join(runtimeDir, "translation-worker.py");
    const runtimeSupported = platform === "win32" && arch === "x64";
    const serviceDir = join(userData, "translation");
    const modelsDir = join(serviceDir, "models");
    const configPath = join(serviceDir, "config.json");
    mkdirSync(serviceDir, { recursive: true });

    const config = defaultConfig();
    try {
        const parsed = JSON.parse(
            readFileSync(configPath, "utf8"),
        ) as Partial<StoredConfig>;
        if (
            (["local", "deepl", "google"] as const).includes(
                parsed.engine as TranslationEngine,
            )
        ) {
            config.engine = parsed.engine as TranslationEngine;
        }
        config.deeplFree = parsed.deeplFree !== false;
        if (parsed.keys && typeof parsed.keys === "object")
            config.keys = parsed.keys;
    } catch {}

    let installing: Promise<TranslationStatus> | null = null;
    const worker = new LocalWorker(pythonPath, workerPath, modelsDir);

    const encryptedKey = (engine: "deepl" | "google"): string | undefined => {
        const encoded = config.keys[engine];
        if (!encoded) return undefined;
        try {
            return safeStorage.decryptString(Buffer.from(encoded, "base64"));
        } catch {
            throw new Error(`${engine} API key could not be decrypted`);
        }
    };

    const saveConfig = (): void => {
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    };

    const status = (): TranslationStatus => {
        const pairs = Object.keys(MODEL_ASSETS).filter((pair) =>
            isModelReady(join(modelsDir, pair)),
        );
        const modelsReady = pairs.length === Object.keys(MODEL_ASSETS).length;
        const runtimeReady =
            runtimeSupported &&
            existsSync(pythonPath) &&
            existsSync(workerPath);
        const size = directorySize(modelsDir);
        return {
            runtimeReady,
            modelsReady,
            engine: config.engine,
            pairs,
            installing: Boolean(installing),
            message: !runtimeReady
                ? "Local translation runtime is unavailable"
                : !modelsReady
                  ? "Install the English/Korean translation models"
                  : undefined,
            local: {
                installed: modelsReady,
                installing: Boolean(installing),
                size,
                languages: modelsReady ? ["en", "ko"] : [],
            },
            providers: {
                deepl: { configured: Boolean(config.keys.deepl) },
                google: { configured: Boolean(config.keys.google) },
            },
        };
    };

    const installModels = async (): Promise<TranslationStatus> => {
        if (!status().runtimeReady) return status();
        if (installing) return installing;
        installing = (async () => {
            mkdirSync(modelsDir, { recursive: true });
            for (const [pair, asset] of Object.entries(MODEL_ASSETS)) {
                const destination = join(modelsDir, pair);
                if (isModelReady(destination)) continue;
                const archive = join(serviceDir, `${pair}.download`);
                const staging = join(modelsDir, `.${pair}-${Date.now()}`);
                rmSync(archive, { force: true });
                rmSync(staging, { recursive: true, force: true });
                try {
                    await downloadModel(asset.url, archive, asset.sha256);
                    mkdirSync(staging, { recursive: true });
                    await extractModel(archive, staging, asset.archiveRoot);
                    if (!isModelReady(staging))
                        throw new Error("Model package is incomplete");
                    rmSync(destination, { recursive: true, force: true });
                    renameSync(staging, destination);
                } finally {
                    rmSync(archive, { force: true });
                    rmSync(staging, { recursive: true, force: true });
                }
            }
            worker.stop();
            return status();
        })();
        try {
            await installing;
        } finally {
            installing = null;
        }
        return status();
    };

    const translateOnline = async (
        request: TranslationRequest,
        engine: "deepl" | "google",
    ): Promise<string[]> => {
        const key = encryptedKey(engine);
        if (!key) throw new Error(`${engine} API key is not configured`);
        if (engine === "deepl") {
            const endpoint = config.deeplFree
                ? "https://api-free.deepl.com/v2/translate"
                : "https://api.deepl.com/v2/translate";
            const response = await fetch(endpoint, {
                method: "POST",
                signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
                headers: {
                    Authorization: `DeepL-Auth-Key ${key}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: request.texts,
                    ...(request.from === "auto"
                        ? {}
                        : { source_lang: request.from.toUpperCase() }),
                    target_lang: request.to.toUpperCase(),
                }),
            });
            if (!response.ok)
                throw new Error(`DeepL request failed (${response.status})`);
            const body = (await response.json()) as {
                translations?: { text?: string }[];
            };
            const results = body.translations?.map((item) => item.text ?? "");
            if (!results || results.length !== request.texts.length) {
                throw new Error("DeepL returned an invalid response");
            }
            return results;
        }
        const response = await fetch(
            "https://translation.googleapis.com/language/translate/v2",
            {
                method: "POST",
                signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
                headers: {
                    "Content-Type": "application/json",
                    "X-goog-api-key": key,
                },
                body: JSON.stringify({
                    q: request.texts,
                    ...(request.from === "auto"
                        ? {}
                        : { source: request.from }),
                    target: request.to,
                    format: "text",
                }),
            },
        );
        if (!response.ok)
            throw new Error(`Google request failed (${response.status})`);
        const body = (await response.json()) as {
            data?: { translations?: { translatedText?: string }[] };
        };
        const results = body.data?.translations?.map(
            (item) => item.translatedText ?? "",
        );
        if (!results || results.length !== request.texts.length) {
            throw new Error("Google returned an invalid response");
        }
        return results;
    };

    return {
        status,
        installModels,
        async translate(request: TranslationRequest): Promise<string[]> {
            validateRequest(request);
            const engine = request.engine ?? "local";
            if (engine === "local") {
                const localStatus = status();
                if (!localStatus.runtimeReady)
                    throw new Error("Local translation runtime is unavailable");
                if (!localStatus.modelsReady)
                    throw new Error("Translation models are not installed");
                return worker.translate(request);
            }
            return translateOnline(request, engine);
        },
        configure(request: ConfigureRequest): TranslationStatus {
            if (
                !(["local", "deepl", "google"] as const).includes(
                    request.engine,
                )
            ) {
                throw new Error("Unsupported translation engine");
            }
            if (request.apiKey !== undefined && request.engine !== "local") {
                if (request.apiKey.length > 512)
                    throw new Error("API key is too long");
                if (request.apiKey) {
                    if (!safeStorage.isEncryptionAvailable()) {
                        throw new Error(
                            "Secure credential storage is unavailable",
                        );
                    }
                    config.keys[request.engine] = safeStorage
                        .encryptString(request.apiKey)
                        .toString("base64");
                } else {
                    delete config.keys[request.engine];
                }
            }
            if (request.apiKey === undefined) config.engine = request.engine;
            if (typeof request.deeplFree === "boolean")
                config.deeplFree = request.deeplFree;
            saveConfig();
            return status();
        },
        dispose(): void {
            worker.stop();
        },
    };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
