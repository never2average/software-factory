/**
 * MCP as a core offering (mold_v0-060; molds/mold_v0/MOLD.md "Pack and record-area contract"): the catalog of MCP tools
 * generated from what packs declare, so a pack with no hand-written tool still has a full MCP surface. This module is
 * pure (zod and the pack seam only): it turns the packs' definitions into tool names, titles, descriptions, input
 * schemas and annotations, deterministically, and applies each pack's `mcp` settings. scripts/gen-packs.mjs runs it at
 * build (a setting naming no tool, a name too long, two tools with one name are refused there); src/packs.ts runs it
 * again at start against the shell's own tool names; src/mcp-tools.ts binds each entry to its handler.
 *
 * Per pack, in this order (names `<prefix>_<verb>_<thing>`, the prefix the pack's id unless `mcp.prefix` says otherwise):
 *   get_started                         a pack with onboarding steps (mold_v0-105): the caller's workspace's progress
 *                                       through them and its next step, listed first (clients list tools in order)
 *   list_<area>, get_<area>             every record area (reads; the area's `read` roles)
 *   export_<area>                       every record area (mold_v0-108): its records as CSV, every field a column under
 *                                       its label, as the console's Export CSV writes them (src/record-export.ts)
 *   create_<area>, update_<area>        a workspace area whose rows are not read from files or an API
 *   move_<area>                         such an area with a lifecycle
 *   get_metrics                         the pack's metrics (mold_v0-063), computed for the caller's workspace
 *   start_<kind>                        every job kind, its arguments typed from its declaration
 *   <run>_status, list_<runs>, get_<run>_results, cancel_<run>   the pack's runs, in the pack's word for a run
 *   get_<kind>_report                   a kind that declares a report file
 *   admin_list_/admin_get_/admin_create_/admin_update_/admin_delete_<area>   shared areas, on the admin MCP (staff)
 *   admin_sync_<repository>             an upstream catalog, on the admin MCP (staff)
 * The customer tools wrap the data API's workspace door (src/data-api.ts DATA_API_OPERATIONS) and the run engine; the
 * admin ones its admin door. Text from a declaration (labels, help, descriptions) reaches a description only as plain
 * text: one line, no control, zero-width or direction characters, no < > or `, capped. No record value ever does.
 */
import { z } from "zod";
import type { AccountPermission } from "./account-roles.js";
import type { Permission as AdminPermission } from "./admin-roles.js";
import { AgentJobKindSchema, CredentialSchema, JobKindSchema, McpSettingsSchema, OnboardingStepSchema, optionValues, READ_ONLY_KINDS, RECORD_KEY, RecordAreaSchema, RecordFieldSchema, RepositorySchema, type PackDefinition, type RecordAction } from "./pack-api.js";

export type GeneratedOp = "get_started" | "list" | "get" | "export" | "create" | "update" | "move" | "metrics" | "start" | "run_status" | "list_runs" | "run_results" | "cancel_run" | "report"
  | "admin_list" | "admin_get" | "admin_create" | "admin_update" | "admin_delete" | "admin_sync";

export interface GeneratedTool {
  /** The name clients see (after `mcp.rename`). */
  name: string;
  /** The generated name: what `mcp` settings name it by. */
  generated: string;
  pack: string;
  op: GeneratedOp;
  /** "workspace": the customer MCP (one workspace's door); "admin": the admin MCP (shared areas, staff). */
  door: "workspace" | "admin";
  /** A customer tool the pack moved to the admin MCP (`mcp.admin_only`): never on the customer MCP. */
  admin_only: boolean;
  area?: string;
  kind?: string;
  repository?: string;
  /** The record action a record tool needs, for the caller's role (src/record-areas.ts allowedRoles). */
  action?: RecordAction;
  /** The account permission a customer tool needs beyond the area's (src/account-roles.ts). */
  needs?: AccountPermission;
  /** The platform permission it needs on the admin MCP (src/admin-roles.ts). */
  admin_needs: AdminPermission;
  title: string;
  description: string;
  input: z.ZodRawShape;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** One pack as the catalog reads it: its id, name, profile words and merged definition. */
export interface CatalogPack { id: string; name: string; words?: Record<string, string>; definition: PackDefinition }

/**
 * A generated tool a pack's mcp settings keep off the customer MCP (mold_v0-067): `exclude` (or left out of `include`)
 * removes it everywhere, `admin_only` moves it to the admin MCP. Either way the same operation's HTTP route for the
 * workspace (the data API, the console's record and run data) and its console tab are withheld too
 * (src/mcp-withheld.ts, scripts/gen-packs.mjs); an excluded staff tool withholds the staff route likewise.
 */
export interface WithheldTool { pack: string; generated: string; op: GeneratedOp; door: "workspace" | "admin"; area?: string; kind?: string; repository?: string; reason: "exclude" | "admin_only" }

/** The names a generated tool may not take: the shell's and the packs' own tools, and the admin MCP's. */
export interface Reserved { customer?: readonly string[]; admin?: readonly string[] }

const MAX_NAME = 64;
/** What one export_<area> call holds at most (src/record-export.ts EXPORT_MAX_ROWS, EXPORT_MAX_BYTES). */
const EXPORT_TEXT = "5000 records or 1 MB of CSV";
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Declared text as a description may carry it: one line of plain text, capped. */
export function plain(s: unknown, max = 300): string {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}<>`]/gu, " ")
    .replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
/** A word as part of a tool name: lowercase letters, digits and _. */
const token = (s: string, dflt: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || dflt;
const plural = (w: string) => (/(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Area = z.output<typeof RecordAreaSchema>;
type Field = z.output<typeof RecordFieldSchema>;
type Kind = z.output<typeof JobKindSchema> | z.output<typeof AgentJobKindSchema>;

const KEY_TEXT = "1-200 letters, digits, . _ : ( ) or -, starting with a letter or digit";
const recordKey = (what: string) => z.string().regex(RECORD_KEY, `a record key: ${KEY_TEXT}`).describe(what);
const RUN_ID = /^run_[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A declared field (or a job kind's argument) as a tool input: its type, its bounds, its label and help as text. */
function fieldInput(f: Field, labelOf: (area: string) => string): z.ZodType {
  let one: z.ZodType, what: string;
  switch (f.type) {
    case "text": one = z.string().max(f.max_length ?? 20_000); what = `text, up to ${f.max_length ?? 20_000} characters`; break;
    case "number": {
      let n = z.number();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      one = n; what = `a number${f.min !== undefined ? ` from ${f.min}` : ""}${f.max !== undefined ? ` up to ${f.max}` : ""}`; break;
    }
    case "boolean": one = z.boolean(); what = "true or false"; break;
    case "date": one = z.string().regex(DATE, "a date: YYYY-MM-DD, or an ISO date-time"); what = "a date, YYYY-MM-DD"; break;
    case "json": one = z.unknown(); what = "any JSON value"; break;
    case "link": one = z.union([z.string().regex(RECORD_KEY), z.array(z.string().regex(RECORD_KEY)).max(500)]); what = "a record key, or a list of keys"; break;
    case "enum": {
      const values = optionValues(f);
      one = z.enum(values as [string, ...string[]]);
      const labelled = (f.options ?? []).map((o) => (typeof o === "string" ? o : o.label && o.label !== o.value ? `${o.value} (${plain(o.label, 80)})` : o.value));
      what = `one of ${labelled.join(", ")}`; break;
    }
    case "person": one = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,199}$/, "a person's sign-in id"); what = "a person's sign-in id"; break;
    case "reference": one = z.string().regex(RECORD_KEY, `a record key: ${KEY_TEXT}`); what = `the key of a ${labelOf(f.to!)} record (${f.to})`; break;
    case "file": one = z.strictObject({ path: z.string().min(1).max(500), name: z.string().max(200).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), size: z.number().int().min(0).optional() });
      what = "a file of the workspace: {path, name?, sha256?, size?}"; break;
    default: one = z.unknown(); what = "a value";
  }
  const v = f.multiple ? z.array(one).max(100) : one;
  const help = f.help ? ` ${plain(f.help, 200)}` : "";
  const described = v.describe(`${plain(f.label, 80)}: ${f.multiple ? "a list of " : ""}${what}.${help}`);
  return f.required ? described : described.optional();
}

/** The JSON Schema subset an agent run's input takes (src/agent-workspace-config.ts InputSchemaSchema). */
type InputJsonSchema = {
  type?: string | string[]; properties?: Record<string, InputJsonSchema>; required?: string[]; additionalProperties?: boolean | InputJsonSchema;
  items?: InputJsonSchema; enum?: unknown[]; const?: unknown; pattern?: string; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; description?: string;
};

/**
 * mold_v0-166: an argument a run writes to an input file (agent `inputs`, from `scope.<argument>`) is typed in its start
 * tool by that input's schema, so a client sees the object it must give (its properties, which are required, their
 * patterns and choices) rather than "any JSON value". The run's harness checks the value against the same schema again.
 */
function schemaInput(s: InputJsonSchema, depth = 0): z.ZodType {
  if (depth > 12) return z.unknown();
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  const one = (t: string): z.ZodType => {
    switch (t) {
      case "string": {
        let v = z.string();
        if (s.minLength !== undefined) v = v.min(s.minLength);
        if (s.maxLength !== undefined) v = v.max(s.maxLength);
        if (s.pattern !== undefined) v = v.regex(new RegExp(s.pattern, "u"));
        return v;
      }
      case "number": case "integer": {
        let v = t === "integer" ? z.number().int() : z.number();
        if (s.minimum !== undefined) v = v.min(s.minimum);
        if (s.maximum !== undefined) v = v.max(s.maximum);
        return v;
      }
      case "boolean": return z.boolean();
      case "null": return z.null();
      case "array": {
        let v = z.array(s.items ? schemaInput(s.items, depth + 1) : z.unknown());
        if (s.minItems !== undefined) v = v.min(s.minItems);
        if (s.maxItems !== undefined) v = v.max(s.maxItems);
        return v;
      }
      case "object": {
        const req = new Set(s.required ?? []);
        const shape = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, sub]) => {
          const v = schemaInput(sub, depth + 1);
          return [k, req.has(k) ? v : v.optional()];
        }));
        const ap = s.additionalProperties;
        return ap === false ? z.strictObject(shape) : ap && typeof ap === "object" ? z.object(shape).catchall(schemaInput(ap, depth + 1)) : z.looseObject(shape);
      }
      default: return z.unknown();
    }
  };
  let v: z.ZodType;
  if (s.enum) v = s.enum.every((e) => typeof e === "string") ? z.enum(s.enum as [string, ...string[]]) : z.union(s.enum.map((e) => z.literal(e as string | number | boolean | null)) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  else if (s.const !== undefined) v = z.literal(s.const as string | number | boolean | null);
  else if (types.length === 1) v = one(types[0]!);
  else if (types.length > 1) v = z.union(types.map(one) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  else v = z.unknown();
  return s.description ? v.describe(plain(s.description, 300)) : v;
}

/** The input schema each of an agent kind's arguments is written to a file with, by argument name (mold_v0-166). */
function argInputSchemas(k: Kind): Map<string, InputJsonSchema> {
  const inputs = (k as { agent?: { inputs?: Record<string, { from: string; schema: InputJsonSchema }> } }).agent?.inputs ?? {};
  const out = new Map<string, InputJsonSchema>();
  for (const inp of Object.values(inputs)) {
    const m = /^scope\.([A-Za-z0-9_-]{1,64})$/.exec(inp.from);
    if (m && !out.has(m[1]!)) out.set(m[1]!, inp.schema);
  }
  return out;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = (destructive: boolean, idempotent: boolean, openWorld = false) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld });

/**
 * The generated tools of a build's packs, in pack order, and every problem with their names and the packs' `mcp`
 * settings. Deterministic: the same definitions give the same list, byte for byte.
 */
export function generateCatalog(packs: readonly CatalogPack[], reserved: Reserved = {}): { tools: GeneratedTool[]; problems: string[]; withheld: WithheldTool[] } {
  const problems: string[] = [];
  const withheld: WithheldTool[] = [];
  const held = (t: GeneratedTool, reason: WithheldTool["reason"]) => withheld.push({ pack: t.pack, generated: t.generated, op: t.op, door: t.door,
    ...(t.area ? { area: t.area } : {}), ...(t.kind ? { kind: t.kind } : {}), ...(t.repository ? { repository: t.repository } : {}), reason });
  const areaLabels = new Map<string, string>();
  for (const p of packs) for (const a of p.definition.recordAreas ?? []) {
    const r = RecordAreaSchema.safeParse(a);
    if (r.success) areaLabels.set(r.data.name, plain(r.data.label, 80));
  }
  const labelOf = (name: string) => areaLabels.get(name) ?? name;
  const out: GeneratedTool[] = [];
  for (const p of packs) {
    const at = (what: string) => `pack ${p.id}: mcp: ${what}`;
    const parsed = McpSettingsSchema.safeParse(p.definition.mcp ?? {});
    if (!parsed.success) { problems.push(at(parsed.error.issues.map((e) => `${e.path.join(".") || "value"} ${e.message}`).join("; "))); continue; }
    const settings = parsed.data;
    const prefix = settings.prefix ?? p.id;
    const words = p.words ?? {};
    const ws = plain(words.workspace ?? "workspace", 40) || "workspace";
    const run = plain(words.run ?? "run", 40) || "run";
    const runs = plain(words.runs ?? plural(run), 40);
    const runTok = token(run, "run"), runsTok = token(words.runs ?? plural(runTok), "runs");
    const packName = plain(p.name, 80) || p.id;
    const tools: GeneratedTool[] = [];
    const add = (t: Omit<GeneratedTool, "name" | "pack" | "admin_only">) => tools.push({ ...t, name: t.generated, pack: p.id, admin_only: false });
    const n = (verb: string, thing?: string) => `${prefix}_${verb}${thing ? `_${thing}` : ""}`;

    // ---------- first-run guidance (mold_v0-105: src/mcp-tools.ts getStarted, from the pack's onboarding steps) ----------
    const steps = (p.definition.onboarding ?? []).map((x) => OnboardingStepSchema.safeParse(x)).filter((r) => r.success).map((r) => r.data);
    if (steps.length) {
      const labels = steps.map((x) => plain(x.label, 60)).join("; ");
      add({ generated: n("get", "started"), op: "get_started", door: "workspace", needs: "read", admin_needs: "read",
        title: `${packName}: start here`,
        description: `Start here. What ${packName} does and this ${ws}'s next setup step (${labels}): which are done, the next one, how to do it and the words the user can type. ` +
          `Call it first in a new conversation, and whenever the user greets you, asks what ${packName} is or can do, asks how to begin, or asks something vague like "get me started" or "what now?". Then tell the user their next step.`,
        input: {}, annotations: READ });
    }

    // ---------- record areas ----------
    const areas = (p.definition.recordAreas ?? []).map((a) => RecordAreaSchema.safeParse(a)).filter((r) => r.success).map((r) => r.data as Area);
    const repoKind = (a: Area) => {
      const raw = a.repository ? p.definition.repositories?.[a.repository] : undefined;
      const r = raw ? RepositorySchema.safeParse(raw) : null;
      return r?.success ? r.data.kind : null;
    };
    for (const a of areas) {
      const label = plain(a.label, 80), about = a.description ? ` ${plain(a.description, 300)}` : "";
      const shared = a.scope === "platform";
      const whose = shared ? `shared by every ${ws}, read only` : `this ${ws}'s own`;
      const readOnly = !!repoKind(a) && (READ_ONLY_KINDS as readonly string[]).includes(repoKind(a)!);
      const state = a.lifecycle?.field;
      const fieldList = a.fields.map((f) => `${f.name} (${plain(f.label, 40)}, ${f.type}${f.multiple ? " list" : ""}${f.required ? ", required" : ""})`).join(", ");
      const sortable = ["key", "title", "updated_at", ...a.fields.filter((f) => !["json", "file", "link"].includes(f.type) && !f.multiple).map((f) => f.name)];
      add({ generated: n("list", a.name), op: "list", door: "workspace", area: a.name, action: "read", admin_needs: "read",
        title: `${label}: list`,
        description: `List the records of ${label} (${whose}), a page at a time: filter, sort, then pass next as after for the following page.${about} Fields: ${fieldList}.`,
        input: {
          filter: z.record(z.string(), z.unknown()).optional().describe(`{field: value} or {field: {op: value}}, every condition ANDed; op is eq, ne, in, lt, lte, gt, gte, contains, prefix or exists; field is one of ${["key", "title", "updated_at", ...a.fields.map((f) => f.name)].join(", ")}`),
          sort: z.enum(sortable.flatMap((s) => [s, `-${s}`]) as [string, ...string[]]).optional().describe("The order: a field, key, title or updated_at; - first for descending (default key)"),
          limit: z.number().int().min(1).max(200).optional().describe("Records per page (default 50)"),
          after: z.string().min(1).max(2000).optional().describe("The next value of the previous page"),
        },
        annotations: READ });
      add({ generated: n("get", a.name), op: "get", door: "workspace", area: a.name, action: "read", admin_needs: "read",
        title: `${label}: get one`,
        description: `One record of ${label} (${whose}) by its key, with every field and the records its links name.`,
        input: { key: recordKey(`The ${label} record's key`) }, annotations: READ });
      add({ generated: n("export", a.name), op: "export", door: "workspace", area: a.name, action: "read", admin_needs: "read",
        title: `${label}: export as CSV`,
        description: `Export the records of ${label} (${whose}) as CSV text: a header row, then one row per record with its key, title, every field under its label and when it last changed; ` +
          `filter and sort as ${n("list", a.name)} does. At most ${EXPORT_TEXT} at once: when more remain, next is set; pass it as after for the rest. Give the user the csv as a file.`,
        input: {
          filter: z.record(z.string(), z.unknown()).optional().describe(`As ${n("list", a.name)}: {field: value} or {field: {op: value}}, every condition ANDed`),
          sort: z.enum(sortable.flatMap((s) => [s, `-${s}`]) as [string, ...string[]]).optional().describe("The order: a field, key, title or updated_at; - first for descending (default key)"),
          after: z.string().min(1).max(2000).optional().describe("The next value of the previous export"),
        },
        annotations: READ });
      if (!shared && !readOnly) {
        const dataShape = Object.fromEntries(a.fields.filter((f) => f.name !== state).map((f) => [f.name, fieldInput(f, labelOf)]));
        const required = a.fields.filter((f) => f.required && f.name !== state).map((f) => f.name);
        const life = a.lifecycle ? ` A new record starts in state ${a.lifecycle.initial}; its state changes only with ${n("move", a.name)}.` : "";
        const body = {
          title: z.string().max(500).optional().describe("The record's title"),
          data: z.strictObject(dataShape).describe(`The record's fields${required.length ? ` (required: ${required.join(", ")})` : ""}`),
        };
        add({ generated: n("create", a.name), op: "create", door: "workspace", area: a.name, action: "create", needs: "edit", admin_needs: "accounts",
          title: `${label}: add one`,
          description: `Add a record to ${label}, this ${ws}'s own, under a new key (refused when the key exists).${life}`,
          input: { key: recordKey(`The new record's key (${KEY_TEXT})`), ...body }, annotations: WRITE(false, false) });
        add({ generated: n("update", a.name), op: "update", door: "workspace", area: a.name, action: "update", needs: "edit", admin_needs: "accounts",
          title: `${label}: change one`,
          description: `Replace the title and fields of a record of ${label}: every field left out is cleared${state ? `; its state (${state}) is kept` : ""}. Read it with ${n("get", a.name)} first.`,
          input: { key: recordKey(`The ${label} record's key`), ...body }, annotations: WRITE(true, true) });
        if (a.lifecycle) {
          const moves = a.lifecycle.transitions.map((t) => `${t.from === "*" ? "any" : t.from.join("/")} -> ${t.to}${t.label ? ` (${plain(t.label, 60)})` : ""}${t.roles ? ` [${t.roles.join(", ")}]` : ""}`).join("; ");
          const states = [...new Set(a.lifecycle.transitions.map((t) => t.to))];
          add({ generated: n("move", a.name), op: "move", door: "workspace", area: a.name, action: "move", needs: "edit", admin_needs: "accounts",
            title: `${label}: move one`,
            description: `Move a record of ${label} to another state along its lifecycle: ${moves}.`,
            input: { key: recordKey(`The ${label} record's key`), to: z.enum(states as [string, ...string[]]).describe("The state to move it to") },
            annotations: WRITE(false, false) });
        }
      }
    }

    // ---------- metrics (mold_v0-063: src/metrics.ts, the same computation as /api/metrics) ----------
    const metrics = (p.definition.metrics ?? []).filter((m) => m && typeof m.name === "string");
    if (metrics.length) {
      add({ generated: n("get", "metrics"), op: "metrics", door: "workspace", needs: "read", admin_needs: "read",
        title: `${packName} metrics`,
        description: `${packName}'s metrics for this ${ws}, computed now: ${metrics.map((m) => `${m.name} (${plain(m.label, 60)})`).join(", ")}. Each is read only by the roles that may read what it is over.`,
        input: { names: z.array(z.enum(metrics.map((m) => m.name) as [string, ...string[]])).min(1).max(30).optional().describe("Only these metrics (default every one)") },
        annotations: READ });
    }

    // ---------- job kinds and the pack's runs ----------
    const kinds: Kind[] = [
      ...(p.definition.jobKinds ?? []).map((k) => JobKindSchema.safeParse(k)),
      ...(p.definition.agentJobKinds ?? []).map((k) => AgentJobKindSchema.safeParse(k)),
    ].filter((r) => r.success).map((r) => r.data as Kind);
    const assetAreas = areas.filter((a) => a.role === "asset").map((a) => a.name);
    const creds = (p.definition.credentials ?? []).map((c) => CredentialSchema.safeParse(c)).filter((r) => r.success).map((r) => r.data);
    const statusName = n(`${runTok}_status`), resultsName = n("get", `${runTok}_results`);
    for (const k of kinds) {
      const label = plain(k.label ?? k.name, 80), about = k.description ? ` ${plain(k.description, 300)}` : "";
      const args = (k.args ?? []).map((x) => RecordFieldSchema.parse(x));
      const typed = argInputSchemas(k);
      const shape: Record<string, z.ZodType> = Object.fromEntries(args.map((f) => {
        const sch = typed.get(f.name);
        if (!sch) return [f.name, fieldInput(f, labelOf)];
        const v = schemaInput(sch).describe(`${plain(f.label, 80)}.${f.help ? ` ${plain(f.help, 300)}` : ""}`);
        return [f.name, f.required ? v : v.optional()];
      }));
      if (assetAreas.length) {
        if ("target_asset" in shape) problems.push(at(`job kind ${k.name} has an argument named target_asset, which its start tool uses for the target`));
        shape.target_asset = z.strictObject({ area: z.enum(assetAreas as [string, ...string[]]), key: recordKey("The record's key") }).optional()
          .describe(`The ${ws}'s record the ${run} is for (its credentials bound to that record reach the ${run})`);
      }
      const envs = creds.filter((c) => k.credentials.includes(c.name) && c.bound_to === "environment");
      if (envs.length) {
        if ("target_environment" in shape) problems.push(at(`job kind ${k.name} has an argument named target_environment, which its start tool uses for the target`));
        const listed = [...new Set(envs.flatMap((c) => c.environments ?? []))];
        shape.target_environment = (listed.length && envs.every((c) => c.environments) ? z.enum(listed as [string, ...string[]]) : z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/))
          .optional().describe(`The environment the ${run} is for (its credentials bound to that environment reach the ${run})`);
      }
      // mold_v0-079: a write that waits for its preview's approval names that approval.
      const gate = (k as { approval?: { preview: string; by: string } }).approval;
      if (gate) {
        if ("approval" in shape) problems.push(at(`job kind ${k.name} has an argument named approval, which its start tool uses for the preview's approval`));
        shape.approval = z.string().regex(/^apr_[A-Za-z0-9_-]{16,40}$/, "an approval id: apr_…")
          .describe(`The approval (apr_…) the ${gate.by === "operator" ? "platform's operator" : `${ws}'s owner`} gave to a ${gate.preview} ${run}'s output; used once`);
      }
      add({ generated: n("start", k.name), op: "start", door: "workspace", kind: k.name, needs: "launch", admin_needs: "accounts",
        title: `Start ${label}`,
        description: `Start a ${run} (${label}) for this ${ws}.${about}${args.length ? ` Arguments: ${args.map((f) => `${f.name}${f.required ? " (required)" : ""}`).join(", ")}.` : ""} ${gate ? `It starts only with the approval (by the ${gate.by === "operator" ? "platform's operator" : `${ws}'s owner`}) of a ${gate.preview} ${run}'s output, with that ${run}'s arguments, and is given that approved output. ` : ""}It is queued and runs in a sandbox, spending at most $${k.budget_usd} of model use; it answers with the ${run}'s id at once. Follow it with ${statusName} and read its results with ${resultsName}.`,
        input: shape, annotations: WRITE(false, false, true) });
    }
    if (kinds.length) {
      const kindNames = kinds.map((k) => k.name) as [string, ...string[]];
      const runId = z.string().regex(RUN_ID, "a run id: run_…").describe(`The ${run}'s id (run_…)`);
      add({ generated: statusName, op: "run_status", door: "workspace", needs: "read", admin_needs: "read",
        title: `${cap(run)} status`,
        description: `One ${run} of ${packName} by its id: its kind, status (queued, running, succeeded, failed, cancelled), attempts, cost and error.`,
        input: { run_id: runId }, annotations: READ });
      add({ generated: n("list", runsTok), op: "list_runs", door: "workspace", needs: "read", admin_needs: "read",
        title: `List ${runs}`,
        description: `This ${ws}'s ${runs} of ${packName}, newest first.`,
        input: { kind: z.enum(kindNames).optional().describe("Only this kind"), limit: z.number().int().min(1).max(200).optional().describe("At most this many (default 50)") },
        annotations: READ });
      add({ generated: resultsName, op: "run_results", door: "workspace", needs: "read", admin_needs: "read",
        title: `${cap(run)} results`,
        description: `The results of one ${run}: each finding's check, asset and source records, its status (pass, fail, error, not_applicable, unknown), fingerprint and evidence.`,
        input: { run_id: runId }, annotations: READ });
      add({ generated: n("cancel", runTok), op: "cancel_run", door: "workspace", needs: "launch", admin_needs: "accounts",
        title: `Cancel a ${run}`,
        description: `Cancel a queued or running ${run} of ${packName}: a queued one ends now; a running one stops spending at once and ends at its next heartbeat.`,
        input: { run_id: runId }, annotations: WRITE(true, true) });
      for (const k of kinds) if (k.report) {
        const label = plain(k.label ?? k.name, 80), what = plain(k.report.label ?? "report", 80);
        add({ generated: n("get", `${k.name}_report`), op: "report", door: "workspace", kind: k.name, needs: "read", admin_needs: "read",
          title: `${label}: ${what}`,
          description: `The ${what} a succeeded ${run} of ${label} wrote (${k.report.format}, from the ${ws}'s files as that ${run} left them).`,
          input: { run_id: runId }, annotations: READ });
      }
    }

    // ---------- the admin MCP: shared areas and upstream catalogs, for platform staff ----------
    for (const a of areas.filter((x) => x.scope === "platform")) {
      const label = plain(a.label, 80);
      const readOnly = !!repoKind(a) && (READ_ONLY_KINDS as readonly string[]).includes(repoKind(a)!);
      const dataShape = Object.fromEntries(a.fields.map((f) => [f.name, fieldInput(f, labelOf)]));
      const body = { title: z.string().max(500).optional().describe("The record's title"), data: z.strictObject(dataShape).describe("The record's fields") };
      add({ generated: n("admin_list", a.name), op: "admin_list", door: "admin", area: a.name, admin_needs: "read",
        title: `Shared ${label}: list`, description: `Staff: list the shared ${label} records every ${ws} reads, a page at a time (pass next as after).`,
        input: { limit: z.number().int().min(1).max(200).optional().describe("Records per page (default 50)"), after: z.string().min(1).max(2000).optional().describe("The next value of the previous page") },
        annotations: READ });
      add({ generated: n("admin_get", a.name), op: "admin_get", door: "admin", area: a.name, admin_needs: "read",
        title: `Shared ${label}: get`, description: `Staff: one shared ${label} record by its key.`,
        input: { key: recordKey(`The ${label} record's key`) }, annotations: READ });
      if (readOnly) continue;
      add({ generated: n("admin_create", a.name), op: "admin_create", door: "admin", area: a.name, admin_needs: "library",
        title: `Shared ${label}: add`, description: `Staff: add a shared ${label} record, read by every ${ws} (refused when the key exists).`,
        input: { key: recordKey(`The new record's key (${KEY_TEXT})`), ...body }, annotations: WRITE(false, false) });
      add({ generated: n("admin_update", a.name), op: "admin_update", door: "admin", area: a.name, admin_needs: "library",
        title: `Shared ${label}: change`, description: `Staff: replace a shared ${label} record's title and fields (every ${ws} reads the change).`,
        input: { key: recordKey(`The ${label} record's key`), ...body }, annotations: WRITE(true, true) });
      add({ generated: n("admin_delete", a.name), op: "admin_delete", door: "admin", area: a.name, admin_needs: "delete",
        title: `Shared ${label}: delete`, description: `Staff: delete a shared ${label} record.`,
        input: { key: recordKey(`The ${label} record's key`) }, annotations: WRITE(true, true) });
    }
    for (const [rn, raw] of Object.entries(p.definition.repositories ?? {})) {
      const r = RepositorySchema.safeParse(raw);
      if (!r.success || r.data.kind !== "upstream_catalog") continue;
      add({ generated: n("admin_sync", rn), op: "admin_sync", door: "admin", repository: rn, admin_needs: "library",
        title: `Index ${rn}`, description: `Staff: index the upstream catalog ${rn} at its pinned commit into its shared areas (idempotent; force passes the guard against pruning many rows and needs the delete permission).`,
        input: { force: z.boolean().optional().describe("Pass the prune guard (needs the delete permission)") }, annotations: WRITE(true, true, true) });
    }

    // ---------- the pack's mcp settings ----------
    const generated = new Set(tools.map((t) => t.generated));
    const named = (list: readonly string[] | undefined, key: string) => { for (const x of list ?? []) if (!generated.has(x)) problems.push(at(`${key} names ${x}, which is not one of this pack's generated tools (${[...generated].join(", ") || "none"})`)); };
    named(settings.include, "include"); named(settings.exclude, "exclude"); named(settings.admin_only, "admin_only");
    named(Object.keys(settings.rename ?? {}), "rename"); named(Object.keys(settings.describe ?? {}), "describe");
    const include = settings.include ? new Set(settings.include) : null, exclude = new Set(settings.exclude ?? []), adminOnly = new Set(settings.admin_only ?? []);
    for (const t of tools) {
      if ((include && !include.has(t.generated)) || exclude.has(t.generated)) { held(t, "exclude"); continue; }
      if (adminOnly.has(t.generated)) {
        if (t.door === "admin") { problems.push(at(`admin_only names ${t.generated}, which is on the admin MCP already`)); continue; }
        // On the admin MCP it names the workspace it acts for.
        if ("workspace" in t.input) { problems.push(at(`admin_only names ${t.generated}, whose argument workspace would clash with the workspace staff name`)); continue; }
        t.admin_only = true;
        held(t, "admin_only");
      }
      t.name = settings.rename?.[t.generated] ?? t.generated;
      if (settings.describe?.[t.generated]) t.description = plain(settings.describe[t.generated], 1000);
      if (t.name.length > MAX_NAME || !NAME.test(t.name))
        problems.push(at(`tool ${t.name} is longer than ${MAX_NAME} characters (MCP clients refuse it): set a shorter mcp.prefix, or rename it`));
      out.push(t);
    }
  }
  // One name, one tool, on each server: the customer MCP's (with the shell's and the packs' own) and the admin MCP's.
  // A pack's own hand-written tool of a generated tool's name replaces it (code stays the escape hatch, mold_v0-057).
  const owner = { customer: new Map<string, string>((reserved.customer ?? []).map((x) => [x, "the shell's or a pack's own tool"])),
    admin: new Map<string, string>((reserved.admin ?? []).map((x) => [x, "an admin MCP tool of the shell"])) };
  const own = new Map<string, string>();
  for (const p of packs) for (const t of p.definition.tools ?? []) if (t && typeof t.name === "string") {
    own.set(t.name, p.id);
    if (!owner.customer.has(t.name)) owner.customer.set(t.name, `pack ${p.id}'s own tool`);
  }
  const kept: GeneratedTool[] = [];
  for (const t of out) {
    const server = t.door === "admin" || t.admin_only ? "admin" : "customer";
    if (server === "customer" && own.get(t.name) === t.pack) continue;
    kept.push(t);
    const prior = owner[server].get(t.name);
    if (prior) problems.push(`pack ${t.pack}: mcp: tool ${t.name} (${t.generated}) clashes with ${prior} on the ${server} MCP: rename it or set mcp.prefix`);
    else owner[server].set(t.name, `pack ${t.pack}'s ${t.generated}`);
  }
  return { tools: kept, problems, withheld };
}
