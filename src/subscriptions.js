// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Cloud subscriptions bought inside the phone apps. Desktop and web builds buy Cloud on the website
// (account-page.js opens the pricing page), so this is the placeholder they use. The phone apps'
// build (rembrandt-mobile) replaces this file with the App Store / Google Play version, which keeps
// these exports.

export const storeName = '';
export const storePlatform = '';
// Who bills a plan, so every app can say where to manage it (a plan bought on a phone is managed there).
const SOURCES = { apple: 'the App Store', google: 'Google Play', paddle: 'Rembrandt on the web' };
export const sellerName = (source) => SOURCES[source] || SOURCES.paddle;
export const storePrice = () => '';
export async function loadStorePrices() { return {}; }
export async function buySubscription() { throw new Error('Buy Cloud on the website'); }
export async function syncStoreSubscriptions() { return 0; }
export async function manageStoreSubscription() {}
