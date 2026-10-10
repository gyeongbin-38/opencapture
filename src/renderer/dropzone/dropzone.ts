import { view } from "dkh-ui";
import { renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import { initStyle, setTitle } from "../root/root";

initStyle(store);
setTitle(t("드롭존"));

const CELLS: { id: string; glyph: string; label: string }[] = [
    { id: "library", glyph: "▤", label: t("라이브러리") },
    { id: "markup", glyph: "✎", label: t("주석·편집") },
    { id: "copy", glyph: "▣", label: t("복사") },
    { id: "subject", glyph: "✦", label: t("배경 제거") },
    { id: "pin", glyph: "⌖", label: t("화면에 고정") },
    { id: "ocr", glyph: "T", label: t("텍스트 인식") },
];

const root = view().attr({ id: "dz_root" }).addInto();

const SIZE = 340;
const CENTER = SIZE / 2;
const RADIUS = 116;
const startAngle = -Math.PI / 2;

view()
    .attr({ id: "dz_center" })
    .add([
        view().add(t("드롭존")),
        view()
            .class("dz_hint")
            .add([t("파일을 칸에 놓기"), "·", "ESC"]),
    ])
    .addInto(root);

for (const [i, cell] of CELLS.entries()) {
    const angle = startAngle + (i / CELLS.length) * Math.PI * 2;
    const el = view("y")
        .class("dz_cell")
        .style({
            left: `${CENTER + RADIUS * Math.cos(angle)}px`,
            top: `${CENTER + RADIUS * Math.sin(angle)}px`,
            animationDelay: `${i * 30}ms`,
        })
        .add([view().add(cell.glyph), view().class("dz_label").add(cell.label)])
        .addInto(root);

    const cellEl = el.el;
    cellEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        cellEl.classList.add("drag_over");
    });
    cellEl.addEventListener("dragleave", () =>
        cellEl.classList.remove("drag_over"),
    );
    cellEl.addEventListener("drop", (e) => {
        e.preventDefault();
        const { webUtils } = require("electron");
        const paths = Array.from(e.dataTransfer?.files ?? [])
            .map((f) => {
                try {
                    return webUtils.getPathForFile(f);
                } catch {
                    return "";
                }
            })
            .filter(Boolean);
        renderSend("dropzone_action", [cell.id, paths]);
    });
}

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") renderSend("dropzone_close", []);
});
