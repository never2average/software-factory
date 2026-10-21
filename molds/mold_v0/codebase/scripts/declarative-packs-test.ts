// Declarative packs (mold_v0-057; src/pack-manifest.ts, molds/mold_v0/MOLD.md "Pack and record-area contract").
//   npm run test:declarative-packs     offline: an embedded database in a temporary directory
//
// 1. The JSON Schema of pack.json (packs/pack.schema.json) is current, and a JSON Schema validator takes the fixture
//    and refuses a malformed one: the file is a real contract for editors and intake, not a description.
// 2. gen-packs builds the fixture pack (scripts/fixtures/packs/fixture_tracker: a pack.json, no code): its areas,
//    credential and steps reach the console's registry, and packs.generated.ts carries the compiled declarations and no
//    import; and refuses malformed pack.json files with the path and the reason.
// 3. A code entry extends a declarative pack (its tool and area join the declared ones); one that redeclares a declared
//    name is refused.
// 4. In the database (two workspaces): typed fields (validation errors on bad values), required fields, references that
//    never reach another workspace's records, the lifecycle (a write never changes the state; moves only along declared
//    transitions, with their roles), permissions per role (create/update/move/delete/read, never wider than the
//    platform's), two-workspace isolation, schema drift shown on read, and job-kind arguments checked on start.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "packs", "fixture_tracker");
const fixtureJson = () => JSON.parse(readFileSync(path.join(FIXTURE, "pack.json"), "utf8"));
const gen = (packsDir: string) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packsDir, "--out", path.join(packsDir, "..", "out"), "--profile", path.join(TMP, "none.json")], { cwd: ROOT, encoding: "utf8" });
let n = 0;
/** A packs directory with one pack: its pack.json (and files); gen-packs' result on it. */
const tryPack = (json: unknown, files: Record<string, string> = {}) => {
  const dir = path.join(TMP, `try-${++n}`, "packs"), id = (json as { id?: string })?.id ?? "fixture_tracker", pdir = path.join(dir, typeof id === "string" ? id : "x");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(path.join(pdir, "pack.json"), typeof json === "string" ? json : JSON.stringify(json, null, 2));
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(pdir, f)), { recursive: true }); writeFileSync(path.join(pdir, f), text.replaceAll("$API", path.relative(pdir, path.join(ROOT, "src", "pack-api.js")).split(path.sep).join("/"))); }
  return { r: gen(dir), out: path.join(dir, "..", "out") };
};
const refused = (what: string, x: { r: ReturnType<typeof gen> }, re: RegExp) => {
  assert.equal(x.r.status, 1, `${what}: refused (got ${x.r.status}: ${x.r.stdout}${x.r.stderr})`);
  assert.match(x.r.stderr, re, `${what}: says where and why`);
};
/** A copy of the fixture's pack.json changed by `edit`. */
const variant = (edit: (j: any) => void) => { const j = fixtureJson(); edit(j); return j; };

try {
  // ---------- 1. the JSON Schema ----------
  {
    const s = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/pack-schema.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(s.status, 0, `packs/pack.schema.json is current: ${s.stderr}`);
    const schema = JSON.parse(readFileSync(path.join(ROOT, "packs", "pack.schema.json"), "utf8"));
    const { default: Ajv } = (await import("ajv/dist/2020.js")) as unknown as { default: new (o: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown[] } } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    assert.ok(validate(fixtureJson()), `the fixture passes the JSON Schema: ${JSON.stringify(validate.errors)}`);
    for (const [what, bad] of [
      ["an unknown field type", variant((j) => { j.record_areas[0].fields[0].type = "enumm"; })],
      ["an unknown key", variant((j) => { j.tables = []; })],
      ["a reserved key (tabs, mold_v0-058)", variant((j) => { j.tabs = []; })],
      ["a field name that is not a plain word", variant((j) => { j.record_areas[0].fields[0].name = "x; DROP TABLE"; })],
      ["an enum value with markup", variant((j) => { j.record_areas[0].fields[1].options = ["<img src=x onerror=alert(1)>"]; })],
      ["a role that does not exist", variant((j) => { j.record_areas[2].permissions.create = ["admin"]; })],
    ] as const) assert.ok(!validate(bad), `the JSON Schema refuses ${what}`);
    console.log("✓ packs/pack.schema.json is current; a JSON Schema validator takes the fixture and refuses 6 malformed ones");
  }

  // ---------- 2. gen-packs builds a pack.json alone, and refuses malformed ones ----------
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  {
    const dir = path.join(TMP, "fixture", "packs");
    cpSync(FIXTURE, path.join(dir, "fixture_tracker"), { recursive: true });
    const r = gen(dir);
    assert.equal(r.status, 0, `gen-packs builds the declarative fixture: ${r.stderr}`);
    assert.match(r.stdout, /1 pack\(s\) \(fixture_tracker\), 0 page\(s\), 3 record area\(s\), 1 credential\(s\), 2 onboarding step\(s\), 0 with migrations/);
    const out = path.join(dir, "..", "out");
    const reg = readFileSync(path.join(out, "src", "packs.generated.ts"), "utf8");
    assert.doesNotMatch(reg, /^import /m, "no code is imported for a pack.json alone");
    const line = /^ {2}\{ manifest: (.*), declared: (.*), definition: null \},$/m.exec(reg);
    assert.ok(line, "the registry carries the declarations and no definition");
    assert.equal(JSON.parse(line![1]!).entry, null, "no entry");
    assert.deepEqual(JSON.parse(line![2]!), JSON.parse(JSON.stringify(compileDeclarations(fixtureJson()))), "the declarations as src/pack-manifest.ts compiles them");
    const nav = readFileSync(path.join(out, "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    const areas = JSON.parse(/export const recordAreas[^=]*= ([\s\S]*?);\n/.exec(nav)![1]!);
    assert.deepEqual(areas.map((a: any) => [a.name, a.scope, a.lifecycle?.initial ?? null]), [["tracker_policies", "platform", null], ["tracker_apps", "workspace", null], ["tracker_findings", "workspace", "open"]]);
    assert.deepEqual(areas[2].links, [{ field: "app", area: "tracker_apps" }, { field: "policy", area: "tracker_policies" }], "reference fields are the area's links");
    assert.match(nav, /"title": "Credentials"/, "the Credentials page appears for the declared field");
    console.log("✓ gen-packs builds a pack.json alone: 3 areas, a credential, 2 steps; the registry carries the compiled declarations and imports nothing");

    const id = "fixture_tracker";
    refused("not JSON", tryPack(`{ "id": "${id}", `), /not valid JSON/);
    refused("an unknown field type", tryPack(variant((j) => { j.record_areas[2].fields[0].type = "enumm"; })), /pack\.json: record_areas\[2\]\.fields\[0\]\.type: Invalid option/);
    refused("an enum with no options", tryPack(variant((j) => { delete j.record_areas[1].fields[2].options; })), /record_areas\[1\]\.fields\[2\]\.options: an enum field lists its options/);
    refused("a reference with no area", tryPack(variant((j) => { delete j.record_areas[2].fields[2].to; })), /fields\[2\]\.to: a reference field names the area it refers to/);
    refused("a lifecycle starting in a state that is not an option", tryPack(variant((j) => { j.record_areas[2].lifecycle.initial = "new"; })), /lifecycle\.initial: initial new is not one of state's options/);
    refused("a transition to an undeclared state", tryPack(variant((j) => { j.record_areas[2].lifecycle.transitions[0].to = "done"; })), /lifecycle\.transitions\[0\]\.to: to done is not one of state's options/);
    refused("a lifecycle on a text field", tryPack(variant((j) => { j.record_areas[2].lifecycle.field = "due"; })), /lifecycle\.field: lifecycle\.field must name one of the area's single-choice enum fields/);
    refused("a viewer allowed to create (wider than the platform)", tryPack(variant((j) => { j.record_areas[2].permissions.create = ["viewer", "member"]; })), /permissions\.create: viewer is read-only in the platform/);
    refused("a viewer's transition", tryPack(variant((j) => { j.record_areas[2].lifecycle.transitions[0].roles = ["viewer"]; })), /viewer is read-only in the platform: a transition cannot be a viewer's/);
    refused("a shared area customers may write", tryPack(variant((j) => { j.record_areas[0].permissions.update = ["owner"]; })), /record_areas\[0\]\.permissions\.update: a shared \(platform\) area is written by platform staff only/);
    refused("a role that does not exist", tryPack(variant((j) => { j.record_areas[2].permissions.create = ["admin"]; })), /permissions\.create\[0\]: Invalid option/);
    refused("a field name that is not a plain word", tryPack(variant((j) => { j.record_areas[1].fields[0].name = "url'); DROP TABLE x; --"; })), /record_areas\[1\]\.fields\[0\]\.name: lowercase letters, digits and _/);
    refused("an enum value with markup", tryPack(variant((j) => { j.record_areas[2].fields[0].options[0] = "<script>alert(1)</script>"; })), /fields\[0\]\.options\[0\]: Invalid input|a choice value/);
    refused("a reference to an area no pack declares", tryPack(variant((j) => { j.record_areas[2].fields[2].to = "nowhere"; })), /record area tracker_findings links field app to area nowhere, which no pack declares/);
    refused("a shared area referring to a workspace's area", tryPack(variant((j) => { j.record_areas[0].fields.push({ name: "app", label: "App", type: "reference", to: "tracker_apps" }); })), /tracker_policies is shared \(platform\) and its field app refers to tracker_apps, a workspace's own area/);
    refused("a reserved key (tabs, mold_v0-058)", tryPack(variant((j) => { j.tabs = [{ area: "tracker_findings" }]; })), /pack\.json: tabs: tabs come with mold_v0-058/);
    refused("charts before mold_v0-063", tryPack(variant((j) => { j.charts = []; })), /charts: charts come with mold_v0-063/);
    refused("an unknown key", tryPack(variant((j) => { j.tables = []; })), /unknown field tables/);
    refused("a harness kind with no program", tryPack(variant((j) => { j.job_kinds[0].runner = "workspace-harness"; })), /job_kinds\[0\]\.entry/);
    refused("a harness kind whose program is not in the pack", tryPack(variant((j) => { j.job_kinds[0] = { name: "kx", runner: "workspace-harness", entry: "run.mjs" }; j.schedules = []; j.onboarding = [j.onboarding[0]]; })), /job kind kx: run\.mjs is not a file of the pack/);
    refused("an agent kind naming an undeclared credential", tryPack(variant((j) => { j.job_kinds[0].credentials = ["nope"]; })), /job kind tracker_scan names credential nope, which this pack does not declare/);
    refused("a schedule of an undeclared kind", tryPack(variant((j) => { j.schedules[0].job_kind = "nope"; })), /schedule nightly_scan names job kind nope/);
    refused("a credential bound to a non-asset area", tryPack(variant((j) => { j.credentials[0].area = "tracker_findings"; })), /credential tracker_token is bound to area tracker_findings, which is not one of this pack's asset areas/);
    refused("an argument of an unknown type", tryPack(variant((j) => { j.job_kinds[0].args[1].type = "integer"; })), /job_kinds\[0\]\.args\[1\]\.type: Invalid option/);
    refused("a metric over nothing", tryPack(variant((j) => { j.metrics[0].over = "nowhere"; })), /metric open_by_severity is over nowhere, which is neither a record area of this build nor run_results/);
    refused("an area reading from an undeclared repository", tryPack(variant((j) => { j.record_areas[1].repository = "nowhere"; })), /record area tracker_apps reads from repository nowhere, which this pack does not declare/);
    refused("a repository with no kind", tryPack(variant((j) => { delete j.repositories.tracker_ledger.kind; })), /repositories\.tracker_ledger\.kind/);
    refused("a run-results mapping naming no area", tryPack(variant((j) => { j.run_results.check = ["nowhere"]; })), /run_results\.check names nowhere, which is not a record area of this build/);
    refused("a schedule giving an argument its kind lacks", tryPack(variant((j) => { j.schedules[0].scope = { nope: 1 }; })), /schedule nightly_scan: tracker_scan has no argument nope/);
    refused("an argument referring to no area", tryPack(variant((j) => { j.job_kinds[0].args[0].to = "nowhere"; })), /job kind tracker_scan's argument app refers to area nowhere, which no pack declares/);
    refused("server code in a pack with no entry", tryPack(fixtureJson(), { "tools.ts": "export const x = 1;\n" }), /tools\.ts is server code but the pack has no entry/);
    refused("the same field twice", tryPack(variant((j) => { j.record_areas[1].fields.push({ name: "url", label: "Again" }); })), /record_areas\[1\]\.fields: a field is declared twice/);
    console.log(`✓ gen-packs refuses ${n} malformed pack.json files, each with its path and reason`);
  }

  // ---------- 3. code extends a declarative pack ----------
  {
    const base = { id: "fx_mixed", name: "Mixed", version: "1", record_areas: [{ name: "fx_items", label: "Items", role: "check", scope: "workspace", fields: [{ name: "body", label: "Body", type: "text" }] }] };
    const entry = (extra: string) => `import { definePack, defineTool, z } from "$API";
export default definePack({ id: "fx_mixed",
  tools: [defineTool({ name: "fx_add_item", description: "Add an item.", inputSchema: { key: z.string() }, handler: async (_ws, { key }, { records }) => records.put("fx_items", key, { data: { body: "x" } }) })],
  recordAreas: [${extra}] });\n`;
    const ok = tryPack({ ...base, entry: "index.ts" }, { "index.ts": entry(`{ name: "fx_notes", label: "Notes", role: "check", scope: "workspace", fields: [{ name: "item", label: "Item", type: "reference", to: "fx_items" }] }`) });
    assert.equal(ok.r.status, 0, `a code entry extends a declarative pack: ${ok.r.stderr}`);
    assert.match(ok.r.stdout, /1 pack\(s\) \(fx_mixed\), 0 page\(s\), 2 record area\(s\)/, "the declared area and the code's");
    assert.match(readFileSync(path.join(ok.out, "src", "packs.generated.ts"), "utf8"), /^import pack0 from .*fx_mixed\/index\.js";$/m, "the entry is imported");
    refused("code redeclaring a declared area", tryPack({ ...base, entry: "index.ts" }, { "index.ts": entry(`{ name: "fx_items", label: "Again", role: "check", scope: "workspace", fields: [{ name: "body", label: "Body" }] }`) }), /recordAreas fx_items is declared twice/);
    const plain = tryPack({ ...base }, { "index.ts": entry("") });
    assert.equal(plain.r.status, 0, `index.ts is still the entry when pack.json names none: ${plain.r.stderr}`);
    assert.match(readFileSync(path.join(plain.out, "src", "packs.generated.ts"), "utf8"), /^import pack0 from/m);
    refused("an entry that is not there", tryPack({ ...base, entry: "main.ts" }), /entry main\.ts does not exist/);
    refused("code naming the record tables", tryPack({ ...base, entry: "index.ts" }, { "index.ts": `import { definePack } from "$API";\nconst q = "UPDATE workspace_records SET data = '{}'";\nexport default definePack({ id: "fx_mixed" });\n` }), /uses the record tables \(use ctx\.records/);
    // A big build: every pack.json reaches the definitions' loader whole (once over the 128 KiB a command argument holds).
    const big = { id: "fx_big", name: "Big", version: "1", record_areas: Array.from({ length: 60 }, (_, i) => ({ name: `fx_big_${i}`, label: "L".repeat(80), role: "check", scope: "workspace",
      fields: Array.from({ length: 50 }, (_, j) => ({ name: `field_${j}`, label: `${"F".repeat(70)} ${j}`, type: "text", help: "H".repeat(200) })) })) };
    assert.ok(JSON.stringify(big).length > 300_000);
    const bigRun = tryPack(big);
    assert.equal(bigRun.r.status, 0, `a ${Math.round(JSON.stringify(big).length / 1024)} KB pack.json builds: ${bigRun.r.stderr.slice(0, 500)}`);
    console.log("✓ a code entry extends a declarative pack (its tool and area join the declared ones); redeclaring a declared name is refused");
  }

  // ---------- 4. in the database ----------
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js"); // reserves the shell's tool names (which reinstalls the registry): before the fixture is installed
  const { setPacksForTest, declaredRuns, packRegistry } = await import("../src/packs.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const { workspaceRuns } = await import("../src/runs.js");
  const { definePack } = await import("../src/pack-api.js");
  const manifest = { id: "fixture_tracker", name: "Fixture tracker", version: "0.1.0", entry: null, migrations: null, words: {}, dir: FIXTURE };
  const declared = compileDeclarations(fixtureJson());
  setPacksForTest([{ manifest, declared, definition: null }]);
  const A = (await createOrg(`Decl A ${STAMP}`)).org, B = (await createOrg(`Decl B ${STAMP}`)).org;
  const as = (org: typeof A, role: "viewer" | "member" | "billing" | "owner" | null) => rec.workspaceRecords("fixture_tracker", org.orgId, { role, userId: role ? `user_${role}` : null });
  const reg = packRegistry();
  assert.deepEqual([reg.recordAreas.length, reg.jobKinds.length, reg.agentJobKinds.length, reg.credentials.length, reg.schedules.length, reg.onboarding.length, reg.metrics.length, reg.repositories.length, reg.runResults.length],
    [3, 0, 1, 1, 1, 2, 1, 2, 1], "the registry lists every declaration (repositories and the run-results mapping for 059 and 061)");

  await rec.putPlatform(null, "tracker_policies", "p1", { title: "Patch within 30 days", data: { summary: "Critical findings are fixed within 30 days", severity: "critical" } });
  await assert.rejects(rec.putPlatform(null, "tracker_policies", "p2", { data: { severity: "critical" } }), /field summary of area tracker_policies is required/, "a shared row's required field");
  {
    // Typed fields: the right values pass, each wrong one is refused with the field and what it takes.
    const ownerA = as(A, "owner"), memberA = as(A, "member");
    await ownerA.put("tracker_apps", "web", { title: "Web app", data: { url: "https://a.example", owner: "user_owner", environment: "prod" } });
    await as(B, "owner").put("tracker_apps", "b-web", { title: "B's app", data: { url: "https://b.example", environment: "staging" } });
    const f1 = await memberA.put("tracker_findings", "f1", { title: "Outdated TLS", data: { severity: "high", app: "web", policy: "p1", due: "2026-11-30", score: 7.5, assignees: ["user_member"], evidence: [{ path: "scans/2026-10-21/tls.json", sha256: "a".repeat(64), size: 120 }] } });
    assert.equal(f1.data.state, "open", "a new record starts in the lifecycle's initial state");
    const bad = async (data: Record<string, unknown>, re: RegExp, what: string) => assert.rejects(memberA.put("tracker_findings", "fx", { data }), (e: { status?: number; message: string }) => e.status === 400 && re.test(e.message), what);
    await bad({ severity: "urgent", app: "web" }, /field severity of area tracker_findings must be one of "low", "medium", "high", "critical"/, "an enum value that is not an option");
    await bad({ severity: "low", app: "web", score: 11 }, /field score .* must be a number from 0 up to 10/, "a number out of range");
    await bad({ severity: "low", app: "web", score: "7" }, /field score .* must be a number/, "a number as text");
    await bad({ severity: "low", app: "web", due: "next week" }, /field due .* must be a date/, "a date that is not one");
    await bad({ severity: "low" }, /field app of area tracker_findings is required/, "a required reference left out");
    await bad({ severity: "low", app: "nope" }, /field app of area tracker_findings: no tracker_apps record nope in this workspace/, "a reference to no record");
    await bad({ severity: "low", app: "web", assignees: "user_member" }, /field assignees .* must be a list of a person's id/, "a single person where a list is declared");
    await bad({ severity: "low", app: "web", assignees: ["<b>x</b>"] }, /field assignees/, "a person id with markup");
    await bad({ severity: "low", app: "web", evidence: [{ path: "../../etc/passwd" }] }, /field evidence .* must be a list of a file reference/, "a file path leaving the workspace's files");
    await bad({ severity: "low", app: "web", evidence: [{ path: "/etc/passwd" }] }, /field evidence/, "an absolute file path");
    await bad({ severity: "low", app: "web", evidence: [{ path: "a.txt", url: "https://x" }] }, /field evidence/, "a file reference with an unknown key");
    await bad({ severity: "low", app: "web", nope: 1 }, /area tracker_findings has no field "nope"/, "an undeclared field");
    await bad({ severity: "urgent", app: "nope", score: -1 }, /severity.*; .*score.*/, "every problem in one refusal");
    console.log("✓ typed fields: enum, number range, date, person, reference, file and required checked on write, every problem named");

    // References never reach another workspace's records.
    await bad({ severity: "low", app: "b-web" }, /no tracker_apps record b-web in this workspace/, "A cannot refer to B's application by its key");
    await as(A, "owner").put("tracker_apps", "b-web", { data: { url: "https://a-own.example" } });
    const f2 = await memberA.put("tracker_findings", "f2", { data: { severity: "low", app: "b-web" } });
    const d2 = await rec.detailFor(A.orgId, "tracker_findings", "f2");
    assert.deepEqual(d2!.links.find((l) => l.field === "app")!.records.map((r) => r.key), ["b-web"], "the same key in A resolves to A's own record");
    const opened = await rec.getFor(A.orgId, "tracker_apps", "b-web");
    assert.equal(opened!.data.url, "https://a-own.example", "A's own, not B's");
    assert.equal(f2.data.state, "open");
    // A planted reference (written around the store, as a pack's raw query could) still resolves only in A.
    await withTenant(A.orgId, () => db.query("/* tenant: test, on purpose */ UPDATE workspace_records SET data = jsonb_set(data, '{app}', '\"only-in-b\"') WHERE org_id = $1 AND key = 'f2'", [A.orgId]));
    await as(B, "owner").put("tracker_apps", "only-in-b", { data: { url: "https://secret-b.example" } });
    const planted = await rec.detailFor(A.orgId, "tracker_findings", "f2");
    assert.deepEqual(planted!.links.find((l) => l.field === "app")!.records, [], "a stored key of B's record resolves to nothing in A");
    assert.ok(!JSON.stringify(planted).includes("secret-b"), "nothing of B's reaches A");
    console.log("✓ references: checked in the writer's workspace; the same key resolves to each workspace's own record; a planted key reaches nothing");

    // The lifecycle.
    const conflict = (e: { status?: number; message: string }, re: RegExp) => e.status === 409 && re.test(e.message);
    await assert.rejects(memberA.put("tracker_findings", "f3", { data: { severity: "low", app: "web", state: "fixed" } }), (e: any) => conflict(e, /a new Findings record starts as "open"/), "a record cannot be created in another state");
    await assert.rejects(memberA.put("tracker_findings", "f1", { data: { severity: "high", app: "web", state: "fixed" } }), (e: any) => conflict(e, /its state changes only by a move/), "a write cannot change the state");
    const kept = await memberA.put("tracker_findings", "f1", { title: "Outdated TLS", data: { severity: "critical", app: "web" } });
    assert.deepEqual([kept.data.state, kept.data.severity], ["open", "critical"], "a write keeps the state");
    await assert.rejects(memberA.move("tracker_findings", "f1", "fixed"), (e: any) => conflict(e, /cannot move from "open" to "fixed"\. From "open" it can move to: "triaged" \(Triage\), "wont_fix" \(Accept the risk\) \[owner\]/), "a move off the declared transitions, with the moves there are");
    await assert.rejects(memberA.move("tracker_findings", "f1", "wont_fix"), (e: any) => e.status === 403 && /is for owner, not the Member role/.test(e.message), "a transition kept for the owner");
    await assert.rejects(memberA.move("tracker_findings", "f1", "closed"), (e: any) => e.status === 409, "a state that does not exist");
    assert.equal((await memberA.move("tracker_findings", "f1", "triaged")).data.state, "triaged");
    assert.equal((await as(A, "billing").move("tracker_findings", "f1", "fixed")).data.state, "fixed", "billing may move (the area's move permission)");
    await assert.rejects(memberA.move("tracker_findings", "f1", "triaged"), (e: any) => conflict(e, /From "fixed" it can move to: "reopened"/));
    assert.equal((await as(A, "owner").move("tracker_findings", "f1", "reopened")).data.state, "reopened");
    await assert.rejects(memberA.move("tracker_apps", "web", "x"), /has no lifecycle/);
    await assert.rejects(memberA.move("tracker_findings", "b-only", "triaged"), (e: any) => e.status === 404, "a record that is not there");
    // A write racing a move never puts the old state back (it changes the row only from what it read).
    await memberA.put("tracker_findings", "f4", { data: { severity: "low", app: "web" } });
    for (const [i, to] of ["triaged", "fixed", "reopened", "fixed", "reopened", "fixed"].entries()) {
      const race = await Promise.allSettled([memberA.put("tracker_findings", "f4", { data: { severity: i % 2 ? "low" : "medium", app: "web" } }), memberA.move("tracker_findings", "f4", to)]);
      assert.equal(race[1].status, "fulfilled", `the move goes through: ${race[1].status === "rejected" ? (race[1].reason as Error).message : ""}`);
      if (race[0].status === "rejected") assert.match((race[0].reason as Error).message, /changed by someone else meanwhile/);
      assert.equal((await memberA.get("tracker_findings", "f4"))!.data.state, to, "the state is the move's, whatever the write read");
    }
    console.log("✓ the lifecycle: created in its initial state, a write never changes it, moves only along declared transitions and their roles, a write racing a move never puts the old state back");

    // Permissions per role, never wider than the platform's.
    const viewerA = as(A, "viewer"), billingA = as(A, "billing");
    await assert.rejects(viewerA.put("tracker_findings", "v1", { data: { severity: "low", app: "web" } }), (e: any) => e.status === 403 && /can't add Findings records with the Viewer role \(member, owner can\)/.test(e.message), "a viewer cannot create");
    await assert.rejects(billingA.put("tracker_findings", "v1", { data: { severity: "low", app: "web" } }), (e: any) => e.status === 403, "billing is not in create");
    await assert.rejects(billingA.put("tracker_findings", "f1", { data: { severity: "low", app: "web" } }), (e: any) => e.status === 403 && /can't change/.test(e.message), "billing is not in update");
    await assert.rejects(viewerA.move("tracker_findings", "f1", "fixed"), (e: any) => e.status === 403, "a viewer cannot move");
    await assert.rejects(viewerA.put("tracker_apps", "v-app", { data: { url: "https://v.example" } }), (e: any) => e.status === 403, "a viewer cannot write an area that declares nothing (the platform's floor)");
    await assert.rejects(memberA.delete("tracker_findings", "f2"), (e: any) => e.status === 403 && /can't delete/.test(e.message), "delete is the owner's");
    assert.equal(await as(A, "owner").delete("tracker_findings", "f2"), true);
    assert.equal((await viewerA.list("tracker_findings")).records.length, 2, "a viewer reads");
    await assert.rejects(viewerA.list("tracker_policies"), (e: any) => e.status === 403 && /can't read Policies records with the Viewer role/.test(e.message), "an area's narrowed read");
    assert.equal((await memberA.get("tracker_policies", "p1"))!.data.severity, "critical", "a member reads the shared policies");
    const viewerDetail = await rec.detailFor(A.orgId, "tracker_findings", "f1", { role: "viewer", userId: "user_viewer" });
    assert.ok(!viewerDetail!.links.some((l) => l.area === "tracker_policies"), "a link into an area the viewer may not read is left out");
    // A role that may write but not read gets nothing back: a write needs read too (its answer shows the record).
    const ext = JSON.parse(JSON.stringify(declared));
    ext.recordAreas.push({ name: "tracker_private", label: "Private notes", role: "check", scope: "workspace", fields: [{ name: "body", label: "Body" }, { name: "stage", label: "Stage", type: "enum", options: ["draft", "approved"] }],
      lifecycle: { field: "stage", initial: "draft", transitions: [{ from: ["draft"], to: "approved", roles: ["owner"] }] }, permissions: { read: ["owner"] } });
    setPacksForTest([{ manifest, declared: ext, definition: null }]);
    await as(A, "owner").put("tracker_private", "secret", { title: "Secret title", data: { body: "owner-only body" } });
    await as(A, "owner").move("tracker_private", "secret", "approved");
    for (const [what, call] of [["move to its own state", () => memberA.move("tracker_private", "secret", "approved")], ["move elsewhere", () => memberA.move("tracker_private", "secret", "draft")],
      ["put", () => memberA.put("tracker_private", "secret", { data: { body: "x" } })], ["delete", () => memberA.delete("tracker_private", "secret")]] as const)
      await assert.rejects((call as () => Promise<unknown>)(), (e: any) => e.status === 403 && /can't read Private notes/.test(e.message) && !/approved|owner-only/.test(e.message), `a member who may not read gets nothing from a ${what}`);
    assert.deepEqual(rec.allowedRoles(rec.findArea("tracker_private")!, "delete"), ["owner"], "a lifecycle area's delete defaults to the owner (no delete-and-re-add around the transitions)");
    // A row written before its area had a lifecycle (no state) is in the initial state; an odd stored number does not stall writes.
    await withTenant(A.orgId, () => db.query("/* tenant: test, on purpose */ INSERT INTO workspace_records (org_id, pack, area, key, data) VALUES ($1, 'fixture_tracker', 'tracker_private', 'old', '{\"body\": \"x\", \"n\": 12345678901234567891}'::jsonb)", [A.orgId]));
    assert.equal((await as(A, "owner").move("tracker_private", "old", "approved")).data.stage, "approved", "a row with no state moves from the initial one, whatever else it stores");
    await assert.rejects(memberA.put("tracker_findings", "nul", { title: "a\u0000b", data: { severity: "low", app: "web" } }), (e: any) => e.status === 400, "a NUL in a title is a 400, not a database error");
    await assert.rejects(memberA.put("tracker_findings", "nul", { data: { severity: "low", app: "web", evidence: [{ path: "a.txt", name: "x\ud800" }] } }), (e: any) => e.status === 400, "a broken surrogate is a 400");
    await assert.rejects(as(A, "owner").put("tracker_apps", "nul", { data: { url: "a\u0000b" } }), (e: any) => e.status === 400 && /cannot be stored/.test(e.message), "a NUL in text is a 400");
    setPacksForTest([{ manifest, declared, definition: null }]);
    const apiKey = as(A, null);
    assert.equal((await apiKey.put("tracker_findings", "k1", { data: { severity: "medium", app: "web" } })).data.state, "open", "an account API key has no role limits (as for every shell tool)");
    // A definition that tries to widen past the platform is refused before it is installed.
    const { installPacks } = await import("../src/packs.js");
    assert.throws(() => installPacks([{ manifest, declared: { recordAreas: [{ name: "w1", label: "W", role: "check", scope: "workspace", fields: [{ name: "x", label: "X" }], permissions: { update: ["viewer"] } }] } }]), /viewer is read-only in the platform/);
    assert.throws(() => definePack({ id: "pk", recordAreas: [{ name: "w1", label: "W", role: "check", scope: "platform", fields: [{ name: "x", label: "X" }], permissions: { create: ["owner"] } }] }), /written by platform staff only/);
    assert.deepEqual(rec.allowedRoles(rec.findArea("tracker_findings")!, "move"), ["member", "billing", "owner"]);
    assert.deepEqual(rec.allowedRoles(rec.findArea("tracker_apps")!, "create"), ["member", "billing", "owner"], "an area that declares nothing: the platform's edit roles");
    console.log("✓ permissions per role: create, update, move, delete and read each as declared, never wider than the platform's; API keys as for every shell tool");

    // Through MCP and as the database sees it: two workspaces.
    const ca = await connect({ ...A, role: "member", userId: "user_member" }), cb = await connect({ ...B, role: "member", userId: "user_member_b" });
    const laRaw = await ca.call("list_records", { area: "tracker_findings" });
    assert.ok(!laRaw.isError, `list_records: ${laRaw.content[0]?.text}`);
    const la = laRaw.structuredContent;
    assert.deepEqual(la.records.map((r: any) => r.key), ["f1", "f4", "k1"], "A lists its own findings");
    assert.equal(la.records[0].state, "reopened", "the list columns carry the state");
    assert.deepEqual((await cb.call("list_records", { area: "tracker_findings" })).structuredContent.records, [], "B has none");
    const cross = await cb.call("get_record", { area: "tracker_findings", key: "f1" });
    assert.ok(cross.isError, "B cannot get A's finding");
    const cv = await connect({ ...A, role: "viewer", userId: "user_viewer" });
    const denied = await cv.call("list_records", { area: "tracker_policies" });
    assert.ok(denied.isError && /Viewer role/.test(denied.content[0]!.text), "list_records applies the area's read permission");
    await ca.close(); await cb.close(); await cv.close();
    const seen = await withTenant(B.orgId, () => db.query<{ n: number }>("/* tenant: test, on purpose */ SELECT count(*)::int AS n FROM workspace_records WHERE area = 'tracker_findings'"));
    assert.equal(seen[0]!.n, 0, "as the tenant role for B, none of A's findings exist");
    const [raw] = await db.query<{ data: any; sealed: boolean }>("SELECT data, sealed FROM workspace_records WHERE org_id = $1 AND area = 'tracker_apps' AND key = 'web'", [A.orgId]);
    assert.ok(raw!.sealed && !JSON.stringify(raw).includes("a.example"), "a declared asset area is sealed at rest like any");
    console.log("✓ two workspaces: MCP lists and gets each workspace's own; the tenant role sees nothing of the other's; assets sealed");

    // Schema drift: the declaration changes after rows were written.
    await memberA.put("tracker_findings", "f1", { data: { severity: "critical", app: "web", score: 3 } });
    const drifted = JSON.parse(JSON.stringify(declared));
    const area = drifted.recordAreas.find((x: any) => x.name === "tracker_findings");
    area.fields = area.fields.filter((f: any) => f.name !== "score");
    area.fields.find((f: any) => f.name === "severity").options = ["low", "medium", "high"];
    setPacksForTest([{ manifest, declared: drifted, definition: null }]);
    const after = await memberA.get("tracker_findings", "f1");
    assert.deepEqual(after!.drift, ["score", "severity"], "the fields that no longer fit are named");
    assert.equal(after!.data.score, undefined, "a field no longer declared is not shown");
    assert.equal(after!.data.severity, "critical", "a value that no longer fits is shown as stored");
    await assert.rejects(memberA.put("tracker_findings", "f1", { data: { ...after!.data } }), /field severity .* must be one of "low", "medium", "high"/, "the next write must fit the declaration");
    assert.equal((await memberA.put("tracker_findings", "f1", { data: { severity: "high", app: "web" } })).drift, undefined, "and then the row fits again");
    setPacksForTest([{ manifest, declared, definition: null }]);
    console.log("✓ schema drift: a stored row that no longer fits is named on read, never silently passed; the next write must fit");
  }

  // Job kinds: an agent-workspace kind declared in pack.json runs like any kind (mold_v0-061), its declared args checked
  // on start as a harness kind's are.
  {
    const ext = definePack({ id: "fixture_tracker", jobKinds: [{ name: "tracker_local", runner: "workspace-harness", entry: "run.mjs",
      args: [{ name: "app", label: "Application", type: "reference", to: "tracker_apps", required: true }, { name: "depth", label: "Depth", type: "number", min: 1, max: 5 }] }] });
    setPacksForTest([{ manifest, declared, definition: ext }]);
    const runs = declaredRuns("fixture_tracker", workspaceRuns("fixture_tracker", A.orgId, null), A.orgId);
    await assert.rejects(runs.start("tracker_scan", { scope: { app: "web", depth: 9 } }), /field depth of job kind tracker_scan's arguments must be a number from 1 up to 5/);
    const scan = await withTenant(A.orgId, () => runs.start("tracker_scan", { scope: { app: "web" } }));
    assert.equal(scan.status, "queued", "the run engine takes an agent-workspace kind declared in pack.json (mold_v0-061)");
    await withTenant(A.orgId, () => workspaceRuns("fixture_tracker", A.orgId, null).cancel(scan.id));
    await assert.rejects(runs.start("tracker_local", { scope: { app: "web", depth: 9 } }), /field depth of job kind tracker_local's arguments must be a number from 1 up to 5/);
    await assert.rejects(runs.start("tracker_local", { scope: { app: "b-only-key" } }), /no tracker_apps record b-only-key in this workspace/, "a reference argument resolves in the run's workspace only");
    await assert.rejects(runs.start("tracker_local", { scope: {} }), /field app of job kind tracker_local's arguments is required/);
    await assert.rejects(runs.start("tracker_local", { scope: { app: "web", extra: 1 } }), /has no field "extra"/);
    const run = await withTenant(A.orgId, () => runs.start("tracker_local", { scope: { app: "web", depth: 2 } }));
    assert.deepEqual([run.status, run.scope], ["queued", { app: "web", depth: 2 }], "good arguments start the run");
    setPacksForTest([{ manifest, declared, definition: null }]);
    console.log("✓ job kinds: an agent-workspace kind declared in pack.json is taken by the run engine (061); declared arguments are checked when a run starts");
  }
  await db.close();
  console.log("DECLARATIVE PACKS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
