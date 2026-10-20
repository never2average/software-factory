/**
 * THE RECORD WORKFLOW STORE, OFFLINE (lib/record-workflow-store.ts, drizzle/0047; phase 3 of the workflow engine,
 * docs/WORKFLOW_ENGINE.md "Storage"). No database: the store runs against drizzle's mock driver, whose statements are
 * rendered to SQL and answered from a script, so what the store SENDS is checked statement by statement. What Postgres
 * does with it (row-level security, the unique attachment, the revision check, the order of events) is
 * scripts/test-record-workflow-store-db.mjs.
 *
 *   1. THE ROW: a real engine instance (initInstance on a neutral fixture, a step completed, the rules run) stored and
 *      read back is the same instance, except the record's own values, which are never copied (`withRecordData`).
 *   2. THE DEFINITION'S HASH: canonical (key order does not matter), sha256 hex, changes when the document does.
 *   3. THE SCOPE: the store refuses a transaction scoped to no workspace or another one, before any read or write;
 *      every statement it sends names its workspace; a method asked about another workspace sends nothing.
 *   4. CONFLICTS: a stale revision, a missing instance and a record already attached are the engine's conflict type
 *      with status 409, returned by create / update and thrown by saveInstance, and nothing more is sent after them.
 *   5. HISTORY: new events are only those after what is stored, inserted in one statement in order; a history shorter
 *      than what is stored is refused.
 *   6. WHAT IT DOES NOT CARRY: definitions change only through the build; scopes, identity, callbacks and leases throw.
 *   7. THE MIGRATION AND THE JOURNAL: two tables, ENABLE + FORCE row-level security and the org_isolation policy on
 *      app.org_id for both, additive only; the same columns as schema.ts; the journal entry at its own index with a
 *      later `when` than the one before it.
 *   8. ONLY THE WRITE PATH CALLS IT: no file outside the tests and lib/record-workflow-moves.ts names the store.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-workflow-store.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "../agent/lib/db/schema.ts";
import {
  RecordWorkflowConflict,
  RecordWorkflowNotSupported,
  RecordWorkflowScopeError,
  RecordWorkflowStore,
  canonicalJson,
  definitionHash,
  definitionVersionOf,
  eventFromRow,
  eventValues,
  instanceFromRow,
  instanceRowValues,
  isRecordWorkflowConflict,
  withRecordData,
} from "../lib/record-workflow-store.ts";
import { isTerminal, runDiff } from "../lib/workflow-engine/engine/src/core/diff.ts";
import { Directory, offlineEvaluator } from "../lib/workflow-engine/engine/src/core/evaluator.ts";
import { initInstance } from "../lib/workflow-engine/engine/src/core/init.ts";
import { PersistenceConflictError } from "../lib/workflow-engine/engine/src/core/store.ts";

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
const section = (title) => console.log(`\n${title}`);

// ── a real instance from the engine ────────────────────────────────────────────────────────────────────────────────

const ORG = "org-store-a";
const FIX = join(ROOT, "scripts/fixtures/workflows");
const PEOPLE = JSON.parse(readFileSync(join(FIX, "people.json"), "utf8"));
const DSL = JSON.parse(readFileSync(join(FIX, "two-person-review.json"), "utf8"));
const directory = new Directory();
directory.seed(structuredClone(PEOPLE.users), ORG);

async function realInstance({ org = ORG, entityId = "rec-1" } = {}) {
  const now = new Date("2026-03-02T09:00:00.000Z");
  const inst = initInstance("two-person-review", DSL, { department: "alpha" }, directory, now, "p-admin", undefined, org, { type: "deployments", id: entityId });
  inst.created_by = "p-admin";
  inst.terminal = isTerminal(DSL, inst);
  // The preparer completes their step; the rules open the review (a state change, rules fired, once-markers).
  const step = inst.steps.find((s) => s.id === "prepare");
  const later = new Date("2026-03-03T10:30:00.000Z");
  step.state = "completed";
  inst.history.push({ at: later.toISOString(), type: "state_changed", step_id: "prepare", actor: "p-maker", source: "user", data: { before: "open", after: "completed" } });
  await runDiff(inst, DSL, { stepId: "prepare", changed: { state: { before: "open", after: "completed" } } }, directory, offlineEvaluator, later, "p-maker");
  inst.terminal = isTerminal(DSL, inst);
  return inst;
}

/** What Postgres hands back for the row the store inserts: jsonb parsed, timestamps as Dates, defaults filled. */
function storedRow(values) {
  const { createdAt, updatedAt, ...rest } = values;
  return { ...JSON.parse(JSON.stringify(rest)), createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) };
}
function storedEvent(values, id) {
  const { at, ...rest } = values;
  return { ...JSON.parse(JSON.stringify(rest)), at: new Date(at), id, createdAt: new Date() };
}

/** The instance as the store gives it back: the record's values are not stored, so they are compared empty. */
const withoutRecordData = (inst) => ({ ...structuredClone(inst), object: { ...inst.object, data: {} }, task: {} });

// ── a recording database: drizzle's mock driver, statements rendered, answers scripted ─────────────────────────────

const mock = drizzle.mock({ schema });
function recordingDb({ org = ORG, answers = [] } = {}) {
  const sent = [];
  const queue = [...answers];
  const next = (q) => {
    const a = queue.length ? queue.shift() : [];
    return typeof a === "function" ? a(q) : a;
  };
  const wrap = (target) =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === "then") {
          if (typeof t.toSQL !== "function") return undefined;
          return (resolve, reject) => {
            let q;
            try {
              q = t.toSQL();
            } catch (e) {
              reject(e);
              return;
            }
            sent.push(q);
            Promise.resolve().then(() => next(q)).then(resolve, reject);
          };
        }
        const v = Reflect.get(t, prop, t);
        if (typeof v !== "function") return v;
        return (...args) => {
          const r = v.apply(t, args);
          return r && typeof r === "object" ? wrap(r) : r;
        };
      },
    });
  const db = {
    select: (...a) => wrap(mock.select(...a)),
    insert: (t) => wrap(mock.insert(t)),
    update: (t) => wrap(mock.update(t)),
    delete: (t) => wrap(mock.delete(t)),
    execute: async (q) => {
      const rendered = mock.dialect.sqlToQuery(q);
      sent.push(rendered);
      if (/current_setting\('app\.org_id'/.test(rendered.sql)) return [{ org }];
      return next(rendered);
    },
  };
  return { db, sent, queue };
}
const statements = (sent) => sent.filter((q) => !/current_setting\('app\.org_id'/.test(q.sql));
const touches = (q, table) => q.sql.includes(`"${table}"`);
const kind = (q) => q.sql.trim().split(/\s+/)[0].toLowerCase();

// ── 1. the row ─────────────────────────────────────────────────────────────────────────────────────────────────────

section("1. The row: an engine instance stored and read back");

await check("a real instance (init, a step completed, the rules run) round-trips through its row and its events", async () => {
  const inst = await realInstance();
  assert.ok(inst.history.length >= 3, "the instance has a history to store");
  assert.ok((inst.fired_once ?? []).length > 0 || inst.history.some((h) => h.type === "diff_rule_fired"), "the rules fired");
  const row = { ...storedRow(instanceRowValues(ORG, inst, DSL)) };
  const events = inst.history.map((h, i) => eventFromRow(storedEvent(eventValues(ORG, inst.id, h), i + 1)));
  const back = instanceFromRow(row, events.map(({ id: _id, instance_id: _i, ...h }) => h));
  // JSON keeps no key whose value is undefined (the engine leaves some on a step), so both sides are compared as JSON.
  const json = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(json(back), json({ ...withoutRecordData(inst), revision: 1, definition_version: definitionVersionOf(definitionHash(DSL)) }));
  assert.ok(Object.keys(back).every((k) => k in inst), "no field the engine does not have");
});

await check("the row carries the pinned definition, its hash, revision 1 and the record it runs on", async () => {
  const inst = await realInstance();
  const row = instanceRowValues(ORG, inst, DSL);
  assert.deepEqual(row.definition, DSL);
  assert.equal(row.definitionHash, definitionHash(DSL));
  assert.equal(row.revision, 1);
  assert.equal(row.entityType, "deployments");
  assert.equal(row.entityId, "rec-1");
  assert.equal(row.orgId, ORG);
});

await check("the record's own values are never stored; withRecordData puts the record's current values back", async () => {
  const inst = await realInstance();
  const row = instanceRowValues(ORG, inst, DSL);
  assert.ok(!JSON.stringify(row.engineState).includes("alpha"), "no record value in engine_state");
  assert.ok(!("task" in row.engineState) && !("object" in row.engineState) && !("history" in row.engineState));
  const back = instanceFromRow(storedRow(row), []);
  assert.deepEqual(back.object.data, {});
  const filled = withRecordData(back, { department: "alpha" });
  assert.deepEqual(filled.task, { department: "alpha" });
  assert.deepEqual(filled.object.data, { department: "alpha" });
  assert.deepEqual(back.task, {}, "withRecordData does not change the instance it was given");
});

await check("terminal: undefined (no completion condition) stays undefined, false and true are kept", async () => {
  const inst = await realInstance();
  for (const terminal of [undefined, false, true]) {
    const copy = { ...structuredClone(inst), terminal };
    if (terminal === undefined) delete copy.terminal;
    const back = instanceFromRow(storedRow(instanceRowValues(ORG, copy, DSL)), []);
    assert.equal(back.terminal, terminal);
    assert.equal("terminal" in back, terminal !== undefined);
  }
});

await check("an event's optional fields round-trip, and absent ones stay absent", () => {
  const full = { at: "2026-03-03T10:30:00.000Z", type: "step_patched", step_id: "s", detail: "d", data: { a: 1 }, actor: "p", source: "cohort", origin_instance_id: "other" };
  const bare = { at: "2026-03-03T10:30:00.000Z", type: "instance_created" };
  for (const e of [full, bare]) {
    const { id, instance_id, ...back } = eventFromRow(storedEvent(eventValues(ORG, "i1", e), 7));
    assert.equal(id, 7);
    assert.equal(instance_id, "i1");
    assert.deepEqual(back, e);
  }
  assert.throws(() => eventValues(ORG, "i1", { at: "not a time", type: "step_patched" }), /not a time/);
});

// ── 2. the definition's hash ───────────────────────────────────────────────────────────────────────────────────────

section("2. The pinned definition's hash");

await check("canonical JSON sorts keys at every depth and drops undefined, as JSON does", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } }), '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
  assert.equal(canonicalJson([undefined]), "[null]");
});

await check("the hash is sha256 hex, the same whatever order the keys were written in, and changes with the document", () => {
  const h = definitionHash(DSL);
  assert.match(h, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(DSL).reverse());
  assert.equal(definitionHash(reordered), h);
  const changed = structuredClone(DSL);
  changed.init.steps[0].title = "Prepare it";
  assert.notEqual(definitionHash(changed), h);
});

// ── 3. the scope ───────────────────────────────────────────────────────────────────────────────────────────────────

section("3. One store, one workspace, inside its scope");

for (const [label, scopedTo] of [["no workspace (the bare pool)", ""], ["another workspace", "org-store-b"]]) {
  await check(`a transaction scoped to ${label} is refused before anything is read or written`, async () => {
    const { db, sent } = recordingDb({ org: scopedTo });
    const store = new RecordWorkflowStore(db, ORG, { definitions: { "two-person-review": DSL } });
    const inst = await realInstance();
    await assert.rejects(store.create(inst, DSL), RecordWorkflowScopeError);
    await assert.rejects(store.get(inst.id), RecordWorkflowScopeError);
    await assert.rejects(store.listEvents(inst.id), RecordWorkflowScopeError);
    assert.deepEqual(statements(sent), [], "nothing but the scope check was sent");
  });
}

await check("a store needs a workspace id", () => {
  assert.throws(() => new RecordWorkflowStore(recordingDb().db, ""), /needs a workspace id/);
});

await check("an instance of another workspace is refused before anything is sent", async () => {
  const { db, sent } = recordingDb();
  const store = new RecordWorkflowStore(db, ORG);
  const other = await realInstance({ org: "org-store-b" });
  await assert.rejects(store.create(other, DSL), RecordWorkflowScopeError);
  await assert.rejects(store.update({ ...other, revision: 1 }), RecordWorkflowScopeError);
  assert.deepEqual(statements(sent), []);
});

await check("every statement of a create, a read, an update, an append and the lists names the store's workspace", async () => {
  const inst = await realInstance();
  const row = storedRow(instanceRowValues(ORG, inst, DSL));
  const { db, sent } = recordingDb({
    answers: [
      [{ id: inst.id }], [], // create: insert instance, insert events
      [row], [], // get: instance, events
      [{ n: inst.history.length }], [{ revision: 2, version: null }], // update: count, CAS (nothing new to insert)
      [{ revision: 3 }], [storedEvent(eventValues(ORG, inst.id, { at: inst.updated_at, type: "comment_added" }), 9)], // appendEvent
      [], [row], [], [row], [], [row], [], [row], // listEvents, listByEntity(+events), listInstances(+events), page(+events), forObjects
      [{ workflowId: "two-person-review", definition: DSL, hash: definitionHash(DSL) }], // getDefinition
    ],
  });
  const store = new RecordWorkflowStore(db, ORG);
  assert.equal((await store.create(inst, DSL)).ok, true);
  const got = await store.get(inst.id);
  assert.equal(got.id, inst.id);
  assert.equal((await store.update({ ...inst, revision: 1 })).ok, true);
  assert.equal((await store.appendEvent(inst.id, { at: inst.updated_at, type: "comment_added" })).revision, 3);
  await store.listEvents(inst.id);
  await store.listByEntity("deployments", "rec-1");
  await store.listInstances();
  await store.listInstancesPage(ORG, undefined, undefined, 10);
  await store.listInstancesForObjects(ORG, "deployments", ["rec-1"]);
  assert.equal((await store.getDefinition(inst.id)).definition_hash, definitionHash(DSL));
  const sql = statements(sent);
  assert.ok(sql.length >= 14, `statements sent: ${sql.length}`);
  for (const q of sql) {
    if (kind(q) === "insert") {
      // An insert names the workspace as the value of its org_id column, in every row.
      const cols = q.sql.match(/\(([^)]*)\) values/i)[1].split(",").map((c) => c.trim());
      const at = cols.indexOf('"org_id"');
      assert.ok(at >= 0, `insert names org_id: ${q.sql}`);
      assert.ok(q.params.includes(ORG), q.sql);
    } else {
      assert.match(q.sql, /"org_id" = \$\d+/, q.sql);
      assert.ok(q.params.includes(ORG), `${q.sql} ${JSON.stringify(q.params)}`);
    }
  }
  assert.equal(sent.filter((q) => /current_setting/.test(q.sql)).length, 1, "the scope is checked once per store");
});

await check("asked about another workspace, the engine's methods answer nothing and send nothing", async () => {
  const { db, sent } = recordingDb();
  const store = new RecordWorkflowStore(db, ORG, { definitions: { "two-person-review": DSL } });
  const B = "org-store-b";
  assert.equal(await store.getInstance("x", B), undefined);
  assert.deepEqual(await store.listInstances(undefined, B), []);
  assert.deepEqual(await store.listInstancesPage(B, undefined, undefined, 5), { items: [] });
  assert.deepEqual(await store.listObjectInstances(B, "deployments", "rec-1"), []);
  assert.deepEqual(await store.listInstancesForObjects(B, "deployments", ["rec-1"]), []);
  assert.equal(await store.findAttachment(B, "two-person-review", "deployments", "rec-1"), undefined);
  assert.equal(await store.getWorkflow("two-person-review", B), undefined);
  assert.deepEqual(await store.listWorkflows(B), []);
  assert.deepEqual(sent, []);
});

// ── 4. conflicts ───────────────────────────────────────────────────────────────────────────────────────────────────

section("4. Conflicts: typed, 409, and nothing written after them");

await check("a stale revision: the engine's conflict type, STALE_REVISION, 409, both revisions named; no event inserted", async () => {
  const inst = await realInstance();
  const { db, sent } = recordingDb({ answers: [[{ n: inst.history.length }], [], [{ revision: 5 }]] });
  const store = new RecordWorkflowStore(db, ORG);
  const r = await store.update({ ...inst, revision: 3 });
  assert.equal(r.ok, false);
  assert.ok(r.conflict instanceof PersistenceConflictError, "the engine's PersistenceConflictError");
  assert.ok(isRecordWorkflowConflict(r.conflict));
  assert.equal(r.conflict.code, "STALE_REVISION");
  assert.equal(r.conflict.status, 409);
  assert.equal(r.conflict.reason, "stale_revision");
  assert.equal(r.conflict.expected, 3);
  assert.equal(r.conflict.current, 5);
  const sql = statements(sent);
  assert.deepEqual(sql.map(kind), ["select", "update", "select"]);
  assert.match(sql[1].sql, /"revision" = \$\d+/, "the update is conditional on the revision read");
  assert.ok(!sql.some((q) => kind(q) === "insert"), "no event is appended");
});

await check("a missing instance is a conflict too (reason missing, current undefined)", async () => {
  const inst = await realInstance();
  const { db } = recordingDb({ answers: [[{ n: 0 }], [], []] });
  const r = await new RecordWorkflowStore(db, ORG).update({ ...inst, revision: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.conflict.reason, "missing");
  assert.equal(r.conflict.current, undefined);
  assert.equal(r.conflict.code, "STALE_REVISION");
});

await check("a record that already runs the workflow: reason attached, code CONFLICT; the insert never raises (ON CONFLICT DO NOTHING) and no event is inserted", async () => {
  const inst = await realInstance();
  const { db, sent } = recordingDb({ answers: [[]] });
  const r = await new RecordWorkflowStore(db, ORG).create(inst, DSL);
  assert.equal(r.ok, false);
  assert.equal(r.conflict.reason, "attached");
  assert.equal(r.conflict.code, "CONFLICT");
  assert.equal(r.conflict.status, 409);
  const sql = statements(sent);
  assert.equal(sql.length, 1);
  assert.match(sql[0].sql, /on conflict do nothing/i);
});

await check("create needs revision 0 (a fresh engine instance); another is a stale-revision conflict and sends nothing", async () => {
  const inst = await realInstance();
  const { db, sent } = recordingDb();
  const r = await new RecordWorkflowStore(db, ORG).create({ ...inst, revision: 2 }, DSL);
  assert.equal(r.ok, false);
  assert.equal(r.conflict.reason, "stale_revision");
  assert.deepEqual(statements(sent), []);
});

await check("saveInstance throws the conflict (as the engine's stores do) and sets the revision on success", async () => {
  const inst = await realInstance();
  const stale = recordingDb({ answers: [[{ n: 0 }], [], [{ revision: 4 }]] });
  await assert.rejects(new RecordWorkflowStore(stale.db, ORG).saveInstance({ ...inst, revision: 2 }), (e) => e instanceof RecordWorkflowConflict && e.status === 409);
  const fresh = recordingDb({ answers: [[{ id: inst.id }], []] });
  const copy = structuredClone(inst);
  await new RecordWorkflowStore(fresh.db, ORG, { definitions: { "two-person-review": DSL } }).saveInstance(copy);
  assert.equal(copy.revision, 1);
  assert.equal(copy.definition_version, 1, "saveInstance sets only the revision, as the engine's stores do");
  const pinned = statements(fresh.sent)[0];
  assert.ok(pinned.params.includes(definitionHash(DSL)), "the definition it pinned is the one the deployment declares");
  const none = recordingDb();
  await assert.rejects(new RecordWorkflowStore(none.db, ORG).saveInstance(structuredClone(inst)), /no definition for workflow "two-person-review"/);
  assert.deepEqual(statements(none.sent), []);
});

// ── 5. history ─────────────────────────────────────────────────────────────────────────────────────────────────────

section("5. History: append-only, in order");

await check("an update inserts only the events after the stored ones, in one statement, in order", async () => {
  const inst = await realInstance();
  const stored = inst.history.length;
  const changed = structuredClone(inst);
  changed.revision = 1;
  changed.history.push({ at: "2026-03-04T08:00:00.000Z", type: "comment_added", step_id: "review", actor: "p-checker", source: "user" });
  changed.history.push({ at: "2026-03-04T08:00:00.000Z", type: "state_changed", step_id: "review", actor: "p-checker", source: "user" });
  const { db, sent } = recordingDb({ answers: [[{ n: stored }], [{ revision: 2, version: definitionVersionOf(definitionHash(DSL)) }], []] });
  const r = await new RecordWorkflowStore(db, ORG).update(changed);
  assert.equal(r.ok, true);
  assert.equal(r.instance.revision, 2);
  assert.equal(r.instance.definition_version, definitionVersionOf(definitionHash(DSL)), "the stored (pinned) version, not the caller's");
  const cas = statements(sent).find((q) => kind(q) === "update");
  assert.match(cas.sql, /jsonb_build_object\('definition_version', "record_workflow_instances"\."engine_state"->'definition_version'\)/, "the update keeps the stored definition version");
  const inserts = statements(sent).filter((q) => kind(q) === "insert");
  assert.equal(inserts.length, 1);
  assert.ok(touches(inserts[0], "record_workflow_events"));
  const types = inserts[0].params.filter((p) => p === "comment_added" || p === "state_changed");
  assert.deepEqual(types, ["comment_added", "state_changed"], "in the order the engine appended them");
});

await check("a create inserts the whole history so far after the instance", async () => {
  const inst = await realInstance();
  const { db, sent } = recordingDb({ answers: [[{ id: inst.id }], []] });
  await new RecordWorkflowStore(db, ORG).create(inst, DSL);
  const sql = statements(sent);
  assert.deepEqual(sql.map((q) => [kind(q), touches(q, "record_workflow_instances") ? "instances" : "events"]), [["insert", "instances"], ["insert", "events"]]);
  assert.equal(sql[1].params.filter((p) => p === ORG).length, inst.history.length);
});

await check("a history shorter than what is stored is a conflict (history_mismatch, 409) found BEFORE anything is written", async () => {
  const inst = await realInstance();
  const { db, sent } = recordingDb({ answers: [[{ n: inst.history.length + 1 }]] });
  const r = await new RecordWorkflowStore(db, ORG).update({ ...inst, revision: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.conflict instanceof RecordWorkflowConflict && r.conflict instanceof PersistenceConflictError);
  assert.equal(r.conflict.reason, "history_mismatch");
  assert.equal(r.conflict.status, 409);
  assert.match(r.conflict.message, /append-only/);
  assert.deepEqual(statements(sent).map(kind), ["select"], "only the count: no UPDATE, no INSERT");
});

await check("an instance from listInstancesForObjects (a summary, history: []) cannot be saved over a stored history", async () => {
  const inst = await realInstance();
  const row = storedRow(instanceRowValues(ORG, inst, DSL));
  const { db, sent } = recordingDb({ answers: [[row], [{ n: inst.history.length }]] });
  const store = new RecordWorkflowStore(db, ORG);
  const [summary] = await store.listInstancesForObjects(ORG, "deployments", ["rec-1"]);
  assert.equal(summary.history, undefined, "the summary carries no history");
  const r = await store.update({ ...summary, organization_id: ORG, steps: summary.steps, revision: 1, history: [] });
  assert.equal(r.ok, false);
  assert.equal(r.conflict.reason, "history_mismatch");
  assert.ok(!statements(sent).some((q) => kind(q) === "update" || kind(q) === "insert"), "nothing written");
  const saved = recordingDb({ answers: [[{ n: inst.history.length }]] });
  await assert.rejects(new RecordWorkflowStore(saved.db, ORG).saveInstance({ ...summary, organization_id: ORG, revision: 1, history: [] }), (e) => e instanceof RecordWorkflowConflict && e.reason === "history_mismatch");
});

await check("appending an event moves the revision on, and does nothing for an instance this workspace does not have", async () => {
  const { db, sent } = recordingDb({ answers: [[]] });
  const r = await new RecordWorkflowStore(db, ORG).appendEvent("nope", { at: "2026-03-04T08:00:00.000Z", type: "comment_added" });
  assert.equal(r, undefined);
  const sql = statements(sent);
  assert.deepEqual(sql.map(kind), ["update"]);
  assert.match(sql[0].sql, /"revision" = \("record_workflow_instances"\."revision" \+ 1\)|"revision" = "record_workflow_instances"\."revision" \+ 1/);
  assert.match(sql[0].sql, /"updated_at" = greatest\("record_workflow_instances"\."updated_at", \$\d+::timestamptz\)/, "updated_at never moves backwards");
});

await check("events are listed in append order (the identity), never re-sorted by their times", async () => {
  const { db, sent } = recordingDb({ answers: [[]] });
  await new RecordWorkflowStore(db, ORG).listEvents("i1");
  assert.match(statements(sent)[0].sql, /order by "record_workflow_events"\."id" asc/i);
});

// ── 6. what it does not carry ──────────────────────────────────────────────────────────────────────────────────────

section("6. What this store does not carry");

await check("definitions come from the build: getWorkflow reads them, versioned by their hash; registering, changing and deleting throw", async () => {
  const { db, sent } = recordingDb();
  const store = new RecordWorkflowStore(db, ORG, { definitions: { "two-person-review": DSL } });
  const w = await store.getWorkflow("two-person-review");
  assert.deepEqual(w.dsl, DSL);
  assert.equal(w.version, definitionVersionOf(definitionHash(DSL)));
  assert.equal(w.organization_id, ORG);
  assert.equal(await store.getWorkflow("nope"), undefined);
  assert.equal(await store.getWorkflow("toString"), undefined, "an inherited property is not a definition");
  assert.deepEqual((await store.getWorkflowVersion("two-person-review", w.version)).dsl, DSL, "the current version is answered without a query");
  assert.equal(await store.getWorkflowVersion("two-person-review", 0), undefined, "a number no hash maps to");
  assert.deepEqual((await store.listWorkflows()).map((x) => x.id), ["two-person-review"]);
  for (const call of [() => store.registerWorkflow(w), () => store.upsertWorkflow(w), () => store.deleteWorkflow("two-person-review")]) {
    await assert.rejects(call(), RecordWorkflowNotSupported);
  }
  assert.deepEqual(sent, []);
});

await check("a version is keyed by the document's hash: distinct documents, distinct versions, the same in every process", () => {
  const changed = structuredClone(DSL);
  changed.diff = [];
  const v1 = definitionVersionOf(definitionHash(DSL));
  const v2 = definitionVersionOf(definitionHash(changed));
  assert.ok(Number.isSafeInteger(v1) && v1 >= 1 && v1 <= 2 ** 48);
  assert.notEqual(v1, v2);
  assert.equal(definitionVersionOf(definitionHash(structuredClone(DSL))), v1);
  assert.throws(() => definitionVersionOf("nope"), /not a definition hash/);
});

await check("getWorkflowVersion answers an older version with the copy an instance was pinned to (one scoped read), never the current document", async () => {
  const changed = structuredClone(DSL);
  changed.diff = [];
  const pinnedVersion = definitionVersionOf(definitionHash(DSL));
  const { db, sent } = recordingDb({ answers: [[{ definition: DSL, hash: definitionHash(DSL), createdAt: new Date("2026-03-02T09:00:00.000Z") }]] });
  const store = new RecordWorkflowStore(db, ORG, { definitions: { "two-person-review": changed } });
  assert.notEqual((await store.getWorkflow("two-person-review")).version, pinnedVersion, "the deployment's document changed");
  const pinned = await store.getWorkflowVersion("two-person-review", pinnedVersion);
  assert.deepEqual(pinned.dsl, DSL);
  assert.equal(pinned.version, pinnedVersion);
  const q = statements(sent);
  assert.equal(q.length, 1);
  assert.match(q[0].sql, /"definition_hash" like \$\d+/);
  assert.ok(q[0].params.includes(`${(pinnedVersion - 1).toString(16).padStart(12, "0")}%`) && q[0].params.includes(ORG), q[0].params);
  const none = recordingDb({ answers: [[]] });
  assert.equal(await new RecordWorkflowStore(none.db, ORG, { definitions: { "two-person-review": changed } }).getWorkflowVersion("two-person-review", pinnedVersion), undefined);
});

await check("the identity snapshot is not kept here (undefined: phase 4/5 supply it), and an object scope moves nothing", async () => {
  const { db, sent } = recordingDb();
  const store = new RecordWorkflowStore(db, ORG);
  assert.equal(await store.getIdentitySnapshot(ORG), undefined);
  assert.deepEqual(await store.reassignObjectScope(ORG, "deployments", "rec-1", { department: "beta" }), { matched: 0, updated: 0 });
  assert.deepEqual(sent, []);
});

await check("storing an identity snapshot, callbacks and job leases throw 'not supported' and send nothing", async () => {
  const { db, sent } = recordingDb();
  const store = new RecordWorkflowStore(db, ORG);
  const calls = [
    () => store.replaceIdentitySnapshot({ organization_id: ORG }),
    () => store.claimCallbackEvent(ORG, "e", "f"),
    () => store.completeCallbackEvent(ORG, "e"),
    () => store.failCallbackEvent(ORG, "e", "x"),
    () => store.getJobCheckpoint(ORG, "j"),
    () => store.claimJobLease(ORG, "j", "o", 30),
    () => store.saveJobCheckpoint({ organization_id: ORG, job_id: "j", revision: 1, updated_at: "" }, "o"),
    () => store.releaseJobLease(ORG, "j", "o"),
  ];
  for (const call of calls) await assert.rejects(call(), RecordWorkflowNotSupported);
  assert.deepEqual(sent, []);
});

// ── 7. the migration and the journal ───────────────────────────────────────────────────────────────────────────────

section("7. drizzle/0047 and the journal");

const TAG = "0047_record_workflows";
const MIGRATION = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8");
const CODE = MIGRATION.replace(/^--.*$/gm, "");
const TABLES = ["record_workflow_instances", "record_workflow_events"];

await check("both tables: ENABLE and FORCE row-level security, and the org_isolation policy on app.org_id for reads and writes", () => {
  for (const t of TABLES) {
    assert.match(CODE, new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    assert.match(CODE, new RegExp(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    const policy = CODE.match(new RegExp(`CREATE POLICY "org_isolation" ON "${t}"\\s+USING \\(([^;]*?)\\)\\s+WITH CHECK \\(([^;]*?)\\);`));
    assert.ok(policy, `policy on ${t}`);
    for (const p of [policy[1], policy[2]]) assert.match(p, /"org_id" = current_setting\('app\.org_id', true\)/);
  }
});

await check("the history is append-only for app_rw (SELECT and INSERT; UPDATE and DELETE revoked) and an instance with a history cannot be deleted (RESTRICT)", () => {
  assert.match(CODE, /GRANT SELECT, INSERT ON "record_workflow_events" TO app_rw;/);
  assert.match(CODE, /REVOKE UPDATE, DELETE, TRUNCATE ON "record_workflow_events" FROM app_rw;/);
  assert.match(CODE, /REFERENCES "public"\."record_workflow_instances"\("org_id","id"\) ON DELETE restrict/);
  assert.doesNotMatch(CODE, /ON DELETE cascade/i);
  const fk = getTableConfig(schema.recordWorkflowEvents).foreignKeys[0];
  assert.equal(fk.onDelete, "restrict");
  const lib = readFileSync(join(ROOT, "scripts/lib/append-only-tables.mjs"), "utf8");
  assert.match(lib, /"record_workflow_events"/);
  for (const f of [".bootstrap-supabase.mjs", "scripts/bootstrap-test-db.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const grant = src.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    const revoke = src.indexOf("applyAppendOnlyGrants(sql)");
    assert.ok(grant >= 0 && revoke > grant, `${f} takes UPDATE and DELETE back after its grant on ALL TABLES`);
  }
});

await check("additive: it creates its two tables, their indexes and constraint, and alters, drops or touches nothing else", () => {
  assert.doesNotMatch(CODE, /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA)\b/i);
  const altered = [...CODE.matchAll(/ALTER\s+TABLE\s+"([^"]+)"/gi)].map((m) => m[1]);
  assert.ok(altered.length > 0 && altered.every((t) => TABLES.includes(t)), altered.join(", "));
  const created = [...CODE.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(created, TABLES);
  const indexed = [...CODE.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"[^"]+"\s+ON\s+"([^"]+)"/gi)].map((m) => m[1]);
  assert.ok(indexed.every((t) => TABLES.includes(t)), indexed.join(", "));
  assert.doesNotMatch(CODE, /^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im, "no data is touched");
});

await check("the migration's columns are schema.ts's columns, table by table", () => {
  for (const [t, table] of [["record_workflow_instances", schema.recordWorkflowInstances], ["record_workflow_events", schema.recordWorkflowEvents]]) {
    const body = CODE.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}" \\(([\\s\\S]*?)\\n\\);`))[1];
    const sqlCols = [...body.matchAll(/^\s*"([a-z_]+)"\s/gm)].map((m) => m[1]).sort();
    const tsCols = getTableConfig(table).columns.map((c) => c.name).sort();
    assert.deepEqual(sqlCols, tsCols, t);
  }
  const unique = getTableConfig(schema.recordWorkflowInstances).indexes.find((i) => i.config.unique);
  assert.deepEqual(unique.config.columns.map((c) => c.name), ["org_id", "entity_type", "entity_id", "workflow_id"]);
  assert.match(CODE, /CREATE UNIQUE INDEX IF NOT EXISTS "record_workflow_instances_entity_uidx" ON "record_workflow_instances" USING btree \("org_id","entity_type","entity_id","workflow_id"\)/);
  assert.match(CODE, /CREATE INDEX IF NOT EXISTS "record_workflow_events_instance_at_idx" ON "record_workflow_events" USING btree \("org_id","instance_id","at"\)/);
});

await check("the journal carries it at its own index, after every other entry, with a later `when` than the one before", () => {
  const { entries } = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = entries.findIndex((e) => e.tag === TAG);
  assert.ok(at > 0, "in the journal");
  assert.ok(entries.every((e, i) => e.idx === i), "every entry's idx is its position (drizzle's migrator and the tests read it so)");
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].when > entries[i - 1].when, `${entries[i].tag} is later than ${entries[i - 1].tag}`);
  // migrate-production applies what is later than the last applied `when`: a database that took 0046 (the people
  // directory, 1793400000000) must still take this one.
  assert.ok(entries[at].when > 1793400000000, "later than 0046's when");
});

// ── 8. only the write path calls it ────────────────────────────────────────────────────────────────────────────────

section("8. Only the write path calls the store");

await check("no file outside the store's tests and the record write path (lib/record-workflow-moves.ts) imports it", () => {
  const out = execFileSync("git", ["grep", "--untracked", "-l", "-E", "record-workflow-store(\\.ts)?[\"'`]", "--", "*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"], { cwd: ROOT, encoding: "utf8" });
  // Phase 5: every door that moves a record of an area running a workflow reaches the store through
  // lib/record-workflow-moves.ts, in its own workspace-scoped transaction; nothing else names it.
  const names = out.split("\n").filter(Boolean).filter((f) => !["lib/record-workflow-store.ts", "scripts/test-record-workflow-store.mjs", "scripts/test-record-workflow-store-db.mjs", "scripts/test-workflow-engine.mjs", "lib/record-workflow-moves.ts", "scripts/test-record-workflow-runtime.mjs", "scripts/lib/record-workflow-runtime-db-probe.mjs"].includes(f));
  assert.deepEqual(names, []);
});

console.log(`\ntest-record-workflow-store: ${passed} checks passed${process.exitCode ? ", SOME FAILED" : ""}`);
