type rect = [number, number, number, number];
type point = { x: number; y: number };

/** 已暂存的多区域：rect 是外接框，points 存在时是自由形选区 */
export type StagedRegion = { rect: rect; key?: number; points?: point[] };

const SVG_NS = "http://www.w3.org/2000/svg";

export function createCaptureStaging(options: {
    container: HTMLElement;
    lineW: () => number;
    zoom: () => number;
    setElBox: (
        el: HTMLElement | SVGSVGElement,
        x: number,
        y: number,
        w: number,
        h: number,
    ) => void;
}) {
    const { container, lineW, zoom, setElBox } = options;
    /** clip 侧直接 push/splice；改完必须调 render */
    const regions: StagedRegion[] = [];
    let highlightKey: number | null = null;
    let renderKey = "";

    function pointInPoints(x: number, y: number, pts: point[]) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const { x: xi, y: yi } = pts[i];
            const { x: xj, y: yj } = pts[j];
            if (
                yi > y !== yj > y &&
                x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
            )
                inside = !inside;
        }
        return inside;
    }

    /** 半透明轮廓 + 序号徽标，告诉你已捕获了哪里 */
    function render() {
        const w = lineW();
        const key = `${w}|${highlightKey ?? ""}|${regions.map((i) => `${i.key ?? ""}:${i.rect.join(",")}:${i.points?.length ?? ""}`).join(";")}`;
        if (key === renderKey) return;
        renderKey = key;
        const badgeSize = Math.max(16, 18 / zoom());
        container.replaceChildren(
            ...regions.map((entry, i) => {
                const active = entry.key != null && entry.key === highlightKey;
                const box = document.createElement("div");
                box.className = "capture-staged-box";
                box.classList.toggle("is-active", active);
                setElBox(
                    box,
                    entry.rect[0],
                    entry.rect[1],
                    entry.rect[2],
                    entry.rect[3],
                );
                box.style.boxSizing = "border-box";
                box.style.border = `${w}px ${active ? "solid" : "dashed"} ${active ? "#fff" : "#ffffffb3"}`;
                box.style.background = active ? "#ffffff26" : "#00000012";
                if (entry.points) {
                    box.style.border = "none";
                    box.style.background = "none";
                    const svg = document.createElementNS(SVG_NS, "svg");
                    svg.setAttribute(
                        "viewBox",
                        `0 0 ${entry.rect[2]} ${entry.rect[3]}`,
                    );
                    svg.style.cssText =
                        "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
                    const poly = document.createElementNS(SVG_NS, "polygon");
                    poly.setAttribute(
                        "points",
                        entry.points
                            .map(
                                (p) =>
                                    `${p.x - entry.rect[0]},${p.y - entry.rect[1]}`,
                            )
                            .join(" "),
                    );
                    poly.setAttribute(
                        "fill",
                        active ? "#ffffff26" : "#00000012",
                    );
                    poly.setAttribute("stroke", active ? "#fff" : "#ffffffb3");
                    poly.setAttribute("stroke-width", String(w));
                    poly.setAttribute(
                        "stroke-dasharray",
                        active ? "none" : `${w * 3} ${w * 2}`,
                    );
                    svg.append(poly);
                    box.append(svg);
                }
                const badge = document.createElement("div");
                badge.className = "capture-staged-badge";
                badge.textContent = `${i + 1}`;
                badge.style.width = `${badgeSize}px`;
                badge.style.height = `${badgeSize}px`;
                badge.style.fontSize = `${badgeSize * 0.62}px`;
                box.append(badge);
                return box;
            }),
        );
    }

    function highlight(key: number | null) {
        if (highlightKey === key) return;
        highlightKey = key;
        render();
    }

    function removeByKey(key: number) {
        const i = regions.findIndex((r) => r.key === key);
        if (i < 0) return;
        regions.splice(i, 1);
        if (highlightKey === key) highlightKey = null;
        render();
    }

    /** 命中测试：指针坐标(画布系)内最上层的已暂存区域 */
    function at(x: number, y: number) {
        for (let i = regions.length - 1; i >= 0; i--) {
            const b = regions[i];
            const r = b.rect;
            if (
                !(
                    x >= r[0] &&
                    x <= r[0] + r[2] &&
                    y >= r[1] &&
                    y <= r[1] + r[3]
                )
            )
                continue;
            if (!b.points || pointInPoints(x, y, b.points)) return b;
        }
        return null;
    }

    function clear() {
        regions.length = 0;
        highlightKey = null;
        render();
    }

    return { regions, render, highlight, removeByKey, at, clear };
}
