// Configuration. Everything works without any of these; each key only switches on an optional
// service. Self-hosters and packagers can override them without rebuilding by defining
// `window.LUMEN_CONFIG` in a script loaded before the app (the server writes one for you).
const DEFAULTS = {
  repo: 'thesnarkitecht/rembrandt',   // GitHub repository: releases, update check, issues
  supportUrl: '',                     // "Support Rembrandt" link (GitHub Sponsors, Open Collective, …)
  siteUrl: '',                        // public address, if you host it (used for OAuth redirects)
  serverUrl: undefined,               // set by rembrandt-server ('' = same origin): its photos folder
  // Import from and export to cloud services. Each needs your own (free) developer app key; see
  // docs/cloud-services.md. A service without keys is shown as unavailable.
  googleClientId: '',       // Google Cloud OAuth client (Web): Google Photos, and with the two below Google Drive
  googleApiKey: '',         // browser API key restricted to the Picker API
  googleAppId: '',          // Google Cloud project number
  dropboxAppKey: '',        // Dropbox app key (Chooser); add your domain under "Chooser / Saver domains"
  onedriveClientId: '',     // Microsoft Entra app (SPA) client id
  adobeClientId: '',        // Adobe Developer Console: OAuth Single-Page App credential with the Lightroom API
};

export const CONFIG = { ...DEFAULTS, ...(globalThis.LUMEN_CONFIG || {}) };
export const supportUrl = () => CONFIG.supportUrl || `https://github.com/${CONFIG.repo}#support-rembrandt`;
