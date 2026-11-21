import { view } from "dkh-ui";
import { renderSend } from "../../../lib/ipc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import { reportUnhandledErrors } from "../lib/unhandled";
import { initStyle, setTitle } from "../root/root";

initStyle(store);

reportUnhandledErrors((message) =>
    renderSend("noti", [{ title: t("오류"), body: message }]),
);
setTitle(t("드롭존"));

const iconPaths: Record<string, string> = {
    library:
        '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
    markup: '<path d="m3 14 9-9 3 3-9 9-4 1 1-4Zm9-9 2-2a2 2 0 0 1 3 3l-2 2"/>',
    copy: '<rect x="7" y="7" width="10" height="11" rx="2"/><path d="M13 7V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
    subject:
        '<path d="m12 3-1.9 4.6a2 2 0 0 1-1.1 1.1L4.4 10.6a1 1 0 0 0 0 1.9l4.6 1.9a2 2 0 0 1 1.1 1.1L12 20l1.9-4.5a2 2 0 0 1 1.1-1.1l4.6-1.9a1 1 0 0 0 0-1.9l-4.6-1.9a2 2 0 0 1-1.1-1.1L12 3Z"/>',
    pin: '<path d="m7 2 6 0-1 5 3 3v2H5v-2l3-3-1-5Zm3 10v6"/>',
    ocr: '<path d="M4 3H2v4m14-4h2v4M2 13v4h4m12-4v4h-4M6 6h8M10 6v8m-3 0h6"/>',
};

function cellIcon(name: string) {
    const icon = view().attr({ ariaHidden: "true" });
    icon.el.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg>`;
    return icon;
}

const CELLS: { id: string; icon: string; label: string }[] = [
    { id: "library", icon: "library", label: t("라이브러리") },
    { id: "markup", icon: "markup", label: t("주석·편집") },
    { id: "copy", icon: "copy", label: t("복사") },
    { id: "subject", icon: "subject", label: t("배경 제거") },
    { id: "pin", icon: "pin", label: t("화면에 고정") },
    { id: "ocr", icon: "ocr", label: t("텍스트 인식") },
];

const root = view().attr({ id: "dz_root" }).addInto();

const SIZE = 340;
const CENTER = SIZE / 2;
const RADIUS = 120;
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
            animationDelay: `${i * 28}ms`,
        })
        .add([cellIcon(cell.icon), view().class("dz_label").add(cell.label)])
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
