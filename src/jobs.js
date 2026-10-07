// Background work: one queue for everything heavy (AI Denoise, Super Resolution, merges, batch work),
// run so the editor never stutters.
//
// • Work is done in small chunks. Between chunks `breathe()` gives the browser a frame, and while you
//   are dragging, typing or scrolling it waits until you stop: editing always comes first.
// • Chunk sizes adapt (`chunker`): each GPU or CPU step is sized to take about the budget of the
//   chosen performance mode, so a slow laptop takes smaller bites rather than freezing.
// • When is a job allowed to run: now (gently, around your editing), when you're away (no input for a
//   minute, or the window hidden), or tonight (in the night window, default 1:00–6:00, keeping the
//   screen awake while it works). Away and tonight run at full speed.
// • Jobs that can be described (which photos, which settings) are remembered across restarts.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { prefs, savePrefs } from './account.js';
import { uid } from './util.js';

// Performance modes: how long one chunk may hold the GPU / main thread while you edit, and how long
// after your last input work waits before going on.
export const MODES = {
  smooth: { label: 'Smooth editing', budget: 10, quiet: 1500 },
  balanced: { label: 'Balanced', budget: 25, quiet: 800 },
  fast: { label: 'Fastest', budget: 80, quiet: 250 },
};
const FULL = 250;   // budget when nobody is editing (away, tonight)
const AWAY = 60e3;  // no input for this long = away

const mode = () => MODES[prefs.perf] || MODES.balanced;
let lastInput = performance.now();
let current = null;                     // running job
const jobs = [];
const listeners = new Set();
const handlers = new Map();             // kind → (desc, job) => Promise, for jobs restored after a restart
const KEY = 'rembrandt:jobs';

export const onJobsChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
const emit = (save = true) => { if (save) persist(); listeners.forEach((f) => f(jobs)); };
export const allJobs = () => jobs;

// ------------------------------------------------------------------ when

export function trackActivity() {
  const mark = (e) => { if (e.type !== 'pointermove' || e.buttons) lastInput = performance.now(); };
  for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) window.addEventListener(t, mark, { capture: true, passive: true });
}
const userAway = () => document.hidden || performance.now() - lastInput > AWAY;
export const userEditing = () => !document.hidden && performance.now() - lastInput < mode().quiet;

function nightWindow() {
  const [a, b] = [prefs.nightFrom ?? 1, prefs.nightTo ?? 6];
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return a < b ? h >= a && h < b : h >= a || h < b;
}
const allowed = (j) => j.when === 'now' || (j.when === 'away' && (userAway() || nightWindow())) || (j.when === 'tonight' && nightWindow());
export const fullSpeed = () => !current || current.when !== 'now' || userAway();

// The next night window start, for "Tonight at 1:00".
export const nightLabel = () => `${prefs.nightFrom ?? 1}:00`;

// ------------------------------------------------------------------ cooperative yielding

const frame = () => new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => setTimeout(r, 0))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Call between chunks of work. Throws AbortError when the job is cancelled.
// For work outside the queue (thumbnails, fingerprints): a frame for the editor, and none while you
// are in the middle of something.
export async function whenQuiet() {
  await frame();
  while (userEditing()) await sleep(150);
}

export async function breathe(job = current) {
  if (job?.cancelled) throw new DOMException('Cancelled', 'AbortError');
  await frame();
  // Your editing comes first; paused jobs wait.
  while (job && (job.paused || (!fullSpeed() && userEditing()))) {
    await sleep(job.paused ? 300 : 120);
    if (job.cancelled) throw new DOMException('Cancelled', 'AbortError');
  }
}

// Time budget for one chunk right now.
export const budget = () => (fullSpeed() && current ? FULL : mode().budget);

// For GPU work split into steps (one network layer at a time): call `step()` after each one. It
// waits for the GPU to finish that step without blocking the page (`gpuDone`), and when the step
// budget is used up, gives the editor its turn (`breathe`).
export function pacer(job, gpuDone) {
  let t = performance.now();
  return async () => {
    await gpuDone();
    if (performance.now() - t >= budget()) { await breathe(job); t = performance.now(); }
  };
}
// WebGL: resolves when the GPU has finished everything issued so far, polling instead of blocking.
export async function glFinished(gl) {
  const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  while (gl.getSyncParameter(s, gl.SYNC_STATUS) !== gl.SIGNALED) await sleep(3);
  gl.deleteSync(s);
}

// Adaptive chunk size: report how long a chunk of `size` took; the next one is sized for the budget.
export function chunker(initial, min, max) {
  let size = initial;
  return {
    get size() { return size; },
    report(ms) {
      const t = budget();
      if (ms > t * 1.3) size = Math.max(min, Math.floor(size * Math.max(0.5, Math.sqrt(t / ms))));
      else if (ms < t * 0.6) size = Math.min(max, Math.ceil(size * 1.25));
    },
  };
}

// ------------------------------------------------------------------ the queue

// { title, kind, when: 'now' | 'away' | 'tonight', run(job) → Promise, desc? (to restore later) }
export function addJob(spec) {
  const job = { id: uid(), when: spec.when || prefs.aiWhen || 'now', progress: 0, state: 'queued', added: Date.now(), ...spec };
  job.setProgress = (f, note) => { job.progress = Math.max(0, Math.min(1, f)); if (note !== undefined) job.note = note; emit(false); };
  jobs.push(job);
  emit();
  pump();
  return job;
}
// Runs every job allowed now, one at a time.
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const j = jobs.find((x) => x.state === 'queued' && allowed(x));
      if (!j) break;
      current = j; j.state = 'running'; emit();
      const lock = j.when !== 'now' && prefs.keepAwake !== false ? await wakeLock() : null;
      try {
        j.result = await j.run(j);
        j.state = 'done'; j.progress = 1;
      } catch (err) {
        j.state = err?.name === 'AbortError' ? 'cancelled' : 'failed';
        j.error = err?.message || String(err);
        if (j.state === 'failed') console.error(err);
      } finally {
        lock?.release?.().catch(() => {});
        current = null;
        j.finished = Date.now();
        j.onDone?.(j);
        emit();
      }
    }
  } finally { pumping = false; }
}
setInterval(pump, 15e3);
document.addEventListener('visibilitychange', () => pump());

async function wakeLock() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

export function cancelJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.cancelled = true;
  if (j.state === 'queued') { j.state = 'cancelled'; emit(); }
}
export function pauseJob(id, paused) { const j = jobs.find((x) => x.id === id); if (j) { j.paused = paused; emit(); } }
export function runNow(id) { const j = jobs.find((x) => x.id === id); if (j && j.state === 'queued') { j.when = 'now'; emit(); pump(); } }
export function reschedule(id, when) { const j = jobs.find((x) => x.id === id); if (j && j.state === 'queued') { j.when = when; emit(); pump(); } }
export function clearFinished() { for (let i = jobs.length - 1; i >= 0; i--) if (['done', 'failed', 'cancelled'].includes(jobs[i].state)) jobs.splice(i, 1); emit(); }
export function setPerf(v) { prefs.perf = v; savePrefs(); }

// ------------------------------------------------------------------ remembered across restarts

export function registerKind(kind, run) { handlers.set(kind, run); }

let restored = false;
function persist() {
  if (!restored) return;
  const keep = jobs.filter((j) => j.state === 'queued' && j.desc && handlers.has(j.kind)).map(({ kind, title, when, desc }) => ({ kind, title, when, desc }));
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* ignore */ }
}
// After the library is loaded: queued jobs from last time come back.
export function restoreJobs() {
  if (restored) return;
  restored = true;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { /* ignore */ }
  for (const j of list) {
    const run = handlers.get(j.kind);
    if (run) addJob({ ...j, run: (job) => run(j.desc, job) });
  }
}
