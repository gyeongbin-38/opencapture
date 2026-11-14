# Bounded RAR WebAssembly runtime

This bridge builds libarchive `v3.8.10` with Emscripten `4.0.21`. It exposes only the streaming RAR4/RAR5 reader ABI used by OpenCapture. The build disables Emscripten's filesystem, starts with a 16 MiB heap, caps growth at 384 MiB, rejects failed allocation, and restricts each output read to 1 MiB. The browser broker runs it in a dedicated Web Worker and waits for the main process to acknowledge every chunk.

`build.sh` is intended for the ephemeral, non-persistent build sandbox. Generated artifacts, upstream license, bridge source, and SHA-256 manifest are copied into `assets/runtime/rar-wasm/` after a successful build.
