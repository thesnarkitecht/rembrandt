// The main "Edit" panel: light, color, effects, curve, mixer, grading, detail.
import { el, getPath, setPath } from './util.js';
import { slider, section, segmented, iconButton, button, popMenu, toggle , disclosure } from './ui.js';
import { icon } from './icons.js';
import { autoVertical } from './tool-crop.js';
import { detectDistortion } from './lens-auto.js';
import { curveEditor, hslMixer, gradingControl, pointColorControl, snapshotsControl } from './widgets.js';
import { defaultParams } from './params.js';
import { LOOKS } from './looks.js';
import { PROFILES } from '../engine/src/color.js';
import { shown, aiOn } from './workspace.js';

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
    hdr: { icon: 'sun', color: 'linear-gradient(135deg,#ffe08a,#ff9f1c)' },
    curve: { icon: 'curve', color: 'linear-gradient(135deg,#4be3b6,#139e76)' },
    mixer: { icon: 'mixer', color: 'conic-gradient(from 200deg,#ff5f5f,#ffd34d,#4de38a,#4dc3ff,#8a6bff,#ff5fc8,#ff5f5f)' },
    grading: { icon: 'wheel', color: 'linear-gradient(135deg,#ff8a65,#7c5cff)' },
    look: { icon: 'presets', color: 'linear-gradient(135deg,#d4a373,#7f5539)' },
    detail: { icon: 'detail', color: 'linear-gradient(135deg,#a3acbd,#5a6376)' },
    optics: { icon: 'aperture', color: 'linear-gradient(135deg,#8fd3ff,#4a7bd6)' },
  };
  // Section header switch: turns the whole group off without losing its settings.
  const on = (g) => ({ get: () => !app.params.off?.[g], set: (v) => app.setGroupOn(g, v) });
  const sec = (title, g, opts) => {
    const x = section(title, { ...opts, badge: B[g], enabled: on(g) });
    x.el.hidden = !shown('edit:' + opts.id);   // Settings → Workspace
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

  const tools = el('div', { class: 'edit-tools' + (aiOn() ? '' : ' no-ai') },
    button('Auto', () => app.autoTone(), 'sm', 'wand'),
    aiOn() ? Object.assign(button('Like me', () => app.editLikeMe(), 'sm', 'sparkle'), { title: 'Edit like me: settings learned from the photos you’ve edited' }) : null,
    treatment.el,
    el('span', { class: 'grow' }),
    iconButton('more', 'More', (e) => popMenu(e.currentTarget, [
      { label: 'Copy edits', icon: 'copy', onClick: () => app.copySettings() },
      { label: 'Choose what to copy…', icon: 'copy', onClick: () => app.copySettings(true) },
      { label: 'Paste edits', icon: 'paste', onClick: () => app.pasteSettings() },
      { sep: true },
      { label: 'HDR from this photo', icon: 'sun', onClick: () => app.hdrFromOne('natural') },
      { label: 'HDR from this photo (strong)', icon: 'sun', onClick: () => app.hdrFromOne('strong') },
      { sep: true },
      { label: 'Reset all edits', icon: 'reset', onClick: () => app.resetAll() },
    ]), 'sm'),
  );

  // --- profile (RAWs): how the camera's data becomes colour, before any slider.
  const profBtn = button('', (e) => {
    const cm = app.cameraMatch, key = cm?.key();
    const pick = (v) => { app.params.profile = v; app.params.cameraLook = false; app.requestRender(); app.commit(); app.refreshPanel(); };
    popMenu(e.currentTarget, [
      { label: PROFILES.color, checked: app.params.profile !== 'standard' && !app.params.cameraLook, onClick: () => pick('color') },
      { label: PROFILES.standard, checked: app.params.profile === 'standard' && !app.params.cameraLook, onClick: () => pick('standard') },
      ...(key ? [{ sep: true }, { label: `Match my ${key}`, checked: !!app.params.cameraLook, onClick: () => {
        if (!cm.info()) { cm.learn(); return; }
        app.set('cameraLook', true); app.commit(); app.refreshPanel();
      } }] : []),
    ]);
  }, 'sm profile-pick');
  profBtn.append(icon('chevron', 'i chev'));
  const profRow = el('div', { class: 'profile-row' }, el('span', { class: 'profile-label' }, 'Profile'), profBtn);
  reg.push({ refresh: () => {
    profRow.hidden = !app.images[app.cur]?.raw;
    profBtn.firstChild.textContent = app.params.cameraLook && app.cameraMatch?.info() ? `Match my ${app.cameraMatch.key()}` : PROFILES[app.params.profile === 'standard' ? 'standard' : 'color'];
  } });

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
  // Match my camera (RAWs): the camera's own colour, learned from the JPEGs inside its RAW files.
  const cm = app.cameraMatch;
  const camToggle = toggle('Match my camera', () => app.params.cameraLook && cm?.info(), (v) => {
    if (v && !cm.info()) { cm.learn(); return; }
    app.set('cameraLook', v); app.commit();
  });
  const camNote = el('p', { class: 'hint' });
  const camBtn = button('Learn', () => cm.learn(), 'sm');
  const camBox = el('div', { class: 'cam-match' }, el('div', { class: 'divider' }),
    el('div', { class: 'subhead' }, el('span', {}, 'Camera color'), camBtn), camToggle.el, camNote);
  color.body.append(camBox);
  reg.push({ refresh: () => {
    const key = cm?.key(), info = cm?.info();
    camBox.hidden = !key;
    if (!key) return;
    camToggle.refresh();
    camBtn.lastChild.textContent = cm.busy ? 'Learning…' : info ? 'Relearn' : 'Learn';
    camBtn.disabled = cm.busy;
    camNote.textContent = info
      ? `Your ${key}’s look, learned from ${info.photos} photo${info.photos === 1 ? '' : 's'} (ΔE ${info.err[0]} → ${info.err[1]} on held-out pixels).`
      : `Learns how your ${key} renders color from the JPEGs inside its RAW files. On this device.`;
  } });

  // --- HDR: local tone mapping, live. One tap for a strength, three sliders to shape it.
  const HDRS = [['Off', 0, 0, 0], ['Natural', 40, 0, 15], ['Balanced', 65, 0, 30], ['Dramatic', 90, 0, 60], ['Sky', 60, 60, 20], ['Interior', 70, -60, 25]];
  const hdrOf = () => (app.params.hdr ||= { amount: 0, balance: 0, detail: 0 });
  const hdr = sec('HDR', 'hdr', { id: 'hdr', open: false, onReset: () => { app.params.hdr = { amount: 0, balance: 0, detail: 0 }; app.requestRender(); app.commit(); app.refreshPanel(); } });
  const hdrChips = el('div', { class: 'chips' });
  const paintHdr = () => {
    const h = hdrOf();
    hdrChips.replaceChildren(...HDRS.map(([name, a, b, d]) => {
      const cur = h.amount === a && h.balance === b && h.detail === d;
      return el('button', { class: 'chip' + (cur ? ' on' : ''), 'aria-pressed': String(cur), onclick: () => {
        Object.assign(hdrOf(), { amount: a, balance: b, detail: d });
        app.requestRender(); app.commit(); app.refreshPanel();
      } }, name);
    }));
  };
  const hdrS = (key, label, min, max, extra = {}) => slider({ label, min, max, def: 0, get: () => hdrOf()[key] || 0, set: (v) => { hdrOf()[key] = v; app.requestRender(); }, commit: () => { app.commit(); paintHdr(); }, ...extra });
  const hdrCtl = [hdrS('amount', 'Strength', 0, 100), hdrS('balance', 'Balance', -100, 100), hdrS('detail', 'Detail', 0, 100)];
  hdrCtl[1].el.title = 'Left: open the shadows more. Right: bring the highlights down more.';
  hdr.body.append(hdrChips, ...hdrCtl.map((c) => c.el),
    disclosure('hdr-more', 'More',
      el('p', { class: 'hint' }, 'Works on one photo. For bracketed exposures, select them in the Library and choose Merge › HDR. Export › HDR saves brighter highlights for HDR screens.'),
      el('div', { class: 'row-btns' }, button('Make an HDR copy', () => { try { app.hdrFromOne('natural'); } catch (err) { app.toast(err.message); } }, 'sm ghost', 'sun'))));
  reg.push({ refresh: () => { paintHdr(); hdrCtl.forEach((c) => c.refresh()); } });

  // --- look: film looks and imported .cube LUTs
  const look = sec('Look', 'look', { id: 'look', open: false, onReset: resetPaths(['look']) });
  const chips = el('div', { class: 'chips' });
  const paintChips = () => {
    const cur = app.params.look?.lut || null;
    const opts = [[null, 'None'], ...Object.entries(LOOKS).map(([k, [name]]) => [k, name]), ...app.userLooks().map((l) => [l.key, l.name])];
    chips.replaceChildren(...opts.map(([k, name]) => el('button', { class: 'chip' + (cur === k ? ' on' : ''), 'aria-pressed': String(cur === k), onclick: () => {
      app.params.look = { lut: k, amount: app.params.look?.amount || 100 };
      app.requestRender(); app.commit(); paintChips(); lookAmt.refresh();
    } }, name)));
  };
  const lookAmt = slider({ label: 'Amount', min: 0, max: 100, def: 100, get: () => app.params.look?.amount ?? 100, set: (v) => { app.params.look = { ...app.params.look, amount: v }; app.requestRender(); }, commit: () => app.commit() });
  look.body.append(chips, lookAmt.el, el('div', { class: 'row-btns' }, button('Import .cube…', () => app.importCube(), 'sm ghost', 'open')),
    el('p', { class: 'hint' }, 'Film-style colour, or any 3D LUT (.cube) from a colourist or another editor.'));
  reg.push({ refresh: () => { paintChips(); lookAmt.refresh(); } });

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
  const mixer = sec('Color Mixer', 'mixer', { id: 'mixer', open: false, onReset: resetPaths(['hsl', 'pointColor']) });
  mixer.body.append(hslMixer(app, reg), el('div', { class: 'subhead' }, 'Point Color'), pointColorControl(app, reg));

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
    S('nr.speckle', 'Color speckles', 0, 100),
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
    profileNote.textContent = prof ? (prof.source.startsWith('Lensfun') ? `Profile for ${prof.source.slice(9)}, from the Lensfun database.` : `${prof.source} correction found in this photo.`)
      : 'No profile for this lens: neither built into the file nor in the Lensfun database. Use the manual corrections below.';
    profileBox.hidden = !prof;
    useProfile.refresh(); useCa.refresh();
  } });
  optics.body.append(
    profileNote, profileBox,
    el('div', { class: 'subhead' }, el('span', {}, 'Manual'), button('Auto', () => {
      // Straight lines made straight, from the small copy of the photo (before lens corrections).
      const sm = app.images[app.cur]?.sample;
      const r = sm && detectDistortion({ width: sm.w, height: sm.h, data: sm.data });
      if (!r) { app.toast('No clear straight lines to judge the lens by in this photo'); return; }
      app.set('optics.manualDistortion', r.amount); app.commit(); app.refreshPanel();
      app.toast(`Distortion ${r.amount > 0 ? '+' : ''}${r.amount}: ${r.amount > 0 ? 'barrel' : 'pincushion'} distortion corrected`);
    }, 'sm ghost')),
    S('optics.manualDistortion', 'Distortion', -100, 100),
    S('optics.manualVignette', 'Vignetting', -100, 100),
    S('optics.manualMidpoint', 'Midpoint', 0, 100),
    el('div', { class: 'subhead' }, el('span', {}, 'Transform'), button('Auto', () => {
      const v = autoVertical(app);
      if (v == null) { app.toast('No clear vertical lines to straighten in this photo'); return; }
      app.set('optics.vertical', v); app.commit(); app.refreshPanel();
      app.toast(`Vertical ${v > 0 ? '+' : ''}${v}: converging verticals made parallel`);
    }, 'sm ghost')),
    S('optics.vertical', 'Vertical', -100, 100),
    S('optics.horizontal', 'Horizontal', -100, 100),
  );

  // --- snapshots
  const snaps = section('Snapshots', { id: 'snapshots', open: false });
  snaps.body.append(snapshotsControl(app, reg));
  reg.push(snaps);

  const root = el('div', { class: 'panel-view' }, tools, profRow, light.el, hdr.el, color.el, look.el, fx.el, curve.el, mixer.el, grading.el, detail.el, optics.el, snaps.el);
  const panel = { el: root, refresh: () => reg.forEach((c) => c.refresh()) };
  // A panel built again (coming back from another tool) starts in step with the photo: without this
  // the Profile row showed, blank, on photos that aren't RAW.
  panel.refresh();
  return panel;
}
