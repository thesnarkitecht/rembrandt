// Appearance: System (follow the OS / host), Light or Dark. The stylesheet does the rest.
const KEY = 'lumen:appearance';
const listeners = new Set();
const mq = window.matchMedia?.('(prefers-color-scheme: dark)');

export function getAppearance() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}
export function setAppearance(v) {
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  apply(v);
}
function apply(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.dataset.theme = v;
  else if (root.dataset.appTheme) delete root.dataset.theme; // only clear what we set
  if (v === 'light' || v === 'dark') root.dataset.appTheme = v; else delete root.dataset.appTheme;
  requestAnimationFrame(() => listeners.forEach((f) => f()));
}
export const onThemeChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

// Current value of a CSS custom property.
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// A CSS colour as [r, g, b] in 0–1 (sRGB).
export function cssRGB(name) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = cssVar(name) || '#000';
  const m = c.fillStyle.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  const p = c.fillStyle.match(/[\d.]+/g) || [0, 0, 0];
  return [p[0] / 255, p[1] / 255, p[2] / 255];
}

export function initTheme() {
  apply(getAppearance());
  mq?.addEventListener?.('change', () => listeners.forEach((f) => f()));
  // The host (e.g. claude.ai) may also switch data-theme.
  new MutationObserver(() => listeners.forEach((f) => f())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
