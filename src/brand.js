// Product naming and the mark in one place; the UI reads them from here.
// The wordmark is REMBRANDT in capitals with wide tracking, as in the logo.
export const BRAND = {
  name: 'Rembrandt',
  company: 'the Rembrandt contributors',   // copyright line
  engine: 'Rembrandt Engine',
  // XMP namespace for our settings in sidecars. Keep it stable once sidecars exist in the wild.
  xmpNs: 'https://photography.work/ns/xmp/1.0/',
};

// The R mark (vector version of brand/r-mark.svg). Its gradient follows the theme through
// --mark-1/2/3, so it stays readable on light and dark backgrounds.
export const MARK_PATHS = ['M0 0H64A31.5 31.5 0 0 1 69.07 62.59L99 100H78L34.8 46H64A14.5 14.5 0 0 0 64 17H17Z', 'M0 35.1V100H59Z'];
let markN = 0;
export function markSvg() {
  const id = `rmark-${++markN}`;
  return `<svg viewBox="-4 -4 108 108" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="100" y1="0" x2="0" y2="100">`
    + '<stop offset="0" style="stop-color:var(--mark-1)"/><stop offset=".5" style="stop-color:var(--mark-2)"/><stop offset="1" style="stop-color:var(--mark-3)"/>'
    + `</linearGradient></defs>${MARK_PATHS.map((d) => `<path fill="url(#${id})" d="${d}"/>`).join('')}</svg>`;
}
