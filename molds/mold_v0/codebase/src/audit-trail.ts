/**
 * The audit trails (mold_v0-197): two toggles in the profile, each off unless the app turns it on (profile.json
 * `audit`: {"data": true, "platform": false, "retention_days": 400}), each written by this module only.
 *
 *   data       the company's data trail: every read, change, reveal and export of a workspace's records (record areas'
 *              workspace rows, files in the workspace store, run results), from the console, the API, MCP, a run or
 *              staff. Each entry: who (a person, a key, staff as a pseudonym, an agent run, the system), what (list,
 *              read, reveal, export, create, update, move, delete), on what (the area or store, the record's key or the
 *              file's path, how many rows), when and through which door. A read is one entry per list or detail, never
 *              one per row, and never with the record's contents: no field value is ever written here.
 *              Per workspace, under row-level security: the workspace's owners read it on the console's Access log
 *              page, as CSV, and through the MCP tool read_audit_trail; platform staff through the admin MCP.
 *   platform   the platform usage trail: every API and MCP request and sign-in (the key's id and prefix, never the key;
 *              the actor, the scopes it acted with, the result code and the latency), and every staff action on an
 *              account (the admin console's API and the admin MCP's tools). The operator reads it fleet-wide (admin
 *              console, admin MCP read_platform_trail); a workspace's owners read their own workspace's slice.
 *
 * Separate from usage metering: mcp_events, compute_events and run_events stay as they are, for billing and analytics.
 * Off, nothing is written, no route answers, no page shows and no tool is listed (the MCP surface is unchanged).
 *
 * Writes are batched: entries queue in memory and go to the database in one transaction per flush (at most every
 * 200 ms, at 200 entries, and when a request ends), each workspace's entries numbered by a monotonic, gapless
 * per-workspace sequence (audit_sequences, taken under its row's lock, so a workspace's entries are numbered in commit
 * order). The tables are append-only (sql/migrations/0031_audit_trails.sql: a trigger refuses every update, and every
 * delete but the retention prune's and a removed workspace's cascade): the shape chain-and-sign (mold_v0-195) needs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Org } from "./auth.js";
import { getDb, type Queryable } from "./db.js";
import { PROFILE } from "./profile.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

// ---------------------------------------------------------------- settings

export interface AuditSettings { data: boolean; platform: boolean; retention_days: number; platform_retention_days: number }
/** profile.json `audit` (src/profile.ts ProfileAudit): both trails off unless set; 400 days of each kept by default. */
export const DEFAULT_RETENTION_DAYS = 400;
let testSettings: Partial<AuditSettings> | null = null;
export function auditSettings(profile?: { audit?: Partial<AuditSettings> }): AuditSettings {
  const p = profile ? { ...(profile.audit ?? {}) } : { ...((PROFILE as { audit?: Partial<AuditSettings> }).audit ?? {}), ...(testSettings ?? {}) };
  const days = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 3650 ? v : d);
  const retention = days(p.retention_days, DEFAULT_RETENTION_DAYS);
  return { data: p.data === true, platform: p.platform === true, retention_days: retention, platform_retention_days: days(p.platform_retention_days, retention) };
}
export const dataTrailOn = () => auditSettings().data;
export const platformTrailOn = () => auditSettings().platform;
export const anyTrailOn = () => dataTrailOn() || platformTrailOn();
/** Tests only: turn the trails on or off as the profile would (null: the profile's own settings). */
export function setAuditForTest(s: Partial<AuditSettings> | null) { testSettings = s; }

// ---------------------------------------------------------------- who is acting, through which door

export type Channel = "console" | "api" | "mcp" | "admin_console" | "admin_mcp" | "run" | "system";
export type ActorKind = "user" | "key" | "staff" | "agent_run" | "system";
export interface AuditActor { kind: ActorKind; id: string | null; key_id?: number | null; scopes?: string[] }
export type DataAction = "list" | "read" | "reveal" | "export" | "create" | "update" | "move" | "delete";
export type DataTarget = "record" | "file" | "run_result";

interface Ctx {
  channel: Channel;
  req?: Request;
  res?: Response;
  /** The MCP caller (auditCaller), or the workspace a sign-in opened. */
  org?: Org;
  actor?: AuditActor;
  /** The platform entry's workspace when nothing else names it (a sign-in, a staff action on an account). */
  orgId?: number | null;
  kind?: "request" | "sign_in" | "staff";
  /** A list read on behalf of an export (the console's Export CSV pages through the list route). */
  listAs?: "export";
  quiet?: boolean;
  collect?: DataRow[] | null;
}
const als = new AsyncLocalStorage<Ctx>();
const current = () => als.getStore();

/** The same pseudonym the activity log gives staff in a workspace (src/analytics.ts staffId), never their identity. */
let staffIdFn: ((actor: string, orgId: number) => string) | null = null;
const pseudonym = async (actor: string, orgId: number) => {
  staffIdFn ??= (await import("./analytics.js")).staffId;
  return staffIdFn(actor, orgId);
};

function actorOf(c: Ctx | undefined): AuditActor {
  if (!c) return { kind: "system", id: null };
  if (c.actor) return c.actor;
  const o = c.org;
  if (o) {
    if (o.staff) return { kind: "staff", id: o.staff, scopes: ["staff"] };
    if (o.keyId != null) return { kind: o.userId ? "user" : "key", id: o.userId ?? `key:${o.keyId}`, key_id: o.keyId, scopes: o.role ? ["member_key", `role:${o.role}`] : ["workspace_key"] };
    if (o.userId) return { kind: "user", id: o.userId, scopes: ["sign_in", ...(o.role ? [`role:${o.role}`] : [])] };
  }
  const l = c.res?.locals as Record<string, any> | undefined;
  if (l?.session) return { kind: "user", id: l.session.user ?? null, scopes: ["session", `role:${l.session.accountRole ?? l.session.role}`] };
  if (l?.adminActor) return { kind: "staff", id: String(l.adminActor), scopes: ["staff", `platform:${l.adminRole ?? "?"}`] };
  if (l?.worker?.runId) return { kind: "agent_run", id: String(l.worker.runId) };
  return { kind: "system", id: null };
}
/**
 * The door, now: a customer route's request made with a person's console session (src/app.ts customerSession: its
 * cookie or its session token) is the console's; anything else under /api (keys, OAuth) is the API's.
 */
function channelNow(c: Ctx | undefined): Channel {
  if (!c) return "system";
  const l = c.res?.locals as Record<string, any> | undefined;
  if (c.channel === "api" && l?.session) return "console";
  return c.channel;
}
const orgOf = (c: Ctx | undefined): number | null => {
  if (!c) return null;
  if (c.org) return c.org.orgId;
  const s = (c.res?.locals as Record<string, any> | undefined)?.session;
  return typeof s?.org === "number" ? s.org : c.orgId ?? null;
};

/** The request's door, by its path (mounted once, first, in src/http.ts). */
function channelOf(path: string): Channel | null {
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  if (/^\/(api\/)?admin\/mcp(\/|$)/.test(path)) return "admin_mcp";
  if (path.startsWith("/api/admin/")) return "admin_console";
  if (path.startsWith("/api/worker/") || path.startsWith("/api/runner/")) return "run";
  if (path.startsWith("/api/cron/")) return null;
  // An embedded app's developer API (mold_v0-193, src/developer-api.ts): its key or client session names the actor (auditApiCaller).
  if (path.startsWith("/v1/")) return "api";
  if (path.startsWith("/api/") || path.startsWith("/oauth/") || path === "/token" || path === "/register") return "api";
  return null;
}
/** Sign-ins: the built-in sign-in's code check and Google's return, and the MCP authorization server's token grants. */
const SIGN_IN = /^\/(api\/auth\/(email\/verify|google\/callback)|oauth\/token|token)$/;

/**
 * Express middleware, first in the app: gives every API, MCP, admin and worker request its audit context (the door
 * and, once known, who is acting), and when the platform trail is on, writes the request's entry when it ends. With
 * both trails off it only passes the request on.
 */
export function auditRequests(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!anyTrailOn()) return next();
    const path = req.path;
    // The Vercel cron's tick (src/http.ts /api/cron/autoscale): the trails' retention, once it answered (authorized).
    if (path === "/api/cron/autoscale") {
      res.on("finish", () => { if (res.statusCode === 200) keepAliveAudit(pruneAudit().catch((e) => console.error(`audit trail prune: ${(e as Error).message}`))); });
      return next();
    }
    const channel = channelOf(path);
    if (!channel) return next();
    const run = channel === "run" ? /^\/api\/(worker|runner)\/runs\/([^/]+)/.exec(path)?.[2] : undefined;
    const ctx: Ctx = { channel, req, res, ...(run ? { actor: { kind: "agent_run", id: decodeURIComponent(run) } } : {}),
      kind: SIGN_IN.test(path) ? "sign_in" : channel === "admin_console" ? "staff" : "request" };
    const t0 = performance.now();
    // Once per request: when it was answered, or when the client went away first (its status as it stood).
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      // Machine traffic (a run's worker API) and the admin MCP (one staff entry per tool call: src/admin-mcp.ts) are not
      // request entries; everything else is.
      if (platformTrailOn() && channel !== "run" && channel !== "admin_mcp") {
        const rpc = channel === "mcp" ? mcpSummary(req.body) : null;
        platformEntry({
          kind: ctx.kind ?? "request", channel: channelNow(ctx), method: req.method, path: (rpc ? `${path} ${rpc}` : path).slice(0, 300),
          status: res.statusCode, latency_ms: Math.round(performance.now() - t0), ip: String(req.ip ?? "").slice(0, 64),
          actor: actorOf(ctx), org_id: orgOf(ctx), org_slug: channel === "admin_console" ? /\/orgs\/([^/]+)/.exec(path)?.[1] ?? null : null,
        });
      }
      kick(true);
    };
    res.on("finish", end);
    res.on("close", end);
    als.run(ctx, () => next());
  };
}
/** An MCP request's methods (a tool call by its tool's name), never its arguments. */
function mcpSummary(body: unknown): string | null {
  const msgs = (Array.isArray(body) ? body : body ? [body] : []) as { method?: unknown; params?: { name?: unknown } }[];
  const s = msgs.map((m) => (m?.method === "tools/call" && typeof m.params?.name === "string" ? `tools/call:${m.params.name}` : typeof m?.method === "string" ? m.method : null))
    .filter(Boolean).join(",");
  return s ? s.slice(0, 200) : null;
}

/** The MCP caller, once signed in (src/http.ts mcp): every entry of the request is theirs. */
export function auditCaller(org: Org) { const c = current(); if (c) c.org = org; }
/**
 * A developer API caller, once authenticated (mold_v0-193, src/developer-api.ts): a workspace key or a client session,
 * the user it acts for, the scopes it held. Every entry of the request (its platform entry, its data entries) is theirs.
 */
export function auditApiCaller(orgId: number, actor: AuditActor) { const c = current(); if (c) { c.orgId = orgId; c.actor = actor; } }
/** A sign-in that opened a session (src/builtin-auth.ts startSession): the request's entry names the person and workspace. */
export function auditSignIn(userId: string, orgId: number | null, method: string) {
  const c = current();
  if (!c) return;
  c.kind = "sign_in";
  c.actor = { kind: "user", id: userId, scopes: ["sign_in", method] };
  c.orgId = orgId;
}
/** Run fn with an explicit actor and door (staff through the admin MCP, a run's hook): entries inside are theirs. */
export function withAuditActor<T>(channel: Channel, actor: AuditActor, fn: () => T): T {
  if (!anyTrailOn()) return fn();
  return als.run({ ...(current() ?? {}), channel, actor, quiet: false, collect: current()?.collect ?? null }, fn);
}
/** Express middleware for the records routes: a list asked for with ?audit=export is an export (the console's Export CSV). */
export function auditListPurpose(req: Request, _res: Response, next: NextFunction) {
  const c = current();
  if (c && req.query.audit === "export") c.listAs = "export";
  next();
}

// ---------------------------------------------------------------- the data trail

interface DataRow {
  org_id: number; actor: AuditActor; action: DataAction; target: DataTarget; pack: string | null; area: string | null;
  record_key: string | null; rows: number | null; channel: Channel;
}
export interface DataEntry { action: DataAction; target?: DataTarget; pack?: string | null; area?: string | null; key?: string | null; rows?: number | null }

/**
 * One entry of a workspace's data trail: what was done to which record, file or run's results, never a value. Inside
 * auditQuiet (the reads a logged operation makes for itself) nothing is written; inside auditAtomic it waits for the
 * operation to succeed.
 */
export function auditData(orgId: number | null | undefined, e: DataEntry): void {
  if (orgId == null || !dataTrailOn()) return;
  const c = current();
  if (c?.quiet) return;
  const action = e.action === "list" && c?.listAs === "export" ? "export" : e.action;
  const row: DataRow = { org_id: orgId, actor: actorOf(c), action, target: e.target ?? "record", pack: e.pack ?? null, area: e.area ?? null,
    record_key: e.key ?? null, rows: e.rows ?? null, channel: channelNow(c) };
  if (c?.collect) c.collect.push(row);
  else enqueueData(row);
}
/** Run fn without writing the entries it would make (a detail's linked records, an export's pages): its caller writes one. */
export function auditQuiet<T>(fn: () => T): T {
  if (!dataTrailOn()) return fn();
  return als.run({ ...(current() ?? { channel: "system" as const }), quiet: true }, fn);
}
/** Run fn, then write one entry for all of it (`entry(result)`, null: none); what fn reads inside is not written again. */
export async function auditAs<T>(orgId: number | null | undefined, fn: () => Promise<T>, entry: (r: T) => DataEntry | null): Promise<T> {
  if (!dataTrailOn() || orgId == null) return fn();
  const r = await auditQuiet(fn);
  const e = entry(r);
  if (e) auditData(orgId, e);
  return r;
}
/** Run fn (a batch: one transaction), keeping the entries it makes until it succeeds; a refused batch writes none. */
export async function auditAtomic<T>(fn: () => Promise<T>): Promise<T> {
  if (!dataTrailOn()) return fn();
  const outer = current();
  if (outer?.collect) return fn(); // already inside one: the outermost decides
  const collect: DataRow[] = [];
  const r = await als.run({ ...(outer ?? { channel: "system" as const }), collect }, fn);
  dataQueue.push(...collect); // one batch: queued whole, then written together
  kick();
  return r;
}

// ---------------------------------------------------------------- the platform trail

interface PlatformRow {
  kind: "request" | "sign_in" | "staff"; channel: Channel; method: string; path: string; status: number | null; latency_ms: number | null; ip: string | null;
  actor: AuditActor; org_id: number | null; org_slug: string | null;
}
function platformEntry(r: PlatformRow) { if (platformTrailOn()) { platformQueue.push(r); kick(); } }
/**
 * A staff member's action through the admin MCP (src/admin-mcp.ts audit): one entry per tool call, with the account it
 * named (the tool's slug, never its other arguments).
 */
export function auditStaff(actor: string, role: string, tool: string, status: number, ip: string | undefined, orgSlug: string | null) {
  if (!platformTrailOn()) return;
  platformEntry({ kind: "staff", channel: "admin_mcp", method: "MCP", path: `/admin/mcp/${tool}`.slice(0, 300), status, latency_ms: null, ip: (ip ?? "").slice(0, 64) || null,
    actor: { kind: "staff", id: actor.slice(0, 120), scopes: ["staff", `platform:${role}`] }, org_id: null, org_slug: orgSlug });
}

// ---------------------------------------------------------------- batched writes

const FLUSH_MS = 200, FLUSH_AT = 200, KEEP_MAX = 20_000;
let dataQueue: DataRow[] = [], platformQueue: PlatformRow[] = [];
let timer: NodeJS.Timeout | null = null, flushing: Promise<void> | null = null;
function enqueueData(row: DataRow) { dataQueue.push(row); kick(); }
/** On Vercel, the function stays up until `p` settles (src/telemetry.ts keepAlive); elsewhere nothing. */
const keepAliveAudit = (p: Promise<unknown>) => void import("./telemetry.js").then((t) => t.keepAlive(p)).catch(() => {});
function kick(now = false) {
  if (!dataQueue.length && !platformQueue.length) return;
  startPruning();
  if (now || dataQueue.length + platformQueue.length >= FLUSH_AT) {
    keepAliveAudit(flushAudit());
    return;
  }
  timer ??= setTimeout(() => { timer = null; void flushAudit(); }, FLUSH_MS);
  timer.unref?.();
}

/** Write what is queued now (tests, shutdown); resolves when it is in the database or was given up. */
export async function flushAudit(): Promise<void> {
  if (flushing) { await flushing; if (!dataQueue.length && !platformQueue.length) return; }
  if (timer) { clearTimeout(timer); timer = null; }
  const data = dataQueue, plat = platformQueue;
  dataQueue = []; platformQueue = [];
  if (!data.length && !plat.length) return;
  flushing = asPlatform(() => writeBatch(data, plat)).catch((e) => {
    console.error(`audit trail: ${data.length + plat.length} entr(ies) not written yet (${(e as Error).message}); retried with the next batch`);
    // Kept for the next flush, up to a bound: a database that stays down costs the oldest entries, never the process.
    dataQueue = [...data, ...dataQueue].slice(-KEEP_MAX);
    platformQueue = [...plat, ...platformQueue].slice(-KEEP_MAX);
  }).finally(() => { flushing = null; });
  await flushing;
}

/** Take `n` numbers of a workspace's (or the platform's, scope 0) sequence of a trail: the first of them. */
async function takeSeq(tx: Queryable, scope: number, trail: "data" | "platform", n: number): Promise<number> {
  const [r] = await tx.query<{ last: number }>(
    `INSERT INTO audit_sequences (scope_id, trail, last_seq) VALUES ($1, $2, $3)
     ON CONFLICT (scope_id, trail) DO UPDATE SET last_seq = audit_sequences.last_seq + excluded.last_seq RETURNING last_seq AS last`, [scope, trail, n]);
  return Number(r!.last) - n + 1;
}
const groupBy = <T>(xs: T[], k: (x: T) => number) => {
  const m = new Map<number, T[]>();
  for (const x of xs) { const key = k(x); const l = m.get(key); if (l) l.push(x); else m.set(key, [x]); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]); // a fixed order: two flushes never wait on each other's locks
};
const CHUNK = 500;

async function writeBatch(data: DataRow[], plat: PlatformRow[]) {
  const db = await getDb();
  // Staff appear in a workspace's data trail as the pseudonym its activity log gives them.
  for (const r of data) if (r.actor.kind === "staff" && r.actor.id && !r.actor.id.startsWith("staff:")) r.actor = { ...r.actor, id: await pseudonym(r.actor.id, r.org_id) };
  await db.transaction(async (tx) => {
    for (const [orgId, rows] of groupBy(data, (r) => r.org_id)) {
      let seq = await takeSeq(tx, orgId, "data", rows.length);
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK), params: unknown[] = [], values: string[] = [];
        for (const r of part) {
          const b = params.length;
          params.push(orgId, seq++, r.actor.kind, r.actor.id?.slice(0, 200) ?? null, r.actor.key_id ?? null, r.action, r.target, r.pack, r.area?.slice(0, 200) ?? null,
            r.record_key?.slice(0, 500) ?? null, r.rows, r.channel);
          values.push(`(${Array.from({ length: 12 }, (_, j) => `$${b + j + 1}`).join(", ")})`);
        }
        await tx.query(`INSERT INTO audit_data_events (org_id, seq, actor_kind, actor_id, key_id, action, target, pack, area, record_key, rows, channel) VALUES ${values.join(", ")}`, params);
      }
    }
    // The platform trail's workspace: the entry's own, else the account a staff action named (by its slug).
    const slugs = [...new Set(plat.filter((r) => r.org_id == null && r.org_slug).map((r) => r.org_slug!))];
    const bySlug = new Map<string, number>(slugs.length
      ? (await tx.query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE slug = ANY ($1::text[])", [slugs])).map((o) => [o.slug, o.id]) : []);
    const scoped = plat.map((r) => ({ ...r, org_id: r.org_id ?? (r.org_slug ? bySlug.get(r.org_slug) ?? null : null) }));
    for (const [scope, rows] of groupBy(scoped, (r) => r.org_id ?? 0)) {
      let seq = await takeSeq(tx, scope, "platform", rows.length);
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK), params: unknown[] = [], values: string[] = [];
        for (const r of part) {
          const b = params.length;
          params.push(scope, seq++, r.org_id, r.kind, r.channel, r.method.slice(0, 16), r.path, r.actor.key_id ?? null, r.actor.kind, r.actor.id?.slice(0, 200) ?? null,
            r.actor.scopes ?? [], r.status, r.latency_ms, r.ip);
          values.push(`(${Array.from({ length: 14 }, (_, j) => `$${b + j + 1}`).join(", ")})`);
        }
        await tx.query(
          `INSERT INTO audit_platform_events (scope_id, seq, org_id, kind, channel, method, path, key_id, actor_kind, actor_id, scopes, status, latency_ms, ip) VALUES ${values.join(", ")}`,
          params.map((p, j) => (j % 14 === 10 ? `{${(p as string[]).map((s) => `"${s.replace(/["\\]/g, "")}"`).join(",")}}` : p)));
      }
    }
  });
}

// ---------------------------------------------------------------- retention

/**
 * Remove entries older than the app's retention (profile audit.retention_days, default 400; the platform trail's
 * audit.platform_retention_days, default the same), 5,000 rows a trail per call. The only delete the tables allow
 * besides a removed workspace's cascade: it runs with app.audit_prune on, in its own transaction.
 */
export async function pruneAudit(): Promise<{ data: number; platform: number }> {
  const s = auditSettings();
  if (!s.data && !s.platform) return { data: 0, platform: 0 };
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT set_config('app.audit_prune', 'on', true)");
    const del = async (sql: string, days: number) => Number((await tx.query<{ n: number }>(sql, [days]))[0]?.n ?? 0);
    return {
      data: s.data ? await del(`WITH d AS (DELETE FROM audit_data_events WHERE (org_id, seq) IN (SELECT org_id, seq FROM audit_data_events WHERE at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1)
        SELECT count(*)::int AS n FROM d`, s.retention_days) : 0,
      platform: s.platform ? await del(`/* tenant: every workspace's old entries, by age */ WITH d AS (DELETE FROM audit_platform_events WHERE (scope_id, seq) IN (SELECT scope_id, seq FROM audit_platform_events WHERE at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1)
        SELECT count(*)::int AS n FROM d`, s.platform_retention_days) : 0,
    };
  }));
}
let pruneTimer: NodeJS.Timeout | null = null;
/** Once a process writes an entry: prune now and then hourly (a server); on Vercel the cron also calls pruneAudit. */
function startPruning() {
  if (pruneTimer || process.env.VERCEL) return;
  const go = () => void pruneAudit().catch((e) => console.error(`audit trail prune: ${(e as Error).message}`));
  pruneTimer = setInterval(go, 3_600_000);
  pruneTimer.unref?.();
  setTimeout(go, 60_000).unref?.();
}

// ---------------------------------------------------------------- reading the trails

const MAX_PAGE = 500;
export interface TrailQuery { limit?: unknown; before?: unknown; from?: unknown; to?: unknown; action?: unknown; actor?: unknown; area?: unknown; kind?: unknown; org?: unknown }
const limitOf = (q: TrailQuery) => Math.min(Math.max(Math.trunc(Number(q.limit ?? 100)) || 100, 1), MAX_PAGE);
const dayOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const textOf = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const intOf = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isSafeInteger(n) && n > 0 ? n : null; };

export interface DataTrailRow { seq: number; at: string; actor_kind: ActorKind; actor_id: string | null; key_id: number | null; action: DataAction; target: DataTarget; pack: string | null; area: string | null; record_key: string | null; rows: number | null; channel: Channel }
/** One workspace's data trail, newest first (under row-level security: only its own rows can come back). `before`: a seq. */
export async function readDataTrail(orgId: number, q: TrailQuery = {}): Promise<{ entries: DataTrailRow[]; next: number | null }> {
  const limit = limitOf(q), params: unknown[] = [orgId], where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (intOf(q.before)) add("seq < ?", intOf(q.before));
  if (dayOf(q.from)) add("at >= ?::date", dayOf(q.from));
  if (dayOf(q.to)) add("at < ?::date + 1", dayOf(q.to));
  if (textOf(q.action)) add("action = ?", textOf(q.action));
  if (textOf(q.actor)) add("actor_id = ?", textOf(q.actor));
  if (textOf(q.area)) add("area = ?", textOf(q.area));
  params.push(limit + 1);
  const rows = await withTenant(orgId, async () => (await getDb()).query<DataTrailRow & { at: Date }>(
    `SELECT seq, at, actor_kind, actor_id, key_id, action, target, pack, area, record_key, rows, channel FROM audit_data_events
      WHERE org_id = $1${where.map((w) => ` AND ${w}`).join("")} ORDER BY seq DESC LIMIT $${params.length}`, params));
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map((r) => ({ ...r, seq: Number(r.seq), at: new Date(r.at).toISOString() }));
  return { entries, next: more ? entries[entries.length - 1]!.seq : null };
}

export interface PlatformTrailRow { seq: number; at: string; org_id: number | null; workspace: string | null; kind: string; channel: Channel; method: string; path: string; key_id: number | null; key_prefix: string | null;
  actor_kind: ActorKind; actor_id: string | null; scopes: string[]; status: number | null; latency_ms: number | null; ip?: string | null }
/**
 * The platform trail, newest first: one workspace's slice (`orgId`, under row-level security; staff named by the
 * pseudonym its activity log uses), or every workspace's for the operator (null: also the entries of no workspace).
 */
export async function readPlatformTrail(orgId: number | null, q: TrailQuery = {}): Promise<{ entries: PlatformTrailRow[]; next: string | null }> {
  const limit = limitOf(q), params: unknown[] = [], where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (orgId !== null) add("e.org_id = ?", orgId);
  else if (intOf(q.org)) add("e.org_id = ?", intOf(q.org));
  else if (textOf(q.org)) add("e.org_id = (SELECT id FROM organizations WHERE slug = ?)", textOf(q.org));
  const before = typeof q.before === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|\d+\|\d+$/.test(q.before) ? q.before.split("|") : null;
  if (before) { params.push(before[0], Number(before[1]), Number(before[2])); where.push(`(e.at, e.scope_id, e.seq) < ($${params.length - 2}::timestamptz, $${params.length - 1}, $${params.length})`); }
  if (dayOf(q.from)) add("e.at >= ?::date", dayOf(q.from));
  if (dayOf(q.to)) add("e.at < ?::date + 1", dayOf(q.to));
  if (textOf(q.kind)) add("e.kind = ?", textOf(q.kind));
  if (textOf(q.actor)) add("e.actor_id = ?", textOf(q.actor));
  params.push(limit + 1);
  const sql = `SELECT e.scope_id, e.seq, e.at, e.org_id, o.slug AS workspace, e.kind, e.channel, e.method, e.path, e.key_id, k.key_prefix, e.actor_kind, e.actor_id, e.scopes,
                      e.status, e.latency_ms${orgId === null ? ", e.ip" : ""}
                 FROM audit_platform_events e LEFT JOIN organizations o ON o.id = e.org_id LEFT JOIN api_keys k ON k.id = e.key_id AND k.org_id = e.org_id
                WHERE ${where.length ? where.join(" AND ") : "true"} ORDER BY e.at DESC, e.scope_id DESC, e.seq DESC LIMIT $${params.length}`;
  const rows = orgId === null
    ? await asPlatform(async () => (await getDb()).query<any>(`/* tenant: the operator's fleet-wide trail (platform staff only) */ ${sql}`, params))
    : await withTenant(orgId, async () => (await getDb()).query<any>(sql, params));
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries: PlatformTrailRow[] = [];
  for (const r of page) {
    const staffInWorkspace = orgId !== null && r.actor_kind === "staff" && r.actor_id && !String(r.actor_id).startsWith("staff:");
    entries.push({ seq: Number(r.seq), at: new Date(r.at).toISOString(), org_id: r.org_id, workspace: r.workspace ?? null, kind: r.kind, channel: r.channel, method: r.method, path: r.path,
      key_id: r.key_id, key_prefix: r.key_prefix ?? null, actor_kind: r.actor_kind, actor_id: staffInWorkspace ? await pseudonym(r.actor_id, orgId!) : r.actor_id,
      scopes: Array.isArray(r.scopes) ? r.scopes : typeof r.scopes === "string" ? r.scopes.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((s: string) => s.replace(/^"|"$/g, "")) : [],
      status: r.status, latency_ms: r.latency_ms, ...(orgId === null ? { ip: r.ip ?? null } : {}) });
  }
  const last = page[page.length - 1];
  return { entries, next: more && last ? `${new Date(last.at).toISOString()}|${last.scope_id}|${last.seq}` : null };
}

// ---------------------------------------------------------------- CSV

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;
export const CSV_MAX_ROWS = 50_000;
const DATA_COLS: (keyof DataTrailRow)[] = ["seq", "at", "actor_kind", "actor_id", "key_id", "action", "target", "pack", "area", "record_key", "rows", "channel"];
const PLATFORM_COLS: (keyof PlatformTrailRow)[] = ["seq", "at", "workspace", "kind", "channel", "method", "path", "key_prefix", "actor_kind", "actor_id", "scopes", "status", "latency_ms"];
/** A trail as CSV, newest first, paged through the readers above (at most CSV_MAX_ROWS rows). */
export async function trailCsv(which: "data" | "platform", orgId: number | null, q: TrailQuery = {}): Promise<{ csv: string; rows: number; more: boolean }> {
  const cols = which === "data" ? DATA_COLS : [...PLATFORM_COLS, ...(orgId === null ? ["ip" as const] : [])];
  let csv = csvLine(cols), rows = 0, before: unknown = q.before;
  for (;;) {
    const page = which === "data" ? await readDataTrail(orgId!, { ...q, before, limit: MAX_PAGE }) : await readPlatformTrail(orgId, { ...q, before, limit: MAX_PAGE });
    for (const e of page.entries as unknown as Record<string, unknown>[]) { csv += csvLine(cols.map((c) => e[c])); rows++; }
    if (!page.next || rows >= CSV_MAX_ROWS) return { csv, rows, more: !!page.next };
    before = page.next;
  }
}

// ---------------------------------------------------------------- HTTP

/** A workspace's owners: the people who may read its trails (an account key without a person acts as the account). */
const isOwner = (s: { accountRole?: string | null; role?: string } | undefined) => s?.accountRole === "owner";

/**
 * /api/audit (a signed-in owner of the workspace): its data trail and its slice of the platform trail, as JSON pages and
 * as CSV. Nothing is mounted with both trails off.
 */
export function auditAppRouter(customerSession: RequestHandler): Router {
  const r = express.Router();
  if (!anyTrailOn()) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.use((_req, res, next) => (isOwner(res.locals.session) ? next() : void res.status(403).json({ error: "Only the workspace's owners read its access log.", code: "owners_only" })));
  const org = (res: Response) => (res.locals.session as { org: number }).org;
  r.get("/", (_req, res) => void res.json({ data: dataTrailOn(), platform: platformTrailOn(), retention_days: auditSettings().retention_days }));
  const csvOut = (res: Response, name: string, out: { csv: string; rows: number; more: boolean }) =>
    void res.type("text/csv; charset=utf-8").set({ "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`, "X-Rows": String(out.rows), "X-More": String(out.more) }).send(`\ufeff${out.csv}`);
  if (dataTrailOn()) {
    r.get("/data", wrap(async (req, res) => void res.json(await readDataTrail(org(res), req.query as TrailQuery))));
    r.get("/data.csv", wrap(async (req, res) => csvOut(res, "data-access-log", await trailCsv("data", org(res), req.query as TrailQuery))));
  }
  if (platformTrailOn()) {
    r.get("/platform", wrap(async (req, res) => void res.json(await readPlatformTrail(org(res), req.query as TrailQuery))));
    r.get("/platform.csv", wrap(async (req, res) => csvOut(res, "request-log", await trailCsv("platform", org(res), req.query as TrailQuery))));
  }
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
/** /api/admin/audit, inside the admin router (any platform admin reads): the platform trail fleet-wide, and a workspace's data trail. */
export function auditAdminRouter(): Router {
  const r = express.Router();
  if (!anyTrailOn()) return r;
  if (platformTrailOn()) {
    r.get("/platform", wrap(async (req, res) => void res.json(await readPlatformTrail(null, req.query as TrailQuery))));
    r.get("/platform.csv", wrap(async (req, res) => {
      const out = await trailCsv("platform", null, req.query as TrailQuery);
      res.type("text/csv; charset=utf-8").set({ "Content-Disposition": `attachment; filename="platform-trail-${new Date().toISOString().slice(0, 10)}.csv"` }).send(`\ufeff${out.csv}`);
    }));
  }
  if (dataTrailOn()) r.get("/data/:org", wrap(async (req, res) => {
    const id = await orgIdOf(String(req.params.org));
    if (id === null) return void res.status(404).json({ error: "No such workspace" });
    res.json(await readDataTrail(id, req.query as TrailQuery));
  }));
  if (dataTrailOn()) r.get("/data/:org/csv", wrap(async (req, res) => {
    const id = await orgIdOf(String(req.params.org));
    if (id === null) return void res.status(404).json({ error: "No such workspace" });
    const out = await trailCsv("data", id, req.query as TrailQuery);
    res.type("text/csv; charset=utf-8").set({ "Content-Disposition": `attachment; filename="data-trail-${id}-${new Date().toISOString().slice(0, 10)}.csv"` }).send(`\ufeff${out.csv}`);
  }));
  return r;
}
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);
async function orgIdOf(ref: string): Promise<number | null> {
  const [o] = await asPlatform(async () => (await getDb()).query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1 OR id::text = $1", [ref]));
  return o?.id ?? null;
}

// ---------------------------------------------------------------- MCP

/** The customer MCP's audit tool (src/shell-tools.ts AUDIT_TOOL_NAMES): listed only when a trail is on, to the workspace's owners. */
export function registerAuditTools(server: McpServer, org: Org) {
  if (!anyTrailOn()) return;
  // An owner's own sign-in or member key; an account key (no person, no role) acts as the account, as on every tool.
  if (!(org.role === "owner" || (!org.userId && !org.role && !org.staff))) return;
  const which = [...(dataTrailOn() ? ["data"] : []), ...(platformTrailOn() ? ["platform"] : [])] as ["data" | "platform", ...("data" | "platform")[]];
  server.registerTool("read_audit_trail", {
    title: "Read the access log",
    description: `This workspace's access log, newest first: ${dataTrailOn() ? "the data trail (who listed, read, revealed, exported, created, changed, moved or deleted which records, files and run results, through which door; never the values)" : ""}${dataTrailOn() && platformTrailOn() ? ", and " : ""}${platformTrailOn() ? "the request log (every API and MCP request and sign-in: key prefix, actor, scopes, result and latency; staff actions on the account)" : ""}. Workspace owners only. Page with before (the previous page's next).`,
    inputSchema: {
      trail: z.enum(which).optional().describe(`Which trail (default ${which[0]})`),
      limit: z.number().int().min(1).max(MAX_PAGE).optional().describe("Entries per page (default 100)"),
      before: z.union([z.number(), z.string()]).optional().describe("The previous page's next"),
      from: z.string().optional().describe("First day, YYYY-MM-DD"), to: z.string().optional().describe("Last day, YYYY-MM-DD"),
      action: z.string().optional().describe("Data trail: only this action (list, read, reveal, export, create, update, move, delete)"),
      area: z.string().optional().describe("Data trail: only this record area, file store or run kind"),
      actor: z.string().optional().describe("Only this actor id"),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const trail = a.trail ?? which[0];
    const page = trail === "data" ? await readDataTrail(org.orgId, a) : await readPlatformTrail(org.orgId, a);
    const out = { trail, ...page };
    return { content: [{ type: "text", text: `${page.entries.length} entr${page.entries.length === 1 ? "y" : "ies"} of the ${trail === "data" ? "data trail" : "request log"}${page.next ? " (more: pass before)" : ""}.\n\n${JSON.stringify(out)}` }], structuredContent: out };
  });
}

/** The admin MCP's audit tools (src/admin-mcp.ts adminTools), when a trail is on: reads, for any platform admin. */
export function auditAdminTools(): Record<string, { title: string; description: string; needs: "read"; input: z.ZodRawShape; run: (a: Record<string, any>) => Promise<unknown>; summary: (d: any) => string }> {
  const out: ReturnType<typeof auditAdminTools> = {};
  const page = { limit: z.number().int().min(1).max(MAX_PAGE).optional(), before: z.union([z.number(), z.string()]).optional(), from: z.string().optional(), to: z.string().optional(), actor: z.string().optional() };
  if (dataTrailOn()) out.read_audit_trail = {
    title: "A workspace's data trail", needs: "read",
    description: "One workspace's data trail (by slug), newest first: who listed, read, revealed, exported or changed which records, files and run results, through which door; never the values.",
    input: { slug: z.string().describe("Account slug (list_accounts)"), action: z.string().optional(), area: z.string().optional(), ...page },
    run: async (a) => { const id = await orgIdOf(String(a.slug)); if (id === null) throw Object.assign(new Error(`No account ${a.slug}`), { status: 404 }); return readDataTrail(id, a); },
    summary: (d) => `${d.entries?.length ?? 0} data trail entr(ies).`,
  };
  if (platformTrailOn()) out.read_platform_trail = {
    title: "The platform trail", needs: "read",
    description: "Every API and MCP request and sign-in across the fleet (key prefix, actor, scopes, result, latency) and every staff action on an account, newest first. Narrow with org (a slug), kind (request, sign_in, staff) and actor.",
    input: { org: z.string().optional(), kind: z.enum(["request", "sign_in", "staff"]).optional(), ...page },
    run: async (a) => readPlatformTrail(null, a),
    summary: (d) => `${d.entries?.length ?? 0} platform trail entr(ies).`,
  };
  return out;
}

/** What DATA-MAP.md says of the trails that are on (src/data-map.ts); nothing when both are off. */
export function auditDataMapRows(s: Pick<AuditSettings, "data" | "platform" | "retention_days" | "platform_retention_days">): { item: string; detail: string }[] {
  const rows: { item: string; detail: string }[] = [];
  if (s.data) rows.push({ item: "Data trail", detail: `in the database, per workspace under row-level security: who listed, read, revealed, exported or changed which record, file or run's results, when and through which door; never a field's value. Read by the workspace's owners (console, CSV, MCP); kept ${s.retention_days} days` });
  if (s.platform) rows.push({ item: "Platform trail", detail: `in the database: every API and MCP request and sign-in (the key's id and prefix, never the key; the actor, scopes, result and latency) and staff actions on an account. Read fleet-wide by the platform's staff and per workspace by its owners; kept ${s.platform_retention_days} days` });
  return rows;
}
