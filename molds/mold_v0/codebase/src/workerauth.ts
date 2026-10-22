/**
 * Worker credentials (docs/security.md, phase 0b). Two kinds:
 *  - the fleet token (OCTILLION_WORKER_TOKEN): Octillion's own shared orchestrators; can serve any job.
 *  - a job token (owk_...): minted by the autoscaler for each per-job orchestrator it launches, bound to that one job
 *    (sim_ or rsh_) and its organization. It can claim and act on that job's sessions or research only, so a sandbox
 *    that leaks its token exposes one job, not every customer's data.
 *  - a run token (owk_..., job_id run_...; mold_v0-055): minted by the autoscaler for each run sandbox it launches, bound
 *    to that one run and that one sandbox. It may only claim that run, once, and act on it with the run's lease
 *    (src/run-routes.ts); every other worker route refuses it (src/http.ts). It expires shortly after the run's deadline
 *    and is revoked when the sandbox is torn down.
 * Tokens are stored as SHA-256 hashes and revoked when the orchestrator's (or the run's) sandbox is deleted.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { isWorkerToken } from "./auth.js";

export type WorkerAuth =
  | { kind: "fleet" }
  | { kind: "job"; jobId: string; orgId: number | null; sandboxRowId: number | null }
  | { kind: "run"; runId: string; orgId: number | null; runSandboxId: number };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN_HOURS = () => Number(process.env.OCTILLION_JOB_TOKEN_HOURS ?? 48);

/** The organization a job belongs to (a simulation or an onboarding research). */
async function orgOfJob(jobId: string): Promise<number | null> {
  // Jobs are the session engine's, a host pack's tables (mold_v0-049): a build without them has no job.
  if (!(jobId.startsWith("rsh_") ? researchJobs() : sessionEngine())) return null;
  const db = await getDb();
  const [r] = jobId.startsWith("rsh_")
    ? await db.query<{ org_id: number }>("SELECT org_id FROM product_research WHERE id = $1", [jobId])
    : await db.query<{ org_id: number }>("SELECT org_id FROM simulations WHERE id = $1", [jobId]);
  return r?.org_id ?? null;
}

/** Mint a token bound to one job, for the orchestrator sandbox `sandboxRowId` (orchestrator_sandboxes.id). */
export async function mintJobWorkerToken(jobId: string, sandboxRowId: number | null): Promise<string> {
  const token = `owk_${randomBytes(24).toString("base64url")}`;
  await (await getDb()).query(
    `INSERT INTO worker_tokens (token_hash, job_id, org_id, sandbox_row_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [sha256(token), jobId, await orgOfJob(jobId), sandboxRowId, TOKEN_HOURS()]);
  return token;
}

/**
 * Mint a token bound to run `runId` and its sandbox `runSandboxId` (run_sandboxes.id; mold_v0-055), valid for
 * `seconds`. It goes only into that sandbox's runner environment.
 */
export async function mintRunWorkerToken(runId: string, orgId: number, runSandboxId: number, seconds: number): Promise<string> {
  if (!runId.startsWith("run_")) throw new Error("a run token is bound to a run (run_...)");
  const token = `owk_${randomBytes(24).toString("base64url")}`;
  await (await getDb()).query(
    `/* tenant: internal, the run's own workspace from its row */ INSERT INTO worker_tokens (token_hash, job_id, org_id, run_sandbox_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [sha256(token), runId, orgId, runSandboxId, Math.max(60, Math.ceil(seconds))]);
  return token;
}

/** Revoke the token of a run sandbox (it was torn down, or its launch failed). */
export async function revokeRunSandboxTokens(runSandboxId: number): Promise<void> {
  await (await getDb()).query("/* tenant: internal, by the run sandbox the token was minted for */ UPDATE worker_tokens SET revoked_at = now() WHERE run_sandbox_id = $1 AND revoked_at IS NULL", [runSandboxId]);
}

/** Fleet token, a live job or run token, or null (reject). */
export async function resolveWorkerToken(token: string | null | undefined): Promise<WorkerAuth | null> {
  if (!token) return null;
  if (isWorkerToken(token)) return { kind: "fleet" };
  if (!token.startsWith("owk_")) return null;
  const [r] = await (await getDb()).query<{ job_id: string; org_id: number | null; sandbox_row_id: number | null; run_sandbox_id: number | null }>(
    "SELECT job_id, org_id, sandbox_row_id, run_sandbox_id FROM worker_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()",
    [sha256(token)]);
  if (!r) return null;
  // A run's token (mold_v0-055): never a job token, whatever route it reaches.
  if (r.job_id.startsWith("run_")) return r.run_sandbox_id != null ? { kind: "run", runId: r.job_id, orgId: r.org_id, runSandboxId: r.run_sandbox_id } : null;
  return { kind: "job", jobId: r.job_id, orgId: r.org_id, sandboxRowId: r.sandbox_row_id };
}

/** Revoke the tokens of an orchestrator sandbox (it was deleted or reaped). */
export async function revokeSandboxWorkerTokens(sandboxRowId: number): Promise<void> {
  await (await getDb()).query("/* tenant: internal, by the sandbox the token was minted for */ UPDATE worker_tokens SET revoked_at = now() WHERE sandbox_row_id = $1 AND revoked_at IS NULL", [sandboxRowId]);
}

/** Whether `auth` may act on agent session `sessionId` (a job token: only its own simulation's sessions). */
export async function canActOnSession(auth: WorkerAuth, sessionId: string): Promise<boolean> {
  if (auth.kind === "fleet") return true;
  if (auth.kind !== "job") return false; // a run token acts on its run only
  if (!sessionEngine()) return false;
  const [s] = await (await getDb()).query<{ simulation_id: string }>("/* tenant: compared with the job the token is bound to */ SELECT simulation_id FROM agent_sessions WHERE id = $1", [sessionId]);
  return !!s && s.simulation_id === auth.jobId;
}

/** Whether `auth` may speak for orchestrator `orchestratorId` (a job token: only the orchestrator it was minted for). */
export async function canActAsOrchestrator(auth: WorkerAuth, orchestratorId: string): Promise<boolean> {
  if (auth.kind === "fleet") return true;
  if (auth.kind !== "job") return false; // a run token acts on its run only
  if (auth.sandboxRowId == null) return false;
  const [r] = await (await getDb()).query<{ orchestrator_id: string | null }>(
    "SELECT orchestrator_id FROM orchestrator_sandboxes WHERE id = $1", [auth.sandboxRowId]);
  return !!r?.orchestrator_id && r.orchestrator_id === orchestratorId;
}
