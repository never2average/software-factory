"use client";

/**
 * Ops Center detail-panel primitives: the DetailPanel (whose editable fields
 * edit INLINE via InlineField/InlineEnabled — there is no separate edit mode),
 * its icon-labelled sections, the wizard review SummaryList, and the shared
 * run-history feed (GET /api/ops/runs).
 */

import { useRef, useState } from "react";
import {
  BellIcon,
  HistoryIcon,
  PencilIcon,
  UserIcon,
  type PlugIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  errMessage,
  fmtTime,
  useOpsList,
  type ApiRun,
  type AutomationType,
} from "./lib";
import {
  EnabledToggle,
  OpsButton,
  OpsInput,
  OpsSelect,
  OpsTextarea,
  RecipientsPicker,
} from "./primitives";
import { INLINE, RUN_DOT, SPACE, SURFACE, TYPE, statusDot } from "./tokens";
import { RunHistoryColumn, type RunCardModel } from "./run-timeline";

/* --------------------------- Review / detail bits -------------------------- */

export interface ReviewField {
  label: string;
  value: React.ReactNode;
}

export const EMPTY_VALUE = <span className="text-muted-foreground/50">—</span>;

export function reviewText(value: string | null | undefined): React.ReactNode {
  return value ? value : EMPTY_VALUE;
}

export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** Key/value review table used by the wizards' final step. */
export function SummaryList({ fields }: { readonly fields: ReviewField[] }) {
  return (
    <dl className={cn("divide-y divide-border/60 overflow-hidden", SURFACE.inset)}>
      {fields.map((f) => (
        <div key={f.label} className={cn("grid grid-cols-[6.5rem_1fr] gap-3", SPACE.headerCell)}>
          <dt className={cn(TYPE.label, "pt-px font-normal text-muted-foreground")}>{f.label}</dt>
          <dd className={cn("min-w-0 whitespace-pre-wrap break-words", TYPE.body)}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Icon-labelled section heading, ported from the CronDetail reference. */
export function DetailLabel({
  icon: Icon,
  children,
}: {
  readonly icon: typeof PlugIcon;
  readonly children: React.ReactNode;
}) {
  return (
    <p className={cn("flex items-center gap-1.5 text-muted-foreground/70", TYPE.sectionLabel)}>
      <Icon className="size-3" />
      {children}
    </p>
  );
}

/** Small status dot for a run-history entry. */
export function RunStatusDot({ status }: { readonly status: string }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        RUN_DOT[status] ?? "bg-muted-foreground/40",
      )}
    />
  );
}

/** One stacked, icon-labelled block of the detail panel. */
export interface DetailSection {
  icon: typeof PlugIcon;
  label: string;
  value: React.ReactNode;
}

export function DetailStack({ sections }: { readonly sections: DetailSection[] }) {
  return (
    <div className={cn("flex flex-col", SPACE.sectionGap)}>
      {sections.map((s) => (
        // Each section is a bordered card (matching the Apps detail design).
        <div key={s.label} className={cn("flex min-w-0 flex-col gap-1.5 px-3.5 py-3", SURFACE.card)}>
          <DetailLabel icon={s.icon}>{s.label}</DetailLabel>
          <div className={cn("min-w-0 whitespace-pre-wrap break-words", TYPE.body)}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Inline editing ----------------------------- */

export interface InlineOption {
  value: string;
  label: string;
}

/**
 * The detail panel's inline editor. Renders the value as (quiet) text with a
 * hover/focus pencil cue; clicking it — or focusing it and pressing
 * Enter/Space — swaps in the matching design-system control in place.
 *
 * Commit semantics:
 * - text/number: Enter or blur commits; Escape cancels (draft discarded).
 * - multiline:   Enter inserts a newline; ⌘/Ctrl+Enter or blur commits.
 * - select:      choosing an option commits; blur closes; Escape cancels.
 * - A commit with an unchanged value just closes the editor (no PATCH).
 * - While the PATCH is in flight the control is disabled with a subtle
 *   "Saving…" line; on failure the error renders inline UNDER the control and
 *   the editor stays open with the user's text intact.
 *
 * Escape is trapped via `data-escape-trap` so the SidePanel/modal never close
 * while an inline editor is open (inline editor → panel → modal order).
 */
export function InlineField({
  label,
  value,
  display,
  variant = "text",
  options,
  placeholder,
  mono,
  hint,
  preview,
  onCommit,
}: {
  /** Accessible name for the affordance ("Edit prompt"). */
  readonly label: string;
  /** Current server value — the editor's initial text. */
  readonly value: string;
  /** Resting representation; defaults to the raw value (or the — placeholder). */
  readonly display?: React.ReactNode;
  readonly variant?: "text" | "multiline" | "number" | "select";
  /** Required for the select variant. */
  readonly options?: InlineOption[];
  readonly placeholder?: string;
  readonly mono?: boolean;
  /** Short hint shown under the control while editing (a few words, not a note). */
  readonly hint?: string;
  /** Live preview of the draft while editing (e.g. describeCron). */
  readonly preview?: (draft: string) => string | null;
  /** PATCH the single changed field; THROW to keep the editor open + show the error. */
  readonly onCommit: (raw: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape unmounts the control; this stops the trailing blur from committing.
  const cancelledRef = useRef(false);

  const open = () => {
    setDraft(value);
    setError(null);
    cancelledRef.current = false;
    setEditing(true);
  };

  const cancel = () => {
    cancelledRef.current = true;
    setEditing(false);
    setError(null);
  };

  const commit = async (raw: string) => {
    if (saving || cancelledRef.current) return;
    if (raw === value) {
      // No-op edit: close quietly, never PATCH (the API 400s on empty patches).
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCommit(raw);
      setEditing(false);
    } catch (e) {
      // Keep the editor open with the user's text intact — never discard input.
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" aria-label={`Edit ${label}`} onClick={open} className={INLINE.editable}>
        <span
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words",
            mono && cn("font-mono", TYPE.meta),
          )}
        >
          {display ?? (value ? value : EMPTY_VALUE)}
        </span>
        <PencilIcon aria-hidden className={INLINE.pencil} />
      </button>
    );
  }

  const previewText = preview && draft.trim() ? preview(draft) : null;

  return (
    <div
      data-escape-trap
      className={cn("flex min-w-0 flex-col", SPACE.fieldGap)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
    >
      {variant === "multiline" ? (
        <OpsTextarea
          autoFocus
          aria-label={label}
          value={draft}
          disabled={saving}
          placeholder={placeholder}
          className={cn(mono && "font-mono")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit(draft);
            }
          }}
        />
      ) : variant === "select" ? (
        <OpsSelect
          autoFocus
          aria-label={label}
          value={draft}
          disabled={saving}
          onChange={(e) => {
            setDraft(e.target.value);
            void commit(e.target.value);
          }}
          onBlur={() => void commit(draft)}
        >
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </OpsSelect>
      ) : (
        <OpsInput
          autoFocus
          aria-label={label}
          type={variant === "number" ? "number" : "text"}
          min={variant === "number" ? 1 : undefined}
          step={variant === "number" ? 1 : undefined}
          value={draft}
          disabled={saving}
          placeholder={placeholder}
          className={cn(mono && "font-mono")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(draft);
            }
          }}
        />
      )}
      {previewText ? (
        <span className={cn("text-muted-foreground", TYPE.meta)}>= {previewText}</span>
      ) : null}
      {saving ? (
        <span className={cn("flex items-center gap-1.5 text-muted-foreground", TYPE.micro)}>
          <Spinner className="size-3" />
          Saving…
        </span>
      ) : error ? (
        <span className={cn("break-words text-red-400", TYPE.meta)}>{error}</span>
      ) : (
        <span className={cn("text-muted-foreground/50", TYPE.micro)}>
          {hint ??
            (variant === "multiline"
              ? "⌘⏎ or click away to save · esc to cancel"
              : variant === "select"
                ? "Pick to save · esc to cancel"
                : "⏎ to save · esc to cancel")}
        </span>
      )}
    </div>
  );
}

/**
 * Inline boolean editor: the design-system EnabledToggle wired straight to a
 * PATCH, with a subtle pending state and an inline error on failure.
 */
/**
 * The status row: JUST the toggle. The traffic-light dot and the
 * "Enabled/Disabled — will not run" caption were both redundant — the toggle's
 * own position already says the same thing three times over.
 */
export function InlineEnabled({
  enabled,
  onCommit,
}: {
  readonly enabled: boolean;
  readonly onCommit: (next: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCommit(!enabled);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <EnabledToggle checked={enabled} disabled={saving} onToggle={() => void toggle()} />
        {saving ? <Spinner className="size-3" /> : null}
      </span>
      {error ? <span className={cn("break-words text-red-400", TYPE.meta)}>{error}</span> : null}
    </div>
  );
}

/**
 * Notify-email section, shared by every record type. (There is no separate
 * "notify when" — the record's own prompt/description IS the notify rule.)
 */
export function notifyEmailSection(notifyEmail: string | null): DetailSection {
  return {
    icon: BellIcon,
    label: "Notify email",
    value: notifyEmail ? (
      <span className={cn("font-mono", TYPE.meta)}>{notifyEmail}</span>
    ) : (
      EMPTY_VALUE
    ),
  };
}

/** Editable notify-email section — same shape, inline editor for the value. */
export function editableNotifyEmailSection(
  recipients: string[] | null,
  patch: (body: Record<string, unknown>) => Promise<void>,
): DetailSection {
  return {
    icon: BellIcon,
    label: "Notify",
    value: <InlineRecipients recipients={recipients ?? []} patch={patch} />,
  };
}


/**
 * Notify recipients: a LIST, picked from the people we actually have in
 * Postgres (internal staff + customer stakeholders, deduped by email) with a
 * live search, plus free-typed addresses for anyone not in those tables.
 *
 * Resting state shows the chosen addresses as chips. Opening it loads the
 * people list; the draft is local, so nothing is written until Save — Escape
 * cancels, and a failed PATCH keeps the editor open with the draft intact.
 */
export function InlineRecipients({
  recipients,
  patch,
}: {
  readonly recipients: string[];
  readonly patch: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(recipients);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setDraft(recipients);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await patch({ notifyEmails: draft.length ? draft : null });
      setEditing(false);
    } catch (e) {
      setError(errMessage(e)); // keep the editor open — never discard the draft
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label="Edit notify recipients"
        onClick={open}
        className={INLINE.editable}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {recipients.length === 0
            ? EMPTY_VALUE
            : recipients.map((e) => (
                <span key={e} className={cn(SURFACE.chip, "font-mono", TYPE.micro)}>
                  {e}
                </span>
              ))}
        </span>
        <PencilIcon aria-hidden className={INLINE.pencil} />
      </button>
    );
  }

  return (
    <div
      data-escape-trap
      className={cn("flex min-w-0 flex-col", SPACE.fieldGap)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setEditing(false);
        setError(null);
      }}
    >
      <RecipientsPicker value={draft} onChange={setDraft} disabled={saving} />
      <span className="flex items-center gap-2">
        <OpsButton size="xs" intent="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </OpsButton>
        <OpsButton size="xs" intent="ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </OpsButton>
        {error ? (
          <span className={cn("break-words text-red-400", TYPE.micro)}>{error}</span>
        ) : (
          <span className={cn("text-muted-foreground/50", TYPE.micro)}>
            esc to cancel · ⏎ adds a typed address
          </span>
        )}
      </span>
    </div>
  );
}

/** Traffic-light status line (dot + label) for a detail section. */
export function StatusLine({ status, label }: { readonly status: string; readonly label?: string }) {
  const text = label ?? status;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", statusDot(status))} />
      {text}
    </span>
  );
}

/** Cron expression as a code chip beside its human cadence. */
export function CronChip({
  cron,
  cadence,
}: {
  readonly cron: string | null;
  readonly cadence: string | null;
}) {
  if (!cron && !cadence) return EMPTY_VALUE;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {cron ? <code className={cn(SURFACE.codeChip, TYPE.body)}>{cron}</code> : null}
      {cadence ? <span className={cn("text-muted-foreground", TYPE.body)}>{cadence}</span> : null}
    </span>
  );
}

/** Created-by / created / updated provenance, condensed into one section. */
export function recordSection(r: {
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}): DetailSection {
  return {
    icon: UserIcon,
    label: "Record",
    value: (
      <span className={cn("flex flex-col gap-0.5 text-muted-foreground", TYPE.meta)}>
        <span>
          Created by {r.createdBy} · {fmtTime(r.createdAt) ?? "—"}
        </span>
        <span>Updated {fmtTime(r.updatedAt) ?? "—"}</span>
      </span>
    ),
  };
}

/* --------------------------- Runtime requirements -------------------------- */


/* ----------------------------- Run history feed ---------------------------- */

/**
 * Fetched from GET /api/ops/runs when the detail panel opens. Rendered like
 * the reference: status dot, timestamp, duration on the right, summary line.
 */
const AUTOMATION_LABEL: Record<AutomationType, string> = {
  system_cron: "cron",
  schedule: "schedule",
  connector: "connector",
  workflow: "workflow",
};

/** Map an automation invocation (ApiRun) into the shared run-card model. */
function automationRunCard(run: ApiRun, type: AutomationType, id: string): RunCardModel {
  const routed = Boolean(run.workflowRunId);
  const openable = routed && run.hasSession !== false;
  const noun = AUTOMATION_LABEL[type];
  // Three visibly-distinct states:
  //  • routed + session  → clickable (opens the run as a chat)
  //  • routed, no session → dimmed "no session" (a run that lost its stream)
  //  • never routed       → "Slack only" (a dispatcher fire that ran no workflow)
  const note = openable ? null : routed ? "no session" : type === "system_cron" ? "Slack only" : null;
  return {
    key: run.id,
    // Cron cards carry the cron's own name; the rest a stable per-kind mark.
    markName: type === "system_cron" ? id : noun,
    runByLabel: type === "system_cron" ? `Run by cron · ${id}` : `Run by ${noun}`,
    status: run.status,
    whenIso: run.startedAt,
    href: openable
      ? `/?chatWorkflowRun=${encodeURIComponent(run.workflowRunId!)}&auto=${encodeURIComponent(run.startedAt)}`
      : null,
    note,
    dimmed: routed && !openable,
    error: run.status === "failed" ? run.error : null,
    search: [id, run.summary ?? "", fmtTime(run.startedAt) ?? "", run.status].join(" "),
  };
}

/**
 * The invocation-history SIDE COLUMN for an automation's detail — the exact same
 * searchable run-card column the workflow editor uses, fed with this
 * automation's runs. Owns its own fetch (the detail panel just says which one).
 */
export function AutomationRunHistoryColumn({
  type,
  id,
  limit = 25,
  inline = false,
}: {
  readonly type: AutomationType;
  readonly id: string;
  readonly limit?: number;
  readonly inline?: boolean;
}) {
  const { items, error, loading } = useOpsList<ApiRun>(
    `/api/ops/runs?type=${type}&id=${encodeURIComponent(id)}&limit=${limit}`,
  );
  const cards = (items ?? []).map((run) => automationRunCard(run, type, id));
  const emptyLabel = loading
    ? "Loading runs…"
    : error
      ? `Failed to load runs: ${error}`
      : "No invocations recorded yet.";
  return <RunHistoryColumn cards={cards} emptyLabel={emptyLabel} inline={inline} />;
}

/**
 * The detail view rendered inside the sidebar — and the record's EDITOR:
 * editable sections carry InlineField/InlineEnabled values that PATCH the
 * single changed field in place; read-only/derived sections stay plain text.
 * Ends with the live run-history feed for the record.
 */
export function DetailPanel({
  title,
  sections,
  log,
  children,
}: {
  readonly title: string;
  readonly sections: DetailSection[];
  // Which automation the run-history feed belongs to.
  readonly log?: { type: AutomationType; id: string };
  // Extra content between the sections and the feed.
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className={cn("min-h-0 flex-1 overflow-y-auto", SPACE.panelBody)}>
        <div className={cn("flex flex-col", SPACE.sectionGap)}>
          <h3 className={cn("truncate pr-8", TYPE.title)}>{title}</h3>
          <DetailStack sections={sections} />
          {children}
          {/* Run history is now a card section at the bottom of the single detail
              panel (matching the Apps design) — not a separate right-hand column. */}
          {log ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <DetailLabel icon={HistoryIcon}>Run history</DetailLabel>
              <AutomationRunHistoryColumn key={`runs:${log.type}:${log.id}`} type={log.type} id={log.id} inline />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
