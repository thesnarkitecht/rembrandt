// Small DOM, math and color helpers shared across the app.
import { isMobileApp } from './platform.js';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
export const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

export function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') n.innerHTML = v;
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function svgEl(tag, attrs = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}

export function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlain(v) && isPlain(base[k])) deepMerge(base[k], v);
    else base[k] = clone(v);
  }
  return base;
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

let versionCounter = Date.now();
export const nextVersion = () => ++versionCounter;

// ---------------------------------------------------------------- color

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export const hslCss = (h, s = 100, l = 50) => `hsl(${h} ${s}% ${l}%)`;

// Direction in Oklab a/b plane for a (HSL) hue angle, so color wheels match what users see.
export function hueDir(h) {
  const [r, g, b] = hsl2rgb(h, 1, 0.5).map(srgbToLinear);
  const [, A, B] = linearToOklab(r, g, b);
  const n = Math.hypot(A, B) || 1;
  return [A / n, B / n];
}

export function fmtSigned(v, digits = 0) {
  const s = Number(v).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

// Inside a claude.ai artifact, files go through the host's download capability;
// everywhere else a plain link download is used.
let downloadsCap = null;
export function warmDownloads() {
  if (window.claude?.use && !downloadsCap) downloadsCap = window.claude.use('downloads').catch(() => null);
}
export async function saveBlob(blob, name) {
  // Phone app: there's no downloads folder; hand the file to the share sheet (Save to Files, etc.).
  if (isMobileApp) {
    const t = window.__TAURI_INTERNALS__;
    const path = await t.invoke('stage_export', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-name': encodeURIComponent(name) } });
    await t.invoke('plugin:mobile|share', { paths: [path] });
    return;
  }
  warmDownloads();
  const dl = downloadsCap ? await downloadsCap : null;
  if (dl) {
    await dl.save({ filename: name, data: blob });
    return;
  }
  downloadBlob(blob, name);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
