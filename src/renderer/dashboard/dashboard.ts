import { button, ele, initDKH, input, p, select, textarea, view } from "dkh-ui";
import type {
    CaptureColorSample,
    CaptureExperiencePreferences,
    CaptureItemsQuery,
    CaptureQueryScope,
    NamedBeautifyStyle,
    OpenCaptureActionName,
    OpenCaptureItem,
    OpenCaptureItemsPage,
    OpenCaptureShortcut,
    OpenCaptureState,
    SavedSmartFilter,
    TranslationEngine,
    TranslationStatus,
} from "../../../lib/openCaptureTypes";
import { fromSavedComparisonSession } from "../../../lib/referenceComparison";
import { type ImageHoldHandle, createImageHold } from "../lib/imageHold";
import { createBundleComposer } from "./bundleComposer";
import { createCaptureBoard } from "./captureBoard";
import { createCaptureExperiencePanel } from "./captureExperiencePanel";
import { type DashboardCommand, createCommandPalette } from "./commandPalette";
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
    formatRelativeTime,
    formatShortcut,
    isGifItem,
    isItemsPage,
    isProjectItem,
    isState,
    isVideoItem,
    mixChannel,
    sampleEdgeColor,
    unsharpMask,
} from "./dashboard-utils";
import { icon } from "./icons";
import { createMinimalHome } from "./minimalHome";
import {
    type ReferenceComparisonItem,
    createReferenceComparison,
} from "./referenceComparison";
import { t } from "./t";
import { virtualLibraryRange, virtualLibrarySlots } from "./virtualLibrary";

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
let smartFilter: "" | "week" | "uncategorized" | "videos" | "no-ocr" = "";
let sortMode: "new" | "old" | "name" = "new";
let thumbSize = localStorage.getItem("oc:thumb-size") || "m";
let quickLookId: string | null = null;
const quickLookImages = new Map<string, string>();
let compareItems: [OpenCaptureItem, OpenCaptureItem] | null = null;
const comparePool: OpenCaptureItem[] = [];
let compareLoadRequest = 0;
let compareMode: "side" | "overlay" | "wipe" = "side";
let compareZoom = 1;
let compareMix = 50;
let copyBundleBusy = false;
const pendingOcrIds = new Set<string>();
let renameTargetId: string | null = null;
let noteTargetId: string | null = null;
let beautifyTarget: { id: string; image: HTMLImageElement } | null = null;
let upscaleTarget: { id: string; image: HTMLImageElement } | null = null;
let experiencePreferences: CaptureExperiencePreferences | null = null;
let libraryScope: CaptureQueryScope = "library";
let queriedItems: Array<OpenCaptureItem | undefined> | null = null;
let queriedTotal = 0;
let querySequence = 0;
let catalogRevision: number | undefined;
let savedStyles: NamedBeautifyStyle[] = [];
let savedSmartFilters: SavedSmartFilter[] = [];
let recentColors: CaptureColorSample[] = [];
let activeSavedSmartId = "";
let virtualScrollScheduled = false;
let libraryQueryTimer: ReturnType<typeof setTimeout> | undefined;
const pendingQueryPages = new Set<number>();

const label = (
    tag: "span" | "strong" | "small" | "h1" | "h2" | "h3",
    value: string,
) => ele(tag).attr({ textContent: value });

view("x").class("window-titlebar").addInto();

const shell = view("x").class("app-shell").addInto();
if (localStorage.getItem("oc:nav-collapsed") !== "0")
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
    { page: "board", icon: "▥", text: t("보드") },
    { page: "translate", icon: "文", text: t("번역") },
    { page: "settings", icon: "⚙", text: t("설정") },
];

const navButtons = new Map<PageName, HTMLButtonElement>();
for (const item of navItems) {
    const navButton = button()
        .class("nav-button")
        .attr({ type: "button", ariaLabel: item.text, title: item.text })
        .data({ page: item.page })
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
        localStorage.setItem("oc:nav-collapsed", collapsed ? "1" : "0");
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
    .class("ghost-button", "compact", "command-trigger")
    .attr({
        type: "button",
        title: t("명령 검색"),
        ariaLabel: t("명령 검색"),
    })
    .add([icon("⌕"), label("span", "Ctrl K")])
    .on("click", () => openDashboardCommands())
    .addInto(topActions);

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
const boardPage = makePage("board");
const translatePage = makePage("translate");
const settingsPage = makePage("settings");
const legacyToolsCloseButton = button(t("간단한 홈으로 돌아가기"))
    .class("outline-button", "legacy-tools-close")
    .attr({ type: "button" })
    .on("click", () => homePage.el.classList.remove("show-all-tools"))
    .addInto(homePage);

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
        name: "previous",
        icon: "⧉",
        title: t("이전 영역"),
        description: t("마지막으로 캡처한 영역을 그대로 다시 찍어요"),
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
        names: ["capture", "fullscreen", "window", "scroll", "previous"],
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
        .class("action-group", "legacy-home-action")
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
    {
        key: "autoClipboard",
        title: t("클립보드 수집"),
        description: t("복사한 이미지를 자동으로 라이브러리에 저장합니다."),
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
    .on("change", async (_event, element) => {
        const id = element.el.value;
        if (id) {
            await runAction("choose-collection", id, true);
            await refreshState();
            void refreshLibraryQuery(true);
        }
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
        void refreshLibraryQuery();
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
        void refreshLibraryQuery(true);
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
const scopeSegment = view("x")
    .class("scope-segment")
    .attr({ role: "tablist", ariaLabel: "보관 범위" })
    .addInto(filterBar);
const scopeButtons = new Map<CaptureQueryScope, HTMLButtonElement>();
for (const [scope, text] of [
    ["temporary", "임시"],
    ["library", "보관함"],
    ["trash", "휴지통"],
] as const) {
    const control = button(text)
        .class("scope-segment-button")
        .attr({
            type: "button",
            role: "tab",
            ariaSelected: String(scope === libraryScope),
        })
        .on("click", () => {
            libraryScope = scope;
            selectedItemIds.clear();
            void refreshLibraryQuery(true);
        })
        .addInto(scopeSegment);
    scopeButtons.set(scope, control.el);
}
const todayChip = button()
    .class("chip-button")
    .attr({ type: "button", ariaPressed: "false" })
    .add([icon("◷"), label("span", t("오늘"))])
    .on("click", () => {
        todayOnly = !todayOnly;
        void refreshLibraryQuery(true);
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
        void refreshLibraryQuery(true);
    })
    .addInto(filterBar);
const smartSelect = select([
    { value: "", name: t("스마트 보기") },
    { value: "week", name: t("이번 주") },
    { value: "uncategorized", name: t("미분류") },
    { value: "videos", name: t("비디오만") },
    { value: "no-ocr", name: t("텍스트 없음") },
])
    .class("select-control", "smart-select")
    .attr({ ariaLabel: t("스마트 보기") })
    .on("change", (_event, element) => {
        smartFilter = element.el.value as typeof smartFilter;
        todayOnly = false;
        void refreshLibraryQuery(true);
    })
    .addInto(filterBar);
const savedSmartSelect = select([{ value: "", name: "저장된 보기" }])
    .class("select-control", "smart-select", "saved-smart-select")
    .attr({ ariaLabel: "저장된 스마트 컬렉션" })
    .on("change", (_event, element) => {
        activeSavedSmartId = element.el.value;
        void refreshLibraryQuery(true);
    })
    .addInto(filterBar);
button("+")
    .class("chip-button", "smart-save-button")
    .attr({
        type: "button",
        title: "현재 조건 저장",
        ariaLabel: "현재 조건 저장",
    })
    .on("click", () => void saveCurrentSmartFilter())
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
        void refreshLibraryQuery(true);
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
const copyBundleButton = button(t("묶음 복사"))
    .class("outline-button", "compact", "bulk-action", "image-bulk-action")
    .attr({
        type: "button",
        title: t("선택한 이미지를 한 장의 격자로 만들어 복사"),
    })
    .on("click", () => void openBundlePreview())
    .addInto(selectionActions);
const copySourceFilesButton = button("원본 파일 복사")
    .class("outline-button", "compact", "bulk-action")
    .attr({
        type: "button",
        title: "선택한 원본 파일을 Explorer에 붙여넣을 수 있게 복사",
    })
    .on("click", () => void copySelectedSourceFiles())
    .addInto(selectionActions);
const promoteSelectionButton = button("보관")
    .class("outline-button", "compact", "bulk-action", "temporary-action")
    .attr({ type: "button" })
    .on("click", () => void mutateSelectedItems("promote"))
    .addInto(selectionActions);
const trashSelectionButton = button("휴지통")
    .class("outline-button", "compact", "bulk-action", "trash-action")
    .attr({ type: "button" })
    .on("click", () => void mutateSelectedItems("trash"))
    .addInto(selectionActions);
const restoreSelectionButton = button("복원")
    .class("outline-button", "compact", "bulk-action", "restore-action")
    .attr({ type: "button" })
    .on("click", () => void mutateSelectedItems("restore"))
    .addInto(selectionActions);
const compareSelectionButton = button(t("비교"))
    .class("outline-button", "compact", "bulk-action", "compare-action")
    .attr({
        type: "button",
        title: t("이미지 두 장을 나란히 또는 겹쳐 비교"),
    })
    .on("click", () => void openSelectedComparison())
    .addInto(selectionActions);
const addSelectionToBoardButton = button(t("보드에 추가"))
    .class("outline-button", "compact", "bulk-action", "board-action")
    .attr({
        type: "button",
        title: t("선택한 이미지를 현재 보드에 추가"),
    })
    .on("click", async () => {
        const ids = [...selectedItemIds];
        if (!ids.length) return;
        try {
            await captureBoardReady;
            await captureBoard.addItems(ids);
            selectedItemIds.clear();
            await showPage("board");
            showToast(`${ids.length}개 캡처를 보드에 추가했습니다.`);
        } catch (error) {
            showToast(errorMessage(error), true);
        }
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

const experiencePanel = createCaptureExperiencePanel({
    save: (patch) => window.openCapture.configureExperience(patch),
    announce: (message, error) => showToast(message, error),
});
settingsLayout.el.append(experiencePanel.element);

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

const savedToolsCard = view("y")
    .class("settings-card", "saved-tools-card")
    .addInto(settingsLayout);
savedToolsCard.add(
    view("x")
        .class("settings-card-heading")
        .add(label("h2", "저장된 스타일과 색상")),
);
const savedStyleRow = view("x", "wrap")
    .class("saved-style-row")
    .addInto(savedToolsCard);
const savedSmartRow = view("x", "wrap")
    .class("saved-style-row", "saved-smart-row")
    .addInto(savedToolsCard);
const recentColorRow = view("x", "wrap")
    .class("recent-color-row")
    .addInto(savedToolsCard);

const diagnosticsCard = ele("details")
    .class("settings-card", "diagnostics-card")
    .addInto(settingsLayout);
diagnosticsCard.add(
    ele("summary").add([
        label("strong", "단축키 진단"),
        label("small", "입력부터 캡처 완료까지"),
    ]),
);
const diagnosticsList = view("y")
    .class("diagnostics-list")
    .addInto(diagnosticsCard);
button("새로고침")
    .class("text-button", "compact")
    .attr({ type: "button" })
    .on("click", () => void refreshState())
    .addInto(diagnosticsCard);

const modalBackdrop = view()
    .class("modal-backdrop")
    .attr({ hidden: true })
    .addInto();
const bundleComposer = createBundleComposer({
    load: (id) => window.openCapture.getItemData(id),
    copy: async (dataURL) => {
        const ok = await runAction("copy-composed", { dataURL });
        if (!ok) throw new Error("묶음을 복사하지 못했습니다.");
    },
    save: async (dataURL, bundleLabel) => {
        const ok = await runAction("save-composed", {
            dataURL,
            label: bundleLabel,
        });
        if (!ok) throw new Error("묶음을 저장하지 못했습니다.");
    },
    openDialog: openModal,
    closeDialog: closeModal,
    announce: (message, error) => showToast(message, error),
});
modalBackdrop.el.append(bundleComposer.dialog);
const referenceComparison = createReferenceComparison({
    loadItemData: (id) => {
        const reference = parseBoardReference(id);
        return reference
            ? window.openCapture.boards.assetData(
                  reference.boardId,
                  reference.assetId,
                  "original",
              )
            : window.openCapture.getItemData(id);
    },
    listSessions: () => window.openCapture.listComparisons(),
    saveSession: (session) => window.openCapture.saveComparison(session),
    removeSession: (id) => window.openCapture.removeComparison(id),
    saveExport: async (dataURL, exportLabel) => {
        const ok = await runAction("save-composed", {
            dataURL,
            label: exportLabel,
        });
        if (!ok) throw new Error("비교 결과를 저장하지 못했습니다.");
    },
    copyExport: async (dataURL) => {
        const ok = await runAction("copy-composed", { dataURL });
        if (!ok) throw new Error("비교 결과를 복사하지 못했습니다.");
    },
    showToast: (message, error) => showToast(message, error),
    translate: t,
    openDialog: openModal,
    closeDialog: closeModal,
});

function parseBoardReference(id: string) {
    const match = /^board:([^:]+):(.+)$/.exec(id);
    if (!match) return null;
    try {
        return {
            boardId: decodeURIComponent(match[1]),
            assetId: decodeURIComponent(match[2]),
        };
    } catch {
        return null;
    }
}

const captureBoard = createCaptureBoard({
    api: window.openCapture.boards,
    loadBeautifyStyles: () => window.openCapture.listStyles(),
    announce: (message, error) => showToast(message, error),
    compareItems: (ids) => {
        const document = captureBoard.getDocument();
        const items = ids.map((id) => {
            const reference = parseBoardReference(id);
            const node = document?.nodes.find(
                (candidate) => candidate.assetId === reference?.assetId,
            );
            return {
                id,
                name: node?.name || node?.text || t("보드 이미지"),
            };
        });
        referenceComparison.open(items);
    },
    capture: () => runAction("capture"),
    changed: () => void renderMinimalHome(),
});
boardPage.el.append(captureBoard.root);
let approvedBoardUnload = false;
let requestedBoardClose = false;
window.openCapture.onBoardFlushRequested((requestId) => {
    requestedBoardClose = true;
    captureBoard.root.inert = true;
    void captureBoard
        .flush()
        .then(
            () => {
                approvedBoardUnload = true;
                return window.openCapture.ackBoardFlush(requestId, true);
            },
            (error) => {
                approvedBoardUnload = false;
                requestedBoardClose = false;
                captureBoard.root.inert = false;
                const message = errorMessage(error);
                showToast(message, true);
                return window.openCapture.ackBoardFlush(
                    requestId,
                    false,
                    message,
                );
            },
        )
        .catch((error) => {
            approvedBoardUnload = false;
            requestedBoardClose = false;
            captureBoard.root.inert = false;
            showToast(errorMessage(error), true);
        });
});
window.addEventListener("beforeunload", (event) => {
    if (approvedBoardUnload && !captureBoard.hasPendingChanges()) {
        approvedBoardUnload = false;
        return;
    }
    if (!captureBoard.hasPendingChanges()) return;
    const closeAfterSave = requestedBoardClose;
    approvedBoardUnload = false;
    captureBoard.root.inert = true;
    event.preventDefault();
    event.returnValue = false;
    void captureBoard
        .flush()
        .then(() => {
            if (closeAfterSave) return window.openCapture.finishBoardClose();
            approvedBoardUnload = true;
            location.reload();
        })
        .catch((error) => {
            approvedBoardUnload = false;
            requestedBoardClose = false;
            captureBoard.root.inert = false;
            showToast(errorMessage(error), true);
        });
});
const captureBoardReady = captureBoard.ready().catch((error) => {
    showToast(errorMessage(error), true);
});

const minimalHome = createMinimalHome({
    capture: () => runAction("capture"),
    openCommands: () => openDashboardCommands(),
    openItem: (item) => {
        if (isVideoItem(item) || isProjectItem(item))
            void runAction("open-item", item.id);
        else openQuickLook(item);
    },
    async openBoard(id) {
        await captureBoardReady;
        await captureBoard.open(id);
        await showPage("board");
    },
    showLibrary: () => void showPage("library"),
});
homePage.el.prepend(minimalHome.root);

const captureCommands: DashboardCommand[] = captureActions.map((action) => ({
    id: `capture:${action.name}`,
    label: action.title,
    detail: action.description,
    keywords: ["캡처", action.name],
    shortcut: action.shortcut,
    run: () =>
        action.name === "steps" ? toggleSteps() : runAction(action.name),
}));
const boardCommands: DashboardCommand[] = [
    ["board:create", "새 보드", "create"],
    ["board:layout-grid", "격자로 정렬", "layout-grid"],
    ["board:layout-horizontal", "가로로 정렬", "layout-horizontal"],
    ["board:layout-vertical", "세로로 정렬", "layout-vertical"],
    ["board:group", "선택 항목 그룹", "group"],
    ["board:focus", "선택 항목만 보기", "focus"],
    ["board:tool-rect", "사각형 그리기", "tool:rect"],
    ["board:tool-arrow", "화살표 그리기", "tool:arrow"],
    ["board:tool-note", "보드 메모 추가", "tool:note"],
    ["board:tool-callout", "설명 상자 추가", "tool:callout"],
    ["board:preset-design", "디자인 피드백 프리셋", "preset:design"],
    ["board:preset-bug", "버그 보고 프리셋", "preset:bug"],
    ["board:preset-study", "공부 메모 프리셋", "preset:study"],
    ["board:export-png", "보드를 PNG로 내보내기", "export-png"],
    ["board:export-pdf", "보드를 PDF로 내보내기", "export-pdf"],
].map(([id, commandLabel, command]) => ({
    id,
    label: commandLabel,
    detail: t("캡처 보드"),
    keywords: ["보드", "도형", "주석"],
    async run() {
        await captureBoardReady;
        await showPage("board");
        await captureBoard.command(command);
    },
}));
const navigationCommands: DashboardCommand[] = [
    ["go:home", "홈 열기", "home"],
    ["go:library", "라이브러리 열기", "library"],
    ["go:board", "캡처 보드 열기", "board"],
    ["go:translate", "번역 열기", "translate"],
    ["go:settings", "설정 열기", "settings"],
].map(([id, commandLabel, page]) => ({
    id,
    label: commandLabel,
    detail: t("화면 이동"),
    run: () => showPage(page as PageName),
}));
const workspaceCommands: DashboardCommand[] = [
    {
        id: "home:all-tools",
        label: "모든 캡처 도구 보기",
        detail: "자동 작업과 전체 캡처 모드",
        keywords: ["캡처", "자동", "전체", "기능"],
        async run() {
            await showPage("home");
            homePage.el.classList.add("show-all-tools");
            legacyToolsCloseButton.el.focus();
        },
    },
    {
        id: "library:add-board",
        label: "선택 항목을 보드에 추가",
        detail: "라이브러리 선택",
        keywords: ["보드", "선택", "추가"],
        async run() {
            const ids = [...selectedItemIds];
            await captureBoardReady;
            await captureBoard.addItems(ids);
            selectedItemIds.clear();
            await showPage("board");
        },
    },
    {
        id: "settings:capture-tools",
        label: "캡처 도구 구성",
        detail: "툴바와 원형 메뉴 즐겨찾기",
        keywords: ["설정", "즐겨찾기", "툴바", "원형 메뉴"],
        async run() {
            await showPage("settings");
            settingsPage.el
                .querySelector<HTMLElement>(".experience-settings")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
        },
    },
];
const commandPalette = createCommandPalette(document.body, [
    ...captureCommands,
    ...boardCommands,
    ...workspaceCommands,
    ...navigationCommands,
]);

function openDashboardCommands() {
    const selection = captureBoard.getSelection();
    const selectedCount = selection.length;
    const imageCount = selection.filter((node) => node.kind === "image").length;
    const disabled = new Set<string>();
    if (selectedCount < 2) {
        disabled.add("board:group");
        disabled.add("board:layout-grid");
        disabled.add("board:layout-horizontal");
        disabled.add("board:layout-vertical");
    }
    if (!selectedCount) disabled.add("board:focus");
    if (!selectedItemIds.size) disabled.add("library:add-board");
    commandPalette.setCommands(
        [
            ...captureCommands.map((command) => ({
                ...command,
                shortcut:
                    formatShortcut(
                        appState.runtime.shortcuts.find(
                            (shortcut) =>
                                command.id === `capture:${shortcut.id}`,
                        )?.active ?? "",
                    ) || undefined,
            })),
            ...boardCommands.map((command) => ({
                ...command,
                disabled: disabled.has(command.id),
                detail:
                    command.id === "board:focus" && imageCount
                        ? `${imageCount}개 이미지 선택됨`
                        : command.detail,
            })),
            ...workspaceCommands.map((command) => ({
                ...command,
                disabled: disabled.has(command.id),
            })),
            ...navigationCommands,
        ].filter((command) =>
            activePage === "board" || !command.id.startsWith("board:")
                ? true
                : ["board:create"].includes(command.id),
        ),
    );
    commandPalette.open();
}

let minimalHomeRequest = 0;
async function renderMinimalHome() {
    const request = ++minimalHomeRequest;
    try {
        const [libraryRecent, temporaryRecent, boards] = await Promise.all([
            window.openCapture.queryItems({
                scope: "library",
                sort: "newest",
                offset: 0,
                limit: 3,
                queryId: `home-library-${request}`,
            }),
            window.openCapture.queryItems({
                scope: "temporary",
                sort: "newest",
                offset: 0,
                limit: 3,
                queryId: `home-temporary-${request}`,
            }),
            window.openCapture.boards.list(),
        ]);
        if (request !== minimalHomeRequest) return;
        const capture = appState.runtime.shortcuts.find(
            (shortcut) => shortcut.id === "capture",
        );
        const activeId = captureBoard.getDocument()?.id;
        const recentById = new Map(
            [...libraryRecent.items, ...temporaryRecent.items].map((item) => [
                item.id,
                item,
            ]),
        );
        minimalHome.render({
            shortcut: capture?.active
                ? formatShortcut(capture.active).replaceAll(" + ", "+")
                : "",
            recents: [...recentById.values()]
                .sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                )
                .slice(0, 3),
            activeBoard:
                boards.find((board) => board.id === activeId) ??
                boards.find((board) => board.active),
        });
    } catch (error) {
        if (request === minimalHomeRequest)
            showToast(errorMessage(error), true);
    }
}
button()
    .class("outline-button", "saved-comparison-button")
    .attr({ type: "button", title: t("저장된 비교") })
    .add([icon("▥"), label("span", t("저장된 비교"))])
    .on("click", () => {
        void window.openCapture
            .listComparisons()
            .then((sessions) => {
                const saved = sessions[0];
                if (!saved) {
                    showToast(t("저장된 비교가 없습니다."));
                    return;
                }
                referenceComparison.open(
                    saved.itemIds.map((id) => ({
                        id,
                        name: `${saved.name} · ${id.slice(0, 8)}`,
                    })),
                    fromSavedComparisonSession(saved) ?? undefined,
                );
            })
            .catch((error) => showToast(String(error), true));
    })
    .addInto(libraryButtons);
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
        const status = !sc.requested
            ? ""
            : sc.available
              ? sc.lastUsed
                  ? formatRelativeTime(sc.lastUsed)
                  : t("아직 사용하지 않음")
              : t("등록 실패 — 다른 앱이 점유 중일 수 있습니다");
        shortcutList.add(
            view("x")
                .class("shortcut-row")
                .add([
                    view("y").add([
                        label("strong", sc.label),
                        label("small", shortcutDescriptions[sc.id] ?? ""),
                        status
                            ? label("small", status).class(
                                  "shortcut-status",
                                  sc.available ? "" : "conflict",
                              )
                            : view(),
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
    align: "c",
    autoBalance: false,
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
    {
        id: "mint",
        name: t("민트"),
        css: "linear-gradient(135deg,#9EE6B8,#4CC9F0)",
        fill: ["#9EE6B8", "#4CC9F0"],
    },
    {
        id: "peach",
        name: t("피치"),
        css: "linear-gradient(135deg,#FFD3A5,#FD6585)",
        fill: ["#FFD3A5", "#FD6585"],
    },
    {
        id: "aurora",
        name: t("오로라"),
        css: "linear-gradient(135deg,#43E97B,#38F9D7)",
        fill: ["#43E97B", "#38F9D7"],
    },
    {
        id: "mono",
        name: t("모노"),
        css: "linear-gradient(135deg,#232526,#414345)",
        fill: ["#232526", "#414345"],
    },
];
const beautifyRatios: [string, number][] = [
    [t("자유"), 0],
    ["1:1", 1],
    ["4:5", 0.8],
    ["3:2", 1.5],
    ["16:9", 16 / 9],
    ["1.91:1", 1.91],
    ["2:1", 2],
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

beautifyControls.add(label("small", t("정렬")).class("control-label"));
const alignChipRow = view("x", "wrap")
    .class("chip-row")
    .addInto(beautifyControls);
const beautifyAligns: [string, string][] = [
    ["↖", "tl"],
    ["↑", "t"],
    ["↗", "tr"],
    ["←", "l"],
    ["◦", "c"],
    ["→", "r"],
    ["↙", "bl"],
    ["↓", "b"],
    ["↘", "br"],
];
for (const [glyph, align] of beautifyAligns) {
    button(glyph)
        .class("chip-button", "ratio-chip", align === "c" ? "active" : "")
        .attr({ type: "button", ariaPressed: String(align === "c") })
        .on("click", (event, el) => {
            beautifyOptions.align = align;
            for (const chipEl of alignChipRow.el.querySelectorAll(
                ".ratio-chip",
            )) {
                const active = chipEl === el.el;
                chipEl.classList.toggle("active", active);
                chipEl.setAttribute("aria-pressed", String(active));
            }
            renderBeautify();
        })
        .addInto(alignChipRow);
}
const autoBalanceCheck = input("checkbox")
    .attr({ id: "auto_balance" })
    .on("input", () => {
        beautifyOptions.autoBalance = autoBalanceCheck.el.checked;
        renderBeautify();
    });
view("x")
    .class("chip-row")
    .add([autoBalanceCheck, label("span", t("자동 균형"))])
    .addInto(beautifyControls);

const beautifyStyleRow = view("x")
    .class("beautify-style-row")
    .addInto(beautifyControls);
const beautifyStyleSelect = select([{ value: "", name: "스타일 프리셋" }])
    .class("select-control")
    .on("change", (_event, element) => applySavedStyle(element.el.value))
    .addInto(beautifyStyleRow);
button("현재 스타일 저장")
    .class("text-button", "compact")
    .attr({ type: "button" })
    .on("click", () => void saveCurrentBeautifyStyle())
    .addInto(beautifyStyleRow);

const beautifySliderInputs = new Map<
    "padding" | "radius" | "shadow",
    HTMLInputElement
>();
function beautifySlider(
    key: "padding" | "radius" | "shadow",
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
    beautifySliderInputs.set(key, range.el);
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
beautifySlider("padding", t("여백"), 0, 200, beautifyOptions.padding, (v) => {
    beautifyOptions.padding = v;
});
beautifySlider("radius", t("둥글기"), 0, 120, beautifyOptions.radius, (v) => {
    beautifyOptions.radius = v;
});
beautifySlider("shadow", t("그림자"), 0, 120, beautifyOptions.shadow, (v) => {
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
            const item = quickLookId ? findKnownItem(quickLookId) : undefined;
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
    const item = quickLookId ? findKnownItem(quickLookId) : undefined;
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
        const item = quickLookId ? findKnownItem(quickLookId) : undefined;
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
        const item = quickLookId ? findKnownItem(quickLookId) : undefined;
        if (!item) return;
        await requestOcrIndex(item.id);
        renderQuickLook();
    })
    .addInto(qlOcrActions);
quickLookDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(quickLookDialog.el);
});

const compareDialog = ele("dialog")
    .class("compare-dialog")
    .attr({ ariaBusy: "false" })
    .addInto(modalBackdrop);
const compareHeader = view("x")
    .class("dialog-header", "compare-header")
    .addInto(compareDialog);
compareHeader.add([
    label("h2", t("레퍼런스 비교")),
    button()
        .class("close-button")
        .attr({ type: "button", ariaLabel: t("닫기") })
        .add(icon("×"))
        .on("click", () => closeModal(compareDialog.el)),
]);
const compareToolbar = view("x", "wrap")
    .class("compare-toolbar")
    .addInto(compareDialog);
const comparePairControls = view("x")
    .class("compare-pair-controls")
    .addInto(compareToolbar);
const compareSelectA = ele("select")
    .class("compare-pair-select")
    .attr({ ariaLabel: t("첫 번째 레퍼런스") })
    .addInto(comparePairControls);
const compareSelectB = ele("select")
    .class("compare-pair-select")
    .attr({ ariaLabel: t("두 번째 레퍼런스") })
    .addInto(comparePairControls);
compareSelectA.on("change", () => void applyComparisonSelection());
compareSelectB.on("change", () => void applyComparisonSelection());
const compareModeButtons = new Map<
    "side" | "overlay" | "wipe",
    HTMLButtonElement
>();
for (const [mode, text] of [
    ["side", t("나란히")],
    ["overlay", t("겹치기")],
    ["wipe", t("밀어서 비교")],
] as const) {
    const control = button(text)
        .class("compare-mode-button")
        .attr({ type: "button" })
        .on("click", () => setCompareMode(mode))
        .addInto(compareToolbar);
    compareModeButtons.set(mode, control.el);
}
const compareMixControl = view("x")
    .class("compare-mix-control")
    .addInto(compareToolbar);
const compareMixLabel = label("small", t("경계 50%"));
const compareMixInput = input("range").attr({
    min: "0",
    max: "100",
    step: "1",
    value: "50",
    ariaLabel: t("비교 경계"),
});
compareMixInput.on("input", () => {
    compareMix = Number(compareMixInput.el.value);
    renderComparison();
});
compareMixControl.add([compareMixLabel, compareMixInput]);
const compareZoomControls = view("x")
    .class("compare-zoom-controls")
    .addInto(compareToolbar);
const compareZoomLabel = label("small", "100%");
compareZoomControls.add([
    button("−")
        .class("compare-icon-button")
        .attr({ type: "button", ariaLabel: t("축소") })
        .on("click", () => setCompareZoom(compareZoom - 0.25)),
    compareZoomLabel,
    button("+")
        .class("compare-icon-button")
        .attr({ type: "button", ariaLabel: t("확대") })
        .on("click", () => setCompareZoom(compareZoom + 0.25)),
    button(t("교체"))
        .class("compare-swap-button")
        .attr({ type: "button" })
        .on("click", () => {
            if (!compareItems) return;
            void setComparisonPair(compareItems[1].id, compareItems[0].id);
        }),
]);
const compareStage = view().class("compare-stage").addInto(compareDialog);
const compareLoadingStatus = label("small", t("이미지 불러오는 중…"))
    .class("compare-loading-status")
    .attr({ role: "status", ariaLive: "polite" })
    .addInto(compareStage);
compareLoadingStatus.el.hidden = true;
const compareSide = view("x").class("compare-side").addInto(compareStage);
const compareSidePaneA = view("y").class("compare-pane").addInto(compareSide);
const compareSideImageA = ele("img")
    .class("compare-image")
    .attr({ alt: "" })
    .addInto(compareSidePaneA);
const compareSideNameA = label("small", "A").addInto(compareSidePaneA);
const compareSidePaneB = view("y").class("compare-pane").addInto(compareSide);
const compareSideImageB = ele("img")
    .class("compare-image")
    .attr({ alt: "" })
    .addInto(compareSidePaneB);
const compareSideNameB = label("small", "B").addInto(compareSidePaneB);
const compareOverlay = view().class("compare-overlay").addInto(compareStage);
const compareOverlayBase = ele("img")
    .class("compare-overlay-image", "compare-overlay-base")
    .attr({ alt: "" })
    .addInto(compareOverlay);
const compareOverlayTop = ele("img")
    .class("compare-overlay-image", "compare-overlay-top")
    .attr({ alt: "" })
    .addInto(compareOverlay);
const compareDivider = view().class("compare-divider").addInto(compareOverlay);
compareDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(compareDialog.el);
});
compareDialog.el.addEventListener("close", () => {
    compareLoadRequest++;
    compareDialog.el.classList.remove("loading");
    compareDialog.el.setAttribute("aria-busy", "false");
    compareLoadingStatus.el.hidden = true;
});
// The factory-backed comparison surface below replaces this legacy local view.
// Keep the detached nodes temporarily so older helper functions remain harmless
// while integrations migrate, without exposing duplicate controls in the DOM.
compareDialog.el.remove();

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
const onboardTestResult = label(
    "small",
    t("여기를 누르고 단축키를 눌러보세요"),
);
const onboardTestPad = view("y")
    .class("onboard-card", "onboard-test")
    .attr({
        tabIndex: 0,
        role: "button",
        title: t("눌러서 캡처 단축키를 직접 테스트하세요."),
    })
    .add([
        view().class("onboard-icon").add(icon("⌨")),
        label("strong", t("키 테스트")),
        onboardTestResult,
    ])
    .on("keydown", (e) => {
        const acc = acceleratorFromEvent(e);
        if (!acc) return;
        e.preventDefault();
        const capture = appState.runtime.shortcuts.find(
            (s) => s.id === "capture",
        );
        const shown = formatShortcut(acc);
        if (acc === capture?.active)
            onboardTestResult.attr({
                textContent: `${shown} — ${t("정상 등록됨")}`,
            });
        else if (acc === capture?.requested && !capture.available)
            onboardTestResult.attr({
                textContent: `${shown} — ${t("등록 실패 상태입니다")}`,
            });
        else
            onboardTestResult.attr({
                textContent: shown,
            });
    })
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

async function showPage(page: PageName) {
    if (activePage === "board" && page !== "board") {
        try {
            await captureBoard.flush();
        } catch (error) {
            showToast(errorMessage(error), true);
            return;
        }
    }
    activePage = page;
    const titles: Record<PageName, string> = {
        home: t("캡처"),
        library: t("라이브러리"),
        board: t("보드"),
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
    if (page === "home") void renderMinimalHome();
}

async function runAction(
    name: OpenCaptureActionName,
    payload?: unknown,
    refresh = false,
) {
    try {
        if (
            activePage === "board" &&
            (name === "hide-window" || name === "open-image")
        )
            await captureBoard.flush();
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

function isComparableImage(item: OpenCaptureItem) {
    return !isVideoItem(item) && !isProjectItem(item);
}

function selectedItemsInOrder() {
    const available = new Map(
        [...appState.items, ...visibleLibraryItems()].map((item) => [
            item.id,
            item,
        ]),
    );
    return [...selectedItemIds]
        .map((id) => available.get(id))
        .filter((item): item is OpenCaptureItem => Boolean(item));
}

function findKnownItem(id: string) {
    return (
        appState.items.find((item) => item.id === id) ??
        queriedItems?.find((item) => item?.id === id)
    );
}

async function loadLibraryImage(item: OpenCaptureItem) {
    const data =
        quickLookImages.get(item.id) ??
        (await window.openCapture.getItemData(item.id));
    quickLookImages.set(item.id, data);
    const image = new Image();
    image.src = data;
    await image.decode();
    return { item, image, data };
}

async function copySelectedAsBundle() {
    if (copyBundleBusy) return;
    const items = selectedItemsInOrder();
    if (items.length < 2) {
        showToast(t("이미지를 두 장 이상 선택해 주세요."), true);
        return;
    }
    if (items.length > 12) {
        showToast(t("묶음 복사는 최대 12장까지 지원합니다."), true);
        return;
    }
    if (items.some((item) => !isComparableImage(item))) {
        showToast(t("이미지 항목만 묶어서 복사할 수 있습니다."), true);
        return;
    }
    copyBundleBusy = true;
    copyBundleButton.el.disabled = true;
    copyBundleButton.el.textContent = t("복사 중…");
    let canvas: HTMLCanvasElement | null = null;
    try {
        const columns = Math.min(4, Math.ceil(Math.sqrt(items.length)));
        const rows = Math.ceil(items.length / columns);
        const cellWidth = 760;
        const cellHeight = 520;
        const gap = 18;
        const padding = 18;
        canvas = document.createElement("canvas");
        canvas.width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
        canvas.height = padding * 2 + rows * cellHeight + (rows - 1) * gap;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(t("이미지 캔버스를 만들 수 없습니다."));
        ctx.fillStyle = "#111114";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const [index, item] of items.entries()) {
            const data = await window.openCapture.getItemData(item.id);
            const image = new Image();
            image.src = data;
            try {
                await image.decode();
                const column = index % columns;
                const row = Math.floor(index / columns);
                const x = padding + column * (cellWidth + gap);
                const y = padding + row * (cellHeight + gap);
                const scale = Math.min(
                    cellWidth / image.naturalWidth,
                    cellHeight / image.naturalHeight,
                );
                const width = Math.max(
                    1,
                    Math.round(image.naturalWidth * scale),
                );
                const height = Math.max(
                    1,
                    Math.round(image.naturalHeight * scale),
                );
                const drawX = x + Math.round((cellWidth - width) / 2);
                const drawY = y + Math.round((cellHeight - height) / 2);
                ctx.fillStyle = "#18181c";
                ctx.fillRect(x, y, cellWidth, cellHeight);
                ctx.drawImage(image, drawX, drawY, width, height);
                ctx.strokeStyle = "rgba(255,255,255,.16)";
                ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1);
            } finally {
                image.src = "";
            }
        }
        const copied = await runAction("copy-composed", {
            dataURL: canvas.toDataURL("image/png"),
        });
        if (copied)
            showToast(
                `${items.length}${t("장을 한 이미지로 묶어 복사했습니다.")}`,
            );
    } catch (error) {
        showToast(errorMessage(error), true);
    } finally {
        if (canvas) {
            canvas.width = 1;
            canvas.height = 1;
        }
        copyBundleBusy = false;
        copyBundleButton.el.textContent = t("묶음 복사");
        renderState();
    }
}

async function openSelectedComparison() {
    const items = selectedItemsInOrder();
    if (items.length < 2) {
        showToast(t("비교할 이미지를 두 장 이상 선택해 주세요."), true);
        return;
    }
    if (items.length > 20) {
        showToast(t("비교는 최대 20장까지 선택할 수 있습니다."), true);
        return;
    }
    if (items.some((item) => !isComparableImage(item))) {
        showToast(t("일반 이미지 두 장만 비교할 수 있습니다."), true);
        return;
    }
    referenceComparison.open(
        items.map<ReferenceComparisonItem>((item) => ({
            id: item.id,
            name: item.name,
            thumbnail: item.thumbnail,
        })),
    );
}

function renderCompareSelectors(firstId: string, secondId: string) {
    compareSelectA.clear();
    compareSelectB.clear();
    comparePool.forEach((item, index) => {
        const text = `${String.fromCharCode(65 + index)} · ${item.name}`;
        compareSelectA.add(
            ele("option").attr({ value: item.id, textContent: text }),
        );
        compareSelectB.add(
            ele("option").attr({ value: item.id, textContent: text }),
        );
    });
    compareSelectA.el.value = firstId;
    compareSelectB.el.value = secondId;
}

async function applyComparisonSelection() {
    const firstId = compareSelectA.el.value;
    const secondId = compareSelectB.el.value;
    if (firstId === secondId) {
        if (compareItems)
            renderCompareSelectors(compareItems[0].id, compareItems[1].id);
        showToast(t("서로 다른 이미지를 선택해 주세요."), true);
        return;
    }
    await setComparisonPair(firstId, secondId);
}

async function setComparisonPair(firstId: string, secondId: string) {
    const first = comparePool.find((item) => item.id === firstId);
    const second = comparePool.find((item) => item.id === secondId);
    if (!first || !second || first.id === second.id) return false;
    const request = ++compareLoadRequest;
    compareDialog.el.classList.add("loading");
    compareDialog.el.setAttribute("aria-busy", "true");
    compareLoadingStatus.el.textContent = t("이미지 불러오는 중…");
    compareLoadingStatus.el.hidden = false;
    try {
        const [firstLoaded, secondLoaded] = await Promise.all([
            loadLibraryImage(first),
            loadLibraryImage(second),
        ]);
        if (request !== compareLoadRequest) return;
        compareItems = [firstLoaded.item, secondLoaded.item];
        compareSideImageA.el.src = firstLoaded.data;
        compareSideImageB.el.src = secondLoaded.data;
        compareOverlayBase.el.src = firstLoaded.data;
        compareOverlayTop.el.src = secondLoaded.data;
        renderCompareSelectors(first.id, second.id);
        renderComparison();
        compareLoadingStatus.el.hidden = true;
        return true;
    } catch (error) {
        if (request === compareLoadRequest) {
            if (compareItems)
                renderCompareSelectors(compareItems[0].id, compareItems[1].id);
            compareLoadingStatus.el.textContent = t(
                "이미지를 불러오지 못했습니다.",
            );
            compareLoadingStatus.el.hidden = false;
            showToast(errorMessage(error), true);
        }
        return false;
    } finally {
        if (request === compareLoadRequest) {
            compareDialog.el.classList.remove("loading");
            compareDialog.el.setAttribute("aria-busy", "false");
        }
    }
}

function setCompareMode(mode: "side" | "overlay" | "wipe") {
    compareMode = mode;
    renderComparison();
}

function setCompareZoom(value: number) {
    compareZoom = Math.max(0.5, Math.min(3, value));
    renderComparison();
}

function renderComparison() {
    if (!compareItems) return;
    const [first, second] = compareItems;
    compareSideNameA.el.textContent = `A · ${first.name}`;
    compareSideNameB.el.textContent = `B · ${second.name}`;
    compareZoomLabel.el.textContent = `${Math.round(compareZoom * 100)}%`;
    compareSide.el.hidden = compareMode !== "side";
    compareOverlay.el.hidden = compareMode === "side";
    for (const [mode, control] of compareModeButtons) {
        control.classList.toggle("active", mode === compareMode);
        control.setAttribute(
            "aria-pressed",
            mode === compareMode ? "true" : "false",
        );
    }
    const width = `${compareZoom * 100}%`;
    compareSideImageA.el.style.width = width;
    compareSideImageB.el.style.width = width;
    compareOverlayBase.el.style.width = width;
    compareOverlayTop.el.style.width = width;
    compareMixControl.el.hidden = compareMode === "side";
    compareMixLabel.el.textContent =
        compareMode === "overlay"
            ? `${t("투명도")} ${compareMix}%`
            : `${t("경계")} ${compareMix}%`;
    if (compareMode === "overlay") {
        compareOverlayTop.el.style.clipPath = "none";
        compareOverlayTop.el.style.opacity = String(compareMix / 100);
        compareDivider.el.hidden = true;
    } else if (compareMode === "wipe") {
        compareOverlayTop.el.style.opacity = "1";
        compareOverlayTop.el.style.clipPath = `inset(0 ${100 - compareMix}% 0 0)`;
        compareDivider.el.hidden = false;
        const dividerPosition =
            compareZoom < 1
                ? (1 - compareZoom) * 50 + compareZoom * compareMix
                : compareZoom * compareMix;
        compareDivider.el.style.left = `${dividerPosition}%`;
    }
}

async function composeLayout(
    ids: string[],
    mode: "steps" | "compare" | "timeline",
) {
    const ordered = ids
        .map((id) => findKnownItem(id))
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
        if (activePage === "board") await captureBoard.flush();
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
        const [nextState, preferences, styles, smartFilters, colors] =
            await Promise.all([
                window.openCapture.getState(),
                window.openCapture.getPreferences(),
                window.openCapture.listStyles(),
                window.openCapture.listSmartFilters(),
                window.openCapture.getSampledColors(),
            ]);
        appState = nextState;
        experiencePreferences = preferences;
        savedStyles = styles;
        savedSmartFilters = smartFilters;
        recentColors = colors;
        experiencePanel.update(preferences);
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
        void renderMinimalHome();
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
    const item = findKnownItem(id);
    if (item) openQuickLook(item);
}

async function openBundlePreview() {
    const items = selectedItemsInOrder().filter(isComparableImage);
    await bundleComposer.open(items);
}

async function copySelectedSourceFiles() {
    const ids = [...selectedItemIds];
    if (!ids.length) return;
    try {
        const result = await window.openCapture.copySourceFiles(ids);
        showToast(`원본 파일 ${result.copied}개를 복사했습니다.`);
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function mutateSelectedItems(kind: "promote" | "trash" | "restore") {
    const ids = [...selectedItemIds];
    if (!ids.length) return;
    await mutateItems(ids, kind);
}

async function repairDraftItem(id: string) {
    try {
        await window.openCapture.repairDraft(id);
        await refreshState();
        await refreshLibraryQuery(true);
        showToast(t("손상된 캡처를 복구했습니다."));
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function mutateItems(
    ids: string[],
    kind: "promote" | "trash" | "restore",
) {
    try {
        if (kind === "promote") await window.openCapture.promoteItems(ids);
        else if (kind === "trash") await window.openCapture.trashItems(ids);
        else await window.openCapture.restoreItems(ids);
        selectedItemIds.clear();
        await refreshState();
        await refreshLibraryQuery(true);
        showToast(
            kind === "promote"
                ? "보관함으로 옮겼습니다."
                : kind === "trash"
                  ? "휴지통으로 옮겼습니다."
                  : "복원했습니다.",
        );
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function saveCurrentSmartFilter() {
    const name = window.prompt("스마트 컬렉션 이름");
    if (!name?.trim()) return;
    const filter: SavedSmartFilter = {
        id: crypto.randomUUID(),
        name: name.trim(),
        tags: activeTag ? [activeTag] : undefined,
        date: todayOnly ? "today" : smartFilter === "week" ? "week" : undefined,
        type: smartFilter === "videos" ? "video" : undefined,
        favorites: favoritesOnly || undefined,
        ocrOnly: ocrOnly || undefined,
    };
    try {
        await window.openCapture.saveSmartFilter(filter);
        savedSmartFilters = await window.openCapture.listSmartFilters();
        activeSavedSmartId = filter.id;
        renderSavedWorkspaceTools();
        await refreshLibraryQuery(true);
        showToast("스마트 컬렉션을 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function saveCurrentBeautifyStyle() {
    const name = window.prompt("스타일 이름");
    if (!name?.trim()) return;
    const style: NamedBeautifyStyle = {
        id: crypto.randomUUID(),
        name: name.trim(),
        background: beautifyOptions.background,
        padding: beautifyOptions.padding,
        shadow: beautifyOptions.shadow,
        radius: beautifyOptions.radius,
        ratio: String(beautifyOptions.ratio),
        align: beautifyOptions.align,
        autoBalance: beautifyOptions.autoBalance,
    };
    try {
        await window.openCapture.saveStyle(style);
        savedStyles = await window.openCapture.listStyles();
        renderSavedWorkspaceTools();
        beautifyStyleSelect.el.value = style.id;
        showToast("스타일을 저장했습니다.");
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

function applySavedStyle(id: string) {
    const style = savedStyles.find((candidate) => candidate.id === id);
    if (!style) return;
    beautifyOptions.background = style.background;
    beautifyOptions.padding = style.padding;
    beautifyOptions.shadow = style.shadow;
    beautifyOptions.radius = style.radius;
    beautifyOptions.ratio = Number(style.ratio) || 0;
    beautifyOptions.align = style.align;
    beautifyOptions.autoBalance = style.autoBalance;
    autoBalanceCheck.el.checked = style.autoBalance;
    for (const [key, control] of beautifySliderInputs)
        control.value = String(beautifyOptions[key]);
    renderBeautify();
}

function renderSavedWorkspaceTools() {
    savedSmartSelect.clear();
    savedSmartSelect.add(
        ele("option").attr({ value: "", textContent: "저장된 보기" }),
    );
    for (const filter of savedSmartFilters)
        savedSmartSelect.add(
            ele("option").attr({ value: filter.id, textContent: filter.name }),
        );
    savedSmartSelect.el.value = activeSavedSmartId;
    savedSmartRow.clear();
    for (const filter of savedSmartFilters)
        savedSmartRow.add(
            view("x")
                .class("saved-tool-chip")
                .add([
                    button(filter.name)
                        .class("text-button", "compact")
                        .attr({ type: "button" })
                        .on("click", () => {
                            activeSavedSmartId = filter.id;
                            savedSmartSelect.el.value = filter.id;
                            showPage("library");
                            void refreshLibraryQuery(true);
                        }),
                    button("×")
                        .class("saved-tool-remove")
                        .attr({
                            type: "button",
                            ariaLabel: `${filter.name} 삭제`,
                        })
                        .on(
                            "click",
                            () => void removeSavedSmartFilter(filter.id),
                        ),
                ]),
        );
    if (!savedSmartFilters.length)
        savedSmartRow.add(label("small", "저장된 스마트 컬렉션 없음"));

    beautifyStyleSelect.clear();
    beautifyStyleSelect.add(
        ele("option").attr({ value: "", textContent: "스타일 프리셋" }),
    );
    savedStyleRow.clear();
    for (const style of savedStyles) {
        beautifyStyleSelect.add(
            ele("option").attr({ value: style.id, textContent: style.name }),
        );
        savedStyleRow.add(
            view("x")
                .class("saved-tool-chip")
                .add([
                    button(style.name)
                        .class("text-button", "compact")
                        .attr({ type: "button", title: "꾸미기에서 적용" })
                        .on("click", () => applySavedStyle(style.id)),
                    button("×")
                        .class("saved-tool-remove")
                        .attr({
                            type: "button",
                            ariaLabel: `${style.name} 삭제`,
                        })
                        .on("click", () => void removeSavedStyle(style.id)),
                ]),
        );
    }
    if (!savedStyles.length)
        savedStyleRow.add(label("small", "저장된 스타일 없음"));

    recentColorRow.clear();
    for (const sample of recentColors.slice(0, 16))
        recentColorRow.add(
            button()
                .class("recent-color-chip")
                .style({ background: sample.value })
                .attr({
                    type: "button",
                    title: `${sample.value} 복사`,
                    ariaLabel: `${sample.value} 복사`,
                })
                .on("click", () => {
                    void navigator.clipboard.writeText(sample.value);
                    showToast(`${sample.value} 복사`);
                }),
        );
    if (!recentColors.length)
        recentColorRow.add(label("small", "최근 추출 색상 없음"));
}

async function removeSavedStyle(id: string) {
    try {
        await window.openCapture.removeStyle(id);
        savedStyles = await window.openCapture.listStyles();
        renderSavedWorkspaceTools();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function removeSavedSmartFilter(id: string) {
    try {
        await window.openCapture.removeSmartFilter(id);
        if (activeSavedSmartId === id) activeSavedSmartId = "";
        savedSmartFilters = await window.openCapture.listSmartFilters();
        renderSavedWorkspaceTools();
        await refreshLibraryQuery(true);
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

function renderDiagnostics() {
    diagnosticsList.clear();
    const records = appState.runtime.captureDiagnostics ?? [];
    if (!records.length) {
        diagnosticsList.add(label("small", "아직 캡처 진단 기록이 없습니다."));
        return;
    }
    const latestByRequest = new Map<string, (typeof records)[number]>();
    for (const record of records) latestByRequest.set(record.requestId, record);
    for (const record of [...latestByRequest.values()].slice(-12).reverse())
        diagnosticsList.add(
            view("x")
                .class(
                    "diagnostic-row",
                    record.phase === "failed" ? "failed" : "",
                )
                .add([
                    label("strong", record.phase),
                    label(
                        "small",
                        record.input ?? record.requestId.slice(0, 8),
                    ),
                    label("small", record.detail ?? formatDate(record.at)),
                ]),
        );
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
    collectionSelect.el.disabled = libraryScope !== "library";

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
    libraryTitle.el.textContent =
        libraryScope === "temporary"
            ? "임시 캡처"
            : libraryScope === "trash"
              ? "휴지통"
              : (activeCollection?.name ?? t("저장된 캡처"));
    const displayedTotal = queriedItems ? queriedTotal : visibleItems.length;
    itemCount.el.textContent = filtered
        ? `${displayedTotal}개 · 전체 ${appState.totalItemCount}개`
        : appState.totalItemCount > appState.items.length
          ? `${displayedTotal}개 · 전체 ${appState.totalItemCount}개`
          : `${displayedTotal}개`;
    for (const [scope, control] of scopeButtons) {
        const active = scope === libraryScope;
        control.classList.toggle("active", active);
        control.setAttribute("aria-selected", String(active));
    }
    for (const [key, checkbox] of workflowInputs)
        checkbox.checked = appState.workflow[key];
    if (experiencePreferences) {
        document.documentElement.dataset.captureMotion =
            experiencePreferences.feedback.motion;
        document.documentElement.classList.toggle(
            "capture-visual-feedback",
            experiencePreferences.feedback.visual,
        );
    }
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
    const selectedItems = selectedItemsInOrder();
    const selectedImagesOnly =
        selectedItems.length === selectedCount &&
        selectedItems.every(isComparableImage);
    copyBundleButton.el.disabled =
        copyBundleBusy ||
        selectedCount < 2 ||
        selectedCount > 12 ||
        !selectedImagesOnly;
    compareSelectionButton.el.disabled =
        selectedCount < 2 || selectedCount > 20 || !selectedImagesOnly;
    copySourceFilesButton.el.disabled = !selectedCount || selectedCount > 50;
    promoteSelectionButton.el.hidden = libraryScope !== "temporary";
    trashSelectionButton.el.hidden = libraryScope === "trash";
    restoreSelectionButton.el.hidden = libraryScope !== "trash";
    loadMoreButton.el.hidden =
        Boolean(queriedItems) ||
        appState.items.length >= appState.totalItemCount;
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
    smartSelect.el.value = smartFilter;
    smartSelect.el.classList.toggle("active", Boolean(smartFilter));
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
    renderLibraryWindow();
    renderDiagnostics();
    renderSavedWorkspaceTools();
    if (quickLookDialog.el.open) renderQuickLook();
}

function visibleLibraryItems() {
    if (queriedItems)
        return queriedItems.filter((item): item is OpenCaptureItem =>
            Boolean(item),
        );
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
    if (smartFilter === "week") {
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        items = items.filter((item) => Date.parse(item.createdAt) >= weekAgo);
    } else if (smartFilter === "uncategorized")
        items = items.filter((item) => !item.collectionId);
    else if (smartFilter === "videos")
        items = items.filter((item) => isVideoItem(item));
    else if (smartFilter === "no-ocr")
        items = items.filter(
            (item) =>
                !item.ocrDone && !isVideoItem(item) && !isProjectItem(item),
        );
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

function currentSmartId() {
    if (activeSavedSmartId) return activeSavedSmartId;
    if (todayOnly) return "builtin:today";
    const builtins: Record<typeof smartFilter, string | undefined> = {
        "": undefined,
        week: "builtin:week",
        uncategorized: "builtin:uncategorized",
        videos: "builtin:video",
        "no-ocr": "builtin:no-ocr",
    };
    return builtins[smartFilter];
}

function currentQuery(offset: number, limit: number): CaptureItemsQuery {
    return {
        scope: libraryScope,
        collectionId:
            libraryScope === "library"
                ? (appState.activeCollectionId ?? undefined)
                : undefined,
        search: searchQuery || undefined,
        tags: activeTag ? [activeTag] : undefined,
        smartId: currentSmartId(),
        favorites: favoritesOnly || undefined,
        ocrOnly: ocrOnly || undefined,
        sort:
            sortMode === "new"
                ? "newest"
                : sortMode === "old"
                  ? "oldest"
                  : "name",
        offset,
        limit,
        queryId: String(querySequence),
        catalogRevision,
    };
}

async function queryLibraryPage(offset: number, limit = 160) {
    const sequence = querySequence;
    if (pendingQueryPages.has(offset)) return;
    pendingQueryPages.add(offset);
    try {
        const result = await window.openCapture.queryItems(
            currentQuery(offset, limit),
        );
        if (sequence !== querySequence || result.queryId !== String(sequence))
            return;
        catalogRevision = result.catalogRevision;
        queriedTotal = result.total;
        if (!queriedItems || queriedItems.length !== result.total)
            queriedItems = Array.from({ length: result.total });
        result.items.forEach((item, index) => {
            if (queriedItems) queriedItems[offset + index] = item;
        });
        renderState();
    } catch (error) {
        if (sequence === querySequence) showToast(errorMessage(error), true);
    } finally {
        pendingQueryPages.delete(offset);
    }
}

async function refreshLibraryQuery(immediate = false) {
    if (libraryQueryTimer) clearTimeout(libraryQueryTimer);
    const run = () => {
        querySequence += 1;
        catalogRevision = undefined;
        queriedItems = null;
        queriedTotal = 0;
        pendingQueryPages.clear();
        void queryLibraryPage(0);
    };
    if (immediate) run();
    else libraryQueryTimer = setTimeout(run, 140);
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

function renderItems(
    items: Array<OpenCaptureItem | undefined>,
    options: { top?: number; bottom?: number; startIndex?: number } = {},
) {
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
    if (options.top) {
        const spacer = document.createElement("div");
        spacer.className = "virtual-library-spacer";
        spacer.style.height = `${options.top}px`;
        fragment.append(spacer);
    }
    for (const [itemIndex, item] of items.entries()) {
        const absoluteIndex = (options.startIndex ?? 0) + itemIndex;
        if (!item) {
            const placeholder = document.createElement("div");
            placeholder.className = "virtual-library-card-placeholder";
            placeholder.dataset.itemIndex = String(absoluteIndex);
            placeholder.setAttribute("aria-hidden", "true");
            fragment.append(placeholder);
            continue;
        }
        const thumbnail = view().class("item-thumbnail");
        const status = item.status ?? "library";
        if (item.draftCorrupt)
            thumbnail.add(
                label("small", t("손상됨")).class(
                    "item-status-badge",
                    "corrupt",
                ),
            );
        else if (status !== "library")
            thumbnail.add(
                label(
                    "small",
                    status === "temporary" ? "임시" : "휴지통",
                ).class("item-status-badge", status),
            );
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
        } else if (isProjectItem(item)) {
            thumbnail.add(view().class("item-video-badge").add("✎"));
        }
        if (item.ocrText) {
            const ocrPreview = view("y").class("item-ocr-preview");
            const ocrLines = item.ocrText
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            const showAll =
                searchQuery &&
                ocrLines.some((l) => l.toLowerCase().includes(searchQuery));
            for (const line of ocrLines.slice(0, showAll ? 6 : 4)) {
                const lineLabel = ele("small");
                const lower = line.toLowerCase();
                const hit = searchQuery ? lower.indexOf(searchQuery) : -1;
                if (hit >= 0) {
                    lineLabel.el.append(
                        line.slice(0, hit),
                        Object.assign(document.createElement("mark"), {
                            textContent: line.slice(
                                hit,
                                hit + searchQuery.length,
                            ),
                        }),
                        line.slice(hit + searchQuery.length),
                    );
                } else lineLabel.el.textContent = line;
                ocrPreview.add(
                    button()
                        .class("ocr-line")
                        .attr({ type: "button", title: t("클릭하여 복사") })
                        .add(lineLabel)
                        .on("click", (event) => {
                            event.stopPropagation();
                            void navigator.clipboard
                                ?.writeText(line)
                                .then(() => showToast(t("복사했습니다")));
                        }),
                );
            }
            thumbnail.add(ocrPreview);
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
                        Math.min(lastSelectIndex, absoluteIndex),
                        Math.max(lastSelectIndex, absoluteIndex),
                    ];
                    const selectionSource = queriedItems ?? items;
                    for (const range of selectionSource.slice(from, to + 1))
                        if (range) selectedItemIds.add(range.id);
                    renderState();
                }
            })
            .on("change", (event) => {
                event.stopPropagation();
                lastSelectIndex = absoluteIndex;
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
            isVideoItem(item) || isProjectItem(item)
                ? void runAction("open-item", item.id)
                : openQuickLook(item),
        );
        itemCard.el.dataset.itemId = item.id;
        itemCard.el.dataset.itemIndex = String(absoluteIndex);
        fragment.append(itemCard.el);
    }
    if (options.bottom) {
        const spacer = document.createElement("div");
        spacer.className = "virtual-library-spacer";
        spacer.style.height = `${options.bottom}px`;
        fragment.append(spacer);
    }
    itemGrid.el.append(fragment);
}

function renderLibraryWindow() {
    const items = visibleLibraryItems();
    if (!queriedItems || queriedTotal <= 120) {
        renderItems(items);
        return;
    }
    const gridRect = itemGrid.el.getBoundingClientRect();
    const contentRect = content.el.getBoundingClientRect();
    const size = thumbSize === "s" ? 180 : thumbSize === "l" ? 300 : 235;
    const range = virtualLibraryRange({
        total: queriedTotal,
        viewportTop: content.el.scrollTop,
        viewportHeight: content.el.clientHeight,
        gridTop: itemGrid.el.offsetTop,
        gridWidth: gridRect.width || contentRect.width,
        cardWidth: size,
        rowHeight: thumbSize === "l" ? 310 : thumbSize === "s" ? 210 : 255,
        gap: 16,
        overscanRows: 3,
    });
    const missingIndex = queriedItems
        .slice(range.start, range.end)
        .findIndex((item) => !item);
    if (missingIndex >= 0)
        void queryLibraryPage(
            Math.floor((range.start + missingIndex) / 160) * 160,
        );
    const windowSlots = virtualLibrarySlots(
        queriedItems,
        range.start,
        range.end,
    );
    renderItems(
        windowSlots.map((slot) => slot.item),
        {
            top: range.top,
            bottom: range.bottom,
            startIndex: windowSlots[0]?.index ?? range.start,
        },
    );
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
        : isProjectItem(item)
          ? [
                ["✎", t("주석·편집"), () => runAction("open-item", item.id)],
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
    if (item.draftCorrupt)
        entries.unshift([
            "↺",
            t("손상된 임시 캡처 복구"),
            () => void repairDraftItem(item.id),
        ]);
    if ((item.status ?? "library") === "temporary")
        entries.unshift([
            "▤",
            "보관함으로 이동",
            () => void mutateItems([item.id], "promote"),
        ]);
    if ((item.status ?? "library") === "trash")
        entries.unshift([
            "↺",
            "복원",
            () => void mutateItems([item.id], "restore"),
        ]);
    else
        entries.push([
            "×",
            "휴지통으로 이동",
            () => void mutateItems([item.id], "trash"),
        ]);
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
    compareDialog,
    onboardDialog,
];
const externalDialogs = [
    bundleComposer.dialog,
    referenceComparison.dialog,
    commandPalette.dialog,
];

function closeModal(dialog: HTMLDialogElement) {
    if (!dialog.open) return;
    dialog.close();
    if (
        !allDialogs.some((d) => d.el.open) &&
        !externalDialogs.some((candidate) => candidate.open)
    ) {
        modalBackdrop.el.hidden = true;
        document.body.classList.remove("modal-open");
    }
}

function closeAllModals() {
    for (const dialog of allDialogs) if (dialog.el.open) dialog.el.close();
    for (const dialog of externalDialogs) if (dialog.open) dialog.close();
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
    const previous = findKnownItem(id)?.name;
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
    const previous = findKnownItem(id)?.note;
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
        const freeX = cw - dw;
        const freeY = ch - dh;
        const align = beautifyOptions.align;
        const ax = align.includes("l") ? 0 : align.includes("r") ? 1 : 0.5;
        const ay = align.startsWith("t")
            ? 0
            : align.startsWith("b")
              ? 1
              : beautifyOptions.autoBalance
                ? 0.42
                : 0.5;
        dx = Math.round(freeX * ax);
        dy = Math.round(freeY * ay);
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

let quickLookCutoutRequest = 0;
async function cutoutQuickLookItem(item: OpenCaptureItem) {
    const request = ++quickLookCutoutRequest;
    quickLookHold.setBusy(true);
    try {
        const result = await window.openCapture.cutoutImage({
            itemId: item.id,
        });
        if (request !== quickLookCutoutRequest || quickLookId !== item.id)
            return;
        await refreshState();
        await refreshLibraryQuery(true);
        openQuickLook(result.item);
        showToast("배경을 제거한 사본을 만들었습니다.", false, [
            ["원본 보기", () => openQuickLook(item)],
            [
                "되돌리기",
                () => {
                    void (async () => {
                        try {
                            await window.openCapture.trashItems([
                                result.item.id,
                            ]);
                            await refreshState();
                            await refreshLibraryQuery(true);
                            openQuickLook(item);
                        } catch (error) {
                            showToast(errorMessage(error), true);
                        }
                    })();
                },
            ],
        ]);
    } catch (error) {
        if (request === quickLookCutoutRequest)
            showToast(errorMessage(error), true, [
                ["다시 시도", () => void cutoutQuickLookItem(item)],
            ]);
    } finally {
        if (request === quickLookCutoutRequest) quickLookHold.setBusy(false);
    }
}

const quickLookHold: ImageHoldHandle = createImageHold(qlImage.el, {
    progressLabel: "길게 눌러 배경 제거",
    disabled: () => {
        const item = quickLookId ? findKnownItem(quickLookId) : undefined;
        return (
            !item ||
            !qlCropOverlay.el.hidden ||
            isVideoItem(item) ||
            isGifItem(item) ||
            isProjectItem(item)
        );
    },
    onHold: () => {
        const item = quickLookId ? findKnownItem(quickLookId) : undefined;
        if (item) return cutoutQuickLookItem(item);
    },
});

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
    const item = quickLookId ? findKnownItem(quickLookId) : undefined;
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
        let wrotePalette = false;
        const framesSimilar = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
            if (a.length !== b.length) return false;
            let diff = 0;
            let n = 0;
            for (let i = 0; i < a.length; i += 64) {
                diff += Math.abs(a[i] - b[i]);
                n++;
            }
            return n > 0 && diff / n < 2;
        };
        let pending:
            | { data: Uint8ClampedArray; w: number; h: number; delay: number }
            | undefined;
        const flushPending = () => {
            if (!pending) return;
            palette ??= quantize(pending.data, 256) as [
                number,
                number,
                number,
            ][];
            const index = applyPalette(pending.data, palette);
            gif.writeFrame(index, pending.w, pending.h, {
                palette: wrotePalette ? undefined : palette,
                delay: pending.delay,
            });
            wrotePalette = true;
            pending = undefined;
        };
        for (let i = start; i <= end; i++) {
            const { image } = await target.decoder.decode({
                frameIndex: i,
            });
            canvas.width = image.codedWidth;
            canvas.height = image.codedHeight;
            ctx.drawImage(image, 0, 0);
            const delay = Math.max(
                20,
                Math.round((image.duration ?? 100_000) / 1000),
            );
            image.close();
            const data = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
            ).data;
            if (pending && framesSimilar(data, pending.data)) {
                pending.delay += delay;
                continue;
            }
            flushPending();
            pending = {
                data,
                w: canvas.width,
                h: canvas.height,
                delay,
            };
        }
        flushPending();
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
    const item = quickLookId ? findKnownItem(quickLookId) : undefined;
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
                    void refreshLibraryQuery(true);
                }),
        );
    }
}

function isLibraryFiltered() {
    return Boolean(
        searchQuery ||
            favoritesOnly ||
            todayOnly ||
            ocrOnly ||
            activeTag ||
            smartFilter,
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
    if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !event.altKey
    ) {
        event.preventDefault();
        openDashboardCommands();
        return;
    }
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
content.el.addEventListener("scroll", () => {
    if (!queriedItems || queriedTotal <= 120 || virtualScrollScheduled) return;
    virtualScrollScheduled = true;
    requestAnimationFrame(() => {
        virtualScrollScheduled = false;
        const focusedId =
            document.activeElement?.closest<HTMLElement>("[data-item-id]")
                ?.dataset.itemId;
        renderLibraryWindow();
        if (focusedId)
            itemGrid.el
                .querySelector<HTMLElement>(
                    `[data-item-id="${CSS.escape(focusedId)}"]`,
                )
                ?.focus({ preventScroll: true });
    });
});

void showPage(activePage);
let libraryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
window.openCapture.onLibraryChanged(() => {
    if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
    libraryRefreshTimer = setTimeout(async () => {
        const previousNewest = appState.items[0]?.id;
        await refreshState();
        await refreshLibraryQuery(true);
        await renderMinimalHome();
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
window.openCapture.onCompareRequested((ids) => {
    void (async () => {
        libraryScope = "temporary";
        await refreshLibraryQuery(true);
        const result = await window.openCapture.queryItems({
            ...currentQuery(0, 80),
            scope: "temporary",
            queryId: `compare-${Date.now()}`,
            catalogRevision: undefined,
        });
        const requested = ids
            .map((id) => result.items.find((item) => item.id === id))
            .filter((item): item is OpenCaptureItem => Boolean(item));
        if (requested.length < 2) {
            showToast("비교할 임시 캡처를 찾지 못했습니다.", true);
            return;
        }
        selectedItemIds.clear();
        for (const item of requested) selectedItemIds.add(item.id);
        referenceComparison.open(
            requested.map((item) => ({
                id: item.id,
                name: item.name,
                thumbnail: item.thumbnail,
            })),
        );
    })();
});
void refreshState().then(() => {
    void refreshLibraryQuery(true);
    if (!localStorage.getItem("oc:onboarded")) openOnboarding();
});
void refreshTranslationStatus();
