export interface FileShelfEntry {
    id: string;
    name: string;
    folder: boolean;
    icon: string;
}

export interface FileShelfApi {
    ready(): Promise<{ files: FileShelfEntry[]; copyMaxFiles: number }>;
    copy(ids: string[]): Promise<void>;
    copyPath(ids: string[]): Promise<void>;
    reveal(id: string): Promise<void>;
    drag(ids: string[]): { started: boolean; error?: string };
    close(): void;
    t(text: string): string;
}

declare global {
    interface Window {
        fileShelf: FileShelfApi;
    }
}
