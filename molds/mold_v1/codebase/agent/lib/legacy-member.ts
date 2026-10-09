/**
 * The member's words before the default profile spoke neutrally.
 *
 * Base text never uses them: it writes role placeholders (`{member}`, `{owner}`) that the profile fills
 * (agent/lib/agent-vocabulary.ts), and the UI reads lib/ui-words.ts. They survive only where something outside
 * the base text already holds them: contract identifiers (the `fdeOwner` key, the `fde_owner` column, an old
 * tool name), stored values (a ticket's `ownerTeam`, an account's `valueEvidenceStatus`) and text an older
 * checkout wrote (an interaction note, a memory). This is the one place that spells them: the vocabulary
 * translates them under a relabelling profile, and the UI shows a stored value in the profile's member word.
 *
 * Pure: no imports, safe on the client, the server and in offline scripts.
 */
export const LEGACY_MEMBER = { singular: "FDE", plural: "FDEs", owner: "FDE owner" } as const;

/** The owner key as stored (`fdeOwner`, `fde_owner`): a person reads the profile's owner label for it. */
export const LEGACY_OWNER_KEY = new RegExp(`^${LEGACY_MEMBER.singular.toLowerCase()}_?owner$`, "i");
/** The solution's owner key as stored (`solutionFdeOwner`, `solution_fde_owner`). */
const LEGACY_SOLUTION_OWNER_KEY = new RegExp(`^solution_?${LEGACY_MEMBER.singular.toLowerCase()}_?owner$`, "i");

/**
 * The label a person reads for an owner key, given the profile's owner label ("Account owner"), or null when `key`
 * is not one. Both names each key has: the stored one with the legacy word and the neutral one beside it
 * (drizzle/0028_neutral_owner_columns.sql). `fde_owner` / `account_owner` -> "Account owner";
 * `solution_fde_owner` / `solution_owner` -> "Solution account owner".
 */
export function ownerKeyLabel(key: string, owner: string): string | null {
  if (LEGACY_OWNER_KEY.test(key) || /^account_?owner$/i.test(key)) return owner;
  if (LEGACY_SOLUTION_OWNER_KEY.test(key) || /^solution_?owner$/i.test(key)) return `Solution ${/^[A-Z][a-z]/.test(owner) ? owner[0].toLowerCase() + owner.slice(1) : owner}`;
  return null;
}
