import type {
    CaptureDraft,
    StageCaptureInput,
    StageCaptureResult,
} from "./openCaptureTypes";

export type DraftSnapshot = Omit<StageCaptureInput, "id" | "expectedRevision">;
export type DraftRecord = {
    key: number;
    id?: string;
    revision: number;
    dirty: boolean;
    editEpoch: number;
    pending: boolean;
    error?: unknown;
    snapshot?: DraftSnapshot;
    chain: Promise<StageCaptureResult | undefined>;
};

export class CaptureDraftQueue {
    private sequence = 0;
    private currentRecord: DraftRecord | null = null;
    private records: DraftRecord[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private ready = false;

    constructor(
        private options: {
            snapshot(includeSource: boolean): DraftSnapshot | null;
            stage(input: StageCaptureInput): Promise<StageCaptureResult>;
            committed?(
                result: StageCaptureResult,
                snapshot: DraftSnapshot,
                record: DraftRecord,
            ): void;
            failed?(error: unknown): void;
        },
    ) {}

    begin(draft?: Pick<CaptureDraft, "id" | "revision">) {
        if (this.timer) clearTimeout(this.timer);
        this.ready = false;
        const existing =
            draft && this.records.find((record) => record.id === draft.id);
        this.currentRecord = existing ?? {
            key: ++this.sequence,
            id: draft?.id,
            revision: draft?.revision ?? 0,
            dirty: false,
            editEpoch: 0,
            pending: false,
            chain: Promise.resolve(undefined),
        };
        if (existing && draft && !existing.dirty && !existing.pending)
            existing.revision = draft.revision;
        if (!existing) this.records.push(this.currentRecord);
        if (this.records.length > 128)
            this.records = this.records.filter(
                (record) =>
                    record === this.currentRecord ||
                    record.pending ||
                    record.error ||
                    record.dirty ||
                    this.records.indexOf(record) >= this.records.length - 80,
            );
        return this.currentRecord;
    }

    initialized() {
        this.ready = true;
    }
    get current() {
        return this.currentRecord;
    }
    get savedIds() {
        return this.records.flatMap((record) => (record.id ? [record.id] : []));
    }

    changed() {
        if (!this.ready || !this.currentRecord) return;
        this.currentRecord.dirty = true;
        this.currentRecord.editEpoch++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            void this.save().catch((error) => this.options.failed?.(error));
        }, 550);
    }

    async save(force = false): Promise<StageCaptureResult | undefined> {
        const record = this.currentRecord;
        if (!this.ready || !record) return Promise.resolve(undefined);
        if (!force && !record.dirty) return record.chain;
        const snapshot = this.options.snapshot(!record.id);
        if (!snapshot) return record.chain;
        const frozen = structuredClone(snapshot);
        record.dirty = false;
        record.snapshot = frozen;
        return this.enqueue(record, frozen);
    }

    private enqueue(record: DraftRecord, snapshot: DraftSnapshot) {
        const previous = record.chain;
        record.chain = previous
            .catch(() => undefined)
            .then(async () => {
                record.pending = true;
                try {
                    const result = await this.options.stage({
                        ...snapshot,
                        ...(record.id
                            ? {
                                  id: record.id,
                                  expectedRevision: record.revision,
                                  sourceDataURL: undefined,
                              }
                            : {}),
                    });
                    if (record.id && record.id !== result.id)
                        throw new Error("Draft identity changed unexpectedly");
                    if (result.revision <= record.revision)
                        throw new Error("Draft acknowledgement is stale");
                    record.id = result.id;
                    record.revision = result.revision;
                    record.error = undefined;
                    this.options.committed?.(result, snapshot, record);
                    if (record.snapshot === snapshot && !record.dirty)
                        record.snapshot = undefined;
                    return result;
                } catch (error) {
                    record.error = error;
                    record.dirty = true;
                    throw error;
                } finally {
                    record.pending = false;
                }
            });
        return record.chain;
    }

    async flush() {
        if (this.timer) clearTimeout(this.timer);
        await this.save();
        await Promise.all(this.records.map((record) => record.chain));
    }

    async retry() {
        const failed = this.records.filter(
            (record) => record.error && record.snapshot,
        );
        await Promise.all(
            failed.map((record) => {
                if (record === this.currentRecord && record.dirty && this.ready)
                    return this.save(true);
                record.dirty = false;
                return this.enqueue(record, record.snapshot!);
            }),
        );
        await this.flush();
    }

    dispose() {
        if (this.timer) clearTimeout(this.timer);
    }
}
