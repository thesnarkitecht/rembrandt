// Product naming and the mark in one place; the UI reads them from here.
// The wordmark is REMBRANDT in capitals with wide tracking, as in the logo.
export const BRAND = {
  name: 'Rembrandt',
  company: 'the Rembrandt contributors',   // copyright line
  engine: 'Rembrandt Engine',
  // XMP namespace for our settings in sidecars. Keep it stable once sidecars exist in the wild.
  xmpNs: 'https://photography.work/ns/xmp/1.0/',
};

// The R mark (vector version of brand/r-mark.svg), flat, in the theme's bronze (--mark-2) so it
// reads on light and dark backgrounds. brand/r-mark-halftone.svg is the large, dotted version.
export const MARK_PATHS = ['M0 0H64A31.5 31.5 0 0 1 69.07 62.59L99 100H78L34.8 46H64A14.5 14.5 0 0 0 64 17H17Z', 'M0 35.1V100H59Z'];
export function markSvg() {
  return `<svg viewBox="-4 -4 108 108" aria-hidden="true" style="color:var(--mark-2)">${MARK_PATHS.map((d) => `<path fill="currentColor" d="${d}"/>`).join('')}</svg>`;
}
