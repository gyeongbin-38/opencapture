export type StartupCommand = { argv: string[]; first?: boolean };
export class StartupCommandQueue {
    private ready = false;
    private running = false;
    private commands: StartupCommand[] = [];
    constructor(
        private run: (command: StartupCommand) => Promise<void>,
        private idle: () => void,
        private error: (error: unknown) => void,
    ) {}
    get pending() {
        return this.commands.length + (this.running ? 1 : 0);
    }
    enqueue(argv: string[]) {
        this.commands.push({ argv: [...argv] });
        if (this.ready && !this.running) void this.drain();
    }
    start(argv: string[]) {
        this.commands.unshift({ argv: [...argv], first: true });
        this.ready = true;
        if (!this.running) void this.drain();
    }
    private async drain() {
        this.running = true;
        try {
            while (this.commands.length) {
                const command = this.commands.shift();
                if (!command) continue;
                try {
                    await this.run(command);
                } catch (error) {
                    this.error(error);
                }
            }
        } finally {
            this.running = false;
            this.idle();
        }
    }
}
