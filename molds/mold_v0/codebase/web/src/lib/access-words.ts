// The words of access (mold_v0-334): one word for each state of an invitation, a member and a key, the same in the workspace
// (Settings, Users and invites, API keys) and in the staff console. An invitation withdrawn is "cancelled" everywhere
// (stored as revoked); a key withdrawn is "revoked". A suspended member and an expired invitation are not errors: their
// badges are neutral, never red. mold_v0-338: a key's state, and its unused and expires-soon marks, the same on both keys pages.
export const INVITE_STATE_WORDS: Record<string, string> = { pending: 'Invited', accepted: 'Accepted', revoked: 'Cancelled', expired: 'Invitation expired' };
export const inviteStateWords = (state: string) => INVITE_STATE_WORDS[state] ?? state;
export const CANCEL_INVITATION = 'Cancel invitation';
export const INVITATION_CANCELLED = 'Invitation cancelled';
/** Days without use after which a key is flagged "unused" (src/member-keys.ts UNUSED_DAYS, the same). */
export const UNUSED_DAYS = 90;
/** Days before its expiry from which an active key is marked "Expires soon" (mold_v0-338, both keys pages). */
export const EXPIRES_SOON_DAYS = 7;
/** A key's state, with a capital, the same on both keys pages (mold_v0-338: the developer keys read "active" before). */
export const KEY_STATE_WORDS: Record<'active' | 'expired' | 'revoked', string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked' };
/** Whether an active key is unused: its last use, else its making, longer ago than UNUSED_DAYS (src/member-keys.ts isUnused, the same). */
export const keyUnused = (k: { state: string; last_used_at: string | null; created_at: string }, now = Date.now()) =>
  k.state === 'active' && now - new Date(k.last_used_at ?? k.created_at).getTime() > UNUSED_DAYS * 86_400_000;
/** Whether an active key expires within EXPIRES_SOON_DAYS days. */
export const keyExpiresSoon = (k: { state: string; expires_at: string | null }, now = Date.now()) =>
  k.state === 'active' && !!k.expires_at && new Date(k.expires_at).getTime() - now <= EXPIRES_SOON_DAYS * 86_400_000;
/** An active key nobody used for UNUSED_DAYS days, in words: never used, or not used since. */
export const unusedWords = (k: { last_used_at: string | null }) => (k.last_used_at ? `Not used for ${UNUSED_DAYS} days` : 'Never used');
