/**
 * NOTES TO A RUNNING SPECIALIST — the inbox, and the specialist's read of it (mold_v1-235).
 *
 * `specialist_steering_notes` (agent/lib/db/schema.ts has the why). The session guard writes a note through
 * `POST /eve/v1/session/<main thread>/steer` (agent/lib/session-guard.ts); the specialist reads its notes at the start
 * of each step through the reader registered here, which the eve patch calls (harness/steering-notes.js). A read
 * marks the notes delivered to THAT step, so a retried step reads the same notes again and a later step none of them.
 *
 * tenancy-ok: every statement runs inside `inOrg(orgId, …)` and names the workspace. The reader's workspace is the
 * main thread's recorded scope (`inheritedScope`), never the caller's guess.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { GateDb } from "../../lib/session-gate.ts";
import { noteForModel, type SteeringNote } from "../../lib/steering-client.ts";

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] } | null)?.rows ?? [])) as Array<Record<string, unknown>>;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

/** A note as stored, for the delegation it was sent to. */
export interface NewNote {
  readonly parentSessionId: string;
  readonly callId: string;
  readonly childSessionId: string | null;
  readonly authorEmail: string | null;
  readonly text: string;
}

/** A note the specialist reads. */
export interface DueNote {
  readonly id: string;
  readonly authorEmail: string | null;
  readonly text: string;
}

export interface SteeringLedger {
  add(note: NewNote): Promise<SteeringNote>;
  /** The main thread's notes, oldest first. */
  list(parentSessionId: string): Promise<SteeringNote[]>;
  /** Mark the delegation's pending notes (and any already given to `step`) delivered to `step`; return them, oldest first. */
  take(parentSessionId: string, callId: string, step: string): Promise<DueNote[]>;
}

const toNote = (r: Record<string, unknown>): SteeringNote => ({
  id: String(r.id),
  callId: String(r.call_id),
  text: String(r.text),
  status: r.status === "delivered" ? "delivered" : "pending",
  createdAt: iso(r.created_at),
  deliveredAt: iso(r.delivered_at),
});

export function steeringLedger(db: Pick<GateDb, "inOrg">, orgId: string, newId: () => string = randomUUID): SteeringLedger {
  return {
    async add(note) {
      const [row] = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            insert into specialist_steering_notes (id, org_id, parent_session_id, call_id, child_session_id, author_email, text, status)
            values (${newId()}, ${orgId}, ${note.parentSessionId}, ${note.callId}, ${note.childSessionId}, ${note.authorEmail}, ${note.text}, 'pending')
            returning id, call_id, text, status, created_at, delivered_at`),
        ),
      );
      if (!row) throw new Error("steering note not written");
      return toNote(row);
    },
    async list(parentSessionId) {
      const rows = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            select id, call_id, text, status, created_at, delivered_at from specialist_steering_notes
            where org_id = ${orgId} and parent_session_id = ${parentSessionId}
            order by created_at asc, id asc limit 200`),
        ),
      );
      return rows.map(toNote);
    },
    async take(parentSessionId, callId, step) {
      const rows = rowsOf(
        await db.inOrg(orgId, (tx) =>
          tx.execute(sql`
            update specialist_steering_notes
               set status = 'delivered', delivered_step = ${step}, delivered_at = coalesce(delivered_at, now())
             where org_id = ${orgId} and parent_session_id = ${parentSessionId} and call_id = ${callId}
               and (status = 'pending' or delivered_step = ${step})
            returning id, author_email, text, created_at`),
        ),
      );
      return rows
        .sort((a, b) => String(iso(a.created_at)).localeCompare(String(iso(b.created_at))) || String(a.id).localeCompare(String(b.id)))
        .map((r) => ({ id: String(r.id), authorEmail: typeof r.author_email === "string" ? r.author_email : null, text: String(r.text) }));
    },
  };
}

/** What the reader needs from the world (injected by the tests). */
export interface ReaderDeps {
  readonly db: () => Pick<GateDb, "inOrg"> | null;
  /** The workspace the delegation's main thread is recorded in, or null. */
  readonly scopeOf: (parent: { sessionId: string; rootSessionId?: string }) => Promise<{ orgId: string } | null>;
}

/** The input the eve patch hands the reader. */
export interface ReaderInput {
  readonly sessionId?: unknown;
  readonly parent?: { readonly sessionId?: unknown; readonly callId?: unknown; readonly rootSessionId?: unknown } | null;
  readonly turnId?: unknown;
  readonly stepIndex?: unknown;
}

/**
 * The notes due at this step of a delegated session, as the eve patch appends them. Never throws: a failure delivers
 * nothing (the notes stay pending for a later step) and the step goes on.
 */
export async function readSteeringNotes(input: ReaderInput, deps: ReaderDeps): Promise<{ id: string; text: string }[]> {
  try {
    const parent = input.parent;
    const parentSessionId = typeof parent?.sessionId === "string" ? parent.sessionId : "";
    const callId = typeof parent?.callId === "string" ? parent.callId : "";
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    if (!parentSessionId || !callId || !sessionId) return [];
    const db = deps.db();
    if (!db) return [];
    const rootSessionId = typeof parent?.rootSessionId === "string" && parent.rootSessionId ? parent.rootSessionId : undefined;
    const scope = await deps.scopeOf({ sessionId: parentSessionId, ...(rootSessionId ? { rootSessionId } : {}) });
    if (!scope) return [];
    const step = `${sessionId}:${String(input.turnId ?? "")}:${String(input.stepIndex ?? "")}`;
    const due = await steeringLedger(db, scope.orgId).take(parentSessionId, callId, step);
    return due.map((n) => ({ id: n.id, text: noteForModel(n.authorEmail, n.text) }));
  } catch (error) {
    console.error("[steering] could not read a specialist's notes; its step goes on without them", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Where the eve patch looks for the reader (harness/steering-notes.js). */
export const STEERING_READER = Symbol.for("eve.app.steeringNotes");

/** Register the reader for this process. Idempotent. */
export function registerSteeringReader(deps: ReaderDeps): void {
  (globalThis as Record<symbol, unknown>)[STEERING_READER] = (input: ReaderInput) => readSteeringNotes(input, deps);
}
