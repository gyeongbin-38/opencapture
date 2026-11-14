#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/vercel/sandbox}"
source "$ROOT/emsdk/emsdk_env.sh"
mkdir -p "$ROOT/output"
emcc "$ROOT/native/rar-wasm/bridge.c" \
  "$ROOT/libarchive-build/libarchive/libarchive.a" \
  -I"$ROOT/libarchive/libarchive" -I"$ROOT/libarchive-build" \
  -O3 --no-entry \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT='web,worker' \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s MAXIMUM_MEMORY=402653184 \
  -s ABORTING_MALLOC=0 \
  -s WASM_BIGINT=1 \
  -s MALLOC=emmalloc \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_oc_open","_oc_next","_oc_path","_oc_size","_oc_type","_oc_read","_oc_error","_oc_close"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8"]' \
  -o "$ROOT/output/rar-runtime.mjs"

cp "$ROOT/libarchive/COPYING" "$ROOT/output/LICENSE.libarchive"
cp "$ROOT/emsdk/LICENSE" "$ROOT/output/LICENSE.emsdk"
cp "$ROOT/native/rar-wasm/bridge.c" "$ROOT/output/bridge.c"
cd "$ROOT"
sha256sum output/rar-runtime.mjs output/rar-runtime.wasm output/LICENSE.libarchive output/LICENSE.emsdk output/bridge.c > output/SHA256SUMS
