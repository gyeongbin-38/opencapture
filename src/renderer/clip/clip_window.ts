/// <reference types="vite/client" />

import type * as Crypto from "node:crypto";
import chroma from "chroma-js";
import hotkeys from "hotkeys-js";
import {
    captureDock,
    fitCaptureToolbar,
    radialLayout,
} from "../../../lib/captureControls";
import { ele2jsKeyCode, jsKeyCodeDisplay } from "../../../lib/key";
import open_with from "../../../lib/open_with";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import { writeImage, writeText } from "../lib/clipboard";
import { Class, cssColor, getImgUrl, initStyle, setTitle } from "../root/root";

import { EraserBrush } from "@erase2d/fabric";
import {
    ActiveSelection,
    Canvas,
    Circle,
    type CircleProps,
    FabricImage,
    type FabricObject,
    IText,
    Line,
    PencilBrush,
    type Point,
    Polygon,
    Polyline,
    Rect,
    type RectProps,
    Shadow,
    SprayBrush,
    classRegistry,
    filters,
} from "fabric";
import initScreenShots from "../screenShot/screenShot";
const screenShots = initScreenShots(
    { c: store.get("额外截屏器.命令"), path: store.get("额外截屏器.位置") },
    undefined,
    t,
    store.get("使用XDGDesktopPortal"),
);

import {
    type ElType,
    button,
    ele,
    frame,
    image,
    input,
    p,
    pack,
    setProperties,
    trackPoint,
    txt,
    view,
} from "dkh-ui";
import { DEFAULT_CAPTURE_EXPERIENCE } from "../../../lib/captureExperience";
import {
    type CaptureSelectionEdge,
    type CaptureSelectionMode,
    selectionEdgesForMode,
    snapDragRect,
    windowBoundsToCanvas,
    windowEdgeAtPoint,
} from "../../../lib/captureWindowSelection";
import { renderOn, renderSend, renderSendSync } from "../../../lib/ipc";
import type {
    CaptureExperiencePreferences,
    CaptureSourceContext,
    CaptureToolId,
    OcrTextLine,
} from "../../../lib/openCaptureTypes";
import { filterSensitiveLines } from "../../../lib/redact";
import { typedEntries, typedKeys } from "../../../lib/utils";
import type {
    EditType,
    setting,
    translateWinType,
    功能,
    功能列表,
} from "../../ShareTypes.js";
import type { IconType } from "../../iconTypes";
import xhistory from "../lib/history";
import { defaultOcrId, loadOCR } from "../ocr/ocr";
import { ocrList } from "../ocr/ocr_omni";
import { createCaptureWorkspace } from "./captureWorkspace";
import {
    LatestLiveTranslation,
    normalizeTranslatedTexts,
} from "./openCaptureLiveTranslation";

const { ipcRenderer } = require("electron") as typeof import("electron");

type SrcPoint = { x: number; y: number } & { readonly _: unique symbol };

initStyle(store);
let captureWorkspace: ReturnType<typeof createCaptureWorkspace> | null = null;
let capturePreferences: CaptureExperiencePreferences = structuredClone(
    DEFAULT_CAPTURE_EXPERIENCE,
);
let captureSourceContext: CaptureSourceContext = {
    kind: "capture",
    capturedAt: new Date().toISOString(),
};
let immutableSourceData: string | undefined;
let captureInitSequence = 0;
let screenRequestSequence = 0;
let captureInitQueue: Promise<void> = Promise.resolve();
let batchRegions: rect[] = [];
let selectionBeforeDrag: {
    rect: rect;
    points: point[];
    manual: boolean;
} | null = null;
let handleDrag: {
    handle: HTMLButtonElement;
    pointerId: number;
    rect: rect;
    origin: editor_position;
} | null = null;
let gestureOrigin: {
    x: number;
    y: number;
    moved: boolean;
    target: CaptureTool | null;
    pointerId: number;
} | null = null;
let suppressContextUntil = 0;

const captureIconPaths: Record<string, string> = {
    stage: '<rect x="3" y="3" width="14" height="14" rx="3"/><path d="M6 10h8m-4-4v8"/>',
    compare:
        '<rect x="2" y="4" width="7" height="12" rx="2"/><rect x="11" y="4" width="7" height="12" rx="2"/>',
    textselect: '<path d="M3 3h14v3M10 3v14m-4 0h8"/>',
    promote: '<path d="M2 6h6l2-3h8v14H2zM7 11l2 2 4-4"/>',
    trash: '<path d="M3 5h14M7 5V2h6v3M5 5l1 13h8l1-13M8 8v7m4-7v7"/>',
    copy: '<rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
    save: '<path d="M10 2v10m-4-4 4 4 4-4M3 13v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
    draw: '<path d="m3 14 9-9 3 3-9 9-4 1 1-4Zm9-9 2-2a2 2 0 0 1 3 3l-2 2"/>',
    ding: '<path d="m7 2 6 0-1 5 3 3v2H5v-2l3-3-1-5Zm3 10v6"/>',
    ocrcopy:
        '<path d="M4 3H2v4m14-4h2v4M2 13v4h4m12-4v4h-4M6 6h8M10 6v8m-3 0h6"/>',
    ocr: '<path d="M4 3H2v4m14-4h2v4M2 13v4h4m12-4v4h-4M6 6h8M10 6v8m-3 0h6"/>',
    translate:
        '<path d="M2 4h9M7 2v2M4 4c0 5 6 8 6 8M10 4c0 4-4 7-7 8m8 5 3-8 3 8m-5-3h4"/>',
    color: '<path d="m5 15 8-8 2 2-8 8H3v-4l2 2ZM12 4l4 4m-2-5a2 2 0 0 1 3 3l-2 2-3-3 2-2Z"/>',
    redact: '<rect x="2" y="4" width="16" height="12" rx="2"/><path d="M5 8h10M5 12h10"/>',
    search: '<circle cx="8" cy="8" r="5"/><path d="m12 12 5 5"/>',
    QR: '<path d="M2 2h6v6H2zM12 2h6v6h-6zM2 12h6v6H2zM12 12h2v2h4v4h-6v-2"/>',
    editor: '<path d="M3 5h14v12H3zM3 13l4-4 3 3 2-2 5 5"/><circle cx="13" cy="8" r="1"/>',
    record: '<rect x="2" y="4" width="11" height="12" rx="2"/><path d="m13 8 5-3v10l-5-3"/>',
    long: '<rect x="3" y="2" width="14" height="16" rx="2"/><path d="M10 5v10m-3-3 3 3 3-3"/>',
    screens:
        '<rect x="2" y="3" width="16" height="11" rx="2"/><path d="M7 18h6m-3-4v4"/>',
    open: '<path d="M9 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5M11 2h7v7m0-7-9 9"/>',
    more: '<circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/>',
    close: '<path d="m5 5 10 10M15 5 5 15"/>',
    lock: '<rect x="4" y="8" width="12" height="10" rx="2"/><path d="M7 8V5a3 3 0 0 1 6 0v3M10 12v2"/>',
    position: '<path d="M10 2v16M2 10h16"/><circle cx="10" cy="10" r="5"/>',
};

function captureIcon(name: string) {
    const icon = view().class("capture-icon").attr({ ariaHidden: "true" });
    icon.el.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${captureIconPaths[name] ?? captureIconPaths.more}</svg>`;
    return icon;
}

function iconEl(src: IconType) {
    return view().add(
        image(getImgUrl(`${src}.svg`), "icon")
            .class("icon")
            .attr({ width: bSize }),
    );
}

function selectEl<i extends string>(
    el: ElType<HTMLElement>,
    title: string,
    data: { name: string; value: i }[],
) {
    let value = data[0].value;
    const valueMap = new Map(
        data.map((i) => [
            i.value,
            view()
                .add(i.name)
                .on("click", () => {
                    setV(i.value);
                    change();
                }),
        ]),
    );

    function change() {
        el.el.dispatchEvent(new CustomEvent("change"));
        selectEl.remove();
        selectEl.el.hidePopover();
    }

    function setV(v: i) {
        value = data.find((i) => i.value === v)?.value ?? data[0].value;
        el.data({
            title: `${title} - ${data.find((i) => i.value === value)?.name ?? ""}`,
        });
    }

    function showList() {
        for (const [v, el] of valueMap) {
            el.el.classList.remove("selected");
            if (v === value) el.el.classList.add("selected");
        }
        const rect = handleEl.el.getBoundingClientRect();
        selectEl
            .clear()
            .addInto()
            .add(Array.from(valueMap.values()))
            .style({
                position: "fixed",
                zIndex: 9999,
                top: `${rect.top}px`,
                left: `${rect.left}px`,
                margin: 0,
            });
        selectEl.el.showPopover();
    }

    const selectEl = view().attr({ popover: "auto" }).class("side_select_menu");
    const handleEl = view()
        .addInto(el)
        .on("click", showList)
        .class("side_select");

    el.on("pointerup", (e) => {
        if (e.button === 2) showList();
    });

    return el
        .bindGet(() => value)
        .bindSet((v: i) => {
            setV(v);
        });
}

function rangeBar(
    _min: number | undefined,
    _max: number | undefined,
    _step: number | undefined,
    text = "",
) {
    const min = _min ?? 0;
    const max = _max ?? 100;
    const step = _step ?? 1;

    let type: "edit" | "move" = "move";

    const p = view().style({
        "align-content": "center",
        position: "relative",
        cursor: "ew-resize",
    });
    const bar = view().style({
        position: "absolute",
        top: "0",
        height: "100%",
        background: "var(--bar-focus-color)",
        borderRadius: "inherit",
        zIndex: "-1",
    });
    const i = input()
        .style({
            // @ts-ignore
            "field-sizing": "content",
            "line-height": "1",
            height: "auto",
        })
        .on("input", () => {
            setV(Number.parseFloat(i.gv), true);
        })
        .on("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                setV(Number.parseFloat(i.gv));
                useI(false);
                valueHistory.push(value);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setV(value + step);
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setV(value - step);
            }
        })
        .on("blur", () => {
            setV(Number.parseFloat(i.gv));
            useI(false);
            valueHistory.push(value);
        })
        .on("mousedown", (e) => {
            if (e.button === 2 && valueHistory.length) {
                e.preventDefault();
                setV(valueHistory.pop() as number);
            }
        });

    useI(false);
    p.add(
        view("x").add([i, text]).style({
            "justify-content": "center",
        }),
    )
        .add(bar)
        .class("range-b")
        .class(Class.mono);

    function useI(b: boolean) {
        i.attr({ disabled: !b }).style({
            "pointer-events": b ? "all" : "none",
        });
        type = b ? "edit" : "move";
        if (b) i.el.focus();
    }

    let value = min;

    const valueHistory: number[] = [value];

    const range = max - min;

    function setV(v: number, noInput = false, event = true) {
        value = vFix(v);
        setBar(value);
        if (!noInput) i.sv(String(value));
        if (event) inputEvent();
    }

    trackPoint(p, {
        start: () => {
            if (type === "edit") return null;
            return { x: 0, y: 0, data: value };
        },
        ing: (p, _e, { startData: oldV }) => {
            setV(oldV + (p.x / 200) * range);
        },
        end(e, { moved }) {
            if (!moved) {
                if (e.button === 2 && valueHistory.length) {
                    setV(valueHistory.pop() as number);
                } else useI(true);
            } else {
                valueHistory.push(value);
            }
        },
    });

    function vFix(v: number) {
        const vv = Math.max(min, Math.min(max, v));
        if (step < 1) {
            const r = 1 / step;
            return (Math.round(vv * r - min * r) + min * r) / r;
        }
        return Math.round((vv - min) / step) * step + min;
    }

    function setBar(v: number) {
        const p = (v - min) / range;
        bar.style({ width: `${p * 100}%` });
    }

    function inputEvent() {
        p.el.dispatchEvent(new Event("input"));
    }

    return p
        .bindGet(() => {
            return vFix(value);
        })
        .bindSet((v: number) => {
            setV(v, false, false);
        })
        .sv(value);
}

function setSetting() {
    const 工具栏 = store.get("工具栏");
    setProperties({
        "--color-size": `${Math.min(colorSize * colorISize, 96)}px`,
        "--color-i-size": `${Math.min(colorSize * colorISize, 96) / colorSize}px`,
        "--color-i-i": `${colorSize}`,
        "--bar-size": `${bSize}px`,
        "--bar-icon": `${工具栏.按钮图标比例}`,
    });
}

function toCanvas(canvas: HTMLCanvasElement, img: ImageData) {
    canvas.getContext("2d")!.putImageData(img, 0, 0);
}

async function setScreen(i: (typeof allScreens)[0]) {
    if (!i) throw new Error(t("화면을 캡처하지 못했습니다."));
    const generation = captureInitSequence;
    const screenRequest = ++screenRequestSequence;
    let _img = screenShotCache.get(i.id);
    if (!_img) {
        _img = (await i.capture()).toImageData();
    }
    const img = _img;
    if (
        generation !== captureInitSequence ||
        screenRequest !== screenRequestSequence
    )
        return false;
    if (
        !img ||
        !Number.isSafeInteger(img.width) ||
        !Number.isSafeInteger(img.height) ||
        img.width <= 0 ||
        img.height <= 0 ||
        img.data?.length !== img.width * img.height * 4
    )
        throw new Error(t("캡처한 화면이 비어 있습니다. 다시 캡처해 주세요."));
    screenShotCache.set(i.id, img);
    const w = img.width;
    const h = img.height;
    mainCanvas.width = w;
    mainCanvas.height = h;
    fabricCanvas.setDimensions({ width: w, height: h });
    setClipSize(w, h);
    toCanvas(mainCanvas, img);
    rectSelect = false;
    finalRect =
        captureSelectionMode === "window" ||
        captureSourceContext.kind === "capture"
            ? [0, 0, 0, 0]
            : [0, 0, mainCanvas.width, mainCanvas.height];
    if (captureSelectionMode === "region" && 记忆框选)
        if (记忆框选值?.[i.id]?.[2]) {
            finalRect = 记忆框选值[i.id];
            rectSelect = true;
            finalRectFix();
        } // 记忆框选边不为0时
    nowScreenId = i.id;
    edgeRect.length = 0;
    getWin();
    drawClipRect();
    if (finalRect[2] <= 0 || finalRect[3] <= 0) showBars(false);

    if (captureSelectionMode === "window") {
        if (selectionEdgesForMode(edgeRect, "window", false).length)
            captureWorkspace?.showStatus(
                "창 위로 포인터를 이동한 다음 클릭하세요.",
            );
        else
            captureWorkspace?.showError(
                new Error("현재 화면에서 캡처할 창을 찾을 수 없습니다."),
            );
    }

    if (w < window.innerWidth || h < window.innerHeight)
        document.body.classList.add("editor_bg");
    return true;
}

function setEditorP(zoom: number, x: number, y: number) {
    captureWorkspace?.dismiss();
    const oldZoom = editorP.zoom;
    const t: string[] = [];
    if (zoom != null) {
        t.push(`scale(${zoom})`);
        editorP.zoom = zoom;
    }
    if (x != null) {
        let limitX = x;
        const min = -mainCanvas.width;
        const max =
            (window.innerWidth * window.devicePixelRatio) / editorP.zoom;
        if (x < min) limitX = min;
        if (x > max) limitX = max;
        t.push(`translateX(${limitX}px)`);
        editorP.x = limitX;
    }
    if (y != null) {
        let limitY = y;
        const min = -mainCanvas.height;
        const max =
            (window.innerHeight * window.devicePixelRatio) / editorP.zoom;
        if (y < min) limitY = min;
        if (y > max) limitY = max;
        t.push(`translateY(${limitY}px)`);
        editorP.y = limitY;
    }
    editor.el.style.transform = t.join(" ");

    // 线的本地宽度随缩放变化
    if (editorP.zoom !== oldZoom) refreshLines();
    whBar(finalRect);
    syncSelectionHandles();
    followBar();
}

/** 参考线在编辑器内的本地宽度：缩放后屏幕上至少 1 逻辑像素，放大时随缩放变粗 */
function lineW() {
    return Math.max(1, 1 / editorP.zoom);
}

function setElBox(el: HTMLElement, x: number, y: number, w: number, h: number) {
    const s = el.style;
    const l = `${x}px`;
    const t = `${y}px`;
    const width = `${Math.max(0, w)}px`;
    const height = `${Math.max(0, h)}px`;
    // 值没变就不写，避免无谓的样式重算和重绘
    if (s.left !== l) s.left = l;
    if (s.top !== t) s.top = t;
    if (s.width !== width) s.width = width;
    if (s.height !== height) s.height = height;
}

function setClipSize(w: number, h: number) {
    clipEl.style.width = `${w}px`;
    clipEl.style.height = `${h}px`;
}

let clipCursor = "";
/** cursor 是继承属性，值没变不写，避免整层样式重算 */
function setClipCursor(c: string) {
    if (clipCursor === c) return;
    clipCursor = c;
    clipEl.style.cursor = c;
}

async function edge() {
    const canvas = mainCanvas;

    const cMin = store.get("框选.自动框选.最小阈值");
    const cMax = store.get("框选.自动框选.最大阈值");

    const { detectBorders } = await import("edge_det");
    const borders = detectBorders(
        new Uint8Array(
            canvas
                .getContext("2d")!
                .getImageData(0, 0, canvas.width, canvas.height).data,
        ),
        canvas.width,
        canvas.height,
        {
            lowThreshold: cMin,
            highThreshold: cMax,
            minArea: 3,
        },
    );

    for (const r of borders) {
        edgeRect.push({
            x: r.x,
            y: r.y,
            width: r.w,
            height: r.h,
            type: "image",
        });
    }
}

function getWin() {
    const display = getNowScreen();
    for (const win of windows) {
        const edge = windowBoundsToCanvas(win.rect, display.bounds, {
            width: mainCanvas.width,
            height: mainCanvas.height,
        });
        if (edge) edgeRect.push(edge);
    }
}

function getNowScreen(id = nowScreenId) {
    const s = allScreens.find((i) => i.id === id) ?? allScreens[0];
    return s;
}

function showSaveBar(m: boolean) {
    hotkeys.deleteScope("c_bar");
    if (m) {
        centerBarEl.style({
            opacity: 1,
            pointerEvents: "auto",
        });
        toHotkeyScope("c_bar");
    } else {
        centerBarEl.style({
            opacity: 0,
            pointerEvents: "none",
        });
        backHotkeyScope();
    }
}

function toHotkeyScope(scope: hotkeyScope) {
    if (hotkeyScopes.at(-1) !== scope) hotkeyScopes.push(scope);
    hotkeys.setScope(scope);
}
function backHotkeyScope() {
    if (hotkeyScopes.length > 1) hotkeyScopes.pop();
    hotkeys.setScope(hotkeyScopes.at(-1) ?? "normal");
    console.log(hotkeys.getScope(), hotkeyScopes);
}

function capturePrimaryToolId() {
    const preset = capturePreferences.defaultPreset;
    if (preset === "copy-close") return "copy";
    if (preset === "stage-only" || preset === "stage-pin") return "stage";
    if (preset === "annotate") return "annotate";
    const act = store.get("框选后默认操作");
    return act === "copysave" ? "copy" : act;
}

function markPrimaryTool() {
    const primary = capturePrimaryToolId();
    for (const b of toolBar.querySelectorAll<HTMLElement>(
        "[data-capture-action]",
    ))
        b.classList.toggle("is-primary", b.dataset.captureAction === primary);
}

function setDefaultAction(act: setting["框选后默认操作"] | undefined) {
    if (!act) return;
    autoDo = act;
    markPrimaryTool();
    if (autoDo !== "no" && autoDo !== "copysave") {
        toolsX[autoDo].el.el.style.backgroundColor = "var(--bar-focus-color)";
    }
}

function 记忆框选f() {
    if (记忆框选 && !longInited) {
        记忆框选值[nowScreenId] = [
            finalRect[0],
            finalRect[1],
            finalRect[2],
            finalRect[3],
        ];
        store.set("框选.记忆.rects", 记忆框选值);
    }
}

// 关闭
async function closeWin() {
    cancelSelectionInteraction();
    try {
        await captureWorkspace?.flush();
    } catch (error) {
        captureWorkspace?.showError(error);
        return;
    }
    liveTranslationController.cancel();
    mainCanvas.width = drawCanvas.width = mainCanvas.width; // 确保清空画布
    cleanClip();
    document.documentElement.style.display = "none";
    记忆框选f();
    if (uIOhook) {
        uIOhook.stop();
    }
    // @ts-expect-error
    await scheduler.yield();
    renderSend("clip_close", []);
}

function runOcr() {
    const type = ocr引擎.gv;
    const c = getClipPhoto();
    renderSend("clip_ocr", [c.toDataURL(), type]);
    toolsX.close.f();
}

function runOcrCopy() {
    const c = getClipPhoto();
    renderSend("clip_ocr_clipboard", [c.toDataURL(), ocr引擎.gv]);
    toolsX.close.f();
}

function runSearch() {
    const type = 识图引擎.gv;
    if (
        type === "ai" &&
        !store.get("AI.在线模型").find((i) => i.supportVision)
    ) {
        alert("无视觉模型，请在设置中添加模型");
        return;
    }
    const c = getClipPhoto();
    renderSend("clip_search", [c.toDataURL(), type]);
    toolsX.close.f();
}
// 二维码
function runQr() {
    const c = getClipPhoto();
    renderSend("clip_qr", [c.toDataURL()]);
    toolsX.close.f();
}

function drawM(v: boolean) {
    if (v) {
        // 绘画模式
        clipEl.style.pointerEvents = "none";
        whEl.style({ pointerEvents: "none" });
    } else {
        // 裁切模式
        clipEl.style.pointerEvents = "auto";
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
        whEl.style({ pointerEvents: "auto" });
    }
    syncSelectionHandles();
}

/**
 * 编辑栏跟踪工具栏
 */
function trackLocation() {
    const toolbar = toolBar.getBoundingClientRect();
    const height = drawBar.offsetHeight;
    const width = drawBar.offsetWidth;
    const below = toolbar.bottom + 8;
    const above = toolbar.top - height - 8;
    let left = Math.max(12, Math.min(innerWidth - width - 12, toolbar.left));
    let top: number;
    if (below + height < innerHeight) {
        top = below;
    } else if (above >= 12) {
        top = above;
    } else {
        const right = toolbar.right + 8;
        const sideLeft =
            right + width + 12 <= innerWidth
                ? right
                : Math.max(12, toolbar.left - width - 8);
        left = sideLeft;
        top = Math.max(12, Math.min(toolbar.top, innerHeight - height - 12));
    }
    drawBar.style.left = `${left}px`;
    drawBar.style.top = `${top}px`;
    positionToolPopover();
}

// 在其他应用打开

async function openApp() {
    const path = require("node:path");
    const os = require("node:os");
    const fs = require("node:fs") as typeof import("node:fs");
    const { randomUUID } = require("node:crypto") as typeof Crypto;
    try {
        const c = getClipPhoto();
        const f = c.toDataURL().replace(/^data:image\/\w+;base64,/, "");
        const dataBuffer = Buffer.from(f, "base64");
        const directory = path.join(os.tmpdir(), "OpenCapture");
        const tmpPhoto = path.join(directory, `open-${randomUUID()}.png`);
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(tmpPhoto, dataBuffer);
        await open_with(tmpPhoto);
    } catch (error) {
        captureWorkspace?.showError(error);
    }
}

function initRecord() {
    const mode = toolsX.record.el.gv;
    if (mode === "normal") {
        renderSend("clip_recordx", [
            {
                rect: finalRect,
                id: String(nowScreenId),
                w: mainCanvas.width,
                h: mainCanvas.height,
                r: ratio,
            },
        ]);
    } else if (mode === "super") {
        renderSend("clip_recordx", []);
    } else {
        renderSend("clip_record", [
            finalRect,
            String(nowScreenId),
            mainCanvas.width,
            mainCanvas.height,
            ratio,
        ]);
    }
    toolsX.close.f();
}

let longBusy = false;
let longCapped = false;
let longSession = 0;
let longInFlight: Promise<void> | null = null;
let longStopping: Promise<void> | null = null;
let longStopSession = 0;
let longKeyupHandler: (() => void) | null = null;
let longWheelHandler: (() => void) | null = null;

function cleanupLongCapture() {
    if (longClipTime !== null) clearInterval(longClipTime);
    longClipTime = null;
    if (longMouse !== null) clearInterval(longMouse);
    longMouse = null;
    if (uIOhook) {
        if (longKeyupHandler) uIOhook.off("keyup", longKeyupHandler);
        if (longWheelHandler) uIOhook.off("wheel", longWheelHandler);
        uIOhook.stop();
    }
    uIOhook = null;
    longKeyupHandler = null;
    longWheelHandler = null;
}

async function long_s(session = longSession) {
    // 上一帧还没拼完就跳过这一帧：
    // 并发进 addLong 会抢 longX.lastImg/lastXY，
    // 拼出来的偏移互相错位
    if (session !== longSession || !longRunning || longCapped) return;
    if (longInFlight) return longInFlight;
    longBusy = true;
    const operation = (async () => {
        try {
            const image = (await getNowScreen().capture()).toImageData();
            if (session !== longSession || !longRunning) return;
            await addLong(image ?? undefined, session);
        } catch (error) {
            if (session !== longSession) return;
            longCapped = true;
            console.error(`长截图单帧失败: ${error}`);
            renderSend("windowIgnoreMouse", [false]);
        }
    })();
    longInFlight = operation;
    try {
        await operation;
    } finally {
        if (longInFlight === operation) {
            longInFlight = null;
            longBusy = false;
        }
    }
}

async function startLong() {
    initLong(finalRect);
    const session = longSession;
    await long_s(session);
    if (session !== longSession || !longRunning) return;
    if (longCapped) {
        await stopLong();
        return;
    }
    renderSend("windowIgnoreMouse", [true]);
    if (store.get("广截屏.模式") === "自动") {
        uIOhook = require("uiohook-napi").uIOhook;
        if (uIOhook) {
            uIOhook.start();
            longKeyupHandler = () => {
                // 原来每次全局抬键都抓一整屏，完全不限流
                const n = Date.now();
                if (n - lastLong > 300) {
                    lastLong = n;
                    void long_s(session);
                }
            };
            longWheelHandler = () => {
                const n = Date.now();
                if (n - lastLong > 500) {
                    lastLong = n;
                    void long_s(session);
                }
            };
            uIOhook.on("keyup", longKeyupHandler);
            uIOhook.on("wheel", longWheelHandler);
        }
    } else {
        longClipTime = setInterval(() => {
            void long_s(session);
        }, store.get("广截屏.t"));
    }
}

function initLong(rect: number[]) {
    longSession++;
    cleanupLongCapture();
    longRunning = true;
    longInited = true;
    longCapped = false;
    longBusy = false;
    longInFlight = null;
    longStopping = null;
    longStopSession = 0;
    longX.img = null;
    longX.imgXY = { x: 0, y: 0 };
    longX.lastImg = null;
    longX.lastXY = { x: 0, y: 0 };
    longPreview.clear();

    longMouse = setInterval(() => {
        const { x, y } = renderSendSync("getMousePos", []).po;
        const el = document.elementsFromPoint(x, y);
        if (longRunning)
            renderSend("windowIgnoreMouse", [!el.includes(finishLongB)]);
        else renderSend("windowIgnoreMouse", [false]);
    }, 1000);

    for (const i of longHide) {
        i.style.display = "none";
    }

    document.body.classList.remove("editor_bg");

    记忆框选值[nowScreenId] = [rect[0], rect[1], rect[2], rect[3]];
    store.set("框选.记忆.rects", 记忆框选值);

    lr.style({
        left: `${rect[0] / ratio}px`,
        top: `${rect[1] / ratio}px`,
        width: `${rect[2] / ratio}px`,
        height: `${rect[3] / ratio}px`,
    });
    const w = 16;
    let right = 0;
    let botton = 0;
    if ((rect[2] + rect[3]) / ratio + w > window.innerHeight) {
        if ((rect[0] + rect[2]) / ratio + w > window.innerWidth) {
        } else {
            right = -w;
        }
    } else {
        botton = -w;
    }
    finishLongB.style.right = `${right}px`;
    finishLongB.style.bottom = `${botton}px`;
    finishLongB.onclick = stopLong;

    let longWidth = 0;
    if (window.innerWidth / 2 > (rect[0] + rect[2] / 2) / ratio) {
        // 右边
        longPreview.style({ right: "0", left: "auto" });
        longWidth = window.innerWidth - (rect[0] + rect[2]) / ratio - w;
    } else {
        longPreview.style({ left: "0" });
        longWidth = rect[0] / ratio - w;
    }
    longPreview.style({
        display: longWidth < 100 ? "none" : "",
        width: `${longWidth}px`,
        height: "100vh",
    });
}

async function stopLong() {
    const session = longSession;
    if (!longInited || session === 0) return;
    if (longStopping && longStopSession === session) return longStopping;
    longStopSession = session;
    const operation = (async () => {
        if (longInFlight) await longInFlight;
        if (session !== longSession) return;
        if (!longCapped) await long_s(session);
        if (longInFlight) await longInFlight;
        if (session !== longSession) return;
        longRunning = false;
        await addLong(undefined, session);
    })();
    longStopping = operation;
    try {
        await operation;
    } finally {
        if (longStopping === operation) longStopping = null;
    }
}

async function addLong(x: ImageData | undefined, session = longSession) {
    if (session !== longSession) return;
    if (!x) {
        pjLong(session);
        return;
    }
    // 原始区域
    const canvas = ele("canvas").el;
    const d = x;
    // 设定canvas宽高并设置裁剪后的图像
    canvas.width = finalRect[2];
    canvas.height = finalRect[3];
    canvas.getContext("2d")!.putImageData(d, -finalRect[0], -finalRect[1]);

    if (!longX.lastImg) {
        longPutImg(canvas, 0, 0);
        longX.lastImg = canvas;
        return;
    }

    const match = await longMatch(longX.lastImg, canvas);

    if (session !== longSession || !longRunning) return;
    if (!match.clipedImg) return;

    const dx = longFX === "xy" ? match.dx : 0;
    const dy = match.dy;
    const putImg = match.clipedImg;
    longPutImg(putImg, dx + longX.lastXY.x, dy + longX.lastXY.y);

    longX.lastImg = canvas;
    longX.lastXY.x += longFX === "xy" ? match.srcDX : 0;
    longX.lastXY.y += match.srcDY;
}

async function longMatch(img0: HTMLCanvasElement, img1: HTMLCanvasElement) {
    // match
    const { findOffset } = await import("picture_match");
    const m = await findOffset(
        img0.getContext("2d")!.getImageData(0, 0, img0.width, img0.height),
        img1.getContext("2d")!.getImageData(0, 0, img1.width, img1.height),
    );

    // 图片应该反过来移动才能拼接上
    const dx = -m.dx;
    const dy = -m.dy;

    // 下面考虑裁切，因为页面可能存在固定区域，以顶栏为例，向下拼接会导致顶栏重复
    // 但是注意到，向下拼接实际上可以覆盖一定的底栏
    // 因此，向下拼接，裁去顶部可以了
    // clip img1 “回”字中间的“口”
    function clip(v: number) {
        const x = v - Math.max((v / 3) * 1, 50);
        return Math.floor(Math.max(x, 0) / 2);
    }
    const dw = longFX === "xy" ? clip(img1.width) : 0; // “目”中间的“口”
    const dh = clip(img1.height);
    // clip img1
    // 0:裁切九宫格边的三个格 !=0:裁出“田”字
    const clip2Canvas = new OffscreenCanvas(img1.width, img1.height);

    if (dx === 0 && dy === 0) {
        return {
            dx: 0,
            dy: 0,
            srcDX: dx,
            srcDY: dy,
            clipedImg: undefined,
        };
    }
    if (dx === 0) {
        clip2Canvas.width = img1.width;
        clip2Canvas.height = img1.height - dh;
        clip2Canvas.getContext("2d")!.drawImage(img1, 0, dy > 0 ? -dh : 0);
    } else if (dy === 0) {
        clip2Canvas.width = img1.width - dw;
        clip2Canvas.height = img1.height;
        clip2Canvas.getContext("2d")!.drawImage(img1, dx > 0 ? -dw : 0, 0);
    } else {
        clip2Canvas.width = img1.width - dw;
        clip2Canvas.height = img1.height - dh;
        clip2Canvas
            .getContext("2d")!
            .drawImage(img1, dx > 0 ? -dw : 0, dy > 0 ? -dh : 0);
    }

    return {
        dx: dx > 0 ? dx + dw : dx,
        dy: dy > 0 ? dy + dh : dy,
        srcDX: dx,
        srcDY: dy,
        clipedImg: clip2Canvas,
    };
}

function longPutImg(
    img: HTMLCanvasElement | OffscreenCanvas,
    x: number,
    y: number,
) {
    // 前提：img大小一定小于等于最终拼接canvas
    const newCanvas = ele("canvas").el;
    const newCtx = newCanvas.getContext("2d");
    if (!newCtx) {
        longCapped = true;
        console.error("长截图：拿不到 2d 上下文，停止拼接");
        captureWorkspace?.showStatus(
            t("이미지가 커져서 여기까지만 이어붙였습니다"),
        );
        void stopLong();
        return;
    }

    const srcW = longX.img?.width || 0;
    const srcH = longX.img?.height || 0;
    const minX = longX.imgXY.x;
    const minY = longX.imgXY.y;
    const maxX = minX + srcW;
    const maxY = minY + srcH;

    let srcDx = 0;
    let srcDy = 0;

    if (x < minX) {
        srcDx = minX - x;
        newCanvas.width = srcDx + srcW;
        longX.imgXY.x -= srcDx;
    } else if (x + img.width > maxX) {
        newCanvas.width = x + img.width - maxX + srcW;
    } else {
        newCanvas.width = srcW;
    }
    if (y < minY) {
        srcDy = minY - y;
        newCanvas.height = srcDy + srcH;
        longX.imgXY.y -= srcDy;
    } else if (y + img.height > maxY) {
        newCanvas.height = y + img.height - maxY + srcH;
    } else {
        newCanvas.height = srcH;
    }

    if (longX.img) newCtx.drawImage(longX.img, srcDx, srcDy);

    const nx = x - longX.imgXY.x;
    const ny = y - longX.imgXY.y;
    newCtx.drawImage(img, nx, ny);
    longX.img = newCanvas;

    longPreview.clear();
    newCanvas.style.maxWidth = "100%";
    newCanvas.style.maxHeight = "100%";
    longPreview.add(newCanvas);
}

function pjLong(session = longSession) {
    if (session !== longSession) return;
    try {
        const oCanvas = longX.img;
        if (!oCanvas) {
            captureWorkspace?.showStatus(t("이어붙일 캡처가 없습니다"));
            return;
        }
        mainCanvas.width = oCanvas.width;
        mainCanvas.height = oCanvas.height;
        fabricCanvas.setDimensions({
            width: oCanvas.width,
            height: oCanvas.height,
        });
        setClipSize(oCanvas.width, oCanvas.height);

        const ggid = oCanvas
            .getContext("2d")!
            .getImageData(0, 0, oCanvas.width, oCanvas.height);
        mainCanvas.getContext("2d")!.putImageData(ggid, 0, 0);

        finalRect = [0, 0, oCanvas.width, oCanvas.height];
        drawClip();

        fabricCanvas.setDimensions({
            width: oCanvas.width,
            height: oCanvas.height,
        });
    } finally {
        cleanupLongCapture();
        longPreview.style({ display: "none" });
        longPreview.clear();
        document.body.classList.add("editor_bg");
        lr.style({ opacity: "0", width: "0", height: "0" });
        for (const element of longHide) element.style.display = "";
        renderSend("windowIgnoreMouse", [false]);
        longRunning = false;
        longInited = false;
        longBusy = false;
        longInFlight = null;
    }
}

// 마지막 선택 영역을 절대 좌표로 기억 — 이후 "같은 영역 다시 캡처"에 사용
function rememberLastRect() {
    if (!finalRect || finalRect[2] < 2 || finalRect[3] < 2) return;
    const display = getNowScreen();
    renderSend("clip_last_rect", [
        {
            x: finalRect[0] / ratio + display.bounds.x,
            y: finalRect[1] / ratio + display.bounds.y,
            w: finalRect[2] / ratio,
            h: finalRect[3] / ratio,
            displayId: display.id,
        },
    ]);
}

// 钉在屏幕上
function runDing() {
    const c = getClipPhoto();
    const display = getNowScreen();
    renderSend("clip_ding", [
        c.toDataURL(),
        "ding",
        {
            x: finalRect[0] / ratio + display.bounds.x,
            y: finalRect[1] / ratio + display.bounds.y,
            w: finalRect[2] / ratio,
            h: finalRect[3] / ratio,
        },
    ]);
    toolsX.close.f();
}

function alert(m: string) {
    const d = ele("dialog")
        .add(
            view("y")
                .add([
                    t(m),
                    button(t("确定"))
                        .on("click", () => {
                            d.remove();
                        })
                        .style({ width: "auto" }),
                ])
                .class(Class.gap),
        )
        .class(Class.glassBar)
        .addInto();
    d.el.showModal();
}

function checkTranslator() {
    const fyq = store.get("翻译.翻译器");
    if (fyq.length === 0) {
        alert(t("无翻译器，请先设置翻译器"));
        return false;
    }
    if (
        store.get("屏幕翻译.语言.to") === "" ||
        store.get("屏幕翻译.语言.from") === ""
    ) {
        alert(t("请设置屏幕翻译的语言"));
        return false;
    }
    return true;
}

async function translate() {
    const t = checkTranslator();
    if (!t) return;
    const display = getNowScreen();
    const c = getClipPhoto();
    if (toolsX.translate.el.gv === "ding") {
        renderSend("clip_ding", [
            c.toDataURL(),
            "translate",
            {
                x: finalRect[0] / ratio + display.bounds.x,
                y: finalRect[1] / ratio + display.bounds.y,
                w: finalRect[2] / ratio,
                h: finalRect[3] / ratio,
            },
        ]);
    } else
        renderSend("clip_translate", [
            {
                rect: {
                    x: finalRect[0],
                    y: finalRect[1],
                    w: finalRect[2],
                    h: finalRect[3],
                },
                dipRect: {
                    x: finalRect[0] / ratio + display.bounds.x,
                    y: finalRect[1] / ratio + display.bounds.y,
                    w: finalRect[2] / ratio,
                    h: finalRect[3] / ratio,
                },
                displayId: nowScreenId,
                img: getClipPhoto().toDataURL(),
            },
        ]);
    toolsX.close.f();
}

// 复制
async function runCopy(closeAfterCopy = true) {
    const generation = captureInitSequence;
    try {
        const c = getClipPhoto();
        const blob = await getBlob(c, "image/png");
        if (!blob)
            throw new Error(
                t("캡처한 화면이 비어 있습니다. 다시 캡처해 주세요."),
            );
        if (generation !== captureInitSequence) return false;
        await captureWorkspace?.stage(true);
        if (generation !== captureInitSequence) return false;
        await writeImage(blob);
        if (generation !== captureInitSequence) return false;
        playDoneSound();
        if (closeAfterCopy) toolsX.close.f();
        else captureWorkspace?.showStatus(t("이미지를 복사했습니다."));
        return true;
    } catch (error) {
        captureWorkspace?.showError(error);
        return false;
    }
}
// 保存
async function runSave() {
    const generation = captureInitSequence;
    try {
        await captureWorkspace?.stage();
    } catch (error) {
        captureWorkspace?.showError(error);
        return;
    }
    if (generation !== captureInitSequence) return;
    if (store.get("保存.快速保存")) {
        type = store.get("保存.默认格式");
        renderSend("clip_hide", []);
        const p = renderSendSync("save_file_path", [type]);
        save(p);
        return;
    }
    showSaveBar(true);
    const els = suffixList;
    const type2N = saveTypeList;
    for (const i of els) {
        i.el.className = "";
    }
    let i = type2N.indexOf(store.get("保存.默认格式"));
    els[i].el.className = "suffix_h";
    toHotkeyScope("c_bar");
    hotkeys("enter", "c_bar", () => {
        els[i].el.click();
        showSaveBar(false);
    });
    const l = type2N.length;
    hotkeys("up", "c_bar", () => {
        els[i % l].el.className = "";
        i = i === 0 ? l - 1 : i - 1;
        els[i % l].el.className = "suffix_h";
    });
    hotkeys("down", "c_bar", () => {
        els[i % l].el.className = "";
        i++;
        els[i % l].el.className = "suffix_h";
    });
    hotkeys("esc", "c_bar", () => {
        showSaveBar(false);
    });
}
async function save(message: string) {
    if (!message) return;
    const iType = message.split(".")?.pop()?.toLowerCase() as
        | SaveFileType
        | undefined;
    const _type = iType && saveTypeList.includes(iType) ? iType : type;

    if (_type !== "svg" && _type !== "ocap") store.set("保存.默认格式", _type);

    const fs = require("node:fs");
    let dataBuffer: Buffer;
    if (_type === "ocap")
        dataBuffer = Buffer.from(
            JSON.stringify({
                v: 1,
                img: mainCanvas.toDataURL("image/png"),
                canvas: fabricCanvas?.toJSON() ?? null,
                rect: finalRect,
            }),
        );
    else if (_type === "svg") dataBuffer = Buffer.from(getClipPhotoSVG());
    else if (_type === "bmp") {
        const nc = getClipPhoto();
        const mainCtx = nc.getContext("2d")!;
        const data = mainCtx.getImageData(0, 0, nc.width, nc.height);
        const abgrArray = new Uint8Array(data.data.length);
        for (let i = 0; i < data.data.length; i += 4) {
            abgrArray[i] = data.data[i + 3];
            abgrArray[i + 1] = data.data[i + 2];
            abgrArray[i + 2] = data.data[i + 1];
            abgrArray[i + 3] = data.data[i];
        }
        const bmp = (await import("bmp-js")).default;
        const arrayBuffer = bmp.encode({
            data: Buffer.from(abgrArray),
            width: data.width,
            height: data.height,
        }).data;
        dataBuffer = arrayBuffer;
    } else if (_type === "pdf") {
        const nc = getClipPhoto();
        const f = await getBlob(nc, "image/jpeg", 0.92);
        if (!f) return;
        dataBuffer = imageToPdf(
            Buffer.from(await f.arrayBuffer()),
            nc.width,
            nc.height,
        );
    } else {
        let f: Blob | null = null;
        const nc = getClipPhoto();
        if (_type === "png") {
            f = await getBlob(nc, "image/png");
        } else if (_type === "jpg") {
            f = await getBlob(nc, "image/jpeg");
        } else if (_type === "webp") {
            f = await getBlob(nc, "image/webp");
        }
        if (!f) {
            // todo error
            return;
        }
        dataBuffer = Buffer.from(await f.arrayBuffer());
        if (store.get("保存.保存并复制")) {
            await writeImage(f); // todo tip
        }
    }

    fs.writeFile(message, dataBuffer, (err: Error | null) => {
        if (!err) {
            playDoneSound();
            renderSend("ok_save", [message]);
            toolsX.close.f();
        } else {
            // todo error
        }
    });
}

/** 이미지 한 장을 담은 최소 PDF (JPEG DCTDecode) */
function imageToPdf(jpeg: Buffer, w: number, h: number) {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offsets: number[] = [];
    let len = 0;
    const push = (s: string | Uint8Array) => {
        const b = typeof s === "string" ? enc.encode(s) : s;
        parts.push(b);
        len += b.length;
    };
    push("%PDF-1.4\n");
    offsets.push(len);
    push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
    offsets.push(len);
    push("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
    offsets.push(len);
    push(
        `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im1 4 0 R>>>>/Contents 5 0 R>>endobj\n`,
    );
    offsets.push(len);
    push(
        `4 0 obj<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>stream\n`,
    );
    push(jpeg);
    push("\nendstream endobj\n");
    offsets.push(len);
    const cs = `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q\n`;
    push(`5 0 obj<</Length ${cs.length}>>stream\n${cs}endstream endobj\n`);
    const xref = len;
    push("xref\n0 6\n0000000000 65535 f \n");
    for (const o of offsets) push(`${String(o).padStart(10, "0")} 00000 n \n`);
    push(`trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`);
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function getClipPhotoSVG() {
    const svg = document.createElement("div");
    if (typeof fabricCanvas === "undefined") {
        svg.innerHTML = `<!--?xml version="1.0" encoding="UTF-8" standalone="no" ?-->
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${mainCanvas.width}" height="${mainCanvas.height}" viewBox="0 0 1920 1080" xml:space="preserve">
            <desc>Created with eSearch</desc>
            </svg>`;
    } else {
        svg.innerHTML = fabricCanvas.toSVG();
        // @ts-ignore
        svg.querySelector("desc").innerHTML =
            "Created with eSearch & Fabric.js";
    }
    const svgEl = svg.querySelector("svg") as SVGElement;
    svgEl.setAttribute("viewBox", finalRect.join(" "));
    const image = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "image",
    );
    image.setAttribute("xlink:href", mainCanvas.toDataURL());
    svgEl.insertBefore(image, svgEl.firstChild);
    const svgT = new XMLSerializer().serializeToString(svgEl);
    return svgT;
}

function getClipPhoto() {
    const mainCtx = mainCanvas.getContext("2d")!;
    if (!finalRect) finalRect = [0, 0, mainCanvas.width, mainCanvas.height];

    if (typeof fabricCanvas !== "undefined") {
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
    }

    const tmpCanvas = document.createElement("canvas");
    const tmpctx = tmpCanvas.getContext("2d")!;
    tmpCanvas.width = finalRect[2];
    tmpCanvas.height = finalRect[3];
    const gid = mainCtx.getImageData(
        finalRect[0],
        finalRect[1],
        finalRect[2],
        finalRect[3],
    ); // 裁剪
    tmpctx.putImageData(gid, 0, 0);
    tmpctx.drawImage(
        fabricCanvas.toCanvasElement(1, {
            left: finalRect[0],
            top: finalRect[1],
            width: finalRect[2],
            height: finalRect[3],
        }),
        0,
        0,
    );
    if (!isRect) {
        const ctx = tmpctx;

        // 创建临时Canvas并保存原始内容
        const tempCanvas = createTemporaryCanvas(tmpCanvas);

        // 清除主Canvas
        ctx.clearRect(0, 0, tmpCanvas.width, tmpCanvas.height);

        // 定义裁剪区域
        ctx.beginPath();
        freeSelect.forEach((point, index) => {
            if (index === 0) {
                ctx.moveTo(point.x - finalRect[0], point.y - finalRect[1]);
            } else {
                ctx.lineTo(point.x - finalRect[0], point.y - finalRect[1]);
            }
        });
        ctx.closePath();
        ctx.clip();

        // 将原始内容重新绘制到主Canvas上
        ctx.drawImage(tempCanvas, 0, 0);
    }
    if (rulerImprint && isRect) drawRulerTicks(tmpctx, tmpCanvas);
    return tmpCanvas;
}

function drawRulerTicks(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
) {
    const { width: w, height: h } = canvas;
    const step = 10;
    const major = 50;
    const tick = (x: number, y0: number, len: number, vertical: boolean) => {
        ctx.beginPath();
        if (vertical) {
            ctx.moveTo(y0, x + 0.5);
            ctx.lineTo(y0 + len, x + 0.5);
        } else {
            ctx.moveTo(x + 0.5, y0);
            ctx.lineTo(x + 0.5, y0 + len);
        }
        ctx.stroke();
    };
    const draw = (outline: boolean) => {
        ctx.strokeStyle = outline
            ? "rgba(255,255,255,0.75)"
            : "rgba(20,20,20,0.8)";
        ctx.lineWidth = outline ? 3 : 1;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "9px sans-serif";
        ctx.textBaseline = "top";
        for (let x = 0; x <= w; x += step) {
            const isMajor = x % major === 0;
            tick(x, 0, isMajor ? 8 : 4, false);
            tick(x, h - (isMajor ? 8 : 4), isMajor ? 8 : 4, false);
            if (isMajor && x % 100 === 0 && x > 0)
                ctx.fillText(String(x), x + 3, 10);
        }
        for (let y = 0; y <= h; y += step) {
            const isMajor = y % major === 0;
            tick(y, 0, isMajor ? 8 : 4, true);
            tick(y, w - (isMajor ? 8 : 4), isMajor ? 8 : 4, true);
            if (isMajor && y % 100 === 0 && y > 0)
                ctx.fillText(String(y), 10, y + 3);
        }
    };
    draw(true);
    draw(false);
}

function createTemporaryCanvas(originalCanvas: HTMLCanvasElement) {
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = originalCanvas.width;
    tempCanvas.height = originalCanvas.height;
    const tempCtx = tempCanvas.getContext("2d")!;
    tempCtx.drawImage(originalCanvas, 0, 0);
    return tempCanvas;
}

async function getBlob(c: HTMLCanvasElement, type: string, q = 1) {
    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    c.toBlob(
        (blob) => {
            resolve(blob);
        },
        type,
        q,
    );
    return promise;
}

function e2srcPoint(e: MouseEvent | PointerEvent) {
    return { x: e.clientX, y: e.clientY } as SrcPoint;
}

function src2pXYdb(e: SrcPoint) {
    const cX = (e.x - editorP.x * editorP.zoom) / editorP.zoom;
    const cY = (e.y - editorP.y * editorP.zoom) / editorP.zoom;
    return { x: cX, y: cY };
}

function src2pXY(e: SrcPoint) {
    const { x, y } = src2pXYdb(e);
    return { x: Math.round(x), y: Math.round(y) } as editor_position;
}

// 鼠标框选坐标转画布坐标,鼠标坐标转画布坐标
function p2Rect(p1: px_position | null, p2: px_position | null): rect {
    if (!p1 || !p2) return [0, 0, 0, 0];
    const { x: oX1, y: oY1 } = p1;
    const { x: oX2, y: oY2 } = p2;
    const x1 = Math.min(oX1, oX2);
    const y1 = Math.min(oY1, oY2);
    const x2 = Math.max(oX1, oX2) + 1;
    const y2 = Math.max(oY1, oY2) + 1;
    return [x1, y1, x2 - x1, y2 - y1];
}

function src2cXY(e: SrcPoint) {
    const { x, y } = src2pXYdb(e);
    if (editorP.zoom === 1 / window.devicePixelRatio) {
        return { x: Math.ceil(x), y: Math.ceil(y) } as px_position; // 确保获取到最后的像素
    }
    return { x: Math.floor(x), y: Math.floor(y) } as px_position; // 放大后，可以进行高精度计算来获取所有像素，缩写后，看的是放大镜，这就无关紧要了
}

function dragRect(e: MouseEvent): rect {
    const start = rectStartE;
    const end = src2cXY(e2srcPoint(e));
    if (!start || !end) return [0, 0, 0, 0];
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if (e.shiftKey) {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * m;
        dy = Math.sign(dy || 1) * m;
    }
    return e.altKey
        ? p2Rect(
              { x: start.x - dx, y: start.y - dy } as px_position,
              { x: start.x + dx, y: start.y + dy } as px_position,
          )
        : p2Rect(start, { x: start.x + dx, y: start.y + dy } as px_position);
}

function pointsOutRect(points: point[]) {
    if (points.length === 0) {
        return [0, 0, 0, 0] as rect;
    }

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;

    // 遍历所有点，找到最小和最大的x,y坐标
    for (const point of points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
    }

    // 返回边框的左下角和右上角坐标
    return [minX, minY, maxX - minX, maxY - minY] as rect;
}

// 开始操纵框选
function clipStart(e: MouseEvent, inRect: boolean) {
    dismissStartHint();
    const p = src2pXY(e2srcPoint(e));
    if (captureSelectionMode === "window") {
        const candidate = windowEdgeAtPoint(
            selectionEdgesForMode(edgeRect, "window", false),
            p,
        );
        if (!candidate) {
            captureWorkspace?.showStatus(
                "캡처할 창 위로 포인터를 이동한 다음 클릭하세요.",
            );
            return;
        }
        isRect = true;
        rectSelect = true;
        finalRect = [
            candidate.x,
            candidate.y,
            candidate.width,
            candidate.height,
        ];
        finalRectFix();
        drawClip();
        hisPush();
        captureWorkspace?.feedback.settle(selectionHandles.el);
        isShowBars = true;
        showBars(true);
        followBar({ x: e.clientX, y: e.clientY });
        void completeSelectionAction();
        return;
    }
    selectionBeforeDrag = {
        rect: [...finalRect],
        points: freeSelect.map((point) => ({ ...point })),
        manual: rectSelect,
    };
    if (isRect) {
        // 在选区内，则调整，否则新建
        if (inRect) {
            isInClipRect(p);
            oldP = { x: p.x, y: p.y };
            oFinalRect = finalRect;
            moving = true;
            moveRect(oFinalRect, p, p);
        } else {
            selecting = true;
            rectStartE = src2cXY(e2srcPoint(e));
            finalRect = p2Rect(rectStartE, rectStartE);
            rightKey = false;
            changeRightBar(false);
        }
    } else {
        if (inRect) {
            oldP = { x: p.x, y: p.y };
            oPoly = structuredClone(freeSelect);
            moving = true;
            movePoly(oPoly, p, p);
        } else {
            selecting = true;
            freeSelect = [p];
            finalRect = pointsOutRect(freeSelect);
            rightKey = false;
            changeRightBar(false);
        }
    }
    renderClip(e);

    // 隐藏
    drawBar.style.opacity = toolBar.style.opacity = "0";
    toolPopover.el.hidden = true;
    closeRadial();
}

function cancelSelectionInteraction() {
    finishHandleResize(false);
    setSnapGuides(null, null);
    if (!down && !selecting && !moving) return;
    down = moved = selecting = moving = false;
    oFinalRect = null;
    oPoly = null;
    direction = "";
    if (selectionBeforeDrag) {
        finalRect = selectionBeforeDrag.rect;
        freeSelect = selectionBeforeDrag.points;
        rectSelect = selectionBeforeDrag.manual;
    }
    selectionBeforeDrag = null;
    mouseBarEl.el.classList.add("mouse_bar_hide");
    drawClip();
    showBars(isShowBars);
    followBar();
}

function pickColor(e: MouseEvent | PointerEvent) {
    rightKey = !rightKey;
    mouseBarEl.el.classList.toggle("mouse_bar_hide", !rightKey);
    // 自由右键取色
    mouseBar(finalRect, e2srcPoint(e));
    // 改成多格式样式
    if (rightKey) {
        changeRightBar(true);
    } else {
        changeRightBar(false);
    }
}

function requireCaptureSelection() {
    if (finalRect[2] > 0 && finalRect[3] > 0) return true;
    captureWorkspace?.showStatus(t("캡처할 영역을 먼저 선택해 주세요."));
    return false;
}

async function completeSelectionAction() {
    if (!requireCaptureSelection()) return;
    const generation = captureInitSequence;
    try {
        if (capturePreferences.defaultPreset === "copy-close") {
            await runCopy();
        } else if (capturePreferences.defaultPreset === "stage-only") {
            await captureWorkspace?.stage(true);
        } else if (capturePreferences.defaultPreset === "stage-pin") {
            await captureWorkspace?.stage(true);
            if (generation !== captureInitSequence) return;
            toolsX.ding.f();
        } else if (capturePreferences.defaultPreset === "annotate") {
            setEditType("draw", "free");
        } else if (autoDo === "copysave") {
            if ((await runCopy(false)) && generation === captureInitSequence)
                await runSave();
        } else if (autoDo !== "no") {
            await toolsX[autoDo].f();
        }
    } catch (error) {
        captureWorkspace?.showError(error);
    }
}

function clipEnd(e: MouseEvent) {
    const p = src2pXY(e2srcPoint(e));
    selecting = false;
    if (isRect) {
        const r = snapDrag(e, dragRect(e));
        if (rectInRect.length) {
            let nearestL = Number.POSITIVE_INFINITY;
            let nr: rect | null = null;
            for (const rect of rectInRect) {
                const center1 = {
                    x: rect[0] + rect[2] / 2,
                    y: rect[1] + rect[3] / 2,
                };
                const center2 = { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 };
                const l =
                    Math.sqrt(
                        (center1.x - center2.x) ** 2 +
                            (center1.y - center2.y) ** 2,
                    ) +
                    Math.abs(rect[0] - r[0]) +
                    Math.abs(rect[1] - r[1]) +
                    Math.abs(rect[0] + rect[2] - (r[0] + r[2])) +
                    Math.abs(rect[1] + rect[3] - (r[1] + r[3]));
                if (l < nearestL) {
                    nearestL = l;
                    nr = rect;
                }
            }
            if (nr && ((e.shiftKey && !moved) || (!moved && down))) {
                rectSelect = true;
                finalRect = nr;
            } else {
                finalRect = r;
            }
        } else {
            finalRect = r;
        }
    } else {
        freeSelect.push(p);
        finalRect = pointsOutRect(freeSelect);
    }
    setSnapGuides(null, null);
    // 此时 selecting 已为 false，选区已定，直接重绘
    captureWorkspace?.feedback.settle(selectionHandles.el);
    drawClip();
    renderClip(e);
    hisPush();
}

/** 遮罩当前的显示形态，未绘制过为 undefined */
let maskType: "rect" | "poly" | null | undefined;
/** 自动框选提示的上一次内容 */
let edgeKey = "";

/** 切换遮罩形态，null 为不显示 */
function showMask(type: "rect" | "poly" | null) {
    if (type === maskType) return;
    maskType = type;
    const rectV = type === "rect";
    for (const el of clipMaskRect) el.el.style.display = rectV ? "" : "none";
    for (const el of clipSelectLines) el.el.style.display = rectV ? "" : "none";
    clipMaskPoly.el.style.display = type === "poly" ? "" : "none";
}

function drawSelectLines() {
    const [x, y, width, height] = finalRect;
    const w = lineW();
    clipSelectLineX.forEach((el, i) => {
        const px = x + x选区参考线.x[i] * width + 0.5 - w / 2;
        setElBox(el.el, px, y, w, height);
    });
    clipSelectLineY.forEach((el, i) => {
        const py = y + x选区参考线.y[i] * height + 0.5 - w / 2;
        setElBox(el.el, x, py, width, w);
    });
}

/** 画框(遮罩) */
function drawClipRect() {
    const cw = mainCanvas.width;
    const ch = mainCanvas.height;

    const x = finalRect[0];
    const y = finalRect[1];
    const width = finalRect[2];
    const height = finalRect[3];

    showMask("rect");
    setElBox(clipMaskRect[0].el, 0, 0, cw, y);
    setElBox(clipMaskRect[1].el, 0, y + height, cw, ch - y - height);
    setElBox(clipMaskRect[2].el, 0, y, x, height);
    setElBox(clipMaskRect[3].el, x + width, y, cw - x - width, height);

    drawSelectLines();

    // 大小栏
    whBar(finalRect);
    syncSelectionHandles();
}

/** 画多边形(遮罩) */
function drawClipPoly(points: point[]) {
    if (points.length < 2) {
        showMask(null);
        return;
    }

    const cw = mainCanvas.width;
    const ch = mainCanvas.height;

    showMask("poly");
    setElBox(clipMaskPoly.el, 0, 0, cw, ch);
    const path = points
        .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
        .join("");
    // evenodd 让选区多边形成为遮罩的洞
    clipMaskPoly.el.style.clipPath = `path(evenodd, "M0 0H${cw}V${ch}H0Z${path}Z")`;

    // 大小栏
    whBar(pointsOutRect(points));
    selectionHandles.el.hidden = true;
}

function drawClip() {
    if (isRect) drawClipRect();
    else drawClipPoly(freeSelect);
    scheduleLiveTranslation();
}

function cleanClip() {
    showMask(null);
    showSaveBar(false);
    captureHelp.el.hidden = true;
    updateStartHint();
    showBars(false);
    whEl.style({ visibility: "hidden" });
    mouseBarEl.el.classList.add("mouse_bar_hide");
    selectionHandles.el.hidden = true;
    closeRadial();
    toolPopover.el.hidden = true;
    edgeKey = "";
    for (const el of clipCkx) setElBox(el.el, 0, 0, 0, 0);
    clipEdge.el.replaceChildren();
}

/** 缩放、平移后刷新参考线，本地线宽随缩放变化 */
function refreshLines() {
    if (isRect) drawSelectLines();
    if (nowMouseE) {
        const e = e2srcPoint(nowMouseE);
        ckx(e);
        inEdge(src2pXYdb(e));
    }
}

/**
 * 自动框选提示
 */
function inEdge(p: editor_position) {
    if (rectSelect) {
        setEdge([]);
        return;
    }

    rectInRect = [];
    for (const i of selectionEdgesForMode(
        edgeRect,
        captureSelectionMode,
        识别窗口,
    )) {
        const x0 = i.x;
        const y0 = i.y;
        const x1 = i.x + i.width;
        const y1 = i.y + i.height;
        if (x0 < p.x && p.x < x1 && y0 < p.y && p.y < y1) {
            rectInRect.push([i.x, i.y, i.width, i.height]);
        }
    }
    setEdge(rectInRect);
}

/** 拖动选区时的吸附参考线：只有命中边才显示，未命中时清空 */
let snapGuideKey = "";
function setSnapGuides(x: number | null, y: number | null) {
    const key = `${x ?? ""}|${y ?? ""}`;
    if (key === snapGuideKey) return;
    snapGuideKey = key;
    const w = lineW();
    const els: HTMLElement[] = [];
    if (x != null) {
        const el = document.createElement("div");
        setElBox(el, x - w / 2, 0, w, mainCanvas.height);
        el.style.background = "#ffffffd9";
        el.style.boxShadow = `0 0 0 ${w}px #00000052`;
        els.push(el);
    }
    if (y != null) {
        const el = document.createElement("div");
        setElBox(el, 0, y - w / 2, mainCanvas.width, w);
        el.style.background = "#ffffffd9";
        el.style.boxShadow = `0 0 0 ${w}px #00000052`;
        els.push(el);
    }
    snapGuideEl.el.replaceChildren(...els);
}

/** 新框选拖动时把移动角吸附到窗口/图像边缘或屏幕中线；Shift/Alt 手势跳过 */
function snapDrag(e: MouseEvent, r: rect): rect {
    if (e.altKey || e.shiftKey || !rectStartE) {
        setSnapGuides(null, null);
        return r;
    }
    const snapped = snapDragRect(
        r,
        rectStartE,
        selectionEdgesForMode(edgeRect, captureSelectionMode, 识别窗口),
        { width: mainCanvas.width, height: mainCanvas.height },
        6 / editorP.zoom,
    );
    setSnapGuides(snapped.guideX, snapped.guideY);
    return snapped.rect;
}

/** 提示框没变化就不动 DOM */
function setEdge(rects: rect[]) {
    const w = lineW();
    const key = `${w}|${rects.map((i) => i.join(",")).join(";")}`;
    if (key === edgeKey) return;
    edgeKey = key;
    clipEdge.el.replaceChildren(
        ...rects.map((i) => {
            const el = document.createElement("div");
            setElBox(el, i[0], i[1], i[2], i[3]);
            el.style.boxSizing = "border-box";
            el.style.border = `${w}px solid #000`;
            el.style.outline = `${w}px solid #fff`;
            return el;
        }),
    );
}

function renderClip(e: MouseEvent) {
    if (down) {
        moved = true;
        rectSelect = true; // 按下并移动，肯定手动选好选区了
    }

    if (selecting) {
        if (isRect) {
            // 画框
            finalRect = snapDrag(e, dragRect(e));
        } else {
            freeSelect.push(src2pXY(e2srcPoint(e)));
            finalRect = pointsOutRect(freeSelect);
        }
    }
    if (moving) {
        if (isRect) {
            moveRect(oFinalRect, oldP, { x: e.offsetX, y: e.offsetY });
        } else {
            movePoly(oPoly, oldP, { x: e.offsetX, y: e.offsetY });
        }
    }

    // 仅选区变化或遮罩形态变化时重绘遮罩
    const mask = isRect ? "rect" : freeSelect.length >= 2 ? "poly" : null;
    if (selecting || moving || maskType !== mask) drawClip();
    inEdge({ x: e.offsetX, y: e.offsetY });
    ckx(e2srcPoint(e));

    if (!selecting && !moving) {
        // 只是悬浮光标时生效，防止在新建或调整选区时光标发生突变
        if (isRect) {
            isInClipRect({ x: e.offsetX, y: e.offsetY });
        } else {
            isPointInPolygon({ x: e.offsetX, y: e.offsetY });
        }
    }
}

// 大小栏
function whBar(finalRect: rect) {
    whEl.style({
        visibility: finalRect[2] > 0 && finalRect[3] > 0 ? "visible" : "hidden",
    });
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    // 大小文字
    const d = 0;
    const x0 = String(finalRect[0] + d);
    const y0 = String(finalRect[1] + d);
    const x1 = String(finalRect[0] + d + finalRect[2]);
    const y1 = String(finalRect[1] + d + finalRect[3]);
    const w = String(finalRect[2]);
    const h = String(finalRect[3]);
    const ch =
        (四角坐标
            ? x0.length +
              1 + // ","
              y0.length +
              x1.length +
              1 + // ","
              y1.length
            : 0) +
        w.length +
        1 + // "×"
        h.length;
    const width = ch * chPX + (四角坐标 ? 8 * 4 : 8 * 2) + 24;
    whX0.el.value = x0;
    whY0.el.value = y0;
    whX1.el.value = x1;
    whY1.el.value = y1;
    whW.el.value = w;
    whH.el.value = h;
    checkWhBarWidth();
    // 位置
    const zx = (finalRect[0] + editorP.x) * editorP.zoom;
    const zy = (finalRect[1] + editorP.y) * editorP.zoom;
    const zw = finalRect[2] * editorP.zoom;
    const dw = whEl.el.offsetWidth || width;
    const dh = 34;
    const gap = 8;

    let x: number;
    x = zx + zw / 2 - dw / 2;
    x = Math.max(gap, Math.min(winWidth - dw - gap, Math.round(x)));

    let y = zy - dh - gap;
    y = Math.max(gap, Math.min(winHeight - dh - gap, Math.round(y)));

    whEl.style({
        transform: `translate(${x}px, ${y}px)`,
    });
}

function checkWhBarWidth() {
    for (const el of whL) {
        el.style({
            width: `${Math.max(4, Math.min(9, el.el.value.length + 1))}ch`,
        });
    }
}

function changeWH(el: ElType<HTMLInputElement>) {
    if (captureSelectionMode === "window") {
        whBar(finalRect);
        captureWorkspace?.showStatus(
            "창 캡처에서는 시스템 창의 원래 경계를 사용합니다.",
        );
        return;
    }
    const l0 = whL.map((i) => i.el.value);
    const l = l0.map((string) => {
        // 排除（数字运算符空格）之外的非法输入
        if (string.match(/[\d+\-*/.\s()]/g)?.length !== string.length)
            return null;
        try {
            // biome-ignore lint/security/noGlobalEval: Only numeric arithmetic characters are accepted above.
            return eval(string);
        } catch {
            return null;
        }
    });

    if (
        l.some((value) => !Number.isFinite(value)) ||
        Number(l[4]) < 1 ||
        Number(l[5]) < 1
    ) {
        whBar(finalRect);
        return;
    }

    const d = 0;
    if (el === whX0 || el === whY0) {
        finalRect[0] = Number(l[0]) - d;
        finalRect[1] = Number(l[1]) - d;
    } else if (el === whX1 || el === whY1) {
        finalRect[2] = Number(l[2]) - finalRect[0] - d;
        finalRect[3] = Number(l[3]) - finalRect[1] - d;
    } else {
        let nw = Number(l[4]);
        let nh = Number(l[5]);
        if (ratioLock && ratioLockValue > 0) {
            if (el === whW) nh = nw / ratioLockValue;
            else if (el === whH) nw = nh * ratioLockValue;
        }
        finalRect[2] = nw;
        finalRect[3] = nh;
    }
    finalRectFix();
    hisPush();
    drawClipRect();
    followBar();
}

let captureSound = localStorage.getItem("oc:capture-sound") === "1";
const flashEl = view()
    .style({
        position: "fixed",
        inset: "0",
        background: "#fff",
        opacity: "0",
        pointerEvents: "none",
        zIndex: "9999",
    })
    .addInto();
function flashCapture() {
    const prefs = captureWorkspace?.preferences();
    if (prefs && !prefs.feedback.visual) return;
    const reduced =
        prefs?.feedback.motion === "reduced" ||
        ((prefs?.feedback.motion ?? "system") === "system" &&
            matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced) return;
    flashEl.el.animate([{ opacity: 0.26 }, { opacity: 0 }], {
        duration: 170,
        easing: "ease-out",
    });
}
function playDoneSound() {
    flashCapture();
    if (!captureSound) return;
    try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.06, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
        osc.onended = () => void ctx.close();
    } catch {}
}

function applyAspect(r: number) {
    const [x, y, w, h] = finalRect;
    if (w < 2 || h < 2) return;
    const cx = x + w / 2;
    const cy = y + h / 2;
    let nw = w;
    let nh = nw / r;
    if (nh > h) {
        nh = h;
        nw = nh * r;
    }
    nw = Math.max(2, Math.round(nw));
    nh = Math.max(2, Math.round(nh));
    finalRect[0] = Math.round(cx - nw / 2);
    finalRect[1] = Math.round(cy - nh / 2);
    finalRect[2] = nw;
    finalRect[3] = nh;
    finalRectFix();
    hisPush();
    drawClipRect();
    followBar();
}

function mouseBar(finalRect: rect, e: SrcPoint) {
    const { x, y } = src2cXY(e);
    const [x0, y0, width, height] = finalRect;

    const delta = (colorSize - 1) / 2;
    const xOffset = x - delta;
    const yOffset = y - delta;

    const imageData = mainCanvasContext.getImageData(
        xOffset,
        yOffset,
        colorSize,
        colorSize,
    );

    pointColorCanvasCtx.clearRect(0, 0, colorSize, colorSize);
    pointColorCanvasBgCtx.clearRect(0, 0, colorSize, colorSize);

    pointColorCanvasBgCtx.putImageData(imageData, 0, 0);

    let points: point[] = [];

    if (isRect || freeSelect.length < 3) {
        points.push({ x: x0, y: y0 });
        points.push({ x: x0, y: y0 + height });
        points.push({ x: x0 + width, y: y0 + height });
        points.push({ x: x0 + width, y: y0 });
    } else {
        points = freeSelect;
    }

    pointColorCanvasCtx.save();

    pointColorCanvasCtx.beginPath();
    pointColorCanvasCtx.moveTo(points[0].x - xOffset, points[0].y - yOffset);
    for (let i = 1; i < points.length; i++) {
        pointColorCanvasCtx.lineTo(
            points[i].x - xOffset,
            points[i].y - yOffset,
        );
    }
    pointColorCanvasCtx.closePath();
    pointColorCanvasCtx.clip();
    pointColorCanvasCtx.drawImage(pointColorCanvasBg, 0, 0);

    pointColorCanvasCtx.restore();

    const centerIndex = (colorSize * delta + delta) * 4;
    let [r, g, b, a] = imageData.data.slice(centerIndex, centerIndex + 4);

    a /= 255;
    const cssColor = `rgb(${r} ${g} ${b} / ${a})`;
    pointCenter.style.background = cssColor;
    theColor = [r, g, b, a];
    clipColorText([r, g, b, a], 取色器默认格式);

    mouseBarXy.sv([x, y]);
}

function ckx(e: SrcPoint) {
    if (!g光标参考线) return;
    const { x, y } = src2cXY(e);
    const w = lineW();
    const cx = x + 0.5 - w / 2;
    const cy = y + 0.5 - w / 2;
    setElBox(clipCkx[0].el, 0, cy, cx, w);
    setElBox(clipCkx[1].el, cx + w, cy, mainCanvas.width - cx - w, w);
    setElBox(clipCkx[2].el, cx, 0, w, cy);
    setElBox(clipCkx[3].el, cx, cy + w, w, mainCanvas.height - cy - w);
}

function numberFormat(num: number) {
    return (num || 0).toFixed(1).replace(/\.?0+$/, "");
}

function rgba2str(rgba: colorRGBA) {
    return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})`;
}

// 色彩空间转换
function colorConversion(rgba: colorRGBA | null, type: colorFormat): string {
    const color = chroma(rgba2str(rgba || [0, 0, 0, 0]));
    if (color.alpha() !== 1) return "/";
    switch (type) {
        case "HEX":
            return color.hex();
        case "RGB":
            return color.css();
        case "HSL": {
            return color.css("hsl");
        }
        case "HSV": {
            const hsv = color.hsv();
            return `hsv(${numberFormat(hsv[0])} ${numberFormat(hsv[1] * 100)}% ${numberFormat(hsv[2] * 100)}%)`;
        }
        case "CMYK": {
            const cmyk = color.cmyk();
            return `cmyk(${numberFormat(cmyk[0] * 100)}% ${numberFormat(cmyk[1] * 100)}% ${numberFormat(cmyk[2] * 100)}% ${numberFormat(cmyk[3] * 100)}%)`;
        }
        case "HWB": {
            const [h, s, v] = color.hsv();
            return `hwb(${numberFormat(h)} ${numberFormat((1 - s) * v * 100)}% ${numberFormat((1 - v) * 100)}%)`;
        }
        case "LAB":
            return color.css("lab");
        case "LCH":
            return color.css("lch");
        case "OKLAB":
            return color.css("oklab");
        case "OKLCH":
            return color.css("oklch");
        default:
            return "";
    }
}

function getColorFormatEl() {
    return mouseBarCopyColorList[取色器格式位置];
}

// 改变颜色文字和样式
function clipColorText(l: colorRGBA, type: colorFormat) {
    const color = chroma(rgba2str(l));
    const clipColorTextColor = color.alpha() === 1 ? pickTextColor(color) : "";
    theTextColor = [color.hex(), clipColorTextColor];

    mouseBarCopyColor.el.style.backgroundColor = color.hex();
    const mainEl = getColorFormatEl();
    // 只改变默认格式的字体颜色和内容，并定位展示
    mainEl.el.style.color = theTextColor[1];
    const c = colorConversion(l, type);
    const s = c.indexOf("(");
    const main =
        s === -1
            ? c
            : c
                  .slice(s + 1, -1)
                  .replace("deg", "°")
                  .replace("none", "-");
    const minR = 0.6;
    mainEl.style({
        fontSize: `${Math.max(minR, Math.min(Math.min(colorSize * colorISize, 96) / (main.length * chPX), 1))}rem`,
    });
    mainEl.el.textContent = main;
    const minW = main.length * chPX * minR;
    mouseBarColorMinSize = minW;

    if (color.alpha() !== 1) {
        mainEl.el.style.color = "";
    }
}

// 改变鼠标跟随栏形态，展示所有颜色格式
function changeRightBar(v: boolean) {
    mouseBarCopySize
        .clear()
        .add(`${finalRect[2]} × ${finalRect[3]}`)
        .on("click", (_, el) => {
            copy(el);
        });
    mouseBarCopyColorList = allColorFormat.map((i) =>
        view()
            .add(colorConversion(theColor, i))
            .on("click", (_, el) => {
                copy(el);
            }),
    );
    mouseBarCopyColor
        .clear()
        .style({
            backgroundColor: theTextColor[0],
            color: theTextColor[1],
        })
        .add(mouseBarCopyColorList);
    const maxW = Math.max(
        ...mouseBarCopyColorList.map((i) => i.el.innerText.length * chPX),
    );
    if (v) {
        const width = maxW;
        const height = 24 * (allColorFormat.length + 2);
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        const newX = Math.min(mouseBarX, winWidth - width - 16);
        const newY = Math.min(mouseBarY, winHeight - height - 16);

        mouseBarEl.class(Class.transition).style({
            transform: `translate(${newX}px, ${newY}px)`,
        });

        mouseBarColor.el.style.height = "0";
        mouseBarCopy.style({
            width: `${maxW}px`,
            height: `${24 * (allColorFormat.length + 1)}px`,
        });
        mouseBarCopyI.el.style.top = "0";
        mouseBarEl.el.style.pointerEvents = "auto";
    } else {
        mouseBarEl.style({
            transform: `translate(${mouseBarX}px, ${mouseBarY}px)`,
        });
        setTimeout(() => {
            mouseBarEl.el.classList.remove(Class.transition);
        }, 400);
        mouseBarColor.el.style.height = "";
        mouseBarCopy.style({
            width: `${Math.max(Math.min(colorSize * colorISize, 96), mouseBarColorMinSize)}px`,
            height: "24px",
        });
        mouseBarCopyI.el.style.top = `${-24 * (取色器格式位置 + 1)}px`;
        mouseBarEl.el.style.pointerEvents = "none";
        if (theColor) clipColorText(theColor, 取色器默认格式);
    }
}

/**
 * 复制内容
 */
function copy(e: ElType<HTMLElement>) {
    writeText(e.el.innerText);
    if (theColor) captureWorkspace?.sampled(chroma(rgba2str(theColor)).hex());
    rightKey = false;
    changeRightBar(false);
}

/**
 * 工具栏自动跟随
 */
function followBar(_op?: { x: number; y: number }) {
    if (finalRect[2] <= 0 || finalRect[3] <= 0) {
        toolBar.style.opacity = "0";
        toolBar.style.pointerEvents = "none";
        drawBar.style.opacity = "0";
        drawBar.style.pointerEvents = "none";
        return;
    }
    const pinned = toolbarPinnedPos;
    toolBar.classList.toggle(
        "toolbar-horizontal",
        toolBar.offsetHeight > innerHeight - 24,
    );
    if (pinned) {
        const w = toolBar.offsetWidth;
        const h = toolBar.offsetHeight;
        toolBar.style.left = `${Math.max(0, Math.min(pinned.left, innerWidth - w))}px`;
        toolBar.style.top = `${Math.max(0, Math.min(pinned.top, innerHeight - h))}px`;
    } else {
        const dock = captureDock(
            {
                x: (finalRect[0] + editorP.x) * editorP.zoom,
                y: (finalRect[1] + editorP.y) * editorP.zoom,
                width: finalRect[2] * editorP.zoom,
                height: finalRect[3] * editorP.zoom,
            },
            { width: innerWidth, height: innerHeight },
            { width: toolBar.offsetWidth, height: toolBar.offsetHeight },
        );
        toolBar.style.left = `${dock.x}px`;
        toolBar.style.top = `${dock.y}px`;
    }
    toolBar.style.opacity = "1";
    toolBar.style.pointerEvents = "auto";
    toolBar.toggleAttribute("data-pinned", Boolean(pinned));
    updateDrawBarVis();
    trackLocation();
    positionToolPopover();
}

// 修复final_rect负数
// 超出屏幕处理
function finalRectFix() {
    if (!finalRect.every(Number.isFinite)) {
        finalRect = [0, 0, 0, 0];
        return;
    }
    finalRect = finalRect.map((i) => Math.round(i)) as rect;
    const x0 = finalRect[0];
    const y0 = finalRect[1];
    const x1 = finalRect[0] + finalRect[2];
    const y1 = finalRect[1] + finalRect[3];
    const x = Math.max(0, Math.min(mainCanvas.width, Math.min(x0, x1)));
    const y = Math.max(0, Math.min(mainCanvas.height, Math.min(y0, y1)));
    const right = Math.max(0, Math.min(mainCanvas.width, Math.max(x0, x1)));
    const bottom = Math.max(0, Math.min(mainCanvas.height, Math.max(y0, y1)));
    finalRect = [x, y, right - x, bottom - y];
}

function inRange(
    min: number,
    value: number,
    max: number,
    type: `${"[" | "("}${")" | "]"}` = "[]",
) {
    if (type === "[]") return min <= value && value <= max;
    if (type === "(]") return min < value && value <= max;
    if (type === "[)") return min <= value && value < max;
    return min < value && value < max;
}

/**
 * 判断光标位置并更改样式,定义光标位置的移动方向
 */
function isInClipRect(p: editor_position) {
    if (finalRect[2] <= 0 || finalRect[3] <= 0) {
        setClipCursor("crosshair");
        direction = "";
        return false;
    }
    let inRect = false;

    const [x0, y0, width, height] = finalRect;
    const x1 = x0 + width;
    const y1 = y0 + height;
    // 如果全屏,那允许框选
    if (
        !(
            finalRect[2] === mainCanvas.width &&
            finalRect[3] === mainCanvas.height
        )
    ) {
        if (x0 <= p.x && p.x <= x1 && y0 <= p.y && p.y <= y1) {
            // 在框选区域内,不可框选,只可调整
            inRect = true;
        } else {
            inRect = false;
        }

        direction = "";

        const num = (8 / editorP.zoom) * window.devicePixelRatio;

        // 光标样式
        if (inRange(x0, p.x, x0 + num) && inRange(y0, p.y, y0 + num)) {
            setClipCursor("nwse-resize");
            direction = "西北";
        } else if (inRange(x1 - num, p.x, x1) && inRange(y1 - num, p.y, y1)) {
            setClipCursor("nwse-resize");
            direction = "东南";
        } else if (inRange(y0, p.y, y0 + num) && inRange(x1 - num, p.x, x1)) {
            setClipCursor("nesw-resize");
            direction = "东北";
        } else if (inRange(y1 - num, p.y, y1) && inRange(x0, p.x, x0 + num)) {
            setClipCursor("nesw-resize");
            direction = "西南";
        } else if (inRange(x0, p.x, x0 + num) && inRange(y0, p.y, y1)) {
            setClipCursor("ew-resize");
            direction = "西";
        } else if (inRange(x1 - num, p.x, x1) && inRange(y0, p.y, y1)) {
            setClipCursor("ew-resize");
            direction = "东";
        } else if (inRange(y0, p.y, y0 + num) && inRange(x0, p.x, x1)) {
            setClipCursor("ns-resize");
            direction = "北";
        } else if (inRange(y1 - num, p.y, y1) && inRange(x0, p.x, x1)) {
            setClipCursor("ns-resize");
            direction = "南";
        } else if (
            inRange(x0 + num, p.x, x1 - num, "()") &&
            inRange(y0 + num, p.y, y1 - num, "()")
        ) {
            setClipCursor("move");
            direction = "move";
        } else {
            setClipCursor("crosshair");
            direction = "";
        }
    } else {
        // 全屏可框选
        setClipCursor("crosshair");
        direction = "";
        inRect = false;
    }
    return inRect;
}

/** 调整框选 */
function moveRect(
    oldFinalRect: rect | null,
    oldPosition: editor_position,
    position: editor_position,
) {
    if (!oldFinalRect) return;
    const op = oldPosition;
    const p = position;
    const dx = p.x - op.x;
    const dy = p.y - op.y;
    switch (direction) {
        case "西北":
            finalRect = [
                oldFinalRect[0] + dx,
                oldFinalRect[1] + dy,
                oldFinalRect[2] - dx,
                oldFinalRect[3] - dy,
            ];
            break;
        case "东南":
            finalRect = [
                oldFinalRect[0],
                oldFinalRect[1],
                oldFinalRect[2] + dx,
                oldFinalRect[3] + dy,
            ];
            break;
        case "东北":
            finalRect = [
                oldFinalRect[0],
                oldFinalRect[1] + dy,
                oldFinalRect[2] + dx,
                oldFinalRect[3] - dy,
            ];
            break;
        case "西南":
            finalRect = [
                oldFinalRect[0] + dx,
                oldFinalRect[1],
                oldFinalRect[2] - dx,
                oldFinalRect[3] + dy,
            ];
            break;
        case "西":
            finalRect = [
                oldFinalRect[0] + dx,
                oldFinalRect[1],
                oldFinalRect[2] - dx,
                oldFinalRect[3],
            ];
            break;
        case "东":
            finalRect = [
                oldFinalRect[0],
                oldFinalRect[1],
                oldFinalRect[2] + dx,
                oldFinalRect[3],
            ];
            break;
        case "北":
            finalRect = [
                oldFinalRect[0],
                oldFinalRect[1] + dy,
                oldFinalRect[2],
                oldFinalRect[3] - dy,
            ];
            break;
        case "南":
            finalRect = [
                oldFinalRect[0],
                oldFinalRect[1],
                oldFinalRect[2],
                oldFinalRect[3] + dy,
            ];
            break;
        case "move":
            finalRect = [
                Math.max(
                    0,
                    Math.min(
                        mainCanvas.width - oldFinalRect[2],
                        oldFinalRect[0] + dx,
                    ),
                ),
                Math.max(
                    0,
                    Math.min(
                        mainCanvas.height - oldFinalRect[3],
                        oldFinalRect[1] + dy,
                    ),
                ),
                oldFinalRect[2],
                oldFinalRect[3],
            ];
            break;
    }
    if (ratioLock && ratioLockValue > 0 && direction !== "move") {
        const r = ratioLockValue;
        const w = finalRect[2];
        const h = finalRect[3];
        if (direction === "东" || direction === "西") {
            const nh = w / r;
            finalRect[1] -= (nh - h) / 2;
            finalRect[3] = nh;
        } else if (direction === "南" || direction === "北") {
            const nw = h * r;
            finalRect[0] -= (nw - w) / 2;
            finalRect[2] = nw;
        } else if (direction) {
            if (Math.abs(dx) > Math.abs(dy) * r) {
                const nh = w / r;
                if (direction.includes("北")) finalRect[1] -= nh - h;
                finalRect[3] = nh;
            } else {
                const nw = h * r;
                if (direction.includes("西")) finalRect[0] -= nw - w;
                finalRect[2] = nw;
            }
        }
    }
    if (finalRect[0] < 0) {
        finalRect[2] = finalRect[2] + finalRect[0];
        finalRect[0] = 0;
    }
    if (finalRect[1] < 0) {
        finalRect[3] = finalRect[3] + finalRect[1];
        finalRect[1] = 0;
    }
    if (finalRect[0] + finalRect[2] > mainCanvas.width)
        finalRect[2] = mainCanvas.width - finalRect[0];
    if (finalRect[1] + finalRect[3] > mainCanvas.height)
        finalRect[3] = mainCanvas.height - finalRect[1];

    finalRectFix();
}
function isPointInPolygon(p: point): boolean {
    // 射线法判断点是否在选区多边形内
    let inside = false;
    for (let i = 0, j = freeSelect.length - 1; i < freeSelect.length; j = i++) {
        const { x: xi, y: yi } = freeSelect[i];
        const { x: xj, y: yj } = freeSelect[j];
        if (
            yi > p.y !== yj > p.y &&
            p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
        )
            inside = !inside;
    }

    if (inside) {
        setClipCursor("move");
        direction = "move";
    } else {
        setClipCursor("crosshair");
        direction = "";
    }
    return inside;
}

/** 调整框选 */
function movePoly(
    oldPoly: point[] | null,
    oldPosition: editor_position,
    position: editor_position,
) {
    if (!oldPoly) return;
    const op = oldPosition;
    const p = position;
    const dx = p.x - op.x;
    const dy = p.y - op.y;
    if (direction === "move") {
        freeSelect = oldPoly.map((i) => {
            const x = Math.round(i.x + dx);
            const y = Math.round(i.y + dy);
            return { x, y };
        });
    }
}

/**
 * 保存历史
 */
function hisPush() {
    const canvas = fabricCanvas?.toJSON() || {};
    undoStack.setData({ rect: finalRect, canvas: canvas });
    undoStack.apply();
    captureWorkspace?.changed();
}
/**
 * 更改历史指针
 * @param {boolean} v true向前 false向后
 */
function undo(v: boolean) {
    if (v) {
        undoStack.undo();
    } else {
        undoStack.unundo();
    }
    const c = undoStack.getData();
    finalRect = c.rect;
    drawClipRect();
    followBar();
    if (fabricCanvas) fabricCanvas.loadFromJSON(c.canvas);
    updateUndoButtons();
}

function getShapePro(name: keyof typeof shapePro) {
    const v = {
        fc: fillColor,
        sc: strokeColor,
        sw: strokeWidth,
        shadow: 0,
    };
    const free: (typeof name)[] = ["free", "eraser", "spray", "highlighter"];
    if (free.includes(name)) {
        v.sc = freeColor;
        v.sw = freeWidth;
    }
    if (!shapePro[name]) shapePro[name] = {};

    for (const x of ["fc", "sc", "sw", "shadow"] as const) {
        if (shapePro[name][x]) {
            // @ts-ignore
            v[x] = shapePro[name][x];
        } else {
            // @ts-ignore
            shapePro[name][x] = v[x] =
                store.get(`图像编辑.形状属性.${name}.${x}`) ?? v[x];
        }
    }
    const nv: { fc: string; sc: string; sw: number; shadow?: number } = {
        fc: v.fc,
        sc: v.sc,
        sw: v.sw,
    };
    if (free.includes(name)) nv.shadow = v.shadow;
    return nv;
}

function setEditType<T extends keyof EditType>(
    mainType: T,
    type: EditType[T],
): void {
    if (!(mainType === "select" && type === "draw")) {
        editType[mainType] = type;
        nowType = mainType;
    }

    const SELECT = "select";

    if (!drawBarOpen && mainType !== "select") {
        drawBarOpen = true;
        updateDrawBarVis();
    }

    for (const [i, mel] of Object.entries(drawMainEls)) {
        if (i === mainType) {
            mel.el.classList.add(SELECT);
            mel.el.innerHTML = drawSideEls[mainType][type].el.innerHTML;
        } else {
            mel.el.classList.remove(SELECT);
        }
        for (const [j, sel] of Object.entries(
            drawSideEls[i as keyof EditType],
        )) {
            if (i === mainType && j === type) {
                sel.el.classList.add(SELECT);
            } else {
                sel.el.classList.remove(SELECT);
            }
        }
    }

    if (mainType === "select") {
        if (type !== "draw") {
            exitFree();
            exitShape();
            exitFilter();
            drawM(false);
            if (type === "free") {
                isRect = false;
            } else {
                isRect = true;
            }
        } else {
            drawM(true);
            exitFree();
            exitShape();
            exitFilter();
        }
        backHotkeyScope();
    } else {
        drawM(true);
        toHotkeyScope("drawing");
    }
    if (mainType === "draw") {
        fabricCanvas.isDrawingMode = true;
        mode = type as EditType["draw"];
        freeInit();
        if (type === "free") {
            pencilElClick();
        }
        if (type === "eraser") {
            eraserElClick();
        }
        if (type === "spray") {
            freeSprayElClick();
        }
        if (type === "highlighter") {
            highlighterElClick();
        }
        exitShape();
        exitFilter();
        freeDrawCursor();
        ableChangeColor();
    }
    if (mainType === "filter") {
        willFilter = type as EditType["filter"];
        exitFree();
        exitShape();
        newFilterSelecting = true;
        fabricCanvas.defaultCursor = "crosshair";
    }
    if (mainType === "shape") {
        shape = type as Shape;
        if (shape) {
            const sPro = getShapePro(shape);
            colorFillEl.sv(sPro.fc);
            colorStrokeEl.sv(sPro.sc);
            strokeWidthEl.sv(sPro.sw);
        }

        exitFree();
        exitFilter();
        fabricCanvas.defaultCursor = "crosshair";

        ableChangeColor();
    }

    if (!(mainType === "select" && type === "draw"))
        store.set(`图像编辑.记忆.${mainType}`, type);

    setOnlyStroke(
        mainType === "draw" ||
            (mainType === "shape" && strokeShapes.includes(type)),
    );
}

function showSideBarItem(index: number) {
    showSideBar(true);
    for (const [i, { w, el }] of drawBarSideElChildren.entries()) {
        if (index === i) {
            const height = Math.ceil(el.el.children.length / w);
            const x = w;
            const y = height;
            el.style({ display: "", width: `${x * bSize}px` });
            let left = bSize * 1;
            if (drawBar.offsetLeft + bSize + bSize * x > window.innerWidth)
                left = -bSize * x;
            drawSideBar.style.left = `${left}px`;
            const top = bSize * Math.min(i, drawMainBar.children.length - y);
            drawSideBar.style.top = `${top}px`;
            drawSideBar.style.width = `${bSize * x}px`;
            const maxHeight =
                window.innerHeight - (drawBar.offsetTop + top) - 12;
            drawSideBar.style.height = `${Math.max(bSize, Math.min(bSize * y, maxHeight))}px`;
        } else {
            el.style({ display: "none" });
        }
    }
}

function isInDrawBar() {
    return drawBar.contains(
        document.elementFromPoint(nowMouseE.clientX, nowMouseE.clientY),
    );
}

function showSideBar(show: boolean) {
    if (show) {
        drawSideBar.classList.remove("draw_side_hide");
    } else {
        drawSideBar.classList.add("draw_side_hide");
    }
}

function showBars(b: boolean) {
    for (const i of [toolBar, drawBar]) {
        if (
            b &&
            finalRect[2] > 0 &&
            finalRect[3] > 0 &&
            (i !== drawBar || drawBarOpen)
        ) {
            i.style.pointerEvents = "";
            i.style.opacity = "";
        } else {
            i.style.pointerEvents = "none";
            i.style.opacity = "0";
        }
    }
    if (!b) {
        closeRadial();
        toolPopover.el.hidden = true;
    }
}
function pencilElClick() {
    fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush.color = getShapePro("free").sc;
    fabricCanvas.freeDrawingBrush.width = getShapePro("free").sw;

    freeShadow();
}
function eraserElClick() {
    // todo
    const eraser = new EraserBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush = eraser;
    fabricCanvas.freeDrawingBrush.width = getShapePro("eraser").sw;
}
function freeSprayElClick() {
    fabricCanvas.freeDrawingBrush = new SprayBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush.color = getShapePro("spray").sc;
    fabricCanvas.freeDrawingBrush.width = getShapePro("spray").sw;
}
const HIGHLIGHTER_ALPHA = 0.4;
function alphaColor(color: string, alpha: number) {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
    if (hex) {
        let h = hex[1];
        if (h.length === 3 || h.length === 4)
            h = [...h].map((c) => c + c).join("");
        return `rgba(${Number.parseInt(h.slice(0, 2), 16)},${Number.parseInt(h.slice(2, 4), 16)},${Number.parseInt(h.slice(4, 6), 16)},${alpha})`;
    }
    const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (rgb) {
        const p = rgb[1].split(",").map((s) => s.trim());
        return `rgba(${p[0]},${p[1]},${p[2]},${alpha})`;
    }
    return color;
}
function highlighterElClick() {
    const pro = getShapePro("highlighter");
    const brush = new PencilBrush(fabricCanvas);
    brush.color = alphaColor(pro.sc, HIGHLIGHTER_ALPHA);
    brush.width = pro.sw;
    brush.strokeLineCap = "round";
    brush.strokeLineJoin = "round";
    brush.shadow = null;
    fabricCanvas.freeDrawingBrush = brush;
}
function freeShadow() {
    if (fabricCanvas.freeDrawingBrush)
        fabricCanvas.freeDrawingBrush.shadow =
            mode === "highlighter"
                ? null
                : new Shadow({
                      blur: getShapePro("free").shadow,
                      color: getShapePro("free").sc,
                  });
}

function freeDrawCursor() {
    if (mode === "free" || mode === "eraser" || mode === "highlighter") {
        const pro = getShapePro(mode);
        let svgW = pro.sw;
        let hW = svgW / 2;
        const r = pro.sw / 2;
        if (svgW < 10) {
            svgW = 10;
            hW = 5;
        }
        let svg = "";
        if (mode === "free" || mode === "highlighter") {
            const c =
                mode === "highlighter"
                    ? alphaColor(pro.sc, HIGHLIGHTER_ALPHA)
                    : pro.sc;
            svg = `<svg width="${svgW}" height="${svgW}" xmlns="http://www.w3.org/2000/svg"><line x1="0" x2="${svgW}" y1="${hW}" y2="${hW}" stroke="#000"/><line y1="0" y2="${svgW}" x1="${hW}" x2="${hW}" stroke="#000"/><circle style="fill:${c};" cx="${hW}" cy="${hW}" r="${r}"/></svg>`;
        } else {
            svg = `<svg width="${svgW}" height="${svgW}" xmlns="http://www.w3.org/2000/svg"><line x1="0" x2="${svgW}" y1="${hW}" y2="${hW}" stroke="#000"/><line y1="0" y2="${svgW}" x1="${hW}" x2="${hW}" stroke="#000"/><circle style="stroke-width:1;stroke:#000;fill:none" cx="${hW}" cy="${hW}" r="${r}"/></svg>`;
        }
        const d = document.createElement("div");
        d.innerHTML = svg;
        const s = new XMLSerializer().serializeToString(
            d.querySelector("svg") as SVGElement,
        );
        const cursorUrl = `data:image/svg+xml;base64,${window.btoa(s)}`;
        fabricCanvas.freeDrawingCursor = `url(" ${cursorUrl} ") ${hW} ${hW}, auto`;
    } else {
        fabricCanvas.freeDrawingCursor = "auto";
    }
}

function freeInit() {
    const { sc, sw, shadow } = getShapePro(mode);
    setDrawMode("stroke");
    colorStrokeEl.sv(sc);
    strokeWidthEl.sv(sw);
    shadowBlurEl.sv(shadow);
}

function fabricDelete() {
    for (const o of fabricCanvas.getActiveObjects()) {
        fabricCanvas.remove(o);
    }
    getFObjectV();
    getFilters();
    hisPush();
}

function rotate(x: number, y: number, r: number) {
    const s = Math.sin(r);
    const c = Math.cos(r);
    return [x * c - y * s, x * s + y * c];
}

// 画一般图形
function draw(
    shape: EditType["shape"],
    v: "start" | "move",
    x1: number,
    y1: number,
    x2: number,
    y2: number,
) {
    const pro = getShapePro(shape);
    const [fillColor, strokeColor, strokeWidth] = [pro.fc, pro.sc, pro.sw];
    if (v === "move") {
        const obj = shapes.at(-1);
        if (obj) fabricCanvas.remove(obj);
        shapes.splice(shapes.length - 1, 1);
    }
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x1 - x2);
    const h = Math.abs(y1 - y2);
    let shapeX: FabricObject | null = null;
    if (shape === "line") {
        shapeX = new Line([x1, y1, x2, y2], {
            stroke: strokeColor,
            originX: "left",
            originY: "top",
            形状: "line",
        });
    } else if (shape === "circle") {
        shapeX = new Circle({
            radius: Math.max(w, h) / 2,
            left: x,
            top: y,
            originX: "left",
            originY: "top",
            fill: fillColor,
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            canChangeFill: true,
            形状: "circle",
        });
    } else if (shape === "rect") {
        shapeX = new Rect({
            left: x,
            top: y,
            width: w,
            height: h,
            originX: "left",
            originY: "top",
            fill: fillColor,
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            canChangeFill: true,
            形状: "rect",
        });
    } else if (shape === "text") {
        shapeX = new IText(t("点击输入文字"), {
            left: x,
            top: y,
            originX: "left",
            originY: "top",
            canChangeFill: true,
            形状: "text",
            fontFamily: 字体.主要字体,
        });
    } else if (shape === "arrow") {
        shapeX = new arrow([x1, y1, x2, y2], {
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            形状: "arrow",
        });
    } else if (shape === "mask") {
        shapeX = new mask({
            left: 0,
            top: 0,
            width: fabricCanvas.width,
            height: fabricCanvas.height,
            fill: fillColor,
            rect: { x, y, w, h },
            canChangeFill: true,
            形状: "mask",
        });
    } else if (shape === "stamp") {
        // 드래그 영역에 맞춰 승인/피드백 기호를 찍는 스탬프 — IText라 더블클릭으로 기호 교체 가능
        shapeX = new IText("✓", {
            left: x,
            top: y,
            originX: "left",
            originY: "top",
            fontSize: Math.max(h, 24),
            fill: fillColor || "#16a34a",
            canChangeFill: true,
            形状: "stamp",
            fontFamily: 字体.主要字体,
        });
    }
    if (shapeX) {
        shapes.push(shapeX);
        fabricCanvas.add(shapeX);
    }
}
// 多边形
function drawPoly(shape: EditType["shape"]) {
    console.log(1111);

    const pro = getShapePro(shape);
    const [fillColor, strokeColor, strokeWidth] = [pro.fc, pro.sc, pro.sw];
    if (polyOP.length !== 1) {
        const obj = shapes.at(-1);
        if (obj) fabricCanvas.remove(obj);
        shapes.splice(shapes.length - 1, 1);
    }
    let shapeX: FabricObject | null = null;
    if (shape === "polyline") {
        shapeX = new Polyline(polyOP, {
            fill: "#0000",
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            originX: "left",
            originY: "top",
            形状: "polyline",
        });
    }
    if (shape === "polygon") {
        shapeX = new Polygon(polyOP, {
            fill: fillColor,
            stroke: strokeColor,
            strokeWidth: strokeWidth,
            originX: "left",
            originY: "top",
            canChangeFill: true,
            形状: "polygon",
        });
    }
    if (shapeX) {
        shapes.push(shapeX);
        fabricCanvas.add(shapeX);
    }
}

function drawNumber() {
    const nowShape = shapes.at(-1);
    if (!nowShape) return;
    // @ts-ignore
    drawNumberN = Number(nowShape.text) + 1 || drawNumberN;
    const p = polyOP.at(-1);
    if (!p) return;

    const txt = new xnumber({
        left: p.x,
        top: p.y,
        fontSize: 16,
        radius: 12,
        originX: "center",
        originY: "center",
        fill: getShapePro("number").fc,
        stroke: getShapePro("number").sc,
        strokeWidth: getShapePro("number").sw,
        canChangeFill: true,
        text: String(drawNumberN),
        形状: "number",
    });
    shapes.push(txt);
    fabricCanvas.add(nowShape);
    fabricCanvas.setActiveObject(txt);

    drawNumberN++;
}

/** 切换当前颜色设定的ui */
function setDrawMode(m: typeof colorM) {
    colorM = m;
    if (m === "fill") {
        colorFillEl.style({ height: "" });
        colorStrokeEl.style({ height: "0" });
        drawStrokeWidth.style({ height: "0" });
        drawColorSwitchMark.style({ top: 0 }).attr({ title: t("当前为填充") });
    } else {
        colorFillEl.style({ height: "0" });
        colorStrokeEl.style({ height: "" });
        drawStrokeWidth.style({ height: "" });
        drawColorSwitchMark.style({ top: "calc(var(--bar-size) / 2)" }).attr({
            title: "当前为描边",
        });
    }
}

function ableChangeColor() {
    if (fabricCanvas.isDrawingMode || shape || fabricCanvas.getActiveObject()) {
        drawColorSide.style({ pointerEvents: "auto", opacity: "1" });
    } else {
        drawColorSide.style({ pointerEvents: "none", opacity: "0.2" });
    }
}

function pickTextColor(bg: chroma.Color, c1 = "#fff", c2 = "#000") {
    // todo 主题色
    if (chroma.contrast(bg, c1) > chroma.contrast(bg, c2)) {
        return c1;
    }
    return c2;
}

function colorInput(type: "fill" | "stroke") {
    const i = input().on("input", () => {
        setC();
        main.el.dispatchEvent(new Event("input"));
    });
    const alpha = rangeBar(0, 1, 0.01).on("input", () => {
        setC();
        main.el.dispatchEvent(new Event("input"));
    });

    function getInputV() {
        return chroma(i.gv).alpha(Number(alpha.gv));
    }
    function setC() {
        const color = getInputV();
        i.style({ "background-color": color.hex() });

        let textColor = "#000";
        const tColor = color;
        const bgColor = chroma(
            window
                .getComputedStyle(document.documentElement)
                .getPropertyValue("--bar-bg0"),
        );
        if (tColor.alpha() >= 0.5 || tColor.alpha() === undefined) {
            textColor = pickTextColor(tColor); // todo 直接混合
        } else {
            // 低透明度背景呈现栏的颜色
            textColor = pickTextColor(bgColor);
        }
        i.style({ color: textColor });

        if (type === "fill") {
            drawColorEl.el.style.backgroundColor = color.hex();
        }
        if (type === "stroke") {
            drawColorEl.el.style.borderColor = color.hex();
        }
    }
    const main = view()
        .add([i, alpha])
        .bindSet((v: string) => {
            const color = chroma(v);
            i.sv(color.hex());
            alpha.sv(color.alpha());
            setC();
        })
        .bindGet(() => {
            return getInputV().hex();
        });
    return main;
}

/** 主编辑栏的属性预览显示为描边 */
function setOnlyStroke(b: boolean) {
    const el = drawColorEl;
    if (b) {
        el.style({
            width: 0,
            rotate: "45deg",
        });
    } else {
        el.style({
            width: "",
            rotate: "",
        });
    }
    setDrawMode(b ? "stroke" : "fill");
}

// 色盘
function colorBar() {
    // 主盘
    const colorList = [0];
    for (let i = 0; i < 360; i += 15) {
        colorList.push(i);
    }
    let isNext = false;
    showColor();
    // 下一层级
    function nextColor(h: number) {
        const nextColorList: string[] = [];
        if (h === 0) {
            for (let i = 0; i < 25; i++) {
                const x = (100 / 24) * (24 - i);
                nextColorList.push(`hsl(0, 0%, ${x}%)`);
            }
        } else {
            for (let i = 90; i > 0; i -= 20) {
                for (let j = 100; j > 0; j -= 20) {
                    nextColorList.push(`hsl(${h}, ${j}%, ${i}%)`);
                }
            }
        }
        drawColorColor.clear().add(
            Object.values(nextColorList).map((v) => {
                return view()
                    .class("color_i")
                    .style({
                        "background-color": v,
                    })
                    .data({
                        title: colorConversion(
                            chroma(v).rgba(),
                            取色器默认格式,
                        ),
                    });
            }),
        );
    }
    function showColor() {
        drawColorColor.clear().add(
            colorList.map((x, i) => {
                return view()
                    .class("color_i")
                    .style({
                        "background-color":
                            i === 0 ? "#fff" : `hsl(${x}, 100%, 50%)`,
                    })
                    .data({
                        i: i.toString(),
                        title: colorConversion(
                            chroma(x).rgba(),
                            取色器默认格式,
                        ),
                    });
            }),
        );
    }
    // 事件
    function cColor(el: HTMLElement) {
        const color = el.style.backgroundColor;
        if (colorM === "fill") {
            colorFillEl.sv(color);
            setFObjectV(color, null, null);
        }
        if (colorM === "stroke") {
            colorStrokeEl.sv(color);
            setFObjectV(null, color, null);
        }
    }
    drawColorColor.on("pointerdown", (e) => {
        const el = e.target as HTMLElement;
        if (e.button === 0) {
            cColor(el);
        } else {
            isNext = !isNext;
            if (isNext) {
                const index = Number(el.getAttribute("data-i"));
                nextColor(colorList[index]);
            } else {
                showColor();
            }
        }
    });
}

/** 鼠标点击后，改变栏文字样式 */
function getFObjectV() {
    const pro: {
        fc: string | undefined;
        sc: string | undefined;
        sw: number | undefined;
    } = { fc: fillColor, sc: strokeColor, sw: strokeWidth };
    const n = fabricCanvas.getActiveObject();
    if (n) {
        // todo 当线与形一起选中，确保形不会透明
        pro.fc = n.fill?.toString();
        pro.sc = n.stroke?.toString();
        pro.sw = n.strokeWidth;
        if ((n as FabricImage).filters) {
            pro.fc = fillColor;
            pro.sc = strokeColor;
            pro.sw = strokeWidth;
        }
        setOnlyStroke(!n.canChangeFill);
    } else if (fabricCanvas.isDrawingMode) {
        pro.fc = shapePro.free?.sc;
        pro.sc = shapePro.free?.sc;
        pro.sw = shapePro.free?.sw;
    } else {
        if (nowType === "shape" || nowType === "draw") {
            const p = shapePro[editType[nowType]];
            pro.fc = p?.fc;
            pro.sc = p?.sc;
            pro.sw = p?.sw;
        }
    }
    console.log(pro);
    strokeWidthEl.sv(pro.sw ?? strokeWidth);
    colorFillEl.sv(pro.fc ?? fillColor);
    colorStrokeEl.sv(pro.sc ?? strokeColor);

    const activeObj = fabricCanvas.getActiveObject() as
        | (FabricObject & { fontSize?: number })
        | undefined;
    fontSizeRow.el.hidden = !(activeObj && activeObj.fontSize !== undefined);

    ableChangeColor();
}
/**
 * 更改全局或选中形状的颜色
 * @param {String} fill 填充颜色
 * @param {String} stroke 边框颜色
 * @param {Number} sw 边框宽度
 */
function setFObjectV(
    fill: string | null,
    stroke: string | null,
    sw: number | null,
) {
    if (fabricCanvas.getActiveObject()) {
        console.log(0);
        /* 选中Object */
        const n = fabricCanvas.getActiveObjects();
        for (const i of n) {
            if (fill) {
                // 只改变形的颜色
                if (i.canChangeFill) i.set("fill", fill);
            }
            if (stroke) i.set("stroke", stroke);
            if (sw) i.set("strokeWidth", sw);
            if (i.形状) {
                store.set(`图像编辑.形状属性.${i.形状}.fc`, fill || fillColor);
                store.set(
                    `图像编辑.形状属性.${i.形状}.sc`,
                    stroke || strokeColor,
                );
                store.set(`图像编辑.形状属性.${i.形状}.sw`, sw || strokeWidth);
                shapePro[i.形状] = {
                    fc: fill || fillColor,
                    sc: stroke || strokeColor,
                    sw: sw || strokeWidth,
                };
            }
        }
        fabricCanvas.renderAll();
    } else if (fabricCanvas.isDrawingMode) {
        console.log(1);
        /* 画笔 */
        if (stroke) {
            if (fabricCanvas.freeDrawingBrush)
                fabricCanvas.freeDrawingBrush.color =
                    mode === "highlighter"
                        ? alphaColor(stroke, HIGHLIGHTER_ALPHA)
                        : stroke;
            const s = shapePro[editType.draw];
            if (s) s.sc = stroke;
        }
        if (sw) {
            if (fabricCanvas.freeDrawingBrush)
                fabricCanvas.freeDrawingBrush.width = sw;
            const s = shapePro[editType.draw];
            if (s) s.sw = sw;
        }
        freeDrawCursor();
        freeShadow();
        if (mode) {
            store.set(`图像编辑.形状属性.${mode}.sc`, stroke || strokeColor);
            store.set(`图像编辑.形状属性.${mode}.sw`, sw || strokeWidth);
        }
    } else {
        console.log(2);
        /* 非画笔非选中 */
        const pro = shapePro[editType.shape] ?? {};
        if (fill) pro.fc = fill;
        if (stroke) pro.sc = stroke;
        if (sw) pro.sw = sw;
        store.set(`图像编辑.形状属性.${editType.shape}`, pro);
    }
}

function newFilterSelect(o: point, no: point) {
    const x1 = Math.round(o.x);
    const y1 = Math.round(o.y);
    const x2 = Math.round(no.x);
    const y2 = Math.round(no.y);
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x1 - x2);
    const h = Math.abs(y1 - y2);

    const mainCtx = mainCanvas.getContext("2d")!;
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const gid = mainCtx.getImageData(x, y, w, h); // 裁剪
    tmpCanvas.getContext("2d")!.putImageData(gid, 0, 0);
    const img = new FabricImage(tmpCanvas, {
        left: x,
        top: y,
        originX: "left",
        originY: "top",
        lockMovementX: true,
        lockMovementY: true,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        hasControls: false,
        hoverCursor: "auto",
    });
    fabricCanvas.add(img);
    fabricCanvas.setActiveObject(img);
}

// biome-ignore lint/suspicious/noExplicitAny: 适配库
function applyFilter(i: number, filter: filters.BaseFilter<string, any>) {
    const obj = fabricCanvas.getActiveObject() as FabricImage;
    obj.filters[i] = filter;
    obj.applyFilters();
    fabricCanvas.renderAll();
}
function getFilters() {
    const obj = fabricCanvas.getActiveObject() as FabricImage;
    if (!obj?.filters) return;
    const f = obj.filters;

    const values = Object.values(filtetMap);
    for (const fl of values) {
        const i = values.indexOf(fl);
        if (fl.value) {
            if (f[i]) {
                const name = typedKeys(filtetMap)[i];
                const range = (
                    fl.el?.() ??
                    rangeBar(
                        fl.value.min,
                        fl.value.max,
                        fl.value.step,
                        fl.value.text,
                    )
                )
                    .on("input", () => {
                        // @ts-ignore
                        const filter = fl.fun(range.gv);
                        console.log(range.gv);

                        applyFilter(i, filter);
                    })
                    .sv(Object.values(f[i])[0]);
                filterRangeEl.clear().add(range);
                if (fl.levels) {
                    const chips = view("x").class("filter-levels");
                    for (const level of fl.levels) {
                        button(String(level))
                            .attr({ type: "button" })
                            .on("click", () => {
                                range.sv(level);
                                range.el.dispatchEvent(new Event("input"));
                            })
                            .addInto(chips);
                    }
                    filterRangeEl.add(chips);
                }
                for (const i of Object.values(drawSideEls.filter)) {
                    i.el.classList.remove("filter_select");
                }
                drawSideEls.filter[name].el.classList.add("filter_select");
            }
        }
    }
}

// 确保退出其他需要鼠标事件的东西，以免多个东西一起出现
function exitFree() {
    fabricCanvas.isDrawingMode = false;
    fabricCanvas.defaultCursor = "auto";
}
function exitShape() {
    shape = "";
    drawingShape = false;
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = "auto";
    polyOP = [];
}
function exitFilter() {
    newFilterSelecting = false;
    fabricCanvas.defaultCursor = "auto";
    willFilter = "";
}

async function fabricCopy() {
    const dx = store.get("图像编辑.复制偏移.x");
    const dy = store.get("图像编辑.复制偏移.y");
    const activeObject = fabricCanvas.getActiveObject();
    if (!activeObject) return;
    const fabricClipboard = await activeObject.clone();
    const clonedObj = await fabricClipboard.clone();
    fabricCanvas.discardActiveObject();
    clonedObj.set({
        left: clonedObj.left + dx,
        top: clonedObj.top + dy,
        evented: true,
    });
    if (clonedObj instanceof ActiveSelection) {
        clonedObj.canvas = fabricCanvas;
        clonedObj.forEachObject((obj) => {
            fabricCanvas.add(obj);
        });
        clonedObj.setCoords();
    } else {
        fabricCanvas.add(clonedObj);
    }
    fabricCanvas.setActiveObject(clonedObj);
    fabricCanvas.requestRenderAll();
    hisPush();
}

// 获取设置

const screenShotCache = new Map<number, ImageData>();

const 字体 = store.get("字体");

const allColorFormat: colorFormat[] = [
    "HEX",
    "RGB",
    "HSL",
    "HSV",
    "HWB",
    "LAB",
    "LCH",
    "OKLAB",
    "OKLCH",
    "CMYK",
];

const 四角坐标 = store.get("显示四角坐标");
const 遮罩颜色 = store.get("框选.颜色.遮罩") || "#0008";
const 取色器默认格式 = store.get("取色器.默认格式");
const 取色器格式位置 = allColorFormat.indexOf(取色器默认格式);
const 取色器显示 = store.get("取色器.显示");
const colorSize = store.get("取色器.大小");
const colorISize = store.get("取色器.像素大小");
const 记忆框选 = store.get("框选.记忆.开启");
const 记忆框选值 = store.get("框选.记忆.rects") as {
    [id: string]: rect;
};
const 识别窗口 = store.get("框选.识别窗口");
let bSize = store.get("工具栏.按钮大小");
if (!Number.isFinite(bSize) || bSize < 28 || bSize > 44) bSize = 32;

const g光标参考线 = store.get("框选.参考线.光标");
const x选区参考线 = store.get("框选.参考线.选区");
const c参考线颜色 = store.get("框选.颜色");

const 全局缩放 = store.get("全局.缩放") || 1.0;
let ratio = 1;

setSetting();

const tools: 功能列表 = [
    "close",
    "screens",
    "ocr",
    "ocrcopy",
    "search",
    "QR",
    "open",
    "ding",
    "record",
    "long",
    "translate",
    "editor",
    "redact",
    "copy",
    "save",
];

const hotkeyTipEl = view().attr({ id: "hotkeys_tip" }).class(Class.glassBar);

const toolsX: Record<功能, { el: ElType<HTMLElement>; f: () => void }> = {
    close: {
        el: iconEl("close").attr({ title: t("关闭") }),
        f: () => closeWin(),
    },
    screens: { el: view().attr({ title: t("屏幕管理") }), f: () => {} },
    ocr: {
        el: selectEl(
            iconEl("ocr"),
            t("文字识别"),
            ocrList(store).map((v) => ({
                name: typeof v.name === "string" ? t(v.name) : v.name.text,
                value: v.value,
            })),
        ),
        f: () => runOcr(),
    },
    ocrcopy: {
        el: iconEl("copy").attr({
            title: "复制文字",
            role: "button",
        }),
        f: () => runOcrCopy(),
    },
    search: {
        el: selectEl(iconEl("search"), t("以图搜图"), [
            { value: "baidu", name: t("百度") },
            { value: "yandex", name: "Yandex" },
            { value: "google", name: "Google" },
            { value: "ai", name: "AI" },
        ]),
        f: () => runSearch(),
    },
    QR: { el: iconEl("scan").attr({ title: t("二维码") }), f: () => runQr() },
    open: {
        el: iconEl("open").attr({ title: t("其他应用打开") }),
        f: () => openApp(),
    },
    ding: {
        el: iconEl("ding").attr({ title: t("屏幕贴图") }),
        f: () => runDing(),
    },
    record: {
        el: selectEl<"old" | "normal" | "super">(iconEl("record"), t("录屏"), [
            { name: t("录屏（旧）"), value: "old" },
            { name: t("普通录屏"), value: "normal" },
            { name: t("超级录屏"), value: "super" },
        ]),
        f: () => initRecord(),
    },
    long: {
        el: selectEl<"y" | "xy">(iconEl("long_clip"), t("广截屏"), [
            { name: t("长截屏 y"), value: "y" },
            { name: t("广截屏 xy"), value: "xy" },
        ]),
        f: () => startLong(),
    },
    translate: {
        el: selectEl<translateWinType["type"]>(
            iconEl("translate"),
            t("屏幕翻译"),
            [
                { name: t("贴图"), value: "ding" },
                { name: t("自动翻译"), value: "live" },
            ],
        ),
        f: () => translate(),
    },
    editor: {
        el: iconEl("super_edit").attr({ title: t("高级图片编辑") }),
        f: () => {
            const c = getClipPhoto();
            renderSend("clip_editor", [c.toDataURL()]);
            toolsX.close.f();
        },
    },
    redact: {
        el: iconEl("hide").attr({
            title: "민감한 텍스트 자동 가림",
            role: "button",
        }),
        f: () => void autoRedact(),
    },
    copy: { el: iconEl("copy").attr({ title: t("复制") }), f: () => runCopy() },
    save: { el: iconEl("save").attr({ title: t("保存") }), f: () => runSave() },
};

for (const [id, tool] of Object.entries(toolsX)) {
    const action = tool.f;
    tool.f = () => {
        if (id !== "close" && id !== "screens" && !requireCaptureSelection())
            return;
        return action();
    };
    const { el, f } = tool;
    el.on("pointerup", (e) => {
        if (e.target === el.el)
            if (e.button === 0) {
                f();
            } else if (e.button === 1) {
                el.el.style.backgroundColor = ""; // todo class
                autoDo = "no";
            }
    });
}

const toolBarEl = view().attr({ id: "tool_bar" }).class(Class.glassBar);
for (const [id, { el }] of Object.entries(toolsX)) {
    toolBarEl.add(el.attr({ id: `tool_${id}` }));
}

const liveTranslationButton = iconEl("translate").attr({
    id: "tool_live_translation",
    role: "button",
    tabIndex: 0,
    title: "선택 영역 실시간 번역 켜기",
    ariaLabel: "선택 영역 실시간 번역 켜기",
    ariaPressed: "false",
});
toolBarEl.add(liveTranslationButton);

toolsX.long.el.sv(store.get("广截屏.方向"));
toolsX.long.el.on("change", () => {
    store.set("广截屏.方向", toolsX.long.el.gv);
    longFX = toolsX.long.el.gv;
    toolsX.long.f();
});

toolsX.record.el.sv(store.get("录屏.模式"));
toolsX.record.el.on("change", () => {
    store.set("录屏.模式", toolsX.record.el.gv);
    toolsX.record.f();
});

toolsX.translate.el.sv(store.get("屏幕翻译.type"));
toolsX.translate.el.on("change", () => {
    store.set("屏幕翻译.type", toolsX.translate.el.gv);
    toolsX.translate.f();
});

toolBarEl.style({
    left: store.get("工具栏.初始位置.left"),
    top: store.get("工具栏.初始位置.top"),
});

const toolsOrder = store.get("工具栏.功能");
for (const g of tools) {
    const id = g;
    const i = toolsOrder.indexOf(id);
    const el = toolsX[id].el;
    if (i !== -1) el.style({ order: String(i) });
    else el.style({ display: "none" });
}

const drawBarEl = view().attr({ id: "draw_bar" }).addInto();
const drawBarMainEl = view()
    .attr({ id: "draw_main" })
    .class(Class.glassBar)
    .addInto(drawBarEl);
const drawBarSideEl = view()
    .attr({ id: "draw_side" })
    .class(Class.glassBar)
    .addInto(drawBarEl);

const drawColorEl = view();

const drawMainElsx = {
    select: iconEl("rect_select").attr({
        id: "draw_select",
        title: "选择与控制",
    }),
    free: iconEl("free_draw").attr({ id: "draw_free", title: t("自由绘画") }),
    shapes: iconEl("shapes").attr({
        id: "draw_shapes",
        title: t("形状和文字"),
    }),
    filters: iconEl("filters").attr({ id: "draw_filters", title: t("滤镜") }),
    color: view()
        .attr({ id: "draw_color", title: t("颜色和大小") })
        .add(drawColorEl),
    position: iconEl("position").attr({
        id: "draw_position",
        title: "层叠高度",
    }),
    操作: iconEl("setting").attr({ id: "draw_操作", title: t("操作") }),
} as const;

const drawBarMainElList = Object.values(drawMainElsx);
for (const el of drawBarMainElList) {
    drawBarMainEl.add(el);
}

const drawSideSelect = {
    rect: iconEl("rect_select").attr({ title: t("矩形选择") }),
    free: iconEl("free_select").attr({ title: t("自由选择") }),
    draw: iconEl("draw_select").attr({ title: t("移动") }),
} as const;

const drawSideFree = {
    pencil: iconEl("draw").attr({ title: t("画笔") }),
    eraser: iconEl("eraser").attr({ title: t("橡皮") }),
    spray: iconEl("spray").attr({ title: t("喷刷") }),
    highlighter: iconEl("highlighter").attr({ title: t("荧光笔") }),
} as const;

const drawShadowBlur = view().attr({ id: "shadow_blur" });

const drawSideShapes = {
    line: iconEl("line").attr({ title: t("线条") }),
    circle: iconEl("circle").attr({ title: t("圆") }),
    rect: iconEl("rect").attr({ title: t("矩形") }),
    polyline: iconEl("polyline").attr({ title: t("折线") }),
    polygon: iconEl("polygon").attr({ title: t("多边形") }),
    text: iconEl("text").attr({ title: t("文字") }),
    number: iconEl("number").attr({ title: t("序号") }),
    arrow: iconEl("arrow").attr({ title: t("箭头") }),
    mask: iconEl("mask").attr({ title: t("遮罩") }),
    stamp: iconEl("star").attr({ title: "스탬프" }),
} as const;

const filterRangeEl = view().class("draw_filters_range");

const drawSideFilters = {
    pixelate: iconEl("pixelate").attr({ title: t("马赛克") }),
    blur: iconEl("blur").attr({ title: t("模糊") }),
    brightness: iconEl("brightness").attr({ title: t("亮度") }),
    contrast: iconEl("contrast").attr({ title: t("对比度") }),
    saturation: iconEl("saturation").attr({ title: t("饱和度") }),
    hue: iconEl("hue").attr({ title: t("色调") }),
    gamma: view().attr({ title: t("伽马") }),
    noise: view().attr({ title: t("噪点") }),
} as const;

const drawSideFiltersMoreGray = {
    gray_average: view().attr({ title: t("平均灰度") }),
    gray_lightness: view().attr({ title: t("亮度") }),
    gray_luminosity: view().attr({ title: t("亮度") }),
};

const drawSideFiltersMore = {
    invert: filterEl("invert", "负片"),
    sepia: filterEl("sepia", "棕褐色"),
    bw: filterEl("bw", "黑白"),
    brownie: filterEl("brownie", "布朗尼"),
    vintage: filterEl("vintage", "老式"),
    koda: filterEl("koda", "柯达彩色胶片"),
    techni: filterEl("techni", "特艺色彩"),
    polaroid: filterEl("polaroid", "宝丽来"),
} as const;

const drawSideFiltersAll = {
    ...drawSideFilters,
    ...drawSideFiltersMoreGray,
    ...drawSideFiltersMore,
} as const;

const drawColorSwitchP = view().attr({ id: "draw_color_switch" });
const drawColorSwitchMark = view()
    .attr({ id: "draw_fill_storke_mark" })
    .addInto(drawColorSwitchP);
drawColorSwitchP.add(
    image(getImgUrl("fill_storke.svg"), "icon")
        .class("icon")
        .style({ zIndex: 1 }),
);

const drawColorP = view().attr({ id: "draw_color_p" });
const drawColorColor = view().attr({ id: "draw_color_color" });
const drawStrokeWidth = view().attr({ id: "draw_stroke_width" });

const fontSizeRow = view("x").class("font-size-presets");
for (const size of [12, 16, 24, 32, 48, 72]) {
    button(String(size))
        .attr({ type: "button", title: t("글자 크기") })
        .on("click", () => {
            const obj = fabricCanvas.getActiveObject() as
                | (FabricObject & { fontSize?: number; radius?: number })
                | undefined;
            if (!obj || obj.fontSize === undefined) return;
            obj.set("fontSize", size);
            if (obj.形状 === "number")
                obj.set("radius", Math.max(12, size * 0.75));
            fabricCanvas.renderAll();
            hisPush();
        })
        .addInto(fontSizeRow);
}
fontSizeRow.el.hidden = true;

const drawColorSide = drawSideGen2("color_size").add([
    drawColorSwitchP,
    drawColorP,
    drawColorColor,
    drawStrokeWidth,
    fontSizeRow,
]);

const drawSidePosition = {
    front: iconEl("position_front").attr({ title: t("移动到最顶端") }),
    forwards: iconEl("position_forwards").attr({ title: t("向上移动一层") }),
    backwards: iconEl("position_backwards").attr({ title: t("向下移动一层") }),
    back: iconEl("position_back").attr({ title: t("移动到最底端") }),
} as const;

const drawSide操作 = {
    撤回: iconEl("left")
        .attr({ title: t("撤回") })
        .data({ key: showShortKey("Control+Z") }),
    重做: iconEl("right")
        .attr({ title: t("重做") })
        .data({ key: showShortKey("Control+Y") }),
    复制: iconEl("copy")
        .attr({ title: t("复制") })
        .data({ key: showShortKey("Control+C") }),
    删除: iconEl("clear")
        .attr({ title: t("删除") })
        .data({ key: showShortKey("Delete") }),
} as const;

function filterEl(name: string, title: string) {
    return view().attr({ id: `draw_filters_${name}`, title });
}

function drawSideGen(els: Record<string, ElType<HTMLElement>>, pid: string) {
    return Object.entries(els).map(([k, v]) => {
        v.attr({ id: `draw_${pid}_${k}` });
        return v;
    });
}
function drawSideGen2(pid: string) {
    return view()
        .class("draw_items")
        .attr({ id: `draw_${pid}_i` });
}

const drawBarSideElChildren: { w: number; el: ElType<HTMLElement> }[] = [
    {
        w: 1,
        el: drawSideGen2("select").add(drawSideGen(drawSideSelect, "select")),
    },
    {
        w: 1,
        el: drawSideGen2("free").add([
            ...drawSideGen(drawSideFree, "free"),
            drawShadowBlur,
        ]),
    },
    {
        w: 2,
        el: drawSideGen2("shapes").add(drawSideGen(drawSideShapes, "shapes")),
    },
    {
        w: 3,
        el: drawSideGen2("filters").add([
            filterRangeEl,
            ...drawSideGen(drawSideFilters, "filters"),
            ...Object.values(drawSideFiltersMoreGray),
            view()
                .attr({ id: "draw_filters_bs" })
                .add(Object.values(drawSideFiltersMore)),
        ]),
    },
    { w: 1, el: drawColorSide },
    {
        w: 1,
        el: drawSideGen2("position").add(
            drawSideGen(drawSidePosition, "position"),
        ),
    },
    { w: 1, el: drawSideGen2("操作").add(drawSideGen(drawSide操作, "操作")) },
];

drawBarSideEl.add(drawBarSideElChildren.map((i) => i.el));

const whEl = view("x").attr({ id: "clip_wh" }).class(Class.glassBar, Class.gap);
const whX0 = input();
const whY0 = input();
const whX1 = input();
const whY1 = input();
const whW = input();
const whH = input();
const whL = [whX0, whY0, whX1, whY1, whW, whH];
let ratioLock = false;
let ratioLockValue = 1;
const whCoordinates = view("x")
    .class("capture-coordinates")
    .add([
        view().add([whX0, txt(", "), whY0]),
        view().add([whX1, txt(", "), whY1]),
    ]);
whCoordinates.el.hidden = true;
const coordinateToggle = button(captureIcon("position"))
    .attr({ title: t("좌표"), type: "button", ariaExpanded: "false" })
    .on("click", () => {
        whCoordinates.el.hidden = !whCoordinates.el.hidden;
        coordinateToggle.el.setAttribute(
            "aria-expanded",
            String(!whCoordinates.el.hidden),
        );
        whBar(finalRect);
    });
const whLock = button(captureIcon("lock"))
    .attr({ title: t("비율 고정"), type: "button", ariaPressed: "false" })
    .on("click", () => {
        ratioLock = !ratioLock;
        if (ratioLock && finalRect[2] > 0 && finalRect[3] > 0)
            ratioLockValue = finalRect[2] / finalRect[3];
        whLock.el.setAttribute("aria-pressed", String(ratioLock));
    });
let rulerImprint = localStorage.getItem("oc:ruler-imprint") === "1";
const whRuler = button()
    .attr({
        title: t("눈금 새기기"),
        type: "button",
        ariaPressed: String(rulerImprint),
    })
    .class("wh-ruler-toggle", rulerImprint ? "active" : "")
    .add(txt("‖"))
    .on("click", () => {
        rulerImprint = !rulerImprint;
        localStorage.setItem("oc:ruler-imprint", rulerImprint ? "1" : "0");
        whRuler.el.setAttribute("aria-pressed", String(rulerImprint));
        whRuler.el.classList.toggle("active", rulerImprint);
    });
const whRatios = view("x").class("capture-ratios");
for (const [ratioLabel, rw, rh] of [
    ["1:1", 1, 1],
    ["3:2", 3, 2],
    ["4:3", 4, 3],
    ["16:9", 16, 9],
    ["9:16", 9, 16],
] as const) {
    whRatios.add(
        button(txt(ratioLabel))
            .class("wh-ratio-chip")
            .attr({ type: "button", title: t("비율 맞추기") })
            .on("click", (e) => {
                e.stopPropagation();
                applyAspect(rw / rh);
            }),
    );
}
whRatios.el.hidden = true;
const ratioToggle = button(txt("a:b"))
    .class("wh-ruler-toggle")
    .attr({ title: t("비율 프리셋"), type: "button", ariaExpanded: "false" })
    .on("click", () => {
        whRatios.el.hidden = !whRatios.el.hidden;
        ratioToggle.el.setAttribute(
            "aria-expanded",
            String(!whRatios.el.hidden),
        );
        whBar(finalRect);
    });
whW.attr({ ariaLabel: t("너비"), inputMode: "numeric" });
whH.attr({ ariaLabel: t("높이"), inputMode: "numeric" });
whEl.add([
    whCoordinates,
    whRatios,
    view("x")
        .class("capture-dimensions")
        .add([whW, txt("×"), whH, txt("px")]),
    whLock,
    whRuler,
    coordinateToggle,
    ratioToggle,
    button(txt("?"))
        .class("wh-ruler-toggle")
        .attr({ title: t("제스처 · 단축키 도움말"), type: "button" })
        .on("click", (e) => {
            e.stopPropagation();
            captureHelp.el.hidden = !captureHelp.el.hidden;
            dismissStartHint();
        }),
]);

let chPX = 0;
const chCal = txt("0").style({ width: "1ch" });
chCal.addInto();
chPX = chCal.el.offsetWidth;
chCal.remove();

const longTip = frame("long_tip", {
    _: view().attr({ id: "long_tip" }),
    rect: {
        _: view().attr({ id: "long_rect" }),
        finish: view().attr({ id: "long_finish" }),
    },
});

const longPreview = view().style({ position: "fixed" });

const captureHelp = view("y").class("capture-help").addInto();
captureHelp.el.hidden = true;
captureHelp.add(ele("strong").attr({ textContent: t("단축키") }));
for (const [key, desc] of [
    ["↑ ← ↓ → · WASD", t("선택 영역 이동")],
    ["Ctrl", t("5픽셀 이동")],
    ["Shift", t("드래그 시 정사각형 · 10픽셀 이동")],
    ["Shift+드래그", t("영역 추가 (최대 12개)")],
    ["Alt", t("중심 기준 확장")],
    ["휠 클릭 드래그", t("도넛 빠른 동작 · 캔버스 팬")],
    ["우클릭", t("도넛 메뉴 · 가운데 놓기는 취소")],
    ["Enter", t("확인 · 저장")],
    ["Esc", t("취소 · 닫기")],
    ["Ctrl+Z · Ctrl+Y / Ctrl+Shift+Z", t("실행 취소 · 다시 실행")],
    ["Delete", t("도형 삭제")],
    ["?", t("이 도움말 표시")],
] as const) {
    captureHelp.add(
        view("x")
            .class("capture-help-row")
            .add([ele("kbd").attr({ textContent: key }), textDesc(desc)]),
    );
}
function textDesc(desc: string) {
    return ele("span").attr({ textContent: desc });
}
captureHelp.el.addEventListener("click", () => {
    captureHelp.el.hidden = true;
});

const startHint = view("x").class("capture-start-hint").addInto();
let startHintDismissed = Boolean(store.get("框选.记忆.启动提示"));
const startHintItems: [string, string][] = [
    ["드래그", t("영역 선택")],
    ["S", t("자동 선택")],
];
for (const [tool, label] of [
    ["copy", "복사"],
    ["save", "저장"],
] as const) {
    const key = (store.get(`工具快捷键.${tool}` as never) as string) ?? "";
    if (key)
        startHintItems.push([
            key
                .split("+")
                .map((k) => jsKeyCodeDisplay(ele2jsKeyCode(k)).primary)
                .join("+"),
            t(label),
        ]);
}
startHintItems.push(["Esc", t("닫기")], ["?", t("단축키")]);
for (const [key, desc] of startHintItems) {
    startHint.add(
        view("x")
            .class("capture-start-hint-item")
            .add([ele("kbd").attr({ textContent: key }), textDesc(desc)]),
    );
}
if (startHintDismissed) startHint.el.classList.add("hint-hidden");

function dismissStartHint() {
    if (startHintDismissed) return;
    startHintDismissed = true;
    store.set("框选.记忆.启动提示", true);
    startHint.el.classList.add("hint-hidden");
}
function updateStartHint() {
    startHint.el.classList.toggle(
        "hint-hidden",
        startHintDismissed || !captureHelp.el.hidden,
    );
}

hotkeyTipEl.addInto();
toolBarEl.addInto();
whEl.addInto();
longTip.el.addInto();
longPreview.addInto();

const centerBarEl = view()
    .attr({ id: "center_bar" })
    .class(Class.glassBar)
    .addInto();
const saveType = view()
    .attr({ id: "save_type" })
    .addInto(centerBarEl)
    .add(view().add(t("保存文件格式为")));
const saveTypeList: SaveFileType[] = [
    "png",
    "jpg",
    "webp",
    "bmp",
    "svg",
    "pdf",
    "ocap",
];
const suffixList = saveTypeList.map((i) =>
    view()
        .data({ value: i })
        .add(i)
        .on("click", () => {
            type = i;
            showSaveBar(false);
            renderSend("clip_hide", []);
            save(renderSendSync("clip_save", [i]));
        }),
);
view().attr({ id: "suffix" }).add(suffixList).addInto(saveType);

const colorFillEl = colorInput("fill").on("input", () => {
    setFObjectV(colorFillEl.gv, null, null);
});
const colorStrokeEl = colorInput("stroke").on("input", () => {
    setFObjectV(colorStrokeEl.gv, null, null);
});

drawColorP.add([colorFillEl, colorStrokeEl]);

const editor = view().attr({ id: "editor" }).addInto();
const mainCanvas = ele("canvas").attr({ id: "main_photo" }).el;
const clipEl = ele("div").attr({ id: "clip_photo" }).el;
const drawCanvas = ele("canvas").attr({ id: "draw_photo" }).el;
const drawP = view().attr({ id: "draw_photo_top" }).add(drawCanvas);
editor.add([mainCanvas, clipEl, drawP]);

/** 遮罩：矩形用四块围合，自由多边形用 clip-path 挖洞 */
const clipMaskRect = Array.from({ length: 4 }, () =>
    view().style({ background: 遮罩颜色 }),
);
const clipMaskPoly = view().style({ background: 遮罩颜色 });
/** 选区参考线 */
const clipSelectLineX = x选区参考线.x.map(() =>
    view().style({ background: c参考线颜色.选区参考线 }),
);
const clipSelectLineY = x选区参考线.y.map(() =>
    view().style({ background: c参考线颜色.选区参考线 }),
);
const clipSelectLines = [...clipSelectLineX, ...clipSelectLineY];
/** 光标参考线：左右横线、上下竖线 */
const clipCkx = Array.from({ length: 4 }, () =>
    view().style({ background: c参考线颜色.光标参考线 }),
);
/** 自动框选提示 */
const clipEdge = view().style({
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
});
const snapGuideEl = view().attr({ id: "capture_snap_guides" }).style({
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
});
clipEl.append(
    ...clipMaskRect.map((i) => i.el),
    clipMaskPoly.el,
    ...clipSelectLines.map((i) => i.el),
    clipEdge.el,
    snapGuideEl.el,
    ...clipCkx.map((i) => i.el),
);

editor.style({ width: `${window.screen.width / 全局缩放}px` });
// 第一次截的一定是桌面,所以可提前定义
mainCanvas.width = drawCanvas.width =
    window.screen.width * window.devicePixelRatio;
mainCanvas.height = drawCanvas.height =
    window.screen.height * window.devicePixelRatio;
setClipSize(mainCanvas.width, mainCanvas.height);
let zoomW = 0;
type rect = [number, number, number, number];
type point = { x: number; y: number };
let finalRect = [0, 0, mainCanvas.width, mainCanvas.height] as rect;
let freeSelect: point[] = [];

const liveTranslationPreview = view()
    .attr({
        id: "live_translation_preview",
        role: "status",
        ariaLive: "polite",
        ariaLabel: "선택 영역 실시간 번역 결과",
    })
    .style({
        position: "fixed",
        left: "16px",
        bottom: "16px",
        zIndex: "9998",
        display: "none",
        maxWidth: "min(560px, calc(100vw - 32px))",
        maxHeight: "40vh",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        padding: "12px 14px",
        borderRadius: "8px",
        background: "rgba(20, 20, 20, 0.9)",
        color: "white",
        boxShadow: "0 4px 18px rgba(0, 0, 0, 0.35)",
        pointerEvents: "none",
    })
    .addInto();

let liveTranslationEnabled = false;
let liveOcrPromise: Promise<
    Awaited<ReturnType<typeof import("esearch-ocr").init>>
> | null = null;

const liveTranslationController = new LatestLiveTranslation<string>(
    (text) => {
        liveTranslationPreview.el.textContent =
            text || t("번역할 텍스트가 없습니다.");
    },
    (error) => {
        liveTranslationPreview.el.textContent =
            error instanceof Error
                ? error.message
                : "실시간 번역에 실패했습니다.";
    },
);

async function getLiveOcr() {
    if (!liveOcrPromise) {
        const loaded = loadOCR(store, store.get("OCR.类型") || defaultOcrId);
        if (!loaded) throw new Error("로컬 OCR 모델을 사용할 수 없습니다.");
        liveOcrPromise = loaded.ocr.init(loaded.config);
    }
    return liveOcrPromise;
}

async function translateCurrentSelection(
    isCurrent: () => boolean = () => true,
) {
    if (finalRect[2] < 2 || finalRect[3] < 2) return "";
    const image = getClipPhoto().toDataURL();
    const from = store.get("屏幕翻译.语言.from") || "auto";
    const to = store.get("屏幕翻译.语言.to") || "ko";
    const ocr = await getLiveOcr();
    if (!isCurrent()) return "";
    const result = await ocr.ocr(image);
    if (!isCurrent()) return "";
    const texts = result.columns
        .flatMap((column) => column.parragraphs)
        .map((paragraph) => paragraph.parse.text.trim())
        .filter(Boolean);
    if (!texts.length) return "";
    const response = await ipcRenderer.invoke("oc:translate", {
        texts,
        from,
        to,
    });
    return normalizeTranslatedTexts(response).join("\n");
}

async function autoRedact() {
    try {
        await captureWorkspace?.reviewRedactions();
    } catch (error) {
        captureWorkspace?.showError(error);
    }
}

function scheduleLiveTranslation() {
    if (!liveTranslationEnabled) return;
    if (
        selecting ||
        moving ||
        longRunning ||
        finalRect[2] < 2 ||
        finalRect[3] < 2
    ) {
        liveTranslationController.cancel();
        liveTranslationPreview.el.textContent = "";
        return;
    }
    liveTranslationPreview.el.textContent = "번역 중…";
    liveTranslationController.schedule(translateCurrentSelection);
}

function setLiveTranslationEnabled(enabled: boolean) {
    liveTranslationEnabled = enabled;
    liveTranslationButton.attr({
        title: enabled
            ? "선택 영역 실시간 번역 끄기"
            : "선택 영역 실시간 번역 켜기",
        ariaLabel: enabled
            ? "선택 영역 실시간 번역 끄기"
            : "선택 영역 실시간 번역 켜기",
        ariaPressed: String(enabled),
    });
    liveTranslationButton.el.style.backgroundColor = enabled
        ? "var(--bar-focus-color)"
        : "";
    liveTranslationPreview.el.style.display = enabled ? "block" : "none";
    if (enabled) {
        scheduleLiveTranslation();
    } else {
        liveTranslationController.cancel();
        liveTranslationPreview.el.textContent = "";
    }
}

liveTranslationButton
    .on("click", () => setLiveTranslationEnabled(!liveTranslationEnabled))
    .on("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setLiveTranslationEnabled(!liveTranslationEnabled);
        }
    });

ipcRenderer.on("oc:capture-mode", (_event, payload: unknown) => {
    const mode =
        typeof payload === "string"
            ? payload
            : payload && typeof payload === "object" && "mode" in payload
              ? (payload as { mode?: unknown }).mode
              : undefined;
    if (mode !== "previous-region") return;
    const remembered = 记忆框选值[nowScreenId];
    if (!remembered?.[2] || !remembered?.[3]) return;
    finalRect = [...remembered];
    rectSelect = true;
    finalRectFix();
    drawClip();
    followBar();
});

const drawBar = drawBarEl.el;
toolBarEl.style({ display: "none" });

type CaptureTool =
    | 功能
    | "draw"
    | "color"
    | "more"
    | "stage"
    | "compare"
    | "textselect"
    | "promote"
    | "trash";
let captureTools: { id: CaptureTool; title: string }[] = [
    { id: "copy", title: "복사" },
    { id: "stage", title: "임시 저장" },
    { id: "draw", title: "주석" },
    { id: "ding", title: "고정" },
    { id: "ocrcopy", title: "텍스트 복사" },
    { id: "translate", title: "번역" },
    { id: "color", title: "색상 추출" },
    { id: "more", title: "더보기" },
];
const secondaryTools: { id: CaptureTool; title: string }[] = [
    { id: "save", title: "저장" },
    { id: "textselect", title: "글자 선택" },
    { id: "compare", title: "레퍼런스 비교" },
    { id: "promote", title: "보관함으로 이동" },
    { id: "trash", title: "휴지통으로 이동" },
    { id: "long", title: "스크롤 캡처" },
    { id: "record", title: "녹화" },
    { id: "redact", title: "자동 가림" },
    { id: "QR", title: "QR 코드" },
    { id: "ocr", title: "텍스트 인식" },
    { id: "search", title: "이미지 검색" },
    { id: "editor", title: "상세 편집" },
    { id: "open", title: "다른 앱에서 열기" },
    { id: "screens", title: "화면 전환" },
];

const quickToolbar = view("x")
    .attr({ id: "quick_toolbar", role: "toolbar", ariaLabel: t("캡처 도구") })
    .style({ opacity: "0", pointerEvents: "none" })
    .addInto();
const toolBar = quickToolbar.el;
let toolbarPinnedPos = store.get("工具栏.快捷位置");
const toolPopover = view()
    .attr({ id: "capture_tools", role: "group", ariaLabel: t("추가 도구") })
    .addInto();
toolPopover.el.hidden = true;
const visiblePopoverTools = () =>
    Array.from(
        toolPopover.el.querySelectorAll<HTMLButtonElement>(".capture-tool"),
    ).filter((b) => b.style.display !== "none");
toolPopover.el.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key))
        return;
    const tools = visiblePopoverTools();
    const i = tools.indexOf(e.target as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    tools[(i + step + tools.length) % tools.length].focus();
});
const radialMenu = view()
    .attr({ id: "radial_menu", role: "menu", ariaLabel: t("캡처 도구") })
    .addInto();
let drawBarOpen = false;
let radialOpen = false;
let radialOrigin = { x: 0, y: 0 };
let radialPage = 0;
let renderRecentTools: (() => void) | undefined;

function toolButton(
    item: { id: CaptureTool; title: string },
    withLabel = false,
) {
    const control = button(captureIcon(item.id))
        .attr({
            type: "button",
            title: t(item.title),
            ariaLabel: t(item.title),
        })
        .class("capture-tool");
    const key =
        item.id === "draw" ||
        item.id === "stage" ||
        item.id === "compare" ||
        item.id === "textselect" ||
        item.id === "promote" ||
        item.id === "trash" ||
        item.id === "more" ||
        item.id === "color"
            ? ""
            : store.get(`工具快捷键.${item.id}` as never);
    control.el.setAttribute(
        "data-title",
        `${t(item.title)}${key ? ` · ${String(key)}` : ""}`,
    );
    control.el.dataset.captureAction = item.id;
    if (withLabel) control.add(txt(t(item.title)));
    control.on("click", (e) => {
        e.stopPropagation();
        const bounds = control.el.getBoundingClientRect();
        if (item.id === "more") {
            if (radialOpen)
                openRadial(
                    radialOrigin.x,
                    radialOrigin.y,
                    (radialPage + 1) % radialPageCount(),
                );
            else {
                toolPopover.el.hidden = !toolPopover.el.hidden;
                moreButton.el.setAttribute(
                    "aria-expanded",
                    String(!toolPopover.el.hidden),
                );
                positionToolPopover();
                if (!toolPopover.el.hidden)
                    toolPopover.el
                        .querySelector<HTMLInputElement>(".capture-tool-search")
                        ?.focus();
            }
            return;
        }
        closeRadial();
        toolPopover.el.hidden = true;
        runCaptureTool(item.id, {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
        });
    });
    return control;
}

const moreButton = toolButton({ id: "more", title: "더보기" }).attr({
    ariaExpanded: "false",
});

const controlSize = input("range")
    .attr({ min: "28", max: "44", step: "2", ariaLabel: t("도구 크기") })
    .sv(String(bSize))
    .on("input", () => {
        bSize = Number(controlSize.el.value);
        store.set("工具栏.按钮大小", bSize);
        setSetting();
        updateCaptureToolbarFit(true);
        followBar();
    });
toolPopover.add(
    view("x")
        .class("capture-size-setting")
        .add([txt(t("도구 크기")), controlSize]),
);

const experienceTools: Record<
    CaptureToolId,
    { id: CaptureTool; title: string }
> = {
    copy: { id: "copy", title: "복사" },
    stage: { id: "stage", title: "임시 저장" },
    annotate: { id: "draw", title: "주석" },
    pin: { id: "ding", title: "고정" },
    ocr: { id: "textselect", title: "글자 선택" },
    redact: { id: "redact", title: "자동 가림" },
    compare: { id: "compare", title: "레퍼런스 비교" },
    promote: { id: "promote", title: "보관함으로 이동" },
    trash: { id: "trash", title: "휴지통으로 이동" },
    more: { id: "more", title: "더보기" },
    save: { id: "save", title: "저장" },
    color: { id: "color", title: "색상 추출" },
    scroll: { id: "long", title: "스크롤 캡처" },
    record: { id: "record", title: "녹화" },
    search: { id: "search", title: "이미지 검색" },
    qr: { id: "QR", title: "QR 코드" },
    open: { id: "open", title: "다른 앱에서 열기" },
    screens: { id: "screens", title: "화면 전환" },
};

let visibleToolbarIds: CaptureToolId[] = [];
let toolbarFixedWidth = 0;

function renderQuickToolbar(ids: readonly CaptureToolId[]) {
    quickToolbar.clear();
    quickToolbar.add(
        view()
            .class("capture-grip")
            .attr({
                title: t("이동 · 더블클릭으로 위치 초기화"),
                ariaLabel: t("이동 · 더블클릭으로 위치 초기화"),
            })
            .on("dblclick", (e) => {
                e.stopPropagation();
                toolbarPinnedPos = null;
                store.set("工具栏.快捷位置", null);
                toolBar.toggleAttribute("data-pinned", false);
                followBar();
            }),
    );
    for (const id of ids) {
        const control = toolButton(experienceTools[id]);
        control.el.dataset.toolbarFavorite = "";
        control.el.classList.toggle(
            "is-primary",
            id === capturePrimaryToolId(),
        );
        quickToolbar.add(control);
    }
    quickToolbar.add(view().class("capture-divider"));
    quickToolbar.add(moreButton);
    quickToolbar.add(toolButton({ id: "close", title: "닫기" }));
}

function updateCaptureToolbarFit(measureFixedWidth = false) {
    const favorites = capturePreferences.toolbarOrder.filter(
        (id) => id !== "more",
    );
    if (measureFixedWidth || !toolbarFixedWidth) {
        visibleToolbarIds = [];
        renderQuickToolbar(visibleToolbarIds);
        toolbarFixedWidth = toolBar.getBoundingClientRect().width;
    }
    const style = getComputedStyle(toolBar);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const fit = fitCaptureToolbar(favorites, {
        viewportWidth: innerWidth,
        favoriteWidth: bSize,
        fixedWidth: toolbarFixedWidth,
        gap,
    });
    if (
        fit.visible.length === visibleToolbarIds.length &&
        fit.visible.every((id, index) => id === visibleToolbarIds[index])
    )
        return;
    visibleToolbarIds = fit.visible;
    renderQuickToolbar(visibleToolbarIds);
}

function rebuildCaptureTools() {
    captureTools = capturePreferences.radialOrder
        .filter((id) => id !== "more")
        .slice(0, 7)
        .map((id) => experienceTools[id]);
    captureTools.push({ id: "more", title: "더보기" });
    toolPopover.clear();
    const toolSearch = input("text")
        .class("capture-tool-search")
        .attr({
            type: "search",
            placeholder: t("도구 검색"),
            ariaLabel: t("도구 검색"),
        })
        .on("input", (_e, element) => {
            const q = element.el.value.trim().toLowerCase();
            for (const b of toolPopover.el.querySelectorAll<HTMLElement>(
                ".capture-tool",
            ))
                b.style.display = (b.textContent ?? "")
                    .toLowerCase()
                    .includes(q)
                    ? ""
                    : "none";
        })
        .on("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                visiblePopoverTools()[0]?.click();
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                visiblePopoverTools()[0]?.focus();
            } else if (e.key === "Escape") {
                e.stopPropagation();
                if (toolSearch.el.value) {
                    toolSearch.el.value = "";
                    toolSearch.el.dispatchEvent(new Event("input"));
                } else {
                    toolPopover.el.hidden = true;
                    moreButton.el.focus();
                }
            }
        });
    toolPopover.add(view("x").class("capture-tool-search-row").add(toolSearch));
    const all = [...Object.values(experienceTools), ...secondaryTools];
    const byId = new Map(all.map((item) => [item.id, item]));
    const recentRow = view("x").class("capture-tool-recent");
    renderRecentTools = () => {
        recentRow.clear();
        let recents: string[] = [];
        try {
            recents = JSON.parse(
                localStorage.getItem("oc:recent-tools") ?? "[]",
            ) as string[];
        } catch {}
        const items = recents
            .map((id) => byId.get(id as CaptureTool))
            .filter((item): item is (typeof all)[number] => Boolean(item))
            .slice(0, 4);
        recentRow.el.hidden = !items.length;
        for (const item of items) recentRow.add(toolButton(item, true));
    };
    renderRecentTools();
    toolPopover.add(recentRow);
    const seen = new Set<CaptureTool>();
    for (const item of all) {
        if (item.id === "more" || seen.has(item.id)) continue;
        seen.add(item.id);
        toolPopover.add(toolButton(item, true));
    }
    let saveCopyOn = Boolean(store.get("保存.保存并复制"));
    const saveCopyToggle = button()
        .class("capture-toggle", saveCopyOn ? "active" : "")
        .attr({
            type: "button",
            title: t("저장할 때 클립보드에도 복사"),
            ariaPressed: String(saveCopyOn),
        })
        .add(txt(t("저장+복사")))
        .on("click", () => {
            saveCopyOn = !saveCopyOn;
            store.set("保存.保存并复制", saveCopyOn);
            saveCopyToggle.el.classList.toggle("active", saveCopyOn);
            saveCopyToggle.el.setAttribute("aria-pressed", String(saveCopyOn));
        });
    toolPopover.add(
        view("x")
            .class("capture-size-setting")
            .add([txt(t("저장 후")), saveCopyToggle]),
    );
    const soundToggle = button()
        .class("capture-toggle", captureSound ? "active" : "")
        .attr({
            type: "button",
            title: t("완료 시 짧은 소리"),
            ariaPressed: String(captureSound),
        })
        .add(txt(t("완료음")))
        .on("click", () => {
            captureSound = !captureSound;
            localStorage.setItem("oc:capture-sound", captureSound ? "1" : "0");
            soundToggle.el.classList.toggle("active", captureSound);
            soundToggle.el.setAttribute("aria-pressed", String(captureSound));
        });
    toolPopover.add(
        view("x")
            .class("capture-size-setting")
            .add([txt(t("피드백")), soundToggle]),
    );
    const delaySteps = [0, 3, 5, 10];
    let captureDelay = delaySteps.includes(Number(store.get("框选.延迟")))
        ? Number(store.get("框选.延迟"))
        : 0;
    const delayToggle = button()
        .class("capture-toggle", captureDelay > 0 ? "active" : "")
        .attr({
            type: "button",
            title: t("다음 캡처 전 대기 시간"),
            ariaPressed: String(captureDelay > 0),
        })
        .add(txt(captureDelay > 0 ? `${captureDelay}s` : t("지연 없음")))
        .on("click", () => {
            captureDelay =
                delaySteps[
                    (delaySteps.indexOf(captureDelay) + 1) % delaySteps.length
                ];
            store.set("框选.延迟", captureDelay);
            delayToggle.el.classList.toggle("active", captureDelay > 0);
            delayToggle.el.setAttribute(
                "aria-pressed",
                String(captureDelay > 0),
            );
            delayToggle.el.textContent =
                captureDelay > 0 ? `${captureDelay}s` : t("지연 없음");
        });
    toolPopover.add(
        view("x")
            .class("capture-size-setting")
            .add([txt(t("지연 캡처")), delayToggle]),
    );
    toolPopover.add(
        view("x")
            .class("capture-size-setting")
            .add([txt(t("도구 크기")), controlSize]),
    );
    updateCaptureToolbarFit(true);
}
rebuildCaptureTools();

const toolbarResizeObserver = new ResizeObserver(() => {
    updateCaptureToolbarFit();
    if (mainCanvas.width) followBar();
});
toolbarResizeObserver.observe(toolBar);

function positionToolPopover() {
    if (toolPopover.el.hidden) return;
    const bar = toolBar.getBoundingClientRect();
    toolPopover.el.style.maxHeight = "";
    const naturalHeight = toolPopover.el.offsetHeight;
    const belowSpace = innerHeight - bar.bottom - 16;
    const aboveSpace = bar.top - 16;
    const below = naturalHeight <= belowSpace || belowSpace >= aboveSpace;
    toolPopover.el.style.maxHeight = `${Math.max(180, below ? belowSpace : aboveSpace)}px`;
    toolPopover.style({
        left: `${Math.max(12, Math.min(innerWidth - toolPopover.el.offsetWidth - 12, bar.left))}px`,
        top: `${below ? bar.bottom + 8 : Math.max(12, bar.top - toolPopover.el.offsetHeight - 8)}px`,
    });
}

function updateDrawBarVis() {
    const visible = drawBarOpen && finalRect[2] > 0 && finalRect[3] > 0;
    drawBar.style.opacity = visible ? "1" : "0";
    drawBar.style.pointerEvents = visible ? "auto" : "none";
    toolBar
        .querySelector<HTMLButtonElement>('[data-capture-action="draw"]')
        ?.setAttribute("aria-pressed", String(drawBarOpen));
    trackLocation();
}

function closeRadial() {
    if (gestureOrigin) suppressContextUntil = Date.now() + 350;
    gestureOrigin = null;
    radialOpen = false;
    radialMenu.style({ display: "none" });
    radialMenu.el.replaceChildren();
}

function runCaptureTool(id: CaptureTool, point = radialOrigin) {
    if (
        !["close", "screens", "color", "more"].includes(id) &&
        !requireCaptureSelection()
    )
        return;
    if (id !== "more") {
        try {
            const key = "oc:recent-tools";
            const list = JSON.parse(
                localStorage.getItem(key) ?? "[]",
            ) as string[];
            const next = [id, ...list.filter((i) => i !== id)].slice(0, 4);
            localStorage.setItem(key, JSON.stringify(next));
            renderRecentTools?.();
        } catch {}
    }
    if (id === "stage") {
        void captureWorkspace
            ?.stage(true)
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "compare") {
        void captureWorkspace
            ?.compare()
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "textselect") {
        void captureWorkspace
            ?.showText()
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "promote") {
        void captureWorkspace
            ?.promote()
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "trash") {
        void captureWorkspace
            ?.trash()
            .then(() => closeWin())
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "draw") {
        drawBarOpen = !drawBarOpen;
        if (drawBarOpen) toolPopover.el.hidden = true;
        if (!drawBarOpen) setEditType("select", "rect");
        updateDrawBarVis();
        return;
    }
    if (id === "color") {
        if (nowMouseE) pickColor(nowMouseE);
        void captureWorkspace
            ?.showPalette()
            .catch((error) => captureWorkspace?.showError(error));
        return;
    }
    if (id === "screens") {
        if (allScreens.length > 1) {
            const index = allScreens.findIndex(
                (screen) => screen.id === nowScreenId,
            );
            void setScreen(allScreens[(index + 1) % allScreens.length]).catch(
                (error) => captureWorkspace?.showError(error),
            );
        }
        return;
    }
    if (id === "more") {
        openRadial(point.x, point.y, (radialPage + 1) % radialPageCount());
        return;
    }
    toolsX[id].f();
}

function radialPageCount() {
    const count = secondaryTools.filter(
        (item) => item.id !== "screens" || allScreens?.length > 1,
    ).length;
    return 1 + Math.ceil(count / 7);
}

function openRadial(cx: number, cy: number, page = 0) {
    toolPopover.el.hidden = true;
    radialOrigin = { x: cx, y: cy };
    radialPage = page;
    const available = secondaryTools.filter(
        (item) => item.id !== "screens" || allScreens?.length > 1,
    );
    const items =
        page === 0
            ? captureTools
            : [
                  ...available.slice((page - 1) * 7, page * 7),
                  {
                      id: "more" as const,
                      title:
                          page + 1 < radialPageCount()
                              ? "다음 도구"
                              : "처음으로",
                  },
              ];
    const layout = radialLayout(
        radialOrigin,
        { width: innerWidth, height: innerHeight },
        items.length,
        bSize + 4,
    );
    radialOrigin = { ...layout.center };
    radialMenu.el.replaceChildren();
    const halo = view()
        .class("radial-halo")
        .style({
            left: `${layout.center.x}px`,
            top: `${layout.center.y}px`,
            width: `${layout.radius * 2}px`,
            height: `${layout.radius * 2}px`,
        });
    radialMenu.add(halo);
    const center = button(captureIcon("close"))
        .class("radial-center")
        .attr({ type: "button", title: t("닫기"), ariaLabel: t("닫기") })
        .style({ left: `${layout.center.x}px`, top: `${layout.center.y}px` })
        .on("click", closeRadial);
    radialMenu.add(center);
    for (const [index, item] of items.entries()) {
        const point = layout.points[index];
        const control = toolButton(item)
            .class("radial_item")
            .attr({ role: "menuitem" })
            .style({ left: `${point.x}px`, top: `${point.y}px` });
        control.el.classList.toggle(
            "is-primary",
            item.id === capturePrimaryToolId(),
        );
        control.el.style.setProperty(
            "--radial-from-x",
            `${layout.center.x - point.x}px`,
        );
        control.el.style.setProperty(
            "--radial-from-y",
            `${layout.center.y - point.y}px`,
        );
        control.el.style.animationDelay = `${index * 12}ms`;
        radialMenu.add(control);
    }
    radialMenu.style({ display: "block" });
    radialOpen = true;
    radialMenu.el
        .querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
}

document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    if (gestureOrigin || Date.now() < suppressContextUntil) {
        e.preventDefault();
        return;
    }
    if (
        target.closest(
            "#quick_toolbar, #radial_menu, #capture_inline_shelf, #capture_palette, #capture_redact_review",
        )
    ) {
        e.preventDefault();
        return;
    }
    if (
        target.closest(
            "input, textarea, #draw_bar, #center_bar, #capture_tools",
        )
    )
        return;
    e.preventDefault();
    if (longInited) return;
    nowMouseE = e;
    rightKey = false;
    changeRightBar(false);
    openRadial(e.clientX, e.clientY);
});

document.addEventListener(
    "pointerdown",
    (e) => {
        const target = e.target as Node;
        if (e.button === 0 && !radialMenu.el.contains(target)) closeRadial();
        if (!toolPopover.el.contains(target) && !toolBar.contains(target)) {
            toolPopover.el.hidden = true;
            moreButton.el.setAttribute("aria-expanded", "false");
        }
    },
    true,
);

document.addEventListener(
    "keydown",
    (e) => {
        if (e.key === "Escape" && captureWorkspace?.hasPanel()) {
            e.stopImmediatePropagation();
            e.preventDefault();
            captureWorkspace.dismiss();
            return;
        }
        if (
            e.key === "Escape" &&
            (radialOpen || !toolPopover.el.hidden || drawBarOpen)
        ) {
            e.stopImmediatePropagation();
            e.preventDefault();
            closeRadial();
            toolPopover.el.hidden = true;
            drawBarOpen = false;
            setEditType("select", "rect");
            updateDrawBarVis();
            toolBar.querySelector<HTMLButtonElement>("button")?.focus();
        } else if (
            radialOpen &&
            ["ArrowRight", "ArrowLeft", "Tab"].includes(e.key)
        ) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const controls = Array.from(
                radialMenu.el.querySelectorAll<HTMLButtonElement>("button"),
            );
            const index = controls.indexOf(
                document.activeElement as HTMLButtonElement,
            );
            const step = e.key === "ArrowLeft" || e.shiftKey ? -1 : 1;
            controls[
                (index + step + controls.length) % controls.length
            ]?.focus();
        }
    },
    true,
);

const selectionHandles = view().attr({ id: "selection_handles" }).addInto();
selectionHandles.el.hidden = true;
const handleDirections = [
    ["nw", "西北"],
    ["n", "北"],
    ["ne", "东北"],
    ["e", "东"],
    ["se", "东南"],
    ["s", "南"],
    ["sw", "西南"],
    ["w", "西"],
] as const;
function finishHandleResize(commit: boolean) {
    const drag = handleDrag;
    if (!drag) return;
    handleDrag = null;
    if (drag.handle.hasPointerCapture(drag.pointerId))
        drag.handle.releasePointerCapture(drag.pointerId);
    if (!commit) finalRect = drag.rect;
    direction = "";
    finalRectFix();
    if (commit) {
        rememberLastRect();
        hisPush();
    }
    drawClip();
    followBar();
}
for (const [position, resizeDirection] of handleDirections) {
    const handle = button()
        .attr({
            type: "button",
            ariaLabel: `${t("크기 조절")} ${position}`,
            tabIndex: -1,
        })
        .class("capture-handle", `handle-${position}`)
        .addInto(selectionHandles);
    handle.on("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        closeRadial();
        liveTranslationController.cancel();
        handleDrag = {
            handle: handle.el,
            pointerId: e.pointerId,
            rect: [...finalRect],
            origin: src2pXY(e2srcPoint(e)),
        };
        handle.el.setPointerCapture(e.pointerId);
    });
    handle.on("pointermove", (e) => {
        const drag = handleDrag;
        if (
            !drag ||
            drag.handle !== handle.el ||
            drag.pointerId !== e.pointerId
        )
            return;
        direction = resizeDirection;
        moveRect(drag.rect, drag.origin, src2pXY(e2srcPoint(e)));
        drawClip();
        followBar();
    });
    handle
        .on("pointerup", (e) => {
            if (
                handleDrag?.handle === handle.el &&
                handleDrag.pointerId === e.pointerId
            )
                finishHandleResize(true);
        })
        .on("pointercancel", (e) => {
            if (
                handleDrag?.handle === handle.el &&
                handleDrag.pointerId === e.pointerId
            )
                finishHandleResize(false);
        });
}

function syncSelectionHandles() {
    selectionHandles.el.hidden =
        captureSelectionMode === "window" ||
        !isRect ||
        selecting ||
        nowType !== "select" ||
        !finalRect[2] ||
        !finalRect[3];
    selectionHandles.style({
        left: `${(finalRect[0] + editorP.x) * editorP.zoom}px`,
        top: `${(finalRect[1] + editorP.y) * editorP.zoom}px`,
        width: `${finalRect[2] * editorP.zoom}px`,
        height: `${finalRect[3] * editorP.zoom}px`,
    });
}

window.addEventListener("resize", () => {
    updateCaptureToolbarFit();
    if (!mainCanvas.width) return;
    whBar(finalRect);
    syncSelectionHandles();
    followBar();
    if (radialOpen) openRadial(radialOrigin.x, radialOrigin.y, radialPage);
});

let nowScreenId = 0;
let captureSelectionMode: CaptureSelectionMode = "region";

let allScreens: Awaited<ReturnType<typeof screenShots>>["screen"];
let windows: Awaited<ReturnType<typeof screenShots>>["window"];

let nowMouseE: MouseEvent;

const editorP = { zoom: 1, x: 0, y: 0 };

let middleB: PointerEvent | null = null;
const middleP = { x: 0, y: 0 };

const edgeRect: CaptureSelectionEdge[] = [];

const drawMainEls: { [key in keyof EditType]: ElType<HTMLElement> } = {
    select: drawMainElsx.select,
    draw: drawMainElsx.free,
    shape: drawMainElsx.shapes,
    filter: drawMainElsx.filters,
};
const drawSideEls: {
    [key in keyof EditType]: { [key1 in EditType[key]]: ElType<HTMLElement> };
} = {
    select: drawSideSelect,
    draw: {
        free: drawSideFree.pencil,
        eraser: drawSideFree.eraser,
        spray: drawSideFree.spray,
        highlighter: drawSideFree.highlighter,
    },
    filter: drawSideFiltersAll,
    shape: drawSideShapes,
};

const mouseBarEl = view()
    .attr({ id: "mouse_bar" })
    .class(Class.glassBar)
    .addInto();
const mouseBarColor = view().attr({ id: "point_color" }).addInto(mouseBarEl);
const mouseBarXy = view()
    .attr({ id: "clip_xy" })
    .addInto(mouseBarEl)
    .bindSet((v: [number, number], el) => {
        el.textContent = `(${v[0]}, ${v[1]})`;
    });
const mouseBarCopy = view().attr({ id: "clip_copy" }).addInto(mouseBarEl);
const mouseBarCopyI = view().addInto(mouseBarCopy);
const mouseBarCopySize = view().addInto(mouseBarCopyI);
const mouseBarCopyColor = view().addInto(mouseBarCopyI);
let mouseBarCopyColorList: ElType<HTMLElement>[] = [];
let mouseBarColorMinSize = 10;

type hotkeyScope = "normal" | "c_bar" | "drawing";
const hotkeyScopes: hotkeyScope[] = [];

const drawHotKey = store.get("截屏编辑快捷键");

type hotkeyTip = { name: string; keys: string[] }[];
const hotkeyTipX: { name: string; hotkey: hotkeyTip }[] = [
    {
        name: "画布",
        hotkey: [
            { name: "移动", keys: [t("方向键"), "wheel"] },
            { name: "缩放", keys: ["Control+wheel"] },
        ],
    },
    {
        name: "框选",
        hotkey: [
            { name: "全选", keys: ["Control+A"] },
            { name: "移动和调节", keys: [t("按住+方向键")] },
            { name: "×5", keys: ["+Control+"] },
            { name: "×10", keys: ["+Shift+"] },
            { name: "左上x", keys: [store.get("大小栏快捷键.左上x")] },
            { name: "左上y", keys: [store.get("大小栏快捷键.左上y")] },
            { name: "右下x", keys: [store.get("大小栏快捷键.右下x")] },
            { name: "右下y", keys: [store.get("大小栏快捷键.右下y")] },
            { name: "宽", keys: [store.get("大小栏快捷键.宽")] },
            { name: "高", keys: [store.get("大小栏快捷键.高")] },
            { name: "自动框选", keys: ["S"] },
            { name: "匹配自动框选", keys: [`Shift ${t("框选")}`] },
        ],
    },
    {
        name: "数值",
        hotkey: [
            { name: "大", keys: ["Up"] },
            { name: "小", keys: ["Down"] },
            { name: "取消更改", keys: ["RightKey"] },
        ],
    },
    {
        name: "取色器",
        hotkey: [
            { name: "展示所有颜色格式", keys: ["RightKey"] },
            { name: "复制颜色", keys: [store.get("其他快捷键.复制颜色")] },
        ],
    },
    { name: "快捷键", hotkey: [{ name: "展示", keys: ["Alt"] }] },
];

let autoDo = store.get("框选后默认操作");

let lastLong = 0;

let uIOhook: typeof import("uiohook-napi")["uIOhook"] | null;
let longClipTime: NodeJS.Timeout | null = null;

const longHide = Array.from(document.body.children).filter(
    (i) => i !== longTip.el.el && i !== longPreview.el,
) as HTMLElement[];

const longX = {
    img: null as HTMLCanvasElement | null,
    imgXY: { x: 0, y: 0 },
    lastImg: null as HTMLCanvasElement | null,
    lastXY: { x: 0, y: 0 },
};

let longRunning = false;
let longInited = false;
let longMouse: NodeJS.Timeout | null = null;

let longFX: typeof toolsX.long.el.gv = "y";

type SaveFileType = setting["保存"]["默认格式"] | "ocap";
let type: SaveFileType;

/** 矩形还是自由 */
let isRect = true;
let /**是否在绘制新选区*/ selecting = false;
let rightKey = false;
let rectStartE: px_position | null = null;
let /**是否在更改选区*/ moving = false;

type editor_position = { x: number; y: number };
type px_position = { x: number; y: number } & symbol;

let /** 先前坐标，用于框选的生成和调整 */ oldP = {
        x: Number.NaN,
        y: Number.NaN,
    } as editor_position;
let oFinalRect: rect | null = null;
let oPoly: point[] | null = null;
let theColor: [number, number, number, number] | null = null;
let theTextColor: [string, string] = ["", ""];
type colorFormat = setting["取色器"]["默认格式"];
type colorRGBA = [number, number, number, number];
let undoStack = new xhistory<{ rect: rect; canvas: object }>([], {
    rect: [0, 0, mainCanvas.width, mainCanvas.height] as rect,
    canvas: {},
});
function updateUndoButtons() {
    drawSide操作.撤回.el.classList.toggle(
        "draw-disabled",
        undoStack.index <= 0,
    );
    drawSide操作.重做.el.classList.toggle(
        "draw-disabled",
        undoStack.index >= undoStack.list.length - 1,
    );
}
function watchUndoStack() {
    undoStack.on("change", updateUndoButtons);
    updateUndoButtons();
}
watchUndoStack();
let direction:
    | ""
    | "move"
    | "东"
    | "西"
    | "南"
    | "北"
    | "东南"
    | "西南"
    | "东北"
    | "西北";
const autoPhotoSelectRect = store.get("框选.自动框选.图像识别");
let /**鼠标是否移动过，用于自动框选点击判断 */ moved = false;
let /**鼠标是否按住 */ down = false;
let /**是否选好了选区，若手动选好，自动框选提示关闭 */ rectSelect = false;

let rectInRect: rect[] = [];

const mouseBarW =
    Math.max(
        colorSize * colorISize,
        (String(window.innerWidth).length +
            String(window.innerHeight).length +
            2 +
            1) *
            8,
    ) + 4;
const mouseBarH = 4 + colorSize * colorISize + 32 * 2;

let mouseBarX = 0;
let mouseBarY = 0;

// 工具栏跟随

// 移动画画栏
let drawBarMovingXY: [number, number] | null = null;

let nowType: keyof EditType;
const editType: EditType = {
    select: "rect",
    draw: "free",
    filter: "pixelate",
    shape: "rect",
};
const editTypeRecord = store.get("图像编辑.记忆") as EditType;

editType.select = editTypeRecord.select || editType.select;
editType.draw = editTypeRecord.draw || editType.draw;
editType.filter = editTypeRecord.filter || editType.filter;
editType.shape = editTypeRecord.shape || editType.shape;

let willShowITime: NodeJS.Timeout;

let isShowBars = !store.get("工具栏.稍后出现") as boolean;

let mode: EditType["draw"];

type Shape = EditType["shape"] | "";
let shape: Shape = "";

let drawingShape = false;
const shapes: FabricObject[] = [];
const unnormalShapes = ["polyline", "polygon", "number"];
const strokeShapes = ["line", "polyline", "arrow"];
let drawOP: [number, number] = [0, 0]; // 首次按下的点
let polyOP: point[] = []; // 多边形点
let newFilterO: Point | null = null;
let drawNumberN = 1;
declare module "fabric" {
    // to have the properties recognized on the instance and in the constructor
    interface FabricObject {
        canChangeFill?: boolean;
        形状?: Shape;
    }
    // to have the properties typed in the exported object
    interface SerializedObjectProps {
        canChangeFill?: boolean;
        形状?: Shape;
    }
}

/** 规定当前色盘对应的是填充还是边框 */
let colorM: "fill" | "stroke" = "fill";

let newFilterSelecting = false;

const filtetMap: {
    [key in EditType["filter"]]: {
        value?: {
            value: number;
            max: number;
            min?: number;
            step?: number;
            text?: string;
        };
        // biome-ignore lint/suspicious/noExplicitAny: 适配库
        fun: (v?: number) => filters.BaseFilter<string, any>;
        el?: () => ElType<HTMLElement>;
        levels?: number[];
    };
} = {
    pixelate: {
        value: { value: 16, max: 20, text: "px" },
        fun: (v) => new Filters.Pixelate({ blocksize: v }),
        levels: [8, 16, 32],
    },
    blur: {
        value: { value: 1, max: 5, text: "%", step: 0.1 },
        fun: (v) => new Filters.Blur({ blur: v }),
        levels: [0.5, 1, 2],
    },
    brightness: {
        value: { min: -1, value: 0, max: 1, step: 0.01 },
        fun: (v) => new Filters.Brightness({ brightness: v }),
    },
    contrast: {
        value: { min: -1, value: 0, max: 1, step: 0.01 },
        fun: (v) => new Filters.Contrast({ contrast: v }),
    },
    saturation: {
        value: { min: -1, value: 0, max: 1, step: 0.01 },
        fun: (v) => new Filters.Saturation({ saturation: v }),
    },
    hue: {
        value: { min: -1, value: 0, max: 1, step: 0.01 },
        fun: (v) => new Filters.HueRotation({ rotation: v }),
    },
    noise: {
        value: { value: 0, max: 1000 },
        fun: (v) => new Filters.Noise({ value: v }),
    },
    invert: { fun: () => new Filters.Invert() },
    sepia: { fun: () => new Filters.Sepia() },
    bw: { fun: () => new Filters.BlackWhite() },
    brownie: { fun: () => new Filters.Brownie() },
    vintage: { fun: () => new Filters.Vintage() },
    koda: { fun: () => new Filters.Kodachrome() },
    techni: { fun: () => new Filters.Technicolor() },
    polaroid: { fun: () => new Filters.Polaroid() },
    gray_average: {
        fun: () =>
            new Filters.Grayscale({
                mode: "average",
            }),
    },
    gray_lightness: {
        fun: () =>
            new Filters.Grayscale({
                mode: "lightness",
            }),
    },
    gray_luminosity: {
        fun: () =>
            new Filters.Grayscale({
                mode: "luminosity",
            }),
    },
    gamma: {
        fun: (v) =>
            new Filters.Gamma({
                gamma: v as unknown as [number, number, number],
            }),
        // @ts-ignore
        value: { value: [1, 1, 1] },
        el: gammaEl,
    },
};

let willFilter: EditType["filter"] | "" = "";

// ------

document.body.style.opacity = "0";

let resolveClipReady: () => void = () => {};
const clipReady = new Promise<void>((r) => {
    resolveClipReady = r;
});

renderOn(
    "clip_init",
    async ([_displays, imgBuffer, mainid, act, project, context]) => {
        cancelSelectionInteraction();
        const initSequence = ++captureInitSequence;
        liveTranslationController.cancel();
        liveTranslationPreview.el.textContent = "";
        const initialize = async () => {
            await clipReady;
            await captureWorkspace?.flush();
            if (initSequence !== captureInitSequence) return;
            document.documentElement.style.display = "";
            down = moved = selecting = moving = false;
            direction = "";
            selectionBeforeDrag = null;
            oFinalRect = null;
            drawBarOpen = false;
            setEditType("select", "rect");
            cleanClip();
            captureSourceContext = project?.source ??
                context?.source ?? {
                    kind: imgBuffer ? "import" : "capture",
                    capturedAt: new Date().toISOString(),
                };
            immutableSourceData = undefined;
            captureSelectionMode = context?.selectionMode ?? "region";
            batchRegions = [];
            captureWorkspace?.begin(
                project?.draftId
                    ? {
                          id: project.draftId,
                          revision: project.draftRevision ?? 1,
                      }
                    : undefined,
            );
            await captureWorkspace?.loadPreferences();
            const wx = await screenShots(_displays, imgBuffer); // 只是截屏 也可能是小图片
            if (initSequence !== captureInitSequence) return;
            if (
                captureSelectionMode === "window" &&
                (wx.type !== "normal" || wx.window.length === 0)
            )
                throw new Error(
                    t(
                        "현재 캡처 방식은 창 선택을 지원하지 않습니다. 영역 캡처를 사용해 주세요.",
                    ),
                );
            screenShotCache.clear();
            fabricCanvas.clear();
            allScreens = wx.screen;
            const mainId = mainid;
            const i = getNowScreen(mainId);
            windows = wx.window;
            console.log(allScreens, windows);
            if (!(await setScreen(i))) return;
            if (initSequence !== captureInitSequence) return;
            const nowScreen =
                _displays.find((i) => i.id === mainId) || _displays[0]; // 非截屏，是屏幕
            const xy = { x: 0, y: 0 };
            if (wx.type === "normal") {
                zoomW = i.size.width;
                ratio = i.scaleFactor;
            } else if (wx.type === "command") {
                const x = store.get("自定义屏幕属性");
                const s = x.find((i) => i.id === mainId);
                zoomW = i.size.width;
                if (s) ratio = s.scaleFactor;
                else ratio = nowScreen.scaleFactor;
            } else if (wx.type === "img")
                if (
                    i.size.width < nowScreen.size.width ||
                    i.size.height < nowScreen.size.height
                ) {
                    const x =
                        (nowScreen.size.width * window.devicePixelRatio) / 2 -
                        i.size.width / 2;
                    const y =
                        (nowScreen.size.height * window.devicePixelRatio) / 2 -
                        i.size.height / 2;
                    xy.x = x;
                    xy.y = y;
                    zoomW = i.size.width;
                    ratio = devicePixelRatio;
                }
            if (!zoomW) zoomW = mainCanvas.width;
            setEditorP(1 / ratio, 0, 0);

            document.body.style.opacity = "";

            renderSend("clip_show", [
                context?.requestId,
                wx.type === "normal" ? nowScreenId : mainId,
            ]);
            const screensEl = toolsX.screens.el;
            if (allScreens.length > 1) {
                let minX = 0;
                let maxX = 0;
                let minY = 0;
                let maxY = 0;
                for (const i of allScreens) {
                    const right = i.bounds.x + i.bounds.width;
                    const bottom = i.bounds.y + i.bounds.height;
                    maxX = Math.max(maxX, right);
                    maxY = Math.max(maxY, bottom);
                    minX = Math.min(minX, i.bounds.x);
                    minY = Math.min(minY, i.bounds.y);
                }
                const tWidth = maxX - minX;
                const tHeight = maxY - minY;
                const el = view();
                for (const i of allScreens) {
                    const x = (i.bounds.x - minX) / tWidth;
                    const y = (i.bounds.y - minY) / tHeight;
                    const width = i.bounds.width / tWidth;
                    const height = i.bounds.height / tHeight;
                    const div = view().style({
                        width: `${width * 100}%`,
                        height: `${height * 100}%`,
                        left: `${x * 100}%`,
                        top: `${y * 100}%`,
                    });
                    if (i.id === nowScreenId) {
                        div.el.classList.add("now_screen");
                    }
                    el.add(div);
                    div.on("click", async () => {
                        try {
                            if (!(await setScreen(i))) return;
                            el.query(".now_screen")?.el.classList.remove(
                                "now_screen",
                            );
                            div.class("now_screen");
                        } catch (error) {
                            captureWorkspace?.showError(error);
                        }
                    });
                }
                screensEl.clear().add(el);
            } else {
                screensEl.el.style.display = "none";
            }

            setDefaultAction(act);

            if (project) {
                const r = project.rect;
                if (
                    Array.isArray(r) &&
                    r.length === 4 &&
                    r.every((n) => Number.isFinite(n))
                ) {
                    finalRect = [r[0], r[1], r[2], r[3]];
                    rectSelect = true;
                    finalRectFix();
                }
                if (project.canvas && fabricCanvas)
                    await fabricCanvas.loadFromJSON(project.canvas as string);
            }
            if (initSequence !== captureInitSequence) return;

            drawClipRect();
            setTimeout(() => {
                whBar(finalRect);
            }, 0);
            rightKey = false;
            changeRightBar(false);
            undoStack = new xhistory<{ rect: rect; canvas: object }>([], {
                rect: [...finalRect],
                canvas: fabricCanvas.toJSON(),
            });
            watchUndoStack();
            captureWorkspace?.initialized();
            followBar();
            if (context?.requestId) {
                renderSend("capture_ready", [context.requestId]);
                requestAnimationFrame(() =>
                    requestAnimationFrame(() =>
                        renderSend("capture_shown", [context.requestId]),
                    ),
                );
            }
        };
        captureInitQueue = captureInitQueue
            .catch(() => undefined)
            .then(initialize);
        try {
            await captureInitQueue;
        } catch (error) {
            if (initSequence !== captureInitSequence) return;
            cleanClip();
            captureWorkspace?.showError(error);
            renderSend("clip_capture_failed", [
                context?.requestId,
                error instanceof Error ? error.message : String(error),
            ]);
        }
    },
);

renderOn("clip_stop_long", () => stopLong());

document.onwheel = (e) => {
    if (
        !editor.el.contains(e.target as HTMLElement) &&
        e.target !== document.body
    )
        return;
    if (longRunning) return;

    document.body.classList.add("editor_bg");

    if ((nowType === "draw" || nowType === "shape") && !e.ctrlKey) {
        let v = strokeWidthEl.gv;
        v += e.deltaY / 50;
        v = Math.max(1, v);
        strokeWidthF.set(v);
        return;
    }

    if (e.ctrlKey) {
        const zz = 1 + Math.abs(e.deltaY) / 300;
        const z = e.deltaY > 0 ? zoomW / zz : zoomW * zz;
        zoomW = z;
        const ozoom = editorP.zoom;
        const nzoom = z / mainCanvas.width;
        const dx = nowMouseE.clientX - editorP.x * ozoom;
        const dy = nowMouseE.clientY - editorP.y * ozoom;
        const x = nowMouseE.clientX - dx * (nzoom / ozoom);
        const y = nowMouseE.clientY - dy * (nzoom / ozoom);
        setEditorP(nzoom, x / nzoom, y / nzoom);
    } else {
        let dx = 0;
        let dy = 0;
        if (e.shiftKey && !e.deltaX) {
            dx = -e.deltaY;
        } else {
            dx = -e.deltaX;
            dy = -e.deltaY;
        }
        setEditorP(
            editorP.zoom,
            editorP.x + dx / editorP.zoom,
            editorP.y + dy / editorP.zoom,
        );
    }
};

document.onkeyup = (e) => {
    if (e.key === "0") {
        if (e.ctrlKey) {
            setEditorP(1 / window.devicePixelRatio, 0, 0); // todo 统一缩放标准
            zoomW = mainCanvas.width;
        }
    }
};

const radialTakesWheel = () => {
    const v = store.get("鼠标快捷键.径向菜单");
    const trigger = v?.트리거 ?? "both";
    return Boolean(
        v?.开启 &&
            Array.isArray(v?.动作) &&
            v.动作.length >= 2 &&
            trigger !== "back",
    );
};
document.addEventListener("pointerdown", (e) => {
    if (e.button === 1) {
        if (radialTakesWheel()) return;
        middleB = e;
        middleP.x = editorP.x;
        middleP.y = editorP.y;
        document.body.classList.add("editor_bg");
    }
});
document.addEventListener("pointermove", (e) => {
    if (middleB) {
        const dx = e.clientX - middleB.clientX;
        const dy = e.clientY - middleB.clientY;
        setEditorP(
            editorP.zoom,
            middleP.x + dx / editorP.zoom,
            middleP.y + dy / editorP.zoom,
        );
    }
});
document.addEventListener("pointerup", (_e) => {
    middleB = null;
});

hotkeys.filter = (event) => {
    const tagName = (<HTMLElement>event.target).tagName;
    const v = !(
        (<HTMLElement>event.target).isContentEditable ||
        tagName === "INPUT" ||
        tagName === "SELECT" ||
        tagName === "TEXTAREA"
    );
    return v;
};

toHotkeyScope("normal");
for (const k of tools) {
    let key = (store.get(`工具快捷键.${k}`) as string) ?? "";
    if (["esc", "escape"].includes(key.toLowerCase()))
        hotkeys(key, "normal", toolsX[k].f);
    else if (key.toLowerCase() === "enter") hotkeys(key, "normal", toolsX[k].f);
    else hotkeys(key, "all", toolsX[k].f);
    key = key
        .split("+")
        .map((k) => jsKeyCodeDisplay(ele2jsKeyCode(k)).primary)
        .join("");
    if (k === "copy") {
        key += ` ${t("双击")}`;
    }
    toolsX[k].el.data({ key: key.trim() });
}
for (const [mainKey, k] of typedEntries(drawHotKey)) {
    drawMainEls[mainKey].data({ key: showShortKey(k.键) });
    hotkeys(k.键, () => {
        setEditType(mainKey, editType[mainKey]);
    });
    for (const [j, v] of typedEntries(k.副)) {
        try {
            // @ts-expect-error
            drawSideEls[mainKey][j].data({
                key: showShortKey(v),
            });
        } catch (error) {}
        hotkeys(v, () => {
            setEditType(mainKey, j);
        });
    }
}

function showShortKey(k: string) {
    return k
        .split("+")
        .map((k) => jsKeyCodeDisplay(ele2jsKeyCode(k)).primary)
        .join("");
}

// alt显示快捷键
let altT: number;
document.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !longRunning) {
        altT = window.setTimeout(() => {
            document.documentElement.style.setProperty(
                "--hotkey-show",
                "block",
            );
        }, 400);
    }
});
document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") {
        clearTimeout(altT);
        document.documentElement.style.setProperty("--hotkey-show", "none");
    }
});

for (const m of hotkeyTipX) {
    hotkeyTipEl.add(p(t(m.name)));
    for (const k of m.hotkey) {
        const x = view().add(txt(t(k.name)));
        for (let s of k.keys) {
            s = s
                .split("+")
                .map((k) => jsKeyCodeDisplay(ele2jsKeyCode(k)).primary)
                .join("+");
            x.add(txt(s));
        }
        hotkeyTipEl.add(x);
    }
}

setDefaultAction(autoDo);

// OCR
const ocr引擎 = toolsX.ocr.el;
ocr引擎.sv(store.get("OCR.类型"));
ocr引擎.on("change", () => {
    store.set("OCR.类型", ocr引擎.gv);
    toolsX.ocr.f();
});

// 以图搜图
const 识图引擎 = toolsX.search.el;
// @ts-ignore
识图引擎.sv(store.get("以图搜图.引擎"));
识图引擎.on("change", () => {
    store.set("以图搜图.引擎", 识图引擎.gv);
    toolsX.search.f();
});

trackLocation();

const finishLongB = longTip.els.finish.el;

const lr = longTip.els.rect;

trackPoint(pack(toolBar), {
    start: (e) => {
        const target = e.target as HTMLElement;
        if (
            e.ctrlKey ||
            target === toolBar ||
            target.classList.contains("capture-divider") ||
            target.classList.contains("capture-grip")
        ) {
            toolBar.style.transition = "none";
            return {
                x: toolBar.offsetLeft,
                y: toolBar.offsetTop,
            };
        }
        return null;
    },
    ing: (p) => {
        const w = toolBar.offsetWidth;
        const h = toolBar.offsetHeight;
        const margin = 12;
        const snap = 14;
        let x = Math.max(0, Math.min(p.x, window.innerWidth - w));
        let y = Math.max(0, Math.min(p.y, window.innerHeight - h));
        if (Math.abs(x - margin) <= snap) x = margin;
        else if (Math.abs(innerWidth - w - margin - x) <= snap)
            x = innerWidth - w - margin;
        if (Math.abs(y - margin) <= snap) y = margin;
        else if (Math.abs(innerHeight - h - margin - y) <= snap)
            y = innerHeight - h - margin;
        toolBar.style.left = `${x}px`;
        toolBar.style.top = `${y}px`;
        trackLocation();
    },
    end: () => {
        toolBar.style.transition = "";
        toolbarPinnedPos = {
            left: toolBar.offsetLeft,
            top: toolBar.offsetTop,
        };
        store.set("工具栏.快捷位置", toolbarPinnedPos);
        toolBar.toggleAttribute("data-pinned", true);
    },
});

setTitle(t("截屏"));

// 键盘控制光标
document.body.onkeydown = (e) => {
    const tagName = (<HTMLElement>e.target).tagName;
    if (
        (<HTMLElement>e.target).isContentEditable ||
        tagName === "INPUT" ||
        tagName === "SELECT" ||
        tagName === "TEXTAREA"
    )
        return;
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        captureHelp.el.hidden = !captureHelp.el.hidden;
        dismissStartHint();
        return;
    }
    if (e.key === "Escape" && !captureHelp.el.hidden) {
        captureHelp.el.hidden = true;
        return;
    }
    if (longRunning) return;
    if (hotkeys.getScope() === "c_bar") return;
    const o: Record<string, "up" | "right" | "down" | "left"> = {
        ArrowUp: "up",
        ArrowRight: "right",
        ArrowDown: "down",
        ArrowLeft: "left",
        w: "up",
        d: "right",
        s: "down",
        a: "left",
    };
    const controlKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const isWasd = controlKey.length === 1 && controlKey in o;
    if (isWasd && (e.ctrlKey || e.metaKey || e.altKey)) return;
    if (captureSelectionMode === "window" && controlKey in o) {
        e.preventDefault();
        captureWorkspace?.showStatus(
            "창 캡처에서는 시스템 창의 원래 경계를 사용합니다.",
        );
        return;
    }
    if (isWasd && (nowType === "draw" || nowType === "shape" || !direction))
        return;
    if (nowType === "draw" || nowType === "shape") {
        if (!(controlKey in o)) return;
        let v = strokeWidthEl.gv;
        v += o[controlKey] === "up" || o[controlKey] === "right" ? 1 : -1;
        v = Math.max(1, v);
        strokeWidthF.set(v);
        return;
    }
    let v = 1;
    if (e.ctrlKey) v = v * 5;
    if (e.shiftKey) v = v * 10;
    if (controlKey in o) {
        e.preventDefault();
        if (isWasd) e.stopPropagation();
        const dx =
            (o[controlKey] === "right" ? v : 0) -
            (o[controlKey] === "left" ? v : 0);
        const dy =
            (o[controlKey] === "down" ? v : 0) -
            (o[controlKey] === "up" ? v : 0);
        if (direction) {
            const op = nowMouseE ?? { offsetX: 0, offsetY: 0 };
            if (isRect) {
                moveRect(
                    finalRect,
                    { x: op.offsetX, y: op.offsetY },
                    { x: op.offsetX + dx, y: op.offsetY + dy },
                );
            } else {
                movePoly(
                    freeSelect,
                    { x: op.offsetX, y: op.offsetY },
                    { x: op.offsetX + dx, y: op.offsetY + dy },
                );
            }
            drawClip();
            if (nowMouseE) ckx(e2srcPoint(nowMouseE));
        } else if (rectSelect) {
            if (isRect) {
                finalRect[0] += Math.min(
                    Math.max(dx, -finalRect[0]),
                    mainCanvas.width - finalRect[0] - finalRect[2],
                );
                finalRect[1] += Math.min(
                    Math.max(dy, -finalRect[1]),
                    mainCanvas.height - finalRect[1] - finalRect[3],
                );
                finalRectFix();
            } else if (freeSelect.length) {
                const xs = freeSelect.map((i) => i.x);
                const ys = freeSelect.map((i) => i.y);
                const cdx = Math.min(
                    Math.max(dx, -Math.min(...xs)),
                    mainCanvas.width - Math.max(...xs),
                );
                const cdy = Math.min(
                    Math.max(dy, -Math.min(...ys)),
                    mainCanvas.height - Math.max(...ys),
                );
                freeSelect = freeSelect.map((i) => ({
                    x: Math.round(i.x + cdx),
                    y: Math.round(i.y + cdy),
                }));
            }
            drawClip();
            followBar();
            if (nowMouseE) ckx(e2srcPoint(nowMouseE));
        } else {
            let x = editorP.x;
            let y = editorP.y;
            const d = v / editorP.zoom;
            switch (o[controlKey]) {
                case "up":
                    y = editorP.y + d;
                    break;
                case "down":
                    y = editorP.y - d;
                    break;
                case "right":
                    x = editorP.x - d;
                    break;
                case "left":
                    x = editorP.x + d;
                    break;
            }
            setEditorP(editorP.zoom, x, y);
            document.body.classList.add("editor_bg");
            if (nowMouseE) mouseBar(finalRect, e2srcPoint(nowMouseE));
        }
    }
};

clipEl.onmousedown = (e) => {
    let inRect = false;
    if (isRect) {
        inRect = isInClipRect({ x: e.offsetX, y: e.offsetY });
    } else {
        inRect = isPointInPolygon({ x: e.offsetX, y: e.offsetY });
    }
    if (e.button === 0) {
        if (e.shiftKey && finalRect[2] > 1 && finalRect[3] > 1 && rectSelect) {
            if (batchRegions.length >= 11) {
                captureWorkspace?.showStatus(
                    t("한 번에 12개 영역까지 보관할 수 있습니다."),
                );
                return;
            }
            batchRegions.push([...finalRect]);
            captureWorkspace?.nextRegion();
            inRect = false;
        }
        clipStart(e, inRect);
    }
    if (e.button !== 0) return;
    toolBar.style.pointerEvents =
        drawBar.style.pointerEvents =
        whEl.el.style.pointerEvents =
            "none";

    down = true;
};

document.onmouseup = (e) => {
    if (e.button === 0) {
        if (selecting) {
            clipEnd(e);
            rememberLastRect();
            // 抬起鼠标后工具栏跟随
            followBar({ x: e.clientX, y: e.clientY });
            // 框选后默认操作
            isShowBars = true;
            showBars(isShowBars);
            void completeSelectionAction();
        }
        if (moving) {
            moving = false;
            oFinalRect = null;
            if (e.button === 0) followBar({ x: e.clientX, y: e.clientY });
            hisPush();
            rememberLastRect();
            scheduleLiveTranslation();
        }
    }
    const hasSelection = finalRect[2] > 0 && finalRect[3] > 0;
    toolBar.style.pointerEvents = whEl.el.style.pointerEvents = hasSelection
        ? "auto"
        : "none";
    drawBar.style.pointerEvents = drawBarOpen && hasSelection ? "auto" : "none";

    down = false;
    moved = false;
    selectionBeforeDrag = null;
};

hotkeys("s", () => {
    dismissStartHint();
    if (captureSelectionMode === "window") {
        rectSelect = false;
        finalRect = [0, 0, 0, 0];
        drawClipRect();
        captureWorkspace?.showStatus(
            "창 위로 포인터를 이동한 다음 클릭하세요.",
        );
        return;
    }
    if (autoPhotoSelectRect) {
        console.log("edge");
        edge();
        rectSelect = false;
        finalRect = [0, 0, mainCanvas.width, mainCanvas.height];
        drawClipRect();
    }
    rectSelect = false;
    finalRect = [0, 0, mainCanvas.width, mainCanvas.height];
    drawClipRect();
    void completeSelectionAction();
});

const whHotKeyMap = {
    左上x: whX0,
    左上y: whY0,
    右下x: whX1,
    右下y: whY1,
    宽: whW,
    高: whH,
};

const whHotkey = store.get("大小栏快捷键");
for (const [i] of typedEntries(whHotkey)) {
    if (whHotkey[i])
        hotkeys(whHotkey[i], { keyup: true, keydown: false }, () => {
            whHotKeyMap[i].el.focus();
        });
}

for (const xel of whL) {
    const el = xel.el;
    const kd = (e: KeyboardEvent) => {
        if (e.key === "ArrowRight" && el.value.length === el.selectionEnd) {
            e.preventDefault();
            const next = whL[whL.indexOf(xel) + 1]?.el;
            if (next) {
                next.selectionStart = next.selectionEnd = 0;
                next.focus();
            }
        }
        if (e.key === "ArrowLeft" && 0 === el.selectionStart) {
            e.preventDefault();
            const last = whL[whL.indexOf(xel) - 1]?.el;
            if (last) {
                last.selectionStart = last.selectionEnd = last.value.length;
                last.focus();
            }
        }
        let v = 1;
        if (e.ctrlKey) v = v * 5;
        if (e.shiftKey) v = v * 10;
        if (e.key === "ArrowUp" && !Number.isNaN(Number(el.value))) {
            e.preventDefault();
            el.value = String(Number(el.value) + 1 * v);
            changeWH(xel);
        }
        if (e.key === "ArrowDown" && !Number.isNaN(Number(el.value))) {
            e.preventDefault();
            el.value = String(Number(el.value) - 1 * v);
            changeWH(xel);
        }
        if (e.key === "Escape") {
            el.blur();
        }
    };

    xel.on("input", checkWhBarWidth)
        .on("change", () => changeWH(xel))
        .on("keydown", kd);
}

// 快捷键全屏选择
hotkeys("ctrl+a, command+a", () => {
    if (captureSelectionMode === "window") {
        captureWorkspace?.showStatus(
            "창 캡처에서는 시스템 창을 선택해 주세요.",
        );
        return;
    }
    finalRect = [0, 0, mainCanvas.width, mainCanvas.height];
    hisPush();
    setClipCursor("crosshair");
    direction = "";
    drawClipRect();
});

// 生成取色器
if (!取色器显示) mouseBarColor.style({ display: "none" });

const pointColorCanvasBg = document.createElement("canvas");
pointColorCanvasBg.style.opacity = "0.5";
pointColorCanvasBg.width = pointColorCanvasBg.height = colorSize;
mouseBarColor.add(pointColorCanvasBg);
const pointColorCanvasBgCtx = pointColorCanvasBg.getContext("2d")!;
const pointColorCanvas = document.createElement("canvas");
pointColorCanvas.width = pointColorCanvas.height = colorSize;
mouseBarColor.add(pointColorCanvas);
const pointColorCanvasCtx = pointColorCanvas.getContext("2d", {
    willReadFrequently: true,
})!;
const pointCenter = document.createElement("div");
mouseBarColor.add(pointCenter);
pointCenter.style.left = "calc((var(--color-size) - var(--color-i-size)) / 2)";
pointCenter.style.top = "calc((var(--color-size) - var(--color-i-size)) / 2)";

if (!store.get("鼠标跟随栏.显示")) mouseBarEl.style({ display: "none" });
// 鼠标跟随栏
const mainCanvasContext = mainCanvas.getContext("2d")!;

// 复制坐标
mouseBarXy.on("click", () => {
    copy(mouseBarXy);
});

changeRightBar(false);

hotkeys(store.get("其他快捷键.复制颜色"), () => {
    copy(getColorFormatEl());
});

clipEl.ondblclick = () => {
    if (store.get("鼠标快捷键.双击") === "复制") toolsX.copy.f();
    else toolsX.save.f();
};

document.onmousemove = (e) => {
    nowMouseE = e;
    // 一帧内的多次移动只渲染最后一次
    requestAnimationFrame(() => {
        const ev = nowMouseE;
        renderClip(ev);
        if (!rightKey) {
            // 鼠标跟随栏
            mouseBar(finalRect, e2srcPoint(ev));

            const d = 16;
            const x = Math.round(ev.clientX + d);
            const y = Math.round(ev.clientY + d);
            const w = mouseBarW;
            const h = mouseBarH;
            const sw = window.innerWidth;
            const sh = window.innerHeight;

            let _x = x;
            let _y = y;
            if (x > sw - w - d && y > sh - h - d) {
                _x = x - w - d - d;
                _y = y - h - d - d;
            } else if (x > sw - w - d) {
                _x = sw - w - d;
            } else if (y > sh - h - d) {
                _y = sh - h - d;
            }

            mouseBarX = _x;
            mouseBarY = _y;

            mouseBarEl.style({
                transform: `translate(${_x}px, ${_y}px)`,
            });

            const isDrawBar = drawBar.contains(ev.target as HTMLElement);
            const isToolBar = toolBar.contains(ev.target as HTMLElement);
            mouseBarEl.el.classList.toggle(
                "mouse_bar_hide",
                isDrawBar || isToolBar || radialOpen || (!selecting && !moving),
            );

            // 画板栏移动
            if (drawBarMovingXY) {
                drawBar.style.left = `${ev.clientX - drawBarMovingXY[0]}px`;
                drawBar.style.top = `${ev.clientY - drawBarMovingXY[1]}px`;
            }
        }
    });
};

drawBar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
        drawBarMovingXY = [
            e.clientX - drawBar.offsetLeft,
            e.clientY - drawBar.offsetTop,
        ];
        drawBar.style.transition = "0s";
    }
});
drawBar.addEventListener("mouseup", (e) => {
    if (e.button !== 0) {
        drawBarMovingXY = null;
        drawBar.style.transition = "";
    }
});

drawSideSelect.rect.on("click", () => {
    setEditType("select", "rect");
});
drawSideSelect.free.on("click", () => {
    setEditType("select", "free");
});
drawSideSelect.draw.on("click", () => {
    setEditType("select", "draw");
});

hotkeys("ctrl+z", () => {
    undo(true);
});
hotkeys("ctrl+y", () => {
    undo(false);
});
hotkeys("ctrl+shift+z", () => {
    undo(false);
});

drawSide操作.撤回.on("click", () => {
    if (undoStack.index <= 0) return;
    undo(true);
});
drawSide操作.重做.on("click", () => {
    if (undoStack.index >= undoStack.list.length - 1) return;
    undo(false);
});
drawSide操作.复制.on("click", () => {
    fabricCopy();
});
drawSide操作.删除.on("click", () => {
    fabricDelete();
});

const Filters = filters;

const fabricCanvas = new Canvas("draw_photo");

hisPush();

const fillColor = store.get("图像编辑.默认属性.填充颜色");
const strokeColor = store.get("图像编辑.默认属性.边框颜色");
const strokeWidth = store.get("图像编辑.默认属性.边框宽度");
const freeColor = store.get("图像编辑.默认属性.画笔颜色");
const freeWidth = store.get("图像编辑.默认属性.画笔粗细");

const shapePro: setting["图像编辑"]["形状属性"] = {};

// 编辑栏
const drawMainBar = drawBarMainEl.el;
const drawSideBar = drawBarSideEl.el;
showSideBar(false);

for (const [index, e] of drawBarMainElList.entries()) {
    const Type: (keyof EditType)[] = ["select", "draw", "shape", "filter"];
    e.on("mouseenter", () => {
        // 用于防误触，防经过时误切换
        willShowITime = setTimeout(() => {
            showSideBarItem(index);
        }, 100);
    });
    e.on("pointerleave", () => {
        clearTimeout(willShowITime);
        setTimeout(() => {
            if (!isInDrawBar()) {
                showSideBar(false);
            }
        }, 100);
    });
    e.on("click", () => {
        setEditType(Type[index], editType[Type[index]]);
    });
}

for (const el of drawBarSideElChildren) {
    el.el.on("pointerleave", () => {
        setTimeout(() => {
            if (!isInDrawBar()) showSideBar(false);
        }, 100);
    });
}

showBars(isShowBars);

hotkeys(store.get("其他快捷键.隐藏或显示栏"), () => {
    isShowBars = !isShowBars;
    showBars(isShowBars);
});

// 笔
drawSideFree.pencil.on("click", () => setEditType("draw", "free"));
// 橡皮
drawSideFree.eraser.on("click", () => setEditType("draw", "eraser"));
// 刷
drawSideFree.spray.on("click", () => setEditType("draw", "spray"));
// 荧光笔
drawSideFree.highlighter.on("click", () => setEditType("draw", "highlighter"));

// 阴影
const shadowBlurEl = rangeBar(0, 20, 1, "px").on("input", freeShadow);
drawShadowBlur.add(shadowBlurEl);

// 几何
for (const [k, el] of Object.entries(drawSideShapes)) {
    el.on("click", () => {
        setEditType("shape", k as EditType["shape"]);
    });
}
// 层叠位置
drawSidePosition.front.on("click", () => {
    const activeObject = fabricCanvas.getActiveObject();
    if (activeObject) fabricCanvas.bringObjectToFront(activeObject);
});
drawSidePosition.forwards.on("click", () => {
    const activeObject = fabricCanvas.getActiveObject();
    if (activeObject) fabricCanvas.bringObjectForward(activeObject);
});
drawSidePosition.backwards.on("click", () => {
    const activeObject = fabricCanvas.getActiveObject();
    if (activeObject) fabricCanvas.sendObjectBackwards(activeObject);
});
drawSidePosition.back.on("click", () => {
    const activeObject = fabricCanvas.getActiveObject();
    if (activeObject) fabricCanvas.sendObjectToBack(activeObject);
});

// 删除快捷键
hotkeys("delete", fabricDelete);

fabricCanvas.on("mouse:down", (options) => {
    // 非常规状态下点击
    if (shape !== "" && !options.target) {
        drawingShape = true;
        fabricCanvas.selection = false;
        const x = options.viewportPoint.x;
        const y = options.viewportPoint.y;
        // 折线与多边形要多次点击，在poly_o_p存储点
        if (!unnormalShapes.includes(shape)) {
            drawOP = [x, y];
            draw(shape, "start", drawOP[0], drawOP[1], x, y);
        } else {
            // 定义最后一个点,双击,点重复,结束
            const polyOPL = polyOP.at(-1);
            if (!(x === polyOPL?.x && y === polyOPL?.y)) {
                polyOP.push({ x: x, y: y });
                if (shape === "number") {
                    drawNumber();
                } else {
                    drawPoly(shape);
                }
            } else {
                hisPush();
                polyOP = [];
                drawNumberN = 1;
            }
        }
    }

    if (newFilterSelecting) {
        newFilterO = fabricCanvas.getViewportPoint(options.e);
    }
});
fabricCanvas.on("mouse:move", (options) => {
    if (drawingShape) {
        if (!unnormalShapes.includes(shape)) {
            if (shape !== "")
                draw(
                    shape,
                    "move",
                    drawOP[0],
                    drawOP[1],
                    options.viewportPoint.x,
                    options.viewportPoint.y,
                );
        }
    }
});
fabricCanvas.on("mouse:up", (options) => {
    if (!unnormalShapes.includes(shape)) {
        drawingShape = false;
        if (shape !== "") {
            const obj = shapes.at(-1);
            if (obj) fabricCanvas.setActiveObject(obj);
            hisPush();
        }
    }

    getFObjectV();
    getFilters();

    if (newFilterSelecting && newFilterO) {
        newFilterSelect(newFilterO, fabricCanvas.getScenePoint(options.e));
        getFilters();
        hisPush();

        if (willFilter) {
            const i = filtetMap[willFilter] as (typeof filtetMap)["pixelate"];
            const index = Object.keys(filtetMap).indexOf(willFilter);
            const filter = i.fun(i.value?.value ?? 1);
            applyFilter(index, filter);
            getFilters();
        }
    }

    if (fabricCanvas.isDrawingMode) {
        hisPush();
    }
});

class mask extends Rect {
    static type = "mask";
    declare rect: { x: number; y: number; w: number; h: number };
    constructor(
        options?: Partial<
            RectProps & { rect: { x: number; y: number; w: number; h: number } }
        >,
    ) {
        super();
        this.setOptions(options);
    }
    render(ctx: CanvasRenderingContext2D): void {
        ctx.save();

        ctx.fillStyle = this.fill?.toString() || "";
        ctx.fillRect(0, 0, this.width, this.height);

        const r = this.rect;
        ctx.clearRect(r.x, r.y, r.w, r.h);

        ctx.restore();
    }
}

classRegistry.setClass(mask);
classRegistry.setSVGClass(mask);

class xnumber extends Circle {
    static type = "number";
    declare fontSize: number;
    declare text: string;
    constructor(
        options?: Partial<CircleProps & { fontSize: number; text: string }>,
    ) {
        super();
        this.setOptions(options);
    }
    render(ctx: CanvasRenderingContext2D): void {
        ctx.save();
        ctx.translate(this.left, this.top);
        this._render(ctx);

        const x = 0;
        const y = 5;

        // 绘制数字
        ctx.fillStyle = this.stroke?.toString() || "#000";
        ctx.font = `${this.fontSize}px ${字体.等宽字体 || "Arial"}`;
        ctx.textAlign = "center";
        ctx.fillText(String(this.text), x, y);
        ctx.restore();
    }
}

classRegistry.setClass(xnumber);
classRegistry.setSVGClass(xnumber);

const arrowConfig = store.get("图像编辑.arrow");

class arrow extends Line {
    static type = "arrow";
    render(ctx: CanvasRenderingContext2D): void {
        ctx.save();

        const { x1, x2, y1, y2 } = this;

        const angle = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
        const w = arrowConfig.w;
        const h = arrowConfig.h;

        const [x3, y3] = rotate(-w / 2, h, angle);
        const [x4, y4] = rotate(w / 2, h, angle);

        const x0 = (x2 - x1) / 2;
        const y0 = (y2 - y1) / 2;

        ctx.translate(x1 + x0, y1 + y0);

        this._render(ctx);

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + x3, y0 + y3);
        if (arrowConfig.type === "stroke") ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + x4, y0 + y4);
        ctx.closePath();

        ctx.fillStyle = this.stroke?.toString() || "";
        ctx.lineWidth = this.strokeWidth || 1;
        ctx.strokeStyle = this.stroke?.toString() || "";
        ctx.fill();
        ctx.stroke();

        ctx.restore();
    }
}

// 颜色选择

setDrawMode(colorM);
drawColorSwitchP.on("click", () => {
    setDrawMode(colorM === "fill" ? "stroke" : "fill");
});

ableChangeColor();

colorBar();

const strokeWidthEl = rangeBar(0, 25, 1, "px").on("input", () => {
    setFObjectV(null, null, strokeWidthEl.gv);
});

drawStrokeWidth.add(strokeWidthEl);

const strokeWidthF = {
    set: (v: number) => {
        strokeWidthEl.sv(v);
        setFObjectV(null, null, Math.floor(v));
    },
};

// 滤镜

for (const [id] of typedEntries(filtetMap)) {
    drawSideFiltersAll[id].on("click", () => {
        setEditType("filter", id);
    });
}

// 伽马

function gammaEl() {
    const g = new Array(3)
        .fill(0)
        .map(() =>
            rangeBar(0.01, 2.2, 0.01).on("input", () =>
                p.el.dispatchEvent(new Event("input")),
            ),
        );
    const p = view()
        .add(g)
        .bindGet(() => g.map((el) => el.gv))
        .bindSet((v: [number, number, number]) => {
            g[0].sv(v[0]);
            g[1].sv(v[1]);
            g[2].sv(v[2]);
        });
    return p;
}

hotkeys("esc", "drawing", () => {
    setEditType("select", "draw");
});

hotkeys("Ctrl+v", () => {
    fabricCopy();
});

setEditType("select", editType.select);

captureWorkspace = createCaptureWorkspace({
    snapshot: (includeSource) => {
        if (
            !mainCanvas.width ||
            !mainCanvas.height ||
            finalRect[2] < 1 ||
            finalRect[3] < 1 ||
            selecting
        )
            return null;
        if (mainCanvas.width * mainCanvas.height > 32_000_000)
            throw new Error(t("임시 편집 원본이 너무 큽니다."));
        if (includeSource)
            immutableSourceData ??= mainCanvas.toDataURL("image/png");
        return {
            sourceDataURL: includeSource ? immutableSourceData : undefined,
            previewDataURL: getClipPhoto().toDataURL("image/png"),
            canvas: fabricCanvas.toJSON(),
            rect: {
                x: finalRect[0],
                y: finalRect[1],
                width: finalRect[2],
                height: finalRect[3],
            },
            source: captureSourceContext,
        };
    },
    screenRect: (r) => ({
        x: (r.x + editorP.x) * editorP.zoom,
        y: (r.y + editorP.y) * editorP.zoom,
        width: r.width * editorP.zoom,
        height: r.height * editorP.zoom,
    }),
    copiedText: writeText,
    preferencesChanged: (value) => {
        capturePreferences = value;
        rebuildCaptureTools();
        markPrimaryTool();
        followBar();
    },
    settleElement: () => selectionHandles.el,
    redact: (lines: OcrTextLine[], r) => {
        for (const line of lines) {
            const pad = Math.max(2, line.box.height * 0.15);
            const mask = new Rect({
                left: r.x + line.box.x - pad,
                top: r.y + line.box.y - pad,
                width: line.box.width + pad * 2,
                height: line.box.height + pad * 2,
                fill: "#111114",
                originX: "left",
                originY: "top",
                canChangeFill: true,
                形状: "rect",
            });
            shapes.push(mask);
            fabricCanvas.add(mask);
        }
        fabricCanvas.renderAll();
        hisPush();
    },
});
Object.assign(window, {
    captureDraftBridge: {
        flush: () => captureWorkspace?.flush(),
        stage: () => captureWorkspace?.stage(),
        info: () => ({
            id: captureWorkspace?.queue.current?.id,
            revision: captureWorkspace?.queue.current?.revision,
            dirty: captureWorkspace?.queue.current?.dirty,
            savedIds: captureWorkspace?.queue.savedIds,
        }),
    },
});
fabricCanvas.on("object:modified", () => captureWorkspace?.changed());
fabricCanvas.on("object:added", () => captureWorkspace?.changed());
fabricCanvas.on("object:removed", () => captureWorkspace?.changed());
fabricCanvas.on("text:changed", () => captureWorkspace?.changed());

function radialGestureTarget(x: number, y: number): CaptureTool | null {
    let nearest: HTMLButtonElement | null = null;
    let distance = 48;
    for (const control of radialMenu.el.querySelectorAll<HTMLButtonElement>(
        ".radial_item",
    )) {
        control.classList.remove("is-gesture-target");
        if (control.disabled) continue;
        const d = Math.hypot(
            x - Number.parseFloat(control.style.left),
            y - Number.parseFloat(control.style.top),
        );
        if (d < distance) {
            nearest = control;
            distance = d;
        }
    }
    nearest?.classList.add("is-gesture-target");
    return (nearest?.dataset.captureAction as CaptureTool) ?? null;
}

document.addEventListener(
    "pointerdown",
    (event) => {
        if (
            event.button !== 2 ||
            longInited ||
            (event.target as HTMLElement).closest(
                "input,textarea,#quick_toolbar,#radial_menu,#draw_bar,#capture_inline_shelf,#capture_palette,#capture_redact_review,#center_bar",
            )
        )
            return;
        event.preventDefault();
        nowMouseE = event;
        suppressContextUntil = 0;
        captureWorkspace?.dismiss();
        rightKey = false;
        changeRightBar(false);
        gestureOrigin = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
            target: null,
            pointerId: event.pointerId,
        };
        openRadial(event.clientX, event.clientY);
    },
    true,
);
document.addEventListener(
    "pointermove",
    (event) => {
        if (!gestureOrigin || gestureOrigin.pointerId !== event.pointerId)
            return;
        if (!(event.buttons & 2)) {
            closeRadial();
            return;
        }
        gestureOrigin.moved ||=
            Math.hypot(
                event.clientX - gestureOrigin.x,
                event.clientY - gestureOrigin.y,
            ) > 20;
        gestureOrigin.target = radialGestureTarget(
            event.clientX,
            event.clientY,
        );
    },
    true,
);
document.addEventListener(
    "pointerup",
    (event) => {
        if (
            event.button !== 2 ||
            !gestureOrigin ||
            gestureOrigin.pointerId !== event.pointerId
        )
            return;
        const gesture = gestureOrigin;
        gesture.moved ||=
            Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >
            20;
        gesture.target = radialGestureTarget(event.clientX, event.clientY);
        gestureOrigin = null;
        suppressContextUntil = Date.now() + 350;
        if (gesture.moved) {
            if (gesture.target) {
                const target = gesture.target;
                if (target !== "more") closeRadial();
                runCaptureTool(target, radialOrigin);
            } else closeRadial();
        }
    },
    true,
);

document.addEventListener(
    "pointercancel",
    (event) => {
        if (gestureOrigin?.pointerId === event.pointerId) closeRadial();
        cancelSelectionInteraction();
    },
    true,
);
window.addEventListener("blur", () => {
    closeRadial();
    cancelSelectionInteraction();
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        closeRadial();
        cancelSelectionInteraction();
    }
});

resolveClipReady();
