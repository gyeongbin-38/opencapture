import { contextBridge, ipcRenderer } from "electron";

type RarCommand = {
    runtimeSource: string;
    wasm: Uint8Array;
    input: Uint8Array;
};

let token = "";
let callbackChannel = "";

contextBridge.exposeInMainWorld("rarRuntime", {
    onCommand(callback: (command: RarCommand) => void) {
        ipcRenderer.once(
            "oc:rar:start",
            (
                _event,
                command: RarCommand & {
                    token: string;
                    callbackChannel: string;
                },
            ) => {
                token = command.token;
                callbackChannel = command.callbackChannel;
                callback({
                    runtimeSource: command.runtimeSource,
                    wasm: command.wasm,
                    input: command.input,
                });
            },
        );
    },
    emit(event: Record<string, unknown>) {
        if (!token || !callbackChannel)
            return Promise.reject(
                new Error("RAR runtime session is unavailable"),
            );
        return ipcRenderer.invoke(callbackChannel, token, event);
    },
});
