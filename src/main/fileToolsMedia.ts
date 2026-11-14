import { spawn } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { FileToolOptions, FileToolRecipe } from "../../lib/fileTools";
import type {
    FileToolEngine,
    ToolContext,
    ToolEngineResult,
    ToolInput,
} from "./fileToolsTypes";

const MAX_INPUT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INPUTS = 32;
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const STDERR_LIMIT = 64 * 1024;
const PROTOCOLS = "file,pipe,crypto,data";
const PROTOCOL_BLACKLIST = "http,https,tcp,tls,udp,rtp,ftp,sftp,concat,subfile";
const USER_FORMATS = [
    "aac",
    "aiff",
    "asf",
    "avi",
    "flac",
    "gif",
    "matroska",
    "webm",
    "mov",
    "mp4",
    "m4a",
    "3gp",
    "3g2",
    "mj2",
    "mp3",
    "ogg",
    "opus",
    "wav",
    "avif",
    "apng",
    "image2",
    "image2pipe",
    "bmp_pipe",
    "jpeg_pipe",
    "png_pipe",
    "tiff_pipe",
    "webp_pipe",
].join(",");

const AUDIO_FORMATS = [
    "mp3",
    "m4a",
    "wav",
    "flac",
    "ogg",
    "opus",
    "aiff",
    "wma",
] as const;
const VIDEO_FORMATS = [
    "mp4",
    "mov",
    "mkv",
    "webm",
    "avi",
    "wmv",
    "gif",
] as const;
const IMAGE_FORMATS = ["jpg", "png", "webp", "tiff", "avif", "bmp"] as const;
const PLAYLIST_EXTENSIONS = new Set(["m3u", "m3u8", "pls"]);

type MediaKind = "audio" | "video" | "image";
const INPUT_EXTENSIONS: Record<MediaKind, Set<string>> = {
    audio: new Set([...AUDIO_FORMATS, "aac", "aif"]),
    video: new Set([...VIDEO_FORMATS, "apng"]),
    image: new Set([...IMAGE_FORMATS, "heic", "heif"]),
};
type Probe = {
    available: boolean;
    reason?: string;
    encoders: string;
    muxers: string;
    decoders: string;
};
type RunResult = { stderr: string };
type MediaMetadata = { duration: number; audio: boolean };

const normalizeExtension = (value: string) => {
    const extension = value.toLowerCase().replace(/^\./, "");
    if (extension === "jpeg") return "jpg";
    if (extension === "tif") return "tiff";
    return extension;
};

const mediaKind = (input: ToolInput): MediaKind | undefined =>
    input.kind === "audio" || input.kind === "video" || input.kind === "image"
        ? input.kind
        : undefined;

const abortError = (message = "Media conversion was cancelled.") => {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
};

const boundedNumber = (
    value: unknown,
    name: string,
    min: number,
    max: number,
    integer = false,
) => {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
    )
        throw new Error(`${name} is outside the supported range.`);
    return value;
};

const sanitizeStem = (path: string) =>
    basename(path, extname(path))
        .replace(/[\\/:*?"<>|\p{C}]/gu, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 96) || "output";

const ffconcatPath = (path: string) =>
    resolve(path).replaceAll("\\", "/").replaceAll("'", "'\\''");

const formatAvailable = (probe: Probe, kind: MediaKind, format: string) => {
    const encoder: Record<string, string> = {
        mp3: "libmp3lame",
        m4a: "aac",
        wav: "pcm_s16le",
        flac: "flac",
        ogg: "libvorbis",
        opus: "libopus",
        aiff: "pcm_s16be",
        wma: "wmav2",
        mp4: "libx264",
        mov: "libx264",
        mkv: "libx264",
        webm: "libvpx-vp9",
        avi: "mpeg4",
        wmv: "wmv2",
        gif: "gif",
        jpg: "mjpeg",
        png: "png",
        webp: "libwebp",
        tiff: "tiff",
        avif: "libaom-av1",
        bmp: "bmp",
    };
    const muxer: Record<string, string> = {
        mp3: "mp3",
        m4a: "ipod",
        wav: "wav",
        flac: "flac",
        ogg: "ogg",
        opus: "opus",
        aiff: "aiff",
        wma: "asf",
        mp4: "mp4",
        mov: "mov",
        mkv: "matroska",
        webm: "webm",
        avi: "avi",
        wmv: "asf",
        gif: "gif",
        jpg: "image2",
        png: "image2",
        webp: "image2",
        tiff: "image2",
        avif: "avif",
        bmp: "image2",
    };
    if (!probe.available) return false;
    if (!probe.encoders.includes(encoder[format] ?? "\0")) return false;
    if (!probe.muxers.includes(muxer[format] ?? "\0")) return false;
    if (kind === "video" && format !== "gif") {
        const audioEncoder =
            format === "webm"
                ? "libopus"
                : format === "wmv"
                  ? "wmav2"
                  : format === "avi"
                    ? "libmp3lame"
                    : "aac";
        if (!probe.encoders.includes(audioEncoder)) return false;
    }
    return true;
};

const codecArgs = (kind: MediaKind, format: string, quality = 0.75) => {
    const q = Math.round(boundedNumber(quality, "quality", 0, 1) * 100);
    const crf = Math.round(51 - (q / 100) * 33);
    if (kind === "audio") {
        const values: Record<string, string[]> = {
            mp3: [
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                String(Math.round((100 - q) / 12)),
            ],
            m4a: [
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                `${Math.round(64 + q * 2.56)}k`,
                "-f",
                "ipod",
            ],
            wav: ["-vn", "-c:a", "pcm_s16le"],
            flac: [
                "-vn",
                "-c:a",
                "flac",
                "-compression_level",
                String(Math.round(q / 12.5)),
            ],
            ogg: [
                "-vn",
                "-c:a",
                "libvorbis",
                "-q:a",
                String(Math.max(0, Math.round(q / 10))),
            ],
            opus: [
                "-vn",
                "-c:a",
                "libopus",
                "-b:a",
                `${Math.round(48 + q * 2.08)}k`,
            ],
            aiff: ["-vn", "-c:a", "pcm_s16be"],
            wma: [
                "-vn",
                "-c:a",
                "wmav2",
                "-b:a",
                `${Math.round(64 + q * 2.56)}k`,
                "-f",
                "asf",
            ],
        };
        return values[format];
    }
    if (kind === "image") {
        const values: Record<string, string[]> = {
            jpg: [
                "-frames:v",
                "1",
                "-c:v",
                "mjpeg",
                "-q:v",
                String(Math.max(2, Math.round((100 - q) / 3) + 2)),
            ],
            png: [
                "-frames:v",
                "1",
                "-c:v",
                "png",
                "-compression_level",
                String(Math.round((100 - q) / 11)),
            ],
            webp: ["-frames:v", "1", "-c:v", "libwebp", "-quality", String(q)],
            tiff: ["-frames:v", "1", "-c:v", "tiff"],
            avif: [
                "-frames:v",
                "1",
                "-c:v",
                "libaom-av1",
                "-still-picture",
                "1",
                "-crf",
                String(crf),
                "-f",
                "avif",
            ],
            bmp: ["-frames:v", "1", "-c:v", "bmp"],
        };
        return values[format];
    }
    const values: Record<string, string[]> = {
        mp4: [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            String(crf),
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ],
        mov: [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            String(crf),
            "-c:a",
            "aac",
        ],
        mkv: [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            String(crf),
            "-c:a",
            "aac",
        ],
        webm: [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            String(crf),
            "-b:v",
            "0",
            "-c:a",
            "libopus",
        ],
        avi: [
            "-c:v",
            "mpeg4",
            "-q:v",
            String(Math.max(2, Math.round((100 - q) / 4) + 2)),
            "-c:a",
            "libmp3lame",
        ],
        wmv: [
            "-c:v",
            "wmv2",
            "-q:v",
            String(Math.max(2, Math.round((100 - q) / 4) + 2)),
            "-c:a",
            "wmav2",
            "-f",
            "asf",
        ],
        gif: ["-an", "-c:v", "gif"],
    };
    return values[format];
};

const optionsFor = (recipe: string) => {
    const map: Record<string, Set<string>> = {
        "media-convert": new Set(["format", "quality"]),
        "media-compress": new Set(["format", "quality"]),
        "media-trim": new Set(["format", "start", "end"]),
        "media-resize": new Set(["format", "width", "height", "quality"]),
        "media-crop": new Set([
            "format",
            "x",
            "y",
            "width",
            "height",
            "quality",
        ]),
        "media-rotate": new Set(["format", "angle", "quality"]),
        "media-speed": new Set(["format", "speed", "quality"]),
        "media-mute": new Set(["format", "quality"]),
        "media-extract-audio": new Set(["format", "quality"]),
        "media-normalize": new Set(["format", "quality", "volume"]),
        "media-merge": new Set(["format", "width", "height", "quality"]),
        "media-split": new Set(["format", "start"]),
        "media-image-convert": new Set(["format", "quality"]),
        "media-image-resize": new Set(["format", "width", "height", "quality"]),
        "media-image-compress": new Set(["format", "quality"]),
        "media-image-rotate": new Set(["format", "angle", "quality"]),
        "media-image-crop": new Set([
            "format",
            "x",
            "y",
            "width",
            "height",
            "quality",
        ]),
        "media-image-flip": new Set(["format", "flip", "quality"]),
        "media-image-remove-metadata": new Set(["format", "quality"]),
        compress: new Set(["format", "quality"]),
        removeMetadata: new Set(["format", "quality"]),
        cropImage: new Set(["format", "x", "y", "width", "height", "quality"]),
        redactImage: new Set([
            "format",
            "x",
            "y",
            "width",
            "height",
            "quality",
        ]),
        normalizeAudio: new Set(["format", "quality", "volume"]),
        muteVideo: new Set(["format", "quality"]),
        trimVideo: new Set(["format", "start", "end", "quality"]),
        cropVideo: new Set(["format", "x", "y", "width", "height", "quality"]),
        changeVideoSpeed: new Set(["format", "speed", "quality"]),
        joinVideos: new Set(["format", "width", "height", "quality"]),
        videoSnapshots: new Set(["start"]),
        splitVideo: new Set(["format", "start"]),
        audioToVideo: new Set(["quality"]),
        trimAudio: new Set(["format", "start", "end", "quality"]),
        audioChannels: new Set(["format", "channels", "quality"]),
        redactVideo: new Set([
            "format",
            "x",
            "y",
            "width",
            "height",
            "start",
            "end",
            "quality",
        ]),
        redactAudio: new Set(["format", "start", "end", "quality"]),
    };
    return map[recipe];
};

const validateOptions = (recipe: string, options: FileToolOptions) => {
    const allowed = optionsFor(recipe);
    if (!allowed) throw new Error(`Unknown media recipe: ${recipe}`);
    for (const key of Object.keys(options))
        if (!allowed.has(key))
            throw new Error(`Unsupported option for ${recipe}: ${key}`);
    if (options.quality !== undefined)
        boundedNumber(options.quality, "quality", 0, 1);
    for (const key of ["width", "height"] as const)
        if (options[key] !== undefined)
            boundedNumber(options[key], key, 1, 16_384, true);
    for (const key of ["x", "y"] as const)
        if (options[key] !== undefined)
            boundedNumber(options[key], key, 0, 16_384, true);
    for (const key of ["start", "end"] as const)
        if (options[key] !== undefined)
            boundedNumber(options[key], key, 0, 24 * 60 * 60);
    if (
        options.end !== undefined &&
        options.start !== undefined &&
        options.end <= options.start
    )
        throw new Error("end must be greater than start.");
    if (options.speed !== undefined)
        boundedNumber(options.speed, "speed", 0.25, 4);
    if (options.angle !== undefined && ![90, 180, 270].includes(options.angle))
        throw new Error("angle must be 90, 180, or 270 degrees.");
    if (options.volume !== undefined)
        boundedNumber(options.volume, "volume", 0.1, 4);
    if (
        options.flip !== undefined &&
        !["horizontal", "vertical"].includes(options.flip)
    )
        throw new Error("flip must be horizontal or vertical.");
    if (options.channels !== undefined && ![1, 2].includes(options.channels))
        throw new Error("channels must be 1 or 2.");
};

const rejectPlaylistSignature = (path: string) => {
    const descriptor = openSync(path, "r");
    const header = Buffer.alloc(512);
    let length = 0;
    try {
        length = readSync(descriptor, header, 0, header.length, 0);
    } finally {
        closeSync(descriptor);
    }
    const text = header
        .subarray(0, length)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart()
        .toLowerCase();
    if (
        text.startsWith("#extm3u") ||
        text.startsWith("ffconcat version") ||
        text.startsWith("[playlist]")
    )
        throw new Error(
            "Playlist and external-reference signatures are not supported.",
        );
};

const restrictedInputOptions = (formats = USER_FORMATS) => [
    "-protocol_whitelist",
    PROTOCOLS,
    "-protocol_blacklist",
    PROTOCOL_BLACKLIST,
    "-format_whitelist",
    formats,
];

const restrictedInputArgs = (path: string, formats = USER_FORMATS) => [
    ...restrictedInputOptions(formats),
    "-i",
    path,
];

const validateInput = (input: ToolInput) => {
    if (
        !isAbsolute(input.path) ||
        input.path.includes("\0") ||
        /:\/\//.test(input.path)
    )
        throw new Error("Media input must be a local absolute path.");
    const extension = normalizeExtension(
        input.extension || extname(input.path),
    );
    if (PLAYLIST_EXTENSIONS.has(extension))
        throw new Error(
            "Playlist and external protocol inputs are not supported.",
        );
    const kind = mediaKind(input);
    if (!kind || !INPUT_EXTENSIONS[kind].has(extension))
        throw new Error("Input extension does not match its media kind.");
    const stats = statSync(input.path);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_INPUT_BYTES)
        throw new Error("Media input size is outside the supported range.");
    if (input.size > 0 && stats.size !== input.size)
        throw new Error("Media input changed after selection.");
    rejectPlaylistSignature(input.path);
};

const recipe = (
    id: string,
    label: string,
    options: FileToolRecipe["options"],
    formats: string[] | undefined,
    available: boolean,
    reason?: string,
    multiple = false,
): FileToolRecipe => ({
    id,
    label,
    group: id.includes("convert") ? "convert" : "tools",
    ...(formats?.length ? { formats } : {}),
    ...(options?.length ? { options } : {}),
    ...(multiple ? { multiple: true } : {}),
    ...(multiple ? { minSources: 2 } : {}),
    available,
    ...(!available && reason ? { reason } : {}),
});

export function createMediaTools({
    ffmpegPath,
}: {
    ffmpegPath: string;
}): FileToolEngine {
    let probePromise: Promise<Probe> | undefined;
    const heicProbe = new Map<string, Promise<boolean>>();
    const metadataProbe = new Map<string, Promise<MediaMetadata>>();
    let runQueue: Promise<void> = Promise.resolve();

    const capture = (args: string[], timeoutMs = PROBE_TIMEOUT_MS) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (settle) => {
                const child = spawn(ffmpegPath, args, {
                    windowsHide: true,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                const timer = setTimeout(
                    () => child.kill("SIGKILL"),
                    timeoutMs,
                );
                child.stdout.on("data", (chunk) => {
                    stdout = (stdout + chunk).slice(-1024 * 1024);
                });
                child.stderr.on("data", (chunk) => {
                    stderr = (stderr + chunk).slice(-1024 * 1024);
                });
                child.once("error", (error) => {
                    clearTimeout(timer);
                    settle({
                        code: null,
                        stdout,
                        stderr: `${stderr}\n${error.message}`,
                    });
                });
                child.once("close", (code) => {
                    clearTimeout(timer);
                    settle({ code, stdout, stderr });
                });
            },
        );

    const probe = () => {
        probePromise ??= (async (): Promise<Probe> => {
            try {
                if (
                    !isAbsolute(ffmpegPath) ||
                    !existsSync(ffmpegPath) ||
                    !statSync(ffmpegPath).isFile()
                )
                    return {
                        available: false,
                        reason: "FFmpeg is not installed for this platform.",
                        encoders: "",
                        muxers: "",
                        decoders: "",
                    };
                const encoders = await capture(["-hide_banner", "-encoders"]);
                const muxers = await capture(["-hide_banner", "-muxers"]);
                const decoders = await capture(["-hide_banner", "-decoders"]);
                if (
                    encoders.code !== 0 ||
                    muxers.code !== 0 ||
                    decoders.code !== 0
                )
                    return {
                        available: false,
                        reason: "FFmpeg capability probing failed.",
                        encoders: "",
                        muxers: "",
                        decoders: "",
                    };
                return {
                    available: true,
                    encoders: `${encoders.stdout}\n${encoders.stderr}`,
                    muxers: `${muxers.stdout}\n${muxers.stderr}`,
                    decoders: `${decoders.stdout}\n${decoders.stderr}`,
                };
            } catch (error) {
                return {
                    available: false,
                    reason:
                        error instanceof Error ? error.message : String(error),
                    encoders: "",
                    muxers: "",
                    decoders: "",
                };
            }
        })();
        return probePromise;
    };

    const canDecodeHeic = (input: ToolInput) => {
        const key = `${resolve(input.path)}\0${input.size}`;
        let value = heicProbe.get(key);
        if (!value) {
            value = capture([
                "-v",
                "error",
                "-nostdin",
                ...restrictedInputArgs(input.path),
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ]).then((result) => result.code === 0);
            heicProbe.set(key, value);
        }
        return value;
    };

    const probeMedia = (input: ToolInput) => {
        const key = `${resolve(input.path)}\0${input.size}`;
        let value = metadataProbe.get(key);
        if (!value) {
            value = capture([
                "-hide_banner",
                "-nostdin",
                ...restrictedInputArgs(input.path),
            ]).then((result) => {
                const match =
                    /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(
                        result.stderr,
                    );
                if (!match)
                    throw new Error(
                        `Media duration is unavailable for ${input.name}.`,
                    );
                const duration =
                    Number(match[1]) * 3600 +
                    Number(match[2]) * 60 +
                    Number(match[3]);
                if (
                    !Number.isFinite(duration) ||
                    duration <= 0 ||
                    duration > 86400
                )
                    throw new Error(
                        `Media duration is outside the supported range for ${input.name}.`,
                    );
                return {
                    duration,
                    audio: /Stream #.*Audio:/i.test(result.stderr),
                };
            });
            metadataProbe.set(key, value);
        }
        return value;
    };

    const hasAudio = (input: ToolInput) =>
        probeMedia(input).then((metadata) => metadata.audio);

    const recipes = async (inputs: ToolInput[]) => {
        if (!inputs.length) return [];
        const kind = mediaKind(inputs[0]);
        if (!kind || inputs.some((input) => mediaKind(input) !== kind))
            return [];
        if (
            inputs.some(
                (input) =>
                    !INPUT_EXTENSIONS[kind].has(
                        normalizeExtension(
                            input.extension || extname(input.path),
                        ),
                    ),
            )
        )
            return [];
        const capability = await probe();
        let available = capability.available;
        let reason = capability.reason;
        if (available && kind === "image") {
            const decoder: Record<string, string> = {
                jpg: "mjpeg",
                png: "png",
                webp: "webp",
                tiff: "tiff",
                avif: "av1",
                bmp: "bmp",
            };
            const unsupported = inputs.find((input) => {
                const extension = normalizeExtension(input.extension);
                const name = decoder[extension];
                return name && !capability.decoders.includes(name);
            });
            if (unsupported) {
                available = false;
                reason = `This FFmpeg build cannot decode ${unsupported.extension.toUpperCase()} images.`;
            }
        }
        if (
            available &&
            kind === "image" &&
            inputs.some((input) =>
                ["heic", "heif"].includes(normalizeExtension(input.extension)),
            )
        ) {
            const results = await Promise.all(
                inputs
                    .filter((input) =>
                        ["heic", "heif"].includes(
                            normalizeExtension(input.extension),
                        ),
                    )
                    .map(canDecodeHeic),
            );
            if (results.some((result) => !result)) {
                available = false;
                reason =
                    "This FFmpeg build cannot decode the selected HEIC/HEIF input.";
            }
        }
        const formats = (
            kind === "audio"
                ? AUDIO_FORMATS
                : kind === "video"
                  ? VIDEO_FORMATS
                  : IMAGE_FORMATS
        ).filter((format) => formatAvailable(capability, kind, format));
        if (!formats.length && available) {
            available = false;
            reason = `FFmpeg has no supported ${kind} output encoder.`;
        }
        if (kind === "image")
            return [
                recipe(
                    "media-image-convert",
                    "Convert image",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-resize",
                    "Resize image",
                    ["width", "height", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-compress",
                    "Compress image",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-rotate",
                    "Rotate image",
                    ["angle", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-crop",
                    "Crop image",
                    ["x", "y", "width", "height", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-flip",
                    "Flip image",
                    ["flip", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-image-remove-metadata",
                    "Remove image metadata",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "compress",
                    "Compression",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "removeMetadata",
                    "Remove metadata",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "cropImage",
                    "Crop image",
                    ["x", "y", "width", "height", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "redactImage",
                    "Redact image",
                    ["x", "y", "width", "height", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
            ];
        if (kind === "audio")
            return [
                recipe(
                    "media-convert",
                    "Convert audio",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-compress",
                    "Compress audio",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-trim",
                    "Trim audio",
                    ["start", "end"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-normalize",
                    "Normalize audio",
                    ["volume", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "media-merge",
                    "Merge audio",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                    true,
                ),
                recipe(
                    "media-split",
                    "Split audio into two parts",
                    ["start"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "compress",
                    "Compression",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "removeMetadata",
                    "Remove metadata",
                    ["quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "normalizeAudio",
                    "Normalize audio",
                    ["volume", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "trimAudio",
                    "Trim audio",
                    ["start", "end", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "audioChannels",
                    "Change audio channels",
                    ["channels", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
                recipe(
                    "audioToVideo",
                    "Create video from audio",
                    ["quality"],
                    ["mp4"],
                    available && formatAvailable(capability, "video", "mp4"),
                    reason ?? "FFmpeg cannot encode MP4 video.",
                ),
                recipe(
                    "redactAudio",
                    "Silence audio range",
                    ["start", "end", "quality"],
                    [...formats],
                    available,
                    reason,
                ),
            ];
        return [
            recipe(
                "media-convert",
                "Convert video",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-compress",
                "Compress video",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-trim",
                "Trim video",
                ["start", "end"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-resize",
                "Resize video",
                ["width", "height", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-crop",
                "Crop video",
                ["x", "y", "width", "height", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-rotate",
                "Rotate video",
                ["angle", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-speed",
                "Change video speed",
                ["speed", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-mute",
                "Mute video",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "media-extract-audio",
                "Extract audio",
                ["quality"],
                [
                    ...AUDIO_FORMATS.filter((format) =>
                        formatAvailable(capability, "audio", format),
                    ),
                ],
                available,
                reason,
            ),
            recipe(
                "media-merge",
                "Merge videos",
                ["width", "height", "quality"],
                formats.filter((format) => format !== "gif"),
                available,
                reason,
                true,
            ),
            recipe(
                "media-split",
                "Split video into two parts",
                ["start"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "compress",
                "Compression",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "removeMetadata",
                "Remove metadata",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "muteVideo",
                "Mute video",
                ["quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "trimVideo",
                "Trim video",
                ["start", "end", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "cropVideo",
                "Crop video",
                ["x", "y", "width", "height", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "changeVideoSpeed",
                "Change video speed",
                ["speed", "quality"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "joinVideos",
                "Join videos",
                ["width", "height", "quality"],
                formats.filter((format) => format !== "gif"),
                available,
                reason,
                true,
            ),
            recipe(
                "videoSnapshots",
                "Export video snapshot",
                ["start"],
                ["png"],
                available && formatAvailable(capability, "image", "png"),
                reason ?? "FFmpeg cannot encode PNG snapshots.",
            ),
            recipe(
                "splitVideo",
                "Split video into two parts",
                ["start"],
                [...formats],
                available,
                reason,
            ),
            recipe(
                "redactVideo",
                "Redact video area",
                ["x", "y", "width", "height", "start", "end", "quality"],
                [...formats],
                available,
                reason,
            ),
        ];
    };

    const outputPath = (
        context: ToolContext,
        input: ToolInput,
        suffix: string,
        extension: string,
    ) => {
        mkdirSync(context.outputDir, { recursive: true });
        const root = resolve(context.outputDir);
        const stem = sanitizeStem(input.path);
        for (let index = 0; index < 10_000; index++) {
            const name = `${stem}-${suffix}${index ? `-${index}` : ""}.${extension}`;
            const target = resolve(join(root, name));
            if (
                !target.startsWith(`${root}\\`) &&
                !target.startsWith(`${root}/`)
            )
                throw new Error("Output escaped the staging directory.");
            if (!existsSync(target)) return target;
        }
        throw new Error("Unable to allocate an output filename.");
    };

    const runProcess = (
        context: ToolContext,
        args: string[],
        outputs: string[],
        expectedDuration?: number,
    ) =>
        new Promise<RunResult>((resolvePromise, rejectPromise) => {
            if (context.signal.aborted) return rejectPromise(abortError());
            let stderr = "";
            let stdout = "";
            let settled = false;
            let timedOut = false;
            let terminationError: Error | undefined;
            let forceFinishTimer: ReturnType<typeof setTimeout> | undefined;
            const child = spawn(
                ffmpegPath,
                [
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-progress",
                    "pipe:1",
                    "-nostats",
                    ...args,
                ],
                {
                    windowsHide: true,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (forceFinishTimer) clearTimeout(forceFinishTimer);
                clearInterval(sizeTimer);
                context.signal.removeEventListener("abort", cancel);
                if (error) {
                    for (const path of outputs)
                        try {
                            rmSync(path, { force: true });
                        } catch {}
                    rejectPromise(error);
                } else resolvePromise({ stderr });
            };
            const terminate = (error: Error) => {
                terminationError ??= error;
                if (!child.kill("SIGKILL")) finish(terminationError);
                else if (!forceFinishTimer)
                    forceFinishTimer = setTimeout(
                        () => finish(terminationError),
                        2000,
                    );
            };
            const cancel = () => terminate(abortError());
            const timer = setTimeout(() => {
                timedOut = true;
                terminate(new Error("Media conversion timed out."));
            }, PROCESS_TIMEOUT_MS);
            const sizeTimer = setInterval(() => {
                try {
                    if (
                        outputs.some(
                            (path) =>
                                existsSync(path) &&
                                statSync(path).size > MAX_OUTPUT_BYTES,
                        )
                    ) {
                        terminate(new Error("Media output exceeded 2 GiB."));
                    }
                } catch (error) {
                    terminate(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
            }, 500);
            sizeTimer.unref();
            context.signal.addEventListener("abort", cancel, { once: true });
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                const lines = stdout.split(/\r?\n/);
                stdout = lines.pop() ?? "";
                for (const line of lines) {
                    const [key, value] = line.split("=", 2);
                    if (key === "out_time_us" && expectedDuration) {
                        const seconds = Number(value) / 1_000_000;
                        if (Number.isFinite(seconds))
                            context.progress(
                                Math.min(
                                    95,
                                    Math.max(
                                        1,
                                        (seconds / expectedDuration) * 95,
                                    ),
                                ),
                            );
                    }
                }
            });
            child.stderr.on("data", (chunk) => {
                stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
            });
            child.once("error", (error) => finish(terminationError ?? error));
            child.once("close", (code) => {
                if (settled) return;
                if (terminationError) return finish(terminationError);
                if (context.signal.aborted) return finish(abortError());
                if (timedOut)
                    return finish(new Error("Media conversion timed out."));
                if (code !== 0)
                    return finish(
                        new Error(
                            `FFmpeg failed (${String(code)}): ${stderr.trim().slice(-2000)}`,
                        ),
                    );
                try {
                    for (const path of outputs) {
                        const stats = statSync(path);
                        if (
                            !stats.isFile() ||
                            stats.size <= 0 ||
                            stats.size > MAX_OUTPUT_BYTES
                        )
                            throw new Error(
                                "FFmpeg produced an invalid output file.",
                            );
                    }
                } catch (error) {
                    return finish(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                }
                context.progress(100);
                finish();
            });
        });

    const chooseFormat = (
        kind: MediaKind,
        input: ToolInput,
        options: FileToolOptions,
        forced?: string,
    ) => {
        let format = normalizeExtension(
            forced ?? options.format ?? input.extension ?? extname(input.path),
        );
        const allowed =
            kind === "audio"
                ? AUDIO_FORMATS
                : kind === "video"
                  ? VIDEO_FORMATS
                  : IMAGE_FORMATS;
        if (!(allowed as readonly string[]).includes(format)) {
            if (forced || options.format)
                throw new Error(`Unsupported ${kind} output format: ${format}`);
            format =
                kind === "audio" ? "mp3" : kind === "video" ? "mp4" : "png";
        }
        return format;
    };

    const singleArgs = (
        context: ToolContext,
        input: ToolInput,
        kind: MediaKind,
        format: string,
        output: string,
        audioPresent?: boolean,
    ) => {
        const { recipe, options } = context;
        const args = [
            "-protocol_whitelist",
            PROTOCOLS,
            "-protocol_blacklist",
            PROTOCOL_BLACKLIST,
            "-format_whitelist",
            USER_FORMATS,
        ];
        if (
            ["media-trim", "trimVideo", "trimAudio"].includes(recipe) &&
            options.start
        )
            args.push("-ss", String(options.start));
        args.push("-i", input.path);
        if (
            ["media-trim", "trimVideo", "trimAudio"].includes(recipe) &&
            options.end !== undefined
        )
            args.push("-t", String(options.end - (options.start ?? 0)));
        const filters: string[] = [];
        if (["media-resize", "media-image-resize"].includes(recipe)) {
            if (options.width === undefined && options.height === undefined)
                throw new Error("Resize needs width or height.");
            const width = options.width ?? -2;
            const height = options.height ?? -2;
            filters.push(`scale=${width}:${height}`);
        }
        if (
            [
                "media-crop",
                "media-image-crop",
                "cropVideo",
                "cropImage",
            ].includes(recipe)
        ) {
            if (options.width === undefined || options.height === undefined)
                throw new Error("Crop needs width and height.");
            filters.push(
                `crop=${options.width}:${options.height}:${options.x ?? 0}:${options.y ?? 0}`,
            );
        }
        if (["media-rotate", "media-image-rotate"].includes(recipe)) {
            if (options.angle === undefined)
                throw new Error("Rotate needs an angle.");
            filters.push(
                options.angle === 90
                    ? "transpose=1"
                    : options.angle === 270
                      ? "transpose=2"
                      : "hflip,vflip",
            );
        }
        if (recipe === "media-image-flip") {
            if (!options.flip) throw new Error("Flip needs a direction.");
            filters.push(options.flip === "horizontal" ? "hflip" : "vflip");
        }
        if (recipe === "redactImage") {
            if (options.width === undefined || options.height === undefined)
                throw new Error("Image redaction needs width and height.");
            filters.push(
                `drawbox=x=${options.x ?? 0}:y=${options.y ?? 0}:w=${options.width}:h=${options.height}:color=black:t=fill`,
            );
        }
        if (recipe === "redactVideo") {
            if (
                options.width === undefined ||
                options.height === undefined ||
                options.start === undefined ||
                options.end === undefined
            )
                throw new Error(
                    "Video redaction needs a rectangle and time range.",
                );
            filters.push(
                `drawbox=x=${options.x ?? 0}:y=${options.y ?? 0}:w=${options.width}:h=${options.height}:color=black:t=fill:enable='between(t,${options.start},${options.end})'`,
            );
        }
        if (recipe === "media-speed" || recipe === "changeVideoSpeed") {
            if (options.speed === undefined)
                throw new Error("Speed change needs speed.");
            filters.push(`setpts=${1 / options.speed}*PTS`);
            if (audioPresent) {
                let remaining = options.speed;
                const audioFilters: number[] = [];
                while (remaining > 2) {
                    audioFilters.push(2);
                    remaining /= 2;
                }
                while (remaining < 0.5) {
                    audioFilters.push(0.5);
                    remaining /= 0.5;
                }
                audioFilters.push(remaining);
                args.push(
                    "-af",
                    audioFilters.map((value) => `atempo=${value}`).join(","),
                );
            }
        }
        if (filters.length) args.push("-vf", filters.join(","));
        if (
            ["media-mute", "muteVideo"].includes(recipe) ||
            (["media-speed", "changeVideoSpeed"].includes(recipe) &&
                !audioPresent)
        )
            args.push("-an");
        if (["media-extract-audio"].includes(recipe)) args.push("-vn");
        if (["media-normalize", "normalizeAudio"].includes(recipe))
            args.push(
                "-af",
                `loudnorm=I=-16:TP=-1.5:LRA=11${options.volume ? `,volume=${options.volume}` : ""}`,
            );
        if (recipe === "redactAudio") {
            if (options.start === undefined || options.end === undefined)
                throw new Error("Audio redaction needs a time range.");
            args.push(
                "-af",
                `volume=enable='between(t,${options.start},${options.end})':volume=0`,
            );
        }
        if (recipe === "audioChannels") {
            if (!options.channels)
                throw new Error("Audio channel conversion needs channels.");
            args.push("-ac", String(options.channels));
        }
        if (["removeMetadata", "media-image-remove-metadata"].includes(recipe))
            args.push("-map_metadata", "-1", "-map_chapters", "-1");
        args.push(...(codecArgs(kind, format, options.quality) ?? []));
        args.push("-fs", String(MAX_OUTPUT_BYTES), output);
        return args;
    };

    const recipeSupports = (recipeId: string, kind: MediaKind) => {
        if (["compress", "removeMetadata"].includes(recipeId)) return true;
        const image = new Set([
            "media-image-convert",
            "media-image-resize",
            "media-image-compress",
            "media-image-rotate",
            "media-image-crop",
            "media-image-flip",
            "media-image-remove-metadata",
            "cropImage",
            "redactImage",
        ]);
        const audio = new Set([
            "media-convert",
            "media-compress",
            "media-trim",
            "media-normalize",
            "media-merge",
            "media-split",
            "normalizeAudio",
            "trimAudio",
            "audioChannels",
            "audioToVideo",
            "redactAudio",
        ]);
        const video = new Set([
            "media-convert",
            "media-compress",
            "media-trim",
            "media-resize",
            "media-crop",
            "media-rotate",
            "media-speed",
            "media-mute",
            "media-extract-audio",
            "media-merge",
            "media-split",
            "muteVideo",
            "trimVideo",
            "cropVideo",
            "changeVideoSpeed",
            "joinVideos",
            "videoSnapshots",
            "splitVideo",
            "redactVideo",
        ]);
        return (
            kind === "image" ? image : kind === "audio" ? audio : video
        ).has(recipeId);
    };

    const runInternal = async (
        context: ToolContext,
    ): Promise<ToolEngineResult> => {
        if (context.inputs.length < 1 || context.inputs.length > MAX_INPUTS)
            throw new Error(`Media jobs accept 1-${MAX_INPUTS} inputs.`);
        if (!isAbsolute(context.outputDir))
            throw new Error("Media output directory must be absolute.");
        validateOptions(context.recipe, context.options);
        for (const input of context.inputs) validateInput(input);
        const kind = mediaKind(context.inputs[0]);
        if (!kind || context.inputs.some((input) => mediaKind(input) !== kind))
            throw new Error("Media inputs must have one homogeneous kind.");
        if (!recipeSupports(context.recipe, kind))
            throw new Error(
                `${context.recipe} does not support ${kind} inputs.`,
            );
        const capability = await probe();
        if (!capability.available)
            throw new Error(capability.reason ?? "FFmpeg is unavailable.");
        if (
            kind === "image" &&
            !(
                await Promise.all(
                    context.inputs
                        .filter((entry) =>
                            ["heic", "heif"].includes(
                                normalizeExtension(entry.extension),
                            ),
                        )
                        .map(canDecodeHeic),
                )
            ).every(Boolean)
        )
            throw new Error(
                "This FFmpeg build cannot decode the selected HEIC/HEIF input.",
            );
        if (context.signal.aborted) throw abortError();
        const allowed = optionsFor(context.recipe);
        if (!allowed)
            throw new Error(`Unknown media recipe: ${context.recipe}`);
        const isMerge = ["media-merge", "joinVideos"].includes(context.recipe);
        if (isMerge ? context.inputs.length < 2 : context.inputs.length !== 1)
            throw new Error(
                isMerge
                    ? "Merge needs at least two inputs."
                    : "This recipe needs one input.",
            );
        const input = context.inputs[0];
        const warnings: string[] = [];

        if (context.recipe === "videoSnapshots") {
            if (!formatAvailable(capability, "image", "png"))
                throw new Error("FFmpeg cannot encode PNG snapshots.");
            const output = outputPath(context, input, "snapshot", "png");
            const args = [
                ...restrictedInputOptions(),
                ...(context.options.start
                    ? ["-ss", String(context.options.start)]
                    : []),
                "-i",
                input.path,
                "-frames:v",
                "1",
                "-c:v",
                "png",
                "-fs",
                String(MAX_OUTPUT_BYTES),
                output,
            ];
            await runProcess(context, args, [output]);
            return { paths: [output] };
        }

        if (context.recipe === "audioToVideo") {
            if (!formatAvailable(capability, "video", "mp4"))
                throw new Error("FFmpeg cannot encode MP4 video.");
            const output = outputPath(context, input, "video", "mp4");
            const args = [
                ...restrictedInputArgs(input.path),
                "-filter_complex",
                "[0:a:0]asplit=2[a][wave];[wave]showwaves=s=1280x720:mode=line:colors=white:r=30,format=yuv420p[v]",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-shortest",
                ...codecArgs("video", "mp4", context.options.quality),
                "-fs",
                String(MAX_OUTPUT_BYTES),
                output,
            ];
            await runProcess(context, args, [output]);
            return { paths: [output] };
        }

        if (["media-split", "splitVideo"].includes(context.recipe)) {
            const splitAt = boundedNumber(
                context.options.start,
                "start",
                0.01,
                24 * 60 * 60,
            );
            const inputFormat = normalizeExtension(
                input.extension || extname(input.path),
            );
            if (
                context.options.format &&
                normalizeExtension(context.options.format) !== inputFormat
            )
                throw new Error("Split preserves the input container format.");
            const format = chooseFormat(kind, input, {}, inputFormat);
            const first = outputPath(context, input, "part-1", format);
            const second = outputPath(context, input, "part-2", format);
            const common = restrictedInputArgs(input.path);
            await runProcess(
                context,
                [
                    ...common,
                    "-t",
                    String(splitAt),
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-fs",
                    String(MAX_OUTPUT_BYTES),
                    first,
                ],
                [first],
                splitAt,
            );
            await runProcess(
                context,
                [
                    ...restrictedInputOptions(),
                    "-ss",
                    String(splitAt),
                    "-i",
                    input.path,
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-fs",
                    String(MAX_OUTPUT_BYTES),
                    second,
                ],
                [second],
            );
            warnings.push(
                "Split points are keyframe-aligned because streams were copied without re-encoding.",
            );
            return { paths: [first, second], warnings };
        }

        if (isMerge) {
            const format = chooseFormat(
                kind,
                input,
                context.options,
                kind === "video" ? "mp4" : undefined,
            );
            const output = outputPath(context, input, "merged", format);
            if (kind === "audio") {
                const list = join(context.outputDir, "inputs.ffconcat");
                writeFileSync(
                    list,
                    `ffconcat version 1.0\n${context.inputs.map((entry) => `file '${ffconcatPath(entry.path)}'`).join("\n")}\n`,
                    { flag: "wx" },
                );
                await runProcess(
                    context,
                    [
                        ...restrictedInputOptions(`concat,${USER_FORMATS}`),
                        "-f",
                        "concat",
                        "-safe",
                        "0",
                        "-i",
                        list,
                        ...codecArgs("audio", format, context.options.quality),
                        "-fs",
                        String(MAX_OUTPUT_BYTES),
                        output,
                    ],
                    [output],
                );
                return { paths: [output] };
            }
            const width = context.options.width ?? 1280;
            const height = context.options.height ?? 720;
            boundedNumber(width, "width", 1, 16_384, true);
            boundedNumber(height, "height", 1, 16_384, true);
            if (format === "gif")
                throw new Error(
                    "Joined videos need an audio-capable output format.",
                );
            const metadata = await Promise.all(
                context.inputs.map((entry) => probeMedia(entry)),
            );
            const expectedDuration = metadata.reduce(
                (total, entry) => total + entry.duration,
                0,
            );
            const args: string[] = [];
            for (const entry of context.inputs)
                args.push(...restrictedInputArgs(entry.path));
            const filters: string[] = [];
            for (const [index, entry] of metadata.entries()) {
                const duration = entry.duration.toFixed(6);
                filters.push(
                    `[${index}:v:0]fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
                );
                filters.push(
                    entry.audio
                        ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${duration},atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
                        : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`,
                );
            }
            const labels = context.inputs
                .map((_entry, index) => `[v${index}][a${index}]`)
                .join("");
            filters.push(
                `${labels}concat=n=${context.inputs.length}:v=1:a=1[v][a]`,
            );
            args.push(
                "-filter_complex",
                filters.join(";"),
                "-map",
                "[v]",
                "-map",
                "[a]",
                ...codecArgs("video", format, context.options.quality),
                "-fs",
                String(MAX_OUTPUT_BYTES),
                output,
            );
            await runProcess(context, args, [output], expectedDuration);
            const silentSources = metadata.filter(
                (entry) => !entry.audio,
            ).length;
            if (silentSources)
                warnings.push(
                    `Silence was inserted for ${silentSources} source${silentSources === 1 ? "" : "s"} without audio.`,
                );
            return {
                paths: [output],
                ...(warnings.length ? { warnings } : {}),
            };
        }

        let targetKind = kind;
        let forcedFormat: string | undefined;
        if (context.recipe === "media-extract-audio") {
            targetKind = "audio";
            forcedFormat = context.options.format ?? "mp3";
        }
        const format = chooseFormat(
            targetKind,
            input,
            context.options,
            forcedFormat,
        );
        if (!formatAvailable(capability, targetKind, format))
            throw new Error(`FFmpeg cannot encode ${format} on this system.`);
        const output = outputPath(context, input, context.recipe, format);
        const speedRecipe = ["media-speed", "changeVideoSpeed"].includes(
            context.recipe,
        );
        const args = singleArgs(
            context,
            input,
            targetKind,
            format,
            output,
            speedRecipe ? await hasAudio(input) : undefined,
        );
        const duration =
            context.options.end !== undefined
                ? context.options.end - (context.options.start ?? 0)
                : undefined;
        await runProcess(context, args, [output], duration);
        if (["media-trim", "trimVideo", "trimAudio"].includes(context.recipe))
            warnings.push(
                "Trim output was re-encoded for deterministic timestamps.",
            );
        return { paths: [output], ...(warnings.length ? { warnings } : {}) };
    };

    const run = (context: ToolContext): Promise<ToolEngineResult> => {
        const turn = runQueue.then(() => runInternal(context));
        runQueue = turn.then(
            () => undefined,
            () => undefined,
        );
        return turn;
    };

    return { recipes, run };
}
