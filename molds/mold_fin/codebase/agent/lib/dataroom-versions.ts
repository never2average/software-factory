/**
 * Agent-side twin of `lib/dataroom-versions.ts` — data-room version control on
 * the AGENT's write path. (agent/lib can't import from the Next front-end's
 * lib/: the bundler and the agent runtime resolve modules differently, hence the
 * duplicate; keep the two in lockstep.)
 *
 * The front-end twin covers writes that arrive over the Ops API (the console,
 * the CLI/MCP). The agent writes through `dataroom-store.ts` instead, so until
 * this module existed an agent-driven backfill — the case that touches the most
 * files at once — overwrote in place with nothing kept and no way back.
 *
 * Two ideas, same as the twin:
 *   - a CHANGESET is one intentional batch, so forty writes are reviewable and
 *     revertible as the single act they actually were;
 *   - a FILE VERSION snapshots the previous bytes before each overwrite.
 *
 * Snapshots live under `_versions/`, which fails both `isSafeDataroomPath`
 * (front end) and DATAROOM_PATH_TEMPLATES (here) — so a snapshot can never be
 * reached or clobbered through the ordinary data-room API, only through these
 * modules. They are written at the SAME physical blob key the front end uses
 * (`dataroom/_versions/…`, org in the key rather than the prefix), because the
 * review and revert UI is front-end-only and has to find them.
 *
 * APPENDS ARE NOT VERSIONED HERE. The agent's `.jsonl` appends are true appends
 * (immutable parts beside the base object), so they destroy nothing — and the
 * revert path writes a base object, which cannot retract parts. Recording them
 * would promise an undo the store cannot deliver.
 */
import { and, eq, sql as dsql } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { dataroomChangesets, dataroomFileVersions } from "./db/schema.ts";
import { getDataroomStore, validateDataroomPath } from "./dataroom-store.ts";

/** Where a snapshot of `path` taken at `at` lives. Not a data-room path. */
function snapshotKey(orgId: string, path: string, at: number): string {
  // The full path is kept (slashes and all) so a snapshot is legible in the
  // blob console when someone is trying to work out what they lost.
  return `_versions/${orgId}/${at}-${path}`;
}

/**
 * The backend addressing the BASE key space (blob `dataroom/…`, local
 * `.dataroom/`) rather than a workspace sub-prefix — snapshot keys already carry
 * their org, and the front end reads them from there.
 */
function snapshotBackend() {
  return getDataroomStore(null).backend;
}

/**
 * False when there is no Postgres to index versions into. Callers use it to say
 * so plainly instead of opening a changeset that cannot exist.
 */
export function versioningAvailable(): boolean {
  return getDb() !== null;
}

export interface OpenChangesetInput {
  orgId: string;
  label: string;
  actor: string;
  rationale?: string | null;
}

/** Start a batch. Writes reference it until it is committed. */
export async function openChangeset(input: OpenChangesetInput): Promise<{ id: string }> {
  return await withOrgDb(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(dataroomChangesets)
      .values({
        orgId: input.orgId,
        label: input.label,
        actor: input.actor,
        source: "agent",
        rationale: input.rationale ?? null,
        // A tool call the model made on its own is exactly what "unattended"
        // means to the reviewer; the write tools carry their own approval gate.
        unattended: true,
        status: "open",
      })
      .returning({ id: dataroomChangesets.id });
    return { id: row.id };
  });
}

/** Close a batch. A committed changeset is what the UI offers to revert. */
export async function commitChangeset(orgId: string, id: string): Promise<{ files: number }> {
  return await withOrgDb(orgId, async (tx) => {
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
  // Without the tables nothing would ever index the snapshot, so don't take one.
  if (!versioningAvailable()) return;
  try {
    const previous = await getDataroomStore(input.orgId).read(input.path);
    let prevBlobKey: string | null = null;
    if (previous !== null) {
      prevBlobKey = snapshotKey(input.orgId, input.path, Date.now());
      await snapshotBackend().write(prevBlobKey, previous);
    }
    await withOrgDb(input.orgId, async (tx) => {
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
  } catch (error) {
    console.error(`[dataroom-versions] could not snapshot ${input.path}:`, error);
  }
}

/**
 * The write every agent overwrite should go through: keep the previous bytes,
 * then replace the file. Path validation happens first so a rejected path never
 * produces a phantom version row.
 */
export async function writeVersioned(input: {
  orgId: string;
  path: string;
  content: string;
  actor: string;
  changesetId?: string | null;
}): Promise<void> {
  validateDataroomPath(input.path);
  await recordFileVersion({
    orgId: input.orgId,
    path: input.path,
    actor: input.actor,
    changesetId: input.changesetId,
    action: "update",
    newBytes: input.content.length,
  });
  await getDataroomStore(input.orgId).write(input.path, input.content);
}
