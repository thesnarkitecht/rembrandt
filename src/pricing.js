// Plans and prices in one place (USD). The server enforces what each plan allows.
// keys: Paddle price keys (web and desktop). store: App Store / Google Play subscription product ids
// (phone apps; the same ids in both stores, mapped to plans in backend/…/_shared/stores.js).
export const PLANS = {
  free: { id: 'free', name: 'Free', month: 0, year: 0, storage: 0 },
  // Cloud Editing: edits, ratings and albums everywhere; photos stay where they are (your devices,
  // or linked from Google Photos and other services). No Rembrandt storage.
  sync: { id: 'sync', name: 'Cloud Editing', month: 5, year: 50, storage: 0, keys: { month: 'syncMonthly', year: 'syncYearly' }, store: { month: 'rembrandt.cloud.editing.monthly', year: 'rembrandt.cloud.editing.yearly' } },
  // Cloud Storage: Cloud Editing plus your originals kept online.
  cloud: { id: 'cloud', name: 'Cloud Storage', month: 7, year: 70, storage: 128e9, keys: { month: 'cloudMonthly', year: 'cloudYearly' }, store: { month: 'rembrandt.cloud.storage.monthly', year: 'rembrandt.cloud.storage.yearly' } },
  cloud_plus: { id: 'cloud_plus', name: 'Cloud Storage 1 TB', month: 15, year: 150, storage: 1e12, keys: { month: 'cloudPlusMonthly', year: 'cloudPlusYearly' }, store: { month: 'rembrandt.cloud.storage1tb.monthly', year: 'rembrandt.cloud.storage1tb.yearly' } },
};
// Desktop and browser: free and open source (github.com/thesnarkitecht/rembrandt).
// Mobile: a free download with a one-time unlock bought in the app (App Store / Google Play), so
// Kickstarter and gift codes can unlock it too. Cloud sync is separate. See src/unlock.js.
export const MOBILE = { price: 30, freeSaves: 3 };
export const planName = (id) => (PLANS[id] || PLANS.free).name;
export const isPaid = (id) => id === 'cloud' || id === 'cloud_plus' || id === 'sync';
export const hasCloudStorage = (id) => id === 'cloud' || id === 'cloud_plus';
