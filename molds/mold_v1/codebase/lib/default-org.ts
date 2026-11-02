/**
 * Org #1's identity: its workspace id and its Google Workspace hosted domain.
 *
 * Org #1 is the backfill target, the fail-safe while tenancy isn't live, and the workspace every identity at its
 * domain resolves to. Each deployment names its own:
 *
 *   DEFAULT_ORG_ID      org #1's workspace id, e.g. `org-yourcompany`
 *   DEFAULT_ORG_DOMAIN  org #1's Google Workspace hosted domain, e.g. `yourcompany.com`
 *
 * A deployment keeps the id its data was written under: org_id columns, row-level security and the data room's
 * `orgs/<id>/` folders all carry it, so changing DEFAULT_ORG_ID on a live database strands org #1's rows and files.
 * Unset, the neutral built-in placeholders below apply (a fresh database, a test, a local run).
 *
 * The one place the rule and the built-in values are written. lib/org-context.ts (web) and agent/lib/org-context.ts
 * (agent) re-export it; scripts/lib/default-org.mjs reads the built-in values from this file and applies the same rule.
 * No `server-only` and no path alias: both bundles import it.
 */

/** Org #1's workspace id when DEFAULT_ORG_ID is unset. */
export const BUILT_IN_ORG = "org-acmeco";
/** Org #1's hosted domain when DEFAULT_ORG_DOMAIN is unset. */
export const BUILT_IN_DOMAIN = "acmeco.example";

/** Org #1's workspace id: DEFAULT_ORG_ID, else BUILT_IN_ORG. Read once, when the module loads. */
export const DEFAULT_ORG: string = process.env.DEFAULT_ORG_ID?.trim() || BUILT_IN_ORG;
/** Org #1's Google Workspace hosted domain, lower case: DEFAULT_ORG_DOMAIN, else BUILT_IN_DOMAIN. */
export const DEFAULT_DOMAIN: string = (process.env.DEFAULT_ORG_DOMAIN?.trim() || BUILT_IN_DOMAIN).toLowerCase();
