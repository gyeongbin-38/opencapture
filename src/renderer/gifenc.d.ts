declare module "gifenc" {
    export function GIFEncoder(): {
        writeFrame(
            index: Uint8Array,
            width: number,
            height: number,
            opts?: {
                palette?: [number, number, number][];
                delay?: number;
                repeat?: number;
                transparent?: boolean;
                transparentIndex?: number;
                dispose?: number;
                first?: boolean;
            },
        ): void;
        finish(): void;
        bytes(): Uint8Array;
    };
    export function quantize(
        data: Uint8ClampedArray,
        maxColors: number,
    ): [number, number, number][];
    export function applyPalette(
        data: Uint8ClampedArray,
        palette: [number, number, number][],
        format?: string,
    ): Uint8Array;
}
