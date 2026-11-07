// A workspace agent's wake on the run page (mold_v0-262, flags record_pages and agent_harness; src/view-routes.ts
// runAppRouter, src/run-page.ts), offline: an embedded database, a fake sign-in, an app whose packs declare no job kind
// of their own (scripts/fixtures/packs/fixture_teams: record pages, no kinds). `npm run test:run-page`, after run-page-test.
//   1. A session's wake is a run of the built-in kind _agent/session: its page (/api/runs/<id>/page) answers, for the
//      person who started it and for everyone else of the workspace who may read its session (a viewer too), with its
//      kind in words, its session (id and title, the page links to it) and its timeline; it was a 404 in an app with no
//      job kind of its own (/api/runs was not mounted).
//   2. Another workspace's wake: not found. Re-run is not offered (a wake is the session's), Stop follows the session.
//   3. The agent's page links each wake to its run page, and the run page to its session (source).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams", "pack.json"), "utf8"));

try {
  const F = await import("../src/features.js");
  const { setPacksForTest, packs } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: "fixture_teams", name: "Fixture teams", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_teams") }, declared: compileDeclarations(FIXTURE) } as never]);
  assert.ok(packs().every((p) => !(p.definition.jobKinds?.length ?? 0) && !(p.definition.agentJobKinds?.length ?? 0)), "the app declares no job kind of its own");
  F.setFeaturesForTest({ record_pages: true, agent_harness: true });
  const A = (await createOrg(`Wake A ${STAMP}`)).org, B = (await createOrg(`Wake B ${STAMP}`)).org;
  const http = await startHttp();
  const member = await http.signIn(A, "member"), other = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const post = async (tok: string, p: string, body: unknown = {}) => { const r = await http.req("POST", p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

  // ---------- 1. the wake's page ----------
  let run = "";
  {
    const s = await post(member, "/api/agent", { message: "Plan the release", title: "Release plan" });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const sid: string = s.body.session.id;
    const [r] = await db.query<{ id: string; pack: string; kind: string }>("SELECT id, pack, kind FROM runs WHERE harness_session_id = $1", [sid]);
    assert.deepEqual([r!.pack, r!.kind], ["_agent", "session"], "a wake: a run of the built-in kind");
    run = r!.id;
    for (const [who, tok] of [["its starter", member], ["another member", other], ["a viewer", viewer]] as const) {
      const p = await get(tok, `/api/runs/${run}/page`);
      assert.equal(p.status, 200, `${who}: ${JSON.stringify(p.body)}`);
      assert.deepEqual([p.body.run.label, p.body.run.session], ["Agent session", { id: sid, title: "Release plan" }], `${who}: its kind in words and its session`);
      assert.ok(p.body.timeline.events.some((e: any) => e.type === "queued"), `${who}: its timeline`);
    }
    assert.equal((await get(member, `/api/runs/${run}/events?after=0`)).status, 200, "its events poll");
    assert.equal((await get(member, `/api/agent/${sid}`)).body.session.wakes_list[0].run_id, run, "the session names the wake");
    ok("a session's wake (_agent/session) has its run page for everyone who may read the session (its starter, another member, a viewer): its kind, its session, its timeline");
  }

  // ---------- 2. another workspace, re-run and stop ----------
  {
    assert.equal((await get(ownerB, `/api/runs/${run}/page`)).status, 404, "another workspace's wake: not found");
    const p = (await get(member, `/api/runs/${run}/page`)).body;
    assert.equal(p.can.rerun, null, "a wake is never re-run from its page (the session wakes it)");
    assert.equal((await post(member, `/api/runs/${run}/rerun`)).status, 403);
    ok("another workspace's wake is not found; a wake offers no Re-run");
  }

  // ---------- 3. the links between them ----------
  {
    const rp = readFileSync(path.join(ROOT, "web", "src", "features", "runs", "run-page.tsx"), "utf8");
    assert.match(rp, /<Link href=\{sessionHref\(r\.session\.id\)\}[^>]*data-run-session=/, "the run page links to its session");
    const ap = readFileSync(path.join(ROOT, "web", "src", "features", "agent", "agent-page.tsx"), "utf8");
    assert.match(ap, /href=\{`\/app\/runs\/\$\{encodeURIComponent\(w\.run_id\)\}`\}[^>]*data-wake-run=/, "the session lists each wake as a link to its run page");
    ok("the run page links to its session, and the session to each wake's run page");
  }
  F.setFeaturesForTest(null);
  await http.close();
  console.log("\nrun page (agent wakes, mold_v0-262): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
