/**
 * The record panel's layout (mold_v0-278, components/layout/detail-panel.tsx), pure: no React, no DOM.
 *
 * Every list's record opens inside the page, to the right of the list: the table column gives way (it narrows, stays
 * scrollable and clickable) and a splitter between them resizes the panel. The width is remembered per panel type as a
 * share of the space the two have (localStorage; blocked storage: for this page only), so it follows the window. The
 * table never gets narrower than TABLE_MIN: when the space cannot hold both, the panel takes it all (auto-expanded), as
 * it does when someone presses Expand (`&panel=full` in the list's address).
 */

/** The narrowest the panel gets. */
export const SPLIT_MIN = 360;
/** The narrowest the table column gets beside an open panel; less room than this and the panel takes it all. */
export const TABLE_MIN = 360;
/** Arrow keys move the splitter by this many pixels (Shift: four times as far). */
export const SPLIT_STEP = 16;

/** What a panel holds: an editor (a form, edge to edge) or a record's read-only details. */
export type PanelKind = 'editor' | 'detail';

/** The share of the space a panel takes until someone resizes it: half for an editor, 40% for details. */
export const SPLIT_DEFAULT: Record<PanelKind, number> = { editor: 0.5, detail: 0.4 };

/** The address parameters: `?id=<key>` opens a list's record, `&panel=full` expands it, `&panelTab=<tab>` picks its tab. */
export const DETAIL_PARAM = 'id';
export const PANEL_PARAM = 'panel';
export const PANEL_FULL = 'full';
export const PANEL_TAB_PARAM = 'panelTab';

/** The widest the panel may be in this much space: everything but the table's minimum (never below its own). */
export function splitMax(space: number): number {
  return Math.max(SPLIT_MIN, Math.floor(space) - TABLE_MIN);
}

/** Whether the space is too narrow for the panel and the table side by side (the panel then takes it all). */
export function tooNarrow(space: number): boolean {
  return space < SPLIT_MIN + TABLE_MIN;
}

/** A width the panel can take in this space. */
export function clampSplit(width: number, space: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : SPLIT_MIN;
  return Math.min(splitMax(space), Math.max(SPLIT_MIN, w));
}

export interface SplitLayout {
  /** The panel's width in pixels (the whole space when `full`). */
  width: number;
  /** The panel takes the whole space: expanded, or the space is too narrow for both. */
  full: boolean;
  /** Full because the space is too narrow (not because someone expanded it): Expand / Collapse are not offered. */
  auto: boolean;
  min: number;
  max: number;
}

/** The panel's layout in `space` pixels from the remembered share (null: the kind's default) and whether it is expanded. */
export function splitLayout(space: number, ratio: number | null, kind: PanelKind, expanded = false): SplitLayout {
  const max = splitMax(space);
  const auto = tooNarrow(space);
  if (auto || expanded) return { width: Math.max(0, Math.round(space)), full: true, auto, min: SPLIT_MIN, max };
  const share = ratio !== null && validRatio(ratio) ? ratio : SPLIT_DEFAULT[kind];
  return { width: clampSplit(share * space, space), full: false, auto: false, min: SPLIT_MIN, max };
}

/** The share of `space` a width is (what is remembered). */
export function ratioOf(width: number, space: number): number {
  if (!(space > 0)) return 0;
  return Math.round((width / space) * 1000) / 1000;
}

const validRatio = (r: number) => Number.isFinite(r) && r >= 0.1 && r <= 0.95;

/**
 * The splitter's keyboard: the panel sits on the right, so ArrowLeft widens it and ArrowRight narrows it (Shift: four
 * times as far); Home and End jump to the limits. Null: not a key the splitter handles.
 */
export function splitWidthForKey(key: string, shift: boolean, width: number, space: number): number | null {
  const step = shift ? SPLIT_STEP * 4 : SPLIT_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampSplit(width + step, space);
    case 'ArrowRight':
      return clampSplit(width - step, space);
    case 'Home':
      return SPLIT_MIN;
    case 'End':
      return splitMax(space);
    default:
      return null;
  }
}

/** Where a panel type's width is remembered: one key per type (an account's width is not a run's). */
export const splitStorageKey = (type: string) => `panel-width:${type}`;

type RatioStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The share this browser remembered for a panel type (missing, out of range or blocked storage: null). */
export function readSplitRatio(storage: RatioStorage | null, type: string): number | null {
  try {
    const raw = storage?.getItem(splitStorageKey(type));
    if (raw == null || raw === '') return null;
    const r = Number(raw);
    return validRatio(r) ? r : null;
  } catch {
    return null;
  }
}

/** Remember a panel type's share; false when the storage refused it (private mode, blocked site data). */
export function writeSplitRatio(storage: RatioStorage | null, type: string, ratio: number): boolean {
  try {
    if (!storage || !validRatio(ratio)) return false;
    storage.setItem(splitStorageKey(type), String(ratio));
    return true;
  } catch {
    return false;
  }
}

/** The address with the panel's own parameters dropped (closing keeps every list filter). */
export function closedSearch(search: string, extra: readonly string[] = []): string {
  const p = new URLSearchParams(search);
  for (const k of [DETAIL_PARAM, PANEL_PARAM, PANEL_TAB_PARAM, ...extra]) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : '';
}
