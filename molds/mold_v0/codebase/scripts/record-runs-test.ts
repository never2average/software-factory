// Records and the runs that wrote them (mold_v0-310; src/record-runs.ts), through the API, offline: an embedded database,
// a fake sign-in, the fixture scripts/fixtures/packs/fixture_pages (its builds' runs section with `wrote: true`, its
// services readable by the owner only).
//   tsx scripts/record-runs-test.ts
//   0. writerRef: a job run's writer (and its workspace hook's run:run:<id>), a program's result; nothing for the rest.
//   1. A record's page: "Made by" the job run that created it (both writer forms), the agent session whose wake's tool
//      call made it (its via, sql/migrations/0071_record_runs.sql), the program child session whose result kept it
//      (src/program-records.ts, as keepRecords writes it); "Changed by" the latest; each history line's run; a runs
//      section's `wrote` list; a person's own record links nothing.
//   2. Both ways: a run's page lists the records it wrote ("Created" / "Changed"); a session's records
//      (GET /api/agent/<id>/records) its wakes' and its programs' records, the child's on the child too.
//   3. Who may: a record the person may not read is never listed (services: the owner only); another workspace's run
//      and session are not found, its record written under the same run id links nothing, and is never listed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const areaOf = (name: string) => FIXTURE.record_areas.find((a: { name: string }) => a.name === name);
// The builds' runs section also lists who made and changed the build; services are the owner's to read.
for (const t of areaOf("builds").detail.tabs) for (const s of t.sections) if (s.runs) s.runs.wrote = true;
areaOf("services").permissions = { read: ["owner"] };

try {
  const F = await import("../src/features.js");
  F.setFeaturesForTest({ record_pages: true, agent_harness: true });
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const RR = await import("../src/record-runs.js");
  const { writeProgramRecords } = await import("../src/program-records.js");
  const { getDb } = await import("../src/db.js");
  const { asPlatform } = await import("../src/tenant-scope.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(FIXTURE) } as never]);

  // ---------- 0. writerRef ----------
  assert.deepEqual(RR.writerRef("run:run_abc123"), { run: "run_abc123" }, "a job run's writer");
  assert.deepEqual(RR.writerRef("run:run:run_abc123"), { run: "run_abc123" }, "its workspace hook's");
  assert.deepEqual(RR.writerRef("run:program:find-builds:hch_abcdefgh12"), { handle: "hch_abcdefgh12" }, "a program's result");
  for (const x of ["people:u1", "run:tool:put_build", "run:route:p:GET:/x", "intake:message:1", "repository:main", "shell:clock", "staff:s1", "run", null])
    assert.equal(RR.writerRef(x), null, `nothing to open for ${x}`);
  assert.deepEqual(RR.writeRef("people:u1", "run:run_wake1"), { run: "run_wake1" }, "a session's wake wins over the person it acts as");
  ok("writerRef: a job run's writer in both forms, a program's result; a person, a tool, a route, the intake, an import, the shell: nothing to open");

  const A = (await createOrg(`Record runs A ${STAMP}`)).org, B = (await createOrg(`Record runs B ${STAMP}`)).org;
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

  const tag = STAMP.replace(/[^A-Za-z0-9]/g, "").slice(-10).padStart(10, "0");
  const runA = `run_rr${tag}`, wake = `run_wk${tag}`, s1 = `hss_root${tag}`, c1 = `hss_kid${tag}`, handle = `hch_prog${tag}`;
  await asPlatform(async () => {
    const run = (id: string, org: number, session: string | null) => db.query(
      `INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, harness_session_id)
       VALUES ($1, $2, 'fixture_pages', 'rebuild', 'succeeded', '{}', 1, 600, 60, 1, $3)`, [id, org, session]);
    const session = (id: string, org: number, title: string, parent: string | null) => db.query(
      `INSERT INTO harness_sessions (id, org_id, title, flavour, model, provider, budget_usd, state, parent_id, root_id, depth)
       VALUES ($1, $2, $3, 'claude_code', 'model-large', 'anthropic', 2, 'parked', $4, $5, $6)`, [id, org, title, parent, parent ?? id, parent ? 1 : 0]);
    await run(runA, A.orgId, null);
    await session(s1, A.orgId, "Tidy the builds", null);
    await session(c1, A.orgId, "find-builds", s1);
    await run(wake, A.orgId, s1);
    await db.query(`INSERT INTO harness_children (id, org_id, root_id, parent_id, session_id, kind, program_id, program_version, name, child_no, budget_usd, status, outputs, settled_at)
      VALUES ($1, $2, $3, $3, $4, 'program', 'find-builds', 1, 'find-builds', 1, 0.5, 'done', $5, now())`,
      [handle, A.orgId, s1, c1, JSON.stringify({ id: "build-p1", name: "Found build", status: "queued", project: "checkout" })]);
  });

  const rec = ra.workspaceRecords("fixture_pages", A.orgId);
  await ra.asWriter({ by: "people", id: "seed" }, () => rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages" } }));
  // A job run's writes: as its own code (run:<id>) and as its workspace hook (run:run:<id>, src/runs.ts).
  await ra.asWriter({ by: "run", id: runA }, async () => {
    await rec.put("builds", "build-r1", { title: "Build R1", data: { status: "queued", project: "checkout", branch: "main" } });
    await rec.put("services", "svc-1", { title: "Payments service", data: { endpoint: "https://example.com/pay" } });
  });
  await ra.asWriter({ by: "run", id: `run:${runA}` }, () => rec.put("builds", "build-r2", { title: "Build R2", data: { status: "queued", project: "checkout" } }));
  // A person's own change, then the agent session's (its wake's tool call writes as the person: src/http.ts marks it).
  await ra.asWriter({ by: "people", id: "u-member" }, () => rec.put("builds", "build-r1", { title: "Build R1", data: { status: "queued", project: "checkout", branch: "release" } }));
  await ra.asVia(`run:${wake}`, () => ra.asWriter({ by: "people", id: "u-member" }, async () => {
    await rec.put("builds", "build-s1", { title: "Build S1", data: { status: "queued", project: "checkout" } });
    await rec.put("builds", "build-r1", { title: "Build R1", data: { status: "queued", project: "checkout", branch: "hotfix" } });
  }));
  // A program's result, kept as the server keeps it after the child settles (nested-runs keepRecords -> writeProgramRecords).
  const [hrow] = await asPlatform(() => db.query<{ outputs: unknown }>("SELECT outputs FROM harness_children WHERE id = $1", [handle]));
  assert.deepEqual(await writeProgramRecords(A.orgId, { id: handle, program_id: "find-builds", outputs: hrow!.outputs }, { area: "builds", key: "id", title: "name", fields: { status: "status", project: "project" } }), ["build-p1"]);
  // A person's own record.
  await ra.asWriter({ by: "people", id: "u-member" }, () => rec.put("builds", "build-h1", { title: "Build H1", data: { status: "queued", project: "checkout" } }));

  // ---------- 1. a record's page ----------
  const page = async (tok: string, key: string, tab?: string) => {
    const r = await get(tok, `/api/records/_page/builds/${key}${tab ? `?tab=${tab}` : ""}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  {
    const r1 = await page(member, "build-r1");
    assert.deepEqual([r1.writers.made.kind, r1.writers.made.id, r1.writers.made.title, r1.writers.made.href], ["run", runA, "Re-run a build", `/app/runs/${runA}`], "build-r1: made by the job run, its kind in words");
    assert.deepEqual(r1.writers.changed.map((x: any) => [x.kind, x.id, x.run_id, x.href]), [["session", s1, wake, `/app/agent?session=${s1}`]], "changed by the agent session (its wake), the person's own change linking nothing");
    const runsSection: any = Object.values(r1.sections).find((x: any) => x && Array.isArray(x.runs));
    assert.deepEqual(runsSection.wrote.map((x: any) => [x.how, x.kind, x.id]), [["Made", "run", runA], ["Changed", "session", s1]], "the runs section's `wrote`");
    const hist = await page(member, "build-r1", "history");
    const lines: any[] = (Object.values(hist.sections).find((x: any) => x && Array.isArray(x.changes)) as any).changes;
    assert.deepEqual(lines.map((l) => [l.action, l.run?.kind ?? null, l.run?.id ?? null]), [["updated", "session", s1], ["updated", null, null], ["created", "run", runA]], "each history line's run: the session, none for the person, the job run");
    assert.equal(lines[0].by, "A member", "the line still says who (the person the session acted as)");

    assert.deepEqual([(await page(member, "build-r2")).writers.made?.id], [runA], "build-r2: its workspace hook's writer (run:run:<id>) links the same run");
    const s = (await page(member, "build-s1")).writers;
    assert.deepEqual([s.made.kind, s.made.id, s.made.run_id, s.made.title], ["session", s1, wake, "Tidy the builds"], "build-s1: made by the agent session, through its wake");
    const p = (await page(member, "build-p1")).writers;
    assert.deepEqual([p.made.kind, p.made.id, p.made.program], ["session", c1, "find-builds"], "build-p1: made by the program's child session (keepRecords' writer)");
    const own = (await page(member, "build-h1")).writers;
    assert.deepEqual(own, { made: null, changed: [] }, "a person's own record: no run to link");
    ok("a record's page: Made by the job run (both writer forms), the agent session (via its wake), the program's child session; Changed by the latest; each history line's run; the runs section's wrote list; a person's own record links nothing");
  }

  // ---------- 2. both ways ----------
  {
    const asMember = await get(member, `/api/runs/${runA}/page`);
    assert.equal(asMember.status, 200, JSON.stringify(asMember.body));
    const rel = Object.fromEntries(asMember.body.related.map((x: any) => [x.key, x.how]));
    assert.deepEqual([rel["build-r1"], rel["build-r2"], rel["svc-1"]], [["Created"], ["Created"], undefined], "the run's page: the records it wrote, never one the person may not read");
    const asOwner = Object.fromEntries((await get(owner, `/api/runs/${runA}/page`)).body.related.map((x: any) => [x.key, x.how]));
    assert.deepEqual(asOwner["svc-1"], ["Created"], "the owner reads the service it wrote");
    const wakePage = Object.fromEntries((await get(member, `/api/runs/${wake}/page`)).body.related.map((x: any) => [x.key, x.how]));
    assert.deepEqual([wakePage["build-s1"], wakePage["build-r1"]], [["Created"], ["Changed"]], "a wake's page: what its tool calls wrote");

    const sr = await get(member, `/api/agent/${s1}/records`);
    assert.equal(sr.status, 200, JSON.stringify(sr.body));
    const got = Object.fromEntries(sr.body.records.map((x: any) => [x.key, x.how]));
    assert.deepEqual(got, { "build-s1": ["Created"], "build-r1": ["Changed"], "build-p1": ["Created"] }, "a session's records: its wakes' and its program's");
    assert.equal(sr.body.total, 3);
    assert.equal(sr.body.records.find((x: any) => x.key === "build-s1").title, "Build S1", "with titles");
    const cr = await get(member, `/api/agent/${c1}/records`);
    assert.deepEqual(cr.body.records.map((x: any) => x.key), ["build-p1"], "the child session's: its program's result");
    ok("both ways: a run's page lists what it wrote (a wake's too), a session lists its wakes' and its programs' records, a child its own");
  }

  // ---------- 3. who may, and the workspace's own ----------
  {
    assert.equal((await get(ownerB, `/api/agent/${s1}/records`)).status, 404, "another workspace's session is not found");
    assert.equal((await get(ownerB, `/api/runs/${runA}/page`)).status, 404, "another workspace's run is not found");
    assert.equal((await get(member, "/api/agent/hss_nosuchsession1/records")).status, 404, "no such session");
    // B's record written under A's run id (a forged writer): it links nothing in B, and A's run never lists it.
    const recB = ra.workspaceRecords("fixture_pages", B.orgId);
    await ra.asWriter({ by: "people", id: "seed" }, () => recB.put("projects", "checkout", { title: "Checkout", data: {} }));
    await ra.asVia(`run:${wake}`, () => ra.asWriter({ by: "run", id: runA }, () => recB.put("builds", "build-b1", { title: "Build B1", data: { status: "queued", project: "checkout" } })));
    const b1 = await get(ownerB, "/api/records/_page/builds/build-b1");
    assert.equal(b1.status, 200, JSON.stringify(b1.body));
    assert.deepEqual(b1.body.writers, { made: null, changed: [] }, "in B, A's run and session are nothing to link");
    const relA = (await get(owner, `/api/runs/${runA}/page`)).body.related.map((x: any) => x.key);
    assert.ok(!relA.includes("build-b1"), "A's run lists none of B's records");
    const sA = (await get(owner, `/api/agent/${s1}/records`)).body.records.map((x: any) => x.key);
    assert.ok(!sA.includes("build-b1"), "A's session lists none of B's records");
    assert.equal((await RR.writtenBy(B.orgId, { run: runA })).map((x) => x.key).join(), "build-b1", "read as B: only B's own rows");
    ok("who may: a record the person may not read is never listed; another workspace's run and session are not found, its record under the same ids links nothing and is never listed");
  }
  F.setFeaturesForTest(null);
  await http.close();
} finally {
  cleanup();
}
process.exit(0);
