// Thin C API over LibRaw for WebAssembly.
// Decodes a RAW file from memory to linear (gamma 1.0) 16-bit sRGB-primaries RGB,
// using the camera's white balance and color matrix. No tone curve, no auto-brightening:
// the result is scene-referred data for Rembrandt's darktable-style pipeline.

#include <cstdio>
#include <cstring>
#include <cmath>
#include <emscripten/emscripten.h>
#include "libraw/libraw.h"

static LibRaw *R = nullptr;
static libraw_processed_image_t *IMG = nullptr;
static char META[4096];

static void release() {
  if (IMG) { LibRaw::dcraw_clear_mem(IMG); IMG = nullptr; }
  if (R) { delete R; R = nullptr; }
}

static void json_str(char *dst, size_t n, const char *s) {
  size_t j = 0;
  for (size_t i = 0; s && s[i] && j + 2 < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { dst[j++] = '\\'; dst[j++] = c; }
    else if (c >= 0x20 && c < 0x7f) dst[j++] = c;
  }
  dst[j] = 0;
}

extern "C" {

// quality: LibRaw user_qual (0 linear, 1 VNG, 2 PPG, 3 AHD, 4 DCB, 11 DHT, 12 AAHD). half: 1 = half size.
// Returns 0 on success, otherwise a LibRaw error code (see lr_error).
EMSCRIPTEN_KEEPALIVE int lr_decode(const unsigned char *buf, int size, int quality, int half) {
  release();
  R = new LibRaw();
  libraw_output_params_t &o = R->imgdata.params;
  o.output_bps = 16;
  o.gamm[0] = 1.0;
  o.gamm[1] = 1.0;
  o.no_auto_bright = 1;
  o.use_camera_wb = 1;
  o.use_camera_matrix = 1;
  o.output_color = 1; // sRGB primaries (linear, since gamma is 1)
  o.highlight = 0;    // clip; highlight reconstruction happens later in the pipeline
  o.user_qual = quality;
  o.half_size = half;
  int r = R->open_buffer(buf, (size_t)size);
  if (r != LIBRAW_SUCCESS) return r;
  r = R->unpack();
  if (r != LIBRAW_SUCCESS) return r;
  r = R->dcraw_process();
  if (r != LIBRAW_SUCCESS) return r;
  IMG = R->dcraw_make_mem_image(&r);
  if (!IMG) return r ? r : -1;
  if (IMG->type != LIBRAW_IMAGE_BITMAP || IMG->colors != 3 || IMG->bits != 16) return -2;

  const libraw_iparams_t &ip = R->imgdata.idata;
  const libraw_imgother_t &ot = R->imgdata.other;
  const libraw_lensinfo_t &ln = R->imgdata.lens;
  char make[128], model[128], lens[256];
  json_str(make, sizeof make, ip.make);
  json_str(model, sizeof model, ip.model);
  json_str(lens, sizeof lens, ln.Lens);
  float baseline = R->imgdata.color.dng_levels.baseline_exposure;
  if (!std::isfinite(baseline)) baseline = 0.f;
  snprintf(META, sizeof META,
           "{\"make\":\"%s\",\"model\":\"%s\",\"lens\":\"%s\",\"iso\":%g,\"shutter\":%g,\"aperture\":%g,"
           "\"focal\":%g,\"timestamp\":%lld,\"flip\":%d,\"baselineExposure\":%g,\"width\":%d,\"height\":%d}",
           make, model, lens, ot.iso_speed, ot.shutter, ot.aperture, ot.focal_len, (long long)ot.timestamp,
           R->imgdata.sizes.flip, baseline, IMG->width, IMG->height);
  // Free LibRaw's working buffers; keep only the output image.
  R->recycle();
  return 0;
}

EMSCRIPTEN_KEEPALIVE int lr_width() { return IMG ? IMG->width : 0; }
EMSCRIPTEN_KEEPALIVE int lr_height() { return IMG ? IMG->height : 0; }
EMSCRIPTEN_KEEPALIVE const unsigned short *lr_data() { return IMG ? (const unsigned short *)IMG->data : nullptr; }
EMSCRIPTEN_KEEPALIVE const char *lr_meta() { return META; }
EMSCRIPTEN_KEEPALIVE const char *lr_error(int code) { return code == -2 ? "Unsupported output format" : libraw_strerror(code); }
EMSCRIPTEN_KEEPALIVE const char *lr_version() { return LibRaw::version(); }
EMSCRIPTEN_KEEPALIVE void lr_free() { release(); }
}
