import {
    button,
    check,
    dynamicSelect,
    ele,
    image,
    input,
    p,
    txt,
} from "dkh-ui";
import { view } from "dkh-ui";
import { t } from "../../../lib/translate/translate";
/// <reference types="vite/client" />
import { Class, cssColor, getImgUrl, initStyle, setTitle } from "../root/root";

import store from "../../../lib/store/renderStore";
initStyle(store);

setTitle(t("录屏"));

let recorder: MediaRecorder;

/** 临时保存的原始视频位置 */
let tmpPath: string;
let crashPath = "";
let crashReset = true;
/** 转换 */
let output: string;

let sS = false;
let stop = false;
let cancelled = false;
let trimChanged = false;

type RecorderState =
    | "ready"
    | "recording"
    | "paused"
    | "processing"
    | "saved"
    | "cancelled"
    | "error";

let recorderState: RecorderState = "ready";
let retryAction: (() => void) | undefined;

const clipTime = Number(store.get("录屏.转换.分段")) * 1000;

const nameT: { s: number; e: number }[] = [{ s: 0, e: Number.NaN }];

const timeL: number[] = [];
function pTime() {
    const t = Date.now();
    timeL.push(t);
    let d = 0;
    for (let i = 0; i < timeL.length; i += 2) {
        if (timeL[i + 1]) d += timeL[i + 1] - timeL[i];
    }
}
function getT() {
    let t = 0;
    for (let i = 1; i < timeL.length - 1; i += 2) {
        t += timeL[i] - timeL[i - 1];
    }
    if (timeL.length % 2 === 0) {
        t += Date.now() - (timeL.at(-2) as number);
    } else {
        t += Date.now() - (timeL.at(-1) as number);
    }
    return t;
}
function setTime(t: string) {
    renderSend("recordTime", [t]);
    timeEl.sv(t);
}
function formatT(t: number) {
    const s = Math.trunc(t / 1000);
    const m = Math.trunc(s / 60);
    const h = Math.trunc(m / 60);
    return `${h === 0 ? "" : `${h}:`}${m - 60 * h}:${String(
        s - 60 * m,
    ).padStart(2, "0")}`;
}
function getTime() {
    if (recorder.state === "recording") {
        let t = 0;
        for (let i = 1; i < timeL.length - 1; i += 2) {
            t += timeL[i] - timeL[i - 1];
        }
        t += Date.now() - (timeL.at(-1) as number);
        setTime(formatT(t));
    } else if (recorder.state === "paused") {
        let elapsed = 0;
        for (let i = 1; i < timeL.length; i += 2) {
            elapsed += timeL[i] - timeL[i - 1];
        }
        setTime(`${formatT(elapsed)} · ${t("일시정지")}`);
    }
}

type mimeType =
    | "mp4"
    | "webm"
    | "gif"
    | "mkv"
    | "mov"
    | "avi"
    | "ts"
    | "mpeg"
    | "flv";
let type = store.get("录屏.转换.格式") as mimeType;

const audioStreamS = new Map<string, MediaStream>();
let stream: MediaStream;

const sysAudioName = "00";

let rect: [number, number, number, number];

// biome-ignore format:
const spawn = require("node:child_process").spawn as typeof import("child_process").spawn;
const fs = require("node:fs") as typeof import("fs");
const path = require("node:path") as typeof import("path");
const { pathToFileURL } = require("node:url") as typeof import("url");
import { renderOn, renderSend, renderSendSync } from "../../../lib/ipc";
import { typedEntries } from "../../../lib/utils";
import type { IconType } from "../../iconTypes";
let pathToFfmpeg = "ffmpeg";
if (process.platform === "win32" || process.platform === "darwin") {
    const p = path.join(__dirname, "..", "..", "lib", "ffmpeg");
    const n = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    pathToFfmpeg = path.join(p, n);
}
const start = spawn(pathToFfmpeg, ["-version"]);
start.on("error", () => {
    const m =
        process.platform === "linux"
            ? t("请安装FFmpeg，并确保软件可使用ffmpeg命令")
            : t("请重新安装软件，或进行反馈");
    renderSend("dialogMessage", [
        {
            message: `${t("FFmpeg用于处理视频，但现在软件无法使用它")}\n${m}`,
            buttons: [t("取消")],
        },
    ]);
});

/** 自动分段 */
function c() {
    if (clipTime === 0) return;
    setTimeout(() => {
        if (!stop) {
            recorder.stop();
            c();
        }
    }, clipTime);
}

function cameraStreamF(b: boolean) {
    renderSend("recordCamera", [b]);
}

function resize() {
    const p = {
        h: videoPEl.el.offsetHeight,
        w: videoPEl.el.offsetWidth,
    };
    const c = {
        h: vpEl.el.offsetHeight,
        w: vpEl.el.offsetWidth,
    };
    const k0 = p.h / p.w;
    const k1 = c.h / c.w;
    if (k0 >= k1) {
        // @ts-ignore
        vpEl.el.style.zoom = p.w / c.w;
    } else {
        // @ts-ignore
        vpEl.el.style.zoom = p.h / c.h;
    }
}

let editting = false;
let exportedPlayback = false;

function setVideo(n: number) {
    exportedPlayback = false;
    videoEl.src = `${tmpPath}/${n}`;
}

/** 获取绝对时间 */
function getPlayT() {
    let t = 0;
    for (let i = 0; i < playName; i++) {
        t += nameT[i].e - nameT[i].s;
    }
    t += videoEl.currentTime * 1000;
    return t;
}

/** 通过绝对时间设定视频和其相对时间 */
function setPlayT(time: number) {
    const x = getTimeInV(time);
    setVideo(x.v);
    playName = x.v;
    videoEl.currentTime = x.time / 1000;
}

/** 获取绝对时间对应的视频和相对时间 */
function getTimeInV(time: number) {
    for (let i = 0; i < nameT.length; i++) {
        if (
            nameT[i].s <= time &&
            (time < nameT?.[i + 1]?.s || time <= nameT[i].e)
        ) {
            return {
                v: i,
                time: Math.min(time - nameT[i].s, nameT[i].e - nameT[i].s),
            };
        }
    }
    return { v: 0, time: 0 };
}

function getAudioNames() {
    const names = Array.from(audioStreamS.keys());
    if (recordSysAudio) names.push(sysAudioName);
    return names;
}

function showControl() {
    editting = true;
    playEl.sv(true);
    if (cameraEl.gv) cameraStreamF(false);
    sEl.class("s_show");
    settingEl.style({ display: "none" });
    mEl.style({ backgroundColor: cssColor.bg });
    videoPEl.style({ transform: "" });
    segEl.remove();
    sEl.el.prepend(retryEl.el);
    sEl.el.prepend(statusEl.el);
    setVideo(0);
    videoEl.style.left = `${-rect[0]}px`;
    videoEl.style.top = `${-rect[1]}px`;
    vpEl.style({
        width: `${rect[2]}px`,
        minWidth: `${rect[2]}px`,
        height: `${rect[3]}px`,
        minHeight: `${rect[3]}px`,
    });
    clipV();
    saveEl.el.disabled = !isTsOk;
    renderSend("windowMax", []);

    setTimeout(() => {
        resize();
        mEl.style({ transition: "none" });
    }, 400);
}

let playName = 0;

function clipV() {
    tStartEl.sv(0);
    setEnd();

    tTEl.sv(tFormat(tEndEl.gv - tStartEl.gv));
    tNtEl.sv(tFormat(0));
    trimChanged = false;
}

/**
 *
 * @param x 输入秒
 */
function tFormat(x: number) {
    const t = x;
    const s = Math.trunc(t / 1000);
    const m = Math.trunc(s / 60);
    const h = Math.trunc(m / 60);
    return `${h === 0 ? "" : `${h}:`}${m - 60 * h}:${String(s - 60 * m).padStart(2, "0")}.${String(
        t % 1000,
    ).slice(0, 1)}`;
}

function videoPlay() {
    if (!exportedPlayback) setPlayT(tStartEl.gv);
    videoEl.play();
}

const clipPath: string[] = [];
let clipPromise: Promise<void> | undefined;
let clipReady = false;
/** 获取要切割的视频和位置 */
async function clip() {
    if (clipReady) return;
    if (clipPromise) return clipPromise;
    clipPromise = runClip();
    try {
        await clipPromise;
        clipReady = true;
    } finally {
        clipPromise = undefined;
    }
}

async function runClip() {
    const start = tStartEl.gv;
    const end = tEndEl.gv;
    const startV = getTimeInV(start);
    const endV = getTimeInV(end);
    const segmentDuration = nameT[startV.v].e - nameT[startV.v].s;
    if (
        !trimChanged &&
        startV.v === endV.v &&
        startV.time <= 1 &&
        Math.abs(endV.time - segmentDuration) <= 50
    ) {
        clipPath.length = 0;
        clipPath.push(path.join(output, `${startV.v}.${type}`));
        return;
    }
    const output1 = path.join(tmpPath, "output1");
    fs.rmSync(output1, { recursive: true, force: true });
    fs.mkdirSync(output1);
    clipPath.length = 0;
    function toArg(
        v: number,
        t: number,
        a: "start" | "end" | "both",
        t2: number,
    ) {
        const args: (string | number)[] = [];
        args.push("-i", path.join(output, `${v}.${type}`));
        if (a === "start") {
            args.push("-ss", t / 1000);
        } else if (a === "end") {
            args.push("-to", t / 1000);
        } else {
            args.push("-ss", t / 1000, "-to", t2 / 1000);
        }
        args.push(path.join(output1, `${v}.${type}`));
        return args.map((i) => String(i));
    }
    if (startV.v + 1 < endV.v) {
        for (let i = startV.v + 1; i < endV.v; i++) {
            fs.copyFileSync(
                path.join(output, `${i}.${type}`),
                path.join(output1, `${i}.${type}`),
            );
        }
    }
    for (let i = startV.v; i <= endV.v; i++) {
        clipPath.push(
            path
                .join(output1, `${i}.${type}`)
                .replaceAll(path.sep, path.posix.sep),
        );
    }
    if (startV.v === endV.v) {
        await runFfmpeg(
            "clip",
            0,
            toArg(startV.v, startV.time, "both", endV.time),
        );
    } else {
        await Promise.all([
            runFfmpeg("clip", 0, toArg(startV.v, startV.time, "start", 0)),
            runFfmpeg("clip", 1, toArg(endV.v, endV.time, "end", 0)),
        ]);
    }
}

async function joinAndSave(filepath: string) {
    if (clipPath.length === 1) {
        fs.cpSync(clipPath[0], filepath);
        ffprocess.join[0] = { args: [], finish: "ok", logs: [], testCom: "" };
        updataPrEl(ffprocess);
    } else {
        const args: string[] = [];

        // 针对不同格式的合并（用switch还要加上作用域的话缩进就太多了）
        if (type === "gif") {
            for (const i of clipPath) args.push("-i", i);
            args.push("-filter_complex");
            let filter = "";
            for (const i in clipPath) filter += `[${i}:v:0]`;
            filter += `concat=n=${clipPath.length}:v=1[outv]`;
            args.push(filter, "-map", "[outv]");
        } else {
            const list = clipPath.map((i) => `file '${i}'`).join("\n");
            const textPath = path.join(tmpPath, "output1", "x.txt");
            fs.writeFileSync(textPath, list);
            args.push(
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                textPath,
                "-c",
                "copy",
            );
        }
        args.push(filepath);
        await runFfmpeg("join", 0, args);
    }
    if (!fs.existsSync(filepath) || fs.statSync(filepath).size === 0) {
        throw new Error(t("저장된 녹화 파일이 비어 있습니다."));
    }
    exportedPlayback = true;
    videoEl.src = pathToFileURL(filepath).href;
    renderSend("ok_save", [filepath, true]);
}

async function save() {
    if (!isTsOk || recorderState === "processing") return;
    store.set("录屏.转换.格式", 格式El.el.gv);
    setRecorderState("processing", t("저장 위치를 선택하는 중입니다."));
    renderSend("recordSavePath", [type]);
}

let isTsOk = false;
let lastSavePath = "";

async function performSave(filepath: string) {
    lastSavePath = filepath;
    setRecorderState("processing", t("녹화를 저장하는 중입니다."));
    try {
        await clip();
        await joinAndSave(filepath);
        retryAction = undefined;
        setRecorderState("saved", t("녹화를 저장했습니다."));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        retryAction = () => void performSave(lastSavePath);
        setRecorderState("error", message);
    }
}

const prText = {
    wait: {
        ts: "等待转换",
        clip: "等待裁剪",
        join: "等待合并",
    },
    running: {
        ts: "正在转换",
        clip: "正在裁剪",
        join: "正在合并",
    },
    ok: {
        ts: "转换完成",
        clip: "裁剪完成",
        join: "合并完成",
    },
    error: {
        ts: "转换失败",
        clip: "裁剪失败",
        join: "合并失败",
    },
};

for (const [_, v] of typedEntries(prText)) {
    for (const [j] of typedEntries(v)) {
        v[j] = t(v[j]);
    }
}

function setFFState(type: keyof typeof prEl, n: number, state: prst) {
    ffprocess[type][n].finish = state;
    if (
        type === "ts" &&
        Object.values(ffprocess[type]).every((i) => i.finish === "ok")
    ) {
        isTsOk = true;
        saveEl.el.disabled = false;
        setRecorderState("ready", t("검토 후 저장할 수 있습니다."));
    }
}

function updataPrEl(pr: typeof ffprocess) {
    for (const i in pr) {
        const key = i as "ts" | "clip" | "join";
        const prILen = Object.keys(pr[key]).length;
        if (prILen === 0) {
            prEl[key].el.innerText = `${prText.wait[key]}`;
        } else {
            const stI: { [key in prst]: number } = {
                ok: 0,
                err: 0,
                running: 0,
            };
            for (const j in pr[key]) {
                stI[pr[key][j].finish]++;
            }
            if (stI.err > 0) {
                prEl[key].el.innerText =
                    `${prText.error[key]} ${t("点击重试")}`;
                prEl[key].class("pro_error");
                prEl[key].el.onclick = () => {
                    for (const i in pr[key]) {
                        if (pr[key][i].finish === "err") {
                            runFfmpeg(key, Number(i), pr[key][i].args);
                        }
                    }
                    logText.el.value += `\n\n${t("重试")}\n\n`;
                };
                logP.el.classList.remove("hide_log");
                for (const i in pr[key]) {
                    if (pr[key][i].finish === "err") {
                        logText.el.value += `\n命令：\n${pr[key][i].testCom}\n\n输出：\n${pr[key][i].logs.map((i) => i.text).join("\n")}`;
                    }
                }
                logText.el.scrollTop = logText.el.scrollHeight;
            } else if (stI.ok === prILen) {
                prEl[key].el.innerText = `${prText.ok[key]}`;
                prEl[key].el.style.width = "100%";
                prEl[key].class("pro_ok");
                if (key === "ts") {
                    isTsOk = true;
                    prEl[key].el.innerText += ` ${t("等待保存")}`;
                }
            } else {
                prEl[key].el.innerText =
                    `${prText.running[key]} ${stI.running}/${prILen}`;
                prEl[key].el.style.width = `${(stI.running / prILen) * 100}%`;
                prEl[key].class("pro_running");
            }
        }
    }
}

type prst = "ok" | "err" | "running";

type P = {
    [k: number]: {
        args: string[];
        testCom: string;
        logs: { text: string }[];
        finish: "ok" | "err" | "running";
    };
};
const ffprocess: {
    [key in "ts" | "clip" | "join"]: P;
} = {
    ts: {},
    clip: {},
    join: {},
};

function runFfmpeg(type: "ts" | "clip" | "join", n: number, args: string[]) {
    const ffmpeg = spawn(pathToFfmpeg, args);
    ffprocess[type][n] = {
        args,
        testCom: `ffmpeg ${args.join(" ")}`,
        finish: "running",
        logs: [],
    };
    updataPrEl(ffprocess);
    return new Promise<boolean>((re, rj) => {
        ffmpeg.on("close", (code) => {
            if (code === 0) {
                setFFState(type, n, "ok");
                updataPrEl(ffprocess);
                re(true);
            } else {
                setFFState(type, n, "err");
                updataPrEl(ffprocess);
                if (type === "ts") {
                    retryAction = () => {
                        void runFfmpeg(type, n, args).catch(() => {});
                    };
                    setRecorderState(
                        "error",
                        t("녹화 처리에 실패했습니다. 다시 시도할 수 있습니다."),
                    );
                }
                rj(new Error(`FFmpeg exited with code ${String(code)}`));
            }
        });
        ffmpeg.stdout.on("data", (data: Uint8Array) => {
            ffprocess[type][n].logs.push({ text: data.toString() });
        });
        ffmpeg.stderr.on("data", (data: Uint8Array) => {
            ffprocess[type][n].logs.push({ text: data.toString() });
        });
    });
}

function iconEl(src: IconType) {
    return image(getImgUrl(`${src}.svg`), "icon").class("icon");
}
function iconBEl(src: IconType) {
    return button().add(image(getImgUrl(`${src}.svg`), "icon").class("icon"));
}

class time_i extends HTMLElement {
    _value = 0;
    _min = 0;
    _max = 0;
    input = document.createElement("input");

    connectedCallback() {
        this._value = Number(this.getAttribute("value")) || 0;
        this._min = Number(this.getAttribute("min")) || 0;
        this._max = Number(this.getAttribute("max")) || 0;
        const i = document.createElement("span");
        this.appendChild(i);
        i.innerHTML = `<span contenteditable="true"></span>:<span contenteditable="true"></span>:<span contenteditable="true"></span>.<span contenteditable="true"></span>`;
        const 加减 = this.input;
        加减.type = "number";
        this.appendChild(加减);
        加减.max = this._max.toString();
        加减.min = this._min.toString();
        加减.value = this._value.toString();
        const [h, m, s, ss] = i.querySelectorAll("span");

        h.onfocus = () => {
            加减.step = "3600000";
        };
        m.onfocus = () => {
            加减.step = "60000";
        };
        s.onfocus = () => {
            加减.step = "1000";
        };
        ss.onfocus = () => {
            加减.step = "1";
        };

        h.oninput = () => {
            r(h, "0", Number.POSITIVE_INFINITY);
        };
        m.oninput = () => {
            r(m, "00", 60);
        };
        s.oninput = () => {
            r(s, "00", 60);
        };
        ss.oninput = () => {
            r(ss, "000", 1000);
        };
        /**
         *
         * @param {HTMLSpanElement} el
         * @param {string} dv
         * @param {number} max
         */
        const r = (el: HTMLSpanElement, dv: string, max: number) => {
            if (Number.isNaN(Number(el.innerText))) {
                el.innerText = "";
            } else {
                let tf = false;
                switch (el) {
                    case ss:
                        tf = 0 <= this.n(ss) && this.n(ss) < max;
                        break;
                    case s:
                        tf = 0 <= this.n(s) && this.n(s) < max;
                        break;
                    case m:
                        tf = 0 <= this.n(m) && this.n(m) < max;
                        break;
                    case h:
                        tf = 0 <= this.n(h) && this.n(h) < max;
                        break;
                }
                if (tf) {
                    if (
                        this.sum_value() > this._max ||
                        this.sum_value() < this._min
                    ) {
                        el.innerText = dv;
                        加减.value = this.sum_value().toString();
                    } else {
                        this._value = this.sum_value();
                        加减.value = this.sum_value().toString();
                    }
                } else {
                    el.innerText = dv;
                    加减.value = this.sum_value().toString();
                }
            }
        };

        加减.oninput = () => {
            this.set_value(Number(加减.value));
            this.dispatchEvent(new Event("input"));
        };
    }

    n(el: HTMLSpanElement) {
        return Number(el.innerText);
    }

    set_value(v: number) {
        this._value = v;
        const tn = v % 1000;
        const sn = Math.trunc(v / 1000);
        const mn = Math.trunc(sn / 60);
        const hn = Math.trunc(mn / 60);
        const [h, m, s, ss] =
            // @ts-ignore
            this.querySelector("span").querySelectorAll("span");
        h.innerText = String(hn);
        m.innerText = String(mn - 60 * hn);
        s.innerText = String(sn - 60 * mn).padStart(2, "0");
        ss.innerText = String(tn).padStart(3, "0");
    }

    sum_value() {
        const [h, m, s, ss] =
            // @ts-ignore
            this.querySelector("span").querySelectorAll("span");
        const [hn, mn, sn, ssn] = [h, m, s, ss].map((v) => this.n(v));
        const v = hn * 3600000 + mn * 60000 + sn * 1000 + ssn;
        return v;
    }

    get value() {
        return this._value;
    }
    set value(v: number) {
        this.set_value(v);
        this.setAttribute("value", String(v));
        this.input.value = v.toString();
    }
    get max() {
        return this._max;
    }
    set max(x) {
        const v = Number(x) || 0;
        this._max = v;
        this.setAttribute("max", String(v));
        this.input.max = v.toString();
    }
    get min() {
        return this._min;
    }
    set min(x) {
        const v = Number(x) || 0;
        this._max = v;
        this.setAttribute("min", String(v));
        this.input.min = v.toString();
    }
    get gv() {
        return this.value;
    }
    sv(v: number) {
        this.value = v;
    }
    set svc(v: number) {
        this.value = v;
    }
}

window.customElements.define("time-i", time_i);

const mEl = view().attr({ id: "m" }).addInto();
const statusEl = txt().attr({ id: "record_status", role: "status" });
statusEl.el.setAttribute("aria-live", "polite");
const retryEl = button(t("다시 시도"))
    .attr({ id: "record_retry", type: "button" })
    .on("click", () => {
        retryAction?.();
    });

function setRecorderState(state: RecorderState, detail = "") {
    recorderState = state;
    document.body.dataset.recorderState = state;
    saveEl.el.disabled = state === "processing" || !isTsOk;
    const labels: Record<RecorderState, string> = {
        ready: t("준비"),
        recording: t("녹화 중"),
        paused: t("일시정지"),
        processing: t("처리 중"),
        saved: t("저장됨"),
        cancelled: t("저장 취소됨"),
        error: t("오류"),
    };
    statusEl.el.textContent = detail
        ? `${labels[state]} · ${detail}`
        : labels[state];
}

const recDot = view().class("rec-dot");
const startStop = button()
    .add(iconEl("start_record").style({ filter: "none" }))
    .attr({ id: "start_stop", title: "녹화 시작/중지" })
    .on("click", () => {
        if (sS) {
            if (!recorder || !stream) return;
            cancelled = false;
            if (!recordSysAudio) {
                // 下面是用来移除系统音频
                const audioTracks = stream.getAudioTracks();
                for (const i of audioTracks) {
                    i.stop();
                    stream.removeTrack(i);
                }
            }
            for (const a of audioStreamS.values()) {
                for (const i of a.getAudioTracks()) stream.addTrack(i);
            }
            crashReset = true;
            recorder.start(2000);
            格式El.el.style({ display: "none" });
            type = 格式El.el.gv as mimeType;
            startStop
                .clear()
                .add(iconEl("stop_record").style({ filter: "none" }));
            recDot.el.classList.remove("paused");
            settingEl
                .clear()
                .add([recDot, startStop, pauseBtn, timeEl, statusEl, cancelEl]);
            pTime();
            timeInterval = window.setInterval(getTime, 500);
            sS = false;
            setRecorderState("recording");
            renderSend("recordStart", []);

            c();
        } else {
            stop = true;
            setRecorderState("processing", t("녹화를 정리하는 중입니다."));
            if (timeInterval !== undefined) {
                clearInterval(timeInterval);
                timeInterval = undefined;
            }
            recorder.stop();
            for (const i of stream.getTracks()) {
                i.stop();
            }
            for (const s of audioStreamS.values())
                for (const t of s.getTracks()) {
                    t.stop();
                }

            pTime();
        }
    });

const timeEl = txt().class(Class.mono);
let timeInterval: number | undefined;
const togglePause = () => {
    if (!recorder || recorder.state === "inactive") return;
    if (recorder.state === "recording") {
        recorder.pause();
        pTime();
    } else if (recorder.state === "paused") {
        recorder.resume();
        pTime();
    }
    recDot.el.classList.toggle("paused", recorder.state === "paused");
    setRecorderState(recorder.state === "paused" ? "paused" : "recording");
};
const pauseBtn = iconBEl("play_pause")
    .attr({ title: "일시정지/재개" })
    .on("click", () => togglePause());

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (
            recorderState === "recording" ||
            recorderState === "paused" ||
            recorderState === "processing"
        )
            return;
        renderSend("windowClose", []);
    } else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        startStop.el.click();
    }
});
const cancelEl = iconBEl("close")
    .attr({ title: "녹화 취소" })
    .on("click", () => {
        cancelled = true;
        setRecorderState("cancelled", t("녹화를 취소했습니다."));
        if (timeInterval !== undefined) clearInterval(timeInterval);
        if (recorder && recorder.state !== "inactive") recorder.stop();
        if (stream)
            for (const i of stream.getTracks()) {
                i.stop();
            }
        for (const s of audioStreamS.values())
            for (const t of s.getTracks()) {
                t.stop();
            }

        try {
            if (crashPath) fs.rmSync(crashPath, { force: true });
        } catch {}
        renderSend("recordStop", []);
        renderSend("windowClose", []);
    });

const cameraEl = check("camera")
    .attr({ id: "camera", title: "카메라 표시" })
    .on("click", () => {
        try {
            cameraStreamF(cameraEl.gv);
            store.set("录屏.摄像头.开启", cameraEl.gv);
        } catch (e) {
            console.error(e);
        }
    });
const micList = view("y");
const audioSelect = dynamicSelect();

const 格式El = dynamicSelect();
const types: mimeType[] = [
    "mp4",
    "webm",
    "gif",
    "mkv",
    "mov",
    "ts",
    "mpeg",
    "flv",
];
格式El.setList(types.map((i) => ({ value: i, text: i })));
格式El.el.el.value = type;
格式El.el.attr({ title: "출력 형식" });
audioSelect.el.attr({ title: "마이크 입력" });

const settingEl = view("x")
    .attr({ id: "rec_setting" })
    .add([
        startStop,
        statusEl,
        retryEl,
        ele("details")
            .attr({ id: "rec_options" })
            .add([
                ele("summary").add(t("설정")),
                view("x")
                    .class("rec-options-row")
                    .add([格式El.el, audioSelect.el, micList, cameraEl]),
            ]),
        cancelEl,
    ])
    .addInto();

const waitTip = ele("dialog")
    .add([
        p(t("等待录屏权限和录音权限获取")),
        p(t("或者在系统设置手动批准权限")),
    ])
    .addInto();
waitTip.el.showModal();

const videoPEl = view().attr({ id: "video" }).addInto(mEl);
const vpEl = view().attr({ id: "v_p" }).addInto(videoPEl);
const videoEl = ele("video").style({ maxWidth: "none" }).addInto(vpEl).el;
const segEl = view().attr({ id: "seg" }).addInto(vpEl);

videoEl.onpause = () => {
    playEl.sv(true);
};
videoEl.onplay = () => {
    playEl.sv(false);
};

videoEl.ontimeupdate = () => {
    if (!editting || exportedPlayback) return;
    tNtEl.sv(tFormat(getPlayT() - tStartEl.gv));
    if (getPlayT() > tEndEl.gv) {
        videoEl.pause();
        tNtEl.sv(tTEl.gv);
    }
    jdtEl.sv(getPlayT());
};

videoEl.onended = () => {
    if (exportedPlayback) {
        playEl.sv(true);
        return;
    }
    if (playName < nameT.length - 1) {
        playName++;
        setVideo(playName);
        videoEl.play();
    } else {
        tNtEl.sv(tTEl.gv);
        jdtEl.svc = Number(jdtEl.el.max);
    }
};

const sEl = view().attr({ id: "s" }).class(Class.smallSize).addInto(mEl);

const jdtEl = input("range")
    .attr({ id: "jdt" })
    .bindGet((el) => Number(el.value))
    .bindSet((v: number, el) => {
        el.value = String(v);
    })
    .on("input", () => {
        setPlayT(jdtEl.gv);
    });

const tStartEl = document.createElement("time-i") as time_i;
tStartEl.id = "t_start";
const tNtEl = txt()
    .attr({ id: "t_nt" })
    .bindSet((v: string, el) => {
        el.innerText = v;
    });
const tTEl = txt()
    .attr({ id: "t_t" })
    .bindSet((v: string, el) => {
        el.innerText = v;
        el.setAttribute("t", v);
    })
    .bindGet((el) => {
        return el.getAttribute("t") ?? "";
    });
const tEndEl = document.createElement("time-i") as time_i;
tEndEl.id = "t_end";

tStartEl.oninput = () => {
    trimChanged = true;
    const t = tStartEl.gv / 1000;
    videoEl.currentTime = tEndEl.min = t;
    jdtEl.el.min = String(t);
    tTEl.sv(tFormat(tEndEl.gv - tStartEl.gv));
};
tEndEl.oninput = () => {
    trimChanged = true;
    const t = tEndEl.gv / 1000;
    videoEl.currentTime = tStartEl.max = t;
    jdtEl.el.max = String(t);
    tTEl.sv(tFormat(tEndEl.gv - tStartEl.gv));
};

const playEl = check("play", [iconEl("recume"), iconEl("pause")])
    .attr({ id: "v_play" })
    .style({
        display: "inline-flex",
    })
    .on("change", () => {
        if (playEl.gv) {
            videoEl.pause();
        } else {
            videoPlay();
        }
    });
const setEndEl = iconBEl("right").attr({ id: "b_t_end" }).on("click", setEnd);

function setEnd() {
    const last = timeL.at(-1) as number;
    const max = last - timeL[0];
    jdtEl.attr({ max: String(max) });
    tEndEl.svc = tStartEl.max = tEndEl.max = last - timeL[0];
}

const saveEl = iconBEl("save")
    .add(t("저장"))
    .attr({ id: "save", disabled: true })
    .on("click", () => save());

const proEl = (id: string) =>
    view()
        .class("pro_p")
        .add(
            view()
                .class("pro")
                .attr({ id: `pr_${id}` }),
        );

const prTs = proEl("ts");
const prClip = proEl("clip");
const prJoin = proEl("join");

const prEl = {
    ts: prTs,
    clip: prClip,
    join: prJoin,
};

updataPrEl(ffprocess);

const logP = ele("details").attr({ id: "log_p" }).class("hide_log");
const logText = ele("textarea").attr({ id: "log", cols: 30, rows: 10 });
logP.add([ele("summary").add(t("FFmpeg 错误日志")), logText]);

const editDetails = ele("details")
    .attr({ id: "record_edit_details" })
    .add([
        ele("summary").add(t("구간 편집")),
        view()
            .class("record-detail-content")
            .add([
                jdtEl,
                view("x")
                    .class("record-time-row")
                    .add([
                        t("开始时间："),
                        tStartEl,
                        tNtEl,
                        " / ",
                        tTEl,
                        playEl,
                        t("结束时间："),
                        tEndEl,
                        setEndEl,
                    ]),
            ]),
    ]);
const processingDetails = ele("details")
    .attr({ id: "record_processing_details" })
    .add([
        ele("summary").add(t("처리 상세")),
        view().class("record-detail-content").add([prTs, prClip, prJoin, logP]),
    ]);

sEl.add([saveEl, editDetails, processingDetails]);

const devices = await navigator.mediaDevices.enumerateDevices();
const audioL = devices.filter((i) => i.kind === "audioinput");
const canSysAudio = store.get("录屏.音频.启用系统内录");
const audioRmb = store.get("录屏.音频.设备列表");
let recordSysAudio = audioRmb.includes(sysAudioName);

async function setMicStream(id: string) {
    for (const s of audioStreamS.values())
        for (const t of s.getTracks()) {
            t.stop();
        }
    audioStreamS.clear();
    if (id) {
        const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: id },
            video: false,
        });
        audioStreamS.set(id, audioStream);
    }
}

const audioDeviceL = audioL.map((i) => ({
    value: i.deviceId,
    text: i.label || i.deviceId,
}));
audioDeviceL.unshift({ value: "", text: t("마이크 없음") });
audioSelect.setList(audioDeviceL);
const rememberedMic = audioL.find((i) => audioRmb.includes(i.deviceId));
audioSelect.el.sv(rememberedMic?.deviceId ?? "");
audioSelect.el.on("change", async () => {
    await setMicStream(audioSelect.el.gv);
    store.set("录屏.音频.设备列表", getAudioNames());
});
if (rememberedMic) await setMicStream(rememberedMic.deviceId);

if (canSysAudio) {
    const sysAudioEl = check("mic").attr({ title: "시스템 오디오 녹음" });
    sysAudioEl.on("input", (_, el) => {
        recordSysAudio = el.gv;
        store.set("录屏.音频.设备列表", getAudioNames());
    });
    sysAudioEl.sv(recordSysAudio);
    micList.add(sysAudioEl);
} else if (audioL.length === 0) {
    audioSelect.el.style({ display: "none" });
}

if (store.get("录屏.摄像头.开启")) {
    try {
        cameraStreamF(true);
        cameraEl.sv(true);
    } catch (e) {
        console.error(e);
    }
}

document.body.onresize = resize;

function recordFatal(message: string) {
    sS = false;
    if (stream) {
        for (const track of stream.getTracks()) track.stop();
    }
    startStop.style({ opacity: "0.4", pointerEvents: "none" });
    retryAction = () => {
        startStop.style({ opacity: "1", pointerEvents: "auto" });
        setRecorderState("ready", t("화면을 다시 준비하는 중입니다."));
        renderSend("recorderReady", []);
    };
    setRecorderState("error", message);
    renderSend("dialogMessage", [{ message, buttons: [t("확인")] }]);
    renderSend("recordStop", []);
}

renderOn("recordInitError", () => {
    waitTip.remove();
    recordFatal(
        t(
            "녹화할 화면을 준비하지 못했습니다. 화면 공유 권한을 확인한 뒤 다시 시도하세요.",
        ),
    );
});

renderOn("recordInit", async ([sourceId, r, screen_w, screen_h]) => {
    waitTip.remove();
    rect = r;
    sS = true;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: canSysAudio // 可能会导致应用崩溃，所以添加这个设置
                ? {
                      // @ts-ignore
                      mandatory: {
                          chromeMediaSource: "desktop",
                      },
                  }
                : false,
            video: {
                // @ts-ignore
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: sourceId,
                    minWidth: screen_w,
                    minHeight: screen_h,
                },
            },
        });
    } catch (e) {
        console.error(e);
    }
    if (!stream) {
        recordFatal(
            t(
                "화면 녹화 권한을 얻지 못했습니다. 권한을 허용한 뒤 다시 시도하세요.",
            ),
        );
        return;
    }
    retryAction = undefined;
    startStop.style({ opacity: "1", pointerEvents: "auto" });
    setRecorderState("ready", t("녹화를 시작할 수 있습니다."));
    let chunks: Blob[] = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "";
    try {
        recorder = new MediaRecorder(
            stream,
            mimeType
                ? {
                      videoBitsPerSecond:
                          store.get("录屏.视频比特率") * 10 ** 6,
                      mimeType,
                  }
                : {
                      videoBitsPerSecond:
                          store.get("录屏.视频比特率") * 10 ** 6,
                  },
        );
    } catch (e) {
        console.error(e);
        recordFatal(t("녹화를 초기화하지 못했습니다."));
        return;
    }
    recorder.ondataavailable = async (e) => {
        chunks.push(e.data);
        try {
            const buf = Buffer.from(await e.data.arrayBuffer());
            if (crashReset) {
                fs.writeFileSync(crashPath, buf);
                crashReset = false;
            } else fs.appendFileSync(crashPath, buf);
        } catch {}
    };

    const fileName = String(Date.now());
    tmpPath = path.join(
        renderSendSync("userDataPath", []),
        "recording-recovery",
        fileName,
    );
    output = path.join(tmpPath, "output");
    crashPath = path.join(tmpPath, "crash.webm");
    crashReset = true;
    try {
        fs.mkdirSync(output, { recursive: true });
    } catch (e) {
        console.error(e);
        recordFatal(t("임시 녹화 폴더를 만들지 못했습니다."));
        return;
    }
    let clipName = 0;
    function save(f: () => void) {
        const b = new Blob(chunks, { type: "video/webm" });
        const reader = new FileReader();
        reader.readAsArrayBuffer(b);
        reader.onloadend = (_e) => {
            const baseName = String(clipName);
            const baseName2 = `${baseName}.${type}`;
            const p = path.join(tmpPath, baseName);
            const crop =
                type === "gif" && store.get("录屏.转换.高质量gif")
                    ? `[in]crop=${rect[2]}:${rect[3]}:${rect[0]}:${rect[1]},split[split1][split2];[split1]palettegen=stats_mode=single[pal];[split2][pal]paletteuse=new=1`
                    : `crop=${rect[2]}:${rect[3]}:${rect[0]}:${rect[1]}`;
            const args = ["-i", p, "-vf", crop, path.join(output, baseName2)];
            fs.writeFile(p, Buffer.from(reader.result as string), (_err) => {
                runFfmpeg("ts", clipName, args);
                chunks = [];
                if (f) f();
                clipName++;
            });
        };
    }

    recorder.onstop = () => {
        (nameT.at(-1) as (typeof nameT)[0]).e = getT();
        if (cancelled) return;
        if (stop) {
            renderSend("recordStop", []);
            save(() => {
                try {
                    fs.rmSync(crashPath, { force: true });
                } catch {}
                showControl();
            });
        } else {
            save(() => {});
            crashReset = true;
            recorder.start(2000);
            nameT.push({ s: getT(), e: Number.NaN });
        }
    };

    if (store.get("录屏.自动录制") === true) {
        let t = store.get("录屏.自动录制延时");
        function d() {
            if (recorder.state !== "inactive") return;
            setTime(String(t));
            setTimeout(() => {
                if (t === 0) {
                    startStop.el.click();
                } else {
                    t--;
                    d();
                }
            }, 1000);
        }
        d();
    }
});

renderOn("recordStartStop", () => {
    startStop.el.click();
});

renderOn("recordSavePathReturn", ([result]) => {
    if (result.status === "selected") {
        void performSave(result.path);
    } else if (result.status === "cancelled") {
        retryAction = () => void save();
        setRecorderState("cancelled", t("파일은 저장되지 않았습니다."));
    } else {
        retryAction = () => void save();
        setRecorderState("error", result.error);
    }
});

renderOn("recordState", ([s]) => {
    if (s === "stop") {
        startStop.el.click();
    } else if (s === "pause") {
        togglePause();
    }
});

renderSend("recorderReady", []);
