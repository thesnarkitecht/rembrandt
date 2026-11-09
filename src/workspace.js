// Workspace: which tools and panel sections are shown, and whether AI is used at all (Settings →
// Workspace). Hiding a tool or section never changes a photo: its settings stay and still render.
// Turning AI off hides every AI tool and stops every model from loading or running on this device;
// AI adjustments already on a photo are left out of the render (and kept) until AI is turned back on.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { prefs, savePrefs } from './account.js';

// The tools on the panel's tab row (Edit is always there).
export const TOOLS = [
  { id: 'crop', label: 'Crop & rotate', icon: 'crop' },
  { id: 'masks', label: 'Masks', icon: 'mask' },
  { id: 'retouch', label: 'Remove', icon: 'erase' },
  { id: 'warp', label: 'Reshape', icon: 'wand' },
  { id: 'ai', label: 'AI', icon: 'sparkle', ai: true },
  { id: 'presets', label: 'Presets', icon: 'presets' },
];
// Sections of the Edit panel (ids as in panel-edit.js). Light is always there.
export const SECTIONS = [
  { id: 'edit:color', label: 'Color', icon: 'drop' },
  { id: 'edit:look', label: 'Look', icon: 'presets' },
  { id: 'edit:hdr', label: 'HDR', icon: 'sun' },
  { id: 'edit:effects', label: 'Effects', icon: 'fx' },
  { id: 'edit:curve', label: 'Curve', icon: 'curve' },
  { id: 'edit:mixer', label: 'Color Mixer', icon: 'mixer' },
  { id: 'edit:grading', label: 'Color Grading', icon: 'wheel' },
  { id: 'edit:detail', label: 'Detail', icon: 'detail' },
  { id: 'edit:optics', label: 'Lens Corrections', icon: 'aperture' },
];
// Other parts of the window.
export const EXTRAS = [
  { id: 'studio', label: 'Edit with words', icon: 'pencil' },
];

const hidden = () => (prefs.hidden ||= {});
export const aiOn = () => prefs.aiOff !== true;
export const shown = (id) => !hidden()[id] && !(TOOLS.find((t) => t.id === id)?.ai && !aiOn());

const listeners = new Set();
export const onWorkspaceChange = (f) => (listeners.add(f), () => listeners.delete(f));
function changed() { savePrefs(); listeners.forEach((f) => f()); }
export function setShown(id, on) { if (on) delete hidden()[id]; else hidden()[id] = true; changed(); }
export function setAi(on) { prefs.aiOff = !on; changed(); }
export function resetWorkspace() { prefs.hidden = {}; prefs.aiOff = false; changed(); }
export const customised = () => !aiOn() || Object.values(hidden()).some(Boolean);

// Thrown (and shown as a toast) when something asks a model to run while AI is off.
export class AiOffError extends Error {
  constructor() { super('AI is turned off. Turn it on in Settings → Workspace.'); this.name = 'AiOffError'; }
}
export function assertAi() { if (!aiOn()) throw new AiOffError(); }

// Adjustment groups that need a model; while AI is off they render as if switched off.
export const AI_GROUPS = ['refocus', 'lens', 'background', 'enhance', 'relight', 'light', 'sky', 'atmos', 'rays', 'skin', 'motion'];
