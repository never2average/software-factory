#!/usr/bin/env node
/**
 * "OFF" CHANGES NOTHING: the task writes a lifecycle under `enforce: "off"` must answer exactly as before lifecycles
 * were enforced. The cases (creates and moves through every transition and every rule, with and without the stored
 * row, each role, comments, four eyes) and the runner that answers them with a checkout's own validator.
 *
 *   node --experimental-strip-types scripts/lib/record-lifecycle-off-cases.mjs <checkout> <areas.json>
 *
 * prints, per case, what agent/lib/task-area.ts prepareTaskWrite answers (what reaches the task service, or the
 * refusal) and what agent/lib/record-validate.ts validateRecordWrite answers, without its `transition` report (an
 * informational field no caller reads, which now names the comment and four-eyes rules too) and without `lifecycle`
 * (new, and null under "off": the test asserts that). scripts/test-record-lifecycle.mjs compares the current checkout's
 * answers with the ones upstream main gave at fc2ea3e (fixtures/record-lifecycle/off-baseline.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NOW = "2026-10-14T08:00:00.000Z";
const ANA = "ana@example.com";
const BO = "bo@example.com";

/** [label, mode, body, who] per area set; `who.before` is the stored row. */
export function offCases() {
  const task = (status, extra = {}) => ({ title: "Chase the invoice", status, done: status === "done", assignee: ANA, createdBy: ANA, dueAt: null, custom: {}, ...extra });
  const ob = (state, extra = {}) => ({ title: "ALM return", status: "in_progress", assignee: ANA, createdBy: ANA, dueAt: "2026-10-31T09:00:00.000Z", custom: { state, frequency: "Quarterly" }, ...extra });
  const pipeline = [];
  for (const role of [undefined, "member", "admin"]) {
    for (const actor of [ANA, BO]) {
      const who = (before, extra = {}) => ({ actor, ...(role ? { role } : {}), now: NOW, before, ...extra });
      pipeline.push(
        ["create, initial", "create", { title: "New task", createdBy: actor }, who(null)],
        ["create, in progress", "create", { title: "New task", status: "in_progress" }, who(null)],
        ["create, done", "create", { title: "Done already", status: "done" }, who(null)],
        ["start", "update", { status: "in_progress", actor }, who(task("open"))],
        ["start, no stored row", "update", { status: "in_progress" }, who(null)],
        ["park", "update", { status: "backlog" }, who(task("open"))],
        ["block without a comment", "update", { status: "blocked" }, who(task("in_progress"))],
        ["block with a comment", "update", { status: "blocked", reason: "waiting on the bank" }, who(task("in_progress"))],
        ["sign off without a due date", "update", { status: "done" }, who(task("in_progress"))],
        ["sign off with a due date", "update", { status: "done", dueAt: "2026-10-20T09:00:00.000Z" }, who(task("in_progress", { dueAt: "2026-10-20T09:00:00.000Z" }))],
        ["sign off by who started it", "update", { status: "done" }, who(task("in_progress", { dueAt: "2026-10-20T09:00:00.000Z" }), { enteredBy: actor })],
        ["done by the flag", "update", { done: true }, who(task("in_progress"))],
        ["reopen by the flag", "update", { done: false }, who(task("done"))],
        ["by a stage", "update", { stageId: "done" }, who(task("open"), { stageState: "done" })],
        ["skip ahead", "update", { status: "done" }, who(task("open"))],
        ["cancel without a comment", "update", { status: "cancelled" }, who(task("open"))],
        ["cancel with a comment", "update", { status: "cancelled", reason: "duplicate" }, who(task("open"))],
        ["not a move", "update", { title: "Renamed", priority: "high" }, who(task("open"))],
        ["same state", "update", { status: "open" }, who(task("open"))],
        ["a wrong status", "update", { status: "waiting" }, who(task("open"))],
      );
    }
  }
  const obligation = [];
  for (const role of [undefined, "member", "admin"]) {
    for (const actor of [ANA, BO]) {
      const who = (before, extra = {}) => ({ actor, ...(role ? { role } : {}), now: NOW, before, ...extra });
      obligation.push(
        ["create", "create", { title: "ALM return", dueAt: "2026-10-31", custom: { frequency: "quarterly" } }, who(null)],
        ["create, under review", "create", { title: "ALM return", dueAt: "2026-10-31", custom: { state: "under_review" } }, who(null)],
        ["start", "update", { custom: { state: "in_progress" } }, who(ob("not_started"))],
        ["submit without evidence", "update", { custom: { state: "evidence_submitted" } }, who(ob("in_progress"))],
        ["submit with evidence", "update", { custom: { state: "evidence_submitted", evidence: ["obligations/evidence/a.pdf"] } }, who(ob("in_progress"))],
        ["take for review", "update", { custom: { state: "under_review" } }, who(ob("evidence_submitted", { custom: { state: "evidence_submitted", evidence: ["x/a.pdf"] } }))],
        ["mark complied", "update", { custom: { state: "closed" } }, who(ob("under_review"))],
        ["ask for more without a comment", "update", { custom: { state: "in_progress" } }, who(ob("under_review"))],
        ["ask for more with a comment", "update", { custom: { state: "in_progress" }, reason: "the scan is unreadable" }, who(ob("under_review"))],
        ["not applicable", "update", { custom: { state: "not_applicable" }, reason: "not our licence" }, who(ob("not_started"))],
        ["skip ahead", "update", { custom: { state: "closed" } }, who(ob("not_started"))],
        ["a direct status", "update", { status: "done" }, who(ob("under_review"))],
        ["own fields only", "update", { custom: { department: "IT" } }, who(ob("in_progress"))],
      );
    }
  }
  return { pipeline, obligation };
}

/** Answer every case with the checkout at `root`, under the compiled areas `areasBySet` ({ pipeline, obligation }). */
export async function runOffCases(root, areasBySet) {
  const { prepareTaskWrite } = await import(pathToFileURL(join(root, "agent/lib/task-area.ts")).href);
  const { validateRecordWrite } = await import(pathToFileURL(join(root, "agent/lib/record-validate.ts")).href);
  const PASS = ["createdBy", "actor", "reason", "idempotencyKey", "archived", "stageId"];
  const out = {};
  for (const [set, cases] of Object.entries(offCases())) {
    const areas = areasBySet[set];
    out[set] = cases.map(([label, mode, body, who]) => {
      const w = { ...who, now: new Date(who.now) };
      const prepared = prepareTaskWrite(mode, body, w, areas);
      const { transition: _t, lifecycle, ...validated } = validateRecordWrite("tasks", { mode, patch: body, actor: w.actor, role: w.role, now: w.now, passThrough: PASS, before: w.before ?? null }, areas);
      return { label, who: { actor: w.actor, role: w.role ?? null }, prepared, validated, ...(lifecycle ? { lifecycle } : {}) };
    });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [root, areasPath] = process.argv.slice(2);
  const areasBySet = JSON.parse(readFileSync(areasPath, "utf8"));
  process.stdout.write(`${JSON.stringify(await runOffCases(root, areasBySet), null, 1)}\n`);
}
