"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceSummary } from "./workspace-summary";
import type { UserContent } from "ai";
import { useEveAgent } from "eve/react";
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
      return "(Plan mode is ON — investigate and plan only, take no action. Use ONLY read-only tools to gather what you need; do NOT write, mutate, send, draft, schedule, post, page, or anything that would prompt for approval. If the request is ambiguous or has real options, ask me a short clarifying question first. Then give a concise plan: the goal, the concrete steps in order, which customers/records/systems each step touches, and how we'll verify it. Then stop and wait for my explicit go — do not act until I approve.)";
    default:
      return null; // "build" (normal), "goal"/"loop" (harness outputSchema gate)
  }
}
const COMPACT_INSTRUCTION =
  "Summarize our entire conversation so far into a compact handoff brief: the goal, the key decisions and facts established, the current state, and what remains to do. Keep every constraint, preference, datum, and reference needed to continue. Reply with ONLY the summary — no preamble.";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";
import { retryStormDetected } from "@/lib/chat-turn-state";
import { composeAttachmentMessage, wrapDirectives } from "@/lib/chat-attachments";
import { cn } from "@/lib/utils";
import { AgentMessage, PendingApprovalCard } from "./agent-message";
import { GOAL_OUTCOME_SCHEMA, asGoalOutcome, goalPreamble, type GoalOutcome } from "./goal-mode";
import type { ChatMeta } from "./chat-shell";
import { Cockpit } from "./cockpit";
import type { OpsSection } from "./ops-center";
import { ErrorBoundary } from "./error-boundary";
import { CustomerSearchDialog, type CustomerListItem } from "./customer-search";
import { CustomerMark } from "./customer-mark";
import {
  STALLED_CUSTOMERS,
  URGENT_TICKETS,
  type BadgeTone,
  type DataItem,
} from "./dataroom";
import { deriveInsights } from "./insights";
import { ArtifactPanel, artifactFromHref, readableArtifactName } from "./artifact-view";
import { ShareThreadButton, type SharePayload } from "./share-thread";
import { opsFetch } from "./ops/lib";

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
  /** Open the Ops Center on a section (optionally deep-linked to a row id). */
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
  readonly sidebarCollapsed: boolean;
  readonly selectedCustomers: string[];
  readonly onCustomersChange: (customers: string[]) => void;
  readonly customers: CustomerListItem[];
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

/** Strip leading directive parentheticals (context / web-search) from a title. */
function cleanTitle(text?: string) {
  if (!text) return text;
  const cleaned = text.replace(/^(\((?:Context|Web search|Plan mode)[^)]*\)\s*)+/i, "").trim();
  return cleaned || text;
}

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
const DISMISSED_KEY = "fde-dismissed-inputs";
function readDismissed(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
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
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-500)));
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
  onOpenOps,
  chatKey,
  onPersist,
  onToggleSidebar,
  sidebarCollapsed,
  selectedCustomers,
  onCustomersChange,
  customers,
  readOnly,
  readOnlyOwner,
  relayThreadId,
  onRelaySent,
  sharedThreadId,
}: AgentChatProps) {
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
   * Say something happened. Fire-and-forget, never throws, never awaited.
   *
   * This file had 2,600 lines and no logging, so every chat failure so far has
   * been found by a person noticing and another person digging. One line at each
   * failure turns that into a query.
   */
  /** The live session id, readable from callbacks the hook owns. */
  const sessionIdRef = useRef<string | null>(null);
  const report = useCallback(
    (kind: string, extra: Record<string, unknown> = {}) => {
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
  const agent = useEveAgent({
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
    onError: (e) => {
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
    if (agent.status === "streaming" || agent.status === "submitted") setStreamError(null);
  }, [agent.status]);

  useEffect(() => {
    sessionIdRef.current = agent.session?.sessionId ?? null;
  }, [agent.session?.sessionId]);

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
  const lastEventType = (agent.events[agent.events.length - 1] as { type?: string } | undefined)?.type;
  const seenEvents = agent.events.length;
  useEffect(() => {
    if (agent.events.length === 0) return;
    const storm = retryStormDetected(agent.events as { type?: string }[]);
    if (storm) {
      setStreamError(
        "This turn kept failing and has stopped retrying. Send it again — the agent won't recover this one.",
      );
      report("stream-gave-up", {
        sessionId: sessionIdRef.current ?? undefined,
        detail: `retry storm · ${agent.events.length} events · last ${lastEventType ?? "none"}`,
      });
      return;
    }
    if (agent.status !== "ready") return;
    let unfinished = false;
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const type = (agent.events[i] as { type?: string })?.type;
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
    setStreamError((prev) => prev ?? "The reply stopped before it finished.");
    report("stream-gave-up", {
      sessionId: sessionIdRef.current ?? undefined,
      detail: `last event: ${lastEventType ?? "none"}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.status, lastEventType, seenEvents]);

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
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const e = agent.events[i] as {
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
  }, [agent.events]);

  // Click-to-compact — IN-THREAD (no fork). eve has no manual-compaction
  // trigger, so we ask the agent to write a compaction checkpoint summary in the
  // SAME session; the transcript shows a "Compacting context…" → "Context
  // manually compacted" divider around it. `compacting` drives the divider;
  // reset when the user sends their next real message.
  const compactPendingRef = useRef(false);
  const [compacting, setCompacting] = useState<"compacting" | "done" | null>(null);
  const handleCompact = useCallback(() => {
    if (isBusy) return;
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
    for (const e of agent.events) {
      const ev = e as { type?: string; data?: { turnId?: string } };
      if (ev.type === "compaction.completed" && ev.data?.turnId) turns.add(ev.data.turnId);
    }
    return turns;
  }, [agent.events]);

  // Goal/Loop completion: the harness emits `result.completed` with the
  // structured `final_output` payload once the model records an outcome. Capture
  // the latest one onto the active goal run so the UI can show complete/blocked.
  useEffect(() => {
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const e = agent.events[i] as { type?: string; data?: { result?: unknown } };
      if (e.type !== "result.completed") continue;
      const outcome = asGoalOutcome(e.data?.result);
      if (outcome) {
        setGoalRun((prev) => (prev && !prev.outcome ? { ...prev, outcome } : prev));
      }
      break;
    }
  }, [agent.events]);

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
      const next = new Set(prev);
      next.add(requestId);
      persistDismissed(next);
      return next;
    });
  };
  // The actual responses this session recorded, keyed by requestId. This is the
  // durable source for persisting answered questions/approvals — the part's own
  // `inputResponse` is missing whenever the answer went out via directDeliver.
  const [answeredResponses, setAnsweredResponses] = useState<Record<string, AnsweredResponse>>({});
  // Requests whose run has DIED: the ONE unrecoverable failure is a crashed
  // child whose continuation token is spent, which the server rejects with a
  // 500 "Cannot deliver inputResponses". Only that signal expires a card — its
  // hoisted Yes/No drops because answering could only fail. Every OTHER failure
  // (a transient 401/429/5xx, a momentary store error) leaves the approval
  // answerable: the re-park resurfaces it, so we must NOT expire on those. We
  // never mark an expired request answered (no inputResponse exists).
  const [expiredRequestIds, setExpiredRequestIds] = useState<ReadonlySet<string>>(new Set());
  const markExpired = (requestIds: readonly string[]) =>
    setExpiredRequestIds((prev) => {
      const next = new Set(prev);
      for (const id of requestIds) next.add(id);
      return next;
    });
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
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const e = agent.events[i] as { type?: string; data?: { continuationToken?: string } };
      if (e.type === "session.waiting" && typeof e.data?.continuationToken === "string" && e.data.continuationToken) {
        return e.data.continuationToken;
      }
    }
    return agent.session?.continuationToken;
  };
  // Recover the freshest resume token from the SERVER when none is in memory:
  // a turn that was streaming when the connection dropped (a window switch mid
  // generation) never parked locally, so no `session.waiting` event — and thus
  // no token — is in `agent.events`. The turn keeps running server-side and
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
    const sessionId = agent.session?.sessionId;
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
      return res.ok;
    } catch {
      return false;
    }
  };
  const isMissingTokenError = (msg: string) =>
    /continuationToken/i.test(msg) && !msg.includes(DEAD_TOKEN_SIGNAL);
  /**
   * Every input request this turn is waiting on, answered-by-us or not.
   *
   * Deliberately does NOT exclude locally answered ones: the batch size is what
   * decides when it is safe to deliver, so removing answers as they arrive would
   * make the last one look like the only one.
   */
  const openRequestIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of agent.data.messages) {
      for (const p of (m as { parts?: readonly unknown[] }).parts ?? []) {
        const part = p as {
          state?: string;
          toolMetadata?: { eve?: { inputRequest?: { requestId?: string }; inputResponse?: unknown } };
        };
        const eve = part.toolMetadata?.eve;
        const rid = eve?.inputRequest?.requestId;
        if (!rid || eve?.inputResponse) continue;
        if (dismissedRequestIds.has(rid) || expiredRequestIds.has(rid)) continue;
        if (!ids.includes(rid)) ids.push(rid);
      }
    }
    return ids;
  }, [agent.data.messages, dismissedRequestIds, expiredRequestIds]);
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

  const respondToInput = async (
    inputResponses: readonly { requestId: string; optionId?: string; text?: string }[],
  ) => {
    // A view-only member of a shared thread can never answer approvals/questions
    // — the owner/participants hold the turn.
    if (readOnly) return;
    setRespondedRequestIds((prev) => {
      const next = new Set(prev);
      for (const r of inputResponses) next.add(r.requestId);
      return next;
    });
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
    const busy = agent.status === "submitted" || agent.status === "streaming";
    if (!busy) {
      // Same pre-empt as messages: a parked session whose store cursor lost its
      // token would reject the answer — deliver it directly with the freshest
      // token so the clarification/approval is never dropped.
      if (
        agent.session?.sessionId &&
        !agent.session.continuationToken &&
        (await directDeliver({ inputResponses }))
      ) {
        pendingAnswerRef.current = [];
        return;
      }
      try {
        await agent.send({ inputResponses });
        pendingAnswerRef.current = [];
      } catch (err) {
        // Expire ONLY on the spent-token signal (the requesting run is gone).
        // Any other store rejection leaves the answer retryable, so we keep the
        // card's Yes/No instead of stripping a live approval.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes(DEAD_TOKEN_SIGNAL)) {
          markExpired(requestIds);
        } else if (isMissingTokenError(msg)) {
          // The store lost its resume token — deliver the answer directly with
          // the freshest token from the stream so the preference isn't dropped.
          await directDeliver({ inputResponses });
        }
        pendingAnswerRef.current = [];
      }
      return;
    }
    const sessionId = agent.session?.sessionId;
    // Latest session.waiting on the stream wins: with several queued approvals
    // each answer consumes a token and the re-park mints a fresh one mid-stream,
    // while agent.session only updates at turn end (it can hold a spent token).
    let continuationToken: string | undefined;
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const e = agent.events[i] as { type?: string; data?: { continuationToken?: string } };
      if (e.type === "session.waiting" && typeof e.data?.continuationToken === "string") {
        continuationToken = e.data.continuationToken;
        break;
      }
    }
    continuationToken ??= agent.session?.continuationToken;
    // No token to POST with: leave the card answerable and clear the ref so a
    // later unrelated store error can't misattribute back to this attempt.
    if (!sessionId || !continuationToken) {
      pendingAnswerRef.current = [];
      return;
    }
    try {
      // Fire-and-forget: execution is durable server-side, and the resumed
      // turn's events arrive on the already-open parent stream.
      const res = await fetch(`/eve/v1/session/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ inputResponses, continuationToken }),
      });
      if (res.ok) {
        pendingAnswerRef.current = [];
      } else {
        // Expire ONLY when the body carries the spent-token signal — a crashed
        // child's token is dead, so the Yes/No can never deliver. A transient
        // non-ok (401 token rotation, 429, a blip 5xx) leaves the card
        // answerable: the re-park resurfaces it and a re-click re-arms it.
        const body = await res.text().catch(() => "");
        if (body.includes(DEAD_TOKEN_SIGNAL)) markExpired(requestIds);
        pendingAnswerRef.current = [];
      }
    } catch {
      // The stream reconnect path will surface the park again — leave the card
      // answerable and clear the ref (a later unrelated error must not expire it).
      pendingAnswerRef.current = [];
    }
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
  const isEmpty = agent.data.messages.length === 0;

  // Child sessions of delegated subagents, keyed by tool-call id. The message
  // parts carry the delegation itself but not the child's session id — only the
  // `subagent.called` EVENT does. Derive it from the full event log (the same
  // log persistence stores), so RESTORED chats keep their child sessions too:
  // the child stream replays history on attach, meaning a reloaded run shows
  // its full step data instead of falling back to a summary blob.
  const eventCount = agent.events.length;
  const childSessions = useMemo(() => {
    const map: Record<string, string> = {};
    for (const raw of agent.events) {
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
    for (const raw of agent.events) {
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

  // "Working…" strip: the turn is active but nothing on screen is visibly
  // progressing — no text tail streaming (the caret covers that), and the turn
  // is not parked waiting on the user (approval / question / authorization).
  const lastMessage = agent.data.messages[agent.data.messages.length - 1];
  const lastParts = (lastMessage?.parts ?? []) as Array<{
    type?: string;
    state?: string;
    toolMetadata?: { eve?: { inputRequest?: unknown; inputResponse?: unknown } };
  }>;
  const awaitingUser = lastParts.some(
    (p) =>
      p.state === "approval-requested" ||
      p.state === "required" ||
      (Boolean(p.toolMetadata?.eve?.inputRequest) && !p.toolMetadata?.eve?.inputResponse),
  );
  const streamingTextTail =
    agent.status === "streaming" &&
    lastMessage?.role === "assistant" &&
    lastParts[lastParts.length - 1]?.type === "text";
  const showWorking = isBusy && !awaitingUser && !streamingTextTail;

  // Pending approvals/questions hoisted to the conversation tail: eve's
  // proxied child approvals carry stale turn ids, so the reducer attaches them
  // to an EARLIER assistant message — in place they render above newer
  // messages. Collected here and rendered after the last message instead.
  const pendingInputParts = useMemo(() => {
    const out: Array<React.ComponentProps<typeof PendingApprovalCard>["part"]> = [];
    for (const m of agent.data.messages) {
      for (const p of m.parts ?? []) {
        const part = p as {
          type?: string;
          toolName?: string;
          state?: string;
          toolCallId?: string;
          toolMetadata?: { eve?: { inputRequest?: unknown; inputResponse?: unknown } };
        };
        if (part.type !== "dynamic-tool") continue;
        if (part.toolName?.startsWith("eve:subagent:")) continue;
        // Subagent-proxied approvals live in the rail, never in this thread.
        if (isProxiedChildApproval(part)) continue;
        // A tool that has already RUN (terminal) is never awaiting approval —
        // even when its inputRequest metadata lingers and no inputResponse was
        // recorded on the part (a write approved via the parent proxy). Without
        // this guard a completed approval-gated write is hoisted to the tail as a
        // DUPLICATE (empty) approval card. Mirrors proxiedApprovalPending below.
        const terminal =
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied";
        const pending =
          !terminal &&
          (part.state === "approval-requested" ||
            (Boolean(part.toolMetadata?.eve?.inputRequest) && !part.toolMetadata?.eve?.inputResponse));
        if (!pending) continue;
        const requestId = (
          part.toolMetadata?.eve?.inputRequest as { requestId?: string } | undefined
        )?.requestId;
        // Waved away by the operator — never re-hoist it.
        if (requestId && dismissedRequestIds.has(requestId)) continue;
        // Answered cards drop out — UNLESS the answer failed and expired them:
        // an expired card stays, re-rendered as a muted "run has stopped" note.
        if (
          requestId &&
          respondedRequestIds.has(requestId) &&
          !expiredRequestIds.has(requestId)
        )
          continue;
        out.push(part as never);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.data.messages, respondedRequestIds, expiredRequestIds, dismissedRequestIds, ownActionCallIds, hasSubagent]);

  // A subagent parked on an approval that we've pulled out of the main thread.
  // We surface a single tail notice (not the mis-positioned card) so the run is
  // still discoverable when the rail is closed. The child-proxied event carries
  // no childSessionId, so name the currently running subagent if there is one.
  const proxiedApprovalPending = useMemo(() => {
    // A proxied approval is only LIVE while its subagent is still parked. Once
    // every subagent DELEGATION has reached a terminal state, any lingering
    // approval part is stale — the child answered it via the parent proxy and
    // ran to completion, but the mis-positioned parent-thread part never got its
    // terminal update. Gating on a live delegation is what kills the stale
    // "a subagent needs your approval" banner after the run finishes (a done
    // T-800 in the rail while the banner still nagged).
    let anyDelegationLive = false;
    for (const m of agent.data.messages) {
      for (const p of m.parts ?? []) {
        const part = p as { type?: string; state?: string; toolName?: string };
        if (part.type !== "dynamic-tool" || !part.toolName?.startsWith("eve:subagent:")) continue;
        const done =
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied";
        if (!done) anyDelegationLive = true;
      }
    }
    if (!anyDelegationLive) return false;

    for (const m of agent.data.messages) {
      for (const p of m.parts ?? []) {
        const part = p as {
          type?: string;
          state?: string;
          toolName?: string;
          toolCallId?: string;
          toolMetadata?: { eve?: { inputRequest?: unknown; inputResponse?: unknown } };
        };
        if (!isProxiedChildApproval(part)) continue;
        // A completed tool (terminal state) is NOT awaiting approval, even if
        // its own part never recorded the response (subagent approvals answered
        // via the parent proxy) — otherwise the banner lingers after the run.
        const terminal =
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied";
        const pending =
          !terminal &&
          Boolean(part.toolMetadata?.eve?.inputRequest) &&
          !part.toolMetadata?.eve?.inputResponse;
        if (!pending) continue;
        // Already answered (via the Control Panel proxy) or its run has DIED —
        // in both cases the part can stay non-terminal forever, so consult the
        // responded/expired sets the card already tracks rather than trusting
        // the part's own state, which lags for proxied child approvals.
        const rid = (part.toolMetadata?.eve?.inputRequest as { requestId?: string } | undefined)?.requestId;
        if (rid && (respondedRequestIds.has(rid) || expiredRequestIds.has(rid))) continue;
        return true;
      }
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.data.messages, respondedRequestIds, expiredRequestIds, ownActionCallIds, hasSubagent]);
  const insights = useMemo(() => {
    const base = deriveInsights(agent.data.messages);
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        childSessionId: s.childSessionId ?? childSessions[s.callId],
      })),
    };
  }, [agent.data.messages, childSessions]);

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
    for (const m of agent.data.messages) {
      for (const p of m.parts ?? []) {
        const part = p as { type?: string; text?: string; input?: unknown };
        if (part.type === "text" && part.text) scan(part.text);
        else if (part.type === "dynamic-tool" && part.input !== undefined) {
          scan(JSON.stringify(part.input));
        }
      }
    }
    return [...found];
  }, [selectedCustomers, customers, agent.data.messages]);

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
  const [queued, setQueued] = useState<{ text: string; files: AttachedFile[] }[]>([]);
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
    for (const m of agent.data.messages) {
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
  }, [agent.data.messages]);
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

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked) return;
    for (const file of Array.from(picked)) {
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
    e.target.value = "";
  };

  // Persist chat metadata once it has a server session.
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const sessionId = agent.session?.sessionId;
  const title = cleanTitle(firstUserText(agent.data.messages));
  const preview = lastText(agent.data.messages);
  const messageCount = agent.data.messages.length;
  const customersKey = selectedCustomers.join(",");
  const status = agent.status;
  // Answered-input markers to fold into the persisted stream (see helper). The
  // count is a dep so persisting re-fires the moment a new input is answered,
  // even when neither status nor messageCount changes.
  const responded = respondedInputEvents(agent.data.messages, answeredResponses);
  const respondedCount = responded.length;
  useEffect(() => {
    if (sessionId && agent.session) {
      persistRef.current(
        agent.session,
        {
          title: title ?? "New chat",
          preview,
          messageCount,
          customers: selectedCustomers.length ? selectedCustomers : undefined,
          forkedFrom,
        },
        // Persist the event stream so reopening this chat restores its history
        // (data.messages is projected from events, not from the session cursor).
        // Fold in synthesized `client.input.responded` events so answered
        // questions/approvals stay answered across a reopen instead of reverting
        // to pending and hoisting to the tail.
        [...agent.events, ...responded] as typeof agent.events,
        chatKey,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, title, preview, messageCount, customersKey, status, respondedCount]);

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
  const withDirectives = (body: string, withContext: boolean) => {
    if (!body) return body;
    const directives: string[] = [];
    if (withContext && selectedCustomers.length > 0) {
      directives.push(`(Context: this conversation is about ${selectedCustomers.join(", ")}.)`);
    }
    for (const d of [searchDirective(webSearch), browserDirective(browserUse), modeDirective(mode)]) {
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

  const sendMessage = async (raw: string, filesToSend: AttachedFile[]) => {
    // Goal / Loop: run in the harness. Frame the objective with the goal
    // preamble and attach the completion-gate schema — the harness injects a
    // `final_output` tool and won't end the turn until the model records an
    // outcome, so the agent keeps working end-to-end. Plain modes send as-is.
    const isGoal = mode === "goal" || mode === "loop";
    const body = isGoal ? goalPreamble(raw, mode) : raw;
    // Context only on the very first turn; web-search opt-out every turn.
    const text = withDirectives(body, agent.data.messages.length === 0);
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
      if (worthInlining(f)) {
        parts.push({ type: "file", data: f.dataUrl, mediaType: f.mediaType, filename: f.name });
      }
    }
    const content: UserContent = parts.length > 1 ? (parts as UserContent) : messageText;
    if (isGoal) setGoalRun({ kind: mode, objective: raw, outcome: null });
    // If the store would CONTINUE a parked session but its cursor has no resume
    // token, it POSTs an empty continuationToken and eve rejects the whole turn.
    // Pre-empt that: deliver directly with the freshest token from the stream.
    if (
      agent.session?.sessionId &&
      !agent.session.continuationToken &&
      (await directDeliver({ message: content, outputSchema }))
    ) {
      return;
    }
    try {
      await agent.send(
        (outputSchema
          ? { message: content, outputSchema }
          : { message: content }) as Parameters<typeof agent.send>[0],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTokenError(msg) && (await directDeliver({ message: content, outputSchema }))) return;
      throw err;
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

  // Stop control for an active goal/loop.
  const requestGoalStop = () => {
    if (agent.status === "submitted" || agent.status === "streaming") {
      // Halt the in-flight turn first; the watcher below delivers the wrap-up
      // once it settles (sending mid-turn would throw "already processing").
      agent.stop();
      setGoalStopping(true);
    } else {
      void deliverGoalWrapUp();
    }
  };

  // Once a stop-requested turn has halted, deliver the wrap-up so the model
  // records the outcome and the completion gate clears.
  useEffect(() => {
    if (!goalStopping) return;
    if (agent.status === "submitted" || agent.status === "streaming") return;
    setGoalStopping(false);
    void deliverGoalWrapUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalStopping, agent.status]);

    // The delivered plan: the last assistant message's text once a plan-mode turn
  // has fully finished and nothing is parked on user input.
  const planText =
    mode === "plan" && !isBusy && !awaitingUser && lastMessage?.role === "assistant"
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
    if (!lastMessage) return;
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
    if (seededRef.current || !initialPrompt || agent.data.messages.length > 0) return;
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
    // If a turn is in flight, queue this one and send it when the agent is idle.
    if (isBusy) {
      setQueued((prev) => [...prev, { text: raw, files: outgoing }]);
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
    setHandledHandoffs((prev) => new Set(prev).add(h.callId));
    const msg = `The ${h.name} subagent finished, but its result did not come through automatically. Here is its final result verbatim:\n\n${h.result}\n\nUse this to continue and complete the task.`;
    if (isBusy) {
      // The parent turn is stuck — it's "busy" awaiting a child that already
      // finished, so it will NEVER complete on its own and the normal queue
      // would wait forever. Abort that dead turn, then queue: the flush effect
      // delivers the result as a fresh turn once the abort lands (isBusy→false).
      setQueued((prev) => [...prev, { text: msg, files: [] }]);
      agent.stop();
    } else {
      void sendMessage(msg, []);
    }
  };

  // Flush any queued messages one at a time as soon as the agent goes idle.
  useEffect(() => {
    if (isBusy || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    if (next.text.trim() || next.files.length > 0) void sendMessage(next.text, next.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, queued]);

  const editQueued = (i: number, text: string) =>
    setQueued((prev) => prev.map((q, j) => (j === i ? { ...q, text } : q)));
  const removeQueued = (i: number) => setQueued((prev) => prev.filter((_, j) => j !== i));
  const moveQueued = (i: number, dir: -1 | 1) =>
    setQueued((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // Regenerate: re-send the most recent user message (appends a fresh turn).
  const retryLast = () => {
    if (isBusy) return;
    const msgs = agent.data.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const text = (msgs[i].parts ?? [])
        .map((p) => {
          const part = p as { type?: string; text?: string };
          return part.type === "text" ? (part.text ?? "") : "";
        })
        .join("")
        .trim();
      if (text) void agent.send({ message: text });
      return;
    }
  };

  // Live starter cards for the empty state (see useStarterCards).
  const starterCards = useStarterCards(isEmpty, getAuthHeaders);

  const pickSuggestion = (prompt: string, customer?: string) => {
    if (isBusy) return;
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
    const text = directives.length > 0 ? `${directives.join(" ")}\n\n${prompt}` : prompt;
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
        const art = artifactFromHref(anchor.getAttribute("href") ?? anchor.href);
        if (art) {
          e.preventDefault();
          e.stopPropagation();
          setPreviewArtifact(art);
        }
      }}
    >
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
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

      {agent.error ? (
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
          resetKeys={[sessionId, agent.status, agent.events.length, agent.data.messages.length]}
        >
          <Conversation className="min-h-0 flex-1">
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
                title={`Back to: ${forkedFrom.title}`}
              >
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="shrink-0">Forked from</span>
                <span className="truncate font-medium text-foreground">{forkedFrom.title}</span>
              </button>
            ) : null}
            {agent.data.messages.map((message, index) => {
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
              // Auto-compaction divider: at the START of a turn eve compacted
              // before (its turnId is in `autoCompactedTurns`), the first time
              // that turn appears in the flow.
              const turnId = message.metadata?.turnId;
              const prevTurnId = index > 0 ? agent.data.messages[index - 1]?.metadata?.turnId : undefined;
              const showAutoDivider = Boolean(turnId && turnId !== prevTurnId && autoCompactedTurns.has(turnId));
              return (
                <Fragment key={message.id}>
                  {showAutoDivider ? <CompactionDivider kind="auto" /> : null}
                  <AgentMessage
                    canRespond={!isBusy && !readOnly}
                    hoistPendingInput
                    isProxiedApproval={isProxiedChildApproval}
                    isLast={index === agent.data.messages.length - 1}
                    isStreaming={
                      agent.status === "streaming" && index === agent.data.messages.length - 1
                    }
                    message={message}
                    onFocusSubagent={(toolCallId) => {
                      setCockpitOpen(true);
                      setFocusSubagent(toolCallId);
                    }}
                    onInputResponses={respondToInput}
                    turnActive={isBusy}
                    onRetry={
                      !isBusy &&
                      message.role === "assistant" &&
                      index === agent.data.messages.length - 1
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
                  return (
                    <PendingApprovalCard
                      key={p.toolCallId}
                      expired={Boolean(requestId && expiredRequestIds.has(requestId))}
                      part={p}
                      onInputResponses={respondToInput}
                      onDismiss={requestId ? () => dismissInput(requestId) : undefined}
                    />
                  );
                })}
              </div>
            ) : null}
            {/* A proxied child approval is only live while the PARENT turn is
                in-flight (its open stream is how the approval reaches us). Once
                the turn ends and the composer is back, a lingering approval is
                stale — gate on isBusy so it never outlives its turn. */}
            {proxiedApprovalPending && isBusy ? (
              <button
                type="button"
                onClick={() => {
                  setCockpitOpen(true);
                  const running = insights.subagents.find((s) => s.status === "running");
                  if (running) setFocusSubagent(running.callId);
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-amber-500/10"
              >
                <ClockIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="min-w-0 flex-1">
                  A subagent needs your approval — open the Control Panel to respond.
                </span>
                <PanelRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ) : null}
            {shownHandoffs.map((h) => (
              <div
                key={h.callId}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
              >
                <p className="text-sm">
                  <span className="font-medium">{h.name} subagent</span> finished, but its result
                  didn't reach the chat.
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
                      setHandledHandoffs((prev) => new Set(prev).add(h.callId))
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
          {queued.length > 0 ? (
            <div className="mb-2 flex flex-col gap-1">
              <p className="px-1 text-3xs text-muted-foreground">
                Queued — sending after the current reply
              </p>
              {queued.map((q, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-1.5 py-1"
                >
                  <span className="w-4 shrink-0 text-center text-3xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <input
                    value={q.text}
                    onChange={(e) => editQueued(i, e.target.value)}
                    placeholder={q.files.length > 0 ? `${q.files.length} file(s)` : "empty"}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                  />
                  <button
                    type="button"
                    onClick={() => moveQueued(i, -1)}
                    disabled={i === 0}
                    aria-label="Move up"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUpIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveQueued(i, 1)}
                    disabled={i === queued.length - 1}
                    aria-label="Move down"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQueued(i)}
                    aria-label="Remove"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ))}
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
            onStop={agent.stop}
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
            <DataSection title="Urgent tickets" items={starterCards.urgent} onPick={pickSuggestion} />
            <DataSection title="Stalled customers" items={starterCards.stalled} onPick={pickSuggestion} />
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

const HERO_LINES = [
  "Delivered",
  "What needs doing today?",
  "Prep the stand-up",
  "Chase the follow-ups",
  "Keep every customer close",
];

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
        const res = await fetch("/api/ops/customers", { headers: getAuthHeaders() });
        if (!res.ok) return;
        const { customers = [] } = (await res.json()) as { customers?: StarterCustomer[] };
        if (cancelled) return;

        /** The FDE who owns the account, as a contact the card can hover. */
        const ownerOf = (c: StarterCustomer) =>
          c.fdeOwner
            ? {
                name: c.fdeOwner
                  .split("@")[0]
                  .split(/[._-]/)
                  .filter(Boolean)
                  .map((w) => w[0].toUpperCase() + w.slice(1))
                  .join(" "),
                role: "FDE owner",
                org: c.name,
                email: c.fdeOwner,
              }
            : undefined;

        const daysSinceIso = (iso: string | null): number | null => {
          if (!iso) return null;
          const t = Date.parse(iso);
          return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
        };

        const urgent: DataItem[] = customers
          .filter((c) => (c.openTickets ?? 0) > 0)
          .sort((a, b) => (b.openTickets ?? 0) - (a.openTickets ?? 0))
          .slice(0, 4)
          .map((c) => ({
            customer: c.name,
            summary:
              c.openTickets === 1
                ? "One open ticket is waiting on us."
                : `${c.openTickets} open tickets are waiting on us.`,
            action: "Triage the open tickets",
            badge: c.openTickets === 1 ? "1 open" : `${c.openTickets} open`,
            badgeTone: ((c.openTickets ?? 0) >= 3 ? "high" : "medium") as BadgeTone,
            // The card has a proper contact slot with a hover card behind it —
            // use it, rather than flattening the owner into a text footnote.
            spoc: ownerOf(c),
            prompt: `Triage the open tickets for ${c.name}: what is blocking each one, who owns it, and what should we do next?`,
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
                ? `No contact logged for over a month.`
                : `No contact logged in ${days} days.`,
            action: "Draft a check-in",
            badge: `${days}d quiet`,
            badgeTone: (days >= 30 ? "high" : "medium") as BadgeTone,
            spoc: ownerOf(c),
            prompt: `${c.name} has been quiet for ${days} days. Summarise where we left off and draft a check-in to their main contact.`,
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
  onChange,
  locked,
}: {
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
          title={`Customer context is locked for this chat: ${selected.join(", ")}`}
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
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border py-1 text-xs transition-colors",
          active
            ? "border-border bg-muted/40 pr-2.5 pl-1.5 text-foreground hover:bg-muted"
            : "border-border/70 px-2.5 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
        )}
        title={
          active
            ? `Customer context: ${selected.join(", ")} — click to change`
            : "Set the customer context for this chat"
        }
      >
        {active ? iconRow : <TagIcon className="size-3.5 shrink-0" />}
        {selected.length === 0 ? (
          <span className="max-w-[10rem] truncate font-medium">Customer context</span>
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
        selected={selected}
        onToggle={toggle}
        onClear={() => onChange([])}
      />
    </>
  );
}
