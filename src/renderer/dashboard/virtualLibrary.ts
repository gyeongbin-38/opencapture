export interface VirtualLibraryRange {
    start: number;
    end: number;
    top: number;
    bottom: number;
    columns: number;
}

export interface VirtualLibraryOptions {
    total: number;
    viewportTop: number;
    viewportHeight: number;
    gridTop: number;
    gridWidth: number;
    cardWidth: number;
    rowHeight: number;
    gap: number;
    overscanRows?: number;
}

export interface VirtualLibrarySlot<T> {
    index: number;
    item: T | undefined;
}

export function virtualLibrarySlots<T>(
    items: Array<T | undefined>,
    start: number,
    end: number,
): VirtualLibrarySlot<T>[] {
    return items
        .slice(start, end)
        .map((item, offset) => ({ index: start + offset, item }));
}

export function virtualLibraryRange({
    total,
    viewportTop,
    viewportHeight,
    gridTop,
    gridWidth,
    cardWidth,
    rowHeight,
    gap,
    overscanRows = 2,
}: VirtualLibraryOptions): VirtualLibraryRange {
    const columns = Math.max(
        1,
        Math.floor((gridWidth + gap) / (cardWidth + gap)),
    );
    const rows = Math.ceil(total / columns);
    const stride = Math.max(1, rowHeight + gap);
    const relativeTop = Math.max(0, viewportTop - gridTop);
    const firstRow = Math.min(
        Math.max(0, rows - Math.max(1, overscanRows * 2 + 1)),
        Math.max(0, Math.floor(relativeTop / stride) - overscanRows),
    );
    const lastRow = Math.min(
        rows,
        Math.ceil((relativeTop + viewportHeight) / stride) + overscanRows,
    );
    const start = Math.min(total, firstRow * columns);
    const end = Math.min(total, lastRow * columns);
    const top = firstRow * stride;
    const bottom = Math.max(0, (rows - lastRow) * stride);
    return { start, end, top, bottom, columns };
}
