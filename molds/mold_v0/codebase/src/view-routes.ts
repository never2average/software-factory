/**
 * What the console's declared tabs read (mold_v0-063, mold_v0-058), for a signed-in person of a workspace (the portal's
 * session check, src/app.ts; the request then runs under the workspace's row-level security). Read only: nothing here
 * writes. Mounted only when the build has what they serve, so with zero packs nothing answers.
 *
 *   GET /api/metrics?names=a,b     the metrics (src/metrics.ts), each as the person's role may read it (a refusal per
 *                                  metric, so one chart the role may not see never hides the others)
 *   GET /api/runs                  the workspace's runs, newest first (?limit, at most 200), with each run's result
 *                                  counts by status (the Runs and Reports tabs)
 *   GET /api/runs/:id              one run of the workspace and its results
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { customerSession, type Session } from "./app.js";
import { getDb } from "./db.js";
import { PackError } from "./pack-api.js";
import { buildViews, computeMetrics, MAX_METRICS_PER_REQUEST } from "./metrics.js";
import { packOpWithheld } from "./mcp-withheld.js";
import { packs } from "./packs.js";

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const session = (res: Response) => res.locals.session as Session;
const actor = (res: Response) => { const s = session(res); return { role: s.accountRole ?? null, userId: s.user ?? null }; };

/** /api/metrics: mounted when a pack declares a metric. */
export function metricAppRouter(): Router {
  const r = express.Router();
  if (!buildViews().metrics.length) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/", answer(async (req, res) => {
    const raw = typeof req.query.names === "string" ? req.query.names : "";
    const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
    if (!names.length) throw new PackError("names: the metrics to compute, comma-separated", 400);
    if (names.length > MAX_METRICS_PER_REQUEST || names.some((n) => !/^[a-z][a-z0-9_]{1,62}$/.test(n))) throw new PackError(`names: up to ${MAX_METRICS_PER_REQUEST} metric names`, 400);
    // A pack that withholds its metrics tool (mold_v0-067) withholds its metrics here too: as if they did not exist.
    const held = new Set(buildViews().metrics.filter((m) => packOpWithheld(m.pack, "metrics")).map((m) => m.name));
    if (names.some((n) => held.has(n))) throw new PackError(`no metric ${names.find((n) => held.has(n))}`, 404);
    return { metrics: await computeMetrics(session(res).org, names, actor(res)) };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** /api/runs: mounted when the build has a job kind. The workspace is the session's, never the request's. */
export function runAppRouter(): Router {
  const r = express.Router();
  if (!packs().some((p) => (p.definition.jobKinds?.length ?? 0) + (p.definition.agentJobKinds?.length ?? 0) > 0)) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/", answer(async (req, res) => {
    const { listRuns } = await import("./runs.js");
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PackError("limit is 1 to 200", 400);
    const org = session(res).org;
    // The runs of a pack that withholds its list tool (mold_v0-067) are not listed here either.
    const runs = (await listRuns(org, { limit })).filter((x) => !packOpWithheld(x.pack, "list_runs"));
    const counts = runs.length ? await (await getDb()).query<{ run_id: string; status: string; n: number }>(
      "SELECT run_id, status, count(*)::int AS n FROM run_results WHERE org_id = $1 AND run_id = ANY ($2::text[]) GROUP BY 1, 2", [org, runs.map((x) => x.id)]) : [];
    // A pack that withholds its results tool (mold_v0-067) shows no result counts either.
    return { runs: runs.map((x) => ({ ...x, results: packOpWithheld(x.pack, "run_results") ? {} : Object.fromEntries(counts.filter((c) => c.run_id === x.id).map((c) => [c.status, c.n])) })) };
  }));
  // mold_v0-079: a preview's approval, by the workspace's owner, signed in (a key never approves: an agent holding one
  // cannot say yes for a person). Only when a kind of the build waits for one.
  if (packs().some((p) => [...(p.definition.jobKinds ?? []), ...(p.definition.agentJobKinds ?? [])].some((k) => (k as { approval?: unknown }).approval))) {
    r.use(express.json({ limit: "4kb" }));
    r.get("/:id/approval", answer(async (req, res) => {
      const id = String(req.params.id);
      if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new PackError("Not found", 404);
      const { approvalView } = await import("./run-approvals.js");
      return approvalView(session(res).org, id);
    }));
    r.post("/:id/approve", answer(async (req, res) => {
      if (res.locals.viaCookie && req.get("x-pack-request") !== "1") throw new PackError("Missing X-Pack-Request header", 403);
      const s = session(res);
      if (s.accountRole !== "owner") throw new PackError("Only the workspace's owner approves a preview", 403);
      const id = String(req.params.id);
      if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new PackError("Not found", 404);
      const { approvePreview } = await import("./run-approvals.js");
      const { log } = await import("./admin.js");
      const who = `customer:${s.email ?? s.user ?? s.slug}`;
      const a = await approvePreview(s.org, id, (req.body ?? {}) as Record<string, unknown>, { role: "owner", by: who });
      log(who, "run.approve", s.slug, { run: id, approval: a.id, kind: a.write_kind, sha256: a.output_sha256 });
      return { approval: a };
    }));
  }
  r.get("/:id", answer(async (req, res) => {
    const { getRun, runResults } = await import("./runs.js");
    const id = String(req.params.id);
    if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new PackError("Not found", 404);
    const run = await getRun(session(res).org, id);
    // A run of a pack that withholds its status and results tools (mold_v0-067) is not shown here either.
    if (!run || (packOpWithheld(run.pack, "run_status") && packOpWithheld(run.pack, "run_results"))) throw new PackError("Not found", 404);
    // A result names records: one whose check the person may not read is left out; an asset or source they may not read
    // is not named (the read permission of each area, mold_v0-057, as on /api/records).
    const { findArea, may } = await import("./record-areas.js");
    const readable = (x: { area: string } | null) => !x || (() => { const a = findArea(x.area); return !!a && may(a, "read", actor(res)); })();
    const results = (await runResults(session(res).org, id)).filter((x) => readable(x.check)).slice(0, 2000)
      .map((x) => ({ ...x, asset: readable(x.asset) ? x.asset : null, source: readable(x.source) ? x.source : null }));
    // Each part as its tool (mold_v0-067): a withheld results tool withholds the results, a withheld status tool the
    // run's status, cost and error (only which run it is stays, so the results have their run).
    const shownRun = packOpWithheld(run.pack, "run_status") ? { id: run.id, pack: run.pack, kind: run.kind } : run;
    return { run: shownRun, results: packOpWithheld(run.pack, "run_results") ? [] : results };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
