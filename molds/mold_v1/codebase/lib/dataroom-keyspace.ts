/**
 * THE DATA ROOM'S KEY SPACE — one workspace, one prefix, and no other way in.
 *
 * Every workspace's data room lives under its own disjoint prefix:
 *
 *     blob:   dataroom/orgs/<org_id>/<dm.md path>
 *     local:  $DATAROOM_DIR/orgs/<org_id>/<dm.md path>
 *
 * and nothing lives at the root. It used to be otherwise. Workspace #1 (the ids in a legacy-root set) and ANY
 * caller that passed no workspace at all were mapped to the ROOT prefix `dataroom/`, while every other workspace was
 * `dataroom/orgs/<id>/`. Two things followed:
 *
 *   · a missing workspace id fell back to the root instead of being refused — a caller that lost its workspace on
 *     the way (an export route that never passed one, an upload with no resolved context) read and wrote the root;
 *   · the root CONTAINS `orgs/`, so the legacy workspace's listing — and every search, zip and export built on a
 *     listing — returned every other workspace's files as `orgs/<their id>/…`.
 *
 * Now a missing or malformed workspace id THROWS ({@link requireWorkspace}), every workspace (the legacy one
 * included) is `orgs/<id>/`, and a listing never returns a path under `orgs/` or `_versions/` even if one exists
 * inside a workspace's own tree. Objects still at the root are moved — only where they provably belong — by a
 * one-time, idempotent migration (scripts/migrate-dataroom-root.mjs).
 *
 * This file imports nothing, so the agent (`../../lib/dataroom-keyspace.ts`), the web app (`@/lib/…`) and plain node
 * (the tests and the migration script) all load the SAME rules. It replaces three hand-kept copies of the mapping
 * (agent/lib/dataroom-store.ts, agent/lib/org-blob.ts, lib/dataroom-blob.ts) that `check:gates` had to hold in step.
 */

/** The blob key space the data room lives in. */
export const DATAROOM_ROOT = "dataroom";
/** The directory every workspace's tree sits in, under the root. */
export const WORKSPACES_DIR = "orgs";
/** Snapshots of overwritten files (lib/dataroom-versions.ts), inside each workspace's own tree. */
export const VERSIONS_DIR = "_versions";

/** Thrown when a data-room call reaches the store without a workspace. Nothing is read or written. */
export class WorkspaceRequiredError extends Error {
  constructor(detail: string) {
    super(`The data room needs a workspace: ${detail}. Nothing was read or written.`);
    this.name = "WorkspaceRequiredError";
  }
}

/**
 * What a workspace id may look like here: one path segment. Ids are `org-<slug>`, bare slugs (`desk-a`,
 * `customer-b`) and the isolated `personal:<domain>` form (lib/org-context.ts), so `:` `.` `@` are allowed; `/`,
 * `\`, a leading dot and `..` are not, so no id can address another workspace's tree or climb out of its own.
 */
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/** The workspace id, or a {@link WorkspaceRequiredError}. Fail closed: there is no default workspace. */
export function requireWorkspace(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new WorkspaceRequiredError("no workspace was given");
  }
  if (!WORKSPACE_ID.test(orgId) || orgId.includes("..")) {
    throw new WorkspaceRequiredError(`"${orgId.slice(0, 80)}" is not a workspace id`);
  }
  return orgId;
}

/** A workspace's tree relative to the data room's root: `orgs/<id>` (no trailing slash). */
export function workspaceDir(orgId: unknown): string {
  return `${WORKSPACES_DIR}/${requireWorkspace(orgId)}`;
}

/** A workspace's blob key prefix: `dataroom/orgs/<id>` (no trailing slash). */
export function workspaceBlobPrefix(orgId: unknown): string {
  return `${DATAROOM_ROOT}/${workspaceDir(orgId)}`;
}

/**
 * May a listing return this path (relative to a workspace's own tree)? Not a snapshot (`_versions/…` is reached only
 * through the version history), and never anything under an `orgs/` directory — a workspace's listing must not be
 * able to carry a second workspace's tree, whatever ended up in its prefix.
 */
export function isListedPath(rel: string): boolean {
  if (rel.length === 0) return false;
  const top = rel.split("/", 1)[0];
  return top !== VERSIONS_DIR && top !== WORKSPACES_DIR;
}

/**
 * Where a snapshot of `path` taken at `at` lives, relative to the workspace's OWN tree. The format is the one the
 * version rows already store (`_versions/<org>/<at>-<path>`), so existing rows keep resolving once the migration has
 * moved `dataroom/_versions/<org>/…` into `dataroom/orgs/<org>/_versions/<org>/…`.
 */
export function snapshotKey(orgId: string, path: string, at: number): string {
  return `${VERSIONS_DIR}/${requireWorkspace(orgId)}/${at}-${path}`;
}

/** Is `key` a snapshot of THIS workspace (a version row's `prev_blob_key`)? Anything else is refused. */
export function isOwnSnapshotKey(orgId: string, key: string): boolean {
  const prefix = `${VERSIONS_DIR}/${requireWorkspace(orgId)}/`;
  return (
    key.startsWith(prefix) &&
    key.length > prefix.length &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.includes("//") &&
    // No percent-encoding at all: `%2e%2e` or `%2f` would be a dot segment or a slash to anything that decodes.
    !key.includes("%")
  );
}
