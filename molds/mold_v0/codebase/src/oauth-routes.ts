/**
 * Credential fields connected through OAuth, over HTTP (mold_v0-014; src/oauth-connections.ts). Nothing is mounted unless
 * a pack's credential field names an OAuth provider.
 *
 *   GET    /api/credential-connections            a signed-in person of the workspace: the providers and the workspace's connections
 *   POST   /api/credential-connections/connect    an owner: {pack, name, asset?, environment?} -> the provider's sign-in address
 *   GET    /api/credential-connections/callback   the provider sends the owner's browser back here; on to the Credentials page with a code
 *   DELETE /api/credential-connections            an owner: {pack, name, asset?, environment?} disconnects that slot
 *
 *   staff (/api/admin/onboarding, oauthAdminRoutes): GET /oauth (providers, whether the vault holds their client values,
 *   the redirect address to register, every connection), DELETE /oauth/connections/:id ("accounts").
 *
 * Cookie writes carry X-Pack-Request: 1 (CSRF). No answer or log line carries a token or a secret.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { consoleUrl } from "./console-url.js";
import { adminDisconnect, adminView, beginConnect, completeConnect, ConnectRefused, disconnect, listConnections, oauthFields, providerSummaries, redirectUri } from "./oauth-connections.js";
import { PackError } from "./pack-api.js";

const answerWith = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await fn(req, res)); }
  catch (e) { if (e instanceof PackError) return void res.status(e.status).json({ error: e.message }); next(e); }
};

export function oauthRouter(): Router {
  const r = express.Router();
  if (!oauthFields().length) return r;
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "16kb" }));
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

  r.get("/", answerWith(async (_req, res) => ({ providers: providerSummaries(), connections: await listConnections(S(res).org), redirect_uri: redirectUri(), can_manage: can(res) })));
  r.post("/connect", answerWith(async (req, res) => {
    manage(res);
    if (!S(res).user) throw new PackError("sign in as a person to connect (a key cannot)", 403);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await beginConnect(S(res).org, S(res).user!, b);
    log(who(res), "oauth.connect_started", S(res).slug, { pack: b.pack, name: b.name, asset: b.asset ?? null, environment: b.environment ?? null });
    return out;
  }));
  r.get("/callback", async (req, res) => {
    const back = (code: string) => res.redirect(303, `${consoleUrl()}/app/credentials?oauth=${encodeURIComponent(code)}`);
    if (!can(res) || !S(res).user) return void back("not_owner");
    try {
      const out = await completeConnect({ org: S(res).org, user: S(res).user!, by: who(res) }, req.query as Record<string, unknown>);
      log(who(res), "oauth.connected", S(res).slug, { pack: out.pack, name: out.name });
      back("connected");
    } catch (e) {
      const code = e instanceof ConnectRefused ? e.code : "failed";
      log(who(res), "oauth.refused", S(res).slug, { code });
      if (!(e instanceof ConnectRefused) && !(e instanceof PackError)) console.error(`oauth: callback failed: ${(e as Error)?.message?.slice(0, 200)}`);
      back(code);
    }
  });
  r.delete("/", answerWith(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await disconnect(S(res).org, b);
    if (!out.removed) throw new PackError("not connected", 404);
    log(who(res), "oauth.disconnected", S(res).slug, { pack: b.pack, name: b.name, asset: b.asset ?? null, environment: b.environment ?? null, revoked_at_provider: out.revoked_at_provider });
    return out;
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

type Need = (p: "accounts") => express.RequestHandler;
/** Staff routes on the admin onboarding router (behind requirePlatformAdmin, JSON and the access log). */
export function oauthAdminRoutes(admin: Router, need: Need, actor: (req: Request, res: Response) => string) {
  if (!oauthFields().length) return;
  admin.get("/oauth", answerWith(() => adminView()));
  admin.delete("/oauth/connections/:id", need("accounts"), answerWith(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new PackError("no such connection", 404);
    const out = await adminDisconnect(id);
    if (!out.removed) throw new PackError("no such connection", 404);
    log(actor(req, res), "oauth.revoked", null, { id, revoked_at_provider: out.revoked_at_provider });
    return out;
  }));
}
