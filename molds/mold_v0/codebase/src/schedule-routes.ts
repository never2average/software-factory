/**
 * Schedules and notices over HTTP (mold_v0-035; src/schedules.ts): the data behind the console's /app/schedules and
 * /app/notices pages. With no job kind in the build /api/schedules mounts nothing; with no due area /api/notices does not.
 *
 *   GET    /api/schedules          a signed-in person of the workspace: its schedules (the packs' defaults copied in),
 *                                  the job kinds and asset areas one may name, whether they may change them
 *   POST   /api/schedules          {pack, job_kind, name, cron, assets?, environment?, label?, enabled?}: add one ("manage"), for a
 *                                  kind the pack itself schedules, with the scope of the pack's own schedule of it
 *   PATCH  /api/schedules/:id      {cron?, enabled?, assets?, environment?, label?}: change one ("manage"; never the scope)
 *   DELETE /api/schedules/:id      remove one the workspace added ("manage"; a pack's default is turned off instead)
 *   GET    /api/notices            a signed-in person of the workspace: its notices (?all=1 with dismissed ones)
 *   POST   /api/notices/:id/dismiss  ("edit")
 *
 * The workspace is always the session's (src/app.ts customerSession): an id of another workspace's schedule or notice is
 * simply not found. A change made with the session cookie carries X-Pack-Request: 1 (CSRF, as the packs' routes).
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount, type AccountPermission } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { PackError } from "./pack-api.js";
import { recordAreas } from "./record-areas.js";
import { createSchedule, deleteSchedule, dismissNotice, dueAreas, listNotices, listSchedules, schedulableKinds, schedulesWired, updateSchedule } from "./schedules.js";

function base(r: Router) {
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "96kb" }));
  // The body parser's own error text quotes the body: answer without it.
  r.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  });
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
}
const S = (res: Response) => res.locals.session as Session;
const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;
const may = (res: Response, p: AccountPermission) => { if (!canAccount(S(res).accountRole, p)) throw new PackError(accountRefusal(p).message, 403); };
const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (v === undefined) return void res.status(204).end();
    res.json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

export function scheduleAppRouter(): Router {
  const r = express.Router();
  if (!schedulesWired()) return r; // no job kind: nothing is mounted, nothing answers
  base(r);
  r.get("/", answer(async (_req, res) => ({
    schedules: await listSchedules(S(res).org),
    kinds: schedulableKinds(),
    asset_areas: recordAreas().filter((a) => a.role === "asset" && a.scope === "workspace").map((a) => ({ pack: a.pack, name: a.name, label: a.label })),
    timezone: "UTC",
    can_manage: canAccount(S(res).accountRole, "manage"),
  })));
  r.post("/", answer(async (req, res) => {
    may(res, "manage");
    // A kind whose start tool its pack withholds (mold_v0-067) cannot be scheduled by the workspace either; the pack's
    // own default schedules are its declaration and still fire.
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { withheldTools } = await import("./mcp-withheld.js");
    if (withheldTools().some((w) => w.op === "start" && w.door === "workspace" && w.kind === b.job_kind && (b.pack === undefined || w.pack === b.pack)))
      throw new PackError(`no job kind ${String(b.job_kind).slice(0, 64)} to schedule`, 404);
    const out = await createSchedule(S(res).org, who(res), (req.body ?? {}) as Record<string, unknown>);
    log(who(res), "schedule.add", S(res).slug, { pack: out.pack, name: out.name, job_kind: out.job_kind, cron: out.cron });
    return out;
  }));
  r.patch("/:id", answer(async (req, res) => {
    may(res, "manage");
    const out = await updateSchedule(S(res).org, String(req.params.id), who(res), (req.body ?? {}) as Record<string, unknown>);
    log(who(res), "schedule.change", S(res).slug, { pack: out.pack, name: out.name, cron: out.cron, enabled: out.enabled });
    return out;
  }));
  r.delete("/:id", answer(async (req, res) => {
    may(res, "manage");
    if (!(await deleteSchedule(S(res).org, String(req.params.id)))) throw new PackError("no such schedule", 404);
    log(who(res), "schedule.remove", S(res).slug, { id: String(req.params.id) });
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

export function noticeAppRouter(): Router {
  const r = express.Router();
  if (!dueAreas().length) return r; // no due area: nothing is mounted, nothing answers
  base(r);
  r.get("/", answer(async (req, res) => ({ notices: await listNotices(S(res).org, { all: req.query.all === "1", actor: { role: S(res).accountRole, userId: S(res).user } }) })));
  r.post("/:id/dismiss", answer(async (req, res) => {
    may(res, "edit");
    if (!(await dismissNotice(S(res).org, String(req.params.id), who(res)))) throw new PackError("no such notice", 404);
    return { dismissed: true };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
