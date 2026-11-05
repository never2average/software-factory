/**
 * The workspace agent over HTTP (mold_v0-243; src/harness-sessions.ts). Nothing is mounted unless the app's profile
 * turns `agent_harness` on: every path answers not found as before.
 *
 *   the workspace (/api/agent; the console's session, X-Pack-Request: 1 on a change made with the cookie)
 *     GET    /                      its sessions (newest activity first), and whether this person may start one
 *     POST   /                      {message, title?, mode?: conversation | task} start one (a member or more)
 *     GET    /:id                   one session: its transcript, requests, budget raises and wakes
 *     POST   /:id/messages          {message} the person who started it: guidance mid-run, or a wake
 *     POST   /:id/pause | /resume | /stop
 *     POST   /:id/requests/:rid     {decision: approve | decline, reason?}
 *     POST   /:id/budget            {to_usd | by_usd, reason} a billing manager or owner; never while it works
 *
 *   staff (/api/admin/agent, agentAdminRoutes): GET / (every workspace's), GET /:id, POST /:id/pause, /:id/stop,
 *   /:id/budget ("accounts"), /:id/requests/:rid (decline only). Staff never message a session: it acts for the
 *   person who started it. Every staff call is in the staff console's log (and the platform trail when it is on).
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { PackError } from "./pack-api.js";
import { agentHarnessOn, flavourOf } from "./agent-harness-config.js";
import { canAccount } from "./account-roles.js";
import { settingNumber, settingText } from "./settings.js";
import * as H from "./harness-sessions.js";

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { const v = await fn(req, res); if (!res.headersSent) res.json(v); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/** What the console shows above the list: the settings a new session would take, in words. */
export function agentOffer() {
  const f = flavourOf(settingText("AGENT_HARNESS"));
  return { harness: f?.label ?? settingText("AGENT_HARNESS"), model: settingText("AGENT_MODEL"), steerable: f?.holds_stdin_open !== false,
    budget_usd: settingNumber("AGENT_SESSION_BUDGET_USD"), ceiling_usd: settingNumber("AGENT_BUDGET_CEILING_USD"), web_tools: settingText("AGENT_WEB_TOOLS"),
    park_after_minutes: settingNumber("AGENT_PARK_AFTER_MINUTES") };
}

export function agentAppRouter(): Router {
  const r = express.Router();
  if (!agentHarnessOn()) return r; // off: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "64kb" }));
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const actor = (res: Response) => H.actorOf(S(res));
  const org = (res: Response) => { const s = S(res); return { orgId: s.org, slug: s.slug, name: "", userId: s.user ?? undefined, role: s.accountRole }; };
  const id = (req: Request) => String(req.params.id);
  r.get("/", answer(async (_req, res) => ({ sessions: await H.listSessions(S(res).org, actor(res)), can_start: canAccount(S(res).accountRole, "launch"), offer: agentOffer() })));
  r.post("/", answer(async (req, res) => { res.status(201); return { session: await H.startSession(S(res).org, actor(res), req.body ?? {}, org(res)) }; }));
  r.get("/:id", answer(async (req, res) => ({ session: await H.readSession(S(res).org, id(req), actor(res)) })));
  r.post("/:id/messages", answer(async (req, res) => H.messageSession(S(res).org, id(req), actor(res), (req.body ?? {}).message, org(res))));
  r.post("/:id/pause", answer(async (req, res) => ({ session: await H.pauseSession(S(res).org, id(req), actor(res)) })));
  r.post("/:id/resume", answer(async (req, res) => ({ session: await H.resumeSession(S(res).org, id(req), actor(res), org(res)) })));
  r.post("/:id/stop", answer(async (req, res) => ({ session: await H.stopSession(S(res).org, id(req), actor(res)) })));
  r.post("/:id/requests/:rid", answer(async (req, res) => ({ session: await H.decideRequest(S(res).org, id(req), String(req.params.rid), actor(res), (req.body ?? {}).decision, (req.body ?? {}).reason, org(res)) })));
  r.post("/:id/budget", answer(async (req, res) => ({ session: await H.raiseBudget(S(res).org, id(req), actor(res), req.body ?? {}, org(res)) })));
  return r;
}

type Need = (p: "accounts") => express.RequestHandler;
/** Staff: every workspace's sessions; pause, stop, raise (with a reason) and decline. Logged as every staff action. */
export function agentAdminRoutes(admin: Router, need: Need, who: (req: Request, res: Response) => string) {
  if (!agentHarnessOn()) return;
  const actor = (req: Request, res: Response) => H.staffActor(who(req, res));
  const id = (req: Request) => String(req.params.id);
  admin.get("/agent", answer(async (req, res) => ({ sessions: await H.listSessions(null, actor(req, res)), offer: agentOffer() })));
  admin.get("/agent/:id", answer(async (req, res) => ({ session: await H.readSession(null, id(req), actor(req, res)) })));
  admin.post("/agent/:id/pause", need("accounts"), answer(async (req, res) => {
    const s = await H.pauseSession(null, id(req), actor(req, res));
    log(who(req, res), "agent.pause", s.workspace?.slug ?? null, { session: s.id });
    return { session: s };
  }));
  admin.post("/agent/:id/stop", need("accounts"), answer(async (req, res) => {
    const s = await H.stopSession(null, id(req), actor(req, res));
    log(who(req, res), "agent.stop", s.workspace?.slug ?? null, { session: s.id });
    return { session: s };
  }));
  admin.post("/agent/:id/budget", need("accounts"), answer(async (req, res) => {
    const s = await H.raiseBudget(null, id(req), actor(req, res), req.body ?? {});
    log(who(req, res), "agent.budget_raised", s.workspace?.slug ?? null, { session: s.id, to_usd: s.budget_usd, reason: String(req.body?.reason ?? "").slice(0, 300) });
    return { session: s };
  }));
  admin.post("/agent/:id/requests/:rid", need("accounts"), answer(async (req, res) => {
    const s = await H.decideRequest(null, id(req), String(req.params.rid), actor(req, res), (req.body ?? {}).decision, (req.body ?? {}).reason);
    log(who(req, res), "agent.request_declined", s.workspace?.slug ?? null, { session: s.id, request: String(req.params.rid).slice(0, 40) });
    return { session: s };
  }));
}
