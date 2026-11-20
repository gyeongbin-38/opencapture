export function reportUnhandledErrors(report: (message: string) => void) {
    let last = "";
    window.addEventListener("error", (event) => {
        console.error(event.error ?? event.message);
        const error = event.error;
        notify(error instanceof Error ? error.message : event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason: unknown = event.reason;
        console.error(reason);
        notify(reason instanceof Error ? reason.message : String(reason));
    });
    function notify(message: string) {
        if (!message || message === last) return;
        last = message;
        try {
            report(message);
        } catch (e) {
            console.error("error report failed:", e);
        }
    }
}
