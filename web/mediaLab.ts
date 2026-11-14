import { lt } from "./i18n";
import { downloadBlob } from "./imageOps";

export type MediaLabOptions = {
    onImage: (dataURL: string, name: string) => Promise<unknown>;
    message: (text: string, error?: boolean) => void;
};

export type MediaLab = {
    openFile(file: File): Promise<void>;
    destroy(): void;
};

type BrowserImageDecoder = {
    tracks: {
        ready: Promise<void>;
        selectedTrack?: { frameCount?: number } | null;
    };
    decode(options: {
        frameIndex: number;
        completeFramesOnly?: boolean;
    }): Promise<{
        image: VideoFrame;
        complete?: boolean;
    }>;
    close(): void;
};

type BrowserImageDecoderConstructor = new (options: {
    data: BufferSource;
    type: string;
}) => BrowserImageDecoder;

type CaptureVideo = HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
};

const GIF_MAX_FRAMES = 120;
const GIF_MAX_PIXELS = 24_000_000;
const GIF_MAX_BYTES = 128 * 1024 * 1024;

const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const control = (
    labelText: string,
    input: HTMLInputElement | HTMLSelectElement,
    testId: string,
) => {
    const label = element("label", "media-lab__field");
    const text = element("span", "media-lab__label", labelText);
    input.dataset.testid = testId;
    label.append(text, input);
    return label;
};

const button = (text: string, testId: string, secondary = false) => {
    const value = element(
        "button",
        secondary ? "media-lab__button is-secondary" : "media-lab__button",
        text,
    );
    value.type = "button";
    value.dataset.testid = testId;
    return value;
};

const readDataURL = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
            reject(reader.error ?? new Error(lt("파일을 읽을 수 없습니다.")));
        reader.readAsDataURL(blob);
    });

const canvasBlob = (canvas: HTMLCanvasElement, type: string) =>
    new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
            (blob) =>
                blob
                    ? resolve(blob)
                    : reject(new Error(lt("프레임을 인코딩할 수 없습니다."))),
            type,
        ),
    );

const waitFor = (target: EventTarget, type: string) =>
    new Promise<void>((resolve, reject) => {
        const done = () => {
            cleanup();
            resolve();
        };
        const failed = () => {
            cleanup();
            reject(new Error(lt("미디어 파일을 불러올 수 없습니다.")));
        };
        const cleanup = () => {
            target.removeEventListener(type, done);
            target.removeEventListener("error", failed);
        };
        target.addEventListener(type, done, { once: true });
        target.addEventListener("error", failed, { once: true });
    });

const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const stem = (name: string) => name.replace(/\.[^.]+$/, "") || lt("미디어");

const recordingMimeType = () => {
    const choices = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
    ];
    return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
};

export function createMediaLab(
    parent: HTMLElement,
    options: MediaLabOptions,
): MediaLab {
    const root = element("section", "media-lab");
    root.dataset.testid = "media-lab";
    root.setAttribute("aria-labelledby", "media-lab-title");

    const heading = element("div", "media-lab__heading");
    const headingCopy = element("div");
    const title = element("h2", "media-lab__title", lt("미디어 실험실"));
    title.id = "media-lab-title";
    headingCopy.append(
        title,
        element(
            "p",
            "media-lab__subtitle",
            lt(
                "로컬 미디어를 열어 프레임을 추출하고, 영상을 자르거나 공유 화면을 녹화합니다.",
            ),
        ),
    );
    const openButton = button(lt("미디어 열기"), "media-open");
    const fileInput = element("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,video/*,.gif";
    fileInput.hidden = true;
    fileInput.dataset.testid = "media-file-input";
    heading.append(headingCopy, openButton, fileInput);

    const status = element(
        "p",
        "media-lab__status",
        lt(
            "이미지, GIF 또는 동영상을 선택하세요. 파일은 이 브라우저 탭에서만 처리됩니다.",
        ),
    );
    status.dataset.testid = "media-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const preview = element("div", "media-lab__preview is-empty");
    preview.dataset.testid = "media-preview";
    preview.append(
        element("p", "media-lab__empty", lt("열린 미디어가 없습니다.")),
    );

    const actions = element("div", "media-lab__actions");
    actions.dataset.testid = "media-actions";

    const settings = element("details", "media-lab__settings");
    settings.dataset.testid = "media-advanced";
    settings.append(element("summary", undefined, lt("고급 설정")));
    const settingsBody = element("div", "media-lab__settings-body");

    const speed = element("select");
    for (const value of ["0.25", "0.5", "1", "1.5", "2"]) {
        const option = element("option");
        option.value = value;
        option.textContent = `${value}×`;
        option.selected = value === "1";
        speed.append(option);
    }
    const muted = element("input");
    muted.type = "checkbox";
    const mutedField = control(lt("미리보기 음소거"), muted, "media-muted");
    mutedField.classList.add("is-check");
    const audio = element("input");
    audio.type = "checkbox";
    const audioField = control(lt("공유 오디오 포함"), audio, "record-audio");
    audioField.classList.add("is-check");
    settingsBody.append(
        control(lt("재생 속도"), speed, "media-speed"),
        mutedField,
        audioField,
    );
    settings.append(settingsBody);

    const recorderCard = element("section", "media-lab__recorder");
    const recorderTitle = element("h3", undefined, lt("화면 녹화"));
    const recorderHelp = element(
        "p",
        "media-lab__help",
        lt(
            "녹화 시작을 누르면 브라우저가 운영체제 화면 공유 권한을 요청합니다.",
        ),
    );
    recorderHelp.dataset.testid = "record-support";
    const recorderActions = element("div", "media-lab__actions");
    const recordStart = button(lt("녹화 시작"), "record-start");
    const recordStop = button(lt("녹화 중지"), "record-stop", true);
    const recordDownload = button(
        lt("녹화 파일 다운로드"),
        "record-download",
        true,
    );
    recordStop.disabled = true;
    recordDownload.disabled = true;
    recorderActions.append(recordStart, recordStop, recordDownload);
    recorderCard.append(recorderTitle, recorderHelp, recorderActions);

    const cancel = button(lt("현재 작업 취소"), "media-cancel", true);
    cancel.hidden = true;
    root.append(
        heading,
        status,
        preview,
        actions,
        settings,
        recorderCard,
        cancel,
    );
    parent.append(root);

    let destroyed = false;
    let currentUrl: string | undefined;
    let currentVideo: CaptureVideo | undefined;
    let currentName = lt("미디어");
    let currentGif: BrowserImageDecoder | undefined;
    let gifFrameCount = 0;
    let screenStream: MediaStream | undefined;
    let screenRecorder: MediaRecorder | undefined;
    let screenChunks: Blob[] = [];
    let screenBlob: Blob | undefined;
    let screenName = lt("화면-녹화.webm");
    let recordingStarted = 0;
    let recordingTimer: number | undefined;
    let taskAbort: AbortController | undefined;
    let busy = false;

    const revokeCurrentUrl = () => {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = undefined;
    };

    const stopScreenTracks = () => {
        for (const track of screenStream?.getTracks() ?? []) track.stop();
        screenStream = undefined;
    };

    const closeCurrent = () => {
        currentVideo?.pause();
        currentVideo = undefined;
        currentGif?.close();
        currentGif = undefined;
        gifFrameCount = 0;
        revokeCurrentUrl();
        preview.replaceChildren();
        preview.classList.add("is-empty");
        actions.replaceChildren();
    };

    const setStatus = (text: string, error = false) => {
        status.textContent = text;
        status.classList.toggle("is-error", error);
        status.setAttribute("role", error ? "alert" : "status");
    };

    const report = (text: string, error = false) => {
        setStatus(text, error);
        options.message(text, error);
    };

    const setBusy = (value: boolean, label?: string) => {
        busy = value;
        root.classList.toggle("is-busy", value);
        openButton.disabled = value;
        fileInput.disabled = value;
        cancel.hidden = !value;
        if (label) setStatus(label);
        for (const value of actions.querySelectorAll<HTMLButtonElement>(
            "button",
        ))
            value.disabled = busy;
    };

    const runTask = async (
        label: string,
        task: (signal: AbortSignal) => Promise<void>,
    ) => {
        if (busy) return;
        const controller = new AbortController();
        taskAbort = controller;
        setBusy(true, label);
        try {
            await task(controller.signal);
        } catch (error) {
            if (controller.signal.aborted) report(lt("작업을 취소했습니다."));
            else report(errorText(error), true);
        } finally {
            if (taskAbort === controller) taskAbort = undefined;
            setBusy(false);
        }
    };

    const addImage = async (dataURL: string, name: string) => {
        await options.onImage(dataURL, name);
        report(
            lt(
                `${name} 파일을 이미지 작업 공간에 추가했습니다.`,
                `Added ${name} to the image workspace.`,
            ),
        );
    };

    const showImage = async (file: File) => {
        currentUrl = URL.createObjectURL(file);
        const image = element("img", "media-lab__image");
        image.alt = file.name;
        image.src = currentUrl;
        image.dataset.testid = "image-preview";
        preview.replaceChildren(image);
        preview.classList.remove("is-empty");
        await image.decode();
        const add = button(lt("이미지 작업 공간에 추가"), "image-add");
        add.onclick = () => {
            void runTask(lt("이미지를 읽는 중…"), async () => {
                await addImage(await readDataURL(file), file.name);
            });
        };
        actions.replaceChildren(add);
        setStatus(
            lt(`${file.name} 파일을 열었습니다.`, `Opened ${file.name}.`),
        );
    };

    const videoCanvas = (video: HTMLVideoElement) => {
        if (!video.videoWidth || !video.videoHeight)
            throw new Error(lt("동영상 프레임이 아직 준비되지 않았습니다."));
        if (video.videoWidth * video.videoHeight > GIF_MAX_PIXELS)
            throw new Error(lt("프레임은 최대 2,400만 화소까지 지원합니다."));
        const canvas = element("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error(lt("캔버스를 사용할 수 없습니다."));
        context.drawImage(video, 0, 0);
        return canvas;
    };

    const trimVideo = async (
        video: CaptureVideo,
        start: number,
        end: number,
        signal: AbortSignal,
    ) => {
        const capture = video.captureStream ?? video.mozCaptureStream;
        if (!capture)
            throw new Error(
                lt("이 브라우저는 실시간 동영상 자르기를 지원하지 않습니다."),
            );
        if (typeof MediaRecorder === "undefined")
            throw new Error(
                lt("이 브라우저는 MediaRecorder를 지원하지 않습니다."),
            );
        video.pause();
        const previousRate = video.playbackRate;
        video.playbackRate = 1;
        video.currentTime = start;
        await waitFor(video, "seeked");
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const stream = capture.call(video);
        const mimeType = recordingMimeType();
        const recorder = new MediaRecorder(
            stream,
            mimeType ? { mimeType } : undefined,
        );
        const chunks: Blob[] = [];
        const result = new Promise<Blob>((resolve, reject) => {
            recorder.ondataavailable = (event) => {
                if (event.data.size) chunks.push(event.data);
            };
            recorder.onerror = () =>
                reject(new Error(lt("동영상 인코딩에 실패했습니다.")));
            recorder.onstop = () => {
                if (signal.aborted)
                    reject(new DOMException("Cancelled", "AbortError"));
                else if (!chunks.length)
                    reject(
                        new Error(
                            lt("자른 동영상 데이터가 생성되지 않았습니다."),
                        ),
                    );
                else
                    resolve(
                        new Blob(chunks, {
                            type: recorder.mimeType || "video/webm",
                        }),
                    );
            };
        });
        const stop = () => {
            if (recorder.state !== "inactive") recorder.stop();
            video.pause();
            for (const track of stream.getTracks()) track.stop();
        };
        const onTime = () => {
            if (video.currentTime >= end) stop();
        };
        const onAbort = () => stop();
        video.addEventListener("timeupdate", onTime);
        video.addEventListener("ended", stop, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        recorder.start(250);
        try {
            await video.play();
            return await result;
        } finally {
            video.removeEventListener("timeupdate", onTime);
            video.removeEventListener("ended", stop);
            signal.removeEventListener("abort", onAbort);
            video.playbackRate = previousRate;
            video.currentTime = Math.min(end, video.duration || end);
        }
    };

    const showVideo = async (blob: Blob, name: string, isRecording = false) => {
        closeCurrent();
        currentName = name;
        currentUrl = URL.createObjectURL(blob);
        const video = element("video", "media-lab__video") as CaptureVideo;
        video.controls = true;
        video.preload = "metadata";
        video.src = currentUrl;
        video.dataset.testid = "video-preview";
        currentVideo = video;
        preview.replaceChildren(video);
        preview.classList.remove("is-empty");
        await waitFor(video, "loadedmetadata");

        const start = element("input");
        start.type = "number";
        start.min = "0";
        start.step = "0.1";
        start.value = "0";
        const end = element("input");
        end.type = "number";
        end.min = "0";
        end.max = String(video.duration);
        end.step = "0.1";
        end.value = Number.isFinite(video.duration)
            ? video.duration.toFixed(2)
            : "0";
        const range = element("div", "media-lab__fields");
        range.append(
            control(lt("시작 위치(초)"), start, "video-trim-start"),
            control(lt("끝 위치(초)"), end, "video-trim-end"),
        );
        const extract = button(lt("현재 프레임 추출"), "video-extract-frame");
        const trim = button(lt("자른 WebM 내보내기"), "video-trim-export");
        const download = button(
            isRecording ? lt("녹화 파일 다운로드") : lt("원본 다운로드"),
            "video-download-original",
            true,
        );
        if (!(video.captureStream ?? video.mozCaptureStream)) {
            trim.disabled = true;
            trim.title = lt(
                "실시간 동영상 자르기는 Chrome 또는 Edge의 captureStream 기능이 필요합니다.",
            );
        }
        extract.onclick = () => {
            void runTask(lt("현재 프레임을 인코딩하는 중…"), async () => {
                const dataURL = await readDataURL(
                    await canvasBlob(videoCanvas(video), "image/png"),
                );
                await addImage(
                    dataURL,
                    lt(
                        `${stem(name)}-프레임-${video.currentTime.toFixed(2)}.png`,
                        `${stem(name)}-frame-${video.currentTime.toFixed(2)}.png`,
                    ),
                );
            });
        };
        trim.onclick = () => {
            void runTask(
                lt("동영상을 실시간으로 자르는 중…"),
                async (signal) => {
                    const from = Number(start.value);
                    const to = Number(end.value);
                    if (
                        !Number.isFinite(from) ||
                        !Number.isFinite(to) ||
                        from < 0 ||
                        to <= from ||
                        to > video.duration + 0.01
                    )
                        throw new Error(
                            lt(
                                "동영상 재생 시간 안에서 올바른 구간을 선택하세요.",
                            ),
                        );
                    const output = await trimVideo(video, from, to, signal);
                    downloadBlob(
                        output,
                        `${stem(name)}-${from.toFixed(1)}-${to.toFixed(1)}.webm`,
                    );
                    report(lt("자른 WebM을 인코딩하고 다운로드했습니다."));
                },
            );
        };
        download.onclick = () => downloadBlob(blob, name);
        actions.replaceChildren(range, extract, trim, download);
        speed.onchange = () => {
            if (currentVideo) currentVideo.playbackRate = Number(speed.value);
        };
        muted.onchange = () => {
            if (currentVideo) currentVideo.muted = muted.checked;
        };
        video.playbackRate = Number(speed.value);
        video.muted = muted.checked;
        setStatus(
            lt(
                `${name} 파일을 열었습니다. 재생 시간: ${video.duration.toFixed(2)}초`,
                `Opened ${name}. Duration: ${video.duration.toFixed(2)}s`,
            ),
        );
    };

    const imageDecoderConstructor = () =>
        (
            globalThis as typeof globalThis & {
                ImageDecoder?: BrowserImageDecoderConstructor;
            }
        ).ImageDecoder;

    const decodeGifFrame = async (
        decoder: BrowserImageDecoder,
        frameIndex: number,
    ) => {
        const { image } = await decoder.decode({
            frameIndex,
            completeFramesOnly: true,
        });
        if (image.codedWidth * image.codedHeight > GIF_MAX_PIXELS) {
            image.close();
            throw new Error(
                lt("GIF 프레임은 최대 2,400만 화소까지 지원합니다."),
            );
        }
        const canvas = element("canvas");
        canvas.width = image.codedWidth;
        canvas.height = image.codedHeight;
        const context = canvas.getContext("2d", {
            alpha: true,
            willReadFrequently: true,
        });
        if (!context) {
            image.close();
            throw new Error(lt("캔버스를 사용할 수 없습니다."));
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        const duration = image.duration;
        image.close();
        return { canvas, context, duration };
    };

    const showGif = async (file: File) => {
        const Decoder = imageDecoderConstructor();
        if (!Decoder)
            throw new Error(
                lt(
                    "움직이는 GIF를 디코딩하려면 Chrome 또는 Edge의 ImageDecoder가 필요합니다.",
                ),
            );
        if (file.size > GIF_MAX_BYTES)
            throw new Error(lt("GIF 파일은 최대 128MiB까지 지원합니다."));
        const decoder = new Decoder({
            data: await file.arrayBuffer(),
            type: "image/gif",
        });
        try {
            await decoder.tracks.ready;
            const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
            if (!count) throw new Error(lt("GIF 프레임을 찾을 수 없습니다."));
            currentGif = decoder;
            gifFrameCount = count;
            currentUrl = URL.createObjectURL(file);
            const image = element("img", "media-lab__image");
            image.alt = lt(
                `${file.name} 움직이는 미리보기`,
                `${file.name} animated preview`,
            );
            image.src = currentUrl;
            image.dataset.testid = "gif-preview";
            const frameCanvas = element("canvas", "media-lab__gif-frame");
            frameCanvas.dataset.testid = "gif-frame-preview";
            preview.replaceChildren(image, frameCanvas);
            preview.classList.remove("is-empty");

            const start = element("input");
            start.type = "number";
            start.min = "0";
            start.max = String(count - 1);
            start.value = "0";
            const end = element("input");
            end.type = "number";
            end.min = "0";
            end.max = String(count - 1);
            end.value = String(count - 1);
            const fps = element("input");
            fps.type = "number";
            fps.min = "1";
            fps.max = "60";
            fps.value = "12";
            const fields = element("div", "media-lab__fields");
            fields.append(
                control(lt("첫 프레임"), start, "gif-trim-start"),
                control(lt("마지막 프레임"), end, "gif-trim-end"),
                control(lt("내보내기 FPS"), fps, "gif-export-fps"),
            );
            const extract = button(lt("선택 프레임 추가"), "gif-extract-frame");
            const exportButton = button(lt("GIF 내보내기"), "gif-export");
            const renderFrame = async () => {
                if (currentGif !== decoder) return;
                const index = Math.max(
                    0,
                    Math.min(count - 1, Math.round(Number(start.value) || 0)),
                );
                const decoded = await decodeGifFrame(decoder, index);
                frameCanvas.width = decoded.canvas.width;
                frameCanvas.height = decoded.canvas.height;
                frameCanvas.getContext("2d")?.drawImage(decoded.canvas, 0, 0);
            };
            start.onchange = () =>
                void renderFrame().catch((error) =>
                    report(errorText(error), true),
                );
            extract.onclick = () => {
                void runTask(lt("GIF 프레임을 추출하는 중…"), async () => {
                    const index = Math.max(
                        0,
                        Math.min(
                            count - 1,
                            Math.round(Number(start.value) || 0),
                        ),
                    );
                    const decoded = await decodeGifFrame(decoder, index);
                    const dataURL = await readDataURL(
                        await canvasBlob(decoded.canvas, "image/png"),
                    );
                    await addImage(
                        dataURL,
                        lt(
                            `${stem(file.name)}-프레임-${index + 1}.png`,
                            `${stem(file.name)}-frame-${index + 1}.png`,
                        ),
                    );
                });
            };
            exportButton.onclick = () => {
                void runTask(
                    lt("GIF를 디코딩하고 인코딩하는 중…"),
                    async (signal) => {
                        const first = Math.round(Number(start.value));
                        const last = Math.round(Number(end.value));
                        const outputFps = Math.round(Number(fps.value));
                        if (
                            !Number.isFinite(first) ||
                            !Number.isFinite(last) ||
                            first < 0 ||
                            last >= count ||
                            first > last
                        )
                            throw new Error(
                                lt("올바른 GIF 프레임 구간을 선택하세요."),
                            );
                        if (
                            !Number.isFinite(outputFps) ||
                            outputFps < 1 ||
                            outputFps > 60
                        )
                            throw new Error(
                                lt("GIF FPS는 1에서 60 사이여야 합니다."),
                            );
                        const selected = last - first + 1;
                        if (selected > GIF_MAX_FRAMES)
                            throw new Error(
                                lt(
                                    `GIF는 최대 ${GIF_MAX_FRAMES}프레임까지 내보낼 수 있습니다.`,
                                    `GIF exports are limited to ${GIF_MAX_FRAMES} frames.`,
                                ),
                            );
                        // @ts-expect-error gifenc does not publish TypeScript declarations.
                        const gifenc = await import("gifenc");
                        const { GIFEncoder, applyPalette, quantize } = gifenc;
                        const gif = GIFEncoder();
                        const delay = Math.max(
                            20,
                            Math.round(1000 / outputFps),
                        );
                        let frameWidth = 0;
                        let frameHeight = 0;
                        for (let index = first; index <= last; index += 1) {
                            if (signal.aborted)
                                throw new DOMException(
                                    "Cancelled",
                                    "AbortError",
                                );
                            const decoded = await decodeGifFrame(
                                decoder,
                                index,
                            );
                            if (!frameWidth) {
                                frameWidth = decoded.canvas.width;
                                frameHeight = decoded.canvas.height;
                            } else if (
                                decoded.canvas.width !== frameWidth ||
                                decoded.canvas.height !== frameHeight
                            ) {
                                throw new Error(
                                    lt(
                                        "프레임 크기가 바뀌는 GIF는 지원하지 않습니다.",
                                    ),
                                );
                            }
                            const pixels = decoded.context.getImageData(
                                0,
                                0,
                                frameWidth,
                                frameHeight,
                            ).data;
                            const palette = quantize(pixels, 256, {
                                format: "rgba4444",
                                oneBitAlpha: true,
                                clearAlpha: true,
                            }) as [number, number, number, number][];
                            const indexed = applyPalette(
                                pixels,
                                palette,
                                "rgba4444",
                            );
                            const transparentIndex = palette.findIndex(
                                (color) => color[3] === 0,
                            );
                            gif.writeFrame(indexed, frameWidth, frameHeight, {
                                palette,
                                delay,
                                transparent: transparentIndex >= 0,
                                transparentIndex: Math.max(0, transparentIndex),
                                dispose: transparentIndex >= 0 ? 2 : 1,
                            });
                            setStatus(
                                lt(
                                    `GIF 프레임을 인코딩하는 중: ${index - first + 1}/${selected}`,
                                    `Encoding GIF frame: ${index - first + 1}/${selected}`,
                                ),
                            );
                            await new Promise<void>((resolve) =>
                                requestAnimationFrame(() => resolve()),
                            );
                        }
                        gif.finish();
                        const output = new Blob([gif.bytes()], {
                            type: "image/gif",
                        });
                        downloadBlob(
                            output,
                            `${stem(file.name)}-${first + 1}-${last + 1}.gif`,
                        );
                        report(
                            lt(
                                `GIF ${selected}프레임을 ${outputFps} FPS로 인코딩하고 다운로드했습니다.`,
                                `Encoded and downloaded a ${selected}-frame GIF at ${outputFps} FPS.`,
                            ),
                        );
                    },
                );
            };
            actions.replaceChildren(fields, extract, exportButton);
            await renderFrame();
            setStatus(
                lt(
                    `${file.name} 파일을 열었습니다. 총 ${count}프레임`,
                    `Opened ${file.name}. ${count} frames total.`,
                ),
            );
        } catch (error) {
            decoder.close();
            if (currentGif === decoder) currentGif = undefined;
            throw error;
        }
    };

    const openFile = async (file: File) => {
        if (destroyed) throw new Error(lt("이미 종료된 미디어 실험실입니다."));
        if (!file || file.size <= 0)
            throw new Error(lt("내용이 있는 미디어 파일을 선택하세요."));
        if (busy)
            throw new Error(
                lt(
                    "현재 미디어 작업이 끝날 때까지 기다리거나 작업을 취소하세요.",
                ),
            );
        closeCurrent();
        currentName = file.name;
        try {
            if (
                file.type === "image/gif" ||
                file.name.toLowerCase().endsWith(".gif")
            )
                await showGif(file);
            else if (file.type.startsWith("image/")) await showImage(file);
            else if (file.type.startsWith("video/"))
                await showVideo(file, file.name);
            else
                throw new Error(
                    lt("이미지, GIF 또는 동영상 파일을 선택하세요."),
                );
        } catch (error) {
            closeCurrent();
            report(errorText(error), true);
            throw error;
        }
    };

    const stopRecording = () => {
        if (screenRecorder?.state && screenRecorder.state !== "inactive")
            screenRecorder.stop();
        recordStop.disabled = true;
    };

    const updateRecordStatus = () => {
        if (
            !recordingStarted ||
            !screenRecorder ||
            screenRecorder.state === "inactive"
        )
            return;
        const seconds = (performance.now() - recordingStarted) / 1000;
        setStatus(
            lt(
                `공유 화면 녹화 중: ${seconds.toFixed(1)}초`,
                `Recording shared screen: ${seconds.toFixed(1)}s`,
            ),
        );
    };

    const supportsRecording =
        Boolean(navigator.mediaDevices?.getDisplayMedia) &&
        typeof MediaRecorder !== "undefined" &&
        window.isSecureContext;
    if (!supportsRecording) {
        recordStart.disabled = true;
        recordStart.title = lt(
            "화면 녹화는 보안이 적용된 localhost 또는 HTTPS 환경의 Chrome이나 Edge에서 사용할 수 있습니다.",
        );
        recorderHelp.textContent = recordStart.title;
        recorderHelp.classList.add("is-error");
    }

    recordStart.onclick = async () => {
        if (!supportsRecording || busy || screenRecorder?.state === "recording")
            return;
        recordStart.disabled = true;
        recordDownload.disabled = true;
        screenBlob = undefined;
        screenChunks = [];
        setStatus(lt("브라우저 화면 공유 권한을 기다리는 중…"));
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: audio.checked,
            });
            if (destroyed) {
                stopScreenTracks();
                return;
            }
            const mimeType = recordingMimeType();
            screenRecorder = new MediaRecorder(
                screenStream,
                mimeType ? { mimeType } : undefined,
            );
            screenRecorder.ondataavailable = (event) => {
                if (event.data.size) screenChunks.push(event.data);
            };
            screenRecorder.onerror = () =>
                report(lt("화면 녹화에 실패했습니다."), true);
            screenRecorder.onstop = () => {
                if (recordingTimer !== undefined)
                    window.clearInterval(recordingTimer);
                recordingTimer = undefined;
                recordingStarted = 0;
                stopScreenTracks();
                recordStart.disabled = false;
                recordStop.disabled = true;
                if (!screenChunks.length) {
                    report(lt("화면 녹화 데이터가 생성되지 않았습니다."), true);
                    return;
                }
                screenBlob = new Blob(screenChunks, {
                    type: screenRecorder?.mimeType || "video/webm",
                });
                recordDownload.disabled = false;
                screenName = lt(
                    `화면-녹화-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
                    `screen-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
                );
                if (destroyed) return;
                void showVideo(screenBlob, screenName, true).catch((error) =>
                    report(errorText(error), true),
                );
            };
            for (const track of screenStream.getVideoTracks())
                track.addEventListener("ended", stopRecording, { once: true });
            screenRecorder.start(500);
            recordingStarted = performance.now();
            recordingTimer = window.setInterval(updateRecordStatus, 250);
            recordStop.disabled = false;
            setStatus(lt("공유 화면 녹화 중: 0.0초"));
        } catch (error) {
            stopScreenTracks();
            recordStart.disabled = false;
            const reason =
                error instanceof DOMException &&
                error.name === "NotAllowedError"
                    ? lt(
                          "화면 공유 권한이 거부되었거나 선택 창이 취소되었습니다.",
                      )
                    : lt(
                          `화면 녹화를 시작할 수 없습니다: ${errorText(error)}`,
                          `Could not start screen recording: ${errorText(error)}`,
                      );
            report(reason, true);
        }
    };

    recordStop.onclick = stopRecording;
    recordDownload.onclick = () => {
        if (screenBlob) downloadBlob(screenBlob, screenName);
    };
    openButton.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (file) void openFile(file).catch(() => undefined);
    };
    cancel.onclick = () => taskAbort?.abort();

    return {
        openFile,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            taskAbort?.abort();
            if (recordingTimer !== undefined)
                window.clearInterval(recordingTimer);
            stopRecording();
            stopScreenTracks();
            closeCurrent();
            root.remove();
        },
    };
}
