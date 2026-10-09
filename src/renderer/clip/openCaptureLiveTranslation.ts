export type LiveTranslationTask<T> = () => Promise<T>;

/**
 * Debounces selection changes, permits one expensive OCR/translation task at a
 * time, and only publishes the newest generation.
 */
export class LatestLiveTranslation<T> {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;
    private running = false;
    private queued: {
        generation: number;
        task: LiveTranslationTask<T>;
    } | null = null;

    constructor(
        private readonly publish: (value: T) => void,
        private readonly reportError: (error: unknown) => void,
        private readonly delayMs = 450,
    ) {}

    schedule(task: LiveTranslationTask<T>) {
        const generation = ++this.generation;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.startOrQueue({ generation, task });
        }, this.delayMs);
    }

    cancel() {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.queued = null;
    }

    private startOrQueue(next: {
        generation: number;
        task: LiveTranslationTask<T>;
    }) {
        if (this.running) {
            this.queued = next;
            return;
        }
        void this.run(next);
    }

    private async run(next: {
        generation: number;
        task: LiveTranslationTask<T>;
    }) {
        this.running = true;
        try {
            const value = await next.task();
            if (next.generation === this.generation) this.publish(value);
        } catch (error) {
            if (next.generation === this.generation) this.reportError(error);
        } finally {
            this.running = false;
            const queued = this.queued;
            this.queued = null;
            if (queued && queued.generation === this.generation) {
                this.startOrQueue(queued);
            }
        }
    }
}

export function normalizeTranslatedTexts(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value))
        return value.filter((x): x is string => typeof x === "string");
    if (
        value &&
        typeof value === "object" &&
        "texts" in value &&
        Array.isArray(value.texts)
    ) {
        return value.texts.filter((x): x is string => typeof x === "string");
    }
    throw new Error("번역 서비스가 올바르지 않은 응답을 반환했습니다.");
}
