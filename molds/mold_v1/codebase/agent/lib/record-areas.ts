/**
 * THE RECORD AREAS, AS EVERY SURFACE READS THEM: a view model over the compiled definitions (RECORD_AREAS, written by
 * scripts/gen-deployment-profile.mjs from profiles `records.areas`; docs/DEPLOYMENT_PROFILE.md "records").
 *
 * `areaView(id)` answers what a list, a board, a form, the agent's tools and its briefing need to know about an area:
 * its words, its fields in order and how to read one off a row (a column, or the area's own field under `custom`),
 * each field's choices with their tones and how a stored value is shown, the lifecycle (each state's category, the
 * moves a transition list allows), the board's columns, the table's columns, the sorts and filters, the create form.
 *
 * Base code branches on CATEGORIES (backlog, open, active, blocked, done, cancelled) and on field TYPES, never on a
 * value a profile chose. Where an area is not redefined (`redefined: false`) a caller keeps the literals it has today;
 * the default definitions carry exactly those words, so either way reads the same.
 *
 * Pure: no React, no database, no fetch. `areas` is a parameter so a preview page or a test can pass another
 * profile's compiled definitions. It lives under agent/lib so both the agent and the web app can import it.
 */
import { ownValue } from "./own-keys.ts";
import { RECORD_AREA_STRUCTURE, RECORD_AREAS, type RecordArea, type RecordAreaStructure, type RecordAreaId, type RecordCategory, type RecordField, type RecordOption, type RecordRole, type RecordTone, type RecordTransition } from "./record-areas.generated.ts";

export type { RecordArea, RecordAreaId, RecordAreaStructure, RecordCategory, RecordField, RecordOption, RecordRole, RecordTone, RecordTransition };
export type RecordAreas = Record<RecordAreaId, RecordArea>;

export const CATEGORIES: readonly RecordCategory[] = ["backlog", "open", "active", "blocked", "done", "cancelled"];
/** The stored task status (the task-workflow service's contract) each category writes. */
export const CATEGORY_STATUS: Record<RecordCategory, string> = { backlog: "backlog", open: "open", active: "in_progress", blocked: "blocked", done: "done", cancelled: "cancelled" };
/** Categories in which a record is still to be done: what "overdue" and "open work" count. */
export const OPEN_CATEGORIES: ReadonlySet<RecordCategory> = new Set(["backlog", "open", "active", "blocked"]);

/** A tone as the dot / chip colour class the ops UI uses (Tailwind). */
export const TONE_CLASS: Record<RecordTone, string> = {
  slate: "bg-slate-400",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  violet: "bg-violet-500",
  muted: "bg-muted-foreground/40",
};

export const upperFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "Coverage report" -> "coverage report"; "KPI table" stays. For use mid-sentence. */
export function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The control a form draws for a field. */
export type InputKind = "text" | "textarea" | "number" | "date" | "datetime" | "select" | "multiselect" | "checkbox" | "email" | "url" | "person" | "record" | "file" | "tags";
export function inputFor(f: Pick<RecordField, "type" | "many">): InputKind {
  switch (f.type) {
    case "long_text": return "textarea";
    case "integer": case "number": case "percent": case "money": return "number";
    case "date": return "date";
    case "datetime": return "datetime";
    case "boolean": return "checkbox";
    case "pick_list": return "select";
    case "multi_pick": return "multiselect";
    case "email": return "email";
    case "link": return "url";
    case "person": return "person";
    case "record": return "record";
    case "file": return "file";
    case "tags": return "tags";
    default: return "text";
  }
}

/** A row as the API returns it: columns by key, the area's own fields under `custom`. */
export type AreaRow = Record<string, unknown> & { custom?: Record<string, unknown> | null };

export function areaView(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS) {
  const area = areas[id];
  const fields = Object.values(area.fields).sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const byAlias = new Map(fields.flatMap((f) => (f.alias ? [[f.alias, f] as const] : [])));
  const label = area.label ?? { singular: id, plural: id };
  const lc = area.lifecycle ?? null;
  const field = (key: string): RecordField | undefined => byKey.get(key) ?? byAlias.get(key);
  const optionsOf = (key: string): RecordOption[] => field(key)?.options ?? [];
  const optionLabel = (o: RecordOption) => o.label ?? o.value;

  const view = {
    id,
    area,
    enabled: area.enabled,
    redefined: area.redefined,
    /** "Task", "Tasks"; mid-sentence "task", "tasks". */
    singular: upperFirst(label.singular),
    plural: upperFirst(label.plural),
    noun: lowerFirst(label.singular),
    nouns: lowerFirst(label.plural),
    description: area.description ?? "",
    /** Every field in order (hidden ones included: a row may still carry them). */
    fields,
    /** The fields a person sees, in order. */
    visibleFields: fields.filter((f) => !f.hidden),
    /** The area's OWN fields (stored under `custom`), in order. */
    ownFields: fields.filter((f) => !f.column),
    field,
    has: (key: string) => byKey.has(key),
    /** A field's label, or `fallback` (what the spot said before) when the definition gives none. */
    label: (key: string, fallback?: string, variant: "full" | "short" = "full"): string => {
      const f = field(key);
      return (variant === "short" ? f?.short_label ?? f?.label : f?.label) ?? fallback ?? key;
    },
    /** A field's value on a row: a column by key, an own field under `custom` (or the keys older rows carry it under). */
    get: (row: AreaRow, key: string): unknown => {
      const f = field(key);
      if (!f) return row[key];
      if (f.column) return row[f.key];
      // A row with no own values (`custom` absent, null, or not an object) holds none of them: nothing, never a throw.
      // Its own key first, then each earlier key (`renamed_from`, agent/lib/own-keys.ts).
      return ownValue(row.custom, f);
    },
    /** A choice field's choices that may still be picked (retired ones are shown, never offered). */
    options: (key: string): { value: string; label: string; tone?: RecordTone; attention?: boolean }[] =>
      optionsOf(key).filter((o) => !o.retired).map((o) => ({ value: o.value, label: optionLabel(o), ...(o.tone ? { tone: o.tone } : {}), ...(o.attention ? { attention: true } : {}) })),
    /** A stored value as the option value it is read as (a legacy spelling mapped), or as it was stored. */
    canonical: (key: string, value: string): string => field(key)?.legacy_values?.[value] ?? value,
    /** A stored value as a person reads it: its choice's label, else the value. "" when unset. */
    display: (key: string, value: unknown): string => {
      if (value === null || value === undefined || value === "") return "";
      if (Array.isArray(value)) return value.map((v) => view.display(key, v)).join(", ");
      const f = field(key);
      const v = String(value);
      const o = f?.options?.find((x) => x.value === (f.legacy_values?.[v] ?? v));
      if (o) return optionLabel(o);
      if (f?.type === "percent" && typeof value === "number") return `${value}%`;
      if ((f?.type === "number" || f?.type === "money") && typeof value === "number") return `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}${f.type === "money" && f.currency ? ` ${f.currency}` : ""}`;
      if (f?.type === "boolean") return value ? "Yes" : "No";
      return v;
    },
    /** The tone of a stored choice value, if the definition gives one. */
    tone: (key: string, value: unknown): RecordTone | undefined => {
      const f = field(key);
      const v = String(value ?? "");
      return f?.options?.find((x) => x.value === (f.legacy_values?.[v] ?? v))?.tone;
    },
    /** The reverse of display: what a person read or typed, as the value to store. Unknown text comes back as it was. */
    valueOf: (key: string, shown: string): string => {
      const t = shown.trim().toLowerCase();
      return optionsOf(key).find((o) => o.value.toLowerCase() === t || optionLabel(o).toLowerCase() === t)?.value ?? shown;
    },
    inputFor: (key: string): InputKind => inputFor(field(key) ?? { type: "text" }),
    /** What the forms submit for the fields nobody sees. */
    fixedValues: (): Record<string, unknown> => Object.fromEntries(fields.filter((f) => f.hidden && f.fixed !== undefined).map((f) => [f.key, f.fixed])),

    // --- the lifecycle -------------------------------------------------------------------------------------------
    lifecycle: lc
      ? {
          field: lc.field,
          /** Is the lifecycle on the area's own field (a redefined task) rather than a column? */
          own: !byKey.get(lc.field)?.column,
          initial: lc.initial ?? optionsOf(lc.field)[0]?.value ?? null,
          enforce: lc.enforce ?? "off",
          states: optionsOf(lc.field).map((o) => ({ value: o.value, label: optionLabel(o), tone: o.tone, category: lc.categories[o.value], retired: Boolean(o.retired) })),
          categoryOf: (state: unknown): RecordCategory | null => (typeof state === "string" ? lc.categories[view.canonical(lc.field, state)] ?? null : null),
          /**
           * The moves from `state` the transitions list allows for `role` (all when the list is empty), each with what it
           * needs. Whether a move outside them goes through is `enforce`'s ("off", "warn", "strict"): enforced by the
           * write path, not here.
           */
          movesFrom: (state: string | null, role?: RecordRole): { to: string; transition: RecordTransition | null }[] => {
            const states = optionsOf(lc.field).filter((o) => !o.retired).map((o) => o.value);
            const ts = lc.transitions ?? [];
            if (!ts.length) return states.filter((s) => s !== state).map((to) => ({ to, transition: null }));
            return ts
              .filter((t) => t.from === "*" || (state !== null && t.from.includes(state)))
              .filter((t) => t.to !== state && (!role || !t.roles || t.roles.includes(role)))
              .map((t) => ({ to: t.to, transition: t }));
          },
        }
      : null,
    /** The category of a row (its lifecycle state's), or null when the area has no lifecycle. */
    categoryOfRow: (row: AreaRow): RecordCategory | null => (lc ? view.lifecycle!.categoryOf(view.get(row, lc.field)) : null),
    /** Is a row finished (its state's category is done or cancelled)? */
    closed: (row: AreaRow): boolean => {
      const c = view.categoryOfRow(row);
      return c === "done" || c === "cancelled";
    },

    // --- the views -----------------------------------------------------------------------------------------------
    /** The board: the field it is grouped by and its columns, the choices in order. */
    board: (() => {
      const by = area.views?.board?.by ?? lc?.field ?? null;
      return by ? { by, columns: optionsOf(by).filter((o) => !o.retired).map((o) => ({ key: o.value, label: optionLabel(o), tone: o.tone })), card: area.views?.board?.card ?? {} } : null;
    })(),
    /** The table's columns: the definition's list, else every visible field shown in lists. */
    tableColumns: (): string[] => area.views?.table?.columns ?? fields.filter((f) => !f.hidden && f.show_in_list).map((f) => f.key),
    sorts: (area.views?.sorts ?? []).map((s) => ({ field: s.field, dir: s.dir ?? "asc", label: s.label ?? field(s.field)?.label ?? s.field, default: Boolean(s.default) })),
    filters: area.views?.filters ?? [],
    groupBy: area.views?.group_by ?? [],
    /** The create form's fields (the definition's, else the required ones), and its button. */
    createFields: (): RecordField[] => {
      const keys = area.views?.create?.fields ?? fields.filter((f) => f.required === true && !f.hidden).map((f) => f.key);
      return keys.flatMap((k) => byKey.get(k) ?? []);
    },
    submitLabel: area.views?.create?.submit_label ?? `New ${lowerFirst(label.singular)}`,
    detailSections: area.views?.detail?.sections ?? [],
    relations: area.relations ?? {},
  };
  return view;
}

export type AreaView = ReturnType<typeof areaView>;

/**
 * The area as a short card for the model (agent/lib/deployment-briefing.ts, the tool descriptions): what a record is,
 * its own fields with their types and which are required, the states in order with what moving into each needs, and
 * the rules. Only for an area the deployment redefines; null otherwise, so the default model surface is unchanged.
 */
export function describeArea(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS, account?: string): string | null {
  const v = areaView(id, areas);
  if (!v.redefined || !v.enabled) return null;
  const a = v.area;
  const lines: string[] = [];
  lines.push(`- ${/^[aeiou]/i.test(v.noun) ? "An" : "A"} **${v.noun}** (plural: ${v.nouns})${a.description ? `: ${a.description}` : "."}`);
  const structure = describeStructure(id, areas, account);
  if (structure) lines.push(`  ${structure}`);
  const own = v.ownFields.filter((f) => !f.hidden);
  if (own.length) lines.push(`  Its own fields (in \`custom\`): ${own.map((f) => describeField(f)).join("; ")}.`);
  lines.push(...describeMoves(id, areas));
  const computed = v.fields.filter((f) => f.computed && !f.hidden);
  if (computed.length) lines.push(`  Computed, never set: ${computed.map((f) => `\`${f.key}\``).join(", ")}.`);
  if (a.agent?.describe) lines.push(`  ${a.agent.describe}`);
  for (const r of a.agent?.rules ?? []) lines.push(`  - ${r}`);
  return lines.join("\n");
}

/**
 * Is the area's structure said to the model? Only where the deployment's own definition is what the model reads: a
 * task area it redefines, a period that declares what it contains, a deployments / implementations area stated in the
 * record-area form (`declared`). Anything else (the default, a legacy form) reads byte for byte what it did.
 */
export function structureShown(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS): boolean {
  const a = areas[id];
  if (!a.enabled) return false;
  if (id === "tasks") return a.redefined;
  if (id === "periods") return Boolean(a.relations?.contains) && a.period?.mode !== "off";
  return Boolean(a.declared);
}

/**
 * What a record of the area IS, in the deployment's words (RECORD_AREA_STRUCTURE; docs/DEPLOYMENT_PROFILE.md "Choosing
 * the area for a domain concept"): "Regulatory filings: each groups obligations due together in one window …". One
 * sentence for the briefing's card, the agent's tools and MCP's; null where structureShown() is false. `account`:
 * what this deployment calls an account (the default profile's word when not given).
 */
export function describeStructure(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS, account = "account", word: (t: string) => string = (t) => t): string | null {
  if (!structureShown(id, areas)) return null;
  const v = areaView(id, areas);
  const s: RecordAreaStructure = RECORD_AREA_STRUCTURE[id];
  // `word` marks the deployment's own words (labels, nouns, the account word): a relabelled briefing keeps them as
  // written while the identifiers around them are spoken in its vocabulary.
  const an = (w: string) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${word(w)}`;
  const shown = (role: keyof RecordAreaStructure["columns"]) => {
    const key = s.columns[role];
    const f = key ? v.field(key) : undefined;
    return f && !f.hidden ? `"${word(v.label(f.key))}", \`${f.key}\`` : null;
  };
  const on = (x: RecordAreaId) => areas[x].enabled && !(x === "periods" && areas.periods.period?.mode === "off");
  const tasks = areaView("tasks", areas);
  const periods = areaView("periods", areas);
  const contains = areas.periods.relations?.contains;
  const parts: string[] = [];
  if (id === "tasks") {
    const owner = shown("owner");
    const due = shown("due");
    parts.push(`${word(v.plural)}: each is one unit of work${owner ? ` that someone owns (${owner})` : ""}${due ? `, falling due on a day (${due})` : ""}, moved through its states until it is done.`);
    if (on("periods") && contains?.area === "tasks") parts.push(`${word(upperFirst(v.nouns))} due together are grouped into ${an(periods.noun)} (\`cycleId\`)${contains.completion === false ? "" : `, which is complete when they are done`}.`);
    const under = (v.area.relations?.containers ?? []).filter((c): c is "deployments" | "implementations" => (c === "deployments" || c === "implementations") && on(c)).map((c) => an(areaView(c, areas).noun));
    if (under.length) parts.push(`One may be filed under ${under.join(" or ")} (containerType + containerId).`);
  } else if (id === "periods") {
    const window = [shown("start"), shown("due")].filter(Boolean);
    parts.push(`${word(v.plural)}: each groups ${word(tasks.nouns)} due together in one window${window.length ? ` (${window.join(" to ")})` : ""}${contains?.completion === false ? "" : ` and is complete when they are all done`}; ${an(tasks.noun)} is in one when filed with its id (\`cycleId\`).`);
  } else {
    const state = shown("state");
    const health = shown("health");
    const says = [state ? `its ${id === "implementations" ? "stage" : "release state"} (${state})` : "", health ? `its ${id === "implementations" ? "risk" : "health"} (${health})` : ""].filter(Boolean);
    parts.push(
      id === "deployments"
        ? `${word(v.plural)}: each is a change rolled out to one ${word(account)} (its target)${says.length ? `, with ${says.join(" and ")}` : ""}.`
        : `${word(v.plural)}: each is a long-running programme run for one ${word(account)}, moving through stages${says.length ? `, with ${says.join(" and ")}` : ""}.`,
    );
    if (tasks.enabled && (tasks.area.relations?.containers ?? []).includes(id)) parts.push(`${word(upperFirst(tasks.nouns))} may be filed under one.`);
  }
  return parts.join(" ");
}

/**
 * What a period contains and is measured by (records.areas.periods.relations.contains), when it declares it and periods
 * are on: the contained area and whether its records complete the period. Null otherwise (the default).
 */
export function periodContains(areas: RecordAreas = RECORD_AREAS): { area: RecordAreaId; completion: boolean } | null {
  const c = areas.periods.relations?.contains;
  if (!c || !areas.periods.enabled || areas.periods.period?.mode === "off" || !areas[c.area]?.enabled) return null;
  return { area: c.area, completion: c.completion !== false };
}

/**
 * A period's completion from the records filed into it (each carries the period's id as `cycleId`): by period id, how
 * many there are (a cancelled one does not count) and how many are done (their state's category is done). Read
 * through the area's own lifecycle, so a pack's states count by their category, never by their names.
 */
export function periodCompletion(rows: AreaRow[], areas: RecordAreas = RECORD_AREAS): Map<string, { total: number; done: number }> {
  const out = new Map<string, { total: number; done: number }>();
  const c = periodContains(areas);
  if (!c) return out;
  const v = areaView(c.area, areas);
  for (const row of rows) {
    const period = row.cycleId;
    if (typeof period !== "string" || !period || row.archivedAt) continue;
    const category = v.categoryOfRow(row);
    if (category === "cancelled") continue;
    const n = out.get(period) ?? { total: 0, done: 0 };
    n.total += 1;
    if (category === "done") n.done += 1;
    out.set(period, n);
  }
  return out;
}

/** `key` ("Label", type, required?, choices): how a tool description and the briefing name a field. */
export function describeField(f: RecordField): string {
  const choices = (f.options ?? []).filter((o) => !o.retired);
  const type =
    f.type === "pick_list" ? `one of ${choices.map((o) => JSON.stringify(o.value) + (o.label && o.label !== o.value ? ` (${JSON.stringify(o.label)})` : "")).join(" | ")}`
    : f.type === "multi_pick" ? `a list of ${choices.map((o) => JSON.stringify(o.value)).join(" | ")}`
    : f.type === "date" ? "date yyyy-mm-dd"
    : f.type === "datetime" ? "ISO date-time"
    : f.type === "percent" ? "percent 0-100"
    : f.type === "money" ? `amount${f.currency ? ` in ${f.currency}` : ""}`
    : f.type === "link" ? "http(s) link"
    : f.type === "person" ? (f.many ? "a list of emails" : "an email")
    : f.type === "file" ? (f.many ? "a list of data-room paths" : "a data-room path")
    : f.type.replace("_", " ");
  return `\`${f.key}\` ("${f.label ?? f.key}", ${type}${f.required === true ? ", required" : f.required === "on_create" ? ", required when created" : ""})`;
}

/**
 * An area's lifecycle as its MOVES, for the model (the card, MCP's task tools): its states, then from each state the
 * moves there are, each with who may make it, who may not (four eyes), what it needs set, whether it needs a comment,
 * and what it stamps, then what the enforce mode does. Never one line of states, which reads as an order the record
 * goes through. [] when the area has no lifecycle.
 */
export function describeMoves(id: RecordAreaId, areas: RecordAreas = RECORD_AREAS): string[] {
  const v = areaView(id, areas);
  const a = v.area;
  const lines: string[] = [];
  if (!v.lifecycle) return lines;
  // The lifecycle as its MOVES, never as one line of states (which reads as an order the record goes through): the
  // states, then from each state the moves there are, each with who may make it, who may not (four eyes), what it
  // needs set, whether it needs a comment, and what it stamps.
  const lc = v.lifecycle;
  const name = lc.own ? `\`custom.${lc.field}\`` : `\`${lc.field}\``;
  const shown = (s: string) => `"${v.display(lc.field, s)}"`;
  const live = lc.states.filter((s) => !s.retired);
  lines.push(`  Its state is ${name}: ${live.map((s) => `${JSON.stringify(s.value)} (${shown(s.value)})`).join(", ")}${lc.initial ? `; a new one starts in ${shown(lc.initial)}` : ""}.`);
  const ts = a.lifecycle?.transitions ?? [];
  if (!ts.length) lines.push("  Any state may move to any other.");
  else {
    const rule = (t: RecordTransition) => {
      const r = [
        t.label ?? "",
        t.roles?.length ? `${t.roles.join(" or ")} only` : "",
        t.not_by === "{entered_by}" ? "not by whoever moved it into the state it leaves: a second person must" : t.not_by ? `not by its ${v.label(t.not_by).toLowerCase()}` : "",
        t.requires?.length ? `needs ${t.requires.map((k) => `"${v.label(k)}"`).join(" and ")} set` : "",
        t.requires_comment ? `needs a comment saying why${id === "tasks" ? " (`reason`)" : ""}` : "",
        ...Object.entries(t.set ?? {}).map(([k, x]) => `sets "${v.label(k)}" to ${x === "{me}" ? "you" : x === "{today}" || x === "{now}" ? "today" : JSON.stringify(x)}`),
      ].filter(Boolean);
      return `${shown(t.to)}${r.length ? ` (${r.join("; ")})` : ""}`;
    };
    const any = ts.filter((t) => t.from === "*");
    for (const s of live) {
      const out = ts.filter((t) => t.from !== "*" && t.from.includes(s.value) && t.to !== s.value);
      if (out.length) lines.push(`  - From ${shown(s.value)} you can go to ${out.map(rule).join(", ")}.`);
    }
    if (any.length) lines.push(`  - From any state you can go to ${any.map(rule).join(", ")}.`);
    const ends = live.filter((s) => !ts.some((t) => t.to !== s.value && (t.from === "*" || t.from.includes(s.value))));
    if (ends.length) lines.push(`  - ${ends.map((s) => shown(s.value)).join(", ")}: no move out.`);
    if (lc.enforce !== "off") lines.push(`  A move not listed here, or that breaks its rule, is ${lc.enforce === "strict" ? "refused, and the refusal names the moves you can make" : "let through but noted in the activity feed: keep to them"}.`);
  }
  return lines;
}
