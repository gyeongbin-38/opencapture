import type { CaptureFeedbackPreferences } from "../../../lib/openCaptureTypes";

export function createCaptureFeedback(
    preferences: () => CaptureFeedbackPreferences,
) {
    let audio: AudioContext | undefined;
    const reduced = () =>
        preferences().motion === "reduced" ||
        (preferences().motion === "system" &&
            matchMedia("(prefers-reduced-motion: reduce)").matches);
    function sync() {
        document.body.classList.toggle(
            "capture-feedback-off",
            !preferences().visual,
        );
        document.body.classList.toggle("capture-motion-reduced", reduced());
        document.body.classList.toggle(
            "capture-motion-full",
            preferences().motion === "full",
        );
    }
    function settle(element: HTMLElement) {
        sync();
        if (!preferences().visual || reduced()) return;
        element.animate(
            [
                { opacity: 0.65, filter: "brightness(1.25)" },
                { opacity: 1, filter: "brightness(1)" },
            ],
            { duration: 150, easing: "ease-out" },
        );
    }
    async function sound() {
        if (!preferences().sound) return;
        try {
            audio ??= new AudioContext();
            await audio.resume();
            const oscillator = audio.createOscillator();
            const gain = audio.createGain();
            const now = audio.currentTime;
            oscillator.type = "triangle";
            oscillator.frequency.setValueAtTime(1040, now);
            oscillator.frequency.exponentialRampToValueAtTime(680, now + 0.045);
            gain.gain.setValueAtTime(0.035, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
            oscillator.connect(gain);
            gain.connect(audio.destination);
            oscillator.start(now);
            oscillator.stop(now + 0.06);
        } catch {
            /* Audio availability never blocks capture. */
        }
    }
    function commit(element?: HTMLElement, audible = false) {
        sync();
        if (element && preferences().visual && !reduced())
            element.animate(
                [
                    { transform: "translateY(5px)", opacity: 0.5 },
                    { transform: "translateY(0)", opacity: 1 },
                ],
                { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" },
            );
        if (audible) void sound();
    }
    return { sync, settle, commit, reduced, sound };
}
