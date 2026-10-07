# Lensfun lens data

`lensfun.json` is converted from the [Lensfun](https://lensfun.github.io) database (`data/db/*.xml`),
© the Lensfun contributors, licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). This file is shared under the same
licence.

Format: `{ cameras: [[maker, model, cropFactor]], lenses: [{ k: maker, n: model, c: cropFactor,
a: aspectRatio, d: distortion, t: tca, v: vignetting }] }`. Distortion rows are `[focal, model, ...terms]`
with model `p` (ptlens a, b, c), `3` (poly3 k1) or `5` (poly5 k1, k2); TCA rows `[focal, '3', vr, vb, cr,
cb, br, bb]` or `[focal, 'l', kr, kb]`; vignetting rows `[focal, aperture, k1, k2, k3]` (pa model, the
farthest calibrated distance).
