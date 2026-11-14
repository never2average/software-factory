// A pack's declared recipes with no object store (mold_v0-305; src/agent-profiles.ts storeUploadBytes, src/recipes.ts
// syncDeclaredRecipes, src/programs.ts freezeTest), offline: an embedded database, and no bucket anywhere (no R2_*, no Key
// vault entry, no APP_STORAGE_DIR), as on a hosted deployment that never set one up.
//   npm run test:declared-recipes-no-store
//
// Proves:
//   1. the pack's recipes come in (version 1), each file kept in the database (one part), its bytes and sha256 exact
//   2. what a session receives: a profile's pick expands into the recipe's files, and each part reads back (the wake's
//      fetch, src/harness-sessions.ts wakeUploadPart) with no object store
//   3. a declared program whose acceptance test runs a declared recipe loads: its test frozen from the recipe (files and
//      their sha256); a program a person creates the same way too
//   4. a file larger than one part still needs an object store (refused in words); a staff upload's parts too; once a
//      store is configured, a new file goes to it and the database-kept ones still read
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { cleanup, TMP } from "./lib/test-world.js";

for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
delete process.env.APP_STORAGE_DIR;
const ok = (m: string) => console.log(`✓ ${m}`);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const SKILL = "---\nname: review\n---\n# Review\nRead the cases, then score them.\n";
const CASES = [{ input: 1, expected: 1 }, { input: 2, expected: 2 }];
const PACK = {
  id: "fx_kit", name: "Kit", version: "1",
  recipes: [{ id: "review-kit", name: "Review kit", description: "What a reviewer works with.", files: [
    { path: ".claude/skills/review/SKILL.md", content: SKILL },
    { path: "cases/cases.json", json: CASES },
    { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n", executable: true }] }],
  programs: [{ id: "measure", name: "Measure", config: { prompt: "Improve it.", spawned_by: ["*"], budget_usd: 1,
    machine: { max_transitions: 4, states: [{ id: "candidate", entry: true, prompt: "Improve {target}" }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] },
    acceptance: { metric: "score", direction: "maximize", surface: ["SKILL.md"], target: { kind: "recipe", id: "review-kit" },
      test: { recipe: { id: "review-kit" }, cases_path: "cases/cases.json", candidate_command: ["builtin:file", "SKILL.md"], scorer_command: ["builtin:exact"] } } } }],
};

try {
  const F = await import("../src/features.js");
  F.setAdminRecordsForTest(["recipes"]);
  F.setFeaturesForTest({ agent_harness: true, nested_runs: true, workspace_recipes: true });
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  setPacksForTest([{ manifest: { id: "fx_kit", name: "Kit", version: "1", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
  const storage = await import("../src/storage.js");
  const R = await import("../src/recipes.js");
  const P = await import("../src/programs.js");
  const AP = await import("../src/agent-profiles.js");

  assert.equal(await storage.platformStoreConfigured(), false, "no object store anywhere");
  await assert.rejects(storage.objectStore(), /no object store/);

  // ---------- 1. the pack's recipes come in ----------
  const files = (await (async () => { await R.syncDeclaredRecipes(); return R.readRecipe("review-kit"); })());
  {
    assert.equal(files.version, 1, "version 1");
    const v = files.versions.find((x) => x.version === 1)!;
    assert.deepEqual(v.files.map((f) => f.path), [".claude/skills/review/SKILL.md", "cases/cases.json", "scripts/check.sh"]);
    const rows = await db.query<{ id: string; parts: number; inline: boolean; sha256: string }>("SELECT id, parts, inline_data IS NOT NULL AS inline, sha256 FROM agent_profile_uploads WHERE id = ANY($1::text[])", [v.files.map((f) => f.id)]);
    assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.inline && r.parts === 1), "each file kept in the database, one part");
    const skill = await R.recipeFile("review-kit", 1, 1);
    assert.equal(skill.data.toString("utf8"), SKILL); assert.equal(skill.file.sha256, sha(SKILL), "its bytes and sha256 exact");
    assert.equal(v.files.find((f) => f.path === "scripts/check.sh")!.executable, true, "a script stays executable");
    ok("the pack's recipes come in with no object store: version 1, each file in the database (one part), bytes and sha256 exact");
  }

  // ---------- 2. what a session receives ----------
  {
    const x = await R.expandRecipes([], [{ id: "review-kit", version: null }]);
    assert.deepEqual(x.recipes, [{ id: "review-kit", name: "Review kit", version: 1 }]);
    for (const u of x.uploads) {
      const parts = AP.uploadParts(u.bytes);
      const got = Buffer.concat(await Promise.all(Array.from({ length: parts }, (_, n) => AP.readUploadPart(u.id, n))));
      assert.equal(sha(got), u.sha256, `${u.path}: the wake's fetch reads it back`);
    }
    ok("a session's pick expands into the recipe's files, and each part reads back as a wake fetches it, with no object store");
  }

  // ---------- 3. a program whose test runs a declared recipe ----------
  {
    await P.syncDeclaredPrograms();
    const prog = await P.readProgram("measure");
    const t = prog.config.acceptance!.test!;
    assert.deepEqual(t.recipe, { id: "review-kit", version: 1 }, "the declared program loaded, its test frozen from version 1");
    assert.deepEqual(t.files.map((f) => [f.path, f.sha256]).sort(), files.versions[0]!.files.map((f) => [f.path, f.sha256]).sort(), "file by file, by sha256");
    assert.match(t.sha256, /^[0-9a-f]{64}$/);
    const made = await P.createProgram("staff-1", { id: "measure-again", name: "Measure again", config: structuredClone(PACK.programs[0]!.config) as never });
    assert.deepEqual((await P.readProgram(made.id)).config.acceptance!.test!.recipe, { id: "review-kit", version: 1 }, "a person's program frozen the same way");
    ok("a declared program whose acceptance test runs a declared recipe loads, its test frozen file by file; a person's too");
  }

  // ---------- 4. what still needs a store ----------
  {
    const big = Buffer.alloc(AP.UPLOAD_PART_BYTES + 1, 7);
    await assert.rejects(AP.storeUploadBytes("the app", big), /no object store/, "a file of more than one part: refused, in words");
    const up = await AP.startUpload("staff-1", { bytes: 5 });
    await assert.rejects(AP.putUploadPart(up.id, 0, Buffer.from("hello")), /no object store/, "a staff upload's parts go to the object store, as before");
    process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
    const later = await AP.storeUploadBytes("the app", Buffer.from("later"));
    const [r] = await db.query<{ inline: boolean }>("SELECT inline_data IS NOT NULL AS inline FROM agent_profile_uploads WHERE id = $1", [later.id]);
    assert.equal(r!.inline, false, "with a store configured, a new file goes to it");
    assert.equal((await AP.readUploadBytes(later.id)).toString(), "later");
    assert.equal((await R.recipeFile("review-kit", 1, 1)).data.toString("utf8"), SKILL, "the database-kept ones still read");
    delete process.env.APP_STORAGE_DIR;
    ok("a file past one part, and a staff upload, still need an object store (refused in words); once one is set, new files go there and the database-kept ones still read");
  }
  console.log("declared-recipes-no-store-test: all passed");
} finally {
  cleanup();
}
process.exit(0);
