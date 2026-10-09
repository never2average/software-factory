"use client";
import { useMemo, useState } from "react";
import { XIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePager } from "./lib";
import { ListFooter, SearchBox, TableCard, Th } from "./primitives";

/**
 * Full-height paginated table built on the SAME primitives as the Connectors
 * table (`TableCard` / `Th` / `SearchBox` / `ListFooter` + `usePager`), so every
 * Workspace tab looks identical and fills the page: sticky-less bordered card,
 * icon column headers, client-side search, and a "N / page" footer with a boxed
 * pager. Rows scroll inside the card; the page never scrolls sideways.
 */

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Plain-text accessor for search (optional). */
  text?: (row: T) => string;
  icon?: LucideIcon;
  align?: "left" | "right";
  className?: string;
}

/**
 * The section header card (icon box + title + blurb + optional action) used at
 * the top of every Workspace tab — the same shape as the Ops Center's
 * `SectionHeaderCard`, but freestanding so any tab (table or form) can use it.
 */
export function HeaderCard({
  icon: Icon,
  title,
  blurb,
  action,
}: {
  icon: LucideIcon;
  title: string;
  blurb: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted text-foreground">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-sm leading-tight">{title}</h2>
        <p className="mt-0.5 truncate text-2xs text-muted-foreground">{blurb}</p>
      </div>
      {action}
    </div>
  );
}

export function PaginatedTable<T>({
  rows,
  columns,
  getKey,
  noun,
  title,
  blurb,
  icon,
  action,
  emptyLabel = "Nothing here yet.",
  onRowClick,
  renderDetail,
  totalBeforeFilters,
  flush = false,
  selectedKey,
  onCloseDetail,
  filters,
}: {
  rows: T[];
  columns: Column<T>[];
  getKey: (row: T) => string;
  /** Singular noun for the search box + footer ("person" → "Search persons…"). */
  noun: string;
  /** Header card (shown when title is provided). */
  title?: string;
  blurb?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  emptyLabel?: string;
  onRowClick?: (row: T) => void;
  /** Renders the detail side panel for the currently `selectedKey`'d row. */
  renderDetail?: (row: T, close: () => void) => React.ReactNode;
  /** Row count BEFORE the caller's own filters, so the count can say "12 of 104". */
  totalBeforeFilters?: number;
  /** Inside a dialog the surface is already a card — see TableCard's `flush`. */
  flush?: boolean;
  /** Controlled: the key of the row whose detail panel is open (open it from a
   *  row action, e.g. "Review"). Omit for a table with no detail panel. */
  selectedKey?: string | null;
  /** Called when the detail panel's close button is pressed. */
  onCloseDetail?: () => void;
  /** Controls rendered beside the search box (type/date pickers, status tabs).
   *  A slot rather than a fixed set, because every table filters by something
   *  different and the row is the one place a user looks for them. */
  filters?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => (c.text ? c.text(r) : "").toLowerCase().includes(q)));
  }, [rows, columns, query]);
  const pager = usePager(filtered);

  const selected =
    renderDetail && selectedKey != null ? rows.find((r) => getKey(r) === selectedKey) ?? null : null;
  const close = () => onCloseDetail?.();

  const cols = selected ? columns.slice(0, 1) : columns; // collapse to the first column beside the panel

  const tableCard = (
    <TableCard
      flush={flush}
      footer={
        <ListFooter
          noun={noun}
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
          {cols.map((c) => (
            <Th key={c.key} icon={c.icon} label={c.header} align={c.align === "right" ? "right" : "left"} />
          ))}
        </tr>
      </thead>
      <tbody>
        {pager.rows.length === 0 ? (
          <tr>
            <td colSpan={cols.length} className="px-4 py-16 text-center text-muted-foreground text-sm">
              {emptyLabel}
            </td>
          </tr>
        ) : (
          pager.rows.map((r) => (
            <tr
              key={getKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn(
                "border-border/50 border-b last:border-b-0",
                onRowClick ? "cursor-pointer hover:bg-muted/40" : "hover:bg-muted/20",
                selected && getKey(r) === selectedKey && "bg-muted/60",
              )}
            >
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cn("px-3 py-2.5 align-middle first:pl-4 last:pr-4", c.align === "right" && "text-right", c.className)}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </TableCard>
  );

  // Search sits ABOVE the table/panel row so the list and the detail panel share
  // the same top edge and fill to the same bottom — no height mismatch.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {title && icon ? <HeaderCard icon={icon} title={title} blurb={blurb ?? ""} action={action} /> : null}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <SearchBox
            noun={noun}
            value={query}
            onChange={(v) => {
              setQuery(v);
              pager.setPage(1);
            }}
          />
        </div>
        {filters}
        {/* Say what the filters did.
         *
         * On a list longer than a page, filtering changes nothing you can see:
         * the page stays full at 25 rows and the only tell is the pager quietly
         * going from "of 4" to "of 2". A working filter and a broken one look
         * identical, which is exactly how a working one gets reported as
         * broken. This is the count that moves. */}
        {(query.trim() || (totalBeforeFilters != null && totalBeforeFilters !== rows.length)) && (
          <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums">
            {filtered.length} of {totalBeforeFilters ?? rows.length} {noun}
            {(totalBeforeFilters ?? rows.length) === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {selected && renderDetail ? (
        // Both columns are IDENTICAL: a `flex flex-col` wrapper holding one
        // flex-1 card. The detail is a plain inline <aside> (not the shared
        // SidePanel, whose hardcoded w-[70%]/flex behaviour offset it) so the
        // two cards share the exact same top edge.
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-h-0 w-[32%] min-w-0 shrink-0 flex-col">{tableCard}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <aside
              className={cn(
                "relative flex min-h-0 flex-1 flex-col overflow-hidden",
                flush ? "rounded-lg border border-border/60 bg-muted/[0.04]" : "rounded-xl border border-border bg-card",
              )}
            >
              <button
                type="button"
                onClick={close}
                aria-label="Close details"
                className="absolute top-2.5 right-2.5 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-4" />
              </button>
              {renderDetail(selected, close)}
            </aside>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{tableCard}</div>
      )}
    </div>
  );
}
