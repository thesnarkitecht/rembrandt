// The background-work indicator in the top bar: hidden when nothing is queued; otherwise a small
// ring showing progress, and a list of jobs to pause, cancel, run now or move to tonight.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { icon } from './icons.js';
import { allJobs, onJobsChange, cancelJob, pauseJob, runNow, reschedule, clearFinished, nightLabel } from './jobs.js';

const WHEN = { now: 'Now', away: 'When you’re away', tonight: () => `Tonight, ${nightLabel()}` };
const whenText = (w) => (typeof WHEN[w] === 'function' ? WHEN[w]() : WHEN[w]);

export function mountJobs(anchor) {
  const ring = el('span', { class: 'jobs-ring' });
  const count = el('span', { class: 'jobs-count' });
  const btn = el('button', { class: 'icon-btn jobs-btn', type: 'button', hidden: true, 'aria-label': 'Background work', title: 'Background work' }, ring, count);
  const panel = el('div', { class: 'jobs-panel', hidden: true, role: 'dialog', 'aria-label': 'Background work' });
  anchor.before(btn);
  document.body.append(panel);
  let recentUntil = 0;

  const place = () => {
    const r = btn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 8}px`;
    panel.style.right = `${Math.max(8, innerWidth - r.right - 60)}px`;
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) { place(); paint(); } });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true; });

  function row(j) {
    const live = j.state === 'running' || j.state === 'queued';
    const status = j.state === 'running' ? (j.paused ? 'Paused' : j.note || `${Math.round(j.progress * 100)}%`)
      : j.state === 'queued' ? whenText(j.when) : j.state === 'done' ? 'Done' : j.state === 'failed' ? j.error || 'Failed' : 'Cancelled';
    const act = (name, title, fn) => el('button', { class: 'icon-btn sm', type: 'button', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name));
    return el('div', { class: `job-row is-${j.state}` },
      el('div', { class: 'job-main' },
        el('div', { class: 'job-title' }, j.title),
        el('div', { class: 'job-status' }, status),
        live ? el('div', { class: 'progress thin' }, el('span', { style: `width:${Math.round(j.progress * 100)}%` })) : null),
      el('div', { class: 'job-acts' },
        j.state === 'running' ? act(j.paused ? 'redo' : 'minus', j.paused ? 'Resume' : 'Pause', () => pauseJob(j.id, !j.paused)) : null,
        j.state === 'queued' && j.when !== 'now' ? act('redo', 'Run now', () => runNow(j.id)) : null,
        j.state === 'queued' && j.when !== 'tonight' ? act('clock', `Tonight, ${nightLabel()}`, () => reschedule(j.id, 'tonight')) : null,
        live ? act('x', 'Cancel', () => cancelJob(j.id)) : null,
        j.state === 'done' && j.open ? act('edit', 'Open', () => j.open()) : null));
  }

  function paint() {
    const list = allJobs();
    const live = list.filter((j) => j.state === 'running' || j.state === 'queued');
    const running = list.find((j) => j.state === 'running');
    if (live.length) recentUntil = Date.now() + 8000;
    btn.hidden = !live.length && Date.now() > recentUntil && panel.hidden;
    count.textContent = live.length ? String(live.length) : '';
    const p = running ? running.progress : live.length ? 0 : 1;
    ring.style.setProperty('--p', `${Math.round(p * 100)}%`);
    btn.classList.toggle('waiting', !running && live.length > 0);
    btn.title = running ? `${running.title}: ${Math.round(running.progress * 100)}%` : live.length ? `${live.length} waiting · ${whenText(live[0].when)}` : 'Background work done';
    if (panel.hidden) return;
    panel.replaceChildren(
      el('div', { class: 'jobs-head' }, el('b', {}, 'Background work'),
        list.some((j) => !['running', 'queued'].includes(j.state)) ? el('button', { class: 'linkish', type: 'button', onclick: () => clearFinished() }, 'Clear finished') : null),
      list.length ? el('div', { class: 'jobs-list' }, [...list].reverse().map(row)) : el('p', { class: 'hint' }, 'Nothing running.'),
      el('p', { class: 'hint jobs-foot' }, 'Heavy work pauses while you edit. Change when it runs in Settings › Performance.'));
  }
  onJobsChange(paint);
  setInterval(() => { if (!btn.hidden && Date.now() > recentUntil) paint(); }, 3000);
  paint();
}
