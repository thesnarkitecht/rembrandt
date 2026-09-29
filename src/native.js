// Desktop (Tauri) helpers. On the web these fall back to the browser.

// OAuth and links open in the system browser on desktop (providers block embedded web views).
export function openExternal() {
  const t = window.__TAURI_INTERNALS__;
  if (!t) return null;
  return (url) => t.invoke('plugin:opener|open_url', { url });
}
