// Workspace recipes (mold_v0-271; src/recipes.ts, src/recipe-routes.ts, src/harness-sessions.ts startSession and
// wakeRecipeProposal, src/agent-harness.ts sendRecipeProposals; molds/mold_v0/docs/agent-harness.md "Workspace
// recipes"), offline: an embedded database, the run engine in this process and the stand-in agent CLI.
//   npm run test:recipes
//
// 0. Off: workspace_recipes not asked for (the staff Records group does not list the page), or the workspace agent off:
//    no route, nothing listed, a profile cannot name one.
// 1. Upload and versions: a recipe's files are agent profile uploads (the same parts, the same table); a new recipe with
//    files is version 1, the next save version 2 (it names the version it edited: an older one is 409); a path out of
//    the workspace, an unfinished upload, a file twice and nothing changed are refused; every version keeps its files,
//    downloadable as uploaded; a staff viewer changes nothing; archived, no profile may name it.
// 2. Picked by a profile: `recipes: [{id, version}]` checked on save (unknown, archived, a version it lacks); a session
//    expands it into its frozen uploads at the version in force when it starts (the profile's own file wins a path both
//    name) and keeps that version while staff save another; its wake writes the files into the working directory, a
//    program executable.
// 3. Self-improvement: the agent writes .recipe-proposal/<recipe>/ (note.md, remove.txt, files/), and its wake sends it as
//    it ends: an approval request staff see (what it changes and removes, from which workspace and session), only for
//    a recipe the session used; accepted, it is the recipe's next version (its source the agent, the proposal named,
//    the executable bit kept); a proposal made against an older version is refused on accept and declined with a reason;
//    a decision is made once; a staff viewer decides nothing.
// 4. mold_v0-303, declared by a pack: its recipes (files inline: a SKILL.md, JSON as json, a script with its executable
//    flag) come in as version 1, stored as uploads; the same declaration again writes nothing; a changed file is the next
//    version, a change of words alone none; once staff save a version it is theirs (the pack's next change leaves it);
//    a pack's agent profile names a recipe and its sessions get its files.
// 5. mold_v0-303, a person starts a program: the ones people may start listed (spawned_by [] or an agent's that a
//    session of that profile spawns), inputs checked, a viewer refused, a stepped program only people start refused,
//    the session's first message the program's prompt filled with the inputs.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (what: string) => console.log(`✓ ${what}`);

try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const R = await import("../src/recipes.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const harness = await import("../src/run-harness.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { createOrg } = await import("../src/auth.js");

  // ---------- 0. off ----------
  {
    F.setFeatureForTest("agent_harness", true);
    F.setAdminRecordsForTest(null);
    assert.equal(F.featureOn("workspace_recipes"), false, "not asked for: the staff Records group does not list the page");
    assert.equal(R.recipesOn(), false);
    await assert.rejects(R.listRecipes(), /not on/);
    F.setAdminRecordsForTest(["recipes", "journeys"]);
    F.setFeatureForTest("agent_harness", false);
    assert.equal(R.recipesOn(), false, "asked for, but the workspace agent is off");
    assert.equal(await R.pickProblem({ id: "x-y", version: null }), "recipe: workspace recipes are not on in this app");
    ok("off: not asked for (the Records group does not list it), or the workspace agent off: nothing answers and no profile may name one");
  }

  // ---------- the world, on ----------
  F.setFeatureForTest("agent_harness", true);
  F.setAdminRecordsForTest(["recipes"]);
  assert.equal(R.recipesOn(), true);
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const W = (await createOrg(`Recipes ${STAMP}`)).org;
  const own = await http.signInAs(W, "owner");
  const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
  const staffTok = await http.adminToken("operator"), readerTok = await http.adminToken("viewer");
  const adm = async (method: string, p: string, body?: unknown, tok = staffTok) => {
    const r = await http.req(method, `/api/admin/onboarding${p}`, { authorization: `Bearer ${tok}` }, body);
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  };
  /** Upload bytes as the console does (the agent profiles' upload routes): start, its parts, finish. */
  const upload = async (bytes: Buffer, tok = staffTok) => {
    const s0 = await adm("POST", "/agent-profiles/uploads", { bytes: bytes.length }, tok);
    if (s0.status !== 201) return s0;
    const u = s0.body.upload as { id: string; parts: number; part_bytes: number };
    for (let n = 0; n < u.parts; n++) {
      const r = await fetch(`${http.base}/api/admin/onboarding/agent-profiles/uploads/${u.id}/parts/${n}`, { method: "PUT", body: new Uint8Array(bytes.subarray(n * u.part_bytes, (n + 1) * u.part_bytes)),
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream", "x-app-admin": "1", "x-pack-request": "1" } });
      assert.equal(r.status, 200, `part ${n}: ${await r.text()}`);
    }
    return adm("POST", `/agent-profiles/uploads/${u.id}/complete`, {}, tok);
  };
  const up = async (text: string) => { const r = await upload(Buffer.from(text)); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.upload as { id: string; bytes: number; sha256: string; executable: boolean }; };

  // ---------- 1. upload and versions ----------
  const TOOL1 = "#!/bin/sh\necho build-v1\n", TOOL2 = "#!/bin/sh\necho build-v2 \"$@\"\n";
  let recipeId = "";
  {
    const tool = await up(TOOL1), guide = await up("# How to build\nGUIDE-V1\n");
    assert.equal(tool.executable, true, "a script is recognised as a program");
    let r = await adm("POST", "/recipes", { name: "Frontend build", description: "The build kit an agent uses.", files: [{ id: tool.id, path: "bin/build", executable: true }, { id: guide.id, path: "docs/BUILD.md", executable: false }] }, readerTok);
    assert.equal(r.status, 403, "a staff viewer creates nothing");
    r = await adm("POST", "/recipes", { name: "Frontend build", description: "The build kit an agent uses.", files: [{ id: tool.id, path: "bin/build", executable: true }, { id: guide.id, path: "docs/BUILD.md", executable: false }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    recipeId = r.body.recipe.id;
    assert.deepEqual([recipeId, r.body.recipe.version, r.body.recipe.files, r.body.recipe.versions[0].source], ["frontend-build", 1, 2, "staff"], "version 1 with its two files");
    assert.equal((await adm("POST", "/recipes", { name: "Frontend build" })).status, 409, "an id once");
    // Refusals of a version's files.
    const v1 = r.body.recipe.versions[0].files as { id: string; path: string }[];
    const bad: [string, unknown, RegExp][] = [
      ["a path out of the workspace", [{ id: tool.id, path: "../etc/passwd" }], /a path inside the session's working directory/],
      ["a path under the proposal folder", [{ id: tool.id, path: ".recipe-proposal/x" }], /not under \.recipe-proposal/],
      ["an upload never made", [{ id: "upl_" + "a".repeat(24), path: "bin/x" }], /not finished/],
      ["one path twice", [{ id: tool.id, path: "bin/a" }, { id: guide.id, path: "BIN/A" }], /two files have one path/],
      ["nothing changed", v1.map((f) => ({ id: f.id, path: f.path, executable: f.path === "bin/build" })), /Nothing changed/],
    ];
    for (const [what, files, re] of bad) {
      const x = await adm("POST", `/recipes/${recipeId}/versions`, { version: 1, files, note: "x" });
      assert.equal(x.status, 400, `${what}: ${JSON.stringify(x.body)}`);
      assert.match(x.body.error, re, what);
    }
    const unfinished = (await adm("POST", "/agent-profiles/uploads", { bytes: 3 })).body.upload;
    assert.match((await adm("POST", `/recipes/${recipeId}/versions`, { version: 1, files: [{ id: unfinished.id, path: "bin/x" }] })).body.error, /not finished/, "an unfinished upload");
    // Version 2: the build tool changed; an edit of version 1 saved after it is refused.
    const tool2 = await up(TOOL2);
    r = await adm("POST", `/recipes/${recipeId}/versions`, { version: 1, files: [{ id: tool2.id, path: "bin/build", executable: true }, { id: guide.id, path: "docs/BUILD.md" }], note: "Passes its arguments on." });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.recipe.versions.map((v: { version: number }) => v.version), [2, 1], "both versions kept, newest first");
    assert.equal((await adm("POST", `/recipes/${recipeId}/versions`, { version: 1, files: [{ id: tool.id, path: "bin/build", executable: true }] })).status, 409, "an edit of an older version: 409");
    // Every version's files download as uploaded.
    const dl = async (v: number, n: number) => (await fetch(`${http.base}/api/admin/onboarding/recipes/${recipeId}/versions/${v}/files/${n}`, { headers: { authorization: `Bearer ${readerTok}` } })).text();
    assert.equal(await dl(1, 1), TOOL1, "version 1 keeps its file");
    assert.equal(await dl(2, 1), TOOL2, "version 2 its own");
    // Archived: no profile may name it; restored: again.
    assert.equal((await adm("POST", `/recipes/${recipeId}/archive`)).status, 200);
    assert.match(String(await R.pickProblem({ id: recipeId, version: null })), /archived/);
    assert.equal((await adm("POST", `/recipes/${recipeId}/restore`)).status, 200);
    const list = (await adm("GET", "/recipes", undefined, readerTok)).body;
    assert.deepEqual(list.recipes.map((x: { id: string; version: number; files: number }) => [x.id, x.version, x.files]), [[recipeId, 2, 2]], "a staff viewer reads them");
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_profile_uploads WHERE id = ANY ($1::text[])", [[tool.id, tool2.id, guide.id]]);
    assert.equal(n, 3, "its files are agent profile uploads (one storage layer)");
    ok("upload and versions: files uploaded as a profile's are, version 1 then 2 (an edit of an older one 409), refusals (a path out of the workspace or under the proposal folder, an unfinished upload, a path twice, nothing changed, a staff viewer), every version's files downloadable as uploaded, archive and restore");
  }

  // ---------- 2. picked by a profile ----------
  const client = await harness.localRunnerClient("w-recipes");
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 250, clock: () => Date.now() };
  const wake = async (sessionId: string) => {
    const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]);
    assert.ok(c, "a wake to claim");
    const [r] = await db.query<{ harness_session_id: string }>("SELECT harness_session_id FROM runs WHERE id = $1", [c!.run.id]);
    assert.equal(r!.harness_session_id, sessionId);
    return { claim: c!, done: harness.runWorkspaceHarness(client, c!, opts) };
  };
  const until = async (what: string, f: () => Promise<boolean>, ms = 20_000) => {
    const t = Date.now();
    while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
  };
  const ownGuide = await up("# Our own guide\nPROFILE-GUIDE\n");
  let sid = "";
  {
    const refused: [string, unknown, RegExp][] = [
      ["an unknown recipe", [{ id: "no-such-kit", version: null }], /no recipe is called no-such-kit/],
      ["a version it lacks", [{ id: recipeId, version: 9 }], /has no version 9/],
      ["listed twice", [{ id: recipeId, version: null }, { id: recipeId, version: 1 }], /listed twice/],
    ];
    for (const [what, recipes, re] of refused) {
      const x = await adm("POST", "/agent-profiles", { name: `Bad ${what}`, config: { recipes } });
      assert.equal(x.status, 400, `${what}: ${JSON.stringify(x.body)}`);
      assert.match(x.body.error, re, what);
    }
    const p = await adm("POST", "/agent-profiles", { name: "Builder with kit", config: { recipes: [{ id: recipeId, version: null }], uploads: [{ id: ownGuide.id, path: "docs/BUILD.md", bytes: ownGuide.bytes, sha256: ownGuide.sha256, executable: false }] } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const facts = (await adm("GET", "/agent-profiles")).body;
    assert.deepEqual(facts.recipes?.map((x: { id: string; version: number }) => [x.id, x.version]), [[recipeId, 2]], "the profile editor offers the recipes");
    const s = await H.startSession(W.orgId, owner, { message: "files", profile: p.body.profile.id });
    sid = s.id;
    let d = await H.readSession(W.orgId, s.id, owner);
    assert.deepEqual(d.policy.recipes, [{ id: recipeId, name: "Frontend build", version: 2 }], "the version in force when it started, frozen");
    assert.deepEqual(d.policy.files, ["docs/BUILD.md", "bin/build"], "the profile's own file first; the recipe's for every other path");
    assert.deepEqual(d.policy.executables, ["bin/build"]);
    // Staff save version 3 while it runs: the session keeps version 2.
    const tool3 = await up("#!/bin/sh\necho build-v3\n");
    const guide = (await adm("GET", `/recipes/${recipeId}`)).body.recipe.versions[0].files.find((f: { path: string }) => f.path === "docs/BUILD.md");
    assert.equal((await adm("POST", `/recipes/${recipeId}/versions`, { version: 2, files: [{ id: tool3.id, path: "bin/build", executable: true }, { id: guide.id, path: "docs/BUILD.md" }], note: "v3" })).status, 201);
    d = await H.readSession(W.orgId, s.id, owner);
    assert.equal(d.policy.recipes[0]!.version, 2, "still version 2");
    const rd = () => H.readSession(W.orgId, s.id, owner);
    const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
    const last = async () => (await rd()).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
    const w = await wake(s.id);
    await until("its files", () => said(/^Files: /));
    assert.equal(await last(), "Files: bin/build, docs/BUILD.md");
    await H.messageSession(W.orgId, s.id, owner, "run ./bin/build kit");
    await until("the recipe's program", () => said(/^Ran: /));
    assert.equal(await last(), "Ran: 0 build-v2 kit", "the recipe's program, at version 2, executable in its workspace");
    await H.messageSession(W.orgId, s.id, owner, "cat docs/BUILD.md");
    await until("the guide", () => said(/^File docs/));
    assert.equal(await last(), "File docs/BUILD.md: # Our own guide | PROFILE-GUIDE", "the profile's own file won the path");
    // 3. The agent proposes version 2 improved (a faster build tool, a new note, the guide removed): sent as the wake ends.
    await H.messageSession(W.orgId, s.id, owner, `run mkdir -p .recipe-proposal/${recipeId}/files/bin .recipe-proposal/other-kit && printf 'Build twice as fast.' > .recipe-proposal/${recipeId}/note.md && printf 'docs/BUILD.md\\n' > .recipe-proposal/${recipeId}/remove.txt && printf '#!/bin/sh\\necho build-fast\\n' > .recipe-proposal/${recipeId}/files/bin/build && chmod +x .recipe-proposal/${recipeId}/files/bin/build && printf 'x' > .recipe-proposal/other-kit/note.md && echo written`);
    await until("the proposal written", () => said(/^Ran: 0 written/));
    await H.stopSession(W.orgId, s.id, owner);
    await w.done;
    ok("picked by a profile: checked on save (unknown, a version it lacks, twice), offered in the editor; a session's uploads are the profile's own then the recipe's at the version in force, frozen while staff save another; its wake writes them (the program runs, the profile's file wins its path)");
  }

  // ---------- 3. self-improvement: the proposal as an approval request ----------
  {
    let pend = (await adm("GET", "/recipe-proposals", undefined, readerTok)).body.proposals as any[];
    assert.equal(pend.length, 1, `one proposal, for the recipe the session used only (${JSON.stringify(pend)})`);
    const p = pend[0];
    assert.deepEqual([p.recipe, p.base_version, p.status, p.changed, p.removed, p.note, p.session, p.workspace], [recipeId, 2, "pending", ["bin/build"], ["docs/BUILD.md"], "Build twice as fast.", sid, W.name], "what it changes and removes, why, and where from");
    assert.deepEqual(p.files.map((f: { path: string; executable: boolean }) => [f.path, f.executable]), [["bin/build", true]], "the version it would make: the guide removed, the tool executable");
    assert.equal(p.stale, true, "made against version 2 while the recipe is at 3");
    assert.equal((await adm("POST", `/recipe-proposals/${p.id}/accept`, {}, readerTok)).status, 403, "a staff viewer decides nothing");
    let x = await adm("POST", `/recipe-proposals/${p.id}/accept`, {});
    assert.equal(x.status, 409); assert.match(x.body.error, /made against version 2/, "a stale proposal is refused on accept");
    assert.equal((await adm("POST", `/recipe-proposals/${p.id}/decline`, {})).status, 400, "a decline says why");
    x = await adm("POST", `/recipe-proposals/${p.id}/decline`, { reason: "Superseded by version 3." });
    assert.deepEqual([x.status, x.body.proposal.status, x.body.proposal.reason], [200, "declined", "Superseded by version 3."]);
    assert.equal((await adm("POST", `/recipe-proposals/${p.id}/accept`, {})).status, 409, "decided once");
    // A new session at version 3 proposes again (directly through the wake's door, as the runner does): accepted.
    const s2 = await H.startSession(W.orgId, owner, { message: "x", profile: "builder-with-kit" });
    const c = (await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]))!;
    await client.agent!.start(c.run.id, c.lease_token);
    const { packBundle } = await import("../src/workspace-bundle.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = path.join(TMP, "proposal");
    mkdirSync(path.join(dir, "files", "bin"), { recursive: true });
    writeFileSync(path.join(dir, "note.md"), "Caches its output.");
    writeFileSync(path.join(dir, "files", "bin", "build"), "#!/bin/sh\necho build-cached\n");
    writeFileSync(path.join(dir, "files", "CACHE.md"), "cache notes");
    await assert.rejects(client.agent!.recipeProposal!(c.run.id, c.lease_token, "other-kit", packBundle(dir).bundle, []), /did not start with that recipe/, "only a recipe the session used");
    const sent = await client.agent!.recipeProposal!(c.run.id, c.lease_token, recipeId, packBundle(dir).bundle, ["bin/build"]);
    await client.agent!.end(c.run.id, c.lease_token, { reason: "stopped" });
    await client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] });
    await H.stopSession(W.orgId, s2.id, owner).catch(() => null);
    x = await adm("POST", `/recipe-proposals/${sent.proposal}/accept`, {});
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.deepEqual([x.body.proposal.status, x.body.proposal.accepted_version], ["accepted", 4]);
    const r = (await adm("GET", `/recipes/${recipeId}`)).body.recipe;
    const v4 = r.versions[0];
    assert.deepEqual([r.version, v4.version, v4.source, v4.proposal], [4, 4, "agent", sent.proposal], "the recipe's next version, its source the agent, the proposal named");
    assert.deepEqual(v4.files.map((f: { path: string; executable: boolean }) => [f.path, f.executable]), [["bin/build", true], ["CACHE.md", false], ["docs/BUILD.md", false]], "in path order: version 3 with the changed tool (still executable) and the added file");
    assert.equal(await (await fetch(`${http.base}/api/admin/onboarding/recipes/${recipeId}/versions/4/files/1`, { headers: { authorization: `Bearer ${readerTok}` } })).text(), "#!/bin/sh\necho build-cached\n");
    assert.equal((await R.recipeUploads({ id: recipeId, version: null })).recipe.version, 4, "the next session starts with it");
    pend = (await adm("GET", "/recipe-proposals")).body.proposals;
    assert.equal(pend.length, 0, "nothing waiting");
    ok("self-improvement: the agent's .recipe-proposal/ sent as its wake ended, an approval request staff see (what it changes and removes, why, the workspace and session), only for a recipe the session used; a stale one refused on accept and declined with its reason, decided once, never by a staff viewer; accepted, the next version (its source the agent, the proposal named, the program still executable)");
  }
  // ---------- 4. declared by a pack (mold_v0-303) ----------
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const AP = await import("../src/agent-profiles.js");
  const manifest = { id: "kit_pack", name: "Kit", version: "1", entry: null, migrations: null, words: {}, dir: ROOT };
  const SKILL = "---\nname: review\n---\n# Review\nRead the schema first.\n";
  const kit = (over: { skill?: string; name?: string; programs?: unknown[] } = {}) => definePack({
    id: "kit_pack",
    recipes: [{ id: "review-kit", name: over.name ?? "Review kit", description: "What a reviewer works with.", files: [
      { path: ".claude/skills/review/SKILL.md", content: over.skill ?? SKILL },
      { path: "schemas/out.json", json: { type: "object", required: ["ok"] } },
      { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n", executable: true }] }],
    agentProfiles: [{ id: "kit-agent", name: "Kit agent", recipes: [{ id: "review-kit" }] }],
    ...(over.programs ? { programs: over.programs as never } : {}),
  });
  const install = (d: ReturnType<typeof kit>) => { setPacksForTest([{ manifest, definition: d }]); R.forgetDeclaredRecipesForTest(); AP.resetProfileSeedForTest(); };
  const kitRow = async () => (await adm("GET", "/recipes/review-kit")).body.recipe as { version: number; declared: boolean; name: string; versions: { version: number; files: { path: string; executable: boolean }[]; note: string; by: string }[] };
  {
    install(kit());
    let r = await kitRow();
    assert.deepEqual([r.version, r.declared, r.versions[0]!.by], [1, true, "the app"], "version 1, the app's");
    assert.deepEqual(r.versions[0]!.files.map((f) => [f.path, f.executable]), [[".claude/skills/review/SKILL.md", false], ["schemas/out.json", false], ["scripts/check.sh", true]], "its files, the script executable");
    const dl = async (v: number, n: number) => (await fetch(`${http.base}/api/admin/onboarding/recipes/review-kit/versions/${v}/files/${n}`, { headers: { authorization: `Bearer ${readerTok}` } })).text();
    assert.equal(await dl(1, 1), SKILL, "the markdown as declared");
    assert.equal(await dl(1, 2), `${JSON.stringify({ type: "object", required: ["ok"] }, null, 2)}\n`, "json written as indented JSON");
    const uploads = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_profile_uploads WHERE created_by = 'the app'"))[0]!.n;
    const before = await uploads();
    install(kit());
    r = await kitRow();
    assert.deepEqual([r.version, await uploads()], [1, before], "the same declaration again: nothing written");
    install(kit({ name: "Review kit (renamed)" }));
    r = await kitRow();
    assert.deepEqual([r.version, r.name], [1, "Review kit (renamed)"], "its words alone changed: no new version");
    install(kit({ skill: `${SKILL}Then run scripts/check.sh.\n` }));
    r = await kitRow();
    assert.deepEqual([r.version, r.declared, await uploads()], [2, true, before + 1], "a changed file: the next version, only that file stored again");
    // The pack's profile names it; a session of that profile gets its files.
    const prof = await AP.readProfile("kit-agent");
    assert.deepEqual(prof.config.recipes, [{ id: "review-kit", version: null }], "a pack's profile names the recipe (its latest)");
    const s = await H.startSession(W.orgId, owner, { message: "review", profile: "kit-agent" });
    const d = await H.readSession(W.orgId, s.id, owner);
    assert.deepEqual(d.policy.recipes, [{ id: "review-kit", name: "Review kit", version: 2 }]);
    assert.ok(d.policy.files.includes("scripts/check.sh") && d.policy.executables.includes("scripts/check.sh"), "the script reaches the session, executable");
    await H.stopSession(W.orgId, s.id, owner).catch(() => null);
    // Staff save a version: theirs from now on, the pack's next change leaves it.
    const v2 = (await kitRow()).versions[0]!.files as { id: string; path: string; executable: boolean }[];
    const x = await adm("POST", "/recipes/review-kit/versions", { version: 2, files: v2.filter((f) => f.path !== "schemas/out.json").map((f) => ({ id: f.id, path: f.path, executable: f.executable })), note: "Staff dropped the schema." });
    assert.equal(x.status, 201, JSON.stringify(x.body));
    install(kit({ skill: `${SKILL}A third take.\n` }));
    r = await kitRow();
    assert.deepEqual([r.version, r.declared, r.versions[0]!.files.length], [3, false, 2], "staff's version stands; the pack no longer replaces it");
    ok("declared by a pack: its recipes (markdown, json, an executable script) come in as version 1, stored as uploads; the same declaration writes nothing, its words alone no version, a changed file the next; once staff save one it is theirs; a pack's profile names it and its sessions get the files");
  }

  // ---------- 5. a person starts a program (mold_v0-303) ----------
  {
    F.setFeatureForTest("nested_runs", true);
    const P = await import("../src/programs.js");
    const S = await import("../src/program-start.js");
    const inputs = { type: "object", required: ["topic"], properties: { topic: { type: "string" } } };
    install(kit({ programs: [
      { id: "look-into", name: "Look into", config: { prompt: "Look into {topic} and list what you find.", inputs, outputs: { type: "object", required: ["findings"], properties: { findings: { type: "array", items: { type: "string" } } } }, spawned_by: [] } },
      { id: "kit-only", name: "Kit only", config: { prompt: "Check {topic}.", inputs, spawned_by: ["kit-agent"] } },
      { id: "stepped", name: "Stepped", config: { prompt: "x", spawned_by: [], machine: { states: [{ id: "one", entry: true, prompt: "Do {topic}." }], transitions: [], max_transitions: 4 } } },
    ] }));
    P.forgetDeclaredProgramsForTest();
    const list = await S.startablePrograms(owner);
    // mold_v0-303 (integration): a stepped program only people start is offered too: a session of its own profile runs it,
    // permitted to spawn exactly it (this replaces the earlier refusal).
    assert.deepEqual(list.map((p) => [p.id, p.via, p.profile]), [["kit-only", "runner", "kit-agent"], ["look-into", "session", "default"], ["stepped", "runner", "default"]], "people only (a session of its own), an agent's (a session of that profile spawns it), and a stepped one only people start (a permitted runner)");
    await assert.rejects(S.startProgram(W.orgId, owner, "look-into", { inputs: {} }), /inputs do not match this program/);
    await assert.rejects(S.startProgram(W.orgId, { ...owner, role: "viewer" as const }, "look-into", { inputs: { topic: "x" } }), /Your role cannot start agent sessions/);
    {
      const stepped = await S.startProgram(W.orgId, owner, "stepped", { inputs: {} });
      assert.deepEqual([stepped.program.id, stepped.program.via], ["stepped", "runner"], "a stepped program only people start runs in a runner session");
      const sd = await H.readSession(W.orgId, stepped.session.id, owner);
      assert.equal(sd.profile?.id, "default", "its own profile's session");
      assert.match(sd.messages.find((m: { role: string }) => m.role === "person")!.body, /spawn with program "stepped"/);
      const [frozen] = await db.query<{ nested: boolean; permit: string | null }>("SELECT policy ? 'nested' AS nested, policy->'nested'->>'permit_program' AS permit FROM harness_sessions WHERE id = $1", [stepped.session.id]);
      if (frozen?.nested) assert.equal(frozen.permit, "stepped", "the root session's permit names exactly that program");
      // The permit lets a session spawn exactly that program; without it (or for another program) the profile's rules hold.
      await P.programForSpawn("stepped", "default", "stepped");
      await assert.rejects(P.programForSpawn("stepped", "default", null), /may not spawn the program stepped/);
      await assert.rejects(P.programForSpawn("look-into", "default", "stepped"), /may not spawn the program look-into/);
      await H.stopSession(W.orgId, stepped.session.id, owner).catch(() => null);
    }
    const started = await S.startProgram(W.orgId, owner, "look-into", { inputs: { topic: "the release notes" } });
    assert.deepEqual([started.program.id, started.program.via, started.session.title], ["look-into", "session", "Look into"]);
    const d = await H.readSession(W.orgId, started.session.id, owner);
    const first = d.messages.find((m: { role: string }) => m.role === "person")!.body as string;
    assert.match(first, /^Look into the release notes and list what you find\./, "the prompt filled with the inputs");
    assert.match(first, /matching this JSON Schema/, "its result asked for in the outputs' shape");
    await H.stopSession(W.orgId, started.session.id, owner).catch(() => null);
    const runner = await S.startProgram(W.orgId, owner, "kit-only", { inputs: { topic: "y" } });
    const rd = await H.readSession(W.orgId, runner.session.id, owner);
    assert.equal(rd.profile?.id, "kit-agent", "a session of the profile that may spawn it");
    assert.match(rd.messages.find((m: { role: string }) => m.role === "person")!.body, /spawn with program "kit-only"/);
    await H.stopSession(W.orgId, runner.session.id, owner).catch(() => null);
    // The Agents page's routes (mounted with the flag on, ahead of /:id): the list and the start.
    const { default: express } = await import("express");
    const router = express.Router();
    (await import("../src/program-routes.js")).programDockRoutes(router, () => W.orgId);
    const paths = (router.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[]).flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []));
    assert.ok(paths.includes("GET /programs") && paths.includes("POST /programs/:id/start"), `Run a program's routes: ${paths.join(", ")}`);
    assert.equal(S.inputsFromRecord({ topic: "subject", key: "$key" }, { key: "r1", title: "T", data: { subject: "S" } }).topic, "S", "a page action's inputs from the record");
    F.setFeatureForTest("nested_runs", false);
    setPacksForTest(null);
    ok("a person starts a program: the ones people may start listed (people only: a session of its own; an agent's: a session of that profile spawns it), its inputs checked, a viewer refused, a stepped program only people start run by a session permitted to spawn exactly it; the first message is its prompt filled with the inputs");
  }

  await http.close();
  console.log("RECIPES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
