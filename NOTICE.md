# Licenses and third-party notices

| Part | License |
|---|---|
| Rembrandt, including `engine/` and `brand/` (everything not listed below) | GNU GPL v3 or later — `LICENSE` |
| `native/LibRaw/`, `src/vendor/libraw/` | LibRaw, used under LGPL-2.1 (see below) |
| `src/vendor/mediapipe/` | MediaPipe Tasks Vision 1.0.1, Apache-2.0 |
| `models/` | MediaPipe / Google models, Apache-2.0 (see `models/README.md`) |
| `src/vendor/nsfw/` | TensorFlow.js 4.22.0, Apache-2.0; NSFWJS 4.3.0 model, MIT (see `src/vendor/nsfw/README.md`) |
| `src/fonts/` | Geist, Geist Mono, Antonio and Instrument Serif, SIL Open Font License 1.1 (`src/fonts/OFL.txt`) |

## Additional permission: app stores (GPL-3.0 section 7)
As an additional permission under section 7 of the GNU GPL version 3, you may convey Rembrandt, or a
work based on it, through an application store (such as Apple's App Store or Google Play) whose terms
of service or distribution add restrictions that would otherwise conflict with the GPL, provided that
the complete corresponding source code stays available under the GPL as the licence requires.
Contributions are accepted under the same terms, including this permission.

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

## TensorFlow.js 4.22.0 (Apache-2.0) and the NSFWJS model (MIT)
`src/vendor/nsfw/tf.min.js` is the unmodified TensorFlow.js browser bundle (source map reference removed), © Google LLC, licensed
under the Apache License 2.0 (`src/vendor/nsfw/LICENSE-tfjs`). `model.json` and
`group1-shard1of1.bin` are the MobileNetV2 model from NSFWJS 4.3.0, © 2019 Infinite Red, Inc.,
licensed under the MIT License (`src/vendor/nsfw/LICENSE-nsfwjs`), converted from the package's
JavaScript copies without changing the weights.

## Published methods used by the Rembrandt Engine
The engine is an independent implementation of published methods: sRGB (IEC 61966-2-1), ITU-R
BT.2020, CIE CAT16 (Li et al. 2017), Krystek's Planckian locus approximation (1985), Oklab
(B. Ottosson 2020, public domain), the dark channel prior (He, Sun & Tang 2009), the guided filter
(He, Sun & Tang 2010; He & Sun 2015) and Fritsch–Carlson monotone cubic interpolation (1980).

## RAWmakase (MIT)
Lens corrections (the built-in Fujifilm and Sony tables in `src/lens.js`, the radial model in
`engine/src/pipeline.js`) and spot removal (the Heal membrane, Clone and automatic source search in
`src/retouch.js`) are ported from RAWmakase, https://github.com/pch/rawmakase.

> MIT License
>
> Copyright (c) 2026 RAWmakase contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
