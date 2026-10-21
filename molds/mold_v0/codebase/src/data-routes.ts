/**
 * The generic data API over HTTP (mold_v0-059; src/data-api.ts). With no record area declared nothing is mounted.
 *
 *   /api/data           a signed-in person of a workspace (the portal's session check, src/app.ts customerSession):
 *                         GET    /                     the areas
 *                         GET    /:area                a page: ?limit, ?after, ?sort (field or -field), ?filter (JSON)
 *                         POST   /:area                create {key, title?, data}
 *                         GET    /:area/:key           one record and its links
 *                         PUT    /:area/:key           update {title?, data}
 *                         POST   /:area/:key/move      {to}
 *                         DELETE /:area/:key
 *                         POST   /_batch               {operations: [{op, area, key, ...}]}: all or none
 *                       Every rule is the record store's (the area's permissions for the person's role, fields,
 *                       references, lifecycle, read-only repositories). A change made with the session cookie carries
 *                       X-Pack-Request: 1 (CSRF, as the packs' routes).
 *   /api/admin/data     platform staff, inside the admin router (requirePlatformAdmin, the CSRF header on cookie writes,
 *                       the access log): shared areas only; reads need "read", writes "library", deletes "delete";
 *                       GET /_repositories, POST /_repositories/:pack/:name/sync ("library"; {force: true} "delete").
 *   An operation whose generated MCP tool a pack excludes or marks admin_only answers 404 here too (mold_v0-067,
 *   src/mcp-withheld.ts): on /api/data for the workspace's tools, on /api/admin/data for an excluded staff tool.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { can, currentAdminRole, need, assertGuarded } from "./admin-roles.js";
import { customerSession, type Session } from "./app.js";
import { adminDataApi, dataApi, type DataCaller } from "./data-api.js";
import type { GeneratedOp } from "./mcp-catalog.js";
import { areaOpWithheld, batchWithheld, syncWithheld } from "./mcp-withheld.js";
import { PackError, type RecordQuery } from "./pack-api.js";
import { recordAreas } from "./record-areas.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (v === undefined) return void res.status(204).end();
    res.status(status).json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
/** The body parser's own error text quotes the body: answer without it. */
const bodyErrors = (err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();
  res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request body must be JSON" });
};
const queryOf = (req: Request): RecordQuery => {
  const q = req.query as Record<string, unknown>;
  for (const k of ["limit", "after", "sort", "filter"]) if (Array.isArray(q[k])) throw new PackError(`${k} is given once`, 400);
  return { limit: q.limit as never, after: q.after as never, sort: q.sort as never, filter: q.filter as never };
};
const keyOf = (req: Request) => String(req.params.key);
/** The route of an operation a pack withholds (mold_v0-067) answers as one that does not exist. */
const open = (op: GeneratedOp | "delete") => (req: Request, res: Response, next: NextFunction) =>
  (areaOpWithheld(String(req.params.area), op) ? void res.status(404).json({ error: "Not found" }) : next());
const batchOpen = (door: "workspace" | "admin") => (req: Request, res: Response, next: NextFunction) => {
  const held = batchWithheld(body(req).operations, door);
  return held ? void res.status(404).json({ error: `Not found: ${held.slice(0, 120)}` }) : next();
};
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

/** /api/data: one workspace's door (a signed-in person of it). */
export function dataAppRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r; // no areas: nothing is mounted, nothing answers
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "1mb" }));
  r.use(bodyErrors);
  r.use(customerSession);
  // A cross-site form cannot send a custom header: a change riding the session cookie must carry this one.
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const caller = (res: Response): DataCaller => { const s = res.locals.session as Session; return { orgId: s.org, role: s.accountRole ?? null, userId: s.user ?? null }; };
  r.get("/", answer(async () => dataApi.areas()));
  r.post("/_batch", batchOpen("workspace"), answer(async (req, res) => dataApi.batch(caller(res), body(req).operations)));
  r.get("/:area", open("list"), answer(async (req, res) => dataApi.list(caller(res), String(req.params.area), queryOf(req))));
  r.post("/:area", open("create"), answer(async (req, res) => {
    const b = body(req);
    if (typeof b.key !== "string") throw new PackError("give the new record's key", 400);
    return dataApi.create(caller(res), String(req.params.area), b.key, b);
  }, 201));
  r.get("/:area/:key", open("get"), answer(async (req, res) => {
    const d = await dataApi.get(caller(res), String(req.params.area), keyOf(req));
    if (!d) throw new PackError("Not found", 404);
    return d;
  }));
  r.put("/:area/:key", open("update"), answer(async (req, res) => dataApi.update(caller(res), String(req.params.area), keyOf(req), body(req))));
  r.post("/:area/:key/move", open("move"), answer(async (req, res) => dataApi.move(caller(res), String(req.params.area), keyOf(req), body(req).to)));
  r.delete("/:area/:key", open("delete"), answer(async (req, res) => {
    if (!(await dataApi.delete(caller(res), String(req.params.area), keyOf(req)))) throw new PackError("Not found", 404);
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** /api/admin/data, inside the admin router: shared areas and the upstream catalogs' index. */
export function dataAdminRouter(): Router {
  const r = express.Router();
  if (!recordAreas().length) return r;
  r.use(express.json({ limit: "1mb" }));
  r.use(bodyErrors);
  const mayDelete = () => { if (!can(currentAdminRole(), "delete")) throw new PackError("Deleting needs the delete permission (an owner)", 403); };
  r.get("/", need("read"), answer(async () => adminDataApi.areas()));
  r.get("/_repositories", need("read"), answer(async () => adminDataApi.repositories()));
  r.post("/_repositories/:pack/:name/sync", need("library"), (req, res, next) => (syncWithheld(String(req.params.pack), String(req.params.name)) ? void res.status(404).json({ error: "Not found" }) : next()), answer(async (req) => {
    const force = body(req).force === true;
    if (force) mayDelete();
    return adminDataApi.sync(String(req.params.pack), String(req.params.name), { force });
  }));
  r.post("/_batch", need("library"), batchOpen("admin"), answer(async (req) => {
    const ops = body(req).operations;
    if (Array.isArray(ops) && ops.some((o) => (o as { op?: unknown })?.op === "delete")) mayDelete();
    return adminDataApi.batch(ops);
  }));
  r.get("/:area", need("read"), open("admin_list"), answer(async (req) => adminDataApi.list(String(req.params.area), queryOf(req))));
  r.post("/:area", need("library"), open("admin_create"), answer(async (req) => {
    const b = body(req);
    if (typeof b.key !== "string") throw new PackError("give the new record's key", 400);
    return adminDataApi.create(String(req.params.area), b.key, b);
  }, 201));
  r.get("/:area/:key", need("read"), open("admin_get"), answer(async (req) => {
    const d = await adminDataApi.get(String(req.params.area), keyOf(req));
    if (!d) throw new PackError("Not found", 404);
    return d;
  }));
  r.put("/:area/:key", need("library"), open("admin_update"), answer(async (req) => adminDataApi.update(String(req.params.area), keyOf(req), body(req))));
  r.delete("/:area/:key", need("delete"), open("admin_delete"), answer(async (req) => {
    if (!(await adminDataApi.delete(String(req.params.area), keyOf(req)))) throw new PackError("Not found", 404);
  }));
  assertGuarded(r, "/api/admin/data");
  return r;
}
