export class BoardRevisionQueue<T extends { revision: number }> {
    private tail: Promise<void> = Promise.resolve();
    private currentRevision = 0;
    private failure: unknown = null;

    reset(revision: number) {
        this.currentRevision = revision;
        this.failure = null;
    }

    revision() {
        return this.currentRevision;
    }

    enqueue(
        snapshot: T,
        save: (snapshot: T, expectedRevision: number) => Promise<T>,
    ): Promise<T> {
        const operation = this.tail
            .catch(() => undefined)
            .then(async () => {
                try {
                    const expectedRevision = this.currentRevision;
                    const versioned = {
                        ...snapshot,
                        revision: expectedRevision,
                    };
                    const saved = await save(versioned, expectedRevision);
                    this.currentRevision = saved.revision;
                    this.failure = null;
                    return saved;
                } catch (error) {
                    this.failure = error;
                    throw error;
                }
            });
        this.tail = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    async flush() {
        while (true) {
            const pending = this.tail;
            await pending;
            if (pending === this.tail) break;
        }
        if (this.failure) throw this.failure;
    }
}
