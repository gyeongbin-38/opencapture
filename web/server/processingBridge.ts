import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const PREFIX = "OPEN_CAPTURE_LAB:";
const BODY_LIMIT = 16 * 1024 * 1024;
const MAX_PENDING = 8;
const ALLOWED_ORIGINS = new Set([
    "http://127.0.0.1:5187",
    "http://localhost:5187",
]);
const OPERATIONS = new Set(["cutout", "ocr", "upscale", "translate", "redact"]);

type WorkerResponse = {
    id?: number;
    event?: string;
    ok?: boolean;
    result?: unknown;
    error?: string;
};

class LabWorkerClient {
    private child: ChildProcessWithoutNullStreams | undefined;
    private server: Server | undefined;
    private socket: Socket | undefined;
    private startPromise: Promise<void> | undefined;
    private output = "";
    private nextId = 1;
    private pending = new Map<
        number,
        {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    constructor(private readonly root: string) {}

    async request(payload: Record<string, unknown>) {
        if (this.pending.size >= MAX_PENDING)
            throw new Error("Processing queue is full");
        await this.start();
        if (this.pending.size >= MAX_PENDING)
            throw new Error("Processing queue is full");
        const socket = this.socket;
        if (!socket) throw new Error("Processing worker is unavailable");
        const id = this.nextId++;
        const timeout = payload.operation === "upscale" ? 240_000 : 90_000;
        return new Promise<unknown>((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectPromise(new Error("Processing worker timed out"));
                this.stop();
            }, timeout);
            this.pending.set(id, {
                resolve: resolvePromise,
                reject: rejectPromise,
                timer,
            });
            socket.write(`${JSON.stringify({ id, ...payload })}\n`);
        });
    }

    stop() {
        const child = this.child;
        this.child = undefined;
        this.startPromise = undefined;
        this.output = "";
        this.socket?.destroy();
        this.socket = undefined;
        this.server?.close();
        this.server = undefined;
        if (child && !child.killed) child.kill();
        this.rejectAll(new Error("Processing worker stopped"));
    }

    private start(): Promise<void> {
        if (this.socket) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.startPromise = new Promise((resolvePromise, rejectPromise) => {
            const timeout = setTimeout(() => {
                rejectPromise(new Error("Processing worker failed to start"));
                this.stop();
            }, 20_000);
            const secret = randomBytes(24).toString("hex");
            const server = createServer((socket) => {
                let authenticated = false;
                let authBuffer = "";
                socket.setEncoding("utf8");
                socket.on("data", (chunk: string) => {
                    if (authenticated) {
                        this.consume(chunk);
                        return;
                    }
                    authBuffer += chunk;
                    const newline = authBuffer.indexOf("\n");
                    if (newline < 0) return;
                    try {
                        const auth = JSON.parse(
                            authBuffer.slice(0, newline),
                        ) as {
                            secret?: string;
                        };
                        if (auth.secret !== secret)
                            throw new Error("Bad worker secret");
                        authenticated = true;
                        this.socket = socket;
                        const remainder = authBuffer.slice(newline + 1);
                        if (remainder) this.consume(remainder);
                        clearTimeout(timeout);
                        resolvePromise();
                    } catch (error) {
                        clearTimeout(timeout);
                        socket.destroy();
                        rejectPromise(
                            error instanceof Error
                                ? error
                                : new Error(String(error)),
                        );
                        this.stop();
                    }
                });
                socket.on("close", () => {
                    if (this.socket !== socket) return;
                    this.rejectAll(
                        new Error("Processing worker connection closed"),
                    );
                    this.stop();
                });
                socket.on("error", () => {});
            });
            this.server = server;
            server.on("error", (error) => {
                clearTimeout(timeout);
                rejectPromise(error);
                this.stop();
            });
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    clearTimeout(timeout);
                    rejectPromise(new Error("Unable to open worker transport"));
                    this.stop();
                    return;
                }
                this.spawn(address.port, secret);
            });
        });
        return this.startPromise;
    }

    private spawn(port: number, secret: string) {
        const require = createRequire(import.meta.url);
        const electronPath = require("electron") as unknown as string;
        const workerPath = resolve(
            this.root,
            ".omx",
            "web-lab-worker",
            "worker.cjs",
        );
        const child = spawn(electronPath, [workerPath], {
            cwd: this.root,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                OPEN_CAPTURE_LAB_ROOT: this.root,
                OPEN_CAPTURE_LAB_PORT: String(port),
                OPEN_CAPTURE_LAB_SECRET: secret,
            },
        });
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (process.env.DEBUG_WEB_LAB) process.stdout.write(chunk);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            if (process.env.DEBUG_WEB_LAB) process.stderr.write(chunk);
        });
        child.on("error", (error) => {
            if (this.child !== child) return;
            this.rejectAll(error);
            this.stop();
        });
        child.on("exit", (code) => {
            if (this.child !== child) return;
            this.rejectAll(
                new Error(`Processing worker exited (${code ?? "unknown"})`),
            );
            this.stop();
        });
    }

    private consume(chunk: string) {
        this.output += chunk;
        let newline = this.output.indexOf("\n");
        while (newline >= 0) {
            const line = this.output.slice(0, newline).trim();
            this.output = this.output.slice(newline + 1);
            newline = this.output.indexOf("\n");
            if (!line.startsWith(PREFIX)) continue;
            let response: WorkerResponse;
            try {
                response = JSON.parse(
                    line.slice(PREFIX.length),
                ) as WorkerResponse;
            } catch {
                this.stop();
                return;
            }
            if (response.event === "ready" || typeof response.id !== "number")
                continue;
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (response.ok) pending.resolve(response.result);
            else
                pending.reject(
                    new Error(response.error ?? "Processing failed"),
                );
        }
    }

    private rejectAll(error: Error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function json(response: ServerResponse, status: number, body: unknown) {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(body));
}

function errorJson(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
) {
    json(response, status, { error: { code, message } });
}

function originAllowed(request: IncomingMessage) {
    const origin = request.headers.origin;
    return !origin || ALLOWED_ORIGINS.has(origin);
}

function readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                rejectPromise(new Error("REQUEST_TOO_LARGE"));
                request.resume();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            if (size > BODY_LIMIT) return;
            try {
                resolvePromise(
                    JSON.parse(Buffer.concat(chunks).toString("utf8")),
                );
            } catch {
                rejectPromise(new Error("INVALID_JSON"));
            }
        });
        request.on("error", rejectPromise);
    });
}

export function createLabProcessingPlugin(): Plugin {
    const root = process.cwd();
    const worker = new LabWorkerClient(root);
    return {
        name: "open-capture-lab-processing",
        configureServer(server) {
            server.httpServer?.once("close", () => worker.stop());
            server.middlewares.use(async (request, response, next) => {
                const url = new URL(request.url ?? "/", "http://127.0.0.1");
                if (
                    url.pathname !== "/api/status" &&
                    url.pathname !== "/api/process"
                ) {
                    next();
                    return;
                }
                if (!originAllowed(request)) {
                    errorJson(
                        response,
                        403,
                        "BAD_ORIGIN",
                        "Cross-origin processing requests are rejected",
                    );
                    return;
                }
                if (url.pathname === "/api/status") {
                    if (request.method !== "GET") {
                        errorJson(
                            response,
                            405,
                            "METHOD_NOT_ALLOWED",
                            "GET is required",
                        );
                        return;
                    }
                    try {
                        json(
                            response,
                            200,
                            await worker.request({ operation: "status" }),
                        );
                    } catch (error) {
                        errorJson(
                            response,
                            503,
                            "WORKER_UNAVAILABLE",
                            error instanceof Error
                                ? error.message
                                : String(error),
                        );
                    }
                    return;
                }
                if (request.method !== "POST") {
                    errorJson(
                        response,
                        405,
                        "METHOD_NOT_ALLOWED",
                        "POST is required",
                    );
                    return;
                }
                if (
                    !request.headers["content-type"]
                        ?.toLowerCase()
                        .startsWith("application/json")
                ) {
                    errorJson(
                        response,
                        415,
                        "UNSUPPORTED_MEDIA_TYPE",
                        "application/json is required",
                    );
                    return;
                }
                try {
                    const body = (await readBody(request)) as Record<
                        string,
                        unknown
                    >;
                    if (
                        !body ||
                        typeof body !== "object" ||
                        !OPERATIONS.has(String(body.operation))
                    ) {
                        errorJson(
                            response,
                            400,
                            "INVALID_OPERATION",
                            "Unsupported processing operation",
                        );
                        return;
                    }
                    json(response, 200, await worker.request(body));
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (message === "REQUEST_TOO_LARGE")
                        errorJson(
                            response,
                            413,
                            message,
                            "Request body exceeds 16 MiB",
                        );
                    else if (message === "INVALID_JSON")
                        errorJson(
                            response,
                            400,
                            message,
                            "Request body is not valid JSON",
                        );
                    else if (message === "Processing queue is full")
                        errorJson(response, 429, "QUEUE_FULL", message);
                    else errorJson(response, 422, "PROCESSING_FAILED", message);
                }
            });
        },
        closeBundle() {
            worker.stop();
        },
    };
}
