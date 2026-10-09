/**
 * THE CHAT QUEUE, HELD ON THE SERVER (`chat_queue_items`).
 *
 * A message typed while the agent is still working is queued, not sent (eve buffers a message delivered mid-turn
 * and runs it at a boundary nobody is reading — #59). Until now the queue lived in the tab's sessionStorage, so
 * closing the tab meant the message was never sent. Here it outlives the tab: the server sends it when the session
 * comes to rest (lib/chat-queue-drain.ts), whether or not a tab is open.
 *
 * Read and written here so the routes (app/api/ops/chat-queue) and the database test
 * (scripts/test-chat-queue-db.mjs) run the SAME code. Rules:
 *
 *  1. OWNER-ONLY. Every read and write is filtered on the caller as well as the workspace, runs with the caller as
 *     `app.principal_email` (the restrictive `chat_queue_owner` policy, drizzle/0021), and an item id that exists
 *     under another person is refused — never overwritten (the chat-list takeover of #59, the same shape).
 *  1b. ONE SESSION, ONE OWNER. Only the person whose chat it is may queue into a session (`sessionOwner`: the
 *     owner the agent recorded at creation, `agent_session_owners` (#66), and — when the chat list has a row for
 *     it — that row's owner too, both agreeing), only while they can still act in the workspace (`canActIn`), and never
 *     into a SHARED thread (those go through the thread's own relay). eve's session routes accept any valid sign-in
 *     for any session, so this is where "a colleague's text sent as someone else" is stopped (review of #63).
 *  2. EXACTLY ONCE. An item leaves `queued` only through `claimNextQueued`: one UPDATE that picks the session's
 *     next sendable item `FOR UPDATE SKIP LOCKED`, guarded by a unique index that allows ONE `sending` item per eve
 *     session. It then becomes `sent` (`markSent`, only by the claim that holds it) or goes back to `queued`
 *     (`releaseClaim`). Two tabs, the agent's hook and the cron racing for one session produce one delivery.
 *  3. NOTHING ANCIENT IS SENT. An item still queued after 24 hours is `expired`: shown as not sent, sent only if the
 *     person asks again ("Send now" requeues it as new).
 *  4. A REMOVAL IS FINAL, and only possible while the item has not gone: × on an item that is already on its way
 *     answers "already sent".
 */
import { sql } from "drizzle-orm";
import { isMember } from "./workspace-rules.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
/** A workspace scope, optionally naming the person (owner-only policy). */
export interface Scope {
  readonly orgId: string;
  readonly principal?: string | null;
}
/** Runs `fn` in a transaction scoped to `scope` (withOrgRls / withOrgDb). */
export type RunIn = <T>(scope: Scope, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** An item still queued this long after it was typed is never sent on its own. */
export const QUEUE_EXPIRE_MS = 24 * 60 * 60_000;
/** A claim held this long without finishing belongs to a sender that died (a function timeout, a crash). */
export const SENDING_STALE_MS = 2 * 60_000;
/** The most items one chat may hold — a queue is minutes of typing, not a log. */
export const QUEUE_MAX = 50;
/** How long a sent item stays listed (so every tab learns what went and reads its reply). */
export const SENT_VISIBLE_MS = 10 * 60_000;
const TEXT_MAX = 100_000;
const MESSAGE_MAX = 250_000;

export type QueueState = "queued" | "sending" | "sent" | "expired" | "failed";
/** A claim held this long that nothing can settle (its session unreadable) ends as `failed` — see `failClaim`. */
export const CLAIM_HARD_TIMEOUT_MS = 10 * 60_000;

export interface QueueSettings {
  readonly mode: string;
  readonly webSearch: boolean;
  readonly browserUse: boolean;
  readonly customers: readonly string[];
}

export interface QueueRow {
  readonly id: string;
  readonly orgId: string;
  readonly ownerEmail: string;
  readonly eveSessionId: string;
  readonly chatId: string | null;
  readonly text: string;
  readonly message: string;
  readonly settings: QueueSettings;
  readonly goal: boolean;
  readonly attachments: ReadonlyArray<{ name: string; path: string }>;
  readonly filesPending: number;
  readonly fileNames: readonly string[];
  readonly position: number;
  readonly state: QueueState;
  readonly claimId: string | null;
  readonly claimedAt: number | null;
  readonly sentAt: number | null;
  readonly sentBy: string | null;
  readonly restMark: string | null;
  readonly sentMessage: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** How long the current claim has been held, by the DATABASE's clock (null when not claimed). */
  readonly claimAgeMs: number | null;
  /** How long ago it was sent, by the DATABASE's clock (only where asked for). */
  readonly sentAgeMs: number | null;
}

export interface QueueItemInput {
  readonly id: string;
  readonly eveSessionId: string;
  readonly chatId?: string | null;
  readonly text: string;
  readonly message: string;
  readonly settings: QueueSettings;
  readonly goal?: boolean;
  readonly attachments?: ReadonlyArray<{ name: string; path: string }> | null;
  readonly filesPending?: number;
  readonly fileNames?: readonly string[] | null;
}

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

/** A database row (snake_case from a raw query, or camelCase from drizzle) as a QueueRow. */
export function toQueueRow(r: Record<string, unknown>): QueueRow {
  const g = (camel: string, snake: string) => (camel in r ? r[camel] : r[snake]);
  return {
    id: String(r.id),
    orgId: String(g("orgId", "org_id")),
    ownerEmail: String(g("ownerEmail", "owner_email")),
    eveSessionId: String(g("eveSessionId", "eve_session_id")),
    chatId: (g("chatId", "chat_id") as string | null) ?? null,
    text: String(r.text ?? ""),
    message: String(r.message ?? ""),
    settings: json<QueueSettings>(r.settings, { mode: "build", webSearch: true, browserUse: false, customers: [] }),
    goal: Boolean(r.goal),
    attachments: json<Array<{ name: string; path: string }>>(r.attachments, []) ?? [],
    filesPending: Number(g("filesPending", "files_pending") ?? 0),
    fileNames: json<string[]>(g("fileNames", "file_names"), []) ?? [],
    position: Number(r.position ?? 0),
    state: String(r.state) as QueueState,
    claimId: (g("claimId", "claim_id") as string | null) ?? null,
    claimedAt: ms(g("claimedAt", "claimed_at")),
    sentAt: ms(g("sentAt", "sent_at")),
    sentBy: (g("sentBy", "sent_by") as string | null) ?? null,
    restMark: (g("restMark", "rest_mark") as string | null) ?? null,
    sentMessage: (g("sentMessage", "sent_message") as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: ms(g("createdAt", "created_at")) ?? 0,
    updatedAt: ms(g("updatedAt", "updated_at")) ?? 0,
    claimAgeMs: r.claim_age_ms === null || r.claim_age_ms === undefined ? null : Number(r.claim_age_ms),
    sentAgeMs: r.sent_age_ms === null || r.sent_age_ms === undefined ? null : Number(r.sent_age_ms),
  };
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : (((r as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]);

const isSettings = (s: unknown): s is QueueSettings =>
  typeof (s as QueueSettings)?.mode === "string" &&
  typeof (s as QueueSettings)?.webSearch === "boolean" &&
  typeof (s as QueueSettings)?.browserUse === "boolean" &&
  Array.isArray((s as QueueSettings)?.customers) &&
  (s as QueueSettings).customers.every((c) => typeof c === "string");

/** Is this a well-formed item to store? A reason when it is not. */
export function invalidItem(item: QueueItemInput): string | null {
  if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(item.id)) return "bad id";
  if (typeof item.eveSessionId !== "string" || !item.eveSessionId || item.eveSessionId.length > 200) return "bad session";
  if (typeof item.text !== "string" || item.text.length > TEXT_MAX) return "bad text";
  if (typeof item.message !== "string" || item.message.length > MESSAGE_MAX) return "bad message";
  if (!item.message.trim() && !(item.filesPending && item.filesPending > 0)) return "empty";
  if (!isSettings(item.settings)) return "bad settings";
  const pending = item.filesPending ?? 0;
  if (!Number.isInteger(pending) || pending < 0 || pending > 20) return "bad files";
  for (const a of item.attachments ?? []) {
    if (typeof a?.name !== "string" || typeof a?.path !== "string" || a.path.length > 1000) return "bad attachment";
  }
  return null;
}

/* ───────────────────────────── who may queue ───────────────────────────── */

/**
 * WHOSE CHAT IS THIS SESSION? The owner the AGENT recorded when the session was created (`agent_session_owners`,
 * PR #66: written by the session guard from the verified caller before the session id is returned — the same record
 * the guard admits a queued delivery against). Only a person's own chat: a workspace-visible step, a service
 * session or a subagent's child session is not a queue's. Cross-checked against the chat list's owner when that row
 * exists (the two disagreeing is refused, not guessed). A session created before that record has no queue: its
 * tab keeps the message and sends it itself. `shared`: a shared thread — its turns belong to the thread's relay.
 */
export async function sessionOwner(
  runIn: RunIn,
  input: { readonly orgId: string; readonly sessionId: string },
): Promise<{ readonly owner: string | null; readonly shared: boolean }> {
  return runIn({ orgId: input.orgId }, async (tx) => {
    const recorded = rowsOf(
      await tx.execute(sql`
        select owner_email, owner_kind, visibility, parent_session_id from agent_session_owners
        where session_id = ${input.sessionId} and org_id = ${input.orgId}`),
    )[0];
    const mirror = rowsOf(
      await tx.execute(sql`
        select owner_email from chat_sessions where eve_session_id = ${input.sessionId} and org_id = ${input.orgId}
        order by created_at asc limit 2`),
    );
    const thread = rowsOf(
      await tx.execute(sql`
        select 1 from chat_threads where eve_session_id = ${input.sessionId} and org_id = ${input.orgId} and archived_at is null limit 1`),
    )[0];
    const personal =
      recorded &&
      recorded.owner_kind === "person" &&
      recorded.visibility === "owner" &&
      !recorded.parent_session_id &&
      typeof recorded.owner_email === "string" &&
      recorded.owner_email;
    const owner = personal ? String(recorded.owner_email).toLowerCase() : null;
    const listed = [...new Set(mirror.map((m) => String(m.owner_email).toLowerCase()))];
    if (!owner || listed.length > 1 || (listed.length === 1 && listed[0] !== owner)) {
      return { owner: null, shared: Boolean(thread) };
    }
    return { owner, shared: Boolean(thread) };
  });
}

/**
 * MAY WE STILL ACT FOR THIS PERSON IN THIS WORKSPACE? Membership, and only membership (lib/workspace-rules.ts
 * `isMember`): the queue and notifications act for someone who is not there, and the web app's hosted-domain
 * fallback rests on a verified Google claim that a later server call does not have. A removed member answers no,
 * so nothing is sent as them, and no notification reaches them (agent/lib/push-recipients.ts asks the same).
 */
export function canActIn(runIn: RunIn, input: { readonly orgId: string; readonly email: string }): Promise<boolean> {
  return isMember(runIn, input);
}


/** Queued items older than a day become `expired` — never sent on their own. Runs before every read and claim. */
async function expireOld(tx: Tx, orgId: string, sessionId: string | null): Promise<void> {
  await tx.execute(sql`
    update chat_queue_items set state = 'expired', updated_at = now()
    where org_id = ${orgId} and state = 'queued' and created_at < now() - make_interval(secs => ${QUEUE_EXPIRE_MS / 1000})
      ${sessionId ? sql`and eve_session_id = ${sessionId}` : sql``}`);
}

export type EnqueueResult =
  | { readonly ok: true; readonly row: QueueRow }
  | { readonly ok: false; readonly reason: "invalid" | "foreign" | "full" | "not-your-chat"; readonly detail?: string };

/** Queue an item for the caller. Idempotent on the item id (a retried POST is the same item). */
export async function enqueueItem(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly item: QueueItemInput },
): Promise<EnqueueResult> {
  const email = input.email.toLowerCase();
  const bad = invalidItem(input.item);
  if (bad) return { ok: false, reason: "invalid", detail: bad };
  const it = input.item;
  // Rule 1: an id another person already holds is theirs. Asked with NO person named, so the owner-only policy
  // cannot hide the row that makes the answer "no".
  const existing = rowsOf(
    await runIn({ orgId: input.orgId }, (tx) =>
      tx.execute(sql`select owner_email from chat_queue_items where id = ${it.id}`),
    ),
  )[0];
  if (existing && String(existing.owner_email).toLowerCase() !== email) return { ok: false, reason: "foreign" };
  // Rule 1b: only into the caller's OWN chat, while they can act here, and never a shared thread's.
  const chat = await sessionOwner(runIn, { orgId: input.orgId, sessionId: it.eveSessionId });
  if (chat.shared || chat.owner !== email || !(await canActIn(runIn, { orgId: input.orgId, email }))) {
    return { ok: false, reason: "not-your-chat" };
  }
  return runIn({ orgId: input.orgId, principal: email }, async (tx) => {
    const [{ n }] = rowsOf(
      await tx.execute(sql`
        select count(*)::int as n from chat_queue_items
        where org_id = ${input.orgId} and owner_email = ${email} and eve_session_id = ${it.eveSessionId}
          and state in ('queued', 'sending')`),
    ) as Array<{ n: number }>;
    if (!existing && n >= QUEUE_MAX) return { ok: false, reason: "full" } as const;
    const inserted = rowsOf(
      await tx.execute(sql`
        insert into chat_queue_items
          (id, org_id, owner_email, eve_session_id, chat_id, text, message, settings, goal, attachments,
           files_pending, file_names, position)
        values (${it.id}, ${input.orgId}, ${email}, ${it.eveSessionId}, ${it.chatId ?? null}, ${it.text},
                ${it.message}, ${JSON.stringify(it.settings)}::jsonb, ${Boolean(it.goal)},
                ${JSON.stringify(it.attachments ?? [])}::jsonb, ${it.filesPending ?? 0},
                ${JSON.stringify(it.fileNames ?? [])}::jsonb,
                (select coalesce(max(position), 0) + 1 from chat_queue_items
                  where org_id = ${input.orgId} and eve_session_id = ${it.eveSessionId}))
        on conflict (id) do nothing
        returning *`),
    );
    const row =
      inserted[0] ??
      rowsOf(
        await tx.execute(
          sql`select * from chat_queue_items where id = ${it.id} and org_id = ${input.orgId} and owner_email = ${email}`,
        ),
      )[0];
    if (!row) return { ok: false, reason: "foreign" } as const;
    return { ok: true, row: toQueueRow(row) } as const;
  });
}

/** The caller's items for one chat: queued, on their way, expired, and recently sent. Oldest first. */
export async function listQueue(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly sessionId: string },
): Promise<QueueRow[]> {
  const email = input.email.toLowerCase();
  return runIn({ orgId: input.orgId, principal: email }, async (tx) => {
    await expireOld(tx, input.orgId, input.sessionId);
    return rowsOf(
      await tx.execute(sql`
        select * from chat_queue_items
        where org_id = ${input.orgId} and owner_email = ${email} and eve_session_id = ${input.sessionId}
          and (state in ('queued', 'sending', 'expired', 'failed') or (state = 'sent' and sent_at > now() - make_interval(secs => ${SENT_VISIBLE_MS / 1000})))
        order by position asc, created_at asc
        limit ${QUEUE_MAX * 2}`),
    ).map(toQueueRow);
  });
}

export type RemoveResult = "removed" | "already-sent" | "not-found";

/** × — remove an item that has not gone yet. */
export async function removeQueued(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly id: string },
): Promise<RemoveResult> {
  const email = input.email.toLowerCase();
  return runIn({ orgId: input.orgId, principal: email }, async (tx) => {
    const gone = rowsOf(
      await tx.execute(sql`
        delete from chat_queue_items
        where id = ${input.id} and org_id = ${input.orgId} and owner_email = ${email} and state in ('queued', 'expired', 'failed')
        returning id`),
    );
    if (gone.length > 0) return "removed" as const;
    const left = rowsOf(
      await tx.execute(
        sql`select state from chat_queue_items where id = ${input.id} and org_id = ${input.orgId} and owner_email = ${email}`,
      ),
    )[0];
    return left ? ("already-sent" as const) : ("not-found" as const);
  });
}

export interface QueuePatch {
  readonly text?: string;
  readonly message?: string;
  readonly settings?: QueueSettings;
  readonly goal?: boolean;
  readonly attachments?: ReadonlyArray<{ name: string; path: string }>;
  readonly filesPending?: number;
  /** Move before (-1) or after (+1) its neighbour. */
  readonly move?: -1 | 1;
  /** An expired or failed item the person chose to send after all ("Send again"): queued again, as new. */
  readonly requeue?: boolean;
}

/** Change an item that has not gone yet (edit, attachments landed, "Send without it", reorder, requeue). */
export async function updateQueued(
  runIn: RunIn,
  input: { readonly orgId: string; readonly email: string; readonly id: string; readonly patch: QueuePatch },
): Promise<QueueRow | null> {
  const email = input.email.toLowerCase();
  const p = input.patch;
  if (p.text !== undefined && (typeof p.text !== "string" || p.text.length > TEXT_MAX)) return null;
  if (p.message !== undefined && (typeof p.message !== "string" || p.message.length > MESSAGE_MAX)) return null;
  if (p.settings !== undefined && !isSettings(p.settings)) return null;
  if (p.filesPending !== undefined && (!Number.isInteger(p.filesPending) || p.filesPending < 0 || p.filesPending > 20)) return null;
  return runIn({ orgId: input.orgId, principal: email }, async (tx) => {
    const cur = rowsOf(
      await tx.execute(sql`
        select * from chat_queue_items
        where id = ${input.id} and org_id = ${input.orgId} and owner_email = ${email}
        for update`),
    )[0];
    if (!cur) return null;
    const row = toQueueRow(cur);
    const editable = row.state === "queued" || ((row.state === "expired" || row.state === "failed") && p.requeue === true);
    if (!editable) return null;
    if (p.move) {
      const neighbour = rowsOf(
        await tx.execute(sql`
          select id, position from chat_queue_items
          where org_id = ${input.orgId} and owner_email = ${email} and eve_session_id = ${row.eveSessionId}
            and state = 'queued' and id <> ${row.id}
            and ${p.move < 0 ? sql`position < ${row.position}` : sql`position > ${row.position}`}
          order by position ${p.move < 0 ? sql`desc` : sql`asc`} limit 1
          for update`),
      )[0];
      if (neighbour) {
        await tx.execute(sql`update chat_queue_items set position = ${row.position}, updated_at = now() where id = ${String(neighbour.id)}`);
        await tx.execute(sql`update chat_queue_items set position = ${Number(neighbour.position)}, updated_at = now() where id = ${row.id}`);
      }
    }
    const updated = rowsOf(
      await tx.execute(sql`
        update chat_queue_items set
          text = ${p.text ?? row.text},
          message = ${p.message ?? row.message},
          settings = ${JSON.stringify(p.settings ?? row.settings)}::jsonb,
          goal = ${p.goal ?? row.goal},
          attachments = ${JSON.stringify(p.attachments ?? row.attachments)}::jsonb,
          files_pending = ${p.filesPending ?? row.filesPending},
          state = ${p.requeue ? "queued" : row.state},
          error = ${p.requeue ? null : row.error},
          created_at = ${p.requeue ? sql`now()` : sql`created_at`},
          position = ${p.requeue ? sql`(select coalesce(max(position), 0) + 1 from chat_queue_items where org_id = ${input.orgId} and eve_session_id = ${row.eveSessionId})` : sql`position`},
          updated_at = now()
        where id = ${row.id} and org_id = ${input.orgId} and owner_email = ${email} and state in ('queued', 'expired', 'failed')
        returning *`),
    )[0];
    return updated ? toQueueRow(updated) : null;
  });
}

/* ───────────────────────────── delivery ───────────────────────────── */

/**
 * What ONE OWNER's queue for a session holds — for the SERVER paths (the drain), which name the owner they serve
 * (`sessionOwner`), never infer it from whichever row happens to be first. Ordered exactly as `claimNextQueued`
 * claims (position, created_at, id), so "the next item" means one thing everywhere. `sending` is ANY item of the
 * session in flight in this workspace (one at a time per session, whoever's it is); its claim age is measured by the
 * database's clock only.
 */
export async function sessionQueueState(
  runIn: RunIn,
  input: { readonly orgId: string; readonly sessionId: string; readonly owner: string },
): Promise<{ readonly queued: number; readonly next: QueueRow | null; readonly sending: QueueRow | null; readonly lastSent: QueueRow | null }> {
  const owner = input.owner.toLowerCase();
  return runIn({ orgId: input.orgId }, async (tx) => {
    await expireOld(tx, input.orgId, input.sessionId);
    const next = rowsOf(
      await tx.execute(sql`
        select * from chat_queue_items where org_id = ${input.orgId} and eve_session_id = ${input.sessionId}
          and owner_email = ${owner} and state = 'queued' and files_pending = 0
        order by position asc, created_at asc, id asc limit 1`),
    ).map(toQueueRow)[0] ?? null;
    const sending = rowsOf(
      await tx.execute(sql`
        select *, (extract(epoch from (now() - claimed_at)) * 1000)::bigint as claim_age_ms
        from chat_queue_items where org_id = ${input.orgId} and eve_session_id = ${input.sessionId} and state = 'sending'
        limit 1`),
    ).map(toQueueRow)[0] ?? null;
    const lastSent = rowsOf(
      await tx.execute(sql`
        select *, (extract(epoch from (now() - sent_at)) * 1000)::bigint as sent_age_ms
        from chat_queue_items where org_id = ${input.orgId} and eve_session_id = ${input.sessionId}
          and state = 'sent' order by sent_at desc limit 1`),
    ).map(toQueueRow)[0] ?? null;
    const [{ n }] = rowsOf(
      await tx.execute(sql`
        select count(*)::int as n from chat_queue_items
        where org_id = ${input.orgId} and eve_session_id = ${input.sessionId} and owner_email = ${owner}
          and state = 'queued' and files_pending = 0`),
    ) as Array<{ n: number }>;
    return { queued: n, next, sending, lastSent };
  });
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

/**
 * CLAIM the next sendable item OF THE OWNER BEING SERVED — the one step that makes a delivery exactly-once.
 *
 * One UPDATE, under a per-(workspace, session) transaction lock: that owner's next `queued` item with nothing still
 * uploading, in (position, created_at, id) order, only if no item of the session is already `sending` in this
 * workspace. The partial unique index on `(org_id, eve_session_id) WHERE state = 'sending'` refuses a second
 * in-flight item outright even if the lock were ever bypassed (that loser gets null, never an error). The caller
 * then sends it as `row.ownerEmail` and nobody else.
 */
export async function claimNextQueued(
  runIn: RunIn,
  input: { readonly orgId: string; readonly sessionId: string; readonly owner: string; readonly claimId: string; readonly restMark: string },
): Promise<QueueRow | null> {
  const owner = input.owner.toLowerCase();
  try {
    return await runIn({ orgId: input.orgId }, async (tx) => {
      // Claimers of ONE session queue up here (released at commit), so the loser of a race simply finds the item
      // already on its way; the unique index below stays the guarantee, not the mechanism.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-queue:${input.orgId}:${input.sessionId}`}))`);
      await expireOld(tx, input.orgId, input.sessionId);
      const claimed = rowsOf(
        await tx.execute(sql`
          update chat_queue_items set state = 'sending', claim_id = ${input.claimId}, claimed_at = now(),
                 rest_mark = ${input.restMark}, token_seq = 0, updated_at = now()
          where id = (
            select id from chat_queue_items
            where org_id = ${input.orgId} and eve_session_id = ${input.sessionId} and owner_email = ${owner}
              and state = 'queued' and files_pending = 0
            order by position asc, created_at asc, id asc
            limit 1
            for update skip locked)
            and not exists (
              select 1 from chat_queue_items s
              where s.org_id = ${input.orgId} and s.eve_session_id = ${input.sessionId} and s.state = 'sending')
          returning *`),
      );
      return claimed[0] ? toQueueRow(claimed[0]) : null;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/**
 * A claim nothing can settle ends here: its session can no longer be read (deleted, purged, the sign-in refused)
 * and it has been held past `CLAIM_HARD_TIMEOUT_MS` by the database's clock. The item is shown as "Didn't send —
 * Send again", and the session's one in-flight slot is free for the next item.
 */
export async function failClaim(
  runIn: RunIn,
  input: { readonly orgId: string; readonly id: string; readonly claimId: string; readonly note: string },
): Promise<boolean> {
  return runIn({ orgId: input.orgId }, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        update chat_queue_items set state = 'failed', claim_id = null, claimed_at = null, error = ${input.note.slice(0, 300)},
               updated_at = now()
        where id = ${input.id} and org_id = ${input.orgId} and state = 'sending' and claim_id = ${input.claimId}
        returning id`),
    ).length > 0,
  );
}

/** The claim delivered it (`sentMessage`: exactly what went). Only the claim that holds the item can say so. */
export async function markSent(
  runIn: RunIn,
  input: { readonly orgId: string; readonly id: string; readonly claimId: string; readonly by: "server" | "tab"; readonly sentMessage?: string | null },
): Promise<boolean> {
  return runIn({ orgId: input.orgId }, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        update chat_queue_items set state = 'sent', sent_at = now(), sent_by = ${input.by}, error = null, updated_at = now(),
               sent_message = ${input.sentMessage ?? null}
        where id = ${input.id} and org_id = ${input.orgId} and state = 'sending' and claim_id = ${input.claimId}
        returning id`),
    ).length > 0,
  );
}

/** The claim did NOT deliver it (refused, or verified not received): back in line, in its place. */
export async function releaseClaim(
  runIn: RunIn,
  input: { readonly orgId: string; readonly id: string; readonly claimId: string; readonly error?: string | null },
): Promise<boolean> {
  return runIn({ orgId: input.orgId }, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        update chat_queue_items set state = 'queued', claim_id = null, claimed_at = null, rest_mark = null, token_seq = 0,
               error = ${input.error ? input.error.slice(0, 300) : null}, updated_at = now()
        where id = ${input.id} and org_id = ${input.orgId} and state = 'sending' and claim_id = ${input.claimId}
        returning id`),
    ).length > 0,
  );
}

/** Claims held longer than `SENDING_STALE_MS` in this workspace — a sender that died mid-delivery. */
export async function staleClaims(runIn: RunIn, input: { readonly orgId: string }): Promise<QueueRow[]> {
  return runIn({ orgId: input.orgId }, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        select * from chat_queue_items where org_id = ${input.orgId} and state = 'sending'
          and claimed_at < now() - make_interval(secs => ${SENDING_STALE_MS / 1000})
        limit 50`),
    ).map(toQueueRow),
  );
}

/** Sessions of this workspace with an item waiting at least `olderThanMs` — the sweep's work list. */
export async function sessionsWithQueued(
  runIn: RunIn,
  input: { readonly orgId: string; readonly olderThanMs: number; readonly limit?: number },
): Promise<string[]> {
  return runIn({ orgId: input.orgId }, async (tx) => {
    await expireOld(tx, input.orgId, null);
    return rowsOf(
      await tx.execute(sql`
        select eve_session_id, min(updated_at) as since from chat_queue_items
        where org_id = ${input.orgId} and state = 'queued' and files_pending = 0 and updated_at < now() - make_interval(secs => ${input.olderThanMs / 1000})
        group by eve_session_id order by since asc limit ${input.limit ?? 20}`),
    ).map((r) => String(r.eve_session_id));
  });
}

/** Sent and expired items are kept a week for the record, then dropped. */
export async function purgeOld(runIn: RunIn, input: { readonly orgId: string }): Promise<void> {
  await runIn({ orgId: input.orgId }, (tx) =>
    tx.execute(sql`delete from chat_queue_items where org_id = ${input.orgId} and state in ('sent', 'expired', 'failed') and updated_at < now() - interval '7 days'`),
  );
}
