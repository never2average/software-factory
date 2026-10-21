/**
 * The neutral usage pages over HTTP (mold_v0-008; src/usage-report.ts):
 *
 *   GET /api/usage          a signed-in person of the workspace: its own figures (members, runs), ?from&to or ?days.
 *                           The workspace is the session's (src/app.ts customerSession), and the request runs under its
 *                           row-level security: another workspace's rows cannot be read whatever the query says.
 *   GET /api/admin/onboarding/usage   platform admins (inside the admin router): every workspace.
 *
 * Read only; nothing is stored. Members are named by the workspace's own team list (email), else "Former member";
 * a key with no member is "Key <id>".
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { customerSession, type Session } from "./app.js";
import { operatorUsageReport, workspaceUsageReport } from "./usage-report.js";

export function usageAppRouter(): Router {
  const r = express.Router();
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(customerSession);
  r.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const s = res.locals.session as Session;
      const report = await workspaceUsageReport(s.org, req.query);
      let names = new Map<string, string>();
      try {
        const { team } = await import("./admin.js");
        names = new Map((await team(s.slug)).members.map((m) => [m.user_id, m.email ?? m.name ?? m.user_id]));
      } catch { /* the team list is unreachable: ids stand in */ }
      const label = (id: string | null, key: number | null) =>
        id ? (id === s.user ? "You" : names.get(id) ?? "Former member") : key != null ? `Key ${key}` : "Workspace key";
      res.json({ ...report, members: report.members.map((m) => ({ ...m, label: label(m.user_id, m.key_id) })),
        runs: { ...report.runs, by_person: report.runs.by_person.map((p) => ({ ...p, label: label(p.user_id, null) })),
          recent: report.runs.recent.map((x) => ({ ...x, by: label(x.requested_by, null) })) } });
    } catch (e) { next(e); }
  });
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}

/** Mounted inside the admin router (/api/admin/onboarding/usage), behind its platform-admin check. */
export function usageAdminRoute() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await operatorUsageReport(req.query)); } catch (e) { next(e); }
  };
}
