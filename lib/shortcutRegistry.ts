export type ShortcutRequest = {
    id: string;
    label: string;
    keys: string[];
    run: () => void;
};
export type ShortcutStatus = {
    id: string;
    label: string;
    requested: string;
    active: string | null;
    available: boolean;
};

export function registerShortcuts(
    requests: ShortcutRequest[],
    register: (key: string, run: () => void) => boolean,
): ShortcutStatus[] {
    return requests.map((request) => {
        let active: string | null = null;
        for (const key of request.keys) {
            try {
                if (register(key, request.run)) {
                    active = key;
                    break;
                }
            } catch {
                /* Invalid or OS-reserved accelerators remain unavailable. */
            }
        }
        return {
            id: request.id,
            label: request.label,
            requested: request.keys[0] ?? "",
            active,
            available: active !== null,
        };
    });
}
