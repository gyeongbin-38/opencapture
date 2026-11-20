import { button, txt, view } from "dkh-ui";
import { renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import { initStyle } from "../root/root";

initStyle(store);

const total = Math.max(
    1,
    Math.min(
        15,
        Number(new URLSearchParams(location.search).get("seconds")) || 3,
    ),
);

const countEl = txt(String(total)).class("delay-count");

const progressBar = view()
    .class("delay-progress-bar")
    .style({ transitionDuration: `${total}s` });
const progress = view()
    .class("delay-progress")
    .attr({ role: "progressbar", ariaLabel: t("截屏倒计时") })
    .add(progressBar);
requestAnimationFrame(() =>
    requestAnimationFrame(() => progressBar.style({ transform: "scaleX(0)" })),
);

const cancel = button(txt(t("取消")))
    .class("delay-cancel")
    .attr({ type: "button" })
    .on("click", () => renderSend("captureDelayCancel", []));

view()
    .class("delay-card")
    .add([txt(t("截屏倒计时")).class("delay-label"), countEl, progress, cancel])
    .addInto();

let left = total;
const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
        clearInterval(timer);
        countEl.sv("0");
    } else countEl.sv(String(left));
}, 1000);

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") renderSend("captureDelayCancel", []);
});
