// OAuth 2 with PKCE in a pop-up (no client secret), for services the app talks to directly from
// the browser (Dropbox, Microsoft). The provider sends the pop-up to auth-callback.html, which
// hands the code back to this window. Tokens live for the browser session only.
import { CONFIG } from './config.js';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = () => `${(CONFIG.siteUrl || location.origin).replace(/\/$/, '')}/auth-callback.html`;

function cached(key) {
  try { const t = JSON.parse(sessionStorage.getItem(key) || 'null'); return t && t.exp > Date.now() + 60e3 ? t.token : null; } catch { return null; }
}

// Returns an access token for the service, asking the user to sign in if needed.
// svc: { key, authorizeUrl, tokenUrl, clientId, scope?, extra? }
export async function pkceToken(svc) {
  const key = `lumen:oauth:${svc.key}`;
  const have = cached(key);
  if (have) return have;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = `oauth.${svc.key}.${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const url = `${svc.authorizeUrl}?` + new URLSearchParams({
    client_id: svc.clientId, redirect_uri: redirectUri(), response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state,
    ...(svc.scope ? { scope: svc.scope } : {}), ...(svc.extra || {}),
  });
  const win = window.open(url, `oauth-${svc.key}`, 'width=520,height=720');
  if (!win) throw new Error('Allow pop-ups for this site to connect your account');
  const code = await new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.data?.type !== 'oauth' || e.data.state !== state) return;
      cleanup();
      if (e.data.error || !e.data.code) reject(new Error(e.data.error || 'Sign-in was cancelled')); else resolve(e.data.code);
    };
    const watch = setInterval(() => { if (win.closed) { setTimeout(() => { cleanup(); reject(new Error('Sign-in was closed')); }, 800); } }, 500);
    const cleanup = () => { removeEventListener('message', onMsg); clearInterval(watch); };
    addEventListener('message', onMsg);
  });
  const r = await fetch(svc.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: svc.clientId, code_verifier: verifier, redirect_uri: redirectUri(), ...(svc.scope && svc.sendScope ? { scope: svc.scope } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'Sign-in failed');
  try { sessionStorage.setItem(key, JSON.stringify({ token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 })); } catch { /* ignore */ }
  return j.access_token;
}

export const forgetToken = (key) => { try { sessionStorage.removeItem(`lumen:oauth:${key}`); } catch { /* ignore */ } };
