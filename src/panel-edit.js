// The main "Edit" panel: light, color, effects, curve, mixer, grading, detail.
import { el, getPath, setPath } from './util.js';
import { slider, section, segmented, iconButton, button, popMenu, toggle } from './ui.js';
import { curveEditor, hslMixer, gradingControl } from './widgets.js';
import { defaultParams } from './params.js';

const TEMP_TRACK = 'linear-gradient(90deg,#4f7dff,#9fb4d9 45%,#d9c49f 55%,#ffb53d)';
const TINT_TRACK = 'linear-gradient(90deg,#3fcf5f,#9fcfa9 45%,#d3a5cf 55%,#e04fd8)';

export function buildEditPanel(app) {
  const D = defaultParams();
  const reg = [];
  const S = (path, label, min, max, step = 1, extra = {}) => {
    const c = slider({
      label, min, max, step, def: getPath(D, path),
      get: () => getPath(app.params, path),
      set: (v) => app.set(path, v),
      commit: () => app.commit(),
      ...extra,
    });
    reg.push(c);
    return c.el;
  };
  const B = {
    light: { icon: 'sun', color: 'linear-gradient(135deg,#ffc04d,#ff7a1a)' },
    color: { icon: 'drop', color: 'linear-gradient(135deg,#ff5f9e,#a55cff)' },
    effects: { icon: 'fx', color: 'linear-gradient(135deg,#4dd0ff,#3a6bff)' },
    curve: { icon: 'curve', color: 'linear-gradient(135deg,#4be3b6,#139e76)' },
    mixer: { icon: 'mixer', color: 'conic-gradient(from 200deg,#ff5f5f,#ffd34d,#4de38a,#4dc3ff,#8a6bff,#ff5fc8,#ff5f5f)' },
    grading: { icon: 'wheel', color: 'linear-gradient(135deg,#ff8a65,#7c5cff)' },
    detail: { icon: 'detail', color: 'linear-gradient(135deg,#a3acbd,#5a6376)' },
    optics: { icon: 'aperture', color: 'linear-gradient(135deg,#8fd3ff,#4a7bd6)' },
  };
  // Section header switch: turns the whole group off without losing its settings.
  const on = (g) => ({ get: () => !app.params.off?.[g], set: (v) => app.setGroupOn(g, v) });
  const sec = (title, g, opts) => {
    const x = section(title, { ...opts, badge: B[g], enabled: on(g) });
    reg.push(x);
    return x;
  };
  const resetPaths = (paths) => () => {
    for (const p of paths) setPath(app.params, p, structuredClone(getPath(D, p)));
    app.requestRender();
    app.commit();
    app.refreshPanel();
  };

  // --- header tools
  const treatment = segmented([{ value: false, label: 'Color' }, { value: true, label: 'B&W' }], app.params.bw, (v) => {
    app.params.bw = v; app.requestRender(); app.commit();
  }, 'seg-sm treatment');
  reg.push({ refresh: () => treatment.set(app.params.bw) });

  const tools = el('div', { class: 'edit-tools' },
    button('Auto', () => app.autoTone(), 'sm', 'wand'),
    treatment.el,
    el('span', { class: 'grow' }),
    iconButton('more', 'More', (e) => popMenu(e.currentTarget, [
      { label: 'Copy edits', icon: 'copy', onClick: () => app.copySettings() },
      { label: 'Choose what to copy…', icon: 'copy', onClick: () => app.copySettings(true) },
      { label: 'Paste edits', icon: 'paste', onClick: () => app.pasteSettings() },
      { sep: true },
      { label: 'Reset all edits', icon: 'reset', onClick: () => app.resetAll() },
    ]), 'sm'),
  );

  // --- light
  const light = sec('Light', 'light', { id: 'light', onReset: resetPaths(['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']) });
  light.body.append(
    S('exposure', 'Exposure', -5, 5, 0.01),
    S('contrast', 'Contrast', -100, 100),
    el('div', { class: 'divider' }),
    S('highlights', 'Highlights', -100, 100),
    S('shadows', 'Shadows', -100, 100),
    S('whites', 'Whites', -100, 100),
    S('blacks', 'Blacks', -100, 100),
  );

  // --- color
  const color = sec('Color', 'color', { id: 'color', open: false, onReset: resetPaths(['temp', 'tint', 'vibrance', 'saturation']) });
  const picker = iconButton('picker', 'Pick a neutral point (W)', () => app.pickWhiteBalance(), 'sm');
  color.body.append(
    el('div', { class: 'subhead' }, el('span', {}, 'White balance'), picker),
    S('temp', 'Temperature', -100, 100, 1, { track: TEMP_TRACK }),
    S('tint', 'Tint', -100, 100, 1, { track: TINT_TRACK }),
    el('div', { class: 'divider' }),
    S('vibrance', 'Vibrance', -100, 100),
    S('saturation', 'Saturation', -100, 100),
  );

  // --- effects
  const fx = sec('Effects', 'effects', { id: 'effects', open: false, onReset: resetPaths(['texture', 'clarity', 'dehaze', 'haze', 'vignette', 'grain']) });
  fx.body.append(
    S('texture', 'Texture', -100, 100),
    S('clarity', 'Clarity', -100, 100),
    S('dehaze', 'Dehaze', -100, 100),
    S('haze', 'Haze', -100, 100),
    el('div', { class: 'subhead' }, 'Vignette'),
    S('vignette.amount', 'Amount', -100, 100),
    S('vignette.midpoint', 'Midpoint', 0, 100),
    S('vignette.roundness', 'Roundness', -100, 100),
    S('vignette.feather', 'Feather', 0, 100),
    el('div', { class: 'subhead' }, 'Grain'),
    S('grain.amount', 'Amount', 0, 100),
    S('grain.size', 'Size', 0, 100),
    S('grain.roughness', 'Roughness', 0, 100),
  );

  // --- curve
  const curve = sec('Curve', 'curve', { id: 'curve', open: false, onReset: resetPaths(['curve']) });
  const ce = curveEditor(app);
  reg.push(ce);
  curve.body.append(ce.el);

  // --- mixer
  const mixer = sec('Color Mixer', 'mixer', { id: 'mixer', open: false, onReset: resetPaths(['hsl']) });
  mixer.body.append(hslMixer(app, reg));

  // --- grading
  const grading = sec('Color Grading', 'grading', { id: 'grading', open: false, onReset: resetPaths(['grading']) });
  grading.body.append(gradingControl(app, reg));

  // --- detail
  const detail = sec('Detail', 'detail', { id: 'detail', open: false, onReset: resetPaths(['sharpen', 'nr']) });
  detail.body.append(
    el('div', { class: 'subhead' }, 'Sharpening'),
    S('sharpen.amount', 'Amount', 0, 150),
    S('sharpen.radius', 'Radius', 0.5, 3, 0.1),
    S('sharpen.masking', 'Masking', 0, 100),
    el('div', { class: 'subhead' }, 'Noise reduction'),
    S('nr.luma', 'Luminance', 0, 100),
    S('nr.chroma', 'Color', 0, 100),
    el('div', { class: 'hint' }, 'Zoom to 100% to judge detail accurately.'),
  );

  // --- lens corrections
  const optics = sec('Lens Corrections', 'optics', { id: 'optics', open: false, onReset: resetPaths(['optics']) });
  const profileNote = el('div', { class: 'hint' });
  const useProfile = toggle('Use the camera’s lens profile', () => {
    const o = app.params.optics || {}, prof = app.lensProfile?.();
    return o.profile === true || (o.profile === 'auto' && !!prof?.defaultOn);
  }, (v) => { app.set('optics.profile', v); app.commit(); app.refreshPanel(); });
  const useCa = toggle('Remove chromatic aberration', () => app.params.optics?.ca !== false, (v) => { app.set('optics.ca', v); app.commit(); });
  const profileBox = el('div', {}, useProfile.el, S('optics.distortion', 'Distortion', 0, 200), S('optics.vignetting', 'Vignetting', 0, 200), useCa.el);
  reg.push({ refresh: () => {
    const prof = app.lensProfile?.();
    profileNote.textContent = prof ? `${prof.source} correction found in this photo.` : 'This photo has no built-in lens data (Fujifilm and Sony RAW files do). Use the manual corrections below.';
    profileBox.hidden = !prof;
    useProfile.refresh(); useCa.refresh();
  } });
  optics.body.append(
    profileNote, profileBox,
    el('div', { class: 'subhead' }, 'Manual'),
    S('optics.manualDistortion', 'Distortion', -100, 100),
    S('optics.manualVignette', 'Vignetting', -100, 100),
    S('optics.manualMidpoint', 'Midpoint', 0, 100),
  );

  const root = el('div', { class: 'panel-view' }, tools, light.el, color.el, fx.el, curve.el, mixer.el, grading.el, detail.el, optics.el);
  return { el: root, refresh: () => reg.forEach((c) => c.refresh()) };
}
