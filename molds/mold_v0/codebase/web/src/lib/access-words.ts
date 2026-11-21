// The words of access (mold_v0-334): one word for each state of an invitation, a member and a key, the same in the workspace
// (Settings, Users and invites, API keys) and in the staff console. An invitation withdrawn is "cancelled" everywhere
// (stored as revoked); a key withdrawn is "revoked". A suspended member and an expired invitation are not errors: their
// badges are neutral, never red.
export const INVITE_STATE_WORDS: Record<string, string> = { pending: 'Invited', accepted: 'Accepted', revoked: 'Cancelled', expired: 'Invitation expired' };
export const inviteStateWords = (state: string) => INVITE_STATE_WORDS[state] ?? state;
export const CANCEL_INVITATION = 'Cancel invitation';
export const INVITATION_CANCELLED = 'Invitation cancelled';
/** Days without use after which a key is flagged "unused" (src/member-keys.ts UNUSED_DAYS, the same). */
export const UNUSED_DAYS = 90;
