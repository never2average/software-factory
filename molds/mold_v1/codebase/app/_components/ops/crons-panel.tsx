"use client";

/**
 * Crons section: pinned system crons (code-authored Vercel Cron jobs whose
 * detail panel inline-edits the override columns — cadence, prompt, notify
 * email, pause/resume — while Source / Last run / Last error stay read-only)
 * + CRUD dynamic schedule rules with inline-editable detail panels, and the
 * stepped Add wizard.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClockIcon,
  Building2Icon,
  ClockIcon,
  FolderTreeIcon,
  HashIcon,
  PlayIcon,
  RepeatIcon,
  TagIcon,
  TextIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react";
import { cronMatches, describeCron } from "@/agent/lib/cron-match";
import { AUTHORED_SYSTEM_CRON_PROMPTS } from "@/agent/lib/system-cron-defs";
import { cn } from "@/lib/utils";
import {
  CronChip,
  DetailPanel,
  EMPTY_VALUE,
  InlineEnabled,
  InlineField,
  StatusLine,
  SummaryList,
  editableNotifyEmailSection,
  notifyEmailSection,
  recordSection,
  reviewText,
  yesNo,
  type DetailSection,
} from "./detail";
import {
  errMessage,
  fmtTime,
  matches,
  opsFetch,
  panelId,
  useOpsList,
  usePager,
  type ApiSchedule,
  type ApiSystemCronOverride,
  type PanelState,
} from "./lib";
import {
  Banners,
  Chip,
  CodeChip,
  ConfirmDeleteDialog,
  DeepLink,
  EmptyCell,
  EnabledToggle,
  Field,
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
  CustomerSelect,
  WorkflowSelect,
  type RadioOption,
} from "./primitives";
import { SURFACE, TYPE } from "./tokens";
import { W } from "@/lib/ui-words";

/**
 * The Prompt cell — a cron's context column, and the whole reason to look at
 * the row. It is a sentence, so it is set as one: it wraps to two lines at the
 * row's own leading rather than being sliced at a fixed width, and only a truly
 * long prompt falls back to the hover.
 */
function PromptCell({ text }: { readonly text: string | null | undefined }) {
  if (!text?.trim()) return <EmptyCell />;
  return (
    <span
      title={text}
      className={cn(
        "line-clamp-2 max-w-[26rem] text-pretty text-muted-foreground leading-snug",
        TYPE.meta,
      )}
    >
      {text}
    </span>
  );
}

// The only code-authored schedule left. Every operational cron (standup, sweeps,
// member performance, manager brief, all-hands, …) is now a DB schedule_rules row,
// shown + edited in the dynamic rules section below.
const SYSTEM_CRONS: { name: string; cron: string; cadence: string; description: string }[] = [
  {
    name: "dynamic",
    cron: "* * * * *",
    cadence: "Every minute",
    description:
      "Dispatcher for the durable schedule_rules engine — claims due rules with an atomic lease and fires them on their cron/interval. Every operational cron is a rule below.",
  },
];

/**
 * The schedule detail panel's sections — every column the PATCH endpoint
 * honours edits inline; the dispatcher-owned run bookkeeping (next/last run,
 * last error) and Record provenance stay plain text.
 */
function scheduleDetailSections(
  s: ApiSchedule,
  patch: (body: Record<string, unknown>) => Promise<void>,
): DetailSection[] {
  return [
    {
      icon: RepeatIcon,
      label: "Every N minutes",
      value: (
        <InlineField
          label="every N minutes"
          variant="number"
          value={s.everyMinutes != null ? String(s.everyMinutes) : ""}
          placeholder="60"
          hint="Drives the recurrence. ⏎ to save · esc to cancel"
          display={s.everyMinutes ? `every ${s.everyMinutes} min` : EMPTY_VALUE}
          onCommit={async (v) => {
            const t = v.trim();
            const minutes = t ? Number(t) : null;
            if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0)) {
              throw new Error("Every N minutes must be a positive whole number.");
            }
            await patch({ everyMinutes: minutes });
          }}
        />
      ),
    },
    {
      icon: AlarmClockIcon,
      label: "Cron (descriptive)",
      value: (
        <InlineField
          label="cron expression"
          value={s.cron ?? ""}
          mono
          placeholder="0 * * * *"
          hint="Display only — recurrence is driven by every-N-minutes."
          display={s.cron ? <CronChip cron={s.cron} cadence={null} /> : EMPTY_VALUE}
          onCommit={(v) => patch({ cron: v.trim() || null })}
        />
      ),
    },
    {
      icon: WorkflowIcon,
      label: "Workflow",
      // WHICH workflow a fire of this rule runs. When set, the fire becomes an
      // openable chat (run-cron-workflows executes it); null = the orchestrator
      // handles the prompt itself.
      value: (
        <WorkflowSelect
          value={s.workflow ?? null}
          onChange={(next) => void patch({ workflow: next })}
        />
      ),
    },
    {
      icon: PlayIcon,
      label: "Status",
      value: (
        <InlineEnabled
          enabled={s.enabled}
          onCommit={(next) => patch({ enabled: next })}
        />
      ),
    },
    {
      icon: TextIcon,
      label: "Prompt",
      value: (
        <InlineField
          label="prompt"
          variant="multiline"
          value={s.prompt}
          placeholder={`Summarize open tickets for each active ${W.account} and flag anything at SLA risk.`}
          hint="What the agent runs each time the rule fires. ⌘⏎ or click away to save"
          onCommit={async (v) => {
            const t = v.trim();
            if (!t) throw new Error("Prompt is required.");
            await patch({ prompt: t });
          }}
        />
      ),
    },
    {
      icon: HashIcon,
      label: "Channel",
      value: (
        <InlineField
          label="channel id"
          value={s.channelId ?? ""}
          mono
          placeholder="C0123456789"
          hint="Optional Slack channel to post into. ⏎ to save · esc to cancel"
          onCommit={(v) => patch({ channelId: v.trim() || null })}
        />
      ),
    },
    {
      icon: Building2Icon,
      label: W.Account,
      value: (
        <CustomerSelect
          value={s.customerId ?? null}
          onChange={(next) => void patch({ customerId: next })}
        />
      ),
    },
    {
      icon: ClockIcon,
      label: "Runs",
      value: (
        <span className={cn("flex flex-col gap-0.5 text-muted-foreground", TYPE.meta)}>
          <span>Next run · {fmtTime(s.nextRunAt) ?? "—"}</span>
          <span>Last run · {fmtTime(s.lastRunAt) ?? "—"}</span>
          {s.lastError ? <span className="text-red-400">Last error: {s.lastError}</span> : null}
        </span>
      ),
    },
    editableNotifyEmailSection(s.notifyEmails, patch),
    recordSection(s),
  ];
}

/* ------------------------------ Schedule wizard -------------------------- */

type Cadence = "hourly" | "daily" | "weekly" | "custom";

const CADENCE_OPTIONS: RadioOption<Cadence>[] = [
  { value: "hourly", title: "Hourly", description: "Runs every 60 minutes (cron 0 * * * *)." },
  { value: "daily", title: "Daily", description: "Runs once a day at 00:00 UTC (cron 0 0 * * *)." },
  {
    value: "weekly",
    title: "Weekly",
    description: "Runs once a week, Monday 00:00 UTC (cron 0 0 * * 1).",
  },
  {
    value: "custom",
    title: "Custom cron",
    description: "Set your own minutes interval and descriptive cron expression.",
  },
];

const CADENCE_PRESETS: Record<Exclude<Cadence, "custom">, { minutes: number; cron: string }> = {
  hourly: { minutes: 60, cron: "0 * * * *" },
  daily: { minutes: 1440, cron: "0 0 * * *" },
  weekly: { minutes: 10080, cron: "0 0 * * 1" },
};

const SCHEDULE_WIZARD_STEPS = [
  {
    heading: "How often should it run?",
    subtitle: "Pick a cadence — recurrence is driven by the minutes interval.",
  },
  {
    heading: "Schedule details",
    subtitle: "Name it and tell the agent what to run each time it fires.",
  },
  {
    heading: "Review & create",
    subtitle: "Double-check the schedule before creating it. The first run fires immediately.",
  },
];

function ScheduleWizard({
  authorEmail,
  onDone,
  onCancel,
}: {
  readonly authorEmail?: string;
  readonly onDone: (id: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [cadence, setCadence] = useState<Cadence | "">("");
  const [customMinutes, setCustomMinutes] = useState("");
  const [customCron, setCustomCron] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [channelId, setChannelId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [notifyEmails, setNotifyEmails] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedMinutes = customMinutes.trim() ? Number(customMinutes) : null;
  const customMinutesValid =
    parsedMinutes !== null && Number.isInteger(parsedMinutes) && parsedMinutes > 0;

  const minutes =
    cadence === "custom"
      ? customMinutesValid
        ? parsedMinutes
        : null
      : cadence
        ? CADENCE_PRESETS[cadence].minutes
        : null;
  const cron =
    cadence === "custom" ? customCron.trim() : cadence ? CADENCE_PRESETS[cadence].cron : "";

  const valid =
    step === 0
      ? cadence !== "" && (cadence !== "custom" || customMinutesValid)
      : step === 1
        ? name.trim().length > 0 && prompt.trim().length > 0
        : true;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await opsFetch<{ item: ApiSchedule }>("/api/ops/schedules", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          prompt: prompt.trim(),
          everyMinutes: minutes ?? undefined,
          cron: cron || undefined,
          kind: "prompt",
          workflow: workflow ?? undefined,
          channelId: channelId.trim() || undefined,
          customerId: customerId.trim() || undefined,
          notifyEmails: notifyEmails.length ? notifyEmails : undefined,
          enabled,
          createdBy: authorEmail,
        }),
      });
      await onDone(created.item.id);
    } catch (e) {
      setError(errMessage(e));
      setCreating(false);
    }
  };

  const meta = SCHEDULE_WIZARD_STEPS[step];
  return (
    <WizardFrame
      heading={meta.heading}
      subtitle={meta.subtitle}
      step={step}
      stepCount={SCHEDULE_WIZARD_STEPS.length}
      valid={valid}
      creating={creating}
      error={error}
      onBack={() => (step === 0 ? onCancel() : setStep(step - 1))}
      onNext={() => (step === SCHEDULE_WIZARD_STEPS.length - 1 ? void create() : setStep(step + 1))}
    >
      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <RadioCards
            label="Cadence"
            value={cadence}
            onChange={setCadence}
            options={CADENCE_OPTIONS}
          />
          {cadence === "custom" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Every N minutes" hint="Drives the recurrence.">
                <OpsInput
                  type="number"
                  min={1}
                  step={1}
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  placeholder="60"
                />
              </Field>
              <Field
                label="Cron (descriptive)"
                hint="Display only — recurrence is driven by everyMinutes."
              >
                <OpsInput
                  className="font-mono"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 * * * *"
                />
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}
      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <OpsInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly-digest"
            />
          </Field>
          <Field label="Prompt" hint="What the agent runs each time the rule fires.">
            <OpsTextarea
              className="min-h-20"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Summarize open tickets for each active ${W.account} and flag anything at SLA risk.`}
            />
          </Field>
          <Field
            label="Workflow"
            hint="Optional — route each fire to a workflow (makes the run an openable chat)."
          >
            <WorkflowSelect value={workflow} onChange={setWorkflow} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel ID" hint="Optional Slack channel to post into.">
              <OpsInput
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="C0123456789"
              />
            </Field>
            <Field label={W.Account} hint="Optional — scope to one account.">
              <CustomerSelect
                value={customerId || null}
                onChange={(next) => setCustomerId(next ?? "")}
              />
            </Field>
          </div>
          <NotifyEmailField recipients={notifyEmails} onRecipients={setNotifyEmails} />
          <div className="flex items-center gap-2">
            <EnabledToggle checked={enabled} onToggle={() => setEnabled((v) => !v)} />
            <span className={cn("text-muted-foreground", TYPE.meta)}>
              {enabled ? "Enabled — eligible to run" : "Disabled — will not run"}
            </span>
          </div>
        </div>
      ) : null}
      {step === 2 ? (
        <SummaryList
          fields={[
            { label: "Name", value: reviewText(name.trim()) },
            { label: "Cadence", value: minutes ? `every ${minutes} min` : EMPTY_VALUE },
            {
              label: "Cron",
              value: cron ? <code className="font-mono">{cron}</code> : EMPTY_VALUE,
            },
            { label: "Workflow", value: reviewText(workflow) },
            { label: "Prompt", value: reviewText(prompt.trim()) },
            { label: "Channel", value: reviewText(channelId.trim() || null) },
            { label: W.Account, value: reviewText(customerId.trim() || null) },
            { label: "Notify", value: reviewText(notifyEmails.join(", ") || null) },
            { label: "Enabled", value: yesNo(enabled) },
          ]}
        />
      ) : null}
    </WizardFrame>
  );
}

/** Traffic-light state for a code-authored cron, from its override row. */
function systemCronStatus(j: { enabled: boolean; lastError: string | null }): string {
  if (!j.enabled) return "paused";
  return j.lastError ? "error" : "live";
}

/** Cron-expression preview for the inline cadence editor. */
function cronPreview(draft: string): string | null {
  try {
    return describeCron(draft.trim());
  } catch {
    return null;
  }
}

/* ------------------------------ Crons panel ------------------------------ */

export function CronsPanel({
  authorEmail,
  initialSelectedId,
  onInitialConsumed,
}: {
  readonly authorEmail?: string;
  // A schedule-rule uuid OR a system cron NAME (deep-link `/?ops=crons&id=…`).
  readonly initialSelectedId?: string;
  readonly onInitialConsumed?: () => void;
}) {
  const { items, error, refetch, loading } = useOpsList<ApiSchedule>("/api/ops/schedules");
  // Pause / soft-delete state for the three code-authored crons. A cron with no
  // row here is live — the table only ever holds overrides.
  const {
    items: overrideItems,
    refetch: refetchOverrides,
  } = useOpsList<ApiSystemCronOverride>("/api/ops/system-crons");
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiSchedule | null>(null);
  const [confirmDeleteSystem, setConfirmDeleteSystem] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const overrides = useMemo(() => {
    const byName = new Map<string, ApiSystemCronOverride>();
    for (const o of overrideItems ?? []) byName.set(o.name, o);
    return byName;
  }, [overrideItems]);

  const systemRows = SYSTEM_CRONS.map((j) => {
    const o = overrides.get(j.name);
    // Cadence override: when the row carries a cron, IT is the effective
    // cadence (enforced by the every-minute dispatcher) and the authored one
    // becomes a footnote.
    const cronOverride = o?.cron ?? null;
    let overrideCadence: string | null = null;
    if (cronOverride) {
      try {
        overrideCadence = describeCron(cronOverride);
      } catch {
        overrideCadence = null;
      }
    }
    return {
      ...j,
      authoredCron: j.cron,
      authoredCadence: j.cadence,
      cron: cronOverride ?? j.cron,
      cadence: cronOverride ? (overrideCadence ?? "override") : j.cadence,
      cronOverride,
      // Prompt override: when set, the run hands IT to Slack instead of the
      // authored prompt (agent/lib/system-cron-defs.ts). "dynamic" has no
      // authored prompt — it is the clock, so no override applies to it.
      promptOverride: o?.prompt ?? null,
      // Which workflow (subagent) runs this cron; null = the orchestrator does.
      workflow: o?.workflow ?? null,
      notifyEmail: o?.notifyEmail ?? null,
      notifyEmails: o?.notifyEmails ?? null,
      enabled: o ? o.enabled : true,
      deleted: Boolean(o?.deletedAt),
      lastError: o?.lastError ?? null,
      lastRunAt: o?.lastRunAt ?? null,
    };
  });
  const visibleSystemRows = systemRows.filter((j) => !j.deleted);
  const deletedSystemRows = systemRows.filter((j) => j.deleted);

  const mutateSystem = async (name: string, fn: () => Promise<unknown>) => {
    setPendingId(name);
    setActionError(null);
    try {
      await fn();
      await refetchOverrides();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setPendingId(null);
    }
  };

  const all = items ?? [];
  const q = search.trim().toLowerCase();
  const filtered = all.filter(
    (s) => !q || matches(q, s.name, s.prompt, s.cron, s.kind, s.channelId, s.customerId),
  );
  const pager = usePager(filtered);
  const { setPage } = pager;

  // Deep-link (`/?ops=crons&id=<id-or-name>`): a system cron NAME opens its
  // detail panel immediately; a schedule uuid waits for the list, jumps the
  // pager to its page, selects it, and opens its panel. Applied once.
  const initialApplied = useRef(false);
  useEffect(() => {
    if (initialApplied.current || !initialSelectedId) return;
    if (SYSTEM_CRONS.some((j) => j.name === initialSelectedId)) {
      initialApplied.current = true;
      onInitialConsumed?.();
      setPanel({ mode: "system", name: initialSelectedId });
      return;
    }
    if (items === null) return;
    initialApplied.current = true;
    onInitialConsumed?.();
    const idx = items.findIndex((s) => s.id === initialSelectedId);
    if (idx === -1) return;
    setPage(Math.floor(idx / pager.pageSize) + 1);
    setSelectedId(initialSelectedId);
    setPanel({ mode: "view", id: initialSelectedId });
  }, [items, initialSelectedId, onInitialConsumed, setPage]);

  const openId = panelId(panel);
  const openItem = openId ? (all.find((s) => s.id === openId) ?? null) : null;

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
      await opsFetch(`/api/ops/schedules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      });
      await refetch();
    },
    [authorEmail, refetch],
  );

  // Inline-edit commit for a code-authored cron's override columns (enabled /
  // prompt / notifyEmail / cron). Errors propagate so the InlineField keeps
  // its editor open with the message.
  const patchSystemField = useCallback(
    async (name: string, body: Record<string, unknown>) => {
      await opsFetch(`/api/ops/system-crons/${name}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, actor: authorEmail }),
      });
      await refetchOverrides();
    },
    [authorEmail, refetchOverrides],
  );

  // Cadence-override commit (null clears it back to the authored expression).
  // Validated client-side before the PATCH.
  const patchSystemCron = useCallback(
    async (name: string, cron: string | null) => {
      if (cron !== null) {
        // Fast local validation; the API re-validates before persisting.
        cronMatches(cron, new Date());
      }
      await patchSystemField(name, { cron });
    },
    [patchSystemField],
  );

  const runDelete = () => {
    const item = confirmDelete;
    setConfirmDelete(null);
    if (item) {
      void mutate(item.id, async () => {
        await opsFetch(`/api/ops/schedules/${item.id}`, {
          method: "DELETE",
          body: JSON.stringify({ actor: authorEmail }),
        });
        setPanel((p) => (panelId(p) === item.id ? { mode: "closed" } : p));
        setSelectedId((s) => (s === item.id ? null : s));
      });
    }
  };

  let panelBody: React.ReactNode = null;
  if (panel.mode === "wizard") {
    panelBody = (
      <ScheduleWizard
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
    panelBody = (
      <DetailPanel
        title={`Schedule — ${openItem.name}`}
        sections={scheduleDetailSections(openItem, (body) => patchField(openItem.id, body))}
        log={{ type: "schedule", id: openItem.id }}
      />
    );
  } else if (panel.mode === "system") {
    const job = systemRows.find((j) => j.name === panel.name);
    if (job) {
      // "dynamic" is the dispatcher that ENFORCES the overrides: its cadence
      // is the clock and it hands no prompt of its own to Slack, so cadence /
      // prompt / notify stay read-only on it (the API refuses them too).
      // daily-standup and sla-sweep inline-edit their override columns —
      // cadence, prompt, notify email — and all three pause/resume inline.
      const overridable = job.name !== "dynamic";
      const authoredPrompt = overridable
        ? AUTHORED_SYSTEM_CRON_PROMPTS[job.name as keyof typeof AUTHORED_SYSTEM_CRON_PROMPTS]
        : null;
      const effectivePrompt = job.promptOverride ?? authoredPrompt;
      panelBody = (
        <DetailPanel
          title={`System cron — ${job.name}`}
          sections={[
            {
              icon: AlarmClockIcon,
              label: "Cron expression",
              value: overridable ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <InlineField
                    label="cron expression override"
                    value={job.cronOverride ?? ""}
                    mono
                    placeholder={job.authoredCron}
                    hint={`UTC. Authored: ${job.authoredCron}. Blank clears the override.`}
                    preview={cronPreview}
                    display={
                      // No caption at rest — the chip says it. Only an ACTIVE
                      // override earns a second line, because then the authored
                      // cadence is no longer visible anywhere else.
                      <span className="flex flex-col gap-1">
                        <CronChip cron={job.cron} cadence={job.cadence} />
                        {job.cronOverride ? (
                          <span className={cn("text-muted-foreground/60", TYPE.meta)}>
                            {`Override — the authored cadence is ${job.authoredCron} (${job.authoredCadence})`}
                          </span>
                        ) : null}
                      </span>
                    }
                    onCommit={async (v) => {
                      const t = v.trim();
                      await patchSystemCron(job.name, t === "" ? null : t);
                    }}
                  />
                  {job.cronOverride ? (
                    <OpsButton
                      intent="secondary"
                      size="xs"
                      disabled={pendingId === job.name}
                      onClick={() =>
                        void mutateSystem(job.name, () => patchSystemCron(job.name, null))
                      }
                      className={cn("self-start rounded-md font-normal", TYPE.meta)}
                    >
                      Clear override (back to {job.authoredCron})
                    </OpsButton>
                  ) : null}
                </div>
              ) : (
                <span className="flex flex-col gap-1">
                  <CronChip cron={job.cron} cadence={job.cadence} />
                  <span className={cn("text-muted-foreground/60", TYPE.meta)}>
                    Fixed — this dispatcher enforces the other crons&apos; overrides
                  </span>
                </span>
              ),
            },
            {
              icon: TextIcon,
              label: "Prompt",
              // The EFFECTIVE prompt: override if set, else the authored one
              // (agent/lib/system-cron-defs.ts). Mirrors the cron field above:
              // inline multiline editor + a quiet clear-override affordance.
              value:
                overridable && effectivePrompt ? (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <InlineField
                      label="prompt override"
                      variant="multiline"
                      value={effectivePrompt}
                      placeholder={authoredPrompt ?? undefined}
                      hint="Overrides the authored prompt. ⌘⏎ or click away to save · esc to cancel"
                      display={<span>{effectivePrompt}</span>}
                      onCommit={async (v) => {
                        const t = v.trim();
                        // Blanking with no override set: nothing to clear.
                        if (!t && !job.promptOverride) return;
                        await patchSystemField(job.name, { prompt: t || null });
                      }}
                    />
                    {job.promptOverride ? (
                      <OpsButton
                        intent="secondary"
                        size="xs"
                        disabled={pendingId === job.name}
                        onClick={() =>
                          void mutateSystem(job.name, () =>
                            patchSystemField(job.name, { prompt: null }),
                          )
                        }
                        className={cn("self-start rounded-md font-normal", TYPE.meta)}
                      >
                        Clear override (back to the authored prompt)
                      </OpsButton>
                    ) : null}
                  </div>
                ) : (
                  <span className="flex flex-col gap-1">
                    <span>{job.description}</span>
                    <span className={cn("text-muted-foreground/60", TYPE.micro)}>
                      The dispatcher has no prompt — it is the clock that runs the dynamic rules
                      and any overridden system crons.
                    </span>
                  </span>
                ),
            },
            {
              icon: WorkflowIcon,
              label: "Source",
              // WHICH workflow runs this cron. Not decoration: when set, the
              // run's message carries a ROUTE TO WORKFLOW line naming the
              // subagent (agent/lib/system-cron-defs.ts), so the orchestrator
              // delegates instead of doing the work itself. The dispatcher has
              // no prompt of its own, so it has nothing to route.
              value: overridable ? (
                <WorkflowSelect
                  value={job.workflow}
                  disabled={pendingId === job.name}
                  onChange={(next: string | null) =>
                    void mutateSystem(job.name, () =>
                      patchSystemField(job.name, { workflow: next }),
                    )
                  }
                />
              ) : (
                <span className={cn("text-muted-foreground/60", TYPE.meta)}>
                  The dispatcher runs the rules and the overridden crons — there is nothing to
                  route.
                </span>
              ),
            },
            {
              icon: PlayIcon,
              label: "Status",
              // Pause/resume inline, exactly like the schedules panel. A
              // soft-deleted cron stays plain text — Restore lives in the
              // table footer.
              value: job.deleted ? (
                <StatusLine status="deleted" />
              ) : (
                <InlineEnabled
                  enabled={job.enabled}
                  onCommit={(next) => patchSystemField(job.name, { enabled: next })}
                />
              ),
            },
            {
              icon: ClockIcon,
              label: "Last run",
              value: reviewText(job.lastRunAt ? fmtTime(job.lastRunAt) : null),
            },
            {
              icon: ZapIcon,
              label: "Last error",
              value: job.lastError ? (
                <span className="text-destructive">{job.lastError}</span>
              ) : (
                EMPTY_VALUE
              ),
            },
            // Alert target, honoured by the run itself (a NOTIFY TARGET line
            // on the message). "dynamic" posts nothing of its own, so nothing
            // would honour it there — read-only unset.
            overridable
              ? editableNotifyEmailSection(job.notifyEmails, (body) =>
                  patchSystemField(job.name, body),
                )
              : notifyEmailSection(null),
          ]}
          log={{ type: "system_cron", id: job.name }}
        />
      );
    }
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
      {/* Soft-deletes the code-authored cron: its handler starts returning early,
          and the row moves to the footer's Restore affordance. */}
      <ConfirmDeleteDialog
        name={confirmDeleteSystem}
        onCancel={() => setConfirmDeleteSystem(null)}
        onConfirm={() => {
          const name = confirmDeleteSystem;
          setConfirmDeleteSystem(null);
          if (!name) return;
          void mutateSystem(name, async () => {
            await opsFetch(`/api/ops/system-crons/${name}`, {
              method: "DELETE",
              body: JSON.stringify({ actor: authorEmail }),
            });
            setPanel((p) =>
              p.mode === "system" && p.name === name ? { mode: "closed" } : p,
            );
          });
        }}
      />
      <PanelLayout
        panel={panelBody ? <SidePanel onClose={closePanel}>{panelBody}</SidePanel> : null}
        header={
          <>
            <SectionHeaderCard
              section="crons"
              noun="Schedule"
              onAdd={() => {
                setSelectedId(null);
                setPanel({ mode: "wizard" });
              }}
            />
            <SearchBox
              noun="schedule"
              value={search}
              onChange={(v) => {
                setSearch(v);
                pager.setPage(1);
              }}
            />
            <Banners loadError={error} actionError={actionError} noun="schedule" />
          </>
        }
        table={
            <TableCard
              footer={
                <ListFooter
                  noun="schedule"
                  total={pager.total}
                  page={pager.page}
                  pages={pager.pages}
                  onPage={pager.setPage}
                  pageSize={pager.pageSize}
                  onPageSize={pager.setPageSize}
                >
                  {/* A deleted system cron is only soft-deleted (its schedule file
                      still exists), so it must be recoverable — otherwise the UI
                      could strand it with no way back. */}
                  {deletedSystemRows.length > 0 ? (
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-2 pr-4 text-muted-foreground",
                        TYPE.meta,
                      )}
                    >
                      {deletedSystemRows.length} hidden
                      {deletedSystemRows.map((j) => (
                        <OpsButton
                          key={j.name}
                          intent="secondary"
                          size="xs"
                          disabled={pendingId === j.name}
                          onClick={() =>
                            void mutateSystem(j.name, () =>
                              opsFetch(`/api/ops/system-crons/${j.name}`, {
                                method: "PATCH",
                                body: JSON.stringify({ restore: true, actor: authorEmail }),
                              }),
                            )
                          }
                          className={cn("rounded-md font-mono font-normal", TYPE.meta)}
                        >
                          Restore {j.name}
                        </OpsButton>
                      ))}
                    </span>
                  ) : null}
                </ListFooter>
              }
            >
              <thead>
                <tr>
                  <Th icon={TagIcon} label="Name" />
                  {compact ? null : (
                    <>
                      <Th icon={AlarmClockIcon} label="Cadence" />
                      <Th icon={TextIcon} label="Prompt" />
                      <Th icon={HashIcon} label="Channel" />
                      <Th icon={ClockIcon} label="Last run" />
                    </>
                  )}
                  <Th label="Actions" align="right" />
                </tr>
              </thead>
              <tbody>
                {/* Code-authored Vercel Cron jobs, pinned first. Their CADENCE,
                    PROMPT, and NOTIFY EMAIL can be overridden inline in the
                    detail panel (the run honours the override row — the
                    dispatcher for cadence, the run itself for prompt/notify)
                    and they can be paused and soft-deleted — each run() handler
                    checks its override row before starting. A soft-deleted one
                    drops out here and comes back through the Restore affordance
                    in the footer. */}
                {visibleSystemRows.map((j) => (
                  <tr key={j.name} className={cn("border-border/60 border-b", SURFACE.rowSystem)}>
                    <td className="py-2.5 pr-3 pl-4">
                      <span className="flex items-center gap-2">
                        <DeepLink
                          section="crons"
                          id={j.name}
                          className="max-w-48 truncate font-medium font-mono hover:underline"
                        >
                          {j.name}
                        </DeepLink>
                        <StatusDot status={systemCronStatus(j)} />
                      </span>
                    </td>
                    {compact ? null : (
                      <>
                        <Td>
                          <CodeChip>{j.cron}</CodeChip>
                        </Td>
                        <Td>
                          <PromptCell text={j.description} />
                        </Td>
                        <Td>
                          <EmptyCell />
                        </Td>
                        <Td>
                          <span className={cn("text-muted-foreground/60", TYPE.meta)}>
                            {j.lastRunAt ? fmtTime(j.lastRunAt) : EMPTY_VALUE}
                          </span>
                        </Td>
                      </>
                    )}
                    <td className="py-2.5 pr-4 pl-3">
                      <span className="flex items-center justify-end">
                        <RowMenu
                          enabled={j.enabled}
                          pending={pendingId === j.name}
                          onReview={() => {
                            setSelectedId(null);
                            setPanel({ mode: "system", name: j.name });
                          }}
                          onToggleEnabled={() =>
                            void mutateSystem(j.name, () =>
                              opsFetch(`/api/ops/system-crons/${j.name}`, {
                                method: "PATCH",
                                body: JSON.stringify({ enabled: !j.enabled, actor: authorEmail }),
                              }),
                            )
                          }
                          onDelete={() => setConfirmDeleteSystem(j.name)}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
                {loading ? (
                  <StateRow span={cols}>Loading…</StateRow>
                ) : pager.total === 0 ? (
                  // No "add one" placeholder when there are simply no custom
                  // schedules: the system crons are pinned above, so the table is
                  // never empty, and the Add button already says how to add one.
                  // A search that matches nothing still needs to say so.
                  all.length === 0 ? null : (
                    <StateRow span={cols} italic>
                      {`No schedules match "${search.trim()}".`}
                    </StateRow>
                  )
                ) : (
                  pager.rows.map((s) => {
                    const lastRun = fmtTime(s.lastRunAt);
                    const isSel = selectedId === s.id;
                    const stateLabel = s.lastError ? "error" : s.enabled ? "active" : "paused";
                    return (
                      <Fragment key={s.id}>
                        <ListRow
                          selected={isSel}
                          dimmed={!s.enabled}
                          onSelect={() => setSelectedId(s.id)}
                        >
                          <NameCell selected={isSel}>
                            <span className="flex items-center gap-1.5">
                              <DeepLink
                                section="crons"
                                id={s.id}
                                className={cn(
                                  "max-w-48 truncate font-medium font-mono hover:underline",
                                  isSel && "text-primary",
                                )}
                              >
                                {s.name}
                              </DeepLink>
                              <StatusDot status={stateLabel} />
                            </span>
                          </NameCell>
                          {compact ? null : (
                            <>
                              <Td>
                                {s.everyMinutes ? (
                                  <Chip>every {s.everyMinutes} min</Chip>
                                ) : s.cron ? (
                                  <CodeChip>{s.cron}</CodeChip>
                                ) : (
                                  <EmptyCell />
                                )}
                              </Td>
                              <Td>
                                {/* The prompt is a sentence, not an id: cut to one
                                    line it lost the verb and the object and left a
                                    hover as the only way to read it. Two lines at
                                    the row's own leading holds every prompt we
                                    actually run, and the title still covers the
                                    pathological one. */}
                                <PromptCell text={s.prompt} />
                              </Td>
                              <Td>
                                {s.channelId ? <CodeChip>#{s.channelId}</CodeChip> : <EmptyCell />}
                              </Td>
                              <Td>
                                <span
                                  className={cn(
                                    "whitespace-nowrap text-muted-foreground",
                                    TYPE.meta,
                                  )}
                                >
                                  {lastRun ?? "—"}
                                </span>
                              </Td>
                            </>
                          )}
                          <MenuCell>
                            <RowMenu
                              enabled={s.enabled}
                              pending={pendingId === s.id}
                              onReview={() => {
                                setSelectedId(s.id);
                                setPanel({ mode: "view", id: s.id });
                              }}
                              onToggleEnabled={() =>
                                void mutate(s.id, () =>
                                  opsFetch(`/api/ops/schedules/${s.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      enabled: !s.enabled,
                                      actor: authorEmail,
                                    }),
                                  }),
                                )
                              }
                              onDelete={() => setConfirmDelete(s)}
                            />
                          </MenuCell>
                        </ListRow>
                        {s.lastError ? (
                          <tr
                            className={cn("border-border/60 border-b", !s.enabled && "opacity-60")}
                          >
                            <td colSpan={cols} className="px-4 pt-0 pb-2.5">
                              <span className={cn("block truncate text-red-400", TYPE.meta)}>
                                Last error: {s.lastError}
                              </span>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
