/**
 * Record areas over HTTP (mold_v0-047; src/record-areas.ts): the data behind the console's generic list and detail
 * pages. With no area declared nothing is mounted.
 *
 *   /api/records                  a signed-in person of a workspace (the portal's session check, src/app.ts): the
 *                                 areas, a page of an area, one record with its links, a page of a merged tab
 *                                 (/api/records/tabs/<pack>/<tab>, mold_v0-135: src/record-merge.ts). Read only: no
 *                                 route writes.
 *   /api/admin/records            platform staff, inside the admin router (requirePlatformAdmin, the access log):
 *                                 platform-scope areas only; PUT needs "library", DELETE needs "delete"
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { assertGuarded, need } from "./admin-roles.js";
import { customerSession, type Session } from "./app.js";
import type { GeneratedOp } from "./mcp-catalog.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { tabAreas } from "./metric-spec.js";
import { PackError, type Tab } from "./pack-api.js";
import { packRegistry } from "./packs.js";
import { mergedPage } from "./record-merge.js";
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
/** An area's page or record whose generated MCP tool a pack withholds answers 404 (mold_v0-067, src/mcp-withheld.ts). */
const open = (...ops: GeneratedOp[]) => (req: Request, res: Response, next: NextFunction) =>
  (ops.some((op) => areaOpWithheld(String(req.params.area), op)) ? void res.status(404).json({ error: "Not found" }) : next());

export function recordAppRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r; // no areas: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  const org = (res: Response) => (res.locals.session as Session).org;
  // The person asking: an area's read permission is theirs to pass (mold_v0-057).
  const actor = (res: Response) => { const s = res.locals.session as Session; return { role: s.accountRole ?? null, userId: s.user ?? null }; };
  r.get("/areas", answer(async () => ({ areas: recordAreas().map(areaSummary) })));
  // A merged tab's page (mold_v0-135): only a declared tab's areas, each read as on /:area (its read permission, its
  // list withheld: 404 as there).
  r.get("/tabs/:pack/:tab", answer(async (req, res) => {
    const tab = (packRegistry().tabs as (Tab & { pack: string })[]).find((t) => t.pack === String(req.params.pack) && t.id === String(req.params.tab) && t.kind === "area" && !!t.areas);
    if (!tab || tabAreas(tab).some((a) => areaOpWithheld(a.area, "list"))) throw new PackError("Not found", 404);
    return mergedPage(org(res), tab, { limit: req.query.limit, after: req.query.after }, actor(res));
  }));
  r.get("/:area", open("list"), answer(async (req, res) => {
    const a = areaOrThrow(String(req.params.area));
    return { area: areaSummary(a), ...(await listFor(org(res), a.name, { limit: req.query.limit, after: req.query.after }, actor(res))) };
  }));
  r.get("/:area/:key", open("get"), answer(async (req, res) => {
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
  r.get("/:area", need("read"), open("admin_list"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    return { area: areaSummary(a), ...(await listPlatform(a, { limit: req.query.limit, after: req.query.after })) };
  }));
  r.get("/:area/:key", need("read"), open("admin_get"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    const record = await getPlatform(a, String(req.params.key));
    if (!record) throw new PackError("Not found", 404);
    return { area: areaSummary(a), record, links: [] };
  }));
  r.put("/:area/:key", need("library"), open("admin_create", "admin_update"), answer(async (req) =>
    ({ record: await putPlatform(null, platformArea(String(req.params.area)).name, String(req.params.key), req.body ?? {}) })));
  r.delete("/:area/:key", need("delete"), open("admin_delete"), answer(async (req) => {
    if (!(await deletePlatform(null, platformArea(String(req.params.area)).name, String(req.params.key)))) throw new PackError("Not found", 404);
  }));
  assertGuarded(r, "/api/admin/records");
  return r;
}
