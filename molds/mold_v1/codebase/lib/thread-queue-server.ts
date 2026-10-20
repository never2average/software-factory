/**
 * A SHARED CHAT'S QUEUE (`chat_thread_queue`, mold_v1-290).
 *
 * Two people can write into one shared chat, but its agent runs one turn at a time. The relay used to answer a second
 * sender with 409 "A turn is in progress … Try again in a moment", and the composer dropped a second message while the
 * first was on its way, so a participant who was not the chat's author could not add anything while another turn ran.
 * Now every message is QUEUED first and the queue is run in order:
 *
 *  1. ENQUEUE. A message from the owner or a participant becomes a row here, in the thread's workspace (RLS), in the
 *     order it arrived (`seq`). Who may post is decided before this, by the route: viewers and guests never reach it.
 *     An id is unique within its workspace only (the key is org_id, id): it says nothing about another workspace.
 *  2. RUN AS ITS AUTHOR. A queued message is sent as the person who wrote it, never as whoever's page ran the queue:
 *     the web app signs a single-use token for the AUTHOR, bound to this item's claim (lib/auth-session.ts
 *     `mintQueueDeliveryToken`, queue "thread"); the agent admits it only for that exact body, once
 *     (agent/lib/queue-delivery-auth.ts), and only while the author is the thread's owner or a live participant
 *     (lib/chat-gate.ts). Where the web app cannot sign (no key), only the author's own page may run their message
 *     (`canSendAs`). Before every claim the author's standing is checked again (`authorStanding`): someone removed from
 *     the workspace or the chat, or a viewer, has their message failed with the reason, and nothing is sent.
 *  3. ONE TURN AT A TIME, AND NEVER AROUND ANYONE ELSE'S. The thread row is a mutex (`turn_holder`, `turn_claimed_at`;
 *     an abandoned claim is taken over atomically after `staleClaimMs`), and the continuation token is read from the
 *     session itself (`parkedToken`): a session that is not parked is running a turn — the owner typing straight into
 *     their own copy of the chat included — and the queue waits for it.
 *  4. EXACTLY ONCE, IN ORDER. The item claim (`FOR UPDATE SKIP LOCKED`, and one `sending` item per thread) means two
 *     pumps can never send the same item or two at once; items run oldest first, whoever sent them. A send whose
 *     outcome is unknown (no answer, a timeout, a 5xx) is never blindly repeated: if the agent never spent the token,
 *     the claim is withdrawn atomically (so a late copy is refused at the door) and the item retried; otherwise the
 *     claim is remembered (`tried_claims`) and, before any resend, the session's history is searched for it.
 *     A history that cannot be read in full is never taken for "not received": the item is failed as unconfirmed.
 *     Where only the author's own page can send (no signing key), a message first in line waits for it a few minutes
 *     (`AUTHOR_WAIT_MS`), then is failed with a reason its author sees, so it never holds the line.
 *  5. RETRIES THAT DO NOT BLOCK. A refusal that may pass (409, 429) backs off exponentially (`next_attempt_at`); later
 *     items run meanwhile. A permanent one (another 4xx, an oversized message) fails at once, and one still refused
 *     `GIVE_UP_AFTER_MS` after its FIRST attempt fails too. Its author is told.
 *  6. A SESSION WITH NO OWNER RECORD (mold_v1-291). The agent's door admits a signed author token only on a thread whose
 *     owner is the session's owner AS THE AGENT RECORDED IT (`agent_session_owners`, since drizzle/0022). A session from
 *     before that record has none, so a token minted for it would only be refused there. Such a session's messages are
 *     never signed for: each is sent on its AUTHOR's own sign-in, by the author's own page — when they send it and the
 *     chat is free, or when their page runs the queue — exactly as a message was sent before the queue
 *     (`sessionOwnerRecorded`). Anyone else's page leaves it where it is (`waiting-for-author`, the same bounded wait
 *     as a deployment that cannot sign), so it is sent as its author or failed with a reason its author sees; never
 *     sent as whoever ran the queue. The web app does not write the missing record itself: the only rows it could
 *     take an owner from are browser-written (the chat list, the thread) or last-writer-wins (the agent's scope row).
 *     The agent writes it itself the first time the session passes its guard and its server-written evidence names an
 *     owner (agent/lib/session-guard.ts `ownershipOf`, lib/session-gate.ts `ownershipFromEvidence`, mold_v1-293: the
 *     person its scope row names, confirmed by a row of that same person — never a thread or chat row alone); from
 *     then on its messages are signed for like any other. A session that evidence does not place stays unowned, and
 *     the agent's gate refuses every sign-in on it: its messages fail with that reason, visible to their authors.
 *  7. NO TABLE, NO OUTAGE. Code can reach a database before drizzle/0048 does (a database shared with another app and
 *     not migrated by it, a build that went out by a git push). Every entry point then says so (`no-queue`, `empty`, an
 *     empty list) instead of throwing, and the relay sends the message the direct way, as it did before the queue.
 *
 * The SQL runs through an injected `RunIn` (withOrgRls in the web app, withOrgDb in scripts/test-thread-queue-db.mjs)
 * and the agent calls through injected deps, so the database test runs this very code against a fake agent.
 */
import { sql } from "drizzle-orm";
import { isUndefinedTable, isUniqueViolation } from "./pg-error.ts";
import { deliveryReference, threadMessageText } from "./queue-delivery-token.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;
/** Runs `fn` in a transaction scoped to the workspace `orgId` (withOrgRls / withOrgDb). */
export type RunIn = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** A refusal that may pass is retried; after this many tries AND `GIVE_UP_AFTER_MS` from the first, it fails. */
export const MAX_ATTEMPTS = 5;
export const GIVE_UP_AFTER_MS = 10 * 60_000;
/** The first back-off after a refusal; doubled each try, at most `BACKOFF_MAX_MS`. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 2 * 60_000;
/** A `sending` claim this old belongs to a request that died. */
export const SENDING_STALE_MS = 6 * 60_000;
/** A thread claim this old was abandoned (a crashed sender): it may be taken over. */
export const STALE_CLAIM_MS = 3 * 60_000;
/** The most items one shared chat may hold. */
export const THREAD_QUEUE_MAX = 50;
/** The longest message one item may carry. */
export const THREAD_TEXT_MAX = 100_000;
/** How long a failed item stays listed for its author. */
export const FAILED_VISIBLE_MS = 30 * 60_000;

export type ThreadQueueState = "queued" | "sending" | "sent" | "failed";

/** What a search of the session's history found. */
export type Received = "yes" | "no" | "unknown";

/**
 * Where this deployment cannot sign for an author, a message first in line waits for its author's own page this long;
 * then it is failed, with a reason its author sees, so it never holds everyone else's messages behind it.
 */
export const AUTHOR_WAIT_MS = 3 * 60_000;
export const AUTHOR_GONE_REASON =
  "Not sent: here only its sender's own page can send it, and it was not open. Send it again when you are back.";
/** A send whose answer was lost and whose arrival could not be checked. */
export const UNCONFIRMED_REASON =
  "Not sent again: the earlier try could not be confirmed either way. Check the chat, and send it again if it is missing.";

export interface ThreadQueueItem {
  readonly id: string;
  readonly threadId: string;
  readonly authorEmail: string;
  readonly text: string;
  readonly seq: number;
  readonly state: ThreadQueueState;
  readonly attempts: number;
  readonly tokenSeq: number;
  readonly triedClaims: readonly string[];
  readonly firstAttemptAt: number | null;
  readonly error: string | null;
  readonly createdAt: number;
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : (((r as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]);

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const textArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.startsWith("{")) return v.slice(1, -1).split(",").filter(Boolean);
  return [];
};

function toItem(r: Record<string, unknown>): ThreadQueueItem {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    authorEmail: String(r.author_email),
    text: String(r.text ?? ""),
    seq: Number(r.seq ?? 0),
    state: String(r.state) as ThreadQueueState,
    attempts: Number(r.attempts ?? 0),
    tokenSeq: Number(r.token_seq ?? 0),
    triedClaims: textArray(r.tried_claims),
    firstAttemptAt: ms(r.first_attempt_at),
    error: (r.error as string | null) ?? null,
    createdAt: ms(r.created_at) ?? 0,
  };
}

/** The text the agent reads: the sender named, so it knows who is speaking (the relay's rule since it was written). */
export const fromLine = threadMessageText;

/** Is this a well-formed message to queue? A reason when it is not. */
export function invalidMessage(input: { readonly id: string; readonly text: string }): string | null {
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{6,80}$/.test(input.id)) return "bad id";
  if (typeof input.text !== "string" || !input.text.trim()) return "empty";
  if (input.text.length > THREAD_TEXT_MAX) return "too long";
  return null;
}

/** `fn`, or `missing` when the queue's table does not exist yet (42P01). */
async function withoutTable<T, M>(missing: M, fn: () => Promise<T>): Promise<T | M> {
  try {
    return await fn();
  } catch (e) {
    if (isUndefinedTable(e)) return missing;
    throw e;
  }
}

export type EnqueueResult =
  | { readonly ok: true; readonly item: ThreadQueueItem; readonly ahead: number }
  | { readonly ok: false; readonly reason: "invalid" | "full" | "foreign"; readonly detail?: string }
  /** The table is not there yet (drizzle/0048 not applied): send the old way. */
  | { readonly ok: false; readonly reason: "no-queue" };

/**
 * Queue a message for a shared chat. Idempotent on the id (a retried POST is the same message); an id another person
 * holds in THIS workspace is refused, never taken over. Another workspace's ids are invisible here (RLS, and the key).
 */
export async function enqueueThreadMessage(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly author: string; readonly id: string; readonly text: string },
): Promise<EnqueueResult> {
  const bad = invalidMessage(input);
  if (bad) return { ok: false, reason: "invalid", detail: bad };
  const author = input.author.toLowerCase();
  return withoutTable({ ok: false, reason: "no-queue" } as const, () =>
    runIn(input.orgId, async (tx) => {
      const mine = sql`org_id = ${input.orgId} and id = ${input.id}`;
      const existing = rowsOf(await tx.execute(sql`select * from chat_thread_queue where ${mine}`))[0];
      if (existing) {
        if (String(existing.author_email).toLowerCase() !== author || String(existing.thread_id) !== input.threadId) {
          return { ok: false, reason: "foreign" } as const;
        }
      } else {
        const [{ n }] = rowsOf(
          await tx.execute(sql`
            select count(*)::int as n from chat_thread_queue
            where org_id = ${input.orgId} and thread_id = ${input.threadId} and state in ('queued', 'sending')`),
        ) as Array<{ n: number }>;
        if (n >= THREAD_QUEUE_MAX) return { ok: false, reason: "full" } as const;
        await tx.execute(sql`
          insert into chat_thread_queue (org_id, id, thread_id, author_email, text)
          values (${input.orgId}, ${input.id}, ${input.threadId}, ${author}, ${input.text})
          on conflict (org_id, id) do nothing`);
      }
      const row = rowsOf(await tx.execute(sql`select * from chat_thread_queue where ${mine}`))[0];
      if (!row) return { ok: false, reason: "foreign" } as const;
      const item = toItem(row);
      const [{ ahead }] = rowsOf(
        await tx.execute(sql`
          select count(*)::int as ahead from chat_thread_queue
          where org_id = ${input.orgId} and thread_id = ${input.threadId} and state in ('queued', 'sending')
            and seq < ${item.seq}`),
      ) as Array<{ ahead: number }>;
      return { ok: true, item, ahead } as const;
    }),
  );
}

/**
 * What the chat's members see of its queue: what waits and what is on its way, oldest first, and — for `viewer` only —
 * their own messages that could not be sent, so they are told rather than left wondering.
 */
export async function listThreadQueue(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly viewer: string },
): Promise<ThreadQueueItem[]> {
  const viewer = input.viewer.toLowerCase();
  return withoutTable([] as ThreadQueueItem[], () =>
    runIn(input.orgId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          select * from chat_thread_queue
          where org_id = ${input.orgId} and thread_id = ${input.threadId}
            and (state in ('queued', 'sending')
              or (state = 'failed' and author_email = ${viewer}
                  and created_at > now() - make_interval(secs => ${FAILED_VISIBLE_MS / 1000})))
          order by seq asc
          limit ${THREAD_QUEUE_MAX + 10}`),
      ).map(toItem),
    ),
  );
}

/** Take back a message of your own that has not gone yet. `no-queue`: the table is not there yet. */
export async function removeThreadMessage(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly author: string; readonly id: string },
): Promise<"removed" | "already-sent" | "not-found" | "no-queue"> {
  const author = input.author.toLowerCase();
  return withoutTable("no-queue" as const, () =>
    runIn(input.orgId, async (tx) => {
      const gone = rowsOf(
        await tx.execute(sql`
          delete from chat_thread_queue
          where org_id = ${input.orgId} and id = ${input.id} and thread_id = ${input.threadId}
            and author_email = ${author} and state in ('queued', 'failed')
          returning id`),
      );
      if (gone.length) return "removed" as const;
      const row = rowsOf(
        await tx.execute(sql`
          select state from chat_thread_queue
          where org_id = ${input.orgId} and id = ${input.id} and thread_id = ${input.threadId} and author_email = ${author}`),
      )[0];
      return row ? ("already-sent" as const) : ("not-found" as const);
    }),
  );
}

/** The head of the queue — the oldest message waiting or on its way — or null. */
export async function headOfQueue(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string },
): Promise<ThreadQueueItem | null> {
  return withoutTable(null, () =>
    runIn(input.orgId, async (tx) => {
      const row = rowsOf(
        await tx.execute(sql`
          select * from chat_thread_queue
          where org_id = ${input.orgId} and thread_id = ${input.threadId} and state in ('queued', 'sending')
          order by seq asc limit 1`),
      )[0];
      return row ? toItem(row) : null;
    }),
  );
}

/* ───────────────────────────── who may still post ───────────────────────────── */

export type Standing = { readonly ok: true; readonly role: "owner" | "participant" } | { readonly ok: false; readonly reason: string };

/**
 * MAY THIS PERSON STILL POST IN THIS CHAT — now, not when they queued? A member of the thread's workspace, and the
 * thread's owner or a live (not revoked) participant of a thread that is still shared. Read in the thread's workspace.
 */
export async function authorStanding(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly author: string },
): Promise<Standing> {
  const a = input.author.toLowerCase();
  const row = rowsOf(
    await runIn(input.orgId, (tx) =>
      tx.execute(sql`
        select lower(t.owner_email) as owner, t.archived_at,
          (select m.role from chat_thread_members m
            where m.thread_id = t.id and lower(m.email) = ${a} and m.status <> 'revoked'
            order by case when m.role = 'participant' then 0 else 1 end limit 1) as role,
          exists (select 1 from org_members o where o.org_id = ${input.orgId} and lower(o.email) = ${a}) as in_org
        from chat_threads t where t.id = ${input.threadId} and t.org_id = ${input.orgId}`),
    ),
  )[0];
  if (!row) return { ok: false, reason: "This chat is no longer here." };
  if (!row.in_org) return { ok: false, reason: "Its sender is no longer a member of this workspace, so it was not sent." };
  if (row.owner === a) return { ok: true, role: "owner" };
  if (row.archived_at) return { ok: false, reason: "This chat is no longer shared, so it was not sent." };
  if (row.role === "participant") return { ok: true, role: "participant" };
  return { ok: false, reason: "Its sender can no longer post in this chat, so it was not sent." };
}

/* ───────────────────────────── the thread mutex ───────────────────────────── */

export interface ThreadClaim {
  readonly holder: string;
  readonly claimedAt: string;
  readonly sessionId: string;
}

/**
 * Take the thread for one turn: free, or held by a claim older than `staleMs` (a sender that died). One statement, so
 * two pumps — or a pump and a stale-claim recovery — can never both take it.
 */
export async function claimThread(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly holder: string; readonly staleMs?: number },
): Promise<ThreadClaim | { readonly busy: true; readonly heldBy: string | null }> {
  const stale = (input.staleMs ?? STALE_CLAIM_MS) / 1000;
  const r = rowsOf(
    await runIn(input.orgId, (tx) =>
      tx.execute(sql`
        update chat_threads set turn_holder = ${input.holder}, turn_claimed_at = clock_timestamp()
        where id = ${input.threadId} and org_id = ${input.orgId} and archived_at is null
          and (turn_holder is null or turn_claimed_at is null
               or turn_claimed_at < clock_timestamp() - make_interval(secs => ${stale}))
        returning eve_session_id, turn_claimed_at::text as claimed_at`),
    ),
  )[0];
  if (r) return { holder: input.holder, claimedAt: String(r.claimed_at), sessionId: String(r.eve_session_id) };
  const held = rowsOf(
    await runIn(input.orgId, (tx) => tx.execute(sql`select turn_holder from chat_threads where id = ${input.threadId}`)),
  )[0];
  return { busy: true, heldBy: (held?.turn_holder as string | null) ?? null };
}

/** Give the thread back, only if this claim still holds it; with the session's fresh token when the turn parked. */
export async function releaseThread(
  runIn: RunIn,
  input: { readonly orgId: string; readonly threadId: string; readonly claim: ThreadClaim; readonly token?: string; readonly sessionId?: string },
): Promise<boolean> {
  const set = input.token
    ? sql`turn_holder = null, turn_claimed_at = null, continuation_token = ${input.token},
          eve_session_id = ${input.sessionId ?? input.claim.sessionId}, updated_at = now()`
    : sql`turn_holder = null, turn_claimed_at = null`;
  const r = rowsOf(
    await runIn(input.orgId, (tx) =>
      tx.execute(sql`
        update chat_threads set ${set}
        where id = ${input.threadId} and turn_holder = ${input.claim.holder}
          and turn_claimed_at = ${input.claim.claimedAt}::timestamptz
        returning id`),
    ),
  );
  return r.length === 1;
}

/* ───────────────────────────── running the queue ───────────────────────────── */

/** What the send looked like from here. */
export interface SendOutcome {
  readonly ok: boolean;
  /** HTTP status; 0 when no answer came (a network failure, a timeout). */
  readonly status: number;
  readonly sessionId?: string;
  readonly detail?: string;
}

export interface PumpDeps {
  readonly runIn: RunIn;
  /** May this page send as `author`? True when the server signs for the author, or the page is the author's own. */
  readonly canSendAs: (author: string) => boolean;
  /**
   * Does the agent hold an owner record for this session in this workspace (`agent_session_owners`)? Without one the
   * agent's door refuses every signed author token, so the session's messages go on their author's own sign-in only.
   * Defaults to {@link sessionOwnerRecorded} (the database read); injected only by tests.
   */
  readonly ownerRecorded?: (orgId: string, sessionId: string) => Promise<boolean>;
  /**
   * Does `forward` send with a single-use token the agent spends at its door (the server signs)? Then a send whose
   * answer was lost can be proved unspent and withdrawn. Without one, such a send is checked in the session's history.
   */
  readonly singleUse: boolean;
  /** The session's continuation token if it is PARKED (its last event is `session.waiting`), else none: a turn runs. */
  readonly parkedToken: (sessionId: string) => Promise<{ readonly token?: string; readonly sessionId: string }>;
  /**
   * Send one message AS `author`, single-use for this claim (`seq`). `signed`: on a token the server signs for the
   * author (bound to this item and thread). Otherwise on the sign-in of the page that runs the queue, which the pump
   * guarantees is the author's own (`author` equals `pumper`); `forward` must refuse anything else.
   */
  readonly forward: (send: {
    readonly signed: boolean;
    readonly sessionId: string;
    /** The thread the item is in: its token is bound to it (the agent admits the author only as ITS participant). */
    readonly thread: string;
    readonly author: string;
    readonly item: string;
    readonly claim: string;
    readonly seq: number;
    readonly message: string;
    readonly continuationToken: string;
  }) => Promise<SendOutcome>;
  /** Read the session until the turn parks; the fresh token, if one was minted. */
  readonly tail: (sessionId: string) => Promise<{ readonly token?: string; readonly sessionId: string }>;
  /**
   * Has the session already received a message sent under any of these claims? "unknown" when its history could not
   * be read in full (a refused, failed or truncated read): that is never taken for "no".
   */
  readonly received: (sessionId: string, claims: readonly string[]) => Promise<Received>;
  /** Override `AUTHOR_WAIT_MS` (tests). */
  readonly authorWaitMs?: number;
  /** A thread claim older than this was abandoned. */
  readonly staleClaimMs?: number;
  /** Override `GIVE_UP_AFTER_MS` (tests). */
  readonly giveUpAfterMs?: number;
  /** Override the back-off (tests). */
  readonly backoffMs?: (attempts: number) => number;
  /** After the item is sent, before the tail: record who wrote the turn. Best effort. */
  readonly onSent?: (item: ThreadQueueItem) => void;
}

export type PumpResult =
  /** Nothing waits that may run now. */
  | { readonly outcome: "empty" }
  /** A turn is running (the thread is held, or the session is not parked): the queue waits for it. */
  | { readonly outcome: "busy"; readonly heldBy: string | null }
  /** The head is its author's to send, and this page cannot send as them (the server cannot sign). */
  | { readonly outcome: "waiting-for-author"; readonly item: ThreadQueueItem }
  /** `item` was sent (or found already delivered) and its turn ran; `parked` when a fresh token came back. */
  | { readonly outcome: "sent"; readonly item: ThreadQueueItem; readonly sessionId: string; readonly parked: boolean }
  /** `item` was not sent: back in the queue for later (`failed: false`), or given up on with a reason. */
  | { readonly outcome: "refused"; readonly item: ThreadQueueItem; readonly failed: boolean; readonly status: number; readonly detail: string };

/** A refusal that a later try may get past: busy (409), slow down (429). */
const TRANSIENT = new Set([409, 425, 429]);
/** No answer, or one that does not say whether the agent took it. */
const ambiguous = (s: SendOutcome) => !s.ok && (s.status === 0 || s.status >= 500);

export function backoff(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

/** A `sending` claim a crashed request left: back in line, its claim remembered (its send may have landed). */
async function releaseStale(tx: Tx, orgId: string, threadId: string): Promise<void> {
  await tx.execute(sql`
    update chat_thread_queue
    set state = 'queued', tried_claims = array_append(tried_claims, claim_id), claim_id = null, claimed_at = null
    where org_id = ${orgId} and thread_id = ${threadId} and state = 'sending'
      and claimed_at < now() - make_interval(secs => ${SENDING_STALE_MS / 1000})`);
}

/**
 * Does the agent hold an owner record for `sessionId` in this workspace (`agent_session_owners`, written by the agent's
 * session guard at creation, or by its own legacy inference — never by a browser)? Read in the workspace's RLS scope.
 * Records are only ever added, so a "yes" stays a "yes". A database without the table answers no (the author's own
 * sign-in, which the agent's gate decides as it always did); any other error is thrown, as every read here is.
 */
export async function sessionOwnerRecorded(runIn: RunIn, orgId: string, sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const row = rowsOf(
      await runIn(orgId, (tx) =>
        tx.execute(sql`
          select 1 as one from agent_session_owners where session_id = ${sessionId} and org_id = ${orgId} limit 1`),
      ),
    )[0];
    return Boolean(row);
  } catch (e) {
    if (isUndefinedTable(e)) return false;
    throw e;
  }
}

/** The session a thread is on now (`chat_threads.eve_session_id`), or "" when the thread is not here. */
async function threadSession(runIn: RunIn, orgId: string, threadId: string): Promise<string> {
  const row = rowsOf(
    await runIn(orgId, (tx) =>
      tx.execute(sql`select eve_session_id from chat_threads where id = ${threadId} and org_id = ${orgId}`),
    ),
  )[0];
  return row?.eve_session_id ? String(row.eve_session_id) : "";
}

/** The oldest item that may run now (not backing off), without claiming it. */
async function nextEligible(runIn: RunIn, orgId: string, threadId: string): Promise<ThreadQueueItem | null> {
  const row = rowsOf(
    await runIn(orgId, (tx) =>
      tx.execute(sql`
        select * from chat_thread_queue
        where org_id = ${orgId} and thread_id = ${threadId} and state = 'queued'
          and (next_attempt_at is null or next_attempt_at <= now())
        order by seq asc limit 1`),
    ),
  )[0];
  return row ? toItem(row) : null;
}

/** Since when THIS item (first in line) has been waiting for its author's page; recorded the first time it is. */
async function waitingForAuthor(runIn: RunIn, orgId: string, itemId: string): Promise<number> {
  const row = rowsOf(
    await runIn(orgId, (tx) =>
      tx.execute(sql`
        update chat_thread_queue set author_wait_since = coalesce(author_wait_since, now())
        where org_id = ${orgId} and id = ${itemId}
        returning author_wait_since`),
    ),
  )[0];
  return ms(row?.author_wait_since) ?? Date.now();
}

/** Claim THIS item for one send, if it is still waiting and nothing of the thread is on its way. */
async function claimItem(runIn: RunIn, orgId: string, item: ThreadQueueItem, claimId: string): Promise<ThreadQueueItem | null> {
  try {
    const row = rowsOf(
      await runIn(orgId, (tx) =>
        tx.execute(sql`
          update chat_thread_queue
          set state = 'sending', claim_id = ${claimId}, claimed_at = now(), attempts = attempts + 1,
              first_attempt_at = coalesce(first_attempt_at, now())
          where org_id = ${orgId} and id = ${item.id} and state = 'queued'
            and not exists (select 1 from chat_thread_queue s
                            where s.org_id = ${orgId} and s.thread_id = ${item.threadId} and s.state = 'sending')
          returning *`),
      ),
    )[0];
    return row ? toItem(row) : null;
  } catch (e) {
    // The one-sending-per-thread index refused a second claim that raced past the NOT EXISTS: someone else has it.
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

async function markSent(runIn: RunIn, orgId: string, item: ThreadQueueItem, claimId: string): Promise<void> {
  await runIn(orgId, (tx) =>
    tx.execute(sql`
      update chat_thread_queue set state = 'sent', sent_at = now(), error = null
      where org_id = ${orgId} and id = ${item.id} and claim_id = ${claimId}`),
  );
}

async function markFailed(runIn: RunIn, orgId: string, itemId: string, reason: string, claimId: string | null): Promise<void> {
  await runIn(orgId, (tx) =>
    tx.execute(sql`
      update chat_thread_queue set state = 'failed', claim_id = null, claimed_at = null, error = ${reason}
      where org_id = ${orgId} and id = ${itemId}
        ${claimId ? sql`and claim_id = ${claimId}` : sql`and state = 'queued'`}`),
  );
}

/** Back in line after a refusal that may pass, not before its back-off. */
async function requeue(
  runIn: RunIn,
  orgId: string,
  item: ThreadQueueItem,
  claimId: string,
  detail: string,
  waitMs: number,
  extra: { readonly tried?: boolean; readonly unspentSeq?: number } = {},
): Promise<boolean> {
  const r = rowsOf(
    await runIn(orgId, (tx) =>
      tx.execute(sql`
        update chat_thread_queue
        set state = 'queued', claim_id = null, claimed_at = null, error = ${detail},
            next_attempt_at = now() + make_interval(secs => ${waitMs / 1000})
            ${extra.tried ? sql`, tried_claims = array_append(tried_claims, ${claimId})` : sql``}
        where org_id = ${orgId} and id = ${item.id} and claim_id = ${claimId}
          ${extra.unspentSeq !== undefined ? sql`and token_seq < ${extra.unspentSeq}` : sql``}
        returning id`),
    ),
  );
  return r.length === 1;
}

/**
 * RUN THE QUEUE — the next item that may run, if the thread is free. See the file comment for the rules. `pumper` is
 * the signed-in member whose request runs it; the message is always sent as its author.
 */
export async function pumpThreadQueue(
  deps: PumpDeps,
  input: { readonly orgId: string; readonly threadId: string; readonly pumper: string },
): Promise<PumpResult> {
  const { runIn } = deps;
  const { orgId, threadId } = input;
  const ready = await withoutTable(false, async () => {
    await runIn(orgId, (tx) => releaseStale(tx, orgId, threadId));
    return true;
  });
  if (!ready) return { outcome: "empty" };

  // May this page run `author`'s message, and how? On a session the agent holds an owner record for: as #197 — a token
  // signed for the author (or, where the server cannot sign, the author's own page). On one it holds none for: the
  // author's own page, on their own sign-in, and never a token (the door would refuse it) — see the file comment, 6.
  const ownerRecorded = deps.ownerRecorded ?? ((o: string, sid: string) => sessionOwnerRecorded(runIn, o, sid));
  const pumper = input.pumper.toLowerCase();
  const own = (author: string) => author.toLowerCase() === pumper;
  const routeFor = (recorded: boolean) => ({
    signed: recorded && deps.singleUse,
    mayRun: (author: string) => (recorded ? deps.canSendAs(author) : own(author)),
  });
  let route = routeFor(await ownerRecorded(orgId, await threadSession(runIn, orgId, threadId)));

  // The head, with every message whose sender may no longer post failed on the way (nothing of theirs is sent), and
  // every one that has waited too long for its author's own page failed too (below), so nobody's line is held for ever.
  let item: ThreadQueueItem | null = null;
  for (let i = 0; i < THREAD_QUEUE_MAX; i++) {
    const next = await nextEligible(runIn, orgId, threadId);
    if (!next) break;
    const standing = await authorStanding(runIn, { orgId, threadId, author: next.authorEmail });
    if (!standing.ok) {
      await markFailed(runIn, orgId, next.id, standing.reason, null);
      continue;
    }
    if (!route.mayRun(next.authorEmail)) {
      // Only the author's own page may send it (a deployment that cannot sign, or a session with no owner record).
      // Wait for it — but not for ever.
      const since = await waitingForAuthor(runIn, orgId, next.id);
      if (Date.now() - since > (deps.authorWaitMs ?? AUTHOR_WAIT_MS)) {
        await markFailed(runIn, orgId, next.id, AUTHOR_GONE_REASON, null);
        continue;
      }
      return { outcome: "waiting-for-author", item: next };
    }
    item = next;
    break;
  }
  if (!item) {
    const head = await headOfQueue(runIn, { orgId, threadId });
    return head?.state === "sending" ? { outcome: "busy", heldBy: head.authorEmail } : { outcome: "empty" };
  }

  const thread = await claimThread(runIn, { orgId, threadId, holder: item.authorEmail, staleMs: deps.staleClaimMs });
  if ("busy" in thread) return { outcome: "busy", heldBy: thread.heldBy };
  const parked = await deps.parkedToken(thread.sessionId);
  if (!parked.token) {
    // A turn is running that this queue did not start (the owner writing straight into their copy of the chat, or a
    // relayed answer): wait for it.
    await releaseThread(runIn, { orgId, threadId, claim: thread });
    return { outcome: "busy", heldBy: null };
  }
  const session = parked.sessionId;
  // The session the send goes to is the one checked (the thread may have moved to another since the check above).
  route = routeFor(await ownerRecorded(orgId, session));
  if (!route.mayRun(item.authorEmail)) {
    await releaseThread(runIn, { orgId, threadId, claim: thread });
    // The same bounded wait as above: the clock starts (or runs on) here too, so this path can never hold the line.
    const since = await waitingForAuthor(runIn, orgId, item.id);
    if (Date.now() - since > (deps.authorWaitMs ?? AUTHOR_WAIT_MS)) {
      await markFailed(runIn, orgId, item.id, AUTHOR_GONE_REASON, null);
      return { outcome: "refused", item, failed: true, status: 0, detail: AUTHOR_GONE_REASON };
    }
    return { outcome: "waiting-for-author", item };
  }
  const claimId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const claimed = await claimItem(runIn, orgId, item, claimId);
  if (!claimed) {
    await releaseThread(runIn, { orgId, threadId, claim: thread });
    return { outcome: "busy", heldBy: null };
  }

  // A send of this item may already have landed (no answer came back): the session's history says, before any resend.
  // A history that could not be read in full proves nothing: the item is then failed as unconfirmed, never resent.
  if (claimed.triedClaims.length > 0) {
    let seen: Received;
    try {
      seen = await deps.received(session, claimed.triedClaims);
    } catch {
      seen = "unknown";
    }
    if (seen === "yes") {
      await markSent(runIn, orgId, claimed, claimId);
      await releaseThread(runIn, { orgId, threadId, claim: thread, token: parked.token, sessionId: session });
      return { outcome: "sent", item: claimed, sessionId: session, parked: true };
    }
    if (seen === "unknown") {
      await markFailed(runIn, orgId, claimed.id, UNCONFIRMED_REASON, claimId);
      await releaseThread(runIn, { orgId, threadId, claim: thread });
      return { outcome: "refused", item: claimed, failed: true, status: 0, detail: UNCONFIRMED_REASON };
    }
  }

  const seq = claimed.tokenSeq + 1;
  let sent: SendOutcome;
  try {
    sent = await deps.forward({
      signed: route.signed,
      sessionId: session,
      thread: threadId,
      author: claimed.authorEmail,
      item: claimed.id,
      claim: claimId,
      seq,
      message: fromLine(claimed.authorEmail, claimed.text) + deliveryReference(claimId),
      continuationToken: parked.token,
    });
  } catch (e) {
    sent = { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }

  if (sent.ok) {
    await markSent(runIn, orgId, claimed, claimId);
    deps.onSent?.(claimed);
    const after = await deps.tail(sent.sessionId ?? session);
    // A tail severed before the turn parked proves nothing: the turn may still run. Then the claim is KEPT (holder and
    // time), so the stale-claim takeover fires later instead of the next send going in at once.
    if (after.token) await releaseThread(runIn, { orgId, threadId, claim: thread, token: after.token, sessionId: after.sessionId });
    return { outcome: "sent", item: claimed, sessionId: after.sessionId, parked: Boolean(after.token) };
  }

  const detail = `The agent did not take the message (${sent.status || "no answer"}). ${sent.detail ?? ""}`.trim();
  const wait = (deps.backoffMs ?? backoff)(claimed.attempts);
  if (ambiguous(sent)) {
    // Unknown: never repeated blindly. If the agent's door never spent this claim's token, withdrawing the claim makes
    // a late copy unacceptable (the claim it names is gone) — then it is safe to try again later. Otherwise it is
    // remembered, and the session's history is checked before any resend; the thread stays held only as long as a
    // turn may be running from it (the next pump reads the session).
    const withdrawn = route.signed && (await requeue(runIn, orgId, claimed, claimId, detail, wait, { unspentSeq: seq }));
    if (!withdrawn) await requeue(runIn, orgId, claimed, claimId, detail, 0, { tried: true });
    await releaseThread(runIn, { orgId, threadId, claim: thread });
    return { outcome: "refused", item: claimed, failed: false, status: sent.status, detail };
  }
  const permanent = !TRANSIENT.has(sent.status);
  const firstAt = claimed.firstAttemptAt ?? Date.now();
  const tooLong =
    claimed.attempts >= MAX_ATTEMPTS && Date.now() - firstAt > (deps.giveUpAfterMs ?? GIVE_UP_AFTER_MS);
  if (permanent || tooLong) await markFailed(runIn, orgId, claimed.id, detail, claimId);
  else await requeue(runIn, orgId, claimed, claimId, detail, wait);
  await releaseThread(runIn, { orgId, threadId, claim: thread });
  return { outcome: "refused", item: claimed, failed: permanent || tooLong, status: sent.status, detail };
}

/**
 * THE DIRECT PATH's half of the mutex: an answer to the turn's own question, or a message when there is no queue table.
 * Take the thread, read the parked session's token, or say who (or what) holds it.
 */
export async function claimForDirectSend(
  deps: Pick<PumpDeps, "runIn" | "parkedToken" | "staleClaimMs">,
  input: { readonly orgId: string; readonly threadId: string; readonly holder: string },
): Promise<
  | { readonly claim: ThreadClaim; readonly token: string; readonly sessionId: string }
  | { readonly busy: true; readonly heldBy: string | null }
> {
  const thread = await claimThread(deps.runIn, { ...input, staleMs: deps.staleClaimMs });
  if ("busy" in thread) return thread;
  const parked = await deps.parkedToken(thread.sessionId);
  if (!parked.token) {
    await releaseThread(deps.runIn, { ...input, claim: thread });
    return { busy: true, heldBy: null };
  }
  return { claim: thread, token: parked.token, sessionId: parked.sessionId };
}
