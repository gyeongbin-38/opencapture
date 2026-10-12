export type LongPressCancelReason =
    | "move"
    | "release"
    | "pointercancel"
    | "escape"
    | "blur"
    | "disabled"
    | "manual";

export type LongPressPoint = {
    pointerId: number;
    x: number;
    y: number;
};

export type LongPressControllerOptions = {
    durationMs?: number;
    moveTolerance?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    onHold: (point: LongPressPoint) => void;
    onDragStart?: (point: LongPressPoint & { dx: number; dy: number }) => void;
    onCancel?: (reason: LongPressCancelReason) => void;
};

export type LongPressController = {
    pointerDown(point: LongPressPoint): boolean;
    pointerMove(point: LongPressPoint): void;
    pointerUp(pointerId: number): void;
    pointerCancel(pointerId: number): void;
    cancel(reason?: LongPressCancelReason): void;
    progress(): number;
    state(): "idle" | "pressing" | "dragging" | "held";
};

export function createLongPressController(
    options: LongPressControllerOptions,
): LongPressController {
    const durationMs = Math.max(1, options.durationMs ?? 650);
    const moveTolerance = Math.max(0, options.moveTolerance ?? 8);
    const now = options.now ?? Date.now;
    const setTimer =
        options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimer =
        options.clearTimer ??
        ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let phase: "idle" | "pressing" | "dragging" | "held" = "idle";
    let origin: (LongPressPoint & { at: number }) | null = null;
    let timer: unknown;

    const clear = () => {
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
    };
    const reset = () => {
        clear();
        origin = null;
        phase = "idle";
    };
    const cancel = (reason: LongPressCancelReason = "manual") => {
        if (phase === "idle") return;
        reset();
        options.onCancel?.(reason);
    };

    return {
        pointerDown(point) {
            if (phase !== "idle") return false;
            origin = { ...point, at: now() };
            phase = "pressing";
            timer = setTimer(() => {
                if (phase !== "pressing" || !origin) return;
                clear();
                phase = "held";
                options.onHold({
                    pointerId: origin.pointerId,
                    x: origin.x,
                    y: origin.y,
                });
            }, durationMs);
            return true;
        },
        pointerMove(point) {
            if (
                phase !== "pressing" ||
                !origin ||
                point.pointerId !== origin.pointerId
            )
                return;
            const dx = point.x - origin.x;
            const dy = point.y - origin.y;
            if (Math.hypot(dx, dy) <= moveTolerance) return;
            clear();
            phase = "dragging";
            options.onCancel?.("move");
            options.onDragStart?.({ ...origin, dx, dy });
        },
        pointerUp(pointerId) {
            if (!origin || origin.pointerId !== pointerId) return;
            if (phase === "pressing") cancel("release");
            else reset();
        },
        pointerCancel(pointerId) {
            if (!origin || origin.pointerId !== pointerId) return;
            cancel("pointercancel");
        },
        cancel,
        progress() {
            if (phase === "held") return 1;
            if (phase !== "pressing" || !origin) return 0;
            return Math.max(0, Math.min(1, (now() - origin.at) / durationMs));
        },
        state: () => phase,
    };
}
