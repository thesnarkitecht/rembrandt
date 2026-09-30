// Sign-in for Cloud sync (emailed one-time code, or Apple/Google/Microsoft). It is shown only when
// someone turns Cloud sync on in Settings.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { PLANS } from './pricing.js';
import { button } from './ui.js';
import * as sb from './backend/supabase.js';
import { backendConfigured } from './config.js';

// Sign-in buttons follow each provider's brand guidance (logo + "Continue with …").
const LOGOS = {
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.2 1-4 2.5-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-4zM14 5.4c.7-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3z"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.3-4.8 3.3-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 9.9l3.7-2.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z"/></svg>',
  microsoft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>',
};
const NAMES = { apple: 'Apple', google: 'Google', microsoft: 'Microsoft' };

// Sign in and sign up are the same two steps: an email (or Apple/Google/Microsoft), then the
// six-digit code we email. New addresses get an account automatically.
export function signInForm(app, changed) {
  const box = el('div', { class: 'online signin' });
  const live = backendConfigured();
  const err = el('div', { class: 'warn-text', role: 'alert' });
  const input = (attrs) => { const i = el('input', { class: 'text-input', ...attrs }); i.addEventListener('keydown', (e) => e.stopPropagation()); return i; };
  let address = '';

  const providers = () => el('div', { class: 'oauth' }, ['apple', 'google', 'microsoft'].map((p) => {
    const b = el('button', { class: 'oauth-btn', type: 'button', disabled: !live }, el('span', { class: 'oauth-logo', html: LOGOS[p] }), el('span', {}, `Continue with ${NAMES[p]}`));
    b.addEventListener('click', async () => {
      err.textContent = '';
      try { await sb.signInWithProvider(p, openExternal()); } catch (e) { err.textContent = e.message; }
    });
    return b;
  }));

  function stepEmail() {
    const email = input({ type: 'email', placeholder: 'you@example.com', autocomplete: 'email', id: 'signinEmail', disabled: !live, value: address, 'aria-label': 'Email address' });
    const go = button('Continue', () => submit(), 'primary signin-go');
    go.disabled = !live;
    const form = el('form', { class: 'signin-form', novalidate: true }, email, go);
    async function submit() {
      err.textContent = '';
      const v = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { err.textContent = 'Enter your email address'; email.focus(); return; }
      go.disabled = true;
      try { await sb.sendCode(v); address = v; stepCode(); } catch (e) { err.textContent = e.message; go.disabled = false; }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    box.replaceChildren(
      el('h3', { class: 'signin-title' }, 'Sign in or create an account'),
      el('p', { class: 'hint' }, live ? 'Use your email; new here means a new account, no password needed.' : 'Accounts open at launch. Until then everything stays on this device.'),
      form, err,
      el('div', { class: 'or' }, el('span', {}, 'or')),
      providers());
    if (live) requestAnimationFrame(() => email.focus());
  }

  function stepCode() {
    const code = input({ inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'one-time-code', id: 'signinCode', class: 'text-input signin-code', 'aria-label': '6-digit code', placeholder: '••••••' });
    let busy = false;
    const verify = async () => {
      const v = code.value.replace(/\D/g, '');
      if (v.length !== 6 || busy) return;
      busy = true;
      err.textContent = '';
      code.disabled = true;
      try { await sb.verifyCode(address, v); await changed(); } catch (e) {
        err.textContent = /expired|invalid/i.test(e.message) ? 'That code didn’t work. Check the latest email, or send a new code.' : e.message;
        code.disabled = false; code.value = ''; code.focus();
      } finally { busy = false; }
    };
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) verify(); });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
    let wait = 30;
    const resend = el('button', { class: 'link-btn', type: 'button', disabled: true }, `Send a new code in ${wait}s`);
    const tick = setInterval(() => {
      if (!box.isConnected) { clearInterval(tick); return; }
      wait--;
      if (wait <= 0) { clearInterval(tick); resend.disabled = false; resend.textContent = 'Send a new code'; } else resend.textContent = `Send a new code in ${wait}s`;
    }, 1000);
    resend.addEventListener('click', async () => {
      err.textContent = '';
      try { await sb.sendCode(address); app.toast?.('New code sent'); clearInterval(tick); stepCode(); } catch (e) { err.textContent = e.message; }
    });
    const back = el('button', { class: 'link-btn', type: 'button', onclick: () => { clearInterval(tick); stepEmail(); } }, 'Use a different email');
    box.replaceChildren(
      el('h3', { class: 'signin-title' }, 'Check your email'),
      el('p', { class: 'hint' }, 'Enter the 6-digit code we sent to ', el('b', {}, address), '. It works for 15 minutes.'),
      code, err,
      el('div', { class: 'signin-links' }, resend, back));
    requestAnimationFrame(() => code.focus());
  }

  stepEmail();
  return box;
}

// Desktop: OAuth runs in the system browser (providers block embedded web views).
export function openExternal() {
  const t = window.__TAURI_INTERNALS__;
  if (!t) return null;
  return (url) => t.invoke('plugin:opener|open_url', { url });
}

export function onlineSection(app, cl, changed, openPlan) {
  if (!cl.signedIn) return signInForm(app, changed);
  const planName = PLANS[cl.plan]?.name || 'Free';
  const out = button('Sign out', async () => { await sb.signOut(); await changed(); }, 'sm ghost');
  return el('div', { class: 'online' },
    el('div', { class: 'row between' },
      el('div', {}, el('div', {}, cl.me?.email || ''), el('div', { class: 'hint' }, cl.plan === 'free' ? 'Free plan · edits stay on this device' : `${planName} plan · syncing`)),
      el('span', { class: 'pill' + (cl.plan !== 'free' ? ' good' : '') }, planName)),
    el('div', { class: 'row-btns' }, button('Plan & storage', openPlan, 'sm primary', 'cloud'), out));
}
