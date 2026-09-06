/**
 * Org → blob-prefix mapping (the tenancy seam for the data room).
 *
 * New workspaces write under `orgs/{org_id}/…` with the dm.md tree beneath.
 * OnFinance (org #1) keeps its LEGACY ROOT layout — the dm.md tree at the blob
 * root — so day one needs no mass copy: its effective prefix is "" and the
 * `orgs/onfinance/` name is an alias for the same bytes.
 *
 * This module is the single place that decision lives, so wiring it into
 * `dataroom-store.ts` later is a one-line change per read/write, and org #1's
 * behavior provably does not change (identity mapping). It is intentionally
 * pure and side-effect free.
 */

/**
 * Org #1 — its data room is the legacy root (no per-org sub-prefix).
 *
 * TWO ids, and that is not tidiness. The workspace row is `org-onfinance-ai`
 * while this constant was `org-onfinance`, so the two never matched: a caller
 * holding the real workspace id addressed `orgs/org-onfinance-ai/` and a caller
 * passing nothing addressed the root. Org #1's data room was split across two
 * prefixes — its 223 customer files in one, its chat uploads in the other —
 * and each half looked complete to whoever read it.
 *
 * THIS MAPPING IS DUPLICATED in agent/lib/dataroom-store.ts,
 * agent/lib/org-blob.ts and lib/dataroom-blob.ts (bundler boundaries keep them
 * apart). They must stay in lockstep — `npm run check:gates` enforces it.
 */
export const LEGACY_ROOT_ORGS = new Set(["org-onfinance", "org-onfinance-ai"]);
export const isLegacyRootOrg = (orgId?: string | null): boolean => !orgId || LEGACY_ROOT_ORGS.has(orgId);
/** Kept for existing importers. */
export const LEGACY_ROOT_ORG = "org-onfinance";

/**
 * The blob key prefix for a workspace's data room.
 *   - onfinance → ""      (legacy root; no migration)
 *   - <other>   → "orgs/<id>"
 * A trailing slash is NOT included; callers join with "/".
 */
export function orgBlobPrefix(orgId: string | null | undefined): string {
  if (isLegacyRootOrg(orgId)) return "";
  return `orgs/${orgId}`;
}

/** Map a data-room logical path to its physical blob key for an org. */
export function orgBlobKey(orgId: string | null | undefined, logicalPath: string): string {
  const prefix = orgBlobPrefix(orgId);
  const clean = logicalPath.replace(/^\/+/, "");
  return prefix ? `${prefix}/${clean}` : clean;
}

/**
 * Reverse of orgBlobKey: strip a workspace's prefix off a physical key to get
 * the logical data-room path. Returns null when the key isn't under the org's
 * prefix (guards path traversal above the prefix — §8 isolation).
 */
export function logicalPathForOrg(orgId: string | null | undefined, blobKey: string): string | null {
  const prefix = orgBlobPrefix(orgId);
  if (!prefix) return blobKey;
  if (blobKey === prefix) return "";
  if (blobKey.startsWith(`${prefix}/`)) return blobKey.slice(prefix.length + 1);
  return null;
}
