// The editor on the Rembrandt website (app.<domain>) comes with Cloud sync: without a plan it shows
// this screen instead of the editor. Only the official site turns it on (CONFIG.hosted); the desktop
// app, rembrandt-server and any other copy of the web app are free and never show it.
import { el } from './util.js';
import { button } from './ui.js';
import { CONFIG, backendConfigured } from './config.js';
import { markSvg } from './brand.js';
import { TIERS, isPaid } from './pricing.js';
import { signInForm } from './account-online.js';
import * as sb from './backend/supabase.js';

export const gated = () => CONFIG.hosted === true && !window.__TAURI_INTERNALS__ && CONFIG.serverUrl === undefined;

let root = null;
// state: the cloud state ({ signedIn, plan, me }); refresh(): re-reads the account after sign-in or
// a purchase made in another tab.
export function updateGate(app, state, refresh) {
  if (!gated() || isPaid(state.plan)) { root?.remove(); root = null; document.body.classList.remove('gated'); return; }
  const site = (CONFIG.siteUrl || '').replace(/\/$/, '');
  const repo = `https://github.com/${CONFIG.repo}`;
  const card = el('div', { class: 'gate-card' });
  const links = el('p', { class: 'gate-links' },
    el('a', { href: `${site}/download.html` }, 'Get the free desktop app'), ' · ',
    el('a', { href: `${repo}#self-host-it`, target: '_blank', rel: 'noopener' }, 'Self-host it free'), ' · ',
    el('a', { href: `${site}/` }, 'About Rembrandt'));
  card.append(el('div', { class: 'gate-mark', html: markSvg() }));
  if (!backendConfigured()) {
    // Before Cloud sync opens, the site's editor has nothing to sign in to.
    card.append(
      el('h1', {}, 'Rembrandt in your browser'),
      el('p', { class: 'lead' }, 'The web editor comes with Cloud sync, which is coming soon. Until then, Rembrandt is free on your computer.'),
      el('div', { class: 'row-btns center' }, el('a', { class: 'btn primary', href: `${site}/download.html` }, 'Get the desktop app')));
  } else if (!state.signedIn) {
    card.append(
      el('h1', {}, 'Rembrandt in your browser'),
      el('p', { class: 'lead' }, `The web editor comes with Cloud sync, from $${TIERS[0].month} a month. Sign in to open your library, or create an account.`),
      signInForm(app, refresh),
      el('p', { class: 'hint' }, el('a', { href: `${site}/pricing.html` }, 'See plans')));
  } else {
    const u = sb.currentUser();
    const choose = `${site}/pricing.html?${new URLSearchParams({ email: u?.email || '', uid: u?.id || '' })}`;
    card.append(
      el('h1', {}, 'One more step'),
      el('p', { class: 'lead' }, `You're signed in as ${state.me?.email || u?.email || ''}. Choose a Cloud sync plan to edit here; your library then opens on every device.`),
      el('div', { class: 'row-btns center' },
        el('a', { class: 'btn primary', href: choose, target: '_blank', rel: 'noopener' }, 'Choose a plan'),
        button('Use another account', async () => { await sb.signOut(); await refresh(); }, 'ghost')),
      el('p', { class: 'hint' }, 'Already subscribed? This page opens the editor as soon as the plan is active.'));
    // Coming back from checkout in another tab.
    window.addEventListener('focus', () => refresh(), { once: true });
  }
  card.append(links);
  const next = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in to Rembrandt' }, el('div', { class: 'gate-bg' }), card);
  if (root) root.replaceWith(next); else document.body.append(next);
  root = next;
  document.body.classList.add('gated');
}
