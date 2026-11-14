import { image, txt, view } from "dkh-ui";
import { radialLayout } from "../../../lib/captureControls";
import { renderOn, renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import type { IconType } from "../../iconTypes";
import { getImgUrl, initStyle } from "../root/root";

initStyle(store);

const actionDefs: Record<string, { icon: IconType; label: string }> = {
    screens: { icon: "camera", label: t("截屏") },
    quick: { icon: "copy", label: t("快速截屏") },
    ocr: { icon: "ocr", label: t("文字识别") },
    ding: { icon: "ding", label: t("贴图") },
    record: { icon: "record", label: t("录屏") },
    long: { icon: "long_clip", label: t("广截屏") },
    translate: { icon: "translate", label: t("屏幕翻译") },
    home: { icon: "main", label: t("起始页") },
    cutout: { icon: "cut", label: t("去除背景") },
    ocrclip: { icon: "ocr", label: t("剪贴板文字识别") },
    recent: { icon: "history", label: t("最近") },
    repeat: { icon: "reload", label: t("같은 영역 다시 캡처") },
    textpin: { icon: "text", label: t("텍스트 고정") },
    qrpin: { icon: "scan", label: t("클립보드 QR") },
};

const rootEl = view().style({ width: "100vw", height: "100vh" });
rootEl.addInto();

let segments: ReturnType<typeof view>[] = [];
let centerLabel: ReturnType<typeof view> | null = null;
let centerEl: ReturnType<typeof view> | null = null;
let shownIds: string[] = [];

renderOn("radialShow", ([ids]) => {
    rootEl.el.innerHTML = "";
    segments = [];
    shownIds = ids;
    const layout = radialLayout(
        { x: 130, y: 130 },
        { width: 260, height: 260 },
        ids.length,
        38,
    );
    view()
        .class("radial-ring")
        .style({
            width: `${layout.radius * 2}px`,
            height: `${layout.radius * 2}px`,
            margin: `-${layout.radius}px 0 0 -${layout.radius}px`,
        })
        .addInto(rootEl);
    const center = view().class("radial-center");
    centerEl = center;
    centerLabel = view()
        .class("radial-center-label")
        .add(txt(t("取消")));
    center.add(centerLabel);
    center.addInto(rootEl);
    for (const [index, id] of ids.entries()) {
        const def = actionDefs[id];
        const p = layout.points[index];
        const seg = view()
            .class("radial-seg")
            .style({
                left: `${p.x}px`,
                top: `${p.y}px`,
                animationDelay: `${30 + index * 22}ms`,
            });
        seg.add(
            image(getImgUrl(`${def?.icon ?? "circle"}.svg`), "icon").class(
                "icon",
            ),
        );
        seg.add(
            view()
                .class("radial-seg-label")
                .add(txt(def?.label ?? id)),
        );
        seg.addInto(rootEl);
        segments.push(seg);
    }
});

renderOn("radialHighlight", ([index]) => {
    for (const [i, seg] of segments.entries())
        seg.el.classList.toggle("on", i === index);
    const id = index >= 0 ? shownIds[index] : undefined;
    const label = id ? actionDefs[id]?.label : undefined;
    centerLabel?.clear().add(txt(label ?? t("取消")));
    centerEl?.el.classList.toggle("on", index < 0);
});

renderOn("radialHide", () => {
    rootEl.el.innerHTML = "";
    segments = [];
    centerEl = null;
});

renderSend("radialReady", []);
