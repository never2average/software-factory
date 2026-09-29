"use client";

import { noteRender } from "@/lib/render-census";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClockIcon,
  ArrowUpRightIcon,
  Bot,
  ExternalLinkIcon,
  GitCompareIcon,
  InfoIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
  ChevronLeftIcon,
  ListTodo,
  PackageIcon,
  PlayIcon,
  RocketIcon,
  SquareIcon,
  PanelRightCloseIcon,
  TicketIcon,
  Users,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { defaultMessageReducer } from "eve/react";
import type { EveMessage } from "eve/react";
import { withSessionEpochs } from "@/lib/chat-turn-state";
import { AgentMessage } from "./agent-message";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChatComposer } from "./composer";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArtifactBody, artifactFromHref, kindOf, useLiveArtifactUrl } from "./artifact-view";
import { CustomerMark } from "./customer-mark";
import { SUBAGENT_META } from "./subagent-meta.generated";
import { subagentDescription, subagentDisplayName, toolCallSummary, toolDisplayName } from "./tool-display";
import type { ArtifactItem, CtxItem, Insights, PersonItem, SubagentRun } from "./insights";
import { deriveInsights, mergeInsights } from "./insights";
import { RunStatusDot } from "./ops/detail";
import { Dashboard, parseDashboardSpec } from "./ops/dashboard";
import { type ApiWorkflowVersion, authToken, opsFetch, type OpsSection, unkebab } from "./ops/lib";
import { pickSubagentName } from "@/lib/subagent-names";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { domainView } from "@/lib/profile-domains";

/** The two record areas as this deployment names them (`domains` in the deployment profile). */
const DEP = domainView("deployments");
const IMP = domainView("implementations");
const countOf = (n: number, view: { noun: string; nouns: string }) => `${n} ${n === 1 ? view.noun : view.nouns}`;

/** A deployment can hide a data-room domain; its ownership panels and counts go with it. */
const domainVisible = (key: "Tickets" | "Deployments" | "Implementation") =>
  DEPLOYMENT_PROFILE.dataroom.domains[key]?.visible !== false;
const SHOW_TICKETS = domainVisible("Tickets");
const SHOW_DEPLOYMENTS = domainVisible("Deployments");
const SHOW_IMPLEMENTATIONS = domainVisible("Implementation");
/** "customer" -> "Customer", for field labels. */
const ACCOUNT_LABEL =
  DEPLOYMENT_PROFILE.vocabulary.account.singular.charAt(0).toUpperCase() +
  DEPLOYMENT_PROFILE.vocabulary.account.singular.slice(1);
/** "a, b, c, and d" — the sentence the dossier has always used for four kinds of work. */
const listWithAnd = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? "") : parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
import { type RunJournalEntry, type WorkflowRunRow } from "./ops/run-timeline";
import { type GraphPhase, RunGraph } from "./ops/run-graph";

/**
 * How many child sessions the rail will attach to at once. The roll-up wants
 * EVERY delegation's history, but a chat with dozens of runs must not open
 * dozens of connections — oldest-first is dropped past this.
 */
const MAX_CHILD_FEEDS = 24;

/** An app row as the cockpit needs it to show refreshes (subset of /api/ops/apps). */
type AppRunRow = {
  id: string;
  slug: string;
  name: string;
  sourceKind: string;
  refreshingAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  contentMd: string | null;
  contentUpdatedAt: string | null;
};

export function Cockpit({
  insights,
  onCollapse,
  focusSubagentCallId,
  onFocusConsumed,
  onDetailChange,
  onInputResponses,
  onStuckHandoffs,
  onOpenArtifact,
  onOpenOps,
}: {
  readonly insights: Insights;
  readonly onCollapse: () => void;
  readonly focusSubagentCallId?: string | null;
  readonly onFocusConsumed?: () => void;
  /** Fires with true while a detail view is open — the chat doubles the rail width. */
  readonly onDetailChange?: (open: boolean) => void;
  /** Answer a proxied approval/question (same responder as the chat). */
  readonly onInputResponses?: (
    responses: readonly { optionId?: string; requestId: string; text?: string }[],
  ) => void | Promise<void>;
  /** Report subagents that FINISHED but whose result never reached the parent
   *  (the delegation is still pending) — the chat surfaces a recovery action. */
  readonly onStuckHandoffs?: (
    handoffs: readonly { callId: string; name: string; result: string }[],
  ) => void;
  /** Open a PUBLISHED FILE in the chat's artifact preview (the rail swaps to
   *  it), so a file in this rail behaves exactly like an artifact link in the
   *  conversation. Scripts and cron definitions still open in a modal — the
   *  preview renders office documents, not text. */
  readonly onOpenArtifact?: (url: string, filename: string) => void;
  /** Open the Ops Center on a section, optionally deep-linked to a row id. */
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
}) {
  noteRender("Cockpit");
  const [selected, setSelected] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  // Child-session feeds are owned at THIS level (not inside the detail view):
  // every delegation stays attached so the list rows count tool calls live, the
  // selected run's transcript survives back-navigation, and — the reason every
  // delegation is attached, not just the running ones — the child's tool calls
  // are the ONLY place a subagent-created object exists. See `merged` below.
  // A workflow step opened as a subagent panel IN THE RAIL. Modelled as a
  // synthetic SubagentRun so it reuses <SubagentDetail> verbatim — the same
  // transcript + steer surface a chat delegation gets.
  const [stepRun, setStepRun] = useState<SubagentRun | null>(null);
  // Child sessions discovered BELOW the first level: a subagent that delegates
  // further produces grandchildren whose work must roll up the same way. They
  // can only be learned from a child's own stream, so they accumulate here and
  // feed back into the target list on the next render (converges at tree depth).
  const [nestedSessions, setNestedSessions] = useState<readonly string[]>([]);
  const feedTargets = useMemo(() => {
    const ids = new Set<string>();
    for (const s of insights.subagents) if (s.childSessionId) ids.add(s.childSessionId);
    for (const sid of nestedSessions) ids.add(sid);
    // The opened workflow step needs its own live feed to render a transcript.
    if (stepRun?.childSessionId) ids.add(stepRun.childSessionId);
    // Bounded: a long chat must not hold an unbounded number of connections.
    return [...ids].slice(0, MAX_CHILD_FEEDS);
  }, [insights.subagents, nestedSessions, stepRun]);
  // Which of those need a LIVE connection rather than a one-shot history
  // harvest: an unfinished run (its rail row counts tool calls as they happen)
  // and whatever the operator has open. Everything else is replayed once and
  // disconnected — see useChildFeeds.
  const liveTargets = useMemo(() => {
    const ids = new Set<string>();
    for (const s of insights.subagents) {
      if (s.childSessionId && (s.status === "running" || s.callId === selected)) {
        ids.add(s.childSessionId);
      }
    }
    if (stepRun?.childSessionId) ids.add(stepRun.childSessionId);
    return [...ids];
  }, [insights.subagents, selected, stepRun]);
  const { feeds, appendLocal, markTurnIdle } = useChildFeeds(feedTargets, liveTargets);

  useEffect(() => {
    const found = new Set<string>();
    for (const f of Object.values(feeds)) for (const sid of f.childSessions) found.add(sid);
    setNestedSessions((prev) => (prev.every((s) => found.has(s)) && prev.length === found.size ? prev : [...found]));
  }, [feeds]);

  // THE roll-up: the panel is a projection of the conversation, and a subagent's
  // session is part of that conversation. Folding each child's projection in is
  // what makes an artifact, cron, app, browser session or workflow run created
  // inside a delegation appear here — the parent's own message stream never
  // contains those tool calls, only the delegation that spawned them.
  // A stream event replaces only ITS session's message array, so keying the
  // per-child derivation on that array's identity keeps a busy run from
  // re-deriving every other attached session on every token.
  const childCache = useRef(new WeakMap<object, Insights>());
  const merged = useMemo(() => {
    let out = insights;
    for (const f of Object.values(feeds)) {
      if (f.messages.length === 0) continue;
      let derived = childCache.current.get(f.messages);
      if (!derived) {
        derived = deriveInsights(f.messages);
        childCache.current.set(f.messages, derived);
      }
      out = mergeInsights(out, derived);
    }
    return out;
  }, [insights, feeds]);
  const browser = useMemo(
    () => ({ views: merged.browserLiveViews, errors: merged.browserErrors }),
    [merged],
  );
  const selectedRun = merged.subagents.find((s) => s.callId === selected) ?? null;

  // Persisted codenames for subagent runs — each run gets a distinct name from
  // the static pool (lib/subagent-names.ts) so two "Research" runs read apart.
  // The name is deterministic from the run's stable key (so it shows instantly,
  // no flicker), and is upserted to the DB (first write wins) so it's stable and
  // authoritative across reloads/clients.
  const [runLabels, setRunLabels] = useState<Record<string, string>>({});
  const runMeta = useMemo(
    () =>
      merged.subagents.map((s) => ({
        key: runKeyOf(s),
        type: s.name,
        sessionId: s.childSessionId ?? null,
      })),
    [merged.subagents],
  );
  const runKeysSig = runMeta.map((m) => m.key).join(",");
  useEffect(() => {
    const missing = runMeta.filter((m) => !(m.key in runLabels));
    if (missing.length === 0) return;
    let alive = true;
    void (async () => {
      const keys = missing.map((m) => m.key);
      let fetched: Record<string, string> = {};
      try {
        const d = await opsFetch<{ labels: Record<string, string> }>(
          `/api/ops/subagent-runs?keys=${encodeURIComponent(keys.join(","))}`,
        );
        fetched = d.labels ?? {};
      } catch {
        /* table may not exist yet — fall back to deterministic names */
      }
      if (!alive) return;
      const next: Record<string, string> = {};
      const toPersist: typeof missing = [];
      for (const m of missing) {
        if (fetched[m.key]) {
          next[m.key] = fetched[m.key];
        } else {
          next[m.key] = pickSubagentName(m.key);
          toPersist.push(m);
        }
      }
      setRunLabels((prev) => ({ ...prev, ...next }));
      // Persist the freshly-minted names; the server returns the stored label
      // (first write wins), so adopt it if another client got there first.
      for (const m of toPersist) {
        void opsFetch<{ label?: string }>("/api/ops/subagent-runs", {
          method: "POST",
          body: JSON.stringify({
            runKey: m.key,
            sessionId: m.sessionId,
            subagentType: m.type,
            label: next[m.key],
          }),
        })
          .then((r) => {
            if (alive && r?.label && r.label !== next[m.key]) {
              setRunLabels((prev) => ({ ...prev, [m.key]: r.label as string }));
            }
          })
          .catch(() => {});
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKeysSig]);
  const nameOf = useCallback(
    (run: SubagentRun) => runLabels[runKeyOf(run)] ?? pickSubagentName(runKeyOf(run)),
    [runLabels],
  );

  // The run whose panel is open in the rail — a delegated subagent OR a workflow
  // step. The header's cancel/resume/info act on whichever it is.
  const railRun = selectedRun ?? stepRun;
  const railFeed = railRun?.childSessionId ? feeds[railRun.childSessionId] : undefined;

  // Stuck handoffs: the child stream has ENDED with a final result, but the
  // parent's delegation is still "running" (it never received the result — the
  // resumeHook handoff didn't land). Surface these to the chat so the user can
  // pull the result in manually. Result = the child's last assistant message.
  const stuckHandoffs = useMemo(() => {
    const out: { callId: string; name: string; result: string }[] = [];
    for (const s of insights.subagents) {
      if (s.status !== "running" || !s.childSessionId) continue;
      const f = feeds[s.childSessionId];
      if (!f || f.turnActive !== false) continue;
      // Only a GENUINELY completed child (session.completed) is a stuck handoff.
      // A child parked on an approval also has turnActive false + status ended,
      // but it isn't finished — it's waiting on the user, so never flag it.
      if (!f.completed) continue;
      const lastAssistant = [...f.messages].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant) continue;
      const result = (lastAssistant.parts ?? [])
        .map((p) => {
          const part = p as { type?: string; text?: string };
          return part.type === "text" ? (part.text ?? "") : "";
        })
        .join("")
        .trim();
      if (!result) continue;
      out.push({ callId: s.callId, name: subagentDisplayName(s.name), result });
    }
    return out;
  }, [insights.subagents, feeds]);
  const stuckSig = stuckHandoffs.map((h) => h.callId).join(",");
  const onStuckRef = useRef(onStuckHandoffs);
  onStuckRef.current = onStuckHandoffs;
  const stuckRef = useRef(stuckHandoffs);
  stuckRef.current = stuckHandoffs;
  useEffect(() => {
    onStuckRef.current?.(stuckRef.current);
  }, [stuckSig]);
  const cancelSelectedRun = async () => {
    const sid = railRun?.childSessionId;
    if (!sid) return;
    try {
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sid)}/cancel`, {
        method: "POST",
        headers: eveAuthHeaders(),
      });
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      appendLocal(
        sid,
        !res.ok
          ? `Cancel failed (${res.status})`
          : body?.status === "no_active_turn"
            ? "Nothing to cancel — the run has no active turn (it already finished or failed)."
            : "Cancel requested",
      );
      if (body?.status === "no_active_turn") markTurnIdle(sid);
    } catch {
      appendLocal(sid, "Cancel failed (network)");
    }
  };
  // Resuming a cancelled/parked child needs its continuation token (captured
  // from the feed's session.waiting events) — without one there is no handle.
  const resumeSelectedRun = async () => {
    const sid = railRun?.childSessionId;
    const continuationToken = railFeed?.continuationToken;
    if (!sid || !continuationToken) return;
    try {
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...eveAuthHeaders() },
        body: JSON.stringify({
          message: "Resume — continue the task from where you left off.",
          continuationToken,
        }),
      });
      appendLocal(sid, res.ok ? "Resume requested" : `Resume failed (${res.status})`);
    } catch {
      appendLocal(sid, "Resume failed (network)");
    }
  };
  const cancelSelectedWorkflowRun = async () => {
    const run = wfHeader ?? selectedWfRun;
    if (!run || run.status !== "running") return;
    try {
      await fetch(`/api/ops/workflow-runs/${encodeURIComponent(run.runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...eveAuthHeaders() },
        body: JSON.stringify({ reason: "Cancelled from the Control Panel" }),
      });
    } catch {
      // The detail poll remains authoritative and will keep the run visible.
    }
  };

  // Durable workflow runs, polled from the Ops API while the cockpit is open.
  // Two calls per tick: ?status=running catches long-running runs that a busy
  // recent page would evict (filter-after-limit), and the unfiltered page
  // supplies the recently-finished tail — a just-finished run stays visible
  // for a few minutes before fading.
  const [wfRuns, setWfRuns] = useState<WorkflowRunRow[]>([]);
  // Apps being refreshed — polled so a refresh (prompt apps run as a plain agent
  // session with NO workflow_run, so they'd otherwise be invisible here) shows up
  // in the Control Panel while it runs and just after.
  const [appRows, setAppRows] = useState<AppRunRow[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const d = await opsFetch<{ items: AppRunRow[] }>("/api/ops/apps");
        if (alive) setAppRows(d.items ?? []);
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  // Scope the Apps section to THIS chat thread: only apps this conversation
  // created / edited / refreshed (merged.appIds, matched by id or slug), so an
  // app refreshing from a cron in some other context no longer leaks in. The
  // thread's own apps stay pinned in the panel for the session (no time filter).
  const chatAppIds = useMemo(() => new Set(merged.appIds), [merged.appIds]);
  const visibleApps = useMemo(
    () => appRows.filter((a) => chatAppIds.has(a.id) || chatAppIds.has(a.slug)),
    [appRows, chatAppIds],
  );
  // The run whose detail is open — a snapshot pinned at click time, so the
  // detail view survives the run aging out of (or re-entering) the list.
  const [selectedWfRun, setSelectedWfRun] = useState<WorkflowRunRow | null>(null);
  // A person / artifact card the operator clicked — each opens a contextual
  // modal (person record; cron def / workflow script / published file).
  const [selectedPerson, setSelectedPerson] = useState<PersonItem | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<CockpitArtifact | null>(null);
  const [selectedTask, setSelectedTask] = useState<CtxItem | null>(null);
  // A live browser session opened from the "Live browser" card — the interactive
  // Browserbase live view fills the rail so the operator can watch OR take over.
  const [selectedLiveView, setSelectedLiveView] = useState<{ sessionRef: string; url: string } | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  // An app opened from the Apps section — its rendered dashboard fills the rail.
  // We pin the id (not the row) so live poll updates (refresh finishing) flow in.
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const selectedApp = useMemo(
    () => (selectedAppId ? (appRows.find((a) => a.id === selectedAppId) ?? null) : null),
    [selectedAppId, appRows],
  );
  const detailOpen = Boolean(
    selectedRun || selectedWfRun || selectedArtifact || selectedTask || selectedApp || selectedLiveView,
  );
  useEffect(() => {
    onDetailChange?.(detailOpen);
  }, [detailOpen, onDetailChange]);

  // Cross-surface focus (pinned contract with agent-chat.tsx): when the chat
  // asks for a specific delegation via focusSubagentCallId, select that run's
  // detail view and acknowledge with onFocusConsumed(). If the run isn't in
  // merged.subagents yet, no-op WITHOUT consuming — the parent re-renders us
  // when it appears and the request is honored then.
  useEffect(() => {
    if (!focusSubagentCallId) return;
    if (!merged.subagents.some((s) => s.callId === focusSubagentCallId)) return;
    setSelected(focusSubagentCallId);
    setSelectedWfRun(null);
    onFocusConsumed?.();
  }, [focusSubagentCallId, merged.subagents, onFocusConsumed]);
  // Sequence guard: each tick takes a ticket when it STARTS; only a response
  // newer than the last applied one may write state, so a slow response can
  // never overwrite fresher data (same pattern as workflows-panel.tsx).
  const wfSeqRef = useRef(0);
  const wfAppliedRef = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      const ticket = ++wfSeqRef.current;
      try {
        const [running, recent] = await Promise.all([
          opsFetch<{ runs: WorkflowRunRow[] }>("/api/ops/workflow-runs?status=running&limit=25"),
          opsFetch<{ runs: WorkflowRunRow[] }>("/api/ops/workflow-runs?limit=10"),
        ]);
        if (!alive || ticket <= wfAppliedRef.current) return;
        wfAppliedRef.current = ticket;
        const seen = new Set<string>();
        const merged = [...running.runs, ...recent.runs].filter((r) =>
          seen.has(r.runId) ? false : (seen.add(r.runId), true),
        );
        setWfRuns(merged);
      } catch {
        // Best-effort telemetry — the cockpit never surfaces polling errors.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Recently-AUTHORED workflows — so a script the operator just wrote (⌘K, or a
  // future agent tool) appears the moment it lands in the workflows table,
  // BEFORE any run. Polled slower than runs; the list carries the full script.
  const [wfDefs, setWfDefs] = useState<WorkflowDef[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const d = await opsFetch<{ items: WorkflowDef[] }>("/api/ops/workflows");
        if (alive) setWfDefs(d.items ?? []);
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 12000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Artifacts to keep at hand while authoring: workflows just authored (inline
  // script, freshest first), then the SCRIPT of every workflow that has run
  // (fetched on open), plus the cron definitions and published files the
  // conversation itself produced.
  // Workflow scripts are surfaced ONLY when THIS conversation actually touched a
  // workflow — the agent delegated to a workflow subagent (authored/edited) or
  // ran one. The `/api/ops/workflows` + `/api/ops/workflow-runs` polls are
  // system-wide, so without this gate a workflow that merely ran on a cron
  // (e.g. route-incident) would spuriously appear on every chat.
  const chatWorkflowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of merged.subagents) {
      const p = s.delegationPart as { toolMetadata?: { eve?: { workflowId?: string } } } | undefined;
      const wid = p?.toolMetadata?.eve?.workflowId;
      if (typeof wid === "string" && wid) ids.add(wid);
    }
    return ids;
  }, [merged.subagents]);
  const chatDidWorkflow = chatWorkflowIds.size > 0 || merged.subagents.some((s) => /workflow/i.test(s.name));

  // Which workflow runs to show. The Control Panel is scoped to THIS chat, so it
  // shows ONLY runs the conversation is responsible for: ones it TRIGGERED
  // (trigger_workflow → runId captured in insights) or whose workflow it
  // AUTHORED/ran (delegation carries the workflowId). It deliberately does NOT
  // show arbitrary running or recently-updated system runs — a cron fire
  // (oncall-handoff, roster-sweep, …) or another chat's run must never leak onto
  // this panel. The runs poll is system-wide; this filter is what keeps the
  // panel from being a global run feed.
  const triggeredRunIds = useMemo(() => new Set(merged.workflowRunIds), [merged.workflowRunIds]);
  const visibleRuns = useMemo(() => {
    const seen = new Set<string>();
    return wfRuns.filter((r) => {
      if (seen.has(r.runId)) return false;
      seen.add(r.runId);
      if (triggeredRunIds.has(r.runId)) return true;
      if (r.workflowId && chatWorkflowIds.has(r.workflowId)) return true;
      return false;
    });
  }, [wfRuns, chatWorkflowIds, triggeredRunIds]);

  const artifacts = useMemo<CockpitArtifact[]>(() => {
    if (!chatDidWorkflow) return merged.artifacts;
    const AUTHORED_WINDOW = 15 * 60_000;
    const relevant = (id: string) => chatWorkflowIds.size === 0 || chatWorkflowIds.has(id);
    // Only workflows the agent is actually AUTHORING/EDITING this session appear
    // as script artifacts (recently-updated + touched by this chat). A workflow
    // that merely RAN is surfaced in the Workflows section as a run — its script
    // is not an artifact of this conversation, so it's intentionally excluded.
    const authored: CockpitArtifact[] = wfDefs
      .filter((w) => w.script && relevant(w.id) && Date.now() - Date.parse(w.updatedAt) < AUTHORED_WINDOW)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((w) => ({
        id: `wf:${w.id}`,
        label: unkebab(w.name),
        kind: "workflow" as const,
        sub: `authored ${relTime(Date.parse(w.updatedAt))}`,
        content: w.script ?? undefined,
        workflowId: w.id,
      }));
    return [...authored, ...merged.artifacts];
  }, [chatDidWorkflow, chatWorkflowIds, wfDefs, merged.artifacts]);

  // The selected run's workflow: the static phase skeleton for the graph and the
  // script behind the (i). The analyzer is server-only, so both come from the API.
  const [wfMeta, setWfMeta] = useState<{ script: string | null; phases: GraphPhase[] } | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  // The freshest polled run, reported up by the detail so the ONE header row
  // (merged into the Back bar) can show live status.
  const [liveWfRun, setLiveWfRun] = useState<WorkflowRunRow | null>(null);
  // The Workflow / Phase context of the opened step, for its header breadcrumb.
  const [stepCtx, setStepCtx] = useState<{ workflow: string; phase: string } | null>(null);
  const openStepAgent = useCallback((e: RunJournalEntry, workflow: string, phase: string) => {
    const session = e.childSessionId ?? e.sessionId;
    if (!session) return;
    setStepCtx({ workflow, phase });
    setStepRun({
      callId: `wfstep:${e.callIndex}:${session}`,
      name: e.subagent ?? "agent",
      childSessionId: session,
      status: e.status === "running" ? "running" : "done",
      output: e.resultPreview ?? undefined,
      activity: e.promptPreview ? [e.promptPreview] : [],
    });
  }, []);
  const selectedWfId = selectedWfRun?.workflowId ?? null;
  useEffect(() => {
    setWfMeta(null);
    setLiveWfRun(null);
    if (!selectedWfId) return;
    let alive = true;
    opsFetch<{ item: { script: string | null }; analysis: { phases: GraphPhase[] } | null }>(
      `/api/ops/workflows/${selectedWfId}`,
    )
      .then((d) => {
        if (alive) setWfMeta({ script: d.item?.script ?? null, phases: d.analysis?.phases ?? [] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [selectedWfId]);
  const wfHeader = liveWfRun ?? selectedWfRun;

  const hasAnything =
    visibleRuns.length > 0 ||
    visibleApps.length > 0 ||
    browser.views.length > 0 ||
    browser.errors.length > 0 ||
    merged.subagents.length > 0 ||
    merged.people.length > 0 ||
    merged.workload.length > 0 ||
    artifacts.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-border border-b px-3">
        {selectedRun ? (
          // Back affordance IS the subagent identity: chevron + mark + name,
          // with the live status right beside it.
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="flex min-w-0 items-center gap-2 text-sm hover:opacity-80"
              title="Back to the Control Panel"
            >
              <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground" />
              <CustomerMark name={nameOf(selectedRun)} size="sm" />
              <span className="flex min-w-0 items-baseline gap-1 truncate font-medium">
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {subagentDisplayName(selectedRun.name)}/
                </span>
                {nameOf(selectedRun)}
              </span>
            </button>
            {selectedRun.status === "running" ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-2xs text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                Running
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-2xs text-muted-foreground">
                Done
              </span>
            )}
          </span>
        ) : stepRun ? (
          // A workflow step opened in the rail — back returns to its run graph.
          // The breadcrumb is Workflow / Phase / Agent.
          <span className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setStepRun(null);
                setStepCtx(null);
              }}
              className="flex min-w-0 items-center gap-1.5 text-sm hover:opacity-80"
              title="Back to the run"
            >
              <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground" />
              <CustomerMark name={subagentDisplayName(stepRun.name)} size="sm" />
              <span className="flex min-w-0 items-center gap-1 truncate font-medium">
                {stepCtx ? (
                  <>
                    <span className="shrink truncate text-muted-foreground">{unkebab(stepCtx.workflow)}</span>
                    <span className="shrink-0 text-muted-foreground/40">/</span>
                    <span className="shrink-0 text-muted-foreground">{stepCtx.phase}</span>
                    <span className="shrink-0 text-muted-foreground/40">/</span>
                  </>
                ) : null}
                <span className="shrink-0">{subagentDisplayName(stepRun.name)}</span>
              </span>
            </button>
            {stepRun.status === "running" ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-2xs text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                Running
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-2xs text-muted-foreground">
                Done
              </span>
            )}
          </span>
        ) : selectedWfRun ? (
          // ONE row: the back affordance carries the run's identity and status,
          // with the script (i) on the right — no second header beneath it.
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedWfRun(null)}
              className="flex min-w-0 items-center gap-2 text-sm hover:opacity-80"
              title="Back to the Control Panel"
            >
              <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground" />
              <RunStatusDot status={runDotStatus((wfHeader ?? selectedWfRun).status)} />
              <span className="min-w-0 truncate font-medium">
                {unkebab((wfHeader ?? selectedWfRun).workflowName)}
              </span>
            </button>
            <span className="shrink-0 text-muted-foreground text-xs">
              {(wfHeader ?? selectedWfRun).status === "running"
                ? `running · attempt ${(wfHeader ?? selectedWfRun).attempts}`
                : (wfHeader ?? selectedWfRun).status === "failed"
                  ? "failed"
                  : (wfHeader ?? selectedWfRun).status === "cancelled"
                    ? "cancelled"
                  : "done"}
            </span>
            {wfMeta?.script ? (
              <button
                type="button"
                onClick={() => setScriptOpen(true)}
                title="View the workflow script"
                aria-label="View the workflow script"
                className="ml-auto shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <InfoIcon className="size-3.5" />
              </button>
            ) : null}
          </span>
        ) : selectedArtifact ? (
          <button
            type="button"
            onClick={() => setSelectedArtifact(null)}
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
            title="Back to the Control Panel"
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate font-medium">{selectedArtifact.label}</span>
          </button>
        ) : selectedTask ? (
          <button
            type="button"
            onClick={() => setSelectedTask(null)}
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
            title="Back to the Control Panel"
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate font-medium">{selectedTask.label}</span>
          </button>
        ) : selectedApp ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedAppId(null)}
              className="flex min-w-0 items-center gap-2 text-sm hover:opacity-80"
              title="Back to the Control Panel"
            >
              <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground" />
              <RunStatusDot
                status={
                  selectedApp.refreshingAt ? "running" : selectedApp.lastError ? "failed" : "success"
                }
              />
              <span className="min-w-0 truncate font-medium">{unkebab(selectedApp.name)}</span>
            </button>
            <span className="shrink-0 text-muted-foreground text-xs">
              {selectedApp.refreshingAt
                ? "refreshing…"
                : selectedApp.contentUpdatedAt
                  ? `refreshed ${fmtElapsed(selectedApp.contentUpdatedAt)} ago`
                  : "never refreshed"}
            </span>
            <button
              type="button"
              onClick={() => onOpenOps?.("apps", selectedApp.id)}
              title="Open in the Apps workspace"
              aria-label="Open in the Apps workspace"
              className="ml-auto shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <ArrowUpRightIcon className="size-3.5" />
            </button>
          </span>
        ) : selectedLiveView ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedLiveView(null)}
              className="flex min-w-0 items-center gap-2 text-sm hover:opacity-80"
              title="Back to the Control Panel"
            >
              <ChevronLeftIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              <span className="min-w-0 truncate font-medium">Live browser</span>
            </button>
            <span className="ml-auto shrink-0 text-muted-foreground text-xs">interactive — click to take control</span>
          </span>
        ) : (
          <span className="font-medium text-sm">Control Panel</span>
        )}
        <span className="flex items-center gap-1">
          {selectedWfRun && (wfHeader ?? selectedWfRun).status === "running" ? (
            <button
              type="button"
              onClick={() => void cancelSelectedWorkflowRun()}
              className="rounded-md p-1 text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600"
              aria-label="Cancel workflow run"
              title="Cancel workflow run"
            >
              <SquareIcon className="size-4" />
            </button>
          ) : null}
          {railRun?.childSessionId &&
          railRun.status === "running" &&
          railFeed?.turnActive !== false ? (
            <button
              type="button"
              onClick={() => void cancelSelectedRun()}
              className="rounded-md p-1 text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600"
              aria-label="Cancel run"
              title="Cancel run"
            >
              <SquareIcon className="size-4" />
            </button>
          ) : railRun?.childSessionId && railFeed?.continuationToken ? (
            <button
              type="button"
              onClick={() => void resumeSelectedRun()}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-emerald-600"
              aria-label="Resume run"
              title="Resume run"
            >
              <PlayIcon className="size-4" />
            </button>
          ) : null}
          {railRun ? (
            <button
              type="button"
              onClick={() => setInfoOpen(true)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label="About this subagent"
              title="About this subagent"
            >
              <InfoIcon className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCollapse}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Collapse control panel"
          >
            <PanelRightCloseIcon className="size-4" />
          </button>
        </span>
        {railRun ? (
          <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
            <DialogContent className="flex h-[80vh] flex-col overflow-hidden sm:max-w-[60vw]">
              <DialogHeader className="shrink-0">
                <DialogTitle className="flex items-center gap-2">
                  <CustomerMark name={subagentDisplayName(railRun.name)} size="md" />
                  {subagentDisplayName(railRun.name)} subagent
                </DialogTitle>
              </DialogHeader>
              {/* Everything below the title scrolls together — the description
                  must never pin/stick above the tools. */}
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
                <DialogDescription className="text-left">
                  {SUBAGENT_META[railRun.name]?.description ||
                    subagentDescription(railRun.name)}
                </DialogDescription>
                <SubagentInfoBody name={railRun.name} />
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {selectedRun ? (
        <SubagentDetail
          appendLocal={appendLocal}
          feed={selectedRun.childSessionId ? feeds[selectedRun.childSessionId] : undefined}
          onInputResponses={onInputResponses}
          run={selectedRun}
        />
      ) : stepRun ? (
        <SubagentDetail
          appendLocal={appendLocal}
          feed={stepRun.childSessionId ? feeds[stepRun.childSessionId] : undefined}
          onInputResponses={onInputResponses}
          run={stepRun}
        />
      ) : selectedWfRun ? (
        <WorkflowRunDetail
          runId={selectedWfRun.runId}
          fallback={selectedWfRun}
          phases={wfMeta?.phases ?? []}
          onRun={setLiveWfRun}
          onOpenAgent={openStepAgent}
        />
      ) : selectedArtifact ? (
        <ArtifactDetail artifact={selectedArtifact} />
      ) : selectedApp ? (
        <AppRunDetail app={selectedApp} onOpenOps={onOpenOps} />
      ) : selectedLiveView ? (
        <LiveBrowserView
          view={selectedLiveView}
          onError={(m) => setControlError(m)}
          error={controlError}
        />
      ) : selectedTask ? (
        <TaskDetail task={selectedTask} onOpenOps={onOpenOps} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {merged.subagents.length > 0 ? (
            <Section icon={Bot} title="Subagents" count={merged.subagents.length}>
              <SubagentList feeds={feeds} runs={merged.subagents} nameOf={nameOf} onSelect={setSelected} />
            </Section>
          ) : null}
          {visibleRuns.length > 0 ? (
            <Section icon={Workflow} title="Workflows" count={visibleRuns.length}>
              <WorkflowRunList runs={visibleRuns} onSelect={setSelectedWfRun} />
            </Section>
          ) : null}
          {browser.views.length > 0 ? (
            <Section icon={GlobeIcon} title="Live browser" count={browser.views.length}>
              <ul className="flex flex-col gap-1">
                {browser.views.map((b) => (
                  <li key={b.sessionRef}>
                    <button
                      type="button"
                      onClick={() => setSelectedLiveView(b)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
                      title="Watch — or take control of — this browser session"
                    >
                      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                      <span className="min-w-0 flex-1 truncate text-sm">Watch this session live</span>
                      <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {browser.errors.length > 0 ? (
            <Section icon={GlobeIcon} title="Browser errors" count={browser.errors.length}>
              <ul className="flex flex-col gap-1">
                {browser.errors.map((e, i) => (
                  <li
                    key={`${e.tool}-${i}`}
                    className="rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2"
                  >
                    <div className="font-mono text-xs font-medium text-destructive">{e.tool}</div>
                    <div className="mt-0.5 break-words text-xs text-muted-foreground">{e.error}</div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {visibleApps.length > 0 ? (
            <Section icon={LayoutDashboardIcon} title="Apps" count={visibleApps.length}>
              <AppRunList apps={visibleApps} onOpen={(a) => setSelectedAppId(a.id)} />
            </Section>
          ) : null}
          {/* Customers deliberately have NO section here — the chat's customer
              context lives as icon chips in the top-right selector, and an agent
              list_customers call would otherwise dump the whole roster into this
              rail. */}
          {merged.people.length > 0 ? (
            <Section icon={Users} title="People" count={merged.people.length}>
              <PeopleList people={merged.people} onSelect={setSelectedPerson} />
            </Section>
          ) : null}
          {artifacts.length > 0 ? (
            <Section icon={PaperclipIcon} title="Artifacts" count={artifacts.length}>
              <ArtifactList
                items={artifacts}
                onSelect={(a) => {
                  // A previewable published file goes to the chat's artifact
                  // panel; everything else (scripts, cron defs) opens inline.
                  const previewable =
                    a.kind === "file" && a.href && artifactFromHref(a.href) !== null;
                  if (previewable && onOpenArtifact) {
                    const art = artifactFromHref(a.href!)!;
                    onOpenArtifact(art.url, art.filename);
                    return;
                  }
                  setSelectedArtifact(a);
                }}
              />
            </Section>
          ) : null}
          {merged.workload.length > 0 ? (
            <Section icon={ListTodo} title="Tasks" count={merged.workload.length}>
              <CtxList items={merged.workload} onSelect={setSelectedTask} />
            </Section>
          ) : null}
          {!hasAnything ? (
            <p className="px-1 py-10 text-center text-muted-foreground text-xs">
              Live context appears here as the agent pulls {DEPLOYMENT_PROFILE.vocabulary.account.plural}, people, tasks, runs
              subagents, and produces artifacts.
            </p>
          ) : null}
        </div>
      )}
      <PersonModal
        person={selectedPerson}
        onClose={() => setSelectedPerson(null)}
        onOpenOps={onOpenOps}
      />
      {/* The active workflow's script, read-only — the source the phase graph
          was parsed from. Opened by the (i) in the header row. */}
      <Dialog open={scriptOpen} onOpenChange={setScriptOpen}>
        <DialogContent className="flex h-[80vh] flex-col overflow-hidden sm:max-w-[70vw]">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Workflow className="size-4 text-muted-foreground" />
              {selectedWfRun ? unkebab(selectedWfRun.workflowName) : "Workflow"}
            </DialogTitle>
            <DialogDescription className="text-left">
              The workflow script this run is executing.
            </DialogDescription>
          </DialogHeader>
          <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-2xs leading-relaxed">
            {wfMeta?.script || "— no script —"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  readonly icon: typeof Bot;
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 px-1 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
        <Icon className="size-3" />
        {title}
        <span className="text-muted-foreground/50">{count}</span>
      </p>
      {children}
    </div>
  );
}

/** The stable identity of a run — its child session id, else the tool-call id.
 *  This is the key its persisted codename is stored under. */
function runKeyOf(run: SubagentRun): string {
  return run.childSessionId || run.callId;
}

function SubagentList({
  feeds,
  runs,
  nameOf,
  onSelect,
}: {
  readonly feeds: Record<string, ChildFeed>;
  readonly runs: SubagentRun[];
  /** The run's assigned codename (persisted). */
  readonly nameOf: (run: SubagentRun) => string;
  readonly onSelect: (callId: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((r) => {
        const type = subagentDisplayName(r.name);
        const name = nameOf(r);
        // Live tool-call count straight from the child's own stream — the
        // message parts only carry the delegation brief, so counting those
        // froze at "1 step" forever.
        const feed = r.childSessionId ? feeds[r.childSessionId] : undefined;
        const toolRows = feed?.rows.filter(
          (row): row is Extract<FeedRow, { kind: "tool" }> => row.kind === "tool",
        ) ?? [];
        const doneCount = toolRows.filter((row) => row.status === "done").length;
        const current = toolRows.findLast((row) => row.status === "running");
        const status =
          r.status === "running"
            ? current
              ? `${toolDisplayName(current.raw)} · ${doneCount} of ${toolRows.length} calls done`
              : toolRows.length > 0
                ? `${doneCount} tool calls done · thinking…`
                : "starting…"
            : `done · ${toolRows.length || r.activity.length || "—"} calls`;
        return (
          <li key={r.callId}>
            <button
              type="button"
              onClick={() => onSelect(r.callId)}
              className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
            >
              <CustomerMark name={name} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">{name}</span>
                <span className="block truncate text-2xs text-muted-foreground">{`${type} · ${status}`}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How many people render before the list collapses behind "Show all N". */
const PEOPLE_CAP = 8;

/** "FDE owner · Axis Bank, Tata Capital +3" — or just the role(s) when unattributed. */
function personSub(p: PersonItem): string | null {
  const role = p.roles.join(", ");
  if (p.accounts.length === 0) return role || null;
  const shown = p.accounts.slice(0, 2).join(", ");
  const extra = p.accounts.length > 2 ? ` +${p.accounts.length - 2}` : "";
  return [role, `${shown}${extra}`].filter(Boolean).join(" · ");
}

function PeopleList({
  people,
  onSelect,
}: {
  readonly people: PersonItem[];
  readonly onSelect: (p: PersonItem) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? people : people.slice(0, PEOPLE_CAP);
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {visible.map((p) => {
          const sub = personSub(p);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
                title="Open this person"
              >
                <CustomerMark name={p.label} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{p.label}</span>
                  {sub ? (
                    <span className="block truncate text-2xs text-muted-foreground">{sub}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {people.length > PEOPLE_CAP ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start rounded-md px-1 py-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {showAll ? "Show fewer" : `Show all ${people.length}`}
        </button>
      ) : null}
    </div>
  );
}

function CtxList({ items, onSelect }: { readonly items: CtxItem[]; readonly onSelect?: (it: CtxItem) => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((it) => {
        const body = (
          <>
            <span className="block truncate font-medium text-sm">{it.label}</span>
            {it.sub ? (
              <span className="block truncate text-2xs text-muted-foreground">{it.sub}</span>
            ) : null}
          </>
        );
        return (
          <li key={it.id}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(it)}
                className="w-full rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
              >
                {body}
              </button>
            ) : (
              <div className="rounded-lg border border-border/60 px-2.5 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * An artifact worth keeping at hand while authoring. `workflow` fetches its
 * script on open; `cron` carries its definition inline; `file` opens a signed
 * URL. Extends the stream's ArtifactItem with the workflow-run source.
 */
export type CockpitArtifact = Omit<ArtifactItem, "kind"> & {
  kind: "file" | "cron" | "workflow";
  workflowId?: string | null;
};

/** A row of GET /api/ops/workflows (full row; `script` + `updatedAt` used here). */
type WorkflowDef = { id: string; name: string; script: string | null; updatedAt: string };

/** "just now" / "3m ago" / "2h ago" for a ms timestamp. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function ArtifactIcon({ kind }: { readonly kind: CockpitArtifact["kind"] }) {
  const Icon = kind === "workflow" ? Workflow : kind === "cron" ? AlarmClockIcon : PaperclipIcon;
  return <Icon className="size-3.5" />;
}

function ArtifactList({
  items,
  onSelect,
}: {
  readonly items: CockpitArtifact[];
  readonly onSelect: (a: CockpitArtifact) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onSelect(a)}
            className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
            title="Open this artifact"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
              <ArtifactIcon kind={a.kind} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sm">{a.label}</span>
              <span className="block truncate text-2xs text-muted-foreground">{a.sub ?? a.kind}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// The comprehensive dossier from GET /api/ops/people/:email.
type PersonDossier = {
  found: boolean;
  identity: {
    name: string;
    email: string;
    title: string | null;
    org: string | null;
    role: string | null;
    kind: string;
    lastContact: string | null;
  } | null;
  team: string | null;
  /** Who this person reports to (single). Null when unset. */
  managerEmail: string | null;
  /** Manager links walked upward — immediate manager first, up to the top. */
  chainUp: { email: string; name: string; title: string | null; role: string | null }[];
  reportees: { email: string; name: string; title: string | null; role: string | null }[];
  /** Escalation contacts: multiple managers, each pinged under a condition. */
  escalations: { email: string; name: string; title: string | null; role: string | null; reason: string }[];
  accounts: { id: string; name: string; role: string | null; title: string | null; lastContact: string | null }[];
  tickets: { id: string; summary: string; status: string; priority: string; customer: string | null; customerLabel: string | null }[];
  deployments: { id: string; customer: string | null; customerLabel: string | null; env: string; version: string; health: string; status: string }[];
  implementations: { id: string; customer: string | null; customerLabel: string | null; stage: string; risk: string; progress: number | null }[];
  todos: { id: string; title: string; done: boolean; priority: string; dueAt: string | null; container: string | null; customer: string | null }[];
};

const PRIO_DOT: Record<string, string> = {
  high: "bg-red-500",
  critical: "bg-red-500",
  normal: "bg-muted-foreground/40",
  medium: "bg-amber-500",
  low: "bg-sky-500/60",
};
function healthDot(h: string): string {
  return h === "healthy" ? "bg-emerald-500" : h === "degraded" ? "bg-amber-500" : "bg-red-500";
}

function Pill({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-2xs text-foreground/80">
      {children}
    </span>
  );
}

/** One ownership section (Tickets / Deployments / Implementations / TODOs).
 *  A plain section header + rows — no enclosing card. */
function OwnPanel({
  icon: Icon,
  title,
  count,
  children,
}: {
  readonly icon: typeof TicketIcon;
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 border-b border-border/50 pb-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">{title}</span>
        <span className="text-2xs text-muted-foreground/50 tabular-nums">{count}</span>
      </div>
      {count === 0 ? (
        <p className="text-2xs text-muted-foreground/40 italic">None</p>
      ) : (
        <ul className="flex flex-col gap-0.5">{children}</ul>
      )}
    </section>
  );
}

function OwnRow({
  dot,
  primary,
  chips,
  onClick,
}: {
  readonly dot: string;
  readonly primary: string;
  readonly chips: React.ReactNode;
  readonly onClick?: () => void;
}) {
  const inner = (
    <>
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0 flex-1 truncate text-xs">{primary}</span>
      <span className="flex shrink-0 items-center gap-1">{chips}</span>
    </>
  );
  return (
    <li>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/40"
        >
          {inner}
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">{inner}</div>
      )}
    </li>
  );
}


/** Suggested escalation triggers — a fixed set surfaced via a <datalist>, but
 *  the field stays free text so an operator can type anything. */
const ESCALATION_TRIGGERS = [
  "Client escalation",
  "Technical blocker",
  "SLA breach",
  "Security incident",
  "Outage / P1",
  "Data / migration issue",
  "Go-live / launch",
  "Billing / commercial",
  "After-hours / on-call",
] as const;

/** A dashed "+" node in the escalation rail — the add affordance lives IN the

/** Editable reporting + escalation for the active person. "Reports to" is a
 *  single manager (the reporting chain); escalation is MULTIPLE managers, each
 *  pinged under a condition ("client escalation", "technical blocker", …). */
type Person = { email: string; name: string; title: string | null; role: string | null };

/**
 * ONE continuous reporting & escalation timeline: managers above, the person
 * themself, their escalation contacts hanging directly BELOW them (editable,
 * with inline "+" nodes at every stage), then their reportees. Rendering it as a
 * single flat entry list is what keeps the rail unbroken — the connecting lines
 * are derived from each entry's index across the whole timeline, so the
 * escalation rows read as part of the chain rather than a detached list.
 */
function ReportingEscalationTimeline({
  self,
  chainUp,
  reportees,
  escalations,
  roster,
  onSave,
}: {
  readonly self: { email: string; name: string };
  readonly chainUp: Person[];
  readonly reportees: Person[];
  readonly escalations: { email: string; reason: string }[];
  readonly roster: { email: string; name: string | null }[];
  readonly onSave: (body: {
    managerEmail?: string | null;
    escalations?: { email: string; reason: string }[];
  }) => void;
}) {
  const [rows, setRows] = useState(() => escalations.map((e) => ({ email: e.email, reason: e.reason })));
  useEffect(() => {
    setRows(escalations.map((e) => ({ email: e.email, reason: e.reason })));
    // Re-sync ONLY when the person changes. Syncing on every `escalations`
    // update would wipe a half-filled row the instant a save round-trips —
    // picking a person (no reason yet) saved a filtered list that excluded the
    // row, and the refetch then deleted it from under the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self.email]);
  const others = roster.filter((r) => r.email.toLowerCase() !== self.email.toLowerCase());
  // Persist only complete rows; incomplete ones stay in local state while editing.
  const commit = (next: { email: string; reason: string }[]) => {
    setRows(next);
    onSave({ escalations: next.filter((r) => r.email && r.reason.trim()) });
  };
  // Picking a person alone never saves (the row has no trigger yet) — it would
  // persist nothing and drop the row. Save only once the row is complete.
  const setPerson = (i: number, email: string) => {
    const next = rows.map((r, j) => (j === i ? { ...r, email } : r));
    if (next[i].reason.trim()) commit(next);
    else setRows(next);
  };
  // Which row is open for editing. A row also counts as "editing" while it's
  // still incomplete — a committed contact renders as a compact node instead.
  const [editing, setEditing] = useState<number | null>(null);
  const isEditing = (i: number) => editing === i || !rows[i].email || !rows[i].reason.trim();
  const nameFor = (email: string) => roster.find((r) => r.email === email)?.name ?? email;
  const insertAt = (at: number) => {
    setRows([...rows.slice(0, at), { email: "", reason: "" }, ...rows.slice(at)]);
    setEditing(at);
  };
  const field =
    "min-w-0 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-foreground/90 focus:border-foreground/30 focus:outline-none";
  const subOf = (p: Person) => [p.title, p.role].filter(Boolean).join(" · ") || p.email;

  type Entry =
    | { k: "up" | "down"; key: string; name: string; sub: string }
    | { k: "self"; key: string; name: string }
    | { k: "esc"; key: string; i: number }
    | { k: "add"; key: string; at: number; label: boolean };
  const entries: Entry[] = [
    ...[...chainUp].reverse().map((p) => ({ k: "up" as const, key: `up-${p.email}`, name: p.name, sub: subOf(p) })),
    { k: "self", key: "self", name: self.name },
    // Contacts run as an unbroken line under the person; a SINGLE trailing "+"
    // appends the next one (interleaved add-nodes fragmented the rail).
    ...rows.map((_, i) => ({ k: "esc" as const, key: `esc-${i}`, i })),
    { k: "add", key: "add", at: rows.length, label: true },
    ...reportees.map((p) => ({ k: "down" as const, key: `down-${p.email}`, name: p.name, sub: subOf(p) })),
  ];
  return (
    <div className="flex w-full flex-col">
      {/* Fixed suggestions for the trigger, but the field stays free text. */}
      <datalist id="escalation-triggers">
        {ESCALATION_TRIGGERS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {entries.map((e, idx) => {
        const first = idx === 0;
        const last = idx === entries.length - 1;
        return (
          <div key={e.key} className="flex items-stretch gap-3">
            <div className="flex w-4 flex-col items-center">
              <span className={cn("w-px flex-1", first ? "bg-transparent" : "bg-border")} />
              {e.k === "add" ? (
                <button
                  type="button"
                  onClick={() => insertAt(e.at)}
                  aria-label="Add escalation contact"
                  className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 bg-background text-muted-foreground ring-2 ring-background transition-colors hover:border-primary hover:text-primary"
                >
                  <PlusIcon className="size-2.5" />
                </button>
              ) : (
                <span
                  className={cn(
                    "shrink-0 rounded-full ring-2 ring-background",
                    e.k === "self"
                      ? "size-2.5 bg-amber-400"
                      : e.k === "up"
                        ? "size-2 bg-indigo-400"
                        : e.k === "down"
                          ? "size-2 bg-emerald-500"
                          : "size-2 bg-amber-400",
                  )}
                />
              )}
              <span className={cn("w-px flex-1", last ? "bg-transparent" : "bg-border")} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
              {e.k === "self" ? (
                <span className="truncate font-semibold text-amber-300 text-xs">{e.name}</span>
              ) : e.k === "up" || e.k === "down" ? (
                <>
                  <span className="truncate font-medium text-xs">{e.name}</span>
                  <span className="truncate text-2xs text-muted-foreground">· {e.sub}</span>
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground/50">
                    {e.k === "up" ? "escalates ↑" : "reports ↓"}
                  </span>
                </>
              ) : e.k === "add" ? (
                e.label ? (
                  <button
                    type="button"
                    onClick={() => insertAt(e.at)}
                    className="text-2xs text-muted-foreground/60 transition-colors hover:text-primary"
                  >
                    Add contact
                  </button>
                ) : null
              ) : e.k === "esc" ? (
                isEditing(e.i) ? (
                  <>
                    <Select value={rows[e.i].email || undefined} onValueChange={(v) => setPerson(e.i, v)}>
                      <SelectTrigger className="h-7 w-40 shrink-0 text-xs">
                        <SelectValue placeholder="Select person" />
                      </SelectTrigger>
                      <SelectContent>
                        {others.map((r) => (
                          <SelectItem key={r.email} value={r.email} className="text-xs">
                            {r.name ?? r.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="shrink-0 text-2xs text-muted-foreground/50">ping when</span>
                    <input
                      value={rows[e.i].reason}
                      list="escalation-triggers"
                      placeholder="client escalation, technical blocker…"
                      autoFocus={editing === e.i && Boolean(rows[e.i].email)}
                      onChange={(ev) =>
                        setRows(rows.map((r, j) => (j === e.i ? { ...r, reason: ev.target.value } : r)))
                      }
                      onBlur={() => {
                        commit(rows);
                        // A complete row collapses to its compact node.
                        if (rows[e.i].email && rows[e.i].reason.trim()) setEditing(null);
                      }}
                      className={cn(field, "min-w-0 flex-1")}
                    />
                    <button
                      type="button"
                      aria-label="Remove escalation contact"
                      onClick={() => commit(rows.filter((_, j) => j !== e.i))}
                      className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-red-400"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </>
                ) : (
                  // Committed: a compact node matching the chain's look, not a form.
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing(e.i)}
                      title="Edit this escalation contact"
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:opacity-80"
                    >
                      <span className="truncate font-medium text-xs">{nameFor(rows[e.i].email)}</span>
                      <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 font-medium text-2xs text-amber-300">
                        {rows[e.i].reason}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label="Remove escalation contact"
                      onClick={() => commit(rows.filter((_, j) => j !== e.i))}
                      className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:text-red-400"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </>
                )
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A small labelled block for the org / accounts strip. */
function DossierBit({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Comprehensive dossier modal for a person clicked in the rail: identity + org
 * position (team / manager / reportees), the accounts they touch, and
 * everything they own across the data room — tickets, deployments,
 * implementations, and todos — fetched live from /api/ops/people/:email.
 */
function PersonModal({
  person,
  onClose,
  onOpenOps,
}: {
  readonly person: PersonItem | null;
  readonly onClose: () => void;
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
}) {
  const [d, setD] = useState<PersonDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  // The org roster, for the reports-to / escalation pickers.
  const [roster, setRoster] = useState<{ email: string; name: string | null }[]>([]);
  useEffect(() => {
    if (!person) return;
    let alive = true;
    opsFetch<{ items: { email: string; name: string | null }[] }>("/api/ops/roster")
      .then((r) => {
        if (alive) setRoster(r.items ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [person]);
  // The account chip currently selected: scopes the ownership panels to that
  // customer and reveals the person's role + context there. null = all.
  const [acct, setAcct] = useState<string | null>(null);
  // AI-generated, grounded briefings per account (keyed by account id), fetched
  // on first selection and cached for the modal's lifetime.
  const [acctSummaries, setAcctSummaries] = useState<
    Record<string, { loading: boolean; text?: string; error?: boolean }>
  >({});
  useEffect(() => {
    setAcct(null);
    setAcctSummaries({});
  }, [person]);
  // When an account is selected, generate its briefing (once) via the agent.
  useEffect(() => {
    if (!acct || !d) return;
    const sel = d.accounts.find((a) => a.id === acct);
    const email = d.identity?.email ?? person?.id;
    if (!sel || !email) return;
    if (acctSummaries[acct]?.text || acctSummaries[acct]?.loading) return;
    let alive = true;
    setAcctSummaries((p) => ({ ...p, [acct]: { loading: true } }));
    const tk = SHOW_TICKETS ? d.tickets.filter((t) => t.customer === acct) : [];
    const dp = SHOW_DEPLOYMENTS ? d.deployments.filter((x) => x.customer === acct) : [];
    const im = SHOW_IMPLEMENTATIONS ? d.implementations.filter((x) => x.customer === acct) : [];
    const td = d.todos.filter((t) => t.customer === acct);
    const counts = {
      tickets: tk.length,
      deployments: dp.length,
      implementations: im.length,
      todos: td.length,
    };
    // Send the actual items inline so the agent never needs a tool round-trip.
    const workText = [
      ...tk.map((t) => `- Ticket ${t.id}: ${t.summary} (${t.status}, ${t.priority} priority)`),
      ...dp.map((x) => `- ${DEP.singular} ${x.id}: ${DEP.hidden("environment") ? "" : `${x.env} `}${x.version}, ${DEP.label("healthStatus", "health").toLowerCase()} ${DEP.display("healthStatus", x.health)}, ${DEP.display("releaseStatus", x.status)}`),
      ...im.map((x) => `- ${IMP.singular} ${x.id}: ${IMP.label("implementationStage", "stage").toLowerCase()} ${IMP.display("implementationStage", x.stage)}, ${IMP.label("implementationRiskLevel", "risk").toLowerCase()} ${x.risk}${x.progress != null ? `, ${Math.round(x.progress)}% complete` : ""}`),
      ...td.map((t) => `- TODO: ${t.title}${t.done ? " (done)" : ""}${t.dueAt ? `, due ${new Date(t.dueAt).toLocaleDateString()}` : ""}`),
    ]
      .slice(0, 60)
      .join("\n");
    fetch(`/api/ops/people/${encodeURIComponent(email)}/account-summary`, {
      method: "POST",
      headers: { "content-type": "application/json", ...eveAuthHeaders() },
      body: JSON.stringify({
        account: sel.name,
        accountId: sel.id,
        role: sel.role,
        title: sel.title,
        lastContact: sel.lastContact,
        person: d.identity
          ? { name: d.identity.name, title: d.identity.title, org: d.identity.org, kind: d.identity.kind }
          : undefined,
        counts,
        workText,
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { summary?: string };
      })
      .then((j) => {
        if (alive) setAcctSummaries((p) => ({ ...p, [acct]: { loading: false, text: j.summary } }));
      })
      .catch(() => {
        if (alive) setAcctSummaries((p) => ({ ...p, [acct]: { loading: false, error: true } }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acct, d]);
  useEffect(() => {
    if (!person) {
      setD(null);
      return;
    }
    let alive = true;
    setLoading(true);
    opsFetch<PersonDossier>(`/api/ops/people/${encodeURIComponent(person.id)}`)
      .then((r) => {
        if (alive) setD(r);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `reload` bumps after an edit so the chain reflects the saved links.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, reload]);

  const id = d?.identity;
  // Persist a reporting/escalation edit for the active person, then refetch.
  const saveRoster = (body: Record<string, unknown>) => {
    const email = d?.identity?.email ?? person?.id;
    if (!email) return;
    void opsFetch("/api/ops/roster", { method: "POST", body: JSON.stringify({ email, ...body }) })
      .then(() => setReload((n) => n + 1))
      .catch(() => {});
  };
  const selAcct = d?.accounts.find((a) => a.id === acct) ?? null;
  const inAcct = (c: string | null) => !acct || c === acct;
  const fTickets = SHOW_TICKETS ? (d?.tickets ?? []).filter((t) => inAcct(t.customer)) : [];
  const fDeps = SHOW_DEPLOYMENTS ? (d?.deployments ?? []).filter((x) => inAcct(x.customer)) : [];
  const fImpls = SHOW_IMPLEMENTATIONS ? (d?.implementations ?? []).filter((x) => inAcct(x.customer)) : [];
  const fTodos = (d?.todos ?? []).filter((t) => inAcct(t.customer));
  // Open the task in the Ops Center TODOs (same window), deep-linked to its
  // detail — closing the person modal so the workspace comes forward.
  const openTask = (tid: string) => {
    onOpenOps?.("todos", tid);
    onClose();
  };

  return (
    <Dialog open={Boolean(person)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[82vh] max-h-[82vh] w-[58vw] max-w-[58vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[58vw]">
        {person ? (
          <>
            <DialogHeader className="shrink-0 gap-0 space-y-0 border-b border-border/60 p-5 text-left">
              <div className="flex items-start gap-3">
                <CustomerMark name={id?.name ?? person.label} size="lg" />
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex items-center gap-2 text-base">
                    <span className="truncate">{id?.name ?? person.label}</span>
                    {id?.kind ? (
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-2xs font-medium",
                          id.kind === "internal"
                            ? "bg-indigo-500/15 text-indigo-300"
                            : "bg-amber-500/15 text-amber-300",
                        )}
                      >
                        {id.kind === "internal" ? "Internal" : "Stakeholder"}
                      </span>
                    ) : null}
                  </DialogTitle>
                  <DialogDescription className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                    {id?.title ? <span className="truncate">{id.title}</span> : null}
                    {id?.email ? <span className="font-mono text-2xs text-muted-foreground">{id.email}</span> : null}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {loading && !d ? (
                <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Spinner className="size-3" />
                  Loading dossier…
                </span>
              ) : (
                <div className="flex flex-col gap-5">
                  {/* Reporting & escalation — editable links + the derived chain */}
                  {d && id ? (
                    <DossierBit label="Reporting & escalation">
                      <ReportingEscalationTimeline
                        self={{ email: id.email, name: id.name }}
                        chainUp={d.chainUp}
                        reportees={d.reportees}
                        escalations={d.escalations.map((e) => ({ email: e.email, reason: e.reason }))}
                        roster={roster}
                        onSave={saveRoster}
                      />
                    </DossierBit>
                  ) : null}

                  {/* Accounts — click a chip to scope everything below to that
                      customer and reveal the person's role + context there. */}
                  {d?.accounts.length ? (
                    <DossierBit label="Accounts">
                      <div className="flex w-full flex-col gap-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {d.accounts.map((a) => {
                            const on = acct === a.id;
                            return (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => setAcct(on ? null : a.id)}
                                className={cn(
                                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                                  on
                                    ? "border-foreground/20 bg-foreground text-background"
                                    : "border-border/60 bg-muted/40 text-foreground/80 hover:bg-muted",
                                )}
                              >
                                {a.name}
                              </button>
                            );
                          })}
                        </div>
                        {selAcct ? (
                          (() => {
                            const s = acctSummaries[selAcct.id];
                            if (s?.text) {
                              return (
                                <p className="text-xs text-foreground/80 leading-relaxed">{s.text}</p>
                              );
                            }
                            // Never block on the agent: the deterministic line shows
                            // INSTANTLY and is replaced in place once the briefing
                            // lands, so selecting an account always feels immediate.
                            return (
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                <span className="font-medium text-foreground/90">{id?.name ?? person.label}</span>
                                {selAcct.role ? (
                                  <>
                                    {" is the "}
                                    <span className="text-foreground/80">{selAcct.role}</span>
                                  </>
                                ) : (
                                  " works"
                                )}
                                {" on "}
                                <span className="font-medium text-foreground/90">{selAcct.name}</span>
                                {selAcct.title ? `, ${selAcct.title}` : ""}
                                {selAcct.lastContact ? ` · last contact ${selAcct.lastContact}` : ""}.{" "}
                                Owns{" "}
                                {listWithAnd(
                                  [
                                    SHOW_TICKETS ? `${fTickets.length} ticket${fTickets.length === 1 ? "" : "s"}` : null,
                                    SHOW_DEPLOYMENTS ? countOf(fDeps.length, DEP) : null,
                                    SHOW_IMPLEMENTATIONS ? countOf(fImpls.length, IMP) : null,
                                    `${fTodos.length} TODO${fTodos.length === 1 ? "" : "s"}`,
                                  ].filter((x): x is string => x !== null),
                                )}{" "}
                                on this account.
                                {s?.loading ? (
                                  <span className="ml-1 inline-flex items-center gap-1 text-muted-foreground/50">
                                    <Spinner className="size-2.5" />
                                    refining…
                                  </span>
                                ) : s?.error ? (
                                  <span className="text-muted-foreground/50"> (AI briefing unavailable)</span>
                                ) : null}
                              </p>
                            );
                          })()
                        ) : null}
                      </div>
                    </DossierBit>
                  ) : null}

                  {/* Ownership across the data room (scoped to the account chip) */}
                  <div className="flex flex-col gap-5">
                    {SHOW_TICKETS ? (
                    <OwnPanel icon={TicketIcon} title="Tickets" count={fTickets.length}>
                      {fTickets.map((t) => (
                        <OwnRow
                          key={`${t.customer}-${t.id}`}
                          dot={PRIO_DOT[t.priority] ?? PRIO_DOT.normal}
                          primary={`${t.id} · ${t.summary}`}
                          chips={
                            <>
                              <Pill>{t.status}</Pill>
                              {t.customerLabel ? (
                                <span className="text-2xs text-muted-foreground/60">{t.customerLabel}</span>
                              ) : null}
                            </>
                          }
                        />
                      ))}
                    </OwnPanel>
                    ) : null}
                    {SHOW_DEPLOYMENTS ? (
                    <OwnPanel icon={RocketIcon} title={DEP.title} count={fDeps.length}>
                      {fDeps.map((x) => (
                        <OwnRow
                          key={`${x.customer}-${x.id}`}
                          dot={healthDot(x.health)}
                          primary={`${x.customerLabel ?? x.customer ?? x.id} · ${DEP.hidden("environment") ? x.id : x.env}`}
                          chips={
                            <>
                              <Pill>{x.version}</Pill>
                              <Pill>{DEP.display("releaseStatus", x.status)}</Pill>
                            </>
                          }
                        />
                      ))}
                    </OwnPanel>
                    ) : null}
                    {SHOW_IMPLEMENTATIONS ? (
                    <OwnPanel icon={PackageIcon} title={IMP.title} count={fImpls.length}>
                      {fImpls.map((x) => (
                        <OwnRow
                          key={x.customer ?? x.id}
                          dot={PRIO_DOT[x.risk] ?? PRIO_DOT.normal}
                          primary={x.customerLabel ?? x.customer ?? x.id}
                          chips={
                            <>
                              {x.progress != null ? <Pill>{Math.round(x.progress)}%</Pill> : null}
                              <Pill>{IMP.display("implementationStage", x.stage)}</Pill>
                            </>
                          }
                        />
                      ))}
                    </OwnPanel>
                    ) : null}
                    <OwnPanel icon={ListTodoIcon} title="TODOs" count={fTodos.length}>
                      {fTodos.map((t) => (
                        <OwnRow
                          key={t.id}
                          dot={t.done ? "bg-emerald-500" : PRIO_DOT[t.priority] ?? PRIO_DOT.normal}
                          primary={t.title}
                          onClick={() => openTask(t.id)}
                          chips={
                            <>
                              {t.container ? <Pill>{t.container}</Pill> : null}
                              {t.dueAt ? (
                                <span className="text-2xs text-muted-foreground/60">
                                  {new Date(t.dueAt).toLocaleDateString()}
                                </span>
                              ) : null}
                            </>
                          }
                        />
                      ))}
                    </OwnPanel>
                  </div>

                </div>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// The full ticket record behind a rail workload item (its id is the ticketId).
type TaskTicket = {
  id: string;
  customer: string | null;
  customerLabel: string | null;
  summary: string;
  description: string | null;
  status: string;
  priority: string;
  severity: string | null;
  type: string | null;
  category: string | null;
  owner: string | null;
  contact: string | null;
  opened: string | null;
  due: string | null;
  slaStatus: string | null;
  escalated: boolean;
  productionImpact: boolean;
  impactLevel: string | null;
  impactSummary: string | null;
  issueDomain: string | null;
  rootCause: string | null;
  resolution: string | null;
  sourceLink: string | null;
  tags: string[];
};
type TaskRelated = { id: string; title: string; done: boolean; priority: string; dueAt: string | null };

function statusTone(s: string): string {
  const v = s.toLowerCase();
  if (/(resolved|closed|done|complete)/.test(v)) return "bg-emerald-500/15 text-emerald-300";
  if (/(blocked|escalat|breach|open)/.test(v)) return "bg-amber-500/15 text-amber-300";
  if (/(progress|triage|active)/.test(v)) return "bg-sky-500/15 text-sky-300";
  return "bg-muted text-muted-foreground";
}

/** A labelled field in the detail grid. */
function TaskField({ label, value }: { readonly label: string; readonly value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">{label}</span>
      <span className="truncate text-xs">{value}</span>
    </div>
  );
}

/**
 * A rail task (ticket) opened in-place — the same in-rail detail pattern the
 * workflow-script artifact uses. Fetches the full ticket record + linked TODOs
 * on open and lays them out: header (id · summary · status), a field grid,
 * description / root-cause, tags, and related work.
 */
function TaskDetail({
  task,
  onOpenOps,
}: {
  readonly task: CtxItem;
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
}) {
  const [ticket, setTicket] = useState<TaskTicket | null>(null);
  const [related, setRelated] = useState<TaskRelated[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setTicket(null);
    setRelated([]);
    opsFetch<{ found: boolean; ticket: TaskTicket | null; todos: TaskRelated[] }>(
      `/api/ops/tickets/${encodeURIComponent(task.id)}`,
    )
      .then((d) => {
        if (!alive) return;
        setTicket(d.ticket);
        setRelated(d.todos ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [task.id]);

  const t = ticket;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <TicketIcon className="size-3.5" />
          <span className="font-mono">{task.id}</span>
          {t?.customerLabel ? <span>· {t.customerLabel}</span> : null}
        </div>
        <h3 className="font-semibold text-sm leading-snug">{t?.summary ?? task.label}</h3>
        {t ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("rounded-md px-1.5 py-0.5 font-medium text-2xs", statusTone(t.status))}>{t.status}</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{t.priority}</span>
            {t.severity ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{t.severity}</span>
            ) : null}
            {t.escalated ? (
              <span className="rounded-md bg-red-500/15 px-1.5 py-0.5 text-2xs text-red-300">escalated</span>
            ) : null}
            {t.productionImpact ? (
              <span className="rounded-md bg-red-500/15 px-1.5 py-0.5 text-2xs text-red-300">prod impact</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {loading && !t ? (
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          Loading ticket…
        </span>
      ) : !t ? (
        <p className="text-2xs text-muted-foreground italic">
          {task.sub ? task.sub : "This ticket isn't in the system-of-record snapshot."}
        </p>
      ) : (
        <>
          {/* Field grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border/60 bg-muted/15 p-3">
            <TaskField label="Owner" value={t.owner} />
            <TaskField label={ACCOUNT_LABEL} value={t.customerLabel ?? t.customer} />
            <TaskField label="Type" value={[t.type, t.category].filter(Boolean).join(" · ") || null} />
            <TaskField label="Domain" value={t.issueDomain} />
            <TaskField label="Opened" value={t.opened} />
            <TaskField label="Due" value={t.due} />
            <TaskField label="SLA" value={t.slaStatus} />
            <TaskField label="Impact" value={t.impactLevel} />
          </div>

          {t.description ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">Description</span>
              <p className="whitespace-pre-wrap text-xs text-foreground/90">{t.description}</p>
            </div>
          ) : null}
          {t.impactSummary ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">{ACCOUNT_LABEL} impact</span>
              <p className="whitespace-pre-wrap text-xs text-foreground/90">{t.impactSummary}</p>
            </div>
          ) : null}
          {t.rootCause ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">Root cause</span>
              <p className="whitespace-pre-wrap text-xs text-foreground/90">{t.rootCause}</p>
            </div>
          ) : null}
          {t.resolution ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">Resolution</span>
              <p className="whitespace-pre-wrap text-xs text-foreground/90">{t.resolution}</p>
            </div>
          ) : null}

          {t.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {t.tags.map((tag) => (
                <span key={tag} className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-2xs text-foreground/70">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {/* Related work */}
          <div className="flex flex-col gap-2">
            <span className="font-medium text-2xs text-muted-foreground/60 uppercase tracking-wide">
              Related todos · {related.length}
            </span>
            {related.length === 0 ? (
              <p className="text-2xs text-muted-foreground/50 italic">No todos linked to this ticket.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {related.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onOpenOps?.("todos", r.id)}
                      className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-left hover:bg-muted/40"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          r.done ? "bg-emerald-500" : PRIO_DOT[r.priority] ?? PRIO_DOT.normal,
                        )}
                      />
                      <span className={cn("min-w-0 flex-1 truncate text-xs", r.done && "text-muted-foreground/60 line-through")}>
                        {r.title}
                      </span>
                      {r.dueAt ? (
                        <span className="shrink-0 text-2xs text-muted-foreground/60">
                          {new Date(r.dueAt).toLocaleDateString()}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {t.sourceLink ? (
            <a
              href={t.sourceLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3.5" />
              Open source
            </a>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * An artifact opened IN THE RAIL (not a modal), consistent with how subagent
 * and workflow-run details open: a workflow's SCRIPT (fetched on open), a
 * cron/schedule DEFINITION (inline), or a published FILE link. The header's
 * back button (owned by Cockpit) returns to the list.
 */
/* --------------------------- workflow script diff -------------------------- */

type DiffLine = { type: "add" | "del" | "ctx"; text: string; a: number | null; b: number | null };

/**
 * A line-level diff (LCS backtrace) of two script revisions. Cheap enough to run
 * inline — workflow scripts are at most a few hundred lines, and the table is
 * O(m·n). Returns unified rows: each is an addition, a deletion, or unchanged
 * context, carrying its old/new line numbers for the gutter.
 */
function lineDiff(before: string, after: string): DiffLine[] {
  const A = before.length ? before.split("\n") : [];
  const B = after.length ? after.split("\n") : [];
  const m = A.length;
  const n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let a = 1;
  let b = 1;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: "ctx", text: A[i], a: a++, b: b++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i], a: a++, b: null });
      i++;
    } else {
      out.push({ type: "add", text: B[j], a: null, b: b++ });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: A[i], a: a++, b: null });
  while (j < n) out.push({ type: "add", text: B[j], a: null, b: b++ });
  return out;
}

/** Collapse long runs of unchanged context into a single fold marker, like a
 *  git hunk — keep CONTEXT lines of padding around each change. */
type DiffRow = DiffLine | { type: "fold"; count: number };
function foldDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === "ctx") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  const rows: DiffRow[] = [];
  let run = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      if (run > 0) {
        rows.push({ type: "fold", count: run });
        run = 0;
      }
      rows.push(lines[idx]);
    } else {
      run++;
    }
  }
  if (run > 0) rows.push({ type: "fold", count: run });
  return rows;
}

const DIFF_ROW: Record<DiffLine["type"], { row: string; sign: string; signColor: string }> = {
  add: { row: "bg-emerald-500/10", sign: "+", signColor: "text-emerald-400" },
  del: { row: "bg-red-500/10", sign: "-", signColor: "text-red-400" },
  ctx: { row: "", sign: " ", signColor: "text-transparent" },
};

/** Git-style unified diff of two workflow-script revisions. */
function ScriptDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const rows = useMemo(() => foldDiff(lineDiff(before, after)), [before, after]);
  const adds = rows.reduce((s, r) => s + (r.type === "add" ? 1 : 0), 0);
  const dels = rows.reduce((s, r) => s + (r.type === "del" ? 1 : 0), 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-muted/20">
      <div className="flex shrink-0 items-center gap-3 border-border/60 border-b px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <GitCompareIcon className="size-3" />
          agent edit
        </span>
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          <span className="text-emerald-400">+{adds}</span>
          <span className="text-red-400">−{dels}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-2xs leading-relaxed">
        {rows.map((r, idx) =>
          r.type === "fold" ? (
            <div
              key={`fold-${idx}`}
              className="flex items-center gap-2 bg-muted/40 px-3 py-0.5 text-[10px] text-muted-foreground/60 italic"
            >
              <span className="w-16 shrink-0" />⋯ {r.count} unchanged line{r.count === 1 ? "" : "s"}
            </div>
          ) : (
            <div key={idx} className={cn("flex", DIFF_ROW[r.type].row)}>
              <span className="w-8 shrink-0 select-none px-1 text-right text-muted-foreground/40 tabular-nums">
                {r.a ?? ""}
              </span>
              <span className="w-8 shrink-0 select-none px-1 text-right text-muted-foreground/40 tabular-nums">
                {r.b ?? ""}
              </span>
              <span className={cn("shrink-0 select-none px-1", DIFF_ROW[r.type].signColor)}>{DIFF_ROW[r.type].sign}</span>
              <span className="whitespace-pre-wrap break-all pr-3">{r.text || " "}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ArtifactDetail({ artifact }: { readonly artifact: CockpitArtifact }) {
  // The workflow's script-version history, newest first. Two or more revisions
  // means the agent actually EDITED the script this session — so instead of the
  // raw script we show a git-style diff of the latest change (v[0] over v[1]).
  // A freshly-authored workflow (one version, or none) just shows its script.
  const [versions, setVersions] = useState<ApiWorkflowVersion[] | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The published link the agent handed back expires; sign a fresh one to open.
  const file = useLiveArtifactUrl(artifact.kind === "file" ? artifact.href : undefined);
  useEffect(() => {
    setVersions(null);
    setScript(null);
    if (artifact.kind !== "workflow" || !artifact.workflowId) return;
    let alive = true;
    setLoading(true);
    const id = artifact.workflowId;
    opsFetch<{ items: ApiWorkflowVersion[] }>(`/api/ops/workflows/${id}/versions?kind=script`)
      .then(async (d) => {
        if (!alive) return;
        setVersions(d.items);
        // Older workflows predate versioning — fall back to the current script
        // off the list endpoint so the pane is never blank.
        if (d.items.length === 0 && !artifact.content) {
          const list = await opsFetch<{ items: { id: string; script: string | null }[] }>("/api/ops/workflows");
          if (alive) setScript(list.items.find((w) => w.id === id)?.script ?? "");
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [artifact]);

  // A real edit: the newest revision, diffed over the one before it.
  const edited = artifact.kind === "workflow" && (versions?.length ?? 0) >= 2;
  const before = edited ? (versions![1].content ?? "") : "";
  const after = edited ? (versions![0].content ?? "") : "";

  const code =
    artifact.kind === "workflow"
      ? (versions?.[0]?.content ?? artifact.content ?? script)
      : artifact.kind === "cron"
        ? artifact.content
        : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
      <p className="mb-2 flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <ArtifactIcon kind={artifact.kind} />
        {edited ? `edited ${relTime(Date.parse(versions![0].createdAt))}` : (artifact.sub ?? artifact.kind)}
      </p>
      {artifact.kind === "file" ? (
        (() => {
          // Render the file's CONTENT inline (text/code/markdown/office) via the
          // shared ArtifactBody, which fetches through the proxy — instead of the
          // old opaque "Open file" card that never showed a .ts / .md / etc. Only
          // for previewable types; genuinely binary files keep the download card.
          const previewable = artifact.href ? artifactFromHref(artifact.href) : null;
          if (previewable) {
            return (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-muted/10">
                <ArtifactBody
                  kind={kindOf(previewable.filename)}
                  content=""
                  url={artifact.href!}
                  filename={previewable.filename}
                />
              </div>
            );
          }
          return (
            <div className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">
                A file the agent published this session. The link is private and time-limited.
              </p>
              {artifact.href ? (
                <a
                  href={file.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 font-medium text-sm transition-colors hover:bg-muted"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open file
                </a>
              ) : null}
            </div>
          );
        })()
      ) : loading ? (
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          Loading script…
        </span>
      ) : edited ? (
        <ScriptDiff before={before} after={after} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-2xs leading-relaxed">
          {code || "— empty —"}
        </pre>
      )}
    </div>
  );
}

/** Bearer headers for same-origin `/eve/v1/*` calls (rewritten to the agent). */
function eveAuthHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** One row of a child session's live feed. Tool rows COALESCE: the request
 *  creates a running row, its result flips the same row to done — never two
 *  lines for one call. */
type FeedRow =
  | { kind: "step"; id: string; label: string }
  | {
      kind: "tool";
      id: string;
      /** Raw tool name, kept for result-matching; display uses toolDisplayName. */
      raw: string;
      summary: string | null;
      status: "running" | "done";
    }
  | { kind: "reply"; id: string; text: string }
  | {
      kind: "wait";
      id: string;
      text: string;
      request?: {
        requestId: string;
        prompt: string;
        options: { id: string; label: string }[];
      };
    }
  | { kind: "note"; id: string; text: string };

let feedSeq = 0;
const feedId = () => `f${++feedSeq}`;

// The SAME reducer the main chat mounts (agent-chat.tsx): eve's message reducer
// inside `withSessionEpochs`, which also applies `withResumedSteps` and names a
// parked specialist's hand-back. Folding the child stream through it yields real
// EveMessage parts — reasoning, tool calls with their input/output, text — so
// the rail detail renders with the very same AgentMessage component as the main
// thread instead of a bespoke row model. A specialist that delegates in turn is
// resumed at step 0 again by eve, exactly like the orchestrator (#67); with
// eve's reducer alone its later thinking was written into the block ABOVE its
// own specialist's card. reduce() is pure, so one shared instance is fine — but
// the wrappers keep their state on the reducer's DATA object (non-enumerable),
// so each feed folds onto its own previous `transcript`, never onto a rebuilt
// `{ messages }` (which would reset that state on every event).
const childReducer = withSessionEpochs(defaultMessageReducer());
type ChildTranscript = ReturnType<typeof childReducer.initial>;

/** Fold one child-session stream event into the feed (loosely typed on purpose). */
function applyFeedEvent(
  rows: FeedRow[],
  e: { type?: string; data?: Record<string, unknown> },
): FeedRow[] {
  const d = e.data ?? {};
  switch (e.type) {
    case "step.started": {
      const label = `Step ${Number(d.stepIndex ?? 0) + 1}`;
      return [...rows, { kind: "step", id: feedId(), label }];
    }
    case "actions.requested": {
      const actions = Array.isArray(d.actions) ? (d.actions as Array<Record<string, unknown>>) : [];
      const added: FeedRow[] = actions
        .map((a): FeedRow | null => {
          const raw = a.toolName ?? a.name;
          if (typeof raw !== "string") return null;
          const callId = a.toolCallId ?? a.callId ?? a.id;
          return {
            kind: "tool",
            id: typeof callId === "string" ? callId : feedId(),
            raw,
            summary: toolCallSummary(raw, a.input ?? a.args ?? null),
            status: "running",
          };
        })
        .filter((r): r is FeedRow => r !== null);
      return added.length ? [...rows, ...added] : rows;
    }
    case "action.result": {
      const r = (d.result ?? {}) as Record<string, unknown>;
      const callId = r.toolCallId ?? r.callId;
      const raw = typeof r.toolName === "string" ? r.toolName : null;
      // Flip the matching running row: by call id first, else the OLDEST
      // running row with the same tool name (calls complete roughly in order).
      let idx = -1;
      if (typeof callId === "string") {
        idx = rows.findIndex((row) => row.kind === "tool" && row.id === callId);
      }
      if (idx === -1 && raw) {
        idx = rows.findIndex(
          (row) => row.kind === "tool" && row.status === "running" && row.raw === raw,
        );
      }
      if (idx === -1) {
        return raw
          ? [...rows, { kind: "tool", id: feedId(), raw, summary: null, status: "done" }]
          : rows;
      }
      const next = [...rows];
      next[idx] = { ...(next[idx] as Extract<FeedRow, { kind: "tool" }>), status: "done" };
      return next;
    }
    case "message.completed": {
      const msg = typeof d.message === "string" ? d.message.trim() : "";
      if (!msg) return rows;
      return [
        ...rows,
        { kind: "reply", id: feedId(), text: msg.length > 140 ? `${msg.slice(0, 140)}…` : msg },
      ];
    }
    case "input.requested": {
      const first = (Array.isArray(d.requests) ? d.requests[0] : undefined) as
        | { requestId?: unknown; prompt?: unknown; options?: unknown }
        | undefined;
      const request =
        first && typeof first.requestId === "string"
          ? {
              requestId: first.requestId,
              prompt: typeof first.prompt === "string" ? first.prompt : "Approval requested",
              options: Array.isArray(first.options)
                ? (first.options as { id?: unknown; label?: unknown }[])
                    .filter((o) => typeof o?.id === "string")
                    .map((o) => ({
                      id: o.id as string,
                      label: typeof o.label === "string" ? o.label : (o.id as string),
                    }))
                : [],
            }
          : undefined;
      return [...rows, { kind: "wait", id: feedId(), text: "Waiting for approval", request }];
    }
    case "subagent.called":
      return [...rows, { kind: "note", id: feedId(), text: "Delegated further" }];
    case "turn.completed":
      return [...rows, { kind: "note", id: feedId(), text: "Turn finished" }];
    case "step.failed":
    case "turn.failed":
    case "session.failed": {
      // Every failure event carries the reason on the wire (eve's protocol:
      // `{ code, message, details? }` — eve's own client store builds
      // `Error(message)` with `name = code`). Surface it instead of a bare
      // "Failed" the user can't act on; fall back only when the wire is empty.
      const code = typeof d.code === "string" ? d.code : null;
      const msg = typeof d.message === "string" ? d.message.trim() : "";
      const reason = [code, msg].filter(Boolean).join(": ");
      const detail = reason
        ? reason.length > 140
          ? `${reason.slice(0, 140)}…`
          : reason
        : "no error detail from the stream";
      const text = `⚠ Failed — ${detail}`;
      // A crash emits the cascade step.failed → turn.failed → session.failed
      // carrying the SAME propagated code/message — collapse it to one row so
      // the rail doesn't stack three identical "Failed" notes for one crash.
      const last = rows[rows.length - 1];
      if (last?.kind === "note" && last.text === text) return rows;
      return [...rows, { kind: "note", id: feedId(), text }];
    }
    default:
      return rows;
  }
}

/**
 * Attach to a delegated subagent's own session stream (the parent only emits
 * `subagent.called` + `childSessionId`; per eve's docs, progress is published on
 * the CHILD's stream) and fold its events into a live feed.
 */
type FeedStatus = "idle" | "live" | "ended" | "unavailable";
interface ChildFeed {
  rows: FeedRow[];
  /** Real reduced messages (eve reducer) for the detail transcript — rendered
   *  by AgentMessage, exactly as the main chat. `rows` stays for the list's
   *  live tool-call counts. */
  messages: EveMessage[];
  /** The reducer's own projection `messages` is read from. Kept whole: it
   *  carries the wrappers' step/epoch state, which `{ messages }` would drop. */
  transcript?: ChildTranscript;
  /** Local rail meta-notes (steer sent, cancel/resume, dead-run) — not part of
   *  the model transcript, shown beneath it. */
  notes: { id: string; text: string }[];
  status: FeedStatus;
  /** True while a turn is running (turn.started seen without a later
   *  turn.completed/failed). Undefined = unknown (no turn events yet). */
  turnActive?: boolean;
  /** The child session emitted session.completed — genuinely done, NOT merely
   *  parked on an approval (which emits session.waiting). Only a completed run
   *  can be a "stuck handoff". */
  completed?: boolean;
  /** The child session's resume handle (from its session.waiting events) —
   *  REQUIRED to deliver a follow-up/steer message (posting without it is a
   *  guaranteed 400). Latest one seen wins; mid-turn deliveries to it are
   *  drained at workflow boundaries per eve's message-delivery semantics. */
  continuationToken?: string;
  /** Sessions this child delegated to in turn (from its own `subagent.called`
   *  events). The rail attaches to them as well, so a grandchild's work rolls
   *  up to the root the same way a child's does. */
  childSessions: string[];
}

/**
 * Attach to the session streams of EVERY targeted child session at once (the
 * parent only emits `subagent.called` + `childSessionId`; per eve's docs,
 * progress is published on the CHILD's stream). Feeds are owned HERE — above
 * the detail view — so the rail's list rows can show live tool-call counts and
 * a feed survives navigating into and back out of the detail. Connections open
 * when a session enters `targets` and abort when it leaves.
 *
 * `liveTargets` is the subset that needs to STAY connected (an unfinished run,
 * or the one the operator has open). Every other target is harvested instead:
 * the stream replays the session's whole history on attach, so once it reaches
 * a session boundary the feed already holds everything that session ever did
 * and the connection is dropped. That is what lets the rail roll up every
 * delegation's work without holding a socket open per finished run.
 */
function useChildFeeds(targets: readonly string[], liveTargets: readonly string[]) {
  const [feeds, setFeeds] = useState<Record<string, ChildFeed>>({});
  const conns = useRef<Record<string, { ctrl: AbortController; live: boolean }>>({});
  /**
   * Where each feed's fold stopped, in absolute stream events. The feed itself
   * outlives its connection (a harvested run re-opened live, a target that left
   * and came back), so a new connection CONTINUES the fold from here rather than
   * replaying the history onto a transcript that already holds it: a replay
   * appended every tool row a second time, and on the wrapped reducer it would
   * re-enter a finished session's events under the NEXT session's epoch.
   */
  const cursors = useRef<Record<string, number>>({});
  const targetsKey = [...targets].sort().join(",");
  const liveKey = [...liveTargets].sort().join(",");
  useEffect(() => {
    const wanted = new Set(targetsKey ? targetsKey.split(",") : []);
    const liveWanted = new Set(liveKey ? liveKey.split(",") : []);
    for (const [sid, conn] of Object.entries(conns.current)) {
      // Drop what left the target list, and re-open a harvested feed that has
      // since become live (selected, or running again) — its connection is gone.
      if (!wanted.has(sid) || (liveWanted.has(sid) && !conn.live)) {
        conn.ctrl.abort();
        delete conns.current[sid];
      }
    }
    const patch = (sid: string, fn: (f: ChildFeed) => ChildFeed) =>
      setFeeds((prev) => ({
        ...prev,
        [sid]: fn(prev[sid] ?? { rows: [], messages: [], notes: [], status: "idle", childSessions: [] }),
      }));
    for (const sid of wanted) {
      if (conns.current[sid]) continue;
      const ctrl = new AbortController();
      const live = liveWanted.has(sid);
      conns.current[sid] = { ctrl, live };
      patch(sid, (f) => f);
      (async () => {
        /**
         * Resume at a cursor, and reconnect when a segment ends.
         *
         * This read had neither. Two consequences, both seen together: the feed
         * was severed at the ~120s stream boundary and the loop just broke, so
         * the rail went quiet while still reporting "live" — it looked like the
         * subagent had been dismissed. Then anything that reopened the feed
         * started from index 0 and replayed the child's ENTIRE history, so six
         * background subagents all flooded the Control Panel at once the moment
         * the next prompt was sent.
         *
         * startIndex is an absolute event count, so the cursor advances on every
         * line INCLUDING one that fails to parse — undercounting silently
         * replays events already shown, which is the same flood in slow motion.
         */
        let cursor = cursors.current[sid] ?? 0;
        let segments = 0;
        try {
          while (!ctrl.signal.aborted && segments < 60) {
            segments++;
            const res = await fetch(
              `/eve/v1/session/${encodeURIComponent(sid)}/stream?startIndex=${cursor}`,
              { headers: eveAuthHeaders(), signal: ctrl.signal },
            );
            if (!res.ok || !res.body) {
              patch(sid, (f) => ({ ...f, status: "unavailable" }));
              return;
            }
            patch(sid, (f) => ({ ...f, status: "live" }));
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let ended = false;
            while (!ctrl.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
            buf += decoder.decode(value, { stream: true });
            const rows = buf.split("\n");
            buf = rows.pop() ?? "";
            for (const row of rows) {
              if (!row.trim()) continue;
              // Count first: the cursor is an absolute event count, so a line we
              // cannot parse still occupies a position.
              cursor++;
              cursors.current[sid] = cursor;
              let event: { type?: string; data?: Record<string, unknown> };
              try {
                event = JSON.parse(row);
              } catch {
                continue;
              }
              if (
                event.type === "turn.completed" ||
                event.type === "turn.failed" ||
                event.type === "session.completed" ||
                event.type === "session.waiting"
              ) {
                ended = true;
              }
              patch(sid, (f) => {
                const transcript = childReducer.reduce(
                  f.transcript ?? childReducer.initial(),
                  event as Parameters<typeof childReducer.reduce>[1],
                );
                return {
                  ...f,
                  rows: applyFeedEvent(f.rows, event).slice(-150),
                  transcript,
                  messages: transcript.messages as EveMessage[],
                };
              });
              if (event.type === "turn.started") {
                patch(sid, (f) => ({ ...f, turnActive: true }));
              } else if (event.type === "turn.completed" || event.type === "turn.failed") {
                patch(sid, (f) => ({ ...f, turnActive: false }));
              }
              // A delegation BELOW this child — record it so the rail attaches
              // to the grandchild too and its work rolls up as well.
              if (event.type === "subagent.called") {
                const nested = (event.data as { childSessionId?: string } | undefined)?.childSessionId;
                if (typeof nested === "string" && nested) {
                  patch(sid, (f) =>
                    f.childSessions.includes(nested)
                      ? f
                      : { ...f, childSessions: [...f.childSessions, nested] },
                  );
                }
              }
              if (event.type === "session.waiting") {
                const token = (event.data as { continuationToken?: string } | undefined)
                  ?.continuationToken;
                patch(sid, (f) => ({
                  ...f,
                  status: "ended",
                  ...(typeof token === "string" ? { continuationToken: token } : {}),
                }));
              } else if (event.type === "session.completed") {
                // GENUINELY finished (not merely parked on an approval, which
                // emits session.waiting instead) — the only state that counts as
                // a completed run for stuck-handoff detection.
                patch(sid, (f) => ({ ...f, status: "ended", completed: true }));
              }
              // Harvest-only: the replay has reached the end of this session's
              // recorded life, so everything it produced is already folded in.
              // Release the connection rather than idle on it.
              if (
                !live &&
                (event.type === "session.waiting" ||
                  event.type === "session.completed" ||
                  event.type === "session.failed")
              ) {
                ctrl.abort();
              }
            }
            }
            // A terminal event means the child is genuinely done — stop. Anything
            // else (a severed segment) means resume where the cursor left off,
            // which is the difference between a rail that goes quiet forever and
            // one that keeps reporting.
            if (ended || ctrl.signal.aborted) break;
          }
          patch(sid, (f) => (f.status === "live" ? { ...f, status: "ended", turnActive: false } : f));
        } catch {
          // A deliberate detach (harvest finished, or the target left the list)
          // is not a failure — the feed keeps everything it already replayed.
          if (ctrl.signal.aborted) return;
          patch(sid, (f) => (f.status === "live" ? { ...f, status: "ended" } : { ...f, status: "unavailable" }));
        }
      })();
    }
  }, [targetsKey, liveKey]);
  useEffect(
    () => () => {
      for (const conn of Object.values(conns.current)) conn.ctrl.abort();
    },
    [],
  );
  const appendLocal = (sid: string, text: string) =>
    setFeeds((prev) => {
      const base =
        prev[sid] ?? { rows: [], messages: [], notes: [], status: "idle" as FeedStatus, childSessions: [] };
      return {
        ...prev,
        [sid]: { ...base, notes: [...base.notes, { id: feedId(), text }] },
      };
    });
  const markTurnIdle = (sid: string) =>
    setFeeds((prev) => {
      const f = prev[sid];
      return f ? { ...prev, [sid]: { ...f, turnActive: false } } : prev;
    });
  return { feeds, appendLocal, markTurnIdle };
}

/** The original delegation brief — full-width user-bubble styling, clamped to
 *  a few lines with Read more (no inner scrollbar). */
function TaskBrief({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 320;
  return (
    <div className="mb-3">
      <div
        className={cn(
          "w-full whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground text-sm",
          !expanded && long && "line-clamp-5",
        )}
      >
        {text}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-muted-foreground text-xs hover:text-foreground"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

function SubagentDetail({
  appendLocal,
  feed,
  onInputResponses,
  run,
}: {
  readonly appendLocal: (sessionId: string, text: string) => void;
  readonly feed?: ChildFeed;
  readonly onInputResponses?: (
    responses: readonly { optionId?: string; requestId: string; text?: string }[],
  ) => void | Promise<void>;
  readonly run: SubagentRun;
}) {
  // Child approvals now render inline in the transcript via AgentMessage (same
  // components as the main chat) and answer through onInputResponses — no
  // bespoke wait-row/options handling needed here anymore.
  const live = run.status === "running";
  const display = subagentDisplayName(run.name);
  const feedStatus: FeedStatus = feed?.status ?? "idle";
  const [busy, setBusy] = useState<"steer" | "cancel" | null>(null);
  // Full composer parity with the main chat — a subagent IS an agent: same
  // attach / web-search / plan-mode controls, same directive prefixes.
  const [steerFiles, setSteerFiles] = useState<
    { id: string; name: string; dataUrl: string; mediaType: string }[]
  >([]);
  const steerFileRef = useRef<HTMLInputElement>(null);
  const [steerWebSearch, setSteerWebSearch] = useState(true);
  const [steerPlanMode, setSteerPlanMode] = useState(false);
  // eve has no mid-turn delivery point for plain messages (tokens only exist
  // at turn boundaries) — queue guidance locally and flush when one appears,
  // mirroring the main chat's queue-while-busy behavior.
  const [steerQueue, setSteerQueue] = useState<string[]>([]);
  const onSteerPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked) return;
    for (const file of Array.from(picked)) {
      const reader = new FileReader();
      reader.onload = () =>
        setSteerFiles((prev) => [
          ...prev,
          {
            id: `${file.name}-${prev.length}-${file.size}`,
            name: file.name,
            dataUrl: reader.result as string,
            mediaType: file.type || "application/octet-stream",
          },
        ]);
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };
  const attached = feedStatus === "live" || feedStatus === "ended";
  // The reduced child transcript minus its first user message (the delegation
  // brief — TaskBrief renders that above). Steer messages (later user turns)
  // stay, so guidance shows inline just like the main thread.
  const transcript: EveMessage[] = (() => {
    const msgs = feed?.messages ?? [];
    // The brief is always the very first message (a later steer is never at
    // index 0), so drop index 0 only when it's that opening user message —
    // never a mid-run steer.
    return msgs[0]?.role === "user" ? msgs.slice(1) : msgs;
  })();
  // Is the run parked on an approval right now? (A non-terminal approval part
  // with no recorded response.) Used to keep the "Working…" strip honest — a
  // parked run is waiting on YOU, not working.
  const awaitingApproval = (feed?.messages ?? []).some((m) =>
    (m.parts ?? []).some((p) => {
      const part = p as {
        state?: string;
        toolMetadata?: { eve?: { inputRequest?: unknown; inputResponse?: unknown } };
      };
      const terminal =
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied";
      if (terminal) return false;
      return (
        part.state === "approval-requested" ||
        (Boolean(part.toolMetadata?.eve?.inputRequest) && !part.toolMetadata?.eve?.inputResponse)
      );
    }),
  );
  // One clear "still working" signal at the live edge of the transcript — no
  // scrolling to hunt for a spinning tool. Hidden when parked on an approval
  // (the card is the signal) or when the run has finished.
  const working = live && feed?.turnActive !== false && !awaitingApproval;

  // A crashed child (model 402, etc.) never emits session.waiting, so no
  // continuation token ever arrives and a queued steer message can never
  // flush. eve's terminal cascade (step→turn→session.failed) closes the
  // stream WITHOUT a resume handle; a RECOVERABLE pause instead delivers
  // session.waiting + a fresh token one event after turn.failed — so we only
  // call the run dead once the stream has actually ended (never mid-turn)
  // with no token in hand. Guarding on the ended stream avoids falsely
  // declaring a live, pausing run dead and dropping deliverable guidance.
  const streamEnded = feedStatus === "ended" || feedStatus === "unavailable";
  const queueDead = streamEnded && feed?.turnActive === false && !feed?.continuationToken;

  const flushToken = feed?.continuationToken;
  useEffect(() => {
    if (!flushToken || steerQueue.length === 0) return;
    const [next, ...rest] = steerQueue;
    setSteerQueue(rest);
    void sendSteer(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushToken, steerQueue.length]);

  // If the run dies while messages are still queued behind a token that will
  // never arrive, drop them and say so ONCE — never leave them claiming they
  // will deliver when they can't.
  useEffect(() => {
    if (!queueDead || steerQueue.length === 0) return;
    const sid = run.childSessionId;
    setSteerQueue([]);
    if (sid) {
      appendLocal(sid, "The subagent has stopped — guidance can't deliver. Re-delegate to continue.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueDead, steerQueue.length]);

  const sendSteer = async (raw: string) => {
    const sid = run.childSessionId;
    if ((!raw && steerFiles.length === 0) || !sid) return;
    // Same directive prefixes as the main chat (minus first-turn context).
    const directives: string[] = [];
    if (!steerWebSearch) {
      directives.push("(Web search is off — do not use the web_search tool for this request.)");
    }
    if (steerPlanMode) {
      directives.push(
        `(Plan mode is ON — investigate and plan only, take no action. Use ONLY read-only tools to gather what you need; do NOT write, mutate, send, draft, schedule, post, page, or anything that would prompt for approval. If the request is ambiguous or has real options, ask me a short clarifying question first. Then give a concise plan: the goal, the concrete steps in order, which ${DEPLOYMENT_PROFILE.vocabulary.account.plural}/records/systems each step touches, and how we'll verify it. Then stop and wait for my explicit go — do not act until I approve.)`,
      );
    }
    const text = directives.length > 0 ? `${directives.join(" ")}\n\n${raw}` : raw;
    // Delivering to a session REQUIRES its continuation token (eve's resume
    // handle, captured from the child's session.waiting events on the feed we
    // are already attached to). Without one the POST is a guaranteed 400.
    const continuationToken = feed?.continuationToken;
    if (!continuationToken) {
      if (queueDead) {
        // The run has ended with no resume handle — a queued message could
        // never be delivered, so don't pretend it will. (The "delivers when
        // the subagent pauses" note below stays honest only for live runs.)
        appendLocal(sid, "The subagent has stopped — guidance can't deliver. Re-delegate to continue.");
        return;
      }
      setSteerQueue((prev) => [...prev, raw]);
      appendLocal(
        sid,
        `Queued: "${raw.slice(0, 70)}" — delivers when the subagent pauses (no mid-turn delivery point in eve).`,
      );
      return;
    }
    const outgoing = steerFiles;
    setSteerFiles([]);
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; data: string; mediaType: string; filename?: string }
    > = [];
    if (text) parts.push({ type: "text", text });
    for (const f of outgoing) {
      parts.push({ type: "file", data: f.dataUrl, mediaType: f.mediaType, filename: f.name });
    }
    const message = outgoing.length > 0 ? parts : text;
    setBusy("steer");
    try {
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...eveAuthHeaders() },
        body: JSON.stringify({ message, continuationToken }),
      });
      appendLocal(
        sid,
        res.ok
          ? `You → ${raw.slice(0, 90)}${outgoing.length ? ` (+${outgoing.length} file${outgoing.length === 1 ? "" : "s"})` : ""} (queued; applies at the next step boundary)`
          : `Steer failed (${res.status})`,
      );
    } catch {
      appendLocal(sid, "Steer failed (network)");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {run.activity[0] ? <TaskBrief text={run.activity[0]} /> : null}
        {attached ? (
          transcript.length === 0 ? (
            <p className="text-muted-foreground text-sm">Waiting for the subagent to act…</p>
          ) : (
            // Full parity: the child's own stream, folded through the SAME eve
            // reducer as the main chat, rendered by the SAME AgentMessage — so
            // reasoning, tool calls (with input/output), text, and approvals all
            // look and behave exactly as they do in the main thread. Approvals
            // answer through onInputResponses (proxied to the parent, which
            // routes the response to this child by requestId). The first user
            // message is the delegation brief, already shown by TaskBrief above.
            <div className="flex flex-col gap-6">
              {transcript.map((m, i) => (
                <AgentMessage
                  key={m.id}
                  message={m}
                  canRespond
                  isLast={i === transcript.length - 1}
                  isStreaming={false}
                  // `Boolean(undefined)` is `false`, so a rail whose feed has
                  // not seen a turn event yet — the whole replay window of a run
                  // that is still executing, and every run whose stream came
                  // back `unavailable` — put copy/vote/retry under the child's
                  // half-written answer. Unknown falls back to the run's own
                  // status; only an observed terminal says finished.
                  turnActive={feed?.turnActive ?? live}
                  hoistPendingInput={false}
                  onInputResponses={onInputResponses ?? (() => {})}
                />
              ))}
            </div>
          )
        ) : run.childSessionId && feedStatus === "idle" ? (
          // Reopening a finished run: its stream is re-attaching and replaying
          // history. Show a loader — NOT the raw run.output (that flashed as
          // unrendered markdown for a few seconds before the transcript arrived).
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading transcript…
          </div>
        ) : run.output ? (
          // Genuinely old run (no live stream) — render the result as markdown,
          // never raw text.
          <MessageResponse className="text-sm">{run.output}</MessageResponse>
        ) : (
          <p className="text-muted-foreground text-sm">
            This run predates live session tracking — no transcript to show.
          </p>
        )}
        {feed?.notes?.length ? (
          <div className="mt-3 flex flex-col gap-1">
            {feed.notes.map((n) => (
              <p key={n.id} className="text-muted-foreground text-xs">
                {n.text}
              </p>
            ))}
          </div>
        ) : null}
        {working ? (
          <div className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" />
            Working…
          </div>
        ) : null}
      </div>
      {run.childSessionId && live ? (
        // Steering only makes sense while the subagent is RUNNING. Once it has
        // handed back to the main agent, the composer is hidden (you continue in
        // the main chat, not by messaging a finished child).
        // pb-5 matches the main composer wrapper (agent-chat "shrink-0 pb-5")
        // so the two boxes sit on the same baseline across the divider.
        <div className="shrink-0 px-3 pt-1 pb-5">
          {/* The SAME component as the main chat's composer — identical box,
              colors, metrics, and the same attach/Search/Plan tools. */}
          <input
            ref={steerFileRef}
            type="file"
            multiple
            className="hidden"
            onChange={onSteerPick}
            aria-hidden="true"
          />
          <ChatComposer
            onSubmit={(m) => {
              const text = m.text?.trim() ?? "";
              if (!text && steerFiles.length === 0) return;
              void sendSteer(text);
            }}
            placeholder={live ? `Steer ${display}…` : `Message ${display}…`}
            status={busy === "steer" ? "submitted" : undefined}
            header={
              steerFiles.length > 0
                ? steerFiles.map((f) => (
                    <span
                      key={f.id}
                      className="flex max-w-[12rem] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
                    >
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setSteerFiles((prev) => prev.filter((x) => x.id !== f.id))}
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
                  onClick={() => steerFileRef.current?.click()}
                  aria-label="Attach files"
                >
                  <PaperclipIcon className="size-4" />
                </PromptInputButton>
                <PromptInputButton
                  type="button"
                  onClick={() => setSteerWebSearch((v) => !v)}
                  aria-pressed={steerWebSearch}
                  title={steerWebSearch ? "Web search on" : "Web search off"}
                  className={cn(
                    steerWebSearch &&
                      "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                  )}
                >
                  <GlobeIcon className="size-4" />
                  <span className="text-xs">Search</span>
                </PromptInputButton>
                <PromptInputButton
                  type="button"
                  onClick={() => setSteerPlanMode((v) => !v)}
                  aria-pressed={steerPlanMode}
                  title={
                    steerPlanMode ? "Plan mode on — agent plans before acting" : "Plan mode off"
                  }
                  className={cn(
                    steerPlanMode &&
                      "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                  )}
                >
                  <ListTodoIcon className="size-4" />
                  <span className="text-xs">Plan</span>
                </PromptInputButton>
              </>
            }
          />
        </div>
      ) : !run.childSessionId ? (
        <p className="border-border border-t p-3 text-2xs text-muted-foreground">
          {`This run predates session tracking — steer it by messaging the orchestrator in the chat (e.g. "tell ${display} to also…").`}
        </p>
      ) : null}
    </div>
  );
}

/** "42s" / "3m 12s" / "1h 4m" since an ISO timestamp — refreshed by the poll. */
function fmtElapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Workflow-run lifecycle → the shared RUN_DOT status vocabulary. */
function runDotStatus(status: WorkflowRunRow["status"]): "running" | "failed" | "success" {
  return status === "completed" ? "success" : status === "cancelled" ? "failed" : status;
}

/** Apps currently refreshing / just refreshed. A prompt app's refresh has no
 *  workflow run, so this is the only place it surfaces while it runs. */
function AppRunList({
  apps,
  onOpen,
}: {
  readonly apps: AppRunRow[];
  readonly onOpen: (app: AppRunRow) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {apps.map((a) => {
        const refreshing = Boolean(a.refreshingAt);
        const failed = !refreshing && Boolean(a.lastError);
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onOpen(a)}
              title="Open the dashboard"
              className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  refreshing ? "animate-pulse bg-amber-400" : failed ? "bg-red-500" : "bg-emerald-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">{unkebab(a.name)}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {refreshing
                    ? "refreshing…"
                    : failed
                      ? `failed · ${a.lastRefreshAt ? `${fmtElapsed(a.lastRefreshAt)} ago` : ""}`
                      : `refreshed ${a.lastRefreshAt ? `${fmtElapsed(a.lastRefreshAt)} ago` : ""}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The rail expanded into an app's rendered document — a dashboard spec renders
 *  as widgets, anything else falls back to Markdown. Mirrors the Apps workspace
 *  panel so the two surfaces read identically. The row is live (polled), so a
 *  refresh in flight shows a spinner and swaps to content when it lands. */
function AppRunDetail({
  app,
  onOpenOps,
}: {
  readonly app: AppRunRow;
  readonly onOpenOps?: (section: OpsSection, id?: string) => void;
}) {
  const spec = useMemo(() => parseDashboardSpec(app.contentMd), [app.contentMd]);
  const refreshing = Boolean(app.refreshingAt);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {app.lastError && !refreshing ? (
        <p className="mx-4 mt-4 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-400 text-xs">
          Refresh failed: {app.lastError}
        </p>
      ) : null}
      {refreshing && !app.contentMd ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="text-xs">Generating the dashboard…</span>
        </div>
      ) : spec ? (
        <div className="min-h-0 flex-1 p-4">
          <Dashboard
            spec={spec}
            onAction={(a) => {
              if (a.kind === "chat") {
                window.open(`/?seed=${encodeURIComponent(a.prompt)}`, "_blank", "noopener");
              } else if (a.kind === "open") {
                window.open(a.href, "_blank", "noopener");
              } else if (a.kind === "refresh") {
                onOpenOps?.("apps", app.id);
              }
            }}
          />
        </div>
      ) : app.contentMd ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 text-sm">
          <MessageResponse>{app.contentMd}</MessageResponse>
        </div>
      ) : (
        <p className="py-16 text-center text-muted-foreground/60 text-xs italic">
          No document yet — this app has not produced one.
        </p>
      )}
    </div>
  );
}

function WorkflowRunList({
  runs,
  onSelect,
}: {
  readonly runs: WorkflowRunRow[];
  readonly onSelect: (run: WorkflowRunRow) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((r) => {
        const running = r.status === "running";
        return (
          <li key={r.runId}>
            <button
              type="button"
              onClick={() => onSelect(r)}
              className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted"
            >
              <RunStatusDot status={runDotStatus(r.status)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">{unkebab(r.workflowName)}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {running
                    ? `attempt ${r.attempts} · ${fmtElapsed(r.createdAt)}`
                    : r.status === "failed"
                      ? `failed · ${fmtElapsed(r.updatedAt)} ago`
                      : r.status === "cancelled"
                        ? `cancelled · ${fmtElapsed(r.updatedAt)} ago`
                      : `done · ${fmtElapsed(r.updatedAt)} ago`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WorkflowRunDetail({
  runId,
  fallback,
  phases,
  onRun,
  onOpenAgent,
}: {
  readonly runId: string;
  readonly fallback: WorkflowRunRow;
  /** Static phase skeleton parsed from the workflow script (fetched by the parent). */
  readonly phases: GraphPhase[];
  /** Reports the freshest polled run so the cockpit's top bar can show status. */
  readonly onRun?: (run: WorkflowRunRow) => void;
  /** Opens one agent as a subagent panel in the rail (with its Workflow/Phase). */
  readonly onOpenAgent: (entry: RunJournalEntry, workflow: string, phase: string) => void;
}) {
  const [run, setRun] = useState<WorkflowRunRow>(fallback);
  const [journal, setJournal] = useState<RunJournalEntry[]>([]);
  // Sequence guard — a slow response must never overwrite a fresher one.
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  // The header lives in the cockpit's top bar (one row, not two), so the live
  // run is reported upward as it polls.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      const ticket = ++seqRef.current;
      try {
        const data = await opsFetch<{ run: WorkflowRunRow | null; journal: RunJournalEntry[] }>(
          `/api/ops/workflow-runs/${runId}`,
        );
        if (!alive || !data.run || ticket <= appliedRef.current) return;
        appliedRef.current = ticket;
        setRun(data.run);
        setJournal(data.journal);
        onRunRef.current?.(data.run);
      } catch {
        // Best-effort — keep showing the last snapshot.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId]);

  const running = run.status === "running";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Phases rail + the subagents that ran in the selected phase. Each row
            opens that subagent's own session as a chat thread. */}
        <RunGraph
          phases={phases}
          journal={journal}
          onOpenAgent={(e, phase) => onOpenAgent(e, run.workflowName, phase)}
        />
        {journal.length === 0 && !running ? (
          <p className="mt-3 px-2 text-2xs text-muted-foreground/60 italic">
            No checkpoints recorded.
          </p>
        ) : null}
        {run.error ? (
          <div className="mt-4">
            <p className="mb-1 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
              Error
            </p>
            <p className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-red-400 text-sm">
              {run.error}
            </p>
          </div>
        ) : null}
      </div>
      <p className="border-border border-t p-3 text-2xs text-muted-foreground">
        Durable run · started {fmtElapsed(run.createdAt)} ago.
      </p>
    </div>
  );
}

/** The info dialog's scrollable body: the subagent's REAL tool roster,
 *  skills doc, and full system instructions from agent/subagents/<name>/. */
function SubagentInfoBody({ name }: { readonly name: string }) {
  const meta = SUBAGENT_META[name];
  if (!meta) {
    return (
      <p className="text-muted-foreground text-sm">
        No definition metadata for this subagent — it may be dynamically declared.
      </p>
    );
  }
  return (
    // Scrolling is owned by the dialog wrapper now, so this is plain content.
    <div className="space-y-6">
      {meta.tools.length > 0 ? (
        <section>
          <h3 className="mb-2 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
            Tools ({meta.tools.length})
          </h3>
          <ol className="flex list-decimal flex-col gap-2.5 pl-5 marker:text-muted-foreground marker:text-xs">
            {meta.tools.map((t) => (
              <li key={t.name} className="text-sm">
                <p className="font-medium">{toolDisplayName(t.name)}</p>
                {t.description ? (
                  <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                    {t.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <section>
          <h3 className="mb-2 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
            Tools
          </h3>
          <p className="text-muted-foreground text-sm">
            No dedicated tools — this subagent works purely through its instructions and sandbox.
          </p>
        </section>
      )}
      {/* Only show Skills when there are REAL SKILL.md procedures to enumerate —
          the generic README blurb isn't worth a heading. */}
      {meta.skillNames.length > 0 ? (
        <section>
          <h3 className="mb-2 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
            Skills ({meta.skillNames.length})
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {meta.skillNames.map((n) => (
              <li key={n} className="rounded-md border border-border px-2 py-0.5 text-xs">
                {n}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}


/**
 * The live browser, with a real handover and a zoom that fits the rail.
 *
 * Two things were missing. The view was interactive, so clicking it drove the
 * page — but nothing stopped the AGENT driving the same page at the same time,
 * which is worst precisely when someone steps in mid-login. And the remote
 * viewport is a desktop while this panel is a narrow column, so the embed
 * arrived scaled to nothing legible.
 *
 * Taking control writes a lock the agent's tools honour (every page operation
 * refuses while it is held); handing back releases it. The lock expires on its
 * own, because a hold nobody can clear is worse than no hold.
 */
function LiveBrowserView({
  view,
  error,
  onError,
}: {
  readonly view: { sessionRef: string; url: string };
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
}) {
  const [zoom, setZoom] = useState(0.6);
  const [held, setHeld] = useState<{ by: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (method: "POST" | "DELETE") => {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/ops/browser/${encodeURIComponent(view.sessionRef)}/control`, {
        method,
        headers: eveAuthHeaders(),
      });
      const data = (await res.json().catch(() => null)) as
        | { heldBy?: string; expiresAt?: string; error?: string }
        | null;
      if (!res.ok) {
        onError(data?.error ?? "Could not change control of this browser.");
        return;
      }
      setHeld(method === "POST" ? { by: data?.heldBy ?? "you", expiresAt: data?.expiresAt ?? "" } : null);
    } catch {
      onError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-border/60 border-b px-2 py-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void call(held ? "DELETE" : "POST")}
          className={cn(
            "rounded-md px-2 py-1 font-medium text-xs transition-colors disabled:opacity-50",
            held
              ? "bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 dark:text-amber-400"
              : "bg-foreground text-background hover:opacity-90",
          )}
        >
          {busy ? "…" : held ? "Hand back to agent" : "Take control"}
        </button>
        {held ? (
          <span className="truncate text-2xs text-muted-foreground">
            You have control — the agent will not touch this browser.
          </span>
        ) : (
          <span className="truncate text-2xs text-muted-foreground">The agent is driving.</span>
        )}
        {/* Zoom, because a desktop viewport in a narrow rail is unreadable.
            Scaling the iframe leaves the REMOTE viewport alone, so sites keep
            serving their desktop layout — shrinking the viewport instead would
            flip many of them to mobile and change what the agent reads. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.3, Number((z - 0.1).toFixed(2))))}
            className="rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-muted"
            title="Zoom out"
          >
            −
          </button>
          <span className="w-9 text-center text-2xs text-muted-foreground tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(1.5, Number((z + 0.1).toFixed(2))))}
            className="rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-muted"
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>
      {error ? (
        <p className="shrink-0 border-destructive/40 border-b bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        <iframe
          key={view.sessionRef}
          title="Live browser session"
          src={view.url}
          // allow-same-origin + scripts so the live view's CDP client runs.
          sandbox="allow-scripts allow-same-origin allow-forms"
          // Scaled, not resized: width/height are the REMOTE viewport, and the
          // transform only changes how much of the rail it occupies.
          style={{
            width: `${100 / zoom}%`,
            height: `${100 / zoom}%`,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
          }}
          className="border-0 bg-white"
        />
      </div>
      <p className="shrink-0 border-border/60 border-t px-3 py-1.5 text-2xs text-muted-foreground">
        {held
          ? "Click or type in the page — the agent is paused on this browser."
          : "Take control before typing, or the agent may navigate away mid-keystroke."}
      </p>
    </div>
  );
}
