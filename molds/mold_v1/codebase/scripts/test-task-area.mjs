/**
 * TASKS AS THE DEPLOYMENT DEFINES THEM (profiles records.areas.tasks), OFFLINE: what the model and a coding agent
 * read, and what a write sends, under the default definition and under a redefined one (the record-areas design's
 * obligation example, scripts/fixtures/record-areas/examples/obligation.json).
 *
 *   1. THE DEFAULT SURFACE IS BYTE-IDENTICAL. With no profile redefining tasks, the model's root prompt and its todo
 *      tools render exactly as recorded (scripts/fixtures/agent-vocabulary/default-surface.txt), and the coding
 *      agent's task tools are exactly upstream main's (fixtures/record-areas/mcp-task-tools-before.json).
 *   2. A REDEFINED TASK, in a copy of the checkout under the obligation profile: upsert_todo and list_todos are
 *      built from the definition (its words, its own fields as enums, its states; no status to set), the per-turn
 *      briefing carries the task's card, and nothing else the model reads moves.
 *   3. The coding agent's task tools under a redefined task (the hosted endpoint passes the definition).
 *   4. A write, prepared (agent/lib/task-area.ts): the default sends a valid body as it came; a redefined one is
 *      normalised, defaulted, and its status derived from its state's category.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-task-area.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyWithProfiles, surfaceSections } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIX = join(ROOT, "scripts/fixtures/record-areas");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
let passed = 0;
const check = (what, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    console.error(`  FAIL ${what}\n${e.message}`);
    process.exitCode = 1;
  }
};
const OBLIGATION = read(join(FIX, "golden/obligation.areas.json"));
const { areaView, describeArea } = await import("../agent/lib/record-areas.ts");
const SURFACE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/lib/model-surface.mjs", "--snapshot", "--no-results"];
const TASK_SECTION = /:: tool :: (upsert_todo|list_todos)$/;
/** What a redefined task may move: the root prompt, its per-turn briefing, the two todo tools (in any agent). */
const MAY_MOVE = (k) => k === "root :: prompt" || k === "root :: per-turn briefing" || TASK_SECTION.test(k);

// --- 1. the default surface ------------------------------------------------------------------------------------------
console.log("1. The default definition: what the model and a coding agent read is what it was");
const here = spawnSync(process.execPath, SURFACE, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
const now = surfaceSections(here.stdout);
const recorded = surfaceSections(readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"));
check("the surface renders", () => assert.equal(here.status, 0, here.stderr.slice(-2000)));
check("the root prompt, its per-turn briefing and every todo tool, in every agent, are byte for byte the recorded ones", () => {
  const keys = [...recorded.keys()].filter(MAY_MOVE);
  assert.ok(keys.length >= 4, `sections: ${keys.join(", ")}`);
  for (const k of keys) assert.equal(now.get(k), recorded.get(k), k);
});
const FOLDERS = { accounts: "A", platform: "P", deliveries: "D", solutions: "S", projects: "J", tickets: "T", people: "E", uploads: "U" };
const { createTools } = await import("../setup/workspace-tools.mjs");
const taskTools = (extra = {}) => Object.fromEntries(createTools({ api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null, folders: FOLDERS, ...extra }).filter((t) => t.name.startsWith("task_")).map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }]));
check("the coding agent's task tools, in each period mode, are upstream main's byte for byte", () => {
  const before = read(join(FIX, "mcp-task-tools-before.json"));
  const modes = { "host-default": undefined, individual: { mode: "individual", label: { singular: "week", plural: "weeks" }, itemLabel: { singular: "goal", plural: "goals" } }, off: { mode: "off" } };
  for (const [k, wp] of Object.entries(modes)) assert.equal(JSON.stringify(taskTools({ workPeriods: wp })), JSON.stringify(before[k]), k);
});

// --- 2. a redefined task, in a copy -----------------------------------------------------------------------------------
console.log("2. A redefined task (a copy under the obligation example)");
const copy = copyWithProfiles(ROOT, [["50-obligation.json", join(FIX, "examples/obligation.json")]]);
let redefined;
try {
  redefined = surfaceSections(copy.run(SURFACE.slice(2)).stdout);
} finally {
  copy.remove();
}
const upsert = redefined.get("root :: tool :: upsert_todo") ?? "";
const list = redefined.get("root :: tool :: list_todos") ?? "";
const schemaOf = (section) => JSON.parse(section.slice(section.indexOf("{")));
check("upsert_todo speaks of an obligation, says how to move one, and carries the card", () => {
  assert.match(upsert, /Create OR update an obligation \(the team's obligations; NOT an account ticket/);
  assert.match(upsert, /Move it by setting `custom\.state` \(its state\); its status follows, never set it\./);
  assert.match(upsert, /- An \*\*obligation\*\* \(plural: obligations\): Something the company must do for a regulator/);
});
check("…its input: the own fields as enums under custom, the state's choices, no status or done to set, the definition's priorities", () => {
  const s = schemaOf(upsert);
  assert.equal(s.properties.status, undefined);
  assert.equal(s.properties.done, undefined);
  assert.deepEqual(s.properties.priority.enum, ["high", "normal", "low"]);
  assert.match(s.properties.priority.description, /high \("Critical"\)/);
  const custom = s.properties.custom;
  assert.deepEqual(custom.properties.frequency.anyOf?.[0]?.enum ?? custom.properties.frequency.enum, ["One-time", "Monthly", "Quarterly", "Half-yearly", "Annual", "Event-based"]);
  assert.deepEqual(custom.properties.state.anyOf?.[0]?.enum ?? custom.properties.state.enum, ["not_started", "in_progress", "evidence_submitted", "under_review", "closed", "not_applicable"]);
  assert.match(s.properties.dueAt.description, /^Due: a date \(yyyy-mm-dd\) or an ISO-8601 date-time; required/);
  assert.match(s.properties.assignee.description, /^Owner: an email; you when omitted on create/);
});
check("list_todos lists obligations with their state and own fields, and filters by state", () => {
  assert.match(list, /List the team's obligations, newest first, with their state and their own fields/);
  assert.deepEqual(schemaOf(list).properties.state.enum, ["not_started", "in_progress", "evidence_submitted", "under_review", "closed", "not_applicable"]);
});
check("the per-turn briefing carries the obligation's card: its own fields, its states, and from each the moves there are with what each needs", () => {
  const prompt = redefined.get("root :: per-turn briefing");
  assert.match(prompt, /- An \*\*obligation\*\* \(plural: obligations\): Something the company must do/);
  assert.match(prompt, /Its state is `custom\.state`: "not_started" \("Not started"\), "in_progress" \("In progress"\)/);
  assert.match(prompt, /- From "In progress" you can go to "Evidence submitted" \(Submit evidence; needs "Evidence" set\)/);
  assert.match(prompt, /"Complied" \(Mark complied; owner or admin only; not by its owner\)/);
  assert.match(prompt, /Written with upsert_todo, read with list_todos\./);
});
check("nothing else the model reads moved: every other section is the default's", () => {
  const moved = [...recorded.keys()].filter((k) => !MAY_MOVE(k) && recorded.get(k) !== redefined.get(k));
  // The root prompt and its per-turn briefing gain the card, appended to the briefing's list, and nothing else.
  const card = `\n${describeArea("tasks", OBLIGATION)}\n  Written with upsert_todo, read with list_todos.`;
  for (const k of ["root :: prompt", "root :: per-turn briefing"]) {
    assert.ok(redefined.get(k).includes(card), `${k} carries the card`);
    assert.equal(redefined.get(k).replace(card, ""), recorded.get(k), `${k} is otherwise the default's`);
  }
  assert.deepEqual(moved, []);
});

// --- 3. the coding agent's tools under a redefined task --------------------------------------------------------------
console.log("3. The coding agent's task tools under a redefined task");
const v = areaView("tasks", OBLIGATION);
const hostTasks = {
  noun: v.noun,
  nouns: v.nouns,
  stateField: v.lifecycle.field,
  states: v.lifecycle.states.map((s) => ({ value: s.value, label: s.label })),
  priorities: v.options("priority").map((o) => ({ value: o.value, label: o.label })),
  ownFields: v.ownFields.filter((f) => !f.hidden && !f.computed).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label ?? o.value })) } : {}), ...(f.many ? { many: true } : {}) })),
};
const hosted = taskTools({ tasks: hostTasks });
check("task_create and task_update: no status (it follows the state), the state and own fields under custom, the definition's priorities", () => {
  for (const name of ["task_create", "task_update"]) {
    const p = hosted[name].inputSchema.properties;
    assert.equal(p.status, undefined, name);
    assert.deepEqual(p.priority.enum, ["high", "normal", "low"], name);
    assert.deepEqual(p.custom.properties.state.enum, ["not_started", "in_progress", "evidence_submitted", "under_review", "closed", "not_applicable"], name);
    assert.deepEqual(p.custom.properties.department.enum, ["Compliance", "Finance", "Operations", "Risk", "Legal", "IT", "HR"], name);
    assert.deepEqual(p.custom.properties.evidence, { type: "array", items: { type: "string" }, description: "Evidence: file." }, name);
    assert.equal(p.custom.additionalProperties, false, name);
  }
  assert.match(hosted.task_create.description, /^Create an obligation, optionally LINKED/);
  assert.match(hosted.task_update.description, /^Correct, move or close an existing obligation\. Move it by setting custom\.state; its status follows\./);
});

// --- 4. a write, prepared ---------------------------------------------------------------------------------------------
console.log("4. A write, prepared (agent/lib/task-area.ts)");
const { prepareTaskWrite } = await import("../agent/lib/task-area.ts");
const { RECORD_AREAS } = await import("../agent/lib/record-areas.generated.ts");
const who = { actor: "ana@example.com", now: new Date("2026-10-14T08:00:00Z") };
check("default: a valid body is sent as it came (null: forward the original text)", () => {
  assert.deepEqual(prepareTaskWrite("create", { title: "x", createdBy: "ana@example.com" }, who, RECORD_AREAS), { ok: true, body: null, warnings: [] });
  assert.deepEqual(prepareTaskWrite("update", { status: "done", actor: "ana@example.com" }, who, RECORD_AREAS), { ok: true, body: null, warnings: [] });
});
check("default: an own field, a wrong status, a too-long title are refused with sentences", () => {
  const r = prepareTaskWrite("update", { custom: { a: 1 }, status: "waiting", title: "x".repeat(301) }, who, RECORD_AREAS);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3, r.errors.join(" | "));
});
check("redefined: a create is normalised and defaulted, and carries the status of its initial state's category", () => {
  const r = prepareTaskWrite("create", { title: "ALM", dueAt: "2026-10-31", custom: { frequency: "monthly" }, createdBy: "ana@example.com" }, who, OBLIGATION);
  assert.deepEqual(r, { ok: true, warnings: [], body: { title: "ALM", dueAt: "2026-10-31T09:00:00.000Z", createdBy: "ana@example.com", assignee: "ana@example.com", custom: { frequency: "Monthly", state: "not_started" }, status: "open", statusFrom: "category" } });
});
check("redefined: a move by state carries its category's status; a move to a done state carries done", () => {
  assert.deepEqual(prepareTaskWrite("update", { custom: { state: "evidence_submitted" }, actor: "ana@example.com" }, who, OBLIGATION).body, { actor: "ana@example.com", custom: { state: "evidence_submitted" }, status: "in_progress", statusFrom: "category" });
  assert.deepEqual(prepareTaskWrite("update", { custom: { state: "Complied" } }, who, OBLIGATION).body, { custom: { state: "closed" }, status: "done", statusFrom: "category" });
  assert.deepEqual(prepareTaskWrite("update", { custom: { department: "IT" } }, who, OBLIGATION).body, { custom: { department: "IT" } }, "a write that moves nothing carries no status");
});

console.log(process.exitCode ? `test-task-area: FAILED (${passed} passed)` : `test-task-area: all ${passed} checks passed`);
