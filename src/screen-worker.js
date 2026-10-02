// Explicit-image check (classic worker), run on the device before a photo is synced to Cloud.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
// Model: NSFWJS MobileNetV2 (MIT) on TensorFlow.js (Apache-2.0); see vendor/nsfw/README.md.
// In: { id, bitmap }. Out: { id, scores: { drawing, hentai, neutral, porn, sexy } } or { id, error }.
/* global tf */
importScripts('./vendor/nsfw/tf.min.js');

const DIR = new URL('./vendor/nsfw/', self.location.href).href;
const CLASSES = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];
let model = null;

// Hosts that can't serve binaries may provide a base64 text copy of the weights.
async function weights() {
  const r = await fetch(DIR + 'group1-shard1of1.bin');
  if (r.ok) return r.arrayBuffer();
  const t = await fetch(DIR + 'group1-shard1of1.bin.b64.txt');
  if (!t.ok) throw new Error('The image check model is not available');
  const bin = atob((await t.text()).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function load() {
  return (model ||= (async () => {
    try { await tf.setBackend('webgl'); await tf.ready(); } catch { await tf.setBackend('cpu'); await tf.ready(); }
    const json = await (await fetch(DIR + 'model.json')).json();
    const m = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: json.weightsManifest[0].weights, weightData: await weights() }));
    tf.tidy(() => m.predict(tf.zeros([1, 224, 224, 3]))); // warm up
    return m;
  })().catch((e) => { model = null; throw e; }));
}

self.onmessage = async ({ data: { id, bitmap } }) => {
  try {
    const m = await load();
    const c = new OffscreenCanvas(224, 224);
    c.getContext('2d').drawImage(bitmap, 0, 0, 224, 224);
    bitmap.close?.();
    const out = tf.tidy(() => m.predict(tf.browser.fromPixels(c).toFloat().div(255).expandDims(0)).dataSync());
    self.postMessage({ id, scores: Object.fromEntries(CLASSES.map((k, i) => [k, out[i]])) });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
