import type { OpenCaptureItem } from "../../../lib/openCaptureTypes";
import { lt } from "../lib/labText";

type Layout = "horizontal" | "vertical" | "grid";
type Background = "transparent" | "black" | "white" | "gray";

const MAX_ITEMS = 12;
const MAX_PIXELS = 64_000_000;

async function decode(data: string) {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
            reject(new Error(lt("이미지를 불러오지 못했습니다.")));
        image.src = data;
    });
    return image;
}

export function createBundleComposer(options: {
    load: (id: string) => Promise<string>;
    copy: (dataURL: string) => Promise<void>;
    save: (dataURL: string, label: string) => Promise<void>;
    openDialog: (dialog: HTMLDialogElement) => void;
    closeDialog: (dialog: HTMLDialogElement) => void;
    announce: (message: string, error?: boolean) => void;
}) {
    const dialog = document.createElement("dialog");
    dialog.className = "shortcut-dialog bundle-dialog";
    dialog.innerHTML = `
        <header class="dialog-header"><h2>${lt("여러 장 묶기")}</h2><button type="button" class="close-button" aria-label="${lt("닫기")}">×</button></header>
        <div class="bundle-toolbar">
            <label>${lt("배치")}<select data-role="layout"><option value="grid">${lt("격자")}</option><option value="horizontal">${lt("가로")}</option><option value="vertical">${lt("세로")}</option></select></label>
            <label>${lt("간격")}<input data-role="gap" type="range" min="0" max="64" value="16"></label>
            <label>${lt("배경")}<select data-role="background"><option value="transparent">${lt("투명")}</option><option value="black">${lt("검정")}</option><option value="white">${lt("흰색")}</option><option value="gray">${lt("회색")}</option></select></label>
        </div>
        <div class="bundle-order" data-role="order" aria-label="${lt("이미지 순서")}"></div>
        <div class="bundle-preview"><canvas data-role="canvas"></canvas><small data-role="meta"></small></div>
        <footer class="dialog-actions"><button type="button" class="text-button" data-role="cancel">${lt("취소")}</button><button type="button" class="outline-button" data-role="save">${lt("저장")}</button><button type="button" class="primary-button" data-role="copy">${lt("묶음 복사")}</button></footer>`;
    const layout = dialog.querySelector<HTMLSelectElement>(
        '[data-role="layout"]',
    )!;
    const gap = dialog.querySelector<HTMLInputElement>('[data-role="gap"]')!;
    const background = dialog.querySelector<HTMLSelectElement>(
        '[data-role="background"]',
    )!;
    const order = dialog.querySelector<HTMLElement>('[data-role="order"]')!;
    const canvas = dialog.querySelector<HTMLCanvasElement>(
        '[data-role="canvas"]',
    )!;
    const meta = dialog.querySelector<HTMLElement>('[data-role="meta"]')!;
    const copy = dialog.querySelector<HTMLButtonElement>('[data-role="copy"]')!;
    const save = dialog.querySelector<HTMLButtonElement>('[data-role="save"]')!;
    let items: OpenCaptureItem[] = [];
    let images: HTMLImageElement[] = [];
    let busy = false;

    function compositionSize() {
        const spacing = Number(gap.value);
        const selectedLayout = layout.value as Layout;
        if (selectedLayout === "horizontal")
            return {
                width:
                    images.reduce((sum, image) => sum + image.naturalWidth, 0) +
                    spacing * (images.length - 1),
                height: Math.max(...images.map((image) => image.naturalHeight)),
                columns: images.length,
            };
        if (selectedLayout === "vertical")
            return {
                width: Math.max(...images.map((image) => image.naturalWidth)),
                height:
                    images.reduce(
                        (sum, image) => sum + image.naturalHeight,
                        0,
                    ) +
                    spacing * (images.length - 1),
                columns: 1,
            };
        const columns = Math.ceil(Math.sqrt(images.length));
        const rows = Math.ceil(images.length / columns);
        const cellWidth = Math.max(
            ...images.map((image) => image.naturalWidth),
        );
        const cellHeight = Math.max(
            ...images.map((image) => image.naturalHeight),
        );
        return {
            width: columns * cellWidth + spacing * (columns - 1),
            height: rows * cellHeight + spacing * (rows - 1),
            columns,
        };
    }

    function renderCanvas(target: HTMLCanvasElement, preview: boolean) {
        const { width, height, columns } = compositionSize();
        if (width * height > MAX_PIXELS)
            throw new Error(lt("묶음 결과가 64MP를 넘습니다."));
        const scale = preview ? Math.min(1, 900 / width, 520 / height) : 1;
        target.width = Math.max(1, Math.round(width * scale));
        target.height = Math.max(1, Math.round(height * scale));
        const context = target.getContext("2d");
        if (!context) throw new Error(lt("캔버스를 만들지 못했습니다."));
        const colors: Record<Background, string | null> = {
            transparent: null,
            black: "#0b0b0c",
            white: "#ffffff",
            gray: "#777777",
        };
        const fill = colors[background.value as Background];
        if (fill) {
            context.fillStyle = fill;
            context.fillRect(0, 0, target.width, target.height);
        } else context.clearRect(0, 0, target.width, target.height);
        const spacing = Number(gap.value);
        const selectedLayout = layout.value as Layout;
        const cellWidth =
            selectedLayout === "grid"
                ? Math.max(...images.map((image) => image.naturalWidth))
                : 0;
        const cellHeight =
            selectedLayout === "grid"
                ? Math.max(...images.map((image) => image.naturalHeight))
                : 0;
        let x = 0;
        let y = 0;
        images.forEach((image, index) => {
            if (selectedLayout === "grid") {
                const column = index % columns;
                const row = Math.floor(index / columns);
                x =
                    column * (cellWidth + spacing) +
                    (cellWidth - image.naturalWidth) / 2;
                y =
                    row * (cellHeight + spacing) +
                    (cellHeight - image.naturalHeight) / 2;
            }
            context.drawImage(
                image,
                x * scale,
                y * scale,
                image.naturalWidth * scale,
                image.naturalHeight * scale,
            );
            if (selectedLayout === "horizontal")
                x += image.naturalWidth + spacing;
            if (selectedLayout === "vertical")
                y += image.naturalHeight + spacing;
        });
        meta.textContent = lt(
            `${width.toLocaleString()} × ${height.toLocaleString()} · ${items.length}장`,
            `${width.toLocaleString()} × ${height.toLocaleString()} · ${items.length} images`,
        );
    }

    function renderPreview() {
        if (!images.length) return;
        try {
            renderCanvas(canvas, true);
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : lt("미리보기를 만들지 못했습니다."),
                true,
            );
        }
    }

    function renderOrder() {
        order.replaceChildren();
        items.forEach((item, index) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "bundle-order-chip";
            chip.draggable = true;
            chip.dataset.index = String(index);
            const orderNumber = document.createElement("span");
            orderNumber.textContent = String(index + 1);
            const itemName = document.createElement("strong");
            itemName.textContent = item.name;
            chip.append(orderNumber, itemName);
            chip.addEventListener("dragstart", (event) =>
                event.dataTransfer?.setData("text/plain", String(index)),
            );
            chip.addEventListener("dragover", (event) =>
                event.preventDefault(),
            );
            chip.addEventListener("drop", (event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer?.getData("text/plain"));
                if (!Number.isInteger(from) || from === index) return;
                const [movedItem] = items.splice(from, 1);
                const [movedImage] = images.splice(from, 1);
                items.splice(index, 0, movedItem);
                images.splice(index, 0, movedImage);
                renderOrder();
                renderPreview();
            });
            order.append(chip);
        });
    }

    async function output(kind: "copy" | "save") {
        if (busy) return;
        busy = true;
        copy.disabled = true;
        save.disabled = true;
        try {
            const outputCanvas = document.createElement("canvas");
            renderCanvas(outputCanvas, false);
            const dataURL = outputCanvas.toDataURL("image/png");
            if (kind === "copy") await options.copy(dataURL);
            else await options.save(dataURL, "Bundle");
            options.announce(
                kind === "copy"
                    ? lt("묶음을 복사했습니다.")
                    : lt("묶음을 저장했습니다."),
            );
            options.closeDialog(dialog);
        } catch (error) {
            options.announce(
                error instanceof Error
                    ? error.message
                    : lt("묶음 작업에 실패했습니다."),
                true,
            );
        } finally {
            busy = false;
            copy.disabled = false;
            save.disabled = false;
        }
    }

    for (const control of [layout, gap, background])
        control.addEventListener("input", renderPreview);
    dialog
        .querySelector(".close-button")
        ?.addEventListener("click", () => options.closeDialog(dialog));
    dialog
        .querySelector('[data-role="cancel"]')
        ?.addEventListener("click", () => options.closeDialog(dialog));
    copy.addEventListener("click", () => void output("copy"));
    save.addEventListener("click", () => void output("save"));
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        options.closeDialog(dialog);
    });

    return {
        dialog,
        async open(nextItems: OpenCaptureItem[]) {
            if (nextItems.length < 2 || nextItems.length > MAX_ITEMS) {
                options.announce(lt("2~12장의 이미지를 선택해 주세요."), true);
                return;
            }
            items = [...nextItems];
            images = [];
            order.replaceChildren();
            meta.textContent = lt("이미지 불러오는 중…");
            options.openDialog(dialog);
            try {
                for (const item of items)
                    images.push(await decode(await options.load(item.id)));
                renderOrder();
                renderPreview();
            } catch (error) {
                options.announce(
                    error instanceof Error
                        ? error.message
                        : lt("이미지를 불러오지 못했습니다."),
                    true,
                );
                options.closeDialog(dialog);
            }
        },
    };
}
