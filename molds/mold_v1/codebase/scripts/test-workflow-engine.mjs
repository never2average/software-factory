/**
 * THE VENDORED WORKFLOW ENGINE, OFFLINE (lib/workflow-engine/, lib/workflow-step-rules.ts;
 * docs/WORKFLOW_ENGINE.md).
 *
 * Ports the behaviour the upstream engine's own tests cover (bun:test, against its HTTP service) to the vendored core
 * and the rebuilt step rules, on neutral fixtures (scripts/fixtures/workflows/: people.json and one workflow per file).
 * Where upstream drove a route, this drives `act()` below: a stand-in for the route that calls the step rules in
 * upstream's order and then the engine (runDiff, terminal, cohorts). It is test scaffolding, not wiring; nothing in the
 * app calls the engine yet.
 *
 *   1. LOADING: every vendored file loads under --experimental-strip-types, and nothing outside the engine's own glue
 *      imports it (so this change alters no runtime behaviour).
 *   2. VALIDATION: spec.json (Draft 2020-12, through Ajv, a devDependency) and dsl/validate.ts, on every fixture and on
 *      each class of authoring error upstream refuses.
 *   3. THE MATCHER and the $object substitution (fails closed).
 *   4. INIT, DIFF, STATE: materializing, routing, send-backs, guards, quorum, once, gateways, terminal, transitions.
 *   5. ASSIGNMENT: presence, balancing, relative (up), anchored (down), self and supervisor reassignment, pinning.
 *   6. THE STEP RULES: demands, transitions, dormant steps, the due-date extension, patch shape, who a patch needs.
 *   7. COHORTS, MIGRATED STEPS, RBAC, THE DIAGRAM, THE IN-MEMORY STORE, IDENTITY.
 *   8. THE COVERAGE MAP in UPSTREAM.json names every upstream test file, and every case it names exists here.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-workflow-engine.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { PLATFORM_USER_ATTRIBUTES, STEP_STATES } from "../lib/workflow-engine/dsl/types.ts";
import { assertValidWorkflow, declaredUserAttributes, validateWorkflow } from "../lib/workflow-engine/dsl/validate.ts";
import { WorkloadBalancer, openLoad } from "../lib/workflow-engine/engine/src/core/balancer.ts";
import { renderWorkflowMermaid, stepConditions } from "../lib/workflow-engine/engine/src/core/diagram.ts";
import { isTerminal, poolSatisfies, reresolveOnEnter, resolveRelative, runCohortRules, runDiff, transitionError } from "../lib/workflow-engine/engine/src/core/diff.ts";
import { Directory, offlineEvaluator } from "../lib/workflow-engine/engine/src/core/evaluator.ts";
import { DEFAULT_ORGANIZATION_ID, SignedGatewayIdentityProvider, organizationId } from "../lib/workflow-engine/engine/src/core/identity.ts";
import { flatOrder, initInstance, resolveAssignees, taskMatchesInit } from "../lib/workflow-engine/engine/src/core/init.ts";
import { UNRESOLVED, get, matches, substituteObject } from "../lib/workflow-engine/engine/src/core/mongo.ts";
import { Rbac } from "../lib/workflow-engine/engine/src/core/rbac.ts";
import { isMutableStepProperty, setStepProperty, stepPropertyValue } from "../lib/workflow-engine/engine/src/core/state.ts";
import { InMemoryStore, PersistenceConflictError } from "../lib/workflow-engine/engine/src/core/store.ts";
import { projectSummaryFields } from "../lib/workflow-engine/engine/src/core/summary.ts";
import { validateIdentitySnapshot } from "../lib/workflow-engine/engine/src/integrations/identity.ts";
import {
  MAX_CONTRIBUTION_CHARS, PATCHABLE, afterPersonPatch, changesDueOn, checkContributionLength, checkContributionOnDormant,
  checkDemandLowering, checkDueOnChange, checkPatchShape, checkReassign, checkStateChange, cleanContribution, demandsFor,
  dueDateExtendedEvent, instanceResource, patchNeeds, stepActResource, stepName,
} from "../lib/workflow-step-rules.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const FIX = join(ROOT, "scripts/fixtures/workflows");
const ENGINE = join(ROOT, "lib/workflow-engine");
const require = createRequire(import.meta.url);

let passed = 0;
const ran = [];
const check = async (what, fn) => {
  ran.push(what);
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

// ── the world: people, roles, the reporting matrix, workflows, instances ───────────────────────────────────────────

const PEOPLE = JSON.parse(readFileSync(join(FIX, "people.json"), "utf8"));
const FIXTURE_NAMES = readdirSync(FIX).filter((f) => f.endsWith(".json") && f !== "people.json").map((f) => f.replace(/\.json$/, "")).sort();
const fixture = (name) => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));
const clone = (v) => structuredClone(v);

/** Denormalized reporting_managers -> matrix rows, each scoped to the reportee's business unit (upstream's reportingRowsFrom). */
const reportingRowsFrom = (users) =>
  users.flatMap((u) => (u.reporting_managers ?? []).map((m) => ({ reporting_manager: m, reportee: u.id, business_unit: u.business_unit })));

function world({ org = "org-a", users = PEOPLE.users, roles = PEOPLE.roles, instances = [] } = {}) {
  const directory = new Directory();
  directory.seed(clone(users), org);
  const rbac = new Rbac();
  rbac.seedRoles(clone(roles), org);
  rbac.addReporting(reportingRowsFrom(users), org);
  const definitions = new Map(FIXTURE_NAMES.map((n) => [n, fixture(n)]));
  const w = {
    org, directory, rbac, instances, definitions,
    balancer: new WorkloadBalancer(() => instances),
    dsl: (id) => w.definitions.get(id),
    /** initInstance for a registered (or given) workflow, kept in the world's instance list. */
    attach(id, task = {}, { dsl, now = new Date(), actor = "p-admin", objectId } = {}) {
      if (dsl) w.definitions.set(id, dsl);
      const inst = initInstance(id, w.dsl(id), task, directory, now, actor, w.balancer, org, { type: "record", id: objectId ?? `rec-${instances.length + 1}` });
      inst.created_by = actor;
      inst.terminal = isTerminal(w.dsl(id), inst);
      instances.push(inst);
      return inst;
    },
  };
  return w;
}
const stepOf = (inst, id) => inst.steps.find((s) => s.id === id);
const holders = (inst, id) => stepOf(inst, id).assignee;

/**
 * A person's change to one step, the way upstream's PATCH route makes it (engine/src/app.ts), with the step rules of
 * lib/workflow-step-rules.ts in its order: the patch's shape, the base permission, the write-only rules (lowering
 * a demand, reassignment, the due-date extension), activation, acting on the step, a dormant step, the state change and
 * its demands; then the change, its history rows, re-resolution, runDiff, the terminal flag and the cohort pass.
 * Answers { status, code? }.
 */
async function act(w, inst, stepId, body, actorId, { now = new Date(), actsWithoutHolding = false } = {}) {
  const dsl = w.dsl(inst.workflow_id);
  const actor = w.directory.get(actorId, inst.organization_id);
  if (!actor) return { status: 401 };
  const step = stepOf(inst, stepId);
  if (!step) return { status: 404 };
  const { comment, evidence, ...patch } = body;
  const commentText = cleanContribution(comment);
  const evidenceRef = cleanContribution(evidence);
  const refused = (r) => ({ status: r.status, code: r.code, message: r.message });
  for (const [name, text] of [["comment", commentText], ["evidence", evidenceRef]]) {
    const r = checkContributionLength(name, text);
    if (!r.ok) return refused(r);
  }
  let r = checkPatchShape(patch);
  if (!r.ok) return refused(r);
  const contributes = !!(commentText || evidenceRef);
  const resource = instanceResource(inst);
  const needs = patchNeeds({ step, patch, contributes, actsWithoutHolding, actorId });
  const forbidden = { status: 403, code: "FORBIDDEN" };
  if (!w.rbac.can(actor, needs.base, resource)) return forbidden;
  const canWrite = w.rbac.can(actor, "write", resource);
  const standingWrite = w.rbac.can(actor, "write", resource, { ignoreGrants: true });
  const contributionOnly = Object.keys(patch).length === 0 && contributes;
  if (contributionOnly && !standingWrite && !w.rbac.can(actor, "act", stepActResource(inst, step))) return forbidden;
  const evidenceIsNew = !!evidenceRef && !step.evidence.some((e) => e.ref === evidenceRef);
  if (contributionOnly && !commentText && !evidenceIsNew) return { status: 200, noop: true };
  const isAdmin = w.rbac.can(actor, "admin", resource);
  let extended = false;
  if (needs.write) {
    if (!canWrite) return forbidden;
    r = checkDemandLowering(step, patch, isAdmin);
    if (!r.ok) return refused(r);
    if (patch.assignee) {
      r = checkReassign({ rbac: w.rbac, actor, instance: inst, step, next: patch.assignee, dsl, directory: w.directory, org: w.rbac, actsWithoutHolding });
      if (!r.ok) return refused(r);
    }
    if ("due_on" in patch) {
      r = checkDueOnChange({ dsl, instance: inst, step, requested: patch.due_on, isAdmin, now: now.getTime() });
      if (!r.ok) return refused(r);
      extended = !!r.extended;
    }
  }
  if (needs.admin && !isAdmin) return forbidden;
  if (needs.actOnStep && !w.rbac.can(actor, "act", stepActResource(inst, step))) return forbidden;
  r = checkContributionOnDormant(step, contributes, canWrite);
  if (!r.ok) return refused(r);
  if ("state" in patch) {
    r = checkStateChange({ dsl, instance: inst, step, to: patch.state, comment: commentText, evidence: evidenceRef });
    if (!r.ok) return refused(r);
  }

  const change = { stepId, changed: {} };
  for (const [prop, after] of Object.entries(patch)) {
    if (!isMutableStepProperty(prop)) continue;
    const before = stepPropertyValue(step, prop);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    assert.ok(setStepProperty(step, prop, after));
    change.changed[prop] = { before, after };
  }
  const at = now.toISOString();
  const transition = change.changed.state ? `${change.changed.state.before} → ${change.changed.state.after}` : undefined;
  if (commentText) {
    step.comments.push({ at, actor: actorId, text: commentText, on_transition: transition });
    inst.history.push({ at, type: "comment_added", step_id: stepId, detail: transition, data: { text: commentText }, actor: actorId, source: "user" });
  }
  if (evidenceIsNew) {
    step.evidence.push({ at, actor: actorId, ref: evidenceRef, on_transition: transition });
    inst.history.push({ at, type: "evidence_added", step_id: stepId, detail: transition, data: { ref: evidenceRef }, actor: actorId, source: "user" });
  }
  if (Object.keys(change.changed).length) {
    inst.history.push({ at, type: "step_patched", step_id: stepId, data: change.changed, actor: actorId, source: "user" });
    if (change.changed.state) inst.history.push({ at, type: "state_changed", step_id: stepId, detail: transition, data: change.changed.state, actor: actorId, source: "user" });
    if (extended && change.changed.due_on) inst.history.push(dueDateExtendedEvent(stepId, change.changed.due_on.before, change.changed.due_on.after, actorId, at));
    afterPersonPatch({ step, change, dsl, directory: w.directory, instance: inst, at, actorId, balancer: w.balancer, org: w.rbac });
    await runDiff(inst, dsl, change, w.directory, offlineEvaluator, now, actorId, w.balancer, w.rbac);
    inst.terminal = isTerminal(dsl, inst);
    const touched = runCohortRules(w.instances, (i) => w.dsl(i.workflow_id), inst, w.directory, now, actorId, w.balancer);
    for (const t of touched) t.terminal = isTerminal(w.dsl(t.workflow_id), t);
  }
  return { status: 200 };
}
const SUBMIT = { comment: "done", evidence: "doc://evidence/1" };

// ── 1. loading ───────────────────────────────────────────────────────────────────────────────────────────────────

section("1. Loading");

await check("loading: every vendored TypeScript file loads under --experimental-strip-types", async () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "lib/workflow-engine"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 14, `expected the vendored .ts files, found ${files.length}`);
  for (const f of files) await import(join(ROOT, f));
});

await check("loading: nothing outside the engine's own glue imports the vendored engine (no runtime behaviour changes)", () => {
  const GLUE = new Set(["lib/workflow-step-rules.ts", "scripts/test-workflow-engine.mjs", "scripts/sync-workflow-engine.mjs"]);
  const out = execFileSync("git", ["grep", "--untracked", "-l", "-E", "workflow-engine/|workflow-step-rules", "--", "*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"], { cwd: ROOT, encoding: "utf8" });
  const importers = out.split("\n").filter(Boolean).filter((f) => !f.startsWith("lib/workflow-engine/") && !GLUE.has(f));
  assert.deepEqual(importers, [], `files outside the glue name the engine: ${importers.join(", ")}`);
});

// ── 2. validation ────────────────────────────────────────────────────────────────────────────────────────────────

section("2. Validation (spec.json through Ajv, and dsl/validate.ts)");

const Ajv2020 = require("ajv/dist/2020").default;
const spec = JSON.parse(readFileSync(join(ENGINE, "dsl/spec.json"), "utf8"));
const structural = new Ajv2020({ allErrors: true, strict: true }).compile(spec);
const messages = (issues) => issues.map((i) => `${i.path}: ${i.message}`).join("\n");
const issuesOf = (doc) => messages(validateWorkflow(doc));

await check("validation: spec.json compiles as a strict Draft 2020-12 schema", () => {
  assert.equal(typeof structural, "function");
  assert.equal(spec.$schema, "https://json-schema.org/draft/2020-12/schema");
});

await check("validation: every fixture passes the structural contract and the semantic validator", () => {
  assert.ok(FIXTURE_NAMES.length >= 11, `expected the 11 fixtures, found ${FIXTURE_NAMES.length}`);
  for (const name of FIXTURE_NAMES) {
    const doc = fixture(name);
    assert.ok(structural(doc), `${name}: ${JSON.stringify(structural.errors)}`);
    assert.deepEqual(validateWorkflow(doc), [], `${name}: ${issuesOf(doc)}`);
  }
});

await check("validation: the structural contract refuses unknown fields and malformed entries (no semantic pass on them)", () => {
  const doc = fixture("two-person-review");
  assert.equal(structural({ ...doc, surprise: true }), false);
  assert.equal(structural({ ...doc, init: { ...doc.init, steps: [null] } }), false);
  assert.equal(structural({ ...doc, user_attributes: [{ key: "duty", options: ["a"], extra: 1 }] }), false);
});

await check("validation: an invalid document is refused with its paths (start_id, duplicate ids, empty diff rule)", () => {
  const issues = validateWorkflow({ init: { start_id: "nope", steps: [{ id: "s1", title: "A" }, { id: "s1", title: "B" }] }, diff: [{}] });
  const text = messages(issues);
  assert.match(text, /init\.start_id: start_id "nope" is not a step id/);
  assert.match(text, /duplicate step id "s1"/);
  assert.match(text, /diff\[0\]\.applicability/);
  assert.throws(() => assertValidWorkflow({ init: { start_id: "x", steps: [] }, diff: [] }), /invalid workflow DSL/);
});

await check("validation: operators the matcher does not support, and spec placeholders, are refused", () => {
  const doc = fixture("two-person-review");
  doc.init.condition = { amount: { $where: "1" } };
  assert.match(issuesOf(doc), /unsupported query operator "\$where"/);
  const placeholder = fixture("two-person-review");
  placeholder.init.condition = "$mongo_expr";
  assert.match(issuesOf(placeholder), /spec placeholder/);
});

await check("validation: duplicate rule priorities are refused (ordering would depend on array position)", () => {
  const doc = fixture("two-person-review");
  doc.diff[3].priority = doc.diff[2].priority;
  assert.match(issuesOf(doc), /priority 1 is shared by rules 2, 3/);
});

await check("validation: the transition matrix holds only known states, and every start state must be declared", () => {
  const doc = fixture("two-person-review");
  doc.init.transitions = { open: ["done"] };
  assert.match(issuesOf(doc), /"done" is not one of/);
  const undeclared = fixture("two-person-review");
  undeclared.init.transitions = { completed: ["open"] };
  assert.match(issuesOf(undeclared), /starts in "open", which init.transitions does not declare/);
});

await check("validation: a vacuous guard (selector already implies all) is flagged; a quorum is not", () => {
  const doc = fixture("quorum-two-of-three");
  doc.diff[0].guard = { selector: { state: "completed" }, all: { state: "completed" } };
  assert.match(issuesOf(doc), /the guard is vacuous/);
  const quorum = fixture("quorum-two-of-three");
  assert.deepEqual(validateWorkflow(quorum), []);
  quorum.diff[0].guard.min_matching = 0;
  assert.match(issuesOf(quorum), /min_matching must be a positive integer/);
});

await check("validation: relative assignment needs exactly one anchor and a reresolve_on", () => {
  const both = fixture("escalate-up-one-level");
  both.init.steps[1].assignee.relative.from_query = { role: "lead" };
  assert.match(issuesOf(both), /from_step or from_query, not both/);
  const neither = fixture("escalate-up-one-level");
  neither.init.steps[1].assignee.relative = { direction: "up" };
  assert.match(issuesOf(neither), /relative needs an anchor/);
  const inert = fixture("escalate-up-one-level");
  delete inert.init.steps[1].assignee.reresolve_on;
  assert.match(issuesOf(inert), /inert without reresolve_on/);
  const unknown = fixture("escalate-up-one-level");
  unknown.init.steps[1].assignee.relative.from_step = "ghost";
  assert.match(issuesOf(unknown), /"ghost" is not a step id/);
  const badDirection = fixture("escalate-up-one-level");
  badDirection.init.steps[1].assignee.relative.direction = "sideways";
  assert.match(issuesOf(badDirection), /direction must be "up" or "down"/);
});

await check("validation: $object is accepted only as a value in the two assignee positions", () => {
  const whole = fixture("anchored-down");
  whole.init.steps[1].assignee.relative.from_query = { $or: [{ $object: "department" }] };
  assert.match(issuesOf(whole), /cannot stand as a whole query/);
  const elsewhere = fixture("two-person-review");
  elsewhere.init.condition = { department: { $object: "department" } };
  assert.match(issuesOf(elsewhere), /\$object is only substituted in/);
  const empty = fixture("anchored-down");
  empty.init.steps[1].assignee.relative.from_query = { department: { $object: "" } };
  assert.match(issuesOf(empty), /non-empty object-data path/);
  const operator = fixture("anchored-down");
  operator.init.steps[1].assignee.relative.from_query = { role: { $where: "x" } };
  assert.match(issuesOf(operator), /unsupported query operator "\$where"/);
});

await check("validation: mail recipients are operator-checked like any directory query", () => {
  const doc = fixture("two-person-review");
  doc.diff[5].action.external.email.recipients.$or.query = { role: { $elemMatch: { x: 1 } } };
  assert.match(issuesOf(doc), /unsupported query operator "\$elemMatch"/);
});

await check("validation: demands need a boolean default and known required_on states", () => {
  const doc = fixture("two-person-review");
  doc.init.steps[0].comments_required = { required_on: ["completed"] };
  doc.init.steps[0].evidence_required = { default: true, required_on: ["finished"] };
  const text = issuesOf(doc);
  assert.match(text, /comments_required\.default: default is required/);
  assert.match(text, /"finished" is not one of/);
});

await check("validation: a step's settable properties exclude the demands (a rule cannot clear one)", () => {
  const doc = fixture("two-person-review");
  doc.diff[2].action.internal.set.comments_required = { value: false };
  assert.match(issuesOf(doc), /"comments_required" is not a settable step property/);
});

await check("validation: cohort rules must use $condn conditions", () => {
  const doc = fixture("cohort-wait");
  doc.diff[0].condition = { step$state: { $delta: { before: "", after: "completed" } } };
  assert.match(issuesOf(doc), /cohort_guard rules must use \$condn/);
});

await check("validation: flatten_order names only step ids, once each", () => {
  const doc = fixture("five-step-chain");
  doc.init.flatten_order = ["s1_scope", "ghost", "s1_scope"];
  const text = issuesOf(doc);
  assert.match(text, /"ghost" is not a step id/);
  assert.match(text, /duplicate step id "s1_scope"/);
});

await check("validation: due_on_extension needs a due_on; completed_at only on a step that starts completed, as a date", () => {
  const ext = fixture("due-extension-once");
  delete ext.init.steps[0].due_on;
  assert.match(issuesOf(ext), /due_on_extension requires the step to declare due_on/);
  const open = fixture("migrated-step");
  open.init.steps[0].state.default = "open";
  assert.match(issuesOf(open), /only for a step that starts completed/);
  const bad = fixture("migrated-step");
  bad.init.steps[0].completed_at.default = "not a date";
  assert.match(issuesOf(bad), /must be a date/);
});

await check("validation: an unknown assignee strategy and a non-boolean presence flag are refused", () => {
  const doc = fixture("five-step-chain");
  doc.init.steps[3].assignee.strategy = "random";
  doc.init.steps[0].assignee.require_active = "yes";
  const text = issuesOf(doc);
  assert.match(text, /strategy must be one of first\/least_loaded\/round_robin/);
  assert.match(text, /require_active must be a boolean/);
  const missing = fixture("five-step-chain");
  missing.init.steps[0].assignee = {};
  assert.match(issuesOf(missing), /assignee condition needs \$or.prompt or \$or.query/);
});

await check("validation: user_attributes — undeclared fields, unknown options, typed values and order operators are refused", () => {
  const doc = fixture("two-person-review");
  doc.init.steps[0].assignee.condition.$or.query = { duty: "auditor" };
  assert.match(issuesOf(doc), /"auditor" is not an option of user attribute "duty"/);
  const undeclared = fixture("two-person-review");
  undeclared.init.steps[0].assignee.condition.$or.query = { desk: "north" };
  assert.match(issuesOf(undeclared), /"desk" is not a user attribute this workflow supports/);
  const typed = fixture("two-person-review");
  typed.user_attributes = [{ key: "senior", type: "boolean" }, { key: "note", type: "text" }];
  typed.init.steps[0].assignee.condition.$or.query = { senior: "yes", note: { $regex: "^a" } };
  assert.match(issuesOf(typed), /"yes" is not a boolean for user attribute "senior"/);
  typed.init.steps[0].assignee.condition.$or.query = { senior: true, note: { $gt: "a" } };
  assert.match(issuesOf(typed), /\$gt compares an order/);
  const unchecked = fixture("two-person-review");
  delete unchecked.user_attributes;
  unchecked.init.steps[0].assignee.condition.$or.query = { anything: "goes" };
  assert.deepEqual(validateWorkflow(unchecked), []);
});

await check("validation: a platform attribute cannot be redeclared, a key only once; declaredUserAttributes lists the declaration", () => {
  const doc = fixture("two-person-review");
  doc.user_attributes = [{ key: "role", options: ["x"] }, { key: "duty", options: ["maker"] }, { key: "duty", options: ["checker"] }, { key: "flag", type: "boolean", options: ["x"] }];
  const text = issuesOf(doc);
  assert.match(text, /"role" is a platform attribute/);
  assert.match(text, /duplicate user attribute "duty"/);
  assert.match(text, /a boolean attribute takes no options/);
  assert.deepEqual(declaredUserAttributes(fixture("two-person-review")), [{ key: "duty", type: "choice", options: ["maker", "checker"] }]);
  assert.ok(PLATFORM_USER_ATTRIBUTES.includes("employment_status_active"));
});

// ── 3. the matcher ───────────────────────────────────────────────────────────────────────────────────────────────

section("3. The query matcher and $object substitution");

await check("matcher: the supported operators, dotted paths, arrays and logical combinators", () => {
  const doc = { a: 5, b: "x", tags: ["t1", "t2"], nested: { deep: 1 } };
  assert.ok(matches(doc, { a: 5, "nested.deep": 1 }));
  assert.ok(matches(doc, { a: { $gt: 4, $lte: 5 }, b: { $in: ["x", "y"] }, c: { $exists: false } }));
  assert.ok(matches(doc, { tags: "t2" }), "an array field equals any of its members");
  assert.ok(matches(doc, { $or: [{ a: 1 }, { b: { $regex: "^x$" } }], $nor: [{ a: 6 }] }));
  assert.ok(matches(doc, { a: { $not: { $lt: 5 } }, b: { $ne: "y" }, z: { $nin: [1] } }));
  assert.ok(matches(doc, { a: { $or: [{ $eq: 1 }, { $eq: 5 }] } }), "value-level $or evaluates");
  assert.ok(matches(doc, undefined));
  assert.equal(get(doc, "nested.deep"), 1);
  assert.throws(() => matches(doc, { a: { $where: 1 } }), /unsupported operator/);
  assert.throws(() => matches(doc, "string"), /query must be an object/);
});

await check("matcher: $object substitutes object data, including inside an operator and through a dotted path", () => {
  const data = { unit: "u1", meta: { owner: "p-lead" } };
  assert.deepEqual(substituteObject({ unit: { $object: "unit" } }, data), { query: { unit: "u1" }, unresolved: [] });
  assert.deepEqual(substituteObject({ unit: { $in: [{ $object: "unit" }, "u2"] } }, data).query, { unit: { $in: ["u1", "u2"] } });
  assert.deepEqual(substituteObject({ id: { $object: "meta.owner" } }, data).query, { id: "p-lead" });
  const plain = { role: "lead" };
  assert.deepEqual(substituteObject(plain, data), { query: plain, unresolved: [] });
});

await check("matcher: $object fails CLOSED on missing, null, empty, operator-carrying, array and inherited data; keeps 0 and false", () => {
  const data = { empty: "", nil: null, op: { $ne: "x" }, list: ["a"], zero: 0, no: false };
  for (const path of ["missing", "empty", "nil", "op", "list", "toString"]) {
    const { unresolved, query } = substituteObject({ f: { $object: path } }, data);
    assert.deepEqual(unresolved, [path], path);
    assert.deepEqual(query.f, UNRESOLVED);
  }
  assert.deepEqual(substituteObject({ f: { $object: "zero" }, g: { $object: "no" } }, data).query, { f: 0, g: false });
});

await check("matcher: the unresolved placeholder matches nothing, including records missing the field", () => {
  assert.equal(matches({ role: "lead" }, { unit: UNRESOLVED }), false);
  assert.equal(matches({ role: "lead", unit: "u1" }, { unit: UNRESOLVED }), false);
});

// ── 4. init, diff, state ─────────────────────────────────────────────────────────────────────────────────────────

section("4. Init, diff and state");

await check("init: gates on init.condition and apply.default", () => {
  const w = world();
  const dsl = fixture("two-person-review");
  dsl.init.condition = { department: { $exists: true } };
  dsl.init.apply = { default: { department: { $ne: "closed" } } };
  assert.equal(taskMatchesInit(dsl, {}), false);
  assert.equal(taskMatchesInit(dsl, { department: "closed" }), false);
  assert.throws(() => w.attach("gated", {}, { dsl }), /does not satisfy init.condition/);
  assert.equal(w.attach("gated", { department: "alpha" }, { dsl }).steps.length, 2);
});

await check("init: materializes due dates, dormant steps, start state, demands and assignees from the record's data", () => {
  const w = world();
  const now = new Date("2026-10-01T00:00:00Z");
  const inst = w.attach("two-person-review", { department: "alpha" }, { now });
  assert.equal(inst.start_id, "prepare");
  assert.equal(inst.organization_id, "org-a");
  assert.deepEqual(inst.object, { type: "record", id: "rec-1", data: { department: "alpha" } });
  const prepare = stepOf(inst, "prepare");
  assert.equal(prepare.due_on, "2026-10-04T00:00:00.000Z");
  assert.equal(prepare.status, true);
  assert.equal(prepare.state, "open");
  assert.deepEqual(prepare.assignee, ["p-maker"]);
  assert.equal(prepare.comments_required, true);
  assert.deepEqual(prepare.comments_required_on, ["completed"]);
  assert.equal(prepare.evidence_criterion, "The material that shows it.");
  const review = stepOf(inst, "review");
  assert.equal(review.status, false, "dormant until a rule activates it");
  assert.deepEqual(review.assignee, ["p-checker"], "p-gone has left and is skipped");
  assert.equal(inst.terminal, false);
  assert.deepEqual(inst.history.map((h) => h.type), ["instance_created"]);
});

await check("init: a query naming object data the record lacks resolves to nobody and says so", () => {
  const w = world();
  const inst = w.attach("two-person-review", {});
  assert.deepEqual(holders(inst, "prepare"), []);
  assert.match(inst.pending_prompts["steps.prepare.assignee"], /object data not present on this instance: department/);
});

await check("init: an assignee query that matches nobody is surfaced, never orphaned silently", () => {
  const w = world();
  const dsl = fixture("migrated-step");
  dsl.init.steps[1].assignee.condition.$or.query = { id: "p-nobody" };
  const inst = w.attach("nobody", {}, { dsl });
  assert.match(inst.pending_prompts["steps.next.assignee"], /matched no present directory user — assign next manually/);
});

await check("init: presence is the default — inactive people are never assigned; a missing field counts as present", () => {
  const w = world();
  const inst = w.attach("multi-holder-chain", { department: "alpha" });
  assert.deepEqual(holders(inst, "collect"), ["p-checker", "p-r1", "p-r2"]);
  assert.ok(!inst.steps.flatMap((s) => s.assignee).includes("p-gone"));
});

await check("init: require_active:false opts out deliberately; an author's own stricter clause is not widened", () => {
  const w = world();
  const dsl = fixture("migrated-step");
  dsl.init.steps[1].assignee = { condition: { $or: { query: { duty: "checker" } } }, require_active: false };
  assert.deepEqual(holders(w.attach("everyone", {}, { dsl }), "next"), ["p-gone"]);
  const strict = fixture("migrated-step");
  strict.init.steps[1].assignee = { condition: { $or: { query: { duty: "checker", employment_status_active: true } } } };
  assert.deepEqual(holders(w.attach("strict", {}, { dsl: strict }), "next"), [], "nobody carries true, and absence must not count");
});

await check("init: a demand's condition may only RAISE it; an AI condition is deferred to pending_prompts", () => {
  const w = world();
  const dsl = fixture("migrated-step");
  dsl.init.steps[1].comments_required = { default: true, condition: { $or: { query: { urgent: true } } } };
  dsl.init.steps[1].evidence_required = { default: false, condition: { $or: { query: { urgent: true } } } };
  const calm = w.attach("raise", { urgent: false }, { dsl });
  assert.equal(stepOf(calm, "next").comments_required, true, "default:true survives a non-matching condition");
  assert.equal(stepOf(calm, "next").evidence_required, false);
  assert.equal(stepOf(w.attach("raise", { urgent: true }), "next").evidence_required, true);
  const ai = fixture("migrated-step");
  ai.init.steps[1].comments_required = { default: false, condition: { $or: { prompt: "Is this sensitive?" } } };
  assert.equal(w.attach("ai", {}, { dsl: ai }).pending_prompts["steps.next.comments_required"], "Is this sensitive?");
});

await check("init: flat order is flatten_order first, then the remaining steps in declared order", () => {
  const dsl = fixture("five-step-chain");
  assert.deepEqual(flatOrder(dsl), ["s1_scope", "s2_collect", "s3_submit", "s4_review", "s5_signoff"]);
  dsl.init.flatten_order = ["s5_signoff", "s2_collect"];
  assert.deepEqual(flatOrder(dsl), ["s5_signoff", "s2_collect", "s1_scope", "s3_submit", "s4_review"]);
  delete dsl.init.flatten_order;
  assert.deepEqual(flatOrder(dsl), dsl.init.steps.map((s) => s.id));
});

await check("init: instances are scoped to their organization (assignees come from that organization's directory)", () => {
  const w = world();
  w.directory.seed([{ id: "q-maker", role: "reviewer", department: "alpha", duty: "maker" }], "org-b");
  const inst = initInstance("two-person-review", w.dsl("two-person-review"), { department: "alpha" }, w.directory, new Date(), "x", undefined, "org-b");
  assert.equal(inst.organization_id, "org-b");
  assert.deepEqual(holders(inst, "prepare"), ["q-maker"]);
  assert.deepEqual(holders(inst, "review"), []);
  assert.equal(organizationId(" "), DEFAULT_ORGANIZATION_ID);
});

await check("state: setStepProperty refuses wrongly-typed values instead of corrupting the step", () => {
  const step = stepOf(world().attach("two-person-review", { department: "alpha" }), "prepare");
  assert.equal(setStepProperty(step, "status", "yes"), false);
  assert.equal(setStepProperty(step, "state", "done"), false);
  assert.equal(setStepProperty(step, "assignee", [1]), false);
  assert.equal(setStepProperty(step, "due_on", null), true);
  assert.equal(step.due_on, undefined);
  assert.equal(isMutableStepProperty("constructor"), false);
  assert.deepEqual([...STEP_STATES], ["open", "completed", "rejected", "escalated"]);
});

await check("two-person-review: submit needs a comment and evidence; the review then opens and the completion is stamped", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  assert.equal((await act(w, inst, "prepare", { state: "completed" }, "p-maker")).code, "COMMENT_REQUIRED");
  assert.equal((await act(w, inst, "prepare", { state: "completed", comment: "done" }, "p-maker")).code, "EVIDENCE_REQUIRED");
  assert.equal((await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker")).status, 200);
  assert.equal(stepOf(inst, "review").status, true);
  assert.ok(stepOf(inst, "prepare").completed_at, "the p0 rule stamps completed_at");
  assert.deepEqual(stepOf(inst, "prepare").comments.map((c) => [c.actor, c.text, c.on_transition]), [["p-maker", "done", "open → completed"]]);
  assert.deepEqual(stepOf(inst, "prepare").evidence.map((e) => e.ref), ["doc://evidence/1"]);
  assert.ok(inst.history.some((h) => h.type === "diff_rule_fired"));
});

await check("two-person-review: only the holder acts; the preparer cannot decide the review", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "ok" }, "p-maker")).status, 403);
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "ok" }, "p-r1")).status, 403, "same role, not assigned");
});

await check("two-person-review: a send-back needs a reason, reopens the first step for the same preparer and clears its date", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal((await act(w, inst, "review", { state: "rejected" }, "p-checker")).code, "COMMENT_REQUIRED");
  assert.equal((await act(w, inst, "review", { state: "rejected", comment: "missing a page" }, "p-checker")).status, 200);
  assert.deepEqual([stepOf(inst, "prepare").status, stepOf(inst, "prepare").state], [true, "open"]);
  assert.equal(stepOf(inst, "prepare").completed_at, undefined);
  assert.deepEqual(holders(inst, "prepare"), ["p-maker"]);
  assert.equal(stepOf(inst, "review").status, false);
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal(stepOf(inst, "review").state, "open", "the review is reopened by the forward rule");
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "complete now" }, "p-checker")).status, 200);
  assert.equal(inst.terminal, true);
});

await check("two-person-review: an escalation queues one email to the department's leads, once", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  assert.equal((await act(w, inst, "prepare", { state: "escalated" }, "p-maker")).status, 200, "evidence is demanded only to complete");
  const mail = inst.outbox.filter((o) => o.kind === "email");
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].recipients, ["lead@example.test"]);
  assert.equal(mail[0].subject, "A step was escalated");
  assert.equal(mail[0].delivery.status, "pending");
  await act(w, inst, "prepare", { state: "open" }, "p-maker");
  await act(w, inst, "prepare", { state: "escalated" }, "p-maker");
  assert.equal(inst.outbox.filter((o) => o.kind === "email").length, 1, "once: true");
  assert.deepEqual(inst.fired_once, [4]);
});

await check("attribution: the patch and the rule writes it triggers are credited to the same person; approvals are state_changed rows", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  const ruleRows = inst.history.filter((h) => h.source === "rule");
  assert.ok(ruleRows.length > 0);
  assert.ok(ruleRows.every((h) => h.actor === "p-maker"));
  const decisions = inst.history.filter((h) => h.type === "state_changed");
  assert.deepEqual(decisions.map((h) => [h.step_id, h.source, h.actor]), [["prepare", "user", "p-maker"]], "review was already open: activation is not a decision");
  await act(w, inst, "review", { state: "rejected", comment: "no" }, "p-checker");
  const ruleMove = inst.history.filter((h) => h.type === "state_changed" && h.source === "rule");
  assert.deepEqual(ruleMove.map((h) => [h.step_id, h.detail]), [["prepare", "completed → open (rule p2)"]]);
});

await check("attribution: a change that changes nothing leaves no history row", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  const before = inst.history.length;
  assert.equal((await act(w, inst, "prepare", { state: "open" }, "p-maker")).status, 200);
  assert.equal(inst.history.length, before);
  assert.equal((await act(w, inst, "prepare", { state: "open" }, "p-viewer")).status, 403, "and an unauthorized no-op is refused");
});

await check("five-step-chain: every holder comes from the record's department; the happy path runs 1 to 5 and ends terminal", async () => {
  const w = world();
  const inst = w.attach("five-step-chain", { department: "alpha" });
  assert.deepEqual(inst.steps.map((s) => s.assignee[0]), ["p-maker", "p-maker", "p-maker", "p-checker", "p-lead"]);
  assert.deepEqual(inst.flat_order, ["s1_scope", "s2_collect", "s3_submit", "s4_review", "s5_signoff"]);
  assert.equal((await act(w, inst, "s1_scope", { state: "completed", comment: "scoped" }, "p-maker")).status, 200);
  assert.equal((await act(w, inst, "s2_collect", { state: "completed", ...SUBMIT }, "p-maker")).status, 200);
  assert.equal((await act(w, inst, "s3_submit", { state: "completed", ...SUBMIT }, "p-maker")).status, 200);
  assert.equal((await act(w, inst, "s4_review", { state: "completed", comment: "fine" }, "p-checker")).status, 200);
  assert.equal(inst.terminal, false);
  assert.equal((await act(w, inst, "s5_signoff", { state: "completed", comment: "closed" }, "p-lead")).status, 200);
  assert.equal(inst.terminal, true);
});

await check("five-step-chain: a dormant step cannot be actioned, even by its own future holder", async () => {
  const w = world();
  const inst = w.attach("five-step-chain", { department: "alpha" });
  const r = await act(w, inst, "s2_collect", { state: "completed", ...SUBMIT }, "p-maker");
  assert.deepEqual([r.status, r.code], [409, "STEP_DORMANT"]);
  assert.equal((await act(w, inst, "s1_scope", { state: "completed", comment: "x" }, "p-checker")).status, 403);
});

await check("five-step-chain: step 3 sends back to step 1; step 5 sends back to step 2 and 3, 4 run again", async () => {
  const w = world();
  const inst = w.attach("five-step-chain", { department: "alpha" });
  await act(w, inst, "s1_scope", { state: "completed", comment: "scoped" }, "p-maker");
  await act(w, inst, "s2_collect", { state: "completed", ...SUBMIT }, "p-maker");
  await act(w, inst, "s3_submit", { state: "rejected", comment: "scope was wrong" }, "p-maker");
  assert.deepEqual(inst.steps.map((s) => [s.id, s.status, s.state]), [
    ["s1_scope", true, "open"], ["s2_collect", false, "open"], ["s3_submit", false, "rejected"], ["s4_review", false, "open"], ["s5_signoff", false, "open"],
  ]);
  await act(w, inst, "s1_scope", { state: "completed", comment: "rescoped" }, "p-maker");
  await act(w, inst, "s2_collect", { state: "completed", ...SUBMIT }, "p-maker");
  await act(w, inst, "s3_submit", { state: "completed", ...SUBMIT }, "p-maker");
  await act(w, inst, "s4_review", { state: "completed", comment: "fine" }, "p-checker");
  await act(w, inst, "s5_signoff", { state: "rejected", comment: "redo the evidence" }, "p-lead");
  assert.deepEqual(inst.steps.map((s) => [s.id, s.status, s.state]), [
    ["s1_scope", true, "completed"], ["s2_collect", true, "open"], ["s3_submit", false, "open"], ["s4_review", false, "open"], ["s5_signoff", false, "rejected"],
  ]);
  await act(w, inst, "s2_collect", { state: "completed", ...SUBMIT }, "p-maker");
  await act(w, inst, "s3_submit", { state: "completed", ...SUBMIT }, "p-maker");
  await act(w, inst, "s4_review", { state: "completed", comment: "fine" }, "p-checker");
  assert.equal(stepOf(inst, "s5_signoff").status, true);
  assert.equal(stepOf(inst, "s5_signoff").state, "open");
});

await check("five-step-chain: an escalated step can still be signed off (escalation flags, it does not lock)", async () => {
  const w = world();
  const inst = w.attach("five-step-chain", { department: "alpha" });
  await act(w, inst, "s1_scope", { state: "escalated" }, "p-maker");
  assert.equal((await act(w, inst, "s1_scope", { state: "completed", comment: "resolved" }, "p-maker")).status, 200);
  assert.equal(stepOf(inst, "s2_collect").status, true);
});

await check("multi-holder-chain: holders up to the step's limit; any holder may act, nobody else; a send-back reopens for the group", async () => {
  const w = world();
  const inst = w.attach("multi-holder-chain", { department: "alpha" });
  assert.deepEqual(holders(inst, "review"), ["p-head", "p-lead"]);
  assert.deepEqual(inst.steps.map((s) => s.status), [true, false, false]);
  assert.equal((await act(w, inst, "collect", { state: "completed", ...SUBMIT }, "p-r3")).status, 403, "a checker outside the holders");
  assert.equal((await act(w, inst, "collect", { state: "completed", comment: "pack" }, "p-r2")).code, "EVIDENCE_REQUIRED");
  assert.equal((await act(w, inst, "collect", { state: "completed", ...SUBMIT }, "p-r2")).status, 200);
  assert.equal((await act(w, inst, "review", { state: "rejected", comment: "missing minutes" }, "p-lead")).status, 200);
  assert.deepEqual([stepOf(inst, "collect").status, stepOf(inst, "collect").state, stepOf(inst, "collect").completed_at], [true, "open", undefined]);
  assert.deepEqual(holders(inst, "collect"), ["p-checker", "p-r1", "p-r2"]);
  assert.equal((await act(w, inst, "collect", { state: "completed", comment: "added", evidence: "doc://evidence/2" }, "p-r1")).status, 200);
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "ok" }, "p-head")).status, 200);
  assert.equal((await act(w, inst, "close", { state: "completed", comment: "closed" }, "p-admin")).status, 200);
  assert.equal(inst.terminal, true);
});

await check("quorum-two-of-three: the decision opens on the second approval, not the first; its notice is sent once", async () => {
  const w = world();
  const inst = w.attach("quorum-two-of-three", {});
  await act(w, inst, "review_1", { state: "completed" }, "p-r1");
  assert.equal(stepOf(inst, "decide").status, false);
  await act(w, inst, "review_2", { state: "completed" }, "p-r2");
  assert.equal(stepOf(inst, "decide").status, true);
  await act(w, inst, "review_3", { state: "completed" }, "p-r3");
  assert.equal(inst.outbox.length, 1);
  assert.deepEqual(inst.outbox[0].recipients, ["lead@example.test"]);
  assert.equal(poolSatisfies(inst.steps.filter((s) => s.id.startsWith("review_")), { state: "completed" }), true);
  assert.equal(poolSatisfies([], { state: "completed" }), false, "an empty pool never satisfies a guard");
});

await check("gateway-branch: the record's own data picks the branch; a prompt branch is deferred, never guessed", async () => {
  const w = world();
  const big = w.attach("gateway-branch", { amount: 1500 });
  await act(w, big, "intake", { state: "completed" }, "p-maker");
  assert.deepEqual([stepOf(big, "lead_review").status, stepOf(big, "standard_review").status], [true, false]);
  assert.equal(big.pending_prompts["diff.p3.applicability"], "Does this record need a second opinion?");
  assert.equal(big.outbox.length, 0);
  const small = w.attach("gateway-branch", { amount: 10 });
  await act(w, small, "intake", { state: "completed" }, "p-maker");
  assert.deepEqual([stepOf(small, "lead_review").status, stepOf(small, "standard_review").status], [false, true]);
});

await check("gateway-branch: an evaluator that answers resolves the prompt branch and queues its agent", async () => {
  const w = world();
  const inst = w.attach("gateway-branch", { amount: 10 });
  const step = stepOf(inst, "intake");
  step.state = "completed";
  const yes = { evaluate: async () => true };
  await runDiff(inst, w.dsl("gateway-branch"), { stepId: "intake", changed: { state: { before: "open", after: "completed" } } }, w.directory, yes, new Date(), "p-maker");
  assert.deepEqual(inst.outbox.map((o) => [o.kind, o.name]), [["agent", "second-opinion"]]);
});

await check("diff: a 'first' selector takes the first MATCHING step of its group, not the first step overall", async () => {
  const w = world();
  const dsl = fixture("quorum-two-of-three");
  dsl.diff = [{ priority: 1, applicability: "all", selector: { rule: "first", group_selector: { id: "review_2" } }, condition: { step$state: { $delta: { before: "", after: "completed" } } }, action: { internal: { scope: "other", other_selector: { id: "decide" }, set: { status: { value: true } } } } }];
  const inst = w.attach("first", {}, { dsl });
  await act(w, inst, "review_1", { state: "completed" }, "p-r1");
  assert.equal(stepOf(inst, "decide").status, false);
  await act(w, inst, "review_2", { state: "completed" }, "p-r2");
  assert.equal(stepOf(inst, "decide").status, true);
});

await check("transitions: an undeclared move is refused, the rework path is allowed, and the matrix binds rules too", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  const r = await act(w, inst, "prepare", { state: "rejected" }, "p-maker");
  assert.deepEqual([r.status, r.code], [422, "TRANSITION_NOT_ALLOWED"]);
  assert.match(r.message, /completed → rejected is not allowed by init.transitions \(allowed: open\)/);
  assert.equal(transitionError(w.dsl("two-person-review"), "rejected", "open"), null);
  const strict = fixture("quorum-two-of-three");
  strict.init.transitions = { open: ["completed"], completed: [] };
  strict.diff = [{ priority: 1, applicability: "all", selector: { rule: "single", group_selector: { id: "review_1" } }, condition: { step$state: { $delta: { before: "", after: "completed" } } }, action: { internal: { scope: "other", other_selector: { id: "review_2" }, set: { state: { value: "rejected" } } } } }];
  const ruled = w.attach("strict", {}, { dsl: strict });
  await act(w, ruled, "review_1", { state: "completed" }, "p-r1");
  assert.equal(stepOf(ruled, "review_2").state, "open");
  assert.ok(ruled.history.some((h) => h.type === "internal_set" && /skipped by init.transitions/.test(h.detail)));
  assert.match(transitionError(strict, "completed", "open"), /"completed" is terminal/);
});

await check("terminal: computed only when the workflow declares terminal_when", () => {
  const w = world();
  assert.equal(w.attach("gateway-branch", { amount: 1 }).terminal, undefined);
  assert.equal(w.attach("two-person-review", { department: "alpha" }).terminal, false);
});

// ── 5. assignment ────────────────────────────────────────────────────────────────────────────────────────────────

section("5. Assignment: balancing, relative, anchored, reassignment, re-resolution");

const singleStep = (assignee) => ({ init: { start_id: "s", steps: [{ id: "s", title: "Work", assignee }] }, diff: [] });

await check("balancing: without a strategy every instance goes to the same first person (the default, unchanged)", () => {
  const w = world();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(holders(w.attach("two-person-review", { department: "alpha" }), "review"), ["p-checker"]);
});

await check("balancing: least_loaded spreads work, ignoring finished and dormant work", () => {
  const w = world();
  const dsl = singleStep({ condition: { $or: { query: { duty: "checker" } } }, strategy: "least_loaded" });
  const got = [1, 2, 3, 4].map(() => holders(w.attach("ll", {}, { dsl }), "s")[0]);
  assert.deepEqual(got, ["p-checker", "p-r1", "p-r2", "p-r3"]);
  w.instances[0].steps[0].state = "completed";
  w.instances[1].steps[0].status = false;
  assert.deepEqual(holders(w.attach("ll", {}), "s"), ["p-checker"]);
  assert.deepEqual(holders(w.attach("ll", {}), "s"), ["p-r1"]);
});

await check("balancing: round_robin rotates per step template, whatever each person holds", () => {
  const w = world();
  const dsl = singleStep({ condition: { $or: { query: { duty: "checker" } } }, strategy: "round_robin" });
  const got = [1, 2, 3, 4, 5].map(() => holders(w.attach("rr", {}, { dsl }), "s")[0]);
  assert.deepEqual(got, ["p-checker", "p-r1", "p-r2", "p-r3", "p-checker"]);
});

await check("balancing: only the eligible are balanced — presence and the query still filter", () => {
  const w = world();
  const dsl = singleStep({ condition: { $or: { query: { duty: "checker" } } }, strategy: "least_loaded" });
  const got = new Set([1, 2, 3, 4, 5, 6].map(() => holders(w.attach("ll", {}, { dsl }), "s")[0]));
  assert.ok(!got.has("p-gone") && !got.has("p-maker"));
});

await check("balancing: load counts only open, actionable, non-terminal steps; a view binds a snapshot", () => {
  const w = world();
  const a = w.attach("two-person-review", { department: "alpha" });
  const b = w.attach("two-person-review", { department: "alpha" });
  b.terminal = true;
  assert.deepEqual([...openLoad([a, b])], [["p-maker", 1]], "review is dormant, b is terminal");
  const view = w.balancer.view([a]);
  assert.deepEqual(view.order(["p-r1", "p-maker"], { condition: { $or: {} }, strategy: "least_loaded" }, "k", "org-a"), ["p-r1", "p-maker"]);
});

await check("relative: escalation goes to the holder's reporting manager, resolved on entry, with an audit row", async () => {
  const w = world();
  const inst = w.attach("escalate-up-one-level", {});
  assert.deepEqual(holders(inst, "escalation"), ["p-admin"], "at attach the fallback; the walk happens on entry");
  await act(w, inst, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(inst, "escalation"), ["p-lead"]);
  const row = inst.history.find((h) => h.type === "assignee_reresolved");
  assert.deepEqual([row.step_id, row.data.reason, row.data.after], ["escalation", "relative", ["p-lead"]]);
  assert.equal((await act(w, inst, "escalation", { state: "completed" }, "p-maker")).status, 403, "the escalated-past holder cannot act");
  assert.equal((await act(w, inst, "escalation", { state: "completed" }, "p-lead")).status, 200);
});

await check("relative: climbs several levels within the record's business unit; falls back when the chain runs out", async () => {
  const w = world();
  const two = fixture("escalate-up-one-level");
  two.init.steps[1].assignee.relative.levels = 2;
  const inUnit = w.attach("two-up", { business_unit: "unit-1" }, { dsl: two });
  await act(w, inUnit, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(inUnit, "escalation"), ["p-head"]);
  const elsewhere = w.attach("two-up", {});
  await act(w, elsewhere, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(elsewhere, "escalation"), ["p-admin"], "the p-lead row is scoped to unit-1");
  const three = fixture("escalate-up-one-level");
  three.init.steps[1].assignee.relative.levels = 3;
  const deep = w.attach("three-up", { business_unit: "unit-1" }, { dsl: three });
  await act(w, deep, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(deep, "escalation"), ["p-admin"]);
});

await check("relative: reads the matrix at entry (a reorg after attach counts) and never escalates to the person escalated past", async () => {
  const w = world();
  const inst = w.attach("escalate-up-one-level", {});
  w.rbac.seedReporting(reportingRowsFrom(PEOPLE.users.map((u) => (u.id === "p-maker" ? { ...u, reporting_managers: ["p-head"] } : u))), "org-a");
  await act(w, inst, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(inst, "escalation"), ["p-head"]);
  const self = world({ users: PEOPLE.users.map((u) => (u.id === "p-maker" ? { ...u, reporting_managers: ["p-maker"] } : u)) });
  const loop = self.attach("escalate-up-one-level", {});
  await act(self, loop, "work", { state: "escalated" }, "p-maker");
  assert.deepEqual(holders(loop, "escalation"), ["p-admin"]);
});

await check("relative: direction down from a step's holder reaches their reportees; none falls back", () => {
  const w = world();
  const inst = w.attach("escalate-up-one-level", {});
  stepOf(inst, "work").assignee = ["p-lead"];
  assert.deepEqual(resolveRelative({ from_step: "work", direction: "down" }, inst, w.rbac), ["p-checker", "p-maker"]);
  stepOf(inst, "work").assignee = ["p-r1"];
  assert.deepEqual(resolveRelative({ from_step: "work", direction: "down" }, inst, w.rbac), []);
});

await check("anchored-down: one level below the lead of the record's own department; another record routes elsewhere", async () => {
  const w = world();
  const alpha = w.attach("anchored-down", { department: "alpha" });
  await act(w, alpha, "start", { state: "completed" }, "p-admin");
  assert.deepEqual(holders(alpha, "delegate"), ["p-checker"]);
  const beta = w.attach("anchored-down", { department: "beta" });
  await act(w, beta, "start", { state: "completed" }, "p-admin");
  assert.deepEqual(holders(beta, "delegate"), ["p-other"]);
  assert.equal((await act(w, beta, "delegate", { state: "completed" }, "p-checker")).status, 403);
  assert.equal((await act(w, beta, "delegate", { state: "completed" }, "p-other")).status, 200);
});

await check("anchored-down: fails CLOSED when the record lacks the anchoring field (falls back, never widens to every lead)", async () => {
  const w = world();
  const inst = w.attach("anchored-down", {});
  await act(w, inst, "start", { state: "completed" }, "p-admin");
  assert.deepEqual(holders(inst, "delegate"), ["p-admin"]);
  assert.deepEqual(resolveRelative({ from_query: { role: "lead", department: { $object: "department" } }, direction: "down" }, inst, w.rbac, w.directory), []);
});

await check("anchored-down: walking up from the anchor reaches the anchor's managers; the anchor query stays in its organization", () => {
  const w = world();
  const inst = w.attach("anchored-down", { department: "alpha", business_unit: "unit-1" });
  assert.deepEqual(resolveRelative({ from_query: { role: "lead", department: { $object: "department" } }, direction: "up" }, inst, w.rbac, w.directory), ["p-head"]);
  const other = { ...clone(inst), organization_id: "org-b" };
  assert.deepEqual(resolveRelative({ from_query: { role: "lead", department: { $object: "department" } }, direction: "down" }, other, w.rbac, w.directory), []);
});

await check("reassign: a department lead may hand a step to someone its rule picks; the hand-placed holder is pinned", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha", business_unit: "unit-1" });
  assert.deepEqual(holders(inst, "approve"), ["p-checker"]);
  assert.equal((await act(w, inst, "approve", { assignee: ["p-r1"] }, "p-lead")).status, 200);
  assert.deepEqual(holders(inst, "approve"), ["p-r1"]);
  assert.equal(stepOf(inst, "approve").assignee_pinned, true);
});

await check("reassign: not to someone outside the rule — unless an administrator places them", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha" });
  const r = await act(w, inst, "approve", { assignee: ["p-other"] }, "p-lead");
  assert.deepEqual([r.status, r.code], [422, "ASSIGNEE_OUTSIDE_RULE"]);
  assert.match(r.message, /other@example\.test does not match the rule for "Approve"/);
  assert.equal((await act(w, inst, "approve", { assignee: ["p-other"] }, "p-admin")).status, 200);
  assert.equal((await act(w, inst, "approve", { state: "completed" }, "p-other")).status, 200, "someone an admin placed may sign");
});

await check("reassign: a holder can neither hand their step on nor take another; a lead of another department has no write", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha" });
  assert.equal((await act(w, inst, "approve", { assignee: ["p-maker"] }, "p-maker")).code, "REASSIGN_NEEDS_SUPERVISOR");
  assert.equal((await act(w, inst, "prepare", { assignee: ["p-r1"] }, "p-maker")).code, "REASSIGN_NEEDS_SUPERVISOR");
  assert.deepEqual(await act(w, inst, "approve", { assignee: ["p-r1"] }, "p-lead-beta"), { status: 403, code: "FORBIDDEN" });
});

await check("reassign: a supervisor who could not act on the step once assigned is refused it", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha", business_unit: "unit-1" });
  const r = await act(w, inst, "approve", { assignee: ["p-unit-lead"] }, "p-unit-lead");
  assert.deepEqual([r.status, r.code], [403, "TAKER_CANNOT_ACT"]);
  assert.equal((await act(w, inst, "approve", { assignee: ["p-r2"] }, "p-unit-lead")).status, 200, "a unit supervisor may still hand it within the rule");
});

await check("reassign: a lead may take a step its rule picks them for; one person may hold every step", async () => {
  const w = world();
  const inst = w.attach("five-step-chain", { department: "alpha" });
  assert.equal((await act(w, inst, "s5_signoff", { assignee: ["p-admin"] }, "p-admin")).status, 200);
  assert.equal((await act(w, inst, "s5_signoff", { assignee: ["p-lead"] }, "p-lead")).status, 200);
  assert.deepEqual(holders(inst, "s5_signoff"), ["p-lead"]);
  for (const s of ["s1_scope", "s2_collect", "s3_submit", "s4_review"]) assert.equal((await act(w, inst, s, { assignee: ["p-admin"] }, "p-admin")).status, 200);
  assert.ok(inst.steps.slice(0, 4).every((s) => s.assignee[0] === "p-admin"));
});

await check("reassign: a per-instance write grant, or a share of the record, does not make its holder a supervisor", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "beta" });
  w.rbac.seedGrants([
    { user_id: "p-viewer", resource_type: "instance", resource_id: inst.id, actions: ["write"] },
    { user_id: "p-r3", resource_type: "object", resource_id: `record:${inst.object.id}`, actions: ["write"] },
  ], "org-a");
  assert.equal((await act(w, inst, "approve", { assignee: ["p-viewer"] }, "p-viewer")).code, "REASSIGN_NEEDS_SUPERVISOR");
  assert.equal((await act(w, inst, "approve", { assignee: ["p-r3"] }, "p-r3")).code, "REASSIGN_NEEDS_SUPERVISOR");
  assert.equal((await act(w, inst, "approve", { state: "completed" }, "p-r3")).status, 403, "a share never implies act");
});

await check("re-resolution: a reopened step re-resolves to someone present; the original holder is kept while present", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha" });
  await act(w, inst, "approve", { state: "rejected" }, "p-checker");
  await act(w, inst, "approve", { state: "open" }, "p-checker");
  assert.deepEqual(holders(inst, "approve"), ["p-checker"], "sticky while present");
  await act(w, inst, "approve", { state: "rejected" }, "p-checker");
  w.directory.upsert({ id: "p-checker", employment_status_active: false }, "org-a");
  await act(w, inst, "approve", { state: "open" }, "p-admin");
  assert.deepEqual(holders(inst, "approve"), ["p-r1"]);
});

await check("re-resolution: a hand-placed holder is left alone; an assignee named in the same change wins", async () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha" });
  await act(w, inst, "approve", { assignee: ["p-r2"] }, "p-lead");
  await act(w, inst, "approve", { state: "rejected" }, "p-r2");
  w.directory.upsert({ id: "p-r2", employment_status_active: true }, "org-a");
  await act(w, inst, "approve", { state: "open" }, "p-r2");
  assert.deepEqual(holders(inst, "approve"), ["p-r2"], "pinned");
  const fresh = w.attach("self-and-supervisor-reassign", { department: "alpha" });
  await act(w, fresh, "approve", { state: "rejected" }, "p-checker");
  assert.equal((await act(w, fresh, "approve", { state: "open", assignee: ["p-r3"] }, "p-admin")).status, 200);
  assert.deepEqual(holders(fresh, "approve"), ["p-r3"]);
});

await check("re-resolution: without reresolve_on a step stays with its holder even after they leave", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  w.directory.upsert({ id: "p-maker", employment_status_active: false }, "org-a");
  reresolveOnEnter(stepOf(inst, "prepare"), w.dsl("two-person-review"), w.directory, inst, new Date().toISOString(), { source: "user" });
  assert.deepEqual(holders(inst, "prepare"), ["p-maker"]);
});

await check("reporting: reporting_managers on a person is queryable by an assignee condition", () => {
  const w = world();
  const { ids } = resolveAssignees({ condition: { $or: { query: { reporting_managers: "p-lead" } } }, limit: 5 }, w.directory, [], undefined, undefined, "org-a");
  assert.deepEqual(ids, ["p-checker", "p-maker"]);
});

// ── 6. the step rules ────────────────────────────────────────────────────────────────────────────────────────────

section("6. The step rules (lib/workflow-step-rules.ts)");

await check("step rules: the patch's shape — unknown and prototype keys, wrongly-typed values", () => {
  assert.deepEqual(checkPatchShape({ state: "completed", due_on: null }), { ok: true });
  assert.equal(checkPatchShape({ constructor: 1 }).code, "UNPATCHABLE_PROPERTY");
  assert.equal(checkPatchShape({ toString: "x" }).code, "UNPATCHABLE_PROPERTY");
  const bad = checkPatchShape({ status: "yes", state: "done", completed_at: "yesterday" });
  assert.equal(bad.code, "INVALID_VALUE");
  assert.match(bad.message, /status \(expected boolean\), state \(expected open\/completed\/rejected\/escalated\), completed_at/);
  assert.deepEqual(Object.keys(PATCHABLE).sort(), ["assignee", "comments_required", "completed_at", "completed_on_delta", "due_on", "evidence_required", "state", "status"]);
});

await check("step rules: comments and evidence — invisible characters dropped, lines kept, length counted in code points", () => {
  assert.equal(cleanContribution("  line one\n\tline two  "), "line one\n\tline two");
  assert.equal(cleanContribution("a​b c\u0007"), "abc");
  assert.equal(cleanContribution("​"), "", "an invisible comment is no comment");
  assert.equal(cleanContribution(42), "");
  assert.deepEqual(checkContributionLength("comment", "😀".repeat(MAX_CONTRIBUTION_CHARS)), { ok: true });
  assert.equal(checkContributionLength("comment", "a".repeat(MAX_CONTRIBUTION_CHARS + 1)).code, "TEXT_TOO_LONG");
});

await check("step rules: a comment or evidence alone is recorded without a state change; re-sending known evidence saves nothing", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  assert.equal((await act(w, inst, "prepare", { comment: "line one\nline two" }, "p-maker")).status, 200);
  assert.deepEqual(stepOf(inst, "prepare").comments.map((c) => c.text), ["line one\nline two"]);
  await act(w, inst, "prepare", { evidence: "doc://evidence/1" }, "p-maker");
  const rows = inst.history.length;
  assert.equal((await act(w, inst, "prepare", { evidence: "doc://evidence/1" }, "p-maker")).noop, true);
  assert.equal(inst.history.length, rows);
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal(stepOf(inst, "prepare").evidence.length, 1, "evidence already on the step is not recorded again at sign-off");
  assert.equal((await act(w, inst, "prepare", { comment: "x" }, "p-r1")).status, 403, "a contribution needs the holder's act or standing over the record");
});

await check("step rules: required_on scopes a demand to the destination states that warrant it; without it every move is covered", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  assert.deepEqual(demandsFor(inst, stepOf(inst, "prepare"), "escalated").map((d) => d.required), [false, false]);
  assert.deepEqual(demandsFor(inst, stepOf(inst, "prepare"), "completed").map((d) => d.required), [true, true]);
  stepOf(inst, "prepare").comments_required_on = null;
  assert.deepEqual(demandsFor(inst, stepOf(inst, "prepare"), "escalated").map((d) => d.required), [true, false], "null round-trips as absent: every state");
  const r = checkStateChange({ dsl: w.dsl("two-person-review"), instance: inst, step: stepOf(inst, "review"), to: "completed" });
  assert.equal(r.code, "STEP_DORMANT");
});

await check("step rules: a refusal names the step's criterion; an unresolved AI condition fails closed", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  const r = checkStateChange({ dsl: w.dsl("two-person-review"), instance: inst, step: stepOf(inst, "prepare"), to: "completed", comment: "x" });
  assert.match(r.message, /requires evidence to change state to "completed": The material that shows it\./);
  const ai = fixture("migrated-step");
  ai.init.steps[1].comments_required = { default: false, condition: { $or: { prompt: "Is this sensitive?" } } };
  const pending = w.attach("ai", {}, { dsl: ai });
  assert.equal(checkStateChange({ dsl: ai, instance: pending, step: stepOf(pending, "next"), to: "completed" }).code, "COMMENT_REQUIRED");
});

await check("step rules: the demand is read from the live step, so a later template edit does not re-scope it", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  w.dsl("two-person-review").init.steps[0].comments_required = { default: false };
  assert.equal((await act(w, inst, "prepare", { state: "completed", evidence: "doc://x" }, "p-maker")).code, "COMMENT_REQUIRED");
});

await check("step rules: switching a demand off needs admin; raising one does not; rule-driven moves are never blocked", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  const r = await act(w, inst, "prepare", { comments_required: false }, "p-maker");
  assert.deepEqual([r.status, r.code], [403, "DEMAND_LOWERING_NEEDS_ADMIN"]);
  assert.equal((await act(w, inst, "prepare", { comments_required: false }, "p-admin")).status, 200);
  assert.equal((await act(w, inst, "prepare", { comments_required: true }, "p-maker")).status, 200);
  assert.deepEqual(checkDemandLowering(stepOf(inst, "prepare"), { comments_required: true }, false), { ok: true });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal(stepOf(inst, "review").state, "open", "the review's comment demand did not stop the rule");
});

await check("step rules: activation is admin-only, and a dormant step cannot be woken and decided in one change", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  assert.equal((await act(w, inst, "review", { status: true }, "p-checker")).status, 403);
  assert.equal((await act(w, inst, "review", { status: true, state: "completed", comment: "x" }, "p-admin")).code, "STEP_DORMANT");
  assert.equal((await act(w, inst, "review", { assignee: ["p-r1"] }, "p-admin")).status, 200, "preparing a dormant step is allowed");
  assert.equal(checkContributionOnDormant(stepOf(inst, "review"), true, false).code, "STEP_DORMANT", "a holder without write adds nothing to a dormant step");
  assert.deepEqual(checkContributionOnDormant(stepOf(inst, "review"), true, true), { ok: true });
});

await check("step rules: who a patch needs — act for a holder's move, write for the rest, admin for status", () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  const step = stepOf(inst, "prepare");
  assert.deepEqual(patchNeeds({ step, patch: { state: "completed" }, contributes: true }), { base: "act", actOnStep: true, admin: false, write: false });
  assert.deepEqual(patchNeeds({ step, patch: { state: "completed", completed_at: "2026-10-01T00:00:00Z" }, contributes: false }), { base: "act", actOnStep: true, admin: false, write: false });
  assert.deepEqual(patchNeeds({ step, patch: {}, contributes: true }), { base: "act", actOnStep: false, admin: false, write: false });
  assert.deepEqual(patchNeeds({ step, patch: { due_on: null }, contributes: false }), { base: "write", actOnStep: false, admin: false, write: true });
  assert.deepEqual(patchNeeds({ step, patch: { status: true }, contributes: false }), { base: "write", actOnStep: false, admin: true, write: false });
  assert.deepEqual(patchNeeds({ step, patch: { state: "completed" }, contributes: false, actsWithoutHolding: true, actorId: "p-lead" }), { base: "write", actOnStep: false, admin: false, write: false });
});

await check("step rules: a caller-declared standing to decide without holding is honoured, and only for state", async () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  await act(w, inst, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "ok" }, "p-lead")).status, 403, "without the standing");
  assert.equal((await act(w, inst, "review", { state: "completed", comment: "ok" }, "p-lead", { actsWithoutHolding: true })).status, 200);
  assert.equal(inst.terminal, true);
  assert.equal((await act(w, inst, "review", { status: false }, "p-lead", { actsWithoutHolding: true })).status, 403, "activation stays admin-only");
});

await check("step rules: the RBAC resources — the instance carries every holder and its scope, a step only its own holders", () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha", departments: ["alpha", "beta", 3], business_unit: "unit-1" });
  const res = instanceResource(inst);
  assert.deepEqual([res.assignees, res.department, res.departments, res.business_unit, res.object_key], [["p-maker", "p-checker"], "alpha", ["alpha", "beta"], "unit-1", `record:${inst.object.id}`]);
  const step = stepActResource(inst, stepOf(inst, "review"));
  assert.deepEqual([step.assignees, step.department, step.created_by], [["p-checker"], undefined, undefined]);
  assert.equal(instanceResource(inst, "Policy").require_object_permission, true);
  assert.equal(stepName({ title: "  " }), '"This step"');
});

await check("due-extension-once: the holder extends a near-overdue step within the cap, once; the row is its own history event", async () => {
  const w = world();
  const now = new Date("2026-10-01T00:00:00Z");
  const inst = w.attach("due-extension-once", {}, { now });
  const due = Date.parse(stepOf(inst, "review").due_on);
  const plus = (days) => new Date(due + days * 86_400_000).toISOString();
  assert.equal((await act(w, inst, "review", { due_on: plus(20) }, "p-maker", { now })).code, "DUE_ON_OVER_CAP");
  assert.equal((await act(w, inst, "review", { due_on: plus(5) }, "p-maker", { now })).status, 200);
  assert.equal(stepOf(inst, "review").due_on, plus(5));
  assert.equal(inst.history.filter((h) => h.type === "due_date_extended").length, 1);
  const second = await act(w, inst, "review", { due_on: new Date(Date.parse(plus(5)) + 86_400_000).toISOString() }, "p-maker", { now });
  assert.deepEqual([second.code, second.message], ["DUE_ON_ALREADY_EXTENDED", '"Review" has already been extended once. No further extensions.']);
});

await check("due-extension-once: refused before the window opens, as a removal, and as a backdate", async () => {
  const w = world();
  const now = new Date("2026-10-01T00:00:00Z");
  const inst = w.attach("due-extension-once", {}, { now });
  const later = Date.parse(stepOf(inst, "later").due_on);
  assert.equal((await act(w, inst, "later", { due_on: new Date(later + 86_400_000).toISOString() }, "p-maker", { now })).code, "DUE_ON_BEFORE_WINDOW");
  assert.equal((await act(w, inst, "review", { due_on: null }, "p-maker", { now })).code, "DUE_ON_REMOVAL");
  const due = Date.parse(stepOf(inst, "review").due_on);
  assert.equal((await act(w, inst, "review", { due_on: new Date(due - 86_400_000).toISOString() }, "p-maker", { now })).code, "DUE_ON_BACKDATE");
  assert.equal((await act(w, inst, "review", { due_on: "not a date" }, "p-maker", { now })).code, "DUE_ON_INVALID");
});

await check("due-extension-once: an administrator bypasses the guard without spending the holder's extension", async () => {
  const w = world();
  const now = new Date("2026-10-01T00:00:00Z");
  const inst = w.attach("due-extension-once", {}, { now });
  const due = Date.parse(stepOf(inst, "review").due_on);
  assert.equal((await act(w, inst, "review", { due_on: new Date(due + 40 * 86_400_000).toISOString() }, "p-admin", { now })).status, 200);
  assert.equal(inst.history.filter((h) => h.type === "due_date_extended").length, 0);
  const current = Date.parse(stepOf(inst, "review").due_on);
  const nearNow = new Date(current - 86_400_000);
  assert.equal((await act(w, inst, "review", { due_on: new Date(current + 2 * 86_400_000).toISOString() }, "p-maker", { now: nearNow })).status, 200);
});

await check("due-extension-once: a re-spelled instant is no change; an unreadable stored date fails closed; an undeclared step is free", async () => {
  const w = world();
  const now = new Date("2026-10-01T00:00:00Z");
  const inst = w.attach("due-extension-once", {}, { now });
  const review = stepOf(inst, "review");
  const respelled = review.due_on.replace(".000Z", "+00:00");
  assert.equal(changesDueOn(review, respelled), false);
  assert.deepEqual(checkDueOnChange({ dsl: w.dsl("due-extension-once"), instance: inst, step: review, requested: respelled, isAdmin: false, now: now.getTime() }), { ok: true });
  review.due_on = "garbage";
  assert.equal((await act(w, inst, "review", { due_on: "2026-10-04T00:00:00Z" }, "p-maker", { now })).code, "DUE_ON_UNREADABLE");
  assert.equal((await act(w, inst, "free", { due_on: "2027-01-01T00:00:00Z" }, "p-maker", { now })).status, 200);
  assert.equal((await act(w, inst, "free", { due_on: null }, "p-maker", { now })).status, 200);
  delete stepOf(inst, "later").due_on;
  assert.equal(checkDueOnChange({ dsl: w.dsl("due-extension-once"), instance: inst, step: stepOf(inst, "later"), requested: "2026-12-01T00:00:00Z", isAdmin: false }).code, "DUE_ON_NOTHING_TO_EXTEND");
  assert.deepEqual(dueDateExtendedEvent("s", "a", "b", "p", "t"), { at: "t", type: "due_date_extended", step_id: "s", detail: "a → b", data: { before: "a", after: "b" }, actor: "p", source: "user" });
});

await check("step rules: checkReassign called directly — the three refusals in order", () => {
  const w = world();
  const inst = w.attach("self-and-supervisor-reassign", { department: "alpha", business_unit: "unit-1" });
  const base = { rbac: w.rbac, instance: inst, step: stepOf(inst, "approve"), dsl: w.dsl("self-and-supervisor-reassign"), directory: w.directory };
  const actor = (id) => w.directory.get(id, "org-a");
  assert.equal(checkReassign({ ...base, actor: actor("p-r1"), next: ["p-r1"] }).code, "REASSIGN_NEEDS_SUPERVISOR");
  assert.equal(checkReassign({ ...base, actor: actor("p-unit-lead"), next: ["p-unit-lead"] }).code, "TAKER_CANNOT_ACT");
  assert.deepEqual(checkReassign({ ...base, actor: actor("p-unit-lead"), next: ["p-unit-lead"], actsWithoutHolding: true }).code, "ASSIGNEE_OUTSIDE_RULE");
  assert.deepEqual(checkReassign({ ...base, actor: actor("p-lead"), next: ["p-r3", "p-checker"] }), { ok: true });
});

// ── 7. cohorts, migrated steps, rbac, diagram, store, identity ───────────────────────────────────────────────────

section("7. Cohorts, migrated steps, RBAC, the diagram, the store, identity");

await check("cohort-wait: the close step opens only when every member of the batch has its review completed", async () => {
  const w = world();
  const watcher = w.attach("cohort-wait", { batch_id: "b1" });
  const members = [1, 2, 3].map(() => w.attach("two-person-review", { department: "alpha", batch_id: "b1" }));
  const outsider = w.attach("two-person-review", { department: "alpha", batch_id: "b2" });
  for (const [i, m] of members.entries()) {
    await act(w, m, "prepare", { state: "completed", ...SUBMIT }, "p-maker");
    await act(w, m, "review", { state: "completed", comment: "ok" }, "p-checker");
    assert.equal(stepOf(watcher, "close").status, i === 2, `after member ${i + 1}`);
  }
  assert.equal(stepOf(outsider, "review").state, "open");
  const fired = watcher.history.find((h) => h.type === "diff_rule_fired");
  assert.deepEqual([fired.source, fired.actor, fired.origin_instance_id], ["cohort", "p-checker", members[2].id]);
  assert.deepEqual(watcher.fired_once, [1]);
});

await check("cohort-wait: join keys compare by value (1 and \"1\" join); object keys never collapse; organizations never join", () => {
  const w = world();
  const done = (inst) => { stepOf(inst, "review").state = "completed"; return inst; };
  const watcher = w.attach("cohort-wait", { batch_id: 1 });
  const member = done(w.attach("two-person-review", { department: "alpha", batch_id: "1" }));
  assert.deepEqual(runCohortRules(w.instances, (i) => w.dsl(i.workflow_id), member, w.directory).map((i) => i.id), [watcher.id]);

  const v = world();
  const objWatcher = v.attach("cohort-wait", { batch_id: { a: 1 } });
  const objMember = done(v.attach("two-person-review", { department: "alpha", batch_id: { a: 2 } }));
  assert.deepEqual(runCohortRules(v.instances, (i) => v.dsl(i.workflow_id), objMember, v.directory), []);
  assert.equal(stepOf(objWatcher, "close").status, false);

  const shared = [];
  const a = world({ instances: shared });
  const b = world({ org: "org-b", instances: shared });
  const foreign = b.attach("cohort-wait", { batch_id: "b9" });
  const local = done(a.attach("two-person-review", { department: "alpha", batch_id: "b9" }));
  assert.deepEqual(runCohortRules(shared, (i) => a.dsl(i.workflow_id), local, a.directory), []);
  assert.equal(stepOf(foreign, "close").status, false);
});

await check("migrated-step: a step starts completed with its migrated date and evidence, credited to its holder", () => {
  const w = world();
  const inst = w.attach("migrated-step", {});
  const earlier = stepOf(inst, "earlier");
  assert.deepEqual([earlier.state, earlier.completed_at], ["completed", "2026-10-01T10:00:00+00:00"]);
  assert.deepEqual(earlier.evidence.map((e) => [e.ref, e.actor]), [["doc://archive/1", "p-maker"], ["doc://archive/2", "p-maker"]]);
  assert.equal(earlier.evidence[1].at, "2026-09-30T09:00:00Z");
  assert.deepEqual([stepOf(inst, "next").completed_at, stepOf(inst, "next").evidence], [undefined, []]);
});

await check("rbac: deny by default; never across organizations; read-only holders still act on their own step", () => {
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha" });
  const res = instanceResource(inst);
  const user = (id) => w.directory.get(id, "org-a");
  assert.equal(w.rbac.can({ id: "x", role: "none", organization_id: "org-a" }, "read", res), false);
  assert.equal(w.rbac.can({ ...user("p-admin"), organization_id: "org-b" }, "read", res), false);
  w.rbac.seedRoles([...PEOPLE.roles, { name: "reader", permissions: [{ object_name: "Actionable", permission: "AssignedReadAll" }] }], "org-a");
  const holder = { ...user("p-maker"), role: "reader" };
  assert.deepEqual(["read", "act", "write"].map((a) => w.rbac.can(holder, a, res)), [true, true, false]);
  assert.equal(w.rbac.can(user("p-viewer"), "read", res), true);
  assert.equal(w.rbac.can(user("p-viewer"), "write", res), false);
});

await check("rbac: department scope covers every department of a record and of a person; business-unit and reportee scopes", () => {
  const w = world();
  const res = { type: "instance", id: "i", organization_id: "org-a", department: "beta", departments: ["gamma"], business_unit: "unit-1", assignees: ["p-maker"] };
  const lead = { id: "x", role: "lead", organization_id: "org-a", department: "delta", departments: ["gamma"] };
  assert.equal(w.rbac.can(lead, "write", res), true);
  assert.equal(w.rbac.can({ ...lead, departments: "gamma" }, "write", res), false, "a malformed list denies instead of throwing");
  assert.equal(w.rbac.can(w.directory.get("p-unit-lead", "org-a"), "write", res), true);
  w.rbac.seedRoles([...PEOPLE.roles, { name: "manager", permissions: [{ object_name: "Actionable", permission: "ReporteeAssignedReadUpdateAll" }] }], "org-a");
  assert.equal(w.rbac.can({ id: "p-lead", role: "manager", organization_id: "org-a" }, "write", res), true, "p-maker reports to p-lead");
  assert.equal(w.rbac.can({ id: "p-head", role: "manager", organization_id: "org-a" }, "write", res), false);
});

await check("rbac: SelfCreatedAll never makes the creator an administrator; grants add to the role and expire", () => {
  const w = world();
  w.rbac.seedRoles([{ name: "creator", permissions: [{ permission: "SelfCreatedAll" }] }], "org-a");
  const res = { type: "instance", id: "i1", organization_id: "org-a", created_by: "c" };
  const creator = { id: "c", role: "creator", organization_id: "org-a" };
  assert.deepEqual(["write", "admin"].map((a) => w.rbac.can(creator, a, res)), [true, false]);
  const past = new Date(Date.now() - 1000).toISOString();
  w.rbac.seedGrants([
    { user_id: "g", resource_type: "instance", resource_id: "i1", actions: ["delete"] },
    { user_id: "g", resource_type: "instance", resource_id: "i1", actions: ["admin"], expires_at: past },
    { user_id: "g", resource_type: "instance", resource_id: "i1", actions: ["read"], expires_at: "whenever" },
    { user_id: "g", resource_type: "instance", resource_id: "i1", actions: ["write"], is_active: false },
  ], "org-a");
  const g = { id: "g", role: "none", organization_id: "org-a" };
  assert.deepEqual(["delete", "admin", "read", "write"].map((a) => w.rbac.can(g, a, res)), [true, false, false, false]);
  assert.equal(w.rbac.can(g, "delete", res, { ignoreGrants: true }), false);
});

await check("rbac: the reporting matrix keeps every manager, scopes rows to a business unit, and ignores duplicates", () => {
  const rbac = new Rbac();
  rbac.seedReporting([
    { reporting_manager: "m1", reportee: "r" },
    { reporting_manager: "m2", reportee: "r", business_unit: "u1" },
    { reporting_manager: "m1", reportee: "r" },
  ]);
  assert.deepEqual(rbac.managers("r"), ["m1"]);
  assert.deepEqual(rbac.managers("r", "u1"), ["m1", "m2"]);
  assert.deepEqual(rbac.reportees("m2", "u1"), ["r"]);
  assert.deepEqual(rbac.reportees("m2"), []);
});

await check("diagram: a flowchart from the start step, decisions on edges, send-backs dotted, conditions in nodes, deterministic", () => {
  const dsl = fixture("two-person-review");
  const text = renderWorkflowMermaid(dsl);
  assert.ok(text.startsWith("flowchart LR\n  START((start)) --> prepare"));
  assert.match(text, /prepare -->\|"approve"\| review/);
  assert.match(text, /review -\.->\|"reject"\| prepare/);
  assert.match(text, /review -->\|"approve"\| COMPLETE\(\(complete\)\)/);
  assert.match(text, /prepare\["Prepare<br\/>📎 evidence required<br\/>💬 comment required<br\/>⏱ due \+3d"\]/);
  assert.equal(renderWorkflowMermaid(dsl), text);
  assert.equal(renderWorkflowMermaid({ init: { start_id: "x", steps: [] }, diff: [] }), "");
  assert.deepEqual(stepConditions({ assignee: { limit: 2, condition: { $or: { query: { role: { $in: ["lead", "admin"] } } } } } }), ["👤 lead / admin", "🔒 2 assignees max"]);
});

await check("diagram: steps with no routing rule are joined in their authored order; ids and quotes are made safe", () => {
  const text = renderWorkflowMermaid({ init: { start_id: "1st", steps: [{ id: "1st", title: 'Say "hi"' }, { id: "b-2", title: "B" }] }, diff: [] });
  assert.match(text, /s_1st\["Say &quot;hi&quot;"\]/);
  assert.match(text, /s_1st -->\|"then"\| b_2/);
});

await check("store: definitions keep immutable versions and refuse a stale or duplicate write", async () => {
  const store = new InMemoryStore();
  const def = { id: "w", organization_id: "org-a", version: 1, dsl: fixture("two-person-review"), registered_at: "t" };
  await store.registerWorkflow(def);
  await assert.rejects(store.registerWorkflow(def), PersistenceConflictError);
  assert.deepEqual(await store.upsertWorkflow({ ...def, version: 1 }), { created: false });
  const stale = await store.upsertWorkflow({ ...def, version: 1 }).catch((e) => e);
  assert.ok(stale instanceof PersistenceConflictError);
  assert.equal(stale.code, "STALE_REVISION");
  assert.equal((await store.getWorkflowVersion("w", 1, "org-a")).version, 1);
  assert.equal((await store.getWorkflow("w", "org-a")).version, 2);
  assert.equal(await store.getWorkflow("w", "org-b"), undefined);
});

await check("store: instances are copy-on-read and compare-and-swap; one attachment per workflow and object; deletes wait for force", async () => {
  const store = new InMemoryStore();
  const w = world();
  await store.registerWorkflow({ id: "two-person-review", organization_id: "org-a", version: 1, dsl: w.dsl("two-person-review"), registered_at: "t" });
  const inst = w.attach("two-person-review", { department: "alpha" });
  await store.saveInstance(inst);
  assert.equal(inst.revision, 1);
  const read = await store.getInstance(inst.id, "org-a");
  read.steps[0].state = "completed";
  assert.equal((await store.getInstance(inst.id, "org-a")).steps[0].state, "open");
  const old = { ...read, revision: 0 };
  await assert.rejects(store.saveInstance(old), /changed concurrently/);
  await store.saveInstance(read);
  assert.equal(read.revision, 2);
  const twin = { ...clone(inst), id: "other", revision: 0 };
  await assert.rejects(store.saveInstance(twin), /attachment already exists/);
  assert.equal(await store.getInstance(inst.id, "org-b"), undefined);
  await assert.rejects(store.deleteWorkflow("two-person-review", false, "org-a"), /attached instance/);
  await store.deleteWorkflow("two-person-review", true, "org-a");
});

await check("store: object reads project the summary fields; a scope reassignment moves every lineage with a history row", async () => {
  const store = new InMemoryStore();
  const w = world();
  const inst = w.attach("two-person-review", { department: "alpha", secret: "x" }, { objectId: "obj-1" });
  await store.saveInstance(inst);
  const [summary] = await store.listInstancesForObjects("org-a", "record", ["obj-1"]);
  assert.equal(summary.task.secret, undefined);
  assert.deepEqual(summary.steps.map((s) => Object.keys(s).sort()), [["assignee", "id"], ["assignee", "id"]]);
  assert.deepEqual(projectSummaryFields(inst).task, { department: "alpha" });
  assert.deepEqual(await store.reassignObjectScope("org-a", "record", "obj-1", { department: "beta" }), { matched: 1, updated: 1 });
  const moved = await store.getInstance(inst.id, "org-a");
  assert.equal(moved.task.department, "beta");
  assert.equal(moved.history.at(-1).type, "task_updated");
});

await check("identity: the signed gateway principal is accepted fresh and refused tampered, expired or too long-lived", () => {
  const secret = "s3cret";
  const now = 1_800_000_000;
  const provider = new SignedGatewayIdentityProvider({ secret, now: () => now });
  const sign = (claims) => {
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { "x-workflow-principal": encoded, "x-workflow-signature": createHmac("sha256", secret).update(encoded).digest("base64url") };
  };
  assert.deepEqual(provider.authenticate(sign({ sub: "p-maker", org: "org-a", iat: now, exp: now + 60 })), { actor_id: "p-maker", organization_id: "org-a" });
  const forged = sign({ sub: "p-maker", org: "org-a", iat: now, exp: now + 60 });
  forged["x-workflow-principal"] = Buffer.from(JSON.stringify({ sub: "p-admin", org: "org-a", iat: now, exp: now + 60 })).toString("base64url");
  assert.equal(provider.authenticate(forged), undefined);
  assert.equal(provider.authenticate(sign({ sub: "p", org: "o", iat: now - 600, exp: now - 300 })), undefined);
  assert.equal(provider.authenticate(sign({ sub: "p", org: "o", iat: now, exp: now + 3600 })), undefined);
  assert.equal(provider.authenticate({ "x-actor-id": "p-admin" }), undefined, "raw headers are ignored");
});

await check("identity: a snapshot is validated whole before anything changes", () => {
  const ok = validateIdentitySnapshot({ organization_id: "org-a", users: PEOPLE.users, roles: PEOPLE.roles, reporting: [{ reporting_manager: "p-lead", reportee: "p-maker" }] });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.snapshot.users.length, PEOPLE.users.length);
  const bad = validateIdentitySnapshot({
    organization_id: "org-a",
    users: [{ id: "u", role: "ghost", departments: "alpha" }],
    roles: [{ name: "r", permissions: [{ permission: "Everything" }] }],
    grants: [{ user_id: "nobody", resource_type: "instance", resource_id: "i", actions: ["read"] }],
  });
  assert.equal(bad.snapshot, undefined);
  const text = bad.issues.join("\n");
  assert.match(text, /departments must be an array of strings/);
  assert.match(text, /role "ghost" is absent from roles/);
  assert.match(text, /permission is unsupported/);
  assert.match(text, /must reference a snapshot user/);
});

// ── 8. the coverage map ──────────────────────────────────────────────────────────────────────────────────────────

section("8. The coverage map (UPSTREAM.json)");

await check("coverage: every upstream test file is mapped, and every case the map names exists in this file", () => {
  const record = JSON.parse(readFileSync(join(ENGINE, "UPSTREAM.json"), "utf8"));
  const upstream = record.upstream_tests;
  assert.ok(Array.isArray(upstream) && upstream.length > 0, "UPSTREAM.json records the upstream test files");
  const mapped = Object.keys(record.coverage ?? {});
  assert.deepEqual(upstream.filter((f) => !mapped.includes(f)), [], "upstream test files with no coverage entry");
  assert.deepEqual(mapped.filter((f) => !upstream.includes(f)), [], "coverage entries for files upstream does not have");
  const names = new Set(ran);
  for (const [file, entry] of Object.entries(record.coverage)) {
    assert.ok(Array.isArray(entry.cases) && typeof entry.ported === "string", `${file}: { ported, cases[], not_ported? }`);
    for (const c of entry.cases) assert.ok(names.has(c) || c === "coverage: every upstream test file is mapped, and every case the map names exists in this file", `${file} names a case this file does not have: ${c}`);
    if (entry.cases.length === 0) assert.ok(entry.not_ported, `${file}: no cases, so it must say why it is not ported`);
  }
});

console.log(`\ntest-workflow-engine: ${passed}/${ran.length} passed`);
