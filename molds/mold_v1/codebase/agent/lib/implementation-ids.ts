/**
 * HOW AN IMPLEMENTATION RECORD IS IDENTIFIED (records.areas.implementations `per_account`; drizzle/0044).
 *
 * Every implementation row has its own id (`implementationId`, the table's key with the workspace). How it is used is
 * the profile's:
 *
 *   one   (the default, and what a profile that says nothing gets): an account holds one record. Its id is the account
 *         id, so (org_id, implementation_id) still holds one row per account and every path finds it by the account,
 *         as it always has. The lists, the activity feed and the tasks filed under it key it as they always did
 *         (its rolloutId, or the account when rows are grouped by rolloutId).
 *   many  an account may hold several (a regulator's several compliance frameworks). Each row has an id of its own,
 *         generated when it is created (or the one the caller names), and every path addresses a row by it: the
 *         screens, the ops routes, upsert_customer's `implementations[]`, the per-area tools, MCP, the workbook.
 *
 * Only an area stated in the record-area form may say "many" (scripts/lib/record-areas.mjs refuses it elsewhere).
 * Pure: no database. Shared by the server and the screens.
 */
import { RECORD_AREAS } from "./record-areas.generated.ts";
import type { RecordAreas } from "./record-areas.ts";
import { isDeclared } from "./record-area-records.ts";
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";

/** The key a row's id is under, in the record, the API and the agent's tools. */
export const IMPLEMENTATION_ID = "implementationId";

/** Does this deployment keep several implementation records per account (each with its own id)? */
export function manyPerAccount(areas: RecordAreas = RECORD_AREAS): boolean {
  return isDeclared("implementations", areas) && areas.implementations.per_account === "many";
}

/** Rows are gathered under a shared rolloutId (a portfolio): the legacy key of a one-per-account row is its account. */
const GROUPED_BY_ROLLOUT = DEPLOYMENT_PROFILE.domains.implementations.group_by === "rolloutId";

/**
 * A row's id as the lists, the activity feed and the tasks filed under it key it: its own id when an account holds
 * several; else as it always was (the account when rows are grouped by rolloutId, else its rolloutId, else the account).
 */
export function implementationKey(
  row: object,
  opts: { many?: boolean; grouped?: boolean } = {},
): string {
  const r = row as { customerId?: unknown; rolloutId?: unknown; implementationId?: unknown };
  const many = opts.many ?? manyPerAccount();
  if (many && typeof r.implementationId === "string" && r.implementationId) return r.implementationId;
  const grouped = opts.grouped ?? GROUPED_BY_ROLLOUT;
  return String(grouped ? r.customerId : (r.rolloutId as string | null | undefined) ?? r.customerId);
}

/** What an id a caller names may look like: what fits in a path and a sentence. */
export const IMPLEMENTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The id a new row gets when the caller names none ("many" only). */
export function newImplementationId(): string {
  return globalThis.crypto.randomUUID();
}

/** An id a caller names, checked: the trimmed id, null for none, or the sentence that says what is wrong. */
export function namedImplementationId(raw: unknown): { id: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { id: null };
  if (typeof raw !== "string" || !IMPLEMENTATION_ID_PATTERN.test(raw.trim())) {
    return { error: `\`${IMPLEMENTATION_ID}\` is letters, digits, ".", "_", ":" or "-", starting with a letter or digit, at most 100 characters.` };
  }
  return { id: raw.trim() };
}
