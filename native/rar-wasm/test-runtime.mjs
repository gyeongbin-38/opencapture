import fs from "node:fs";
import assert from "node:assert/strict";
import createModule from "/vercel/sandbox/output/rar-runtime-node.mjs";

const module = await createModule();
const chunkCapacity = 1024 * 1024;
assert.ok(module.HEAPU8.buffer.byteLength <= 16 * 1024 * 1024);
const growthPointer = module._malloc(32 * 1024 * 1024);
assert.ok(growthPointer, "WASM memory did not grow on demand");
assert.ok(module.HEAPU8.buffer.byteLength >= 32 * 1024 * 1024);
assert.ok(module.HEAPU8.buffer.byteLength <= 384 * 1024 * 1024);
module._free(growthPointer);

function run(name, expectedSuccess) {
    const input = fs.readFileSync(`/vercel/sandbox/fixtures/${name}`);
    const inputPointer = module._malloc(input.length);
    const chunkPointer = module._malloc(chunkCapacity);
    assert.ok(inputPointer && chunkPointer);
    module.HEAPU8.set(input, inputPointer);
    let files = 0;
    let bytes = 0;
    let error = "";
    try {
        if (!module._oc_open(inputPointer, input.length)) {
            error = module.UTF8ToString(module._oc_error());
        } else {
            while (true) {
                const next = module._oc_next();
                if (next === 0) break;
                if (next < 0) {
                    error = module.UTF8ToString(module._oc_error());
                    break;
                }
                const path = module.UTF8ToString(module._oc_path());
                const size = Number(module._oc_size());
                const type = module._oc_type();
                assert.ok(path && !path.includes("\uFFFD"));
                assert.ok(size >= 0 && size <= 256 * 1024 * 1024);
                if (type === 1) {
                    files += 1;
                    let entryBytes = 0;
                    while (true) {
                        const count = module._oc_read(chunkPointer, chunkCapacity);
                        assert.ok(count <= chunkCapacity);
                        if (count < 0) {
                            error = module.UTF8ToString(module._oc_error());
                            break;
                        }
                        if (count === 0) break;
                        entryBytes += count;
                        bytes += count;
                    }
                    if (!error) assert.equal(entryBytes, size);
                } else {
                    assert.equal(type, 2);
                }
                if (error) break;
            }
        }
    } finally {
        module._oc_close();
        module._free(chunkPointer);
        module._free(inputPointer);
    }
    if (expectedSuccess) {
        assert.equal(error, "", `${name}: ${error}`);
        assert.ok(files > 0 && bytes > 0);
    } else {
        assert.match(
            error,
            /encrypt|passphrase|damaged|failed|invalid|ended|truncated/i,
        );
    }
    console.log(JSON.stringify({ name, files, bytes, error }));
}

run("rar4.rar", true);
run("rar5.rar", true);
run("rar4-encrypted.rar", false);
run("rar5-encrypted.rar", false);

const original = fs.readFileSync("/vercel/sandbox/fixtures/rar5.rar");
fs.writeFileSync(
    "/vercel/sandbox/fixtures/rar5-truncated.rar",
    original.subarray(0, Math.floor(original.length / 2)),
);
run("rar5-truncated.rar", false);

const glue = fs.readFileSync(
    "/vercel/sandbox/output/rar-runtime.mjs",
    "utf8",
);
assert.ok(glue.includes("402653184"), "384 MiB maximum memory missing");
console.log("bounded RAR runtime fixtures passed");
