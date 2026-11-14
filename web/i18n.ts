import {
    type LabLang,
    getLabLang,
    lt,
    setLabDict,
    setLabLang,
} from "../src/renderer/lib/labText";
import { en } from "../src/renderer/lib/labText.en";

export { getLabLang, lt };
export type { LabLang };

const LANG_KEY = "opencapture:lab:lang";

export function initLabLang(): LabLang {
    const param = new URLSearchParams(location.search).get("lang");
    const stored = localStorage.getItem(LANG_KEY);
    const lang: LabLang =
        param === "ko" || param === "en"
            ? param
            : stored === "ko"
              ? "ko"
              : "en";
    setLabLang(lang);
    setLabDict("en", en);
    document.documentElement.lang = lang === "ko" ? "ko" : "en";
    return lang;
}

export function switchLabLang(lang: LabLang) {
    if (lang === getLabLang()) return;
    localStorage.setItem(LANG_KEY, lang);
    location.reload();
}
