"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { INVITE_RESULT_KEY } from "./auth-gate";
import { AgentChat, type AgentEvents, type AgentSession } from "./agent-chat";
import { ChatSidebar } from "./chat-sidebar";
import { ChatSearchDialog } from "./chat-search";
import { CUSTOMERS, Dataroom, type DataroomTab } from "./dataroom";
import type { CustomerListItem } from "./customer-search";
import { OpsCenter, type OpsSection } from "./ops-center";
import { activeOrg, opsFetch } from "./ops/lib";
import { cn } from "@/lib/utils";

/** A thread shared with the current user (from GET /api/ops/threads). Never
 *  carries the continuation token — a shared thread is opened read-only. */
export interface SharedThread {
  id: string;
  eveSessionId: string;
  title: string;
  preview?: string | null;
  customers?: string[];
  ownerEmail: string;
  role: string;
  clientEvents?: unknown[];
  updatedAt: string;
}

export interface StoredSession {
  id: string;
  /** Stable per-mount key. Lets us keep ONE sidebar entry per conversation even
   *  if eve re-mints the session id mid-chat (e.g. after a stream/billing error),
   *  which otherwise forks the thread into a duplicate entry. */
  clientKey?: string;
  title: string;
  preview?: string;
  messageCount?: number;
  customer?: string; // legacy single-customer (migrated on read)
  customers?: string[];
  archived?: boolean;
  /** The thread this one was forked from (a plan → new-thread fork), so the
   *  fork can link back to its origin. */
  forkedFrom?: { id: string; title: string };
  session: AgentSession;
  events?: AgentEvents; // event stream, to restore message history on reopen
  updatedAt: number;
  /** Sidebar metadata SNAPSHOTTED from the full event stream at persist time, so
   *  the second row (customer badge, artifact/email counts) still renders after
   *  the events are stripped to fit quota — no blank row until the chat is
   *  reopened. Recomputed live from `events` whenever those are present. */
  derivedCustomers?: string[];
  toolCounts?: { artifacts: number; emails: number; subagents?: number };
  /** Teammates invited to this thread (non-owner members), from the DB mirror. */
  invitees?: string[];
}

/** Metadata row from GET /api/ops/chat-sessions (the durable per-user mirror). */
interface DbChatSession {
  id: string;
  clientKey?: string;
  title?: string;
  preview?: string;
  messageCount?: number;
  customers?: string[];
  forkedFrom?: { id: string; title: string };
  eveSessionId?: string;
  continuationToken?: string;
  derivedCustomers?: string[];
  toolCounts?: { artifacts: number; emails: number; subagents?: number };
  invitees?: string[];
  updatedAt?: number;
}

/**
 * Drop EXACT-duplicate events from a stored stream, keeping the first of each.
 *
 * The eve message reducer upserts by message id, so replaying an identical event
 * twice yields the same messages as replaying it once — duplicates are pure
 * redundancy. But they DO accumulate: (a) every persist re-appends the synthetic
 * `client.input.responded` markers (they never live in `agent.events`), so each
 * reload adds another identical copy; (b) a mid-stream reattach after a stream
 * error re-appends byte-identical turn events to the store's raw list. Left in,
 * a corrupted/bloated stream is what renders as duplicated / jumbled / blank
 * messages on reopen. Collapsing exact duplicates is safe (it can't change a
 * clean stream's projection) and keeps the persisted payload from ballooning.
 */
/**
 * The session cursor, with its resume token repaired from the stream.
 *
 * A session parked on user input carries its resume token on the latest
 * `session.waiting` EVENT; the store's `session` cursor only advances at a clean
 * turn boundary, so it can be handed over WITHOUT the token. Resuming from such
 * a cursor sends an empty continuationToken, which eve rejects ("Missing or
 * empty 'continuationToken' field") and the next message is lost.
 */
export function withFreshestToken(session: AgentSession, events: readonly unknown[]): AgentSession {
  if (session.continuationToken) return session;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { continuationToken?: string } };
    if (e?.type === "session.waiting" && typeof e.data?.continuationToken === "string" && e.data.continuationToken) {
      return { ...session, continuationToken: e.data.continuationToken };
    }
  }
  return session;
}

export function dedupeEvents<T>(events: readonly T[] | undefined): T[] {
  if (!events?.length) return events ? [...events] : [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    let key: string;
    try {
      key = JSON.stringify(e);
    } catch {
      out.push(e);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Customer ids referenced anywhere in a chat's event stream (matched against a
 *  known id set). Shared by the sidebar (live) and persist (snapshot). */
export function inferCustomersFromEvents(
  events: readonly unknown[] | undefined,
  idSet: ReadonlySet<string>,
): string[] {
  if (!events?.length || idSet.size === 0) return [];
  const found = new Set<string>();
  for (const raw of events) {
    const e = raw as { type?: string; data?: Record<string, unknown> };
    let text = "";
    if (e.type === "message.received") text = JSON.stringify(e.data ?? "");
    else if (e.type === "actions.requested") text = JSON.stringify(e.data?.actions ?? "");
    else if (e.type === "input.requested") text = JSON.stringify(e.data?.requests ?? "");
    if (!text) continue;
    for (const tok of text.toLowerCase().split(/[^a-z0-9-]+/)) {
      if (idSet.has(tok)) found.add(tok);
    }
  }
  return [...found];
}

export interface ChatMeta {
  title: string;
  preview?: string;
  messageCount?: number;
  customers?: string[];
  forkedFrom?: { id: string; title: string };
}

/** Read a session's customers, migrating the legacy single-customer field. */
export function sessionCustomers(s: StoredSession): string[] {
  if (s.customers?.length) return s.customers;
  return s.customer ? [s.customer] : [];
}

/** Count published artifacts + drafted emails in a chat. Prefers the snapshot
 *  taken at persist time (survives event stripping); falls back to a live scan
 *  of the event stream when it's present. */
export function chatToolCounts(s: StoredSession): { artifacts: number; emails: number; subagents: number } {
  if (!s.events?.length && s.toolCounts) {
    return { artifacts: s.toolCounts.artifacts, emails: s.toolCounts.emails, subagents: s.toolCounts.subagents ?? 0 };
  }
  let artifacts = 0;
  let emails = 0;
  let subagents = 0;
  const bump = (tool: unknown) => {
    if (tool === "publish_artifact") artifacts++;
    else if (tool === "email_create_draft") emails++;
  };
  for (const raw of (s.events ?? []) as Array<{
    type?: string;
    data?: { result?: { toolName?: string }; event?: { type?: string; data?: { result?: { toolName?: string } } } };
  }>) {
    if (raw.type === "subagent.called") subagents++;
    else if (raw.type === "action.result") bump(raw.data?.result?.toolName);
    else if (raw.type === "subagent.event" && raw.data?.event?.type === "action.result") {
      bump(raw.data.event.data?.result?.toolName);
    }
  }
  return { artifacts, emails, subagents };
}

/** Compact "2m ago" / "3h ago" / "Jul 4" relative time. */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ChatShellProps {
  readonly getAuthHeaders: () => Record<string, string>;
  readonly email: string | null;
  readonly name: string | null;
  readonly picture: string | null;
  readonly onSignOut: () => void;
}

function storageKey(email: string | null) {
  /**
   * Keyed by workspace as well as by person.
   *
   * It was keyed by email alone, so one browser held ONE thread list across
   * every workspace: switching workspace kept the previous tenant's chats in
   * the sidebar under the new tenant's name. Worse, the list is mirrored to
   * the server on sync, which is how conversations physically migrated between
   * workspaces.
   *
   * A workspace you have not opened yet simply starts empty and fills from the
   * server, which is org-scoped and owns the list anyway.
   */
  return `fde-chats:${email ?? "anon"}:${activeOrg() ?? "default"}`;
}

/** A ceiling so a runaway can't wedge storage — far above any real sidebar. */
const STORAGE_MAX_CHATS = 300;

/**
 * Persist the session list to localStorage.
 *
 * The payload embeds each chat's full event stream, which grows without bound
 * and eventually blows the ~5 MB quota. The FIRST version of this fix evicted
 * old chats on overflow — which is why the sidebar started "pruning chats from
 * the beginning". The SECOND version fixed that but always stripped events down
 * to the 4 most-recent chats, so after a reload every older chat had to REPLAY
 * its whole stream from the server on open — which is why switching threads went
 * "very very slow".
 *
 * This version keeps events for as MANY recent chats as actually FIT: it tries
 * to persist everything, and only when that overflows does it strip the oldest
 * chats' event streams (progressively) until it fits. A chat whose events are
 * cached opens instantly; only the oldest, quota-permitting, re-hydrate from the
 * server (`openChat`/`replaySession`). Metadata for EVERY chat is always kept,
 * so the sidebar list never loses an entry. The active/`protect`ed chats always
 * keep their events regardless of position.
 */
function writeSessions(email: string | null, sessions: StoredSession[], protect: ReadonlySet<string>): boolean {
  const key = storageKey(email);
  const list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = (s: StoredSession) => protect.has(s.id) || protect.has(s.clientKey ?? "");
  // Keep full events for the first `n` chats (and any protected one anywhere);
  // strip the rest to metadata only.
  const stripBeyond = (n: number): StoredSession[] =>
    list.map((s, i) => (i < n || kept(s) ? s : { ...s, events: undefined }));
  const tryWrite = (l: StoredSession[]): boolean => {
    try {
      localStorage.setItem(key, JSON.stringify(l));
      return true;
    } catch {
      return false;
    }
  };
  // Try to keep ALL events, then back off the kept-count until it fits — so the
  // most-recent chats stay cached (instant open) and only the oldest are stripped
  // when genuinely over quota. Coarse steps keep this to a handful of attempts.
  const steps = [list.length, 64, 32, 16, 8, 4, 2, 0].filter(
    (n, i, a) => n <= list.length && a.indexOf(n) === i,
  );
  for (const n of steps) {
    if (tryWrite(stripBeyond(n))) return true;
  }
  // Truly pathological single huge chat — cap the count (very high), metadata only.
  console.warn("[chat-shell] localStorage still over quota after stripping all event streams — capping chat count.");
  return tryWrite(stripBeyond(0).slice(0, STORAGE_MAX_CHATS));
}

/**
 * The chat, while it is being fetched.
 *
 * Replaces a small spinner drawn over the PREVIOUS thread: the old content
 * stayed on screen behind a translucent wash, so a slow open looked like a
 * click that did nothing. This covers the pane and takes the shape of what is
 * coming, which makes the wait legible even when it is long.
 *
 * A holding pattern, not a fix — replays can take seconds and that is the real
 * bug. `aria-busy` and the label keep it honest for anyone not watching pixels.
 */
function ChatShimmer() {
  // Deterministic widths: a random ratio per render makes the skeleton twitch
  // on every re-render, which is worse than a static one.
  const lines = [
    ["78%", "92%", "54%"],
    ["88%", "63%"],
    ["70%", "95%", "84%", "41%"],
  ];
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
      className="absolute inset-0 z-20 flex flex-col bg-background"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 overflow-hidden px-6 pt-12">
        {lines.map((widths, i) => (
          <div key={i} className={cn("flex flex-col gap-2", i % 2 === 1 && "items-end")}>
            <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
            {widths.map((w, j) => (
              <div
                key={j}
                className="h-3.5 animate-pulse rounded bg-muted/50"
                style={{ width: w, animationDelay: `${(i * 3 + j) * 70}ms` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-8">
        <div className="h-24 w-full animate-pulse rounded-2xl border border-border/60 bg-muted/30" />
      </div>
      <span className="sr-only">Loading conversation…</span>
    </div>
  );
}

export function ChatShell({ getAuthHeaders, email, name, picture, onSignOut }: ChatShellProps) {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  // Customer list for the per-chat context selector. Fetched from the system of
  // record (Postgres) at runtime via /api/ops/customers — NOT the bundled
  // data/customers.json (empty in this deployment). The feed carries each
  // customer's summary (tier/stage/status/health/owner + last touch) inline so
  // the selector renders a real one-line summary. Seed with the bundled CUSTOMERS
  // so there's something before the fetch resolves.
  const [customerOptions, setCustomerOptions] = useState<CustomerListItem[]>(CUSTOMERS);
  // Live customer id set for the persist-time metadata snapshot (read from the
  // deps-[] persist callback via a ref). Approximate is fine.
  const customerIdSetRef = useRef<ReadonlySet<string>>(new Set());
  customerIdSetRef.current = new Set(customerOptions.map((c) => c.id.toLowerCase()));
  const [collapsed, setCollapsed] = useState(false);
  // On a phone the sidebar cannot sit beside the chat: at 320px wide it left 64px for the whole
  // conversation and the header's controls fell off the right edge (measured by the factory's
  // responsiveness lane, signed in). Below md it starts closed and, once opened, overlays the chat.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    if (mq.matches) setCollapsed(true);
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setCollapsed(true); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  // True while a clicked thread is replaying its transcript from the server
  // (uncached open) — drives a loading overlay so the click feels immediate.
  const [openingChat, setOpeningChat] = useState(false);
  const [dataroomOpen, setDataroomOpen] = useState(false);
  const [dataroomTab, setDataroomTab] = useState<DataroomTab>("customers");
  const [dataroomSheet, setDataroomSheet] = useState<string | undefined>(undefined);
  const [opsOpen, setOpsOpen] = useState(false);
  const [opsSection, setOpsSection] = useState<OpsSection>("connectors");
  const [opsInitialId, setOpsInitialId] = useState<string | undefined>(undefined);
  const [opsInitialView, setOpsInitialView] = useState<
    "tasks" | "sprints" | "deployments" | "implementations" | undefined
  >(undefined);
  const openOps = useCallback((section: OpsSection, id?: string) => {
    setOpsSection(section);
    setOpsInitialId(id);
    setOpsOpen(true);
  }, []);

  // Deep-link support: `/?ops=<connectors|workflows|crons>&id=<row-id>` opens
  // the Ops Center on that section with that row's detail panel open (`id` may
  // be a system cron NAME for the crons section). Read once on mount, in an
  // effect, so SSR/hydration never sees it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    /**
     * `?dataroom=<tab>` opens the data room on a tab. The onboarding checks link
     * here ("Onboard the first customer"), and without it the only honest
     * destination was a page that merely contained the thing being asked for.
     */
    const dataroom = params.get("dataroom");
    const DATAROOM_TABS = [
      "customers", "platform", "deployments", "solutions", "implementation",
      "tickets", "people", "interactions", "internal-staff", "customer-stakeholders",
    ];
    if (dataroom && DATAROOM_TABS.includes(dataroom)) {
      setDataroomTab(dataroom as DataroomTab);
      setDataroomOpen(true);
    }
    const ops = params.get("ops");
    if (ops === "connectors" || ops === "workflows" || ops === "crons" || ops === "apps" || ops === "todos" || ops === "inbox") {
      setOpsSection(ops);
      setOpsInitialId(params.get("id") ?? undefined);
      const view = params.get("view");
      if (view === "tasks" || view === "sprints" || view === "deployments" || view === "implementations") {
        setOpsInitialView(view);
      }
      setOpsOpen(true);
    }
  }, []);
  const openDataroom = useCallback((tab: DataroomTab, sheet?: string) => {
    setDataroomTab(tab);
    setDataroomSheet(sheet);
    setDataroomOpen(true);
  }, []);

  // Load the real customer list (system of record) for the context selector.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ops/customers", { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = (await res.json()) as { customers?: CustomerListItem[] };
        if (!cancelled && data.customers?.length) setCustomerOptions(data.customers);
      } catch {
        /* keep the bundled fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAuthHeaders]);

  // What the mounted AgentChat is: a stable key + the session it seeds from.
  /**
   * Mount keys must be unique FOREVER, not just within a page load.
   *
   * `newCount` is a ref that resets on every reload, so the first chat you
   * typed into after a refresh was always `new-1` — the same key the previous
   * session's first chat carried. handlePersist reconciles on clientKey FIRST,
   * so that new conversation matched the OLD one's stored entry and overwrote
   * its title, preview, session id and events. The old conversation lost its
   * only index row and became unreachable.
   *
   * On the server it is worse than data loss: threads/route.ts prefers a
   * clientKey match too, so a recycled key can re-point an existing
   * chat_threads row — and the chat_thread_members already on it — at an
   * unrelated conversation. That is a disclosure.
   *
   * A random suffix costs nothing and removes the entire class.
   */
  const mintKey = (prefix: string) =>
    `${prefix}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const [mountKey, setMountKey] = useState(() => mintKey("new"));
  /**
   * Bumped to force a REMOUNT of the same chat, which is the only way to make
   * the eve store re-open a stream (it reads its session config once, at
   * creation). Deliberately separate from mountKey: mountKey is the chat's
   * persistence identity, so bumping THAT would file the recovered thread as a
   * new chat instead of continuing this one.
   */
  const [attachNonce, setAttachNonce] = useState(0);
  const [initialSession, setInitialSession] = useState<AgentSession | undefined>(undefined);
  const [initialEvents, setInitialEvents] = useState<AgentEvents | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeCustomers, setActiveCustomers] = useState<string[]>([]);
  // When the current mount is a shared thread opened by a non-owner: the owner's
  // email drives the view-only composer notice. Cleared on any other open.
  const [readOnlyOwner, setReadOnlyOwner] = useState<string | undefined>(undefined);
  // Set when the current mount is a shared thread this PARTICIPANT can send into
  // — sends route through the relay. Distinct from readOnly (viewer).
  const [relayThreadId, setRelayThreadId] = useState<string | undefined>(undefined);
  const [sharedReopen, setSharedReopen] = useState<SharedThread | null>(null);
  // Threads shared WITH me (role !== owner), for the sidebar "Shared with you".
  const [sharedThreads, setSharedThreads] = useState<SharedThread[]>([]);
  const newCount = useRef(0);
  /**
   * Has the durable thread list been merged in yet?
   *
   * The sign-in backfill pushes every LOCAL thread up to the mirror. Run before
   * the merge, it re-uploads threads that were deleted on another device —
   * resurrecting them everywhere, permanently, because each device then keeps
   * re-pushing them. Deletion could never stick. The backfill now waits.
   */
  const [mergedFromDb, setMergedFromDb] = useState(false);
  // The last list load failed: what is on screen is the cache, not the truth.
  const [listStale, setListStale] = useState(false);

  // Load persisted sessions for this user. Drop any workflow/cron-opened threads
  // (clientKey "eve-…") that a previous build persisted — they are ephemeral and
  // must not survive a reload; re-save the cleaned list so they never return.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(email));
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredSession[];
      const cleaned = stored
        // `shared-…` entries are other people's threads that an earlier build
        // filed here. They belong under "Shared with you", which reads from the
        // server, so dropping them locally is a repair, not a loss.
        .filter((s) => !s.clientKey?.startsWith("eve-") && !s.clientKey?.startsWith("shared-"))
        .filter((s) => !s.id?.startsWith("shared-"))
        // Heal streams a previous build stored with accumulated duplicates
        // (which rendered as duplicated / jumbled / blank messages on reopen).
        .map((s) => (s.events?.length ? { ...s, events: dedupeEvents(s.events) as AgentEvents } : s));
      setSessions(cleaned);
      if (cleaned.length !== stored.length) {
        localStorage.setItem(storageKey(email), JSON.stringify(cleaned));
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, [email]);

  /**
   * THE SERVER OWNS THE LIST. localStorage owns the transcripts.
   *
   * This used to be a merge between two stores that each thought they were
   * authoritative, and every bug in the sidebar came out of that one decision:
   * a thread renamed on another device kept its stale title; a deleted one came
   * back because the local copy outlived the row; someone else's shared thread
   * got filed under Chats as yours. Each was fixed with another merge rule, and
   * the next one was always waiting.
   *
   * So the list is now REPLACED by the server's, not reconciled with it. The
   * server row is the existence, the name, the ownership. The only thing kept
   * from local state is the cached `events` transcript, which the mirror does
   * not store and which is what makes reopening a thread instant.
   *
   * Local-only rows survive exactly one case: a chat created moments ago whose
   * first sync has not landed. Anything older that the server does not know
   * about is not "unsynced", it is deleted — and deleting is the operation that
   * never used to stick.
   *
   * Fail-safe: a failed request leaves the cached list alone. Being briefly
   * stale beats emptying someone's sidebar because a fetch lost a race.
   */
  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    void (async () => {
      try {
        // One retry: a single unlucky request should not leave the sidebar
        // stale for the rest of the session.
        let res = await fetch("/api/ops/chat-sessions", { headers: getAuthHeaders() });
        if (!res.ok && res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled) return;
          res = await fetch("/api/ops/chat-sessions", { headers: getAuthHeaders() });
        }
        /**
         * A response we cannot trust must not become the list.
         *
         * The server replies 503 when it could not read the store (it used to
         * reply "200 []", which this code faithfully applied — the sidebar
         * painted from cache and then emptied itself a moment later). Keeping
         * the cache and flagging it stale is the only safe move: the list is
         * server-owned, but only once the server has actually spoken.
         */
        if (!res.ok) {
          if (!cancelled) setListStale(true);
          return;
        }
        const { items } = (await res.json()) as { items?: DbChatSession[] };
        if (cancelled || !Array.isArray(items)) return;
        setListStale(false);
        setSessions((prev) => {
          const cachedById = new Map(prev.map((s) => [s.id, s]));
          const GRACE_MS = 5 * 60 * 1000;
          const now = Date.now();

          const fromServer: StoredSession[] = items
            .filter((it) => it.eveSessionId) // un-replayable rows can never open
            .map((it) => {
              const cached = cachedById.get(it.id);
              return {
                id: it.id,
                clientKey: it.clientKey ?? cached?.clientKey,
                title: it.title || cached?.title || "Chat",
                preview: it.preview ?? cached?.preview,
                messageCount: it.messageCount ?? cached?.messageCount,
                customers: it.customers ?? cached?.customers,
                forkedFrom: it.forkedFrom ?? cached?.forkedFrom,
                session: {
                  sessionId: it.eveSessionId as string,
                  continuationToken: it.continuationToken ?? cached?.session?.continuationToken,
                  streamIndex: cached?.session?.streamIndex ?? 0,
                },
                // The one thing the server does not have.
                events: cached?.events,
                updatedAt: it.updatedAt ?? cached?.updatedAt ?? now,
                derivedCustomers: it.derivedCustomers ?? cached?.derivedCustomers,
                toolCounts: it.toolCounts ?? cached?.toolCounts,
                invitees: it.invitees,
              };
            });

          const known = new Set(fromServer.map((s) => s.id));
          const unsynced = prev.filter(
            (s) => !known.has(s.id) && (now - s.updatedAt < GRACE_MS || !s.session?.sessionId),
          );
          return [...fromServer, ...unsynced];
        });
        if (!cancelled) setMergedFromDb(true);
      } catch {
        // Offline — keep the cached list, and do not treat it as reconciled.
        if (!cancelled) setListStale(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, getAuthHeaders]);

  // Durable per-user mirror of the thread list (metadata only — history replays
  // from the eve session on open). localStorage stays the instant-open cache;
  // this lets a user's chats follow their account across devices. Debounced,
  // fire-and-forget, and fail-safe (no-ops before the migration / offline).
  const dbSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The newest list awaiting a write, and when it STARTED waiting.
   *
   * Both exist because the debounce alone loses chats. Every call used to clear
   * the timer, and a streaming turn calls this on every message — so the write
   * was starved for the entire turn and only landed 1.5s after the stream went
   * quiet. Close the tab, navigate, or lose the tab to a background purge inside
   * that window and the conversation was never recorded at all: no sidebar row,
   * and since the mirror is the only index of your chats, no way back to it. A
   * completed 3,000-character answer was lost that way today.
   */
  const pendingSessions = useRef<StoredSession[] | null>(null);
  const pendingSince = useRef<number>(0);
  /** Set when writes are failing, so the sidebar can stop claiming all is well. */
  const [syncFailed, setSyncFailed] = useState(false);
  /** However busy the stream, never go longer than this without a write. */
  const MAX_SYNC_WAIT_MS = 5000;

  /**
   * Write now. `onUnload` uses `keepalive` so the request survives the page
   * going away — the ordinary fetch is cancelled on unload, which is precisely
   * when the last and most valuable write happens.
   */
  /**
   * Put a failed write back in the queue WITHOUT clobbering anything newer.
   *
   * The retry used to assign `pendingSessions.current = list` unconditionally,
   * where `list` was captured before the request went out. A newer snapshot
   * queued while that request was in flight — which is normal during a
   * streaming turn, and failures happen precisely when the network is bad —
   * was overwritten by the older one, so the row that finally landed was the
   * pre-failure state.
   */
  const requeue = useCallback((list: StoredSession[], onUnload: boolean) => {
    if (onUnload) return; // the page is gone; there is nothing left to retry with
    pendingSessions.current ??= list;
    if (!pendingSince.current) pendingSince.current = Date.now();
    if (dbSyncTimer.current) clearTimeout(dbSyncTimer.current);
    dbSyncTimer.current = setTimeout(() => flushRef.current?.(), 4000);
  }, []);
  /** Set below; breaks the requeue → flush → requeue reference cycle. */
  const flushRef = useRef<((onUnload?: boolean) => void) | null>(null);

  /**
   * A failed save reached the sidebar but never reached us — so "chat lost my
   * conversation" arrived as a support message rather than a number. Reported
   * once per failure, never awaited, and it must never itself break a save.
   */
  const reportSaveFailure = useCallback(
    (detail: string) => {
      try {
        void fetch("/api/ops/chat-telemetry", {
          method: "POST",
          headers: { "content-type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ kind: "save-failed", detail: detail.slice(0, 300) }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* never */
      }
    },
    [getAuthHeaders],
  );

  const flushSessions = useCallback(
    (onUnload = false) => {
      const list = pendingSessions.current;
      if (!list || !email) return;
      pendingSessions.current = null;
      pendingSince.current = 0;
      if (dbSyncTimer.current) {
        clearTimeout(dbSyncTimer.current);
        dbSyncTimer.current = null;
      }
      // keepalive bodies are capped (~64KB), so an unload write carries fewer
      // rows rather than being silently dropped for being too large. The most
      // recently touched chats are the ones worth saving.
      const sessions = list.slice(0, onUnload ? 40 : 200).map((s) => ({
        id: s.id,
        clientKey: s.clientKey ?? null,
        title: s.title ?? null,
        preview: s.preview ?? null,
        messageCount: s.messageCount ?? null,
        customers: s.customers ?? null,
        forkedFrom: s.forkedFrom ?? null,
        eveSessionId: s.session?.sessionId ?? null,
        continuationToken: s.session?.continuationToken ?? null,
        derivedCustomers: s.derivedCustomers ?? null,
        toolCounts: s.toolCounts ?? null,
        archived: Boolean(s.archived),
        updatedAt: s.updatedAt,
      }));
      if (sessions.length === 0) return;
      void fetch("/api/ops/chat-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ sessions }),
        keepalive: onUnload,
      })
        .then((r) => {
          // A rejected write used to be swallowed whole. It is the difference
          // between "your chats are saved" and "your chats are gone", so it is
          // retried once and then said out loud.
          if (r.ok) return setSyncFailed(false);
          requeue(list, onUnload);
          setSyncFailed(true);
          reportSaveFailure(`status ${r.status}`);
        })
        .catch((e: unknown) => {
          requeue(list, onUnload);
          setSyncFailed(true);
          reportSaveFailure(e instanceof Error ? e.message : "network");
        });
    },
    [email, getAuthHeaders, requeue],
  );
  flushRef.current = flushSessions;

  /**
   * Sign-in can resolve AFTER the first chats exist. Every write attempted
   * before then returned early on `!email` and nothing re-triggered it, so the
   * opening moments of a session could go unrecorded. Flush once we have an
   * identity to write under.
   */
  useEffect(() => {
    if (email && pendingSessions.current) flushSessions();
  }, [email, flushSessions]);

  /**
   * Flush whenever the page might be going away. `pagehide` covers navigation,
   * tab close and the bfcache; `visibilitychange` covers a phone being locked or
   * the tab being backgrounded, which on mobile is often the last event a page
   * ever receives.
   */
  useEffect(() => {
    const onHide = () => flushSessions(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSessions(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmounting is also a departure — don't drop what is queued.
      flushSessions(true);
    };
  }, [flushSessions]);

  /**
   * Queue a write. Debounced so a burst of stream updates is one request, with a
   * MAX WAIT so a continuous burst cannot postpone it indefinitely — the old
   * version reset its timer on every call, so a long streaming turn wrote
   * nothing until the stream fell silent.
   */
  const syncSessionsToDb = useCallback(
    (list: StoredSession[], immediate = false) => {
      if (!email) return;
      pendingSessions.current = list.filter((s) => s.session?.sessionId || s.id);
      if (!pendingSince.current) pendingSince.current = Date.now();
      // A brand-new chat registers NOW. The index row must not lose a race with
      // the conversation it indexes, and the first seconds — before any
      // debounce could elapse — are exactly when a tab gets closed again.
      if (immediate) return flushSessions();
      // Waited long enough already — write now rather than debouncing again.
      if (Date.now() - pendingSince.current >= MAX_SYNC_WAIT_MS) return flushSessions();
      if (dbSyncTimer.current) clearTimeout(dbSyncTimer.current);
      dbSyncTimer.current = setTimeout(() => flushSessions(), 1500);
    },
    [email, flushSessions],
  );

  /**
   * A ref so `handlePersist` can reach the CURRENT sync function without taking
   * it as a dependency — handlePersist is passed to the chat component and must
   * stay referentially stable, or every re-render remounts the persistence
   * effect.
   */
  const syncRef = useRef<((list: StoredSession[], immediate?: boolean) => void) | null>(null);
  syncRef.current = syncSessionsToDb;

  const activeIdForWrite = useRef<string | null>(null);
  const persist = useCallback(
    (next: StoredSession[]) => {
      setSessions(next);
      // The in-memory state keeps everything; the WRITE may be pruned to fit,
      // always sparing the active chat's events.
      writeSessions(email, next, new Set([activeIdForWrite.current ?? ""]));
      syncSessionsToDb(next);
    },
    [email, syncSessionsToDb],
  );

  // Called by the live chat as it gains a server session + a first line.
  /**
   * "Continue" on a cut-off reply: remount THIS chat on its own cursor so a
   * fresh store re-opens the stream and collects the rest of the turn.
   *
   * The chat's persistence identity (`chatKey`) is deliberately untouched — only
   * the React key moves — so the recovered transcript updates the existing
   * thread rather than appearing as a second one in the sidebar.
   */
  const reattach = useCallback((session: AgentSession, events: AgentEvents) => {
    const clean = dedupeEvents(events) as AgentEvents;
    setInitialSession(withFreshestToken(session, clean));
    setInitialEvents(clean);
    setAttachNonce((n) => n + 1);
  }, []);

  const handlePersist = useCallback(
    (rawSession: AgentSession, meta: ChatMeta, rawEvents: AgentEvents, chatKey: string) => {
      const id = rawSession.sessionId;
      if (!id) return;
      // Collapse exact-duplicate events (accumulated `client.input.responded`,
      // byte-identical reattach re-emissions) BEFORE anything else keys off the
      // length — so the stored stream stays clean and the anti-truncation guard
      // compares like with like.
      const events = dedupeEvents(rawEvents) as AgentEvents;
      // A session parked on user input carries its resume token on the latest
      // `session.waiting` EVENT — the store's `session` cursor can lag (it only
      // advances at a clean turn boundary) and be persisted WITHOUT the token.
      // Reopening such an entry then continues with an empty continuationToken,
      // which eve rejects ("Missing or empty 'continuationToken' field") and the
      // next message / clarification answer is lost. Backfill the freshest token
      // from the stream so a reopened thread can always resume.
      const session = withFreshestToken(rawSession, events);
      // Threads opened FROM a workflow/cron run (mountEveSession → chatKey
      // "eve-…") are EPHEMERAL: they are a live view onto an automation's own
      // session, not a chat the user started. Persisting them would put a
      // deletable entry in the sidebar whose deletion breaks the underlying
      // run, and it would linger after a reload. Never store them.
      //
      // A SHARED thread is not yours either. It mounts with a `shared-…` key,
      // and persisting it filed somebody else's conversation in your own chat
      // list — under "Chats", with your archive and delete buttons on it, and
      // with no share marker, because as far as the sidebar was concerned it
      // was one of yours. Same shape as the thread-row fork this had on the
      // server: opening someone's thread quietly made you a copy of it.
      if (chatKey.startsWith("eve-") || chatKey.startsWith("shared-")) return;
      setActiveId((prev) => prev ?? id); // highlight the new chat without remounting it
      setSessions((prev) => {
        const now = Date.now();
        // Reconcile by the stable per-mount clientKey FIRST so a re-minted
        // session id updates the same entry instead of forking a duplicate;
        // fall back to the session id (older entries have no clientKey).
        // Three-way reconcile: per-mount clientKey first; then the stored entry
        // id (reopened chats mount with chatKey = stored id — this is what keeps
        // a hard refresh mid-run from FORKING the thread when eve re-mints the
        // session id on reattach); session id last.
        const existing =
          prev.find((s) => s.clientKey === chatKey) ??
          prev.find((s) => s.id === chatKey) ??
          prev.find((s) => s.id === id);
        // NEVER truncate: the event stream only grows within a session, so a
        // SHORTER list for the same session id is a partial remount/replay (an
        // interrupted resync). Keep the longer one rather than overwriting real
        // progress with a stale, smaller snapshot.
        const sameSession = existing?.session?.sessionId === session.sessionId;
        const nextEvents =
          sameSession && (existing?.events?.length ?? 0) > events.length ? existing!.events : events;
        // Snapshot the second-row metadata from the FULL events now, so it stays
        // visible after `writeSessions` strips this chat's events for quota — no
        // blank row until reopen. Keep the previous snapshot if this persist has
        // no events (a partial remount) rather than clobbering it with zeros.
        const derivedCustomers = events.length
          ? inferCustomersFromEvents(events, customerIdSetRef.current)
          : existing?.derivedCustomers;
        const toolCounts = events.length
          ? chatToolCounts({ events } as StoredSession)
          : existing?.toolCounts;
        const entry: StoredSession = {
          // Keep the sidebar identity STABLE from creation. If eve re-mints the
          // session id mid-chat we still update this same entry (matched via
          // clientKey) rather than forking; the latest session lives in `session`.
          id: existing?.id ?? id,
          clientKey: chatKey,
          title: meta.title,
          preview: meta.preview,
          messageCount: meta.messageCount,
          customers: meta.customers ?? existing?.customers,
          archived: existing?.archived,
          forkedFrom: meta.forkedFrom ?? existing?.forkedFrom,
          session,
          events: nextEvents,
          derivedCustomers,
          toolCounts,
          updatedAt: now,
        };
        const next = existing
          ? prev.map((s) => (s === existing ? { ...s, ...entry, updatedAt: now } : s))
          : [entry, ...prev];
        // Prune-and-retry write that always spares THIS chat's events.
        writeSessions(email, next, new Set([entry.id, chatKey]));
        /**
         * AND the durable mirror. This was missing, and it was the whole bug.
         *
         * handlePersist is the ONLY persistence that runs during a live
         * conversation, and it wrote localStorage alone. `syncSessionsToDb` was
         * reached only from `persist()` — open, delete, archive, re-tag — so a
         * chat you started and never reopened got a server row only by luck.
         * With no row, the next load's server list replaces the local one and
         * the conversation is gone from the sidebar, transcript and all, even
         * though eve still holds every byte.
         *
         * The debounce fixes made earlier (max wait, unload flush, retry) were
         * all correct and all in a function this path never called.
         *
         * A BRAND-NEW chat registers immediately rather than waiting out the
         * debounce: the index row must not be able to lose a race with the
         * conversation it indexes, and the first seconds are exactly when a
         * user closes a tab they opened by accident.
         */
        syncRef.current?.(next, /* immediate */ !existing);
        return next;
      });
    },
    [email],
  );

  const [seedPrompt, setSeedPrompt] = useState<string | undefined>(undefined);
  // The origin thread of the currently-mounted fork (fresh or reopened), so the
  // chat can show a "back to original" link at its top.
  const [forkedFrom, setForkedFrom] = useState<{ id: string; title: string } | undefined>(undefined);
  // Refs so the stable (deps-[]) callbacks below read live values.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  activeIdForWrite.current = activeId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // One-time backfill on sign-in: push the EXISTING localStorage threads to the
  // durable mirror so they appear on other devices without needing to touch each
  // one first. Runs once after the local list has loaded.
  const didBackfillRef = useRef(false);
  useEffect(() => {
    if (!email || didBackfillRef.current) return;
    // Ordering is the whole point — see mergedFromDb.
    if (!mergedFromDb) return;
    const t = setTimeout(() => {
      didBackfillRef.current = true;
      if (sessionsRef.current.length) syncSessionsToDb(sessionsRef.current);
    }, 800);
    return () => clearTimeout(t);
  }, [email, syncSessionsToDb, mergedFromDb]);

  const newChat = useCallback(() => {
    newCount.current += 1;
    setInitialSession(undefined);
    setInitialEvents(undefined);
    setActiveId(null);
    setActiveCustomers([]);
    setSeedPrompt(undefined);
    setForkedFrom(undefined);
    setAutoBadge(undefined);
    setReadOnlyOwner(undefined);
    setRelayThreadId(undefined);
    setSharedReopen(null);
    setMountKey(mintKey("new"));
    setSearchOpen(false);
  }, []);

  // Fork a finished plan into a fresh thread: same customer context, plan mode
  // off, and the plan itself auto-sent as the first message with a go signal.
  const forkPlan = useCallback((plan: string) => {
    newCount.current += 1;
    const srcId = activeIdRef.current;
    const src = srcId ? sessionsRef.current.find((s) => s.id === srcId) : undefined;
    setForkedFrom(src ? { id: src.id, title: src.title || "Original chat" } : undefined);
    setInitialSession(undefined);
    setInitialEvents(undefined);
    setActiveId(null);
    setSeedPrompt(
      `(Forked from a planning thread — the plan below is already approved.)\n\n${plan}\n\nImplement this plan end to end, following the steps in order, and verify each step as you go.`,
    );
    setReadOnlyOwner(undefined);
    setRelayThreadId(undefined);
    setSharedReopen(null);
    setMountKey(mintKey("fork"));
    setSearchOpen(false);
  }, []);

  // Compact: the context ring's click hands us a summary of the current thread;
  // open a FRESH, short thread seeded with it (so the model continues from the
  // brief instead of the full transcript). Same mount path as fork, different
  // seed framing; back-link points at the original.
  const compactThread = useCallback((summary: string) => {
    newCount.current += 1;
    const srcId = activeIdRef.current;
    const src = srcId ? sessionsRef.current.find((s) => s.id === srcId) : undefined;
    setForkedFrom(src ? { id: src.id, title: src.title || "Original chat" } : undefined);
    setInitialSession(undefined);
    setInitialEvents(undefined);
    setActiveId(null);
    setSeedPrompt(
      `(Compacted from a longer thread — the summary below is the prior context.)\n\n${summary}\n\nContinue from here.`,
    );
    setReadOnlyOwner(undefined);
    setRelayThreadId(undefined);
    setSharedReopen(null);
    setMountKey(mintKey("compact"));
    setSearchOpen(false);
  }, []);

  // Re-read a session's stream from the server, newest-first, so a thread that
  // was persisted MID-STREAM (its turn still generating, so no boundary event
  // and no continuation token yet) can be resumed at the server's authoritative
  // state — the full event list plus the freshest resume token. `advanceSession`
  // in the eve client only mints a token at a turn boundary (`session.waiting`),
  // so a tokenless stored session is exactly one persisted mid-generation; this
  // is the only path that recovers it, since the client store never re-attaches
  // to an in-flight turn on its own.
  //
  // Reads until the live turn PARKS: a boundary event (waiting/completed/failed)
  // followed by a quiet gap. A boundary that is immediately followed by more
  // events is a PRIOR turn's park inside the replayed history — the stream keeps
  // going — so we must not stop on the first boundary (that would truncate a
  // multi-turn thread); only silence after a boundary means the live turn parked.
  //
  // SILENCE IS THE ONLY END-OF-REPLAY SIGNAL. eve's session stream is a live tail
  // over the durable workflow run: it replays the stored events and then, for any
  // run that has not TERMINATED, holds the connection open forever with no
  // heartbeat (eve's own ndjson-stream docs: "a parked `session.waiting` durable
  // run keeps its event stream open indefinitely"). Only `session.completed` /
  // `session.failed` end the body.
  //
  // So every stop condition here is a quiet window, and the window has to be
  // armed even when NO boundary was seen — otherwise a session that never
  // recorded one runs to the 15s hard timeout. That is not a rare shape: it is
  // exactly the case this function exists to repair (a thread persisted
  // mid-generation, whose run died before `emitTurnEpilogue` wrote its
  // `turn.completed` + `session.waiting`), and it is permanent — no boundary is
  // ever written, so EVERY subsequent open paid the full 15s. It also covers a
  // thread opened while a turn is genuinely in flight, where waiting longer buys
  // nothing: the eve store does not attach to the live stream on mount, so the
  // transcript is a snapshot the moment we stop reading either way.
  //
  // Stopping early can only ever drop a SUFFIX, never reorder — the reducer
  // projects a prefix, which is a consistent earlier state of the same thread.
  const replaySession = useCallback(
    async (
      sessionId: string,
      // For a SHARED thread, read through the membership-checked proxy so revoke
      // actually cuts access (the eve stream only domain-gates reads).
      viaThreadId?: string,
    ): Promise<{ events: unknown[]; continuationToken?: string; index?: number } | null> => {
      const events: unknown[] = [];
      let continuationToken: string | undefined;
      let serverIndex: number | undefined;
      /**
       * Measure the open where the session already is.
       *
       * The alternative was asking someone to copy their bearer token out of
       * localStorage and paste it into a terminal — which is the exact motion
       * every "paste this in your console" attack depends on, and not a habit
       * worth teaching to save a measurement. Nothing leaves the page: the
       * numbers are recorded in the tab that made the request.
       *
       * `stopReason` is the value that matters. It separates "the stream was
       * slow" from "the stream never ended and we sat through our own
       * deadline", which cannot be read off the source because it depends on
       * the thread's runtime state.
       */
      const startedAt = performance.now();
      let stopReason:
        | "marker"
        | "terminal"
        | "park-quiet"
        | "quiet"
        | "eof"
        | "timeout"
        | "segment-cap" = "eof";

      const bounded = Boolean(viaThreadId);
      /**
       * REPLAY IS SEGMENTED, because the stream is.
       *
       * This used to be a single open with a 15s cap. But a stream is severed
       * on a hard ~120s boundary and simply ends — no terminal event, a clean
       * EOF mid-turn. Live streaming survives that because eve's reader reopens
       * at the advanced index; replay did not, so re-opening a long thread
       * mounted a transcript that stopped in the middle of a turn. The stall
       * detector then correctly reported "the reply stopped before it
       * finished" about a turn that had completed perfectly well, and the reply
       * itself was missing from the screen.
       *
       * So: keep reopening at the absolute index until the session is genuinely
       * at rest (a terminal, or a park with nothing following), a segment
       * yields nothing new, or the whole open runs out of budget. `startIndex`
       * is an absolute event count and `events` holds only real events — the
       * `ops.replay.end` marker is never pushed — so `events.length` is exactly
       * where to resume from.
       */
      const deadline = startedAt + (bounded ? 12_000 : 60_000);
      const MAX_SEGMENTS = 12;
      let finished = false; // a terminal session.completed/failed — mount NOW
      // Tracked separately from stopReason: it is set inside a closure, and
      // narrowing cannot see across one.
      let sawMarker = false;
      // True when the LAST event read was a turn/session park — not sticky, so a
      // park buried in replayed history goes back to the long window as soon as
      // the next event arrives, instead of leaving the rest of a multi-turn
      // replay exposed to a 300ms cut.
      let atBoundary = false;

      /** One open. Returns how many real events it contributed. */
      const readSegment = async (startIndex: number): Promise<number> => {
        const ctrl = new AbortController();
        const hardTimer = setTimeout(() => ctrl.abort(), bounded ? 8_000 : 15_000);
        let got = 0;
        let sawAnyEvent = false;
        /**
         * ASK THE SERVER WHERE REPLAY ENDS instead of inferring it from silence.
         *
         * The shared-thread proxy can watch the NDJSON go past and inject one
         * `ops.replay.end` line the moment the backlog drains, with the absolute
         * next event index. That turns "wait and hope nothing else arrives" into
         * a definite answer. Only the proxied path can do it — a direct eve read
         * has nothing in the middle to inject it — so the heuristics below stay
         * for that path.
         */
        const url = viaThreadId
          ? `/api/ops/threads/${encodeURIComponent(viaThreadId)}/stream?replay=1&replayOnly=1`
          : `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`;
        try {
          const res = await fetch(url, { headers: getAuthHeaders(), signal: ctrl.signal });
          if (!res.ok || !res.body) return 0;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            if (finished) break; // finished sessions never emit more — no wait
            const read = reader.read();
            // At a park, a gap means the live turn has parked: stop soon (a
            // lagging token may still arrive, but the open must not block on
            // it). Mid-replay, a gap is more likely a slow server than the end,
            // so wait much longer. Before the first byte, don't race at all:
            // that is time-to-first-byte, and only the hard timeout bounds it.
            const quietMs = atBoundary ? 300 : sawAnyEvent ? 1_500 : 0;
            const r = quietMs
              ? await Promise.race([
                  read.catch(() => ({ done: true as const, value: undefined })),
                  new Promise<{ done: true; value: undefined }>((resolve) =>
                    setTimeout(() => resolve({ done: true, value: undefined }), quietMs),
                  ),
                ])
              : await read.catch(() => ({ done: true as const, value: undefined }));
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const l of lines) {
              if (!l.trim()) continue;
              try {
                const ev = JSON.parse(l) as {
                  type?: string;
                  data?: { continuationToken?: string; index?: number };
                };
                // The marker is bookkeeping, not conversation — it must never
                // reach the reducer, and it means history is complete right here.
                if (ev.type === "ops.replay.end") {
                  serverIndex = typeof ev.data?.index === "number" ? ev.data.index : undefined;
                  stopReason = "marker";
                  sawMarker = true;
                  finished = true;
                  continue;
                }
                events.push(ev);
                got++;
                sawAnyEvent = true;
                if (
                  ev.type === "session.waiting" &&
                  typeof ev.data?.continuationToken === "string" &&
                  ev.data.continuationToken
                ) {
                  continuationToken = ev.data.continuationToken;
                }
                if (ev.type === "session.completed" || ev.type === "session.failed") {
                  finished = true; // no stragglers — break right after this chunk
                } else {
                  // `turn.completed`/`turn.failed` count as a park too: eve
                  // writes them as a SEPARATE event just before
                  // `session.waiting`, so a run that died between the two still
                  // reads as at-rest here rather than falling through to the
                  // long window.
                  atBoundary =
                    ev.type === "session.waiting" ||
                    ev.type === "turn.completed" ||
                    ev.type === "turn.failed";
                }
              } catch {
                /* skip malformed line */
              }
            }
          }
        } catch {
          /* fall back to whatever we collected */
        } finally {
          clearTimeout(hardTimer);
          if (ctrl.signal.aborted) stopReason = "timeout";
          ctrl.abort();
        }
        return got;
      };

      let segments = 0;
      for (;;) {
        segments += 1;
        const got = await readSegment(events.length);
        // At rest: a terminal, or a park with nothing after it. Done.
        if (finished || atBoundary) {
          // The marker is the strongest signal we have; never downgrade it.
          stopReason = finished ? (sawMarker ? "marker" : "terminal") : "park-quiet";
          break;
        }
        // Nothing new — there is no more history to read, so reopening again
        // would just spin.
        if (got === 0) break;
        // The shared-thread proxy replays the whole backlog and injects its own
        // end marker; it has no startIndex to resume from.
        if (bounded) break;
        if (performance.now() > deadline) {
          stopReason = "timeout";
          break;
        }
        if (segments >= MAX_SEGMENTS) {
          stopReason = "segment-cap";
          break;
        }
        // Fell out mid-turn — the 120s severance. Reopen where we stopped.
      }

      {
        const ms = Math.round(performance.now() - startedAt);
        const record = {
          ms,
          stopReason,
          segments,
          events: events.length,
          shared: bounded,
          sessionId,
          at: new Date().toISOString(),
        };
        // Kept on the window so a slow open can be inspected after the fact —
        // `window.__threadOpens` — rather than needing a repro while watching.
        const w = window as unknown as { __threadOpens?: unknown[] };
        w.__threadOpens = [...(w.__threadOpens ?? []).slice(-49), record];
        if (ms > 2_000 || stopReason === "timeout" || segments > 1) {
          console.warn(
            `[thread-open] ${ms}ms · ${stopReason} · ${segments} segment(s) · ${events.length} events · ${
              bounded ? "shared" : "owned"
            }`,
          );
        }
      }

      return events.length > 0 ? { events, continuationToken, index: serverIndex } : null;
    },
    [getAuthHeaders],
  );

  const openChat = useCallback(
    async (s: StoredSession) => {
      setReadOnlyOwner(undefined);
      setRelayThreadId(undefined);
      setSharedReopen(null);
      setSeedPrompt(undefined);
      setAutoBadge(undefined);
      setForkedFrom(s.forkedFrom);
      setActiveId(s.id);
      setActiveCustomers(sessionCustomers(s));
      setSearchOpen(false);
      // Resync from the server when EITHER the stored session was persisted
      // mid-stream (no resume token) OR its event stream was pruned to fit the
      // localStorage quota (no events cached). Both mount a stale/empty snapshot
      // otherwise — replaying restores the full transcript and a live token.
      if (s.session?.sessionId && (!s.session.continuationToken || !s.events?.length)) {
        setOpeningChat(true);
        let fresh: Awaited<ReturnType<typeof replaySession>> = null;
        try {
          fresh = await replaySession(s.session.sessionId);
        } finally {
          setOpeningChat(false);
        }
        if (fresh) {
          // The server stream has no client-side `client.input.responded` events,
          // so carry the answered-input markers from the stored snapshot forward —
          // otherwise questions/approvals answered earlier revert to pending.
          const answered = ((s.events ?? []) as unknown[]).filter(
            (e) => (e as { type?: string }).type === "client.input.responded",
          );
          // Dedupe the merge so the streamIndex matches the mounted length exactly
          // (a stale/off index is what re-streams already-present events into
          // duplicates).
          const merged = dedupeEvents([...(fresh.events as unknown[]), ...answered]);
          const freshSession = {
            ...s.session,
            continuationToken: fresh.continuationToken,
            /**
             * SERVER events only — never `merged.length`.
             *
             * streamIndex is an absolute count of events the server has sent,
             * and eve passes it straight through as the next `startIndex`. The
             * merge deliberately adds `client.input.responded` markers, which
             * the server has never heard of, and the dedupe then removes an
             * unknown number of rows. Counting that total told eve to start N
             * events late, so the next turn silently SKIPPED N real events —
             * tool results and text that simply never rendered. The shared-open
             * path below already counts the right thing and says why.
             */
            streamIndex: fresh.index ?? (fresh.events as unknown[]).length,
          } as AgentSession;
          setInitialEvents(merged as AgentEvents);
          setInitialSession(freshSession);
          setMountKey(s.id);
          // Cache the replayed transcript back so the NEXT open of this thread is
          // INSTANT (no server replay). The active thread is spared from the
          // localStorage quota prune, so this survives.
          persist(
            sessionsRef.current.map((x) =>
              x.id === s.id ? { ...x, events: merged as AgentEvents, session: freshSession } : x,
            ),
          );
          return;
        }
      }
      setInitialSession(s.session);
      setInitialEvents(dedupeEvents(s.events) as AgentEvents);
      setMountKey(s.id);
    },
    [replaySession, persist],
  );

  // Navigate back to a thread by id (the fork's "back to original" link).
  const openThreadById = useCallback((id: string) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (s) openChat(s);
  }, [openChat]);

  // Open an arbitrary eve session (e.g. a workflow step's session) as a full
  // chat thread: replay its stream into events, capture the resume token, mount
  // AgentChat with them. Bounded read so an in-flight session mounts at its
  // current state rather than hanging on the open stream.
  const mountEveSession = useCallback(
    async (sessionId: string) => {
      const events: unknown[] = [];
      let continuationToken: string | undefined;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
          headers: getAuthHeaders(),
          signal: ctrl.signal,
        });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          let done = false;
          while (!done) {
            const r = await reader.read().catch(() => ({ done: true, value: undefined }));
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const l of lines) {
              if (!l.trim()) continue;
              try {
                const ev = JSON.parse(l) as { type?: string; data?: { continuationToken?: string } };
                events.push(ev);
                if (ev.type === "session.waiting" && typeof ev.data?.continuationToken === "string") {
                  continuationToken = ev.data.continuationToken;
                  done = true;
                } else if (ev.type === "session.completed") {
                  done = true;
                }
              } catch {
                /* skip malformed line */
              }
            }
          }
          clearTimeout(timer);
          ctrl.abort();
        }
      } catch {
        /* mount with whatever we collected */
      }
      newCount.current += 1;
      setSeedPrompt(undefined);
      setForkedFrom(undefined);
      setActiveId(null);
      setActiveCustomers([]);
      setReadOnlyOwner(undefined);
      setRelayThreadId(undefined);
      setSharedReopen(null);
      setInitialEvents(events as AgentEvents);
      setInitialSession({ sessionId, continuationToken, streamIndex: events.length } as AgentSession);
      setMountKey(`eve-${sessionId}`);
      setOpsOpen(false);
    },
    [getAuthHeaders],
  );

  // Poll the threads shared WITH me (owner-side shares appear in the normal list
  // via the owner's own localStorage). Owned threads are filtered out here.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await opsFetch<{ items: SharedThread[] }>("/api/ops/threads");
        if (alive) setSharedThreads((d.items ?? []).filter((t) => t.role !== "owner"));
      } catch {
        /* not signed in yet / offline — leave the list as-is */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 20000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Open a thread shared with me — replay its eve stream and mount READ-ONLY
  // (the composer becomes a view-only notice; the owner holds the token).
  const openSharedThread = useCallback(
    async (thread: SharedThread) => {
      // A shared open replays through the proxy and is the SLOWEST kind, and it
      // was the one path that showed nothing at all while it waited.
      setOpeningChat(true);
      try {
      // Read via the membership-checked proxy so a revoked member is cut off.
      const fresh = await replaySession(thread.eveSessionId, thread.id);
      newCount.current += 1;
      setSeedPrompt(undefined);
      setForkedFrom(undefined);
      setAutoBadge(undefined);
      setActiveId(`shared:${thread.id}`);
      setActiveCustomers(thread.customers ?? []);
      // Participant → relay-send mode (composer live); viewer → read-only.
      const canSend = thread.role === "participant";
      setReadOnlyOwner(canSend ? undefined : thread.ownerEmail);
      setRelayThreadId(canSend ? thread.id : undefined);
      setSharedReopen(thread);
      const answered = ((thread.clientEvents ?? []) as unknown[]).filter(
        (e) => (e as { type?: string }).type === "client.input.responded",
      );
      const events = fresh ? dedupeEvents([...(fresh.events as unknown[]), ...answered]) : answered;
      setInitialEvents(events as AgentEvents);
      setInitialSession({
        sessionId: thread.eveSessionId,
        continuationToken: fresh?.continuationToken,
        // The SERVER's absolute index when it has one. `events.length` counts
        // the client-only `client.input.responded` markers appended above, so
        // it drifts above the true server index — and eve passes streamIndex
        // straight through as startIndex on reconnect, so that drift silently
        // skips real events.
        streamIndex: fresh?.index ?? events.length,
      } as AgentSession);
      // A fresh mount key each open so a relay-refresh remounts with new events.
      setMountKey(mintKey(`shared-${thread.id}`));
      setOpsOpen(false);
      } finally {
        setOpeningChat(false);
      }
    },
    [replaySession],
  );

  // "Auto-triggered" badge shown at the top of a chat opened from a cron
  // invocation (a workflow run a cron fired). { ts, via } → a pill.
  const [autoBadge, setAutoBadge] = useState<
    { ts?: string; via: string; kind?: "cron" | "workflow-run" | "app" } | undefined
  >(undefined);
  // Transient top-of-app notice (e.g. an invite was redeemed).
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // The invite was already redeemed in AuthGate — it has to happen before the
  // "do you have a workspace?" check, or an invitee is redirected to onboarding
  // and never gets here. All that is left is to say how it went.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(INVITE_RESULT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(INVITE_RESULT_KEY);
      setNotice(JSON.parse(raw) as { kind: "ok" | "err"; text: string });
    } catch {
      /* nothing to report */
    }
  }, []);

  // Deep-link: `/?chatSession=<eve session id>` opens that session as a chat
  // (used by the "Open as chat" link on a workflow-run step / app refresh). An
  // optional `&from=<name>&kind=<workflow-run|app>` stamps the top provenance
  // indicator so an opened run/app thread shows where it came from — even when
  // it wasn't cron-triggered. A `wrun_…` session id defaults to workflow-run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("chatSession");
    if (!id) return;
    const from = params.get("from");
    const kind = params.get("kind");
    if (from) {
      setAutoBadge({ via: from, kind: kind === "app" ? "app" : "workflow-run" });
    } else if (id.startsWith("wrun_")) {
      setAutoBadge({ via: "this run", kind: "workflow-run" });
    }
    void mountEveSession(id);
  }, [mountEveSession]);

  // Deep-link: `/?seed=<instruction>` opens a FRESH chat pre-loaded with the
  // instruction (auto-sent), so a dashboard action button calls the agent back
  // with the human in the loop — the agent proposes the tool, the operator
  // approves inline. Mounts once on load.
  useEffect(() => {
    const seed = new URLSearchParams(window.location.search).get("seed");
    if (!seed) return;
    newCount.current += 1;
    setInitialSession(undefined);
    setInitialEvents(undefined);
    setActiveId(null);
    setForkedFrom(undefined);
    setAutoBadge(undefined);
    setSeedPrompt(seed);
    setMountKey(mintKey("seed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link: `/?chatWorkflowRun=<run id>&auto=<ts>` opens the workflow run a
  // cron triggered as a chat, badged as auto-triggered (used by a cron
  // invocation's "Open as chat"). Resolve the run's first step session + name.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("chatWorkflowRun");
    const ts = params.get("auto");
    const from = params.get("from");
    const kind = params.get("kind");
    if (!runId) return;
    void (async () => {
      try {
        const res = await fetch(`/api/ops/workflow-runs/${encodeURIComponent(runId)}`, {
          headers: getAuthHeaders(),
        });
        const d = (await res.json()) as {
          run?: { workflowName?: string };
          journal?: { sessionId?: string | null }[];
        };
        const sessionId = (d.journal ?? []).find((j) => j.sessionId)?.sessionId;
        // An explicit `from` (e.g. an app link) names the source; otherwise the
        // run's workflow name. `auto=` present → a cron fired it
        // ("Auto-triggered"); else it's a run/app opened as a chat.
        const via = from ?? d.run?.workflowName ?? "workflow";
        setAutoBadge(
          ts
            ? { ts, via, kind: "cron" }
            : { via, kind: kind === "app" ? "app" : "workflow-run" },
        );
        if (sessionId) await mountEveSession(sessionId);
      } catch {
        /* run not ready yet */
      }
    })();
  }, [mountEveSession, getAuthHeaders]);

  const deleteChat = useCallback(
    (id: string) => {
      persist(sessions.filter((s) => s.id !== id));
      // Remove from the durable per-user mirror too (POST only upserts the kept
      // list; a hard delete needs its own call). Fire-and-forget + fail-safe.
      void fetch(`/api/ops/chat-sessions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      }).catch(() => {});
      if (activeId === id) newChat();
    },
    [sessions, activeId, persist, newChat, getAuthHeaders],
  );

  const archiveChat = useCallback(
    (id: string) => {
      persist(sessions.map((s) => (s.id === id ? { ...s, archived: true } : s)));
      if (activeId === id) newChat();
    },
    [sessions, activeId, persist, newChat],
  );

  // Set the customers on the live chat immediately so the sidebar reflects it.
  const changeCustomers = useCallback(
    (next: string[]) => {
      setActiveCustomers(next);
      if (activeId) {
        persist(sessions.map((s) => (s.id === activeId ? { ...s, customers: next } : s)));
      }
    },
    [activeId, sessions, persist],
  );

  const ordered = [...sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-background">
      {notice ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-50 flex items-center justify-center gap-3 px-4 py-2 text-sm",
            notice.kind === "ok"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-destructive/15 text-destructive",
          )}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}
      {collapsed ? null : (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            aria-label="Close sidebar"
            onClick={() => setCollapsed(true)}
          />
          <div className="fixed inset-y-0 left-0 z-40 md:static md:z-auto">
        <ChatSidebar
          sessions={ordered}
          listStale={listStale}
          saveFailed={syncFailed}
          sharedThreads={sharedThreads}
          onSelectShared={openSharedThread}
          customers={customerOptions}
          activeId={activeId}
          email={email}
          name={name}
          picture={picture}
          onSelect={openChat}
          onNew={newChat}
          onDelete={deleteChat}
          onArchive={archiveChat}
          onSearch={() => setSearchOpen(true)}
          onOpenDataroom={openDataroom}
          onOpenOps={openOps}
          onCollapse={() => setCollapsed(true)}
          onSignOut={onSignOut}
        />
          </div>
        </>
      )}

      <div className="relative flex min-w-0 flex-1 overflow-hidden">
      <AgentChat
        key={`${mountKey}#${attachNonce}`}
        chatKey={mountKey}
        getAuthHeaders={getAuthHeaders}
        initialSession={initialSession}
        initialEvents={initialEvents}
        initialPrompt={seedPrompt}
        forkedFrom={forkedFrom}
        autoBadge={autoBadge}
        onForkPlan={forkPlan}
        onCompact={compactThread}
        onOpenThread={openThreadById}
        onReattach={reattach}
        onOpenOps={openOps}
        onPersist={handlePersist}
        onToggleSidebar={() => setCollapsed(false)}
        sidebarCollapsed={collapsed}
        selectedCustomers={activeCustomers}
        onCustomersChange={changeCustomers}
        customers={customerOptions}
        readOnly={Boolean(readOnlyOwner)}
        readOnlyOwner={readOnlyOwner}
        relayThreadId={relayThreadId}
        onRelaySent={() => {
          if (sharedReopen) void openSharedThread(sharedReopen);
        }}
        sharedThreadId={sharedReopen?.id}
      />
        {openingChat ? <ChatShimmer /> : null}
      </div>

      <ChatSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        sessions={ordered}
        onSelect={openChat}
        sharedThreads={sharedThreads}
        onSelectShared={(t) => {
          setSearchOpen(false);
          void openSharedThread(t);
        }}
      />

      <Dataroom
        open={dataroomOpen}
        onOpenChange={setDataroomOpen}
        initialTab={dataroomTab}
        initialSheet={dataroomSheet}
        getAuthHeaders={getAuthHeaders}
      />

      <OpsCenter
        open={opsOpen}
        onOpenChange={setOpsOpen}
        section={opsSection}
        authorEmail={email ?? undefined}
        initialSelectedId={opsInitialId}
        initialView={opsInitialView}
      />
    </div>
  );
}
