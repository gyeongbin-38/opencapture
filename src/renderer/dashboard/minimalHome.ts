import type { BoardSummary } from "../../../lib/captureBoard";
import type {
    DashboardPin,
    OpenCaptureItem,
    PinWorkspaceSummary,
} from "../../../lib/openCaptureTypes";
import { icon } from "./icons";
import { t } from "./t";

export type MinimalHomeOptions = {
    capture(): void;
    openCommands(): void;
    openItem(item: OpenCaptureItem): void;
    openBoard(id?: string): Promise<unknown>;
    showLibrary(): void;
    pinAction(
        action: "close" | "blink" | "restore" | "closeAll",
        id?: string,
    ): void;
    pinWorkspace(
        op: "save" | "restore" | "delete",
        name?: string,
        opts?: { keep?: boolean },
    ): void;
};

export type MinimalHomeController = {
    root: HTMLElement;
    render(input: {
        shortcut: string;
        recents: OpenCaptureItem[];
        activeBoard?: BoardSummary;
        pins?: DashboardPin[];
        workspaces?: PinWorkspaceSummary[];
    }): void;
};

function control(label: string, className: string) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    return element;
}

export function createMinimalHome(
    options: MinimalHomeOptions,
): MinimalHomeController {
    const root = document.createElement("section");
    root.className = "minimal-home";

    const hero = document.createElement("div");
    hero.className = "minimal-home-hero";
    const capture = control(t("새 캡처"), "minimal-capture-button");
    capture.dataset.action = "capture";
    const captureGlyph = icon("⌁").el;
    const captureLabel = document.createElement("strong");
    captureLabel.textContent = t("새 캡처");
    const captureKey = document.createElement("kbd");
    capture.replaceChildren(captureGlyph, captureLabel, captureKey);
    capture.addEventListener("click", options.capture);
    const command = control(t("모든 기능 찾기"), "minimal-command-button");
    command.dataset.commandOpen = "true";
    command.addEventListener("click", options.openCommands);
    hero.append(capture, command);

    const pinsSection = document.createElement("section");
    pinsSection.className = "minimal-pins";
    const pinsHeader = document.createElement("div");
    pinsHeader.className = "minimal-section-head";
    const pinsTitle = document.createElement("h3");
    const pinsActions = document.createElement("div");
    pinsActions.className = "minimal-pins-actions";
    const restoreButton = control(t("모두 복원"), "minimal-link-button");
    restoreButton.addEventListener("click", () => options.pinAction("restore"));
    const closeAllButton = control(t("모두 닫기"), "minimal-link-button");
    closeAllButton.addEventListener("click", () =>
        options.pinAction("closeAll"),
    );
    const saveSetButton = control(t("세트 저장"), "minimal-link-button");
    let lastSavedSets: PinWorkspaceSummary[] = [];
    saveSetButton.addEventListener("click", () => {
        const name = window.prompt(
            t("핀 세트 이름"),
            `${t("핀 세트")} ${lastSavedSets.length + 1}`,
        );
        if (name?.trim()) options.pinWorkspace("save", name.trim());
    });
    pinsActions.append(saveSetButton, restoreButton, closeAllButton);
    pinsHeader.append(pinsTitle, pinsActions);
    const pinsGrid = document.createElement("div");
    pinsGrid.className = "minimal-pins-grid";
    const workspaceRow = document.createElement("div");
    workspaceRow.className = "minimal-pin-workspaces";
    pinsSection.append(pinsHeader, workspaceRow, pinsGrid);
    pinsSection.hidden = true;

    const continueSection = document.createElement("section");
    continueSection.className = "minimal-continue";
    const continueCopy = document.createElement("div");
    const continueTitle = document.createElement("strong");
    const continueMeta = document.createElement("small");
    continueCopy.append(continueTitle, continueMeta);
    const continueButton = control(t("이어가기"), "minimal-continue-button");
    continueButton.dataset.boardContinue = "true";
    continueSection.append(continueCopy, continueButton);
    continueSection.hidden = true;

    const convertSection = document.createElement("section");
    convertSection.className = "minimal-convert-history";
    const convertHeader = document.createElement("div");
    convertHeader.className = "minimal-section-head";
    const convertTitle = document.createElement("h3");
    convertTitle.textContent = t("최근 변환");
    convertHeader.append(convertTitle);
    const convertRow = document.createElement("div");
    convertRow.className = "minimal-convert-history-row";
    convertSection.append(convertHeader, convertRow);
    convertSection.hidden = true;

    const recentHeader = document.createElement("div");
    recentHeader.className = "minimal-section-head";
    const recentTitle = document.createElement("h3");
    recentTitle.textContent = t("최근 캡처");
    const libraryButton = control(t("전체 보기"), "minimal-link-button");
    libraryButton.addEventListener("click", options.showLibrary);
    recentHeader.append(recentTitle, libraryButton);
    const recentGrid = document.createElement("div");
    recentGrid.className = "minimal-recent-grid";
    root.append(
        hero,
        continueSection,
        pinsSection,
        convertSection,
        recentHeader,
        recentGrid,
    );

    return {
        root,
        render({ shortcut, recents, activeBoard, pins, workspaces }) {
            captureKey.textContent = shortcut || "";
            captureKey.hidden = !shortcut;
            continueSection.hidden =
                !activeBoard ||
                (!activeBoard.imageCount && !activeBoard.nodeCount);
            if (activeBoard) {
                continueTitle.textContent = activeBoard.name;
                continueMeta.textContent = t(
                    "이미지 {images}개 · 요소 {elements}개",
                )
                    .replace("{images}", String(activeBoard.imageCount))
                    .replace("{elements}", String(activeBoard.nodeCount));
                continueButton.onclick = () =>
                    void options.openBoard(activeBoard.id);
            }
            const activePins = pins ?? [];
            const savedSets = workspaces ?? [];
            lastSavedSets = savedSets;
            pinsSection.hidden = !activePins.length && !savedSets.length;
            saveSetButton.hidden = !activePins.length;
            workspaceRow.replaceChildren();
            for (const { name, count } of savedSets) {
                const chip = document.createElement("div");
                chip.className = "minimal-workspace-chip";
                const load = control(
                    `${name} · ${count}`,
                    "minimal-workspace-open",
                );
                load.title = t("핀 세트 불러오기 · Alt+클릭은 기존 핀 유지");
                const remove = control("×", "minimal-pin-close");
                remove.title = t("삭제");
                remove.setAttribute("aria-label", `${name} · ${t("삭제")}`);
                remove.addEventListener("click", (event) => {
                    event.stopPropagation();
                    options.pinWorkspace("delete", name);
                });
                chip.append(load, remove);
                load.addEventListener("click", (event) =>
                    options.pinWorkspace("restore", name, {
                        keep: event.altKey,
                    }),
                );
                workspaceRow.append(chip);
            }
            pinsTitle.textContent = `${t("화면 위 핀")} ${activePins.length}`;
            pinsGrid.replaceChildren();
            for (const pin of activePins) {
                const card = document.createElement("div");
                card.className = "minimal-pin-card";
                const locate = control("", "minimal-pin-open");
                locate.title = t("클릭하면 화면에서 찾기");
                if (!pin.visible || pin.ignored)
                    card.classList.add("minimal-pin-inactive");
                const image = document.createElement("img");
                image.alt = "";
                image.src = pin.src;
                image.style.opacity = String(
                    Math.min(1, Math.max(0.2, pin.opacity)),
                );
                const meta = document.createElement("span");
                meta.className = "minimal-pin-meta";
                const size = document.createElement("small");
                const state = !pin.visible
                    ? ` · ${t("숨김")}`
                    : pin.ignored
                      ? ` · ${t("클릭 통과")}`
                      : "";
                size.textContent = `${Math.round(pin.w)}×${Math.round(pin.h)}${state}`;
                size.title = `${Math.round(pin.x)}, ${Math.round(pin.y)}`;
                const close = control("×", "minimal-pin-close");
                close.title = t("닫기");
                close.setAttribute("aria-label", t("닫기"));
                close.addEventListener("click", (event) => {
                    event.stopPropagation();
                    options.pinAction("close", pin.id);
                });
                meta.append(size);
                locate.append(image, meta);
                card.append(locate, close);
                locate.addEventListener("click", () =>
                    options.pinAction("blink", pin.id),
                );
                pinsGrid.append(card);
            }
            recentGrid.replaceChildren();
            if (!recents.length) {
                const empty = document.createElement("p");
                empty.className = "minimal-recent-empty";
                empty.textContent = t("첫 캡처가 여기에 나타납니다.");
                recentGrid.append(empty);
                return;
            }
            for (const item of recents.slice(0, 3)) {
                const card = document.createElement("button");
                card.type = "button";
                card.className = "minimal-recent-card";
                card.dataset.itemId = item.id;
                const image = document.createElement("img");
                image.alt = "";
                const placeholder = document.createElement("span");
                placeholder.className = "minimal-recent-placeholder";
                placeholder.append(icon("▧").el);
                image.hidden = !item.thumbnail;
                placeholder.hidden = Boolean(item.thumbnail);
                if (item.thumbnail) image.src = item.thumbnail;
                image.addEventListener("error", () => {
                    image.hidden = true;
                    placeholder.hidden = false;
                });
                const copy = document.createElement("span");
                const name = document.createElement("strong");
                name.textContent = item.name;
                const date = document.createElement("small");
                date.textContent = new Intl.DateTimeFormat(
                    window.openCapture.lang || "ko",
                    {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                    },
                ).format(new Date(item.createdAt));
                copy.append(name, date);
                card.append(image, placeholder, copy);
                card.addEventListener("click", () => options.openItem(item));
                recentGrid.append(card);
            }
        },
    };
}
