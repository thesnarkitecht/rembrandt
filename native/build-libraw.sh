#!/usr/bin/env bash
# Builds LibRaw + the Rembrandt wrapper to single-threaded WebAssembly (no SharedArrayBuffer needed).
# Requires Emscripten (emcc) on PATH. Output: ../src/vendor/libraw/lumen-raw.{js,wasm}
set -euo pipefail
cd "$(dirname "$0")"
OUT=../src/vendor/libraw
mkdir -p "$OUT" build
OBJS=(libraw_datastream libraw_c_api cameralist fuji_compressed crx fp_dng decoders_libraw unpack unpack_thumb
  colorconst utils_libraw init_close_utils decoder_info open phaseone_processing thumb_utils tiff_writer
  subtract_black postprocessing_utils dcraw_process raw2image mem_image x3f_utils_patched x3f_parse_process
  read_utils curves utils_dcraw colordata canon_600 decoders_dcraw decoders_libraw_dcrdefs generic kodak_decoders
  dng smal load_mfbacks sony nikon samsung cr3_parser canon epson olympus leica fuji adobepano pentax p1
  makernotes exif_gps kodak tiff ciff mediumformat minolta identify_tools hasselblad_model normalize_model identify
  misc_parsers wblists postprocessing_aux postprocessing_utils_dcrdefs aspect_ratio misc_demosaic xtrans_demosaic
  ahd_demosaic dht_demosaic aahd_demosaic dcb_demosaic file_write ext_preprocess apply_profile)
SRCS=()
for o in "${OBJS[@]}"; do SRCS+=("$(find LibRaw/src -name "$o.cpp" | head -1)"); done
FLAGS=(-O3 -ILibRaw -w -DLIBRAW_NOTHREADS -DNO_LCMS -DNO_JASPER -DNO_JPEG -fwasm-exceptions)
pids=()
for s in "${SRCS[@]}"; do
  o="build/$(basename "$s" .cpp).o"
  if [ ! -f "$o" ] || [ "$s" -nt "$o" ]; then em++ "${FLAGS[@]}" -c "$s" -o "$o" & pids+=($!); fi
  while [ "$(jobs -rp | wc -l)" -ge "$(nproc)" ]; do sleep 0.2; done
done
for p in "${pids[@]}"; do wait "$p"; done
em++ "${FLAGS[@]}" lumen_raw.cpp build/*.o -o "$OUT/lumen-raw.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -sINITIAL_MEMORY=64MB -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,HEAPU16 -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sFILESYSTEM=0 -sSTACK_SIZE=4MB
ls -la "$OUT"
