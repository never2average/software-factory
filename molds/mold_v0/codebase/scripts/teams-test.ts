// Teams inside a workspace and per-record visibility (mold_v0-259, flag teams; src/teams.ts, src/team-routes.ts,
// src/visibility.ts, sql/migrations/0050_teams_and_visibility.sql), offline: an embedded database, a fake sign-in, the
// fixture scripts/fixtures/packs/fixture_teams (projects shared with a team by default, notes private by default with
// collaborators, places with no visibility; a project's page lists and counts its notes, its tab counts them per row,
// metrics count both). `npm run test:teams`.
//   1. Off (the default): /api/teams answers nothing, no record carries a visibility, every record is the workspace's.
//   2. The area's declaration is checked (modes, default, a shared area, a repository's area).
//   3. Teams: only the workspace's owners manage them (create, rename, add and remove people, make a lead, delete); every
//      person of the workspace reads them; every membership change is kept, with who made it.
//   4. Writes: a new record takes its area's default (a team: the writer's one team), owned by its writer; a team the
//      writer is not in, a mode the area does not take, collaborators where the area names none, a visibility that would
//      hide the record from its writer are refused; a record written before the flag stays open to the workspace.
//   5. Every read path hides a private or team record from a person who may not see it (a member of another team, a
//      viewer, someone not named on it) and shows it to its team, its collaborators and the workspace's owners: the list,
//      the record, the record page, its related list and computed facts, a tab's computed column, the record picker,
//      the CSV export, the data API, metrics and the list's cards, the MCP list, get and export tools and the shell's
//      list_records and get_record, the workspace agent's tools (its session token acts as the person), a pack tool's
//      ctx.records, a reference check, and the developer API's door (no person: the workspace's records only).
//   6. Writes follow the same rule: another person's private record cannot be changed, moved, deleted or shared (404);
//      Share is its owner's, its team lead's or an owner's; a lead's change is checked as anyone's.
//   7. The database is the one place: a tenant query with a viewer set sees only what that person may; one with no
//      viewer at all sees only what is open to the workspace (it fails closed); writes are refused by the policy too.
//   8. Workspace isolation: another workspace's teams and records never show, whatever the keys or ids.
//   9. Leaving: a person taken out of a team no longer sees its records; one removed from the workspace leaves its teams;
//      a deleted team's records become private to their owners.
//  10. Off again: every record is the workspace's again (nothing hidden), and the routes answer nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams", "pack.json"), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const sorted = (xs: string[]) => [...xs].sort();

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { RecordAreaSchema } = await import("../src/pack-api.js");
  const { getDb } = await import("../src/db.js");
  const { withTenant, withViewer } = await import("../src/tenant-scope.js");
  const { dataApi } = await import("../src/data-api.js");
  const { callGeneratedTool } = await import("../src/mcp-tools.js");
  const { API_VIEWER } = await import("../src/visibility.js");
  const db = await getDb();
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_teams", name: "Fixture teams", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams") }, declared: compileDeclarations(j) } as never]);
  install(FIXTURE);
  const A = (await createOrg(`Teams A ${STAMP}`)).org, B = (await createOrg(`Teams B ${STAMP}`)).org;
  const a = A.orgId, b = B.orgId;
  const http = await startHttp();
  const owner = await http.signInAs(A, "owner"), design = await http.signInAs(A, "member"), lead = await http.signInAs(A, "member"),
    ops = await http.signInAs(A, "member"), collab = await http.signInAs(A, "member"), viewer = await http.signInAs(A, "viewer"), ownerB = await http.signInAs(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const call = async (who: { token: string }, method: string, p: string, body?: unknown) => {
    const r = await http.req(method, p, h(who.token), body);
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const get = (who: { token: string }, p: string) => call(who, "GET", p);
  const post = (who: { token: string }, p: string, body: unknown = {}) => call(who, "POST", p, body);
  const keysOf = (x: { records?: { key: string }[] }) => sorted((x.records ?? []).map((r) => r.key));
  const people = { owner, design, lead, ops, collab, viewer } as const;
  type Who = keyof typeof people;
  const orgOf = (who: Who) => ({ ...A, userId: people[who].userId, role: who === "owner" ? "owner" as const : who === "viewer" ? "viewer" as const : "member" as const });

  // A record written before the flag (and one in B under the same key, and one there under another key).
  await ra.asWriter({ by: "people", id: owner.userId }, async () => {
    await ra.workspaceRecords("fixture_teams", a).put("notes", "n-old", { title: "Old note", data: { topic: "plan", body: "Written before teams" } });
    await ra.workspaceRecords("fixture_teams", b).put("notes", "n-private", { title: "B's note", data: { topic: "risk" } });
    await ra.workspaceRecords("fixture_teams", b).put("projects", "b-project", { title: "B's project", data: { status: "active" } });
  });

  // ---------- 1. off ----------
  {
    assert.equal((await get(owner, "/api/teams")).status, 404, "off: no teams route");
    const list = await get(design, "/api/records/notes");
    assert.equal(list.status, 200);
    assert.ok(list.body.records.every((r: any) => r.visibility === undefined), "off: no record carries a visibility");
    assert.equal(list.body.area.visibility, undefined, "off: the area says nothing of it");
    const c = await connect(orgOf("design"));
    const tools = (await c.client.listTools()).tools;
    assert.ok(!JSON.stringify(tools.find((t) => t.name === "fixture_teams_create_notes")?.inputSchema ?? {}).includes("visibility"), "off: the create tool takes no visibility");
    await c.close();
    ok("off (the default): /api/teams answers nothing, no record or area carries a visibility, the tools take none");
  }
  F.setFeaturesForTest({ teams: true, record_pages: true });

  // ---------- 2. the declaration ----------
  {
    const area = clone(FIXTURE.record_areas[1]);
    const bad = (patch: Record<string, unknown>, re: RegExp, what: string) => {
      const r = RecordAreaSchema.safeParse({ ...area, ...patch });
      assert.ok(!r.success && re.test(JSON.stringify(r.error.issues)), `${what}: ${r.success ? "accepted" : JSON.stringify(r.error.issues)}`);
    };
    bad({ visibility: { modes: ["team"], default: "private" } }, /not one of modes/, "a default outside the modes");
    bad({ visibility: { modes: ["team", "team"], default: "team" } }, /listed twice/, "a mode twice");
    bad({ visibility: { modes: ["everyone"], default: "everyone" } }, /invalid/i, "an unknown mode");
    bad({ scope: "platform", visibility: { modes: ["workspace"], default: "workspace" } }, /workspace's own records/, "a shared area");
    bad({ repository: "files", visibility: { modes: ["workspace"], default: "workspace" } }, /repository/, "an area fed by a repository");
    assert.ok(RecordAreaSchema.safeParse(area).success);
    ok("an area's visibility is checked: its default one of its modes, each mode once and known, a workspace area of the shell's own tables");
  }

  // ---------- 3. teams ----------
  let designId = 0, opsId = 0;
  {
    assert.equal((await post(design, "/api/teams", { name: "Design" })).status, 403, "a member does not create a team");
    const d = await post(owner, "/api/teams", { name: "Design", description: "Screens and flows" });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    designId = d.body.team.id;
    opsId = (await post(owner, "/api/teams", { name: "Ops" })).body.team.id;
    assert.equal((await post(owner, "/api/teams", { name: "design" })).status, 409, "a name is unique in the workspace (any case)");
    assert.equal((await post(owner, `/api/teams/${designId}/people`, { people: [design.userId] })).status, 200);
    assert.equal((await post(owner, `/api/teams/${designId}/people`, { people: [lead.userId], role: "lead" })).status, 200);
    assert.equal((await post(owner, `/api/teams/${opsId}/people`, { people: [ops.userId, lead.userId] })).status, 200);
    assert.equal((await post(owner, `/api/teams/${opsId}/people/${encodeURIComponent(lead.userId)}`, { role: "lead" })).status, 200);
    assert.equal((await call(owner, "DELETE", `/api/teams/${opsId}/people/${encodeURIComponent(lead.userId)}`)).status, 200, "taken out of Ops");
    assert.equal((await post(lead, `/api/teams/${designId}/people`, { people: [viewer.userId] })).status, 403, "a lead does not manage the team's people (owners do)");
    assert.equal((await call(design, "PATCH", `/api/teams/${designId}`, { name: "Mine" })).status, 403, "a member does not rename it");
    const list = await get(viewer, "/api/teams");
    assert.equal(list.status, 200, "every person of the workspace reads the teams");
    assert.deepEqual(list.body.teams.map((t: any) => [t.name, t.members]), [["Design", 2], ["Ops", 1]]);
    assert.equal(list.body.can_manage, false);
    assert.deepEqual((await get(design, "/api/teams")).body.mine.map((t: any) => [t.name, t.role]), [["Design", "member"]], "a person's own teams, with their role");
    const page = await get(design, `/api/teams/${designId}`);
    assert.deepEqual(page.body.people.map((p: any) => [p.user_id, p.role]), [[lead.userId, "lead"], [design.userId, "member"]], "leads first");
    const opsPage = await get(owner, `/api/teams/${opsId}`);
    assert.deepEqual(opsPage.body.changes.changes.map((c: any) => [c.action, c.user_id, c.by]).reverse(),
      [["created", null, owner.userId], ["member_added", ops.userId, owner.userId], ["member_added", lead.userId, owner.userId], ["lead_set", lead.userId, owner.userId], ["member_removed", lead.userId, owner.userId]],
      "every change of the team and its people is kept, with who made it");
    const stored = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_team_changes WHERE org_id = $1", [a]);
    assert.ok(stored[0]!.n >= 7, "kept in the database");
    ok("teams: only owners manage them (members and leads refused), everyone reads them and their own; leads first; each change kept with who made it");
  }

  // ---------- 4. writes ----------
  const create = (who: Who, area: string, key: string, body: Record<string, unknown>) => post(people[who], `/api/data/${area}`, { key, ...body });
  {
    const p = await create("design", "projects", "p-design", { title: "Design system", data: { summary: "Shared parts", status: "active", started: "2026-10-01" } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.deepEqual(p.body.record.visibility, { mode: "team", team: { id: designId, name: "Design" }, owner: design.userId, collaborators: [] }, "a project: its area's default, the writer's one team, owned by them");
    const n1 = await create("design", "notes", "n-private", { title: "My draft", data: { project: "p-design", topic: "plan", body: "Only mine" } });
    assert.deepEqual(n1.body.record.visibility, { mode: "private", team: null, owner: design.userId, collaborators: [] }, "a note: private by default");
    assert.equal((await create("design", "notes", "n-team", { title: "Team plan", data: { project: "p-design", topic: "decision" }, visibility: { mode: "team", team: "Design" } })).status, 201, "a team note (by the team's name)");
    assert.equal((await create("design", "notes", "n-collab", { title: "With a colleague", data: { project: "p-design", topic: "risk" }, visibility: { mode: "private", collaborators: [collab.userId] } })).status, 201);
    assert.equal((await create("owner", "notes", "n-open", { title: "For everyone", data: { project: "p-design", topic: "plan" }, visibility: { mode: "workspace" } })).status, 201);
    assert.equal((await create("ops", "projects", "p-ops", { title: "Ops runbook", data: { status: "planned" } })).status, 201);
    assert.equal((await create("owner", "places", "pl-1", { title: "Head office", data: { city: "Lisbon" } })).status, 201, "an area with no visibility as before");
    const refuse = async (who: Who, body: Record<string, unknown>, status: number, re: RegExp, what: string) => {
      const r = await create(who, "notes", `n-x-${Math.random().toString(36).slice(2, 7)}`, { title: "x", data: { topic: "plan" }, ...body });
      assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, re, what);
    };
    await refuse("design", { visibility: { mode: "team", team: opsId } }, 403, /not in Ops/, "a team the writer is not in");
    await refuse("design", { visibility: { mode: "everyone" } }, 400, /one of private, team, workspace/, "a mode the area does not take");
    await refuse("design", { visibility: { mode: "team", team: 999999 } }, 400, /no team/, "a team that does not exist");
    await refuse("design", { visibility: { mode: "private", collaborators: ["not a person"] } }, 400, /collaborators/, "a collaborator that is no person's id");
    await refuse("collab", { visibility: { mode: "team" } }, 400, /in no team/, "team by default, in no team: choose");
    await refuse("design", { visibility: { mode: "team", team: designId, owner: ops.userId } }, 400, /has no owner/, "a visibility's owner is its writer's, never given");
    const noCollab = clone(FIXTURE);
    noCollab.record_areas[1].visibility.collaborators = false;
    install(noCollab);
    await refuse("design", { visibility: { mode: "private", collaborators: [collab.userId] } }, 400, /name no collaborators/, "collaborators where the area names none");
    install(FIXTURE);
    // A lead may change a team record, never so that they would not see it.
    const hide = await post(lead, "/api/data/notes/n-team/visibility", { visibility: { mode: "private" } });
    assert.equal(hide.status, 400, JSON.stringify(hide.body));
    assert.match(hide.body.error, /would no longer see/, "a visibility that would hide it from its writer is refused");
    const old = await get(owner, "/api/records/notes/n-old");
    assert.deepEqual(old.body.record.visibility, { mode: "workspace", team: null, owner: null, collaborators: [] }, "a record written before the flag: open to the workspace");
    // A run, the shell or an account key adds a record no person owns: open to the workspace unless it says.
    const sys = await ra.asWriter({ by: "run", id: "seed" }, () => ra.workspaceRecords("fixture_teams", a).create("notes", "n-run", { title: "From a run", data: { topic: "plan" } }));
    assert.deepEqual(sys.visibility, { mode: "workspace", team: null, owner: null, collaborators: [] }, "no person: open to the workspace");
    ok("writes: a new record takes the area's default (the writer's one team; private) owned by its writer, or what it names; refused in words: a team the writer is not in or that does not exist, a mode the area does not take, collaborators where it names none or that are no person, a visibility hiding it from the writer; before the flag, and from no person: the workspace's");
  }

  // Who should see which note and project.
  const NOTES: Record<Who, string[]> = {
    owner: ["n-collab", "n-old", "n-open", "n-private", "n-run", "n-team"],
    design: ["n-collab", "n-old", "n-open", "n-private", "n-run", "n-team"],
    lead: ["n-old", "n-open", "n-run", "n-team"],
    ops: ["n-old", "n-open", "n-run"],
    collab: ["n-collab", "n-old", "n-open", "n-run"],
    viewer: ["n-old", "n-open", "n-run"],
  };
  const PROJECTS: Record<Who, string[]> = { owner: ["p-design", "p-ops"], design: ["p-design"], lead: ["p-design"], ops: ["p-ops"], collab: [], viewer: [] };
  const everyone = Object.keys(people) as Who[];

  // ---------- 5. every read path ----------
  {
    for (const who of everyone) {
      const p = people[who];
      // The list and each record (the console's /api/records and the data API).
      assert.deepEqual(keysOf((await get(p, "/api/records/notes")).body), NOTES[who], `${who}: the list`);
      assert.deepEqual(keysOf((await get(p, "/api/data/notes")).body), NOTES[who], `${who}: the data API's list`);
      assert.deepEqual(keysOf((await get(p, "/api/records/projects")).body), PROJECTS[who], `${who}: the projects`);
      for (const k of NOTES.owner) {
        const want = NOTES[who].includes(k) ? 200 : 404;
        assert.equal((await get(p, `/api/records/notes/${k}`)).status, want, `${who}: the record ${k}`);
        assert.equal((await get(p, `/api/data/notes/${k}`)).status, want, `${who}: the data API's ${k}`);
      }
      // The CSV export pages the list (?audit=export): the same rows.
      assert.deepEqual(keysOf((await get(p, "/api/records/notes?audit=export")).body), NOTES[who], `${who}: the CSV export`);
      // The record picker (a reference field's choices), with and without a search.
      assert.deepEqual(sorted((await get(p, "/api/records/_page/_pick/notes")).body.records.map((r: any) => r.key)), NOTES[who], `${who}: the record picker`);
      assert.deepEqual(sorted((await get(p, "/api/records/_page/_pick/notes?q=note")).body.records.map((r: any) => r.key)),
        NOTES[who].filter((k) => ["n-old"].includes(k)), `${who}: the picker's search ("note": Old note)`);
      // The tab's column computed from related records: how many notes point at each project, as this person.
      const col = await get(p, `/api/records/_page/_columns/fixture_teams/projects?keys=p-design,p-ops`);
      const counted = Object.values(col.body.columns)[0] as Record<string, number>;
      const pointing = NOTES[who].filter((k) => ["n-private", "n-team", "n-collab", "n-open"].includes(k)).length;
      assert.equal(counted["p-design"], pointing, `${who}: the tab's computed Notes column`);
      // Metrics (a chart's and a card's counts): notes by topic, as this person.
      const m = await get(p, "/api/metrics?names=notes_by_topic");
      const total = (m.body.metrics[0].groups ?? []).reduce((n: number, g: any) => n + Number(g.value ?? 0), 0);
      assert.equal(total, NOTES[who].length, `${who}: metrics count only what they see: ${JSON.stringify(m.body.metrics[0]).slice(0, 300)}`);
      // The list's four cards (the server's sparklines for the area).
      const cards = await get(p, "/api/records/_console/notes/sparklines");
      assert.equal(cards.status, 200);
      assert.equal(cards.body.cards[0].value, NOTES[who].length, `${who}: the cards count what they see: ${JSON.stringify(cards.body.cards[0])}`);
    }
    ok("the console's list, record, CSV export (its pages), record picker and its search, a tab's computed column, metrics and the list's cards, and the data API: each person sees exactly the records open to the workspace, theirs, those they collaborate on and their teams'; owners all");

    // The record page (record_pages on): the project's page, its related notes and its computed facts.
    for (const who of ["owner", "design", "lead"] as Who[]) {
      const pg = await get(people[who], "/api/records/_page/projects/p-design");
      assert.equal(pg.status, 200, `${who}: ${JSON.stringify(pg.body)}`);
      const related = Object.values(pg.body.sections).find((s: any) => s.area === "notes") as any;
      assert.deepEqual(sorted(related.records.map((r: any) => r.key)), NOTES[who].filter((k) => ["n-private", "n-team", "n-collab", "n-open"].includes(k)).slice(0, 5), `${who}: the related list`);
      const count = Object.values(pg.body.facts).find((f: any) => f.op === "count") as any;
      assert.equal(count.value, related.records.length, `${who}: the computed fact`);
    }
    for (const who of ["ops", "collab", "viewer"] as Who[]) assert.equal((await get(people[who], "/api/records/_page/projects/p-design")).status, 404, `${who}: no page of a project they may not see`);
    ok("the record page: its related list and its computed facts count only what the person may see; a project they may not see has no page (404)");

    // MCP: the generated list, get and export tools, the shell's list_records and get_record, as each person.
    for (const who of everyone) {
      const c = await connect(orgOf(who));
      const r = async (name: string, args: Record<string, unknown>) => (await c.call(name, args));
      assert.deepEqual(sorted((await r("fixture_teams_list_notes", {})).structuredContent.records.map((x: any) => x.key)), NOTES[who], `${who}: list_notes`);
      assert.deepEqual(sorted((await r("list_records", { area: "notes" })).structuredContent.records.map((x: any) => x.key)), NOTES[who], `${who}: list_records`);
      for (const k of ["n-private", "n-team", "n-collab"]) {
        const got = await r("fixture_teams_get_notes", { key: k });
        assert.equal(!got.isError, NOTES[who].includes(k), `${who}: get_notes ${k}`);
        assert.equal(!(await r("get_record", { area: "notes", key: k })).isError, NOTES[who].includes(k), `${who}: get_record ${k}`);
      }
      const csv = String((await r("fixture_teams_export_notes", {})).structuredContent.csv);
      for (const k of NOTES.owner) assert.equal(csv.includes(`\n${k},`), NOTES[who].includes(k), `${who}: export_notes ${k}`);
      const mt = await r("fixture_teams_get_metrics", { names: ["notes_by_topic"] });
      assert.ok(!mt.isError, JSON.stringify(mt.content));
      const mtotal = (mt.structuredContent.metrics[0].groups ?? []).reduce((n: number, g: any) => n + Number(g.value ?? 0), 0);
      assert.equal(mtotal, NOTES[who].length, `${who}: get_metrics counts what they see`);
      await c.close();
    }
    ok("MCP: the generated list, get and export tools and the shell's list_records and get_record answer each person what they may see");

    // The workspace agent (mold_v0-243/250): its session token acts as the person who started it, through the same tools.
    const agent = { ...orgOf("lead"), agentSession: { session: "hss_test", allowed: [] as string[] } };
    assert.deepEqual(sorted(((await callGeneratedTool(agent, "fixture_teams_list_notes", {})) as any).structuredContent.records.map((x: any) => x.key)), NOTES.lead, "the agent's list as its starter");
    assert.ok(((await callGeneratedTool(agent, "fixture_teams_get_notes", { key: "n-private" })) as any).isError, "the agent cannot read a record its starter may not");
    // A pack tool's ctx.records and the shell's own work: the actor's view, or every record.
    const asLead = await ra.workspaceRecords("fixture_teams", a, { role: "member", userId: lead.userId }).list("notes", { limit: 50 });
    assert.deepEqual(keysOf(asLead), NOTES.lead, "ctx.records for a person: their view");
    assert.deepEqual(keysOf(await ra.workspaceRecords("fixture_teams", a).list("notes", { limit: 50 })), NOTES.owner, "the shell's own work (a run, a schedule): every record");
    // A reference check: a person cannot point a record at one they may not see.
    const ref = await create("ops", "notes", "n-ref", { title: "x", data: { project: "p-design", topic: "plan" } });
    assert.equal(ref.status, 400, JSON.stringify(ref.body));
    assert.match(ref.body.error, /no projects record p-design/, "a reference to a record the writer may not see is refused as missing");
    // The developer API's door: a workspace's backend is no person of it.
    const api = await withTenant(a, () => withViewer(API_VIEWER, () => dataApi.list({ orgId: a, role: null, userId: "key:sk_test" }, "notes", { limit: 50 })));
    assert.deepEqual(keysOf(api), ["n-old", "n-open", "n-run"], "the developer API: the records open to the workspace");
    const apiWrite = await withTenant(a, () => withViewer(API_VIEWER, () => dataApi.create({ orgId: a, role: null, userId: "key:sk_test" }, "notes", "n-api", { title: "From a backend", data: { topic: "plan" } })));
    assert.equal(apiWrite.record.visibility?.mode, "workspace", "and what it adds is the workspace's");
    await assert.rejects(withTenant(a, () => withViewer(API_VIEWER, () => dataApi.create({ orgId: a, role: null, userId: "key:sk_test" }, "notes", "n-api2", { title: "x", data: {}, visibility: { mode: "private" } }))), /no person of the workspace/);
    ok("the workspace agent's tools act as its starter; a pack tool's ctx.records as its person, the shell's own work every record; a reference check finds only what the writer may see; the developer API's door sees and adds the workspace's records only");
  }

  // ---------- 6. writes follow the same rule; Share ----------
  {
    const hidden = { title: "x", data: { topic: "risk" } };
    assert.equal((await call(ops, "PUT", "/api/data/notes/n-private", hidden)).status, 404, "another's private record: no update");
    assert.equal((await call(lead, "PUT", "/api/data/notes/n-collab", hidden)).status, 404, "not named on it: no update");
    assert.equal((await call(ops, "DELETE", "/api/data/notes/n-private")).status, 404, "no delete");
    assert.equal((await post(ops, "/api/data/notes/n-private/visibility", { visibility: { mode: "workspace" } })).status, 404, "no share");
    assert.ok((await post(ops, "/api/data/notes", { key: "n-private", title: "x", data: { topic: "plan" } })).status === 409, "nor a record over its key");
    const c = await connect(orgOf("ops"));
    assert.ok((await c.call("fixture_teams_update_notes", { key: "n-private", data: { topic: "plan" } })).isError, "nor through MCP");
    await c.close();
    // Share: the owner, a lead of its team, an owner of the workspace; not a collaborator, not a member of its team.
    assert.equal((await post(collab, "/api/data/notes/n-collab/visibility", { visibility: { mode: "workspace" } })).status, 403, "a collaborator does not share it");
    const shareTeam = await post(design, "/api/data/projects/p-design/visibility", { visibility: { mode: "workspace" } });
    assert.equal(shareTeam.status, 200, "its owner shares it");
    assert.deepEqual(keysOf((await get(viewer, "/api/records/projects")).body), ["p-design"], "now everyone sees it");
    assert.equal((await post(lead, "/api/data/projects/p-design/visibility", { visibility: { mode: "team", team: designId } })).status, 403, "a lead shares only while it is the team's (now the workspace's)");
    assert.equal((await post(owner, "/api/data/projects/p-design/visibility", { visibility: { mode: "team", team: designId, collaborators: [collab.userId] } })).status, 200, "an owner shares any");
    assert.deepEqual(keysOf((await get(viewer, "/api/records/projects")).body), [], "back to the team");
    assert.deepEqual(keysOf((await get(collab, "/api/records/projects")).body), ["p-design"], "a collaborator sees it");
    const byLead = await post(lead, "/api/data/projects/p-design/visibility", { visibility: { mode: "team", team: designId, collaborators: [] } });
    assert.equal(byLead.status, 200, `a lead of its team changes it: ${JSON.stringify(byLead.body)}`);
    assert.deepEqual(byLead.body.record.visibility.owner, design.userId, "its owner stays");
    assert.equal((await get(collab, "/api/records/projects/p-design")).status, 404);
    const det = await get(design, "/api/records/notes/n-private");
    assert.equal(det.body.can_share, true, "the record says its owner may share it");
    assert.equal((await get(lead, "/api/records/notes/n-team")).body.can_share, true, "a lead of its team may");
    assert.equal((await get(owner, "/api/records/notes/n-team")).body.can_share, true, "an owner may");
    assert.equal((await get(collab, "/api/records/notes/n-collab")).body.can_share, false, "a collaborator may not");
    // The MCP create tool takes who sees the new record (only for such an area, only while on).
    const cm = await connect(orgOf("design"));
    const schema = JSON.stringify((await cm.client.listTools()).tools.find((t) => t.name === "fixture_teams_create_notes")?.inputSchema ?? {});
    assert.ok(schema.includes("visibility") && !JSON.stringify((await cm.client.listTools()).tools.find((t) => t.name === "fixture_teams_create_places")?.inputSchema ?? {}).includes("visibility"), "create_notes takes visibility; create_places (no visibility) does not");
    const made = await cm.call("fixture_teams_create_notes", { key: "n-mcp", title: "From an AI client", data: { topic: "plan" }, visibility: { mode: "team", team: "Design" } });
    assert.ok(!made.isError, JSON.stringify(made.content));
    assert.equal(made.structuredContent.record.visibility.mode, "team");
    await cm.close();
    assert.equal((await get(lead, "/api/records/notes/n-mcp")).status, 200, "its team sees it");
    assert.equal((await get(ops, "/api/records/notes/n-mcp")).status, 404, "another team does not");
    assert.equal((await call(owner, "DELETE", "/api/data/notes/n-mcp")).status, 204, "an owner of the workspace deletes it");
    // The edit form's visibility, through the record page's edit action.
    const edit = await post(design, "/api/records/_page/projects/p-design/actions/edit", { title: "Design system", data: { summary: "Shared parts", status: "active" }, visibility: { mode: "team", team: designId } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    ok("writes follow the same rule: no update, delete, share or key reuse of a record the person may not see (404, 409), nor through MCP; Share is its owner's, its team lead's while it is the team's, or an owner's; its owner stays; the record says who may share it");
  }

  // ---------- 7. the database is the one place ----------
  {
    const seen = (viewerId: string | null) => withTenant(a, () => withViewer(viewerId, async () => sorted((await db.query<{ key: string }>(
      "/* tenant: teams test */ SELECT key FROM workspace_records WHERE org_id = $1 AND area = 'notes'", [a])).map((r) => r.key))));
    assert.deepEqual(await seen(ops.userId), [...NOTES.ops, "n-api"].sort(), "a raw query as a person: their records only");
    assert.deepEqual(await seen(null), [...NOTES.owner, "n-api"].sort(), "no viewer in scope: every record (the shell's own work)");
    const counted = await withTenant(a, () => withViewer(viewer.userId, async () => (await db.query<{ n: number }>("/* tenant: teams test */ SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND area = 'notes'", [a]))[0]!.n));
    assert.equal(counted, NOTES.viewer.length + 1, "a count as a viewer");
    const touched = await withTenant(a, () => withViewer(ops.userId, async () => (await db.query("/* tenant: teams test */ UPDATE workspace_records SET title = 'x' WHERE org_id = $1 AND key = 'n-private' RETURNING key", [a])).length));
    assert.equal(touched, 0, "an update of a record the person may not see touches nothing");
    // A tenant transaction that sets no viewer at all: only what is open to the workspace (fails closed).
    const role = (await db.query<{ r: string }>("SELECT app_tenant_role() AS r"))[0]!.r;
    const bare = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${role}`);
      await tx.query("SELECT set_config('app.org_id', $1, true)", [String(a)]);
      return sorted((await tx.query<{ key: string }>("/* tenant: teams test */ SELECT key FROM workspace_records WHERE org_id = $1 AND area = 'notes'", [a])).map((r) => r.key));
    });
    assert.deepEqual(bare, ["n-api", "n-old", "n-open", "n-run"], "no app.viewer: the workspace's open records only");
    await assert.rejects(withTenant(a, () => withViewer(ops.userId, () => db.query("/* tenant: teams test */ INSERT INTO workspace_records (org_id, pack, area, key, visibility, owner_id) VALUES ($1, 'fixture_teams', 'notes', 'n-sneak', 'private', $2)", [a, design.userId]))),
      /row-level security|policy/, "the policy refuses a row the writer would not see");
    const [pol] = await db.query<{ permissive: string }>("SELECT permissive FROM pg_policies WHERE tablename = 'workspace_records' AND policyname = 'record_visibility'");
    assert.equal(pol?.permissive, "RESTRICTIVE", "a restrictive policy, over tenant_isolation");
    ok("the database is the one place: a raw tenant query, count or update as a person reaches only what they may see; no viewer set sees only the workspace's open records (fails closed); the restrictive policy refuses a hidden row's insert");
  }

  // ---------- 8. workspace isolation ----------
  {
    assert.equal((await get(ownerB, `/api/teams/${designId}`)).status, 404, "another workspace's team: not found");
    assert.deepEqual((await get(ownerB, "/api/teams")).body.teams, [], "B has no teams");
    assert.equal((await post(ownerB, `/api/teams/${designId}/people`, { people: [ownerB.userId] })).status, 404, "nor joins A's");
    assert.deepEqual(keysOf((await get(ownerB, "/api/records/notes")).body), ["n-private"], "B's owner sees B's own note only");
    assert.equal((await get(ownerB, "/api/records/notes/n-private")).body.record.title, "B's note");
    assert.equal((await get(design, "/api/records/projects/b-project")).status, 404);
    const shareB = await post(ownerB, "/api/data/notes/n-private/visibility", { visibility: { mode: "team", team: designId } });
    assert.equal(shareB.status, 400, "B cannot share with A's team");
    const c = await connect({ ...B, userId: ownerB.userId, role: "owner" });
    assert.deepEqual(sorted((await c.call("fixture_teams_list_notes", {})).structuredContent.records.map((x: any) => x.key)), ["n-private"]);
    await c.close();
    ok("workspace isolation: another workspace's teams are not found nor joined, its records never listed or shared with A's teams");
  }

  // ---------- 9. leaving ----------
  {
    assert.equal((await call(owner, "DELETE", `/api/teams/${designId}/people/${encodeURIComponent(lead.userId)}`)).status, 200);
    assert.deepEqual(keysOf((await get(lead, "/api/records/notes")).body), ["n-api", "n-old", "n-open", "n-run"], "taken out of the team: its records go");
    const del = await call(owner, "DELETE", `/api/teams/${opsId}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.records, 1, "Ops' one project made private");
    const pOps = await get(owner, "/api/records/projects/p-ops");
    assert.deepEqual([pOps.body.record.visibility.mode, pOps.body.record.visibility.owner], ["private", ops.userId], "private to its owner");
    assert.deepEqual(keysOf((await get(ops, "/api/records/projects")).body), ["p-ops"], "its owner still sees it");
    assert.equal((await get(owner, `/api/teams/${opsId}`)).status, 404, "the team is gone");
    // Removed from the workspace: out of its teams.
    const team = await get(owner, "/api/app/team");
    const m = team.body.members.find((x: any) => x.user_id === design.userId);
    assert.ok(m, "the designer is a member");
    const rm = await post(owner, `/api/app/team/members/${encodeURIComponent(m.id)}/remove`);
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    assert.deepEqual((await get(owner, `/api/teams/${designId}`)).body.people.map((p: any) => p.user_id), [], "they left Design too");
    ok("leaving: out of a team its records go; a deleted team's records become private to their owners; someone removed from the workspace leaves its teams");
  }

  // ---------- 10. off again ----------
  {
    F.setFeaturesForTest({ teams: false, record_pages: true });
    assert.equal((await get(owner, "/api/teams")).status, 404, "off: no teams route");
    assert.deepEqual(keysOf((await get(viewer, "/api/records/notes")).body), [...NOTES.owner, "n-api"].sort(), "off: every record is the workspace's again");
    assert.ok((await get(viewer, "/api/records/notes")).body.records.every((r: any) => r.visibility === undefined), "and none carries a visibility");
    ok("off again: nothing is hidden and nothing is shown of visibility; the routes answer nothing");
  }
  await http.close();
  console.log("\nteams: all checks passed");
} finally {
  cleanup();
}
