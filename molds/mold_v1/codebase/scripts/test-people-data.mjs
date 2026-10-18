#!/usr/bin/env node
/**
 * PEOPLE DATA, OFFLINE (agent/lib/people-catalogue.ts, agent/lib/people-directory.ts, scripts/lib/people-profile.mjs):
 *
 *   0. the profile's `people` section is checked at build: the default and a declared catalogue
 *      (scripts/fixtures/people/50-people.json) build; a reserved key, a type the engine does not have, options on a
 *      boolean, a key declared twice and an unknown key are refused with a sentence;
 *   1. the default (this checkout): no department and no attribute declared, so nothing is offered and every value is
 *      refused; the reporting-line rules hold anyway (someone of the same workspace, never themselves, no loop);
 *   2. the declared catalogue, in a copy: departments and each of the four attribute types checked and merged per key;
 *      who reads a person's attributes; the identity snapshot the workflow engine's directory is seeded from, built
 *      from one workspace's rows and never carrying another's. When the engine library is in the tree
 *      (agent/lib/workflow-engine/, or WORKFLOW_ENGINE_TREE=<a checkout that has it>), the snapshot is validated by the
 *      engine's own validateIdentitySnapshot and seeded into its Directory and Rbac; otherwise that part says it is
 *      skipped.
 *
 *   npm run test:people-data
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const INNER = process.argv.includes("--inner");
let passed = 0;
let failed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${what}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${what} — ${e instanceof Error ? e.message : String(e)}`.slice(0, 1500));
  }
};

if (!INNER) {
  const { peopleProblem } = await import(pathToFileURL(join(ROOT, "scripts/lib/people-profile.mjs")).href);
  const { readFileSync } = await import("node:fs");
  const def = JSON.parse(readFileSync(join(ROOT, "profiles/00-default.json"), "utf8")).people;
  const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/people/50-people.json"), "utf8")).people;
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "$comment" ? undefined : v)));
  console.log("0. The profile's people section, checked at build");
  await check("the default's people section is valid and declares nothing", () => {
    assert.equal(peopleProblem(strip(def)), null);
    assert.deepEqual([def.departments, def.attributes], [[], []]);
  });
  await check("the declared fixture is valid", () => assert.equal(peopleProblem({ ...strip(def), ...fixture }), null));
  const bad = (patch) => peopleProblem({ ...strip(def), ...fixture, ...patch });
  await check("a reserved key (a field the directory sends anyway) is refused", () => {
    for (const key of ["department", "email", "role", "reporting_managers", "employment_status_active", "office_ids"]) {
      assert.match(bad({ attributes: [{ key, label: "X", type: "text" }] }) ?? "", /already carries/, key);
    }
  });
  await check("a type the engine does not have, options on a boolean, a choice with none: refused", () => {
    assert.match(bad({ attributes: [{ key: "x", label: "X", type: "number" }] }) ?? "", /is not a type/);
    assert.match(bad({ attributes: [{ key: "x", label: "X", type: "boolean", options: [{ value: "a", label: "A" }] }] }) ?? "", /takes no options/);
    assert.match(bad({ attributes: [{ key: "x", label: "X", type: "choice" }] }) ?? "", /needs 1 to 100 options/);
  });
  await check("a key declared twice, an unknown key, a bad department key: refused", () => {
    assert.match(bad({ departments: [{ key: "a", label: "A" }, { key: "a", label: "B" }] }) ?? "", /declared twice/);
    assert.match(bad({ colour: "red" }) ?? "", /unknown key/);
    assert.match(bad({ departments: [{ key: "Has Space", label: "A" }] }) ?? "", /lower-case/);
  });
  await check("the generator refuses a bad people section and names it", () => {
    const dir = mkdtempSync(join(tmpdir(), "people-profile-"));
    try {
      cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
      writeFileSync(join(dir, "50-bad.json"), JSON.stringify({ people: { attributes: [{ key: "role", label: "Role", type: "text" }] } }));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--check"], { encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir } });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /people\.attributes\[0\]\.key: "role" is a field every person already carries/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const runInner = (label, cwd) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(cwd, "scripts/test-people-data.mjs"), "--inner"], { cwd, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const out = `${r.stdout}${r.stderr}`;
    for (const l of out.split("\n").filter((l) => /^\s+(ok|FAIL|skip) /.test(l))) console.log(l);
    passed += (out.match(/^\s+ok /gm) ?? []).length;
    failed += (out.match(/^\s+FAIL /gm) ?? []).length;
    if (r.status !== 0 && !/^\s+FAIL /m.test(out)) {
      failed++;
      console.log(`  FAIL ${label}: did not finish — ${out.slice(-1500)}`);
    }
  };
  console.log("\n1. The default (this checkout)");
  runInner("default", ROOT);
  console.log("\n2. A declared catalogue (scripts/fixtures/people/50-people.json), in a copy");
  const { copyWithProfiles } = await import(pathToFileURL(join(ROOT, "scripts/lib/profile-copy.mjs")).href);
  const copy = copyWithProfiles(ROOT, [["50-people.json", join(ROOT, "scripts/fixtures/people/50-people.json")]]);
  try {
    runInner("declared", copy.dir);
  } finally {
    copy.remove();
  }
  console.log(`\ntest-people-data: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ---- inner: one build's profile ---------------------------------------------------------------------------- */
const here = process.cwd();
const imp = (p) => import(pathToFileURL(join(here, p)).href);
const cat = await imp("agent/lib/people-catalogue.ts");
const dir = await imp("agent/lib/people-directory.ts");
const { PEOPLE } = cat;
const DECLARED = PEOPLE.hasDepartments;
const tag = DECLARED ? "[declared]" : "[default]";

await check(`${tag} reporting lines: someone of the same workspace, never themselves, no loop`, () => {
  const people = new Set(["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
  const lines = (pairs) => new Map(pairs);
  assert.equal(cat.reportingProblem(lines([["a@x.test", "b@x.test"]]), people, ["a@x.test"]), null);
  assert.match(cat.reportingProblem(lines([["a@x.test", "a@x.test"]]), people, ["a@x.test"]) ?? "", /cannot report to themselves/);
  assert.match(cat.reportingProblem(lines([["a@x.test", "out@other.test"]]), people, ["a@x.test"]) ?? "", /is not in this workspace/);
  assert.match(cat.reportingProblem(lines([["a@x.test", "b@x.test"], ["b@x.test", "a@x.test"]]), people, ["b@x.test"]) ?? "", /reporting loop: b@x\.test → a@x\.test → b@x\.test/);
  assert.match(cat.reportingProblem(lines([["a@x.test", "b@x.test"], ["b@x.test", "c@x.test"], ["c@x.test", "a@x.test"]]), people, ["c@x.test"]) ?? "", /reporting loop/);
  // A loop already stored elsewhere, not through the person changed, is not this write's to refuse.
  assert.equal(cat.reportingProblem(lines([["c@x.test", "d@x.test"], ["d@x.test", "c@x.test"], ["a@x.test", "c@x.test"]]), people, ["a@x.test"]), null);
  // Clearing a line is always fine; letters compare case-insensitively.
  assert.equal(cat.reportingProblem(lines([["a@x.test", null]]), people, ["A@X.test"]), null);
  assert.match(cat.reportingProblem(lines([["a@x.test", "A@X.TEST"]]), people, ["a@x.test"]) ?? "", /themselves/);
});
await check(`${tag} an archived person's stored line still closes a loop (the check is given every stored line)`, () => {
  // arc is archived from the roster but still signed in (so one of the workspace's people), with arc → y stored.
  const people = new Set(["arc@x.test", "y@x.test"]);
  assert.match(cat.reportingProblem(new Map([["arc@x.test", "y@x.test"], ["y@x.test", "arc@x.test"]]), people, ["y@x.test"]) ?? "", /reporting loop: y@x\.test → arc@x\.test → y@x\.test/);
});
await check(`${tag} only the workspace's owner and admins set people data`, () => {
  assert.deepEqual(["owner", "admin", "engineer", "member", null, "x"].map(cat.canSetPeopleData), [true, true, false, false, false, false]);
});
await check(`${tag} attributes are read by the person and the workspace's owner and admins, nobody else`, () => {
  const row = { email: "a@x.test", attributes: DECLARED ? { grade: "g1" } : {} };
  assert.ok(cat.visibleAttributes(row, { email: "A@x.test", role: "member" }));
  assert.ok(cat.visibleAttributes(row, { email: "o@x.test", role: "owner" }));
  assert.ok(cat.visibleAttributes(row, { email: "o@x.test", role: "admin" }));
  assert.equal(cat.visibleAttributes(row, { email: "b@x.test", role: "member" }), undefined);
  assert.equal(cat.visibleAttributes(row, { email: "b@x.test", role: "engineer" }), undefined);
  assert.equal(cat.visibleAttributes(row, { email: null, role: "member" }), undefined);
});

if (!DECLARED) {
  await check("[default] nothing is declared: no department, no attribute, the default words", () => {
    assert.equal(PEOPLE.hasDepartments, false);
    assert.equal(PEOPLE.hasAttributes, false);
    assert.equal(PEOPLE.supervisorLabel, "Reports to");
    assert.deepEqual(PEOPLE.department, { singular: "department", plural: "departments" });
  });
  await check("[default] a department or an attribute is refused with a sentence; clearing is allowed", () => {
    assert.match(cat.checkDepartments(["ops"]).error ?? "", /declares no departments/);
    assert.deepEqual(cat.checkDepartments([]), { value: [] });
    assert.match(cat.checkAttributes({ grade: "g1" }).error ?? "", /"grade" is not an attribute here\.$/);
  });
  await check("[default] the identity snapshot still carries people, roles and reporting lines", () => {
    const s = dir.identitySnapshot("org-a", [{ orgId: "org-a", email: "A@x.test", managerEmail: "b@x.test", departments: ["ops"], attributes: { grade: "g1" } }], [{ orgId: "org-a", email: "b@x.test", role: "owner" }]);
    assert.deepEqual(s.users.map((u) => [u.id, u.role, u.departments ?? null, u.grade ?? null]), [["a@x.test", "member", [], null], ["b@x.test", "owner", null, null]]);
    assert.deepEqual(s.reporting, [{ reporting_manager: "b@x.test", reportee: "a@x.test" }]);
  });
} else {
  await check("[declared] the catalogue and its words come from the profile", () => {
    assert.equal(PEOPLE.supervisorLabel, "Supervisor");
    assert.deepEqual(PEOPLE.department, { singular: "desk", plural: "desks" });
    assert.deepEqual(PEOPLE.departments.map((d) => d.key), ["north", "south"]);
    assert.equal(cat.departmentLabel("south"), "South desk");
    assert.equal(cat.departmentLabel("gone"), "gone");
  });
  await check("[declared] departments: declared keys only, deduplicated, in the profile's order, [] clears", () => {
    assert.deepEqual(cat.checkDepartments(["south", "north", "south"]), { value: ["north", "south"] });
    assert.deepEqual(cat.checkDepartments([]), { value: [] });
    assert.match(cat.checkDepartments(["east"]).error ?? "", /Not a desk here: east\. Choose from north, south\./);
    assert.match(cat.checkDepartments("north").error ?? "", /Desks must be a list/);
    assert.deepEqual(cat.declaredDepartments(["south", "gone", 3, "north"]), ["north", "south"]);
  });
  await check("[declared] each of the four attribute types: a value of its type, anything else refused", () => {
    assert.deepEqual(cat.checkAttributes({ grade: "g2", languages: ["hi", "en", "hi"], on_call: false, desk_phone: "  101  " }), { set: { grade: "g2", languages: ["hi", "en"], on_call: false, desk_phone: "101" }, clear: [] });
    assert.match(cat.checkAttributes({ grade: "g3" }).error ?? "", /Grade is one of g1, g2/);
    assert.match(cat.checkAttributes({ languages: ["fr"] }).error ?? "", /Languages is a list of en, hi/);
    assert.match(cat.checkAttributes({ on_call: "yes" }).error ?? "", /On call is yes or no/);
    assert.match(cat.checkAttributes({ desk_phone: 101 }).error ?? "", /Desk phone is text/);
    assert.match(cat.checkAttributes({ desk_phone: "x".repeat(501) }).error ?? "", /at most 500/);
    assert.match(cat.checkAttributes({ desk_phone: "a\nb" }).error ?? "", /one line/);
    assert.match(cat.checkAttributes({ salary: 1 }).error ?? "", /"salary" is not an attribute here\. Known: grade, languages, on_call, desk_phone\./);
    assert.match(cat.checkAttributes(["grade"]).error ?? "", /must be an object/);
  });
  await check("[declared] attributes merge per key: null, \"\" and [] clear; keys a patch does not name are kept", () => {
    const patch = cat.checkAttributes({ grade: null, on_call: true, languages: [] });
    assert.deepEqual(patch, { set: { on_call: true }, clear: ["grade", "languages"] });
    assert.deepEqual(cat.mergeAttributes({ grade: "g1", languages: ["en"], desk_phone: "7", stale: 1 }, patch), { desk_phone: "7", stale: 1, on_call: true });
    // A reader is given only declared keys holding a value of their type.
    assert.deepEqual(cat.declaredAttributes({ desk_phone: "7", stale: 1, grade: "g9", on_call: true }), { on_call: true, desk_phone: "7" });
  });
  await check("[declared] the identity snapshot: one workspace's people, their departments, attributes, roles and lines", () => {
    const roster = [
      { orgId: "org-a", email: "Ana@a.test", name: "Ana", managerEmail: "cat@a.test", departments: ["south", "north"], attributes: { grade: "g1", languages: ["en"], on_call: true, desk_phone: "7", stale: "x" } },
      { orgId: "org-a", email: "cat@a.test", name: "Cat", managerEmail: null, departments: [], attributes: {} },
      { orgId: "org-a", email: "gone@a.test", managerEmail: "cat@a.test", archivedAt: new Date() },
      // Archived from the roster but still signed in, with a stored line; and a live person whose line points at them.
      { orgId: "org-a", email: "left@a.test", managerEmail: "cat@a.test", departments: ["north"], attributes: { grade: "g1" }, archivedAt: "2026-10-01T00:00:00Z" },
      { orgId: "org-a", email: "eve@a.test", managerEmail: "left@a.test" },
      { orgId: "org-a", email: "out@a.test", managerEmail: "ben@b.test" },
      { orgId: "org-b", email: "ben@b.test", departments: ["north"], attributes: { grade: "g2" } },
    ];
    const members = [{ orgId: "org-a", email: "cat@a.test", role: "owner" }, { orgId: "org-a", email: "dev@a.test", role: "engineer" }, { orgId: "org-a", email: "left@a.test", role: "member" }, { orgId: "org-b", email: "ben@b.test", role: "owner" }];
    const s = dir.identitySnapshot("org-a", roster, members);
    assert.equal(s.organization_id, "org-a");
    assert.deepEqual(s.users.map((u) => u.id), ["ana@a.test", "cat@a.test", "dev@a.test", "eve@a.test", "left@a.test", "out@a.test"]);
    assert.ok(s.users.every((u) => u.organization_id === "org-a"), "every user is org-a's");
    assert.ok(!JSON.stringify(s).includes("ben@b.test"), "nothing of workspace B");
    const ana = s.users.find((u) => u.id === "ana@a.test");
    assert.deepEqual(ana, { grade: "g1", languages: ["en"], on_call: true, desk_phone: "7", id: "ana@a.test", organization_id: "org-a", email: "ana@a.test", role: "member", employment_status_active: true, departments: ["north", "south"], name: "Ana", department: "north", reporting_managers: ["cat@a.test"] });
    assert.equal(s.users.find((u) => u.id === "cat@a.test").role, "owner");
    assert.equal(s.users.find((u) => u.id === "dev@a.test").role, "engineer");
    // An archived roster row is not carried: not the person (unless signed in, then with their role only), not their
    // line, not a line to them, so the engine never routes to or walks through someone who left the roster.
    assert.ok(!s.users.some((u) => u.id === "gone@a.test"), "archived and not signed in: absent");
    assert.deepEqual(s.users.find((u) => u.id === "left@a.test"), { id: "left@a.test", organization_id: "org-a", email: "left@a.test", role: "member", employment_status_active: true });
    assert.equal(s.users.find((u) => u.id === "eve@a.test").reporting_managers, undefined, "a line to an archived person is not carried");
    assert.ok(s.users.every((u) => u.employment_status_active === true));
    assert.equal(s.users.find((u) => u.id === "out@a.test").reporting_managers, undefined, "a line out of the workspace is not carried");
    assert.deepEqual(s.reporting, [{ reporting_manager: "cat@a.test", reportee: "ana@a.test" }]);
    assert.deepEqual(s.roles.map((r) => r.name), ["owner", "admin", "engineer", "member"]);
    assert.deepEqual(dir.identitySnapshot("org-a", roster, members), s, "the same people give the same snapshot");
  });

  // The engine's own validator and directory, when the library is in the tree (or WORKFLOW_ENGINE_TREE names one).
  const engineRoot = [process.env.WORKFLOW_ENGINE_TREE, here].filter(Boolean).map((r) => join(r, "agent/lib/workflow-engine/engine/src")).find((p) => existsSync(join(p, "integrations/identity.ts")));
  if (!engineRoot) {
    console.log("  skip [declared] the engine's validateIdentitySnapshot, Directory and Rbac: the workflow engine library is not in this tree yet (docs/WORKFLOW_ENGINE.md, phase 1); the snapshot's shape is the engine's, copied in agent/lib/people-directory.ts");
  } else {
    await check("[declared] the engine accepts the snapshot (validateIdentitySnapshot), its Directory queries it and its Rbac walks the lines", async () => {
      const { validateIdentitySnapshot } = await import(pathToFileURL(join(engineRoot, "integrations/identity.ts")).href);
      const { Directory } = await import(pathToFileURL(join(engineRoot, "core/evaluator.ts")).href);
      const { Rbac } = await import(pathToFileURL(join(engineRoot, "core/rbac.ts")).href);
      const s = dir.identitySnapshot("org-a", [
        { orgId: "org-a", email: "ana@a.test", managerEmail: "cat@a.test", departments: ["north", "south"], attributes: { grade: "g1", on_call: true } },
        { orgId: "org-a", email: "cat@a.test", departments: ["north"] },
      ], [{ orgId: "org-a", email: "cat@a.test", role: "owner" }, { orgId: "org-a", email: "ana@a.test", role: "member" }]);
      const v = validateIdentitySnapshot(JSON.parse(JSON.stringify(s)));
      assert.deepEqual(v.issues, []);
      const d = new Directory();
      d.seed(v.snapshot.users, "org-a");
      assert.deepEqual(d.query({ department: "north" }, Infinity, "org-a").map((u) => u.id), ["ana@a.test", "cat@a.test"]);
      assert.deepEqual(d.query({ departments: "south" }, Infinity, "org-a").map((u) => u.id), ["ana@a.test"]);
      assert.deepEqual(d.query({ grade: "g1", role: "member" }, Infinity, "org-a").map((u) => u.id), ["ana@a.test"]);
      assert.deepEqual(d.query({ department: "north" }, Infinity, "org-b"), [], "another organisation finds nobody");
      const rbac = new Rbac();
      rbac.seedRoles(v.snapshot.roles, "org-a");
      rbac.seedReporting(v.snapshot.reporting, "org-a");
      assert.deepEqual(rbac.managers("ana@a.test", undefined, "org-a"), ["cat@a.test"]);
      assert.deepEqual(rbac.reportees("cat@a.test", undefined, "org-a"), ["ana@a.test"]);
      const step = { type: "instance", id: "i1", organization_id: "org-a", assignees: ["ana@a.test"] };
      const cat_ = v.snapshot.users.find((u) => u.id === "cat@a.test");
      const ana = v.snapshot.users.find((u) => u.id === "ana@a.test");
      assert.equal(rbac.canReassign(cat_, step), true, "the owner reassigns");
      assert.equal(rbac.canReassign(ana, step), false, "a member holding the step does not");
      assert.equal(rbac.can(ana, "act", step), true, "the holder acts on it");
    });
  }
}
console.log(`people-data inner ${tag}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
