import { promises as fs, renameSync } from "node:fs";

const transient = (error: unknown) =>
    ["EPERM", "EACCES", "EBUSY"].includes(
        (error as NodeJS.ErrnoException)?.code ?? "",
    );
const waitCell = new Int32Array(new SharedArrayBuffer(4));

export function replaceFileSync(
    source: string,
    target: string,
    replace = renameSync,
) {
    for (let attempt = 0; ; attempt++) {
        try {
            replace(source, target);
            return;
        } catch (error) {
            if (!transient(error) || attempt >= 9) throw error;
            Atomics.wait(waitCell, 0, 0, 8);
        }
    }
}

export async function replaceFile(source: string, target: string) {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.rename(source, target);
            return;
        } catch (error) {
            if (!transient(error) || attempt >= 9) throw error;
            await new Promise((resolve) => setTimeout(resolve, 8));
        }
    }
}
