export { t, tLan, lan, getLans, getLanName };
import { matchFitLan } from "xtranslator";
const path = require("node:path") as typeof import("path");
const fs = require("node:fs") as typeof import("fs");
const rootDir = (() => {
    try {
        const rootDirL = __dirname.split(path.sep);
        const outDir = rootDirL.lastIndexOf("out");
        const dir = path.join(
            rootDirL.slice(0, outDir).join(path.sep),
            "./lib/translate",
        );
        if (fs.existsSync(dir)) return dir;
    } catch {}
    try {
        const dir = path.join(process.cwd(), "lib/translate");
        if (fs.existsSync(dir)) return dir;
    } catch {}
    return path.join("lib", "translate");
})();

function loadJson<T>(file: string, fallback: T): T {
    try {
        return require(path.join(rootDir, file)) as T;
    } catch {
        return fallback;
    }
}

const ignore = loadJson("./ignore.json", [] as string[]);

let language = "";
// Values already translated into the active language; lets t() stay
// idempotent when callers pass translated text (dkh translates on add).
let translatedValues: Set<string> | undefined;

/**
 * 获取可用语言
 * @param {string} lan 语言
 * @returns 仅限支持的语言
 */
function parseLan(lan: string) {
    const lans = getLans();
    return matchFitLan(lan, lans) ?? "zh-HANS";
}

/**
 * 切换语言
 * @param {string} lan 语言
 */
function lan(lan: string | undefined) {
    language = parseLan(lan ?? "");
    if (language !== "zh-HANS") {
        l = loadJson(`./${language}.json`, {});
        translatedValues = new Set(Object.values(l));
    } else {
        translatedValues = undefined;
    }
}

/**
 * 翻译
 * @param {string} text 原文字
 * @returns 翻译后的文字
 */
function t(text: string) {
    if (!language) return text;
    if (language === "zh-HANS") return text;
    return autoSt(text, l);
}
function st(_text: string, map: typeof l) {
    if (!_text.trim()) return null;
    if (ignore.includes(_text)) return null;
    const text = _text.trim();
    const id = source[text];
    if (!id) {
        if (translatedValues?.has(text)) return text;
        console.log(`%c"${text}":"",`, "color:#f00;background:#fdd");
        return null;
    }
    const t = map[id];
    if (!t) {
        console.log(
            `%c${id}%c: ${text}`,
            "color:#00f;background:#ddf",
            "",
        );
        return null;
    }
    return t;
}
function autoSt(_text: string, map: typeof l): string {
    if (!_text.trim()) return _text;
    let text = _text.trim();
    let e = "";
    if (text.endsWith("：")) {
        text = text.slice(0, -1);
        e = "：";
    }
    const t = st(text, map);
    if (!t) return text;
    return e ? `${t}${autoSt("：", map)}` : t;
}
function tLan(text: string, lan: string) {
    if (parseLan(lan) === "zh-HANS") return text;
    const map = loadJson(`./${parseLan(lan)}.json`, {} as typeof l);
    return autoSt(text, map);
}

const source = loadJson("./source.json", {} as Record<string, string>);
let l: Record<string, string>;

function getLans() {
    let lans: string[] = [];
    try {
        lans = fs
            .readdirSync(rootDir)
            .filter(
                (file) =>
                    file.endsWith(".json") &&
                    !file.startsWith("source") &&
                    !file.startsWith(".") &&
                    file !== "ignore.json",
            )
            .map((l) => l.replace(".json", ""));
    } catch {}
    return ["zh-HANS"].concat(lans);
}

function getLanName(lan: string) {
    return {
        ar: "عربي",
        en: "English",
        ko: "한국어",
        eo: "Esperanto",
        es: "Español",
        fr: "Français",
        ru: "Русский",
        "zh-HANS": "简体中文",
        "zh-HANT": "繁体中文",
    }[lan];
}
