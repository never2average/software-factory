"use client";

import { noteRender, renderCensus } from "@/lib/render-census";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyPanel } from "@/components/lazy-panel";
import { WorkspaceSummary } from "./workspace-summary";
import type { UserContent } from "ai";
import { resolveTextToResponses } from "eve/client";
import { defaultMessageReducer, useEveAgent } from "eve/react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  GitBranchIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  PaperclipIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RepeatIcon,
  TagIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { PromptInputButton, type PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { ChatComposer } from "./composer";
import { ContextRing } from "./context-ring";
import { CompactionDivider } from "./compaction-divider";
import { MonitorIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STORAGE_KEYS, readStored, writeStored } from "@/lib/browser-storage";
import { sharedGet } from "@/lib/startup-fetch";

/** Approx model context window for the gauge (Claude/GLM-class). Approximate on
 *  purpose — the ring is an indicator; eve owns the real compaction threshold. */
const CONTEXT_WINDOW = 200_000;

// Per-turn capability directives (each returns null when it needs to say nothing).
function searchDirective(on: boolean): string | null {
  return on ? null : "(Web search is off — do not use the web_search tool for this request.)";
}
/** Let the agent open a REAL browser (off by default → not mentioned). */
function browserDirective(on: boolean): string | null {
  return on
    ? "(Browser use is enabled — you may open a real browser (browser_open) and navigate + read pages with the browser tools when it helps.)"
    : null;
}
/** The agent's operating mode — one of four, exclusive. Build is the default. */
type AgentMode = "build" | "plan" | "goal" | "loop";
const MODES: {
  value: AgentMode;
  label: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "build", label: "Build", blurb: "Do the work, acting as needed", icon: HammerIcon },
  { value: "plan", label: "Plan", blurb: "Investigate & plan, take no action", icon: ListTodoIcon },
  { value: "goal", label: "Goal", blurb: "Drive to the objective end-to-end", icon: TargetIcon },
  { value: "loop", label: "Loop", blurb: "Iterate until the task is done", icon: RepeatIcon },
];
/** The per-turn directive for a mode. Steers the agent's OWN multi-step turn.
 *  Goal & Loop are NOT directives — they run in the harness via an
 *  `outputSchema` completion gate (see `goal-mode.ts` + `sendMessage`), so the
 *  harness keeps the model working until it records an outcome. Only Plan uses
 *  a directive; Build is normal execution. */
function modeDirective(mode: AgentMode): string | null {
  switch (mode) {
    case "plan":
      return `(Plan mode is ON — investigate and plan only, take no action. Use ONLY read-only tools to gather what you need; do NOT write, mutate, send, draft, schedule, post, page, or anything that would prompt for approval. If the request is ambiguous or has real options, ask me a short clarifying question first. Then give a concise plan: the goal, the concrete steps in order, which ${DEPLOYMENT_PROFILE.vocabulary.account.plural}/records/systems each step touches, and how we'll verify it. Then stop and wait for my explicit go — do not act until I approve.)`;
    default:
      return null; // "build" (normal), "goal"/"loop" (harness outputSchema gate)
  }
}
/** The text eve echoes back in `message.received` for this content (its text parts). */
function deliveryText(content: UserContent): string {
  if (typeof content === "string") return content;
  return (content as readonly { type?: string; text?: string }[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * What a chat is still OWED (deliveries eve has not started) — lib/chat-queue.
 * In localStorage when the chat is the person's own (shared across their tabs,
 * scoped like the chat cache); here, by chatKey, otherwise. Module scope for
 * the same reason either way: a hand-back or a resync REMOUNTS the chat, and
 * the list may not be lost to that. (Its QUEUE is held on the server —
 * use-chat-queue.ts.)
 */
const memoryOwed = new Map<string, OwedRecord>();
/** How long a 5xx/lost answer is watched for before the question comes back. */
const ANSWER_VERIFY_MS = 60_000;
/** How often an answer POST is tried when eve has not seen the park yet (see `answerPostRetryable`). */
const ANSWER_RETRIES = 10;

/**
 * Files of a queued item this tab must send ITSELF (`where: "local"` — the server could not hold the queue), by
 * item id. A server-held item's files are stored in the data room when it is queued, so it keeps them.
 */
const queuedFiles = new Map<string, AttachedFile[]>();
/** This page load. */
const TAB_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`;
/**
 * This tab's identity across its own reloads (lib/chat-queue `markGone`): the
 * ids of its earlier pages, which wrote themselves into the TAB's
 * sessionStorage as they unloaded. A reloaded tab knows their unacknowledged
 * messages were its own ("your earlier message"); a COPY of a live tab has no
 * such entry, so they read as another tab's.
 */
const SELF_IDS: ReadonlySet<string> = (() => {
  if (typeof window === "undefined") return new Set([TAB_ID]);
  try {
    return new Set([TAB_ID, ...readGone(window.sessionStorage)]);
  } catch {
    return new Set([TAB_ID]);
  }
})();
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => markGone(window.sessionStorage, TAB_ID));
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) unmarkGone(window.sessionStorage, TAB_ID);
  });
}
// A Stop's note, the turns this tab stopped and a Stop's transcript markers live in ./chat-stop-state, keyed
// `${email}:${orgId}:${chatKey}` and forgotten on sign-out (mold_v1-141).
/** Re-arm rounds of the live reader after its budget ran out, by `chatKey:turn`. */
const attachRounds = new Map<string, number>();
/** chatKey → ordinal of a turn the server reported as not running. */
const abandonedTurns = new Map<string, number>();
/**
 * `${chatKey}:${turn ordinal}` → resyncs spent on that turn. A resync is a full
 * replay and a remount; if the replay itself comes back short the watcher would
 * otherwise ask again, forever. Four per turn, then it just keeps the hold.
 */
const resyncsSpent = new Map<string, number>();
const RESYNC_BUDGET = 4;
/**
 * `${chatKey}:${turn ordinal}` → how many times THIS turn has been seen to
 * detach, and how many events the last resync mounted with.
 *
 * Both live at module scope because a resync REMOUNTS this component, and both
 * questions are about the turn, not the mount. Measured on 2026-09-21: one
 * session reported "Chat stream ended mid-turn and stopped resuming" three
 * times in 63 seconds, every record identical (`last event: message.appended`).
 * That was not three incidents; it was one detached turn, remounted by each
 * resync, re-reporting itself from a fresh mount. The replay a resync performs
 * deliberately returns as soon as a live turn goes quiet, so a turn that is
 * still running comes back mid-turn and the new mount is detached again.
 *
 * So: count the detaches here, report the FIRST one and the give-up at the end
 * of the budget, and refuse to spend another resync on a turn the last resync
 * made no progress on (that one needs a real session boundary, not a blind
 * retry).
 */
const detachesSeen = new Map<string, number>();
const detachesReported = new Map<string, number>();
const resyncEventFloor = new Map<string, number>();
/**
 * `${chatKey}:${turn ordinal}` → outer attach attempts already spent on that
 * turn, and turns whose stall has already been filed.
 *
 * Module scope for the same reason the maps above are: a resync REMOUNTS this
 * component, and both questions are about the TURN, not the mount. Without that
 * the budget resets on every remount and a session whose stream simply will not
 * open reopens it forever — each open costing the ownership gate two or three
 * workspace-scoped queries.
 */
const attachFailures = new Map<string, number>();
const stallsReported = new Map<string, number>();
/** How many readers this turn has already opened — see the telemetry note. */
const attachStarts = new Map<string, number>();
/**
 * Turns whose share was REVOKED (403). Terminal, and deliberately kept out of
 * `attachFailures`: that map is forgiven when the tab comes back, and forgiving
 * a revocation means re-probing the membership gate on every single focus — the
 * small denial-of-service against our own gate lib/chat-attach.ts says it is
 * avoiding. A 401 is the opposite case and is NOT recorded here (the credential
 * can be refreshed by signing in again).
 */
const attachRevoked = new Set<string>();
/**
 * Forget everything recorded about a chat's EARLIER turns.
 *
 * Every map above is keyed `chatKey:turn ordinal` and lives at module scope so
 * that a resync remount cannot reset it. Nothing ever removed an entry, so a
 * tab left open on a long conversation accumulated one entry per map per turn
 * for the life of the tab — small, but unbounded, and invisible. A turn that is
 * over can never be reported, resynced or attached again, so its entries are
 * dead the moment the next turn starts.
 *
 * The ordinal immediately behind the current one is SPARED: `turnsStarted`
 * counts `turn.started` events, and eve re-emits one for the SAME turn when it
 * replays after a step throws — so the newest ordinal can step forward without a
 * new turn having begun, and pruning it there would hand a still-running turn a
 * fresh attach budget and a second `attach-started`.
 */
function forgetFinishedTurns(chatKey: string, currentTurn: number): void {
  const oldest = currentTurn - 1;
  const prefix = `${chatKey}:`;
  for (const map of [
    detachesSeen,
    detachesReported,
    resyncEventFloor,
    attachFailures,
    stallsReported,
    attachStarts,
    attachRounds,
  ]) {
    for (const key of [...map.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const turn = Number(key.slice(prefix.length));
      if (Number.isFinite(turn) && turn < oldest) map.delete(key);
    }
  }
  for (const key of [...attachRevoked]) {
    if (!key.startsWith(prefix)) continue;
    const turn = Number(key.slice(prefix.length));
    if (Number.isFinite(turn) && turn < oldest) attachRevoked.delete(key);
  }
}
/** Outer attach attempts per turn, then the resync/replay watcher owns it. */
const ATTACH_BUDGET = 4;
/**
 * How long an unfinished turn may be silent before it is COUNTED as stalled.
 *
 * Not a verdict and nothing on screen changes: one long tool call (a browser
 * session, a subagent) can legitimately emit nothing for a while. It is a count,
 * because the existing `stream-gave-up` site only fires when the store happens
 * to be `ready`, so a death that leaves it `streaming`, `submitted` or `error`
 * has always recorded NOTHING — the most likely reason the whole history of chat
 * incidents is five rows against an operator reporting "many many problems".
 */
const STALL_MS = 90_000;
const COMPACT_INSTRUCTION =
  "Summarize our entire conversation so far into a compact handoff brief: the goal, the key decisions and facts established, the current state, and what remains to do. Keep every constraint, preference, datum, and reference needed to continue. Reply with ONLY the summary — no preamble.";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";
import {
  answerPostRetryable,
  appendTailEvent,
  attachDecision,
  attachRearmAllowed,
  awaitingSpecialists,
  liveDelegations,
  specialistWorkingLine,
  ANSWER_CHECKING_LINE,
  answerNeedsCheck,
  type AnswerPostOutcome,
  stopTarget,
  stoppedFromEvents,
  stoppedMarker,
  stoppedNoteHosts,
  stoppedTurnNotes,
  turnShowedNothing,
  attachRetryDelayMs,
  composerRoute,
  deadInputRequestIds,
  effectiveDismissals,
  handBackSession,
  holdLabel,
  isRenderLoopError,
  isSessionBoundary,
  mergeAttachedEvents,
  outstandingDeliveries,
  pendingInputRequestParts,
  proxiedChildRequestIds,
  renderLoopDetail,
  renderLoopScene,
  resyncDecision,
  retryStormDetected,
  sendGate,
  absoluteIndexBase,
  serverEventCount,
  shouldReportDetach,
  stopAvailable,
  tailStillWriting,
  turnFinished,
  turnsStarted,
  turnUnfinished,
  withoutRequestIds,
  withRequestIds,
  withSessionEpochs,
  withoutResponses,
  withResponses,
  receivedSince,
  type Delivery,
  type IndexedEvent,
  type TurnEvent,
} from "@/lib/chat-turn-state";
import { detachedOutstanding } from "@/lib/detached-delegation";
import {
  deliveryId,
  isOwedKeyOf,
  markGone,
  readGone,
  unmarkGone,
  owedKey,
  releasable,
  readOwed,
  updateOwed,
  type OwedRecord,
  type PendingDelivery,
  type QueueSettings,
} from "@/lib/chat-queue";
import { useChatQueue, type QueueEntry } from "./use-chat-queue";
import { onStopMarker, recordStopMarker, stopKey, stopMarkersFor, stopNotes, stoppedHere } from "./chat-stop-state";
import { notifyFromPage, setViewingSession } from "./desktop-notify";
import { eveSessionStream, readLiveTail, readTailEvent, streamHasMoved, threadProxyStream } from "@/lib/chat-attach";
import type { ChatTelemetryKind } from "@/lib/chat-telemetry";
import {
  activeSettingLabels,
  composeAttachmentMessage,
  displayTitle,
  wrapDirectives,
} from "@/lib/chat-attachments";
import { cn } from "@/lib/utils";
import { AgentMessage, PendingApprovalCard, messageRendersContent } from "./agent-message";
import { HandbackNote } from "./handback-note";
import { isHandbackTranscriptMessage, messageText } from "@/lib/handback-text";
import { GOAL_OUTCOME_SCHEMA, asGoalOutcome, goalPreamble, type GoalOutcome } from "./goal-mode";
import type { ChatMeta } from "./chat-shell";
import type { OpsSection } from "./ops-center";
import { ErrorBoundary } from "./error-boundary";
import { CustomerSearchDialog, type CustomerListItem, type CustomerListStatus } from "./customer-search";
import { CustomerMark } from "./customer-mark";
import { DEPLOYMENT_PROFILE, fillProfileText } from "@/lib/deployment-profile.generated";
import type { BadgeTone, DataItem } from "./dataroom";
import { deriveInsights } from "./insights";
import { ArtifactPanel, artifactFromHref, readableArtifactName } from "./artifact-view";
import { ShareThreadButton, type SharePayload } from "./share-thread";
import { opsFetch } from "./ops/lib";

// The control panel (runs, graphs, dashboards) is fetched when a chat first shows it, not with the composer. Its
// placeholder fills the rail it will occupy (the <aside> already has its width), so nothing moves when it lands.
const Cockpit = lazyPanel(() => import("./cockpit").then((m) => m.Cockpit), {
  label: "The control panel",
  placeholder: () => <CockpitPlaceholder />,
});

/** The control panel's outline while its code loads: its 48px header and a few rows, filling the rail. */
function CockpitPlaceholder() {
  return (
    <div aria-busy="true" data-testid="cockpit-loading" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center border-border border-b px-3">
        <span className="font-medium text-sm">Control Panel</span>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {[80, 64, 72].map((w) => (
          <div key={w} className="h-3.5 animate-pulse rounded bg-muted/50" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

export type AgentSession = NonNullable<
  NonNullable<Parameters<typeof useEveAgent>[0]>["initialSession"]
>;
export type AgentEvents = NonNullable<
  NonNullable<Parameters<typeof useEveAgent>[0]>["initialEvents"]
>;

interface AttachedFile {
  id: string;
  name: string;
  dataUrl: string;
  mediaType: string;
  /**
   * The ORIGINAL File. Kept because the data URL cannot be turned back into a
   * blob in the browser: `fetch("data:…")` is governed by `connect-src`, and the
   * CSP here is `connect-src 'self' https://accounts.google.com`, so the browser
   * blocks it. That call used to be best-effort — the inline copy still reached
   * the agent — so the failure was invisible. Once the upload became the ONLY
   * way the file travels, the block surfaced as "this attachment failed to
   * upload" on a file that was perfectly fine.
   */
  file: File;
}

interface AgentChatProps {
  readonly getAuthHeaders: () => Record<string, string>;
  readonly initialSession?: AgentSession;
  readonly initialEvents?: AgentEvents;
  /** Stable per-mount key so persistence can update this chat in place even if
   *  the underlying eve session id gets re-minted (e.g. after a stream error). */
  readonly chatKey: string;
  readonly onPersist: (
    session: AgentSession,
    meta: ChatMeta,
    events: AgentEvents,
    chatKey: string,
  ) => void;
  readonly onToggleSidebar: () => void;
  /** Auto-sent as the first message of a fresh mount (used by plan forking). */
  readonly initialPrompt?: string;
  /** The thread this one was forked from — renders a "back to original" link. */
  readonly forkedFrom?: { id: string; title: string };
  /** Provenance of a chat opened from an automation — renders an indicator at
   *  the top saying where the thread came from. `kind` picks the wording:
   *  'cron' → "Auto-triggered … via <via>" (amber); 'workflow-run' / 'app' →
   *  "Workflow run · <via>" / "App refresh · <via>" (neutral). `ts` optional. */
  readonly autoBadge?: { ts?: string; via: string; kind?: "cron" | "workflow-run" | "app" };
  /** Open a NEW thread seeded with the finished plan (chat-shell owns mounting). */
  readonly onForkPlan?: (plan: string) => void;
  /** Compact: open a fresh thread seeded with a summary of THIS one (the context
   *  ring's click action). chat-shell owns mounting the compacted thread. */
  readonly onCompact?: (summary: string) => void;
  /** Navigate to another thread by id (the fork's back-link). */
  readonly onOpenThread?: (id: string) => void;
  /**
   * Re-attach to THIS session's stream after it dropped mid-answer.
   *
   * The store reads its session config once, when it is created, so there is no
   * in-place "reconnect" to call: the shell remounts this component seeded with
   * the cursor and events handed over here, and the fresh store re-opens the
   * stream where the old one died. The turn itself never stopped — it is durable
   * server-side — so this recovers the rest of the answer rather than asking the
   * model to say it again.
   */
  readonly onReattach?: (session: AgentSession, events: AgentEvents) => void;
  /**
   * Re-read this chat's session from the server and remount on the result.
   *
   * Used when a turn this component stopped listening to has settled: the eve
   * store streams only from `send()`, so the rest of that reply can only reach
   * the screen through a replay. `clientEvents` are the answered-input markers
   * the server has never heard of. Resolves false when nothing was mounted.
   */
  readonly onResync?: (
    sessionId: string,
    clientEvents: readonly unknown[],
    /** Server events already on screen; a shorter replay must not replace them. */
    knownServerEvents?: number,
  ) => Promise<boolean>;
  /** Open the Ops Center on a section (optionally deep-linked to a row id). */
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
  readonly sidebarCollapsed: boolean;
  readonly selectedCustomers: string[];
  readonly onCustomersChange: (customers: string[]) => void;
  readonly customers: CustomerListItem[];
  /** Where the workspace's list stands: the picker says "loading" or "could not be loaded" rather than "none". */
  readonly customersStatus?: CustomerListStatus;
  /** Reads the workspace's list again (the picker's Retry after a failed read). */
  readonly onRetryCustomers?: () => void;
  /** A shared thread opened by a non-owner: the transcript is live but the
   *  composer is replaced by a view-only notice (multiplayer Phase 1). */
  readonly readOnly?: boolean;
  /** The owner of a shared thread being viewed (shown in the view-only notice). */
  readonly readOnlyOwner?: string;
  /** A shared thread this PARTICIPANT can send into: messages route through the
   *  server relay (POST /api/ops/threads/:id/messages) instead of the eve store,
   *  so token custody + turn serialization stay server-side (multiplayer Phase 2). */
  readonly relayThreadId?: string;
  /** Called after a relay send completes (turn parked) so the shell can refresh
   *  the transcript from the replayed stream. */
  readonly onRelaySent?: () => void;
  /** The server thread id when this mount is a SHARED thread (owner-view,
   *  participant, or viewer) — drives presence heartbeats + the avatar stack. */
  readonly sharedThreadId?: string;
  /**
   * `${email}:${orgId}` — the scope the chat cache is stored under. Where a
   * chat's queue and owed deliveries are kept (lib/chat-queue); absent, they
   * live in memory only.
   */
  readonly storageScope?: string;
}

type MsgList = readonly { role: string; parts?: readonly unknown[] }[];

function firstUserText(messages: MsgList) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts ?? []) {
      const part = p as { type?: string; text?: string };
      if (part.type === "text" && part.text?.trim()) return part.text.trim();
    }
  }
  return undefined;
}

/**
 * The title as STORED: the first thing the person sent, untouched. Directives
 * are removed where a title is SHOWN (`displayTitle` in the sidebar, the search
 * and the fork banner) and nowhere else, so a display rule can never lose words
 * from the stored copy.
 */
function cleanTitle(text?: string) {
  return text?.trim() || undefined;
}

/** The preview as STORED: the last text, untouched (cleaned where shown — see `cleanTitle`). */
function lastText(messages: MsgList) {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const p of messages[i].parts ?? []) {
      const part = p as { type?: string; text?: string };
      if (part.type === "text" && part.text?.trim()) return part.text.trim();
    }
  }
  return undefined;
}

/**
 * Synthesize `client.input.responded` events for every already-answered input
 * request in the projected messages. The eve store marks a question/approval
 * answered ONLY from this client-side event, which lives in its derived list and
 * is NEVER in `agent.events` (the raw server stream). So a persisted/reopened
 * thread — whose events are exactly that raw stream — would replay every answered
 * input as still-pending and hoist it to the tail (a question re-asked, an
 * approval re-shown after a tab switch). Appending these recreates the answered
 * state when the reducer replays the events on the next mount. Questions never
 * get a server-side resolution (unlike a tool approval's `action.result`), so
 * this is the only signal that survives a reload for them.
 *
 * TWO sources, because not every answered input is reflected on its part. When
 * an answer is delivered via `directDeliver` (a parked/tokenless session — which
 * is exactly the state these clarification questions sit in), the eve store
 * never sees a `client.input.responded`, so the part keeps NO `inputResponse`.
 * `extra` — the responses this session actually recorded — closes that gap:
 * without it, a directDeliver-answered question reverted to pending on reopen.
 */
/** Dismissed (waved-away) input requests, persisted across reopens. Keyed
 *  globally because requestIds are unique UUIDs — no need to scope by chat. */
const DISMISSED_KEY = STORAGE_KEYS.dismissedInputs;
function readDismissed(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = readStored(DISMISSED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function persistDismissed(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    // Cap so this can't grow without bound; the tail is what matters.
    writeStored(DISMISSED_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    /* quota — a dropped dismissal just re-hoists, not fatal */
  }
}

type AnsweredResponse = { requestId: string; optionId?: string; text?: string };
function respondedInputEvents(messages: MsgList, extra: Record<string, AnsweredResponse>): unknown[] {
  const byId = new Map<string, AnsweredResponse>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      const part = p as {
        type?: string;
        toolMetadata?: { eve?: { inputResponse?: AnsweredResponse } };
      };
      const resp = part.type === "dynamic-tool" ? part.toolMetadata?.eve?.inputResponse : undefined;
      if (resp && typeof resp.requestId === "string" && resp.requestId) byId.set(resp.requestId, resp);
    }
  }
  for (const [rid, resp] of Object.entries(extra)) if (rid) byId.set(rid, resp);
  return [...byId.values()].map((resp) => ({ type: "client.input.responded", data: { responses: [resp] } }));
}

interface OnlineMember {
  email: string;
  typing: boolean;
}
interface Presence {
  online: OnlineMember[];
  turnHolder: string | null;
}

/** Polled presence heartbeat for a shared thread: POST every ~9s (bumping the
 *  typing window when the local user is composing) and take the live roster +
 *  current turn-holder from the same response. Best-effort; a failed beat is
 *  silently ignored. Inert when `threadId` is undefined (single-player chat). */
function usePresence(threadId: string | undefined, typing: boolean): Presence {
  const [presence, setPresence] = useState<Presence>({ online: [], turnHolder: null });
  const typingRef = useRef(typing);
  typingRef.current = typing;
  useEffect(() => {
    if (!threadId) {
      setPresence({ online: [], turnHolder: null });
      return;
    }
    let alive = true;
    const beat = async () => {
      try {
        const p = await opsFetch<Presence>(`/api/ops/threads/${threadId}/presence`, {
          method: "POST",
          body: JSON.stringify({ typing: typingRef.current }),
        });
        if (alive) setPresence({ online: p.online ?? [], turnHolder: p.turnHolder ?? null });
      } catch {
        /* offline / not a member — leave presence as-is */
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), 9000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [threadId]);
  return presence;
}

/** Overlapping avatar stack of the teammates currently viewing a shared thread. */
function PresenceStack({ online }: { readonly online: OnlineMember[] }) {
  if (online.length === 0) return null;
  const shown = online.slice(0, 4);
  const typingNames = online.filter((o) => o.typing).map((o) => o.email.split("@")[0]);
  return (
    <span className="flex items-center gap-1.5" title={`${online.length} online`}>
      <span className="flex -space-x-1.5">
        {shown.map((o) => (
          <span key={o.email} className="rounded-[5px] ring-2 ring-background" title={o.email}>
            <CustomerMark name={o.email} size="sm" />
          </span>
        ))}
        {online.length > shown.length ? (
          <span className="grid size-5 place-items-center rounded-[5px] bg-muted text-2xs text-muted-foreground ring-2 ring-background">
            +{online.length - shown.length}
          </span>
        ) : null}
      </span>
      {typingNames.length > 0 ? (
        <span className="text-2xs text-muted-foreground">
          {typingNames[0]}
          {typingNames.length > 1 ? ` +${typingNames.length - 1}` : ""} typing…
        </span>
      ) : null}
    </span>
  );
}

export function AgentChat({
  getAuthHeaders,
  initialSession,
  initialEvents,
  initialPrompt,
  forkedFrom,
  autoBadge,
  onForkPlan,
  onCompact,
  onOpenThread,
  onReattach,
  onResync,
  onOpenOps,
  chatKey,
  onPersist,
  onToggleSidebar,
  sidebarCollapsed,
  selectedCustomers,
  onCustomersChange,
  customers,
  customersStatus = "ready",
  onRetryCustomers,
  readOnly,
  readOnlyOwner,
  relayThreadId,
  onRelaySent,
  sharedThreadId,
  storageScope,
}: AgentChatProps) {
  noteRender("AgentChat");
  /**
   * A dropped stream must not look like a finished answer.
   *
   * An eve session stream is a live tail with no heartbeat: only
   * session.completed / session.failed close it cleanly. Anything else that
   * severs it — a function timeout, laptop sleep, a network change, an idle
   * proxy — ends the body mid-answer. The store retries (3 by default) and then
   * gives up, and because no onError was wired the give-up was SILENT: the
   * reply simply stopped with no error, which is exactly how "threads keep
   * dying" looks from the outside.
   */
  const [streamError, setStreamError] = useState<string | null>(null);
  /**
   * The last store error was a React render loop, not a stream failure.
   *
   * Declared ABOVE the store so `onError` never reads it through the temporal
   * dead zone (the same trap the DEAD_TOKEN_SIGNAL comment below describes). It
   * suppresses the "Request failed" card for an error the reader can do nothing
   * about and that says nothing true about their reply.
   */
  const renderLoopRef = useRef(false);
  /** The scene at the moment the store throws — see renderLoopScene. */
  const sceneRef = useRef("");
  const [renderLoop, setRenderLoop] = useState(false);

  /**
   * Say something happened. Fire-and-forget, never throws, never awaited.
   *
   * This file had 2,600 lines and no logging, so every chat failure so far has
   * been found by a person noticing and another person digging. One line at each
   * failure turns that into a query.
   */
  /** The live session id, readable from callbacks the hook owns. */
  const sessionIdRef = useRef<string | null>(null);
  const report = useCallback(
    /**
     * `ChatTelemetryKind`, not `string`. The route answers 202 on a parse
     * failure, so a kind it does not list is accepted, dropped and looks exactly
     * like a kind that never fired — which is how `resync` and `stop` were
     * emitted from here for weeks and never once reached `automation_audit`.
     * Typing the parameter makes that a typecheck failure instead of silence.
     */
    (kind: ChatTelemetryKind, extra: Record<string, unknown> = {}) => {
      try {
        void fetch("/api/ops/chat-telemetry", {
          method: "POST",
          headers: { "content-type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ kind, ...extra }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* telemetry must never break chat */
      }
    },
    [getAuthHeaders],
  );
  // Turn ids restart at turn_0 in every eve session; keep them unique when one
  // transcript spans two (see withSessionEpochs). Read once, at store creation.
  const [reducer] = useState(() => withSessionEpochs(defaultMessageReducer()));
  /**
   * The absolute-index deficit of THIS mount (see absoluteIndexBase). Read once,
   * from the cursor and transcript the mount was seeded with — a cached transcript
   * is compacted, so counting it understates where the stream actually is.
   */
  const [indexBase] = useState(() =>
    absoluteIndexBase(initialSession?.streamIndex, initialEvents as readonly TurnEvent[] | undefined),
  );
  /** Absolute stream position of a transcript, compaction included. */
  const absoluteIndex = useCallback(
    (events: readonly TurnEvent[]) => serverEventCount(events) + indexBase,
    [indexBase],
  );
  /** Events the store has read, and errors it has raised — see `onEvent` below. */
  const storeEventsSeenRef = useRef(0);
  const storeErrorsRef = useRef(0);
  const agent = useEveAgent({
    reducer,
    headers: getAuthHeaders,
    initialSession,
    initialEvents,
    /**
     * A budget of stream SEGMENTS, not a retry storm.
     *
     * The stream is severed every ~120s regardless of health, and each
     * "attempt" is just reopening at the next index — it only fires when a
     * segment ends without a turn boundary, and it resumes exactly where it
     * stopped. At 6 this capped every conversation at twelve minutes and then
     * went silent with no error, which is precisely the reported symptom.
     * 200 segments is a ceiling no real turn reaches.
     */
    maxReconnectAttempts: 200,
    // Counted so a send can tell "the POST failed" (nothing read, an error)
    // from "the POST landed and eve is holding it" (see `recordDelivery`).
    onEvent: () => {
      storeEventsSeenRef.current += 1;
    },
    onError: (e) => {
      storeErrorsRef.current += 1;
      const msg = e.message || "";
      /**
       * A missing continuation token is RECOVERABLE and must not be dressed up
       * as a dead reply.
       *
       * eve mints a fresh token on every re-park, and the store's cursor only
       * advances at a clean turn boundary — so a compaction, or a tab
       * backgrounded long enough for the stream to be severed, leaves the store
       * holding a token the server has already retired. Every EXPLICIT send path
       * here already recovers from this by re-deriving the freshest token from
       * the stream. This callback did not: it painted "The reply was cut off …
       * the agent kept going, so the rest of it is still there", which is both
       * alarming and wrong — nothing was lost and the turn is fine.
       *
       * Report it (so it stays countable) but do not tell the user their reply
       * is gone. The next action re-derives the token on its own.
       */
      // Literal, not DEAD_TOKEN_SIGNAL: that const is declared far below this
      // closure, and relying on it being initialised by call time is a
      // temporal-dead-zone crash waiting for the one path that fires early.
      const recoverable = /continuationToken/i.test(msg) && !msg.includes("Cannot deliver inputResponses");
      /**
       * A RENDER loop is not a stream failure — and must not end the turn.
       *
       * The store notifies its subscribers synchronously from inside the
       * `for await` that reads the stream (eve-agent-store.js, `#O()`), so a
       * React "maximum update depth" throw unwinds into the store's own catch,
       * where it is recorded as `agent.error` and the turn is marked `error`.
       * Measured once in production (2026-09-21 13:33:52, `Minified React error
       * #185`) against a turn whose stream was perfectly healthy. No
       * ErrorBoundary can catch it: the throw is delivered at the next setState
       * call site, which is the store's, not inside the boundary's subtree.
       *
       * Counted under its own kind so a loop is findable, but never painted as a
       * dropped connection and never treated as the end of the reply — the turn
       * is still running server-side, and the detached-turn hold plus the resync
       * watcher below pull the rest of it in.
       */
      if (isRenderLoopError(msg)) {
        renderLoopRef.current = true;
        setRenderLoop(true);
        report("render-loop", {
          sessionId: sessionIdRef.current ?? undefined,
          // The scene, not just the code: #185 minifies to a sentence that names nothing.
          // And WHO was rendering (lib/render-census.ts): the scene says what was on
          // screen, the census which component was looping. Census first, so the
          // 300-character cap trims the error text — the one part that says nothing.
          detail: renderLoopDetail(msg, sceneRef.current, renderCensus()),
        });
        return;
      }
      // A REAL failure after a loop must be shown: the suppression above is for
      // the loop error only, never a blanket mute on `agent.error`.
      if (renderLoopRef.current) {
        renderLoopRef.current = false;
        setRenderLoop(false);
      }
      if (!recoverable) setStreamError(msg || "The connection to the agent dropped.");
      report(recoverable ? "resume" : "stream-error", {
        sessionId: sessionIdRef.current ?? undefined,
        detail: msg.slice(0, 300),
      });
    },
  });
  // Any forward progress means the stream is alive again — clear the notice
  // rather than leaving a stale error above a streaming reply.
  useEffect(() => {
    if (agent.status === "streaming" || agent.status === "submitted") {
      setStreamError(null);
      // Forward progress means the loop (if there ever was one) is behind us.
      if (renderLoopRef.current) {
        renderLoopRef.current = false;
        setRenderLoop(false);
      }
    }
  }, [agent.status]);

  useEffect(() => {
    sessionIdRef.current = agent.session?.sessionId ?? null;
  }, [agent.session?.sessionId]);
  /**
   * The session this transcript belongs to, SURVIVING a cursor reset.
   *
   * eve's client drops its whole cursor — session id included — whenever a
   * stream ends without a session boundary (`advanceSession` in
   * node_modules/eve/dist/src/client/session-utils.js): Stop, a severed body
   * with the reconnect budget spent, an abort. The turn is still running under
   * that id, and it is the only handle for cancelling it or reading how it
   * ended.
   */
  const liveSessionIdRef = useRef<string | null>(initialSession?.sessionId ?? null);
  if (agent.session?.sessionId) liveSessionIdRef.current = agent.session.sessionId;

  /* ── THE LIVE TAIL ──────────────────────────────────────────────────────────
   *
   * Events read from the session's stream by a reader the STORE does not own,
   * because the store only reads while it is sending (see `attachDecision`).
   * Every entry carries the absolute stream index it arrived at; the merge
   * deduplicates on that index, and the store always wins an index it holds.
   *
   * Declared here, above everything that reads the transcript, because from this
   * point on `mergedEvents` and `view` are what the component reasons about —
   * the gate, the telemetry, the context ring, the hoisted approvals, the
   * rendered messages. Reading `agent.events` below this line would mean
   * deciding a turn is dead while its reply is arriving two lines away.
   */
  const [attachedTail, setAttachedTail] = useState<readonly IndexedEvent[]>([]);
  /**
   * The merge's `nextIndex` is the store's ABSOLUTE position, never its length.
   *
   * `mergeAttachedEvents` defaults it to `serverEventCount(storeEvents)`, and
   * that default is only right for a transcript read straight off the stream.
   * A reopened thread mounts a COMPACTED cached transcript (#38), so the store
   * holds fewer events than the index it covers — while the reader is started
   * at `absoluteIndex(...)`, count PLUS the compaction deficit. The tail then
   * began at 103 while the merge was still looking for 100, every entry read as
   * a gap, and the merge returned the store's array untouched: on exactly the
   * mount the reattach exists for — a thread reopened mid-turn — the live tail
   * never reached the transcript at all, while `view` above projected it, so
   * the reply was on screen and the gate, the telemetry and the reader's own
   * resume index could not see it. The two changes shipped the same day and
   * each one's offline test passed alone.
   */
  const mergedEvents = useMemo(
    () =>
      mergeAttachedEvents(
        agent.events as readonly TurnEvent[],
        attachedTail,
        absoluteIndex(agent.events as readonly TurnEvent[]),
      ),
    [agent.events, attachedTail, absoluteIndex],
  ) as typeof agent.events;
  /**
   * The transcript as projected from the store's events AND the live tail.
   *
   * Folded ONTO `agent.data` rather than re-reduced from zero: that is what
   * keeps `withSessionEpochs` correct (its epoch state is a non-enumerable
   * property of the data object, so continuing from the store's output
   * continues its epoch) and what keeps this O(new events) instead of
   * O(transcript) on every frame of a streaming reply.
   *
   * The cache is keyed on identity: a new `agent.data` (the store advanced, or
   * a send replaced the optimistic bubble) throws it away and re-folds the whole
   * tail, which is correct because `reduce` is pure.
   *
   * What is folded is what the MERGE accepted, not the raw tail. Projecting the
   * raw tail let the screen and the transcript disagree: a tail entry the merge
   * dropped (an index the store already holds, or one stranded behind a gap)
   * was still reduced into the view, so the reply could be visibly on screen
   * while `mergedEvents` — which is what the send gate, the stall telemetry and
   * the reader's own resume index are computed from — did not contain it.
   */
  const projectionRef = useRef<{ base: unknown; applied: number; data: typeof agent.data } | null>(
    null,
  );
  const view = useMemo(() => {
    const accepted = mergedEvents.length - agent.events.length;
    if (accepted <= 0) return agent.data;
    const cached = projectionRef.current;
    const reusable = cached !== null && cached.base === agent.data && cached.applied <= accepted;
    let data = reusable ? cached.data : agent.data;
    for (let i = agent.events.length + (reusable ? cached.applied : 0); i < mergedEvents.length; i++) {
      data = reducer.reduce(data, mergedEvents[i] as never) as typeof agent.data;
    }
    projectionRef.current = { base: agent.data, applied: accepted, data };
    return data;
  }, [agent.data, agent.events, mergedEvents, reducer]);
  // The actual responses this session recorded, keyed by requestId. This is the
  // durable source for persisting answered questions/approvals — the part's own
  // `inputResponse` is missing whenever the answer went out via directDeliver.
  const [answeredResponses, setAnsweredResponses] = useState<Record<string, AnsweredResponse>>({});
  /** Requests whose answer the server refused — shown live again (see `answerRejected`). */
  const [rejectedRequestIds, setRejectedRequestIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const viewMessages = useMemo(
    () =>
      withoutResponses(withResponses(view.messages, answeredResponses), rejectedRequestIds) as typeof view.messages,
    [view.messages, answeredResponses, rejectedRequestIds],
  );

  /**
   * MESSAGES EVE IS STILL HOLDING FOR US — see `outstandingDeliveries`.
   *
   * eve answers 200 to a message sent while a turn is running or a specialist
   * is parked, emits nothing for it, and runs it as a turn of its own after the
   * next `session.waiting`. Every reader stops at the first boundary, so that
   * turn was read only when the NEXT send happened to open a stream — the reply
   * one message behind. While a delivery is outstanding the chat keeps a reader
   * on the stream past the boundary (`attachDecision` "buffered") and holds new
   * messages in the queue (`sendGate` "delivering") instead of stacking more
   * into eve's buffer, where nothing can remove them.
   */
  /*
   * WHAT EVE OWES THIS CHAT, shared by the person's tabs (lib/chat-queue) — the
   * only cross-tab state, because it decides what is ON SCREEN: a tab that knows
   * eve still holds a message keeps reading past the boundary instead of falling
   * a reply behind. Each tab writes only its own record. (The QUEUE is per tab —
   * below.) Neither is used for a thread that is not the person's own: another
   * person's text must never show up, or go out around the relay.
   */
  const ownsPending = Boolean(storageScope) && !readOnly && !relayThreadId && !sharedThreadId;
  const pendingChatId = liveSessionIdRef.current ?? initialSession?.sessionId ?? chatKey;
  const owedKeyNow = ownsPending && storageScope ? owedKey(storageScope, pendingChatId) : null;
  const localStore = () => (typeof window === "undefined" ? null : window.localStorage);
  const memoryOwedList = (rec: OwedRecord | undefined): PendingDelivery[] => {
    if (!rec) return [];
    const released = new Set(rec.released);
    return rec.deliveries.map((d) => ({ ...d, tab: TAB_ID })).filter((d) => !released.has(deliveryId(d)));
  };
  const [owed, setOwed] = useState<readonly PendingDelivery[]>(() =>
    owedKeyNow ? readOwed(localStore(), owedKeyNow) : memoryOwedList(memoryOwed.get(chatKey)),
  );
  const owedKeyRef = useRef(owedKeyNow);
  /** Change THIS tab's record of what is owed — the only one it writes. */
  const changeOwed = useCallback(
    (change: (own: OwedRecord) => OwedRecord) => {
      const key = owedKeyRef.current;
      if (key) {
        setOwed(updateOwed(localStore(), key, TAB_ID, change));
        return;
      }
      const next = change(memoryOwed.get(chatKey) ?? { beat: Date.now(), deliveries: [], released: [] });
      memoryOwed.set(chatKey, next);
      setOwed(memoryOwedList(next));
    },
    [chatKey],
  );
  // A new chat got its session id: move this tab's record to the session's key.
  useEffect(() => {
    const prev = owedKeyRef.current;
    owedKeyRef.current = owedKeyNow;
    if (!owedKeyNow || !prev || prev === owedKeyNow) return;
    const mine = readOwed(localStore(), prev).filter((d) => d.tab === TAB_ID);
    if (mine.length === 0) return;
    updateOwed(localStore(), prev, TAB_ID, () => ({ beat: Date.now(), deliveries: [], released: [] }));
    setOwed(
      updateOwed(localStore(), owedKeyNow, TAB_ID, (o) => ({
        ...o,
        deliveries: [...o.deliveries, ...mine.map(({ tab: _tab, ...d }) => d)],
      })),
    );
  }, [owedKeyNow]);
  // Another tab's delivery is owed here too.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      const key = owedKeyRef.current;
      if (key && isOwedKeyOf(key, e.key)) setOwed(readOwed(window.localStorage, key));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  /**
   * A CLOCK FOR THE ESCAPE HATCH. `outstandingDeliveries` drops a delivery
   * after `DELIVERY_MAX_AGE_MS`, but it is memoised — without a clock that
   * moves, the age was never looked at again and the hatch never opened.
   */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (owed.length === 0) return;
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [owed.length]);
  // Only deliveries to the session on screen can be acked by it.
  const currentSid = liveSessionIdRef.current;
  const deliveries = useMemo(
    () => owed.filter((d) => !d.sessionId || !currentSid || d.sessionId === currentSid),
    [owed, currentSid],
  );
  const deliveriesRef = useRef(deliveries);
  deliveriesRef.current = deliveries;
  const outstanding = useMemo(
    () =>
      outstandingDeliveries({
        deliveries,
        events: mergedEvents as readonly TurnEvent[],
        indexBase,
        now: clock,
      }),
    [deliveries, mergedEvents, indexBase, clock],
  );
  // This tab's OWN earlier page counts as this tab (a reload is not another tab).
  const owedFromOtherTab =
    outstanding.length > 0 && outstanding.every((d) => !SELF_IDS.has((d as PendingDelivery).tab ?? ""));
  // This tab's settled deliveries are forgotten a minute later — not at once,
  // because another tab may not have read their turn yet (it holds until it has).
  useEffect(() => {
    const settled = deliveries.filter((d) => d.tab === TAB_ID && !outstanding.includes(d));
    if (settled.length === 0) return;
    const oldest = Math.min(...settled.map((d) => d.sentAt));
    const t = setTimeout(
      () => {
        const cutoff = Date.now() - 60_000;
        const gone = new Set(settled.filter((d) => d.sentAt <= cutoff).map((d) => d.sentAt));
        if (gone.size) changeOwed((o) => ({ ...o, deliveries: o.deliveries.filter((d) => !gone.has(d.sentAt)) }));
      },
      Math.max(1_000, oldest + 61_000 - Date.now()),
    );
    return () => clearTimeout(t);
  }, [deliveries, outstanding, changeOwed]);
  const recordDelivery = (text: string, kind: "message" | "answer" = "message"): Delivery => {
    const d: Delivery = {
      text,
      at: absoluteIndex(mergedEvents as readonly TurnEvent[]),
      sentAt: Date.now(),
      sessionId: liveSessionIdRef.current,
      kind,
    };
    changeOwed((o) => ({ ...o, deliveries: [...o.deliveries, d] }));
    return { ...d, tab: TAB_ID } as Delivery;
  };
  const forgetDelivery = (d: Delivery) =>
    changeOwed((o) => ({ ...o, deliveries: o.deliveries.filter((x) => x.sentAt !== d.sentAt) }));
  /**
   * A STOP RELEASES specific deliveries — never "everything": this tab's own,
   * and another tab's only if it was sent before this tab last saw the stream
   * move (a newer one is that tab's business, and releasing it would put that
   * tab one reply behind again). Released as a fact every tab applies.
   */
  const lastViewAtRef = useRef(Date.now());
  useEffect(() => {
    lastViewAtRef.current = Date.now();
  }, [mergedEvents.length]);
  const releaseDeliveries = (list: readonly Delivery[]) => {
    const own = new Set(list.filter((d) => (d as PendingDelivery).tab === TAB_ID).map((d) => d.sentAt));
    const others = list.filter((d) => (d as PendingDelivery).tab !== TAB_ID).map((d) => deliveryId(d as PendingDelivery));
    changeOwed((o) => ({
      ...o,
      deliveries: o.deliveries.filter((d) => !own.has(d.sentAt)),
      released: [...o.released, ...others],
    }));
  };

  /**
   * The two failures that arrive with no error attached.
   *
   * 1. The stream settles while the transcript's last event is a turn STARTING —
   *    the turn is running server-side and nothing is listening.
   * 2. eve is retrying the turn from scratch: it replays the durable workflow,
   *    so the prologue repeats and no step ever starts. After its retries are
   *    spent the turn is dead, and — measured on a real run — NO `turn.failed`
   *    reaches the stream. The user watches an empty screen forever.
   *
   * The second is why this exists. A turn that died at 21:11 sat frozen at
   * eleven events for six minutes looking exactly like a slow one, and the only
   * way anybody found out was reading agent logs by hand.
   *
   * The discriminator is the REPEAT, not elapsed time (see lib/chat-turn-state):
   * a healthy turn here ran 63 seconds across 443 events, so any timeout would
   * eventually declare working turns dead.
   */
  const lastEventType = (mergedEvents[mergedEvents.length - 1] as { type?: string } | undefined)?.type;
  const seenEvents = mergedEvents.length;
  useEffect(() => {
    if (mergedEvents.length === 0) return;
    const storm = retryStormDetected(mergedEvents as { type?: string }[]);
    if (storm) {
      setStreamError(
        "This turn kept failing and has stopped retrying. Send it again — the agent won't recover this one.",
      );
      // A storm re-emits its prologue, so this effect re-ran on every one of
      // them and filed a record each time. One record per stormed turn.
      const stormKey = `storm:${chatKey}:${turnsStarted(mergedEvents as { type?: string }[])}`;
      if ((detachesReported.get(stormKey) ?? 0) === 0) {
        detachesReported.set(stormKey, 1);
        report("stream-gave-up", {
          sessionId: sessionIdRef.current ?? undefined,
          detail: `retry storm · ${mergedEvents.length} events · last ${lastEventType ?? "none"}`,
        });
      }
      return;
    }
    if (agent.status !== "ready") return;
    let unfinished = false;
    for (let i = mergedEvents.length - 1; i >= 0; i--) {
      const type = (mergedEvents[i] as { type?: string })?.type;
      if (
        type === "turn.completed" ||
        type === "session.completed" ||
        type === "session.waiting" ||
        type === "turn.failed" ||
        type === "turn.cancelled"
      ) {
        break;
      }
      if (type === "turn.started") {
        unfinished = true;
        break;
      }
    }
    if (!unfinished) return;
    // No amber "the reply stopped" banner any more: that state is now HELD and
    // watched (sendGate "detached" + the resync watcher below), and says so in
    // its own status line. Still counted, so it stays queryable.
    //
    // ONCE PER DETACHED TURN, not once per mount. A resync remounts this
    // component, and a replay that comes back mid-turn remounts it detached
    // again — which is how one session filed three byte-identical
    // "ended mid-turn and stopped resuming" records inside 63 seconds on
    // 2026-09-21. Counted at module scope (the map outlives the remount) so the
    // telemetry counts incidents; the tail of a cycling turn is still reported,
    // once, when the resync budget runs out, so a stuck one is visible rather
    // than silent.
    const key = `${chatKey}:${turnsStarted(mergedEvents as { type?: string }[])}`;
    const seen = (detachesSeen.get(key) ?? 0) + 1;
    detachesSeen.set(key, seen);
    const reported = detachesReported.get(key) ?? 0;
    const resyncs = resyncsSpent.get(key) ?? 0;
    if (!shouldReportDetach({ reported, resyncsSpent: resyncs, resyncBudget: RESYNC_BUDGET })) return;
    detachesReported.set(key, reported + 1);
    report("stream-gave-up", {
      sessionId: sessionIdRef.current ?? undefined,
      detail:
        resyncs >= RESYNC_BUDGET
          ? `still detached after ${resyncs} resyncs · ${seen} detaches · last event: ${lastEventType ?? "none"}`
          : `last event: ${lastEventType ?? "none"}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.status, lastEventType, seenEvents, chatKey]);

  /**
   * NOT a remount loop — see the history here before adding one back.
   *
   * The stream IS cut on a hard 120s boundary (measured at 121/241/362/482/
   * 602/723s). The wrong conclusion drawn from that was "a clean end-of-body is
   * not an error, so the store never reconnects". It does. eve's send-path
   * reader loops `for(;;)`, and a clean EOF leaves its boundary flag false, so
   * it REOPENS at the advanced index and only `maxReconnectAttempts` stops it
   * (node_modules/eve/dist/src/client/session.js, `#r`).
   *
   * Six cuts and then silence was not a missing mechanism. It was this number,
   * set to 6, doing exactly what it says: six 120-second segments, twelve
   * minutes, then give up. So the fix is the number.
   *
   * The remount-based auto-resume that briefly lived here did nothing at all:
   * the store opens a stream only from send(), never on mount
   * (eve-agent-store.js has no stream code), so remounting with a cursor
   * re-rendered the same events and re-armed itself ~900ms later, forever —
   * and its attempt counter lived in the component being remounted, so the
   * bound reset every cycle.
   */

  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  // Context-window gauge: the latest `step.completed` usage IS the current prompt
  // size (uncached input + cache-read tokens). Falls back to a compaction event's
  // reported input tokens. 0 until the first model step reports usage.
  const contextUsage = useMemo(() => {
    for (let i = mergedEvents.length - 1; i >= 0; i--) {
      const e = mergedEvents[i] as {
        type?: string;
        data?: {
          usage?: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number };
          usageInputTokens?: number;
        };
      };
      if (e.type === "step.completed" && e.data?.usage) {
        // `cacheReadTokens` = the prior conversation replayed from cache (the
        // bulk of a long thread); `inputTokens` = this turn's fresh prompt;
        // `outputTokens` = the reply just generated. Total context = cached +
        // fresh.
        const cached = e.data.usage.cacheReadTokens ?? 0;
        const fresh = e.data.usage.inputTokens ?? 0;
        return { total: cached + fresh, cached, fresh, output: e.data.usage.outputTokens ?? 0 };
      }
      /**
       * Compaction finished: the context has been replaced by a summary, so the
       * ring must stop showing the old size.
       *
       * eve's `compaction.completed` carries only modelId/sequence/sessionId/
       * turnId — no usage figure — so there is nothing to display yet. Walking
       * past it reached `compaction.requested`, whose usageInputTokens is the
       * PRE-compaction total (the reason it fired), and the ring sat pinned at
       * ~100% after an autocompact that had actually worked. Reset here and let
       * the next step.completed report the real post-compaction number.
       */
      if (e.type === "compaction.completed") {
        return { total: 0, cached: 0, fresh: 0, output: 0, compacted: true };
      }
      // Still compacting: the context genuinely IS this big until it finishes.
      if (e.type === "compaction.requested" && typeof e.data?.usageInputTokens === "number") {
        return { total: e.data.usageInputTokens, cached: 0, fresh: e.data.usageInputTokens, output: 0 };
      }
    }
    return { total: 0, cached: 0, fresh: 0, output: 0 };
  }, [mergedEvents]);

  // Click-to-compact — IN-THREAD (no fork). eve has no manual-compaction
  // trigger, so we ask the agent to write a compaction checkpoint summary in the
  // SAME session; the transcript shows a "Compacting context…" → "Context
  // manually compacted" divider around it. `compacting` drives the divider;
  // reset when the user sends their next real message.
  const compactPendingRef = useRef(false);
  const [compacting, setCompacting] = useState<"compacting" | "done" | null>(null);
  // `gate` is derived further down (it needs the open input requests); callbacks
  // declared above it read the latest verdict through this ref.
  const holdRef = useRef(false);
  const gateReasonRef = useRef<ReturnType<typeof sendGate>["reason"]>(null);
  const [remoteTurn, setRemoteTurn] = useState(false);
  /** Until when a reader lingers after a Stop — see `stopTurn`. */
  const [lingerUntil, setLingerUntil] = useState(0);
  const lingering = lingerUntil > Date.now();
  useEffect(() => {
    if (!lingerUntil) return;
    const t = setTimeout(() => setLingerUntil(0), Math.max(0, lingerUntil - Date.now()));
    return () => clearTimeout(t);
  }, [lingerUntil]);
  /**
   * A live reader is open on this transcript's stream — see the reattach block
   * below. Declared up here because the resync/replay watcher, which is written
   * above it, now stands DOWN while a reader is attached: a replay of a running
   * turn returns mid-turn by design, so spending one while the turn is being
   * read live would remount the chat and throw away the reader for nothing.
   */
  const [attachLive, setAttachLive] = useState(false);
  /** Bumped when a reader gives up, to arm the next attempt within the budget. */
  const [attachEpoch, setAttachEpoch] = useState(0);
  /** Forgive the reader's spent budget once an answer is accepted — see `freshAttachAfterAnswer`. */
  const freshAttachRef = useRef<() => void>(() => {});
  /**
   * The reader stopped on a 401: this browser's sign-in expired under the turn.
   *
   * Its own state, not a failure count, because it needs its own WORDS. The
   * session token lasts about an hour and auth-gate drops it 60 seconds before
   * `exp`, so a long turn crossing that boundary is ordinary — and every path
   * that could show the rest of the reply (the reader, the poll, the replay) is
   * equally locked out. Telling the person "Still working…" hides the single
   * action that recovers it.
   */
  const [authExpired, setAuthExpired] = useState(false);
  /**
   * The transcript IS streaming, whoever is reading it.
   *
   * `agent.status` only ever says `streaming` while the STORE is reading, so a
   * turn recovered by the live reader would arrive with no caret and no "this is
   * being written right now" — the reply would appear to jump, which reads as
   * another glitch rather than as the fix.
   */
  const liveStreaming = agent.status === "streaming" || attachLive;
  const handleCompact = useCallback(() => {
    if (isBusy || holdRef.current) return;
    compactPendingRef.current = true;
    setCompacting("compacting");
    void agent.send({ message: COMPACT_INSTRUCTION });
  }, [isBusy, agent]);
  useEffect(() => {
    if (agent.status !== "ready" || !compactPendingRef.current) return;
    compactPendingRef.current = false;
    setCompacting("done");
  }, [agent.status]);

  // Auto-compaction checkpoints: eve emits `compaction.completed` (with a turnId)
  // whenever it compacts on its own. Map those turn ids so the transcript can
  // render a divider at the start of each compacted turn.
  const autoCompactedTurns = useMemo(() => {
    const turns = new Set<string>();
    for (const e of mergedEvents) {
      const ev = e as { type?: string; data?: { turnId?: string } };
      if (ev.type === "compaction.completed" && ev.data?.turnId) turns.add(ev.data.turnId);
    }
    return turns;
  }, [mergedEvents]);

  // Goal/Loop completion: the harness emits `result.completed` with the
  // structured `final_output` payload once the model records an outcome. Capture
  // the latest one onto the active goal run so the UI can show complete/blocked.
  useEffect(() => {
    for (let i = mergedEvents.length - 1; i >= 0; i--) {
      const e = mergedEvents[i] as { type?: string; data?: { result?: unknown } };
      if (e.type !== "result.completed") continue;
      const outcome = asGoalOutcome(e.data?.result);
      if (outcome) {
        setGoalRun((prev) => (prev && !prev.outcome ? { ...prev, outcome } : prev));
      }
      break;
    }
  }, [mergedEvents]);

  // Deliver input responses (approvals, question answers). The store's send()
  // throws "already processing a turn" whenever the parent stream is open —
  // which is exactly when proxied subagent approvals arrive — so when busy we
  // POST the response directly with the parked turn's continuation token; the
  // resumed events flow down the stream that is already attached. The token
  // comes from the session cursor, else the last session.waiting event.
  // Requests answered this mount — the direct-POST path never writes an
  // inputResponse back onto the part, so without this the hoisted card keeps
  // its Yes/No and a second click sends an already-consumed token (a 500
  // "Channel handler failed" banner).
  const [respondedRequestIds, setRespondedRequestIds] = useState<ReadonlySet<string>>(new Set());
  // Requests the operator explicitly WAVED AWAY: a question or approval the
  // agent asked but that the run has moved past (it parked on the tail and the
  // operator doesn't want to answer it). These aren't "answered" — no response
  // exists — so they drop from the hoisted tail purely on the operator's say-so.
  // Persisted (requestIds are unique) so a dismissed card never re-hoists on
  // reopen, which is exactly the "these are STILL here" complaint.
  const [dismissedRequestIds, setDismissedRequestIds] =
    useState<ReadonlySet<string>>(readDismissed);
  const dismissInput = (requestId: string) => {
    setDismissedRequestIds((prev) => {
      // `withRequestIds` returns `prev` unchanged when the id is already there:
      // a second click is then one render instead of a new Set that re-projects
      // every memo keyed on this state (see lib/chat-turn-state).
      const next = withRequestIds(prev, [requestId]);
      if (next !== prev) persistDismissed(next);
      return next;
    });
  };
  // Requests whose run has DIED: the ONE unrecoverable failure is a crashed
  // child whose continuation token is spent, which the server rejects with a
  // 500 "Cannot deliver inputResponses". Only that signal expires a card — its
  // hoisted Yes/No drops because answering could only fail. Every OTHER failure
  // (a transient 401/429/5xx, a momentary store error) leaves the approval
  // answerable: the re-park resurfaces it, so we must NOT expire on those. We
  // never mark an expired request answered (no inputResponse exists).
  const [expiredLocal, setExpiredRequestIds] = useState<ReadonlySet<string>>(new Set());
  const markExpired = (requestIds: readonly string[]) =>
    setExpiredRequestIds((prev) => withRequestIds(prev, requestIds));
  /**
   * WHAT A STOP RETIRED: questions it ended and specialists whose work it
   * discarded. Kept as a `client.turn.stopped` marker in the transcript (see
   * `stoppedMarker`), so it is persisted with the chat and a reload agrees —
   * the question does not come back as live, and the tile does not go back to
   * "Running".
   */
  // Whose Stop state this is: the person and workspace as well as the chat (./chat-stop-state).
  const stopStateKey = stopKey(storageScope, chatKey);
  const [stoppedMarkers, setStoppedMarkers] = useState<TurnEvent[]>(() => stopMarkersFor(stopStateKey));
  useEffect(() => {
    const sync = () => setStoppedMarkers(stopMarkersFor(stopStateKey));
    const off = onStopMarker(stopStateKey, sync);
    sync();
    return off;
  }, [stopStateKey]);
  const stopped = useMemo(
    () => stoppedFromEvents([...(mergedEvents as readonly TurnEvent[]), ...stoppedMarkers]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedEvents.length, stoppedMarkers],
  );
  /** Retired either way: the run is gone (expired) or a Stop ended it. */
  const expiredRequestIds = useMemo(
    () => withRequestIds(expiredLocal, stopped.requestIds),
    [expiredLocal, stopped.requestIds],
  );
  // The spent-token signal: keying expiry on this specific message (not any
  // non-2xx / any thrown error) is what keeps a live, re-parking run's approval
  // answerable through a transient blip.
  const DEAD_TOKEN_SIGNAL = "Cannot deliver inputResponses";
  // Request ids of the most recent answer attempt, so a store error on the very
  // next render can be attributed back to them (case (c)). Cleared on success.
  const pendingAnswerRef = useRef<readonly string[]>([]);
  // The freshest resume token: the store's `session` cursor lags a turn that
  // parked on user input, but the latest `session.waiting` EVENT carries the
  // live token. Prefer that, fall back to the cursor.
  const freshestToken = (): string | undefined => {
    for (let i = mergedEvents.length - 1; i >= 0; i--) {
      const e = mergedEvents[i] as { type?: string; data?: { continuationToken?: string } };
      if (e.type === "session.waiting" && typeof e.data?.continuationToken === "string" && e.data.continuationToken) {
        return e.data.continuationToken;
      }
    }
    return agent.session?.continuationToken;
  };
  // Recover the freshest resume token from the SERVER when none is in memory:
  // a turn that was streaming when the connection dropped (a window switch mid
  // generation) never parked locally, so no `session.waiting` event — and thus
  // no token — is in `mergedEvents`. The turn keeps running server-side and
  // parks there; replaying its stream surfaces the latest `session.waiting`
  // token so a send can still resume it. Bounded so it never hangs the send.
  const serverFreshestToken = async (sessionId: string): Promise<string | undefined> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    let token: string | undefined;
    try {
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
        headers: getAuthHeaders(),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return undefined;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawBoundary = false;
      for (;;) {
        const read = reader.read();
        // Once the live turn parks, stop on the quiet that follows the boundary
        // (a boundary trailed by more events is a prior turn in the replay).
        const r = sawBoundary
          ? await Promise.race([
              read.catch(() => ({ done: true as const, value: undefined })),
              new Promise<{ done: true; value: undefined }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined }), 700),
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
            const ev = JSON.parse(l) as { type?: string; data?: { continuationToken?: string } };
            if (ev.type === "session.waiting" && typeof ev.data?.continuationToken === "string" && ev.data.continuationToken) {
              token = ev.data.continuationToken;
            }
            if (ev.type === "session.waiting" || ev.type === "session.completed" || ev.type === "session.failed") {
              sawBoundary = true;
            }
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch {
      /* return whatever token we saw */
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    return token;
  };
  // Deliver a turn straight to the resume endpoint with the freshest token —
  // the recovery path when the store would continue with an empty token and
  // eve rejects it ("Missing or empty 'continuationToken'"). Returns ok.
  const directDeliver = async (payload: {
    message?: UserContent;
    inputResponses?: readonly { requestId: string; optionId?: string; text?: string }[];
    outputSchema?: object;
  }): Promise<boolean> => {
    // `liveSessionIdRef` as the fallback: after a detached turn the store's
    // cursor has been reset (session id included) by `advanceSession`, so
    // `agent.session.sessionId` is undefined for exactly the sessions this path
    // exists to resume — including one the live tail has just carried to its
    // park, whose fresh token `freshestToken()` now reads straight off the tail
    // instead of paying `serverFreshestToken`'s whole replay for it.
    const sessionId = agent.session?.sessionId ?? liveSessionIdRef.current;
    if (!sessionId) return false;
    // In-memory token first; if the turn dropped mid-stream there is none, so
    // recover it from the server before giving up.
    const token = freshestToken() ?? (await serverFreshestToken(sessionId));
    if (!token) return false;
    try {
      const res = await fetch(`/eve/v1/session/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ ...payload, continuationToken: token }),
      });
      // Delivered AROUND the store: the turn now runs with no local stream on
      // it. Until a resync shows how it ended, the session is not idle.
      if (res.ok) setRemoteTurn(true);
      // A message eve may hold behind whatever is running — see `deliveries`.
      if (res.ok && payload.message !== undefined) recordDelivery(deliveryText(payload.message));
      else if (res.ok && (payload.inputResponses?.length ?? 0) > 0) recordDelivery("", "answer");
      return res.ok;
    } catch {
      return false;
    }
  };
  const isMissingTokenError = (msg: string) =>
    /continuationToken/i.test(msg) && !msg.includes(DEAD_TOKEN_SIGNAL);
  /**
   * Approvals and questions whose RUN IS GONE — read from the stream, so the
   * verdict survives a reload (see `deadInputRequestIds`).
   *
   * The three sets beside it (responded / dismissed / expired) are in-memory:
   * after a reopen they are empty, and a part left non-terminal by a turn that
   * died was hoisted as a live approval and held the composer on
   * `awaiting-input` forever — "permission decisions resurface and block
   * streaming for chats that are already completed". A LIVE park still behaves
   * exactly as before; only a request the stream shows to be unanswerable drops
   * out of the gate, and it stays on screen as the muted expired note.
   *
   * Keyed on the event COUNT: the stream only ever appends, and the verdict is a
   * fold over it. `deadInputRequestIds` returns one shared empty set when there
   * is nothing dead, so an ordinary transcript keeps the same reference on every
   * projection and the memos below it do not churn.
   */
  const deadRequests = useMemo(
    () => deadInputRequestIds(mergedEvents as { type?: string }[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedEvents.length],
  );
  /**
   * The dismissals that may COUNT: a live specialist's question is not one of
   * them (see `effectiveDismissals`). Dismissing it opened the send gate onto a
   * session that buffers every message behind that delegation, which is how
   * messages stacked up unanswered with nothing able to remove them.
   */
  const proxiedRequestIds = useMemo(
    () => proxiedChildRequestIds(mergedEvents as readonly TurnEvent[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedEvents.length],
  );
  const countedDismissals = useMemo(
    () => effectiveDismissals(dismissedRequestIds, mergedEvents as readonly TurnEvent[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dismissedRequestIds, mergedEvents.length],
  );
  /**
   * Every input request this turn is waiting on, answered-by-us or not.
   *
   * Deliberately does NOT exclude locally answered ones: the batch size is what
   * decides when it is safe to deliver, so removing answers as they arrive would
   * make the last one look like the only one.
   */
  const openRequestIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of viewMessages) {
      for (const p of (m as { parts?: readonly unknown[] }).parts ?? []) {
        const part = p as {
          state?: string;
          toolMetadata?: { eve?: { inputRequest?: { requestId?: string }; inputResponse?: unknown } };
        };
        const eve = part.toolMetadata?.eve;
        const rid = eve?.inputRequest?.requestId;
        if (!rid || eve?.inputResponse) continue;
        if (countedDismissals.has(rid) || expiredRequestIds.has(rid)) continue;
        // A dead request can never be answered, so it must not count as a
        // SIBLING either: the batch waits for every open request to have an
        // answer before delivering, and one stale id in the batch swallowed a
        // real answer to a live question and delivered nothing at all.
        if (deadRequests.has(rid)) continue;
        if (!ids.includes(rid)) ids.push(rid);
      }
    }
    return ids;
  }, [viewMessages, countedDismissals, expiredRequestIds, deadRequests]);
  const openRequestsRef = useRef<string[]>([]);
  openRequestsRef.current = openRequestIds;

  /**
   * Answers waiting for their siblings.
   *
   * When the agent asks several questions at once, answering ONE used to be
   * delivered immediately — which resumes the turn. The second answer then went
   * into a session that was already streaming, and its reply interleaved with
   * the first one's. eve takes an ARRAY of inputResponses precisely so a set of
   * questions is answered as a set; the old code sent them one at a time and
   * relied on each re-park minting a fresh token mid-stream, which is what
   * produced the interleaving.
   *
   * So: hold each answer until every open request has one, then deliver them
   * together in a single call.
   */
  const bufferedAnswers = useRef(
    new Map<string, { requestId: string; optionId?: string; text?: string }>(),
  );
  /** How many of the current batch are still unanswered (for the UI). */
  const [awaitingSiblings, setAwaitingSiblings] = useState(0);
  /**
   * An attachment is being stored before the turn starts.
   *
   * Sending now AWAITS the upload — the data-room path has to be true before the
   * agent is told to read it. A 630KB workbook takes ~1.7s, and during that the
   * composer has already cleared and no message has appeared yet, so the app
   * looks frozen. Reported as "the thread is hanging", and it was: silent, not
   * stuck.
   */
  const [uploading, setUploading] = useState(0);

  /**
   * AN ANSWER THE SERVER REFUSED IS NOT AN ANSWER. It used to stay recorded as
   * owed — the composer then held on "waiting its turn" for an answer that
   * would never arrive — with the card already marked answered. Now the
   * delivery record goes, the question comes back, and the person is told in
   * plain words. (A spent token still expires the card: see DEAD_TOKEN_SIGNAL.)
   */
  /** A 5xx/lost answer is being checked against the stream (see respondToInput). */
  const [answerChecking, setAnswerChecking] = useState(false);
  const [answerError, setAnswerError] = useState<{
    readonly message: string;
    readonly responses: readonly { requestId: string; optionId?: string; text?: string }[];
    readonly label: string;
  } | null>(null);
  const answerRejected = (
    requestIds: readonly string[],
    responses: readonly { requestId: string; optionId?: string; text?: string }[],
    why: "refused" | "unreachable" | "not-sent",
  ) => {
    setRejectedRequestIds((prev) => withRequestIds(prev, requestIds));
    setRespondedRequestIds((prev) => withoutRequestIds(prev, requestIds));
    setAnsweredResponses((prev) => {
      const next = { ...prev };
      for (const id of requestIds) delete next[id];
      return next;
    });
    setStreamError(null);
    // What they answered, in their words — for the one-click retry.
    const label = responses
      .map((r) => {
        if (r.text) return r.text;
        const req = openInputRequests.find((q) => q.requestId === r.requestId) as
          | { options?: readonly { id?: string; label?: string }[] }
          | undefined;
        return req?.options?.find((o) => o.id === r.optionId)?.label ?? r.optionId ?? "";
      })
      .filter(Boolean)
      .join(", ");
    setAnswerError({
      message:
        why === "refused"
          ? "Your answer didn't go through — the server refused it. The question is still open above."
          : why === "not-sent"
            ? "Your answer wasn't sent — this page lost its connection to the conversation. Reload the page, then answer the question again."
            : "Your answer didn't reach the server. The question is still open above.",
      responses,
      label,
    });
  };
  const respondToInput = async (
    inputResponses: readonly { requestId: string; optionId?: string; text?: string }[],
  ) => {
    // A view-only member of a shared thread can never answer approvals/questions
    // — the owner/participants hold the turn.
    if (readOnly) return;
    setAnswerError(null);
    setRejectedRequestIds((prev) => withoutRequestIds(prev, inputResponses.map((r) => r.requestId)));
    setRespondedRequestIds((prev) => withRequestIds(prev, inputResponses.map((r) => r.requestId)));
    // Record the real responses so they persist as answered regardless of which
    // delivery path (store send vs directDeliver) actually carried them.
    setAnsweredResponses((prev) => {
      const next = { ...prev };
      for (const r of inputResponses) next[r.requestId] = r;
      return next;
    });
    for (const r of inputResponses) bufferedAnswers.current.set(r.requestId, r);
    const unanswered = openRequestsRef.current.filter((id) => !bufferedAnswers.current.has(id));
    if (unanswered.length > 0) {
      // Held, not sent. Delivering now would resume the turn and the remaining
      // answers would land in the middle of its reply.
      setAwaitingSiblings(unanswered.length);
      return;
    }
    setAwaitingSiblings(0);
    const batch = [...bufferedAnswers.current.values()];
    bufferedAnswers.current.clear();
    inputResponses = batch;
    const requestIds = inputResponses.map((r) => r.requestId);
    pendingAnswerRef.current = requestIds;
    /**
     * A SHARED thread answers through the relay, exactly as its messages do.
     *
     * Both paths below reach for a continuation token, and on a shared thread
     * there is no longer one to reach for: the token is stripped as the stream
     * passes the membership-checked proxy, because handing every viewer the live
     * resume token let a read-only member send into the thread. Without this
     * branch a participant's Yes/No would fall through to
     * `if (!sessionId || !continuationToken) return;` inside directDeliver and be
     * dropped in silence, leaving an answered card that answered nothing.
     *
     * The relay is also the only correct writer here for the same reason it is
     * for messages: it holds the single-writer claim on that token, so two people
     * answering at once serialise instead of spending it twice.
     */
    if (relayThreadId) {
      setRelayPending(requestIds.join(","));
      setRelayError(null);
      try {
        await opsFetch(`/api/ops/threads/${relayThreadId}/messages`, {
          method: "POST",
          body: JSON.stringify({ inputResponses }),
        });
        pendingAnswerRef.current = [];
        onRelaySent?.();
      } catch (e) {
        // The card stays answerable: an answer that did not reach the relay is
        // not an answer, and silently keeping it "responded" is the failure this
        // whole branch exists to prevent.
        setRespondedRequestIds((prev) => withoutRequestIds(prev, requestIds));
        setRelayError(e instanceof Error ? e.message : String(e));
      } finally {
        setRelayPending(null);
      }
      return;
    }
    /**
     * THE ANSWER IS POSTED BY THE APP, and judged by THAT POST's status alone.
     *
     * It used to go through the store's `send()`, which POSTs and then reads the
     * stream, and swallows an error from either: a stream read that failed
     * after eve had ACCEPTED the answer (a 401 a moment later) was taken for a
     * refusal, and the consumed question came back as live (review,
     * `consumed`). Now: accepted → the answer is owed, and the live reader
     * (`attachDecision` "buffered") reads the reply it resumes — a later stream
     * failure is a connection problem, handled as one; 4xx → refused, and the
     * question comes back; a spent token → the run is gone, the card expires.
     */
    const storeReading = agent.status === "submitted" || agent.status === "streaming";
    const answeredAt = absoluteIndex(mergedEvents as readonly TurnEvent[]);
    let outcome = await postAnswer(inputResponses);
    pendingAnswerRef.current = [];
    /**
     * A 5xx or a lost response is NOT a refusal: the answer may well have
     * landed (the response went missing, not the request). Restoring the
     * question at once invited a second answer on a spent token, which then
     * expired the card while the reply was running.
     *
     * So it is treated as delivered — the reader stays on the stream and the
     * card stays answered — while the stream is watched for up to a minute (a
     * specialist resumed by the answer can take a while before the parent
     * stream says anything). Only if nothing arrives is the question restored.
     */
    /**
     * NOTHING WAS SENT — no session, or no resume token to send it with. There is
     * no answer in flight to wait for, so the question comes back at once with a
     * plain reason (it used to sit a full minute on "Checking whether your answer
     * reached the server…" first: review of #59).
     */
    if (outcome.notSent) {
      answerRejected(requestIds, inputResponses, "not-sent");
      return;
    }
    if (answerNeedsCheck(outcome)) {
      const sessionId = agent.session?.sessionId ?? liveSessionIdRef.current;
      if (sessionId) {
        const provisional = recordDelivery("", "answer");
        if (!storeReading) setRemoteTurn(true);
        setAnswerChecking(true);
        const landed = await streamHasMoved(
          eveSessionStream({ sessionId, headers: getAuthHeaders }),
          answeredAt,
          ANSWER_VERIFY_MS,
        );
        setAnswerChecking(false);
        if (landed) {
          freshAttachRef.current();
          return;
        }
        forgetDelivery(provisional);
        setRemoteTurn(false);
      }
    }
    if (outcome.ok) {
      recordDelivery("", "answer");
      // Delivered around an idle store: nothing local is reading yet, so the
      // session is not at rest until the reader has read what it resumes. (A
      // store already reading gets the resumed events on its open stream.)
      if (!storeReading) {
        setRemoteTurn(true);
        freshAttachRef.current();
      }
      return;
    }
    if (outcome.body.includes(DEAD_TOKEN_SIGNAL)) {
      markExpired(requestIds);
      return;
    }
    answerRejected(requestIds, inputResponses, outcome.status >= 400 && outcome.status < 500 ? "refused" : "unreachable");
  };
  /** POST an answer to the parked session with the freshest resume token. Never throws. */
  const postAnswer = async (
    inputResponses: readonly { requestId: string; optionId?: string; text?: string }[],
  ): Promise<AnswerPostOutcome> => {
    const sessionId = agent.session?.sessionId ?? liveSessionIdRef.current;
    // NOTHING WAS POSTED in these two: say so (`notSent`), so the caller never
    // waits a minute for the stream to show an answer that was never sent.
    if (!sessionId) return { ok: false, status: 0, body: "no session", notSent: "no-session" };
    const continuationToken = freshestToken() ?? agent.session?.continuationToken ?? (await serverFreshestToken(sessionId));
    if (!continuationToken) return { ok: false, status: 0, body: "no resume token", notSent: "no-token" };
    /**
     * Retried like eve's own client (`postTurnWithRetry`): answering just as the
     * question parks can meet a 500 "target session was not found" — the park
     * is not visible yet — and a moment later the same POST succeeds.
     */
    let last: { ok: boolean; status: number; body: string } = { ok: false, status: 0, body: "network" };
    for (let attempt = 0; attempt < ANSWER_RETRIES; attempt++) {
      try {
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ inputResponses, continuationToken }),
        });
        last = { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text().catch(() => "") };
      } catch {
        return { ok: false, status: 0, body: "network" };
      }
      if (!answerPostRetryable(last.status, last.body)) return last;
      await new Promise((r) => setTimeout(r, Math.min(200 * (attempt + 1), 1_000)));
    }
    return last;
  };
  // Case (c): the store surfaces the spent-token error on the render right after
  // an answer attempt — that answer's approvals belong to a run that has
  // stopped, so expire them and clear the ref. We gate on the dead-token signal:
  // a broad store error for any OTHER reason must not strip a live approval.
  useEffect(() => {
    if (
      agent.error &&
      pendingAnswerRef.current.length > 0 &&
      (agent.error.message ?? "").includes(DEAD_TOKEN_SIGNAL)
    ) {
      markExpired(pendingAnswerRef.current);
      pendingAnswerRef.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.error]);
  const isEmpty = viewMessages.length === 0;

  // Child sessions of delegated subagents, keyed by tool-call id. The message
  // parts carry the delegation itself but not the child's session id — only the
  // `subagent.called` EVENT does. Derive it from the full event log (the same
  // log persistence stores), so RESTORED chats keep their child sessions too:
  // the child stream replays history on attach, meaning a reloaded run shows
  // its full step data instead of falling back to a summary blob.
  const eventCount = mergedEvents.length;
  // Kept current as the transcript grows so `onError` — which cannot see `agent`
  // at all (it is declared inside the store's own config) — has something to say.
  useEffect(() => {
    sceneRef.current = renderLoopScene(
      viewMessages as readonly { parts?: readonly unknown[] }[],
      mergedEvents as { type?: string }[],
      typeof window === "undefined" ? undefined : { width: window.innerWidth, height: window.innerHeight },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventCount]);
  const childSessions = useMemo(() => {
    const map: Record<string, string> = {};
    for (const raw of mergedEvents) {
      const e = raw as { type?: string; data?: Record<string, unknown> };
      if (e.type !== "subagent.called" || !e.data) continue;
      const callId = e.data.callId;
      const child = e.data.childSessionId;
      if (typeof callId === "string" && typeof child === "string") map[callId] = child;
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventCount]);

  // Call ids the PARENT actually declared: every tool call the main agent makes
  // is streamed as an `actions.requested` first (stream-actions.js). A
  // subagent's approval, by contrast, is proxied onto this same parent stream
  // as a bare `input.requested` with the CHILD's turn id and NO matching
  // actions.requested (execution/subagent-hitl-proxy.js). So an approval whose
  // call id never appears here is proxied from a child — it belongs in that
  // subagent's rail, not mid-thread where the stale turn id misplaces it.
  const ownActionCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const raw of mergedEvents) {
      const e = raw as { type?: string; data?: { actions?: Array<{ callId?: unknown }> } };
      if (e.type !== "actions.requested") continue;
      for (const a of e.data?.actions ?? []) {
        if (typeof a.callId === "string") ids.add(a.callId);
      }
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventCount]);
  const hasSubagent = Object.keys(childSessions).length > 0;
  // A tool part is a subagent-proxied approval (never the main agent's own)
  // when a subagent exists, it isn't the delegation card itself, and its call
  // id was never declared by the parent. Guarding on hasSubagent keeps the
  // suppression dormant in plain conversations.
  const isProxiedChildApproval = (part: {
    type?: string;
    toolName?: string;
    toolCallId?: string;
  }) =>
    hasSubagent &&
    part.type === "dynamic-tool" &&
    !part.toolName?.startsWith("eve:subagent:") &&
    typeof part.toolCallId === "string" &&
    !ownActionCallIds.has(part.toolCallId);

  // The tail of the transcript, and whether it is parked on the user (approval /
  // question / authorization). Read by the "Working…" strip, the plan hand-off
  // and the composer — all of which live below the send gate, because "is the
  // answer over" is a question about the TURN and the gate is what answers it.
  const lastMessage = viewMessages[viewMessages.length - 1];
  const lastParts = (lastMessage?.parts ?? []) as Array<{
    type?: string;
    state?: string;
    toolMetadata?: { eve?: { inputRequest?: { requestId?: string }; inputResponse?: unknown } };
  }>;
  const awaitingUser = lastParts.some((p) => {
    // A request the stream has already ended is not something the reader is
    // being waited on for — otherwise the "Working…" strip stays hidden behind a
    // prompt nobody can answer.
    const rid = p.toolMetadata?.eve?.inputRequest?.requestId;
    if (rid && deadRequests.has(rid)) return false;
    return (
      p.state === "approval-requested" ||
      p.state === "required" ||
      (Boolean(p.toolMetadata?.eve?.inputRequest) && !p.toolMetadata?.eve?.inputResponse)
    );
  });

  // Pending approvals/questions hoisted to the conversation tail: eve's
  // proxied child approvals carry stale turn ids, so the reducer attaches them
  // to an EARLIER assistant message — in place they render above newer
  // messages. Collected here and rendered after the last message instead.
  //
  // A DELEGATED CHILD'S REQUEST BELONGS HERE TOO, and used not to: the old
  // `if (isProxiedChildApproval(part)) continue` sent it to the rail instead,
  // which is why a declared specialist's output never reached this chat. See
  // `pendingInputRequestParts` in lib/chat-turn-state for the measurement and
  // the three things that one `continue` broke.
  const pendingInputParts = useMemo(
    () =>
      pendingInputRequestParts({
        messages: viewMessages as readonly { parts?: readonly unknown[] }[],
        dismissed: countedDismissals,
        responded: respondedRequestIds,
        expired: expiredRequestIds,
      }) as Array<React.ComponentProps<typeof PendingApprovalCard>["part"]>,
    [viewMessages, respondedRequestIds, expiredRequestIds, countedDismissals],
  );

  /**
   * THE SEND GATE — see lib/chat-turn-state `sendGate` for the why.
   *
   * `isBusy` alone let a message out whenever the STORE was idle, which is not
   * the same as the SESSION being idle: a detached turn (Stop, dropped stream,
   * reopened mid-turn) and a turn parked on an approval both leave the store
   * `ready` with a turn that will write again. Anything delivered then sits
   * below text that keeps arriving above it.
   */
  const openInputRequests = useMemo(() => {
    // The part keeps the request minus its `action`, which the resolver never reads.
    type OpenRequest = Parameters<typeof resolveTextToResponses>[1][number];
    const out: OpenRequest[] = [];
    for (const p of pendingInputParts) {
      const req = (p as { toolMetadata?: { eve?: { inputRequest?: OpenRequest } } }).toolMetadata?.eve
        ?.inputRequest;
      // An expired card stays on screen as a note, but its run is gone. Same for
      // one the STREAM says is gone: it renders, it never holds the composer.
      if (req?.requestId && !expiredRequestIds.has(req.requestId) && !deadRequests.has(req.requestId)) {
        out.push(req);
      }
    }
    return out;
  }, [pendingInputParts, expiredRequestIds, deadRequests]);
  const startedTurns = useMemo(
    () => turnsStarted(mergedEvents as { type?: string }[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventCount],
  );
  // Set when the cancel route answers `no_active_turn` for a turn with no
  // terminal event: it is not running and never will finish. Keyed by the turn
  // ordinal (module scope) so the verdict survives the resync remount.
  const [abandonedTurn, setAbandonedTurn] = useState<number | null>(
    () => abandonedTurns.get(chatKey) ?? null,
  );
  const gate = useMemo(
    () =>
      sendGate({
        storeBusy: isBusy,
        events: mergedEvents as { type?: string }[],
        pendingInputs: openInputRequests.length,
        abandoned: abandonedTurn !== null && abandonedTurn === startedTurns,
        remoteTurn,
        outstanding: outstanding.length,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isBusy, eventCount, openInputRequests.length, abandonedTurn, startedTurns, remoteTurn, outstanding.length],
  );
  holdRef.current = gate.hold;
  gateReasonRef.current = gate.reason;
  /**
   * The specialists the main thread is waiting on while nothing is asked of the
   * person — see `awaitingSpecialists`. Read by the live reader at every seam
   * (a quiet stream is then expected, not failed) and said in the status line.
   */
  const workingSpecialists = useMemo(
    () =>
      awaitingSpecialists({ events: mergedEvents as readonly TurnEvent[], openRequests: openInputRequests.length }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventCount, openInputRequests.length],
  );
  const specialistQuietRef = useRef(false);
  specialistQuietRef.current = workingSpecialists.length > 0;
  const detached = gate.reason === "detached";
  /**
   * IS THE ANSWER OVER — for the transcript, not for the composer.
   *
   * Same verdict, same input, one function (`turnFinished` = `!sendGate().hold`,
   * see lib/chat-turn-state for the measurement). This used to be `isBusy`,
   * which is the STORE's status, so every detached stretch of a turn — a
   * reopened thread, a resync remount, a severed segment, a turn POSTed around
   * the store — read as "finished" and put the copy/vote/retry row under a half
   * written reply while the composer, one gate away, was holding the next
   * message on "Still working".
   */
  const answerOver = turnFinished({
    storeBusy: isBusy,
    events: mergedEvents as { type?: string }[],
    pendingInputs: openInputRequests.length,
    abandoned: abandonedTurn !== null && abandonedTurn === startedTurns,
    remoteTurn,
  });
  /**
   * "Working…": the turn is running and nothing on screen is visibly moving.
   *
   * Both halves were wrong. `isBusy` hid the strip for the whole detached half
   * of a turn, and `lastParts[…].type === "text"` treated a CLOSED paragraph as
   * a live one — eve marks the text part `done` at the step boundary before a
   * tool runs, and the relay does not flush the tool part until the next one, so
   * the tail is a finished paragraph for exactly the gap this strip exists to
   * fill. `tailStillWriting` asks for `state === "streaming"` instead.
   */
  const showWorking = !answerOver && !awaitingUser && !tailStillWriting(lastParts);
  // A delegation that has not reached a terminal state: "a specialist is running".
  const specialistRunning = useMemo(
    () =>
      viewMessages.some((m) =>
        (m.parts ?? []).some((p) => {
          const part = p as { type?: string; state?: string; toolName?: string };
          return (
            part.type === "dynamic-tool" &&
            Boolean(part.toolName?.startsWith("eve:subagent:")) &&
            part.state !== "output-available" &&
            part.state !== "output-error" &&
            part.state !== "output-denied"
          );
        }),
      ),
    [viewMessages],
  );

  const insights = useMemo(() => {
    const base = deriveInsights(viewMessages);
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        childSessionId: s.childSessionId ?? childSessions[s.callId],
      })),
    };
  }, [viewMessages, childSessions]);

  // Which customer(s) the chat is ACTUALLY about, inferred from its content —
  // only when nothing was manually selected (a manual pick always wins). The
  // header chip is otherwise a pre-conversation input and stays blank on an
  // inferred chat. We match known customer ids as whole tokens against the
  // first user message's `(Context: …)` directive, every tool-call input (the
  // `customer_id` args and the delegation brief that carries `customer id X`),
  // and message text — id tokens keep their hyphens, so there are no partial
  // false positives.
  const inferredCustomers = useMemo(() => {
    if (selectedCustomers.length > 0) return [] as string[];
    const byId = new Map(customers.map((c) => [c.id.toLowerCase(), c.id]));
    if (byId.size === 0) return [] as string[];
    const found = new Set<string>();
    const scan = (text: string) => {
      for (const tok of text.toLowerCase().split(/[^a-z0-9-]+/)) {
        const id = tok && byId.get(tok);
        if (id) found.add(id);
      }
    };
    for (const m of viewMessages) {
      for (const p of m.parts ?? []) {
        const part = p as { type?: string; text?: string; input?: unknown };
        if (part.type === "text" && part.text) scan(part.text);
        else if (part.type === "dynamic-tool" && part.input !== undefined) {
          scan(JSON.stringify(part.input));
        }
      }
    }
    return [...found];
  }, [selectedCustomers, customers, viewMessages]);

  // Self-contained attachments (bulletproof: our own input + data-URL state).
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cockpitOpen, setCockpitOpen] = useState(true);
  // The rail doubles in width while a detail view (subagent / workflow run) is
  // open — reading step feeds in a 20rem column was cramped.
  const [cockpitWide, setCockpitWide] = useState(false);
  // A delegation tool card's "View in Control Panel" hands its toolCallId here;
  // the Cockpit consumes it (selects that run's detail view) and clears it via
  // onFocusConsumed once the run exists in insights.subagents.
  const [focusSubagent, setFocusSubagent] = useState<string | null>(null);
  // Four INDEPENDENT per-turn toggles: web search, browser use (orthogonal web
  // capabilities), plan mode, and goal mode (its secondary).
  const [webSearch, setWebSearch] = useState(true);
  const [browserUse, setBrowserUse] = useState(false);
  // The agent's operating MODE (one of four): Build (act normally), Plan (plan
  // only), Goal (drive to the objective), Loop (iterate until done). Goal/Loop
  // run IN THE HARNESS: the send carries an `outputSchema` completion gate, so
  // eve keeps the model working until it records an outcome (`final_output`).
  const [mode, setMode] = useState<AgentMode>("build");
  // The active goal/loop run for this thread (UI mirror; the real state is the
  // session's outputSchema). `outcome` fills in from a `result.completed` event.
  const [goalRun, setGoalRun] = useState<{
    kind: "goal" | "loop";
    objective: string;
    outcome: GoalOutcome | null;
  } | null>(null);
  // A goal's completion gate (session outputSchema) only clears when the model
  // calls `final_output`. So "Stop" can't just cancel — it asks the model to
  // record the current state as the outcome. When a stop is requested mid-turn,
  // this flag defers the wrap-up message until the in-flight turn halts.
  const [goalStopping, setGoalStopping] = useState(false);
  /** The settings a message is sent under — captured when it is queued. */
  const currentSettings = (): QueueSettings => ({
    mode,
    webSearch,
    browserUse,
    customers: [...selectedCustomers],
  });
  /** Queue a message under the settings on screen now (the queue itself is set up below, with the composer). */
  const enqueue = (text: string, files: AttachedFile[]) => {
    void enqueueRef.current(text, files, currentSettings());
  };
  const enqueueRef = useRef<(text: string, files: AttachedFile[], s: QueueSettings) => Promise<void>>(async () => {});
  // Relay send state for a shared thread this participant contributes to: the
  // optimistic message shown while the server relay runs, and any error.
  const [relayPending, setRelayPending] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  // Presence for a shared thread: who else is online/typing, and who (if anyone)
  // currently holds the in-flight turn. Polled heartbeats (Vercel has no WS).
  const presence = usePresence(sharedThreadId, Boolean(relayPending));
  // Subagents that finished but whose result never reached the parent (reported
  // by the Cockpit). A grace period avoids flashing during a NORMAL, fast
  // handoff — only a genuinely stuck one persists past it.
  const [stuckHandoffs, setStuckHandoffs] = useState<
    readonly { callId: string; name: string; result: string }[]
  >([]);
  const [handledHandoffs, setHandledHandoffs] = useState<ReadonlySet<string>>(new Set());
  // Specialists that finished while a sibling of the same step still works: held by design, never "stuck".
  const [heldHandoffs, setHeldHandoffs] = useState<readonly { callId: string; name: string }[]>([]);
  // An office-artifact link the user clicked — shown in the in-app preview.
  const [previewArtifact, setPreviewArtifact] = useState<{ url: string; filename: string } | null>(
    null,
  );
  // Every previewable artifact published this chat (from publish_artifact tool
  // parts + artifact URLs in text), in appearance order — grouped by readable
  // name they become an artifact's versions (a rebuild republishes the file).
  const sessionArtifacts = useMemo(() => {
    const list: { url: string; filename: string; key: string }[] = [];
    const seen = new Set<string>();
    const add = (url?: string, filename?: string) => {
      if (!url || seen.has(url)) return;
      let name = filename;
      if (!name) {
        try {
          name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
        } catch {
          name = "artifact";
        }
      }
      const art = artifactFromHref(url) ?? { url, filename: name ?? "artifact" };
      seen.add(url);
      list.push({ url, filename: art.filename, key: readableArtifactName(art.filename).toLowerCase() });
    };
    for (const m of viewMessages) {
      for (const p of m.parts ?? []) {
        const part = p as { type?: string; toolName?: string; text?: string; input?: unknown; output?: unknown };
        if (part.type === "dynamic-tool" && part.toolName === "publish_artifact") {
          const out = part.output as { url?: string } | undefined;
          const inp = part.input as { filename?: string } | undefined;
          if (out?.url && artifactFromHref(out.url)) add(out.url, inp?.filename);
        } else if (part.type === "text" && part.text) {
          for (const match of part.text.matchAll(
            /https?:\/\/[^\s)\]]+\.(?:xlsx|xls|docx|pptx|ppt|csv)(?:\?[^\s)\]]*)?/gi,
          )) {
            add(match[0]);
          }
        }
      }
    }
    return list;
  }, [viewMessages]);
  const previewVersions = useMemo(() => {
    if (!previewArtifact) return [];
    const key = readableArtifactName(previewArtifact.filename).toLowerCase();
    const versions = sessionArtifacts
      .filter((a) => a.key === key)
      .map((a) => ({ url: a.url, filename: a.filename }));
    if (!versions.some((v) => v.url === previewArtifact.url)) versions.push(previewArtifact);
    return versions;
  }, [previewArtifact, sessionArtifacts]);
  const stuckSeenRef = useRef<Map<string, number>>(new Map());
  const [, forceGraceReeval] = useState(0);
  // Plan handoff: once a plan-mode turn finishes, the banner above the composer
  // offers implement / keep planning / fork. Keyed by message id so it shows
  // once per delivered plan and reappears for each newly finished plan turn.
  const [planHandledId, setPlanHandledId] = useState<string | null>(null);

  // ONE way in for attachments — the picker, a drop and a paste all land here, so
  // they share the same data-URL handling and end up in the same `files` state
  // (the only one the send path reads).
  const addFiles = useCallback((incoming: FileList | File[] | null | undefined) => {
    if (!incoming) return;
    for (const file of Array.from(incoming)) {
      const reader = new FileReader();
      reader.onload = () =>
        setFiles((prev) => [
          ...prev,
          {
            id: `${file.name}-${prev.length}-${file.size}`,
            name: file.name,
            dataUrl: reader.result as string,
            file,
            mediaType: file.type || "application/octet-stream",
          },
        ]);
      reader.readAsDataURL(file);
    }
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    e.target.value = "";
  };

  // Drag-and-drop + paste. PromptInput has its own form-level drop handler and
  // textarea paste handler, but they feed ITS internal attachment store, which
  // this chat never reads — files dropped there simply vanished. These run in
  // the CAPTURE phase on the whole chat column (a near-miss still attaches) and
  // stop the event before PromptInput sees it. Enter/leave are counted because
  // they fire for every child element the pointer crosses.
  const canAttach = !readOnly;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnterFiles = (e: React.DragEvent) => {
    if (!canAttach || !carriesFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOverFiles = (e: React.DragEvent) => {
    if (!canAttach || !carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeaveFiles = (e: React.DragEvent) => {
    if (!canAttach || !carriesFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDropFiles = (e: React.DragEvent) => {
    if (!carriesFiles(e)) return;
    // Always swallow a file drop: unhandled, the browser navigates to the file.
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (canAttach) addFiles(e.dataTransfer.files);
  };
  const onPasteFiles = (e: React.ClipboardEvent) => {
    if (!canAttach) return;
    const pasted: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) pasted.push(file);
    }
    if (pasted.length === 0) return; // plain text: untouched
    e.preventDefault();
    e.stopPropagation();
    addFiles(pasted);
  };

  // Persist chat metadata once it has a server session.
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const sessionId = agent.session?.sessionId;
  const title = cleanTitle(firstUserText(viewMessages));
  /**
   * DESKTOP NOTIFICATIONS from this tab (app/_components/desktop-notify.ts): when the tab is hidden or unfocused and
   * its own stream brings a finished reply, a question or approval, or a failure, say so — under the same tag the
   * server's push uses, so the two never alert twice. Only for events that ARRIVE while mounted: the transcript a
   * chat opens with is history. The chat on screen is registered so neither this nor a push notifies about the
   * conversation the person is looking at.
   */
  const viewingSid = liveSessionIdRef.current ?? initialSession?.sessionId ?? null;
  useEffect(() => {
    setViewingSession(viewingSid);
    return () => setViewingSession(null);
  }, [viewingSid]);
  const notifiedUpToRef = useRef<number | null>(null);
  const titleForNotify = useRef<string | null>(null);
  titleForNotify.current = title ?? null;
  useEffect(() => {
    const evs = mergedEvents as readonly TurnEvent[];
    if (notifiedUpToRef.current === null || notifiedUpToRef.current > evs.length) {
      notifiedUpToRef.current = evs.length;
      return;
    }
    const from = notifiedUpToRef.current;
    notifiedUpToRef.current = evs.length;
    const sid = liveSessionIdRef.current;
    if (!sid || relayThreadId) return;
    for (let i = from; i < evs.length; i++) {
      const e = evs[i] as {
        type?: string;
        data?: {
          turnId?: string;
          finishReason?: string;
          message?: string;
          requests?: ReadonlyArray<{ prompt?: string; action?: { kind?: string; toolName?: string } | null }>;
        };
      };
      const turnId = e.data?.turnId;
      if (e.type === "input.requested") {
        const r = e.data?.requests?.[0];
        const tool = r?.action?.kind === "tool-call" ? r.action.toolName : undefined;
        void notifyFromPage({ kind: "input", sessionId: sid, turnId, tool, text: tool ? undefined : r?.prompt }, titleForNotify.current);
      } else if (e.type === "turn.failed") {
        void notifyFromPage({ kind: "failed", sessionId: sid, turnId }, titleForNotify.current);
      } else if (e.type === "turn.completed") {
        // A reply — unless the turn parked on the person (already notified as a question) or produced no answer.
        let text: string | undefined;
        let parked = false;
        for (let j = i - 1; j >= 0; j--) {
          const p = evs[j] as typeof e;
          if (p.type === "turn.started" || isSessionBoundary(p as TurnEvent)) break;
          if (p.data?.turnId && turnId && p.data.turnId !== turnId) break;
          if (p.type === "input.requested") parked = true;
          if (text === undefined && p.type === "message.completed" && p.data?.finishReason !== "tool-calls" && p.data?.message?.trim()) {
            text = p.data.message;
          }
        }
        if (!parked && text) void notifyFromPage({ kind: "reply", sessionId: sid, turnId, text }, titleForNotify.current);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedEvents.length]);

  const preview = lastText(viewMessages);
  const messageCount = viewMessages.length;
  const customersKey = selectedCustomers.join(",");
  const status = agent.status;
  // Answered-input markers to fold into the persisted stream (see helper). The
  // count is a dep so persisting re-fires the moment a new input is answered,
  // even when neither status nor messageCount changes.
  const responded = respondedInputEvents(viewMessages, answeredResponses);
  const respondedCount = responded.length;
  const respondedRef = useRef(responded);
  respondedRef.current = responded;
  const stoppedMarkersRef = useRef(stoppedMarkers);
  stoppedMarkersRef.current = stoppedMarkers;
  /**
   * WHY THE PERSIST IS ON A CLOCK AND NOT ON `preview`.
   *
   * `preview = lastText(viewMessages)` is the FULL TEXT of the last part, so it
   * changes with every single character the model streams — and this effect
   * depended on it. Every delta therefore ran the whole persist: `dedupeEvents`
   * (a `JSON.stringify` per event, into a Set) plus a SYNCHRONOUS
   * `localStorage.setItem` of the entire chat list. Measured by review on a
   * mid-range core, on a 1,500-event turn with a 60 KB table in it: ~460 ms of
   * blocking main-thread work PER DELTA, against a 47 MB string. That is the
   * chat freezing while it writes, not while it thinks. It predates the
   * reattach; the reattach made it fire during detached turns too, which is how
   * it became this change's problem.
   *
   * The transcript still has to be persisted WHILE a reply streams (a reload
   * mid-turn must not lose it), so the fix is not to drop the dependency but to
   * take it off the character: a tick that advances at most once every two
   * seconds while anything is streaming, plus the events that already mark real
   * progress (a new message, an answered input, the status settling). `preview`
   * itself is read from a ref at write time, so the row still carries the latest
   * line without the effect ever keying on it.
   */
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [persistTick, setPersistTick] = useState(0);
  const streamingNow = isBusy || attachLive;
  useEffect(() => {
    if (!streamingNow) return;
    const id = setInterval(() => setPersistTick((n) => n + 1), 2_000);
    return () => clearInterval(id);
  }, [streamingNow]);
  /** Client-only markers the server replay lacks — carried through a resync. */
  const clientMarkers = () => [
    ...(mergedEvents as { type?: string }[]).filter((e) => e.type?.startsWith("client.")),
    ...respondedRef.current,
    ...stoppedMarkersRef.current,
  ];
  useEffect(() => {
    if (sessionId && agent.session) {
      persistRef.current(
        // The cursor the STORE holds does not know about the live tail: it only
        // advances inside a `send()`. Persisting it beside a transcript the tail
        // extended would file a `streamIndex` that understates the events in the
        // same row, and the snapshot's seam check (lib/chat-snapshot.ts) would
        // then find the stream disagreeing with the cache on the next open and
        // throw the whole cached transcript away for a full replay.
        attachedTail.length > 0
          ? ({
              ...agent.session,
              streamIndex: absoluteIndex(mergedEvents as readonly TurnEvent[]),
            } as AgentSession)
          : agent.session,
        {
          title: title ?? "New chat",
          // Read from the ref: the LATEST line still reaches the sidebar row,
          // but this effect never has to wake up for a character (see above).
          preview: previewRef.current,
          messageCount,
          customers: selectedCustomers.length ? selectedCustomers : undefined,
          forkedFrom,
        },
        // Persist the event stream so reopening this chat restores its history
        // (data.messages is projected from events, not from the session cursor).
        // Fold in synthesized `client.input.responded` events so answered
        // questions/approvals stay answered across a reopen instead of reverting
        // to pending and hoisting to the tail.
        [...mergedEvents, ...responded, ...stoppedMarkers] as typeof mergedEvents,
        chatKey,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, title, messageCount, customersKey, status, respondedCount, stoppedMarkers.length, persistTick]);

  // A snapshot for the Share dialog — the server thread row needs the current
  // session id, freshest resume token, and the client-side input-response
  // markers (which the eve replay lacks). Null until the chat has a real,
  // non-ephemeral session (nothing to share before the first message).
  const canShare = Boolean(sessionId) && !chatKey.startsWith("eve-") && !readOnly && !isEmpty;
  const getSharePayload = useCallback((): SharePayload | null => {
    const sid = agent.session?.sessionId;
    if (!sid) return null;
    return {
      clientKey: chatKey,
      eveSessionId: sid,
      title: title ?? "Shared chat",
      preview,
      customers: selectedCustomers.length ? selectedCustomers : undefined,
      forkedFrom,
      continuationToken: freshestToken(),
      clientEvents: responded,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, title, preview, customersKey, forkedFrom, respondedCount, sessionId]);

  // Prefix a message with directives: customer context (first turn) + a
  // web-search opt-out when the toggle is off.
  const withDirectives = (body: string, withContext: boolean, s: QueueSettings = currentSettings()) => {
    if (!body) return body;
    const directives: string[] = [];
    if (withContext && s.customers.length > 0) {
      directives.push(`(Context: this conversation is about ${s.customers.join(", ")}.)`);
    }
    for (const d of [searchDirective(s.webSearch), browserDirective(s.browserUse), modeDirective(s.mode as AgentMode)]) {
      if (d) directives.push(d);
    }
    /**
     * Wrapped, not bare. These tell the MODEL what this turn may use; showing
     * them to the reader puts "(Browser use is enabled — you may open a real
     * browser (browser_open) …)" in the words they supposedly typed.
     */
    return directives.length > 0 ? `${wrapDirectives(directives)}\n\n${body}` : body;
  };

  /**
   * Store an attachment in the data room and RETURN WHERE IT WENT.
   *
   * This already existed and threw the path away, which was the whole problem:
   * the file was persisted correctly AND the entire base64 copy was inlined into
   * the turn as well. An 840KB spreadsheet became an 840KB message, the turn's
   * step could not carry it, eve retried four times and gave up, and the user
   * watched a spinner. Inlining a file into a durable step payload is not file
   * handling — store it once, pass a reference, let the tools read it.
   */
  const persistAttachment = async (f: AttachedFile): Promise<string | null> => {
    try {
      const form = new FormData();
      // The original File — never a re-fetch of the data URL (CSP blocks that).
      form.append("file", f.file, f.name);
      const res = await fetch("/api/ops/upload", {
        method: "POST",
        headers: getAuthHeaders(),
        body: form,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { path?: string };
      return data.path ?? null;
    } catch {
      return null;
    }
  };

  /**
   * THE QUEUE — held on the server (app/_components/use-chat-queue.ts), so closing the tab does not lose it and the
   * server sends it when the session comes to rest. Each item carries the WIRE TEXT for the settings it was queued
   * under (Plan mode keeps its directive), composed here exactly as `sendMessage` composes a direct send. Only the
   * person's own chats: a shared or relay thread keeps its queue in this tab.
   */
  const composeQueued = (
    text: string,
    s: QueueSettings,
    stored: ReadonlyArray<{ name: string; path: string }>,
    failed: readonly string[],
  ) => {
    const qmode = s.mode as AgentMode;
    const isGoal = qmode === "goal" || qmode === "loop";
    const body = isGoal ? goalPreamble(text, qmode) : text;
    return { message: composeAttachmentMessage(withDirectives(body, false, s), stored, failed), goal: isGoal };
  };
  const queue = useChatQueue({
    chatKey,
    sessionId: liveSessionIdRef.current ?? initialSession?.sessionId ?? null,
    serverAllowed: ownsPending,
    getAuthHeaders,
    compose: composeQueued,
    upload: (file, name) => persistAttachment({ file, name } as AttachedFile),
    onDelivered: (d) => {
      // Sent by the server (or another tab's drain): read its reply like one of ours — unless it is on screen already.
      const events = mergedEventsRef.current as readonly TurnEvent[];
      const since = Date.now() - 20 * 60_000;
      if (receivedSince(events, d.message, since)) return;
      recordDelivery(d.message, "message");
      if (d.goal) setGoalRun({ kind: "goal", objective: d.text, outcome: null });
    },
  });
  const queued = queue.entries;
  enqueueRef.current = async (text, files, s) => {
    const entry = await queue.add(
      text,
      files.map((f) => ({ file: f.file, name: f.name })),
      s,
    );
    if (entry.where === "local" && files.length > 0) queuedFiles.set(entry.id, files);
  };

  /**
   * Only small images ride along inside the message.
   *
   * A model can SEE an image, so inlining one buys something. Nothing is gained
   * by inlining a spreadsheet or a PDF: the agent reads those with its data-room
   * and sandbox tools, from the copy that is already stored. The cap is on the
   * encoded length because that is what actually travels.
   */
  const INLINE_LIMIT_BYTES = 256 * 1024;
  const worthInlining = (f: AttachedFile) =>
    f.mediaType.startsWith("image/") && f.dataUrl.length <= INLINE_LIMIT_BYTES;

  /**
   * A copy of an image small enough to ride inside the message, or null.
   *
   * The original is always stored in the data room at full size. What the MODEL sees is this copy: before it
   * existed, an image over the inline limit — every phone photo, most full-page screenshots — was stored and
   * then never shown to the model at all, so a vision model still answered "I cannot see the image". The copy
   * is drawn in the browser (no network, so the CSP does not apply): longest side stepped down from 1568px
   * and JPEG quality stepped down until it fits. Text in a scanned page stays legible at these sizes; if even
   * the smallest attempt does not fit, the model falls back to the stored file like any other attachment.
   */
  const inlineCopy = async (f: AttachedFile): Promise<{ dataUrl: string; mediaType: string } | null> => {
    if (!f.mediaType.startsWith("image/") || f.mediaType === "image/svg+xml") return null;
    if (f.dataUrl.length <= INLINE_LIMIT_BYTES) return { dataUrl: f.dataUrl, mediaType: f.mediaType };
    try {
      const bitmap = await createImageBitmap(f.file);
      for (const side of [1568, 1280, 1024, 768]) {
        const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const g = canvas.getContext("2d");
        if (!g) return null;
        g.fillStyle = "#fff"; // JPEG has no alpha: a transparent PNG would otherwise turn black
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.85, 0.7, 0.55]) {
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (dataUrl.length <= INLINE_LIMIT_BYTES) return { dataUrl, mediaType: "image/jpeg" };
        }
      }
    } catch {
      /* an image the browser cannot decode (HEIC, a corrupt file): the stored copy is still there */
    }
    return null;
  };

  /**
   * `settings`: a QUEUED message goes out under the settings it was queued with
   * (mode, web search, browser, companies), not whatever the composer shows now.
   */
  const sendMessage = async (raw: string, filesToSend: AttachedFile[], settings?: QueueSettings) => {
    const s = settings ?? currentSettings();
    const mode = s.mode as AgentMode;
    // Goal / Loop: run in the harness. Frame the objective with the goal
    // preamble and attach the completion-gate schema — the harness injects a
    // `final_output` tool and won't end the turn until the model records an
    // outcome, so the agent keeps working end-to-end. Plain modes send as-is.
    const isGoal = mode === "goal" || mode === "loop";
    const body = isGoal ? goalPreamble(raw, mode) : raw;
    // Context only on the very first turn; web-search opt-out every turn.
    const text = withDirectives(body, viewMessages.length === 0, s);
    const outputSchema = isGoal ? (GOAL_OUTCOME_SCHEMA as unknown as object) : undefined;
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; data: string; mediaType: string; filename?: string }
    > = [];
    /**
     * Store attachments FIRST, then tell the agent where they are.
     *
     * Awaited on purpose: the reference in the message has to be true when the
     * agent reads it, and a turn that starts before its file exists is a turn
     * that reports the file missing. Uploads run in parallel with each other, so
     * this costs one round trip, not one per file.
     */
    setUploading(filesToSend.length);
    const stored = await Promise.all(
      filesToSend.map(async (f) => ({ file: f, path: await persistAttachment(f) })),
    ).finally(() => setUploading(0));
    /**
     * `[file: name]` for the CHIP, the path for the agent.
     *
     * The transcript renders those tokens as attachment chips
     * (agent-message.tsx extractAttachments) and strips them from the visible
     * text. Previously the chip came from the inlined file part; now that only
     * small images travel inline, a sent message would show no attachment at
     * all — the file would look like it had never been sent.
     */
    const ok = stored
      .filter((s) => s.path)
      .map((s) => ({ name: s.file.name, path: s.path as string }));
    const failed = stored.filter((s) => !s.path).map((s) => s.file.name);
    // One shared composer (lib/chat-attachments), so the tests exercise exactly
    // what ships: model gets the paths, the reader sees only their own words.
    const messageText = composeAttachmentMessage(text, ok, failed);

    if (messageText) parts.push({ type: "text", text: messageText });
    for (const { file: f } of stored) {
      const copy = worthInlining(f) ? { dataUrl: f.dataUrl, mediaType: f.mediaType } : await inlineCopy(f);
      if (copy) {
        parts.push({ type: "file", data: copy.dataUrl, mediaType: copy.mediaType, filename: f.name });
      }
    }
    const content: UserContent = parts.length > 1 ? (parts as UserContent) : messageText;
    if (isGoal) setGoalRun({ kind: mode, objective: raw, outcome: null });
    // If the store would CONTINUE a parked session but its cursor has no resume
    // token, it POSTs an empty continuationToken and eve rejects the whole turn.
    // Pre-empt that: deliver directly with the freshest token from the stream.
    //
    // And when the store has lost its cursor ENTIRELY while this chat still
    // knows its session — a Stop aborts the store's read, and eve's
    // `advanceSession` then drops the session id with the rest — `send()` would
    // open a brand-new eve session: the reply lands in a conversation nobody is
    // showing (measured in the review: "MSG-3" went to POST /eve/v1/session
    // after a Stop and was never seen again). Deliver to the live session instead.
    const cursorLost = !agent.session?.sessionId && Boolean(liveSessionIdRef.current) && viewMessages.length > 0;
    if (
      (cursorLost || (agent.session?.sessionId && !agent.session.continuationToken)) &&
      (await directDeliver({ message: content, outputSchema }))
    ) {
      return;
    }
    // Recorded BEFORE the send: the store's reader can stop at a boundary that
    // is not this message's (a turn still running, a specialist parked), and
    // then this is the only record that eve still owes a reply to it.
    const delivery = recordDelivery(messageText, "message");
    const eventsBefore = storeEventsSeenRef.current;
    const errorsBefore = storeErrorsRef.current;
    try {
      await agent.send(
        (outputSchema
          ? { message: content, outputSchema }
          : { message: content }) as Parameters<typeof agent.send>[0],
      );
    } catch (err) {
      forgetDelivery(delivery);
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTokenError(msg) && (await directDeliver({ message: content, outputSchema }))) return;
      throw err;
    }
    // The store swallows a failed POST (it resolves with an error set). Nothing
    // read AND an error raised means the message never reached eve, so it is
    // owed nothing. (A send ended by Stop reads nothing too, but raises no error:
    // that message may well be held by eve, so it stays owed.)
    if (storeEventsSeenRef.current === eventsBefore && storeErrorsRef.current !== errorsBefore) {
      forgetDelivery(delivery);
    }
  };

  // Conclude a goal by making the model record its outcome — the only thing that
  // clears the session's completion gate. Delivered with the schema already on
  // the session, so `final_output` is available.
  const deliverGoalWrapUp = async () => {
    const wrap =
      "Stop now — the user ended this goal. Do not start or continue any work. Immediately record the outcome by calling final_output with status \"blocked\" and a one-sentence summary of the current state and what remains.";
    if (agent.session?.sessionId && !agent.session.continuationToken && (await directDeliver({ message: wrap }))) {
      return;
    }
    try {
      await agent.send({ message: wrap });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTokenError(msg)) await directDeliver({ message: wrap });
    }
  };

  /**
   * STOP THE TURN, not just the listening.
   *
   * `agent.stop()` only aborts the local stream: "the server-side turn keeps
   * running" (eve docs, frontend overview). Worse, a stream that ends without a
   * session boundary resets eve's whole client cursor, so the very next send
   * went to a BRAND-NEW eve session — the agent lost the conversation, and the
   * new session's `turn_0` wrote over this transcript's first exchange.
   *
   * eve's cancel route stops the turn itself; it settles on the stream we are
   * still reading as `turn.cancelled` → `session.waiting`, which is a real
   * boundary: the store goes idle with its cursor intact and the queue flushes
   * into the SAME session. Only when that cannot happen (no session yet, the
   * request failed, no boundary within the grace) do we fall back to the local
   * detach — and then the gate holds sends until the turn is known to be over.
   */
  const [stopping, setStopping] = useState(false);
  /** What the last Stop found, said once above the composer (a refused Stop from a stale tab). */
  const [stopNote, setStopNoteState] = useState<string | null>(() => stopNotes.get(stopStateKey) ?? null);
  const setStopNote = (note: string | null) => {
    if (note) stopNotes.set(stopStateKey, note);
    else stopNotes.delete(stopStateKey);
    setStopNoteState(note);
  };
  const stopFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The transcript as it stands when a deferred callback finally runs. */
  const mergedEventsRef = useRef(mergedEvents);
  mergedEventsRef.current = mergedEvents;
  const stopTurn = useCallback(() => {
    const sid = liveSessionIdRef.current;
    const storeBusy = agent.status === "submitted" || agent.status === "streaming";
    if (!sid) {
      agent.stop();
      return;
    }
    setStopping(true);
    setStopNote(null);
    const events = mergedEventsRef.current as readonly TurnEvent[];
    const wasTurn = turnsStarted(events as { type?: string }[]);
    /**
     * WHAT THIS STOP MAY RELEASE (see `releaseDeliveries`): this tab's own
     * deliveries, and another tab's only if it was sent before this tab last saw
     * the stream move. Chosen NOW, released only once the Stop is known to be
     * aimed at what is on screen — a refused Stop releases nothing.
     */
    const viewAt = lastViewAtRef.current;
    const owedNow = deliveriesRef.current as readonly PendingDelivery[];
    const toRelease = releasable(owedNow, SELF_IDS, viewAt);
    // Another tab's message past the grace may go too — but only if the server
    // shows the session AT REST: a message queued behind a long specialist run
    // is waiting legitimately, and releasing it is a lie about what is on screen.
    const withGrace = async (): Promise<PendingDelivery[]> => {
      const more = releasable(owedNow, SELF_IDS, viewAt, Date.now(), { sessionAtRest: true }).filter(
        (d) => !toRelease.includes(d),
      );
      if (more.length === 0) return toRelease;
      const tail = await readTailEvent({ sessionId: sid, headers: getAuthHeaders });
      return isSessionBoundary(tail ?? undefined) ? [...toRelease, ...more] : toRelease;
    };
    /** AIMED AT THE TURN ON SCREEN (`stopTarget`) — never session-wide, never a guess. */
    const target = stopTarget(events);
    /**
     * STOPPING A TURN THAT IS WAITING ON A QUESTION, or a reply that resumed
     * after one. eve drops a parked delegation and emits NOTHING, and a resumed
     * reply ends without a `turn.cancelled` — so once the cancel is accepted the
     * Stop is recorded here: a transcript marker (persisted, so a reload and
     * another device agree) that retires the questions, settles the
     * specialist's tile and says "Stopped."
     */
    const parkedOn = gateReasonRef.current === "awaiting-input" ? [...openRequestsRef.current] : [];
    const delegations = parkedOn.length > 0 || target.resumed ? liveDelegations(events) : [];
    if (!target.turnId) {
      // NOTHING IS RUNNING. Cancel nothing (there is no turn on screen to aim
      // at); release what this tab was holding so its queue can move. A store
      // still waiting on a message eve never started stops waiting.
      if (storeBusy) agent.stop();
      releaseDeliveries(toRelease);
      setRemoteTurn(false);
      setStopping(false);
      void withGrace().then((all) => {
        if (all.length > toRelease.length) releaseDeliveries(all.filter((d) => !toRelease.includes(d)));
      });
      report("stop", { sessionId: sid, detail: `${storeBusy ? "streaming" : (gateReasonRef.current ?? "held")} · at rest, nothing cancelled` });
      return;
    }
    void (async () => {
      /**
       * A STALE VIEW STOPS NOTHING. If the stream has moved past what this tab
       * shows (another tab answered, or started a newer turn), refuse, refresh,
       * and say so — the person decides again from the real state. Only a view
       * nothing is reading can be stale: a tab reading the turn live is showing
       * the very turn it would stop.
       */
      if (!storeBusy && !attachLiveRef.current) {
        const moved = await streamHasMoved(
          eveSessionStream({ sessionId: sid, headers: getAuthHeaders }),
          absoluteIndex(events),
        );
        if (moved) {
          attachFailures.delete(attachKeyRef.current);
          attachRounds.delete(attachKeyRef.current);
          setAttachEpoch((n) => n + 1);
          setStopping(false);
          setStopNote("This chat moved on in another tab — it has been refreshed. Press Stop again if it is still running.");
          return;
        }
      }
      // Aimed and current: now release, and linger a reader briefly — if eve
      // was holding a message behind the stopped turn, it runs next.
      releaseDeliveries(await withGrace());
      setLingerUntil(Date.now() + 20_000);
      const mine = stoppedHere.get(stopStateKey) ?? new Set<string>();
      mine.add(target.turnId as string);
      stoppedHere.set(stopStateKey, mine);
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sid)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ turnId: target.turnId }),
      });
      if (!res.ok) throw new Error(`cancel ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      // The turn we delivered around the store (an answer posted by the app)
      // is the one just stopped: nothing will arrive to say it ended, so its
      // hold must not outlive the Stop.
      if (body.status === "accepted") setRemoteTurn(false);
      if (body.status === "accepted" && (parkedOn.length > 0 || target.resumed || target.parked)) {
        recordStopMarker(
          stopStateKey,
          // The note goes under the reply that was stopped: a resumed hand-back's own turn.
          stoppedMarker({ requestIds: parkedOn, delegations, at: absoluteIndex(events), turnId: target.replyTurnId ?? target.turnId }),
        );
        setStopping(false);
      } else if (
        body.status === "accepted" &&
        target.turnId &&
        turnShowedNothing(mergedEventsRef.current as readonly TurnEvent[], target.turnId)
      ) {
        // STOPPED BEFORE IT SAID ANYTHING. The note has no reply to sit under and
        // eve's `turn.cancelled` may not be in what a later open reads, so the
        // Stop is recorded as a marker: persisted with the chat (client_markers),
        // it says "Stopped." under this turn on every open and every device.
        recordStopMarker(
          stopStateKey,
          stoppedMarker({ requestIds: [], delegations: [], at: absoluteIndex(events), turnId: target.turnId }),
        );
      }
      if (body.status === "no_active_turn") {
        // Nothing is running under this id, yet the transcript never saw the
        // turn end: it is dead (or ended unheard), not slow. Stop reading a
        // stream that will say nothing, release the hold, pull the truth.
        if (storeBusy) agent.stop();
        setRemoteTurn(false);
        abandonedTurns.set(chatKey, wasTurn);
        setAbandonedTurn(wasTurn);
        setStopping(false);
        // The local cursor was reset by the detach; without the replay's
        // cursor the next send would open a new, empty eve session.
        void onResync?.(sid, clientMarkers()).catch(() => false);
      }
    })().catch(() => {
      if (storeBusy) agent.stop();
      setStopping(false);
    });
    if (stopFallbackRef.current) clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = setTimeout(() => {
      if (storeBusy) {
        // No boundary arrived. Detach so the composer is not frozen; the gate
        // keeps new messages queued until the turn is seen to settle.
        agent.stop();
        setStopping(false);
        return;
      }
      /**
       * STOP HAS TO WORK EVEN WHEN NOTHING CAN HEAR THE ANSWER.
       *
       * On a DETACHED turn the cancel request goes out fine and eve really does
       * stop the turn — but `turn.cancelled` → `session.waiting` can only reach
       * this transcript through the live reader or the poll. The turn the person
       * asked to stop is exactly the turn the server was told to stop, so after
       * the grace we record it as abandoned, which is the same state the
       * `no_active_turn` answer produces: the gate releases, the reader stands
       * down, and the replay picks up whatever really happened on the next open.
       */
      if (turnUnfinished(mergedEventsRef.current as readonly TurnEvent[])) {
        abandonedTurns.set(chatKey, wasTurn);
        setAbandonedTurn(wasTurn);
      }
      // Stop always releases the hold, whatever the stream says or does not say.
      setRemoteTurn(false);
      setStopping(false);
    }, 12_000);
    report("stop", { sessionId: sid, detail: `${storeBusy ? "streaming" : (gateReasonRef.current ?? "detached")} · ${target.turnId}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, chatKey, getAuthHeaders, report, onResync]);
  useEffect(() => {
    if (isBusy) return;
    if (stopFallbackRef.current) clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = null;
  }, [isBusy]);
  useEffect(() => {
    if (!gate.hold) setStopping(false);
  }, [gate.hold]);
  useEffect(
    () => () => {
      if (stopFallbackRef.current) clearTimeout(stopFallbackRef.current);
    },
    [],
  );

  // Stop control for an active goal/loop.
  const requestGoalStop = () => {
    if (agent.status === "submitted" || agent.status === "streaming") {
      // Halt the in-flight turn first; the watcher below delivers the wrap-up
      // once it settles (sending mid-turn would throw "already processing").
      stopTurn();
      setGoalStopping(true);
    } else {
      void deliverGoalWrapUp();
    }
  };

  // Once a stop-requested turn has halted, deliver the wrap-up so the model
  // records the outcome and the completion gate clears.
  useEffect(() => {
    if (!goalStopping) return;
    // Not merely "the store is idle": after a detach the turn is still running
    // and the wrap-up would land in the middle of it.
    if (gate.hold) return;
    setGoalStopping(false);
    void deliverGoalWrapUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalStopping, gate.hold]);

    // The delivered plan: the last assistant message's text once a plan-mode turn
  // has fully finished and nothing is parked on user input.
  const planText =
    // `answerOver`, not `!isBusy`: "fully finished" is a property of the TURN.
    // On `isBusy` a detached plan turn offered "Approve this plan" over the
    // first paragraph of one still being written.
    mode === "plan" && answerOver && !awaitingUser && lastMessage?.role === "assistant"
      ? (lastMessage.parts ?? [])
          .map((p) => {
            const part = p as { type?: string; text?: string };
            return part.type === "text" ? (part.text ?? "") : "";
          })
          .join("\n")
          .trim()
      : "";
  const planReady = Boolean(planText) && lastMessage?.id !== planHandledId;

  const implementPlan = () => {
    if (!lastMessage || gate.hold) return;
    setPlanHandledId(lastMessage.id);
    setMode("build");
    void agent.send({
      message:
        "The plan above is approved — plan mode is now OFF. Implement it end to end, following the steps in order, and verify each step as you go.",
    });
  };

  const continuePlanning = () => {
    if (lastMessage) setPlanHandledId(lastMessage.id);
  };

  const forkPlan = () => {
    if (!lastMessage) return;
    setPlanHandledId(lastMessage.id);
    onForkPlan?.(planText);
  };

  // A forked mount auto-sends its seed prompt as the first turn.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialPrompt || viewMessages.length > 0) return;
    seededRef.current = true;
    void sendMessage(initialPrompt, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const raw = message.text?.trim() ?? "";
    if (!raw && files.length === 0) return;
    // Clear a lingering "manually compacted" divider once the user continues.
    setCompacting(null);
    // Shared-thread participant: route through the server relay (atomic token
    // claim + serialized turn). The eve store is NOT involved — the transcript
    // refreshes via onRelaySent once the turn parks.
    if (relayThreadId) {
      if (!raw || relayPending) return;
      setRelayError(null);
      setRelayPending(raw);
      try {
        await opsFetch(`/api/ops/threads/${relayThreadId}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: raw }),
        });
        onRelaySent?.();
      } catch (e) {
        setRelayError(e instanceof Error ? e.message : String(e));
      } finally {
        setRelayPending(null);
      }
      return;
    }
    const outgoing = files;
    setFiles([]);
    // While ANY turn of this session is live — streaming, detached, or parked on
    // a request — the message is held, never appended as if the chat were idle.
    const answers =
      gate.reason === "awaiting-input" && raw ? resolveTextToResponses(raw, openInputRequests) : [];
    const route = composerRoute({ gate, answers: answers.length, hasFiles: outgoing.length > 0 });
    if (route === "answer") {
      // Typed text that answers the open question IS the answer (eve resolves
      // it the same way server-side). Recorded on the card, not as a new bubble
      // under a reply that is about to resume above it.
      await respondToInput(answers);
      return;
    }
    // Behind what is already queued, never around it: a message typed while earlier ones wait goes after them.
    if (route === "queue" || (route === "send" && queue.pending.length > 0)) {
      enqueue(raw, outgoing);
      return;
    }
    await sendMessage(raw, outgoing);
  };

  // Stuck-handoff grace: remember when each stuck run was first reported, drop
  // ones that resolved, and re-evaluate on a slow tick so the grace can elapse
  // even when no other state changes.
  useEffect(() => {
    const nowT = Date.now();
    const live = new Set(stuckHandoffs.map((h) => h.callId));
    for (const h of stuckHandoffs) {
      if (!stuckSeenRef.current.has(h.callId)) stuckSeenRef.current.set(h.callId, nowT);
    }
    for (const k of [...stuckSeenRef.current.keys()]) {
      if (!live.has(k)) stuckSeenRef.current.delete(k);
    }
  }, [stuckHandoffs]);
  useEffect(() => {
    if (stuckHandoffs.length === 0) return;
    const t = setInterval(() => forceGraceReeval((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, [stuckHandoffs.length]);
  const STUCK_GRACE_MS = 12_000;
  const shownHandoffs = stuckHandoffs.filter((h) => {
    if (handledHandoffs.has(h.callId)) return false;
    const seen = stuckSeenRef.current.get(h.callId);
    return seen !== undefined && Date.now() - seen >= STUCK_GRACE_MS;
  });
  // Pull a finished subagent's result into the chat as a new message so the
  // main agent can continue — best-effort, and the result is preserved in the
  // transcript regardless of whether the parent resumes.
  const bringResult = (h: { callId: string; name: string; result: string }) => {
    setHandledHandoffs((prev) => withRequestIds(prev, [h.callId]));
    const msg = `The ${h.name} subagent finished, but its result did not come through automatically. Here is its final result verbatim:\n\n${h.result}\n\nUse this to continue and complete the task.`;
    if (gate.hold) {
      // The parent turn is stuck — it's "busy" awaiting a child that already
      // finished, so it will NEVER complete on its own and the normal queue
      // would wait forever. CANCEL that turn (not a local abort: that left it
      // running, reset the cursor, and sent this result to a new, empty
      // session), then queue: the flush effect delivers the result once the
      // cancellation settles on the stream.
      enqueue(msg, []);
      stopTurn();
    } else {
      void sendMessage(msg, []);
    }
  };

  /**
   * SEND THE QUEUE — one message at a time, as soon as the SESSION is idle (not merely the store, see sendGate).
   *
   * A server-held item is sent BY THE SERVER (lib/chat-queue-drain.ts): usually the agent's hook has already done
   * it the moment the session came to rest, and this tab only asks in case it has not (a hook that could not reach
   * the web app, a deployment without the key the server signs with). Either way the server's claim makes it
   * exactly once, and `onDelivered` has this tab read the reply. The ask backs off: the server may know better
   * that the session is not at rest (another tab's message is running), and a tight loop would only repeat that.
   *
   * An item the server could not hold (`where: "local"`) is sent by this tab, with the settings it was queued
   * under. One at a time: `flushingRef` holds until the send (upload included) is done.
   */
  const flushingRef = useRef(false);
  const drainAfterRef = useRef(0);
  const [flushTick, setFlushTick] = useState(0);
  useEffect(() => {
    if (gate.hold || readOnly || flushingRef.current || queued.length === 0) return;
    const done = () => {
      flushingRef.current = false;
      setFlushTick((n) => n + 1);
    };
    const local = queued.find((q) => q.where === "local" && q.state === "queued" && !q.busy && (q.files === 0 || queuedFiles.has(q.id)));
    if (local) {
      const files = queuedFiles.get(local.id) ?? [];
      queuedFiles.delete(local.id);
      queue.takeLocal(local.id);
      flushingRef.current = true;
      if (local.text.trim() || files.length > 0) void sendMessage(local.text, files, local.settings).then(done, done);
      else done();
      return;
    }
    if (!queue.serverQueued) return;
    const wait = drainAfterRef.current - Date.now();
    if (wait > 0) {
      const t = setTimeout(() => setFlushTick((n) => n + 1), wait);
      return () => clearTimeout(t);
    }
    flushingRef.current = true;
    void queue.drain().then(
      (reason) => {
        drainAfterRef.current = reason === "sent" || reason === "received" ? 0 : Date.now() + 3_000;
        done();
      },
      () => {
        drainAfterRef.current = Date.now() + 5_000;
        done();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.hold, queued, queue.serverQueued, flushTick, readOnly]);

  /**
   * Watch a DETACHED turn until it settles, then pull the rest of it in.
   *
   * Nothing local is reading the stream, so ask the server for its tail event
   * (`startIndex=-1`, eve docs "Reconnect and rewind") every few seconds: one
   * event, no replay. A session boundary means the turn is over; the shell then
   * replays the session and remounts this chat on it, which both shows the rest
   * of the reply IN ITS OWN MESSAGE and restores a cursor that continues the
   * same session. The held queue (module scope) flushes on the new mount.
   */
  useEffect(() => {
    // SECOND LINE, not first: while a reader is on the live stream the rest of
    // the reply is already arriving, and a replay would only interrupt it.
    if (!detached || readOnly || relayThreadId || !onResync || attachLive) return;
    const sid = liveSessionIdRef.current;
    if (!sid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let silent = 0;
    let delay = 3000;
    const readTail = async (): Promise<{ type?: string } | null> => {
      const ctrl = new AbortController();
      const hard = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sid)}/stream?startIndex=-1`, {
          headers: getAuthHeaders(),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return null;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          buf += dec.decode(r.value, { stream: true });
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            buf = buf.slice(0, nl);
            break;
          }
        }
        return buf.trim() ? (JSON.parse(buf) as { type?: string }) : null;
      } catch {
        return null;
      } finally {
        clearTimeout(hard);
        ctrl.abort();
      }
    };
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = setTimeout(tick, delay);
        return;
      }
      const tail = await readTail();
      if (cancelled) return;
      const budgetKey = `${chatKey}:${startedTurns}`;
      const known = absoluteIndex(mergedEvents as readonly TurnEvent[]);
      if (!tail) silent += 1;
      /**
       * ONE DETACH, ONE RESYNC THAT HOLDS — see `resyncDecision` for the why.
       *
       * The budget alone only bounded the spin at four; the replay coming back
       * mid-turn is what made each remount detach again, and each cycle cost a
       * full replay and another telemetry record.
       */
      const decision = resyncDecision({
        tail: tail ?? undefined,
        silentReads: silent,
        knownEvents: known,
        lastResyncEvents: resyncEventFloor.get(budgetKey),
        spent: resyncsSpent.get(budgetKey) ?? 0,
        budget: RESYNC_BUDGET,
      });
      if (decision.reason === "blind") silent = 0;
      if (decision.resync) {
        resyncsSpent.set(budgetKey, (resyncsSpent.get(budgetKey) ?? 0) + 1);
        // What the NEXT detach of this turn is measured against: a replay that
        // brings back no more than this made no progress, so it is not repeated.
        resyncEventFloor.set(budgetKey, known);
        report("resync", { sessionId: sid, detail: tail?.type ?? "blind" });
        const mounted = await onResync(sid, clientMarkers(), known).catch(() => false);
        if (mounted || cancelled) return; // remounting — this instance is done
        // The server says the session is at rest but the replay could not be
        // mounted. A turn known only by our own POST has nothing else to hold on.
        if (decision.reason === "boundary") setRemoteTurn(false);
      }
      delay = Math.min(delay * 1.5, 15_000);
      timer = setTimeout(tick, delay);
    };
    // A turn delivered around the store needs a moment to START: until then the
    // tail is still the previous park and would read as "settled".
    timer = setTimeout(tick, remoteTurn ? 5000 : 1500);
    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 200);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detached, abandonedTurn, readOnly, relayThreadId, remoteTurn, attachLive]);

  /**
   * ═══ REATTACH TO THE LIVE STREAM ═══════════════════════════════════════════
   *
   * The watcher above POLLS a turn it cannot hear, and then recovers it with a
   * full replay and a remount. This reads the turn instead.
   *
   * WHY THE POLL WAS NEVER ENOUGH. A replay deliberately returns as soon as a
   * live turn goes quiet (chat-shell's `replaySession`), so replaying a RUNNING
   * turn mounts it mid-turn and the fresh mount is detached again. That cycle is
   * what filed three byte-identical "Chat stream ended mid-turn and stopped
   * resuming · last event: message.appended" records on one session inside 63
   * seconds on 2026-09-21. #34 stopped the cycling by demanding progress before
   * another resync — and the fault underneath survived it untouched: on
   * 2026-09-22T15:32:45 the same thing recorded exactly ONCE and the half-written
   * answer simply never continued, while the server finished it perfectly well.
   *
   * WHAT THIS DOES. `ClientSession.stream({ startIndex, signal })` — which eve
   * has always exposed and this app never called — opens the session's event
   * stream at an absolute index. A reader is opened whenever the store is idle
   * and the transcript's tail says a turn is running (`attachDecision`), the
   * events land in `attachedTail`, and `mergedEvents` / `view` above project
   * them beside the store's own. No replay, no remount, no flicker: the rest of
   * the reply is simply written where the rest of the reply goes.
   *
   * WHEN IT LETS GO. The store starts a `send()` (never two readers over one
   * session), a session boundary arrives, the session id changes under it, the
   * turn is judged abandoned, or the component unmounts. Every one of those
   * aborts the fetch through this controller rather than leaving it to leak.
   *
   * THE SEAM. `openStreamIterable` reconnects only on a socket DISCONNECT; the
   * ~120s severance presents as a clean EOF and simply ends the iterable. So the
   * reopen loop lives in lib/chat-attach.ts, around eve's stream, resuming at
   * the advanced absolute index — which is the same thing eve's own send-path
   * reader does, and the only reason live streaming ever survived 120 seconds.
   *
   * THE POLL STAYS, as the second line: a turn that ended while nothing was
   * attached, a stream that refuses to open, a budget spent. `resyncDecision` is
   * untouched; it is just no longer the first thing tried.
   */
  /** The session (or shared thread) this transcript is on, read by the reader. */
  const attachTargetRef = useRef<string | null>(null);
  /**
   * A SHARED thread keeps reading through the membership-checked proxy.
   *
   * eve's own stream route domain-gates reads but does not check membership, so
   * a revoked member pointed straight at the session id would keep receiving the
   * conversation. `/api/ops/threads/:id/stream` checks first and answers 403,
   * which is what makes revoke real — and the reader stops on a 403 rather than
   * retrying it (see lib/chat-attach.ts).
   */
  const attachVia = sharedThreadId;
  const attachId = attachVia ?? liveSessionIdRef.current;
  attachTargetRef.current = attachId ?? null;
  const attachKey = `${chatKey}:${startedTurns}`;
  /**
   * The absolute index the next reader resumes from, kept current every render.
   *
   * Never `agent.session.streamIndex`: the store RESETS that cursor whenever a
   * stream ends without a session boundary, which is precisely the detached case
   * this path exists for. It is derived from the transcript instead, skipping the
   * browser-only `client.*` markers that would otherwise push it past events we do
   * not have — PLUS this mount's compaction deficit, because a cached transcript
   * (lib/chat-snapshot.ts) holds fewer events than the index it covers. Counting
   * alone resumes the reader BEHIND the stream, and re-applying an older
   * `message.appended` rewinds the reply on screen.
   */
  const nextIndexRef = useRef(0);
  nextIndexRef.current = absoluteIndex(mergedEvents as readonly TurnEvent[]);
  /**
   * HAND THE RECOVERED TURN BACK TO THE STORE.
   *
   * Once the reader reaches the session boundary the tail has done its job, and
   * leaving it in component state would eventually corrupt the transcript: the
   * store's own event log knows nothing about it, so the next `send()` — which
   * appends to that log — would shift the absolute cursor underneath the merge
   * and the recovered reply would disappear as the new turn streamed in.
   *
   * `onReattach` is the mechanism the shell already built for exactly this
   * ("remount THIS chat on its own cursor"), and here it costs NOTHING: no
   * replay, no request, no deadline. It is handed the merged events, the session
   * id that survived the cursor reset, and the fresh continuation token the tail
   * just delivered — so the store comes back as the single authority with a
   * cursor that can continue the SAME eve session instead of opening an empty
   * new one whose `turn_0` writes over the first exchange.
   *
   * Built from the reader's own collected events rather than from state, because
   * React has not necessarily committed the last `setAttachedTail` by the time
   * the reader resolves.
   *
   * COLLECTED ACROSS READERS, NOT PER READER. This was a per-effect array, and
   * the effect re-runs mid-turn on three ordinary events: a reader failure
   * bumping `attachEpoch`, the tab becoming visible again, and `attachKey`
   * changing because eve re-emits `turn.started` when it replays a turn after a
   * step throws (see `retryStormDetected`). Reader #2 then starts PAST the
   * store's own index, so its array began after a gap, `mergeAttachedEvents`
   * returned the identical array, and the `merged === agent.events` bail below
   * skipped the hand-off entirely. Proved: store 0..99, tail 100..149 from
   * reader #1, reader #2 collecting 150..202 including the `session.waiting` —
   * no hand-off and no remount. The user watched the reply finish, and then the
   * NEXT message re-projected the stranded tail over the new turn while the
   * store, never having regained the session id or the fresh token, opened a
   * NEW eve session whose `turn_0` wrote over the first exchange. So the tail
   * lives in a ref that outlives the effect and is cleared only on a hand-off
   * or on unmount.
   */
  const collectedRef = useRef<readonly IndexedEvent[]>([]);
  const handBackRef = useRef<(attachedTo: string) => void>(() => {});
  handBackRef.current = (attachedTo) => {
    const collected = collectedRef.current;
    const sid = liveSessionIdRef.current;
    // Deliberately NOT gated on the effect still being mounted: the reader can
    // resolve after React has already committed the terminal event and torn the
    // effect down, and dropping the hand-off there would leave the tail stranded
    // in state — the exact corruption it exists to prevent. What it IS gated on
    // is identity: if the chat has moved to another session since this reader
    // opened, these events belong to a conversation that is no longer on screen.
    if (!sid || sid !== attachedTo) return;
    // A shared thread's mount is owned by the shell (it re-reads through the
    // membership-checked proxy), and a view-only member has no cursor to carry.
    if (!onReattach || attachVia || readOnly || relayThreadId) return;
    if (collected.length === 0) return;
    const merged = mergeAttachedEvents(
      agent.events as readonly TurnEvent[],
      collected,
      absoluteIndex(agent.events as readonly TurnEvent[]),
    );
    if (merged === agent.events) return;
    /**
     * The cursor eve itself would keep — see `handBackSession`.
     *
     * A hand-off on `session.failed` / `session.completed` used to reinstate the
     * DEAD session with a token `freshestToken()` had scraped off an earlier
     * park, so the next message posted to a session that is over with a spent
     * token and read as "The connection to the agent dropped." eve's
     * `advanceSession` returns an EMPTY session state on exactly those two
     * boundaries, which is how a new session gets opened and what
     * `withSessionEpochs` is written against.
     */
    const cursor = handBackSession({
      boundary: merged[merged.length - 1] as TurnEvent | undefined,
      sessionId: sid,
      continuationToken: freshestToken(),
      streamIndex: absoluteIndex(merged),
    });
    collectedRef.current = [];
    onReattach(cursor as AgentSession, [...merged, ...clientMarkers()] as AgentEvents);
  };
  /**
   * A specialist handed over as "reports later" (lib/detached-delegation.ts) brings its result back as a turn nobody in
   * this tab started. Until it has, the server still owes this transcript that turn: keep a reader on the stream (its
   * quiet is expected, `workingSpecialists`), so the result appears when it lands, not at the next send or reload.
   * Only the READER counts it — the composer is not held for it.
   */
  const reportsLaterOwed = useMemo(
    () => detachedOutstanding(mergedEvents as readonly TurnEvent[]).length > 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventCount],
  );
  const attachVerdict = attachDecision({
    sessionId: attachId,
    storeBusy: isBusy,
    events: mergedEvents as readonly TurnEvent[],
    abandoned: abandonedTurn !== null && abandonedTurn === startedTurns,
    failures: attachFailures.get(attachKey) ?? 0,
    maxFailures: ATTACH_BUDGET,
    // A Stop leaves a reader lingering briefly (see stopTurn): anything eve was
    // holding behind the stopped turn runs next and has to be read.
    outstanding: outstanding.length + (lingering ? 1 : 0) + (reportsLaterOwed ? 1 : 0),
  });
  const shouldAttach = attachVerdict.attach;
  /**
   * A SPENT BUDGET IS A PAUSE, NOT THE END — see `attachRetryDelayMs`.
   *
   * "open-failed" used to hold for the rest of the turn: four readers, then
   * nothing read it until the next send opened a stream ("the reply only
   * appears after I send another message"). While the server still owes this
   * transcript something — the turn is unfinished, or eve holds a message of
   * ours — a fresh round is armed after a backoff. Never for a revoked share
   * (403) or an expired sign-in (401): no retry can fix those, and a tab
   * return or a new sign-in re-arms them already.
   */
  const stillOwed =
    turnUnfinished(mergedEvents as readonly TurnEvent[]) || outstanding.length > 0 || reportsLaterOwed;
  const rearmable =
    attachVerdict.reason === "open-failed" && stillOwed && !authExpired && !attachRevoked.has(attachKey);
  /**
   * …with an END. About ten minutes of rounds (`ATTACH_MAX_ROUNDS`), never
   * while the tab is hidden (a tab return re-arms on its own), and then the
   * person gets a "Reconnect" control instead of a tab that polls for ever.
   */
  const [rearmRounds, setRearmRounds] = useState(() => attachRounds.get(attachKey) ?? 0);
  const reconnectOffered = rearmable && !attachRearmAllowed(rearmRounds, false);
  useEffect(() => {
    if (!rearmable) return;
    const round = attachRounds.get(attachKey) ?? 0;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    // A hidden tab still re-arms while the turn is running — the reply it shows must be current when the person
    // comes back (lib/chat-turn-state `attachRearmAllowed`).
    if (!attachRearmAllowed(round, hidden, stillOwed)) return;
    const timer = setTimeout(() => {
      attachRounds.set(attachKey, round + 1);
      setRearmRounds(round + 1);
      attachFailures.delete(attachKey);
      setAttachEpoch((n) => n + 1);
    }, attachRetryDelayMs(round));
    return () => clearTimeout(timer);
  }, [rearmable, attachKey, attachEpoch]);
  const reconnect = () => {
    attachRounds.delete(attachKey);
    setRearmRounds(0);
    attachFailures.delete(attachKey);
    setAttachEpoch((n) => n + 1);
  };
  /**
   * AN ACCEPTED ANSWER IS A FRESH START for the reader.
   *
   * The attach budget and the rearm rounds are keyed by turn, and a reply
   * resumed by an answer has no `turn.started` — so it inherited whatever the
   * turn had spent before the question. A turn whose specialist worked quietly
   * for a few minutes before asking had already climbed to one-minute rounds or
   * spent its budget outright ("open-failed": no reader at all), and the answer
   * then waited out that backoff before anything read the hand-back — the 80 s
   * and 279 s reattaches in the telemetry. Forgive both, and start a reader now
   * unless one is already on the stream.
   */
  const freshAttachAfterAnswer = () => {
    attachRounds.delete(attachKeyRef.current);
    setRearmRounds(0);
    attachFailures.delete(attachKeyRef.current);
    if (!attachLiveRef.current) setAttachEpoch((n) => n + 1);
  };
  freshAttachRef.current = freshAttachAfterAnswer;
  useEffect(() => {
    if (!shouldAttach || !attachId) return;
    const ctrl = new AbortController();
    const captured = attachId;
    const startIndex = nextIndexRef.current;
    const started = Date.now();
    let alive = true;
    setAttachLive(true);
    /**
     * ONE `attach-started` PER TURN, not one per effect re-run.
     *
     * The comparison this kind exists for is attach-started vs attach-complete:
     * the gap is meant to read as "how often a live tail could not finish the
     * job". Reported on every effect run it read as several failed tails
     * wherever it was really ONE tail restarting — and the restarts are
     * ordinary (an epoch bump, a tab return, eve re-emitting `turn.started` on
     * a replay), so the gap was measuring the restart rate, not the failure
     * rate. Restarts are still counted, in the detail, where they are honest.
     */
    const restarts = attachStarts.get(attachKey) ?? 0;
    attachStarts.set(attachKey, restarts + 1);
    if (restarts === 0) {
      report("attach-started", {
        sessionId: liveSessionIdRef.current ?? undefined,
        attempt: attachFailures.get(attachKey) ?? 0,
        detail: `from index ${startIndex} · ${attachVia ? "shared proxy" : "eve stream"}`,
      });
    }
    void readLiveTail({
      open: attachVia
        ? threadProxyStream({ threadId: attachVia, headers: getAuthHeaders })
        : eveSessionStream({ sessionId: captured, headers: getAuthHeaders }),
      startIndex,
      signal: ctrl.signal,
      // A specialist is working and the parent says nothing until it hands
      // back: a seam in that silence is the stream being healthy, not failing.
      quietExpected: () => specialistQuietRef.current,
      onEvent: (entry) => {
        // The transcript moved to another session while this reader was open (a
        // resync remount that re-minted the id, a fork, a new session after a
        // `session.completed`). Its events belong to a conversation that is no
        // longer on screen, and applying them would write one thread's reply
        // into another's.
        if (
          !attachDecision({
            sessionId: attachTargetRef.current,
            attachedTo: captured,
            storeBusy: false,
          }).attach
        ) {
          ctrl.abort();
          return;
        }
        // Placed BY INDEX, never appended blindly. A reader that restarted
        // mid-turn reopens BELOW the tail's last index to close a gap, and the
        // old "compare with the last entry" guard dropped every one of those
        // deliveries — which froze the transcript for the rest of the session
        // (see `appendTailEvent`). `mergeAttachedEvents` still holds the
        // authoritative rule; this keeps the tail orderly for it.
        collectedRef.current = appendTailEvent(collectedRef.current, entry);
        setAttachedTail((prev) => appendTailEvent(prev, entry));
      },
    })
      .then((result) => {
        if (alive) setAttachLive(false);
        if (result.outcome === "aborted") return;
        if (result.outcome === "terminal") {
          attachFailures.delete(attachKey);
          // A reader that read to a boundary proved the connection works: the
          // next quiet stretch of this turn starts from a 5 s round again, not
          // from wherever an earlier bad patch left the backoff (a resumed reply
          // has no `turn.started`, so it shares this key with the whole turn).
          attachRounds.delete(attachKey);
          if (alive) setRearmRounds(0);
          // A turn delivered AROUND the store (directDeliver) has now been seen
          // to settle, so the hold it placed can lift without a replay.
          if (alive) {
            setRemoteTurn(false);
            // A reader that read a turn to its end had a working credential.
            setAuthExpired(false);
          }
          report("attach-complete", {
            sessionId: liveSessionIdRef.current ?? undefined,
            elapsedMs: Date.now() - started,
            attempt: result.segments,
            detail: `${result.events} events · index ${startIndex}→${result.index}${
              restarts > 0 ? ` · reader restart ${restarts}` : ""
            }`,
          });
          handBackRef.current(captured);
          return;
        }
        // A revoked share can never come back; everything else gets the rest of
        // its budget and then the resync/replay watcher.
        if (!alive) return;
        if (result.outcome === "unauthorized") {
          // NOT the turn's fault and NOT a revoked share: the hour-long session
          // token expired under a long turn (auth-gate drops it 60s before
          // `exp`, after which `getAuthHeaders()` returns `{}`). Retrying spends
          // an ownership-gated read per attempt and can never succeed, and
          // "Still working…" is a lie — so stop the reader and say the one
          // thing that fixes it.
          attachFailures.set(attachKey, ATTACH_BUDGET);
          setAuthExpired(true);
        }
        const spent =
          result.outcome === "forbidden" || result.outcome === "unauthorized"
            ? ATTACH_BUDGET
            : (attachFailures.get(attachKey) ?? 0) + 1;
        attachFailures.set(attachKey, spent);
        // A revoked share is FINAL. Remembered outside the budget, because the
        // budget is forgiven on a tab return — and re-probing a revoked share on
        // every focus is the small denial-of-service against our own membership
        // gate that this module says it is avoiding.
        if (result.outcome === "forbidden") attachRevoked.add(attachKey);
        report("attach-failed", {
          sessionId: liveSessionIdRef.current ?? undefined,
          elapsedMs: Date.now() - started,
          attempt: spent,
          detail: `${result.outcome} · ${result.events} events · ${result.detail ?? "no detail"}${
            restarts > 0 ? ` · reader restart ${restarts}` : ""
          }`,
        });
        setAttachEpoch((n) => n + 1);
      })
      .catch(() => {
        // readLiveTail never rejects; this is belt-and-braces so a future throw
        // cannot leave `attachLive` stuck true and the poll disarmed.
        if (alive) setAttachLive(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
      setAttachLive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAttach, attachId, attachVia, attachKey, attachEpoch]);

  /**
   * A NEW TURN retires everything recorded about the old ones.
   *
   * The collected tail belongs to the turn it was read from — carrying it into
   * the next one would re-project a finished reply over a running one — and the
   * module-scope maps keyed `chatKey:turn` are otherwise never pruned, which is
   * a slow leak in a tab left open on a long conversation.
   */
  useEffect(() => {
    forgetFinishedTurns(chatKey, startedTurns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, startedTurns]);
  useEffect(
    () => () => {
      collectedRef.current = [];
    },
    [],
  );

  /**
   * A TAB COMING BACK is a fresh chance, not a spent budget.
   *
   * A backgrounded tab is exactly where this defect is most often met: the
   * browser suspends or drops the socket, the reader burns its reopens against
   * a connection that cannot work, and the turn is handed to the poll while
   * nobody is looking. On return the conditions are completely different, so the
   * failure count for this turn is forgiven once and a reader is re-armed —
   * never while one is already attached, which would abort a healthy read to
   * start the same read again.
   */
  const attachLiveRef = useRef(false);
  attachLiveRef.current = attachLive;
  /**
   * …AND THE STORE'S OWN READER. While this tab's send is streaming, the reader is eve's store's, not ours, and it
   * cannot be reopened in place. If it came back from the background delivering nothing while the session has
   * moved past what is on screen, its socket died in the sleep: detach it locally (`agent.stop()` aborts only the
   * local read — the turn keeps running) and the attach reader resumes at the transcript's index, the same path a
   * severed stream takes. A reader that delivers anything in the first second is left alone.
   */
  const storeResyncRef = useRef<() => void>(() => {});
  storeResyncRef.current = () => {
    const sid = liveSessionIdRef.current;
    if (!sid || !(agent.status === "submitted" || agent.status === "streaming")) return;
    const before = nextIndexRef.current;
    window.setTimeout(async () => {
      if (nextIndexRef.current !== before || liveSessionIdRef.current !== sid) return;
      const moved = await streamHasMoved(eveSessionStream({ sessionId: sid, headers: getAuthHeaders }), before);
      if (!moved || nextIndexRef.current !== before || liveSessionIdRef.current !== sid) return;
      if (!(agentStatusRef.current === "submitted" || agentStatusRef.current === "streaming")) return;
      report("resync", { sessionId: sid, detail: "store reader silent after the tab slept" });
      agent.stop();
    }, 1_000);
  };
  const agentStatusRef = useRef(agent.status);
  agentStatusRef.current = agent.status;
  const attachKeyRef = useRef(attachKey);
  attachKeyRef.current = attachKey;
  useEffect(() => {
    if (typeof document === "undefined") return;
    /**
     * A fresh chance for a turn whose conditions changed — but NOT for a turn
     * whose share is gone.
     *
     * This used to clear `attachFailures` unconditionally, so a genuinely
     * revoked share (403) re-opened the membership-gated stream on every single
     * tab focus, forever: the exact self-inflicted load lib/chat-attach.ts stops
     * the reader to avoid. A revocation is terminal and is remembered outside
     * the budget; everything else — a suspended socket, a cold gate, an expired
     * credential the person has since renewed — is forgiven.
     */
    const rearm = () => {
      if (attachLiveRef.current || attachRevoked.has(attachKeyRef.current)) return;
      attachFailures.delete(attachKeyRef.current);
      // Signing in again happens in another tab or through the gate above this
      // component, and neither tells the chat. A tab return is the moment to
      // find out: clear the claim and let the next reader re-establish it.
      setAuthExpired(false);
      setAttachEpoch((n) => n + 1);
    };
    /**
     * BACK FROM THE BACKGROUND: resync at once. A hidden tab's timers are throttled (Chrome: once a minute after
     * five minutes) and a frozen or back/forward-cached page runs nothing at all, so a reader that looks attached
     * may be sitting on a socket that died while it slept. After a real absence the reader is reopened at the
     * transcript's own index — the same motion as the ~120s seam — instead of waiting out its 150 s silence
     * watchdog. A blink (under two seconds) keeps a healthy reader as it is.
     */
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;
    const resync = () => {
      storeResyncRef.current();
      attachFailures.delete(attachKeyRef.current);
      if (attachRevoked.has(attachKeyRef.current)) return;
      setAuthExpired(false);
      setAttachEpoch((n) => n + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away >= 2_000) resync();
      else rearm();
    };
    const onResume = () => resync();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) resync();
    };
    document.addEventListener("resume", onResume);
    window.addEventListener("pageshow", onPageShow);
    /**
     * AND THE NETWORK COMING BACK.
     *
     * Only `visibilitychange` re-armed the reader, so a laptop that goes offline
     * with the tab in front burns all four attach attempts in under a minute
     * against a connection that cannot work, hands the turn to the poll (which
     * cannot reach the network either) and then nothing at all re-arms when the
     * network returns — the tab was never hidden, so no visibility event ever
     * fires. `online` is the event for exactly that, and it costs one listener.
     */
    window.addEventListener("online", rearm);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", rearm);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  /**
   * A turn that has gone QUIET, counted.
   *
   * `stream-gave-up` above only fires when `agent.status === "ready"`, so a turn
   * that dies while the store still believes it is `streaming` (or `submitted`,
   * or `error`) has always recorded nothing at all. This one is judged from the
   * transcript alone: an unfinished turn with no new event for 90 seconds, filed
   * once per turn whatever the store thinks. It changes nothing on screen — one
   * long tool call can legitimately be silent — it exists so that next week has
   * a number in it instead of silence.
   */
  useEffect(() => {
    if (!turnUnfinished(mergedEvents as readonly TurnEvent[])) return;
    const key = `${chatKey}:${startedTurns}`;
    if ((stallsReported.get(key) ?? 0) > 0) return;
    const timer = setTimeout(() => {
      stallsReported.set(key, 1);
      report("stall", {
        sessionId: liveSessionIdRef.current ?? undefined,
        elapsedMs: STALL_MS,
        detail: `${agent.status} · ${attachLive ? "reader attached" : "no reader"} · ${
          mergedEvents.length
        } events · last ${lastEventType ?? "none"}`,
      });
    }, STALL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedEvents.length, startedTurns, chatKey, agent.status, attachLive, lastEventType]);

  /** What the next message will tell the model — shown beside the toggles, once. */
  const settingLabels = activeSettingLabels({
    webSearch,
    browserUse,
    mode,
    customers: selectedCustomers,
  });
  /**
   * STOPPED REPLIES — said under the reply, in EVERY tab, and by whom, where it
   * stays in the conversation's history (see `stoppedTurnNotes`). eve's
   * `turn.cancelled` alone left a half reply with nothing under it, and a Stop
   * pressed in one tab ended a turn the other tab was watching in silence.
   */
  const stoppedNotes = useMemo(
    () =>
      stoppedTurnNotes(
        [...(mergedEvents as readonly TurnEvent[]), ...stoppedMarkers],
        stoppedHere.get(stopStateKey) ?? new Set(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedEvents.length, stoppedMarkers, stopStateKey],
  );
  /** message id → the "Stopped." note said under it (see `stoppedNoteHosts`). */
  const stoppedNoteAt = useMemo(
    () => stoppedNoteHosts(viewMessages, stoppedNotes, (m) => messageRendersContent(m, true, isProxiedChildApproval)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMessages, stoppedNotes],
  );
  // A stopped turn with NO message on screen (eve has not numbered it yet) has
  // nowhere to put its note: say it above the composer instead, until the next
  // turn. Every other stopped turn says it in place, in the history.
  const cancelledNote = useMemo(() => {
    for (let i = mergedEvents.length - 1; i >= 0; i--) {
      const e = mergedEvents[i] as { type?: string; data?: { turnId?: string } };
      if (e.type === "turn.started" || e.type === "turn.completed") return null;
      if (e.type === "turn.cancelled") {
        const id = e.data?.turnId ?? "";
        // Only a reply with something ON SCREEN can carry the note under it.
        const shown = viewMessages.some(
          (m) =>
            m.role === "assistant" &&
            m.metadata?.turnId === id &&
            (m.parts ?? []).some((p) => {
              const part = p as { type?: string; text?: string };
              return part.type === "dynamic-tool" || (part.type === "text" && Boolean(part.text?.trim()));
            }),
        );
        const hosted = viewMessages.some((m) => m.metadata?.turnId === id && stoppedNoteAt.has(m.id));
        return shown || hosted ? null : (stoppedNotes.get(id) ?? null);
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedEvents.length, viewMessages, stoppedNotes, stoppedNoteAt]);
  /** A way out of a hold that feels stuck — see `stopAvailable`. */
  // The question on screen is a delegated specialist's (it cannot be dismissed).
  const specialistWaiting =
    gate.reason === "awaiting-input" && liveDelegations(mergedEvents as readonly TurnEvent[]).length > 0;
  const showStop = stopAvailable({
    gate,
    storeBusy: isBusy,
    readOnly,
    queued: queue.pending.length,
    specialistWaiting,
  });
  const removeQueued = (q: QueueEntry) => {
    queuedFiles.delete(q.id);
    void queue.remove(q.id);
  };

  // Regenerate: re-send the most recent user message (appends a fresh turn).
  const retryLast = () => {
    if (gate.hold) return;
    const msgs = viewMessages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const text = (msgs[i].parts ?? [])
        .map((p) => {
          const part = p as { type?: string; text?: string };
          return part.type === "text" ? (part.text ?? "") : "";
        })
        .join("")
        .trim();
      // Re-sent EXACTLY as it was sent: nothing is stripped from what goes to
      // the model (a display rule must never be able to damage a message).
      if (text) void agent.send({ message: text });
      return;
    }
  };

  // Live starter cards for the empty state (see useStarterCards).
  const starterCards = useStarterCards(isEmpty, getAuthHeaders);

  const pickSuggestion = (prompt: string, customer?: string) => {
    if (gate.hold) return;
    // Map the card's customer as this chat's context (state updates async, so
    // inject it into the message directly rather than relying on selectedCustomers).
    const custs = customer ? [customer] : selectedCustomers;
    if (customer) onCustomersChange([customer]);
    const directives: string[] = [];
    if (custs.length > 0) {
      directives.push(`(Context: this conversation is about ${custs.join(", ")}.)`);
    }
    for (const d of [searchDirective(webSearch), browserDirective(browserUse), modeDirective(mode)]) {
      if (d) directives.push(d);
    }
    // Wrapped like every other message (see `withDirectives`): the bare form is
    // what put "(Context: …) (Web search is off …)" into chat titles.
    const text = directives.length > 0 ? `${wrapDirectives(directives)}\n\n${prompt}` : prompt;
    agent.send({ message: text });
  };

  return (
    <div
      className="flex h-dvh min-w-0 flex-1 overflow-hidden"
      onClickCapture={(e) => {
        // A click on an office-artifact link (xlsx/docx/…) opens the in-app
        // preview instead of downloading — anywhere in the chat or rail.
        const anchor = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor) return;
        // The viewer's own "Open original" / Download links point at the very
        // file being previewed; they must leave the app, not reopen the preview.
        if (anchor.hasAttribute("data-open-original") || anchor.hasAttribute("download")) return;
        const art = artifactFromHref(anchor.getAttribute("href") ?? anchor.href);
        if (art) {
          e.preventDefault();
          e.stopPropagation();
          setPreviewArtifact(art);
        }
      }}
    >
      <main
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
        onDragEnterCapture={onDragEnterFiles}
        onDragOverCapture={onDragOverFiles}
        onDragLeaveCapture={onDragLeaveFiles}
        onDropCapture={onDropFiles}
        onPasteCapture={onPasteFiles}
      >
      {dragging ? (
        <div
          className="pointer-events-none absolute inset-2 z-30 flex items-end justify-center rounded-2xl bg-primary/5 pb-8 ring-2 ring-primary/40"
          data-testid="chat-drop-affordance"
        >
          <span className="rounded-full border border-border bg-background px-3 py-1 font-medium text-foreground text-xs shadow-sm">
            Drop to attach
          </span>
        </div>
      ) : null}
      {/* Catches a render loop (#185) anywhere in the chat body — header,
          composer, or the transcript's own inner boundary — BEFORE it reaches
          the eve store's synchronous re-render (where it is swallowed as
          agent.error and nukes the turn). componentDidCatch logs the component
          stack the minified store error can't carry. */}
      <ErrorBoundary label="Chat body" resetKeys={[sessionId]}>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-3">
        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Open sidebar"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {sharedThreadId ? <PresenceStack online={presence.online} /> : null}
          {canShare ? <ShareThreadButton getPayload={getSharePayload} /> : null}
          <CustomerSelect
            selected={selectedCustomers}
            inferred={inferredCustomers}
            customers={customers}
            status={customersStatus}
            onRetry={onRetryCustomers}
            onChange={onCustomersChange}
            locked={!isEmpty}
          />
          {!isEmpty && !cockpitOpen ? (
            <button
              type="button"
              onClick={() => setCockpitOpen(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Open control panel"
              title="Open control panel"
            >
              <PanelRightIcon className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      {/* A render loop is not a failed request. The store records it as
          `agent.error` because React threw at its own setState call site (see
          onError), and telling the reader their request failed is both alarming
          and wrong — the turn is still running, and the detached-turn watcher
          pulls the rest of it in. */}
      {agent.error && !renderLoop ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 sm:px-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Request failed</p>
              <p className="mt-0.5 text-muted-foreground">{agent.error.message}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isEmpty ? null : (
        // The transcript is wrapped so a render loop (e.g. a "Maximum update
        // depth" #185) is caught HERE by React instead of propagating into the
        // eve store's synchronous useSyncExternalStore re-render — where it would
        // be recorded as agent.error and nuke the whole (still-live) turn. The
        // boundary also logs the component stack, which the minified store error
        // never carries, so the exact looping component can be pinned.
        <ErrorBoundary
          label="Transcript"
          // Recover automatically when the turn advances or the thread changes:
          // a transient throw (a mid-stream break, a subagent stopping) then
          // heals on the next event instead of wedging the whole transcript
          // behind the error card. status flips on turn end; the counts move as
          // events/messages arrive; sessionId changes on a thread switch.
          resetKeys={[sessionId, agent.status, mergedEvents.length, viewMessages.length]}
        >
          {/* The turn as the transcript sees it: what the end-of-answer row is
              decided on (`answerOver`) and how far into the stream this view has
              read. A finer signal than text growth for anything sampling the
              page (scripts/rig-end-of-answer.mjs; mold_v1-111). */}
          <Conversation
            className="min-h-0 flex-1"
            data-turn={answerOver ? "finished" : "running"}
            data-stream-index={absoluteIndex(mergedEvents as readonly TurnEvent[])}
          >
            <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
            {autoBadge ? (
              autoBadge.kind === "cron" || (autoBadge.ts && !autoBadge.kind) ? (
                <div className="mx-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/5 px-3 py-1 text-amber-700 text-xs dark:text-amber-400">
                  <ClockIcon className="size-3.5 shrink-0" />
                  <span>
                    Auto-triggered{autoBadge.ts ? ` ${new Date(autoBadge.ts).toLocaleString()}` : ""} · via{" "}
                    <span className="font-medium">{autoBadge.via}</span>
                  </span>
                </div>
              ) : (
                <div className="mx-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-muted-foreground text-xs">
                  <ClockIcon className="size-3.5 shrink-0" />
                  <span>
                    {autoBadge.kind === "app" ? "App refresh" : "Workflow run"} ·{" "}
                    <span className="font-medium text-foreground">{autoBadge.via}</span>
                    {autoBadge.ts ? ` · ${new Date(autoBadge.ts).toLocaleString()}` : ""}
                  </span>
                </div>
              )
            ) : null}
            {forkedFrom ? (
              <button
                type="button"
                onClick={() => onOpenThread?.(forkedFrom.id)}
                className="mx-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                title={`Back to: ${displayTitle(forkedFrom.title, "Original chat")}`}
              >
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="shrink-0">Forked from</span>
                <span className="truncate font-medium text-foreground">{displayTitle(forkedFrom.title, "Original chat")}</span>
              </button>
            ) : null}
            {viewMessages.map((message, index) => {
              // The compaction instruction is sent as a user turn under the hood —
              // hide it so only the divider + checkpoint summary read cleanly.
              if (
                message.role === "user" &&
                (message.parts ?? []).some(
                  (p) => (p as { type?: string; text?: string }).type === "text" &&
                    (p as { text?: string }).text === COMPACT_INSTRUCTION,
                )
              ) {
                return null;
              }
              // A stopped specialist's automatic hand-back is a user-role message the SYSTEM sent
              // (lib/handback-text.ts): a note, never a bubble from the person.
              if (isHandbackTranscriptMessage(message)) {
                return <HandbackNote key={message.id} text={messageText(message)} />;
              }
              // Auto-compaction divider: at the START of a turn eve compacted
              // before (its turnId is in `autoCompactedTurns`), the first time
              // that turn appears in the flow.
              const turnId = message.metadata?.turnId;
              const prevTurnId = index > 0 ? viewMessages[index - 1]?.metadata?.turnId : undefined;
              const showAutoDivider = Boolean(turnId && turnId !== prevTurnId && autoCompactedTurns.has(turnId));
              return (
                <Fragment key={message.id}>
                  {showAutoDivider ? <CompactionDivider kind="auto" /> : null}
                  <AgentMessage
                    canRespond={!isBusy && !readOnly}
                    hoistPendingInput
                    isProxiedApproval={isProxiedChildApproval}
                    isLast={index === viewMessages.length - 1}
                    isStreaming={liveStreaming && index === viewMessages.length - 1}
                    message={message}
                    stoppedDelegations={stopped.delegations}
                    stoppedNote={stoppedNoteAt.get(message.id)}
                    onFocusSubagent={(toolCallId) => {
                      setCockpitOpen(true);
                      setFocusSubagent(toolCallId);
                    }}
                    onInputResponses={respondToInput}
                    // NOT `isBusy`: the store goes idle on every detached
                    // stretch of a live turn. See `answerOver` above.
                    turnActive={!answerOver}
                    onRetry={
                      answerOver &&
                      message.role === "assistant" &&
                      index === viewMessages.length - 1
                        ? retryLast
                        : undefined
                    }
                  />
                </Fragment>
              );
            })}
            {/* Manual compaction (the context ring's click): a "Compacting
                context…" loader while the checkpoint summary streams, then a
                "Context manually compacted" divider. */}
            {compacting ? <CompactionDivider kind={compacting === "compacting" ? "compacting" : "manual"} /> : null}
            {/* Relay optimistic bubble: a participant's just-sent message + a
                working indicator, shown until the turn parks and the shell
                refreshes the transcript from the replayed stream. */}
            {relayPending ? (
              <div className="flex flex-col gap-3">
                <div className="ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm">
                  {relayPending}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Spinner className="size-3.5" />
                  Sending to the shared thread…
                </div>
              </div>
            ) : null}
            {relayError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span className="text-muted-foreground">{relayError}</span>
              </div>
            ) : null}
            {pendingInputParts.length > 0 ? (
              <div className="flex flex-col">
                {pendingInputParts.map((p) => {
                  const requestId = (
                    p.toolMetadata?.eve?.inputRequest as { requestId?: string } | undefined
                  )?.requestId;
                  // A specialist's question whose delegation has settled was answered
                  // (here, in another tab, or in the Control Panel): the tile says how
                  // it ended. It is not an "expired approval".
                  if (requestId && deadRequests.has(requestId) && proxiedRequestIds.has(requestId)) return null;
                  // Stopped: the specialist's tile already says so, in place — a second
                  // copy hoisted below later replies would read as a new event.
                  if (requestId && stopped.requestIds.has(requestId) && proxiedRequestIds.has(requestId)) return null;
                  return (
                    <PendingApprovalCard
                      key={p.toolCallId}
                      // A dead request reads exactly like an expired one: the run
                      // that asked has stopped, so the card is a note, not a prompt.
                      expired={Boolean(
                        requestId && (expiredRequestIds.has(requestId) || deadRequests.has(requestId)),
                      )}
                      part={p}
                      stoppedName={requestId ? stopped.requestNames.get(requestId) : undefined}
                      onInputResponses={respondToInput}
                      // No Dismiss on a live specialist's question: it cannot be
                      // waved away (see `effectiveDismissals`) — answer it, or Stop.
                      onDismiss={
                        requestId &&
                        effectiveDismissals(new Set([requestId]), mergedEvents as readonly TurnEvent[]).size > 0
                          ? () => dismissInput(requestId)
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            ) : null}
            {/* The "A subagent needs your approval — open the Control Panel to
                respond" banner that used to sit here is gone. It was gated on
                `isBusy`, which goes false the moment eve emits the parent's turn
                epilogue for a parked child (turn.completed → session.waiting is
                the PARK, not the end) — so it disappeared exactly when the child
                was waiting, and while it showed it only pointed somewhere else.
                The child's request is now an answerable card in
                `pendingInputParts` above, which also holds the send gate, so
                typed text becomes the answer instead of vanishing. */}
            {shownHandoffs.map((h) => (
              <div
                key={h.callId}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
              >
                <p className="text-sm">
                  <span className="font-medium">{h.name} subagent</span> finished and nothing else is
                  running, but its result didn't reach the chat.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => bringResult(h)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs hover:bg-primary/90"
                  >
                    <ArrowRightIcon className="size-3.5" />
                    Bring result into chat
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setHandledHandoffs((prev) => withRequestIds(prev, [h.callId]))
                    }
                    className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
            {showWorking ? (
              // The hosted relay only flushes tool parts at step boundaries, so
              // while a call executes there is nothing new to render — this strip
              // is the "something is happening" affordance in that gap. Hidden
              // when text is actively streaming (the caret covers that) and when
              // the turn is parked waiting on the user.
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Spinner className="size-3.5" />
                Working…
              </div>
            ) : null}
          </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </ErrorBoundary>
      )}

      {/* Shared thread: someone else holds the in-flight turn. */}
      {sharedThreadId && presence.turnHolder && !relayPending ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2 sm:px-6">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-amber-600 text-xs dark:text-amber-400">
            <Spinner className="size-3" />
            {presence.turnHolder.split("@")[0]} is responding…
          </span>
        </div>
      ) : null}

      {readOnly ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 sm:px-6">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
            <EyeIcon className="size-4 shrink-0" />
            <span>
              View-only — ask {readOnlyOwner ? <span className="font-medium text-foreground">{readOnlyOwner}</span> : "the owner"} for participant access to reply.
            </span>
          </div>
        </div>
      ) : (
      <div
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          isEmpty
            ? "flex max-w-3xl flex-1 flex-col items-center justify-center gap-3 pb-[12vh]"
            : "max-w-3xl shrink-0 pb-5",
        )}
      >
        {isEmpty ? <RotatingHero /> : null}
        <div className="w-full">
          {goalRun ? (
            (() => {
              const done = goalRun.outcome;
              const complete = done?.status === "complete";
              const blocked = done?.status === "blocked";
              const Icon = complete
                ? CheckCircle2Icon
                : blocked
                  ? CircleAlertIcon
                  : goalRun.kind === "loop"
                    ? RepeatIcon
                    : TargetIcon;
              const tone = complete
                ? "border-emerald-500/30 bg-emerald-500/5"
                : blocked
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-primary/30 bg-primary/5";
              const iconTone = complete
                ? "text-emerald-500"
                : blocked
                  ? "text-amber-500"
                  : "text-primary";
              const label = complete
                ? `${goalRun.kind === "loop" ? "Loop" : "Goal"} complete`
                : blocked
                  ? `${goalRun.kind === "loop" ? "Loop" : "Goal"} blocked`
                  : goalRun.kind === "loop"
                    ? "Looping"
                    : "Pursuing goal";
              return (
                <div className={cn("mb-2 rounded-xl border px-3 py-2.5", tone)}>
                  <div className="flex items-center gap-2">
                    <Icon className={cn("size-4 shrink-0", iconTone, !done && isBusy && "animate-pulse")} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-xs">{label}</p>
                      <p className="truncate text-muted-foreground text-xs" title={goalRun.objective}>
                        {goalRun.objective}
                      </p>
                    </div>
                    {done ? (
                      <button
                        type="button"
                        onClick={() => setGoalRun(null)}
                        aria-label="Dismiss"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={requestGoalStop}
                        disabled={goalStopping}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-60"
                      >
                        <XIcon className="size-3.5" />
                        {goalStopping ? "Stopping…" : "Stop"}
                      </button>
                    )}
                  </div>
                  {done ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-foreground/90 text-xs">
                      {done.summary}
                      {blocked && done.remaining ? `\n\nBlocked on: ${done.remaining}` : ""}
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : null}
          {planReady ? (
            <div className="mb-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm">
                  How do you want to proceed?
                </p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={implementPlan}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs hover:bg-primary/90"
                >
                  <HammerIcon className="size-3.5" />
                  Implement plan
                </button>
                <button
                  type="button"
                  onClick={continuePlanning}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted"
                >
                  <ListTodoIcon className="size-3.5" />
                  Keep planning
                </button>
                <button
                  type="button"
                  onClick={forkPlan}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted"
                  title="Start a fresh thread seeded with this plan and implement it there"
                >
                  <GitBranchIcon className="size-3.5" />
                  Fork to new thread
                </button>
              </div>
            </div>
          ) : null}
          {/* A turn is still alive with nothing local listening to it — or eve
              is still holding a message of ours, or a question is holding
              messages the person is trying to send. Say so, and offer the one
              honest way out, which is stopping THAT turn (see `stopAvailable`). */}
          {cancelledNote && !stopNote ? (
            <p data-cancelled-note role="status" className="mb-2 px-1 text-muted-foreground text-xs">
              {cancelledNote}
            </p>
          ) : null}
          {/* eve's own rule: while a question is open, free text ANSWERS it. Said
              plainly, so a message meant as a new request is not a surprise. */}
          {gate.reason === "awaiting-input" &&
          !readOnly &&
          openInputRequests.some((r) => (r as { allowFreeform?: boolean }).allowFreeform !== false) ? (
            <p data-answer-hint className="mb-1.5 px-1 text-muted-foreground text-xs">
              Your next message will answer the question above.
            </p>
          ) : null}
          {answerChecking && !showStop ? (
            <p data-answer-checking role="status" className="mb-2 px-1 text-muted-foreground text-xs">
              {ANSWER_CHECKING_LINE}
            </p>
          ) : null}
          {answerError ? (
            <div
              role="alert"
              data-answer-error
              className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-400"
            >
              <span className="flex-1">{answerError.message}</span>
              {answerError.label ? (
                <button
                  type="button"
                  data-answer-retry
                  onClick={() => void respondToInput(answerError.responses)}
                  className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                >
                  Send “{answerError.label.length > 40 ? `${answerError.label.slice(0, 40)}…` : answerError.label}” again
                </button>
              ) : null}
              <button type="button" onClick={() => setAnswerError(null)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-amber-500/20">
                Dismiss
              </button>
            </div>
          ) : null}
          {stopNote ? (
            <div
              role="status"
              data-stop-note
              className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
            >
              <span className="flex-1">{stopNote}</span>
              <button type="button" onClick={() => setStopNote(null)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-muted">
                Dismiss
              </button>
            </div>
          ) : null}
          {reconnectOffered && !readOnly ? (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
            >
              <span className="flex-1">
                Stopped trying to reach the rest of this reply after ten minutes. Reconnect to look again.
              </span>
              <button
                type="button"
                onClick={reconnect}
                className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
              >
                Reconnect
              </button>
            </div>
          ) : null}
          {showStop ? (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
            >
              <Spinner className="size-3 shrink-0" />
              <span className="flex-1">
                {authExpired
                  ? // A 401, not a slow turn. Every path that could show the rest
                    // of this reply is locked out until the person signs in
                    // again, so say that instead of "still working".
                    "Your sign-in expired while this reply was running. Sign in again to pick it up — nothing is lost."
                  : stopping
                  ? "Stopping the earlier reply…"
                  : answerChecking
                  ? // Not yet known whether the answer landed, so not yet known
                    // whether anything is running because of it: say what IS
                    // happening, not "a specialist is working" (review of #59).
                    ANSWER_CHECKING_LINE
                  : gate.reason === "awaiting-input"
                    ? specialistWaiting
                      ? "A specialist is waiting on your answer above. Answer it, or stop it — its work is discarded and your queued messages send."
                      : "Waiting for your answer above. Answer it, or stop this reply to send your queued messages."
                  : gate.reason === "delivering"
                    ? owedFromOtherTab
                      ? "Your earlier message is queued and will be sent after this reply. Stop releases it after a minute."
                      : "Your earlier message is waiting its turn on the server — its reply will appear here."
                  : specialistRunning || workingSpecialists.length > 0
                    ? specialistWorkingLine(
                        workingSpecialists.filter((d) => !d.detached && !heldHandoffs.some((h) => h.callId === d.callId)).map((d) => d.name),
                        workingSpecialists.filter((d) => !d.detached && heldHandoffs.some((h) => h.callId === d.callId)).map((d) => d.name),
                        workingSpecialists.filter((d) => d.detached).map((d) => d.name),
                      )
                    : attachLive
                      ? // A reader IS on the live stream: the words have to match
                        // what the screen is doing, or the one state where the
                        // reply is visibly arriving still reads as a dead wait.
                        "Still working — the rest of the earlier reply is arriving now."
                      : "Still working — the earlier reply is continuing on the server and will appear here when it finishes."}
              </span>
              <button
                type="button"
                onClick={stopTurn}
                disabled={stopping}
                className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Stop it
              </button>
            </div>
          ) : null}
          {queued.length > 0 ? (
            <div className="mb-2 flex flex-col gap-1" data-queue>
              <p className="px-1 text-3xs text-muted-foreground" aria-live="polite">
                {queue.pending.length === 0
                  ? "Not sent."
                  : gate.reason === "delivering" && owedFromOtherTab
                    ? "Your earlier message is queued and will be sent after this reply."
                    : gate.hold
                      ? `${holdLabel(gate.reason, specialistRunning, attachLive, authExpired, answerChecking)}${queue.background ? " They are sent even if you close this tab." : ""}`
                      : "Queued — sending next."}
              </p>
              {queued.map((q, i) => {
                const failed = q.state === "failed";
                const expired = q.state === "expired" || failed;
                const sending = q.state === "sending";
                /** Files the closed tab never finished uploading: said here, and the item waits for the person. */
                const uploadLost = !expired && q.filesPending > 0 && q.busy !== "uploading" && q.busy !== "saving";
                return (
                <div key={q.id} className="rounded-lg border border-border/60 bg-muted/40 px-1.5 py-1" data-queue-item={q.state}>
                <div className="flex items-center gap-1">
                  <span className="w-4 shrink-0 text-center text-3xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <input
                    value={q.text}
                    onChange={(e) => queue.edit(q.id, e.target.value)}
                    readOnly={expired || sending}
                    placeholder={q.files > 0 ? `${q.files} file(s)` : "empty"}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                  />
                  <button
                    type="button"
                    onClick={() => queue.move(q.id, -1)}
                    disabled={i === 0 || expired || sending}
                    aria-label="Move up"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUpIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => queue.move(q.id, 1)}
                    disabled={i === queued.length - 1 || expired || sending}
                    aria-label="Move down"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQueued(q)}
                    disabled={sending}
                    aria-label="Remove"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
                {expired ? (
                  <p data-queue-note className="flex items-center gap-2 px-5 pt-0.5 text-3xs text-amber-700 dark:text-amber-400">
                    <span className="flex-1">
                      {failed
                        ? "Didn't send — we couldn't confirm it reached the chat."
                        : "Not sent — it waited more than a day, so it was held back."}
                    </span>
                    <button
                      type="button"
                      onClick={() => queue.requeue(q.id)}
                      className="shrink-0 rounded px-1 font-medium hover:bg-amber-500/10"
                    >
                      {failed ? "Send again" : "Send now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQueued(q)}
                      className="shrink-0 rounded px-1 font-medium hover:bg-amber-500/10"
                    >
                      Discard
                    </button>
                  </p>
                ) : sending ? (
                  <p data-queue-note className="px-5 pt-0.5 text-3xs text-muted-foreground">Sending…</p>
                ) : q.busy === "uploading" ? (
                  <p data-queue-note className="px-5 pt-0.5 text-3xs text-muted-foreground">
                    Uploading {q.files === 1 ? "the attachment" : `${q.files} attachments`} — keep this tab open until it finishes.
                  </p>
                ) : uploadLost ? (
                  <p data-queue-note className="flex items-center gap-2 px-5 pt-0.5 text-3xs text-amber-700 dark:text-amber-400">
                    <span className="flex-1">
                      {q.filesPending === 1 ? "An attachment was" : `${q.filesPending} attachments were`} still uploading
                      when the tab closed, so {q.filesPending === 1 ? "it was" : "they were"} lost — re-attach, or send
                      without {q.filesPending === 1 ? "it" : "them"}.
                    </span>
                    {q.text.trim() ? (
                      <button
                        type="button"
                        onClick={() => queue.sendWithout(q.id)}
                        className="shrink-0 rounded px-1 font-medium hover:bg-amber-500/10"
                      >
                        Send without it
                      </button>
                    ) : null}
                  </p>
                ) : q.where === "local" && q.files > 0 && !queuedFiles.has(q.id) ? (
                  <p data-queue-note className="flex items-center gap-2 px-5 pt-0.5 text-3xs text-amber-700 dark:text-amber-400">
                    <span className="flex-1">
                      {q.files === 1 ? "Attachment" : `${q.files} attachments`} not kept after reload — re-attach it, or send
                      without it.
                    </span>
                    {q.text.trim() ? (
                      <button
                        type="button"
                        onClick={() => queue.sendWithout(q.id)}
                        className="shrink-0 rounded px-1 font-medium hover:bg-amber-500/10"
                      >
                        Send without it
                      </button>
                    ) : null}
                  </p>
                ) : q.note ? (
                  <p data-queue-note className="px-5 pt-0.5 text-3xs text-muted-foreground">{q.note}</p>
                ) : null}
                </div>
                );
              })}
            </div>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
            aria-hidden="true"
          />
          {/* Above the composer: where the eye already is when a reply stops. */}
          {/* Held answers. Without this the click looks ignored: the card marks
              itself answered, nothing is sent, and the agent sits silent until
              the last sibling is answered. */}
          {uploading > 0 && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
              <Spinner className="size-3" />
              <span>
                Saving {uploading === 1 ? "your attachment" : `${uploading} attachments`} to the data
                room…
              </span>
            </div>
          )}
          {awaitingSiblings > 0 && !streamError && (
            <div className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
              Answer saved. Waiting for {awaitingSiblings} more{" "}
              {awaitingSiblings === 1 ? "question" : "questions"} — they are sent together so the
              replies don&apos;t overlap.
            </div>
          )}
          {streamError && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <span className="flex-1">
                {/* Two different failures wore the same sentence.
                    A DROPPED stream really does leave the turn running, and
                    "the agent kept going" is true. A FAILED turn is over, and
                    saying the rest is still there sends someone to wait for an
                    answer that is never coming — which is what the sandbox
                    outage looked like on screen. Tell them apart. */}
                {/fail|not provisioned|Sandbox template|stopped retrying/i.test(streamError ?? "")
                  ? streamError
                  : `The reply was cut off — ${streamError} The agent kept going, so the rest of it is still there.`}
              </span>
              {/* No "Continue" button here on purpose.
                  One existed and it was a lie: it called onReattach, which
                  remounts the chat with its cursor — and the eve store opens a
                  stream only from send(), never on mount, so the remount
                  re-rendered the same events and fetched nothing. Reloading the
                  thread genuinely re-reads the session from eve; a button that
                  claims to recover the reply and does nothing is worse than
                  none. Re-open the chat to pull the full transcript. */}
              <button
                type="button"
                onClick={() => setStreamError(null)}
                className="shrink-0 rounded px-1.5 py-0.5 hover:bg-amber-500/20"
              >
                Dismiss
              </button>
            </div>
          )}
          <ChatComposer
            onStop={stopTurn}
            onSubmit={handleSubmit}
            placeholder="Send a message…"
            status={agent.status}
            submitAccessory={
              contextUsage.total > 0 ? (
                <ContextRing
                  tokens={contextUsage.total}
                  windowSize={CONTEXT_WINDOW}
                  breakdown={{ cached: contextUsage.cached, fresh: contextUsage.fresh }}
                  onCompact={handleCompact}
                  busy={isBusy}
                />
              ) : undefined
            }
            header={
              files.length > 0
                ? files.map((f) => (
                    <span
                      key={f.id}
                      className="flex max-w-[12rem] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
                    >
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label="Remove attachment"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  ))
                : undefined
            }
            tools={
              <>
                <PromptInputButton
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label="Attach files"
                >
                  <PaperclipIcon className="size-4" />
                </PromptInputButton>
                <PromptInputButton
                  type="button"
                  onClick={() => setWebSearch((v) => !v)}
                  aria-pressed={webSearch}
                  title={webSearch ? "Web search on" : "Web search off"}
                  className={cn(webSearch && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
                >
                  <GlobeIcon className="size-4" />
                  <span className="text-xs">Search</span>
                </PromptInputButton>
                <PromptInputButton
                  type="button"
                  onClick={() => setBrowserUse((v) => !v)}
                  aria-pressed={browserUse}
                  title={browserUse ? "Browser use on — agent can open a real browser" : "Browser use off"}
                  className={cn(browserUse && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
                >
                  <MonitorIcon className="size-4" />
                  <span className="text-xs">Browser</span>
                </PromptInputButton>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <PromptInputButton
                      type="button"
                      title="Mode"
                      className={cn(mode !== "build" && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
                    >
                      {(() => {
                        const Active = MODES.find((m) => m.value === mode)?.icon ?? HammerIcon;
                        return <Active className="size-4" />;
                      })()}
                      <span className="text-xs">{MODES.find((m) => m.value === mode)?.label ?? "Build"}</span>
                      <ChevronDownIcon className="size-3 opacity-60" />
                    </PromptInputButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    {MODES.map((m) => (
                      <DropdownMenuItem
                        key={m.value}
                        onSelect={() => setMode(m.value)}
                        className="items-start gap-2.5 py-2"
                      >
                        <m.icon className="mt-0.5 size-4 shrink-0 text-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-medium">{m.label}</span>
                          <span className="text-xs text-muted-foreground">{m.blurb}</span>
                        </span>
                        {mode === m.value ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* The settings every message carries to the model, shown ONCE,
                    here, as state — never inside the messages or the sidebar
                    (lib/chat-attachments displayText / activeSettingLabels). */}
                {settingLabels.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1" aria-label="Active settings">
                    {settingLabels.map((label) => (
                      <span
                        key={label}
                        data-setting-chip
                        className="max-w-[14rem] truncate rounded-full border border-border bg-muted/50 px-2 py-0.5 text-3xs text-muted-foreground"
                        title={label}
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </>
            }
          />
        </div>
        {isEmpty ? (
          <div className="mt-6 flex w-full flex-col gap-8">
            {/* What needs attention, on the home screen under the composer —
                where this has always lived. The two sections below it are built
                from urgent tickets and stalled customers, so a workspace with
                neither showed an empty home screen even when it had a degraded
                deployment and a blocked implementation. This reads the whole
                workspace, so the home screen has something to say from the
                first day rather than only once tickets exist. */}
            <WorkspaceSummary variant="home" />
            {TICKETS_VISIBLE ? (
              <DataSection title={DEPLOYMENT_PROFILE.chat.empty_sections.urgent} items={starterCards.urgent} onPick={pickSuggestion} />
            ) : null}
            <DataSection title={DEPLOYMENT_PROFILE.chat.empty_sections.stalled} items={starterCards.stalled} onPick={pickSuggestion} />
          </div>
        ) : null}
      </div>
      )}
      </ErrorBoundary>
      </main>
      {/* Artifact preview owns the right rail while open (a package-marked side
          panel, not a modal) — it takes precedence over the Control Panel. */}
      {previewArtifact ? (
        <aside className="flex h-dvh w-[45vw] shrink-0 flex-col border-border border-l bg-muted/20">
          <ErrorBoundary label="Artifact preview" compact>
            <ArtifactPanel
              url={previewArtifact.url}
              filename={previewArtifact.filename}
              versions={previewVersions}
              onSelectVersion={(v) => setPreviewArtifact(v)}
              onClose={() => setPreviewArtifact(null)}
            />
          </ErrorBoundary>
        </aside>
      ) : /* Right rail appears once a real chat has started. A render error in
             the panel is contained here so it can never blank out the whole app. */
      !isEmpty && cockpitOpen ? (
        <aside
          className={cn(
            "flex h-dvh shrink-0 flex-col border-border border-l bg-muted/20 transition-[width] duration-200",
            cockpitWide ? "w-[45vw]" : "w-80",
          )}
        >
          <ErrorBoundary label="Control panel" compact>
            <Cockpit
              insights={insights}
              onCollapse={() => setCockpitOpen(false)}
              // Focus-handoff contract: when focusSubagentCallId matches a run in
              // insights.subagents, Cockpit opens that run's detail view and calls
              // onFocusConsumed().
              focusSubagentCallId={focusSubagent}
              onFocusConsumed={() => setFocusSubagent(null)}
              onDetailChange={setCockpitWide}
              onInputResponses={respondToInput}
              onStuckHandoffs={setStuckHandoffs}
              onHeldHandoffs={setHeldHandoffs}
              // A published file in the rail opens in the SAME artifact preview
              // an office link in the chat opens — the rail swaps to it, and
              // closing the preview brings the cockpit back.
              onOpenArtifact={(url, filename) => setPreviewArtifact({ url, filename })}
              onOpenOps={onOpenOps}
            />
          </ErrorBoundary>
        </aside>
      ) : null}
    </div>
  );
}

/** The hero's rotating lines come from the deployment profile ("{product}" is the product name). */
const HERO_LINES = DEPLOYMENT_PROFILE.chat.hero_lines.map((line) => fillProfileText(line));

/** A deployment that hides the tickets data-room domain gets no ticket-based home-screen cards. */
const TICKETS_VISIBLE = DEPLOYMENT_PROFILE.dataroom.domains.tickets?.visible !== false;

function RotatingHero() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % HERO_LINES.length), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <h1
      key={i}
      className="animate-in fade-in-0 slide-in-from-bottom-1 font-medium text-4xl tracking-tighter duration-700"
    >
      {HERO_LINES[i]}
    </h1>
  );
}

/** Small customer monogram — reads like a company logo mark. */
function Monogram({
  name,
  small = false,
}: {
  readonly name: string;
  readonly small?: boolean;
}) {
  return <CustomerMark name={name} size={small ? "xs" : "sm"} />;
}

function PersonCard({
  person,
  customer,
}: {
  readonly person: { name: string; role?: string; org?: string; email?: string };
  readonly customer?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground font-semibold text-background text-sm">
        {person.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-sm">{person.name}</p>
        {person.role ? <p className="text-muted-foreground text-xs">{person.role}</p> : null}
        {person.org ?? customer ? (
          <p className="truncate text-2xs text-muted-foreground">{person.org ?? customer}</p>
        ) : null}
        {person.email ? (
          <p className="mt-1 truncate text-2xs text-muted-foreground">{person.email}</p>
        ) : null}
      </div>
    </div>
  );
}

function Badge({
  tone,
  className,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  const cls =
    className ??
    (tone === "high"
      ? "bg-red-500/15 text-red-700 dark:text-red-400"
      : tone === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : tone === "low"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-muted text-muted-foreground");
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-3xs", cls)}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Live starter cards                                                          */
/* -------------------------------------------------------------------------- */

/** Just the fields the cards need from /api/ops/customers. */
interface StarterCustomer {
  id: string;
  name: string;
  openTickets: number;
  lastTouchDate: string | null;
  lastTouch: string | null;
  /** The account's owner; the API returns it under both names (accountOwner is the neutral one). */
  accountOwner?: string | null;
  fdeOwner: string | null;
  healthReason: string | null;
}

/**
 * The empty-state cards, built from the LIVE system of record.
 *
 * They used to be derived at module scope from `data/customers.json`, which is a
 * dev-only seed and has been `{"customers": []}` in this deployment ever since
 * Postgres became the system of record. Both lists were therefore always empty,
 * `DataSection` returned null for both, and the empty state silently lost its
 * entire contents — nothing errored, so nothing said so.
 *
 * `/api/ops/customers` already returns open-ticket counts and last-touch dates
 * for exactly this purpose, so the cards now come from the same place the rest
 * of the console does.
 */
function useStarterCards(
  enabled: boolean,
  getAuthHeaders: () => Record<string, string>,
): { stalled: DataItem[]; urgent: DataItem[] } {
  const [cards, setCards] = useState<{ stalled: DataItem[]; urgent: DataItem[] }>({
    stalled: [],
    urgent: [],
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        // The shell reads this same list for the account picker at the same moment: one request (lib/startup-fetch).
        const res = await sharedGet("/api/ops/customers", getAuthHeaders());
        if (!res.ok) return;
        const { customers = [] } = (await res.json()) as { customers?: StarterCustomer[] };
        if (cancelled) return;

        const copy = DEPLOYMENT_PROFILE.chat.starter_cards;
        /** The member who owns the account, as a contact the card can hover. */
        const ownerOf = (c: StarterCustomer) => {
          const owner = c.accountOwner ?? c.fdeOwner;
          return owner
            ? {
                name: owner
                  .split("@")[0]
                  .split(/[._-]/)
                  .filter(Boolean)
                  .map((w) => w[0].toUpperCase() + w.slice(1))
                  .join(" "),
                role: copy.owner_label,
                org: c.name,
                email: owner,
              }
            : undefined;
        };

        const daysSinceIso = (iso: string | null): number | null => {
          if (!iso) return null;
          const t = Date.parse(iso);
          return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
        };

        const urgent: DataItem[] = (TICKETS_VISIBLE ? customers : [])
          .filter((c) => (c.openTickets ?? 0) > 0)
          .sort((a, b) => (b.openTickets ?? 0) - (a.openTickets ?? 0))
          .slice(0, 4)
          .map((c) => ({
            customer: c.name,
            summary:
              c.openTickets === 1
                ? fillProfileText(copy.ticket_waiting, { count: c.openTickets, name: c.name })
                : fillProfileText(copy.tickets_waiting, { count: c.openTickets, name: c.name }),
            action: fillProfileText(copy.triage_title, { name: c.name }),
            badge: fillProfileText(c.openTickets === 1 ? copy.ticket_badge : copy.tickets_badge, { count: c.openTickets }),
            badgeTone: ((c.openTickets ?? 0) >= 3 ? "high" : "medium") as BadgeTone,
            // The card has a proper contact slot with a hover card behind it —
            // use it, rather than flattening the owner into a text footnote.
            spoc: ownerOf(c),
            prompt: fillProfileText(copy.triage_prompt, { name: c.name, count: c.openTickets }),
          }));

        // "Stalled" is a real signal only when we know when we last spoke; a
        // customer with no recorded touch is unknown, not stale, and guessing
        // would put a false alarm on the first screen anyone sees.
        const stalled: DataItem[] = customers
          .map((c) => ({ c, days: daysSinceIso(c.lastTouchDate) }))
          .filter((x): x is { c: StarterCustomer; days: number } => x.days != null && x.days >= 14)
          .sort((a, b) => b.days - a.days)
          .slice(0, 4)
          .map(({ c, days }) => ({
            customer: c.name,
            // `lastTouch` is free text from an import and runs to hundreds of
            // characters. Say the fact plainly and keep the raw note out of a
            // 2-line card where it can only ever be a truncated fragment.
            summary:
              days >= 30
                ? fillProfileText(copy.quiet_summary_long, { name: c.name, days })
                : fillProfileText(copy.quiet_summary, { name: c.name, days }),
            action: fillProfileText(copy.quiet_title, { name: c.name }),
            badge: fillProfileText(copy.quiet_badge, { days }),
            badgeTone: (days >= 30 ? "high" : "medium") as BadgeTone,
            spoc: ownerOf(c),
            prompt: fillProfileText(copy.quiet_prompt, { name: c.name, days }),
          }));

        setCards({ stalled, urgent });
      } catch {
        /* the empty state simply stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, getAuthHeaders]);

  return cards;
}

function DataSection({
  title,
  items,
  onPick,
}: {
  readonly title: string;
  readonly items: DataItem[];
  readonly onPick: (prompt: string, customer?: string) => void;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 4);
  return (
    <div className="w-full">
      <p className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">{title}</p>
      <ul className="grid grid-cols-2 gap-1.5">
        {shown.map((it, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onPick(it.prompt, it.customer)}
              className="group relative flex w-full flex-col gap-1.5 overflow-hidden rounded-xl border border-border/60 bg-card/30 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-xs">
                  <Monogram name={it.customer} />
                  <span className="truncate">{it.customer}</span>
                </span>
                {it.badge ? (
                  <Badge tone={it.badgeTone} className={it.badgeClass}>
                    {it.badge}
                  </Badge>
                ) : null}
              </div>
              <span className="line-clamp-2 min-h-[32px] text-muted-foreground text-xs">
                {it.summary}
              </span>
              {it.spoc || it.meta ? (
                <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                  {it.spoc ? (
                    <HoverCard openDelay={120} closeDelay={80}>
                      <HoverCardTrigger asChild>
                        {/* Stop the click bubbling to the card's suggestion action. */}
                        <span
                          onClick={(e) => e.stopPropagation()}
                          className="flex min-w-0 items-center gap-1.5 rounded transition-colors hover:text-foreground"
                        >
                          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-muted font-semibold text-[8px] text-foreground">
                            {it.spoc.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="truncate">{it.spoc.name}</span>
                        </span>
                      </HoverCardTrigger>
                      <HoverCardContent align="start" className="w-60 p-3">
                        <PersonCard person={it.spoc} customer={it.customer} />
                      </HoverCardContent>
                    </HoverCard>
                  ) : null}
                  {it.meta ? (
                    // `shrink-0` + no truncate meant a long meta ran straight
                    // out of the card. It only ever held "22d old" before, so
                    // nothing caught it until the values came from live data.
                    <span className="min-w-0 truncate text-muted-foreground/60">
                      {it.spoc ? `· ${it.meta}` : it.meta}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {/* Hover CTA: floats bottom-right on an opaque dark chip so it
                  never blends into the card text (no reserved extra row). */}
              <span className="pointer-events-none absolute right-2 bottom-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-lg bg-popover px-2 py-1 font-medium text-2xs text-foreground opacity-0 shadow-lg ring-1 ring-border transition-opacity duration-150 group-hover:opacity-100">
                <ArrowRightIcon className="size-3 shrink-0" />
                <span className="truncate">{it.action}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CustomerSelect({
  selected,
  inferred = [],
  customers,
  status,
  onRetry,
  onChange,
  locked,
}: {
  readonly status: CustomerListStatus;
  readonly onRetry?: () => void;
  readonly selected: string[];
  /** Customer(s) inferred from the conversation, shown read-only when nothing
   *  was manually selected — distinguished from a locked manual pick. */
  readonly inferred?: string[];
  readonly customers: { id: string; name: string }[];
  readonly onChange: (customers: string[]) => void;
  readonly locked: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Resolve a customer id (or name) to its human name — the chip must never
  // show a raw kebab-case id like "sharjah-islamic-bank".
  const nameOf = (idOrName: string) =>
    customers.find((c) => c.id === idOrName || c.name === idOrName)?.name ?? idOrName;

  // The selected customers render as an overlapping row of logo marks — the
  // context reads at a glance without spending header width on names. One
  // selection keeps its name; more collapse to marks + a count.
  const marks = selected.slice(0, 4);
  const overflow = selected.length - marks.length;
  const iconRow = (
    <span className="flex items-center -space-x-1">
      {marks.map((name) => (
        <span key={name} className="rounded ring-1 ring-background" title={name}>
          <Monogram name={name} small />
        </span>
      ))}
    </span>
  );

  // Once a chat has started, the context is fixed — show it read-only.
  if (locked) {
    if (selected.length > 0) {
      return (
        <span
          className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pr-2.5 pl-1.5 text-muted-foreground text-xs"
          title={fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.pill_locked, {
            context: DEPLOYMENT_PROFILE.vocabulary.account_context,
            names: selected.join(", "),
          })}
        >
          {iconRow}
          {selected.length === 1 ? (
            <span className="max-w-[10rem] truncate font-medium text-foreground">
              {nameOf(selected[0])}
            </span>
          ) : overflow > 0 ? (
            <span className="font-medium text-foreground">+{overflow}</span>
          ) : null}
        </span>
      );
    }
    // Nothing was manually picked — surface what the chat is inferred to be
    // about (dashed + "inferred" so it never reads as an explicit lock).
    if (inferred.length > 0) {
      const infMarks = inferred.slice(0, 4);
      const infOverflow = inferred.length - infMarks.length;
      return (
        <span
          className="flex items-center gap-1.5 rounded-full border border-border border-dashed bg-transparent py-1 pr-2.5 pl-1.5 text-muted-foreground text-xs"
          title={`Inferred from this conversation: ${inferred.join(", ")}`}
        >
          <span className="flex items-center -space-x-1">
            {infMarks.map((id) => (
              <span key={id} className="rounded ring-1 ring-background" title={nameOf(id)}>
                <Monogram name={nameOf(id)} small />
              </span>
            ))}
          </span>
          {inferred.length === 1 ? (
            <span className="max-w-[10rem] truncate font-medium text-foreground">
              {nameOf(inferred[0])}
            </span>
          ) : infOverflow > 0 ? (
            <span className="font-medium text-foreground">+{infOverflow}</span>
          ) : null}
          <span className="text-2xs text-muted-foreground">· inferred</span>
        </span>
      );
    }
    return null;
  }

  const active = selected.length > 0;
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  return (
    <>
      <button
        type="button"
        data-testid="account-picker"
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border py-1 text-xs transition-colors",
          active
            ? "border-border bg-muted/40 pr-2.5 pl-1.5 text-foreground hover:bg-muted"
            : "border-border/70 px-2.5 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
        )}
        title={
          active
            ? fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.pill_active, {
                context: DEPLOYMENT_PROFILE.vocabulary.account_context,
                names: selected.join(", "),
              })
            : fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.pill_empty)
        }
      >
        {active ? iconRow : <TagIcon className="size-3.5 shrink-0" />}
        {selected.length === 0 ? (
          <span className="max-w-[10rem] truncate font-medium">{DEPLOYMENT_PROFILE.vocabulary.account_context}</span>
        ) : selected.length === 1 ? (
          <span className="max-w-[10rem] truncate font-medium">{selected[0]}</span>
        ) : overflow > 0 ? (
          <span className="font-medium">+{overflow}</span>
        ) : null}
      </button>
      <CustomerSearchDialog
        open={open}
        onOpenChange={setOpen}
        customers={customers}
        status={status}
        onRetry={onRetry}
        selected={selected}
        onToggle={toggle}
        onClear={() => onChange([])}
      />
    </>
  );
}
