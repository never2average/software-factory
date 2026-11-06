/**
 * /api/teams (mold_v0-259, flag teams; src/teams.ts): a workspace's teams for the console's Settings › Teams and each
 * team's page, and the forms' team picker. Off (the default) nothing answers (404), as before the flag.
 *
 *   GET    /                         the teams, with how many people each has and its leads; the person's own teams; the
 *                                    workspace's people (the pickers' names); whether this person manages teams
 *   POST   /                         a new team {name, description?}                                        owners
 *   GET    /:id                      one team: its people (leads first), its records as this person sees them, its changes
 *   GET    /:id/changes?before=      older changes (Show more)
 *   PATCH  /:id                      rename it, or change its description {name?, description?}             owners
 *   DELETE /:id                      delete it (its records become private to their owners)                  owners
 *   POST   /:id/people               add people {people: [id...], role?: member|lead}                        owners
 *   POST   /:id/people/:user         make someone a lead or a member again {role}                           owners
 *   DELETE /:id/people/:user         take someone out of the team                                           owners
 *
 * Everyone in the workspace reads the teams (so a person can pick the team that sees a record); only its owners change
 * them. Every change is kept (workspace_team_changes) with who made it.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { canAccount } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import { PackError } from "./pack-api.js";
import { recordsSharedWith } from "./record-areas.js";
import * as T from "./teams.js";
import { teamsOn } from "./visibility.js";

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { const v = await fn(req, res); res.status(status).json(v ?? {}); }
  catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};

/** The workspace's people as the pickers and the team page name them (id, name, address, role); empty when unreachable. */
async function workspacePeople(s: Session): Promise<{ user_id: string; name: string | null; email: string | null; account_role: string }[]> {
  try {
    const t = await (await import("./admin.js")).team(s.slug);
    return t.members.filter((m) => m.user_id && m.status === "active").map((m) => ({ user_id: m.user_id, name: m.name ?? null, email: m.email ?? null, account_role: m.account_role }));
  } catch { return []; }
}

export function teamAppRouter(): Router {
  const r = express.Router();
  // The flag is read per request: off, every request passes on (and nothing else answers it: 404).
  r.use((_req, _res, next) => (teamsOn() ? next() : next("router")));
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "64kb" }));
  r.use(customerSession);
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const manages = (res: Response) => canAccount(S(res).accountRole, "team");
  const owners = (_req: Request, res: Response, next: NextFunction) =>
    (manages(res) ? next() : void res.status(403).json({ error: "Only the workspace's owners manage its teams. Ask an owner to change a team." }));
  const who = (res: Response) => S(res).user ?? null;
  const actor = (res: Response) => ({ role: S(res).accountRole ?? null, userId: S(res).user ?? null });
  const id = (req: Request) => String(req.params.id);

  r.get("/", answer(async (_req, res) => {
    const s = S(res);
    const [teams, mine, people] = await Promise.all([T.listTeams(s.org), s.user ? T.teamsOf(s.org, s.user) : [], workspacePeople(s)]);
    return { teams, mine, people, me: s.user, can_manage: manages(res) };
  }));
  r.post("/", owners, answer(async (req, res) => ({ team: await T.createTeam(S(res).org, who(res), req.body ?? {}) }), 201));
  r.get("/:id", answer(async (req, res) => {
    const s = S(res);
    const team = await T.teamOrThrow(s.org, id(req));
    const [people, changes, records, everyone] = await Promise.all([T.teamPeople(s.org, team.id), T.teamChanges(s.org, team.id),
      recordsSharedWith(s.org, team.id, actor(res)), workspacePeople(s)]);
    const named = (u: string | null) => (u ? everyone.find((p) => p.user_id === u) ?? null : null);
    return {
      team, can_manage: manages(res), me: s.user,
      people: people.map((p) => ({ ...p, name: named(p.user_id)?.name ?? null, email: named(p.user_id)?.email ?? null })),
      records, changes: { ...changes, changes: changes.changes.map((c) => ({ ...c, by_name: named(c.by)?.name ?? named(c.by)?.email ?? null, user_name: named(c.user_id)?.name ?? named(c.user_id)?.email ?? null })) },
      // Who may be added: the workspace's people not in it yet.
      candidates: everyone.filter((p) => !people.some((x) => x.user_id === p.user_id)),
    };
  }));
  r.get("/:id/changes", answer(async (req, res) => {
    const team = await T.teamOrThrow(S(res).org, id(req));
    const before = req.query.before === undefined ? null : Number(req.query.before);
    if (before !== null && (!Number.isInteger(before) || before < 1)) throw new PackError("before: a change's id", 400);
    return T.teamChanges(S(res).org, team.id, { before });
  }));
  r.patch("/:id", owners, answer(async (req, res) => ({ team: await T.updateTeam(S(res).org, who(res), id(req), req.body ?? {}) })));
  r.delete("/:id", owners, answer(async (req, res) => T.deleteTeam(S(res).org, who(res), id(req))));
  r.post("/:id/people", owners, answer(async (req, res) => ({ people: await T.addTeamPeople(S(res).org, who(res), id(req), req.body?.people, req.body?.role ?? "member") })));
  r.post("/:id/people/:user", owners, answer(async (req, res) => ({ people: await T.setTeamRole(S(res).org, who(res), id(req), String(req.params.user), req.body?.role) })));
  r.delete("/:id/people/:user", owners, answer(async (req, res) => ({ people: await T.removeTeamPerson(S(res).org, who(res), id(req), String(req.params.user)) })));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
