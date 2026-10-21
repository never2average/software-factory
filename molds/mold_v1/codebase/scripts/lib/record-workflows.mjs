/**
 * RECORD WORKFLOWS, AT BUILD TIME (profiles `records.workflows`; docs/DEPLOYMENT_PROFILE.md "records.workflows";
 * docs/WORKFLOW_ENGINE.md, phase 2 of 8). A profile or a pack may supply workflow documents in the vendored engine's DSL
 * (its `init` + `diff` shape) and bind a record area's lifecycle to one:
 *
 *   records.workflows.<id>                                   a workflow document
 *   records.areas.<area>.lifecycle.workflow                  "<id>": the workflow this lifecycle runs
 *   records.areas.<area>.lifecycle.transitions[i].step       { id, state }: making this move changes that step
 *   records.areas.<area>.lifecycle.workflow_states           { "<record state>": { "<step id>": "<step state>" } }:
 *                                                            where a record already mid-lifecycle stands, for its
 *                                                            workflow instance to be created lazily
 *   records.areas.<area>.lifecycle.workflow_due              { "<step id>": { "field": "<date field>", "days": n } }:
 *                                                            the step's due date anchored to a date of the record
 *
 * This file is only the build's checks: nothing at runtime reads a workflow yet. workflowProblem() checks one document
 * (the engine's spec.json, then its semantic validator, then what this phase refuses); bindingProblem() checks a
 * compiled area's binding. Both return the first problem as { path, message } (path relative to records.workflows.<id>
 * or records.areas.<area>), or null, as scripts/lib/record-areas.mjs checkArea() does.
 *
 * Pure but for reading spec.json: no process, no output. Ajv (a devDependency) is loaded only when a profile declares a
 * workflow, so a profile that declares none builds exactly as before.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { STEP_STATES } from "../../lib/workflow-engine/dsl/types.ts";
import { validateWorkflow } from "../../lib/workflow-engine/dsl/validate.ts";

export { STEP_STATES };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const quote = (v) => JSON.stringify(v);
const list = (xs) => xs.map(quote).join(", ");

/** A workflow id: lowercase words of letters and digits joined by "-" or "_", starting with a letter. */
export const WORKFLOW_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
export const WORKFLOW_ID_MAX = 64;
/** How far from the record's date a step's anchored due date may fall, in days (lifecycle.workflow_due). */
export const DUE_DAYS_MAX = 3650;

/**
 * What the app refuses, and why (docs/WORKFLOW_ENGINE.md). Email and agent actions run (phase 6): an email becomes the
 * app's own notification to the step's holders, an agent run a task for the assistant; nothing sends an email. What
 * still cannot run: a branch a model would resolve, and an email's attachments.
 */
export const LATER = {
  prompt: 'a "prompt" branch is resolved by a model, which this app does not run; give the deterministic branch instead ("query", or "value")',
  attachments: "an email action's attachments are generated or searched for, which this app does not do; the notification names the step and the record instead",
};

let structural = null;
/** The engine's spec.json (Draft 2020-12), compiled once, through Ajv as the engine's test does. */
function structuralValidator() {
  if (structural) return structural;
  const require = createRequire(import.meta.url);
  let Ajv2020;
  try {
    Ajv2020 = require("ajv/dist/2020").default;
  } catch {
    throw new Error('checking a workflow against the engine\'s spec.json needs the "ajv" package (a devDependency of this checkout): run npm ci');
  }
  const spec = JSON.parse(readFileSync(new URL("../../lib/workflow-engine/dsl/spec.json", import.meta.url), "utf8"));
  structural = new Ajv2020({ allErrors: false, strict: true }).compile(spec);
  return structural;
}

/** An Ajv instance path ("/init/steps/0/title") as the profile's own path ("init.steps[0].title"). */
export function pathOf(instancePath) {
  let out = "";
  for (const raw of instancePath.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += /^\d+$/.test(seg) ? `[${seg}]` : out ? `.${seg}` : seg;
  }
  return out;
}

/** One Ajv error as a sentence: its message, with the key or the values it names. */
function ajvMessage(e) {
  if (e.keyword === "additionalProperties") return `${e.message} ("${e.params.additionalProperty}")`;
  if (e.keyword === "enum") return `${e.message} (${list(e.params.allowedValues)})`;
  return e.message;
}

/** A `prompt` branch, or an email's attachments: what the app cannot run. The first, in document order. */
function laterPhaseProblem(doc) {
  for (const [i, step] of doc.init.steps.entries()) {
    for (const k of ["assignee", "evidence_required", "comments_required"]) {
      const or = step?.[k]?.condition?.$or;
      if (isObj(or) && "prompt" in or) return { path: `init.steps[${i}].${k}.condition.$or.prompt`, message: LATER.prompt };
    }
  }
  for (const [i, rule] of doc.diff.entries()) {
    if (isObj(rule.applicability_query) && "prompt" in rule.applicability_query) return { path: `diff[${i}].applicability_query.prompt`, message: LATER.prompt };
    for (const [k, expr] of Object.entries(rule.action?.internal?.set ?? {})) {
      if (isObj(expr) && "prompt" in expr) return { path: `diff[${i}].action.internal.set.${k}.prompt`, message: LATER.prompt };
    }
    const email = rule.action?.external?.email;
    if (isObj(email)) {
      const at = `diff[${i}].action.external.email`;
      if (isObj(email.recipients?.$or) && "prompt" in email.recipients.$or) return { path: `${at}.recipients.$or.prompt`, message: LATER.prompt };
      for (const k of ["subject", "body"]) {
        if (isObj(email[k]) && "prompt" in email[k]) return { path: `${at}.${k}.prompt`, message: LATER.prompt };
      }
      if ("attachments" in email) return { path: `${at}.attachments`, message: LATER.attachments };
    }
  }
  return null;
}

/**
 * The first problem with records.workflows.<id>: its id, the engine's spec.json, the engine's semantic validator
 * (validateWorkflow), then what this phase refuses. { path, message } with path relative to records.workflows.<id>.
 */
export function workflowProblem(id, doc) {
  if (!WORKFLOW_ID.test(id) || id.length > WORKFLOW_ID_MAX) {
    return { path: "", message: `a workflow id is lowercase letters and digits, words joined by "-" or "_", starting with a letter, at most ${WORKFLOW_ID_MAX} characters (for example "two-person-review")` };
  }
  if (!isObj(doc)) return { path: "", message: 'must be an object: a workflow document with an "init" and a "diff" (docs/WORKFLOW_ENGINE.md)' };
  const check = structuralValidator();
  if (!check(doc)) {
    const e = check.errors[0];
    return { path: pathOf(e.instancePath), message: ajvMessage(e) };
  }
  const issues = validateWorkflow(doc);
  if (issues.length) return { path: issues[0].path === "$" ? "" : issues[0].path, message: issues[0].message };
  return laterPhaseProblem(doc);
}

/**
 * The first problem with a compiled area's binding to a workflow (records.areas.<area>.lifecycle.workflow, its
 * transitions' `step`, its `workflow_states`, its `workflow_due`), or null. Run after checkArea() (so the lifecycle's field is a pick_list
 * and its states are checked); `workflows` is the merged records.workflows, each already checked by workflowProblem().
 */
export function bindingProblem(area, workflows) {
  const bad = (path, message) => ({ path, message });
  const lc = area.lifecycle;
  if (!lc) return null;
  const field = area.fields[lc.field];
  const states = field.options.map((o) => o.value);
  const id = lc.workflow;
  const declared = Object.keys(workflows ?? {});
  let steps = [];
  if (id !== undefined) {
    if (!(id in (workflows ?? {}))) return bad("lifecycle.workflow", `${quote(id)} is not a workflow of this profile (${declared.length ? `records.workflows: ${list(declared)}` : "records.workflows declares none"})`);
    steps = workflows[id].init.steps.map((s) => s.id);
  }
  const noWorkflow = (path, what) => bad(path, `${what} names a step of the lifecycle's workflow, and this lifecycle has none; name it with lifecycle.workflow`);
  const stepProblem = (path, stepId, state) => {
    if (!steps.includes(stepId)) return bad(path.id, `${quote(stepId)} is not a step of the workflow ${quote(id)} (its steps: ${list(steps)})`);
    if (!STEP_STATES.includes(state)) return bad(path.state, `${quote(state)} is not a step state of the workflow engine (${list([...STEP_STATES])})`);
    return null;
  };
  for (const [i, t] of (lc.transitions ?? []).entries()) {
    if (t.step === undefined) continue;
    const at = `lifecycle.transitions[${i}].step`;
    if (id === undefined) return noWorkflow(at, "a transition's step");
    const p = stepProblem({ id: `${at}.id`, state: `${at}.state` }, t.step.id, t.step.state);
    if (p) return p;
  }
  if (lc.workflow_states !== undefined) {
    if (id === undefined) return noWorkflow("lifecycle.workflow_states", "workflow_states");
    for (const [state, byStep] of Object.entries(lc.workflow_states)) {
      const at = `lifecycle.workflow_states.${state}`;
      if (!states.includes(state)) {
        const canonical = field.legacy_values?.[state];
        if (canonical !== undefined) return bad(at, `${quote(state)} is a stored legacy spelling of ${quote(canonical)}; key workflow_states by the state itself, ${quote(canonical)}`);
        return bad(at, `${quote(state)} is not a state of ${lc.field} (${list(states)})`);
      }
      for (const [stepId, stepState] of Object.entries(byStep)) {
        const p = stepProblem({ id: `${at}.${stepId}`, state: `${at}.${stepId}` }, stepId, stepState);
        if (p) return p;
      }
    }
  }
  if (lc.workflow_due !== undefined) {
    if (id === undefined) return noWorkflow("lifecycle.workflow_due", "workflow_due");
    for (const [stepId, anchor] of Object.entries(lc.workflow_due)) {
      const at = `lifecycle.workflow_due.${stepId}`;
      if (!steps.includes(stepId)) return bad(at, `${quote(stepId)} is not a step of the workflow ${quote(id)} (its steps: ${list(steps)})`);
      const f = area.fields[anchor.field];
      const dates = Object.values(area.fields).filter((x) => x.type === "date" || x.type === "datetime").map((x) => x.key);
      if (!f) return bad(`${at}.field`, `${quote(anchor.field)} is not a field of this area${dates.length ? ` (its dates: ${list(dates)})` : " (it has no date field)"}`);
      if (f.type !== "date" && f.type !== "datetime") return bad(`${at}.field`, `${quote(anchor.field)} is a ${f.type} field; a due date is anchored to a date or datetime field${dates.length ? ` (${list(dates)})` : ""}`);
      if (anchor.days !== undefined && (!Number.isInteger(anchor.days) || Math.abs(anchor.days) > DUE_DAYS_MAX)) return bad(`${at}.days`, `must be a whole number of days between -${DUE_DAYS_MAX} and ${DUE_DAYS_MAX}`);
    }
  }
  return null;
}
