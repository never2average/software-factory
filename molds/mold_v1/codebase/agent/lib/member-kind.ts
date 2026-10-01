/**
 * The `kind` a team member's roster entry carries (People/{id}/identity.json), which separates the workspace's own
 * people from the external contacts the same folder holds.
 *
 * New entries are written with MEMBER_KIND. Entries written before it carry the original value, a stored value in
 * every workspace's data room that is never rewritten here, so every reader accepts both (isMemberKind).
 */
export const MEMBER_KIND = "internal-member";

/** The value roster entries were written with before MEMBER_KIND (mold_v1-103, PR 4); read, never written. */
export const LEGACY_MEMBER_KINDS: readonly string[] = ["internal-fde"];

/** Is this identity.json `kind` a team member's (the current value or an earlier one)? */
export function isMemberKind(kind: unknown): boolean {
  return kind === MEMBER_KIND || (typeof kind === "string" && LEGACY_MEMBER_KINDS.includes(kind));
}
