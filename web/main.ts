import "./lab.css";
import "./captureLab.css";
import "./mediaLab.css";
import "./referenceWindows.css";
import "../src/renderer/dashboard/captureBoard.css";
import "../src/renderer/dashboard/referenceComparison.css";

import type { CaptureBoardController } from "../lib/boardPorts";
import type { SavedComparisonSession } from "../lib/openCaptureTypes";
import { createCaptureBoard } from "../src/renderer/dashboard/captureBoard";
import {
    type ReferenceComparisonItem,
    createReferenceComparison,
} from "../src/renderer/dashboard/referenceComparison";
import { requestText } from "../src/renderer/lib/textDialog";
import {
    type BrowserBoardApi,
    type BrowserItem,
    createBrowserBoardApi,
} from "./boardApi";
import { type CaptureLab, createCaptureLab } from "./captureLab";
import { type LabFeature, features } from "./features";
import { getLabLang, initLabLang, lt, switchLabLang } from "./i18n";
import { dataURLBlob, downloadBlob, downloadDataURL } from "./imageOps";
import { createMediaLab } from "./mediaLab";
import { createReferenceWindows } from "./referenceWindows";
import { type LabCheckResult, runLabChecks } from "./selfChecks";

type Route =
    | "editor"
    | "capture"
    | "library"
    | "media"
    | "features"
    | "settings";
type ProcessorOperation = "ocr" | "cutout" | "upscale" | "redact" | "translate";
type ProcessorResult = {
    dataURL?: string;
    width?: number;
    height?: number;
    text?: string;
    lines?: unknown[];
};

const labSession = new URLSearchParams(location.search)
    .get("session")
    ?.replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 48);
const DATABASE_NAME = `opencapture-browser-lab-v1${labSession ? `-${labSession}` : ""}`;
const SETTINGS_KEY = "opencapture:lab:settings";
const CHECKS_KEY = "opencapture:lab:checks";
const BUGS_KEY = "opencapture:lab:bugs";
const SESSIONS_KEY = "opencapture:lab:comparison-sessions";

const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const button = (text: string, action?: string, secondary = false) => {
    const node = element(
        "button",
        secondary ? "button secondary" : "button",
        text,
    );
    node.type = "button";
    if (action) node.dataset.action = action;
    return node;
};

const readJSON = <T>(key: string, fallback: T): T => {
    try {
        const value = localStorage.getItem(key);
        return value ? (JSON.parse(value) as T) : fallback;
    } catch {
        return fallback;
    }
};

const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const fileDataURL = (file: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
            reject(reader.error ?? new Error("File read failed."));
        reader.readAsDataURL(file);
    });

const loadImage = (source: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Image could not be decoded."));
        image.src = source;
    });

const canvasDataURL = (canvas: HTMLCanvasElement) =>
    canvas.toDataURL("image/png");

async function transformImage(
    source: string,
    operation: "rotate" | "flip" | "resize",
    requestedWidth?: number,
) {
    const image = await loadImage(source);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    if (operation === "rotate") {
        canvas.width = image.naturalHeight;
        canvas.height = image.naturalWidth;
        context.translate(canvas.width, 0);
        context.rotate(Math.PI / 2);
        context.drawImage(image, 0, 0);
    } else if (operation === "flip") {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
        context.drawImage(image, 0, 0);
    } else {
        const width = Math.max(
            1,
            Math.min(8192, Math.round(requestedWidth ?? image.naturalWidth)),
        );
        const height = Math.max(
            1,
            Math.round((width * image.naturalHeight) / image.naturalWidth),
        );
        if (width * height > 16_000_000)
            throw new Error(
                lt("결과 이미지가 너무 큽니다. 너비를 줄여 주세요."),
            );
        canvas.width = width;
        canvas.height = height;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
    }
    return canvasDataURL(canvas);
}

async function composite(items: BrowserItem[]) {
    if (!items.length) throw new Error(lt("이미지를 하나 이상 선택해 주세요."));
    const gap = 16;
    const columns = Math.ceil(Math.sqrt(items.length));
    const cellWidth = Math.min(
        640,
        Math.max(...items.map((item) => item.width)),
    );
    const heights = items.map((item) =>
        Math.max(1, (cellWidth * item.height) / item.width),
    );
    const rows = Array.from(
        { length: Math.ceil(items.length / columns) },
        (_, row) =>
            Math.max(...heights.slice(row * columns, (row + 1) * columns)),
    );
    const width = columns * cellWidth + gap * (columns - 1);
    const height =
        rows.reduce((sum, row) => sum + row, 0) + gap * (rows.length - 1);
    if (!Number.isFinite(width * height))
        throw new Error(lt("이미지 크기를 확인해 주세요."));
    const scale = Math.min(
        1,
        Math.sqrt(16_000_000 / (width * height)),
        8192 / width,
        8192 / height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.scale(scale, scale);
    for (const [index, item] of items.entries()) {
        const image = await loadImage(item.dataURL);
        const row = Math.floor(index / columns);
        const y = rows
            .slice(0, row)
            .reduce((sum, value) => sum + value + gap, 0);
        context.drawImage(
            image,
            (index % columns) * (cellWidth + gap),
            y,
            cellWidth,
            heights[index],
        );
        image.src = "";
    }
    return canvasDataURL(canvas);
}

async function copyPNG(dataURL: string) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("PNG clipboard access is unavailable in this browser.");
    await navigator.clipboard.write([
        new ClipboardItem({ "image/png": dataURLBlob(dataURL) }),
    ]);
}

function makeSample(name: string, colors: [string, string], index: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    const gradient = context.createLinearGradient(
        0,
        0,
        canvas.width,
        canvas.height,
    );
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(10,10,12,.72)";
    context.beginPath();
    context.roundRect(70, 72, 820, 456, 32);
    context.fill();
    context.fillStyle = "#fff";
    context.font = "600 54px Segoe UI, sans-serif";
    context.fillText(name, 120, 180);
    context.font = "28px Segoe UI, sans-serif";
    context.fillStyle = "rgba(255,255,255,.76)";
    context.fillText(
        index === 1
            ? "Contact: hello@example.com"
            : "Created locally. Ready for your notes.",
        120,
        236,
    );
    context.fillStyle = colors[index % 2];
    context.beginPath();
    context.roundRect(120, 320, 280 + index * 70, 80, 16);
    context.fill();
    return canvasDataURL(canvas);
}

async function resetDatabaseIfRequested() {
    if (sessionStorage.getItem("opencapture:reset-database") !== "yes") return;
    sessionStorage.removeItem("opencapture:reset-database");
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DATABASE_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(request.error ?? new Error("Database reset failed."));
        request.onblocked = () =>
            reject(new Error("Close other lab tabs before resetting."));
    });
}

async function start() {
    initLabLang();
    await resetDatabaseIfRequested();
    const mount = document.querySelector<HTMLElement>("#app");
    if (!mount) throw new Error("Application mount was not found.");

    const settings = readJSON(SETTINGS_KEY, {
        reducedMotion: false,
        controlSize: 40,
    });
    document.documentElement.dataset.reducedMotion = String(
        settings.reducedMotion,
    );
    document.documentElement.style.setProperty(
        "--control-size",
        `${settings.controlSize}px`,
    );

    const shell = element("div", "lab-shell");
    const rail = element("aside", "lab-rail");
    rail.setAttribute("aria-label", lt("테스트 공간 탐색"));
    const brand = element("div", "lab-brand", "OC");
    brand.title = "OpenCapture browser lab";
    const nav = element("nav", "lab-nav");
    const routeLabels: Array<[Route, string, string]> = [
        [
            "editor",
            lt("보드"),
            '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/>',
        ],
        [
            "capture",
            lt("캡처"),
            '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="3"/>',
        ],
        [
            "library",
            lt("보관함"),
            '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="m3 15 5-4 5 5 3-3 5 4"/><circle cx="16" cy="9" r="1"/>',
        ],
        [
            "media",
            lt("미디어"),
            '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
        ],
        [
            "features",
            lt("기능"),
            '<path d="m4 6 2 2 3-4m3 2h8M4 13l2 2 3-4m3 2h8M4 20h5m3 0h8"/>',
        ],
        [
            "settings",
            lt("설정"),
            '<path d="M3 6h6m4 0h8M3 12h11m4 0h3M3 18h3m4 0h11"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
        ],
    ];
    const navButtons = new Map<Route, HTMLButtonElement>();
    for (const [route, label, glyph] of routeLabels) {
        const item = element("button", "lab-nav__item");
        item.type = "button";
        item.dataset.route = route;
        item.dataset.testid = `nav-${route}`;
        item.setAttribute("aria-label", label);
        item.title = label;
        const navIcon = element("span", "lab-nav__glyph");
        navIcon.setAttribute("aria-hidden", "true");
        navIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`;
        item.append(navIcon, element("span", "lab-nav__label", label));
        nav.append(item);
        navButtons.set(route, item);
    }
    rail.append(brand, nav);

    const frame = element("div", "lab-frame");
    const header = element("header", "lab-header");
    const headingWrap = element("div");
    const eyebrow = element("span", "lab-eyebrow", "Browser feature lab");
    const pageTitle = element("h1", "lab-title", lt("보드"));
    headingWrap.append(eyebrow, pageTitle);
    const headerActions = element("div", "lab-header__actions");
    const processorStatus = element(
        "span",
        "capability-status",
        lt("로컬 도구 확인 중…"),
    );
    processorStatus.dataset.testid = "processor-status";
    const langSwitch = element("div", "lang-switch");
    langSwitch.setAttribute("role", "group");
    langSwitch.setAttribute("aria-label", lt("표시 언어", "Display language"));
    for (const [lang, label] of [
        ["en", "EN"],
        ["ko", "한국어"],
    ] as const) {
        const langButton = element("button", "lang-switch__option", label);
        langButton.type = "button";
        langButton.dataset.lang = lang;
        langButton.dataset.testid = `lang-${lang}`;
        langButton.dataset.active = String(lang === getLabLang());
        langButton.onclick = () => switchLabLang(lang);
        langSwitch.append(langButton);
    }
    const commandButton = button(lt("명령"), "commands", true);
    headerActions.append(processorStatus, langSwitch, commandButton);
    header.append(headingWrap, headerActions);
    const content = element("main", "lab-content");
    const notice = element("div", "lab-notice");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.hidden = true;
    const routes = new Map<Route, HTMLElement>();
    for (const [route] of routeLabels) {
        const section = element("section", `lab-page lab-page--${route}`);
        section.dataset.page = route;
        section.hidden = true;
        content.append(section);
        routes.set(route, section);
    }
    frame.append(header, notice, content);
    shell.append(rail, frame);
    mount.replaceChildren(shell);

    let noticeTimer = 0;
    const message = (text: string, error = false) => {
        window.clearTimeout(noticeTimer);
        notice.textContent = text;
        notice.dataset.kind = error ? "error" : "normal";
        notice.hidden = false;
        noticeTimer = window.setTimeout(
            () => {
                notice.hidden = true;
            },
            error ? 7000 : 3200,
        );
    };

    let busyCount = 0;
    const run = async <T>(
        label: string,
        task: () => Promise<T>,
        done?: string,
    ): Promise<T | undefined> => {
        busyCount += 1;
        shell.setAttribute("aria-busy", "true");
        message(label);
        try {
            const result = await task();
            if (done) message(done);
            return result;
        } catch (error) {
            message(errorText(error), true);
            return undefined;
        } finally {
            busyCount -= 1;
            if (!busyCount) shell.removeAttribute("aria-busy");
        }
    };

    const api: BrowserBoardApi = createBrowserBoardApi({
        databaseName: DATABASE_NAME,
    });
    const process = async (
        operation: ProcessorOperation,
        input: { dataURL?: string; text?: string; from?: string; to?: string },
    ) => {
        const response = await fetch("/api/process", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operation, ...input }),
        });
        const payload = (await response.json().catch(() => null)) as
            | ProcessorResult
            | { error?: { message?: string; code?: string } }
            | null;
        if (!response.ok) {
            const detail =
                payload && "error" in payload
                    ? payload.error?.message
                    : undefined;
            throw new Error(
                detail ?? `Local processor failed (${response.status}).`,
            );
        }
        return payload as ProcessorResult;
    };

    let items: BrowserItem[] = [];
    const selectedIds = new Set<string>();
    const selectedItems = () =>
        items.filter((item) => selectedIds.has(item.id));

    const comparisonSessions = () =>
        readJSON<SavedComparisonSession[]>(SESSIONS_KEY, []);
    const comparison = createReferenceComparison({
        async loadItemData(id) {
            if (id.startsWith("board:")) {
                const [, boardId, assetId] = id
                    .split(":")
                    .map(decodeURIComponent);
                return api.assetData(boardId, assetId, "original");
            }
            const item = await api.readItem(id);
            if (!item) throw new Error("Comparison image was not found.");
            return item.dataURL;
        },
        listSessions: async () => comparisonSessions(),
        saveSession: async (session) => {
            const next = comparisonSessions().filter(
                (entry) => entry.id !== session.id,
            );
            next.unshift(session);
            localStorage.setItem(
                SESSIONS_KEY,
                JSON.stringify(next.slice(0, 30)),
            );
            return session;
        },
        removeSession: async (id) => {
            localStorage.setItem(
                SESSIONS_KEY,
                JSON.stringify(
                    comparisonSessions().filter((entry) => entry.id !== id),
                ),
            );
        },
        saveExport: async (dataURL, label) =>
            downloadDataURL(dataURL, `${label}.png`),
        copyExport: copyPNG,
        showToast: message,
    });
    document.body.append(comparison.dialog);

    const references = createReferenceWindows(document.body, {
        process: async (operation, dataURL) => process(operation, { dataURL }),
        message,
    });

    const board = createCaptureBoard({
        api,
        announce: message,
        capture: () => navigate("capture"),
        compareItems: (ids) =>
            void openComparison(ids).catch((error) =>
                message(errorText(error), true),
            ),
        changed: () => void refreshLibrary(),
    });
    routes.get("editor")?.append(board.root);

    const captureLab: CaptureLab = createCaptureLab(
        routes.get("capture") as HTMLElement,
        {
            onImage: async (dataURL, name) => {
                await api.importImage(dataURL, name);
                await refreshLibrary();
                message(
                    lt(
                        "이미지를 보관함에 저장했습니다. 보관함에서 확인할 수 있습니다.",
                        "Image saved — find it in the Library.",
                    ),
                );
            },
            onFloat: (dataURL, name) =>
                void references
                    .open(dataURL, name)
                    .catch((error) => message(errorText(error), true)),
            onProcess: async (operation, dataURL) => {
                if (operation === "color") return undefined;
                const result = await process(operation, { dataURL });
                if (result.dataURL) {
                    await api.importImage(
                        result.dataURL,
                        `${operation}-result.png`,
                    );
                    message(
                        lt(
                            "처리 결과를 보관함에 저장했습니다.",
                            "Saved the processed result to the Library.",
                        ),
                    );
                }
                if (result.text)
                    openTextResult(
                        operation === "ocr"
                            ? lt("인식한 텍스트", "Recognized text")
                            : lt("결과", "Result"),
                        result.text,
                    );
                await refreshLibrary();
                return result;
            },
            message,
        },
    );

    const mediaLab = createMediaLab(routes.get("media") as HTMLElement, {
        onImage: async (dataURL, name) => {
            await api.importImage(dataURL, name);
            await refreshLibrary();
        },
        message,
    });

    const libraryPage = routes.get("library") as HTMLElement;
    const libraryHeader = element("div", "page-heading");
    const libraryCopy = element("div");
    libraryCopy.append(
        element("h2", "page-heading__title", lt("이미지 보관함")),
        element(
            "p",
            "page-heading__copy",
            lt("가져오거나 처리한 이미지는 이 브라우저에 저장됩니다."),
        ),
    );
    const importButton = button(lt("이미지 가져오기"), "import");
    const fileInput = element("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.dataset.testid = "library-file-input";
    libraryHeader.append(libraryCopy, importButton, fileInput);
    const libraryTools = element("div", "library-tools");
    const searchLabel = element("label", "field");
    searchLabel.append(element("span", "field__label", lt("이름으로 찾기")));
    const search = element("input");
    search.type = "search";
    search.placeholder = lt("이미지 검색");
    search.dataset.testid = "library-search";
    searchLabel.append(search);
    const selectionCount = element("span", "selection-count", lt("0개 선택"));
    const libraryActions = element("div", "action-row");
    const actionSpecs = [
        ["add-board", lt("보드에 추가")],
        ["compare", lt("비교")],
        ["float", lt("참고창")],
        ["copy", lt("PNG 복사")],
        ["composite", lt("합친 PNG 복사")],
        ["download", lt("다운로드")],
        ["crop", lt("자르기")],
        ["rotate", lt("90° 회전")],
        ["flip", lt("좌우 반전")],
        ["resize", lt("크기 변경")],
        ["ocr", "OCR"],
        ["translate", lt("번역")],
        ["cutout", lt("배경 제거")],
        ["upscale", lt("업스케일")],
        ["redact", lt("민감 정보 가리기")],
    ] as const;
    const libraryMore = element("details", "library-more");
    libraryMore.append(element("summary", "button secondary", lt("편집 도구")));
    const libraryMoreActions = element("div", "library-more-actions");
    const primaryActions = new Set(["add-board", "compare", "float", "copy"]);
    for (const [action, label] of actionSpecs)
        (primaryActions.has(action)
            ? libraryActions
            : libraryMoreActions
        ).append(button(label, action, true));
    libraryMore.append(libraryMoreActions);
    libraryActions.append(libraryMore);
    libraryTools.append(searchLabel, selectionCount, libraryActions);
    const dropzone = element(
        "div",
        "library-dropzone",
        lt("이미지를 놓거나 붙여넣으세요"),
    );
    dropzone.tabIndex = 0;
    dropzone.dataset.testid = "library-dropzone";
    const libraryGrid = element("div", "library-grid");
    libraryGrid.dataset.testid = "library-grid";
    libraryPage.append(libraryHeader, libraryTools, dropzone, libraryGrid);

    const featurePage = routes.get("features") as HTMLElement;
    const featureHeading = element("div", "page-heading");
    const featureCopy = element("div");
    featureCopy.append(
        element("h2", "page-heading__title", lt("기능 목록")),
        element(
            "p",
            "page-heading__copy",
            lt("브라우저 기능을 실행하고 수동 확인 상태를 따로 기록합니다."),
        ),
    );
    const bugButton = button(lt("버그 기록"), "bugs", true);
    featureHeading.append(featureCopy, bugButton);
    const featureSearchLabel = element("label", "field feature-filter");
    featureSearchLabel.append(element("span", "field__label", lt("기능 검색")));
    const featureSearch = element("input");
    featureSearch.type = "search";
    featureSearch.placeholder = lt("이름, 설명 또는 실행 환경");
    featureSearchLabel.append(featureSearch);
    let kindFilter = "all";
    let uncheckedOnly = false;
    const featureFilters = element("div", "feature-filters");
    const kindOptions: Array<[string, string]> = [
        ["all", lt("전체", "All")],
        ["web", lt("웹", "Web")],
        ["local", lt("로컬 도구", "Local")],
        ["permission", lt("권한 필요", "Permission")],
        ["native", lt("앱 전용", "App only")],
    ];
    const filterChips: HTMLButtonElement[] = [];
    const syncFilterChips = () => {
        for (const chip of filterChips)
            chip.dataset.active = String(
                chip.dataset.kind
                    ? chip.dataset.kind === kindFilter
                    : uncheckedOnly,
            );
    };
    for (const [kind, label] of kindOptions) {
        const chip = element("button", "feature-filter-chip", label);
        chip.type = "button";
        chip.dataset.kind = kind;
        chip.onclick = () => {
            kindFilter = kind;
            syncFilterChips();
            renderFeatures();
        };
        filterChips.push(chip);
        featureFilters.append(chip);
    }
    const uncheckedChip = element(
        "button",
        "feature-filter-chip",
        lt("미확인만", "Unchecked only"),
    );
    uncheckedChip.type = "button";
    uncheckedChip.onclick = () => {
        uncheckedOnly = !uncheckedOnly;
        syncFilterChips();
        renderFeatures();
    };
    filterChips.push(uncheckedChip);
    featureFilters.append(uncheckedChip);
    syncFilterChips();
    const capabilityList = element("div", "capability-list");
    const featureGroups = element("div", "feature-groups");
    featurePage.append(
        featureHeading,
        featureSearchLabel,
        featureFilters,
        capabilityList,
        featureGroups,
    );

    const checksPanel = element("section", "self-check-panel");
    const checksHeader = element("div", "self-check-header");
    const checksDescription = element("div");
    checksDescription.append(
        element("h2", undefined, lt("자동 기본 점검")),
        element(
            "p",
            undefined,
            lt(
                "별도 테스트 데이터로 저장·복구·이미지 처리 결과를 확인합니다. 화면 조작과 권한은 직접 확인 항목으로 남깁니다.",
            ),
        ),
    );
    const runChecksButton = button(lt("자동점검 실행"), "run-checks", true);
    checksHeader.append(checksDescription, runChecksButton);
    const deepChecksLabel = element("label", "toggle-row");
    const deepChecks = element("input");
    deepChecks.type = "checkbox";
    deepChecks.dataset.testid = "deep-model-checks";
    deepChecksLabel.append(
        deepChecks,
        document.createTextNode(
            lt(
                "실제 OCR·누끼·번역·AI 확대도 점검 (첫 사용 시 약 5MB 모델 다운로드)",
            ),
        ),
    );
    const checksSummary = element(
        "p",
        "self-check-summary",
        lt("아직 실행하지 않았습니다."),
    );
    checksSummary.setAttribute("role", "status");
    const checksList = element("ol", "self-check-results");
    checksList.dataset.testid = "self-check-results";
    const exportChecks = button(lt("점검 결과 다운로드"), "export-checks");
    exportChecks.disabled = true;
    checksPanel.append(
        checksHeader,
        deepChecksLabel,
        checksSummary,
        checksList,
        exportChecks,
    );
    featurePage.insertBefore(checksPanel, featureSearchLabel);
    let checkResults: LabCheckResult[] = [];
    runChecksButton.onclick = () => {
        runChecksButton.disabled = true;
        deepChecks.disabled = true;
        checkResults = [];
        checksList.replaceChildren();
        checksSummary.textContent = lt("점검 중…");
        void runLabChecks({
            models: deepChecks.checked,
            onResult(result) {
                checkResults.push(result);
                const row = element("li");
                row.dataset.result = result.status;
                row.dataset.checkId = result.id;
                row.append(
                    element(
                        "strong",
                        undefined,
                        lt(
                            `${result.status === "pass" ? "통과" : result.status === "fail" ? "실패" : "직접 확인"} · ${result.name}`,
                            `${result.status === "pass" ? "Pass" : result.status === "fail" ? "Fail" : "Manual"} · ${result.name}`,
                        ),
                    ),
                    element("span", undefined, result.detail),
                );
                checksList.append(row);
                checksSummary.textContent = lt(
                    `${checkResults.filter((item) => item.status === "pass").length}개 통과 · ${checkResults.filter((item) => item.status === "fail").length}개 실패 · ${checkResults.filter((item) => item.status === "manual").length}개 직접 확인`,
                    `${checkResults.filter((item) => item.status === "pass").length} passed · ${checkResults.filter((item) => item.status === "fail").length} failed · ${checkResults.filter((item) => item.status === "manual").length} manual`,
                );
            },
        })
            .then(() => {
                localStorage.setItem(
                    "opencapture:lab:last-checks",
                    JSON.stringify({
                        at: new Date().toISOString(),
                        results: checkResults,
                    }),
                );
            })
            .catch((error) => message(errorText(error), true))
            .finally(() => {
                runChecksButton.disabled = false;
                deepChecks.disabled = false;
                exportChecks.disabled = checkResults.length === 0;
            });
    };
    exportChecks.onclick = () =>
        downloadBlob(
            new Blob(
                [
                    JSON.stringify(
                        { at: new Date().toISOString(), results: checkResults },
                        null,
                        2,
                    ),
                ],
                { type: "application/json" },
            ),
            "opencapture-checks.json",
        );

    const settingsPage = routes.get("settings") as HTMLElement;
    const settingsPanel = element("div", "settings-panel");
    settingsPanel.append(
        element("h2", "page-heading__title", lt("실험실 설정")),
    );
    const motionLabel = element("label", "toggle-row");
    const motionInput = element("input");
    motionInput.type = "checkbox";
    motionInput.checked = settings.reducedMotion;
    motionLabel.append(
        motionInput,
        element("span", "toggle-row__copy", lt("움직임 줄이기")),
    );
    const sizeLabel = element("label", "field");
    sizeLabel.append(element("span", "field__label", lt("컨트롤 크기")));
    const sizeInput = element("input");
    sizeInput.type = "range";
    sizeInput.min = "40";
    sizeInput.max = "52";
    sizeInput.step = "2";
    sizeInput.value = String(settings.controlSize);
    const sizeOutput = element(
        "output",
        "field__value",
        `${settings.controlSize}px`,
    );
    sizeLabel.append(sizeInput, sizeOutput);
    const displayLanguageRow = element("div", "field");
    displayLanguageRow.append(
        element("span", "field__label", lt("표시 언어", "Display language")),
    );
    const languageButtons = element("div", "lang-switch");
    languageButtons.setAttribute("role", "group");
    languageButtons.setAttribute(
        "aria-label",
        lt("표시 언어", "Display language"),
    );
    for (const [lang, label] of [
        ["en", "EN"],
        ["ko", "한국어"],
    ] as const) {
        const option = element("button", "lang-switch__option", label);
        option.type = "button";
        option.dataset.lang = lang;
        option.dataset.active = String(lang === getLabLang());
        option.onclick = () => switchLabLang(lang);
        languageButtons.append(option);
    }
    displayLanguageRow.append(languageButtons);
    const resetButton = button(lt("데모 데이터 초기화"), "reset-data", true);
    settingsPanel.append(
        motionLabel,
        sizeLabel,
        displayLanguageRow,
        resetButton,
    );
    settingsPage.append(settingsPanel);

    const textDialog = element("dialog", "lab-dialog");
    const textDialogTitle = element("h2", "lab-dialog__title", lt("결과"));
    const textArea = element("textarea");
    textArea.rows = 12;
    textArea.readOnly = true;
    textArea.setAttribute("aria-label", lt("결과 텍스트"));
    const textDialogClose = button(lt("닫기"), undefined, true);
    textDialogClose.onclick = () => textDialog.close();
    textDialog.append(textDialogTitle, textArea, textDialogClose);
    document.body.append(textDialog);
    function openTextResult(title: string, text: string) {
        textDialogTitle.textContent = title;
        textArea.value = text;
        textDialog.showModal();
    }

    const translateDialog = element("dialog", "lab-dialog");
    const translateTitle = element("h2", "lab-dialog__title", lt("로컬 번역"));
    const translateSourceLabel = element("label", "field");
    translateSourceLabel.append(element("span", "field__label", lt("원문")));
    const translateSource = element("textarea");
    translateSource.rows = 7;
    translateSourceLabel.append(translateSource);
    const languageRow = element("div", "form-row");
    const fromLabel = element("label", "field");
    fromLabel.append(element("span", "field__label", lt("원본 언어")));
    const fromSelect = element("select");
    fromSelect.append(
        new Option("Auto", "auto"),
        new Option("English", "en"),
        new Option("Korean", "ko"),
    );
    fromLabel.append(fromSelect);
    const toLabel = element("label", "field");
    toLabel.append(element("span", "field__label", lt("번역 언어")));
    const toSelect = element("select");
    toSelect.append(new Option("Korean", "ko"), new Option("English", "en"));
    toLabel.append(toSelect);
    languageRow.append(fromLabel, toLabel);
    const translateResult = element("textarea");
    translateResult.rows = 7;
    translateResult.readOnly = true;
    translateResult.dataset.testid = "translate-result";
    translateResult.setAttribute("aria-label", lt("번역 결과"));
    const translateActions = element("div", "dialog-actions");
    const translateRun = button(lt("번역"));
    const translateClose = button(lt("닫기"), undefined, true);
    translateClose.onclick = () => translateDialog.close();
    translateActions.append(translateClose, translateRun);
    translateDialog.append(
        translateTitle,
        translateSourceLabel,
        languageRow,
        translateResult,
        translateActions,
    );
    document.body.append(translateDialog);
    translateRun.onclick = () =>
        void run(
            lt("로컬로 번역하는 중…", "Translating locally…"),
            async () => {
                const result = await process("translate", {
                    text: translateSource.value,
                    from: fromSelect.value,
                    to: toSelect.value,
                });
                translateResult.value = result.text ?? "";
            },
        );

    const bugsDialog = element("dialog", "lab-dialog lab-dialog--wide");
    const bugsTitle = element("h2", "lab-dialog__title", lt("버그 기록"));
    const bugForm = element("form", "bug-form");
    const bugTitleLabel = element("label", "field");
    bugTitleLabel.append(element("span", "field__label", lt("제목")));
    const bugTitleInput = element("input");
    bugTitleInput.required = true;
    bugTitleLabel.append(bugTitleInput);
    const bugDetailLabel = element("label", "field");
    bugDetailLabel.append(
        element("span", "field__label", lt("재현 단계와 실제 결과")),
    );
    const bugDetailInput = element("textarea");
    bugDetailInput.rows = 5;
    bugDetailInput.required = true;
    bugDetailLabel.append(bugDetailInput);
    const bugSubmit = button(lt("기록 저장"));
    bugSubmit.type = "submit";
    bugForm.append(bugTitleLabel, bugDetailLabel, bugSubmit);
    const bugList = element("div", "bug-list");
    const bugDialogActions = element("div", "dialog-actions");
    const exportBugs = button(lt("JSON 내보내기"), undefined, true);
    const closeBugs = button(lt("닫기"), undefined, true);
    closeBugs.onclick = () => bugsDialog.close();
    bugDialogActions.append(exportBugs, closeBugs);
    bugsDialog.append(bugsTitle, bugForm, bugList, bugDialogActions);
    document.body.append(bugsDialog);

    const commandsDialog = element("dialog", "lab-dialog command-dialog");
    commandsDialog.append(element("h2", "lab-dialog__title", lt("명령")));
    const commandSearch = element("input");
    commandSearch.type = "search";
    commandSearch.placeholder = lt("페이지 이동 또는 기능 실행");
    commandSearch.setAttribute("aria-label", lt("명령 검색"));
    const commandList = element("div", "command-list");
    const commandClose = button(lt("닫기"), undefined, true);
    commandClose.onclick = () => commandsDialog.close();
    commandsDialog.append(commandSearch, commandList, commandClose);
    document.body.append(commandsDialog);

    function navigate(route: Route) {
        for (const [key, page] of routes) page.hidden = key !== route;
        for (const [key, item] of navButtons)
            item.dataset.active = String(key === route);
        pageTitle.textContent =
            routeLabels.find(([key]) => key === route)?.[1] ?? "Lab";
        location.hash = route;
        if (route === "library")
            void refreshLibrary().catch((error) =>
                message(errorText(error), true),
            );
        if (route === "features") renderFeatures();
    }

    function itemReferences(
        sourceItems: BrowserItem[],
    ): ReferenceComparisonItem[] {
        return sourceItems.map((item) => ({
            id: item.id,
            name: item.name,
            thumbnail: item.dataURL,
            width: item.width,
            height: item.height,
        }));
    }

    async function openComparison(ids?: string[]) {
        const referencesToOpen: ReferenceComparisonItem[] = [];
        for (const id of ids ?? selectedItems().map((item) => item.id)) {
            if (id.startsWith("board:")) {
                referencesToOpen.push({
                    id,
                    name: lt("보드 자산", "Board asset"),
                });
                continue;
            }
            const item =
                items.find((candidate) => candidate.id === id) ??
                (await api.readItem(id));
            if (item) referencesToOpen.push(...itemReferences([item]));
        }
        comparison.open(referencesToOpen);
    }

    function renderLibrary() {
        const query = search.value.trim().toLocaleLowerCase();
        const visible = items.filter((item) =>
            item.name.toLocaleLowerCase().includes(query),
        );
        libraryGrid.replaceChildren();
        selectionCount.textContent = lt(
            `${selectedIds.size}개 선택`,
            `${selectedIds.size} selected`,
        );
        for (const control of libraryActions.querySelectorAll<HTMLButtonElement>(
            "button[data-action]",
        )) {
            const action = control.dataset.action;
            control.disabled =
                action !== "translate" &&
                (selectedIds.size === 0 ||
                    (action === "compare" && selectedIds.size < 2));
            control.title = control.disabled
                ? lt("먼저 이미지를 선택해 주세요.")
                : "";
        }
        for (const item of visible) {
            const card = element("article", "library-card");
            card.dataset.selected = String(selectedIds.has(item.id));
            card.dataset.itemId = item.id;
            const image = element("img");
            image.src = item.dataURL;
            image.alt = item.name;
            image.loading = "lazy";
            const checkboxLabel = element("label", "library-card__check");
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = selectedIds.has(item.id);
            checkbox.setAttribute(
                "aria-label",
                lt(`${item.name} 선택`, `Select ${item.name}`),
            );
            checkbox.onchange = () => {
                if (checkbox.checked) selectedIds.add(item.id);
                else selectedIds.delete(item.id);
                renderLibrary();
            };
            checkboxLabel.append(checkbox);
            const meta = element("div", "library-card__meta");
            meta.append(
                element("strong", "library-card__name", item.name),
                element(
                    "span",
                    "library-card__size",
                    `${item.width} × ${item.height}`,
                ),
            );
            card.append(image, checkboxLabel, meta);
            libraryGrid.append(card);
        }
        if (!visible.length)
            libraryGrid.append(
                element(
                    "p",
                    "empty-state",
                    query
                        ? lt(
                              "조건에 맞는 이미지가 없습니다.",
                              "No images match this filter.",
                          )
                        : lt(
                              "아직 이미지가 없습니다. 가져오거나 놓거나 붙여넣으세요.",
                              "No images yet. Import, drop, or paste an image.",
                          ),
                ),
            );
    }

    async function refreshLibrary() {
        items = await api.listItems();
        for (const id of [...selectedIds])
            if (!items.some((item) => item.id === id)) selectedIds.delete(id);
        renderLibrary();
    }

    async function importFiles(files: Iterable<File>) {
        for (const file of files) {
            if (!file.type.startsWith("image/")) continue;
            await api.importImage(
                await fileDataURL(file),
                file.name || lt("붙여넣은-이미지.png", "pasted-image.png"),
            );
        }
        await refreshLibrary();
        message(lt("이미지를 가져왔습니다."));
    }

    async function derive(
        operation: "rotate" | "flip" | "resize",
        width?: number,
    ) {
        const source = selectedItems()[0];
        if (!source) throw new Error(lt("이미지를 먼저 선택해 주세요."));
        const dataURL = await transformImage(source.dataURL, operation, width);
        const item = await api.deriveItem(source.id, dataURL, operation);
        selectedIds.clear();
        selectedIds.add(item.id);
        await refreshLibrary();
        message(
            lt(
                "새 이미지를 보관함에 저장했습니다.",
                "Saved a new image to the Library.",
            ),
        );
    }

    async function processSelection(
        operation: Exclude<ProcessorOperation, "translate">,
    ) {
        const boardImages = board
            .getSelection()
            .filter((node) => node.kind === "image");
        if (
            operation === "cutout" &&
            boardImages.length &&
            !routes.get("editor")?.hidden
        ) {
            await board.command("cutout");
            return;
        }
        const source = selectedItems()[0];
        if (!source) throw new Error(lt("이미지를 먼저 선택해 주세요."));
        const result = await process(operation, { dataURL: source.dataURL });
        if (result.text) openTextResult(lt("인식한 텍스트"), result.text);
        if (result.dataURL) {
            const created = await api.deriveItem(
                source.id,
                result.dataURL,
                operation,
            );
            selectedIds.clear();
            selectedIds.add(created.id);
            await refreshLibrary();
            message(
                lt(
                    "처리 결과를 보관함에 저장했습니다.",
                    "Saved the processed result to the Library.",
                ),
            );
        }
        if (!result.text && !result.dataURL)
            throw new Error("The processor returned no usable result.");
    }

    async function runLibraryAction(action: string) {
        if (action === "translate") {
            translateSource.value = "";
            translateResult.value = "";
            translateDialog.showModal();
            return;
        }
        const selected = selectedItems();
        if (!selected.length)
            throw new Error(lt("이미지를 하나 이상 선택해 주세요."));
        if (action === "add-board") {
            await board.addItems(selected.map((item) => item.id));
            navigate("editor");
            message(
                lt(
                    "보드에 추가했습니다. Ctrl+Z로 되돌릴 수 있습니다.",
                    "Added to the board. Press Ctrl+Z to undo.",
                ),
            );
        } else if (action === "compare") await openComparison();
        else if (action === "float")
            for (const item of selected)
                await references.open(item.dataURL, item.name);
        else if (action === "copy") {
            await copyPNG(selected[0].dataURL);
            message(lt("PNG 이미지를 복사했습니다."));
        } else if (action === "composite") {
            await copyPNG(await composite(selected));
            message(lt("PNG 이미지를 복사했습니다."));
        } else if (action === "download") {
            for (const item of selected)
                downloadDataURL(
                    item.dataURL,
                    item.name.endsWith(".png") ? item.name : `${item.name}.png`,
                );
            message(lt("다운로드했습니다.", "Downloaded."));
        } else if (action === "crop") {
            captureLab.setSource(selected[0].dataURL, selected[0].name, "crop");
            navigate("capture");
        } else if (action === "rotate" || action === "flip")
            await derive(action);
        else if (action === "resize") {
            const value = await requestText({
                title: lt("새 이미지 너비 (px)"),
                value: String(selected[0].width),
                maxLength: 5,
            });
            if (value === null) return;
            const width = Number(value);
            if (!Number.isFinite(width) || width < 1)
                throw new Error(lt("올바른 너비를 입력해 주세요."));
            await derive("resize", width);
        } else if (["ocr", "cutout", "upscale", "redact"].includes(action)) {
            await processSelection(
                action as Exclude<ProcessorOperation, "translate">,
            );
        }
    }

    const featureChecks = readJSON<Record<string, boolean>>(CHECKS_KEY, {});
    let capabilityState: Record<
        string,
        { available?: boolean; message?: string }
    > = {};
    function renderCapabilities() {
        capabilityList.replaceChildren();
        for (const [name, value] of Object.entries(capabilityState)) {
            const chip = element(
                "span",
                "capability-chip",
                lt(
                    `${name}: ${value.available ? "준비됨" : "사용 불가"}`,
                    `${name}: ${value.available ? "Ready" : "Unavailable"}`,
                ),
            );
            chip.dataset.available = String(Boolean(value.available));
            if (value.message) chip.title = value.message;
            capabilityList.append(chip);
        }
    }

    function renderFeatures() {
        const query = featureSearch.value.trim().toLocaleLowerCase();
        const matching = features.filter(
            (feature) =>
                (kindFilter === "all" || feature.kind === kindFilter) &&
                (!uncheckedOnly || !featureChecks[feature.id]) &&
                `${feature.name} ${lt(feature.name)} ${feature.detail} ${lt(feature.detail)} ${feature.kind}`
                    .toLocaleLowerCase()
                    .includes(query),
        );
        featureGroups.replaceChildren();
        const grouped = new Map<string, LabFeature[]>();
        for (const feature of matching)
            grouped.set(feature.group, [
                ...(grouped.get(feature.group) ?? []),
                feature,
            ]);
        for (const [group, groupFeatures] of grouped) {
            const section = element("details", "feature-group");
            section.open = true;
            const summary = element("summary", "feature-group__title");
            summary.append(
                document.createTextNode(lt(group)),
                element(
                    "span",
                    "feature-group__count",
                    String(groupFeatures.length),
                ),
            );
            section.append(summary);
            const list = element("div", "feature-list");
            for (const feature of groupFeatures) {
                const row = element("article", "feature-row");
                const copy = element("div", "feature-row__copy");
                const title = element("div", "feature-row__title");
                title.append(
                    element("strong", undefined, lt(feature.name)),
                    element(
                        "span",
                        `kind kind--${feature.kind}`,
                        feature.kind === "native" ? "App only" : feature.kind,
                    ),
                );
                copy.append(title, element("p", undefined, lt(feature.detail)));
                const actions = element("div", "feature-row__actions");
                const checkLabel = element("label", "check-control");
                const check = element("input");
                check.type = "checkbox";
                check.checked = Boolean(featureChecks[feature.id]);
                check.onchange = () => {
                    featureChecks[feature.id] = check.checked;
                    localStorage.setItem(
                        CHECKS_KEY,
                        JSON.stringify(featureChecks),
                    );
                };
                checkLabel.append(check, document.createTextNode(lt("확인함")));
                actions.append(checkLabel);
                if (feature.kind === "native")
                    actions.append(
                        element(
                            "span",
                            "app-only-copy",
                            lt(
                                "운영체제 연동이 필요한 데스크톱 앱 전용 기능입니다.",
                            ),
                        ),
                    );
                else if (feature.action) {
                    const runButton = button(
                        lt("열기 / 실행"),
                        undefined,
                        true,
                    );
                    runButton.onclick = () => void runFeature(feature);
                    actions.append(runButton);
                }
                row.append(copy, actions);
                list.append(row);
            }
            section.append(list);
            featureGroups.append(section);
        }
    }

    async function runFeature(feature: LabFeature) {
        const action = feature.action;
        if (!action) return;
        if (
            ["editor", "capture", "library", "media", "settings"].includes(
                action,
            )
        ) {
            navigate(action as Route);
            return;
        }
        if (
            action.startsWith("tool:") ||
            [
                "layout-grid",
                "undo",
                "export-png",
                "export-portable",
                "beautify",
            ].includes(action)
        ) {
            navigate("editor");
            const featureName = lt(feature.name);
            await run(
                lt(`${featureName} 실행 중…`, `Running ${featureName}…`),
                async () => board.command(action),
            );
            return;
        }
        const libraryAction =
            action === "float"
                ? "float"
                : action === "composite"
                  ? "composite"
                  : action;
        navigate("library");
        const featureName = lt(feature.name);
        await run(
            lt(`${featureName} 실행 중…`, `Running ${featureName}…`),
            () => runLibraryAction(libraryAction),
        );
    }

    function renderBugReports() {
        const reports = readJSON<
            Array<{
                id: string;
                title: string;
                detail: string;
                createdAt: string;
            }>
        >(BUGS_KEY, []);
        bugList.replaceChildren();
        for (const report of reports) {
            const row = element("article", "bug-row");
            row.append(
                element("strong", undefined, report.title),
                element("p", undefined, report.detail),
                element(
                    "time",
                    undefined,
                    new Date(report.createdAt).toLocaleString(),
                ),
            );
            bugList.append(row);
        }
        if (!reports.length)
            bugList.append(
                element(
                    "p",
                    "empty-state",
                    lt("저장된 기록이 없습니다.", "No reports saved."),
                ),
            );
    }

    bugForm.onsubmit = (event) => {
        event.preventDefault();
        const reports = readJSON<
            Array<{
                id: string;
                title: string;
                detail: string;
                createdAt: string;
            }>
        >(BUGS_KEY, []);
        reports.unshift({
            id: crypto.randomUUID(),
            title: bugTitleInput.value.trim(),
            detail: bugDetailInput.value.trim(),
            createdAt: new Date().toISOString(),
        });
        localStorage.setItem(BUGS_KEY, JSON.stringify(reports));
        bugForm.reset();
        renderBugReports();
    };
    exportBugs.onclick = () => {
        const payload = JSON.stringify(
            {
                exportedAt: new Date().toISOString(),
                checks: featureChecks,
                reports: readJSON(BUGS_KEY, []),
            },
            null,
            2,
        );
        const url = URL.createObjectURL(
            new Blob([payload], { type: "application/json" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "opencapture-lab-report.json";
        anchor.click();
        URL.revokeObjectURL(url);
    };

    function renderCommands() {
        const query = commandSearch.value.trim().toLocaleLowerCase();
        commandList.replaceChildren();
        for (const [route, label] of routeLabels.filter(([, label]) =>
            label.toLocaleLowerCase().includes(query),
        )) {
            const item = button(
                lt(`${label}(으)로 이동`, `Go to ${label}`),
                undefined,
                true,
            );
            item.onclick = () => {
                commandsDialog.close();
                navigate(route);
            };
            commandList.append(item);
        }
        for (const feature of features
            .filter(
                (item) =>
                    item.action &&
                    `${item.name} ${lt(item.name)}`
                        .toLocaleLowerCase()
                        .includes(query),
            )
            .slice(0, 12)) {
            const item = button(lt(feature.name), undefined, true);
            item.onclick = () => {
                commandsDialog.close();
                void runFeature(feature);
            };
            commandList.append(item);
        }
    }

    commandButton.onclick = () => {
        commandSearch.value = "";
        renderCommands();
        commandsDialog.showModal();
        commandSearch.focus();
    };
    commandSearch.oninput = renderCommands;
    nav.onclick = (event) => {
        const target =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-route]")
                : null;
        if (target?.dataset.route) navigate(target.dataset.route as Route);
    };
    importButton.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        const files = fileInput.files;
        fileInput.value = "";
        if (files)
            void run(lt("이미지를 가져오는 중…", "Importing images…"), () =>
                importFiles(files),
            );
    };
    search.oninput = renderLibrary;
    libraryActions.onclick = (event) => {
        const target =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-action]")
                : null;
        if (target?.dataset.action)
            void run(
                lt(
                    `${target.textContent ?? "작업"} 실행 중…`,
                    `Running ${target.textContent ?? "action"}…`,
                ),
                () => runLibraryAction(target.dataset.action as string),
            );
    };
    for (const type of ["dragenter", "dragover"])
        dropzone.addEventListener(type, (event) => {
            event.preventDefault();
            dropzone.dataset.active = "true";
        });
    dropzone.addEventListener(
        "dragleave",
        () => delete dropzone.dataset.active,
    );
    dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        delete dropzone.dataset.active;
        if (event.dataTransfer?.files)
            void run(
                lt("놓은 이미지를 가져오는 중…", "Importing dropped images…"),
                () => importFiles(event.dataTransfer?.files ?? []),
            );
    });
    window.addEventListener("paste", (event) => {
        const files = [...(event.clipboardData?.items ?? [])].flatMap((item) =>
            item.kind === "file" && item.type.startsWith("image/")
                ? [item.getAsFile()].filter((file): file is File =>
                      Boolean(file),
                  )
                : [],
        );
        if (files.length)
            void run(
                lt("붙여넣은 이미지 가져오는 중…", "Importing pasted image…"),
                () => importFiles(files),
            );
    });
    featureSearch.oninput = renderFeatures;
    bugButton.onclick = () => {
        renderBugReports();
        bugsDialog.showModal();
    };
    motionInput.onchange = () => {
        settings.reducedMotion = motionInput.checked;
        document.documentElement.dataset.reducedMotion = String(
            settings.reducedMotion,
        );
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    };
    sizeInput.oninput = () => {
        settings.controlSize = Number(sizeInput.value);
        sizeOutput.textContent = `${settings.controlSize}px`;
        document.documentElement.style.setProperty(
            "--control-size",
            `${settings.controlSize}px`,
        );
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    };
    resetButton.onclick = () => {
        if (
            !window.confirm(
                lt(
                    "브라우저 실험실의 보드와 이미지를 모두 삭제할까요? 되돌릴 수 없습니다.",
                    "Delete all browser lab boards and images? This cannot be undone.",
                ),
            )
        )
            return;
        sessionStorage.setItem("opencapture:reset-database", "yes");
        localStorage.removeItem(CHECKS_KEY);
        localStorage.removeItem(BUGS_KEY);
        localStorage.removeItem(SESSIONS_KEY);
        location.reload();
    };
    window.addEventListener("keydown", (event) => {
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLocaleLowerCase() === "k"
        ) {
            event.preventDefault();
            commandButton.click();
        }
        if (
            event.key === "?" &&
            !(
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement
            )
        ) {
            commandButton.click();
        }
    });

    const loadSamples = async () => {
        const existing = await api.listItems();
        if (existing.length) return existing;
        const restoreAutoAdd = board.getDocument()?.settings.autoAdd;
        if (restoreAutoAdd) {
            await board.command("auto-add");
            await board.flush();
        }
        const samples: Array<[string, [string, string]]> = [
            ["Aurora card", ["#3757d5", "#8d4fc2"]],
            ["Warm dashboard", ["#d45b36", "#d2a83e"]],
            ["Mint reference", ["#178a79", "#295cb5"]],
        ];
        const created: BrowserItem[] = [];
        for (const [index, [name, colors]] of samples.entries())
            created.push(
                await api.importImage(
                    makeSample(name, colors, index),
                    `${name}.png`,
                ),
            );
        await board.addItems(created.map((item) => item.id));
        await board.command("layout-grid");
        await board.command("fit");
        if (restoreAutoAdd) await board.command("auto-add");
        await board.flush();
        return api.listItems();
    };

    await board.ready();
    const initial = location.hash.slice(1) as Route;
    navigate(routes.has(initial) ? initial : "editor");
    await loadSamples();
    await refreshLibrary();

    window.__captureLab = { board, api, navigate, features, loadSamples };

    const status = await api.status();
    if (status.readOnly)
        message(
            status.error ?? lt("브라우저 저장소를 읽기 전용으로 열었습니다."),
            true,
        );
    try {
        const response = await fetch("/api/status");
        const payload = (await response.json()) as {
            capabilities?: Record<
                string,
                { available?: boolean; message?: string }
            >;
        };
        if (!response.ok)
            throw new Error("Local processing service is unavailable.");
        capabilityState = payload.capabilities ?? {};
        const ready = Object.values(capabilityState).filter(
            (value) => value.available,
        ).length;
        processorStatus.textContent = lt(
            `로컬 도구 ${ready}/${Object.keys(capabilityState).length}개 준비됨`,
            `Local tools ${ready}/${Object.keys(capabilityState).length} ready`,
        );
        processorStatus.dataset.ready = String(ready > 0);
        renderCapabilities();
    } catch (error) {
        processorStatus.textContent = lt("로컬 도구를 사용할 수 없음");
        processorStatus.title = errorText(error);
        processorStatus.dataset.ready = "false";
    }

    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        mediaLab.destroy();
        references.destroy();
        comparison.destroy();
        captureLab.destroy();
        board.destroy();
        void api.dispose();
    };
    window.addEventListener("beforeunload", (event) => {
        void board.flush().catch(() => undefined);
        if (board.hasPendingChanges()) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    window.addEventListener(
        "pagehide",
        (event) => {
            if (event.persisted) return;
            void board
                .flush()
                .catch(() => undefined)
                .finally(() => cleanup());
        },
        { once: true },
    );
}

declare global {
    interface Window {
        __captureLab?: {
            board: CaptureBoardController;
            api: BrowserBoardApi;
            navigate: (route: Route) => void;
            features: LabFeature[];
            loadSamples: () => Promise<BrowserItem[]>;
        };
    }
}

function renderFatal(error: unknown) {
    const mount = document.querySelector<HTMLElement>("#app") ?? document.body;
    const panel = element("main", "fatal-state");
    panel.append(
        element(
            "h1",
            undefined,
            lt(
                "브라우저 실험실을 시작할 수 없습니다",
                "Browser lab could not start",
            ),
        ),
        element("p", undefined, errorText(error)),
    );
    const retry = button(lt("다시 시도", "Retry"));
    retry.onclick = () => location.reload();
    panel.append(retry);
    mount.replaceChildren(panel);
}

void start().catch(renderFatal);
