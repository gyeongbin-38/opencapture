import type {
    OpenCaptureItem,
    OpenCaptureItemsPage,
    OpenCaptureState,
} from "../../../lib/openCaptureTypes";
import { t } from "./t";

export type PageName = "home" | "library" | "translate" | "settings";

export const emptyState: OpenCaptureState = {
    collections: [],
    items: [],
    activeCollectionId: null,
    defaultFolder: "",
    version: "",
    totalItemCount: 0,
    workflow: {
        autoCopy: false,
        autoRemoveBackground: false,
        autoPin: false,
        autoOcr: true,
        autoPreview: false,
        autoClipboard: false,
    },
    pinSets: [],
    runtime: { startAtLogin: false, shortcuts: [] },
};

export const UPSCALE_MAX_PIXELS = 24_000_000;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message
        : t("요청을 처리하지 못했습니다.");
}

export function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("날짜 정보 없음");
    return new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

export function formatRelativeTime(value: number) {
    const diff = Date.now() - value;
    if (diff < 60_000) return t("방금 사용");
    if (diff < 3_600_000)
        return t("{n}분 전 사용").replace(
            "{n}",
            String(Math.floor(diff / 60_000)),
        );
    if (diff < 86_400_000)
        return t("{n}시간 전 사용").replace(
            "{n}",
            String(Math.floor(diff / 3_600_000)),
        );
    return t("{n}일 전 사용").replace(
        "{n}",
        String(Math.floor(diff / 86_400_000)),
    );
}

export function formatShortcut(value: string) {
    return value
        .replaceAll(
            "CommandOrControl",
            navigator.platform.startsWith("Mac") ? "Cmd" : "Ctrl",
        )
        .replaceAll("Escape", "Esc")
        .replaceAll("+", " + ");
}

export function isState(value: unknown): value is OpenCaptureState {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<OpenCaptureState>;
    return (
        Array.isArray(candidate.collections) &&
        Array.isArray(candidate.items) &&
        typeof candidate.totalItemCount === "number" &&
        Boolean(candidate.workflow) &&
        Boolean(candidate.runtime)
    );
}

export function isItemsPage(value: unknown): value is OpenCaptureItemsPage {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<OpenCaptureItemsPage>;
    return (
        Array.isArray(candidate.items) &&
        typeof candidate.totalItemCount === "number"
    );
}

export function isGifItem(item: OpenCaptureItem) {
    return item.name.toLowerCase().endsWith(".gif");
}

export function isVideoItem(item: OpenCaptureItem) {
    return /\.(mp4|webm|mov|mkv|avi|ts)$/i.test(item.name);
}

export function isProjectItem(item: OpenCaptureItem) {
    return item.name.toLowerCase().endsWith(".ocap");
}

export function unsharpMask(
    canvas: HTMLCanvasElement,
    radius: number,
    amount: number,
) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const blur = document.createElement("canvas");
    blur.width = canvas.width;
    blur.height = canvas.height;
    const bctx = blur.getContext("2d");
    if (!bctx) return;
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(canvas, 0, 0);
    const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const soft = bctx.getImageData(0, 0, canvas.width, canvas.height);
    const s = source.data;
    const b = soft.data;
    for (let i = 0; i < s.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = s[i + c] + (s[i + c] - b[i + c]) * amount;
            s[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
    ctx.putImageData(source, 0, 0);
}

export function sampleEdgeColor(
    image: HTMLImageElement,
): [number, number, number] {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [38, 60, 74];
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            if (y > 2 && y < size - 3 && x > 2 && x < size - 3) continue;
            const i = (y * size + x) * 4;
            const a = data[i + 3] / 255;
            r += data[i] * a;
            g += data[i + 1] * a;
            b += data[i + 2] * a;
            n += a;
        }
    if (!n) return [38, 60, 74];
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function mixChannel(
    from: [number, number, number],
    to: [number, number, number],
    t: number,
): [number, number, number] {
    return [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
    ];
}

export function drawBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    size = 40,
) {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#2563eb";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${size / 2 + 2}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + size / 2, y + size / 2 + 1);
}

const KEY_NAME_MAP: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    "+": "Plus",
    ";": ";",
    "=": "=",
    ",": ",",
    "-": "-",
    ".": ".",
    "/": "/",
    "`": "`",
    "[": "[",
    "]": "]",
    "\\": "\\",
    "'": "'",
};

export function acceleratorFromEvent(e: KeyboardEvent): string | null {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    let key = "";
    if (/^.$/u.test(e.key)) key = (KEY_NAME_MAP[e.key] ?? e.key).toUpperCase();
    else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else key = KEY_NAME_MAP[e.key] ?? "";
    if (!key) return null;
    if (!parts.length && !/^F\d{1,2}$/.test(key)) return null;
    parts.push(key);
    return parts.join("+");
}

export type GifDecoder = {
    tracks: {
        ready: Promise<void>;
        selectedTrack: { frameCount: number } | null;
    };
    decode(options: { frameIndex: number }): Promise<ImageDecodeResult>;
    close(): void;
};

export const GifImageDecoder = (
    globalThis as unknown as {
        ImageDecoder?: new (init: {
            data: BufferSource;
            type: string;
        }) => GifDecoder;
    }
).ImageDecoder;
