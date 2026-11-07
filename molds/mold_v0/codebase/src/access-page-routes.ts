/**
 * Staff routes of the early-access form and sign-in editor (mold_v0-266; src/access-pages.ts), under
 * /api/admin/onboarding (the staff guard, its access log and the role check, src/admin-roles.ts):
 *   GET  /access-pages               both pages in force, the sign-in methods there are, the latest changes (any role)
 *   GET  /access-pages/:id/changes   one page's history: each version, who, when, before and after (any role)
 *   PUT  /access-pages/:id           save { version, config }: a new version (Operator and up: need("accounts"))
 *   POST /access-pages/:id/reset     back to the build's defaults { version } (Operator and up)
 * Every save and reset is also a staff log line (src/admin.ts log), beside its row in access_page_changes.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { PackError } from "./pack-api.js";
import { log } from "./admin.js";
import * as A from "./access-pages.js";

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try { const v = await fn(req, res); if (!res.headersSent) res.json(v); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message, ...((e as { problems?: string[] }).problems ? { problems: (e as { problems?: string[] }).problems } : {}) });
    next(e);
  }
};

export function accessPageAdminRoutes(ob: Router, need: (p: "accounts") => RequestHandler, who: (req: Request, res: Response) => string) {
  ob.get("/access-pages", answer(async () => ({ pages: await A.readAccessPages(), methods: await A.signInMethods(), changes: await A.accessPageChanges(undefined, 50) })));
  ob.get("/access-pages/:id/changes", answer(async (req) => {
    if (!A.isAccessPageId(req.params.id)) throw new PackError("no such page (request_form or sign_in)", 404);
    return { changes: await A.accessPageChanges(req.params.id) };
  }));
  ob.put("/access-pages/:id", need("accounts"), answer(async (req, res) => {
    const page = await A.saveAccessPage(who(req, res), req.params.id, req.body ?? {});
    log(who(req, res), "access_page.save", null, { page: page.id, version: page.version });
    return { page };
  }));
  ob.post("/access-pages/:id/reset", need("accounts"), answer(async (req, res) => {
    const page = await A.resetAccessPage(who(req, res), req.params.id, req.body ?? {});
    log(who(req, res), "access_page.reset", null, { page: page.id, version: page.version });
    return { page };
  }));
}
