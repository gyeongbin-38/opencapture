import { button, ele, initDKH, txt, view } from "dkh-ui";
import type { OpenCaptureItem } from "../../../lib/openCaptureTypes";
import { icon } from "../dashboard/icons";
import { t } from "../dashboard/t";

initDKH({ pureStyle: true });
let items: OpenCaptureItem[] = [];
const selected = new Set<string>();
let request = 0;
const panel = view().class("capture-shelf-panel").addInto();
const header = view("x").class("shelf-header").addInto(panel);
const title = txt(t("임시 캡처")).addInto(header);
const closeButton = button("×")
    .class("shelf-close")
    .attr({ type: "button", ariaLabel: t("닫기") })
    .addInto(header);
closeButton.on("click", () => window.close());
const rail = view("x").class("shelf-rail").addInto(panel);
const actions = view("x").class("shelf-actions").addInto(panel);
const status = txt("")
    .class("shelf-status")
    .attr({ role: "status", ariaLive: "polite" })
    .addInto(panel);
txt(
    [
        `C ${t("복사")}`,
        `E ${t("주석")}`,
        `P ${t("고정")}`,
        `V ${t("비교")}`,
        `X ${t("변환")}`,
        `A ${t("보관")}`,
        `D ${t("휴지통")}`,
        `←→ ${t("선택 이동")}`,
        t("드래그로 보내기"),
    ].join(" · "),
)
    .class("shelf-hint")
    .addInto(panel);
const controls: { el: HTMLButtonElement; key?: string }[] = [];
function action(
    label: string,
    glyph: string,
    key: string,
    handler: (ids: string[]) => Promise<unknown>,
    multiple = false,
) {
    const control = button()
        .class("shelf-action")
        .attr({
            type: "button",
            ariaLabel: `${t(label)} (${key.toUpperCase()})`,
            title: `${t(label)} (${key.toUpperCase()})`,
        })
        .add(icon(glyph))
        .on("click", () => {
            const ids = Array.from(selected);
            if (!ids.length) return;
            control.el.disabled = true;
            void handler(ids)
                .then((result) => {
                    if (result !== false) status.el.textContent = t("완료");
                    return refresh();
                })
                .catch((error) => {
                    status.el.textContent =
                        error instanceof Error ? error.message : String(error);
                })
                .finally(() => renderActions());
        })
        .addInto(actions);
    control.el.dataset.multiple = String(multiple);
    control.el.dataset.shelfAction = key;
    controls.push({ el: control.el, key });
}
action(
    "복사",
    "▣",
    "c",
    async (ids) => {
        if (ids.length === 1)
            return window.openCapture.shelfAction("copy", ids[0]);
        return window.openCapture.copySourceFiles(ids);
    },
    true,
);
action("주석", "✎", "e", (ids) =>
    window.openCapture.shelfAction("edit", ids[0]),
);
action(
    "고정",
    "◇",
    "p",
    async (ids) => {
        for (const id of ids) await window.openCapture.shelfAction("pin", id);
    },
    true,
);
action(
    "비교",
    "⇄",
    "v",
    (ids) => window.openCapture.requestComparison(ids),
    true,
);
action(
    "변환",
    "⭘",
    "x",
    async (ids) => {
        await window.openCapture.requestConversion(ids);
        status.el.textContent = "";
        return false;
    },
    true,
);
action("보관", "⇩", "a", (ids) => window.openCapture.promoteItems(ids), true);
action("휴지통", "⌫", "d", (ids) => window.openCapture.trashItems(ids), true);

function renderActions() {
    for (const control of controls) {
        control.el.disabled =
            !selected.size ||
            (control.el.dataset.multiple !== "true" && selected.size !== 1) ||
            (control.key === "v" && selected.size < 2);
    }
}
function render() {
    title.el.textContent = `${t("임시 캡처")} ${items.length}`;
    rail.clear();
    if (!items.length)
        rail.add(txt(t("임시 캡처가 없습니다")).class("shelf-empty"));
    for (const item of items) {
        const card = button(
            ele("img").attr({ src: item.thumbnail ?? "", alt: item.name }),
        )
            .class("shelf-card")
            .attr({
                type: "button",
                ariaLabel: item.name,
                ariaPressed: String(selected.has(item.id)),
                draggable: true,
            });
        card.el.dataset.itemId = item.id;
        card.on("click", (event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                if (selected.has(item.id)) selected.delete(item.id);
                else selected.add(item.id);
            } else {
                selected.clear();
                selected.add(item.id);
            }
            render();
        });
        card.on("dblclick", () => {
            void window.openCapture
                .shelfAction("edit", item.id)
                .catch((error) => {
                    status.el.textContent = String(error);
                });
        });
        card.on("dragstart", (event) => {
            event.preventDefault();
            window.openCapture.startDrag(
                selected.has(item.id) && selected.size > 1
                    ? items.filter((i) => selected.has(i.id)).map((i) => i.id)
                    : item.id,
            );
        });
        rail.add(card);
    }
    renderActions();
}
async function refresh() {
    const sequence = ++request;
    const result = await window.openCapture.queryItems({
        scope: "temporary",
        sort: "newest",
        offset: 0,
        limit: 80,
        queryId: `shelf-${sequence}`,
    });
    if (sequence !== request) return;
    const prior = new Set(items.map((item) => item.id));
    items = result.items;
    for (const id of selected)
        if (!items.some((item) => item.id === id)) selected.delete(id);
    if (!selected.size && items[0]) selected.add(items[0].id);
    render();
    if (items.some((item) => !prior.has(item.id)))
        panel.el.classList.add("shelf-arrived");
    setTimeout(() => panel.el.classList.remove("shelf-arrived"), 250);
}
window.openCapture.onLibraryChanged(() => {
    void refresh().catch((error) => {
        status.el.textContent = String(error);
    });
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.close();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        for (const item of items) selected.add(item.id);
        render();
        return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        items.length
    ) {
        const ids = items.map((item) => item.id);
        const current = ids.findIndex((id) => selected.has(id));
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const next =
            current < 0
                ? ids[event.key === "ArrowLeft" ? ids.length - 1 : 0]
                : ids[Math.min(ids.length - 1, Math.max(0, current + delta))];
        if (next) {
            selected.clear();
            selected.add(next);
            render();
            rail.el
                .querySelector(`[data-item-id="${next}"]`)
                ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        return;
    }
    if (event.key === "Enter") {
        if (
            event.target instanceof Element &&
            event.target.closest("[data-shelf-action]")
        )
            return;
        const edit = controls.find((control) => control.key === "e");
        if (edit && !edit.el.disabled) {
            event.preventDefault();
            edit.el.click();
        }
        return;
    }
    const key = event.key === "Delete" ? "d" : event.key.toLowerCase();
    const control = controls.find((control) => control.key === key);
    if (control && !control.el.disabled) control.el.click();
});
void window.openCapture
    .getPreferences()
    .then((preferences) => {
        document.body.classList.toggle(
            "shelf-feedback-off",
            !preferences.feedback.visual,
        );
        document.body.classList.toggle(
            "shelf-reduced",
            preferences.feedback.motion === "reduced",
        );
    })
    .catch(() => {});
void refresh().catch((error) => {
    status.el.textContent = String(error);
});
