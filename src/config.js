// Configuration. Everything works without any of these; each key only switches on an optional
// service. Official builds, self-hosters and packagers can override them without rebuilding by
// defining `window.LUMEN_CONFIG` in a script loaded before the app (rembrandt-server writes one).
const DEFAULTS = {
  repo: 'thesnarkitecht/rembrandt',   // GitHub repository: releases, update check, issues
  supportUrl: '',                     // a donation page; the Support button only shows when this is set
  siteUrl: '',                        // the Rembrandt website (pricing page, share links, OAuth redirects); defaults to this page's origin
  serverUrl: undefined,               // set by rembrandt-server ('' = same origin): its photos folder

  // Cloud sync (optional, paid). Accounts live on a Supabase project; the anon key is public by
  // design (row-level security protects the data). Without these, Cloud sync is simply hidden.
  supabaseUrl: '',          // https://<project>.supabase.co
  supabaseAnonKey: '',
  paddleClientToken: '',    // Paddle Billing client-side token (checkout on the website)
  paddleEnvironment: 'sandbox',
  prices: {                 // Paddle price ids
    syncMonthly: '', syncYearly: '',            // Cloud Editing (no storage)
    cloudMonthly: '', cloudYearly: '',          // Cloud · 128 GB
    cloudPlusMonthly: '', cloudPlusYearly: '',  // Cloud · 1 TB
  },

  // Phone apps (used by the rembrandt-mobile build).
  unlockProductId: 'rembrandt.unlock', // one-time unlock: the same product id in App Store Connect and Play Console
  appStoreId: '',           // numeric App Store id (the Update button opens its listing)
  androidPackage: 'work.light.rembrandt', // Play Store listing for the Android Update button

  // Import from and export to cloud services. Each needs your own (free) developer app key; see
  // docs/cloud-services.md. A service without keys is shown as unavailable.
  googleClientId: '',       // Google Cloud OAuth client (Web): Google Photos, and with the two below Google Drive
  googleApiKey: '',         // browser API key restricted to the Picker API
  googleAppId: '',          // Google Cloud project number
  dropboxAppKey: '',        // Dropbox app key (Chooser); add your domain under "Chooser / Saver domains"
  onedriveClientId: '',     // Microsoft Entra app (SPA) client id
  adobeClientId: '',        // Adobe Developer Console: OAuth Single-Page App credential with the Lightroom API
};

export const CONFIG = { ...DEFAULTS, ...(globalThis.LUMEN_CONFIG || {}), prices: { ...DEFAULTS.prices, ...(globalThis.LUMEN_CONFIG?.prices || {}) } };
export const backendConfigured = () => !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
export const supportUrl = () => CONFIG.supportUrl || `https://github.com/${CONFIG.repo}#help-out`;
