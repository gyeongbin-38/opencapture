import xtranslator from "xtranslator";
import type { setting } from "../../ShareTypes";

export function loadTranslator(
    store: typeof import("../../../lib/store/renderStore")["default"],
) {
    const { ipcRenderer } = require("electron") as typeof import("electron");
    return (texts: string[]): Promise<string[]> => {
        const language = store.get("屏幕翻译.语言");
        return ipcRenderer.invoke("oc:translate", {
            texts,
            from: language.from || "auto",
            to: language.to || "ko",
        });
    };
}

export function getTranslators(
    store: typeof import("../../../lib/store/renderStore")["default"],
    settingItem: setting["翻译"]["翻译器"][0],
): InstanceType<(typeof xtranslator)["Translator"]> | undefined {
    const e =
        xtranslator.es[
            settingItem.type === "llm" ? "chatgpt" : settingItem.type
        ]();
    if (e) {
        if (settingItem.type === "llm") {
            const model = store
                .get("AI.在线模型")
                .find((i) => i.name === settingItem.keys.name);
            if (!model) {
                return;
            }
            // @ts-ignore
            e.setKeys({
                url: new URL("chat/completions", model.url).toString(),
                key: model.key,
                config: {
                    model: model.model,
                },
            });
            // @ts-ignore
        } else e.setKeys(settingItem.keys);
        return e;
    }
    return undefined;
}
