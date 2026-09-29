# Rembrandt Engine

The open-source develop pipeline behind [Rembrandt](../README.md): a scene-referred, GPU (WebGL2) photo
processing engine. Part of Rembrandt and under the same licence: GNU GPL v3 or later (see `../LICENSE`).

```
engine/src/color.js     colour science: Rec.2020/sRGB, Oklab, CAT16 white balance, display curve
engine/src/shaders.js   GLSL for every pass
engine/src/pipeline.js  settings -> uniforms, tone curve LUT, airlight estimation
engine/src/engine.js    WebGL2 runner with per-pass caching
```

## Pipeline

All processing happens in linear Rec.2020 (D65) scene light until the display transform.

1. **Input.** Linear sources (e.g. demosaiced RAW) enter as-is times a gain. Display-referred 8-bit
   images are un-tone-mapped with the exact inverse of the display curve, so an untouched JPEG
   round-trips unchanged.
2. **Dehaze** — dark channel prior (He et al. 2009) at quarter resolution, refined with a guided
   filter; negative values add a distance-weighted veil.
3. **Exposure.**
4. **Tone zones and clarity** — an edge-preserving base layer of log-luminance (guided filter,
   He et al. 2010) drives raised-cosine EV zones for blacks, shadows, highlights and whites;
   clarity scales the detail layer around middle grey. **Texture** boosts fine detail.
5. **White balance** — CAT16 adaptation from a Planckian/Duv illuminant to D65.
6. **Colour in OkLCh** — 8-band hue/saturation/luminance mixer, vibrance, saturation, 3-way grading,
   monochrome.
7. *(host passes — e.g. an application's local adjustments)*
8. **Final** — edge-aware noise reduction, sharpening, display transform
   `y = x^c / (x^c + k)` pinned at middle grey (contrast sets `c`) with a hue-preserving path to
   white, gamut mapping by chroma reduction in OkLCh, tone curves, vignette, grain.

## Use

```js
import { Engine } from './engine/src/engine.js';
const engine = new Engine(canvas);
await engine.setImage({ kind: 'display', bitmap }, { airlight: [1, 1, 1] });
engine.render(settings, { toImage, toCrop, scale: canvas.height });
```

`settings` is a plain object; see the header of `src/pipeline.js`. The screen mapping matrices
(`toImage`, `toCrop`) are 3x3 column-major matrices from canvas pixels to texture UV.
