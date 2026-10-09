export type PinVisibility = {
    id: string;
    visible: boolean;
};

export class PinFocusState {
    private focusedId: string | null = null;
    private readonly visibilityBeforeFocus = new Map<string, boolean>();

    get activeId() {
        return this.focusedId;
    }

    get isActive() {
        return this.focusedId !== null;
    }

    toggle(id: string, pins: readonly PinVisibility[]) {
        if (this.focusedId === id) return this.restore();

        this.rememberNewPins(pins);
        this.focusedId = id;
        return pins.map((pin) => ({ id: pin.id, visible: pin.id === id }));
    }

    reconcile(pins: readonly PinVisibility[]) {
        if (!this.focusedId) return [];
        this.rememberNewPins(pins);
        return pins.map((pin) => ({
            id: pin.id,
            visible: pin.id === this.focusedId,
        }));
    }

    remove(id: string) {
        this.visibilityBeforeFocus.delete(id);
        if (this.focusedId !== id) return [];
        return this.restore();
    }

    restore() {
        const changes = Array.from(
            this.visibilityBeforeFocus,
            ([id, visible]) => ({ id, visible }),
        );
        this.focusedId = null;
        this.visibilityBeforeFocus.clear();
        return changes;
    }

    private rememberNewPins(pins: readonly PinVisibility[]) {
        for (const pin of pins) {
            if (!this.visibilityBeforeFocus.has(pin.id)) {
                this.visibilityBeforeFocus.set(pin.id, pin.visible);
            }
        }
    }
}

export class PinBlinkController {
    private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
    private readonly visible = new Map<string, boolean>();

    constructor(
        private readonly setVisible: (id: string, visible: boolean) => void,
        private readonly intervalMs = 500,
    ) {}

    isActive(id: string) {
        return this.timers.has(id);
    }

    get isAnyActive() {
        return this.timers.size > 0;
    }

    toggle(id: string) {
        if (this.isActive(id)) {
            this.stop(id);
            return false;
        }

        this.visible.set(id, true);
        this.timers.set(
            id,
            setInterval(() => {
                const visible = !(this.visible.get(id) ?? true);
                this.visible.set(id, visible);
                this.setVisible(id, visible);
            }, this.intervalMs),
        );
        return true;
    }

    stop(id: string) {
        const timer = this.timers.get(id);
        if (timer !== undefined) clearInterval(timer);
        this.timers.delete(id);
        this.visible.delete(id);
        this.setVisible(id, true);
    }

    clear() {
        for (const id of Array.from(this.timers.keys())) this.stop(id);
    }
}
