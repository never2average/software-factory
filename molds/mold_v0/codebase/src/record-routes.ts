/**
 * Record areas over HTTP (mold_v0-047; src/record-areas.ts): the data behind the console's generic list and detail
 * pages. With no area declared nothing is mounted.
 *
 *   /api/records                  a signed-in person of a workspace (the portal's session check, src/app.ts): the
 *                                 areas, a page of an area, one record with its links. Read only: no route writes.
 *   /api/admin/records            platform staff, inside the admin router (requirePlatformAdmin, the access log):
 *                                 platform-scope areas only; PUT needs "library", DELETE needs "delete"
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { assertGuarded, need } from "./admin-roles.js";
import { customerSession, type Session } from "./app.js";
import { PackError } from "./pack-api.js";
import { areaOrThrow, areaSummary, deletePlatform, detailFor, getPlatform, listFor, listPlatform, putPlatform, recordAreas } from "./record-areas.js";

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

/** /api/records: the console's list and detail pages for one workspace (a signed-in person of it). Read only. */
export function recordAppRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r; // no areas: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  const org = (res: Response) => (res.locals.session as Session).org;
  // The person asking: an area's read permission is theirs to pass (mold_v0-057).
  const actor = (res: Response) => { const s = res.locals.session as Session; return { role: s.accountRole ?? null, userId: s.user ?? null }; };
  r.get("/areas", answer(async () => ({ areas: recordAreas().map(areaSummary) })));
  r.get("/:area", answer(async (req, res) => {
    const a = areaOrThrow(String(req.params.area));
    return { area: areaSummary(a), ...(await listFor(org(res), a.name, { limit: req.query.limit, after: req.query.after }, actor(res))) };
  }));
  r.get("/:area/:key", answer(async (req, res) => {
    const d = await detailFor(org(res), String(req.params.area), String(req.params.key), actor(res));
    if (!d) throw new PackError("Not found", 404);
    return d;
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** /api/admin/records, inside the admin router: platform areas; changes need "library", deletes "delete". */
export function recordAdminRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r;
  const platformArea = (name: string) => {
    const a = areaOrThrow(name);
    if (a.scope !== "platform") throw new PackError(`area ${a.name} holds each workspace's own records`, 404);
    return a;
  };
  r.get("/areas", need("read"), answer(async () => ({ areas: recordAreas().map(areaSummary) })));
  r.get("/:area", need("read"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    return { area: areaSummary(a), ...(await listPlatform(a, { limit: req.query.limit, after: req.query.after })) };
  }));
  r.get("/:area/:key", need("read"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    const record = await getPlatform(a, String(req.params.key));
    if (!record) throw new PackError("Not found", 404);
    return { area: areaSummary(a), record, links: [] };
  }));
  r.put("/:area/:key", need("library"), answer(async (req) =>
    ({ record: await putPlatform(null, platformArea(String(req.params.area)).name, String(req.params.key), req.body ?? {}) })));
  r.delete("/:area/:key", need("delete"), answer(async (req) => {
    if (!(await deletePlatform(null, platformArea(String(req.params.area)).name, String(req.params.key)))) throw new PackError("Not found", 404);
  }));
  assertGuarded(r, "/api/admin/records");
  return r;
}
