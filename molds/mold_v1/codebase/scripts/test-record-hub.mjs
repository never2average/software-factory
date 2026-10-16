#!/usr/bin/env node
/**
 * THE RECORD HUB, OFFLINE (profiles `records.hub`; agent/lib/record-hub.ts; docs/DEPLOYMENT_PROFILE.md "records.hub").
 *
 *   1. the default profile compiles to today's hub ("TODOs", no glyph of its own, "TODO" / "TODOs" for an entry), and
 *      this checkout's generated RECORD_HUB is that;
 *   2. a profile that names the hub (scripts/fixtures/record-hub/50-obligations-register.json) compiles to its name and
 *      glyph, its entries in the tasks area's word; one that redefines the tasks area keeps the screen's name and
 *      counts in the task's word; the previews (`?hub=` on app/preview/ops-center and control-panel) compile the
 *      fixture to exactly what the build does;
 *   3. every bad `records.hub` fails the build with the file and the path;
 *   4. the model: the default briefing and the roster tools' words are what they were; a renamed hub is named in the
 *      briefing (verbatim under a relabelling profile) and in the roster tools' descriptions.
 *
 *   npm run test:record-hub
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHub, DEFAULT_HUB_LABEL, hubAttributive, hubCount, hubProblem } from "../agent/lib/record-hub.ts";
import { RECORD_HUB } from "../agent/lib/deployment-profile.generated.ts";
import { RECORD_HUB as WEB_RECORD_HUB } from "../lib/deployment-profile.generated.ts";
import { RECORD_AREAS } from "../agent/lib/record-areas.generated.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = join(ROOT, "scripts/fixtures/record-hub/50-obligations-register.json");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
let passed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${what}\n${e.message}`);
    process.exitCode = 1;
  }
};

/** Run the generator over the checkout's default profile plus `extra` ([name, path | object]); never writes files. */
function gen(extra, flag = "--print-hub") {
  const dir = mkdtempSync(join(tmpdir(), "record-hub-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) {
      if (typeof src === "string") cpSync(src, join(dir, name));
      else writeFileSync(join(dir, name), JSON.stringify(src, null, 2));
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), flag], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const hubOf = (extra) => {
  const r = gen(extra);
  assert.equal(r.rc, 0, r.err);
  return JSON.parse(r.out);
};
const TODAY = { label: "TODOs", icon: null, item: { singular: "TODO", plural: "TODOs" }, relabelled: false };

// --- 1. the default ---------------------------------------------------------------------------------------------------
await check("the default profile compiles to today's hub", () => assert.deepEqual(hubOf([]), TODAY));
await check("this checkout's generated RECORD_HUB (both copies) is today's hub", () => {
  assert.deepEqual(RECORD_HUB, TODAY);
  assert.deepEqual(WEB_RECORD_HUB, TODAY);
});
await check("the default's words: a count and the attributive form are today's", () => {
  assert.equal(DEFAULT_HUB_LABEL, "TODOs");
  assert.equal(hubCount(TODAY, 1), "1 TODO");
  assert.equal(hubCount(TODAY, 3), "3 TODOs");
  assert.equal(hubAttributive(TODAY), "TODO");
});

// --- 2. a named hub ----------------------------------------------------------------------------------------------------
const REGISTER = { label: "Obligations Register", icon: "scale", item: { singular: "task", plural: "tasks" }, relabelled: true };
await check("a profile that names the hub: its name and glyph; an entry is the tasks area's word", () => assert.deepEqual(hubOf([["50-hub.json", FIXTURE]]), REGISTER));
await check("the previews compile the fixture to what the build does", () => {
  assert.deepEqual(compileHub(read(FIXTURE).records.hub, RECORD_AREAS.tasks), REGISTER);
});
await check("a name alone keeps today's glyphs (icon null)", () => {
  assert.deepEqual(hubOf([["50-hub.json", { records: { hub: { label: "Compliance desk" } } }]]), { ...REGISTER, label: "Compliance desk", icon: null });
});
await check("a later file changes the glyph alone", () => {
  assert.deepEqual(hubOf([["50-hub.json", FIXTURE], ["60-icon.json", { records: { hub: { icon: "shield-check" } } }]]), { ...REGISTER, icon: "shield-check" });
});
await check("a redefined tasks area under the default hub: the screen stays \"TODOs\", an entry is the task's word", () => {
  const h = hubOf([["50-tasks.json", { records: { areas: { tasks: { label: { singular: "obligation", plural: "obligations" } } } } }]]);
  assert.deepEqual(h, { ...TODAY, item: { singular: "obligation", plural: "obligations" } });
  assert.equal(hubCount(h, 2), "2 obligations");
});
await check("the hub's name is apart from the tasks area's: both renamed, each keeps its own", () => {
  const h = hubOf([["50-hub.json", FIXTURE], ["51-tasks.json", { records: { areas: { tasks: { label: { singular: "obligation", plural: "obligations" } } } } }]]);
  assert.deepEqual(h, { ...REGISTER, item: { singular: "obligation", plural: "obligations" } });
});
await check("naming the hub moves nothing in DEPLOYMENT_PROFILE", () => {
  const before = gen([], "--print"); const after = gen([["50-hub.json", FIXTURE]], "--print");
  assert.equal(before.rc, 0, before.err); assert.equal(after.rc, 0, after.err);
  assert.equal(after.out, before.out);
});

// --- 3. a bad hub fails the build ------------------------------------------------------------------------------------
const BAD = [
  ["an unknown key", { label: "X", lable: "Y" }, "profiles/50-bad.json: records.hub.lable: unknown key (not in profiles/00-default.json)"],
  ["an empty name", { label: "  " }, "profiles/50-bad.json: records.hub.label must be a non-empty string"],
  ["a name that is not a string", { label: { singular: "Register" } }, "profiles/50-bad.json: records.hub.label must be a non-empty string"],
  ["a name with spaces around it", { label: " Register" }, "starts or ends with a space"],
  ["a name on two lines", { label: "Obligations\nRegister" }, "records.hub.label must be one line"],
  ["a name too long for the nav", { label: "R".repeat(41) }, "is 41 characters; at most 40 fit the nav"],
  ["a placeholder in the name", { label: "{account} register" }, "holds { } < or >"],
  ["a glyph not in the set", { label: "Register", icon: "scales" }, 'records.hub.icon: "scales" is not one of "circle-check"'],
];
for (const [what, hub, message] of BAD) {
  await check(`refused: ${what}`, () => {
    const r = gen([["50-bad.json", { records: { hub } }]], "--check");
    assert.notEqual(r.rc, 0, "the build passed");
    assert.ok(r.err.includes(message), `expected "${message}" in:\n${r.err}`);
    assert.ok(r.err.startsWith("profiles/50-bad.json: "), `the file is named:\n${r.err}`);
  });
}
await check("hubProblem: the default's hub is fine, a hub that is not an object is not", () => {
  assert.equal(hubProblem({ label: "TODOs", icon: null }), null);
  assert.match(hubProblem("TODOs") ?? "", /records\.hub must be an object/);
});

// --- 4. the model ----------------------------------------------------------------------------------------------------
const { renderDeploymentBriefing } = await import("../agent/lib/deployment-briefing.ts");
const { DEPLOYMENT_PROFILE } = await import("../agent/lib/deployment-profile.generated.ts");
await check("the default briefing says nothing of the hub", () => {
  assert.equal(renderDeploymentBriefing(), renderDeploymentBriefing(DEPLOYMENT_PROFILE, RECORD_AREAS, TODAY));
  assert.ok(!(renderDeploymentBriefing() ?? "").includes("/?ops=todos"));
});
await check("a renamed hub is named in the briefing, with the screen it is and the tools that keep it", () => {
  const b = renderDeploymentBriefing(DEPLOYMENT_PROFILE, RECORD_AREAS, REGISTER) ?? "";
  assert.ok(b.includes("People call the screen that holds the team's checklist **Obligations Register** (the Ops Center's `todos` section; a link to it is `/?ops=todos`). What they keep there is what list_todos reads and upsert_todo writes."), b);
});
await check("under a relabelling profile the hub's name is passed verbatim", () => {
  const r = gen([["50-x.json", join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json")]], "--print");
  assert.equal(r.rc, 0, r.err);
  const relabelled = JSON.parse(r.out);
  const named = { ...REGISTER, label: "Customer deployments register" };
  const b = renderDeploymentBriefing(relabelled, RECORD_AREAS, named) ?? "";
  assert.ok(b.includes("**Customer deployments register**"), b);
});
await check("the roster tools name the hub in its words: today's by default, the profile's when renamed", () => {
  const src = readFileSync(join(ROOT, "agent/lib/roster-tools.ts"), "utf8");
  assert.ok(src.includes("the ${hubAttributive(RECORD_HUB)} scope filters"));
  assert.ok(src.includes("so the ${RECORD_HUB.label} 'my reportees'"));
  assert.equal(hubAttributive(TODAY), "TODO");
  assert.equal(hubAttributive(REGISTER), "Obligations Register");
});

console.log(`test-record-hub: ${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
