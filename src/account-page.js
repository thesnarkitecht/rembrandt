// Settings: Cloud sync, Preferences, Storage, Sharing, Data & privacy.
// Everything works without an account. The only sign-in is under Cloud sync: turning it on asks
// you to sign in and pick a plan; turning it off signs out and leaves the library on this device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, saveBlob } from './util.js';
import { segmented, slider, toggle, button } from './ui.js';
import { icon } from './icons.js';
import * as catalog from './catalog.js';
import * as sb from './backend/supabase.js';
import * as api from './backend/account-api.js';
import { checkout, billingConfigured } from './backend/billing.js';
import { backendConfigured, CONFIG } from './config.js';
import { exportDefaults, saveExportDefaults } from './export.js';
import { prefs, savePrefs } from './account.js';
import { getAppearance, setAppearance } from './theme.js';
import { signInForm, openExternal } from './account-online.js';
import { updateRow } from './update-check.js';
import { PLANS, TIERS, planName, isPaid, hasCloudStorage } from './pricing.js';
import { ring, fmtBytes } from './ring.js';
import { BRAND } from './brand.js';
import { isMobileApp, isTauri, isIOS } from './platform.js';
import { unlockPanel, isUnlocked, freeSavesLeft, unlockPrice, onUnlockChange } from './unlock.js';
import { buySubscription, syncStoreSubscriptions, manageStoreSubscription, loadStorePrices, storePrice, storeName, storePlatform, sellerName } from './subscriptions.js';

const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const SECTIONS = [
  ...(isMobileApp ? [['unlock', 'Unlock', 'sparkle']] : []),
  ['cloud', 'Cloud sync', 'cloud'],
  ['prefs', 'Preferences', 'gear'],
  ['storage', 'Storage', 'laptop'],
  ['sharing', 'Sharing', 'link'],
  ['data', 'Data & privacy', 'shield'],
];
// Older links into the page (sign-in, plan, devices) all land on Cloud sync.
const ALIAS = { profile: 'cloud', plan: 'cloud', devices: 'cloud' };

export function buildAccountPage(app, hooks) {
  const root = el('section', { class: 'acct-page', id: 'accountPage' });
  const nav = el('nav', { class: 'acct-nav', 'aria-label': 'Account' });
  const body = el('div', { class: 'acct-main' });
  root.append(nav, body);
  let current = isMobileApp && !isUnlocked() ? 'unlock' : 'cloud';
  let period = 'year';
  let pick = null;      // the Cloud sync size shown in the plan picker
  let turningOn = false;   // the user switched Cloud sync on and is signing in
  let pricesLoaded = false; // phone: store prices asked for once
  const cl = () => app.cloudState();
  const online = () => backendConfigured() && cl().signedIn;
  const toast = (m) => app.toast(m);

  const card = (title, ...kids) => el('section', { class: 'acct-card' }, title ? el('h2', {}, title) : null, ...kids);
  const rowKV = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('span', {}, v));
  const loading = () => el('p', { class: 'hint' }, 'Loading…');
  const needCloud = (what) => card(null, el('p', { class: 'hint' }, `Turn on Cloud sync to ${what}.`),
    el('div', { class: 'row-btns' }, button('Cloud sync', () => { current = 'cloud'; render(); }, 'sm', 'cloud')));
  const busy = async (btn, f) => { btn.disabled = true; try { await f(); } catch (e) { toast(e.message); } finally { btn.disabled = false; } };

  // Waits for a purchase made elsewhere (the browser, the store) to reach the account.
  async function waitForPlan(tries = 8) {
    for (let i = 0; i < tries; i++) { await new Promise((r) => setTimeout(r, 1500)); await hooks.accountChanged(); if (isPaid(cl().plan)) break; }
    render();
  }

  async function buy(key, btn) {
    if (!online()) { current = 'cloud'; turningOn = true; render(); return; }
    // Desktop app, or any copy without Paddle's checkout (self-hosted, packaged): checkout runs on
    // the Rembrandt website, so it opens there in the browser, already tied to this account. The plan
    // appears here when the user comes back.
    if ((isTauri && !isMobileApp) || !billingConfigured()) {
      const site = (CONFIG.siteUrl || '').replace(/\/$/, '');
      if (!site) { toast('Purchases open at launch'); return; }
      const u = sb.currentUser();
      const url = `${site}/pricing.html?${new URLSearchParams({ buy: key, email: u?.email || '', uid: u?.id || '' })}`;
      const ext = openExternal();
      if (ext) await ext(url); else window.open(url, '_blank', 'noopener');
      toast('Finish checkout in your browser. Your plan appears here when you come back.');
      window.addEventListener('focus', () => waitForPlan(20), { once: true });
      return;
    }
    await busy(btn, async () => {
      if (await checkout(key, sb.currentUser())) {
        toast('Thank you! Activating…');
        await waitForPlan();
      }
    });
  }
  const openPortal = (btn) => busy(btn, async () => {
    const { url } = await api.billingPortal();
    const ext = openExternal();
    if (ext) await ext(url); else window.open(url, '_blank', 'noopener');
  });

  // ---------------------------------------------------------------- sections

  // The one place with an account: a yes/no question, then sign-in, then a plan.
  function cloudSync() {
    const c = cl();
    const out = [];
    const on = online();
    const sw = el('button', { type: 'button', class: 'cloud-switch' + (on || turningOn ? ' on' : ''), role: 'switch', 'aria-checked': String(on || turningOn), 'aria-label': 'Cloud sync', disabled: !backendConfigured() });
    sw.addEventListener('click', () => {
      if (on) { turnOff(sw); return; }
      turningOn = !turningOn; render();
    });
    const status = !backendConfigured() ? 'Cloud sync is coming soon. Everything stays on this device.'
      : on ? (isPaid(c.plan) ? (c.status === 'error' ? `Paused, retrying · ${c.me?.email}` : `On · ${c.me?.email}`) : `Signed in as ${c.me?.email} · choose a plan to start syncing`)
      : turningOn ? 'Sign in to turn it on. New here? The same step creates your account.'
      : 'Off. Your library stays on this device, and you don’t need an account.';
    out.push(el('section', { class: 'acct-card cloud-ask' },
      el('div', { class: 'cloud-ask-row' },
        el('div', {}, el('h2', {}, on ? (isPaid(c.plan) ? 'Cloud sync is on' : 'One more step: choose a plan') : 'Turn on Cloud sync?'), el('p', { class: 'hint' }, status)),
        sw),
      !on && !turningOn ? el('ul', { class: 'cloud-perks' }, [
        'Your photos, edits and albums on every device: computer, phone and browser',
        'Edit in any browser at the Rembrandt website, nothing to install',
        'Share links to your photos',
      ].map((t) => el('li', {}, icon('check'), t))) : null,
      !on && !turningOn && backendConfigured() ? el('p', { class: 'hint' }, isMobileApp ? 'Editing, AI and export never need it.' : `From $${TIERS[0].month} a month. Editing, AI and export never need it.`) : null));

    if (!on) {
      if (turningOn && backendConfigured()) {
        out.push(card(null, signInForm(app, async () => {
          await hooks.accountChanged();
          // Phone: a Cloud subscription this store account already has joins the account.
          if (isMobileApp && await syncStoreSubscriptions()) await hooks.accountChanged();
          turningOn = false; render();
        }),
          el('div', { class: 'row-btns' }, button('Not now', () => { turningOn = false; render(); }, 'sm ghost'))));
      }
      return out;
    }

    // Signed in: account, plan and billing.
    const nameIn = el('input', { class: 'text-input', id: 'acctName', value: c.me?.name || prefs.name || '', placeholder: 'Your name', autocomplete: 'name' });
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    const saveName = button('Save', () => busy(saveName, async () => {
      prefs.name = nameIn.value.trim(); savePrefs();
      await api.setDisplayName(prefs.name); await hooks.accountChanged();
      hooks.profileChanged(); toast('Name saved'); render();
    }), 'sm');
    const emailIn = el('input', { class: 'text-input', id: 'acctEmail', type: 'email', value: c.me?.email || '', autocomplete: 'email' });
    emailIn.addEventListener('keydown', (e) => e.stopPropagation());
    const change = button('Change', () => busy(change, async () => {
      if (emailIn.value.trim() === c.me?.email) return;
      await api.changeEmail(emailIn.value.trim());
      toast('Check both inboxes to confirm the new address');
    }), 'sm ghost');
    out.push(card('Account',
      el('label', { class: 'field' }, el('span', {}, 'Name'), el('div', { class: 'row' }, nameIn, saveName)),
      el('label', { class: 'field' }, el('span', {}, 'Email'), el('div', { class: 'row' }, emailIn, change))));

    const cur = c.plan || 'free';
    const info = c.info || {};
    // Who bills the active plan (Paddle for the web and desktop, or a phone store), and who sells in
    // this app. A plan is changed or cancelled where it was bought.
    const source = isPaid(cur) ? (info.source || 'paddle') : null;
    const here = isMobileApp ? storePlatform : 'paddle';
    const ours = !source || source === here;
    if (isMobileApp && !pricesLoaded) { pricesLoaded = true; loadStorePrices().then(() => { if (current === 'cloud') render(); }); }

    if (isPaid(cur)) {
      const manage = !ours ? null
        : isMobileApp ? (() => { const b = button('Manage subscription', () => busy(b, () => manageStoreSubscription(info.store_product || '')), 'sm ghost', 'card'); return b; })()
        : (() => { const b = button('Manage billing', () => openPortal(b), 'sm ghost', 'card'); return b; })();
      const note = !ours ? `Billed through ${sellerName(source)}${isMobileApp ? '.' : '. Change or cancel it there.'}`
        : isMobileApp ? `Change plan or cancel in your ${storeName} subscriptions. If you cancel, your photos and edits stay available to download.`
        : 'Change plan, update your card, download invoices or cancel in the billing portal. If you cancel, your photos and edits stay available to download.';
      out.push(card('Plan',
        el('div', { class: 'plan-now' },
          el('div', {}, el('div', { class: 'plan-now-name' }, planName(cur)),
            el('div', { class: 'hint' }, `${PLANS[cur].size} for your photos · sync and the web editor${info.period_end ? ` · renews ${fmtDate(info.period_end)}` : ''}`)),
          manage),
        el('p', { class: 'hint' }, note)));
    }

    // Plans: bought here unless the current plan is billed somewhere else.
    if (ours) {
      const per = segmented([{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly · 2 months free' }], period, (v) => { period = v; render(); }, 'period');
      const choose = (p, b) => {
        if (!isMobileApp) return isPaid(cur) ? openPortal(b) : buy(p.keys[period], b);
        // Phone: App Store upgrades and downgrades within the subscription group; Google Play
        // switches plans in its own subscription settings.
        if (isPaid(cur) && !isIOS) return busy(b, () => manageStoreSubscription(info.store_product || ''));
        return busy(b, async () => {
          const r = await buySubscription(p.id, period);
          if (r === 'owned') { toast('Thank you! Cloud sync is on.'); await waitForPlan(); }
          else if (r === 'pending') toast('Waiting for approval. Cloud sync turns on when the purchase goes through.');
        });
      };
      // One plan in five sizes: pick the storage, see the price.
      if (!pick || !PLANS[pick]) pick = isPaid(cur) ? cur : 'cloud_256';
      const p = PLANS[pick];
      const isCur = cur === p.id;
      const local = isMobileApp && storePrice(p.store[period]);  // the store's price, in the local currency
      const price = local || `$${p[period]}`;
      const b = button(isCur ? 'Current plan' : isPaid(cur) ? `Switch to ${p.size}` : `Get Cloud sync · ${p.size}`, () => choose(p, b), isCur ? 'ghost' : 'primary');
      if (isCur) b.disabled = true;
      const sizes = segmented(TIERS.map((t) => ({ value: t.id, label: t.size })), pick, (v) => { pick = v; render(); }, 'sizes');
      out.push(el('div', { class: 'tiers-head' }, el('h2', {}, isPaid(cur) ? 'Change plan' : 'Choose your storage'), per.el));
      out.push(el('div', { class: 'tier plan-one' + (isCur ? ' current' : '') },
        el('div', { class: 'field' }, el('span', {}, 'Storage for your original photos'), sizes.el),
        el('div', { class: 'tier-price' }, el('b', {}, price), el('span', {}, period === 'month' ? 'per month' : local ? 'per year' : `per year · $${(p.year / 12).toFixed(2)}/mo`)),
        el('ul', {}, ['Your photos, edits, ratings and albums on every device', 'The web editor at the Rembrandt website, in any browser',
          'Link Google Photos, Drive, Dropbox and OneDrive without using storage', 'Share links to your photos'].map((f) => el('li', {}, icon('check'), f))),
        b));
    }

    if (isMobileApp) {
      // Store rules: restore, and the subscription terms next to the purchase.
      const restore = button('Restore purchases', () => busy(restore, async () => {
        const n = await syncStoreSubscriptions({ restore: true });
        await hooks.accountChanged(); render();
        toast(n ? 'Subscription restored' : `No Cloud subscription found for this ${storeName} account`);
      }), 'sm ghost');
      const off = button('Turn off Cloud sync', () => turnOff(off), 'sm ghost');
      const site = (CONFIG.siteUrl || '').replace(/\/$/, '');
      const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', onclick: (e) => { const ext = openExternal(); if (ext) { e.preventDefault(); ext(href); } } }, text);
      out.push(card(null, el('div', { class: 'row-btns' }, restore, off)));
      out.push(el('p', { class: 'hint center' },
        `Subscriptions renew automatically until cancelled, and are charged to your ${storeName} account. Cancel any time, at least 24 hours before renewal, in your ${storeName} subscriptions. `,
        site ? link(`${site}/terms.html`, 'Terms') : null, site ? ' · ' : null, site ? link(`${site}/privacy.html`, 'Privacy') : null));
      return out;
    }

    const code = el('input', { class: 'text-input mono', id: 'redeemCode', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'aria-label': 'Redeem code' });
    code.addEventListener('keydown', (e) => e.stopPropagation());
    const redeem = button('Redeem', () => busy(redeem, async () => {
      const r = await api.redeemCode(code.value);
      toast(r?.already ? 'You already redeemed that code' : `${planName(r?.plan)} added to your account`);
      await hooks.accountChanged(); render();
    }), 'sm ghost');
    const off = button('Turn off Cloud sync', () => turnOff(off), 'sm ghost');
    out.push(card(null,
      el('div', { class: 'subhead' }, 'Redeem a code (Kickstarter or gift)'), el('div', { class: 'row' }, code, redeem),
      el('div', { class: 'subhead' }, 'Turn off'),
      el('p', { class: 'hint' }, 'Signs this device out. Your library and edits stay here; what’s already online stays in your account.'),
      el('div', { class: 'row-btns' }, off)));
    out.push(el('p', { class: 'hint center' }, 'Prices in USD; tax may apply. Payments are processed by Paddle.'));
    return out;
  }
  const turnOff = (btn) => busy(btn, async () => { await sb.signOut(); turningOn = false; await hooks.accountChanged(); toast('Cloud sync is off. Your library stays on this device.'); render(); });

  function storage() {
    const c = cl();
    const info = c.info || {};
    const out = [];
    const rings = el('div', { class: 'rings' });
    if (online() && hasCloudStorage(c.plan) && info.quota_bytes) {
      const used = info.storage_bytes || 0;
      rings.append(el('div', { class: 'ring-card' },
        ring([{ value: used, color: 'var(--accent)' }], info.quota_bytes, { size: 168, stroke: 16, top: fmtBytes(used), bottom: `of ${fmtBytes(info.quota_bytes)}` }),
        el('div', {}, el('div', { class: 'ring-label' }, icon('cloud'), 'Online'),
          el('div', { class: 'legend' },
            el('span', {}, el('i', { style: { background: 'var(--accent)' } }), `Original photos · ${fmtBytes(used)}`),
            el('span', {}, el('i', { style: { background: 'var(--track)' } }), `Free · ${fmtBytes(Math.max(0, info.quota_bytes - used))}`)))));
    }
    const dev = el('div', { class: 'ring-card' }, loading());
    rings.append(dev);
    out.push(rings);
    catalog.storageEstimate().then((est) => {
      dev.textContent = '';
      if (!est?.quota) { dev.append(el('p', { class: 'hint' }, 'Storage details are not available in this browser.')); return; }
      const lib = est.details?.indexedDB ?? est.used;
      dev.append(
        ring([{ value: lib, color: 'var(--good)' }], est.quota, { size: 168, stroke: 16, top: fmtBytes(est.used), bottom: `of ${fmtBytes(est.quota)}` }),
        el('div', {}, el('div', { class: 'ring-label' }, icon('laptop'), 'This device'),
          el('div', { class: 'legend' },
            el('span', {}, el('i', { style: { background: 'var(--good)' } }), `Library · ${fmtBytes(lib)} (${app.images.length} photo${app.images.length === 1 ? '' : 's'})`),
            el('span', {}, el('i', { style: { background: 'var(--track)' } }), `Free · ${fmtBytes(Math.max(0, est.quota - est.used))}`))));
    });

    // management
    const manage = card('Manage');
    const protect = button('Keep library if space runs low', () => busy(protect, async () => {
      toast((await catalog.requestPersistence()) ? 'The browser will keep your library' : 'The browser declined; export a backup to be safe');
    }), 'sm ghost', 'shield');
    manage.append(el('div', { class: 'row-btns' }, protect));
    if (!(online() && hasCloudStorage(c.plan))) {
      const free = button('Remove local copies of linked photos', () => busy(free, async () => { const n = await hooks.freeDeviceSpace(); toast(n ? `Freed ${n} photo${n === 1 ? '' : 's'}; they stay in Google Photos or wherever they're linked from` : 'No linked photos are stored on this device'); render(); }), 'sm ghost', 'download');
      manage.append(el('p', { class: 'hint' }, 'Photos linked from Google Photos, Drive, Dropbox or OneDrive can be removed from this device; your edits and previews stay.'), el('div', { class: 'row-btns' }, free));
    }
    if (online() && hasCloudStorage(c.plan)) {
      const up = button('Back up originals now', () => busy(up, async () => { const n = await hooks.uploadMissingOriginals(); toast(n ? `Uploading ${n} original${n === 1 ? '' : 's'}` : 'Every original on this device is already backed up'); }), 'sm ghost', 'cloud');
      const free = button('Free up space on this device', () => busy(free, async () => { const n = await hooks.freeDeviceSpace(); toast(n ? `Removed ${n} local cop${n === 1 ? 'y' : 'ies'}; originals stay online` : 'Nothing to remove yet'); render(); }), 'sm ghost', 'download');
      manage.append(el('p', { class: 'hint' }, 'Originals that are backed up online can be removed from this device and downloaded again when you open them.'), el('div', { class: 'row-btns' }, up, free));
      const list = el('div', { class: 'file-list' }, loading());
      manage.append(el('div', { class: 'subhead' }, 'Largest originals online'), list);
      api.listOnlineOriginals().then((rows) => {
        list.textContent = '';
        if (!rows.length) { list.append(el('p', { class: 'hint' }, 'No originals stored online yet.')); return; }
        for (const r of rows.slice(0, 25)) {
          const rm = button('Remove from cloud', () => busy(rm, async () => { await api.removeOnlineOriginal(r.id); toast(`${r.name} removed from online storage`); await hooks.accountChanged(); render(); }), 'sm ghost');
          list.append(el('div', { class: 'file-row' }, el('span', { class: 'file-name' }, r.name), el('span', { class: 'file-size' }, fmtBytes(r.original_size || 0)), rm));
        }
      }).catch((e) => { list.textContent = e.message; });
    } else if (online()) {
      manage.append(el('p', { class: 'hint' }, 'Back up your original photos and edit them anywhere with Cloud.'), el('div', { class: 'row-btns' }, button('See plans', () => { current = 'cloud'; render(); }, 'sm primary')));
    }
    let confirmClear = false;
    const clearRow = el('div', { class: 'row-btns' });
    const renderClear = () => {
      clearRow.textContent = '';
      if (!confirmClear) clearRow.append(button('Remove all photos from this device…', () => { confirmClear = true; renderClear(); }, 'sm ghost danger-text', 'trash'));
      else clearRow.append(el('span', { class: 'warn-text' }, 'Delete every photo, album and edit stored on this device?'),
        button('Cancel', () => { confirmClear = false; renderClear(); }, 'sm ghost'),
        button('Delete everything', async () => { await hooks.clearLibrary(); render(); }, 'sm danger'));
    };
    renderClear();
    manage.append(clearRow);
    out.push(manage);
    return out;
  }

  function sharing() {
    if (!online()) return [needCloud('create and manage share links')];
    const list = el('div', { class: 'file-list' }, loading());
    api.listShares().then((rows) => {
      list.textContent = '';
      if (!rows.length) { list.append(el('p', { class: 'hint' }, 'You haven’t shared any links. Select photos in the library and choose Share.')); return; }
      for (const s of rows) {
        const url = `${(CONFIG.siteUrl || location.origin).replace(/\/$/, '')}/share.html#${s.token}`;
        const copy = button('Copy link', async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); } }, 'sm ghost', 'copy');
        const stop = button('Stop sharing', () => busy(stop, async () => { await api.revokeShare(s.token); toast('Link turned off'); render(); }), 'sm ghost');
        const expired = s.expires_at && new Date(s.expires_at) < new Date();
        list.append(el('div', { class: 'file-row share' },
          el('span', { class: 'file-name' }, el('b', {}, s.title || 'Shared photos'), el('span', { class: 'hint' }, `${s.item_count} photo${s.item_count === 1 ? '' : 's'} · ${s.view_count || 0} view${s.view_count === 1 ? '' : 's'} · ${expired ? 'expired' : s.expires_at ? `until ${fmtDate(s.expires_at)}` : 'no expiry'}`)),
          copy, stop));
      }
    }).catch((e) => { list.textContent = e.message; });
    return [card('Shared links', list)];
  }

  function preferences() {
    const look = segmented([{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], getAppearance(), (v) => setAppearance(v));
    const rawQ = segmented([{ value: 0, label: 'Fast' }, { value: 3, label: 'Standard' }, { value: 4, label: 'Detailed' }], prefs.rawQuality, (v) => { prefs.rawQuality = v; savePrefs(); });
    const keys = segmented([{ value: 'rembrandt', label: 'Rembrandt' }, { value: 'lightroom', label: 'Lightroom' }], prefs.shortcuts || 'rembrandt', (v) => { prefs.shortcuts = v; savePrefs(); });
    const prevQ = segmented([{ value: 1920, label: 'Fast' }, { value: 2560, label: 'Balanced' }, { value: 4096, label: 'Sharp' }], prefs.previewLong, (v) => { prefs.previewLong = v; savePrefs(); hooks.previewChanged(v); });
    const fmt = segmented([{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }], exportDefaults.format, (v) => { exportDefaults.format = v; saveExportDefaults(); });
    const q = slider({ label: 'Export quality', min: 40, max: 100, def: 92, get: () => exportDefaults.quality, set: (v) => { exportDefaults.quality = v; }, commit: saveExportDefaults });
    const field = (label, ctl, hint) => el('div', { class: 'field' }, el('span', {}, label), ctl, hint ? el('span', { class: 'hint' }, hint) : null);
    const ver = window.LUMEN_BUILD?.version;
    // Since you switched: what the Adobe plan would have cost since Rembrandt's first launch.
    const PLANS_ADOBE = [{ value: 'none', label: 'None', price: 0 }, { value: 'lr', label: 'Lightroom', price: 11.99 }, { value: 'ph20', label: 'Photography 20 GB', price: 14.99 }, { value: 'ph1tb', label: 'Photography 1 TB', price: 19.99 }];
    const savedText = el('div', { class: 'savings' });
    const paintSaved = () => {
      const plan = PLANS_ADOBE.find((x) => x.value === (prefs.adobePlan || 'ph20'));
      const since = prefs.since || Date.now();
      const months = Math.max(0, (Date.now() - since) / (30.44 * 864e5));
      savedText.textContent = '';
      if (!plan.price) { savedText.append(el('span', { class: 'hint' }, 'Pick the plan you had to see what you’ve kept.')); return; }
      const saved = Math.max(plan.price, Math.ceil(months) * plan.price);
      savedText.append(el('b', {}, `$${saved.toFixed(2)}`), el('span', { class: 'hint' }, `kept since ${new Date(since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} · ${plan.label} at $${plan.price}/month (US price)`));
    };
    const planSeg = segmented(PLANS_ADOBE.map(({ value, label }) => ({ value, label })), prefs.adobePlan || 'ph20', (v) => { prefs.adobePlan = v; savePrefs(); paintSaved(); });
    paintSaved();
    return [
      card('Updates', el('p', { class: 'lead' }, `You're using ${BRAND.name}${ver ? ` ${ver}` : ''}.`), updateRow()),
      card('Since you switched', savedText, field('Adobe plan you had', planSeg.el)),
      card('Appearance', field('Theme', look.el), toggle('Opening animation', () => prefs.splash !== false, (v) => { prefs.splash = v; savePrefs(); }).el),
      card('Editing', field('RAW development', rawQ.el, 'Detailed is slower but resolves fine texture better.'), field('Preview resolution', prevQ.el, 'Sharp uses more graphics memory.'),
        field('Keyboard shortcuts', keys.el, 'Lightroom: P, X and U flag in Edit too, V black & white, K masks, Shift+P presets, ⌘K keywords, ⌘U auto, ⌘⇧R reset, ⌘⇧E export, ⌘⇧I import.')),
      card('Storage', toggle('Keep linked photos on this device', () => !!prefs.keepLinked, (v) => { prefs.keepLinked = v; savePrefs(); }).el,
        el('p', { class: 'hint' }, 'Off: photos linked from Google Photos, Drive, Dropbox or OneDrive use no space here or in Rembrandt storage. Only a small preview and your edits are kept, and after you close Rembrandt you pick a photo again to keep editing it. On: they open instantly, but use space on this device.')),
      card('Export', field('Default format', fmt.el), q.el),
    ];
  }

  function data() {
    const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try { const n = await hooks.restoreBackup(JSON.parse(await f.text())); toast(`Restored edits for ${n} photo${n === 1 ? '' : 's'}`); } catch (e) { toast(`Couldn't read that backup: ${e.message}`); }
    });
    const backup = button('Save backup', async () => {
      const d = {
        app: 'Rembrandt', version: 1, savedAt: new Date().toISOString(), profile: { name: prefs.name },
        photos: app.images.map((e) => ({ key: e.key, name: e.name, rating: e.rating || 0, flag: e.flag || 0, params: e.params || null })),
        albums: hooks.albums(),
      };
      try { await saveBlob(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' }), `photo-library-backup-${new Date().toISOString().slice(0, 10)}.json`); } catch (e) { if (e?.code !== 'declined') toast(`Backup failed: ${e.message}`); }
    }, 'sm', 'save');
    const out = [card('Backup',
      el('p', { class: 'lead' }, 'A backup holds your edits, ratings, flags and albums (not the photo files). Restore it on another device after importing the same photos.'),
      el('div', { class: 'row-btns' }, backup, button('Restore from backup…', () => fileIn.click(), 'sm ghost'), fileIn))];
    if (online()) {
      const exp = button('Download my account data', () => busy(exp, async () => {
        const d = await api.exportAccountData();
        await saveBlob(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' }), `account-data-${new Date().toISOString().slice(0, 10)}.json`);
      }), 'sm ghost', 'download');
      const confirmIn = el('input', { class: 'text-input', id: 'deleteConfirm', placeholder: cl().me?.email || 'your email', autocomplete: 'off' });
      confirmIn.addEventListener('keydown', (e) => e.stopPropagation());
      const del = button('Delete account', () => busy(del, async () => {
        if (confirmIn.value.trim().toLowerCase() !== (cl().me?.email || '').toLowerCase()) throw new Error('Type your email address to confirm');
        await api.deleteAccount(confirmIn.value.trim());
        await sb.signOut();
        await hooks.accountChanged();
        toast('Your account and online data were deleted');
        render();
      }), 'sm danger');
      out.push(card('Your data', el('p', { class: 'lead' }, 'Download everything stored in your account: profile, plan, synced edits, albums and share links.'), el('div', { class: 'row-btns' }, exp)));
      out.push(card('Delete account',
        el('p', { class: 'lead' }, 'Deletes your account, synced edits, albums, share links and every original stored online. Subscriptions are cancelled. Photos on this device are not touched. This cannot be undone.'),
        ['apple', 'google'].includes(cl().info?.source) ? el('p', { class: 'warn-text' }, `Your Cloud plan is billed through ${sellerName(cl().info.source)}. Cancel it there first; deleting your account can't stop store billing.`) : null,
        el('label', { class: 'field' }, el('span', {}, 'Type your email address to confirm'), confirmIn), el('div', { class: 'row-btns' }, del)));
    }
    const repo = `https://github.com/${CONFIG.repo}`;
    const site = (CONFIG.siteUrl || '').replace(/\/$/, '');
    const open = (url) => { const ext = openExternal(); if (ext) ext(url); else window.open(url, '_blank', 'noopener'); };
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', onclick: (e) => { if (openExternal()) { e.preventDefault(); open(href); } } }, text);
    out.push(card('About',
      el('div', { class: 'about' },
        el('p', {}, el('b', {}, BRAND.name), window.LUMEN_BUILD?.version ? ` ${window.LUMEN_BUILD.version}` : ''),
        el('p', { class: 'hint' }, `© ${new Date().getFullYear()} ${BRAND.company}`),
        el('p', {}, 'Free software under the GNU General Public License v3 or later: use it, study it, change it and share it. Image processing: ', el('b', {}, BRAND.engine), '. On-device AI: MediaPipe models (Apache-2.0). RAW decoding: LibRaw (LGPL-2.1).'),
        el('p', {}, link(repo, 'Source code'), ' · ', link(`${repo}/releases`, 'Downloads'), ' · ', link(`${repo}/issues`, 'Report a problem'),
          ...(site ? [' · ', link(`${site}/terms.html`, 'Terms of service'), ' · ', link(`${site}/privacy.html`, 'Privacy policy')] : [])),
        el('p', { class: 'hint' }, 'No ads and no tracking. AI features run on your device.'))));
    out.push(card('Support Rembrandt',
      el('p', { class: 'lead' }, 'Rembrandt is free and stays free. If it’s useful to you, you can help keep it going: star it on GitHub, tell a friend, report bugs, or subscribe to Cloud sync.'),
      el('div', { class: 'row-btns' },
        CONFIG.supportUrl ? button('Support Rembrandt', () => open(CONFIG.supportUrl), 'sm', 'heart') : null,
        button('Star on GitHub', () => open(repo), 'sm ghost', 'star'))));
    return out;
  }

  // Phone app only: the one-time unlock (free download; saving needs it after the free saves).
  function unlock() {
    if (isUnlocked()) {
      return [card(null, el('div', { class: 'cloud-ask-row' },
        el('div', {}, el('h2', {}, 'Rembrandt is unlocked'), el('p', { class: 'hint' }, 'Thank you. Everything is yours, on every phone and tablet with this store account.'))))];
    }
    const left = freeSavesLeft();
    return [card(null,
      el('h2', {}, 'Unlock Rembrandt'),
      el('p', { class: 'lead' }, `Editing is free to try${left ? `, and you have ${left} free save${left === 1 ? '' : 's'} left` : ''}. Unlock once for ${unlockPrice()} to save and share without limits. No subscription.`),
      unlockPanel(app, () => render()))];
  }
  onUnlockChange(() => { if (current === 'unlock' && root.isConnected) render(); });

  const BUILD = { unlock, cloud: cloudSync, storage, sharing, prefs: preferences, data };

  function render() {
    nav.textContent = '';
    nav.append(el('button', { class: 'acct-back', onclick: () => hooks.back() }, icon('chevron', 'i back-chev'), 'Back'));
    for (const [id, label, ic] of SECTIONS) {
      const b = el('button', { class: 'acct-nav-item' + (id === current ? ' on' : ''), 'aria-current': id === current ? 'page' : null }, icon(ic), el('span', {}, label));
      b.addEventListener('click', () => { current = id; render(); });
      nav.append(b);
    }
    body.textContent = '';
    const title = SECTIONS.find((s) => s[0] === current)[1];
    body.append(el('div', { class: 'acct-inner' }, el('h1', { class: 'acct-title' }, title), ...BUILD[current]()));
  }

  return {
    el: root,
    show(section) { section = ALIAS[section] || section; if (section && BUILD[section]) current = section; render(); body.scrollTop = 0; },
    render,
  };
}
