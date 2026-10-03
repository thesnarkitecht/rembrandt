#!/usr/bin/env python3
"""Builds the Rembrandt brand files in brand/ from the R mark's geometry.

  python3 brand/src/make-brand.py        (needs fontTools and brotli: pip install fonttools brotli)

The mark keeps the original R outline. It comes in two treatments:
  * solid  - flat bronze, for small sizes (favicons, the app header)
  * halftone - the R drawn as bronze dots, bigger and lighter where the light falls (top right),
    like the website's paintings; for the app icon and large uses.
The wordmark is REMBRANDT in Antonio (SIL OFL 1.1), converted to outlines so it needs no font.
"""
import math, os, random
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
FONT = os.path.join(OUT, '..', 'src', 'fonts', 'antonio.woff2')
INK, CREAM = '#0B0A09', '#EEE8DE'
BRONZE = ['#A8712F', '#C98F4F', '#F4D292']         # shadow, mid, light (dark backgrounds)
BRONZE_LIGHT_BG = ['#6A4019', '#A8712F', '#C98F4F']  # the same steps for light backgrounds
MARK = ['M0 0H64A31.5 31.5 0 0 1 69.07 62.59L99 100H78L34.8 46H64A14.5 14.5 0 0 0 64 17H17Z', 'M0 35.1V100H59Z']

# ---- the R as polygons (arcs flattened) for the inside test
def arc(cx, cy, r, a0, a1, n=48):
    return [(cx + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]
cx, cy = 64, 31.5
outer = [(0, 0), (64, 0)] + arc(cx, cy, 31.5, -math.pi / 2, math.atan2(62.59 - cy, 69.07 - cx))[1:] + [(99, 100), (78, 100), (34.8, 46), (64, 46)] \
    + arc(cx, cy, 14.5, math.pi / 2, -math.pi / 2)[1:] + [(17, 17)]
tri = [(0, 35.1), (0, 100), (59, 100)]
def inside(poly, x, y):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def in_r(x, y): return inside(outer, x, y) or inside(tri, x, y)
def edge_dist(x, y):
    best = 9e9
    for poly in (outer, tri):
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i], poly[i - 1]
            dx, dy = x2 - x1, y2 - y1; L = dx * dx + dy * dy or 1
            t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L))
            best = min(best, math.hypot(x - x1 - t * dx, y - y1 - t * dy))
    return best

def halftone(step=3.4, palette=BRONZE):
    """Dots on a grid inside the R; light falls from the top right."""
    groups = {0: [], 1: [], 2: []}
    n = int(100 / step) + 1
    for j in range(n):
        for i in range(n):
            x, y = (i + 0.5) * step, (j + 0.5) * step
            if not in_r(x, y): continue
            light = max(0.0, min(1.0, 1 - math.hypot(100 - x, y) / 125))
            r = step * 0.5 * (0.74 + 0.24 * light)
            r = min(r, 0.25 * step + edge_dist(x, y))          # keep the outline crisp
            tier = 2 if light > 0.62 else 1 if light > 0.22 else 0
            groups[tier].append(f'M{x + r:.2f} {y:.2f}a{r:.2f} {r:.2f} 0 1 0 {-2 * r:.2f} 0a{r:.2f} {r:.2f} 0 1 0 {2 * r:.2f} 0')
    return ''.join(f'<path fill="{palette[k]}" d="{"".join(v)}"/>' for k, v in groups.items() if v)

def solid(fill): return ''.join(f'<path fill="{fill}" d="{d}"/>' for d in MARK)

# ---- REMBRANDT outlined in Antonio
def wordmark(text='REMBRANDT', wght=700, tracking=0.07):
    f = TTFont(FONT)
    if 'fvar' in f: f = instancer.instantiateVariableFont(f, {'wght': wght})
    gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
    cap = f['OS/2'].sCapHeight or upm * 0.7
    x, parts = 0, []
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, cap)))
        parts.append(pen.getCommands())
        x += gs[g].width + tracking * upm
    x -= tracking * upm
    return ''.join(parts), x, cap   # path, width, cap height (font units)

# ---- topographic lines for the icon tile
def noise(x, y, seed=7):
    def h(i, j):
        v = math.sin(i * 127.1 + j * 311.7 + seed * 17.3) * 43758.5453
        return v - math.floor(v)
    xi, yi = math.floor(x), math.floor(y); xf, yf = x - xi, y - yi
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a, b, c, d = h(xi, yi), h(xi + 1, yi), h(xi, yi + 1), h(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
def contours(size, cell=8, levels=(0.32, 0.42, 0.52, 0.62)):
    n = size // cell
    val = [[noise(i * 0.07, j * 0.07) * 0.65 + noise(i * 0.15 + 5, j * 0.15 - 2) * 0.35 for i in range(n + 1)] for j in range(n + 1)]
    d = []
    for lv in levels:
        for j in range(n):
            for i in range(n):
                a, b, c, e = val[j][i], val[j][i + 1], val[j + 1][i + 1], val[j + 1][i]
                pts = []
                for (p, q, x1, y1, x2, y2) in ((a, b, i, j, i + 1, j), (b, c, i + 1, j, i + 1, j + 1), (c, e, i + 1, j + 1, i, j + 1), (e, a, i, j + 1, i, j)):
                    if (p < lv) != (q < lv):
                        t = (lv - p) / (q - p); pts.append(((x1 + (x2 - x1) * t) * cell, (y1 + (y2 - y1) * t) * cell))
                for k in range(0, len(pts) - 1, 2):
                    d.append(f'M{pts[k][0]:.1f} {pts[k][1]:.1f}L{pts[k + 1][0]:.1f} {pts[k + 1][1]:.1f}')
    return ''.join(d)

def write(name, svg):
    with open(os.path.join(OUT, name), 'w') as fh: fh.write(svg + '\n')
    print('wrote', name)

VB = 'viewBox="-4 -4 108 108"'
write('r-mark.svg', f'<svg xmlns="http://www.w3.org/2000/svg" {VB} role="img" aria-label="Rembrandt">\n  <!-- Flat bronze for small sizes. On light backgrounds use #8A5829. -->\n  {solid(BRONZE[1])}\n</svg>')
write('r-mark-halftone.svg', f'<svg xmlns="http://www.w3.org/2000/svg" {VB} role="img" aria-label="Rembrandt">\n  <!-- For dark backgrounds, 64 px and up. -->\n  {halftone()}\n</svg>')
write('r-mark-halftone-light.svg', f'<svg xmlns="http://www.w3.org/2000/svg" {VB} role="img" aria-label="Rembrandt">\n  <!-- For light backgrounds, 64 px and up. -->\n  {halftone(palette=BRONZE_LIGHT_BG)}\n</svg>')

# Lockup: the halftone R and the wordmark, cap height = mark height.
wd, ww, cap = wordmark()
s = 100 / cap; gap = 34
W = 100 + gap + ww * s
for name, ink, pal in (('rembrandt.svg', CREAM, BRONZE), ('rembrandt-light.svg', '#17120C', BRONZE_LIGHT_BG)):
    write(name, f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 {W + 12:.1f} 112" role="img" aria-label="Rembrandt">\n'
          f'  {halftone(palette=pal)}\n  <path fill="{ink}" transform="translate({100 + gap} 0) scale({s:.5f})" d="{wd}"/>\n</svg>')

# App icon: warm ink tile, faint contour lines, the halftone R, a hairline frame.
tile = 824
icon = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
        f'  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A130C"/><stop offset="1" stop-color="#0B0A09"/></linearGradient>\n'
        f'    <clipPath id="c"><rect x="100" y="100" width="{tile}" height="{tile}" rx="186"/></clipPath></defs>\n'
        f'  <rect x="100" y="100" width="{tile}" height="{tile}" rx="186" fill="url(#bg)"/>\n'
        f'  <g clip-path="url(#c)"><path transform="translate(100 100)" fill="none" stroke="#EEE8DE" stroke-opacity=".07" stroke-width="2" d="{contours(tile)}"/></g>\n'
        f'  <rect x="101" y="101" width="{tile - 2}" height="{tile - 2}" rx="185" fill="none" stroke="#C98F4F" stroke-opacity=".28" stroke-width="2"/>\n'
        f'  <g transform="translate(290 288) scale(4.45)">{halftone(step=3.1)}</g>\n</svg>')
write('app-icon.svg', icon)
# Phones: a full square (iOS rejects transparent corners and rounds it itself; Android masks it).
write('app-icon-mobile.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
      f'  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A130C"/><stop offset="1" stop-color="#0B0A09"/></linearGradient></defs>\n'
      f'  <rect width="1024" height="1024" fill="url(#bg)"/>\n'
      f'  <path fill="none" stroke="#EEE8DE" stroke-opacity=".07" stroke-width="2.4" d="{contours(1024)}"/>\n'
      f'  <g transform="translate(262 258) scale(5)">{halftone(step=3.1)}</g>\n</svg>')
# Assets the app itself serves (the build copies src/, not brand/).
APP_ART = os.path.join(OUT, '..', 'src', 'art')
with open(os.path.join(APP_ART, 'r-mark-halftone.svg'), 'w') as fh:
    fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" {VB}>{halftone()}</svg>\n')
with open(os.path.join(APP_ART, 'topo.svg'), 'w') as fh:   # used as a CSS mask, so its colour comes from the theme
    fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><path fill="none" stroke="#000" stroke-width="1.4" d="{contours(1600, cell=16)}"/></svg>\n')
print('wrote src/art/r-mark-halftone.svg, src/art/topo.svg')
# Small sizes (64 px and below): the same tile with the flat R, which stays sharp where dots would blur.
write('app-icon-small.svg', icon.split('  <g transform')[0] + f'  <g transform="translate(290 288) scale(4.45)">{solid(BRONZE[1])}</g>\n</svg>')
