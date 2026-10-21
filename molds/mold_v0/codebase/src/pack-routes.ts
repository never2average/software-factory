/**
 * Pack HTTP routes (mold_v0-038), never at a shell path:
 *
 *   /api/packs/<id><path>        a signed-in person of the workspace (the customer portal's own session check,
 *                                src/app.ts customerSession), the rest of the request under row-level security for
 *                                that workspace; a change needs "edit" unless the route names another permission, and
 *                                a change made with the session cookie must carry X-Pack-Request: 1 (CSRF)
 *   /api/admin/packs/<id><path>  platform admins: mounted inside the /api/admin router (src/http.ts), so
 *                                requirePlatformAdmin, the CSRF header on cookie writes and the access log all apply;
 *                                every change carries need(<its permission>) and the router is checked by assertGuarded
 *
 * A handler gets a context (its workspace or the admin, the params, query and body, a database handle) and returns a
 * JSON value (undefined: 204). A PackError reaches the caller with its status; anything else is a 500.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { accountRefusal, canAccount } from "./account-roles.js";
import { assertGuarded, need, type PlatformRole } from "./admin-roles.js";
import { customerSession, type Session } from "./app.js";
import { getDb } from "./db.js";
import { PackError, type AdminRoute, type PackDb, type WorkspaceRoute } from "./pack-api.js";
import { packs, workspaceDb } from "./packs.js";
import { platformRecords, workspaceRecords } from "./record-areas.js";

const params = (req: Request) => Object.fromEntries(Object.entries(req.params ?? {}).map(([k, v]) => [k, String(v)]));
const query = (req: Request) => ({ ...(req.query as Record<string, unknown>) });

/** Run a handler and answer: its JSON value, 204 for nothing, a PackError's status and message. */
const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (res.headersSent) return;
    if (v === undefined) return void res.status(204).end();
    res.json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/** /api/packs: one sub-router per pack, behind the customer session. */
export function packAppRouter(): Router {
  const r = express.Router();
  const list = packs().filter((p) => (p.definition.routes ?? []).some((x) => x.scope === "workspace"));
  if (!list.length) return r; // zero packs: nothing is mounted, nothing answers
  r.use(express.json({ limit: "64kb" }));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  // A cross-site form cannot send a custom header: a change riding the session cookie must carry this one.
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  for (const p of list) {
    const pr = express.Router({ mergeParams: true });
    for (const route of (p.definition.routes ?? []).filter((x): x is WorkspaceRoute => x.scope === "workspace")) {
      const needs = route.needs ?? (route.method === "get" ? undefined : "edit");
      pr[route.method](route.path, answer(async (req, res) => {
        const s = res.locals.session as Session;
        if (needs && !canAccount(s.accountRole, needs)) throw new PackError(accountRefusal(needs).message, 403);
        const workspace = { id: s.org, slug: s.slug, name: null, userId: s.user, role: s.accountRole };
        const { workspaceRuns } = await import("./runs.js");
        return route.handler({ pack: p.id, workspace, db: workspaceDb(s.org), records: workspaceRecords(p.id, s.org), runs: workspaceRuns(p.id, s.org, s.user),
          params: params(req), query: query(req), body: req.body });
      }));
    }
    r.use(`/${p.id}`, pr);
  }
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** The platform database, unscoped: the admin console works across workspaces by design (as src/admin.ts does). */
const platformDb: PackDb = { query: async (sql, p) => (await getDb()).query(sql, p) };

/** /api/admin/packs, mounted on the admin router (requirePlatformAdmin and the access log run first). */
export function packAdminRouter(): Router {
  const r = express.Router();
  for (const p of packs()) {
    const routes = (p.definition.routes ?? []).filter((x): x is AdminRoute => x.scope === "admin");
    if (!routes.length) continue;
    const pr = express.Router({ mergeParams: true });
    for (const route of routes) {
      const guard = need(route.needs ?? "read");
      pr[route.method](route.path, guard, answer(async (req, res) => route.handler({
        pack: p.id, admin: { actor: String(res.locals.adminActor ?? "admin"), role: res.locals.adminRole as PlatformRole },
        db: platformDb, records: platformRecords(p.id), params: params(req), query: query(req), body: req.body,
      })));
    }
    // The same rule the shell's own admin routers follow: no change without need(permission).
    assertGuarded(pr, `/api/admin/packs/${p.id}`);
    r.use(`/${p.id}`, pr);
  }
  return r;
}
