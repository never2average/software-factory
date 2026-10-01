/**
 * The owner of an account and of a solution, under two column names each (drizzle/0028_neutral_owner_columns.sql).
 *
 *   customers.account_owner   (accountOwner)   beside  customers.fde_owner            (fdeOwner)
 *   solutions.solution_owner  (solutionOwner)  beside  solutions.solution_fde_owner   (solutionFdeOwner)
 *
 * The neutral column is the one the app reads; the original is a contract writers outside this repository still name
 * (the software factory's workspace seeding writes customers.fde_owner in raw SQL), so it is kept, never dropped, and
 * always written too. On a migrated database a trigger keeps each pair equal whichever side a statement writes. A
 * database built by `drizzle-kit push` alone (CI's, a developer's) has the columns but not the trigger, so:
 *
 *   - every write names BOTH columns (pairOwners / pairSolutionOwners on any insert row or update set);
 *   - every read takes the neutral column and falls back to the original (accountOwnerSql, ownerOf, ...).
 */
import { sql, type SQL } from "drizzle-orm";
import { customers, solutions } from "./schema.ts";

/** A row or a `set` that may name either side of the account owner. */
type AccountOwnerSides = { accountOwner?: string | null; fdeOwner?: string | null };
/** A row or a `set` that may name either side of a solution's owner. */
type SolutionOwnerSides = { solutionOwner?: string | null; solutionFdeOwner?: string | null };

/**
 * The value a write puts on both sides: the neutral key when it is given (undefined is "not given"), else the
 * original. undefined when the write names neither, so an update leaves both alone.
 */
function written(neutral: string | null | undefined, original: string | null | undefined): string | null | undefined {
  return neutral !== undefined ? neutral : original;
}

/** The same row with both account-owner keys set to the one value it names; untouched when it names neither. */
export function pairOwners<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & AccountOwnerSides;
  const v = written(r.accountOwner, r.fdeOwner);
  return v === undefined ? row : { ...row, accountOwner: v, fdeOwner: v };
}

/** The same row with both solution-owner keys set to the one value it names; untouched when it names neither. */
export function pairSolutionOwners<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & SolutionOwnerSides;
  const v = written(r.solutionOwner, r.solutionFdeOwner);
  return v === undefined ? row : { ...row, solutionOwner: v, solutionFdeOwner: v };
}

/** The account's owner from a row read with both columns: the neutral one, else the original. */
export function ownerOf(row: AccountOwnerSides): string | null {
  return row.accountOwner ?? row.fdeOwner ?? null;
}

/** A solution's owner from a row read with both columns: the neutral one, else the original. */
export function solutionOwnerOf(row: SolutionOwnerSides): string | null {
  return row.solutionOwner ?? row.solutionFdeOwner ?? null;
}

/** The account's owner as a column of a select: the neutral column, else the original. */
export const accountOwnerSql: SQL<string | null> = sql<string | null>`coalesce(${customers.accountOwner}, ${customers.fdeOwner})`;

/** A solution's owner as a column of a select: the neutral column, else the original. */
export const solutionOwnerSql: SQL<string | null> = sql<string | null>`coalesce(${solutions.solutionOwner}, ${solutions.solutionFdeOwner})`;

/**
 * A row read with `select()` (every column), as an API returns it: both keys carry the owner read with the fallback,
 * so a caller reading either name gets the same value.
 */
export function withOwnerKeys<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & AccountOwnerSides;
  if (!("accountOwner" in r) && !("fdeOwner" in r)) return row;
  const v = ownerOf(r);
  return { ...row, accountOwner: v, fdeOwner: v };
}

/** withOwnerKeys for a solution row. */
export function withSolutionOwnerKeys<T extends Record<string, unknown>>(row: T): T {
  const r = row as T & SolutionOwnerSides;
  if (!("solutionOwner" in r) && !("solutionFdeOwner" in r)) return row;
  const v = solutionOwnerOf(r);
  return { ...row, solutionOwner: v, solutionFdeOwner: v };
}
