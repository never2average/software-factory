/**
 * Log drains in (mold_v0-303): an inbound receiver (pack.json developer_surface.webhooks_in) of kind log drain takes a
 * hosting provider's request logs and keeps only per-window aggregates of them, as report records in a workspace area:
 * per deployment and window, requests, errors (5xx), error rate, p95 and mean latency, source "log drain". No log line,
 * path, address or user agent is kept: each delivery is reduced to counts and a latency histogram, then dropped.
 *
 *   signature   pluggable (`signature`): "standard" (Standard Webhooks, src/developer-webhooks.ts verifySigned) or
 *               "vercel" (x-vercel-signature: the hex HMAC-SHA1 of the raw body keyed with the drain's secret).
 *   secret      by name only: `log_drain.secret_env` names the environment variable holding the drain's secret (set
 *               with provision.py --set-secret); absent or unset, the inbound source's own sealed secret (whsec_...,
 *               given to the provider as the drain's custom secret).
 *   handshake   a provider proving the endpoint (Vercel: the x-vercel-verify response header, its value the token
 *               `log_drain.verify_env` names) is answered on every response of the source; an empty body writes nothing.
 *   bodies      NDJSON (one JSON object a line), a JSON array, or one JSON object; at most `log_drain.max_bytes` (default
 *               and cap 1 MiB, the API's own body limit) and MAX_LINES lines; anything else is refused whole.
 *   requests    a line with a status code (statusCode, or proxy.statusCode) is one request; lines sharing a requestId
 *               are one request (its status from the line that has one, its duration from the line that has one, or a
 *               "Duration: <n> ms" report line). Lines whose `source` or `environment` the receiver does not take are
 *               skipped.
 *   deployment  each request's deployment is resolved by `log_drain.deployments`: a record of that area whose `field`
 *               equals the line's deploymentId, projectId or host (`match`; a host also matches the field stored as an
 *               https:// address). One that matches no record is counted (`unknown`) and never creates a record.
 *   windows     `window_minutes` long (default 60), UTC-aligned, by the line's timestamp; the report record of a
 *               deployment's window (key <deployment key>.<yyyymmddThhmmZ>) is read, merged and written again. Its
 *               latency histogram (2 significant digits a bucket, so p95 is within 5%) is kept in the area's json field
 *               mapped as `buckets`; without one, p95 covers each delivery alone.
 *
 * The pure parts (parse, verify, reduce, merge) are exported for scripts/log-drain-test.ts; the write is
 * src/developer-inbound.ts's (the source, its idempotency, the record store).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiProblem } from "./developer-surface.js";
import { RECORD_KEY } from "./pack-api.js";

/** The largest body taken (the API's own raw-body limit). */
export const LOG_DRAIN_MAX_BYTES = 1024 * 1024;
/** The most lines one delivery may have. */
export const MAX_LINES = 20_000;
/** The most report records one delivery may write (deployments x windows). */
export const MAX_REPORTS = 500;

export type SignatureKind = "standard" | "vercel";
/** The report fields a receiver writes, by their logical names (the area's field of that name unless mapped). */
export const REPORT_FIELDS = ["deployment", "window_start", "window_end", "requests", "errors", "error_rate", "p95_ms", "mean_ms", "source", "buckets"] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

/** The receiver's log-drain options, as read (defensively: src/pack-manifest.ts owns their shape). */
export interface LogDrainOptions {
  signature: SignatureKind;
  secret_env: string | null;
  verify_env: string | null;
  verify_header: string | null;
  max_bytes: number;
  window_minutes: number;
  deployments: { area: string; field: string; match: "deployment_id" | "project_id" | "host" };
  fields: Partial<Record<ReportField, string>>;
  sources: string[] | null;
  environments: string[] | null;
  source_label: string;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const strList = (v: unknown, max = 20) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 60).slice(0, max) : null);

/**
 * A receiver's log-drain options, or null when it is not a log-drain receiver (no `log_drain` object). Unknown or
 * malformed values fall back to the defaults; a secret value is never read from here, only an environment name.
 */
export function logDrainOptions(r: unknown): LogDrainOptions | null {
  const raw = (r as { log_drain?: unknown; signature?: unknown } | null) ?? null;
  const ld = raw?.log_drain;
  if (!ld || typeof ld !== "object" || Array.isArray(ld)) return null;
  const o = ld as Record<string, unknown>;
  const dep = (o.deployments && typeof o.deployments === "object" ? o.deployments : {}) as Record<string, unknown>;
  const fields: Partial<Record<ReportField, string>> = {};
  const fm = (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<string, unknown>;
  for (const f of REPORT_FIELDS) if (typeof fm[f] === "string" && FIELD.test(fm[f] as string)) fields[f] = fm[f] as string;
  const signature: SignatureKind = raw?.signature === "vercel" ? "vercel" : "standard";
  const n = (v: unknown, def: number, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : def);
  return {
    signature,
    secret_env: typeof o.secret_env === "string" && ENV_NAME.test(o.secret_env) ? o.secret_env : null,
    verify_env: typeof o.verify_env === "string" && ENV_NAME.test(o.verify_env) ? o.verify_env : null,
    verify_header: signature === "vercel" ? "x-vercel-verify" : null,
    max_bytes: n(o.max_bytes, LOG_DRAIN_MAX_BYTES, 1024, LOG_DRAIN_MAX_BYTES),
    window_minutes: n(o.window_minutes, 60, 1, 24 * 60),
    deployments: {
      area: typeof dep.area === "string" && FIELD.test(dep.area) ? dep.area : "deployments",
      field: typeof dep.field === "string" && (FIELD.test(dep.field) || dep.field === "$key") ? dep.field : "$key",
      match: dep.match === "project_id" || dep.match === "host" ? dep.match : "deployment_id",
    },
    fields,
    sources: strList(o.sources),
    environments: strList(o.environments),
    source_label: typeof o.source_label === "string" && o.source_label.trim() ? o.source_label.trim().slice(0, 60) : "log drain",
  };
}

/** What only the whole build can say of a log-drain receiver: src/developer-config.ts (no imports there, for gen-packs). */
export { logDrainProblems } from "./developer-config.js";

// ---------- signatures ----------

const h1 = (headers: Record<string, string | string[] | undefined>, n: string) => { const v = headers[n]; return (Array.isArray(v) ? v[0] : v) ?? ""; };

/** Vercel's: x-vercel-signature is the hex HMAC-SHA1 of the raw body, keyed with the drain's secret. */
export function vercelSignature(secret: string, raw: string): string {
  return createHmac("sha1", secret).update(raw, "utf8").digest("hex");
}
export function verifyVercel(secret: string, headers: Record<string, string | string[] | undefined>, raw: string): { id: string } {
  const got = h1(headers, "x-vercel-signature").trim().toLowerCase();
  if (!got) throw new ApiProblem(400, "invalid_signature", "x-vercel-signature is required");
  const want = Buffer.from(vercelSignature(secret, raw)), g = Buffer.from(got);
  if (g.length !== want.length || !timingSafeEqual(g, want)) throw new ApiProblem(400, "invalid_signature", "the signature does not match");
  // No message id: the body's hash is (a retried delivery is the same body, written once).
  return { id: `body:${createHash("sha256").update(raw).digest("hex").slice(0, 48)}` };
}

// ---------- parsing ----------

/** A delivery's lines: NDJSON, a JSON array, or one object. Refused whole when a line is not a JSON object. */
export function parseLines(raw: string, maxBytes = LOG_DRAIN_MAX_BYTES): Record<string, unknown>[] {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new ApiProblem(413, "too_large", `a log delivery is at most ${maxBytes} bytes`);
  const t = raw.trim();
  if (!t) return [];
  let lines: unknown[];
  if (t.startsWith("[")) {
    try { lines = JSON.parse(t); } catch { throw new ApiProblem(400, "invalid_request", "the body is not a JSON array, NDJSON or a JSON object"); }
    if (!Array.isArray(lines)) throw new ApiProblem(400, "invalid_request", "the body is not a JSON array");
  } else {
    const parts = t.split(/\r?\n/).filter((l) => l.trim());
    lines = parts.map((l, i) => { try { return JSON.parse(l); } catch { throw new ApiProblem(400, "invalid_request", `line ${i + 1} is not JSON`); } });
  }
  if (lines.length > MAX_LINES) throw new ApiProblem(413, "too_large", `at most ${MAX_LINES} log lines a delivery`);
  for (const [i, l] of lines.entries()) if (!l || typeof l !== "object" || Array.isArray(l)) throw new ApiProblem(400, "invalid_request", `line ${i + 1} is not a JSON object`);
  return lines as Record<string, unknown>[];
}

// ---------- reducing ----------

/** A latency bucket: the duration to 2 significant digits (exact below 100 ms), so a percentile is within 5%. */
export function bucketOf(ms: number): number {
  if (!(ms >= 0) || !Number.isFinite(ms)) return 0;
  if (ms < 100) return Math.round(ms);
  const p = 10 ** (Math.floor(Math.log10(ms)) - 1);
  return Math.round(ms / p) * p;
}
export type Histogram = Record<string, number>;
/** The nearest-rank percentile of a histogram (null: empty). */
export function percentile(h: Histogram, q: number): number | null {
  const xs = Object.entries(h).map(([k, n]) => [Number(k), n] as const).filter(([k, n]) => Number.isFinite(k) && n > 0).sort((a, b) => a[0] - b[0]);
  const total = xs.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  const rank = Math.ceil(q * total);
  let c = 0;
  for (const [k, n] of xs) { c += n; if (c >= rank) return k; }
  return xs[xs.length - 1]![0];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
const DURATION_IN_MESSAGE = /\bDuration:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\b/;

/** One request as the logs say: its deployment's ids, its status, its duration (ms) and when. */
export interface DrainRequest { deployment_id?: string; project_id?: string; host?: string; status?: number; duration_ms?: number; at: number }

/** The requests of a delivery's lines (see the header: a line with a status code is a request; a requestId joins lines). */
export function requestsOf(lines: Record<string, unknown>[], o: Pick<LogDrainOptions, "sources" | "environments">, now = Date.now()): DrainRequest[] {
  const byId = new Map<string, DrainRequest>(), loose: DrainRequest[] = [];
  for (const l of lines) {
    const source = str(l.source), env = str(l.environment);
    if (source === "build") continue;
    if (o.sources && source && !o.sources.includes(source)) continue;
    if (o.environments && env && !o.environments.includes(env)) continue;
    const proxy = (l.proxy && typeof l.proxy === "object" ? l.proxy : {}) as Record<string, unknown>;
    const status = num(proxy.statusCode) ?? num(l.statusCode);
    let duration = num(l.durationMs) ?? num(l.duration) ?? num(proxy.durationMs) ?? num(proxy.duration);
    if (duration === undefined && typeof l.message === "string") { const m = DURATION_IN_MESSAGE.exec(l.message); if (m) duration = Number(m[1]); }
    const at = num(l.timestamp) ?? num(proxy.timestamp) ?? now;
    const r: DrainRequest = { deployment_id: str(l.deploymentId), project_id: str(l.projectId), host: str(proxy.host) ?? str(l.host), at,
      ...(status !== undefined && status >= 100 && status <= 599 ? { status: Math.trunc(status) } : {}),
      ...(duration !== undefined && duration >= 0 && duration < 86_400_000 ? { duration_ms: duration } : {}) };
    const id = str(l.requestId);
    if (!id) { if (r.status !== undefined) loose.push(r); continue; }
    const prior = byId.get(id);
    if (!prior) { byId.set(id, r); continue; }
    prior.status ??= r.status; prior.duration_ms ??= r.duration_ms;
    prior.deployment_id ??= r.deployment_id; prior.project_id ??= r.project_id; prior.host ??= r.host;
    prior.at = Math.min(prior.at, r.at);
  }
  return [...[...byId.values()].filter((r) => r.status !== undefined), ...loose];
}

/** A host as matched: lowercase, without a scheme, a path or a trailing dot. */
export const hostOf = (v: string) => v.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0]!.replace(/\.$/, "");

/** The value of a request its deployment is matched by. */
export function matchValue(r: DrainRequest, match: LogDrainOptions["deployments"]["match"]): string | undefined {
  return match === "project_id" ? r.project_id : match === "host" ? (r.host ? hostOf(r.host) : undefined) : r.deployment_id;
}

/** One window's aggregate. */
export interface WindowAgg { start: number; end: number; requests: number; errors: number; timed: number; total_ms: number; buckets: Histogram }
/** Group requests by a deployment value and UTC window. */
export function aggregate(reqs: DrainRequest[], valueOf: (r: DrainRequest) => string | undefined, windowMinutes: number): Map<string, Map<number, WindowAgg>> {
  const w = windowMinutes * 60_000;
  const out = new Map<string, Map<number, WindowAgg>>();
  for (const r of reqs) {
    const v = valueOf(r);
    if (v === undefined) continue;
    const start = Math.floor(r.at / w) * w;
    let byWin = out.get(v);
    if (!byWin) out.set(v, (byWin = new Map()));
    let a = byWin.get(start);
    if (!a) byWin.set(start, (a = { start, end: start + w, requests: 0, errors: 0, timed: 0, total_ms: 0, buckets: {} }));
    a.requests++;
    if ((r.status ?? 0) >= 500) a.errors++;
    if (r.duration_ms !== undefined) { a.timed++; a.total_ms += r.duration_ms; const b = String(bucketOf(r.duration_ms)); a.buckets[b] = (a.buckets[b] ?? 0) + 1; }
  }
  return out;
}

/** The report record's fields as stored before (null: none), as an aggregate to merge into. */
export function priorOf(data: Record<string, unknown> | null, f: (k: ReportField) => string | null): Pick<WindowAgg, "requests" | "errors" | "timed" | "total_ms" | "buckets"> | null {
  if (!data) return null;
  const g = (k: ReportField) => { const n = f(k); return n ? data[n] : undefined; };
  const requests = num(g("requests")) ?? 0, errors = num(g("errors")) ?? 0, mean = num(g("mean_ms"));
  const rawB = g("buckets");
  const buckets: Histogram = {};
  if (rawB && typeof rawB === "object" && !Array.isArray(rawB))
    for (const [k, v] of Object.entries(rawB as Record<string, unknown>)) { const n = num(v); if (Number.isFinite(Number(k)) && n !== undefined && n > 0) buckets[k] = Math.trunc(n); }
  const histTimed = Object.values(buckets).reduce((s, n) => s + n, 0);
  // Without the histogram, the requests that had a duration are taken as all of them (the mean's weight).
  const timed = histTimed || (mean !== undefined ? requests : 0);
  return { requests, errors, timed, total_ms: mean !== undefined ? mean * timed : 0, buckets };
}

/** A window's aggregate merged with what its record held. */
export function merge(a: WindowAgg, prior: ReturnType<typeof priorOf>): WindowAgg {
  if (!prior) return a;
  const buckets: Histogram = { ...prior.buckets };
  for (const [k, n] of Object.entries(a.buckets)) buckets[k] = (buckets[k] ?? 0) + n;
  return { ...a, requests: a.requests + prior.requests, errors: a.errors + prior.errors, timed: a.timed + prior.timed, total_ms: a.total_ms + prior.total_ms, buckets };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
/** A report record's field values (by logical name) for a merged window. */
export function reportValues(a: WindowAgg, deploymentKey: string, sourceLabel: string): Record<ReportField, unknown> {
  const p95 = percentile(a.buckets, 0.95);
  return {
    deployment: deploymentKey, window_start: new Date(a.start).toISOString(), window_end: new Date(a.end).toISOString(),
    requests: a.requests, errors: a.errors, error_rate: a.requests ? round(a.errors / a.requests, 4) : 0,
    p95_ms: p95 === null ? null : round(p95, 1), mean_ms: a.timed ? round(a.total_ms / a.timed, 1) : null,
    source: sourceLabel, buckets: a.buckets,
  };
}

/** A report record's key: the deployment's key and the window's start (UTC), kept within the record key's form. */
export function reportKey(deploymentKey: string, start: number): string {
  const stamp = new Date(start).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace(/\d{2}Z$/, "Z");
  const k = `${deploymentKey.slice(0, 180)}.${stamp}`;
  return RECORD_KEY.test(k) ? k : `d${createHash("sha256").update(deploymentKey).digest("hex").slice(0, 24)}.${stamp}`;
}

/** Calls on one report record are made one at a time in this process (a read, a merge, a write). */
const chains = new Map<string, Promise<unknown>>();
export function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const p = prior.catch(() => null).then(fn);
  const tail = p.catch(() => null);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return p;
}
