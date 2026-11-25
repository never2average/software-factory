/**
 * The developer surface's declaration (mold_v0-193; molds/mold_v0/MOLD.md "Developer surface"): what an app of kind
 * `embedded` gives the developers of the product it is built into. It is on in a build where one pack's pack.json (or
 * the app's profile.json) declares `developer_surface`; in every other build nothing of it is mounted, listed or read.
 *
 *   events          the events the build emits to the workspaces' webhook endpoints (Standard Webhooks), each a name
 *                   from EVENT_CATALOG, what it means, optionally `areas` (record events of those areas only)
 *   sdk_languages   the SDKs generated at build time (typescript, python)
 *   client_sessions short-lived tokens a workspace's backend mints for its signed-in users: ttl_seconds (the longest
 *                   one may live), allowed_origins (browser origins every workspace may call from; each workspace adds
 *                   its own), scopes (what a session may ever hold; absent: read and write)
 *   webhooks_in     inbound receivers: a verified payload (or each item of a list in it) written into one of the
 *                   build's workspace record areas, its key, title and fields read by JSON Pointer
 *   api_version     (optional) the version a key made today is pinned to; one of API_VERSIONS (default the latest)
 *
 * mold_v0-347: events, sdk_languages and client_sessions are each optional (developerSurfaceDefaults fills them): a
 * surface may be its receivers alone. With no event there are no webhooks out (hasWebhooksOut): no Settings tab, no
 * endpoint routes, nothing in the API's description; with no client_sessions a session holds read only, from the
 * origins a workspace adds itself.
 *
 * No imports: scripts/gen-packs.mjs loads this file directly (node's type stripping) to check a declaration against the
 * build's areas, and src/developer-docs.ts (the guide's pages) reads the same catalog.
 */

/** The API's versions, oldest first (date versioning: a key is pinned to the version it was made at; API-Version overrides). */
export const API_VERSIONS = ["2026-11-01"] as const;
export const LATEST_API_VERSION: string = API_VERSIONS[API_VERSIONS.length - 1]!;

/** Every event the shell can emit, and what it carries. `webhook.test` (a test ping) is always sent on request, never declared. */
export const EVENT_CATALOG = {
  "record.created": { about: "A record was created in one of the workspace's areas.", record: true },
  "record.updated": { about: "A record's title or fields were replaced (its state kept).", record: true },
  "record.state_changed": { about: "A record moved along its area's lifecycle (from, to).", record: true },
  "record.deleted": { about: "A record was deleted.", record: true },
  "run.finished": { about: "A run ended: succeeded, failed or cancelled.", record: false },
  // A record clock (mold_v0-191, src/record-clocks.ts) calls emitEvent when it goes overdue: once per record, clock and deadline.
  "clock.overdue": { about: "A record's deadline clock passed its due time.", record: false },
} as const;
export type EventName = keyof typeof EVENT_CATALOG;
export const EVENT_NAMES = Object.keys(EVENT_CATALOG) as EventName[];
export const TEST_EVENT = "webhook.test";

/**
 * Scopes a key or a client session holds. `read`, `write` and `run` may be narrowed to one area or kind
 * (`read:<area>`, `write:<area>`, `run:<kind>`); `sessions` mints client sessions and manages the browser origins;
 * `webhooks` manages webhook endpoints and inbound sources; `checks` asks the build's declarative checks (mold_v0-196,
 * src/checks.ts), narrowed as `checks:<name>`. An integration key holds exactly one scope.
 */
export const BASE_SCOPES = ["read", "write", "run", "sessions", "webhooks", "checks"] as const;
export type BaseScope = (typeof BASE_SCOPES)[number];
/**
 * What a client session may ever hold (a browser or phone never manages keys, sessions or webhooks): read, write, run
 * and checks, each maybe narrowed (`checks:<name>`, mold_v0-224). The declaration's client_sessions.scopes, the pack
 * schema (src/pack-manifest.ts) and the app spec's schema take exactly these (SESSION_SCOPE_PATTERN).
 */
export const SESSION_SCOPES = ["read", "write", "run", "checks"] as const;
export const DEFAULT_SESSION_SCOPES = ["read", "write"];
export const SCOPE_PATTERN = /^(read|write|run|sessions|webhooks|checks)(:[a-z][a-z0-9_]{0,63})?$/;
export const SESSION_SCOPE_PATTERN = /^(read|write|run|checks)(:[a-z][a-z0-9_]{0,63})?$/;

export const SDK_LANGUAGES = ["typescript", "python"] as const;

export interface DeveloperEvent { name: string; description: string; areas?: string[]; payload?: Record<string, unknown> }
export interface InboundReceiver {
  name: string;
  description?: string;
  area: string;
  /** JSON Pointer to a list in the payload: each item is one record (absent: the payload is one record). */
  items?: string;
  /** JSON Pointers into the payload (or the item): its key, its title, and each field (optional for a log drain). */
  key?: string;
  title?: string;
  fields?: Record<string, string>;
  /** Only payloads whose `type` is one of these are written (absent: any). */
  types?: string[];
  /** How the sender signs (mold_v0-303): "standard" (Standard Webhooks, the default) or "vercel" (x-vercel-signature). */
  signature?: "standard" | "vercel";
  /** A hosting provider's request logs reduced to per-deployment, per-window report records (mold_v0-303, src/log-drain.ts). */
  log_drain?: LogDrainDeclaration;
}
/** A log-drain receiver's options as declared (their shape is src/pack-manifest.ts's; src/log-drain.ts reads them). */
export interface LogDrainDeclaration {
  secret_env?: string;
  verify_env?: string;
  window_minutes?: number;
  max_bytes?: number;
  deployments: { area: string; field: string; match?: "deployment_id" | "project_id" | "host" };
  fields?: Partial<Record<string, string>>;
  sources?: string[];
  environments?: string[];
  source_label?: string;
  /** mold_v0-325: hours without a delivery before the source is called silent (default 6). */
  silent_hours?: number;
  /** mold_v0-325: the A/B comparison of each deployment with the one it replaced, kept as records of `area`. */
  compare?: { area: string; previous_field?: string; hours?: number; min_requests?: number; min_error_points?: number; min_z?: number; p95_rise?: number; fields?: Partial<Record<string, string>> };
}
export interface DeveloperSurfaceConfig {
  events: DeveloperEvent[];
  sdk_languages: string[];
  client_sessions: { ttl_seconds: number; allowed_origins: string[]; scopes?: string[] };
  webhooks_in?: InboundReceiver[];
  api_version?: string;
}

/** What a declaration leaves out, filled in (mold_v0-347): no events, no SDK, client sessions of read only and an hour. */
export const SESSIONS_WHEN_UNDECLARED = { ttl_seconds: 3600, allowed_origins: [] as string[], scopes: ["read"] };
export function developerSurfaceDefaults<T extends Partial<DeveloperSurfaceConfig>>(c: T): T & DeveloperSurfaceConfig {
  const cs = c.client_sessions ? { ...c.client_sessions, ttl_seconds: c.client_sessions.ttl_seconds ?? 3600 } : { ...SESSIONS_WHEN_UNDECLARED, scopes: [...SESSIONS_WHEN_UNDECLARED.scopes] };
  return { ...c, events: c.events ?? [], sdk_languages: c.sdk_languages ?? [], client_sessions: cs } as T & DeveloperSurfaceConfig;
}
/** Whether the build has webhooks out (mold_v0-347): only when it declares an event to send. */
export const hasWebhooksOut = (c: Pick<DeveloperSurfaceConfig, "events"> | null | undefined) => !!c?.events?.length;

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
const POINTER = /^(\/([^~/]|~[01])*)*$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A field of a record area as the check needs it. */
export interface AreaFacts { name: string; scope: string; fields: string[]; sealed?: boolean;
  /** mold_v0-325: each enum field's option values, each reference field's target area (a log drain's comparisons). */
  enums?: Record<string, string[]>; refs?: Record<string, string> }

/**
 * Every problem of a declaration against the build's areas, job kinds and declarative checks (`checks`: their names;
 * absent: not checked), as sentences; none: it is sound. The shape itself (types, lengths) is src/pack-manifest.ts's;
 * this is what only the whole build can say.
 */
export function developerSurfaceProblems(cfg: DeveloperSurfaceConfig, areas: AreaFacts[], checks?: readonly string[], kinds?: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of (cfg.events ?? []).entries()) {
    if (!(EVENT_NAMES as string[]).includes(e.name)) out.push(`events[${i}].name: ${e.name} is not an event the shell emits (${EVENT_NAMES.join(", ")})`);
    if (seen.has(e.name)) out.push(`events[${i}].name: ${e.name} is declared twice`);
    seen.add(e.name);
    if (e.areas?.length) {
      if (!(EVENT_CATALOG as Record<string, { record: boolean }>)[e.name]?.record) out.push(`events[${i}].areas: only a record event names areas`);
      for (const a of e.areas) if (!areas.some((x) => x.name === a && x.scope === "workspace")) out.push(`events[${i}].areas: ${a} is not one of the build's workspace record areas`);
    }
  }
  for (const l of cfg.sdk_languages ?? []) if (!(SDK_LANGUAGES as readonly string[]).includes(l)) out.push(`sdk_languages: ${l} is not generated by this mold (${SDK_LANGUAGES.join(", ")})`);
  const cs = cfg.client_sessions;
  if (cs) {
    for (const o of cs.allowed_origins ?? []) if (!ORIGIN.test(o)) out.push(`client_sessions.allowed_origins: ${o} is not an https origin like https://app.example.com`);
    for (const s of cs.scopes ?? []) {
      const [base, target] = s.split(":") as [string, string?];
      if (!SESSION_SCOPE_PATTERN.test(s)) { out.push(`client_sessions.scopes: ${s} is not a scope a client session may hold (${SESSION_SCOPES.join(", ")}, or one narrowed like read:<area> or checks:<check>)`); continue; }
      if (target === undefined) continue;
      if ((base === "read" || base === "write") && !areas.some((a) => a.name === target)) out.push(`client_sessions.scopes: ${s}: ${target} is not one of the build's record areas`);
      if (base === "checks" && checks && !checks.includes(target)) out.push(`client_sessions.scopes: ${s}: ${target} is not one of the build's checks${checks.length ? ` (${checks.join(", ")})` : " (it declares none)"}`);
      if (base === "run" && kinds && !kinds.includes(target)) out.push(`client_sessions.scopes: ${s}: ${target} is not one of the build's job kinds`);
    }
    if ((cs.scopes ?? []).some((s) => s.split(":")[0] === "checks") && checks && !checks.length) out.push("client_sessions.scopes: checks: the build declares no check (pack.json checks) for a session to ask");
  }
  const names = new Set<string>();
  for (const [i, r] of (cfg.webhooks_in ?? []).entries()) {
    if (!NAME.test(r.name)) out.push(`webhooks_in[${i}].name: lowercase letters, digits and _`);
    if (names.has(r.name)) out.push(`webhooks_in[${i}].name: ${r.name} is declared twice`);
    names.add(r.name);
    const a = areas.find((x) => x.name === r.area);
    if (!a) out.push(`webhooks_in[${i}].area: ${r.area} is not one of the build's record areas`);
    else if (a.scope !== "workspace") out.push(`webhooks_in[${i}].area: ${r.area} is a shared (platform) area: an inbound receiver writes a workspace's own records`);
    for (const [what, p] of [["key", r.key], ["title", r.title], ["items", r.items]] as const)
      if (p !== undefined && !POINTER.test(p)) out.push(`webhooks_in[${i}].${what}: ${p} is not a JSON Pointer (like /id or /finding/title)`);
    for (const [f, p] of Object.entries(r.fields ?? {})) {
      if (a && !a.fields.includes(f)) out.push(`webhooks_in[${i}].fields.${f}: not a field of ${r.area}`);
      if (!POINTER.test(p)) out.push(`webhooks_in[${i}].fields.${f}: ${p} is not a JSON Pointer`);
    }
    if (!r.log_drain && (r.key === undefined || r.fields === undefined)) out.push(`webhooks_in[${i}]: a receiver that is not a log drain names its key and fields`);
    out.push(...logDrainProblems(i, r, areas));
  }
  if (cfg.api_version !== undefined && !(API_VERSIONS as readonly string[]).includes(cfg.api_version)) out.push(`api_version: ${cfg.api_version} is not one of ${API_VERSIONS.join(", ")}`);
  return out;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * What only the whole build can say of a log-drain receiver (mold_v0-303; src/log-drain.ts re-exports it): its secret
 * and verification token are environment names, its deployments area and field are the build's, and each mapped
 * report field is a field of its area. Here, not in src/log-drain.ts, because this file has no imports (gen-packs).
 */
export function logDrainProblems(i: number, r: unknown, areas: AreaFacts[]): string[] {
  const ld = (r as { log_drain?: unknown } | null)?.log_drain;
  if (!ld || typeof ld !== "object" || Array.isArray(ld)) return [];
  const o = ld as Record<string, unknown>;
  const out: string[] = [];
  const at = `webhooks_in[${i}].log_drain`;
  for (const k of ["secret_env", "verify_env"] as const)
    if (o[k] !== undefined && !(typeof o[k] === "string" && ENV_NAME.test(o[k] as string))) out.push(`${at}.${k}: an environment variable's name (A-Z, 0-9, _), never a secret's value`);
  const d = (o.deployments && typeof o.deployments === "object" ? o.deployments : {}) as Record<string, unknown>;
  const depName = typeof d.area === "string" && NAME.test(d.area) ? d.area : "deployments";
  const depField = typeof d.field === "string" && (NAME.test(d.field) || d.field === "$key") ? d.field : "$key";
  const dep = areas.find((a) => a.name === depName);
  if (!dep) out.push(`${at}.deployments.area: ${depName} is not one of the build's record areas`);
  else if (depField !== "$key" && !dep.fields.includes(depField)) out.push(`${at}.deployments.field: not a field of ${dep.name}`);
  const rep = areas.find((a) => a.name === (r as { area?: string }).area);
  const fm = (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<string, unknown>;
  if (rep) for (const [k, f] of Object.entries(fm)) if (typeof f === "string" && !rep.fields.includes(f)) out.push(`${at}.fields.${k}: ${f} is not a field of ${rep.name}`);
  // mold_v0-325: the comparisons' area, the deployments' previous field, the verdict's options.
  const c = o.compare;
  if (c !== undefined) {
    const co = (c && typeof c === "object" && !Array.isArray(c) ? c : {}) as Record<string, unknown>;
    const cmp = areas.find((a) => a.name === co.area);
    if (!cmp) out.push(`${at}.compare.area: ${String(co.area)} is not one of the build's record areas`);
    else if (cmp.scope !== "workspace") out.push(`${at}.compare.area: ${cmp.name} is a shared area: comparisons are a workspace's own records`);
    const prev = typeof co.previous_field === "string" ? co.previous_field : "previous";
    if (dep && !dep.fields.includes(prev)) out.push(`${at}.compare.previous_field: ${prev} is not a field of ${dep.name} (the deployment each one replaced)`);
    else if (dep?.refs && dep.refs[prev] !== undefined && dep.refs[prev] !== dep.name) out.push(`${at}.compare.previous_field: ${prev} refers to ${dep.refs[prev]}, not ${dep.name}`);
    const cf = (co.fields && typeof co.fields === "object" ? co.fields : {}) as Record<string, unknown>;
    if (cmp) {
      for (const [k, f] of Object.entries(cf)) if (typeof f === "string" && !cmp.fields.includes(f)) out.push(`${at}.compare.fields.${k}: ${f} is not a field of ${cmp.name}`);
      const verdict = typeof cf.verdict === "string" ? cf.verdict : "verdict";
      const opts = cmp.enums?.[verdict];
      if (!cmp.fields.includes(verdict)) out.push(`${at}.compare: ${cmp.name} has no ${verdict} field for the verdict`);
      else if (opts) for (const v of ["insufficient_data", "no_change_detected", "regressed"]) if (!opts.includes(v)) out.push(`${at}.compare: ${cmp.name}.${verdict} has no option ${v}`);
    }
  }
  return out;
}

/** The scope a request needs for an action over an area or a kind; a key holds it when it has the base or the narrowed scope. */
export function scopeAllows(held: readonly string[], base: BaseScope, target?: string | null): boolean {
  return held.includes(base) || (target != null && held.includes(`${base}:${target}`));
}

/** Read a JSON Pointer (RFC 6901) out of a value; undefined when it is not there. */
export function pointer(v: unknown, p: string): unknown {
  if (p === "") return v;
  let cur: unknown = v;
  for (const raw of p.slice(1).split("/")) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
  }
  return cur;
}
