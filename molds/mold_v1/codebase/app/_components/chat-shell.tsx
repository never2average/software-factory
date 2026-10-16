"use client";

import { noteRender } from "@/lib/render-census";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { activeOrg, opsFetch, switchWorkspace, workspaceOfLink } from "./ops/lib";
import { sharedGet } from "@/lib/startup-fetch";
import { isWorkspaceRefusalBody, noteChatRefused } from "@/lib/workspace-refusal";
import {
  SNAPSHOT_VERSION,
  buildSnapshot,
  seamVerdict,
  replaceDecision,
  mountFromSnapshot,
  snapshotUsable,
  splitClientEvents,
  createEventDeduper,
  dedupeEvents,
  type TranscriptSnapshot,
  snapshotWriteNeeded,
} from "@/lib/chat-snapshot";
import { withFreshestToken } from "@/lib/chat-session-cursor";
import { readReplay, type ReplayResult } from "@/lib/chat-replay-read";
import { openRoute, replayMayReplace } from "@/lib/chat-open-route";
import { parseServerTiming } from "@/lib/server-timing";
import { createOpenGuard, type OpenTicket } from "@/lib/chat-open-guard";
import {
  beginChatOpen,
  browserLagSampler,
  browserStorageChars,
  configureChatOpenTiming,
  flushOpenCounter,
  noteChatCommit,
  reportSnapshotEvent,
  type ChatMountCause,
  type ChatOpenHandle,
  type SavedCopyWrite,
} from "@/lib/chat-open-timing";
import { MARKERS_MAX_BYTES_CLIENT, capMarkers, isPersistedMarker, serverEventCount, type TurnEvent } from "@/lib/chat-turn-state";
import { createPersistWriter } from "@/lib/chat-persist";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { isTodoViewKey, type TodoViewKey } from "@/lib/work-periods-ui";

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
 * A shared open paints only after its seam read returns, so a second seam read
 * is visible delay there. It is taken only when the first one came back within
 * this long, which keeps both inside the shared read's bound (8 s a read, 12 s
 * an open).
 */
const SHARED_SEAM_RETRY_WITHIN_MS = 4_000;

/**
 * Does this transcript end at rest (a park, a finished turn, a finished
 * session)? The same list `handlePersist` uses to decide a saved copy may be
 * written; an open that mounts a transcript NOT at rest mounted a running turn.
 */
function endsAtRest(events: readonly unknown[] | undefined): boolean {
  const lastServer = splitClientEvents(events ?? []).server.at(-1) as { type?: string } | undefined;
  return (
    lastServer?.type === "session.waiting" ||
    lastServer?.type === "turn.completed" ||
    lastServer?.type === "turn.failed" ||
    lastServer?.type === "session.completed" ||
    lastServer?.type === "session.failed"
  );
}

/**
 * How far the longest copy of this session we hold reaches, as an absolute stream index: this browser's (its stored
 * cursor, or its event count when that is larger: a mid-turn persist keeps the cursor of the last park) and the saved
 * copy's (`knownSaved`, the index this page last read or wrote for it). Undefined when neither exists.
 */
function longestCopyIndex(s: StoredSession, sessionId: string, knownSaved: number | undefined): number | undefined {
  let longest = knownSaved;
  if (s.session?.sessionId === sessionId && s.events?.length) {
    const local = Math.max(s.session.streamIndex ?? 0, serverEventCount(s.events as readonly TurnEvent[]));
    longest = Math.max(longest ?? 0, local);
  }
  return longest;
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
  return `${STORAGE_KEYS.chats}:${email ?? "anon"}:${activeOrg() ?? "default"}`;
}

/** Which chat this person last had open in this workspace, so a reload reopens it (see `bootFromCache`). */
function lastChatKey(email: string | null) {
  return `${STORAGE_KEYS.lastChat}:${email ?? "anon"}:${activeOrg() ?? "default"}`;
}

/**
 * This browser's cached chat list, cleaned: workflow/cron-opened threads (clientKey `eve-…`) a previous build
 * persisted are dropped (they are ephemeral), `shared-…` entries an earlier build filed here are dropped (they belong
 * under "Shared with you", read from the server), and streams stored with accumulated duplicates are healed.
 * `changed` says the stored copy needs the repair written back.
 */
function readCachedSessions(email: string | null): { cleaned: StoredSession[]; changed: boolean } | null {
  try {
    const raw = readStored(storageKey(email));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredSession[];
    const cleaned = stored
      .filter((s) => !s.clientKey?.startsWith("eve-") && !s.clientKey?.startsWith("shared-"))
      .filter((s) => !s.id?.startsWith("shared-"))
      .map((s) => (s.events?.length ? { ...s, events: dedupeEvents(s.events) as AgentEvents } : s));
    return { cleaned, changed: cleaned.length !== stored.length };
  } catch {
    return null; // corrupt storage
  }
}

/**
 * THE FIRST SCREEN, FROM THIS BROWSER'S CACHE.
 *
 * The sidebar used to start empty and fill in an effect, and every load landed on a new chat whatever the person had
 * open. Now the first render already holds the cached list, and the chat they last had open when it can be shown
 * straight from the cache (a transcript and a resume token, exactly what a click on a cached chat mounts). A last
 * chat the cache cannot show is opened through `openChat` right after mount, as a click would. The server list then
 * replaces the cached one as before; until it has answered, the sidebar says it is updating.
 */
function bootFromCache(email: string | null) {
  const cached = readCachedSessions(email);
  const sessions = cached?.cleaned ?? [];
  const lastId = readStored(lastChatKey(email));
  const last = lastId ? sessions.find((s) => s.id === lastId) : undefined;
  // Exactly what a click mounts with no request (lib/chat-open-route.ts `openRoute`): a parked chat with its
  // transcript, or one whose turn was still running here a moment ago.
  const instant =
    last?.session?.sessionId &&
    last.events?.length &&
    openRoute({
      sessionId: last.session.sessionId,
      token: Boolean(last.session.continuationToken),
      events: last.events,
      updatedAt: last.updatedAt,
      now: Date.now(),
    }) === "local"
      ? last
      : undefined;
  return { sessions, repair: cached?.changed ?? false, last, instant };
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
            <Skeleton className="h-3 w-24 bg-muted/70" />
            {widths.map((w, j) => (
              <Skeleton
                key={j}
                className="bg-muted/50"
                style={{ width: w, animationDelay: `${(i * 3 + j) * 70}ms` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-8">
        <Skeleton className="h-24 w-full rounded-2xl border border-border/60 bg-muted/30" />
      </div>
      <span className="sr-only">Loading conversation…</span>
    </div>
  );
}

/** Is this answer the server's "You are not a member of this workspace" (lib/workspace-refusal.ts)? */
async function isWorkspaceRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  return isWorkspaceRefusalBody(res.status, await res.clone().text().catch(() => ""));
}

export function ChatShell({ getAuthHeaders, email, name, picture, onSignOut }: ChatShellProps) {
  noteRender("ChatShell");
  // Read once, on the first render: the cached list and the chat to reopen (see `bootFromCache`).
  const [boot] = useState(() => bootFromCache(email));
  const [sessions, setSessions] = useState<StoredSession[]>(boot.sessions);
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
    TodoViewKey | undefined
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
      if (isTodoViewKey(view)) {
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
        // Shared with the starter cards' read of the same list, and started early by the <head> script.
        const res = await sharedGet("/api/ops/customers", getAuthHeaders());
        // A guest of one shared chat is not in the chat's workspace: its list is refused, and for them that is an
        // empty picker, not a failure. (Anyone else refused never gets here: the page shows the refusal instead.)
        if (await isWorkspaceRefusal(res)) {
          if (!cancelled) {
            setCustomerOptions([]);
            setCustomersStatus("ready");
          }
          return;
        }
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
  const [mountKey, setMountKey] = useState(() => boot.instant?.id ?? mintKey("new"));
  /**
   * Bumped to force a REMOUNT of the same chat, which is the only way to make
   * the eve store re-open a stream (it reads its session config once, at
   * creation). Deliberately separate from mountKey: mountKey is the chat's
   * persistence identity, so bumping THAT would file the recovered thread as a
   * new chat instead of continuing this one.
   */
  const [attachNonce, setAttachNonce] = useState(0);
  // A reopened last chat mounts exactly as `openChat` mounts a cached one: its session, its events plus markers.
  const [initialSession, setInitialSession] = useState<AgentSession | undefined>(boot.instant?.session);
  const [initialEvents, setInitialEvents] = useState<AgentEvents | undefined>(() =>
    boot.instant
      ? (dedupeEvents([...((boot.instant.events ?? []) as unknown[]), ...(boot.instant.markers ?? [])]) as AgentEvents)
      : undefined,
  );
  const [activeId, setActiveId] = useState<string | null>(boot.instant?.id ?? null);
  const [activeCustomers, setActiveCustomers] = useState<string[]>(() =>
    boot.instant ? sessionCustomers(boot.instant) : [],
  );
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

  // Load persisted sessions for this user (the first render already did, from `boot`; this runs again when the
  // person changes) and write the cleaned list back when it needed repair — see `readCachedSessions`.
  const bootedFor = useRef<string | null | undefined>(email);
  useEffect(() => {
    const cached = bootedFor.current === email ? { cleaned: boot.sessions, changed: boot.repair } : readCachedSessions(email);
    bootedFor.current = undefined;
    if (!cached) return;
    setSessions(cached.cleaned);
    if (cached.changed) {
      // Land any coalesced write FIRST, so a frame that has not fired yet
      // cannot arrive after this repair and put the dropped entries back.
      flushSessionWrite();
      writeStored(storageKey(email), JSON.stringify(cached.cleaned));
    }
  }, [email, boot]);

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
        // The first read is usually already answered: the <head> script started it (lib/startup-fetch).
        let res = await sharedGet("/api/ops/chat-sessions", getAuthHeaders());
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
          // Refused for a guest of one shared chat (not in its workspace): there is no list to be stale about.
          if (!cancelled && !(await isWorkspaceRefusal(res))) setListStale(true);
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
    async (
      sessionId: string,
      signal?: AbortSignal,
      /** The route's `Server-Timing` phases (lib/server-timing.ts), for the open's record. */
      onTiming?: (phases: Record<string, number>) => void,
    ): Promise<TranscriptSnapshot | null> => {
      try {
        const res = await fetch(`/api/ops/chat-snapshots?session=${encodeURIComponent(sessionId)}`, {
          headers: getAuthHeaders(),
          signal,
        });
        const phases = parseServerTiming(res.headers.get("server-timing"));
        if (Object.keys(phases).length) onTiming?.(phases);
        // 403 (not shared with me), 503 (store down), 404 (not deployed yet) —
        // every one of them means "open it the old way", which is always
        // correct and never wrong, only slow. Slow for a reason worth knowing,
        // though: a chat refused its saved copy on every open is a chat that
        // pays the full replay on every open, and nothing said so.
        if (!res.ok) {
          reportSnapshotEvent("snapshot-refused", { sessionId, status: res.status, reason: "read" });
          return null;
        }
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
      /** What became of the write, for the open's record (lib/chat-open-timing.ts). Never throws into the caller. */
      onOutcome?: (outcome: SavedCopyWrite, status?: number) => void;
    }) => {
      const outcome = (o: SavedCopyWrite, status?: number) => {
        try {
          input.onOutcome?.(o, status);
        } catch {
          /* never */
        }
      };
      const snapshot = buildSnapshot({
        eveSessionId: input.sessionId,
        streamIndex: input.streamIndex,
        events: input.events,
      });
      if (!snapshot) {
        // Nothing worth storing (no session, no server events, a mid-turn cursor). Said once per chat per load.
        if (input.sessionId) {
          reportSnapshotEvent("snapshot-skipped", {
            sessionId: input.sessionId,
            reason: !input.events?.length ? "no-events" : "not-at-a-boundary",
          });
        }
        outcome("skipped");
        return;
      }
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
        outcome("not-needed");
        return;
      }
      outcome("sent");
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
        .then(async (r) => {
          // Refused (too large, a version the server does not project, a thread
          // that is not mine to write): forget that we believe it is stored, so
          // a later, smaller or better-placed write is still attempted.
          if (r.ok) {
            outcome("stored", r.status);
            return;
          }
          snapshotIndexRef.current.delete(snapshot.eveSessionId);
          outcome("refused", r.status);
          // Swallowed until now: a chat whose saves are refused looks exactly like one that was never saved. Only
          // the route's short code (too-large, version, index) and the size are sent, never the body's sentences.
          const body = (await r.json().catch(() => null)) as { reason?: unknown; bytes?: unknown } | null;
          const code = typeof body?.reason === "string" && /^[a-z-]{1,24}$/.test(body.reason) ? body.reason : "refused";
          const bytes = typeof body?.bytes === "number" ? ` bytes=${Math.round(body.bytes)}` : "";
          reportSnapshotEvent("snapshot-refused", {
            sessionId: snapshot.eveSessionId,
            status: r.status,
            reason: `write:${code}${bytes} events=${snapshot.events.length}`,
          });
        })
        .catch(() => {
          snapshotIndexRef.current.delete(snapshot.eveSessionId);
          outcome("failed");
        });
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

  /**
   * Why the chat's NEXT mount happens, for the open's record (lib/chat-open-timing.ts): set just before the state
   * change that remounts it, read and reset by the commit hook. A ref, so recording never renders anything.
   */
  const mountCauseRef = useRef<ChatMountCause>("open");

  /**
   * One open at a time (lib/chat-open-guard.ts). Every path that puts something in the chat pane claims a ticket;
   * an open checks its own after every await and before every state write, so a slower, earlier click can never land
   * on top of a later one.
   */
  const openGuardRef = useRef(createOpenGuard());
  /** Set just before the page load's own reopen calls `openChat`, so that open's clock starts at navigation. */
  const pageLoadOpenRef = useRef(false);
  /**
   * The chat pane, for the two things the shell must know about the composer without owning it: whether it holds a
   * draft (a background replacement waits rather than throw the draft away) and when its first frame is usable.
   */
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  /** Sent anything since the current open began? (performance.now() of the last send, 0 for none.) */
  const sentAtRef = useRef(0);
  /** A replacement of the transcript waiting for the composer to be free (see `replaceDecision`). */
  const pendingSwapRef = useRef<(() => void) | null>(null);
  const composerHasDraft = useCallback((): boolean => {
    try {
      const box = chatPaneRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      return Boolean(box && box.value.trim().length > 0);
    } catch {
      return false;
    }
  }, []);

  /**
   * Something other than `openChat` is taking the chat pane (a new chat, a fork, a shared chat, an automation's
   * session): cancel the open in flight, drop a waiting replacement, and take down the shimmer that open put up,
   * since it can no longer take it down itself.
   */
  const supersedeOpen = useCallback((): OpenTicket => {
    const ticket = openGuardRef.current.claim();
    pendingSwapRef.current = null;
    setOpeningChat(false);
    return ticket;
  }, []);

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
    mountCauseRef.current = "reattach";
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
      mountCauseRef.current = "resync";
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
      if (chatKey.startsWith("eve-") || chatKey.startsWith("shared-")) {
        // No saved copy is ever written for these, and that used to be silent. Once per chat per page load.
        reportSnapshotEvent("snapshot-skipped", {
          sessionId: id,
          reason: chatKey.startsWith("shared-") ? "shared" : "automation",
        });
        return;
      }
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
  const [forkedFrom, setForkedFrom] = useState<{ id: string; title: string } | undefined>(boot.instant?.forkedFrom);
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
    supersedeOpen();
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
  }, [supersedeOpen]);

  // Fork a finished plan into a fresh thread: same customer context, plan mode
  // off, and the plan itself auto-sent as the first message with a go signal.
  const forkPlan = useCallback((plan: string) => {
    supersedeOpen();
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
  }, [supersedeOpen]);

  // Compact: the context ring's click hands us a summary of the current thread;
  // open a FRESH, short thread seeded with it (so the model continues from the
  // brief instead of the full transcript). Same mount path as fork, different
  // seed framing; back-link points at the original.
  const compactThread = useCallback((summary: string) => {
    supersedeOpen();
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
  }, [supersedeOpen]);

  /**
   * Re-read a session's stream from the server (lib/chat-replay-read.ts `readReplay`, which holds every rule about
   * when a read has read enough). This wrapper supplies the sign-in headers and keeps the read's record on the window
   * — `window.__threadOpens` — so a slow open can be inspected after the fact rather than needing a repro while
   * watching. Nothing leaves the page: the numbers are recorded in the tab that made the request.
   */
  const replaySession = useCallback(
    async (
      sessionId: string,
      viaThreadId?: string,
      tail?: { startIndex: number; parked?: boolean },
      /** `timing`: the open this read belongs to, which keeps what the server said about each read's time. */
      opts?: { signal?: AbortSignal; timing?: ChatOpenHandle },
    ): Promise<ReplayResult | null> => {
      const { result, record } = await readReplay({
        sessionId,
        viaThreadId,
        tail,
        signal: opts?.signal,
        headers: getAuthHeaders,
        onServerTiming: opts?.timing
          ? (t) => opts.timing?.serverTiming("replay", t.phases, { firstByte: t.firstByte, marker: t.marker })
          : undefined,
      });
      const w = window as unknown as { __threadOpens?: unknown[] };
      w.__threadOpens = [...(w.__threadOpens ?? []).slice(-49), record];
      if (record.ms > 2_000 || record.stopReason === "timeout" || record.segments > 1) {
        console.warn(
          `[thread-open] ${record.ms}ms (${record.quietMs}ms quiet) · ${record.stopReason} · ${record.segments} segment(s) · ${
            record.events
          } events · ${record.shared ? "shared" : "owned"}${record.startIndex ? ` · tail from ${record.startIndex}` : ""}`,
        );
      }
      return result;
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
   * It is the same cache with the same rules (lib/chat-snapshot.ts
   * `seamVerdict`): the seam is re-read from the stream, an EMPTY or unanswered
   * seam read is not evidence against the cache and keeps it, and only a stream
   * that positively disagrees discards it in favour of the full replay.
   * Returning `null` still means "we learned nothing".
   *
   * The one difference from `openChat`: nothing is on screen while this runs, so
   * a second seam read is visible delay, not background work. It is taken only
   * while the first one left room for it inside the shared read's own bound
   * (8 s per read, 12 s per open); otherwise the first read is final.
   */
  const replayFromCache = useCallback(
    async (
      sessionId: string,
      viaThreadId?: string,
      parked?: boolean,
      signal?: AbortSignal,
    ): Promise<ReplayResult | null> => {
      const cached = await fetchSnapshot(sessionId, signal);
      if (cached) {
        const startedAt = performance.now();
        const readSeam = () =>
          replaySession(sessionId, viaThreadId, { startIndex: cached.eventIndex - 1, parked }, { signal });
        let tail = await readSeam();
        let verdict = seamVerdict(cached, tail, 1);
        if (verdict.action === "retry") {
          const roomForASecondRead = performance.now() - startedAt < SHARED_SEAM_RETRY_WITHIN_MS && !signal?.aborted;
          if (roomForASecondRead) tail = await readSeam();
          verdict = seamVerdict(cached, tail, 2);
        }
        if (verdict.action === "keep" || verdict.action === "extend") {
          // An unanswered read proves nothing about the cache (see openChat),
          // and the cached transcript beats showing nothing at all.
          return {
            events: [...cached.events, ...verdict.tail],
            continuationToken: tail?.continuationToken,
            index: cached.eventIndex + verdict.tail.length,
          };
        }
        console.warn(`[thread-open] snapshot discarded (${verdict.status}) — replaying in full`);
        reportSnapshotEvent("snapshot-discarded", { sessionId, reason: `${verdict.status}${viaThreadId ? " shared" : ""}` });
        snapshotIndexRef.current.delete(sessionId);
      }
      if (signal?.aborted) return null;
      return replaySession(sessionId, viaThreadId, undefined, { signal });
    },
    [fetchSnapshot, replaySession],
  );

  /**
   * Mount a full replay of a stored chat: the foreground replay of a chat with
   * no saved copy, and the background replacement of a saved copy the stream
   * disagreed with. `remount` bumps the attach nonce, because the replacement
   * lands on a chat that is ALREADY mounted under the same key: without it the
   * eve store, which reads `initialEvents` only when it is created, kept the
   * discarded copy on screen and the authoritative replay was fetched and never
   * shown.
   */
  const mountReplayed = useCallback(
    (s: StoredSession, sessionId: string, fresh: ReplayResult, timing: ChatOpenHandle, remount: boolean) => {
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
      if (remount) {
        mountCauseRef.current = "seam-replace";
        setAttachNonce((n) => n + 1);
      }
      /**
       * NEVER STORE A READ THAT STOPPED EARLY OVER A LONGER COPY (lib/chat-open-route.ts `replayMayReplace`).
       *
       * A replay that hit its deadline, its segment cap or an error is a prefix of the conversation. Written into
       * this browser's list it replaced a longer transcript there, and posted as the saved copy it became what every
       * other device mounted. A complete read (a drained marker, a terminal, a park) is always stored: a stream only
       * grows, so a copy longer than a complete read is the wrong copy.
       */
      const longer = longestCopyIndex(s, sessionId, snapshotIndexRef.current.get(sessionId));
      if (!replayMayReplace(fresh, longer)) {
        console.warn(`[thread-open] replay stopped early (${fresh.stop}) at ${fresh.index} — not stored over the copy at ${longer}`);
        reportSnapshotEvent("snapshot-skipped", {
          sessionId,
          reason: `truncated-replay stop=${fresh.stop ?? "-"} index=${fresh.index ?? "-"} copy=${longer ?? "-"}`,
        });
        timing.savedCopy("skipped");
        return;
      }
      // Cache the replayed transcript back so the NEXT open of this thread is
      // INSTANT (no server replay). The active thread is spared from the
      // localStorage quota prune, so this survives.
      persist(
        sessionsRef.current.map((x) =>
          x.id === s.id ? { ...x, events: merged as AgentEvents, session: freshSession } : x,
        ),
      );
      // A read that stopped at the live edge of a running turn ("live", lib/chat-replay-read.ts) is mid-turn: there is
      // no saved copy to write until the turn parks, and the live persist path writes it then.
      if (fresh.stop === "live") {
        timing.savedCopy("skipped");
        return;
      }
      // And durably, so this is the LAST time any device pays for the whole
      // conversation. localStorage caches it for this browser only, and only
      // until the quota prune reaches it.
      storeSnapshot({
        sessionId,
        chatSessionId: s.id,
        events: merged,
        streamIndex: freshSession.streamIndex,
        onOutcome: timing.savedCopy,
      });
    },
    [persist, storeSnapshot],
  );

  /**
   * Replace a painted chat whose saved copy the stream positively disagreed
   * with: a full replay BEHIND the chat that is on screen, never the shimmer
   * over it, then one remount onto the replay, if and when the person is free
   * (lib/chat-snapshot.ts `replaceDecision`):
   *
   *   - typing a draft: wait; the swap runs when the draft is sent or cleared;
   *   - has sent since the open began: the swap is FORCED, from a read taken
   *     after the send. The copy mounted the chat at the copy's stream index,
   *     and the reader of the turn just sent starts there: if the copy claimed
   *     more events than the stream has, the new turn's events fall below that
   *     cursor and never render, so keeping the mount would lose the reply. The
   *     message itself is durable on the server, so the fresh read contains it,
   *     the remounted chat attaches to the running turn, and the composer is
   *     empty at that moment, so nothing typed is lost. What IS lost is the
   *     scroll position, once;
   *   - otherwise: swap now.
   *
   * Guarded like `resync`: a later click (the ticket) or another chat on screen
   * (the mount key) and nothing is written.
   */
  const replaceBehindPaint = useCallback(
    async (s: StoredSession, sessionId: string, ticket: OpenTicket, timing: ChatOpenHandle): Promise<void> => {
      const startedAt = performance.now();
      const fresh = await replaySession(sessionId, undefined, undefined, { signal: ticket.signal, timing });
      timing.replay(performance.now() - startedAt, fresh?.events.length ?? 0);
      if (!fresh) return;
      const swap = () => {
        if (!ticket.current() || mountKeyRef.current !== s.id) return;
        const decision = replaceDecision({ typing: composerHasDraft(), sent: sentAtRef.current > 0 });
        if (decision === "wait") {
          pendingSwapRef.current = swap;
          return;
        }
        if (decision === "swap-fresh" && sentAtRef.current > startedAt) {
          // This replay was read before the send: read again, so the mount carries the turn just sent.
          void replaceBehindPaint(s, sessionId, ticket, timing);
          return;
        }
        mountReplayed(s, sessionId, fresh, timing, true);
      };
      swap();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recursion through its own binding; every dependency is stable
    [replaySession, mountReplayed, composerHasDraft],
  );

  const openChat = useCallback(
    async (s: StoredSession) => {
      /**
       * This click is now the open the person wants. Claiming cancels the open in
       * flight (its requests abort, and it can no longer write), and drops any
       * replacement still waiting for the composer.
       */
      const ticket = openGuardRef.current.claim();
      pendingSwapRef.current = null;
      sentAtRef.current = 0;
      const pageLoad = pageLoadOpenRef.current;
      pageLoadOpenRef.current = false;
      /**
       * One record per click (lib/chat-open-timing.ts), the local mount
       * included: route, saved-copy and seam times, paint, composer-ready,
       * mounts, the shimmer, the saved-copy write, main-thread lag and the
       * specialist streams for 30 s. Never throws, never renders.
       */
      const timing = beginChatOpen({
        chatId: s.id,
        sessionId: s.session?.sessionId,
        storedEvents: s.events?.length ?? 0,
        storedToken: Boolean(s.session?.continuationToken),
        pageLoad,
      });
      mountCauseRef.current = "open";
      // However the open ends, it has then decided what it shows: `whenChatOpenSettled` (lib/chat-open-timing.ts)
      // lets work that should not compete with it (the Control Panel's finished specialists) start.
      try {
      setReadOnlyOwner(undefined);
      setRelayThreadId(undefined);
      setSharedReopen(null);
      setSeedPrompt(undefined);
      setAutoBadge(undefined);
      setForkedFrom(s.forkedFrom);
      setActiveId(s.id);
      setActiveCustomers(sessionCustomers(s));
      setSearchOpen(false);
      /**
       * Where this open reads from (lib/chat-open-route.ts `openRoute`). The server, when this browser's events were
       * pruned to fit the localStorage quota (no events cached), or the stored session was persisted mid-stream (no
       * resume token) and nothing says its turn is running now: replaying restores the full transcript and a live
       * token. Everything else mounts what this browser holds, with no request, a RUNNING chat included: its events
       * end inside a turn and were written in the last few minutes, so the chat's own live reader continues the turn
       * from the absolute index those events end at, instead of the replay loop reading it until it falls silent.
       */
      const route = openRoute({
        sessionId: s.session?.sessionId,
        token: Boolean(s.session?.continuationToken),
        events: s.events,
        updatedAt: s.updatedAt,
        now: Date.now(),
      });
      if (s.session?.sessionId && route === "network") {
        const sessionId = s.session.sessionId;
        setOpeningChat(true);
        /**
         * The chat being LEFT is unmounted now, not when this open lands.
         *
         * The shimmer is an overlay: the previous chat stayed mounted under it for the whole of this open, and its
         * Control Panel kept downloading and folding its specialists' streams while this chat's saved copy, seam read
         * or full replay competed with it for the network and the main thread. Nothing of it is visible under the
         * shimmer, so an empty mount in its place costs nothing to look at, and unmounting aborts its reads.
         * Re-opening the chat already on screen keeps it.
         */
        if (mountKeyRef.current !== s.id) {
          setInitialEvents(undefined);
          setInitialSession(undefined);
          setMountKey(mintKey("opening"));
        }
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
        const snapshotStartedAt = performance.now();
        const cached = await fetchSnapshot(sessionId, ticket.signal, (phases) => timing.serverTiming("snapshot", phases));
        timing.snapshot(performance.now() - snapshotStartedAt, Boolean(cached));
        // A later click took over while the saved copy was on its way: that open owns the pane, and the shimmer.
        if (!ticket.current()) return;
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
          timing.route("snapshot");
          setInitialEvents(mountNow.events as AgentEvents);
          setInitialSession(cachedSession);
          setMountKey(s.id);
          setOpeningChat(false);

          /**
           * Now the tail, from ONE event before the snapshot ends.
           *
           * That extra event is the seam: the stream's own copy of the last
           * event the snapshot claims. lib/chat-snapshot.ts `seamVerdict` reads
           * the answer, and only POSITIVE evidence counts against the copy: a
           * different event at the seam, or a stream that closed with nothing
           * there. An EMPTY or unanswered read is not evidence — a parked
           * stream never ends, so "nothing came back" is a timer's verdict,
           * and the timer lost to eve's first byte on 10-30% of measured seam
           * reads — so it is read once more, behind the painted chat, and if
           * it is still silent the copy stays on screen unverified, exactly as
           * a timed-out read always left it. Nothing is deleted and the
           * shimmer never comes back over a painted chat.
           */
          const readSeam = async () => {
            const startedAt = performance.now();
            const tail = await replaySession(
              sessionId,
              undefined,
              { startIndex: cached.eventIndex - 1, parked: Boolean(s.session.continuationToken) },
              { signal: ticket.signal, timing },
            );
            return { tail, ms: performance.now() - startedAt };
          };
          let { tail, ms } = await readSeam();
          let verdict = seamVerdict(cached, tail, 1);
          timing.seam(verdict.status, ms);
          if (!ticket.current()) return;
          if (verdict.action === "retry") {
            console.warn(`[thread-open] seam read came back ${verdict.status} — reading it once more behind the painted chat`);
            ({ tail, ms } = await readSeam());
            verdict = seamVerdict(cached, tail, 2);
            timing.seam(verdict.status, ms);
            if (!ticket.current()) return;
          }
          if (verdict.action === "keep") {
            if (verdict.status !== "match") {
              console.warn(`[thread-open] seam read ${verdict.status} twice — keeping the cached transcript unverified`);
              return;
            }
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
          /**
           * The chat-switch guard, as `resync` has it: whatever comes next
           * replaces the transcript of THIS chat, so it must still be the chat
           * on screen. (The ticket covers a later click; this covers anything
           * else that changed the pane without one.)
           */
          if (mountKeyRef.current !== s.id) return;
          if (verdict.action === "extend") {
            const merged = mountFromSnapshot(cached, verdict.tail, localMarkers);
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
            mountCauseRef.current = "seam-tail";
            setAttachNonce((n) => n + 1);
            persist(
              sessionsRef.current.map((x) =>
                x.id === s.id ? { ...x, events: merged.events as AgentEvents, session: nextSession } : x,
              ),
            );
            // A tail that stopped at the live edge of a running turn is mid-turn: the chat's live reader carries on
            // from `merged.streamIndex`, and the copy is written when the turn parks.
            if (tail?.stop === "live") {
              timing.route("running");
              timing.savedCopy("skipped");
              return;
            }
            storeSnapshot({
              sessionId,
              chatSessionId: s.id,
              events: merged.events,
              streamIndex: merged.streamIndex,
              onOutcome: timing.savedCopy,
            });
            return;
          }
          // The stream positively disagreed. Say so — a cache that is silently
          // wrong is worse than no cache — forget the row, and replace the
          // transcript from the full replay, which is authoritative: behind the
          // painted chat, not under the shimmer.
          timing.route("snapshot-discarded");
          console.warn(`[thread-open] snapshot discarded (${verdict.status}) — replacing it behind the painted chat`);
          reportSnapshotEvent("snapshot-discarded", { sessionId, reason: verdict.status });
          snapshotIndexRef.current.delete(sessionId);
          void fetch(`/api/ops/chat-snapshots?session=${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
          }).catch(() => {});
          await replaceBehindPaint(s, sessionId, ticket, timing);
          return;
        }

        timing.route("full-replay");
        let fresh: Awaited<ReturnType<typeof replaySession>> = null;
        const replayStartedAt = performance.now();
        try {
          fresh = await replaySession(sessionId, undefined, undefined, { signal: ticket.signal, timing });
        } finally {
          // Only the open that put the shimmer up may take it down: a later click owns it now.
          if (ticket.current()) setOpeningChat(false);
        }
        if (!ticket.current()) return;
        if (fresh) {
          timing.replay(performance.now() - replayStartedAt, fresh.events.length);
          /**
           * This browser holds a LONGER copy than a replay that stopped early (`replayMayReplace`): show that copy,
           * as the local open below does, rather than a transcript cut short; nothing is stored over it.
           */
          if (s.events?.length && !replayMayReplace(fresh, longestCopyIndex(s, sessionId, snapshotIndexRef.current.get(sessionId)))) {
            console.warn(`[thread-open] replay stopped early (${fresh.stop}) at ${fresh.index} — keeping this browser's longer copy`);
            reportSnapshotEvent("snapshot-skipped", {
              sessionId,
              reason: `truncated-replay stop=${fresh.stop ?? "-"} index=${fresh.index ?? "-"} kept-local`,
            });
          } else {
            if (!endsAtRest(fresh.events)) timing.route("running");
            mountReplayed(s, sessionId, fresh, timing, false);
            return;
          }
        }
      }
      // A network open in flight may have put the shimmer up; this click cancelled it, so take it down.
      setOpeningChat(false);
      if (timing.record.route === "pending") timing.route(!s.events?.length || endsAtRest(s.events) ? "local" : "running");
      setInitialSession(s.session);
      setInitialEvents(dedupeEvents([...((s.events ?? []) as unknown[]), ...(s.markers ?? [])]) as AgentEvents);
      setMountKey(s.id);
      } finally {
        if (ticket.current()) timing.settled();
      }
    },
    [replaySession, persist, fetchSnapshot, storeSnapshot, getAuthHeaders, mountReplayed, replaceBehindPaint],
  );

  // The last chat, when the cache could not show it by itself (no transcript or no resume token here): open it the
  // way a click would, once, right after the first render.
  useEffect(() => {
    if (boot.last && !boot.instant) {
      // The page load's own open: its record's clock starts at navigation, not at a click.
      pageLoadOpenRef.current = true;
      void openChat(boot.last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the chat the first render found
  }, []);

  /**
   * The open's instrument (lib/chat-open-timing.ts), wired to this page: rows go
   * through the same fire-and-forget route as every other chat incident, the
   * composer is found in the chat pane, and lag is sampled by the browser.
   * Declared before the commit hook below so the page load's own chat, mounted
   * straight from the cache by the first render, is recorded too.
   */
  const authHeadersRef = useRef(getAuthHeaders);
  authHeadersRef.current = getAuthHeaders;
  useLayoutEffect(() => {
    configureChatOpenTiming({
      post: (row, keepalive) => {
        try {
          void fetch("/api/ops/chat-telemetry", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeadersRef.current() },
            body: JSON.stringify(row),
            keepalive,
          }).catch(() => {});
        } catch {
          /* never */
        }
      },
      composerReady: () => {
        const box = chatPaneRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
        return Boolean(box && !box.disabled);
      },
      lagSampler: browserLagSampler,
      storageChars: browserStorageChars,
    });
    if (boot.instant) {
      const t = beginChatOpen({
        chatId: boot.instant.id,
        sessionId: boot.instant.session?.sessionId,
        storedEvents: boot.instant.events?.length ?? 0,
        storedToken: Boolean(boot.instant.session?.continuationToken),
        pageLoad: true,
      });
      t.route(endsAtRest(boot.instant.events) ? "local" : "running");
      t.settled();
    }
    // The counter of opens leaves with the tab: a hidden or closing page gets one keepalive POST.
    const flush = () => flushOpenCounter(true);
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once; the live values are read through refs
  }, []);

  /**
   * Every commit of the chat pane, for the open's record: a new React key for
   * the open's chat is a mount (with the cause set just before it), and the
   * first commit with messages and no shimmer over them is the paint. Writes to
   * the record only; never sets state.
   */
  useLayoutEffect(() => {
    noteChatCommit({
      mountKey,
      reactKey: `${mountKey}#${attachNonce}`,
      hasMessages: Boolean(initialEvents?.length),
      shimmer: openingChat,
      cause: mountCauseRef.current,
    });
    mountCauseRef.current = "other";
  }, [mountKey, attachNonce, initialEvents, openingChat]);

  /**
   * The composer, as far as a waiting replacement cares (`replaceBehindPaint`):
   * a send marks the open as "has sent" and runs the replacement after the
   * message has had a moment to reach the server; a draft cleared to nothing
   * runs it at once.
   */
  const onPaneInput = useCallback(() => {
    if (!pendingSwapRef.current || composerHasDraft()) return;
    const run = pendingSwapRef.current;
    pendingSwapRef.current = null;
    run();
  }, [composerHasDraft]);
  const onPaneSubmit = useCallback(() => {
    sentAtRef.current = performance.now();
    if (!pendingSwapRef.current) return;
    const run = pendingSwapRef.current;
    pendingSwapRef.current = null;
    setTimeout(run, 1_500);
  }, []);

  // Remember which chat is open, so the next load reopens it; a new chat (or a shared one) forgets it.
  useEffect(() => {
    if (activeId && !activeId.startsWith("shared:")) writeStored(lastChatKey(email), activeId);
    else removeStored(lastChatKey(email));
  }, [activeId, email]);

  // The reopened chat was deleted on another device: once the server's list is in and it is not on it, start fresh
  // rather than keep a conversation open that no longer exists.
  useEffect(() => {
    const reopened = boot.instant?.id ?? boot.last?.id;
    if (!mergedFromDb || !reopened || activeIdRef.current !== reopened) return;
    if (!sessionsRef.current.some((s) => s.id === reopened)) newChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decided once, when the server list first lands
  }, [mergedFromDb]);

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
      const ticket = supersedeOpen();
      const events: unknown[] = [];
      let continuationToken: string | undefined;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
          headers: getAuthHeaders(),
          signal: ctrl.signal,
        });
        // The chat this page's LINK names is refused outright (not this person's chat, here or as a guest): if the
        // tab's workspace was refused as well, the page says "You are not a member of this workspace" rather than
        // opening an empty chat (lib/workspace-refusal.ts). Any other chat opened later changes nothing.
        if ((res.status === 404 || res.status === 403) && new URLSearchParams(window.location.search).get("chatSession") === sessionId) {
          noteChatRefused();
        }
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
      // A chat clicked while this session was being read is the one the person wants now.
      if (!ticket.current()) return;
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
    [getAuthHeaders, supersedeOpen],
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
      const ticket = supersedeOpen();
      setOpeningChat(true);
      try {
      // Read via the membership-checked proxy so a revoked member is cut off —
      // starting from the cached transcript, whose read is gated by the same
      // membership rule, so revoking still cuts everything off at once.
      const fresh = await replayFromCache(thread.eveSessionId, thread.id, undefined, ticket.signal);
      // A later click took over while this replayed: it owns the pane now.
      if (!ticket.current()) return;
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
        // Only while this is still the open the person asked for: a later one owns the shimmer.
        if (ticket.current()) setOpeningChat(false);
      }
    },
    [replayFromCache, supersedeOpen],
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
      installNotificationBridge((sid, url) => {
        // A chat in ANOTHER workspace than this tab's: load its link, which names the workspace — the page then
        // opens in that workspace (lib/startup-fetch.ts adopts `?org=`) instead of refusing the chat as unknown here.
        const org = url ? workspaceOfLink(url) : null;
        if (org && url && org !== activeOrg()) {
          window.location.assign(url);
          return;
        }
        const s = sessionsRef.current.find((x) => x.session?.sessionId === sid || x.id === sid);
        if (s) openChatRef.current(s);
        else void mountEveSession(sid);
      }),
    [mountEveSession],
  );

  /**
   * A link that names its workspace (`&org=`): the <head> script has already put this tab in it; tell the server too
   * — the switcher's path — before the chat is opened, so everything this page does from here is in that workspace.
   */
  const adoptLinkedWorkspace = useCallback(async (): Promise<void> => {
    const org = workspaceOfLink(window.location.href);
    if (org) await switchWorkspace(org);
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
    void (async () => {
      await adoptLinkedWorkspace();
      await mountEveSession(id);
    })();
  }, [mountEveSession, adoptLinkedWorkspace]);

  // Deep-link: `/?seed=<instruction>` opens a FRESH chat pre-loaded with the
  // instruction (auto-sent), so a dashboard action button calls the agent back
  // with the human in the loop — the agent proposes the tool, the operator
  // approves inline. Mounts once on load.
  useEffect(() => {
    const seed = new URLSearchParams(window.location.search).get("seed");
    if (!seed) return;
    supersedeOpen();
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
      await adoptLinkedWorkspace();
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
  }, [mountEveSession, getAuthHeaders, adoptLinkedWorkspace]);

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
              ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
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
          listUpdating={!mergedFromDb && !listStale}
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

      <div
        ref={chatPaneRef}
        className="relative flex min-w-0 flex-1 overflow-hidden"
        onInputCapture={onPaneInput}
        onSubmitCapture={onPaneSubmit}
      >
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
