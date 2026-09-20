#!/usr/bin/env node
// Merges profiles/*.json (filename order; later wins; objects merge deeply, arrays and scalars replace) into the
// deployment profile and writes it where both halves of the app can import it as plain data:
//   lib/deployment-profile.generated.ts         (web)
//   agent/lib/deployment-profile.generated.ts   (agent)
// A deployment never edits profiles/00-default.json; it ADDS profiles/NN-<name>.json (a subagent pack ships one,
// a branding step may add another). See docs/DEPLOYMENT_PROFILE.md.   npm run build:deployment-profile
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    if (shape && !(k in shape) && !FREE.some((f) => path === f) && !FIELD_MAP.test(path) && !(k === "description" && path.startsWith("dataroom.domains."))) fail(`${here}: unknown key (not in profiles/00-default.json)`);
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v, here, shape?.[k]) : v;
  }
  return out;
}
// "$comment" is documentation at any depth, never data.
const uncomment = (v) => (Array.isArray(v) ? v.map(uncomment) : isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "$comment").map(([k, x]) => [k, uncomment(x)])) : v);
const FREE = ["dataroom.domains"];
// domains.<area>.fields is a map keyed by real field keys; its entries are validated against the schemas below.
const FIELD_MAP = /^domains\.(deployments|implementations)\.fields(\.|$)/;
let current = "";
function fail(msg) { console.error(`profiles/${current}: ${msg}`); process.exit(1); }

const files = readdirSync(DIR).filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f)).sort();
if (files[0] !== "00-default.json") { console.error("profiles/00-default.json is missing"); process.exit(1); }
let profile = {}; let shape = null; let defaults = null;
for (const f of files) {
  current = f;
  let doc;
  try { doc = JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch (e) { fail(`not valid JSON: ${e.message}`); }
  if (!isObj(doc)) fail("must be a JSON object");
  doc = uncomment(doc);
  profile = shape ? merge(profile, doc, "", shape) : merge({}, doc, "", null);
  if (!shape) { shape = profile; defaults = structuredClone(profile); }
}

// What the rest of the code relies on. Fail the build, never the page.
current = files.at(-1);
const DOMAINS = ["Customers", "Platform", "Deployments", "Solutions", "Implementation", "Tickets", "People"];
for (const d of Object.keys(profile.dataroom.domains)) if (!DOMAINS.includes(d)) fail(`dataroom.domains.${d}: not a data-room domain (${DOMAINS.join(", ")}). A profile relabels or hides domains; it cannot add one.`);
for (const d of DOMAINS) {
  const v = (profile.dataroom.domains[d] ??= { label: d, visible: true });
  if (typeof v.label !== "string" || !v.label.trim()) v.label = d;
  if (typeof v.visible !== "boolean") v.visible = true;
  if ("description" in v && (typeof v.description !== "string" || !v.description.trim())) delete v.description;
}
if (!profile.dataroom.domains.Customers.visible) fail("dataroom.domains.Customers cannot be hidden: every record hangs off it");
if (!Array.isArray(profile.chat.hero_lines) || !profile.chat.hero_lines.length || profile.chat.hero_lines.some((l) => typeof l !== "string" || !l.trim())) fail("chat.hero_lines must be a non-empty list of strings");
if (typeof profile.chat.user_messages.collapse !== "boolean") fail("chat.user_messages.collapse must be true or false");
if (!Number.isInteger(profile.chat.user_messages.collapsed_lines) || profile.chat.user_messages.collapsed_lines < 2 || profile.chat.user_messages.collapsed_lines > 40) fail("chat.user_messages.collapsed_lines must be a whole number from 2 to 40");
for (const k of ["singular", "plural"]) for (const n of ["account", "member"]) if (typeof profile.vocabulary[n]?.[k] !== "string" || !profile.vocabulary[n][k].trim()) fail(`vocabulary.${n}.${k} must be a non-empty string`);
if (profile.dataroom.seed !== null) {
  if (!Array.isArray(profile.dataroom.seed)) fail("dataroom.seed must be null (the built-in starter tree) or a list of { path, content }");
  for (const s of profile.dataroom.seed) {
    if (typeof s?.path !== "string" || typeof s?.content !== "string" || s.path.includes("..") || s.path.startsWith("/")) fail(`dataroom.seed entry ${JSON.stringify(s?.path)}: needs a relative "path" and a "content" string`);
    if (s.path !== "README.md" && !DOMAINS.concat("Uploads").includes(s.path.split("/")[0])) fail(`dataroom.seed path "${s.path}" does not start with a data-room domain`);
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
const SYSTEM_KEYS = ["orgId", "customerId", "displayName"];
const FIELD_SPEC_KEYS = ["label", "short_label", "help", "placeholder", "hidden", "fixed", "options"];
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
  if (area === "implementations") {
    if (d.group_by !== null && (!known[d.group_by]?.column || known[d.group_by].type !== "text")) fail(`${at}.group_by: "${d.group_by}" must be a free-text column of the implementation table`);
    if (d.group_by !== null && d.fields[d.group_by]?.hidden) fail(`${at}.group_by: "${d.group_by}" is hidden`);
    for (const n of ["singular", "plural"]) if (typeof d.group_label?.[n] !== "string" || !d.group_label[n].trim()) fail(`${at}.group_label.${n} must be a non-empty string`);
  }
}

if (profile.agent.briefing !== null && (typeof profile.agent.briefing !== "string" || profile.agent.briefing.split(/\s+/).length > 400)) fail("agent.briefing must be null or a string of at most 400 words (it is sent on every turn)");

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
    domains: Record<string, { label: string; visible: boolean; description?: string }>;
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
}

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
}
export type DomainArea = "deployments" | "implementations";
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
// --print: the merged, validated profile as JSON on stdout (scripts/test-deployment-profile.mjs reads an example this way).
if (process.argv.includes("--print")) { console.log(JSON.stringify(profile)); process.exit(0); }
console.log(`deployment profile: ${files.join(" + ")} -> product "${profile.product.name}", ${profile.vocabulary.account.plural}, ${Object.values(profile.dataroom.domains).filter((d) => d.visible).length}/${DOMAINS.length} data-room domains visible${["deployments", "implementations"].filter((a) => JSON.stringify(profile.domains[a]) !== JSON.stringify(defaults.domains[a])).map((a) => `, ${a} shown as "${profile.domains[a].group_by ? profile.domains[a].group_label.plural : profile.domains[a].label.plural}"`).join("")}`);
