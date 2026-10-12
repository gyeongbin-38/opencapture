import {
    type LongPressCancelReason,
    createLongPressController,
} from "../../../lib/longPress";

export type ImageHoldContext = {
    event: PointerEvent;
    x: number;
    y: number;
    pointerId: number;
};

export type ImageHoldOptions = {
    durationMs?: number;
    moveTolerance?: number;
    disabled?: (event: PointerEvent) => boolean;
    onHold: (context: ImageHoldContext) => void | Promise<void>;
    onDragStart?: (
        context: ImageHoldContext & { dx: number; dy: number },
    ) => void;
    onCancel?: (reason: LongPressCancelReason) => void;
    onError?: (error: unknown) => void;
    progressLabel?: string;
};

export type ImageHoldHandle = {
    cancel(reason?: LongPressCancelReason): void;
    dispose(): void;
    setBusy(busy: boolean): void;
};

const excludedTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(
        target.closest(
            "button,input,textarea,select,a,[contenteditable=true],[data-no-image-hold],.pin-toolbar,.pin-radial-menu,.pin-controls-panel,canvas",
        ),
    );

export function createImageHold(
    target: HTMLElement,
    options: ImageHoldOptions,
): ImageHoldHandle {
    target.dataset.imageHold = "true";
    const indicator = document.createElement("span");
    indicator.className = "image-hold-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.title = options.progressLabel ?? "길게 눌러 배경 제거";
    target.parentElement?.appendChild(indicator);
    let startEvent: PointerEvent | null = null;
    let frame = 0;
    let suppressClick = false;

    const stopProgress = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        indicator.classList.remove("is-pressing");
        indicator.style.removeProperty("--image-hold-progress");
    };
    const drawProgress = () => {
        const reducedMotion =
            document.body.classList.contains("pin-motion-reduced") ||
            (!document.body.classList.contains("pin-motion-full") &&
                matchMedia("(prefers-reduced-motion: reduce)").matches);
        if (reducedMotion) {
            indicator.style.setProperty("--image-hold-progress", "360deg");
            return;
        }
        indicator.style.setProperty(
            "--image-hold-progress",
            `${Math.round(controller.progress() * 360)}deg`,
        );
        if (controller.state() === "pressing")
            frame = requestAnimationFrame(drawProgress);
    };
    const controller = createLongPressController({
        durationMs: options.durationMs,
        moveTolerance: options.moveTolerance,
        onHold: async (point) => {
            stopProgress();
            suppressClick = true;
            indicator.classList.add("is-complete");
            const event = startEvent;
            if (!event) return;
            try {
                await options.onHold({ ...point, event });
            } catch (error) {
                options.onError?.(error);
            } finally {
                indicator.classList.remove("is-complete");
            }
        },
        onDragStart: (point) => {
            stopProgress();
            const event = startEvent;
            if (event) options.onDragStart?.({ ...point, event });
        },
        onCancel: (reason) => {
            stopProgress();
            options.onCancel?.(reason);
        },
    });

    const pointerDown = (event: PointerEvent) => {
        if (
            event.button !== 0 ||
            !event.isPrimary ||
            excludedTarget(event.target) ||
            options.disabled?.(event)
        ) {
            controller.cancel("disabled");
            return;
        }
        startEvent = event;
        suppressClick = false;
        if (
            !controller.pointerDown({
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
            })
        )
            return;
        const container =
            indicator.offsetParent instanceof HTMLElement
                ? indicator.offsetParent
                : target.parentElement;
        const bounds = container?.getBoundingClientRect();
        const scaleX =
            container?.offsetWidth && bounds?.width
                ? bounds.width / container.offsetWidth
                : 1;
        const scaleY =
            container?.offsetHeight && bounds?.height
                ? bounds.height / container.offsetHeight
                : 1;
        indicator.style.left = `${(event.clientX - (bounds?.left ?? 0)) / scaleX + (container?.scrollLeft ?? 0) - (container?.clientLeft ?? 0)}px`;
        indicator.style.top = `${(event.clientY - (bounds?.top ?? 0)) / scaleY + (container?.scrollTop ?? 0) - (container?.clientTop ?? 0)}px`;
        indicator.classList.add("is-pressing");
        try {
            target.setPointerCapture(event.pointerId);
        } catch {
            // Detached/replaced targets can reject pointer capture.
        }
        frame = requestAnimationFrame(drawProgress);
    };
    const pointerMove = (event: PointerEvent) => {
        if (event.buttons !== 1) {
            controller.cancel("disabled");
            return;
        }
        controller.pointerMove({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        });
    };
    const pointerUp = (event: PointerEvent) => {
        controller.pointerUp(event.pointerId);
        startEvent = null;
        stopProgress();
    };
    const pointerCancel = (event: PointerEvent) => {
        controller.pointerCancel(event.pointerId);
        startEvent = null;
    };
    const keyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") controller.cancel("escape");
    };
    const blur = () => controller.cancel("blur");
    const click = (event: MouseEvent) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
    };

    target.addEventListener("pointerdown", pointerDown);
    target.addEventListener("pointermove", pointerMove);
    target.addEventListener("pointerup", pointerUp);
    target.addEventListener("pointercancel", pointerCancel);
    target.addEventListener("click", click, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", blur);

    return {
        cancel(reason = "manual") {
            controller.cancel(reason);
            stopProgress();
            startEvent = null;
        },
        dispose() {
            controller.cancel("manual");
            stopProgress();
            target.removeEventListener("pointerdown", pointerDown);
            target.removeEventListener("pointermove", pointerMove);
            target.removeEventListener("pointerup", pointerUp);
            target.removeEventListener("pointercancel", pointerCancel);
            target.removeEventListener("click", click, true);
            window.removeEventListener("keydown", keyDown, true);
            window.removeEventListener("blur", blur);
            indicator.remove();
            delete target.dataset.imageHold;
        },
        setBusy(busy) {
            target.classList.toggle("image-hold-busy", busy);
            indicator.classList.toggle("is-busy", busy);
        },
    };
}
