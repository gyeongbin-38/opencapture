type RarCommand = {
    runtimeSource: string;
    wasm: Uint8Array;
    input: Uint8Array;
};

declare global {
    interface Window {
        rarRuntime: {
            onCommand(callback: (command: RarCommand) => void): void;
            emit(event: Record<string, unknown>): Promise<void>;
        };
    }
}

const workerSource = String.raw`
const CHUNK_BYTES = 1024 * 1024;
const pending = new Map();
let sequence = 0;
function emit(event) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        const transfer = event.type === "chunk" ? [event.bytes.buffer] : [];
        self.postMessage({ type: "event", id, event }, transfer);
    });
}
self.onmessage = async ({ data }) => {
    if (data.type === "ack") {
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id);
        if (data.error) waiter.reject(new Error(data.error));
        else waiter.resolve();
        return;
    }
    if (data.type !== "start") return;
    let module;
    let inputPointer = 0;
    let chunkPointer = 0;
    let moduleUrl = "";
    let wasmUrl = "";
    try {
        moduleUrl = URL.createObjectURL(new Blob([data.runtimeSource], { type: "text/javascript" }));
        wasmUrl = URL.createObjectURL(new Blob([data.wasm], { type: "application/wasm" }));
        const runtime = await import(moduleUrl);
        module = await runtime.default({ locateFile: (name) => name.endsWith(".wasm") ? wasmUrl : name });
        inputPointer = module._malloc(data.input.byteLength);
        chunkPointer = module._malloc(CHUNK_BYTES);
        if (!inputPointer || !chunkPointer) throw new Error("RAR runtime memory limit reached");
        module.HEAPU8.set(data.input, inputPointer);
        if (!module._oc_open(inputPointer, data.input.byteLength)) throw new Error(module.UTF8ToString(module._oc_error()));
        while (true) {
            const next = module._oc_next();
            if (next === 0) break;
            if (next < 0) throw new Error(module.UTF8ToString(module._oc_error()));
            const path = module.UTF8ToString(module._oc_path());
            if (!path || path.includes("\uFFFD")) throw new Error("RAR entry path is not valid UTF-8");
            const size = Number(module._oc_size());
            const entryType = module._oc_type();
            await emit({ type: "entry", path, size, entryType });
            if (entryType === 1) {
                while (true) {
                    const count = module._oc_read(chunkPointer, CHUNK_BYTES);
                    if (count < 0) throw new Error(module.UTF8ToString(module._oc_error()));
                    if (count === 0) break;
                    await emit({ type: "chunk", bytes: module.HEAPU8.slice(chunkPointer, chunkPointer + count) });
                }
            }
            await emit({ type: "entry-end" });
        }
        await emit({ type: "done" });
    } catch (error) {
        await emit({ type: "error", message: error instanceof Error ? error.message : String(error) }).catch(() => {});
    } finally {
        module?._oc_close();
        if (module && chunkPointer) module._free(chunkPointer);
        if (module && inputPointer) module._free(inputPointer);
        if (moduleUrl) URL.revokeObjectURL(moduleUrl);
        if (wasmUrl) URL.revokeObjectURL(wasmUrl);
        self.close();
    }
};
`;

window.rarRuntime.onCommand((command) => {
    const workerUrl = URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl, { type: "module" });
    URL.revokeObjectURL(workerUrl);
    worker.onmessage = ({ data }) => {
        if (data.type !== "event") return;
        void window.rarRuntime
            .emit(data.event)
            .then(() => worker.postMessage({ type: "ack", id: data.id }))
            .catch((error) =>
                worker.postMessage({
                    type: "ack",
                    id: data.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                }),
            );
    };
    worker.postMessage(
        {
            type: "start",
            runtimeSource: command.runtimeSource,
            wasm: command.wasm,
            input: command.input,
        },
        [command.wasm.buffer, command.input.buffer],
    );
});

export {};
