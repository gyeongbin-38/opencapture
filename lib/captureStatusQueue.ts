type StatusMessage = { text: string; hold: boolean };

export class CaptureStatusQueue {
    private pending: StatusMessage[] = [];
    private current: StatusMessage | null = null;
    private errorActive = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly holdMs: number;
    private readonly progressMs: number;

    constructor(
        private readonly display: {
            show(text: string): void;
            hide(): void;
            showError(text: string): void;
        },
        timing?: { holdMs?: number; progressMs?: number },
    ) {
        this.holdMs = timing?.holdMs ?? 1700;
        this.progressMs = timing?.progressMs ?? 4000;
    }

    private pump() {
        if (this.errorActive || this.current) return;
        const next = this.pending.shift();
        if (!next) {
            this.display.hide();
            return;
        }
        this.current = next;
        this.display.show(next.text);
        this.timer = setTimeout(
            () => {
                this.current = null;
                this.timer = undefined;
                this.pump();
            },
            next.hold ? this.holdMs : this.progressMs,
        );
    }

    push(text: string) {
        const hold = !(text.endsWith("…") || text.endsWith("..."));
        if (this.current?.text === text || this.pending.at(-1)?.text === text)
            return;
        if (
            !this.errorActive &&
            this.current &&
            (!this.current.hold || !hold)
        ) {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = undefined;
            }
            this.current = null;
        }
        this.pending.push({ text, hold });
        this.pump();
    }

    fail(error: unknown) {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.errorActive = true;
        this.pending.length = 0;
        this.current = null;
        this.display.showError(
            error instanceof Error ? error.message : String(error),
        );
    }

    clearError() {
        this.errorActive = false;
        this.pump();
    }

    reset() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.errorActive = false;
        this.pending.length = 0;
        this.current = null;
        this.display.hide();
    }
}
