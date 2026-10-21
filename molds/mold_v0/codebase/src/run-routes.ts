/**
 * The run engine's worker API (mold_v0-041; src/runs.ts, src/run-harness.ts): /api/worker/runs, inside the worker
 * router (src/http.ts), so the worker token is checked first. Runs are claimed with the fleet token only (a job token
 * is bound to one simulation and never claims runs). Every step after the claim also needs the run's lease token
 * (header X-Run-Lease): a runner can act only on the attempt it holds.
 *
 *   POST /claim               {worker_id, kinds?: ["pack/kind"]} -> {run: Claim | null}
 *   POST /:id/heartbeat       -> {lease_expires_at, cancel, reason}
 *   POST /:id/events          {events: [{type, data}]} -> {appended}
 *   POST /:id/complete        {outcome, error_kind?, error?, results?} -> {run}
 *   GET  /:id/workspace       the run's own workspace store, latest snapshot, as a bundle (src/workspace-bundle.ts);
 *                             headers X-Workspace-Version, X-Workspace-Manifest-Sha256 (mold_v0-033)
 *   PUT  /:id/workspace       a bundle (application/octet-stream): staged, committed only when the run succeeds
 *   GET  /:id/credentials     the workspace credentials the run receives (mold_v0-034; src/credentials.ts):
 *                             {credentials: [{name, env | file, value}], missing: [name]}. Never cached, never logged.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { PackError } from "./pack-api.js";
import { appendRunEvents, claimRun, completeRun, heartbeatRun, leasedRun, runCredentialsForLease } from "./runs.js";
import { checkoutBundle, stageBundle } from "./workspace-store.js";
import type { WorkerAuth } from "./workerauth.js";

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (!res.headersSent) res.json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    const status = (e as { status?: number }).status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: (e as Error).message });
    next(e);
  }
};
const leaseOf = (req: Request) => String(req.get("x-run-lease") ?? "");

export function runWorkerRouter(): Router {
  const r = express.Router();
  r.use((_req, res, next) => ((res.locals.worker as WorkerAuth | undefined)?.kind === "fleet" ? next()
    : void res.status(403).json({ error: "Runs are served with the fleet worker token" })));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.post("/claim", answer(async (req) => {
    const { worker_id, kinds } = (req.body ?? {}) as { worker_id?: unknown; kinds?: unknown };
    return { run: await claimRun(String(worker_id ?? ""), { kinds: Array.isArray(kinds) ? kinds.map(String) : undefined }) };
  }));
  r.post("/:id/heartbeat", answer((req) => heartbeatRun(String(req.params.id), leaseOf(req))));
  r.post("/:id/events", answer((req) => appendRunEvents(String(req.params.id), leaseOf(req), (req.body ?? {}).events)));
  r.post("/:id/complete", answer(async (req) => ({ run: await completeRun(String(req.params.id), leaseOf(req), req.body ?? {}) })));
  r.get("/:id/workspace", answer(async (req, res) => {
    const out = await checkoutBundle(await leasedRun(String(req.params.id), leaseOf(req)));
    res.set({ "content-type": "application/octet-stream", "x-workspace-version": String(out.version), "x-workspace-manifest-sha256": out.manifest_sha256 });
    res.end(out.bundle);
  }));
  r.get("/:id/credentials", answer((req) => runCredentialsForLease(String(req.params.id), leaseOf(req))));
  const maxBundle = Number(process.env.OCTILLION_WORKSPACE_MAX_BUNDLE_BYTES ?? 300 * 1024 * 1024);
  r.put("/:id/workspace", express.raw({ type: "application/octet-stream", limit: maxBundle }), answer(async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new PackError("send the workspace as application/octet-stream", 400);
    return stageBundle(await leasedRun(String(req.params.id), leaseOf(req)), req.body);
  }));
  return r;
}
