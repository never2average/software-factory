#!/usr/bin/env node
/**
 * THE RECORD WORKFLOW STORE AGAINST A REAL POSTGRES (lib/record-workflow-store.ts, drizzle/0047; phase 3 of the
 * workflow engine, docs/WORKFLOW_ENGINE.md "Storage").
 *
 * As app_rw (NOBYPASSRLS), through the agent's real workspace scope (`withOrgDb`), with the two tables' policies in the
 * production fail-closed form (flipped here and restored after, as the other fail-closed steps do):
 *
 *   1. the tables are tenant tables like their neighbours: row-level security ENABLED and FORCED, the org_isolation
 *      policy, one instance of a workflow per record (the unique index), events tied to an instance of their own
 *      workspace (the foreign key carries it);
 *   2. a real engine instance (initInstance on a neutral fixture) is created, read back by id and by its record, and
 *      updated after the engine ran on a step change; the pinned definition and its hash are what it was made from;
 *   3. a stale revision is a conflict (409) and NOTHING is written: the row and its history are the first writer's,
 *      and the caller's transaction is still usable; the same for two writers racing in two transactions, and for a
 *      second attachment of the same workflow to the same record;
 *   4. events append in the order they were appended (two in one write, one with an earlier time), and an appended
 *      event moves the revision on (and updated_at never backwards) so a writer holding an older read is refused; the
 *      history is an audit trail: app_rw cannot change or remove an event, nor delete an instance that has history, and
 *      an instance read without its history (a list's summary) cannot be saved over it;
 *   4b. an instance runs on its PINNED definition through the engine's own interface (`getWorkflowVersion` of its
 *      `definition_version`) after the deployment's document changed;
 *   5. another workspace sees zero rows of either table, through the store and through raw queries under RLS, cannot
 *      write into this one's (WITH CHECK), and may attach the same workflow to a record of the same id of its own;
 *   6. a connection that names no workspace sees nothing and writes nothing, and the store refuses it outright;
 *   7. drizzle/0047 on a database as the live ones are before it: additive, in step with schema.ts (the drift plan
 *      names only these two tables before it and plans nothing after it), row-level security from the migration
 *      itself, harmless run twice.
 *
 * Needs ADMIN_URL (seeding, policy DDL, catalog reads, a scratch database) and DATABASE_URL (app_rw): a database built by
 * `drizzle-kit push` + scripts/bootstrap-test-db.mjs (CI's isolation job).
 *
 *   ADMIN_URL=… DATABASE_URL=postgres://app_rw:…  npm run test:record-workflow-store-db
 */
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-record-workflow-store-db: SKIPPED — needs ADMIN_URL (seeding, policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
};

const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
const { RecordWorkflowStore, RecordWorkflowConflict, RecordWorkflowScopeError, definitionHash, definitionVersionOf } = await import("../lib/record-workflow-store.ts");
const { initInstance } = await import("../lib/workflow-engine/engine/src/core/init.ts");
const { isTerminal, runDiff } = await import("../lib/workflow-engine/engine/src/core/diff.ts");
const { Directory, offlineEvaluator } = await import("../lib/workflow-engine/engine/src/core/evaluator.ts");

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const app = postgres(appUrl, { ssl: local ? false : "require", prepare: false, max: 2, onnotice: () => {} });

const TABLES = ["record_workflow_instances", "record_workflow_events"];
const ORG_A = `org_rws_a_${process.pid}`;
const ORG_B = `org_rws_b_${process.pid}`;
const FIX = join(ROOT, "scripts/fixtures/workflows");
const PEOPLE = JSON.parse(readFileSync(join(FIX, "people.json"), "utf8"));
const DSL = JSON.parse(readFileSync(join(FIX, "two-person-review.json"), "utf8"));
const WF = "two-person-review";
const directory = new Directory();
for (const org of [ORG_A, ORG_B]) directory.seed(structuredClone(PEOPLE.users), org);
const json = (v) => JSON.parse(JSON.stringify(v));
// jsonb keeps no key order and JSON no undefined value, so instances are compared as parsed JSON, keys in any order.
const sameInstance = (a, b) => isDeepStrictEqual(json(a), json(b));
/** The SQLSTATE of a refused statement (the app's query errors carry the code, never the values). */
const sqlState = (r) => r.error?.code ?? r.error?.cause?.code ?? (r.error ? "no code" : "it went through");
const PINNED_VERSION = definitionVersionOf(definitionHash(DSL));
const recordShape = (inst, revision) => ({ ...structuredClone(inst), object: { ...inst.object, data: {} }, task: {}, revision, definition_version: PINNED_VERSION });

/** A fresh engine instance on a record of this workspace (revision 0), as phase 5 will make one. */
function attach(org, recordId, now = new Date("2026-04-01T09:00:00.000Z")) {
  const inst = initInstance(WF, DSL, { department: "alpha" }, directory, now, "p-admin", undefined, org, { type: "deployments", id: recordId });
  inst.created_by = "p-admin";
  inst.terminal = isTerminal(DSL, inst);
  return inst;
}

/** A person's change to a step, then the engine's rules: what phase 5's write path will do before it saves. */
async function move(inst, stepId, state, actor, at, dsl = DSL) {
  const step = inst.steps.find((s) => s.id === stepId);
  const before = step.state;
  step.state = state;
  inst.history.push({ at: at.toISOString(), type: "state_changed", step_id: stepId, actor, source: "user", data: { before, after: state } });
  await runDiff(inst, dsl, { stepId, changed: { state: { before, after: state } } }, directory, offlineEvaluator, at, actor);
  inst.terminal = isTerminal(dsl, inst);
  inst.updated_at = at.toISOString();
  return inst;
}

const inA = (fn) => withOrgDb(ORG_A, (tx) => fn(new RecordWorkflowStore(tx, ORG_A), tx));
const inB = (fn) => withOrgDb(ORG_B, (tx) => fn(new RecordWorkflowStore(tx, ORG_B), tx));
const rows = (r) => (Array.isArray(r) ? r : (r?.rows ?? []));
const saved = new Map();

try {
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG_A}, 'Workflow store A', 'active'), (${ORG_B}, 'Workflow store B', 'active')`;

  /* ---- 1. tenant tables like their neighbours ----------------------------------------------------------------- */
  console.log("1. The tables are tenant tables like their neighbours:");
  for (const table of TABLES) {
    const [rls] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`;
    check(`row-level security is enabled and FORCED on ${table}`, rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, rls);
    const [policy] = await admin`select qual from pg_policies where tablename = ${table} and policyname = 'org_isolation'`;
    check("…with the workspace policy", Boolean(policy), policy);
    saved.set(table, policy.qual);
    // The production shape: no workspace named, no rows (.migrate-rls-fail-closed.mjs; drizzle/0047 creates it so).
    const closed = `(org_id = current_setting('app.org_id', true))`;
    await admin.unsafe(`ALTER POLICY org_isolation ON ${table} USING ${closed} WITH CHECK ${closed}`);
  }
  const [role] = await app`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`;
  check("…and the app's role cannot bypass it (or every check below would be vacuous)", role?.rolbypassrls === false && role?.rolsuper === false, role);
  const uniq = await admin`select indexdef from pg_indexes where tablename = 'record_workflow_instances' and indexname = 'record_workflow_instances_entity_uidx'`;
  check("one instance of a workflow per record: a unique index on (org_id, entity_type, entity_id, workflow_id)", /UNIQUE INDEX .*\(org_id, entity_type, entity_id, workflow_id\)/.test(uniq[0]?.indexdef ?? ""), uniq);
  const fk = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'record_workflow_events_instance_fk'`;
  check("an event hangs off an instance of its own workspace (the foreign key carries org_id) and RESTRICTS its deletion", /FOREIGN KEY \(org_id, instance_id\) REFERENCES record_workflow_instances\(org_id, id\) ON DELETE RESTRICT/.test(fk[0]?.def ?? ""), fk);
  const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];
  const privileges = async (db) => {
    const out = {};
    for (const t of TABLES) {
      const [row] = await db`select string_agg(p, ',' order by i) as p from unnest(${PRIVILEGES}::text[]) with ordinality as x(p, i) where has_table_privilege('app_rw', ${t}, p)`;
      out[t] = row.p;
    }
    return out;
  };
  const granted = await privileges(admin);
  check("app_rw may SELECT and INSERT history events only (append-only), and everything on instances", granted.record_workflow_events === "SELECT,INSERT" && granted.record_workflow_instances === "SELECT,INSERT,UPDATE,DELETE", granted);

  /* ---- 2. round trip ------------------------------------------------------------------------------------------- */
  console.log("\n2. Create, read and update round-trip:");
  const first = attach(ORG_A, "rec-1");
  const created = await inA((s) => s.create(first, DSL));
  check("a new instance is created at revision 1", created.ok && created.instance.revision === 1, created.ok ? created.instance.revision : created.conflict?.message);
  const byId = await inA((s) => s.get(first.id));
  check("read back by id it is the instance that was stored (the record's own values are not stored)", sameInstance(byId, recordShape(first, 1)), { got: json(byId)?.steps?.[0], want: json(first).steps[0] });
  const byRecord = await inA((s) => s.getByEntity("deployments", "rec-1", WF));
  check("…and by its record and workflow", sameInstance(byRecord, recordShape(first, 1)));
  check("…pinned at the version keyed by its definition's hash", created.instance.definition_version === PINNED_VERSION && byId.definition_version === PINNED_VERSION, byId.definition_version);
  const pinned = await inA((s) => s.getDefinition(first.id));
  check("the pinned definition is the document it was made from, with its hash", isDeepStrictEqual(pinned?.definition, DSL) && pinned.definition_hash === definitionHash(DSL), pinned?.definition_hash);
  const later = structuredClone(DSL);
  later.init.steps[0].title = "Prepare, changed by a later build";
  const stillPinned = await withOrgDb(ORG_A, (tx) => new RecordWorkflowStore(tx, ORG_A, { definitions: { [WF]: later } }).getDefinition(first.id));
  check("…and stays so when the deployment's document changes later", stillPinned?.definition_hash === definitionHash(DSL) && stillPinned.definition.init.steps[0].title === DSL.init.steps[0].title);

  const changed = await move(structuredClone(byId), "prepare", "completed", "p-maker", new Date("2026-04-01T10:00:00.000Z"));
  const updated = await inA((s) => s.update(changed));
  check("an update after the engine ran on a step change is stored at revision 2", updated.ok && updated.instance.revision === 2, updated.ok ? updated.instance.revision : updated.conflict?.message);
  const afterUpdate = await inA((s) => s.get(first.id));
  check("read back it is the changed instance: its steps, fired rules, terminal flag and history", sameInstance(afterUpdate, recordShape(changed, 2)), { steps: json(afterUpdate)?.steps?.map((s) => [s.id, s.state, s.status]), fired: afterUpdate?.fired_once });
  check("…the review step is open and the preparer's is completed (the rules' work survived the round trip)", afterUpdate.steps.find((s) => s.id === "prepare").state === "completed" && afterUpdate.steps.find((s) => s.id === "review").status === true, afterUpdate.steps.map((s) => [s.id, s.state, s.status]));
  const [rowCount] = await admin`select count(*)::int as n from record_workflow_events where org_id = ${ORG_A} and instance_id = ${first.id}`;
  check("every history event is one row (none twice, none lost)", rowCount.n === changed.history.length, { stored: rowCount.n, history: changed.history.length });

  /* ---- 3. conflicts write nothing ------------------------------------------------------------------------------ */
  console.log("\n3. A stale revision is a conflict, and nothing is written:");
  const readA = await inA((s) => s.get(first.id));
  const readB = await inA((s) => s.get(first.id));
  const winner = await move(structuredClone(readA), "review", "completed", "p-checker", new Date("2026-04-01T11:00:00.000Z"));
  const won = await inA((s) => s.update(winner));
  check("the first writer at revision 2 is stored at revision 3", won.ok && won.instance.revision === 3);
  const eventsBefore = (await admin`select count(*)::int as n from record_workflow_events where instance_id = ${first.id}`)[0].n;
  const loser = await move(structuredClone(readB), "review", "rejected", "p-checker", new Date("2026-04-01T11:00:01.000Z"));
  const lost = await inA(async (s, tx) => {
    const r = await s.update(loser);
    // The caller's transaction is still usable after the conflict: no statement failed.
    const [still] = rows(await tx.execute("select 1 as one"));
    return { r, usable: still?.one === 1 };
  });
  check("the second writer, still at revision 2, gets the conflict: STALE_REVISION, 409, expected 2, current 3", !lost.r.ok && lost.r.conflict instanceof RecordWorkflowConflict && lost.r.conflict.code === "STALE_REVISION" && lost.r.conflict.status === 409 && lost.r.conflict.expected === 2 && lost.r.conflict.current === 3, lost.r.ok ? "ok" : { ...lost.r.conflict, message: lost.r.conflict.message });
  check("…and its transaction is still usable (the conflict is found without a failed statement)", lost.usable === true);
  const afterConflict = await inA((s) => s.get(first.id));
  check("nothing of the loser's was written: the review is completed as the winner left it, revision 3", afterConflict.revision === 3 && afterConflict.steps.find((s) => s.id === "review").state === "completed", afterConflict.steps.map((s) => [s.id, s.state]));
  const eventsAfter = (await admin`select count(*)::int as n from record_workflow_events where instance_id = ${first.id}`)[0].n;
  check("…and none of its events", eventsAfter === eventsBefore, { eventsBefore, eventsAfter });
  const thrown = await attempt(() => inA((s) => s.saveInstance(structuredClone(loser))));
  check("the engine's saveInstance throws the same conflict", thrown.error instanceof RecordWorkflowConflict && thrown.error.status === 409, thrown.error?.message);

  // Two transactions racing at the same revision: one wins, one is refused, never both.
  const race = await inA((s) => s.get(first.id));
  const tally = [];
  for (let round = 0; round < 8; round++) {
    const base = await inA((s) => s.get(first.id));
    const at = new Date(Date.UTC(2026, 3, 2, 9, round));
    const [x, y] = await Promise.all([0, 1].map((k) => inA(async (s) => {
      const mine = structuredClone(base);
      mine.history.push({ at: at.toISOString(), type: "comment_added", step_id: "review", actor: k ? "p-lead" : "p-checker", source: "user", data: { round, k } });
      mine.updated_at = at.toISOString();
      return (await s.update(mine)).ok;
    })));
    tally.push(`${x}+${y}`);
  }
  check("8 rounds of two transactions writing the same revision at once: exactly one wins each time", tally.every((t) => t === "true+false" || t === "false+true"), tally);
  const afterRace = await inA((s) => s.get(first.id));
  check("…the revision moved on once per round, and each round left exactly one event", afterRace.revision === race.revision + 8 && afterRace.history.filter((h) => h.type === "comment_added").length === 8, { revision: afterRace.revision, from: race.revision });

  const again = attach(ORG_A, "rec-1");
  const dup = await inA(async (s, tx) => {
    const r = await s.create(again, DSL);
    const [still] = rows(await tx.execute("select 1 as one"));
    return { r, usable: still?.one === 1 };
  });
  check("attaching the same workflow to the same record again: conflict (CONFLICT, 409), the transaction still usable", !dup.r.ok && dup.r.conflict.reason === "attached" && dup.r.conflict.code === "CONFLICT" && dup.r.conflict.status === 409 && dup.usable, dup.r.ok ? "ok" : dup.r.conflict.message);
  const [one] = await admin`select count(*)::int as n from record_workflow_instances where org_id = ${ORG_A} and entity_id = 'rec-1'`;
  const [noOrphans] = await admin`select count(*)::int as n from record_workflow_events where org_id = ${ORG_A} and instance_id = ${again.id}`;
  check("…one row for the record, and no event of the refused one", one.n === 1 && noOrphans.n === 0, { rows: one.n, events: noOrphans.n });

  const current = await inA((s) => s.get(first.id));
  const summarySave = await inA(async (s, tx) => {
    const [summary] = await s.listInstancesForObjects(ORG_A, "deployments", ["rec-1"]);
    const r = await s.update({ ...summary, organization_id: ORG_A, revision: current.revision, history: [] });
    const [still] = rows(await tx.execute("select 1 as one"));
    return { r, usable: still?.one === 1, summaryHistory: summary.history };
  });
  check("an instance from listInstancesForObjects (no history) saved over the stored history: history_mismatch, 409, transaction usable", summarySave.summaryHistory === undefined && !summarySave.r.ok && summarySave.r.conflict.reason === "history_mismatch" && summarySave.r.conflict.status === 409 && summarySave.usable, summarySave.r.ok ? "ok" : summarySave.r.conflict.message);
  const afterSummary = await inA((s) => s.get(first.id));
  check("…and nothing was written: revision, steps and history as they were", afterSummary.revision === current.revision && sameInstance(afterSummary, current));

  /* ---- 4. events in order --------------------------------------------------------------------------------------- */
  console.log("\n4. Events append in order:");
  const second = attach(ORG_A, "rec-2");
  await inA((s) => s.create(second, DSL));
  const t0 = new Date("2026-04-03T09:00:00.000Z");
  const appended = await inA(async (s) => {
    const a = await s.appendEvent(second.id, { at: t0.toISOString(), type: "comment_added", step_id: "prepare", actor: "p-maker", source: "user", detail: "first" });
    const b = await s.appendEvent(second.id, { at: t0.toISOString(), type: "evidence_added", step_id: "prepare", actor: "p-maker", source: "user", detail: "second, same time" });
    const c = await s.appendEvent(second.id, { at: "2026-04-02T09:00:00.000Z", type: "comment_added", step_id: "prepare", actor: "p-maker", source: "user", detail: "third, an earlier time" });
    return [a, b, c];
  });
  check("each append moves the revision on (2, 3, 4)", appended.map((x) => x?.revision).join() === "2,3,4", appended.map((x) => x?.revision));
  const listed = await inA((s) => s.listEvents(second.id));
  check("listed in the order appended: the creation, then first, second, third (not re-sorted by time)", listed.map((e) => e.detail ?? e.type).join(" | ") === "instance_created | first | second, same time | third, an earlier time", listed.map((e) => e.detail ?? e.type));
  check("…their row ids increasing", listed.every((e, i) => i === 0 || e.id > listed[i - 1].id));
  const afterAppends = await inA((s) => s.get(second.id));
  check("updated_at follows the latest event and never moves backwards (the earlier-stamped third left it at the second's time)", afterAppends.updated_at === t0.toISOString(), afterAppends.updated_at);
  const withTwo = await inA((s) => s.get(second.id));
  withTwo.history.push({ at: "2026-04-03T10:00:00.000Z", type: "state_changed", step_id: "prepare", actor: "p-maker", source: "user" });
  withTwo.history.push({ at: "2026-04-03T10:00:00.000Z", type: "diff_rule_fired", detail: "priority 0", actor: "p-maker", source: "rule" });
  withTwo.updated_at = "2026-04-03T10:00:00.000Z";
  const twoInOne = await inA((s) => s.update(withTwo));
  const listedAfter = await inA((s) => s.listEvents(second.id));
  check("two events in one write are stored after the rest, in their order", twoInOne.ok && listedAfter.slice(-2).map((e) => e.type).join() === "state_changed,diff_rule_fired" && listedAfter.length === 6, listedAfter.map((e) => e.type));
  const stale = structuredClone(second);
  stale.revision = 1;
  stale.history.push({ at: "2026-04-03T11:00:00.000Z", type: "comment_added", step_id: "prepare", actor: "p-maker", source: "user", detail: "from an old read" });
  const staleAfterAppend = await inA((s) => s.update(stale));
  const [eventsNow] = await admin`select count(*)::int as n, max(revision) as revision from record_workflow_events e join record_workflow_instances i on i.org_id = e.org_id and i.id = e.instance_id where e.instance_id = ${second.id}`;
  check("a writer holding the instance as created (revision 1) is refused after the appends, as a 409 conflict (its history is short: history_mismatch)", !staleAfterAppend.ok && staleAfterAppend.conflict.status === 409 && staleAfterAppend.conflict.reason === "history_mismatch", staleAfterAppend.ok ? "ok" : staleAfterAppend.conflict.reason);
  check("…and nothing of it was written (nothing silently dropped, nothing overwritten)", eventsNow.n === 6 && Number(eventsNow.revision) === 5, eventsNow);

  console.log("\n4b. The history is an audit trail:");
  const changeEvent = await attempt(() => withOrgDb(ORG_A, (tx) => tx.execute(`update record_workflow_events set detail = 'rewritten' where instance_id = '${second.id}'`)));
  check("app_rw in the workspace's own scope cannot change an event (42501)", sqlState(changeEvent) === "42501", sqlState(changeEvent));
  const removeEvent = await attempt(() => withOrgDb(ORG_A, (tx) => tx.execute(`delete from record_workflow_events where instance_id = '${second.id}'`)));
  check("…nor remove one (42501)", sqlState(removeEvent) === "42501", sqlState(removeEvent));
  const removeInstance = await attempt(() => withOrgDb(ORG_A, (tx) => tx.execute(`delete from record_workflow_instances where id = '${second.id}'`)));
  check("…nor delete an instance that has a history (the foreign key restricts: 23503)", sqlState(removeInstance) === "23503", sqlState(removeInstance));
  const [kept] = await admin`select (select count(*)::int from record_workflow_events where instance_id = ${second.id}) as events, (select count(*)::int from record_workflow_events where instance_id = ${second.id} and detail = 'rewritten') as rewritten`;
  check("…the history is whole", kept.events === listedAfter.length && kept.rewritten === 0, kept);

  console.log("\n4c. An instance runs on its pinned definition, through the engine's interface:");
  // A later build changes the document: its rules are gone, so completing the first step would open nothing.
  const LATER = structuredClone(DSL);
  LATER.diff = [];
  LATER.init.steps[0].title = "Prepare (changed by a later build)";
  const third = attach(ORG_A, "rec-3");
  await inA((s) => s.create(third, DSL));
  const viaEngine = await withOrgDb(ORG_A, async (tx) => {
    const s = new RecordWorkflowStore(tx, ORG_A, { definitions: { [WF]: LATER } });
    const inst = await s.getInstance(third.id, ORG_A);
    const current = await s.getWorkflow(WF, ORG_A);
    const runs = await s.getWorkflowVersion(inst.workflow_id, inst.definition_version, ORG_A);
    await move(inst, "prepare", "completed", "p-maker", new Date("2026-04-05T09:00:00.000Z"), runs.dsl);
    const r = await s.update(inst);
    return { inst, current, runs, r };
  });
  check("the deployment's current document has another version than the instance's", viaEngine.current.version === definitionVersionOf(definitionHash(LATER)) && viaEngine.current.version !== viaEngine.inst.definition_version, { current: viaEngine.current.version, instance: viaEngine.inst.definition_version });
  check("getWorkflowVersion(instance.definition_version) gives the pinned document, not the new one", isDeepStrictEqual(viaEngine.runs.dsl, DSL) && viaEngine.runs.version === PINNED_VERSION, viaEngine.runs?.dsl?.init?.steps?.[0]?.title);
  check("…so the engine runs the pinned rules: completing the first step opened the review (the new document has no rules)", viaEngine.inst.steps.find((s) => s.id === "review").status === true && viaEngine.r.ok, viaEngine.inst.steps.map((s) => [s.id, s.state, s.status]));
  const tamper = await inA((s) => s.get(third.id));
  tamper.definition_version = definitionVersionOf(definitionHash(LATER));
  const tampered = await inA((s) => s.update(tamper));
  const afterTamper = await inA((s) => s.get(third.id));
  check("an update cannot move an instance to another definition version (the stored one is kept)", tampered.ok && tampered.instance.definition_version === PINNED_VERSION && afterTamper.definition_version === PINNED_VERSION, afterTamper.definition_version);

  /* ---- 5. another workspace ------------------------------------------------------------------------------------- */
  console.log("\n5. Another workspace sees none of it:");
  const seenByB = await inB(async (s) => ({
    get: await s.get(first.id),
    byRecord: await s.getByEntity("deployments", "rec-1", WF),
    list: await s.listByEntity("deployments", "rec-1"),
    all: await s.listInstances(),
    page: await s.listInstancesPage(ORG_B, undefined, undefined, 50),
    summary: await s.listInstancesForObjects(ORG_B, "deployments", ["rec-1", "rec-2"]),
    events: await s.listEvents(first.id),
    definition: await s.getDefinition(first.id),
    append: await s.appendEvent(first.id, { at: "2026-04-04T09:00:00.000Z", type: "comment_added", actor: "intruder", source: "user" }),
    update: await s.update({ ...structuredClone(afterRace), organization_id: ORG_B }),
  }));
  check("through the store: no instance by id, by record or in any list; no events; no definition", seenByB.get === undefined && seenByB.byRecord === undefined && seenByB.list.length === 0 && seenByB.all.length === 0 && seenByB.page.items.length === 0 && seenByB.summary.length === 0 && seenByB.events.length === 0 && seenByB.definition === undefined, { all: seenByB.all.length, events: seenByB.events.length });
  check("…an append to A's instance writes nothing (no such instance here)", seenByB.append === undefined);
  check("…and an update of A's instance relabelled as B's is a conflict (missing), not a write", !seenByB.update.ok && seenByB.update.conflict.reason === "missing");
  const askedAsA = await attempt(() => inB((s) => s.update(afterRace)));
  check("…B's store refuses an instance that names workspace A outright", askedAsA.error instanceof RecordWorkflowScopeError, askedAsA.error?.message);
  const aUnchanged = await inA((s) => s.get(first.id));
  check("A's instance is exactly as it was (revision, history)", aUnchanged.revision === afterRace.revision && aUnchanged.history.length === afterRace.history.length);

  const raw = await withOrgDb(ORG_B, async (tx) => ({
    instances: rows(await tx.execute("select count(*)::int as n from record_workflow_instances"))[0].n,
    events: rows(await tx.execute("select count(*)::int as n from record_workflow_events"))[0].n,
    named: rows(await tx.execute(`select count(*)::int as n from record_workflow_instances where org_id = '${ORG_A}'`))[0].n,
    updated: rows(await tx.execute(`update record_workflow_instances set revision = 99 where org_id = '${ORG_A}' returning id`)).length,
    deleted: rows(await tx.execute(`delete from record_workflow_instances where org_id = '${ORG_A}' returning id`)).length,
  }));
  check("through raw queries under RLS in B's scope: zero rows of either table, even naming A", raw.instances === 0 && raw.events === 0 && raw.named === 0, raw);
  check("…an UPDATE or DELETE of A's rows touches none", raw.updated === 0 && raw.deleted === 0, raw);
  const planted = await attempt(() => withOrgDb(ORG_B, (tx) => tx.execute(`insert into record_workflow_instances (org_id, id, entity_type, entity_id, workflow_id, definition_hash, definition) values ('${ORG_A}', 'planted', 'deployments', 'rec-9', '${WF}', 'x', '{}')`)));
  check("…and a row planted under A's workspace from B's scope is refused (WITH CHECK: 42501)", sqlState(planted) === "42501", sqlState(planted));
  const plantedEvent = await attempt(() => withOrgDb(ORG_B, (tx) => tx.execute(`insert into record_workflow_events (org_id, instance_id, at, type) values ('${ORG_A}', '${first.id}', now(), 'comment_added')`)));
  check("…and so is an event planted on A's instance (42501)", sqlState(plantedEvent) === "42501", sqlState(plantedEvent));
  const crossFk = await attempt(() => withOrgDb(ORG_B, (tx) => tx.execute(`insert into record_workflow_events (org_id, instance_id, at, type) values ('${ORG_B}', '${first.id}', now(), 'comment_added')`)));
  check("…and an event of B's own that names A's instance is refused by the foreign key (23503)", sqlState(crossFk) === "23503", sqlState(crossFk));
  const theirs = attach(ORG_B, "rec-1");
  const bCreated = await inB((s) => s.create(theirs, DSL));
  const bList = await inB((s) => s.listInstances());
  const aList = await inA((s) => s.listInstances());
  check("B may attach the same workflow to its own record of the same id, and each sees only its own", bCreated.ok && bList.length === 1 && bList[0].id === theirs.id && aList.length === 3 && aList.every((i) => i.organization_id === ORG_A), { b: bList.map((i) => i.id), a: aList.length });
  const [counts] = await admin`select (select count(*)::int from record_workflow_instances where org_id = ${ORG_A}) as a, (select count(*)::int from record_workflow_events where org_id = ${ORG_A} and actor = 'intruder') as intruder`;
  check("A still holds exactly its three instances and no event of B's", counts.a === 3 && counts.intruder === 0, counts);

  /* ---- 6. no workspace named ------------------------------------------------------------------------------------ */
  console.log("\n6. A connection that names no workspace:");
  const unscoped = {
    instances: (await app`select count(*)::int as n from record_workflow_instances`)[0].n,
    events: (await app`select count(*)::int as n from record_workflow_events`)[0].n,
    named: (await app`select count(*)::int as n from record_workflow_instances where org_id = ${ORG_A}`)[0].n,
  };
  check("sees zero rows of either table, even naming a workspace", unscoped.instances === 0 && unscoped.events === 0 && unscoped.named === 0, unscoped);
  const unscopedWrite = await attempt(() => app`insert into record_workflow_instances (org_id, id, entity_type, entity_id, workflow_id, definition_hash, definition) values (${ORG_A}, 'unscoped', 'deployments', 'rec-8', ${WF}, 'x', '{}')`);
  check("…and writes nothing (WITH CHECK refuses the row: 42501)", sqlState(unscopedWrite) === "42501", sqlState(unscopedWrite));
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const bare = drizzle(app);
  const refused = await attempt(() => new RecordWorkflowStore(bare, ORG_A).get(first.id));
  check("the store handed the bare pool refuses before reading anything", refused.error instanceof RecordWorkflowScopeError, refused.error?.message);
  const wrongScope = await attempt(() => withOrgDb(ORG_B, (tx) => new RecordWorkflowStore(tx, ORG_A).listInstances()));
  check("…and so does a store for A handed B's transaction", wrongScope.error instanceof RecordWorkflowScopeError, wrongScope.error?.message);

  /* ---- 7. the migration ----------------------------------------------------------------------------------------- */
  const TAG = "0047_record_workflows";
  console.log(`\n7. drizzle/${TAG}.sql on a database as the live ones are before it:`);
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  check(`the journal carries ${TAG} at its own index, later than the one before`, at > 0 && journal.entries.every((e, i) => e.idx === i) && journal.entries[at].when > journal.entries[at - 1].when, journal.entries.slice(at - 1, at + 1));
  const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
  const SCRATCH = `rwsmig_${process.pid}`;
  const scratchUrl = (() => {
    const u = new URL(adminUrl);
    u.pathname = `/${SCRATCH}`;
    return u.toString();
  })();
  await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
  await admin.unsafe(`create database "${SCRATCH}"`);
  const sdb = postgres(scratchUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
  try {
    const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
    const has = async () => (await sdb`select table_name from information_schema.tables where table_name in ${sdb(TABLES)}`).length;
    check("a database built from schema.ts has both tables", pushed.status === 0 && (await has()) === 2, pushed.out.slice(-300));
    const others = (await sdb`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)[0].n - 2;
    await sdb.unsafe(`drop table "record_workflow_events"`);
    await sdb.unsafe(`drop table "record_workflow_instances"`);
    const before = driftPlan(scratchUrl);
    const ours = (x) => TABLES.some((t) => x.includes(`"${t}"`));
    check(`before ${TAG.slice(0, 4)} the drift plan against schema.ts names these two tables and only them (so an empty plan after means something)`, !before.error && before.apply.length >= 2 && before.apply.every(ours) && before.refused.length === 0, before.error ? before : { apply: before.apply.map((x) => x.slice(0, 90)), refused: before.refused });
    await sdb.begin(async (tx) => {
      for (const x of statements) await tx.unsafe(x);
    });
    const after = driftPlan(scratchUrl);
    check(`after ${TAG.slice(0, 4)} the drift dry run plans NOTHING to apply, and refuses nothing`, !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
    check("…what it sets aside is only policy / row-level-security noise", !after.error && after.aside.every((x) => !/COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)), after.aside);
    check("…and no other table appeared or went", (await sdb`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)[0].n - 2 === others);
    for (const table of TABLES) {
      const [flags] = await sdb`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table}`;
      const pol = await sdb`select policyname, qual, with_check from pg_policies where tablename = ${table}`;
      check(`the migration itself enables and forces row-level security on ${table}, with the workspace policy failing closed`, flags?.relrowsecurity && flags?.relforcerowsecurity && pol.length === 1 && pol[0].policyname === "org_isolation" && /org_id = current_setting\('app\.org_id'::text, true\)/.test(pol[0].qual) && !/IS NULL/i.test(pol[0].qual) && /app\.org_id/.test(pol[0].with_check), { flags, pol });
    }
    const [scratchGrants] = await sdb`select (select string_agg(p, ',' order by i) from unnest(${["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]}::text[]) with ordinality as x(p, i) where has_table_privilege('app_rw', 'record_workflow_events', p)) as events`;
    const [scratchFk] = await sdb`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'record_workflow_events_instance_fk'`;
    check("the migration itself makes the history append-only for app_rw (SELECT, INSERT) and its foreign key RESTRICT", scratchGrants.events === "SELECT,INSERT" && /ON DELETE RESTRICT/.test(scratchFk?.def ?? ""), { scratchGrants, scratchFk });
    await sdb.begin(async (tx) => {
      for (const x of statements) await tx.unsafe(x);
    });
    const twice = driftPlan(scratchUrl);
    check("run again it changes nothing", (await sdb`select policyname from pg_policies where tablename in ${sdb(TABLES)}`).length === 2 && twice.apply?.length === 0 && (await sdb`select count(*)::int as n from pg_constraint where conname = 'record_workflow_events_instance_fk'`)[0].n === 1);
  } finally {
    await sdb.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
  }
} catch (error) {
  failures.push(`threw: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  for (const [table, qual] of saved) {
    await admin.unsafe(`ALTER POLICY org_isolation ON ${table} USING (${qual}) WITH CHECK (${qual})`).catch(() => {});
  }
  await admin`delete from record_workflow_events where org_id in (${ORG_A}, ${ORG_B})`.catch(() => {});
  await admin`delete from record_workflow_instances where org_id in (${ORG_A}, ${ORG_B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG_A}, ${ORG_B})`.catch(() => {});
  await admin.end({ timeout: 2 });
  await app.end({ timeout: 2 });
  await closeDb();
}

if (failures.length) {
  console.error(`\ntest-record-workflow-store-db: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-record-workflow-store-db: all ${passed} checks passed`);
process.exit(0);
