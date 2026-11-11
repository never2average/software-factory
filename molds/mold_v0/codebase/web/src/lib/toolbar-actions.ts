/**
 * A list's search row, without React (mold_v0-294): every tab's toolbar is
 *
 *   [search, taking the rest of the row] [Filter] [columns] [Actions ▾] [primary call to action]
 *
 * and "Actions ▾" (components/layout/actions-menu.tsx, one outlined, labelled dropdown) holds every secondary action
 * of the tab: its own first, then Import and Export, then Ask AI, each group set off by a separator. No other Export,
 * Import, Download or Ask button sits in the row (scripts/console-actions-scan.ts keeps them out).
 */

/** One item of the menu (the shape of a row's ⋯ item, components/layout/record-filters.tsx RowAction). */
export interface ToolbarItem { label: string; separator?: boolean }

/**
 * The Actions menu's items in order: the page's own, then Import and Export, then Ask AI, a separator before each group
 * after the first (an item's own `separator` inside its group is kept). Empty: the row has no Actions button at all.
 */
export function actionsItems<A extends ToolbarItem>(opts: { page?: readonly A[]; imports?: readonly A[]; exports?: readonly A[]; ask?: A | null }): A[] {
  const groups = [
    [...(opts.page ?? [])],
    [...(opts.imports ?? []), ...(opts.exports ?? [])],
    opts.ask ? [opts.ask] : [],
  ].filter((g) => g.length > 0);
  return groups.flatMap((g, i) => g.map((a, j) => (j === 0 ? { ...a, separator: i > 0 } : a)));
}

/** What a list sends to Ask AI (src/list-answers.ts ListContext); the server caps and cleans it again. */
export interface ListAskContext { list: string; search?: string; filters: string[]; columns: string[]; rows: string[][]; total: number }

/** Rows sent with a question, at most (the server's LIST_ROWS_MAX). */
export const ASK_ROWS_MAX = 50;
/** Values that look like an address or a phone number are not sent as the search. */
const LOOKS_PERSONAL = /@|\d(?: ?\d){6,}/;

/** A list's context from what it shows: the first ASK_ROWS_MAX rows of the view, the columns its Export writes. */
export function listAskContext(o: { list: string; search?: string; filters?: string[]; columns: string[]; rows: readonly (readonly unknown[])[] }): ListAskContext {
  const search = (o.search ?? '').trim();
  const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 200);
  return {
    list: o.list,
    ...(search && !LOOKS_PERSONAL.test(search) ? { search } : {}),
    filters: o.filters ?? [],
    columns: o.columns,
    rows: o.rows.slice(0, ASK_ROWS_MAX).map((r) => r.map(text)),
    total: o.rows.length,
  };
}
