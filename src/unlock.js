// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// The phone apps' one-time unlock. Desktop and web builds have nothing to unlock, so this is the
// placeholder they use: everything is unlocked and saving is never limited. The phone apps' build
// (rembrandt-mobile) replaces this file with the App Store / Google Play version, which keeps
// these exports.

export const UNLOCK_ID = 'rembrandt.unlock';
export const FREE_SAVES = Infinity;
export const onUnlockChange = () => () => {};
export const isUnlocked = () => true;
export const freeSavesLeft = () => Infinity;
export const unlockPrice = () => '';
export const canSave = () => true;
export function countSave() {}
export async function refreshUnlock() {}
export async function buyUnlock() { return false; }
export async function restoreUnlock() { return false; }
export async function redeemUnlockCode() { return false; }
export function unlockPanel() { return null; }
export async function askToUnlock() { return true; }
