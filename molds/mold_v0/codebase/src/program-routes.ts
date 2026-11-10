/**
 * Programs and acceptance over HTTP (mold_v0-291, flag nested_runs). Mounted only while it is on.
 *
 *   staff, /api/admin/onboarding/programs: any staff role reads; a change needs need("compute"), a review or rollback too.
 *     GET  /programs                         every program, the evaluations and the champion versions
 *     GET  /programs/:id                     one: its config and versions
 *     GET  /programs/:id/versions/:v         one version as saved
 *     POST /programs                         {id?, name, description?, config, note?}
 *     PUT  /programs/:id                     {version, name?, description?, config, note?} (409: someone saved first)
 *     POST /programs/:id/archive | /restore
 *     GET  /program-evaluations              every workspace's decisions, ?program= &target=
 *     POST /program-evaluations/:id/review   {decision: accept | decline, reason} an outcome that needs a person
 *     GET  /program-champions                the versions, ?target=
 *     POST /program-champions/:id/rollback   {reason}: the version before becomes the champion again
 *     POST /program-champions/:id/apply      {ref?}: a person applies it (a recipe: a proposal staff accept in Recipes)
 *
 *   the workspace, /api/agent (the person's own tree): GET /:id/tree  its children; POST /:id/children/:handle/cancel
 */
import { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { PackError } from "./pack-api.js";
import { log } from "./admin.js";
import * as P from "./programs.js";
import * as N from "./nested-runs.js";
import type { Actor } from "./harness-sessions.js";
import * as D from "./agent-dock.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { const v = await fn(req, res); if (!res.headersSent) res.status(status).json(v); }
  catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
};

export function programAdminRoutes(ob: Router, need: (p: "compute") => RequestHandler, who: (req: Request, res: Response) => string) {
  if (!P.programsOn()) return;
  const id = (req: Request) => String(req.params.id);
  ob.get("/programs", answer(async () => ({ programs: await P.listPrograms(), evaluations: await N.listEvaluations(null), champions: await N.listChampions(null) })));
  ob.get("/programs/:id", answer(async (req) => ({ program: await P.readProgram(id(req)), evaluations: await N.listEvaluations(null, { program: id(req) }) })));
  ob.get("/programs/:id/versions/:v", answer(async (req) => ({ version: await P.readProgramVersion(id(req), Number(req.params.v)) })));
  ob.post("/programs", need("compute"), answer(async (req, res) => { const p = await P.createProgram(who(req, res), req.body ?? {}); log(who(req, res), "program.create", null, { program: p.id, version: p.version }); return { program: p }; }, 201));
  ob.put("/programs/:id", need("compute"), answer(async (req, res) => { const p = await P.updateProgram(who(req, res), id(req), req.body ?? {}); log(who(req, res), "program.update", null, { program: p.id, version: p.version }); return { program: p }; }));
  for (const [path, archived] of [["archive", true], ["restore", false]] as const) ob.post(`/programs/:id/${path}`, need("compute"), answer(async (req, res) => { const p = await P.setProgramArchived(who(req, res), id(req), archived); log(who(req, res), `program.${path}`, null, { program: p.id }); return { program: p }; }));
  ob.get("/program-evaluations", answer(async (req) => ({ evaluations: await N.listEvaluations(null, { program: req.query.program ? String(req.query.program) : undefined, target: req.query.target ? String(req.query.target) : undefined }) })));
  ob.post("/program-evaluations/:id/review", need("compute"), answer(async (req, res) => { const e = await N.reviewEvaluation(who(req, res), id(req), req.body ?? {}); log(who(req, res), "program.evaluation_review", e.workspace ?? null, { evaluation: e.id, decision: e.review_decision }); return { evaluation: e }; }));
  ob.get("/program-targets/:id", answer(async (req) => D.targetHistory(null, String(req.params.id))));
  ob.get("/program-champions", answer(async (req) => ({ champions: await N.listChampions(null, { target: req.query.target ? String(req.query.target) : undefined }) })));
  ob.post("/program-champions/:id/rollback", need("compute"), answer(async (req, res) => { const c = await N.rollbackChampion(who(req, res), id(req), req.body ?? {}); log(who(req, res), "program.champion_rollback", c.workspace ?? null, { version: c.id, reason: String((req.body ?? {}).reason ?? "").slice(0, 300) }); return { champion: c }; }));
  ob.post("/program-champions/:id/apply", need("compute"), answer(async (req, res) => { const c = await N.applyChampion(who(req, res), id(req), req.body ?? {}); log(who(req, res), "program.champion_apply", c.workspace ?? null, { version: c.id, ref: c.applied_ref }); return { champion: c }; }));
}

/** The dock and the runs (mold_v0-292): whole-workspace paths, mounted ahead of /:id. */
export function programDockRoutes(r: Router, orgOf: (res: Response) => number) {
  if (!N.nestedOn()) return;
  r.get("/dock", answer(async (_req, res) => D.dockSections(orgOf(res))));
  r.get("/dock/:section", answer(async (req, res) => D.dockSection(orgOf(res), String(req.params.section))));
  r.get("/runs", answer(async (_req, res) => ({ runs: await D.activeRuns(orgOf(res)) })));
  r.get("/targets/:id", answer(async (req, res) => D.targetHistory(orgOf(res), String(req.params.id))));
}

/** The workspace's own tree of a session (src/agent-routes.ts mounts it). */
export function programAppRoutes(r: Router, orgOf: (res: Response) => number, actorOf: (res: Response) => Actor) {
  if (!N.nestedOn()) return;
  r.get("/:id/tree", answer(async (req, res) => { const { root, children } = await N.readTree(orgOf(res), String(req.params.id), actorOf(res)); return { root: { id: root.id, ref: root.nested?.ref ?? null, phase: root.phase, budget_usd: root.budget_usd, spent_usd: root.spent_usd, remaining_usd: root.remaining_usd }, children }; }));
  r.get("/:id/run", answer(async (req, res) => ({ run: await D.runDetail(orgOf(res), String(req.params.id), actorOf(res)) })));
  // A second agent from a point in this conversation: a session of its own, the transcript up to there as its context.
  r.post("/:id/fork", answer(async (req, res) => { res.status(201); return { session: await (await import("./harness-sessions.js")).forkSession(orgOf(res), String(req.params.id), actorOf(res), req.body ?? {}) }; }));
  r.post("/:id/children/:handle/cancel", answer(async (req, res) => {
    const a = actorOf(res), org = orgOf(res);
    const mine = await (await import("./harness-sessions.js")).readSession(org, String(req.params.id), a);
    if (!mine.can.stop) throw new PackError("Only the person who started this session or an owner can cancel its children", 403);
    return { child: await N.cancelChild({ orgId: org, sessionId: String(req.params.id), runId: null, role: null }, req.params.handle, "cancelled by a person") };
  }));
}
