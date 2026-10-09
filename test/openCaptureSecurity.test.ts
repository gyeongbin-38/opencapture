import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
vi.mock("electron", () => ({ BrowserWindow: {}, ClipboardItem: {}, app: {}, clipboard: {}, dialog: {}, ipcMain: {}, nativeImage: {}, shell: {} }));
vi.mock("onnxruntime-node", () => ({ InferenceSession: {}, Tensor: {} }));
import { isLibrary, isTrustedPage } from "../src/main/openCapture";
const root = resolve("security-fixture");
describe("translation sender URL boundary", () => {
    it("rejects corrupt or incomplete catalog metadata before persistence", () => {
        expect(isLibrary({collections: [], items: []})).toBe(false);
        expect(isLibrary({collections: [{id:'a',name:'A',path:'C:/Shots'}],items:[],activeCollectionId:'missing'})).toBe(false);
        expect(isLibrary({collections: [{id:'a',name:'A',path:'C:/Shots'}],items:[],activeCollectionId:'a'})).toBe(true);
    });
    it("accepts packaged renderer but rejects remote and outside files", () => {
        expect(isTrustedPage(pathToFileURL(resolve(root, "out/renderer/dashboard.html")).href, root)).toBe(true);
        expect(isTrustedPage("https://example.com/dashboard.html", root)).toBe(false);
        expect(isTrustedPage(pathToFileURL(resolve(root, "out/renderer-other/evil.html")).href, root)).toBe(false);
        expect(isTrustedPage("javascript:alert(1)", root)).toBe(false);
    });
    it("allows only exact loopback development origin", () => {
        expect(isTrustedPage("http://localhost:5173/dashboard.html", root, "http://localhost:5173")).toBe(true);
        expect(isTrustedPage("http://localhost:5174/dashboard.html", root, "http://localhost:5173")).toBe(false);
        expect(isTrustedPage("http://localhost.evil.test:5173/dashboard.html", root, "http://localhost:5173")).toBe(false);
    });
});
