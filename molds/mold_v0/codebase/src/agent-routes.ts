/**
 * The workspace agent over HTTP (mold_v0-243; src/harness-sessions.ts). Nothing is mounted unless the app's profile
 * turns `agent_harness` on: every path answers not found as before.
 *
 *   the workspace (/api/agent; the console's session, X-Pack-Request: 1 on a change made with the cookie)
 *     GET    /                      its sessions (newest activity first), and whether this person may start one
 *     POST   /                      {message, title?, mode?: conversation | task, budget_usd?} start one (a member or more;
 *                                    a budget up to the setting's, or the ceiling for a billing manager or owner)
 *     GET    /:id                   one session: its transcript, requests, budget raises and wakes
 *     POST   /:id/messages          {message, files?, repositories?} the person who started it: guidance mid-run, or a wake
 *     GET    /composer?session=     what the composer offers (mold_v0-290; src/agent-composer.ts): attaching files and the
 *                                    workspace's repositories, with limits or the reason not; never a token
 *     POST   /files?session=        one file's bytes (application/octet-stream; X-File-Name, X-File-Type): a draft of this person
 *     DELETE /files/:file           a draft, before it is sent
 *     POST   /:id/pause | /resume | /stop
 *     POST   /:id/requests/:rid     {decision: approve | decline, reason?}
 *     POST   /:id/budget            {to_usd | by_usd, reason} a billing manager or owner: raises to the ceiling or lowers to
 *                                    what it has spent, while it works too (mold_v0-287)
 *     GET    /:id/trace?after=<c>   the session's trace: what it did and said, in order (mold_v0-287); after: the cursor of the last read
 *     GET    /:id/trace/stream      the same as a stream (server-sent events), from ?after=, until the connection or this
 *                                    request's time ends; the page reconnects with the last cursor
 *     GET    /:id/trace/:step       one step's full detail (a tool's arguments and result, secrets masked)
 *     GET    /icon                  the workspace's own agent icon (mold_v0-252; src/agent-icon.ts) or null
 *     PUT    /icon, DELETE /icon    refused (403): since mold_v0-262 platform staff set it, on the account's page
 *
 *   staff, an account's agent icon (mold_v0-262): GET /api/admin/onboarding/agent-icon/<slug>; PUT (the icon's bytes,
 *   application/octet-stream, at most 256 KB, its declared type in X-File-Type: checked by what they are, sealed with
 *   the workspace's key) and DELETE (back to the app's icon) for the accounts role, each in the staff log.
 *
 *   staff (/api/admin/agent, agentAdminRoutes): GET / (every workspace's), GET /:id, POST /:id/pause, /:id/stop,
 *   /:id/budget ("accounts"), /:id/requests/:rid (decline only). Staff never message a session: it acts for the
 *   person who started it. Every staff call is in the staff console's log (and the platform trail when it is on).
 *
 *   agent profiles (mold_v0-261; src/agent-profiles.ts), staff at /api/admin/agent-profiles:
 *     GET    /                      every profile, and what the editor offers (mold_v0-267): the harnesses this platform
 *                                    runs, the providers and their key vault entries, the priced models, the keys a session
 *                                    may be given, the app's tools (for a governance allowlist), the upload limit
 *     POST   /uploads               {bytes} start an upload ("compute"): its id and its parts (4 MiB each)
 *     PUT    /uploads/:id/parts/:n  a part's bytes (application/octet-stream); POST /uploads/:id/complete {sha256?}
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
import { sseStart } from "./docs-answers.js";
import { attachmentMaxBytes, removeDraftFile, storeDraftFile } from "./agent-composer.js";

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

/**
 * A session's trace as a stream (mold_v0-287): what is new, as a `data:` event each time, read from the database where
 * the engine writes it (no event bus: nothing else needs one, and a poll per open screen is one indexed read). Ends
 * before a hosted function's limit; the page reconnects from the cursor it last received. A first read that refuses (not
 * found, not on) answers with its status before the stream starts.
 */
const TRACE_STREAM_SECONDS = 240, TRACE_STREAM_LIVE_MS = 800, TRACE_STREAM_IDLE_MS = 3000;
const TRACE_LIVE = new Set(["starting", "working", "waiting", "waking"]);
function traceStream(read: (req: Request, res: Response, after: unknown) => Promise<H.TraceAnswer>) {
  return async (req: Request, res: Response) => {
    let after: unknown = req.query.after;
    const first = await read(req, res, after);
    sseStart(res);
    let closed = false;
    req.on("close", () => { closed = true; });
    let last = "", wrote = 0, cursor = first.cursor;
    const send = (a: H.TraceAnswer) => {
      after = a.cursor; cursor = a.cursor;
      const j = JSON.stringify(a);
      if (j === last) return;
      res.write(`data: ${j}\n\n`); last = j; wrote = Date.now();
    };
    send(first);
    let live = TRACE_LIVE.has(first.phase), more = first.more;
    const started = Date.now();
    while (!closed && Date.now() - started < TRACE_STREAM_SECONDS * 1000) {
      if (!more) await new Promise((r) => setTimeout(r, live ? TRACE_STREAM_LIVE_MS : TRACE_STREAM_IDLE_MS));
      if (closed) break;
      const a = await read(req, res, after).catch(() => null);
      if (!a) break;
      send(a);
      live = TRACE_LIVE.has(a.phase); more = a.more;
      if (Date.now() - wrote > 15_000) { res.write(": alive\n\n"); wrote = Date.now(); }
    }
    res.write(`event: close\ndata: ${JSON.stringify({ cursor })}\n\n`);
    res.end();
  };
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
    profiles: canAccount(S(res).accountRole, "launch") || !S(res).user ? await P.startableProfiles(actor(res), () => H.startBudgetMax(S(res).org, actor(res))) : [] })));
  // The workspace's own agent icon (mold_v0-252), ahead of /:id. Every person of the workspace sees it. mold_v0-262: only
  // platform staff set or reset it (Admin › Accounts › <account>, agentAdminRoutes below): the workspace's PUT and DELETE
  // are gone, and say where it is set.
  // A store that cannot be read (none set up, or down) is the default icon, not an error page's console noise.
  r.get("/icon", answer(async (_req, res) => ({ icon: await readAgentIcon(S(res).org).catch((e: Error) => { console.error(`agent icon: ${e.message}`); return null; }), can_change: false, max_bytes: AGENT_ICON_MAX_BYTES })));
  const staffOnly = (_req: Request, res: Response) => void res.status(403).json({ error: "The agent icon is set by the platform's staff, on the account's page." });
  r.put("/icon", staffOnly);
  r.delete("/icon", staffOnly);
  // mold_v0-290: what the composer offers, and the files a person attaches before sending (ahead of /:id).
  r.get("/composer", answer(async (req, res) => ({ offer: await H.composerOffer(S(res).org, actor(res), typeof req.query.session === "string" ? req.query.session : null) })));
  r.post("/files", (req: Request, res: Response, next: NextFunction) => (req.is("application/octet-stream") ? next() : void res.status(415).json({ error: "Send the file's bytes as application/octet-stream" })),
    express.raw({ type: "application/octet-stream", limit: attachmentMaxBytes() }),
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
      (err ? void res.status(err.type === "entity.too.large" ? 413 : err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? `A file may be at most ${Math.round(attachmentMaxBytes() / 1048576)} MB` : "The file could not be read" }) : next()),
    answer(async (req, res) => {
      await H.mayCompose(S(res).org, actor(res), typeof req.query.session === "string" ? req.query.session : null);
      res.status(201);
      return { file: await storeDraftFile(S(res).org, H.composerOwner(actor(res)), { name: req.get("x-file-name"), content_type: req.get("x-file-type"), data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) }) };
    }));
  r.delete("/files/:file", answer(async (req, res) => { await removeDraftFile(S(res).org, H.composerOwner(actor(res)), String(req.params.file)); return { removed: true }; }));
  r.post("/", answer(async (req, res) => { res.status(201); return { session: await H.startSession(S(res).org, actor(res), req.body ?? {}, org(res)) }; }));
  r.get("/:id", answer(async (req, res) => ({ session: await H.readSession(S(res).org, id(req), actor(res)) })));
  r.get("/:id/trace/stream", answer(traceStream((req, res, after) => H.sessionTrace(S(res).org, id(req), actor(res), after))));
  r.get("/:id/trace", answer(async (req, res) => H.sessionTrace(S(res).org, id(req), actor(res), req.query.after)));
  r.get("/:id/trace/:step", answer(async (req, res) => H.sessionTraceStep(S(res).org, id(req), actor(res), String(req.params.step))));
  r.post("/:id/messages", answer(async (req, res) => H.messageSession(S(res).org, id(req), actor(res), (req.body ?? {}).message, org(res), { files: (req.body ?? {}).files, repositories: (req.body ?? {}).repositories })));
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
  admin.get("/agent/:id/trace/stream", answer(traceStream((req, res, after) => H.sessionTrace(null, id(req), actor(req, res), after))));
  admin.get("/agent/:id/trace", answer(async (req, res) => H.sessionTrace(null, id(req), actor(req, res), req.query.after)));
  admin.get("/agent/:id/trace/:step", answer(async (req, res) => H.sessionTraceStep(null, id(req), actor(req, res), String(req.params.step))));
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
    const before = await H.readSession(null, id(req), actor(req, res));
    const s = await H.raiseBudget(null, id(req), actor(req, res), req.body ?? {});
    log(who(req, res), s.budget_usd < before.budget_usd ? "agent.budget_lowered" : "agent.budget_raised", s.workspace?.slug ?? null, { session: s.id, from_usd: before.budget_usd, to_usd: s.budget_usd, reason: String(req.body?.reason ?? "").slice(0, 300) });
    return { session: s };
  }));
  admin.post("/agent/:id/requests/:rid", need("accounts"), answer(async (req, res) => {
    const s = await H.decideRequest(null, id(req), String(req.params.rid), actor(req, res), (req.body ?? {}).decision, (req.body ?? {}).reason);
    log(who(req, res), "agent.request_declined", s.workspace?.slug ?? null, { session: s.id, request: String(req.params.rid).slice(0, 40) });
    return { session: s };
  }));

  // ---------- an account's agent icon (mold_v0-262: staff only, audited; src/agent-icon.ts validates and seals it) ----------
  const orgOf = async (slug: string): Promise<{ id: number; slug: string }> => {
    const [o] = await asPlatform(async () => (await getDb()).query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE slug = $1", [slug.slice(0, 120)]));
    if (!o) throw new PackError("Not found", 404);
    return o;
  };
  admin.get("/agent-icon/:slug", answer(async (req) => {
    const o = await orgOf(String(req.params.slug));
    return { icon: await readAgentIcon(o.id), max_bytes: AGENT_ICON_MAX_BYTES };
  }));
  admin.put("/agent-icon/:slug", need("accounts"), (req: Request, res: Response, next: NextFunction) => (req.is("application/octet-stream") ? next() : void res.status(415).json({ error: "Send the icon's bytes as application/octet-stream" })),
    express.raw({ type: "application/octet-stream", limit: AGENT_ICON_MAX_BYTES }),
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
      (err ? void res.status(err.type === "entity.too.large" ? 413 : err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? `An icon is at most ${AGENT_ICON_MAX_BYTES / 1024} KB` : "The request body could not be read" }) : next()),
    answer(async (req, res) => {
      const o = await orgOf(String(req.params.slug));
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const icon = await saveAgentIcon(o.id, `staff:${who(req, res)}`, data, String(req.get("x-file-type") ?? ""));
      log(who(req, res), "agent.icon_set", o.slug, { sha256: icon.sha256, content_type: icon.content_type });
      return { icon };
    }));
  admin.delete("/agent-icon/:slug", need("accounts"), answer(async (req, res) => {
    const o = await orgOf(String(req.params.slug));
    await resetAgentIcon(o.id);
    log(who(req, res), "agent.icon_reset", o.slug, {});
    return { icon: null };
  }));

  // ---------- agent profiles (mold_v0-261) ----------
  admin.get("/agent-profiles", answer(async () => ({ profiles: await P.listProfiles(), ...(await profileEditorFacts()) })));
  // mold_v0-267: uploads into a profile's workspace, in parts (ahead of /:id).
  admin.post("/agent-profiles/uploads", need("compute"), answer(async (req, res) => {
    const u = await P.startUpload(who(req, res), req.body ?? {});
    res.status(201);
    return { upload: u };
  }));
  admin.put("/agent-profiles/uploads/:upload/parts/:n", need("compute"), (req: Request, res: Response, next: NextFunction) => (req.is("application/octet-stream") ? next() : void res.status(415).json({ error: "Send the part's bytes as application/octet-stream" })),
    express.raw({ type: "application/octet-stream", limit: P.UPLOAD_PART_BYTES }),
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) =>
      (err ? void res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: err.type === "entity.too.large" ? `A part is at most ${P.UPLOAD_PART_BYTES / 1024 / 1024} MiB` : "The part could not be read" }) : next()),
    answer(async (req) => ({ part: await P.putUploadPart(String(req.params.upload), Number(req.params.n), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) })));
  admin.post("/agent-profiles/uploads/:upload/complete", need("compute"), answer(async (req, res) => {
    const u = await P.completeUpload(String(req.params.upload), req.body ?? {});
    log(who(req, res), "agent_profile.upload", null, { upload: u.id, bytes: u.bytes, sha256: u.sha256 });
    return { upload: u };
  }));
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
 * What the profile editor offers (mold_v0-267): src/agent-profiles.ts editorChoices, and the app's own tools as a
 * workspace's owner is offered them (each a read or not), for a governance policy's tool allowlist.
 */
async function profileEditorFacts() {
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
  return { ...(await P.editorChoices()), tools };
}
