/**
 * THE CHAT LIST MIRROR (`chat_sessions`) — read and written here, so the route
 * (app/api/ops/chat-sessions/route.ts) and the database test
 * (scripts/test-chat-sessions-mirror-db.mjs) run the SAME code.
 *
 * Three rules, each from a review of #59:
 *
 *  1. ONE ROW, ONE OWNER — FOR GOOD. The upsert conflicts on `id` (the eve
 *     session id), but ownership used to be checked only on `eveSessionId`: a
 *     colleague in the same workspace who knew a session id (they appear in
 *     `?chatSession=` links) could POST `{ id: <that id> }` with no
 *     `eveSessionId` and the upsert rewrote the row's owner, nulled its eve
 *     session and merged in their markers. Now a row that exists under another
 *     owner is refused whatever fields are sent, the update itself is guarded
 *     (`setWhere owner = me`, so a race cannot slip past the check), and an
 *     upsert never changes `ownerEmail` or an existing `eveSessionId`.
 *  2. ONE CHAT'S MARKERS NEVER BREAK THE BATCH. A size limit inside the batch
 *     schema rejected the WHOLE sync (400) for one chat with many answers, and
 *     titles, archive state and new chats then stopped syncing everywhere.
 *     Markers are now trimmed per chat (`capMarkers`), never refused.
 *  3. EITHER DEPLOY ORDER IS SAFE. `client_markers` arrives with migration 0020;
 *     code that names a missing column fails every query (500, and the sidebar
 *     stops syncing). The column is looked up once (re-checked every minute
 *     while absent), and the reads and writes name it only if it is there.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { chatSessions, chatThreads } from "../agent/lib/db/schema.ts";
import { capMarkers, MARKERS_MAX_BYTES_SERVER } from "./chat-turn-state.ts";

/**
 * `chat_sessions` as it is BEFORE migration 0020 — every column but
 * `client_markers`. drizzle names every column of a table in an insert, so
 * writing through `chatSessions` while the column is absent fails the whole
 * statement; this shape is what the write uses until the column exists.
 * Keep it in step with `chatSessions` in agent/lib/db/schema.ts (the database
 * test writes through both).
 */
const chatSessionsBefore0020 = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  ownerEmail: text("owner_email").notNull(),
  clientKey: text("client_key"),
  title: text("title"),
  preview: text("preview"),
  messageCount: integer("message_count"),
  customers: jsonb("customers").$type<string[]>(),
  forkedFrom: jsonb("forked_from").$type<{ id: string; title: string }>(),
  eveSessionId: text("eve_session_id"),
  continuationToken: text("continuation_token"),
  derivedCustomers: jsonb("derived_customers").$type<string[]>(),
  toolCounts: jsonb("tool_counts").$type<{ artifacts: number; emails: number }>(),
  archived: boolean("archived").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
/** Runs `fn` inside the caller's workspace (RLS) scope. */
export type InOrg = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface MirrorRowInput {
  readonly id: string;
  readonly clientKey?: string | null;
  readonly title?: string | null;
  readonly preview?: string | null;
  readonly messageCount?: number | null;
  readonly customers?: string[] | null;
  readonly forkedFrom?: { id: string; title: string } | null;
  readonly eveSessionId?: string | null;
  readonly continuationToken?: string | null;
  readonly derivedCustomers?: string[] | null;
  readonly toolCounts?: { artifacts: number; emails: number } | null;
  readonly clientMarkers?: readonly unknown[] | null;
  readonly archived?: boolean;
  readonly updatedAt?: number;
}

let markersColumn: { readonly present: boolean; readonly checkedAt: number } | null = null;
/** For tests: forget what was learned about the column. */
export function resetMarkersColumnCache(): void {
  markersColumn = null;
}
const rowCount = (r: unknown): number =>
  Array.isArray(r) ? r.length : ((r as { rows?: unknown[] } | null)?.rows?.length ?? 0);

/** Does `chat_sessions.client_markers` exist yet? Asked once; an absence is re-checked each minute. */
export async function hasMarkersColumn(inOrg: InOrg): Promise<boolean> {
  if (markersColumn && (markersColumn.present || Date.now() - markersColumn.checkedAt < 60_000)) {
    return markersColumn.present;
  }
  let present = false;
  try {
    present =
      rowCount(
        await inOrg((tx) =>
          tx.execute(
            sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_sessions' and column_name = 'client_markers'`,
          ),
        ),
      ) > 0;
  } catch {
    present = false;
  }
  markersColumn = { present, checkedAt: Date.now() };
  return present;
}

/** Every column the list needs, named — never `select *` (see rule 3). */
function listColumns(withMarkers: boolean) {
  return {
    id: chatSessions.id,
    clientKey: chatSessions.clientKey,
    title: chatSessions.title,
    preview: chatSessions.preview,
    messageCount: chatSessions.messageCount,
    customers: chatSessions.customers,
    forkedFrom: chatSessions.forkedFrom,
    eveSessionId: chatSessions.eveSessionId,
    continuationToken: chatSessions.continuationToken,
    derivedCustomers: chatSessions.derivedCustomers,
    toolCounts: chatSessions.toolCounts,
    archived: chatSessions.archived,
    updatedAt: chatSessions.updatedAt,
    ...(withMarkers ? { clientMarkers: chatSessions.clientMarkers } : {}),
  };
}

/** The caller's live chats in this workspace, newest first. */
export async function readMirrorRows(
  inOrg: InOrg,
  input: { readonly orgId: string; readonly email: string },
): Promise<Array<Record<string, unknown> & { id: string; eveSessionId: string | null; clientKey: string | null }>> {
  const withMarkers = await hasMarkersColumn(inOrg);
  return inOrg((tx) =>
    tx
      .select(listColumns(withMarkers))
      .from(chatSessions)
      .where(
        and(eq(chatSessions.ownerEmail, input.email), eq(chatSessions.orgId, input.orgId), eq(chatSessions.archived, false)),
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(200),
  );
}

/** Write the caller's chat list. Returns how many rows were refused as somebody else's. */
export async function writeMirrorRows(
  inOrg: InOrg,
  input: { readonly orgId: string; readonly email: string; readonly sessions: readonly MirrorRowInput[] },
): Promise<{ readonly refused: number }> {
  const { orgId, email, sessions } = input;
  /**
   * A thread somebody else owns is never one of your chats — whether it was
   * shared (a `chat_threads` row), already mirrored by someone else under its
   * eve session, or (rule 1) already a row under that very id.
   */
  const foreignSessions = new Set<string>();
  const foreignIds = new Set<string>();
  const sessionIds = sessions.map((s) => s.eveSessionId).filter((id): id is string => Boolean(id));
  if (sessionIds.length) {
    const threads = await inOrg((tx) =>
      tx
        .select({ eveSessionId: chatThreads.eveSessionId, ownerEmail: chatThreads.ownerEmail })
        .from(chatThreads)
        .where(inArray(chatThreads.eveSessionId, sessionIds)),
    );
    for (const t of threads as { eveSessionId: string; ownerEmail: string }[]) {
      if (t.ownerEmail.toLowerCase() !== email) foreignSessions.add(t.eveSessionId);
    }
    const claimed = await inOrg((tx) =>
      tx
        .select({ eveSessionId: chatSessions.eveSessionId, ownerEmail: chatSessions.ownerEmail })
        .from(chatSessions)
        .where(inArray(chatSessions.eveSessionId, sessionIds)),
    );
    for (const c of claimed as { eveSessionId: string | null; ownerEmail: string }[]) {
      if (c.eveSessionId && c.ownerEmail.toLowerCase() !== email) foreignSessions.add(c.eveSessionId);
    }
  }
  const ids = sessions.map((s) => s.id);
  if (ids.length) {
    const existing = await inOrg((tx) =>
      tx.select({ id: chatSessions.id, ownerEmail: chatSessions.ownerEmail }).from(chatSessions).where(inArray(chatSessions.id, ids)),
    );
    for (const r of existing as { id: string; ownerEmail: string }[]) {
      if (r.ownerEmail.toLowerCase() !== email) foreignIds.add(r.id);
    }
  }

  const withMarkers = await hasMarkersColumn(inOrg);
  let refused = 0;
  for (const s of sessions) {
    if (foreignIds.has(s.id) || (s.eveSessionId && foreignSessions.has(s.eveSessionId))) {
      refused += 1;
      continue;
    }
    const markers = withMarkers ? capMarkers(s.clientMarkers ?? [], MARKERS_MAX_BYTES_SERVER) : [];
    const insert = {
      id: s.id,
      orgId,
      ownerEmail: email,
      clientKey: s.clientKey ?? null,
      title: s.title ?? null,
      preview: s.preview ?? null,
      messageCount: s.messageCount ?? null,
      customers: s.customers ?? null,
      forkedFrom: s.forkedFrom ?? null,
      eveSessionId: s.eveSessionId ?? null,
      continuationToken: s.continuationToken ?? null,
      derivedCustomers: s.derivedCustomers ?? null,
      toolCounts: s.toolCounts ?? null,
      archived: s.archived ?? false,
      updatedAt: s.updatedAt ? new Date(s.updatedAt) : new Date(),
      ...(withMarkers ? { clientMarkers: markers.length ? markers : null } : {}),
    };
    /**
     * What an update may change. NOT `orgId` (a thread belongs to the workspace
     * it was started in — a workspace switch must not drag it along), NOT
     * `ownerEmail`, and an existing `eveSessionId` is kept: it can be set once,
     * never replaced or nulled.
     */
    const { orgId: _immutable, ownerEmail: _owner, eveSessionId: _session, clientMarkers: _markers, ...mutable } =
      insert as typeof insert & { clientMarkers?: unknown };
    void _immutable;
    void _owner;
    void _session;
    void _markers;
    const table = withMarkers ? chatSessions : chatSessionsBefore0020;
    await inOrg((tx) =>
      tx
        .insert(table)
        .values(insert)
        .onConflictDoUpdate({
          target: table.id,
          set: { ...mutable,
            eveSessionId: sql`coalesce(${table.eveSessionId}, excluded.eve_session_id)`,
            // Markers only ever GROW: the union of what is stored and what this
            // device sends, so a device with fewer never erases another's Stop.
            ...(withMarkers && markers.length
              ? {
                  clientMarkers: sql`(SELECT jsonb_agg(DISTINCT m) FROM jsonb_array_elements(coalesce(${chatSessions.clientMarkers}, '[]'::jsonb) || excluded.client_markers) AS m)`,
                }
              : {}),
          },
          // Guarded AT WRITE TIME too: even a row that appeared under another
          // owner between the check above and this statement is not taken over.
          setWhere: eq(table.ownerEmail, email),
        }),
    );
  }
  return { refused };
}
