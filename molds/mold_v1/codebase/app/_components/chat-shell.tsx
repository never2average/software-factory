"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { lazyPanel } from "@/components/lazy-panel";
import { INVITE_RESULT_KEY } from "./auth-gate";
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "@/lib/browser-storage";
import { AgentChat, type AgentEvents, type AgentSession } from "./agent-chat";
import { installNotificationBridge } from "./desktop-notify";
import { ChatSidebar } from "./chat-sidebar";
import { ChatSearchDialog } from "./chat-search";
import type { DataroomTab } from "./dataroom";
import type { CustomerListItem, CustomerListStatus } from "./customer-search";
import type { OpsSection } from "./ops-center";
import { activeOrg, opsFetch } from "./ops/lib";
import {
  SNAPSHOT_VERSION,
  buildSnapshot,
  checkSeam,
  mountFromSnapshot,
  snapshotUsable,
  splitClientEvents,
  createEventDeduper,
  dedupeEvents,
  type TranscriptSnapshot,
  snapshotWriteNeeded,
} from "@/lib/chat-snapshot";
import { withFreshestToken } from "@/lib/chat-session-cursor";
import { MARKERS_MAX_BYTES_CLIENT, capMarkers, isPersistedMarker } from "@/lib/chat-turn-state";
import { createPersistWriter } from "@/lib/chat-persist";
import { cn } from "@/lib/utils";

/**
 * The data room and the Ops Center are fetched the first time one is opened, not with the chat. Between them they
 * are most of the app's code (every ops panel, the workbook previews, the task board's charts), and a person who
 * opens the app to ask a question needs none of it. Each mounts on its first open and then stays mounted, so its
 * state and its closing animation behave exactly as before. A chunk that fails to load shows a card with Retry over
 * the page (components/lazy-panel.tsx), never the whole app's error screen.
 */
const Dataroom = lazyPanel(() => import("./dataroom").then((m) => m.Dataroom), { label: "The data room", overlay: true });
const OpsCenter = lazyPanel(() => import("./ops-center").then((m) => m.OpsCenter), { label: "The Ops Center", overlay: true });

/**
 * What a replay hands back.
 *
 * `events` are only the events AFTER the requested start index when one was
 * given — a TAIL, not the whole transcript — and `index` is where the stream now
 * is, absolutely. The two are deliberately independent: a cached transcript is
 * compacted, so it holds fewer lines than the stream position it represents.
 */
interface ReplayResult {
  events: unknown[];
  continuationToken?: string;
  index?: number;
  /**
   * WHY the read stopped — because a tail that read nothing is ambiguous
   * without it. The stream saying "there is nothing after that index" is a fact
   * about the conversation; a read that timed out is a fact about the network.
   * They lead to opposite decisions about a cached transcript.
   */
  stop?: string;
}

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
  /**
   * The chat's persisted markers as the SERVER mirror has them (a Stop, an
   * answered question) — for a device that has no local copy of the events.
   */
  markers?: unknown[];
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
  clientMarkers?: unknown[];
  updatedAt?: number;
}

/**
 * Every persisted marker a chat has — this browser's copy and the server
 * mirror's, deduplicated — for EVERY open path. A Stop recorded on one device
 * then holds on all of them, snapshot or no snapshot.
 */
function markersOf(s: Pick<StoredSession, "events" | "markers">): unknown[] {
  return dedupeEvents([...((s.events ?? []) as unknown[]).filter(isPersistedMarker), ...(s.markers ?? [])]);
}

/**
 * The session cursor, with its resume token repaired from the stream.
 *
 * MOVED to lib/chat-session-cursor.ts, and changed while it went: it scanned
 * backwards for the newest `session.waiting` carrying a token, which sails
 * straight past a `session.failed` and resurrects the dead session's token onto
 * a cursor that had just been emptied on purpose. It now stops at the LAST turn
 * boundary, the way eve's own `advanceSession` does. Re-exported because this is
 * where every reader has looked for it; the rule lives in a module with no React
 * in it so scripts/test-thread-snapshot.mjs can execute it.
 */
export { withFreshestToken } from "@/lib/chat-session-cursor";

/**
 * Dropping exact-duplicate events MOVED to lib/chat-snapshot.ts, beside the
 * other transcript utilities and where it can be executed by a test. Re-exported
 * because this is where readers have always found it. `createEventDeduper` is
 * the same rule computed incrementally, which is what the live persist path
 * uses — see `handlePersist`.
 */
export { dedupeEvents } from "@/lib/chat-snapshot";

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
  // The prefix was `fde-chats:` until the base product's role name came out of the
  // wire. readStored falls back to it, so nobody's sidebar empties on the deploy
  // that renamed it — see lib/browser-storage.ts.
  return `${STORAGE_KEYS.chats}:${email ?? "anon"}:${activeOrg() ?? "default"}`;
}

/**
 * The quota back-off and the coalescer MOVED to lib/chat-persist.ts, for the
 * reason `dedupeEvents` moved to lib/chat-snapshot.ts: this is the code whose
 * bugs lose conversations, and there it can be EXECUTED by a test rather than
 * matched by a regex. Re-exported because this is where readers have always
 * found the storage ceiling.
 */
export { STORAGE_MAX_CHATS } from "@/lib/chat-persist";

/**
 * The one writer for the whole shell. Module scope because `writeSessions` has
 * always been module scope, and because there is exactly one ChatShell on the
 * page — a per-mount writer would drop a pending write on every remount, which
 * is the one thing this must never do.
 */
const persistWriter = createPersistWriter({
  onWarn: (message) => console.warn(message),
});

/**
 * QUEUE a write of the session list to localStorage — one per animation frame,
 * superseded writes dropped.
 *
 * It used to build the string and call `setItem` right here, synchronously,
 * from inside the `setSessions` updater. Measured on the operator's real thread
 * shape (a 1,500-event turn whose answer holds a 60 KB table) that was 266 ms of
 * `JSON.stringify` + `setItem` sitting between React deciding what the chat
 * looks like and the browser painting it — per persist, and a streaming turn
 * persists on every message, every answered input and every 2 s tick. The chat
 * froze while it SAVED, not while it thought.
 *
 * What is queued is the whole list, so a flush can never store a half-updated
 * one and a newer queue call is a strict replacement for an older one. The list
 * itself is not copied: it is the array React is about to hold, and every update
 * in this file replaces chats rather than mutating them — which is also what
 * lets lib/chat-persist.ts reuse the JSON of the chats that did not change.
 *
 * Nothing here may be the last word before a close: see `flushSessionWrite`.
 */
function writeSessions(email: string | null, sessions: StoredSession[], protect: ReadonlySet<string>): void {
  persistWriter.queue(storageKey(email), sessions, protect);
}

/**
 * Write anything queued, NOW, on this stack.
 *
 * A page that is going away gets no animation frame, no idle callback and no
 * promise continuation — it gets one synchronous stack and then it is gone. So
 * every departure path (`pagehide`, the tab going hidden, unmount) calls this
 * before anything else, and it is deliberately synchronous all the way down to
 * `setItem`. This is the constraint that made the previous engineer leave the
 * write inside the React commit; it is honoured by keeping a synchronous path,
 * not by keeping every write synchronous.
 */
function flushSessionWrite(): boolean {
  return persistWriter.flush();
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
  // Customer list for the per-chat context selector: the workspace's own, from the
  // system of record via /api/ops/customers, and nothing else. It starts EMPTY and
  // loading. It used to start from a bundled sample list and keep it whenever the
  // workspace had none, so an empty workspace offered invented accounts forever and
  // a chat could be grounded on an id that does not exist (mold_v1-120). The feed
  // carries each account's summary (tier/stage/status/health/owner + last touch)
  // inline so the selector renders a real one-line summary.
  const [customerOptions, setCustomerOptions] = useState<CustomerListItem[]>([]);
  const [customersStatus, setCustomersStatus] = useState<CustomerListStatus>("loading");
  /** Bumped by the picker's Retry: reads the list again. */
  const [customersReload, setCustomersReload] = useState(0);
  const retryCustomers = useCallback(() => {
    setCustomersStatus("loading");
    setCustomersReload((n) => n + 1);
  }, []);
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
  // Once opened, the lazily loaded data room / Ops Center stay mounted (see `Dataroom` above).
  const dataroomMounted = useRef(false);
  if (dataroomOpen) dataroomMounted.current = true;
  const opsMounted = useRef(false);
  if (opsOpen) opsMounted.current = true;
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

  // Load the workspace's customer list (system of record) for the context selector.
  // An empty answer IS the answer (the picker shows its empty state); a failed read
  // is said as one, never shown as an empty workspace.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ops/customers", { headers: getAuthHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { customers?: CustomerListItem[] };
        if (cancelled) return;
        setCustomerOptions(Array.isArray(data.customers) ? data.customers : []);
        setCustomersStatus("ready");
      } catch {
        if (!cancelled) setCustomersStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAuthHeaders, customersReload]);

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
      const raw = readStored(storageKey(email));
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
        // Land any coalesced write FIRST, so a frame that has not fired yet
        // cannot arrive after this repair and put the dropped entries back.
        flushSessionWrite();
        writeStored(storageKey(email), JSON.stringify(cleaned));
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
                markers: it.clientMarkers ?? cached?.markers,
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
        // Capped by BYTES (stops kept first, answer text trimmed): one chat's
        // markers must never be what gets the whole list sync refused.
        clientMarkers: capMarkers(markersOf(s), MARKERS_MAX_BYTES_CLIENT),
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
   *
   * BOTH stores, in this order. The localStorage write is now coalesced onto an
   * animation frame (see `writeSessions`), and a closing page never gets that
   * frame — so `flushSessionWrite` runs first and synchronously, before the
   * network flush that may not complete at all. It is also the cheaper of the
   * two to lose a race with: the mirror can be rebuilt from the server, the
   * cached transcript cannot.
   *
   * Deliberately NOT `beforeunload`: registering one disqualifies the page from
   * the bfcache, and `pagehide` fires in every case `beforeunload` would,
   * including the bfcache entry this would otherwise break.
   */
  useEffect(() => {
    const onHide = () => {
      flushSessionWrite();
      flushSessions(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmounting is also a departure — don't drop what is queued.
      flushSessionWrite();
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
      //
      // WRITTEN THROUGH, not coalesced. This is the deliberate-action path —
      // open, delete, archive, re-tag — which happens once per click, never per
      // delta, so the coalescing buys nothing here and the cost of being wrong
      // is high: a delete that has not reached storage when the tab dies comes
      // back on the next load. Only the streaming path (`handlePersist`) waits
      // for a frame, because only the streaming path repeats.
      writeSessions(email, next, new Set([activeIdForWrite.current ?? ""]));
      flushSessionWrite();
      syncSessionsToDb(next);
    },
    [email, syncSessionsToDb],
  );

  /* ---- the transcript cache ------------------------------------------------
   *
   * localStorage already caches a thread's events, and a chat whose events are
   * cached opens instantly. The trouble is everything that is NOT in it: a chat
   * whose stream was stripped to fit the ~5MB quota (see writeSessions), a
   * second device, a cleared browser, a colleague's thread. All of those fall
   * through to `replaySession`, which re-reads the whole conversation — which is
   * what "reopening an old chat is very very slow" is.
   *
   * So the same cache, durably, server-side and workspace-scoped:
   * /api/ops/chat-snapshots holds the transcript a thread has already been shown
   * plus the absolute stream index it covers. It is a CACHE and never the truth
   * — lib/chat-snapshot.ts holds every rule about when it may be trusted, and
   * every path below falls back to the full replay rather than showing something
   * it is not sure of.
   */

  /**
   * The highest index we know is already stored for a session.
   *
   * Without it, mounting a snapshot and then persisting (which happens
   * immediately, on mount) would write the row straight back, unchanged, on
   * every single open — a megabyte of transcript uploaded to learn nothing.
   */
  const snapshotIndexRef = useRef<Map<string, number>>(new Map());
  /** How many client markers the stored snapshot of each session carries. */
  const snapshotMarkersRef = useRef<Map<string, number>>(new Map());

  const fetchSnapshot = useCallback(
    async (sessionId: string): Promise<TranscriptSnapshot | null> => {
      try {
        const res = await fetch(`/api/ops/chat-snapshots?session=${encodeURIComponent(sessionId)}`, {
          headers: getAuthHeaders(),
        });
        // 403 (not shared with me), 503 (store down), 404 (not deployed yet) —
        // every one of them means "open it the old way", which is always
        // correct and never wrong, only slow.
        if (!res.ok) return null;
        const { snapshot } = (await res.json()) as { snapshot?: TranscriptSnapshot | null };
        if (!snapshotUsable(snapshot, { eveSessionId: sessionId })) return null;
        snapshotIndexRef.current.set(sessionId, snapshot.eventIndex);
        snapshotMarkersRef.current.set(sessionId, snapshot.clientEvents.length);
        return snapshot;
      } catch {
        return null;
      }
    },
    [getAuthHeaders],
  );

  /**
   * Store the transcript for a session. Fire-and-forget and fail-safe: a
   * snapshot that does not get written costs a slow open, never a wrong one, so
   * nothing here is allowed to interrupt a chat.
   */
  const storeSnapshot = useCallback(
    (input: {
      sessionId: string | undefined;
      chatSessionId?: string;
      events: readonly unknown[] | undefined;
      streamIndex: number | undefined;
    }) => {
      const snapshot = buildSnapshot({
        eveSessionId: input.sessionId,
        streamIndex: input.streamIndex,
        events: input.events,
      });
      if (!snapshot) return;
      const knownIndex = snapshotIndexRef.current.get(snapshot.eveSessionId);
      // Never move a thread's transcript backwards — a truncated read must not
      // overwrite a complete one — but DO rewrite the same position when it
      // gained markers (a Stop that produced no server event: see
      // `snapshotWriteNeeded`).
      if (
        !snapshotWriteNeeded(
          snapshot,
          knownIndex === undefined
            ? undefined
            : { eventIndex: knownIndex, markers: snapshotMarkersRef.current.get(snapshot.eveSessionId) ?? 0 },
        )
      ) {
        return;
      }
      snapshotIndexRef.current.set(snapshot.eveSessionId, snapshot.eventIndex);
      snapshotMarkersRef.current.set(snapshot.eveSessionId, snapshot.clientEvents.length);
      void fetch("/api/ops/chat-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          eveSessionId: snapshot.eveSessionId,
          chatSessionId: input.chatSessionId,
          version: SNAPSHOT_VERSION,
          eventIndex: snapshot.eventIndex,
          events: snapshot.events,
          clientEvents: snapshot.clientEvents,
        }),
      })
        .then((r) => {
          // Refused (too large, a version the server does not project, a thread
          // that is not mine to write): forget that we believe it is stored, so
          // a later, smaller or better-placed write is still attempted.
          if (!r.ok) snapshotIndexRef.current.delete(snapshot.eveSessionId);
        })
        .catch(() => snapshotIndexRef.current.delete(snapshot.eveSessionId));
    },
    [getAuthHeaders],
  );
  /**
   * A ref for the same reason `syncRef` is one: `handlePersist` is handed to the
   * chat component and must stay referentially stable, or every re-render
   * remounts the persistence effect.
   */
  const storeSnapshotRef = useRef<typeof storeSnapshot | null>(null);
  storeSnapshotRef.current = storeSnapshot;

  /**
   * The live persist path's incremental deduper (lib/chat-snapshot.ts).
   *
   * A ref, not state: it carries the previous call's answer so the next one
   * only pays for what arrived since, and recreating it per render would throw
   * that away — which is the entire saving. It is safe to keep across mounts
   * because a stream that is not an append of the one it last saw falls back to
   * the full pass on its own.
   */
  const deduperRef = useRef(createEventDeduper<unknown>());

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
    /**
     * The hand-off may deliberately carry an EMPTY cursor.
     *
     * When a turn ends on `session.failed` or `session.completed`, eve's own
     * `advanceSession` returns `createInitialSessionState()` — no session id, no
     * token — because that session cannot be continued. `withFreshestToken` used
     * to scan backwards for the newest `session.waiting` with a token, walk
     * straight past the failure, and put the dead session's token back on the
     * cursor. The next message then posted to a finished session with a spent
     * token and the reader was told "The connection to the agent dropped."
     *
     * It now stops at the LAST boundary, so a failure or a completion means no
     * backfill at all. See lib/chat-session-cursor.ts.
     */
    setInitialSession(withFreshestToken(session, clean));
    setInitialEvents(clean);
    setAttachNonce((n) => n + 1);
  }, []);

  /**
   * Re-read the ACTIVE chat's session from eve and remount on it.
   *
   * The live chat calls this when a turn it was no longer listening to (Stop
   * that fell back to a detach, a dropped stream, a thread opened mid-turn) has
   * settled server-side. It is `openChat`'s replay branch without the
   * navigation: same events, same cursor rules, same persistence identity.
   */
  const mountKeyRef = useRef(mountKey);
  mountKeyRef.current = mountKey;
  const replayRef = useRef<((sessionId: string) => Promise<ReplayResult | null>) | null>(null);
  const resync = useCallback(
    async (sessionId: string, clientEvents: readonly unknown[], knownServerEvents = 0): Promise<boolean> => {
      const forKey = mountKeyRef.current;
      const fresh = await replayRef.current?.(sessionId);
      // Moved to another chat while the replay ran, or the replay came back
      // SHORTER than what is on screen (it hit its own deadline): never trade a
      // longer transcript for a shorter one.
      if (!fresh || mountKeyRef.current !== forKey) return false;
      if ((fresh.events as unknown[]).length < knownServerEvents) return false;
      const merged = dedupeEvents([...(fresh.events as unknown[]), ...clientEvents]);
      setInitialEvents(merged as AgentEvents);
      setInitialSession({
        sessionId,
        continuationToken: fresh.continuationToken,
        // SERVER events only — see openChat for why never `merged.length`.
        streamIndex: fresh.index ?? (fresh.events as unknown[]).length,
      } as AgentSession);
      setAttachNonce((n) => n + 1);
      return true;
    },
    [],
  );

  const handlePersist = useCallback(
    (rawSession: AgentSession, meta: ChatMeta, rawEvents: AgentEvents, chatKey: string) => {
      const id = rawSession.sessionId;
      if (!id) return;
      /**
       * Collapse exact-duplicate events (accumulated `client.input.responded`,
       * byte-identical reattach re-emissions) BEFORE anything else keys off the
       * length — so the stored stream stays clean and the anti-truncation guard
       * compares like with like.
       *
       * INCREMENTALLY, because this runs once per text delta. `dedupeEvents`
       * stringifies every event in the list, and eve's deltas each carry
       * `messageSoFar` — the whole answer so far — so a long turn was paying a
       * JSON.stringify of a quadratically-growing stream on the main thread
       * between each chunk of output and the paint that shows it. A live turn
       * only APPENDS, and first-occurrence-wins means the previous answer is
       * still correct for the prefix, so the deduper checks the prefix by
       * reference and stringifies only what arrived since. Anything that is not
       * an append — a remount, a resync, a replaced array — falls back to the
       * full pass, so the RESULT is unchanged; only the cost is.
       */
      const events = deduperRef.current(rawEvents) as AgentEvents;
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
        /**
         * Prune-and-retry write that always spares THIS chat's events — now
         * QUEUED rather than performed here.
         *
         * This line used to be 266 ms of `JSON.stringify` and a synchronous
         * `localStorage.setItem` INSIDE a `setSessions` updater, i.e. inside the
         * React commit, on a 1,500-event turn with a 60 KB table in it. It runs
         * on every message, every answered input and every 2 s of streaming
         * (agent-chat's `persistTick`), so it was a quarter of a second of frozen
         * chat between the answer changing and the answer appearing.
         *
         * `next` deliberately stays inside the updater: the previous attempt to
         * fix this foundered on hoisting it out, because this updater also feeds
         * `syncRef` and `storeSnapshotRef`. Nothing is hoisted. The list is
         * handed to a queue that builds the string on the next frame, and every
         * departure path flushes that queue synchronously
         * (`flushSessionWrite`), so the state before a close still lands.
         */
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
        /**
         * AND the transcript, once the turn has come to rest.
         *
         * `session.streamIndex` is the eve store's own cursor, and
         * `advanceSession` only advances it at a PARK — at any other moment it
         * is reset to zero. So a positive index is itself the proof that this
         * persist is a boundary and that the number is the stream's true
         * position, which is exactly the pair a resume needs. Anything else
         * (mid-turn, a fresh chat with no session yet) is skipped; there is
         * another boundary along in a moment.
         *
         * The last server event is checked too, because the cursor can be
         * carried in from the mount while a new turn is already streaming — and
         * storing a grown transcript against the index it had BEFORE that turn
         * would describe a stream position that does not contain it.
         */
        const lastServer = splitClientEvents(nextEvents ?? []).server.at(-1) as { type?: string } | undefined;
        const atRest =
          lastServer?.type === "session.waiting" ||
          lastServer?.type === "turn.completed" ||
          lastServer?.type === "turn.failed" ||
          lastServer?.type === "session.completed" ||
          lastServer?.type === "session.failed";
        if (atRest) {
          storeSnapshotRef.current?.({
            sessionId: session.sessionId,
            chatSessionId: entry.id,
            events: nextEvents,
            streamIndex: session.streamIndex,
          });
        }
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
      /**
       * A TAIL read: start at this ABSOLUTE event index instead of at zero, and
       * return only what comes after it.
       *
       * This is what makes a reopen cost the size of what is NEW. The transcript
       * up to `startIndex` came from the cache (lib/chat-snapshot.ts) and is
       * already on screen; everything here is the part the cache cannot know
       * about. `parked` says the caller holds a live resume token, which lets
       * the server use its SHORT drain window — a tail read of a parked session
       * replays nothing, so the marker logic would otherwise wait out the long
       * "the turn may still be thinking" window for a session that is by
       * definition silent.
       */
      tail?: { startIndex: number; parked?: boolean },
    ): Promise<ReplayResult | null> => {
      const base = Math.max(0, Math.floor(tail?.startIndex ?? 0));
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
       *
       * `quietMs` is the second number that matters, and it was not being kept:
       * it is the time spent waiting out a quiet window rather than reading
       * bytes — latency this client CHOSE, not latency the server imposed. On
       * the owned path it was 1,500ms per segment, which is why that path now
       * asks the server where the replay ends instead (`/api/ops/chat-replay`).
       */
      const startedAt = performance.now();
      let quietMs = 0;
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
       * at rest (a terminal, a DRAINED end marker, or a park with nothing
       * following), a segment yields nothing new, or the whole open runs out of
       * budget. `cursor` is an absolute event count and `events` holds only real
       * events — the `ops.replay.end` marker is never pushed — so `base +
       * events.length` is exactly where to resume from when the server does not
       * say.
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
      /**
       * Has the OWNED path's marker route answered at least once?
       *
       * `/api/ops/chat-replay` is newer than the deployments that read from it,
       * and a browser tab lives for days. If it is not there (or the workspace
       * lookup behind it is down) this falls back to reading eve directly — the
       * exact code path that shipped before, quiet windows and all. A thread
       * that opens slowly is a bad day; a thread that will not open is an
       * outage.
       */
      let markerRouteOk = true;

      /** One open. Returns how many real events it contributed. */
      const readSegment = async (startIndex: number): Promise<number> => {
        const ctrl = new AbortController();
        const hardTimer = setTimeout(() => ctrl.abort(), bounded ? 8_000 : 15_000);
        let got = 0;
        let sawAnyEvent = false;
        /**
         * ASK THE SERVER WHERE REPLAY ENDS instead of inferring it from silence.
         *
         * A proxy can watch the NDJSON go past and inject one `ops.replay.end`
         * line the moment the backlog drains, with the absolute next event
         * index. That turns "wait and hope nothing else arrives" into a definite
         * answer, decided between two deployments in the same region rather than
         * across this browser's network.
         *
         * Only a proxied path can do it. That used to mean SHARED threads only,
         * so every thread you own — which is nearly all of them — paid a
         * 1,500ms quiet window per segment instead. `/api/ops/chat-replay` is
         * the same trick for the owned path, with the same access rule; the
         * heuristics below remain for the fallback, and for a marker that says
         * the stream was cut rather than drained.
         */
        const url = viaThreadId
          ? `/api/ops/threads/${encodeURIComponent(viaThreadId)}/stream?replay=1&replayOnly=1${
              // The proxy has always accepted and forwarded a startIndex; only
              // this caller never had one to send. With the transcript cached, a
              // shared open can read its tail too — and shared opens are the
              // slowest kind, two hops and a membership check away.
              startIndex > 0 ? `&startIndex=${startIndex}` : ""
            }`
          : markerRouteOk
            ? `/api/ops/chat-replay?session=${encodeURIComponent(sessionId)}&startIndex=${startIndex}${
                tail?.parked ? "&parked=1" : ""
              }`
            : `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`;
        try {
          let res = await fetch(url, { headers: getAuthHeaders(), signal: ctrl.signal });
          if (!res.ok && !viaThreadId && markerRouteOk) {
            // Not there, or not answering. Take the old road for the rest of
            // this open rather than failing it.
            markerRouteOk = false;
            res = await fetch(
              `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`,
              { headers: getAuthHeaders(), signal: ctrl.signal },
            );
          }
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
            // A TAIL read is EXPECTED to be empty — a parked thread that nobody
            // has touched has nothing after its last event, and eve holds the
            // connection open anyway. With no window before the first byte that
            // read runs to the 15s hard timeout every time, which would make the
            // fallback path (no end marker) worse than what it replaced. Here,
            // silence IS the answer, so it only has to be long enough to outlast
            // a slow first flush.
            const quietWindow = atBoundary ? 300 : sawAnyEvent ? 1_500 : tail ? 1_200 : 0;
            const waitedFrom = performance.now();
            const r = quietWindow
              ? await Promise.race([
                  read.catch(() => ({ done: true as const, value: undefined })),
                  new Promise<{ done: true; value: undefined; quiet: true }>((resolve) =>
                    setTimeout(() => resolve({ done: true, value: undefined, quiet: true }), quietWindow),
                  ),
                ])
              : await read.catch(() => ({ done: true as const, value: undefined }));
            // Only a window that WON the race cost anything; the rest of the
            // time the read came back first and the timer was free.
            if ((r as { quiet?: true }).quiet) quietMs += performance.now() - waitedFrom;
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const l of lines) {
              if (!l.trim()) continue;
              try {
                const ev = JSON.parse(l) as {
                  type?: string;
                  data?: { continuationToken?: string; index?: number; drained?: boolean };
                };
                // The marker is bookkeeping, not conversation — it must never
                // reach the reducer. `drained: false` means the marker was
                // emitted because the UPSTREAM ENDED, not because the backlog
                // ran dry: that is the ~120s severance, and treating it as the
                // end of history is exactly how a long thread used to mount
                // stopping mid-turn. Take the index and reopen there.
                if (ev.type === "ops.replay.end") {
                  serverIndex = typeof ev.data?.index === "number" ? ev.data.index : undefined;
                  sawMarker = true;
                  if (ev.data?.drained !== false) {
                    stopReason = "marker";
                    finished = true;
                  }
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
      let cursor = base;
      for (;;) {
        segments += 1;
        const got = await readSegment(cursor);
        // Prefer the server's own count: it saw every line, including any this
        // client could not parse.
        cursor = serverIndex ?? base + events.length;
        // At rest: a terminal, a drained marker, or a park with nothing after
        // it. Done.
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
          // What the open spent waiting for silence rather than reading. The
          // number the fast path is trying to drive to zero, kept beside the
          // total so a regression in either is visible.
          quietMs: Math.round(quietMs),
          stopReason,
          segments,
          events: events.length,
          startIndex: base,
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
            `[thread-open] ${ms}ms (${Math.round(quietMs)}ms quiet) · ${stopReason} · ${segments} segment(s) · ${
              events.length
            } events · ${bounded ? "shared" : "owned"}${base ? ` · tail from ${base}` : ""}`,
          );
        }
      }

      /**
       * A TAIL that read nothing is a RESULT, not a failure.
       *
       * The full-replay contract is "null means we learned nothing", because an
       * empty replay of a whole session means the read failed. A tail of a
       * parked session legitimately returns zero events — that is the normal,
       * happy answer, and the one this whole change exists to make cheap — so it
       * must be distinguishable from a read that fell over. `index` carries the
       * answer either way.
       */
      if (!events.length && !tail) return null;
      return { events, continuationToken, index: serverIndex ?? base + events.length, stop: stopReason };
    },
    [getAuthHeaders],
  );

  // `resync` is declared above this (next to reattach); hand it the replay.
  replayRef.current = replaySession;

  /**
   * A replay that starts from the cached transcript when there is one.
   *
   * `openChat` does this in two phases so a reopened thread PAINTS before the
   * tail is read. This is the same thing for callers that just want the
   * transcript in one piece — notably a SHARED thread, which is the slowest open
   * there is (a membership check and a second hop on top of the replay) and
   * whose mount rebuilds several pieces of state at once.
   *
   * It is the same cache with the same rules: the seam is re-read from the
   * stream, and a snapshot the stream disagrees with is discarded in favour of
   * the full replay. Returning `null` still means "we learned nothing".
   */
  const replayFromCache = useCallback(
    async (sessionId: string, viaThreadId?: string, parked?: boolean): Promise<ReplayResult | null> => {
      const cached = await fetchSnapshot(sessionId);
      if (cached) {
        const tail = await replaySession(sessionId, viaThreadId, {
          startIndex: cached.eventIndex - 1,
          parked,
        });
        const seam = checkSeam(cached, tail?.events);
        if (seam.status === "match" || tail?.stop === "timeout") {
          // A stalled tail proves nothing about the cache (see openChat), and
          // the cached transcript beats showing nothing at all.
          return {
            events: [...cached.events, ...seam.tail],
            continuationToken: tail?.continuationToken,
            index: cached.eventIndex + seam.tail.length,
          };
        }
        console.warn(`[thread-open] snapshot discarded (${seam.status}) — replaying in full`);
        snapshotIndexRef.current.delete(sessionId);
      }
      return replaySession(sessionId, viaThreadId);
    },
    [fetchSnapshot, replaySession],
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
        const sessionId = s.session.sessionId;
        setOpeningChat(true);
        /**
         * THE FAST PATH: mount the cached transcript, then read only the tail.
         *
         * This is the whole fix for "reopening an old chat is very very slow".
         * The old path below re-reads the conversation from event zero and waits
         * out a quiet window per segment, so its cost is the size of everything
         * that has ever been said. This one costs one indexed row plus whatever
         * has happened SINCE — usually nothing, because a parked thread is the
         * normal resting state.
         *
         * The order is deliberate: paint first, verify second. The seam check
         * (lib/chat-snapshot.ts) re-reads the single event the snapshot claims to
         * end on, so the stream still has the final say — but it says it a
         * moment after the conversation is already on screen, instead of a
         * conversation's worth of events beforehand.
         */
        const cached = await fetchSnapshot(sessionId);
        if (cached) {
          const localMarkers = dedupeEvents([
            ...((s.events ?? []) as unknown[]).filter((e) => (e as { type?: string }).type?.startsWith("client.")),
            ...(s.markers ?? []),
          ]);
          const mountNow = mountFromSnapshot(cached, [], localMarkers);
          /**
           * The resume handle is NOT stored in the cache — it already has an
           * owner (the chat_sessions row), and a cache is the last place to keep
           * a second copy of a resume capability. It is recovered here the same
           * way the full-replay path recovers it: from the freshest
           * `session.waiting` in the transcript, which is where eve puts it. A
           * thread whose stored cursor lagged behind a park would otherwise
           * mount tokenless and lose its next message.
           */
          const cachedSession = withFreshestToken(
            { ...s.session, streamIndex: mountNow.streamIndex } as AgentSession,
            mountNow.events,
          );
          setInitialEvents(mountNow.events as AgentEvents);
          setInitialSession(cachedSession);
          setMountKey(s.id);
          setOpeningChat(false);

          /**
           * Now the tail, from ONE event before the snapshot ends.
           *
           * That extra event is the seam: the stream's own copy of the last
           * event the snapshot claims. If it is missing the snapshot is ahead of
           * the stream; if it differs the snapshot is not this conversation's.
           * Either way the cache is discarded and the full replay takes over, so
           * a reopened thread can never settle on something a full replay would
           * not show.
           */
          const tail = await replaySession(sessionId, undefined, {
            startIndex: cached.eventIndex - 1,
            parked: Boolean(s.session.continuationToken),
          });
          const seam = checkSeam(cached, tail?.events);
          if (seam.status === "match") {
            if (seam.tail.length === 0) {
              // Nothing new: the mount stands. Cache it in this browser too, so
              // the next open of this thread costs no request at all — that is
              // what `writeSessions` is for, and this transcript is the
              // compacted one, which is what fits in the quota.
              persist(
                sessionsRef.current.map((x) =>
                  x.id === s.id ? { ...x, events: mountNow.events as AgentEvents, session: cachedSession } : x,
                ),
              );
              return;
            }
            const merged = mountFromSnapshot(cached, seam.tail, localMarkers);
            const nextSession = withFreshestToken(
              {
                ...cachedSession,
                // A token from the TAIL is newer than anything in the cache.
                continuationToken: tail?.continuationToken ?? cachedSession.continuationToken,
                streamIndex: merged.streamIndex,
              } as AgentSession,
              merged.events,
            );
            setInitialEvents(merged.events as AgentEvents);
            setInitialSession(nextSession);
            // Remount so the store re-seeds from the fuller transcript. Only
            // when there IS something new: a remount on every open would throw
            // away scroll position to display the identical conversation.
            setAttachNonce((n) => n + 1);
            persist(
              sessionsRef.current.map((x) =>
                x.id === s.id ? { ...x, events: merged.events as AgentEvents, session: nextSession } : x,
              ),
            );
            storeSnapshot({
              sessionId,
              chatSessionId: s.id,
              events: merged.events,
              streamIndex: merged.streamIndex,
            });
            return;
          }
          /**
           * A tail that never got an ANSWER proves nothing.
           *
           * "The stream has nothing at that index" and "the read timed out" both
           * arrive here as zero events, and they call for opposite decisions.
           * Only the first is evidence against the snapshot. On a stalled read
           * the cached transcript stays on screen — it is what this browser
           * would have shown anyway — and the next open checks again.
           */
          if (tail?.stop === "timeout") {
            console.warn("[thread-open] tail read timed out — keeping the cached transcript unverified");
            return;
          }
          // The stream disagreed. Say so — a cache that is silently wrong is
          // worse than no cache — forget the row, and fall through to the full
          // replay below, which is authoritative.
          console.warn(`[thread-open] snapshot discarded (${seam.status}) — replaying in full`);
          snapshotIndexRef.current.delete(sessionId);
          void fetch(`/api/ops/chat-snapshots?session=${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
          }).catch(() => {});
          setOpeningChat(true);
        }

        let fresh: Awaited<ReturnType<typeof replaySession>> = null;
        try {
          fresh = await replaySession(sessionId);
        } finally {
          setOpeningChat(false);
        }
        if (fresh) {
          // The server stream has no client-side markers, so carry the ones this
          // browser persisted forward — answered inputs (`client.input.responded`)
          // and Stops (`client.turn.stopped`) — otherwise questions answered or
          // stopped earlier revert to live, and a stopped specialist to "Running".
          const answered = markersOf(s);
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
          // And durably, so this is the LAST time any device pays for the whole
          // conversation. localStorage caches it for this browser only, and only
          // until the quota prune reaches it.
          storeSnapshot({
            sessionId,
            chatSessionId: s.id,
            events: merged,
            streamIndex: freshSession.streamIndex,
          });
          return;
        }
      }
      setInitialSession(s.session);
      setInitialEvents(dedupeEvents([...((s.events ?? []) as unknown[]), ...(s.markers ?? [])]) as AgentEvents);
      setMountKey(s.id);
    },
    [replaySession, persist, fetchSnapshot, storeSnapshot, getAuthHeaders],
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
      // Read via the membership-checked proxy so a revoked member is cut off —
      // starting from the cached transcript, whose read is gated by the same
      // membership rule, so revoking still cuts everything off at once.
      const fresh = await replayFromCache(thread.eveSessionId, thread.id);
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
        isPersistedMarker,
      );
      const events = fresh ? dedupeEvents([...(fresh.events as unknown[]), ...answered]) : answered;
      setInitialEvents(events as AgentEvents);
      setInitialSession({
        sessionId: thread.eveSessionId,
        /**
         * NO RESUME TOKEN, for a participant or a viewer.
         *
         * A shared thread's token lives in the `chat_threads` row and is
         * claimed by the send relay — that is what serializes two people
         * writing into one eve session, and what
         * `app/api/ops/threads/[id]/messages/route.ts` means by "once shared,
         * the token lives ONLY in the row, never on a client".
         *
         * This line mounted it anyway, for viewers as well as participants,
         * because the stream proxy handed eve's `session.waiting` through
         * untouched and `replaySession` picks the token out of it. Only the
         * composer's own UI then stopped a read-only member from sending. The
         * proxy now strips it server-side (`withoutContinuationTokens`), so
         * `fresh.continuationToken` is already undefined here; leaving the
         * field off is the client saying the same thing, so a future reader
         * cannot re-introduce the mount from some other source.
         *
         * Nothing here needs it: a participant sends through `relayThreadId`
         * (agent-chat's `handleSubmit` short-circuits to the relay before it
         * touches a token) and a viewer sends nothing at all.
         */
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
    [replayFromCache],
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
      const raw = readStored(INVITE_RESULT_KEY, "session");
      if (!raw) return;
      removeStored(INVITE_RESULT_KEY, "session");
      setNotice(JSON.parse(raw) as { kind: "ok" | "err"; text: string });
    } catch {
      /* nothing to report */
    }
  }, []);

  // A desktop notification was clicked (public/sw.js): open that chat — the sidebar's own entry when it is one of
  // ours, else the session itself, exactly as the `?chatSession=` deep link below does.
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  useEffect(
    () =>
      installNotificationBridge((sid) => {
        const s = sessionsRef.current.find((x) => x.session?.sessionId === sid || x.id === sid);
        if (s) openChatRef.current(s);
        else void mountEveSession(sid);
      }),
    [mountEveSession],
  );

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
      const gone = sessions.find((s) => s.id === id);
      persist(sessions.filter((s) => s.id !== id));
      // Remove from the durable per-user mirror too (POST only upserts the kept
      // list; a hard delete needs its own call). Fire-and-forget + fail-safe.
      void fetch(`/api/ops/chat-sessions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      }).catch(() => {});
      /**
       * …and the cached transcript. A cache that outlives the thing it caches
       * is a copy of a conversation the user believes they deleted.
       *
       * The DELETE above now does this server-side as well — the mirror row,
       * the transcript and the share, in one authorized request — because a
       * deletion that depends on the deleter's browser staying alive is not a
       * deletion: this call is `void fetch(…).catch(() => {})`, so closing the
       * tab on the click left the full conversation behind for good. This stays
       * as the local half (it also clears `snapshotIndexRef`, which is in this
       * browser and nowhere else) and is now belt to the server's braces.
       */
      const sid = gone?.session?.sessionId;
      if (sid) {
        snapshotIndexRef.current.delete(sid);
        void fetch(`/api/ops/chat-snapshots?session=${encodeURIComponent(sid)}`, {
          method: "DELETE",
          headers: getAuthHeaders(),
        }).catch(() => {});
      }
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
          getAuthHeaders={getAuthHeaders}
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
        onResync={resync}
        onOpenOps={openOps}
        onPersist={handlePersist}
        onToggleSidebar={() => setCollapsed(false)}
        sidebarCollapsed={collapsed}
        selectedCustomers={activeCustomers}
        onCustomersChange={changeCustomers}
        customers={customerOptions}
        customersStatus={customersStatus}
        onRetryCustomers={retryCustomers}
        readOnly={Boolean(readOnlyOwner)}
        readOnlyOwner={readOnlyOwner}
        relayThreadId={relayThreadId}
        onRelaySent={() => {
          if (sharedReopen) void openSharedThread(sharedReopen);
        }}
        sharedThreadId={sharedReopen?.id}
        // No identity yet: nothing is kept (never under an "anon" scope another
        // person could later read).
        storageScope={email ? `${email}:${activeOrg() ?? "default"}` : undefined}
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

      {dataroomOpen || dataroomMounted.current ? (
        <Dataroom
          open={dataroomOpen}
          onOpenChange={setDataroomOpen}
          initialTab={dataroomTab}
          initialSheet={dataroomSheet}
          getAuthHeaders={getAuthHeaders}
        />
      ) : null}

      {opsOpen || opsMounted.current ? (
        <OpsCenter
          open={opsOpen}
          onOpenChange={setOpsOpen}
          section={opsSection}
          authorEmail={email ?? undefined}
          initialSelectedId={opsInitialId}
          initialView={opsInitialView}
        />
      ) : null}
    </div>
  );
}
