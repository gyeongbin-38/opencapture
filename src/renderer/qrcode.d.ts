declare module "qrcode" {
    interface QRCodeToCanvasOptions {
        version?: number;
        errorCorrectionLevel?: "L" | "M" | "Q" | "H";
        margin?: number;
        scale?: number;
        width?: number;
        color?: { dark?: string; light?: string };
    }
    export function toCanvas(
        canvas: HTMLCanvasElement,
        text: string,
        options?: QRCodeToCanvasOptions,
    ): Promise<HTMLCanvasElement>;
    export function toDataURL(
        text: string,
        options?: QRCodeToCanvasOptions,
    ): Promise<string>;
}
