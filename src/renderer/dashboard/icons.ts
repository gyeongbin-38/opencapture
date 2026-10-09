import { type ElType, ele } from "dkh-ui";

const SVG_NS = "http://www.w3.org/2000/svg";

type IconShape = readonly [
    tag: "path" | "circle" | "rect" | "line" | "polyline",
    attributes: Record<string, string>,
];

const shapes: Record<string, readonly IconShape[]> = {
    // capture mark — corner brackets + center dot
    "⌁": [
        [
            "path",
            {
                d: "M8.5 4.5h-3a1 1 0 0 0-1 1v3M19.5 8.5v-3a1 1 0 0 0-1-1h-3M15.5 19.5h3a1 1 0 0 0 1-1v-3M4.5 15.5v3a1 1 0 0 0 1 1h3",
            },
        ],
        [
            "circle",
            {
                cx: "12",
                cy: "12",
                r: "1.4",
                fill: "currentColor",
                stroke: "none",
            },
        ],
    ],
    // home
    "⌂": [
        ["path", { d: "m4.5 10.5 7.5-6 7.5 6" }],
        ["path", { d: "M6.5 9v9.5h11V9" }],
    ],
    // library — 2x2 rounded grid
    "▧": [
        ["rect", { x: "4", y: "4", width: "7", height: "7", rx: "1.6" }],
        ["rect", { x: "13", y: "4", width: "7", height: "7", rx: "1.6" }],
        ["rect", { x: "4", y: "13", width: "7", height: "7", rx: "1.6" }],
        ["rect", { x: "13", y: "13", width: "7", height: "7", rx: "1.6" }],
    ],
    // translate — languages glyph
    文: [
        ["path", { d: "M3 5h12M8 3v2" }],
        [
            "path",
            {
                d: "M6 9.5c1.2 2.9 3.4 5.1 6.5 6.5M10.5 9.5C9 13 6.7 15.7 3.5 17",
            },
        ],
        ["path", { d: "m12.5 21 4.5-10 4.5 10M14.4 18h5.2" }],
    ],
    // settings — sliders
    "⚙": [
        ["line", { x1: "3.5", y1: "6", x2: "13", y2: "6" }],
        ["line", { x1: "17", y1: "6", x2: "20.5", y2: "6" }],
        ["circle", { cx: "15", cy: "6", r: "2" }],
        ["line", { x1: "3.5", y1: "12", x2: "7", y2: "12" }],
        ["line", { x1: "11", y1: "12", x2: "20.5", y2: "12" }],
        ["circle", { cx: "9", cy: "12", r: "2" }],
        ["line", { x1: "3.5", y1: "18", x2: "15", y2: "18" }],
        ["line", { x1: "19", y1: "18", x2: "20.5", y2: "18" }],
        ["circle", { cx: "17", cy: "18", r: "2" }],
    ],
    // command key
    "⌘": [
        [
            "path",
            {
                d: "M9 8V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z",
            },
        ],
    ],
    // compact — arrow into corner
    "↙": [
        ["path", { d: "M17 7 7 17" }],
        ["path", { d: "M16 17H7V8" }],
    ],
    "—": [["line", { x1: "5", y1: "12", x2: "19", y2: "12" }]],
    "＋": [
        ["line", { x1: "12", y1: "5", x2: "12", y2: "19" }],
        ["line", { x1: "5", y1: "12", x2: "19", y2: "12" }],
    ],
    // crop — area capture
    "⌗": [
        ["path", { d: "M6.5 2.5v13a2 2 0 0 0 2 2h13" }],
        ["path", { d: "M2.5 6.5h13a2 2 0 0 1 2 2v13" }],
    ],
    // clipboard
    "▣": [
        [
            "path",
            {
                d: "M9 4.5H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 17 4.5h-2",
            },
        ],
        ["rect", { x: "9", y: "3", width: "6", height: "3.5", rx: "1" }],
    ],
    // folder
    "▤": [
        [
            "path",
            {
                d: "M4 19.5h16a1.5 1.5 0 0 0 1.5-1.5V8.5A1.5 1.5 0 0 0 20 7h-8.2a1.5 1.5 0 0 1-1.2-.6L9.4 4.9a1.5 1.5 0 0 0-1.2-.6H4A1.5 1.5 0 0 0 2.5 5.8V18A1.5 1.5 0 0 0 4 19.5Z",
            },
        ],
    ],
    // scroll — up/down chevrons
    "↕": [
        ["path", { d: "m7.5 9 4.5-4.5L16.5 9" }],
        ["path", { d: "m7.5 15 4.5 4.5 4.5-4.5" }],
    ],
    // record dot
    "●": [
        ["circle", { cx: "12", cy: "12", r: "7" }],
        [
            "circle",
            {
                cx: "12",
                cy: "12",
                r: "3",
                fill: "currentColor",
                stroke: "none",
            },
        ],
    ],
    // text
    T: [
        ["path", { d: "M5.5 6h13" }],
        ["path", { d: "M12 6v13" }],
    ],
    // pin
    "◇": [
        ["path", { d: "M9 3.5h6v5.5l3 3v1H6v-1l3-3Z" }],
        ["line", { x1: "12", y1: "13", x2: "12", y2: "20.5" }],
    ],
    // upload into tray
    "⇧": [
        ["path", { d: "m8 8.5 4-4 4 4M12 4.5V15" }],
        [
            "path",
            { d: "M4.5 15.5v3A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-3" },
        ],
    ],
    // download from tray
    "⇩": [
        ["path", { d: "m8 11.5 4 4 4-4M12 15.5V5" }],
        [
            "path",
            { d: "M4.5 15.5v3A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-3" },
        ],
    ],
    "✓": [["polyline", { points: "5 12.5 10 17.5 19 7" }]],
    // storage drive
    "▰": [
        ["rect", { x: "3", y: "6", width: "18", height: "13", rx: "2" }],
        ["line", { x1: "3", y1: "14.5", x2: "21", y2: "14.5" }],
        [
            "circle",
            {
                cx: "17",
                cy: "16.8",
                r: "0.8",
                fill: "currentColor",
                stroke: "none",
            },
        ],
    ],
    // swap
    "⇄": [
        ["path", { d: "M4.5 8.5h13m-3-3 3 3-3 3M19.5 15.5h-13m3 3-3-3 3-3" }],
    ],
    "×": [
        ["line", { x1: "6.5", y1: "6.5", x2: "17.5", y2: "17.5" }],
        ["line", { x1: "17.5", y1: "6.5", x2: "6.5", y2: "17.5" }],
    ],
    "•••": [
        [
            "circle",
            {
                cx: "5.5",
                cy: "12",
                r: "1.2",
                fill: "currentColor",
                stroke: "none",
            },
        ],
        [
            "circle",
            {
                cx: "12",
                cy: "12",
                r: "1.2",
                fill: "currentColor",
                stroke: "none",
            },
        ],
        [
            "circle",
            {
                cx: "18.5",
                cy: "12",
                r: "1.2",
                fill: "currentColor",
                stroke: "none",
            },
        ],
    ],
    // sparkle — auto / background remove
    "✦": [
        [
            "path",
            {
                d: "M12 4c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z",
            },
        ],
    ],
    // search
    "⌕": [
        ["circle", { cx: "10.5", cy: "10.5", r: "6" }],
        ["line", { x1: "15", y1: "15", x2: "20", y2: "20" }],
    ],
    // star
    "★": [
        [
            "path",
            {
                d: "M12 4.6l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7L12 4.6Z",
            },
        ],
    ],
    // duplicate
    "⧉": [
        [
            "rect",
            { x: "8.5", y: "8.5", width: "11.5", height: "11.5", rx: "1.8" },
        ],
        [
            "path",
            {
                d: "M15.5 8.5V5.3a1.8 1.8 0 0 0-1.8-1.8H5.3a1.8 1.8 0 0 0-1.8 1.8v8.4a1.8 1.8 0 0 0 1.8 1.8h3.2",
            },
        ],
    ],
    // pencil — annotate / edit
    "✎": [
        [
            "path",
            {
                d: "M4.5 19.5l1-4L15.8 5.2a2.1 2.1 0 0 1 3 3L8.5 18.5l-4 1Z",
            },
        ],
        ["line", { x1: "14.2", y1: "6.8", x2: "17.2", y2: "9.8" }],
    ],
    // framed image — beautify
    "▨": [
        ["rect", { x: "3.5", y: "5", width: "17", height: "14", rx: "2" }],
        ["circle", { cx: "9", cy: "10", r: "1.4" }],
        ["path", { d: "M5.5 17l4.2-4.2 2.8 2.8 3.2-3.2 2.8 4.6" }],
    ],
    // crosshair — pin to screen / precision
    "⌖": [
        ["circle", { cx: "12", cy: "12", r: "6.5" }],
        ["line", { x1: "12", y1: "2.5", x2: "12", y2: "5.5" }],
        ["line", { x1: "12", y1: "18.5", x2: "12", y2: "21.5" }],
        ["line", { x1: "2.5", y1: "12", x2: "5.5", y2: "12" }],
        ["line", { x1: "18.5", y1: "12", x2: "21.5", y2: "12" }],
    ],
    // memo note
    "☰": [
        ["line", { x1: "4.5", y1: "7", x2: "19.5", y2: "7" }],
        ["line", { x1: "4.5", y1: "12", x2: "19.5", y2: "12" }],
        ["line", { x1: "4.5", y1: "17", x2: "14", y2: "17" }],
    ],
    // upscale — expand arrows
    "⤢": [
        ["path", { d: "M9 4H4v5M20 9V4h-5M4 15v5h5M15 20h5v-5" }],
        ["line", { x1: "4", y1: "4", x2: "9.6", y2: "9.6" }],
        ["line", { x1: "20", y1: "4", x2: "14.4", y2: "9.6" }],
        ["line", { x1: "4", y1: "20", x2: "9.6", y2: "14.4" }],
        ["line", { x1: "20", y1: "20", x2: "14.4", y2: "14.4" }],
    ],
    // mouse — mouse chord trigger
    "◉": [
        [
            "rect",
            {
                x: "7",
                y: "3",
                width: "10",
                height: "18",
                rx: "5",
            },
        ],
        ["line", { x1: "12", y1: "3", x2: "12", y2: "9" }],
        ["line", { x1: "12", y1: "9", x2: "12", y2: "9.2" }],
    ],
    // clock — today filter
    "◷": [
        ["circle", { cx: "12", cy: "12", r: "8.5" }],
        ["line", { x1: "12", y1: "7", x2: "12", y2: "12" }],
        ["line", { x1: "12", y1: "12", x2: "15.5", y2: "13.8" }],
    ],
    // tag — library tags
    "#": [
        ["line", { x1: "4", y1: "9.5", x2: "20", y2: "9.5" }],
        ["line", { x1: "4", y1: "15", x2: "20", y2: "15" }],
        ["line", { x1: "10", y1: "4", x2: "8.4", y2: "20" }],
        ["line", { x1: "15.6", y1: "4", x2: "14", y2: "20" }],
    ],
    // keyboard
    "⌨": [
        ["rect", { x: "2.5", y: "6", width: "19", height: "12", rx: "2" }],
        ["line", { x1: "6", y1: "10", x2: "6.2", y2: "10" }],
        ["line", { x1: "10", y1: "10", x2: "10.2", y2: "10" }],
        ["line", { x1: "14", y1: "10", x2: "14.2", y2: "10" }],
        ["line", { x1: "18", y1: "10", x2: "18.2", y2: "10" }],
        ["line", { x1: "8", y1: "14.5", x2: "16", y2: "14.5" }],
    ],
};

export function icon(value: string): ElType<HTMLSpanElement> {
    const wrapper = ele("span").class("icon");
    wrapper.el.setAttribute("aria-hidden", "true");

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");

    for (const [tag, attributes] of shapes[value] ?? shapes["⌗"]) {
        const shape = document.createElementNS(SVG_NS, tag);
        for (const [name, attributeValue] of Object.entries(attributes))
            shape.setAttribute(name, attributeValue);
        svg.append(shape);
    }

    wrapper.el.append(svg);
    return wrapper;
}
