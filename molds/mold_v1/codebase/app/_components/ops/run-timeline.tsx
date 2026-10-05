"use client";

/**
 * Workflow-run display: the phase-grouped tree a finished run renders as, and
 * the live journal a run IN FLIGHT streams into while the POST is pending.
 *
 * Both read the same design tokens as the rest of the Ops Center; neither owns
 * any fetch — the workflows panel polls and hands the data down.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, SendHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import { RunStatusDot } from "./detail";
import { CustomerMark } from "../customer-mark";
import { authToken, linkInWorkspace, type WorkflowRunEvent } from "./lib";
import { SESSION_DELEGATION_HEADER, canMessageSession, delegationFromHeader, refusalText } from "@/lib/specialist-run-actions";
import { Chip } from "./primitives";
import { SURFACE, TYPE } from "./tokens";

function dotStatus(s: WorkflowRunRow["status"]): "running" | "failed" | "success" {
  return s === "running" ? "running" : s === "failed" || s === "cancelled" ? "failed" : "success";
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A run-history column: a searchable list of run CARDS (workflow, who ran it,
 * when). A card opens that run as a full chat thread in a NEW TAB — no inline
 * transcript. Shared by the workflow editor and a cron's detail; the parent
 * owns fetching + FILTERING the run list (by workflow, or by cron).
 */
function runBy(createdBy?: string | null): string {
  if (!createdBy) return "manual";
  return createdBy.startsWith("cron:") ? `cron · ${createdBy.slice(5)}` : createdBy;
}

/**
 * The normalized card a run-history column renders — one per run/invocation.
 * Both the workflow editor and an automation's detail feed map their own rows
 * into this so the two columns are pixel-identical. `href === null` renders a
 * muted, non-clickable card; `noSession` appends the "· no session" note.
 */
export interface RunCardModel {
  readonly key: string;
  readonly markName: string;
  readonly runByLabel: string;
  readonly status: "running" | "failed" | "success";
  readonly whenIso: string;
  readonly href: string | null;
  /** A short suffix after the timestamp explaining a non-clickable card —
   *  e.g. "no session" (degraded) or "Slack only" (never ran a workflow). */
  readonly note?: string | null;
  /** Dim the card — reserved for the DEGRADED "no session" case, not for
   *  fires that were simply never meant to open (those read at full strength). */
  readonly dimmed?: boolean;
  readonly error?: string | null;
  readonly search: string;
}

/** Map a workflow run row to the shared card model. */
export function workflowRunCard(r: WorkflowRunRow): RunCardModel {
  const openable = r.hasSession !== false;
  return {
    key: r.runId,
    markName: r.workflowName,
    runByLabel: `Run by ${runBy(r.createdBy)}`,
    status: dotStatus(r.status),
    whenIso: r.createdAt,
    href: openable ? linkInWorkspace(`/?chatWorkflowRun=${encodeURIComponent(r.runId)}`) : null,
    note: openable ? null : "no session",
    dimmed: !openable,
    search: [r.workflowName, r.runId, runBy(r.createdBy), whenLabel(r.createdAt), r.status].join(" "),
  };
}

function RunCard({ card }: { readonly card: RunCardModel }) {
  const inner = (
    <>
      <CustomerMark name={card.markName} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("min-w-0 truncate font-medium", TYPE.meta)}>{card.runByLabel}</span>
          <RunStatusDot status={card.status} />
        </div>
        <span className={cn("flex items-center gap-1.5 tabular-nums text-muted-foreground", TYPE.micro)}>
          {whenLabel(card.whenIso)}
          {card.note ? (
            <span className="rounded-sm bg-muted px-1 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
              {card.note}
            </span>
          ) : null}
        </span>
        {card.error ? (
          <p className={cn("break-words text-red-400", TYPE.micro)}>{card.error}</p>
        ) : null}
      </div>
    </>
  );
  return card.href ? (
    <a
      href={card.href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:border-foreground/30 hover:bg-muted/40"
      title="Open this run as a chat in a new tab"
    >
      {inner}
    </a>
  ) : (
    <div
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2",
        card.dimmed ? "bg-background/40 opacity-60" : null,
      )}
      title={
        card.note === "no session"
          ? "This run has no captured session to open as a chat"
          : card.note === "Slack only"
            ? "This fire only posted to Slack — it never ran a workflow, so there is no chat to open"
            : undefined
      }
    >
      {inner}
    </div>
  );
}

/**
 * A searchable side column of run CARDS — the workflow editor's run history and
 * an automation detail's invocation history render the SAME column, differing
 * only in the cards fed in. The parent owns fetching; this owns search + chrome.
 */
export function RunHistoryColumn({
  cards,
  emptyLabel,
  inline = false,
}: {
  readonly cards: readonly RunCardModel[];
  readonly emptyLabel?: string;
  /** Render as a full-width bordered card inside the detail body (matching the
   *  Apps single-panel design) instead of a separate right-hand column. */
  readonly inline?: boolean;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const filtered = query ? cards.filter((c) => c.search.toLowerCase().includes(query)) : cards;

  return (
    <div
      className={cn(
        "flex flex-col",
        inline
          ? "max-h-96 overflow-hidden rounded-xl border border-border bg-muted/10"
          : "w-80 shrink-0 border-border border-l bg-muted/10",
      )}
    >
      <div className="shrink-0 border-border border-b p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search runs…"
          className={cn(
            "w-full rounded-md border border-border bg-background px-2 py-1 outline-none focus:border-foreground/40",
            TYPE.meta,
          )}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <p className={cn("p-2 text-muted-foreground/60 italic", TYPE.micro)}>
            {emptyLabel ?? "No runs yet."}
          </p>
        ) : filtered.length === 0 ? (
          <p className={cn("p-2 text-muted-foreground/60 italic", TYPE.micro)}>No runs match.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {filtered.map((c) => (
              <li key={c.key}>
                <RunCard card={c} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function eveAuth(): Record<string, string> {
  const t = authToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/**
 * Steer a RUNNING workflow step: attach to its session stream to capture the
 * continuation token (eve's resume handle), then POST guidance to it — the same
 * mechanism the Control Panel uses to steer a chat subagent. Delivery only lands
 * at a pause point (an approval or the child's next boundary), so a message may
 * queue until then; a single-turn step can finish before it delivers.
 *
 * The row's session is often the SPECIALIST the step called, not the step's own, and a message to a delegated
 * specialist's session can only be refused. So nothing is offered until the agent's stream has said this session is
 * not a delegation (lib/specialist-run-actions.ts).
 */
function WorkflowStepSteer({ sessionId }: { readonly sessionId: string }) {
  const [delegated, setDelegated] = useState<boolean | undefined>(undefined);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const queueRef = useRef<string | null>(null);

  const deliver = async (message: string) => {
    const continuationToken = tokenRef.current;
    if (!continuationToken) {
      queueRef.current = message;
      setNote("Queued — delivers when the step next pauses (no mid-turn delivery point in eve).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...eveAuth() },
        body: JSON.stringify({ message, continuationToken }),
      });
      setNote(res.ok ? "Guidance delivered — applies at the next step boundary." : await refusalText(res, `Steer failed (${res.status}).`));
    } catch {
      setNote("Steer failed (network).");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
          headers: eveAuth(),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        setDelegated(delegationFromHeader(res.headers.get(SESSION_DELEGATION_HEADER)));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!ctrl.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            if (!l.trim()) continue;
            try {
              const ev = JSON.parse(l) as { type?: string; data?: { continuationToken?: string } };
              if (ev.type === "session.waiting" && typeof ev.data?.continuationToken === "string") {
                tokenRef.current = ev.data.continuationToken;
                if (queueRef.current) {
                  const q = queueRef.current;
                  queueRef.current = null;
                  void deliver(q);
                }
              }
            } catch {
              /* ignore malformed line */
            }
          }
        }
      } catch {
        /* stream ended/aborted */
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const onSend = () => {
    const m = text.trim();
    if (!m) return;
    setText("");
    void deliver(m);
  };

  if (!canMessageSession(delegated)) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Steer this step…"
          className={cn(
            "min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 outline-none focus:border-foreground/40",
            TYPE.meta,
          )}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="Send guidance"
        >
          <SendHorizontalIcon className="size-3.5" />
        </button>
      </div>
      {note ? <p className={cn("text-muted-foreground", TYPE.micro)}>{note}</p> : null}
    </div>
  );
}

/** One checkpoint row from GET /api/ops/workflow-runs/:runId. */
export interface RunJournalEntry {
  callIndex: number;
  attempt?: number;
  subagent: string | null;
  promptPreview: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  resultPreview: string | null;
  sessionId?: string | null;
  childSessionId?: string | null;
  createdAt: string;
}

/** The durable run row from GET /api/ops/workflow-runs/:runId. */
export interface WorkflowRunRow {
  runId: string;
  workflowId: string | null;
  workflowName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  workerId?: string | null;
  leaseExpiresAt?: string | null;
  lastHeartbeatAt?: string | null;
  cancellationStatus?: "none" | "requested" | "cancelled";
  cancelRequestedAt?: string | null;
  cancelRequestedBy?: string | null;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  error: string | null;
  createdBy?: string | null;
  hasSession?: boolean;
  createdAt: string;
  updatedAt: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtAt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "subagent ← prompt" → the badge text and the prompt snippet. */
function splitAgentText(text: string): { subagent: string; prompt: string } {
  const sep = text.indexOf(" ← ");
  if (sep > 0) return { subagent: text.slice(0, sep), prompt: text.slice(sep + 3) };
  return { subagent: "agent", prompt: text };
}

/** One phase's slice of the flat event list; `index` is the FLAT position. */
interface Section {
  title: string;
  at: number;
  events: { e: WorkflowRunEvent; index: number }[];
}

/** Split the flat log on "phase" events; anything before the first phase is "Run". */
function groupEvents(events: WorkflowRunEvent[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  events.forEach((e, index) => {
    if (e.kind === "phase") {
      current = { title: e.text, at: e.at, events: [] };
      sections.push(current);
      return;
    }
    if (!current) {
      current = { title: "Run", at: e.at, events: [] };
      sections.push(current);
    }
    current.events.push({ e, index });
  });
  return sections;
}

/**
 * The nth agent event in flat order pairs with the nth journal checkpoint
 * (journal is ordered by callIndex) — that is how a finished run's tree picks
 * up the durable statuses the poller saw while it ran.
 */
function agentOrdinals(events: WorkflowRunEvent[]): Map<number, number> {
  const map = new Map<number, number>();
  let n = 0;
  events.forEach((e, i) => {
    if (e.kind === "agent") map.set(i, n++);
  });
  return map;
}

export function AgentStepCard({
  subagent,
  prompt,
  result,
  status,
  detail,
  duration,
  ordinal,
  steerSessionId,
  openSessionId,
}: {
  readonly subagent: string;
  readonly prompt: string;
  readonly result?: string | null;
  readonly status: "success" | "failed" | "running" | "unknown";
  readonly detail?: string | null;
  readonly duration?: string | null;
  readonly ordinal?: number;
  /** The step's steer target (running steps only) — its child/step session. */
  readonly steerSessionId?: string | null;
  /** The step's own session — opened as a full chat thread in a new tab. */
  readonly openSessionId?: string | null;
}) {
  const [open, setOpen] = useState(status === "running" && Boolean(steerSessionId));
  // A workflow step IS a subagent turn: the prompt handed to it and the result
  // it returned. Collapsed by default (scannable), expands into that transcript.
  const expandable = Boolean(prompt || result || detail || steerSessionId);
  return (
    <li className={cn("flex flex-col bg-background/40", SURFACE.inset)}>
      <button
        type="button"
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        className="flex items-start gap-2 px-2 py-1.5 text-left"
        aria-expanded={open}
      >
        <span className="mt-1 flex shrink-0">
          <RunStatusDot status={status} />
        </span>
        {ordinal != null ? (
          <span className={cn("mt-0.5 shrink-0 text-muted-foreground/50 tabular-nums", TYPE.micro)}>
            #{ordinal}
          </span>
        ) : null}
        <Chip className="shrink-0 font-mono">{subagent}</Chip>
        <span
          className={cn("min-w-0 flex-1 break-words text-muted-foreground", TYPE.meta, !open && "truncate")}
        >
          {open ? prompt : truncate(prompt, 120)}
        </span>
        {duration ? (
          <span className={cn("mt-0.5 shrink-0 text-muted-foreground/60 tabular-nums", TYPE.micro)}>
            {duration}
          </span>
        ) : null}
        {expandable ? (
          <ChevronDownIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-border/40 border-t px-2 py-2">
          {result ? (
            <div>
              <p className={cn("mb-1 text-muted-foreground/60 uppercase tracking-wide", TYPE.micro)}>
                Result
              </p>
              <MessageResponse className="text-sm">{result}</MessageResponse>
            </div>
          ) : status === "running" ? (
            <p className={cn("text-muted-foreground/60 italic", TYPE.micro)}>Running…</p>
          ) : (
            <p className={cn("text-muted-foreground/60 italic", TYPE.micro)}>No result recorded.</p>
          )}
          {detail ? <p className={cn("break-words text-red-400", TYPE.micro)}>{detail}</p> : null}
          {status === "running" && steerSessionId ? (
            <WorkflowStepSteer sessionId={steerSessionId} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * FEATURE 1 — the phase-grouped tree of a FINISHED run. Each "phase" event
 * opens a section; agent events render as step cards (badge, snippet, duration
 * to the next event, status dot); log lines stay muted, errors red.
 */
export function RunTimeline({
  events,
  journal,
}: {
  readonly events: WorkflowRunEvent[];
  readonly journal: RunJournalEntry[];
}) {
  const sections = groupEvents(events);
  const ordinals = agentOrdinals(events);
  const sorted = [...journal].sort((a, b) => a.callIndex - b.callIndex);

  return (
    <div className="flex flex-col gap-2">
      {sections.map((s, si) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are positional
        <section key={si}>
          <p className={cn("mb-1 flex items-baseline gap-2", TYPE.sectionLabel)}>
            <span className="text-foreground/80">{s.title}</span>
            <span className="text-muted-foreground/50 tabular-nums">{fmtAt(s.at)}</span>
          </p>
          <ul className="flex flex-col gap-1">
            {s.events.map(({ e, index }) => {
              if (e.kind === "agent") {
                const { subagent, prompt } = splitAgentText(e.text);
                // Duration is only knowable when a later event bounds the step;
                // the last event's own timestamp is not an end time.
                const nextAt = events[index + 1]?.at;
                const j = sorted[ordinals.get(index) ?? -1];
                // No journal checkpoint = no durable evidence the call finished
                // (e.g. the call in flight when a run timed out) — render the
                // unknown fallback, never fabricated success.
                const status =
                  j == null ? "unknown" : j.status === "failed" ? "failed" : "success";
                return (
                  <AgentStepCard
                    key={index}
                    subagent={subagent}
                    prompt={prompt}
                    status={status}
                    detail={j?.status === "failed" ? j.error : null}
                    duration={nextAt != null ? fmtAt(Math.max(0, nextAt - e.at)) : null}
                  />
                );
              }
              return (
                <li
                  key={index}
                  className={cn(
                    "flex gap-2 px-2 font-mono",
                    TYPE.micro,
                    e.kind === "error" ? "text-red-400" : "text-muted-foreground",
                  )}
                >
                  <span className="shrink-0 tabular-nums opacity-60">{fmtAt(e.at)}</span>
                  <span className="min-w-0 break-words">{e.text}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * FEATURE 2 — the checkpoints of a run IN FLIGHT, as they land in the journal.
 * The panel polls GET /api/ops/workflow-runs/:runId and re-renders this list;
 * each entry is a step card keyed by callIndex.
 */
export function LiveRunJournal({ journal }: { readonly journal: RunJournalEntry[] }) {
  if (journal.length === 0) {
    return (
      <p className={cn("px-2 text-muted-foreground/60 italic", TYPE.micro)}>
        Running — waiting for the first checkpoint…
      </p>
    );
  }
  const sorted = [...journal].sort((a, b) => a.callIndex - b.callIndex);
  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((j) => (
        <AgentStepCard
          key={j.callIndex}
          ordinal={j.callIndex}
          subagent={j.subagent ?? "agent"}
          prompt={j.promptPreview}
          result={j.resultPreview}
          status={j.status === "failed" ? "failed" : j.status === "running" ? "running" : "success"}
          detail={j.status === "failed" ? j.error : null}
          steerSessionId={j.status === "running" ? j.childSessionId ?? j.sessionId : null}
          openSessionId={j.sessionId}
        />
      ))}
    </ul>
  );
}
