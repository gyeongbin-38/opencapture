export type FileToolKind =
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "document"
    | "spreadsheet"
    | "slides"
    | "subtitle"
    | "archive"
    | "folder"
    | "other";

export interface FileToolSource {
    id: string;
    name: string;
    size: number;
    extension: string;
    kind: FileToolKind;
}

export interface FileToolRecipe {
    id: string;
    label: string;
    group: "convert" | "tools";
    formats?: string[];
    /** Process the whole selection together; otherwise run once per file. */
    multiple?: boolean;
    minSources?: number;
    sourceIds?: string[];
    options?: (
        | "quality"
        | "width"
        | "height"
        | "start"
        | "end"
        | "speed"
        | "pages"
        | "angle"
        | "volume"
        | "x"
        | "y"
        | "flip"
        | "channels"
        | "foldAxis"
        | "foldOffset"
        | "foldSize"
    )[];
    available: boolean;
    reason?: string;
}

export interface FileToolOptions {
    format?: string;
    quality?: number;
    width?: number;
    height?: number;
    start?: number;
    end?: number;
    speed?: number;
    pages?: string;
    angle?: number;
    volume?: number;
    x?: number;
    y?: number;
    flip?: "horizontal" | "vertical";
    channels?: number;
    foldAxis?: "horizontal" | "vertical";
    foldOffset?: number;
    foldSize?: number;
}

export interface FileToolSelection {
    sources: FileToolSource[];
    recipes: FileToolRecipe[];
    rejected: { name: string; reason: string }[];
    unavailableActions?: string[];
    copyMaxFiles: number;
    destinations?: {
        id: string;
        name: string;
        available: boolean;
        reason?: string;
    }[];
}

export interface FileToolResult {
    sourceId: string;
    name: string;
    status: "success" | "error" | "cancelled";
    outputs: { id: string; name: string; size: number }[];
    error?: string;
    warnings?: string[];
}

export interface FileToolProgress {
    jobId: string;
    completed: number;
    total: number;
    percent: number;
}

export interface FileToolsApi {
    select(
        paths?: string[],
        mode?: "files" | "folders",
    ): Promise<FileToolSelection>;
    run(input: {
        jobId: string;
        sourceIds: string[];
        recipe: string;
        options: FileToolOptions;
        destinationId?: string;
    }): Promise<FileToolResult[]>;
    cancel(jobId: string): Promise<boolean>;
    outputAction(
        id: string,
        action: "reveal" | "copy" | "copy-path" | "drag",
    ): Promise<boolean>;
    sourceAction(
        ids: string[],
        action:
            | "copy"
            | "copy-path"
            | "copy-to"
            | "move-to"
            | "reveal"
            | "terminal"
            | "share"
            | "float"
            | "edit",
        jobId?: string,
        destinationId?: string,
    ): Promise<{ ok: boolean; message?: string; sources?: FileToolSource[] }>;
    onProgress(callback: (value: FileToolProgress) => void): () => void;
}

export function fileToolKind(extension: string): FileToolKind {
    const groups: [FileToolKind, string[]][] = [
        [
            "image",
            [
                "jpg",
                "jpeg",
                "png",
                "webp",
                "heic",
                "heif",
                "tif",
                "tiff",
                "avif",
                "bmp",
                "svg",
                "ico",
            ],
        ],
        ["video", ["mp4", "mov", "mkv", "webm", "avi", "wmv", "gif", "apng"]],
        [
            "audio",
            [
                "mp3",
                "m4a",
                "wav",
                "flac",
                "ogg",
                "opus",
                "aiff",
                "aif",
                "wma",
                "aac",
            ],
        ],
        ["pdf", ["pdf"]],
        [
            "document",
            [
                "doc",
                "docx",
                "odt",
                "pages",
                "md",
                "markdown",
                "txt",
                "epub",
                "rtf",
                "rtfd",
                "html",
                "htm",
            ],
        ],
        ["spreadsheet", ["xls", "xlsx", "ods", "csv", "tsv", "json"]],
        ["slides", ["ppt", "pptx", "odp"]],
        ["subtitle", ["srt", "vtt", "ass", "ssa"]],
        ["archive", ["zip", "tar", "gz", "gzip", "tgz", "rar", "br"]],
    ];
    return (
        groups.find(([, extensions]) =>
            extensions.includes(extension.toLowerCase()),
        )?.[0] ?? "other"
    );
}
