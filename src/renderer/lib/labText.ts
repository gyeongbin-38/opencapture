export type LabLang = string;

let lang: LabLang = "ko";
const dicts: Record<string, Record<string, string>> = {};
const missing = new Set<string>();

export function setLabLang(next: LabLang) {
    lang = next;
}

export function getLabLang() {
    return lang;
}

export function setLabDict(language: string, dict: Record<string, string>) {
    dicts[language] = dict;
    missing.clear();
}

/**
 * Map an app UI language to a lab language. Korean is built in; any other
 * language uses its dictionary when present and falls back to English.
 */
export function labLangFor(appLan: string | undefined): LabLang {
    if (appLan === "ko") return "ko";
    if (appLan && dicts[appLan]) return appLan;
    return "en";
}

/**
 * Capture-lab bilingual text. `ko` is the canonical Korean copy; `en` is an
 * inline English override for strings with interpolated values that cannot be
 * dictionary keys. Languages without a dictionary fall back to English.
 */
export function lt(ko: string, en?: string): string {
    if (lang === "ko") return ko;
    if (lang === "en" && en !== undefined) return en;
    const hit = dicts[lang]?.[ko];
    if (hit !== undefined) return hit;
    if (en !== undefined) return en;
    const enHit = dicts.en?.[ko];
    if (enHit !== undefined) return enHit;
    const key = `${lang}:${ko}`;
    if (!missing.has(key)) {
        missing.add(key);
        console.warn(`[labText] missing ${lang} translation: "${ko}"`);
    }
    return ko;
}
