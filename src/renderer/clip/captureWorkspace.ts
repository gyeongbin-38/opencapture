import { button, ele, input, txt, view } from "dkh-ui";
import { CaptureDraftQueue } from "../../../lib/captureDraftQueue";
import type { DraftSnapshot } from "../../../lib/captureDraftQueue";
import { DEFAULT_CAPTURE_EXPERIENCE } from "../../../lib/captureExperience";
import type {
    CaptureDraft,
    CaptureExperiencePreferences,
    CaptureRect,
    OcrTextLine,
    StageCaptureResult,
} from "../../../lib/openCaptureTypes";
import { filterSensitiveLines } from "../../../lib/redact";
import { t } from "../../../lib/translate/translate";
import { createCaptureFeedback } from "../lib/captureFeedback";

type ElectronModule = typeof import("electron");
const { ipcRenderer } = require("electron") as ElectronModule;

export function createCaptureWorkspace(options: {
    snapshot(includeSource: boolean): DraftSnapshot | null;
    screenRect(rect: CaptureRect): CaptureRect;
    copiedText(text: string): Promise<void>;
    preferencesChanged(value: CaptureExperiencePreferences): void;
    redact(lines: OcrTextLine[], rect: CaptureRect): void;
    settleElement(): HTMLElement;
}) {
    let preferences = structuredClone(DEFAULT_CAPTURE_EXPERIENCE);
    const feedback = createCaptureFeedback(() => preferences.feedback);
    const status = view("x")
        .class("capture-workspace-status")
        .attr({ role: "status", ariaLive: "polite" })
        .addInto();
    const statusText = txt("").addInto(status);
    const retry = button(t("재시도"))
        .addInto(status)
        .on("click", () => {
            void queue.retry().catch(showError);
        });
    retry.el.hidden = true;
    status.el.hidden = true;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    const strip = view("x")
        .attr({ id: "capture_inline_shelf" })
        .class("capture-inline-shelf")
        .addInto();
    strip.el.hidden = true;
    const thumbnails = new Map<
        string,
        { result: StageCaptureResult; data: string }
    >();
    const textLayer = view().attr({ id: "capture_text_layer" }).addInto();
    const palette = view("x")
        .attr({ id: "capture_palette" })
        .class("capture-palette")
        .addInto();
    palette.el.hidden = true;
    const review = ele("dialog")
        .attr({ id: "capture_redact_review" })
        .class("capture-review")
        .addInto();
    const reviewTitle = txt(t("가릴 항목 확인")).addInto(review);
    const candidates = view().class("capture-review-list").addInto(review);
    const reviewActions = view("x")
        .class("capture-review-actions")
        .addInto(review);
    button(t("취소"))
        .addInto(reviewActions)
        .on("click", () => review.el.close());
    const apply = button(t("선택 가리기")).addInto(reviewActions);
    let candidateLines: OcrTextLine[] = [];
    let candidateRect: CaptureRect | null = null;
    let candidateDraft: { id: string; revision: number; epoch: number } | null =
        null;

    function showStatus(message: string, error = false) {
        if (statusTimer) clearTimeout(statusTimer);
        statusText.el.textContent = message;
        status.el.hidden = false;
        retry.el.hidden = !error;
        status.el.classList.toggle("has-error", error);
        if (!error)
            statusTimer = setTimeout(() => {
                status.el.hidden = true;
            }, 1700);
    }
    function showError(error: unknown) {
        showStatus(
            error instanceof Error ? error.message : String(error),
            true,
        );
    }
    const queue = new CaptureDraftQueue({
        snapshot: options.snapshot,
        stage: (value) => ipcRenderer.invoke("oc:draft:stage", value),
        committed: (result, snapshot) => {
            const isNew = !thumbnails.has(result.id);
            void addThumbnail(result, snapshot.previewDataURL)
                .then(() => {
                    if (isNew) feedback.commit(strip.el);
                })
                .catch(showError);
            showStatus(t("임시 저장됨"));
        },
        failed: showError,
    });

    async function addThumbnail(result: StageCaptureResult, data: string) {
        const image = new Image();
        image.src = data;
        try {
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = 112;
            canvas.height = 76;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            const scale = Math.min(
                112 / image.naturalWidth,
                76 / image.naturalHeight,
            );
            const width = image.naturalWidth * scale;
            const height = image.naturalHeight * scale;
            ctx.drawImage(
                image,
                (112 - width) / 2,
                (76 - height) / 2,
                width,
                height,
            );
            const existing = thumbnails.get(result.id);
            if (existing && existing.result.revision > result.revision) return;
            thumbnails.delete(result.id);
            thumbnails.set(result.id, { result, data: canvas.toDataURL() });
            while (thumbnails.size > 8) {
                const oldest = thumbnails.keys().next().value;
                if (oldest) thumbnails.delete(oldest);
            }
            renderStrip();
        } finally {
            image.src = "";
        }
    }
    const shelfActionIcons: Record<string, string> = {
        copy: '<rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
        pin: '<path d="m7 2 6 0-1 5 3 3v2H5v-2l3-3-1-5Zm3 10v6"/>',
        trash: '<path d="M3 5h14M7 5V2h6v3M5 5l1 13h8l1-13M8 8v7m4-7v7"/>',
    };
    function shelfActionButton(name: string, label: string, act: () => void) {
        const icon = view()
            .class("capture-shelf-action-icon")
            .attr({ ariaHidden: "true" });
        icon.el.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shelfActionIcons[name]}</svg>`;
        return button(icon)
            .class("capture-shelf-action")
            .attr({ type: "button", title: label })
            .on("click", (event) => {
                event.stopPropagation();
                act();
            });
    }
    function renderStrip() {
        strip.clear();
        strip.add(
            txt(`${t("임시")} ${thumbnails.size}`).class("capture-shelf-count"),
        );
        if (thumbnails.size === 1) {
            strip.add(
                view("x")
                    .class("capture-shelf-hint")
                    .add([
                        ele("kbd").attr({ textContent: t("Shift+드래그") }),
                        ele("span").attr({ textContent: t("영역 추가") }),
                    ]),
            );
        }
        for (const [id, entry] of thumbnails) {
            const thumbnail = button(
                ele("img").attr({
                    src: entry.data,
                    alt: entry.result.item.name,
                }),
            )
                .class("capture-shelf-thumb")
                .attr({ type: "button", title: t("주석·편집") });
            thumbnail.on("click", () => {
                void queue
                    .flush()
                    .then(() => ipcRenderer.invoke("oc:clip:open-draft", id))
                    .catch(showError);
            });
            const actions = view("x")
                .class("capture-shelf-actions")
                .add([
                    shelfActionButton("copy", t("복사"), () =>
                        ipcRenderer
                            .invoke("oc:shelf:action", "copy", id)
                            .then(() => showStatus(t("이미지를 복사했습니다.")))
                            .catch(showError),
                    ),
                    shelfActionButton("pin", t("고정"), () =>
                        ipcRenderer
                            .invoke("oc:shelf:action", "pin", id)
                            .then(() => showStatus(t("화면에 고정됨")))
                            .catch(showError),
                    ),
                    shelfActionButton("trash", t("휴지통으로 이동"), () =>
                        ipcRenderer
                            .invoke("oc:items:trash", [id])
                            .then(() => {
                                thumbnails.delete(id);
                                renderStrip();
                                showStatus(t("휴지통으로 이동됨"));
                            })
                            .catch(showError),
                    ),
                ]);
            strip.add(
                view().class("capture-shelf-card").add([thumbnail, actions]),
            );
        }
        strip.el.hidden = !thumbnails.size;
    }

    async function loadPreferences() {
        try {
            preferences = await ipcRenderer.invoke("oc:preferences:get");
            feedback.sync();
            options.preferencesChanged(preferences);
        } catch (error) {
            showError(error);
        }
        return preferences;
    }
    function begin(draft?: Pick<CaptureDraft, "id" | "revision">) {
        dismiss();
        status.el.hidden = true;
        queue.begin(draft);
    }
    async function stage(audible = false) {
        showStatus(t("임시 저장 중…"));
        const result = await queue.save(true);
        if (result && audible) feedback.commit(undefined, true);
        return result;
    }
    function nextRegion() {
        const saved = queue.save(true);
        void saved.catch(showError);
        queue.begin();
        queue.initialized();
    }
    async function compare() {
        const result = await stage();
        if (!result) return;
        const ids = [...thumbnails.keys()].filter((id) => id !== result.id);
        if (!ids.length) {
            showStatus(t("비교할 캡처를 하나 더 보관해 주세요."));
            return;
        }
        await ipcRenderer.invoke("oc:compare:open", [ids.at(-1), result.id]);
    }
    async function promote() {
        const result = await stage();
        if (!result) return;
        await ipcRenderer.invoke("oc:items:promote", [result.id]);
        showStatus(t("라이브러리에 저장됨"));
    }
    async function trash() {
        const result = await stage();
        if (!result) return;
        await ipcRenderer.invoke("oc:items:trash", [result.id]);
        thumbnails.delete(result.id);
        renderStrip();
        showStatus(t("휴지통으로 이동됨"));
    }
    async function recognized() {
        const record = queue.current;
        const epoch = record?.editEpoch;
        const saved = await stage();
        if (
            !saved ||
            !record ||
            queue.current !== record ||
            record.editEpoch !== epoch ||
            record.dirty ||
            record.pending
        )
            return null;
        showStatus(t("텍스트 인식 중…"));
        const result = await ipcRenderer.invoke("oc:ocr:recognize", saved.id);
        if (
            queue.current?.id !== saved.id ||
            queue.current.revision !== saved.revision ||
            queue.current.editEpoch !== epoch ||
            queue.current.dirty ||
            queue.current.pending
        )
            return null;
        if (result.error) throw new Error(result.error);
        if (!result.lines.length) {
            showStatus(t("인식된 텍스트가 없습니다."));
            return null;
        }
        return { saved, result, epoch: record.editEpoch };
    }
    async function showText() {
        const recognizedResult = await recognized();
        if (!recognizedResult) return;
        const rect = options.snapshot(false)?.rect;
        if (!rect) return;
        textLayer.clear();
        for (const line of recognizedResult.result.lines as OcrTextLine[]) {
            const point = options.screenRect({
                x: rect.x + line.box.x,
                y: rect.y + line.box.y,
                width: line.box.width,
                height: line.box.height,
            });
            const lineButton = button()
                .class("capture-text-box")
                .attr({
                    type: "button",
                    ariaLabel: `${t("텍스트 복사")} ${line.text}`,
                })
                .style({
                    left: `${point.x}px`,
                    top: `${point.y}px`,
                    width: `${Math.max(18, point.width)}px`,
                    height: `${Math.max(18, point.height)}px`,
                });
            lineButton.el.setAttribute("data-title", line.text);
            lineButton.on("click", () => {
                void options
                    .copiedText(line.text)
                    .then(() => showStatus(t("텍스트를 복사했습니다")))
                    .catch(showError);
            });
            textLayer.add(lineButton);
        }
        showStatus(t("이미지의 글자를 눌러 복사하세요."));
    }
    async function reviewRedactions() {
        const recognizedResult = await recognized();
        if (!recognizedResult) return;
        candidateLines = filterSensitiveLines(
            recognizedResult.result.lines as OcrTextLine[],
        );
        if (!candidateLines.length) {
            showStatus(t("민감한 텍스트를 찾지 못했습니다"));
            return;
        }
        candidateRect = options.snapshot(false)?.rect ?? null;
        candidateDraft = {
            id: recognizedResult.saved.id,
            revision: recognizedResult.saved.revision,
            epoch: recognizedResult.epoch,
        };
        candidates.clear();
        for (const line of candidateLines) {
            const choice = input("checkbox");
            choice.el.checked = true;
            candidates.add(
                ele("label")
                    .class("capture-review-line")
                    .add([choice, txt(line.text)]),
            );
        }
        reviewTitle.el.textContent = t("가릴 항목 확인");
        review.el.showModal();
    }
    apply.on("click", () => {
        const active = queue.current;
        if (
            !candidateRect ||
            !active ||
            active.id !== candidateDraft?.id ||
            active.revision !== candidateDraft?.revision ||
            active.dirty ||
            active.pending ||
            active.editEpoch !== candidateDraft?.epoch
        ) {
            review.el.close();
            showStatus(t("캡처가 변경되었습니다. 다시 확인해 주세요."), true);
            return;
        }
        const selected = Array.from(
            candidates.el.querySelectorAll<HTMLInputElement>("input"),
        ).flatMap((choice, index) =>
            choice.checked ? [candidateLines[index]] : [],
        );
        options.redact(selected, candidateRect);
        review.el.close();
        showStatus(t("선택한 항목을 가렸습니다."));
        queue.changed();
    });
    async function showPalette() {
        const colors = await ipcRenderer.invoke("oc:colors:list");
        palette.clear().add(txt(t("최근 색상")));
        for (const sample of colors.slice(0, 12)) {
            const control = button()
                .class("capture-color-swatch")
                .attr({ type: "button", ariaLabel: sample.value })
                .style({ backgroundColor: sample.value });
            control.el.setAttribute("data-title", sample.value);
            control.on("click", () => {
                void options
                    .copiedText(sample.value)
                    .then(() => showStatus(t("색상을 복사했습니다.")))
                    .catch(showError);
            });
            palette.add(control);
        }
        palette.el.hidden = false;
    }
    function sampled(value: string) {
        void ipcRenderer.invoke("oc:colors:add", value).catch(showError);
    }
    function dismiss() {
        textLayer.clear();
        palette.el.hidden = true;
        if (review.el.open) review.el.close();
    }
    const hasPanel = () =>
        textLayer.el.childElementCount > 0 ||
        !palette.el.hidden ||
        review.el.open;
    return {
        queue,
        feedback,
        stage,
        compare,
        promote,
        trash,
        begin,
        initialized: () => queue.initialized(),
        changed: () => queue.changed(),
        flush: () => queue.flush(),
        nextRegion,
        loadPreferences,
        showStatus,
        showError,
        showText,
        reviewRedactions,
        showPalette,
        sampled,
        dismiss,
        hasPanel,
        preferences: () => preferences,
    };
}
