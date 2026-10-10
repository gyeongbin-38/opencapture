import { button, ele, initDKH, input, p, select, textarea, view } from "dkh-ui";
import type {
    OpenCaptureActionName,
    OpenCaptureItem,
    OpenCaptureItemsPage,
    OpenCaptureShortcut,
    OpenCaptureState,
    TranslationEngine,
    TranslationStatus,
} from "../../../lib/openCaptureTypes";
import {
    type GifDecoder,
    GifImageDecoder,
    type PageName,
    UPSCALE_MAX_PIXELS,
    acceleratorFromEvent,
    clamp01,
    drawBadge,
    emptyState,
    errorMessage,
    formatDate,
    formatShortcut,
    isGifItem,
    isItemsPage,
    isState,
    isVideoItem,
    mixChannel,
    sampleEdgeColor,
    unsharpMask,
} from "./dashboard-utils";
import { icon } from "./icons";
import { t } from "./t";

initDKH({ pureStyle: true });

const transparencyPreference = matchMedia(
    "(prefers-reduced-transparency: reduce)",
);
const syncTransparencyPreference = () =>
    document.documentElement.classList.toggle(
        "reduced-transparency",
        transparencyPreference.matches,
    );
syncTransparencyPreference();
transparencyPreference.addEventListener("change", syncTransparencyPreference);

let appState = emptyState;
let translationStatus: TranslationStatus | null = null;
let activePage: PageName = "home";
const selectedItemIds = new Set<string>();
let lastSelectIndex: number | null = null;
let searchQuery = "";
let favoritesOnly = false;
let todayOnly = false;
let ocrOnly = false;
let activeTag: string | null = null;
let sortMode: "new" | "old" | "name" = "new";
let thumbSize = localStorage.getItem("oc:thumb-size") || "m";
let quickLookId: string | null = null;
const quickLookImages = new Map<string, string>();
const pendingOcrIds = new Set<string>();
let renameTargetId: string | null = null;
let noteTargetId: string | null = null;
let beautifyTarget: { id: string; image: HTMLImageElement } | null = null;
let upscaleTarget: { id: string; image: HTMLImageElement } | null = null;

const label = (
    tag: "span" | "strong" | "small" | "h1" | "h2" | "h3",
    value: string,
) => ele(tag).attr({ textContent: value });

view("x").class("window-titlebar").addInto();

const shell = view("x").class("app-shell").addInto();
if (localStorage.getItem("oc:nav-collapsed"))
    shell.el.classList.add("nav-collapsed");
const sidebar = ele("aside").class("sidebar").addInto(shell);
const main = ele("main").class("main").addInto(shell);

const brand = view("x")
    .class("brand")
    .attr({ title: "OpenCapture" })
    .addInto(sidebar);
brand.add(view().class("brand-mark").add(icon("⌁")));

const navigation = ele("nav").class("navigation").addInto(sidebar);
const navItems: { page: PageName; icon: string; text: string }[] = [
    { page: "home", icon: "⌂", text: t("홈") },
    { page: "library", icon: "▧", text: t("라이브러리") },
    { page: "translate", icon: "文", text: t("번역") },
    { page: "settings", icon: "⚙", text: t("설정") },
];

const navButtons = new Map<PageName, HTMLButtonElement>();
for (const item of navItems) {
    const navButton = button()
        .class("nav-button")
        .attr({ type: "button", ariaLabel: item.text, title: item.text })
        .add([icon(item.icon), label("span", item.text)])
        .on("click", () => showPage(item.page))
        .addInto(navigation);
    navButtons.set(item.page, navButton.el);
}

const sidebarBottom = view("y").class("sidebar-bottom").addInto(sidebar);
const sidebarTools = view("x").class("sidebar-tools").addInto(sidebarBottom);
button()
    .class("ghost-button", "compact", "icon-button")
    .attr({
        type: "button",
        title: t("사이드바 접기"),
        ariaLabel: t("사이드바 접기"),
    })
    .add(icon("⇤"))
    .on("click", () => {
        const collapsed = shell.el.classList.toggle("nav-collapsed");
        localStorage.setItem("oc:nav-collapsed", collapsed ? "1" : "");
    })
    .addInto(sidebarTools);
button()
    .class("ghost-button", "compact", "icon-button")
    .attr({
        type: "button",
        title: t("단축키 보기"),
        ariaLabel: t("단축키 보기"),
    })
    .add(icon("?"))
    .on("click", () => openShortcutSheet())
    .addInto(sidebarTools);
button()
    .class("ghost-button", "compact", "icon-button")
    .attr({
        type: "button",
        title: t("시작 가이드"),
        ariaLabel: t("시작 가이드"),
    })
    .add(icon("✦"))
    .on("click", () => openOnboarding())
    .addInto(sidebarTools);

const versionLabel = label("small", "").class("version").addInto(sidebarBottom);

const topbar = view("x").class("topbar").addInto(main);
const titleGroup = view("y").class("title-group").addInto(topbar);
const pageTitle = label("h1", t("캡처")).addInto(titleGroup);
const topActions = view("x").class("top-actions").addInto(topbar);

button()
    .class("ghost-button", "compact", "icon-button")
    .attr({
        type: "button",
        title: t("간단히 보기"),
        ariaLabel: t("간단히 보기"),
    })
    .add(icon("↙"))
    .on("click", () => runAction("toggle-compact"))
    .addInto(topActions);
button()
    .class("ghost-button", "compact", "icon-button")
    .attr({ type: "button", title: t("창 숨기기"), ariaLabel: t("창 숨기기") })
    .add(icon("—"))
    .on("click", () => runAction("hide-window"))
    .addInto(topActions);
button()
    .class("ghost-button", "compact", "icon-button")
    .attr({
        type: "button",
        title: t("이미지 열기"),
        ariaLabel: t("이미지 열기"),
    })
    .add(icon("＋"))
    .on("click", () => runAction("open-image"))
    .addInto(topActions);

const content = ele("div").class("content").addInto(main);
const pages = new Map<PageName, HTMLElement>();

function makePage(name: PageName) {
    const page = ele("section")
        .class("page")
        .data({ page: name })
        .addInto(content);
    pages.set(name, page.el);
    return page;
}

const homePage = makePage("home");
const libraryPage = makePage("library");
const translatePage = makePage("translate");
const settingsPage = makePage("settings");

const captureActions: {
    name: OpenCaptureActionName;
    icon: string;
    title: string;
    description: string;
    shortcut?: string;
    featured?: boolean;
}[] = [
    {
        name: "capture",
        icon: "⌗",
        title: t("영역 캡처"),
        description: t("원하는 영역을 빠르게 선택해요"),
        shortcut: "Ctrl + Shift + A",
        featured: true,
    },
    {
        name: "fullscreen",
        icon: "▣",
        title: t("전체 화면"),
        description: t("현재 화면 전체를 바로 저장해요"),
    },
    {
        name: "window",
        icon: "▤",
        title: t("창 캡처"),
        description: t("열려 있는 창 하나만 골라요"),
    },
    {
        name: "scroll",
        icon: "↕",
        title: t("스크롤 캡처"),
        description: t("긴 페이지를 한 장으로 이어 붙여요"),
    },
    {
        name: "record",
        icon: "●",
        title: t("화면 녹화"),
        description: t("화면 움직임과 소리를 기록해요"),
        shortcut: "Ctrl + Shift + R",
    },
    {
        name: "steps",
        icon: "≣",
        title: t("단계 캡처"),
        description: t("클릭할 때마다 화면이 순서대로 저장돼요"),
    },
    {
        name: "ocr",
        icon: "T",
        title: t("텍스트 추출"),
        description: t("화면 속 글자를 바로 복사해요"),
    },
    {
        name: "screen-translate",
        icon: "文",
        title: t("화면 번역"),
        description: t("캡처한 문장을 선택한 언어로 번역해요"),
    },
    {
        name: "pin-clipboard",
        icon: "◇",
        title: t("클립보드 고정"),
        description: t("복사한 이미지를 화면 위에 띄워요"),
    },
];

const actionGroups: { key: string; title: string; names: string[] }[] = [
    {
        key: "capture",
        title: t("캡처"),
        names: ["capture", "fullscreen", "window", "scroll"],
    },
    { key: "record", title: t("녹화"), names: ["record", "steps"] },
    {
        key: "tools",
        title: t("도구"),
        names: ["ocr", "screen-translate", "pin-clipboard"],
    },
    { key: "auto", title: t("자동 작업"), names: [] },
];
const openGroups = new Set<string>(
    JSON.parse(localStorage.getItem("oc:action-groups") ?? '["capture"]'),
);
const workflowCard = view("y").class("workflow-card");
const pinSetRow = view("x", "wrap").class("pinset-row");

function makeActionCard(action: (typeof captureActions)[number]) {
    const category =
        action.name === "screen-translate" || action.name === "ocr"
            ? "language"
            : action.name === "pin-clipboard"
              ? "pin"
              : action.name === "record"
                ? "create"
                : "capture";
    const actionButton = button()
        .class("action-card", action.featured ? "featured" : "")
        .attr({ type: "button", title: action.description })
        .data({ action: action.name, category })
        .on("click", () => {
            if (action.name === "steps") {
                void toggleSteps();
            } else runAction(action.name);
        });
    actionButton.add([
        view("x")
            .class("action-card-top")
            .add([
                view().class("action-icon").add(icon(action.icon)),
                action.shortcut
                    ? label("small", action.shortcut).class("key-hint")
                    : undefined,
            ]),
        label("h3", action.title),
    ]);
    return actionButton;
}

const groupEls = new Map<string, { el: HTMLElement; head: HTMLElement }>();
for (const group of actionGroups) {
    const groupEl = view("y")
        .class("action-group")
        .data({ group: group.key })
        .addInto(homePage);
    const head = button()
        .class("action-group-head")
        .attr({ type: "button", ariaExpanded: "false" })
        .add([label("span", group.title), icon("▾").class("chevron")])
        .on("click", () => {
            if (openGroups.has(group.key)) openGroups.delete(group.key);
            else openGroups.add(group.key);
            syncGroups();
            localStorage.setItem(
                "oc:action-groups",
                JSON.stringify([...openGroups]),
            );
        })
        .addInto(groupEl);
    const body = view("y").class("action-group-body").addInto(groupEl);
    groupEls.set(group.key, { el: groupEl.el, head: head.el });
    if (group.names.length) {
        const tiles = view("x", "wrap").class("action-grid").addInto(body);
        for (const name of group.names) {
            const action = captureActions.find((a) => a.name === name);
            if (action) makeActionCard(action).addInto(tiles);
        }
    }
    if (group.key === "tools") {
        const quickRow = view("x", "wrap").class("quick-row").addInto(body);
        quickRow.add(pinSetRow);
        button()
            .class("ghost-button", "compact")
            .attr({
                type: "button",
                title: t("화면에 고정된 이미지를 모두 복원"),
            })
            .add([icon("◇"), label("span", t("핀 복원"))])
            .on("click", () => runAction("restore-pins"))
            .addInto(quickRow);
    }
    if (group.key === "auto") body.add(workflowCard);
}

function syncGroups() {
    for (const [key, { el, head }] of groupEls) {
        const open = openGroups.has(key);
        el.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
    }
}
syncGroups();

const workflowInputs = new Map<
    keyof OpenCaptureState["workflow"],
    HTMLInputElement
>();
const workflowOptions: {
    key: keyof OpenCaptureState["workflow"];
    title: string;
    description: string;
}[] = [
    {
        key: "autoCopy",
        title: t("클립보드에 복사"),
        description: t("캡처가 끝나면 바로 붙여넣을 수 있습니다."),
    },
    {
        key: "autoRemoveBackground",
        title: t("배경 자동 제거"),
        description: t("로컬에서 배경을 제거한 사본을 만듭니다."),
    },
    {
        key: "autoPin",
        title: t("화면에 고정"),
        description: t("완료된 이미지를 현재 화면 위에 띄웁니다."),
    },
    {
        key: "autoOcr",
        title: t("텍스트 자동 인식"),
        description: t(
            "캡처 속 글자를 기기 안에서 인식해 라이브러리 검색에 활용합니다.",
        ),
    },
    {
        key: "autoPreview",
        title: t("캡처 후 바로 보기"),
        description: t("저장 직후 큰 미리보기를 열어 바로 작업할 수 있습니다."),
    },
];
const workflowChoices = view("x", "wrap")
    .class("workflow-choices")
    .addInto(workflowCard);
for (const option of workflowOptions) {
    const checkbox = input("checkbox").attr({ ariaLabel: option.title });
    workflowInputs.set(option.key, checkbox.el);
    checkbox.on("change", async () => {
        checkbox.el.disabled = true;
        await runAction("configure-workflow", {
            [option.key]: checkbox.el.checked,
        });
        checkbox.el.disabled = false;
        renderState();
    });
    ele("label")
        .class("toggle-option")
        .attr({ title: option.description })
        .add([checkbox, label("strong", option.title)])
        .addInto(workflowChoices);
}

const libraryToolbar = view("x").class("section-toolbar").addInto(libraryPage);
const collectionGroup = view("y").class("field-group").addInto(libraryToolbar);
const collectionSelect = select([])
    .class("select-control")
    .attr({ ariaLabel: t("컬렉션 선택") })
    .on("change", (_event, element) => {
        const id = element.el.value;
        if (id) runAction("choose-collection", id, true);
    })
    .addInto(collectionGroup);
const searchGroup = view("y").class("field-group").addInto(libraryToolbar);
const searchField = view("x").class("search-field").addInto(searchGroup);
searchField.add(view().class("search-icon").add(icon("⌕")));
const searchInput = input("text")
    .class("search-input")
    .attr({
        placeholder: t("이름·메모·태그·본문 텍스트로 찾기"),
        ariaLabel: t("캡처 검색"),
    })
    .on("input", () => {
        searchQuery = searchInput.el.value.trim().toLowerCase();
        renderState();
    })
    .addInto(searchField);
const libraryButtons = view("x")
    .class("toolbar-actions")
    .addInto(libraryToolbar);
const favFilterButton = button()
    .class("chip-button", "fav-filter")
    .attr({
        type: "button",
        ariaPressed: "false",
        title: t("즐겨찾기만 보기"),
        ariaLabel: t("즐겨찾기만 보기"),
    })
    .add([icon("★"), label("span", t("즐겨찾기"))])
    .on("click", () => {
        favoritesOnly = !favoritesOnly;
        favFilterButton.el.classList.toggle("active", favoritesOnly);
        favFilterButton.attr({ ariaPressed: String(favoritesOnly) });
        renderState();
    })
    .addInto(libraryButtons);
button()
    .class("outline-button", "folder-add-button")
    .attr({ type: "button" })
    .add([icon("＋"), label("span", t("폴더 추가"))])
    .on("click", () => runAction("add-collection", undefined, true))
    .addInto(libraryButtons);
const fileInput = input("file")
    .class("visually-hidden")
    .attr({ multiple: true, accept: "image/*,video/*" });
fileInput.on("change", () => {
    const files = Array.from(fileInput.el.files ?? []);
    if (files.length) importFiles(files);
    fileInput.el.value = "";
});
fileInput.addInto(libraryPage);
button()
    .class("primary-button", "library-import-button")
    .attr({ type: "button" })
    .add([icon("⇧"), label("span", t("이미지 가져오기"))])
    .on("click", () => fileInput.el.click())
    .addInto(libraryButtons);

const filterBar = view("x", "wrap").class("filter-bar").addInto(libraryPage);
const todayChip = button()
    .class("chip-button")
    .attr({ type: "button", ariaPressed: "false" })
    .add([icon("◷"), label("span", t("오늘"))])
    .on("click", () => {
        todayOnly = !todayOnly;
        renderState();
    })
    .addInto(filterBar);
const ocrChip = button()
    .class("chip-button")
    .attr({
        type: "button",
        ariaPressed: "false",
        title: t("텍스트 인식된 캡처"),
    })
    .add([icon("T"), label("span", t("텍스트"))])
    .on("click", () => {
        ocrOnly = !ocrOnly;
        renderState();
    })
    .addInto(filterBar);
const tagChipRow = view("x", "wrap").class("tag-chip-row").addInto(filterBar);
const filterBarEnd = view("x").class("filter-bar-end").addInto(filterBar);
const sortSelect = select([
    { value: "new", name: t("최신순") },
    { value: "old", name: t("오래된순") },
    { value: "name", name: t("이름순") },
])
    .class("select-control", "sort-select")
    .attr({ ariaLabel: t("정렬") })
    .on("change", (_event, element) => {
        sortMode = element.el.value as typeof sortMode;
        renderState();
    })
    .addInto(filterBarEnd);
const sizeSegment = view("x")
    .class("size-segment")
    .attr({ role: "group", ariaLabel: t("썸네일 크기") })
    .addInto(filterBarEnd);
for (const [size, text] of [
    ["s", t("작게")],
    ["m", t("보통")],
    ["l", t("크게")],
] as const) {
    button(text)
        .class("size-segment-button")
        .attr({ type: "button", ariaPressed: String(thumbSize === size) })
        .on("click", () => {
            thumbSize = size;
            localStorage.setItem("oc:thumb-size", size);
            renderState();
        })
        .addInto(sizeSegment);
}

const dropZone = view("y")
    .class("drop-zone")
    .attr({ role: "button", tabIndex: 0, ariaLabel: t("이미지 가져오기") })
    .add([
        view().class("drop-icon").add(icon("⇩")),
        label("strong", t("이미지를 여기에 놓으세요")),
        button(t("파일 선택"))
            .class("text-button")
            .attr({ type: "button", tabIndex: -1 }),
    ])
    .on("click", () => fileInput.el.click())
    .on("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") fileInput.el.click();
    })
    .on("dragover", (event, element) => {
        event.preventDefault();
        element.el.classList.add("dragging");
    })
    .on("dragleave", (_event, element) =>
        element.el.classList.remove("dragging"),
    )
    .on("drop", (event, element) => {
        event.preventDefault();
        element.el.classList.remove("dragging");
        const files = Array.from(event.dataTransfer?.files ?? []).filter(
            (file) => file.type.startsWith("image/"),
        );
        if (files.length) importFiles(files);
    })
    .addInto(libraryPage);

const libraryMeta = view("x")
    .class("section-heading", "library-meta")
    .addInto(libraryPage);
const libraryTitle = label("h2", t("저장된 캡처")).addInto(libraryMeta);
const itemCount = label("small", "").class("count-badge").addInto(libraryMeta);
const selectionToolbar = view("x")
    .class("selection-toolbar")
    .addInto(libraryPage);
const selectionStatus = label("strong", t("선택 없음")).addInto(
    selectionToolbar,
);
const selectionActions = view("x", "wrap")
    .class("selection-actions")
    .addInto(selectionToolbar);
const selectDisplayedButton = button(t("표시된 항목 모두 선택"))
    .class("text-button")
    .attr({ type: "button" })
    .on("click", () => {
        for (const item of visibleLibraryItems()) selectedItemIds.add(item.id);
        renderState();
    })
    .addInto(selectionActions);
const clearSelectionButton = button(t("선택 해제"))
    .class("text-button")
    .attr({ type: "button" })
    .on("click", () => {
        selectedItemIds.clear();
        renderState();
    })
    .addInto(selectionActions);
for (const [text, action, direction] of [
    [t("내보내기"), "export-items"],
    [t("고정"), "pin-items"],
    [t("세로 합치기"), "combine-items", "vertical"],
    [t("가로 합치기"), "combine-items", "horizontal"],
] as [string, OpenCaptureActionName, "vertical" | "horizontal" | undefined][]) {
    button(text)
        .class(
            "outline-button",
            "compact",
            "bulk-action",
            direction ? "combine-action" : "",
        )
        .attr({ type: "button" })
        .on("click", async () => {
            const ids = [...selectedItemIds];
            if (!ids.length) return;
            await runAction(action, direction ? { ids, direction } : { ids });
        })
        .addInto(selectionActions);
}
button(t("핀 세트 저장"))
    .class("outline-button", "compact", "bulk-action")
    .attr({
        type: "button",
        title: t("선택한 캡처를 한 번에 고정하는 세트로 저장"),
    })
    .on("click", async () => {
        const ids = [...selectedItemIds];
        if (!ids.length) return;
        await runAction("save-pin-set", { ids });
    })
    .addInto(selectionActions);
button(t("번호 합치기"))
    .class("outline-button", "compact", "combine-action")
    .attr({
        type: "button",
        title: t("선택한 캡처를 번호가 붙은 순서 이미지로 합성"),
    })
    .on("click", () => void composeLayout([...selectedItemIds], "steps"))
    .addInto(selectionActions);
button(t("비교 합치기"))
    .class("outline-button", "compact", "combine-action")
    .attr({ type: "button", title: t("선택한 캡처를 A/B 라벨로 나란히 합성") })
    .on("click", () => void composeLayout([...selectedItemIds], "compare"))
    .addInto(selectionActions);
button(t("타임라인 합치기"))
    .class("outline-button", "compact", "combine-action")
    .attr({
        type: "button",
        title: t("선택한 캡처를 번호가 붙은 가로 타임라인으로 합성"),
    })
    .on("click", () => void composeLayout([...selectedItemIds], "timeline"))
    .addInto(selectionActions);
button(t("텍스트 인식"))
    .class("outline-button", "compact", "bulk-action")
    .attr({
        type: "button",
        title: t("선택한 캡처의 글자를 인식해 검색에 추가"),
    })
    .on("click", async () => {
        const ids = [...selectedItemIds];
        if (!ids.length) return;
        for (const id of ids) {
            pendingOcrIds.add(id);
            setTimeout(() => pendingOcrIds.delete(id), 120_000);
        }
        await runAction("index-ocr", { ids });
    })
    .addInto(selectionActions);
const itemGrid = view("x", "wrap").class("item-grid").addInto(libraryPage);
const loadMoreButton = button(t("더 불러오기"))
    .class("outline-button", "load-more")
    .attr({ type: "button" })
    .on("click", () => loadMoreItems())
    .addInto(libraryPage);

const translatorLayout = view("x")
    .class("translator-layout")
    .addInto(translatePage);
const translatorMain = view("y")
    .class("translator-main")
    .addInto(translatorLayout);
const translateControls = view("x")
    .class("language-row")
    .addInto(translatorMain);
const languageOptions = [
    { value: "auto", name: t("언어 자동 감지") },
    { value: "ko", name: t("한국어") },
    { value: "en", name: t("영어") },
];
const sourceLanguage = select(languageOptions)
    .class("select-control")
    .addInto(translateControls);
sourceLanguage.el.value = "auto";
button()
    .class("swap-button")
    .attr({
        type: "button",
        title: t("언어 바꾸기"),
        ariaLabel: t("언어 바꾸기"),
    })
    .add(icon("⇄"))
    .on("click", () => {
        if (sourceLanguage.el.value === "auto") return;
        const source = sourceLanguage.el.value;
        sourceLanguage.el.value = targetLanguage.el.value;
        targetLanguage.el.value = source;
    })
    .addInto(translateControls);
const targetLanguage = select(languageOptions.slice(1))
    .class("select-control")
    .addInto(translateControls);
targetLanguage.el.value = "ko";

const translationEditors = view("x")
    .class("translation-editors")
    .addInto(translatorMain);
const sourceEditor = view("y")
    .class("translation-editor")
    .addInto(translationEditors);
const sourceText = ele("textarea")
    .class("translation-textarea")
    .attr({
        placeholder: t("번역할 내용을 입력하세요"),
        spellcheck: false,
        maxLength: 5000,
    })
    .addInto(sourceEditor);
const sourceFooter = view("x").class("editor-footer").addInto(sourceEditor);
const characterCount = label("small", "0 / 5,000").addInto(sourceFooter);
sourceText.on("input", () => {
    characterCount.el.textContent = `${sourceText.el.value.length.toLocaleString()} / 5,000`;
});
button(t("번역하기"))
    .class("primary-button")
    .attr({ type: "button" })
    .on("click", () => translateText())
    .addInto(sourceFooter);

const resultEditor = view("y")
    .class("translation-editor", "result-editor")
    .addInto(translationEditors);
const resultText = ele("textarea")
    .class("translation-textarea")
    .attr({ placeholder: t("번역 결과가 여기에 표시됩니다"), readOnly: true })
    .addInto(resultEditor);
const resultFooter = view("x").class("editor-footer").addInto(resultEditor);
button()
    .class("text-button")
    .attr({ type: "button" })
    .add([icon("▣"), label("span", t("결과 복사"))])
    .on("click", async () => {
        if (!resultText.el.value) return;
        await navigator.clipboard.writeText(resultText.el.value);
        showToast("번역 결과를 복사했습니다.");
    })
    .addInto(resultFooter);

const modelPanel = view("y").class("model-panel").addInto(translatorLayout);
const engineChoice = select<TranslationEngine>([
    { value: "local", name: t("로컬 · 오프라인") },
    { value: "deepl", name: t("DeepL · 온라인") },
    { value: "google", name: t("Google · 온라인") },
])
    .class("select-control")
    .on("change", async () => {
        try {
            translationStatus = await window.openCapture.configureTranslation({
                engine: engineChoice.el.value as TranslationEngine,
            });
            renderTranslationStatus();
        } catch (error) {
            showToast(errorMessage(error), true);
        }
    });
modelPanel.add([engineChoice]);
const statusRow = view("x").class("status-row").addInto(modelPanel);
const modelStatusDot = ele("span").class("status-dot").addInto(statusRow);
const modelStatusText = label("strong", t("상태 확인 중")).addInto(statusRow);
const modelDetails = p(t("설치 상태를 확인하고 있습니다."))
    .class("model-details")
    .addInto(modelPanel);
const installButton = button()
    .class("primary-button", "wide")
    .attr({ type: "button" })
    .add([icon("⇩"), label("span", t("로컬 모델 설치"))])
    .on("click", () => installModels())
    .addInto(modelPanel);

const settingsLayout = view("y").class("settings-layout").addInto(settingsPage);
const storageCard = view("y").class("settings-card").addInto(settingsLayout);
storageCard.add([
    view("x")
        .class("settings-card-heading")
        .add(label("h2", t("저장 위치"))),
]);
const folderRow = view("x").class("folder-row").addInto(storageCard);
const folderPath = ele("code")
    .attr({ textContent: t("확인 중…") })
    .addInto(folderRow);
button(t("폴더 추가"))
    .class("outline-button")
    .attr({ type: "button" })
    .on("click", () => runAction("add-collection", undefined, true))
    .addInto(folderRow);

const convenienceCard = view("y")
    .class("settings-card")
    .addInto(settingsLayout);
convenienceCard.add(
    view("x")
        .class("settings-card-heading")
        .add(label("h2", t("빠른 실행"))),
);
const startAtLoginInput = input("checkbox").attr({
    ariaLabel: t("로그인할 때 OpenCapture 시작"),
});
startAtLoginInput.on("change", async () => {
    startAtLoginInput.el.disabled = true;
    await runAction("configure-runtime", {
        startAtLogin: startAtLoginInput.el.checked,
    });
    await refreshState();
    startAtLoginInput.el.disabled = false;
});
ele("label")
    .class("toggle-option", "login-toggle")
    .add([startAtLoginInput, label("strong", t("로그인할 때 시작"))])
    .addInto(convenienceCard);

const mouseChordSelect = select([
    { value: "关闭", name: t("끄기") },
    { value: "截屏", name: t("영역 캡처") },
    { value: "快速截屏", name: t("빠른 캡처") },
    { value: "录屏", name: t("화면 녹화") },
    { value: "起始页", name: t("시작 화면 열기") },
]).class("select-control", "chord-select");
mouseChordSelect.on("change", async () => {
    mouseChordSelect.el.disabled = true;
    await runAction("configure-runtime", {
        mouseChord: mouseChordSelect.el.value,
    });
    await refreshState();
    mouseChordSelect.el.disabled = false;
});
ele("label")
    .class("toggle-option")
    .attr({ title: t("왼쪽과 오른쪽 버튼을 함께 누르면 바로 실행됩니다.") })
    .add([
        view().class("option-icon").add(icon("◉")),
        label("strong", t("마우스 좌·우 동시 클릭")),
        mouseChordSelect,
    ])
    .addInto(convenienceCard);
const runtimeShortcutList = view("y")
    .class("runtime-shortcut-list")
    .addInto(convenienceCard);

const providerCard = view("y").class("settings-card").addInto(settingsLayout);
providerCard.add(
    view("x")
        .class("settings-card-heading")
        .add(label("h2", t("외부 번역 연결"))),
);
const providerForm = view("x").class("provider-form").addInto(providerCard);
const providerSelect = select([
    { value: "deepl", name: "DeepL" },
    { value: "google", name: "Google Translate" },
])
    .class("select-control")
    .addInto(providerForm);
const apiKeyInput = input("password")
    .class("text-control")
    .attr({ placeholder: t("새 API 키 입력"), autocomplete: "new-password" })
    .addInto(providerForm);
button(t("저장"))
    .class("primary-button")
    .attr({ type: "button" })
    .on("click", () => saveProvider())
    .addInto(providerForm);
const providerStatus = p(t("연결 상태를 확인하고 있습니다."))
    .class("helper-text")
    .addInto(providerCard);

const aboutCard = view("x")
    .class("settings-card", "about-card")
    .addInto(settingsLayout);
aboutCard.add([
    view("x").class("settings-card-heading").add(label("h2", "OpenCapture")),
    label("small", t("버전 확인 중")).class("version-pill"),
]);

const modalBackdrop = view()
    .class("modal-backdrop")
    .attr({ hidden: true })
    .addInto();
const shortcutDialog = ele("dialog")
    .class("shortcut-dialog")
    .addInto(modalBackdrop);
const shortcutHeader = view("x").class("dialog-header").addInto(shortcutDialog);
shortcutHeader.add([
    view("y").add(label("h2", t("단축키"))),
    button()
        .class("close-button")
        .attr({ type: "button", ariaLabel: t("닫기") })
        .add(icon("×"))
        .on("click", () => closeShortcutSheet()),
]);
const shortcutList = view("y").class("shortcut-list").addInto(shortcutDialog);
const shortcutDescriptions: Record<string, string> = {
    toggle: t("OpenCapture 열기"),
    capture: t("화면의 원하는 부분 선택"),
    record: t("영역을 선택해 녹화 시작"),
    dropzone: t("드래그 중 라이브러리 열기"),
    selection: t("선택된 텍스트 복사 후 번역"),
    restore: t("포커스와 클릭 통과 해제"),
};

function renderShortcutSheet() {
    shortcutList.clear();
    for (const sc of appState.runtime.shortcuts) {
        const keyText = sc.active ?? sc.requested ?? "";
        const keys = keyText
            ? formatShortcut(keyText).split(" + ")
            : [t("끄기")];
        shortcutList.add(
            view("x")
                .class("shortcut-row")
                .add([
                    view("y").add([
                        label("strong", sc.label),
                        label("small", shortcutDescriptions[sc.id] ?? ""),
                    ]),
                    view("x")
                        .class("key-group")
                        .add(
                            keys.map((key) =>
                                ele("kbd").attr({ textContent: key }),
                            ),
                        ),
                ]),
        );
    }
    const chordNames: Record<string, string> = {
        截屏: t("영역 캡처"),
        快速截屏: t("빠른 캡처"),
        录屏: t("화면 녹화"),
        起始页: t("시작 화면 열기"),
    };
    const chord = appState.runtime.mouseChord ?? "关闭";
    if (chord !== "关闭")
        shortcutList.add(
            view("x")
                .class("shortcut-row")
                .add([
                    view("y").add([
                        label("strong", t("마우스 좌·우 동시 클릭")),
                        label("small", chordNames[chord] ?? ""),
                    ]),
                    view("x")
                        .class("key-group")
                        .add([
                            ele("kbd").attr({ textContent: "L" }),
                            ele("kbd").attr({ textContent: "R" }),
                        ]),
                ]),
        );
}
button(t("닫기"))
    .class("primary-button", "wide")
    .attr({ type: "button" })
    .on("click", () => closeShortcutSheet())
    .addInto(shortcutDialog);

const renameDialog = ele("dialog")
    .class("shortcut-dialog", "form-dialog")
    .addInto(modalBackdrop);
renameDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add(label("h2", t("이름 바꾸기"))),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: t("닫기") })
                .add(icon("×"))
                .on("click", () => closeModal(renameDialog.el)),
        ]),
);
const renameInput = input("text")
    .class("text-control", "rename-input")
    .attr({
        maxLength: 100,
        ariaLabel: t("새 파일 이름"),
        placeholder: t("새 이름 입력"),
    })
    .addInto(renameDialog);
renameInput.on("keydown", (event) => {
    if (event.key === "Enter") void submitRename();
});
renameDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button(t("취소"))
                .class("text-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(renameDialog.el)),
            button(t("저장"))
                .class("primary-button")
                .attr({ type: "button" })
                .on("click", () => void submitRename()),
        ]),
);
renameDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(renameDialog.el);
});

const noteDialog = ele("dialog")
    .class("shortcut-dialog", "form-dialog")
    .addInto(modalBackdrop);
noteDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add(label("h2", t("메모"))),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: t("닫기") })
                .add(icon("×"))
                .on("click", () => closeModal(noteDialog.el)),
        ]),
);
const noteInput = textarea()
    .class("text-control", "note-input")
    .attr({
        maxLength: 2000,
        rows: 4,
        ariaLabel: t("메모 내용"),
        placeholder: t("예: 결제 화면 참고용, 보고서에 넣을 이미지"),
    })
    .addInto(noteDialog);
noteDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button(t("취소"))
                .class("text-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(noteDialog.el)),
            button(t("저장"))
                .class("primary-button")
                .attr({ type: "button" })
                .on("click", () => void submitNote()),
        ]),
);
noteDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(noteDialog.el);
});

const beautifyOptions = {
    padding: 56,
    radius: 16,
    shadow: 40,
    background: "auto",
    ratio: 0,
};
const beautifyBackgrounds: {
    id: string;
    name: string;
    css: string;
    fill: [string, string] | null;
}[] = [
    { id: "auto", name: t("이미지에서 추출"), css: "", fill: null },
    { id: "transparent", name: t("투명"), css: "", fill: null },
    {
        id: "sky",
        name: t("하늘"),
        css: "linear-gradient(135deg,#64F1E2,#79A7FF)",
        fill: ["#64F1E2", "#79A7FF"],
    },
    {
        id: "violet",
        name: t("보라"),
        css: "linear-gradient(135deg,#C1A9FF,#FF9BB8)",
        fill: ["#C1A9FF", "#FF9BB8"],
    },
    {
        id: "sunset",
        name: t("노을"),
        css: "linear-gradient(135deg,#FFBF83,#FF9BB8)",
        fill: ["#FFBF83", "#FF9BB8"],
    },
    {
        id: "night",
        name: t("밤"),
        css: "linear-gradient(135deg,#0B1526,#264D5E)",
        fill: ["#0B1526", "#264D5E"],
    },
    {
        id: "paper",
        name: t("종이"),
        css: "#F4F1EA",
        fill: ["#F4F1EA", "#E9E3D5"],
    },
];
const beautifyRatios: [string, number][] = [
    [t("자유"), 0],
    ["1:1", 1],
    ["4:5", 0.8],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
];

const beautifyDialog = ele("dialog")
    .class("shortcut-dialog", "beautify-dialog")
    .addInto(modalBackdrop);
beautifyDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add(label("h2", t("배경 꾸미기"))),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: t("닫기") })
                .add(icon("×"))
                .on("click", () => closeModal(beautifyDialog.el)),
        ]),
);
const beautifyBody = view("x").class("beautify-body").addInto(beautifyDialog);
const beautifyPreview = view().class("beautify-preview").addInto(beautifyBody);
const beautifyCanvas = ele("canvas").addInto(beautifyPreview);
const beautifyControls = view("y")
    .class("beautify-controls")
    .addInto(beautifyBody);

beautifyControls.add(label("small", t("비율")).class("control-label"));
const ratioChipRow = view("x", "wrap")
    .class("chip-row")
    .addInto(beautifyControls);
const ratioChips: HTMLButtonElement[] = [];
for (const [name, ratio] of beautifyRatios) {
    const chip = button(name)
        .class("chip-button", "ratio-chip", ratio === 0 ? "active" : "")
        .attr({ type: "button", ariaPressed: String(ratio === 0) })
        .on("click", () => {
            beautifyOptions.ratio = ratio;
            for (const chipEl of ratioChips) {
                const active = chipEl === chip.el;
                chipEl.classList.toggle("active", active);
                chipEl.setAttribute("aria-pressed", String(active));
            }
            renderBeautify();
        })
        .addInto(ratioChipRow);
    ratioChips.push(chip.el);
}

beautifyControls.add(label("small", t("배경")).class("control-label"));
const bgSwatchRow = view("x", "wrap")
    .class("swatch-row")
    .addInto(beautifyControls);
const bgSwatches: HTMLButtonElement[] = [];
for (const background of beautifyBackgrounds) {
    const swatch = button()
        .class(
            "bg-swatch",
            background.id === "auto" ? "auto" : "",
            background.id === "transparent" ? "checker" : "",
            background.id === "auto" ? "active" : "",
        )
        .attr({
            type: "button",
            title: background.name,
            ariaLabel: `배경 ${background.name}`,
            ariaPressed: String(background.id === "auto"),
        })
        .style(background.css ? { background: background.css } : {})
        .on("click", () => {
            beautifyOptions.background = background.id;
            for (const swatchEl of bgSwatches) {
                const active = swatchEl === swatch.el;
                swatchEl.classList.toggle("active", active);
                swatchEl.setAttribute("aria-pressed", String(active));
            }
            renderBeautify();
        });
    if (background.id === "auto") swatch.add(icon("✦"));
    if (background.id === "transparent") swatch.add(label("span", "α"));
    swatch.addInto(bgSwatchRow);
    bgSwatches.push(swatch.el);
}

function beautifySlider(
    title: string,
    min: number,
    max: number,
    value: number,
    apply: (v: number) => void,
) {
    const valueLabel = label("small", String(value)).class("slider-value");
    const range = input("range")
        .attr({
            min: String(min),
            max: String(max),
            value: String(value),
            ariaLabel: title,
        })
        .on("input", () => {
            const v = Number(range.el.value);
            valueLabel.el.textContent = String(v);
            apply(v);
            renderBeautify();
        });
    view("y")
        .class("slider-group")
        .add([
            view("x")
                .class("slider-row")
                .add([label("span", title).class("slider-title"), valueLabel]),
            range,
        ])
        .addInto(beautifyControls);
}
beautifySlider(t("여백"), 0, 200, beautifyOptions.padding, (v) => {
    beautifyOptions.padding = v;
});
beautifySlider(t("둥글기"), 0, 120, beautifyOptions.radius, (v) => {
    beautifyOptions.radius = v;
});
beautifySlider(t("그림자"), 0, 120, beautifyOptions.shadow, (v) => {
    beautifyOptions.shadow = v;
});

beautifyDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button()
                .class("outline-button")
                .attr({ type: "button" })
                .add([icon("▣"), label("span", t("이미지 복사"))])
                .on("click", () => void copyCanvas(beautifyCanvas.el)),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("⇩"), label("span", t("컬렉션에 저장"))])
                .on("click", () => void saveBeautified()),
        ]),
);
beautifyDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(beautifyDialog.el);
});

const upscaleOptions = { scale: 2, sharpen: true };
const upscaleScales = [2, 3, 4];

const upscaleDialog = ele("dialog")
    .class("shortcut-dialog", "beautify-dialog")
    .addInto(modalBackdrop);
upscaleDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add(label("h2", t("업스케일"))),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: t("닫기") })
                .add(icon("×"))
                .on("click", () => closeModal(upscaleDialog.el)),
        ]),
);
const upscaleBody = view("x").class("beautify-body").addInto(upscaleDialog);
const upscalePreview = view().class("beautify-preview").addInto(upscaleBody);
const upscaleCanvas = ele("canvas").addInto(upscalePreview);
const upscaleControls = view("y")
    .class("beautify-controls")
    .addInto(upscaleBody);

upscaleControls.add(label("small", t("배율")).class("control-label"));
const upscaleChipRow = view("x", "wrap")
    .class("chip-row")
    .addInto(upscaleControls);
const upscaleChips: HTMLButtonElement[] = [];
for (const scale of upscaleScales) {
    const chip = button(`${scale}×`)
        .class("chip-button", "ratio-chip", scale === 2 ? "active" : "")
        .attr({ type: "button", ariaPressed: String(scale === 2) })
        .on("click", () => {
            upscaleOptions.scale = scale;
            for (const chipEl of upscaleChips) {
                const active = chipEl === chip.el;
                chipEl.classList.toggle("active", active);
                chipEl.setAttribute("aria-pressed", String(active));
            }
            renderUpscale();
        })
        .addInto(upscaleChipRow);
    upscaleChips.push(chip.el);
}
const sharpenInput = input("checkbox").attr({ ariaLabel: t("선명하게") });
sharpenInput.el.checked = true;
const sharpenRow = view("x")
    .class("slider-row", "check-row")
    .add([label("span", t("선명하게")).class("slider-title"), sharpenInput])
    .addInto(upscaleControls);
sharpenInput.on("change", () => {
    upscaleOptions.sharpen = sharpenInput.el.checked;
    renderUpscale();
});
const upscaleInfo = label("small", "").class("upscale-info");
upscaleControls.add(upscaleInfo);
const upscaleError = label("small", "").class("upscale-error");
upscaleControls.add(upscaleError);

upscaleDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button()
                .class("outline-button")
                .attr({ type: "button" })
                .add([icon("▣"), label("span", t("이미지 복사"))])
                .on("click", () => {
                    const target = upscaleTarget;
                    if (!target) return;
                    if (upscaleOversized()) {
                        upscaleError.el.textContent = t(
                            "결과 크기가 너무 큽니다. 배율을 낮춰 주세요.",
                        );
                        return;
                    }
                    void copyCanvas(upscaleFull(target));
                }),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("⇩"), label("span", t("컬렉션에 저장"))])
                .on("click", () => void saveUpscaled()),
        ]),
);
upscaleDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(upscaleDialog.el);
});

const foldDialog = ele("dialog").class("fold-dialog").addInto(modalBackdrop);
const foldHeader = view("x").class("dialog-header").addInto(foldDialog);
const foldTitle = view("y").addInto(foldHeader);
foldTitle.add([label("h2", t("중간 접기"))]);
button()
    .class("close-button")
    .attr({ type: "button", ariaLabel: t("닫기") })
    .add(icon("×"))
    .on("click", () => closeModal(foldDialog.el))
    .addInto(foldHeader);
const foldStage = view().class("fold-stage").addInto(foldDialog);
const foldImgWrap = view().class("fold-image-wrap").addInto(foldStage);
const foldImage = ele("img")
    .class("fold-image")
    .attr({ alt: "" })
    .addInto(foldImgWrap);
const foldShade = view().class("fold-shade").addInto(foldImgWrap);
const foldControls = view("y").class("fold-controls").addInto(foldDialog);
const foldStartInput = input("range")
    .attr({
        min: "0",
        max: "95",
        value: "30",
        step: "1",
        ariaLabel: t("접기 시작"),
    })
    .addInto(foldControls);
const foldEndInput = input("range")
    .attr({
        min: "5",
        max: "100",
        value: "70",
        step: "1",
        ariaLabel: t("접기 끝"),
    })
    .addInto(foldControls);
const foldInfo = label("small", "").class("fold-info").addInto(foldControls);
foldDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button(t("취소"))
                .class("outline-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(foldDialog.el)),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("⬍"), label("span", t("접어서 저장"))])
                .on("click", () => void applyFold()),
        ]),
);
foldDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(foldDialog.el);
});

const gifDialog = ele("dialog").class("fold-dialog").addInto(modalBackdrop);
const gifHeader = view("x").class("dialog-header").addInto(gifDialog);
const gifTitle = view("y").addInto(gifHeader);
gifTitle.add([label("h2", t("GIF 트림"))]);
button()
    .class("close-button")
    .attr({ type: "button", ariaLabel: t("닫기") })
    .add(icon("×"))
    .on("click", () => closeModal(gifDialog.el))
    .addInto(gifHeader);
const gifStage = view().class("fold-stage").addInto(gifDialog);
const gifCanvas = ele("canvas").class("gif-canvas").addInto(gifStage);
const gifControls = view("y").class("fold-controls").addInto(gifDialog);
const gifStartInput = input("range")
    .attr({
        min: "0",
        max: "1",
        value: "0",
        step: "1",
        ariaLabel: t("시작 프레임"),
    })
    .on("input", () => void renderGifPreview())
    .addInto(gifControls);
const gifEndInput = input("range")
    .attr({
        min: "0",
        max: "1",
        value: "1",
        step: "1",
        ariaLabel: t("끝 프레임"),
    })
    .on("input", () => void renderGifPreview())
    .addInto(gifControls);
const gifInfo = label("small", "").class("fold-info").addInto(gifControls);
gifDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button(t("취소"))
                .class("outline-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(gifDialog.el)),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("≣"), label("span", t("GIF로 저장"))])
                .on("click", () => void applyGifTrim()),
        ]),
);
gifDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(gifDialog.el);
});
let gifTarget: { id: string; decoder: GifDecoder; count: number } | null = null;
let gifPreviewRequest = 0;

const quickLookDialog = ele("dialog")
    .class("quicklook-dialog")
    .addInto(modalBackdrop);
const qlHeader = view("x")
    .class("dialog-header", "ql-header")
    .addInto(quickLookDialog);
const qlTitle = view("y").class("ql-title").addInto(qlHeader);
const qlName = label("h2", "").addInto(qlTitle);
const qlMeta = label("small", "").addInto(qlTitle);
button()
    .class("close-button")
    .attr({ type: "button", ariaLabel: t("닫기") })
    .add(icon("×"))
    .on("click", () => closeModal(quickLookDialog.el))
    .addInto(qlHeader);
const qlBody = view("x").class("ql-body").addInto(quickLookDialog);
const qlStage = view().class("ql-stage").addInto(qlBody);
const qlImageWrap = view().class("ql-image-wrap").addInto(qlStage);
const qlImage = ele("img")
    .class("ql-image")
    .attr({ alt: "" })
    .addInto(qlImageWrap);
const qlCropOverlay = view().class("ql-crop-overlay").addInto(qlImageWrap);
qlCropOverlay.el.hidden = true;
const qlCropRect = view().class("ql-crop-rect").addInto(qlCropOverlay);
qlCropRect.el.hidden = true;
const qlCropBar = view("x").class("ql-crop-bar").addInto(qlStage);
qlCropBar.el.hidden = true;
qlCropBar.add([
    button(t("자르기 적용"))
        .class("primary-button", "compact")
        .attr({ type: "button" })
        .on("click", () => void applyQlCrop()),
    button(t("취소"))
        .class("outline-button", "compact")
        .attr({ type: "button" })
        .on("click", () => exitQlCrop()),
]);
const qlPrev = button()
    .class("ql-nav", "ql-prev")
    .attr({ type: "button", ariaLabel: t("이전 캡처") })
    .add(label("span", "‹"))
    .on("click", () => quickLookNavigate(-1))
    .addInto(qlStage);
const qlNext = button()
    .class("ql-nav", "ql-next")
    .attr({ type: "button", ariaLabel: t("다음 캡처") })
    .add(label("span", "›"))
    .on("click", () => quickLookNavigate(1))
    .addInto(qlStage);
const qlSide = view("y").class("ql-side").addInto(qlBody);
const qlActions = view("x", "wrap").class("ql-actions").addInto(qlSide);
const qlActionList: [string, string, (item: OpenCaptureItem) => void][] = [
    ["▣", t("복사"), (item) => runAction("copy-item", item.id)],
    ["⌖", t("고정"), (item) => runAction("pin-item", item.id)],
    ["✎", t("주석·편집"), (item) => runAction("open-item", item.id)],
    ["⌗", t("자르기"), () => startQlCrop()],
    ["⬍", t("중간 접기"), (item) => void openFold(item)],
    [
        "≣",
        t("GIF 트림"),
        (item) => {
            if (!isGifItem(item)) {
                showToast("GIF 항목에서만 사용할 수 있습니다.", true);
                return;
            }
            void openGifTrim(item);
        },
    ],
    ["▨", t("꾸미기"), (item) => void openBeautify(item)],
    ["⤢", t("업스케일"), (item) => void openUpscale(item)],
    ["✧", t("AI 업스케일"), (item) => runAiUpscale(item)],
    ["☰", t("메모"), (item) => openNote(item)],
    ["✦", t("배경 제거"), (item) => runAction("remove-background", item.id)],
    ["T", t("이름"), (item) => openRename(item)],
    ["⧉", t("복제"), (item) => runAction("duplicate-item", item.id)],
    ["▤", t("폴더"), (item) => runAction("reveal-item", item.id)],
];
for (const [glyph, text, run] of qlActionList) {
    button()
        .class("ql-action")
        .attr({ type: "button" })
        .add([icon(glyph), label("small", text)])
        .on("click", () => {
            const item = appState.items.find((i) => i.id === quickLookId);
            if (item) run(item);
        })
        .addInto(qlActions);
}
qlSide.add(label("small", t("태그")).class("eyebrow", "ql-eyebrow"));
const qlTags = view("x", "wrap").class("ql-tags").addInto(qlSide);
const qlTagInput = input("text")
    .class("text-control", "tag-input")
    .attr({
        placeholder: t("태그 입력 후 Enter"),
        maxLength: 30,
        ariaLabel: t("태그 추가"),
    })
    .addInto(qlSide);
qlTagInput.on("keydown", async (event) => {
    event.stopPropagation();
    const item = appState.items.find((i) => i.id === quickLookId);
    if (!item) return;
    if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        const value = qlTagInput.el.value.trim();
        if (!value) return;
        qlTagInput.el.value = "";
        const tags = [...(item.tags ?? []), value];
        await runItemEdit(
            ["set-tags", { id: item.id, tags }],
            ["set-tags", { id: item.id, tags: item.tags ?? [] }],
        );
    } else if (
        event.key === "Backspace" &&
        !qlTagInput.el.value &&
        item.tags?.length
    ) {
        const tags = item.tags.slice(0, -1);
        await runItemEdit(
            ["set-tags", { id: item.id, tags }],
            ["set-tags", { id: item.id, tags: item.tags }],
        );
    }
});
const qlTagSuggest = view("x", "wrap").class("tag-suggest").addInto(qlSide);
qlSide.add(label("small", t("인식된 텍스트")).class("eyebrow", "ql-eyebrow"));
const qlOcrStatus = label("small", "").addInto(qlSide);
const qlOcrText = ele("pre").class("ql-ocr-text").addInto(qlSide);
const qlOcrActions = view("x").class("ql-ocr-actions").addInto(qlSide);
button()
    .class("outline-button", "compact")
    .attr({ type: "button" })
    .add([icon("▣"), label("span", t("텍스트 복사"))])
    .on("click", async () => {
        const item = appState.items.find((i) => i.id === quickLookId);
        if (!item?.ocrText) return;
        await navigator.clipboard.writeText(item.ocrText);
        showToast("인식된 텍스트를 복사했습니다.");
    })
    .addInto(qlOcrActions);
button()
    .class("text-button", "compact")
    .attr({ type: "button" })
    .add([icon("T"), label("span", t("텍스트 인식"))])
    .on("click", async () => {
        const item = appState.items.find((i) => i.id === quickLookId);
        if (!item) return;
        await requestOcrIndex(item.id);
        renderQuickLook();
    })
    .addInto(qlOcrActions);
quickLookDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(quickLookDialog.el);
});

const onboardDialog = ele("dialog")
    .class("onboard-dialog")
    .addInto(modalBackdrop);
onboardDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add(label("h2", t("OpenCapture 시작하기"))),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: t("닫기") })
                .add(icon("×"))
                .on("click", () => closeOnboarding()),
        ]),
);
const onboardGrid = view("x", "wrap")
    .class("onboard-grid")
    .addInto(onboardDialog);
const onboardCaptureKeys = view("x")
    .class("key-group", "onboard-keys")
    .addInto(
        view("y")
            .class("onboard-card")
            .attr({ title: t("언제든 이 단축키로 화면을 선택하세요.") })
            .add([
                view().class("onboard-icon").add(icon("⌗")),
                label("strong", t("한 번에 캡처")),
            ])
            .addInto(onboardGrid),
    );
const onboardChordCard = view("y")
    .class("onboard-card")
    .attr({ title: t("좌·우 버튼을 함께 누르면 캡처가 시작됩니다.") })
    .add([
        view().class("onboard-icon").add(icon("◉")),
        label("strong", t("마우스로도 바로")),
    ])
    .addInto(onboardGrid);
const onboardChordButton = button(t("지금 켜기"))
    .class("outline-button", "compact")
    .attr({ type: "button" })
    .on("click", async () => {
        onboardChordButton.el.disabled = true;
        await runAction("configure-runtime", { mouseChord: "截屏" });
        await refreshState();
        onboardChordButton.el.textContent = t("켜짐");
    })
    .addInto(onboardChordCard);
view("y")
    .class("onboard-card")
    .attr({
        title: t(
            "캡처 하나로 복사·고정·주석·번역·업스케일·태그·검색까지 바로 이어집니다.",
        ),
    })
    .add([
        view().class("onboard-icon").add(icon("✦")),
        label("strong", t("한 장에서 모두")),
    ])
    .addInto(onboardGrid);
button(t("시작하기"))
    .class("primary-button", "wide")
    .attr({ type: "button" })
    .on("click", () => closeOnboarding())
    .addInto(onboardDialog);
onboardDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeOnboarding();
});

function renderOnboarding() {
    onboardCaptureKeys.clear();
    const capture = appState.runtime.shortcuts.find((s) => s.id === "capture");
    const keyText = capture?.active ?? capture?.requested ?? "";
    for (const key of (keyText ? formatShortcut(keyText) : "—").split(" + "))
        onboardCaptureKeys.add(ele("kbd").attr({ textContent: key }));
    onboardChordButton.el.disabled =
        appState.runtime.mouseChord !== undefined &&
        appState.runtime.mouseChord !== "关闭";
    if (onboardChordButton.el.disabled)
        onboardChordButton.el.textContent = t("켜짐");
}

function openOnboarding() {
    renderOnboarding();
    openModal(onboardDialog.el);
}

function closeOnboarding() {
    localStorage.setItem("oc:onboarded", "1");
    closeModal(onboardDialog.el);
}

modalBackdrop.on("click", (event) => {
    if (event.target === modalBackdrop.el) closeAllModals();
});
shortcutDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeShortcutSheet();
});

const toast = ele("div")
    .class("toast")
    .attr({ role: "status", ariaLive: "polite" })
    .addInto();
const toastText = ele("span").addInto(toast);
const toastActions = view("x").class("toast-actions").addInto(toast);
let toastTimer = 0;
const srToast = ele("div")
    .class("toast", "sr-toast")
    .attr({ role: "status", ariaLive: "polite" })
    .addInto();
const srToastText = ele("span").addInto(srToast);

function runAiUpscale(item: OpenCaptureItem) {
    srToastText.el.textContent = t("AI 업스케일을 준비하고 있습니다…");
    srToast.el.classList.add("visible");
    void runAction("ai-upscale", item.id).then(() => {
        srToast.el.classList.remove("visible");
    });
}

function showPage(page: PageName) {
    activePage = page;
    const titles: Record<PageName, string> = {
        home: t("캡처"),
        library: t("라이브러리"),
        translate: t("번역"),
        settings: t("설정"),
    };
    for (const [name, element] of pages)
        element.classList.toggle("active", name === page);
    for (const [name, element] of navButtons)
        element.classList.toggle("active", name === page);
    pageTitle.el.textContent = titles[page];
    content.el.scrollTop = 0;
    if (page === "translate") refreshTranslationStatus();
}

async function runAction(
    name: OpenCaptureActionName,
    payload?: unknown,
    refresh = false,
) {
    try {
        const result = await window.openCapture.action(name, payload);
        if (isState(result)) appState = result;
        else if (refresh) await refreshState();
        renderState();
        return true;
    } catch (error) {
        showToast(errorMessage(error), true);
        return false;
    }
}

type ItemEditAction = [OpenCaptureActionName, unknown];

async function runItemEdit(apply: ItemEditAction, undo: ItemEditAction | null) {
    try {
        const result = await window.openCapture.action(apply[0], apply[1]);
        if (isState(result)) appState = result;
        renderState();
        if (undo)
            showToast("적용했습니다.", false, [
                [
                    t("되돌리기"),
                    () => {
                        void (async () => {
                            try {
                                const restored =
                                    await window.openCapture.action(
                                        undo[0],
                                        undo[1],
                                    );
                                if (isState(restored)) appState = restored;
                                renderState();
                            } catch (error) {
                                showToast(errorMessage(error), true);
                            }
                        })();
                    },
                ],
            ]);
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function toggleSteps() {
    const was = appState.runtime.stepCapture ?? false;
    await runAction("steps", undefined, true);
    if ((appState.runtime.stepCapture ?? false) && !was)
        showToast(
            t(
                "클릭할 때마다 화면이 저장됩니다. 카드를 다시 누르면 중지합니다.",
            ),
        );
}

async function composeLayout(
    ids: string[],
    mode: "steps" | "compare" | "timeline",
) {
    const ordered = ids
        .map((id) => appState.items.find((i) => i.id === id))
        .filter((i): i is OpenCaptureItem => Boolean(i))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, 20);
    if (ordered.length < 2) return;
    try {
        const images: HTMLImageElement[] = [];
        for (const item of ordered) {
            const data = await window.openCapture.getItemData(item.id);
            const img = new Image();
            img.src = data;
            await img.decode();
            images.push(img);
        }
        const gap = 28;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        if (mode === "steps") {
            const width = Math.max(...images.map((i) => i.naturalWidth), 1);
            const scaled = images.map((img) => ({
                img,
                h: Math.round((img.naturalHeight * width) / img.naturalWidth),
            }));
            canvas.width = width;
            canvas.height = scaled.reduce((sum, i) => sum + i.h + gap, gap);
            ctx.fillStyle = "#f4f4f5";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            let y = gap;
            scaled.forEach(({ img, h }, index) => {
                ctx.drawImage(img, 0, y, width, h);
                drawBadge(ctx, 14, y + 14, String(index + 1));
                y += h + gap;
            });
        } else {
            const height = Math.max(...images.map((i) => i.naturalHeight), 1);
            const scaled = images.map((img) => ({
                img,
                w: Math.round((img.naturalWidth * height) / img.naturalHeight),
            }));
            canvas.height = height + gap * 2;
            canvas.width = scaled.reduce((sum, i) => sum + i.w + gap, gap);
            ctx.fillStyle = "#f4f4f5";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            let x = gap;
            scaled.forEach(({ img, w }, index) => {
                if (mode === "timeline" && index > 0) {
                    ctx.strokeStyle = "#94a3b8";
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(x - gap + 6, canvas.height / 2);
                    ctx.lineTo(x - 6, canvas.height / 2);
                    ctx.stroke();
                }
                ctx.drawImage(img, x, gap, w, height);
                drawBadge(
                    ctx,
                    x + 14,
                    gap + 14,
                    mode === "compare"
                        ? String.fromCharCode(65 + index)
                        : String(index + 1),
                );
                x += w + gap;
            });
        }
        if (
            await runAction("save-composed", {
                id: ordered[0].id,
                dataURL: canvas.toDataURL("image/png"),
                label: "Steps",
            })
        )
            showToast("합성 이미지를 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function importFiles(files: File[]) {
    try {
        appState = await window.openCapture.importFiles(files);
        renderState();
        showToast(`${files.length}개 이미지를 가져왔습니다.`);
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

let shortcutWarned = false;

async function refreshState() {
    try {
        appState = await window.openCapture.getState();
        if (appState.recoveryWarning) showToast(appState.recoveryWarning, true);
        if (!shortcutWarned) {
            shortcutWarned = true;
            const failed = appState.runtime.shortcuts.filter(
                (s) => !s.available && s.requested,
            );
            if (failed.length)
                showToast(
                    `단축키 등록 실패: ${failed.map((s) => s.label).join(", ")}. 다른 앱이 점유 중입니다. 설정에서 다시 지정하세요.`,
                    true,
                );
        }
        const previewId = appState.previewItemId;
        renderState();
        if (previewId) void openPreviewById(previewId);
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function openPreviewById(id: string) {
    if (!appState.items.some((i) => i.id === id)) {
        try {
            appState = await window.openCapture.getState();
            renderState();
        } catch {
            return;
        }
    }
    const item = appState.items.find((i) => i.id === id);
    if (item) openQuickLook(item);
}

function renderState() {
    const activeCollection =
        appState.collections.find(
            (collection) => collection.id === appState.activeCollectionId,
        ) ?? appState.collections[0];

    collectionSelect.clear();
    if (!appState.collections.length) {
        collectionSelect.add(
            ele("option").attr({
                value: "",
                textContent: t("컬렉션 없음"),
                disabled: true,
                selected: true,
            }),
        );
    } else {
        for (const collection of appState.collections) {
            collectionSelect.add(
                ele("option").attr({
                    value: collection.id,
                    textContent: collection.name,
                }),
            );
        }
        collectionSelect.el.value = activeCollection?.id ?? "";
    }

    folderPath.el.textContent =
        activeCollection?.path ||
        appState.defaultFolder ||
        t("저장 폴더가 설정되지 않았습니다.");
    versionLabel.el.textContent = appState.version
        ? `OpenCapture ${appState.version}`
        : "OpenCapture";
    const versionPill =
        aboutCard.el.querySelector<HTMLElement>(".version-pill");
    if (versionPill)
        versionPill.textContent = appState.version
            ? `v${appState.version}`
            : t("개발 버전");

    const visibleItems = visibleLibraryItems();
    const filtered = isLibraryFiltered();
    libraryTitle.el.textContent = activeCollection?.name ?? t("저장된 캡처");
    itemCount.el.textContent = filtered
        ? `${visibleItems.length}개 표시 · 전체 ${appState.totalItemCount}개`
        : appState.totalItemCount > appState.items.length
          ? `${visibleItems.length}개 표시 · 전체 ${appState.totalItemCount}개`
          : `${visibleItems.length}개`;
    for (const [key, checkbox] of workflowInputs)
        checkbox.checked = appState.workflow[key];
    startAtLoginInput.el.checked = appState.runtime.startAtLogin;
    renderRuntimeShortcuts();
    const selectedCount = selectedItemIds.size;
    selectionStatus.el.textContent = selectedCount
        ? `${selectedCount}개 선택됨`
        : t("선택 없음");
    selectionToolbar.el.classList.toggle("has-selection", selectedCount > 0);
    clearSelectionButton.el.disabled = !selectedCount;
    clearSelectionButton.el.hidden = !selectedCount;
    selectDisplayedButton.el.disabled =
        !visibleItems.length ||
        visibleItems.every((item) => selectedItemIds.has(item.id));
    for (const action of selectionToolbar.el.querySelectorAll<HTMLButtonElement>(
        ".bulk-action",
    ))
        action.disabled = !selectedCount;
    for (const action of selectionToolbar.el.querySelectorAll<HTMLButtonElement>(
        ".combine-action",
    ))
        action.disabled = selectedCount < 2 || selectedCount > 20;
    loadMoreButton.el.hidden = appState.items.length >= appState.totalItemCount;
    loadMoreButton.el.textContent = `더 불러오기 (${appState.items.length}/${appState.totalItemCount})`;
    const stepsCard = homePage.el.querySelector<HTMLElement>(
        '[data-action="steps"]',
    );
    if (stepsCard) {
        const running = appState.runtime.stepCapture ?? false;
        stepsCard.classList.toggle("active", running);
        const title = stepsCard.querySelector<HTMLElement>("h3");
        if (title) title.textContent = running ? t("중지") : t("단계 캡처");
    }
    pinSetRow.clear();
    const sets = appState.pinSets ?? [];
    pinSetRow.el.style.display = sets.length ? "" : "none";
    if (sets.length)
        pinSetRow.add(
            label("small", t("핀 세트")).class("eyebrow", "pinset-heading"),
        );
    for (const set of sets) {
        pinSetRow.add(
            view("x")
                .class("pinset-chip")
                .add([
                    button()
                        .class("pinset-run")
                        .attr({
                            type: "button",
                            title: `${set.name} — ${set.itemIds.length}장을 화면에 고정`,
                        })
                        .add([
                            icon("◇"),
                            label(
                                "span",
                                `${set.name} · ${set.itemIds.length}장`,
                            ),
                        ])
                        .on("click", () =>
                            runAction("pin-set", { id: set.id }),
                        ),
                    button("×")
                        .class("pinset-remove")
                        .attr({
                            type: "button",
                            title: `${set.name} 세트 삭제`,
                        })
                        .on("click", () =>
                            runAction("remove-pin-set", { id: set.id }),
                        ),
                ]),
        );
    }
    todayChip.el.classList.toggle("active", todayOnly);
    todayChip.attr({ ariaPressed: String(todayOnly) });
    ocrChip.el.classList.toggle("active", ocrOnly);
    ocrChip.attr({ ariaPressed: String(ocrOnly) });
    sortSelect.el.value = sortMode;
    sizeSegment.el
        .querySelectorAll<HTMLButtonElement>(".size-segment-button")
        .forEach((seg, index) => {
            const pressed = ["s", "m", "l"][index] === thumbSize;
            seg.classList.toggle("active", pressed);
            seg.setAttribute("aria-pressed", String(pressed));
        });
    itemGrid.el.dataset.size = thumbSize;
    renderTagChips();
    renderItems(visibleItems);
    if (quickLookDialog.el.open) renderQuickLook();
}

function visibleLibraryItems() {
    const activeCollection =
        appState.collections.find(
            (collection) => collection.id === appState.activeCollectionId,
        ) ?? appState.collections[0];
    let items = activeCollection
        ? appState.items.filter(
              (item) => item.collectionId === activeCollection.id,
          )
        : appState.items;
    if (favoritesOnly) items = items.filter((item) => item.favorite);
    if (todayOnly) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const startTime = start.getTime();
        items = items.filter((item) => Date.parse(item.createdAt) >= startTime);
    }
    if (ocrOnly) items = items.filter((item) => item.ocrDone);
    if (activeTag)
        items = items.filter((item) => item.tags?.includes(activeTag ?? ""));
    if (searchQuery)
        items = items.filter((item) =>
            `${item.name} ${item.note ?? ""} ${item.ocrText ?? ""} ${(item.tags ?? []).join(" ")}`
                .toLowerCase()
                .includes(searchQuery),
        );
    if (sortMode === "old") items = [...items].reverse();
    else if (sortMode === "name")
        items = [...items].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return items;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);
async function rebindShortcut(
    shortcut: OpenCaptureShortcut,
    key: string | null,
) {
    if (key) {
        const clash = appState.runtime.shortcuts.find(
            (s) =>
                s.id !== shortcut.id &&
                (s.active === key || (s.custom ?? s.requested) === key),
        );
        if (clash) {
            showToast(
                `${clash.label}에 이미 등록된 단축키입니다. 다른 키를 눌러 주세요.`,
                true,
            );
            return;
        }
    }
    try {
        await window.openCapture.action("configure-runtime", {
            shortcuts: { [shortcut.id]: key },
        });
    } catch (error) {
        showToast(errorMessage(error), true);
        return;
    }
    await refreshState();
    const next = appState.runtime.shortcuts.find((s) => s.id === shortcut.id);
    const ok =
        key === null
            ? true
            : key === ""
              ? next?.active === null && next?.custom === ""
              : next?.active === key;
    if (!ok)
        showToast(
            `${shortcut.label} 단축키를 등록하지 못했습니다. 다른 키를 사용해 주세요.`,
            true,
        );
}

function shortcutEditor(shortcut: OpenCaptureShortcut) {
    const field = input("text")
        .class("shortcut-edit")
        .attr({
            readOnly: true,
            value: shortcut.custom ?? shortcut.requested ?? "",
            placeholder: t("단축키 없음"),
            ariaLabel: `${shortcut.label} 단축키`,
            title: t(
                "클릭 후 새 단축키를 누르세요. Backspace는 끄기, Esc는 취소",
            ),
        });
    const reset = button()
        .class("shortcut-reset")
        .attr({
            type: "button",
            ariaLabel: t("기본값으로 되돌리기"),
            title: t("기본값"),
        })
        .add(label("span", "↺"))
        .on("click", () => void rebindShortcut(shortcut, null));
    field.on("keydown", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
            field.el.value = shortcut.custom ?? shortcut.requested ?? "";
            field.el.blur();
            return;
        }
        if (
            e.key === "Backspace" &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.shiftKey &&
            !e.metaKey
        ) {
            field.el.value = "";
            field.el.blur();
            await rebindShortcut(shortcut, "");
            return;
        }
        if (MODIFIER_KEYS.has(e.key)) return;
        const accel = acceleratorFromEvent(e);
        if (!accel) {
            field.el.classList.add("invalid");
            setTimeout(() => field.el.classList.remove("invalid"), 400);
            return;
        }
        field.el.value = accel;
        field.el.blur();
        await rebindShortcut(shortcut, accel);
    });
    field.on("blur", () => {
        if (!field.el.value && (shortcut.custom ?? shortcut.requested))
            field.el.value = shortcut.custom ?? shortcut.requested ?? "";
    });
    const status = !shortcut.available
        ? `충돌 · ${formatShortcut(shortcut.requested)}`
        : shortcut.active === null
          ? t("꺼짐")
          : shortcut.custom != null
            ? `기본: ${formatShortcut(shortcut.default || shortcut.requested || "—")}`
            : formatShortcut(shortcut.active);
    return view("x")
        .class("runtime-shortcut-row")
        .add([
            view("y").add([
                label("strong", shortcut.label),
                label("small", status),
            ]),
            field,
            reset,
        ]);
}

function renderRuntimeShortcuts() {
    runtimeShortcutList.clear();
    mouseChordSelect.el.value = appState.runtime.mouseChord ?? "关闭";
    if (!appState.runtime.shortcuts.length) {
        runtimeShortcutList.add(p(t("등록된 시스템 단축키가 없습니다.")));
        return;
    }
    for (const shortcut of appState.runtime.shortcuts)
        runtimeShortcutList.add(shortcutEditor(shortcut));
}

function renderItems(items: OpenCaptureItem[]) {
    itemGrid.clear();
    if (!items.length) {
        const filtered = isLibraryFiltered();
        itemGrid.add(
            filtered
                ? view("y")
                      .class("empty-state")
                      .add([
                          view().class("empty-icon").add(icon("⌕")),
                          label("h3", t("조건에 맞는 캡처가 없어요")),
                          p(
                              t(
                                  "검색어를 바꾸거나 즐겨찾기 필터를 해제해 보세요.",
                              ),
                          ),
                      ])
                : view("y")
                      .class("empty-state")
                      .add([
                          view().class("empty-icon").add(icon("▧")),
                          label("h3", t("아직 저장된 캡처가 없어요")),
                          p(
                              t(
                                  "새로 캡처하거나 이미지를 가져오면 여기에 모입니다.",
                              ),
                          ),
                          button(t("첫 캡처 시작"))
                              .class("primary-button")
                              .attr({ type: "button" })
                              .on("click", () => runAction("capture")),
                      ]),
        );
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const [itemIndex, item] of items.entries()) {
        const thumbnail = view().class("item-thumbnail");
        if (item.thumbnail) {
            thumbnail.add(
                ele("img")
                    .attr({
                        src: item.thumbnail,
                        alt: "",
                        loading: "lazy",
                        decoding: "async",
                    })
                    .on("error", (_event, image) => image.el.remove()),
            );
        } else if (isVideoItem(item)) {
            thumbnail.add(view().class("item-video-badge").add(icon("v")));
        }
        const selectionInput = input("checkbox")
            .class("item-select")
            .attr({
                ariaLabel: `${item.name} 선택`,
                title: `${item.name} 선택`,
            });
        selectionInput.el.checked = selectedItemIds.has(item.id);
        selectionInput
            .on("click", (event) => {
                event.stopPropagation();
                if (event.shiftKey && lastSelectIndex !== null) {
                    event.preventDefault();
                    const [from, to] = [
                        Math.min(lastSelectIndex, itemIndex),
                        Math.max(lastSelectIndex, itemIndex),
                    ];
                    for (const range of items.slice(from, to + 1))
                        selectedItemIds.add(range.id);
                    renderState();
                }
            })
            .on("change", (event) => {
                event.stopPropagation();
                lastSelectIndex = itemIndex;
                if (selectionInput.el.checked) selectedItemIds.add(item.id);
                else selectedItemIds.delete(item.id);
                renderState();
            });
        const favButton = button()
            .class("fav-button", item.favorite ? "active" : "")
            .attr({
                type: "button",
                ariaLabel: `${item.name} 즐겨찾기`,
                ariaPressed: String(Boolean(item.favorite)),
                title: item.favorite ? t("즐겨찾기 해제") : t("즐겨찾기"),
            })
            .add(icon("★"))
            .on("click", (event) => {
                event.stopPropagation();
                void runAction("toggle-favorite", item.id);
            });
        const itemCard = view("y")
            .class("item-card", selectedItemIds.has(item.id) ? "selected" : "")
            .attr({ draggable: true, tabIndex: 0 })
            .on("dragstart", (event) => {
                event.preventDefault();
                window.openCapture.startDrag(item.id);
            })
            .on("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openQuickLook(item);
                }
            })
            .add([
                selectionInput,
                favButton,
                thumbnail.on("dblclick", () => runAction("open-item", item.id)),
                view("x")
                    .class("item-info")
                    .add([
                        view("y").add([
                            label("strong", item.name),
                            label("small", formatDate(item.createdAt)),
                            ...(item.note
                                ? [label("small", item.note).class("item-note")]
                                : []),
                            ...(item.tags?.length
                                ? [
                                      label(
                                          "small",
                                          item.tags
                                              .map((tag) => `#${tag}`)
                                              .join(" "),
                                      ).class("item-tags"),
                                  ]
                                : []),
                        ]),
                        button()
                            .class("more-button")
                            .attr({
                                type: "button",
                                ariaLabel: `${item.name} 메뉴`,
                            })
                            .add(icon("•••"))
                            .on("click", (event, element) => {
                                event.stopPropagation();
                                toggleItemMenu(element.el, item);
                            }),
                    ]),
            ]);
        itemCard.on("click", () =>
            isVideoItem(item)
                ? void runAction("open-item", item.id)
                : openQuickLook(item),
        );
        fragment.append(itemCard.el);
    }
    itemGrid.el.append(fragment);
}

async function loadMoreItems() {
    loadMoreButton.el.disabled = true;
    try {
        const result = await window.openCapture.action("load-items", {
            offset: appState.items.length,
            limit: 200,
        });
        if (!isItemsPage(result))
            throw new Error(t("라이브러리 응답을 확인할 수 없습니다."));
        const itemsById = new Map(
            appState.items.map((item) => [item.id, item] as const),
        );
        for (const item of result.items) itemsById.set(item.id, item);
        appState = {
            ...appState,
            items: [...itemsById.values()],
            totalItemCount: result.totalItemCount,
        };
        renderState();
    } catch (error) {
        showToast(errorMessage(error), true);
    } finally {
        loadMoreButton.el.disabled = false;
    }
}

function toggleItemMenu(anchor: HTMLElement, item: OpenCaptureItem) {
    for (const menu of document.querySelectorAll(".item-menu")) menu.remove();
    const menu = view("y")
        .class("item-menu")
        .addInto(anchor.parentElement ?? document.body);
    const entries: [string, string, () => void][] = isVideoItem(item)
        ? [
              ["v", t("재생"), () => runAction("open-item", item.id)],
              ["☰", t("메모"), () => openNote(item)],
              ["T", t("이름 바꾸기"), () => openRename(item)],
              ["⧉", t("복제"), () => runAction("duplicate-item", item.id)],
              [
                  "▤",
                  t("폴더에서 보기"),
                  () => runAction("reveal-item", item.id),
              ],
          ]
        : [
              ["⌕", t("미리보기"), () => openQuickLook(item)],
              ["⌖", t("화면에 고정"), () => runAction("pin-item", item.id)],
              [
                  "▣",
                  t("클립보드에 복사"),
                  () => runAction("copy-item", item.id),
              ],
              ["✎", t("주석·편집"), () => runAction("open-item", item.id)],
              ["▨", t("배경 꾸미기"), () => openBeautify(item)],
              ["⤢", t("업스케일"), () => openUpscale(item)],
              ["✧", t("AI 업스케일"), () => runAiUpscale(item)],
              ["⬍", t("중간 접기"), () => void openFold(item)],
              ...(isGifItem(item)
                  ? ([["≣", t("GIF 트림"), () => void openGifTrim(item)]] as [
                        string,
                        string,
                        () => void,
                    ][])
                  : []),
              ["☰", t("메모"), () => openNote(item)],
              [
                  "T",
                  item.ocrDone ? t("텍스트 다시 인식") : t("텍스트 인식"),
                  () => void requestOcrIndex(item.id),
              ],
              [
                  "✦",
                  t("배경 제거"),
                  () => runAction("remove-background", item.id),
              ],
              ["T", t("이름 바꾸기"), () => openRename(item)],
              ["⧉", t("복제"), () => runAction("duplicate-item", item.id)],
              [
                  "▤",
                  t("폴더에서 보기"),
                  () => runAction("reveal-item", item.id),
              ],
          ];
    for (const [glyph, text, run] of entries) {
        menu.add(
            button()
                .class("menu-item")
                .attr({ type: "button" })
                .add([icon(glyph), label("span", text)])
                .on("click", (event) => {
                    event.stopPropagation();
                    menu.remove();
                    run();
                }),
        );
    }
    setTimeout(() =>
        document.addEventListener("click", () => menu.remove(), { once: true }),
    );
}

async function refreshTranslationStatus() {
    try {
        translationStatus = await window.openCapture.translationStatus();
        renderTranslationStatus();
    } catch {
        modelStatusText.el.textContent = t("상태를 확인할 수 없음");
        modelDetails.el.textContent = t(
            "번역 서비스를 시작한 뒤 다시 확인해 주세요.",
        );
    }
}

function renderTranslationStatus() {
    if (!translationStatus) return;
    const engine = translationStatus.engine ?? "local";
    engineChoice.el.value = engine;
    const local = translationStatus.local;
    modelStatusDot.el.classList.toggle("ready", local.installed);
    modelStatusDot.el.classList.toggle("pending", Boolean(local.installing));
    modelStatusText.el.textContent = local.installing
        ? t("모델 설치 중")
        : local.installed
          ? t("로컬 모델 사용 가능")
          : t("로컬 모델 설치 필요");
    const sizeText = local.size ? `약 ${local.size}` : t("필요한 모델 파일");
    modelDetails.el.textContent = local.installed
        ? t("다운로드된 모델로 오프라인 번역을 사용할 수 있습니다.")
        : `${sizeText}을 내려받습니다. 설치 후에는 오프라인으로 동작합니다.`;
    installButton.el.hidden = local.installed;
    installButton.el.disabled = Boolean(local.installing);
    providerStatus.el.textContent = [
        translationStatus.providers.deepl.configured
            ? t("DeepL 연결됨")
            : t("DeepL 미연결"),
        translationStatus.providers.google.configured
            ? t("Google 연결됨")
            : t("Google 미연결"),
    ].join(" · ");
}

async function installModels() {
    installButton.el.disabled = true;
    modelStatusText.el.textContent = t("모델 설치 중");
    modelStatusDot.el.classList.add("pending");
    try {
        translationStatus = await window.openCapture.installModels();
        renderTranslationStatus();
        showToast("로컬 번역 모델을 설치했습니다.");
    } catch (error) {
        installButton.el.disabled = false;
        showToast(errorMessage(error), true);
        await refreshTranslationStatus();
    }
}

async function translateText() {
    const text = sourceText.el.value.trim();
    if (!text) {
        sourceText.el.focus();
        showToast("번역할 내용을 입력해 주세요.", true);
        return;
    }
    resultText.el.value = t("번역 중…");
    try {
        const translated = await window.openCapture.translate({
            texts: [text],
            from: sourceLanguage.el.value,
            to: targetLanguage.el.value,
            engine: translationStatus?.engine ?? "local",
        });
        resultText.el.value = translated[0] ?? "";
    } catch (error) {
        resultText.el.value = "";
        showToast(errorMessage(error), true);
    }
}

async function saveProvider() {
    const key = apiKeyInput.el.value.trim();
    if (!key) {
        apiKeyInput.el.focus();
        showToast("저장할 새 API 키를 입력해 주세요.", true);
        return;
    }
    try {
        translationStatus = await window.openCapture.configureTranslation({
            engine: providerSelect.el.value as TranslationEngine,
            apiKey: key,
        });
        apiKeyInput.el.value = "";
        renderTranslationStatus();
        showToast("번역 연결을 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

function openModal(dialog: HTMLDialogElement) {
    if (dialog.open) return;
    modalBackdrop.el.hidden = false;
    document.body.classList.add("modal-open");
    dialog.showModal();
}

const allDialogs = [
    shortcutDialog,
    renameDialog,
    noteDialog,
    beautifyDialog,
    upscaleDialog,
    foldDialog,
    gifDialog,
    quickLookDialog,
    onboardDialog,
];

function closeModal(dialog: HTMLDialogElement) {
    if (!dialog.open) return;
    dialog.close();
    if (!allDialogs.some((d) => d.el.open)) {
        modalBackdrop.el.hidden = true;
        document.body.classList.remove("modal-open");
    }
}

function closeAllModals() {
    for (const dialog of allDialogs) if (dialog.el.open) dialog.el.close();
    modalBackdrop.el.hidden = true;
    document.body.classList.remove("modal-open");
}

function openShortcutSheet() {
    if (shortcutDialog.el.open) return;
    renderShortcutSheet();
    openModal(shortcutDialog.el);
    runAction("cheatsheet");
}

function closeShortcutSheet() {
    closeModal(shortcutDialog.el);
}

function openRename(item: OpenCaptureItem) {
    renameTargetId = item.id;
    renameInput.el.value = item.name.replace(/\.[^.]+$/, "");
    openModal(renameDialog.el);
    setTimeout(() => renameInput.el.select());
}

async function submitRename() {
    if (!renameTargetId) return;
    const name = renameInput.el.value.trim();
    if (!name) {
        renameInput.el.focus();
        showToast("새 이름을 입력해 주세요.", true);
        return;
    }
    const id = renameTargetId;
    const previous = appState.items.find((i) => i.id === id)?.name;
    closeModal(renameDialog.el);
    await runItemEdit(
        ["rename-item", { id, name }],
        previous ? ["rename-item", { id, name: previous }] : null,
    );
}

function openNote(item: OpenCaptureItem) {
    noteTargetId = item.id;
    noteInput.el.value = item.note ?? "";
    openModal(noteDialog.el);
    setTimeout(() => noteInput.el.focus());
}

async function submitNote() {
    if (!noteTargetId) return;
    const id = noteTargetId;
    const previous = appState.items.find((i) => i.id === id)?.note;
    closeModal(noteDialog.el);
    await runItemEdit(
        ["set-note", { id, note: noteInput.el.value }],
        previous !== undefined ? ["set-note", { id, note: previous }] : null,
    );
}

async function openBeautify(item: OpenCaptureItem) {
    try {
        const dataURL = await window.openCapture.getItemData(item.id);
        const image = new Image();
        image.src = dataURL;
        await image.decode();
        beautifyTarget = { id: item.id, image };
        openModal(beautifyDialog.el);
        renderBeautify();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function openUpscale(item: OpenCaptureItem) {
    try {
        const dataURL = await window.openCapture.getItemData(item.id);
        const image = new Image();
        image.src = dataURL;
        await image.decode();
        upscaleTarget = { id: item.id, image };
        openModal(upscaleDialog.el);
        renderUpscale();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

function upscaleOversized() {
    const target = upscaleTarget;
    if (!target) return false;
    return (
        Math.round(target.image.naturalWidth * upscaleOptions.scale) *
            Math.round(target.image.naturalHeight * upscaleOptions.scale) >
        UPSCALE_MAX_PIXELS
    );
}

function renderUpscale() {
    const target = upscaleTarget;
    if (!target) return;
    const { image } = target;
    const iw = image.naturalWidth;
    const ih = image.naturalHeight;
    if (!iw || !ih) return;
    const outW = Math.round(iw * upscaleOptions.scale);
    const outH = Math.round(ih * upscaleOptions.scale);
    const tooLarge = upscaleOversized();
    upscaleInfo.el.textContent = `${iw}×${ih} → ${outW}×${outH}`;
    upscaleError.el.textContent = tooLarge
        ? t("결과 크기가 너무 큽니다. 배율을 낮춰 주세요.")
        : "";
    const canvas = upscaleCanvas.el;
    const pv = Math.min(1, 700 / Math.max(outW, outH));
    canvas.width = Math.max(1, Math.round(outW * pv));
    canvas.height = Math.max(1, Math.round(outH * pv));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (upscaleOptions.sharpen && !tooLarge)
        unsharpMask(canvas, 0.8 * pv * upscaleOptions.scale, 0.4);
}

function upscaleFull(target: {
    id: string;
    image: HTMLImageElement;
}): HTMLCanvasElement {
    const { image } = target;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * upscaleOptions.scale);
    canvas.height = Math.round(image.naturalHeight * upscaleOptions.scale);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (upscaleOptions.sharpen)
        unsharpMask(canvas, upscaleOptions.scale * 0.6, 0.5);
    return canvas;
}

async function saveUpscaled() {
    const target = upscaleTarget;
    if (!target) return;
    if (upscaleOversized()) {
        upscaleError.el.textContent = t(
            "결과 크기가 너무 큽니다. 배율을 낮춰 주세요.",
        );
        return;
    }
    const dataURL = upscaleFull(target).toDataURL("image/png");
    closeModal(upscaleDialog.el);
    if (
        await runAction("save-composed", {
            id: target.id,
            dataURL,
            label: "Upscale",
        })
    )
        showToast("업스케일 이미지를 컬렉션에 저장했습니다.");
}

function beautifyFill(): [string, string] | null {
    const selected = beautifyBackgrounds.find(
        (background) => background.id === beautifyOptions.background,
    );
    if (!selected) return null;
    if (selected.id === "transparent") return null;
    if (selected.id === "auto" && beautifyTarget) {
        const edge = sampleEdgeColor(beautifyTarget.image);
        const light = mixChannel(edge, [255, 255, 255], 0.22);
        const dark = mixChannel(edge, [9, 15, 26], 0.28);
        return [`rgb(${light.join(",")})`, `rgb(${dark.join(",")})`];
    }
    return selected.fill;
}

function renderBeautify() {
    const target = beautifyTarget;
    if (!target) return;
    const { image } = target;
    const iw = image.naturalWidth;
    const ih = image.naturalHeight;
    if (!iw || !ih) return;
    const pad = beautifyOptions.padding;
    let cw: number;
    let ch: number;
    let dx: number;
    let dy: number;
    let dw: number;
    let dh: number;
    if (beautifyOptions.ratio > 0) {
        const ratio = beautifyOptions.ratio;
        cw = 1600;
        ch = Math.round(cw / ratio);
        if (ch > 1600) {
            ch = 1600;
            cw = Math.round(ch * ratio);
        }
        const scale = Math.min((cw - pad * 2) / iw, (ch - pad * 2) / ih);
        dw = Math.max(1, Math.round(iw * Math.max(scale, 0)));
        dh = Math.max(1, Math.round(ih * Math.max(scale, 0)));
        dx = Math.round((cw - dw) / 2);
        dy = Math.round((ch - dh) / 2);
    } else {
        const scale = Math.min(1, 1400 / Math.max(iw, ih));
        dw = Math.max(1, Math.round(iw * scale));
        dh = Math.max(1, Math.round(ih * scale));
        cw = dw + pad * 2;
        ch = dh + pad * 2;
        dx = pad;
        dy = pad;
    }
    const canvas = beautifyCanvas.el;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    const fill = beautifyFill();
    if (fill) {
        const gradient = ctx.createLinearGradient(0, 0, cw, ch);
        gradient.addColorStop(0, fill[0]);
        gradient.addColorStop(1, fill[1]);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, cw, ch);
    }
    const radius = Math.min(beautifyOptions.radius, dw / 2, dh / 2);
    const path = new Path2D();
    path.roundRect(dx, dy, dw, dh, radius);
    if (beautifyOptions.shadow > 0) {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur = beautifyOptions.shadow;
        ctx.shadowOffsetY = Math.round(beautifyOptions.shadow * 0.35);
        ctx.fillStyle = "#000";
        ctx.fill(path);
        ctx.restore();
    }
    ctx.save();
    ctx.clip(path);
    ctx.drawImage(image, dx, dy, dw, dh);
    ctx.restore();
}

async function copyCanvas(canvas: HTMLCanvasElement) {
    try {
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error(t("이미지를 만들지 못했습니다."));
        await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob }),
        ]);
        showToast("이미지를 복사했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function saveBeautified() {
    const target = beautifyTarget;
    if (!target) return;
    const dataURL = beautifyCanvas.el.toDataURL("image/png");
    closeModal(beautifyDialog.el);
    if (await runAction("save-composed", { id: target.id, dataURL }))
        showToast("꾸민 이미지를 컬렉션에 저장했습니다.");
}

async function requestOcrIndex(id: string) {
    pendingOcrIds.add(id);
    setTimeout(() => pendingOcrIds.delete(id), 120_000);
    await runAction("index-ocr", id);
}

function openQuickLook(item: OpenCaptureItem) {
    quickLookId = item.id;
    exitQlCrop();
    renderQuickLook();
    openModal(quickLookDialog.el);
    void loadQuickLookImage(item.id);
}

let cropRect: { x: number; y: number; w: number; h: number } | null = null;
let cropAnchor: { x: number; y: number } | null = null;

function paintCropRect() {
    if (!cropRect || cropRect.w < 0.005 || cropRect.h < 0.005) {
        qlCropRect.el.hidden = true;
        return;
    }
    qlCropRect.el.hidden = false;
    qlCropRect.el.style.left = `${cropRect.x * 100}%`;
    qlCropRect.el.style.top = `${cropRect.y * 100}%`;
    qlCropRect.el.style.width = `${cropRect.w * 100}%`;
    qlCropRect.el.style.height = `${cropRect.h * 100}%`;
}

function overlayPoint(event: PointerEvent) {
    const box = qlCropOverlay.el.getBoundingClientRect();
    return {
        x: clamp01((event.clientX - box.left) / box.width),
        y: clamp01((event.clientY - box.top) / box.height),
    };
}

qlCropOverlay.el.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    qlCropOverlay.el.setPointerCapture(event.pointerId);
    cropAnchor = overlayPoint(event);
    cropRect = { x: cropAnchor.x, y: cropAnchor.y, w: 0, h: 0 };
    paintCropRect();
});
qlCropOverlay.el.addEventListener("pointermove", (event) => {
    if (!cropAnchor) return;
    const point = overlayPoint(event);
    cropRect = {
        x: Math.min(cropAnchor.x, point.x),
        y: Math.min(cropAnchor.y, point.y),
        w: Math.abs(point.x - cropAnchor.x),
        h: Math.abs(point.y - cropAnchor.y),
    };
    paintCropRect();
});
qlCropOverlay.el.addEventListener("pointerup", () => {
    cropAnchor = null;
    paintCropRect();
});

function startQlCrop() {
    cropRect = null;
    qlCropOverlay.el.hidden = false;
    qlCropBar.el.hidden = false;
    qlCropRect.el.hidden = true;
    qlPrev.el.disabled = true;
    qlNext.el.disabled = true;
}

function exitQlCrop() {
    cropRect = null;
    cropAnchor = null;
    qlCropOverlay.el.hidden = true;
    qlCropBar.el.hidden = true;
    if (quickLookDialog.el.open) renderQuickLook();
}

async function applyQlCrop() {
    const item = appState.items.find((i) => i.id === quickLookId);
    const rect = cropRect;
    if (!item || !rect || rect.w < 0.005 || rect.h < 0.005) {
        exitQlCrop();
        return;
    }
    try {
        const data =
            quickLookImages.get(item.id) ??
            (await window.openCapture.getItemData(item.id));
        const image = new Image();
        image.src = data;
        await image.decode();
        const iw = image.naturalWidth;
        const ih = image.naturalHeight;
        const sx = Math.round(rect.x * iw);
        const sy = Math.round(rect.y * ih);
        const sw = Math.max(8, Math.round(rect.w * iw));
        const sh = Math.max(8, Math.round(rect.h * ih));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
        exitQlCrop();
        if (
            await runAction("save-composed", {
                id: item.id,
                dataURL: canvas.toDataURL("image/png"),
                label: "Crop",
            })
        )
            showToast("자른 이미지를 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

let foldTarget: { id: string; image: HTMLImageElement } | null = null;

function foldFractions() {
    const rawStart = foldStartInput.el.valueAsNumber || 0;
    const rawEnd = foldEndInput.el.valueAsNumber || 0;
    const start = clamp01(Math.min(rawStart, rawEnd - 5) / 100);
    const end = clamp01(Math.max(rawEnd, rawStart + 5) / 100);
    return { start, end };
}

function renderFold() {
    if (!foldTarget) return;
    const { start, end } = foldFractions();
    foldShade.el.style.top = `${start * 100}%`;
    foldShade.el.style.height = `${(end - start) * 100}%`;
    foldInfo.el.textContent = `접는 구간 ${Math.round(start * 100)}% – ${Math.round(end * 100)}%`;
}
foldStartInput.on("input", () => renderFold());
foldEndInput.on("input", () => renderFold());

async function openFold(item: OpenCaptureItem) {
    try {
        const data =
            quickLookImages.get(item.id) ??
            (await window.openCapture.getItemData(item.id));
        const image = new Image();
        image.src = data;
        await image.decode();
        foldTarget = { id: item.id, image };
        foldImage.attr({ src: data });
        openModal(foldDialog.el);
        renderFold();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function applyFold() {
    const target = foldTarget;
    if (!target) return;
    try {
        const { start, end } = foldFractions();
        const img = target.image;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const topH = Math.round(ih * start);
        const bottomY = Math.round(ih * end);
        const bottomH = ih - bottomY;
        if (bottomH <= 0 || topH <= 0)
            throw new Error(t("접기 범위가 이미지를 벗어났습니다."));
        const seam = Math.min(28, Math.max(14, Math.round(iw * 0.02)));
        const canvas = document.createElement("canvas");
        canvas.width = iw;
        canvas.height = topH + seam + bottomH;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.fillStyle = "#f4f4f5";
        ctx.fillRect(0, 0, iw, canvas.height);
        ctx.drawImage(img, 0, 0, iw, topH, 0, 0, iw, topH);
        ctx.drawImage(
            img,
            0,
            bottomY,
            iw,
            bottomH,
            0,
            topH + seam,
            iw,
            bottomH,
        );
        ctx.beginPath();
        ctx.moveTo(0, topH);
        ctx.lineTo(iw, topH);
        for (let x = iw; x >= 0; x -= 24) ctx.lineTo(x - 12, topH + seam);
        ctx.closePath();
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        closeModal(foldDialog.el);
        if (
            await runAction("save-composed", {
                id: target.id,
                dataURL: canvas.toDataURL("image/png"),
                label: "Folded",
            })
        )
            showToast("중간을 접은 이미지를 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function openGifTrim(item: OpenCaptureItem) {
    if (!GifImageDecoder) {
        showToast("이 환경에서는 GIF 트림을 사용할 수 없습니다.", true);
        return;
    }
    try {
        const bytes = await window.openCapture.getItemFile(item.id);
        const decoder = new GifImageDecoder({
            data: bytes as BufferSource,
            type: "image/gif",
        });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
        if (count < 2) {
            decoder.close();
            throw new Error(t("프레임이 2개 이상인 GIF만 트림할 수 있습니다."));
        }
        gifTarget?.decoder.close();
        gifTarget = { id: item.id, decoder, count };
        gifStartInput.attr({ max: String(count - 1), value: "0" });
        gifEndInput.attr({ max: String(count - 1), value: String(count - 1) });
        openModal(gifDialog.el);
        await renderGifPreview();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function renderGifPreview() {
    const target = gifTarget;
    if (!target) return;
    const request = ++gifPreviewRequest;
    let start = Number(gifStartInput.el.value) || 0;
    let end = Number(gifEndInput.el.value) || 0;
    if (start > end) [start, end] = [end, start];
    gifInfo.el.textContent = `프레임 ${start + 1}–${end + 1} / ${target.count}`;
    try {
        const { image } = await target.decoder.decode({ frameIndex: start });
        if (request !== gifPreviewRequest || gifTarget !== target) {
            image.close();
            return;
        }
        const canvas = gifCanvas.el;
        canvas.width = image.codedWidth;
        canvas.height = image.codedHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        image.close();
    } catch {
        // 미리보기 프레임 디코딩 실패는 무시
    }
}

async function applyGifTrim() {
    const target = gifTarget;
    if (!target) return;
    let start = Number(gifStartInput.el.value) || 0;
    let end = Number(gifEndInput.el.value) || 0;
    if (start > end) [start, end] = [end, start];
    try {
        const { GIFEncoder, applyPalette, quantize } =
            // @ts-expect-error
            (await import("gifenc")) as typeof import("gifenc");
        const gif = GIFEncoder();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas");
        let palette: [number, number, number][] | undefined;
        for (let i = start; i <= end; i++) {
            const { image } = await target.decoder.decode({
                frameIndex: i,
            });
            canvas.width = image.codedWidth;
            canvas.height = image.codedHeight;
            ctx.drawImage(image, 0, 0);
            const delay = image.duration;
            image.close();
            const data = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
            ).data;
            palette ??= quantize(data, 256) as [number, number, number][];
            const index = applyPalette(data, palette);
            gif.writeFrame(index, canvas.width, canvas.height, {
                palette: i === start ? palette : undefined,
                delay: Math.max(20, Math.round((delay ?? 100_000) / 1000)),
            });
        }
        gif.finish();
        const bytes = gif.bytes();
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk)
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        closeModal(gifDialog.el);
        if (
            await runAction("save-gif", {
                id: target.id,
                dataURL: `data:image/gif;base64,${btoa(binary)}`,
            })
        )
            showToast("GIF 클립을 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function loadQuickLookImage(id: string) {
    if (quickLookImages.has(id)) return;
    try {
        const data = await window.openCapture.getItemData(id);
        if (quickLookImages.size > 12) {
            const oldest = quickLookImages.keys().next().value;
            if (oldest) quickLookImages.delete(oldest);
        }
        quickLookImages.set(id, data);
        if (quickLookId === id && quickLookDialog.el.open) renderQuickLook();
    } catch {
        // 미리보기 로드 실패 시 썸네일로 대체 표시
    }
}

function quickLookNavigate(step: 1 | -1) {
    const items = visibleLibraryItems();
    if (items.length < 2) return;
    cropRect = null;
    cropAnchor = null;
    qlCropOverlay.el.hidden = true;
    qlCropBar.el.hidden = true;
    const index = items.findIndex((i) => i.id === quickLookId);
    const next =
        items[(Math.max(0, index) + step + items.length) % items.length];
    quickLookId = next.id;
    renderQuickLook();
    void loadQuickLookImage(next.id);
}

function renderQuickLook() {
    const item = appState.items.find((i) => i.id === quickLookId);
    if (!item) {
        if (quickLookDialog.el.open) closeModal(quickLookDialog.el);
        quickLookId = null;
        return;
    }
    qlName.el.textContent = item.name;
    qlMeta.el.textContent = [
        formatDate(item.createdAt),
        item.note ? `메모: ${item.note}` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const full = quickLookImages.get(item.id);
    qlImage.attr({ src: full ?? item.thumbnail ?? "" });
    const multi = visibleLibraryItems().length > 1;
    qlPrev.el.disabled = !multi;
    qlNext.el.disabled = !multi;
    qlTags.clear();
    for (const tag of item.tags ?? []) {
        qlTags.add(
            button()
                .class("tag-chip")
                .attr({ type: "button", title: `${tag} 태그 제거` })
                .add([label("span", `#${tag}`), label("span", "×")])
                .on("click", async () => {
                    await runItemEdit(
                        [
                            "set-tags",
                            {
                                id: item.id,
                                tags: (item.tags ?? []).filter(
                                    (t) => t !== tag,
                                ),
                            },
                        ],
                        ["set-tags", { id: item.id, tags: item.tags ?? [] }],
                    );
                }),
        );
    }
    qlTagSuggest.clear();
    const tagCounts = new Map<string, number>();
    for (const other of appState.items)
        for (const tag of other.tags ?? [])
            if (!(item.tags ?? []).includes(tag))
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    for (const [tag] of [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6))
        qlTagSuggest.add(
            button()
                .class("chip-button", "tag-suggest-chip")
                .attr({ type: "button", title: `태그 추가: ${tag}` })
                .add(label("span", `#${tag}`))
                .on("click", async () => {
                    const current = appState.items.find(
                        (i) => i.id === item.id,
                    );
                    if (!current) return;
                    await runItemEdit(
                        [
                            "set-tags",
                            {
                                id: item.id,
                                tags: [...(current.tags ?? []), tag],
                            },
                        ],
                        ["set-tags", { id: item.id, tags: current.tags ?? [] }],
                    );
                }),
        );
    if (item.ocrDone) pendingOcrIds.delete(item.id);
    if (item.ocrText) {
        qlOcrStatus.el.textContent = `${item.ocrText.length.toLocaleString()}자 인식됨`;
        qlOcrText.el.textContent = item.ocrText;
        qlOcrText.el.hidden = false;
    } else if (pendingOcrIds.has(item.id)) {
        qlOcrStatus.el.textContent = t("텍스트를 인식하는 중입니다…");
        qlOcrText.el.hidden = true;
    } else if (item.ocrDone) {
        qlOcrStatus.el.textContent = t("인식된 텍스트가 없습니다.");
        qlOcrText.el.hidden = true;
    } else {
        qlOcrStatus.el.textContent = t(
            "아직 인식하지 않았습니다. 텍스트 인식을 실행하면 검색에도 포함됩니다.",
        );
        qlOcrText.el.hidden = true;
    }
}

function renderTagChips() {
    tagChipRow.clear();
    const counts = new Map<string, number>();
    for (const item of appState.items)
        for (const tag of item.tags ?? [])
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (activeTag && !counts.has(activeTag)) activeTag = null;
    for (const [tag, count] of [...counts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], "ko"),
    )) {
        tagChipRow.add(
            button()
                .class(
                    "chip-button",
                    "tag-filter",
                    activeTag === tag ? "active" : "",
                )
                .attr({
                    type: "button",
                    ariaPressed: String(activeTag === tag),
                })
                .add([icon("#"), label("span", `${tag} ${count}`)])
                .on("click", () => {
                    activeTag = activeTag === tag ? null : tag;
                    renderState();
                }),
        );
    }
}

function isLibraryFiltered() {
    return Boolean(
        searchQuery || favoritesOnly || todayOnly || ocrOnly || activeTag,
    );
}

function showCaptureToast(item: OpenCaptureItem) {
    showToast("이미지가 라이브러리에 추가되었습니다", false, [
        [t("복사"), () => runAction("copy-item", item.id)],
        [t("고정"), () => runAction("pin-item", item.id)],
        [t("열기"), () => runAction("open-item", item.id)],
        [t("메모"), () => openNote(item)],
    ]);
}

function showToast(
    message: string,
    error = false,
    actions: [string, () => void][] = [],
) {
    window.clearTimeout(toastTimer);
    toastText.el.textContent = message;
    toastActions.clear();
    for (const [text, run] of actions) {
        toastActions.add(
            button(text)
                .class("toast-action")
                .attr({ type: "button" })
                .on("click", () => {
                    toast.el.classList.remove("visible");
                    run();
                }),
        );
    }
    toast.el.classList.toggle("error", error);
    toast.el.classList.add("visible");
    toastTimer = window.setTimeout(
        () => toast.el.classList.remove("visible"),
        actions.length ? 8000 : 3200,
    );
}

document.addEventListener("keydown", (event) => {
    const tag = (event.target as HTMLElement).tagName;
    if (event.key === "Escape" && !modalBackdrop.el.hidden) closeAllModals();
    if (
        quickLookDialog.el.open &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(tag)
    ) {
        if (event.key === "ArrowLeft") quickLookNavigate(-1);
        if (event.key === "ArrowRight") quickLookNavigate(1);
    }
    if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(tag)
    )
        openShortcutSheet();
});

const loadObserver = new IntersectionObserver(
    (entries) => {
        if (
            entries.some((entry) => entry.isIntersecting) &&
            !loadMoreButton.el.hidden &&
            !loadMoreButton.el.disabled
        )
            void loadMoreItems();
    },
    { root: content.el, rootMargin: "400px" },
);
loadObserver.observe(loadMoreButton.el);

showPage(activePage);
let libraryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
window.openCapture.onLibraryChanged(() => {
    if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
    libraryRefreshTimer = setTimeout(async () => {
        const previousNewest = appState.items[0]?.id;
        await refreshState();
        const newest = appState.items[0];
        if (newest && newest.id !== previousNewest) showCaptureToast(newest);
    }, 150);
});
window.openCapture.onShowLibrary(() => showPage("library"));
window.openCapture.onWorkflowError((message) => showToast(message, true));
window.openCapture.onSrProgress(({ phase, percent }) => {
    if (phase === "download")
        srToastText.el.textContent = t("AI 모델을 다운로드하고 있습니다…");
    else if (phase === "run")
        srToastText.el.textContent = `AI 업스케일 처리 중 ${percent}%`;
    else {
        srToast.el.classList.remove("visible");
        if (phase === "done")
            showToast("AI 업스케일 이미지를 컬렉션에 저장했습니다.");
    }
});
window.openCapture.onPreviewItem((id) => void openPreviewById(id));
void refreshState().then(() => {
    if (!localStorage.getItem("oc:onboarded")) openOnboarding();
});
void refreshTranslationStatus();
