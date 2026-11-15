const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const profile = path.join(root, ".evidence/convenience-profile");
const folder = path.join(root, ".evidence/convenience-captures");
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(folder, { recursive: true });
const fixtures = [
    path.join(root, ".evidence/red.png"),
    path.join(root, ".evidence/blue.png"),
];
// auto-cutout 테스트는 라이브러리 dedup을 통과해야 하므로 고유 콘텐츠의 시드가 필요
const zlib = require("node:zlib");
const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};
const makeSeedPng = () => {
    const w = 96;
    const h = 96;
    const rows = Buffer.alloc(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
        const row = y * (1 + w * 3);
        for (let x = 0; x < w; x++) {
            const i = row + 1 + x * 3;
            const inCircle = (x - 48) ** 2 + (y - 48) ** 2 < 24 * 24;
            rows[i] = inCircle ? 40 : 220;
            rows[i + 1] = inCircle ? 200 : 60;
            rows[i + 2] = inCircle ? 60 : 40;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
};
const cutoutSeed = path.join(root, ".evidence/auto-cutout-seed.png");
if (!fs.existsSync(cutoutSeed)) fs.writeFileSync(cutoutSeed, makeSeedPng());
const items = Array.from({ length: 1005 }, (_, i) => ({
    id: `fixture-${i}`,
    name: `fixture-${i}.png`,
    path: fixtures[i % 2],
    createdAt: new Date().toISOString(),
    collectionId: "default",
}));
fs.writeFileSync(
    path.join(profile, "library.json"),
    JSON.stringify({
        collections: [{ id: "default", name: "Test captures", path: folder }],
        items,
        activeCollectionId: "default",
        workflow: {
            autoCopy: false,
            autoRemoveBackground: false,
            autoPin: false,
        },
    }),
);
const started = Date.now();
const child = spawn(
    path.join(root, "release/win-unpacked/OpenCapture.exe"),
    [
        "--broker",
        "--toggle",
        "--remote-debugging-port=0",
        `--userData=${profile}`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let socket,
    log = "",
    id = 0;
const pending = new Map();
child.stderr.on("data", (d) => (log += d.toString()));
const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        socket.send(JSON.stringify({ id: i, method, params }));
    });
const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
};
const assert = (condition, message) => {
    if (!condition) throw Error(message);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const timer = setTimeout(() => {
    child.kill();
    console.error("Convenience test timeout", log);
    process.exit(1);
}, 90000);
(async () => {
    try {
        let page;
        for (let i = 0; i < 100; i++) {
            try {
                const port = log.match(
                    /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/,
                )?.[1];
                if (port)
                    page = (
                        await (
                            await fetch(`http://127.0.0.1:${port}/json`)
                        ).json()
                    ).find((p) => p.url.includes("dashboard.html"));
                if (page) break;
            } catch {}
            await delay(200);
        }
        assert(page, "Dashboard missing");
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
            socket.onopen = r;
            socket.onerror = j;
        });
        socket.onmessage = (e) => {
            const m = JSON.parse(e.data);
            const p = pending.get(m.id);
            if (p) {
                pending.delete(m.id);
                m.error
                    ? p.reject(Error(m.error.message))
                    : p.resolve(m.result);
            }
        };
        let bridgeReady = false;
        for (let i = 0; i < 100; i++) {
            try {
                bridgeReady = await evaluate(
                    "typeof window.openCapture === 'object'",
                );
                if (bridgeReady) break;
            } catch {}
            await delay(50);
        }
        assert(bridgeReady, "Preload did not initialize");
        let state = await evaluate("window.openCapture.getState()");
        const readyMs = Date.now() - started;
        assert(state.totalItemCount === 1005, "History was truncated");
        assert(state.items.length <= 200, "Initial page unbounded");
        const page2 = await evaluate(
            'window.openCapture.action("load-items",{offset:200,limit:100})',
        );
        assert(page2.items.length === 100, "Pagination failed");
        state = await evaluate(
            'window.openCapture.action("combine-items",{ids:["fixture-0","fixture-1"],direction:"vertical"})',
        );
        assert(
            state.totalItemCount === 1006,
            "Combine did not create an additional item",
        );
        const combined = state.items.find((i) => i.name.startsWith("Combined"));
        const persistent = JSON.parse(
            fs.readFileSync(path.join(profile, "library.json"), "utf8"),
        );
        assert(
            persistent.items.length === 1006,
            "Persisted history lost items",
        );
        assert(
            !persistent.items.some((i) => i.thumbnail),
            "Thumbnail blobs persisted",
        );
        await evaluate(
            'window.openCapture.action("configure-workflow",{autoRemoveBackground:true})',
        );
        const doc = await call("DOM.getDocument");
        const file = await call("DOM.querySelector", {
            nodeId: doc.root.nodeId,
            selector: "input[type=file]",
        });
        await call("DOM.setFileInputFiles", {
            nodeId: file.nodeId,
            files: [cutoutSeed],
        });
        for (let i = 0; i < 100; i++) {
            state = await evaluate("window.openCapture.getState()");
            if (state.totalItemCount >= 1008) break;
            await delay(150);
        }
        assert(
            state.totalItemCount === 1008,
            "Auto-cutout failed to preserve original and add derivative",
        );
        await evaluate(
            'document.querySelector(\'.nav-button[data-page="library"]\').click()',
        );
        await delay(300);
        let screenshot = await call("Page.captureScreenshot");
        fs.writeFileSync(
            path.join(root, ".evidence/library-wide.png"),
            Buffer.from(screenshot.data, "base64"),
        );
        await evaluate('window.openCapture.action("toggle-compact")');
        await delay(300);
        screenshot = await call("Page.captureScreenshot");
        fs.writeFileSync(
            path.join(root, ".evidence/library-compact.png"),
            Buffer.from(screenshot.data, "base64"),
        );
        const dimensions = await evaluate(
            "({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth})",
        );
        assert(
            dimensions.width <= 420 &&
                dimensions.scrollWidth <= dimensions.width + 2,
            "Compact layout overflows horizontally",
        );
        await evaluate(
            'window.openCapture.action("configure-workflow",{autoRemoveBackground:false})',
        );
        const evidence = {
            readyMs,
            initialCount: 1005,
            persistentCount: persistent.items.length,
            afterAutoCutout: state.totalItemCount,
            combinedPath: combined?.path,
            compact: dimensions,
            runtime: state.runtime,
        };
        void call("Runtime.evaluate", {
            expression: 'window.openCapture.action("hide-window")',
        }).catch(() => {});
        for (let i = 0; i < 80 && child.exitCode === null; i++)
            await delay(500);
        assert(
            child.exitCode === 0,
            "Broker editor did not quit after windows closed",
        );
        evidence.editorExitedWhenHidden = true;
        fs.writeFileSync(
            path.join(root, ".evidence/convenience.json"),
            JSON.stringify(evidence, null, 2),
        );
        console.log(JSON.stringify(evidence));
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        clearTimeout(timer);
        socket?.close();
        if (child.exitCode === null) child.kill();
    }
})();
