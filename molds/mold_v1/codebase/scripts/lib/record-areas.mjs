/**
 * RECORD AREAS: the one model behind the four kinds of record a deployment profile shapes (docs/DEPLOYMENT_PROFILE.md,
 * "records"). Each area is bound to the table it already has:
 *
 *   deployments       the `deployments` table       (legacy form: domains.deployments)
 *   implementations   the `implementation` table    (legacy form: domains.implementations)
 *   tasks             the `todos` table             (no legacy form: the default profile's records.areas.tasks)
 *   periods           the `cycles` table            (legacy form: work_periods)
 *
 * A profile may only REDEFINE these four (a brand-new kind of record is refused), and only at build time.
 *
 * compileArea() turns what the profile says into one compiled definition: every column of the bound table typed from
 * the source (base), the legacy form lowered onto it (lowerDomain / lowerPeriods), then the profile's records.areas.<id>
 * merged over that (objects deeply, arrays replace, `fields` a map keyed by field key). checkArea() is every rule the
 * build enforces beyond the JSON Schema (scripts/schemas/record-area.schema.json). raiseDomain() / raisePeriods() go
 * the other way, for a profile written in the new form, so every reader of `domains` and `work_periods` keeps working
 * until it reads the compiled areas itself.
 *
 * Pure: no file system, no process. scripts/gen-deployment-profile.mjs reads the sources and calls these.
 */
import { validate } from "./json-schema.mjs";

/** The JSON Schema check of what a profile SAYS about an area (before it is compiled): the first problem, or null. */
export function schemaProblem(schema, declared) {
  const problems = validate(schema, declared ?? {});
  return problems.length ? problems[0] : null;
}
export const AREA_IDS = ["deployments", "implementations", "tasks", "periods"];
export const BUILT_IN = {
  deployments: { kind: "record", storage: "deployments" },
  implementations: { kind: "record", storage: "implementation" },
  tasks: { kind: "task", storage: "todos" },
  periods: { kind: "period", storage: "cycles" },
};
/**
 * THE STRUCTURE of each built-in area: what it IS, independent of what any deployment calls it. The area ids are the
 * base product's software words; this is the shape behind each, so a pack author (and the model, and a coding agent)
 * can map a domain concept onto the right area. Fixed by the table each is stored in; a profile cannot change it
 * (it says what the area is CALLED and which relations it uses). docs/DEPLOYMENT_PROFILE.md "Choosing the area for a
 * domain concept" is the decision table drawn from this.
 *
 *   role       one word: unit | container | change | programme
 *   is         what one record is, in neutral words
 *   time       instant (falls due or happens on one day) | window (starts and ends) | ongoing (runs on, moves through stages)
 *   relations  contains: the area whose records a record holds AND is measured by; groups: the area whose records may
 *              be filed under it (not measured by them); targets: what it is rolled out to or run for; in: where a record
 *              of this area may sit
 *   columns    which built-in column carries which role: state, owner, due, target, health, and the area's own extras
 *   choose     when a domain concept belongs in this area
 */
export const STRUCTURE = {
  tasks: {
    role: "unit",
    is: "a unit of work: one thing a person owns, does and finishes, falling due on a day",
    time: "instant",
    relations: { in: ["periods", "deployments", "implementations"] },
    columns: { state: "status", owner: "assignee", due: "dueAt", container: "containerId", period: "cycleId", parent: "parentId" },
    choose: "the concept is one piece of work someone owns and closes, with its own due date and states",
  },
  periods: {
    role: "container",
    is: "a bounded container: a window that holds units of work due together and is measured by them",
    time: "window",
    relations: { contains: "tasks" },
    columns: { state: "state", owner: "lead", start: "startsAt", due: "endsAt", goal: "goal", capacity: "capacity" },
    choose: "the concept is a set of units that fall due together and is complete when they are done",
  },
  deployments: {
    role: "change",
    is: "a change rolled out to a target (an account, or a place within it), with a release state and health",
    time: "instant",
    relations: { targets: "account", groups: "tasks" },
    columns: { target: "account", state: "releaseStatus", health: "healthStatus", owner: "deployOwnerEmail", when: "lastDeployAt", version: "deployedVersion" },
    choose: "the concept is a change put into effect for one account, whose release and health are then watched",
  },
  implementations: {
    role: "programme",
    is: "a long-running programme or framework run for one account: it groups work and moves through stages",
    time: "ongoing",
    relations: { targets: "account", groups: "tasks" },
    columns: { target: "account", state: "implementationStage", owner: "implementationOwnerEmail", due: "targetGoLiveDate", health: "implementationRiskLevel", progress: "implementationProgressPct", group: "rolloutId" },
    choose: "the concept is a standing programme an account adopts and works through in stages, for months",
  },
};
/** The areas a period may contain (the area whose rows carry the period's id: todos.cycleId). */
export const PERIOD_CONTAINS = ["tasks"];
/** What base code branches on: never a pack's state, always its category. */
export const CATEGORIES = ["backlog", "open", "active", "blocked", "done", "cancelled"];
/** The stored task status (the contract with the task-workflow service) each category writes. */
export const CATEGORY_STATUS = { backlog: "backlog", open: "open", active: "in_progress", blocked: "blocked", done: "done", cancelled: "cancelled" };
export const ROLES = ["owner", "admin", "engineer", "member"];
export const FIELD_TYPES = ["text", "long_text", "integer", "number", "percent", "money", "date", "datetime", "boolean", "email", "link", "pick_list", "multi_pick", "person", "record", "file", "tags"];
export const LIMITS = { own_fields: 60, indexes_per_table: 6 };
/** The link types a task may point at (the task-workflow service's `linkType`). */
export const TASK_LINKS = ["ticket", "customer", "app", "cron", "workflow", "chat"];
/** The record areas a task may be filed under (the service's `containerType`, by area id). */
export const TASK_CONTAINERS = { deployments: "deployment", implementations: "implementation" };

/** A column's kind (read from the source) and the field types it can carry. */
export const COMPATIBLE = {
  text: ["text", "long_text", "date", "datetime", "email", "link", "pick_list", "person", "record"],
  enum: ["pick_list"],
  number: ["number", "percent", "money", "integer"],
  integer: ["integer", "number"],
  boolean: ["boolean"],
  timestamp: ["datetime", "date"],
  uuid: ["record", "text"],
  list: ["tags", "multi_pick", "file", "person", "record"],
};
const DEFAULT_TYPE = { text: "text", enum: "pick_list", number: "number", integer: "integer", boolean: "boolean", timestamp: "datetime", uuid: "record", list: "tags" };
const CHOICE = new Set(["pick_list", "multi_pick"]);
const DATES = new Set(["date", "datetime"]);
const NUMBERS = new Set(["integer", "number", "percent", "money"]);
const TEXTS = new Set(["text", "long_text", "email", "link"]);
const PEOPLE = new Set(["person", "email"]);
const SORTABLE = new Set(["text", "integer", "number", "percent", "money", "date", "datetime", "pick_list", "person", "email", "boolean", "link", "record"]);
const OWN_KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const TEMPLATE_DEFAULT = /^\{(today([+-][0-9]{1,3}d)?|me|account\.owner)\}$/;
/** Not fields: the row's identity, its workspace, the own-field store, soft delete. */
// recursFrom: todos.recurs_from, generated from custom.recurs_from (the link a next occurrence carries back, drizzle/0042):
// never a field, and no area's own field may be called recurs_from.
export const SYSTEM_KEYS = ["id", "orgId", "customerId", "implementationId", "displayName", "custom", "archivedAt", "recursFrom"];
/** Columns a write never sets: the database and the service stamp them. */
export const READ_ONLY = { todos: ["doneAt", "createdBy", "createdAt", "updatedAt"], cycles: ["createdBy", "createdAt", "updatedAt"] };
/** Pseudo-fields an area offers beside its own: the account a record hangs off. */
const ACCOUNT_FIELD = "account";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const quote = (s) => JSON.stringify(s);
const list = (a) => a.map(quote).join(", ");
const an = (w) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** Objects merge deeply, arrays and scalars replace; "$comment" is documentation. The profile merge rule. */
export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (k === "$comment") continue;
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : structuredClone(v);
  }
  return out;
}

/**
 * Every column of the bound table as a field: its kind, the type it shows as by default, whether a write must give
 * it, its enum's values as options. `cols`: { key: { kind, values?, required } } (the generator reads the source).
 */
export function columnBase(id, cols) {
  const fields = {};
  const stamped = new Set(READ_ONLY[BUILT_IN[id].storage] ?? []);
  let i = 0;
  for (const [key, meta] of Object.entries(cols)) {
    i += 1;
    const type = meta.kind === "number" && /Pct$/.test(key) ? "percent" : DEFAULT_TYPE[meta.kind] ?? "text";
    fields[key] = { order: 10000 + i * 10, type, ...(meta.required && !stamped.has(key) ? { required: true } : {}), ...(meta.values ? { options: meta.values.map((value) => ({ value })) } : {}) };
  }
  return { enabled: true, ...BUILT_IN[id], columns: "all", fields };
}

/** domains.<area> (the legacy form) as a record area. Only what it states; the base supplies the rest. */
export function lowerDomain(id, d, cols) {
  if (!isObj(d)) return {};
  const fields = {};
  // A malformed legacy form is refused by the legacy checks with their own message; lowering only skips what it cannot read.
  for (const [key, spec] of Object.entries(isObj(d.fields) ? d.fields : {})) {
    if (!(key in cols) || !isObj(spec)) continue;
    const f = {};
    for (const k of ["label", "short_label", "help", "placeholder", "hidden", "fixed"]) if (k in spec) f[k] = spec[k];
    if (isObj(spec.options) && cols[key].values) f.options = cols[key].values.map((value) => (value in spec.options ? { value, label: spec.options[value] } : { value }));
    fields[key] = f;
  }
  if (typeof d.kind_field === "string" && d.kind_field in cols && Array.isArray(d.kinds)) fields[d.kind_field] = { ...(fields[d.kind_field] ?? {}), type: "pick_list", options: d.kinds.map((value) => ({ value })) };
  (Array.isArray(d.custom_fields) ? d.custom_fields : []).filter((cf) => isObj(cf) && typeof cf.key === "string").forEach((cf, i) => {
    fields[cf.key] = {
      order: 100000 + i * 10,
      type: cf.type,
      label: cf.label,
      ...(cf.required ? { required: true } : {}),
      ...(cf.help ? { help: cf.help } : {}),
      ...(Array.isArray(cf.options) ? { options: cf.options.map((value) => ({ value })) } : {}),
      ...(cf.show_in_list ? { show_in_list: true } : {}),
    };
  });
  const views = {};
  if (Array.isArray(d.create_fields) && d.create_fields.length) views.create = { fields: [...d.create_fields], append: true };
  if (Array.isArray(d.detail_fields) && d.detail_fields.length) views.detail = { sections: [{ fields: [...d.detail_fields] }], append: true };
  const relations = { account: { required: true }, tasks: true };
  if ("group_by" in d) relations.group = { field: d.group_by, label: d.group_label };
  return {
    label: d.label,
    description: d.description,
    id: { ...(id === "deployments" ? { field: "deploymentId" } : {}), label: d.id_label },
    fields,
    ...(Object.keys(views).length ? { views } : {}),
    relations,
  };
}

/** work_periods (the legacy form) as the periods area. */
export function lowerPeriods(wp) {
  if (!isObj(wp)) return {};
  const period = {};
  for (const k of ["mode", "list_label", "item_label", "length_days", "auto_rollover", "length_days_range", "workspace_can_set_length"]) if (k in wp) period[k] = structuredClone(wp[k]);
  return { enabled: wp.mode !== "off", label: structuredClone(wp.label), period };
}

/**
 * One compiled area. `declared` is the merged records.areas.<id> (the default's and every pack file's). Every field
 * comes out with its key, whether it is a column, and a type.
 */
export function compileArea(id, { cols, legacy, declared }) {
  const base = columnBase(id, cols);
  const lowered = id === "periods" ? lowerPeriods(legacy) : id === "tasks" ? {} : lowerDomain(id, legacy, cols);
  const area = deepMerge(deepMerge(base, lowered), declared ?? {});
  const named = new Set(Object.keys(declared?.fields ?? {}));
  if (area.id?.field) named.add(area.id.field);
  let unordered = 0;
  for (const [key, f] of Object.entries(area.fields)) {
    const column = key in cols;
    // An own field the profile gave no order comes after every field that has one, in the order it was declared.
    if (f.order === undefined) f.order = 200000 + (unordered += 1) * 10;
    f.key = key;
    f.column = column;
    if (!f.type && column) f.type = base.fields[key]?.type ?? "text";
    if (column && area.columns === "listed" && !named.has(key) && !READ_ONLY[BUILT_IN[id].storage]?.includes(key)) f.hidden = true;
  }
  // A task whose states are its own (an own pick_list field): the stored status follows them, so nobody sets it.
  if (id === "tasks" && area.lifecycle?.field && area.lifecycle.field !== "status" && area.fields.status) area.fields.status.hidden = true;
  // A period that CONTAINS an area's records: a target measuring that area with no date of its own counts the records
  // filed into the period ("contained"); one with a date counts those dated inside the window ("window"). Stated only
  // when the period declares what it contains, so a profile that does not compiles to what it did.
  if (id === "periods" && isObj(area.relations?.contains)) {
    area.relations.contains = { completion: true, ...area.relations.contains };
    for (const t of area.targets ?? []) {
      if (!isObj(t?.measure) || t.measure.scope) continue;
      if (t.measure.area === area.relations.contains.area && !t.measure.date) t.measure.scope = "contained";
      else if (t.measure.date) t.measure.scope = "window";
    }
  }
  return area;
}

/** The fields of an area in their order. */
export const orderedFields = (area) => Object.values(area.fields).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.key < b.key ? -1 : 1));

/**
 * Everything the build refuses beyond the schema (schemaProblem, on what the profile said). Returns the first problem
 * as { path, message } (path relative to records.areas.<id>), or null. `ctx`: { cols, areas (all compiled, by id),
 * folders (data-room domain ids), declared (what the profile said about this area) }.
 */
export function checkArea(id, area, ctx) {
  const bad = (path, message) => ({ path, message });
  const { kind, storage } = BUILT_IN[id];
  if (area.kind !== kind) return bad("kind", `the ${id} area is a "${kind}" area; its kind is fixed by the table it is stored in`);
  if (area.storage !== storage) return bad("storage", `the ${id} area is stored in the "${storage}" table; that cannot change`);
  const cols = ctx.cols;
  const fields = area.fields;
  const has = (k) => k in fields;
  const visible = (k) => has(k) && !fields[k].hidden;
  const fieldNames = () => orderedFields(area).filter((f) => !f.hidden).map((f) => f.key);
  const unknown = (path, k, what = "field") => bad(path, `${quote(k)} is not a ${what} of this area (its fields: ${fieldNames().join(", ")})`);
  const recordArea = kind === "record";
  const isFieldRef = (k) => has(k) || (recordArea && k === ACCOUNT_FIELD);
  const readOnly = new Set(READ_ONLY[storage] ?? []);
  // How many records an account holds: the implementations' to say (each then has its own id, drizzle/0044). A
  // deployment is already keyed by its own id under the account; a task or a period hangs off no account.
  if ("per_account" in area && id !== "implementations") {
    return bad("per_account", id === "deployments" ? `a deployment is identified by its own id (${quote(area.id?.field ?? "deploymentId")}), so an account already holds as many as it needs; per_account is the implementations area's` : `the ${id} area belongs to no account; per_account is the implementations area's`);
  }

  // --- fields -----------------------------------------------------------------------------------------------------
  const own = Object.values(fields).filter((f) => !f.column);
  if (own.length > LIMITS.own_fields) return bad("fields", `${own.length} own fields; an area may declare at most ${LIMITS.own_fields}`);
  const builtInSpellings = new Set([...Object.keys(cols), ...SYSTEM_KEYS].flatMap((k) => [k, snake(k), k.toLowerCase()]));
  const labels = new Map();
  const aliases = new Map();
  let indexes = 0;
  for (const f of orderedFields(area)) {
    const at = `fields.${f.key}`;
    const col = cols[f.key];
    if (SYSTEM_KEYS.includes(f.key)) return bad(at, `${quote(f.key)} is the record's ${f.key === "custom" ? "own-field store" : "identity or workspace"}, not a field`);
    if (col) {
      if (f.column === false) return bad(`${at}.column`, `${quote(f.key)} is a column of the ${storage} table`);
      if (!COMPATIBLE[col.kind].includes(f.type)) return bad(`${at}.type`, `${quote(f.key)} is a ${col.kind === "enum" ? "column with a fixed list of values" : `${col.kind} column`}, so it can be ${COMPATIBLE[col.kind].map(quote).join(" or ")}, not ${quote(f.type)}`);
      if (col.kind === "enum") {
        const values = new Set(col.values);
        const extra = (f.options ?? []).filter((o) => !values.has(o.value));
        if (extra.length) return bad(`${at}.options`, `${list(extra.map((o) => o.value))} ${extra.length === 1 ? "is not a value" : "are not values"} of ${f.key} (${list(col.values)}); a column's choices are the values it stores. Give them other words with "label"`);
      }
    } else {
      if (f.column === true) return bad(`${at}.column`, `${quote(f.key)} is not a column of the ${storage} table`);
      if (!OWN_KEY.test(f.key) || f.key.length > 40) return bad(at, `an own field's key must be snake_case: lowercase letters, digits and single underscores, starting with a letter, at most 40 characters (for example "due_date"), and ${quote(f.key)} is not`);
      if (builtInSpellings.has(f.key)) return bad(at, `${quote(f.key)} is already a built-in field of the ${storage} table in another spelling; relabel that one, or pick another key`);
      if (!f.type) return bad(`${at}.type`, `an own field needs a type (${FIELD_TYPES.join(", ")})`);
      if (!f.label) return bad(`${at}.label`, `an own field needs a label: what a person reads for ${quote(f.key)}`);
    }
    if (readOnly.has(f.key) && ("fixed" in f || "default" in f || f.required)) return bad(at, `${quote(f.key)} is stamped by the system; it takes no value, default or "required"`);
    if (f.label) {
      const other = labels.get(f.label.trim().toLowerCase());
      if (other && !f.hidden && !fields[other].hidden) return bad(`${at}.label`, `${quote(f.label)} is also the label of ${quote(other)}; two fields with one label cannot be told apart`);
      labels.set(f.label.trim().toLowerCase(), f.key);
    }
    if (f.alias) {
      if (aliases.has(f.alias) || (has(f.alias) && f.alias !== f.key)) return bad(`${at}.alias`, `${quote(f.alias)} already names ${aliases.get(f.alias) ?? f.alias}; an alias names one field`);
      aliases.set(f.alias, f.key);
    }
    // Choices.
    if (CHOICE.has(f.type)) {
      if (!f.options?.length) return bad(`${at}.options`, `a ${f.type} needs its choices: a list of { "value", "label"?, "tone"? }`);
      const seenV = new Set();
      const seenL = new Map();
      for (const [i, o] of f.options.entries()) {
        const v = o.value.trim().toLowerCase();
        if (seenV.has(v)) return bad(`${at}.options[${i}]`, `${quote(o.value)} is listed twice`);
        seenV.add(v);
        const l = (o.label ?? o.value).trim().toLowerCase();
        if (seenL.has(l)) return bad(`${at}.options[${i}].label`, `${quote(o.label ?? o.value)} labels both ${quote(seenL.get(l))} and ${quote(o.value)}; a label must map back to one value`);
        seenL.set(l, o.value);
      }
      for (const [stored, value] of Object.entries(f.legacy_values ?? {})) {
        if (!f.options.some((o) => o.value === value)) return bad(`${at}.legacy_values.${stored}`, `${quote(value)} is not one of the choices (${list(f.options.map((o) => o.value))})`);
      }
    } else {
      if ("options" in f && !col?.values) return bad(`${at}.options`, `only a pick_list or multi_pick has choices (${quote(f.key)} is ${f.type})`);
      if ("legacy_values" in f) return bad(`${at}.legacy_values`, `only a field with choices maps stored values`);
    }
    if (("min" in f || "max" in f) && !NUMBERS.has(f.type)) return bad(`${at}.min`, `min and max are for numbers (${quote(f.key)} is ${f.type})`);
    if ("min" in f && "max" in f && f.min > f.max) return bad(`${at}.min`, `min (${f.min}) is above max (${f.max})`);
    if ("max_length" in f && !TEXTS.has(f.type)) return bad(`${at}.max_length`, `max_length is for text (${quote(f.key)} is ${f.type})`);
    if ("pattern" in f) {
      if (!TEXTS.has(f.type)) return bad(`${at}.pattern`, `a pattern is for text (${quote(f.key)} is ${f.type})`);
      try { new RegExp(f.pattern, "u"); } catch (e) { return bad(`${at}.pattern`, `not a regular expression: ${e.message}`); }
    }
    if ("currency" in f && f.type !== "money") return bad(`${at}.currency`, `only money has a currency`);
    if ("many" in f && !["person", "record", "file"].includes(f.type)) return bad(`${at}.many`, `only a person, record or file field holds a list`);
    if (f.column && f.many && cols[f.key].kind !== "list") return bad(`${at}.many`, `${quote(f.key)} is a single-value column; a list needs an own field`);
    if (f.type === "file" && f.column) return bad(`${at}.type`, `a file field is an own field (its paths are kept with the record), not a column`);
    if ("record" in f) {
      if (f.type !== "record") return bad(`${at}.record`, `only a record field names an area`);
      const target = f.record.area;
      if (target !== "account" && !(AREA_IDS.includes(target) && ctx.areas[target]?.enabled !== false)) return bad(`${at}.record.area`, `${quote(target)} is not "account" or an enabled area (${AREA_IDS.join(", ")})`);
    }
    if ("folder" in f) {
      if (f.type !== "file") return bad(`${at}.folder`, `only a file field has a folder`);
      const m = /^\{folder:([a-z]+)\}\//.exec(f.folder);
      if (!m || !ctx.folders.includes(m[1])) return bad(`${at}.folder`, `must start with a data-room folder placeholder, {folder:<domain>}/, one of ${ctx.folders.map((d) => `{folder:${d}}`).join(", ")}`);
      if (f.folder.includes("..")) return bad(`${at}.folder`, `may not climb out of its folder ("..")`);
    }
    if ("fixed" in f) {
      if (!f.hidden) return bad(`${at}.fixed`, `only a hidden field takes a fixed value (a field people can see is filled in by them)`);
      const why = valueProblem(f, f.fixed);
      if (why) return bad(`${at}.fixed`, why);
    }
    if (f.hidden && f.required === true && !("fixed" in f) && !("default" in f)) {
      return bad(at, `${quote(f.key)} is required, so hiding it${area.columns === "listed" && !("hidden" in (ctx.declared?.fields?.[f.key] ?? {})) ? ` (columns: "listed" hides every column not named)` : ""} needs a "fixed" value the forms submit${f.options ? ` (one of ${list(f.options.map((o) => o.value))})` : ""}`);
    }
    if ("default" in f) {
      if (typeof f.default === "string" && f.default.startsWith("{")) {
        if (!TEMPLATE_DEFAULT.test(f.default)) return bad(`${at}.default`, `${quote(f.default)} is not a default template ({today}, {today+7d}, {me}, {account.owner})`);
        if (/^\{today/.test(f.default) && !DATES.has(f.type)) return bad(`${at}.default`, `${f.default} is a date, and ${quote(f.key)} is ${f.type}`);
        if (/^\{(me|account\.owner)\}$/.test(f.default) && !PEOPLE.has(f.type)) return bad(`${at}.default`, `${f.default} is a person, and ${quote(f.key)} is ${f.type}`);
      } else {
        const why = valueProblem(f, f.default);
        if (why) return bad(`${at}.default`, why);
      }
    }
    if ("renamed_from" in f) {
      if (f.column) return bad(`${at}.renamed_from`, `a column cannot be renamed; give it another label`);
      if (has(f.renamed_from)) return bad(`${at}.renamed_from`, `${quote(f.renamed_from)} is still a field of this area`);
    }
    if (f.index && f.index !== "none") {
      if (f.index === "sort" && !SORTABLE.has(f.type)) return bad(`${at}.index`, `a ${f.type} field cannot be sorted`);
      if (!f.column && (DATES.has(f.type) || NUMBERS.has(f.type))) indexes += 1;
    }
    if (f.computed) {
      if (f.column) return bad(`${at}.computed`, `a column holds what is written to it; a computed field is an own field`);
      const p = whereProblem(f.computed.when.map((w) => w.if), area, `${at}.computed.when`);
      if (p) return p;
      for (const [i, w] of f.computed.when.entries()) {
        const why = valueProblem(f, w.then);
        if (why) return bad(`${at}.computed.when[${i}].then`, why);
      }
      if ("else" in f.computed && f.computed.else !== null) {
        const why = valueProblem(f, f.computed.else);
        if (why) return bad(`${at}.computed.else`, why);
      }
    }
  }
  if (indexes > LIMITS.indexes_per_table) return bad("fields", `${indexes} own fields ask for an index; a table takes at most ${LIMITS.indexes_per_table}`);
  // A computed field may read another, never itself through others.
  {
    const deps = Object.fromEntries(Object.values(fields).filter((f) => f.computed).map((f) => [f.key, f.computed.when.flatMap((w) => Object.keys(w.if)).filter((k) => fields[k]?.computed)]));
    const visiting = new Set();
    const done = new Set();
    const cycle = (k) => {
      if (done.has(k)) return null;
      if (visiting.has(k)) return k;
      visiting.add(k);
      for (const d of deps[k] ?? []) { const c = cycle(d); if (c) return c; }
      visiting.delete(k);
      done.add(k);
      return null;
    };
    for (const k of Object.keys(deps)) { const c = cycle(k); if (c) return bad(`fields.${c}.computed`, `${quote(c)} is computed from itself (through ${Object.keys(deps).join(", ")})`); }
  }

  // --- the title template -----------------------------------------------------------------------------------------
  if (area.title) {
    for (const m of area.title.matchAll(/\{([^{}]+)\}/g)) if (!isFieldRef(m[1])) return unknown("title", m[1]);
  }
  if (area.id?.field && !has(area.id.field)) return unknown("id.field", area.id.field);
  if (area.id?.pattern) { try { new RegExp(area.id.pattern, "u"); } catch (e) { return bad("id.pattern", `not a regular expression: ${e.message}`); } }

  // --- the lifecycle ----------------------------------------------------------------------------------------------
  const lc = area.lifecycle;
  if (kind === "task" && !lc) return bad("lifecycle", `the tasks area needs a lifecycle: the field whose states move a task, each mapped to a category`);
  if (lc) {
    const f = fields[lc.field];
    if (!f) return unknown("lifecycle.field", lc.field);
    if (f.type !== "pick_list") return bad("lifecycle.field", `${quote(lc.field)} must be a pick_list (its choices are the states)`);
    if (f.computed) return bad("lifecycle.field", `${quote(lc.field)} is computed; a state is moved, not computed`);
    const states = f.options.map((o) => o.value);
    const cats = lc.categories ?? {};
    const missing = states.filter((s) => !(s in cats));
    if (missing.length) return bad("lifecycle.categories", `every state needs a category (${CATEGORIES.join(", ")}); ${list(missing)} ${missing.length === 1 ? "has" : "have"} none`);
    for (const s of Object.keys(cats)) if (!states.includes(s)) return bad(`lifecycle.categories.${s}`, `${quote(s)} is not a state of ${lc.field} (${list(states)})`);
    if (!states.some((s) => cats[s] === "done")) return bad("lifecycle.categories", `at least one state must be "done" (how base code knows a record is finished)`);
    if (kind === "task" && lc.field === "status") {
      // The status column IS the contract with the task-workflow service: its values keep their meaning.
      for (const s of states) if (CATEGORY_STATUS[cats[s]] !== s) return bad(`lifecycle.categories.${s}`, `the status ${quote(s)} is the category ${quote(Object.keys(CATEGORY_STATUS).find((c) => CATEGORY_STATUS[c] === s))}; to give a task other states, put the lifecycle on an own pick_list field`);
    }
    if (kind === "task" && lc.field !== "status" && f.column) return bad("lifecycle.field", `a task's lifecycle is the "status" column or an own pick_list field, not ${quote(lc.field)}`);
    // A period's state is the cycles.state column: the system's rollover opens, starts and closes periods by its
    // states' categories (agent/lib/period-area.ts), so the states are the column's, whatever they are called.
    if (kind === "period" && lc.field !== "state") return bad("lifecycle.field", `a period's lifecycle is its "state" column (its choices are the states, each with a category), not ${quote(lc.field)}`);
    if (lc.initial !== undefined && !states.includes(lc.initial)) return bad("lifecycle.initial", `${quote(lc.initial)} is not a state of ${lc.field} (${list(states)})`);
    for (const [i, t] of (lc.transitions ?? []).entries()) {
      const at = `lifecycle.transitions[${i}]`;
      for (const s of t.from === "*" ? [] : t.from) if (!states.includes(s)) return bad(`${at}.from`, `${quote(s)} is not a state of ${lc.field} (${list(states)})`);
      if (!states.includes(t.to)) return bad(`${at}.to`, `${quote(t.to)} is not a state of ${lc.field} (${list(states)})`);
      for (const k of t.requires ?? []) if (!has(k)) return unknown(`${at}.requires`, k);
      // "{entered_by}": the person who moved the record into the state it leaves may not make the move (four eyes).
      if (t.not_by !== undefined && t.not_by !== "{entered_by}") {
        if (!has(t.not_by)) return unknown(`${at}.not_by`, t.not_by);
        if (!PEOPLE.has(fields[t.not_by].type)) return bad(`${at}.not_by`, `${quote(t.not_by)} must be a person field (it names who may not make the move)`);
      }
      for (const [k, v] of Object.entries(t.set ?? {})) {
        if (!has(k)) return unknown(`${at}.set`, k);
        if (k === lc.field) return bad(`${at}.set.${k}`, `the move itself sets ${quote(k)}`);
        // "{now}": the time of the move (agent/lib/record-lifecycle.ts resolveStamp), on a date or time field.
        if (v === "{now}") { if (!DATES.has(fields[k].type)) return bad(`${at}.set.${k}`, `{now} is a time, and ${quote(k)} is ${fields[k].type}`); continue; }
        if (v === "{me}" ? !PEOPLE.has(fields[k].type) : (typeof v === "string" && v.startsWith("{")) ? !TEMPLATE_DEFAULT.test(v) : Boolean(valueProblem(fields[k], v))) return bad(`${at}.set.${k}`, v === "{me}" ? `{me} is a person, and ${quote(k)} is ${fields[k].type}` : valueProblem(fields[k], v) ?? `${quote(v)} is not a value for ${quote(k)}`);
      }
    }
    if (lc.enforce === "strict") {
      if (lc.initial === undefined) return bad("lifecycle.initial", `a strict lifecycle needs an initial state (where every record starts)`);
      const reach = new Set([lc.initial]);
      for (let grew = true; grew;) {
        grew = false;
        for (const t of lc.transitions ?? []) if (!reach.has(t.to) && (t.from === "*" || t.from.some((s) => reach.has(s)))) { reach.add(t.to); grew = true; }
      }
      const stuck = states.filter((s) => !reach.has(s) && !f.options.find((o) => o.value === s)?.retired);
      if (stuck.length) return bad("lifecycle.transitions", `under "strict", ${list(stuck)} can never be reached from ${quote(lc.initial)}; add a transition to ${stuck.length === 1 ? "it" : "each"}, or mark it "retired"`);
    }
  }

  // --- relations --------------------------------------------------------------------------------------------------
  const rel = area.relations ?? {};
  for (const c of rel.containers ?? []) {
    if (!(c in TASK_CONTAINERS)) return bad("relations.containers", `${quote(c)} cannot hold tasks (it can be ${list(Object.keys(TASK_CONTAINERS))})`);
    if (ctx.areas[c]?.enabled === false) return bad("relations.containers", `${quote(c)} is not enabled in this deployment`);
  }
  for (const l of rel.links ?? []) if (!TASK_LINKS.includes(l)) return bad("relations.links", `${quote(l)} is not a link type (${list(TASK_LINKS)})`);
  if ((rel.containers || rel.links || "subtasks" in rel || "periods" in rel) && kind !== "task") return bad("relations", `containers, links, subtasks and periods describe a task; this is a ${kind} area`);
  if ("contains" in rel) {
    // A period holds the records filed into it (todos.cycleId) and is measured by them: "a filing is a set of obligations".
    if (kind !== "period") return bad("relations.contains", `only a period contains another area's records (a bounded container measured by them); the ${id} area is ${an(STRUCTURE[id].role)} ${STRUCTURE[id].role}: ${STRUCTURE[id].is}`);
    const c = rel.contains.area;
    if (!PERIOD_CONTAINS.includes(c)) return bad("relations.contains.area", `a period can contain ${list(PERIOD_CONTAINS)} (the records that carry a period's id), not ${quote(c)}`);
    if (ctx.areas[c]?.enabled === false) return bad("relations.contains.area", `${quote(c)} is not enabled in this deployment`);
    if (ctx.areas[c]?.relations?.periods === false) return bad("relations.contains.area", `the ${c} area says its records are never filed into a period (relations.periods: false)`);
    if (area.enabled === false || area.period?.mode === "off") return bad("relations.contains", `periods are off in this deployment, so they contain nothing`);
  }
  if ("structure" in (ctx.declared ?? {})) return bad("structure", `what the ${id} area IS (${STRUCTURE[id].is}) is fixed by the table it is stored in; a profile names it (label) and declares its relations. To hold another kind of thing, choose the area whose structure fits (docs/DEPLOYMENT_PROFILE.md "Choosing the area for a domain concept")`);
  if (rel.group?.field != null) {
    if (!has(rel.group.field)) return unknown("relations.group.field", rel.group.field);
  }

  // --- views ------------------------------------------------------------------------------------------------------
  const v = area.views ?? {};
  const visibleRef = (path, k) => (!isFieldRef(k) ? unknown(path, k) : k !== ACCOUNT_FIELD && fields[k].hidden ? bad(path, `${quote(k)} is hidden; a hidden field is not shown`) : null);
  if (v.available && v.default && !v.available.includes(v.default)) return bad("views.default", `${quote(v.default)} is not one of views.available (${list(v.available)})`);
  for (const [i, k] of (v.table?.columns ?? []).entries()) { const p = visibleRef(`views.table.columns[${i}]`, k); if (p) return p; }
  if (v.board?.by) {
    const p = visibleRef("views.board.by", v.board.by); if (p) return p;
    if (fields[v.board.by]?.type !== "pick_list") return bad("views.board.by", `a board's columns are a pick_list's choices, and ${quote(v.board.by)} is ${fields[v.board.by]?.type ?? "the account"}`);
  }
  for (const k of ["title", "badge"]) {
    const ref = v.board?.card?.[k];
    if (!ref || (k === "title" && ref === "title" && (area.title || has("title")))) continue;
    const p = visibleRef(`views.board.card.${k}`, ref); if (p) return p;
  }
  for (const [i, k] of (v.board?.card?.meta ?? []).entries()) { const p = visibleRef(`views.board.card.meta[${i}]`, k); if (p) return p; }
  for (const [k, ref] of [["views.timeline.start", v.timeline?.start], ["views.timeline.end", v.timeline?.end], ["views.calendar.date", v.calendar?.date]]) {
    if (!ref) continue;
    const p = visibleRef(k, ref); if (p) return p;
    if (!DATES.has(fields[ref].type)) return bad(k, `${quote(ref)} must be a date or datetime field (it is ${fields[ref].type})`);
  }
  for (const [i, flt] of (v.filters ?? []).entries()) {
    const at = `views.filters[${i}]`;
    if (!flt.field) return bad(at, `a filter names its field`);
    const p = visibleRef(`${at}.field`, flt.field); if (p) return p;
    if (flt.scope === "people" && flt.field !== ACCOUNT_FIELD && !PEOPLE.has(fields[flt.field].type)) return bad(`${at}.scope`, `a people filter needs a person field, and ${quote(flt.field)} is ${fields[flt.field].type}`);
    if (flt.presets?.some((x) => x.startsWith("due") || x === "overdue") && !DATES.has(fields[flt.field]?.type)) return bad(`${at}.presets`, `date presets need a date field, and ${quote(flt.field)} is ${fields[flt.field]?.type ?? "the account"}`);
  }
  const defaults = (v.sorts ?? []).filter((s) => s.default);
  if (defaults.length > 1) return bad("views.sorts", `only one sort is the default`);
  for (const [i, s] of (v.sorts ?? []).entries()) {
    const p = visibleRef(`views.sorts[${i}].field`, s.field); if (p) return p;
    if (s.field !== ACCOUNT_FIELD && !SORTABLE.has(fields[s.field].type)) return bad(`views.sorts[${i}].field`, `a ${fields[s.field].type} field cannot be sorted`);
  }
  for (const [i, k] of (v.group_by ?? []).entries()) { const p = visibleRef(`views.group_by[${i}]`, k); if (p) return p; }
  for (const [i, sec] of (v.detail?.sections ?? []).entries()) {
    for (const [j, k] of (sec.fields ?? []).entries()) { const p = visibleRef(`views.detail.sections[${i}].fields[${j}]`, k); if (p) return p; }
    if (!sec.fields?.length && !sec.related) return bad(`views.detail.sections[${i}]`, `a section lists fields or names what is related`);
  }
  if (v.create?.fields) {
    for (const [i, k] of v.create.fields.entries()) {
      const p = visibleRef(`views.create.fields[${i}]`, k); if (p) return p;
      if (k !== ACCOUNT_FIELD && (fields[k].computed || readOnly.has(k))) return bad(`views.create.fields[${i}]`, `${quote(k)} is ${fields[k].computed ? "computed" : "stamped by the system"}; a form cannot write it`);
    }
    if (!v.create.append) {
      const lacking = Object.values(fields).filter((f) => f.required === true && !f.hidden && !("default" in f) && !("fixed" in f) && !readOnly.has(f.key) && !(lc?.initial && lc.field === f.key) && !v.create.fields.includes(f.key));
      if (lacking.length) return bad("views.create.fields", `${list(lacking.map((f) => f.key))} ${lacking.length === 1 ? "is" : "are"} required and ${lacking.length === 1 ? "has" : "have"} no default, so the create form must ask for ${lacking.length === 1 ? "it" : "them"}`);
    }
  }

  // --- permissions ------------------------------------------------------------------------------------------------
  const perm = area.permissions ?? {};
  if (perm.own?.field && (!has(perm.own.field) || !PEOPLE.has(fields[perm.own.field].type))) return bad("permissions.own.field", `${quote(perm.own.field)} must be a person field of this area`);
  for (const k of Object.keys(perm.fields ?? {})) if (!has(k)) return unknown(`permissions.fields.${k}`, k);
  // Who may read is not enforced yet (agent/lib/record-permissions.ts): a list would show the row anyway, so a rule
  // that looks like it hides one is refused rather than ignored.
  if (perm.read !== undefined && perm.read !== "*") return bad("permissions.read", `who may read is not enforced yet, so it is "*" (everyone in the workspace); limit who may create, update or delete instead`);

  // --- reminders, recurrence, metrics, targets --------------------------------------------------------------------
  const ids = new Set();
  for (const [i, r] of (area.reminders ?? []).entries()) {
    const at = `reminders[${i}]`;
    if (ids.has(r.id)) return bad(`${at}.id`, `${quote(r.id)} is used twice`);
    ids.add(r.id);
    if (!has(r.date) && !(kind === "period" && ["startsAt", "endsAt"].includes(r.date))) return unknown(`${at}.date`, r.date);
    if (has(r.date) && !DATES.has(fields[r.date].type)) return bad(`${at}.date`, `${quote(r.date)} must be a date field`);
    for (const n of r.notify) {
      const m = /^\{(manager_of:([A-Za-z0-9_]+)|account\.owner|members_behind_target)\}$/.exec(n);
      if (m) { if (m[2] && (!has(m[2]) || !PEOPLE.has(fields[m[2]].type))) return bad(`${at}.notify`, `{manager_of:${m[2]}} needs a person field`); continue; }
      if (!has(n) || !PEOPLE.has(fields[n].type)) return bad(`${at}.notify`, `${quote(n)} must be a person field of this area or {manager_of:<field>} / {account.owner}`);
    }
    if (r.channels?.includes("email")) return bad(`${at}.channels`, `email reminders are off in this release; use "inbox" or "push"`);
    if (r.unless) { const p = whereProblem([r.unless], area, `${at}.unless`); if (p) return p; }
  }
  if (area.recurrence) {
    const rc = area.recurrence;
    if (rc.field) {
      if (!has(rc.field) || fields[rc.field].type !== "pick_list") return bad("recurrence.field", `${quote(rc.field)} must be a pick_list field of this area`);
      for (const k of Object.keys(rc.every ?? {})) if (!fields[rc.field].options.some((o) => o.value === k)) return bad(`recurrence.every.${k}`, `${quote(k)} is not a choice of ${rc.field}`);
    }
    if (rc.anchor && (!has(rc.anchor) || !DATES.has(fields[rc.anchor].type))) return bad("recurrence.anchor", `${quote(rc.anchor)} must be a date field of this area`);
    for (const k of rc.copy ?? []) if (!has(k)) return unknown("recurrence.copy", k);
  }
  for (const [i, m] of (area.metrics ?? []).entries()) {
    const at = `metrics[${i}]`;
    const wheres = [m.count?.where, m.ratio?.num, m.ratio?.den, m.sum?.where].filter(Boolean);
    const p = whereProblem(wheres, area, at); if (p) return p;
    if (m.sum && (!has(m.sum.field) || !NUMBERS.has(fields[m.sum.field].type))) return bad(`${at}.sum.field`, `${quote(m.sum.field)} must be a number field`);
    if ([m.count, m.ratio, m.sum].filter(Boolean).length !== 1) return bad(at, `a metric is one of count, ratio or sum`);
  }
  if (kind !== "period") {
    if (area.period) return bad("period", `only the periods area has period settings`);
    if (area.targets) return bad("targets", `only the periods area has targets`);
  }
  for (const [i, t] of (area.targets ?? []).entries()) {
    const at = `targets[${i}]`;
    const other = ctx.areas[t.measure.area];
    if (!other || t.measure.area === "periods" || other.enabled === false) return bad(`${at}.measure.area`, `${quote(t.measure.area)} must be an enabled area other than periods`);
    if (t.measure.date && (!other.fields[t.measure.date] || !DATES.has(other.fields[t.measure.date].type))) return bad(`${at}.measure.date`, `${quote(t.measure.date)} must be a date field of ${t.measure.area}`);
    if (t.measure.person && (!other.fields[t.measure.person] || !PEOPLE.has(other.fields[t.measure.person].type))) return bad(`${at}.measure.person`, `${quote(t.measure.person)} must be a person field of ${t.measure.area}`);
    if (t.measure.where) { const p = whereProblem([t.measure.where], other, `${at}.measure.where`); if (p) return p; }
    if (t.measure.scope === "contained" && rel.contains?.area !== t.measure.area) return bad(`${at}.measure.scope`, `"contained" counts the ${t.measure.area} records filed into a period, and this period does not contain ${t.measure.area} (relations.contains)`);
    if (t.measure.scope === "window" && !t.measure.date) return bad(`${at}.measure.scope`, `"window" counts the records dated inside the period; name the date field that places them (measure.date)`);
  }
  return null;
}

/** A where-clause's keys are fields of the area; `category` only on its lifecycle field. */
function whereProblem(wheres, area, at) {
  for (const w of wheres) {
    for (const [k, cond] of Object.entries(w ?? {})) {
      if (!(k in area.fields)) return { path: at, message: `${quote(k)} is not a field of this area` };
      if (isObj(cond) && "category" in cond) {
        if (area.lifecycle?.field !== k) return { path: at, message: `"category" is only for the lifecycle field (${area.lifecycle?.field ?? "none"})` };
        const cats = Array.isArray(cond.category) ? cond.category : [cond.category];
        for (const c of cats) if (!CATEGORIES.includes(c)) return { path: at, message: `${quote(c)} is not a category (${CATEGORIES.join(", ")})` };
      }
    }
  }
  return null;
}

/** Why a value cannot be stored in a field, or null. Templates are checked by the caller. */
export function valueProblem(f, value) {
  if (value === null) return null;
  const choices = f.options?.map((o) => o.value);
  switch (f.type) {
    case "pick_list":
      return typeof value === "string" && choices?.includes(value) ? null : `${quote(value)} is not one of ${list(choices ?? [])}`;
    case "multi_pick":
    case "tags":
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return `must be a list of strings`;
      return f.type === "multi_pick" && value.some((x) => !choices.includes(x)) ? `every value must be one of ${list(choices)}` : null;
    case "integer":
      return Number.isInteger(value) ? null : `must be a whole number`;
    case "number":
    case "percent":
    case "money":
      return typeof value === "number" && Number.isFinite(value) ? null : `must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `must be true or false`;
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : `must be a date written as year-month-day`;
    default:
      if (f.many) return Array.isArray(value) && value.every((x) => typeof x === "string") ? null : `must be a list of strings`;
      return typeof value === "string" && value.trim() !== "" ? null : `must be a non-empty string`;
  }
}

/**
 * A record area written in the new form, as the legacy `domains.<area>` its current readers take. Starts from the
 * legacy form the profile merged (`legacy`) and writes over it what the area says. An own field of a type the legacy
 * form does not have is left out of it (`dropped`), with the reason.
 */
const LEGACY_OWN = { text: "text", long_text: "long_text", number: "number", integer: "number", money: "number", percent: "percent", date: "date", email: "email", person: "email", link: "link", pick_list: "pick_list" };
export function raiseDomain(id, area, legacy, cols) {
  const d = structuredClone(legacy);
  const dropped = [];
  d.label = { ...area.label };
  if (area.description) d.description = area.description;
  if (area.id?.label) d.id_label = area.id.label;
  d.fields = {};
  const fields = orderedFields(area);
  let kindField = null;
  for (const f of fields.filter((x) => x.column)) {
    const spec = {};
    for (const k of ["label", "short_label", "help", "placeholder", "hidden", "fixed"]) if (k in f) spec[k] = f[k];
    if (cols[f.key].values && f.options) {
      const labelled = f.options.filter((o) => o.label !== undefined && o.label !== o.value);
      if (labelled.length || f.options.length < cols[f.key].values.length) spec.options = Object.fromEntries(f.options.map((o) => [o.value, o.label ?? o.value]));
    }
    if (cols[f.key].kind === "text" && f.type === "pick_list" && !kindField && !f.hidden) kindField = f;
    if (Object.keys(spec).length) d.fields[f.key] = spec;
  }
  d.kind_field = kindField ? kindField.key : null;
  d.kinds = kindField ? kindField.options.map((o) => o.value) : [];
  d.custom_fields = [];
  for (const f of fields.filter((x) => !x.column && !x.computed && !x.hidden)) {
    const type = f.many ? null : LEGACY_OWN[f.type];
    if (!type) { dropped.push(`${f.key} (${f.type}${f.many ? ", a list" : ""})`); continue; }
    const listed = area.views?.table?.columns ? area.views.table.columns.includes(f.key) : Boolean(f.show_in_list);
    d.custom_fields.push({
      key: f.key, label: f.label, type,
      ...(f.required === true ? { required: true } : {}),
      ...(type === "pick_list" ? { options: f.options.map((o) => o.value) } : {}),
      ...(f.help ? { help: f.help } : {}),
      ...(listed ? { show_in_list: true } : {}),
    });
  }
  const formable = (k) => cols[k] && cols[k].kind !== "list" && !area.fields[k]?.hidden;
  d.create_fields = (area.views?.create?.fields ?? []).filter(formable);
  const detail = (area.views?.detail?.sections ?? []).flatMap((s) => s.fields ?? []);
  d.detail_fields = [...new Set(detail)].filter(formable);
  if (id === "implementations") {
    const g = area.relations?.group;
    if (g && "field" in g) d.group_by = g.field;
    if (g?.label) d.group_label = { ...g.label };
  }
  return { domain: d, dropped };
}

/** The periods area as the legacy `work_periods`. */
export function raisePeriods(area, legacy) {
  const wp = structuredClone(legacy);
  wp.label = { ...area.label };
  for (const [k, v] of Object.entries(area.period ?? {})) if (k in wp) wp[k] = structuredClone(v);
  if (area.enabled === false) wp.mode = "off";
  return wp;
}

/** Does a profile file state an area in the legacy form, the new form, or both? */
export function formsIn(doc) {
  const legacy = new Set();
  const fresh = new Set();
  for (const id of ["deployments", "implementations"]) if (isObj(doc.domains) && id in doc.domains) legacy.add(id);
  if ("work_periods" in doc) legacy.add("periods");
  if (isObj(doc.records?.areas)) for (const id of Object.keys(doc.records.areas)) fresh.add(id);
  return { legacy, fresh };
}

/**
 * What the build says about the mapping: each area's structural role (STRUCTURE) next to what this deployment calls
 * it, so a concept put in the wrong area is visible when the profile is built, and a few warnings. The warnings are
 * deliberately conservative: they read the definition's SHAPE (a column that carries the area's role, a date a record
 * falls due on), never guess at a label's meaning, and never fail the build. `areas`: every compiled area, by id.
 */
export function structureNote(areas) {
  const word = (id) => areas[id]?.label?.plural ?? id;
  const lines = [];
  for (const id of AREA_IDS) {
    const a = areas[id];
    const s = STRUCTURE[id];
    const contains = id === "periods" && a.relations?.contains ? `; contains ${quote(word(a.relations.contains.area))}${a.relations.contains.completion === false ? "" : ", measured by them"}` : "";
    lines.push(`${id} [${s.role}], shown as ${quote(word(id))}${a.enabled === false || a.period?.mode === "off" ? " (off)" : ""}: ${s.is}${contains}`);
  }
  const warnings = [];
  const d = areas.deployments;
  if (d && d.enabled !== false && d.redefined !== false) {
    const due = Object.values(d.fields).find((f) => !f.column && !f.hidden && DATES.has(f.type) && (/(^|_)due($|_)/.test(f.key) || /\bdue\b/i.test(f.label ?? "")));
    if (due) {
      warnings.push(`the deployments area ("${word("deployments")}") has a date it falls due on (${quote(due.key)}), and a deployment is ${STRUCTURE.deployments.is}: it has no due date. A record that falls due is a unit of work (tasks), or, when it is a set of units due together, a period that contains them (periods, relations.contains: { "area": "tasks" }). See docs/DEPLOYMENT_PROFILE.md "Choosing the area for a domain concept"`);
    }
    const role = ["state", "health"].map((r) => STRUCTURE.deployments.columns[r]);
    if (role.every((k) => d.fields[k]?.hidden)) {
      warnings.push(`the deployments area ("${word("deployments")}") hides both columns that carry what a deployment is (${role.map(quote).join(", ")}: its release state and its health). If these records are not changes rolled out to an account, another area fits them better: see docs/DEPLOYMENT_PROFILE.md "Choosing the area for a domain concept"`);
    }
  }
  return { lines, warnings };
}
