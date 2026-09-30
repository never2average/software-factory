"use client";

/**
 * TODOs — the team's internal action list. Deliberately NOT the tickets
 * system: a flat, fast checklist. Quick-add + inline check/priority/hide in the
 * list; a side panel edits the rest — notes, due, assignee, and the container
 * (a Deployment/Implementation "epic") and link (a related object) via pickers.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  BracesIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  LayersIcon,
  ListFilterIcon,
  ListTodoIcon,
  type LucideIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusIcon,
  RocketIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CustomerMark } from "../customer-mark";
import type { BoardColumn } from "./board";
import { Badge, DeployCard, ImplCard, MetaLine, TaskCard, WorkspaceCard } from "./cards";
import {
  ViewSwitcher,
  WorkspaceViews,
  type ViewMode,
  type WorkspaceViewConfig,
} from "./workspace-views";
import { Burndown } from "./burndown";
import { ActivityFeed, CommentThread } from "./entity-detail";
import {
  errMessage,
  opsFetch,
  useOpsList,
  type ApiCycle,
  type ApiRefDeployment,
  type ApiRefImplementation,
  type ApiRosterMember,
  type ApiTodo,
} from "./lib";
import {
  Banners,
  Field,
  IconButton,
  ListFooter,
  OpsButton,
  OpsInput,
  OpsSelect,
  OpsTextarea,
  SearchBox,
  SidePanel,
} from "./primitives";
import { SURFACE, TYPE } from "./tokens";
import { CustomFieldControl, customFieldError } from "./custom-fields";
import { displayCustom, validateCustom } from "@/agent/lib/custom-fields";
import type { CustomFieldSpec, DomainArea } from "@/lib/deployment-profile.generated";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { bundleToMarkdown, exportJson, type ExportBundle } from "@/lib/record-export";
import { domainView, groupRows, groupSlug, groupTitle, withProfileFields, type DomainFormField, type DomainView } from "@/lib/profile-domains";

/**
 * The two record areas as THIS deployment names them (docs/DEPLOYMENT_PROFILE.md, `domains`). Every label below
 * passes its old literal through: the default profile gives it straight back, a redefined area replaces it.
 */
const DEP = domainView("deployments");
const IMP = domainView("implementations");
const ACCOUNT = DEPLOYMENT_PROFILE.vocabulary.account;
const ACCOUNT_LABEL = ACCOUNT.singular.charAt(0).toUpperCase() + ACCOUNT.singular.slice(1);
const ACCOUNTS_LOWER = ACCOUNT.plural;

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-500",
  normal: "bg-muted-foreground/40",
  low: "bg-sky-500/60",
};

const TASK_STATUSES = [
  { value: "backlog", label: "Backlog", tone: "bg-muted-foreground/40" },
  { value: "open", label: "Open", tone: "bg-sky-500" },
  { value: "in_progress", label: "In progress", tone: "bg-amber-500" },
  { value: "blocked", label: "Blocked", tone: "bg-red-500" },
  { value: "done", label: "Done", tone: "bg-emerald-500" },
  { value: "cancelled", label: "Cancelled", tone: "bg-muted-foreground/25" },
] as const;
const TASK_COLUMNS: BoardColumn[] = TASK_STATUSES.map((s) => ({ key: s.value, label: s.label, tone: s.tone }));

/* ------------------------------ org scope --------------------------------- */

type ScopeKey = "me" | "reportees" | "team" | "everyone";

const TASK_SORTS = [
  { value: "created", label: "Newest" },
  { value: "priority", label: "Priority" },
  { value: "due", label: "Due date" },
  { value: "title", label: "Title" },
] as const;

const DEPLOYMENT_SORTS = [
  { value: "customer", label: ACCOUNT_LABEL },
  { value: "health", label: DEP.label("healthStatus", "Health", "short") },
  { value: "status", label: DEP.label("releaseStatus", "Status", "short") },
  ...(DEP.hidden("environment") ? [] : [{ value: "env", label: DEP.label("environment", "Environment") }]),
] as const;
const IMPLEMENTATION_SORTS = [
  { value: "customer", label: ACCOUNT_LABEL },
  { value: "stage", label: IMP.label("implementationStage", "Stage", "short") },
  { value: "risk", label: IMP.label("implementationRiskLevel", "Risk", "short") },
  { value: "progress", label: IMP.label("implementationProgressPct", "Progress", "short") },
] as const;

/**
 * Resolves the "me / my reportees / my team / everyone" filter against the
 * roster (email → team + manager). Multi-select: `scopes` is a set of picks and
 * `inScope(ownerEmail)` passes if the owner matches ANY of them. Empty (or
 * "everyone") = no filter.
 */
function useScope(authorEmail: string | undefined, initial: readonly ScopeKey[]) {
  const { items } = useOpsList<ApiRosterMember>("/api/ops/roster");
  const [scopes, setScopes] = useState<string[]>([...initial]);
  const me = authorEmail?.toLowerCase() ?? null;
  const roster = items ?? [];
  const { reportees, teamMates } = useMemo(() => {
    const rep = new Set<string>();
    const team = new Set<string>();
    const myTeam = me ? roster.find((r) => r.email.toLowerCase() === me)?.team ?? null : null;
    for (const r of roster) {
      const e = r.email.toLowerCase();
      if (me && r.managerEmail?.toLowerCase() === me) rep.add(e);
      if (myTeam && r.team === myTeam) team.add(e);
    }
    if (me && myTeam) team.add(me); // my team includes me
    return { reportees: rep, teamMates: team };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, me]);

  const inScope = useCallback(
    (owner: string | null | undefined) => {
      if (scopes.length === 0 || scopes.includes("everyone")) return true;
      if (!owner) return false; // unowned items only surface under "everyone"
      const o = owner.toLowerCase();
      return scopes.some((s) => (s === "me" ? o === me : s === "reportees" ? reportees.has(o) : teamMates.has(o)));
    },
    [scopes, me, reportees, teamMates],
  );
  return { scopes, setScopes, inScope };
}

/* ------------------------------ tab toolbar ------------------------------- */

type SortOption = { value: string; label: string };

/** Client-side pager: slices `rows` to a page, resetting to page 1 when the
 *  filtered set changes (via `resetKey`) so you never land on an empty page. */
function usePaged<T>(rows: readonly T[], resetKey: unknown) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const clamped = Math.min(page, pages);
  const slice = rows.slice((clamped - 1) * pageSize, clamped * pageSize);
  useEffect(() => setPage(1), [resetKey, pageSize]);
  return { slice, page: clamped, pages, setPage, pageSize, setPageSize, total: rows.length };
}

type FilterGroup = {
  label: string;
  /** Currently-selected values; empty = no filter (all). */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  options: readonly SortOption[];
};

const SCOPE_OPTIONS: readonly SortOption[] = [
  { value: "me", label: "Me" },
  { value: "reportees", label: "My reportees" },
  { value: "team", label: "My team" },
  { value: "everyone", label: "Everyone" },
];

/** A toolbar dropdown: a button that matches the others and opens a menu. */
function ToolbarMenu({
  label,
  icon: Icon,
  children,
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OpsButton intent="secondary" size="sm" className="shrink-0 gap-1.5 px-3">
          <Icon className="size-3.5 opacity-70" />
          {label}
          <ChevronDownIcon className="size-3.5 opacity-50" />
        </OpsButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The single "Filter" dropdown. Each facet is a labelled section of MULTI-SELECT
 * checkboxes inside ONE stable menu — deliberately NOT hover fly-out submenus,
 * which recompute their position on every render and visibly jitter. Toggling a
 * box keeps the menu open (onSelect is prevented) so you can pick several.
 * Empty selection in a facet = no filter on it.
 */
function FilterMenu({ groups }: { readonly groups: readonly FilterGroup[] }) {
  const active = groups.reduce((n, g) => n + g.selected.length, 0);
  return (
    <ToolbarMenu label={active > 0 ? `Filter · ${active}` : "Filter"} icon={ListFilterIcon}>
      {groups.map((g, i) => (
        <Fragment key={g.label}>
          {i > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuLabel className="flex items-center justify-between gap-4">
            <span className={cn("text-muted-foreground", TYPE.micro)}>{g.label}</span>
            {g.selected.length > 0 ? (
              <button
                type="button"
                onClick={() => g.onChange([])}
                className={cn("text-muted-foreground/60 hover:text-foreground", TYPE.micro)}
              >
                Clear
              </button>
            ) : null}
          </DropdownMenuLabel>
          {g.options.map((o) => {
            const checked = g.selected.includes(o.value);
            return (
              <DropdownMenuCheckboxItem
                key={o.value}
                checked={checked}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(c) =>
                  g.onChange(c ? [...g.selected, o.value] : g.selected.filter((v) => v !== o.value))
                }
              >
                {o.label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </Fragment>
      ))}
    </ToolbarMenu>
  );
}

/**
 * The standardized per-tab toolbar. Two dropdowns only: a nested **Filter**
 * (Status / Scope / Cycle) and **Views** (ordering). Every TODO view renders
 * this so the top row is identical everywhere; all controls share one height.
 */
function TabToolbar({
  noun,
  q,
  setQ,
  onCreate,
  createLabel,
  filter,
  sort,
  setSort,
  sortOptions,
  onClose,
  viewSwitcher,
}: {
  readonly noun: string;
  readonly q: string;
  readonly setQ: (v: string) => void;
  readonly onCreate?: () => void;
  readonly createLabel?: string;
  readonly filter?: React.ReactNode;
  readonly sort: string;
  readonly setSort: (v: string) => void;
  readonly sortOptions: readonly SortOption[];
  readonly onClose: () => void;
  readonly viewSwitcher?: React.ReactNode;
}) {
  // One shared height for every control (search input + all the buttons).
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-2 py-2 [&_button]:h-9 [&_input]:h-9">
      <div className="relative min-w-40 flex-1">
        <SearchBox noun={noun} value={q} onChange={setQ} />
      </div>
      {viewSwitcher}
      {onCreate ? (
        <OpsButton
          intent="ghost"
          size="sm"
          onClick={onCreate}
          className="shrink-0 gap-1.5 px-3 text-primary hover:bg-primary/10 hover:text-primary"
        >
          <PlusIcon className="size-3.5" />
          {createLabel}
        </OpsButton>
      ) : null}
      {filter}
      <ToolbarMenu label="Views" icon={SlidersHorizontalIcon}>
        <DropdownMenuLabel className="text-muted-foreground">Ordering</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          {sortOptions.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </ToolbarMenu>
      <IconButton aria-label="Close" title="Close" onClick={onClose} className="ml-0.5 h-9 w-9 shrink-0">
        <XIcon className="size-4" />
      </IconButton>
    </div>
  );
}

/* --------------------------- reference pickers ---------------------------- */

type RefKind = "deployment" | "implementation" | "ticket" | "customer" | "app" | "cron" | "workflow";
type RefItem = { id: string; label: string; name?: string };

const REF_ENDPOINT: Record<RefKind, string> = {
  deployment: "/api/ops/deployments",
  implementation: "/api/ops/implementations",
  ticket: "/api/ops/tickets",
  customer: "/api/ops/customers",
  app: "/api/ops/apps",
  cron: "/api/ops/schedules",
  workflow: "/api/ops/workflows",
};

/** Pick one object of `kind` from its live list; returns { id, label }. */
/** What a person reads for a reference kind; the kind itself stays the identifier. Default profile: the kind. */
const REF_NOUN: Partial<Record<RefKind, string>> = { customer: ACCOUNT.singular, deployment: DEP.noun, implementation: IMP.noun };

function ReferenceSelect({
  kind,
  value,
  onChange,
  disabled,
}: {
  readonly kind: RefKind;
  readonly value: string | null;
  readonly onChange: (ref: { id: string; label: string } | null) => void;
  readonly disabled?: boolean;
}) {
  const { items } = useOpsList<RefItem>(REF_ENDPOINT[kind]);
  const opts = (items ?? []).map((it) => ({ id: it.id, label: it.label ?? it.name ?? it.id }));
  return (
    <OpsSelect
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const id = e.target.value;
        if (!id) return onChange(null);
        const it = opts.find((o) => o.id === id);
        onChange({ id, label: it?.label ?? id });
      }}
    >
      <option value="">{items === null ? "Loading…" : `Choose a ${REF_NOUN[kind] ?? kind}…`}</option>
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </OpsSelect>
  );
}

/* -------------------------------- helpers --------------------------------- */

/** Go-live countdown for implementation cards: "due in N days" / "N days overdue". */
function goLiveDue(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (days === 0) return { text: "due today", overdue: false };
  if (days > 0) return { text: `due in ${days} day${days === 1 ? "" : "s"}`, overdue: false };
  return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, overdue: true };
}

function dueLabel(iso: string): { text: string; overdue: boolean } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { text: iso, overdue: false };
  const days = Math.round((t - Date.now()) / 86_400_000);
  const overdue = t < Date.now();
  const text =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : days > 0 ? `in ${days}d` : `${-days}d ago`;
  return { text: `due ${text}`, overdue };
}

/* ------------------------------- the panel -------------------------------- */

type TodoView = "sprints" | "tasks" | "deployments" | "implementations";

const NAV: { key: TodoView; label: string; icon: LucideIcon; blurb: string }[] = [
  { key: "sprints", label: "Sprints", icon: LayersIcon, blurb: "Time-boxed cycles that group tasks." },
  { key: "tasks", label: "Tasks", icon: ListTodoIcon, blurb: "The team's internal checklist." },
  { key: "deployments", label: DEP.title, icon: RocketIcon, blurb: DEP.description },
  { key: "implementations", label: IMP.title, icon: PackageIcon, blurb: IMP.description },
];

export function TodosPanel({
  authorEmail,
  onClose,
  initialSelectedId,
  initialView,
  onInitialConsumed,
}: {
  readonly authorEmail?: string;
  readonly onClose: () => void;
  /** Deep-link (`/?ops=todos&id=<todo id>`): the task to open on first show. */
  readonly initialSelectedId?: string;
  /** Deep-link (`&view=<tab>`): which tab to open on first show. */
  readonly initialView?: TodoView;
  readonly onInitialConsumed?: () => void;
}) {
  const { items, error, refetch, loading } = useOpsList<ApiTodo>("/api/ops/todos");
  const [view, setView] = useState<TodoView>(initialView ?? "tasks");
  const [taskView, setTaskView] = useState<ViewMode>("kanban");
  const { scopes, setScopes, inScope } = useScope(authorEmail, []);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"created" | "priority" | "due" | "title">("created");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cycleSel, setCycleSel] = useState<string[]>([]);
  const cyclesQ = useOpsList<ApiCycle>("/api/ops/cycles");
  const cycles = cyclesQ.items ?? [];
  const now = Date.now();
  const currentCycle = cycles.find(
    (c) => c.startsAt && c.endsAt && Date.parse(c.startsAt) <= now && now <= Date.parse(c.endsAt),
  );
  const cycleName = (id: string | null) => (id ? cycles.find((c) => c.id === id)?.name ?? null : null);
  // Per-type numeric slugs (TS-001 …), ordered by creation.
  const taskSeq = useMemo(
    () => buildSeqMap(items ?? [], (t) => t.id, (t) => Date.parse(t.createdAt)),
    [items],
  );

  const query = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (t) =>
          inScope(t.assignee ?? t.createdBy) &&
          (cycleSel.length === 0 ||
            cycleSel.some((s) =>
              s === "backlog" ? !t.cycleId : s === "current" ? t.cycleId === currentCycle?.id : t.cycleId === s,
            )) &&
          (!query ||
            [t.title, t.notes ?? "", t.containerLabel ?? "", t.linkLabel ?? "", t.assignee ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(query)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, inScope, query, cycleSel, currentCycle?.id],
  );
  const sorted = useMemo(() => {
    const rank = { high: 0, normal: 1, low: 2 } as const;
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sort === "priority") return rank[a.priority] - rank[b.priority];
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "due") {
        const av = a.dueAt ? Date.parse(a.dueAt) : Infinity;
        const bv = b.dueAt ? Date.parse(b.dueAt) : Infinity;
        return av - bv;
      }
      return Date.parse(b.createdAt) - Date.parse(a.createdAt); // created (newest)
    });
    return arr;
  }, [filtered, sort]);
  const selected = items?.find((t) => t.id === selectedId) ?? null;

  // Deep-link (`/?ops=todos&id=…`): once todos load, open that task's detail on
  // the Tasks view, then tell the modal it's consumed so switching tabs later
  // doesn't re-select it.
  useEffect(() => {
    if (!initialSelectedId || !items) return;
    if (items.some((t) => t.id === initialSelectedId)) {
      setView("tasks");
      setSelectedId(initialSelectedId);
    }
    onInitialConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedId, items]);

  const run = async (id: string | null, fn: () => Promise<unknown>) => {
    setBusyId(id ?? "new");
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  // "New task" from the toolbar: create a placeholder and open its detail so
  // the title can be typed straight away (the app's Add-then-edit pattern).
  const createTask = () =>
    run(null, async () => {
      const res = await opsFetch<{ item: { id: string } }>("/api/ops/todos", {
        method: "POST",
        body: JSON.stringify({ title: "New task", createdBy: authorEmail ?? "web" }),
      });
      setView("tasks");
      setSelectedId(res.item.id);
    });
  const patch = (id: string, body: Record<string, unknown>) =>
    run(id, () => opsFetch(`/api/ops/todos/${id}`, { method: "PATCH", body: JSON.stringify({ ...body, actor: authorEmail }) }));
  const hide = (id: string) =>
    run(id, async () => {
      await opsFetch(`/api/ops/todos/${id}`, { method: "DELETE" });
      setSelectedId((s) => (s === id ? null : s));
    });
  // Add a todo from inside a details card — stays put (the card's related list
  // refreshes) instead of jumping to Tasks.
  const addTodoTo = (body: Record<string, unknown>) =>
    run(null, () =>
      opsFetch("/api/ops/todos", {
        method: "POST",
        body: JSON.stringify({ ...body, createdBy: authorEmail ?? "web" }),
      }),
    );
  // Jump to a todo (from a related-todos list) and open its editor.
  const openTodo = (id: string) => {
    setView("tasks");
    setSelectedId(id);
  };
  // Write editable key fields back to a system-of-record row, then refresh that
  // list so the row + card reflect it.
  const patchRef = (endpoint: string, id: string, body: Record<string, unknown>, refetchRef: () => void) =>
    run(null, async () => {
      await opsFetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...body, actor: authorEmail }) });
      refetchRef();
    });
  const todos = items ?? [];
  // Burndown of the tasks filed under one implementation (for its card).
  const burndownFor = (id: string) => {
    const its = todos.filter((t) => t.containerType === "implementation" && t.containerId === id);
    if (its.length === 0) return undefined;
    const created = its.map((t) => Date.parse(t.createdAt)).filter((n) => !Number.isNaN(n));
    const dues = its.map((t) => (t.dueAt ? Date.parse(t.dueAt) : Number.NaN)).filter((n) => !Number.isNaN(n));
    const start = created.length ? Math.min(...created) : Date.now();
    const end = dues.length ? Math.max(...dues) : start + 14 * 86_400_000;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      committed: its.length,
      doneDates: its.filter((t) => t.done).map((t) => t.doneAt).filter((d): d is string => Boolean(d)),
    };
  };

  const list = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <TabToolbar
        noun="todo"
        q={q}
        setQ={setQ}
        onCreate={createTask}
        createLabel="New task"
        sort={sort}
        setSort={(v) => setSort(v as typeof sort)}
        sortOptions={TASK_SORTS}
        onClose={onClose}
        viewSwitcher={<ViewSwitcher view={taskView} setView={setTaskView} />}
        filter={
          <FilterMenu
            groups={[
              { label: "Scope", selected: scopes, onChange: setScopes, options: SCOPE_OPTIONS },
              {
                label: "Cycle",
                selected: cycleSel,
                onChange: setCycleSel,
                options: [
                  ...(currentCycle ? [{ value: "current", label: `Current · ${currentCycle.name}` }] : []),
                  { value: "backlog", label: "Backlog" },
                  ...cycles.map((c) => ({ value: c.id, label: c.name })),
                ],
              },
            ]}
          />
        }
      />

      <Banners loadError={error} actionError={actionError} noun="todo" />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loading && !items ? (
            <p className={cn("py-10 text-center text-muted-foreground", TYPE.meta)}>Loading todos…</p>
          ) : (items?.length ?? 0) === 0 ? (
            <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>No todos yet — hit New task.</p>
          ) : (
            <WorkspaceViews
          view={taskView}
          config={{
            items: sorted,
            selectedId,
            onSelect: setSelectedId,
            renderCard: (t) => (
              <TaskCard
                task={{
                  title: t.title,
                  priority: t.priority,
                  done: t.done,
                  assignee: t.assignee,
                  cycleLabel: cycleName(t.cycleId),
                  containerType: t.containerType,
                  containerLabel: t.containerLabel,
                  due: t.dueAt ? dueLabel(t.dueAt) : null,
                }}
                selected={selectedId === t.id}
                onClick={() => setSelectedId(t.id)}
              />
            ),
            kanban: {
              columns: TASK_COLUMNS,
              columnOf: (t) => (TASK_STATUSES.some((s) => s.value === t.status) ? t.status : "open"),
              onMove: (t, col) => patch(t.id, { status: col }),
            },
            table: [
              { key: "title", label: "Task", render: (t) => <span className={cn("font-medium", t.done && "text-muted-foreground/60 line-through")}>{t.title}</span> },
              { key: "status", label: "Status", render: (t) => <span className="capitalize">{t.status.replace("_", " ")}</span> },
              { key: "priority", label: "Priority", render: (t) => <span className="capitalize">{t.priority}</span> },
              { key: "cycle", label: "Cycle", render: (t) => cycleName(t.cycleId) ?? "—" },
              { key: "due", label: "Due", render: (t) => (t.dueAt ? dueLabel(t.dueAt).text : "—") },
              { key: "assignee", label: "Assignee", render: (t) => (t.assignee ? t.assignee.split("@")[0] : "—") },
            ],
            timeline: {
              rangeOf: (t) => ({ start: t.createdAt, end: t.dueAt ?? t.createdAt }),
              labelOf: (t) => t.title,
              toneOf: (t) => (t.done ? "bg-emerald-500/60" : t.priority === "high" ? "bg-red-500/70" : "bg-indigo-500/70"),
            },
          }}
        />
          )}
        </div>
        {selected ? (
          <SidePanel
            onClose={() => setSelectedId(null)}
            actions={
              <PanelActionsMenu
                shareView="tasks"
                shareId={selected.id}
                deleteLabel="Delete task"
                onDelete={() => hide(selected.id)}
                exportType="task"
                exportId={selected.id}
                copyTitle={selected.title}
              />
            }
          >
            <TodoDetail
              todo={selected}
              cycles={cycles}
              busy={busyId === selected.id}
              authorEmail={authorEmail}
              slug={seqSlug("TS", taskSeq.get(selected.id) ?? 0)}
              onPatch={(body) => patch(selected.id, body)}
              subtasks={(items ?? []).filter((t) => t.parentId === selected.id)}
              onAddSubtask={(title) => addTodoTo({ title, parentId: selected.id })}
              onToggleSubtask={(id, done) => patch(id, { status: done ? "done" : "open" })}
              onOpenSubtask={(id) => setSelectedId(id)}
            />
          </SidePanel>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Side-nav: the TODO workspace's five views. */}
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-border/60 border-r bg-muted/20 p-3">
        {NAV.map((n) => {
          const isActive = view === n.key;
          return (
            <button
              key={n.key}
              type="button"
              onClick={() => {
                setView(n.key);
                setSelectedId(null);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
                TYPE.body,
                isActive
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <n.icon className={cn("size-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground/70")} />
              <span className="truncate">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {view === "tasks" ? (
          list
        ) : view === "sprints" ? (
          <CyclesManager
            cycles={cycles}
            todos={items ?? []}
            authorEmail={authorEmail}
            onChanged={() => {
              void cyclesQ.refetch();
              void refetch();
            }}
            onClose={onClose}
            onOpenTodo={openTodo}
          />
        ) : view === "deployments" ? (
          <MineList<ApiRefDeployment>
            endpoint="/api/ops/deployments"
            authorEmail={authorEmail}
            noun={DEP.noun}
            nounPlural={DEP.nouns}
            mapItems={uniqueDeploymentIds}
            onClose={onClose}
            createConfig={{
              label: `New ${DEP.noun}`,
              fixed: DEP.fixedValues(),
              fields: deploymentCreateFields(DEP),
              area: "deployments",
              customFields: DEP.customFields,
            }}
            sortOptions={DEPLOYMENT_SORTS}
            textOf={(d) => `${d.label} ${d.id} ${DEP.display("releaseStatus", d.status)} ${DEP.display("healthStatus", d.health)} ${DEP.hidden("environment") ? "" : d.env} ${kindOf(DEP, d.fields) ?? ""} ${customText(DEP, d.custom)}`}
            sortOf={(d, s) =>
              s === "health" ? d.health : s === "status" ? d.status : s === "env" ? d.env : d.customer ?? ""
            }
            buildViews={({ selectedId, onSelect, refetch }) => ({
              renderCard: (d) => (
                <DeployCard
                  deploy={{
                    customer: d.customerLabel ?? d.customer ?? d.id,
                    env: DEP.hidden("environment") ? "" : d.env,
                    version: d.version,
                    health: d.health,
                    healthLabel: DEP.display("healthStatus", d.health, "") || undefined,
                    kind: kindOf(DEP, d.fields),
                    status: d.status,
                    owner: d.owner,
                    uptime: DEP.hidden("uptime30dPct") ? null : d.uptime,
                  }}
                  selected={selectedId === d.id}
                  onClick={() => onSelect(d.id)}
                />
              ),
              kanban: {
                columns: DEPLOY_COLUMNS,
                columnOf: (d) => d.status,
                onMove: (d, status) => void patchRef("/api/ops/deployments", d.recordId ?? d.id, { customerId: d.customer, releaseStatus: status, ...(d.recordId ? { entityId: d.id } : {}) }, refetch),
              },
              table: [
                { key: "customer", label: ACCOUNT_LABEL, render: (d) => <span className="font-medium">{d.customerLabel ?? d.customer ?? d.id}</span> },
                // A redefined area names its records by id (a report id), so the id earns a column.
                ...(DEP.redefined ? [{ key: "id", label: DEP.idLabel, render: (d: ApiRefDeployment) => <span className="font-mono">{d.recordId ?? d.id}</span> }] : []),
                ...(DEP.spec.kind_field ? [{ key: "kind", label: DEP.label(DEP.spec.kind_field, DEP.spec.kind_field, "short"), render: (d: ApiRefDeployment) => kindOf(DEP, d.fields) ?? "—" }] : []),
                ...(DEP.hidden("environment") ? [] : [{ key: "env", label: DEP.label("environment", "Env", "short"), render: (d: ApiRefDeployment) => d.env }]),
                { key: "version", label: DEP.label("deployedVersion", "Version", "short"), render: (d) => <span className="font-mono">{d.version}</span> },
                { key: "health", label: DEP.label("healthStatus", "Health", "short"), render: (d) => <span className={cn("inline-flex items-center gap-1.5", DEP.display("healthStatus", d.health, "") ? null : "capitalize")}><span className={cn("size-1.5 rounded-full", healthDot(d.health))} />{DEP.display("healthStatus", d.health)}</span> },
                { key: "status", label: DEP.label("releaseStatus", "Release", "short"), render: (d) => DEP.display("releaseStatus", d.status) },
                ...customColumns<ApiRefDeployment>(DEP),
                { key: "owner", label: DEP.label("deployOwnerEmail", "Owner", "short"), render: (d) => (d.owner ? d.owner.split("@")[0] : "—") },
              ],
              timeline: {
                rangeOf: (d) => ({ start: d.lastDeployAt, end: d.lastDeployAt }),
                labelOf: (d) => d.customerLabel ?? d.customer ?? d.id,
                toneOf: (d) => (d.health === "healthy" ? "bg-emerald-500/70" : d.health === "degraded" ? "bg-amber-500/70" : "bg-red-500/70"),
              },
            })}
            renderDetail={(d, api) => (
              <RefDetail
                entity="deployment"
                eyebrow={DEP.noun}
                entityId={d.id}
                slug={api.slug}
                authorEmail={authorEmail}
                title={d.label}
                subtitle={[DEP.hidden("environment") ? null : d.env, d.version].filter(Boolean).join(" · ")}
                busy={busyId === "new"}
                edits={detailEdits(DEP, [
                  { key: "healthStatus", label: DEP.label("healthStatus", "Health"), value: d.health },
                  { key: "releaseStatus", label: DEP.label("releaseStatus", "Release status"), value: d.status },
                  { key: "deployOwnerEmail", label: DEP.label("deployOwnerEmail", "Owner"), value: d.owner ?? "" },
                ], d.fields)}
                area="deployments"
                customFields={DEP.customFields}
                custom={d.custom}
                displayName={d.displayName}
                onSave={(patch) => patchRef("/api/ops/deployments", d.recordId ?? d.id, { customerId: d.customer, ...patch, ...(d.recordId ? { entityId: d.id } : {}) }, api.refetch)}
                staticFields={[
                  { label: ACCOUNT_LABEL, value: d.customer ?? "" },
                  ...(DEP.redefined ? [{ label: DEP.idLabel, value: d.recordId ?? d.id }] : []),
                  ...(DEP.hidden("environment") ? [] : [{ label: DEP.label("environment", "Environment"), value: d.env }]),
                  { label: DEP.label("deployedVersion", "Version"), value: d.version },
                ]}
                related={todos.filter((td) => td.containerType === "deployment" && td.containerId === d.id)}
                onAddSubtask={(title) =>
                  addTodoTo({ title, containerType: "deployment", containerId: d.id, containerLabel: d.label })
                }
                onToggleSubtask={(id, done) => patch(id, { status: done ? "done" : "open" })}
                onOpenTodo={openTodo}
              />
            )}
            shareView="deployments"
            deleteUrl={(d) => `/api/ops/deployments/${encodeURIComponent(d.recordId ?? d.id)}?customerId=${encodeURIComponent(d.customer ?? "")}`}
            exportType="deployment"
            exportCustomerId={(d) => d.customer}
          />
        ) : (
          <MineList<ApiRefImplementation>
            endpoint="/api/ops/implementations"
            authorEmail={authorEmail}
            noun={IMP.noun}
            nounPlural={IMP.nouns}
            onClose={onClose}
            grouping={
              IMP.groupBy && IMP.groupLabel
                ? {
                    field: IMP.groupBy,
                    label: IMP.groupLabel,
                    members: ACCOUNTS_LOWER,
                    groupOf: (r) => groupValue(r.fields, IMP.groupBy),
                    ownerOf: (r) => r.owner,
                    progressOf: (r) => r.progress,
                  }
                : undefined
            }
            createConfig={{
              label: `New ${IMP.noun}`,
              fixed: IMP.fixedValues(),
              fields: implementationCreateFields(IMP),
              area: "implementations",
              customFields: IMP.customFields,
            }}
            sortOptions={IMPLEMENTATION_SORTS}
            textOf={(r) => `${r.label} ${IMP.display("implementationStage", r.stage)} ${IMP.display("implementationRiskLevel", r.risk)} ${groupTitle(groupValue(r.fields, IMP.groupBy) ?? "")} ${customText(IMP, r.custom)}`}
            sortOf={(r, s) =>
              s === "stage"
                ? r.stage
                : s === "risk"
                  ? r.risk
                  : s === "progress"
                    ? -(r.progress ?? -1)
                    : r.customer ?? ""
            }
            buildViews={({ selectedId, onSelect, refetch }) => ({
              renderCard: (r) => (
                <ImplCard
                  impl={{
                    title: implTitle(r),
                    customer: IMP.groupBy ? groupTitle(groupValue(r.fields, IMP.groupBy) ?? "") || "—" : r.customerLabel ?? r.customer ?? "—",
                    risk: r.risk,
                    owner: r.owner,
                    due: goLiveDue(r.goLiveDate),
                    burndown: burndownFor(r.id),
                  }}
                  selected={selectedId === r.id}
                  onClick={() => onSelect(r.id)}
                />
              ),
              kanban: {
                columns: IMPL_COLUMNS,
                columnOf: (r) => r.stage,
                onMove: (r, stage) => void patchRef("/api/ops/implementations", r.id, { customerId: r.customer, implementationStage: stage }, refetch),
              },
              table: [
                ...(IMP.hidden("launchScopeSolutionIds") ? [] : [{ key: "solution", label: IMP.label("launchScopeSolutionIds", "Solution", "short"), render: (r: ApiRefImplementation) => <span className="font-medium">{implTitle(r)}</span> }]),
                { key: "customer", label: ACCOUNT_LABEL, render: (r) => <span className={IMP.hidden("launchScopeSolutionIds") ? "font-medium" : undefined}>{r.customerLabel ?? r.customer ?? "—"}</span> },
                { key: "stage", label: IMP.label("implementationStage", "Stage", "short"), render: (r) => IMP.display("implementationStage", r.stage) },
                ...(IMP.redefined ? [{ key: "progress", label: IMP.label("implementationProgressPct", "Progress", "short"), render: (r: ApiRefImplementation) => (r.progress != null ? `${Math.round(r.progress)}%` : "—") }] : []),
                { key: "risk", label: IMP.label("implementationRiskLevel", "Risk", "short"), render: (r) => <span className="capitalize">{IMP.display("implementationRiskLevel", r.risk)}</span> },
                ...IMP.spec.detail_fields
                  .filter((k) => TABLE_EXTRA_TYPES.includes(IMP.formField(k)?.kind ?? "") && k !== "implementationProgressPct")
                  .map((k) => ({ key: k, label: IMP.label(k, k, "short"), render: (r: ApiRefImplementation) => showField(IMP, k, r.fields?.[k]) })),
                ...customColumns<ApiRefImplementation>(IMP),
                { key: "golive", label: IMP.label("targetGoLiveDate", "Go-live", "short"), render: (r) => goLiveDue(r.goLiveDate)?.text ?? "—" },
                { key: "owner", label: IMP.label("implementationOwnerEmail", "Owner", "short"), render: (r) => (r.owner ? r.owner.split("@")[0] : "—") },
              ],
              timeline: {
                rangeOf: (r) => ({ start: null, end: r.goLiveDate }),
                labelOf: (r) => implTitle(r),
                toneOf: (r) => riskTone(r.risk),
              },
            })}
            renderDetail={(r, api) => (
              <RefDetail
                entity="implementation"
                eyebrow={IMP.noun}
                entityId={r.id}
                slug={api.slug}
                authorEmail={authorEmail}
                title={r.label}
                subtitle={r.progress != null ? `${Math.round(r.progress)}% complete` : undefined}
                busy={busyId === "new"}
                edits={detailEdits(IMP, [
                  { key: "implementationStage", label: IMP.label("implementationStage", "Stage"), value: r.stage },
                  { key: "implementationRiskLevel", label: IMP.label("implementationRiskLevel", "Risk"), value: r.risk },
                  { key: "implementationOwnerEmail", label: IMP.label("implementationOwnerEmail", "Owner"), value: r.owner ?? "" },
                ], r.fields)}
                area="implementations"
                customFields={IMP.customFields}
                custom={r.custom}
                displayName={r.displayName}
                onSave={(patch) => patchRef("/api/ops/implementations", r.id, { customerId: r.customer, ...patch }, api.refetch)}
                staticFields={[{ label: ACCOUNT_LABEL, value: r.customer ?? "" }]}
                related={todos.filter((td) => td.containerType === "implementation" && td.containerId === r.id)}
                onAddSubtask={(title) =>
                  addTodoTo({ title, containerType: "implementation", containerId: r.id, containerLabel: r.label })
                }
                onToggleSubtask={(id, done) => patch(id, { status: done ? "done" : "open" })}
                onOpenTodo={openTodo}
              />
            )}
            shareView="implementations"
            deleteUrl={(r) => `/api/ops/implementations/${encodeURIComponent(r.id)}?customerId=${encodeURIComponent(r.customer ?? "")}`}
            exportType="implementation"
            exportCustomerId={(r) => r.customer}
          />
        )}
        </div>
      </div>
  );
}

/* ------------------- the deployment profile's two areas ------------------- */

const TABLE_EXTRA_TYPES: readonly string[] = ["select", "number"];

function groupValue(fields: Record<string, string | number | null> | undefined, key: string | null): string | null {
  const v = key ? fields?.[key] : null;
  return typeof v === "string" && v.trim() ? v : null;
}

/** The profile's kind of record (a report type…), read from the free-text field that carries it. */
function kindOf(view: DomainView, fields: Record<string, string | number | null> | undefined): string | null {
  return groupValue(fields, view.spec.kind_field);
}

/** A profile field's stored value, as a person reads it: enum display label, "62%" for a percentage. */
function showField(view: DomainView, key: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return /Pct$/.test(key) ? `${Math.round(value)}%` : String(value);
  return view.display(key, value);
}

/** The list's columns for the profile's OWN fields marked show_in_list; a link is a link, the rest read as text. */
function customColumns<T extends { custom?: Record<string, string | number> }>(view: DomainView): { key: string; label: string; render: (row: T) => React.ReactNode }[] {
  return view.listCustomFields.map((f) => ({
    key: `custom.${f.key}`,
    label: f.label,
    render: (row: T) => {
      const shown = displayCustom(f, row.custom?.[f.key]);
      if (!shown) return "—";
      return f.type === "link" ? (
        <a href={shown} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
          {hostOf(shown)}
        </a>
      ) : f.type === "number" || f.type === "percent" ? (
        <span className="tabular-nums">{shown}</span>
      ) : (
        shown
      );
    },
  }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the list's search matches of a row's custom values. */
function customText(view: DomainView, custom: Record<string, string | number> | undefined): string {
  return view.listCustomFields.map((f) => displayCustom(f, custom?.[f.key])).join(" ");
}

function implTitle(r: ApiRefImplementation): string {
  const account = r.customerLabel ?? r.customer ?? r.id;
  return IMP.hidden("launchScopeSolutionIds") ? account : r.solutionName ?? account;
}

/** Risk is Green/Yellow/Red in the schema; the old form wrote low/medium/high/critical. Both colour correctly. */
function riskTone(risk: string): string {
  const r = risk.toLowerCase();
  return r === "high" || r === "critical" || r === "red" ? "bg-red-500/70" : r === "medium" || r === "yellow" ? "bg-amber-500/70" : "bg-emerald-500/70";
}

/**
 * A deployment id is unique per customer, not per workspace: two companies can each have "Q2FY26-results". The
 * list, the selection and the activity feed key on `id`, so a repeated id becomes customer + id and the real one
 * is kept in `recordId` for the API. Ids that are already unique are untouched.
 */
function uniqueDeploymentIds(items: ApiRefDeployment[]): ApiRefDeployment[] {
  const seen = new Map<string, number>();
  for (const d of items) seen.set(d.id, (seen.get(d.id) ?? 0) + 1);
  return items.map((d) => ((seen.get(d.id) ?? 0) > 1 ? { ...d, recordId: d.id, id: `${d.customer ?? ""}::${d.id}` } : d));
}

export function deploymentCreateFields(view: DomainView): RefCreateField[] {
  return withProfileFields<RefCreateField>(
    view,
    [
      { key: "customerId", label: ACCOUNT_LABEL, kind: "customer", required: true },
      { key: "deploymentId", label: view.idLabel, kind: "text", placeholder: view.placeholder("deploymentId", "DEP-…"), required: true },
      {
        key: "environment",
        label: view.label("environment", "Environment"),
        kind: "select",
        options: view.options("environment", [
          { value: "production", label: "Production" },
          { value: "staging", label: "Staging" },
          { value: "development", label: "Development" },
        ]),
      },
      { key: "region", label: view.label("region", "Region"), kind: "text", placeholder: view.placeholder("region", "ap-south-1"), required: true },
      { key: "deployedVersion", label: view.label("deployedVersion", "Version"), kind: "text", placeholder: view.placeholder("deployedVersion", "1.0.0"), required: true },
      { key: "releaseStatus", label: view.label("releaseStatus", "Release status"), kind: "select", options: view.options("releaseStatus", DEPLOY_COLUMNS.map((c) => ({ value: c.key, label: c.label }))) },
      {
        key: "healthStatus",
        label: view.label("healthStatus", "Health"),
        kind: "select",
        options: view.options("healthStatus", [
          { value: "healthy", label: "Healthy" },
          { value: "degraded", label: "Degraded" },
          { value: "down", label: "Down" },
        ]),
      },
      { key: "deployOwnerEmail", label: view.label("deployOwnerEmail", "Owner"), kind: "text", placeholder: view.placeholder("deployOwnerEmail", "name@company.com") },
    ],
    view.spec.create_fields,
  ).map((f) => ({ ...f, help: view.help(f.key) }) as RefCreateField);
}

export function implementationCreateFields(view: DomainView): RefCreateField[] {
  const group = view.groupBy ? view.formField(view.groupBy) : null;
  return withProfileFields<RefCreateField>(
    view,
    [
      { key: "customerId", label: ACCOUNT_LABEL, kind: "customer", required: true },
      ...(group ? [group as RefCreateField] : []),
      { key: "implementationStage", label: view.label("implementationStage", "Stage"), kind: "select", options: view.options("implementationStage", IMPL_STAGES.map((st) => ({ value: st, label: st }))) },
      {
        key: "implementationRiskLevel",
        label: view.label("implementationRiskLevel", "Risk"),
        kind: "select",
        options: view.options("implementationRiskLevel", [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "critical", label: "Critical" },
        ]),
      },
      { key: "implementationOwnerEmail", label: view.label("implementationOwnerEmail", "Owner"), kind: "text", placeholder: view.placeholder("implementationOwnerEmail", "name@company.com") },
    ],
    view.spec.create_fields,
  ).map((f) => ({ ...f, help: view.help(f.key) }) as RefCreateField);
}

/** The detail card's editable fields: the built-in three (a relabelled enum becomes a select), then the profile's. */
function detailEdits(view: DomainView, builtIn: readonly RefEdit[], fields: Record<string, string | number | null> | undefined): RefEdit[] {
  const kept: RefEdit[] = builtIn
    .filter((e) => !view.hidden(e.key))
    .map((e) => (view.optionsRedefined(e.key) ? { ...e, kind: "select" as const, options: view.options(e.key) } : e));
  const have = new Set(kept.map((e) => e.key));
  const extra = view.spec.detail_fields.filter((k) => !have.has(k)).flatMap((k): RefEdit[] => {
    const f: DomainFormField | null = view.formField(k);
    if (!f) return [];
    const raw = fields?.[k];
    return [{ key: k, label: f.label, value: raw == null ? "" : String(raw), kind: f.kind, options: f.kind === "select" ? f.options : undefined, help: f.help, clearable: !("required" in f && f.required) }];
  });
  return [...kept, ...extra];
}

/* --------------------------- "My …" reference views ----------------------- */

/**
 * A read view over an owned reference list (tickets / deployments /
 * implementations). Filters to the current user by default, searches, and lets
 * you spin a linked TODO off any row.
 */
function MineList<T extends { id: string; owner: string | null }>({
  endpoint,
  authorEmail,
  noun,
  nounPlural,
  mapItems,
  grouping,
  textOf,
  sortOf,
  sortOptions,
  onClose,
  renderDetail,
  buildViews,
  createConfig,
  shareView,
  deleteUrl,
  exportType,
  exportCustomerId,
}: {
  readonly endpoint: string;
  readonly authorEmail?: string;
  readonly noun: string;
  /** "coverage reports": the plural a person reads. Defaults to `${noun}s`. */
  readonly nounPlural?: string;
  /** Normalise the fetched rows before anything keys on them (e.g. make repeated ids unique). */
  readonly mapItems?: (items: T[]) => T[];
  /** The profile's group_by: rows gathered under a header per group, and "New" picks or names a group. */
  readonly grouping?: {
    readonly field: string;
    readonly label: { singular: string; plural: string };
    /** What the rows of a group are, in the plural ("companies"). */
    readonly members: string;
    readonly groupOf: (t: T) => string | null;
    readonly ownerOf: (t: T) => string | null;
    readonly progressOf: (t: T) => number | null;
  };
  readonly textOf: (t: T) => string;
  /** Comparable key for sort option `s` (string sorts A→Z; use a negative number to sort desc). */
  readonly sortOf: (t: T, s: string) => string | number;
  readonly sortOptions: readonly SortOption[];
  readonly onClose: () => void;
  /** The editable details card for one record, opened when a row/card is clicked. */
  readonly renderDetail: (
    item: T,
    api: { refetch: () => void; close: () => void; slug: string },
  ) => React.ReactNode;
  /** The tab's kanban / table / timeline config (items/selection injected here). */
  readonly buildViews: (api: {
    selectedId: string | null;
    onSelect: (id: string) => void;
    refetch: () => void;
  }) => Omit<WorkspaceViewConfig<T>, "items" | "selectedId" | "onSelect">;
  /** Enables the "New …" button + create panel. Omit for a read-only list. */
  readonly createConfig?: {
    readonly label: string;
    readonly fields: readonly RefCreateField[];
    /** Submitted with every create: the values of fields this deployment hides (`fixed` in the profile). */
    readonly fixed?: Record<string, string | number>;
    /** The profile's OWN fields (`custom_fields`), rendered after the built-in ones and submitted under `custom`. */
    readonly area?: DomainArea;
    readonly customFields?: readonly CustomFieldSpec[];
  };
  /** Deep-link view + delete endpoint for the panel's "…" menu. */
  readonly shareView: "deployments" | "implementations";
  readonly deleteUrl: (item: T) => string;
  /** Copy-as-JSON/MD: the export entity type + how to read its customer id. */
  readonly exportType: "deployment" | "implementation";
  readonly exportCustomerId: (item: T) => string | null;
}) {
  const { items: fetched, error, loading, refetch } = useOpsList<T>(endpoint);
  const items = useMemo(() => (fetched && mapItems ? mapItems(fetched) : fetched), [fetched, mapItems]);
  const nouns = nounPlural ?? `${noun}s`;
  const [groupKey, setGroupKey] = useState<string | null>(null);
  // Numeric slugs (DP-001 / IM-001), by stable id order.
  const seqPrefix = exportType === "deployment" ? "DP" : "IM";
  const seqMap = useMemo(() => buildSeqMap(items ?? [], (i) => i.id, (i) => i.id), [items]);
  const { scopes, setScopes, inScope } = useScope(authorEmail, ["me"]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>(sortOptions[0].value);
  const [view, setView] = useState<ViewMode>("kanban");
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const query = q.trim().toLowerCase();
  const filtered = (items ?? [])
    .filter((t) => inScope(t.owner) && (!query || textOf(t).toLowerCase().includes(query)))
    .filter((t) => !grouping || groupKey === null || (grouping.groupOf(t)?.trim() ?? "") === groupKey)
    .sort((a, b) => {
      const av = sortOf(a, sort);
      const bv = sortOf(b, sort);
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv));
    });
  const selected = items?.find((t) => t.id === selId) ?? null;
  // Group headers are counted over everything in scope, not over the group currently picked.
  const groups = grouping
    ? groupRows(
        (items ?? []).filter((t) => inScope(t.owner) && (!query || textOf(t).toLowerCase().includes(query))),
        grouping.groupOf,
        grouping.ownerOf,
        grouping.progressOf,
      )
    : [];
  const groupChoices = grouping
    ? [...new Set((items ?? []).map((t) => grouping.groupOf(t)?.trim() ?? "").filter(Boolean))].sort().map((g) => ({ value: g, label: groupTitle(g) }))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabToolbar
        noun={noun}
        q={q}
        setQ={setQ}
        sort={sort}
        setSort={setSort}
        sortOptions={sortOptions}
        onClose={onClose}
        onCreate={
          createConfig
            ? () => {
                setSelId(null);
                setCreating(true);
              }
            : undefined
        }
        createLabel={createConfig?.label}
        viewSwitcher={<ViewSwitcher view={view} setView={setView} />}
        filter={<FilterMenu groups={[{ label: "Scope", selected: scopes, onChange: setScopes, options: SCOPE_OPTIONS }]} />}
      />

      {error ? <p className={cn("px-4 pt-3 text-red-400", TYPE.meta)}>{error}</p> : null}

      {grouping && groups.length > 0 && (view !== "table" || groupKey !== null) ? (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-border/60 border-b px-4 py-2" data-testid="group-strip">
          <button
            type="button"
            onClick={() => setGroupKey(null)}
            className={cn("shrink-0 rounded-md border px-2.5 py-1", TYPE.meta, groupKey === null ? "border-foreground/40 bg-background font-medium" : "border-border/60 text-muted-foreground hover:text-foreground")}
          >
            All {grouping.label.plural.toLowerCase()}
          </button>
          {groups.map((g) => (
            <GroupHeader key={g.key || "—"} compact active={groupKey === g.key} group={g} label={grouping.label} members={grouping.members} onPick={() => setGroupKey(groupKey === g.key ? null : g.key)} />
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loading && !items ? (
            <p className={cn("py-10 text-center text-muted-foreground", TYPE.meta)}>Loading {nouns}…</p>
          ) : filtered.length === 0 ? (
            <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>
              {(items?.length ?? 0) === 0 ? `No ${nouns}.` : `No ${nouns} in this scope.`}
            </p>
          ) : grouping && view === "table" && groupKey === null ? (
            <div className="min-h-0 flex-1 overflow-auto" data-testid="grouped-list">
              {groups.map((g) => (
                <section key={g.key || "—"} data-testid="group-section">
                  <GroupHeader group={g} label={grouping.label} members={grouping.members} onPick={() => setGroupKey(g.key)} />
                  <WorkspaceViews
                    view="table"
                    config={{ items: filtered.filter((t) => (grouping.groupOf(t)?.trim() ?? "") === g.key), selectedId: selId, onSelect: setSelId, ...buildViews({ selectedId: selId, onSelect: setSelId, refetch }) }}
                  />
                </section>
              ))}
            </div>
          ) : (
            <WorkspaceViews
              view={view}
              config={{ items: filtered, selectedId: selId, onSelect: setSelId, ...buildViews({ selectedId: selId, onSelect: setSelId, refetch }) }}
            />
          )}
        </div>
        {creating && createConfig ? (
          <SidePanel onClose={() => setCreating(false)}>
            <RefCreate
              noun={noun}
              endpoint={endpoint}
              fields={createConfig.fields}
              fixed={createConfig.fixed}
              area={createConfig.area}
              customFields={createConfig.customFields}
              groupChoices={groupChoices}
              groupNoun={grouping?.label.singular}
              authorEmail={authorEmail}
              onCancel={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                refetch();
                setSelId(id);
              }}
            />
          </SidePanel>
        ) : selected ? (
          <SidePanel
            onClose={() => setSelId(null)}
            actions={
              <PanelActionsMenu
                shareView={shareView}
                shareId={selected.id}
                deleteLabel={`Delete ${noun}`}
                onDelete={() => {
                  void opsFetch(deleteUrl(selected), { method: "DELETE" })
                    .then(() => refetch())
                    .catch(() => {});
                  setSelId(null);
                }}
                exportType={exportType}
                exportId={selected.id}
                exportCustomerId={exportCustomerId(selected)}
                copyTitle={(selected as { label?: string }).label ?? selected.id}
              />
            }
          >
            {renderDetail(selected, {
              refetch,
              close: () => setSelId(null),
              slug: seqSlug(seqPrefix, seqMap.get(selected.id) ?? 0),
            })}
          </SidePanel>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------- create panels ------------------------------ */

export type RefCreateField =
  | { readonly key: string; readonly label: string; readonly kind: "text" | "number"; readonly placeholder?: string; readonly required?: boolean; readonly help?: string }
  | { readonly key: string; readonly label: string; readonly kind: "customer"; readonly required?: boolean; readonly help?: string }
  /** The profile's group_by field: pick an existing group or name a new one (stored as its slug). */
  | { readonly key: string; readonly label: string; readonly kind: "group"; readonly help?: string }
  | {
      readonly key: string;
      readonly label: string;
      readonly kind: "select";
      readonly options: readonly { value: string; label: string }[];
      readonly help?: string;
    };

/** Not a slug groupSlug() can produce, so it never collides with a real group. */
const NEW_GROUP = "__new__";

/** One group's header: its name, who owns it, how many rows, how far along they are on average. */
function GroupHeader<T>({
  group,
  label,
  members,
  onPick,
  compact,
  active,
}: {
  readonly group: { key: string; title: string; owner: string | null; rows: T[]; averageProgress: number | null };
  readonly label: { singular: string; plural: string };
  readonly members: string;
  readonly onPick: () => void;
  readonly compact?: boolean;
  readonly active?: boolean;
}) {
  const title = group.title || `No ${label.singular.toLowerCase()}`;
  const facts = [
    group.owner ? group.owner.split("@")[0] : null,
    `${group.rows.length} ${group.rows.length === 1 ? ACCOUNT.singular : members}`,
    group.averageProgress != null ? `${group.averageProgress}% average` : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="group-header"
      className={cn(
        "flex items-baseline gap-2 text-left",
        compact
          ? cn("shrink-0 rounded-md border px-2.5 py-1", active ? "border-foreground/40 bg-background" : "border-border/60 hover:bg-background/60")
          : "w-full border-border/60 border-b bg-muted/20 px-6 pt-4 pb-2",
      )}
    >
      <span className={cn("font-medium text-foreground", compact ? TYPE.meta : TYPE.body)}>{title}</span>
      <span className={cn("text-muted-foreground", TYPE.micro)}>{facts.join(" · ")}</span>
    </button>
  );
}

/** The create panel shared by Deployments & Implementations — a small typed form
 *  that POSTs to the list endpoint, then opens the new record's detail. Mirrors
 *  New task / New cycle: create, then refine in the detail. */
export function RefCreate({
  noun,
  endpoint,
  fields,
  fixed,
  area,
  customFields = [],
  groupChoices = [],
  groupNoun = "group",
  authorEmail,
  onCreated,
  onCancel,
}: {
  readonly noun: string;
  readonly endpoint: string;
  readonly fields: readonly RefCreateField[];
  /** Values of the fields this deployment hides; submitted as they are. */
  readonly fixed?: Record<string, string | number>;
  /** The profile's OWN fields: after the built-in ones, validated as the API will, submitted under `custom`. */
  readonly area?: DomainArea;
  readonly customFields?: readonly CustomFieldSpec[];
  readonly groupChoices?: readonly { value: string; label: string }[];
  readonly groupNoun?: string;
  readonly authorEmail?: string;
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const initial = () =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.kind === "select" ? f.options[0]?.value ?? "" : f.kind === "group" ? groupChoices[0]?.value ?? NEW_GROUP : ""]),
    ) as Record<string, string>;
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [newGroup, setNewGroup] = useState("");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const missing = fields.find((f) => (f.kind === "text" || f.kind === "number" || f.kind === "customer") && f.required && !values[f.key]?.trim());

  const submit = async () => {
    if (missing) {
      setErr(`${missing.label} is required.`);
      return;
    }
    // The same check the API runs, field by field, so each sentence lands under its own field.
    const typed = Object.fromEntries(customFields.map((f) => [f.key, custom[f.key] ?? ""]));
    const checked = area && customFields.length ? validateCustom(area, typed, { mode: "create", fields: [...customFields] }) : null;
    if (area && checked && !checked.ok) {
      const found = Object.fromEntries(customFields.flatMap((f) => { const e = customFieldError(area, f, typed[f.key], "create"); return e ? [[f.key, e]] : []; }));
      setCustomErrors(found);
      setErr(Object.keys(found).length === 1 ? Object.values(found)[0] : "Some fields need another look. Each one says what is wrong.");
      return;
    }
    setCustomErrors({});
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { ...fixed, ...values, actor: authorEmail };
      for (const f of fields) {
        if (f.kind === "group") body[f.key] = values[f.key] === NEW_GROUP ? groupSlug(newGroup) : values[f.key];
        if (f.kind === "number" && values[f.key]?.trim()) body[f.key] = Number(values[f.key]);
      }
      for (const k of Object.keys(body)) if (body[k] === "") delete body[k];
      if (checked?.ok && Object.keys(checked.values).length) body.custom = checked.values;
      const res = await opsFetch<{ item: { id: string } }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      onCreated(res.item.id);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <PanelHeader eyebrow={`New ${noun}`}>
        <h3 className={cn(TYPE.title)}>New {noun}</h3>
      </PanelHeader>
      <div className="flex flex-col gap-4 px-5 py-4">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.help}>
            {f.kind === "group" ? (
              <>
                <OpsSelect value={values[f.key]} disabled={busy} onChange={(e) => set(f.key, e.target.value)}>
                  {groupChoices.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  <option value={NEW_GROUP}>New {groupNoun.toLowerCase()}…</option>
                </OpsSelect>
                {values[f.key] === NEW_GROUP ? (
                  <OpsInput value={newGroup} disabled={busy} placeholder={`Name the ${groupNoun.toLowerCase()}`} onChange={(e) => setNewGroup(e.target.value)} />
                ) : null}
              </>
            ) : f.kind === "customer" ? (
              <ReferenceSelect
                kind="customer"
                value={values[f.key] || null}
                disabled={busy}
                onChange={(ref) => set(f.key, ref?.id ?? "")}
              />
            ) : f.kind === "select" ? (
              <OpsSelect value={values[f.key]} disabled={busy} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </OpsSelect>
            ) : (
              <OpsInput
                value={values[f.key]}
                disabled={busy}
                type={f.kind === "number" ? "number" : undefined}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </Field>
        ))}
        {customFields.map((f) => (
          <CustomFieldControl
            key={f.key}
            field={f}
            value={custom[f.key] ?? ""}
            error={customErrors[f.key]}
            disabled={busy}
            onChange={(v) => {
              setCustom((p) => ({ ...p, [f.key]: v }));
              if (customErrors[f.key]) setCustomErrors(({ [f.key]: _fixed, ...rest }) => rest);
            }}
          />
        ))}
        {err ? <p role="alert" className={cn("text-red-400", TYPE.meta)}>{err}</p> : null}
        <div className="flex items-center gap-2 pt-1">
          <OpsButton intent="primary" size="sm" disabled={busy} onClick={submit}>
            Create {noun}
          </OpsButton>
          <OpsButton intent="secondary" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </OpsButton>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- board columns + helpers ------------------------ */

function healthDot(h: string): string {
  return h === "healthy" ? "bg-emerald-500" : h === "degraded" ? "bg-amber-500" : "bg-red-500";
}

const DEPLOY_COLUMNS: BoardColumn[] = [
  { key: "deployed", label: "Deployed", tone: "bg-emerald-500" },
  { key: "in-progress", label: "In progress", tone: "bg-amber-500" },
  { key: "pending-approval", label: "Pending approval", tone: "bg-sky-500" },
  { key: "rolled-back", label: "Rolled back", tone: "bg-muted-foreground/40" },
  { key: "failed", label: "Failed", tone: "bg-red-500" },
].map((c) => ({ ...c, label: DEP.display("releaseStatus", c.key, c.label) }));

// The full implementation pipeline (matches the customer-schema enum exactly),
// so every stage is a column even when empty — you can drag a rollout into any.
const IMPL_STAGES = [
  "Kickoff",
  "Discovery",
  "Configuration",
  "Integration",
  "UAT",
  "Pilot",
  "Go-Live",
  "Stabilization",
  "Steady State",
  "On Hold",
] as const;
const IMPL_COLUMNS: BoardColumn[] = IMPL_STAGES.map((s) => ({ key: s, label: IMP.display("implementationStage", s) }));

const CYCLE_COLUMNS: BoardColumn[] = [
  { key: "planning", label: "Planning", tone: "bg-muted-foreground/40" },
  { key: "active", label: "Active", tone: "bg-emerald-500" },
  { key: "closed", label: "Closed", tone: "bg-muted-foreground/30" },
];

/* ------------------------- reference details card ------------------------- */

type RefEdit = {
  key: string;
  label: string;
  value: string;
  /** Absent: the free-text input the card always had. The profile's fields say what they are. */
  kind?: "text" | "number" | "select" | "group";
  options?: readonly { value: string; label: string }[];
  help?: string;
  /** May be saved empty (an optional column). The built-in three never are. */
  clearable?: boolean;
};

/**
 * The editable details card behind a ticket/deployment/implementation row.
 * A few key fields write back to the system-of-record; the body is that
 * record's related TODOs — a plain list, or a timeline for deployments.
 */
function RefDetail({
  entity,
  eyebrow,
  entityId,
  slug,
  authorEmail,
  title,
  displayName,
  subtitle,
  edits,
  area,
  customFields = [],
  custom,
  onSave,
  staticFields,
  related,
  onAddSubtask,
  onToggleSubtask,
  onOpenTodo,
  busy,
}: {
  readonly entity: "deployment" | "implementation";
  /** What a person reads above the title; the entity type stays the identifier. */
  readonly eyebrow?: string;
  readonly entityId: string;
  readonly slug: string;
  readonly authorEmail?: string;
  /** The composed identity label — the editable title's placeholder / fallback. */
  readonly title: string;
  /** The current editable display name (null ⇒ show `title` as placeholder). */
  readonly displayName: string | null;
  readonly subtitle?: string;
  readonly edits: readonly RefEdit[];
  /** The profile's OWN fields, after the built-in ones. A change is saved as `{ custom: { key: value | null } }`. */
  readonly area?: DomainArea;
  readonly customFields?: readonly CustomFieldSpec[];
  readonly custom?: Record<string, string | number>;
  readonly onSave: (patch: Record<string, unknown>) => void;
  readonly staticFields: readonly { label: string; value: string }[];
  readonly related: readonly ApiTodo[];
  readonly onAddSubtask: (title: string) => void;
  readonly onToggleSubtask: (id: string, done: boolean) => void;
  readonly onOpenTodo: (id: string) => void;
  readonly busy: boolean;
}) {
  const ordered = [...related].sort(
    (a, b) => Date.parse(a.dueAt ?? a.createdAt) - Date.parse(b.dueAt ?? b.createdAt),
  );
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  // Saved on blur / on pick like the fields above it; a value the API would refuse is answered here, under the field.
  const commitCustom = (f: CustomFieldSpec, typed: string) => {
    const stored = custom?.[f.key];
    if (typed === (stored == null ? "" : String(stored))) return;
    const error = area ? customFieldError(area, f, typed, "update") : null;
    setCustomErrors(({ [f.key]: _old, ...rest }) => (error ? { ...rest, [f.key]: error } : rest));
    if (!error) onSave({ custom: { [f.key]: typed === "" ? null : typed } });
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <PanelHeader eyebrow={eyebrow ?? entity} slug={slug}>
        <input
          key={displayName ?? ""}
          defaultValue={displayName ?? ""}
          placeholder={title}
          className="w-full truncate bg-transparent font-semibold text-[15px] text-foreground leading-snug outline-none placeholder:text-muted-foreground/60"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (displayName ?? "")) onSave({ displayName: v });
          }}
        />
        {subtitle ? <p className={cn("mt-0.5 truncate text-muted-foreground", TYPE.meta)}>{subtitle}</p> : null}
      </PanelHeader>

      <div className="flex flex-col gap-5 px-5 py-4">
        <PanelSection label="Properties">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            {edits.map((e) => (
              <Field key={e.key} label={e.label} hint={e.help}>
                {e.kind === "select" && e.options ? (
                  <OpsSelect
                    key={e.value}
                    defaultValue={e.value}
                    disabled={busy}
                    onChange={(ev) => {
                      if (ev.target.value !== e.value) onSave({ [e.key]: ev.target.value });
                    }}
                  >
                    {e.value === "" || !e.options.some((o) => o.value === e.value) ? <option value={e.value}>{e.value || "—"}</option> : null}
                    {e.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </OpsSelect>
                ) : (
                  <OpsInput
                    key={e.value}
                    defaultValue={e.kind === "group" ? groupTitle(e.value) : e.value}
                    type={e.kind === "number" ? "number" : undefined}
                    disabled={busy}
                    onBlur={(ev) => {
                      const typed = ev.target.value.trim();
                      const v = e.kind === "group" ? groupSlug(typed) : typed;
                      if ((v || e.clearable) && v !== e.value) onSave({ [e.key]: v });
                    }}
                  />
                )}
              </Field>
            ))}
            {customFields.map((f) => (
              <CustomFieldControl
                key={f.key}
                field={f}
                value={custom?.[f.key] == null ? "" : String(custom[f.key])}
                error={customErrors[f.key]}
                disabled={busy}
                onCommit={(v) => commitCustom(f, v)}
              />
            ))}
          </div>
        </PanelSection>

        {staticFields.length > 0 ? (
          <div className={cn(SURFACE.inset, "flex flex-col gap-1.5 p-3")}>
            {staticFields.map((f) => (
              <div key={f.label} className="flex items-center justify-between gap-4">
                <span className={cn("text-muted-foreground", TYPE.micro)}>{f.label}</span>
                <span className={cn("truncate text-right", TYPE.meta)}>{f.value || "—"}</span>
              </div>
            ))}
          </div>
        ) : null}

        <SubtaskList
          items={ordered}
          busy={busy}
          onToggle={onToggleSubtask}
          onAdd={onAddSubtask}
          onOpen={onOpenTodo}
        />
      </div>

      <div className="flex flex-col gap-4 border-border/60 border-t px-5 py-4">
        <ActivityFeed entity={entity} id={entityId} />
        <CommentThread entity={entity} id={entityId} label={title} authorEmail={authorEmail} />
      </div>
    </div>
  );
}

/* ------------------------------- todo detail ------------------------------ */

const CONTAINER_KINDS = [
  { value: "", label: "— none —" },
  { value: "deployment", label: DEP.singular },
  { value: "implementation", label: IMP.singular },
];
const LINK_KINDS = [
  { value: "", label: "— none —" },
  { value: "ticket", label: "Ticket" },
  { value: "customer", label: ACCOUNT_LABEL },
  { value: "app", label: "App" },
  { value: "cron", label: "Cron" },
  { value: "workflow", label: "Workflow" },
];

function TodoDetail({
  todo,
  cycles,
  busy,
  authorEmail,
  slug,
  onPatch,
  subtasks,
  onAddSubtask,
  onToggleSubtask,
  onOpenSubtask,
}: {
  readonly todo: ApiTodo;
  readonly cycles: ApiCycle[];
  readonly busy: boolean;
  readonly authorEmail?: string;
  readonly slug: string;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly subtasks: readonly ApiTodo[];
  readonly onAddSubtask: (title: string) => void;
  readonly onToggleSubtask: (id: string, done: boolean) => void;
  readonly onOpenSubtask: (id: string) => void;
}) {
  const priorityTone =
    todo.priority === "high" ? "bg-red-500" : todo.priority === "low" ? "bg-muted-foreground/50" : "bg-indigo-500";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* Header — an eyebrow + the title as a borderless, document-style input
          (the create panel opens here too, so "New task" is editable in place). */}
      <PanelHeader eyebrow="Task" eyebrowDot={priorityTone} slug={slug}>
        <input
          defaultValue={todo.title}
          placeholder="Untitled task"
          className="w-full bg-transparent font-semibold text-[15px] text-foreground leading-snug outline-none placeholder:text-muted-foreground/40"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== todo.title) onPatch({ title: v });
          }}
        />
      </PanelHeader>

      <div className="flex flex-col gap-5 px-5 py-4">
        <Field label="Notes">
          <OpsTextarea
            rows={3}
            defaultValue={todo.notes ?? ""}
            placeholder="Any detail…"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (todo.notes ?? "")) onPatch({ notes: v || null });
            }}
          />
        </Field>

        <PanelSection label="Properties">
          {/* Even 2-col grid — no orphaned field (Due used to sit alone). */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field label="Status">
              <OpsSelect value={todo.status} disabled={busy} onChange={(e) => onPatch({ status: e.target.value })}>
                {TASK_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </OpsSelect>
            </Field>
            <Field label="Priority">
              <OpsSelect value={todo.priority} disabled={busy} onChange={(e) => onPatch({ priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </OpsSelect>
            </Field>
            <Field label="Due">
              <OpsInput
                type="date"
                defaultValue={todo.dueAt ? todo.dueAt.slice(0, 10) : ""}
                onChange={(e) =>
                  onPatch({ dueAt: e.target.value ? new Date(`${e.target.value}T09:00:00Z`).toISOString() : null })
                }
              />
            </Field>
            <Field label="Assignee" hint="Blank = the creator.">
              <OpsInput
                defaultValue={todo.assignee ?? ""}
                placeholder="name@company.com"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (todo.assignee ?? "")) onPatch({ assignee: v || null });
                }}
              />
            </Field>
            <div className="col-span-2">
              <Field label="Cycle">
                <OpsSelect
                  value={todo.cycleId ?? ""}
                  disabled={busy}
                  onChange={(e) => onPatch({ cycleId: e.target.value || null })}
                >
                  <option value="">Backlog (no cycle)</option>
                  {cycles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </OpsSelect>
              </Field>
            </div>
          </div>
        </PanelSection>

        <PanelSection label="Links">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field label="Filed under (epic)">
              <div className="flex flex-col gap-1.5">
                <OpsSelect
                  value={todo.containerType ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const ct = e.target.value;
                    if (!ct) onPatch({ containerType: null, containerId: null, containerLabel: null });
                    else onPatch({ containerType: ct, containerId: null, containerLabel: null });
                  }}
                >
                  {CONTAINER_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </OpsSelect>
                {todo.containerType ? (
                  <ReferenceSelect
                    kind={todo.containerType as RefKind}
                    value={todo.containerId}
                    disabled={busy}
                    onChange={(ref) =>
                      onPatch({
                        containerType: todo.containerType,
                        containerId: ref?.id ?? null,
                        containerLabel: ref?.label ?? null,
                      })
                    }
                  />
                ) : null}
              </div>
            </Field>

            <Field label="Linked to">
              <div className="flex flex-col gap-1.5">
                <OpsSelect
                  value={todo.linkType ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const lt = e.target.value;
                    if (!lt) onPatch({ linkType: null, linkId: null, linkLabel: null });
                    else onPatch({ linkType: lt, linkId: null, linkLabel: null });
                  }}
                >
                  {LINK_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </OpsSelect>
                {todo.linkType && todo.linkType !== "chat" ? (
                  <ReferenceSelect
                    kind={todo.linkType as RefKind}
                    value={todo.linkId}
                    disabled={busy}
                    onChange={(ref) =>
                      onPatch({ linkType: todo.linkType, linkId: ref?.id ?? null, linkLabel: ref?.label ?? null })
                    }
                  />
                ) : null}
              </div>
            </Field>
          </div>
        </PanelSection>

        <SubtaskList
          items={subtasks}
          busy={busy}
          onToggle={onToggleSubtask}
          onAdd={onAddSubtask}
          onOpen={onOpenSubtask}
        />
      </div>

      {/* Activity + Comments render their own section headers. */}
      <div className="flex flex-col gap-4 border-border/60 border-t px-5 py-4">
        <ActivityFeed entity="task" id={todo.id} refreshKey={todo.updatedAt} />
        <CommentThread entity="task" id={todo.id} label={todo.title} authorEmail={authorEmail} />
      </div>
    </div>
  );
}

/* ------------------------- shared panel chrome ---------------------------- */

/** The detail/create panel header: a small eyebrow (with an optional status
 *  dot) over the title. Shared by every tab's detail panel so they read as one
 *  family. Sits above the SidePanel's absolute close button (pr-12 clears it). */
/** A short numeric reference slug, e.g. "TS-001", "DP-002". */
function seqSlug(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

/** Map each item's id → its 1-based sequence number, ordered by a stable key
 *  (creation order). Powers the numeric slugs so every entity has a short,
 *  human-readable reference (TS-001 …). Derived, not stored — numbers reflect
 *  current creation order, so a hard-deleted item's number is reused by the next. */
function buildSeqMap<T>(
  items: readonly T[],
  keyOf: (t: T) => string,
  orderBy: (t: T) => string | number,
): Map<string, number> {
  const m = new Map<string, number>();
  [...items]
    .sort((a, b) => {
      const av = orderBy(a);
      const bv = orderBy(b);
      return typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    })
    .forEach((t, i) => m.set(keyOf(t), i + 1));
  return m;
}

/** The slug as plain, copyable monospace text (no badge chrome). */
function SlugText({ slug }: { readonly slug: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy slug"
      onClick={() => {
        void navigator.clipboard?.writeText(slug).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "max-w-full truncate font-mono text-muted-foreground transition-colors hover:text-foreground",
        TYPE.micro,
      )}
    >
      {copied ? "copied" : slug}
    </button>
  );
}

function PanelHeader({
  eyebrow,
  eyebrowDot,
  slug,
  children,
}: {
  readonly eyebrow: string;
  readonly eyebrowDot?: string;
  /** A short reference slug — when present it IS the eyebrow (plain copyable
   *  text), replacing the type label. */
  readonly slug?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-border/60 border-b px-5 py-4 pr-12">
      <span className="flex min-w-0 items-center gap-1.5">
        {eyebrowDot ? <span className={cn("size-1.5 shrink-0 rounded-full", eyebrowDot)} /> : null}
        {slug ? (
          <SlugText slug={slug} />
        ) : (
          <span className={cn("font-medium text-muted-foreground/60 uppercase tracking-wide", TYPE.micro)}>
            {eyebrow}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

/** A labelled block within a detail panel — an uppercase section label over its
 *  fields. Keeps Properties / Links / etc. visually grouped and consistent. */
function PanelSection({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <span className={cn("font-medium text-muted-foreground/50 uppercase tracking-wide", TYPE.micro)}>{label}</span>
      {children}
    </section>
  );
}

// The export's Markdown and JSON (Copy as …) are built by lib/record-export.ts: keys and code values in the profile's
// words, data verbatim. GET /api/ops/export itself stays raw.

/** The "…" overflow that sits in the SidePanel's action slot (left of the ✕):
 *  Share (copy deep-link), Copy as JSON / Markdown, and a destructive Delete.
 *  Shared by every detail panel. */
function PanelActionsMenu({
  shareView,
  shareId,
  onDelete,
  deleteLabel,
  exportType,
  exportId,
  exportCustomerId,
  copyTitle,
}: {
  readonly shareView: "tasks" | "sprints" | "deployments" | "implementations";
  readonly shareId: string;
  readonly onDelete: () => void;
  readonly deleteLabel: string;
  /** The entity to export (Copy as JSON / Markdown) — resolved server-side into
   *  the full picture (pointers + data-room context). Omit for no export. */
  readonly exportType?: "task" | "deployment" | "implementation";
  readonly exportId?: string;
  readonly exportCustomerId?: string | null;
  readonly copyTitle?: string;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const copy = (text: string, note: string) => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard?.writeText(text).then(() => {
      setFlash(note);
      setTimeout(() => setFlash(null), 1500);
    });
  };
  const share = () => {
    if (typeof window === "undefined") return;
    copy(`${window.location.origin}/?ops=todos&view=${shareView}&id=${encodeURIComponent(shareId)}`, "link");
  };
  // Fetch the enriched bundle (record + resolved pointers + data-room context)
  // then copy it as JSON or Markdown. The thin DB row alone would omit the
  // linked deployment/implementation record and the customer's context files.
  const copyExport = async (fmt: "json" | "md") => {
    if (!exportType || !exportId || copyBusy) return;
    setCopyBusy(true);
    setFlash(fmt === "json" ? "json…" : "md…");
    try {
      const qs = new URLSearchParams({ type: exportType, id: exportId });
      if (exportCustomerId) qs.set("customerId", exportCustomerId);
      const bundle = await opsFetch<ExportBundle>(`/api/ops/export?${qs.toString()}`);
      const text = fmt === "json" ? exportJson(bundle) : bundleToMarkdown(copyTitle ?? "Record", bundle);
      copy(text, fmt);
    } catch {
      setFlash(null);
    } finally {
      setCopyBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label="More actions" title="More actions">
          <MoreHorizontalIcon className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); share(); }} className="gap-2">
          <Share2Icon className="size-3.5" />
          {flash === "link" ? "Link copied" : "Share link"}
        </DropdownMenuItem>
        {exportType ? (
          <>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void copyExport("json");
              }}
              className="gap-2"
            >
              <BracesIcon className="size-3.5" />
              {flash === "json" ? "JSON copied" : flash === "json…" ? "Copying…" : "Copy as JSON"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void copyExport("md");
              }}
              className="gap-2"
            >
              <FileTextIcon className="size-3.5" />
              {flash === "md" ? "Markdown copied" : flash === "md…" ? "Copying…" : "Copy as Markdown"}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="gap-2 text-red-400">
          <Trash2Icon className="size-3.5" />
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A checklist of child todos (subtasks) — toggle done, click to open, and an
 *  inline "add" row. Shared by every detail panel; each supplies where the
 *  children come from and what adding one means. */
function SubtaskList({
  items,
  onToggle,
  onAdd,
  onOpen,
  busy,
}: {
  readonly items: readonly ApiTodo[];
  readonly onToggle: (id: string, done: boolean) => void;
  readonly onAdd: (title: string) => void;
  readonly onOpen: (id: string) => void;
  readonly busy?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const done = items.filter((t) => t.done).length;
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  return (
    <PanelSection label={`Subtasks · ${done}/${items.length}`}>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {items.map((t) => (
            <li key={t.id} className="group/st flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggle(t.id, !t.done)}
                title={t.done ? "Mark open" : "Mark done"}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                {t.done ? (
                  <CheckIcon className="size-4 text-emerald-500" />
                ) : (
                  <CircleIcon className="size-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                className={cn(
                  "min-w-0 flex-1 truncate py-0.5 text-left hover:text-foreground",
                  TYPE.body,
                  t.done ? "text-muted-foreground/60 line-through" : "text-foreground/90",
                )}
              >
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-1.5 rounded-md border border-border/50 px-2 py-1.5 focus-within:border-border">
        <PlusIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
        <input
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add subtask…"
          className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40", TYPE.body)}
        />
      </div>
    </PanelSection>
  );
}

/* ------------------------------- cycles ----------------------------------- */

const CYCLE_SORTS = [
  { value: "created", label: "Newest" },
  { value: "starts", label: "Start date" },
  { value: "name", label: "Name" },
] as const;

function fmtRange(s: string | null, e: string | null): string {
  const f = (d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (s && e) return `${f(s)} – ${f(e)}`;
  if (e) return `ends ${f(e)}`;
  if (s) return `from ${f(s)}`;
  return "no dates";
}

/** One sprint as a clickable read-first card matching the other tabs: title,
 *  the sprint lead avatar, an icon metadata line, the goal, and the burndown.
 *  Clicking opens the detail panel, where lead / dates / state / lifecycle
 *  actions are edited (same click-through model as Deployments & Implementations). */
export function CycleCard({
  cycle: c,
  stats: s,
  selected,
  onClick,
}: {
  readonly cycle: ApiCycle;
  readonly stats: { total: number; done: number; committed: number; doneDates: string[] };
  readonly selected?: boolean;
  readonly onClick?: () => void;
}) {
  const daysLeft = c.endsAt ? Math.round((Date.parse(c.endsAt) - Date.now()) / 86_400_000) : null;
  return (
    <WorkspaceCard
      title={c.name}
      selected={selected}
      onClick={onClick}
      headerRight={
        c.lead ? (
          <span title={`Sprint lead · ${c.lead}`}>
            <CustomerMark name={c.lead} size="sm" />
          </span>
        ) : undefined
      }
    >
      <MetaLine
        items={[
          { icon: CalendarIcon, node: fmtRange(c.startsAt, c.endsAt) },
          ...(daysLeft != null
            ? [{ icon: ClockIcon, node: daysLeft < 0 ? `${-daysLeft}d over` : `${daysLeft}d left`, danger: daysLeft < 0 }]
            : []),
          { node: <span className="tabular-nums">{`${s.done}/${s.committed} done`}</span> },
        ]}
      />
      {c.goal ? <p className="text-muted-foreground text-xs">{c.goal}</p> : null}
      <Burndown startsAt={c.startsAt} endsAt={c.endsAt} committed={s.committed} doneDates={s.doneDates} height={150} />
    </WorkspaceCard>
  );
}

/** The sprint detail/create panel — the click-through for a cycle card, and
 *  where a just-created sprint opens. Mirrors TodoDetail: an eyebrow + editable
 *  name, a Properties grid, the burndown, the sprint's tasks, then Activity and
 *  Comments, with roll-over / archive in the footer. */
function CycleDetail({
  cycle: c,
  stats: s,
  roster,
  busy,
  authorEmail,
  tasks,
  slug,
  onPatch,
  onRollover,
  onOpenTodo,
  onAddSubtask,
  onToggleSubtask,
}: {
  readonly cycle: ApiCycle;
  readonly stats: { total: number; done: number; committed: number; doneDates: string[] };
  readonly roster: readonly ApiRosterMember[];
  readonly busy: boolean;
  readonly authorEmail?: string;
  readonly tasks: readonly ApiTodo[];
  readonly slug: string;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly onRollover: () => void;
  readonly onOpenTodo: (id: string) => void;
  readonly onAddSubtask: (title: string) => void;
  readonly onToggleSubtask: (id: string, done: boolean) => void;
}) {
  const stateDot =
    c.state === "active" ? "bg-emerald-500" : c.state === "closed" ? "bg-muted-foreground/50" : "bg-indigo-500";
  const ordered = [...tasks].sort(
    (a, b) => Date.parse(a.dueAt ?? a.createdAt) - Date.parse(b.dueAt ?? b.createdAt),
  );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <PanelHeader eyebrow="Sprint" eyebrowDot={stateDot} slug={slug}>
        <input
          defaultValue={c.name}
          placeholder="Untitled sprint"
          className="w-full bg-transparent font-semibold text-[15px] text-foreground leading-snug outline-none placeholder:text-muted-foreground/40"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== c.name) onPatch({ name: v });
          }}
        />
      </PanelHeader>

      <div className="flex flex-col gap-5 px-5 py-4">
        <PanelSection label="Properties">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field label="State">
              <OpsSelect value={c.state} disabled={busy} onChange={(e) => onPatch({ state: e.target.value })}>
                <option value="planning">Planning</option>
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </OpsSelect>
            </Field>
            <Field label="Sprint lead">
              <OpsSelect
                value={c.lead ?? ""}
                disabled={busy}
                onChange={(e) => onPatch({ lead: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {roster.map((r) => (
                  <option key={r.email} value={r.email}>
                    {r.name ?? r.email.split("@")[0]}
                  </option>
                ))}
              </OpsSelect>
            </Field>
            <Field label="Starts">
              <OpsInput
                type="date"
                defaultValue={c.startsAt ? c.startsAt.slice(0, 10) : ""}
                onChange={(e) =>
                  onPatch({ startsAt: e.target.value ? new Date(`${e.target.value}T09:00:00Z`).toISOString() : null })
                }
              />
            </Field>
            <Field label="Ends">
              <OpsInput
                type="date"
                defaultValue={c.endsAt ? c.endsAt.slice(0, 10) : ""}
                onChange={(e) =>
                  onPatch({ endsAt: e.target.value ? new Date(`${e.target.value}T09:00:00Z`).toISOString() : null })
                }
              />
            </Field>
            <Field label="Capacity" hint="Committed task count.">
              <OpsInput
                type="number"
                min={0}
                defaultValue={c.capacity ?? ""}
                placeholder="—"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  const n = v ? Number(v) : null;
                  if (n !== (c.capacity ?? null)) onPatch({ capacity: Number.isFinite(n) ? n : null });
                }}
              />
            </Field>
          </div>
          <Field label="Goal">
            <OpsTextarea
              rows={2}
              defaultValue={c.goal ?? ""}
              placeholder="What this sprint is trying to achieve…"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (c.goal ?? "")) onPatch({ goal: v || null });
              }}
            />
          </Field>
        </PanelSection>

        <PanelSection label="Burndown">
          <Burndown startsAt={c.startsAt} endsAt={c.endsAt} committed={s.committed} doneDates={s.doneDates} height={150} />
        </PanelSection>

        <SubtaskList
          items={ordered}
          busy={busy}
          onToggle={onToggleSubtask}
          onAdd={onAddSubtask}
          onOpen={onOpenTodo}
        />
      </div>

      <div className="flex flex-col gap-4 border-border/60 border-t px-5 py-4">
        <ActivityFeed entity="cycle" id={c.id} refreshKey={c.updatedAt} />
        <CommentThread entity="cycle" id={c.id} label={c.name} authorEmail={authorEmail} />
      </div>

      <div className="mt-auto flex items-center gap-4 border-border/60 border-t px-5 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={onRollover}
          className={cn("text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50", TYPE.meta)}
        >
          Roll over unfinished
        </button>
      </div>
    </div>
  );
}

/** Sprint cards with a burndown, opening a detail/create panel per cycle. */
function CyclesManager({
  cycles,
  todos,
  authorEmail,
  onChanged,
  onClose,
  onOpenTodo,
}: {
  readonly cycles: ApiCycle[];
  readonly todos: ApiTodo[];
  readonly authorEmail?: string;
  readonly onChanged: () => void | Promise<void>;
  readonly onClose: () => void;
  /** Jump to a task in the Tasks tab (from the sprint's task list). */
  readonly onOpenTodo: (id: string) => void;
}) {
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>("created");
  const [cycleView, setCycleView] = useState<ViewMode>("kanban");
  const { items: rosterItems } = useOpsList<ApiRosterMember>("/api/ops/roster");
  const roster = rosterItems ?? [];
  const { scopes, setScopes, inScope } = useScope(authorEmail, ["me"]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // "New cycle" creates a blank sprint and opens its detail panel — the same
  // create-then-edit flow as New task (no separate inline form).
  const create = () =>
    void run(async () => {
      const res = await opsFetch<{ item: { id: string } }>("/api/ops/cycles", {
        method: "POST",
        body: JSON.stringify({ name: "New sprint", createdBy: authorEmail ?? "web" }),
      });
      setSelectedCycleId(res.item.id);
    });
  const patchCycle = (id: string, body: Record<string, unknown>) =>
    run(() => opsFetch(`/api/ops/cycles/${id}`, { method: "PATCH", body: JSON.stringify({ ...body, actor: authorEmail }) }));
  const archive = (id: string) =>
    run(() => opsFetch(`/api/ops/cycles/${id}`, { method: "DELETE" }));
  const rollover = (id: string) =>
    run(() =>
      opsFetch(`/api/ops/cycles/${id}/rollover`, {
        method: "POST",
        body: JSON.stringify({ target: null, actor: authorEmail }),
      }),
    );
  // Subtask helpers for the sprint panel: a sprint's subtasks are the todos
  // filed into its cycle.
  const addTaskToCycle = (cycleId: string, title: string) =>
    run(() =>
      opsFetch("/api/ops/todos", {
        method: "POST",
        body: JSON.stringify({ title, cycleId, createdBy: authorEmail ?? "web" }),
      }),
    );
  const patchTodoStatus = (id: string, done: boolean) =>
    run(() =>
      opsFetch(`/api/ops/todos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: done ? "done" : "open", actor: authorEmail }),
      }),
    );

  const statsFor = (c: ApiCycle) => {
    const tasks = todos.filter((t) => t.cycleId === c.id);
    const doneTasks = tasks.filter((t) => t.done);
    return {
      total: tasks.length,
      done: doneTasks.length,
      committed: c.capacity ?? tasks.length,
      doneDates: doneTasks.map((t) => t.doneAt).filter((d): d is string => Boolean(d)),
    };
  };

  const query = q.trim().toLowerCase();
  const shown = [...cycles]
    .filter((c) => inScope(c.lead ?? c.createdBy) && (!query || c.name.toLowerCase().includes(query)))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "starts") {
        const av = a.startsAt ? Date.parse(a.startsAt) : Infinity;
        const bv = b.startsAt ? Date.parse(b.startsAt) : Infinity;
        return av - bv;
      }
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });

  const selectedCycle = selectedCycleId ? (cycles.find((c) => c.id === selectedCycleId) ?? null) : null;
  const cycleSeq = useMemo(
    () => buildSeqMap(cycles, (c) => c.id, (c) => Date.parse(c.createdAt)),
    [cycles],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabToolbar
        noun="cycle"
        q={q}
        setQ={setQ}
        onCreate={create}
        createLabel="New cycle"
        sort={sort}
        setSort={setSort}
        sortOptions={CYCLE_SORTS}
        onClose={onClose}
        viewSwitcher={<ViewSwitcher view={cycleView} setView={setCycleView} />}
        filter={<FilterMenu groups={[{ label: "Scope", selected: scopes, onChange: setScopes, options: SCOPE_OPTIONS }]} />}
      />

      {err ? <p className={cn("px-4 pt-2 text-red-400", TYPE.meta)}>{err}</p> : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shown.length === 0 ? (
            <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>
              {query ? "No cycles match." : "No cycles yet — hit New cycle."}
            </p>
          ) : (
            <WorkspaceViews
              view={cycleView}
              config={{
                items: shown,
                selectedId: selectedCycleId,
                onSelect: setSelectedCycleId,
                renderCard: (c) => (
                  <CycleCard
                    cycle={c}
                    stats={statsFor(c)}
                    selected={selectedCycleId === c.id}
                    onClick={() => setSelectedCycleId(c.id)}
                  />
                ),
                kanban: {
                  columns: CYCLE_COLUMNS,
                  columnOf: (c) => c.state,
                  onMove: (c, state) => void patchCycle(c.id, { state }),
                },
                table: [
                  { key: "name", label: "Sprint", render: (c) => <span className="font-medium">{c.name}</span> },
                  { key: "state", label: "State", render: (c) => <span className="capitalize">{c.state}</span> },
                  { key: "dates", label: "Dates", render: (c) => fmtRange(c.startsAt, c.endsAt) },
                  { key: "done", label: "Done", render: (c) => `${statsFor(c).done}/${statsFor(c).committed}` },
                ],
                timeline: {
                  rangeOf: (c) => ({ start: c.startsAt, end: c.endsAt }),
                  labelOf: (c) => c.name,
                  toneOf: (c) => (c.state === "active" ? "bg-emerald-500/70" : c.state === "closed" ? "bg-muted-foreground/40" : "bg-indigo-500/70"),
                },
              }}
            />
          )}
        </div>
        {selectedCycle ? (
          <SidePanel
            onClose={() => setSelectedCycleId(null)}
            actions={
              <PanelActionsMenu
                shareView="sprints"
                shareId={selectedCycle.id}
                deleteLabel="Delete sprint"
                onDelete={() => {
                  void archive(selectedCycle.id);
                  setSelectedCycleId(null);
                }}
              />
            }
          >
            <CycleDetail
              cycle={selectedCycle}
              stats={statsFor(selectedCycle)}
              roster={roster}
              busy={busy}
              authorEmail={authorEmail}
              tasks={todos.filter((t) => t.cycleId === selectedCycle.id)}
              slug={seqSlug("SP", cycleSeq.get(selectedCycle.id) ?? 0)}
              onPatch={(body) => void patchCycle(selectedCycle.id, body)}
              onRollover={() => void rollover(selectedCycle.id)}
              onOpenTodo={onOpenTodo}
              onAddSubtask={(title) => void addTaskToCycle(selectedCycle.id, title)}
              onToggleSubtask={(id, done) => void patchTodoStatus(id, done)}
            />
          </SidePanel>
        ) : null}
      </div>
    </div>
  );
}
