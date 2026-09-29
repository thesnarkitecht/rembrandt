# Licenses and third-party notices

| Part | License |
|---|---|
| Rembrandt, including `engine/` and `brand/` (everything not listed below) | GNU GPL v3 or later — `LICENSE` |
| `native/LibRaw/`, `src/vendor/libraw/` | LibRaw, used under LGPL-2.1 (see below) |
| `src/vendor/mediapipe/` | MediaPipe Tasks Vision 1.0.1, Apache-2.0 |
| `models/` | MediaPipe / Google models, Apache-2.0 (see `models/README.md`) |
| `src/fonts/` | Geist and Geist Mono, SIL Open Font License 1.1 (`src/fonts/OFL.txt`) |

## LibRaw 0.21.4 (CDDL-1.0 or LGPL-2.1)
© LibRaw LLC. `native/LibRaw/` contains the unmodified LibRaw 0.21.4 sources; `native/build-libraw.sh`
compiles them with `native/lumen_raw.cpp` into `src/vendor/libraw/lumen-raw.{js,wasm}`.
Rembrandt uses LibRaw under the terms of the GNU Lesser General Public License 2.1
(`native/LibRaw/LICENSE.LGPL`), which is compatible with Rembrandt's GPL-3.0-or-later. The LibRaw source code is available at https://www.libraw.org and in
this distribution under `native/LibRaw/`.

## MediaPipe Tasks Vision 1.0.1 and models (Apache-2.0)
© Google LLC. `src/vendor/mediapipe/` holds the unmodified `@mediapipe/tasks-vision` runtime
(source map reference removed); `models/` holds the unmodified model files listed in
`models/README.md`. Licensed under the Apache License 2.0 (`src/vendor/mediapipe/LICENSE`).

## Published methods used by the Rembrandt Engine
The engine is an independent implementation of published methods: sRGB (IEC 61966-2-1), ITU-R
BT.2020, CIE CAT16 (Li et al. 2017), Krystek's Planckian locus approximation (1985), Oklab
(B. Ottosson 2020, public domain), the dark channel prior (He, Sun & Tang 2009), the guided filter
(He, Sun & Tang 2010; He & Sun 2015) and Fritsch–Carlson monotone cubic interpolation (1980).
