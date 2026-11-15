// mold_v0-309: the titles a list, a record's page and a related list show for the records their references name
// (src/record-areas.ts withRefTitles), offline on the fixture scripts/fixtures/packs/fixture_pages with its projects
// sealed (their titles stored encrypted, "enc:v1:..."):
//   1. a list's rows, a record's own answer and a related list's rows carry the plain title, and no answer anywhere
//      holds the ciphertext;
//   2. a merged tab's row whose own title is only its key takes its partner's (src/record-merge.ts mergeRow), and a
//      reference to such a row is titled by that partner (a workspace record matched to a library record);
//   3. a runs tab's targets by their titles (recordTitles), as the person reads them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const areaOf = (n: string) => FIXTURE.record_areas.find((a: { name: string }) => a.name === n);
areaOf("projects").sealed = true;

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { getDb } = await import("../src/db.js");
  const ra = await import("../src/record-areas.js");
  const { mergeRow } = await import("../src/record-merge.js");
  setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(FIXTURE) } as never]);
  F.setFeaturesForTest({ record_pages: true });
  const A = (await createOrg(`Titles 309 ${STAMP}`)).org, a = A.orgId;
  const http = await startHttp();
  const member = await http.signIn(A, "member");
  const h = { authorization: `Bearer ${member}`, "x-pack-request": "1" };
  const get = async (p: string) => { const r = await http.req("GET", p, h); const text = await r.text(); return { status: r.status, text, body: JSON.parse(text || "{}") as any }; };
  const rec = ra.workspaceRecords("fixture_pages", a);
  await ra.asWriter({ by: "people", id: "seed" }, async () => {
    await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages" } });
    await rec.put("builds", "build-01", { title: "Build 01", data: { status: "queued", project: "checkout", branch: "main" } });
  });

  // 1. A sealed area's titles, opened.
  {
    const stored = await (await getDb()).query<{ title: string }>("SELECT title FROM workspace_records WHERE org_id = $1 AND area = 'projects' AND key = 'checkout'", [a]);
    assert.match(stored[0]!.title, /^enc:v1:/, "the project's title is stored sealed (the case this guards)");
    const list = await get("/api/records/builds");
    assert.equal(list.status, 200, list.text.slice(0, 300));
    assert.deepEqual(list.body.records.find((r: any) => r.key === "build-01")?.ref_titles, { project: { checkout: "Checkout" } }, "a list's row: the plain title");
    const det = await get("/api/records/builds/build-01");
    assert.deepEqual(det.body.record.ref_titles, { project: { checkout: "Checkout" } }, "the record's own answer");
    const pg = await get("/api/records/_page/projects/checkout?tab=overview");
    assert.equal(pg.status, 200, pg.text.slice(0, 300));
    const related = Object.values(pg.body.sections as Record<string, any>).find((s: any) => s?.area === "builds");
    assert.ok(related?.records?.every((r: any) => r.ref_titles?.project?.checkout === "Checkout"), `a related list's rows: ${JSON.stringify(related).slice(0, 300)}`);
    for (const [what, x] of [["list", list], ["record", det], ["page", pg], ["projects list", await get("/api/records/projects")]] as const)
      assert.doesNotMatch(x.text, /enc:v1:/, `no ciphertext in the ${what}'s answer`);
    ok("a sealed area's titles: plain in a list's row, a record's answer and a related list's rows; no enc:v1: in any answer");
  }

  // 2. A merged row's title, and a reference to it, from its partner when its own is only its key.
  {
    const row = (title: string | null) => ({ key: "ctl-1", title, data: {}, updated_at: "2026-11-15T00:00:00.000Z" }) as never;
    assert.equal(mergeRow("ctl-1", [{ area: "mine", record: row("ctl-1") }, { area: "library", record: row("Access control") }])?.title, "Access control", "a row titled by its key takes the library record's");
    assert.equal(mergeRow("ctl-1", [{ area: "mine", record: row("My control") }, { area: "library", record: row("Access control") }])?.title, "My control", "its own title, when it has one, first");
    assert.equal(mergeRow("ctl-1", [{ area: "mine", record: row("ctl-1") }])?.title, "ctl-1", "no partner: as before");
    const src = readFileSync(path.join(ROOT, "src", "record-areas.ts"), "utf8");
    assert.match(src, /const partners = await mergedPartners\(actor, orgId, area\.scope\);[\s\S]*?let bare = keys\.filter\(\(k\) => !own\.has\(k\) \|\| own\.get\(k\) === k\);/, "a reference to a row titled by its key: its merged-tab partner's title");
    ok("merged rows: a title other than the key first (a library record's); a reference to such a row titled the same way");
  }

  // 3. A runs tab's targets.
  {
    const t = await ra.recordTitles(a, "projects", ["checkout", "nope"], { role: "member", userId: null } as never);
    assert.deepEqual([...t], [["checkout", "Checkout"]], "a sealed target's title, opened; an unknown key none");
    assert.deepEqual([...(await ra.recordTitles(a, "no_such_area", ["x"], { role: "member", userId: null } as never))], [], "an area that is not there: none");
    ok("runs: a target's title as the person reads it (sealed ones opened)");
  }
  await http.close();
  console.log("\nrecord titles (mold_v0-309): all checks passed");
} finally {
  cleanup();
}
