import { addClass, addStyle, initDKH, view } from "dkh-ui";
import { matchFitLan } from "xtranslator";
import { renderSendSync } from "../../../lib/ipc";
import { getLans, lan, t } from "../../../lib/translate/translate";
import type { RawIconType } from "../../iconTypes";
import { labLangFor, setLabDict, setLabLang } from "../lib/labText";
import { en as labEn } from "../lib/labText.en";

function initStyle(
    store: typeof import("../../../lib/store/renderStore")["default"],
) {
    if (!store.get("dev")) addStyle({ "[data-dev]": { display: "none" } });
    function setCSSVar(name: string, value: string) {
        if (value) document.documentElement.style.setProperty(name, value);
    }
    const 模糊 = store.get("全局.模糊");
    if (模糊 !== 0) {
        setCSSVar("--blur", `blur(${模糊}px)`);
    } else {
        setCSSVar("--blur", "none");
    }

    setCSSVar("--alpha", `${store.get("全局.不透明度") * 100}%`);

    const theme = store.get("全局.主题");
    setCSSVar("--bar-bg0", theme.light.barbg);
    setCSSVar("--bg", theme.light.bg);
    setCSSVar("--emphasis-color", theme.light.emphasis);
    setCSSVar("--d-bar-bg0", theme.dark.barbg);
    setCSSVar("--d-bg", theme.dark.bg);
    setCSSVar("--d-emphasis-color", theme.dark.emphasis);
    setCSSVar("--font-color", theme.light.fontColor);
    setCSSVar("--d-font-color", theme.dark.fontColor);
    setCSSVar("--font-color-emphasis", theme.light.fontInEmphasis);
    setCSSVar("--d-font-color-emphasis", theme.dark.fontInEmphasis);
    setCSSVar("--icon-color", theme.light.iconColor);
    setCSSVar("--d-icon-color", theme.dark.iconColor);

    function checkIconColor(c: string) {
        return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 8 9 19 4 14'></polyline></svg>`)}")`;
    }

    setCSSVar("--check-icon", checkIconColor(theme.light.fontInEmphasis));
    setCSSVar("--d-check-icon", checkIconColor(theme.dark.fontInEmphasis));

    const 字体 = store.get("字体");
    setCSSVar("--main-font", 字体.主要字体);
    setCSSVar("--monospace", 字体.等宽字体 || monoFont.join(","));

    const activeLanguage = renderSendSync("active_language", []) ?? "zh-HANS";
    lan(activeLanguage);
    const resolvedLan = matchFitLan(activeLanguage, getLans()) ?? "zh-HANS";
    document.documentElement.lang = resolvedLan;
    document.documentElement.dir = resolvedLan === "ar" ? "rtl" : "ltr";
    setLabDict("en", labEn);
    setLabLang(labLangFor(activeLanguage));

    initDKH({
        pureStyle: true,
        attrMap: {
            title: (s: string, el) => {
                const title = t(s);
                el.setAttribute("data-title", title);
                el.setAttribute("aria-label", title);
            },
        },
    });

    const topTip = view()
        .class(Class.glassBar)
        .style({
            position: "fixed",
            pointerEvents: "none",
            padding: "4px 9px",
            borderRadius: "8px",
            width: "auto",
            height: "auto",
            maxWidth: "min(320px, calc(100vw - 24px))",
            fontSize: "12px",
            lineHeight: "1.5",
            letterSpacing: "0.01em",
            fontFamily: "var(--main-font)",
            zIndex: 9999,
            transition: "opacity .15s ease",
            whiteSpace: "pre",
            boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        })
        .addInto()
        .bindSet((v: string, el) => {
            const parts = v.split(" · ");
            el.replaceChildren(document.createTextNode(parts[0]));
            for (const part of parts.slice(1)) {
                const key = document.createElement("span");
                key.textContent = part;
                key.style.cssText = "margin-left:8px;opacity:.6";
                el.append(key);
            }
        });

    let tipTimer = 0;
    window.addEventListener("pointerover", (e) => {
        const el = e.target as HTMLElement;
        const tEl = el.closest("[data-title]");
        window.clearTimeout(tipTimer);
        const title = tEl?.getAttribute("data-title");
        if (!tEl || !title?.trim()) {
            topTip.style({ opacity: 0 });
            return;
        }
        tipTimer = window.setTimeout(() => {
            const rect = tEl.getBoundingClientRect();
            topTip.sv(title);
            const tw = topTip.el.offsetWidth;
            const th = topTip.el.offsetHeight;
            const ow = window.innerWidth;
            const oh = window.innerHeight;
            const left = Math.max(
                0,
                Math.min(rect.left + rect.width / 2 - tw / 2, ow - tw),
            );
            let top = rect.bottom + 6;
            if (top > oh - th) {
                top = rect.top - th - 6;
            }
            topTip.style({
                opacity: 1,
                left: `${left}px`,
                top: `${Math.max(Math.min(top, oh - th), 0)}px`,
            });
        }, 320);
    });
}

function getImgUrl(name: RawIconType) {
    return new URL(`../assets/icons/${name}`, import.meta.url).href;
}

function setTitle(t: string) {
    document.title = `OpenCapture ${t}`;
    // todo 国际化
}

const cssColor = {
    font: {
        f0: cssVarR("font-color"),
        light: cssVarR("font-color-l"),
        llight: cssVarR("font-color-ll"),
        main: cssVarR("font-color-emphasis"),
    },
    f: cssVarR("m-color-f"),
    ff: cssVarR("m-color-ff"),
    fff: cssVarR("m-color-fff"),
    b: cssVarR("m-color-b"),
    bb: cssVarR("m-color-bb"),
    bbb: cssVarR("m-color-bbb"),
    main: cssVarR("m-color"),
    bg: cssVarR("bg"),
};

const Class = {
    gap: addClass({ gap: cssVar("o-padding") }, {}),
    group: "group",
    smallSize: "small-size",
    mono: addClass({ fontFamily: cssVar("monospace") }, {}),
    click: addClass(
        { transition: cssVar("transition"), cursor: "pointer" },
        { "&:active": { transform: "var(--button-active)" } },
    ),
    click1: addClass(
        { transition: cssVar("transition"), cursor: "pointer" },
        {},
    ),
    hover: addClass(
        {},
        { "&:hover": { backgroundColor: "var(--hover-color)" } },
    ),
    button: "",
    transition: addClass({ transition: cssVar("transition") }, {}),
    deco: addClass(
        {
            borderRadius: cssVarR("border-radius"),
            outline: `1px solid ${cssVarR("border-color")}`,
            outlineOffset: "-1px",
        },
        {},
    ),
    noDeco: addClass(
        {
            outline: "none",
        },
        {},
    ),
    textItem: addClass(
        {
            paddingInline: "var(--o-padding)",
        },
        {},
    ),
    glassBar: "bar",
    /** 背景是屏幕 */
    screenBar: addClass(
        {
            borderRadius: cssVarR("border-radius"),
            backgroundColor: cssColor.bg,
        },
        {
            "& :is(button, *:has(> .icon), input, .deco)": {
                outline: "none",
            },
        },
    ),
    hide: addClass(
        {
            opacity: "0",
            pointerEvents: "none",
        },
        {},
    ),
};

Class.button = `${Class.click} ${Class.hover}`;

const monoFont = [
    "Cascadia Code Light",
    "Courier New",
    "Courier",
    "Lucida Console",
    "Monaco",
    "Liberation Mono",
    "Roboto Mono",
];

function cssVar(x: "transition" | "o-padding" | "monospace" | "b-button") {
    return cssVarR(x);
}
function cssVarR(x: string) {
    return `var(--${x})`;
}

export { initStyle, getImgUrl, setTitle, Class, cssColor, cssVar, monoFont };
