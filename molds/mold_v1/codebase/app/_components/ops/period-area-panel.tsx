"use client";

/**
 * THE PERIODS DRAWN FROM THEIR DEFINITION (records.areas.periods stated in the record-area form, compiled with
 * `declared: true`; agent/lib/period-area.ts): a pack's bounded container, a "Regulatory filing" say, shown as its
 * definition says. The list as a table, a board by state, a timeline or a month calendar on one date field (the views
 * it declares); its filters and sorts; its metrics; the detail with its lifecycle moves, its sections and own fields;
 * the records it CONTAINS (relations.contains, #185) listed under it with how many are done; its activity and comments.
 *
 * Every write goes to the cycles routes, which check it with the one validator (agent/lib/period-area-store.ts); the
 * create form runs the same check first, so each sentence lands under its field. Who may (#180) shapes what is offered
 * (./record-access.ts); a move whose transition needs a comment asks for one; a strict lifecycle's forbidden moves are
 * greyed out with the reason (./task-area-model.ts clientMove).
 *
 * Built from the pieces the other record areas use: RecordFieldControl (./task-area.tsx), WorkspaceViews, the metrics
 * strip, the warnings toast and the reason dialog (./task-area-parts.tsx), and todos-panel's chrome (toolbar, filter
 * menu, panel header and sections), passed in so the tab looks like every other one.
 *
 * A profile that does not declare the area never mounts this: its period view is today's (./todos-panel.tsx).
 */
import { useCallback, useMemo, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceCard } from "./cards";
import { WorkspaceViews, type ViewMode } from "./workspace-views";
import { errMessage, opsFetch, type ApiCycle, type ApiTodo } from "./lib";
import { OpsButton, SidePanel } from "./primitives";
import { TYPE } from "./tokens";
import { RecordFieldControl } from "./task-area";
import { ActivityFeed, CommentThread } from "./entity-detail";
import { RecordWorkflowSection } from "./record-workflow";
import { areaRunsWorkflow } from "@/lib/record-workflow-view";
import { TONE_CLASS, areaView, type AreaRow, type RecordAreas, type RecordField, type RecordRole } from "@/agent/lib/record-areas";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import { preparePeriodWrite } from "@/agent/lib/period-area";
import { useRecordAccess } from "./record-access";
import { clientMove, writeNotes, type TaskReadContext } from "./task-area-model";
import { MoveReasonDialog, TaskMetricStrip, TaskWarningsToast, type PendingMove } from "./task-area-parts";
import type { RecordAreaChrome } from "./record-area-panel";
import { byDay, completionOf, DEFAULT_LABEL, filterPeriods, monthGrid, periodAreaRow, periodAreaUi, periodMetrics, sortPeriods, type PeriodAreaUi, type PeriodViewMode } from "./period-area-model";

type FormValue = string | string[] | boolean;
const blankForm = (x: FormValue) => (Array.isArray(x) ? x.length === 0 : typeof x === "string" ? x.trim() === "" : false);
const isList = (f: RecordField) => f.type === "multi_pick" || f.type === "tags" || (Boolean(f.many) && ["person", "record", "file"].includes(f.type));
/** A stored value as the form holds it: a date field reads its day, a list stays a list. */
function formValueOf(f: RecordField, x: unknown): FormValue {
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "boolean") return x;
  if (x === null || x === undefined) return f.type === "boolean" ? false : isList(f) ? [] : "";
  const s = String(x);
  if (f.type === "date" && /^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  if (f.type === "datetime" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  return s;
}
/** A form value as a write sends it: a day as that day, a local date-time as an instant, a number's text, a list. */
function writeValueOf(f: RecordField, x: FormValue): unknown {
  if (blankForm(x)) return null;
  if (typeof x === "string" && f.type === "datetime" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x)) return new Date(`${x}:00Z`).toISOString();
  if (typeof x === "string" && ["integer", "number", "percent", "money"].includes(f.type)) return x.trim();
  return x;
}
/** The body that changes one field: a column by key, an own field under `custom`. */
const fieldBody = (f: RecordField, value: unknown): Record<string, unknown> => (f.column ? { [f.key]: value } : { custom: { [f.key]: value } });
const shortDate = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? new Date(`${x.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null);

/** One cell / card line: a field's value as the definition shows it (a choice with its tone, a person by name). */
function FieldValue({ ui, row, keyName }: { readonly ui: PeriodAreaUi; readonly row: AreaRow; readonly keyName: string }) {
  const v = ui.view;
  const f = v.field(keyName);
  const raw = keyName === ui.lifecycle?.field ? ui.stateOf(row) : v.get(row, keyName);
  if (!f) return <span className="text-muted-foreground/50">—</span>;
  if ((f.type === "date" || f.type === "datetime") && typeof raw === "string") return <span className="tabular-nums">{shortDate(raw) ?? raw}</span>;
  const text = v.display(keyName, raw);
  if (!text) return <span className="text-muted-foreground/50">—</span>;
  const tone = f.type === "pick_list" ? v.tone(keyName, raw) : undefined;
  if (tone) {
    return (
      <span className="inline-flex items-center gap-1.5" data-tone={tone}>
        <span className={cn("size-1.5 rounded-full", TONE_CLASS[tone])} />
        {text}
      </span>
    );
  }
  if (f.type === "person" || f.type === "email") return <>{Array.isArray(raw) ? raw.map((x) => String(x).split("@")[0]).join(", ") : text.split("@")[0]}</>;
  if (["integer", "number", "percent", "money"].includes(f.type)) return <span className="tabular-nums">{text}</span>;
  return <>{text}</>;
}

/** The view switch, offering only the views the definition lists. */
function Modes({ modes, mode, setMode }: { readonly modes: readonly PeriodViewMode[]; readonly mode: PeriodViewMode; readonly setMode: (m: PeriodViewMode) => void }) {
  if (modes.length < 2) return null;
  const label: Record<PeriodViewMode, string> = { kanban: "Board", table: "Table", timeline: "Timeline", calendar: "Calendar" };
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 p-0.5" data-testid="period-modes">
      {modes.map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)} className={cn("rounded-md px-2 py-1 text-xs transition-colors", mode === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {label[m]}
        </button>
      ))}
    </div>
  );
}

/** A month of days, each period placed on the day its calendar date falls (Monday first), with a month switch. */
function CalendarView({ ui, rows, selectedId, onSelect, now }: { readonly ui: PeriodAreaUi; readonly rows: readonly (AreaRow & { id: string })[]; readonly selectedId: string | null; readonly onSelect: (id: string) => void; readonly now: number }) {
  const dated = useMemo(() => byDay(ui, rows), [ui, rows]);
  // Opens on this month, or on the month of the first dated period when none falls in this one.
  const [cursor, setCursor] = useState(() => {
    const d = new Date(now);
    const thisMonth = `${d.toISOString().slice(0, 7)}`;
    const first = [...dated.keys()].sort().find((k) => k.startsWith(thisMonth)) ?? [...dated.keys()].sort()[0];
    const at = first ? new Date(`${first}T00:00:00Z`) : d;
    return { y: at.getUTCFullYear(), m: at.getUTCMonth() };
  });
  const weeks = monthGrid(cursor.y, cursor.m);
  const title = new Date(Date.UTC(cursor.y, cursor.m, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const shift = (n: number) => setCursor((c) => ({ y: c.y + Math.floor((c.m + n) / 12), m: (((c.m + n) % 12) + 12) % 12 }));
  const today = new Date(now).toISOString().slice(0, 10);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="period-calendar">
      <div className="mb-3 flex items-center gap-2">
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className={cn("min-w-36 text-center font-medium text-foreground", TYPE.body)} data-testid="calendar-month">
          {title}
        </span>
        <button type="button" aria-label="Next month" onClick={() => shift(1)} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-4" />
        </button>
        <span className={cn("ml-2 text-muted-foreground", TYPE.micro)}>{ui.view.label(ui.calendarDate, DEFAULT_LABEL[ui.calendarDate])}</span>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border/60 bg-border/40">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className={cn("bg-background px-2 py-1 text-muted-foreground/70 uppercase", TYPE.micro)}>
            {d}
          </div>
        ))}
        {weeks.flat().map((day, i) => (
          <div key={day ?? `pad-${i}`} data-day={day ?? undefined} className={cn("min-h-20 bg-background p-1.5", !day && "bg-muted/10")}>
            {day ? (
              <>
                <span className={cn("tabular-nums", TYPE.micro, day === today ? "font-semibold text-foreground" : "text-muted-foreground/70")}>{Number(day.slice(8))}</span>
                <div className="mt-1 flex flex-col gap-1">
                  {((dated.get(day) ?? []) as (AreaRow & { id: string })[]).map((r) => {
                    const tone = ui.view.tone("state", ui.stateOf(r));
                    return (
                      <button
                        key={r.id}
                        type="button"
                        data-testid="calendar-item"
                        onClick={() => onSelect(r.id)}
                        className={cn("flex items-center gap-1 truncate rounded px-1 py-0.5 text-left hover:bg-muted/40", TYPE.micro, selectedId === r.id ? "bg-muted/60 text-foreground" : "text-foreground/80")}
                      >
                        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone ?? "muted"])} />
                        <span className="truncate">{String(r.name ?? "")}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PeriodAreaPanel({
  areas = RECORD_AREAS,
  cycles,
  todos,
  authorEmail,
  role,
  chrome,
  onChanged,
  onClose,
  onOpenTodo,
  onAddTask,
  onToggleTask,
  renderActions,
}: {
  readonly areas?: RecordAreas;
  readonly cycles: readonly ApiCycle[];
  /** Every task in hand: the ones filed into a period (cycleId) are its contained records. */
  readonly todos: readonly ApiTodo[];
  readonly authorEmail?: string;
  readonly role?: RecordRole;
  readonly chrome: RecordAreaChrome;
  readonly onChanged: () => void | Promise<void>;
  readonly onClose: () => void;
  readonly onOpenTodo: (id: string) => void;
  /** File a new task into the period (todos-panel writes it in the task area's words). */
  readonly onAddTask: (cycleId: string, title: string) => Promise<unknown>;
  /** Mark a contained task done or open again (in the task area's states). */
  readonly onToggleTask: (id: string, done: boolean) => Promise<unknown>;
  /** The detail's "…" menu (share, delete); `can.delete` is whether to offer the delete. */
  readonly renderActions: (row: ApiCycle, done: () => void, can: { delete: boolean }) => React.ReactNode;
}) {
  const ui = useMemo(() => periodAreaUi(areas), [areas]);
  const v = ui.view;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(ui.defaultSort);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<PeriodViewMode>(ui.defaultMode);
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const dismissWarnings = useCallback(() => setWarnings([]), []);
  const [pending, setPending] = useState<(PendingMove & { id: string; body: Record<string, unknown> }) | null>(null);
  const access = useRecordAccess("periods", authorEmail, areas);
  const now = Date.now();
  const ctx: TaskReadContext = useMemo(() => ({ now, me: authorEmail, stateOf: ui.stateOf }), [now, authorEmail, ui]);
  const rows = useMemo(() => cycles.map((c) => ({ ...periodAreaRow(c as unknown as Record<string, unknown>), id: c.id }) as AreaRow & { id: string }), [cycles]);
  const shown = useMemo(() => sortPeriods(ui, filterPeriods(ui, rows, q, picks, ctx), sort) as (AreaRow & { id: string })[], [ui, rows, q, picks, ctx, sort]);
  const metrics = useMemo(() => periodMetrics(ui, rows, ctx), [ui, rows, ctx]);
  // The contained records (#185): every task filed into a period, and how many of them are done, by its categories.
  const tasksArea = useMemo(() => areaView("tasks", areas), [areas]);
  const completion = useMemo(() => completionOf(todos as unknown as AreaRow[], areas), [todos, areas]);
  const selected = shown.find((r) => r.id === selId) ?? rows.find((r) => r.id === selId) ?? null;
  const selectedCycle = selected ? cycles.find((c) => c.id === selected.id) ?? null : null;

  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const answer = await fn();
      const notes = writeNotes(answer);
      if (notes.length) setWarnings(notes);
      await onChanged();
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (id: string, body: Record<string, unknown>) => send(() => opsFetch(`/api/ops/cycles/${id}`, { method: "PATCH", body: JSON.stringify({ ...body, actor: authorEmail }) }));
  /** A move to `to`: refused here under strict, asks for a reason when its transition needs one, else sent. */
  const move = (row: AreaRow & { id: string }, to: string) => {
    const lc = ui.lifecycle;
    if (!lc) return;
    const from = ui.stateOf(row);
    const m = clientMove(v, row, from, to, { me: authorEmail, role });
    if (m.blocked) {
      setActionError(m.blocked);
      return;
    }
    if (!access.transition(row)) {
      setActionError(`You cannot move this ${ui.noun}.`);
      return;
    }
    const body = { [lc.field]: to };
    if (m.needsComment) {
      setPending({ id: row.id, body, title: String(row.name ?? ""), from: from ? `"${v.display(lc.field, from)}"` : "nothing", to: `"${v.display(lc.field, to)}"`, action: m.action });
      return;
    }
    void patch(row.id, body);
  };

  const card = ui.board?.card ?? {};
  const config = {
    items: shown,
    selectedId: selId,
    onSelect: (id: string) => {
      setCreating(false);
      setSelId(id);
    },
    renderCard: (r: AreaRow & { id: string }) => {
      const held = completion.get(r.id);
      return (
        <WorkspaceCard
          title={card.title && card.title !== "name" ? <FieldValue ui={ui} row={r} keyName={card.title} /> : String(r.name ?? "")}
          headerRight={card.badge ? <span className={TYPE.micro}><FieldValue ui={ui} row={r} keyName={card.badge} /></span> : undefined}
          selected={selId === r.id}
          onClick={() => setSelId(r.id)}
          testid="period-card"
        >
          <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground", TYPE.micro)}>
            {(card.meta ?? ["endsAt", "lead"]).map((k) => (v.field(k) && !v.field(k)!.hidden ? <span key={k}><FieldValue ui={ui} row={r} keyName={k} /></span> : null))}
            {ui.contains ? <span className="tabular-nums" data-testid="card-completion">{`${held?.done ?? 0}/${held?.total ?? 0} ${tasksArea.nouns} done`}</span> : null}
          </div>
        </WorkspaceCard>
      );
    },
    kanban: {
      columns: ui.board?.columns ?? [],
      columnOf: (r: AreaRow) => String((ui.board?.by === ui.lifecycle?.field ? ui.stateOf(r) : v.get(r, ui.board?.by ?? "")) ?? ""),
      onMove: (r: AreaRow & { id: string }, col: string) => {
        const by = ui.board?.by;
        if (!by) return;
        if (by === ui.lifecycle?.field) return move(r, col);
        const f = v.field(by);
        if (f) void patch(r.id, fieldBody(f, col));
      },
      ...(ui.lifecycle?.enforce === "strict" ? { canDrop: (r: AreaRow & { id: string }, col: string) => clientMove(v, r, ui.stateOf(r), col, { me: authorEmail, role }).blocked } : {}),
    },
    table: [
      ...ui.columns.map((c) => ({
        key: c.key,
        label: c.label,
        render: (r: AreaRow & { id: string }) => (
          <span data-col={c.key} className={c.key === ui.columns[0]?.key ? "font-medium" : undefined}>
            {c.key === "name" ? String(r.name ?? "") : <FieldValue ui={ui} row={r} keyName={c.key} />}
          </span>
        ),
      })),
      ...(ui.contains
        ? [{
            key: "contains",
            label: `${tasksArea.plural} done`,
            render: (r: AreaRow & { id: string }) => {
              const held = completion.get(r.id);
              return <span data-col="contains" className="tabular-nums">{`${held?.done ?? 0}/${held?.total ?? 0}`}</span>;
            },
          }]
        : []),
    ],
    timeline: {
      rangeOf: (r: AreaRow) => ({ start: (v.get(r, ui.timeline.start) as string | null) ?? null, end: (v.get(r, ui.timeline.end) as string | null) ?? null }),
      labelOf: (r: AreaRow) => String(r.name ?? ""),
      toneOf: (r: AreaRow) => {
        const t = v.tone("state", ui.stateOf(r));
        return t ? `${TONE_CLASS[t]}/70` : "bg-indigo-500/70";
      },
    },
  };

  const { Toolbar, FilterMenu } = chrome;
  const filterGroups = ui.facets.map((f) => ({ label: f.label, selected: picks[f.id] ?? [], onChange: (n: string[]) => setPicks((p) => ({ ...p, [f.id]: f.id.startsWith("date:") ? n.slice(-1) : n })), options: f.options }));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="period-area">
      <Toolbar
        noun={ui.noun}
        nounPlural={ui.nouns}
        q={q}
        setQ={setQ}
        sort={sort}
        setSort={setSort}
        sortOptions={ui.sorts}
        onClose={onClose}
        onCreate={access.create ? () => { setSelId(null); setCreating(true); } : undefined}
        createLabel={ui.createLabel}
        viewSwitcher={<Modes modes={ui.modes} mode={mode} setMode={setMode} />}
        filter={filterGroups.length ? <FilterMenu groups={filterGroups} /> : undefined}
      />
      <TaskMetricStrip metrics={metrics} />
      {actionError ? (
        <p role="alert" className={cn("px-4 pt-3 text-red-400", TYPE.meta)}>
          {actionError}
        </p>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shown.length === 0 && mode !== "calendar" ? (
            <p className={cn("py-16 text-center text-muted-foreground/60 italic", TYPE.meta)}>{rows.length ? ui.emptyNoMatch : ui.empty}</p>
          ) : mode === "calendar" ? (
            <CalendarView ui={ui} rows={shown} selectedId={selId} onSelect={(id) => { setCreating(false); setSelId(id); }} now={now} />
          ) : (
            <WorkspaceViews view={mode as ViewMode} config={config} />
          )}
        </div>
        {creating ? (
          <SidePanel onClose={() => setCreating(false)}>
            <PeriodCreate
              ui={ui}
              areas={areas}
              authorEmail={authorEmail}
              canSet={(k) => access.field(k, null)}
              onCancel={() => setCreating(false)}
              onCreated={async (id, answer) => {
                setCreating(false);
                const notes = writeNotes(answer);
                if (notes.length) setWarnings(notes);
                await onChanged();
                setSelId(id);
              }}
            />
          </SidePanel>
        ) : selected && selectedCycle ? (
          <SidePanel onClose={() => setSelId(null)} actions={renderActions(selectedCycle, () => { setSelId(null); void onChanged(); }, { delete: access.delete(selected) })}>
            <PeriodDetail
              key={selected.id}
              ui={ui}
              row={selected}
              cycle={selectedCycle}
              chrome={chrome}
              busy={busy}
              authorEmail={authorEmail}
              role={role}
              canMove={access.transition(selected)}
              canRename={access.update(selected)}
              canSet={(k) => access.field(k, selected)}
              tasks={todos.filter((t) => t.cycleId === selected.id)}
              tasksWord={{ nouns: tasksArea.nouns, plural: tasksArea.plural }}
              held={completion.get(selected.id) ?? { total: 0, done: 0 }}
              closedTask={(t) => tasksArea.closed(t as unknown as AreaRow)}
              onPatch={(body) => void patch(selected.id, body)}
              onMove={(to) => move(selected, to)}
              onOpenTodo={onOpenTodo}
              onAddTask={(title) => void send(() => onAddTask(selected.id, title))}
              onToggleTask={(id, done) => void send(() => onToggleTask(id, done))}
            />
          </SidePanel>
        ) : null}
      </div>
      <TaskWarningsToast warnings={warnings} onDismiss={dismissWarnings} />
      <MoveReasonDialog
        move={pending}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => {
          const p = pending;
          setPending(null);
          if (p) void patch(p.id, { ...p.body, reason });
        }}
      />
    </div>
  );
}

/** The detail: the name, the lifecycle's moves, the definition's sections, the contained records, activity, comments. */
function PeriodDetail({
  ui,
  row,
  cycle,
  chrome,
  busy,
  authorEmail,
  role,
  canMove,
  canRename,
  canSet,
  tasks,
  tasksWord,
  held,
  closedTask,
  onPatch,
  onMove,
  onOpenTodo,
  onAddTask,
  onToggleTask,
}: {
  readonly ui: PeriodAreaUi;
  readonly row: AreaRow & { id: string };
  readonly cycle: ApiCycle;
  readonly chrome: RecordAreaChrome;
  readonly busy: boolean;
  readonly authorEmail?: string;
  readonly role?: RecordRole;
  readonly canMove: boolean;
  readonly canRename: boolean;
  readonly canSet: (key: string) => boolean;
  readonly tasks: readonly ApiTodo[];
  readonly tasksWord: { nouns: string; plural: string };
  readonly held: { total: number; done: number };
  readonly closedTask: (t: ApiTodo) => boolean;
  readonly onPatch: (body: Record<string, unknown>) => void;
  readonly onMove: (to: string) => void;
  readonly onOpenTodo: (id: string) => void;
  readonly onAddTask: (title: string) => void;
  readonly onToggleTask: (id: string, done: boolean) => void;
}) {
  const v = ui.view;
  const lc = ui.lifecycle;
  const { PanelHeader, PanelSection } = chrome;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const state = ui.stateOf(row);
  const hasTransitions = (v.area.lifecycle?.transitions?.length ?? 0) > 0;
  const moves = lc && hasTransitions ? lc.movesFrom(state, role) : [];
  const nameField = v.field("name");
  const ordered = [...tasks].filter((t) => !t.archivedAt).sort((a, b) => Date.parse(a.dueAt ?? a.createdAt) - Date.parse(b.dueAt ?? b.createdAt));
  const section = (s: PeriodAreaUi["sections"][number], i: number) => {
    if (s.related === "tasks") {
      if (!ui.contains) return null;
      return (
        <PanelSection key={`tasks:${i}`} label={`${s.label ?? tasksWord.plural} · ${held.done}/${held.total}`}>
          <div data-testid="period-contains" className="flex flex-col gap-1">
            {held.total > 0 ? (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-label={`${held.done} of ${held.total} done`}>
                <div className="h-full rounded-full bg-emerald-500/80" style={{ width: `${Math.round((held.done / held.total) * 100)}%` }} />
              </div>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {ordered.map((t) => {
                const done = closedTask(t);
                return (
                  <li key={t.id} className="flex items-center gap-2" data-testid="period-task">
                    <button type="button" disabled={busy} onClick={() => onToggleTask(t.id, !done)} title={done ? "Mark open" : "Mark done"} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                      {done ? <CheckIcon className="size-4 text-emerald-500" /> : <CircleIcon className="size-4" />}
                    </button>
                    <button type="button" onClick={() => onOpenTodo(t.id)} className={cn("min-w-0 flex-1 truncate py-0.5 text-left hover:text-foreground", TYPE.body, done ? "text-muted-foreground/60 line-through" : "text-foreground/90")}>
                      {t.title}
                    </button>
                    {t.dueAt ? <span className={cn("shrink-0 text-muted-foreground tabular-nums", TYPE.micro)}>{shortDate(t.dueAt)}</span> : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center gap-1.5 rounded-md border border-border/50 px-2 py-1.5 focus-within:border-border">
              <PlusIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
              <input
                value={draft}
                disabled={busy}
                aria-label={`Add ${tasksWord.nouns}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) {
                    e.preventDefault();
                    onAddTask(draft.trim());
                    setDraft("");
                  }
                }}
                placeholder={`Add to this ${ui.noun}…`}
                className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/40", TYPE.body)}
              />
            </div>
          </div>
        </PanelSection>
      );
    }
    if (s.related === "activity") return <ActivityFeed key={`activity:${i}`} entity="cycle" id={row.id} refreshKey={cycle.updatedAt} />;
    if (s.related === "comments") return <CommentThread key={`comments:${i}`} entity="cycle" id={row.id} label={String(row.name ?? "")} authorEmail={authorEmail} />;
    const fields = s.fields.filter((f) => f.key !== "name" && !(hasTransitions && f.key === lc?.field));
    if (!fields.length) return null;
    return (
      <PanelSection key={`${s.label ?? ""}:${i}`} label={s.label ?? "Properties"}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-4" data-testid="period-section">
          {fields.map((f) =>
            f.computed ? (
              <div key={f.key} className="flex flex-col gap-1">
                <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>{f.label ?? f.key}</span>
                <span className={TYPE.body} data-record-value={f.key}><FieldValue ui={ui} row={row} keyName={f.key} /></span>
              </div>
            ) : (
              <RecordFieldControl
                key={`${f.key}:${JSON.stringify(v.get(row, f.key) ?? null)}`}
                field={{ ...f, label: f.label ?? DEFAULT_LABEL[f.key] ?? f.key }}
                value={formValueOf(f, f.key === lc?.field ? state : v.get(row, f.key))}
                error={errors[f.key]}
                disabled={busy || !canSet(f.key) || (f.key === lc?.field && !canMove)}
                onCommit={(x) => {
                  const value = writeValueOf(f, x);
                  if (value === null && f.required === true) return setErrors((p) => ({ ...p, [f.key]: `"${f.label ?? f.key}" (${f.key}) is required, so it cannot be cleared.` }));
                  setErrors(({ [f.key]: _drop, ...rest }) => rest);
                  if (f.key === lc?.field && typeof value === "string") onMove(value);
                  else onPatch(fieldBody(f, value));
                }}
              />
            ),
          )}
        </div>
      </PanelSection>
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="period-detail">
      <PanelHeader eyebrow={ui.singular}>
        <input
          key={String(row.name ?? "")}
          defaultValue={String(row.name ?? "")}
          placeholder={nameField?.placeholder ?? ui.singular}
          aria-label={nameField?.label ?? "Name"}
          readOnly={!canRename}
          className="w-full truncate bg-transparent font-semibold text-[15px] text-foreground leading-snug outline-none placeholder:text-muted-foreground/60"
          onBlur={(e) => {
            const t = e.target.value.trim();
            if (t && t !== row.name) onPatch({ name: t });
          }}
        />
      </PanelHeader>
      <div className="flex flex-col gap-5 px-5 py-4">
        {lc && hasTransitions ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="lifecycle-moves">
            <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", TYPE.micro)} data-testid="period-state">
              <span className={cn("size-1.5 rounded-full", TONE_CLASS[v.tone(lc.field, state) ?? "muted"])} />
              {v.display(lc.field, state) || "—"} →
            </span>
            {moves.map((m) => {
              const check = clientMove(v, row, state, m.to, { me: authorEmail, role });
              return (
                <OpsButton key={`${m.to}:${m.transition?.label ?? ""}`} intent="secondary" size="sm" title={check.blocked ?? undefined} disabled={busy || !canMove || Boolean(check.blocked)} onClick={() => onMove(m.to)}>
                  {m.transition?.label ?? v.display(lc.field, m.to)}
                </OpsButton>
              );
            })}
          </div>
        ) : null}
        {areaRunsWorkflow(v.area) ? <RecordWorkflowSection area="periods" record={{ id: row.id }} refreshKey={cycle.updatedAt} /> : null}
        {ui.sections.map(section)}
      </div>
    </div>
  );
}

/** The create form: the definition's fields, checked as the API checks it before it is sent. */
function PeriodCreate({
  ui,
  areas,
  authorEmail,
  canSet,
  onCreated,
  onCancel,
}: {
  readonly ui: PeriodAreaUi;
  readonly areas: RecordAreas;
  readonly authorEmail?: string;
  readonly canSet: (key: string) => boolean;
  readonly onCreated: (id: string, answer: unknown) => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  const me = authorEmail;
  const initial = (f: RecordField): FormValue => {
    const d = f.default;
    if (d === "{me}") return me ?? "";
    if (typeof d === "string" && /^\{today/.test(d)) {
      const m = /([+-]\d+)d/.exec(d);
      return new Date(Date.now() + (m ? Number(m[1]) : 0) * 86_400_000).toISOString().slice(0, 10);
    }
    if (Array.isArray(d)) return d.map(String);
    if (typeof d === "boolean") return d;
    if (d !== undefined && d !== null && !String(d).startsWith("{")) return String(d);
    return formValueOf(f, null);
  };
  const fields = ui.createFields;
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(fields.map((f) => [f.key, initial(f)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A workspace whose periods have a length names and dates a new one itself when the form leaves them out.
  const hasLength = ui.view.area.period?.length_days != null;
  const submit = async () => {
    const body: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    for (const f of fields) {
      if (!canSet(f.key)) continue;
      const x = writeValueOf(f, values[f.key]);
      if (x === null) continue;
      if (f.column) body[f.key] = x;
      else custom[f.key] = x;
    }
    if (Object.keys(custom).length) body.custom = custom;
    const problems: Record<string, string> = {};
    const rest: string[] = [];
    const checked = preparePeriodWrite("create", body, { actor: me ?? "", checkPermissions: false }, areas);
    if (!checked.ok) {
      for (const e of checked.errors) {
        const key = /\(([A-Za-z0-9_]+)\)/.exec(e)?.[1];
        if (key === "name" && hasLength && body.startsAt === undefined && body.endsAt === undefined) continue;
        if (key && fields.some((f) => f.key === key) && !problems[key]) problems[key] = e;
        else rest.push(e);
      }
    }
    setErrors(problems);
    setFormError(rest.length ? rest.join(" ") : null);
    if (Object.keys(problems).length || rest.length) return;
    setBusy(true);
    try {
      const res = await opsFetch<{ item: { id: string } }>("/api/ops/cycles", { method: "POST", body: JSON.stringify({ ...body, createdBy: me ?? "web" }) });
      await onCreated(res.item.id, res);
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="period-create"
      // The validator's own sentences, under each field, rather than the browser's bubbles.
      noValidate
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="pr-12 font-semibold text-[15px] text-foreground">{ui.createTitle}</h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        {fields.map((f) => (
          <RecordFieldControl
            key={f.key}
            field={{ ...f, label: f.label ?? DEFAULT_LABEL[f.key] ?? f.key }}
            value={values[f.key]}
            error={errors[f.key]}
            disabled={busy || !canSet(f.key)}
            onChange={(x) => {
              setValues((p) => ({ ...p, [f.key]: x }));
              setErrors(({ [f.key]: _drop, ...rest }) => rest);
            }}
          />
        ))}
      </div>
      {formError ? (
        <p role="alert" className={cn("text-red-400", TYPE.meta)}>
          {formError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <OpsButton type="submit" intent="primary" disabled={busy}>
          {ui.createLabel}
        </OpsButton>
        <OpsButton type="button" intent="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </OpsButton>
      </div>
    </form>
  );
}
