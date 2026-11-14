import type {
    CaptureExperiencePreferences,
    CaptureToolId,
} from "../../../lib/openCaptureTypes";
import { lt } from "../lib/labText";

const toolLabels: Record<CaptureToolId, string> = {
    copy: lt("복사"),
    save: lt("저장"),
    stage: lt("임시 저장"),
    annotate: lt("주석"),
    pin: lt("고정"),
    color: lt("색상"),
    scroll: lt("스크롤 캡처"),
    record: lt("녹화"),
    search: lt("이미지 검색"),
    qr: "QR",
    open: lt("편집기"),
    screens: lt("화면 선택"),
    ocr: lt("텍스트"),
    redact: lt("가리기"),
    compare: lt("비교"),
    promote: lt("보관"),
    trash: lt("휴지통"),
    more: lt("더보기"),
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
    summary.innerHTML = lt(
        "<strong>캡처 도구</strong><small>순서 · 동작 · 피드백</small>",
    );
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
                    : lt("설정을 저장하지 못했습니다."),
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
        heading.innerHTML = lt(
            `<strong>${title}</strong><small>최대 ${max}개</small>`,
            `<strong>${title}</strong><small>Up to ${max}</small>`,
        );
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
                controlButton("↑", lt("앞으로"), () => {
                    if (index <= 0) return;
                    [order[index - 1], order[index]] = [
                        order[index],
                        order[index - 1],
                    ];
                    void commit({ [key]: order });
                }),
                controlButton("↓", lt("뒤로"), () => {
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
            renderOrder(lt("하단 툴바"), "toolbarOrder", 6),
            renderOrder(lt("우클릭 원형 메뉴"), "radialOrder", 8),
        );
        body.append(tools);

        const optionsGrid = document.createElement("div");
        optionsGrid.className = "experience-options-grid";
        const preset = document.createElement("select");
        for (const [value, text] of [
            ["copy-close", lt("복사 후 닫기")],
            ["stage-only", lt("임시 저장")],
            ["stage-pin", lt("저장 후 고정")],
            ["annotate", lt("주석 열기")],
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
        optionsGrid.append(settingRow(lt("기본 동작"), preset));

        const motion = document.createElement("select");
        for (const [value, text] of [
            ["system", lt("시스템 설정")],
            ["full", lt("전체 모션")],
            ["reduced", lt("모션 줄이기")],
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
        optionsGrid.append(settingRow(lt("모션"), motion));

        const trashDays = document.createElement("select");
        for (const [value, text] of [
            ["0", lt("자동 비우지 않음")],
            ["7", lt("7일 후 비우기")],
            ["14", lt("14일 후 비우기")],
            ["30", lt("30일 후 비우기")],
            ["90", lt("90일 후 비우기")],
        ])
            trashDays.add(new Option(text, value));
        trashDays.value = String(current.trashRetentionDays);
        trashDays.addEventListener(
            "change",
            () => void commit({ trashRetentionDays: Number(trashDays.value) }),
        );
        optionsGrid.append(settingRow(lt("휴지통 자동 비우기"), trashDays));

        for (const [key, text] of [
            ["visual", lt("시각 피드백")],
            ["sound", lt("소리 (기본 꺼짐)")],
            ["shelfEnabled", lt("캡처 선반")],
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
