/// <reference types="vite/client" />

import { Buffer } from "node:buffer";
import {
    type BaseWindow,
    BrowserWindow,
    ClipboardItem,
    Menu,
    type NativeImage,
    Notification,
    Tray,
    type View,
    WebContentsView,
    app,
    clipboard,
    crashReporter,
    desktopCapturer,
    dialog,
    globalShortcut,
    ipcMain,
    nativeImage,
    nativeTheme,
    screen,
    session,
    shell,
} from "electron";
import {
    type ShortcutRequest,
    type ShortcutStatus,
    registerShortcuts,
} from "../../lib/shortcutRegistry";
import { StartupCommandQueue } from "../../lib/startupCommands";
import { createTranslationService } from "./localTranslation";
import { installOpenCapture } from "./openCapture";

import minimist from "minimist";

import initScreenShots from "../renderer/screenShot/screenShot";

import { exec, execSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdir,
    mkdirSync,
    readFile,
    readFileSync,
    rmSync,
    statSync,
    writeFile,
    writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import url from "node:url";
import main, { matchFitLan } from "xtranslator";
import { githubMirrorList } from "../../lib/github_mirror";
import { mainOn, mainOnReflect, mainSend } from "../../lib/ipc";
import type { RecordRect } from "../../lib/ipc";
import Store from "../../lib/store/store";
import time_format from "../../lib/time_format";
import { getLans, lan, t } from "../../lib/translate/translate";
import { typedEntries } from "../../lib/utils";
import type {
    EditToolsType,
    GithubUrlType,
    MainWinType,
    setting,
    translateWinType,
    功能,
} from "../ShareTypes";

const runPath = join(resolve(__dirname, ""), "../../");
const tmpDir = join(tmpdir(), "OpenCapture");
app.setName("OpenCapture");
app.setPath("userData", join(app.getPath("appData"), "OpenCapture"));
mkdirSync(app.getPath("userData"), { recursive: true });
let openCapture: ReturnType<typeof installOpenCapture> | undefined;
const brokerMode = process.argv.includes("--broker");
let shortcutStatus: ShortcutStatus[] = [];
const loginTarget = () => {
    const helper = join(dirname(process.execPath), "OpenCaptureQuick.exe");
    return existsSync(helper)
        ? { path: helper, args: [] as string[] }
        : { path: process.execPath, args: ["--background"] };
};
let idleExit: ReturnType<typeof setTimeout> | undefined;
const commands = new StartupCommandQueue(
    (command) => argRun(command.argv, command.first),
    scheduleIdleExit,
    (error) => console.error("Command failed:", error),
);
function scheduleIdleExit() {
    if (idleExit) clearTimeout(idleExit);
    if (!brokerMode || commands.pending) return;
    idleExit = setTimeout(async () => {
        await openCapture?.whenIdle();
        if (
            commands.pending === 0 &&
            BrowserWindow.getAllWindows().length === 0
        )
            app.quit();
    }, 5000);
}
app.on("browser-window-created", () => {
    if (idleExit) clearTimeout(idleExit);
});
app.on("window-all-closed", () => {
    scheduleIdleExit();
});

// 自定义用户路径
try {
    let preloadConfig = "";
    try {
        preloadConfig = readFileSync(join(runPath, "preload_config"))
            .toString()
            .trim();
        if (preloadConfig.startsWith("."))
            preloadConfig = join(runPath, preloadConfig);
    } catch (error) {}
    const portable = "portable";
    const userDataPath =
        minimist(process.argv.slice(1)).userData ||
        preloadConfig ||
        (statSync(join(runPath, portable)).isDirectory()
            ? join(runPath, portable)
            : "");
    console.log(`userDataPath: ${userDataPath}`);

    if (userDataPath) app.setPath("userData", userDataPath);
} catch (e) {}

const store = new Store({
    configPath: join(app.getPath("userData"), "config.json"),
});

ipcMain.on("store", (e, x) => {
    if (x.type === "get") {
        e.returnValue = store.get(x.path);
    } else if (x.type === "set") {
        store.set(x.path, x.value);
        if (x.path === "鼠标快捷键.全局") syncMouseChord();
    } else if (x.type === "path") {
        e.returnValue = store.path();
    } else if (x.type === "getAll") {
        e.returnValue = store.getAll();
    } else if (x.type === "setAll") {
        store.setAll(x.value);
    }
});

let /** 是否开启开发模式 */ dev: boolean;
// 自动开启开发者模式
if (
    process.argv.includes("-d") ||
    import.meta.env.DEV ||
    process.env.ESEARCH_DEV ||
    store.get("dev")
) {
    dev = true;
} else {
    dev = false;
}

if (dev) {
    setInterval(() => {
        const usage = process.memoryUsage();
        const main = usage.rss / 1024 / 1024;
        let rander = 0;
        for (const i of app.getAppMetrics().filter((i) => i.type === "Tab")) {
            rander += i.memory.workingSetSize;
        }
        rander = rander / 1024;
        console.log(
            `Memory： ${main.toFixed(7)} + ${rander.toFixed(7)} = ${main + rander}`,
        );
    }, 1500);
}

const logs: {
    from: "screenShot" | "ding" | "mainWindow" | "translator";
    message: string;
    type: "info" | "warning" | "error";
    lineCount: number;
}[] = [];

const screenShotArgs = [
    { c: store.get("额外截屏器.命令"), path: store.get("额外截屏器.位置") },
    (m: string) =>
        feedbackUrl({
            title: "截屏库调用错误",
            main: "截屏库调用错误",
            steps: "截屏",
            more: m,
        }),
    t,
    store.get("使用XDGDesktopPortal"),
] as const;

const keepClip = !brokerMode && store.get("保留截屏窗口") === true;

function mainUrl(fileName: string) {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        const mainUrl = `${process.env.ELECTRON_RENDERER_URL}/${fileName}`;
        return mainUrl;
    }
    return join(__dirname, "../renderer", fileName);
}

/** 加载网页 */
function rendererPath(
    window: BrowserWindow,
    fileName: string,
    q?: Electron.LoadFileOptions,
) {
    rendererPath2(window.webContents, fileName, q ?? {});
    window.webContents.on("will-navigate", (event) => {
        event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => {
        return { action: "deny" };
    });
}
function rendererPath2(
    window: Electron.WebContents,
    fileName: string,
    q: Electron.LoadFileOptions,
) {
    window.on("will-navigate", (event) => event.preventDefault());
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        const x = new url.URL(mainUrl(fileName));
        if (q) {
            if (q.search) x.search = q.search;
            if (q.query) {
                for (const i in q.query) {
                    x.searchParams.set(i, q.query[i]);
                }
            }
            if (q.hash) x.hash = q.hash;
        }
        window.loadURL(x.toString());
    } else {
        window.loadFile(mainUrl(fileName), q);
    }
}

if (!store.get("硬件加速")) {
    app.disableHardwareAcceleration();
}

/**
 * 复制选区，存在变化，回调
 */
async function copyText(callback: (t: string) => void) {
    const oClipboard = await clipboard.readText();
    if (process.platform === "darwin") {
        exec(
            `osascript -e 'tell application "System Events"' -e 'delay 0.1' -e 'key code 8 using command down' -e 'end tell'`,
        );
    } else if (process.platform === "win32") {
        const { uIOhook, UiohookKey } =
            require("uiohook-napi") as typeof import("uiohook-napi");
        uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl]);
    } else if (process.platform === "linux") {
        // @ts-ignore
        exec(store.get("主搜索功能.linux_copy") || "xdotool key ctrl+c");
    }
    setTimeout(async () => {
        const t = await clipboard.readText();
        let v = "";
        if (oClipboard !== t) v = t;
        for (const i of store.get("主搜索功能.自动搜索排除")) {
            if (t.match(i)) {
                v = "";
                break;
            }
        }
        callback(v);
        await clipboard.writeText(oClipboard);
    }, 300);
}

/** 读取剪贴板图片（Electron 44 移除了 clipboard.readImage） */
async function readImageFromClipboard() {
    const items = await clipboard.read();
    for (const mime of ["image/png", "image/jpeg"] as const) {
        const item = items.find((i) => i.types.includes(mime));
        if (!item) continue;
        const data = await item.getType(mime);
        if (!("arrayBuffer" in data)) continue;
        return nativeImage.createFromBuffer(
            Buffer.from(await data.arrayBuffer()),
        );
    }
    return nativeImage.createEmpty();
}

/** 写入图片到剪贴板（Electron 44 移除了 clipboard.writeImage） */
async function writeImageToClipboard(image: NativeImage) {
    await clipboard.write([
        new ClipboardItem({
            "image/png": new Blob([image.toPNG()], { type: "image/png" }),
        }),
    ]);
}

/** 自动判断选中搜索还是截屏搜索 */
function autoOpen() {
    copyText((t) => {
        if (t) {
            createMainWindow({ type: "text", content: t });
        } else {
            showPhoto();
        }
    });
}

/** 选区搜索 */
function openSelection() {
    copyText((t) => {
        if (t) createMainWindow({ type: "text", content: t });
    });
}

/** 剪贴板搜索 */
async function openClipBoard() {
    const t =
        process.platform === "linux" && store.get("主搜索功能.剪贴板选区搜索")
            ? await clipboard.selection.readText()
            : await clipboard.readText();
    createMainWindow({ type: "text", content: t });
}

// cli参数重复启动;
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
    app.quit();
} else {
    app.on("second-instance", (_event, commanLine, _workingDirectory) => {
        if (idleExit) clearTimeout(idleExit);
        commands.enqueue(commanLine);
    });
}

function sleep(time: number) {
    if (!time) return;
    return new Promise((rj: (v: boolean) => void) => {
        setTimeout(() => {
            rj(true);
        }, time);
    });
}

/**
 * 根据命令运行
 * @param {string[]} c 命令
 */
async function argRun(c: string[], first?: boolean) {
    const argv = minimist(c.slice(1));
    if (argv["process-inbox"]) {
        await openCapture?.ingestInbox();
        await openCapture?.whenIdle();
        return;
    }
    if (argv.background) return;
    if (argv.toggle) {
        openCapture?.toggle();
        return;
    }
    if (argv.capture) {
        await sendCaptureEvent();
        return;
    }

    const ocrE = store
        .get("离线OCR")
        .map((i) => `${i.id}(${i.name})`)
        .concat(["baidu", "youdao"]);
    const searchE = ["baidu, yandex, google"];

    function getEngine(e: string, list: string[], df: string) {
        if (!list.includes(e)) {
            console.log(`${e} ∉ ${list.join(", ")}`);
        }
        return e || df;
    }

    if (argv.dev) {
        dev = true;
    }

    if (argv.v || argv.version) {
        console.log(app.getVersion());
        if (first) app.exit();
    }
    if (argv.h || argv.help) {
        const list: (string | [string | [string, string], number, string])[] = [
            [["v", "version"], 0, app.getVersion()],
            [["h", "help"], 0, t("帮助")],
            ["config", 0, t("打开配置")],
            ["userData", 0, t("用户数据路径")],
            "",
            [["i", "input"], 0, t("输入图片，如果空，则截屏")],
            ["delay", 0, t("延时截屏")],
            "",
            `[${t("动作")}] [i] [more]`,
            t("动作"),
            ["c", 0, t("截屏")],
            [["s", "save"], 0, t("保存到路径或剪贴板")],
            [["p", "path"], 1, t("保存的路径")],
            ["n", 1, t("连拍数")],
            ["dt", 1, t("连拍间隔（ms）")],
            ["clipborad", 1, t("保存到剪贴板")],
            [["o", "ocr"], 0, t("文字识别")],
            ["engine", 1, ocrE.join(", ")],
            ["[mode]", 1, ""],
            [["m", "img"], 0, t("以图搜图")],
            ["engine", 1, searchE.join(", ")],
            ["[mode]", 1, ""],
            [["d", "ding"], 0, t("贴图")],
            [["t", "text"], 0, t("主页面打开文字")],
            ["[mode]", 1, ""],
            ["setting", 0, t("设置")],
            "",
            t("文字处理模式，不设置则自动判断"),
            ["trans", 0, t("翻译")],
            ["search", 0, t("搜索")],
        ];
        function add(t: string) {
            return t.length === 1 ? `-${t}` : t.startsWith("[") ? t : `--${t}`;
        }
        const list1: (string | [string, string])[] = list.map((i) => {
            if (typeof i === "string") {
                return i;
            }
            const t =
                typeof i[0] === "string"
                    ? add(i[0])
                    : i[0].map((x) => add(x)).join(",");
            return [`${" ".repeat(i[1] * 2)}${t}`, i[2]];
        });
        const maxWidth =
            Math.max(
                ...list1
                    .filter((i) => typeof i !== "string")
                    .map((i) => i[0].length),
            ) + 8;
        console.log(
            list1
                .map((i) => {
                    if (typeof i === "string") return i;
                    return `${i[0]}${" ".repeat(maxWidth - i[0].length)}${i[1]}`;
                })
                .join("\n"),
        );
        if (first) app.exit();
    }
    if (argv.config) {
        shell.openExternal(join(app.getPath("userData"), "config.json"));
        if (first) app.exit();
    }

    const path = argv.i || argv.input;
    async function getImg() {
        let img: NativeImage | undefined = undefined;
        if (!path) {
            const screenShots = initScreenShots(...screenShotArgs);
            await sleep(argv.delay || 0);
            img = (
                await (await screenShots()).screen[0].capture()
            ).toNativeImage();
        } else {
            // minimist 在 "--i" 后面没跟值时给的是布尔 true
            // 直接进 readFileSync会抛 ERR_INVALID_ARG_TYPE
            if (typeof path !== "string") {
                console.error("--i/--input 需要跟一个文件路径");
                return undefined;
            }
            try {
                img = nativeImage.createFromBuffer(readFileSync(path));
            } catch (error) {
                console.error(`读取图片失败 ${path}: ${error}`);
                return undefined;
            }
            if (img.isEmpty()) {
                console.error(`${path} 不是可识别的图片文件`);
                return undefined;
            }
        }
        return img;
    }
    const textMode: setting["主页面"]["模式"] = argv.trans
        ? "translate"
        : argv.search
          ? "search"
          : "auto";
    const e = argv.engine;
    if (argv.s || argv.save) {
        const n = argv.n as number;
        const dt = (argv.dt as number) || 100;

        const savePath = argv.p || argv.path;
        const sp =
            typeof savePath !== "string"
                ? checkFile(
                      join(
                          store.get("快速截屏.路径") ||
                              store.get("保存.保存路径.图片"),
                          getFileName(),
                      ),
                  )
                : existsSync(savePath) && statSync(savePath).isDirectory()
                  ? checkFile(join(savePath, getFileName()))
                  : savePath;

        if (n) {
            if (!sp) return;
            try {
                mkdirSync(sp, { recursive: true });
            } catch (error) {}
            const screenShots = initScreenShots(...screenShotArgs);
            for (let i = 0; i < n; i++) {
                setTimeout(async () => {
                    const image = (
                        await (await screenShots()).screen[0].capture()
                    ).toNativeImage();
                    const buffer = image.toPNG();
                    const filePath = join(sp, `${i}.png`);
                    writeFile(filePath, buffer, () => {});
                }, dt * i);
            }
        } else {
            const img = await getImg();
            if (!img) return;
            if (argv.clipboard) {
                await writeImageToClipboard(img);
            } else {
                const file = sp.endsWith(".png") ? sp : `${sp}.png`;
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, img.toPNG());
                console.log(`已保存截图: ${file}`);
            }
        }
    } else if (argv.o || argv.ocr) {
        const img = await getImg();
        if (!img) return;
        createMainWindow({
            type: "ocr",
            content: img.toDataURL(),
            arg0: getEngine(e, ocrE, store.get("OCR.类型")),
            mode: textMode,
        });
    } else if (argv.d || argv.ding) {
        const img = await getImg();
        if (!img) return;
        ding(img);
    } else if (argv.m || argv.img) {
        const img = await getImg();
        if (!img) return;
        createMainWindow({
            type: "image",
            content: img.toDataURL(),
            arg0: getEngine(e, searchE, store.get("以图搜图.引擎")),
            mode: textMode,
        });
    } else if (argv.t || argv.text) {
        createMainWindow({
            type: "text",
            content: argv.t || argv.text,
            mode: textMode,
        });
    } else if (argv.c) {
        showPhoto();
    } else if (argv.setting) {
        createSettingWindow();
    } else {
        const appPath = app.getAppPath();
        const path = argv._.find(
            (i) =>
                i !== appPath &&
                existsSync(i) &&
                i.match(
                    /(\.png)|(\.jpe?g)|(\.svg)|(\.webp)|(\.bmp)|(\.gif)|(\.ico)|(\.tiff?)$/i,
                ),
        );
        if (path) showPhoto(path);
        else openCapture?.show();
    }
}

function rmR(dir_path: string) {
    try {
        rmSync(dir_path, { recursive: true });
    } catch (error) {}
}

// 快捷键
const 快捷键函数: Record<keyof setting["快捷键"], () => void> = {
    自动识别: autoOpen,
    截屏搜索: showPhoto,
    选中搜索: openSelection,
    剪贴板搜索: openClipBoard,
    快速截屏: quickClip,
    连拍: async () => {
        lianPai();
    },
    结束广截屏: () => {
        mainSend(clipWindow?.webContents, "clip_stop_long", []);
    },
    剪贴板贴图: () => dingFromClipBoard(),
    主页面: () => createMainWindow({ type: "text", content: "" }),
};

// 시작 화면(대시보드) 전역 단축키 — 사용자가 키를 바꿀 수 있다
function ocShortcutDefs(): ShortcutRequest[] {
    return [
        ...(!brokerMode
            ? [
                  {
                      id: "toggle",
                      label: "시작 화면 토글",
                      keys: [
                          "CommandOrControl+Shift+Space",
                          "CommandOrControl+Alt+Space",
                      ],
                      run: () => {
                          openCapture?.toggle();
                      },
                  },
                  {
                      id: "capture",
                      label: "영역 캡처",
                      keys: [
                          "CommandOrControl+Shift+A",
                          "CommandOrControl+Alt+A",
                      ],
                      run: () => {
                          sendCaptureEvent();
                      },
                  },
              ]
            : []),
        {
            id: "record",
            label: "녹화",
            keys: ["CommandOrControl+Shift+R", "CommandOrControl+Alt+R"],
            run: () => {
                sendCaptureEvent(undefined, "record");
            },
        },
        {
            id: "dropzone",
            label: "드롭존",
            keys: ["CommandOrControl+Shift+D", "CommandOrControl+Alt+D"],
            run: () => {
                openCapture?.showDropzone();
            },
        },
        {
            id: "selection",
            label: "선택 글자 번역",
            keys: ["CommandOrControl+Alt+T", "CommandOrControl+Alt+Shift+T"],
            run: () => {
                copyText((text) => {
                    if (text) createBrowser(0, `translate/?text=${text}`);
                });
            },
        },
        {
            id: "restore",
            label: "고정 이미지 복원",
            keys: [
                "CommandOrControl+Alt+Escape",
                "CommandOrControl+Alt+Shift+Escape",
            ],
            run: () => {
                dingThrogh = null;
                for (const [, { win }] of dingwindowList.entries()) {
                    win.setIgnoreMouseEvents(false);
                    win.webContents.send("oc:pins-control", "restore");
                }
            },
        },
    ];
}

function ocShortcutRequests() {
    const custom = store.get("起始页快捷键") || {};
    return ocShortcutDefs().map((def) => {
        const key = custom[def.id];
        return {
            ...def,
            keys: key === undefined ? def.keys : key === "" ? [] : [key],
        };
    });
}

function ocShortcutStatus() {
    const custom = store.get("起始页快捷键") || {};
    const defaults = new Map(
        ocShortcutDefs().map((d) => [d.id, d.keys[0] ?? ""]),
    );
    return shortcutStatus.map((s) => ({
        ...s,
        custom: custom[s.id] ?? null,
        default: defaults.get(s.id) ?? s.requested,
    }));
}

/** key: 새 가속키, ""=끄기, null=기본값으로 되돌리기 */
function rebindOcShortcut(id: string, key: unknown): boolean {
    const def = ocShortcutDefs().find((d) => d.id === id);
    if (!def) return false;
    if (key !== null && typeof key !== "string") return false;
    const keys = key === null ? def.keys : key === "" ? [] : [key];
    if (key !== null && key !== "") {
        const taken = ocShortcutRequests().some(
            (other) => other.id !== id && other.keys.includes(key),
        );
        if (taken) return false;
    }
    const status = shortcutStatus.find((s) => s.id === id);
    const oldActive = status?.active ?? null;
    let active: string | null = null;
    for (const k of keys) {
        if (k === oldActive) {
            active = k;
            break;
        }
        try {
            if (globalShortcut.register(k, def.run)) {
                active = k;
                break;
            }
        } catch {
            /* OS 예약 키는 등록 불가 */
        }
    }
    if (active === null && keys.length > 0) return false;
    if (oldActive && oldActive !== active) globalShortcut.unregister(oldActive);
    const custom = { ...(store.get("起始页快捷键") || {}) };
    if (key === null) delete custom[id];
    else custom[id] = key;
    store.set("起始页快捷键", custom);
    if (status) {
        status.active = active;
        status.available = true;
    }
    return true;
}

// 마우스 좌·우 동시 클릭 트리거
type UiohookModule = typeof import("uiohook-napi");
let mouseHook: UiohookModule["uIOhook"] | null = null;
const chordState = { left: false, right: false, fired: false };

function mouseChordRun(): (() => void) | null {
    switch (store.get("鼠标快捷键.全局")) {
        case "截屏":
            return () => sendCaptureEvent();
        case "快速截屏":
            return () => quickClip();
        case "录屏":
            return () => sendCaptureEvent(undefined, "record");
        case "起始页":
            return () => openCapture?.toggle();
        default:
            return null;
    }
}

// 단계 캡처 — 모드가 켜져 있으면 마우스 클릭마다 해당 화면을 순서대로 저장
let stepCaptureActive = false;
let stepCaptureCount = 0;
let stepCaptureLastAt = 0;

function toggleStepCapture() {
    stepCaptureActive = !stepCaptureActive;
    if (stepCaptureActive) {
        stepCaptureCount = 0;
        stepCaptureLastAt = 0;
    }
    syncMouseChord();
}

async function captureStepAt(x: number, y: number) {
    try {
        const display = screen.getDisplayNearestPoint({ x, y });
        const scale = display.scaleFactor || 1;
        const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: {
                width: Math.max(1, Math.round(display.size.width * scale)),
                height: Math.max(1, Math.round(display.size.height * scale)),
            },
            fetchWindowIcons: false,
        });
        const source =
            sources.find((s) => s.display_id === String(display.id)) ??
            sources[0];
        if (!source || source.thumbnail.isEmpty()) return;
        stepCaptureCount += 1;
        openCapture?.saveImage(
            source.thumbnail,
            `Step-${stepCaptureCount}`,
            false,
            undefined,
            ["단계"],
        );
    } catch (error) {
        console.error("step capture failed", error);
    }
}

function syncMouseChord() {
    if (mouseChordRun() || stepCaptureActive) {
        if (mouseHook) return;
        try {
            const { uIOhook } = require("uiohook-napi") as UiohookModule;
            mouseHook = uIOhook;
            uIOhook.on("mousedown", (e) => {
                if (stepCaptureActive && e.button === 1) {
                    const now = Date.now();
                    if (now - stepCaptureLastAt > 350) {
                        stepCaptureLastAt = now;
                        setTimeout(() => void captureStepAt(e.x, e.y), 60);
                    }
                }
                if (e.button === 1) chordState.left = true;
                else if (e.button === 2) chordState.right = true;
                else return;
                if (!chordState.fired && chordState.left && chordState.right) {
                    chordState.fired = true;
                    const run = mouseChordRun();
                    if (run) setTimeout(run, 0);
                }
            });
            uIOhook.on("mouseup", (e) => {
                if (e.button === 1) chordState.left = false;
                if (e.button === 2) chordState.right = false;
                if (!chordState.left && !chordState.right)
                    chordState.fired = false;
            });
            uIOhook.start();
        } catch (error) {
            console.error("마우스 단축키 후킹 실패", error);
            mouseHook = null;
        }
    } else if (mouseHook) {
        try {
            mouseHook.stop();
        } catch {}
        mouseHook = null;
        chordState.left = chordState.right = chordState.fired = false;
    }
}

let contextMenu: Electron.Menu | null = null;
let tray: Tray | null = null;
const trayIcons: Record<string, NativeImage> = {
    macTem: nativeImage.createFromPath(
        join(runPath, "assets/logo/bw/macIconTemplate.png"),
    ),
    color: nativeImage.createFromPath(join(runPath, "assets/logo/32x32.png")),
    white: nativeImage.createFromPath(
        join(runPath, "assets/logo/bw/32x32_white.png"),
    ),
    black: nativeImage.createFromPath(
        join(runPath, "assets/logo/bw/32x32_black.png"),
    ),
};

app.commandLine.appendSwitch(
    "enable-experimental-web-platform-features",
    "enable",
);

function handleError(e: string) {
    if (app.isReady()) {
        const id = dialog.showMessageBoxSync({
            type: "error",
            title: t("错误"),
            message: e,
            buttons: [t("反馈"), t("复制")],
        });
        if (id === 0) {
            shell.openExternal(feedbackUrl({ title: "主进程错误", main: e }));
        }
        if (id === 1) {
            clipboard.writeText(e);
        }
    } else {
        dialog.showErrorBox(t("错误"), e);
    }
}

process.on("uncaughtException", (e) => {
    handleError(`${e.stack ?? e.name}`);
});

process.on("unhandledRejection", (e) => {
    handleError(String(e));
});

app.whenReady().then(() => {
    console.log(
        `eSearch ${app.getVersion()} 启动\n项目地址：https://github.com/xushengfeng/eSearch`,
    );

    crashReporter.start({ uploadToServer: false });

    store.setDefaultData(defaultSetting);

    fixSettingTree();

    const translation = createTranslationService({
        root: runPath,
        userData: app.getPath("userData"),
    });
    app.once("will-quit", () => translation.dispose());
    openCapture = installOpenCapture(runPath, {
        capture: async (mode) => {
            if (mode === "fullscreen" || mode === "previous") {
                const shots = initScreenShots(...screenShotArgs);
                const all = await shots(screen.getAllDisplays());
                const target =
                    all.screen.find(
                        (s) =>
                            s.id ===
                            screen.getDisplayNearestPoint(
                                screen.getCursorScreenPoint(),
                            ).id,
                    ) ?? all.screen[0];
                if (!target) throw new Error("캡처할 화면을 찾을 수 없습니다.");
                let image = (await target.capture()).toNativeImage();
                if (mode === "previous") {
                    const rect = store.get("框选.记忆.rects")?.[target.id];
                    if (!rect || rect[2] < 1 || rect[3] < 1)
                        throw new Error(
                            "이전 캡처 영역이 없습니다. 먼저 영역을 캡처해 주세요.",
                        );
                    image = image.crop({
                        x: rect[0],
                        y: rect[1],
                        width: rect[2],
                        height: rect[3],
                    });
                }
                const saved = openCapture?.saveImage(image);
                if (saved) showPhoto(saved);
                return;
            }
            const actions: Record<string, 功能 | undefined> = {
                capture: undefined,
                window: undefined,
                scroll: "long",
                record: "record",
                ocr: "ocr",
                "screen-translate": "translate",
            };
            await sendCaptureEvent(undefined, actions[mode]);
        },
        pin: async (path) => {
            if (path) ding(nativeImage.createFromPath(path));
            else await dingFromClipBoard();
        },
        edit: showPhoto,
        settings: createSettingWindow,
        runtimeState: () => ({
            startAtLogin:
                app.isPackaged &&
                app.getLoginItemSettings(loginTarget()).openAtLogin,
            shortcuts: ocShortcutStatus(),
            mouseChord: store.get("鼠标快捷键.全局"),
            brokerMode,
            stepCapture: stepCaptureActive,
        }),
        steps: toggleStepCapture,
        configureRuntime: (input) => {
            if (!input || typeof input !== "object")
                throw new Error("올바른 설정이 아닙니다.");
            const data = input as {
                startAtLogin?: unknown;
                mouseChord?: unknown;
                shortcuts?: unknown;
            };
            const failures: string[] = [];
            if (data.startAtLogin !== undefined) {
                if (typeof data.startAtLogin !== "boolean")
                    throw new Error("올바른 시작 설정이 아닙니다.");
                if (!app.isPackaged)
                    throw new Error(
                        "로그인 시 시작은 배포 앱에서 설정해 주세요.",
                    );
                app.setLoginItemSettings({
                    ...loginTarget(),
                    openAtLogin: data.startAtLogin,
                });
            }
            if (typeof data.mouseChord === "string") {
                store.set(
                    "鼠标快捷键.全局",
                    data.mouseChord as setting["鼠标快捷键"]["全局"],
                );
                syncMouseChord();
            }
            if (data.shortcuts && typeof data.shortcuts === "object") {
                for (const [id, key] of Object.entries(data.shortcuts))
                    if (!rebindOcShortcut(id, key)) failures.push(id);
            }
            return {
                startAtLogin:
                    app.isPackaged &&
                    app.getLoginItemSettings(loginTarget()).openAtLogin,
                shortcuts: ocShortcutStatus(),
                mouseChord: store.get("鼠标快捷键.全局"),
                brokerMode,
                ...(failures.length ? { shortcutErrors: failures } : {}),
            };
        },
        setSaveFolder: (path) => {
            store.set("保存.保存路径.图片", path);
        },
        restorePins: () => {
            dingThrogh = null;
            for (const [, { win }] of dingwindowList.entries()) {
                win.setIgnoreMouseEvents(false);
                win.webContents.send("oc:pins-control", "restore");
            }
        },
        translate: (input) =>
            translation.translate(
                input as Parameters<typeof translation.translate>[0],
            ),
        translationStatus: () => translation.status(),
        installModels: () => translation.installModels(),
        configureTranslation: (input) =>
            translation.configure(
                input as Parameters<typeof translation.configure>[0],
            ),
    });
    store.set("保存.保存路径.图片", openCapture.activeFolder());

    // 初始化语言
    lan(store.get("语言.语言") || "");

    if (!brokerMode && store.get("托盘") !== "无") {
        // 托盘
        tray = new Tray(join(runPath, "assets/logo/32x32.png"));

        function update() {
            tray?.setContextMenu(contextMenu);
        }

        contextMenu = Menu.buildFromTemplate([
            {
                label: "OpenCapture 열기",
                click: () => {
                    openCapture?.show();
                },
            },
            {
                label: `${t("自动识别")}`,
                click: () => {
                    autoOpen();
                },
            },
            {
                label: t("截屏搜索"),
                click: () => {
                    setTimeout(() => {
                        showPhoto();
                    }, store.get("主搜索功能.截屏搜索延迟"));
                },
            },
            {
                label: t("选中搜索"),
                click: () => {
                    openSelection();
                },
            },
            {
                label: t("剪贴板搜索"),
                click: () => {
                    openClipBoard();
                },
            },
            {
                type: "separator",
            },
            {
                label: t("文字识别（OCR）"),
                click: () => {
                    setTimeout(() => {
                        sendCaptureEvent(undefined, "ocr");
                    }, store.get("主搜索功能.截屏搜索延迟"));
                },
            },
            {
                label: t("以图搜图"),
                click: () => {
                    setTimeout(() => {
                        sendCaptureEvent(undefined, "search");
                    }, store.get("主搜索功能.截屏搜索延迟"));
                },
            },
            {
                label: t("超级录屏"),
                click: () => {
                    createSuperRecorderWindow();
                },
            },
            {
                type: "separator",
            },
            {
                label: t("浏览器打开"),
                type: "checkbox",
                checked: store.get("浏览器中打开"),
                click: (i) => {
                    store.set("浏览器中打开", i.checked);
                    update();
                },
            },
            {
                type: "separator",
            },
            {
                label: t("从剪贴板贴图"),
                click: () => {
                    dingFromClipBoard();
                },
            },
            {
                type: "separator",
            },
            {
                label: t("主页面模式"),
                type: "submenu",
                submenu: [
                    {
                        label: t("自动"),
                        type: "radio",
                        checked: store.get("主页面.模式") === "auto",
                        click: () => {
                            store.set("主页面.模式", "auto");
                            update();
                        },
                    },
                    {
                        label: t("搜索"),
                        type: "radio",
                        checked: store.get("主页面.模式") === "search",
                        click: () => {
                            store.set("主页面.模式", "search");
                            update();
                        },
                    },
                    {
                        label: t("翻译"),
                        type: "radio",
                        checked: store.get("主页面.模式") === "translate",
                        click: () => {
                            store.set("主页面.模式", "translate");
                            update();
                        },
                    },
                ],
            },
            {
                label: t("复用主页面"),
                toolTip: t("可加快OCR加载"),
                type: "checkbox",
                checked: store.get("主页面.复用"),
                click: (i) => {
                    store.set("主页面.复用", i.checked);
                    update();
                },
            },
            { type: "separator" },
            {
                label: t("主页面"),
                click: () => {
                    createMainWindow({ type: "text", content: "" });
                },
            },
            {
                label: t("设置"),
                click: () => {
                    createSettingWindow();
                },
            },
            {
                label: t("教程帮助"),
                click: () => {
                    createHelpWindow();
                },
            },
            {
                type: "separator",
            },
            ...(dev
                ? [
                      {
                          label: t("退出开发者模式"),
                          click: () => {
                              store.set("dev", false);
                              app.relaunch();
                              app.exit(0);
                          },
                      },
                  ]
                : []),
            {
                label: t("检查更新"),
                click: async () => {
                    checkUpdate(true);
                },
            },
            {
                label: t("反馈"),
                click: (_i, win) => {
                    shell.openExternal(
                        feedbackUrl({
                            title: `[${win?.getTitle()?.replace("eSearch - ", "") ?? "……界面"}] 存在……问题`,
                        }),
                    );
                },
            },
            {
                label: t("重启"),
                click: () => {
                    app.relaunch();
                    app.exit(0);
                },
            },
            {
                label: t("退出"),
                click: () => {
                    app.quit();
                },
            },
        ]);
        tray?.setToolTip(app.getName());
        if (store.get("点击托盘自动截图")) {
            tray?.on("click", () => {
                showPhoto();
            });
            tray?.on("right-click", () => {
                if (contextMenu) tray?.popUpContextMenu(contextMenu);
            });
        } else {
            if (contextMenu) tray?.setContextMenu(contextMenu);
        }
    }

    // 启动时提示
    if (store.get("启动提示"))
        new Notification({
            title: app.name,
            body: `${app.name} ${t("已经在后台启动")}`,
            icon: join(runPath, "assets/logo/64x64.png"),
        }).show();

    const 快捷键 = store.get("快捷键");
    for (const [k, m] of typedEntries(快捷键)) {
        if (!m.key) continue;
        if (
            !globalShortcut.register(m.key, () => {
                快捷键函数[k]();
            })
        ) {
            console.error(`快捷键注册失败：${k} = ${m.key}`);
        }
    }
    const 工具快捷键 = store.get("全局工具快捷键");
    for (const [k, m] of typedEntries(工具快捷键)) {
        if (!m) continue;
        if (
            !globalShortcut.register(m, () => {
                sendCaptureEvent(undefined, k as 功能);
            })
        ) {
            console.error(`全局工具快捷键注册失败：${k} = ${m}`);
        }
    }

    // tmp目录
    shortcutStatus = registerShortcuts(ocShortcutRequests(), (key, run) =>
        globalShortcut.register(key, run),
    );
    syncMouseChord();
    if (!existsSync(tmpDir)) mkdir(tmpDir, () => {});
    if (keepClip) {
        clipWindow = createClipWindow();
    }

    nativeTheme.themeSource = store.get("全局.深色模式");

    // 菜单栏设置
    setMenu();

    setTray();
    commands.start(process.argv);
});

function setTray() {
    if (!tray) return;
    const i = store.get("托盘");
    if (i === "彩色") {
        tray.setImage(trayIcons.color);
    }
    if (i === "白") {
        tray.setImage(trayIcons.white);
    }
    if (i === "黑") {
        tray.setImage(trayIcons.black);
    }
    if (i === "跟随系统" || i === "跟随系统反") {
        if (isMac) tray.setImage(trayIcons.macTem);
    }
    if (i === "跟随系统") {
        if (nativeTheme.shouldUseDarkColors) {
            tray.setImage(trayIcons.black);
        } else {
            tray.setImage(trayIcons.white);
        }
    }
    if (i === "跟随系统反") {
        if (nativeTheme.shouldUseDarkColors) {
            tray.setImage(trayIcons.white);
        } else {
            tray.setImage(trayIcons.black);
        }
    }
}

const isMac = process.platform === "darwin";

function setMenu() {
    const menuTemplate = [
        ...(isMac
            ? [
                  {
                      label: app.name,
                      submenu: [
                          { label: `${t("关于")} ${app.name}`, role: "about" },
                          { type: "separator" },
                          {
                              label: t("设置"),
                              click: () => {
                                  createSettingWindow();
                              },
                              accelerator: "CmdOrCtrl+,",
                          },
                          { type: "separator" },
                          { label: t("服务"), role: "services" },
                          { type: "separator" },
                          { label: `${t("隐藏")} ${app.name}`, role: "hide" },
                          { label: t("隐藏其他"), role: "hideOthers" },
                          { label: t("全部显示"), role: "unhide" },
                          { type: "separator" },
                          { label: `退出 ${app.name}`, role: "quit" },
                      ],
                  },
              ]
            : []),
        {
            label: t("文件"),
            submenu: [
                {
                    label: t("设置"),
                    click: () => {
                        createSettingWindow();
                    },
                    accelerator: "CmdOrCtrl+,",
                },
                {
                    id: "close",
                    label: t("关闭"),
                    role: "close",
                    accelerator: "CmdOrCtrl+W",
                },
            ],
        },
        {
            label: t("视图"),
            submenu: [
                { label: t("重新加载"), role: "reload" },
                { label: t("强制重载"), role: "forceReload" },
                { label: t("开发者工具"), role: "toggleDevTools" },
                { type: "separator" },
                { label: t("实际大小"), role: "resetZoom", accelerator: "" },
                { label: t("放大"), role: "zoomIn" },
                { label: t("缩小"), role: "zoomOut" },
                { type: "separator" },
                { label: t("全屏"), role: "togglefullscreen" },
            ],
        },
        {
            label: t("窗口"),
            submenu: [
                { label: t("最小化"), role: "minimize" },
                { label: t("关闭"), role: "close" },
                ...(isMac
                    ? [
                          { type: "separator" },
                          { label: t("置于最前面"), role: "front" },
                          { type: "separator" },
                          { label: t("窗口"), role: "window" },
                      ]
                    : []),
            ],
        },
        {
            label: t("帮助"),
            role: "help",
            submenu: [
                {
                    label: t("教程帮助"),
                    click: () => {
                        createHelpWindow();
                    },
                },
            ],
        },
    ] as Electron.MenuItemConstructorOptions[];
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}

app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    try {
        mouseHook?.stop();
    } catch {}
    rmR(tmpDir);
});

function feedbackUrl(op?: {
    title?: string;
    main?: string;
    steps?: string;
    expected?: string;
    more?: string;
}) {
    const url = new URL(
        "https://github.com/xushengfeng/eSearch/issues/new?assignees=&labels=bug&projects=&template=bug_report.yaml",
    );
    url.searchParams.append("title", op?.title || "...存在...的错误");
    url.searchParams.append("main", op?.main || "");
    url.searchParams.append("steps", op?.steps || "");
    url.searchParams.append("expected", op?.expected || "");
    url.searchParams.append("more", op?.more || "");
    url.searchParams.append("v", app.getVersion());
    url.searchParams.append(
        "os",
        `${process.platform} ${release()} (${process.arch})`,
    );
    return url.toString();
}

function feedbackUrl2(op?: {
    title?: string;
    main?: string;
}) {
    const url = new URL(
        "https://github.com/xushengfeng/eSearch/issues/new?template=feature_request.yaml&labels=新需求",
    );
    if (op?.title) url.searchParams.append("title", op.title);
    url.searchParams.append("main", op?.main || "");
    url.searchParams.append("v", app.getVersion());
    url.searchParams.append(
        "os",
        `${process.platform} ${release()} (${process.arch})`,
    );
    return url.toString();
}

const theIcon =
    process.platform === "win32"
        ? join(runPath, "assets/logo/icon.ico")
        : join(runPath, "assets/logo/1024x1024.png");

const baseWinConfig: () => Electron.BrowserWindowConstructorOptions = () => {
    const bg = nativeTheme.shouldUseDarkColors
        ? store.get("全局.主题.dark.bg")
        : store.get("全局.主题.light.bg");
    return {
        icon: theIcon,
        autoHideMenuBar: true,
        backgroundColor: bg,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
        },
    };
};

mainOn("dialogMessage", ([arg0]) => {
    const id = dialog.showMessageBoxSync(arg0);
    return id;
});

function pushLog(op: (typeof logs)[0]) {
    if (logs.length > 50) {
        logs.shift();
    }
    logs.push(op);
}

// 截屏窗口
let clipWindow: BrowserWindow | null = null;
let clipWindowLoaded = false;
let pendingClipInit: [Buffer | undefined, 功能 | undefined] | null = null;
const getClipWin = async () => {
    if (clipWindowLoaded && !clipWindow?.isDestroyed())
        return clipWindow as BrowserWindow;
    if (!clipWindow || clipWindow.isDestroyed())
        clipWindow = createClipWindow();

    return new Promise((re: (v: BrowserWindow) => void) => {
        clipWindow?.webContents.once("did-finish-load", () => {
            clipWindowLoaded = true;
            return re(clipWindow as BrowserWindow);
        });
    });
};
/** 初始化截屏后台窗口 */
function createClipWindow() {
    const _clipWindow = new BrowserWindow({
        icon: theIcon,
        width: screen.getPrimaryDisplay().workAreaSize.width,
        height: screen.getPrimaryDisplay().workAreaSize.height,
        show: false,
        alwaysOnTop: !dev, // 为了方便调试，调试模式就不居上了
        fullscreenable: true,
        transparent: true,
        frame: false,
        resizable: process.platform === "linux", // gnome下为false时无法全屏
        skipTaskbar: true,
        autoHideMenuBar: true,
        movable: false,
        enableLargerThanScreen: true, // mac
        hasShadow: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            zoomFactor: store.get("全局.缩放") || 1.0,
        },
    });

    if (!dev) _clipWindow.setAlwaysOnTop(true, "screen-saver");

    rendererPath(_clipWindow, "capture.html");

    _clipWindow.webContents.on("did-fail-load", (_e, code, desc) =>
        console.log("[clip] fail-load", code, desc),
    );

    _clipWindow.webContents.on("render-process-gone", (_e, d) => {
        console.log(d);
        const id = dialog.showMessageBoxSync({
            message: t("截屏程序崩溃，是否重启？"),
            buttons: [t("重启"), t("退出应用")],
            defaultId: 0,
            cancelId: 1,
            detail: JSON.stringify(d),
        });
        if (id === 0) exitFullScreen();
        if (id === 1) app.exit();
    });
    _clipWindow.webContents.once("did-finish-load", () => {
        clipWindowLoaded = true;
    });
    _clipWindow.webContents.on("did-finish-load", () => {
        if (pendingClipInit)
            mainSend(_clipWindow.webContents, "clip_init", [
                screen.getAllDisplays(),
                pendingClipInit[0],
                screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
                pendingClipInit[1],
            ]);
    });
    _clipWindow.webContents.on("console-message", (d) => {
        console.log("[clip]", d.level, d.message);
        if (d.level !== "debug")
            pushLog({
                from: "screenShot",
                lineCount: d.lineNumber,
                type: d.level,
                message: d.message,
            });
    });
    return _clipWindow;
}

mainOn("clip_show", () => {
    fullScreen();
});
mainOn("clip_close", () => {
    exitFullScreen();
});
mainOn("clip_ocr", ([img, type]) => {
    createMainWindow({ type: "ocr", content: img, arg0: type });
});
mainOn("clip_search", ([img, type]) => {
    createMainWindow({ type: "image", content: img, arg0: type });
});
mainOn("clip_qr", ([img]) => {
    createMainWindow({ type: "qr", content: img });
});
mainOn("clip_hide", async () => {
    hideClip();
});
mainOn("clip_save", async ([type]) => {
    const savedPath = store.get("保存.保存路径.图片") || "";
    const x = await dialog.showSaveDialog({
        title: t("选择要保存的位置"),
        defaultPath: savedPath
            ? join(savedPath, `${getFileName()}.${type}`)
            : undefined,
        filters: [{ name: t("图像"), extensions: [type] }],
    });

    if (x.filePath) {
    } else {
        new Notification({
            title: `${app.name} ${t("保存文件失败")}`,
            body: t("用户已取消保存"),
            icon: join(runPath, "assets/logo/64x64.png"),
        }).show();
        clipWindow?.show();
        clipWindow?.setSimpleFullScreen(true);
    }
    return x.filePath;
});
mainOn("clip_ding", ([img, type, rect]) => {
    createDingWindow(rect.x, rect.y, rect.w, rect.h, img, type);
});
mainOn("clip_mac_app", async () => {
    hideClip();
    const x = await dialog.showOpenDialog({
        defaultPath: "/Applications",
    });
    if (x.canceled) {
        clipWindow?.show();
        clipWindow?.setSimpleFullScreen(true);
    }
    return { canceled: x.canceled, filePaths: x.filePaths };
});
mainOn("clip_record", ([rect, id, w, h, r]) => {
    createRecorderWindow(rect, {
        id: id,
        w: w,
        h: h,
        r: r,
    });
});
mainOn("getMousePos", (_, e) => {
    const w = BrowserWindow.fromWebContents(e.sender)?.getBounds();
    const p = screen.getCursorScreenPoint();
    return {
        po: { x: p.x - (w?.x || 0), y: p.y - (w?.y || 0) },
        ab: p,
    };
});
mainOn("clip_translate", ([arg]) => {
    createTranslator(arg);
});
mainOn("clip_editor", ([arg]) => {
    createPhotoEditor(arg);
});
mainOn("clip_recordx", ([opt]) => {
    createSuperRecorderWindow(opt);
});

/**
 * 获取图片
 * @param {?string} imgPath 路径
 */
function showPhoto(imgPath?: string) {
    if (imgPath) {
        console.log(imgPath);
        readFile(imgPath, (err, data) => {
            if (err) console.error(err);
            sendCaptureEvent(data);
        });
    } else {
        sendCaptureEvent();
    }
}

async function fullScreen() {
    const nearestScreen = screen.getDisplayNearestPoint(
        screen.getCursorScreenPoint(),
    );
    const win = await getClipWin();
    win.setBounds({
        x: nearestScreen.bounds.x,
        y: nearestScreen.bounds.y,
    });
    win.show();
    win.setSimpleFullScreen(true);
}

async function sendCaptureEvent(data?: Buffer, type?: 功能) {
    pendingClipInit = [data, type];
    mainSend((await getClipWin())?.webContents, "clip_init", [
        screen.getAllDisplays(),
        data,
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
        type,
    ]);
}

/** 关闭或隐藏截屏 */
function exitFullScreen() {
    pendingClipInit = null;
    if (keepClip) {
        clipWindow?.setSimpleFullScreen(false);
        clipWindow?.hide();
        try {
            clipWindow?.reload();
        } catch {}
    } else {
        clipWindow?.close();
        clipWindow = null;
        clipWindowLoaded = false;
    }
}

/** 隐藏截屏窗口 */
function hideClip() {
    pendingClipInit = null;
    clipWindow?.setSimpleFullScreen(false);
    clipWindow?.hide();
}

/** 快速截屏 */
async function quickClip() {
    const screenShots = initScreenShots(...screenShotArgs);
    for (const c of (await screenShots()).screen) {
        const image: NativeImage = (await c.capture()).toNativeImage();
        if (store.get("快速截屏.模式") === "clip") {
            await writeImageToClipboard(image);
        } else if (
            store.get("快速截屏.模式") === "path" &&
            store.get("快速截屏.路径")
        ) {
            const filename = checkFile(
                join(store.get("快速截屏.路径"), `${getFileName()}.png`),
            );
            if (!image) return;
            writeFileSync(filename, image.toPNG());
            noti(filename);
        }
    }
}
function checkFile(name: string, baseName = name, n = 1) {
    // 检查文件是否存在于当前目录中。
    if (existsSync(name)) {
        /* 存在文件，需要重命名 */
        const name = baseName.replace(/\.(\w+$)/, `(${n}).$1`);
        return checkFile(name, baseName, n + 1);
    }
    return name;
}

/** 连拍 */
function lianPai(d = store.get("连拍.间隔"), maxN = store.get("连拍.数")) {
    const basePath = store.get("快速截屏.路径");
    if (!basePath) return;
    const screenShots = initScreenShots(...screenShotArgs);
    const dirPath = checkFile(join(basePath, getFileName()));
    mkdirSync(dirPath, { recursive: true });
    for (let i = 0; i < maxN; i++) {
        setTimeout(async () => {
            const image = (
                await (await screenShots()).screen[0].capture()
            ).toNativeImage();
            const buffer = image.toPNG();
            const filePath = join(dirPath, `${i}.png`);
            writeFile(filePath, buffer, (err) => {
                if (err)
                    console.error(`连拍第 ${i} 张写入失败: ${err.message}`);
            });
        }, d * i);
    }
}

let recording = false;
const recorderWinW = 264;
const recorderWinH = 24;

let _recorder: BrowserWindow;
let _recorderTipWin: BrowserWindow;
function createRecorderWindow(
    rect0: [number, number, number, number],
    screenx: { id: string; w: number; h: number; r: number },
) {
    const s = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const ratio = screenx.r;
    const p = {
        x: screen.getCursorScreenPoint().x,
        y: screen.getCursorScreenPoint().y,
    };
    const rect = rect0.map((v) => v / ratio);
    const sx = s.bounds.x;
    const sy = s.bounds.y;
    const sx1 = sx + s.bounds.width;
    const sy1 = sy + s.bounds.height;
    const hx = sx + rect[0] + rect[2] / 2;
    const hy = sy + rect[1] + rect[3] / 2;
    const w = recorderWinW;
    const h = recorderWinH;
    let x = p.x <= hx ? sx + rect[0] : sx + rect[0] + rect[2] - w;
    let y = p.y <= hy ? sy + rect[1] - h - 8 : sy + rect[1] + rect[3] + 8;
    x = Math.max(x, sx);
    x = Math.min(x, sx1 - w);
    y = Math.max(y, sy);
    y = Math.min(y, sy1 - h);
    x = Math.round(x);
    y = Math.round(y);
    const recorder = new BrowserWindow(baseWinConfig());
    _recorder = recorder;
    rendererPath(recorder, "recorder.html");
    if (dev) recorder.webContents.openDevTools();

    recorder.on("close", () => {
        store.set("录屏.大小.x", recorder.getBounds().x);
        store.set("录屏.大小.y", recorder.getBounds().y);
        try {
            recorderTipWin.close();
        } catch (error) {}
    });

    recorder.on("resize", () => {
        if (recorder.isResizable()) {
            store.set("录屏.大小.width", recorder.getBounds().width);
            store.set("录屏.大小.height", recorder.getBounds().height);
        }
    });

    mainOn("recorderReady", () => {
        desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
            let dId = sources.find((s) => s.display_id === screenx.id)?.id;
            if (!dId) dId = sources[0].id;
            mainSend(recorder.webContents, "recordInit", [
                dId,
                rect0,
                screenx.w,
                screenx.h,
            ]);
        });
    });

    globalShortcut.register("Super+R", () => {
        if (!recorder.isDestroyed()) {
            mainSend(recorder.webContents, "recordStartStop", []);
        }
    });

    const recorderTipWin = createRecorderTipWindow(
        rect0,
        ratio,
        screenx.id,
        true,
    );

    recording = true;
}

/** 录屏提示覆盖层：框选区域的虚线、键盘鼠标提示、摄像头、悬浮控制条 */
function createRecorderTipWindow(
    rect0: [number, number, number, number],
    ratio: number,
    displayId: string,
    pause: boolean,
) {
    const border = 2;
    const display = screen
        .getAllDisplays()
        .find((d) => String(d.id) === displayId);
    const rect1 = rect0.map((v) => Math.round(v / ratio));
    const recorderTipWin = new BrowserWindow({
        x: (display?.bounds.x ?? 0) + rect1[0] - border,
        y: (display?.bounds.y ?? 0) + rect1[1] - border,
        width: rect1[2] + border * 2,
        height: rect1[3] + border * 2 + 24,
        transparent: true,
        frame: false,
        autoHideMenuBar: true,
        resizable: process.platform === "linux",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
        },
    });
    _recorderTipWin = recorderTipWin;
    rendererPath(
        recorderTipWin,
        "recorderTip.html",
        pause ? {} : { query: { nopause: "1" } },
    );
    if (dev) recorderTipWin.webContents.openDevTools();

    recorderTipWin.setAlwaysOnTop(true, "screen-saver");

    recorderTipWin.setIgnoreMouseEvents(true);
    return recorderTipWin;
}

function checkWin(win: BrowserWindow) {
    return win && !win.isDestroyed();
}

mainOn("recordStop", () => {
    if (checkWin(_recorderTipWin)) _recorderTipWin.close();
    recording = false;
});
mainOn("recordStart", () => {
    if (checkWin(_recorder)) _recorder.minimize();
});
mainOnReflect("recordTime", () => {
    if (checkWin(_recorderTipWin)) return [_recorderTipWin.webContents];
    return [];
});
mainOnReflect("recordCamera", () => {
    if (checkWin(_recorderTipWin)) return [_recorderTipWin.webContents];
    return [];
});
mainOnReflect("recordState", () => {
    if (checkWin(_recorder)) return [_recorder.webContents];
    return [];
});
mainOn("recordSavePath", ([ext]) => {
    const savedPath = store.get("保存.保存路径.视频") || "";
    dialog
        .showSaveDialog({
            title: t("选择要保存的位置"),
            defaultPath: savedPath
                ? join(savedPath, `${getFileName()}.${ext}`)
                : undefined,
            filters: [{ name: t("视频"), extensions: [ext] }],
        })
        .then(async (x) => {
            if (x.filePath) {
                let fpath = x.filePath;
                if (!fpath.includes(".")) {
                    fpath += `.${ext}`;
                }
                if (checkWin(_recorder))
                    mainSend(_recorder.webContents, "recordSavePathReturn", [
                        fpath,
                    ]);
            } else {
                new Notification({
                    title: `${app.name} ${t("保存视频失败")}`,
                    body: t("用户已取消保存"),
                    icon: join(runPath, "assets/logo/64x64.png"),
                }).show();
            }
        });
});

function createSuperRecorderWindow(fixed?: RecordRect) {
    const recorder = new BrowserWindow(baseWinConfig());
    recorder.minimize();
    rendererPath(recorder, "videoEditor.html");
    if (dev) recorder.webContents.openDevTools();
    if (fixed) {
        _recorder = recorder;
        const tip = createRecorderTipWindow(
            fixed.rect,
            fixed.r,
            fixed.id,
            false,
        );
        tip.webContents.on("did-finish-load", () => {
            mainSend(tip.webContents, "recordCamera", [
                store.get("录屏.摄像头.开启"),
            ]);
        });
        recorder.on("close", () => {
            if (!tip.isDestroyed()) tip.close();
        });
    }
    recorder.webContents.on("did-finish-load", () => {
        desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
            let dId = sources[0].id;
            if (fixed)
                dId = sources.find((s) => s.display_id === fixed.id)?.id ?? dId;
            mainSend(recorder.webContents, "superRecorderInit", [dId, fixed]);
        });
    });
}
mainOn("reloadMainFromSetting", () => {
    if (clipWindow && !clipWindow.isDestroyed() && !clipWindow.isVisible())
        clipWindow.reload();
    if (contextMenu && tray) {
        const browserItem = contextMenu.items.find(
            (i) => i.label === t("浏览器打开"),
        );
        if (browserItem) browserItem.checked = store.get("浏览器中打开");
        tray.popUpContextMenu(contextMenu);
        tray.closeContextMenu();
    }
});
mainOn("getDefaultSetting", async () => {
    return defaultSetting;
});
mainOn("reload", () => {
    app.relaunch();
    app.exit(0);
});
mainOn("exit", () => {
    app.exit(0);
});
mainOn("clearStorage", () => {
    const ses = session.defaultSession;
    ses.clearStorageData();
});
mainOn("clearCache", () => {
    const ses = session.defaultSession;
    Promise.all([
        ses.clearAuthCache(),
        ses.clearCache(),
        ses.clearCodeCaches({}),
        ses.clearHostResolverCache(),
    ]);
});
mainOn("move_user_data", ([target]) => {
    if (!target) return;
    const toPath = resolve(target);
    const prePath = app.getPath("userData");
    mkdirSync(toPath, { recursive: true });
    try {
        if (process.platform === "win32") {
            execSync(`xcopy "${prePath}\\**" "${toPath}" /Y /s`);
        } else {
            execSync(`cp -r "${prePath}/**" "${toPath}"`);
        }
    } catch (error) {}
    // todo 错误返回
});
mainOn("getAutoStart", () => {
    if (process.platform === "linux") {
        try {
            const autoStartPath = join(
                homedir(),
                ".config/autostart/e-search.desktop",
            );
            return existsSync(autoStartPath);
        } catch (error) {
            return false;
        }
    }
    return app.getLoginItemSettings().openAtLogin;
});
mainOn("setAutoStart", ([arg1]) => {
    if (process.platform === "linux") {
        try {
            const autoStartDir = join(homedir(), ".config/autostart");
            const autoStartFile = join(autoStartDir, "e-search.desktop");
            if (arg1) {
                mkdirSync(autoStartDir, { recursive: true });
                cpSync(join(runPath, "assets/e-search.desktop"), autoStartFile);
            } else {
                rmSync(autoStartFile, { recursive: true });
            }
        } catch {}
    } else {
        app.setLoginItemSettings({ openAtLogin: arg1 });
    }
});
mainOn("theme", ([arg1]) => {
    nativeTheme.themeSource = arg1;
    store.set("全局.深色模式", arg1);
});

mainOn("hotkey", ([type, name, key]) => {
    // 先注册新键，成功后再注销旧键：失败时旧绑定原样保留
    const [storeKey, action] =
        type === "快捷键"
            ? ([
                  `快捷键.${name}.key`,
                  () => 快捷键函数[name as keyof typeof 快捷键函数](),
              ] as const)
            : ([
                  `全局工具快捷键.${name}`,
                  () => sendCaptureEvent(undefined, name as 功能),
              ] as const);
    // @ts-ignore
    const old = store.get(storeKey) as string;
    if (key && key === old) return true;
    let ok = true;
    if (key) {
        try {
            ok = globalShortcut.register(key, action);
        } catch {
            ok = false;
        }
    }
    if (!ok) {
        console.error(
            `快捷键注册失败：${name} = ${key}（保留 ${old || "空"}）`,
        );
        return false;
    }
    if (old) globalShortcut.unregister(old);
    return true;
});

// 长截屏

function dingObj() {
    const obj = new Map<
        number,
        { win: BrowserWindow; display: Electron.Display }
    >();
    return {
        set: (
            id: number,
            v: { win: BrowserWindow; display: Electron.Display },
        ) => {
            obj.set(id, v);
            v.win.on("closed", () => {
                obj.delete(id);
            });
        },
        delete: (id: number) => {
            const x = obj.get(id);
            if (x && !x.win.isDestroyed()) {
                x.win.close();
            }
            return obj.delete(id);
        },
        entries: () => {
            return Array.from(obj.entries()).filter(
                ([_, v]) => !v.win.isDestroyed(),
            );
        },
        keys: () => {
            return Array.from(obj.keys());
        },
        size: () => {
            return obj.size;
        },
    };
}

// ding窗口
const dingwindowList = dingObj();

async function dingFromClipBoard() {
    const img = await readImageFromClipboard();
    if (img.getSize().height && img.getSize().width) {
        console.log("ding img");
        ding(img);
    }
}

function ding(img: NativeImage) {
    const nowPoint = screen.getCursorScreenPoint();
    const size = img.getSize();
    if (!size.width || !size.height) return;
    createDingWindow(
        nowPoint.x,
        nowPoint.y,
        size.width,
        size.height,
        img.toDataURL(),
    );
}

function createDingWindow(
    x: number,
    y: number,
    w: number,
    h: number,
    img: string,
    type: "translate" | "ding" = "ding",
) {
    if (dingwindowList.size() === 0) {
        const screenL = screen.getAllDisplays();
        const id = Date.now();
        for (const i of screenL) {
            const dingWindow = new BrowserWindow({
                icon: theIcon,
                transparent: true,
                frame: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                autoHideMenuBar: true,
                enableLargerThanScreen: true, // mac
                hasShadow: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                },
                x: i.bounds.x,
                y: i.bounds.y,
                width: i.bounds.width,
                height: i.bounds.height,
            });
            dingwindowList.set(i.id, { win: dingWindow, display: i });

            rendererPath(dingWindow, "ding.html");
            if (dev) dingWindow.webContents.openDevTools();
            dingWindow.webContents.on("did-finish-load", () => {
                if (!dingWindow.isDestroyed())
                    mainSend(dingWindow.webContents, "addDing", [
                        id,
                        x - i.bounds.x,
                        y - i.bounds.y,
                        w,
                        h,
                        img,
                        type,
                    ]);
            });
            dingWindow.webContents.on("console-message", (d) => {
                if (d.level !== "debug")
                    pushLog({
                        from: "ding",
                        lineCount: d.lineNumber,
                        message: d.message,
                        type: d.level,
                    });
            });
            dingWindow.setIgnoreMouseEvents(true);

            dingWindow.setAlwaysOnTop(true, "screen-saver");
        }
        forceDingThrogh();
    } else {
        const id = Date.now();
        for (const [_, win] of dingwindowList.entries()) {
            const b = win.win.getBounds();
            mainSend(win.win.webContents, "addDing", [
                id,
                x - b.x,
                y - b.y,
                w,
                h,
                img,
                "ding",
            ]);
        }
    }
    // 自动改变鼠标穿透
    if (!dingClickThroughRunning) {
        dingClickThroughRunning = true;
        dingClickThrough();
    }
}
let dingClickThroughRunning = false;
function dingClickThrough() {
    if (dingwindowList.size() === 0) {
        dingClickThroughRunning = false;
        return;
    }
    const nowXY = screen.getCursorScreenPoint();
    for (const [_, win] of dingwindowList.entries()) {
        const b = win.win.getBounds();
        mainSend(win.win.webContents, "dingMouse", [
            nowXY.x - b.x,
            nowXY.y - b.y,
        ]);
    }
    setTimeout(dingClickThrough, 10);
}
let dingThrogh: null | boolean = null;
mainOn("dingIgnore", ([v]) => {
    for (const [_, win] of dingwindowList.entries()) {
        win.win.setIgnoreMouseEvents(dingThrogh === null ? v : dingThrogh);
    }
});

function forceDingThrogh() {
    if (store.get("贴图.强制鼠标穿透")) {
        globalShortcut.register(store.get("贴图.强制鼠标穿透"), () => {
            dingThrogh = !dingThrogh;
            for (const [_, win] of dingwindowList.entries()) {
                win.win.setIgnoreMouseEvents(dingThrogh);
            }
        });
    }
}

mainOnReflect("dingShare", ([data]) => {
    if (data.type === "close" && data.closeAll) {
        for (const i of dingwindowList.keys()) {
            dingwindowList.delete(i);
        }
        return [];
    }

    return dingwindowList.entries().map(([_, { win }]) => win.webContents);
});
mainOn("edit_pic", ([img]) => {
    sendCaptureEvent(img);
});

function createTranslator(op: Omit<translateWinType, "type">) {
    const win = new BrowserWindow({
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        autoHideMenuBar: true,
    });

    const screenSize = (
        screen.getAllDisplays().find((i) => i.id === op.displayId) ||
        screen.getPrimaryDisplay()
    ).bounds;
    let x = Math.floor(op.dipRect.x);
    let y = Math.floor(op.dipRect.y);
    const w = Math.floor(op.dipRect.w);
    const h = Math.floor(op.dipRect.h);
    if (w > h) {
        const y1 = Math.max(0, op.dipRect.y - op.dipRect.h);
        const y2 = Math.min(
            screenSize.height - op.dipRect.h,
            op.dipRect.y + op.dipRect.h,
        );
        y =
            Math.abs(y1 - y) > Math.abs(y2 - y)
                ? Math.floor(y1)
                : Math.floor(y2);
    } else {
        const x1 = Math.max(0, op.dipRect.x - op.dipRect.w);
        const x2 = Math.min(
            screenSize.width - op.dipRect.w,
            op.dipRect.x + op.dipRect.w,
        );
        x =
            Math.abs(x1 - x) > Math.abs(x2 - x)
                ? Math.floor(x1)
                : Math.floor(x2);
    }
    win.setBounds({
        x: x,
        y: y,
        width: w,
        height: h,
    });

    rendererPath(win, "translator.html");
    if (dev) win.webContents.openDevTools();
    win.webContents.on("did-finish-load", () => {
        mainSend(win.webContents, "translatorInit", [
            op.displayId,
            screen.getAllDisplays(),
            op.rect,
        ]);
    });
    win.webContents.on("console-message", (d) => {
        if (d.level !== "debug")
            pushLog({
                from: "translator",
                lineCount: d.lineNumber,
                message: d.message,
                type: d.level,
            });
    });

    win.setAlwaysOnTop(true, "screen-saver");
}

function createPhotoEditor(img: string) {
    const win = new BrowserWindow(baseWinConfig());
    win.maximize();

    rendererPath(win, "photoEditor.html");
    if (dev) win.webContents.openDevTools();

    win.webContents.on("did-finish-load", () => {
        mainSend(win.webContents, "superPhotoEditorInit", [img]);
    });
}

// 主页面
const mainWindowL: {
    [n: number]: {
        win: BrowserWindow;
        browser: { top: number; bottom: number };
    };
} = {};

const mainToSearchL: { [n: number]: Array<number> } = {};
async function createMainWindow(op: MainWinType) {
    if (store.get("主页面.复用") && Object.keys(mainWindowL).length > 0) {
        const name = Math.max(
            ...Object.keys(mainWindowL).map((i) => Number(i)),
        );
        const mainWindow = mainWindowL[name].win;
        op.time = Date.now();
        mainSend(mainWindow.webContents, "editorInit", [name, op]);
        if (store.get("主页面.复用后聚焦")) mainWindow.focus();
        return name;
    }

    const windowName = Date.now();
    const [w, h, m] = store.get("主页面大小");
    const vr = screen.getDisplayNearestPoint(
        screen.getCursorScreenPoint(),
    ).bounds;
    const px = screen.getCursorScreenPoint().x;
    const py = screen.getCursorScreenPoint().y;
    const x = px > vr.x + vr.width / 2 ? px - w : px;
    const y = py > vr.y + vr.height / 2 ? py - h : py;
    const bg = nativeTheme.shouldUseDarkColors
        ? store.get("全局.主题.dark.bg")
        : store.get("全局.主题.light.bg");
    const mainWindow = new BrowserWindow({
        x: Math.max(vr.x, x),
        y: Math.max(vr.y, y),
        width: w,
        height: h,
        minWidth: 400,
        ...baseWinConfig(),
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: bg,
            symbolColor: nativeTheme.shouldUseDarkColors
                ? store.get("全局.主题.dark.fontColor")
                : store.get("全局.主题.light.fontColor"),
            height: 32,
        },
    });
    mainWindowL[windowName] = {
        browser: { top: 0, bottom: 48 },
        win: mainWindow,
    };

    mainToSearchL[windowName] = [];

    if (m) mainWindow.maximize();

    rendererPath(mainWindow, "editor.html");

    await mainWindow.webContents.session.setProxy(store.get("代理"));

    if (dev) mainWindow.webContents.openDevTools();

    op.time = windowName;

    mainWindow.webContents.on("did-finish-load", () => {
        mainWindow.webContents.setZoomFactor(store.get("全局.缩放") || 1.0);
        // 确保切换到index时能传递window_name
        mainSend(mainWindow.webContents, "editorInit", [windowName, op]);

        if (op.type === "image" && op.arg0 === "ai") {
            createBrowser(windowName, "./aiVision.html").then((c) => {
                c?.executeJavaScript(`setImg("${op.content}")`);
            });
        }
    });
    mainWindow.webContents.on("console-message", (d) => {
        if (d.level !== "debug")
            pushLog({
                from: "mainWindow",
                lineCount: d.lineNumber,
                message: d.message,
                type: d.level,
            });
    });

    mainWindow.on("close", () => {
        store.set("主页面大小", [
            mainWindow.getNormalBounds().width,
            mainWindow.getNormalBounds().height,
            mainWindow.isMaximized(),
        ]);
        for (const i of mainWindow.contentView.children) {
            if (i instanceof WebContentsView) i.webContents.close();
        }
    });

    mainWindow.on("closed", () => {
        delete mainWindowL[windowName];
    });

    // 浏览器大小适应
    mainWindow.on("resize", () => {
        setTimeout(() => {
            for (const i of mainWindow.contentView.children) {
                if (i.getBounds().width !== 0)
                    setViewSize(i, mainWindow, mainWindowL[windowName].browser);
            }
        }, 0);
    });

    return windowName;
}

let settingWindow: BrowserWindow | null = null;

async function createSettingWindow() {
    if (settingWindow && !settingWindow.isDestroyed()) {
        settingWindow.focus();
        return;
    }
    settingWindow = new BrowserWindow({
        minWidth: 600,
        width: 900,
        height: 700,
        ...baseWinConfig(),
    });

    rendererPath(settingWindow, "setting.html");

    await settingWindow.webContents.session.setProxy(store.get("代理"));

    if (dev) settingWindow.webContents.openDevTools();

    settingWindow.webContents.on("did-finish-load", () => {
        settingWindow?.webContents.setZoomFactor(store.get("全局.缩放") || 1.0);
    });
}

async function createHelpWindow() {
    shell.openExternal(
        `https://github.com/xushengfeng/eSearch/blob/${app.getVersion()}/docs/use/readme.md`,
    );
}

const searchWindowL: { [n: number]: WebContentsView } = {};
mainOn("open_this_browser", ([window_name, url]) => {
    createBrowser(window_name, url);
});

/** 创建浏览器页面 */
async function createBrowser(windowName: number, url: string) {
    console.log(url);

    if (!windowName)
        // biome-ignore lint: init window
        windowName = await createMainWindow({ type: "text", content: "" });

    const mainWindow = mainWindowL[windowName].win;

    if (mainWindow.isDestroyed()) return null;
    minViews(mainWindow);
    const view = Date.now();
    let webPreferences: Electron.WebPreferences = {};
    if (url.startsWith("translate") || url === "./aiVision.html") {
        webPreferences = {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true,
        };
    }
    const searchView = new WebContentsView({
        webPreferences,
    });
    searchWindowL[view] = searchView;
    await searchView.webContents.session.setProxy(store.get("代理"));
    mainWindow.contentView.addChildView(searchView);

    if (url.startsWith("translate")) {
        rendererPath2(searchView.webContents, "translate.html", {
            query: { text: url.replace("translate/?text=", "") },
        });
    } else if (url === "./aiVision.html") {
        rendererPath2(searchView.webContents, "aiVision.html", {});
    } else searchView.webContents.loadURL(url);
    const bSize = mainWindowL[windowName].browser;
    setViewSize(searchView, mainWindow, bSize);
    searchView.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http") || url.startsWith("https"))
            createBrowser(windowName, url);
        return { action: "deny" };
    });
    if (dev) searchView.webContents.openDevTools();
    if (!mainWindow.isDestroyed())
        mainSend(mainWindow.webContents, "browserNew", [view, url]);

    searchView.webContents.session.setPermissionRequestHandler((_, __, cb) =>
        cb(false),
    );
    searchView.webContents.session.setPermissionCheckHandler(() => false);

    searchView.webContents.on("page-title-updated", (_event, title) => {
        if (!mainWindow.isDestroyed())
            mainSend(mainWindow.webContents, "browserTitle", [view, title]);
    });
    searchView.webContents.on("page-favicon-updated", (_event, favlogo) => {
        if (!mainWindow.isDestroyed())
            mainSend(mainWindow.webContents, "browserIcon", [view, favlogo[0]]);
    });
    searchView.webContents.on("did-navigate", (_event, url) => {
        if (!mainWindow.isDestroyed())
            mainSend(mainWindow.webContents, "browserUrl", [view, url]);
    });
    searchView.webContents.on("did-start-loading", () => {
        if (!mainWindow.isDestroyed())
            mainSend(mainWindow.webContents, "browserLoad", [view, true]);
    });
    searchView.webContents.on("did-stop-loading", () => {
        if (!mainWindow.isDestroyed())
            mainSend(mainWindow.webContents, "browserLoad", [view, false]);
    });
    searchView.webContents.on("did-fail-load", (_event, err_code, err_des) => {
        rendererPath2(searchView.webContents, "browser_bg.html", {
            query: {
                type: "did-fail-load",
                err_code: String(err_code),
                err_des,
            },
        });
        if (dev) searchView.webContents.openDevTools();
    });
    searchView.webContents.on("render-process-gone", () => {
        rendererPath2(searchView.webContents, "browser_bg.html", {
            query: { type: "render-process-gone" },
        });
        if (dev) searchView.webContents.openDevTools();
    });
    searchView.webContents.on("unresponsive", () => {
        rendererPath2(searchView.webContents, "browser_bg.html", {
            query: { type: "unresponsive" },
        });
        if (dev) searchView.webContents.openDevTools();
    });
    searchView.webContents.on("responsive", () => {
        searchView.webContents.loadURL(url);
    });
    searchView.webContents.on("certificate-error", () => {
        rendererPath2(searchView.webContents, "browser_bg.html", {
            query: { type: "certificate-error" },
        });
        if (dev) searchView.webContents.openDevTools();
    });
    return new Promise((resolve: (x: Electron.WebContents) => void) => {
        searchView.webContents.on("did-finish-load", () => {
            resolve(searchView.webContents);
        });
    });
}
/**
 * 标签页事件
 */
function viewEvents(
    w: BaseWindow | undefined,
    arg:
        | "home"
        | "back"
        | "forward"
        | "reload"
        | "stop"
        | "browser"
        | "add_history"
        | "dev",
) {
    if (w instanceof BrowserWindow) mainSend(w.webContents, "viewEvent", [arg]);
}

mainOn("tabView", ([id, arg], e) => {
    const mainWindow = BrowserWindow.fromWebContents(e.sender);
    const searchWindow = searchWindowL[id];
    if (!mainWindow) return;
    switch (arg) {
        case "close":
            mainWindow.contentView.removeChildView(searchWindow);
            searchWindow.webContents.close();
            delete searchWindowL[id];
            break;
        case "top": {
            // 有时直接把主页面当成浏览器打开，这时pid未初始化就触发top了，直接忽略
            if (!mainWindow) return;
            minViews(mainWindow);
            searchWindow.setVisible(true);
            break;
        }
        case "back":
            searchWindow.webContents.goBack();
            break;
        case "forward":
            searchWindow.webContents.goForward();
            break;
        case "stop":
            searchWindow.webContents.stop();
            break;
        case "reload":
            searchWindow.webContents.reload();
            break;
        case "home":
            minViews(mainWindow);
            break;
        case "dev":
            searchWindow.webContents.openDevTools();
            break;
    }
});

mainOn("openUrl", ([url]) => {
    shell.openExternal(url);
});

mainOn("tabViewSize", ([arg2], e) => {
    const mainWindow = BrowserWindow.fromWebContents(e.sender);
    if (!mainWindow) return;
    const bSize = Object.values(mainWindowL).find(
        (i) => i.win === mainWindow,
    )?.browser;
    if (!bSize) return;
    bSize.bottom = arg2.bottom;
    bSize.top = arg2.top;
    for (const w of mainWindow.contentView.children) {
        if (w.getBounds().width !== 0) setViewSize(w, mainWindow, bSize);
    }
});

function setViewSize(
    w: View,
    window: BrowserWindow,
    size: (typeof mainWindowL)[0]["browser"],
) {
    w.setBounds({
        x: 0,
        y: size.top,
        width: window.getBounds().width,
        height: window.getBounds().height - size.bottom - size.top,
    });
}

/** 最小化某个窗口的所有标签页 */
function minViews(mainWindow?: BrowserWindow) {
    if (!mainWindow) return;
    for (const v of mainWindow.contentView.children) {
        v.setVisible(false);
    }
}

/** 生成一个文件名 */
function getFileName() {
    const saveNameTime = time_format(
        store.get("保存名称.时间"),
        new Date(),
    ).replace("\\", "");
    const fileName =
        store.get("保存名称.前缀") + saveNameTime + store.get("保存名称.后缀");
    return fileName;
}

/** 提示保存成功 */
function noti(filePath: string) {
    const notification = new Notification({
        title: `${app.name} ${t("保存文件成功")}`,
        body: `${t("已保存文件到")} ${filePath}`,
        icon: join(runPath, "assets/logo/64x64.png"),
    });
    notification.on("click", () => {
        shell.showItemInFolder(filePath);
    });
    notification.show();
}

mainOn("noti", ([{ title, body }]) => {
    const notification = new Notification({
        title: `${app.name} ${title}`,
        body: body,
        icon: join(runPath, "assets/logo/64x64.png"),
    });
    notification.show();
});

mainOn("windowIgnoreMouse", ([arg], e) => {
    BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(arg);
});
mainOn("windowClose", (_, e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
});
mainOn("windowMax", (_, e) => {
    BrowserWindow.fromWebContents(e.sender)?.maximize();
});
mainOn("windowTop", ([top], e) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(top);
});
mainOn("windowTopest", ([top], e) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(
        top,
        "screen-saver",
    );
});
mainOn("windowShow", (_, e) => {
    BrowserWindow.fromWebContents(e.sender)?.show();
});

mainOn("save_file_path", async ([type, isVideo]) => {
    const savedPath = isVideo
        ? store.get("保存.保存路径.视频") || ""
        : store.get("保存.保存路径.图片") || "";
    const defaultPath = join(savedPath, `${getFileName()}.${type}`);
    if (store.get("保存.快速保存") && savedPath) {
        return defaultPath;
    }
    const x = await dialog.showSaveDialog({
        title: t("选择要保存的位置"),
        defaultPath: savedPath ? defaultPath : undefined,
        filters: [
            { name: isVideo ? t("视频") : t("图像"), extensions: [type] },
        ],
    });
    return x.filePath;
});

mainOn("ok_save", ([arg, isVideo]) => {
    noti(arg);
    if (!isVideo) openCapture?.remember(arg);
    if (isVideo) {
        store.set("保存.保存路径.视频", dirname(arg));
    } else {
        store.set("保存.保存路径.图片", dirname(arg));
    }
});

mainOn("selectPath", async ([path, p]) => {
    try {
        const x = await dialog.showOpenDialog({
            title: t("选择文件"),
            defaultPath: path || app.getPath("pictures"),
            properties: p,
        });
        return x.filePaths[0] || "";
    } catch (error) {
        return "";
    }
});

mainOn("runPath", () => {
    return runPath;
});
mainOn("userDataPath", () => {
    return app.getPath("userData");
});

mainOn("systemLan", () => {
    return matchBestLan();
});
mainOn("feedbackBug", ([arg]) => {
    return feedbackUrl(arg);
});
mainOn("feedbackFeature", ([arg]) => {
    return feedbackUrl2(arg);
});

mainOn("getScreens", () => {
    return screen.getAllDisplays();
});

mainOn("recordMemWarning", () => {
    new Notification({
        title: `${app.name} ${t("录屏内存不足")}`,
        body: t("将自动结束录屏"),
    }).show();
});

mainOn("getLogs", () => {
    return logs;
});

nativeTheme.on("updated", () => {
    setTray();
});

// 默认设置
const defaultSetting: setting = {
    设置版本: app.getVersion(),
    启动提示: false,
    dev: false,
    保留截屏窗口: false,
    语言: { 语言: "ko" },
    托盘: "彩色",
    快捷键: {
        自动识别: {
            key: "",
        },
        截屏搜索: {
            key: "Alt+C",
        },
        选中搜索: {},
        剪贴板搜索: {},
        快速截屏: {},
        连拍: { key: "" },
        主页面: {},
        结束广截屏: { key: "" },
        剪贴板贴图: { key: "" },
    },
    点击托盘自动截图: process.platform !== "linux",
    全局工具快捷键: {
        close: "",
        ocr: "",
        search: "",
        QR: "",
        open: "",
        ding: "",
        record: "",
        long: "",
        copy: "",
        save: "",
        screens: "",
        translate: "",
        editor: "",
        redact: "",
    },
    工具快捷键: {
        close: "Escape",
        ocr: "Enter",
        search: "",
        QR: "",
        open: "",
        ding: "",
        record: "",
        long: "",
        copy: isMac ? "Command+C" : "Control+C",
        save: isMac ? "Command+S" : "Control+S",
        screens: "",
        translate: "",
        editor: "",
        redact: "",
    },
    鼠标快捷键: {
        右键: "取色器",
        双击: "复制",
        全局: "关闭",
    },
    起始页快捷键: {},
    截屏编辑快捷键: {
        select: { 键: "1", 副: { rect: "1+2", free: "1+3", draw: "1+4" } },
        draw: { 键: "2", 副: { free: "2+3", eraser: "2+4", spray: "2+5" } },
        shape: {
            键: "3",
            副: {
                line: "3+4",
                circle: "3+5",
                rect: "3+6",
                polyline: "5",
                polygon: "6",
                text: "7",
                number: "8",
                arrow: "9",
                mask: "3+e",
            },
        },
        filter: {
            键: "4",
            副: {
                pixelate: "4+5",
                blur: "4+6",
                brightness: "",
                contrast: "",
                saturation: "",
                hue: "",
                noise: "",
                invert: "",
                sepia: "",
                bw: "",
                brownie: "",
                vintage: "",
                koda: "",
                techni: "",
                polaroid: "",
                gray_average: "",
                gray_lightness: "",
                gray_luminosity: "",
                gamma: "",
            },
        },
    },
    大小栏快捷键: {
        左上x: "",
        左上y: "",
        右下x: "",
        右下y: "",
        宽: "",
        高: "",
    },
    主页面快捷键: {
        搜索: "Ctrl+Shift+S",
        翻译: "Ctrl+Shift+T",
        打开链接: "Ctrl+Shift+L",
        删除换行: "Ctrl+Enter",
        图片区: "Ctrl+P",
        关闭: "Ctrl+W",
    },
    其他快捷键: {
        复制颜色: "K",
        隐藏或显示栏: "",
    },
    主搜索功能: {
        自动搜索排除: [],
        剪贴板选区搜索: true,
        截屏搜索延迟: 0,
    },
    全局: {
        模糊: 25,
        缩放: 1,
        不透明度: 0.4,
        深色模式: "system",
        主题: {
            light: {
                emphasis: "#D7E3F8",
                barbg: "#D7E3F8",
                bg: "#FAFAFF",
                fontColor: "#1A1C1E",
                fontInEmphasis: "#1A1C1E",
                iconColor:
                    "invert(6%) sepia(11%) saturate(695%) hue-rotate(169deg) brightness(95%) contrast(88%)",
            },
            dark: {
                emphasis: "#3B4858",
                barbg: "#3B4858",
                bg: "#1A1C1E",
                fontColor: "#FAFAFF",
                fontInEmphasis: "#FAFAFF",
                iconColor:
                    "invert(99%) sepia(21%) saturate(4777%) hue-rotate(180deg) brightness(109%) contrast(106%)",
            },
        },
    },
    工具栏: {
        按钮大小: 48,
        按钮图标比例: 0.7,
        初始位置: { left: "10px", top: "100px" },
        功能: [
            "close",
            "screens",
            "ocr",
            "search",
            "QR",
            "open",
            "ding",
            "record",
            "long",
            "translate",
            "editor",
            "redact",
            "copy",
            "save",
        ],
        稍后出现: false,
    },
    字体: {
        主要字体: "",
        等宽字体: "",
        大小: 16,
    },
    编辑器: {
        自动换行: true,
        拼写检查: true,
        行号: true,
        工具: [],
    },
    工具栏跟随: "展示内容优先",
    自动搜索: true,
    鼠标跟随栏: {
        显示: true,
    },
    取色器: { 像素大小: 10, 大小: 15, 显示: true, 默认格式: "HEX" },
    显示四角坐标: true,
    框选: {
        自动框选: {
            图像识别: false,
            最小阈值: 50,
            最大阈值: 150,
        },
        识别窗口: true,
        记忆: { 开启: true, rects: {} },
        颜色: {
            遮罩: "#0008",
            光标参考线: "#00f",
            选区参考线: "#1115",
        },
        参考线: {
            光标: false,
            选区: { x: [], y: [] },
        },
    },
    图像编辑: {
        默认属性: {
            填充颜色: "#fff",
            边框颜色: "#333",
            边框宽度: 1,
            画笔颜色: "#333",
            画笔粗细: 2,
        },
        复制偏移: {
            x: 10,
            y: 10,
        },
        形状属性: {
            arrow: { sw: 3 },
            mask: { fc: "#0005" },
        },
        记忆: {
            select: "rect",
            draw: "free",
            shape: "rect",
            filter: "pixelate",
        },
        arrow: {
            type: "stroke",
            w: 10,
            h: 16,
        },
        收藏: {
            color: [],
            形状: [],
        },
    },
    OCR: {
        类型: "0",
        离线切换: true,
        识别段落: true,
        整体方向识别: false,
        全局det路径: "ppocr6_small_det.onnx",
    },
    离线OCR: [
        {
            id: "korean",
            name: "한국어 / Korean",
            detPath: "ppocr6_small_det.onnx",
            recPath: "korean/korean_rec.onnx",
            dicPath: "korean/korean_dict.txt",
            scripts: ["ko", "en"],
            accuracy: "low",
            speed: "fast",
            optimize: { space: true },
        },
        {
            id: "0",
            name: "默认",
            detPath: "",
            recPath: "",
            dicPath: "",
            scripts: ["zh-HANS", "en"],
            accuracy: "low",
            speed: "fast",
            optimize: {
                space: false,
            },
        },
    ],
    AI: {
        运行后端: "cpu",
        在线模型: [],
    },
    在线OCR: {
        baidu: {
            url: "",
            id: "",
            secret: "",
            time: 0,
            token: "",
        },
        youdao: {
            id: "",
            secret: "",
        },
    },
    以图搜图: {
        引擎: "baidu",
    },
    自动打开链接: false,
    自动搜索中文占比: 0.2,
    浏览器中打开: false,
    浏览器: {
        标签页: {
            自动关闭: true,
            小: false,
            灰度: false,
        },
    },
    保存: {
        默认格式: "png",
        保存路径: { 图片: "", 视频: "" },
        快速保存: false,
        保存并复制: false,
    },
    保存名称: { 前缀: "OpenCapture-", 时间: "YYYY-MM-DD-HH-mm-ss-S", 后缀: "" },
    框选后默认操作: "no",
    快速截屏: { 模式: "clip", 路径: "" },
    引擎: {
        记忆: {
            搜索: "必应",
            翻译: "Deepl",
        },
        搜索: [
            { name: "必应", url: "https://cn.bing.com/search?q=%s" },
            { name: "Google", url: "https://www.google.com/search?q=%s" },
            { name: "百度", url: "https://www.baidu.com/s?wd=%s" },
            { name: "Yandex", url: "https://yandex.com/search/?text=%s" },
        ],
        翻译: [
            {
                name: "Google",
                url: "https://translate.google.com.hk/?op=translate&text=%s",
            },
            {
                name: "Deepl",
                url: "https://www.deepl.com/translator#any/any/%s",
            },
            { name: "金山词霸", url: "http://www.iciba.com/word?w=%s" },
            { name: "百度", url: "https://fanyi.baidu.com/#auto/auto/%s" },
            { name: "腾讯", url: "https://fanyi.qq.com/?text=%s" },
            { name: "翻译", url: "translate/?text=%s" },
        ],
    },
    历史记录设置: {
        保留历史记录: true,
        自动清除历史记录: false,
        d: 14,
    },
    ding_dock: [0, 0],
    贴图: {
        窗口: {
            变换: ["transform: rotateY(180deg);"],
            双击: "归位",
            提示: false,
        },
        强制鼠标穿透: "",
    },
    代理: {
        mode: "direct",
        pacScript: "",
        proxyRules: "",
        proxyBypassRules: "",
    },
    主页面: {
        模式: "auto",
        复用: true,
        复用后聚焦: true,
        失焦关闭: false,
        简洁模式: false,
        显示图片区: 10,
        自动复制OCR: false,
        复制OCR后提示: false,
    },
    主页面大小: [800, 600, false],
    时间格式: "MM/DD hh:mm:ss",
    硬件加速: true,
    更新: {
        检查更新: false,
        频率: "start",
        模式: "小版本",
        忽略版本: "",
    },
    录屏: {
        模式: "normal",
        自动录制: true,
        自动录制延时: 3,
        视频比特率: 2.5,
        摄像头: {
            开启: false,
            镜像: false,
            设备: "",
            背景: {
                模式: "none",
                模糊: 40,
                imgUrl: "",
                videoUrl: "",
                fit: "cover",
            },
        },
        音频: {
            设备列表: [],
            启用系统内录: true,
        },
        转换: {
            格式: "webm",
            码率: 2.5,
            帧率: 30,
            其他: "",
            高质量gif: false,
            分段: 10,
        },
        提示: {
            键盘: {
                开启: false,
                位置: { x: "+", y: "+", offsetX: 4, offsetY: 4 },
                大小: 1,
            },
            鼠标: {
                开启: false,
            },
            光标: {
                开启: false,
                样式: "width: 24px;\nheight: 24px;\nborder-radius: 50%;\nbackground-color: #ff08;",
            },
        },
        大小: {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        },
        超级录屏: {
            编码选择: "性能优先",
            关键帧间隔: 150,
            格式: "gif",
            缩放: 2,
            导出后关闭: false,
        },
    },
    屏幕翻译: {
        type: "ding",
        dTime: 3000,
        color: { bg: "rgb(255,255,255,0.5)", text: "" },
        语言: {
            from: "en",
            to: "ko",
        },
    },
    翻译: {
        翻译器: [],
        收藏: {
            fetch: [],
            文件: [],
        },
        常用语言: [],
    },
    额外截屏器: { 命令: "", 位置: "" },
    使用XDGDesktopPortal: false,
    自定义屏幕属性: [],
    连拍: {
        数: 5,
        间隔: 100,
    },
    广截屏: {
        模式: "自动",
        t: 800,
        方向: "y",
    },
    高级图片编辑: { 配置: [], 默认配置: "" },
    网络: {
        github镜像: {
            启用: false,
            api: githubMirrorList.api[
                Math.floor(Math.random() * githubMirrorList.api.length)
            ],
            base: githubMirrorList.base[
                Math.floor(Math.random() * githubMirrorList.base.length)
            ],
        },
    },
};
try {
    defaultSetting.保存.保存路径.图片 = app.getPath("pictures");
    defaultSetting.保存.保存路径.视频 = app.getPath("videos");
} catch (e) {
    console.error(e);
}

function matchBestLan() {
    const supportLan = getLans();
    const l = matchFitLan(app.getLocale(), supportLan);
    if (l) return l;
    return "zh-HANS";
}

// 增加设置项后，防止undefined
function fixSettingTree() {
    if (store.get("设置版本") === app.getVersion() && !dev) return;
    versionTrans();
    store.set("设置版本", app.getVersion());
    if (store.get("网络.github镜像.启用") === undefined)
        store.set("网络.github镜像.启用", matchBestLan() === "zh-HANS");
}

function versionTrans() {
    const version = store.get("设置版本");
    if (versionCompare(version, "14.1.0") <= 0) {
        const oldSetting = store.get("贴图.窗口.变换");
        if (typeof oldSetting === "string") {
            store.set("贴图.窗口.变换", [oldSetting]);
        }
    }
    if (versionCompare(version, "14.6.4") <= 0) {
        const ocr = store.get("离线OCR") as unknown as [
            string,
            string,
            string,
            string,
        ][];
        const newOcr: {
            id: string;
            name: string;
            detPath: string;
            recPath: string;
            dicPath: string;
            scripts: string[];
        }[] = [];
        for (const i of ocr) {
            newOcr.push({
                id: i[0] === "默认" ? "0" : i[0],
                name: i[0],
                detPath: i[1],
                recPath: i[2],
                dicPath: i[3],
                scripts: [],
            });
        }
        store.set("离线OCR", newOcr);
        if (store.get("OCR.类型") === "默认") {
            store.set("OCR.类型", "0");
        }
    }
}

function versionCompare(v1: string, v2: string) {
    const v1Arr = v1.split("-")[0].split(".");
    const v2Arr = v2.split("-")[0].split(".");
    for (let i = 0; i < v1Arr.length; i++) {
        const a = Number(v1Arr.at(i) ?? 0);
        const b = Number(v2Arr.at(i) ?? 0);
        if (a > b) {
            return 1;
        }
        if (a < b) {
            return -1;
        }
    }
    return 0;
}

function githubPath(url: string): {
    type: GithubUrlType;
    path: string;
} {
    const u = url.replace("https://", "");
    if (u.startsWith("api.github.com"))
        return {
            path: u.replace("api.github.com", ""),
            type: "api",
        };
    if (u.startsWith("github.com"))
        return { path: u.replace("github.com", ""), type: "base" };
    return { path: url, type: "base" };
}

function githubUrl(_path: string, _type: GithubUrlType | "auto" = "auto") {
    const s = store.get("网络.github镜像");
    function ap(x: string) {
        return x.replace(/\/$/, "");
    }
    function bp(x: string) {
        return x.replace(/^\//, "");
    }
    if (!s.启用) {
        if (_type === "auto") return _path;
        return _type === "api"
            ? `https://api.github.com/${bp(_path)}`
            : `https://github.com/${bp(_path)}`;
    }
    const { path, type } =
        _type === "auto" ? githubPath(_path) : { path: _path, type: _type };
    if (type === "api") {
        return `${ap(s.api)}/${bp(path)}`;
    }
    if (type === "base") {
        return `${ap(s.base)}/${bp(path)}`;
    }
    return path;
}

mainOn("githubUrl", ([p, t]) => githubUrl(p, t));

function checkUpdate(s手动检查?: boolean) {
    if (!s手动检查) return;
    dialog.showMessageBox({
        message:
            "OpenCapture는 자동 업데이트를 사용하지 않습니다. 배포받은 프로젝트에서 새 버전을 확인해 주세요.",
        buttons: ["확인"],
    });
}

function showVersion(arg?: { v: string; url: string } | "err") {
    let title = "";
    let b = "";
    let url = "https://github.com/xushengfeng/eSearch/releases";
    if (arg) {
        if (arg === "err") {
            title = t("无法检查更新");
            b = t("请检查网络，稍后重试");
        } else {
            title = `${app.name} ${t("有新版本：")}${arg.v}`;
            b = `${t("点击下载")}`;
            url = arg.url;
        }
    } else {
        title = t("已是最新版本");
    }
    const notification = new Notification({
        title,
        body: b,
        icon: join(runPath, "assets/logo/64x64.png"),
    });
    notification.on("click", () => {
        shell.openExternal(url);
    });
    notification.show();
}

// Fork updates are deliberately managed by OpenCapture releases.
