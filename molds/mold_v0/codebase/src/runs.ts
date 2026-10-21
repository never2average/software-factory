/**
 * The generic run engine (mold_v0-041; molds/mold_v0/MOLD.md "Pack and record-area contract"), beside the product's
 * own session queue (src/worker.ts, agent_sessions), which it does not touch. Tables: sql/migrations/0005_runs.sql.
 *
 *   start     a workspace (a pack's tool or route, ctx.runs.start) queues a run of one of the pack's job kinds. The
 *             kind's limits are frozen into the run: token lifetime, lease, attempts, budget, egress hosts.
 *   claim     a runner (the fleet token at /api/worker/runs, or in-process) takes the oldest queued run of the kinds it
 *             serves, FOR UPDATE SKIP LOCKED, gets a lease token (only its hash is stored), a deadline (now + the
 *             kind's token lifetime) and a gateway token that lives exactly until that deadline
 *   heartbeat renews the lease (lease_seconds); answers cancel=true once the run is cancelled or past its deadline
 *   events    appended to run_events by the lease holder
 *   complete  by the lease holder: succeeded (its results checked against the record areas and written), failed, or,
 *             for an infrastructure failure with attempts left, queued again for a fresh attempt
 *   cancel    by the workspace: a queued run ends at once; a running one stops spending at once (its gateway tokens are
 *             revoked) and ends when its runner sees cancel=true at its next heartbeat, or when its lease lapses
 *   sweep     runs whose lease lapsed: queued again (infrastructure, attempts left), else failed; cancelled if asked
 *
 * Each step that names a run checks the lease token of the current attempt, so a runner whose lease lapsed and was
 * claimed again can neither heartbeat, write nor complete it. Every row carries the workspace (org_id); the workspace
 * of a run is taken from the caller's session (start, cancel) or from the run row (claim), never from a runner's input.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { brokerRunCredentials, revokeRunTokens, runGatewayUsage } from "./gateway.js";
import { JobKindSchema, PackError, z, type RunResultRow, type RunView, type WorkspaceRuns } from "./pack-api.js";
import { packs } from "./packs.js";
import { findArea } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";

export type JobKind = z.output<typeof JobKindSchema> & { pack: string };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let cache: { from: unknown; kinds: JobKind[] } | null = null;
/** Every job kind the packs declare (the definition checked by definePack; names are unique within a pack). */
export function jobKinds(): JobKind[] {
  const list = packs();
  if (cache?.from === list) return cache.kinds;
  cache = { from: list, kinds: list.flatMap((p) => (p.definition.jobKinds ?? []).map((k) => ({ ...JobKindSchema.parse(k), pack: p.id }))) };
  return cache.kinds;
}
export const findKind = (pack: string, name: string) => jobKinds().find((k) => k.pack === pack && k.name === name) ?? null;

export class RunLeaseError extends PackError {
  constructor(message = "This run's lease is not yours (it lapsed, or the run ended): stop working on it") { super(message, 409); }
}

interface RunRow {
  id: string; org_id: number; pack: string; kind: string; status: RunView["status"]; scope: Record<string, unknown>; targets: Record<string, unknown>;
  spec: JobKind; attempt: number; max_attempts: number; token_lifetime_seconds: number; lease_seconds: number; budget_usd: number; egress: string[];
  worker_id: string | null; lease_expires_at: Date | null; deadline_at: Date | null; cancel_requested_at: Date | null; cost_usd: number;
  error_kind: string | null; error: string | null; created_at: Date; started_at: Date | null; ended_at: Date | null;
}
const COLS = `id, org_id, pack, kind, status, scope, targets, spec, attempt, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, egress,
  worker_id, lease_expires_at, deadline_at, cancel_requested_at, cost_usd, error_kind, error, created_at, started_at, ended_at`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export const view = (r: RunRow): RunView => ({
  id: r.id, pack: r.pack, kind: r.kind, status: r.status, attempt: r.attempt, max_attempts: r.max_attempts,
  scope: r.scope ?? {}, targets: r.targets ?? {}, cost_usd: Number(r.cost_usd), budget_usd: Number(r.budget_usd),
  error_kind: r.error_kind, error: r.error, cancel_requested: !!r.cancel_requested_at,
  created_at: iso(r.created_at)!, started_at: iso(r.started_at), ended_at: iso(r.ended_at),
});

const jsonObject = (v: unknown, what: string) => {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new PackError(`${what} must be an object`, 400);
  if (Buffer.byteLength(JSON.stringify(v)) > 64 * 1024) throw new PackError(`${what} is at most 64 KB`, 413);
  return v as Record<string, unknown>;
};

// ---------- the workspace's side: start, read, cancel ----------

/** Queue a run of `pack`'s job kind for workspace `orgId` (the caller's own workspace, from its session). */
export async function startRun(orgId: number, pack: string, kind: string, input: { scope?: unknown; targets?: unknown } = {}, requestedBy: string | null = null): Promise<RunView> {
  const k = findKind(pack, kind);
  if (!k) throw new PackError(`pack ${pack} has no job kind ${JSON.stringify(String(kind).slice(0, 64))}`, 404);
  const scope = jsonObject(input.scope, "scope"), targets = jsonObject(input.targets, "targets");
  const id = `run_${randomBytes(12).toString("base64url")}`;
  // The tenant role may only read runs: the row is written by the platform, with the workspace the caller is scoped to.
  const [r] = await asPlatform(async () => (await getDb()).query<RunRow>(
    `INSERT INTO runs (id, org_id, pack, kind, scope, targets, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, egress, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLS}`,
    [id, orgId, pack, kind, JSON.stringify(scope), JSON.stringify(targets), JSON.stringify(k), k.max_attempts, k.token_lifetime_seconds,
     k.lease_seconds, k.budget_usd, k.egress.map((h) => h.replace(/^\*\./, "").toLowerCase()), requestedBy]));
  await event(id, orgId, 0, "queued", { kind, requested_by: requestedBy });
  return view(r!);
}

export async function getRun(orgId: number, id: string): Promise<RunView | null> {
  const [r] = await (await getDb()).query<RunRow>(`SELECT ${COLS} FROM runs WHERE org_id = $1 AND id = $2`, [orgId, String(id)]);
  return r ? view(r) : null;
}
export async function listRuns(orgId: number, opts: { pack?: string; limit?: number } = {}): Promise<RunView[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const rows = await (await getDb()).query<RunRow>(
    `SELECT ${COLS} FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR pack = $2) ORDER BY created_at DESC, id DESC LIMIT $3`, [orgId, opts.pack ?? null, limit]);
  return rows.map(view);
}
export async function runResults(orgId: number, id: string): Promise<RunResultRow[]> {
  const rows = await (await getDb()).query<{ check_area: string; check_key: string; asset_area: string | null; asset_key: string | null; source_area: string | null;
    source_key: string | null; status: RunResultRow["status"]; finding_fingerprint: string | null; evidence_ref: string | null; detail: Record<string, unknown> }>(
    `SELECT check_area, check_key, asset_area, asset_key, source_area, source_key, status, finding_fingerprint, evidence_ref, detail
       FROM run_results WHERE org_id = $1 AND run_id = $2 ORDER BY id`, [orgId, String(id)]);
  return rows.map((r) => ({ check: { area: r.check_area, key: r.check_key }, asset: r.asset_area ? { area: r.asset_area, key: r.asset_key! } : null,
    source: r.source_area ? { area: r.source_area, key: r.source_key! } : null, status: r.status, finding_fingerprint: r.finding_fingerprint,
    evidence_ref: r.evidence_ref, detail: r.detail ?? {} }));
}

/** Cancel a run of workspace `orgId`: a queued one ends now; a running one stops spending now and ends at its next heartbeat. */
export async function cancelRun(orgId: number, id: string, by: string | null = null): Promise<RunView> {
  const r = await asPlatform(async () => {
    const db = await getDb();
    const [x] = await db.query<RunRow>(
      `UPDATE runs SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              ended_at = CASE WHEN status = 'queued' THEN now() ELSE ended_at END,
              error_kind = CASE WHEN status = 'queued' THEN 'cancelled' ELSE error_kind END,
              cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING ${COLS}`, [orgId, String(id)]);
    return x ?? (await db.query<RunRow>(`SELECT ${COLS} FROM runs WHERE org_id = $1 AND id = $2`, [orgId, String(id)]))[0];
  });
  if (!r) throw new PackError("no such run", 404);
  // Spending stops now, whatever the runner does next.
  await asPlatform(() => revokeRunTokens(r.id));
  await event(r.id, orgId, r.attempt, "cancel_requested", { by });
  return view(r);
}

/** ctx.runs: this pack's runs for one workspace. */
export const workspaceRuns = (pack: string, orgId: number, requestedBy: string | null = null): WorkspaceRuns => ({
  start: (kind, input) => startRun(orgId, pack, kind, input ?? {}, requestedBy),
  get: async (id) => { const r = await getRun(orgId, id); return r && r.pack === pack ? r : null; },
  list: (opts) => listRuns(orgId, { pack, limit: opts?.limit }),
  results: async (id) => { const r = await getRun(orgId, id); if (!r || r.pack !== pack) throw new PackError("no such run", 404); return runResults(orgId, id); },
  cancel: async (id) => { const r = await getRun(orgId, id); if (!r || r.pack !== pack) throw new PackError("no such run", 404); return cancelRun(orgId, id, requestedBy); },
});

// ---------- the runner's side: claim, heartbeat, events, complete ----------

async function event(runId: string, orgId: number, attempt: number, type: string, data: Record<string, unknown> = {}, q?: Queryable) {
  await asPlatform(async () => (q ?? (await getDb())).query(
    "INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, $3, $4, $5)", [runId, orgId, attempt, type, JSON.stringify(data)]));
}

/** What a runner gets with a claimed run: everything it needs, no secret but its own lease and gateway tokens. */
export interface Claim {
  run: RunView & { org_id: number; spec: JobKind };
  lease_token: string;
  lease_seconds: number;
  lease_expires_at: string;
  deadline_at: string;
  gateway: { expires_at: string; env: Record<string, string>; providers: Record<string, { base_url: string }>; gateway_url: string };
  /** Hosts the run's egress proxy allows: the gateway's (when it is a public HTTPS host) and the kind's. */
  egress: { hosts: string[] };
}

/** Hosts a run may reach: the kind's own, plus the gateway's public host. An IP address or localhost is never listed. */
export function runEgressHosts(kindHosts: string[], gatewayUrl: string): string[] {
  const hosts = new Set(kindHosts.map((h) => h.replace(/^\*\./, "").toLowerCase()));
  try {
    const u = new URL(gatewayUrl);
    const h = u.hostname.toLowerCase();
    if (u.protocol === "https:" && !/^[\d.]+$/.test(h) && !h.includes(":") && h !== "localhost") hosts.add(h);
  } catch { /* no gateway host */ }
  return [...hosts].sort();
}

/**
 * Lapsed leases: a running run whose runner stopped heartbeating. Cancelled when asked; queued again when the
 * infrastructure may be at fault and attempts remain; else failed. A run past its deadline (its token expired) fails.
 */
export async function sweepRuns(): Promise<{ requeued: number; failed: number; cancelled: number }> {
  return asPlatform(async () => {
    const db = await getDb();
    const rows = await db.query<{ id: string; org_id: number; attempt: number; status: string; error_kind: string | null }>(
      `/* tenant: platform sweep of lapsed leases, every workspace */ UPDATE runs SET
          status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                        WHEN deadline_at < now() THEN 'failed'
                        WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
          error_kind = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN deadline_at < now() THEN 'timeout' ELSE 'infrastructure' END,
          error = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN deadline_at < now() THEN 'the run passed its deadline'
                       ELSE 'the runner stopped heartbeating (lease lapsed)' END,
          ended_at = CASE WHEN cancel_requested_at IS NULL AND deadline_at >= now() AND attempt < max_attempts THEN NULL ELSE now() END,
          worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status = 'running' AND lease_expires_at < now()
        RETURNING id, org_id, attempt, status, error_kind`);
    for (const r of rows) {
      await revokeRunTokens(r.id);
      await releaseWorkspace(r.id);
      await event(r.id, r.org_id, r.attempt, r.status === "queued" ? "retry" : r.status, { reason: "lease lapsed", error_kind: r.error_kind });
    }
    return { requeued: rows.filter((r) => r.status === "queued").length, failed: rows.filter((r) => r.status === "failed").length, cancelled: rows.filter((r) => r.status === "cancelled").length };
  });
}

/** The workspace store's lease for a run (mold_v0-033): released when the attempt ends. A no-op until the store exists. */
async function releaseWorkspace(_runId: string): Promise<void> {}

/**
 * Claim the oldest queued run of the given kinds ("pack/kind"; all when empty). Returns null when there is none.
 * The gateway token is minted after the claim commits; if that fails the run goes back to the queue unchanged.
 */
export async function claimRun(workerId: string, opts: { kinds?: string[] } = {}): Promise<Claim | null> {
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new PackError("worker_id: 1-100 letters, digits, . _ : -", 400);
  await sweepRuns();
  const kinds = (opts.kinds ?? []).filter((k) => typeof k === "string").slice(0, 50);
  const lease = `orl_${randomBytes(24).toString("base64url")}`;
  const row = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const candidates = await tx.query<{ id: string; org_id: number; pack: string; kind: string }>(
      `/* tenant: platform claim across workspaces (the workspace comes from the row) */ SELECT id, org_id, pack, kind FROM runs
        WHERE status = 'queued' AND ($1::text[] IS NULL OR pack || '/' || kind = ANY ($1::text[]))
        ORDER BY created_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`, [kinds.length ? kinds : null]);
    for (const c of candidates) {
      if (!findKind(c.pack, c.kind)) continue; // a kind this build no longer has: left queued for a build that has it
      const [r] = await tx.query<RunRow>(
        `/* tenant: the claimed run, by id */ UPDATE runs SET status = 'running', attempt = attempt + 1, worker_id = $2, lease_token_hash = $3,
                lease_expires_at = now() + make_interval(secs => lease_seconds), heartbeat_at = now(),
                deadline_at = now() + make_interval(secs => token_lifetime_seconds), started_at = coalesce(started_at, now()),
                error_kind = NULL, error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'queued' RETURNING ${COLS}`, [c.id, workerId, sha256(lease)]);
      if (r) return r;
    }
    return null;
  }));
  if (!row) return null;
  let gateway;
  try {
    gateway = await asPlatform(() => brokerRunCredentials(row.id, row.spec.providers ?? [], new Date(row.deadline_at!)));
  } catch (e) {
    // A provider the kind names but the vault does not serve is configuration, not an outage: the run fails, not retried.
    await complete(row.id, lease, { outcome: "failed", error_kind: "run", error: `gateway credentials: ${(e as Error).message}` });
    throw e;
  }
  await event(row.id, row.org_id, row.attempt, "claimed", { worker_id: workerId, deadline_at: iso(row.deadline_at) });
  return {
    run: { ...view(row), org_id: row.org_id, spec: row.spec },
    lease_token: lease, lease_seconds: row.lease_seconds, lease_expires_at: iso(row.lease_expires_at)!, deadline_at: iso(row.deadline_at)!,
    gateway: { expires_at: gateway.expires_at, env: gateway.env, providers: gateway.providers, gateway_url: gateway.gateway_url },
    egress: { hosts: runEgressHosts(row.egress ?? [], gateway.gateway_url) },
  };
}

/** The run, when `leaseToken` is its current attempt's lease and it is running; else a RunLeaseError. */
async function leased(q: Queryable, runId: string, leaseToken: unknown, lock = false): Promise<RunRow> {
  if (typeof leaseToken !== "string" || !leaseToken.startsWith("orl_")) throw new RunLeaseError("a run's lease token is required");
  const [r] = await q.query<RunRow>(
    `/* tenant: by run id and its lease token (the runner's only credential for it) */ SELECT ${COLS} FROM runs
      WHERE id = $1 AND lease_token_hash = $2 AND status = 'running'${lock ? " FOR UPDATE" : ""}`, [String(runId), sha256(leaseToken)]);
  if (!r) throw new RunLeaseError();
  return r;
}

/** Renew the lease. `cancel` is true once the run is cancelled or past its deadline: the runner stops and completes. */
export async function heartbeatRun(runId: string, leaseToken: string): Promise<{ lease_expires_at: string; cancel: boolean; reason: string | null }> {
  return asPlatform(async () => {
    const db = await getDb();
    const r = await leased(db, runId, leaseToken);
    const [u] = await db.query<{ lease_expires_at: Date }>(
      `/* tenant: the leased run, by id */ UPDATE runs SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => lease_seconds), updated_at = now()
        WHERE id = $1 AND lease_token_hash = $2 AND status = 'running' RETURNING lease_expires_at`, [r.id, sha256(leaseToken)]);
    if (!u) throw new RunLeaseError();
    await renewWorkspace(r.id, r.lease_seconds);
    const late = r.deadline_at && new Date(r.deadline_at).getTime() <= Date.now();
    return { lease_expires_at: iso(u.lease_expires_at)!, cancel: !!r.cancel_requested_at || !!late, reason: r.cancel_requested_at ? "cancelled" : late ? "deadline" : null };
  });
}
/** The workspace store's lease follows the run's (mold_v0-033). A no-op until the store exists. */
async function renewWorkspace(_runId: string, _seconds: number): Promise<void> {}

const EVENT_TYPE = /^[a-z][a-z0-9_.:-]{0,63}$/;
/** Append events (at most 500 per call, 16 KB each, 20 000 per run). */
export async function appendRunEvents(runId: string, leaseToken: string, events: unknown): Promise<{ appended: number }> {
  if (!Array.isArray(events) || events.length > 500) throw new PackError("events: a list of at most 500", 400);
  return asPlatform(async () => {
    const db = await getDb();
    const r = await leased(db, runId, leaseToken);
    const [{ n }] = await db.query<{ n: number }>("/* tenant: the leased run's own events */ SELECT count(*)::int AS n FROM run_events WHERE run_id = $1", [r.id]);
    if (n + events.length > 20_000) throw new PackError("this run has too many events (20 000)", 413);
    for (const e of events) {
      const type = (e as { type?: unknown })?.type, data = (e as { data?: unknown })?.data ?? {};
      if (typeof type !== "string" || !EVENT_TYPE.test(type)) throw new PackError("each event needs a type: lowercase letters, digits, . _ : -", 400);
      if (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024) throw new PackError("an event's data is at most 16 KB", 413);
    }
    for (const e of events as { type: string; data?: unknown }[]) await event(r.id, r.org_id, r.attempt, e.type, (e.data ?? {}) as Record<string, unknown>, db);
    return { appended: events.length };
  });
}

export interface Completion {
  outcome: "succeeded" | "failed";
  /** For a failure: infrastructure (retried while attempts remain), run, validation or timeout. */
  error_kind?: "infrastructure" | "run" | "validation" | "timeout";
  error?: string;
  results?: unknown[];
}

const STATUSES = new Set(["pass", "fail", "error", "not_applicable", "unknown"]);
const FINGERPRINT = /^[A-Za-z0-9:_.\-/]{1,160}$/;
type Ref = { area: string; key: string };
const refOf = (v: unknown, what: string): Ref | null => {
  if (v === undefined || v === null) return null;
  const r = v as Ref;
  if (!r || typeof r.area !== "string" || typeof r.key !== "string") throw new PackError(`${what} must be {area, key}`, 400);
  return { area: r.area, key: r.key };
};

/**
 * A result's references, checked before anything is written: the check, asset and source each name a declared area
 * of that role and a record that exists for this run's workspace (its own rows of a workspace area, or a shared row).
 * An asset is always the workspace's own: a run can never point a finding at another workspace's records.
 */
async function checkResults(q: Queryable, orgId: number, results: unknown[]) {
  if (results.length > 5000) throw new PackError("at most 5000 results per run", 413);
  const exists = new Map<string, boolean>();
  const has = async (want: "check" | "asset" | "source", ref: Ref) => {
    const area = findArea(ref.area);
    if (!area || area.role !== want) throw new PackError(`result: ${ref.area} is not a ${want} area`, 400);
    const id = `${ref.area}\u0000${ref.key}`;
    if (!exists.has(id)) {
      const rows = area.scope === "platform"
        ? await q.query("SELECT 1 FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3", [area.pack, area.name, ref.key])
        : await q.query("SELECT 1 FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4", [orgId, area.pack, area.name, ref.key]);
      exists.set(id, rows.length > 0);
    }
    if (!exists.get(id)) throw new PackError(`result: no ${want} record ${ref.key} in ${ref.area}${area.scope === "workspace" ? " for this run's workspace" : ""}`, 400);
  };
  const out = [];
  for (const raw of results) {
    const x = raw as Record<string, unknown>;
    const check = refOf(x?.check, "check"), asset = refOf(x?.asset, "asset"), source = refOf(x?.source, "source");
    if (!check) throw new PackError("each result names its check {area, key}", 400);
    if (typeof x.status !== "string" || !STATUSES.has(x.status)) throw new PackError("result status: pass, fail, error, not_applicable or unknown", 400);
    const fp = x.finding_fingerprint ?? null, ev = x.evidence_ref ?? null;
    if (fp !== null && (typeof fp !== "string" || !FINGERPRINT.test(fp))) throw new PackError("finding_fingerprint: 1-160 letters, digits, : _ . - /", 400);
    if (ev !== null && (typeof ev !== "string" || ev.length > 500 || /[\u0000-\u001f]/.test(ev))) throw new PackError("evidence_ref: up to 500 characters", 400);
    const detail = jsonObject(x.detail, "detail");
    if (Buffer.byteLength(JSON.stringify(detail)) > 16 * 1024) throw new PackError("a result's detail is at most 16 KB", 413);
    await has("check", check);
    if (asset) await has("asset", asset);
    if (source) await has("source", source);
    out.push({ check, asset, source, status: x.status, fp, ev, detail });
  }
  return out;
}

/** End the current attempt (the lease holder only). Returns the run as it now stands. */
export async function completeRun(runId: string, leaseToken: string, c: Completion): Promise<RunView> {
  return complete(runId, leaseToken, c);
}

async function complete(runId: string, leaseToken: string, c: Completion): Promise<RunView> {
  if (c?.outcome !== "succeeded" && c?.outcome !== "failed") throw new PackError("outcome: succeeded or failed", 400);
  const usage = await asPlatform(() => runGatewayUsage(String(runId)));
  const r = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const run = await leased(tx, runId, leaseToken, true);
    let status: RunView["status"], kind: string | null = null, error: string | null = null;
    if (run.cancel_requested_at) { status = "cancelled"; kind = "cancelled"; error = "cancelled"; }
    else if (c.outcome === "succeeded") {
      const results = await checkResults(tx, run.org_id, Array.isArray(c.results) ? c.results : []);
      for (const x of results)
        await tx.query(
          `INSERT INTO run_results (run_id, org_id, check_area, check_key, asset_area, asset_key, source_area, source_key, status, finding_fingerprint, evidence_ref, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [run.id, run.org_id, x.check.area, x.check.key, x.asset?.area ?? null, x.asset?.key ?? null, x.source?.area ?? null, x.source?.key ?? null,
           x.status, x.fp, x.ev, JSON.stringify(x.detail)]);
      status = "succeeded";
    } else {
      kind = ["infrastructure", "run", "validation", "timeout"].includes(String(c.error_kind)) ? String(c.error_kind) : "run";
      error = String(c.error ?? "").slice(0, 2000) || null;
      status = kind === "infrastructure" && run.attempt < run.max_attempts ? "queued" : "failed";
    }
    const [u] = await tx.query<RunRow>(
      `/* tenant: the leased run, by id */ UPDATE runs SET status = $2, error_kind = $3, error = $4, cost_usd = $5,
              ended_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
              worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`, [run.id, status, kind, error, usage.cost_usd]);
    await event(run.id, run.org_id, run.attempt, status === "queued" ? "retry" : status, { error_kind: kind, error, cost_usd: usage.cost_usd }, tx);
    return u!;
  }));
  await asPlatform(() => revokeRunTokens(r.id));
  await releaseWorkspace(r.id);
  return view(r);
}
