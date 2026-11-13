// A record's page, part 4 (mold_v0-262, flag record_pages), offline: run by `npm run test:record-pages` after the other
// parts. The fixture scripts/fixtures/packs/fixture_pages with, in memory, a build's Failure section shown only while it
// failed, an Open artifact action (open_url), a tags field shown as chips and a release page that hides Linked records.
//   1. Declared and refused (src/pack-api.ts): a section's `when` (the notices' conditions over the area's fields), an
//      open_url action's field (a url field, or text), display "chips" (a json field only), `linked` on a layout.
//   2. Reference titles (src/record-areas.ts withRefTitles): an area's list, a record's detail and a related list's rows
//      carry the titles of the records their references name ({field: {key: title}}), only while the flag is on; a
//      record its reader may not see keeps its key (none for another workspace's); the console shows titles, linked.
//   3. External links: an open_url action answers the field's address (http or https only), disabled with why when the
//      field is empty or holds no web address; the page opens it in a new tab (noopener).
//   4. Conditional sections and Linked records (pure, web/src/features/records/detail-layout.ts): a section with `when`
//      shown only while it holds; Linked records leaves out the links shown as facts or a section's fields, and none with
//      linked: false. Chips (source): a json list of strings as chips, four in a cell then +N.
//   5. The header at 390 px (source): the actions bar wraps inside the header (never its one-line width), so More stays in
//      the card.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const web = (rel: string) => import(pathToFileURL(path.join(WEB, rel)).href);
const ok = (m: string) => console.log(`✓ ${m}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages", "pack.json"), "utf8"));
const areaOf = (j: { record_areas: { name: string }[] }, n: string) => j.record_areas.find((a) => a.name === n) as any;
{
  const b = areaOf(FIXTURE, "builds");
  b.fields.push({ name: "tags", label: "Tags", type: "json", display: "chips" });
  b.detail.tabs[1].sections[0].when = { field: "status", equals: "failed" };
  b.detail.actions.splice(4, 0, { kind: "open_url", field: "artifact", label: "Open artifact" });
  areaOf(FIXTURE, "releases").detail.linked = false;
}

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  const { RecordAreaSchema } = await import("../src/pack-api.js");
  const install = (j: unknown) => setPacksForTest([{ manifest: { id: "fixture_pages", name: "Fixture pages", version: "0.1.0", entry: null, migrations: null, words: {},
    dir: path.join(ROOT, "scripts", "fixtures", "packs", "fixture_pages") }, declared: compileDeclarations(j) } as never]);
  install(FIXTURE);

  // ---------- 1. declared and refused ----------
  {
    const builds = areaOf(FIXTURE, "builds");
    const bad = (patch: (a: any) => void, re: RegExp, what: string) => {
      const a = clone(builds); patch(a);
      const r = RecordAreaSchema.safeParse(a);
      assert.ok(!r.success && re.test(JSON.stringify(r.error.issues)), `${what}: ${r.success ? "accepted" : JSON.stringify(r.error.issues)}`);
    };
    assert.ok(RecordAreaSchema.safeParse(builds).success, "the fixture's builds declare");
    bad((a) => { a.detail.tabs[1].sections[0].when = { field: "nope", equals: "x" }; }, /nope is not one of the area's fields/, "a section's condition on no field");
    bad((a) => { a.detail.tabs[1].sections[0].when = { field: "status", equals: "exploded" }; }, /exploded is not one of status's options/, "an option the field lacks");
    bad((a) => { a.detail.actions.find((x: any) => x.kind === "open_url").field = "duration"; }, /a number field: an open_url action opens a url field's address/, "open_url on a number");
    bad((a) => { delete a.detail.actions.find((x: any) => x.kind === "open_url").field; }, /names the field holding the web address/, "open_url without a field");
    bad((a) => { a.fields.find((f: any) => f.name === "branch").display = "chips"; }, /display: \\"chips\\" is for a json field/, "chips on a text field");
    bad((a) => { a.detail.linked = "no"; }, /boolean/i, "linked is true or false");
    ok("declared and refused: a section's when (fields and options checked), an open_url action's url or text field, chips for a json field only, linked true or false");
  }

  F.setFeaturesForTest({ record_pages: true });
  const A = (await createOrg(`Pages 262 A ${STAMP}`)).org, B = (await createOrg(`Pages 262 B ${STAMP}`)).org, a = A.orgId, b = B.orgId;
  const http = await startHttp();
  const member = await http.signIn(A, "member"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const get = async (tok: string, p: string) => { const r = await http.req("GET", p, h(tok)); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rec = ra.workspaceRecords("fixture_pages", a);
  await ra.asWriter({ by: "people", id: "seed" }, async () => {
    await rec.put("projects", "checkout", { title: "Checkout", data: { summary: "The payment pages" } });
    await rec.put("environments", "staging-eu", { title: "Staging (EU)", data: { tier: "staging" } });
    await rec.put("builds", "build-01", { title: "Build 01", data: { status: "queued", project: "checkout", environment: "staging-eu", branch: "main", artifact: "https://artifacts.example.com/build-01.zip", tags: ["web", "payments", "eu", "beta", "canary"] } });
    await rec.put("builds", "build-02", { title: "Build 02", data: { status: "queued", project: "checkout", branch: "main" } });
  });
  await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", b).put("projects", "other", { title: "B's project", data: {} }));

  // ---------- 2. reference titles ----------
  {
    const list = await get(member, "/api/records/builds");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const by = Object.fromEntries(list.body.records.map((r: any) => [r.key, r.ref_titles ?? null]));
    assert.deepEqual(by["build-01"], { project: { checkout: "Checkout" }, environment: { "staging-eu": "Staging (EU)" } }, "a list row: each reference's title");
    assert.deepEqual(by["build-02"], { project: { checkout: "Checkout" } });
    assert.ok(!("project" in (by["build-02"] ?? {})) || !("environment" in by["build-02"]), "a reference left empty names nothing");
    const det = await get(member, "/api/records/builds/build-01");
    assert.deepEqual(det.body.record.ref_titles, { project: { checkout: "Checkout" }, environment: { "staging-eu": "Staging (EU)" } }, "the record's own facts and sections");
    const pg = await get(member, "/api/records/_page/projects/checkout?tab=overview");
    const related = Object.values(pg.body.sections as Record<string, any>).find((s: any) => s?.area === "builds");
    assert.ok(related?.records?.every((r: any) => r.ref_titles?.project?.checkout === "Checkout"), `a related list's rows: ${JSON.stringify(related).slice(0, 300)}`);
    // Another workspace's records are never titles here: B's list reads B's own (its project's title, never A's).
    await ra.asWriter({ by: "people", id: "seed" }, () => ra.workspaceRecords("fixture_pages", b).put("builds", "build-01", { title: "B build", data: { status: "queued", project: "other" } }));
    assert.deepEqual((await get(ownerB, "/api/records/builds")).body.records.map((r: any) => r.ref_titles), [{ project: { other: "B's project" } }], "each workspace's titles are its own");
    F.setFeaturesForTest({ record_pages: false });
    assert.ok((await get(member, "/api/records/builds")).body.records.every((r: any) => r.ref_titles === undefined), "off: the rows as before");
    assert.equal((await get(member, "/api/records/builds/build-01")).body.record.ref_titles, undefined, "off: the record as before");
    F.setFeaturesForTest({ record_pages: true });
    const fv = readFileSync(path.join(WEB, "features", "records", "record-pages.tsx"), "utf8");
    assert.match(fv, /\{titles\?\.\[k\] \?\? k\}/, "the console shows a reference's title in place of its key, linked to the record");
    assert.match(fv, /data-ref-cell=\{name\}/, "a list cell links each reference by its title");
    const dp = readFileSync(path.join(WEB, "features", "records", "detail-page.tsx"), "utf8");
    assert.match(dp, /titles=\{record\.ref_titles\?\.\[x\.field!\]\}/, "a fact passes its reference's titles");
    assert.match(dp, /titles=\{r\.ref_titles\?\.\[f\.name\]\}/, "a related list's cell too");
    ok("reference titles: a list's rows, a record's detail and a related list's rows carry the named records' titles (another workspace's or a missing one: the key); off, as before; the console shows them linked");
  }

  // ---------- 3. external links ----------
  {
    const acts = async (key: string) => (await get(member, `/api/records/_page/builds/${key}`)).body.actions as any[];
    const open = (xs: any[]) => xs.find((x) => x.kind === "open_url");
    const one = open(await acts("build-01"));
    assert.deepEqual([one.id, one.label, one.url, one.disabled], ["open_url.artifact", "Open artifact", "https://artifacts.example.com/build-01.zip", null], "the field's address");
    // mold_v0-298: an empty field offers no action (it was disabled, with why).
    assert.equal(open(await acts("build-02")), undefined, "an empty field: the action is not offered");
    const viewer = await http.signIn(A, "viewer");
    assert.equal(open((await get(viewer, "/api/records/_page/builds/build-01")).body.actions).url, "https://artifacts.example.com/build-01.zip", "a viewer may follow it (it changes nothing)");
    const pa = readFileSync(path.join(WEB, "features", "records", "page-actions.tsx"), "utf8");
    assert.match(pa, /a\.kind === 'open_url'\) return void \(a\.url && window\.open\(a\.url, '_blank', 'noopener,noreferrer'\)\)/, "the page opens it in a new tab, without the opener");
    ok("external links: an open_url action answers its field's http(s) address, hidden when it holds none; a viewer may follow it; opened in a new tab without the opener");
  }

  // ---------- 4. conditional sections, Linked records, chips ----------
  {
    const L = await web("features/records/detail-layout.ts");
    const failure = areaOf(FIXTURE, "builds").detail.tabs[1].sections[0];
    assert.equal(L.sectionShown(failure, { status: "failed" }), true, "the Failure section while the build failed");
    assert.equal(L.sectionShown(failure, { status: "passed" }), false, "and not otherwise");
    assert.equal(L.sectionShown({ title: "Always", fields: ["notes"] }, {}), true, "a section without when: always");
    const bl = areaOf(FIXTURE, "builds").detail;
    assert.deepEqual(L.linkedShown(bl, ["project", "environment", "other"]), ["other"], "Linked records leaves out the links shown as facts");
    assert.deepEqual(L.linkedShown(areaOf(FIXTURE, "releases").detail, ["project", "service"]), [], "linked: false: none");
    const dp = readFileSync(path.join(WEB, "features", "records", "detail-page.tsx"), "utf8");
    assert.match(dp, /if \(!sectionShown\(s, record\.data, record\.clocks\)\) return null;/, "the page draws a section only while its condition holds");
    assert.match(dp, /listed\.has\(l\.field\)/, "the Linked records card lists only what linkedShown keeps");
    const rp = readFileSync(path.join(WEB, "features", "records", "record-pages.tsx"), "utf8");
    assert.match(rp, /<Chips values=\{chips\} max=\{4\} \/>/, "a list cell: four chips, then +N");
    assert.match(rp, /data-chip-more/, "the rest counted");
    const d = await get(member, "/api/records/builds/build-01");
    assert.deepEqual(d.body.record.data.tags, ["web", "payments", "eu", "beta", "canary"], "a chips field is a json list as stored");
    ok("conditional sections (shown while their condition holds), Linked records without what the page shows already (none with linked: false), and chips for a json list of strings");
  }

  // ---------- 5. the header at 390 px ----------
  {
    const pa = readFileSync(path.join(WEB, "features", "records", "page-actions.tsx"), "utf8");
    const bar = /<div className='([^']+)' data-page-actions=''/.exec(pa)?.[1] ?? "";
    assert.ok(bar.includes("flex-wrap") && bar.includes("min-w-0") && bar.includes("max-w-full") && !/\bshrink-0\b/.test(bar), `the actions bar wraps inside the header: ${bar}`);
    const dp = readFileSync(path.join(WEB, "features", "records", "detail-page.tsx"), "utf8");
    assert.ok(!/flex shrink-0 flex-wrap items-start gap-2'>\{share\}\{actionsBar\}/.test(dp), "Share and the actions wrap together, not held to one line");
    ok("the header's actions wrap inside the card at any width (More is never clipped at 390 px)");
  }
  F.setFeaturesForTest(null);
  await http.close();
  console.log("\nrecord pages (mold_v0-262): all checks passed");
} finally {
  cleanup();
}
process.exit(0);
