// Plans and prices in one place (USD). The server enforces what each plan allows.
// Cloud sync is one plan in five storage sizes; every size includes sync on every device, your
// originals kept online, the hosted web editor and share links. Yearly is ten months' price.
// keys: Paddle price keys in CONFIG.prices (website checkout). store: App Store / Google Play
// subscription product ids (phone apps; mapped to plans in rembrandt-cloud's _shared/plans.js).
const tier = (id, gb, month, size) => ({
  id, size: gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`,
  name: `Cloud sync ${gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`}`,
  month, year: month * 10, storage: gb * 1e9,
  keys: { month: `${id}_monthly`, year: `${id}_yearly` },
  store: { month: `rembrandt.cloud.${size}.monthly`, year: `rembrandt.cloud.${size}.yearly` },
});
export const TIERS = [
  tier('cloud_128', 128, 7, '128gb'),
  tier('cloud_192', 192, 9, '192gb'),
  tier('cloud_256', 256, 11, '256gb'),
  tier('cloud_512', 512, 13, '512gb'),
  tier('cloud_1tb', 1000, 15, '1tb'),
];
export const PLANS = { free: { id: 'free', name: 'Free', month: 0, year: 0, storage: 0 }, ...Object.fromEntries(TIERS.map((t) => [t.id, t])) };
// Desktop and self-hosted web: free and open source. Phone apps: a free download with a one-time
// unlock bought in the app (see src/unlock.js); Cloud sync is separate and optional.
export const MOBILE = { price: 30, freeSaves: 3 };
export const planName = (id) => (PLANS[id] || PLANS.free).name;
export const isPaid = (id) => TIERS.some((t) => t.id === id);
export const hasCloudStorage = isPaid;
