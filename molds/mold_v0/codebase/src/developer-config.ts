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
  // Emitted once ticket mold_v0-191's deadline clocks land (they call emitEvent from src/developer-webhooks.ts).
  "clock.overdue": { about: "A record's deadline clock passed its due time.", record: false },
} as const;
export type EventName = keyof typeof EVENT_CATALOG;
export const EVENT_NAMES = Object.keys(EVENT_CATALOG) as EventName[];
export const TEST_EVENT = "webhook.test";

/**
 * Scopes a key or a client session holds. `read`, `write` and `run` may be narrowed to one area or kind
 * (`read:<area>`, `write:<area>`, `run:<kind>`); `sessions` mints client sessions and manages the browser origins;
 * `webhooks` manages webhook endpoints and inbound sources. An integration key holds exactly one scope.
 */
export const BASE_SCOPES = ["read", "write", "run", "sessions", "webhooks"] as const;
export type BaseScope = (typeof BASE_SCOPES)[number];
/** What a client session may ever hold (a browser or phone never manages keys, sessions or webhooks). */
export const SESSION_SCOPES = ["read", "write", "run"] as const;
export const DEFAULT_SESSION_SCOPES = ["read", "write"];
export const SCOPE_PATTERN = /^(read|write|run|sessions|webhooks)(:[a-z][a-z0-9_]{0,63})?$/;

export const SDK_LANGUAGES = ["typescript", "python"] as const;

export interface DeveloperEvent { name: string; description: string; areas?: string[]; payload?: Record<string, unknown> }
export interface InboundReceiver {
  name: string;
  description?: string;
  area: string;
  /** JSON Pointer to a list in the payload: each item is one record (absent: the payload is one record). */
  items?: string;
  /** JSON Pointers into the payload (or the item): its key, its title, and each field. */
  key: string;
  title?: string;
  fields: Record<string, string>;
  /** Only payloads whose `type` is one of these are written (absent: any). */
  types?: string[];
}
export interface DeveloperSurfaceConfig {
  events: DeveloperEvent[];
  sdk_languages: string[];
  client_sessions: { ttl_seconds: number; allowed_origins: string[]; scopes?: string[] };
  webhooks_in?: InboundReceiver[];
  api_version?: string;
}

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
const POINTER = /^(\/([^~/]|~[01])*)*$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A field of a record area as the check needs it. */
export interface AreaFacts { name: string; scope: string; fields: string[]; sealed?: boolean }

/**
 * Every problem of a declaration against the build's areas and job kinds, as sentences; none: it is sound. The shape
 * itself (types, lengths) is src/pack-manifest.ts's; this is what only the whole build can say.
 */
export function developerSurfaceProblems(cfg: DeveloperSurfaceConfig, areas: AreaFacts[]): string[] {
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
      const base = s.split(":")[0]!;
      if (!SCOPE_PATTERN.test(s) || !(SESSION_SCOPES as readonly string[]).includes(base)) out.push(`client_sessions.scopes: ${s} is not a scope a client session may hold (${SESSION_SCOPES.join(", ")}, or one narrowed like read:<area>)`);
    }
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
  }
  if (cfg.api_version !== undefined && !(API_VERSIONS as readonly string[]).includes(cfg.api_version)) out.push(`api_version: ${cfg.api_version} is not one of ${API_VERSIONS.join(", ")}`);
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
