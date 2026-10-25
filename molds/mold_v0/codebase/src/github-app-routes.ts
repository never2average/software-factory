/**
 * Repository access by a GitHub App per workspace over HTTP (mold_v0-014; src/github-app.ts). Nothing is mounted unless a
 * pack declares a credential field with `github_app: true`.
 *
 *   POST   /api/github-app/webhook       the app's webhook (GitHub): verified by the webhook secret (X-Hub-Signature-256)
 *                                         before anything is read; installation removed, suspended, repositories changed
 *   GET    /api/github-app               a signed-in person of the workspace: whether the platform has the app, the
 *                                         workspace's installation (account, repositories, per-asset narrowing)
 *   POST   /api/github-app/install       an owner: the install address (a signed, one-time state for this workspace)
 *   GET    /api/github-app/callback      GitHub sends the owner's browser back here: bound to the workspace, or refused;
 *                                         either way the browser goes on to the console's Credentials page
 *   PUT    /api/github-app/repositories  an owner: {area, asset, repositories} narrows that asset's runs' tokens
 *   DELETE /api/github-app               an owner: disconnect (tokens revoked, the installation uninstalled)
 *
 *   staff (/api/admin/onboarding, githubAppAdminRoutes): GET /github-app (the app's settings, never a secret, the addresses to give
 *   GitHub, every installation), PUT /github-app (the settings: "keys"), DELETE /github-app/installations/:org ("accounts").
 *
 * A change made with the session cookie carries X-Pack-Request: 1 (CSRF), as the credential routes. No answer or log line
 * carries a token, a key or a secret.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { consoleUrl, publicUrl } from "./console-url.js";
import { adminInstallations, appConfig, beginInstall, completeInstall, configSummary, disconnect, githubAppFields, handleWebhook,
  InstallRefused, setAppConfig, setAssetRepositories, TOKEN_PERMISSIONS, webhookSignatureValid, workspaceView } from "./github-app.js";
import { PackError } from "./pack-api.js";

const answerWith = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    // Anything else is a 500 whose text is never shown (src/http.ts logs it): ours never carry a secret.
    next(e);
  }
};

export function githubAppRouter(): Router {
  const r = express.Router();
  if (!githubAppFields().length) return r; // no field asks for it: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  // The webhook, before any session: GitHub signs the exact bytes it sends.
  r.post("/webhook", express.raw({ type: () => true, limit: "1mb" }), async (req, res, next) => {
    try {
      const c = await appConfig();
      if (!c) return void res.status(404).json({ error: "Not found" });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!webhookSignatureValid(c.webhook_secret, raw, req.get("x-hub-signature-256"))) return void res.status(401).json({ error: "bad signature" });
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return void res.status(400).json({ error: "the body must be JSON" }); }
      const event = String(req.get("x-github-event") ?? "").slice(0, 60);
      const out = await handleWebhook(event, body && typeof body === "object" ? body : {});
      if (out.handled !== "ignored") console.error(`github-app: webhook ${event} ${out.handled} (installation ${Number((body.installation as { id?: unknown })?.id) || "?"})`);
      res.json(out);
    } catch (e) { next(e); }
  });

  r.use(express.json({ limit: "64kb" }));
  r.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  });
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const can = (res: Response) => canAccount(S(res).accountRole, "manage");
  const manage = (res: Response) => { if (!can(res)) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;

  r.get("/", answerWith(async (_req, res) => ({ ...(await workspaceView(S(res).org)), can_manage: can(res) })));
  r.post("/install", answerWith(async (_req, res) => {
    manage(res);
    if (!S(res).user) throw new PackError("sign in as a person to connect GitHub (a key cannot)", 403);
    const out = await beginInstall(S(res).org, S(res).user!);
    log(who(res), "github_app.install_started", S(res).slug, {});
    return out;
  }));
  // GitHub's redirect: a browser navigation, so every outcome is a redirect to the console with a code (nothing echoed).
  r.get("/callback", async (req, res) => {
    const back = (code: string) => res.redirect(303, `${consoleUrl()}/app/credentials?github=${encodeURIComponent(code)}`);
    if (!can(res)) return void back("not_owner");
    if (!S(res).user) return void back("not_owner");
    try {
      const out = await completeInstall({ org: S(res).org, user: S(res).user!, by: who(res) }, req.query as Record<string, unknown>);
      log(who(res), `github_app.${out.outcome}`, S(res).slug, { account: out.account });
      back(out.outcome);
    } catch (e) {
      const code = e instanceof InstallRefused ? e.code : e instanceof PackError ? "github_unreachable" : "failed";
      log(who(res), "github_app.refused", S(res).slug, { code });
      if (!(e instanceof InstallRefused) && !(e instanceof PackError)) console.error(`github-app: callback failed: ${(e as Error)?.message?.slice(0, 200)}`);
      back(code);
    }
  });
  r.put("/repositories", answerWith(async (req, res) => {
    manage(res);
    const out = await setAssetRepositories(S(res).org, (req.body ?? {}) as Record<string, unknown>);
    log(who(res), "github_app.repositories", S(res).slug, { area: out.area, asset: out.asset, repositories: out.repositories.length });
    return out;
  }));
  r.delete("/", answerWith(async (_req, res) => {
    manage(res);
    const out = await disconnect(S(res).org, "disconnected");
    if (!out.disconnected) throw new PackError("GitHub is not connected", 404);
    log(who(res), "github_app.disconnected", S(res).slug, { uninstalled: out.uninstalled });
    return out;
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

type Need = (p: "keys" | "accounts") => express.RequestHandler;
/** Staff routes on the admin router (already behind requirePlatformAdmin, JSON and the access log). */
export function githubAppAdminRoutes(admin: Router, need: Need, actor: (req: Request, res: Response) => string) {
  if (!githubAppFields().length) return;
  admin.get("/github-app", answerWith(async () => ({
    available: true,
    app: await configSummary(),
    // What to type into GitHub's "Register new GitHub App" form: this build's own addresses.
    setup: {
      homepage_url: consoleUrl(),
      callback_url: `${consoleUrl()}/api/github-app/callback`,
      webhook_url: `${publicUrl()}/api/github-app/webhook`,
      request_user_authorization: true,
      permissions: { ...TOKEN_PERMISSIONS, metadata: "read" },
      events: ["installation", "installation_repositories"],
    },
    fields: githubAppFields(),
    installations: await adminInstallations(),
  })));
  admin.put("/github-app", need("keys"), answerWith(async (req, res) => {
    const out = await setAppConfig((req.body ?? {}) as Record<string, unknown>);
    log(actor(req, res), "github_app.settings", null, { set: Object.keys(req.body ?? {}).slice(0, 10) });
    return out;
  }));
  admin.delete("/github-app/installations/:org", need("accounts"), answerWith(async (req, res) => {
    const org = Number(req.params.org);
    if (!Number.isSafeInteger(org) || org <= 0) throw new PackError("no such workspace", 404);
    const out = await disconnect(org, "revoked_by_staff");
    if (!out.disconnected) throw new PackError("that workspace has no live installation", 404);
    log(actor(req, res), "github_app.revoked", null, { org, uninstalled: out.uninstalled });
    return out;
  }));
}
