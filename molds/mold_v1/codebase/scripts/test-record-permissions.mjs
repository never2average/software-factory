/**
 * WHO MAY WRITE A RECORD, AND THE METRICS AN AREA DECLARES, OFFLINE (agent/lib/record-permissions.ts,
 * agent/lib/record-metrics.ts; docs/DEPLOYMENT_PROFILE.md "records").
 *
 *   1. THE DEFAULT IS UNCHANGED. Under the default profile (and the live packs' profiles named by
 *      LIVE_PACK_PROFILES=<dir>[:<dir>], their deployments' delete rule aside) nothing is refused to anyone, a role
 *      or none, and the one validator answers exactly as it does without a role.
 *   2. EVERY ROLE RULE, for each area (scripts/fixtures/record-areas/examples/permissions.json over the filing,
 *      obligation and programme examples): create, update, delete for owner, admin, engineer, member and no role;
 *      "own row" (a member changes only their own); a field only some roles may set (on create and on change);
 *      a move alone; an archive is a delete; a change of nothing is allowed; the sentences.
 *   3. THE WRITE PATHS' ONE CHECK: prepareRecordWrite (routes, nested rows, tools) and prepareTaskWrite (task routes,
 *      tools) refuse with `forbidden` (the 403) and that sentence; a screen's pre-check may skip it.
 *   4. WHAT A SCREEN OFFERS is what the server allows: recordAccess() against the refusals, every role, every row.
 *   5. THE METRICS compile to one SELECT of FILTERs over the list query's own conditions, bound values only, `{today}`
 *      as the day; a ratio counts its numerator inside its denominator; the live packs' metrics all compile.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-permissions.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const EX = join(ROOT, "scripts/fixtures/record-areas/examples");
let passed = 0;
let failed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${what}\n${e.message}`);
  }
};
const NODE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
/** The compiled areas of the default profile plus `extra` ([name, path]); never writes files. */
function areasOf(extra) {
  const dir = mkdtempSync(join(tmpdir(), "record-permissions-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) cpSync(src, join(dir, name));
    const r = spawnSync(process.execPath, [...NODE, join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** The generator's refusal of the default profile plus `doc`, or "" when it compiles. */
function refusalOf(doc) {
  const dir = mkdtempSync(join(tmpdir(), "record-permissions-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    cpSync(join(EX, "programme.json"), join(dir, "50-a.json"));
    writeFileSync(join(dir, "60-x.json"), JSON.stringify(doc));
    const r = spawnSync(process.execPath, [...NODE, join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? "" : r.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const P = await import("../agent/lib/record-permissions.ts");
const { prepareRecordWrite } = await import("../agent/lib/record-area-write.ts");
const { prepareTaskWrite } = await import("../agent/lib/task-area.ts");
const { areaView } = await import("../agent/lib/record-areas.ts");
const { RECORD_AREAS } = await import("../agent/lib/record-areas.generated.ts");

const ROLES = ["owner", "admin", "engineer", "member", undefined];
const AREAS = ["deployments", "implementations", "tasks", "periods"];
const ME = "maya@example.test";
const OTHER = "omar@example.test";

// --- 1. the default ---------------------------------------------------------------------------------------------------
console.log("1. The default: nothing declared, nothing refused, the validator's answer unchanged");
const defaults = [["default (this checkout)", RECORD_AREAS]];
for (const dir of (process.env.LIVE_PACK_PROFILES ?? "").split(":").filter(Boolean)) {
  defaults.push([`live ${dir}`, areasOf(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, join(dir, f)]))]);
}
for (const [label, areas] of defaults) {
  const live = label.startsWith("live");
  await check(`${label}: ${live ? "only deployments declare" : "no area declares"} who may write, so nothing is asked`, () => {
    for (const id of AREAS) if (!(live && id === "deployments")) assert.equal(P.permissionsDeclared(id, areas), false, id);
    if (live) assert.equal(P.permissionsDeclared("deployments", areas), true, "the live packs limit deleting a deployment");
  });
  await check(`${label}: every role, and none, may create, change, move and delete ${live ? "(but a deployment's delete and reviewer)" : ""}`, () => {
    for (const id of AREAS) {
      if (live && id === "deployments") continue;
      const v = areaView(id, areas);
      const keys = v.visibleFields.filter((f) => !f.computed).map((f) => f.key);
      for (const role of ROLES) {
        const who = { role, actor: ME };
        assert.equal(P.createRefusal(id, who, Object.fromEntries(keys.map((k) => [k, "x"])), areas), null, `${id} create ${role}`);
        assert.equal(P.updateRefusal(id, Object.fromEntries(keys.map((k) => [k, "x"])), { custom: {} }, who, areas), null, `${id} update ${role}`);
        assert.equal(P.updateRefusal(id, { archived: true }, { custom: {} }, who, areas), null, `${id} archive ${role}`);
        assert.equal(P.deleteRefusal(id, { custom: {} }, who, areas), null, `${id} delete ${role}`);
        const a = P.recordAccess(id, who, areas);
        assert.ok(a.create && a.update(null) && a.transition({}) && a.delete({}) && keys.every((k) => a.field(k, {}) && a.field(k, null)), `${id} access ${role}`);
      }
    }
  });
}
await check("default: the validator answers a write with no role exactly as with each role (the write paths' result is unchanged)", () => {
  const strip = (r) => JSON.stringify(r);
  const dep = { deploymentId: "d-1", environment: "prod", region: "us-east-1", deployedVersion: "1.0.0" };
  for (const role of ROLES) {
    assert.equal(strip(prepareRecordWrite("deployments", "create", dep, { actor: ME, role })), strip(prepareRecordWrite("deployments", "create", dep, { actor: ME })));
    assert.equal(strip(prepareRecordWrite("implementations", "update", { implementationRiskLevel: "Red" }, { actor: ME, role, before: { custom: {} } })), strip(prepareRecordWrite("implementations", "update", { implementationRiskLevel: "Red" }, { actor: ME, before: { custom: {} } })));
    assert.equal(strip(prepareTaskWrite("update", { title: "x", archived: true }, { actor: ME, role, before: { custom: {} } })), strip(prepareTaskWrite("update", { title: "x", archived: true }, { actor: ME })));
  }
});

// --- 2. every role rule -------------------------------------------------------------------------------------------------
console.log("\n2. Every role rule (permissions.json over the filing, obligation and programme examples)");
const A = areasOf([["50-a.json", join(EX, "compliance.json")], ["51-b.json", join(EX, "obligation.json")], ["52-c.json", join(EX, "programme.json")], ["60-p.json", join(EX, "permissions.json")]]);
const allowed = (r) => r === null;
const may = (roles) => (role) => role !== undefined && roles.includes(role);
const each = (fn) => { for (const role of ROLES) fn(role); };
const nounOf = (id) => areaView(id, A).noun;
const an = (n) => (/^[aeiou]/i.test(n) ? `an ${n}` : `a ${n}`);

await check("the compiled areas are golden/permissions.areas.json (what /preview/record-areas?profile=permissions shows)", () => {
  const golden = join(ROOT, "scripts/fixtures/record-areas/golden/permissions.areas.json");
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, `${JSON.stringify(A, null, 1)}\n`);
  assert.deepEqual(A, JSON.parse(readFileSync(golden, "utf8")));
});
await check("all four areas say who may write here", () => {
  for (const id of AREAS) assert.equal(P.permissionsDeclared(id, A), true, id);
});

// deployments: the live packs' rule. Anyone creates and changes; an owner or an admin deletes and sets the reviewer.
const filing = { deploymentId: "F-1", releaseStatus: "in-progress", deployOwnerEmail: OTHER, approvedByEmail: null, custom: {} };
await check("deployments: anyone in the workspace creates and changes one; with no role too (\"*\")", () => {
  each((role) => {
    assert.equal(P.createRefusal("deployments", { role, actor: ME }, { runtime: "Periodic return" }, A), null, String(role));
    assert.equal(P.updateRefusal("deployments", { notes: "late" }, filing, { role, actor: ME }, A), null, String(role));
  });
});
await check("deployments: only an owner or an admin deletes one (an engineer, a member and no role are refused)", () => {
  each((role) => assert.equal(allowed(P.deleteRefusal("deployments", filing, { role, actor: ME }, A)), may(["owner", "admin"])(role), String(role)));
  assert.equal(P.deleteRefusal("deployments", filing, { role: "member", actor: ME }, A), `Only an owner or an admin can delete ${an(nounOf("deployments"))}.`);
});
await check("deployments: only an owner or an admin changes the reviewer, on a change and on a create, by its key or its alias", () => {
  each((role) => {
    const ok = may(["owner", "admin"])(role);
    assert.equal(allowed(P.updateRefusal("deployments", { approvedByEmail: ME }, filing, { role, actor: ME }, A)), ok, `update ${role}`);
    assert.equal(allowed(P.updateRefusal("deployments", { signed_off_by: ME }, filing, { role, actor: ME }, A)), ok, `alias ${role}`);
    assert.equal(allowed(P.createRefusal("deployments", { role, actor: ME }, { approvedByEmail: ME }, A)), ok, `create ${role}`);
  });
  const label = areaView("deployments", A).label("approvedByEmail");
  assert.equal(P.updateRefusal("deployments", { approvedByEmail: ME }, filing, { role: "member", actor: ME }, A), `Only an owner or an admin can change "${label}" on ${an(nounOf("deployments"))}.`);
  // A create that leaves it out, or a change that keeps it as it is, asks nothing.
  assert.equal(P.createRefusal("deployments", { role: "member", actor: ME }, { approvedByEmail: "" }, A), null);
  assert.equal(P.updateRefusal("deployments", { approvedByEmail: OTHER, notes: "x" }, { ...filing, approvedByEmail: OTHER }, { role: "member", actor: ME }, A), null);
});

// implementations: own row. An owner or an admin changes any; a member or an engineer only their own.
const mine = { customerId: "acme", implementationOwnerEmail: ME, implementationStage: "Kickoff", implementationRiskLevel: "Green", custom: {} };
const theirs = { ...mine, implementationOwnerEmail: OTHER };
await check("implementations: an owner, an admin or an engineer creates one; a member and no role are refused", () => {
  each((role) => assert.equal(allowed(P.createRefusal("implementations", { role, actor: ME }, { rolloutId: "R-1" }, A)), may(["owner", "admin", "engineer"])(role), String(role)));
  assert.equal(P.createRefusal("implementations", { role: "member", actor: ME }, {}, A), `Only an owner, an admin or an engineer can add ${an(nounOf("implementations"))}.`);
});
await check("implementations, own row: a member (or an engineer) changes only the ones they own; an owner or an admin any", () => {
  each((role) => {
    const boss = may(["owner", "admin"])(role);
    assert.equal(allowed(P.updateRefusal("implementations", { blocker: "vendor" }, theirs, { role, actor: ME }, A)), boss, `theirs ${role}`);
    assert.equal(allowed(P.updateRefusal("implementations", { blocker: "vendor" }, mine, { role, actor: ME }, A)), true, `mine ${role}`);
    assert.equal(allowed(P.updateRefusal("implementations", { implementationStage: "Discovery" }, mine, { role, actor: ME }, A)), true, `move mine ${role}`);
  });
  // The own field is compared without regard to case or spaces; another person's email is not theirs.
  assert.equal(P.updateRefusal("implementations", { blocker: "x" }, { ...mine, implementationOwnerEmail: ` ${ME.toUpperCase()} ` }, { role: "member", actor: ME }, A), null);
  const ownLabel = areaView("implementations", A).label("implementationOwnerEmail").toLowerCase();
  assert.equal(P.updateRefusal("implementations", { blocker: "x" }, theirs, { role: "member", actor: ME }, A), `You can change ${an(nounOf("implementations"))} only when you are its ${ownLabel}; an owner or an admin can change any.`);
});
await check("implementations: the risk is an owner's or an admin's to set, even on a member's own row", () => {
  each((role) => assert.equal(allowed(P.updateRefusal("implementations", { implementationRiskLevel: "Red" }, mine, { role, actor: ME }, A)), may(["owner", "admin"])(role), String(role)));
});
await check("implementations: a delete is an owner's or an admin's, own row or not (own lets a member change, not delete)", () => {
  each((role) => {
    assert.equal(allowed(P.deleteRefusal("implementations", mine, { role, actor: ME }, A)), may(["owner", "admin"])(role), `mine ${role}`);
    assert.equal(allowed(P.deleteRefusal("implementations", theirs, { role, actor: ME }, A)), may(["owner", "admin"])(role), `theirs ${role}`);
  });
});
await check("a change of nothing is allowed to anyone (nothing is written); no stored row means every named field changes", () => {
  assert.equal(P.updateRefusal("implementations", { blocker: "vendor" }, { ...theirs, blocker: "vendor" }, { role: "member", actor: ME }, A), null);
  assert.equal(P.updateRefusal("implementations", { customerId: "acme", actor: ME, reason: "x" }, theirs, { role: "member", actor: ME }, A), null);
  assert.notEqual(P.updateRefusal("implementations", { blocker: "vendor" }, null, { role: "member", actor: ME }, A), null);
});

// tasks: own row (the assignee), a field only an owner or an admin sets, an archive is a delete.
const task = (assignee) => ({ id: "t-1", title: "Return", assignee, custom: { state: "not_started", reviewer: null } });
await check("tasks, own row: a member changes and moves only the tasks assigned to them; an owner or an admin any", () => {
  each((role) => {
    const boss = may(["owner", "admin"])(role);
    assert.equal(allowed(P.updateRefusal("tasks", { title: "Return (late)" }, task(OTHER), { role, actor: ME }, A)), boss, `theirs ${role}`);
    assert.equal(allowed(P.updateRefusal("tasks", { title: "Return (late)" }, task(ME), { role, actor: ME }, A)), true, `mine ${role}`);
    assert.equal(allowed(P.updateRefusal("tasks", { custom: { state: "in_progress" } }, task(OTHER), { role, actor: ME }, A)), boss, `move theirs ${role}`);
    assert.equal(allowed(P.updateRefusal("tasks", { custom: { state: "in_progress" } }, task(ME), { role, actor: ME }, A)), true, `move mine ${role}`);
  });
});
await check("tasks: only an owner or an admin sets the reviewer, even on their own task", () => {
  each((role) => assert.equal(allowed(P.updateRefusal("tasks", { custom: { reviewer: OTHER } }, task(ME), { role, actor: ME }, A)), may(["owner", "admin"])(role), String(role)));
});
await check("tasks: an archive (hide) is a delete, an owner's or an admin's", () => {
  each((role) => assert.equal(allowed(P.updateRefusal("tasks", { archived: true }, task(ME), { role, actor: ME }, A)), may(["owner", "admin"])(role), String(role)));
  assert.equal(P.updateRefusal("tasks", { archived: true }, task(ME), { role: "member", actor: ME }, A), `Only an owner or an admin can delete ${an(nounOf("tasks"))}.`);
});
await check("own may [\"transition\"] alone: a member moves their own task, and nothing more", () => {
  const T = structuredClone(A);
  T.tasks.permissions.own.may = ["transition"];
  assert.equal(P.updateRefusal("tasks", { custom: { state: "in_progress" } }, task(ME), { role: "member", actor: ME }, T), null);
  assert.notEqual(P.updateRefusal("tasks", { title: "Renamed" }, task(ME), { role: "member", actor: ME }, T), null);
  assert.notEqual(P.updateRefusal("tasks", { custom: { state: "in_progress" } }, task(OTHER), { role: "member", actor: ME }, T), null);
  // On a task whose lifecycle is the status column, done and a pipeline stage are moves too.
  const S = structuredClone(T);
  S.tasks.lifecycle = { ...RECORD_AREAS.tasks.lifecycle };
  for (const body of [{ done: true }, { stageId: "s-2" }, { status: "in_progress" }]) assert.equal(P.updateRefusal("tasks", body, { assignee: ME, status: "open", done: false, custom: {} }, { role: "member", actor: ME }, S), null, JSON.stringify(body));
});

// periods: roles only.
const period = { id: "p-1", name: "Week 1", state: "planning", custom: {} };
await check("periods: an owner or an admin opens one; an owner, an admin or an engineer changes or rolls it over; an owner deletes", () => {
  each((role) => {
    assert.equal(allowed(P.createRefusal("periods", { role, actor: ME }, { name: "Week 2" }, A)), may(["owner", "admin"])(role), `create ${role}`);
    assert.equal(allowed(P.updateRefusal("periods", { name: "Week 1b" }, period, { role, actor: ME }, A)), may(["owner", "admin", "engineer"])(role), `update ${role}`);
    assert.equal(allowed(P.updateRefusal("periods", {}, period, { role, actor: ME }, A, true)), may(["owner", "admin", "engineer"])(role), `rollover ${role}`);
    assert.equal(allowed(P.deleteRefusal("periods", period, { role, actor: ME }, A)), may(["owner"])(role), `delete ${role}`);
  });
});
await check("the generator refuses a read rule other than \"*\" (it is not enforced, so it may not look like it is)", () => {
  const err = refusalOf({ records: { areas: { implementations: { permissions: { read: ["owner"] } } } } });
  assert.match(err, /permissions\.read/);
  assert.match(err, /not enforced yet/);
  assert.equal(refusalOf({ records: { areas: { implementations: { permissions: { read: "*", delete: ["owner"] } } } } }), "");
});

// --- 3. the write paths' one check ----------------------------------------------------------------------------------
console.log("\n3. The write paths' one check: forbidden, with the sentence");
await check("prepareRecordWrite (ops routes, upsert_customer's rows, the per-area tools) refuses with forbidden and writes nothing", () => {
  const r = prepareRecordWrite("implementations", "update", { blocker: "vendor" }, { actor: ME, role: "member", before: theirs }, A);
  assert.equal(r.ok, false);
  assert.equal(r.forbidden, true);
  assert.deepEqual(r.errors, [P.updateRefusal("implementations", { blocker: "vendor" }, theirs, { role: "member", actor: ME }, A)]);
  const own = prepareRecordWrite("implementations", "update", { blocker: "vendor" }, { actor: ME, role: "member", before: mine }, A);
  assert.equal(own.ok, true, JSON.stringify(own));
  const create = prepareRecordWrite("implementations", "create", { rolloutId: "R-9" }, { actor: ME, role: "member" }, A);
  assert.equal(create.ok === false && create.forbidden, true);
  const noRole = prepareRecordWrite("deployments", "create", { deploymentId: "F-2", runtime: "Periodic return", deployedVersion: "Q2", approvedByEmail: ME }, { actor: ME }, A);
  assert.equal(noRole.ok === false && noRole.forbidden, true, "no role fails closed");
});
await check("a screen's pre-check may skip who-may (checkPermissions: false); every other answer is the same", () => {
  const r = prepareRecordWrite("implementations", "create", { rolloutId: "R-9" }, { actor: ME, checkPermissions: false }, A);
  assert.equal(r.ok, true, JSON.stringify(r));
});
await check("prepareTaskWrite (task routes, upsert_todo) refuses with forbidden: another's task, the reviewer, an archive", () => {
  for (const [body, before] of [[{ title: "x" }, task(OTHER)], [{ custom: { reviewer: OTHER } }, task(ME)], [{ archived: true }, task(ME)]]) {
    const r = prepareTaskWrite("update", body, { actor: ME, role: "member", before }, A);
    assert.equal(r.ok === false && r.forbidden, true, JSON.stringify(body));
  }
  const ok = prepareTaskWrite("update", { title: "x" }, { actor: ME, role: "member", before: task(ME) }, A);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const admin = prepareTaskWrite("update", { archived: true }, { actor: ME, role: "admin", before: task(OTHER) }, A);
  assert.equal(admin.ok, true, JSON.stringify(admin));
});

// --- 4. what a screen offers --------------------------------------------------------------------------------------------
console.log("\n4. What a screen offers is what the server allows");
await check("recordAccess() agrees with the refusals for every area, role, row and field", () => {
  const rows = { deployments: [filing, { ...filing, deployOwnerEmail: ME }], implementations: [mine, theirs], tasks: [task(ME), task(OTHER)], periods: [period] };
  for (const id of AREAS) {
    const v = areaView(id, A);
    for (const role of ROLES) {
      const who = { role, actor: ME };
      const a = P.recordAccess(id, who, A);
      assert.equal(a.create, allowed(P.createRefusal(id, who, {}, A)), `${id} create ${role}`);
      for (const row of rows[id]) {
        assert.equal(a.delete(row), allowed(P.deleteRefusal(id, row, who, A)), `${id} delete ${role}`);
        for (const f of v.visibleFields.filter((x) => !x.computed)) {
          const body = f.column ? { [f.key]: `new-${f.key}` } : { custom: { [f.key]: `new-${f.key}` } };
          assert.equal(a.field(f.key, row), allowed(P.updateRefusal(id, body, row, who, A)), `${id}.${f.key} ${role} ${JSON.stringify(row).slice(0, 60)}`);
          assert.equal(a.field(f.key, null), allowed(P.createRefusal(id, who, body, A)), `${id}.${f.key} create ${role}`);
        }
      }
    }
  }
});

// --- 5. the metrics ---------------------------------------------------------------------------------------------------
console.log("\n5. The metrics: counted by the list query's conditions, in one SELECT");
const M = await import("../agent/lib/record-metrics.ts");
const { deployments, implementation } = await import("../agent/lib/db/schema.ts");
const { PgDialect } = await import("drizzle-orm/pg-core");
const dialect = new PgDialect();
const TABLE = { deployments, implementations: implementation };
const now = new Date("2026-10-14T08:00:00Z");
await check("{today} and {today±Nd} are the day the metric is counted", () => {
  assert.deepEqual(M.resolveToday({ a: { lt: "{today}" }, b: ["{today+7d}", "{today-1d}"], c: "x" }, now), { a: { lt: "2026-10-14" }, b: ["2026-10-21", "2026-10-13"], c: "x" });
});
await check("the programme's four metrics: a count, a count with {today} and categories, a ratio, a sum; bound values, the workspace named", () => {
  const { select, errors } = M.compileMetrics("implementations", implementation, "org-a", A, now);
  assert.equal(errors.size, 0, [...errors.values()].join(" "));
  assert.deepEqual(Object.keys(select).sort(), ["d2", "m0", "m1", "m2", "m3"]);
  const q = (k) => dialect.sqlToQuery(select[k]);
  assert.match(q("m0").sql, /^\(count\(\*\) filter \(where .*"org_id" = \$1.*\)\)::int$/);
  assert.ok(q("m0").params.includes("org-a") && q("m0").params.includes("Red"), JSON.stringify(q("m0").params));
  assert.ok(q("m1").params.includes("2026-10-14") && !q("m1").sql.includes("2026"), q("m1").sql);
  assert.match(q("m3").sql, /^coalesce\(sum\(.*\) filter \(where .*\), 0\)::float8$/);
  // The ratio's numerator is counted inside its denominator.
  const den = q("d2").sql.replace(/^\(count\(\*\) filter \(where (.*)\)\)::int$/, "$1");
  assert.ok(q("m2").sql.startsWith(`(count(*) filter (where ${den} and `), q("m2").sql);
});
await check("a ratio reads as a percent of its denominator (0 when there is none); attention only when flagged and not zero", () => {
  const ms = M.metricsFrom("implementations", { m0: 2, m1: 0, m2: 1, d2: 4, m3: 150.5 }, new Map(), A);
  assert.deepEqual(ms.map((m) => [m.id, m.value, m.text, m.attention]), [["at-risk", 2, "2", true], ["past-deadline", 0, "0", false], ["live-rate", 25, "25%", false], ["progress", 150.5, "150.5", false]]);
  assert.equal(M.metricsFrom("implementations", { m0: 0, m1: 0, m2: 0, d2: 0, m3: 0 }, new Map(), A)[2].text, "0%");
});
await check("the filing's metrics compile, a computed field (timeliness) as its CASE; the coverage report's too", () => {
  for (const [id, areas] of [["deployments", A], ["deployments", areasOf([["50-a.json", join(EX, "research.json")]])]]) {
    const { select, errors } = M.compileMetrics(id, TABLE[id], "org-a", areas, now);
    assert.equal(errors.size, 0, [...errors.values()].join(" "));
    assert.equal(Object.keys(select).filter((k) => k.startsWith("m")).length, areas[id].metrics.length);
  }
  const t = dialect.sqlToQuery(M.compileMetrics("deployments", deployments, "org-a", A, now).select.m0);
  assert.match(t.sql, /case when/);
});
await check("a metric whose condition cannot be counted says why and shows a dash; the others still count", () => {
  const B = structuredClone(A);
  B.implementations.metrics = [{ id: "bad", label: "Bad", count: { where: { nope: "x" } } }, ...A.implementations.metrics.slice(0, 1)];
  const { select, errors } = M.compileMetrics("implementations", implementation, "org-a", B, now);
  assert.equal(errors.size, 1);
  assert.ok("m1" in select && !("m0" in select));
  const [bad, ok] = M.metricsFrom("implementations", { m1: 3 }, errors, B);
  assert.equal(bad.value, null);
  assert.equal(bad.text, "—");
  assert.match(bad.error, /no field "nope"/);
  assert.equal(ok.value, 3);
});
await check("an area that declares no metrics has none, and nothing is compiled (the default)", () => {
  for (const id of ["deployments", "implementations"]) {
    assert.deepEqual(RECORD_AREAS[id].metrics ?? [], []);
    assert.deepEqual(Object.keys(M.compileMetrics(id, TABLE[id], "org-a", RECORD_AREAS, now).select), []);
  }
});
for (const dir of (process.env.LIVE_PACK_PROFILES ?? "").split(":").filter(Boolean)) {
  await check(`live ${dir}: every declared metric of deployments and implementations compiles`, () => {
    const L = areasOf(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, join(dir, f)]));
    for (const id of ["deployments", "implementations"]) {
      const { errors } = M.compileMetrics(id, TABLE[id], "org-a", L, now);
      assert.equal(errors.size, 0, `${id}: ${[...errors.values()].join(" ")}`);
    }
  });
}

console.log(`\ntest-record-permissions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
