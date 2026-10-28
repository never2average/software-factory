/**
 * THE LIFECYCLE WARNINGS REPORT, OFFLINE, on a fake database (agent/lib/lifecycle-warnings.ts;
 * scripts/operator/lifecycle-warnings.mjs).
 *
 * The activity lines are the real ones: the pipeline fixture (scripts/fixtures/record-lifecycle/pipeline.json) under
 * enforce "warn" is compiled as the build compiles it, a task write is checked by the real validator (prepareTaskWrite),
 * and the lines are the ones writeOutcome writes (outcomeEvents). The fake database holds them in memory, answers the
 * report's two statements, and refuses a write once its transaction is read-only, as Postgres does.
 *
 *   1. The lines: a warn line and a move line parse back to the rule, the states and the comment; other lines do not.
 *   2. The report: a seeded warned move is listed (time, workspace, record, from → to, rule, actor, comment) and counted
 *      by rule, area and actor; every lifecycle move in the window is counted, warned or not; a warning before --since
 *      and another workspace's lines stay out of a workspace's report; the totals add the workspaces up.
 *   3. Read-only: every workspace's transaction is set READ ONLY before its first read, and nothing is written.
 *   4. The command line and the text the operator reads.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-lifecycle-warnings.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const ROOT = new URL("..", import.meta.url).pathname;
let passed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    console.error(`  FAIL ${what}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
};

/** The compiled areas of the default profile plus `extra` ([name, path | object]), as the build compiles them. */
function compile(extra) {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-warnings-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) typeof src === "string" ? cpSync(src, join(dir, name)) : writeFileSync(join(dir, name), JSON.stringify(src));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const warnAreas = compile([
  ["50-pipeline.json", join(ROOT, "scripts/fixtures/record-lifecycle/pipeline.json")],
  ["52-enforce.json", { records: { areas: { tasks: { lifecycle: { enforce: "warn" } } } } }],
]);

const { prepareTaskWrite } = await import("../agent/lib/task-area.ts");
const { areaView } = await import("../agent/lib/record-areas.ts");
const { outcomeEvents } = await import("../agent/lib/record-lifecycle-store.ts");
const W = await import("../agent/lib/lifecycle-warnings.ts");

const ANA = "ana@example.com";
const BO = "bo@example.com";
const NOW = new Date("2026-10-24T08:00:00Z");
const tasks = areaView("tasks", warnAreas);
const task = (status) => ({ title: "Chase the invoice", status, done: status === "done", assignee: ANA, createdBy: ANA, dueAt: "2026-10-30T09:00:00.000Z", custom: {} });
/** The activity lines writeOutcome would write for this task write (warn: the move, and the rule when one broke). */
const lines = (mode, body, who, comment = null) => {
  const w = prepareTaskWrite(mode, body, { now: NOW, ...who }, warnAreas);
  assert.ok(w.ok && w.lifecycle, JSON.stringify(w).slice(0, 300));
  return outcomeEvents(tasks, w.lifecycle, comment);
};

/* ------------------------------------------------------------------------------------------------ the fake database */
const dialect = new PgDialect();
/** An in-memory entity_activity and orgs, answering the report's statements; a write in a read-only transaction fails. */
function fakeDb(orgs, rows) {
  const log = { transactions: [], writes: [], readsBeforeReadOnly: [] };
  const inTx = (scope) => {
    const t = { scope, readOnly: false, statements: [] };
    log.transactions.push(t);
    return {
      t,
      async execute(q) {
        const { sql: text, params } = dialect.sqlToQuery(q);
        const s = text.replace(/\s+/g, " ").trim();
        t.statements.push(s);
        if (/^set transaction read only$/i.test(s)) {
          t.readOnly = true;
          return [];
        }
        if (/^(insert|update|delete|truncate|create|drop|alter|grant|merge|copy)\b/i.test(s) || /\b(insert into|update \w+ set|delete from)\b/i.test(s)) {
          log.writes.push(s);
          if (t.readOnly) throw new Error(`cannot execute ${s.split(" ")[0].toUpperCase()} in a read-only transaction`);
          return [];
        }
        if (!t.readOnly) log.readsBeforeReadOnly.push(s);
        if (/^select org_id from orgs/i.test(s)) return orgs.map((org_id) => ({ org_id }));
        if (/count\(\*\)/.test(s) && /from entity_activity/.test(s)) {
          const [org, since, until] = params;
          assert.equal(org, scope, "the count is filtered on the transaction's own workspace");
          const by = {};
          for (const r of rows) {
            if (r.org !== org || r.at < new Date(since) || r.at >= new Date(until) || !W.parseMoveLine(r.event)) continue;
            by[r.type] = (by[r.type] ?? 0) + 1;
          }
          return Object.entries(by).map(([entity_type, n]) => ({ entity_type, n }));
        }
        if (/left join lateral/.test(s)) {
          const [, org, since, until, like] = params;
          assert.equal(org, scope, "the warn lines are filtered on the transaction's own workspace");
          const prefix = like.replace(/%$/, "");
          return rows
            .filter((w) => w.org === org && w.at >= new Date(since) && w.at < new Date(until) && w.event.startsWith(prefix))
            .sort((a, b) => a.at - b.at)
            .map((w) => {
              const m = rows
                .filter((m) => m.org === w.org && m.type === w.type && m.id === w.id && m.actor === w.actor && m.at <= w.at && m.at >= new Date(w.at.getTime() - 60_000) && W.parseMoveLine(m.event))
                .sort((a, b) => b.at - a.at)[0];
              return { created_at: w.at, entity_type: w.type, entity_id: w.id, actor: w.actor, warn_line: w.event, move_line: m?.event ?? null };
            });
        }
        throw new Error(`the fake database does not know this statement: ${s}`);
      },
    };
  };
  return {
    log,
    gate: {
      async listOrgs() {
        const tx = inTx(null);
        // As the operator script lists them: a read-only transaction on the bare handle.
        await tx.execute(sql`set transaction read only`);
        return (await tx.execute(sql`select org_id from orgs order by org_id`)).map((r) => r.org_id);
      },
      async inOrg(orgId, fn) {
        return fn(inTx(orgId));
      },
    },
  };
}

/** Lines written a millisecond apart from `at`, as writeOutcome writes them. */
const seed = (rows, org, type, id, actor, at, events) => events.forEach((event, i) => rows.push({ org, type, id, actor, event, at: new Date(at.getTime() + i) }));

const ORG_A = "org-a";
const ORG_B = "org-b";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const SINCE = new Date("2026-10-21T00:00:00Z");
const rows = [];
// A: a warned move (a member cancels, which only owner or admin may), with its comment.
const cancel = lines("update", { status: "cancelled", reason: "filed twice" }, { actor: BO, role: "member", before: task("open") }, "filed twice");
seed(rows, ORG_A, "task", T1, BO, new Date("2026-10-22T10:00:00Z"), cancel);
// A: two allowed moves (counted as moves, not warned).
seed(rows, ORG_A, "task", T2, ANA, new Date("2026-10-23T09:00:00Z"), lines("update", { status: "in_progress" }, { actor: ANA, role: "owner", before: task("open") }));
seed(rows, ORG_A, "task", T3, ANA, new Date("2026-10-23T09:05:00Z"), lines("update", { status: "backlog" }, { actor: ANA, role: "owner", before: task("open") }));
// A: an ordinary feed line (not a lifecycle move), and a warned move from BEFORE --since.
rows.push({ org: ORG_A, type: "task", id: T2, actor: ANA, event: "Status changed open → in_progress", at: new Date("2026-10-23T09:00:00.500Z") });
seed(rows, ORG_A, "task", T3, BO, new Date("2026-10-20T23:59:00Z"), cancel);
// B: a warned move of its own (a move the transitions do not list), by another person, on a task id A also has.
seed(rows, ORG_B, "task", T2, ANA, new Date("2026-10-25T12:00:00Z"), lines("update", { status: "backlog" }, { actor: ANA, role: "member", before: task("in_progress") }));

/* ------------------------------------------------------------------------------------------------ 1. the lines */
console.log("1. The activity lines read back");
await check("the warn line writeOutcome wrote parses to its rule and its words", () => {
  assert.equal(cancel.length, 2, "a warned move writes two lines");
  assert.deepEqual(W.parseWarnLine(cancel[1]), { rules: ["roles"], detail: "Cancel: only owner or admin may make it" });
  assert.equal(W.parseWarnLine(cancel[0]), null);
  assert.equal(W.parseWarnLine("Status changed open → in_progress"), null);
});
await check("the move line parses to its field, states and comment; a create has no from; other lines are no move", () => {
  assert.deepEqual(W.parseMoveLine(cancel[0]), { field: "status", from: "open", to: "cancelled", comment: "filed twice" });
  assert.deepEqual(W.parseMoveLine('Status moved "Open" → "In progress" (Start) [status: open → in_progress]'), { field: "status", from: "open", to: "in_progress", comment: null });
  assert.deepEqual(W.parseMoveLine('Task created in "In progress" [status:  → in_progress]'), { field: "status", from: null, to: "in_progress", comment: null });
  assert.equal(W.parseMoveLine("Status changed open → in_progress"), null);
  assert.equal(W.parseMoveLine(cancel[1]), null);
});
await check("the Postgres marker pattern says what the JavaScript one says (the same lines match)", () => {
  // In Postgres a `]` first in a bracket is literal; JavaScript needs it escaped (`[^]` alone is "any character").
  const js = new RegExp(W.MARKER_SQL.replace(/\[\^\]/g, "[^\\]"));
  for (const r of rows) assert.equal(js.test(r.event), W.parseMoveLine(r.event) !== null, r.event);
});

/* ------------------------------------------------------------------------------------------------ 2. the report */
console.log("2. The report");
const fake = fakeDb([ORG_B, ORG_A], rows);
const report = await W.lifecycleWarnings(fake.gate, { since: SINCE });
const a = report.orgs.find((o) => o.orgId === ORG_A);
const b = report.orgs.find((o) => o.orgId === ORG_B);
await check("the seeded warned move is listed: time, workspace, record, from → to, rule, actor, comment", () => {
  assert.equal(a.warnings, 1);
  assert.deepEqual(a.list[0], {
    at: "2026-10-22T10:00:00.001Z",
    orgId: ORG_A,
    area: "tasks",
    entityType: "task",
    entityId: T1,
    actor: BO,
    field: "status",
    from: "open",
    to: "cancelled",
    rules: ["roles"],
    detail: "Cancel: only owner or admin may make it",
    comment: "filed twice",
  });
});
await check("counted by rule, by area and by actor; every lifecycle move in the window counted, warned or not", () => {
  assert.deepEqual(a.byRule, { roles: 1 });
  assert.deepEqual(a.byArea, { tasks: 1 });
  assert.deepEqual(a.byActor, { [BO]: 1 });
  assert.equal(a.moves, 3, "the cancel, the start and the park (not the plain feed line, not the move before --since)");
  assert.deepEqual(a.movesByArea, { tasks: 3 });
  assert.equal(a.share, 0.3333);
});
await check("another workspace's lines stay in its own report; the totals add the workspaces up", () => {
  assert.deepEqual(report.orgs.map((o) => o.orgId), [ORG_A, ORG_B]);
  assert.equal(b.warnings, 1);
  assert.equal(b.list[0].actor, ANA);
  assert.equal(b.list[0].from, "in_progress");
  assert.equal(b.list[0].to, "backlog");
  assert.deepEqual(b.list[0].rules, ["transition"]);
  assert.ok(a.list.every((w) => w.orgId === ORG_A) && b.list.every((w) => w.orgId === ORG_B));
  assert.deepEqual(report.totals, { orgs: 2, moves: 4, warnings: 2, share: 0.5, byRule: { roles: 1, transition: 1 }, byArea: { tasks: 2 }, byActor: { [ANA]: 1, [BO]: 1 } });
  assert.equal(report.readOnly, true);
});
await check("--until and --org narrow it: the window ends before B's move; one workspace only", async () => {
  const r = await W.lifecycleWarnings(fakeDb([ORG_A, ORG_B], rows).gate, { since: SINCE, until: new Date("2026-10-24T00:00:00Z"), orgs: [ORG_B] });
  assert.deepEqual(r.orgs.map((o) => [o.orgId, o.moves, o.warnings]), [[ORG_B, 0, 0]]);
  assert.equal(r.totals.share, 0);
});

/* ------------------------------------------------------------------------------------------------ 3. read-only */
console.log("3. Read-only");
await check("every transaction is set READ ONLY before its first read, and nothing is written", () => {
  assert.equal(fake.log.transactions.length, 3, "the workspace list and one per workspace");
  for (const t of fake.log.transactions) assert.equal(t.statements[0], "set transaction read only", JSON.stringify(t.statements));
  assert.deepEqual(fake.log.readsBeforeReadOnly, []);
  assert.deepEqual(fake.log.writes, []);
  assert.ok(fake.log.transactions.filter((t) => t.scope).every((t) => t.statements.slice(1).every((s) => /^select /i.test(s))), "only selects");
});
await check("the fake refuses a write in a read-only transaction, as Postgres does (so the check above can fail)", async () => {
  const f = fakeDb([ORG_A], rows);
  await assert.rejects(
    f.gate.inOrg(ORG_A, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`insert into entity_activity (org_id) values (${ORG_A})`);
    }),
    /read-only transaction/,
  );
  assert.equal(f.log.writes.length, 1);
});

/* ------------------------------------------------------------------------------------------------ 4. command line, text */
console.log("4. The command line and the text");
await check("--since is required and an ISO date; --until later; --org repeats; anything else is refused", () => {
  const p = W.parseLifecycleWarningsArgs(["--since", "2026-10-21", "--org", ORG_A, "--org", ORG_B, "--json"]);
  assert.equal(p.since.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.deepEqual([p.until, p.orgs, p.json], [null, [ORG_A, ORG_B], true]);
  assert.equal(W.parseLifecycleWarningsArgs(["--since", "2026-10-21T05:56:00Z", "--until", "2026-10-28"]).until.toISOString(), "2026-10-28T00:00:00.000Z");
  assert.match(W.parseLifecycleWarningsArgs([]).error, /--since <ISO date> is required/);
  assert.match(W.parseLifecycleWarningsArgs(["--since", "last week"]).error, /not an ISO date/);
  assert.match(W.parseLifecycleWarningsArgs(["--since", "2026-10-28", "--until", "2026-10-21"]).error, /later than --since/);
  assert.match(W.parseLifecycleWarningsArgs(["--since", "2026-10-21", "--apply"]).error, /not an argument/);
});
await check("the text names the share, the counts and each warned move, and says nothing was changed", () => {
  const text = W.formatLifecycleWarnings(report);
  console.log(text.replace(/^/gm, "       | "));
  assert.match(text, /2 warned move\(s\) of 4 lifecycle move\(s\) \(50\.0%\)/);
  assert.match(text, /Workspace org-a: 1 warned of 3 move\(s\) \(33\.3%\)/);
  assert.match(text, /by rule: {2}roles 1/);
  assert.match(text, new RegExp(`2026-10-22T10:00:00.001Z  task/${T1}  status: open → cancelled  \\[roles\\]  by ${BO.replace(".", "\\.")}`));
  assert.match(text, /comment: filed twice/);
  assert.match(text, /Read-only: every transaction was READ ONLY; nothing was changed\./);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).totals.byRule, { roles: 1, transition: 1 });
});

console.log(process.exitCode ? "test-lifecycle-warnings: FAILED" : `test-lifecycle-warnings: ${passed} passed`);
