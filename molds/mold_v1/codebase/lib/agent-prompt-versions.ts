import { and, asc, desc, eq } from "drizzle-orm";
import { agentConfigs, agentPromptVersions } from "@/agent/lib/db/schema";
import type { getOpsDb } from "@/lib/ops-db";
import { withOrgRls } from "@/lib/ops-db";

type Db = NonNullable<ReturnType<typeof getOpsDb>>;

export interface PromptVersion {
  id: string;
  instructions: string | null;
  actor: string;
  kind: string;
  restoredFrom: string | null;
  createdAt: string;
  /** The text this version replaced — the previous row, or null for the first. */
  before: string | null;
}

/**
 * Whether the history table exists.
 *
 * The migration is run by hand, so the code ships before the table does. Every
 * entry point here treats "no table" as "no history" rather than an error: the
 * Agents tab must keep working, and a prompt edit must never fail because its
 * audit trail is unavailable.
 *
 * tenancy-ok: the probe below is the one statement in this file on an unscoped
 * handle, and it reads no tenant DATA — it discards the row and keeps only
 * "did that parse and execute". Under the fail-closed policy it returns zero
 * rows WITHOUT erroring, which is still the right answer to the only question
 * it asks; a missing table throws, which is the other one. Every real read and
 * write here runs inside `withOrgRls(orgId, …)`. This surface was widened from
 * `app/api` to `app lib`, and the file surfaced then rather than because
 * anything about it changed.
 */
let tableKnownReady = false;
async function tableReady(db: Db): Promise<boolean> {
  // Memoised: a table that exists cannot stop existing, and this probe was
  // costing a round trip on EVERY prompt save — the cheapest of the queries I
  // added, and the most pointless.
  if (tableKnownReady) return true;
  try {
    await db.select({ id: agentPromptVersions.id }).from(agentPromptVersions).limit(1);
    tableKnownReady = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a person's edits to one prompt count as the same sitting.
 *
 * The editor commits on idle, so without this every ~second of typing became
 * its own version and the history read as a keystroke log — dozens of entries
 * for one thought, each diff a few characters wide, and the actual before/after
 * of the change buried across all of them. Inside the window the newest version
 * is rewritten in place, so a session collapses to the state it ended in.
 */
const SESSION_MS = 5 * 60 * 1000;

/**
 * Record the state an agent's prompt is now in.
 *
 * Appends a version, EXCEPT while the same person is still mid-session on the
 * same prompt — then the newest version is rewritten in place, so one sitting
 * yields one version instead of one per idle pause. See SESSION_MS.
 *
 * `seedPrevious` covers the very first edit after the migration: without a row
 * for the text that was already live, the first diff would compare the new
 * prompt against nothing and the previously-live prompt would never appear in
 * the history at all. It is written only when the history for this agent is
 * genuinely empty, so it cannot duplicate the migration's own seeding.
 */
export async function recordPromptVersion(
  db: Db,
  input: {
    orgId: string;
    agentKey: string;
    instructions: string | null;
    actor: string;
    seedPrevious?: string | null;
    kind?: "edit" | "restore";
    restoredFrom?: string | null;
  },
): Promise<void> {
  if (!(await tableReady(db))) return;
  try {
    /**
     * Never record a version identical to the one already on top.
     *
     * This guard used to live in the PUT route, which meant it protected
     * exactly one caller: anything else appending a version could write a row
     * whose diff is empty, and a history full of "changed nothing" entries is
     * worse than no history — it buries the edits that matter. The invariant
     * belongs to whatever owns the table.
     */
    const [latest] = await withOrgRls(input.orgId, (tx) =>
      tx
      .select({
        id: agentPromptVersions.id,
        instructions: agentPromptVersions.instructions,
        actor: agentPromptVersions.actor,
        kind: agentPromptVersions.kind,
        createdAt: agentPromptVersions.createdAt,
      })
      .from(agentPromptVersions)
      .where(
        and(
          eq(agentPromptVersions.orgId, input.orgId),
          eq(agentPromptVersions.agentKey, input.agentKey),
        ),
      )
      .orderBy(desc(agentPromptVersions.createdAt))
      .limit(1),
    );
    // A restore is deliberate provenance ("someone put this back"), so it is
    // recorded even when the text is unchanged; an edit is not.
    if (latest && (latest.instructions ?? null) === (input.instructions ?? null) && input.kind !== "restore") {
      return;
    }

    /**
     * Same person, same prompt, still the same sitting → rewrite the top
     * version rather than stacking another one.
     *
     * A restore never coalesces, in either direction: it is a distinct act, and
     * folding it into a neighbouring edit would lose the fact that someone
     * reached back for an old prompt.
     */
    const coalesce =
      latest !== undefined &&
      input.kind !== "restore" &&
      latest.kind !== "restore" &&
      latest.actor === input.actor &&
      Date.now() - latest.createdAt.getTime() < SESSION_MS;

    if (coalesce) {
      await withOrgRls(input.orgId, (tx) =>
        tx
          .update(agentPromptVersions)
          .set({ instructions: input.instructions, createdAt: new Date() })
          .where(eq(agentPromptVersions.id, latest.id)),
      );
      return;
    }

    if (input.seedPrevious && latest === undefined) {
      await withOrgRls(input.orgId, (tx) =>
        tx.insert(agentPromptVersions).values({
        orgId: input.orgId,
        agentKey: input.agentKey,
        instructions: input.seedPrevious,
        actor: "unknown",
        kind: "edit",
      }),
      );
    }
    await withOrgRls(input.orgId, (tx) =>
      tx.insert(agentPromptVersions).values({
      orgId: input.orgId,
      agentKey: input.agentKey,
      instructions: input.instructions,
      actor: input.actor,
      kind: input.kind ?? "edit",
      restoredFrom: input.restoredFrom ?? null,
    }),
    );
  } catch {
    /* history is an audit trail, never a gate on the edit itself */
  }
}

/**
 * One agent's prompt history, newest first, each version carrying the text it
 * replaced so the caller can render a diff without a second request.
 */
export async function listPromptVersions(
  db: Db,
  orgId: string,
  agentKey: string,
  limit = 50,
): Promise<PromptVersion[]> {
  if (!(await tableReady(db))) return [];
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(agentPromptVersions)
      .where(and(eq(agentPromptVersions.orgId, orgId), eq(agentPromptVersions.agentKey, agentKey)))
      .orderBy(asc(agentPromptVersions.createdAt))
      .limit(limit),
  );

  // Ascending for the pairing, then reversed — the before-state of a version is
  // the one immediately preceding it in time.
  return rows
    .map((r, i) => ({
      id: r.id,
      instructions: r.instructions,
      actor: r.actor,
      kind: r.kind,
      restoredFrom: r.restoredFrom,
      createdAt: r.createdAt.toISOString(),
      before: i === 0 ? null : (rows[i - 1].instructions ?? null),
    }))
    .reverse();
}

/**
 * Put an old version back.
 *
 * Recorded as a new version rather than by rewinding: the history is
 * append-only, so restoring is itself an edit someone made, and naming the
 * version it came from keeps that legible.
 */
export async function restorePromptVersion(
  db: Db,
  orgId: string,
  agentKey: string,
  versionId: string,
  actor: string,
): Promise<{ instructions: string | null } | null> {
  if (!(await tableReady(db))) return null;
  const [target] = await withOrgRls(orgId, (tx) =>
    tx
    .select()
    .from(agentPromptVersions)
    .where(
      and(
        eq(agentPromptVersions.id, versionId),
        eq(agentPromptVersions.orgId, orgId),
        eq(agentPromptVersions.agentKey, agentKey),
      ),
    )
    .limit(1),
  );
  if (!target) return null;

  const set = { instructions: target.instructions, updatedBy: actor, updatedAt: new Date() };
  await withOrgRls(orgId, (tx) =>
    tx
      .insert(agentConfigs)
      .values({ orgId, agentKey, ...set })
      .onConflictDoUpdate({ target: [agentConfigs.orgId, agentConfigs.agentKey], set }),
  );

  // Through the same recorder, so the table has exactly one writer and one set
  // of rules about what may be appended.
  await recordPromptVersion(db, {
    orgId,
    agentKey,
    instructions: target.instructions,
    actor,
    kind: "restore",
    restoredFrom: target.id,
  });
  return { instructions: target.instructions };
}

/** Most recent version id per agent, for the "N versions" hint on the list. */
export async function promptVersionCounts(db: Db, orgId: string): Promise<Record<string, number>> {
  if (!(await tableReady(db))) return {};
  const rows = await db
    .select({ agentKey: agentPromptVersions.agentKey })
    .from(agentPromptVersions)
    .where(eq(agentPromptVersions.orgId, orgId))
    .orderBy(desc(agentPromptVersions.createdAt));
  const out: Record<string, number> = {};
  for (const r of rows) out[r.agentKey] = (out[r.agentKey] ?? 0) + 1;
  return out;
}
