import { dirname, resolve } from "node:path";
import type {
    CaptureItemsQuery,
    OpenCaptureItem,
    SavedSmartFilter,
} from "../../lib/openCaptureTypes";

const pathKey = (path: string) => {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function shouldRemoveOwnedDuplicate(
    candidatePath: string,
    duplicatePath: string,
    indexedPaths: readonly string[],
    ownedFolders: readonly string[],
) {
    return (
        pathKey(candidatePath) !== pathKey(duplicatePath) &&
        ownedFolders.some(
            (folder) => pathKey(dirname(candidatePath)) === pathKey(folder),
        ) &&
        !indexedPaths.some((path) => pathKey(path) === pathKey(candidatePath))
    );
}

export function applyCaptureTransition(
    catalog: OpenCaptureItem[],
    ids: string[],
    transition: "promote" | "trash" | "restore",
) {
    const snapshot = ids.map((id) => {
        const item = catalog.find((candidate) => candidate.id === id);
        if (!item) throw new Error("Capture item was not found.");
        return {
            item,
            status: item.status,
            previousStatus: item.previousStatus,
        };
    });
    for (const { item } of snapshot) {
        const status = item.status ?? "library";
        if (transition === "promote" && status !== "temporary")
            throw new Error("Only temporary captures can be promoted.");
        if (transition === "restore" && status !== "trash")
            throw new Error("Only trashed captures can be restored.");
    }
    for (const { item } of snapshot) {
        const status = item.status ?? "library";
        if (transition === "promote") {
            item.status = "library";
        } else if (transition === "trash") {
            if (status === "trash") continue;
            item.previousStatus = status;
            item.status = "trash";
        } else {
            item.status = item.previousStatus ?? "library";
            item.previousStatus = undefined;
        }
    }
    return snapshot;
}

export function queryCaptureItems(
    catalog: OpenCaptureItem[],
    request: CaptureItemsQuery,
    smartFilters: SavedSmartFilter[],
    catalogRevision: number,
) {
    if (
        !request ||
        typeof request !== "object" ||
        !Number.isSafeInteger(request.offset) ||
        request.offset < 0 ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 200 ||
        !["temporary", "library", "trash", "all"].includes(request.scope) ||
        !["newest", "oldest", "name"].includes(request.sort) ||
        typeof request.queryId !== "string" ||
        request.queryId.length > 100 ||
        (request.search !== undefined &&
            (typeof request.search !== "string" ||
                request.search.length > 500)) ||
        (request.tags !== undefined &&
            (!Array.isArray(request.tags) ||
                request.tags.length > 12 ||
                request.tags.some(
                    (tag) => typeof tag !== "string" || tag.length > 40,
                )))
    )
        throw new Error("Invalid capture query.");
    if (
        request.offset > 0 &&
        request.catalogRevision !== undefined &&
        request.catalogRevision !== catalogRevision
    )
        throw new Error("Capture catalog changed; restart this query.");
    const builtin: Partial<SavedSmartFilter> | undefined =
        request.smartId === "builtin:today"
            ? { date: "today" as const }
            : request.smartId === "builtin:week"
              ? { date: "week" as const }
              : request.smartId === "builtin:video"
                ? { type: "video" as const }
                : undefined;
    const smart =
        builtin ??
        (request.smartId
            ? smartFilters.find((candidate) => candidate.id === request.smartId)
            : undefined);
    if (
        request.smartId &&
        !smart &&
        !["builtin:uncategorized", "builtin:no-ocr"].includes(request.smartId)
    )
        throw new Error("Smart filter was not found.");
    const tags = request.tags ?? smart?.tags ?? [];
    const search = request.search?.trim().toLocaleLowerCase();
    const cutoff =
        smart?.date === "today"
            ? Date.now() - 86_400_000
            : smart?.date === "week"
              ? Date.now() - 7 * 86_400_000
              : smart?.date === "month"
                ? Date.now() - 31 * 86_400_000
                : 0;
    const typeMatches = (item: OpenCaptureItem) => {
        if (!smart?.type) return true;
        const path = item.path.toLowerCase();
        if (smart.type === "video")
            return /\.(mp4|webm|mov|mkv|avi|ts)$/.test(path);
        if (smart.type === "gif") return path.endsWith(".gif");
        if (smart.type === "project") return path.endsWith(".ocap");
        return /\.(png|jpe?g|webp|bmp)$/.test(path);
    };
    const scoped = catalog.filter((item) => {
        const status = item.status ?? "library";
        if (request.scope !== "all" && status !== request.scope) return false;
        if (request.collectionId && item.collectionId !== request.collectionId)
            return false;
        if (
            search &&
            !`${item.name}\n${item.note ?? ""}\n${item.ocrText ?? ""}`
                .toLocaleLowerCase()
                .includes(search)
        )
            return false;
        if (tags.length && !tags.every((tag) => item.tags?.includes(tag)))
            return false;
        if (request.smartId === "builtin:uncategorized" && item.tags?.length)
            return false;
        if (
            request.smartId === "builtin:no-ocr" &&
            (item.ocrText ||
                /\.(mp4|webm|mov|mkv|avi|ts|ocap)$/i.test(item.path))
        )
            return false;
        if ((request.favorites ?? smart?.favorites) && !item.favorite)
            return false;
        if ((request.ocrOnly ?? smart?.ocrOnly) && !item.ocrText) return false;
        if (cutoff && Date.parse(item.createdAt) < cutoff) return false;
        return typeMatches(item);
    });
    scoped.sort((a, b) =>
        request.sort === "name"
            ? a.name.localeCompare(b.name)
            : request.sort === "oldest"
              ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
              : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    return {
        items: scoped.slice(request.offset, request.offset + request.limit),
        total: scoped.length,
        queryId: request.queryId,
        catalogRevision,
    };
}
