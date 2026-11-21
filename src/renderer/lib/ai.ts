type aiData = {
    role: "system" | "user" | "assistant";
    content: {
        text: string;
        img?: string;
    };
};

type chatgptm = {
    role: "system" | "user" | "assistant";
    content:
        | string
        | [
              { type: "text"; text: string },
              { type: "image_url"; image_url: { url: string } },
          ];
};

function toChatgptm(data: aiData): chatgptm {
    const { role, content } = data;
    if (content.img) {
        return {
            role,
            content: [
                { type: "text", text: content.text },
                { type: "image_url", image_url: { url: content.img } },
            ],
        };
    }
    return {
        role,
        content: content.text,
    };
}

function runAI(
    message: aiData[],
    x: {
        config: Record<string, unknown>;
        url: string;
        key: string;
        model: string;
    },
) {
    const m: { messages: chatgptm[]; stream: boolean } & Record<
        string,
        unknown
    > = {
        messages: message.map(toChatgptm),
        stream: true,
    };
    for (const i in x.config) {
        m[i] = x.config[i];
    }
    if (x.model) m.model = x.model;
    let resultText = "";
    let streamFun: (text: string, end: boolean) => void = () => {};

    const abortController = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const finish = (end: string) => {
        streamFun(resultText, true);
        resolve(end);
    };

    let url = x.url;
    if (x.url.replace(/\/$/, "").endsWith("v1/chat/completions")) {
        url = x.url;
    } else {
        url = new URL("chat/completions", x.url).toString();
    }

    fetch(url, {
        method: "POST",
        headers: {
            authorization: `Bearer ${x.key}`,
            "content-type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify(m),
    })
        .then(async (res) => {
            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                let msg = `HTTP ${res.status}`;
                try {
                    const j = JSON.parse(errText);
                    msg = j?.error?.message ?? msg;
                } catch {
                    if (errText) msg += `: ${errText.slice(0, 200)}`;
                }
                throw new Error(msg);
            }
            if (!res.body) throw new Error("response has no body");
            const reader = res.body.getReader();
            const textDecoder = new TextDecoder();
            let buffered = "";
            const readBody = (
                result: ReadableStreamReadResult<Uint8Array>,
            ): Promise<void> | void => {
                buffered += textDecoder.decode(result.value, {
                    stream: !result.done,
                });
                const lines = buffered.split("\n");
                buffered = result.done ? "" : (lines.pop() ?? "");
                for (const raw of lines) {
                    const i = raw
                        .trim()
                        .replace(/^data:/, "")
                        .trim();
                    if (i === "") continue;
                    if (i === "[DONE]") {
                        abortController.abort();
                        finish(resultText);
                        return;
                    }
                    parse(i);
                }
                if (result.done) {
                    finish(resultText);
                    return;
                }
                return reader.read().then(readBody);
            };
            return reader.read().then(readBody);
        })
        .catch((e) => {
            streamFun(resultText, true);
            if (abortController.signal.aborted) {
                resolve(resultText);
            } else {
                reject(e);
            }
        });
    function parse(text: string) {
        let res = "";
        try {
            const data = JSON.parse(text);
            res =
                data.message?.content ||
                data.choices[0]?.message?.content ||
                data.choices[0]?.delta.content;
        } catch (error) {}
        resultText += res ?? "";
        streamFun(resultText, false);
    }

    return {
        text: promise,
        stream: (f: typeof streamFun) => {
            streamFun = f;
        },
        stop: () => {
            abortController.abort();
        },
    };
}

export { runAI };
export type { aiData };
