import type { BoardDocument } from "../lib/captureBoard";
import { captureDock, fitCaptureToolbar } from "../lib/captureControls";
import { createLongPressController } from "../lib/longPress";
import { isSensitiveText } from "../lib/redact";
import {
    type BrowserBoardApi,
    type BrowserItem,
    createBrowserBoardApi,
    parseBrowserPortable,
} from "./boardApi";
import {
    beautifyImage,
    dataURLBlob,
    normalizeImage,
    resizeImage,
} from "./imageOps";

export type LabCheckResult = {
    id: string;
    name: string;
    status: "pass" | "fail" | "manual";
    detail: string;
    durationMs: number;
};

type CheckOptions = {
    models: boolean;
    onResult: (result: LabCheckResult) => void;
};

type OcrLine = {
    text: string;
    box: { x: number; y: number; width: number; height: number };
    confidence?: number;
};

const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

function requireCondition(
    condition: unknown,
    message: string,
): asserts condition {
    if (!condition) throw new Error(message);
}

const canvasPng = (
    width: number,
    height: number,
    draw: (context: CanvasRenderingContext2D) => void,
) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas is unavailable.");
    draw(context);
    return canvas.toDataURL("image/png");
};

const generatedBoardImage = () =>
    canvasPng(128, 80, (context) => {
        const gradient = context.createLinearGradient(0, 0, 128, 80);
        gradient.addColorStop(0, "#3257d6");
        gradient.addColorStop(1, "#69c7a8");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 128, 80);
        context.fillStyle = "#ffffff";
        context.fillRect(18, 18, 92, 44);
    });

const generatedTextImage = () =>
    canvasPng(900, 220, (context) => {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, 900, 220);
        context.fillStyle = "#000000";
        context.font = "bold 42px Arial, sans-serif";
        context.fillText("PUBLIC DOCUMENT", 34, 78);
        context.fillText("owner@example.com", 34, 164);
    });

const generatedPlantImage = () =>
    canvasPng(256, 256, (context) => {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, 256, 256);
        context.fillStyle = "#8b5a35";
        context.fillRect(92, 174, 72, 52);
        context.fillStyle = "#2f8b57";
        for (const [x, y, rotation] of [
            [128, 145, 0],
            [104, 126, -0.65],
            [151, 118, 0.7],
            [112, 93, -0.35],
            [145, 82, 0.4],
        ] as const) {
            context.save();
            context.translate(x, y);
            context.rotate(rotation);
            context.beginPath();
            context.ellipse(0, 0, 16, 34, 0, 0, Math.PI * 2);
            context.fill();
            context.restore();
        }
    });

async function imagePixels(dataURL: string) {
    const bitmap = await createImageBitmap(dataURLBlob(dataURL));
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Canvas is unavailable.");
        context.drawImage(bitmap, 0, 0);
        return {
            width: bitmap.width,
            height: bitmap.height,
            pixels: context.getImageData(0, 0, bitmap.width, bitmap.height)
                .data,
        };
    } finally {
        bitmap.close();
    }
}

function regionChanged(
    before: Awaited<ReturnType<typeof imagePixels>>,
    after: Awaited<ReturnType<typeof imagePixels>>,
    box: OcrLine["box"],
) {
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const right = Math.min(before.width, Math.ceil(box.x + box.width));
    const bottom = Math.min(before.height, Math.ceil(box.y + box.height));
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const offset = (y * before.width + x) * 4;
            for (let channel = 0; channel < 4; channel++)
                if (
                    before.pixels[offset + channel] !==
                    after.pixels[offset + channel]
                )
                    return true;
        }
    }
    return false;
}

async function processRequest<T>(payload: Record<string, unknown>): Promise<T> {
    const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const result = (await response.json()) as T & {
        error?: { message?: string };
    };
    if (!response.ok)
        throw new Error(
            result.error?.message ?? `Processing failed (${response.status}).`,
        );
    return result;
}

function deleteDatabase(name: string, timeoutMs = 3_000) {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(
            () => finish(new Error("Isolated IndexedDB deletion timed out.")),
            timeoutMs,
        );
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => finish();
        request.onerror = () =>
            finish(request.error ?? new Error("IndexedDB deletion failed."));
        request.onblocked = () =>
            finish(
                new Error(
                    "IndexedDB deletion was blocked by an open connection.",
                ),
            );
    });
}

export async function runLabChecks(
    options: CheckOptions,
): Promise<LabCheckResult[]> {
    const results: LabCheckResult[] = [];
    const databaseName = `opencapture-lab-check-${crypto.randomUUID()}`;
    const api = createBrowserBoardApi({ databaseName });
    let reloadApi: BrowserBoardApi | undefined;
    let item: BrowserItem | undefined;
    let board: BoardDocument | undefined;
    let assetId: string | undefined;
    const fixture = generatedBoardImage();

    const emit = (result: LabCheckResult) => {
        results.push(result);
        options.onResult(result);
    };
    const check = async (
        id: string,
        name: string,
        action: () => Promise<string> | string,
    ) => {
        const started = performance.now();
        try {
            const detail = await action();
            emit({
                id,
                name,
                status: "pass",
                detail,
                durationMs: Math.round(performance.now() - started),
            });
        } catch (error) {
            emit({
                id,
                name,
                status: "fail",
                detail: errorText(error),
                durationMs: Math.round(performance.now() - started),
            });
        }
    };
    const manual = (id: string, name: string, detail: string) =>
        emit({ id, name, status: "manual", detail, durationMs: 0 });

    try {
        await check("board-write", "격리 보드 저장", async () => {
            const status = await api.status();
            requireCondition(
                !status.readOnly,
                status.error ?? "IndexedDB is read-only.",
            );
            item = await api.importImage(fixture, "generated-check.png");
            const created = await api.create("Automated isolated check");
            const withImage = await api.addItems(
                created.id,
                [item.id],
                created.revision,
            );
            assetId = withImage.nodes.find(
                (node) => node.kind === "image",
            )?.assetId;
            requireCondition(assetId, "Imported image asset was not attached.");
            board = await api.save(
                { ...withImage, name: "Automated saved check" },
                withImage.revision,
            );
            return `Created revision ${board.revision} with one generated image.`;
        });

        await check("board-cas", "오래된 리비전 거부", async () => {
            requireCondition(board, "Board setup did not complete.");
            let rejected = false;
            try {
                await api.save(board, board.revision - 1);
            } catch (error) {
                rejected = /revision conflict/i.test(errorText(error));
            }
            requireCondition(
                rejected,
                "A stale compare-and-swap save was accepted.",
            );
            return "Stale revision save rejected with a revision conflict.";
        });

        await check("board-reload", "두 번째 어댑터 재로드", async () => {
            requireCondition(board, "Board setup did not complete.");
            reloadApi = createBrowserBoardApi({ databaseName });
            const loaded = await reloadApi.load(board.id);
            requireCondition(
                loaded.revision === board.revision,
                "Reloaded revision differs.",
            );
            requireCondition(
                loaded.name === board.name,
                "Reloaded name differs.",
            );
            requireCondition(
                loaded.nodes.length === 1,
                "Reloaded image node is missing.",
            );
            return `Second adapter loaded revision ${loaded.revision}.`;
        });

        await check(
            "owned-asset",
            "원본 항목 삭제 후 보드 자산 유지",
            async () => {
                requireCondition(
                    item && assetId,
                    "Imported item setup did not complete.",
                );
                await api.deleteItem(item.id);
                requireCondition(
                    (await api.readItem(item.id)) === null,
                    "Library item remains.",
                );
                const asset = await api.snapshotAsset(assetId);
                requireCondition(
                    asset,
                    "Board-owned asset was deleted with its source item.",
                );
                requireCondition(
                    asset.width === 128 && asset.height === 80,
                    "Asset dimensions changed.",
                );
                return "Board-owned 128×80 asset remains after source item deletion.";
            },
        );

        await check("portable-validation", "손상된 포터블 보드 거부", () => {
            let rejected = false;
            try {
                parseBrowserPortable(
                    JSON.stringify({ version: 1, document: {}, assets: [] }),
                );
            } catch {
                rejected = true;
            }
            requireCondition(rejected, "Invalid portable board was accepted.");
            return "Malformed portable board rejected by the real validator.";
        });

        await check("image-transform", "이미지 리사이즈·꾸미기", async () => {
            const resizeFixture = canvasPng(1280, 800, (context) => {
                context.fillStyle = "#365cd6";
                context.fillRect(0, 0, 1280, 800);
            });
            const resized = await normalizeImage(
                await resizeImage(resizeFixture),
            );
            requireCondition(
                resized.width === 1024 && resized.height === 640,
                `Resize returned ${resized.width}×${resized.height}.`,
            );
            const beautified = await beautifyImage(fixture, {
                id: "check",
                name: "Check",
                background: "#f3f4f7",
                padding: 12,
                shadow: 8,
                radius: 10,
                ratio: "auto",
                align: "center",
                autoBalance: false,
            });
            requireCondition(
                beautified.width === 152 && beautified.height === 104,
                `Beautify returned ${beautified.width}×${beautified.height}.`,
            );
            return "Resize produced 1024×640; beautify produced 152×104.";
        });

        await check("capture-layout", "캡처 도구 위치·오버플로", () => {
            const tools = ["copy", "stage", "ocr", "redact", "save"];
            const fit = fitCaptureToolbar(tools, {
                viewportWidth: 260,
                favoriteWidth: 44,
                fixedWidth: 110,
                gap: 2,
            });
            requireCondition(fit.visible.length > 0, "No toolbar actions fit.");
            requireCondition(
                fit.overflow.length > 0,
                "Narrow toolbar did not overflow.",
            );
            requireCondition(
                [...fit.visible, ...fit.overflow].join(",") === tools.join(","),
                "Toolbar ordering changed.",
            );
            const dock = captureDock(
                { x: 330, y: 260, width: 25, height: 25 },
                { width: 360, height: 300 },
                { width: 260, height: 44 },
            );
            requireCondition(
                dock.x >= 12 && dock.x + 260 <= 348 && dock.y >= 12,
                "Dock escaped the viewport.",
            );
            return `${fit.visible.length} visible, ${fit.overflow.length} overflow; dock remained reachable.`;
        });

        await check("long-press", "길게 누르기 임계값", () => {
            let timer: (() => void) | undefined;
            let held = 0;
            const controller = createLongPressController({
                onHold: () => held++,
                setTimer: (callback) => {
                    timer = callback;
                    return callback;
                },
                clearTimer: () => {
                    timer = undefined;
                },
            });
            controller.pointerDown({ pointerId: 1, x: 10, y: 10 });
            controller.pointerMove({ pointerId: 1, x: 16, y: 15 });
            timer?.();
            requireCondition(
                held === 1 && controller.state() === "held",
                "Valid hold did not fire.",
            );
            controller.pointerUp(1);
            let dragged = false;
            const dragController = createLongPressController({
                onHold: () => held++,
                onDragStart: () => {
                    dragged = true;
                },
                setTimer: () => 1,
                clearTimer: () => {},
            });
            dragController.pointerDown({ pointerId: 2, x: 0, y: 0 });
            dragController.pointerMove({ pointerId: 2, x: 9, y: 0 });
            requireCondition(
                dragged && dragController.state() === "dragging" && held === 1,
                "Movement threshold did not hand off to drag.",
            );
            return "Within 8 px held once; 9 px movement switched to drag.";
        });

        if (options.models) {
            const textFixture = generatedTextImage();
            await check("model-ocr", "로컬 OCR", async () => {
                const result = await processRequest<{
                    text: string;
                    lines: OcrLine[];
                    width: number;
                    height: number;
                }>({ operation: "ocr", dataURL: textFixture });
                requireCondition(
                    result.width === 900 && result.height === 220,
                    "OCR dimensions differ.",
                );
                requireCondition(
                    /PUBLIC/i.test(result.text),
                    "OCR missed high-contrast English text.",
                );
                requireCondition(
                    result.lines.some((line) => isSensitiveText(line.text)),
                    "OCR did not produce a recognizable email line.",
                );
                return `Recognized ${result.lines.length} lines locally.`;
            });

            await check("model-redact", "민감정보만 가리기", async () => {
                const result = await processRequest<{
                    dataURL: string;
                    lines: OcrLine[];
                    redacted: number;
                }>({ operation: "redact", dataURL: textFixture });
                const sensitive = result.lines.filter((line) =>
                    isSensitiveText(line.text),
                );
                const ordinary = result.lines.filter(
                    (line) => !isSensitiveText(line.text),
                );
                requireCondition(
                    ordinary.length > 0,
                    "No ordinary OCR line was available.",
                );
                requireCondition(
                    result.redacted === sensitive.length && result.redacted > 0,
                    "Redacted count does not match sensitive OCR lines.",
                );
                requireCondition(
                    result.redacted < result.lines.length,
                    "Ordinary OCR lines were included in redaction.",
                );
                const [before, after] = await Promise.all([
                    imagePixels(textFixture),
                    imagePixels(result.dataURL),
                ]);
                requireCondition(
                    before.width === after.width &&
                        before.height === after.height,
                    "Redaction dimensions changed.",
                );
                requireCondition(
                    before.pixels.some(
                        (value, index) => value !== after.pixels[index],
                    ),
                    "Redaction output pixels did not change.",
                );
                requireCondition(
                    ordinary.every(
                        (line) => !regionChanged(before, after, line.box),
                    ),
                    "An ordinary OCR line was altered.",
                );
                requireCondition(
                    sensitive.every((line) =>
                        regionChanged(before, after, line.box),
                    ),
                    "A sensitive OCR line was not altered.",
                );
                return `${result.redacted} sensitive line masked; ${ordinary.length} ordinary line(s) excluded.`;
            });

            await check("model-cutout", "로컬 배경 제거", async () => {
                const result = await processRequest<{
                    dataURL: string;
                    width: number;
                    height: number;
                }>({ operation: "cutout", dataURL: generatedPlantImage() });
                requireCondition(
                    result.width === 256 && result.height === 256,
                    "Cutout dimensions changed.",
                );
                const image = await imagePixels(result.dataURL);
                let minAlpha = 255;
                let maxAlpha = 0;
                for (let index = 3; index < image.pixels.length; index += 4) {
                    minAlpha = Math.min(minAlpha, image.pixels[index]);
                    maxAlpha = Math.max(maxAlpha, image.pixels[index]);
                }
                requireCondition(
                    minAlpha < 220 && maxAlpha > 240,
                    "Cutout lacks a useful alpha range.",
                );
                return `U2Net alpha range ${minAlpha}–${maxAlpha}.`;
            });

            await check("model-upscale", "로컬 AI 확대", async () => {
                const tiny = canvasPng(8, 6, (context) => {
                    context.fillStyle = "#365cd6";
                    context.fillRect(0, 0, 8, 6);
                    context.fillStyle = "#ffffff";
                    context.fillRect(2, 1, 4, 4);
                });
                const result = await processRequest<{
                    dataURL: string;
                    width: number;
                    height: number;
                }>({ operation: "upscale", dataURL: tiny });
                requireCondition(
                    result.width === 32 && result.height === 24,
                    `Upscale returned ${result.width}×${result.height}.`,
                );
                requireCondition(
                    (await imagePixels(result.dataURL)).width === 32,
                    "Upscale PNG dimensions differ.",
                );
                return "8×6 input produced a real 32×24 image.";
            });

            await check("model-translate", "로컬 번역", async () => {
                const result = await processRequest<{ text: string }>({
                    operation: "translate",
                    text: "Hello, this is a local translation test.",
                    from: "en",
                    to: "ko",
                });
                requireCondition(
                    /[가-힣]/.test(result.text),
                    "Translation did not contain Hangul.",
                );
                return `English translated locally to: ${result.text.slice(0, 80)}`;
            });
        }

        manual(
            "permission-actions",
            "브라우저 권한 기능",
            "화면 공유와 클립보드는 사용자 권한 선택이 필요해 수동 확인 대상입니다.",
        );
        manual(
            "native-actions",
            "데스크톱 전용 기능",
            "전역 단축키, 다른 앱 캡처, 항상 위 창은 네이티브 앱에서 수동 확인해야 합니다.",
        );
        manual(
            "dom-coverage",
            "화면 버튼·라우팅",
            "이 자동점검은 기본 도메인 동작을 확인하며 DOM 버튼과 전체 사용자 흐름은 수동 확인 대상입니다.",
        );
    } finally {
        await check("storage-cleanup", "격리 저장소 정리", async () => {
            const disposals = await Promise.allSettled([
                reloadApi?.dispose() ?? Promise.resolve(),
                api.dispose(),
            ]);
            await deleteDatabase(databaseName);
            const failed = disposals.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failed) throw failed.reason;
            return `Deleted isolated database ${databaseName}.`;
        });
    }

    return results;
}
