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
import { icon } from "./icons";

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

type PageName = "home" | "library" | "translate" | "settings";

const emptyState: OpenCaptureState = {
    collections: [],
    items: [],
    activeCollectionId: null,
    defaultFolder: "",
    version: "",
    totalItemCount: 0,
    workflow: {
        autoCopy: false,
        autoRemoveBackground: false,
        autoPin: false,
        autoOcr: true,
    },
    runtime: { startAtLogin: false, shortcuts: [] },
};

let appState = emptyState;
let translationStatus: TranslationStatus | null = null;
let activePage: PageName = "home";
const selectedItemIds = new Set<string>();
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

const prismField = view()
    .class("prism-field")
    .attr({ ariaHidden: "true" })
    .addInto();
prismField.add([
    view().class("prism-orb", "prism-orb-cyan"),
    view().class("prism-orb", "prism-orb-violet"),
    view().class("prism-orb", "prism-orb-coral"),
    view().class("prism-orb", "prism-orb-blue"),
    view().class("prism-beam"),
]);

const windowTitlebar = view("x").class("window-titlebar").addInto();
windowTitlebar.add([
    view().class("window-titlebar-mark").add(icon("⌁")),
    label("span", "OpenCapture"),
]);

const shell = view("x").class("app-shell").addInto();
const sidebar = ele("aside").class("sidebar").addInto(shell);
const main = ele("main").class("main").addInto(shell);

const brand = view("x").class("brand").addInto(sidebar);
brand.add([
    view().class("brand-mark").add(icon("⌁")),
    view("y")
        .class("brand-copy")
        .add([
            label("strong", "OpenCapture"),
            label("small", "내 화면을 더 가볍게"),
        ]),
]);

const navigation = ele("nav").class("navigation").addInto(sidebar);
const navItems: { page: PageName; icon: string; text: string }[] = [
    { page: "home", icon: "⌂", text: "홈" },
    { page: "library", icon: "▧", text: "라이브러리" },
    { page: "translate", icon: "文", text: "번역" },
    { page: "settings", icon: "⚙", text: "설정" },
];

const navButtons = new Map<PageName, HTMLButtonElement>();
for (const item of navItems) {
    const navButton = button()
        .class("nav-button")
        .attr({ type: "button", ariaLabel: item.text })
        .add([icon(item.icon), label("span", item.text)])
        .on("click", () => showPage(item.page))
        .addInto(navigation);
    navButtons.set(item.page, navButton.el);
}

const sidebarBottom = view("y").class("sidebar-bottom").addInto(sidebar);
button()
    .class("shortcut-button")
    .attr({ type: "button" })
    .add([icon("⌘"), label("span", "단축키 보기"), label("small", "?")])
    .on("click", () => openShortcutSheet())
    .addInto(sidebarBottom);
button()
    .class("text-button", "guide-button")
    .attr({ type: "button" })
    .add([icon("✦"), label("span", "시작 가이드")])
    .on("click", () => openOnboarding())
    .addInto(sidebarBottom);

const versionLabel = label("small", "OpenCapture")
    .class("version")
    .addInto(sidebarBottom);

const topbar = view("x").class("topbar").addInto(main);
const titleGroup = view("y").class("title-group").addInto(topbar);
const pageEyebrow = label("small", "캡처 도구")
    .class("eyebrow")
    .addInto(titleGroup);
const pageTitle = label("h1", "캡처 작업실").addInto(titleGroup);
const topActions = view("x").class("top-actions").addInto(topbar);

button()
    .class("ghost-button", "compact", "window-action")
    .attr({ type: "button", title: "간단히 보기", ariaLabel: "간단히 보기" })
    .add([icon("↙"), label("span", "간단히")])
    .on("click", () => runAction("toggle-compact"))
    .addInto(topActions);
button()
    .class("ghost-button", "compact", "window-action")
    .attr({ type: "button", title: "창 숨기기", ariaLabel: "창 숨기기" })
    .add([icon("—"), label("span", "숨기기")])
    .on("click", () => runAction("hide-window"))
    .addInto(topActions);
button()
    .class("ghost-button", "compact")
    .attr({ type: "button", title: "이미지 열기" })
    .add([icon("＋"), label("span", "이미지 열기")])
    .on("click", () => runAction("open-image"))
    .addInto(topActions);
button()
    .class("primary-button", "compact")
    .attr({ type: "button" })
    .add([icon("⌗"), label("span", "새 캡처")])
    .on("click", () => runAction("capture"))
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
        title: "영역 캡처",
        description: "원하는 영역을 빠르게 선택해요",
        shortcut: "Ctrl + Shift + A",
        featured: true,
    },
    {
        name: "fullscreen",
        icon: "▣",
        title: "전체 화면",
        description: "현재 화면 전체를 바로 저장해요",
    },
    {
        name: "window",
        icon: "▤",
        title: "창 캡처",
        description: "열려 있는 창 하나만 골라요",
    },
    {
        name: "scroll",
        icon: "↕",
        title: "스크롤 캡처",
        description: "긴 페이지를 한 장으로 이어 붙여요",
    },
    {
        name: "record",
        icon: "●",
        title: "화면 녹화",
        description: "화면 움직임과 소리를 기록해요",
        shortcut: "Ctrl + Shift + R",
    },
    {
        name: "steps",
        icon: "≣",
        title: "단계 캡처",
        description: "클릭할 때마다 화면이 순서대로 저장돼요",
    },
    {
        name: "ocr",
        icon: "T",
        title: "텍스트 추출",
        description: "화면 속 글자를 바로 복사해요",
    },
    {
        name: "screen-translate",
        icon: "文",
        title: "화면 번역",
        description: "캡처한 문장을 선택한 언어로 번역해요",
    },
    {
        name: "pin-clipboard",
        icon: "◇",
        title: "클립보드 고정",
        description: "복사한 이미지를 화면 위에 띄워요",
    },
];

const welcome = view("x").class("welcome-card").addInto(homePage);
const welcomeCopy = view("y").class("welcome-copy").addInto(welcome);
welcomeCopy.add([
    label("small", "빠른 캡처").class("eyebrow"),
    label("h2", "순간을 담고,\n작업을 이어가세요.").class("hero-title"),
    p(
        "필요한 화면을 골라 저장하고, 바로 다음 작업으로 이어갈 수 있어요.",
    ).class("hero-description"),
    view("x")
        .class("hero-actions")
        .add([
            button()
                .class("primary-button", "hero-capture-button")
                .attr({ type: "button" })
                .add([icon("⌗"), label("span", "영역 캡처")])
                .on("click", () => runAction("capture")),
            label("small", "Ctrl + Shift + A").class("shortcut-pill"),
        ]),
]);
const welcomeArt = view()
    .class("welcome-art", "hero-capture-art")
    .add([
        view().class("capture-frame", "frame-back"),
        view().class("capture-frame", "frame-middle"),
        view()
            .class("capture-frame", "frame-front")
            .add([
                view()
                    .class("capture-frame-bar")
                    .add([
                        ele("span").class("frame-dot"),
                        ele("span").class("frame-dot"),
                        ele("span").class("frame-dot"),
                    ]),
                view()
                    .class("capture-frame-content")
                    .add(
                        view()
                            .class("capture-selection")
                            .add([
                                ele("span").class(
                                    "selection-corner",
                                    "top-left",
                                ),
                                ele("span").class(
                                    "selection-corner",
                                    "top-right",
                                ),
                                ele("span").class(
                                    "selection-corner",
                                    "bottom-left",
                                ),
                                ele("span").class(
                                    "selection-corner",
                                    "bottom-right",
                                ),
                            ]),
                    ),
            ]),
        view().class("hero-prism").add(icon("✦")),
        view().class("hero-lens").add(icon("⌁")),
    ]);
welcome.add(welcomeArt);

const homeHeading = view("x").class("section-heading").addInto(homePage);
homeHeading.add([
    view("y").add([
        label("h2", "빠른 실행"),
        p("자주 쓰는 도구를 한 번에 시작하세요."),
    ]),
    button("단축키 보기")
        .class("text-button")
        .attr({ type: "button" })
        .on("click", () => openShortcutSheet()),
]);

const actionGrid = view("x", "wrap").class("action-grid").addInto(homePage);
for (const action of captureActions) {
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
        .attr({ type: "button" })
        .data({ action: action.name, category })
        .on("click", () => {
            if (action.name === "steps") {
                void toggleSteps();
            } else runAction(action.name);
        });
    const cardTop = view("x")
        .class("action-card-top")
        .add([
            view().class("action-icon").add(icon(action.icon)),
            action.shortcut
                ? label("small", action.shortcut).class("key-hint")
                : undefined,
        ]);
    actionButton.add([
        cardTop,
        label("h3", action.title),
        p(action.description),
        label("span", "실행 →").class("action-link"),
    ]);
    actionButton.addInto(actionGrid);
}

const utilityRow = view("x").class("utility-row").addInto(homePage);
const recentSummary = view("x").class("utility-card").addInto(utilityRow);
recentSummary.add([
    view().class("utility-icon").add(icon("▧")),
    view("y")
        .class("utility-copy")
        .add([
            label("strong", "캡처 라이브러리"),
            label("span", "저장된 캡처를 한곳에서 관리하세요."),
        ]),
    button("열기")
        .class("outline-button", "compact")
        .attr({ type: "button" })
        .on("click", () => showPage("library")),
]);
const restorePins = view("x").class("utility-card").addInto(utilityRow);
restorePins.add([
    view().class("utility-icon", "mint").add(icon("◇")),
    view("y")
        .class("utility-copy")
        .add([
            label("strong", "고정 이미지 복원"),
            label("span", "포커스·깜빡임·클릭 통과를 해제해요."),
        ]),
    button("복원")
        .class("outline-button", "compact")
        .attr({ type: "button" })
        .on("click", () => runAction("restore-pins")),
]);

const workflowCard = view("y").class("workflow-card").addInto(homePage);
workflowCard.add([
    view("y")
        .class("workflow-copy")
        .add([
            label("h2", "캡처 뒤 자동 작업"),
            p(
                "필요한 작업만 선택하세요. 원본 캡처는 항상 보관되며 이미지는 자동으로 외부에 업로드되지 않습니다.",
            ),
        ]),
]);

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
        title: "클립보드에 복사",
        description: "캡처가 끝나면 바로 붙여넣을 수 있습니다.",
    },
    {
        key: "autoRemoveBackground",
        title: "배경 자동 제거",
        description: "로컬에서 배경을 제거한 사본을 만듭니다.",
    },
    {
        key: "autoPin",
        title: "화면에 고정",
        description: "완료된 이미지를 현재 화면 위에 띄웁니다.",
    },
    {
        key: "autoOcr",
        title: "텍스트 자동 인식",
        description:
            "캡처 속 글자를 기기 안에서 인식해 라이브러리 검색에 활용합니다.",
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
        .add([
            checkbox,
            view("y").add([
                label("strong", option.title),
                label("small", option.description),
            ]),
        ])
        .addInto(workflowChoices);
}

const libraryToolbar = view("x").class("section-toolbar").addInto(libraryPage);
const collectionGroup = view("y").class("field-group").addInto(libraryToolbar);
collectionGroup.add(label("small", "컬렉션"));
const collectionSelect = select([])
    .class("select-control")
    .attr({ ariaLabel: "컬렉션 선택" })
    .on("change", (_event, element) => {
        const id = element.el.value;
        if (id) runAction("choose-collection", id, true);
    })
    .addInto(collectionGroup);
const searchGroup = view("y").class("field-group").addInto(libraryToolbar);
searchGroup.add(label("small", "검색"));
const searchField = view("x").class("search-field").addInto(searchGroup);
searchField.add(view().class("search-icon").add(icon("⌕")));
const searchInput = input("text")
    .class("search-input")
    .attr({
        placeholder: "이름·메모·태그·본문 텍스트로 찾기",
        ariaLabel: "캡처 검색",
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
        title: "즐겨찾기만 보기",
        ariaLabel: "즐겨찾기만 보기",
    })
    .add([icon("★"), label("span", "즐겨찾기")])
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
    .add([icon("＋"), label("span", "폴더 추가")])
    .on("click", () => runAction("add-collection", undefined, true))
    .addInto(libraryButtons);
const fileInput = input("file")
    .class("visually-hidden")
    .attr({ multiple: true, accept: "image/*" });
fileInput.on("change", () => {
    const files = Array.from(fileInput.el.files ?? []);
    if (files.length) importFiles(files);
    fileInput.el.value = "";
});
fileInput.addInto(libraryPage);
button()
    .class("primary-button", "library-import-button")
    .attr({ type: "button" })
    .add([icon("⇧"), label("span", "이미지 가져오기")])
    .on("click", () => fileInput.el.click())
    .addInto(libraryButtons);

const filterBar = view("x", "wrap").class("filter-bar").addInto(libraryPage);
const todayChip = button()
    .class("chip-button")
    .attr({ type: "button", ariaPressed: "false" })
    .add([icon("◷"), label("span", "오늘")])
    .on("click", () => {
        todayOnly = !todayOnly;
        renderState();
    })
    .addInto(filterBar);
const ocrChip = button()
    .class("chip-button")
    .attr({ type: "button", ariaPressed: "false", title: "텍스트 인식된 캡처" })
    .add([icon("T"), label("span", "텍스트")])
    .on("click", () => {
        ocrOnly = !ocrOnly;
        renderState();
    })
    .addInto(filterBar);
const tagChipRow = view("x", "wrap").class("tag-chip-row").addInto(filterBar);
const filterBarEnd = view("x").class("filter-bar-end").addInto(filterBar);
const sortSelect = select([
    { value: "new", name: "최신순" },
    { value: "old", name: "오래된순" },
    { value: "name", name: "이름순" },
])
    .class("select-control", "sort-select")
    .attr({ ariaLabel: "정렬" })
    .on("change", (_event, element) => {
        sortMode = element.el.value as typeof sortMode;
        renderState();
    })
    .addInto(filterBarEnd);
const sizeSegment = view("x")
    .class("size-segment")
    .attr({ role: "group", ariaLabel: "썸네일 크기" })
    .addInto(filterBarEnd);
for (const [size, text] of [
    ["s", "작게"],
    ["m", "보통"],
    ["l", "크게"],
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
    .attr({ role: "button", tabIndex: 0, ariaLabel: "이미지 가져오기" })
    .add([
        view().class("drop-icon").add(icon("⇩")),
        label("strong", "이미지를 여기에 놓으세요"),
        p("PNG, JPG, GIF, WebP 파일을 현재 컬렉션에 저장합니다."),
        button("파일 선택")
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
const libraryTitle = label("h2", "저장된 캡처").addInto(libraryMeta);
const itemCount = label("small", "").class("count-badge").addInto(libraryMeta);
const selectionToolbar = view("x")
    .class("selection-toolbar")
    .addInto(libraryPage);
const selectionStatus = label("strong", "선택 없음").addInto(selectionToolbar);
const selectionActions = view("x", "wrap")
    .class("selection-actions")
    .addInto(selectionToolbar);
const selectDisplayedButton = button("표시된 항목 모두 선택")
    .class("text-button")
    .attr({ type: "button" })
    .on("click", () => {
        for (const item of visibleLibraryItems()) selectedItemIds.add(item.id);
        renderState();
    })
    .addInto(selectionActions);
const clearSelectionButton = button("선택 해제")
    .class("text-button")
    .attr({ type: "button" })
    .on("click", () => {
        selectedItemIds.clear();
        renderState();
    })
    .addInto(selectionActions);
for (const [text, action, direction] of [
    ["내보내기", "export-items"],
    ["고정", "pin-items"],
    ["세로 합치기", "combine-items", "vertical"],
    ["가로 합치기", "combine-items", "horizontal"],
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
button("번호 합치기")
    .class("outline-button", "compact", "combine-action")
    .attr({
        type: "button",
        title: "선택한 캡처를 번호가 붙은 순서 이미지로 합성",
    })
    .on("click", () => void composeSteps([...selectedItemIds]))
    .addInto(selectionActions);
button("텍스트 인식")
    .class("outline-button", "compact", "bulk-action")
    .attr({ type: "button", title: "선택한 캡처의 글자를 인식해 검색에 추가" })
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
const loadMoreButton = button("더 불러오기")
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
    { value: "auto", name: "언어 자동 감지" },
    { value: "ko", name: "한국어" },
    { value: "en", name: "영어" },
];
const sourceLanguage = select(languageOptions)
    .class("select-control")
    .addInto(translateControls);
sourceLanguage.el.value = "auto";
button()
    .class("swap-button")
    .attr({ type: "button", title: "언어 바꾸기", ariaLabel: "언어 바꾸기" })
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
sourceEditor.add(label("small", "원문"));
const sourceText = ele("textarea")
    .class("translation-textarea")
    .attr({
        placeholder: "번역할 내용을 입력하세요",
        spellcheck: false,
        maxLength: 5000,
    })
    .addInto(sourceEditor);
const sourceFooter = view("x").class("editor-footer").addInto(sourceEditor);
const characterCount = label("small", "0 / 5,000").addInto(sourceFooter);
sourceText.on("input", () => {
    characterCount.el.textContent = `${sourceText.el.value.length.toLocaleString()} / 5,000`;
});
button("번역하기")
    .class("primary-button")
    .attr({ type: "button" })
    .on("click", () => translateText())
    .addInto(sourceFooter);

const resultEditor = view("y")
    .class("translation-editor", "result-editor")
    .addInto(translationEditors);
resultEditor.add(label("small", "번역 결과"));
const resultText = ele("textarea")
    .class("translation-textarea")
    .attr({ placeholder: "번역 결과가 여기에 표시됩니다", readOnly: true })
    .addInto(resultEditor);
const resultFooter = view("x").class("editor-footer").addInto(resultEditor);
button()
    .class("text-button")
    .attr({ type: "button" })
    .add([icon("▣"), label("span", "결과 복사")])
    .on("click", async () => {
        if (!resultText.el.value) return;
        await navigator.clipboard.writeText(resultText.el.value);
        showToast("번역 결과를 복사했습니다.");
    })
    .addInto(resultFooter);

const modelPanel = view("y").class("model-panel").addInto(translatorLayout);
const engineTitle = label("h2", "무료 로컬 번역");
const engineNotice = p("로컬 엔진은 원문을 외부로 보내지 않습니다.");
const engineChoice = select<TranslationEngine>([
    { value: "local", name: "로컬 · 오프라인" },
    { value: "deepl", name: "DeepL · 온라인" },
    { value: "google", name: "Google · 온라인" },
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
modelPanel.add([
    label("small", "번역 엔진").class("eyebrow"),
    engineTitle,
    engineChoice,
    engineNotice,
]);
const statusRow = view("x").class("status-row").addInto(modelPanel);
const modelStatusDot = ele("span").class("status-dot").addInto(statusRow);
const modelStatusText = label("strong", "상태 확인 중").addInto(statusRow);
const modelDetails = p("설치 상태를 확인하고 있습니다.")
    .class("model-details")
    .addInto(modelPanel);
const installButton = button()
    .class("primary-button", "wide")
    .attr({ type: "button" })
    .add([icon("⇩"), label("span", "로컬 모델 설치")])
    .on("click", () => installModels())
    .addInto(modelPanel);
modelPanel.add(
    view("x")
        .class("privacy-note")
        .add([
            icon("✓"),
            p("화면·고정 이미지 번역은 기본 로컬 엔진을 사용합니다."),
        ]),
);

const settingsLayout = view("y").class("settings-layout").addInto(settingsPage);
const storageCard = view("y").class("settings-card").addInto(settingsLayout);
storageCard.add([
    view("x")
        .class("settings-card-heading")
        .add([
            view().class("settings-icon").add(icon("▰")),
            view("y").add([
                label("h2", "저장 위치"),
                p("캡처 파일이 저장되는 기본 폴더입니다."),
            ]),
        ]),
]);
const folderRow = view("x").class("folder-row").addInto(storageCard);
const folderPath = ele("code")
    .attr({ textContent: "확인 중…" })
    .addInto(folderRow);
button("폴더 추가")
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
        .add([
            view().class("settings-icon", "mint").add(icon("⌘")),
            view("y").add([
                label("h2", "빠른 실행"),
                p(
                    "단축키 칸을 클릭하고 새 키를 누르면 바로 바뀝니다. Backspace는 끄기, ↺는 기본값입니다.",
                ),
            ]),
        ]),
);
const startAtLoginInput = input("checkbox").attr({
    ariaLabel: "로그인할 때 OpenCapture 시작",
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
    .add([
        startAtLoginInput,
        view("y").add([
            label("strong", "로그인할 때 시작"),
            label(
                "small",
                "이 선택을 바꿀 때만 운영체제 시작 설정이 변경됩니다.",
            ),
        ]),
    ])
    .addInto(convenienceCard);

const mouseChordSelect = select([
    { value: "关闭", name: "끄기" },
    { value: "截屏", name: "영역 캡처" },
    { value: "快速截屏", name: "빠른 캡처" },
    { value: "录屏", name: "화면 녹화" },
    { value: "起始页", name: "시작 화면 열기" },
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
    .add([
        view().class("option-icon").add(icon("◉")),
        view("y").add([
            label("strong", "마우스 좌·우 동시 클릭"),
            label("small", "왼쪽과 오른쪽 버튼을 함께 누르면 바로 실행됩니다."),
        ]),
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
        .add([
            view().class("settings-icon", "lavender").add(icon("文")),
            view("y").add([
                label("h2", "외부 번역 연결"),
                p(
                    "선택 사항입니다. 개인 API 키는 안전한 저장소에 보관되고 화면에 다시 표시되지 않습니다.",
                ),
            ]),
        ]),
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
    .attr({ placeholder: "새 API 키 입력", autocomplete: "new-password" })
    .addInto(providerForm);
button("저장")
    .class("primary-button")
    .attr({ type: "button" })
    .on("click", () => saveProvider())
    .addInto(providerForm);
const providerStatus = p("연결 상태를 확인하고 있습니다.")
    .class("helper-text")
    .addInto(providerCard);

const aboutCard = view("x")
    .class("settings-card", "about-card")
    .addInto(settingsLayout);
aboutCard.add([
    view("x")
        .class("settings-card-heading")
        .add([
            view().class("settings-icon", "mint").add(icon("⌁")),
            view("y").add([
                label("h2", "OpenCapture"),
                p("무료 오픈소스 화면 캡처 도구"),
            ]),
        ]),
    label("small", "버전 확인 중").class("version-pill"),
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
    view("y").add([
        label("small", "빠른 실행").class("eyebrow"),
        label("h2", "단축키"),
    ]),
    button()
        .class("close-button")
        .attr({ type: "button", ariaLabel: "닫기" })
        .add(icon("×"))
        .on("click", () => closeShortcutSheet()),
]);
const shortcutList = view("y").class("shortcut-list").addInto(shortcutDialog);
const shortcutDescriptions: Record<string, string> = {
    toggle: "OpenCapture 열기",
    capture: "화면의 원하는 부분 선택",
    record: "영역을 선택해 녹화 시작",
    dropzone: "드래그 중 라이브러리 열기",
    selection: "선택된 텍스트 복사 후 번역",
    restore: "포커스와 클릭 통과 해제",
};

function renderShortcutSheet() {
    shortcutList.clear();
    for (const sc of appState.runtime.shortcuts) {
        const keyText = sc.active ?? sc.requested ?? "";
        const keys = keyText ? formatShortcut(keyText).split(" + ") : ["끄기"];
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
        截屏: "영역 캡처",
        快速截屏: "빠른 캡처",
        录屏: "화면 녹화",
        起始页: "시작 화면 열기",
    };
    const chord = appState.runtime.mouseChord ?? "关闭";
    if (chord !== "关闭")
        shortcutList.add(
            view("x")
                .class("shortcut-row")
                .add([
                    view("y").add([
                        label("strong", "마우스 좌·우 동시 클릭"),
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
button("닫기")
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
            view("y").add([
                label("small", "라이브러리").class("eyebrow"),
                label("h2", "이름 바꾸기"),
            ]),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: "닫기" })
                .add(icon("×"))
                .on("click", () => closeModal(renameDialog.el)),
        ]),
);
const renameInput = input("text")
    .class("text-control", "rename-input")
    .attr({
        maxLength: 100,
        ariaLabel: "새 파일 이름",
        placeholder: "새 이름 입력",
    })
    .addInto(renameDialog);
renameInput.on("keydown", (event) => {
    if (event.key === "Enter") void submitRename();
});
renameDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button("취소")
                .class("text-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(renameDialog.el)),
            button("저장")
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
            view("y").add([
                label("small", "라이브러리").class("eyebrow"),
                label("h2", "메모"),
            ]),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: "닫기" })
                .add(icon("×"))
                .on("click", () => closeModal(noteDialog.el)),
        ]),
);
noteDialog.add(p("이 캡처에 짧은 메모를 남겨 두세요.").class("dialog-desc"));
const noteInput = textarea()
    .class("text-control", "note-input")
    .attr({
        maxLength: 2000,
        rows: 4,
        ariaLabel: "메모 내용",
        placeholder: "예: 결제 화면 참고용, 보고서에 넣을 이미지",
    })
    .addInto(noteDialog);
noteDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button("취소")
                .class("text-button")
                .attr({ type: "button" })
                .on("click", () => closeModal(noteDialog.el)),
            button("저장")
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
    { id: "auto", name: "이미지에서 추출", css: "", fill: null },
    { id: "transparent", name: "투명", css: "", fill: null },
    {
        id: "sky",
        name: "하늘",
        css: "linear-gradient(135deg,#64F1E2,#79A7FF)",
        fill: ["#64F1E2", "#79A7FF"],
    },
    {
        id: "violet",
        name: "보라",
        css: "linear-gradient(135deg,#C1A9FF,#FF9BB8)",
        fill: ["#C1A9FF", "#FF9BB8"],
    },
    {
        id: "sunset",
        name: "노을",
        css: "linear-gradient(135deg,#FFBF83,#FF9BB8)",
        fill: ["#FFBF83", "#FF9BB8"],
    },
    {
        id: "night",
        name: "밤",
        css: "linear-gradient(135deg,#0B1526,#264D5E)",
        fill: ["#0B1526", "#264D5E"],
    },
    {
        id: "paper",
        name: "종이",
        css: "#F4F1EA",
        fill: ["#F4F1EA", "#E9E3D5"],
    },
];
const beautifyRatios: [string, number][] = [
    ["자유", 0],
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
            view("y").add([
                label("small", "공유용 이미지").class("eyebrow"),
                label("h2", "배경 꾸미기"),
            ]),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: "닫기" })
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

beautifyControls.add(label("small", "비율").class("control-label"));
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

beautifyControls.add(label("small", "배경").class("control-label"));
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
beautifySlider("여백", 0, 200, beautifyOptions.padding, (v) => {
    beautifyOptions.padding = v;
});
beautifySlider("둥글기", 0, 120, beautifyOptions.radius, (v) => {
    beautifyOptions.radius = v;
});
beautifySlider("그림자", 0, 120, beautifyOptions.shadow, (v) => {
    beautifyOptions.shadow = v;
});

beautifyDialog.add(
    view("x")
        .class("dialog-actions")
        .add([
            button()
                .class("outline-button")
                .attr({ type: "button" })
                .add([icon("▣"), label("span", "이미지 복사")])
                .on("click", () => void copyCanvas(beautifyCanvas.el)),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("⇩"), label("span", "컬렉션에 저장")])
                .on("click", () => void saveBeautified()),
        ]),
);
beautifyDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(beautifyDialog.el);
});

const upscaleOptions = { scale: 2, sharpen: true };
const upscaleScales = [2, 3, 4];
const UPSCALE_MAX_PIXELS = 24_000_000;

const upscaleDialog = ele("dialog")
    .class("shortcut-dialog", "beautify-dialog")
    .addInto(modalBackdrop);
upscaleDialog.add(
    view("x")
        .class("dialog-header")
        .add([
            view("y").add([
                label("small", "이미지 보정").class("eyebrow"),
                label("h2", "업스케일"),
            ]),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: "닫기" })
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

upscaleControls.add(label("small", "배율").class("control-label"));
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
const sharpenInput = input("checkbox").attr({ ariaLabel: "선명하게" });
sharpenInput.el.checked = true;
const sharpenRow = view("x")
    .class("slider-row", "check-row")
    .add([label("span", "선명하게").class("slider-title"), sharpenInput])
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
                .add([icon("▣"), label("span", "이미지 복사")])
                .on("click", () => {
                    const target = upscaleTarget;
                    if (!target) return;
                    if (upscaleOversized()) {
                        upscaleError.el.textContent =
                            "결과 크기가 너무 큽니다. 배율을 낮춰 주세요.";
                        return;
                    }
                    void copyCanvas(upscaleFull(target));
                }),
            button()
                .class("primary-button")
                .attr({ type: "button" })
                .add([icon("⇩"), label("span", "컬렉션에 저장")])
                .on("click", () => void saveUpscaled()),
        ]),
);
upscaleDialog.el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal(upscaleDialog.el);
});

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
    .attr({ type: "button", ariaLabel: "닫기" })
    .add(icon("×"))
    .on("click", () => closeModal(quickLookDialog.el))
    .addInto(qlHeader);
const qlBody = view("x").class("ql-body").addInto(quickLookDialog);
const qlStage = view().class("ql-stage").addInto(qlBody);
const qlImage = ele("img").class("ql-image").attr({ alt: "" }).addInto(qlStage);
const qlPrev = button()
    .class("ql-nav", "ql-prev")
    .attr({ type: "button", ariaLabel: "이전 캡처" })
    .add(label("span", "‹"))
    .on("click", () => quickLookNavigate(-1))
    .addInto(qlStage);
const qlNext = button()
    .class("ql-nav", "ql-next")
    .attr({ type: "button", ariaLabel: "다음 캡처" })
    .add(label("span", "›"))
    .on("click", () => quickLookNavigate(1))
    .addInto(qlStage);
const qlSide = view("y").class("ql-side").addInto(qlBody);
const qlActions = view("x", "wrap").class("ql-actions").addInto(qlSide);
const qlActionList: [string, string, (item: OpenCaptureItem) => void][] = [
    ["▣", "복사", (item) => runAction("copy-item", item.id)],
    ["⌖", "고정", (item) => runAction("pin-item", item.id)],
    ["✎", "주석·편집", (item) => runAction("open-item", item.id)],
    ["▨", "꾸미기", (item) => void openBeautify(item)],
    ["⤢", "업스케일", (item) => void openUpscale(item)],
    ["☰", "메모", (item) => openNote(item)],
    ["✦", "배경 제거", (item) => runAction("remove-background", item.id)],
    ["T", "이름", (item) => openRename(item)],
    ["⧉", "복제", (item) => runAction("duplicate-item", item.id)],
    ["▤", "폴더", (item) => runAction("reveal-item", item.id)],
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
qlSide.add(label("small", "태그").class("eyebrow", "ql-eyebrow"));
const qlTags = view("x", "wrap").class("ql-tags").addInto(qlSide);
const qlTagInput = input("text")
    .class("text-control", "tag-input")
    .attr({
        placeholder: "태그 입력 후 Enter",
        maxLength: 30,
        ariaLabel: "태그 추가",
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
        await runAction("set-tags", { id: item.id, tags });
    } else if (
        event.key === "Backspace" &&
        !qlTagInput.el.value &&
        item.tags?.length
    ) {
        const tags = item.tags.slice(0, -1);
        await runAction("set-tags", { id: item.id, tags });
    }
});
qlSide.add(label("small", "인식된 텍스트").class("eyebrow", "ql-eyebrow"));
const qlOcrStatus = label("small", "").addInto(qlSide);
const qlOcrText = ele("pre").class("ql-ocr-text").addInto(qlSide);
const qlOcrActions = view("x").class("ql-ocr-actions").addInto(qlSide);
button()
    .class("outline-button", "compact")
    .attr({ type: "button" })
    .add([icon("▣"), label("span", "텍스트 복사")])
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
    .add([icon("T"), label("span", "텍스트 인식")])
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
            view("y").add([
                label("small", "시작 가이드").class("eyebrow"),
                label("h2", "OpenCapture 시작하기"),
            ]),
            button()
                .class("close-button")
                .attr({ type: "button", ariaLabel: "닫기" })
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
            .add([
                view().class("onboard-icon").add(icon("⌗")),
                label("strong", "한 번에 캡처"),
                label("small", "언제든 이 단축키로 화면을 선택하세요."),
            ])
            .addInto(onboardGrid),
    );
const onboardChordCard = view("y")
    .class("onboard-card")
    .add([
        view().class("onboard-icon").add(icon("◉")),
        label("strong", "마우스로도 바로"),
        label("small", "좌·우 버튼을 함께 누르면 캡처가 시작됩니다."),
    ])
    .addInto(onboardGrid);
const onboardChordButton = button("지금 켜기")
    .class("outline-button", "compact")
    .attr({ type: "button" })
    .on("click", async () => {
        onboardChordButton.el.disabled = true;
        await runAction("configure-runtime", { mouseChord: "截屏" });
        await refreshState();
        onboardChordButton.el.textContent = "켜짐";
    })
    .addInto(onboardChordCard);
view("y")
    .class("onboard-card")
    .add([
        view().class("onboard-icon").add(icon("✦")),
        label("strong", "한 장에서 모두"),
        label(
            "small",
            "캡처 하나로 복사·고정·주석·번역·업스케일·태그·검색까지 바로 이어집니다.",
        ),
    ])
    .addInto(onboardGrid);
button("시작하기")
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
        onboardChordButton.el.textContent = "켜짐";
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

function showPage(page: PageName) {
    activePage = page;
    const titles: Record<PageName, [string, string]> = {
        home: ["캡처 도구", "캡처 작업실"],
        library: ["저장 공간", "내 캡처 모아보기"],
        translate: ["번역 도구", "텍스트를 내 언어로"],
        settings: ["환경 설정", "OpenCapture 설정"],
    };
    for (const [name, element] of pages)
        element.classList.toggle("active", name === page);
    for (const [name, element] of navButtons)
        element.classList.toggle("active", name === page);
    pageEyebrow.el.textContent = titles[page][0];
    pageTitle.el.textContent = titles[page][1];
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
    } catch (error) {
        showToast(errorMessage(error), true);
    }
}

async function toggleSteps() {
    const was = appState.runtime.stepCapture ?? false;
    await runAction("steps", undefined, true);
    if ((appState.runtime.stepCapture ?? false) && !was)
        showToast(
            "클릭할 때마다 화면이 저장됩니다. 카드를 다시 누르면 중지합니다.",
        );
}

async function composeSteps(ids: string[]) {
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
        const width = Math.max(...images.map((i) => i.naturalWidth), 1);
        const gap = 28;
        const badge = 40;
        const scaled = images.map((img) => ({
            img,
            w: Math.round((img.naturalWidth * width) / img.naturalWidth),
            h: Math.round((img.naturalHeight * width) / img.naturalWidth),
        }));
        const height = scaled.reduce((sum, i) => sum + i.h + gap, gap);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.fillStyle = "#f4f4f5";
        ctx.fillRect(0, 0, width, height);
        let y = gap;
        scaled.forEach(({ img, w, h }, index) => {
            ctx.drawImage(img, 0, y, w, h);
            ctx.beginPath();
            ctx.arc(
                badge / 2 + 14,
                y + badge / 2 + 14,
                badge / 2,
                0,
                Math.PI * 2,
            );
            ctx.fillStyle = "#2563eb";
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = `600 ${badge / 2 + 2}px system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(index + 1), badge / 2 + 14, y + badge / 2 + 15);
            y += h + gap;
        });
        await runAction("save-composed", {
            id: ordered[0].id,
            dataURL: canvas.toDataURL("image/png"),
            label: "Steps",
        });
        showToast("번호가 붙은 단계 이미지를 저장했습니다.");
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

async function refreshState() {
    try {
        appState = await window.openCapture.getState();
        if (appState.recoveryWarning) showToast(appState.recoveryWarning, true);
        renderState();
    } catch (error) {
        showToast(errorMessage(error), true);
    }
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
                textContent: "컬렉션 없음",
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
        "저장 폴더가 설정되지 않았습니다.";
    versionLabel.el.textContent = appState.version
        ? `OpenCapture ${appState.version}`
        : "OpenCapture";
    const versionPill =
        aboutCard.el.querySelector<HTMLElement>(".version-pill");
    if (versionPill)
        versionPill.textContent = appState.version
            ? `v${appState.version}`
            : "개발 버전";

    const visibleItems = visibleLibraryItems();
    const filtered = isLibraryFiltered();
    libraryTitle.el.textContent = activeCollection?.name ?? "저장된 캡처";
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
        : "선택 없음";
    clearSelectionButton.el.disabled = !selectedCount;
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
    const stepsCard = actionGrid.el.querySelector<HTMLElement>(
        '[data-action="steps"]',
    );
    if (stepsCard) {
        const running = appState.runtime.stepCapture ?? false;
        stepsCard.classList.toggle("active", running);
        const link = stepsCard.querySelector<HTMLElement>(".action-link");
        if (link) link.textContent = running ? "중지" : "실행 →";
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
const KEY_NAME_MAP: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    "+": "Plus",
    ";": ";",
    "=": "=",
    ",": ",",
    "-": "-",
    ".": ".",
    "/": "/",
    "`": "`",
    "[": "[",
    "]": "]",
    "\\": "\\",
    "'": "'",
};

function acceleratorFromEvent(e: KeyboardEvent): string | null {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    let key = "";
    if (/^.$/u.test(e.key)) key = (KEY_NAME_MAP[e.key] ?? e.key).toUpperCase();
    else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else key = KEY_NAME_MAP[e.key] ?? "";
    if (!key) return null;
    if (!parts.length && !/^F\d{1,2}$/.test(key)) return null;
    parts.push(key);
    return parts.join("+");
}

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
            placeholder: "단축키 없음",
            ariaLabel: `${shortcut.label} 단축키`,
            title: "클릭 후 새 단축키를 누르세요. Backspace는 끄기, Esc는 취소",
        });
    const reset = button()
        .class("shortcut-reset")
        .attr({
            type: "button",
            ariaLabel: "기본값으로 되돌리기",
            title: "기본값",
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
          ? "꺼짐"
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
        runtimeShortcutList.add(p("등록된 시스템 단축키가 없습니다."));
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
                          label("h3", "조건에 맞는 캡처가 없어요"),
                          p("검색어를 바꾸거나 즐겨찾기 필터를 해제해 보세요."),
                      ])
                : view("y")
                      .class("empty-state")
                      .add([
                          view().class("empty-icon").add(icon("▧")),
                          label("h3", "아직 저장된 캡처가 없어요"),
                          p(
                              "새로 캡처하거나 이미지를 가져오면 여기에 모입니다.",
                          ),
                          button("첫 캡처 시작")
                              .class("primary-button")
                              .attr({ type: "button" })
                              .on("click", () => runAction("capture")),
                      ]),
        );
        return;
    }

    for (const item of items) {
        const thumbnail = view().class("item-thumbnail");
        if (item.thumbnail) {
            thumbnail.add(
                ele("img")
                    .attr({ src: item.thumbnail, alt: "" })
                    .on("error", (_event, image) => image.el.remove()),
            );
        }
        const selectionInput = input("checkbox")
            .class("item-select")
            .attr({
                ariaLabel: `${item.name} 선택`,
                title: `${item.name} 선택`,
            });
        selectionInput.el.checked = selectedItemIds.has(item.id);
        selectionInput
            .on("click", (event) => event.stopPropagation())
            .on("change", (event) => {
                event.stopPropagation();
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
                title: item.favorite ? "즐겨찾기 해제" : "즐겨찾기",
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
        itemCard.on("click", () => openQuickLook(item));
        itemGrid.add(itemCard);
    }
}

async function loadMoreItems() {
    loadMoreButton.el.disabled = true;
    try {
        const result = await window.openCapture.action("load-items", {
            offset: appState.items.length,
            limit: 200,
        });
        if (!isItemsPage(result))
            throw new Error("라이브러리 응답을 확인할 수 없습니다.");
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
    const entries: [string, string, () => void][] = [
        ["⌕", "미리보기", () => openQuickLook(item)],
        ["⌖", "화면에 고정", () => runAction("pin-item", item.id)],
        ["▣", "클립보드에 복사", () => runAction("copy-item", item.id)],
        ["✎", "주석·편집", () => runAction("open-item", item.id)],
        ["▨", "배경 꾸미기", () => openBeautify(item)],
        ["⤢", "업스케일", () => openUpscale(item)],
        ["☰", "메모", () => openNote(item)],
        [
            "T",
            item.ocrDone ? "텍스트 다시 인식" : "텍스트 인식",
            () => void requestOcrIndex(item.id),
        ],
        ["✦", "배경 제거", () => runAction("remove-background", item.id)],
        ["T", "이름 바꾸기", () => openRename(item)],
        ["⧉", "복제", () => runAction("duplicate-item", item.id)],
        ["▤", "폴더에서 보기", () => runAction("reveal-item", item.id)],
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
        modelStatusText.el.textContent = "상태를 확인할 수 없음";
        modelDetails.el.textContent =
            "번역 서비스를 시작한 뒤 다시 확인해 주세요.";
    }
}

function renderTranslationStatus() {
    if (!translationStatus) return;
    const engine = translationStatus.engine ?? "local";
    engineChoice.el.value = engine;
    engineTitle.el.textContent =
        engine === "local"
            ? "무료 로컬 번역"
            : `${engine === "deepl" ? "DeepL" : "Google"} 온라인 번역`;
    engineNotice.el.textContent =
        engine === "local"
            ? "원문은 이 컴퓨터에서만 처리됩니다. 모델 설치 후 인터넷 없이 사용할 수 있습니다."
            : "번역하기를 누르면 원문과 인증 키가 선택한 번역 제공자에게 전송됩니다. 제공자 API 요금이 적용될 수 있습니다.";
    const local = translationStatus.local;
    modelStatusDot.el.classList.toggle("ready", local.installed);
    modelStatusDot.el.classList.toggle("pending", Boolean(local.installing));
    modelStatusText.el.textContent = local.installing
        ? "모델 설치 중"
        : local.installed
          ? "로컬 모델 사용 가능"
          : "로컬 모델 설치 필요";
    const sizeText = local.size ? `약 ${local.size}` : "필요한 모델 파일";
    modelDetails.el.textContent = local.installed
        ? "다운로드된 모델로 오프라인 번역을 사용할 수 있습니다."
        : `${sizeText}을 내려받습니다. 설치 후에는 오프라인으로 동작합니다.`;
    installButton.el.hidden = local.installed;
    installButton.el.disabled = Boolean(local.installing);
    providerStatus.el.textContent = [
        translationStatus.providers.deepl.configured
            ? "DeepL 연결됨"
            : "DeepL 미연결",
        translationStatus.providers.google.configured
            ? "Google 연결됨"
            : "Google 미연결",
    ].join(" · ");
}

async function installModels() {
    installButton.el.disabled = true;
    modelStatusText.el.textContent = "모델 설치 중";
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
    resultText.el.value = "번역 중…";
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
    closeModal(renameDialog.el);
    await runAction("rename-item", { id, name });
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
    closeModal(noteDialog.el);
    await runAction("set-note", { id, note: noteInput.el.value });
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

function unsharpMask(
    canvas: HTMLCanvasElement,
    radius: number,
    amount: number,
) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const blur = document.createElement("canvas");
    blur.width = canvas.width;
    blur.height = canvas.height;
    const bctx = blur.getContext("2d");
    if (!bctx) return;
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(canvas, 0, 0);
    const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const soft = bctx.getImageData(0, 0, canvas.width, canvas.height);
    const s = source.data;
    const b = soft.data;
    for (let i = 0; i < s.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = s[i + c] + (s[i + c] - b[i + c]) * amount;
            s[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
    ctx.putImageData(source, 0, 0);
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
        ? "결과 크기가 너무 큽니다. 배율을 낮춰 주세요."
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
        upscaleError.el.textContent =
            "결과 크기가 너무 큽니다. 배율을 낮춰 주세요.";
        return;
    }
    const dataURL = upscaleFull(target).toDataURL("image/png");
    closeModal(upscaleDialog.el);
    await runAction("save-composed", {
        id: target.id,
        dataURL,
        label: "Upscale",
    });
    showToast("업스케일 이미지를 컬렉션에 저장했습니다.");
}

function sampleEdgeColor(image: HTMLImageElement): [number, number, number] {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [38, 60, 74];
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            if (y > 2 && y < size - 3 && x > 2 && x < size - 3) continue;
            const i = (y * size + x) * 4;
            const a = data[i + 3] / 255;
            r += data[i] * a;
            g += data[i + 1] * a;
            b += data[i + 2] * a;
            n += a;
        }
    if (!n) return [38, 60, 74];
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function mixChannel(
    from: [number, number, number],
    to: [number, number, number],
    t: number,
): [number, number, number] {
    return [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
    ];
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
        if (!blob) throw new Error("이미지를 만들지 못했습니다.");
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
    await runAction("save-composed", { id: target.id, dataURL });
    showToast("꾸민 이미지를 컬렉션에 저장했습니다.");
}

async function requestOcrIndex(id: string) {
    pendingOcrIds.add(id);
    setTimeout(() => pendingOcrIds.delete(id), 120_000);
    await runAction("index-ocr", id);
}

function openQuickLook(item: OpenCaptureItem) {
    quickLookId = item.id;
    renderQuickLook();
    openModal(quickLookDialog.el);
    void loadQuickLookImage(item.id);
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
                    await runAction("set-tags", {
                        id: item.id,
                        tags: (item.tags ?? []).filter((t) => t !== tag),
                    });
                }),
        );
    }
    if (item.ocrDone) pendingOcrIds.delete(item.id);
    if (item.ocrText) {
        qlOcrStatus.el.textContent = `${item.ocrText.length.toLocaleString()}자 인식됨`;
        qlOcrText.el.textContent = item.ocrText;
        qlOcrText.el.hidden = false;
    } else if (pendingOcrIds.has(item.id)) {
        qlOcrStatus.el.textContent = "텍스트를 인식하는 중입니다…";
        qlOcrText.el.hidden = true;
    } else if (item.ocrDone) {
        qlOcrStatus.el.textContent = "인식된 텍스트가 없습니다.";
        qlOcrText.el.hidden = true;
    } else {
        qlOcrStatus.el.textContent =
            "아직 인식하지 않았습니다. 텍스트 인식을 실행하면 검색에도 포함됩니다.";
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
        ["복사", () => runAction("copy-item", item.id)],
        ["고정", () => runAction("pin-item", item.id)],
        ["열기", () => runAction("open-item", item.id)],
        ["메모", () => openNote(item)],
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

function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message
        : "요청을 처리하지 못했습니다.";
}

function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
    return new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function formatShortcut(value: string) {
    return value
        .replaceAll(
            "CommandOrControl",
            navigator.platform.startsWith("Mac") ? "Cmd" : "Ctrl",
        )
        .replaceAll("Escape", "Esc")
        .replaceAll("+", " + ");
}

function isState(value: unknown): value is OpenCaptureState {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<OpenCaptureState>;
    return (
        Array.isArray(candidate.collections) &&
        Array.isArray(candidate.items) &&
        typeof candidate.totalItemCount === "number" &&
        Boolean(candidate.workflow) &&
        Boolean(candidate.runtime)
    );
}

function isItemsPage(value: unknown): value is OpenCaptureItemsPage {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<OpenCaptureItemsPage>;
    return (
        Array.isArray(candidate.items) &&
        typeof candidate.totalItemCount === "number"
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
void refreshState().then(() => {
    if (!localStorage.getItem("oc:onboarded")) openOnboarding();
});
void refreshTranslationStatus();
