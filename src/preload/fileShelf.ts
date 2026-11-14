import { contextBridge, ipcRenderer } from "electron";
import type { FileShelfApi } from "../../lib/fileShelf";

const prefix = "--file-shelf-token=";
const token = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);

if (
    !token ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        token,
    )
)
    throw new Error("File shelf capability token is missing.");

const channel = (name: string) => `oc:file-shelf:${token}:${name}`;
const api: FileShelfApi = Object.freeze({
    ready: () => ipcRenderer.invoke(channel("ready")),
    copy: (ids: string[]) => ipcRenderer.invoke(channel("copy"), ids),
    copyPath: (ids: string[]) => ipcRenderer.invoke(channel("copy-path"), ids),
    reveal: (id: string) => ipcRenderer.invoke(channel("reveal"), id),
    drag: (ids: string[]) => ipcRenderer.sendSync(channel("drag"), ids),
    close: () => ipcRenderer.send(channel("close")),
    t: (text: string) => ipcRenderer.sendSync(channel("translate"), text),
});

contextBridge.exposeInMainWorld("fileShelf", api);
