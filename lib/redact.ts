/**
 * Smart-redact pattern detection (Snagit/Xnapper style).
 * Pure functions so the clip editor and tests share the same rules.
 */

export type SensitiveCategory =
    | "email"
    | "card"
    | "phone"
    | "ipv4"
    | "id"
    | "secret";

export type SensitiveRule = {
    category: SensitiveCategory;
    pattern: RegExp;
};

/**
 * Patterns intentionally match *inside* a text line, not whole lines:
 * a sentence may contain a sensitive fragment surrounded by prose.
 */
export const sensitiveRules: SensitiveRule[] = [
    { category: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/ },
    { category: "card", pattern: /\b(?:\d[ -]?){13,19}\b/ },
    {
        category: "phone",
        pattern:
            /(?:\b01[016789]-\d{3,4}-\d{4}\b)|(?:\+\d{1,3}[ -]\(?\d{1,4}\)?[ -]\d{3,4}[ -]\d{4}\b)/,
    },
    { category: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
    {
        category: "id",
        pattern: /(?:\b\d{6}-?[1-4]\d{6}\b)|(?:\b\d{3}-\d{2}-\d{4}\b)/,
    },
    {
        category: "secret",
        pattern:
            /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b|\b(?:sk|pk|api|key|token|secret|passwd|password)[_-]?[\w-]{16,}\b/i,
    },
];

/** True when the line contains at least one sensitive fragment. */
export function isSensitiveText(text: string): boolean {
    return sensitiveRules.some((rule) => rule.pattern.test(text));
}

/**
 * Keep the OCR lines that contain sensitive content.
 * Generic so it works directly on esearch-ocr `resultType` entries.
 */
export function filterSensitiveLines<T extends { text: string }>(
    lines: readonly T[],
): T[] {
    return lines.filter((line) => isSensitiveText(line.text));
}
