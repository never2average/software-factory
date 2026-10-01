/**
 * An account's two owner fields, each under two KEYS (agent/lib/db/owner-columns.ts holds the columns).
 *
 *   original (the record contract's key)   neutral (the column the app reads first)
 *   fdeOwner   / fde_owner                 accountOwner   / account_owner     drizzle/0028
 *   aeOwner    / ae_owner                  secondaryOwner / secondary_owner   drizzle/0029
 *
 * The original keys carry one line of work's role words, and the agent's record contract, the workbook and existing
 * profiles still name the fields by them; the neutral keys are what the Ops API also accepts and returns. Wherever a
 * list of account keys is read (a profile's `account_fields.hidden`), naming either key of a pair names the field.
 *
 * Pure: no imports, safe on the client, the server and in offline scripts.
 */

/** [original, neutral], camelCase, as customerSchema and the Ops API name them. */
export const OWNER_KEY_TWINS: ReadonlyArray<readonly [original: string, neutral: string]> = [
  ["fdeOwner", "accountOwner"],
  ["aeOwner", "secondaryOwner"],
];

/** The record contract's key for an account key: a neutral owner key maps to its original, any other to itself. */
export function recordOwnerKey(key: string): string {
  return OWNER_KEY_TWINS.find(([, neutral]) => neutral === key)?.[0] ?? key;
}

/** A list of account keys with both keys of every owner pair it names (order kept, no duplicates). */
export function withOwnerKeyTwins(keys: readonly string[]): string[] {
  const out = new Set(keys);
  for (const pair of OWNER_KEY_TWINS) if (pair.some((k) => out.has(k))) for (const k of pair) out.add(k);
  return [...out];
}

/** The second owner's key under any of its names: `aeOwner`, `ae_owner`, `secondaryOwner`, `secondary_owner`. */
export const SECONDARY_OWNER_KEY = /^(?:ae|secondary)_?owner$/i;

/**
 * The label a person reads for the second owner's key, given the profile's label for it
 * (`vocabulary.secondary_owner`, "Secondary owner"), or null when `key` is not one.
 */
export function secondaryOwnerKeyLabel(key: string, label: string): string | null {
  return SECONDARY_OWNER_KEY.test(key) ? label : null;
}

/**
 * A workbook column key as a person reads it: the second owner's original column (`ae_owner`) is shown by its
 * neutral name (`secondary_owner`), in every profile. Any other key is returned as written. Keys are never labels:
 * the label is the profile's (secondaryOwnerKeyLabel).
 */
export function neutralSecondaryOwnerKey(key: string): string {
  if (key === "ae_owner") return "secondary_owner";
  if (key === "aeOwner") return "secondaryOwner";
  return key;
}
