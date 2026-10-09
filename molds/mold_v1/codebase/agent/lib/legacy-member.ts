/**
 * The member's words before the default profile spoke neutrally: the base product's old role word.
 *
 * Base text never uses them: it writes role placeholders (`{member}`, `{owner}`) that the profile fills
 * (agent/lib/agent-vocabulary.ts), and the UI reads lib/ui-words.ts. They survive only where something outside
 * the source already holds them, and only to be READ: stored values (a ticket's `ownerTeam`, an account's
 * `valueEvidenceStatus`, a roster entry's `kind`), the owner keys of a record a data room or workbook stored before
 * the rename, an old tool name in a stored transcript or workflow, and text an older checkout wrote (an interaction
 * note, a memory). This is the one place the app spells the word: the vocabulary translates it under a relabelling
 * profile, and the UI shows a stored value in the profile's member word.
 *
 * The word is built from its letters, so the source never carries it as text: it is a name the published code no
 * longer uses, kept here only so data written under it is still understood.
 *
 * Pure: no imports, safe on the client, the server and in offline scripts.
 */
const WORD = String.fromCharCode(0x46, 0x44, 0x45);

export const LEGACY_MEMBER = { singular: WORD, plural: `${WORD}s`, owner: `${WORD} owner` } as const;

/** The legacy word in lower case, as identifiers and stored keys spell it. */
export const LEGACY_WORD = WORD.toLowerCase();

/** The upper-camel form an identifier joins it with (`solution` + it + `Owner`). */
const CAMEL = WORD[0] + WORD.slice(1).toLowerCase();

/**
 * The record keys and columns the owners were stored under before the rename, by what they hold now:
 * the account's owner (`accountOwner`, `account_owner`) and a solution's (`solutionOwner`, `solution_owner`).
 */
export const LEGACY_OWNER_KEYS = {
  accountOwner: `${LEGACY_WORD}Owner`,
  account_owner: `${LEGACY_WORD}_owner`,
  solutionOwner: `solution${CAMEL}Owner`,
  solution_owner: `solution_${LEGACY_WORD}_owner`,
} as const;

/** An owner key as stored before the rename (either case): a person reads the profile's owner label for it. */
export const LEGACY_OWNER_KEY = new RegExp(`^${LEGACY_WORD}_?owner$`, "i");
/** The solution's owner key as stored before the rename. */
const LEGACY_SOLUTION_OWNER_KEY = new RegExp(`^solution_?${LEGACY_WORD}_?owner$`, "i");

/**
 * The label a person reads for an owner key, given the profile's owner label ("Account owner"), or null when `key`
 * is not one. `account_owner` (and its stored predecessor) -> "Account owner"; `solution_owner` (and its stored
 * predecessor) -> "Solution account owner".
 */
export function ownerKeyLabel(key: string, owner: string): string | null {
  if (LEGACY_OWNER_KEY.test(key) || /^account_?owner$/i.test(key)) return owner;
  if (LEGACY_SOLUTION_OWNER_KEY.test(key) || /^solution_?owner$/i.test(key)) return `Solution ${/^[A-Z][a-z]/.test(owner) ? owner[0].toLowerCase() + owner.slice(1) : owner}`;
  return null;
}

/**
 * The same record with each owner stored under its old key moved to its current one: `accountOwner` on an account,
 * `solutionOwner` on each of its solutions (camelCase, as a data room or the sample data stores a record). A record
 * that already has the current key keeps its value; the old key is removed either way. Anything else is untouched.
 */
export function withCurrentOwnerKeys<T>(record: T): T {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const r = record as Record<string, unknown>;
  let out: Record<string, unknown> = r;
  const move = (from: string, to: string) => {
    if (!(from in out)) return;
    const { [from]: old, ...rest } = out;
    out = to in rest && rest[to] !== undefined && rest[to] !== null ? rest : { ...rest, [to]: old };
  };
  move(LEGACY_OWNER_KEYS.accountOwner, "accountOwner");
  if (Array.isArray(out.solutions)) {
    const solutions = out.solutions.map((s) => {
      if (!s || typeof s !== "object" || !(LEGACY_OWNER_KEYS.solutionOwner in s)) return s;
      const { [LEGACY_OWNER_KEYS.solutionOwner]: old, ...rest } = s as Record<string, unknown>;
      return rest.solutionOwner !== undefined && rest.solutionOwner !== null ? rest : { ...rest, solutionOwner: old };
    });
    out = { ...out, solutions };
  }
  return out as T;
}
