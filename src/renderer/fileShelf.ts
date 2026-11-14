import { button, ele, initDKH, view } from "dkh-ui";
import type { FileShelfApi, FileShelfEntry } from "../../lib/fileShelf";

const api = (
    window as Window & {
        fileShelf?: FileShelfApi & { t?(text: string): string };
    }
).fileShelf;

const t = (text: string) => api?.t?.(text) ?? text;

initDKH({ pureStyle: true });

let files: FileShelfEntry[] = [];
const selected = new Set<string>();
let busy = false;
let copyMaxFiles = 100;

const root = view("y").class("file-shelf").addInto(document.body);
const header = view("x").class("file-shelf-header").addInto(root);
const heading = view("y").class("file-shelf-heading").addInto(header);
ele("strong")
    .attr({ textContent: t("悬浮文件") })
    .addInto(heading);
const subtitle = ele("small").addInto(heading);
const closeButton = button(t("关闭"))
    .class("file-shelf-close")
    .attr({ type: "button", ariaLabel: t("关闭悬浮文件") })
    .on("click", () => api?.close())
    .addInto(header);

const list = view("y")
    .class("file-shelf-list")
    .attr({ role: "list", ariaLabel: t("文件列表") })
    .addInto(root);
const empty = view("y")
    .class("file-shelf-empty")
    .add(t("没有可显示的文件"))
    .addInto(list);

const footer = view("y").class("file-shelf-footer").addInto(root);
const statusRow = view("x").class("file-shelf-status-row").addInto(footer);
const selectionStatus = ele("span").addInto(statusRow);
const message = ele("span")
    .class("file-shelf-message")
    .attr({ role: "status", ariaLive: "polite" })
    .addInto(statusRow);
const actions = view("x").class("file-shelf-actions").addInto(footer);
const copyButton = button(t("复制文件"))
    .attr({ type: "button" })
    .on("click", () => void runCopy(false))
    .addInto(actions);
const pathButton = button(t("复制路径"))
    .attr({ type: "button" })
    .on("click", () => void runCopy(true))
    .addInto(actions);

const setMessage = (text = "", error = false) => {
    message.el.textContent = text;
    message.el.classList.toggle("error", error);
    message.el.hidden = !text;
};

const copyLimitMessage = () => t("Copy one file at a time on macOS.");

const selectedIds = () =>
    files.filter((file) => selected.has(file.id)).map((file) => file.id);

const syncControls = () => {
    const count = selected.size;
    subtitle.el.textContent = t("{count} 个文件").replace(
        "{count}",
        String(files.length),
    );
    selectionStatus.el.textContent = t("已选择 {count} 个").replace(
        "{count}",
        String(count),
    );
    const copyOverLimit = count > copyMaxFiles;
    copyButton.el.disabled = busy || count === 0 || copyOverLimit;
    pathButton.el.disabled = busy || count === 0;
    closeButton.el.disabled = busy;
    if (!busy && copyOverLimit) setMessage(copyLimitMessage(), true);
    else if (message.el.textContent === copyLimitMessage()) setMessage();
};

const setBusy = (value: boolean) => {
    busy = value;
    root.el.classList.toggle("busy", value);
    for (const control of list.el.querySelectorAll<HTMLInputElement>(
        "input[type='checkbox']",
    ))
        control.disabled = value;
    syncControls();
};

async function runCopy(pathOnly: boolean) {
    if (!api || busy) return;
    const ids = selectedIds();
    if (!ids.length) return;
    if (!pathOnly && ids.length > copyMaxFiles) {
        setMessage(copyLimitMessage(), true);
        return;
    }
    setBusy(true);
    setMessage(pathOnly ? t("正在复制路径") : t("正在复制文件"));
    try {
        if (pathOnly) await api.copyPath(ids);
        else await api.copy(ids);
        setMessage(pathOnly ? t("路径已复制") : t("文件已复制到剪贴板"));
    } catch (error) {
        setMessage(
            error instanceof Error ? t(error.message) : t(String(error)),
            true,
        );
    } finally {
        setBusy(false);
    }
}

const reveal = async (file: FileShelfEntry) => {
    if (!api || busy) return;
    setMessage(t("正在文件夹中显示"));
    try {
        await api.reveal(file.id);
        setMessage(t("已在文件夹中显示"));
    } catch (error) {
        setMessage(
            error instanceof Error ? t(error.message) : t(String(error)),
            true,
        );
    }
};

const beginDrag = (file: FileShelfEntry, event: DragEvent) => {
    event.preventDefault();
    if (!api || busy) return;
    if (!selected.has(file.id)) {
        selected.clear();
        selected.add(file.id);
        for (const checkbox of list.el.querySelectorAll<HTMLInputElement>(
            "input[type='checkbox']",
        ))
            checkbox.checked =
                checkbox.closest<HTMLElement>("[data-file-id]")?.dataset
                    .fileId === file.id;
        syncControls();
    }
    try {
        const outcome = api.drag(selectedIds());
        setMessage(
            outcome.started
                ? t("系统已接受拖放请求")
                : t(outcome.error || "无法开始系统拖放"),
            !outcome.started,
        );
    } catch (error) {
        setMessage(
            error instanceof Error ? t(error.message) : t(String(error)),
            true,
        );
    }
};

function renderFiles() {
    list.el.replaceChildren();
    empty.el.hidden = files.length > 0;
    if (!files.length) list.el.append(empty.el);
    for (const file of files) {
        const row = ele("div")
            .class("file-shelf-row")
            .attr({ role: "listitem", title: file.name });
        row.el.dataset.fileId = file.id;
        const checkbox = ele("input").attr({
            type: "checkbox",
            ariaLabel: t("选择 {name}").replace("{name}", file.name),
        });
        checkbox.el.checked = selected.has(file.id);
        checkbox.el.disabled = busy;
        checkbox.on("change", () => {
            if (checkbox.el.checked) selected.add(file.id);
            else selected.delete(file.id);
            setMessage();
            syncControls();
        });
        const icon = ele("img").class("file-shelf-icon").attr({
            src: file.icon,
            alt: "",
            decoding: "async",
            draggable: false,
        });
        icon.on("error", () => icon.el.classList.add("unavailable"));
        const copy = view("y").class("file-shelf-row-copy");
        copy.add([
            ele("strong").attr({ textContent: file.name }),
            ele("small").attr({
                textContent: file.folder ? t("文件夹") : t("文件"),
            }),
        ]);
        const grip = button("")
            .class("file-shelf-drag")
            .attr({
                type: "button",
                draggable: true,
                ariaLabel: t("拖出 {name}").replace("{name}", file.name),
                title: t("拖动以开始系统文件拖放"),
            });
        grip.el.innerHTML =
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
        grip.el.addEventListener("dragstart", (event) =>
            beginDrag(file, event),
        );
        row.on("dblclick", (event) => {
            event.preventDefault();
            void reveal(file);
        });
        row.on("click", (event) => {
            if ((event.target as HTMLElement).closest("button, input")) return;
            if (selected.has(file.id)) selected.delete(file.id);
            else selected.add(file.id);
            renderFiles();
        });
        row.add([checkbox, icon, copy, grip]);
        row.addInto(list);
    }
    syncControls();
}

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        api?.close();
        return;
    }
    const target = event.target;
    const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
            target.matches("input[type='text'], textarea"));
    if (
        !editing &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "a"
    ) {
        event.preventDefault();
        for (const file of files) selected.add(file.id);
        renderFiles();
    }
});

if (!api) {
    setMessage(t("悬浮文件服务不可用"), true);
    syncControls();
} else {
    void api
        .ready()
        .then((payload) => {
            files = payload.files;
            copyMaxFiles =
                Number.isInteger(payload.copyMaxFiles) &&
                payload.copyMaxFiles > 0
                    ? payload.copyMaxFiles
                    : 1;
            selected.clear();
            for (const file of files) selected.add(file.id);
            renderFiles();
            copyButton.el.focus();
        })
        .catch((error) => {
            setMessage(
                error instanceof Error ? t(error.message) : t(String(error)),
                true,
            );
            syncControls();
        });
}
