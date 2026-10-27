/**
 * On-premises runners over HTTP (mold_v0-036; src/onprem-runners.ts). Nothing is mounted unless the build has a kind
 * that needs a workspace's private network (and APP_ONPREM_RUNNERS is not off): every path then answers 404 as before.
 *
 *   the workspace (/api/runners; the portal's session, X-Pack-Request: 1 on a change made with the cookie)
 *     GET    /                 a signed-in person: the location, the runners and their health, the kinds it applies to
 *     POST   /                 an owner: {name} a new runner: its one-time enrollment token and the command, shown once
 *     DELETE /:id              an owner: revoke at once
 *     PUT    /location         an owner: {location: hosted | on_premises}
 *
 *   the runner (/api/runner; no session: its own bearer credential; it only ever calls out)
 *     POST   /enroll           Authorization: Bearer ore_... (once) {version, hostname, capacity, isolation, allow, kinds}
 *                               -> {runner_id, name, credential: orr_... (shown once), poll_seconds}
 *     POST   /poll?wait=<s>    Authorization: Bearer orr_... {version, hostname, capacity, isolation, allow, kinds,
 *                               sandboxes: [{row, sandbox_id, live, state}], started: [{row, sandbox_id}],
 *                               failed: [{row, step, error}]} -> {assign: [...], remove: [row], keep: [row], poll_seconds}.
 *                               With wait (at most 20 s), the answer waits while there is nothing to start.
 *                               A revoked runner gets 401 {revoked: true}.
 *
 *   staff (/api/admin/onboarding, onPremAdminRoutes): GET /runners (every workspace's, health only),
 *   DELETE /runners/:id ("accounts": revoke).
 *
 * No answer or log line carries a token or a credential but the one being handed out once.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { bearer } from "./auth.js";
import { publicUrl } from "./console-url.js";
import { getDb } from "./db.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";
import { adminRunners, createRunner, enrollRunner, onPremAvailable, pollRunner, revokeRunner, RunnerAuthError, runnerFromCredential, setRunnerLocation,
  workspaceRunners } from "./onprem-runners.js";

const answerWith = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (e instanceof RunnerAuthError) return void res.status(401).json({ error: e.message, ...(e.revoked ? { revoked: true } : {}) });
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const jsonBody = (limit: string) => [
  express.json({ limit }),
  (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  },
];

/** The address the runner's run sandboxes are told the app is at (the runner replaces it with the one it was given). */
const appAddress = () => publicUrl() ?? "";

/** The one command that installs a runner (docs/on-premises-runner.md), with its token. */
export function installCommand(token: string, image = "<the image your provider gave you>"): string {
  return [
    "docker run -d --name app-runner --restart unless-stopped --user 0",
    "  -v /var/run/docker.sock:/var/run/docker.sock -v app-runner:/var/lib/app-runner",
    `  -e APP_RUNNER_URL=${appAddress() || "<this app's address>"}`,
    `  -e APP_RUNNER_TOKEN=${token}`,
    "  -e APP_RUNNER_ALLOW='<your private hosts and networks, e.g. *.corp.example 10.20.0.0/16:443|6443>'",
    `  ${image} node --import tsx src/onprem-runner.ts`,
  ].join(" \\\n");
}

export function onPremAppRouter(): Router {
  const r = express.Router();
  if (!onPremAvailable()) return r; // no kind needs a private network: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(...jsonBody("16kb"));
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const can = (res: Response) => canAccount(S(res).accountRole, "manage");
  const manage = (res: Response) => { if (!can(res)) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;

  r.get("/", answerWith(async (_req, res) => ({ ...(await workspaceRunners(S(res).org)), can_manage: can(res), image: ENV.APP_RUNNER_IMAGE_REF || null })));
  r.post("/", answerWith(async (req, res) => {
    manage(res);
    const out = await createRunner(S(res).org, who(res), (req.body ?? {}).name);
    log(who(res), "runner.created", S(res).slug, { runner: out.runner.id });
    return { ...out, command: installCommand(out.enrollment_token, ENV.APP_RUNNER_IMAGE_REF || undefined) };
  }));
  r.put("/location", answerWith(async (req, res) => {
    manage(res);
    const out = await setRunnerLocation(S(res).org, (req.body ?? {}).location, who(res));
    log(who(res), "runner.location", S(res).slug, out);
    return out;
  }));
  r.delete("/:id", answerWith(async (req, res) => {
    manage(res);
    const out = await revokeRunner(S(res).org, String(req.params.id), who(res));
    if (!out.revoked) throw new PackError("no such runner, or it is already revoked", 404);
    log(who(res), "runner.revoked", S(res).slug, { runner: String(req.params.id).slice(0, 40), runs_stopped: out.runs_stopped });
    return out;
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function onPremRunnerRouter(): Router {
  const r = express.Router();
  if (!onPremAvailable()) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(...jsonBody("256kb"));
  r.post("/enroll", answerWith(async (req) => {
    const out = await enrollRunner(bearer(req.headers.authorization), req.body ?? {});
    log(`runner:${out.runner_id}`, "runner.enrolled", null, { runner: out.runner_id });
    return out;
  }));
  r.post("/poll", answerWith(async (req, res) => {
    const who = await runnerFromCredential(bearer(req.headers.authorization));
    const wait = Math.max(0, Math.min(20, Number(req.query.wait) || 0)) * 1000;
    const t0 = Date.now();
    let closed = false;
    res.on("close", () => { closed = true; });
    let out = await pollRunner(who, req.body ?? {}, appAddress());
    // Long poll: while there is nothing to start or remove, wait for a run of its workspace to be queued on premises
    // (checked every second; the runner's whole poll again at most every 4 seconds).
    let last = Date.now();
    while (!closed && !out.assign.length && !out.remove.length && Date.now() - t0 < wait) {
      await sleep(1000);
      const [q] = await asPlatform(async () => (await getDb()).query<{ n: number }>(
        "SELECT count(*)::int AS n FROM runs WHERE org_id = $1 AND status = 'queued' AND runner_location = 'on_premises'", [who.orgId]));
      if (Number(q?.n ?? 0) > 0 && Date.now() - last >= 4000) {
        await runnerFromCredential(bearer(req.headers.authorization)); // revoked meanwhile: this call says so
        out = await pollRunner(who, { ...(req.body ?? {}), started: [], failed: [] }, appAddress());
        last = Date.now();
      }
    }
    return out;
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

type Need = (p: "keys" | "accounts") => express.RequestHandler;
/** Staff routes on the admin router (already behind requirePlatformAdmin, JSON and the access log). */
export function onPremAdminRoutes(admin: Router, need: Need, actor: (req: Request, res: Response) => string) {
  if (!onPremAvailable()) return;
  admin.get("/runners", answerWith(async () => ({ available: true, runners: await adminRunners() })));
  admin.delete("/runners/:id", need("accounts"), answerWith(async (req, res) => {
    const out = await revokeRunner(null, String(req.params.id), actor(req, res));
    if (!out.revoked) throw new PackError("no such runner, or it is already revoked", 404);
    log(actor(req, res), "runner.revoked", null, { runner: String(req.params.id).slice(0, 40), runs_stopped: out.runs_stopped });
    return out;
  }));
}
