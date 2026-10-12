export type PinPoint = readonly [number, number];

export type PinVisualMaterial<TStroke> = {
    url: string;
    translation: string;
    isTranslate: boolean;
    rotation: number;
    flip: boolean;
    strokes: TStroke[];
};

export function withDerivedPinImage<TStroke>(
    current: PinVisualMaterial<TStroke>,
    dataURL: string,
): PinVisualMaterial<TStroke> {
    return {
        ...current,
        url: dataURL,
        translation: "",
        isTranslate: false,
        strokes: [...current.strokes],
    };
}

export function normalizeQuarterTurn(rotation: number) {
    return (((Math.round(rotation / 90) % 4) + 4) % 4) * 90;
}

export function pinOutputSize(width: number, height: number, rotation: number) {
    const quarterTurn = normalizeQuarterTurn(rotation);
    return quarterTurn === 90 || quarterTurn === 270
        ? { width: height, height: width }
        : { width, height };
}

export function transformPinPoint(
    point: PinPoint,
    source: { width: number; height: number },
    rotation: number,
    flipX: boolean,
) {
    const quarterTurn = normalizeQuarterTurn(rotation);
    const output = pinOutputSize(source.width, source.height, quarterTurn);
    let x = point[0] * source.width - source.width / 2;
    const y = point[1] * source.height - source.height / 2;
    if (flipX) x = -x;

    const rotated =
        quarterTurn === 90
            ? { x: -y, y: x }
            : quarterTurn === 180
              ? { x: -x, y: -y }
              : quarterTurn === 270
                ? { x: y, y: -x }
                : { x, y };

    return {
        x: rotated.x + output.width / 2,
        y: rotated.y + output.height / 2,
    };
}
