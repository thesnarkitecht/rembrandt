// Account operations against the backend (profile, sharing, storage, devices, deletion).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import * as sb from './supabase.js';

const uid = () => sb.currentUser()?.id;

export const getProfile = async () => (await sb.rest(`profiles?select=display_name&id=eq.${uid()}`))[0] || {};
export const setDisplayName = (name) => sb.rest(`profiles?id=eq.${uid()}`, { method: 'PATCH', body: { display_name: name.trim().slice(0, 80) }, headers: { Prefer: 'return=minimal' } });
export const changeEmail = (email) => sb.updateUser({ email });

export const listShares = () => sb.rest(`shares?select=token,title,item_count,created_at,expires_at,view_count,allow_download,revoked&user_id=eq.${uid()}&revoked=eq.false&order=created_at.desc`);
export const revokeShare = (token) => sb.fn('share', { op: 'revoke', token });

export const listOnlineOriginals = () => sb.rest(`photos?select=id,key,name,original_size,updated_at&user_id=eq.${uid()}&original_key=not.is.null&deleted=eq.false&order=original_size.desc&limit=200`);
export const removeOnlineOriginal = (photoId) => sb.fn('r2', { op: 'delete', photoId });


export const exportAccountData = () => sb.fn('account', { op: 'export' });
export const deleteAccount = (confirmEmail) => sb.fn('account', { op: 'delete', confirm: confirmEmail });
export const billingPortal = () => sb.fn('billing-portal', {});
// Kickstarter and gift codes add Cloud time to the account.
export const redeemCode = (code) => sb.rpc('redeem_code', { code });
