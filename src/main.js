// App controller: image library, view (zoom/pan), tools, history, keyboard, persistence.
import { Engine } from '../engine/src/engine.js';
import { BRAND } from './brand.js';
import { planName, isPaid } from './pricing.js';
import { gated, updateGate } from './hosted-gate.js';
import { readLensProfile } from './lens.js';
import { isMobileApp, isTouch } from './platform.js';
import { refreshUnlock, isUnlocked } from './unlock.js';
import { syncStoreSubscriptions } from './subscriptions.js';
import { initTheme, onThemeChange, cssRGB } from './theme.js';
import { localAdjustments } from './local-adjust.js';
import { ai } from './ai/ai.js';
import { lensPass, chain, setBackgroundImage, hasBackgroundImage, quality as lensQuality, lensActive } from './ai/lens.js';
import { refocusPass, refocusActive } from './ai/refocus.js';
import { studioPass, motionPass } from './ai/studio.js';
import { buildAIPanel } from './ai/panel-ai.js';
import { decodeFile, decodeRawLinear, sampleData, thumbnail, ACCEPT, RAW_EXT } from './loader.js';
import * as folders from './folders.js';
import { isPhotoName } from './folders.js';
import { readXmpSettings, crsToParams, embeddedXmp, sidecarNames, buildXmp } from './xmp.js';
import { catalogIndex } from './lrcat.js';
import { openImport } from './import-hub.js';
import { CLOUD_SOURCES, pickLinked, sourceName } from './import-cloud.js';
import * as batch from './batch.js';
import * as adobe from './adobe.js';
import { openExternal } from './account-online.js';
import { startUpdateChecks, updateState } from './update-check.js';
import { defaultParams, withSettings, developSettings, effectiveParams } from './params.js';
import * as catalog from './catalog.js';
import { buildLibrary } from './library.js';
import { ring, fmtBytes } from './ring.js';
import { openShare } from './share.js';
import { paintAvatar, prefs } from './account.js';
import { buildAccountPage } from './account-page.js';
import { listOnlineOriginals } from './backend/account-api.js';
import * as cloud from './cloud.js';
import * as syncCheck from './sync-check.js';
import * as sb from './backend/supabase.js';
import { backendConfigured, CONFIG } from './config.js';
import * as albums from './albums.js';
import { A, qToP, pToUV, rotatedBounds, cropUVToQ, fitCrop } from './geometry.js';
import { buildEditPanel } from './panel-edit.js';
import { buildCropPanel, CropOverlay, refitCrop } from './tool-crop.js';
import { buildMaskPanel, MaskOverlay, activeMask, removeMask, applyPick, addMask } from './tool-masks.js';
import { retouchPasses } from './retouch.js';
import { RetouchOverlay, buildRetouchPanel, retouchState, deleteSelected, newSourceForSelected } from './tool-retouch.js';
import { buildPresetsPanel, allPresets } from './panel-presets.js';
import { computeHistogram, drawHistogram } from './histogram.js';
import { openExport, renderExport } from './export.js';
import { el, svgEl, clamp, clone, debounce, setPath, srgbToLinear, uid, warmDownloads, deepMerge } from './util.js';
import { icon } from './icons.js';
import { sliderHooks, closeMenu, popMenu } from './ui.js';
import { displayToScene, solveWhiteBalance, toneInv, MIDDLE_GREY as GREY } from '../engine/src/color.js';
import { estimateAirlight } from '../engine/src/pipeline.js';

const $ = (id) => document.getElementById(id);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

class History {
  constructor(limit = 250) { this.stack = []; this.i = -1; this.limit = limit; }
  reset(state) { this.stack = [JSON.stringify(state)]; this.i = 0; }
  push(state) {
    const s = JSON.stringify(state);
    if (s === this.stack[this.i]) return false;
    this.stack.length = this.i + 1;
    this.stack.push(s);
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
    return true;
  }
  undo() { return this.i > 0 ? JSON.parse(this.stack[--this.i]) : null; }
  redo() { return this.i < this.stack.length - 1 ? JSON.parse(this.stack[++this.i]) : null; }
  get canUndo() { return this.i > 0; }
  get canRedo() { return this.i < this.stack.length - 1; }
}

const viewer = $('viewer');
const canvas = $('gl');
const overlay = $('overlay');

const app = {
  images: [],
  cur: -1,
  img: null,
  params: null,
  preview: null,
  hist: null,
  engine: null,
  panel: null,
  clipboard: null,
  m: null,
  history: new History(),
  state: {
    tool: 'edit', before: false, compare: 'off', splitX: 0.5, clip: false, showOverlay: true, sliding: false,
    activeMaskId: null, activeComp: 0, pick: null,
    brush: { size: 25, feather: 50, flow: 80, erase: false },
  },
  view: { mode: 'edit', fit: true, scale: 1, pan: [0, 0], fitScale: 1 },

  // ------------------------------------------------------------ edits
  set(path, v) { setPath(this.params, path, v); this.requestRender(); },
  // The camera's built-in lens correction for the open photo (src/lens.js), or null.
  lensProfile() { return this.images[this.cur]?.lensProfile || null; },

  commit() {
    if (!this.params) return;
    if (this.history.push(this.params)) {
      this.persist();
      this.updateUndo();
    }
  },

  restore(p) {
    if (!p) return;
    this.params = p;
    if (!p.masks.some((m) => m.id === this.state.activeMaskId)) {
      this.state.activeMaskId = p.masks[p.masks.length - 1]?.id || null;
      this.state.activeComp = 0;
    }
    this.persist();
    this.updateUndo();
    this.rebuildPanel();
    this.requestRender();
  },
  undo() { const p = this.history.undo(); if (p) { this.restore(p); this.toast('Undo'); } },
  redo() { const p = this.history.redo(); if (p) { this.restore(p); this.toast('Redo'); } },

  updateUndo() {
    $('btnUndo').disabled = !this.history.canUndo;
    $('btnRedo').disabled = !this.history.canRedo;
  },

  persist: debounce(function persist() {
    const e = app.images[app.cur];
    if (!e || !app.params) return;
    e.params = app.params;
    e.edited = true;
    e.updatedAt = Date.now();
    catalog.updatePhoto(e.id, { params: app.params, edited: true, updatedAt: e.updatedAt }).catch(() => {});
    cloud.pushPhoto(e);
    queueSidecar(e);
    saveThumb();
  }, 400),

  previewSettings(s) {
    this.preview = s ? withSettings(this.params, s, this.img.aspect) : null;
    this.requestRender();
  },
  applySettings(s, name) {
    this.params = withSettings(this.params, s, this.img.aspect);
    this.commit();
    this.requestRender();
    if (name) this.toast(`Applied “${name}”`);
  },
  copySettings(choose = false) {
    const e = this.images[this.cur];
    if (e && this.params) copyEditsFrom(e.id, choose);
  },
  pasteSettings() {
    const e = this.images[this.cur];
    if (e && this.params) pasteEditsTo([e.id]);
  },
  resetAll() {
    if (!this.img) return;
    this.params = defaultParams(this.img.aspect);
    this.state.activeMaskId = null;
    this.commit();
    this.rebuildPanel();
    this.fitView();
    this.toast('All edits reset');
  },

  // ------------------------------------------------------------ panels & tools
  setTool(t) {
    if (!this.img && t !== 'edit') return;
    if (this.state.tool === t && this.panel) return;
    this.state.tool = t;
    this.state.pick = null;
    document.querySelectorAll('.rail [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    viewer.dataset.tool = t;
    if (t === 'masks' && !activeMask(this) && this.params?.masks.length) this.state.activeMaskId = this.params.masks[this.params.masks.length - 1].id;
    this.buildPanel();
    this.fitView();
  },
  buildPanel() {
    const body = $('panelBody');
    body.textContent = '';
    if (!this.params) { this.panel = null; return; }
    const t = this.state.tool;
    this.panel = t === 'crop' ? buildCropPanel(this) : t === 'masks' ? buildMaskPanel(this) : t === 'retouch' ? buildRetouchPanel(this) : t === 'presets' ? buildPresetsPanel(this) : t === 'ai' ? buildAIPanel(this) : buildEditPanel(this);
    body.append(this.panel.el);
  },
  refreshPanel() { this.panel?.refresh(); },
  rebuildPanel() {
    if (this.panel?.rebuild) this.panel.rebuild();
    else this.panel?.refresh();
  },

  setGroupOn(g, on) {
    if (!this.params) return;
    this.params.off = { ...(this.params.off || {}), [g]: !on };
    if (on) delete this.params.off[g];
    this.commit();
    this.requestRender();
  },

  // ------------------------------------------------------------ AI
  ai,
  aiError: null,
  aiEnsure() {
    const e = this.images[this.cur];
    if (!e || !this.params) return;
    ai.ensure(e, this.params).then(() => { this.aiError = null; this.requestRender(); this.refreshPanel(); }, (err) => this.aiFailed(err));
  },
  aiFailed(err) {
    console.error(err);
    this.aiError = err?.message || String(err);
    this.toast(`AI analysis failed: ${this.aiError}`);
    this.refreshPanel();
  },
  aiStatus(op, text) {
    const e = this.images[this.cur];
    return ai.busy && !ai.has(e, op) ? 'Analyzing photo on this device…' : text;
  },
  aiFocus() { return ai.focusDepth(this.images[this.cur]); },
  aiQuickMask(type) {
    this.setTool('masks');
    addMask(this, type);
  },
  chooseBackground() {
    const input = el('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      const key = 'bg:' + catalog.photoKey(f);
      await catalog.storeFile(key, f);
      await setBackgroundImage(this.engine, key, f);
      Object.assign(this.params.ai.bg, { mode: 'image', image: key });
      this.aiEnsure();
      this.commit(); this.refreshPanel(); this.requestRender();
    });
    input.click();
  },

  // ------------------------------------------------------------ picking
  startPick(kind) {
    this.state.pick = kind;
    viewer.classList.add('picking');
    this.toast(kind === 'sun' ? 'Click where the light comes from' : kind === 'focus' ? 'Click where the photo should be in focus' : kind === 'wb' ? 'Click something that should be neutral grey or white' : kind === 'color' ? 'Click the color to select' : 'Click a tone to select');
  },
  pickWhiteBalance() { if (this.img) this.startPick('wb'); },
  finishPick(uv) {
    const kind = this.state.pick;
    this.state.pick = null;
    viewer.classList.remove('picking');
    if (!kind || uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return;
    if (kind === 'sun') {
      Object.assign(this.params.ai.rays, { x: Math.round(uv[0] * 1000) / 1000, y: Math.round(uv[1] * 1000) / 1000 });
      if (!this.params.ai.rays.amount) this.params.ai.rays.amount = 50;
      this.aiEnsure(); this.commit(); this.refreshPanel(); this.requestRender();
      return;
    }
    if (kind === 'focus') {
      const e = this.images[this.cur];
      const set = () => {
        const d = ai.depthAt(e, uv);
        if (d == null) return;
        this.params.ai.blur.focus = Math.round(d * 1000) / 1000;
        if (!this.params.ai.blur.amount) this.params.ai.blur.amount = 50;
        this.commit(); this.refreshPanel(); this.requestRender();
      };
      if (ai.has(e, 'depth')) set();
      else ai.analyze(e, 'depth').then(set, (err) => this.aiFailed(err));
      return;
    }
    if (kind === 'wb') {
      const { temp, tint } = solveWhiteBalance(displayToScene(this.sourceAt(uv)));
      this.params.temp = Math.round(clamp(temp, -100, 100));
      this.params.tint = Math.round(clamp(tint, -100, 100));
      this.commit();
      this.refreshPanel();
      this.requestRender();
    } else {
      applyPick(this, kind, uv);
    }
  },
  sourceAt([u, v]) {
    const s = this.images[this.cur]?.sample;
    if (!s) return [0.18, 0.18, 0.18];
    const cx = clamp(Math.floor(u * s.w), 0, s.w - 1), cy = clamp(Math.floor(v * s.h), 0, s.h - 1);
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const i = (y * s.w + x) * 4;
        for (let c = 0; c < 3; c++) acc[c] += srgbToLinear(s.data[i + c] / 255);
        n++;
      }
    }
    return acc.map((a) => a / n);
  },

  autoTone() {
    const s = this.images[this.cur]?.sample;
    if (!s) return;
    const evs = [];
    const step = Math.max(1, Math.floor((s.w * s.h) / 60000)) * 4;
    for (let i = 0; i < s.data.length; i += step) {
      const Y = 0.2126 * srgbToLinear(s.data[i] / 255) + 0.7152 * srgbToLinear(s.data[i + 1] / 255) + 0.0722 * srgbToLinear(s.data[i + 2] / 255);
      evs.push(Math.log2(Math.max(toneInv(Y), 1e-5) / GREY));
    }
    evs.sort((a, b) => a - b);
    const q = (t) => evs[Math.min(evs.length - 1, Math.floor(t * evs.length))];
    const med = q(0.5), lo = q(0.02), hi = q(0.98);
    const p = this.params;
    p.exposure = Math.round(clamp((-0.25 - med) * 0.75, -2.5, 2.5) * 100) / 100;
    const h2 = hi + p.exposure, l2 = lo + p.exposure;
    p.highlights = h2 > 2.8 ? -Math.round(clamp((h2 - 2.8) * 30, 0, 70)) : 0;
    p.whites = h2 < 1.8 ? Math.round(clamp((1.8 - h2) * 25, 0, 40)) : 0;
    p.shadows = l2 < -4.2 ? Math.round(clamp((-4.2 - l2) * 18, 0, 55)) : 0;
    p.blacks = l2 > -3.2 ? -Math.round(clamp((l2 + 3.2) * 20, 0, 40)) : 0;
    p.contrast = hi - lo < 5.5 ? Math.round(clamp((5.5 - (hi - lo)) * 9, 0, 30)) : 0;
    p.vibrance = Math.max(p.vibrance, 12);
    this.commit();
    this.refreshPanel();
    this.requestRender();
    this.toast('Auto settings applied');
  },

  // ------------------------------------------------------------ view
  fitView() { this.view.fit = true; this.requestRender(); },

  // pane: {x0, w} in device px — the whole canvas, or one half in side-by-side compare.
  computeView(p, pane = { x0: 0, w: canvas.width }) {
    const a = this.img.aspect, g = p.geometry;
    const cropMode = this.state.tool === 'crop';
    const cw = pane.w, ch = canvas.height, x0 = pane.x0;
    this.view.pane = pane;
    const frame = cropMode ? { cx: 0, cy: 0, ...rotatedBounds(a, { ...g, angle: 0 }) } : g.crop;
    const pad = cropMode ? 0.84 : 0.94;
    this.view.fitScale = Math.min(cw / frame.w, ch / frame.h) * pad;
    if (this.view.fit) { this.view.scale = this.view.fitScale; this.view.pan = [0, 0]; }
    const { scale, pan } = this.view;
    const screenToQ = [1 / scale, 0, 0, 1 / scale, frame.cx - (cw / 2 + pan[0]) / scale, frame.cy - (ch / 2 + pan[1]) / scale];
    const fragToScreen = [1, 0, 0, -1, -x0, ch];
    const qp = qToP(g);
    const d = DPR();
    const cssToQ = A.chain(screenToQ, A.translate(-x0, 0), A.scale(d));
    const cssToP = A.mul(qp, cssToQ);
    this.m = { cssToQ, qToCss: A.inv(cssToQ), cssToP, pToCss: A.inv(cssToP), cssToUV: A.mul(pToUV(a), cssToP) };
    return {
      toImage: A.mat3(A.chain(pToUV(a), qp, screenToQ, fragToScreen)),
      toCrop: A.mat3(A.chain(A.inv(cropUVToQ(g.crop)), screenToQ, fragToScreen)),
      cropTest: !cropMode,
      scale, // device px per image-height unit
    };
  },
  cssToQ(x, y) { return A.apply(this.m.cssToQ, x, y); },
  cssToP(x, y) { return A.apply(this.m.cssToP, x, y); },
  cssToUV(x, y) { return A.apply(this.m.cssToUV, x, y); },

  outputMats(p, w, h) { return outputMatsFor(p, this.img.aspect, w, h); },

  zoomTo(scale, sx, sy) {
    const v = this.view;
    const pane = v.pane || { x0: 0, w: canvas.width };
    const cw = pane.w, ch = canvas.height;
    if (sx == null) { sx = cw / 2; sy = ch / 2; } else sx = ((sx - pane.x0) % cw + cw) % cw;
    const ns = clamp(scale, v.fitScale * 0.5, this.engine.fullH * 16);
    const k = ns / v.scale;
    v.pan = [sx - cw / 2 - (sx - cw / 2 - v.pan[0]) * k, sy - ch / 2 - (sy - ch / 2 - v.pan[1]) * k];
    v.scale = ns;
    v.fit = false;
    this.requestRender();
  },
  toggleZoom(sx, sy) {
    if (!this.img) return;
    if (this.view.fit || this.view.scale < this.engine.fullH * 0.99) this.zoomTo(this.engine.fullH, sx, sy);
    else this.fitView();
  },

  // ------------------------------------------------------------ rendering
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.renderNow(); });
  },

  renderParams() {
    const p = this.preview || this.params;
    if (!this.state.before) return this.state.showDepth && this.state.tool === 'ai' ? { ...p, _depthView: true } : p;
    const d = defaultParams(this.img.aspect);
    d.geometry = p.geometry;
    return d;
  },

  renderNow() {
    const E = this.engine;
    if (!this.img || !E?.L) return;
    const d = DPR();
    const cw = Math.max(1, Math.round(viewer.clientWidth * d)), ch = Math.max(1, Math.round(viewer.clientHeight * d));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const p = this.renderParams();
    const t = this.state;
    const compare = t.compare !== 'off' && t.tool === 'edit' && !t.before ? t.compare : null;
    const half = Math.floor(cw / 2);
    const v = this.computeView(p, compare === 'side' ? { x0: half, w: cw - half } : { x0: 0, w: cw });

    // Switch to the full-resolution level when zoomed past the preview's detail.
    const prevH = E.levelSize('preview').h;
    const want = E.hasFullLevel() && v.scale > prevH * 1.1 ? 'full' : v.scale < prevH * 0.95 ? 'preview' : E.L.kind;
    if (want !== E.L.kind) E.useLevel(want).then(() => this.requestRender());

    const overlayId = t.tool === 'masks' && t.showOverlay && !t.sliding && !t.before ? t.activeMaskId : null;
    if (compare) {
      const before = defaultParams(this.img.aspect);
      before.geometry = p.geometry;
      if (compare === 'split') {
        const sx = Math.round(clamp(t.splitX, 0, 1) * cw);
        E.renderBefore(before, v);
        E.render(p, { ...v, clip: t.clip, overlayId, scissor: [sx, 0, cw - sx, ch] });
        E.blitBefore([0, 0, sx, ch]);
      } else {
        const vl = this.computeView(p, { x0: 0, w: half });
        E.renderBefore(before, vl);
        this.computeView(p, { x0: half, w: cw - half });
        E.render(p, { ...v, clip: t.clip, overlayId, scissor: [half, 0, cw - half, ch] });
        E.blitBefore([0, 0, half, ch]);
      }
    } else E.render(p, { ...v, clip: t.clip, overlayId });
    this.drawOverlay();
    this.updateHud();
    this.scheduleHisto();
  },

  drawOverlay() {
    overlay.textContent = '';
    if (!this.img || this.state.before) return;
    const W = viewer.clientWidth, H = viewer.clientHeight;
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const c = this.state.compare;
    if (c !== 'off' && this.state.tool === 'edit') {
      const lab = (x, y, text, anchor) => { const t = svgEl('text', { x, y, class: 'cmp-label', 'text-anchor': anchor }); t.textContent = text; overlay.append(t); };
      if (c === 'split') {
        const x = this.state.splitX * W;
        overlay.append(svgEl('line', { x1: x, y1: 0, x2: x, y2: H, class: 'cmp-line' }));
        overlay.append(svgEl('circle', { cx: x, cy: H / 2, r: 15, class: 'cmp-knob' }));
        overlay.append(svgEl('path', { d: `M${x - 5} ${H / 2 - 5}l-4 5 4 5M${x + 5} ${H / 2 - 5}l4 5-4 5`, class: 'cmp-arrows' }));
        lab(x - 12, 26, 'Before', 'end');
        lab(x + 12, 26, 'After', 'start');
      } else {
        overlay.append(svgEl('line', { x1: W / 2, y1: 0, x2: W / 2, y2: H, class: 'cmp-line' }));
        lab(W / 4, 26, 'Before', 'middle');
        lab((3 * W) / 4, 26, 'After', 'middle');
      }
      return;
    }
    if (this.state.tool === 'crop') cropOverlay.draw(overlay, W, H);
    if (this.state.tool === 'masks') maskOverlay.draw(overlay);
    if (this.state.tool === 'retouch') retouchOverlay.draw(overlay);
  },

  updateHud() {
    const pct = (this.view.scale / this.engine.fullH) * 100;
    $('zoomLabel').textContent = `${this.view.fit ? 'Fit · ' : ''}${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
    $('beforeBadge').hidden = !this.state.before;
    $('btnBefore').classList.toggle('on', this.state.before || this.state.compare !== 'off');
  },

  scheduleHisto: debounce(function histo() {
    if (!app.img || !app.engine.L) return;
    const p = app.renderParams();
    const { crop } = p.geometry;
    const ar = crop.w / crop.h;
    const w = Math.max(1, Math.round(ar >= 1 ? 256 : 256 * ar)), h = Math.max(1, Math.round(ar >= 1 ? 256 / ar : 256));
    const px = app.engine.readPixels(p, w, h, { ...app.outputMats(p, w, h), scale: h / crop.h, cropTest: true });
    app.hist = computeHistogram(px);
    drawHistogram($('histo'), app.hist);
    $('clipHi').classList.toggle('hot', app.hist.clipHi);
    $('clipLo').classList.toggle('hot', app.hist.clipLo);
    if (app.state.tool === 'edit' && app.panel && !app.state.sliding) app.panel.refreshCurve?.();
  }, 90),

  renderSmall(params, long) {
    if (!this.img || !this.engine.L) return null;
    const { crop } = params.geometry;
    const ar = crop.w / crop.h;
    const w = Math.max(1, Math.round(ar >= 1 ? long : long * ar)), h = Math.max(1, Math.round(ar >= 1 ? long / ar : long));
    const px = this.engine.readPixels(params, w, h, { ...this.outputMats(params, w, h), scale: h / crop.h, cropTest: true });
    return new ImageData(new Uint8ClampedArray(px.buffer), w, h);
  },

  // ------------------------------------------------------------ misc
  // Brief message at the top of the window; `action` adds a button such as Undo.
  toast: (() => {
    let t = 0;
    return (msg, { action, ms } = {}) => {
      const n = $('toast');
      n.textContent = '';
      n.append(el('span', {}, msg));
      if (action) n.append(el('button', { class: 'toast-action', onclick: () => { n.classList.remove('show'); action.onClick(); } }, action.label));
      n.classList.toggle('has-action', !!action);
      n.classList.add('show');
      clearTimeout(t);
      t = setTimeout(() => n.classList.remove('show'), ms || (action ? 7000 : 1900));
    };
  })(),
};

function outputMatsFor(p, aspect, w, h) {
  const g = p.geometry;
  const toCropUV = A.scale(1 / w, 1 / h);
  return {
    toImage: A.mat3(A.chain(pToUV(aspect), qToP(g), cropUVToQ(g.crop), toCropUV)),
    toCrop: A.mat3(toCropUV),
  };
}

let library = null;
let accountPage = null;

// Sidebar storage widget: online storage on the Cloud plan, otherwise this device's storage.
async function paintStorage(node) {
  const cl = cloud.cloud, info = cl.info || {};
  let used, total, label;
  if (cl.provider === 'lumen' && isPaid(cl.plan) && info.quota_bytes) { used = info.storage_bytes || 0; total = info.quota_bytes; label = 'Online storage'; }
  else {
    const est = await catalog.storageEstimate();
    if (!est?.quota) { node.hidden = true; return; }
    used = est.used; total = est.quota; label = 'On this device';
  }
  node.hidden = false;
  node.textContent = '';
  const plan = !cl.signedIn ? 'Cloud sync off' : cl.plan === 'free' ? 'no Cloud plan' : planName(cl.plan);
  node.append(ring([{ value: used, color: 'var(--accent)' }], total, { size: 34, stroke: 5 }),
    el('span', { class: 'side-storage-text' }, el('b', {}, `${fmtBytes(used)} of ${fmtBytes(total)}`), el('span', {}, `${label} · ${plan}`)));
}
const cropOverlay = new CropOverlay(app);
const maskOverlay = new MaskOverlay(app);
const retouchOverlay = new RetouchOverlay(app);
sliderHooks.start = () => { app.state.sliding = true; lensQuality.draft = !!(app.params && (refocusActive(app.params) || lensActive(app.params))); };
sliderHooks.end = () => { app.state.sliding = false; lensQuality.draft = false; app.requestRender(); };

// ================================================================== library (catalog-backed)

const thumbURL = (e, blob) => {
  if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl);
  e.thumbUrl = blob ? URL.createObjectURL(blob) : '';
};

// Saves an edited thumbnail for the current photo (used by the library grid and filmstrip).
const saveThumb = debounce(async () => {
  const e = app.images[app.cur];
  if (!e || !app.img || app.preview || app.state.before) return;
  const img = app.renderSmall(app.params, 480);
  if (!img) return;
  const c = el('canvas', { width: img.width, height: img.height });
  c.getContext('2d').putImageData(img, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  if (!blob) return;
  thumbURL(e, blob);
  catalog.putThumb(e.id, blob);
  e.thumbAspect = c.width / c.height;
  catalog.updatePhoto(e.id, { thumbAspect: e.thumbAspect });
  if (cloud.cloud.available) {
    const k = 200 / Math.max(c.width, c.height);
    const t = el('canvas', { width: Math.round(c.width * k), height: Math.round(c.height * k) });
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    e.cloudThumb = t.toDataURL('image/jpeg', 0.72);
    catalog.updatePhoto(e.id, { cloudThumb: e.cloudThumb });
    cloud.pushPhoto(e, e.cloudThumb);
  }
  refreshLibrary();
}, 900);

async function thumbFromBitmap(bitmap) {
  const t = thumbnail(bitmap, 360);
  return new Promise((r) => t.toBlob(r, 'image/jpeg', 0.86));
}

function newEntry(rec) {
  return { ...rec, bitmap: null, linear: null, file: null, loading: false, thumbUrl: '' };
}

async function loadCatalog() {
  const recs = await catalog.listPhotos();
  // A linked photo without a copy here is back in its service after a restart.
  app.images = recs.map((r) => newEntry(r.linked && !r.stored && !r.src ? { ...r, offline: true } : r));
  await Promise.all(app.images.map(async (e) => {
    const b = await catalog.getThumb(e.id);
    if (b) thumbURL(e, b);
  }));
  refreshLibrary();
  renderStrip();
}

// Merge a record from the online library (another device) into the local catalog; newest wins.
async function mergeRemote(r) {
  if (!r?.key) return;
  let e = app.images.find((x) => x.key === r.key);
  if (!e) {
    e = newEntry({ id: uid(), key: r.key, name: r.name, addedAt: Date.now(), rating: r.rating, flag: r.flag, params: r.params, edited: r.edited, updatedAt: r.updatedAt, w: r.w, h: r.h, kind: r.kind, raw: r.raw, cloudThumb: r.thumb, linked: r.source || null, offline: true, stored: false, screen: 'ok' });
    app.images.push(e);
    await catalog.putPhoto({ id: e.id, key: e.key, name: e.name, addedAt: e.addedAt, rating: e.rating, flag: e.flag, params: e.params, edited: e.edited, updatedAt: e.updatedAt, w: e.w, h: e.h, kind: e.kind, raw: e.raw, cloudThumb: e.cloudThumb, linked: e.linked, offline: true, stored: false, screen: 'ok' });
    if (r.thumb) { const b = await (await fetch(r.thumb)).blob(); thumbURL(e, b); catalog.putThumb(e.id, b); }
    return;
  }
  if ((r.updatedAt || 0) <= (e.updatedAt || 0)) return;
  const patch = { rating: r.rating || 0, flag: r.flag || 0, params: r.params || null, edited: !!r.edited, updatedAt: r.updatedAt };
  Object.assign(e, patch);
  await catalog.updatePhoto(e.id, patch);
  if (r.thumb && r.thumb !== e.cloudThumb) { e.cloudThumb = r.thumb; const b = await (await fetch(r.thumb)).blob(); thumbURL(e, b); catalog.putThumb(e.id, b); }
  if (app.images[app.cur] === e && app.img && r.params && !app.state.sliding) {
    app.params = deepMerge(defaultParams(app.img.aspect), r.params);
    app.history.reset(app.params);
    app.updateUndo();
    app.rebuildPanel();
    app.requestRender();
    app.toast('Updated from your other device');
  }
}

// Nothing syncs until the owner has seen the Cloud warning on this device and each photo has passed
// the on-device check; flagged photos stay here (On this device only).
let syncAcked = null;
cloud.setSyncGate({
  cleared: (e) => !!syncAcked?.done && syncCheck.cleared(e),
  check: async (e) => { if (!syncAcked) return 'later'; await syncAcked; return syncCheck.check(e); },
});
let keptHere = 0;
const toastKept = debounce(() => {
  const n = keptHere; keptHere = 0;
  if (!n) return;
  app.toast(`${n === 1 ? 'A photo looks' : `${n} photos look`} explicit, so ${n === 1 ? 'it stays' : 'they stay'} on this device`, { ms: 7000, action: { label: 'Show', onClick: () => { setMode('library'); library?.showView('local'); } } });
}, 1200);
syncCheck.onFlagged((e) => {
  // In case it synced before the check existed.
  if (cloud.cloud.available) cloud.deletePhoto(e.key);
  keptHere++;
  toastKept();
  refreshLibrary();
});
async function keepOnDevice(ids) {
  const list = app.images.filter((e) => ids.includes(e.id));
  await syncCheck.keepLocal(list);
  if (cloud.cloud.available) for (const e of list) cloud.deletePhoto(e.key);
  refreshLibrary();
  app.toast(`${list.length === 1 ? 'Kept' : `Kept ${list.length} photos`} on this device only`);
}
async function syncAnyway(ids) {
  const list = app.images.filter((e) => ids.includes(e.id));
  if (!list.length || !(await syncCheck.confirmSyncAnyway(list.length))) return;
  await syncCheck.allowSync(list);
  for (const e of list) {
    cloud.pushPhoto(e);
    const f = cloud.storesOriginals() && !e.src && !e.linked && (e.file || (await catalog.getFile(e.id)));
    if (f) cloud.uploadOriginal(e, f);
  }
  refreshLibrary();
}

let stopSync = null;
async function startSync() {
  stopSync?.();
  stopSync = null;
  if (backendConfigured() && !window.__TAURI_INTERNALS__) {
    try { if (await sb.handleAuthRedirect()) app.toast('Signed in'); } catch (e) { app.toast(`Sign-in failed: ${e.message}`); }
  }
  // Purchases made on the website with this email join the account as soon as it signs in.
  if (backendConfigured() && sb.currentUser()) await sb.rpc('claim_purchases').catch(() => {});
  const st = await cloud.initCloud();
  paintTopAvatar();
  if (!st.available) return;
  if (!syncAcked) {
    syncAcked = syncCheck.acknowledgeSync(st.uid);
    syncAcked.then(() => { syncAcked.done = true; });
  }
  await syncAcked;
  const remote = await cloud.pullAll();
  const seen = new Set();
  for (const r of remote) { seen.add(r.key); await mergeRemote(r); }
  // Upload anything this device has that the account doesn't, or has newer.
  for (const e of app.images) {
    const r = remote.find((x) => x.key === e.key);
    if (!r || (e.updatedAt || 0) > (r.updatedAt || 0)) cloud.pushPhoto(e);
  }
  refreshLibrary();
  renderStrip();
  const stopPhotos = cloud.subscribe((type, r) => { if (type !== 'removed') mergeRemote(r).then(() => { refreshLibrary(); renderStrip(); }); });
  const remoteAlbums = await cloud.pullAlbums();
  for (const r of remoteAlbums) await albums.mergeRemoteAlbum(r);
  albums.pushAllAlbums(remoteAlbums);
  const stopAlbums = cloud.subscribeAlbums((r) => albums.mergeRemoteAlbum(r));
  stopSync = () => { stopPhotos(); stopAlbums(); };
}

function paintTopAvatar() {
  const a = $('avatar');
  const me = cloud.cloud.me;
  if (cloud.cloud.available && me?.avatarUrl) {
    a.textContent = '';
    a.classList.remove('noname');
    a.append(el('img', { src: me.avatarUrl, alt: '' }));
    $('btnAccount').title = `${me.name || 'Your account'} · synced`;
  } else paintAvatar(a, cloud.cloud.signedIn ? cloud.cloud.me?.name : prefs.name);
}

// ================================================================== import

const progress = (() => {
  let last = 0;
  return (msg, force) => { const t = performance.now(); if (force || t - last > 1200) { last = t; app.toast(msg); } };
})();
const isXmp = (f) => /\.xmp$/i.test(f.name);
const relOf = (f) => f.webkitRelativePath || f.name;
const dirOf = (rel) => rel.slice(0, rel.lastIndexOf('/') + 1);

// Files chosen, dropped or downloaded. XMP sidecars among them are matched to their photos;
// `opts.adobe` also reads edits saved inside the files, and `opts.catalog` applies a Lightroom catalog.
async function openFiles(files, opts = {}) {
  const all = [...files];
  const side = new Map();
  for (const f of all) if (isXmp(f)) side.set(relOf(f).toLowerCase(), f);
  const idx = opts.catalog ? catalogIndex(opts.catalog) : null;
  const items = all
    .filter((f) => f && !isXmp(f) && !/\.lrcat/i.test(f.name) && (f.type.startsWith('image/') || isPhotoName(f.name)))
    .map((file) => {
      const rel = relOf(file);
      const raw = RAW_EXT.has(file.name.split('.').pop().toLowerCase());
      const sc = sidecarNames(file.name, raw).map((n) => side.get((dirOf(rel) + n).toLowerCase())).find(Boolean);
      return { file, xmp: sc ? () => sc.text() : null, lr: idx?.match(file.name, rel, file.size) || null, adobe: !!opts.adobe, linked: file.linkedFrom || null };
    });
  if (!items.length) {
    if (all.length) app.toast(all.some(isXmp) ? 'Choose the photos together with their .xmp files' : 'No photos found');
    return [];
  }
  return importItems(items, { open: true, catalog: opts.catalog });
}

// Develop settings that come with an imported photo: Lightroom catalog, XMP sidecar, or XMP inside the file.
async function importedSettings(it, file, aspect) {
  if (it.lr) return { params: it.lr.crs ? crsToParams(it.lr.crs, aspect) : null, rating: it.lr.rating, flag: it.lr.flag };
  let text = it.xmp ? await it.xmp() : null;
  if (!text && (it.adobe || /\.dng$/i.test(file.name))) text = await embeddedXmp(file).catch(() => null);
  if (!text) return null;
  const st = readXmpSettings(text, aspect);
  if (st && it.xmp) { st.xmpHash = hashText(text); st.xmpSeen = it.xmpSeen || 0; }
  return st;
}

function applyImported(e, st) {
  if (!st) return false;
  const patch = {};
  if (st.params) { patch.params = st.params; patch.edited = true; }
  if (st.rating !== null && st.rating !== undefined) patch.rating = st.rating;
  if (st.flag !== null && st.flag !== undefined) patch.flag = st.flag;
  if (st.xmpHash) { patch.xmpHash = st.xmpHash; patch.xmpSeen = st.xmpSeen; }
  Object.assign(e, patch);
  return !!st.params;
}

// A small thumbnail with the photo's edits, rendered from its preview.
async function editedThumb(bitmap, params, aspect) {
  try {
    engineDirty = true;
    await app.engine.setImage({ kind: 'display', bitmap }, computeStats(sampleData(bitmap)));
    const { crop } = params.geometry;
    const ar = crop.w / crop.h, long = 360;
    const w = Math.max(1, Math.round(ar >= 1 ? long : long * ar)), h = Math.max(1, Math.round(ar >= 1 ? long / ar : long));
    const px = app.engine.readPixels(params, w, h, { ...outputMatsFor(params, aspect, w, h), scale: h / crop.h, cropTest: true });
    const c = el('canvas', { width: w, height: h });
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  } catch (err) { console.warn(err); return null; }
}

async function restoreEngine() {
  const cur = app.images[app.cur];
  if (engineDirty && cur && app.img) { await applySource(cur); app.requestRender(); }
  engineDirty = false;
}

// Imports photos. Each item is { file } or { src: { folder, rel } } for a photo in a synced folder,
// plus optional { xmp, lr, adobe } describing where its edits come from.
async function importItems(items, opts = {}) {
  catalog.requestPersistence();
  let first = null;
  let added = 0;
  const done = [];
  const collections = new Map();
  const failed = [];
  const many = items.length > 3;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (many) progress(`${opts.label || 'Importing'} ${n + 1} of ${items.length}…`);
    let file = it.file;
    try { file ||= await folders.fileFor(it.src, { ask: false }); } catch { file = null; }
    if (!file) continue;
    const key = catalog.photoKey(file);
    // A linked photo picked again matches its entry even if the service gave no stable date.
    const existing = app.images.find((e) => e.key === key)
      || (it.linked ? app.images.find((e) => e.linked === it.linked && e.offline && e.key.startsWith(`${file.name}:${file.size}:`)) : null);
    if (existing) {
      const patch = {};
      if (it.src && !existing.src) patch.src = it.src;
      if (existing.offline) {
        patch.offline = false;
        if (!it.src) { catalog.rememberFile(existing.id, file); if (!(it.linked && !prefs.keepLinked)) catalog.storeFile(existing.id, file); }
      }
      if (it.lr || it.xmp || it.adobe) {
        const st = await importedSettings(it, file, existing.w && existing.h ? existing.w / existing.h : 1.5);
        if (applyImported(existing, st)) Object.assign(patch, { params: existing.params, edited: true });
        if (st) Object.assign(patch, { rating: existing.rating, flag: existing.flag });
      }
      if (Object.keys(patch).length) touch(existing, patch);
      it.lr?.collections.forEach((c) => (collections.get(c) || collections.set(c, []).get(c)).push(existing.key));
      first ||= existing;
      done.push(existing);
      continue;
    }
    const e = newEntry({
      id: uid(), key, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
      addedAt: Date.now() + added++, rating: 0, flag: 0, params: null, edited: false, src: it.src || null,
      rendered: !!it.rendered, // a Lightroom rendition: its edits are already in the pixels
      linked: it.linked || null, // lives in Google Photos, Drive, Dropbox or OneDrive: never uploaded to our storage
    });
    e.loading = true;
    e.file = file;
    app.images.push(e);
    if (!many || n % 12 === 0) { refreshLibrary(); renderStrip(); }
    try {
      const d = await decodeFile(file);
      e.bitmap = d.bitmap;
      e.kind = d.kind;
      e.raw = !!d.raw;
      if (d.linear) { e.linear = d.linear; e.meta = d.linear.meta; }
      e.w = d.linear ? d.linear.w : d.bitmap.width;
      e.h = d.linear ? d.linear.h : d.bitmap.height;
      e.loading = false;
      const edited = applyImported(e, await importedSettings(it, file, e.w / e.h).catch(() => null));
      // Linked photos live in their service; a copy stays on this device only if the user wants that.
      const stored = it.src || (it.linked && !prefs.keepLinked) ? (catalog.rememberFile(e.id, file), false) : await catalog.storeFile(e.id, file);
      e.offline = false;
      e.updatedAt = Date.now();
      // A photo that can't be saved (storage blocked or full) still opens for this session.
      await catalog.putPhoto({
        id: e.id, key, name: e.name, size: e.size, type: e.type, lastModified: e.lastModified, addedAt: e.addedAt, updatedAt: e.updatedAt,
        rating: e.rating, flag: e.flag, params: e.params, edited: e.edited, kind: e.kind, raw: e.raw, w: e.w, h: e.h, meta: e.meta || null, stored,
        src: e.src, xmpHash: e.xmpHash || null, xmpSeen: e.xmpSeen || 0, rendered: e.rendered, linked: e.linked,
      }).catch((err) => console.warn('Could not save to the catalog', err));
      const tb = edited ? await editedThumb(d.bitmap, e.params, e.w / e.h) : await thumbFromBitmap(d.bitmap);
      if (tb) { thumbURL(e, tb); catalog.putThumb(e.id, tb); }
      cloud.pushPhoto(e);
      // Photos in synced folders already live on disk; only copied-in photos are backed up online.
      // Linked photos stay in the service they came from and never use Rembrandt storage.
      if (!it.src && !it.linked && cloud.storesOriginals()) cloud.uploadOriginal(e, file).then((ok) => { if (ok === false) app.toast(`${e.name} couldn't be stored online — it stays on this device`); });
      it.lr?.collections.forEach((c) => (collections.get(c) || collections.set(c, []).get(c)).push(e.key));
      first ||= e;
      done.push(e);
      if (it.src) e.file = null;
      if (app.images[app.cur] !== e) releaseBitmap(e);
    } catch (err) {
      console.error(err);
      app.images.splice(app.images.indexOf(e), 1);
      // Decoder errors are browser jargon; say what it means.
      const decode = /ImageBitmap|decode|EncodingError|InvalidStateError|source image/i.test(`${err?.name} ${err?.message}`);
      failed.push({ name: file.name, why: decode ? 'the file looks damaged or isn’t a photo' : reason(err) });
    }
  }
  await restoreEngine();
  for (const [name, keys] of collections) {
    const al = albums.allAlbums().find((a) => a.name === name);
    if (al) await albums.addToAlbum(al.id, keys); else await albums.createAlbum(name, keys);
  }
  refreshLibrary();
  renderStrip();
  // One summary: what came in, and what couldn't be opened (by name, with the reason).
  const fresh = added - failed.length;
  const bad = failed.length === 1 ? `${failed[0].name} couldn't be opened: ${failed[0].why}`
    : failed.length ? `${failed.length} files couldn't be opened (${failed.slice(0, 3).map((f) => f.name).join(', ')}${failed.length > 3 ? ', …' : ''})` : '';
  if (first && opts.open) {
    if (app.view.mode === 'library' || opts.label || items.length > 20) {
      if (app.view.mode !== 'library') setMode('library');
      const msg = `Imported ${fresh} photo${fresh === 1 ? '' : 's'}${collections.size ? ` and ${collections.size} album${collections.size === 1 ? '' : 's'}` : ''}`;
      if (bad) app.toast(`${msg} · ${bad}`, { ms: 8000 }); else progress(msg, true);
    } else {
      await openInEditor(first.id);
      if (bad) app.toast(bad, { ms: 6000 });
    }
  } else if (bad) app.toast(bad, { ms: 6000 });
  updateEmpty();
  return done;
}

// Lightroom catalog photos that match photos already in the library.
function catalogMatches(cat) {
  const idx = catalogIndex(cat);
  return app.images.filter((e) => !e.rendered && idx.match(e.name, e.src?.rel || e.name, e.size)).length;
}
async function applyCatalog(cat) {
  const idx = catalogIndex(cat);
  let n = 0;
  const cols = new Map();
  for (const e of app.images) {
    const p = e.rendered ? null : idx.match(e.name, e.src?.rel || e.name, e.size);
    if (!p) continue;
    const aspect = e.w && e.h ? e.w / e.h : 1.5;
    const patch = { rating: p.rating, flag: p.flag };
    if (p.crs) Object.assign(patch, { params: crsToParams(p.crs, aspect), edited: true });
    touch(e, patch);
    queueSidecar(e);
    p.collections.forEach((c) => (cols.get(c) || cols.set(c, []).get(c)).push(e.key));
    n++;
  }
  for (const [name, keys] of cols) {
    const al = albums.allAlbums().find((a) => a.name === name);
    if (al) await albums.addToAlbum(al.id, keys); else await albums.createAlbum(name, keys);
  }
  const cur = app.images[app.cur];
  if (cur && app.img && cur.params) { app.params = deepMerge(defaultParams(app.img.aspect), cur.params); app.history.reset(app.params); app.rebuildPanel(); app.requestRender(); }
  refreshLibrary();
  renderStrip();
  return n;
}

// ================================================================== synced folders

const hashText = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// Scans a synced folder: imports new photos, picks up sidecars changed by other apps or devices,
// and marks photos that disappeared as offline.
async function syncFolder(f, opts = {}) {
  if (!f || f.busy || f.status !== 'ok') return;
  folders.setBusy(f, true, 'Looking for photos…');
  try {
    const list = await folders.scan(f);
    const mine = new Map(app.images.filter((e) => e.src?.folder === f.id).map((e) => [e.src.rel, e]));
    const idx = opts.catalog ? catalogIndex(opts.catalog) : null;
    const items = [];
    const seen = new Set();
    for (const p of list) {
      seen.add(p.rel);
      const raw = RAW_EXT.has(p.name.split('.').pop().toLowerCase());
      const scName = sidecarNames(p.name, raw).find((n) => p.sidecars.has(n.toLowerCase()));
      const sc = scName ? p.sidecars.get(scName.toLowerCase()) : null;
      const e = mine.get(p.rel);
      if (e) {
        if (e.offline) touch(e, { offline: false });
        if (sc && sc.lastModified > (e.xmpSeen || 0)) await pullSidecar(e, sc);
        continue;
      }
      items.push({
        src: { folder: f.id, rel: p.rel, lastModified: p.lastModified },
        xmp: sc ? () => folders.readText(f.id, sc.rel) : null,
        xmpSeen: sc?.lastModified || 0,
        lr: idx?.match(p.name, p.rel, p.size) || null,
      });
    }
    for (const [rel, e] of mine) if (!seen.has(rel) && !e.offline) { e.offline = true; catalog.updatePhoto(e.id, { offline: true }); }
    if (items.length) {
      folders.setBusy(f, true, `Importing ${items.length} photos…`);
      await importItems(items, { label: `Syncing ${f.name}:`, catalog: opts.catalog, open: !!opts.open });
    }
    await folders.updateFolder(f, { count: list.length, lastScan: Date.now() });
  } catch (err) {
    console.error(err);
    app.toast(err.message);
  } finally {
    folders.setBusy(f, false);
    refreshLibrary();
  }
}

// A sidecar changed on disk: apply it unless it's the one we wrote.
async function pullSidecar(e, sc) {
  const text = await folders.readText(e.src.folder, sc.rel);
  e.xmpSeen = sc.lastModified;
  if (!text || hashText(text) === e.xmpHash) { catalog.updatePhoto(e.id, { xmpSeen: e.xmpSeen }); return; }
  const patch = { xmpSeen: sc.lastModified };
  {
    const st = readXmpSettings(text, e.w && e.h ? e.w / e.h : 1.5);
    if (st) {
      applyImported(e, st);
      Object.assign(patch, { params: e.params, edited: e.edited, rating: e.rating, flag: e.flag, xmpHash: hashText(text) });
      if (app.images[app.cur] === e && app.img && st.params) {
        app.params = deepMerge(defaultParams(app.img.aspect), e.params);
        app.history.reset(app.params);
        app.rebuildPanel();
        app.requestRender();
        app.toast('Edits updated from the folder');
      }
    }
  }
  touch(e, patch);
}

// Writes the photo's edits next to it (debounced per photo).
const sidecarTimers = new Map();
function queueSidecar(e) {
  if (!e?.src) return;
  const f = folders.folderById(e.src.folder);
  if (!f?.sidecars) return;
  clearTimeout(sidecarTimers.get(e.id));
  sidecarTimers.set(e.id, setTimeout(async () => {
    sidecarTimers.delete(e.id);
    const aspect = e.w && e.h ? e.w / e.h : 1.5;
    const p = e.params ? deepMerge(defaultParams(aspect), e.params) : defaultParams(aspect);
    const text = buildXmp(p, { aspect, raw: e.raw, rating: e.rating, flag: e.flag });
    const t = await folders.writeSidecar(e.src, sidecarNames(e.name, e.raw)[0], text);
    if (t) { e.xmpHash = hashText(text); e.xmpSeen = t; catalog.updatePhoto(e.id, { xmpHash: e.xmpHash, xmpSeen: t }); }
  }, 1500));
}

async function addSyncedFolder(opts = {}) {
  if (!folders.support()) { app.toast('Syncing a folder needs the desktop app, or Chrome or Edge'); return; }
  let f;
  try { f = await folders.addFolder(); } catch (err) { app.toast(err.message); return; }
  if (!f) return;
  setMode('library');
  library?.showView?.('folder:' + f.id);
  app.toast(`Syncing “${f.name}”…`);
  await syncFolder(f, { ...opts, open: true });
}

async function unsyncFolder(f) {
  const ids = app.images.filter((e) => e.src?.folder === f.id).map((e) => e.id);
  await removePhotos(ids);
  await folders.removeFolder(f.id);
  app.toast(`Stopped syncing “${f.name}”. The photos are still in the folder.`);
}

let lastSweep = 0;
function sweepFolders(force) {
  if (!force && (document.hidden || performance.now() - lastSweep < 20000)) return;
  lastSweep = performance.now();
  for (const f of folders.allFolders()) if (f.status === 'ok') syncFolder(f);
}

// The original file for a photo: in memory, in the catalog, or in its synced folder.
// A readable copy of a file. Safari can return files from IndexedDB that fail when decoded; reading
// the bytes up front turns that into a clear NotReadableError.
async function readable(file) {
  try { return new File([await file.arrayBuffer()], file.name, { type: file.type, lastModified: file.lastModified }); } catch (err) {
    if (err?.name === 'NotReadableError' || err?.name === 'NotFoundError') throw Object.assign(new Error(err.message), { name: 'NotReadableError' });
    throw err;
  }
}
const reason = (err) => (err?.message || String(err || 'unknown error')).replace(/\.$/, '');

async function originalFile(e) {
  return e.file || (await catalog.getFile(e.id)) || (e.src ? await folders.fileFor(e.src) : null);
}

function releaseBitmap(e) {
  if (app.images[app.cur] === e) return;
  if (e.bitmap) { e.bitmap.close?.(); e.bitmap = null; }
  e.linear = null; // decoded RAW data is large; it is re-developed when the photo is opened again
  e.file = null;
}

// Scene statistics from the small CPU sample: the airlight used by dehaze.
function computeStats(sample) {
  const { w, h, data } = sample;
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb.set(displayToScene([srgbToLinear(data[i * 4] / 255), srgbToLinear(data[i * 4 + 1] / 255), srgbToLinear(data[i * 4 + 2] / 255)]), i * 3);
  }
  return { airlight: estimateAirlight(rgb, w, h) };
}

const fmtShutter = (t) => (t >= 1 ? `${+t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`);
function describe(e, w, h) {
  const m = e.meta;
  const parts = [`${w} × ${h}`, e.kind || ''];
  if (m) {
    parts.push([m.make, m.model].filter(Boolean).join(' '));
    if (m.focal) parts.push(`${Math.round(m.focal)} mm`);
    if (m.aperture) parts.push(`f/${+m.aperture.toFixed(1)}`);
    if (m.shutter) parts.push(fmtShutter(m.shutter));
    if (m.iso) parts.push(`ISO ${Math.round(m.iso)}`);
  } else if (e.raw) parts.push('camera preview');
  return parts.filter(Boolean).join(' · ');
}

// Points the engine at the best source we have for `e`: developed RAW data if available,
// otherwise the decoded bitmap (JPEG/PNG/…, or a RAW's embedded preview).
async function applySource(e) {
  const lin = e.linear;
  const w = lin ? lin.w : e.bitmap.width, h = lin ? lin.h : e.bitmap.height;
  e.sample = lin ? { data: lin.preview.data, w: lin.preview.w, h: lin.preview.h } : e.sample || sampleData(e.bitmap);
  e.stats = computeStats(e.sample);
  const aspect = w / h;
  if (app.img && app.params && Math.abs(app.img.aspect - aspect) > 1e-6) {
    // RAW and embedded preview can differ by a few pixels; keep the crop where it was.
    const g = app.params.geometry, k = aspect / app.img.aspect;
    app.img.aspect = aspect;
    if (g.cropAuto) refitCrop(app, true);
    else { g.crop.cx *= k; g.crop.w *= k; g.crop = fitCrop(g.crop, aspect, g); }
  }
  if (app.img) app.img.aspect = aspect;
  await app.engine.setImage(lin ? { kind: 'linear', data: lin.data, w, h, gain: lin.gain } : { kind: 'display', bitmap: e.bitmap }, e.stats);
  app.engine.setLensProfile(e.lensProfile);
  // Built-in lens corrections are read once per photo, straight from the RAW file.
  if (e.raw && e.lensProfile === undefined) {
    e.lensProfile = null;
    originalFile(e).then(readLensProfile).then((prof) => {
      e.lensProfile = prof;
      if (prof && app.images[app.cur] === e) { app.engine.setLensProfile(prof); app.requestRender(); app.refreshPanel(); }
    }).catch(() => {});
  }
  ai.bind(app.engine, e);
  if (app.params) await loadBackground(app.params);
  $('info').textContent = describe(e, w, h);
  $('rawBadge').hidden = !e.rawBusy;
}

function developRaw(e) {
  if (!e.raw || e.linear || e.rawBusy || e.rawError || !e.file) return;
  e.rawBusy = true;
  if (app.images[app.cur] === e) $('rawBadge').hidden = false;
  decodeRawLinear(e.file, { quality: prefs.rawQuality })
    .then(async (lin) => {
      e.rawBusy = false;
      e.meta = lin.meta;
      catalog.updatePhoto(e.id, { meta: lin.meta, w: lin.w, h: lin.h });
      if (app.images[app.cur] !== e) return;
      e.linear = lin;
      await applySource(e);
      app.requestRender();
      saveThumb();
      app.toast(`RAW developed with LibRaw in ${(lin.meta.decodeMs / 1000).toFixed(1)} s`);
    })
    .catch((err) => {
      e.rawBusy = false;
      e.rawError = err.message;
      if (app.images[app.cur] === e) {
        $('rawBadge').hidden = true;
        app.toast(`Using the camera preview — ${err.message}`);
      }
    });
}

async function select(i) {
  const e = app.images[i];
  if (!e || (e.loading && !e.bitmap)) return;
  if (app.cur === i && app.img) return;
  const prev = app.images[app.cur];
  if (prev && app.params) prev.params = app.params;
  app.cur = i;
  if (!e.bitmap) {
    try {
      e.file = await originalFile(e);
      if (!e.file && cloud.cloud.signedIn && cloud.cloud.provider === 'lumen') {
        app.toast(`Downloading ${e.name}…`);
        e.file = await cloud.fetchOriginal(e);
        if (e.file) { e.offline = false; catalog.storeFile(e.id, e.file); }
      }
      if (!e.file && e.linked) {
        e.offline = true;
        refreshLibrary();
        relinkToast(e);
        return;
      }
      if (!e.file) {
        e.offline = true;
        app.toast(`${e.name} is not stored on this device — import it again to edit`);
        refreshLibrary();
        return;
      }
      const d = await decodeFile(await readable(e.file));
      e.bitmap = d.bitmap;
      e.kind = d.kind;
      e.raw = !!d.raw;
      if (d.linear) { e.linear = d.linear; e.meta = d.linear.meta; }
    } catch (err) {
      console.error(err);
      if (err?.name === 'NotReadableError') {
        e.offline = true;
        catalog.updatePhoto(e.id, { offline: true }).catch(() => {});
        refreshLibrary();
        app.toast(`This browser lost its copy of ${e.name} — import it again to edit`);
      } else app.toast(`Couldn't open ${e.name}: ${reason(err)}`);
      return;
    }
  }
  app.images.forEach((x) => x !== e && releaseBitmap(x));
  const w = e.linear ? e.linear.w : e.bitmap.width, h = e.linear ? e.linear.h : e.bitmap.height;
  const aspect = w / h;
  app.img = null;
  const params = e.params && e.params.v === 1 ? deepMerge(defaultParams(aspect), e.params) : defaultParams(aspect);
  app.params = params;
  app.preview = null;
  app.state.activeMaskId = params.masks[params.masks.length - 1]?.id || null;
  app.state.activeComp = 0;
  app.history.reset(params);
  app.updateUndo();
  app.img = { name: e.name, aspect, kind: e.kind, raw: e.raw };
  await applySource(e);
  $('fileTitle').textContent = e.name;
  document.body.classList.add('has-image');
  app.buildPanel();
  app.view.fit = true;
  renderStrip();
  app.requestRender();
  app.aiEnsure();
  developRaw(e);
}

// A linked photo lives in Google Photos (or Drive, Dropbox, OneDrive). On a device that doesn't have
// it yet, picking it once in that service brings it here; the pick is matched to this photo.
function relinkToast(e) {
  const source = CLOUD_SOURCES.find((s) => s.id === e.linked);
  const where = sourceName(e.linked);
  if (!source?.ready()) { app.toast(`${e.name} is in ${where}. Open Rembrandt in a browser where ${where} is connected to edit it.`); return; }
  app.toast(`${e.name} is in ${where}. Pick it there once to edit it on this device.`, { ms: 9000,
    action: { label: `Open ${where}`, onClick: async () => {
      try {
        const files = await pickLinked(source, (t) => progress(t));
        if (!files.length) return;
        await openFiles(files);
        const back = app.images.find((x) => x.id === e.id);
        if (back && !back.offline) await openInEditor(back.id);
      } catch (err) { app.toast(err.message); }
    } },
  });
}

async function openInEditor(id) {
  const i = app.images.findIndex((e) => e.id === id);
  if (i < 0) return;
  setMode('edit');
  await select(i);
}

// Photos leave the library at once; their files, edits and synced rows are deleted only when the
// Undo toast runs out (or the next delete starts). Closing the page before then keeps them.
let pendingDelete = null;

function detachPhotos(ids) {
  const set = new Set(ids);
  const cur = app.images[app.cur];
  // After deleting the open photo, show the next one in the order the user sees (or the previous).
  const seen = visibleImages();
  const at = cur ? seen.indexOf(cur) : -1;
  const next = at < 0 ? null : seen.slice(at + 1).find((e) => !set.has(e.id)) || seen.slice(0, at).reverse().find((e) => !set.has(e.id)) || null;
  const removed = app.images.map((e, i) => [e, i]).filter(([e]) => set.has(e.id));
  app.images = app.images.filter((e) => !set.has(e.id));
  if (cur && set.has(cur.id)) {
    app.cur = -1;
    app.img = null;
    app.params = null;
    document.body.classList.remove('has-image');
    $('fileTitle').textContent = '';
    $('info').textContent = '';
    app.buildPanel();
    overlay.textContent = '';
    drawHistogram($('histo'), null);
    const gl = app.engine.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.07, 0.075, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (app.view.mode === 'edit' && app.images.length) select(next ? app.images.indexOf(next) : 0);
  } else if (cur) app.cur = app.images.indexOf(cur);
  refreshLibrary();
  renderStrip();
  updateEmpty();
  return removed;
}

async function finalizeDelete(entries) {
  for (const e of entries) { e.bitmap?.close?.(); thumbURL(e, null); cloud.deletePhoto(e.key); }
  albums.forgetKeys(entries.map((e) => e.key));
  await catalog.removePhotos(entries.map((e) => e.id));
}

function commitPendingDelete() {
  if (!pendingDelete) return;
  const { removed, timer } = pendingDelete;
  pendingDelete = null;
  clearTimeout(timer);
  finalizeDelete(removed.map(([e]) => e));
}

// Two clicks: every delete (the photo's trash button, the toolbar, the menus, the Delete key) asks in
// a dialog in the middle of the screen first; after that there's still Undo for a few seconds.
function deletePhotos(ids) {
  const list = ids.map((id) => app.images.find((x) => x.id === id)).filter(Boolean);
  if (!list.length) return;
  const n = list.length, one = n === 1;
  const dlg = el('dialog', { class: 'dlg confirm-delete' });
  const close = () => { dlg.close(); dlg.remove(); };
  const go = el('button', { class: 'btn danger', type: 'button', onclick: () => { close(); deleteNow(ids); } }, one ? 'Delete' : `Delete ${n}`);
  const thumbs = list.slice(0, 4).filter((e) => e.thumbUrl);
  dlg.append(
    thumbs.length ? el('div', { class: 'cd-thumbs' }, ...thumbs.map((e) => el('img', { src: e.thumbUrl, alt: '' }))) : '',
    el('div', { class: 'dlg-head' }, el('h2', {}, one ? 'Delete this photo?' : `Delete ${n} photos?`)),
    el('div', { class: 'dlg-body' }, el('p', { class: 'hint' }, one
      ? `“${list[0].name}” and its edits are removed from your library${cloud.cloud.available ? ' and Cloud sync' : ''}.`
      : `They and their edits are removed from your library${cloud.cloud.available ? ' and Cloud sync' : ''}.`)),
    el('div', { class: 'dlg-foot' }, el('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'), go),
  );
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });   // click outside
  document.body.append(dlg);
  dlg.showModal();
  go.focus();
}

function deleteNow(ids) {
  if (!ids.length) return;
  commitPendingDelete();
  const removed = detachPhotos(ids);
  if (!removed.length) return;
  const n = removed.length;
  const timer = setTimeout(commitPendingDelete, 9000);
  pendingDelete = { removed, timer };
  app.toast(`Deleted ${n} photo${n === 1 ? '' : 's'}`, {
    ms: 9000,
    action: { label: 'Undo', onClick: () => {
      if (pendingDelete?.removed !== removed) return;
      clearTimeout(timer);
      pendingDelete = null;
      const cur = app.images[app.cur];
      for (const [e, i] of removed) app.images.splice(Math.min(i, app.images.length), 0, e);
      if (cur) app.cur = app.images.indexOf(cur);
      refreshLibrary();
      renderStrip();
      updateEmpty();
    } },
  });
}

// Immediate removal without Undo (clearing the whole library from Preferences, which asks first).
async function removePhotos(ids) {
  commitPendingDelete();
  await finalizeDelete(detachPhotos(ids).map(([e]) => e));
}

function touch(e, patch) {
  Object.assign(e, patch, { updatedAt: Date.now() });
  catalog.updatePhoto(e.id, { ...patch, updatedAt: e.updatedAt });
  cloud.pushPhoto(e);
}
function setRating(ids, rating) {
  for (const e of app.images) if (ids.includes(e.id)) { touch(e, { rating }); queueSidecar(e); }
  refreshLibrary();
  renderStrip();
}
function setFlag(ids, flag) {
  for (const e of app.images) if (ids.includes(e.id)) { touch(e, { flag }); queueSidecar(e); }
  refreshLibrary();
  renderStrip();
}

// ================================================================== batch editing

const photoAspect = (e) => (app.images[app.cur] === e && app.img ? app.img.aspect : e.w && e.h ? e.w / e.h : 1.5);
// A photo's full edit (the live one for the photo open in the editor).
function editOf(e) {
  if (app.images[app.cur] === e && app.params) return app.params;
  return e.params && e.params.v === 1 ? deepMerge(defaultParams(photoAspect(e)), e.params) : defaultParams(photoAspect(e));
}

async function copyEditsFrom(id, choose = false) {
  const e = app.images.find((x) => x.id === id);
  if (!e) return;
  let parts = batch.rememberedParts();
  if (choose) { parts = await batch.chooseParts(); if (!parts) return; }
  batch.copyEdits(editOf(e), parts, e.name, photoAspect(e));
  app.toast(`Copied ${batch.describeClip()}`);
  refreshLibrary();
}

// Changes the edits of many photos at once, with a single Undo for all of them.
function changeEdits(ids, fn, message) {
  const list = app.images.filter((e) => ids.includes(e.id));
  if (!list.length) return;
  const cur = app.images[app.cur];
  const before = list.map((e) => [e, clone(editOf(e))]);
  const apply = (e, p) => {
    if (e === cur && app.img) { app.params = p; app.commit(); app.rebuildPanel(); app.requestRender(); }
    else { touch(e, { params: p, edited: true }); queueSidecar(e); }
  };
  for (const e of list) apply(e, fn(editOf(e), photoAspect(e)));
  refreshLibrary();
  renderStrip();
  refreshThumbs(list.filter((e) => e !== cur || !app.img));
  app.toast(message, {
    action: {
      label: 'Undo',
      onClick: () => {
        for (const [e, p] of before) apply(e, p);
        refreshLibrary();
        refreshThumbs(before.map(([e]) => e).filter((e) => e !== cur || !app.img));
        app.toast('Undone');
      },
    },
  });
}
const plural = (n) => `${n} photo${n === 1 ? '' : 's'}`;
function pasteEditsTo(ids) {
  const c = batch.clipboard();
  if (!c) { app.toast('Copy edits from a photo first'); return; }
  changeEdits(ids, (p, a) => batch.pasteEdits(p, c, a), ids.length === 1 ? `Pasted ${batch.describeClip(c)}` : `Pasted edits to ${plural(ids.length)}`);
}
function resetEdits(ids) {
  changeEdits(ids, (p, a) => defaultParams(a), `Reset ${plural(ids.length)}`);
}
function applyPresetTo(ids, preset) {
  changeEdits(ids, (p, a) => withSettings(p, preset.settings, a), `Applied “${preset.name}” to ${plural(ids.length)}`);
}
// Kept for callers of the old name: paste the open photo's look onto others.
function syncSettings(ids) {
  const e = app.images[app.cur];
  if (e && app.params) { batch.copyEdits(app.params, batch.rememberedParts(), e.name, photoAspect(e)); pasteEditsTo(ids.filter((id) => id !== e.id)); }
}

// Thumbnails for photos whose edits changed without opening them, rendered one by one in the background.
const thumbQueue = [];
let thumbBusy = false;
function refreshThumbs(list) {
  for (const e of list) if (!thumbQueue.includes(e)) thumbQueue.push(e);
  if (!thumbBusy) runThumbs();
}
async function runThumbs() {
  thumbBusy = true;
  while (thumbQueue.length) {
    const e = thumbQueue.shift();
    try {
      const f = e.file || (await catalog.getFile(e.id)) || (e.src ? await folders.fileFor(e.src, { ask: false }) : null);
      if (!f) continue;
      const d = await decodeFile(f);
      const tb = await editedThumb(d.bitmap, editOf(e), d.bitmap.width / d.bitmap.height);
      d.bitmap.close?.();
      if (tb) { thumbURL(e, tb); catalog.putThumb(e.id, tb); }
      // Keep the photo in the editor on screen while working through the queue.
      if (app.view.mode === 'edit') await restoreEngine();
      if (!thumbQueue.length || thumbQueue.length % 6 === 0) { refreshLibrary(); renderStrip(); }
    } catch (err) { console.warn('thumbnail', err); }
  }
  await restoreEngine();
  refreshLibrary();
  renderStrip();
  thumbBusy = false;
}

// Right-click menu for photos in the gallery and the filmstrip.
function photoMenu(ids, anchor, extra = []) {
  const c = batch.clipboard();
  const n = ids.length;
  popMenu(anchor, [
    n === 1 ? { label: 'Edit', icon: 'edit', onClick: () => openInEditor(ids[0]) } : null,
    n === 1 ? { label: 'Copy edits', icon: 'copy', onClick: () => copyEditsFrom(ids[0]) } : null,
    n === 1 ? { label: 'Choose what to copy…', icon: 'copy', onClick: () => copyEditsFrom(ids[0], true) } : null,
    { label: c ? `Paste edits${n > 1 ? ` to ${n} photos` : ''}` : 'Paste edits (copy first)', icon: 'paste', onClick: () => pasteEditsTo(ids) },
    { label: 'Apply preset…', icon: 'presets', onClick: () => presetMenu(ids, anchor) },
    { label: n > 1 ? `Reset edits on ${n} photos` : 'Reset edits', icon: 'reset', onClick: () => resetEdits(ids) },
    ...extra,
  ]);
}
function presetMenu(ids, anchor) {
  const groups = {};
  for (const p of allPresets()) (groups[p.group || 'Your presets'] ||= []).push(p);
  popMenu(anchor, Object.entries(groups).flatMap(([g, list], i) => [i ? { sep: true } : null, { head: g }, ...list.map((p) => ({ label: p.name, onClick: () => applyPresetTo(ids, p) }))]));
}
const pointAnchor = (ev) => ({ getBoundingClientRect: () => ({ left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY }) });

function visibleImages() {
  return library ? library.visible() : app.images;
}

function renderStrip() {
  const strip = $('strip');
  strip.textContent = '';
  const list = visibleImages();
  list.forEach((e) => {
    const i = app.images.indexOf(e);
    const t = el('div', { class: 'thumb' + (i === app.cur ? ' on' : '') + (e.loading ? ' loading' : '') + (e.offline ? ' offline' : ''), title: e.name, tabindex: 0 },
      e.thumbUrl ? el('img', { src: e.thumbUrl, alt: '', draggable: 'false' }) : el('span', { class: 'thumb-ph' }),
      e.rating ? el('span', { class: 'thumb-stars' }, '★'.repeat(e.rating)) : null,
      e.flag === 1 ? el('span', { class: 'thumb-flag pick' }) : e.flag === -1 ? el('span', { class: 'thumb-flag reject' }) : null,
    );
    t.addEventListener('click', () => select(i));
    t.addEventListener('contextmenu', (ev) => { ev.preventDefault(); photoMenu([e.id], pointAnchor(ev)); });
    strip.append(t);
    if (i === app.cur) requestAnimationFrame(() => t.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });
}

function refreshLibrary() {
  library?.refresh();
}

function updateEmpty() {
  const none = app.images.length === 0;
  $('empty').hidden = !(none && app.view.mode === 'edit');
  document.body.classList.toggle('catalog-empty', none);
}

// ================================================================== modes & batch export

let modeBeforeAccount = 'library';
function setMode(mode, section) {
  if (mode === 'plan') { mode = 'account'; section = 'plan'; }
  if (mode === 'account') {
    if (app.view.mode !== 'account') modeBeforeAccount = app.view.mode || 'library';
    app.view.mode = 'account';
    document.body.dataset.mode = 'account';
    document.querySelectorAll('[data-mode-btn]').forEach((b) => b.classList.remove('on'));
    accountPage.show(section);
    return;
  }
  app.view.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('[data-mode-btn]').forEach((b) => b.classList.toggle('on', b.dataset.modeBtn === mode));
  if (mode === 'library') {
    const cur = app.images[app.cur];
    if (cur) library.selectOnly(cur.id);
    refreshLibrary();
    library.focusCurrent?.();
    $('library').querySelector('.lib-content')?.focus({ preventScroll: true });
  } else {
    if (!app.img && app.images.length) {
      const first = visibleImages()[0] || app.images[0];
      select(app.images.indexOf(first));
    }
    renderStrip();
    app.requestRender();
  }
  updateEmpty();
}

// Background pictures live in the catalog's file store.
async function loadBackground(p) {
  const key = p.ai?.bg?.image;
  if (!key || hasBackgroundImage(key)) return;
  const f = await catalog.getFile(key);
  if (f) await setBackgroundImage(app.engine, key, f);
}

let engineDirty = false;

// The engine renders effective settings (switched-off groups use their defaults).
let canvasBg = [0.08, 0.08, 0.09];
class AppEngine extends Engine {
  render(p, v) { return super.render(effectiveParams(p), { bg: canvasBg, ...v }); }
  renderBefore(p, v) { return super.renderBefore(effectiveParams(p), { bg: canvasBg, ...v }); }
  readPixels(p, w, h, v) { return super.readPixels(effectiveParams(p), w, h, v); }
  exportPixels(p, ...rest) { return super.exportPixels(effectiveParams(p), ...rest); }
}
async function renderPhotoForExport(id, opts) {
  const e = app.images.find((x) => x.id === id);
  if (!e) return null;
  const base = e.name.replace(/\.[^.]+$/, '');
  const cur = app.images[app.cur];
  if (e === cur && app.img) {
    if (engineDirty) { await applySource(cur); engineDirty = false; }
    await ai.ensure(cur, app.params);
    const { blob } = await renderExport(app, opts);
    return { blob, base };
  }
  const file = await originalFile(e);
  if (!file) return null;
  const d = await decodeFile(file);
  let lin = d.linear || null;
  if (d.raw && !lin) { try { lin = await decodeRawLinear(file, { quality: prefs.rawQuality }); } catch { lin = null; } }
  const sample = lin ? { data: lin.preview.data, w: lin.preview.w, h: lin.preview.h } : sampleData(d.bitmap);
  const w = lin ? lin.w : d.bitmap.width, h = lin ? lin.h : d.bitmap.height;
  const aspect = w / h;
  const params = e.params && e.params.v === 1 ? deepMerge(defaultParams(aspect), e.params) : defaultParams(aspect);
  engineDirty = true;
  await app.engine.setImage(lin ? { kind: 'linear', data: lin.data, w, h, gain: lin.gain } : { kind: 'display', bitmap: d.bitmap }, computeStats(sample));
  if (d.raw && e.lensProfile === undefined) e.lensProfile = await readLensProfile(file);
  app.engine.setLensProfile(e.lensProfile);
  const tmp = { bitmap: d.bitmap, linear: lin, sample, ai: e.ai };
  ai.bind(app.engine, tmp);
  await ai.ensure(tmp, params);
  e.ai = tmp.ai;
  await loadBackground(params);
  const { blob } = await renderExport(app, opts, params, (p, ww, hh) => outputMatsFor(p, aspect, ww, hh));
  d.bitmap?.close?.();
  return { blob, base };
}

function sharePhotos(ids, title) {
  openShare(app, ids, {
    title,
    render: async (id, opts) => (await renderPhotoForExport(id, opts))?.blob,
    exportPhotos,
    signIn: () => setMode('account', 'cloud'),
  });
  $('shareDialog').addEventListener('close', async () => {
    const cur = app.images[app.cur];
    if (engineDirty && cur && app.img) { await applySource(cur); app.requestRender(); }
    engineDirty = false;
  }, { once: true });
}

function exportPhotos(ids) {
  openExport(app, ids, renderPhotoForExport);
  $('exportDialog').addEventListener('close', async () => {
    const cur = app.images[app.cur];
    if (engineDirty && cur && app.img) { await applySource(cur); app.requestRender(); }
    engineDirty = false;
  }, { once: true });
}

// ================================================================== pointer & wheel

let pointer = null;
let spaceDown = false;
// Touch: two fingers pinch-zoom and pan; one finger swipes to the next photo when the photo fits
// the screen; a double tap zooms to 100%.
const touches = new Map();
let pinch = null;
let lastTap = { t: 0, x: 0, y: 0 };
const pinchState = () => {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
};
function stepPhoto(dir) {
  const list = visibleImages();
  const n = list.indexOf(app.images[app.cur]) + dir;
  if (n >= 0 && n < list.length) select(app.images.indexOf(list[n]));
}
const local = (e) => {
  const r = viewer.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const toolOverlay = () => ({ crop: cropOverlay, masks: maskOverlay, retouch: retouchOverlay })[app.state.tool] || null;

viewer.addEventListener('pointerdown', (e) => {
  if (!app.img) return;
  closeMenu();
  const [x, y] = local(e);
  viewer.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, [x, y]);
    if (touches.size === 2) {
      // A second finger turns whatever the first one started into a pinch (and undoes a brush stroke start).
      if (pointer?.kind === 'tool') pointer.tool.up();
      const st = pinchState();
      pinch = { ...st, scale: app.view.scale, pan: [...app.view.pan] };
      if (app.view.fit) { app.view.fit = false; }
      pointer = null;
      return;
    }
    if (touches.size > 2) return;
  }
  if (app.state.pick && e.button === 0) { app.finishPick(app.cssToUV(x, y)); return; }
  if (app.state.compare === 'split' && app.state.tool === 'edit' && Math.abs(x - app.state.splitX * viewer.clientWidth) < 20 && e.button === 0) {
    pointer = { kind: 'split' };
    return;
  }
  const tool = toolOverlay();
  if (e.button === 0 && !spaceDown && tool && tool.down(e, x, y)) {
    pointer = { kind: 'tool', tool };
    return;
  }
  pointer = { kind: 'pan', x, y, pan: [...app.view.pan], fit: app.view.fit, touch: e.pointerType === 'touch', t: performance.now() };
  viewer.classList.add('panning');
});

viewer.addEventListener('pointermove', (e) => {
  if (!app.img) return;
  const [x, y] = local(e);
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, [x, y]);
    if (pinch && touches.size === 2) {
      const d = DPR();
      const st = pinchState();
      app.view.pan = [pinch.pan[0] + (st.mid[0] - pinch.mid[0]) * d, pinch.pan[1] + (st.mid[1] - pinch.mid[1]) * d];
      app.view.scale = pinch.scale;
      app.zoomTo(pinch.scale * (st.d / pinch.d), st.mid[0] * d, st.mid[1] * d);
      return;
    }
    if (pinch) return;
    // With the whole photo on screen, a sideways drag is a swipe between photos, not a pan.
    if (pointer?.kind === 'pan' && pointer.touch && pointer.fit) return;
  }
  if (pointer?.kind === 'tool') { pointer.tool.move(e, x, y); return; }
  if (pointer?.kind === 'split') { app.state.splitX = clamp(x / viewer.clientWidth, 0.02, 0.98); app.requestRender(); return; }
  if (pointer?.kind === 'pan') {
    const d = DPR();
    if (app.view.fit) { app.view.fit = false; }
    app.view.pan = [pointer.pan[0] + (x - pointer.x) * d, pointer.pan[1] + (y - pointer.y) * d];
    app.requestRender();
    return;
  }
  const tool = toolOverlay();
  if (tool === maskOverlay) { maskOverlay.move(e, x, y); app.drawOverlay(); }
  if (tool === retouchOverlay) retouchOverlay.move(e, x, y);
  const onSplit = app.state.compare === 'split' && app.state.tool === 'edit' && Math.abs(x - app.state.splitX * viewer.clientWidth) < 20;
  viewer.style.cursor = app.state.pick ? 'crosshair' : onSplit ? 'ew-resize' : spaceDown ? 'grab' : tool ? tool.cursor(x, y) : '';
});

const endPointer = (e) => {
  if (e?.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) pinch = null;
      if (!touches.size && app.view.scale <= app.view.fitScale * 1.02) app.fitView();
      pointer = null;
      viewer.classList.remove('panning');
      return;
    }
    if (pointer?.kind === 'pan' && pointer.touch && e.type === 'pointerup') {
      const [x, y] = local(e);
      const dx = x - pointer.x, dy = y - pointer.y, dt = performance.now() - pointer.t;
      if (pointer.fit && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepPhoto(dx < 0 ? 1 : -1);
      else if (Math.hypot(dx, dy) < 10 && dt < 250) {
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
          lastTap.t = 0;
          if (app.state.tool !== 'crop' && app.state.tool !== 'retouch' && !(app.state.tool === 'masks' && activeMask(app))) app.toggleZoom(x * DPR(), y * DPR());
        } else lastTap = { t: now, x, y };
      }
    }
  }
  if (pointer?.kind === 'tool') pointer.tool.up();
  pointer = null;
  viewer.classList.remove('panning');
};
viewer.addEventListener('pointerup', endPointer);
viewer.addEventListener('pointercancel', endPointer);
viewer.addEventListener('pointerleave', () => { if (!pointer) { maskOverlay.leave(); retouchOverlay.hover = null; app.drawOverlay(); } });

viewer.addEventListener('wheel', (e) => {
  if (!app.img) return;
  e.preventDefault();
  const [x, y] = local(e);
  const d = DPR();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const k = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0022));
  app.zoomTo(app.view.scale * k, x * d, y * d);
}, { passive: false });

viewer.addEventListener('dblclick', (e) => {
  if (!app.img || app.state.tool === 'crop' || app.state.tool === 'retouch' || (app.state.tool === 'masks' && activeMask(app))) return;
  const [x, y] = local(e);
  app.toggleZoom(x * DPR(), y * DPR());
});

new ResizeObserver(() => { app.requestRender(); app.scheduleHisto(); }).observe(viewer);

// ================================================================== chrome

const importApi = {
  chooseFiles: () => $('fileInput').click(),
  chooseFolder: () => $('folderInput').click(),
  openFiles,
  syncFolder: (f, opts) => (f ? syncFolder(f, opts) : addSyncedFolder(opts)),
  applyCatalog,
  catalogMatches,
  pendingCatalog: null,
  pendingCloud: null,
  adobeConnect: () => adobe.adobeSignIn(openExternal()),
  readLightroomCloud: (onProgress) => adobe.readLightroomCloud(onProgress),
  downloadLightroom,
};

// Downloads photos from Lightroom (cloud) as Lightroom renders them (edits applied) and imports
// them with their ratings, flags and albums. The edits are already in the pixels, so they aren't
// applied a second time.
async function downloadLightroom(cat, photos) {
  const queue = photos.slice();
  let done = 0, failed = 0;
  setMode('library');
  while (queue.length) {
    const batch = queue.splice(0, 8);
    const files = [];
    await Promise.all(batch.map(async (p) => {
      try { files.push({ file: await adobe.downloadRendition(cat, p), lr: { ...p, crs: null }, rendered: true }); } catch (err) { console.warn(err); failed++; }
      done++;
      progress(`Downloading from Lightroom: ${done} of ${photos.length}…`);
    }));
    if (files.length) await importItems(files, { label: 'Importing from Lightroom:' });
  }
  progress(`Imported ${photos.length - failed} photo${photos.length - failed === 1 ? '' : 's'} from Lightroom${failed ? ` (${failed} couldn’t be downloaded)` : ''}`, true);
}
const openImporter = (page) => openImport(app, importApi, page);
$('btnOpenEmpty').addEventListener('click', () => openImporter());
$('btnAdd').addEventListener('click', () => openImporter());
$('folderInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('fileInput').accept = ACCEPT;
$('fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('btnUndo').addEventListener('click', () => app.undo());
$('btnRedo').addEventListener('click', () => app.redo());
$('btnExport').addEventListener('click', () => {
  if (app.view.mode === 'library') {
    const sel = library ? library.selection() : [];
    if (sel.length) return exportPhotos(sel);
  }
  openExport(app);
});
document.querySelectorAll('[data-mode-btn]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.modeBtn)));
$('btnFit').addEventListener('click', () => app.fitView());
$('btn100').addEventListener('click', () => app.img && app.zoomTo(app.engine.fullH));
// Cloud plan: upload originals that aren't online yet; free local space for ones that are.
async function onlineKeys() {
  const rows = await listOnlineOriginals();
  return new Set(rows.map((r) => r.key));
}
async function uploadMissingOriginals() {
  const have = await onlineKeys();
  let n = 0;
  for (const e of app.images) {
    if (have.has(e.key)) continue;
    const f = e.file || (await catalog.getFile(e.id));
    if (!f) continue;
    n++;
    cloud.uploadOriginal(e, f);
  }
  return n;
}
async function freeDeviceSpace() {
  const have = await onlineKeys().catch(() => new Set());
  let n = 0;
  for (const e of app.images) {
    // Stored online, or linked from another service: the original is safe elsewhere.
    if (!(have.has(e.key) || e.linked) || e === app.images[app.cur] || e.offline) continue;
    await catalog.deleteFile(e.id);
    e.file = null;
    e.offline = true;
    await catalog.updatePhoto(e.id, { offline: true, stored: false });
    n++;
  }
  refreshLibrary();
  renderStrip();
  return n;
}

const accountHooks = {
  profileChanged: () => paintTopAvatar(),
  accountChanged: async () => { await startSync(); paintTopAvatar(); },
  cloud: cloud.cloud,
  clearLibrary: () => removePhotos(app.images.map((e) => e.id)),
  previewChanged: (v) => app.engine.setPreviewLong(v).then(() => app.requestRender()),
  restoreBackup: async (data) => {
    if (!data || !['Rembrandt', 'photography.work', 'Lumen'].includes(data.app) || !Array.isArray(data.photos)) throw new Error('not a backup from this app');
    for (const a of data.albums || []) await albums.mergeRemoteAlbum({ ...a, updatedAt: Math.max(a.updatedAt || 0, 1) });
    let n = 0;
    for (const b of data.photos) {
      const e = app.images.find((x) => x.key === b.key);
      if (!e) continue;
      Object.assign(e, { rating: b.rating || 0, flag: b.flag || 0, params: b.params || null, edited: !!b.params });
      await catalog.updatePhoto(e.id, { rating: e.rating, flag: e.flag, params: e.params, edited: e.edited });
      n++;
    }
    const cur = app.images[app.cur];
    if (cur && app.img) { app.img = null; const i = app.cur; app.cur = -1; await select(i); }
    refreshLibrary();
    renderStrip();
    return n;
  },
  albums: () => albums.allAlbums(),
  openPlan: () => setMode('account', 'cloud'),
  back: () => setMode(modeBeforeAccount === 'account' ? 'library' : modeBeforeAccount),
  uploadMissingOriginals,
  freeDeviceSpace,
};
$('btnAccount').addEventListener('click', (e) => popMenu(e.currentTarget, [
  isMobileApp && !isUnlocked() ? { label: 'Unlock Rembrandt', icon: 'sparkle', onClick: () => setMode('account', 'unlock') } : null,
  { label: `Cloud sync · ${cloud.cloud.signedIn ? 'On' : 'Off'}`, icon: 'cloud', onClick: () => setMode('account', 'cloud') },
  { label: 'Preferences', icon: 'gear', onClick: () => setMode('account', 'prefs') },
  { label: 'Storage', icon: 'laptop', onClick: () => setMode('account', 'storage') },
  { label: updateState().available ? 'Update Rembrandt…' : 'Check for updates…', icon: 'sync', onClick: () => setMode('account', 'prefs') },
  { sep: true },
  { label: 'Import photos…', icon: 'open', onClick: () => openImporter() },
  isTouch ? null : { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => $('helpDialog').showModal() },
]));
// Rembrandt is free. With a donation page configured, a heart in the top bar links to it.
function openSupport() {
  const url = CONFIG.supportUrl;
  if (!url) return;
  const ext = openExternal();
  if (ext) ext(url); else window.open(url, '_blank', 'noopener');
}
$('btnSupport').hidden = !CONFIG.supportUrl;
$('btnSupport').addEventListener('click', openSupport);
$('helpClose').addEventListener('click', () => $('helpDialog').close());
$('clipHi').addEventListener('click', () => { app.state.clip = !app.state.clip; syncClip(); });
$('clipLo').addEventListener('click', () => { app.state.clip = !app.state.clip; syncClip(); });
function syncClip() {
  $('clipHi').classList.toggle('on', app.state.clip);
  $('clipLo').classList.toggle('on', app.state.clip);
  app.requestRender();
}
const beforeBtn = $('btnBefore');
function setCompare(mode) {
  app.state.compare = mode;
  app.state.before = false;
  if (mode !== 'off' && app.state.tool !== 'edit') app.setTool('edit');
  app.fitView();
  app.toast(mode === 'split' ? 'Split view — drag the divider' : mode === 'side' ? 'Side by side' : 'Compare off');
}
beforeBtn.addEventListener('click', (e) => popMenu(e.currentTarget, [
  { label: 'Show original  (\\)', icon: 'eye', onClick: () => { app.state.compare = 'off'; app.state.before = !app.state.before; app.requestRender(); } },
  { label: 'Split view  (Y)', icon: 'compare', onClick: () => setCompare('split') },
  { label: 'Side by side', icon: 'presets', onClick: () => setCompare('side') },
  { label: 'Compare off', icon: 'x', onClick: () => setCompare('off') },
]));
document.querySelectorAll('.rail [data-tool]').forEach((b) => b.addEventListener('click', () => app.setTool(b.dataset.tool)));
$('btnToggleFilm').addEventListener('click', () => document.body.classList.toggle('film-hidden'));

// Drag & drop anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) openFiles(files);
});

// ================================================================== keyboard

window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? app.redo() : app.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
  if (mod && k.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); return; }
  if (mod && k.toLowerCase() === 'e') { e.preventDefault(); $('btnExport').click(); return; }
  if (app.view.mode === 'library') {
    if (!mod && (k === 'e' || k === 'd')) { const sel = library.selection(); if (sel.length) openInEditor(sel[0]); else setMode('edit'); e.preventDefault(); return; }
    if (k === '?' && !mod) { $('helpDialog').showModal(); return; }
    if (library.onKey(e)) e.preventDefault();
    return;
  }
  if (!mod && !e.altKey && k === 'g') { setMode('library'); e.preventDefault(); return; }
  if (!mod && !e.altKey && /^[0-5]$/.test(k) && app.img && tag !== 'INPUT') { setRating([app.images[app.cur].id], +k); app.toast(+k ? `Rated ${'★'.repeat(+k)}` : 'Rating cleared'); e.preventDefault(); return; }
  if (mod && e.shiftKey && k.toLowerCase() === 'c') { e.preventDefault(); app.copySettings(); return; }
  if (mod && e.shiftKey && k.toLowerCase() === 'v') { e.preventDefault(); app.pasteSettings(); return; }
  if (mod || e.altKey) return;
  if (k === ' ' && !spaceDown) { spaceDown = true; viewer.style.cursor = 'grab'; if (tag !== 'BUTTON') e.preventDefault(); return; }
  if (!app.img) { if (k === '?') $('helpDialog').showModal(); return; }
  const t = app.state.tool;
  switch (k) {
    case '\\': app.state.before = !app.state.before; app.requestRender(); break;
    case 'y': setCompare(app.state.compare === 'off' ? 'split' : app.state.compare === 'split' ? 'side' : 'off'); break;
    case 'e': case 'd': app.setTool('edit'); break;
    case 'r': case 'c': app.setTool(t === 'crop' ? 'edit' : 'crop'); break;
    case 'm': app.setTool(t === 'masks' ? 'edit' : 'masks'); break;
    case 'q': app.setTool(t === 'retouch' ? 'edit' : 'retouch'); break;
    case '/': if (t === 'retouch') newSourceForSelected(app); break;
    case 'h': if (t === 'retouch') { retouchState.hide = !retouchState.hide; app.refreshPanel(); app.drawOverlay(); } break;
    case 'p': app.setTool(t === 'presets' ? 'edit' : 'presets'); break;
    case 'a': app.setTool(t === 'ai' ? 'edit' : 'ai'); break;
    case 'o': app.state.showOverlay = !app.state.showOverlay; app.refreshPanel(); app.requestRender(); break;
    case 'j': app.state.clip = !app.state.clip; syncClip(); break;
    case 'w': app.pickWhiteBalance(); break;
    case 'z': app.toggleZoom(); break;
    case 'f': app.fitView(); break;
    case '?': $('helpDialog').showModal(); break;
    case 'x': if (t === 'crop') app.panel.swap(); break;
    case 'Enter': if (t === 'crop') app.setTool('edit'); break;
    case 'Escape':
      if (app.state.pick) { app.state.pick = null; viewer.classList.remove('picking'); }
      else if (t === 'crop' || t === 'retouch') app.setTool('edit');
      break;
    case '[': case ']': {
      const up = k === ']';
      if (t === 'masks') {
        const B = app.state.brush;
        if (e.shiftKey || k === '{' || k === '}') B.feather = clamp(B.feather + (up ? 10 : -10), 0, 100);
        else B.size = clamp(Math.round(B.size * (up ? 1.15 : 0.87) + (up ? 1 : -1)), 1, 100);
        app.refreshPanel();
        app.drawOverlay();
      } else if (t === 'crop') app.panel.rot(up ? 1 : -1)();
      break;
    }
    case 'ArrowLeft': case 'ArrowRight': {
      if (tag === 'INPUT') return;
      const list = visibleImages();
      const n = list.indexOf(app.images[app.cur]) + (k === 'ArrowRight' ? 1 : -1);
      if (n >= 0 && n < list.length) select(app.images.indexOf(list[n]));
      break;
    }
    case 'Delete': case 'Backspace': {
      const m = activeMask(app);
      if (t === 'retouch') deleteSelected(app);
      else if (t === 'masks' && m) removeMask(app, m);
      else if (app.view.mode === 'edit' && app.images[app.cur]) deletePhotos([app.images[app.cur].id]);
      break;
    }
    default: return;
  }
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; viewer.style.cursor = ''; }
});

// ================================================================== boot

// Desktop: the system browser finishes OAuth and deep-links the code back; pick it up here.
function watchDesktopSignIn() {
  const t = window.__TAURI_INTERNALS__;
  if (!t) return;
  const check = async () => {
    try {
      const r = await t.invoke('take_auth_code');
      if (!r?.code) return;
      if (r.state?.startsWith('adobe')) { await adobe.completeAdobeSignIn(r.code, r.state); return; }
      await sb.completeSignIn(r.code); app.toast('Signed in'); await startSync(); paintTopAvatar();
    } catch (e) { app.toast(`Sign-in failed: ${e.message}`); }
  };
  setInterval(check, 1500);
  window.addEventListener('focus', check);
}

function boot() {
  initTheme();
  watchDesktopSignIn();
  startUpdateChecks();
  if (isMobileApp) refreshUnlock();
  canvasBg = cssRGB('--canvas');
  onThemeChange(() => {
    canvasBg = cssRGB('--canvas');
    if (app.engine) app.engine.beforeKey = null;
    app.refreshPanel();
    app.requestRender();
  });
  // Histogram can be folded away to give the controls more room.
  try { if (localStorage.getItem('lumen:histo') === '0') document.querySelector('.panel').classList.add('histo-collapsed'); } catch { /* ignore */ }
  $('info').addEventListener('click', () => {
    const c = document.querySelector('.panel').classList.toggle('histo-collapsed');
    try { localStorage.setItem('lumen:histo', c ? '0' : '1'); } catch { /* ignore */ }
    if (!c) app.requestRender();
  });
  $('modKey').textContent = isMac ? '⌘' : 'Ctrl';
  document.querySelectorAll('[data-icon]').forEach((n) => n.prepend(icon(n.dataset.icon)));
  try {
    app.engine = new AppEngine(canvas);
    app.engine.hostPasses = chain(refocusPass, localAdjustments, studioPass, lensPass, motionPass);
    // Test hook: ?debug exposes the app to automated checks.
    if (new URLSearchParams(location.search).has('debug')) window.__rembrandt = app;
    app.engine.sourcePasses = retouchPasses;
    ai.onChange(() => { if (app.state.tool === 'ai' || app.state.tool === 'masks') app.refreshPanel(); app.requestRender(); });
  } catch (err) {
    console.error(err);
    $('empty').hidden = false;
    $('emptyTitle').textContent = 'Your browser can’t run the editor';
    $('emptyText').textContent = err.message + ' Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.';
    $('btnOpenEmpty').hidden = true;
    return;
  }
  app.engine.previewLong = prefs.previewLong;
  paintAvatar($('avatar'));
  if (isTouch) {
    $('emptyTitle').innerHTML = 'Open photos to start <em>editing</em>';
    $('emptyText').textContent = 'Pick photos from your library. Everything happens on this device, and nothing is uploaded.';
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); app.toast('Graphics context lost — reload the page to continue'); });
  warmDownloads();
  app.updateUndo();
  app.buildPanel();
  library = buildLibrary(app, {
    openInEditor, removePhotos, deletePhotos, keepOnDevice, syncAnyway, syncOn: () => cloud.cloud.available, setRating, setFlag, syncSettings, exportPhotos,
    copyEdits: copyEditsFrom, pasteEdits: pasteEditsTo, resetEdits, photoMenu, presetMenu, pointAnchor, clipboard: batch.clipboard, describeClip: batch.describeClip,
    importFiles: () => openImporter(),
    syncFolder: (f) => (f ? syncFolder(f) : addSyncedFolder()),
    unsyncFolder,
    reconnectFolder: async (f) => { if (await folders.reconnect(f)) syncFolder(f); },
    stripChanged: renderStrip,
    openPlan: () => setMode('account', 'cloud'),
    openAccount: (section) => setMode('account', section),
    share: sharePhotos,
    paintStorage,
  });
  $('library').replaceWith(library.el);
  accountPage = buildAccountPage(app, accountHooks);
  $('accountPage').replaceWith(accountPage.el);
  app.cloudState = () => cloud.cloud;
  cloud.onCloudChange(() => { library?.repaintStorage?.(); paintTopAvatar(); gate(); });
  // The website's editor (CONFIG.hosted) opens for Cloud subscribers; everyone else signs in first.
  const gate = () => updateGate(app, cloud.cloud, async () => { await startSync(); gate(); });
  if (gated()) gate();
  window.lumen = app; // handy for debugging from the console
  albums.loadAlbums().then(loadCatalog).then(() => folders.loadFolders().catch((e) => console.warn(e))).then(() => {
    refreshLibrary();
    sweepFolders(true);
    setInterval(() => sweepFolders(false), 60000);
    window.addEventListener('focus', () => sweepFolders(false));
    setMode(app.images.length ? 'library' : 'edit');
    startSync().then(async () => {
      if (app.images.length && app.view.mode === 'edit' && !app.img) setMode('library');
      // Phone: renewals, upgrades and purchases on another phone reach the account.
      if (isMobileApp && cloud.cloud.signedIn && await syncStoreSubscriptions().catch(() => 0)) { await startSync(); paintTopAvatar(); }
    });
  });
}
boot();
