export type DashboardCommand = {
    id: string;
    label: string;
    detail?: string;
    keywords?: string[];
    shortcut?: string;
    disabled?: boolean;
    run(): Promise<unknown>;
};

export type CommandPaletteController = {
    dialog: HTMLDialogElement;
    open(query?: string): void;
    close(): void;
    setCommands(commands: DashboardCommand[]): void;
    destroy(): void;
};

export function createCommandPalette(
    parent: HTMLElement,
    initialCommands: DashboardCommand[],
): CommandPaletteController {
    const dialog = document.createElement("dialog");
    dialog.className = "command-palette";
    dialog.setAttribute("aria-label", "명령 검색");

    const searchWrap = document.createElement("div");
    searchWrap.className = "command-search";
    const glyph = document.createElement("span");
    glyph.className = "command-search-glyph";
    glyph.textContent = "⌕";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "기능이나 도구 검색";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "명령 검색");
    searchWrap.append(glyph, input);

    const results = document.createElement("div");
    results.className = "command-results";
    results.setAttribute("role", "listbox");
    const footer = document.createElement("div");
    footer.className = "command-footer";
    footer.textContent = "↑↓ 이동  ·  Enter 실행  ·  Esc 닫기";
    dialog.append(searchWrap, results, footer);
    parent.append(dialog);

    let commands = initialCommands;
    let visible: DashboardCommand[] = [];
    let activeIndex = 0;

    const close = () => {
        if (dialog.open) dialog.close();
    };

    const run = async (command: DashboardCommand) => {
        if (command.disabled) return;
        close();
        await command.run();
    };

    const render = () => {
        const query = input.value.trim().toLocaleLowerCase("ko-KR");
        visible = commands.filter((command) => {
            if (!query) return true;
            return [command.label, command.detail, ...(command.keywords ?? [])]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase("ko-KR")
                .includes(query);
        });
        activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));
        results.replaceChildren();
        if (!visible.length) {
            const empty = document.createElement("p");
            empty.className = "command-empty";
            empty.textContent = "일치하는 기능이 없습니다.";
            results.append(empty);
            return;
        }
        visible.forEach((command, index) => {
            const control = document.createElement("button");
            control.type = "button";
            control.className = "command-result";
            control.dataset.commandId = command.id;
            control.setAttribute("role", "option");
            control.setAttribute(
                "aria-selected",
                String(index === activeIndex),
            );
            control.disabled = Boolean(command.disabled);
            const copy = document.createElement("span");
            copy.className = "command-copy";
            const title = document.createElement("strong");
            title.textContent = command.label;
            copy.append(title);
            if (command.detail) {
                const detail = document.createElement("small");
                detail.textContent = command.detail;
                copy.append(detail);
            }
            control.append(copy);
            if (command.shortcut) {
                const key = document.createElement("kbd");
                key.textContent = command.shortcut;
                control.append(key);
            }
            control.addEventListener("pointermove", () => {
                if (activeIndex === index) return;
                activeIndex = index;
                results
                    .querySelectorAll<HTMLElement>("[role=option]")
                    .forEach((option, optionIndex) =>
                        option.setAttribute(
                            "aria-selected",
                            String(optionIndex === activeIndex),
                        ),
                    );
            });
            control.addEventListener("click", () => void run(command));
            results.append(control);
        });
    };

    input.addEventListener("input", () => {
        activeIndex = 0;
        render();
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!visible.length) return;
            const delta = event.key === "ArrowDown" ? 1 : -1;
            activeIndex =
                (activeIndex + delta + visible.length) % visible.length;
            render();
            results
                .querySelector<HTMLElement>(`[aria-selected="true"]`)
                ?.scrollIntoView({ block: "nearest" });
        }
        if (event.key === "Enter" && visible[activeIndex]) {
            event.preventDefault();
            void run(visible[activeIndex]);
        }
    });
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) close();
    });
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        close();
    });

    return {
        dialog,
        open(query = "") {
            input.value = query;
            activeIndex = 0;
            render();
            if (!dialog.open) dialog.showModal();
            requestAnimationFrame(() => input.focus());
        },
        close,
        setCommands(next) {
            commands = next;
            if (dialog.open) render();
        },
        destroy() {
            dialog.remove();
        },
    };
}
