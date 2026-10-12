import { captureDock, fitCaptureToolbar } from "../lib/captureControls";

export type CaptureLabOptions = {
    onImage: (dataURL: string, name: string) => Promise<unknown>;
    onFloat: (dataURL: string, name: string) => void;
    onProcess: (
        operation: "ocr" | "cutout" | "color",
        dataURL: string,
    ) => Promise<unknown>;
    message: (text: string, error?: boolean) => void;
};

export type CaptureLab = {
    setSource(dataURL: string, name: string, mode?: "capture" | "crop"): void;
    destroy(): void;
};

type Rect = { x: number; y: number; width: number; height: number };
type Action = {
    id: string;
    label: string;
    icon: string;
};

const actions: Action[] = [
    { id: "copy", label: "PNG 복사", icon: "copy" },
    { id: "edit", label: "편집", icon: "edit" },
    { id: "save", label: "저장", icon: "save" },
    { id: "float", label: "레퍼런스 띄우기", icon: "float" },
    { id: "ocr", label: "텍스트 인식", icon: "ocr" },
    { id: "cutout", label: "배경 제거", icon: "cutout" },
    { id: "color", label: "색상 추출", icon: "color" },
];

const iconPaths: Record<string, string> = {
    copy: '<rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
    edit: '<path d="m3 14 9-9 3 3-9 9-4 1 1-4Zm9-9 2-2a2 2 0 0 1 3 3l-2 2"/>',
    save: '<path d="M10 2v10m-4-4 4 4 4-4M3 13v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
    float: '<path d="M10 2v16M2 10h16"/><circle cx="10" cy="10" r="5"/>',
    ocr: '<path d="M4 3H2v4m14-4h2v4M2 13v4h4m12-4v4h-4M6 6h8M10 6v8m-3 0h6"/>',
    cutout: '<path d="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3z"/><path d="M12 12h5v5h-5z" stroke-dasharray="2 2"/>',
    color: '<path d="m5 15 8-8 2 2-8 8H3v-4l2 2ZM12 4l4 4m-2-5a2 2 0 0 1 3 3l-2 2-3-3 2-2Z"/>',
    more: '<circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="10" r="1" fill="currentColor"/><circle cx="16" cy="10" r="1" fill="currentColor"/>',
    close: '<path d="m5 5 10 10M15 5 5 15"/>',
};

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

const icon = (name: string) =>
    `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] ?? iconPaths.more}</svg>`;

const actionButton = (action: Action, labelled = false) => {
    const node = element("button", "capture-lab__tool");
    node.type = "button";
    node.dataset.action = action.id;
    node.title = action.label;
    node.setAttribute("aria-label", action.label);
    node.innerHTML = `${icon(action.icon)}${labelled ? `<span>${action.label}</span>` : ""}`;
    return node;
};

const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));

const stem = (name: string) => name.replace(/\.[^.]+$/, "") || "capture";

const dataURLToBlob = async (dataURL: string) => (await fetch(dataURL)).blob();

const waitForVideo = (video: HTMLVideoElement) =>
    new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
            () =>
                finish(
                    new Error(
                        "공유 화면에서 시간 안에 이미지를 가져오지 못했습니다.",
                    ),
                ),
            10_000,
        );
        const finish = (error?: Error) => {
            window.clearTimeout(timeout);
            video.onloadedmetadata = null;
            video.onerror = null;
            error ? reject(error) : resolve();
        };
        video.onloadedmetadata = () => finish();
        video.onerror = () =>
            finish(new Error("공유 화면을 읽을 수 없습니다."));
    });

function drawSample(kind: "page" | "window" | "scroll") {
    const canvas = document.createElement("canvas");
    canvas.width = kind === "window" ? 1120 : 1440;
    canvas.height = kind === "scroll" ? 1800 : kind === "window" ? 760 : 900;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#eef2f7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#172033";
    context.fillRect(0, 0, canvas.width, 76);
    context.fillStyle = "#ffffff";
    context.font = "700 28px system-ui";
    context.fillText(
        kind === "window" ? "창 화면 — 샘플" : "Atlas 작업 공간 — 샘플",
        42,
        48,
    );
    const sections = kind === "scroll" ? 5 : 2;
    for (let index = 0; index < sections; index++) {
        const top = 116 + index * 320;
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.roundRect(42, top, canvas.width - 84, 270, 18);
        context.fill();
        context.fillStyle = index % 2 ? "#6d5dfc" : "#1677ff";
        context.fillRect(76, top + 42, 180, 150);
        context.fillStyle = "#182234";
        context.font = "700 30px system-ui";
        context.fillText(
            index === 0 ? "일관된 캡처 테스트 영역" : `샘플 영역 ${index + 1}`,
            292,
            top + 72,
        );
        context.fillStyle = "#596579";
        context.font = "20px system-ui";
        context.fillText(
            "OCR과 자르기를 확인할 수 있는 선명한 글자와 색상입니다.",
            292,
            top + 116,
        );
        for (let chip = 0; chip < 4; chip++) {
            context.fillStyle = ["#ff5d73", "#ffb020", "#22b573", "#7357ff"][
                chip
            ];
            context.beginPath();
            context.roundRect(292 + chip * 116, top + 156, 92, 44, 12);
            context.fill();
        }
    }
    return canvas;
}

export function createCaptureLab(
    parent: HTMLElement,
    options: CaptureLabOptions,
): CaptureLab {
    const root = element("section", "capture-lab");
    root.dataset.testid = "capture-lab";
    root.tabIndex = 0;

    const heading = element("header", "capture-lab__heading");
    const headingCopy = element("div");
    const title = element("h2", "capture-lab__title", "캡처 실험실");
    const subtitle = element(
        "p",
        "capture-lab__subtitle",
        "표시된 샘플로 연습하거나 브라우저에서 화면 또는 창을 직접 공유하세요.",
    );
    headingCopy.append(title, subtitle);
    const sourceActions = element("div", "capture-lab__source-actions");
    const sourceButtons = [
        ["share-screen", "화면 또는 창 공유"],
        ["timer", "3초 후 캡처"],
        ["window-sample", "창 샘플"],
        ["scroll-sample", "스크롤 샘플"],
        ["previous", "이전 소스"],
    ];
    for (const [id, label] of sourceButtons) {
        const node = element(
            "button",
            "capture-lab__button is-secondary",
            label,
        );
        node.type = "button";
        node.dataset.action = id;
        sourceActions.append(node);
    }
    heading.append(headingCopy, sourceActions);

    const sourceStatus = element("p", "capture-lab__source-status");
    sourceStatus.setAttribute("role", "status");
    sourceStatus.setAttribute("aria-live", "polite");

    const stage = element("div", "capture-lab__stage");
    stage.dataset.testid = "capture-stage";
    const canvas = element("canvas", "capture-lab__canvas");
    const selection = element("div", "capture-lab__selection");
    selection.tabIndex = 0;
    selection.setAttribute("aria-label", "선택한 캡처 영역");
    const handleLabels: Record<string, string> = {
        nw: "왼쪽 위",
        n: "위",
        ne: "오른쪽 위",
        e: "오른쪽",
        se: "오른쪽 아래",
        s: "아래",
        sw: "왼쪽 아래",
        w: "왼쪽",
    };
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const node = element("button", `capture-lab__handle is-${handle}`);
        node.type = "button";
        node.dataset.handle = handle;
        node.setAttribute(
            "aria-label",
            `선택 영역 ${handleLabels[handle]} 크기 조절`,
        );
        selection.append(node);
    }

    const dimensions = element("div", "capture-lab__dimensions");
    const widthInput = element("input");
    widthInput.type = "number";
    widthInput.min = "1";
    widthInput.dataset.dimension = "width";
    widthInput.setAttribute("aria-label", "선택 영역 너비");
    const heightInput = element("input");
    heightInput.type = "number";
    heightInput.min = "1";
    heightInput.dataset.dimension = "height";
    heightInput.setAttribute("aria-label", "선택 영역 높이");
    const lock = element("input");
    lock.type = "checkbox";
    lock.dataset.action = "ratio-lock";
    lock.setAttribute("aria-label", "선택 영역 비율 고정");
    const lockLabel = element("label", "capture-lab__ratio", "비율 고정");
    lockLabel.prepend(lock);
    dimensions.append(
        element("span", undefined, "너비"),
        widthInput,
        element("span", undefined, "높이"),
        heightInput,
        lockLabel,
    );

    const toolbar = element("div", "capture-lab__toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "캡처 작업");
    const more = element("div", "capture-lab__more");
    more.hidden = true;
    more.setAttribute("role", "group");
    more.setAttribute("aria-label", "추가 캡처 작업");
    const radial = element("div", "capture-lab__radial");
    radial.hidden = true;
    radial.setAttribute("role", "menu");
    radial.setAttribute("aria-label", "빠른 캡처 작업");
    const countdown = element("div", "capture-lab__countdown");
    countdown.hidden = true;
    const countdownValue = element("strong", undefined, "3");
    const cancelTimer = element("button", "capture-lab__button", "취소");
    cancelTimer.type = "button";
    cancelTimer.dataset.action = "cancel-timer";
    countdown.append(
        element("span", undefined, "공유 시작까지"),
        countdownValue,
        cancelTimer,
    );
    stage.append(
        canvas,
        selection,
        dimensions,
        toolbar,
        more,
        radial,
        countdown,
    );
    root.append(heading, sourceStatus, stage);
    parent.append(root);

    const sourceCanvas = document.createElement("canvas");
    let sourceName = "샘플-페이지.png";
    let sourceMode: "capture" | "crop" = "capture";
    let sourceIsSample = true;
    let selectionRect: Rect = { x: 120, y: 110, width: 820, height: 520 };
    let aspectRatio = selectionRect.width / selectionRect.height;
    let previousSource:
        | {
              dataURL: string;
              name: string;
              mode: "capture" | "crop";
              sample: boolean;
          }
        | undefined;
    let loadSequence = 0;
    let destroyed = false;
    let timer: number | undefined;
    let countdownTick: number | undefined;
    let activeStream: MediaStream | undefined;
    let pickerActive = false;
    let visibleActions: Action[] = [];
    let fixedToolbarWidth = 0;
    let toolSize = 40;
    const disposers: Array<() => void> = [];

    const listen = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement | Window,
        type: K,
        listener: (event: HTMLElementEventMap[K]) => void,
    ) => {
        target.addEventListener(type, listener as EventListener);
        disposers.push(() =>
            target.removeEventListener(type, listener as EventListener),
        );
    };

    const reportError = (error: unknown) =>
        options.message(
            error instanceof Error ? error.message : String(error),
            true,
        );

    const canvasPoint = (event: { clientX: number; clientY: number }) => {
        const bounds = canvas.getBoundingClientRect();
        return {
            x: clamp(
                ((event.clientX - bounds.left) / bounds.width) *
                    sourceCanvas.width,
                0,
                sourceCanvas.width,
            ),
            y: clamp(
                ((event.clientY - bounds.top) / bounds.height) *
                    sourceCanvas.height,
                0,
                sourceCanvas.height,
            ),
        };
    };

    const cancelCountdown = (announce = false) => {
        if (timer !== undefined) window.clearTimeout(timer);
        if (countdownTick !== undefined) window.clearInterval(countdownTick);
        timer = undefined;
        countdownTick = undefined;
        countdown.hidden = true;
        if (announce) options.message("예약 캡처를 취소했습니다.");
    };

    const selectedDataURL = () => {
        const result = document.createElement("canvas");
        result.width = Math.max(1, Math.round(selectionRect.width));
        result.height = Math.max(1, Math.round(selectionRect.height));
        result
            .getContext("2d")!
            .drawImage(
                sourceCanvas,
                Math.round(selectionRect.x),
                Math.round(selectionRect.y),
                result.width,
                result.height,
                0,
                0,
                result.width,
                result.height,
            );
        return result.toDataURL("image/png");
    };

    const positionPopover = () => {
        if (more.hidden) return;
        const toolbarBounds = toolbar.getBoundingClientRect();
        const stageBounds = stage.getBoundingClientRect();
        const width = more.offsetWidth;
        const height = more.offsetHeight;
        const left = clamp(
            toolbarBounds.left - stageBounds.left,
            12,
            stage.clientWidth - width - 12,
        );
        const below = toolbarBounds.bottom - stageBounds.top + 8;
        more.style.left = `${left}px`;
        more.style.top = `${below + height <= stage.clientHeight - 12 ? below : Math.max(12, toolbarBounds.top - stageBounds.top - height - 8)}px`;
    };

    const renderMore = (overflow: readonly Action[]) => {
        more.replaceChildren();
        const available = [
            ...overflow,
            ...actions.filter((item) => !overflow.includes(item)),
        ];
        for (const action of available) more.append(actionButton(action, true));
        const sizeLabel = element(
            "label",
            "capture-lab__size",
            `도구 크기 ${toolSize}px`,
        );
        const size = element("input");
        size.type = "range";
        size.min = "36";
        size.max = "44";
        size.step = "2";
        size.value = String(toolSize);
        size.dataset.action = "tool-size";
        size.setAttribute("aria-label", "도구 모음 버튼 크기");
        sizeLabel.append(size);
        more.append(sizeLabel);
    };

    const renderToolbar = (items: readonly Action[]) => {
        toolbar.replaceChildren();
        for (const action of items) {
            const node = actionButton(action);
            node.dataset.favorite = "";
            toolbar.append(node);
        }
        toolbar.append(element("span", "capture-lab__divider"));
        toolbar.append(
            actionButton({ id: "more", label: "더보기", icon: "more" }),
            actionButton({
                id: "close",
                label: "선택 영역 초기화",
                icon: "close",
            }),
        );
    };

    const fitToolbar = (remeasure = false) => {
        if (remeasure || !fixedToolbarWidth) {
            visibleActions = [];
            renderToolbar(visibleActions);
            fixedToolbarWidth = toolbar.getBoundingClientRect().width;
        }
        const style = getComputedStyle(toolbar);
        const gap = Number.parseFloat(style.columnGap) || 0;
        const favoriteWidth = Math.max(40, toolSize);
        const fit = fitCaptureToolbar(actions, {
            viewportWidth: stage.clientWidth,
            favoriteWidth,
            fixedWidth: fixedToolbarWidth,
            gap,
        });
        if (
            fit.visible.length !== visibleActions.length ||
            fit.visible.some((item, index) => item !== visibleActions[index])
        ) {
            visibleActions = fit.visible;
            renderToolbar(visibleActions);
        }
        renderMore(fit.overflow);
    };

    const updateLayout = () => {
        if (!sourceCanvas.width) return;
        const left = (selectionRect.x / sourceCanvas.width) * 100;
        const top = (selectionRect.y / sourceCanvas.height) * 100;
        const width = (selectionRect.width / sourceCanvas.width) * 100;
        const height = (selectionRect.height / sourceCanvas.height) * 100;
        selection.style.left = `${left}%`;
        selection.style.top = `${top}%`;
        selection.style.width = `${width}%`;
        selection.style.height = `${height}%`;
        widthInput.value = String(Math.round(selectionRect.width));
        heightInput.value = String(Math.round(selectionRect.height));
        const selectionBounds = selection.getBoundingClientRect();
        const stageBounds = stage.getBoundingClientRect();
        const dock = captureDock(
            {
                x: selectionBounds.left - stageBounds.left,
                y: selectionBounds.top - stageBounds.top,
                width: selectionBounds.width,
                height: selectionBounds.height,
            },
            { width: stage.clientWidth, height: stage.clientHeight },
            { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
        );
        toolbar.style.left = `${dock.x}px`;
        toolbar.style.top = `${dock.y}px`;
        dimensions.style.left = `${clamp(selectionBounds.left - stageBounds.left, 12, stage.clientWidth - dimensions.offsetWidth - 12)}px`;
        dimensions.style.top = `${clamp(selectionBounds.top - stageBounds.top - dimensions.offsetHeight - 8, 12, stage.clientHeight - dimensions.offsetHeight - 12)}px`;
        positionPopover();
    };

    const drawSource = () => {
        canvas.width = sourceCanvas.width;
        canvas.height = sourceCanvas.height;
        canvas.getContext("2d")!.drawImage(sourceCanvas, 0, 0);
        sourceStatus.textContent = `${sourceIsSample ? "샘플 소스" : "공유 소스"} · ${sourceName} · ${sourceCanvas.width} × ${sourceCanvas.height}`;
        sourceStatus.classList.toggle("is-sample", sourceIsSample);
        requestAnimationFrame(() => {
            fitToolbar();
            updateLayout();
        });
    };

    const applyCanvas = (
        next: HTMLCanvasElement,
        name: string,
        mode: "capture" | "crop",
        sample: boolean,
        remember = true,
    ) => {
        if (remember && sourceCanvas.width)
            previousSource = {
                dataURL: sourceCanvas.toDataURL("image/png"),
                name: sourceName,
                mode: sourceMode,
                sample: sourceIsSample,
            };
        sourceCanvas.width = next.width;
        sourceCanvas.height = next.height;
        sourceCanvas.getContext("2d")!.drawImage(next, 0, 0);
        sourceName = name;
        sourceMode = mode;
        sourceIsSample = sample;
        const inset =
            mode === "crop"
                ? 0
                : Math.round(Math.min(next.width, next.height) * 0.08);
        selectionRect = {
            x: inset,
            y: inset,
            width: Math.max(1, next.width - inset * 2),
            height: Math.max(1, next.height - inset * 2),
        };
        aspectRatio = selectionRect.width / selectionRect.height;
        cancelCountdown();
        pickerActive = false;
        drawSource();
    };

    const setSource = (
        dataURL: string,
        name: string,
        mode: "capture" | "crop" = "capture",
    ) => {
        const sequence = ++loadSequence;
        const image = new Image();
        image.onload = () => {
            if (destroyed || sequence !== loadSequence) return;
            const next = document.createElement("canvas");
            next.width = image.naturalWidth;
            next.height = image.naturalHeight;
            next.getContext("2d")!.drawImage(image, 0, 0);
            applyCanvas(next, name, mode, false);
        };
        image.onerror = () => {
            if (sequence === loadSequence)
                options.message("캡처 소스를 불러올 수 없습니다.", true);
        };
        image.src = dataURL;
    };

    const captureSharedScreen = async () => {
        if (!navigator.mediaDevices?.getDisplayMedia)
            throw new Error("이 브라우저는 화면 공유를 지원하지 않습니다.");
        activeStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
        });
        if (destroyed) {
            for (const track of activeStream.getTracks()) track.stop();
            activeStream = undefined;
            return;
        }
        const video = document.createElement("video");
        try {
            video.srcObject = activeStream;
            await waitForVideo(video);
            await video.play();
            const next = document.createElement("canvas");
            next.width = video.videoWidth;
            next.height = video.videoHeight;
            next.getContext("2d")!.drawImage(video, 0, 0);
            applyCanvas(next, "공유-화면.png", "capture", false);
            options.message("공유한 소스에서 화면 한 장을 캡처했습니다.");
        } finally {
            if (activeStream)
                for (const track of activeStream.getTracks()) track.stop();
            activeStream = undefined;
            video.srcObject = null;
        }
    };

    const runAction = async (id: string) => {
        const moreWasHidden = more.hidden;
        more.hidden = true;
        radial.hidden = true;
        if (id === "more") {
            more.hidden = !moreWasHidden;
            positionPopover();
            return;
        }
        if (id === "close") {
            selectionRect = {
                x: 0,
                y: 0,
                width: sourceCanvas.width,
                height: sourceCanvas.height,
            };
            aspectRatio = selectionRect.width / selectionRect.height;
            updateLayout();
            return;
        }
        if (id === "share-screen") {
            cancelCountdown();
            await captureSharedScreen();
            return;
        }
        if (id === "timer") {
            cancelCountdown();
            let remaining = 3;
            countdownValue.textContent = String(remaining);
            countdown.hidden = false;
            countdownTick = window.setInterval(() => {
                remaining -= 1;
                countdownValue.textContent = String(Math.max(0, remaining));
            }, 1000);
            timer = window.setTimeout(() => {
                cancelCountdown();
                void captureSharedScreen().catch(reportError);
            }, 3000);
            return;
        }
        if (id === "cancel-timer") {
            cancelCountdown(true);
            return;
        }
        if (id === "window-sample" || id === "scroll-sample") {
            const kind = id === "window-sample" ? "window" : "scroll";
            applyCanvas(
                drawSample(kind),
                kind === "window" ? "창-샘플.png" : "스크롤-샘플.png",
                "capture",
                true,
            );
            options.message(
                `${kind === "window" ? "창" : "스크롤"} 샘플을 불러왔습니다.`,
            );
            return;
        }
        if (id === "previous") {
            if (!previousSource) {
                options.message("아직 이전 소스가 없습니다.", true);
                return;
            }
            const previous = previousSource;
            const image = new Image();
            image.onload = () => {
                const next = document.createElement("canvas");
                next.width = image.naturalWidth;
                next.height = image.naturalHeight;
                next.getContext("2d")!.drawImage(image, 0, 0);
                applyCanvas(
                    next,
                    previous.name,
                    previous.mode,
                    previous.sample,
                );
            };
            image.src = previous.dataURL;
            return;
        }
        const dataURL = selectedDataURL();
        const name = `${stem(sourceName)}-선택.png`;
        if (id === "copy") {
            if (
                !navigator.clipboard?.write ||
                typeof ClipboardItem === "undefined"
            )
                throw new Error(
                    "이 브라우저는 PNG 클립보드 복사를 지원하지 않습니다.",
                );
            await navigator.clipboard.write([
                new ClipboardItem({ "image/png": dataURLToBlob(dataURL) }),
            ]);
            options.message("선택 영역의 PNG를 클립보드에 복사했습니다.");
        } else if (id === "edit" || id === "save") {
            await options.onImage(
                dataURL,
                id === "edit" ? `${stem(name)}-편집.png` : name,
            );
        } else if (id === "float") {
            options.onFloat(dataURL, name);
        } else if (id === "color") {
            await options.onProcess("color", dataURL);
            pickerActive = true;
            root.classList.add("is-picking-color");
            options.message("소스의 픽셀을 클릭하면 HEX 색상을 복사합니다.");
        } else if (id === "ocr" || id === "cutout") {
            await options.onProcess(id, dataURL);
        }
    };

    const beginDrag = (event: PointerEvent) => {
        if (pickerActive) return;
        const eventTarget = event.target as HTMLElement;
        const handle =
            eventTarget.closest<HTMLElement>("[data-handle]")?.dataset.handle;
        if (
            event.button !== 0 ||
            (!handle && eventTarget.closest("button,input,label"))
        )
            return;
        cancelCountdown();
        const start = canvasPoint(event);
        const original = { ...selectionRect };
        const inside =
            start.x >= original.x &&
            start.x <= original.x + original.width &&
            start.y >= original.y &&
            start.y <= original.y + original.height;
        stage.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
            const point = canvasPoint(moveEvent);
            const dx = point.x - start.x;
            const dy = point.y - start.y;
            if (handle) {
                let left = original.x;
                let top = original.y;
                let right = original.x + original.width;
                let bottom = original.y + original.height;
                if (handle.includes("w")) left = point.x;
                if (handle.includes("e")) right = point.x;
                if (handle.includes("n")) top = point.y;
                if (handle.includes("s")) bottom = point.y;
                const next = {
                    x: clamp(Math.min(left, right), 0, sourceCanvas.width - 1),
                    y: clamp(Math.min(top, bottom), 0, sourceCanvas.height - 1),
                    width: Math.max(1, Math.abs(right - left)),
                    height: Math.max(1, Math.abs(bottom - top)),
                };
                if (lock.checked) {
                    if (handle === "n" || handle === "s")
                        next.width = next.height * aspectRatio;
                    else next.height = next.width / aspectRatio;
                    if (handle.includes("w"))
                        next.x = original.x + original.width - next.width;
                    else if (!handle.includes("e"))
                        next.x =
                            original.x + original.width / 2 - next.width / 2;
                    if (handle.includes("n"))
                        next.y = original.y + original.height - next.height;
                    else if (!handle.includes("s"))
                        next.y =
                            original.y + original.height / 2 - next.height / 2;
                }
                next.x = clamp(next.x, 0, sourceCanvas.width - 1);
                next.y = clamp(next.y, 0, sourceCanvas.height - 1);
                next.width = Math.min(next.width, sourceCanvas.width - next.x);
                next.height = Math.min(
                    next.height,
                    sourceCanvas.height - next.y,
                );
                selectionRect = next;
            } else if (inside) {
                selectionRect.x = clamp(
                    original.x + dx,
                    0,
                    sourceCanvas.width - original.width,
                );
                selectionRect.y = clamp(
                    original.y + dy,
                    0,
                    sourceCanvas.height - original.height,
                );
            } else {
                selectionRect = {
                    x: Math.min(start.x, point.x),
                    y: Math.min(start.y, point.y),
                    width: Math.max(1, Math.abs(point.x - start.x)),
                    height: Math.max(1, Math.abs(point.y - start.y)),
                };
            }
            if (!lock.checked)
                aspectRatio = selectionRect.width / selectionRect.height;
            updateLayout();
        };
        const end = () => {
            stage.removeEventListener("pointermove", move);
            stage.removeEventListener("pointerup", end);
            stage.removeEventListener("pointercancel", end);
        };
        stage.addEventListener("pointermove", move);
        stage.addEventListener("pointerup", end);
        stage.addEventListener("pointercancel", end);
    };

    listen(stage, "pointerdown", beginDrag);
    listen(root, "pointerdown", (event) => {
        const target = event.target as Node;
        if (!more.contains(target) && !toolbar.contains(target))
            more.hidden = true;
        if (!radial.contains(target)) radial.hidden = true;
    });
    listen(root, "click", (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-action]",
        );
        if (!target || target instanceof HTMLInputElement) return;
        void runAction(target.dataset.action ?? "").catch(reportError);
    });
    listen(root, "input", (event) => {
        const input = event.target as HTMLInputElement;
        if (input.dataset.action === "tool-size") {
            toolSize = Number(input.value);
            root.style.setProperty("--capture-lab-tool-size", `${toolSize}px`);
            fitToolbar(true);
            updateLayout();
            return;
        }
        const dimension = input.dataset.dimension as
            | "width"
            | "height"
            | undefined;
        if (!dimension) return;
        cancelCountdown();
        const value = Math.max(1, Number(input.value));
        if (dimension === "width") {
            selectionRect.width = Math.min(
                value,
                sourceCanvas.width - selectionRect.x,
            );
            if (lock.checked)
                selectionRect.height = Math.min(
                    selectionRect.width / aspectRatio,
                    sourceCanvas.height - selectionRect.y,
                );
        } else {
            selectionRect.height = Math.min(
                value,
                sourceCanvas.height - selectionRect.y,
            );
            if (lock.checked)
                selectionRect.width = Math.min(
                    selectionRect.height * aspectRatio,
                    sourceCanvas.width - selectionRect.x,
                );
        }
        updateLayout();
    });
    listen(root, "keydown", (event) => {
        const key = event.key.toLowerCase();
        const directions: Record<string, [number, number]> = {
            arrowleft: [-1, 0],
            a: [-1, 0],
            arrowright: [1, 0],
            d: [1, 0],
            arrowup: [0, -1],
            w: [0, -1],
            arrowdown: [0, 1],
            s: [0, 1],
        };
        const direction = directions[key];
        if (!direction || (event.target as HTMLElement).matches("input"))
            return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        selectionRect.x = clamp(
            selectionRect.x + direction[0] * step,
            0,
            sourceCanvas.width - selectionRect.width,
        );
        selectionRect.y = clamp(
            selectionRect.y + direction[1] * step,
            0,
            sourceCanvas.height - selectionRect.height,
        );
        updateLayout();
    });
    listen(canvas, "click", (event) => {
        if (!pickerActive) return;
        const point = canvasPoint(event);
        const pixel = sourceCanvas
            .getContext("2d")!
            .getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data;
        const hex = `#${[pixel[0], pixel[1], pixel[2]]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("")}`.toUpperCase();
        pickerActive = false;
        root.classList.remove("is-picking-color");
        void navigator.clipboard
            .writeText(hex)
            .then(
                () => options.message(`${hex} 색상을 클립보드에 복사했습니다.`),
                reportError,
            );
    });
    listen(stage, "contextmenu", (event) => {
        event.preventDefault();
        radial.replaceChildren();
        for (const [index, action] of actions.slice(0, 6).entries()) {
            const node = actionButton(action);
            node.setAttribute("role", "menuitem");
            node.style.setProperty("--radial-index", String(index));
            radial.append(node);
        }
        radial.hidden = false;
        const stageBounds = stage.getBoundingClientRect();
        radial.style.left = `${clamp(event.clientX - stageBounds.left, 84, stage.clientWidth - 84)}px`;
        radial.style.top = `${clamp(event.clientY - stageBounds.top, 84, stage.clientHeight - 84)}px`;
    });
    listen(window, "resize", () => {
        fitToolbar();
        updateLayout();
    });

    const observer = new ResizeObserver(() => {
        fitToolbar();
        updateLayout();
    });
    observer.observe(stage);
    observer.observe(toolbar);
    disposers.push(() => observer.disconnect());

    root.style.setProperty("--capture-lab-tool-size", `${toolSize}px`);
    renderToolbar([]);
    fitToolbar(true);
    applyCanvas(drawSample("page"), "샘플-페이지.png", "capture", true, false);

    return {
        setSource,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            loadSequence += 1;
            cancelCountdown();
            if (activeStream)
                for (const track of activeStream.getTracks()) track.stop();
            for (const dispose of disposers) dispose();
            root.remove();
        },
    };
}
