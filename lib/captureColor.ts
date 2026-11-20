import chroma from "chroma-js";
import type { setting } from "../src/ShareTypes";

export type CaptureColorFormat = setting["取色器"]["默认格式"];
export type CaptureColorRgba = [number, number, number, number];

export function rgbaCss(rgba: CaptureColorRgba) {
    return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})`;
}

function formatComponent(num: number) {
    return (num || 0).toFixed(1).replace(/\.?0+$/, "");
}

export function colorConversion(
    rgba: CaptureColorRgba | null,
    type: CaptureColorFormat,
): string {
    const color = chroma(rgbaCss(rgba || [0, 0, 0, 0]));
    if (color.alpha() !== 1) return "/";
    switch (type) {
        case "HEX":
            return color.hex();
        case "RGB":
            return color.css();
        case "HSL":
            return color.css("hsl");
        case "HSV": {
            const hsv = color.hsv();
            return `hsv(${formatComponent(hsv[0])} ${formatComponent(hsv[1] * 100)}% ${formatComponent(hsv[2] * 100)}%)`;
        }
        case "CMYK": {
            const cmyk = color.cmyk();
            return `cmyk(${formatComponent(cmyk[0] * 100)}% ${formatComponent(cmyk[1] * 100)}% ${formatComponent(cmyk[2] * 100)}% ${formatComponent(cmyk[3] * 100)}%)`;
        }
        case "HWB": {
            const [h, s, v] = color.hsv();
            return `hwb(${formatComponent(h)} ${formatComponent((1 - s) * v * 100)}% ${formatComponent((1 - v) * 100)}%)`;
        }
        case "LAB":
            return color.css("lab");
        case "LCH":
            return color.css("lch");
        case "OKLAB":
            return color.css("oklab");
        case "OKLCH":
            return color.css("oklch");
        default:
            return "";
    }
}
