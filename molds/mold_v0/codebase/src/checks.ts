/**
 * Declarative yes/no checks, answered (mold_v0-196; molds/mold_v0/MOLD.md "Declarative checks"; the declaration is
 * src/check-spec.ts, the evaluator src/check-eval.ts). With no check declared nothing here is mounted or listed: the
 * MCP surface and the API are exactly what they were.
 *
 *   POST /api/checks/<name>    the inputs as a JSON object -> {check, allowed, reason, record_refs, explanation?}
 *   GET  /api/checks           the checks a caller may ask, with their inputs
 *   MCP  check_<name>          the same answer, as a read-only tool of the workspace's MCP server
 *   POST /v1/checks/<name>     the developer surface's door (mold_v0-193, src/developer-api.ts), when the app has one
 *
 * Who asks: a signed-in person of a workspace (the console's session: cookie, with X-Pack-Request on a POST, or a
 * session token) or a workspace's MCP key (`Authorization: Bearer oct_...`, a member key with its person's role) on
 * /api/checks; on /v1/checks a developer key (`sk_`) or a client session (`cs_`) holding the scope `checks` (every
 * check) or `checks:<name>` (that one), with the developer surface's own origin, version and rate rules. The
 * workspace is always the caller's own,
 * never an input: every record is read through the record store for that workspace (src/record-areas.ts listFor and
 * getFor: its row-level security, the area's read permission for the caller's role, sealed areas opened with the
 * workspace's key, the data trail), so another workspace's records never answer. Each answer is one entry in the
 * platform trail when audit.platform is on (src/audit-trail.ts auditCheckAnswer: the check's name and outcome, never an
 * input or a value).
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import type { AccountRole } from "./account-roles.js";
import { auditCaller, auditCheckAnswer } from "./audit-trail.js";
import { resolveKey } from "./auth.js";
import { parseTime } from "./clock-math.js";
import { ANY_CANDIDATES, CHECK_SCOPE_PATTERN, CheckSchema, checkIndexHint, checkToolName, durationMs, fieldTypeOf, inputKind, isDateText, isGroup, opOf, parseOperand, requireOf,
  type Check, type CheckArea, type FieldCondition, type Kind } from "./check-spec.js";
import { evaluate, leafWords, pickLatest, valueAt, type EvalContext, type EvalRecord, type Leaf } from "./check-eval.js";
import { PackError, type PackTool, type RecordQuery, type RecordRow, type Workspace } from "./pack-api.js";
import { packs } from "./packs.js";
import { featureSetting } from "./feature-flags.js";
import { findArea, getFor, listFor, type Actor, type RecordArea } from "./record-areas.js";

/** Who asks: the workspace (from the session or key, never from input), the person's role and id, the scopes held. */
export interface CheckCaller {
  orgId: number;
  role: AccountRole | null;
  userId: string | null;
  /** A scoped credential's scopes (the developer surface's keys and client sessions, mold_v0-193); null: a session or MCP key, every check. */
  scopes: readonly string[] | null;
}
export interface CheckAnswer {
  check: string;
  allowed: boolean;
  reason: string;
  record_refs: { area: string; key: string }[];
  explanation?: {
    mode: "latest" | "any";
    at: string;
    record: { area: string; key: string } | null;
    lookup: { area: string; key: string } | null;
    decided_by: (Leaf & { words: string })[];
    conditions: (Leaf & { words: string })[];
    index: ReturnType<typeof checkIndexHint>;
  };
}

// ---------- the build's checks ----------

export interface DeclaredCheck extends Check { pack: string }
let cache: { from: unknown; list: DeclaredCheck[] } | null = null;
/** Every check the build's packs declare (checked when the packs were installed: src/packs.ts). */
export function declaredChecks(): DeclaredCheck[] {
  if (!featureSetting("declarative_checks")) return []; // the features registry (mold_v0-219): off, no route or tool
  const all = packs();
  if (cache?.from === all) return cache.list;
  const list = all.flatMap((p) => (p.definition.checks ?? []).map((c) => ({ ...CheckSchema.parse(c), pack: p.id })));
  cache = { from: all, list };
  return list;
}
export const findCheck = (name: string) => declaredChecks().find((c) => c.name === name) ?? null;
/** The scopes a developer key or client session may hold to ask checks: `checks` (all), `checks:<name>` (one). */
export const checkScopeNames = () => ["checks", ...declaredChecks().map((c) => `checks:${c.name}`)];
/** Does a credential holding `scopes` (null: not a scoped one) let its holder ask check `name`? */
export function scopeAllows(scopes: readonly string[] | null, name: string): boolean {
  if (scopes === null) return true;
  return scopes.some((s) => CHECK_SCOPE_PATTERN.test(s) && (s === "checks" || s === `checks:${name}`));
}

/** An area as the checks read it (live, sealed). */
export const checkAreaOf = (a: RecordArea): CheckArea => ({ name: a.name, scope: a.scope, fields: a.fields, live: a.repo?.kind === "http_api", sealed: a.role === "asset" || a.sealed === true });

// ---------- inputs ----------

const bad = (m: string) => new PackError(m, 400);
/** The asker's inputs, exactly as declared: nothing unknown, each of its type, the required ones given. */
export function checkInputs(c: Check, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad("give the inputs as a JSON object");
  const got = raw as Record<string, unknown>;
  const decl = c.inputs ?? {};
  for (const k of Object.keys(got)) if (!Object.hasOwn(decl, k)) throw bad(`${k.slice(0, 64)} is not an input of check ${c.name} (${Object.keys(decl).join(", ") || "it takes none"})`);
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(decl)) {
    const { optional, type } = inputKind(t);
    const v = got[k];
    if (v === undefined || v === null || v === "") { if (!optional) throw bad(`${k} is required (a ${type})`); continue; }
    const ok = type === "string" ? typeof v === "string" && v.length <= 500 && !v.includes("\u0000")
      : type === "number" ? typeof v === "number" && Number.isFinite(v)
      : type === "boolean" ? typeof v === "boolean"
      : type === "date" ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isDateText(v)
      : typeof v === "string" && v.length <= 40 && isDateText(v);
    if (!ok) throw bad(`${k}: a ${type}${type === "date" ? " (YYYY-MM-DD)" : type === "datetime" ? " (ISO 8601)" : type === "string" ? " (up to 500 characters)" : ""}`);
    out[k] = v;
  }
  return out;
}

// ---------- answering ----------

const recordOf = (r: RecordRow): EvalRecord => ({ key: r.key, title: r.title, data: r.data ?? {}, updated_at: r.updated_at ?? null });
/** An operand that may only be a value or an input (a match), resolved; undefined when an optional input is left out. */
function matchValue(v: unknown, kind: Kind, inputs: Record<string, unknown>, now: number, rec: EvalRecord | null): unknown {
  const x = parseOperand(v, kind);
  if (x.t === "literal") return x.value;
  if (x.t === "now") return new Date(now + x.offsetMs).toISOString();
  if (x.t === "ref") return rec ? valueAt({ record: rec, lookup: null, lookupAs: null }, x.path) : undefined;
  return inputs[x.name] ?? (x.orNow ? new Date(now).toISOString() : undefined);
}
const kindIn = (a: RecordArea, f: string): Kind => (f === "key" ? "string" : f === "updated_at" ? "date" : fieldTypeOf(a.fields.find((x) => x.name === f) ?? { name: f }).kind);
/** A match as the record store's filter (src/record-query.ts): equality, or set membership for a list. */
function filterOf(area: RecordArea, match: Record<string, unknown>, inputs: Record<string, unknown>, now: number, rec: EvalRecord | null): Record<string, unknown> | null {
  const f: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(match)) {
    const k = kindIn(area, name);
    if (Array.isArray(v)) {
      const vals = v.map((x) => matchValue(x, k, inputs, now, rec));
      if (vals.some((x) => x === undefined || x === null)) return null;
      f[name] = { in: vals };
    } else {
      const x = matchValue(v, k, inputs, now, rec);
      if (x === undefined || x === null || x === "") return null;
      f[name] = x;
    }
  }
  return f;
}
/**
 * An any-record rule's conditions, added to the filter: the database finds the records that may meet them all, and the
 * evaluator decides. Every condition here is implied by the evaluator's own (never narrower), so no record that meets
 * require is left out: a date bound is widened to whole days on each side (stored dates are ISO text, compared as text
 * in the database, instants in the evaluator; a zone's offset is under a day), a date equality is left to the evaluator.
 */
const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function requireFilter(area: RecordArea, conds: FieldCondition[], inputs: Record<string, unknown>, now: number): Record<string, Record<string, unknown>> | null {
  const f: Record<string, Record<string, unknown>> = {};
  const put = (field: string, op: string, v: unknown) => { if ((f[field] ??= {})[op] === undefined) f[field]![op] = v; };
  const ms = (v: unknown) => { const t = typeof v === "string" ? parseTime(v) : null; return t; };
  for (const c of conds) {
    const op = opOf(c)[0]!;
    const k = kindIn(area, c.field);
    const val = (v: unknown) => matchValue(v, k, inputs, now, null);
    switch (op) {
      case "exists": put(c.field, "exists", c.exists); break;
      case "has": { const v = val(c.has); if (v === undefined) return null; put(c.field, "contains", v); break; }
      case "in": { if (k === "date") break; const vs = c.in!.map(val); if (vs.some((v) => v === undefined)) return null; put(c.field, "in", vs); break; }
      case "not_in": break;
      case "eq": case "ne": { if (k === "date") break; const v = val(c[op]); if (v === undefined) return null; put(c.field, op, v); break; }
      case "gt": case "gte": case "lt": case "lte": {
        const v = val(c[op]);
        if (v === undefined) return null;
        if (k !== "date") { put(c.field, op, v); break; }
        const t = ms(v);
        if (t === null) break;
        if (op === "gt" || op === "gte") put(c.field, "gte", dayOf(t - DAY)); else put(c.field, "lt", dayOf(t + 2 * DAY));
        break;
      }
      case "within": {
        const w = c.within!;
        const ref = w.of === undefined ? now : ms(val(w.of));
        if (ref === null || ref === undefined) { if (w.of !== undefined && val(w.of) === undefined) return null; break; }
        const span = durationMs((w.last ?? w.next)!);
        const [from, to] = w.last ? [ref - span, ref] : [ref, ref + span];
        put(c.field, "gte", dayOf(from - DAY));
        put(c.field, "lt", dayOf(to + 2 * DAY));
        break;
      }
    }
  }
  return f;
}

const ref = (a: { name: string }, r: EvalRecord) => ({ area: a.name, key: r.key });

/**
 * Answer check `name` for `caller` with `rawInputs` (checked against the declaration), at `now`. Reads only the
 * caller's workspace's records (and shared ones), through the record store.
 */
export async function answerCheck(caller: CheckCaller, name: string, rawInputs: unknown, now = Date.now()): Promise<CheckAnswer> {
  const c = findCheck(String(name));
  if (!c) throw new PackError(`no check ${String(name).slice(0, 64)}`, 404);
  if (!scopeAllows(caller.scopes, c.name)) throw new PackError(`this credential may not ask check ${c.name} (it needs the scope checks:${c.name} or checks)`, 403);
  const inputs = checkInputs(c, rawInputs);
  const t0 = performance.now();
  const answer = await decide(c, caller, inputs, now);
  auditCheckAnswer(caller.orgId, c.name, answer.allowed, Math.round(performance.now() - t0));
  return answer;
}

async function decide(c: DeclaredCheck, caller: CheckCaller, inputs: Record<string, unknown>, now: number): Promise<CheckAnswer> {
  const actor: Actor = { role: caller.role, userId: caller.userId };
  const r = c.rule;
  const area = findArea(r.area);
  if (!area) throw new PackError(`check ${c.name}: its area ${r.area} is not installed`, 500);
  const lookupArea = r.lookup ? findArea(r.lookup.area) : null;
  const req = requireOf(r);
  const filter = filterOf(area, r.match, inputs, now, null);
  if (!filter) throw bad(`check ${c.name}: a value it matches on is missing`);
  const hint = checkIndexHint(c, checkAreaOf(area));
  const mode = r.latest_by ? "latest" as const : "any" as const;

  // The candidates, as the workspace sees them: the latest one, or those the database finds meeting require.
  const list = async (q: RecordQuery) => (await listFor(caller.orgId, area.name, q, actor)).records.map(recordOf);
  let candidates: EvalRecord[];
  if (mode === "latest") candidates = await list({ filter, sort: `-${r.latest_by}`, limit: 1 });
  else {
    const extra = requireFilter(area, ("all" in req ? req.all : [req]).filter((x): x is FieldCondition => !isGroup(x)), inputs, now);
    candidates = extra ? await list({ filter: mergeFilter(filter, extra), sort: "key", limit: ANY_CANDIDATES }) : [];
  }

  // The lookup's record (one level): by key, or by its match (its latest, else its first by key).
  const lookupFor = async (rec: EvalRecord): Promise<EvalRecord | null> => {
    if (!r.lookup || !lookupArea) return null;
    if (r.lookup.key !== undefined) {
      const k = matchValue(r.lookup.key, "string", inputs, now, rec);
      if (typeof k !== "string" || !k) return null;
      try { const got = await getFor(caller.orgId, lookupArea.name, k, actor); return got ? recordOf(got) : null; }
      catch (e) { if (e instanceof PackError && e.status === 400) return null; throw e; }
    }
    const lf = filterOf(lookupArea, r.lookup.match ?? {}, inputs, now, rec);
    if (!lf) return null;
    const got = (await listFor(caller.orgId, lookupArea.name, { filter: lf, sort: r.lookup.latest_by ? `-${r.lookup.latest_by}` : "key", limit: 1 }, actor)).records;
    return got[0] ? recordOf(got[0]) : null;
  };
  const kindOf = (p: string): Kind => {
    const dot = p.indexOf(".");
    return dot < 0 ? kindIn(area, p) : lookupArea ? kindIn(lookupArea, p.slice(dot + 1)) : "string";
  };
  const ctxOf = (record: EvalRecord, lookup: EvalRecord | null): EvalContext => ({ record, lookup, lookupAs: r.lookup?.as ?? null, inputs, now, kindOf });
  const words = (l: Leaf) => ({ ...l, words: leafWords(l, kindOf(l.field)) });
  const matchWords = Object.keys(r.match).join(", ");
  const at = new Date(now).toISOString();
  const explained = (allowed: boolean, reason: string, record: EvalRecord | null, lookup: EvalRecord | null, outcome: ReturnType<typeof evaluate> | null): CheckAnswer => ({
    check: c.name, allowed, reason,
    record_refs: [...(record ? [ref(area, record)] : []), ...(lookup && lookupArea ? [ref(lookupArea, lookup)] : [])],
    ...(c.explain ? { explanation: { mode, at, record: record ? ref(area, record) : null, lookup: lookup && lookupArea ? ref(lookupArea, lookup) : null,
      decided_by: (outcome?.decided_by ?? []).map(words), conditions: (outcome?.evaluated ?? []).map(words), index: hint } } : {}),
  });

  if (mode === "latest") {
    const rec = pickLatest(candidates, r.latest_by!, kindIn(area, r.latest_by!));
    if (!rec) return explained(false, `no ${area.label} record matches (${matchWords})`, null, null, null);
    const lk = await lookupFor(rec);
    const o = evaluate(req, ctxOf(rec, lk));
    const decisive = o.decided_by.map((l) => leafWords(l, kindOf(l.field)));
    return explained(o.passed, o.passed
      ? `the latest ${area.label} record (${rec.key}) meets every condition`
      : `the latest ${area.label} record (${rec.key}) does not: ${decisive.join("; ")}`, rec, lk, o);
  }
  // Any record: the first (by key) the database found that the evaluator agrees meets require.
  for (const rec of [...candidates].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const o = evaluate(req, ctxOf(rec, null));
    if (o.passed) return explained(true, `${area.label} record ${rec.key} meets every condition`, rec, null, o);
  }
  // None: explain with the first matching record (by key), when there is one.
  const [first] = await list({ filter, sort: "key", limit: 1 });
  if (!first) return explained(false, `no ${area.label} record matches (${matchWords})`, null, null, null);
  const o = evaluate(req, ctxOf(first, null));
  return explained(false, `no matching ${area.label} record meets every condition; ${first.key}: ${o.decided_by.filter((l) => !l.passed).map((l) => leafWords(l, kindOf(l.field))).join("; ") || "it does not"}`, first, null, o);
}
function mergeFilter(a: Record<string, unknown>, b: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [f, ops] of Object.entries(b)) {
    const cur = out[f];
    // A field the match already pins keeps its value: require's operators on it are left to the evaluator.
    if (cur !== undefined) continue;
    out[f] = ops;
  }
  return out;
}

// ---------- MCP ----------

const inputSchemaOf = (c: Check): z.ZodRawShape => Object.fromEntries(Object.entries(c.inputs ?? {}).map(([k, t]) => {
  const { optional, type } = inputKind(t);
  const base = type === "number" ? z.number() : type === "boolean" ? z.boolean() : z.string().max(500).describe(type === "date" ? "a date, YYYY-MM-DD" : type === "datetime" ? "a time, ISO 8601" : "text");
  return [k, optional ? base.optional() : base];
}));

/** The MCP tools that answer the build's checks (none without a check: the surface is unchanged). */
export function checkTools(): (PackTool & { pack: string })[] {
  return declaredChecks().map((c) => ({
    pack: c.pack,
    name: checkToolName(c.name),
    title: c.label ?? `Check ${c.name}`,
    description: `Answer yes or no: ${c.description ?? c.label ?? c.name}. Reads this workspace's ${c.rule.area} records${c.rule.latest_by ? ` (the latest by ${c.rule.latest_by} decides)` : ""}. Returns {allowed, reason, record_refs${c.explain ? ", explanation (every condition evaluated and the one that decided it)" : ""}}.`,
    inputSchema: inputSchemaOf(c),
    annotations: { title: c.label ?? `Check ${c.name}`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ws: Workspace, args: Record<string, unknown>) => answerCheck({ orgId: ws.id, role: ws.role, userId: ws.userId, scopes: null }, c.name, args),
  }) as unknown as PackTool & { pack: string });
}

// ---------- HTTP ----------

const bearer = (req: Request) => {
  const h = req.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? req.get("x-api-key") ?? null;
};
const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/** /api/checks: nothing is mounted with no check declared. `session` is the console's (src/app.ts customerSession). */
export function checkAppRouter(session: (req: Request, res: Response, next: NextFunction) => unknown): Router {
  const r = express.Router();
  if (!declaredChecks().length) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "16kb" }));
  r.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => (err ? void res.status(err.status && err.status < 500 ? err.status : 400).json({ error: "The request body must be a JSON object of the check's inputs" }) : next()));
  // Who asks: an MCP key, else a session (developer keys and client sessions ask at /v1/checks).
  r.use(async (req, res, next) => {
    const token = bearer(req);
    try {
      if (token?.startsWith("oct_")) {
        const org = await resolveKey(token);
        if (!org) return void res.status(401).json({ error: "That key is not valid (revoked, expired or unknown)" });
        auditCaller(org);
        res.locals.checkCaller = { orgId: org.orgId, role: org.role ?? null, userId: org.userId ?? null, scopes: null } satisfies CheckCaller;
        return next();
      }
    } catch (e) { return next(e); }
    // The console's session: a POST riding its cookie carries X-Pack-Request (CSRF), as the data API asks.
    return session(req, res, () => {
      if (req.method !== "GET" && res.locals.viaCookie && req.get("x-pack-request") !== "1") return void res.status(403).json({ error: "Missing X-Pack-Request header" });
      const s = res.locals.session as { org: number; user: string | null; accountRole?: AccountRole | null };
      res.locals.checkCaller = { orgId: s.org, role: s.accountRole ?? null, userId: s.user ?? null, scopes: null } satisfies CheckCaller;
      next();
    });
  });
  const caller = (res: Response) => res.locals.checkCaller as CheckCaller;
  r.get("/", answer(async (_req, res) => ({ checks: declaredChecks().filter((c) => scopeAllows(caller(res).scopes, c.name)).map((c) => ({
    name: c.name, label: c.label ?? null, description: c.description ?? null, inputs: c.inputs, area: c.rule.area, latest_by: c.rule.latest_by ?? null, tool: checkToolName(c.name) })) })));
  r.post("/:name", answer(async (req, res) => answerCheck(caller(res), String(req.params.name), req.body)));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** For tests and the build log: each check's index hint. */
export const checkHints = () => declaredChecks().map((c) => { const a = findArea(c.rule.area); return { check: c.name, ...checkIndexHint(c, a ? checkAreaOf(a) : undefined) }; });
