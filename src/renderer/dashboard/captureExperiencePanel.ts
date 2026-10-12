import type {
    CaptureExperiencePreferences,
    CaptureToolId,
} from "../../../lib/openCaptureTypes";

const toolLabels: Record<CaptureToolId, string> = {
    copy: "복사",
    save: "저장",
    stage: "임시 저장",
    annotate: "주석",
    pin: "고정",
    color: "색상",
    scroll: "스크롤 캡처",
    record: "녹화",
    search: "이미지 검색",
    qr: "QR",
    open: "편집기",
    screens: "화면 선택",
    ocr: "텍스트",
    redact: "가리기",
    compare: "비교",
    promote: "보관",
    trash: "휴지통",
    more: "더보기",
};

const allTools = Object.keys(toolLabels) as CaptureToolId[];

function controlButton(text: string, title: string, run: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "experience-order-button";
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", run);
    return button;
}

export function createCaptureExperiencePanel(options: {
    save: (
        patch: Partial<CaptureExperiencePreferences>,
    ) => Promise<CaptureExperiencePreferences>;
    announce: (message: string, error?: boolean) => void;
}) {
    const root = document.createElement("details");
    root.className = "settings-card experience-settings";
    const summary = document.createElement("summary");
    summary.innerHTML =
        "<strong>캡처 도구</strong><small>순서 · 동작 · 피드백</small>";
    root.append(summary);
    const body = document.createElement("div");
    body.className = "experience-settings-body";
    root.append(body);
    let current: CaptureExperiencePreferences | null = null;

    async function commit(patch: Partial<CaptureExperiencePreferences>) {
        if (!current) return;
        try {
            current = await options.save(patch);
            render();
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : "설정을 저장하지 못했습니다.",
                true,
            );
        }
    }

    function renderOrder(
        title: string,
        key: "toolbarOrder" | "radialOrder",
        max: number,
    ) {
        if (!current) return document.createElement("div");
        const section = document.createElement("section");
        section.className = "experience-tool-section";
        const heading = document.createElement("div");
        heading.className = "experience-tool-heading";
        heading.innerHTML = `<strong>${title}</strong><small>최대 ${max}개</small>`;
        section.append(heading);
        const list = document.createElement("div");
        list.className = "experience-tool-list";
        const order = [...current[key]];
        for (const tool of allTools) {
            const row = document.createElement("div");
            row.className = "experience-tool-row";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = order.includes(tool);
            checkbox.disabled = tool === "more";
            checkbox.addEventListener("change", () => {
                const next = order.filter((value) => value !== tool);
                if (checkbox.checked && next.length < max) next.push(tool);
                if (!next.includes("more")) next.push("more");
                void commit({ [key]: next.slice(0, max) });
            });
            const name = document.createElement("span");
            name.textContent = toolLabels[tool];
            const index = order.indexOf(tool);
            const controls = document.createElement("div");
            controls.className = "experience-order-controls";
            controls.append(
                controlButton("↑", "앞으로", () => {
                    if (index <= 0) return;
                    [order[index - 1], order[index]] = [
                        order[index],
                        order[index - 1],
                    ];
                    void commit({ [key]: order });
                }),
                controlButton("↓", "뒤로", () => {
                    if (index < 0 || index >= order.length - 1) return;
                    [order[index], order[index + 1]] = [
                        order[index + 1],
                        order[index],
                    ];
                    void commit({ [key]: order });
                }),
            );
            controls.hidden = index < 0;
            row.append(checkbox, name, controls);
            list.append(row);
        }
        section.append(list);
        return section;
    }

    function settingRow(label: string, control: HTMLElement) {
        const row = document.createElement("label");
        row.className = "experience-setting-row";
        const name = document.createElement("span");
        name.textContent = label;
        row.append(name, control);
        return row;
    }

    function render() {
        body.replaceChildren();
        if (!current) return;
        const tools = document.createElement("div");
        tools.className = "experience-tool-columns";
        tools.append(
            renderOrder("하단 툴바", "toolbarOrder", 6),
            renderOrder("우클릭 원형 메뉴", "radialOrder", 8),
        );
        body.append(tools);

        const optionsGrid = document.createElement("div");
        optionsGrid.className = "experience-options-grid";
        const preset = document.createElement("select");
        for (const [value, text] of [
            ["copy-close", "복사 후 닫기"],
            ["stage-only", "임시 저장"],
            ["stage-pin", "저장 후 고정"],
            ["annotate", "주석 열기"],
        ])
            preset.add(new Option(text, value));
        preset.value = current.defaultPreset;
        preset.addEventListener(
            "change",
            () =>
                void commit({
                    defaultPreset:
                        preset.value as CaptureExperiencePreferences["defaultPreset"],
                }),
        );
        optionsGrid.append(settingRow("기본 동작", preset));

        const motion = document.createElement("select");
        for (const [value, text] of [
            ["system", "시스템 설정"],
            ["full", "전체 모션"],
            ["reduced", "모션 줄이기"],
        ])
            motion.add(new Option(text, value));
        motion.value = current.feedback.motion;
        motion.addEventListener(
            "change",
            () =>
                void commit({
                    feedback: {
                        ...current?.feedback,
                        motion: motion.value as CaptureExperiencePreferences["feedback"]["motion"],
                    } as CaptureExperiencePreferences["feedback"],
                }),
        );
        optionsGrid.append(settingRow("모션", motion));

        for (const [key, text] of [
            ["visual", "시각 피드백"],
            ["sound", "소리 (기본 꺼짐)"],
            ["shelfEnabled", "캡처 선반"],
        ] as const) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked =
                key === "shelfEnabled"
                    ? current.shelfEnabled
                    : current.feedback[key];
            checkbox.addEventListener("change", () => {
                if (key === "shelfEnabled")
                    void commit({ shelfEnabled: checkbox.checked });
                else
                    void commit({
                        feedback: {
                            ...current?.feedback,
                            [key]: checkbox.checked,
                        } as CaptureExperiencePreferences["feedback"],
                    });
            });
            optionsGrid.append(settingRow(text, checkbox));
        }
        body.append(optionsGrid);
    }

    return {
        element: root,
        update(preferences: CaptureExperiencePreferences) {
            current = preferences;
            render();
        },
    };
}
