import { button, ele, initDKH, txt, view } from "dkh-ui";
import type { OpenCaptureItem } from "../../../lib/openCaptureTypes";
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
const controls: HTMLButtonElement[] = [];
function action(
    label: string,
    handler: (ids: string[]) => Promise<unknown>,
    multiple = false,
) {
    const control = button(t(label))
        .class("shelf-action")
        .attr({ type: "button" })
        .on("click", () => {
            const ids = Array.from(selected);
            if (!ids.length) return;
            control.el.disabled = true;
            void handler(ids)
                .then(() => {
                    status.el.textContent = t("완료");
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
    controls.push(control.el);
}
action(
    "복사",
    async (ids) => {
        if (ids.length === 1)
            return window.openCapture.shelfAction("copy", ids[0]);
        return window.openCapture.copySourceFiles(ids);
    },
    true,
);
action("주석", (ids) => window.openCapture.shelfAction("edit", ids[0]));
action(
    "고정",
    async (ids) => {
        for (const id of ids) await window.openCapture.shelfAction("pin", id);
    },
    true,
);
action("비교", (ids) => window.openCapture.requestComparison(ids), true);
action("보관", (ids) => window.openCapture.promoteItems(ids), true);

function renderActions() {
    for (const control of controls) {
        control.disabled =
            !selected.size ||
            (control.dataset.multiple !== "true" && selected.size !== 1) ||
            (control.textContent === t("비교") && selected.size < 2);
    }
}
function render() {
    title.el.textContent = `${t("임시 캡처")} ${items.length}`;
    rail.clear();
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
            window.openCapture.startDrag(item.id);
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
    }
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
