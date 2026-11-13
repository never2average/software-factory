// A record's page, part 2 (mold_v0-254, flag record_pages), through the API (src/record-page-routes.ts), offline: an
// embedded database, a fake sign-in, the fixture scripts/fixtures/packs/fixture_pages (projects, environments, builds;
// the build and rebuild job kinds). Run by `npm run test:record-pages` after scripts/record-pages-test.ts.
//   1. Off (the default): /api/records/_page answers nothing (404, as before the flag); the record's own routes as before.
//   2. A build's actions by role: the member's (Re-run, Open project, Edit, Move, Copy link), the owner's (and Delete),
//      the viewer's (Open project, Copy link); each disabled one with its reason (Re-run while a build is still going,
//      Move from a state nothing the role may do leaves, Open project with no project).
//   3. The API enforces the same: a role the page hides an action from is refused it (403), a disabled one is refused
//      with its reason (409), a state the action does not offer is refused (400); the allowed ones act (a run, a move,
//      an edit, a delete).
//   4. A run started on a record carries it (runs.record_area, record_key): the record's runs section lists it with who
//      started it; a project's runs list its own (a build's re-runs are the build's); another workspace's never.
//   5. Related lists: a project's builds (those pointing at it, newest first, its limit and whether there are more, each
//      row with its own area's actions for this person); never another workspace's; hidden from a role that may not read
//      the builds.
//   6. The server's install refuses what gen-packs refuses (a related list whose area has no link back here, an action
//      naming a job kind or a transition that does not exist, two primary actions).
//   7. mold_v0-256: a record's change history (who, when, each field before and after; an encrypted field redacted, in the
//      answer and the table; none for an area without a history section, none written off or for a write that changes
//      nothing; never another workspace's).
//   8. Facts computed from related records, as the person reading (hidden from a role that may not read their area).
//  10. A link to several areas, a run on a linked record, a related list matched on a field.
//   9. Add <related record> (create_record), the record picker, a tab's columns computed from related records, a Key from
//      a Title: each as the person may, the workspace's own only; off, none of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(j) } as never]);
  install(FIXTURE);
  const A = (await createOrg(`Pages A ${STAMP}`)).org, B = (await createOrg(`Pages B ${STAMP}`)).org;
  const a = A.orgId, b = B.orgId;
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const post = async (tok: string, p: string, body: unknown = {}) => { const r = await http.req("POST", p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const page = (tok: string, area: string, key: string, tab?: string) => get(tok, `/api/records/_page/${area}/${key}${tab ? `?tab=${tab}` : ""}`);
  const act = (tok: string, area: string, key: string, id: string, body: unknown = {}) => post(tok, `/api/records/_page/${area}/${key}/actions/${id}`, body);
  const ids = (actions: { id: string }[]) => actions.map((a) => a.id);

  // The world: two projects and their builds in A (one project's six, so its list has more than its limit); in B a
  // project of the same key and a build pointing at it. Builds start queued (the lifecycle's initial) and move on.
  const seed = async (org: number, builds: [string, string, string, string[]][]) => {
    const rec = ra.workspaceRecords("fixture_pages", org);
    await ra.asWriter({ by: "people", id: "seed" }, async () => {
      await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages", owner: "Payments team", health: "healthy" } });
      await rec.put("projects", "search", { title: "Search", data: { summary: "Product search" } });
      await rec.put("environments", "staging-eu", { title: "Staging (EU)", data: { tier: "staging" } });
    });
    for (const [key, project, started, path_] of builds) {
      await ra.asWriter({ by: "run", id: "seed" }, () => rec.put("builds", key, { title: key.replace("build-", "Build "), data: { status: "queued", project, environment: "staging-eu", branch: "main", commit: `c0ffee${key.slice(-2)}`, started } }));
      for (const to of path_) await rec.move("builds", key, to);
    }
  };
  // mold_v0-256: the flag on while seeding, so the seeded builds' changes are in their history.
  F.setFeaturesForTest({ record_pages: true });
  await seed(a, [
    ["build-01", "checkout", "2026-10-01", ["running", "failed"]], ["build-02", "checkout", "2026-10-02", ["running", "passed"]],
    ["build-03", "checkout", "2026-10-03", ["running", "passed"]], ["build-04", "checkout", "2026-10-04", []], ["build-05", "checkout", "2026-10-05", ["running", "failed"]],
    ["build-06", "checkout", "2026-10-06", ["running"]], ["build-07", "search", "2026-10-07", ["running", "passed"]],
  ]);
  await seed(b, [["build-90", "checkout", "2026-10-09", []]]);
  await ra.asWriter({ by: "run", id: "seed" }, () => ra.workspaceRecords("fixture_pages", a).put("builds", "build-08", { title: "Build 08", data: { status: "queued", branch: "main" } }));

  // ---------- 1. off ----------
  F.setFeaturesForTest({ record_pages: false });
  {
    assert.equal((await page(owner, "builds", "build-01")).status, 404, "off: no page route");
    assert.equal((await act(owner, "builds", "build-01", "delete")).status, 404, "off: no action route");
    assert.equal((await get(owner, "/api/records/builds/build-01")).status, 200, "the record's own route as before");
    ok("off (the default): /api/records/_page answers nothing (404, as before the flag); the record's own routes as before");
  }
  F.setFeaturesForTest({ record_pages: true });

  // ---------- 2. actions by role, and why a disabled one is ----------
  {
    const failedM = await page(member, "builds", "build-01");
    assert.equal(failedM.status, 200, JSON.stringify(failedM.body));
    assert.deepEqual(ids(failedM.body.actions), ["start_run.rebuild", "link.project", "edit", "move", "copy_link"], "a member: no Delete (a lifecycle area's delete is the owner's)");
    const byId = (x: any) => Object.fromEntries(x.body.actions.map((a: any) => [a.id, a]));
    const m = byId(failedM);
    assert.deepEqual([m["start_run.rebuild"].place, m["start_run.rebuild"].label, m["start_run.rebuild"].disabled], ["primary", "Re-run", null]);
    assert.deepEqual(m["start_run.rebuild"].run.values, { build: "build-01", branch: "main", commit: "c0ffee01" }, "its input pre-filled from the record ($key and its fields)");
    assert.deepEqual(m["start_run.rebuild"].run.args.map((a: any) => a.name), ["build", "branch", "commit"]);
    assert.deepEqual(m["link.project"].target, { area: "projects", key: "checkout" });
    assert.ok(m.edit.fields.every((f: any) => f.name !== "status"), "the edit form leaves the lifecycle's field out (a move changes it)");
    assert.equal(m.move.disabled, "Nothing you can do moves it from Failed.", "a member moves no failed build (Queue again is the owner's)");
    assert.ok(!m.move.moves.some((x: any) => x.to === "queued"), "the owner's Queue again is not listed to a member");
    const failedO = byId(await page(owner, "builds", "build-01"));
    assert.ok(failedO.delete && failedO.delete.place === "more", "the owner also has Delete, in More");
    assert.match(failedO.delete.confirm, /Delete this build and its results\?/, "with its own question");
    assert.deepEqual(failedO.move.moves.map((x: any) => [x.to, x.disabled]), [["running", "It can't move from Failed to Running."], ["passed", "It can't move from Failed to Passed."],
      ["failed", "It is already Failed."], ["cancelled", "It can't move from Failed to Cancelled."], ["queued", null]], "each state with why it is closed, the owner's Queue again open");
    assert.equal(failedO.move.disabled, null);
    const viewerIds = ids((await page(viewer, "builds", "build-01")).body.actions);
    assert.deepEqual(viewerIds, ["link.project", "copy_link"], "a viewer: only what reads");
    const running = byId(await page(member, "builds", "build-06"));
    assert.equal(running["start_run.rebuild"].disabled, "A build that is still going can't be re-run: cancel it first, or wait for it to end.", "Re-run disabled while the build is going, with its reason");
    assert.deepEqual(running.move.moves.filter((x: any) => !x.disabled).map((x: any) => x.to), ["passed", "failed", "cancelled"], "a running build: the moves out of Running");
    const orphan = byId(await page(member, "builds", "build-08"));
    // mold_v0-298: no project set, so no Open project (it was disabled, with why).
    assert.equal(orphan["link.project"], undefined, "no project set: no Open project");
    ok("a build's actions by role: a member's Re-run (primary, its input pre-filled), Open project, Edit, Move, Copy link; the owner's also Delete; a viewer's Open project and Copy link; each disabled one with its reason (Re-run while going, Move from Failed for a member); no Open project when none is set");
  }

  // ---------- 3. the API enforces the same ----------
  {
    const refused = async (tok: string, key: string, id: string, body: unknown, status: number, re: RegExp, what: string) => {
      const r = await act(tok, "builds", key, id, body);
      assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, re, what);
    };
    await refused(viewer, "build-01", "start_run.rebuild", { input: { build: "build-01", branch: "main" } }, 403, /Re-run is not open to the Viewer role on Builds records/, "a viewer's re-run");
    await refused(viewer, "build-06", "move", { to: "passed" }, 403, /not open to the Viewer role/, "a viewer's move");
    await refused(viewer, "build-01", "edit", { data: { summary: "x" } }, 403, /not open to the Viewer role/, "a viewer's edit");
    await refused(member, "build-01", "delete", {}, 403, /not open to the Member role/, "a member's delete");
    await refused(member, "build-06", "start_run.rebuild", { input: { build: "build-06", branch: "main" } }, 409, /still going can't be re-run/, "a re-run while going");
    await refused(member, "build-01", "move", { to: "queued" }, 409, /Nothing you can do moves it from Failed/, "a member's move from Failed");
    await refused(owner, "build-01", "move", { to: "passed" }, 409, /can't move from Failed to Passed/, "a move along no transition");
    await refused(owner, "build-01", "move", { to: "exploded" }, 400, /not a state this action moves/, "a state the action does not offer");
    await refused(owner, "build-01", "link.project", {}, 400, /happens in the browser/, "a link: nothing to send");
    await refused(owner, "build-01", "nope", {}, 404, /no such action/, "an action the page does not have");
    assert.equal((await act(ownerB, "builds", "build-01", "delete")).status, 404, "another workspace's record: not found");
    // The data API's own checks stand behind the page's (a viewer cannot write there either).
    assert.equal((await post(viewer, "/api/data/builds/build-06/move", { to: "passed" })).status, 403);

    const moved = await act(member, "builds", "build-06", "move", { to: "passed" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.record.data.status, "passed", "a member moves a running build to passed");
    const edited = await act(member, "builds", "build-02", "edit", { title: "Build 02 (renamed)", data: { summary: "Rebuilt after the cache fix", project: "checkout", environment: "staging-eu", branch: "main", commit: "c0ffee02", started: "2026-10-02" } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual([edited.body.record.title, edited.body.record.data.summary, edited.body.record.data.status, edited.body.record.data.project], ["Build 02 (renamed)", "Rebuilt after the cache fix", "passed", "checkout"],
      "an edit changes its fields, keeps its state and what the form leaves out");
    const requeued = await act(owner, "builds", "build-01", "move", { to: "queued" });
    assert.equal(requeued.body.record?.data.status, "queued", "the owner's Queue again");
    const del = await act(owner, "builds", "build-03", "delete");
    assert.deepEqual([del.status, del.body.deleted], [200, true], "the owner deletes");
    assert.equal((await get(owner, "/api/records/builds/build-03")).status, 404, "gone");
    ok("the API enforces the same: a role the page hides an action from is refused (a viewer's re-run, move and edit, a member's delete: 403), a disabled one with its reason (409), a state the action does not offer (400), another workspace's record (404); a member's move and edit, the owner's move and delete act");
  }

  // ---------- 4. a run started on a record carries it ----------
  let runId = "";
  {
    const started = await act(member, "builds", "build-05", "start_run.rebuild", { input: { build: "build-05", branch: "main", commit: "c0ffee05" } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    runId = started.body.run.id;
    const [row] = await db.query<{ record_area: string; record_key: string; requested_by: string }>("SELECT record_area, record_key, requested_by FROM runs WHERE id = $1", [runId]);
    assert.deepEqual([row!.record_area, row!.record_key], ["builds", "build-05"], "the run carries the record it was started on");
    const runs = (await page(member, "builds", "build-05")).body.sections["0-3"];
    assert.equal(runs.total, 1);
    assert.deepEqual([runs.runs[0].id, runs.runs[0].kind, runs.runs[0].status, runs.runs[0].by], [runId, "rebuild", "queued", "You"], "the build's runs: the re-run, started by you");
    assert.equal((await page(owner, "builds", "build-05")).body.sections["0-3"].runs[0].by !== "You", true, "someone else sees who started it, not You");
    const built = await act(member, "projects", "checkout", "start_run.build", { input: { project: "checkout", branch: "release" } });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    const projRuns = (await page(member, "projects", "checkout")).body.sections["0-2"];
    assert.deepEqual(projRuns.runs.map((r: any) => r.kind), ["build"], "the project's runs: its own build (a build's re-run is the build's)");
    // Another workspace: the same keys, none of A's runs.
    assert.deepEqual((await page(ownerB, "projects", "checkout")).body.sections["0-2"], { total: 0, runs: [] }, "another workspace's project of the same key: no runs of A's");
    // A run started anywhere else carries no record.
    const { startRun } = await import("../src/runs.js");
    const plain = await startRun(a, "fixture_pages", "build", { scope: { project: "search", branch: "main" } });
    assert.deepEqual((await db.query<{ record_area: string | null }>("SELECT record_area FROM runs WHERE id = $1", [plain.id]))[0]!.record_area, null, "a run started elsewhere: no record");
    ok("a run started on a record carries it: the build's runs list its re-run (by You; someone else sees who), the project's its own build; another workspace's project of the same key lists none; a run started elsewhere carries no record");
  }

  // ---------- 5. related lists ----------
  {
    const p = (await page(member, "projects", "checkout")).body;
    const builds = p.sections["0-1"];
    assert.equal(builds.area, "builds"); assert.equal(builds.via, "project");
    assert.deepEqual(builds.records.map((r: any) => r.key), ["build-06", "build-05", "build-04", "build-02", "build-01"], "checkout's builds, newest started first, at most 5 (build-03 deleted)");
    assert.equal(builds.more, false, "five: no more");
    assert.ok(!builds.records.some((r: any) => r.key === "build-90"), "never another workspace's");
    const row = builds.records.find((r: any) => r.key === "build-05");
    assert.deepEqual(ids(row.actions), ["start_run.rebuild", "link.project", "edit", "move", "copy_link"], "each row: its own area's actions this person may take");
    assert.equal(row.actions.find((a: any) => a.id === "edit").fields, undefined, "a row's edit opens the record's page: no form fields in the list");
    await ra.asWriter({ by: "run", id: "seed" }, () => ra.workspaceRecords("fixture_pages", a).put("builds", "build-09", { title: "Build 09", data: { status: "queued", project: "checkout", started: "2026-10-10" } }));
    const more = (await page(member, "projects", "checkout")).body.sections["0-1"];
    assert.deepEqual([more.records.length, more.records[0].key, more.more], [5, "build-09", true], "six: the newest five and Show all");
    const vIds = (await page(viewer, "projects", "checkout")).body.sections["0-1"].records[0].actions.map((a: any) => a.id);
    assert.deepEqual(vIds, ["link.project", "copy_link"], "a viewer's rows: what reads");
    assert.deepEqual((await page(ownerB, "projects", "checkout")).body.sections["0-1"].records.map((r: any) => r.key), ["build-90"], "B's project: B's build only");
    // The builds closed to viewers: the project's Builds section is not drawn for them; members still read it.
    const closed = clone(FIXTURE);
    closed.record_areas.find((a: any) => a.name === "builds").permissions = { read: ["member", "billing", "owner"] };
    install(closed);
    assert.deepEqual((await page(viewer, "projects", "checkout")).body.sections["0-1"], { hidden: true }, "a role that may not read the builds: the section hidden");
    assert.equal((await page(member, "projects", "checkout")).body.sections["0-1"].records.length, 5, "a member still reads it");
    install(FIXTURE);
    ok("related lists: a project's builds pointing at it, newest first, its limit and Show all past it, each row with its own area's actions for this person; never another workspace's; hidden from a role that may not read the builds");
  }

  // ---------- 6. the server's install refuses what gen-packs refuses ----------
  {
    const refuse = (edit: (j: any) => void, re: RegExp, what: string) => { const j = clone(FIXTURE); edit(j); assert.throws(() => install(j), re, what); };
    const projects = (j: any) => j.record_areas.find((a: any) => a.name === "projects"), buildsOf = (j: any) => j.record_areas.find((a: any) => a.name === "builds");
    refuse((j) => { projects(j).detail.tabs[0].sections[1].related.area = "environments"; }, /environments has no link back to projects/, "a related list whose area has no link back");
    refuse((j) => { buildsOf(j).detail.actions[0].job_kind = "deploy"; }, /deploy is not a job kind of pack fixture_pages/, "an action naming a kind that does not exist");
    refuse((j) => { buildsOf(j).detail.actions.push({ kind: "move", to: "archived" }); }, /no transition of the lifecycle goes to archived/, "an action naming a transition that does not exist");
    refuse((j) => { buildsOf(j).detail.actions[1].place = "primary"; }, /2 actions are primary/, "two primary actions");
    install(FIXTURE);
    ok("the server's install refuses what gen-packs refuses: a related list whose area has no link back, an action naming a job kind or a transition that does not exist, two primary actions");
  }
  // ---------- 7. a record's change history (mold_v0-256) ----------
  {
    const hist = async (tok: string, area: string, key: string, sec: string) => (await page(tok, area, key, "history")).body.sections[sec];
    const hb = await hist(member, "builds", "build-02", "4-0");
    assert.deepEqual(hb.changes.map((c: any) => c.action), ["updated", "moved", "moved", "created"], "build-02's changes, newest first: the edit, its two moves, its creation");
    const edit = hb.changes[0];
    assert.equal(edit.by, "You", "the edit: by you (the member reading)");
    assert.deepEqual(edit.title, { before: "Build 02", after: "Build 02 (renamed)" }, "its title before and after");
    assert.deepEqual(edit.changes.find((c: any) => c.field === "summary"), { field: "summary", before: null, after: "Rebuilt after the cache fix" }, "a field before and after");
    assert.deepEqual(hb.changes[1].changes, [{ field: "status", before: "running", after: "passed" }], "a move: the state before and after");
    assert.equal(hb.changes[3].by, "The app's own automation", "the seed's run");
    assert.notEqual((await hist(owner, "builds", "build-02", "4-0")).changes[0].by, "You", "someone else sees who changed it");
    assert.equal((await hist(viewer, "builds", "build-02", "4-0")).changes.length, 4, "a viewer reads it (the area's read)");
    assert.equal((await page(ownerB, "builds", "build-02", "history")).status, 404, "another workspace: not found");
    const older = await get(member, `/api/records/_page/builds/build-02/history?section=4-0&before=${hb.changes[1].id}`);
    assert.deepEqual(older.body.changes.map((c: any) => c.action), ["moved", "created"], "Show older: the lines before one");
    assert.equal((await get(member, "/api/records/_page/builds/build-02/history?section=0-0")).status, 400, "a section that is not a history");
    // An encrypted field: that it changed, never a value, in the answer or the table.
    const SECRET = "s3cret-signing-value", SECRET2 = "an0ther-signing-value";
    const made = await post(owner, "/api/data/releases", { key: "rel-4-13", title: "Release 4.13", data: { project: "checkout", version: "4.13.0", stage: "draft", signing_secret: SECRET, changelog: "Fixes:\n- refunds\n- receipts" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const upd = await http.req("PUT", "/api/data/releases/rel-4-13", h(owner), { title: "Release 4.13", data: { project: "checkout", version: "4.13.0", stage: "candidate", signing_secret: SECRET2, changelog: "Fixes:\n- refunds\n- receipts\n- search ranking" } });
    assert.equal(upd.status, 200, await upd.text());
    const rel = await page(owner, "releases", "rel-4-13", "history");
    const raw = JSON.stringify(rel.body);
    const latest = rel.body.sections["1-0"].changes[0];
    assert.deepEqual(latest.changes.find((c: any) => c.field === "signing_secret"), { field: "signing_secret", redacted: true }, "the encrypted field: redacted");
    assert.deepEqual(latest.changes.find((c: any) => c.field === "changelog"), { field: "changelog", before: "Fixes:\n- refunds\n- receipts", after: "Fixes:\n- refunds\n- receipts\n- search ranking" }, "a long text: before and after whole (the page diffs it)");
    assert.ok(!raw.includes(SECRET) && !raw.includes(SECRET2), "no value of it anywhere in the answer");
    const stored = await db.query<{ changes: unknown }>("SELECT changes FROM record_changes WHERE area = 'releases'");
    assert.ok(stored.length === 2 && !JSON.stringify(stored).includes(SECRET) && !JSON.stringify(stored).includes(SECRET2) && !JSON.stringify(stored).includes("sealed"), "nor in the table: neither the value nor its sealed envelope");
    assert.equal((await db.query("SELECT 1 FROM record_changes WHERE area = 'environments'")).length, 0, "an area without a history section: nothing kept");
    // Off: nothing written.
    const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM record_changes"))[0]!.n;
    F.setFeaturesForTest({ record_pages: false });
    await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", a).put("builds", "build-09", { title: "Build 09", data: { status: "queued", project: "checkout", started: "2026-10-10", summary: "off" } }));
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM record_changes"))[0]!.n, before, "off: no line written");
    F.setFeaturesForTest({ record_pages: true });
    // A write that changes nothing writes nothing; a delete writes its line.
    await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", a).put("builds", "build-09", { title: "Build 09", data: { status: "queued", project: "checkout", started: "2026-10-10", summary: "off" } }));
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM record_changes"))[0]!.n, before, "a write that changes nothing: no line");
    ok("a record's change history (mold_v0-256): newest first, who (you, someone else's address, the app's automation), the title and each field before and after, a move's states, Show older; a viewer reads it, another workspace never; an encrypted field only redacted (no value, nor its envelope, in the answer or the table); an area without a history section keeps none; off, or a write that changes nothing, writes no line");
  }

  // ---------- 8. facts computed from related records ----------
  {
    await act(member, "builds", "build-06", "edit", { title: "Build 06", data: { project: "checkout", environment: "staging-eu", branch: "main", commit: "c0ffee06", started: "2026-10-06", coverage: 91.5 } });
    const f = (await page(member, "projects", "checkout")).body.facts;
    assert.deepEqual(f["3"], { op: "latest", value: "queued", area: "builds", field: "status", record: { key: "build-09", title: "Build 09" } }, "the last build (by started): its status, and which");
    assert.deepEqual(f["4"], { op: "count", value: 6, capped: false, area: "builds", via: "project" }, "how many builds point here");
    assert.equal(f["5"].value, 1, "how many of them failed (where)");
    assert.deepEqual([f["6"].value, f["6"].record.key], [91.5, "build-06"], "the newest passed build's coverage");
    assert.deepEqual(Object.keys(f), ["3", "4", "5", "6"], "only the computed facts");
    assert.equal((await page(ownerB, "projects", "checkout")).body.facts["4"].value, 1, "B's project counts B's builds only");
    const closed = clone(FIXTURE);
    closed.record_areas.find((x: any) => x.name === "builds").permissions = { read: ["member", "billing", "owner"] };
    install(closed);
    assert.deepEqual(Object.values((await page(viewer, "projects", "checkout")).body.facts), [{ hidden: true }, { hidden: true }, { hidden: true }, { hidden: true }], "a role that may not read the builds: every fact over them hidden");
    assert.equal((await page(member, "projects", "checkout")).body.facts["4"].value, 6, "a member still reads them");
    install(FIXTURE);
    ok("facts computed from related records, on the server as the person reading: the last build's status (and which), a count, a count where, the newest passed build's coverage; another workspace's own only; hidden from a role that may not read the builds");
  }

  // ---------- 9. Add <related record>, the record picker, list columns from related records, a Key from a Title ----------
  {
    const byIdOf = (body: any) => Object.fromEntries(body.actions.map((x: any) => [x.id, x]));
    const p = byIdOf((await page(member, "projects", "checkout")).body);
    const addBuild = p["create_record.builds"];
    assert.deepEqual([addBuild.place, addBuild.label, addBuild.create.area, addBuild.create.values], ["secondary", "Add build", "builds", { project: "checkout", summary: "The payment pages" }],
      "Add build: the project and its summary filled in ($key, $field:summary)");
    assert.ok(addBuild.create.fields.some((x: any) => x.name === "project" && x.type === "reference" && x.to === "projects"), "with the builds' form");
    assert.ok(!byIdOf((await page(viewer, "projects", "checkout")).body)["create_record.builds"], "a viewer: no Add");
    const closedCreate = clone(FIXTURE);
    closedCreate.record_areas.find((x: any) => x.name === "builds").permissions = { create: ["owner"] };
    install(closedCreate);
    assert.ok(!byIdOf((await page(member, "projects", "checkout")).body)["create_record.builds"], "a role that may not create builds: no Add");
    install(FIXTURE);
    // The picker: the records this person reads, the workspace's own, by name or key.
    const pick = await get(member, "/api/records/_page/_pick/projects?q=chec");
    assert.deepEqual(pick.body.records, [{ key: "checkout", title: "Checkout" }], "the picker: what matches");
    assert.deepEqual((await get(member, "/api/records/_page/_pick/projects")).body.records.map((r: any) => r.key).sort(), ["checkout", "search"], "everything before anything is typed (the newest change first)");
    await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", a).put("projects", "atlas", { title: "Atlas", data: { summary: "A's own" } }));
    assert.deepEqual((await get(member, "/api/records/_page/_pick/projects?q=atl")).body.records, [{ key: "atlas", title: "Atlas" }]);
    assert.deepEqual((await get(ownerB, "/api/records/_page/_pick/projects?q=atl")).body.records, [], "never another workspace's");
    assert.equal((await get(member, "/api/records/_page/_pick/ghosts")).status, 404);
    const closedRead = clone(FIXTURE);
    closedRead.record_areas.find((x: any) => x.name === "projects").permissions = { read: ["owner"] };
    install(closedRead);
    assert.equal((await get(member, "/api/records/_page/_pick/projects")).status, 403, "a role that may not read the area: refused");
    install(FIXTURE);
    // List columns computed from the builds that point at each project.
    const cols = (await get(member, "/api/records/_page/_columns/fixture_pages/projects?keys=checkout,search,nope")).body.columns;
    assert.deepEqual(cols.rel_builds_count, { checkout: 6, search: 1, nope: 0 }, "how many builds each project has");
    assert.deepEqual(cols.rel_builds_latest_status, { checkout: "passed", search: "passed", nope: null }, "its latest build's status (the newest change)");
    assert.deepEqual((await get(ownerB, "/api/records/_page/_columns/fixture_pages/projects?keys=checkout")).body.columns.rel_builds_count, { checkout: 1 }, "B's own builds");
    const closedBuilds = clone(FIXTURE);
    closedBuilds.record_areas.find((x: any) => x.name === "builds").permissions = { read: ["member", "billing", "owner"] };
    install(closedBuilds);
    assert.deepEqual((await get(viewer, "/api/records/_page/_columns/fixture_pages/projects?keys=checkout")).body.columns, { rel_builds_count: { hidden: true }, rel_builds_latest_status: { hidden: true } }, "a role that may not read the builds: hidden");
    install(FIXTURE);
    assert.deepEqual((await get(member, "/api/records/_page/_columns/fixture_pages/builds?keys=x")).body.columns, {}, "a tab without computed columns: none");
    const spec = await get(member, "/api/tab-actions/_areas/projects");
    assert.equal(spec.body.area?.key_from_title, true, "the projects' create form: the Key from the Title");
    F.setFeaturesForTest({ record_pages: false });
    assert.equal((await get(member, "/api/records/_page/_pick/projects")).status, 404, "off: no picker");
    assert.equal((await get(member, "/api/records/_page/_columns/fixture_pages/projects?keys=checkout")).status, 404, "off: no computed columns");
    assert.equal((await get(member, "/api/tab-actions/_areas/projects")).body.area?.key_from_title, undefined, "off: the Key typed");
    F.setFeaturesForTest({ record_pages: true });
    ok("Add build on a project's page (its fields filled in from the project; not for a viewer or a role that may not create builds); the record picker (what matches, the workspace's own, refused to a role that may not read the area); a tab's columns computed from the builds of each project (a count, the latest status; B's own; hidden from a role that may not read them); the Key from the Title; off, none of them");
  }
  // ---------- 10. a link to several areas, a run on a linked record, a related list matched on a field ----------
  {
    const rec = ra.workspaceRecords("fixture_pages", a);
    await ra.asWriter({ by: "people", id: "seed" }, async () => {
      await rec.put("services", "svc-pay", { title: "Payments API", data: { endpoint: "https://pay.example.com", owner: "Payments team" } });
      await rec.put("releases", "rel-1", { title: "Release 1", data: { project: "checkout", version: "1.0.0", stage: "candidate", service: "svc-pay", subject: "staging-eu" } });
      await rec.put("releases", "rel-2", { title: "Release 2", data: { project: "checkout", version: "2.0.0", stage: "draft", subject: "build-02" } });
      await rec.put("releases", "rel-3", { title: "Release 3", data: { project: "search", version: "3.0.0", stage: "draft" } });
    });
    const byId = (body: any) => Object.fromEntries(body.actions.map((x: any) => [x.id, x]));
    const r1 = await page(member, "releases", "rel-1");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const a1 = byId(r1.body);
    assert.deepEqual(a1["link.subject"].target, { area: "environments", key: "staging-eu" }, "a subject that is an environment: its environment");
    assert.deepEqual(byId((await page(member, "releases", "rel-2")).body)["link.subject"].target, { area: "builds", key: "build-02" }, "one that is a build: its build (not the first area declared)");
    assert.deepEqual([a1["start_run.scan"].disabled, a1["start_run.scan"].run.target], [null, { area: "services", key: "svc-pay", title: "Payments API" }], "Scan service: the release's service");
    assert.match(byId((await page(member, "releases", "rel-3")).body)["start_run.scan"].disabled, /No service is set on this record/, "no service: disabled, with why");
    const scanned = await act(member, "releases", "rel-1", "start_run.scan", { input: { target_asset: { area: "services", key: "svc-other" } } });
    assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
    const [run] = await db.query<{ targets: any; record_area: string; record_key: string }>("SELECT targets, record_area, record_key FROM runs WHERE id = $1", [scanned.body.run.id]);
    assert.deepEqual([run!.targets.asset, run!.record_area, run!.record_key], [{ area: "services", key: "svc-pay" }, "releases", "rel-1"], "the run targets the service (never one sent from the browser) and carries the release");
    assert.equal((await act(member, "releases", "rel-3", "start_run.scan")).status, 409, "no service: refused");
    const builds = r1.body.sections["0-2"];
    assert.deepEqual([builds.area, builds.via, builds.match], ["builds", "project", "checkout"], "the release's builds: matched on its project");
    assert.ok(builds.records.length === 5 && builds.records.every((x: any) => x.data.project === "checkout"), "builds whose project is the release's");
    const r3 = (await page(member, "releases", "rel-3")).body.sections["0-2"];
    assert.deepEqual([r3.match, r3.records.map((x: any) => x.key)], ["search", ["build-07"]], "another project's release: that project's builds");
    assert.equal((await page(ownerB, "releases", "rel-1")).status, 404, "another workspace's release: not found");
    ok("a link to several areas opens the one its value is in (an environment, a build); Scan service runs on the release's service (disabled and refused without one; the target never taken from the browser) and carries the release; a related list matched on the release's project");
  }
  F.setFeaturesForTest(null);
  await http.close();
} finally {
  cleanup();
}
process.exit(0);
