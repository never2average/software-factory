#!/usr/bin/env node
// Merges profiles/*.json (filename order; later wins; objects merge deeply, arrays and scalars replace) into the
// deployment profile and writes it where both halves of the app can import it as plain data:
//   lib/deployment-profile.generated.ts         (web)
//   agent/lib/deployment-profile.generated.ts   (agent)
// A deployment never edits profiles/00-default.json; it ADDS profiles/NN-<name>.json (a subagent pack ships one,
// a branding step may add another). See docs/DEPLOYMENT_PROFILE.md.   npm run build:deployment-profile
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSource } from "./lib/profile-library.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// PROFILES_DIR + --check let a test validate another set of profiles without touching the generated files.
const DIR = process.env.PROFILES_DIR ? process.env.PROFILES_DIR : join(ROOT, "profiles");
const CHECK_ONLY = process.argv.includes("--check") || process.argv.includes("--print");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function merge(base, over, path, shape) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === "$comment") continue;
    const here = path ? `${path}.${k}` : k;
    // dataroom.domains keys and free-form maps aside, a key the default does not have is a typo, not an extension.
    if (shape && !(k in shape) && !FREE.some((f) => path === f) && !FIELD_MAP.test(path) && !((k === "description" || k === "label") && path.startsWith("dataroom.domains."))) fail(`${here}: unknown key (not in profiles/00-default.json)`);
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v, here, shape?.[k]) : v;
  }
  return out;
}
// "$comment" is documentation at any depth, never data.
const uncomment = (v) => (Array.isArray(v) ? v.map(uncomment) : isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "$comment").map(([k, x]) => [k, uncomment(x)])) : v);
// library.sources is a map of the deployment's own source ids (scripts/lib/profile-library.mjs validates each).
const FREE = ["dataroom.domains", "library.sources"];
// domains.<area>.fields is a map keyed by real field keys; its entries are validated against the schemas below.
const FIELD_MAP = /^domains\.(deployments|implementations)\.fields(\.|$)/;
let current = "";
function fail(msg) { console.error(`profiles/${current}: ${msg}`); process.exit(1); }

const files = readdirSync(DIR).filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f)).sort();
if (files[0] !== "00-default.json") { console.error("profiles/00-default.json is missing"); process.exit(1); }
// --- the data-room domains: an id, the folder its files are STORED under, the label people read ------------------
// The ids are what code and profiles call a domain. The folder is the profile's (dataroom.domains.<id>.folder), so
// base code spells no stored name; the names the folders had while they WERE in the code are in one place,
// scripts/lib/legacy-dataroom-folders.json, and a profile written then (keyed by them) is still understood.
const DOMAINS = ["accounts", "platform", "deliveries", "solutions", "projects", "tickets", "people"];
const LEGACY_FOLDERS = uncomment(JSON.parse(readFileSync(join(ROOT, "scripts/lib/legacy-dataroom-folders.json"), "utf8")));
for (const id of [...DOMAINS, "uploads"]) if (typeof LEGACY_FOLDERS[id] !== "string") { console.error(`scripts/lib/legacy-dataroom-folders.json: no legacy folder for "${id}"`); process.exit(1); }
const LEGACY_KEY = new Map(DOMAINS.map((id) => [LEGACY_FOLDERS[id], id]));
/** domain id -> the profile file and the old key it named the domain by. */
const namedByLegacyKey = new Map();
/** Domain ids (and "uploads") whose stored folder a profile other than the default states. */
const folderStated = new Set();
/** A profile's dataroom.domains with every old key (the folder's former name) read as the domain's id. */
function readDomains(doc, file) {
  const domains = doc.dataroom?.domains;
  if (file !== "00-default.json" && doc.dataroom && "uploads_folder" in doc.dataroom) folderStated.add("uploads");
  if (!isObj(domains)) return;
  for (const key of Object.keys(domains)) {
    const id = DOMAINS.includes(key) ? key : LEGACY_KEY.get(key);
    if (!id) continue; // refused below, with the list of domains
    if (id !== key) {
      if (file === "00-default.json") fail(`dataroom.domains.${key}: the default profile names a domain by its id ("${id}")`);
      if (id in domains) fail(`dataroom.domains.${key} and dataroom.domains.${id} are the same domain ("${key}" is its former name). Keep one entry, under "${id}".`);
      domains[id] = domains[key];
      delete domains[key];
      if (!namedByLegacyKey.has(id)) namedByLegacyKey.set(id, { file, key });
    }
    if (file !== "00-default.json" && isObj(domains[id]) && "folder" in domains[id]) folderStated.add(id);
  }
}
let profile = {}; let shape = null; let defaults = null;
for (const f of files) {
  current = f;
  let doc;
  try { doc = JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch (e) { fail(`not valid JSON: ${e.message}`); }
  if (!isObj(doc)) fail("must be a JSON object");
  doc = uncomment(doc);
  readDomains(doc, f);
  profile = shape ? merge(profile, doc, "", shape) : merge({}, doc, "", null);
  if (!shape) { shape = profile; defaults = structuredClone(profile); }
}

// What the rest of the code relies on. Fail the build, never the page.
current = files.at(-1);
for (const d of Object.keys(profile.dataroom.domains)) if (!DOMAINS.includes(d)) fail(`dataroom.domains.${d}: not a data-room domain (${DOMAINS.join(", ")}). A profile relabels or hides domains, and says where each is stored; it cannot add one.`);
// A stored folder is one path segment a file system and a blob key both take, and never a name the store itself uses.
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_FOLDERS = ["orgs", "_versions"];
const checkFolder = (at, name) => {
  if (typeof name !== "string" || !FOLDER_NAME.test(name) || name.includes("..")) fail(`${at}: ${JSON.stringify(name)} is not a folder name. Use letters, digits, ".", "_" or "-", starting with a letter or a digit (for example "Accounts").`);
  if (RESERVED_FOLDERS.includes(name) || /\.[A-Za-z0-9]+$/.test(name)) fail(`${at}: "${name}" is a name the data room keeps for itself (or reads as a file). Pick another folder name.`);
};
for (const d of DOMAINS) {
  const v = profile.dataroom.domains[d];
  if (!isObj(v)) fail(`dataroom.domains.${d} must be an object with a "folder"`);
  for (const k of Object.keys(v)) if (!["folder", "label", "visible", "description"].includes(k)) fail(`dataroom.domains.${d}.${k}: unknown key (a domain takes folder, label, visible, description)`);
  checkFolder(`dataroom.domains.${d}.folder`, v.folder);
  // No label of its own: people read the folder's name.
  if (typeof v.label !== "string" || !v.label.trim()) v.label = v.folder;
  if (typeof v.visible !== "boolean") v.visible = true;
  if ("description" in v && (typeof v.description !== "string" || !v.description.trim())) delete v.description;
}
checkFolder("dataroom.uploads_folder", profile.dataroom.uploads_folder);
{
  const seen = new Map();
  for (const [at, name] of [...DOMAINS.map((d) => [`dataroom.domains.${d}.folder`, profile.dataroom.domains[d].folder]), ["dataroom.uploads_folder", profile.dataroom.uploads_folder]]) {
    const other = seen.get(name.toLowerCase());
    if (other) fail(`${at}: "${name}" is also ${other}. Two domains cannot be stored in one folder.`);
    seen.set(name.toLowerCase(), at);
  }
}
// THE SAFETY NET for a deployment that already holds files. A profile that names a domain by its former key was
// written when the folder had that name, so its data room is, as far as anyone can tell from here, stored under it.
// Building it with another folder would leave those files behind and write new ones beside them. Refused, with the
// line to add: nothing is ever moved or guessed.
for (const [id, { file, key }] of namedByLegacyKey) {
  const folder = profile.dataroom.domains[id].folder;
  if (folderStated.has(id) || folder === LEGACY_FOLDERS[id]) continue;
  current = file;
  fail(
    `dataroom.domains.${key}: this profile calls the domain by the name its folder used to have. That folder name is now a setting, ` +
      `and without one this deployment would store the domain under "${folder}/": files already under "${key}/" would be left behind ` +
      `and new ones written beside them. Nothing was built. If this deployment's data room already has a "${key}/" folder, add ` +
      `"folder": "${key}" to that entry (or, in any profile file: {"dataroom": {"domains": {"${id}": {"folder": "${key}"}}}}); ` +
      `its files stay exactly where they are. If it has no files yet, add "folder": "${folder}" to say so.`,
  );
}
current = files.at(-1);
if (!profile.dataroom.domains.accounts.visible) fail("dataroom.domains.accounts cannot be hidden: every record hangs off it");
if (!Array.isArray(profile.chat.hero_lines) || !profile.chat.hero_lines.length || profile.chat.hero_lines.some((l) => typeof l !== "string" || !l.trim())) fail("chat.hero_lines must be a non-empty list of strings");
if (typeof profile.chat.user_messages.collapse !== "boolean") fail("chat.user_messages.collapse must be true or false");
if (!Number.isInteger(profile.chat.user_messages.collapsed_lines) || profile.chat.user_messages.collapsed_lines < 2 || profile.chat.user_messages.collapsed_lines > 40) fail("chat.user_messages.collapsed_lines must be a whole number from 2 to 40");
for (const k of ["owner", "secondary_owner"]) if (typeof profile.vocabulary[k] !== "string" || !profile.vocabulary[k].trim()) fail(`vocabulary.${k} must be a non-empty string`);
for (const k of ["singular", "plural"]) for (const n of ["account", "member"]) if (typeof profile.vocabulary[n]?.[k] !== "string" || !profile.vocabulary[n][k].trim()) fail(`vocabulary.${n}.${k} must be a non-empty string`);
if (profile.dataroom.seed !== null) {
  if (!Array.isArray(profile.dataroom.seed)) fail("dataroom.seed must be null (the built-in starter tree) or a list of { path, content }");
  for (const s of profile.dataroom.seed) {
    if (typeof s?.path !== "string" || typeof s?.content !== "string" || s.path.includes("..") || s.path.startsWith("/")) fail(`dataroom.seed entry ${JSON.stringify(s?.path)}: needs a relative "path" and a "content" string`);
    const roots = [...DOMAINS.map((d) => profile.dataroom.domains[d].folder), profile.dataroom.uploads_folder];
    if (s.path !== "README.md" && !roots.includes(s.path.split("/")[0])) fail(`dataroom.seed path "${s.path}" does not start with one of this profile's data-room folders (${roots.join(", ")})`);
  }
}
// --- domains: the two record areas a deployment may redefine ---------------------------------------------------
// Field keys and enum values are read from the SOURCE (the zod schemas and the drizzle tables), so a profile
// cannot label a field that does not exist or an enum value the API would never see.
const zodSrc = readFileSync(join(ROOT, "agent/lib/customer-schema.ts"), "utf8");
const dbSrc = readFileSync(join(ROOT, "agent/lib/db/schema.ts"), "utf8");
function zodFields(name) {
  const start = zodSrc.indexOf(`export const ${name} = z.object({`);
  if (start < 0) { console.error(`gen-deployment-profile: ${name} not found in agent/lib/customer-schema.ts`); process.exit(1); }
  const block = zodSrc.slice(start, zodSrc.indexOf("\n});", start));
  const out = {};
  const entries = block.split(/\n(?=  [A-Za-z0-9_]+: )/).slice(1);
  for (const e of entries) {
    const key = e.match(/^  ([A-Za-z0-9_]+): /)[1];
    const en = e.match(/z\.enum\(\[([\s\S]*?)\]\)/);
    out[key] = en ? { type: "enum", values: [...en[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) }
      : /z\.array\(/.test(e) ? { type: "list" }
      : /percentSchema|z\.number\(/.test(e) ? { type: "number" } : { type: "text" };
  }
  return out;
}
function dbColumns(name) {
  const start = dbSrc.indexOf(`export const ${name} = pgTable(`);
  if (start < 0) { console.error(`gen-deployment-profile: table ${name} not found in agent/lib/db/schema.ts`); process.exit(1); }
  const end = dbSrc.indexOf("\nexport const ", start + 1);
  const block = dbSrc.slice(start, end < 0 ? undefined : end);
  const out = {};
  const parts = block.split(/\n(?=\s+[A-Za-z0-9_]+: (?:text|doublePrecision|bigint|integer|jsonb|boolean|timestamp)\()/).slice(1);
  for (const c of parts) {
    const [, key, kind] = c.match(/^\s+([A-Za-z0-9_]+): (\w+)\(/);
    const stmt = c.split(/\n\s*\},?\n|\n\s*\(t\) =>/)[0];
    out[key] = { type: kind === "jsonb" ? "list" : kind === "text" ? "text" : "number", required: /\.notNull\(\)|\.primaryKey\(\)/.test(stmt) && !/\.default/.test(stmt) };
  }
  return out;
}
const AREAS = { deployments: ["deploymentSchema", "deployments"], implementations: ["implementationSchema", "implementation"] };
// `custom` is the jsonb column that holds the profile's OWN fields (custom_fields below): not a field to relabel.
const SYSTEM_KEYS = ["orgId", "customerId", "displayName", "custom"];
const CUSTOM_FIELD_KEYS = ["key", "label", "type", "required", "options", "help", "show_in_list"];
const CUSTOM_FIELD_TYPES = ["text", "long_text", "number", "percent", "date", "email", "link", "pick_list"];
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const FIELD_SPEC_KEYS = ["label", "short_label", "help", "placeholder", "hidden", "fixed", "options"];
/**
 * A list of custom_fields (the deployment's OWN fields on a record: `domains.<area>.custom_fields` and
 * `account_fields.custom_fields`). The same rules wherever a list is declared; `builtIn` is every key the record
 * already has, in any spelling, so an own field can never shadow a real one.
 */
function checkCustomFields(at, list, builtInKeys, table, relabelAt) {
  if (!Array.isArray(list)) fail(`${at}.custom_fields must be a list of fields (an empty list when the record has none)`);
  const builtIn = new Set([...builtInKeys].flatMap((k) => [k, snake(k), k.toLowerCase()]));
  const seenKeys = new Set(); const seenLabels = new Map();
  list.forEach((f, i) => {
    const here = `${at}.custom_fields[${i}]`;
    if (!isObj(f)) fail(`${here} must be an object with a key, a label and a type`);
    for (const k of Object.keys(f)) if (!CUSTOM_FIELD_KEYS.includes(k)) fail(`${here}.${k}: unknown key (a custom field takes ${CUSTOM_FIELD_KEYS.join(", ")})`);
    if (typeof f.key !== "string" || !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(f.key) || f.key.length > 40) fail(`${here}.key must be snake_case: lowercase letters, digits and single underscores, starting with a letter, at most 40 characters (for example "target_price")`);
    if (builtIn.has(f.key)) fail(`${here}.key: "${f.key}" is already a built-in field of the ${table} table. ${relabelAt ? `Relabel that one under ${relabelAt}, or pick another key` : "Pick another key"}`);
    if (seenKeys.has(f.key)) fail(`${here}.key: "${f.key}" is declared twice in ${at}.custom_fields; a key names one field`);
    seenKeys.add(f.key);
    if (typeof f.label !== "string" || !f.label.trim()) fail(`${here}.label must be a non-empty string (what a person reads for "${f.key}")`);
    if (seenLabels.has(f.label.trim().toLowerCase())) fail(`${here}.label: "${f.label}" is also the label of "${seenLabels.get(f.label.trim().toLowerCase())}"; two fields with one label cannot be told apart`);
    seenLabels.set(f.label.trim().toLowerCase(), f.key);
    if (!CUSTOM_FIELD_TYPES.includes(f.type)) fail(`${here}.type: ${JSON.stringify(f.type)} is not a field type. Use one of ${CUSTOM_FIELD_TYPES.join(", ")}`);
    for (const k of ["required", "show_in_list"]) if (k in f && typeof f[k] !== "boolean") fail(`${here}.${k} must be true or false`);
    if ("help" in f && (typeof f.help !== "string" || !f.help.trim())) fail(`${here}.help must be a non-empty string`);
    if (f.type === "pick_list") {
      if (!Array.isArray(f.options) || !f.options.length || f.options.some((o) => typeof o !== "string" || !o.trim())) fail(`${here}.options: a pick_list needs a non-empty list of choices, each a non-empty string`);
      if (new Set(f.options.map((o) => o.trim().toLowerCase())).size !== f.options.length) fail(`${here}.options lists the same choice twice`);
    } else if ("options" in f) fail(`${here}.options: only a pick_list has options ("${f.key}" is ${f.type})`);
  });
}
const domainFields = {};
for (const [area, [zodName, table]] of Object.entries(AREAS)) {
  const z = zodFields(zodName); const db = dbColumns(table);
  const all = {};
  for (const k of new Set([...Object.keys(z), ...Object.keys(db)])) {
    if (SYSTEM_KEYS.includes(k)) continue;
    all[k] = { type: z[k]?.type ?? db[k].type, ...(z[k]?.values ? { values: z[k].values } : {}), column: k in db, required: Boolean(db[k]?.required) };
  }
  domainFields[area] = all;
}
const validValue = (meta, v) => (meta.type === "enum" ? meta.values.includes(v) : meta.type === "number" ? typeof v === "number" && Number.isFinite(v) : meta.type === "text" ? typeof v === "string" && v.trim() !== "" : false);
for (const area of Object.keys(AREAS)) {
  const at = `domains.${area}`; const d = profile.domains?.[area]; const known = domainFields[area];
  if (!isObj(d)) fail(`${at} must be an object`);
  for (const n of ["singular", "plural"]) if (typeof d.label?.[n] !== "string" || !d.label[n].trim()) fail(`${at}.label.${n} must be a non-empty string`);
  for (const n of ["description", "id_label"]) if (typeof d[n] !== "string" || !d[n].trim()) fail(`${at}.${n} must be a non-empty string`);
  if (!isObj(d.fields)) fail(`${at}.fields must be an object keyed by field`);
  for (const [key, spec] of Object.entries(d.fields)) {
    const here = `${at}.fields.${key}`; const meta = known[key];
    if (!meta) fail(`${here}: unknown field key. It is not a field of ${AREAS[area][0]} (agent/lib/customer-schema.ts) or a column of the ${AREAS[area][1]} table (agent/lib/db/schema.ts)`);
    if (!isObj(spec)) fail(`${here} must be an object`);
    for (const k of Object.keys(spec)) if (!FIELD_SPEC_KEYS.includes(k)) fail(`${here}.${k}: unknown key (a field takes ${FIELD_SPEC_KEYS.join(", ")})`);
    for (const k of ["label", "short_label", "help", "placeholder"]) if (k in spec && (typeof spec[k] !== "string" || !spec[k].trim())) fail(`${here}.${k} must be a non-empty string`);
    if ("hidden" in spec && typeof spec.hidden !== "boolean") fail(`${here}.hidden must be true or false`);
    if ("options" in spec) {
      if (meta.type !== "enum") fail(`${here}.options: ${key} is not an enum field, so it has no values to label`);
      if (!isObj(spec.options)) fail(`${here}.options must map an enum value to its display label`);
      const seen = new Map();
      for (const [value, label] of Object.entries(spec.options)) {
        if (!meta.values.includes(value)) fail(`${here}.options.${JSON.stringify(value)}: not a value of ${key} (${meta.values.join(", ")})`);
        if (typeof label !== "string" || !label.trim()) fail(`${here}.options.${JSON.stringify(value)} must be a non-empty display label`);
        if (seen.has(label)) fail(`${here}.options: "${label}" labels both ${seen.get(label)} and ${value}; a display label must map back to one value`);
        seen.set(label, value);
      }
    }
    if ("fixed" in spec) {
      if (!spec.hidden) fail(`${here}.fixed: only a hidden field takes a fixed value (a field people can see is filled in by them)`);
      if (!validValue(meta, spec.fixed)) fail(`${here}.fixed: ${JSON.stringify(spec.fixed)} is not a valid value for ${key}${meta.values ? ` (${meta.values.join(", ")})` : ` (a ${meta.type === "number" ? "number" : "non-empty string"})`}`);
    }
    if (spec.hidden && meta.required && !("fixed" in spec)) fail(`${here}: ${key} is required, so hiding it needs a "fixed" value for the forms to submit${meta.values ? ` (one of ${meta.values.join(", ")})` : ""}`);
  }
  for (const list of ["create_fields", "detail_fields"]) {
    if (!Array.isArray(d[list])) fail(`${at}.${list} must be a list of field keys`);
    for (const key of d[list]) {
      if (!known[key]?.column || known[key].type === "list") fail(`${at}.${list}: "${key}" is not a single-value column of the ${AREAS[area][1]} table, so a form cannot write it`);
      if (d.fields[key]?.hidden) fail(`${at}.${list}: "${key}" is hidden; a hidden field is not shown on a form`);
    }
  }
  if (!Array.isArray(d.kinds) || d.kinds.some((k) => typeof k !== "string" || !k.trim()) || new Set(d.kinds).size !== d.kinds.length) fail(`${at}.kinds must be a list of distinct non-empty strings`);
  if (d.kind_field !== null) {
    const meta = known[d.kind_field];
    if (!meta?.column || meta.type !== "text") fail(`${at}.kind_field: "${d.kind_field}" must be a free-text column of the ${AREAS[area][1]} table (an enum cannot carry new kinds)`);
    if (d.fields[d.kind_field]?.hidden) fail(`${at}.kind_field: "${d.kind_field}" is hidden`);
    if (!d.kinds.length) fail(`${at}.kinds must list the kinds when kind_field is set`);
  } else if (d.kinds.length) fail(`${at}.kind_field must name the field that carries the kinds`);
  // custom_fields: the deployment's OWN fields on the area, stored by key in the table's `custom` column and
  // validated on every write by agent/lib/custom-fields.ts. No built-in column is involved, so none may be shadowed.
  checkCustomFields(at, d.custom_fields, new Set([...Object.keys(known), ...SYSTEM_KEYS]), AREAS[area][1], `${at}.fields`);
  if (area === "implementations") {
    if (d.group_by !== null && (!known[d.group_by]?.column || known[d.group_by].type !== "text")) fail(`${at}.group_by: "${d.group_by}" must be a free-text column of the implementation table`);
    if (d.group_by !== null && d.fields[d.group_by]?.hidden) fail(`${at}.group_by: "${d.group_by}" is hidden`);
    for (const n of ["singular", "plural"]) if (typeof d.group_label?.[n] !== "string" || !d.group_label[n].trim()) fail(`${at}.group_label.${n} must be a non-empty string`);
  }
}

// --- account_fields: fields of the account record itself the MODEL never reads or writes -------------------------
{
  const account = zodFields("customerSchema");
  const hidden = profile.account_fields?.hidden;
  if (!Array.isArray(hidden) || hidden.some((k) => typeof k !== "string")) fail("account_fields.hidden must be a list of field keys (empty to hide none)");
  // An owner field may be named by either of its keys: the record contract's (fdeOwner, aeOwner) or the neutral one
  // beside it (accountOwner, secondaryOwner; agent/lib/owner-keys.ts). Either hides the one field, and naming both
  // keys of a pair is naming it twice.
  const recordKey = (key) => ({ accountOwner: "fdeOwner", secondaryOwner: "aeOwner" })[key] ?? key;
  for (const key of hidden) {
    if (!(recordKey(key) in account)) fail(`account_fields.hidden: "${key}" is not a field of customerSchema (agent/lib/customer-schema.ts). Known: ${Object.keys(account).join(", ")}`);
    if (key === "id" || key === "name") fail(`account_fields.hidden: "${key}" cannot be hidden; every record is found and named by it`);
  }
  if (new Set(hidden.map(recordKey)).size !== hidden.length) fail("account_fields.hidden lists a field twice");
  // `custom` is where account_fields.custom_fields live, not a field of its own: a deployment that wants no own
  // fields declares none, and one that hides an own field simply does not declare it.
  if (hidden.includes("custom")) fail('account_fields.hidden: "custom" cannot be hidden; it holds account_fields.custom_fields. Declare no custom fields to have none');
  // custom_fields: the deployment's OWN fields on the account record, stored by key in customers.custom. Never a
  // customerSchema key or a customers column in any spelling, hidden or not: a hidden built-in field is still a
  // real one, and an own field under its name would be two values for one word.
  checkCustomFields("account_fields", profile.account_fields.custom_fields, new Set([...Object.keys(account), ...Object.keys(dbColumns("customers")), "customerId", "customerName", "orgId", "custom"]), "customers", null);
}

// --- work_periods: the time-boxed periods that group tasks, switched and worded by the profile ---------------------
{
  const wp = profile.work_periods; const at = "work_periods";
  if (!isObj(wp)) fail(`${at} must be an object`);
  const MODES = ["off", "team", "individual"];
  if (!MODES.includes(wp.mode)) fail(`${at}.mode: ${JSON.stringify(wp.mode)} is not a mode. Use "team" (one shared period with a lead, a capacity and a burndown), "individual" (each person's own items within the period) or "off" (no periods in this deployment)`);
  for (const k of ["label", "list_label", "item_label"]) {
    if (!isObj(wp[k])) fail(`${at}.${k} must be an object with a "singular" and a "plural"`);
    for (const n of Object.keys(wp[k])) if (n !== "singular" && n !== "plural") fail(`${at}.${k}.${n}: unknown key (a label takes singular, plural)`);
    for (const n of ["singular", "plural"]) {
      const w = wp[k][n];
      if (typeof w !== "string" || !w.trim() || w !== w.trim() || w.length > 40 || /[{}<>\n]/.test(w)) fail(`${at}.${k}.${n} must be a non-empty word or short phrase (at most 40 characters, no braces or line breaks), for example "week"`);
    }
  }
  // A profile that renames the period states `label`; unless it also states `list_label`, the list reads the same word.
  const sameLabel = (a, b) => a.singular === b.singular && a.plural === b.plural;
  if (sameLabel(wp.list_label, defaults.work_periods.list_label) && !sameLabel(wp.label, defaults.work_periods.label)) wp.list_label = { ...wp.label };
  if (wp.length_days !== null && (!Number.isInteger(wp.length_days) || wp.length_days < 1 || wp.length_days > 366)) fail(`${at}.length_days must be null (a new period has no dates until someone sets them) or a whole number of days from 1 to 366`);
  if (typeof wp.auto_rollover !== "boolean") fail(`${at}.auto_rollover must be true or false`);
  if (wp.mode === "individual" && wp.length_days === null) fail(`${at}.length_days: mode "individual" needs a length in days (for example 7): a person's unfinished items are carried into the next period, which is opened with this length when there is none`);
  if (wp.auto_rollover && wp.length_days === null) fail(`${at}.length_days: auto_rollover needs a length in days, to open the next period with`);
  if (wp.auto_rollover && wp.mode === "off") fail(`${at}.auto_rollover: there is nothing to roll over when mode is "off"`);
}

if (profile.agent.briefing !== null && (typeof profile.agent.briefing !== "string" || profile.agent.briefing.split(/\s+/).length > 400)) fail("agent.briefing must be null or a string of at most 400 words (it is sent on every turn)");

// --- what the model is: the base persona, and which base specialists it has ------------------------------------
if (typeof profile.persona?.base !== "boolean") fail("persona.base must be true (keep the base product's orchestrator persona) or false (a pack's agent/instructions/50-pack-*.md supplies it)");
const SUBAGENTS = join(ROOT, "agent/subagents");
const present = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "agent.ts"))) : []);
// A live eve build (scripts/eve-build.mjs) moves the excluded specialists aside while it runs: they are still
// subagents. (gen-subagent-meta reads the merged profile through --print, and may run during a build.) The names a
// build hides are in its lock (`hidden`) before a directory moves and until every one is back, so they are read
// from there as well as from both folders; and because a directory can be between the two folders at the instant
// they are listed, an excluded name that is found nowhere is looked for again, a few times, before it is refused.
const HIDDEN_DIR = join(ROOT, ".eve-build-hidden");
function specialistsNow() {
  let locked = [];
  try { locked = JSON.parse(readFileSync(join(HIDDEN_DIR, "lock.json"), "utf8")).hidden ?? []; } catch { /* no build running */ }
  return new Set([...locked.filter((k) => typeof k === "string"), ...present(SUBAGENTS), ...present(join(HIDDEN_DIR, "subagents"))]);
}
let knownSpecialists = specialistsNow();
const excludeList = Array.isArray(profile.specialists?.exclude) ? profile.specialists.exclude : [];
for (let attempt = 0; attempt < 40 && excludeList.some((k) => !knownSpecialists.has(k)); attempt++) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  for (const k of specialistsNow()) knownSpecialists.add(k);
}
if (!Array.isArray(profile.specialists?.exclude)) fail("specialists.exclude must be a list of subagent directory names (empty to keep them all)");
for (const [i, key] of profile.specialists.exclude.entries()) {
  if (typeof key !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(key)) fail(`specialists.exclude[${i}] must be a subagent directory name, e.g. "data-migration"`);
  if (!knownSpecialists.has(key)) fail(`specialists.exclude[${i}]: "${key}" is not a subagent (none of agent/subagents/*/agent.ts; known: ${[...knownSpecialists].sort().join(", ")})`);
}
if (new Set(profile.specialists.exclude).size !== profile.specialists.exclude.length) fail("specialists.exclude lists a subagent twice");

// --- the library a new workspace is provisioned with: named here, never listed in base code -----------------------
// Each source is a directory in the repository (workflows/*.workflow.js, recipes.json). A later profile adds one
// under its own id, and turns one off by setting its id to null. The default names none.
if (!isObj(profile.library?.sources)) fail("library.sources must be a map of source id to a directory in the repository (empty for no library)");
for (const [id, value] of Object.entries(profile.library.sources)) {
  if (value === null || value === false) { delete profile.library.sources[id]; continue; }
  const problem = validateSource(ROOT, id, value);
  if (problem) fail(`library.sources.${id}: ${problem}`);
}
if (Object.keys(defaults.library.sources).length) fail("library.sources: the default profile names no library source. A deployment opts into one by ADDING a profile file (docs/DEPLOYMENT_PROFILE.md, \"library\")");

// --- the data-room folders the MODEL reads: a relabelled domain's label as a folder name (agent/lib/agent-vocabulary.ts)
// "Coverage reports" is read and written as `Coverage-reports/` and stored under the domain's own folder. Two
// domains must not meet on one folder name, and none may take a stored name another domain already has.
{
  const folderNameFor = (label) => label.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const storedOf = (d) => profile.dataroom.domains[d].folder;
  const seen = new Map();
  for (const d of DOMAINS) {
    const label = profile.dataroom.domains[d].label;
    const folder = label === storedOf(d) ? storedOf(d) : folderNameFor(label);
    if (!folder) fail(`dataroom.domains.${d}.label: "${label}" leaves no letters or digits to name its folder`);
    const other = seen.get(folder.toLowerCase());
    if (other) fail(`dataroom.domains.${d}.label: "${label}" would be read as the folder "${folder}/", and so would ${other}. Pick a label that names a different folder.`);
    const stored = folder !== storedOf(d) && DOMAINS.find((o) => o !== d && storedOf(o).toLowerCase() === folder.toLowerCase());
    if (stored) fail(`dataroom.domains.${d}.label: "${label}" would be read as the folder "${folder}/", which is where ${stored} is stored. Pick a label that names a different folder.`);
    seen.set(folder.toLowerCase(), d);
    if ([profile.dataroom.uploads_folder, ...RESERVED_FOLDERS].some((r) => r.toLowerCase() === folder.toLowerCase())) fail(`dataroom.domains.${d}.label: "${label}" would be read as "${folder}/", a folder the data room already has`);
  }
}

const banner = `// AUTO-GENERATED by scripts/gen-deployment-profile.mjs from profiles/*.json — do not edit by hand.
// Sources, in merge order: ${files.join(", ")}
`;
const body = `${banner}
export interface DeploymentProfile {
  product: { name: string; tagline: string; description: string };
  vocabulary: {
    account: { singular: string; plural: string };
    member: { singular: string; plural: string };
    owner: string;
    /** The label of an account's second owner (the \`ae_owner\` / \`secondary_owner\` field). */
    secondary_owner: string;
    account_context: string;
  };
  chat: {
    hero_lines: string[];
    empty_sections: { urgent: string; stalled: string };
    /** Long messages a person SENT start folded to collapsed_lines lines, with "Show more". Assistant replies never fold. */
    user_messages: { collapse: boolean; collapsed_lines: number };
    starter_cards: {
      owner_label: string; ticket_waiting: string; tickets_waiting: string; ticket_badge: string; tickets_badge: string;
      triage_title: string; triage_prompt: string;
      quiet_summary: string; quiet_summary_long: string; quiet_badge: string; quiet_title: string; quiet_prompt: string;
    };
    /** pill_active / pill_locked take {context} (vocabulary.account_context) and {names}. */
    account_search: {
      title: string; description: string; placeholder: string; empty: string;
      pill_empty: string; pill_active: string; pill_locked: string;
    };
  };
  dataroom: {
    root_label: string;
    /**
     * By domain id. \`folder\`: the name the domain's files are STORED under (the first segment of every path in
     * it). \`label\`: what people and the model read (the folder's name when the profile gives none).
     */
    domains: Record<DataroomDomainId, { folder: string; label: string; visible: boolean; description?: string }>;
    /** The folder files a person attaches are stored under. */
    uploads_folder: string;
    /** null = the built-in starter tree; otherwise the files a new workspace is seeded with. */
    seed: { path: string; content: string }[] | null;
  };
  /**
   * The two record areas a deployment may REDEFINE: names, field labels, enum display labels, hidden fields (a
   * hidden required field carries the fixed value the forms submit). Keys are real field keys and enum values.
   */
  domains: { deployments: DomainSpec; implementations: DomainSpec & { group_by: string | null; group_label: { singular: string; plural: string } } };
  /** Sent to the model on every turn, after the stable prompt. null = nothing extra. */
  agent: { briefing: string | null };
  /** base: keep the base product's orchestrator persona in the root prompt (agent/lib/root-instructions.ts). */
  persona: { base: boolean };
  /** Base specialists the deployment does not use: moved out of agent/subagents/ at generation time. */
  specialists: { exclude: string[] };
  /**
   * sources: the directories (by id) whose workflows and recipes every new workspace is provisioned with
   * (scripts/build-workflow-library.mjs compiles them into agent/lib/workflow-library.generated.ts). Empty by default.
   */
  library: { sources: Record<string, string> };
  /**
   * hidden: fields of the account record the model never reads or writes (its tools' parameters and results).
   * custom_fields: the deployment's OWN fields on the account record, by key in the customers table's \`custom\` column.
   */
  account_fields: { hidden: string[]; custom_fields: CustomFieldSpec[] };
  /**
   * The time-boxed periods that group tasks (the \`cycles\` table). mode "team": one shared period with a lead, a
   * capacity and a burndown. "individual": each person's own items within the period. "off": the feature does not
   * exist in this deployment (agent/lib/work-periods.ts is what every surface reads).
   */
  work_periods: {
    mode: WorkPeriodMode;
    /** What a period is called. */
    label: { singular: string; plural: string };
    /** What it is called where tasks are grouped and filtered by it. */
    list_label: { singular: string; plural: string };
    /** What one task in a period is called under mode "individual". */
    item_label: { singular: string; plural: string };
    /** How long a new period runs; null = no dates until someone sets them. */
    length_days: number | null;
    /** An ended period's unfinished tasks are carried into the next one, opened when there is none. */
    auto_rollover: boolean;
  };
}
export type WorkPeriodMode = "off" | "team" | "individual";

/** The data-room domains, by the id code and profiles call them. Their stored folder names are the profile's. */
export type DataroomDomainId = ${DOMAINS.map((d) => JSON.stringify(d)).join(" | ")};
export const DATAROOM_DOMAIN_IDS: readonly DataroomDomainId[] = ${JSON.stringify(DOMAINS)};

export interface DomainFieldSpec {
  label?: string;
  /** For a table column or a chip, where the full label is too long. */
  short_label?: string;
  help?: string;
  placeholder?: string;
  /** Not used in this deployment: no form field, no column, no detail row. */
  hidden?: boolean;
  /** What the forms submit for a hidden field. Required when the field is. */
  fixed?: string | number;
  /** enum VALUE -> what a person reads. The value is what is stored and submitted. */
  options?: Record<string, string>;
}
export interface DomainSpec {
  label: { singular: string; plural: string };
  description: string;
  id_label: string;
  /** A free-text field that carries one of \`kinds\` (shown as a select). null = the area has no kinds. */
  kind_field: string | null;
  kinds: string[];
  /** Extra fields on the "New …" form / the detail card, after the built-in ones. */
  create_fields: string[];
  detail_fields: string[];
  fields: Record<string, DomainFieldSpec>;
  /** The deployment's OWN fields on the area. Values live by key in the table's \`custom\` jsonb column. */
  custom_fields: CustomFieldSpec[];
}
export type CustomFieldType = "text" | "long_text" | "number" | "percent" | "date" | "email" | "link" | "pick_list";
export interface CustomFieldSpec {
  /** snake_case, unique in the area, never a built-in column's name. The key the value is stored and sent under. */
  key: string;
  label: string;
  type: CustomFieldType;
  /** Enforced when a record is created, and against clearing afterwards. */
  required?: boolean;
  /** The choices of a pick_list (required for one, refused for any other type). */
  options?: string[];
  help?: string;
  /** Also a column / a chip on the area's list, not only on the form and the detail card. */
  show_in_list?: boolean;
}
export type DomainArea = "deployments" | "implementations";
/** A record that can carry custom fields: the two redefinable areas and the account record itself. */
export type CustomFieldArea = DomainArea | "account";
/** What a form needs to know about a field: read from agent/lib/customer-schema.ts and agent/lib/db/schema.ts. */
export interface DomainFieldMeta { type: "enum" | "number" | "text" | "list"; values?: string[]; column: boolean; required: boolean }

export const DEPLOYMENT_PROFILE: DeploymentProfile = ${JSON.stringify(profile, null, 2)};

/** domains as profiles/00-default.json states them: "has this deployment redefined the area?" is a comparison with this. */
export const DEFAULT_DOMAINS: DeploymentProfile["domains"] = ${JSON.stringify(defaults.domains)};

/** Every field of the two areas, from the zod schemas and the drizzle tables. */
export const DOMAIN_FIELDS: Record<DomainArea, Record<string, DomainFieldMeta>> = ${JSON.stringify(domainFields)};

/** The product's display name. One place, so a rebrand is a profile, not a search-and-replace. */
export const PRODUCT_NAME: string = DEPLOYMENT_PROFILE.product.name;

/** Fill {name}-style slots in profile copy. Unknown slots are left as written. */
export function fillProfileText(text: string, slots: Record<string, string | number> = {}): string {
  return text.replace(/\\{([a-z_]+)\\}/g, (whole, key) => (key === "product" ? PRODUCT_NAME : key in slots ? String(slots[key]) : whole));
}
`;
if (!CHECK_ONLY) for (const target of ["lib/deployment-profile.generated.ts", "agent/lib/deployment-profile.generated.ts"]) writeFileSync(join(ROOT, target), body);
// The former folder names as a module the SERVER can import (the store's write guard). Kept out of the profile
// module on purpose: that one is bundled for the browser, and no page has a use for them.
if (!CHECK_ONLY) {
  writeFileSync(
    join(ROOT, "agent/lib/legacy-dataroom-folders.generated.ts"),
    `// AUTO-GENERATED by scripts/gen-deployment-profile.mjs from scripts/lib/legacy-dataroom-folders.json — do not edit by hand.
import type { DataroomDomainId } from "./deployment-profile.generated.ts";

/**
 * The names the data-room folders had while they were written into the code, by domain id. A data room that holds
 * one of these while the profile stores that domain under another name was filled before the profile said where:
 * it is refused (agent/lib/dataroom-folders.ts), never silently forked.
 */
export const LEGACY_DATAROOM_FOLDERS: Record<DataroomDomainId | "uploads", string> = ${JSON.stringify(Object.fromEntries([...DOMAINS, "uploads"].map((id) => [id, LEGACY_FOLDERS[id]])))};
`,
  );
}

/**
 * specialists.exclude is a LIST, honoured where things are generated and built — nothing is moved:
 *   scripts/gen-subagent-meta.mjs   leaves them out of the registry (UI lists, workflow author, data-room templates)
 *   agent/lib/agent-vocabulary.ts   drops them from every prompt's roster and list of names
 *   scripts/eve-build.mjs           hides their directories from eve's discovery for the duration of the build
 *                                   (eve makes every directory under agent/subagents/ a tool the model can call,
 *                                   and has no switch to leave one out), restoring them however the build ends
 */
if (!CHECK_ONLY) {
  // A kept specialist whose NAME carries a word the profile relabels is still called that by the model.
  // "Relabels": its word is neither the name's own word nor the default profile's (the neutral word base text fills in).
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const relabelledWords = [
    ["customer", profile.vocabulary.account.singular, defaults.vocabulary.account.singular],
    ["deployment", profile.domains.deployments.label.singular, defaults.domains.deployments.label.singular],
    ["implementation", profile.domains.implementations.label.singular, defaults.domains.implementations.label.singular],
    ["member", profile.vocabulary.member.singular, defaults.vocabulary.member.singular],
  ].filter(([base, word, neutral]) => !same(base, word) && !same(neutral, word)).map(([base]) => base);
  for (const key of present(SUBAGENTS).filter((k) => !profile.specialists.exclude.includes(k))) {
    const hit = relabelledWords.find((w) => key.split("-").includes(w));
    if (hit) console.warn(`gen-deployment-profile: warning: the specialist "${key}" keeps its name, and the model delegates to it by that name, but this profile relabels "${hit}". Exclude it (specialists.exclude) if this deployment does not use it.`);
  }
}
// --print: the merged, validated profile as JSON on stdout (scripts/test-deployment-profile.mjs reads an example this way).
if (process.argv.includes("--print")) { console.log(JSON.stringify(profile)); process.exit(0); }
console.log(`deployment profile: ${files.join(" + ")} -> product "${profile.product.name}", ${profile.vocabulary.account.plural}, ${Object.values(profile.dataroom.domains).filter((d) => d.visible).length}/${DOMAINS.length} data-room domains visible${["deployments", "implementations"].filter((a) => JSON.stringify(profile.domains[a]) !== JSON.stringify(defaults.domains[a])).map((a) => `, ${a} shown as "${profile.domains[a].group_by ? profile.domains[a].group_label.plural : profile.domains[a].label.plural}"`).join("")}`);
