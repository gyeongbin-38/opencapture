import { ele } from "dkh-ui";
import type {
    CaptureConvertFormat,
    CaptureConvertOptions,
    CaptureConvertOutput,
    CaptureConvertPreview,
    CaptureDragAcknowledgement,
    CaptureRegistrationOutcome,
} from "../../../lib/openCaptureTypes";
import { t } from "../dashboard/t";

export interface ConvertTarget {
    id?: string;
    path: string;
    name?: string;
    file?: File;
}

export interface ConvertApi {
    convertItem?(
        id: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertOutput>;
    convertPath?(
        path: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertOutput>;
    previewItem?(
        id: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertPreview>;
    previewPath?(
        path: string,
        format: CaptureConvertFormat,
        data?: Uint8Array,
        options?: CaptureConvertOptions,
    ): Promise<CaptureConvertPreview>;
    getItemFile?(id: string): Promise<Uint8Array>;
    readFilePath?(path: string): Promise<Uint8Array>;
    registerConvertedPaths?(
        paths: string[],
    ): Promise<CaptureRegistrationOutcome[]>;
    dragConvertedPath?(path: string): Promise<CaptureDragAcknowledgement>;
    revealPath?(path: string): Promise<boolean>;
}

export type ConvertRowStatus =
    | "pending"
    | "converting"
    | "written"
    | "skipped"
    | "failed"
    | "cancelled";

export interface ConvertResultRow {
    index: number;
    target: ConvertTarget;
    status: ConvertRowStatus;
    output?: CaptureConvertOutput;
    error?: string;
    registration?: CaptureRegistrationOutcome;
}

export interface ConvertResult {
    written: string[];
    bytes: number;
    failed: { target: ConvertTarget; error: string }[];
    skipped: number;
    cancelled: boolean;
    format: CaptureConvertFormat | undefined;
    rows: ConvertResultRow[];
    registration: CaptureRegistrationOutcome[];
}

export const CONVERT_FORMATS: CaptureConvertFormat[] = [
    "png",
    "jpg",
    "webp",
    "avif",
    "bmp",
    "ico",
    "gif",
    "pdf",
];

const SETTINGS_KEY = "oc:convert-settings-v2";
const PRESETS_KEY = "oc:convert-named-presets-v1";
const OPTIONS_OPEN_KEY = "oc:convert-options-open";
const MAX_PRESETS = 12;
const MAX_PRESET_NAME = 32;
const MAX_SIGNATURE = 80;
const MAX_WIDTH = 16_384;
const MAX_RENDERER_BYTES = 128 * 1024 * 1024;
const MAX_RENDERER_PIXELS = 100_000_000;

type StoredSettings = {
    format: CaptureConvertFormat;
    scale: number;
    quality: number;
    maxWidth: number;
    background: string;
    namePattern: string;
    signature: string;
    register: boolean;
};

type OperationSettings = {
    format: CaptureConvertFormat;
    options: CaptureConvertOptions;
    signature: string;
    register: boolean;
};

type NamedPreset = { name: string; settings: StoredSettings };

const DEFAULT_SETTINGS: StoredSettings = {
    format: "png",
    scale: 1,
    quality: 0.92,
    maxWidth: 0,
    background: "",
    namePattern: "{name}",
    signature: "",
    register: false,
};

const BUILTIN_PRESETS: NamedPreset[] = [
    {
        name: "文档",
        settings: {
            ...DEFAULT_SETTINGS,
            format: "png",
            maxWidth: 2560,
            background: "#ffffff",
        },
    },
    {
        name: "网页分享",
        settings: {
            ...DEFAULT_SETTINGS,
            format: "webp",
            quality: 0.82,
            maxWidth: 1920,
        },
    },
];

const errorMessage = (error: unknown) =>
    error instanceof Error
        ? error.message.replace(/^Error:\s*/i, "")
        : String(error);

const fileName = (target: ConvertTarget) =>
    target.name || target.path.split(/[\\/]/).pop() || target.path;

const pathName = (path: string) => path.split(/[\\/]/).pop() || path;

const sourceExtension = (target: ConvertTarget) => {
    if (target.file?.type === "image/svg+xml") return "svg";
    if (target.file?.type === "image/avif") return "avif";
    return (target.file?.name || target.name || target.path)
        .split(".")
        .pop()
        ?.toLowerCase();
};

const formatBytes = (bytes?: number) => {
    if (!Number.isFinite(bytes)) return t("大小未知");
    if ((bytes ?? 0) < 1024) return `${bytes} B`;
    if ((bytes ?? 0) < 1024 * 1024)
        return `${((bytes ?? 0) / 1024).toFixed(1)} KB`;
    return `${((bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;
};

const validColor = (value: unknown) =>
    typeof value === "string" &&
    (value === "" || /^#[0-9a-f]{6}$/i.test(value));

const cleanSettings = (
    value: unknown,
    fallbackRegister: boolean,
): StoredSettings => {
    const data =
        value && typeof value === "object"
            ? (value as Partial<StoredSettings>)
            : {};
    return {
        format: CONVERT_FORMATS.includes(data.format as CaptureConvertFormat)
            ? (data.format as CaptureConvertFormat)
            : DEFAULT_SETTINGS.format,
        scale:
            typeof data.scale === "number" &&
            Number.isFinite(data.scale) &&
            data.scale >= 0.1 &&
            data.scale <= 1
                ? data.scale
                : DEFAULT_SETTINGS.scale,
        quality:
            typeof data.quality === "number" &&
            Number.isFinite(data.quality) &&
            data.quality >= 0.1 &&
            data.quality <= 1
                ? data.quality
                : DEFAULT_SETTINGS.quality,
        maxWidth:
            typeof data.maxWidth === "number" &&
            Number.isInteger(data.maxWidth) &&
            data.maxWidth >= 0 &&
            data.maxWidth <= MAX_WIDTH
                ? data.maxWidth
                : 0,
        background: validColor(data.background) ? data.background! : "",
        namePattern:
            typeof data.namePattern === "string" &&
            data.namePattern.length > 0 &&
            data.namePattern.length <= 80
                ? data.namePattern
                : "{name}",
        signature:
            typeof data.signature === "string"
                ? data.signature.slice(0, MAX_SIGNATURE)
                : "",
        register:
            typeof data.register === "boolean"
                ? data.register
                : fallbackRegister,
    };
};

const readJson = (key: string): unknown => {
    try {
        return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
        return null;
    }
};

const readNamedPresets = (): NamedPreset[] => {
    const raw = readJson(PRESETS_KEY);
    if (!Array.isArray(raw)) return [];
    const names = new Set<string>();
    const result: NamedPreset[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const candidate = item as Partial<NamedPreset>;
        const name =
            typeof candidate.name === "string"
                ? candidate.name.trim().slice(0, MAX_PRESET_NAME)
                : "";
        if (!name || names.has(name)) continue;
        names.add(name);
        result.push({
            name,
            settings: cleanSettings(candidate.settings, false),
        });
        if (result.length === MAX_PRESETS) break;
    }
    return result;
};

const writeStorage = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage is optional in restricted renderer profiles.
    }
};

async function sourceBytes(target: ConvertTarget, api: ConvertApi) {
    const bytes = target.id
        ? await api.getItemFile?.(target.id)
        : target.file
          ? new Uint8Array(await target.file.arrayBuffer())
          : await api.readFilePath?.(target.path);
    if (!bytes?.length) throw new Error(t("无法读取源文件"));
    if (bytes.byteLength > MAX_RENDERER_BYTES)
        throw new Error(t("源文件过大，无法在预览中处理"));
    return bytes;
}

async function bitmapFromBytes(
    bytes: Uint8Array,
    sourceType?: string,
): Promise<ImageBitmap> {
    try {
        return await createImageBitmap(
            new Blob([bytes as BlobPart], { type: sourceType }),
        );
    } catch {
        const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: sourceType }),
        );
        try {
            const image = new Image();
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error(t("无法解码图像")));
                image.src = url;
            });
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            if (!context || !canvas.width || !canvas.height)
                throw new Error(t("无法解码图像"));
            context.drawImage(image, 0, 0);
            return createImageBitmap(canvas);
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}

async function canvasPrepare(
    bytes: Uint8Array,
    settings: OperationSettings,
    mime: "image/png" | "image/webp" | "image/avif",
    sourceType?: string,
) {
    const bitmap = await bitmapFromBytes(bytes, sourceType);
    try {
        if (
            !bitmap.width ||
            !bitmap.height ||
            bitmap.width * bitmap.height > MAX_RENDERER_PIXELS
        )
            throw new Error(t("图像尺寸过大，无法在预览中处理"));
        const widthScale = settings.options.maxWidth
            ? Math.min(1, settings.options.maxWidth / bitmap.width)
            : 1;
        const scale = Math.min(
            widthScale,
            settings.options.scale ?? DEFAULT_SETTINGS.scale,
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error(t("无法准备图像"));
        if (settings.options.background) {
            context.fillStyle = settings.options.background;
            context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (settings.signature) {
            const base = Math.min(canvas.width, canvas.height);
            const padding = Math.max(8, Math.round(base * 0.025));
            const size = Math.max(12, Math.round(base * 0.045));
            const x = canvas.width - padding;
            const y = canvas.height - padding;
            context.font = `600 ${size}px system-ui, sans-serif`;
            context.textAlign = "right";
            context.textBaseline = "bottom";
            context.globalAlpha = 0.85;
            context.lineWidth = Math.max(2, size / 8);
            context.strokeStyle = "rgba(0,0,0,0.55)";
            context.strokeText(settings.signature, x, y);
            context.fillStyle = "#ffffff";
            context.fillText(settings.signature, x, y);
        }
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (value) =>
                    value
                        ? resolve(value)
                        : reject(new Error(t("当前环境不支持所选格式"))),
                mime,
                settings.options.quality ?? DEFAULT_SETTINGS.quality,
            ),
        );
        if (mime !== "image/png" && blob.type !== mime)
            throw new Error(t("当前环境不支持所选格式"));
        return {
            data: new Uint8Array(await blob.arrayBuffer()),
            encodedSize: { width: canvas.width, height: canvas.height },
        };
    } finally {
        bitmap.close();
    }
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
) {
    const node = ele(tag).el as HTMLElementTagNameMap[K];
    if (className) node.className = className;
    return node;
}

export function openConvertDonut(options: {
    point: { x: number; y: number };
    targets: ConvertTarget[];
    api: ConvertApi;
    onDone?: (result: ConvertResult) => void;
    onError?: (message: string) => void;
    extraActions?: { label: string; hint?: string; run: () => void }[];
    presets?: boolean;
    register?: boolean;
}): () => void {
    const { targets, api } = options;
    if (!targets.length) {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            options.onDone?.({
                written: [],
                bytes: 0,
                failed: [],
                skipped: 0,
                cancelled: true,
                format: undefined,
                rows: [],
                registration: [],
            });
        };
        queueMicrotask(finish);
        return finish;
    }
    const rows: ConvertResultRow[] = targets.map((target, index) => ({
        index,
        target,
        status: "pending",
    }));
    const opener =
        document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
    let settings = cleanSettings(
        readJson(SETTINGS_KEY) ?? readJson("oc:convert-preset"),
        Boolean(options.register),
    );
    if (!api.registerConvertedPaths) settings.register = false;
    const namedPresets = readNamedPresets();
    let operationSnapshot: OperationSettings | undefined;
    let activeRows: ConvertResultRow[] = [];
    let previewToken = 0;
    let operationToken = 0;
    let previewTimer = 0;
    let previewUrl = "";
    let sourcePreviewUrl = "";
    let previewView: "source" | "result" = "result";
    let firstSourceBytes: Promise<Uint8Array> | undefined;
    let busy = false;
    let closed = false;
    let settled = false;
    let operationCancelled = false;
    let conversionPromisePending = false;
    let dragOutput: CaptureConvertOutput | undefined;
    let dragState: "idle" | "preparing" | "ready" | "error" = "idle";
    let dragPromisePending = false;

    const backdrop = element("div", "convert-donut-backdrop");
    const dialog = element("section", "convert-donut");
    dialog.dataset.convertDialog = "";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "convert-dialog-title");
    dialog.tabIndex = -1;
    backdrop.append(dialog);
    document.body.append(backdrop);

    const header = element("header", "convert-donut-header");
    const heading = element("div");
    const title = element("h2");
    title.id = "convert-dialog-title";
    title.textContent = t("转换图像");
    const subtitle = element("p");
    subtitle.textContent = t("先预览结果，再保存文件");
    heading.append(title, subtitle);
    const closeButton = element("button", "convert-donut-icon-button");
    closeButton.type = "button";
    closeButton.dataset.convertAction = "close";
    closeButton.textContent = t("关闭");
    header.append(heading, closeButton);

    const body = element("div", "convert-donut-body");
    const controls = element("div", "convert-donut-controls");
    const formatField = element("label", "convert-donut-field");
    const formatLabel = element("span");
    formatLabel.textContent = t("输出格式");
    const formatSelect = element("select");
    formatSelect.dataset.convertFormat = "";
    for (const format of CONVERT_FORMATS) {
        const option = element("option");
        option.value = format;
        option.textContent = format.toUpperCase();
        formatSelect.append(option);
    }
    formatSelect.value = settings.format;
    formatField.append(formatLabel, formatSelect);
    controls.append(formatField);

    const presetField = element("label", "convert-donut-field");
    const presetLabel = element("span");
    presetLabel.textContent = t("预设");
    const presetSelect = element("select");
    presetSelect.dataset.convertPreset = "";
    presetField.append(presetLabel, presetSelect);
    if (options.presets !== false) controls.append(presetField);

    const preview = element("section", "convert-donut-preview");
    preview.dataset.convertPreview = "";
    preview.dataset.convertPreviewView = previewView;
    const previewVisual = element("div", "convert-donut-preview-visual");
    const previewTabs = element("div", "convert-donut-preview-tabs");
    const sourceTab = element("button");
    sourceTab.type = "button";
    sourceTab.dataset.convertPreviewTab = "source";
    sourceTab.textContent = t("原图");
    sourceTab.setAttribute("aria-pressed", "false");
    const resultTab = element("button");
    resultTab.type = "button";
    resultTab.dataset.convertPreviewTab = "result";
    resultTab.textContent = t("结果");
    resultTab.setAttribute("aria-pressed", "true");
    previewTabs.append(sourceTab, resultTab);
    const previewImage = element("img");
    previewImage.dataset.convertPreviewImage = "";
    previewImage.alt = t("转换结果预览");
    previewImage.hidden = true;
    const previewPlaceholder = element("span");
    previewPlaceholder.textContent = t("正在准备预览");
    previewVisual.append(previewTabs, previewImage, previewPlaceholder);
    const previewMeta = element("div", "convert-donut-preview-meta");
    const sourceMeta = element("div");
    const sourceLabel = element("span");
    sourceLabel.textContent = t("原文件");
    const sourceValue = element("strong");
    sourceMeta.append(sourceLabel, sourceValue);
    const resultMeta = element("div");
    const resultLabel = element("span");
    resultLabel.textContent = t("转换结果");
    const resultValue = element("strong");
    const resultDetail = element("small");
    resultMeta.append(resultLabel, resultValue, resultDetail);
    const previewStatus = element("p", "convert-donut-status");
    previewStatus.dataset.convertPreviewStatus = "";
    previewStatus.setAttribute("role", "status");
    previewMeta.append(sourceMeta, resultMeta, previewStatus);
    preview.append(previewVisual, previewMeta);

    const details = element("details", "convert-donut-options");
    details.dataset.convertOptions = "";
    try {
        details.open = localStorage.getItem(OPTIONS_OPEN_KEY) === "1";
    } catch {
        details.open = false;
    }
    const summary = element("summary");
    summary.textContent = t("选项");
    const optionGrid = element("div", "convert-donut-option-grid");
    details.append(summary, optionGrid);

    const addField = (
        labelText: string,
        input: HTMLInputElement,
        help?: string,
    ) => {
        const field = element("label", "convert-donut-field");
        const label = element("span");
        label.textContent = labelText;
        field.append(label, input);
        if (help) {
            const hint = element("small");
            hint.textContent = help;
            field.append(hint);
        }
        optionGrid.append(field);
        return field;
    };
    const qualityInput = element("input");
    qualityInput.dataset.convertOption = "quality";
    qualityInput.type = "number";
    qualityInput.min = "10";
    qualityInput.max = "100";
    qualityInput.value = String(Math.round(settings.quality * 100));
    const qualityField = addField(
        t("质量（百分比）"),
        qualityInput,
        t("仅用于 JPG、WebP 和 AVIF"),
    );
    const scaleInput = element("input");
    scaleInput.dataset.convertOption = "scale";
    scaleInput.type = "number";
    scaleInput.min = "10";
    scaleInput.max = "100";
    scaleInput.step = "1";
    scaleInput.value = String(Math.round(settings.scale * 100));
    addField(t("缩放比例（百分比）"), scaleInput, t("100 保留原始尺寸"));
    const widthInput = element("input");
    widthInput.dataset.convertOption = "max-width";
    widthInput.type = "number";
    widthInput.min = "0";
    widthInput.max = String(MAX_WIDTH);
    widthInput.value = String(settings.maxWidth);
    addField(t("最大宽度（像素）"), widthInput, t("输入 0 保留原始宽度"));
    const backgroundInput = element("input");
    backgroundInput.dataset.convertOption = "background";
    backgroundInput.type = "text";
    backgroundInput.placeholder = "#ffffff";
    backgroundInput.maxLength = 7;
    backgroundInput.value = settings.background;
    addField(t("背景颜色"), backgroundInput, t("留空保留透明背景"));
    const signatureInput = element("input");
    signatureInput.dataset.convertOption = "signature";
    signatureInput.type = "text";
    signatureInput.maxLength = MAX_SIGNATURE;
    signatureInput.value = settings.signature;
    addField(t("签名"), signatureInput, t("留空时不添加签名"));
    const nameInput = element("input");
    nameInput.dataset.convertOption = "name-pattern";
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.value = settings.namePattern;
    addField(t("文件名规则"), nameInput, "{name} · {wxh} · {date}");

    const registerField = element("label", "convert-donut-check");
    const registerInput = element("input");
    registerInput.dataset.convertOption = "register";
    registerInput.type = "checkbox";
    registerInput.checked = settings.register;
    registerInput.disabled = !api.registerConvertedPaths;
    const registerText = element("span");
    registerText.textContent = t("保存后添加到图库");
    registerField.append(registerInput, registerText);
    optionGrid.append(registerField);

    const presetEditor = element("div", "convert-donut-preset-editor");
    const presetName = element("input");
    presetName.dataset.convertPresetName = "";
    presetName.type = "text";
    presetName.maxLength = MAX_PRESET_NAME;
    presetName.placeholder = t("预设名称");
    const savePreset = element("button");
    savePreset.dataset.convertAction = "save-preset";
    savePreset.type = "button";
    savePreset.textContent = t("保存预设");
    const deletePreset = element("button");
    deletePreset.dataset.convertAction = "delete-preset";
    deletePreset.type = "button";
    deletePreset.textContent = t("删除预设");
    presetEditor.append(presetName, savePreset, deletePreset);
    if (options.presets !== false) optionGrid.append(presetEditor);

    const results = element("section", "convert-donut-results");
    results.dataset.convertResults = "";
    results.hidden = true;
    const resultsHeader = element("div", "convert-donut-results-header");
    const resultsTitle = element("h3");
    resultsTitle.textContent = t("处理结果");
    const resultsSummary = element("span");
    resultsHeader.append(resultsTitle, resultsSummary);
    const resultList = element("ol");
    results.append(resultsHeader, resultList);

    const dragPanel = element("section", "convert-donut-drag");
    dragPanel.hidden = targets.length !== 1 || !api.dragConvertedPath;
    const dragStatus = element("p");
    dragStatus.dataset.dragStatus = "idle";
    dragStatus.textContent = t("需要时可先准备拖放文件");
    const dragActions = element("div", "convert-donut-inline-actions");
    const prepareDrag = element("button");
    prepareDrag.type = "button";
    prepareDrag.dataset.convertAction = "prepare-drag";
    prepareDrag.textContent = t("准备拖放");
    const dispatchDrag = element("button", "primary");
    dispatchDrag.type = "button";
    dispatchDrag.dataset.convertAction = "dispatch-drag";
    dispatchDrag.textContent = t("开始系统拖放");
    dispatchDrag.hidden = true;
    const cancelDrag = element("button");
    cancelDrag.type = "button";
    cancelDrag.dataset.convertAction = "cancel-drag";
    cancelDrag.textContent = t("取消准备");
    cancelDrag.hidden = true;
    dragActions.append(prepareDrag, dispatchDrag, cancelDrag);
    dragPanel.append(dragStatus, dragActions);
    details.append(dragPanel);

    const errorBox = element("p", "convert-donut-error");
    errorBox.setAttribute("role", "alert");
    errorBox.hidden = true;
    const footer = element("footer", "convert-donut-footer");
    const footerSecondary = element("div", "convert-donut-inline-actions");
    for (const action of options.extraActions ?? []) {
        const extra = element("button");
        extra.type = "button";
        extra.textContent = action.label;
        extra.title = action.hint ?? action.label;
        extra.addEventListener("click", () => {
            if (busy || closed) return;
            dismiss();
            action.run();
        });
        footerSecondary.append(extra);
    }
    const retryConvert = element("button");
    retryConvert.type = "button";
    retryConvert.dataset.convertAction = "retry-convert";
    retryConvert.textContent = t("重试失败的文件");
    retryConvert.hidden = true;
    const retryRegistration = element("button");
    retryRegistration.type = "button";
    retryRegistration.dataset.convertAction = "retry-registration";
    retryRegistration.textContent = t("重试图库添加");
    retryRegistration.hidden = true;
    footerSecondary.append(retryConvert, retryRegistration);
    const footerPrimary = element("div", "convert-donut-inline-actions");
    const cancelButton = element("button");
    cancelButton.type = "button";
    cancelButton.dataset.convertAction = "cancel";
    cancelButton.textContent = t("取消");
    const convertButton = element("button", "primary");
    convertButton.type = "button";
    convertButton.dataset.convertAction = "convert";
    convertButton.textContent = t("转换");
    footerPrimary.append(cancelButton, convertButton);
    footer.append(footerSecondary, footerPrimary);
    body.append(controls, preview, details, results, errorBox);
    dialog.append(header, body, footer);

    const setError = (message = "") => {
        errorBox.hidden = !message;
        errorBox.textContent = message;
        if (message) options.onError?.(message);
    };

    const readControls = (): StoredSettings | undefined => {
        const quality = Number(qualityInput.value);
        const scale = Number(scaleInput.value);
        const maxWidth = Number(widthInput.value);
        const background = backgroundInput.value.trim();
        const namePattern = nameInput.value.trim();
        if (!Number.isFinite(quality) || quality < 10 || quality > 100) {
            setError(t("质量必须在 10 到 100 之间"));
            return;
        }
        if (!Number.isFinite(scale) || scale < 10 || scale > 100) {
            setError(t("缩放比例必须在 10 到 100 之间"));
            return;
        }
        if (
            !Number.isInteger(maxWidth) ||
            maxWidth < 0 ||
            maxWidth > MAX_WIDTH
        ) {
            setError(t("最大宽度必须是 0 到 16384 之间的整数"));
            return;
        }
        if (!validColor(background)) {
            setError(t("背景颜色需要使用 #RRGGBB 格式"));
            return;
        }
        if (!namePattern || namePattern.length > 80) {
            setError(t("请输入有效的文件名规则"));
            return;
        }
        setError();
        return {
            format: formatSelect.value as CaptureConvertFormat,
            scale: scale / 100,
            quality: quality / 100,
            maxWidth,
            background,
            namePattern,
            signature: signatureInput.value.trim().slice(0, MAX_SIGNATURE),
            register: registerInput.checked && !registerInput.disabled,
        };
    };

    const snapshot = (): OperationSettings | undefined => {
        const next = readControls();
        if (!next) return;
        settings = next;
        writeStorage(SETTINGS_KEY, settings);
        return {
            format: next.format,
            options: {
                ...(next.scale !== DEFAULT_SETTINGS.scale
                    ? { scale: next.scale }
                    : {}),
                ...(["jpg", "webp", "avif"].includes(next.format) &&
                next.quality !== DEFAULT_SETTINGS.quality
                    ? { quality: next.quality }
                    : {}),
                ...(next.maxWidth ? { maxWidth: next.maxWidth } : {}),
                ...(next.background ? { background: next.background } : {}),
                ...(next.namePattern !== "{name}"
                    ? { namePattern: next.namePattern }
                    : {}),
            },
            signature: next.signature,
            register: next.register,
        };
    };

    const syncFormatFields = () => {
        const relevant = ["jpg", "webp", "avif"].includes(formatSelect.value);
        qualityInput.disabled = !relevant;
        qualityField.classList.toggle("disabled", !relevant);
    };

    const applySettings = (next: StoredSettings) => {
        settings = cleanSettings(next, Boolean(options.register));
        if (!api.registerConvertedPaths) settings.register = false;
        formatSelect.value = settings.format;
        scaleInput.value = String(Math.round(settings.scale * 100));
        qualityInput.value = String(Math.round(settings.quality * 100));
        widthInput.value = String(settings.maxWidth);
        backgroundInput.value = settings.background;
        signatureInput.value = settings.signature;
        nameInput.value = settings.namePattern;
        registerInput.checked = settings.register;
        writeStorage(SETTINGS_KEY, settings);
        syncFormatFields();
        schedulePreview();
    };

    const renderPresetOptions = () => {
        presetSelect.replaceChildren();
        const placeholder = element("option");
        placeholder.value = "";
        placeholder.textContent = t("选择预设");
        presetSelect.append(placeholder);
        for (const [index, preset] of BUILTIN_PRESETS.entries()) {
            const option = element("option");
            option.value = `builtin:${index}`;
            option.textContent = t(preset.name);
            presetSelect.append(option);
        }
        for (const [index, preset] of namedPresets.entries()) {
            const option = element("option");
            option.value = `local:${index}`;
            option.textContent = preset.name;
            presetSelect.append(option);
        }
        deletePreset.disabled = true;
    };

    const showPreviewView = (view: "source" | "result") => {
        previewView = view;
        preview.dataset.convertPreviewView = view;
        sourceTab.setAttribute("aria-pressed", String(view === "source"));
        resultTab.setAttribute("aria-pressed", String(view === "result"));
        const url = view === "source" ? sourcePreviewUrl : previewUrl;
        previewImage.alt =
            view === "source" ? t("原图预览") : t("转换结果预览");
        if (url) {
            previewImage.src = url;
            previewImage.hidden = false;
            previewPlaceholder.hidden = true;
        } else {
            previewImage.removeAttribute("src");
            previewImage.hidden = true;
            previewPlaceholder.hidden = false;
            previewPlaceholder.textContent =
                view === "source" ? t("正在读取原图") : t("正在准备预览");
        }
    };

    const revokePreview = () => {
        if (!previewUrl) return;
        if (previewView === "result") previewImage.removeAttribute("src");
        URL.revokeObjectURL(previewUrl);
        previewUrl = "";
    };

    const revokeSourcePreview = () => {
        if (!sourcePreviewUrl) return;
        if (previewView === "source") previewImage.removeAttribute("src");
        URL.revokeObjectURL(sourcePreviewUrl);
        sourcePreviewUrl = "";
    };

    const getSourceBytes = (target: ConvertTarget) => {
        if (target !== targets[0]) return sourceBytes(target, api);
        firstSourceBytes ??= sourceBytes(target, api);
        return firstSourceBytes;
    };

    const sourceMime = (target: ConvertTarget) => {
        if (target.file?.type) return target.file.type;
        const extension = sourceExtension(target);
        if (extension === "svg") return "image/svg+xml";
        if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
        if (extension === "avif") return "image/avif";
        return extension ? `image/${extension}` : "application/octet-stream";
    };

    const prepareData = async (
        target: ConvertTarget,
        frozen: OperationSettings,
    ): Promise<{ data?: Uint8Array; extra?: CaptureConvertOptions }> => {
        if (frozen.format === "webp" || frozen.format === "avif") {
            const prepared = await canvasPrepare(
                await getSourceBytes(target),
                frozen,
                frozen.format === "avif" ? "image/avif" : "image/webp",
                sourceMime(target),
            );
            return {
                data: prepared.data,
                extra: { encodedSize: prepared.encodedSize },
            };
        }
        if (
            frozen.signature ||
            ["svg", "avif"].includes(sourceExtension(target) ?? "")
        ) {
            const prepared = await canvasPrepare(
                await getSourceBytes(target),
                { ...frozen, options: {} },
                "image/png",
                sourceMime(target),
            );
            return {
                data: prepared.data,
                extra: {
                    pngData: true,
                    encodedSize: prepared.encodedSize,
                },
            };
        }
        return {};
    };

    const callPreview = async (
        target: ConvertTarget,
        frozen: OperationSettings,
    ) => {
        const call = target.id ? api.previewItem : api.previewPath;
        if (!call) throw new Error(t("此页面暂不支持转换预览"));
        const prepared = await prepareData(target, frozen);
        return call(target.id ?? target.path, frozen.format, prepared.data, {
            ...frozen.options,
            ...prepared.extra,
        });
    };

    const schedulePreview = () => {
        window.clearTimeout(previewTimer);
        const frozen = snapshot();
        if (!frozen || busy || closed || !targets[0]) return;
        const token = ++previewToken;
        previewStatus.textContent = t("正在准备预览");
        previewTimer = window.setTimeout(() => {
            void callPreview(targets[0], frozen)
                .then((value) => {
                    if (closed || token !== previewToken) return;
                    revokePreview();
                    previewUrl = URL.createObjectURL(
                        new Blob([value.data as BlobPart], {
                            type: value.previewMime,
                        }),
                    );
                    if (previewView === "result") showPreviewView("result");
                    resultValue.textContent = `${value.width} × ${value.height}`;
                    resultDetail.textContent = `${frozen.format.toUpperCase()} · ${value.outputBytes === undefined ? t("最终大小在保存后显示") : formatBytes(value.outputBytes)}${value.approximate ? ` · ${t("预览为近似效果")}` : ""}`;
                    previewStatus.textContent = t("预览已更新，尚未写入文件");
                })
                .catch((error) => {
                    if (closed || token !== previewToken) return;
                    revokePreview();
                    if (previewView === "result") {
                        previewImage.hidden = true;
                        previewPlaceholder.hidden = false;
                        previewPlaceholder.textContent = t("无法显示预览");
                    }
                    previewStatus.textContent = t(errorMessage(error));
                });
        }, 120);
    };

    const isSameFormatNoOp = (
        row: ConvertResultRow,
        frozen: OperationSettings,
    ) => {
        const extension = row.target.path.split(".").pop()?.toLowerCase();
        const sameFormat =
            extension === frozen.format ||
            (extension === "jpeg" && frozen.format === "jpg");
        return (
            sameFormat &&
            !frozen.signature &&
            Object.keys(frozen.options).length === 0
        );
    };

    const convertOne = async (
        row: ConvertResultRow,
        frozen: OperationSettings,
        token: number,
    ) => {
        if (closed || token !== operationToken)
            throw new DOMException("Aborted", "AbortError");
        const prepared = await prepareData(row.target, frozen);
        if (closed || token !== operationToken)
            throw new DOMException("Aborted", "AbortError");
        const call = row.target.id ? api.convertItem : api.convertPath;
        if (!call) throw new Error(t("此页面暂不支持转换"));
        return call(
            row.target.id ?? row.target.path,
            frozen.format,
            prepared.data,
            { ...frozen.options, ...prepared.extra },
        );
    };

    const rowStatus = (row: ConvertResultRow) => {
        if (row.status === "pending") return t("等待中");
        if (row.status === "converting") return t("转换中");
        if (row.status === "cancelled") return t("已取消");
        if (row.status === "skipped") return t("无需转换");
        if (row.status === "failed") return t("转换失败");
        if (!row.registration) return t("已保存");
        if (row.registration.status === "registered") return t("已添加到图库");
        if (row.registration.status === "duplicate")
            return t("图库中已有此文件");
        if (row.registration.status === "unsupported")
            return t("已保存，图库不支持此格式");
        return t("已保存，图库添加失败");
    };

    const renderRows = () => {
        results.hidden = !rows.some((row) => row.status !== "pending");
        resultList.replaceChildren();
        let written = 0;
        let failed = 0;
        for (const row of rows) {
            if (row.status === "written") written++;
            if (row.status === "failed") failed++;
            const item = element("li", "convert-donut-result-row");
            item.dataset.convertRow = "";
            item.dataset.index = String(row.index);
            item.dataset.status = row.status;
            if (row.output) item.dataset.outputPath = row.output.path;
            const identity = element("div");
            const name = element("strong");
            name.textContent = fileName(row.target);
            const detail = element("small");
            detail.textContent = row.output
                ? `${pathName(row.output.path)} · ${row.output.width} × ${row.output.height} · ${formatBytes(row.output.bytes)}${row.registration?.error ? ` · ${t(row.registration.error)}` : ""}`
                : row.error
                  ? t(row.error)
                  : rowStatus(row);
            identity.append(name, detail);
            const status = element("span", "convert-donut-row-status");
            status.textContent = rowStatus(row);
            status.dataset.registrationStatus =
                row.registration?.status ?? "none";
            item.append(identity, status);
            if (row.output && api.revealPath) {
                const reveal = element("button");
                reveal.type = "button";
                reveal.textContent = t("在文件夹中显示");
                reveal.addEventListener("click", () => {
                    void api
                        .revealPath?.(row.output!.path)
                        .catch((error) => setError(t(errorMessage(error))));
                });
                item.append(reveal);
            }
            resultList.append(item);
        }
        resultsSummary.textContent = t("已保存 {saved} 个，失败 {failed} 个")
            .replace("{saved}", String(written))
            .replace("{failed}", String(failed));
        retryConvert.hidden = !rows.some((row) => row.status === "failed");
        retryRegistration.hidden = !rows.some(
            (row) => row.registration?.status === "failed",
        );
    };

    const registerRows = async (candidates: ConvertResultRow[]) => {
        if (!api.registerConvertedPaths) return;
        const eligible = candidates.filter(
            (row) => row.status === "written" && row.output,
        );
        if (!eligible.length) return;
        try {
            const outcomes = await api.registerConvertedPaths(
                eligible.map((row) => row.output!.path),
            );
            const queues = new Map<string, CaptureRegistrationOutcome[]>();
            for (const outcome of outcomes) {
                const queue = queues.get(outcome.path) ?? [];
                queue.push(outcome);
                queues.set(outcome.path, queue);
            }
            for (const row of eligible) {
                row.registration =
                    queues.get(row.output!.path)?.shift() ??
                    ({
                        path: row.output!.path,
                        status: "failed",
                        error: t("图库未返回此文件的处理结果"),
                    } satisfies CaptureRegistrationOutcome);
            }
        } catch (error) {
            const message = t(errorMessage(error));
            for (const row of eligible)
                row.registration = {
                    path: row.output!.path,
                    status: "failed",
                    error: message,
                };
            setError(message);
        }
        renderRows();
    };

    const setBusy = (value: boolean) => {
        busy = value;
        convertButton.disabled = value;
        retryConvert.disabled = value;
        retryRegistration.disabled = value;
        formatSelect.disabled = value;
        presetSelect.disabled = value;
        details.classList.toggle("busy", value);
        if (!value) syncFormatFields();
    };

    const runRows = async (
        candidates: ConvertResultRow[],
        frozen: OperationSettings,
    ) => {
        if (busy || closed || !candidates.length) return;
        setBusy(true);
        conversionPromisePending = true;
        operationCancelled = false;
        operationSnapshot = frozen;
        const token = ++operationToken;
        activeRows = candidates;
        for (const row of candidates) {
            if (closed || token !== operationToken) {
                if (row.status === "pending" || row.status === "converting")
                    row.status = "cancelled";
                continue;
            }
            row.status = "converting";
            row.error = undefined;
            renderRows();
            if (isSameFormatNoOp(row, frozen)) {
                row.status = "skipped";
                renderRows();
                continue;
            }
            try {
                row.output = await convertOne(row, frozen, token);
                row.status = "written";
            } catch (error) {
                if (closed || token !== operationToken)
                    row.status = "cancelled";
                else {
                    row.status = "failed";
                    row.error = errorMessage(error);
                }
            }
            renderRows();
        }
        activeRows = [];
        if (!closed && token === operationToken && frozen.register)
            await registerRows(candidates);
        conversionPromisePending = false;
        if (!closed) {
            setBusy(false);
            if (token === operationToken) {
                convertButton.textContent = t("再次转换");
                queueMicrotask(() =>
                    results.scrollIntoView({ block: "nearest" }),
                );
            }
        }
    };

    const buildResult = (): ConvertResult => ({
        written: rows.flatMap((row) =>
            row.status === "written" && row.output ? [row.output.path] : [],
        ),
        bytes: rows.reduce(
            (sum, row) =>
                sum + (row.status === "written" ? (row.output?.bytes ?? 0) : 0),
            0,
        ),
        failed: rows.flatMap((row) =>
            row.status === "failed"
                ? [{ target: row.target, error: row.error ?? t("转换失败") }]
                : [],
        ),
        skipped: rows.filter((row) => row.status === "skipped").length,
        cancelled:
            operationCancelled ||
            rows.some((row) => row.status === "cancelled") ||
            !operationSnapshot,
        format: operationSnapshot?.format,
        rows: rows.map((row) => ({ ...row })),
        registration: rows.flatMap((row) =>
            row.registration ? [row.registration] : [],
        ),
    });

    function dismiss() {
        if (closed) return;
        if (busy) {
            operationCancelled = true;
            operationToken++;
            for (const row of activeRows) {
                if (row.status === "pending" || row.status === "converting")
                    row.status = "cancelled";
            }
            if (dragPromisePending) {
                dragState = "idle";
                dragOutput = undefined;
                prepareDrag.hidden = false;
                cancelDrag.hidden = true;
                dragStatus.dataset.dragStatus = "idle";
                dragStatus.textContent = t("已取消拖放准备");
            } else if (!conversionPromisePending) {
                activeRows = [];
                setBusy(false);
            }
            renderRows();
            cancelButton.textContent = t("关闭");
            return;
        }
        closed = true;
        previewToken++;
        operationToken++;
        window.clearTimeout(previewTimer);
        for (const row of activeRows) {
            if (row.status === "pending" || row.status === "converting")
                row.status = "cancelled";
        }
        revokePreview();
        revokeSourcePreview();
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
        if (opener?.isConnected) opener.focus();
        if (!settled) {
            settled = true;
            options.onDone?.(buildResult());
        }
    }

    const focusable = () =>
        Array.from(
            dialog.querySelectorAll<HTMLElement>(
                "button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])",
            ),
        ).filter((node) => !node.hidden && node.getClientRects().length > 0);
    const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (details.open && document.activeElement?.closest("details")) {
                details.open = false;
                summary.focus();
                return;
            }
            dismiss();
            return;
        }
        if (event.key !== "Tab") return;
        const nodes = focusable();
        if (!nodes.length) {
            event.preventDefault();
            return;
        }
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (
            index < 0 ||
            (!event.shiftKey && index === nodes.length - 1) ||
            (event.shiftKey && index === 0)
        ) {
            event.preventDefault();
            nodes[event.shiftKey ? nodes.length - 1 : 0].focus();
        }
    };

    presetSelect.addEventListener("change", () => {
        const [kind, rawIndex] = presetSelect.value.split(":");
        const index = Number(rawIndex);
        const preset =
            kind === "builtin" ? BUILTIN_PRESETS[index] : namedPresets[index];
        if (preset) {
            presetName.value = kind === "local" ? preset.name : "";
            applySettings(preset.settings);
        }
        deletePreset.disabled = kind !== "local";
    });
    sourceTab.addEventListener("click", () => showPreviewView("source"));
    resultTab.addEventListener("click", () => showPreviewView("result"));
    savePreset.addEventListener("click", () => {
        const name = presetName.value.trim().slice(0, MAX_PRESET_NAME);
        const next = readControls();
        if (!name || !next) {
            if (!name) setError(t("请输入预设名称"));
            return;
        }
        const existing = namedPresets.findIndex((item) => item.name === name);
        if (existing >= 0) namedPresets[existing] = { name, settings: next };
        else if (namedPresets.length < MAX_PRESETS)
            namedPresets.push({ name, settings: next });
        else {
            setError(t("最多可保存 12 个预设"));
            return;
        }
        writeStorage(PRESETS_KEY, namedPresets);
        renderPresetOptions();
        presetSelect.value = `local:${existing >= 0 ? existing : namedPresets.length - 1}`;
        deletePreset.disabled = false;
        setError();
    });
    deletePreset.addEventListener("click", () => {
        if (!presetSelect.value.startsWith("local:")) return;
        const index = Number(presetSelect.value.split(":")[1]);
        if (!Number.isInteger(index) || !namedPresets[index]) return;
        namedPresets.splice(index, 1);
        writeStorage(PRESETS_KEY, namedPresets);
        presetName.value = "";
        renderPresetOptions();
    });
    details.addEventListener("toggle", () => {
        try {
            localStorage.setItem(OPTIONS_OPEN_KEY, details.open ? "1" : "0");
        } catch {
            // Optional UI preference.
        }
    });
    const settingInputs = [
        formatSelect,
        scaleInput,
        qualityInput,
        widthInput,
        backgroundInput,
        signatureInput,
        nameInput,
        registerInput,
    ];
    for (const input of settingInputs) {
        input.addEventListener("change", () => {
            if (input === formatSelect) syncFormatFields();
            dragOutput = undefined;
            dragState = "idle";
            prepareDrag.hidden = false;
            dispatchDrag.hidden = true;
            cancelDrag.hidden = true;
            dragStatus.dataset.dragStatus = "idle";
            delete dragStatus.dataset.preparedPath;
            dragStatus.textContent = t("需要时可先准备拖放文件");
            schedulePreview();
        });
        if (input instanceof HTMLInputElement)
            input.addEventListener("input", schedulePreview);
    }
    convertButton.addEventListener("click", () => {
        if (busy || closed) return;
        const frozen = snapshot();
        if (!frozen) return;
        let candidates = rows.filter(
            (row) => row.status === "pending" || row.status === "cancelled",
        );
        if (!candidates.length) {
            for (const row of rows) {
                row.status = "pending";
                row.output = undefined;
                row.error = undefined;
                row.registration = undefined;
            }
            candidates = rows;
        }
        void runRows(candidates, frozen);
    });
    retryConvert.addEventListener("click", () => {
        if (busy || closed || !operationSnapshot) return;
        const failed = rows.filter((row) => row.status === "failed");
        for (const row of failed) {
            row.status = "pending";
            row.error = undefined;
        }
        void runRows(failed, operationSnapshot);
    });
    retryRegistration.addEventListener("click", () => {
        if (busy) return;
        setBusy(true);
        conversionPromisePending = true;
        void registerRows(
            rows.filter((row) => row.registration?.status === "failed"),
        ).finally(() => {
            conversionPromisePending = false;
            if (!closed) setBusy(false);
        });
    });
    prepareDrag.addEventListener("click", () => {
        const frozen = snapshot();
        const row = rows[0];
        if (!frozen || !row || busy) return;
        operationSnapshot = frozen;
        operationCancelled = false;
        const token = ++operationToken;
        setBusy(true);
        dragPromisePending = true;
        activeRows = [row];
        row.status = "converting";
        renderRows();
        dragState = "preparing";
        dragOutput = undefined;
        prepareDrag.hidden = true;
        dispatchDrag.hidden = true;
        cancelDrag.hidden = false;
        dragStatus.dataset.dragStatus = "preparing";
        dragStatus.textContent = t("正在准备拖放文件");
        void convertOne(row, frozen, token)
            .then((output) => {
                dragPromisePending = false;
                row.output = output;
                row.status = "written";
                activeRows = [];
                setBusy(false);
                renderRows();
                if (
                    closed ||
                    token !== operationToken ||
                    dragState !== "preparing"
                )
                    return;
                dragOutput = output;
                dragState = "ready";
                cancelDrag.hidden = true;
                dispatchDrag.hidden = false;
                dragStatus.dataset.dragStatus = "ready";
                dragStatus.dataset.preparedPath = output.path;
                dragStatus.textContent = t(
                    "文件已准备好，请按下按钮开始系统拖放",
                );
            })
            .catch((error) => {
                dragPromisePending = false;
                activeRows = [];
                setBusy(false);
                if (closed || token !== operationToken) return;
                row.status = "failed";
                row.error = errorMessage(error);
                renderRows();
                dragState = "error";
                prepareDrag.hidden = false;
                cancelDrag.hidden = true;
                dragStatus.dataset.dragStatus = "error";
                dragStatus.textContent = t(errorMessage(error));
            });
    });
    cancelDrag.addEventListener("click", () => {
        operationToken++;
        operationCancelled = true;
        dragState = "idle";
        dragOutput = undefined;
        if (rows[0]?.status === "converting") rows[0].status = "cancelled";
        renderRows();
        prepareDrag.hidden = false;
        cancelDrag.hidden = true;
        dragStatus.dataset.dragStatus = "idle";
        delete dragStatus.dataset.preparedPath;
        dragStatus.textContent = t("已取消拖放准备");
    });
    dispatchDrag.addEventListener("click", () => {
        if (
            !dragOutput ||
            !["ready", "error"].includes(dragState) ||
            !api.dragConvertedPath
        )
            return;
        dispatchDrag.disabled = true;
        void api
            .dragConvertedPath(dragOutput.path)
            .then((ack) => {
                dispatchDrag.disabled = false;
                if (closed) return;
                if (ack.started) {
                    dragState = "ready";
                    dragStatus.dataset.dragStatus = "ready";
                    dragStatus.textContent = t("系统已接受拖放请求");
                } else {
                    dragState = "error";
                    dragStatus.dataset.dragStatus = "error";
                    dragStatus.textContent = ack.error
                        ? t(ack.error)
                        : t("无法开始系统拖放");
                }
            })
            .catch((error) => {
                dispatchDrag.disabled = false;
                if (closed) return;
                dragState = "error";
                dragStatus.dataset.dragStatus = "error";
                dragStatus.textContent = t(errorMessage(error));
            });
    });
    cancelButton.addEventListener("click", () => {
        if (busy) {
            dismiss();
            return;
        }
        dismiss();
    });
    closeButton.addEventListener("click", dismiss);
    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) dismiss();
    });
    document.addEventListener("keydown", onKey, true);

    sourceValue.textContent =
        targets.length === 1
            ? fileName(targets[0])
            : t("{count} 个文件").replace("{count}", String(targets.length));
    void getSourceBytes(targets[0])
        .then((bytes) => {
            if (closed) return;
            revokeSourcePreview();
            sourcePreviewUrl = URL.createObjectURL(
                new Blob([bytes as BlobPart], { type: sourceMime(targets[0]) }),
            );
            if (previewView === "source") showPreviewView("source");
        })
        .catch((error) => {
            if (closed || previewView !== "source") return;
            previewPlaceholder.textContent = t(errorMessage(error));
        });
    renderPresetOptions();
    syncFormatFields();
    queueMicrotask(() => {
        formatSelect.focus();
        schedulePreview();
    });
    return dismiss;
}
