import { ele } from "dkh-ui";
import type {
    FileToolOptions,
    FileToolRecipe,
    FileToolResult,
    FileToolSelection,
    FileToolSource,
    FileToolsApi,
} from "../../../lib/fileTools";
import { t } from "../dashboard/t";

type Mode = "convert" | "tools" | "actions";
type SourceAction = Parameters<FileToolsApi["sourceAction"]>[1];
type OptionId = NonNullable<FileToolRecipe["options"]>[number];
type UiFileToolsApi = Omit<FileToolsApi, "select"> & {
    select(
        paths?: string[],
        mode?: "files" | "folders",
    ): Promise<FileToolSelection>;
};

const ACTIONS: {
    id: SourceAction;
    label: string;
    detail: string;
    imageOnly?: boolean;
    single?: boolean;
}[] = [
    { id: "copy", label: "复制文件", detail: "复制所选文件" },
    { id: "copy-path", label: "复制路径", detail: "复制完整文件路径" },
    { id: "copy-to", label: "复制到…", detail: "选择目标文件夹并复制" },
    {
        id: "move-to",
        label: "移动到…",
        detail: "选择同一磁盘的目标文件夹并移动",
    },
    { id: "reveal", label: "在文件夹中显示", detail: "显示第一个所选文件" },
    { id: "terminal", label: "在终端中打开", detail: "在文件所在目录打开终端" },
    { id: "share", label: "系统共享", detail: "仅在支持原生共享的平台可用" },
    {
        id: "edit" as SourceAction,
        label: "编辑图像",
        detail: "在现有图像编辑器中打开",
        imageOnly: true,
        single: true,
    },
    {
        id: "float",
        label: "悬浮显示",
        detail: "将所选文件保留在悬浮窗口中",
    },
];

const OPTION_CONFIG: Record<
    OptionId,
    {
        label: string;
        type: "number" | "text" | "select";
        min?: number;
        max?: number;
        step?: number;
        value: string;
        choices?: { value: string; label: string }[];
    }
> = {
    quality: {
        label: "质量（百分比）",
        type: "number",
        min: 10,
        max: 100,
        step: 1,
        value: "90",
    },
    width: {
        label: "宽度（像素）",
        type: "number",
        min: 1,
        max: 32768,
        step: 1,
        value: "1920",
    },
    height: {
        label: "高度（像素）",
        type: "number",
        min: 1,
        max: 32768,
        step: 1,
        value: "1080",
    },
    start: {
        label: "开始时间（秒）",
        type: "number",
        min: 0,
        step: 0.1,
        value: "0",
    },
    end: {
        label: "结束时间（秒）",
        type: "number",
        min: 0,
        step: 0.1,
        value: "10",
    },
    speed: {
        label: "速度倍数",
        type: "number",
        min: 0.25,
        max: 4,
        step: 0.1,
        value: "1",
    },
    pages: {
        label: "页面范围",
        type: "text",
        value: "all",
    },
    angle: {
        label: "旋转角度",
        type: "number",
        min: 0,
        max: 270,
        step: 90,
        value: "90",
    },
    volume: {
        label: "音量（百分比）",
        type: "number",
        min: 10,
        max: 400,
        step: 1,
        value: "100",
    },
    x: {
        label: "水平位置",
        type: "number",
        min: 0,
        step: 1,
        value: "0",
    },
    y: {
        label: "垂直位置",
        type: "number",
        min: 0,
        step: 1,
        value: "0",
    },
    flip: {
        label: "翻转",
        type: "select",
        value: "horizontal",
        choices: [
            { value: "horizontal", label: "水平" },
            { value: "vertical", label: "垂直" },
        ],
    },
    channels: {
        label: "声道",
        type: "select",
        value: "2",
        choices: [
            { value: "1", label: "单声道" },
            { value: "2", label: "立体声" },
        ],
    },
    foldAxis: {
        label: "折叠方向",
        type: "select",
        value: "horizontal",
        choices: [
            { value: "horizontal", label: "水平（移除横向条带）" },
            { value: "vertical", label: "垂直（移除纵向条带）" },
        ],
    },
    foldOffset: {
        label: "折叠起点（像素）",
        type: "number",
        min: 1,
        max: 32767,
        step: 1,
        value: "1",
    },
    foldSize: {
        label: "移除大小（像素）",
        type: "number",
        min: 1,
        max: 32767,
        step: 1,
        value: "1",
    },
};

const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
) => {
    const node = ele(tag).el as HTMLElementTagNameMap[K];
    if (className) node.className = className;
    return node;
};

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const localizedMessage = (message: string) => {
    const foldOption = /^Unsupported image-fold option: (.+)$/.exec(message);
    if (foldOption)
        return t("Unsupported image-fold option: {option}").replace(
            "{option}",
            foldOption[1],
        );
    const silence =
        /^Silence was inserted for (\d+) sources? without audio\.$/.exec(
            message,
        );
    if (silence)
        return t(
            "Silence was inserted for {count} sources without audio.",
        ).replace("{count}", silence[1]);
    const unavailable = /^Conversion is unavailable for (.+)$/.exec(message);
    if (unavailable)
        return t("Conversion is unavailable for {extensions}").replace(
            "{extensions}",
            unavailable[1],
        );
    const encoder = /^FFmpeg has no supported (.+) output encoder\.$/.exec(
        message,
    );
    if (encoder)
        return t("FFmpeg has no supported {kind} output encoder.").replace(
            "{kind}",
            encoder[1],
        );
    return t(message);
};

const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const kindLabel = (source: FileToolSource) => {
    const labels: Record<FileToolSource["kind"], string> = {
        image: "图像",
        video: "视频",
        audio: "音频",
        pdf: "PDF",
        document: "文档",
        spreadsheet: "表格",
        slides: "演示文稿",
        subtitle: "字幕",
        archive: "压缩包",
        folder: "文件夹",
        other: "其他",
    };
    return labels[source.kind];
};

function fileToolsApi(): UiFileToolsApi | undefined {
    return (
        window.openCapture as typeof window.openCapture & {
            fileTools?: UiFileToolsApi;
        }
    ).fileTools;
}

export function openFileTools(paths?: string[]): () => void {
    const api = fileToolsApi();
    const opener =
        document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
    let closed = false;
    let selection: FileToolSelection = {
        sources: [],
        recipes: [],
        rejected: [],
        copyMaxFiles: 100,
    };
    let mode: Mode = "convert";
    let selectedRecipe: FileToolRecipe | undefined;
    let selectedAction: SourceAction | undefined;
    let selectedSourceIds = new Set<string>();
    let results: FileToolResult[] = [];
    let runningJobId = "";
    let runSnapshot:
        | {
              recipe: FileToolRecipe;
              options: FileToolOptions;
              destinationId: string | null;
          }
        | undefined;
    let loading = false;
    let sourcesExpanded = true;

    const backdrop = element("div", "file-tools-backdrop");
    const dialog = element("section", "file-tools-dialog");
    dialog.dataset.fileToolsDialog = "";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "file-tools-title");
    backdrop.append(dialog);
    document.body.append(backdrop);

    const header = element("header", "file-tools-header");
    const heading = element("div");
    const title = element("h2");
    title.id = "file-tools-title";
    title.textContent = t("文件工具");
    heading.append(title);
    const closeButton = element("button");
    closeButton.type = "button";
    closeButton.dataset.fileToolsAction = "close";
    closeButton.textContent = t("关闭");
    header.append(heading, closeButton);

    const body = element("div", "file-tools-body");
    const sourceSection = element("section", "file-tools-sources");
    const sourceHeader = element("div", "file-tools-section-header");
    const sourceTitle = element("h3");
    const sourceToggle = element("button", "file-tools-source-toggle");
    sourceToggle.type = "button";
    sourceToggle.dataset.fileToolsAction = "toggle-sources";
    sourceToggle.setAttribute("aria-controls", "file-tools-source-list");
    sourceTitle.append(sourceToggle);
    const sourcePickerActions = element("div", "file-tools-inline-actions");
    const chooseButton = element("button");
    chooseButton.type = "button";
    chooseButton.dataset.fileToolsAction = "choose-files";
    chooseButton.textContent = t("选择文件");
    const chooseFolderButton = element("button");
    chooseFolderButton.type = "button";
    chooseFolderButton.dataset.fileToolsAction = "choose-folders";
    chooseFolderButton.textContent = t("选择文件夹");
    sourcePickerActions.append(chooseButton, chooseFolderButton);
    sourceHeader.append(sourceTitle, sourcePickerActions);
    const sourceList = element("div", "file-tools-source-list");
    sourceList.id = "file-tools-source-list";
    sourceList.dataset.fileToolsSources = "";
    const rejectedList = element("div", "file-tools-rejected");
    sourceSection.append(sourceHeader, sourceList, rejectedList);

    const modeTabs = element("div", "file-tools-modes");
    modeTabs.setAttribute("role", "tablist");
    const modeButtons = new Map<Mode, HTMLButtonElement>();
    for (const [id, label, key] of [
        ["convert", "转换", "Alt+1"],
        ["tools", "工具", "Alt+2"],
        ["actions", "操作", "Alt+3"],
    ] as [Mode, string, string][]) {
        const tab = element("button");
        tab.type = "button";
        tab.role = "tab";
        tab.dataset.fileToolsMode = id;
        tab.setAttribute("aria-selected", String(id === mode));
        const text = element("span");
        text.textContent = t(label);
        const shortcut = element("kbd");
        shortcut.textContent = key;
        tab.append(text, shortcut);
        modeButtons.set(id, tab);
        modeTabs.append(tab);
    }

    const workspace = element("div", "file-tools-workspace");
    const recipePane = element("section", "file-tools-recipes");
    const recipeSummary = element("p", "file-tools-recipe-summary");
    const recipeList = element("div", "file-tools-recipe-list");
    recipeList.dataset.fileToolsRecipes = "";
    recipeList.setAttribute("role", "listbox");
    recipePane.append(recipeSummary, recipeList);
    const optionsPane = element("section", "file-tools-options");
    optionsPane.dataset.fileToolsOptions = "";
    const optionsTitle = element("h3");
    optionsTitle.textContent = t("选项");
    const optionsHeading = element("div", "file-tools-options-heading");
    const changeRecipeButton = element("button");
    changeRecipeButton.type = "button";
    changeRecipeButton.dataset.fileToolsAction = "change-recipe";
    changeRecipeButton.textContent = t("更改操作");
    optionsHeading.append(optionsTitle, changeRecipeButton);
    const optionGrid = element("div", "file-tools-option-grid");
    optionsPane.append(optionsHeading, optionGrid);
    workspace.append(recipePane, optionsPane);

    const progressSection = element("section", "file-tools-progress");
    progressSection.hidden = true;
    const progressText = element("span");
    progressText.setAttribute("role", "status");
    const progressTrack = element("div", "file-tools-progress-track");
    const progressBar = element("div");
    progressTrack.append(progressBar);
    progressSection.append(progressText, progressTrack);

    const resultSection = element("section", "file-tools-results");
    resultSection.dataset.fileToolsResults = "";
    resultSection.hidden = true;
    const resultHeader = element("div", "file-tools-section-header");
    const resultTitle = element("h3");
    resultTitle.textContent = t("处理结果");
    const resultSummary = element("span");
    resultHeader.append(resultTitle, resultSummary);
    const resultList = element("div", "file-tools-result-list");
    resultSection.append(resultHeader, resultList);

    const message = element("p", "file-tools-message");
    message.setAttribute("role", "status");
    message.hidden = true;

    const footer = element("footer", "file-tools-footer");
    const footerSecondary = element("div", "file-tools-inline-actions");
    const destinationRow = element("label", "file-tools-destination");
    const destinationLabel = element("span");
    destinationLabel.textContent = t("保存位置");
    const destinationSelect = element("select");
    destinationSelect.dataset.fileToolsDestination = "";
    destinationSelect.setAttribute("aria-label", t("保存位置"));
    destinationRow.append(destinationLabel, destinationSelect);
    destinationRow.hidden = true;
    const retryButton = element("button");
    retryButton.type = "button";
    retryButton.dataset.fileToolsAction = "retry";
    retryButton.textContent = t("仅重试失败项");
    retryButton.hidden = true;
    footerSecondary.append(destinationRow, retryButton);
    const footerPrimary = element("div", "file-tools-inline-actions");
    const cancelButton = element("button");
    cancelButton.type = "button";
    cancelButton.dataset.fileToolsAction = "cancel";
    cancelButton.textContent = t("取消");
    const runButton = element("button", "primary");
    runButton.type = "button";
    runButton.dataset.fileToolsAction = "run";
    runButton.textContent = t("运行");
    footerPrimary.append(cancelButton, runButton);
    footer.append(footerSecondary, footerPrimary);

    body.append(
        sourceSection,
        modeTabs,
        workspace,
        progressSection,
        resultSection,
        message,
    );
    dialog.append(header, body, footer);

    const setMessage = (text = "", error = false) => {
        message.hidden = !text;
        message.textContent = text;
        message.classList.toggle("error", error);
    };

    const compatibleSourceIds = (recipe: FileToolRecipe) => {
        const recipeIds = new Set(
            recipe.sourceIds?.length
                ? recipe.sourceIds
                : selection.sources.map((source) => source.id),
        );
        return [...selectedSourceIds].filter((id) => recipeIds.has(id));
    };

    const actionSourceIds = (action: (typeof ACTIONS)[number]) =>
        selection.sources
            .filter(
                (source) =>
                    selectedSourceIds.has(source.id) &&
                    (!action.imageOnly || source.kind === "image"),
            )
            .map((source) => source.id);

    const selectedCount = () => selectedSourceIds.size;
    const syncDestination = () => {
        const previous = destinationSelect.value;
        destinationSelect.replaceChildren();
        const choose = element("option");
        choose.value = "";
        choose.textContent = t("运行时选择文件夹");
        destinationSelect.append(choose);
        for (const saved of selection.destinations ?? []) {
            const option = element("option");
            option.value = saved.id;
            option.textContent = saved.name;
            option.disabled = !saved.available;
            option.title = saved.reason ? t(saved.reason) : saved.name;
            destinationSelect.append(option);
        }
        if (
            [...destinationSelect.options].some(
                (option) => option.value === previous && !option.disabled,
            )
        )
            destinationSelect.value = previous;
        destinationSelect.disabled = loading || Boolean(runningJobId);
        destinationRow.hidden =
            !selection.destinations?.length ||
            (mode === "actions" &&
                selectedAction !== "copy-to" &&
                selectedAction !== "move-to");
    };
    const copyOverLimit = (action: SourceAction | undefined, count: number) =>
        action === "copy" && count > selection.copyMaxFiles;
    const copyLimitMessage = () => t("Copy one file at a time on macOS.");

    const syncRunButton = () => {
        if (loading || runningJobId) {
            runButton.disabled = true;
            return;
        }
        if (mode === "actions") {
            const action = ACTIONS.find((item) => item.id === selectedAction);
            const eligible = action ? actionSourceIds(action).length : 0;
            runButton.disabled =
                !action ||
                eligible === 0 ||
                Boolean(action.single && eligible !== 1) ||
                copyOverLimit(action?.id, eligible);
            runButton.textContent = t("执行操作");
            return;
        }
        if (!selectedRecipe) {
            runButton.disabled = true;
            runButton.textContent = t("运行");
            return;
        }
        const eligible = compatibleSourceIds(selectedRecipe).length;
        runButton.disabled =
            !selectedRecipe.available ||
            eligible < (selectedRecipe.minSources ?? 1);
        runButton.textContent = t("开始处理");
    };

    const syncSourceDisclosure = () => {
        sourceList.hidden = !sourcesExpanded;
        sourceToggle.disabled = !selection.sources.length;
        sourceToggle.setAttribute("aria-expanded", String(sourcesExpanded));
        sourceToggle.title = t(
            sourcesExpanded ? "收起文件列表" : "展开文件列表",
        );
        sourceHeader.classList.toggle("collapsed", !sourcesExpanded);
    };
    sourceToggle.addEventListener("click", () => {
        sourcesExpanded = !sourcesExpanded;
        syncSourceDisclosure();
    });

    const renderSources = () => {
        sourceList.replaceChildren();
        for (const source of selection.sources) {
            const row = element("label", "file-tools-source-row");
            row.dataset.sourceId = source.id;
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = selectedSourceIds.has(source.id);
            const copy = element("span");
            const name = element("strong");
            name.textContent = source.name;
            const meta = element("small");
            meta.textContent = `${t(kindLabel(source))} · ${formatBytes(source.size)}`;
            copy.append(name, meta);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedSourceIds.add(source.id);
                else selectedSourceIds.delete(source.id);
                renderRecipes();
            });
            row.append(checkbox, copy);
            sourceList.append(row);
        }
        sourceToggle.textContent = t("文件 {selected}/{total}")
            .replace("{selected}", String(selectedCount()))
            .replace("{total}", String(selection.sources.length));
        syncSourceDisclosure();
        rejectedList.replaceChildren();
        for (const rejected of selection.rejected) {
            const row = element("p");
            row.textContent = `${rejected.name} · ${t(rejected.reason)}`;
            rejectedList.append(row);
        }
    };

    const recipeButtons = () =>
        Array.from(
            recipeList.querySelectorAll<HTMLButtonElement>(
                "button[data-recipe-id], button[data-source-action]",
            ),
        );

    const chooseRecipe = (recipe?: FileToolRecipe) => {
        selectedRecipe = recipe;
        selectedAction = undefined;
        renderRecipes();
        if (recipe) changeRecipeButton.focus();
        else recipeButtons()[0]?.focus();
    };
    changeRecipeButton.addEventListener("click", () => chooseRecipe());

    const chooseAction = (action?: SourceAction) => {
        selectedAction = action;
        selectedRecipe = undefined;
        renderRecipes();
    };

    const renderOptions = () => {
        optionsTitle.textContent = selectedRecipe
            ? t(selectedRecipe.label)
            : t("选项");
        optionGrid.replaceChildren();
        const recipe = selectedRecipe;
        if (!recipe) {
            optionsPane.hidden = true;
            return;
        }
        const controls: OptionId[] = [...(recipe.options ?? [])];
        if (recipe.formats?.length) {
            const field = element("label", "file-tools-field");
            const label = element("span");
            label.textContent = t("输出格式");
            const select = element("select");
            select.dataset.fileToolOption = "format";
            for (const format of recipe.formats) {
                const option = element("option");
                option.value = format;
                option.textContent = format.toUpperCase();
                select.append(option);
            }
            field.append(label, select);
            optionGrid.append(field);
        }
        for (const id of controls) {
            const config = OPTION_CONFIG[id];
            const field = element("label", "file-tools-field");
            const label = element("span");
            label.textContent = t(config.label);
            let control: HTMLInputElement | HTMLSelectElement;
            if (config.type === "select") {
                const select = element("select");
                for (const choice of config.choices ?? []) {
                    const option = element("option");
                    option.value = choice.value;
                    option.textContent = t(choice.label);
                    select.append(option);
                }
                control = select;
            } else {
                const input = element("input");
                input.type = config.type;
                if (config.min !== undefined) input.min = String(config.min);
                if (id === "angle" && selectedRecipe?.id !== "pdf-organize")
                    input.min = "90";
                if (config.max !== undefined) input.max = String(config.max);
                if (config.step !== undefined) input.step = String(config.step);
                control = input;
            }
            control.value =
                selectedRecipe?.id === "pdf-organize" && id === "angle"
                    ? "0"
                    : config.value;
            control.dataset.fileToolOption = id;
            field.append(label, control);
            optionGrid.append(field);
        }
        optionsPane.hidden = false;
    };

    const renderRecipes = () => {
        syncDestination();
        renderSources();
        recipePane.hidden = Boolean(selectedRecipe);
        recipeList.replaceChildren();
        if (mode === "actions") {
            for (const action of ACTIONS) {
                const eligible = actionSourceIds(action).length;
                const overCopyLimit = copyOverLimit(action.id, eligible);
                const button = element("button", "file-tools-recipe");
                button.type = "button";
                button.dataset.sourceAction = action.id;
                button.setAttribute(
                    "aria-selected",
                    String(selectedAction === action.id),
                );
                const copy = element("span");
                const label = element("strong");
                label.textContent = t(action.label);
                const detail = element("small");
                detail.textContent = [
                    t(action.detail),
                    selection.unavailableActions?.includes(action.id)
                        ? t("此操作在当前平台不可用")
                        : "",
                    t("{count} 个可处理").replace("{count}", String(eligible)),
                    action.single && eligible !== 1
                        ? t("请选择一个兼容文件")
                        : "",
                    overCopyLimit ? copyLimitMessage() : "",
                ]
                    .filter(Boolean)
                    .join(" · ");
                copy.append(label, detail);
                button.append(copy);
                button.disabled =
                    eligible === 0 ||
                    Boolean(action.single && eligible !== 1) ||
                    overCopyLimit ||
                    Boolean(selection.unavailableActions?.includes(action.id));
                button.addEventListener("click", () => chooseAction(action.id));
                recipeList.append(button);
            }
            recipeSummary.textContent = t("文件操作不会转换内容");
        } else {
            const recipes = selection.recipes.filter(
                (recipe) => recipe.group === mode,
            );
            for (const recipe of recipes) {
                const eligible = compatibleSourceIds(recipe).length;
                const incompatible = Math.max(0, selectedCount() - eligible);
                const button = element("button", "file-tools-recipe");
                button.type = "button";
                button.dataset.recipeId = recipe.id;
                button.setAttribute(
                    "aria-selected",
                    String(selectedRecipe?.id === recipe.id),
                );
                const copy = element("span");
                const label = element("strong");
                label.textContent = t(recipe.label);
                const detail = element("small");
                const counts = [
                    t("{count} 个可处理").replace("{count}", String(eligible)),
                    incompatible
                        ? t("{count} 个不兼容").replace(
                              "{count}",
                              String(incompatible),
                          )
                        : "",
                    recipe.reason ? localizedMessage(recipe.reason) : "",
                ].filter(Boolean);
                detail.textContent = counts.join(" · ");
                copy.append(label, detail);
                button.append(copy);
                button.disabled =
                    !recipe.available || eligible < (recipe.minSources ?? 1);
                button.addEventListener("click", () => chooseRecipe(recipe));
                recipeList.append(button);
            }
            recipeSummary.textContent = recipes.length
                ? t("仅会处理兼容的已选文件；不兼容项会保留在列表中")
                : t("当前选择没有可用的本机处理方式");
        }
        renderOptions();
        syncRunButton();
    };

    const setMode = (next: Mode) => {
        mode = next;
        selectedRecipe = undefined;
        selectedAction = undefined;
        for (const [id, button] of modeButtons)
            button.setAttribute("aria-selected", String(id === mode));
        renderRecipes();
        recipeButtons()[0]?.focus();
    };

    const renderResults = () => {
        resultSection.hidden = !results.length;
        resultList.replaceChildren();
        let success = 0;
        let failed = 0;
        for (const result of results) {
            if (result.status === "success") success++;
            if (result.status === "error") failed++;
            const row = element("article", "file-tools-result-row");
            row.dataset.resultStatus = result.status;
            const head = element("div");
            const name = element("strong");
            name.textContent = result.name;
            const status = element("span");
            status.textContent =
                result.status === "success"
                    ? t("完成")
                    : result.status === "cancelled"
                      ? t("已取消")
                      : t("失败");
            head.append(name, status);
            row.append(head);
            if (result.error) {
                const error = element("p", "error");
                error.textContent = t(result.error);
                row.append(error);
            }
            for (const warning of result.warnings ?? []) {
                const note = element("p");
                note.textContent = localizedMessage(warning);
                row.append(note);
            }
            for (const output of result.outputs) {
                const outputRow = element("div", "file-tools-output-row");
                const outputName = element("span");
                outputName.textContent = `${output.name} · ${formatBytes(output.size)}`;
                const actions = element("div", "file-tools-inline-actions");
                for (const [action, label] of [
                    ["reveal", "显示"],
                    ["copy", "复制"],
                    ["copy-path", "路径"],
                ] as const) {
                    const actionButton = element("button");
                    actionButton.type = "button";
                    actionButton.textContent = t(label);
                    actionButton.addEventListener("click", () => {
                        void api
                            ?.outputAction(output.id, action)
                            .then((ok) =>
                                setMessage(
                                    ok ? t("操作已完成") : t("操作未完成"),
                                    !ok,
                                ),
                            )
                            .catch((error) =>
                                setMessage(t(errorMessage(error)), true),
                            );
                    });
                    actions.append(actionButton);
                }
                const drag = element("button");
                drag.type = "button";
                drag.draggable = true;
                drag.dataset.outputId = output.id;
                drag.textContent = t("拖出");
                drag.title = t("按住并拖动以开始系统文件拖放");
                drag.addEventListener("dragstart", (event) => {
                    event.preventDefault();
                    void api
                        ?.outputAction(output.id, "drag")
                        .then((accepted) =>
                            setMessage(
                                accepted
                                    ? t("系统已接受拖放请求")
                                    : t("无法开始系统拖放"),
                                !accepted,
                            ),
                        )
                        .catch((error) =>
                            setMessage(t(errorMessage(error)), true),
                        );
                });
                actions.append(drag);
                outputRow.append(outputName, actions);
                row.append(outputRow);
            }
            resultList.append(row);
        }
        resultSummary.textContent = t("完成 {success} · 失败 {failed}")
            .replace("{success}", String(success))
            .replace("{failed}", String(failed));
        retryButton.hidden = failed === 0;
    };

    const readOptions = (): FileToolOptions | undefined => {
        const value: FileToolOptions = {};
        for (const control of optionGrid.querySelectorAll<
            HTMLInputElement | HTMLSelectElement
        >("[data-file-tool-option]")) {
            const id = control.dataset.fileToolOption as OptionId | "format";
            if (id === "format") {
                value.format = control.value;
                continue;
            }
            if (id === "pages") {
                value.pages = control.value.trim();
                continue;
            }
            if (id === "flip") {
                value.flip = control.value as "horizontal" | "vertical";
                continue;
            }
            if (id === "foldAxis") {
                value.foldAxis = control.value as "horizontal" | "vertical";
                continue;
            }
            if (
                control instanceof HTMLInputElement &&
                !control.checkValidity()
            ) {
                setMessage(t("请输入有效的选项值"), true);
                control.focus();
                return;
            }
            const number = Number(control.value);
            if (!Number.isFinite(number)) {
                setMessage(t("请输入有效的选项值"), true);
                control.focus();
                return;
            }
            if (id === "quality") value.quality = number / 100;
            else if (id === "volume") value.volume = number / 100;
            else if (id === "channels") value.channels = number;
            else value[id] = number;
        }
        if (
            value.start !== undefined &&
            value.end !== undefined &&
            value.end <= value.start
        ) {
            setMessage(t("结束时间必须晚于开始时间"), true);
            return;
        }
        return value;
    };

    const setRunning = (value: boolean) => {
        loading = value;
        destinationSelect.disabled = value;
        changeRecipeButton.disabled = value;
        if (value) {
            chooseButton.disabled = true;
            chooseFolderButton.disabled = true;
            for (const button of modeButtons.values()) button.disabled = true;
            for (const input of dialog.querySelectorAll<
                HTMLInputElement | HTMLSelectElement | HTMLButtonElement
            >("input, select, .file-tools-recipe"))
                input.disabled = true;
        } else {
            chooseButton.disabled = false;
            chooseFolderButton.disabled = false;
            for (const button of modeButtons.values()) button.disabled = false;
            renderRecipes();
        }
        cancelButton.textContent = value ? t("取消任务") : t("关闭");
        syncRunButton();
    };

    const runRecipe = async (
        recipe: FileToolRecipe,
        sourceIds: string[],
        options: FileToolOptions,
        destinationId: string | null = destinationSelect.value || null,
    ) => {
        if (!api || runningJobId || !sourceIds.length) return;
        const incompatible = selectedCount() - sourceIds.length;
        if (incompatible > 0)
            setMessage(
                t("将处理 {eligible} 个兼容文件；{incompatible} 个保持不变")
                    .replace("{eligible}", String(sourceIds.length))
                    .replace("{incompatible}", String(incompatible)),
            );
        else setMessage();
        runningJobId = crypto.randomUUID();
        runSnapshot = { recipe, options: { ...options }, destinationId };
        progressSection.hidden = false;
        progressBar.style.width = "0%";
        progressText.textContent = t("正在准备任务");
        setRunning(true);
        try {
            const next = await api.run({
                jobId: runningJobId,
                sourceIds,
                recipe: recipe.id,
                options,
                ...(destinationId ? { destinationId } : {}),
            });
            results = next;
            renderResults();
            resultSection.tabIndex = -1;
            queueMicrotask(() => {
                resultSection.scrollIntoView({ block: "nearest" });
                resultSection.focus();
            });
        } catch (error) {
            setMessage(t(errorMessage(error)), true);
        } finally {
            runningJobId = "";
            setRunning(false);
            progressSection.hidden = true;
        }
    };

    const runSelected = () => {
        if (!api || loading) return;
        if (mode === "actions") {
            const action = ACTIONS.find((item) => item.id === selectedAction);
            if (!action) return;
            const sourceIds = actionSourceIds(action);
            if (copyOverLimit(action.id, sourceIds.length)) {
                setMessage(copyLimitMessage(), true);
                return;
            }
            const incompatible = selectedCount() - sourceIds.length;
            runningJobId = crypto.randomUUID();
            progressSection.hidden = false;
            progressBar.style.width = "0%";
            progressText.textContent = t("正在准备任务");
            setRunning(true);
            void api
                .sourceAction(
                    sourceIds,
                    action.id,
                    runningJobId,
                    action.id === "copy-to" || action.id === "move-to"
                        ? destinationSelect.value || undefined
                        : undefined,
                )
                .then((outcome) => {
                    if (outcome.sources?.length) {
                        const updates = new Map(
                            outcome.sources.map((source) => [
                                source.id,
                                source,
                            ]),
                        );
                        selection.sources = selection.sources.map(
                            (source) => updates.get(source.id) ?? source,
                        );
                        renderSources();
                    }
                    const detail = [
                        outcome.message ? t(outcome.message) : "",
                        incompatible
                            ? t("{count} 个不兼容文件未处理").replace(
                                  "{count}",
                                  String(incompatible),
                              )
                            : "",
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    setMessage(
                        detail ||
                            (outcome.ok ? t("操作已完成") : t("操作未完成")),
                        !outcome.ok,
                    );
                })
                .catch((error) => setMessage(t(errorMessage(error)), true))
                .finally(() => {
                    runningJobId = "";
                    progressSection.hidden = true;
                    setRunning(false);
                    queueMicrotask(() =>
                        recipeList
                            .querySelector<HTMLElement>(
                                `[data-source-action="${action.id}"][aria-selected="true"]`,
                            )
                            ?.focus(),
                    );
                });
            return;
        }
        if (!selectedRecipe) return;
        const options = readOptions();
        if (!options) return;
        void runRecipe(
            selectedRecipe,
            compatibleSourceIds(selectedRecipe),
            options,
        );
    };

    const loadSelection = async (
        nextPaths?: string[],
        pickMode?: "files" | "folders",
    ) => {
        if (!api || loading) return;
        loading = true;
        chooseButton.disabled = true;
        chooseFolderButton.disabled = true;
        setMessage(t("正在检查本机可用功能"));
        try {
            const next = await api.select(nextPaths, pickMode);
            selection = next;
            sourcesExpanded = !next.sources.length;
            selectedSourceIds = new Set(
                next.sources.map((source) => source.id),
            );
            selectedRecipe = undefined;
            selectedAction = undefined;
            results = [];
            renderResults();
            setMessage();
            renderRecipes();
        } catch (error) {
            setMessage(t(errorMessage(error)), true);
        } finally {
            loading = false;
            chooseButton.disabled = false;
            chooseFolderButton.disabled = false;
            syncRunButton();
            syncDestination();
        }
    };

    const cancelJob = async () => {
        if (!api || !runningJobId) return;
        cancelButton.disabled = true;
        try {
            await api.cancel(runningJobId);
            setMessage(t("正在取消任务"));
        } catch (error) {
            setMessage(t(errorMessage(error)), true);
        } finally {
            cancelButton.disabled = false;
        }
    };

    const close = () => {
        if (closed) return;
        if (runningJobId) {
            void cancelJob();
            return;
        }
        closed = true;
        unsubscribeProgress?.();
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
        if (opener?.isConnected) opener.focus();
    };

    const focusable = () =>
        Array.from(
            dialog.querySelectorAll<HTMLElement>(
                "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
            ),
        ).filter((node) => !node.hidden && node.getClientRects().length > 0);

    const editable = (target: EventTarget | null) =>
        target instanceof HTMLElement &&
        (target.isContentEditable || target.matches("input, select, textarea"));

    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
            return;
        }
        if (event.key === "Tab") {
            const nodes = focusable();
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            if (
                index < 0 ||
                (!event.shiftKey && index === nodes.length - 1) ||
                (event.shiftKey && index === 0)
            ) {
                event.preventDefault();
                nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus();
            }
            return;
        }
        if (editable(event.target) || event.repeat) return;
        if (event.altKey && ["1", "2", "3"].includes(event.key)) {
            event.preventDefault();
            setMode(
                ({ "1": "convert", "2": "tools", "3": "actions" } as const)[
                    event.key as "1" | "2" | "3"
                ],
            );
            return;
        }
        if (
            ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(
                event.key,
            ) &&
            document.activeElement?.closest(".file-tools-recipe-list")
        ) {
            const buttons = recipeButtons().filter(
                (button) => !button.disabled,
            );
            const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
            );
            const step =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                    ? 1
                    : -1;
            event.preventDefault();
            buttons[
                (current + step + buttons.length) % buttons.length
            ]?.focus();
        }
    };

    for (const [id, button] of modeButtons)
        button.addEventListener("click", () => setMode(id));
    chooseButton.addEventListener(
        "click",
        () => void loadSelection(undefined, "files"),
    );
    chooseFolderButton.addEventListener(
        "click",
        () => void loadSelection(undefined, "folders"),
    );
    runButton.addEventListener("click", runSelected);
    retryButton.addEventListener("click", () => {
        if (!runSnapshot || runningJobId) return;
        const failed = new Set(
            results
                .filter((result) => result.status === "error")
                .map((result) => result.sourceId),
        );
        const compatible = new Set(compatibleSourceIds(runSnapshot.recipe));
        const sourceIds = [...failed].filter((id) => compatible.has(id));
        void runRecipe(
            runSnapshot.recipe,
            sourceIds,
            runSnapshot.options,
            runSnapshot.destinationId,
        );
    });
    cancelButton.addEventListener("click", close);
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey, true);

    const unsubscribeProgress = api?.onProgress((progress) => {
        if (progress.jobId !== runningJobId || closed) return;
        progressSection.hidden = false;
        const percent = Math.min(100, Math.max(0, progress.percent));
        progressBar.style.width = `${percent}%`;
        progressText.textContent = t(
            "已处理 {completed} / {total} · {percent}%",
        )
            .replace("{completed}", String(progress.completed))
            .replace("{total}", String(progress.total))
            .replace("{percent}", String(Math.round(percent)));
    });

    if (!api) {
        setMessage(t("文件工具服务不可用"), true);
        chooseButton.disabled = true;
        chooseFolderButton.disabled = true;
        runButton.disabled = true;
    } else void loadSelection(paths);
    queueMicrotask(() => chooseButton.focus());
    return close;
}
