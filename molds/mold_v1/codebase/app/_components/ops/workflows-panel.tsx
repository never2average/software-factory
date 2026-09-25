"use client";

/**
 * Workflows section: table, stepped Add wizard, inline-editable detail panel
 * with the ⌘K operator-override editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  Building2Icon,
  CheckIcon,
  FileCode2Icon,
  FileTextIcon,
  HistoryIcon,
  ListOrderedIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PowerIcon,
  SparklesIcon,
  SquareIcon,
  TagIcon,
  TextIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { W } from "@/lib/ui-words";
import {
  EMPTY_VALUE,
  InlineField,
  RunStatusDot,
  SummaryList,
  reviewText,
} from "./detail";
import {
  errMessage,
  matches,
  opsFetch,
  panelId,
  splitList,
  authToken,
  useOpsList,
  usePager,
  type ApiWorkflow,
  type ApiSystemCronOverride,
  type ApiWorkflowVersion,
  type PanelState,
  type WorkflowRunEvent,
} from "./lib";
import {
  Banners,
  Chip,
  ConfirmDeleteDialog,
  DeepLink,
  EmptyCell,
  ErrorBanner,
  Field,
  IconButton,
  ListFooter,
  ListRow,
  MenuCell,
  NameCell,
  NotifyEmailField,
  OpsButton,
  OpsInput,
  OpsTextarea,
  PanelLayout,
  RadioCards,
  RowMenu,
  SearchBox,
  SectionHeaderCard,
  SidePanel,
  StateRow,
  StatusDot,
  TableCard,
  Td,
  Th,
  WizardFrame,
  type RadioOption,
} from "./primitives";
import {
  LiveRunJournal,
  RunHistoryColumn,
  RunTimeline,
  workflowRunCard,
  type RunJournalEntry,
  type WorkflowRunRow,
} from "./run-timeline";
import { SURFACE, TYPE } from "./tokens";


import { SUBAGENT_KEYS } from "../subagent-meta.generated";

/* ------------------- Workflow instructions: ⌘K inline editor -------------- */

/**
 * Minimal token highlighter ported from the reference (highlightLine/JS_TOKEN):
 * comments, strings, keywords and numbers get a colour; everything else passes
 * through. Applied line-by-line to the operator-override text.
 */
const JS_TOKEN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|export|from|default|const|let|var|function|return|async|await|if|else|for|of|new|continue|throw|try|catch|type|interface|as|satisfies|readonly)\b|(\b\d+(?:\.\d+)?\b)/g;

function highlightLine(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  JS_TOKEN.lastIndex = 0;
  for (let m = JS_TOKEN.exec(line); m != null; m = JS_TOKEN.exec(line)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [text, comment, string, keyword, num] = m;
    const cls = comment
      ? "text-muted-foreground/60 italic"
      : string
        ? "text-emerald-500"
        : keyword
          ? "text-sky-500"
          : num
            ? "text-amber-500"
            : undefined;
    out.push(
      <span key={key++} className={cls}>
        {text}
      </span>,
    );
    last = m.index + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** "1 specialist" / "2 specialists": how many a workflow delegates to that this deployment does not have. */
const missingSpecialists = (n: number) => `${n} specialist${n === 1 ? "" : "s"}`;

/** The declared eve subagents — the only names an override can actually reach. */
const SUBAGENT_IDS = new Set<string>(SUBAGENT_KEYS);

/**
 * The workflow's SCRIPT editor: a full-area code surface whose tab names the
 * script, with one menu holding every action on it — run, edit, restore a
 * version, clear.
 *
 * A workflow IS this script. It orchestrates the subagents rather than exposing
 * them: `agent(prompt, { subagent })` delegates a step, parallel() fans out,
 * pipeline() streams items through stages, phase() groups the run. The script
 * runs in a QuickJS sandbox with no filesystem, no network and no host objects
 * (lib/workflow-runtime.ts), and its steps reach the agent with the OPERATOR's
 * own credentials — a run can never do what the person who started it could not.
 */
/** What a new workflow starts as: the smallest script that actually does work. */
const BASE_STARTER_SCRIPT = `export const meta = {
  name: "triage",
  description: "Triage open tickets and draft a reply for the worst one.",
};

type Worst = { ticket: string; why: string };

phase("Find");
const worst: Worst = await agent(
  "List the open tickets that are past SLA and name the single worst one.",
  { subagent: "customer-context" },
);

phase("Draft");
const reply = await agent(\`Draft a reply for: \${worst.ticket}\`, { subagent: "follow-ups" });

log("drafted a reply");
return { worst, reply };
`;

/**
 * The starter above delegates to two base specialists. A deployment whose profile excludes either starts from one
 * step that delegates to a specialist it HAS: a new workflow must never name one this deployment does not use.
 */
const STARTER_SCRIPT =
  SUBAGENT_IDS.has("customer-context") && SUBAGENT_IDS.has("follow-ups")
    ? BASE_STARTER_SCRIPT
    : `export const meta = {
  name: "first-step",
  description: "Ask one specialist for one thing and return its answer.",
};

phase("Ask");
const answer = await agent(
  "In three bullet points: what can you do in this workspace?",${SUBAGENT_KEYS[0] ? `\n  { subagent: ${JSON.stringify(SUBAGENT_KEYS[0])} },` : ""}
);

log("asked");
return { answer };
`;

function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function scriptFile(name: string): string {
  return `${slugOf(name) || "workflow"}.workflow.ts`;
}

/**
 * The subagent's instructions override — the OTHER file a workflow owns.
 *
 * It is not dead: `agent/subagents/<id>/instructions/operator-override.ts` still
 * injects it at every turn, so text left here silently steers the subagent that
 * the script's `agent()` steps delegate to. That is exactly why it must stay
 * VISIBLE and editable rather than becoming invisible state — an override you
 * cannot see is one you cannot reason about when a run misbehaves.
 *
 * It only reaches a subagent when the workflow's name matches a declared one.
 */
function overrideFile(name: string): string {
  const id = slugOf(name);
  return SUBAGENT_IDS.has(id) ? `agent/subagents/${id}/instructions.md` : `${id}.override.md`;
}

/** Which of the workflow's two files the editor has open. */
type EditorFile = "script" | "instructions";

function versionLabel(v: ApiWorkflowVersion): string {
  const when = new Date(v.createdAt);
  const stamp = Number.isNaN(when.getTime())
    ? v.createdAt
    : when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  const size = v.content ? `${v.content.trim().split(/\s+/).length} words` : "cleared";
  return `${stamp} · ${size}`;
}

function WorkflowOverrideEditor({
  workflow,
  authorEmail,
  onSaved,
  menuItems,
  actionsHost,
}: {
  readonly workflow: ApiWorkflow;
  readonly authorEmail?: string;
  readonly onSaved: () => Promise<void>;
  /** The workflow-level items, folded into this pane's ONE menu. */
  readonly menuItems?: React.ReactNode;
  /** Where the pane's one "..." renders: the panel header, beside the ×. */
  readonly actionsHost?: HTMLElement | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The payload draft, shown before a run and editable.
   *
   * Null means the sheet is closed. A workflow that reads no arguments never
   * opens it — most do not, since a script is expected to work out its own
   * scope — so this stays out of the way of the common case.
   */
  const [argsDraft, setArgsDraft] = useState<string | null>(null);
  const [argsKeys, setArgsKeys] = useState<string[]>([]);
  const [argsNote, setArgsNote] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  /**
   * Ask for a draft; run straight away when there is nothing to fill in.
   *
   * The model proposes VALUES only — the keys come from the script — so the
   * draft cannot be rejected by the validator that guards the run.
   */
  const startRun = async () => {
    setDraftError(null);
    setDrafting(true);
    try {
      const d = await opsFetch<{ args: Record<string, unknown>; keys: string[]; note?: string }>(
        `/api/ops/workflows/${workflow.id}/args`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!d.keys.length) {
        await run();
        return;
      }
      setArgsKeys(d.keys);
      setArgsNote(d.note ?? null);
      setArgsDraft(JSON.stringify(d.args, null, 2));
    } catch (e) {
      // Drafting is an aid, not a gate: fall back to running unscoped rather
      // than blocking a run because a suggestion could not be produced.
      setDraftError(errMessage(e));
      await run();
    } finally {
      setDrafting(false);
    }
  };
  const [versions, setVersions] = useState<ApiWorkflowVersion[] | null>(null);
  const [runEvents, setRunEvents] = useState<WorkflowRunEvent[]>([]);
  // The durable side of a run: the journal checkpoints the poller saw, the run
  // row itself (status + attempts), whether we are still polling, and — when a
  // run timed out resumably — the id a Resume re-POST should carry.
  const [runJournal, setRunJournal] = useState<RunJournalEntry[]>([]);
  const [liveRun, setLiveRun] = useState<WorkflowRunRow | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // The run-history column to the right of the editor: all runs of THIS
  // workflow, newest first, polled so a live run appears and advances.
  const [runsList, setRunsList] = useState<WorkflowRunRow[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await opsFetch<{ runs: WorkflowRunRow[] }>("/api/ops/workflow-runs?limit=50");
        if (alive) setRunsList(d.runs ?? []);
      } catch {
        /* transient */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const myRuns = useMemo(
    () => runsList.filter((r) => r.workflowName === workflow.name),
    [runsList, workflow.name],
  );
  const [polling, setPolling] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [showRawLog, setShowRawLog] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Sequence guard for poll responses: each GET takes a ticket when it STARTS,
  // and only a response holding a ticket newer than the last applied one may
  // write state — a slow interval GET that resolves after the finally-block's
  // final read can no longer clobber the completed run with stale data.
  const pollSeqRef = useRef(0);
  const pollAppliedRef = useRef(0);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );
  const [open, setOpen] = useState<EditorFile>("script");
  // The ⌘K inline agent: an instruction, and whether it is in flight.
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // Where the inline agent floats: the caret's line, and the code's scroll — the
  // card is pinned to the ACTIVE LINE, so it has to move when either changes.
  const [caretLine, setCaretLine] = useState(1);
  const [codeScroll, setCodeScroll] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const askCardRef = useRef<HTMLDivElement>(null);
  // The key listeners are registered once; these let them read live state.
  const askingRef = useRef(false);
  const editingRef = useRef(false);
  askingRef.current = asking;
  editingRef.current = editing;

  const showFile = (next: EditorFile) => {
    if (next === open) return;
    setOpen(next);
    setEditing(false);
    setError(null);
    // The other file's history is not this file's history.
    setVersions(null);
  };

  const isScript = open === "script";
  const file = isScript ? scriptFile(workflow.name) : overrideFile(workflow.name);
  const text = (isScript ? workflow.script : workflow.instructions) ?? "";
  // The override has its own on/off switch; the script has none (it runs when
  // you run it), so the chip carries the one fact each file actually has.
  const overrideLive = workflow.instructionsEnabled && (workflow.instructions ?? "").trim() !== "";
  // An override only reaches a SUBAGENT when the workflow is named after one
  // (agent/lib/workflow-override.ts matches on the name). On any other workflow
  // the text still counts — the ⌘K author is given it and writes scripts that
  // obey it — but it never lands in a subagent's context, and the editor says so
  // rather than letting the operator believe otherwise.
  const overrideReachesSubagent = SUBAGENT_IDS.has(slugOf(workflow.name));

  const startEdit = useCallback(() => {
    setDraft(
      isScript ? (workflow.script ?? STARTER_SCRIPT) : (workflow.instructions ?? ""),
    );
    setError(null);
    setEditing(true);
  }, [isScript, workflow.script, workflow.instructions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K opens the inline agent over the code — say what the workflow should
      // do, it writes the script. ⌘E is bound to the same thing because some
      // browsers (Chrome, and the assistant-sidebar browsers built on it) claim
      // ⌘K for themselves and never hand the event to the page at all.
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "k" && key !== "e") return;
      const t = e.target;
      // Inside the code textarea ⌘K still opens the agent (that is the point);
      // any OTHER control that owns typing keeps its own behaviour.
      const typingElsewhere =
        t instanceof HTMLElement &&
        t !== textareaRef.current &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typingElsewhere) return;
      e.preventDefault();
      e.stopPropagation();
      setAskError(null);
      // The card floats over the caret, so there has to be a caret: open the
      // editor if it is not already open.
      if (!editingRef.current) startEdit();
      setAsking(true);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !askingRef.current) return;
      // The side panel closes itself on Escape (capture, on document). Window
      // capture runs first, so this is the only place that can dismiss the card
      // WITHOUT the whole panel going with it.
      e.preventDefault();
      e.stopPropagation();
      setAsking(false);
    };
    // Clicking away is the other way out — the only one, now that the card has no
    // × of its own. Pointerdown, not click: the card must go the moment you reach
    // for the code, not after the click has landed somewhere behind it.
    const onPointerDown = (e: PointerEvent) => {
      if (!askingRef.current) return;
      const t = e.target;
      if (t instanceof Node && askCardRef.current?.contains(t)) return;
      setAsking(false);
    };
    // Capture, on window: the earliest point the page can see the key at all.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [startEdit]);

  useEffect(() => {
    if (asking) askRef.current?.focus();
  }, [asking]);

  /**
   * The inline agent. It WRITES the script; it does not run it — the reply lands
   * in the editor as an unsaved draft, so nothing reaches the sandbox until the
   * operator reads it and hits Save.
   */
  const generate = async () => {
    const prompt = ask.trim();
    if (!prompt) return;
    const token = authToken();
    if (!token) {
      setAskError("Sign in again — writing a script uses your own credentials.");
      return;
    }
    setGenerating(true);
    setAskError(null);
    try {
      const res = await fetch(`/api/ops/workflows/${workflow.id}/author`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, current: editing ? draft : (workflow.script ?? "") }),
      });
      const data = (await res.json()) as { script?: string; error?: string; issues?: string[] };
      if (!res.ok || !data.script) {
        setAskError(data.error ?? `The agent could not write it (${res.status}).`);
        return;
      }
      setDraft(data.script);
      setEditing(true);
      setAsking(false);
      setAsk("");
      // The script is in the editor either way; a validator complaint is a note,
      // not a refusal — Save and Run are what enforce.
      setError(data.issues?.length ? data.issues.join(" · ") : null);
    } catch (e) {
      setAskError(errMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  // Every action on the override is the same PATCH; returns false so callers
  // can keep the editor open on failure with the operator's draft intact.
  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await opsFetch(`/api/ops/workflows/${workflow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      });
      // A save is a new version — drop the cached list so the menu re-reads it.
      setVersions(null);
      await onSaved();
      return true;
    } catch (e) {
      setError(errMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const value = draft.trim() ? draft : null;
    const ok = await patch(isScript ? { script: value } : { instructions: value });
    if (ok) setEditing(false);
  };

  // Restoring is not a rewind: it writes the old text back through the normal
  // save, which appends a version of its own. History only ever grows.
  const restore = async (v: ApiWorkflowVersion) => {
    const value = v.content?.trim() ? v.content : null;
    await patch(isScript ? { script: value } : { instructions: value });
  };

  // Run the script. The run id is minted CLIENT-side ("wfr_…") and sent with
  // the POST, so while the request is pending the panel can poll the durable
  // journal at GET /api/ops/workflow-runs/:runId and show each checkpoint as it
  // lands — the operator watches steps, not a spinner. When the POST resolves,
  // its events replace the live view as the phase-grouped tree.
  const run = async (existingRunId?: string, args?: unknown) => {
    const token = authToken();
    if (!token) {
      setError("Sign in again — a run uses your own credentials to reach the agent.");
      return;
    }
    const runId = existingRunId ?? `wfr_${crypto.randomUUID()}`;
    setActiveRunId(runId);
    setBusy(true);
    setError(null);
    setRunEvents([]);
    setRunJournal([]);
    setLiveRun(null);
    setResumeId(null);
    setShowRawLog(false);
    setPolling(true);
    // Discard any response still in flight from a previous run of this panel.
    pollAppliedRef.current = pollSeqRef.current;
    const poll = async () => {
      const ticket = ++pollSeqRef.current;
      try {
        const data = await opsFetch<{ run: WorkflowRunRow | null; journal: RunJournalEntry[] }>(
          `/api/ops/workflow-runs/${runId}`,
        );
        // Only apply if no newer-started request has already landed — a slow
        // interval GET must not overwrite the final post-completion read.
        if (ticket <= pollAppliedRef.current) return;
        pollAppliedRef.current = ticket;
        setLiveRun(data.run);
        setRunJournal(data.journal);
      } catch {
        // The row may not exist yet (or the DB blinked) — keep polling.
      }
    };
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => void poll(), 2500);
    void poll();
    try {
      const res = await fetch(`/api/ops/workflows/${workflow.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          actor: authorEmail,
          runId,
          ...(args === undefined ? {} : { args }),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        ok?: boolean;
        events?: WorkflowRunEvent[];
        resumable?: boolean;
        durableRunId?: string;
      };
      setRunEvents(data.events ?? []);
      if (data.resumable && data.durableRunId) setResumeId(data.durableRunId);
      if (!res.ok || data.error) setError(data.error ?? `The run failed (${res.status}).`);
      await onSaved();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      // One last read so the tree merges the FINAL step statuses, not the ones
      // from up to 2.5s ago.
      await poll();
      setPolling(false);
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    const runId = liveRun?.status === "running" ? liveRun.runId : activeRunId;
    if (!runId) return;
    try {
      await opsFetch(`/api/ops/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Cancelled from the workflow editor" }),
      });
      setError(null);
    } catch (cause) {
      setError(errMessage(cause));
    }
  };

  const loadVersions = async () => {
    if (versions !== null) return;
    try {
      // The history of the file that is OPEN — the script and the override are
      // separate files with separate pasts.
      const data = await opsFetch<{ items: ApiWorkflowVersion[] }>(
        `/api/ops/workflows/${workflow.id}/versions?kind=${open}`,
      );
      setVersions(data.items);
    } catch (e) {
      setVersions([]);
      setError(errMessage(e));
    }
  };

  // Eagerly: an arrow that opens onto "No earlier versions yet" is a promise the
  // menu cannot keep, so the count has to be known before the row is drawn.
  useEffect(() => {
    void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.id, open, versions === null]);

  // What the pane DRAWS: the file, or — when the file is empty — the scaffold
  // the editor would hand you, so an empty workflow is never a blank rectangle.
  const preview = (
    text || (isScript ? STARTER_SCRIPT : "")
  ).replace(/\n$/, "").split("\n");

  const menuContent = (
      <DropdownMenuContent align="end" className="min-w-48">
        {isScript ? (
          <>
            <DropdownMenuItem
              className={cn("gap-2", TYPE.body)}
              disabled={text.trim() === "" || busy || drafting}
              onSelect={() => void startRun()}
            >
              <PlayIcon className="size-3.5" />
              {drafting ? "Preparing…" : "Run workflow"}
            </DropdownMenuItem>
            {liveRun?.status === "running" ? (
              <DropdownMenuItem
                variant="destructive"
                className={cn("gap-2", TYPE.body)}
                onSelect={() => void cancelRun()}
              >
                <SquareIcon className="size-3.5" />
                Cancel current run
              </DropdownMenuItem>
            ) : null}
          </>
        ) : (
          <DropdownMenuItem
            className={cn("gap-2", TYPE.body)}
            disabled={text.trim() === "" || busy}
            onSelect={() => void patch({ instructionsEnabled: !workflow.instructionsEnabled })}
          >
            <PowerIcon className="size-3.5" />
            {workflow.instructionsEnabled ? "Disable override" : "Enable override"}
          </DropdownMenuItem>
        )}
        {versions && versions.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn("gap-2", TYPE.body)}>
              <HistoryIcon className="size-3.5" />
              Restore version
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-64 min-w-56 overflow-y-auto">
              {versions.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  className={cn("flex-col items-start gap-0", TYPE.body)}
                  onSelect={() => void restore(v)}
                >
                  <span className="tabular-nums">{versionLabel(v)}</span>
                  <span className={cn("truncate text-muted-foreground", TYPE.micro)}>
                    {v.author}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {isScript ? (
          <>
            {/* The override is not dead code — it still reaches the subagent
                every turn — so it stays one click away, just not in a tab. */}
            <DropdownMenuItem
              className={cn("gap-2", TYPE.body)}
              onSelect={() => showFile("instructions")}
            >
              <FileTextIcon className="size-3.5" />
              Instructions override
              {(workflow.instructions ?? "").trim() ? (
                <Chip className={cn("ml-auto", overrideLive ? undefined : "text-amber-500")}>
                  {overrideLive ? "on" : "off"}
                </Chip>
              ) : null}
            </DropdownMenuItem>
          </>
        ) : null}
        {menuItems ? (
          <>
            <DropdownMenuSeparator />
            {menuItems}
          </>
        ) : null}
      </DropdownMenuContent>
  );

  // The ONE menu for this pane — the file's actions and the workflow's. It is
  // rendered into the panel header (beside the dismiss button) when the host
  // gives us a slot, so the "..." and the × are the same control strip and stay
  // aligned no matter what the editor is doing underneath.
  /** Which line the caret is on — the line the ⌘K card pins itself to. */
  const trackCaret = (el: HTMLTextAreaElement) => {
    const upto = el.value.slice(0, el.selectionStart ?? 0);
    setCaretLine(upto.split("\n").length);
    setCodeScroll(el.scrollTop);
  };

  // The card sits just under the caret's line. The numbers are the editor's own:
  // `p-3` is 12px of padding and `leading-5` is a 20px line box, so line N's
  // bottom edge is 12 + N*20 — minus however far the code has scrolled away.
  const CODE_PAD = 12;
  const LINE_H = 20;
  const askTop = Math.max(CODE_PAD, CODE_PAD + caretLine * LINE_H - codeScroll);

  /**
   * The ⌘K inline agent — Cursor's shape: a card floating OVER the code at the
   * line you are on, not a bar bolted to the top of the pane. Say what the
   * workflow should do and it writes the script into the editor as an unsaved
   * draft. It authors; it never runs. Nothing reaches the sandbox until you read
   * it and press Save.
   */
  const askCard = asking ? (
    <div
      ref={askCardRef}
      data-escape-trap
      // Narrow and tall, and it does NOT span the pane: it is a note pinned to a
      // line of code, so it takes the width of a prompt, not the width of a file.
      className="absolute left-3 z-20 w-80"
      style={{ top: askTop }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <div className={cn("flex flex-col", SURFACE.overlay)}>
        {/* The prompt is a paragraph, not a search box: a real textarea, with the
            Go button riding INSIDE it so the two never separate. */}
        <div className="relative">
          <OpsTextarea
            ref={askRef}
            aria-label="Instruct the agent"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            disabled={generating}
            rows={4}
            spellCheck={false}
            placeholder={
              text.trim()
                ? "Change this workflow… e.g. add a phase that emails the summary"
                : "Describe the workflow… e.g. triage overdue tickets and draft a reply"
            }
            className={cn(
              "min-h-24 w-full resize-none rounded-lg border-0 bg-transparent p-2.5 pb-9 shadow-none focus-visible:ring-0",
              TYPE.meta,
            )}
            onKeyDown={(e) => {
              // ⏎ sends, ⇧⏎ is a new line — the prompt is multi-line, so the
              // send key has to be the one that ISN'T how you write a paragraph.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void generate();
              }
            }}
          />
          {/* Fixed to the corner of the field, floating over the text. */}
          <OpsButton
            intent="primary"
            size="xs"
            aria-label="Generate"
            onClick={() => void generate()}
            disabled={generating || !ask.trim()}
            className="absolute right-2 bottom-2 size-7 rounded-full p-0 shadow-md"
          >
            {generating ? (
              <Spinner className="size-3.5" />
            ) : (
              <ArrowUpIcon className="size-3.5" />
            )}
          </OpsButton>
        </div>
        {askError ? (
          <div className="px-2.5 pb-2.5">
            <ErrorBanner message={askError} />
          </div>
        ) : null}
        <p
          className={cn(
            "border-border/60 border-t px-2.5 py-1.5 text-muted-foreground/60",
            TYPE.micro,
          )}
        >
          {generating ? "Writing the script…" : "⏎ send · esc or click away to dismiss"}
        </p>
      </div>
    </div>
  ) : null;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label="Workflow actions"
          disabled={busy}
          className="data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          {busy ? <Spinner className="size-3.5" /> : <MoreHorizontalIcon className="size-3.5" />}
        </IconButton>
      </DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  );

  return (
    // Flush to the panel's edges — this IS the right side of the modal, not a
    // card sitting inside it.
    <div
      ref={rootRef}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background/60"
    >
      {actionsHost ? createPortal(menu, actionsHost) : null}
      {/* The tab bar IS the pane's title: the file this text feeds, named the
          way an editor names an open file. Its actions live in the header menu. */}
      {/* h-11 is not decoration: the panel's × and "..." float at top-2.5 and are
          24px tall, so their centre line is 22px down. A 44px tab bar puts this
          row's centre on exactly that line, and the three controls read as one
          strip instead of three heights. */}
      <div
        className={cn(
          "flex h-11 shrink-0 items-stretch border-b border-border bg-muted/20",
          // Only reserve room for the header controls when they actually float
          // over this row (i.e. no drawer is pushing it down).
          actionsHost ? "pr-[4.75rem]" : "pr-2",
        )}
      >
        {/* ONE tab: the file that is open. The workflow is the script — the
            subagent's instructions.md is a rarely-touched override, so it is
            reached from the menu, not parked next to the script forever. */}
        <span className="flex min-w-0 items-center gap-2 border-border border-r bg-background px-3">
          <FileCode2Icon className="size-3.5 shrink-0 opacity-70" />
          <span className={cn("truncate font-mono", TYPE.meta)}>{file}</span>
          {!isScript ? (
            <Chip className={overrideLive ? undefined : "text-amber-500"}>
              {overrideLive ? "on" : "off"}
            </Chip>
          ) : null}
        </span>
        {!isScript ? (
          <button
            type="button"
            onClick={() => showFile("script")}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-border border-r px-3 text-muted-foreground hover:bg-background/50",
              TYPE.meta,
            )}
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to the script
          </button>
        ) : null}
        <span className="flex-1" />
        {actionsHost ? null : menu}
      </div>

      {/* Editor on the left, run-history column on the right. The editor is the
          frame the ⌘K card floats INSIDE — pinned to the active line. */}
      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {askCard}
      {editing ? (
        <div
          data-escape-trap
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
        >
          <OpsTextarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              trackCaret(e.currentTarget);
            }}
            onSelect={(e) => trackCaret(e.currentTarget)}
            onScroll={(e) => setCodeScroll(e.currentTarget.scrollTop)}
            spellCheck={false}
            disabled={busy}
            placeholder={
              isScript
                ? STARTER_SCRIPT
                : "e.g. Always cross-check ticket SLAs against the data room before drafting, and flag anything ambiguous instead of guessing."
            }
            className={cn(
              "min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono leading-5 focus-visible:ring-0",
              TYPE.meta,
            )}
          />
          {/*
            The payload, drafted and editable.
            Shown only when the script reads arguments — most do not, and a
            dialog asking for {} would be a step that teaches people to click
            through. Keys are fixed by the script; the values are the model's
            suggestion and yours to correct.
          */}
          {argsDraft !== null ? (
            <div className="border-border border-t px-2.5 py-2">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <p className={cn("font-medium", TYPE.meta)}>Run with</p>
                <p className={cn("truncate text-muted-foreground", TYPE.micro)}>
                  reads {argsKeys.join(", ")}
                </p>
              </div>
              <textarea
                value={argsDraft}
                onChange={(e) => {
                  setArgsDraft(e.target.value);
                  setDraftError(null);
                }}
                spellCheck={false}
                rows={Math.min(10, argsDraft.split("\n").length + 1)}
                className={cn(
                  "w-full resize-y rounded-md border border-border bg-background p-2 font-mono leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30",
                  TYPE.meta,
                )}
              />
              {argsNote ? (
                <p className={cn("mt-1 text-muted-foreground", TYPE.micro)}>{argsNote}</p>
              ) : null}
              {draftError ? (
                <p className={cn("mt-1 text-red-600 dark:text-red-400", TYPE.micro)}>{draftError}</p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <OpsButton
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    // Parse HERE so a typo is caught while the JSON is still on
                    // screen next to the cursor, rather than as a 400 after the
                    // sheet has closed. The server re-checks regardless.
                    let value: unknown;
                    try {
                      value = JSON.parse(argsDraft);
                    } catch (e) {
                      setDraftError(`Not valid JSON: ${errMessage(e)}`);
                      return;
                    }
                    setArgsDraft(null);
                    void run(undefined, value);
                  }}
                >
                  Run with this payload
                </OpsButton>
                <OpsButton intent="secondary" size="sm" onClick={() => setArgsDraft(null)}>
                  Cancel
                </OpsButton>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="px-2 pb-2">
              <ErrorBanner message={error} />
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-1.5">
            <p className={cn("truncate text-muted-foreground", TYPE.micro)}>
              {isScript
                ? "TypeScript, run sandboxed. agent() delegates a step; parallel() and pipeline() fan out."
                : overrideReachesSubagent
                  ? `Appended to the ${slugOf(workflow.name)} subagent's instructions every turn, and given to ⌘K when it writes this script.`
                  : "No subagent is named after this workflow, so this text reaches ⌘K when it writes the script — not a subagent's context."}
            </p>
            <OpsButton
              intent="ghost"
              size="xs"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="ml-auto"
            >
              Cancel
            </OpsButton>
            <OpsButton intent="primary" size="xs" onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner className="size-3" /> : <CheckIcon className="size-3" />}
              Save
            </OpsButton>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="flex min-h-0 flex-1 cursor-text flex-col items-stretch justify-start overflow-auto text-left"
        >
          {/* An empty file used to render an empty pane, which reads as broken
              rather than as empty. Show the scaffold the editor would GIVE you,
              dimmed, so the pane always shows the shape of the file. */}
          {text ? null : (
            <p
              className={cn(
                "border-border/60 border-b px-3 py-2 text-muted-foreground/60 italic",
                TYPE.meta,
              )}
            >
              {isScript
                ? "No script yet — press ⌘K (or ⌘E) and say what it should do, or click here to write it yourself."
                : overrideReachesSubagent
                  ? "No override — click here to add standing instructions for this subagent."
                  : "No override — click here to add standing instructions. They will steer ⌘K when it writes this workflow's script."}
            </p>
          )}
          <pre
            className={cn(
              "min-w-max p-3 font-mono leading-5",
              TYPE.meta,
              text ? undefined : "opacity-40",
            )}
          >
            {preview.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              <div key={i} className="flex">
                <span className="w-8 shrink-0 select-none pr-3 text-right text-muted-foreground/40 tabular-nums">
                  {i + 1}
                </span>
                <code className="whitespace-pre">{highlightLine(line)}</code>
              </div>
            ))}
          </pre>
        </button>
      )}
      </div>
      {!editing ? (
        <RunHistoryColumn
          cards={myRuns.map(workflowRunCard)}
          emptyLabel="No runs of this workflow yet."
        />
      ) : null}
      </div>

      {!editing && error ? (
        <div className="shrink-0 px-2 pb-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}
    </div>
  );
}


/**
 * The workflow's right pane. The EDITOR is the pane: its tab bar carries the
 * pane's title (the file the override feeds) and the editor runs the full
 * height beneath it, flush to the panel's edges.
 *
 * The workflow's own surfaces — its fields, its last runs, what it has spent —
 * are not gone: they pull down OVER the editor from the "..." menu beside the
 * dismiss button, one at a time, and close again. Nothing permanently squats
 * above the editor.
 */

/**
 * The workflow-level half of the "..." menu.
 *
 * These are ITEMS, not a menu: there is exactly ONE menu in this pane (the
 * editor's), and it carries both the actions on the open FILE and the actions
 * on the WORKFLOW. Two triggers side by side — a chevron and a "..." — was the
 * bug: two menus, overlapping, with no way to tell which owned what.
 */
function WorkflowMenuItems({
  workflow,
  onToggleEnabled,
  onDelete,
}: {
  readonly workflow: ApiWorkflow;
  readonly onToggleEnabled: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem className={cn("gap-2", TYPE.body)} onSelect={() => onToggleEnabled()}>
        {workflow.enabled ? (
          <>
            <PauseIcon className="size-3.5" />
            Pause workflow
          </>
        ) : (
          <>
            <PlayIcon className="size-3.5" />
            Resume workflow
          </>
        )}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        className={cn("gap-2", TYPE.body)}
        onSelect={() => onDelete()}
      >
        <Trash2Icon className="size-3.5" />
        Delete workflow
      </DropdownMenuItem>
    </>
  );
}

function WorkflowPane({
  workflow,
  authorEmail,
  onSaved,
  menuItems,
  actionsHost,
}: {
  readonly workflow: ApiWorkflow;
  readonly authorEmail?: string;
  readonly onSaved: () => Promise<void>;
  readonly menuItems?: React.ReactNode;
  readonly actionsHost?: HTMLElement | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkflowOverrideEditor
        workflow={workflow}
        authorEmail={authorEmail}
        onSaved={onSaved}
        menuItems={menuItems}
        actionsHost={actionsHost}
      />
    </div>
  );
}

/* ------------------------------ Workflow wizard -------------------------- */

const CUSTOM_TRIGGER = "__custom__";

const TRIGGER_OPTIONS: RadioOption<string>[] = [
  {
    value: "on delegation",
    title: "On delegation",
    description: "Runs when the orchestrator delegates a matching task to it.",
  },
  {
    value: "manual",
    title: "Manual",
    description: "Runs only when a teammate starts it explicitly.",
  },
  {
    value: CUSTOM_TRIGGER,
    title: "Custom trigger",
    description: "Describe your own trigger condition.",
  },
];

const WORKFLOW_WIZARD_STEPS = [
  {
    heading: "How should this workflow start?",
    subtitle: "Select the trigger that kicks it off.",
  },
  {
    heading: "Workflow details",
    subtitle: "Name it and describe what it does when it runs.",
  },
  {
    heading: "What are the steps?",
    subtitle: "One step per line — the agent runs them in order.",
  },
  {
    heading: "Review & create",
    subtitle: "Double-check the workflow before creating it.",
  },
];

function WorkflowWizard({
  authorEmail,
  onDone,
  onCancel,
}: {
  readonly authorEmail?: string;
  readonly onDone: (id: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [triggerChoice, setTriggerChoice] = useState("on delegation");
  const [customTrigger, setCustomTrigger] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [steps, setSteps] = useState("");
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = triggerChoice === CUSTOM_TRIGGER ? customTrigger.trim() : triggerChoice;

  const valid =
    step === 0
      ? trigger.length > 0
      : step === 1
        ? name.trim().length > 0 && description.trim().length > 0
        : true;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await opsFetch<{ item: ApiWorkflow }>("/api/ops/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          trigger,
          steps: splitList(steps),
          customerId: customerId.trim() || undefined,
          notifyEmails: notifyEmails.length ? notifyEmails : undefined,
          createdBy: authorEmail,
        }),
      });
      await onDone(created.item.id);
    } catch (e) {
      setError(errMessage(e));
      setCreating(false);
    }
  };

  const meta = WORKFLOW_WIZARD_STEPS[step];
  return (
    <WizardFrame
      heading={meta.heading}
      subtitle={meta.subtitle}
      step={step}
      stepCount={WORKFLOW_WIZARD_STEPS.length}
      valid={valid}
      creating={creating}
      error={error}
      onBack={() => (step === 0 ? onCancel() : setStep(step - 1))}
      onNext={() => (step === WORKFLOW_WIZARD_STEPS.length - 1 ? void create() : setStep(step + 1))}
    >
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <RadioCards
            label="Trigger"
            value={triggerChoice}
            onChange={setTriggerChoice}
            options={TRIGGER_OPTIONS}
          />
          {triggerChoice === CUSTOM_TRIGGER ? (
            <Field label="Custom trigger">
              <OpsInput
                value={customTrigger}
                onChange={(e) => setCustomTrigger(e.target.value)}
                placeholder="on new P1 ticket"
              />
            </Field>
          ) : null}
        </div>
      ) : null}
      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <OpsInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ticket-triage"
            />
          </Field>
          <Field label="Description">
            <OpsTextarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this workflow does when the orchestrator delegates to it."
            />
          </Field>
          <Field label={`${W.Account} ID`} hint="Optional — scope the workflow to one account.">
            <OpsInput
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder={W.accountIdExample}
            />
          </Field>
          <NotifyEmailField recipients={notifyEmails} onRecipients={setNotifyEmails} />
        </div>
      ) : null}
      {step === 2 ? (
        <Field label="Steps" hint="One per line (commas work too).">
          <OpsTextarea
            className="min-h-28 font-mono"
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            placeholder={"pull open tickets\nrank by SLA\ndraft summary"}
          />
        </Field>
      ) : null}
      {step === 3 ? (
        <SummaryList
          fields={[
            { label: "Name", value: reviewText(name.trim()) },
            { label: "Trigger", value: reviewText(trigger) },
            { label: "Description", value: reviewText(description.trim()) },
            { label: W.Account, value: reviewText(customerId.trim() || null) },
            { label: "Notify", value: reviewText(notifyEmails.join(", ") || null) },
            {
              label: "Steps",
              value: splitList(steps).length ? (
                <ol className="list-decimal space-y-0.5 pl-4">
                  {splitList(steps).map((s, i) => (
                    <li key={`${i}-${s}`}>{s}</li>
                  ))}
                </ol>
              ) : (
                EMPTY_VALUE
              ),
            },
          ]}
        />
      ) : null}
    </WizardFrame>
  );
}

/* ------------------------------ Workflows panel -------------------------- */

export function WorkflowsPanel({
  authorEmail,
  initialSelectedId,
  onInitialConsumed,
}: {
  readonly authorEmail?: string;
  readonly initialSelectedId?: string;
  readonly onInitialConsumed?: () => void;
}) {
  const { items, extra, error, refetch, loading } = useOpsList<ApiWorkflow>("/api/ops/workflows");
  // Why this workspace has fewer (or none) of the base library's workflows — said, not left as an empty list.
  // Computed by GET /api/ops/workflows (lib/workflow-availability.ts), so the library's text stays on the server.
  const LIBRARY_NOTE = typeof extra.libraryNote === "string" ? extra.libraryNote : null;
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which surface is pulled down over the editor. Lives here, not in the pane,
  // because the "..." menu that drives it sits in the panel's chrome.
  // The header slot the editor portals its "..." into. A callback ref in state
  // (not a useRef) because the editor must RE-RENDER once the node exists.
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiWorkflow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // System crons can ROUTE to a workflow (override.workflow) — that workflow is
  // effectively cron-triggered even though its own `trigger` field still reads
  // "manual". Cross-reference so the list shows the real trigger.
  const { items: cronItems } = useOpsList<ApiSystemCronOverride>("/api/ops/system-crons");
  const cronByWorkflow = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cronItems ?? []) {
      if (c.workflow) map.set(c.workflow, c.name);
    }
    return map;
  }, [cronItems]);
  const triggerLabel = (w: ApiWorkflow) => {
    const cron = cronByWorkflow.get(w.name);
    return cron ? `cron · ${cron}` : w.trigger;
  };

  // The workflows table also holds the 8 SUBAGENTS (trigger "on delegation") —
  // those are operator-instruction overrides / delegation targets, not runnable
  // workflow scripts. They must not appear in the Workflows list.
  const all = (items ?? []).filter((w) => w.trigger !== "on delegation");
  const q = search.trim().toLowerCase();
  const filtered = all.filter(
    (w) => !q || matches(q, w.name, w.description, w.trigger, w.customerId, w.steps?.join(" ")),
  );
  const pager = usePager(filtered);
  const { setPage } = pager;

  // Deep-link (`/?ops=workflows&id=<id>`): once the list loads, jump the pager
  // to the row's page, select it, and open its detail panel. Applied once.
  const initialApplied = useRef(false);
  useEffect(() => {
    if (initialApplied.current || !initialSelectedId || items === null) return;
    initialApplied.current = true;
    onInitialConsumed?.();
    const idx = items.findIndex((w) => w.id === initialSelectedId);
    if (idx === -1) return;
    setPage(Math.floor(idx / pager.pageSize) + 1);
    setSelectedId(initialSelectedId);
    setPanel({ mode: "view", id: initialSelectedId });
  }, [items, initialSelectedId, onInitialConsumed, setPage]);

  const openId = panelId(panel);
  const openItem = openId ? (all.find((w) => w.id === openId) ?? null) : null;

  const closePanel = useCallback(() => {
    setPanel({ mode: "closed" });
    setSelectedId(null);
  }, []);

  const mutate = async (id: string, fn: () => Promise<unknown>) => {
    setPendingId(id);
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setPendingId(null);
    }
  };

  // Inline-edit commit: PATCH the single changed field, then refetch. Errors
  // propagate so the InlineField keeps its editor open with the message.
  const patchField = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await opsFetch(`/api/ops/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      });
      await refetch();
    },
    [authorEmail, refetch],
  );

  const runDelete = () => {
    const item = confirmDelete;
    setConfirmDelete(null);
    if (item) {
      void mutate(item.id, async () => {
        await opsFetch(`/api/ops/workflows/${item.id}`, {
          method: "DELETE",
          body: JSON.stringify({ actor: authorEmail }),
        });
        setPanel((p) => (panelId(p) === item.id ? { mode: "closed" } : p));
        setSelectedId((s) => (s === item.id ? null : s));
      });
    }
  };

  let panelBody: React.ReactNode = null;
  let panelActions: React.ReactNode = null;
  if (panel.mode === "wizard") {
    panelBody = (
      <WorkflowWizard
        authorEmail={authorEmail}
        onCancel={closePanel}
        onDone={async (id) => {
          await refetch();
          setSelectedId(id);
          setPanel({ mode: "view", id });
        }}
      />
    );
  } else if (panel.mode === "view" && openItem) {
    // The pane has exactly ONE "...", and it owns both the open file and the
    // workflow. It renders into this slot — the header strip that also holds the
    // × — so the two controls sit on the same line whatever the editor is doing
    // below them. The editor still OWNS the menu (it holds the run/edit/version
    // state); it just portals it up here.
    panelActions = <span ref={setActionsHost} className="flex items-center gap-0.5" />;
    panelBody = (
      <WorkflowPane
        key={openItem.id}
        workflow={openItem}
        authorEmail={authorEmail}
        onSaved={refetch}
        actionsHost={actionsHost}
        menuItems={
          <WorkflowMenuItems
            workflow={openItem}
            onToggleEnabled={() =>
              void mutate(openItem.id, () =>
                patchField(openItem.id, { enabled: !openItem.enabled }),
              )
            }
            onDelete={() => setConfirmDelete(openItem)}
          />
        }
      />
    );
  }

  // See the note in ConnectorsPanel: at 30% the table only fits Name + Actions.
  const compact = panelBody !== null;
  const cols = compact ? 2 : 6;

  return (
    <>
      <ConfirmDeleteDialog
        name={confirmDelete?.name ?? null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={runDelete}
      />
      <PanelLayout
        panel={
          panelBody ? (
            <SidePanel onClose={closePanel} actions={panelActions}>
              {panelBody}
            </SidePanel>
          ) : null
        }
        header={
          <>
            <SectionHeaderCard
              section="workflows"
              noun="Workflow"
              onAdd={() => {
                setSelectedId(null);
                setPanel({ mode: "wizard" });
              }}
            />
            <SearchBox
              noun="workflow"
              value={search}
              onChange={(v) => {
                setSearch(v);
                pager.setPage(1);
              }}
            />
            <Banners loadError={error} actionError={actionError} noun="workflow" />
            {LIBRARY_NOTE ? (
              <p className={cn("rounded-md border border-border/60 px-3 py-2 text-muted-foreground", TYPE.meta)} role="note">
                {LIBRARY_NOTE}
              </p>
            ) : null}
          </>
        }
        table={
            <TableCard
              footer={
                <ListFooter
                  noun="workflow"
                  total={pager.total}
                  page={pager.page}
                  pages={pager.pages}
                  onPage={pager.setPage}
                  pageSize={pager.pageSize}
                  onPageSize={pager.setPageSize}
                />
              }
            >
              <thead>
                <tr>
                  <Th icon={TagIcon} label="Name" />
                  {compact ? null : (
                    <>
                      <Th icon={ZapIcon} label="Trigger" />
                      <Th icon={TextIcon} label="Description" />
                      <Th icon={ListOrderedIcon} label="Steps" />
                      <Th icon={Building2Icon} label={W.Account} />
                    </>
                  )}
                  <Th label="Actions" align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {loading ? (
                  <StateRow span={cols}>Loading…</StateRow>
                ) : pager.total === 0 ? (
                  <StateRow span={cols} italic>
                    {all.length === 0
                      ? "No workflows yet — add one."
                      : `No workflows match "${search.trim()}".`}
                  </StateRow>
                ) : (
                  pager.rows.map((w) => {
                    const isSel = selectedId === w.id;
                    return (
                      <ListRow
                        key={w.id}
                        selected={isSel}
                        dimmed={!w.enabled || w.availability?.available === false}
                        onSelect={() => setSelectedId(w.id)}
                      >
                        <NameCell selected={isSel}>
                          <span className="flex items-center gap-1.5">
                            <DeepLink
                              section="workflows"
                              id={w.id}
                              className={cn(
                                "max-w-48 truncate font-medium font-mono hover:underline",
                                isSel && "text-primary",
                              )}
                            >
                              {w.name}
                            </DeepLink>
                            <StatusDot status={w.enabled && w.availability?.available !== false ? "active" : "paused"} />
                            {w.availability?.available === false ? (
                              <span title={w.availability.reason}>
                                <Chip>not in this workspace</Chip>
                              </span>
                            ) : w.availability?.needsExcluded?.length ? (
                              // A count, never the directory names: an excluded specialist is not shown to a person, and
                              // its name is the base product's word (`customer-context`, `deployment`).
                              <span title={`Edited or written here, and delegates to ${missingSpecialists(w.availability.needsExcluded.length)} this workspace does not use: that step will fail.`}>
                                <Chip>needs {missingSpecialists(w.availability.needsExcluded.length)}</Chip>
                              </span>
                            ) : null}
                          </span>
                        </NameCell>
                        {compact ? null : (
                          <>
                            <Td>
                              <Chip>{triggerLabel(w)}</Chip>
                            </Td>
                            <Td>
                              <span
                                title={w.description}
                                className={cn(
                                  "block max-w-72 truncate text-muted-foreground",
                                  TYPE.meta,
                                )}
                              >
                                {w.description}
                              </span>
                            </Td>
                            <Td>
                              {w.steps?.length ? (
                                <span
                                  title={w.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
                                  className={cn(
                                    "cursor-default whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-2",
                                    TYPE.meta,
                                  )}
                                >
                                  {w.steps.length} step{w.steps.length === 1 ? "" : "s"}
                                </span>
                              ) : (
                                <EmptyCell />
                              )}
                            </Td>
                            <Td>
                              {w.customerId ? (
                                <span className={cn("font-mono text-muted-foreground", TYPE.meta)}>
                                  {w.customerId}
                                </span>
                              ) : (
                                <EmptyCell />
                              )}
                            </Td>
                          </>
                        )}
                        <MenuCell>
                          <RowMenu
                            enabled={w.enabled}
                            pending={pendingId === w.id}
                            onReview={() => {
                              setSelectedId(w.id);
                              setPanel({ mode: "view", id: w.id });
                            }}
                            onToggleEnabled={() =>
                              void mutate(w.id, () =>
                                opsFetch(`/api/ops/workflows/${w.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    enabled: !w.enabled,
                                    actor: authorEmail,
                                  }),
                                }),
                              )
                            }
                            onDelete={() => setConfirmDelete(w)}
                          />
                        </MenuCell>
                      </ListRow>
                    );
                  })
                )}
              </tbody>
            </TableCard>
        }
      />
    </>
  );
}
