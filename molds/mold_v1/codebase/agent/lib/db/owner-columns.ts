/**
 * The owner of an account and of a solution, and an account's second owner.
 *
 *   customers.account_owner    (accountOwner)    one column (drizzle/0028 added it; 0037 made it the only one used)
 *   solutions.solution_owner   (solutionOwner)   one column (likewise)
 *   customers.secondary_owner  (secondaryOwner)  beside  customers.ae_owner  (aeOwner)   drizzle/0029
 *
 * The account's and the solution's owner each had an original column beside the neutral one; since drizzle/0037 the
 * app reads and writes only the neutral one (the original is kept equal by 0028's trigger until 0038 drops both), so
 * they need nothing here beyond a name for the column.
 *
 * The second owner still has two names. `secondary_owner` is the one the app reads; `ae_owner` is the original, kept
 * and always written too. On a migrated database a trigger keeps the pair equal whichever side a statement writes. A
 * database built by `drizzle-kit push` alone (CI's, a developer's) has the columns but not the trigger, so:
 *
 *   - every write names BOTH columns (pairOwners on any insert row or update set);
 *   - every read takes the neutral column and falls back to the original (secondaryOwnerOf, secondaryOwnerSql).
 */
import { sql, type SQL } from "drizzle-orm";
import { customers } from "./schema.ts";

/** A row or a `set` that may name either side of the account's second owner. */
type SecondaryOwnerSides = { secondaryOwner?: string | null; aeOwner?: string | null };

/**
 * The same customers row with both keys of the second-owner pair set to the one value it names: the neutral key when
 * it is given (undefined is "not given"), else the original. Untouched when it names neither, so an update leaves
 * both alone.
 */
export function pairOwners<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & SecondaryOwnerSides;
  const second = r.secondaryOwner !== undefined ? r.secondaryOwner : r.aeOwner;
  if (second === undefined) return row;
  return { ...row, secondaryOwner: second, aeOwner: second };
}

/** The account's owner from a customers row. */
export function ownerOf(row: { accountOwner?: string | null }): string | null {
  return row.accountOwner ?? null;
}

/** The account's second owner from a row read with both columns: the neutral one, else the original. */
export function secondaryOwnerOf(row: SecondaryOwnerSides): string | null {
  return row.secondaryOwner ?? row.aeOwner ?? null;
}

/** The account's owner as a column of a select. */
export const accountOwnerSql: SQL<string | null> = sql<string | null>`${customers.accountOwner}`;

/** The account's second owner as a column of a select: the neutral column, else the original. */
export const secondaryOwnerSql: SQL<string | null> = sql<string | null>`coalesce(${customers.secondaryOwner}, ${customers.aeOwner})`;

/**
 * A customers row read with `select()` (every column), as an API returns it: both keys of the second-owner pair carry
 * the value read with the fallback, so a caller reading either name gets the same value. A row with neither key is
 * returned as it is.
 */
export function withOwnerKeys<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & SecondaryOwnerSides;
  if (!("secondaryOwner" in r) && !("aeOwner" in r)) return row;
  const second = secondaryOwnerOf(r);
  return { ...row, secondaryOwner: second, aeOwner: second };
}
