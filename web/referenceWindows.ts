import { captureDock } from "../lib/captureControls";
import { createLongPressController } from "../lib/longPress";

export type ReferenceWindowsOptions = {
    process: (
        operation: "cutout" | "ocr",
        dataURL: string,
    ) => Promise<{ dataURL?: string; text?: string }>;
    message: (text: string, error?: boolean) => void;
};

export type ReferenceWindows = {
    open(dataURL: string, name: string): Promise<void>;
    closeAll(): void;
    destroy(): void;
};

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type Card = {
    shell: HTMLElement;
    image: HTMLImageElement;
    toolbar: HTMLElement;
    name: string;
    originalDataURL: string;
    dataURL: string;
    natural: Size;
    initialSize: Size;
    scale: number;
    opacity: number;
    locked: boolean;
    aspectLocked: boolean;
    busy: boolean;
    revision: number;
    closed: boolean;
    history: string[];
    cleanup: Array<() => void>;
    scheduleDock: () => void;
    close: () => void;
};

const MIN_SIZE = 96;
const EDGE_GAP = 12;

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

const icon = (path: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
    );
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
};

const button = (
    label: string,
    path: string,
    testId: string,
    iconOnly = false,
) => {
    const value = element(
        "button",
        `reference-window__button${iconOnly ? " is-icon" : ""}`,
    );
    value.type = "button";
    value.dataset.testid = testId;
    value.setAttribute("aria-label", label);
    value.title = label;
    value.append(icon(path));
    if (!iconOnly)
        value.append(element("span", "reference-window__button-label", label));
    return value;
};

const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));

const pngBlob = async (image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("이미지를 변환할 수 없습니다.");
    context.drawImage(image, 0, 0);
    return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
            (blob) =>
                blob
                    ? resolve(blob)
                    : reject(new Error("PNG 이미지를 만들 수 없습니다.")),
            "image/png",
        ),
    );
};

const waitForImage = (image: HTMLImageElement) =>
    new Promise<void>((resolve, reject) => {
        const loaded = () => {
            cleanup();
            resolve();
        };
        const failed = () => {
            cleanup();
            reject(new Error("이미지를 열 수 없습니다."));
        };
        const cleanup = () => {
            image.removeEventListener("load", loaded);
            image.removeEventListener("error", failed);
        };
        image.addEventListener("load", loaded, { once: true });
        image.addEventListener("error", failed, { once: true });
    });

const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
) => {
    target.addEventListener(type, listener as EventListener, options);
    return () =>
        target.removeEventListener(type, listener as EventListener, options);
};

export function createReferenceWindows(
    parent: HTMLElement,
    options: ReferenceWindowsOptions,
): ReferenceWindows {
    const layer = element("div", "reference-windows");
    layer.dataset.testid = "reference-windows";
    parent.append(layer);
    const cards = new Set<Card>();
    let destroyed = false;
    let zIndex = 0;

    const bringForward = (card: Card) => {
        zIndex += 1;
        card.shell.style.zIndex = String(zIndex);
        card.toolbar.style.zIndex = String(zIndex);
    };

    const closeCard = (card: Card) => {
        if (card.closed) return;
        card.closed = true;
        card.revision += 1;
        for (const cleanup of card.cleanup.splice(0)) cleanup();
        card.shell.remove();
        card.toolbar.remove();
        cards.delete(card);
    };

    const makeCard = async (dataURL: string, name: string) => {
        const shell = element("article", "reference-window");
        shell.dataset.testid = "reference-window";
        shell.setAttribute("aria-label", `${name} 참고창`);
        const header = element("header", "reference-window__header");
        const caption = element(
            "span",
            "reference-window__caption",
            "참고창으로 띄우기",
        );
        caption.title =
            "이 이미지는 브라우저 탭 안에서만 떠 있습니다. 운영체제의 항상 위 창은 아닙니다.";
        const title = element("span", "reference-window__name", name);
        const close = button(
            "참고창 닫기",
            "M6 6l12 12M18 6 6 18",
            "reference-close",
            true,
        );
        header.append(caption, title, close);
        const viewport = element("div", "reference-window__viewport");
        const image = element("img", "reference-window__image");
        image.alt = name;
        image.draggable = false;
        image.src = dataURL;
        viewport.append(image);
        shell.append(header, viewport);

        const toolbar = element("div", "reference-window__toolbar");
        toolbar.dataset.testid = "reference-toolbar";
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", `${name} 참고창 도구`);

        const lock = button(
            "위치 잠금",
            "M7 10V7a5 5 0 0110 0v3m-11 0h12v10H6z",
            "reference-lock",
        );
        lock.setAttribute("aria-pressed", "false");
        const aspect = button(
            "비율 잠금",
            "M9 15l6-6m-8.5 3.5-2 2a3.54 3.54 0 005 5l2-2m1-11 2-2a3.54 3.54 0 015 5l-2 2",
            "reference-aspect",
            true,
        );
        aspect.setAttribute("aria-pressed", "true");
        const undo = button(
            "되돌리기",
            "M9 7H4v-5M4 7l5-5m-5 5h10a6 6 0 010 12h-3",
            "reference-undo",
            true,
        );
        undo.disabled = true;
        const restore = button(
            "원본 복원",
            "M4 4v6h6M20 20v-6h-6M5.6 17.7A8 8 0 0118.3 6M18.4 6.3A8 8 0 015.7 18",
            "reference-restore",
            true,
        );
        const copy = button(
            "PNG 복사",
            "M8 8h11v11H8zM5 16H4V5h11v1",
            "reference-copy",
        );
        const cutout = button(
            "배경 제거",
            "M12 3a9 9 0 100 18 9 9 0 000-18zm0 0v18M3 12h18",
            "reference-cutout",
        );
        const ocr = button(
            "글자 인식",
            "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
            "reference-ocr",
        );
        const cancel = button(
            "작업 취소",
            "M6 6l12 12M18 6 6 18",
            "reference-cancel",
        );
        cancel.hidden = true;

        const controls = element("div", "reference-window__controls");
        const opacityLabel = element("label", "reference-window__field");
        opacityLabel.append(element("span", undefined, "불투명도"));
        const opacity = element("input");
        opacity.type = "range";
        opacity.min = "10";
        opacity.max = "100";
        opacity.value = "100";
        opacity.dataset.testid = "reference-opacity";
        const opacityValue = element("output", undefined, "100%");
        opacityLabel.append(opacity, opacityValue);
        const sizeLabel = element("label", "reference-window__field");
        sizeLabel.append(element("span", undefined, "크기"));
        const size = element("input");
        size.type = "range";
        size.min = "36";
        size.max = "300";
        size.value = "100";
        size.dataset.testid = "reference-size";
        const sizeValue = element("output", undefined, "100%");
        sizeLabel.append(size, sizeValue);
        controls.append(opacityLabel, sizeLabel);

        const textPanel = element("section", "reference-window__text");
        textPanel.hidden = true;
        const textHeading = element("div", "reference-window__text-heading");
        textHeading.append(element("strong", undefined, "인식한 글자"));
        const textClose = button(
            "인식 결과 닫기",
            "M6 6l12 12M18 6 6 18",
            "reference-text-close",
            true,
        );
        textHeading.append(textClose);
        const textOutput = element("textarea", "reference-window__text-output");
        textOutput.readOnly = true;
        textOutput.rows = 5;
        textOutput.setAttribute("aria-label", "인식한 글자 결과");
        textPanel.append(textHeading, textOutput);
        toolbar.append(
            lock,
            aspect,
            undo,
            restore,
            copy,
            cutout,
            ocr,
            cancel,
            controls,
            textPanel,
        );

        await waitForImage(image);
        if (destroyed) return;
        const maxWidth = Math.max(MIN_SIZE, window.innerWidth * 0.58);
        const maxHeight = Math.max(MIN_SIZE, window.innerHeight * 0.58);
        const fit = Math.min(
            1,
            maxWidth / image.naturalWidth,
            maxHeight / image.naturalHeight,
        );
        const initialSize = {
            width: Math.max(MIN_SIZE, Math.round(image.naturalWidth * fit)),
            height: Math.max(MIN_SIZE, Math.round(image.naturalHeight * fit)),
        };
        const offset = cards.size * 28;
        shell.style.width = `${initialSize.width}px`;
        shell.style.height = `${initialSize.height + 40}px`;
        shell.style.left = `${clamp(28 + offset, EDGE_GAP, window.innerWidth - initialSize.width - EDGE_GAP)}px`;
        shell.style.top = `${clamp(28 + offset, EDGE_GAP, window.innerHeight - initialSize.height - 52)}px`;
        layer.append(shell, toolbar);

        let dockFrame = 0;
        const card: Card = {
            shell,
            image,
            toolbar,
            name,
            originalDataURL: dataURL,
            dataURL,
            natural: {
                width: image.naturalWidth,
                height: image.naturalHeight,
            },
            initialSize,
            scale: 1,
            opacity: 1,
            locked: false,
            aspectLocked: true,
            busy: false,
            revision: 0,
            closed: false,
            history: [],
            cleanup: [],
            scheduleDock: () => {
                if (dockFrame || card.closed) return;
                dockFrame = requestAnimationFrame(() => {
                    dockFrame = 0;
                    if (card.closed) return;
                    const availableWidth = Math.max(
                        34,
                        window.innerWidth - EDGE_GAP * 2,
                    );
                    const availableHeight = Math.max(
                        34,
                        window.innerHeight - EDGE_GAP * 2 - 40,
                    );
                    const shrink = Math.min(
                        1,
                        availableWidth / shell.offsetWidth,
                        availableHeight / Math.max(1, shell.offsetHeight - 40),
                    );
                    if (shrink < 1) {
                        shell.style.width = `${shell.offsetWidth * shrink}px`;
                        shell.style.height = `${(shell.offsetHeight - 40) * shrink + 40}px`;
                        card.scale = shell.offsetWidth / initialSize.width;
                        size.min = String(
                            Math.min(36, Math.floor(card.scale * 100)),
                        );
                        size.value = String(Math.round(card.scale * 100));
                        sizeValue.value = `${Math.round(card.scale * 100)}%`;
                    }
                    shell.style.left = `${clamp(shell.offsetLeft, EDGE_GAP, window.innerWidth - shell.offsetWidth - EDGE_GAP)}px`;
                    shell.style.top = `${clamp(shell.offsetTop, EDGE_GAP, window.innerHeight - shell.offsetHeight - EDGE_GAP)}px`;
                    const bounds = shell.getBoundingClientRect();
                    const toolbarBounds = toolbar.getBoundingClientRect();
                    const point = captureDock(
                        {
                            x: bounds.left,
                            y: bounds.top,
                            width: bounds.width,
                            height: bounds.height,
                        },
                        {
                            width: window.innerWidth,
                            height: window.innerHeight,
                        },
                        {
                            width: toolbarBounds.width,
                            height: toolbarBounds.height,
                        },
                    );
                    toolbar.style.left = `${point.x}px`;
                    toolbar.style.top = `${point.y}px`;
                });
            },
            close: () => closeCard(card),
        };
        cards.add(card);
        bringForward(card);

        const setSize = (width: number, height: number) => {
            const minWidth = initialSize.width * 0.36;
            const minHeight = initialSize.height * 0.36 + 40;
            shell.style.width = `${clamp(width, minWidth, initialSize.width * 3)}px`;
            shell.style.height = `${clamp(height, minHeight, initialSize.height * 3 + 40)}px`;
            card.scale = clamp(
                ((shell.offsetWidth / initialSize.width) * 100) / 100,
                0.36,
                3,
            );
            size.value = String(Math.round(card.scale * 100));
            sizeValue.value = `${Math.round(card.scale * 100)}%`;
            card.scheduleDock();
        };

        const setScale = (value: number) => {
            const next = clamp(value, 0.36, 3);
            card.scale = next;
            setSize(initialSize.width * next, initialSize.height * next + 40);
        };

        const setImage = async (next: string, remember = true) => {
            const revision = card.revision;
            const previous = card.dataURL;
            image.src = next;
            try {
                await waitForImage(image);
            } catch (error) {
                image.src = previous;
                throw error;
            }
            if (card.closed) return;
            if (revision !== card.revision) {
                image.src = previous;
                return;
            }
            if (remember && previous !== next) card.history.push(previous);
            card.dataURL = next;
            card.natural = {
                width: image.naturalWidth,
                height: image.naturalHeight,
            };
            undo.disabled = card.history.length === 0;
        };

        const setBusy = (value: boolean) => {
            card.busy = value;
            shell.classList.toggle("is-busy", value);
            toolbar.classList.toggle("is-busy", value);
            cancel.hidden = !value;
            for (const control of [cutout, ocr, copy, restore, undo])
                control.disabled =
                    value || (control === undo && !card.history.length);
        };

        const run = async (operation: "cutout" | "ocr") => {
            if (card.busy || card.closed) return;
            const revision = ++card.revision;
            const input = card.dataURL;
            setBusy(true);
            options.message(
                operation === "cutout"
                    ? "배경을 제거하고 있습니다."
                    : "글자를 인식하고 있습니다.",
            );
            try {
                const result = await options.process(operation, input);
                if (card.closed || revision !== card.revision) return;
                if (operation === "cutout") {
                    if (!result.dataURL)
                        throw new Error("배경 제거 결과가 없습니다.");
                    await setImage(result.dataURL);
                    if (card.closed || revision !== card.revision) return;
                    options.message("배경을 제거했습니다.");
                } else {
                    if (typeof result.text !== "string")
                        throw new Error("글자 인식 결과가 없습니다.");
                    textOutput.value = result.text;
                    textPanel.hidden = false;
                    card.scheduleDock();
                    options.message("글자를 인식했습니다.");
                }
            } catch (error) {
                if (card.closed || revision !== card.revision) return;
                options.message(errorText(error), true);
            } finally {
                if (!card.closed && revision === card.revision) setBusy(false);
            }
        };

        const cancelTask = () => {
            if (!card.busy) return;
            card.revision += 1;
            setBusy(false);
            options.message("작업을 취소했습니다.");
        };

        let stopInteraction = () => {};
        card.cleanup.push(() => stopInteraction());

        const beginMove = (
            event: PointerEvent,
            initialPointer: Point = { x: event.clientX, y: event.clientY },
        ) => {
            if (card.locked) return;
            stopInteraction();
            bringForward(card);
            const bounds = shell.getBoundingClientRect();
            const origin = { x: bounds.left, y: bounds.top };
            const move = (next: PointerEvent) => {
                if (next.pointerId !== event.pointerId || next.buttons !== 1) {
                    finish();
                    return;
                }
                const x = clamp(
                    origin.x + next.clientX - initialPointer.x,
                    EDGE_GAP - shell.offsetWidth + 48,
                    window.innerWidth - 48,
                );
                const y = clamp(
                    origin.y + next.clientY - initialPointer.y,
                    EDGE_GAP,
                    window.innerHeight - 48,
                );
                shell.style.left = `${Math.round(x)}px`;
                shell.style.top = `${Math.round(y)}px`;
                card.scheduleDock();
            };
            const finish = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                shell.classList.remove("is-moving");
                if (stopInteraction === finish) stopInteraction = () => {};
            };
            shell.classList.add("is-moving");
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
            stopInteraction = finish;
        };

        const beginResize = (event: PointerEvent, edge: ResizeEdge) => {
            if (card.locked || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            stopInteraction();
            bringForward(card);
            const bounds = shell.getBoundingClientRect();
            const origin = {
                x: event.clientX,
                y: event.clientY,
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
            };
            const move = (next: PointerEvent) => {
                if (next.pointerId !== event.pointerId || next.buttons !== 1) {
                    finish();
                    return;
                }
                const dx = next.clientX - origin.x;
                const dy = next.clientY - origin.y;
                let width = origin.width + (edge.includes("e") ? dx : 0);
                let height = origin.height + (edge.includes("s") ? dy : 0);
                if (edge.includes("w")) width = origin.width - dx;
                if (edge.includes("n")) height = origin.height - dy;
                if (card.aspectLocked) {
                    const ratio = initialSize.width / initialSize.height;
                    if (edge === "n" || edge === "s")
                        width = Math.max(1, height - 40) * ratio;
                    else height = width / ratio + 40;
                }
                let left = origin.left;
                let top = origin.top;
                if (edge.includes("w"))
                    left = origin.left + origin.width - width;
                if (edge.includes("n"))
                    top = origin.top + origin.height - height;
                shell.style.left = `${Math.round(left)}px`;
                shell.style.top = `${Math.round(top)}px`;
                setSize(width, height);
            };
            const finish = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                shell.classList.remove("is-resizing");
                if (stopInteraction === finish) stopInteraction = () => {};
            };
            shell.classList.add("is-resizing");
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
            stopInteraction = finish;
        };

        for (const edge of [
            "n",
            "ne",
            "e",
            "se",
            "s",
            "sw",
            "w",
            "nw",
        ] as const) {
            const handle = element(
                "span",
                `reference-window__resize is-${edge}`,
            );
            handle.dataset.edge = edge;
            handle.setAttribute("aria-hidden", "true");
            handle.addEventListener("pointerdown", (event) =>
                beginResize(event, edge),
            );
            shell.append(handle);
        }

        const hold = createLongPressController({
            durationMs: 650,
            moveTolerance: 8,
            onHold: () => void run("cutout"),
            onDragStart: (point) =>
                beginMove(
                    new PointerEvent("pointermove", {
                        pointerId: point.pointerId,
                        clientX: point.x + point.dx,
                        clientY: point.y + point.dy,
                        button: 0,
                        buttons: 1,
                    }),
                    { x: point.x, y: point.y },
                ),
        });
        let holdPointer: number | undefined;
        const imageDown = (event: PointerEvent) => {
            if (
                card.locked ||
                card.busy ||
                event.button !== 0 ||
                !event.isPrimary
            ) {
                hold.cancel("disabled");
                return;
            }
            bringForward(card);
            holdPointer = event.pointerId;
            hold.pointerDown({
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
            });
            image.setPointerCapture(event.pointerId);
        };
        const imageMove = (event: PointerEvent) => {
            if (event.pointerId !== holdPointer) return;
            if (event.buttons !== 1) {
                hold.cancel("disabled");
                holdPointer = undefined;
                return;
            }
            hold.pointerMove({
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
            });
        };
        const imageUp = (event: PointerEvent) => {
            hold.pointerUp(event.pointerId);
            if (event.pointerId === holdPointer) holdPointer = undefined;
        };
        const imageCancel = (event: PointerEvent) => {
            hold.pointerCancel(event.pointerId);
            if (event.pointerId === holdPointer) holdPointer = undefined;
        };
        const contextMenu = (event: MouseEvent) => {
            hold.cancel("disabled");
            holdPointer = undefined;
            event.preventDefault();
        };

        card.cleanup.push(
            () => hold.cancel("manual"),
            listen(shell, "pointerdown", () => bringForward(card)),
            listen(header, "pointerdown", (event) => {
                if (
                    event.button === 0 &&
                    !(event.target as Element).closest("button")
                )
                    beginMove(event);
            }),
            listen(image, "pointerdown", imageDown),
            listen(image, "pointermove", imageMove),
            listen(image, "pointerup", imageUp),
            listen(image, "pointercancel", imageCancel),
            listen(image, "contextmenu", contextMenu),
            listen(
                image,
                "wheel",
                (event) => {
                    if (card.locked) return;
                    event.preventDefault();
                    setScale(card.scale * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
                },
                { passive: false },
            ),
            listen(window, "resize", () => card.scheduleDock()),
            listen(window, "keydown", (event) => {
                if (event.key === "Escape") hold.cancel("escape");
            }),
            listen(window, "blur", () => hold.cancel("blur")),
        );

        const observer = new ResizeObserver(() => card.scheduleDock());
        observer.observe(shell);
        observer.observe(toolbar);
        card.cleanup.push(() => observer.disconnect());

        close.onclick = card.close;
        lock.onclick = () => {
            card.locked = !card.locked;
            shell.classList.toggle("is-locked", card.locked);
            lock.classList.toggle("is-active", card.locked);
            lock.setAttribute("aria-pressed", String(card.locked));
            lock.querySelector(".reference-window__button-label")!.textContent =
                card.locked ? "위치 잠금 해제" : "위치 잠금";
            lock.setAttribute(
                "aria-label",
                card.locked ? "위치 잠금 해제" : "위치 잠금",
            );
            hold.cancel("disabled");
            if (card.locked) stopInteraction();
        };
        aspect.onclick = () => {
            card.aspectLocked = !card.aspectLocked;
            aspect.classList.toggle("is-active", card.aspectLocked);
            aspect.setAttribute("aria-pressed", String(card.aspectLocked));
        };
        aspect.classList.add("is-active");
        undo.onclick = () => {
            const previous = card.history.pop();
            if (!previous) return;
            void setImage(previous, false)
                .then(() => {
                    undo.disabled = card.history.length === 0;
                    options.message("이전 이미지로 되돌렸습니다.");
                })
                .catch((error) => {
                    card.history.push(previous);
                    options.message(errorText(error), true);
                });
        };
        restore.onclick = () => {
            if (card.dataURL === card.originalDataURL) return;
            void setImage(card.originalDataURL)
                .then(() => options.message("원본 이미지를 복원했습니다."))
                .catch((error) => options.message(errorText(error), true));
        };
        copy.onclick = () => {
            void (async () => {
                try {
                    if (
                        !navigator.clipboard ||
                        typeof ClipboardItem === "undefined"
                    )
                        throw new Error(
                            "이 브라우저에서는 이미지 복사를 지원하지 않습니다.",
                        );
                    await navigator.clipboard.write([
                        new ClipboardItem({ "image/png": pngBlob(image) }),
                    ]);
                    options.message("PNG 이미지를 복사했습니다.");
                } catch (error) {
                    options.message(errorText(error), true);
                }
            })();
        };
        cutout.onclick = () => void run("cutout");
        ocr.onclick = () => void run("ocr");
        cancel.onclick = cancelTask;
        textClose.onclick = () => {
            textPanel.hidden = true;
            card.scheduleDock();
        };
        opacity.oninput = () => {
            card.opacity = Number(opacity.value) / 100;
            image.style.opacity = String(card.opacity);
            opacityValue.value = `${opacity.value}%`;
        };
        size.oninput = () => setScale(Number(size.value) / 100);
        card.scheduleDock();
    };

    return {
        async open(dataURL, name) {
            if (destroyed) throw new Error("참고창이 이미 종료되었습니다.");
            if (!dataURL.startsWith("data:image/"))
                throw new Error("이미지 데이터만 참고창으로 열 수 있습니다.");
            await makeCard(dataURL, name || "이미지");
        },
        closeAll() {
            for (const card of [...cards]) card.close();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const card of [...cards]) card.close();
            layer.remove();
        },
    };
}
