import "./textDialog.css";

type TextRequest = {
    title: string;
    value?: string;
    multiline?: boolean;
    maxLength?: number;
};
type ChoiceRequest = {
    title: string;
    value?: string;
    choices: Array<{ value: string; label: string }>;
};

function requestValue(
    title: string,
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): Promise<string | null> {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = "workspace-text-dialog";
        const form = document.createElement("form");
        form.method = "dialog";
        const heading = document.createElement("h2");
        heading.textContent = title;
        const actions = document.createElement("div");
        actions.className = "workspace-text-dialog-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "취소";
        const save = document.createElement("button");
        save.type = "submit";
        save.textContent = "확인";
        save.className = "workspace-text-dialog-confirm";
        actions.append(cancel, save);
        form.append(heading, field, actions);
        dialog.append(form);
        let finished = false;
        const finish = (value: string | null) => {
            if (finished) return;
            finished = true;
            document.removeEventListener("keydown", keyDown, true);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(value);
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                finish(null);
            }
            if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "k"
            )
                event.stopImmediatePropagation();
        };
        cancel.addEventListener("click", () => finish(null));
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            finish(field.value);
        });
        dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            finish(null);
        });
        dialog.addEventListener("close", () => finish(null));
        field.setAttribute("aria-label", title);
        document.body.append(dialog);
        document.addEventListener("keydown", keyDown, true);
        dialog.showModal();
        queueMicrotask(() => {
            field.focus();
            if (
                field instanceof HTMLInputElement ||
                field instanceof HTMLTextAreaElement
            )
                field.select();
        });
    });
}

export function requestText(options: TextRequest): Promise<string | null> {
    const field = options.multiline
        ? document.createElement("textarea")
        : document.createElement("input");
    field.value = options.value ?? "";
    field.maxLength = options.maxLength ?? 2000;
    return requestValue(options.title, field);
}

export function requestChoice(options: ChoiceRequest): Promise<string | null> {
    const field = document.createElement("select");
    for (const choice of options.choices)
        field.add(new Option(choice.label, choice.value));
    if (options.value !== undefined) field.value = options.value;
    return requestValue(options.title, field);
}
