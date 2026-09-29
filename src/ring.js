// Storage ring (donut chart) and byte formatting.
import { el, svgEl } from './util.js';

export const fmtBytes = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(0, Math.round(b / 1e3))} KB`);

// segments: [{ value, color }] out of `total`.
export function ring(segments, total, { size = 180, stroke = 16, top = '', bottom = '' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'ring', role: 'img', 'aria-label': `${top} ${bottom}`.trim() });
  svg.append(svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', style: 'stroke: var(--track)', 'stroke-width': stroke }));
  let off = 0;
  for (const s of segments) {
    const frac = total > 0 ? Math.min(1, s.value / total) : 0;
    const len = frac > 0 ? Math.max(frac * c, stroke * 0.6) : 0;
    if (!len) continue;
    svg.append(svgEl('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', style: `stroke: ${s.color}`, 'stroke-width': stroke, 'stroke-linecap': 'round',
      'stroke-dasharray': `${Math.max(0.01, len - stroke * 0.5)} ${c}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }));
    off += len;
  }
  return el('div', { class: 'ring-wrap', style: { width: `${size}px`, height: `${size}px` } }, svg,
    el('div', { class: 'ring-center' }, el('div', { class: 'ring-top' }, top), el('div', { class: 'ring-bottom' }, bottom)));
}
