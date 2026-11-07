/**
 * The workspace agent over HTTP (mold_v0-243; src/harness-sessions.ts). Nothing is mounted unless the app's profile
 * turns `agent_harness` on: every path answers not found as before.
 *
 *   the workspace (/api/agent; the console's session, X-Pack-Request: 1 on a change made with the cookie)
 *     GET    /                      its sessions (newest activity first), and whether this person may start one
 *     POST   /                      {message, title?, mode?: conversation | task, budget_usd?} start one (a member or more;
 *                                    a budget up to the setting's, or the ceiling for a billing manager or owner)
 *     GET    /:id                   one session: its transcript, requests, budget raises and wakes
 *     POST   /:id/messages          {message} the person who started it: guidance mid-run, or a wake
 *     POST   /:id/pause | /resume | /stop
 *     POST   /:id/requests/:rid     {decision: approve | decline, reason?}
 *     POST   /:id/budget            {to_usd | by_usd, reason} a billing manager or owner; never while it works
 *     GET    /icon                  the workspace's own agent icon (mold_v0-252; src/agent-icon.ts) or null, and whether
 *                                    this person may change it (an owner)
 *     PUT    /icon                  an owner: the icon's bytes (application/octet-stream, at most 256 KB; its declared
 *                                    type in X-File-Type), checked by what they are, sealed with the workspace's key
 *     DELETE /icon                  an owner: back to the app's icon
 *
 *   staff (/api/admin/agent, agentAdminRoutes): GET / (every workspace's), GET /:id, POST /:id/pause, /:id/stop,
 *   /:id/budget ("accounts"), /:id/requests/:rid (decline only). Staff never message a session: it acts for the
 *   person who started it. Every staff call is in the staff console's log (and the platform trail when it is on).
 *
 *   agent profiles (mold_v0-261; src/agent-profiles.ts), staff at /api/admin/agent-profiles:
 *     GET    /                      every profile, and what the editor offers: the priced models, the app's tools (read
 *                                    or not), the workspaces an override may name, the platform settings a profile inherits
 *     GET    /:id                   one profile: its config, what it resolves to, its versions and its changes
 *     GET    /:id/versions/:v       one version as it was saved
 *     POST   /                      {name, id?, description?, config? | copy_of?} a new profile ("compute")
 *     PUT    /:id                   {version, name?, description?, config} a new version ("compute"; 409 when the
 *                                    version edited is not the latest)
 *     POST   /:id/archive | /restore ("compute"; the Default is never archived)
 *   The customer's GET /api/agent lists the profiles this person may start (the Start a session dialog's picker), and
 *   POST /api/agent takes {profile}.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { PackError } from "./pack-api.js";
import { agentHarnessOn, flavourOf } from "./agent-harness-config.js";
import { canAccount } from "./account-roles.js";
import { settingNumber, settingText } from "./settings.js";
import * as H from "./harness-sessions.js";
import { AGENT_ICON_MAX_BYTES, readAgentIcon, resetAgentIcon, saveAgentIcon } from "./agent-icon.js";
import * as P from "./agent-profiles.js";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";

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
    park_after_minutes: settingNumber("AGENT_PARK_AFTER_MINUTES"),
    // mold_v0-250: which of the workspace's own tools a new session uses without asking (the rest ask the person first).
    workspace_tools: settingText("AGENT_WORKSPACE_TOOLS") };
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
  // The offer carries this person's own budget range for the start dialog (mold_v0-249): the default, and how far they may go.
  // mold_v0-261: the agent profiles this person may start, each with its model and their budget range under it.
  r.get("/", answer(async (_req, res) => ({ sessions: await H.listSessions(S(res).org, actor(res)), can_start: canAccount(S(res).accountRole, "launch"),
    offer: { ...agentOffer(), budget: await H.startBudgetMax(S(res).org, actor(res)) },
    profiles: canAccount(S(res).accountRole, "launch") || !S(res).user ? await P.startableProfiles(S(res).slug, actor(res), (eff) => H.startBudgetMax(S(res).org, actor(res), eff)) : [] })));
  // The workspace's own agent icon (mold_v0-252), ahead of /:id. Every person of the workspace sees it; its owners change it.
  const owner = (_req: Request, res: Response, next: NextFunction) =>
    (canAccount(S(res).accountRole, "manage") ? next() : void res.status(403).json({ error: "Only the workspace's owners change its agent icon." }));
  r.get("/icon", answer(async (_req, res) => ({ icon: await readAgentIcon(S(res).org), can_change: canAccount(S(res).accountRole, "manage"), max_bytes: AGENT_ICON_MAX_BYTES })));
  r.put("/icon", owner, (req: Request, res: Response, next: NextFunction) => (req.is("application/octet-stream") ? next() : void res.status(415).json({ error: "Send the icon's bytes as application/octet-stream" })),
    express.raw({ type: "application/octet-stream", limit: AGENT_ICON_MAX_BYTES }),
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
      (err ? void res.status(err.type === "entity.too.large" ? 413 : err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? `An icon is at most ${AGENT_ICON_MAX_BYTES / 1024} KB` : "The request body could not be read" }) : next()),
    answer(async (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return { icon: await saveAgentIcon(S(res).org, S(res).email ?? S(res).user, data, String(req.get("x-file-type") ?? "")) };
    }));
  r.delete("/icon", owner, answer(async (_req, res) => { await resetAgentIcon(S(res).org); return { icon: null }; }));
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

type Need = (p: "accounts" | "compute") => express.RequestHandler;
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

  // ---------- agent profiles (mold_v0-261) ----------
  admin.get("/agent-profiles", answer(async () => ({ profiles: await P.listProfiles(), ...(await profileEditorFacts()) })));
  admin.get("/agent-profiles/:id", answer(async (req) => ({ profile: await P.readProfile(id(req)) })));
  admin.get("/agent-profiles/:id/versions/:v", answer(async (req) => ({ version: await P.profileVersion(id(req), Number(req.params.v)) })));
  admin.post("/agent-profiles", need("compute"), answer(async (req, res) => {
    const p = await P.createProfile(who(req, res), req.body ?? {});
    log(who(req, res), "agent_profile.create", null, { profile: p.id, version: p.version });
    res.status(201);
    return { profile: p };
  }));
  admin.put("/agent-profiles/:id", need("compute"), answer(async (req, res) => {
    const p = await P.updateProfile(who(req, res), id(req), req.body ?? {});
    log(who(req, res), "agent_profile.update", null, { profile: p.id, version: p.version, changed: p.changes[0]?.changed ?? [] });
    return { profile: p };
  }));
  for (const [path, archived] of [["archive", true], ["restore", false]] as const) admin.post(`/agent-profiles/:id/${path}`, need("compute"), answer(async (req, res) => {
    const p = await P.setProfileArchived(who(req, res), id(req), archived);
    log(who(req, res), `agent_profile.${path}`, null, { profile: p.id, version: p.version });
    return { profile: p };
  }));
}

/**
 * What the profile editor offers (mold_v0-261): the priced models (a profile takes only those), the app's own tools as an
 * owner is offered them (each a read or not), the workspaces an override may name, and the platform settings a profile
 * inherits where it leaves a setting unset.
 */
async function profileEditorFacts() {
  const db = await asPlatform(() => getDb());
  const models = (await asPlatform(() => db.query<{ model: string }>("SELECT model FROM model_prices ORDER BY model"))).map((m) => m.model);
  const workspaces = await asPlatform(() => db.query<{ slug: string; name: string }>("/* tenant: platform staff, every workspace's slug and name (an override's picker) */ SELECT slug, name FROM organizations ORDER BY lower(name), slug LIMIT 1000"));
  let tools: { name: string; title: string | null; read: boolean }[] = [];
  try {
    const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
      import("./server.js"), import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/inMemory.js")]);
    // As a workspace's owner is offered them (no workspace is read: listing a tool reads nothing); the agent's own session tools left out.
    const server = createServer({ orgId: 0, slug: "", name: "", role: "owner", userId: "agent-profile-editor", agentSession: { session: "", allowed: [] } });
    const client = new Client({ name: "agent-profile-editor", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try { tools = (await client.listTools()).tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? null, read: t.annotations?.readOnlyHint === true })); }
    finally { await client.close(); }
  } catch (e) { console.error(`agent profiles: the app's tools could not be listed (${(e as Error).message})`); }
  const s = P.effectiveOf({});
  return { models, tools, workspaces, roles: ["member", "billing", "owner"], settings: { model: s.model, provider: s.provider, budget_usd: s.budget_usd, ceiling_usd: s.ceiling_usd,
    max_turns: s.max_turns, wake_max_minutes: s.wake_max_minutes, web: s.web, tools: { base: s.tools.base, free: s.tools.free } } };
}
