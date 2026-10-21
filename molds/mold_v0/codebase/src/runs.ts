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
import { AgentJobKindSchema, JobKindSchema, PackError, z, type RunResultRow, type RunView, type WorkspaceCommitContext, type WorkspaceFile, type WorkspaceRuns } from "./pack-api.js";
import { packs } from "./packs.js";
import { findArea } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { acquireLease, commitStaged, endAttempt, latestSnapshot, openSnapshot, removeObjects, renewLease } from "./workspace-store.js";
import { EMPTY_MANIFEST_SHA256, readBundle } from "./workspace-bundle.js";
import type { Secret } from "./credential-redact.js";
import { redactJson, redactText } from "./credential-redact.js";
import { runCredentials, runSecrets, type RunCredentials } from "./credentials.js";
import { checkRunStart, maxRunConcurrency, underConcurrency } from "./run-limits.js";

/** A job kind: a program of the pack's own (jobKinds) or an agent repository at a pin (agentJobKinds, mold_v0-061). */
export type JobKind = (z.output<typeof JobKindSchema> | z.output<typeof AgentJobKindSchema>) & { pack: string };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let cache: { from: unknown; kinds: JobKind[] } | null = null;
/** Every job kind the packs declare (the definition checked by definePack; names are unique within a pack). */
export function jobKinds(): JobKind[] {
  const list = packs();
  if (cache?.from === list) return cache.kinds;
  cache = { from: list, kinds: list.flatMap((p) => [
    ...(p.definition.jobKinds ?? []).map((k): JobKind => ({ ...JobKindSchema.parse(k), pack: p.id })),
    ...(p.definition.agentJobKinds ?? []).map((k): JobKind => ({ ...AgentJobKindSchema.parse(k), pack: p.id })),
  ]) };
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

/**
 * Queue a run of `pack`'s job kind for workspace `orgId` (the caller's own workspace, from its session). When the
 * caller is a signed-in person (`org.userId`), the account's own launch rules apply first (src/limits.ts checkRun:
 * a viewer cannot launch, a blocked member or account cannot, the account's allowance and concurrency); when it is
 * platform staff acting for the workspace (`org.staff`, mold_v0-067), the account's rules with no person (checkAccountRun).
 */
export async function startRun(orgId: number, pack: string, kind: string, input: { scope?: unknown; targets?: unknown } = {}, requestedBy: string | null = null,
                               org?: import("./auth.js").Org): Promise<RunView> {
  const k = findKind(pack, kind);
  if (!k) throw new PackError(`pack ${pack} has no job kind ${JSON.stringify(String(kind).slice(0, 64))}`, 404);
  const scope = jsonObject(input.scope, "scope"), targets = jsonObject(input.targets, "targets");
  if (org?.userId) {
    const { checkRun, LimitError } = await import("./limits.js");
    try { await asPlatform(() => checkRun(org)); }
    catch (e) { if (e instanceof LimitError) throw new PackError(e.message, (e as { status?: number }).status ?? 403); throw e; }
  } else if (org?.staff) {
    // Staff starting a run for the workspace (mold_v0-067): the account's own launch rules, with no person.
    const { checkAccountRun, LimitError } = await import("./limits.js");
    try { await asPlatform(() => checkAccountRun(org)); }
    catch (e) { if (e instanceof LimitError) throw new PackError(e.message, (e as { status?: number }).status ?? 403); throw e; }
  }
  const [{ n }] = await asPlatform(async () => (await getDb()).query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runs WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]));
  // Limits (mold_v0-018, 053; src/run-limits.ts): the workspace's live runs, the kind's month budget, the account's
  // allowance; the run's budget is the kind's, never above the platform's ceiling.
  const { budget_usd, live_per_workspace } = await checkRunStart(orgId, pack, kind, k, n);
  const id = `run_${randomBytes(12).toString("base64url")}`;
  // The tenant role may only read runs: the row is written by the platform, with the workspace the caller is scoped to.
  // The live cap is counted again with the insert, under a lock per workspace, so concurrent starts (a scheduler's
  // ticks, many tool calls at once) cannot pass it together (mold_v0-018).
  const [r] = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`runs-live:${orgId}`]);
    const [{ live }] = await tx.query<{ live: number }>("SELECT count(*)::int AS live FROM runs WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]);
    if (live >= live_per_workspace)
      throw new PackError(`this workspace already has ${live} runs queued or running (at most ${live_per_workspace}): wait for some to finish`, 429);
    return tx.query<RunRow>(
      `INSERT INTO runs (id, org_id, pack, kind, scope, targets, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, egress, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLS}`,
      [id, orgId, pack, kind, JSON.stringify(scope), JSON.stringify(targets), JSON.stringify(k), k.max_attempts, k.token_lifetime_seconds,
       k.lease_seconds, budget_usd, k.egress.map((h) => h.replace(/^\*\./, "").toLowerCase()), requestedBy]);
  }));
  await event(id, orgId, 0, "queued", { kind, requested_by: requestedBy });
  // On Vercel nothing ticks between crons: the run's sandbox is launched now (mold_v0-055; a server's loop ticks itself).
  if (process.env.VERCEL) void import("./autoscaler.js").then((a) => import("./telemetry.js").then((t) => t.keepAlive(a.kickAutoscaler().catch(() => null)))).catch(() => {});
  return view(r!);
}

export async function getRun(orgId: number, id: string): Promise<RunView | null> {
  const [r] = await (await getDb()).query<RunRow>(`SELECT ${COLS} FROM runs WHERE org_id = $1 AND id = $2`, [orgId, String(id)]);
  return r ? view(r) : null;
}
export async function listRuns(orgId: number, opts: { pack?: string; kind?: string; limit?: number } = {}): Promise<RunView[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const rows = await (await getDb()).query<RunRow>(
    `SELECT ${COLS} FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR pack = $2) AND ($4::text IS NULL OR kind = $4) ORDER BY created_at DESC, id DESC LIMIT $3`,
    [orgId, opts.pack ?? null, limit, opts.kind ?? null]);
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
export const workspaceRuns = (pack: string, orgId: number, requestedBy: string | null = null, org?: import("./auth.js").Org): WorkspaceRuns => ({
  start: (kind, input) => startRun(orgId, pack, kind, input ?? {}, requestedBy, org),
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
  /** `token`: the run's gateway token itself (also in `env`), for an agent-workspace kind's declared variables (mold_v0-061). */
  gateway: { expires_at: string; env: Record<string, string>; providers: Record<string, { base_url: string }>; gateway_url: string; token: string | null };
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
  const gone: string[] = [];
  const out = await asPlatform(async () => (await getDb()).transaction(async (db) => {
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
    // In the same transaction as the status change: no later attempt can be claimed before its tokens and lease are gone.
    for (const r of rows) {
      await revokeRunTokens(r.id, db);
      gone.push(...(await endAttempt(db, r.id)));
      await event(r.id, r.org_id, r.attempt, r.status === "queued" ? "retry" : r.status, { reason: "lease lapsed", error_kind: r.error_kind }, db);
    }
    return { requeued: rows.filter((r) => r.status === "queued").length, failed: rows.filter((r) => r.status === "failed").length, cancelled: rows.filter((r) => r.status === "cancelled").length };
  }));
  await removeObjects(gone);
  return out;
}

/**
 * Claim the oldest queued run of the given kinds ("pack/kind"; all when empty). Returns null when there is none.
 * The gateway token is minted after the claim commits; if that fails the run goes back to the queue unchanged.
 */
export async function claimRun(workerId: string, opts: { kinds?: string[]; runId?: string } = {}): Promise<Claim | null> {
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)) throw new PackError("worker_id: 1-100 letters, digits, . _ : -", 400);
  await sweepRuns();
  // A run sandbox (mold_v0-055) claims only the run it was launched for.
  const only = opts.runId === undefined ? null : String(opts.runId);
  // Only kinds this build has (a run of a kind it lacks waits for a build that has it), and only those asked for.
  const known = jobKinds().map((k) => `${k.pack}/${k.name}`);
  const asked = (opts.kinds ?? []).filter((k) => typeof k === "string").slice(0, 50);
  const kinds = asked.length ? known.filter((k) => asked.includes(k)) : known;
  if (!kinds.length) return null;
  const lease = `orl_${randomBytes(24).toString("base64url")}`;
  const row = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const candidates = await tx.query<{ id: string; org_id: number; pack: string; kind: string; workspace: boolean; lease_seconds: number; concurrency: number | null }>(
      `/* tenant: platform claim across workspaces (the workspace comes from the row) */ SELECT id, org_id, pack, kind,
              coalesce((spec->>'workspace')::boolean, false) AS workspace, lease_seconds, (spec->>'concurrency_per_workspace')::int AS concurrency FROM runs
        WHERE status = 'queued' AND pack || '/' || kind = ANY ($1::text[]) AND ($3::text IS NULL OR id = $3)
          -- One writer per workspace store: a run whose store another live run holds is not even a candidate, so a
          -- workspace with many queued runs never hides other workspaces' runs behind its own.
          AND NOT (coalesce((spec->>'workspace')::boolean, false) AND EXISTS (SELECT 1 FROM workspace_leases l
                   WHERE l.org_id = runs.org_id AND l.store = runs.pack AND l.expires_at > now() AND l.run_id <> runs.id))
          -- Nor one whose workspace already runs its kind's concurrency (mold_v0-018; rechecked under a lock below).
          AND (SELECT count(*) FROM runs x WHERE x.org_id = runs.org_id AND x.pack = runs.pack AND x.kind = runs.kind AND x.status = 'running')
              < LEAST(coalesce((spec->>'concurrency_per_workspace')::int, $2), $2)
        ORDER BY created_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`, [kinds, maxRunConcurrency(), only]);
    for (const c of candidates) {
      if (!findKind(c.pack, c.kind)) continue; // a kind this build no longer has: left queued for a build that has it
      // The kind's concurrency in this workspace (mold_v0-018): over it, the run waits in the queue.
      if (!(await underConcurrency(tx, c))) continue;
      // One writer per workspace store (mold_v0-033): while another run of this workspace and pack holds the store's
      // lease, this one waits in the queue.
      if (c.workspace && !(await acquireLease(tx, c.org_id, c.pack, c.id, c.lease_seconds))) continue;
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
    gateway: { expires_at: gateway.expires_at, env: gateway.env, providers: gateway.providers, gateway_url: gateway.gateway_url, token: gateway.token ?? null },
    egress: { hosts: runEgressHosts(row.egress ?? [], gateway.gateway_url) },
  };
}

/** A queued run the autoscaler may launch a sandbox for (mold_v0-055): what a claim would take now. */
export interface ClaimableRun { id: string; org_id: number; pack: string; kind: string; attempt: number; token_lifetime_seconds: number; lease_seconds: number; created_at: Date }

/**
 * Queued runs a claim would take now, oldest first (mold_v0-055: the autoscaler's run demand): of a kind this build has,
 * whose workspace store no other live run holds, and under the kind's concurrency in its workspace and the platform's
 * ceiling (mold_v0-018), as claimRun's own candidates. Counts and ids only; nothing is locked or changed.
 */
export async function claimableRuns(limit = 200): Promise<ClaimableRun[]> {
  const known = jobKinds().map((k) => `${k.pack}/${k.name}`);
  if (!known.length) return [];
  const rows = await asPlatform(async () => (await getDb()).query<ClaimableRun & { workspace: boolean; running: number; cap: number }>(
    `/* tenant: internal: the autoscaler's run demand across workspaces, ids go to the run's own sandbox only */
     SELECT id, org_id, pack, kind, attempt, token_lifetime_seconds, lease_seconds, created_at,
            coalesce((spec->>'workspace')::boolean, false) AS workspace,
            (SELECT count(*)::int FROM runs x WHERE x.org_id = runs.org_id AND x.pack = runs.pack AND x.kind = runs.kind AND x.status = 'running') AS running,
            LEAST(coalesce((spec->>'concurrency_per_workspace')::int, $2), $2) AS cap
       FROM runs
      WHERE status = 'queued' AND pack || '/' || kind = ANY ($1::text[]) AND cancel_requested_at IS NULL
        AND NOT (coalesce((spec->>'workspace')::boolean, false) AND EXISTS (SELECT 1 FROM workspace_leases l
                 WHERE l.org_id = runs.org_id AND l.store = runs.pack AND l.expires_at > now() AND l.run_id <> runs.id))
      ORDER BY created_at, id LIMIT $3`, [known, maxRunConcurrency(), Math.max(1, Math.min(limit, 1000))]));
  // As a claim would see them one after another: no more of a workspace's queued runs of a kind than it may still run
  // at once, and one run per workspace store (mold_v0-018, 033). A sandbox launched past that would only wait.
  const taken = new Map<string, number>(), stores = new Set<string>();
  const out: ClaimableRun[] = [];
  for (const r of rows) {
    if (!findKind(r.pack, r.kind)) continue;
    const key = `${r.org_id}/${r.pack}/${r.kind}`, n = taken.get(key) ?? 0;
    if (Number(r.running) + n >= Number(r.cap)) continue;
    if (r.workspace) { const st = `${r.org_id}/${r.pack}`; if (stores.has(st)) continue; stores.add(st); }
    taken.set(key, n + 1);
    out.push({ id: r.id, org_id: r.org_id, pack: r.pack, kind: r.kind, attempt: r.attempt, token_lifetime_seconds: r.token_lifetime_seconds,
               lease_seconds: r.lease_seconds, created_at: r.created_at });
  }
  return out;
}

/** Queued runs per kind ("pack/kind"), claimable or not (the autoscaler's demand, reported per kind). */
export async function queuedRunsByKind(): Promise<Record<string, number>> {
  const rows = await asPlatform(async () => (await getDb()).query<{ k: string; n: number }>(
    "/* tenant: internal: counts per kind across workspaces, counts only */ SELECT pack || '/' || kind AS k, count(*)::int AS n FROM runs WHERE status = 'queued' GROUP BY 1 ORDER BY 1"));
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}

/**
 * A queued run whose sandbox could not be started, again and again (mold_v0-055): it fails with that reason rather than
 * waiting forever (or launching forever). Only while it is still queued; a run claimed meanwhile is left alone.
 */
export async function failUnlaunchedRun(runId: string, reason: string): Promise<boolean> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number; attempt: number }>(
    `/* tenant: internal, by run id (the autoscaler's launch bookkeeping) */ UPDATE runs SET status = 'failed', error_kind = 'infrastructure', error = $2,
            ended_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id, org_id, attempt`, [runId, reason.slice(0, 2000)]));
  if (r) await event(r.id, r.org_id, r.attempt, "failed", { error_kind: "infrastructure", error: reason.slice(0, 2000) });
  return !!r;
}

/**
 * Say once on each queued run why it waits (mold_v0-055): no sandbox to run it in. A `waiting` event with the reason,
 * written only when the run's last such event gave another reason (or none was written). Returns how many were noted.
 */
export async function noteRunsWaiting(reason: string, limit = 200): Promise<number> {
  const rows = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number; attempt: number }>(
    `/* tenant: internal: the autoscaler notes why queued runs wait, on each run's own row */
     SELECT r.id, r.org_id, r.attempt FROM runs r WHERE r.status = 'queued'
        AND coalesce((SELECT e.data->>'reason' FROM run_events e WHERE e.run_id = r.id AND e.type = 'waiting' ORDER BY e.id DESC LIMIT 1), '') <> $1
      ORDER BY r.created_at LIMIT $2`, [reason, limit]));
  for (const r of rows) await event(r.id, r.org_id, r.attempt, "waiting", { reason });
  return rows.length;
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

/** The running run behind a lease token (the workspace store's checkout and stage, src/workspace-store.ts). */
export const leasedRun = (runId: string, leaseToken: string) => asPlatform(async () => leased(await getDb(), runId, leaseToken));

/**
 * The workspace credentials a running run receives (mold_v0-034; src/credentials.ts): only for the lease holder, only
 * the fields its kind names, only the values of the run row's own workspace bound to what the run targets. The run's
 * events record which names were delivered and which were missing, never a value.
 */
export async function runCredentialsForLease(runId: string, leaseToken: string): Promise<RunCredentials> {
  const r = await leasedRun(runId, leaseToken);
  const out = await runCredentials(r);
  if (r.spec?.credentials?.length)
    await event(r.id, r.org_id, r.attempt, "credentials", { delivered: out.credentials.map((c) => c.name), missing: out.missing });
  return out;
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
/** The workspace store's lease follows the run's (mold_v0-033). */
const renewWorkspace = (runId: string, seconds: number) => renewLease(runId, seconds);

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
    // A value the run received never lands in its events, whatever the program printed (mold_v0-034).
    const secrets = await runSecrets(r);
    for (const e of events as { type: string; data?: unknown }[])
      await event(r.id, r.org_id, r.attempt, redactText(e.type, secrets) === e.type ? e.type : "redacted", redactJson((e.data ?? {}) as Record<string, unknown>, secrets), db);
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

/** What happened to a result that named a record the run's workspace does not have (mold_v0-065). */
export interface Unresolved {
  check: Ref; asset: Ref | null; source: Ref | null; status: string; finding_fingerprint: string | null;
  missing: ("check" | "asset" | "source")[]; action: "dropped" | "downgraded"; reason?: string;
}
type CheckedResult = { check: Ref; asset: Ref | null; source: Ref | null; status: string; fp: string | null; ev: string | null; detail: Record<string, unknown> };

/**
 * A result's references, checked before anything is written: the check, asset and source each name a declared area
 * of that role and a record that exists for this run's workspace (its own rows of a workspace area, or a shared row).
 * An asset is always the workspace's own: a run can never point a finding at another workspace's records.
 *
 * A result's identity (mold_v0-065) is check x asset x source x finding fingerprint: several findings on one triple
 * stay separate rows when their fingerprints differ; the same identity twice is refused (a run that cannot tell two
 * findings apart must fold them itself). A reference to a record that does not exist is handled as the kind says
 * (`unresolved_references`): "reject" refuses the run's results; "drop" leaves the result out; "downgrade" clears a
 * missing asset or source (kept, as written, in detail.unresolved) and drops a result whose check is missing. More
 * than `max_unresolved` such results refuse the run's results whatever the mode. A reference to an area that is not
 * declared or not of its role is always refused: that is the pack's mistake, never the data's.
 */
async function checkResults(q: Queryable | null, orgId: number, results: unknown[], kind: { unresolved_references?: string; max_unresolved?: number } = {}) {
  if (results.length > 5000) throw new PackError("at most 5000 results per run", 413);
  const mode = kind.unresolved_references === "drop" || kind.unresolved_references === "downgrade" ? kind.unresolved_references : "reject";
  const maxUnresolved = kind.max_unresolved ?? 100;
  const exists = new Map<string, boolean>();
  /** Does the record exist for this run's workspace? A wrong area or role throws whatever the mode. */
  const has = async (want: "check" | "asset" | "source", ref: Ref): Promise<boolean> => {
    const area = findArea(ref.area);
    if (!area || area.role !== want) throw new PackError(`result: ${ref.area} is not a ${want} area`, 400);
    // No database (the dry pass before a workspace hook): everything but existence is checked.
    if (!q) return true;
    const id = `${ref.area}\u0000${ref.key}`;
    if (!exists.has(id)) {
      const rows = area.scope === "platform"
        ? await q.query("SELECT 1 FROM platform_records WHERE pack = $1 AND area = $2 AND key = $3", [area.pack, area.name, ref.key])
        : await q.query("SELECT 1 FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4", [orgId, area.pack, area.name, ref.key]);
      exists.set(id, rows.length > 0);
    }
    if (!exists.get(id) && mode === "reject")
      throw new PackError(`result: no ${want} record ${ref.key} in ${ref.area}${area.scope === "workspace" ? " for this run's workspace" : ""}`, 400);
    return exists.get(id)!;
  };
  const notes: { at: number; u: Unresolved }[] = [];
  const kept: { at: number; row: CheckedResult; id: string; downgraded: boolean; note: (action: Unresolved["action"], reason?: string) => void }[] = [];
  for (const [at, raw] of results.entries()) {
    const x = raw as Record<string, unknown>;
    const check = refOf(x?.check, "check");
    let asset = refOf(x?.asset, "asset"), source = refOf(x?.source, "source");
    if (!check) throw new PackError("each result names its check {area, key}", 400);
    if (typeof x.status !== "string" || !STATUSES.has(x.status)) throw new PackError("result status: pass, fail, error, not_applicable or unknown", 400);
    const fp = x.finding_fingerprint ?? null, ev = x.evidence_ref ?? null;
    if (fp !== null && (typeof fp !== "string" || !FINGERPRINT.test(fp))) throw new PackError("finding_fingerprint: 1-160 letters, digits, : _ . - /", 400);
    if (ev !== null && (typeof ev !== "string" || ev.length > 500 || /[\u0000-\u001f]/.test(ev))) throw new PackError("evidence_ref: up to 500 characters", 400);
    let detail = jsonObject(x.detail, "detail");
    if (Buffer.byteLength(JSON.stringify(detail)) > 16 * 1024) throw new PackError("a result's detail is at most 16 KB", 413);
    const missing: Unresolved["missing"] = [];
    if (!(await has("check", check))) missing.push("check");
    if (asset && !(await has("asset", asset))) missing.push("asset");
    if (source && !(await has("source", source))) missing.push("source");
    const note = (action: Unresolved["action"], reason?: string) => notes.push({ at, u: { check, asset: refOf(x.asset, "asset"), source: refOf(x.source, "source"), status: x.status as string,
      finding_fingerprint: fp as string | null, missing, action, ...(reason ? { reason } : {}) } });
    let downgraded = false;
    if (missing.length) {
      if (mode === "drop" || missing.includes("check")) { note("dropped"); continue; }
      // downgrade: the missing references are cleared; what the run wrote is kept in the result's detail.
      detail = { ...detail, unresolved: Object.fromEntries(missing.map((m) => [m, m === "asset" ? asset : source])) };
      if (missing.includes("asset")) asset = null;
      if (missing.includes("source")) source = null;
      if (Buffer.byteLength(JSON.stringify(detail)) > 16 * 1024) { note("dropped", "detail too large once downgraded"); continue; }
      downgraded = true;
    }
    const id = JSON.stringify([check.area, check.key, asset?.area ?? "", asset?.key ?? "", source?.area ?? "", source?.key ?? "", fp ?? ""]);
    kept.push({ at, row: { check, asset, source, status: x.status, fp: fp as string | null, ev: ev as string | null, detail }, id, downgraded, note });
  }
  // Identity, whatever the order: results as written first (the same one twice is refused), then the downgraded ones
  // (one that became the same as another result is dropped, and said so).
  const seen = new Set<string>();
  const out: { at: number; row: CheckedResult }[] = [];
  for (const k of [...kept.filter((k) => !k.downgraded), ...kept.filter((k) => k.downgraded)]) {
    if (seen.has(k.id)) {
      if (k.downgraded) { k.note("dropped", "the same as another result once downgraded"); continue; }
      const r = k.row;
      throw new PackError(`result: check ${r.check.key} x ${r.asset?.key ?? "no asset"} x ${r.source?.key ?? "no source"}${r.fp ? ` x finding ${r.fp}` : ""} is listed twice`, 400);
    }
    seen.add(k.id);
    if (k.downgraded) k.note("downgraded");
    out.push({ at: k.at, row: k.row });
  }
  const unresolved = notes.sort((x, y) => x.at - y.at).map((n) => n.u);
  if (unresolved.length > maxUnresolved)
    throw new PackError(`results: ${unresolved.length} name records that do not exist for this run's workspace (this kind accepts at most ${maxUnresolved})`, 400);
  return { rows: out.sort((x, y) => x.at - y.at).map((o) => o.row), unresolved };
}

/** A pack whose areas read the workspace store's files (mold_v0-059): the shell re-indexes them after each commit. */
const indexesFiles = (pack: string) => Object.values(packs().find((p) => p.id === pack)?.definition.repositories ?? {}).some((r) => (r as { kind?: string })?.kind === "workspace_files");
/** A run whose pack indexes its workspace after each commit (mold_v0-064; the shell's own index, mold_v0-059). */
const withHook = (r: RunRow | null) => !!r?.spec?.workspace && (typeof packs().find((p) => p.id === r.pack)?.definition.onWorkspaceCommit === "function" || indexesFiles(r.pack));

/** End the current attempt (the lease holder only). Returns the run as it now stands. */
export async function completeRun(runId: string, leaseToken: string, c: Completion): Promise<RunView> {
  return complete(runId, leaseToken, c);
}

/** The start of a run's error when the shell's index of its workspace files refused the commit (mold_v0-059). */
const INDEX_REFUSED = "the index of the workspace's files refused the commit: ";
/** How long a pack's onWorkspaceCommit hook may take (mold_v0-064). */
const hookSeconds = () => Math.min(Math.max(Number(process.env.OCTILLION_WORKSPACE_HOOK_SECONDS ?? 120) || 120, 1), 1800);

/**
 * mold_v0-064: a succeeded workspace run of a pack with onWorkspaceCommit. Its snapshot is committed first, in its own
 * transaction (the run still running, its lease and its store's lease extended for the hook); then the hook indexes the
 * committed files for the run's own workspace; then the completion checks the results (which may name what the hook
 * indexed). Returns the run when the commit itself ended the attempt (a conflict), else what the completion needs.
 */
async function commitThenHook(runId: string, leaseToken: string, secrets: Secret[], cost: number): Promise<{ done: RunRow; gone: string[] } | { committed: boolean; hookError: string | null }> {
  const gone: string[] = [];
  const first = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const run = await leased(tx, runId, leaseToken, true);
    if (run.cancel_requested_at) return { skip: true as const };
    const wb = await commitStaged(tx, run);
    if (wb === "conflict") {
      const status = run.attempt < run.max_attempts ? "queued" : "failed", kind = "infrastructure";
      const error = "the workspace changed after this run checked it out: retried from a fresh checkout";
      const [u] = await tx.query<RunRow>(
        `/* tenant: the leased run, by id */ UPDATE runs SET status = $2, error_kind = $3, error = $4, cost_usd = $5, ended_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
                worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [run.id, status, kind, error, cost]);
      await event(run.id, run.org_id, run.attempt, status === "queued" ? "retry" : status, { error_kind: kind, error }, tx);
      await revokeRunTokens(run.id, tx); gone.push(...(await endAttempt(tx, run.id)));
      return { done: u as RunRow };
    }
    if (wb) await event(run.id, run.org_id, run.attempt, "workspace_written", wb, tx);
    // The hook's time on top of the leases: neither the run nor its store is taken over while it indexes.
    await tx.query(`/* tenant: the leased run, by id */ UPDATE runs SET lease_expires_at = now() + make_interval(secs => lease_seconds + $2) WHERE id = $1`, [run.id, hookSeconds() + 30]);
    await tx.query(`/* tenant: the leased run's own store lease */ UPDATE workspace_leases SET expires_at = now() + make_interval(secs => $2) WHERE run_id = $1`, [run.id, run.lease_seconds + hookSeconds() + 30]);
    return { run, wb };
  }));
  if ("skip" in first) return { committed: false, hookError: null };
  if ("done" in first && first.done) return { done: first.done, gone };
  const { run, wb } = first;
  if (!wb) return { committed: false, hookError: null }; // nothing staged: no snapshot to hand the hook
  const def = packs().find((p) => p.id === run.pack)?.definition;
  const hook = def?.onWorkspaceCommit;
  const index = indexesFiles(run.pack);
  if (!hook && !index) return { committed: true, hookError: null };
  try {
    const snap = await asPlatform(async () => latestSnapshot(await getDb(), run.org_id, run.pack));
    // No version yet (a first run that wrote an empty workspace): the empty workspace, version 0.
    const files: WorkspaceFile[] = snap ? readBundle(await openSnapshot(snap)).files.map((f) => ({ path: f.path, size: f.body.length, sha256: snap.manifest[f.path]!.sha256, body: f.body })) : [];
    // The shell's own index first (mold_v0-059): the areas fed by the workspace's files, for the run's own workspace,
    // all-or-nothing; then the pack's hook sees them indexed. A refused index fails the run as a failed hook does.
    if (index) {
      const { indexWorkspaceFiles } = await import("./data-repositories.js");
      const reports = await indexWorkspaceFiles(run.org_id, run.pack, files).catch((e) => { throw new Error(`${INDEX_REFUSED}${String((e as Error)?.message ?? e)}`); });
      await event(run.id, run.org_id, run.attempt, "workspace_indexed", { version: snap?.version ?? 0, repositories: reports.map((x) => ({ repository: x.repository, areas: x.areas })) });
    }
    if (!hook) return { committed: true, hookError: null };
    // The run's own workspace, from the run row: the hook's records, database and files are that workspace's only.
    const [org] = await asPlatform(async () => (await getDb()).query<{ slug: string; name: string | null }>("SELECT slug, name FROM organizations WHERE id = $1", [run.org_id]));
    const { workspaceDb } = await import("./packs.js");
    const { workspaceRecords } = await import("./record-areas.js");
    // Handles that stop working when the hook's time is up: a hook still going after it cannot write on.
    let live = true;
    const alive = <T>(f: () => T): T => { if (!live) throw new Error("the workspace hook's time is up: refused"); return f(); };
    const db = workspaceDb(run.org_id), recs = workspaceRecords(run.pack, run.org_id);
    const ctx: WorkspaceCommitContext = {
      pack: run.pack, workspace: { id: run.org_id, slug: org?.slug ?? "", name: org?.name ?? null, userId: null, role: null },
      db: { query: (sql, params) => alive(() => db.query(sql, params)) },
      records: { list: (a, o) => alive(() => recs.list(a, o)), get: (a, k) => alive(() => recs.get(a, k)), put: (a, k, v) => alive(() => recs.put(a, k, v)),
        move: (a, k, t) => alive(() => recs.move(a, k, t)), delete: (a, k) => alive(() => recs.delete(a, k)), batch: (ops) => alive(() => recs.batch(ops)) },
      run: { id: run.id, kind: run.kind, attempt: run.attempt, scope: run.scope ?? {}, targets: run.targets ?? {} },
      snapshot: { version: snap?.version ?? 0, changed: !wb.unchanged, manifest_sha256: snap?.manifest_sha256 ?? EMPTY_MANIFEST_SHA256 },
    };
    let timer: NodeJS.Timeout | undefined;
    await withTenant(run.org_id, () => Promise.race([
      Promise.resolve().then(() => hook(ctx, files)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`it took longer than ${hookSeconds()} s`)), hookSeconds() * 1000); }),
    ])).finally(() => { clearTimeout(timer); live = false; });
    await event(run.id, run.org_id, run.attempt, "workspace_hook", { version: snap?.version ?? 0, files: files.length });
    return { committed: true, hookError: null };
  } catch (e) {
    const msg = redactText(String((e as Error)?.message ?? e).slice(0, 1000), secrets);
    await event(run.id, run.org_id, run.attempt, "workspace_hook_failed", { error: msg, snapshot: "kept: it is committed and passed the run's validation" });
    return { committed: true, hookError: msg };
  }
}

async function complete(runId: string, leaseToken: string, c0: Completion): Promise<RunView> {
  if (c0?.outcome !== "succeeded" && c0?.outcome !== "failed") throw new PackError("outcome: succeeded or failed", 400);
  // Nor in its results or its error (mold_v0-034): redacted before they are checked and written.
  const runRow = await asPlatform(async () =>
    (await (await getDb()).query<RunRow>(`/* tenant: by run id, for its own credentials */ SELECT ${COLS} FROM runs WHERE id = $1`, [String(runId)]))[0] ?? null);
  const secrets = runRow ? await runSecrets(runRow) : [];
  const c: Completion = secrets.length ? { ...c0, error: c0.error === undefined ? undefined : redactText(String(c0.error), secrets),
    results: Array.isArray(c0.results) ? redactJson(c0.results, secrets) : c0.results } : c0;
  const usage = await asPlatform(() => runGatewayUsage(String(runId)));
  const gone: string[] = [];
  // mold_v0-064: a pack that indexes its workspace gets the committed snapshot before the results are checked.
  let hooked: { committed: boolean; hookError: string | null } | null = null;
  if (c.outcome === "succeeded" && withHook(runRow)) {
    // Everything about the results but whether their records exist is checked before anything is committed: only an
    // unresolved reference (which the hook may resolve) can still refuse them after the snapshot commits.
    await checkResults(null, runRow!.org_id, Array.isArray(c.results) ? c.results : [], runRow!.spec ?? {});
    const h = await commitThenHook(String(runId), leaseToken, secrets, usage.cost_usd);
    if ("done" in h) { await removeObjects(h.gone); return view(h.done); }
    hooked = h;
  }
  const r = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const run = await leased(tx, runId, leaseToken, true);
    // The attempt's end, in this transaction: its tokens revoked, its store lease released, its uncommitted stage discarded.
    const endOfAttempt = async () => { await revokeRunTokens(run.id, tx); gone.push(...(await endAttempt(tx, run.id))); };
    let status: RunView["status"], kind: string | null = null, error: string | null = null;
    let resultSummary: Record<string, number> | null = null;
    if (run.cancel_requested_at) { status = "cancelled"; kind = "cancelled"; error = "cancelled"; }
    else if (c.outcome === "succeeded" && hooked?.hookError) {
      // The hook failed: the results are not accepted. The snapshot stays committed (it passed the run's validation);
      // the next run's commit calls the hook again.
      status = "failed"; kind = "run";
      error = (hooked.hookError.startsWith(INDEX_REFUSED) ? hooked.hookError : `the pack's workspace hook (onWorkspaceCommit) failed: ${hooked.hookError}`).slice(0, 2000);
    }
    else if (c.outcome === "succeeded") {
      const { rows: results, unresolved } = await checkResults(tx, run.org_id, Array.isArray(c.results) ? c.results : [], run.spec ?? {});
      // The workspace's write-back (mold_v0-033): the staged snapshot becomes the next version now, with the results
      // (already committed, before the results were checked, when the pack has a workspace hook: mold_v0-064).
      const wb = run.spec?.workspace && !hooked ? await commitStaged(tx, run) : null;
      if (wb === "conflict") {
        status = run.attempt < run.max_attempts ? "queued" : "failed"; kind = "infrastructure";
        error = "the workspace changed after this run checked it out: retried from a fresh checkout";
        const [u] = await tx.query<RunRow>(
          `/* tenant: the leased run, by id */ UPDATE runs SET status = $2, error_kind = $3, error = $4, cost_usd = $5, ended_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
                  worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [run.id, status, kind, error, usage.cost_usd]);
        await event(run.id, run.org_id, run.attempt, status === "queued" ? "retry" : status, { error_kind: kind, error }, tx);
        await endOfAttempt();
        return u!;
      }
      if (wb) await event(run.id, run.org_id, run.attempt, "workspace_written", wb, tx);
      for (const x of results)
        await tx.query(
          `INSERT INTO run_results (run_id, org_id, check_area, check_key, asset_area, asset_key, source_area, source_key, status, finding_fingerprint, evidence_ref, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [run.id, run.org_id, x.check.area, x.check.key, x.asset?.area ?? null, x.asset?.key ?? null, x.source?.area ?? null, x.source?.key ?? null,
           x.status, x.fp, x.ev, JSON.stringify(x.detail)]);
      // Every result left out or downgraded is said so (mold_v0-065), with its status: a dropped failure is visible.
      for (const u of unresolved.slice(0, 500)) await event(run.id, run.org_id, run.attempt, "result_unresolved", u as unknown as Record<string, unknown>, tx);
      if (unresolved.length) resultSummary = { results: results.length, unresolved: unresolved.length,
        dropped: unresolved.filter((u) => u.action === "dropped").length, downgraded: unresolved.filter((u) => u.action === "downgraded").length,
        dropped_not_passing: unresolved.filter((u) => u.action === "dropped" && u.status !== "pass" && u.status !== "not_applicable").length };
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
    await event(run.id, run.org_id, run.attempt, status === "queued" ? "retry" : status, { error_kind: kind, error, cost_usd: usage.cost_usd, ...(resultSummary ?? {}) }, tx);
    await endOfAttempt();
    return u!;
  }));
  await removeObjects(gone);
  return view(r);
}
