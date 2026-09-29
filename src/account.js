// Local profile and preferences (stored on this device).
const KEY = 'lumen:prefs';
export const prefs = (() => {
  const d = { name: '', rawQuality: 3, previewLong: 2560 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return d; }
})();
export function savePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

const initials = (n) => (n || '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
export function paintAvatar(node, name = prefs.name) {
  node.textContent = initials(name) || '';
  node.classList.toggle('noname', !name);
}
