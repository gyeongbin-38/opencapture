import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileToolOptions } from "../lib/fileTools";
import { createMediaTools } from "../src/main/fileToolsMedia";
import type { ToolContext, ToolInput } from "../src/main/fileToolsTypes";

const root = resolve(__dirname, "..");
const ffmpeg = join(root, "lib", "ffmpeg", "ffmpeg.exe");
const temporary: string[] = [];
const hashFile = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

const temp = () => {
    const path = mkdtempSync(join(tmpdir(), "opencapture-media-tools-"));
    temporary.push(path);
    return path;
};

const input = (
    path: string,
    kind: ToolInput["kind"],
    extension: string,
): ToolInput => ({
    id: basenameForTest(path),
    name: basenameForTest(path),
    path,
    extension,
    kind,
    size: statSync(path).size,
});

const basenameForTest = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const context = (
    source: ToolInput | ToolInput[],
    recipe: string,
    options: FileToolOptions,
    outputDir: string,
    signal = new AbortController().signal,
) => {
    const progress: number[] = [];
    return {
        value: {
            inputs: Array.isArray(source) ? source : [source],
            recipe,
            options,
            outputDir,
            signal,
            progress: (percent: number) => progress.push(percent),
        } satisfies ToolContext,
        progress,
    };
};

const makeImageFixture = (directory: string) => {
    const image = join(directory, "source.png");
    execFileSync(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=96x64",
            "-frames:v",
            "1",
            image,
        ],
        { windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
    );
    return image;
};

const makeAudioFixture = (directory: string) => {
    const audio = join(directory, "source.wav");
    execFileSync(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "pcm_s16le",
            audio,
        ],
        { windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
    );
    return audio;
};

const makeVideoFixture = (directory: string) => {
    const video = join(directory, "source.mp4");
    execFileSync(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x90:rate=15:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-metadata",
            "title=secret-fixture-title",
            "-shortest",
            video,
        ],
        { windowsHide: true },
    );
    return video;
};

const makeFixtures = (directory: string) => {
    const image = makeImageFixture(directory);
    const audio = makeAudioFixture(directory);
    const video = makeVideoFixture(directory);
    return { image, audio, video };
};

const expectDecodable = (path: string) => {
    expect(() =>
        execFileSync(
            ffmpeg,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                path,
                "-f",
                "null",
                "-",
            ],
            { windowsHide: true },
        ),
    ).not.toThrow();
};

const probeMedia = (path: string) => {
    const result = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-i", path], {
        windowsHide: true,
        encoding: "utf8",
    });
    const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(
        result.stderr,
    );
    if (!match) throw new Error(`Missing duration for ${path}`);
    return {
        duration:
            Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
        audio: /Stream #.*Audio:/i.test(result.stderr),
    };
};

const nonBlackPixelsAt = (path: string, seconds: number) => {
    const frame = execFileSync(
        ffmpeg,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            String(seconds),
            "-i",
            path,
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ],
        { windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
    );
    let count = 0;
    for (let index = 0; index < frame.length; index += 3)
        if (frame[index] > 32 || frame[index + 1] > 32 || frame[index + 2] > 32)
            count++;
    return count;
};

afterEach(() => {
    for (const path of temporary.splice(0))
        rmSync(path, { recursive: true, force: true });
});

describe("file tools media engine", () => {
    it("reports unavailable recipes without spawning during construction", async () => {
        const directory = temp();
        const source = join(directory, "source.wav");
        writeFileSync(source, "fixture");
        const engine = createMediaTools({
            ffmpegPath: join(directory, "missing.exe"),
        });
        const recipes = await engine.recipes([input(source, "audio", "wav")]);
        expect(recipes.length).toBeGreaterThan(4);
        expect(recipes.every((entry) => entry.available === false)).toBe(true);
        expect(recipes[0].reason).toMatch(/not installed/i);

        const svg = join(directory, "unsupported.svg");
        writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        await expect(
            engine.recipes([input(svg, "image", "svg")]),
        ).resolves.toEqual([]);
    });

    it("does not advertise HEIC support when the selected file cannot decode", async () => {
        const directory = temp();
        const source = join(directory, "broken.heic");
        writeFileSync(source, "not a HEIC image");
        const engine = createMediaTools({ ffmpegPath: ffmpeg });
        const recipes = await engine.recipes([input(source, "image", "heic")]);
        expect(recipes.length).toBeGreaterThan(4);
        expect(recipes.every((entry) => entry.available === false)).toBe(true);
        expect(recipes[0].reason).toMatch(/cannot decode.*HEIC/i);
    });

    it("produces every advertised image, audio, and video output family", async () => {
        const directory = temp();
        const fixtures = makeFixtures(directory);
        const engine = createMediaTools({ ffmpegPath: ffmpeg });
        const groups = [
            {
                source: input(fixtures.image, "image", "png"),
                recipe: "media-image-convert",
                formats: ["jpg", "png", "webp", "tiff", "avif", "bmp"],
            },
            {
                source: input(fixtures.audio, "audio", "wav"),
                recipe: "media-convert",
                formats: [
                    "mp3",
                    "m4a",
                    "wav",
                    "flac",
                    "ogg",
                    "opus",
                    "aiff",
                    "wma",
                ],
            },
            {
                source: input(fixtures.video, "video", "mp4"),
                recipe: "media-convert",
                formats: ["mp4", "mov", "mkv", "webm", "avi", "wmv", "gif"],
            },
        ] as const;
        for (const group of groups) {
            const available = await engine.recipes([group.source]);
            const conversion = available.find(
                (entry) => entry.id === group.recipe,
            );
            expect(conversion?.available).toBe(true);
            for (const format of group.formats) {
                expect(conversion?.formats).toContain(format);
                const job = context(
                    group.source,
                    group.recipe,
                    { format, quality: 0.4 },
                    join(directory, `matrix-${group.source.kind}-${format}`),
                );
                const result = await engine.run(job.value);
                expect(result.paths[0]).toMatch(new RegExp(`\\.${format}$`));
                expectDecodable(result.paths[0]);
            }
        }
    }, 120_000);

    it("converts real image, audio, and video fixtures with fixed recipes", async () => {
        const directory = temp();
        const fixtures = makeFixtures(directory);
        const engine = createMediaTools({ ffmpegPath: ffmpeg });

        const imageInput = input(fixtures.image, "image", "png");
        const imageRecipes = await engine.recipes([imageInput]);
        expect(
            imageRecipes.find((entry) => entry.id === "media-image-convert"),
        ).toMatchObject({ available: true });
        expect(imageRecipes.map((entry) => entry.id)).toEqual(
            expect.arrayContaining([
                "compress",
                "removeMetadata",
                "cropImage",
                "redactImage",
            ]),
        );
        const imageJob = context(
            imageInput,
            "media-image-convert",
            { format: "webp", quality: 0.7 },
            join(directory, "image-out"),
        );
        const imageResult = await engine.run(imageJob.value);
        expect(imageResult.paths[0]).toMatch(/\.webp$/);
        expect(statSync(imageResult.paths[0]).size).toBeGreaterThan(20);
        expectDecodable(imageResult.paths[0]);
        expect(imageJob.progress.at(-1)).toBe(100);

        const audioInput = input(fixtures.audio, "audio", "wav");
        const audioRecipes = await engine.recipes([audioInput]);
        expect(audioRecipes.map((entry) => entry.id)).toEqual(
            expect.arrayContaining([
                "normalizeAudio",
                "trimAudio",
                "audioChannels",
                "audioToVideo",
                "redactAudio",
            ]),
        );
        const audioJob = context(
            audioInput,
            "normalizeAudio",
            { format: "mp3", quality: 0.65 },
            join(directory, "audio-out"),
        );
        const audioResult = await engine.run(audioJob.value);
        expect(audioResult.paths[0]).toMatch(/\.mp3$/);
        expect(statSync(audioResult.paths[0]).size).toBeGreaterThan(100);
        expectDecodable(audioResult.paths[0]);

        const channelsJob = context(
            audioInput,
            "audioChannels",
            JSON.parse('{"format":"wav","channels":1}') as FileToolOptions,
            join(directory, "channels-out"),
        );
        const channels = await engine.run(channelsJob.value);
        expectDecodable(channels.paths[0]);

        const silenceJob = context(
            audioInput,
            "redactAudio",
            { format: "wav", start: 0.3, end: 0.8 },
            join(directory, "silence-out"),
        );
        const silenced = await engine.run(silenceJob.value);
        expectDecodable(silenced.paths[0]);

        const audioVideoJob = context(
            audioInput,
            "audioToVideo",
            { quality: 0.5 },
            join(directory, "audio-video-out"),
        );
        const audioVideo = await engine.run(audioVideoJob.value);
        expect(audioVideo.warnings).toBeUndefined();
        expectDecodable(audioVideo.paths[0]);
        expect(probeMedia(audioVideo.paths[0]).audio).toBe(true);
        expect(nonBlackPixelsAt(audioVideo.paths[0], 0.25)).toBeGreaterThan(
            100,
        );
        expect(nonBlackPixelsAt(audioVideo.paths[0], 1.25)).toBeGreaterThan(
            100,
        );

        const audioMergeJob = context(
            [audioInput, { ...audioInput, id: "second-audio" }],
            "media-merge",
            { format: "mp3", quality: 0.6 },
            join(directory, "audio-merge-out"),
        );
        const mergedAudio = await engine.run(audioMergeJob.value);
        expectDecodable(mergedAudio.paths[0]);

        const videoInput = input(fixtures.video, "video", "mp4");
        const videoRecipes = await engine.recipes([videoInput]);
        expect(videoRecipes.map((entry) => entry.id)).toEqual(
            expect.arrayContaining([
                "muteVideo",
                "trimVideo",
                "cropVideo",
                "changeVideoSpeed",
                "joinVideos",
                "videoSnapshots",
                "splitVideo",
                "redactVideo",
            ]),
        );
        const metadataJob = context(
            videoInput,
            "removeMetadata",
            { format: "mp4", quality: 0.55 },
            join(directory, "metadata-out"),
        );
        const metadataFree = await engine.run(metadataJob.value);
        const metadata = execFileSync(
            ffmpeg,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                metadataFree.paths[0],
                "-f",
                "ffmetadata",
                "-",
            ],
            { windowsHide: true, encoding: "utf8" },
        );
        expect(metadata).not.toContain("secret-fixture-title");
        const snapshotJob = context(
            videoInput,
            "videoSnapshots",
            { start: 0.4 },
            join(directory, "snapshot-out"),
        );
        const snapshot = await engine.run(snapshotJob.value);
        expect(snapshot.paths[0]).toMatch(/\.png$/);
        expect(statSync(snapshot.paths[0]).size).toBeGreaterThan(100);
        expectDecodable(snapshot.paths[0]);

        const redactJob = context(
            videoInput,
            "redactVideo",
            {
                format: "mp4",
                x: 4,
                y: 4,
                width: 40,
                height: 30,
                start: 0.2,
                end: 1.2,
                quality: 0.6,
            },
            join(directory, "redact-out"),
        );
        const redacted = await engine.run(redactJob.value);
        expect(statSync(redacted.paths[0]).size).toBeGreaterThan(100);
        expectDecodable(redacted.paths[0]);

        const muteJob = context(
            videoInput,
            "muteVideo",
            { format: "mp4", quality: 0.55 },
            join(directory, "mute-out"),
        );
        const muted = await engine.run(muteJob.value);
        expectDecodable(muted.paths[0]);
        expect(() =>
            execFileSync(
                ffmpeg,
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    muted.paths[0],
                    "-map",
                    "0:a:0",
                    "-f",
                    "null",
                    "-",
                ],
                { windowsHide: true, stdio: "ignore" },
            ),
        ).toThrow();

        const speedJob = context(
            videoInput,
            "changeVideoSpeed",
            { format: "mp4", speed: 1.5, quality: 0.55 },
            join(directory, "speed-out"),
        );
        const spedUp = await engine.run(speedJob.value);
        expectDecodable(spedUp.paths[0]);
        expect(() =>
            execFileSync(
                ffmpeg,
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    spedUp.paths[0],
                    "-map",
                    "0:a:0",
                    "-frames:a",
                    "1",
                    "-f",
                    "null",
                    "-",
                ],
                { windowsHide: true, stdio: "ignore" },
            ),
        ).not.toThrow();

        const joinedJob = context(
            [videoInput, { ...videoInput, id: "second" }],
            "joinVideos",
            { format: "mp4", width: 160, height: 90, quality: 0.55 },
            join(directory, "join-out"),
        );
        const joined = await engine.run(joinedJob.value);
        expect(joined.warnings).toBeUndefined();
        expectDecodable(joined.paths[0]);
        const joinedInfo = probeMedia(joined.paths[0]);
        expect(joinedInfo.audio).toBe(true);
        expect(joinedInfo.duration).toBeGreaterThanOrEqual(3.8);
        expect(joinedInfo.duration).toBeLessThanOrEqual(4.3);

        const silentVideoPath = join(directory, "silent.mp4");
        execFileSync(
            ffmpeg,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                fixtures.video,
                "-an",
                "-c:v",
                "copy",
                silentVideoPath,
            ],
            { windowsHide: true },
        );
        const silentVideo = input(silentVideoPath, "video", "mp4");
        const sourceHashes = [
            hashFile(fixtures.video),
            hashFile(silentVideoPath),
        ];
        const mixedJoinJob = context(
            [videoInput, silentVideo],
            "joinVideos",
            { format: "mp4", width: 160, height: 90, quality: 0.55 },
            join(directory, "mixed-join-out"),
        );
        const mixedJoin = await engine.run(mixedJoinJob.value);
        expect(mixedJoin.warnings).toContain(
            "Silence was inserted for 1 source without audio.",
        );
        const mixedInfo = probeMedia(mixedJoin.paths[0]);
        expect(mixedInfo.audio).toBe(true);
        expect(mixedInfo.duration).toBeGreaterThanOrEqual(3.8);
        expect(mixedInfo.duration).toBeLessThanOrEqual(4.3);
        expect([hashFile(fixtures.video), hashFile(silentVideoPath)]).toEqual(
            sourceHashes,
        );

        const splitJob = context(
            videoInput,
            "splitVideo",
            { start: 0.8 },
            join(directory, "split-real-out"),
        );
        const split = await engine.run(splitJob.value);
        expect(split.paths).toHaveLength(2);
        split.paths.forEach(expectDecodable);
    }, 120_000);

    it("kills an active conversion when its signal is aborted", async () => {
        const directory = temp();
        const video = join(directory, "long.mp4");
        execFileSync(
            ffmpeg,
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=30:duration=12",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                video,
            ],
            { windowsHide: true },
        );
        const source = input(video, "video", "mp4");
        const engine = createMediaTools({ ffmpegPath: ffmpeg });
        await engine.recipes([source]);
        const controller = new AbortController();
        const outputDir = join(directory, "cancel-out");
        const sourceHash = hashFile(video);
        const job = context(
            [source, { ...source, id: "second" }],
            "joinVideos",
            { format: "mp4", width: 640, height: 360, quality: 1 },
            outputDir,
            controller.signal,
        );
        const running = engine.run(job.value);
        setTimeout(() => controller.abort(), 500);
        await expect(running).rejects.toMatchObject({ name: "AbortError" });
        expect(hashFile(video)).toBe(sourceHash);
        expect(existsSync(outputDir) ? readdirSync(outputDir) : []).toEqual([]);
    }, 60_000);

    it("rejects malformed options, protocols, and split container changes", async () => {
        const directory = temp();
        const videoPath = makeVideoFixture(directory);
        const engine = createMediaTools({ ffmpegPath: ffmpeg });
        const video = input(videoPath, "video", "mp4");

        const malformed = context(
            video,
            "media-convert",
            {
                format: "mp4",
                argv: ["-i", "https://example.com"],
            } as FileToolOptions,
            join(directory, "malformed-out"),
        );
        await expect(engine.run(malformed.value)).rejects.toThrow(
            /Unsupported option/,
        );

        const percentQuality = context(
            video,
            "media-convert",
            { format: "mp4", quality: 50 },
            join(directory, "bad-quality-out"),
        );
        await expect(engine.run(percentQuality.value)).rejects.toThrow(
            /quality.*supported range/i,
        );

        const split = context(
            video,
            "splitVideo",
            { start: 0.5, format: "webm" },
            join(directory, "split-out"),
        );
        await expect(engine.run(split.value)).rejects.toThrow(
            /preserves the input/,
        );

        const playlist = join(directory, "remote.m3u8");
        writeFileSync(playlist, "https://example.com/video.ts\n");
        const playlistInput = input(playlist, "video", "m3u8");
        const playlistJob = context(
            playlistInput,
            "media-convert",
            { format: "mp4" },
            join(directory, "playlist-out"),
        );
        await expect(engine.run(playlistJob.value)).rejects.toThrow(/Playlist/);

        const sentinelHash = hashFile(videoPath);
        const referenced = videoPath.replaceAll("\\", "/");
        const attacks = [
            {
                name: "renamed-hls.mp4",
                body: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:///${referenced}\n#EXT-X-ENDLIST\n`,
            },
            {
                name: "renamed-ffconcat.mp4",
                body: `ffconcat version 1.0\nfile '${referenced}'\n`,
            },
        ];
        for (const attack of attacks) {
            const path = join(directory, attack.name);
            const outputDir = join(directory, `${attack.name}-out`);
            writeFileSync(path, attack.body);
            const attackJob = context(
                input(path, "video", "mp4"),
                "media-convert",
                { format: "mp4" },
                outputDir,
            );
            await expect(engine.run(attackJob.value)).rejects.toThrow(
                /external-reference signatures/,
            );
            expect(existsSync(outputDir)).toBe(false);
            expect(hashFile(videoPath)).toBe(sentinelHash);
        }
    }, 15_000);
});
