/**
 * A person (or a schedule) starts a program (mold_v0-303, flag nested_runs with agent_harness; src/program-spec.ts says
 * what a program is). Until now a program ran only as a child an agent session spawned; here a person starts one from
 * the Agents page ("Run a program", src/program-routes.ts) or a record page's start_program action
 * (src/record-page-routes.ts), and a pack's schedule starts one at its due times (src/schedules.ts start_program).
 *
 *   who may       a program's `spawned_by` says which agents may spawn it: [] is "people only", ["*"] every agent and
 *                 people too, a list of profiles those agents (a person starts it through one of them). An optional
 *                 `roles` on the program (account roles) narrows the people further; a person always needs the role to
 *                 start agent sessions ("launch"). An archived program starts nothing.
 *   how it runs   "session": a program with no machine that people may start runs as a session of its own: its agent
 *                 profile, its prompt filled with the inputs (checked against its inputs schema first), its result asked
 *                 for in its outputs' shape. "runner": any other a session of a profile that may spawn it runs, told to
 *                 spawn it with exactly these inputs, collect it and report; the program's own checks (inputs, outputs,
 *                 machine, acceptance) are the spawn's (src/nested-runs.ts). A machine program only people may start
 *                 ([]) runs in a session of its own agent profile that is permitted to spawn exactly that program
 *                 (NestedPolicy.permit_program, at the root only); no other session may spawn it.
 *   acting for    the person who starts it (their role, their budget range); a schedule's acts for the workspace's
 *                 account, as an account key does. The session is an ordinary one: its trace, its stop, its budget.
 */
import { PackError } from "./pack-api.js";
import { canAccount, isAccountRole } from "./account-roles.js";
import { declaredInputs, mayBeSpawnedBy, renderPrompt, typedOutputs, validateJson, type JsonSchema, type ProgramConfig } from "./program-spec.js";
import type { Actor, SessionDetail } from "./harness-sessions.js";
import type { Org } from "./auth.js";

/**
 * How a start runs: the program as the session itself, or a session of `profile` that spawns it. `permit`: that session
 * may spawn exactly this program whatever its spawned_by says (a program with steps that only people start).
 */
export type StartVia = { via: "session" | "runner"; profile: string; permit?: boolean };
export interface StartableProgram { id: string; name: string; description: string; icon: string; version: number; inputs: JsonSchema; via: StartVia["via"]; profile: string }

/** What a session's budget leaves a runner to read the child's result (src/nested-runs.ts keeps a margin as well). */
const RUNNER_MARGIN_USD = 0.5;

/** The account roles a program names (`roles`, optional), or null: every role that may start agent sessions. */
export function programRoles(config: ProgramConfig): string[] | null {
  const r: unknown = config.roles;
  return Array.isArray(r) && r.length && r.every(isAccountRole) ? (r as string[]) : null;
}

/** How `config` is started by a person (or a schedule), or why it cannot be (null: never by a person). */
export function personStart(config: ProgramConfig): StartVia | { refused: string } {
  const own = config.agent_profile ?? "default";
  const peopleMay = !config.spawned_by.length || config.spawned_by.includes("*");
  if (!config.machine && peopleMay) return { via: "session", profile: own };
  // A machine (or an agents-only program) needs a parent session whose profile may spawn it.
  const runner = [own, "default", ...config.spawned_by.filter((p) => p !== "*")].find((p) => mayBeSpawnedBy(config, p));
  if (runner) return { via: "runner", profile: runner };
  // A program with steps only people start: a session of its own profile runs it, permitted to spawn exactly it.
  if (config.machine && !config.spawned_by.length) return { via: "runner", profile: own, permit: true };
  return { refused: "No agent profile may spawn this program: list one in its spawned_by" };
}

/** Whether `actor` may start it at all: their role (launch, and the program's roles), the program active. */
export function actorProblem(actor: Actor, config: ProgramConfig): string | null {
  if (actor.kind === "staff" || actor.kind === "system") return "A program acts for the person who starts it: staff cannot start one for a workspace";
  if (actor.kind === "person") {
    if (!canAccount(actor.role, "launch")) return "Your role cannot start agent sessions. Ask an account owner to change it on the Team page.";
    const roles = programRoles(config);
    if (roles && !(actor.role && roles.includes(actor.role))) return "Your role cannot start this program.";
  }
  return null;
}

/** The active programs `actor` may start now, each with how it would run. */
export async function startablePrograms(actor: Actor): Promise<StartableProgram[]> {
  const P = await import("./programs.js");
  if (!P.programsOn()) return [];
  const all = await P.listPrograms();
  const out: StartableProgram[] = [];
  for (const s of all) {
    if (s.status !== "active") continue;
    const d = await P.readProgram(s.id);
    if (actorProblem(actor, d.config)) continue;
    const how = personStart(d.config);
    if ("refused" in how) continue;
    out.push({ id: d.id, name: d.name, description: d.description, icon: d.icon, version: d.version, inputs: d.config.inputs, via: how.via, profile: how.profile });
  }
  return out;
}

/** A record page's start_program inputs (`input`: a program input's name -> a field, $key or $title), from the record. */
export function inputsFromRecord(map: Record<string, string> | undefined, r: { key: string; title: string | null; data: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, from] of Object.entries(map ?? {})) {
    const v = from === "$key" ? r.key : from === "$title" ? r.title : r.data[from.startsWith("$field:") ? from.slice(7) : from];
    if (v !== undefined && v !== null && v !== "") out[name] = v;
  }
  return out;
}

/** The first message of a start: the program's prompt filled (a session) or the spawn it asks for (a runner). */
export function startMessage(p: { id: string; name: string; config: ProgramConfig }, how: StartVia, inputs: Record<string, unknown>): string {
  const given = Object.keys(inputs).length ? `\n\nInputs:\n${JSON.stringify(inputs)}` : "";
  if (how.via === "session") {
    const outputs = typedOutputs(p.config.outputs);
    return `${renderPrompt(p.config.prompt, inputs, declaredInputs(p.config.inputs))}${given}${outputs ? `\n\nWhen you are done, end your last message with your result as one JSON object matching this JSON Schema:\n${JSON.stringify(outputs).slice(0, 4000)}` : ""}`;
  }
  return `Run the program ${p.id} (${p.name}): call spawn with program "${p.id}" and exactly the inputs below, wait for it with collect, then report its result as it gave it. Do nothing else.${given || "\n\nInputs:\n{}"}`;
}

export interface StartProgramInput { inputs?: unknown; budget_usd?: unknown; title?: unknown }

/**
 * Start program `id` for `actor` in workspace `orgId`: refused in words when it is archived, not one people start, the
 * actor's role may not, or the inputs do not match. Returns the session that runs it (`opts.record` links it to a record).
 */
export async function startProgram(orgId: number, actor: Actor, id: string, input: StartProgramInput, org?: Org, opts: { record?: { area: string; key: string } } = {}): Promise<{ session: SessionDetail; program: { id: string; version: number; via: StartVia["via"] } }> {
  const P = await import("./programs.js");
  if (!P.programsOn()) throw new PackError("Programs are not on in this app", 404);
  const p = await P.readProgram(String(id));
  if (p.status !== "active") throw new PackError(`The program ${p.name} is archived`, 409);
  const who = actorProblem(actor, p.config);
  if (who) throw new PackError(who, 403);
  const how = personStart(p.config);
  if ("refused" in how) throw new PackError(how.refused, 409);
  const inputs = input.inputs ?? {};
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new PackError("inputs: an object", 400);
  const bad = validateJson(inputs, p.config.inputs);
  if (bad.length) throw new PackError(`inputs do not match this program: ${bad.slice(0, 5).join("; ")}`, 400);
  const H = await import("./harness-sessions.js");
  const range = await H.startBudgetMax(orgId, actor);
  const wanted = input.budget_usd !== undefined && input.budget_usd !== null && input.budget_usd !== "" ? Number(input.budget_usd)
    : p.config.budget_usd + (how.via === "runner" ? RUNNER_MARGIN_USD : 0);
  if (!Number.isFinite(wanted) || wanted < 0.1) throw new PackError("budget_usd: at least $0.10", 400);
  const budget = Math.min(wanted, range.max_usd);
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : p.name).slice(0, 80);
  const session = await H.startSession(orgId, actor, { message: startMessage(p, how, inputs as Record<string, unknown>), profile: how.profile, title, mode: "task", budget_usd: budget }, org,
    { ...(opts.record ? { record: opts.record } : {}), ...(how.permit ? { permitProgram: p.id } : {}) });
  return { session, program: { id: p.id, version: p.version, via: how.via } };
}
