import { contextBridge, ipcRenderer } from "electron";

const token = process.argv
    .find((value) => value.startsWith("--pdf-tools-token="))
    ?.slice("--pdf-tools-token=".length);
if (!token || !/^[0-9a-f-]{36}$/.test(token))
    throw new Error("Invalid PDF job.");
const channel = (name: string) => `oc:pdf-worker:${token}:${name}`;
contextBridge.exposeInMainWorld("pdfTools", {
    ready: () => ipcRenderer.invoke(channel("ready")),
    emit: (page: unknown) => ipcRenderer.invoke(channel("page"), page),
    done: () => ipcRenderer.invoke(channel("done")),
    fail: (message: unknown) =>
        ipcRenderer.send(
            channel("error"),
            typeof message === "string"
                ? message.slice(0, 1000)
                : "PDF processing failed.",
        ),
});
