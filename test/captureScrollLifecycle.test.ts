import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const filename = new URL(
    "../src/renderer/clip/clip_window.ts",
    import.meta.url,
);
const source = ts.createSourceFile(
    filename.pathname,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

function productionFunction(name: string) {
    const declaration = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    if (!declaration) throw new Error(`Production ${name} function missing`);
    return declaration.getText(source);
}

function compile(script: string) {
    return ts.transpileModule(script, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
        },
    }).outputText;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("production scroll capture lifecycle", () => {
    it("discards a late frame from an older scroll session", async () => {
        const first = deferred<{ toImageData(): { id: number } }>();
        const second = deferred<{ toImageData(): { id: number } }>();
        const captures = [first.promise, second.promise];
        const addLong = vi.fn(async () => {});
        const state = {
            addLong,
            getNowScreen: () => ({ capture: () => captures.shift() }),
            renderSend: vi.fn(),
            console,
        };
        const context = vm.createContext({ state });
        vm.runInContext(
            compile(`
                let longBusy=false;
                let longCapped=false;
                let longSession=1;
                let longRunning=true;
                let longInFlight=null;
                const addLong=state.addLong;
                const getNowScreen=state.getNowScreen;
                const renderSend=state.renderSend;
                const console=state.console;
                ${productionFunction("long_s")}
                globalThis.api={
                    run:long_s,
                    restart(){longSession=2;longBusy=false;longInFlight=null},
                    read:()=>({longBusy,longSession,longInFlight})
                };
            `),
            context,
        );
        const api = context.api as {
            run(session: number): Promise<void>;
            restart(): void;
            read(): { longBusy: boolean; longInFlight: Promise<void> | null };
        };

        const oldFrame = api.run(1);
        api.restart();
        const currentFrame = api.run(2);
        const currentOperation = api.read().longInFlight;
        first.resolve({ toImageData: () => ({ id: 1 }) });
        await oldFrame;
        expect(addLong).not.toHaveBeenCalled();
        expect(api.read().longInFlight).toBe(currentOperation);

        second.resolve({ toImageData: () => ({ id: 2 }) });
        await currentFrame;
        expect(addLong).toHaveBeenCalledOnce();
        expect(addLong).toHaveBeenCalledWith({ id: 2 }, 2);
        expect(api.read()).toMatchObject({
            longBusy: false,
            longInFlight: null,
        });
    });

    it("waits for the real in-flight frame before final capture and assembly", async () => {
        const pending = deferred<void>();
        const longS = vi.fn(async () => {});
        const addLong = vi.fn(async () => {});
        const context = vm.createContext({
            pending: pending.promise,
            longS,
            addLong,
        });
        vm.runInContext(
            compile(`
                let longSession=4;
                let longInited=true;
                let longInFlight=pending;
                let longCapped=false;
                let longRunning=true;
                let longStopping=null;
                let longStopSession=0;
                const long_s=longS;
                ${productionFunction("stopLong")}
                globalThis.api={stop:stopLong,read:()=>({longRunning,longStopping})};
            `),
            context,
        );
        const api = context.api as {
            stop(): Promise<void>;
            read(): {
                longRunning: boolean;
                longStopping: Promise<void> | null;
            };
        };

        const stopping = api.stop();
        await Promise.resolve();
        expect(longS).not.toHaveBeenCalled();
        expect(addLong).not.toHaveBeenCalled();
        pending.resolve();
        await stopping;

        expect(longS).toHaveBeenCalledWith(4);
        expect(addLong).toHaveBeenCalledWith(undefined, 4);
        expect(api.read()).toEqual({ longRunning: false, longStopping: null });
    });

    it("resets stitched state and removes prior native listeners on restart", () => {
        const hook = {
            off: vi.fn(),
            stop: vi.fn(),
        };
        const oldKey = () => {};
        const oldWheel = () => {};
        const longX = {
            img: { old: true },
            imgXY: { x: 8, y: 9 },
            lastImg: { old: true },
            lastXY: { x: 10, y: 11 },
        };
        const clearInterval = vi.fn();
        const previewClear = vi.fn();
        const context = vm.createContext({
            h: {
                hook,
                oldKey,
                oldWheel,
                longX,
                clearInterval,
                previewClear,
            },
        });
        vm.runInContext(
            compile(`
                let longClipTime=1;
                let longMouse=2;
                let uIOhook=h.hook;
                let longKeyupHandler=h.oldKey;
                let longWheelHandler=h.oldWheel;
                const clearInterval=h.clearInterval;
                let longSession=0;
                let longRunning=false;
                let longInited=false;
                let longCapped=true;
                let longBusy=true;
                let longInFlight=Promise.resolve();
                let longStopping=Promise.resolve();
                let longStopSession=9;
                const longX=h.longX;
                const longPreview={clear:h.previewClear,style(){}};
                const setInterval=()=>3;
                const renderSendSync=()=>({po:{x:0,y:0}});
                const renderSend=()=>{};
                const finishLongB={style:{}};
                const longHide=[];
                const document={body:{classList:{remove(){}},children:[]},elementsFromPoint:()=>[]};
                const 记忆框选值={};
                let nowScreenId=1;
                const store={set(){}};
                const ratio=1;
                const window={innerWidth:800,innerHeight:600};
                const lr={style(){}};
                const stopLong=()=>{};
                ${productionFunction("cleanupLongCapture")}
                ${productionFunction("initLong")}
                globalThis.api={
                    init:()=>initLong([10,20,300,200]),
                    read:()=>({longSession,longRunning,longInited,longCapped,longBusy,longInFlight,longStopping,longStopSession,longClipTime,longMouse,uIOhook,longKeyupHandler,longWheelHandler})
                };
            `),
            context,
        );
        const api = context.api as {
            init(): void;
            read(): Record<string, unknown>;
        };
        api.init();

        expect(hook.off).toHaveBeenCalledWith("keyup", oldKey);
        expect(hook.off).toHaveBeenCalledWith("wheel", oldWheel);
        expect(hook.stop).toHaveBeenCalledOnce();
        expect(clearInterval).toHaveBeenCalledWith(1);
        expect(clearInterval).toHaveBeenCalledWith(2);
        expect(previewClear).toHaveBeenCalledOnce();
        expect(longX).toEqual({
            img: null,
            imgXY: { x: 0, y: 0 },
            lastImg: null,
            lastXY: { x: 0, y: 0 },
        });
        expect(api.read()).toMatchObject({
            longSession: 1,
            longRunning: true,
            longInited: true,
            longCapped: false,
            longBusy: false,
            longInFlight: null,
            longStopping: null,
            longStopSession: 0,
            longClipTime: null,
            longMouse: 3,
            uIOhook: null,
            longKeyupHandler: null,
            longWheelHandler: null,
        });
    });

    it.each(["empty", "error"])(
        "restores the capture UI after an %s final assembly",
        (mode) => {
            const hidden = [{ style: { display: "none" } }];
            const cleanup = vi.fn();
            const previewStyle = vi.fn();
            const previewClear = vi.fn();
            const bodyAdd = vi.fn();
            const frameStyle = vi.fn();
            const renderSend = vi.fn();
            const showStatus = vi.fn();
            const brokenCanvas = {
                width: 10,
                height: 20,
                getContext: () => ({
                    getImageData: () => {
                        throw new Error("read failed");
                    },
                }),
            };
            const context = vm.createContext({
                h: {
                    hidden,
                    cleanup,
                    previewStyle,
                    previewClear,
                    bodyAdd,
                    frameStyle,
                    renderSend,
                    showStatus,
                    canvas: mode === "empty" ? null : brokenCanvas,
                },
            });
            vm.runInContext(
                compile(`
                    let longSession=5;
                    let longRunning=true;
                    let longInited=true;
                    let longBusy=true;
                    let longInFlight=Promise.resolve();
                    const longX={img:h.canvas};
                    const cleanupLongCapture=h.cleanup;
                    const captureWorkspace={showStatus:h.showStatus};
                    const t=value=>value;
                    const mainCanvas={width:0,height:0,getContext:()=>({putImageData(){}})};
                    const fabricCanvas={setDimensions(){}};
                    const setClipSize=()=>{};
                    let finalRect=[0,0,0,0];
                    const drawClip=()=>{};
                    const longPreview={style:h.previewStyle,clear:h.previewClear};
                    const document={body:{classList:{add:h.bodyAdd}}};
                    const lr={style:h.frameStyle};
                    const longHide=h.hidden;
                    const renderSend=h.renderSend;
                    ${productionFunction("pjLong")}
                    globalThis.api={finish:()=>pjLong(5),read:()=>({longRunning,longInited,longBusy,longInFlight})};
                `),
                context,
            );
            const api = context.api as {
                finish(): void;
                read(): Record<string, unknown>;
            };

            if (mode === "error") expect(api.finish).toThrow("read failed");
            else api.finish();

            expect(cleanup).toHaveBeenCalledOnce();
            expect(previewStyle).toHaveBeenCalledWith({ display: "none" });
            expect(previewClear).toHaveBeenCalledOnce();
            expect(bodyAdd).toHaveBeenCalledWith("editor_bg");
            expect(frameStyle).toHaveBeenCalledWith({
                opacity: "0",
                width: "0",
                height: "0",
            });
            expect(hidden[0].style.display).toBe("");
            expect(renderSend).toHaveBeenCalledWith("windowIgnoreMouse", [
                false,
            ]);
            expect(api.read()).toEqual({
                longRunning: false,
                longInited: false,
                longBusy: false,
                longInFlight: null,
            });
            if (mode === "empty") expect(showStatus).toHaveBeenCalledOnce();
        },
    );
});
