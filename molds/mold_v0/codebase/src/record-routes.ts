/**
 * Record areas over HTTP (mold_v0-047; src/record-areas.ts): the data behind the console's generic list and detail
 * pages. With no area declared nothing is mounted.
 *
 *   /api/records                  a signed-in person of a workspace (the portal's session check, src/app.ts): the
 *                                 areas, a page of an area, one record with its links, a page of a merged tab
 *                                 (/api/records/tabs/<pack>/<tab>, mold_v0-135: src/record-merge.ts), the records due soon
 *                                 across its clock areas (/api/records/due-soon, mold_v0-207), a record's file cards
 *                                 and each file's bytes at a signed link (/api/records/<area>/<key>/files[/<field>/<n>],
 *                                 mold_v0-220: src/record-files.ts), the four cards of an area's own lists (its
 *                                 Settings tab, its Records page: /api/records/_console/<area>/sparklines, mold_v0-237,
 *                                 src/sparklines.ts workspaceAreaSparklines). Read only: no route writes.
 *   /api/admin/records            platform staff, inside the admin router (requirePlatformAdmin, the access log):
 *                                 platform-scope areas only; PUT needs "library", DELETE needs "delete".
 *                                 mold_v0-212, the staff record page (web/src/features/records/staff-records.tsx):
 *                                 GET _console/<area>/sparklines  its four cards (src/sparklines.ts areaSparklines)
 *                                 GET _console/<area>/form        what the page offers this staff role: create, edit
 *                                                                 and import (the role's "library"; the staff tool not
 *                                                                 withheld; no encrypted field), remove ("delete"), the
 *                                                                 repository that fills the area, and the area's fields
 *                                                                 as the form draws them. The writes themselves go to
 *                                                                 /api/admin/data, unchanged.
 *                                 mold_v0-221: every shared area, a repository's too: staff rows (provenance staff)
 *                                 beside the repository's, which stay read only; Edit on a repository's row is an
 *                                 Override (a staff row of the same key that wins until removed; removing it puts the
 *                                 repository's version back: src/record-areas.ts putPlatform, deletePlatform). Each
 *                                 row of the list and the detail carries its `provenance` (by, repository, overrides).
 *                                 POST _console/<area>/import    {rows: [{key, title?, data}], dry_run?}: the import's
 *                                                                 preview (dry_run, the default) or the import itself
 *                                                                 ("library"; src/record-import.ts), each row it wrote
 *                                                                 an IMPORT line of the staff access log.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { assertGuarded, can, need, type PlatformRole } from "./admin-roles.js";
import { customerSession, type Session } from "./app.js";
import type { GeneratedOp } from "./mcp-catalog.js";
import { areaOpWithheld } from "./mcp-withheld.js";
import { tabAreas } from "./metric-spec.js";
import { PackError, type Tab } from "./pack-api.js";
import { packRegistry } from "./packs.js";
import { mergedPage } from "./record-merge.js";
import { anyArea, mountFileRoutes } from "./record-files.js";
import { auditListPurpose } from "./audit-trail.js";
import { dueAcross } from "./record-clocks.js";
import { areaOrThrow, areaSummary, deletePlatform, detailFor, getPlatform, isReadOnlyArea, listFor, listPlatform, platformProvenance, putPlatform, recordAreas, type RecordArea } from "./record-areas.js";
import { getDb } from "./db.js";
import { auditStaffRows } from "./audit-trail.js";

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
  // The console's Export CSV pages through the list routes with ?audit=export: the data trail records an export (mold_v0-197).
  r.use(auditListPurpose);
  const org = (res: Response) => (res.locals.session as Session).org;
  // The person asking: an area's read permission is theirs to pass (mold_v0-057).
  const actor = (res: Response) => { const s = res.locals.session as Session; return { role: s.accountRole ?? null, userId: s.user ?? null }; };
  r.get("/areas", answer(async () => ({ areas: recordAreas().map(areaSummary) })));
  // A merged tab's page (mold_v0-135): only a declared tab's areas, each read as on /:area (its read permission, its
  // list withheld: 404 as there).
  // A filtered tab's page (mold_v0-175): its one area, narrowed by the tab's declared filter (never the page's).
  r.get("/tabs/:pack/:tab", answer(async (req, res) => {
    const tab = (packRegistry().tabs as (Tab & { pack: string })[]).find((t) => t.pack === String(req.params.pack) && t.id === String(req.params.tab) && t.kind === "area" && (!!t.areas || !!t.filter));
    if (!tab || tabAreas(tab).some((a) => areaOpWithheld(a.area, "list"))) throw new PackError("Not found", 404);
    if (!tab.areas) {
      const a = areaOrThrow(tab.area!);
      return { area: areaSummary(a), ...(await listFor(org(res), a.name, { limit: req.query.limit === undefined ? undefined : Number(req.query.limit), after: req.query.after === undefined ? undefined : String(req.query.after), filter: tab.filter }, actor(res))) };
    }
    return mergedPage(org(res), tab, { limit: req.query.limit, after: req.query.after }, actor(res));
  }));
  // The home page's Due soon card (mold_v0-207; src/record-clocks.ts dueAcross): records coming due or overdue across
  // the clock areas this person may read and whose list no pack withholds. Not an area name (those take no "-").
  r.get("/due-soon", answer(async (req, res) => dueAcross(org(res), actor(res), { limit: req.query.limit === undefined ? undefined : Number(req.query.limit), withheld: (a) => areaOpWithheld(a, "list") })));
  // An area's own lists' four cards (mold_v0-237): its Settings tab's and its Records page's (an area name has no "_").
  r.get("/_console/:area/sparklines", open("list"), answer(async (req, res) => {
    const a = areaOrThrow(String(req.params.area));
    return (await import("./sparklines.js")).workspaceAreaSparklines(org(res), a.name, actor(res));
  }));
  r.get("/:area", open("list"), answer(async (req, res) => {
    const a = areaOrThrow(String(req.params.area));
    return { area: areaSummary(a), ...(await listFor(org(res), a.name, { limit: req.query.limit, after: req.query.after }, actor(res))) };
  }));
  // A record's files and documents (mold_v0-220, src/record-files.ts): its card's file cards, and each file's bytes.
  mountFileRoutes(r, { base: "/api/records", org, actor, who: (res) => ({ scope: `org-${org(res)}`, person: String(actor(res).userId) }), area: anyArea }, (op) => open(op));
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
  // The staff record page (mold_v0-212): "_console" is no area's name (an area's starts with a letter).
  r.get("/_console/:area/sparklines", need("read"), open("admin_list"), answer(async (req) =>
    (await import("./sparklines.js")).areaSparklines(platformArea(String(req.params.area)).name)));
  r.get("/_console/:area/form", need("read"), open("admin_list"), answer(async (req, res) => {
    const a = platformArea(String(req.params.area));
    const { formField } = await import("./tab-actions.js");
    const role = res.locals.adminRole as PlatformRole | undefined;
    // Hand writes on the console (mold_v0-221: a repository's area too, as staff rows beside its rows): rows the shell
    // stores (not read live), no encrypted field (its value never round-tripped through a form or a file), the role's
    // "library" (as /api/admin/data checks), the staff tool not withheld.
    const stored = !isReadOnlyArea(a) && a.repo?.kind !== "http_api";
    const writable = stored && !a.fields.some((f) => f.encrypted) && can(role, "library");
    const create = writable && !areaOpWithheld(a.name, "admin_create"), edit = writable && !areaOpWithheld(a.name, "admin_update");
    return {
      area: a.name, label: a.label,
      create, edit, import: create && edit,
      remove: stored && can(role, "delete") && !areaOpWithheld(a.name, "admin_delete"),
      repository: a.repo ? { name: a.repo.name, kind: a.repo.kind } : null,
      fields: a.fields.map(formField),
    };
  }));
  // The import (mold_v0-221): its preview unless dry_run is false. Its body has its own size limit (src/http.ts).
  r.post("/_console/:area/import", need("library"), open("admin_create", "admin_update"), answer(async (req, res) => {
    const a = platformArea(String(req.params.area));
    const body = (req.body ?? {}) as { rows?: unknown; dry_run?: unknown };
    const { importRecords } = await import("./record-import.js");
    const report = await importRecords(a, body.rows, { dryRun: body.dry_run !== false });
    if (!report.dry_run) recordImport(a, report.rows.filter((x) => x.action === "create" || x.action === "update" || x.action === "override"), res);
    return report;
  }));
  r.get("/:area", need("read"), open("admin_list"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    const page = await listPlatform(a, { limit: req.query.limit, after: req.query.after });
    return { area: areaSummary(a), ...page, records: await withProvenance(a, page.records) };
  }));
  // A shared record's documents (mold_v0-220): staff see a regulator's document as its customers do.
  mountFileRoutes(r, { base: "/api/admin/records", org: () => null, actor: () => ({ role: null, userId: null }),
    who: (res) => ({ scope: "staff", person: String(res.locals.adminActor ?? "staff") }), area: platformArea }, () => open("admin_get"), need("read"));
  r.get("/:area/:key", need("read"), open("admin_get"), answer(async (req) => {
    const a = platformArea(String(req.params.area));
    const record = await getPlatform(a, String(req.params.key));
    if (!record) throw new PackError("Not found", 404);
    return { area: areaSummary(a), record: (await withProvenance(a, [record]))[0], links: [] };
  }));
  r.put("/:area/:key", need("library"), open("admin_create", "admin_update"), answer(async (req) =>
    ({ record: await putPlatform(null, platformArea(String(req.params.area)).name, String(req.params.key), req.body ?? {}) })));
  r.delete("/:area/:key", need("delete"), open("admin_delete"), answer(async (req) => {
    if (!(await deletePlatform(null, platformArea(String(req.params.area)).name, String(req.params.key)))) throw new PackError("Not found", 404);
  }));
  assertGuarded(r, "/api/admin/records");
  return r;
}

/** Each shared row with where it comes from (mold_v0-221): staff or its repository, and what a staff override stands over. */
async function withProvenance<T extends { key: string }>(a: RecordArea, rows: T[]): Promise<(T & { provenance?: unknown })[]> {
  const p = await platformProvenance(a, rows.map((r) => r.key));
  return rows.map((r) => (p.has(r.key) ? { ...r, provenance: p.get(r.key) } : r));
}

/**
 * An import's rows in the staff access log (admin_access_log, as every /api/admin request and admin MCP call): one IMPORT
 * line per row written, after the request's own line; and the platform trail's staff entries when it is on.
 */
function recordImport(a: RecordArea, rows: { key: string; action: string }[], res: Response) {
  if (!rows.length) return;
  const actor = String(res.locals.adminActor ?? "unknown").replace(/[^\w.@ :-]/g, "").slice(0, 80) || "unknown";
  const paths = rows.map((x) => `/api/admin/records/${a.name}/${x.key} ${x.action}`.slice(0, 300));
  void getDb().then((db) => db.query("INSERT INTO admin_access_log (actor, method, path, status, ip) SELECT $1, 'IMPORT', p, 200, $3 FROM unnest($2::text[]) AS p",
    [actor, paths, String(res.req.ip ?? "").slice(0, 64)])).catch((e) => console.error(`admin access log: ${(e as Error).message}`));
  auditStaffRows(actor, String(res.locals.adminRole ?? ""), paths);
}
