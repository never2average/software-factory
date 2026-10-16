/**
 * THE RECORD HUB: the one screen that holds the record areas (the Ops Center's `todos` section: its tasks, periods and
 * the two account areas' views), as a deployment names it (profiles `records.hub`, docs/DEPLOYMENT_PROFILE.md
 * "records.hub").
 *
 * The hub has its own name, separate from the tasks area's word: the default profile calls the screen "TODOs" and a
 * task "task"; a compliance deployment may call the screen "Obligations Register" and a task "obligation". What it
 * says:
 *
 *   label   the screen's name, as a person reads it (the nav item, the screen's title, the Control Panel's section)
 *   icon    one of HUB_ICONS, or null: the nav keeps its circle-check and the Control Panel its list glyph
 *
 * Compiled at build into RECORD_HUB (lib/deployment-profile.generated.ts) with two derived parts:
 *
 *   item        one entry of the hub as a count names it ("3 TODOs"): today's "TODO" / "TODOs" while neither the
 *               hub nor the tasks area is renamed, else the tasks area's word ("3 obligations", "3 tasks")
 *   relabelled  the label is not the default's: the agent's briefing says what people call the screen
 *
 * The deep-link key (`/?ops=todos`) and every identifier stay: they are contracts.
 *
 * No imports: the profile generator (scripts/gen-deployment-profile.mjs) reads this file too.
 */

/** The glyphs a profile may give the hub, by the name it writes (lucide's). */
export const HUB_ICONS = [
  "circle-check",
  "list-todo",
  "list-checks",
  "clipboard-list",
  "clipboard-check",
  "scale",
  "shield-check",
  "landmark",
  "book-open",
  "folder-kanban",
  "calendar-check",
  "file-check",
] as const;
export type RecordHubIcon = (typeof HUB_ICONS)[number];

/** The default profile's name for the screen (profiles/00-default.json `records.hub.label`). */
export const DEFAULT_HUB_LABEL = "TODOs";
/** One entry of the hub when the tasks area is not redefined: today's words. */
export const DEFAULT_HUB_ITEM = { singular: "TODO", plural: "TODOs" } as const;
/** The longest name the nav and the Control Panel's section header lay out on one line. */
export const HUB_LABEL_MAX = 40;

export interface RecordHub {
  label: string;
  icon: RecordHubIcon | null;
  item: { singular: string; plural: string };
  relabelled: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What is wrong with a profile's `records.hub` (merged), as `<path>: <reason>`; null when nothing is. */
export function hubProblem(raw: unknown): string | null {
  if (!isObj(raw)) return "records.hub must be an object with a \"label\"";
  for (const k of Object.keys(raw)) if (k !== "label" && k !== "icon" && k !== "$comment") return `records.hub.${k}: unknown key (the hub takes label, icon)`;
  const label = raw.label;
  if (typeof label !== "string" || !label.trim()) return "records.hub.label must be a non-empty string (the screen's name, e.g. \"Obligations Register\")";
  if (label !== label.trim()) return `records.hub.label: ${JSON.stringify(label)} starts or ends with a space`;
  if (/[\n\r\t]/.test(label)) return "records.hub.label must be one line";
  if (label.length > HUB_LABEL_MAX) return `records.hub.label: ${JSON.stringify(label)} is ${label.length} characters; at most ${HUB_LABEL_MAX} fit the nav`;
  if (/[{}<>]/.test(label)) return `records.hub.label: ${JSON.stringify(label)} holds { } < or >, which a name never needs`;
  const icon = raw.icon;
  if (icon !== null && icon !== undefined && !(HUB_ICONS as readonly unknown[]).includes(icon)) {
    return `records.hub.icon: ${JSON.stringify(icon)} is not one of ${HUB_ICONS.map((i) => `"${i}"`).join(", ")} (or null for today's glyphs)`;
  }
  return null;
}

/**
 * The hub as the build emits it, from a checked `records.hub` and the tasks area as compiled (its word, and whether the
 * profile redefines it). An entry keeps today's word, "TODO", only while nothing renames the hub or the tasks: a
 * deployment that calls the screen "Obligations Register" does not count "TODOs" in it.
 */
export function compileHub(raw: { label: string; icon?: string | null }, tasks: { redefined?: boolean; label?: { singular: string; plural: string } }): RecordHub {
  const relabelled = raw.label !== DEFAULT_HUB_LABEL;
  const word = tasks.label ?? DEFAULT_HUB_ITEM;
  return {
    label: raw.label,
    icon: (raw.icon ?? null) as RecordHubIcon | null,
    item: relabelled || tasks.redefined ? { singular: word.singular, plural: word.plural } : { ...DEFAULT_HUB_ITEM },
    relabelled,
  };
}

/** "1 TODO", "3 TODOs", "3 obligations": a count of the hub's entries. */
export function hubCount(hub: RecordHub, n: number): string {
  return `${n} ${n === 1 ? hub.item.singular : hub.item.plural}`;
}

/** The hub's name used before a noun ("the TODO scope filters"): today's "TODO" by default, else the label. */
export function hubAttributive(hub: RecordHub): string {
  return hub.relabelled ? hub.label : DEFAULT_HUB_ITEM.singular;
}
