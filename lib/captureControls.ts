export type CaptureBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CaptureToolbarFit<T> = {
    visible: T[];
    overflow: T[];
};

export function fitCaptureToolbar<T>(
    favorites: readonly T[],
    metrics: {
        viewportWidth: number;
        favoriteWidth: number;
        fixedWidth: number;
        gap: number;
        viewportPadding?: number;
    },
): CaptureToolbarFit<T> {
    const viewportPadding = metrics.viewportPadding ?? 12;
    const availableWidth = Math.max(
        0,
        metrics.viewportWidth - viewportPadding * 2,
    );
    const favoriteStep = Math.max(0, metrics.favoriteWidth + metrics.gap);
    const remainingWidth = Math.max(0, availableWidth - metrics.fixedWidth);
    const visibleCount =
        favoriteStep > 0
            ? Math.min(
                  favorites.length,
                  Math.floor(remainingWidth / favoriteStep),
              )
            : 0;

    return {
        visible: favorites.slice(0, visibleCount),
        overflow: favorites.slice(visibleCount),
    };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(Math.max(min, max), value));
}

export function captureDock(
    selection: CaptureBox,
    viewport: { width: number; height: number },
    toolbar: { width: number; height: number },
) {
    const gap = 12;
    const x = clamp(
        selection.x + (selection.width - toolbar.width) / 2,
        gap,
        viewport.width - toolbar.width - gap,
    );
    const below = selection.y + selection.height + gap;
    const y =
        below + toolbar.height <= viewport.height - gap
            ? below
            : selection.y - toolbar.height - gap;
    return {
        x: Math.round(x),
        y: Math.round(clamp(y, gap, viewport.height - toolbar.height - gap)),
    };
}

export function dimBarY(
    selection: { y: number; height: number },
    viewportHeight: number,
    barHeight: number,
    preferBottom: boolean,
    overlaps: (cy: number) => boolean,
    gap = 8,
) {
    const insideFits = selection.height >= barHeight + gap * 2;
    const insideNear = preferBottom
        ? selection.y + selection.height - barHeight - gap
        : selection.y + gap;
    const insideFar = preferBottom
        ? selection.y + gap
        : selection.y + selection.height - barHeight - gap;
    let y = preferBottom
        ? selection.y + selection.height + gap
        : selection.y - barHeight - gap;
    const primaryFits = preferBottom
        ? y + barHeight <= viewportHeight - gap
        : y >= gap;
    if (!primaryFits || overlaps(y)) {
        if (insideFits && !overlaps(insideNear)) y = insideNear;
        else if (insideFits && !overlaps(insideFar)) y = insideFar;
        else if (!primaryFits)
            y = preferBottom ? viewportHeight - barHeight - gap : gap;
    }
    return Math.max(
        gap,
        Math.min(viewportHeight - barHeight - gap, Math.round(y)),
    );
}

export function radialLayout(
    pointer: { x: number; y: number },
    viewport: { width: number; height: number },
    count: number,
    buttonSize = 36,
) {
    const radius = Math.max(78, buttonSize * 2.2);
    const extent = radius + buttonSize / 2 + 16;
    const center = {
        x: clamp(pointer.x, extent, viewport.width - extent),
        y: clamp(pointer.y, extent, viewport.height - extent),
    };
    const points = Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
        return {
            x: Math.round(center.x + Math.cos(angle) * radius),
            y: Math.round(center.y + Math.sin(angle) * radius),
        };
    });
    return { center, points, radius };
}
