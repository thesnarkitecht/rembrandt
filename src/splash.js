// Opening sequence: the two pieces of the R slide together, a light passes over the gold, and
// REMBRANDT settles in underneath. About two seconds. It plays once per launch (once per browser
// session on the web), any key or click skips it, and it stays off for people who prefer reduced
// motion or turned it off in Preferences.
import { prefs } from './account.js';
import { BRAND, MARK_PATHS } from './brand.js';

const SEEN = 'lumen:splash';
const HOLD = 2300; // ms until it fades out

function shouldPlay() {
  if (prefs.splash === false) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try { if (sessionStorage.getItem(SEEN)) return false; sessionStorage.setItem(SEEN, '1'); } catch { /* play anyway */ }
  return true;
}

const [BOWL, TRIANGLE] = MARK_PATHS;
const markup = () => `
  <svg class="splash-r" viewBox="-4 -4 108 108" aria-hidden="true">
    <defs>
      <linearGradient id="splash-gold" gradientUnits="userSpaceOnUse" x1="100" y1="0" x2="0" y2="100">
        <stop offset="0" stop-color="#F6D799"/><stop offset=".5" stop-color="#C98F4F"/><stop offset="1" stop-color="#7E4F22"/>
      </linearGradient>
      <linearGradient id="splash-shine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff6e4" stop-opacity="0"/><stop offset=".5" stop-color="#fff6e4" stop-opacity=".75"/><stop offset="1" stop-color="#fff6e4" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="splash-clip"><path d="${BOWL}"/><path d="${TRIANGLE}"/></clipPath>
    </defs>
    <path class="splash-bowl" fill="url(#splash-gold)" d="${BOWL}"/>
    <path class="splash-tri" fill="url(#splash-gold)" d="${TRIANGLE}"/>
    <g clip-path="url(#splash-clip)"><rect class="splash-shine" x="-40" y="-60" width="34" height="220" fill="url(#splash-shine)"/></g>
  </svg>
  <div class="splash-name">${BRAND.name.toUpperCase().split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>`;

function play() {
  const root = document.getElementById('splash');
  if (!root || !shouldPlay()) { root?.remove(); return; }
  const stage = root.querySelector('.splash-stage');
  stage.innerHTML = markup();
  stage.setAttribute('aria-label', BRAND.name);
  root.hidden = false;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    root.classList.add('out');
    setTimeout(() => root.remove(), 420);
    removeEventListener('keydown', finish, true);
  };
  root.addEventListener('pointerdown', finish);
  addEventListener('keydown', finish, true);
  // Start once the font is in, so the letters don't swap mid-animation.
  (document.fonts?.ready || Promise.resolve()).then(() => requestAnimationFrame(() => root.classList.add('go')));
  setTimeout(finish, HOLD);
  setTimeout(finish, 5000); // never block the app, whatever happens to fonts
}

play();
