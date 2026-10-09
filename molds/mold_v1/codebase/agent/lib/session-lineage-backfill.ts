/**
 * LINEAGE FOR CHILDREN DELEGATED BEFORE IT WAS RECORDED (mold_v1-133).
 *
 * Since #66 the session guard records a delegated child's owner (its parent's) as the parent's `subagent.called` line
 * passes through the stream it serves (agent/lib/session-lineage-stream.ts). A child announced BEFORE that — or on a
 * part of the parent's stream nobody has read through the guard since, because the chat reopens from its transcript
 * cache and streams only what is new — has no owner on record, so the gate refuses it to everyone, its own owner
 * included (404 on the child's stream in the Control Panel) until someone replays the parent from index 0.
 *
 * Two ways to close that, both reading the PARENT's own history from eve and never anything a client wrote:
 *
 *   · LAZILY, in the guard: when a caller is admitted to a session's stream from a later index, the part they skip is
 *     read server-side — bounded, resumed from where this process last stopped — and every child it names is
 *     recorded (agent/lib/session-guard.ts). A child asked for before that read finishes (or on another instance)
 *     is recovered on its own request: its parent is found (a running read, or the caller's transcript cache as a
 *     hint), checked against the gate and eve's own history, and read once. This also covers future gaps.
 *   · ONCE, at deploy: scripts/backfill-session-lineage.mjs replays every owned root from index 0 through the agent's
 *     own guarded stream route, as that session's owner (a two-minute, read-only token bound to the one session), so
 *     the guard's live path records the children exactly as it would for the owner's own browser — and then each
 *     child it finds, so grandchildren are reached too. A pre-#66 chat with no owner record gets one on its replay
 *     (the guard's legacy rule, from the chat list), after which the cached-transcript and fast-replay routes serve
 *     it (lib/session-gate.ts readTranscriptAccess). Idempotent.
 *
 * Either way a child only ever INHERITS its parent's recorded ownership (lib/session-gate.ts via
 * agent/lib/session-owners.ts recordChildSession): nobody is granted a child they could not already read the parent of.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { agentSessionOwners, chatSessions, chatTranscriptSnapshots } from "./db/schema.ts";
import type { GateDb } from "../../lib/session-gate.ts";
import type { SystemGateDb } from "./session-owner-backfill.ts";

type Event = { type?: unknown; data?: { childSessionId?: unknown } | null } | null | undefined;

/** The child session a `subagent.called` event announces, or null. Accepts an event object or one NDJSON line. */
export function childOf(event: Event | string): string | null {
  let value: Event;
  if (typeof event === "string") {
    if (!event.includes("subagent.called")) return null;
    try {
      value = JSON.parse(event) as Event;
    } catch {
      return null;
    }
  } else value = event;
  const child = value?.type === "subagent.called" ? value.data?.childSessionId : undefined;
  return typeof child === "string" && child ? child : null;
}

export interface ScanResult {
  /** Children announced in the part read, in order, de-duplicated. */
  readonly children: string[];
  /** How many events were read (the absolute index reached, the scan starting at 0). */
  readonly reached: number;
  /** True when the scan read everything it was asked for (`until` reached, or the stream ended). */
  readonly complete: boolean;
  /**
   * Why it stopped: `until` (read what was asked), `end` (the stream closed), `idle` (a live tail went quiet: caught
   * up), `deadline` (still reading when time ran out — there may be more), `error` (eve could not be read).
   */
  readonly stop: "until" | "end" | "idle" | "deadline" | "error";
}

/**
 * Read a session's events from index 0 and collect the children they announce.
 *
 * eve's stream is a live tail that never ends for a parked run, so the read is bounded three ways: it stops at
 * `until` events (the index a caller is about to start from — everything before it exists already), when no event
 * arrives for `idleMs`, and after `totalMs` overall.
 */
export async function scanForChildren(
  open: () => Promise<ReadableStream<unknown>>,
  opts: { until?: number; idleMs?: number; totalMs?: number; stopAt?: string } = {},
): Promise<ScanResult> {
  const until = opts.until !== undefined && opts.until > 0 ? opts.until : Number.POSITIVE_INFINITY;
  const idleMs = opts.idleMs ?? 750;
  const deadline = Date.now() + (opts.totalMs ?? 4_000);
  const children: string[] = [];
  const seen = new Set<string>();
  let reached = 0;
  let complete = false;
  let stop: ScanResult["stop"] = "deadline";
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  const timeout = (ms: number) =>
    new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), Math.max(0, ms));
      (t as { unref?: () => void }).unref?.();
    });
  try {
    const stream = await Promise.race([open(), timeout(Math.min(idleMs * 4, deadline - Date.now()))]);
    if (stream === "timeout") return { children, reached, complete, stop: "error" };
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    const take = (event: Event | string) => {
      reached++;
      const child = childOf(event);
      if (child && !seen.has(child)) {
        seen.add(child);
        children.push(child);
      }
    };
    while (reached < until && !(opts.stopAt && seen.has(opts.stopAt))) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([reader.read(), timeout(Math.min(idleMs, left))]);
      if (next === "timeout") {
        // Quiet for idleMs (a live tail caught up), unless it was the deadline that cut the wait short.
        if (idleMs <= left) stop = "idle";
        break;
      }
      if (next.done) {
        if (partial.trim()) take(partial);
        complete = true;
        stop = "end";
        break;
      }
      const value = next.value;
      if (value instanceof Uint8Array) {
        // The HTTP form: NDJSON bytes.
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim() && reached < until) take(line);
      } else if (typeof value === "string") {
        for (const line of value.split("\n")) if (line.trim() && reached < until) take(line);
      } else {
        take(value as Event);
      }
    }
    if (reached >= until || (opts.stopAt && seen.has(opts.stopAt))) {
      complete = true;
      stop = "until";
    }
  } catch {
    // A parent eve cannot read has nothing to add; the caller simply learns nothing new.
    stop = "error";
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
  return { children, reached, complete, stop };
}

/**
 * Sessions whose cached transcript names `childId` as a delegated child, in the given workspaces (each read inside
 * its own RLS scope). A HINT for the guard's recovery path only: the rows are written by browsers, so every candidate
 * is then checked against the gate (may this caller read it?) and against eve's own history of it (does it really
 * name the child?) before anything is recorded (agent/lib/session-guard.ts recoverChildLineage).
 */
export async function candidateParents(db: Pick<GateDb, "inOrg">, orgIds: readonly string[], childId: string): Promise<string[]> {
  if (!childId || /["\\]/.test(childId)) return [];
  const needle = `%${childId.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const out = new Set<string>();
  for (const orgId of orgIds) {
    const rows = await db.inOrg(orgId, (tx) =>
      tx
        .select({ sessionId: chatTranscriptSnapshots.eveSessionId })
        .from(chatTranscriptSnapshots)
        .where(and(eq(chatTranscriptSnapshots.orgId, orgId), sql`${chatTranscriptSnapshots.events}::text like ${needle}`))
        .limit(5),
    );
    for (const r of rows) if (r.sessionId && r.sessionId !== childId) out.add(r.sessionId);
    if (out.size >= 5) break;
  }
  return [...out];
}

/** A session whose children the one-time backfill replays: an owned root, and the person it belongs to. */
export interface LineageParent {
  readonly orgId: string;
  readonly sessionId: string;
  readonly ownerEmail: string;
}

/**
 * Every session the deploy-time backfill should replay, per workspace (each read inside that workspace's RLS scope):
 * roots with a PERSON owner on record, then chats the list mirrors whose owner is not recorded yet (the guard infers
 * and freezes those on the first read — in the replaying token's workspace only, lib/session-gate.ts
 * readLegacyOwnershipIn — and refuses them if the evidence is ambiguous or unanchored, so a replay can never crown the
 * wrong owner; run scripts/backfill-session-owners.mjs FIRST so the unanchored ones have records). Service-run steps
 * are not listed: their children are named in workflow_run_journal, which the gate already reads.
 *
 * SYSTEM PATH (a deploy-time script): with no `orgIds` it enumerates every workspace, which is why it takes a
 * `SystemGateDb`. No request path may call it (npm run check:tenancy).
 */
export async function listLineageParents(db: SystemGateDb, orgIds?: readonly string[]): Promise<LineageParent[]> {
  const out: LineageParent[] = [];
  const seen = new Set<string>();
  for (const orgId of orgIds ?? (await db.listOrgs())) {
    const rows = await db.inOrg(orgId, async (tx) => {
      const roots = await tx
        .select({ sessionId: agentSessionOwners.sessionId, ownerEmail: agentSessionOwners.ownerEmail })
        .from(agentSessionOwners)
        .where(
          and(
            eq(agentSessionOwners.orgId, orgId),
            isNull(agentSessionOwners.parentSessionId),
            isNotNull(agentSessionOwners.ownerEmail),
          ),
        );
      const mirrored = await tx
        .select({ sessionId: chatSessions.eveSessionId, ownerEmail: chatSessions.ownerEmail })
        .from(chatSessions)
        .where(and(eq(chatSessions.orgId, orgId), isNotNull(chatSessions.eveSessionId)));
      return [...roots, ...mirrored];
    });
    for (const row of rows) {
      const email = row.ownerEmail?.trim().toLowerCase();
      if (!row.sessionId || !email || seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      out.push({ orgId, sessionId: row.sessionId, ownerEmail: email });
    }
  }
  return out;
}

export interface BackfillOutcome {
  readonly parents: number;
  readonly replayed: number;
  readonly refused: number;
  readonly failed: number;
  readonly children: number;
}

/**
 * Replay each parent through `replay` (which must go through the agent's guarded stream route — that is what records
 * the children) and count what it announced. `concurrency` parents at a time. Never throws for one parent.
 */
export async function backfillLineage(
  parents: readonly LineageParent[],
  replay: (parent: LineageParent) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>,
  opts: { concurrency?: number; idleMs?: number; totalMs?: number; log?: (line: string) => void } = {},
): Promise<BackfillOutcome> {
  let replayed = 0;
  let refused = 0;
  let failed = 0;
  let children = 0;
  const queue = [...parents];
  // Children are replayed in turn, as their root's owner: a grandchild delegated before #66 is announced only on its
  // parent CHILD's stream, which no root replay passes through.
  const queued = new Set(parents.map((p) => p.sessionId));
  let active = 0;
  const worker = async () => {
    for (;;) {
      const parent = queue.shift();
      if (!parent) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 10)); // another worker may still add children
        continue;
      }
      active++;
      try {
        const res = await replay(parent);
        if (res.status === 404 || res.status === 401) {
          refused++;
          opts.log?.(`refused ${parent.sessionId} (${res.status}) — no recorded or unambiguous owner; left as is`);
          await res.body?.cancel().catch(() => undefined);
          continue;
        }
        if (res.status >= 300 || !res.body) {
          failed++;
          opts.log?.(`failed ${parent.sessionId} (${res.status})`);
          await res.body?.cancel().catch(() => undefined);
          continue;
        }
        const body = res.body;
        const scan = await scanForChildren(async () => body as ReadableStream<unknown>, {
          idleMs: opts.idleMs,
          totalMs: opts.totalMs ?? 30_000,
        });
        replayed++;
        children += scan.children.length;
        if (scan.children.length) opts.log?.(`${parent.sessionId}: ${scan.children.length} delegated child session(s)`);
        for (const child of scan.children) {
          if (queued.has(child)) continue;
          queued.add(child);
          queue.push({ orgId: parent.orgId, sessionId: child, ownerEmail: parent.ownerEmail });
        }
      } catch (error) {
        failed++;
        opts.log?.(`failed ${parent.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        active--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return { parents: parents.length, replayed, refused, failed, children };
}
