import { button, txt, view } from "dkh-ui";
import { renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import type { 功能 } from "../../ShareTypes.js";
import { reportUnhandledErrors } from "../lib/unhandled";
import { initStyle } from "../root/root";

initStyle(store);

reportUnhandledErrors((message) =>
    renderSend("noti", [{ title: t("오류"), body: message }]),
);

const params = new URLSearchParams(location.search);
const total = Math.max(1, Math.min(15, Number(params.get("seconds")) || 3));

// 倒计时后将要执行的工具 — 与 clip 工具栏标题共用翻译
const delayActionLabels: Record<功能, string> = {
    close: "关闭",
    screens: "屏幕管理",
    ocr: "文字识别",
    ocrcopy: "复制文字",
    search: "以图搜图",
    QR: "二维码",
    open: "其他应用打开",
    ding: "屏幕贴图",
    record: "录屏",
    long: "广截屏",
    translate: "屏幕翻译",
    editor: "高级图片编辑",
    redact: "민감한 텍스트 자동 가림",
    copy: "复制",
    save: "保存",
};
const action = params.get("action") as 功能 | null;
const actionText =
    action && action in delayActionLabels
        ? ` · ${t(delayActionLabels[action])}`
        : "";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let left = total;
const countEl = txt(String(left)).class("delay-count");

const progressBar = view()
    .class("delay-progress-bar")
    .style({ transitionDuration: reducedMotion ? "0s" : `${total}s` });
const progress = view()
    .class("delay-progress")
    .attr({
        role: "progressbar",
        ariaLabel: t("截屏倒计时"),
        ariaValueMin: "0",
        ariaValueMax: String(total),
        ariaValueNow: String(left),
    })
    .add(progressBar);
if (!reducedMotion)
    requestAnimationFrame(() =>
        requestAnimationFrame(() =>
            progressBar.style({ transform: "scaleX(0)" }),
        ),
    );

// 调整剩余秒数后让进度条从当前位置重新匀速耗尽
const syncProgress = () => {
    progress.el.ariaValueNow = String(left);
    const fraction = Math.min(1, Math.max(0, left / total));
    if (reducedMotion) {
        progressBar.style({ transform: `scaleX(${fraction})` });
        return;
    }
    progressBar.style({
        transitionDuration: "0s",
        transform: `scaleX(${fraction})`,
    });
    void progressBar.el.offsetWidth;
    progressBar.style({
        transitionDuration: `${left}s`,
        transform: "scaleX(0)",
    });
};

const adjust = (delta: number) => {
    const next = Math.max(1, Math.min(15, left + delta));
    if (next === left) return;
    left = next;
    countEl.sv(String(left));
    syncProgress();
    renderSend("captureDelayAdjust", [delta]);
};

const minus = button(txt("−1s"))
    .class("delay-adjust")
    .attr({ type: "button", ariaLabel: t("남은 시간 1초 줄이기") })
    .on("click", () => adjust(-1));
const plus = button(txt("+1s"))
    .class("delay-adjust")
    .attr({ type: "button", ariaLabel: t("남은 시간 1초 늘리기") })
    .on("click", () => adjust(1));

const skip = button(txt(t("캡처하기")))
    .class("delay-skip")
    .attr({ type: "button" })
    .on("click", () => renderSend("captureDelaySkip", []));

const cancel = button(txt(t("取消")))
    .class("delay-cancel")
    .attr({ type: "button" })
    .on("click", () => renderSend("captureDelayCancel", []));

view()
    .class("delay-card")
    .add([
        txt(`${t("截屏倒计时")}${actionText}`).class("delay-label"),
        view("x").class("delay-stepper").add([minus, countEl, plus]),
        progress,
        view("x").class("delay-actions").add([skip, cancel]),
    ])
    .addInto();

const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
        clearInterval(timer);
        countEl.sv("0");
    } else countEl.sv(String(left));
    progress.el.ariaValueNow = String(Math.max(left, 0));
    if (reducedMotion)
        progressBar.style({
            transform: `scaleX(${Math.max(left, 0) / total})`,
        });
}, 1000);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        renderSend("captureDelayCancel", []);
        return;
    }
    if (e.key === "Enter") {
        // 焦点在按钮上时交给按钮自身点击，避免重复触发
        if ((e.target as HTMLElement | null)?.tagName !== "BUTTON")
            renderSend("captureDelaySkip", []);
        return;
    }
    if (e.key === "+" || e.key === "=") adjust(1);
    else if (e.key === "-") adjust(-1);
});
