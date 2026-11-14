#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/vercel/sandbox}"
LIBARCHIVE_TAG="v3.8.10"
EMSDK_TAG="4.0.21"

cd "$ROOT"
git clone --depth 1 --branch "$LIBARCHIVE_TAG" https://github.com/libarchive/libarchive.git libarchive
git clone --depth 1 --branch "$EMSDK_TAG" https://github.com/emscripten-core/emsdk.git emsdk
./emsdk/emsdk install "$EMSDK_TAG"
./emsdk/emsdk activate "$EMSDK_TAG"
source ./emsdk/emsdk_env.sh

emcmake cmake -S libarchive -B libarchive-build -G Ninja \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_TEST=OFF \
  -DENABLE_INSTALL=OFF \
  -DENABLE_TAR=OFF \
  -DENABLE_CPIO=OFF \
  -DENABLE_CAT=OFF \
  -DENABLE_OPENSSL=OFF \
  -DENABLE_LIBB2=OFF \
  -DENABLE_LZ4=OFF \
  -DENABLE_LZO=OFF \
  -DENABLE_LZMA=OFF \
  -DENABLE_ZSTD=OFF \
  -DENABLE_BZip2=OFF \
  -DENABLE_ZLIB=OFF \
  -DENABLE_LIBXML2=OFF \
  -DENABLE_EXPAT=OFF \
  -DENABLE_PCREPOSIX=OFF
cmake --build libarchive-build --target libarchive.a -j1

mkdir -p output
emcc native/rar-wasm/bridge.c libarchive-build/libarchive/libarchive.a \
  -Ilibarchive/libarchive -Ilibarchive-build \
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
  -o output/rar-runtime.mjs

cp libarchive/COPYING output/LICENSE.libarchive
cp emsdk/LICENSE output/LICENSE.emsdk
cp native/rar-wasm/bridge.c output/bridge.c
sha256sum output/rar-runtime.mjs output/rar-runtime.wasm output/LICENSE.libarchive output/LICENSE.emsdk output/bridge.c > output/SHA256SUMS
