// Minimal Supabase client (auth with emailed one-time codes, PostgREST, Edge Functions) over fetch,
// so the app keeps zero dependencies.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { CONFIG } from '../config.js';

const KEY = 'lumen:session';
let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { session = null; }
const listeners = new Set();
export const onAuthChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
function save(s) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((f) => f(s));
}
export const currentUser = () => session?.user || null;

async function call(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const h = { apikey: CONFIG.supabaseAnonKey, 'Content-Type': 'application/json', ...headers };
  if (auth) {
    const tok = await accessToken();
    h.Authorization = `Bearer ${tok || CONFIG.supabaseAnonKey}`;
  }
  const r = await fetch(CONFIG.supabaseUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) {
    const err = new Error(data?.error_description || data?.msg || data?.message || data?.error || `Request failed (${r.status})`);
    err.status = r.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

const withExpiry = (d) => ({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, user: d.user });

let refreshing = null;
async function accessToken() {
  if (!session) return null;
  if (Date.now() < session.expires_at - 60000) return session.access_token;
  refreshing ||= call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } })
    .then((d) => { save(withExpiry(d)); return session.access_token; })
    .catch((e) => { if (e.status === 400 || e.status === 401) save(null); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// ------------------------------------------------------------------ Google, Apple, Microsoft (OAuth with PKCE)
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER = 'lumen:pkce';
export const PROVIDERS = { apple: 'apple', google: 'google', microsoft: 'azure' };

// Where the provider sends the browser back to. The desktop app goes through the website, which
// hands the code to the app with a deep link (see auth-callback.html).
export function redirectUrl() {
  if (window.__TAURI_INTERNALS__) return `${(CONFIG.siteUrl || '').replace(/\/$/, '')}/auth-callback.html?to=app`;
  return location.origin + location.pathname;
}

export async function signInWithProvider(name, openUrl) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try { localStorage.setItem(VERIFIER, verifier); } catch { /* ignore */ }
  const q = new URLSearchParams({ provider: PROVIDERS[name] || name, redirect_to: redirectUrl(), code_challenge: challenge, code_challenge_method: 's256' });
  if (name === 'microsoft') q.set('scopes', 'email');
  const url = `${CONFIG.supabaseUrl}/auth/v1/authorize?${q}`;
  if (openUrl) await openUrl(url); else location.assign(url);
}

// Finish an OAuth sign-in: exchange ?code= (web redirect or desktop deep link) for a session.
export async function completeSignIn(code) {
  let verifier = null;
  try { verifier = localStorage.getItem(VERIFIER); localStorage.removeItem(VERIFIER); } catch { /* ignore */ }
  if (!verifier) throw new Error('Sign-in expired. Please try again.');
  const d = await call('/auth/v1/token?grant_type=pkce', { method: 'POST', auth: false, body: { auth_code: code, code_verifier: verifier } });
  save(withExpiry(d));
  return d.user;
}

// Called once at start-up on the web: handles ?code=… or ?error_description=… after a redirect.
export async function handleAuthRedirect() {
  const u = new URL(location.href);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error_description');
  if (!code && !err) return null;
  u.searchParams.delete('code'); u.searchParams.delete('error'); u.searchParams.delete('error_description');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  if (err) throw new Error(err);
  return completeSignIn(code);
}

// Step 1: email a six-digit code (the Supabase email template must include {{ .Token }}).
export const sendCode = (email) => call('/auth/v1/otp', { method: 'POST', auth: false, body: { email, create_user: true } });
// Step 2: exchange it for a session.
export async function verifyCode(email, token) {
  const d = await call('/auth/v1/verify', { method: 'POST', auth: false, body: { type: 'email', email, token } });
  save(withExpiry(d));
  return d.user;
}
export async function signOut() {
  try { await call('/auth/v1/logout', { method: 'POST' }); } catch { /* ignore */ }
  save(null);
}

// Update the signed-in user's auth record (e.g. { email } sends a confirmation to the new address).
export async function updateUser(attrs) {
  const u = await call('/auth/v1/user', { method: 'PUT', body: attrs });
  if (session && u?.id) save({ ...session, user: { ...session.user, ...u } });
  return u;
}

export const rest = (path, opts) => call('/rest/v1/' + path, opts);
export const rpc = (fn, args = {}) => call('/rest/v1/rpc/' + fn, { method: 'POST', body: args });
export const fn = (name, body) => call('/functions/v1/' + name, { method: 'POST', body });
