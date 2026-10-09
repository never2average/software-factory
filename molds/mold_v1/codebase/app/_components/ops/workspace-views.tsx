"use client";

/**
 * Notion-style view switching for the workspace tabs: every tab renders the
 * same items three ways — a Kanban board, a data Table, and a Timeline — chosen
 * by <ViewSwitcher>. A tab supplies one <WorkspaceViewConfig> and <WorkspaceViews>
 * dispatches on the active mode.
 */
import { GanttChartIcon, LayoutGridIcon, Table2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Board, type BoardColumn } from "./board";
import { TYPE } from "./tokens";

export type ViewMode = "kanban" | "table" | "timeline";

const VIEW_META: { v: ViewMode; icon: typeof LayoutGridIcon; label: string }[] = [
  { v: "kanban", icon: LayoutGridIcon, label: "Board" },
  { v: "table", icon: Table2Icon, label: "Table" },
  { v: "timeline", icon: GanttChartIcon, label: "Timeline" },
];

export function ViewSwitcher({
  view,
  setView,
}: {
  readonly view: ViewMode;
  readonly setView: (v: ViewMode) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
      {VIEW_META.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => setView(o.v)}
          title={o.label}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
            view === o.v ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <o.icon className="size-3.5" />
          <span className="hidden md:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Table ---------------------------------- */

export type TableColumn<T> = { key: string; label: string; render: (t: T) => React.ReactNode; className?: string };

export function TableView<T extends { id: string }>({
  columns,
  rows,
  selectedId,
  onSelect,
}: {
  readonly columns: readonly TableColumn<T>[];
  readonly rows: readonly T[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <table className="w-full min-w-[40rem] text-left">
        <thead>
          <tr className="border-border/60 border-b">
            {columns.map((c) => (
              <th key={c.key} className={cn("whitespace-nowrap px-2 py-2 font-medium text-muted-foreground/60 uppercase tracking-wide", TYPE.micro)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={cn(
                "cursor-pointer border-border/40 border-b transition-colors hover:bg-muted/20",
                selectedId === r.id && "bg-muted/40",
              )}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn("px-2 py-2.5 align-middle", c.className, TYPE.meta)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------- Timeline -------------------------------- */

export type TimelineRange = { start: string | null; end: string | null };

export function TimelineView<T extends { id: string }>({
  items,
  rangeOf,
  labelOf,
  toneOf,
  selectedId,
  onSelect,
}: {
  readonly items: readonly T[];
  readonly rangeOf: (t: T) => TimelineRange;
  readonly labelOf: (t: T) => React.ReactNode;
  readonly toneOf?: (t: T) => string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const parse = (s: string | null) => (s ? Date.parse(s) : Number.NaN);
  const rows = items.map((t) => {
    const r = rangeOf(t);
    let a = parse(r.start);
    let b = parse(r.end);
    if (Number.isNaN(a) && !Number.isNaN(b)) a = b;
    if (Number.isNaN(b) && !Number.isNaN(a)) b = a;
    return { t, a, b };
  });
  const stamps = rows.flatMap((r) => (Number.isNaN(r.a) ? [] : [r.a, r.b]));
  const now = Date.now();
  const min = Math.min(now, ...(stamps.length ? stamps : [now]));
  const max = Math.max(now + 86_400_000, ...(stamps.length ? stamps : [now]));
  const span = Math.max(1, max - min);
  const pct = (t: number) => ((t - min) / span) * 100;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex flex-col gap-1.5">
        {rows.map(({ t, a, b }) => {
          const dated = !Number.isNaN(a) && !Number.isNaN(b);
          return (
            <div key={t.id} className="grid grid-cols-[11rem_1fr] items-center gap-3">
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={cn("truncate text-left text-xs", selectedId === t.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {labelOf(t)}
              </button>
              <div className="relative h-7 rounded bg-muted/15">
                <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-red-500/40" style={{ left: `${pct(now)}%` }} />
                {dated ? (
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className={cn(
                      "absolute inset-y-1 rounded transition-all hover:brightness-110",
                      selectedId === t.id && "ring-1 ring-foreground/40",
                      toneOf?.(t) ?? "bg-indigo-500/70",
                    )}
                    style={{ left: `${pct(a)}%`, width: `${Math.max(1.5, pct(b) - pct(a))}%` }}
                  />
                ) : (
                  <span className="pl-2 text-2xs text-muted-foreground/40 leading-7">no dates</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- View dispatcher ---------------------------- */

export type WorkspaceViewConfig<T extends { id: string }> = {
  items: readonly T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Kanban card renderer. */
  renderCard: (t: T) => React.ReactNode;
  kanban: { columns: readonly BoardColumn[]; columnOf: (t: T) => string; onMove: (t: T, col: string) => void };
  table: readonly TableColumn<T>[];
  timeline: { rangeOf: (t: T) => TimelineRange; labelOf: (t: T) => React.ReactNode; toneOf?: (t: T) => string };
};

export function WorkspaceViews<T extends { id: string }>({
  view,
  config,
}: {
  readonly view: ViewMode;
  readonly config: WorkspaceViewConfig<T>;
}) {
  if (view === "table") {
    return <TableView columns={config.table} rows={config.items} selectedId={config.selectedId} onSelect={config.onSelect} />;
  }
  if (view === "timeline") {
    return (
      <TimelineView
        items={config.items}
        rangeOf={config.timeline.rangeOf}
        labelOf={config.timeline.labelOf}
        toneOf={config.timeline.toneOf}
        selectedId={config.selectedId}
        onSelect={config.onSelect}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Board
        columns={config.kanban.columns as BoardColumn[]}
        items={config.items as T[]}
        columnOf={config.kanban.columnOf}
        onMove={config.kanban.onMove}
        renderCard={config.renderCard}
      />
    </div>
  );
}
