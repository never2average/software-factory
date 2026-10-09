/**
 * The schema drizzle-kit reads (drizzle.config.ts), for the release between drizzle/0037 and drizzle/0038 only.
 *
 * It is agent/lib/db/schema.ts exactly, plus the two retired owner columns a live database still holds:
 * customers' original owner column and solutions' (drizzle/0028 added `account_owner` and `solution_owner` beside
 * them; drizzle/0037 made them nullable, dropped the original's index and stopped every reader and writer of them).
 *
 * Why they are declared here and not in schema.ts. The deploy runs the journal, then a read-only drift dry run of
 * `drizzle-kit push` against this file, and refuses any DROP COLUMN it would plan. Until drizzle/0038 drops them in
 * the journal, a schema without these columns would stop every deploy. Declaring them in schema.ts instead would put
 * them in every `select()` the app makes, so the release that drops them would break the release still serving
 * during its deploy window. Here they are seen by drizzle-kit and by nothing the app runs.
 *
 * drizzle/0038 drops both columns; this file then goes, and drizzle.config.ts points back at schema.ts.
 */
import { text } from "drizzle-orm/pg-core";
import { LEGACY_OWNER_KEYS } from "../legacy-member.ts";
import { customersTableWith, solutionsTableWith } from "./schema.ts";

export * from "./schema.ts";

/** customers, with its retired owner column (nullable, unindexed: drizzle/0037). */
export const customers = customersTableWith({ retiredAccountOwner: text(LEGACY_OWNER_KEYS.account_owner) });

/** solutions, with its retired owner column (nullable since drizzle/0037). */
export const solutions = solutionsTableWith({ retiredSolutionOwner: text(LEGACY_OWNER_KEYS.solution_owner) });
