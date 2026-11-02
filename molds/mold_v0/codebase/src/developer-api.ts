/**
 * The developer API of an embedded app (mold_v0-193): /v1 and /openapi.json. Mounted only in a build with a developer
 * surface (src/developer-surface.ts); in every other build this router is empty and nothing answers.
 *
 *   authentication  `Authorization: Bearer sk_...` (a workspace key, src/developer-keys.ts) from a server, or
 *                   `Bearer cs_...` (a client session, src/developer-sessions.ts) from a browser or phone. A key sent
 *                   with an Origin header (a browser) is refused: a key never belongs in a client.
 *   CORS            a browser's Origin must be allowed for the session's workspace (the app's allowed_origins and the
 *                   workspace's own); preflights answer for an origin some workspace allows
 *   scopes          each operation needs one (read, write, run, sessions, webhooks; read/write/run narrowed to an area
 *                   or kind count for that area or kind); X-Scope narrows one request to fewer
 *   actor           X-Actor (keys only): the backend's signed-in user the call is for; a client session's subject.
 *                   Recorded on the platform audit hook (src/developer-audit.ts) and on the events the call causes
 *   versions        API-Version (dated); default the key's pinned version; every answer names the version it served
 *   idempotency     Idempotency-Key on a write: the same key and request within 24 hours answers the first answer
 *                   again (Idempotent-Replayed: true); the same key with another request is refused (422)
 *   errors          application/problem+json {type, title, status, detail, code, request_id}
 *   pages           {data, next}: `after` = the previous `next` (records: the record store's cursor; runs and
 *                   deliveries: a keyset cursor)
 *   rate limits     per key (or client session) and per workspace a minute: the MCP front door's numbers
 *                   (src/rate-limits.ts mcp.per_key_per_minute, per_workspace_per_minute), 429 with Retry-After
 * Every record operation goes through the generic data API (src/data-api.ts): the record store's own rules.
 */
import { createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { auditPlatform } from "./developer-audit.js";
import { API_VERSIONS, scopeAllows, type BaseScope } from "./developer-config.js";
import { resolveDeveloperKey, type ResolvedKey } from "./developer-keys.js";
import { openApiDocument } from "./developer-openapi.js";
import { addOrigin, covers, listOrigins, mintClientSession, originAllowed, removeOrigin, resolveClientSession, revokeClientSession, type ResolvedSession } from "./developer-sessions.js";
import { actorLabel, ApiProblem, asApiActor, developerSurface, type ApiActor } from "./developer-surface.js";
import * as hooks from "./developer-webhooks.js";
import { createSource, deleteSource, listSources, receive } from "./developer-inbound.js";
import { dataApi, type DataCaller } from "./data-api.js";
import { getDb } from "./db.js";
import { publicUrl } from "./console-url.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { PackError } from "./pack-api.js";
import { hit, limitsFor, planOf } from "./rate-limits.js";
import { areaOrThrow } from "./record-areas.js";
import { cancelRun, getRun, jobKinds, runResults, startRun } from "./runs.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

const STATUS_CODE: Record<number, string> = { 400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict",
  413: "too_large", 415: "unsupported_media_type", 422: "unprocessable", 429: "rate_limited", 503: "unavailable" };
const TITLE: Record<number, string> = { 400: "Bad request", 401: "Unauthenticated", 403: "Forbidden", 404: "Not found", 405: "Method not allowed", 409: "Conflict",
  413: "Too large", 415: "Unsupported media type", 422: "Unprocessable", 429: "Too many requests", 500: "Internal error", 503: "Unavailable" };
const ACTOR = /^[A-Za-z0-9._:@+-]{1,128}$/;
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXPOSED = "API-Version, Request-Id, Idempotent-Replayed, Retry-After, RateLimit-Limit";
const ALLOWED_HEADERS = "Authorization, Content-Type, Idempotency-Key, API-Version, X-Scope";

/** A problem as its JSON body. */
export function problemBody(status: number, code: string, detail: string, requestId: string | null, extra: Record<string, unknown> = {}) {
  return { type: `/problems/${code}`, title: TITLE[status] ?? (status >= 500 ? "Internal error" : "Error"), status, detail, code, ...(requestId ? { request_id: requestId } : {}), ...extra };
}
function sendProblem(res: Response, e: unknown) {
  const rid = (res.locals.requestId as string | undefined) ?? null;
  let status = 500, code = "internal", detail = "Internal error", extra: Record<string, unknown> = {};
  if (e instanceof ApiProblem) ({ status, code, message: detail, extra } = e);
  else if (e instanceof PackError) { status = e.status; code = STATUS_CODE[e.status] ?? "error"; detail = e.message; }
  else console.error(e);
  if (status === 429 && typeof extra.retry_after === "number") res.set("Retry-After", String(extra.retry_after));
  res.status(status).type("application/problem+json").send(JSON.stringify(problemBody(status, code, detail, rid, extra)));
  return { status, body: null };
}

/** Who is calling, after authentication. */
interface Caller { orgId: number; key: ResolvedKey | null; session: ResolvedSession | null; scopes: string[]; actor: ApiActor; version: string }
const callerOf = (res: Response) => res.locals.caller as Caller;
/** Refuse unless the caller holds `base` (for `target`, when the scope names an area or kind). */
function need(res: Response, base: BaseScope, target?: string | null) {
  const c = callerOf(res);
  if (!scopeAllows(c.scopes, base, target)) throw new ApiProblem(403, "insufficient_scope", `this needs the ${base}${target ? ` (or ${base}:${target})` : ""} scope`, { required_scope: target ? `${base}:${target}` : base });
}
const keysOnly = (res: Response) => { const c = callerOf(res); if (!c.key) throw new ApiProblem(403, "forbidden", "a client session cannot do this: call it from your server with a key"); return c.key; };
const dataCaller = (res: Response): DataCaller => { const c = callerOf(res); return { orgId: c.orgId, role: null, userId: c.actor.user ?? c.actor.credential }; };

type Answer = { status: number; body?: unknown };
/** A handler's answer, as JSON; errors as problems; writes through the idempotency keys. */
const h = (fn: (req: Request, res: Response) => Promise<Answer>) => async (req: Request, res: Response) => {
  try {
    const c = callerOf(res);
    const run = () => withTenant(c.orgId, () => asApiActor(c.actor, () => fn(req, res)));
    const a = await idempotent(req, res, c, run);
    if (a.status === 204) return void res.status(204).end();
    res.status(a.status).json(a.body);
  } catch (e) { sendProblem(res, e); }
};

/** Idempotency-Key on a write (24 hours, per credential): replay the first answer for the same request. */
async function idempotent(req: Request, res: Response, c: Caller, fn: () => Promise<Answer>): Promise<Answer> {
  const raw = req.get("idempotency-key");
  if (raw === undefined || !WRITES.has(req.method)) return fn();
  if (!/^[\x21-\x7e]{1,255}$/.test(raw)) throw new ApiProblem(400, "invalid_idempotency_key", "Idempotency-Key: 1 to 255 visible ASCII characters");
  const scope = c.key ? `key:${c.key.id}` : `session:${c.session!.id}`;
  const hash = createHash("sha256").update(`${req.method} ${req.originalUrl}\n${(res.locals.rawBody as string) ?? ""}`).digest("hex");
  const db = await getDb();
  const [row] = await asPlatform(() => db.query<{ request_hash: string; state: string; status_code: number | null; response: unknown; replay: boolean; stale: boolean }>(
    `INSERT INTO idempotency_keys (org_id, scope, idem_key, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, scope, idem_key) DO UPDATE SET org_id = idempotency_keys.org_id
     RETURNING request_hash, state, status_code, response, (xmax <> 0) AS replay, (created_at < now() - interval '60 seconds') AS stale`, [c.orgId, scope, raw, hash]));
  if (row!.replay) {
    if (row!.request_hash !== hash) throw new ApiProblem(422, "idempotency_key_reused", "this Idempotency-Key was used with another request: use a new key for a new request");
    if (row!.state !== "done" && !row!.stale) throw new ApiProblem(409, "idempotency_in_progress", "a request with this Idempotency-Key is still being answered: retry shortly");
    if (row!.state === "done") {
      res.set("Idempotent-Replayed", "true");
      const status = row!.status_code ?? 200;
      if (status >= 400) throw Object.assign(new ApiProblem(status, String((row!.response as { code?: string })?.code ?? STATUS_CODE[status] ?? "error"), String((row!.response as { detail?: string })?.detail ?? "")));
      return { status, body: row!.response };
    }
    await asPlatform(() => db.query("UPDATE idempotency_keys SET created_at = now() WHERE org_id = $1 AND scope = $2 AND idem_key = $3", [c.orgId, scope, raw]));
  }
  const store = (status: number, body: unknown) => asPlatform(() => db.query(
    "UPDATE idempotency_keys SET state = 'done', status_code = $4, response = $5 WHERE org_id = $1 AND scope = $2 AND idem_key = $3", [c.orgId, scope, raw, status, JSON.stringify(body ?? null)]));
  const forget = () => asPlatform(() => db.query("DELETE FROM idempotency_keys WHERE org_id = $1 AND scope = $2 AND idem_key = $3", [c.orgId, scope, raw]));
  try {
    const a = await fn();
    await (a.status >= 500 ? forget() : store(a.status, a.body));
    return a;
  } catch (e) {
    const status = e instanceof ApiProblem || e instanceof PackError ? e.status : 500;
    // A refusal is the answer (replayed); a failure of ours may be retried with the same key.
    if (status >= 500 || status === 429) await forget().catch(() => {});
    else await store(status, { code: e instanceof ApiProblem ? e.code : STATUS_CODE[status] ?? "error", detail: (e as Error).message }).catch(() => {});
    throw e;
  }
}

/** Parse the raw body as JSON (an empty body is {}). */
const jsonBody = (res: Response): Record<string, unknown> => {
  const raw = res.locals.rawBody as string;
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new ApiProblem(400, "invalid_json", "the request body must be a JSON object"); }
};
const q1 = (req: Request, k: string): string | undefined => {
  const v = (req.query as Record<string, unknown>)[k];
  if (Array.isArray(v)) throw new ApiProblem(400, "invalid_request", `${k} is given once`);
  return v === undefined ? undefined : String(v);
};

/** A record area this API serves (a withheld operation answers as one that does not exist). */
const areaFor = (name: string, op: Parameters<typeof areaOpWithheld>[1]) => {
  let a;
  try { a = areaOrThrow(name); } catch { throw new ApiProblem(404, "not_found", `no record area ${name.slice(0, 64)}`); }
  if (areaOpWithheld(a.name, op)) throw new ApiProblem(404, "not_found", "Not found");
  return a;
};
const kindFor = (name: unknown) => {
  const k = jobKinds().find((x) => x.name === name);
  if (!k) throw new ApiProblem(400, "invalid_request", `kind: one of ${[...new Set(jobKinds().map((x) => x.name))].join(", ")}`);
  return k;
};

/** A run as the API shows it. */
interface RunCols { id: string; pack: string; kind: string; status: string; attempt: number; max_attempts: number; scope: unknown; targets: unknown; cost_usd: string; budget_usd: string;
  error_kind: string | null; error: string | null; cancel_requested_at: Date | null; created_at: Date; started_at: Date | null; ended_at: Date | null }
const isoOf = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const runOf = (r: RunCols) => ({ id: r.id, pack: r.pack, kind: r.kind, status: r.status, attempt: r.attempt, max_attempts: r.max_attempts, scope: r.scope ?? {}, targets: r.targets ?? {},
  cost_usd: Number(r.cost_usd), budget_usd: Number(r.budget_usd), error_kind: r.error_kind, error: r.error, cancel_requested: !!r.cancel_requested_at,
  created_at: isoOf(r.created_at), started_at: isoOf(r.started_at), ended_at: isoOf(r.ended_at) });

/** /openapi.json and /v1: empty in a build without a developer surface. */
export function developerApiRouter(): Router {
  const r = express.Router();
  if (!developerSurface()) return r;

  r.get("/openapi.json", (req, res) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" });
    const base = (process.env.PUBLIC_URL ? publicUrl() : `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.json(openApiDocument(base));
  });

  const v1 = express.Router();
  v1.use((req, res, next) => {
    res.locals.requestId = `req_${randomBytes(9).toString("base64url")}`;
    res.set({ "Request-Id": res.locals.requestId, "Cache-Control": "no-store" });
    next();
  });
  // CORS: a preflight answers for an origin some workspace allows (the call itself is checked for its own workspace).
  v1.use(async (req, res, next) => {
    const origin = req.get("origin");
    if (!origin) return next();
    res.set("Vary", "Origin");
    if (req.method !== "OPTIONS") return next();
    if (!(await originAllowed(origin, null).catch(() => false))) return void sendProblem(res, new ApiProblem(403, "origin_not_allowed", "this origin may not call the API"));
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE", "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Expose-Headers": EXPOSED, "Access-Control-Max-Age": "600" });
    res.status(204).end();
  });
  // The raw body (a signature covers it: webhooks in; the idempotency hash too), at most 1 MB.
  v1.use(express.raw({ type: () => true, limit: "1mb" }), (req, res, next) => {
    res.locals.rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    next();
  });
  v1.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
    (err ? void sendProblem(res, new ApiProblem(err.type === "entity.too.large" ? 413 : 400, err.type === "entity.too.large" ? "too_large" : "invalid_request", err.type === "entity.too.large" ? "the request is larger than 1 MB" : "the request body could not be read")) : next()));

  // ---------- webhooks in: signed by the sender, no key ----------
  v1.post("/inbound/:id", async (req, res) => {
    try { res.json(await receive(String(req.params.id), req.headers, res.locals.rawBody as string)); }
    catch (e) { sendProblem(res, e); }
  });

  // ---------- authentication, scopes, actor, version, origin, rate limits ----------
  v1.use(async (req, res, next) => {
    try {
      const m = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
      if (!m) throw new ApiProblem(401, "unauthenticated", "send Authorization: Bearer <key or client session>");
      const token = m[1]!;
      const origin = req.get("origin") ?? null;
      let key: ResolvedKey | null = null, session: ResolvedSession | null = null;
      if (token.startsWith("sk_")) key = await resolveDeveloperKey(token);
      else if (token.startsWith("cs_")) session = await resolveClientSession(token);
      if (!key && !session) throw new ApiProblem(401, "unauthenticated", "this key or client session is unknown, revoked or expired");
      const orgId = (key ?? session)!.orgId;
      if (key && origin) throw new ApiProblem(403, "secret_key_in_browser", "a key is for your server, never a browser: mint a client session (POST /v1/client_sessions) and use its token there");
      if (origin) {
        if (!(await originAllowed(origin, orgId))) throw new ApiProblem(403, "origin_not_allowed", "this origin is not allowed for the workspace (/v1/allowed_origins)");
        res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": EXPOSED });
      }
      const held = key ? key.scopes : session!.scopes;
      const narrow = req.get("x-scope");
      let scopes = held;
      if (narrow !== undefined) {
        const asked = narrow.split(/[\s,]+/).filter(Boolean);
        const bad = asked.find((s) => !covers(held, s));
        if (!asked.length || bad) throw new ApiProblem(403, "insufficient_scope", bad ? `X-Scope: ${bad.slice(0, 80)} is not held by this credential` : "X-Scope: name at least one scope");
        scopes = asked;
      }
      const assert = req.get("x-actor");
      if (assert !== undefined) {
        if (!key) throw new ApiProblem(403, "forbidden", "X-Actor is for a key: a client session acts as its subject");
        if (!ACTOR.test(assert)) throw new ApiProblem(400, "invalid_request", "X-Actor: your user's id (1-128 letters, digits and . _ : @ + -)");
      }
      const version = req.get("api-version") ?? (key ? key.apiVersion : API_VERSIONS[API_VERSIONS.length - 1]!);
      if (!(API_VERSIONS as readonly string[]).includes(version)) throw new ApiProblem(400, "unsupported_api_version", `API-Version: one of ${API_VERSIONS.join(", ")}`);
      res.set("API-Version", version);
      const actor: ApiActor = { orgId, credential: key ? `key:${key.prefix}` : `session:${session!.id}`, user: key ? assert ?? null : session!.subject };
      res.locals.caller = { orgId, key, session, scopes, actor, version } satisfies Caller;
      const lim = limitsFor(await planOf(orgId)).mcp;
      const refused = await hit([
        { bucket: key ? `api-key:${key.id}` : `api-session:${session!.id}`, limit: lim.per_key_per_minute, what: key ? "key" : "client session" },
        { bucket: `api-workspace:${orgId}`, limit: lim.per_workspace_per_minute, what: "workspace" }]);
      res.set("RateLimit-Limit", String(lim.per_key_per_minute));
      if (refused) throw new ApiProblem(429, "rate_limited", `too many requests: this ${refused.what} may make ${refused.limit} a minute`, { retry_after: refused.retry_after });
      res.on("finish", () => auditPlatform({ orgId, action: "api.request", actor: actorLabel(actor), target: `${req.method} ${req.originalUrl.split("?")[0]}`,
        scopes, status: res.statusCode, request_id: res.locals.requestId as string }));
      next();
    } catch (e) { sendProblem(res, e); }
  });

  // ---------- records (the generic data API) ----------
  v1.get("/areas", h(async (_req, res) => { need(res, "read"); return { status: 200, body: { data: dataApi.areas().areas } }; }));
  v1.get("/records/:area", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "list");
    need(res, "read", a.name);
    const page = await dataApi.list(dataCaller(res), a.name, { limit: q1(req, "limit") as never, after: q1(req, "after"), sort: q1(req, "sort"), filter: q1(req, "filter") as never });
    return { status: 200, body: { data: page.records, next: page.next } };
  }));
  v1.get("/records/:area/:key", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "get");
    need(res, "read", a.name);
    const d = await dataApi.get(dataCaller(res), a.name, String(req.params.key));
    if (!d) throw new ApiProblem(404, "not_found", `no ${a.name} record ${String(req.params.key).slice(0, 200)}`);
    const { record, links } = d as { record: unknown; links?: unknown };
    return { status: 200, body: { data: record, links: links ?? [] } };
  }));
  v1.post("/records/:area", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "create");
    need(res, "write", a.name);
    const b = jsonBody(res);
    if (typeof b.key !== "string") throw new ApiProblem(400, "invalid_request", "key: the new record's key");
    return { status: 201, body: { data: (await dataApi.create(dataCaller(res), a.name, b.key, b)).record } };
  }));
  v1.put("/records/:area/:key", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "update");
    need(res, "write", a.name);
    return { status: 200, body: { data: (await dataApi.update(dataCaller(res), a.name, String(req.params.key), jsonBody(res))).record } };
  }));
  v1.post("/records/:area/:key/move", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "move");
    need(res, "write", a.name);
    return { status: 200, body: { data: (await dataApi.move(dataCaller(res), a.name, String(req.params.key), jsonBody(res).to)).record } };
  }));
  v1.delete("/records/:area/:key", h(async (req, res) => {
    const a = areaFor(String(req.params.area), "delete");
    need(res, "write", a.name);
    if (!(await dataApi.delete(dataCaller(res), a.name, String(req.params.key)))) throw new ApiProblem(404, "not_found", `no ${a.name} record ${String(req.params.key).slice(0, 200)}`);
    return { status: 204 };
  }));
  v1.post("/batch", h(async (_req, res) => {
    const ops = jsonBody(res).operations;
    if (!Array.isArray(ops)) throw new ApiProblem(400, "invalid_request", "operations: a list of {op, area, key, ...}");
    for (const o of ops) {
      const { op, area } = (o ?? {}) as { op?: unknown; area?: unknown };
      const a = areaFor(String(area), op === "delete" ? "delete" : op === "move" ? "move" : op === "create" ? "create" : "update");
      need(res, "write", a.name);
    }
    return { status: 200, body: { data: (await dataApi.batch(dataCaller(res), ops)).results } };
  }));

  // ---------- runs ----------
  if (jobKinds().length) {
    v1.get("/runs", h(async (req, res) => {
      need(res, "read");
      const limit = q1(req, "limit") === undefined ? 50 : Number(q1(req, "limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiProblem(400, "invalid_request", "limit: 1 to 200");
      const after = q1(req, "after") === undefined ? null : hooks.decodeCursor(q1(req, "after")!);
      const kind = q1(req, "kind") ?? null, status = q1(req, "status") ?? null;
      const rows = await (await getDb()).query<RunCols>(
        `SELECT id, pack, kind, status, attempt, max_attempts, scope, targets, cost_usd, budget_usd, error_kind, error, cancel_requested_at, created_at, started_at, ended_at
           FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR status = $3)
            AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::text)) ORDER BY created_at DESC, id DESC LIMIT $6`,
        [callerOf(res).orgId, kind, status, after?.at ?? null, after?.id ?? null, limit + 1]);
      const page = rows.slice(0, limit);
      return { status: 200, body: { data: page.map(runOf), next: rows.length > limit ? hooks.encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null } };
    }));
    v1.post("/runs", h(async (_req, res) => {
      const b = jsonBody(res);
      const k = kindFor(b.kind);
      need(res, "run", k.name);
      const c = callerOf(res);
      return { status: 201, body: { data: await startRun(c.orgId, k.pack, k.name, { scope: b.scope, targets: b.targets, approval: b.approval }, actorLabel(c.actor)) } };
    }));
    const runOr404 = async (res: Response, id: string) => {
      const run = await getRun(callerOf(res).orgId, id);
      if (!run) throw new ApiProblem(404, "not_found", "no such run");
      return run;
    };
    v1.get("/runs/:id", h(async (req, res) => { const run = await runOr404(res, String(req.params.id)); need(res, "read"); return { status: 200, body: { data: run } }; }));
    v1.get("/runs/:id/results", h(async (req, res) => {
      need(res, "read");
      await runOr404(res, String(req.params.id));
      return { status: 200, body: { data: await runResults(callerOf(res).orgId, String(req.params.id)) } };
    }));
    v1.post("/runs/:id/cancel", h(async (req, res) => {
      const run = await runOr404(res, String(req.params.id));
      need(res, "run", run.kind);
      return { status: 200, body: { data: await cancelRun(callerOf(res).orgId, run.id, actorLabel(callerOf(res).actor)) } };
    }));
  }

  // ---------- client sessions and allowed origins ----------
  v1.post("/client_sessions", h(async (_req, res) => {
    const key = keysOnly(res);
    need(res, "sessions");
    return { status: 201, body: { data: await mintClientSession(key.orgId, key.id, key.scopes, jsonBody(res)) } };
  }));
  v1.delete("/client_sessions/:id", h(async (req, res) => {
    keysOnly(res); need(res, "sessions");
    if (!(await revokeClientSession(callerOf(res).orgId, String(req.params.id)))) throw new ApiProblem(404, "not_found", "no such client session");
    return { status: 204 };
  }));
  const originsBody = async (orgId: number) => ({ data: await listOrigins(orgId), app: developerSurface()?.client_sessions.allowed_origins ?? [] });
  v1.get("/allowed_origins", h(async (_req, res) => { need(res, "sessions"); return { status: 200, body: await originsBody(callerOf(res).orgId) }; }));
  v1.post("/allowed_origins", h(async (_req, res) => {
    keysOnly(res); need(res, "sessions");
    await addOrigin(callerOf(res).orgId, jsonBody(res).origin, actorLabel(callerOf(res).actor));
    return { status: 200, body: await originsBody(callerOf(res).orgId) };
  }));
  v1.delete("/allowed_origins", h(async (req, res) => {
    keysOnly(res); need(res, "sessions");
    if (!(await removeOrigin(callerOf(res).orgId, q1(req, "origin") ?? ""))) throw new ApiProblem(404, "not_found", "that origin is not allowed here");
    return { status: 200, body: await originsBody(callerOf(res).orgId) };
  }));

  // ---------- webhooks out ----------
  const by = (res: Response) => actorLabel(callerOf(res).actor);
  const wh = (fn: (req: Request, res: Response, orgId: number) => Promise<Answer>) => h(async (req, res) => { keysOnly(res); need(res, "webhooks"); return fn(req, res, callerOf(res).orgId); });
  v1.get("/webhook_endpoints", wh(async (_q, _r, org) => ({ status: 200, body: { data: await hooks.listEndpoints(org) } })));
  v1.post("/webhook_endpoints", wh(async (_q, res, org) => ({ status: 201, body: { data: await hooks.createEndpoint(org, jsonBody(res), by(res)) } })));
  v1.get("/webhook_endpoints/:id", wh(async (req, _r, org) => ({ status: 200, body: { data: await hooks.getEndpoint(org, String(req.params.id)) } })));
  v1.patch("/webhook_endpoints/:id", wh(async (req, res, org) => ({ status: 200, body: { data: await hooks.updateEndpoint(org, String(req.params.id), jsonBody(res)) } })));
  v1.delete("/webhook_endpoints/:id", wh(async (req, _r, org) => {
    if (!(await hooks.deleteEndpoint(org, String(req.params.id)))) throw new ApiProblem(404, "not_found", "No such webhook endpoint");
    return { status: 204 };
  }));
  v1.post("/webhook_endpoints/:id/rotate_secret", wh(async (req, res, org) => ({ status: 200, body: { data: await hooks.rotateEndpointSecret(org, String(req.params.id), jsonBody(res), by(res)) } })));
  v1.get("/webhook_endpoints/:id/secret", wh(async (req, res, org) => ({ status: 200, body: { data: await hooks.revealWebhookSecret(org, String(req.params.id), by(res)) } })));
  v1.post("/webhook_endpoints/:id/test", wh(async (req, _r, org) => ({ status: 200, body: { data: await hooks.testEndpoint(org, String(req.params.id)) } })));
  v1.get("/webhook_endpoints/:id/deliveries", wh(async (req, _r, org) => ({ status: 200, body: await hooks.listDeliveries(org, String(req.params.id), { limit: q1(req, "limit"), after: q1(req, "after"), status: q1(req, "status") }) })));
  v1.get("/webhook_deliveries/:id", wh(async (req, _r, org) => ({ status: 200, body: { data: await hooks.getDelivery(org, String(req.params.id)) } })));
  v1.post("/webhook_deliveries/:id/retry", wh(async (req, _r, org) => ({ status: 200, body: { data: await hooks.redeliver(org, String(req.params.id)) } })));

  // ---------- webhooks in: the sources ----------
  if (developerSurface()?.webhooks_in?.length) {
    v1.get("/inbound_sources", wh(async (_q, _r, org) => ({ status: 200, body: { data: await listSources(org) } })));
    v1.post("/inbound_sources", wh(async (_q, res, org) => ({ status: 201, body: { data: await createSource(org, jsonBody(res), by(res)) } })));
    v1.delete("/inbound_sources/:id", wh(async (req, _r, org) => {
      if (!(await deleteSource(org, String(req.params.id)))) throw new ApiProblem(404, "not_found", "No such inbound source");
      return { status: 204 };
    }));
  }

  v1.use((_req, res) => void sendProblem(res, new ApiProblem(404, "not_found", "no such operation (see /openapi.json)")));
  r.use("/v1", v1);
  return r;
}
