import type { BoardSummary } from "../../../lib/captureBoard";
import type { OpenCaptureItem } from "../../../lib/openCaptureTypes";

export type MinimalHomeOptions = {
    capture(): void;
    openCommands(): void;
    openItem(item: OpenCaptureItem): void;
    openBoard(id?: string): Promise<unknown>;
    showLibrary(): void;
};

export type MinimalHomeController = {
    root: HTMLElement;
    render(input: {
        shortcut: string;
        recents: OpenCaptureItem[];
        activeBoard?: BoardSummary;
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
    const eyebrow = document.createElement("span");
    eyebrow.className = "minimal-eyebrow";
    eyebrow.textContent = "CAPTURE";
    const title = document.createElement("h2");
    title.textContent = "필요한 순간, 바로 캡처";
    const description = document.createElement("p");
    description.textContent =
        "영역을 선택한 뒤 복사하거나 보드에서 이어서 작업하세요.";
    const capture = control("새 캡처", "minimal-capture-button");
    capture.dataset.action = "capture";
    const captureGlyph = document.createElement("span");
    captureGlyph.textContent = "⌗";
    const captureLabel = document.createElement("strong");
    captureLabel.textContent = "새 캡처";
    const captureKey = document.createElement("kbd");
    capture.replaceChildren(captureGlyph, captureLabel, captureKey);
    capture.addEventListener("click", options.capture);
    const command = control("모든 기능 찾기", "minimal-command-button");
    command.dataset.commandOpen = "true";
    command.addEventListener("click", options.openCommands);
    hero.append(eyebrow, title, description, capture, command);

    const continueSection = document.createElement("section");
    continueSection.className = "minimal-continue";
    const continueCopy = document.createElement("div");
    const continueEyebrow = document.createElement("span");
    continueEyebrow.className = "minimal-eyebrow";
    continueEyebrow.textContent = "CONTINUE";
    const continueTitle = document.createElement("strong");
    const continueMeta = document.createElement("small");
    continueCopy.append(continueEyebrow, continueTitle, continueMeta);
    const continueButton = control("이어가기", "minimal-continue-button");
    continueButton.dataset.boardContinue = "true";
    continueSection.append(continueCopy, continueButton);

    const recentHeader = document.createElement("div");
    recentHeader.className = "minimal-section-head";
    const recentTitle = document.createElement("h3");
    recentTitle.textContent = "최근 캡처";
    const libraryButton = control("전체 보기", "minimal-link-button");
    libraryButton.addEventListener("click", options.showLibrary);
    recentHeader.append(recentTitle, libraryButton);
    const recentGrid = document.createElement("div");
    recentGrid.className = "minimal-recent-grid";
    root.append(hero, continueSection, recentHeader, recentGrid);

    return {
        root,
        render({ shortcut, recents, activeBoard }) {
            captureKey.textContent = shortcut || "";
            captureKey.hidden = !shortcut;
            continueSection.hidden = !activeBoard;
            if (activeBoard) {
                continueTitle.textContent = activeBoard.name;
                continueMeta.textContent = `${activeBoard.imageCount}개 이미지 · ${activeBoard.nodeCount}개 요소`;
                continueButton.onclick = () =>
                    void options.openBoard(activeBoard.id);
            }
            recentGrid.replaceChildren();
            if (!recents.length) {
                const empty = document.createElement("p");
                empty.className = "minimal-recent-empty";
                empty.textContent = "첫 캡처가 여기에 나타납니다.";
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
                image.src = item.thumbnail ?? "";
                const copy = document.createElement("span");
                const name = document.createElement("strong");
                name.textContent = item.name;
                const date = document.createElement("small");
                date.textContent = new Intl.DateTimeFormat("ko-KR", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                }).format(new Date(item.createdAt));
                copy.append(name, date);
                card.append(image, copy);
                card.addEventListener("click", () => options.openItem(item));
                recentGrid.append(card);
            }
        },
    };
}
