if (location.pathname.endsWith("/recorder.html")) {
    const mode = process.env.OPENCAPTURE_RECORDER_SCENARIO;
    const childProcess = require("node:child_process");
    const originalSpawn = childProcess.spawn;
    window.__recorderFfmpegSpawns = 0;
    childProcess.spawn = (...args) => {
        window.__recorderFfmpegSpawns++;
        return originalSpawn(...args);
    };
    const devices = navigator.mediaDevices || {};
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: devices,
    });
    devices.enumerateDevices = async () => [];
    devices.getUserMedia = async (constraints) => {
        if (!constraints || !constraints.video) return new MediaStream();
        if (mode === "acquisition-denied") {
            throw new DOMException(
                "Synthetic permission denial",
                "NotAllowedError",
            );
        }
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        const context = canvas.getContext("2d");
        let frame = 0;
        const draw = () => {
            frame++;
            context.fillStyle = frame % 2 ? "#111318" : "#1c2230";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#f4f4f5";
            context.font = "48px sans-serif";
            context.fillText(`OpenCapture ${frame}`, 80, 160);
            context.fillStyle = "#5b6ee1";
            context.fillRect(80 + (frame % 180), 220, 180, 120);
        };
        draw();
        const timer = setInterval(draw, 33);
        const stream = canvas.captureStream(30);
        stream
            .getVideoTracks()[0]
            .addEventListener("ended", () => clearInterval(timer));
        window.__recorderSynthetic = { canvas, stream };
        return stream;
    };
    if (mode === "media-unsupported") {
        const OriginalMediaRecorder = window.MediaRecorder;
        window.MediaRecorder = class UnsupportedMediaRecorder extends (
            OriginalMediaRecorder
        ) {
            constructor() {
                throw new DOMException(
                    "Synthetic codec rejection",
                    "NotSupportedError",
                );
            }
        };
    }
    if (mode === "save-error") {
        const fs = require("node:fs");
        const originalCopy = fs.cpSync;
        let failedOnce = false;
        fs.cpSync = (...args) => {
            if (!failedOnce) {
                failedOnce = true;
                throw new Error("Synthetic save failure");
            }
            return originalCopy(...args);
        };
    }
}
