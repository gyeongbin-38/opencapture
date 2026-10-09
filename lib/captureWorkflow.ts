export type CaptureWorkflowPreferences = {
    autoCopy: boolean;
    autoRemoveBackground: boolean;
    autoPin: boolean;
};

export const defaultCaptureWorkflowPreferences: CaptureWorkflowPreferences = {
    autoCopy: false,
    autoRemoveBackground: false,
    autoPin: false,
};

export function parseCaptureWorkflowPreferences(
    value: unknown,
    fallback = defaultCaptureWorkflowPreferences,
): CaptureWorkflowPreferences {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Workflow settings must be an object.");
    const input = value as Record<string, unknown>;
    const allowed = new Set(["autoCopy", "autoRemoveBackground", "autoPin"]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
        throw new Error("Unknown workflow setting.");
    for (const value of Object.values(input)) {
        if (typeof value !== "boolean")
            throw new Error("Workflow settings must be boolean values.");
    }
    return { ...fallback, ...input } as CaptureWorkflowPreferences;
}

export type CaptureWorkflowOperations<Derived> = {
    copy: (path: string) => void | Promise<void>;
    removeBackground: (path: string) => Derived | Promise<Derived>;
    saveDerived: (
        derived: Derived,
        originalPath: string,
    ) => string | Promise<string>;
    pin: (path: string) => void | Promise<void>;
    onError: (path: string, step: CaptureWorkflowStep, error: unknown) => void;
};

export type CaptureWorkflowStep =
    | "queue"
    | "copy"
    | "remove-background"
    | "pin";

export type CombineDirection = "vertical" | "horizontal";

export function planImageCombination(
    sizes: readonly { width: number; height: number }[],
    direction: CombineDirection,
) {
    let sourcePixels = 0;
    let width = 0;
    let height = 0;
    for (const size of sizes) {
        if (
            !Number.isSafeInteger(size.width) ||
            !Number.isSafeInteger(size.height) ||
            size.width <= 0 ||
            size.height <= 0
        )
            throw new Error("One of the selected images has an invalid size.");
        sourcePixels += size.width * size.height;
        if (sourcePixels > 20_000_000)
            throw new Error("Selected images exceed the 20MP source limit.");
        if (direction === "horizontal") {
            width += size.width;
            height = Math.max(height, size.height);
        } else {
            width = Math.max(width, size.width);
            height += size.height;
        }
    }
    if (width * height > 40_000_000)
        throw new Error("The combined image exceeds the 40MP output limit.");
    return { width, height, sourcePixels };
}

type Job = {
    path: string;
    preferences: CaptureWorkflowPreferences;
};

export class CaptureWorkflowQueue<Derived> {
    private readonly jobs: Job[] = [];
    private readonly idleResolvers: Array<() => void> = [];
    private running = false;

    constructor(
        private readonly operations: CaptureWorkflowOperations<Derived>,
        private readonly maxPending = 100,
    ) {}

    enqueue(path: string, preferences: CaptureWorkflowPreferences) {
        if (this.jobs.length >= this.maxPending) {
            this.report(
                path,
                "queue",
                new Error("Capture workflow queue is full."),
            );
            return false;
        }
        this.jobs.push({ path, preferences: { ...preferences } });
        if (!this.running) void this.drain();
        return true;
    }

    whenIdle() {
        if (!this.running && this.jobs.length === 0) return Promise.resolve();
        return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
    }

    private async attempt(
        path: string,
        step: CaptureWorkflowStep,
        operation: () => void | Promise<void>,
    ) {
        try {
            await operation();
        } catch (error) {
            this.report(path, step, error);
        }
    }

    private report(path: string, step: CaptureWorkflowStep, error: unknown) {
        try {
            this.operations.onError(path, step, error);
        } catch {
            // Error reporting must not stall later capture workflows.
        }
    }

    private async drain() {
        this.running = true;
        try {
            while (this.jobs.length > 0) {
                const job = this.jobs.shift();
                if (!job) continue;
                let effectivePath = job.path;
                if (job.preferences.autoRemoveBackground)
                    try {
                        const derived = await this.operations.removeBackground(
                            job.path,
                        );
                        effectivePath = await this.operations.saveDerived(
                            derived,
                            job.path,
                        );
                    } catch (error) {
                        this.report(job.path, "remove-background", error);
                    }
                if (job.preferences.autoCopy)
                    await this.attempt(effectivePath, "copy", () =>
                        this.operations.copy(effectivePath),
                    );
                if (job.preferences.autoPin)
                    await this.attempt(effectivePath, "pin", () =>
                        this.operations.pin(effectivePath),
                    );
            }
        } finally {
            this.running = false;
            for (const resolve of this.idleResolvers.splice(0)) resolve();
        }
    }
}
