import type { SavedComparisonSession } from "../../../lib/openCaptureTypes";
import {
    REFERENCE_EXPORT_PIXELS,
    REFERENCE_MAX_ITEMS,
    REFERENCE_MAX_NOTES,
    type ReferenceCompareMode,
    type ReferenceComparisonSession,
    type ReferencePixels,
    type ReferencePointNote,
    type ReferenceZoomMode,
    computeAlignment,
    computePixelDiff,
    fromSavedComparisonSession,
    normalizeReferenceNotes,
    toSavedComparisonSession,
} from "../../../lib/referenceComparison";
import "./referenceComparison.css";
import { lt } from "../lib/labText";

export type ReferenceComparisonItem = {
    id: string;
    name: string;
    thumbnail?: string;
    width?: number;
    height?: number;
};

export type ReferenceComparisonOptions = {
    loadItemData(id: string): Promise<string>;
    listSessions?: () => Promise<SavedComparisonSession[]>;
    saveSession?: (
        session: SavedComparisonSession,
    ) => Promise<SavedComparisonSession>;
    removeSession?: (id: string) => Promise<void>;
    saveExport?: (dataURL: string, label: string) => Promise<void>;
    copyExport?: (dataURL: string) => Promise<void>;
    showToast(message: string, error?: boolean): void;
    translate?: (source: string) => string;
    openDialog?: (dialog: HTMLDialogElement) => void;
    closeDialog?: (dialog: HTMLDialogElement) => void;
};

export type ReferenceComparisonController = {
    dialog: HTMLDialogElement;
    open(
        items: ReferenceComparisonItem[],
        session?: ReferenceComparisonSession,
    ): void;
    close(): void;
    destroy(): void;
};

type LoadedReference = {
    item: ReferenceComparisonItem;
    image: HTMLImageElement;
    pixels: ReferencePixels;
};

const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

const numberValue = (input: HTMLInputElement, fallback: number) => {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
};

const uid = () =>
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const loadImage = (source: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => resolve(image);
        image.onerror = () =>
            reject(new Error("Reference image could not be decoded"));
        image.src = source;
    });

function readPixels(image: HTMLImageElement): ReferencePixels {
    const factor = Math.min(
        1,
        1024 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * factor));
    const height = Math.max(1, Math.round(image.naturalHeight * factor));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, width, height);
    return {
        width,
        height,
        data: context.getImageData(0, 0, width, height).data,
    };
}

export function createReferenceComparison(
    options: ReferenceComparisonOptions,
): ReferenceComparisonController {
    const t = options.translate ?? ((source: string) => source);
    const dialog = element("dialog", "rc-dialog compare-dialog");
    const shell = element("div", "rc-shell");
    const header = element("header", "rc-header");
    const title = element("h2", "rc-title", t(lt("레퍼런스 비교")));
    const status = element("span", "rc-status", t(lt("이미지를 선택하세요")));
    const closeButton = element("button", "rc-icon-button", "×");
    closeButton.type = "button";
    closeButton.title = t(lt("닫기"));
    header.append(title, status, closeButton);

    const toolbar = element("div", "rc-toolbar");
    const selectA = element("select", "rc-select compare-pair-select");
    const selectB = element("select", "rc-select compare-pair-select");
    selectA.setAttribute("aria-label", "A");
    selectB.setAttribute("aria-label", "B");
    const modeGroup = element("div", "rc-segmented");
    const modeLabels: Array<[ReferenceCompareMode, string]> = [
        ["side", t(lt("나란히"))],
        ["opacity", t(lt("겹치기"))],
        ["wipe", t(lt("슬라이더"))],
        ["diff", t(lt("차이"))],
    ];
    const modeButtons = new Map<ReferenceCompareMode, HTMLButtonElement>();
    for (const [mode, label] of modeLabels) {
        const button = element(
            "button",
            "rc-segment compare-mode-button",
            label,
        );
        button.type = "button";
        button.dataset.mode = mode;
        modeButtons.set(mode, button);
        modeGroup.append(button);
    }
    const zoomModeGroup = element("div", "rc-segmented rc-zoom-mode");
    const fitButton = element("button", "rc-segment", t(lt("맞춤")));
    const actualButton = element("button", "rc-segment", "1:1");
    fitButton.type = actualButton.type = "button";
    zoomModeGroup.append(fitButton, actualButton);
    const zoomOut = element("button", "rc-icon-button", "−");
    const zoomLabel = element("span", "rc-zoom-label", "100%");
    const zoomIn = element("button", "rc-icon-button", "+");
    zoomOut.type = zoomIn.type = "button";
    toolbar.append(
        selectA,
        selectB,
        modeGroup,
        zoomModeGroup,
        zoomOut,
        zoomLabel,
        zoomIn,
    );

    const main = element("div", "rc-main");
    const stageWrap = element("div", "rc-stage-wrap");
    const canvas = element("canvas", "rc-canvas");
    canvas.tabIndex = 0;
    const stageEmpty = element(
        "div",
        "rc-empty",
        t(lt("비교 이미지를 불러오는 중…")),
    );
    stageWrap.append(canvas, stageEmpty);
    const inspector = element("details", "rc-inspector");
    const inspectorSummary = element(
        "summary",
        "rc-inspector-summary",
        t(lt("비교 옵션")),
    );
    const inspectorBody = element("div", "rc-inspector-body");

    const alignSection = element("section", "rc-panel");
    const alignTitle = element("h3", "rc-panel-title", t(lt("정렬")));
    const alignButton = element("button", "rc-primary", t(lt("자동 정렬")));
    alignButton.type = "button";
    const alignFeedback = element(
        "small",
        "rc-help",
        t(lt("B를 A에 맞춥니다")),
    );
    const fields = element("div", "rc-field-grid");
    const offsetX = element("input", "rc-number");
    const offsetY = element("input", "rc-number");
    const scaleB = element("input", "rc-number");
    for (const input of [offsetX, offsetY, scaleB]) input.type = "number";
    offsetX.step = offsetY.step = "1";
    scaleB.step = "0.01";
    const field = (labelText: string, input: HTMLInputElement) => {
        const label = element("label", "rc-field");
        label.append(element("span", undefined, labelText), input);
        return label;
    };
    fields.append(
        field("X", offsetX),
        field("Y", offsetY),
        field(t(lt("배율")), scaleB),
    );
    alignSection.append(alignTitle, alignButton, alignFeedback, fields);

    const viewSection = element("section", "rc-panel");
    const opacity = element("input");
    const wipe = element("input");
    const threshold = element("input");
    for (const input of [opacity, wipe, threshold]) {
        input.type = "range";
        input.min = "0";
        input.max = "100";
    }
    opacity.value = "50";
    wipe.value = "50";
    threshold.value = "12";
    const range = (text: string, input: HTMLInputElement) => {
        const label = element("label", "rc-range");
        label.append(element("span", undefined, text), input);
        return label;
    };
    viewSection.append(
        element("h3", "rc-panel-title", t(lt("보기"))),
        range(t(lt("불투명도")), opacity),
        range(t(lt("경계")), wipe),
        range(t(lt("차이 민감도")), threshold),
    );

    const notesSection = element("section", "rc-panel rc-notes-panel");
    const notesHeader = element("div", "rc-panel-row");
    notesHeader.append(
        element("h3", "rc-panel-title", t(lt("메모"))),
        element("small", "rc-help", t(lt("이미지를 클릭해 추가"))),
    );
    const noteToggle = element("button", "rc-secondary", t(lt("메모 찍기")));
    noteToggle.type = "button";
    const noteList = element("div", "rc-note-list");
    notesSection.append(notesHeader, noteToggle, noteList);

    const sessionsSection = element("section", "rc-panel");
    const sessionName = element("input", "rc-text-input");
    sessionName.placeholder = t(lt("세션 이름"));
    const saveSession = element("button", "rc-secondary", t(lt("세션 저장")));
    saveSession.type = "button";
    const removeSession = element("button", "rc-secondary", t(lt("세션 삭제")));
    removeSession.type = "button";
    if (!options.removeSession) removeSession.hidden = true;
    if (!options.saveSession) saveSession.hidden = true;
    const sessionSelect = element("select", "rc-select rc-session-select");
    sessionsSection.append(
        element("h3", "rc-panel-title", t(lt("저장된 비교"))),
        sessionName,
        saveSession,
        removeSession,
        sessionSelect,
    );

    inspectorBody.append(
        alignSection,
        viewSection,
        notesSection,
        sessionsSection,
    );
    inspector.append(inspectorSummary, inspectorBody);
    main.append(stageWrap, inspector);

    const footer = element("footer", "rc-footer");
    const hint = element(
        "small",
        "rc-help",
        t(lt("드래그 이동 · 휠 확대 · 방향키로 B 미세 이동")),
    );
    const copyButton = element(
        "button",
        "rc-secondary",
        t(lt("비교 이미지 복사")),
    );
    const exportButton = element("button", "rc-primary", t(lt("PNG 저장")));
    copyButton.type = exportButton.type = "button";
    if (!options.copyExport) copyButton.hidden = true;
    if (!options.saveExport) exportButton.hidden = true;
    footer.append(hint, copyButton, exportButton);
    shell.append(header, toolbar, main, footer);
    dialog.append(shell);
    document.body.append(dialog);

    let pool: ReferenceComparisonItem[] = [];
    let activeA: LoadedReference | null = null;
    let activeB: LoadedReference | null = null;
    let mode: ReferenceCompareMode = "side";
    let zoomMode: ReferenceZoomMode = "fit";
    let zoom = 1;
    let pan = { x: 0, y: 0 };
    let bOffset = { x: 0, y: 0 };
    let bScale = 1;
    let notes: ReferencePointNote[] = [];
    let placingNote = false;
    let loadGeneration = 0;
    let differenceCache: { key: string; canvas: HTMLCanvasElement } | null =
        null;
    let dragging: { x: number; y: number; panX: number; panY: number } | null =
        null;
    let sessions: ReferenceComparisonSession[] = [];
    let activeSessionId = "";
    let lastAMap: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null = null;

    const setStatus = (
        text: string,
        kind: "normal" | "error" | "busy" = "normal",
    ) => {
        status.textContent = text;
        status.dataset.kind = kind;
        dialog.setAttribute("aria-busy", String(kind === "busy"));
    };

    const syncControls = () => {
        offsetX.value = String(Math.round(bOffset.x * 100) / 100);
        offsetY.value = String(Math.round(bOffset.y * 100) / 100);
        scaleB.value = String(Math.round(bScale * 10_000) / 10_000);
        zoomLabel.textContent =
            zoomMode === "actual"
                ? `${Math.round(zoom * 100)}% · 1:1`
                : `${Math.round(zoom * 100)}%`;
        for (const [key, button] of modeButtons)
            button.classList.toggle("active", key === mode);
        fitButton.classList.toggle("active", zoomMode === "fit");
        actualButton.classList.toggle("active", zoomMode === "actual");
        noteToggle.classList.toggle("active", placingNote);
        opacity.closest("label")?.toggleAttribute("hidden", mode !== "opacity");
        wipe.closest("label")?.toggleAttribute("hidden", mode !== "wipe");
        threshold.closest("label")?.toggleAttribute("hidden", mode !== "diff");
    };

    const drawNotes = (
        context: CanvasRenderingContext2D,
        map: { x: number; y: number; width: number; height: number },
    ) => {
        context.save();
        context.font = "600 13px system-ui";
        context.textAlign = "center";
        context.textBaseline = "middle";
        notes.forEach((note, index) => {
            const x = map.x + note.x * map.width;
            const y = map.y + note.y * map.height;
            context.beginPath();
            context.arc(x, y, 11, 0, Math.PI * 2);
            context.fillStyle = "#f5f5f5";
            context.fill();
            context.fillStyle = "#0a0a0b";
            context.fillText(String(index + 1), x, y + 0.5);
        });
        context.restore();
    };

    const canvasMetrics = () => {
        if (!activeA || !activeB) return null;
        const cssWidth = Math.max(1, stageWrap.clientWidth);
        const cssHeight = Math.max(1, stageWrap.clientHeight);
        const device = Math.min(2, devicePixelRatio || 1);
        canvas.width = Math.round(cssWidth * device);
        canvas.height = Math.round(cssHeight * device);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        return { cssWidth, cssHeight, device };
    };

    const render = () => {
        syncControls();
        const metrics = canvasMetrics();
        const context = canvas.getContext("2d");
        if (!context || !metrics || !activeA || !activeB) return;
        const { cssWidth, cssHeight, device } = metrics;
        context.setTransform(device, 0, 0, device, 0, 0);
        context.clearRect(0, 0, cssWidth, cssHeight);
        context.fillStyle = "#0a0a0b";
        context.fillRect(0, 0, cssWidth, cssHeight);
        const padding = 24;
        const paneWidth =
            mode === "side"
                ? (cssWidth - padding * 3) / 2
                : cssWidth - padding * 2;
        const paneHeight = cssHeight - padding * 2;
        const fitA = Math.min(
            paneWidth / activeA.image.naturalWidth,
            paneHeight / activeA.image.naturalHeight,
        );
        const viewScale = (zoomMode === "fit" ? fitA : 1) * zoom;
        const width = activeA.image.naturalWidth * viewScale;
        const height = activeA.image.naturalHeight * viewScale;
        const baseX =
            mode === "side"
                ? padding + (paneWidth - width) / 2
                : (cssWidth - width) / 2;
        const baseY = padding + (paneHeight - height) / 2;
        const ax = baseX + pan.x;
        const ay = baseY + pan.y;
        const map = { x: ax, y: ay, width, height };
        lastAMap = map;
        context.imageSmoothingEnabled = true;
        if (mode === "side") {
            context.drawImage(activeA.image, ax, ay, width, height);
            const fitB = Math.min(
                paneWidth / activeB.image.naturalWidth,
                paneHeight / activeB.image.naturalHeight,
            );
            const bViewScale = (zoomMode === "fit" ? fitB : 1) * zoom;
            const bWidth = activeB.image.naturalWidth * bViewScale;
            const bHeight = activeB.image.naturalHeight * bViewScale;
            const bx =
                padding * 2 + paneWidth + (paneWidth - bWidth) / 2 + pan.x;
            const by = padding + (paneHeight - bHeight) / 2 + pan.y;
            context.drawImage(activeB.image, bx, by, bWidth, bHeight);
            drawNotes(context, map);
            context.fillStyle = "#d4d4d8";
            context.font = "600 12px system-ui";
            context.fillText("A", padding, 17);
            context.fillText("B", padding * 2 + paneWidth, 17);
            return;
        }
        context.drawImage(activeA.image, ax, ay, width, height);
        const bx = ax + bOffset.x * viewScale;
        const by = ay + bOffset.y * viewScale;
        const bw = activeB.image.naturalWidth * viewScale * bScale;
        const bh = activeB.image.naturalHeight * viewScale * bScale;
        if (mode === "opacity") {
            context.globalAlpha = numberValue(opacity, 50) / 100;
            context.drawImage(activeB.image, bx, by, bw, bh);
            context.globalAlpha = 1;
        } else if (mode === "wipe") {
            context.save();
            const edge = cssWidth * (numberValue(wipe, 50) / 100);
            context.beginPath();
            context.rect(0, 0, edge, cssHeight);
            context.clip();
            context.drawImage(activeB.image, bx, by, bw, bh);
            context.restore();
            context.fillStyle = "#f5f5f5";
            context.fillRect(edge - 1, 0, 2, cssHeight);
        } else if (mode === "diff") {
            const key = [
                loadGeneration,
                bOffset.x,
                bOffset.y,
                bScale,
                threshold.value,
            ].join(":");
            if (differenceCache?.key !== key) {
                const diff = computePixelDiff(activeA.pixels, activeB.pixels, {
                    offsetX:
                        (bOffset.x * activeA.pixels.width) /
                        activeA.image.naturalWidth,
                    offsetY:
                        (bOffset.y * activeA.pixels.height) /
                        activeA.image.naturalHeight,
                    scale:
                        (bScale *
                            (activeB.image.naturalWidth /
                                activeB.pixels.width)) /
                        (activeA.image.naturalWidth / activeA.pixels.width),
                    threshold: numberValue(threshold, 12) * 2.55,
                });
                const diffCanvas = document.createElement("canvas");
                diffCanvas.width = diff.width;
                diffCanvas.height = diff.height;
                diffCanvas
                    .getContext("2d")
                    ?.putImageData(
                        new ImageData(diff.data, diff.width, diff.height),
                        0,
                        0,
                    );
                differenceCache = { key, canvas: diffCanvas };
            }
            if (differenceCache)
                context.drawImage(
                    differenceCache.canvas,
                    ax,
                    ay,
                    width,
                    height,
                );
        }
        drawNotes(context, map);
    };

    const renderNotes = () => {
        noteList.replaceChildren();
        notes.forEach((note, index) => {
            const row = element("div", "rc-note-row");
            const badge = element("span", "rc-note-badge", String(index + 1));
            const input = element("input", "rc-note-input");
            input.value = note.text;
            input.maxLength = 500;
            input.addEventListener("change", () => {
                note.text = input.value.trim().slice(0, 500);
            });
            const remove = element("button", "rc-note-remove", "×");
            remove.type = "button";
            remove.addEventListener("click", () => {
                notes = notes.filter((entry) => entry.id !== note.id);
                renderNotes();
                render();
            });
            row.append(badge, input, remove);
            noteList.append(row);
        });
    };

    const setPair = async (aId: string, bId: string) => {
        const generation = ++loadGeneration;
        differenceCache = null;
        activeA = activeB = null;
        stageEmpty.hidden = false;
        canvas.hidden = true;
        setStatus(t(lt("이미지 불러오는 중…")), "busy");
        try {
            const aItem = pool.find((item) => item.id === aId);
            const bItem = pool.find((item) => item.id === bId);
            if (!aItem || !bItem || aItem.id === bItem.id)
                throw new Error("Invalid pair");
            const [aSource, bSource] = await Promise.all([
                options.loadItemData(aItem.id),
                options.loadItemData(bItem.id),
            ]);
            const [aImage, bImage] = await Promise.all([
                loadImage(aSource),
                loadImage(bSource),
            ]);
            if (generation !== loadGeneration) return;
            activeA = {
                item: aItem,
                image: aImage,
                pixels: readPixels(aImage),
            };
            activeB = {
                item: bItem,
                image: bImage,
                pixels: readPixels(bImage),
            };
            stageEmpty.hidden = true;
            canvas.hidden = false;
            setStatus(`${aItem.name} · ${bItem.name}`);
            render();
        } catch {
            if (generation !== loadGeneration) return;
            activeA = activeB = null;
            stageEmpty.textContent = t(lt("이미지를 불러오지 못했습니다"));
            setStatus(t(lt("불러오기 실패")), "error");
        }
    };

    const currentSession = (): ReferenceComparisonSession => ({
        id: activeSessionId || uid(),
        name: sessionName.value.trim() || t(lt("이름 없는 비교")),
        aId: selectA.value,
        bId: selectB.value,
        mode,
        zoomMode,
        zoom,
        pan: { ...pan },
        offsetB: { ...bOffset },
        scaleB: bScale,
        opacity: numberValue(opacity, 50),
        wipe: numberValue(wipe, 50),
        threshold: numberValue(threshold, 12),
        notes: normalizeReferenceNotes(notes),
        updatedAt: Date.now(),
    });

    const applySession = (session: ReferenceComparisonSession) => {
        for (const id of [session.aId, session.bId]) {
            if (!pool.some((item) => item.id === id))
                pool.unshift({
                    id,
                    name: `${session.name} · ${id.slice(0, 8)}`,
                });
        }
        pool = pool.slice(0, REFERENCE_MAX_ITEMS);
        selectA.replaceChildren();
        selectB.replaceChildren();
        for (const item of pool) {
            selectA.append(new Option(`A · ${item.name}`, item.id));
            selectB.append(new Option(`B · ${item.name}`, item.id));
        }
        activeSessionId = session.id;
        sessionName.value = session.name;
        selectA.value = session.aId;
        selectB.value = session.bId;
        mode = session.mode;
        zoomMode = session.zoomMode;
        zoom = clamp(session.zoom, 0.1, 8);
        pan = { ...session.pan };
        bOffset = { ...session.offsetB };
        bScale = clamp(session.scaleB, 0.5, 2);
        opacity.value = String(clamp(session.opacity, 0, 100));
        wipe.value = String(clamp(session.wipe, 0, 100));
        threshold.value = String(clamp(session.threshold, 0, 100));
        notes = normalizeReferenceNotes(session.notes);
        renderNotes();
        void setPair(session.aId, session.bId);
    };

    const refreshSessions = async () => {
        const saved = options.listSessions
            ? await options.listSessions().catch(() => [])
            : [];
        sessions = saved.flatMap((session) => {
            const parsed = fromSavedComparisonSession(session);
            return parsed ? [parsed] : [];
        });
        sessionSelect.replaceChildren(new Option(t(lt("세션 열기")), ""));
        for (const session of sessions.slice(0, 50)) {
            sessionSelect.append(new Option(session.name, session.id));
        }
    };

    const exportCanvas = () => {
        if (!activeA || !activeB) throw new Error("No active references");
        const side = mode === "side";
        let width = side
            ? activeA.image.naturalWidth + activeB.image.naturalWidth
            : activeA.image.naturalWidth;
        let height = Math.max(
            activeA.image.naturalHeight,
            activeB.image.naturalHeight,
        );
        const factor = Math.min(
            1,
            Math.sqrt(REFERENCE_EXPORT_PIXELS / (width * height)),
        );
        width = Math.max(1, Math.round(width * factor));
        height = Math.max(1, Math.round(height * factor));
        const output = document.createElement("canvas");
        output.width = width;
        output.height = height;
        const context = output.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.fillStyle = "#0a0a0b";
        context.fillRect(0, 0, width, height);
        const aWidth = side
            ? Math.round(activeA.image.naturalWidth * factor)
            : width;
        const aHeight = Math.round(activeA.image.naturalHeight * factor);
        context.drawImage(activeA.image, 0, 0, aWidth, aHeight);
        if (side) {
            const bWidth = width - aWidth;
            context.drawImage(
                activeB.image,
                aWidth,
                0,
                bWidth,
                Math.round(activeB.image.naturalHeight * factor),
            );
        } else {
            const bx = bOffset.x * factor;
            const by = bOffset.y * factor;
            const bw = activeB.image.naturalWidth * factor * bScale;
            const bh = activeB.image.naturalHeight * factor * bScale;
            if (mode === "opacity") {
                context.globalAlpha = numberValue(opacity, 50) / 100;
                context.drawImage(activeB.image, bx, by, bw, bh);
                context.globalAlpha = 1;
            } else if (mode === "wipe") {
                context.save();
                context.beginPath();
                context.rect(
                    0,
                    0,
                    width * (numberValue(wipe, 50) / 100),
                    height,
                );
                context.clip();
                context.drawImage(activeB.image, bx, by, bw, bh);
                context.restore();
            } else if (mode === "diff") {
                const diff = computePixelDiff(activeA.pixels, activeB.pixels, {
                    offsetX:
                        (bOffset.x * activeA.pixels.width) /
                        activeA.image.naturalWidth,
                    offsetY:
                        (bOffset.y * activeA.pixels.height) /
                        activeA.image.naturalHeight,
                    scale: bScale,
                    threshold: numberValue(threshold, 12) * 2.55,
                });
                const diffCanvas = document.createElement("canvas");
                diffCanvas.width = diff.width;
                diffCanvas.height = diff.height;
                diffCanvas
                    .getContext("2d")
                    ?.putImageData(
                        new ImageData(diff.data, diff.width, diff.height),
                        0,
                        0,
                    );
                context.drawImage(diffCanvas, 0, 0, width, height);
            }
        }
        drawNotes(context, { x: 0, y: 0, width: aWidth, height: aHeight });
        notes.forEach((note, index) => {
            if (!note.text) return;
            const x = note.x * aWidth;
            const y = note.y * aHeight;
            const text = `${index + 1}. ${note.text}`;
            context.font = `${Math.max(12, Math.round(14 * factor))}px system-ui`;
            const boxWidth = Math.min(
                width - x,
                context.measureText(text).width + 16,
            );
            context.fillStyle = "rgba(10,10,11,.82)";
            context.fillRect(x + 14, y - 14, boxWidth, 28);
            context.fillStyle = "#fff";
            context.textAlign = "left";
            context.textBaseline = "middle";
            context.fillText(text, x + 22, y);
        });
        return output;
    };

    const closeDialog = () => {
        if (options.closeDialog) options.closeDialog(dialog);
        else if (dialog.open) dialog.close();
    };
    closeButton.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDialog();
    });
    dialog.addEventListener("close", () => {
        loadGeneration++;
        activeA = activeB = null;
    });
    selectA.addEventListener(
        "change",
        () => void setPair(selectA.value, selectB.value),
    );
    selectB.addEventListener(
        "change",
        () => void setPair(selectA.value, selectB.value),
    );
    for (const [key, button] of modeButtons) {
        button.addEventListener("click", () => {
            mode = key;
            render();
        });
    }
    fitButton.addEventListener("click", () => {
        zoomMode = "fit";
        zoom = 1;
        pan = { x: 0, y: 0 };
        render();
    });
    actualButton.addEventListener("click", () => {
        zoomMode = "actual";
        zoom = 1;
        pan = { x: 0, y: 0 };
        render();
    });
    zoomOut.addEventListener("click", () => {
        zoom = clamp(zoom / 1.2, 0.1, 8);
        render();
    });
    zoomIn.addEventListener("click", () => {
        zoom = clamp(zoom * 1.2, 0.1, 8);
        render();
    });
    for (const input of [opacity, wipe, threshold])
        input.addEventListener("input", render);
    for (const input of [offsetX, offsetY, scaleB]) {
        input.addEventListener("change", () => {
            bOffset.x = numberValue(offsetX, bOffset.x);
            bOffset.y = numberValue(offsetY, bOffset.y);
            bScale = clamp(numberValue(scaleB, bScale), 0.5, 2);
            render();
        });
    }
    alignButton.addEventListener("click", async () => {
        if (!activeA || !activeB) return;
        const generation = loadGeneration;
        alignButton.disabled = true;
        alignFeedback.textContent = t(lt("픽셀을 분석하는 중…"));
        await new Promise(requestAnimationFrame);
        if (generation !== loadGeneration || !activeA || !activeB) {
            alignButton.disabled = false;
            return;
        }
        const result = computeAlignment(activeA.pixels, activeB.pixels);
        if (generation !== loadGeneration) {
            alignButton.disabled = false;
            return;
        }
        alignButton.disabled = false;
        if (!result.ok) {
            alignFeedback.textContent = t(lt("공통 영역을 찾지 못했습니다"));
            alignFeedback.dataset.kind = "error";
            return;
        }
        bOffset = {
            x:
                result.offsetX *
                (activeA.image.naturalWidth / activeA.pixels.width),
            y:
                result.offsetY *
                (activeA.image.naturalHeight / activeA.pixels.height),
        };
        bScale =
            (result.scale *
                (activeA.image.naturalWidth / activeA.pixels.width)) /
            (activeB.image.naturalWidth / activeB.pixels.width);
        alignFeedback.textContent = lt(
            `${t("정렬됨")} · ${Math.round(result.score * 100)}%`,
            `Aligned · ${Math.round(result.score * 100)}%`,
        );
        alignFeedback.dataset.kind = "normal";
        render();
    });
    noteToggle.addEventListener("click", () => {
        placingNote = !placingNote;
        syncControls();
        canvas.focus();
    });
    canvas.addEventListener("pointerdown", (event) => {
        if (placingNote && activeA) {
            if (notes.length >= REFERENCE_MAX_NOTES) {
                options.showToast(
                    t(lt("메모는 최대 50개까지 추가할 수 있습니다")),
                    true,
                );
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const map = lastAMap;
            if (!map) return;
            const localX = event.clientX - rect.left;
            const localY = event.clientY - rect.top;
            if (
                localX < map.x ||
                localY < map.y ||
                localX > map.x + map.width ||
                localY > map.y + map.height
            ) {
                options.showToast(t(lt("A 이미지 안을 클릭해 주세요")), true);
                return;
            }
            const x = clamp((localX - map.x) / map.width, 0, 1);
            const y = clamp((localY - map.y) / map.height, 0, 1);
            notes.push({ id: uid(), x, y, text: t(lt("메모")) });
            renderNotes();
            render();
            return;
        }
        dragging = {
            x: event.clientX,
            y: event.clientY,
            panX: pan.x,
            panY: pan.y,
        };
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        pan.x = dragging.panX + event.clientX - dragging.x;
        pan.y = dragging.panY + event.clientY - dragging.y;
        render();
    });
    canvas.addEventListener("pointerup", () => {
        dragging = null;
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            zoom = clamp(zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.1, 8);
            render();
        },
        { passive: false },
    );
    canvas.addEventListener("keydown", (event) => {
        if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                event.key,
            )
        )
            return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") bOffset.x -= step;
        if (event.key === "ArrowRight") bOffset.x += step;
        if (event.key === "ArrowUp") bOffset.y -= step;
        if (event.key === "ArrowDown") bOffset.y += step;
        render();
    });
    saveSession.addEventListener("click", async () => {
        if (!options.saveSession || !activeA || !activeB) return;
        const session = currentSession();
        try {
            await options.saveSession(toSavedComparisonSession(session));
            activeSessionId = session.id;
            await refreshSessions();
            sessionSelect.value = session.id;
            options.showToast(t(lt("비교 세션을 저장했습니다")));
        } catch {
            options.showToast(t(lt("비교 세션을 저장하지 못했습니다")), true);
        }
    });
    sessionSelect.addEventListener("change", () => {
        const session = sessions.find(
            (entry) => entry.id === sessionSelect.value,
        );
        if (session) applySession(session);
    });
    removeSession.addEventListener("click", async () => {
        if (!options.removeSession || !sessionSelect.value) return;
        try {
            await options.removeSession(sessionSelect.value);
            if (activeSessionId === sessionSelect.value) activeSessionId = "";
            await refreshSessions();
            options.showToast(t(lt("비교 세션을 삭제했습니다")));
        } catch {
            options.showToast(t(lt("비교 세션을 삭제하지 못했습니다")), true);
        }
    });
    copyButton.addEventListener("click", async () => {
        if (!options.copyExport) return;
        try {
            await options.copyExport(exportCanvas().toDataURL("image/png"));
            options.showToast(t(lt("비교 이미지를 복사했습니다")));
        } catch {
            options.showToast(t(lt("비교 이미지를 복사하지 못했습니다")), true);
        }
    });
    exportButton.addEventListener("click", async () => {
        if (!options.saveExport) return;
        try {
            await options.saveExport(
                exportCanvas().toDataURL("image/png"),
                "Compare",
            );
            options.showToast(t(lt("비교 이미지를 저장했습니다")));
        } catch {
            options.showToast(t(lt("비교 이미지를 저장하지 못했습니다")), true);
        }
    });
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(stageWrap);

    return {
        dialog,
        open(items, session) {
            pool = items.slice(0, REFERENCE_MAX_ITEMS);
            if (pool.length < 2) {
                options.showToast(
                    t(lt("비교할 이미지를 두 장 이상 선택해 주세요")),
                    true,
                );
                return;
            }
            selectA.replaceChildren();
            selectB.replaceChildren();
            pool.forEach((item, index) => {
                selectA.append(new Option(`A · ${item.name}`, item.id));
                selectB.append(new Option(`B · ${item.name}`, item.id));
                if (index === 0) selectA.value = item.id;
                if (index === 1) selectB.value = item.id;
            });
            activeSessionId = "";
            sessionName.value = "";
            notes = [];
            bOffset = { x: 0, y: 0 };
            bScale = 1;
            pan = { x: 0, y: 0 };
            mode = "side";
            zoomMode = "fit";
            zoom = 1;
            renderNotes();
            if (!dialog.open) {
                if (options.openDialog) options.openDialog(dialog);
                else dialog.showModal();
            }
            void refreshSessions();
            if (session) applySession(session);
            else void setPair(pool[0].id, pool[1].id);
        },
        close() {
            closeDialog();
        },
        destroy() {
            loadGeneration++;
            resizeObserver.disconnect();
            dialog.remove();
        },
    };
}
