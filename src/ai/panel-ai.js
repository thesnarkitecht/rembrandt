// AI panel: Refocus (deblur), Lens Blur and Background. Everything runs on this device.
// Copyright © 2026 light.work. Licensed under the PolyForm Shield License 1.0.0 (see LICENSE).
// You may not sell this software or a modified version of it; see LICENSE and TRADEMARKS.md.
import { el } from '../util.js';
import { slider, section, segmented, toggle, button, disclosure } from '../ui.js';
import { icon } from '../icons.js';
import { defaultParams } from '../params.js';

export function buildAIPanel(app) {
  const D = defaultParams().ai;
  const reg = [];
  const A = () => app.params.ai;
  const S = (get, set, label, min, max, def, extra = {}) => {
    const c = slider({ label, min, max, def, get, set: (v) => { set(v); app.aiEnsure(); app.requestRender(); }, commit: () => app.commit(), ...extra });
    reg.push(c);
    return c.el;
  };
  const status = el('div', { class: 'ai-status' });
  const paintStatus = () => {
    const busy = app.ai.busy > 0;
    status.hidden = !busy && !app.aiError;
    status.classList.toggle('busy', busy);
    status.textContent = '';
    status.append(icon('sparkle'), el('span', {}, busy ? 'Analyzing the photo on this device…' : `AI isn’t available: ${app.aiError}`));
  };
  paintStatus();
  reg.push({ refresh: paintStatus });
  const on = (g) => ({ get: () => !app.params.off?.[g], set: (v) => app.setGroupOn(g, v) });
  const resetGroup = (k) => () => { app.params.ai[k] = structuredClone(D[k]); app.commit(); app.requestRender(); refresh(); };

  // ---- refocus
  const refocus = section('Refocus', { id: 'ai-refocus', badge: { icon: 'focus' }, enabled: on('refocus'), onReset: resetGroup('refocus') });
  const scope = segmented([{ value: 'subject', label: 'Subject' }, { value: 'all', label: 'Whole photo' }], A().refocus.scope, (v) => {
    A().refocus.scope = v; app.aiEnsure(); app.commit(); app.requestRender();
  }, 'seg-sm');
  reg.push({ refresh: () => scope.set(A().refocus.scope) });
  const blurLabel = () => {
    const est = app.images[app.cur]?.ai?.blur;
    return A().refocus.radius > 0 ? 'Custom' : est ? 'Auto' : 'Auto';
  };
  refocus.body.append(
    S(() => A().refocus.amount, (v) => { A().refocus.amount = v; }, 'Amount', 0, 100, 0),
    scope.el,
    disclosure('ai-refocus', 'More options',
      S(() => (A().refocus.radius > 0 ? A().refocus.radius : app.images[app.cur]?.ai?.blur?.radiusH || 0.004) * 1000, (v) => { A().refocus.radius = v / 1000; }, 'Blur size', 0.5, 20, 4,
        { step: 0.1, format: (v) => (A().refocus.radius > 0 ? v.toFixed(1) : `${blurLabel()} · ${v.toFixed(1)}`) }),
      S(() => A().refocus.protect, (v) => { A().refocus.protect = v; }, 'Noise protection', 0, 100, 30),
      el('div', { class: 'row-btns' }, button('Detect blur again', () => { A().refocus.radius = -1; app.commit(); app.requestRender(); refresh(); }, 'sm ghost', 'wand'))),
  );

  // ---- lens blur
  const lens = section('Lens Blur', { id: 'ai-lens', badge: { icon: 'aperture' }, enabled: on('lens'), onReset: resetGroup('blur') });
  const protect = toggle('Keep subject sharp', () => A().blur.protect, (v) => { A().blur.protect = v; app.aiEnsure(); app.commit(); app.requestRender(); });
  const showDepth = toggle('Show depth map', () => app.state.showDepth, (v) => { app.state.showDepth = v; app.requestRender(); });
  reg.push(protect, showDepth);
  lens.body.append(
    S(() => A().blur.amount, (v) => { A().blur.amount = v; }, 'Amount', 0, 100, 0),
    el('div', { class: 'inline-btns' },
      button('Set focus point', () => app.startPick('focus'), 'sm', 'focus'),
      button('Auto', () => { A().blur.focus = -1; app.aiEnsure(); app.commit(); app.requestRender(); refresh(); }, 'sm ghost', 'subject')),
    S(() => A().blur.range, (v) => { A().blur.range = v; }, 'Depth of field', 0, 100, 12),
    disclosure('ai-lens', 'More options',
      S(() => (A().blur.focus < 0 ? app.aiFocus() : A().blur.focus) * 100, (v) => { A().blur.focus = v / 100; }, 'Focal distance', 0, 100, 80,
        { format: (v) => (A().blur.focus < 0 ? 'Auto' : `${Math.round(v)}`) }),
      S(() => A().blur.bokeh, (v) => { A().blur.bokeh = v; }, 'Bokeh highlights', 0, 100, 0),
      protect.el, showDepth.el),
  );

  // ---- background
  const bg = section('Background', { id: 'ai-bg', badge: { icon: 'background' }, enabled: on('background'), onReset: resetGroup('bg') });
  const mode = segmented([
    { value: 'none', label: 'Original' }, { value: 'blur', label: 'Blur' }, { value: 'color', label: 'Color' }, { value: 'image', label: 'Picture' },
  ], A().bg.mode, (v) => {
    A().bg.mode = v;
    if (v === 'blur' && !A().bg.blur) A().bg.blur = 60;
    if (v === 'image' && !A().bg.image) { app.chooseBackground(); return; }
    app.aiEnsure(); app.commit(); app.requestRender(); refresh();
  }, 'seg-sm');
  const colorIn = el('input', { type: 'color', class: 'color-input', value: A().bg.color, id: 'bgColor' });
  colorIn.addEventListener('input', () => { A().bg.color = colorIn.value; app.aiEnsure(); app.requestRender(); });
  colorIn.addEventListener('change', () => app.commit());
  const colorRow = el('label', { class: 'row between color-row' }, el('span', { class: 'hint' }, 'Backdrop color'), colorIn);
  const picRow = el('div', { class: 'row-btns' }, button('Choose picture…', () => app.chooseBackground(), 'sm ghost', 'image'));
  const blurRow = el('div', {}, S(() => A().bg.blur, (v) => { A().bg.blur = v; }, 'Blur', 0, 100, 60));
  const showRows = () => {
    mode.set(A().bg.mode);
    colorIn.value = A().bg.color;
    colorRow.hidden = A().bg.mode !== 'color';
    picRow.hidden = A().bg.mode !== 'image';
    blurRow.hidden = A().bg.mode !== 'blur';
  };
  showRows();
  reg.push({ refresh: showRows });
  bg.body.append(mode.el, blurRow, colorRow, picRow);

  reg.push(refocus, lens, bg);
  const root = el('div', { class: 'panel-view' }, status, refocus.el, lens.el, bg.el);
  function refresh() { reg.forEach((c) => c.refresh()); }
  return { el: root, refresh };
}
