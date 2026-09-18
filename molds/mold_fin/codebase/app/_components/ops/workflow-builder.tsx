"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MERMAID_THEME } from "./dashboard-ds";
import {
  ArrowRightIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  UserIcon,
  WorkflowIcon,
  ChevronRightIcon,
  CheckSquareIcon,
  RocketIcon,
  GripVerticalIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import {
  ASSIGN_LABELS,
  MIGRATE_LABELS,
  assignSummary,
  migrateSummary,
  type AssignRule,
  type MigrateRule,
  type WorkflowDefinition,
  type WorkflowEntity,
  type WorkflowStage,
} from "@/lib/workflow-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaginatedTable, type Column } from "./paginated-table";
import { errMessage, opsFetch } from "./lib";
import { afterMenuClose } from "./after-menu-close";

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `s_${Math.random().toString(36).slice(2)}`).slice(0, 12);

function linear(labels: [string, string][], assigns: AssignRule[]): WorkflowStage[] {
  const stages: WorkflowStage[] = labels.map(([label, description], i) => ({
    id: uid(),
    label,
    description,
    assign: assigns[i] ?? { type: "none" },
    transitions: [],
  }));
  for (let i = 0; i < stages.length - 1; i++) {
    stages[i].transitions = [{ to: stages[i + 1].id, migrate: { type: "manual" } }];
  }
  return stages;
}

const TEMPLATES: Record<WorkflowEntity, () => WorkflowStage[]> = {
  implementation: () =>
    linear(
      [
        ["Scoping", "Requirements and success criteria agreed with the customer."],
        ["Configuration", "Platform + solution configured for the customer."],
        ["Integration", "Connectors provisioned and the first sync is green."],
        ["UAT", "Customer validating against the acceptance criteria."],
        ["Go-live", "Launched in production and handed to support."],
      ],
      [{ type: "customer_owner" }, { type: "role", value: "engineer" }, { type: "role", value: "engineer" }, { type: "customer_owner" }, { type: "none" }],
    ),
  task: () =>
    linear(
      [
        ["Backlog", "Captured but not yet started."],
        ["Open", "Ready to be picked up."],
        ["In progress", "Actively being worked."],
        ["Blocked", "Waiting on someone or something."],
        ["Done", "Completed and verified."],
      ],
      [{ type: "none" }, { type: "least_loaded" }, { type: "none" }, { type: "none" }, { type: "none" }],
    ),
};

const ASSIGN_TYPES: AssignRule["type"][] = ["none", "role", "person", "team", "customer_owner", "least_loaded", "prompt"];
const MIGRATE_TYPES: MigrateRule["type"][] = ["manual", "rule", "prompt"];

/** What a workflow governs, as a glyph — replaces the Governs column. */
const ENTITY_ICONS: Record<string, typeof WorkflowIcon> = {
  task: CheckSquareIcon,
  implementation: RocketIcon,
};
const assignNeedsValue = (t: AssignRule["type"]) => t === "role" || t === "person" || t === "team" || t === "least_loaded" || t === "prompt";

/** Rules that pick between several people — the only ones a pool can narrow. */
const assignPicksFromPool = (t: AssignRule["type"]) =>
  t === "role" || t === "team" || t === "least_loaded" || t === "prompt";

/**
 * Rules that leave a choice open, where a stated preference can break the tie.
 * `prompt` is excluded on purpose: it IS the preference, and offering a second
 * free-text box beside it asks the same question twice.
 */
const assignTakesGuidance = (t: AssignRule["type"]) =>
  t === "role" || t === "team" || t === "least_loaded";

/** A labelled sub-field inside the Assign block. */
function AssignField({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-baseline gap-1.5">
        <span className="font-medium text-2xs text-foreground/80">{label}</span>
        {hint ? <span className="truncate text-2xs text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}
const migrateNeedsValue = (t: MigrateRule["type"]) => t === "rule" || t === "prompt";

/** A stored workflow plus its record metadata (the list view's row). */
type WorkflowRow = WorkflowDefinition & { createdBy?: string | null; createdAt?: string | null };

/**
 * The stage chain, as chips.
 *
 * This is the page's actual subject and it was a line of truncated 10px muted
 * text. Chips give each stage its own edge, the arrows show direction, and the
 * count — when we know it — says how much work is sitting in each one. A stage
 * that has held nothing for months is either dead weight or a process nobody
 * follows, and that is what someone opens this page to find out.
 */
function StageChain({
  stages,
  counts,
}: {
  readonly stages: { id: string; label: string }[];
  readonly counts?: Record<string, number>;
}) {
  if (stages.length === 0) {
    return <span className="text-2xs text-muted-foreground italic">No stages yet</span>;
  }
  // Task statuses are stored as the label lowercased with underscores.
  const countFor = (label: string) => counts?.[label.toLowerCase().replace(/\s+/g, "_")];
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
      {stages.map((st, i) => {
        const n = countFor(st.label);
        return (
          <span key={st.id} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs",
                n ? "border-border bg-muted/60 text-foreground" : "border-border/50 text-muted-foreground",
              )}
            >
              {st.label}
              {n ? <span className="tabular-nums text-muted-foreground">{n}</span> : null}
            </span>
            {i < stages.length - 1 ? (
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The workflow as a mermaid flowchart.
 *
 * Deliberately thorough: a diagram that only draws boxes and arrows tells you
 * nothing you could not read off the stage list in a quarter of the space. What
 * is NOT in that list is the shape — where work enters, who picks it up at each
 * stage, which moves are automatic and which need a person, which arrows go
 * BACKWARDS (rework loops are the thing people most often fail to notice they
 * designed), and where a piece of work can finally come to rest.
 */
function workflowMermaid(
  w: { stages: WorkflowStage[] },
  counts?: Record<string, number>,
): string {
  if (w.stages.length === 0) return "";
  const id = new Map(w.stages.map((s, i) => [s.id, `S${i}`]));
  const order = new Map(w.stages.map((s, i) => [s.id, i]));
  // Quotes and angle brackets end a mermaid label early; <br/> is intentional.
  const esc = (t: string) => t.replace(/"/g, "#quot;").replace(/[<>]/g, "").trim();
  const countFor = (label: string) => counts?.[label.toLowerCase().replace(/\s+/g, "_")];

  const lines = ["flowchart TD", "  START((start))"];
  lines.push(`  START --> ${id.get(w.stages[0].id)}`);

  const terminals: string[] = [];
  for (const st of w.stages) {
    const bits = [esc(st.label)];
    // Who picks it up here. assignSummary already folds in the department and
    // the stated preference, so the node carries the whole rule.
    bits.push(`👤 ${esc(assignSummary(st.assign))}`);
    const n = countFor(st.label);
    if (n) bits.push(`${n} ${n === 1 ? "item" : "items"} here now`);
    const isTerminal = st.transitions.length === 0;
    if (isTerminal) {
      bits.push("✅ work rests here");
      terminals.push(id.get(st.id) as string);
      lines.push(`  ${id.get(st.id)}(["${bits.join("<br/>")}"])`);
    } else {
      lines.push(`  ${id.get(st.id)}["${bits.join("<br/>")}"]`);
    }
  }

  for (const st of w.stages) {
    for (const t of st.transitions) {
      const to = id.get(t.to);
      if (!to) continue;
      // A transition to an EARLIER stage is rework — a dotted edge, because it
      // is the one thing a linear reading of the stage list hides completely.
      const backwards = (order.get(t.to) ?? 0) < (order.get(st.id) ?? 0);
      const label = esc(migrateSummary(t.migrate)) || "manual";
      lines.push(`  ${id.get(st.id)} ${backwards ? "-.->" : "-->"}|"${label}"| ${to}`);
    }
  }

  for (const t of terminals) lines.push(`  style ${t} fill:#0f2a1a,stroke:#2e7d32,color:#e6ffe6`);
  return lines.join("\n");
}

/**
 * The DAG, rendered directly.
 *
 * The markdown pipeline was doing this before, and it brings its own furniture:
 * a "mermaid" language label, download/copy/fullscreen buttons, a zoom cluster,
 * and two nested bordered boxes — all of it wrapped in a third box of mine. Four
 * frames around one small diagram. Calling mermaid ourselves gives back a plain
 * SVG and the space it deserves.
 */
function DagDialog({
  workflow,
  counts,
  onClose,
}: {
  readonly workflow: WorkflowRow | null;
  /** Live per-stage counts, so the diagram shows where work actually sits. */
  readonly counts?: Record<string, number>;
  readonly onClose: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const src = workflow ? workflowMermaid(workflow, counts) : "";

  useEffect(() => {
    if (!src) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        // Loaded on demand: mermaid is large and most sessions never open this.
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          ...MERMAID_THEME.config,
        });
        const id = `wf-dag-${Math.random().toString(36).slice(2)}`;
        const { svg: out } = await mermaid.render(id, src);
        if (!cancelled) setSvg(out);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <Dialog open={Boolean(workflow)} onOpenChange={(o) => !o && onClose()}>
      {/* 70% of the viewport — a diagram is the whole reason this dialog exists,
          so it gets the room rather than a default dialog width. */}
      <DialogContent
        showCloseButton
        className="flex h-[70vh] w-[70vw] max-w-none flex-col gap-3 sm:max-w-none"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{workflow?.name ?? "Workflow"}</DialogTitle>
          <DialogDescription>
            Every stage and transition. Rounded nodes are terminal — nothing follows.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {!src ? (
            <p className="text-muted-foreground text-sm">This workflow has no stages yet.</p>
          ) : failed ? (
            <pre className="overflow-auto rounded-lg bg-muted/40 p-3 text-2xs text-muted-foreground">{src}</pre>
          ) : svg ? (
            // The SVG is generated here from our own stage data — never from
            // anything a user typed into a page — and mermaid runs in strict
            // mode, so dangerouslySetInnerHTML is not a foothold for anyone.
            <div
              className="grid h-full place-items-center [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="grid h-full place-items-center"><Spinner /></div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowBuilder() {
  const [workflows, setWorkflows] = useState<WorkflowRow[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** Which stages are expanded. Everything starts collapsed — see StageCard. */
  const [openStages, setOpenStages] = useState<Set<string>>(new Set());
  const [dagOf, setDagOf] = useState<WorkflowRow | null>(null);
  const [editingName, setEditingName] = useState(false);
  // A small activation distance so a click on the handle still toggles rather
  // than starting a drag nobody meant.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /**
   * Is there anything to save?
   *
   * Save moved into the menu, and a primary action that is only reachable
   * through a menu is a good way to lose someone's edits. So it comes back out
   * — but only once the draft actually differs from what is stored, which also
   * means the header is quiet while you are just reading.
   */
  const dirty = useMemo(() => {
    if (!draft) return false;
    const original = workflows?.find((w) => w.id === draft.id);
    if (!original) return false;
    const shape = (d: { name: string; entity: string; stages: unknown }) =>
      JSON.stringify({ name: d.name, entity: d.entity, stages: d.stages });
    return shape(original) !== shape(draft);
  }, [draft, workflows]);

  /**
   * How many items actually sit in each stage, per workflow entity.
   *
   * Without this the page is purely declarative: it tells you the stages exist
   * and nothing about whether anyone uses them. A stage holding zero items for
   * months is either dead weight or a process nobody follows, and that is the
   * question someone opens this page to answer. Counts are keyed by the stage
   * LABEL lowercased with spaces as underscores, which is how the task statuses
   * are stored ("In progress" -> in_progress).
   */
  const [usage, setUsage] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await opsFetch<{ items: { status?: string }[] }>("/api/ops/todos?includeDone=true");
        if (cancelled) return;
        const byStatus: Record<string, number> = {};
        for (const t of d.items ?? []) {
          const k = (t.status ?? "open").toLowerCase();
          byStatus[k] = (byStatus[k] ?? 0) + 1;
        }
        setUsage({ task: byStatus });
      } catch {
        /* counts are an enhancement; the list still stands without them */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await opsFetch<{ items: WorkflowRow[]; canEdit: boolean }>("/api/ops/workflow-definitions");
      setWorkflows(d.items);
      setCanEdit(d.canEdit);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Sync the editable draft with the selected workflow.
  useEffect(() => {
    const wf = workflows?.find((w) => w.id === selectedId) ?? null;
    setDraft(wf ? structuredClone(wf) : null);
    setSaved(false);
  }, [selectedId, workflows]);

  // Create from the modal, then open the new row's builder card straight away.
  async function createWorkflow(entity: WorkflowEntity) {
    setBusy(true);
    setError(null);
    try {
      const name = entity === "implementation" ? "Implementation pipeline" : "Task workflow";
      const d = await opsFetch<{ item: WorkflowDefinition }>("/api/ops/workflow-definitions", {
        method: "POST",
        body: JSON.stringify({ name, entity, stages: TEMPLATES[entity]() }),
      });
      setCreateOpen(false);
      await load();
      setSelectedId(d.item.id);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await opsFetch(`/api/ops/workflow-definitions/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name, entity: draft.entity, stages: draft.stages }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Delete straight from a row's ··· menu.
  async function deleteWorkflow(w: WorkflowRow) {
    if (!confirm(`Delete the "${w.name}" workflow?`)) return;
    try {
      await opsFetch(`/api/ops/workflow-definitions/${w.id}`, { method: "DELETE" });
      setSelectedId((cur) => (cur === w.id ? null : cur));
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  }

  async function removeWorkflow() {
    if (!draft) return;
    if (!confirm(`Delete the "${draft.name}" workflow?`)) return;
    try {
      await opsFetch(`/api/ops/workflow-definitions/${draft.id}`, { method: "DELETE" });
      setSelectedId(null);
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  }

  const patchStage = (id: string, patch: Partial<WorkflowStage>) =>
    setDraft((d) => (d ? { ...d, stages: d.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d));
  const addStage = () =>
    setDraft((d) =>
      d ? { ...d, stages: [...d.stages, { id: uid(), label: "New stage", description: "", assign: { type: "none" }, transitions: [] }] } : d,
    );
  const removeStage = (id: string) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            stages: d.stages
              .filter((s) => s.id !== id)
              .map((s) => ({ ...s, transitions: s.transitions.filter((t) => t.to !== id) })),
          }
        : d,
    );

  if (workflows === null) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;

  const columns: Column<WorkflowRow>[] = [
    {
      key: "workflow",
      header: "Workflow",
      icon: WorkflowIcon,
      text: (w) => `${w.name} ${w.entity}`,
      cell: (w) => (
        <div className="flex items-center gap-2.5">
          {/* What it governs, as the row's own icon. A whole column to repeat
              one word per row bought nothing the icon cannot say. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
                {(() => {
                  const Icon = ENTITY_ICONS[w.entity] ?? WorkflowIcon;
                  return <Icon className="size-3.5" />;
                })()}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="capitalize">
              Governs {w.entity}s
            </TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <div className="truncate font-medium">{w.name}</div>
            {/* The stages ARE the workflow. They were a truncated line of 10px
                muted text under the name — the page's whole subject, rendered
                as an afterthought and clipped before the last stage. */}
            <StageChain stages={w.stages} counts={usage[w.entity]} />
          </div>
        </div>
      ),
    },
    {
      // Was a bare count of the stages — a number you can get by counting the
      // chips one column to the left. What is NOT visible anywhere else is
      // whether the workflow is carrying any real work.
      key: "inUse",
      header: "In use",
      text: () => "",
      cell: (w) => {
        const counts = usage[w.entity];
        const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
        if (total === null) return <span className="text-2xs text-muted-foreground">—</span>;
        return total === 0 ? (
          <span className="text-2xs text-muted-foreground">nothing yet</span>
        ) : (
          <span className="text-xs tabular-nums">
            {total} <span className="text-2xs text-muted-foreground">{w.entity}s</span>
          </span>
        );
      },
    },
    {
      key: "createdBy",
      header: "Created by",
      icon: UserIcon,
      text: (w) => w.createdBy ?? "",
      cell: (w) => (
        <div className="leading-tight">
          <div className="text-xs">{w.createdBy ?? "—"}</div>
          {w.createdAt ? (
            <div className="text-2xs text-muted-foreground">{new Date(w.createdAt).toLocaleDateString()}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (w) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label="Actions"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreHorizontalIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setSelectedId(w.id)}>Review</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => afterMenuClose(() => setDagOf(w))}>View diagram</DropdownMenuItem>
            {canEdit && (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => void deleteWorkflow(w)}
              >
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DagDialog workflow={dagOf} counts={dagOf ? usage[dagOf.entity] : undefined} onClose={() => setDagOf(null)} />
      {/* Choose what the new workflow governs. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription className="sr-only">Choose what kind of work this workflow governs.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2.5">
            {(
              [
                {
                  entity: "task" as const,
                  title: "Task workflow",
                  blurb: "Stages a task moves through — backlog, in progress, blocked, done.",
                },
                {
                  entity: "implementation" as const,
                  title: "Implementation workflow",
                  blurb: "A customer rollout pipeline — scoping, configuration, integration, UAT, go-live.",
                },
              ]
            ).map((o) => (
              <button
                key={o.entity}
                type="button"
                disabled={busy}
                onClick={() => void createWorkflow(o.entity)}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:bg-muted disabled:opacity-60"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
                  <WorkflowIcon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-sm">{o.title}</span>
                  <span className="block text-2xs text-muted-foreground">{o.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      <PaginatedTable
        rows={workflows}
        columns={columns}
        getKey={(w) => w.id}
        noun="workflow"
        icon={WorkflowIcon}
        title="Project workflows"
        blurb="Define the stages work moves through — how to assign into each, and how it advances."
        emptyLabel="No workflow yet — create one to define your stages."
        action={
          canEdit ? (
            <Button size="sm" onClick={() => setCreateOpen(true)} disabled={busy}>
              <PlusIcon className="size-4" /> New workflow
            </Button>
          ) : undefined
        }
        onRowClick={(w) => setSelectedId(w.id)}
        selectedKey={selectedId}
        onCloseDetail={() => setSelectedId(null)}
        renderDetail={() =>
          !draft ? (
            <div className="flex flex-1 items-center justify-center"><Spinner /></div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-5 pt-4">
              {/* One header row: the title reads as a title and edits in place,
                  everything else is behind the menu. The chip said
                  "Task workflow" beside a field that already said "Task
                  workflow", and the chain of chips repeated the list column one
                  panel to the left — two rows spent restating the row you
                  clicked to get here. */}
              {/* Line the header up with the panel's own close button, which is
                  positioned absolutely and so ignores this container entirely.
                  Its centre: top-2.5 (10px) + p-1 (4px) + half a size-4 icon
                  (8px) = 22px from the panel's top edge.
                  This row: the body's pt-4 (16px) + half of h-8 (16px) = 32px.
                  -mt-2.5 (10px) moves it to 6 + 16 = 22px. The three controls
                  then share one centre line instead of three. */}
              <div className="-mt-2.5 mb-4 flex h-8 items-center gap-1 pr-8">
                {editingName ? (
                  <input
                    autoFocus
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") setEditingName(false);
                    }}
                    aria-label="Workflow name"
                    className="min-w-0 flex-1 rounded-md border border-ring bg-transparent px-1.5 py-1 font-semibold text-base outline-none"
                  />
                ) : (
                  // A permanent input frame around a heading makes the panel
                  // look like a form you are mid-way through filling in. It is a
                  // title until you decide to change it.
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setEditingName(true)}
                    title={canEdit ? "Click to rename" : undefined}
                    className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left font-semibold text-base hover:bg-muted/60 disabled:hover:bg-transparent"
                  >
                    {draft.name}
                  </button>
                )}
                {saved && <span className="shrink-0 text-emerald-500 text-xs">Saved</span>}
                {canEdit && dirty && (
                  <Button size="sm" onClick={save} disabled={busy} className="shrink-0">
                    {busy ? "Saving…" : "Save"}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Workflow actions"
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => afterMenuClose(() => setDagOf(draft as WorkflowRow))}>
                      View diagram
                    </DropdownMenuItem>
                    {canEdit && (
                      <DropdownMenuItem onSelect={() => void save()} disabled={busy}>
                        Save
                      </DropdownMenuItem>
                    )}
                    {canEdit && (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => void removeWorkflow()}
                      >
                        Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={({ active, over }) => {
                  if (!over || active.id === over.id) return;
                  const from = draft.stages.findIndex((s) => s.id === active.id);
                  const to = draft.stages.findIndex((s) => s.id === over.id);
                  if (from < 0 || to < 0) return;
                  setDraft({ ...draft, stages: arrayMove(draft.stages, from, to) });
                }}
              >
                <SortableContext
                  items={draft.stages.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
              <div className="space-y-2">
                {draft.stages.map((stage, i) => (
                  <StageCard
                    key={stage.id}
                    index={i}
                    stage={stage}
                    allStages={draft.stages}
                    canEdit={canEdit}
                    open={openStages.has(stage.id)}
                    onToggle={() =>
                      setOpenStages((prev) => {
                        const next = new Set(prev);
                        if (next.has(stage.id)) next.delete(stage.id);
                        else next.add(stage.id);
                        return next;
                      })
                    }
                    onChange={(patch) => patchStage(stage.id, patch)}
                    onRemove={() => removeStage(stage.id)}
                  />
                ))}
                {canEdit && (
                  <button
                    type="button"
                    onClick={addStage}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 text-muted-foreground text-sm hover:text-foreground"
                  >
                    <PlusIcon className="size-4" /> Add stage
                  </button>
                )}
              </div>
                </SortableContext>
              </DndContext>
            </div>
          )
        }
      />
    </div>
  );
}

/**
 * One stage, collapsed by default.
 *
 * Every stage used to render fully expanded, so a five-stage workflow was a
 * ~1300px wall of form controls and you could see two stages at a time. The
 * panel is opened to understand a workflow — where work enters, how it is
 * assigned, where it can go — and that shape was the one thing it could not
 * show. Collapsed rows carry the same facts as a sentence; expanding is for
 * when you actually intend to change something.
 */
function StageCard({
  index,
  stage,
  allStages,
  canEdit,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  index: number;
  stage: WorkflowStage;
  allStages: WorkflowStage[];
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<WorkflowStage>) => void;
  onRemove: () => void;
}) {
  const others = allStages.filter((s) => s.id !== stage.id);
  const setAssignType = (type: AssignRule["type"]) =>
    onChange({ assign: (assignNeedsValue(type) ? { type, value: "" } : { type }) as AssignRule });
  const setAssignValue = (value: string) =>
    onChange({ assign: { ...(stage.assign as { type: AssignRule["type"]; value?: string }), value } as AssignRule });

  const addTransition = () => {
    const to = others[0]?.id;
    if (!to) return;
    onChange({ transitions: [...stage.transitions, { to, migrate: { type: "manual" } }] });
  };
  const patchTransition = (i: number, patch: Partial<WorkflowStage["transitions"][number]>) =>
    onChange({ transitions: stage.transitions.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const removeTransition = (i: number) => onChange({ transitions: stage.transitions.filter((_, j) => j !== i) });

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 10 : undefined,
  } as React.CSSProperties;

  const labelCls = "text-2xs font-medium uppercase tracking-wide text-muted-foreground";
  const inputCls = "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-70";

  // The collapsed line: assignment, exits, and how much is sitting here.
  const nameOf = (id: string) => allStages.find((x) => x.id === id)?.label ?? "?";
  const summary = [
    stage.assign.type === "none" ? null : ASSIGN_LABELS[stage.assign.type],
    stage.transitions.length === 0
      ? "terminal"
      : `→ ${stage.transitions.map((t) => nameOf(t.to)).join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div ref={setNodeRef} style={style} className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 p-3">
        {canEdit && (
          // Stage ORDER is the sequence work moves through, and it was fixed at
          // creation — the only way to reorder was to delete and rebuild every
          // stage plus its transitions.
          <button
            type="button"
            aria-label={`Reorder ${stage.label}`}
            className="cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          // Belt and braces: the drag sensor lives on the handle, but a pointer
          // sequence that starts here must never be claimed by it — a stage you
          // cannot open is a far worse failure than a drag that does not start.
          onPointerDown={(e) => e.stopPropagation()}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted font-medium text-2xs text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            {/* No count here: the stage chips in the list column already carry
                it, and beside the name it competed with the thing you came to
                read. */}
            <span className="truncate font-semibold text-sm">{stage.label}</span>
            {!open && summary ? (
              <span className="block truncate text-2xs text-muted-foreground">{summary}</span>
            ) : null}
          </span>
        </button>
        {canEdit && (
          <button onClick={onRemove} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove stage">
            <Trash2Icon className="size-4" />
          </button>
        )}
      </div>

      {!open ? null : (
      <div className="border-border/60 border-t p-4 pt-3">
      <div className="mb-3">
        <span className={labelCls}>Stage name</span>
        <input
          value={stage.label}
          onChange={(e) => onChange({ label: e.target.value })}
          disabled={!canEdit}
          className={inputCls}
        />
      </div>

      {/* One field per row. Side by side, a two-line description sat next to a
          single select and the whole right half of the card was empty — and the
          assign rule can grow a second control (team, role, person), which then
          wrapped under a textarea it has nothing to do with. */}
      <div className="flex flex-col gap-3">
        <label className="space-y-1">
          <span className={labelCls}>Contains</span>
          <textarea
            value={stage.description}
            onChange={(e) => onChange({ description: e.target.value })}
            disabled={!canEdit}
            rows={2}
            placeholder="Entry meaning / definition of this stage…"
            className={inputCls}
          />
        </label>

        <div className="space-y-1">
          <span className={labelCls}>Assign</span>
          {/* The fields follow the strategy, because they do not all apply to
              all of them. Showing every field always produced nonsense: with
              "By a prompt" you got the prompt AND a separate "guidance"
              box — two free-text fields asking for the same sentence — and a
              department filter next to "Fixed person", which narrows a pool of
              exactly one. */}
          <div className="flex flex-col gap-2">
            <select
              value={stage.assign.type}
              onChange={(e) => setAssignType(e.target.value as AssignRule["type"])}
              disabled={!canEdit}
              className={inputCls}
            >
              {ASSIGN_TYPES.map((t) => (
                <option key={t} value={t}>{ASSIGN_LABELS[t]}</option>
              ))}
            </select>

            {assignNeedsValue(stage.assign.type) && (
              <AssignField
                label={
                  stage.assign.type === "prompt"
                    ? "Instruction"
                    : stage.assign.type === "role"
                      ? "Role"
                      : stage.assign.type === "person"
                        ? "Person"
                        : "Team"
                }
                hint={
                  stage.assign.type === "prompt"
                    ? "What the agent should look for when it picks someone."
                    : undefined
                }
              >
                <input
                  value={(stage.assign as { value?: string }).value ?? ""}
                  onChange={(e) => setAssignValue(e.target.value)}
                  disabled={!canEdit}
                  placeholder={
                    stage.assign.type === "prompt"
                      ? "e.g. the senior engineer on that customer"
                      : stage.assign.type === "role"
                        ? "e.g. engineer"
                        : stage.assign.type === "person"
                          ? "name@company.com"
                          : "e.g. platform"
                  }
                  className={inputCls}
                />
              </AssignField>
            )}

            {/* A department narrows a POOL, so it only means anything when the
                rule is choosing between people. */}
            {assignPicksFromPool(stage.assign.type) && (
              <AssignField label="Department" hint="Only consider people in this department.">
                <input
                  value={stage.assign.department ?? ""}
                  onChange={(e) =>
                    onChange({ assign: { ...stage.assign, department: e.target.value || undefined } })
                  }
                  disabled={!canEdit}
                  placeholder="Optional — e.g. Risk"
                  className={inputCls}
                />
              </AssignField>
            )}

            {/* Guidance is a tie-break for a MECHANICAL rule. The prompt rule is
                already nothing but guidance, so it never gets this. */}
            {assignTakesGuidance(stage.assign.type) && (
              <AssignField label="Preference" hint="Applied when the rule leaves a choice open.">
                <input
                  value={stage.assign.guidance ?? ""}
                  onChange={(e) =>
                    onChange({ assign: { ...stage.assign, guidance: e.target.value || undefined } })
                  }
                  disabled={!canEdit}
                  placeholder="Optional — e.g. prefer whoever handled the last ticket"
                  className={inputCls}
                />
              </AssignField>
            )}
          </div>
        </div>
      </div>

      {/* Transitions */}
      <div className="mt-3 space-y-2">
        <span className={labelCls}>Moves to</span>
        {stage.transitions.length === 0 && <div className="text-2xs text-muted-foreground">Terminal stage — nothing after this.</div>}
        {stage.transitions.map((t, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
            <ArrowRightIcon className="size-3.5 text-muted-foreground" />
            <select value={t.to} onChange={(e) => patchTransition(i, { to: e.target.value })} disabled={!canEdit} className="rounded-md border border-input bg-transparent px-1.5 py-1 text-xs">
              {others.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <span className="text-2xs text-muted-foreground">via</span>
            <select
              value={t.migrate.type}
              onChange={(e) => patchTransition(i, { migrate: (migrateNeedsValue(e.target.value as MigrateRule["type"]) ? { type: e.target.value, value: "" } : { type: e.target.value }) as MigrateRule })}
              disabled={!canEdit}
              className="rounded-md border border-input bg-transparent px-1.5 py-1 text-xs"
            >
              {MIGRATE_TYPES.map((m) => (
                <option key={m} value={m}>{MIGRATE_LABELS[m]}</option>
              ))}
            </select>
            {migrateNeedsValue(t.migrate.type) && (
              <input
                value={(t.migrate as { value?: string }).value ?? ""}
                onChange={(e) => patchTransition(i, { migrate: { type: t.migrate.type, value: e.target.value } as MigrateRule })}
                disabled={!canEdit}
                placeholder={t.migrate.type === "prompt" ? "e.g. when all readiness gates pass" : "condition"}
                className="min-w-[10rem] flex-1 rounded-md border border-input bg-transparent px-1.5 py-1 text-xs"
              />
            )}
            {canEdit && (
              <button onClick={() => removeTransition(i)} className="ml-auto text-muted-foreground hover:text-destructive" aria-label="Remove transition">
                <Trash2Icon className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {canEdit && others.length > 0 && (
          <button type="button" onClick={addTransition} className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
            <GitBranchIcon className="size-3" /> Add transition
          </button>
        )}
      </div>
      </div>
      )}
    </div>
  );
}
