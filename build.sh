#!/bin/sh
# Build the console pages. Needs clang (wasm32 + wasm-ld) and Python 3.10+; no Node.js.
# (Node and Playwright are used only by the optional developer smoke test at the end.)
# SPDX-License-Identifier: GPL-3.0-only
set -e
cd "$(dirname "$0")"
COMMON="--target=wasm32 -O3 -msimd128 -nostdlib -ffreestanding -Wall -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=65536"
clang $COMMON -Wl,--export-memory -Wl,--initial-memory=20971520 -o web/xpu.wasm src/xpu.c
clang $COMMON -DXPU_THREADS -matomics -mbulk-memory -Wl,--import-memory -Wl,--shared-memory \
  -Wl,--initial-memory=20971520 -Wl,--max-memory=20971520 -Wl,--export=__stack_pointer -o web/xpu-mt.wasm src/xpu.c
echo "built web/xpu.wasm ($(wc -c < web/xpu.wasm) B) web/xpu-mt.wasm ($(wc -c < web/xpu-mt.wasm) B)"
mkdir -p dist
python3 -B tools/bundle.py
# developer smoke test (Node + Playwright): the built pages must start with no errors
if [ "${SKIP_SMOKE:-0}" != "1" ]; then node tools/smoke.cjs; fi
