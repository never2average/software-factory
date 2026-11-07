// Teams and visibility, part 2 (mold_v0-262, flag teams; src/visibility.ts, src/teams.ts, src/record-areas.ts,
// sql/migrations/0053_inherited_visibility.sql, 0054_team_role_names.sql), offline: an embedded database, a fake sign-in,
// the fixture scripts/fixtures/packs/fixture_teams with, in memory, a history section on the projects' page, a tasks
// area that inherits its projects' visibility, and team roles in the app's words. `npm run test:teams` (after teams-test).
//   1. Creating a record in an area with both visibility and a history section returns (it hung: the writer's teams were
//      read on a second connection while the write's own transaction held the embedded database's one), in a single
//      write and in a batch, and its history line is kept; a share in a batch likewise.
//   2. Inherited visibility: a task is seen by whoever sees its project (its team, its owner, a workspace owner) and by
//      nobody else, in the API, a raw tenant query and a count; one with no project is open to the workspace; moving it
//      to another project or making the project private follows at once; a task takes no visibility of its own, offers
//      no Share; the declaration is checked (a single reference, to an area that declares its own modes).
//   3. Team roles in the app's words: lead / dev / viewer mapped onto the two levels; people added and changed by a
//      role's id, read back with its label; a change within a level kept as a change; only a lead-level role shares a
//      team's records; an unknown role refused with the roles named; without declared roles, Lead and Member as before.
//   4. The build (scripts/gen-packs.mjs): a pack's team_roles, the app's profile.json over it, reach the server's and the
//      console's profile only while teams is on (off: the files as before); a wrong list, or two packs declaring them,
//      refused; an inheriting area's declaration reaches the console as {inherit}.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const sorted = (xs: string[]) => [...xs].sort();
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams", "pack.json"), "utf8"));
// The projects' page keeps a history; tasks follow their project's visibility.
FIXTURE.record_areas[0].detail.tabs[0].sections.push({ title: "History", history: {} });
FIXTURE.record_areas.push({
  name: "tasks", label: "Tasks", role: "source", scope: "workspace",
  fields: [{ name: "project", label: "Project", type: "reference", to: "projects" }, { name: "state", label: "State", type: "text" }],
  visibility: { inherit: "project" },
});
const within = <T>(ms: number, what: string, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s (a write waiting on itself)`)), ms).unref())]);

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const T = await import("../src/teams.js");
  const { recordHistory } = await import("../src/record-history.js");
  const { RecordAreaSchema, TeamRolesSchema } = await import("../src/pack-api.js");
  const { getDb } = await import("../src/db.js");
  const { withTenant, withViewer } = await import("../src/tenant-scope.js");
  const db = await getDb();
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_teams", name: "Fixture teams", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams") }, declared: compileDeclarations(j) } as never]);
  install(FIXTURE);
  F.setFeaturesForTest({ teams: true, record_pages: true });
  const A = (await createOrg(`Teams 262 ${STAMP}`)).org, a = A.orgId;
  const http = await startHttp();
  const owner = await http.signInAs(A, "owner"), dev = await http.signInAs(A, "member"), lead = await http.signInAs(A, "member"), ops = await http.signInAs(A, "member"), viewer = await http.signInAs(A, "viewer");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const call = async (who: { token: string }, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(who.token), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const get = (who: { token: string }, p: string) => call(who, "GET", p);
  const post = (who: { token: string }, p: string, body: unknown = {}) => call(who, "POST", p, body);
  const keys = (x: { records?: { key: string }[] }) => sorted((x.records ?? []).map((r) => r.key));
  const actorOf = (p: { userId: string }, role: "member" | "owner" | "viewer" = "member") => ({ role, userId: p.userId });

  // Teams: Core (dev, lead as its lead) and Ops (ops). Roles are the built-in two until section 3.
  const core = await T.createTeam(a, owner.userId, { name: "Core" }), opsT = await T.createTeam(a, owner.userId, { name: "Ops" });
  await T.addTeamPeople(a, owner.userId, core.id, [dev.userId]);
  await T.addTeamPeople(a, owner.userId, core.id, [lead.userId], "lead");
  await T.addTeamPeople(a, owner.userId, opsT.id, [ops.userId]);

  // ---------- 1. a create with visibility and history returns ----------
  {
    const recs = ra.workspaceRecords("fixture_teams", a, actorOf(dev));
    const made = await within(20_000, "a create in an area with visibility and history", ra.asWriter({ by: "people", id: dev.userId }, () => recs.put("projects", "p-core", { title: "Core", data: { status: "active" } })));
    assert.deepEqual([made.visibility?.mode, made.visibility?.team?.name, made.visibility?.owner], ["team", "Core", dev.userId], "its area's default: the writer's one team, owned by them");
    const hist = await withTenant(a, () => recordHistory(a, ra.findArea("projects")!, "p-core"));
    assert.deepEqual(hist.lines.map((l) => l.action), ["created"], "its history line kept, in the same transaction");
    const updated = await within(20_000, "an update", recs.put("projects", "p-core", { title: "Core", data: { status: "done" } }));
    assert.equal(updated.data.status, "done");
    const named = await within(20_000, "a create naming its team", recs.put("projects", "p-named", { title: "Named", data: {}, visibility: { mode: "team", team: "Core" } }));
    assert.equal(named.visibility?.team?.name, "Core", "a named team is found on the write's own transaction too");
    const batch = await within(20_000, "a batch", recs.batch([{ op: "create", area: "projects", key: "p-b1", title: "B1", data: {} }, { op: "create", area: "projects", key: "p-b2", title: "B2", data: {}, visibility: { mode: "private" } }]));
    assert.deepEqual(batch.map((x) => (x as { record?: { visibility?: { mode: string } } }).record?.visibility?.mode), ["team", "private"], "a batch of creates by a person in a team");
    const viaHttp = await within(20_000, "the console's create", post(dev, "/api/data/projects", { key: "p-http", title: "From the console", data: { status: "planned" } }));
    assert.equal(viaHttp.status, 201, JSON.stringify(viaHttp.body));
    assert.equal((await withTenant(a, () => recordHistory(a, ra.findArea("projects")!, "p-core"))).lines.length, 2, "and the update's line");
    ok("a create in an area with visibility and a history section returns (single, named team, batch, the console's), its history kept: the writer's teams are read on the write's own transaction");
  }

  // ---------- 2. inherited visibility ----------
  {
    const recs = (p: { userId: string }, role: "member" | "owner" = "member") => ra.workspaceRecords("fixture_teams", a, actorOf(p, role));
    await ra.asWriter({ by: "people", id: dev.userId }, async () => {
      await recs(dev).put("projects", "p-open", { title: "Open", data: {}, visibility: { mode: "workspace" } });
      await recs(dev).put("tasks", "t-core", { title: "Core task", data: { project: "p-core", state: "doing" } });
      await recs(dev).put("tasks", "t-open", { title: "Open task", data: { project: "p-open" } });
      await recs(dev).put("tasks", "t-none", { title: "Loose task", data: {} });
    });
    const row = await recs(owner, "owner").get("tasks", "t-core");
    assert.deepEqual(row?.visibility, { mode: "inherit", team: null, owner: dev.userId, collaborators: [], parent: { area: "projects", key: "p-core" } }, "stored as following its project");
    assert.equal((await recs(owner, "owner").get("tasks", "t-none"))?.visibility?.mode, "workspace", "no project: open to the workspace");
    const sees = async (p: { token: string }) => keys((await get(p, "/api/records/tasks")).body);
    assert.deepEqual(await sees(dev), ["t-core", "t-none", "t-open"], "the project's team sees its task");
    assert.deepEqual(await sees(lead), ["t-core", "t-none", "t-open"], "its lead too");
    assert.deepEqual(await sees(ops), ["t-none", "t-open"], "another team does not");
    assert.deepEqual(await sees(viewer), ["t-none", "t-open"], "nor a viewer outside it");
    assert.deepEqual(await sees(owner), ["t-core", "t-none", "t-open"], "a workspace owner sees every task");
    assert.equal((await get(ops, "/api/records/tasks/t-core")).status, 404, "its page: not found for another team");
    const raw = (v: string | null) => withTenant(a, () => withViewer(v, async () => sorted((await db.query<{ key: string }>("/* tenant: teams 262 test */ SELECT key FROM workspace_records WHERE org_id = $1 AND area = 'tasks'", [a])).map((r) => r.key))));
    assert.deepEqual(await raw(ops.userId), ["t-none", "t-open"], "the database's own rule: a raw tenant query as another team");
    assert.deepEqual(await raw(dev.userId), ["t-core", "t-none", "t-open"], "and as the team");
    const n = await withTenant(a, () => withViewer(ops.userId, async () => (await db.query<{ n: number }>("/* tenant: teams 262 test */ SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND area = 'tasks'", [a]))[0]!.n));
    assert.equal(n, 2, "a count as another team");
    // Follows at once: the task moved to the open project, then the project made private.
    await recs(dev).put("tasks", "t-core", { title: "Core task", data: { project: "p-open", state: "doing" } });
    assert.deepEqual(await sees(ops), ["t-core", "t-none", "t-open"], "moved to an open project: everyone sees it");
    await recs(dev).put("tasks", "t-core", { title: "Core task", data: { project: "p-core", state: "doing" } });
    assert.equal((await post(dev, "/api/data/projects/p-core/visibility", { visibility: { mode: "private" } })).status, 200, "its project made private");
    assert.deepEqual(await sees(lead), ["t-none", "t-open"], "the team no longer sees the private project's task");
    assert.deepEqual(await sees(dev), ["t-core", "t-none", "t-open"], "its project's owner does");
    // No visibility of its own: none given, none shared, the MCP tool takes none.
    await assert.rejects(recs(dev).put("tasks", "t-x", { title: "X", data: { project: "p-open" }, visibility: { mode: "private" } }), /take no `visibility` of their own/, "a task takes no visibility");
    assert.equal((await post(dev, "/api/data/tasks/t-open/visibility", { visibility: { mode: "private" } })).status, 400, "nor is it shared");
    assert.equal((await get(dev, "/api/records/tasks/t-open")).body.can_share, false, "its page offers no Share");
    // A task cannot name a project its writer does not see (the reference check, as they read).
    await assert.rejects(recs(ops).put("tasks", "t-sneak", { title: "Sneak", data: { project: "p-core" } }), /p-core/, "a project the writer cannot see is not there");
    // The declaration: a single reference, to an area that declares its own modes.
    const tasks = FIXTURE.record_areas.find((x: { name: string }) => x.name === "tasks");
    const bad = (patch: Record<string, unknown>, re: RegExp, what: string) => { const r = RecordAreaSchema.safeParse({ ...tasks, ...patch }); assert.ok(!r.success && re.test(JSON.stringify(r.error.issues)), `${what}: ${r.success ? "accepted" : JSON.stringify(r.error.issues)}`); };
    bad({ visibility: { inherit: "state" } }, /single reference field/, "a text field");
    bad({ visibility: { inherit: "nope" } }, /not one of the area's fields/, "no such field");
    bad({ visibility: { inherit: "project", modes: ["private"] } }, /invalid|Unrecognized/i, "inherit with modes");
    const orphan = JSON.parse(JSON.stringify(FIXTURE));
    orphan.record_areas.find((x: { name: string }) => x.name === "tasks").fields[0].to = "places";
    orphan.record_areas.find((x: { name: string }) => x.name === "tasks").visibility = { inherit: "project" };
    assert.throws(() => install(orphan), /takes `visibility` from places through project, which declares no `visibility`/, "a parent with no visibility of its own is refused at build");
    install(FIXTURE);
    ok("inherited visibility: a task is seen by whoever sees its project (its team, its owner, an owner) and nobody else, in the API, a raw query and a count; no project: the workspace's; it follows a move and a private project at once; no visibility, Share or hidden project of its own; the declaration checked");
  }

  // ---------- 3. team roles in the app's words ----------
  {
    const roles = [{ id: "lead", label: "Lead", level: "lead" as const }, { id: "dev", label: "Developer", level: "member" as const }, { id: "viewer", label: "Viewer", level: "member" as const }];
    assert.ok(TeamRolesSchema.safeParse(roles).success, "lead, dev and viewer declare");
    for (const [v, re] of [[[roles[1], roles[2]], /each level/], [[roles[0], roles[0]], /listed twice/], [[roles[0], { ...roles[1], level: "boss" }], /invalid/i], [[roles[0]], /too_small|at least|>=2/i]] as const)
      assert.ok(!TeamRolesSchema.safeParse(v).success && re.test(JSON.stringify(TeamRolesSchema.safeParse(v).error!.issues)), `refused: ${JSON.stringify(v)}`);
    // Before: Lead and Member, as ever.
    const before = (await get(owner, `/api/teams/${core.id}`)).body;
    assert.deepEqual(before.roles.map((r: any) => r.id), ["lead", "member"], "no declared roles: Lead and Member");
    assert.deepEqual(before.people.map((p: any) => [p.role, p.role_label]), [["lead", "Lead"], ["member", "Member"]]);
    T.setTeamRolesForTest(roles);
    const qa = await http.signInAs(A, "member");
    assert.equal((await post(owner, `/api/teams/${core.id}/people`, { people: [qa.userId], role: "viewer" })).status, 200, "added as a Viewer");
    assert.equal((await post(owner, `/api/teams/${core.id}/people/${encodeURIComponent(dev.userId)}`, { role: "dev" })).status, 200, "made a Developer");
    const bad = await post(owner, `/api/teams/${core.id}/people`, { people: [ops.userId], role: "admin" });
    assert.deepEqual([bad.status, /lead, dev, viewer/.test(bad.body.error)], [400, true], "an unknown role refused, the roles named");
    const page = (await get(owner, `/api/teams/${core.id}`)).body;
    assert.deepEqual(page.roles.map((r: any) => [r.id, r.label, r.level]), roles.map((r) => [r.id, r.label, r.level]), "the page lists the app's roles");
    const by = Object.fromEntries(page.people.map((p: any) => [p.user_id, [p.role, p.role_id, p.role_label]]));
    assert.deepEqual([by[lead.userId], by[dev.userId], by[qa.userId]], [["lead", "lead", "Lead"], ["member", "dev", "Developer"], ["member", "viewer", "Viewer"]], "each with its role in the app's words and its level");
    assert.ok(page.changes.changes.some((c: any) => c.action === "role_set" && c.user_id === dev.userId && c.detail === "as Developer"), "a change within a level is kept as one");
    const [{ role_name }] = await db.query<{ role_name: string }>("SELECT role_name FROM workspace_team_members WHERE team_id = $1 AND user_id = $2", [core.id, qa.userId]);
    assert.equal(role_name, "viewer", "stored as its id beside its level");
    // What a role may do is its level's: a Viewer (member level) cannot share the team's records, the Lead can.
    const recs = ra.workspaceRecords("fixture_teams", a, actorOf(dev));
    await ra.asWriter({ by: "people", id: dev.userId }, () => recs.put("projects", "p-roles", { title: "Roles", data: {}, visibility: { mode: "team", team: "Core" } }));
    assert.equal((await post(qa, "/api/data/projects/p-roles/visibility", { visibility: { mode: "workspace" } })).status, 403, "a Viewer cannot change who sees the team's record");
    assert.equal((await post(lead, "/api/data/projects/p-roles/visibility", { visibility: { mode: "team", team: "Core", collaborators: [ops.userId] } })).status, 200, "the Lead can");
    assert.deepEqual(keys((await get(qa, "/api/records/projects")).body).includes("p-roles"), true, "a Viewer of the team sees its records");
    T.setTeamRolesForTest(null);
    assert.deepEqual((await get(owner, `/api/teams/${core.id}`)).body.people.find((p: any) => p.user_id === dev.userId).role_label, "Member", "roles no longer declared: the level's own word");
    ok("team roles in the app's words: lead / dev / viewer on the two levels, added and changed by id, read with their labels, a change within a level kept; only the lead level shares; an unknown role refused with the roles named; undeclared: Lead and Member");
  }
  // ---------- 4. the build ----------
  {
    const TMPB = mkdtempSync(path.join(tmpdir(), "teams-262-"));
    const ROLES = [{ id: "lead", label: "Lead", level: "lead" }, { id: "dev", label: "Developer", level: "member" }, { id: "viewer", label: "Viewer", level: "member" }];
    const build = (name: string, packRoles: unknown, profile: Record<string, unknown> | null) => {
      const copy = path.join(TMPB, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (x) => !skip.has(path.basename(x)) && x !== path.join(ROOT, "packs") && !x.startsWith(path.join(ROOT, "build")) });
      for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs", "fixture_teams"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      writeFileSync(path.join(copy, "packs", "fixture_teams", "pack.json"), JSON.stringify({ ...FIXTURE, ...(packRoles ? { team_roles: packRoles } : {}) }, null, 2));
      if (profile) writeFileSync(path.join(copy, "profile.json"), JSON.stringify(profile, null, 2));
      const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
      const read = (rel: string) => (existsSync(path.join(copy, rel)) ? readFileSync(path.join(copy, rel), "utf8") : "");
      return { status: g.status, out: `${g.stdout}\n${g.stderr}`, server: read("src/profile.generated.ts"), console: read("web/src/config/profile.generated.ts"), nav: read("web/src/config/pack-nav.generated.ts") };
    };
    try {
      const off = build("off", ROLES, null);
      assert.equal(off.status, 0, off.out.slice(-1500));
      assert.ok(!off.server.includes("team_roles") && !off.console.includes("team_roles"), "teams off: no roles in either profile module");
      const on = build("on", ROLES, { features: { teams: true } });
      assert.equal(on.status, 0, on.out.slice(-1500));
      assert.ok(on.server.includes('"team_roles"') && on.server.includes('"Developer"') && on.console.includes('"Viewer"'), "a pack's roles in the server's and the console's profile");
      assert.match(on.nav, /"visibility": \{\s*"inherit": "project"\s*\}/, "an inheriting area reaches the console as {inherit}");
      const app = build("app", ROLES, { features: { teams: true }, team_roles: [{ id: "owner_role", label: "Head", level: "lead" }, { id: "crew", label: "Crew", level: "member" }] });
      assert.equal(app.status, 0, app.out.slice(-1500));
      assert.ok(app.server.includes('"Head"') && !app.server.includes('"Developer"'), "the app's profile.json over the pack's");
      const bad = build("bad", [{ id: "dev", label: "Developer", level: "member" }, { id: "qa", label: "QA", level: "member" }], { features: { teams: true } });
      assert.ok(bad.status !== 0 && /team_roles: at least one role of each level/.test(bad.out), `one level only: refused: ${bad.out.slice(-400)}`);
      ok("the build: a pack's team roles (the app's profile.json over them) reach both profile modules only while teams is on; a list of one level refused; an inheriting area reaches the console as {inherit}");
    } finally { rmSync(TMPB, { recursive: true, force: true }); }
  }
  F.setFeaturesForTest(null);
  await http.close();
  console.log("\nteams (mold_v0-262): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
