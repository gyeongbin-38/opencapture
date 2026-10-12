export const TAG_LIMIT = 12;
export const TAG_MAX_LENGTH = 30;
export const NOTE_MAX_LENGTH = 2000;
export const OCR_TEXT_LIMIT = 50_000;

export function normalizeTags(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const tags = [
        ...new Set(
            value
                .filter((t): t is string => typeof t === "string")
                .map((t) => t.trim().replace(/\p{C}/gu, ""))
                .filter(Boolean)
                .map((t) => t.slice(0, TAG_MAX_LENGTH)),
        ),
    ].slice(0, TAG_LIMIT);
    return tags.length ? tags : undefined;
}

export function isValidTags(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= TAG_LIMIT &&
        value.every((t) => typeof t === "string" && t.length <= TAG_MAX_LENGTH)
    );
}
