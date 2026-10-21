/**
 * The workspace credential vault over HTTP (mold_v0-034; src/credentials.ts): /api/credentials, the data behind the
 * console's /app/credentials page. With no pack declaring a credential nothing is mounted.
 *
 *   GET    /api/credentials   a signed-in person of the workspace: the fields the packs declare and, for each stored
 *                             value, its slot and last 4 characters. Never a value.
 *   PUT    /api/credentials   {pack, name, asset?, environment?, value}: set or replace one value ("manage": an owner)
 *   DELETE /api/credentials   {pack, name, asset?, environment?}: remove one ("manage")
 *
 * The workspace is the session's (src/app.ts customerSession). A change made with the session cookie carries
 * X-Pack-Request: 1 (CSRF, as the packs' routes). A body that is not JSON is refused without echoing any of it, and no
 * answer or log line carries a value: the audit log records the slot and who, never the value.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { log } from "./admin.js";
import { customerSession, type Session } from "./app.js";
import { credentialSpecs, deleteCredential, listCredentials, setCredential } from "./credentials.js";
import { PackError } from "./pack-api.js";

export function credentialAppRouter(): Router {
  const r = express.Router();
  if (!credentialSpecs().length) return r; // no fields: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "32kb" }));
  // The body parser's own error text quotes the body: answer without it.
  r.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
  });
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = await fn(req, res);
      if (v === undefined) return void res.status(204).end();
      res.json(v);
    } catch (e) {
      if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
      // Anything else is a 500 whose text is never shown (and src/http.ts logs it): ours never carry a value.
      next(e);
    }
  };
  const manage = (res: Response) => { if (!canAccount(S(res).accountRole, "manage")) throw new PackError(accountRefusal("manage").message, 403); };
  const who = (res: Response) => `customer:${S(res).email ?? S(res).user ?? S(res).slug}`;
  const slotOf = (b: Record<string, unknown>) => ({ pack: b.pack, name: b.name, asset: b.asset ?? null, environment: b.environment ?? null });

  r.get("/", answer(async (_req, res) => ({ ...(await listCredentials(S(res).org)), can_manage: canAccount(S(res).accountRole, "manage") })));
  r.put("/", answer(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await setCredential(S(res).org, who(res), b);
    log(who(res), "credential.set", S(res).slug, { pack: out.pack, name: out.name, asset: out.asset, environment: out.environment });
    return out;
  }));
  r.delete("/", answer(async (req, res) => {
    manage(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const removed = await deleteCredential(S(res).org, b);
    if (!removed) throw new PackError("no such value", 404);
    log(who(res), "credential.remove", S(res).slug, slotOf(b));
    return { removed };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
