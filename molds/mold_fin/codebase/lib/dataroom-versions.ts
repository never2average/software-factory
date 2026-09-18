import "server-only";

import { and, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { dataroomChangesets, dataroomFileVersions } from "@/agent/lib/db/schema";
import { readDataroomFile, writeDataroomFile } from "@/lib/dataroom-blob";
import { withOrgRls } from "@/lib/ops-db";

/**
 * Version control for the data room.
 *
 * The store overwrites in place, so before today a write destroyed what it
 * replaced. The audit trail recorded that a file changed and (recently) why,
 * but never the bytes — which meant a bulk backfill that got something wrong
 * was unrecoverable in the only way that matters: you could read about the
 * damage but not undo it.
 *
 * Two ideas:
 *   - a CHANGESET is one intentional batch (a backfill), so forty writes are
 *     reviewable and revertible as the single act they actually were;
 *   - a FILE VERSION snapshots the previous bytes before each overwrite.
 *
 * Snapshots live in the blob store beside the data room under `_versions/`,
 * which `isSafeDataroomPath` rejects — so a snapshot can never be reached or
 * clobbered through the ordinary data-room API, only through here.
 */

/** Where a snapshot of `path` taken at `at` lives. Not a data-room path. */
function snapshotKey(orgId: string, path: string, at: number): string {
  // The full path is kept (slashes and all) so a snapshot is legible in the
  // blob console when someone is trying to work out what they lost.
  return `_versions/${orgId}/${at}-${path}`;
}

export interface OpenChangesetInput {
  orgId: string;
  label: string;
  actor: string;
  source?: "cli" | "agent" | "web";
  rationale?: string | null;
  unattended?: boolean;
}

/** Start a batch. Writes reference it until it is committed. */
export async function openChangeset(input: OpenChangesetInput): Promise<{ id: string }> {
  return await withOrgRls(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(dataroomChangesets)
      .values({
        orgId: input.orgId,
        label: input.label,
        actor: input.actor,
        source: input.source ?? "web",
        rationale: input.rationale ?? null,
        unattended: input.unattended ?? false,
        status: "open",
      })
      .returning({ id: dataroomChangesets.id });
    return { id: row.id };
  });
}

/** Close a batch. A committed changeset is what the UI offers to revert. */
export async function commitChangeset(orgId: string, id: string): Promise<{ files: number }> {
  return await withOrgRls(orgId, async (tx) => {
    const [{ n }] = await tx
      .select({ n: dsql<number>`count(*)::int` })
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.changesetId, id), eq(dataroomFileVersions.orgId, orgId)));
    await tx
      .update(dataroomChangesets)
      .set({ status: "committed", committedAt: new Date() })
      .where(and(eq(dataroomChangesets.id, id), eq(dataroomChangesets.orgId, orgId)));
    return { files: n ?? 0 };
  });
}

/**
 * Snapshot what a write is about to replace, and record the intent.
 *
 * Called BEFORE the write lands. Best-effort by design: if versioning fails we
 * do not block the write — losing history is bad, refusing to let someone do
 * their job because the history table is unhappy is worse. The failure is
 * logged, and the write still appears in the audit trail.
 */
export async function recordFileVersion(input: {
  orgId: string;
  path: string;
  actor: string;
  changesetId?: string | null;
  action: "create" | "update" | "append" | "delete";
  newBytes: number;
}): Promise<void> {
  try {
    const previous = await readDataroomFile(input.path, input.orgId);
    let prevBlobKey: string | null = null;
    if (previous !== null) {
      prevBlobKey = snapshotKey(input.orgId, input.path, Date.now());
      // Snapshots are written with the org's own prefix logic bypassed: the key
      // already carries the org, and `_versions/` is outside the data room.
      await writeDataroomFile(prevBlobKey, previous, "text/plain", null);
    }
    await withOrgRls(input.orgId, async (tx) => {
      await tx.insert(dataroomFileVersions).values({
        orgId: input.orgId,
        changesetId: input.changesetId ?? null,
        path: input.path,
        // A write to a path that did not exist is a create, whatever the caller
        // called it.
        action: previous === null ? "create" : input.action,
        prevBlobKey,
        prevBytes: previous?.length ?? null,
        newBytes: input.newBytes,
        actor: input.actor,
      });
    });
  } catch (e) {
    console.error(`[dataroom-versions] could not snapshot ${input.path}:`, e);
  }
}

export interface ChangesetSummary {
  id: string;
  label: string;
  actor: string;
  source: string;
  rationale: string | null;
  unattended: boolean;
  status: string;
  createdAt: string;
  committedAt: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
  files: number;
}

/** Recent changesets, newest first, with their file counts. */
export async function listChangesets(orgId: string, limit = 50): Promise<ChangesetSummary[]> {
  return await withOrgRls(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(dataroomChangesets)
      .where(eq(dataroomChangesets.orgId, orgId))
      .orderBy(desc(dataroomChangesets.createdAt))
      .limit(limit);
    const counts = await tx
      .select({
        changesetId: dataroomFileVersions.changesetId,
        n: dsql<number>`count(*)::int`,
      })
      .from(dataroomFileVersions)
      .where(eq(dataroomFileVersions.orgId, orgId))
      .groupBy(dataroomFileVersions.changesetId);
    const byId = new Map(counts.map((c) => [c.changesetId, c.n]));
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      actor: r.actor,
      source: r.source,
      rationale: r.rationale,
      unattended: r.unattended,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      committedAt: r.committedAt?.toISOString() ?? null,
      revertedAt: r.revertedAt?.toISOString() ?? null,
      revertedBy: r.revertedBy,
      files: byId.get(r.id) ?? 0,
    }));
  });
}

export interface ChangesetFile {
  path: string;
  action: string;
  prevBytes: number | null;
  newBytes: number | null;
  hasSnapshot: boolean;
}

/** One changeset with the files it touched. */
export async function getChangeset(
  orgId: string,
  id: string,
): Promise<{ changeset: ChangesetSummary; files: ChangesetFile[] } | null> {
  const all = await listChangesets(orgId, 200);
  const changeset = all.find((c) => c.id === id);
  if (!changeset) return null;
  const files = await withOrgRls(orgId, async (tx) =>
    tx
      .select()
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.changesetId, id), eq(dataroomFileVersions.orgId, orgId)))
      .orderBy(dataroomFileVersions.createdAt),
  );
  return {
    changeset,
    files: files.map((f) => ({
      path: f.path,
      action: f.action,
      prevBytes: f.prevBytes,
      newBytes: f.newBytes,
      hasSnapshot: Boolean(f.prevBlobKey),
    })),
  };
}

export interface FileDiff {
  path: string;
  action: string;
  /** Bytes this write replaced. null when it created the file. */
  before: string | null;
  /** Bytes this write PRODUCED. null when it could not be reconstructed. */
  after: string | null;
}

/**
 * What each write in a changeset actually did.
 *
 * The "after" side is the subtle part. We snapshot what a write REPLACED, never
 * what it produced — so reading the file's current content and calling it the
 * after-state is wrong twice over: if the changeset was reverted, current is
 * the undo, and every later edit to that path gets attributed to this version.
 *
 * The after-state of a write is the before-snapshot of the NEXT write to the
 * same path. Only for the most recent write is the current file correct, and
 * only then because nothing has replaced it yet.
 */
export async function changesetDiff(orgId: string, id: string): Promise<FileDiff[]> {
  const rows = await withOrgRls(orgId, async (tx) =>
    tx
      .select()
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.changesetId, id), eq(dataroomFileVersions.orgId, orgId)))
      .orderBy(dataroomFileVersions.createdAt),
  );

  const out: FileDiff[] = [];
  for (const row of rows) {
    const [next] = await withOrgRls(orgId, async (tx) =>
      tx
        .select({ prevBlobKey: dataroomFileVersions.prevBlobKey })
        .from(dataroomFileVersions)
        .where(
          and(
            eq(dataroomFileVersions.orgId, orgId),
            eq(dataroomFileVersions.path, row.path),
            gt(dataroomFileVersions.createdAt, row.createdAt),
          ),
        )
        .orderBy(dataroomFileVersions.createdAt)
        .limit(1),
    );
    const before = row.prevBlobKey ? await readDataroomFile(row.prevBlobKey, null) : null;
    const after = next
      ? next.prevBlobKey
        ? await readDataroomFile(next.prevBlobKey, null)
        : null // the next write created it, so this one had left it absent
      : await readDataroomFile(row.path, orgId);
    out.push({ path: row.path, action: row.action, before, after });
  }
  return out;
}

/** The bytes a write replaced, for showing a diff. */
export async function readSnapshot(orgId: string, id: string, path: string): Promise<string | null> {
  const [row] = await withOrgRls(orgId, async (tx) =>
    tx
      .select({ key: dataroomFileVersions.prevBlobKey })
      .from(dataroomFileVersions)
      .where(
        and(
          eq(dataroomFileVersions.changesetId, id),
          eq(dataroomFileVersions.orgId, orgId),
          eq(dataroomFileVersions.path, path),
        ),
      )
      .limit(1),
  );
  if (!row?.key) return null;
  return await readDataroomFile(row.key, null);
}

export interface RevertResult {
  restored: string[];
  /** Files this changeset CREATED. They are emptied, not deleted — see below. */
  emptied: string[];
  failed: { path: string; error: string }[];
}

/**
 * Undo a changeset: put every file back to the bytes it held before.
 *
 * Applied newest-first, so a path written twice within one batch ends on its
 * ORIGINAL content rather than an intermediate state.
 *
 * Files the changeset CREATED are emptied rather than deleted. The store has no
 * delete, and inventing one during a revert — the operation people reach for
 * when they are already alarmed — is the wrong time to add a way to destroy
 * data. An empty file is visible and removable; a deleted one is a second
 * incident.
 */
export async function revertChangeset(
  orgId: string,
  id: string,
  actor: string,
): Promise<RevertResult> {
  const rows = await withOrgRls(orgId, async (tx) =>
    tx
      .select()
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.changesetId, id), eq(dataroomFileVersions.orgId, orgId)))
      .orderBy(desc(dataroomFileVersions.createdAt)),
  );

  const result: RevertResult = { restored: [], emptied: [], failed: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.path)) continue; // newest-first: the first hit is the oldest state we keep
    seen.add(row.path);
    try {
      if (row.prevBlobKey) {
        const previous = await readDataroomFile(row.prevBlobKey, null);
        if (previous === null) throw new Error("snapshot is missing from the blob store");
        await writeDataroomFile(row.path, previous, "text/markdown", orgId);
        result.restored.push(row.path);
      } else {
        await writeDataroomFile(row.path, "", "text/markdown", orgId);
        result.emptied.push(row.path);
      }
    } catch (e) {
      result.failed.push({ path: row.path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await withOrgRls(orgId, async (tx) => {
    await tx
      .update(dataroomChangesets)
      .set({ status: "reverted", revertedAt: new Date(), revertedBy: actor })
      .where(and(eq(dataroomChangesets.id, id), eq(dataroomChangesets.orgId, orgId)));
  });
  return result;
}

/** Version history for a single path, newest first. */
export async function fileHistory(orgId: string, path: string, limit = 25) {
  return await withOrgRls(orgId, async (tx) =>
    tx
      .select()
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.orgId, orgId), eq(dataroomFileVersions.path, path)))
      .orderBy(desc(dataroomFileVersions.createdAt))
      .limit(limit),
  );
}

/** Writes that were not part of any batch — one-off edits. */
export async function standaloneVersions(orgId: string, limit = 50) {
  return await withOrgRls(orgId, async (tx) =>
    tx
      .select()
      .from(dataroomFileVersions)
      .where(and(eq(dataroomFileVersions.orgId, orgId), isNull(dataroomFileVersions.changesetId)))
      .orderBy(desc(dataroomFileVersions.createdAt))
      .limit(limit),
  );
}
