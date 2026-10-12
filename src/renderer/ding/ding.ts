// biome-ignore format:
import { writeImage, writeText } from "../lib/clipboard";
const fs = require("node:fs") as typeof import("fs");
import {
    type ElType,
    addClass,
    addStyle,
    button,
    elFromId,
    ele,
    image,
    initDKH,
    input,
    trackPoint,
    txt,
    view,
} from "dkh-ui";
import xtranslator from "xtranslator";
import { captureDock, radialLayout } from "../../../lib/captureControls";
import { PinBlinkController, PinFocusState } from "../../../lib/pinState";
import store from "../../../lib/store/renderStore";
import { Class, cssVar, getImgUrl, initStyle, setTitle } from "../root/root";

import { renderOn, renderSend, renderSendSync } from "../../../lib/ipc";
import { t } from "../../../lib/translate/translate";
import type { DingStart, Dire } from "../../ShareTypes";
import type { IconType } from "../../iconTypes";
import { createImageHold } from "../lib/imageHold";
import { loadTranslator } from "../lib/translate";
import { defaultOcrId, loadOCR } from "../ocr/ocr";
import {
    pinOutputSize,
    transformPinPoint,
    withDerivedPinImage,
} from "./pinRendering";

initStyle(store);

setTitle(t("贴图"));

let lo: import("esearch-ocr").initType;
let translateE: ((input: string[]) => Promise<string[]>) | undefined;
let NodeScreenshots: typeof import("node-screenshots") | undefined;

type PinShareMessage =
    | { type: "focus"; id: string }
    | { type: "blink"; id: string }
    | { type: "ignore"; id: string; value: boolean }
    | { type: "restore" };

const focusState = new PinFocusState();
const focusButtons = new Map<string, HTMLButtonElement>();
const blinkButtons = new Map<string, HTMLButtonElement>();
const ignoreButtons = new Map<string, HTMLButtonElement>();
const ignoredPins = new Set<string>();
const pinDisposers = new Map<string, Set<() => void>>();
const pinToolbarPositioners = new Map<string, () => void>();
const blinkState = new PinBlinkController((id, visible) => {
    const image = elFromId(id)?.query(".img")?.el;
    if (image) image.style.visibility = visible ? "" : "hidden";
});

function iconEl(src: IconType) {
    return image(getImgUrl(`${src}.svg`), "icon").class("icon");
}

renderOn("dingShare", ([data]) => {
    const message = data as typeof data | PinShareMessage;
    console.log(message);
    switch (message.type) {
        case "close":
            close2(message.id);
            break;
        case "move_start":
            mouseStart(message.more);
            break;
        case "move_end":
            mouseEnd();
            break;
        case "back":
            back2(message.id);
            break;
        case "resize":
            if (!resizeSender) {
                const more = message.more;
                resize(more.id, more.zoom, more.dx, more.dy, more.clip);
            }
            break;
        case "focus":
            toggleFocus(message.id);
            break;
        case "blink":
            toggleBlink(message.id);
            break;
        case "ignore":
            setPinIgnore(message.id, message.value);
            break;
        case "restore":
            restorePinEffects();
            break;
    }
});

const { ipcRenderer } = require("electron") as typeof import("electron");
void ipcRenderer
    .invoke("oc:preferences:get")
    .then(
        (preferences: {
            feedback?: {
                visual?: boolean;
                motion?: "system" | "full" | "reduced";
            };
        }) => {
            const feedback = preferences.feedback;
            document.body.classList.toggle(
                "pin-feedback-disabled",
                feedback?.visual === false,
            );
            document.body.classList.toggle(
                "pin-motion-reduced",
                feedback?.motion === "reduced",
            );
            document.body.classList.toggle(
                "pin-motion-full",
                feedback?.motion === "full",
            );
        },
    )
    .catch(() => {
        // Preferences are optional for legacy pin windows; CSS defaults stay active.
    });
ipcRenderer.on("oc:pins-control", (_event, command) => {
    if (command === "restore") restorePinEffects();
});

const dives: ElType<HTMLElement>[] = [];

type SavedDingPin = {
    x: number;
    y: number;
    w: number;
    h: number;
    src: string;
    opacity: number;
    z: number;
};
let sessionDirty = true;
function markSessionDirty() {
    sessionDirty = true;
}

let changing: { x: number; y: number } | null = null;
const dingData: Map<
    string,
    {
        rect: [number, number, number, number];
        url: string;
        translation: string;
        isTranslate: boolean;
    }
> = new Map();
let elMap: ReturnType<typeof setNewDing>[] = [];
const setNewDing = (
    wid: string,
    x: number,
    y: number,
    w: number,
    h: number,
    url: string,
    type: "translate" | "ding",
) => {
    const previousDisposers = pinDisposers.get(wid);
    if (previousDisposers) for (const dispose of previousDisposers) dispose();
    const disposers = new Set<() => void>();
    pinDisposers.set(wid, disposers);
    dingData.set(wid, {
        rect: [x, y, w, h],
        url,
        translation: "",
        isTranslate: false,
    });
    markSessionDirty();
    const div = view()
        .attr({ id: wid, tabIndex: 0 })
        .style({ position: "fixed", overflow: "visible" })
        .class(dingPhotoClass);
    dives.push(div);
    if (store.get("贴图.窗口.提示")) div.class(dingPhotoHightClass);
    div.style({
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
    });
    const img = image(url, "").attr({ draggable: false });
    const imageP = view()
        .class("img")
        .add(img)
        .class(imageClass)
        .style({ overflow: "hidden" })
        .class(Class.transition);
    const toolBar = view().class("pin-toolbar-host").style({
        overflow: "visible",
        position: "fixed",
        zIndex: 2,
    });
    const toolBarC = view("x")
        .attr({ id: `pin-toolbar-${wid}` })
        .class("pin-toolbar", toolBarIClass)
        .bindSet((v: { forceShow?: boolean; show?: boolean }, el) => {
            if (v.forceShow !== undefined)
                el.setAttribute("data-force-show", String(v.forceShow));
            if (v.show !== undefined)
                el.setAttribute("data-show", String(v.show));
            if (el.getAttribute("data-force-show") === "true") {
                el.classList.add("is-visible");
            } else {
                el.classList.toggle(
                    "is-visible",
                    el.getAttribute("data-show") === "true",
                );
            }
        })
        .sv({ show: false })
        .class(Class.transition);
    toolBar.add(toolBarC);
    // 顶栏
    div.el.onmouseenter = () => {
        toolBarC.sv({ show: true });
    };
    div.el.onmouseleave = () => {
        toolBarC.sv({ show: false });
    };

    const concorlClass = addClass(
        {
            cursor: "ew-resize",
        },
        {
            "& .icon": {
                width: "18px",
                position: "initial",
            },
        },
    );
    const controlsPanel = view("x")
        .class("pin-controls-panel")
        .attr({ role: "group", ariaLabel: "핀 크기와 투명도" });

    // 透明
    const opacityEl = txt()
        .bindSet((v: string, el) => {
            el.innerText = `${v}%`;
            img.el.style.opacity = `${Number(v) / 100}`;
        })
        .sv("100");
    const opacityElP = view("x")
        .class(concorlClass)
        .attr({ title: "不透明度" })
        .add([iconEl("opacity"), opacityEl]);

    trackPoint(opacityElP, {
        start: () => {
            toolBarC.sv({ forceShow: true });
            return { x: 0, y: 0, data: Number.parseInt(opacityEl.gv) };
        },
        ing: (p, _e, { startData }) => {
            const d = Math.round(p.x / 2);
            const newOp = Math.max(0, Math.min(100, startData + d));
            opacityEl.sv(newOp.toString());
        },
        end: () => {
            toolBarC.sv({ forceShow: false });
            markSessionDirty();
        },
    });

    controlsPanel.add(opacityElP);
    // 大小
    const sizeInput = txt()
        .bindSet((v: string, el) => {
            el.innerText = `${v}%`;
        })
        .bindGet((el) => {
            return Number.parseInt(el.innerText);
        })
        .sv("100");
    const sizeRange = input("range")
        .attr({
            min: "10",
            max: "300",
            step: "5",
            ariaLabel: "핀 크기",
        })
        .sv("100")
        .on("input", () => {
            sizeInput.sv(sizeRange.el.value);
            sizeChange();
        });
    const sizeEl = view("x")
        .class(concorlClass)
        .attr({ title: "大小" })
        .add([iconEl("size"), sizeRange, sizeInput]);

    trackPoint(sizeEl, {
        start: (event) => {
            if ((event.target as HTMLElement).closest('input[type="range"]'))
                return false;
            toolBarC.sv({ forceShow: true });
            return { x: 0, y: 0, data: sizeInput.gv };
        },
        ing: (p, _e, { startData }) => {
            const d = Math.round(p.x / 2);
            const newS = Math.max(10, Math.min(300, startData + d));
            sizeInput.sv(newS.toString());
            sizeRange.sv(newS.toString());
            sizeChange();
        },
        end: () => {
            toolBarC.sv({ forceShow: false });
        },
    });

    function sizeChange() {
        if (Number.isFinite(Number(sizeInput.gv))) {
            let zoom = Number(sizeInput.gv) / 100;
            if (zoom < 0.05) zoom = 0.05;
            resizeSender = true;
            resize(wid, zoom, 0, 0);
            resizeSender = false;
        }
    }

    controlsPanel.add(sizeEl);

    const sizePresets = [50, 75, 100, 150];
    sizeEl.el.oncontextmenu = (e) => {
        e.preventDefault();
        const cur = Number(sizeInput.gv);
        const next =
            sizePresets[
                (sizePresets.findIndex((p) => p >= cur) + 1) %
                    sizePresets.length
            ];
        sizeInput.sv(String(next));
        sizeRange.sv(String(next));
        sizeChange();
    };
    sizeEl.el.title = `${sizeEl.el.title} (우클릭: ${sizePresets.join("/")})`;

    const pinFx = { rot: 0, flip: false };
    let disposed = false;
    let cutoutGeneration = 0;
    let cutoutBusy = false;
    let visualRevision = 0;
    const applyPinFx = () => {
        const quarterTurn = pinFx.rot % 180 !== 0;
        const fit = quarterTurn
            ? Math.min(
                  div.el.clientWidth / Math.max(1, div.el.clientHeight),
                  div.el.clientHeight / Math.max(1, div.el.clientWidth),
              )
            : 1;
        const transform = `rotate(${pinFx.rot}deg) scaleX(${pinFx.flip ? -1 : 1}) scale(${fit})`;
        img.el.style.transformOrigin = "center";
        img.el.style.transform = transform;
        drawCanvas.style.transformOrigin = "center";
        drawCanvas.style.transform = transform;
    };

    const drawCanvas = document.createElement("canvas");
    drawCanvas.style.cssText =
        "position:absolute;inset:0;z-index:1;pointer-events:none;";
    imageP.el.appendChild(drawCanvas);
    const drawCtx = drawCanvas.getContext("2d")!;
    const strokes: { pts: [number, number][] }[] = [];
    let pinDrawing = false;
    let drawMode = false;
    const redrawPinStrokes = () => {
        const w = div.el.clientWidth;
        const h = div.el.clientHeight;
        drawCanvas.width = w;
        drawCanvas.height = h;
        drawCtx.lineWidth = Math.max(2, w / 240);
        drawCtx.lineCap = "round";
        drawCtx.lineJoin = "round";
        drawCtx.strokeStyle = "#ff3355";
        for (const s of strokes) {
            if (s.pts.length < 2) continue;
            drawCtx.beginPath();
            for (const [i, p] of s.pts.entries())
                i
                    ? drawCtx.lineTo(p[0] * w, p[1] * h)
                    : drawCtx.moveTo(p[0] * w, p[1] * h);
            drawCtx.stroke();
        }
    };
    drawCanvas.addEventListener("pointerdown", (e) => {
        if (!drawMode || e.button !== 0) return;
        e.stopPropagation();
        visualRevision += 1;
        pinDrawing = true;
        strokes.push({
            pts: [
                [e.offsetX / drawCanvas.width, e.offsetY / drawCanvas.height],
            ],
        });
        drawCanvas.setPointerCapture(e.pointerId);
    });
    drawCanvas.addEventListener("pointermove", (e) => {
        if (!pinDrawing) return;
        const pts = strokes.at(-1)?.pts;
        if (!pts) return;
        const w = drawCanvas.width;
        const h = drawCanvas.height;
        const nx = e.offsetX / w;
        const ny = e.offsetY / h;
        const last = pts.at(-1)!;
        pts.push([nx, ny]);
        drawCtx.beginPath();
        drawCtx.moveTo(last[0] * w, last[1] * h);
        drawCtx.lineTo(nx * w, ny * h);
        drawCtx.stroke();
    });
    const endPinStroke = () => {
        pinDrawing = false;
    };
    drawCanvas.addEventListener("pointerup", endPinStroke);
    drawCanvas.addEventListener("pointercancel", endPinStroke);
    drawCanvas.addEventListener("contextmenu", (e) => {
        if (e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            visualRevision += 1;
            strokes.length = 0;
            redrawPinStrokes();
        }
    });
    const drawButton = button(iconEl("draw"))
        .attr({ title: "그리기 (우클릭 지우기)" })
        .on("click", () => {
            drawMode = !drawMode;
            drawCanvas.style.pointerEvents = drawMode ? "auto" : "none";
            drawButton.el.style.background = drawMode
                ? "var(--bar-focus-color)"
                : "";
            if (drawMode) redrawPinStrokes();
        });
    let toolbarPlacementFrame = 0;
    const updateToolbarPlacement = () => {
        window.cancelAnimationFrame(toolbarPlacementFrame);
        toolbarPlacementFrame = window.requestAnimationFrame(() => {
            if (!div.el.isConnected || !toolBarC.el.isConnected) return;
            const rect = div.el.getBoundingClientRect();
            const toolbarSize = {
                width: toolBarC.el.offsetWidth,
                height: toolBarC.el.offsetHeight,
            };
            if (!toolbarSize.width || !toolbarSize.height) return;
            const point = captureDock(
                {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                },
                { width: window.innerWidth, height: window.innerHeight },
                toolbarSize,
            );
            toolBar.style({ left: `${point.x}px`, top: `${point.y}px` });
        });
    };
    pinToolbarPositioners.set(wid, updateToolbarPlacement);
    const pinResizeObserver = new ResizeObserver(() => {
        if (strokes.length) redrawPinStrokes();
        updateToolbarPlacement();
    });
    pinResizeObserver.observe(div.el);
    pinResizeObserver.observe(toolBarC.el);
    const pinPositionObserver = new MutationObserver(updateToolbarPlacement);
    pinPositionObserver.observe(div.el, {
        attributes: true,
        attributeFilter: ["style"],
    });
    window.addEventListener("resize", updateToolbarPlacement);
    disposers.add(() => {
        window.cancelAnimationFrame(toolbarPlacementFrame);
        window.removeEventListener("resize", updateToolbarPlacement);
        pinResizeObserver.disconnect();
        pinPositionObserver.disconnect();
        pinToolbarPositioners.delete(wid);
    });

    const renderPinBlob = async () => {
        let source = img.el;
        const composedUrl = getUrl(wid);
        if (composedUrl && composedUrl !== source.src) {
            const translated = new Image();
            translated.src = composedUrl;
            await translated.decode();
            source = translated;
        }
        if (!source.complete) await source.decode();
        const sourceSize = {
            width: source.naturalWidth || div.el.clientWidth,
            height: source.naturalHeight || div.el.clientHeight,
        };
        const outputSize = pinOutputSize(
            sourceSize.width,
            sourceSize.height,
            pinFx.rot,
        );
        const canvas = document.createElement("canvas");
        canvas.width = outputSize.width;
        canvas.height = outputSize.height;
        const context = canvas.getContext("2d")!;
        context.save();
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate((pinFx.rot * Math.PI) / 180);
        context.scale(pinFx.flip ? -1 : 1, 1);
        context.drawImage(
            source,
            -sourceSize.width / 2,
            -sourceSize.height / 2,
            sourceSize.width,
            sourceSize.height,
        );
        context.restore();
        context.lineWidth = Math.max(2, canvas.width / 240);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = "#ff3355";
        for (const stroke of strokes) {
            if (stroke.pts.length < 2) continue;
            context.beginPath();
            for (const [index, point] of stroke.pts.entries()) {
                const transformed = transformPinPoint(
                    point,
                    sourceSize,
                    pinFx.rot,
                    pinFx.flip,
                );
                if (index) context.lineTo(transformed.x, transformed.y);
                else context.moveTo(transformed.x, transformed.y);
            }
            context.stroke();
        }
        return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error("PNG"))),
                "image/png",
            ),
        );
    };
    type PinVisualSnapshot = {
        url: string;
        translation: string;
        isTranslate: boolean;
        rotation: number;
        flip: boolean;
        strokes: { pts: [number, number][] }[];
    };
    let cutoutUndo: PinVisualSnapshot | null = null;
    const visualSnapshot = (): PinVisualSnapshot | null => {
        const data = dingData.get(wid);
        if (!data) return null;
        return {
            url: data.url,
            translation: data.translation,
            isTranslate: data.isTranslate,
            rotation: pinFx.rot,
            flip: pinFx.flip,
            strokes: strokes.map((stroke) => ({
                pts: stroke.pts.map((point) => [...point]),
            })),
        };
    };
    const restoreVisualSnapshot = (snapshot: PinVisualSnapshot) => {
        const data = dingData.get(wid);
        if (!data || disposed) return;
        data.url = snapshot.url;
        data.translation = snapshot.translation;
        data.isTranslate = snapshot.isTranslate;
        img.el.src = snapshot.url;
        pinFx.rot = snapshot.rotation;
        pinFx.flip = snapshot.flip;
        strokes.splice(0, strokes.length, ...snapshot.strokes);
        applyPinFx();
        redrawPinStrokes();
    };
    let cutoutStatusRetry: (() => void) | null = null;
    let holdHandle: ReturnType<typeof createImageHold> | null = null;
    const runCutout = async () => {
        if (cutoutBusy || disposed) return;
        const snapshot = visualSnapshot();
        if (!snapshot) return;
        const generation = ++cutoutGeneration;
        const sourceRevision = visualRevision;
        cutoutBusy = true;
        holdHandle?.setBusy(true);
        ocrTransStateBar.el.classList.remove(Class.hide);
        ocrTransStateBar.sv("배경을 제거하는 중…");
        cutoutStatusRetry = null;
        try {
            const dataURL = getUrl(wid);
            if (!dataURL) throw new Error("PIN_SOURCE_MISSING");
            const result = (await ipcRenderer.invoke("oc:image:cutout", {
                dataURL,
            })) as { itemId: string; dataURL: string };
            if (
                disposed ||
                generation !== cutoutGeneration ||
                !dingData.has(wid)
            )
                return;
            if (sourceRevision !== visualRevision) {
                ocrTransStateBar.sv(
                    "이미지가 변경되어 배경 제거 결과를 적용하지 않았습니다",
                );
                return;
            }
            cutoutUndo = snapshot;
            const next = withDerivedPinImage(snapshot, result.dataURL);
            const data = dingData.get(wid)!;
            data.url = next.url;
            data.translation = next.translation;
            data.isTranslate = next.isTranslate;
            img.el.src = next.url;
            pinFx.rot = next.rotation;
            pinFx.flip = next.flip;
            strokes.splice(0, strokes.length, ...next.strokes);
            visualRevision += 1;
            applyPinFx();
            redrawPinStrokes();
            ocrTransStateBar.sv("배경을 제거했습니다 · U로 실행 취소");
            cutoutUndoButton.el.classList.remove(Class.hide);
        } catch {
            if (disposed || generation !== cutoutGeneration) return;
            ocrTransStateBar.sv("배경 제거에 실패했습니다");
            cutoutStatusRetry = () => void runCutout();
            cutoutRetryButton.el.classList.remove(Class.hide);
        } finally {
            if (generation === cutoutGeneration) {
                cutoutBusy = false;
                holdHandle?.setBusy(false);
            }
        }
    };
    const undoCutout = () => {
        if (!cutoutUndo || disposed) return;
        ++cutoutGeneration;
        cutoutBusy = false;
        holdHandle?.setBusy(false);
        restoreVisualSnapshot(cutoutUndo);
        visualRevision += 1;
        cutoutUndo = null;
        cutoutUndoButton.el.classList.add(Class.hide);
        cutoutRetryButton.el.classList.add(Class.hide);
        ocrTransStateBar.el.classList.remove(Class.hide);
        ocrTransStateBar.sv("배경 제거를 실행 취소했습니다");
    };
    const copyPin = async () => {
        await writeImage(await renderPinBlob());
        ocrTransStateBar.el.classList.remove(Class.hide);
        ocrTransStateBar.sv("이미지를 복사했습니다");
    };
    const savePin = async () => {
        renderSend("windowTopest", [false]);
        const path = renderSendSync("save_file_path", ["png"]);
        renderSend("windowTopest", [true]);
        if (!path) return;
        const bytes = Buffer.from(await (await renderPinBlob()).arrayBuffer());
        fs.writeFileSync(path, bytes);
        renderSend("ok_save", [path]);
    };
    const editPin = async () => {
        const bytes = Buffer.from(await (await renderPinBlob()).arrayBuffer());
        renderSend("edit_pic", [bytes]);
    };

    let linkTimer: NodeJS.Timeout | null = null;
    let linkedApp = "";
    disposers.add(() => {
        if (linkTimer) clearInterval(linkTimer);
        linkTimer = null;
    });
    const focusedApp = () => {
        try {
            NodeScreenshots ??= require("node-screenshots");
            const w = NodeScreenshots?.Window.all().find((w) => w.isFocused());
            return w ? { app: w.appName(), pid: w.pid() } : null;
        } catch {
            return null;
        }
    };
    const linkButton = button(iconEl("link"))
        .attr({
            title: "다음에 포커스하는 앱에 연결 (그 앱에서만 핀 표시)",
            ariaPressed: "false",
        })
        .on("click", () => {
            if (linkTimer) {
                clearInterval(linkTimer);
                linkTimer = null;
                div.el.style.visibility = "";
                linkButton.el.style.background = "";
                linkButton.el.setAttribute("aria-pressed", "false");
                return;
            }
            linkedApp = "";
            linkButton.el.style.background = "var(--bar-focus-color)";
            linkButton.el.setAttribute("aria-pressed", "true");
            linkTimer = setInterval(() => {
                const c = focusedApp();
                if (!c) return;
                if (!linkedApp && c.pid !== process.pid) linkedApp = c.app;
                div.el.style.visibility =
                    c.pid === process.pid || c.app === linkedApp
                        ? ""
                        : "hidden";
            }, 700);
        });

    // 滚轮缩放
    div.el.onwheel = (e) => {
        if (e.deltaY !== 0) {
            let zoom = Number(sizeInput.gv) / 100;
            const zz = 1 + Math.abs(e.deltaY) / 300;
            zoom = e.deltaY > 0 ? zoom / zz : zoom * zz;
            if (zoom < 0.05) zoom = 0.05;
            resizeSender = true;
            const d = dxdy(e, e.ctrlKey ? imageP : div);
            resize(wid, zoom, d.dx, d.dy, e.ctrlKey);
            resizeSender = false;
        }
    };

    async function translate() {
        ocrTransStateBar.el.classList.remove(Class.hide);
        ocrTransStateBar.sv("正在OCR识别...");
        const p = await preTranAndOcr(url);
        ocrTransStateBar.sv("正在翻译...");
        try {
            await transAndDraw(div, p);
            ocrTransStateBar.class(Class.hide);
        } catch (error) {
            if (error instanceof UnConfigTranslateError) {
                ocrTransStateBar.sv("未配置翻译引擎");
            } else ocrTransStateBar.sv("翻译失败");
        }
    }

    const transB = button(iconEl("translate"))
        .attr({ title: "翻译" })
        .on("click", async () => {
            const d = dingData.get(wid);
            if (d) {
                const t = d.isTranslate;
                d.isTranslate = !t;
                if (t) {
                    div.query("canvas")?.style({ display: "none" });
                } else {
                    if (!d.translation) {
                        await translate();
                    }
                    div.query("canvas")?.style({ display: "" });
                }
                visualRevision += 1;
            }
        });
    // 工具栏
    const focusButton = button(iconEl("select_all"))
        .attr({
            title: "이 핀만 보기",
            ariaLabel: "이 핀만 보기",
            ariaPressed: "false",
        })
        .on("click", () => {
            sendPinShare({ type: "focus", id: wid });
        });
    focusButtons.set(wid, focusButton.el);
    const blinkButton = button(iconEl("hide"))
        .attr({
            title: "원본과 깜빡 비교",
            ariaLabel: "원본과 깜빡 비교",
            ariaPressed: "false",
        })
        .on("click", () => {
            sendPinShare({ type: "blink", id: wid });
        });
    blinkButtons.set(wid, blinkButton.el);
    const ignoreButton = button(iconEl("ignore"))
        .attr({
            title: "클릭 통과",
            ariaLabel: "클릭 통과",
            ariaPressed: "false",
        })
        .on("click", () => {
            sendPinShare({
                type: "ignore",
                id: wid,
                value: !ignoredPins.has(wid),
            });
        });
    ignoreButtons.set(wid, ignoreButton.el);
    const ocrTextButton = button(iconEl("ocr"))
        .attr({ title: "텍스트 복사", ariaLabel: "텍스트 복사" })
        .on("click", async () => {
            ocrTransStateBar.el.classList.remove(Class.hide);
            ocrTransStateBar.sv("텍스트 인식 중…");
            try {
                await initOCR();
                const p = await ocr(getUrl(wid));
                const text = p
                    .map((i) => i.parse.text)
                    .join("\n")
                    .trim();
                await writeText(text || " ");
                ocrTransStateBar.sv("텍스트를 복사했습니다");
            } catch {
                ocrTransStateBar.sv("텍스트 인식에 실패했습니다");
            }
        });

    const rotateButton = button(iconEl("reload"))
        .attr({ title: "90° 회전" })
        .on("click", () => {
            pinFx.rot = (pinFx.rot + 90) % 360;
            visualRevision += 1;
            applyPinFx();
        });
    const mirrorButton = button(iconEl("mirror"))
        .attr({ title: "좌우 반전" })
        .on("click", () => {
            pinFx.flip = !pinFx.flip;
            visualRevision += 1;
            applyPinFx();
        });
    const saveButton = button(iconEl("save"))
        .attr({ title: "저장  Ctrl+S" })
        .on("click", () => void savePin());
    const minimizeButton = button(iconEl("minimize"))
        .attr({ title: "숨기기" })
        .on("click", () => minimize(div.el));
    const backButton = button(iconEl("back"))
        .attr({ title: "원본 위치로 돌아가기" })
        .on("click", () => back(wid));
    const copyButton = button(iconEl("copy"))
        .attr({ title: "복사  Ctrl+C", ariaLabel: "이미지 복사" })
        .on("click", () => void copyPin());
    const editButton = button(iconEl("free_draw"))
        .attr({ title: "편집  E", ariaLabel: "편집기에서 열기" })
        .on("click", () => void editPin());
    const cutoutButton = button(iconEl("cut"))
        .attr({ title: "배경 제거  X", ariaLabel: "배경 제거" })
        .on("click", () => void runCutout());
    drawButton.attr({ title: "그리기  D", ariaLabel: "핀 위에 그리기" });
    focusButton.attr({ title: "이 핀만 보기  F" });
    const closeButton = button(iconEl("close"))
        .attr({ title: "닫기  Esc", ariaLabel: "핀 닫기" })
        .on("click", () => close(wid));
    const moreButton = button(iconEl("setting"))
        .attr({
            title: "크기와 투명도",
            ariaLabel: "크기와 투명도",
            ariaExpanded: "false",
        })
        .on("click", () => {
            const open = controlsPanel.el.classList.toggle("is-open");
            moreButton.el.setAttribute("aria-expanded", String(open));
            toolBarC.sv({ forceShow: open });
            updateToolbarPlacement();
        });
    const coreActions = view("x")
        .class("pin-core-actions", toolBarButtonsClass)
        .add([
            copyButton,
            editButton,
            drawButton,
            focusButton,
            moreButton,
            closeButton,
        ]);
    toolBarC.add([controlsPanel, coreActions]);

    const radialMenu = view()
        .class("pin-radial-menu")
        .attr({ role: "menu", ariaLabel: "핀 도구", ariaHidden: "true" });
    const radialCenter = button(iconEl("close"))
        .class("pin-radial-center")
        .attr({ title: "도구 닫기", ariaLabel: "도구 닫기" });
    radialMenu.add(radialCenter);
    let radialOpen = false;
    const closeRadial = () => {
        if (!radialOpen) return;
        radialOpen = false;
        radialMenu.el.classList.remove("is-open");
        radialMenu.el.setAttribute("aria-hidden", "true");
    };
    const radialActions: {
        label: string;
        icon: IconType;
        run: () => void;
        active?: () => boolean;
    }[] = [
        {
            label: "배경 제거",
            icon: "cut" as IconType,
            run: () => cutoutButton.el.click(),
            active: () => cutoutBusy,
        },
        {
            label: "배경 제거 실행 취소",
            icon: "back" as IconType,
            run: undoCutout,
            active: () => cutoutUndo !== null,
        },
        {
            label: "번역",
            icon: "translate" as IconType,
            run: () => transB.el.click(),
        },
        {
            label: "깜빡 비교",
            icon: "hide",
            run: () => blinkButton.el.click(),
            active: () => blinkState.isActive(wid),
        },
        {
            label: "클릭 통과",
            icon: "ignore",
            run: () => ignoreButton.el.click(),
            active: () => ignoredPins.has(wid),
        },
        {
            label: "텍스트 복사",
            icon: "ocr" as IconType,
            run: () => ocrTextButton.el.click(),
        },
        {
            label: "90° 회전",
            icon: "reload" as IconType,
            run: () => rotateButton.el.click(),
        },
        {
            label: "좌우 반전",
            icon: "mirror" as IconType,
            run: () => mirrorButton.el.click(),
        },
        {
            label: "앱에 연결",
            icon: "link",
            run: () => linkButton.el.click(),
            active: () => linkTimer !== null,
        },
        {
            label: "저장",
            icon: "save" as IconType,
            run: () => saveButton.el.click(),
        },
        {
            label: "숨기기",
            icon: "minimize" as IconType,
            run: () => minimizeButton.el.click(),
        },
        {
            label: "원위치",
            icon: "back" as IconType,
            run: () => backButton.el.click(),
        },
    ];
    const radialButtons = radialActions.map((action, index) =>
        button(iconEl(action.icon))
            .class("pin-radial-action")
            .attr({
                title: action.label,
                ariaLabel: action.label,
                role: "menuitem",
            })
            .on("click", () => {
                action.run();
                radialButtons[index].el.setAttribute(
                    "aria-pressed",
                    String(action.active?.() ?? false),
                );
                closeRadial();
            }),
    );
    radialMenu.add(radialButtons);
    div.add(radialMenu);
    const openRadial = (x: number, y: number) => {
        const layout = radialLayout(
            { x, y },
            { width: window.innerWidth, height: window.innerHeight },
            radialButtons.length,
            34,
        );
        const bounds = div.el.getBoundingClientRect();
        radialCenter.style({
            left: `${layout.center.x - bounds.left}px`,
            top: `${layout.center.y - bounds.top}px`,
        });
        radialButtons.forEach((item, index) =>
            item
                .attr({
                    ariaPressed: String(
                        radialActions[index].active?.() ?? false,
                    ),
                })
                .style({
                    left: `${layout.points[index].x - bounds.left}px`,
                    top: `${layout.points[index].y - bounds.top}px`,
                    "--pin-radial-delay": `${index * 18}ms`,
                }),
        );
        radialOpen = true;
        radialMenu.el.setAttribute("aria-hidden", "false");
        radialMenu.el.classList.add("is-open");
        radialCenter.el.focus();
    };
    radialCenter.on("click", closeRadial);
    imageP.el.addEventListener("contextmenu", (event) => {
        if (drawMode && event.shiftKey) {
            visualRevision += 1;
            strokes.length = 0;
            redrawPinStrokes();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        openRadial(event.clientX, event.clientY);
    });
    div.el.addEventListener("pointerdown", (event) => {
        const target = event.target as Node;
        if (radialOpen && !radialMenu.el.contains(target)) closeRadial();
        if (
            controlsPanel.el.classList.contains("is-open") &&
            !toolBarC.el.contains(target)
        ) {
            controlsPanel.el.classList.remove("is-open");
            moreButton.el.setAttribute("aria-expanded", "false");
            toolBarC.sv({ forceShow: false });
        }
    });

    const ocrTransStateBarText = txt();
    const cutoutRetryButton = button(txt("재시도"))
        .class(Class.hide)
        .attr({ title: "배경 제거 다시 시도" })
        .on("click", () => {
            cutoutRetryButton.el.classList.add(Class.hide);
            cutoutStatusRetry?.();
        });
    const cutoutUndoButton = button(txt("실행 취소"))
        .class(Class.hide)
        .attr({ title: "배경 제거 실행 취소" })
        .on("click", undoCutout);
    const ocrTransStateBar = view("x")
        .class(Class.glassBar)
        .class(Class.hide)
        .style({
            padding: "4px",
            gap: "4px",
            bottom: "4px",
            borderRadius: "4px",
            alignItems: "center",
            position: "absolute",
            zIndex: 2,
            left: "50%",
            transform: "translateX(-50%)",
        })
        .add([
            ocrTransStateBarText,
            cutoutRetryButton,
            cutoutUndoButton,
            button(iconEl("close"))
                .attr({ title: "关闭" })
                .on("click", () => {
                    ocrTransStateBar.class(Class.hide);
                }),
        ])
        .bindSet((v: string) => {
            ocrTransStateBarText.sv(v);
        });
    // 双击行为
    div.el.ondblclick = () => {
        if (store.get("贴图.窗口.双击") === "归位") back(wid);
        else close(wid);
    };
    // 放到前面
    div.el.onclick = () => {
        div.el.style.zIndex = String(toppest + 1);
        dockEl.el.style.zIndex = String(toppest + 2);
        toppest += 1;
        markSessionDirty();
    };
    // 快捷键
    div.on("keydown", (e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "Escape") {
            if (radialOpen) {
                closeRadial();
            } else if (controlsPanel.el.classList.contains("is-open")) {
                controlsPanel.el.classList.remove("is-open");
                moreButton.el.setAttribute("aria-expanded", "false");
                toolBarC.sv({ forceShow: false });
            } else if (drawMode) {
                drawButton.el.click();
            } else if (focusState.isActive || blinkState.isAnyActive) {
                sendPinShare({ type: "restore" });
            } else {
                close(wid);
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            e.preventDefault();
            void copyPin();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void savePin();
        }
        if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "d") {
            drawButton.el.click();
        }
        if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "e") {
            void editPin();
        }
        if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
            focusButton.el.click();
        }
        if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "x") {
            void runCutout();
        }
        if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "u") {
            undoCutout();
        }
        if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            const dx =
                e.key === "ArrowLeft"
                    ? -step
                    : e.key === "ArrowRight"
                      ? step
                      : 0;
            const dy =
                e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            if (dx || dy) {
                div.el.style.left = `${div.el.offsetLeft + dx}px`;
                div.el.style.top = `${div.el.offsetTop + dy}px`;
                markSessionDirty();
            }
        }
        if (!Number.isNaN(Number(e.key))) {
            transform(wid, Number(e.key) - 1);
        }
    });
    div.add(toolBar).add(imageP).add(ocrTransStateBar);
    holdHandle = createImageHold(img.el, {
        durationMs: 650,
        moveTolerance: 8,
        progressLabel: "길게 눌러 배경 제거",
        disabled: () => drawMode || cutoutBusy,
        onHold: () => runCutout(),
        onDragStart: ({ event }) => {
            resizeSender = true;
            const { dx, dy } = dxdy(event, div);
            renderSend("dingShare", [
                {
                    type: "move_start",
                    more: {
                        id: wid,
                        dx,
                        dy,
                        d: dire(div.el, {
                            x: event.clientX,
                            y: event.clientY,
                        }),
                    },
                },
            ]);
        },
    });
    disposers.add(() => {
        disposed = true;
        ++cutoutGeneration;
        holdHandle?.dispose();
        holdHandle = null;
    });
    photoEl.add(div);
    updateToolbarPlacement();
    applyFocusChanges(focusState.reconcile(readPinVisibility()));

    // dock
    dockI();

    resize(wid, 1, 0, 0);

    if (type === "translate") {
        translate();
    }

    return {
        opacity: (v: string) => opacityEl.sv(v),
        size: (v: string) => {
            sizeInput.sv(v);
            sizeRange.sv(
                String(Math.max(10, Math.min(300, Number.parseInt(v) || 100))),
            );
        },
        id: wid,
    };
};

async function preTranAndOcr(url: string) {
    translateE = loadTranslator(store);
    await initOCR();
    const p = await ocr(url);
    return p;
}

async function initOCR() {
    if (!lo) {
        const x = loadOCR(store, store.get("OCR.类型") || defaultOcrId);
        if (x) lo = await x.ocr.init(x.config);
    }
}

renderOn("dingMouse", ([x, y]) => {
    const els = document.elementsFromPoint(x, y);
    let ignorex = false;
    for (const el of ignoreEl) {
        if (els.includes(el)) {
            ignorex = true;
            break;
        }
    }
    if (els[0] === photoEl.el || ignorex) {
        renderSend("dingIgnore", [true]);
    } else {
        renderSend("dingIgnore", [false]);
    }

    mouseMove(els[0] as HTMLElement, x, y);
});

function sendPinShare(message: PinShareMessage) {
    renderSend("dingShare", [message as never]);
}

function readPinVisibility() {
    return Array.from(dingData.keys(), (id) => ({
        id,
        visible: elFromId(id)?.el.style.visibility !== "hidden",
    }));
}

function applyFocusChanges(changes: ReturnType<PinFocusState["restore"]>) {
    for (const { id, visible } of changes) {
        const el = elFromId(id)?.el;
        if (el) el.style.visibility = visible ? "" : "hidden";
    }
}

function syncPinToggleButtons() {
    for (const [id, button] of focusButtons) {
        const active = focusState.activeId === id;
        button.setAttribute("aria-pressed", String(active));
        button.classList.toggle(pinToggleActiveClass, active);
    }
    for (const [id, button] of blinkButtons) {
        const active = blinkState.isActive(id);
        button.setAttribute("aria-pressed", String(active));
        button.classList.toggle(pinToggleActiveClass, active);
    }
    for (const [id, button] of ignoreButtons) {
        const active = ignoredPins.has(id);
        button.setAttribute("aria-pressed", String(active));
        button.classList.toggle(pinToggleActiveClass, active);
    }
}

function setPinIgnore(id: string, value: boolean) {
    if (value) ignoredPins.add(id);
    else ignoredPins.delete(id);
    ignore(id, value);
    syncPinToggleButtons();
}

function toggleFocus(id: string) {
    applyFocusChanges(focusState.toggle(id, readPinVisibility()));
    syncPinToggleButtons();
}

function toggleBlink(id: string) {
    blinkState.toggle(id);
    syncPinToggleButtons();
}

function restorePinEffects() {
    ignoreEl = [];
    ignoredPins.clear();
    applyFocusChanges(focusState.restore());
    blinkState.clear();
    syncPinToggleButtons();
    renderSend("dingIgnore", [false]);
    dockI();
}

window.addEventListener("beforeunload", () => {
    for (const disposers of pinDisposers.values())
        for (const dispose of disposers) dispose();
    pinDisposers.clear();
    blinkState.clear();
});

function minimize(el: HTMLElement) {
    el.style.transition = cssVar("transition");
    setTimeout(() => {
        el.style.transition = "";
    }, 400);
    el.classList.add(minimizeClass);
}
let ignoreEl: HTMLElement[] = [];
function ignore(id: string, v: boolean) {
    const el = elFromId(id)?.el;
    if (!el) return;
    if (v) {
        ignoreEl.push(el);
    } else {
        ignoreEl = ignoreEl.filter((e) => e !== el);
    }
}
const tranStyle = document.createElement("style");
for (const [i, t] of store.get("贴图.窗口.变换").entries()) {
    tranStyle.innerHTML += `.tran${i}{${t}}`;
}
document.body.appendChild(tranStyle);
/**
 * 窗口变换
 */
function transform(id: string, i: number) {
    const c = `tran${i}`;
    const img = elFromId(id)?.query(".img")?.el;
    if (!img) return;
    if (i >= 0 && i < store.get("贴图.窗口.变换").length) {
        img.classList.toggle(c);
    }
    const l = Array.from(img.classList.values());
    for (const t of l) {
        if (t.startsWith("tran") && t !== c) {
            img.classList.remove(t);
        }
    }
}
function back(id: string) {
    renderSend("dingShare", [{ type: "back", id }]);
}
function back2(id: string) {
    const el = elFromId(id);
    if (!el) return;
    const pS = dingData.get(id)?.rect;
    if (!pS) return;
    el.el.style.transition = cssVar("transition");
    setTimeout(() => {
        el.el.style.transition = "";
        resizeSender = true;
        resize(id, 1, 0, 0);
        resizeSender = false;
    }, 400);
    el.style({
        left: `${pS[0]}px`,
        top: `${pS[1]}px`,
        width: `${pS[2]}px`,
        height: `${pS[3]}px`,
    });
    el.query(".img")?.style({
        left: "0",
        top: "0",
        width: "100%",
        height: "",
    });

    const x = elMap.find((e) => e.id === id);
    if (!x) return;
    x.opacity("100");
}
function close(id: string) {
    renderSend("dingShare", [
        { type: "close", id, closeAll: dingData.size === 1 },
    ]);
}
function close2(id: string) {
    const disposers = pinDisposers.get(id);
    if (disposers) for (const dispose of disposers) dispose();
    pinDisposers.delete(id);
    blinkState.stop(id);
    applyFocusChanges(focusState.remove(id));
    focusButtons.delete(id);
    blinkButtons.delete(id);
    ignoreButtons.delete(id);
    ignoredPins.delete(id);
    elFromId(id)?.remove();
    dingData.delete(id);
    elMap = elMap.filter((e) => e.id !== id);
    markSessionDirty();
    dockI();
}
function getUrl(id: string) {
    const data = dingData.get(id);
    if (!data) return "";
    const _isTranslate = data.isTranslate;
    return _isTranslate ? data.translation : data.url;
}
async function ocr(img: string) {
    const p = await lo.ocr(img);
    return p.columns.flatMap((c) => c.parragraphs);
}

class UnConfigTranslateError extends Error {}

async function transAndDraw(
    el: ElType<HTMLElement>,
    p: Awaited<ReturnType<typeof ocr>>,
) {
    const data = dingData.get(el.el.id);
    if (!data) return;
    const image = el.query(".img > img")!.el;
    const canvas = ele("canvas")
        .attr({
            width: image.naturalWidth,
            height: image.naturalHeight,
        })
        .style({ position: "absolute", pointerEvents: "none" })
        // @ts-ignore
        .addInto(el.query(".img")).el;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    console.log(p);
    if (!translateE) throw new UnConfigTranslateError();
    const tr = await translateE(p.map((i) => i.parse.text));
    console.log(tr);

    for (const [i, t] of tr.entries()) {
        const x = p[i];
        if (t !== x.parse.text) drawText(t, ctx, x.parse.box, x.src);
    }
    // todo 多屏
    data.translation = canvas.toDataURL("image/png", 1);
    data.isTranslate = true;
}

function distance(a: [number, number], b: [number, number]) {
    return Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
}

function drawText(
    text: string,
    ctx: CanvasRenderingContext2D,
    box: Awaited<ReturnType<typeof ocr>>[0]["parse"]["box"],
    boxSrc: Awaited<ReturnType<typeof ocr>>[0]["src"],
) {
    const textList = Array.from(seg.segment(text));

    const firstline = boxSrc[0].box;
    const lineHeight = distance(firstline[3], firstline[0]);
    const lineNum = boxSrc.length;
    let fontSize = lineHeight;
    ctx.font = `${fontSize}px serif`;
    const textWidth = ctx.measureText(text).width;
    const boxWidth = distance(box[1], box[0]);
    const boxHeight = distance(box[3], box[0]);
    const oneLineWidth = boxWidth * lineNum;
    if (textWidth > oneLineWidth) {
        fontSize = Math.floor((fontSize * oneLineWidth) / textWidth);
        ctx.font = `${fontSize}px serif`;
    }

    const gap =
        lineNum === 1 ? 0 : (boxHeight - lineHeight * lineNum) / (lineNum - 1);
    const lines = splitText(textList, ctx, boxWidth); // todo 严格等于lineNum

    for (const b of boxSrc) {
        ctx.fillStyle = color2rgb(b.style.bg);
        ctx.strokeStyle = color2rgb(b.style.bg); // 拓展外边
        ctx.beginPath();
        ctx.moveTo(b.box[0][0], b.box[0][1]);
        ctx.lineTo(b.box[1][0], b.box[1][1]);
        ctx.lineTo(b.box[2][0], b.box[2][1]);
        ctx.lineTo(b.box[3][0], b.box[3][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    const angle = Math.atan2(box[1][1] - box[0][1], box[1][0] - box[0][0]);
    const yBaseVector = [
        (box[3][0] - box[0][0]) / boxHeight,
        (box[3][1] - box[0][1]) / boxHeight,
    ];
    ctx.textBaseline = "top";
    ctx.fillStyle = color2rgb(boxSrc[0].style.text);
    for (const [i, line] of lines.entries()) {
        const yn = i * lineHeight + i * gap;
        const x = box[0][0] + yBaseVector[0] * yn;
        const y = box[0][1] + yBaseVector[1] * yn;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillText(line, 0, 0, boxWidth);
        ctx.restore();
    }
}

function color2rgb(color: number[]) {
    return `rgb(${color.join(",")})`;
}

function splitText(
    text: Intl.SegmentData[],
    ctx: CanvasRenderingContext2D,
    maxWidth: number,
) {
    // todo 性能
    // todo 符号不能在开头
    let line = "";
    const lines: string[] = [];
    for (let i = 0; i < text.length; i++) {
        const t = text[i].segment;
        if (ctx.measureText(line + t).width < maxWidth) {
            line += t;
        } else {
            lines.push(line);
            line = t;
        }
    }
    if (line) {
        lines.push(line);
    }

    return lines.map((l) => l.trimEnd());
}

// 最高窗口
let toppest = 1;
let oPs: number[];
let windowDiv: ElType<HTMLElement> | null = null; // todo 使用id代替

let resizeSender = false;

document.onmousedown = (e) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const div = dives.find((d) => d.el.contains(el));
    const isControl = Boolean(
        el.closest(".pin-toolbar, .pin-radial-menu, .pin-controls-panel"),
    );
    if (el.closest('[data-image-hold="true"]')) return;
    if (div && !isControl && el.tagName === "IMG") {
        const { dx, dy } = dxdy(e, div);
        renderSend("dingShare", [
            {
                type: "move_start",
                more: {
                    id: div.el.id,
                    dx,
                    dy,
                    d: dire(div.el, { x: e.clientX, y: e.clientY }),
                },
            },
        ]);
    }
    resizeSender = true;
};
function mouseStart(op: DingStart) {
    windowDiv = elFromId(op.id);
    const div = windowDiv as ElType<HTMLElement>;
    const {
        po: { x, y },
    } = renderSendSync("getMousePos", []);
    div.style({
        left: `${x - div.el.offsetWidth * op.dx}px`,
        top: `${y - div.el.offsetHeight * op.dy}px`,
    });
    oPs = [
        div.el.offsetLeft,
        div.el.offsetTop,
        div.el.offsetWidth,
        div.el.offsetHeight,
    ];
    changing = { x: x, y: y };
    direction = op.d;
    cursor(direction);
}
function mouseMove(el: HTMLElement, x: number, y: number) {
    if (direction) {
        if (windowDiv) move(windowDiv, { x, y });
    } else {
        const div = dives.find((d) => d.el.contains(el));
        if (div) {
            const d = dire(div.el, { x, y });
            cursor(d);
        } else {
            cursor("");
        }
    }
}
document.onmouseup = (_e) => {
    renderSend("dingShare", [{ type: "move_end" }]);
    resizeSender = false;
};
function mouseEnd() {
    oPs = [];
    changing = null;
    windowDiv = null;
    direction = "";
    markSessionDirty();
    cursor(direction);
}

let direction: Dire = "";

function dire(el: HTMLElement, p: { x: number; y: number }) {
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const pX = p.x - el.offsetLeft;
    const pY = p.y - el.offsetTop;
    let direction: Dire = "";

    const num = 8;

    function w() {
        return 0 <= pX && pX <= num;
    }

    function e() {
        return width - num <= pX && pX <= width;
    }

    function n() {
        return 0 <= pY && pY <= num;
    }

    function s() {
        return height - num <= pY && pY <= height;
    }

    if (0 <= pX && pX <= width && 0 <= pY && pY <= height) {
        if (w() && n()) {
            direction = "西北";
        } else if (w() && s()) {
            direction = "西南";
        } else if (e() && n()) {
            direction = "东北";
        } else if (e() && s()) {
            direction = "东南";
        } else if (w()) {
            direction = "西";
        } else if (e()) {
            direction = "东";
        } else if (n()) {
            direction = "北";
        } else if (s()) {
            direction = "南";
        } else {
            direction = "move";
        }
    } else {
        direction = "";
    }
    return direction;
}

let lastCursor: Dire = "";

function cursor(d: Dire) {
    if (d === lastCursor) return;
    lastCursor = d;
    const m: Record<Dire, string> = {
        西北: "nwse-resize",
        东南: "nwse-resize",
        东北: "nesw-resize",
        西南: "nesw-resize",
        西: "ew-resize",
        东: "ew-resize",
        北: "ns-resize",
        南: "ns-resize",
        move: "default",
        "": "default",
    };
    (document.querySelector("html") as HTMLElement).style.cursor = m[d];
}

function move(el: ElType<HTMLElement>, e: { x: number; y: number }) {
    if (changing != null && oPs.length !== 0) {
        const oE = changing;
        const dx = e.x - oE.x;
        const dy = e.y - oE.y;
        const [ox, oy, ow, oh] = oPs;
        let pS: [number, number, number, number] = [
            Number.NaN,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        ];
        const zp = { x: 0, y: 0 };
        switch (direction) {
            case "西北": {
                const k = -1 / (oh / ow);
                const d =
                    (k * dx - dy) / Math.sqrt(k ** 2 + 1) +
                    Math.sqrt(ow ** 2 + oh ** 2);
                const w = d * Math.cos(Math.atan(oPs[3] / oPs[2]));
                const h = d * Math.sin(Math.atan(oPs[3] / oPs[2]));
                pS = [ox + ow - w, oy + oh - h, w, h];
                zp.x = 1;
                zp.y = 1;
                break;
            }
            case "东南": {
                const k = -1 / (oh / ow);
                const d =
                    -(k * dx - dy) / Math.sqrt(k ** 2 + 1) +
                    Math.sqrt(ow ** 2 + oh ** 2);
                const w = d * Math.cos(Math.atan(oPs[3] / oPs[2]));
                const h = d * Math.sin(Math.atan(oPs[3] / oPs[2]));
                pS = [ox, oy, w, h];
                break;
            }
            case "东北": {
                const k = 1 / (oh / ow);
                const d =
                    (k * dx - dy) / Math.sqrt(k ** 2 + 1) +
                    Math.sqrt(ow ** 2 + oh ** 2);
                const w = d * Math.cos(Math.atan(oPs[3] / oPs[2]));
                const h = d * Math.sin(Math.atan(oPs[3] / oPs[2]));
                pS = [ox, oy + oh - h, w, h];
                zp.y = 1;
                break;
            }
            case "西南": {
                const k = 1 / (oh / ow);
                const d =
                    -(k * dx - dy) / Math.sqrt(k ** 2 + 1) +
                    Math.sqrt(ow ** 2 + oh ** 2);
                const w = d * Math.cos(Math.atan(oPs[3] / oPs[2]));
                const h = d * Math.sin(Math.atan(oPs[3] / oPs[2]));
                pS = [ox + ow - w, oy, w, h];
                zp.x = 1;
                break;
            }
            case "西": {
                const r = (ow - dx) / ow;
                pS = [ox + dx, oy, ow - dx, oh * r];
                zp.x = 1;
                break;
            }
            case "东": {
                const r = (ow + dx) / ow;
                pS = [ox, oy, ow + dx, oh * r];
                break;
            }
            case "北": {
                const r = (oPs[3] - dy) / oh;
                pS = [ox, oy + dy, ow * r, oh - dy];
                zp.y = 1;
                break;
            }
            case "南": {
                const r = (oPs[3] + dy) / oh;
                pS = [ox, oy, ow * r, oh + dy];
                break;
            }
            case "move":
                pS = [ox + dx, oy + dy, ow, oh];
                el.style({
                    left: `${pS[0]}px`,
                    top: `${pS[1]}px`,
                    width: `${pS[2]}px`,
                    height: `${pS[3]}px`,
                });
                pinToolbarPositioners.get(el.el.id)?.();
                return;
        }
        // @ts-ignore
        resize(el.el.id, pS[2] / dingData.get(el.el.id).rect[2], zp.x, zp.y);
    }
}

function dxdy(e: MouseEvent, el: ElType<HTMLElement>) {
    const r = el.el.getBoundingClientRect();
    return {
        dx: (e.clientX - r.left) / el.el.offsetWidth,
        dy: (e.clientY - r.top) / el.el.offsetHeight,
    };
}

function resize(
    id: string,
    zoom: number,
    dx: number,
    dy: number,
    _clip?: boolean,
) {
    const el = elFromId(id);
    if (!el) return;
    const d = dingData.get(id);
    if (!d) return;
    elMap.find((i) => i.id === id)?.size(String(Math.round(zoom * 100)));
    const rect = [
        el.el.offsetLeft,
        el.el.offsetTop,
        el.el.offsetWidth,
        el.el.offsetHeight,
    ];
    const toWidth = d.rect[2] * zoom;
    const toHeight = d.rect[3] * zoom;
    const point = { x: rect[0] + rect[2] * dx, y: rect[1] + rect[3] * dy };
    const x = point.x - toWidth * dx;
    const y = point.y - toHeight * dy;
    const pS = [x, y, toWidth, toHeight];
    const clip = toWidth < rect[2] ? false : _clip;

    if (clip) {
        const style = {
            left: `${pS[0] - rect[0]}px`,
            top: `${pS[1] - rect[1]}px`,
            width: `${pS[2]}px`,
            height: `${pS[3]}px`,
        };
        el.query(".img")?.style(style);
    } else {
        const style = {
            left: 0,
            top: 0,
            width: "100%",
            height: "",
        } as const;
        el.query(".img")?.style(style);
        el.style({
            left: `${pS[0]}px`,
            top: `${pS[1]}px`,
            width: `${pS[2]}px`,
            height: `${pS[3]}px`,
        });
    }

    for (const i of el.queryAll(".img>*")) {
        i.style({ "image-rendering": zoom > 1.5 ? "pixelated" : "initial" });
    }
    pinToolbarPositioners.get(id)?.();
    markSessionDirty();

    if (resizeSender)
        renderSend("dingShare", [
            { type: "resize", more: { id: id, zoom, dx, dy, clip } },
        ]);
}

initDKH({ pureStyle: true });

addStyle({
    body: {
        width: "100vw",
        height: "100vh",
        "--hover-color": "var(--bar-hover-color) !important;",
    },
});

const photoEl = view().style({ width: "100%", height: "100%" }).addInto();

const dingPhotoClass = addClass(
    {},
    {
        "&:hover": {
            boxShadow: "var(--shadow)",
        },
        "&:focus": {
            outline: "none",
        },
    },
);
const dingPhotoHightClass = addClass({ boxShadow: "var(--shadow)" }, {});

const minimizeClass = addClass(
    {
        opacity: "0 !important",
        // @ts-expect-error
        pointerEvents: "none !important",
    },
    {},
);

const toolBarButtonsClass = addClass(
    {},
    {
        "&>button": {
            height: "32px",
        },
    },
);

const pinToggleActiveClass = addClass(
    {
        backgroundColor: "var(--hover-color)",
    },
    {},
);

const toolBarIClass = addClass(
    {},
    {
        "&>div": {
            display: "flex",
            alignItems: "center",
            width: "auto",
        },
    },
);

const imageClass = addClass(
    { position: "relative", width: "100%", userSelect: "none" },
    { "&>*": { width: "100%", top: 0, left: 0 } },
);

const dockP = store.get("ding_dock");

const dockClassSmall = addClass(
    {
        height: "40px",
        width: "12px",
        left: "var(--dock-left)",
        top: "var(--dock-top)",
    },
    {},
);

const dockEl = view()
    .attr({ id: "dock" })
    .bindSet((v: { x: number; y: number }, el) => {
        dockEl.style({
            "--dock-left": `${v.x}px`,
            "--dock-top": `${v.y}px`,
        });
    })
    .style({
        position: "fixed",
        zIndex: "2",
    })
    .class(Class.screenBar)
    .class(dockClassSmall)
    .addInto();
dockEl.sv({ x: dockP[0], y: dockP[1] });

const dockClassBigLeft = addClass(
    {
        height: "100%",
        width: "200px",
        top: "0",
        left: "0",
        borderRadius: "0",
    },
    {},
);

const dockClassBigRight = addClass(
    {
        height: "100%",
        width: "200px",
        top: "0",
        left: "calc(100vw - 200px)",
        borderRadius: "0",
    },
    {},
);
const dockView = view()
    .style({
        overflowX: "hidden",
        overflowY: "auto",
        width: "100%",
        display: "none",
    })
    .addInto(dockEl);

let dockShow = false;

trackPoint(dockEl, {
    start: () => {
        dockEl.el.style.transition = "0s";
        return { x: dockEl.el.offsetLeft, y: dockEl.el.offsetTop };
    },
    ing: (p) => {
        dockEl.sv(p);
        return p;
    },
    end: (_, { moved, ingData }) => {
        if (!moved) {
            showDock();
        } else {
            store.set("ding_dock", [ingData.x, ingData.y]);
        }
        dockEl.el.style.transition = cssVar("transition");
    },
});

const showDock = () => {
    dockShow = !dockShow;
    if (dockShow) {
        if (
            dockEl.el.offsetLeft + 5 <=
            // @ts-ignore
            document.querySelector("html").offsetWidth / 2
        ) {
            dockEl.el.classList.remove(dockClassBigRight);
            dockEl.el.classList.add(dockClassBigLeft);
        } else {
            dockEl.el.classList.remove(dockClassBigLeft);
            dockEl.el.classList.add(dockClassBigRight);
        }
        dockView.style({ display: "block" });
    } else {
        dockEl.el.classList.remove(dockClassBigLeft);
        dockEl.el.classList.remove(dockClassBigRight);
        dockEl.el.style.transition = "";
        dockView.style({ display: "none" });
    }
};

// 刷新dock
function dockI() {
    dockView.clear();
    for (const i of dingData.keys()) {
        let iIgnore_v = false;
        let iTran_v = -1;

        const dockItem = view();
        const iPhoto = image(getUrl(i), t("미리보기"))
            .style({ width: "100%" })
            .on("click", () => {
                const div = document.getElementById(i);
                if (div?.classList.contains(minimizeClass)) {
                    div.style.transition = cssVar("transition");
                    setTimeout(() => {
                        div.style.transition = "";
                    }, 400);
                    div.classList.remove(minimizeClass);
                } else {
                    back(i);
                }
                if (div) div.style.zIndex = String(toppest + 1);
                toppest += 1;
            });
        const iClose = view()
            .add(iconEl("close"))
            .attr({ title: "关闭" })
            .on("click", () => {
                close(i);
            });
        const iIgnore = view()
            .add(iconEl("ignore"))
            .attr({ title: "鼠标穿透" })
            .on("click", () => {
                iIgnore_v = !iIgnore_v;
                ignore(i, iIgnore_v);
            });
        const iTran = view()
            .add(iconEl("replace"))
            .attr({ title: "窗口变换" })
            .on("click", () => {
                iTran_v = iTran_v === -1 ? 0 : -1;
                transform(i, iTran_v);
            });

        dockItem
            .add([
                view("x")
                    .add([iTran, iIgnore, iClose])
                    .style({
                        position: "absolute",
                        right: "8px",
                        borderRadius: cssVar("o-padding"),
                    })
                    .class(Class.smallSize, Class.glassBar),
                iPhoto,
            ])
            .addInto(dockView);
    }
}
renderOn("addDing", ([wid, x, y, w, h, url, type]) => {
    elMap.push(setNewDing(String(wid), x, y, w, h, url, type));
    markSessionDirty();
});

function collectSessionPins(): SavedDingPin[] {
    const pins: SavedDingPin[] = [];
    for (const [id, data] of dingData) {
        const el = elFromId(id)?.el;
        const img = el?.querySelector<HTMLImageElement>(".img > img");
        if (!el || !img || !data.url.startsWith("data:image/")) continue;
        pins.push({
            x: el.offsetLeft,
            y: el.offsetTop,
            w: el.offsetWidth,
            h: el.offsetHeight,
            src: data.url,
            opacity: Number(img.style.opacity || 1),
            z: Number(el.style.zIndex || 0),
        });
    }
    return pins;
}

setInterval(() => {
    if (!sessionDirty) return;
    sessionDirty = false;
    void ipcRenderer
        .invoke("ding:session:save", collectSessionPins())
        .catch(() => {
            sessionDirty = true;
        });
}, 2500);

void ipcRenderer
    .invoke("ding:session:get")
    .then((pins: SavedDingPin[]) => {
        if (!Array.isArray(pins) || !pins.length) return;
        for (const [index, pin] of pins.entries()) {
            const entry = setNewDing(
                `restored-${Date.now()}-${index}`,
                pin.x,
                pin.y,
                pin.w,
                pin.h,
                pin.src,
                "ding",
            );
            entry.opacity(String(Math.round(pin.opacity * 100)));
            const el = elFromId(entry.id)?.el;
            if (el) el.style.zIndex = String(pin.z);
            elMap.push(entry);
        }
        toppest = Math.max(toppest, ...pins.map((p) => p.z)) + 1;
    })
    .catch(() => {});

let seg: Intl.Segmenter;
try {
    seg = new Intl.Segmenter(
        store.get("屏幕翻译.语言.to") ?? navigator.language ?? "zh-HANS",
        {
            granularity: "word",
        },
    );
} catch (error) {
    seg = new Intl.Segmenter("zh-HANS", {
        granularity: "word",
    });
}
