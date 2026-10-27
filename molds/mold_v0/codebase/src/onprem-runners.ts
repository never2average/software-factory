/**
 * On-premises runners (mold_v0-036; molds/mold_v0/MOLD.md "On-premises runners", docs/on-premises-runner.md). A
 * workspace whose runs must reach its own private network (a pack's kind with `private_network: true`: an audit's
 * runtime probes of systems that are not on the internet) installs a small runner inside that network
 * (src/onprem-runner.ts, the app's own image and one command). Tables: sql/migrations/0027_on_premises_runners.sql.
 *
 *   create    an owner of the workspace names a runner: a row with a one-time enrollment token (ore_..., only its
 *             sha256 stored, shown once, expiring after APP_RUNNER_ENROLL_HOURS, 24)
 *   enroll    the runner sends the token once (POST /api/runner/enroll): it is cleared, and the runner gets its own
 *             credential (orr_..., only its sha256 stored), bound to that row and so to that one workspace
 *   location  the workspace's choice for runs that need its private network: hosted (the default, and with no row) or
 *             on_premises, which needs one of its runners enrolled and online. A run of such a kind is routed when it is
 *             queued (runs.runner_location); switching moves the workspace's queued ones. Every other run is hosted.
 *   poll      the runner asks, outbound only (POST /api/runner/poll, every few seconds; it never listens): it says what it
 *             is (version, host, capacity, the kinds its image has, its private allow list) and which run sandboxes it
 *             has, and gets the runs to start, each with a worker token bound to that run and that sandbox (exactly a
 *             hosted run sandbox's: src/run-sandboxes.ts, src/run-routes.ts), and the sandboxes to remove. Only its own
 *             workspace's runs routed on premises, of kinds its image has, within the kind's limits (claimableRuns):
 *             never another workspace's. The run sandbox then claims, streams events and completes through the worker
 *             API as a hosted one does, outbound too.
 *   revoke    an owner (or platform staff) revokes a runner: at once its credential and the tokens of every sandbox it
 *             launched stop working, the runs it was carrying out stop spending (their gateway tokens are revoked) and go
 *             back to the queue (or fail when no attempt is left), and the runner, at its next poll, removes its run
 *             sandboxes and stops.
 *   health    a runner is online when it polled within APP_RUNNER_ONLINE_SECONDS (90); the console shows when it was
 *             last seen. A runner silent for APP_RUNNER_OFFLINE_REAP_MINUTES (15) loses its sandboxes' tokens.
 *
 * Nothing here exists in a build with no kind that needs the private network (the routes mount nothing, every run is
 * hosted, as before), nor with APP_ONPREM_RUNNERS=off.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, type Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";
import { claimableRuns, failUnlaunchedRun, findKind, jobKinds, sweepRuns, type JobKind } from "./runs.js";
import { mintRunWorkerToken, revokeRunSandboxTokens } from "./workerauth.js";
import { recordComputeEvent } from "./compute-events.js";
import { DEFAULT_RUN_UIDS } from "./run-users.js";
import { ENV } from "./env-names.js";

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export const ONPREM = {
  enrollHours: () => Math.min(24 * 7, Math.max(1, num(ENV.APP_RUNNER_ENROLL_HOURS, 24))),
  onlineSeconds: () => Math.max(15, num(ENV.APP_RUNNER_ONLINE_SECONDS, 90)),
  pollSeconds: () => Math.max(1, num(ENV.APP_RUNNER_POLL_SECONDS, 5)),
  offlineReapMinutes: () => Math.max(1, num(ENV.APP_RUNNER_OFFLINE_REAP_MINUTES, 15)),
  bootMinutes: () => Math.max(1, num(ENV.APP_RUN_BOOT_MINUTES, 10)),
  launchAttempts: () => Math.max(1, num(ENV.APP_RUN_LAUNCH_ATTEMPTS, 3)),
  backoffSeconds: () => Math.max(0, num(ENV.APP_RUN_LAUNCH_BACKOFF_SECONDS, 30)),
  maxPerWorkspace: () => Math.max(1, num(ENV.APP_RUNNERS_PER_WORKSPACE, 10)),
  maxCapacity: () => Math.max(1, num(ENV.APP_RUNNER_MAX_CAPACITY, 8)),
};
export type RunnerLocation = "hosted" | "on_premises";
export const ENROLL_PREFIX = "ore_", CREDENTIAL_PREFIX = "orr_";

/** The kinds of this build that may need a workspace's private network. */
export const privateNetworkKinds = (): JobKind[] => jobKinds().filter((k) => (k as { private_network?: boolean }).private_network);
/** Whether this build offers on-premises runners at all: a kind that needs the private network, and not switched off. */
export const onPremAvailable = () => (ENV.APP_ONPREM_RUNNERS ?? "").toLowerCase() !== "off" && privateNetworkKinds().length > 0;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONLINE = () => `last_seen_at > now() - make_interval(secs => ${Math.round(ONPREM.onlineSeconds())})`;

/** Where workspace `orgId`'s runs that need its private network go now (inside startRun's transaction). */
export async function runLocationFor(q: Queryable, orgId: number): Promise<RunnerLocation> {
  if (!onPremAvailable()) return "hosted";
  const [r] = await q.query<{ location: RunnerLocation }>("SELECT location FROM workspace_runner_settings WHERE org_id = $1", [orgId]);
  return r?.location === "on_premises" ? "on_premises" : "hosted";
}

async function runEvent(q: Queryable, runId: string, orgId: number, attempt: number, type: string, data: Record<string, unknown>) {
  await q.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, $3, $4, $5)", [runId, orgId, attempt, type, JSON.stringify(data)]);
}

/** A run just routed on premises: says so when the workspace has no runner online to take it. */
export async function noteOnPremisesStart(runId: string, orgId: number): Promise<void> {
  await asPlatform(async () => {
    const db = await getDb();
    const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM onprem_runners WHERE org_id = $1 AND state = 'enrolled' AND ${ONLINE()}`, [orgId]);
    if (!n) await runEvent(db, runId, orgId, 0, "waiting", { reason: "waits for this workspace's on-premises runner: none is online" });
  });
}

// ---------- the workspace's side (src/onprem-runner-routes.ts) ----------

interface RunnerRow {
  id: string; org_id: number; name: string; state: "pending" | "enrolled" | "revoked"; enroll_expires_at: Date; created_by: string | null; created_at: Date;
  enrolled_at: Date | null; revoked_at: Date | null; revoked_by: string | null; last_seen_at: Date | null; version: string | null; hostname: string | null;
  isolation: string | null; capacity: number | null; allow: string[]; online: boolean; live: number;
}
const RUNNER_COLS = () => `r.id, r.org_id, r.name, r.state, r.enroll_expires_at, r.created_by, r.created_at, r.enrolled_at, r.revoked_at, r.revoked_by, r.last_seen_at,
  r.version, r.hostname, r.isolation, r.capacity, r.allow, (r.state = 'enrolled' AND r.${ONLINE()}) AS online,
  (SELECT count(*)::int FROM run_sandboxes s WHERE s.onprem_runner_id = r.id AND s.state <> 'deleted') AS live`;
export interface RunnerView {
  id: string; name: string; status: "waiting_for_install" | "enrollment_expired" | "online" | "offline" | "revoked";
  created_at: string; created_by: string | null; enroll_expires_at: string | null; enrolled_at: string | null; revoked_at: string | null;
  last_seen_at: string | null; version: string | null; hostname: string | null; isolation: string | null; capacity: number | null;
  live_runs: number; allow: string[];
}
const runnerView = (r: RunnerRow): RunnerView => ({
  id: r.id, name: r.name,
  status: r.state === "revoked" ? "revoked" : r.state === "pending" ? (new Date(r.enroll_expires_at).getTime() > Date.now() ? "waiting_for_install" : "enrollment_expired")
    : r.online ? "online" : "offline",
  created_at: iso(r.created_at)!, created_by: r.created_by, enroll_expires_at: r.state === "pending" ? iso(r.enroll_expires_at) : null,
  enrolled_at: iso(r.enrolled_at), revoked_at: iso(r.revoked_at), last_seen_at: iso(r.last_seen_at), version: r.version, hostname: r.hostname,
  isolation: r.isolation, capacity: r.capacity, live_runs: Number(r.live ?? 0), allow: Array.isArray(r.allow) ? r.allow : [],
});

export interface WorkspaceRunners {
  available: boolean; location: RunnerLocation; runners: RunnerView[];
  /** The kinds whose runs go to the runner when the location is on premises. */
  kinds: { pack: string; name: string; label: string }[];
  /** Runs of the workspace waiting for a runner now. */
  queued_on_premises: number;
}

/** The workspace's runners, its location and the kinds it applies to (never another workspace's). */
export async function workspaceRunners(orgId: number): Promise<WorkspaceRunners> {
  return asPlatform(async () => {
    const db = await getDb();
    const rows = await db.query<RunnerRow>(`SELECT ${RUNNER_COLS()} FROM onprem_runners r WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [orgId]);
    const [s] = await db.query<{ location: RunnerLocation }>("SELECT location FROM workspace_runner_settings WHERE org_id = $1", [orgId]);
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE org_id = $1 AND status = 'queued' AND runner_location = 'on_premises'", [orgId]);
    return {
      available: true, location: s?.location === "on_premises" ? "on_premises" : "hosted",
      runners: rows.map(runnerView),
      kinds: privateNetworkKinds().map((k) => ({ pack: k.pack, name: k.name, label: (k as { label?: string }).label ?? k.name })),
      queued_on_premises: Number(n),
    };
  });
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,59}$/u;

/** A new runner of workspace `orgId`, waiting for its install: its one-time enrollment token, shown this once. */
export async function createRunner(orgId: number, by: string | null, rawName: unknown): Promise<{ runner: RunnerView; enrollment_token: string; expires_at: string }> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!NAME.test(name)) throw new PackError("name: 1 to 60 letters, digits, spaces and . _ ( ) -", 400);
  const token = `${ENROLL_PREFIX}${randomBytes(24).toString("base64url")}`;
  const id = `rnr_${randomBytes(9).toString("base64url")}`;
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`onprem-runners:${orgId}`]);
    const [{ n }] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM onprem_runners WHERE org_id = $1 AND state <> 'revoked'", [orgId]);
    if (n >= ONPREM.maxPerWorkspace()) throw new PackError(`at most ${ONPREM.maxPerWorkspace()} runners per workspace: revoke one first`, 409);
    await tx.query(
      `INSERT INTO onprem_runners (id, org_id, name, enroll_token_hash, enroll_expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6)`, [id, orgId, name, sha256(token), ONPREM.enrollHours(), by]);
    const [r] = await tx.query<RunnerRow>(`SELECT ${RUNNER_COLS()} FROM onprem_runners r WHERE r.org_id = $1 AND r.id = $2`, [orgId, id]);
    return { runner: runnerView(r!), enrollment_token: token, expires_at: iso(r!.enroll_expires_at)! };
  }));
}

/**
 * Revoke runner `id` (of workspace `orgId`; platform staff pass null): its credential and enrollment token stop working
 * now, so do its sandboxes' worker tokens; its runs stop spending and go back to the queue (or fail with no attempt left).
 */
export async function revokeRunner(orgId: number | null, id: string, by: string | null): Promise<{ revoked: boolean; runs_stopped: number }> {
  const out = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const [r] = await tx.query<{ id: string; org_id: number }>(
      `/* tenant: by the runner's id, within the caller's workspace (staff: any) */ UPDATE onprem_runners SET state = 'revoked', revoked_at = now(), revoked_by = $3, enroll_token_hash = NULL
        WHERE id = $1 AND ($2::int IS NULL OR org_id = $2) AND state <> 'revoked' RETURNING id, org_id`, [String(id), orgId, by]);
    if (!r) return null;
    const rows = await tx.query<{ id: number; run_id: string }>(
      `UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), reap_reason = coalesce(reap_reason, 'its on-premises runner was revoked')
        WHERE onprem_runner_id = $1 AND state <> 'deleted' RETURNING id, run_id`, [r.id]);
    // Their worker tokens, in the same transaction: nothing of the runner works once this commits.
    if (rows.length) await tx.query("/* tenant: internal, by the revoked runner's sandboxes */ UPDATE worker_tokens SET revoked_at = now() WHERE run_sandbox_id = ANY ($1::int[]) AND revoked_at IS NULL",
      [rows.map((x) => x.id)]);
    // The runs those sandboxes carry out: their lease ends now, so the sweep below revokes their gateway tokens (spending
    // stops) and queues them again (or fails them), in the run's own workspace.
    const ids = rows.map((x) => x.run_id);
    const stopped = ids.length ? await tx.query<{ id: string }>(
      `/* tenant: the revoked runner's own workspace, by run id */ UPDATE runs SET lease_expires_at = now() - interval '1 second'
        WHERE id = ANY ($1::text[]) AND org_id = $2 AND status = 'running' RETURNING id`, [ids, r.org_id]) : [];
    return { orgId: r.org_id, sandboxes: rows, stopped: stopped.length };
  }));
  if (!out) return { revoked: false, runs_stopped: 0 };
  await asPlatform(async () => {
    if (out.stopped) await sweepRuns();
    for (const x of out.sandboxes) await recordComputeEvent({ kind: "reaped", job_id: x.run_id, reason: `on-premises runner ${id} revoked` });
  });
  return { revoked: true, runs_stopped: out.stopped };
}

/**
 * Set where workspace `orgId`'s runs that need its private network go. On premises needs a runner of the workspace that
 * is enrolled and online. Its queued runs of those kinds move with it (one with a sandbox already launched for it is
 * left to that sandbox, which is told to stop).
 */
export async function setRunnerLocation(orgId: number, raw: unknown, by: string | null): Promise<{ location: RunnerLocation; moved: number }> {
  if (raw !== "hosted" && raw !== "on_premises") throw new PackError("location: hosted or on_premises", 400);
  const location: RunnerLocation = raw;
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`onprem-runners:${orgId}`]);
    if (location === "on_premises") {
      const [{ n }] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM onprem_runners WHERE org_id = $1 AND state = 'enrolled' AND ${ONLINE()}`, [orgId]);
      if (!n) throw new PackError("install and enroll a runner first: on premises needs one of this workspace's runners online", 409);
    }
    await tx.query(
      `INSERT INTO workspace_runner_settings (org_id, location, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (org_id) DO UPDATE SET location = excluded.location, updated_by = excluded.updated_by, updated_at = now()`, [orgId, location, by]);
    const kinds = privateNetworkKinds().map((k) => `${k.pack}/${k.name}`);
    const from: RunnerLocation = location === "on_premises" ? "hosted" : "on_premises";
    // A sandbox launched for a queued run that has not claimed it yet would claim it in the old place: it is told to stop.
    await tx.query(
      `/* tenant: the caller's workspace's runs */ UPDATE run_sandboxes s SET state = 'draining', reap_reason = coalesce(s.reap_reason, 'its run moved to another runner location')
         FROM runs x WHERE x.id = s.run_id AND x.org_id = $1 AND x.status = 'queued' AND x.runner_location = $2 AND s.state IN ('booting', 'running') AND s.claimed_at IS NULL`, [orgId, from]);
    const moved = await tx.query<{ id: string; attempt: number }>(
      `UPDATE runs SET runner_location = $3, updated_at = now() WHERE org_id = $1 AND status = 'queued' AND runner_location = $2
          AND pack || '/' || kind = ANY ($4::text[]) RETURNING id, attempt`, [orgId, from, location, kinds]);
    for (const m of moved) await runEvent(tx, m.id, orgId, m.attempt, "location", { location, by });
    return { location, moved: moved.length };
  }));
}

// ---------- the runner's side (POST /api/runner/enroll, /api/runner/poll) ----------

export interface RunnerInfo { version?: unknown; hostname?: unknown; capacity?: unknown; isolation?: unknown; allow?: unknown; kinds?: unknown }
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || null : null);
const clean = (info: RunnerInfo) => ({
  version: text(info.version, 80), hostname: text(info.hostname, 120), isolation: text(info.isolation, 20),
  capacity: Number.isSafeInteger(Number(info.capacity)) ? Math.max(0, Math.min(ONPREM.maxCapacity(), Number(info.capacity))) : 1,
  allow: Array.isArray(info.allow) ? info.allow.slice(0, 100).map((x) => text(x, 300)).filter((x): x is string => !!x) : [],
  kinds: Array.isArray(info.kinds) ? info.kinds.slice(0, 500).map((x) => text(x, 130)).filter((x): x is string => !!x) : null,
});

export class RunnerAuthError extends PackError {
  constructor(message: string, public revoked = false) { super(message, 401); }
}

/** Enroll with a one-time token: the runner's own credential, shown this once. The token is used up. */
export async function enrollRunner(token: string | null, info: RunnerInfo): Promise<{ runner_id: string; name: string; credential: string; poll_seconds: number }> {
  if (!token || !token.startsWith(ENROLL_PREFIX) || token.length > 200) throw new RunnerAuthError("an enrollment token (ore_...) is required");
  const credential = `${CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
  const c = clean(info);
  const [r] = await asPlatform(async () => (await getDb()).query<{ id: string; name: string; org_id: number }>(
    `/* tenant: by the one-time token's hash (the runner's only credential for it) */ UPDATE onprem_runners SET state = 'enrolled', enroll_token_hash = NULL, secret_hash = $2, enrolled_at = now(),
            last_seen_at = now(), version = $3, hostname = $4, isolation = $5, capacity = $6, allow = $7
      WHERE enroll_token_hash = $1 AND state = 'pending' AND enroll_expires_at > now() RETURNING id, name, org_id`,
    [sha256(token), sha256(credential), c.version, c.hostname, c.isolation, c.capacity, JSON.stringify(c.allow)]));
  if (!r) throw new RunnerAuthError("this enrollment token is unknown, used, revoked or expired: create a new runner in the console");
  return { runner_id: r.id, name: r.name, credential, poll_seconds: ONPREM.pollSeconds() };
}

export interface AuthedRunner { id: string; orgId: number; name: string }
/** The enrolled runner behind a credential; a RunnerAuthError (revoked: true when it was revoked) otherwise. */
export async function runnerFromCredential(credential: string | null): Promise<AuthedRunner> {
  if (!credential || !credential.startsWith(CREDENTIAL_PREFIX) || credential.length > 200) throw new RunnerAuthError("a runner credential (orr_...) is required");
  const [r] = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number; name: string; state: string }>(
    "/* tenant: by the runner credential's hash (it names its one workspace) */ SELECT id, org_id, name, state FROM onprem_runners WHERE secret_hash = $1", [sha256(credential)]));
  if (!r) throw new RunnerAuthError("unknown runner credential");
  if (r.state !== "enrolled") throw new RunnerAuthError("this runner was revoked: remove it, or create a new one in the console", true);
  return { id: r.id, orgId: r.org_id, name: r.name };
}

export interface PollReport extends RunnerInfo {
  /** The run sandboxes it has: their rows, the sandbox (container) ids and whether each is still running. */
  sandboxes?: unknown;
  /** Launches since the last poll: started (with the sandbox id) or failed (with the step and error). */
  started?: unknown;
  failed?: unknown;
}
export interface Assignment {
  row: number; run_id: string; name: string; ttl_seconds: number;
  /** The run sandbox's runner environment, as a hosted run sandbox's (the runner sets APP_URL to its own address for the app). */
  env: Record<string, string>;
}
export interface PollAnswer { runner: { id: string; name: string }; assign: Assignment[]; remove: number[]; keep: number[]; poll_seconds: number }

const intOf = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 200).filter((x) => x && typeof x === "object") as Record<string, unknown>[] : []);

/**
 * One poll of runner `who`: record what it said, reconcile its sandboxes (as the hosted scaler reconciles its own), and
 * hand it its workspace's runs routed on premises (only of kinds its image has), up to its capacity.
 */
export async function pollRunner(who: AuthedRunner, report: PollReport, apiUrl: string): Promise<PollAnswer> {
  const c = clean(report);
  return asPlatform(async () => {
    const db = await getDb();
    await db.query(
      `UPDATE onprem_runners SET last_seen_at = now(), version = coalesce($3, version), hostname = coalesce($4, hostname), isolation = coalesce($5, isolation),
              capacity = $6, allow = $7 WHERE id = $1 AND org_id = $2`, [who.id, who.orgId, c.version, c.hostname, c.isolation, c.capacity, JSON.stringify(c.allow)]);
    const remove: number[] = [];
    // Its own rows only: a row id of another runner (or another workspace) in its report changes nothing.
    const own = async (row: number) => (await db.query<{ id: number }>("SELECT id FROM run_sandboxes WHERE id = $1 AND onprem_runner_id = $2 AND state <> 'deleted'", [row, who.id])).length > 0;
    for (const s of list(report.started)) {
      const row = intOf(s.row), sid = text(s.sandbox_id, 200);
      if (row && sid && (await own(row)))
        await db.query("UPDATE run_sandboxes SET sandbox_id = coalesce(sandbox_id, $2), state = CASE WHEN state = 'booting' THEN 'running' ELSE state END, ready_at = coalesce(ready_at, now()) WHERE id = $1", [row, sid]);
    }
    const reap = async (row: { id: number; run_id: string; sandbox_id: string | null }, reason: string, failedStart: boolean, step?: string) => {
      await db.query(`UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), reap_reason = coalesce(reap_reason, $2),
                        launch_step = CASE WHEN $3 THEN coalesce(launch_step, $4) ELSE launch_step END,
                        launch_error = CASE WHEN $3 THEN coalesce(launch_error, $2) ELSE launch_error END WHERE id = $1`, [row.id, reason.slice(0, 500), failedStart, step ?? "boot"]);
      await revokeRunSandboxTokens(row.id);
      await recordComputeEvent({ kind: failedStart ? "launch_failed" : "reaped", sandbox_id: row.sandbox_id, job_id: row.run_id, step: failedStart ? step ?? "boot" : undefined, reason: `on-premises run sandbox: ${reason}` });
      remove.push(row.id);
    };
    for (const f of list(report.failed)) {
      const row = intOf(f.row);
      if (!row || !(await own(row))) continue;
      const [r] = await db.query<{ id: number; run_id: string; sandbox_id: string | null }>("SELECT id, run_id, sandbox_id FROM run_sandboxes WHERE id = $1", [row]);
      await reap(r!, `the runner could not start it: ${text(f.error, 400) ?? "unknown error"}`, true, text(f.step, 40) ?? "start");
    }
    // Reconcile: what it has against its live rows.
    const reported = new Map(list(report.sandboxes).flatMap((s) => { const row = intOf(s.row); return row ? [[row, { live: s.live !== false, state: text(s.state, 40) }] as const] : []; }));
    const rows = await db.query<{ id: number; run_id: string; attempt: number; sandbox_id: string | null; state: string; created_at: Date; claimed_at: Date | null; reap_reason: string | null }>(
      "SELECT id, run_id, attempt, sandbox_id, state, created_at, claimed_at, reap_reason FROM run_sandboxes WHERE onprem_runner_id = $1 AND state <> 'deleted' ORDER BY id", [who.id]);
    const runsOf = new Map((await db.query<{ id: string; status: string; worker_id: string | null; deadline_at: Date | null; attempt: number }>(
      `SELECT id, status, worker_id, deadline_at, attempt FROM runs WHERE org_id = $2 AND id = ANY ($1::text[])`, [rows.map((r) => r.run_id), who.orgId])).map((r) => [r.id, r]));
    const now = Date.now(), min = 60_000;
    for (const row of rows) {
      const age = now - new Date(row.created_at).getTime();
      if (row.state === "draining") { await reap(row, row.reap_reason ?? "its attempt ended", false); continue; }
      const seen = reported.get(row.id);
      if (!seen) { if (age > 2 * min) await reap(row, "its runner no longer has it", !row.claimed_at); continue; }
      if (!seen.live) { await reap(row, `the run sandbox is ${seen.state ?? "stopped"}`, !row.claimed_at); continue; }
      const run = runsOf.get(row.run_id);
      if (!run || !["queued", "running"].includes(run.status)) { await reap(row, `its run is ${run?.status ?? "gone"}`, false); continue; }
      if (run.status === "running") {
        if (run.worker_id !== `sbx-${row.id}`) { await reap(row, "its run is carried out elsewhere", false); continue; }
        if (run.deadline_at && now > new Date(run.deadline_at).getTime() + 5 * min) await reap(row, "past its run's deadline", false);
        continue;
      }
      if (row.claimed_at) { await reap(row, run.attempt < row.attempt ? "its claim did not start the run" : "its attempt ended and the run was queued again", run.attempt < row.attempt); continue; }
      if (age > ONPREM.bootMinutes() * min) await reap(row, `no claim within ${ONPREM.bootMinutes()} minutes`, true);
    }

    // Assign: this workspace's runs routed on premises, of the kinds its image has, up to its capacity.
    const assign: Assignment[] = [];
    const [{ live }] = await db.query<{ live: number }>("SELECT count(*)::int AS live FROM run_sandboxes WHERE onprem_runner_id = $1 AND state <> 'deleted'", [who.id]);
    let room = c.capacity - Number(live);
    if (room > 0) {
      const has = c.kinds ? new Set(c.kinds) : null;
      for (const run of await claimableRuns(200, { location: "on_premises", orgId: who.orgId })) {
        if (room <= 0) break;
        if (run.org_id !== who.orgId) continue; // claimableRuns is scoped to the workspace; held here again
        if (has && !has.has(`${run.pack}/${run.kind}`)) continue; // a kind its image lacks waits for one that has it
        const [f] = await db.query<{ n: number; last: Date | null; err: string | null }>(
          `SELECT count(*)::int AS n, max(deleted_at) AS last, (array_agg(launch_error ORDER BY id DESC))[1] AS err FROM run_sandboxes WHERE run_id = $1 AND launch_error IS NOT NULL`, [run.id]);
        const fails = Number(f?.n ?? 0);
        if (fails >= ONPREM.launchAttempts()) { await failUnlaunchedRun(run.id, `its on-premises run sandbox could not be started (${fails} tries; last: ${String(f?.err ?? "").slice(0, 300)})`); continue; }
        if (fails && f?.last && now - new Date(f.last).getTime() < ONPREM.backoffSeconds() * 1000 * 2 ** (fails - 1)) continue;
        // One live sandbox per run (the unique index): a second runner of the workspace polling at once gets nothing.
        const [row] = await db.query<{ id: number }>(
          "INSERT INTO run_sandboxes (run_id, attempt, provider, onprem_runner_id) VALUES ($1, $2, 'onprem', $3) ON CONFLICT (run_id) WHERE state <> 'deleted' DO NOTHING RETURNING id",
          [run.id, run.attempt + 1, who.id]);
        if (!row) continue;
        const kind = findKind(run.pack, run.kind);
        let packRel = "";
        if (kind && kind.runner === "workspace-harness") {
          const { packDir } = await import("./packs.js");
          packRel = path.relative(ROOT, packDir(run.pack)).split(path.sep).join("/");
          if (!packRel || packRel.startsWith("..") || path.isAbsolute(packRel)) packRel = "";
        }
        const life = ONPREM.bootMinutes() * 60 + run.token_lifetime_seconds + run.lease_seconds * 2;
        const token = await mintRunWorkerToken(run.id, run.org_id, row.id, life + 600);
        assign.push({
          row: row.id, run_id: run.id, name: `run-${row.id}-${randomBytes(3).toString("hex")}`, ttl_seconds: life + 1800,
          env: { APP_URL: apiUrl, APP_WORKER_TOKEN: token, APP_RUN_ID: run.id, APP_RUN_UIDS: ENV.APP_RUN_UIDS || DEFAULT_RUN_UIDS, APP_RUN_PACK_DIR: packRel, APP_RUN_LOCKDOWN: "on" },
        });
        room--;
      }
    }
    const keep = (await db.query<{ id: number }>("SELECT id FROM run_sandboxes WHERE onprem_runner_id = $1 AND state <> 'deleted' ORDER BY id", [who.id])).map((r) => r.id);
    return { runner: { id: who.id, name: who.name }, assign, remove, keep, poll_seconds: ONPREM.pollSeconds() };
  });
}

/**
 * Runners silent past APP_RUNNER_OFFLINE_REAP_MINUTES: their sandboxes' tokens are revoked and the rows closed (a run
 * one of them was carrying out lapses and is queued again by the sweep). Called from the run scaler's tick.
 */
export async function reapSilentRunners(): Promise<number> {
  if (!onPremAvailable()) return 0;
  return asPlatform(async () => {
    const db = await getDb();
    const rows = await db.query<{ id: number; run_id: string }>(
      `/* tenant: internal, every workspace's silent runners (their own sandboxes only) */ UPDATE run_sandboxes s SET state = 'deleted', deleted_at = now(), reap_reason = coalesce(s.reap_reason, 'its on-premises runner went silent')
         FROM onprem_runners r WHERE r.id = s.onprem_runner_id AND s.state <> 'deleted'
          AND (r.state <> 'enrolled' OR r.last_seen_at IS NULL OR r.last_seen_at < now() - make_interval(mins => $1))
        RETURNING s.id, s.run_id`, [Math.round(ONPREM.offlineReapMinutes())]);
    for (const r of rows) await revokeRunSandboxTokens(r.id);
    return rows.length;
  });
}

/** Every workspace's runners, for platform staff (no secret: names, state, health). */
export async function adminRunners(): Promise<(RunnerView & { org_id: number; org_name: string | null })[]> {
  return asPlatform(async () => {
    const rows = await (await getDb()).query<RunnerRow & { org_name: string | null }>(
      `/* tenant: platform staff, every workspace (names and health only) */ SELECT ${RUNNER_COLS()}, o.name AS org_name FROM onprem_runners r
         LEFT JOIN organizations o ON o.id = r.org_id ORDER BY r.created_at DESC LIMIT 500`);
    return rows.map((r) => ({ ...runnerView(r), org_id: r.org_id, org_name: r.org_name }));
  });
}
