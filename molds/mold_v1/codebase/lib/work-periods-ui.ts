/**
 * WORK PERIODS AS A PERSON READS THEM: every label, placeholder and sentence the UI shows about a period, built from
 * the deployment profile's `work_periods` (agent/lib/work-periods.ts), and which views exist at all.
 *
 * No component spells a period word. Under the default profile each string below is, to the letter, what the base
 * product's UI has always shown (it used the profile's `label` for the view and a period's own panel, and its
 * `list_label` where tasks are grouped and filtered); scripts/test-work-periods.mjs pins every one of them. Under
 * another profile they read its words, and under mode "off" there is nothing to read: `enabled` is false, the
 * period view is not among `todoViews`, and no component asks for a period.
 *
 * Pure: no React, no fetch. `wp` is a parameter so a preview page or a test can pass another profile's.
 */
import { WORK_PERIODS, periodSlugPrefix, type WorkPeriods } from "../agent/lib/work-periods.ts";

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The tabs of the Todos workspace, by the key a deep link carries (`/?ops=todos&view=<key>`). */
export type TodoViewKey = "sprints" | "tasks" | "deployments" | "implementations";
/** The period view's key. A link someone already shared carries it, so it is a contract and never a label. */
export const PERIOD_VIEW: TodoViewKey = "sprints";

const VIEW_KEYS: readonly string[] = [PERIOD_VIEW, "tasks", "deployments", "implementations"];
/** Is this string one of the Todos workspace's view keys (what a deep link's `view` may be)? */
export const isTodoViewKey = (v: string | null | undefined): v is TodoViewKey => typeof v === "string" && VIEW_KEYS.includes(v);

/** The views this deployment has, in the order the navigation shows them. No period view under mode "off". */
export function todoViews(wp: WorkPeriods = WORK_PERIODS): TodoViewKey[] {
  return [...(wp.enabled ? [PERIOD_VIEW] : []), "tasks", "deployments", "implementations"];
}

/** The view a deep link or a stored choice opens: itself when this deployment has it, the task list otherwise. */
export function resolveTodoView(view: TodoViewKey | undefined, wp: WorkPeriods = WORK_PERIODS): TodoViewKey {
  return view && todoViews(wp).includes(view) ? view : "tasks";
}

export interface PeriodUi {
  enabled: boolean;
  team: boolean;
  individual: boolean;
  /** The navigation entry and its one-line description. */
  navLabel: string;
  navBlurb: string;
  /** Where tasks are grouped and filtered by their period: the filter, the table column, the task's field. */
  listLabel: string;
  backlogOption: string;
  /** The period list's toolbar and empty states. */
  searchNoun: string;
  searchNounPlural: string;
  createLabel: string;
  emptyNone: string;
  emptyNoMatch: string;
  /** A period's own panel. */
  eyebrow: string;
  untitled: string;
  /** The name a period created from the toolbar starts with (when the profile gives no length to name it by). */
  newName: string;
  tableLabel: string;
  deleteLabel: string;
  slugPrefix: string;
  goalPlaceholder: string;
  /** Mode team only. */
  leadLabel: string;
  leadTitle: (lead: string) => string;
  rolloverLabel: string;
  /** Mode individual only: one person's items within the period. */
  itemsLabel: string;
  myItemsLabel: string;
  addItemPlaceholder: string;
  noItems: string;
  personGoalLabel: string;
  personGoalPlaceholder: string;
  plannedLabel: string;
  plannedHint: string;
  carryMineLabel: string;
  progressLabel: (done: number, planned: number) => string;
  peopleCount: (n: number) => string;
  /** The workspace's own period length (the workspace settings screen; admins change it). */
  lengthLabel: string;
  lengthNote: string;
  lengthDefault: (days: number | null) => string;
}

export function periodUi(wp: WorkPeriods = WORK_PERIODS): PeriodUi {
  const p = wp.label; const l = wp.listLabel; const i = wp.itemLabel;
  return {
    enabled: wp.enabled,
    team: wp.team,
    individual: wp.individual,
    navLabel: cap(p.plural),
    navBlurb: wp.individual ? `Each person's ${i.plural} for the ${p.singular}.` : `Time-boxed ${l.plural} that group tasks.`,
    listLabel: cap(l.singular),
    backlogOption: `Backlog (no ${l.singular})`,
    searchNoun: l.singular,
    searchNounPlural: l.plural,
    createLabel: `New ${l.singular}`,
    emptyNone: `No ${l.plural} yet — hit New ${l.singular}.`,
    emptyNoMatch: `No ${l.plural} match.`,
    eyebrow: cap(p.singular),
    untitled: `Untitled ${p.singular}`,
    newName: `New ${p.singular}`,
    tableLabel: cap(p.singular),
    deleteLabel: `Delete ${p.singular}`,
    slugPrefix: periodSlugPrefix(wp),
    goalPlaceholder: `What this ${p.singular} is trying to achieve…`,
    leadLabel: `${cap(p.singular)} lead`,
    leadTitle: (lead) => `${cap(p.singular)} lead · ${lead}`,
    rolloverLabel: wp.individual ? `Carry everyone's unfinished ${i.plural} to the next ${p.singular}` : "Roll over unfinished",
    itemsLabel: cap(i.plural),
    myItemsLabel: `My ${i.plural}`,
    addItemPlaceholder: `Add a ${i.singular}…`,
    noItems: `No ${i.plural} yet.`,
    personGoalLabel: `Goal for the ${p.singular}`,
    personGoalPlaceholder: `What you mean to get done this ${p.singular}…`,
    plannedLabel: "Planned",
    plannedHint: `How many ${i.plural} you planned.`,
    carryMineLabel: `Carry my unfinished ${i.plural} to the next ${p.singular}`,
    progressLabel: (done, planned) => `${done}/${planned} ${planned === 1 ? i.singular : i.plural} done`,
    peopleCount: (n) => `${n} ${n === 1 ? "person" : "people"}`,
    lengthLabel: `${cap(p.singular)} length`,
    lengthNote: `Applies to new ${p.plural}; the current one keeps its dates.`,
    lengthDefault: (days) => `Default: ${days === null ? `no fixed length (a new ${p.singular} has no dates until someone sets them)` : `${days} day${days === 1 ? "" : "s"}`}.`,
  };
}

/** This deployment's. */
export const PERIOD_UI: PeriodUi = periodUi();
