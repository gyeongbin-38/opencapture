import { button, txt, view } from "dkh-ui";
import { renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import type { 功能 } from "../../ShareTypes.js";
import { initStyle } from "../root/root";

initStyle(store);

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

const countEl = txt(String(total)).class("delay-count");

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
        ariaValueNow: String(total),
    })
    .add(progressBar);
if (!reducedMotion)
    requestAnimationFrame(() =>
        requestAnimationFrame(() =>
            progressBar.style({ transform: "scaleX(0)" }),
        ),
    );

const cancel = button(txt(t("取消")))
    .class("delay-cancel")
    .attr({ type: "button" })
    .on("click", () => renderSend("captureDelayCancel", []));

view()
    .class("delay-card")
    .add([
        txt(`${t("截屏倒计时")}${actionText}`).class("delay-label"),
        countEl,
        progress,
        cancel,
    ])
    .addInto();

let left = total;
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
    if (e.key === "Escape") renderSend("captureDelayCancel", []);
});
