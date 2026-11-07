/**
 * The console's routes of mold_v0-260's home cards and run analytics (src/run-analytics.ts; molds/mold_v0/MOLD.md
 * "Generic gaps"), each mounted only while its flag is on (off: nothing here answers, the request passes on to the 404):
 *
 *   GET /api/home/recent-runs     (overview_cards) the workspace's latest runs, any signed-in person
 *   GET /api/home/attention       (overview_cards) the records whose warning or danger notices hold, as the person reads
 *   GET /api/analytics/runs       (run_analytics) ?from=&to=&kind=&status=: the workspace's runs broken down; its billing
 *                                 managers and owners (the "billing" permission: everyone's spend, as Billing)
 *
 * The workspace is the session's, never an input. The staff view is src/http.ts's /api/admin/onboarding/run-analytics.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import { featureOn } from "./features.js";
import { PackError } from "./pack-api.js";
import { byWords } from "./record-page-routes.js";
import { attention, recentRuns, runAnalytics } from "./run-analytics.js";

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
};
const S = (res: Response) => res.locals.session as Session;

export function homeCardsRouter(): Router {
  const r = express.Router();
  r.use((_req, _res, next) => (featureOn("overview_cards") ? next() : next("router")));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/recent-runs", answer(async (_req, res) => ({ runs: await recentRuns(S(res).org, await byWords(S(res))) })));
  r.get("/attention", answer(async (_req, res) => attention(S(res).org, { role: S(res).accountRole ?? null, userId: S(res).user ?? null })));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

export function runAnalyticsRouter(): Router {
  const r = express.Router();
  r.use((_req, _res, next) => (featureOn("run_analytics") ? next() : next("router")));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/runs", answer(async (req, res) => {
    if (!canAccount(S(res).accountRole, "billing")) throw new PackError(accountRefusal("billing").message, 403);
    return runAnalytics({ orgId: S(res).org, actor: { role: S(res).accountRole ?? null, userId: S(res).user ?? null }, who: await byWords(S(res)) }, req.query as Record<string, unknown>);
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
