import { button, ele, initDKH, p, select, view } from "dkh-ui";
import type * as Electron from "electron";
import store from "../../../lib/store/renderStore";
import { lan, t } from "../../../lib/translate/translate";
import { labLangFor, setLabLang } from "../lib/labText";
const { ipcRenderer, clipboard } = require("electron") as typeof Electron;
lan(store.get("语言.语言"));
setLabLang(labLangFor(store.get("语言.语言")));
initDKH({ pureStyle: true });
document.title = `OpenCapture · ${t("번역")}`;
document.body.style.cssText =
    "margin:0;padding:24px;background:#f7f6f2;color:#27342b;font:14px 'Segoe UI','Malgun Gothic',sans-serif";
const container = view("y").style({ gap: "16px" }).addInto();
p(t("영어 ↔ 한국어 · 로컬 번역")).addInto(container);
const row = view("x").style({ gap: "12px" }).addInto(container);
const from = select([
    { value: "auto", name: t("언어 자동 감지") },
    { value: "en", name: t("영어") },
    { value: "ko", name: t("한국어") },
]).addInto(row);
const to = select([
    { value: "ko", name: t("한국어") },
    { value: "en", name: t("영어") },
]).addInto(row);
const input = ele("textarea")
    .attr({
        ariaLabel: t("번역할 텍스트"),
        placeholder: t("번역할 내용을 입력하세요"),
    })
    .style({
        minHeight: "180px",
        padding: "16px",
        border: "1px solid #d8ded3",
        borderRadius: "10px",
        resize: "vertical",
    })
    .addInto(container);
const result = ele("div")
    .attr({ role: "status", ariaLive: "polite" })
    .style({
        minHeight: "100px",
        whiteSpace: "pre-wrap",
        padding: "16px",
        background: "white",
        borderRadius: "10px",
    })
    .addInto(container);
const translateButton = button(t("번역"))
    .style({
        padding: "12px",
        background: "#dc7452",
        color: "white",
        borderRadius: "8px",
    })
    .addInto(container);
translateButton.on("click", async () => {
    const text = input.el.value.trim();
    if (!text) return;
    translateButton.el.disabled = true;
    result.el.textContent = t("번역 중…");
    try {
        const output: string[] = await ipcRenderer.invoke("oc:translate", {
            texts: [text],
            from: from.el.value,
            to: to.el.value,
        });
        result.el.textContent = output.join("\n");
    } catch (error) {
        result.el.textContent = `${error instanceof Error ? error.message : String(error)}\n${t("시작 화면의 번역 탭에서 모델 설치와 API 연결을 확인하세요.")}`;
    } finally {
        translateButton.el.disabled = false;
    }
});
button(t("결과 복사"))
    .on("click", () => {
        clipboard.writeText(result.el.textContent || "");
    })
    .addInto(container);
input.el.value = new URLSearchParams(location.search).get("text") || "";
if (input.el.value.trim()) translateButton.el.click();
