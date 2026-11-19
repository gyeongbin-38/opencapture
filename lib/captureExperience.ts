import type {
    CaptureExperiencePreferences,
    CaptureToolId,
} from "./openCaptureTypes";

export const CAPTURE_EXPERIENCE_VERSION = 1 as const;

export const DEFAULT_TOOLBAR_ORDER: CaptureToolId[] = [
    "copy",
    "stage",
    "annotate",
    "pin",
    "more",
];

export const DEFAULT_RADIAL_ORDER: CaptureToolId[] = [
    "copy",
    "stage",
    "annotate",
    "pin",
    "ocr",
    "redact",
    "compare",
    "more",
];

export const DEFAULT_CAPTURE_EXPERIENCE: CaptureExperiencePreferences = {
    version: CAPTURE_EXPERIENCE_VERSION,
    toolbarOrder: [...DEFAULT_TOOLBAR_ORDER],
    radialOrder: [...DEFAULT_RADIAL_ORDER],
    feedback: {
        visual: true,
        sound: false,
        soundTone: "chime",
        motion: "system",
    },
    defaultPreset: "stage-only",
    shelfEnabled: true,
    trashRetentionDays: 0,
};

const TOOL_IDS = new Set<CaptureToolId>([
    "copy",
    "save",
    "stage",
    "annotate",
    "pin",
    "color",
    "scroll",
    "record",
    "search",
    "qr",
    "open",
    "screens",
    "ocr",
    "redact",
    "compare",
    "promote",
    "trash",
    "more",
]);

function toolOrder(value: unknown, fallback: CaptureToolId[], limit: number) {
    if (!Array.isArray(value)) return [...fallback];
    const result: CaptureToolId[] = [];
    for (const entry of value) {
        if (typeof entry !== "string" || !TOOL_IDS.has(entry as CaptureToolId))
            continue;
        const id = entry as CaptureToolId;
        if (!result.includes(id)) result.push(id);
        if (result.length === limit) break;
    }
    return result.length ? result : [...fallback];
}

export function parseCaptureExperience(
    value: unknown,
): CaptureExperiencePreferences {
    const input =
        value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
    const feedback =
        input.feedback && typeof input.feedback === "object"
            ? (input.feedback as Record<string, unknown>)
            : {};
    const motion = feedback.motion;
    const preset = input.defaultPreset;
    return {
        version: CAPTURE_EXPERIENCE_VERSION,
        toolbarOrder: toolOrder(input.toolbarOrder, DEFAULT_TOOLBAR_ORDER, 8),
        radialOrder: toolOrder(input.radialOrder, DEFAULT_RADIAL_ORDER, 8),
        feedback: {
            visual: feedback.visual !== false,
            sound: feedback.sound === true,
            soundTone: feedback.soundTone === "shutter" ? "shutter" : "chime",
            motion:
                motion === "full" || motion === "reduced" ? motion : "system",
        },
        defaultPreset:
            preset === "copy-close" ||
            preset === "stage-pin" ||
            preset === "annotate"
                ? preset
                : "stage-only",
        shelfEnabled: input.shelfEnabled !== false,
        trashRetentionDays: Number.isSafeInteger(input.trashRetentionDays)
            ? Math.min(365, Math.max(0, input.trashRetentionDays as number))
            : 0,
    };
}
