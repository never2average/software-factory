/**
 * Nested runs (mold_v0-291, flag nested_runs with agent_harness; molds/mold_v0/docs/agent-harness.md "Nested runs and
 * Programs"): a running agent session spawns children, each a full session in its own sandbox, and collects their typed
 * results. The only writer of harness_children, harness_evaluations, harness_champions and harness_gateway_holds.
 *
 *   spawn      only from a live wake's own workspace token (src/harness-reach.ts): the caller is the token's session, never
 *              an input. Program or prompt; inputs checked against its schema and redacted; the budget carved atomically
 *              out of what the parent has left, under the parent's row lock, and off the parent's running wake too
 *   a child    a session of the root's person, in the root's workspace, under a policy that is the intersection of its
 *              program's and its parent's (src/nested-policy.ts): it never asks anyone for more, cannot be raised, and
 *              ends when it steps outside. Depth 2, 8 children per root, 4 at once by default; lower only by the app
 *   settling   what a child costs is added to its parent, what it did not use is returned, once. A machine's steps
 *              settle into the machine's own pool the same way
 *   durable    all of it is rows: the sweep (nestedTick) reconciles whatever a lost process left half done
 *   budgets    the gateway holds each request's worst cost from its run's budget (admitTreeRequest), so concurrent
 *              requests of a tree can never spend past its root's budget
 *   acceptance the guardian (src/program-acceptance.ts): only this module and the evaluator's measurements decide
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "./db.js";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { PROFILE } from "./profile.js";
import { featureOn } from "./features.js";
import { agentHarnessOn, currentPolicy, flavourOf, resolveHooks, workspaceToolName, workspaceToolOf, ACCEPTANCE_KIND, AGENT_PACK, type AgentPolicy, type NestedPolicy } from "./agent-harness-config.js";
import { NESTED_TOOLS } from "./agent-governance.js";
import * as H from "./harness-sessions.js";
import { canAccount, type AccountRole } from "./account-roles.js";
import { revokeToolTokens } from "./harness-reach.js";
import { ChildPolicyRefused, effectiveWeb, intersectChildPolicy, type ProgramSide } from "./nested-policy.js";
import { atPath, renderPrompt, typedOutputs, validateJson, type FailurePolicy, type JsonSchema, type Machine, type MachineState, type ProgramConfig } from "./program-spec.js";
import { machineBegin, machineStep, resolveSource, type MachineRun, type StepSpec } from "./program-machine.js";
import { decideAcceptance, offSurface, seedOf, type Decision, type MeasuredCase } from "./program-acceptance.js";
import { programForSpawn, programsForProfile, sha256 } from "./programs.js";
import { maskSecrets } from "./run-events.js";
import type { EvaluationResult, EvaluationStart } from "./program-evaluator.js";

const { tx, read, newId, num, money, committedUsd, rowOf, closed, endSession, systemMessage, runEvent, recomputeSpend, queueWake, wakeOf } = H;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export const nestedOn = () => featureOn("nested_runs") && agentHarnessOn();
const needOn = () => { if (!nestedOn()) throw new PackError("Nested runs are not on in this app", 404); };

/** The most a build may allow; its profile may only lower them. */
export const NESTED_CEILINGS = { depth: 2, children: 8, concurrent: 4 } as const;
export function nestedLimits() {
  const p = PROFILE.nested_runs ?? {};
  const lower = (v: number | undefined, ceil: number) => (typeof v === "number" && v >= 0 ? Math.min(Math.floor(v), ceil) : ceil);
  return { depth: lower(p.max_depth, NESTED_CEILINGS.depth), children: lower(p.max_children, NESTED_CEILINGS.children), concurrent: Math.max(1, lower(p.max_concurrent, NESTED_CEILINGS.concurrent)) };
}
export const MIN_CHILD_BUDGET = 0.1;
/** What a parent always keeps of its own: enough to read what its children return. */
export const PARENT_MARGIN_USD = 0.05;
const COLLECT_MAX_SECONDS = 25;
const MAX_NAME = 80;
const HOLD_SECONDS = 900;
/** A start not finished in this long was lost with its process: the tick takes it up again. */
const LOST_START_MS = 120_000;
/** The kinds that take a child session and a sandbox: what the tree's cap counts. A machine is bookkeeping; an acceptance step is the server's. */
const SANDBOX_KINDS = "('prompt', 'program', 'step')";
/** Another process started this child first: this one's work is undone. */
class LostStart extends Error {}

export type ChildStatus = "queued" | "running" | "done" | "error" | "cancelled";
export interface HandleRow {
  id: string; org_id: number; root_id: string; parent_id: string; session_id: string | null; step_of: string | null; state_id: string | null;
  kind: "prompt" | "program" | "machine" | "step" | "acceptance"; program_id: string | null; program_version: number | null; name: string; child_no: number;
  inputs: Record<string, unknown>; outputs_schema: JsonSchema | null; budget_usd: string | number; pool_used_usd: string | number; spent_usd: string | number;
  status: ChildStatus; queue_reason: string | null; answer: string | null; outputs: unknown; error: string | null; failure_policy: FailurePolicy; retries: number; retries_used: number;
  attention: boolean; machine: HandleMachine | null; candidate: CandidateRef | null; cancel_requested_at: Date | null; created_at: Date; settled_at: Date | null;
}
const H_COLS = "id, org_id, root_id, parent_id, session_id, step_of, state_id, kind, program_id, program_version, name, child_no, inputs, outputs_schema, budget_usd, pool_used_usd, spent_usd, status, queue_reason, answer, outputs, error, failure_policy, retries, retries_used, attention, machine, candidate, cancel_requested_at, created_at, settled_at";
/** A machine's column: its definition and state, frozen with the handle (machine), or a step's place in its machine (step). */
interface HandleMachine { spec?: Machine; run?: MachineRun; step?: { entry: number; index: number; bindings?: Record<string, unknown> }; pending?: PendingChild | null; acceptance?: { config: NonNullable<ProgramConfig["acceptance"]>; candidate_from: string; hypothesis?: string | null } }
export interface CandidateRef { key: string; sha256: string; bytes: number; paths: string[]; from_session: string }
/** A child's session as it will start: built once, when it is spawned (or when a step reaches its turn). */
interface PendingChild { policy: AgentPolicy; title: string; message: string; profile: { id: string; version: number } | null; schema?: JsonSchema | null }

export interface HandleView {
  handle: string; name: string; ref: string | null; kind: HandleRow["kind"]; program: string | null; program_version: number | null; state: string | null; status: ChildStatus; settled: boolean;
  answer: string | null; outputs: unknown; error: string | null; budget_usd: number; spent_usd: number; waiting: string | null; attention: boolean; session_id: string | null; started_at: string; settled_at: string | null;
}
const viewOf = (h: HandleRow, ref: string | null, status: ChildStatus = h.status, waiting: string | null = h.queue_reason): HandleView => ({
  handle: h.id, name: h.name, ref, kind: h.kind, program: h.program_id, program_version: h.program_version, state: h.state_id, status, settled: !!h.settled_at,
  answer: h.answer, outputs: h.outputs ?? null, error: h.error, budget_usd: num(h.budget_usd), spent_usd: num(h.spent_usd), waiting, attention: h.attention, session_id: h.session_id, started_at: iso(h.created_at)!, settled_at: iso(h.settled_at),
});

// ---------------------------------------------------------------- redaction

/** Every string in a JSON value with secrets masked: what passes between sessions passes through this. */
export function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (typeof v === "string") return maskSecrets(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
  return v;
}

// ---------------------------------------------------------------- a root's tools and its number

const REF_PREFIX = "AGI";
/** The next root number in this workspace (AGI-001): taken under a lock with the insert. */
export async function nextRootRef(q: Queryable, orgId: number): Promise<string> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harness-ref:${orgId}`]);
  const [r] = await q.query<{ n: number }>("/* tenant: within the caller's workspace */ SELECT coalesce(max(substring(ref from '-([0-9]+)$')::int), 0)::int AS n FROM harness_sessions WHERE org_id = $1 AND parent_id IS NULL AND ref IS NOT NULL", [orgId]);
  return `${REF_PREFIX}-${String((r?.n ?? 0) + 1).padStart(3, "0")}`;
}
const toolNames = (canSpawn: boolean, isChild: boolean) => [...(canSpawn ? ["spawn", "collect", "list_children", "cancel_child"] : []), ...(isChild ? ["submit_outputs"] : [])].filter((t) => (NESTED_TOOLS as readonly string[]).includes(t)).map(workspaceToolName);

/** What a new root session is given: its place in a tree, the tools to spawn and collect, and the programs it may spawn. */
export async function prepareRootPolicy(policy: AgentPolicy, id: string, profileId: string): Promise<void> {
  const limits = nestedLimits();
  policy.nested = { root_id: id, parent_id: null, depth: 0, can_spawn: limits.depth > 0, is_child: false };
  policy.tools.push(...toolNames(limits.depth > 0, false));
  if (limits.depth > 0 && policy.workspace) {
    const programs = await programsForProfile(profileId).catch(() => []);
    const lines = programs.slice(0, 12).map((p) => `- ${p.id}: ${p.name}${p.description ? `. ${p.description}` : ""} inputs: ${JSON.stringify(p.config.inputs).slice(0, 400)} outputs: ${JSON.stringify(p.config.outputs).slice(0, 400)}`);
    policy.workspace.context.text = `${policy.workspace.context.text}\n\n${spawnGuide(limits, lines)}`;
  }
}
function spawnGuide(limits: ReturnType<typeof nestedLimits>, programLines: string[]): string {
  return ["## Child sessions", `You can start child sessions of your own: spawn(program or prompt, inputs, name?, budget_usd?) starts one and returns a handle at once; collect(handles?, timeout?) reads their results; list_children and cancel_child manage them. A child runs in its own sandbox, acts as the same person, and its budget comes out of yours. At most ${limits.children} children in this session's tree and ${limits.concurrent} at once. Do your other work while they run; you can end your turn: you are woken when they have all finished.`,
    programLines.length ? `Programs you can spawn (by id, with typed inputs and outputs):\n${programLines.join("\n")}` : ""].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- building a child

interface CallCtx { orgId: number; sessionId: string; runId: string | null; role: string | null }
async function treeActor(parent: H.SessionRow, role: string | null): Promise<{ kind: "person" | "key"; user: string | null; name: string | null; role: string | null }> {
  if (!parent.started_by || parent.started_by === "account") return { kind: "key", user: null, name: parent.started_by_name, role: null };
  let r = role;
  if (!r) {
    const { memberRole } = await import("./auth.js");
    const [o] = await read((q) => q.query<{ clerk_org_id: string | null }>("SELECT clerk_org_id FROM organizations WHERE id = $1", [parent.org_id]));
    r = await memberRole(parent.started_by, o?.clerk_org_id ?? null);
    if (!r) throw new PackError("The person who started this session is no longer a member of the workspace", 403);
  }
  return { kind: "person", user: parent.started_by, name: parent.started_by_name, role: r };
}

async function programSide(parent: H.SessionRow, actor: Awaited<ReturnType<typeof treeActor>>, profileId: string | null, config: ProgramConfig | null): Promise<{ side: ProgramSide; profile: { id: string; version: number } | null }> {
  const p = parent.policy;
  // A child with no program of its own: its parent's policy, with nothing to intersect against but itself.
  if (!config && !profileId) {
    return { profile: parent.profile_id && parent.profile_version ? { id: parent.profile_id, version: parent.profile_version } : null,
      side: { flavour: p.flavour, model: p.model, provider: p.provider, hooks: resolveHooks(flavourOf(p.flavour)!), web: effectiveWeb(p), tools_rule: p.governance?.tools ?? null, retention_days: p.governance?.retention_days ?? null,
        credentials: p.credentials ?? [], vault_keys: p.vault_keys ?? [], inference_key: p.inference_key ?? null, free_tools: p.tools.filter((t) => !!workspaceToolOf(t)), uploads: p.uploads ?? [], files: p.files ?? [], recipes: p.recipes ?? [] } };
  }
  const { profileForStart } = await import("./agent-profiles.js");
  const { row, eff } = await profileForStart(profileId, actor as never);
  const flavour = flavourOf(eff.harness) ?? flavourOf(p.flavour)!;
  const expanded = eff.recipes.length ? await (await import("./recipes.js")).expandRecipes(eff.uploads, eff.recipes) : { uploads: eff.uploads, recipes: [] };
  const base = currentPolicy("task");
  const g = eff.governance;
  const web = g ? effectiveWeb({ web: base.web, governance: g }) : effectiveWeb(base);
  const owner = actor.kind === "person" && actor.role === "owner";
  return { profile: { id: row.id, version: row.version },
    side: { flavour: flavour.id, model: eff.model, provider: eff.provider, hooks: resolveHooks(flavour, {}), web, tools_rule: g?.tools ?? null, retention_days: g?.retention_days ?? null,
      credentials: owner ? eff.keys.flatMap((k) => (k.kind === "workspace" ? [k.name] : [])) : [],
      vault_keys: eff.keys.flatMap((k) => (k.kind === "platform" ? [{ provider: k.provider, label: k.label, env: k.env }] : [])),
      inference_key: eff.key, free_tools: (p.tools ?? []).filter((t) => { const w = workspaceToolOf(t); return !!w && (!g?.tools || g.tools.allowed.includes(w)); }),
      uploads: expanded.uploads.map((u) => ({ ...u })), files: [], recipes: expanded.recipes,
      ...(config?.limits?.max_turns ? { max_turns: config.limits.max_turns } : {}), ...(config?.limits?.wake_max_minutes ? { wake_max_seconds: config.limits.wake_max_minutes * 60 } : {}) } };
}

function childNote(name: string, schema: JsonSchema | null): string {
  return [`## This is a child run ("${name}")`,
    "A parent session started you for one piece of work; work it through and finish. You act as the same person, in the same workspace, and your budget comes out of the parent's: it is fixed, and nobody can raise it. You cannot ask anyone for more access: if your policy does not allow something, say so and finish.",
    schema ? `When you are done, call submit_outputs with your answer and outputs matching this JSON Schema (it is checked; if it is refused, fix what it says and call it again):\n${JSON.stringify(schema).slice(0, 4000)}` : "When you are done, say your result in your last message: that is what the parent receives."].join("\n");
}

async function buildChild(parent: H.SessionRow, handleId: string, a: { name: string; prompt: string; inputs: unknown; profile: string | null; config: ProgramConfig | null; schema: JsonSchema | null; depth: number; role: string | null; candidate?: boolean }): Promise<PendingChild> {
  const actor = await treeActor(parent, a.role);
  const { side, profile } = await programSide(parent, actor, a.profile, a.config);
  const base = currentPolicy("task");
  let policy: AgentPolicy;
  try { policy = intersectChildPolicy(parent.policy, side, base); }
  catch (e) { if (e instanceof ChildPolicyRefused) throw new PackError(`This child cannot start: ${e.message}`, 403); throw e; }
  const limits = nestedLimits();
  const canSpawn = a.depth < limits.depth;
  const nested: NestedPolicy = { root_id: parent.root_id ?? parent.id, parent_id: parent.id, depth: a.depth, can_spawn: canSpawn, is_child: true, handle: handleId, ...(a.candidate ? { candidate: true } : {}) };
  policy.nested = nested;
  policy.tools = [...new Set([...policy.tools, ...toolNames(canSpawn, true)])];
  if (profile) policy.profile = { id: profile.id, name: parent.policy.profile?.name ?? profile.id, version: profile.version };
  if (policy.workspace) policy.workspace = { ...policy.workspace, context: { ...policy.workspace.context, text: `${policy.workspace.context.text}\n\n${childNote(a.name, a.schema)}` } };
  const body = `${a.prompt}${a.inputs && typeof a.inputs === "object" && Object.keys(a.inputs as object).length ? `\n\nInputs:\n${JSON.stringify(a.inputs)}` : ""}`;
  if (body.length > H.MAX_MESSAGE_CHARS) throw new PackError(`inputs: too long for a child's first message (at most ${H.MAX_MESSAGE_CHARS} characters in all)`, 413);
  return { policy, title: a.name, message: body, profile };
}

// ---------------------------------------------------------------- the wake's calls (MCP tools)

function assertLive(p: H.SessionRow, runId: string | null) {
  if (!runId || p.current_run_id !== runId || p.state !== "live" || p.stop_requested_at || p.pause_requested_at || p.archived_at) throw new PackError("Only a running wake of this session may do that", 403);
}

/** What `parent` may still give a child, with the lock held: its spend re-read from its meter, and its live model holds taken out. */
async function spendable(q: Queryable, p: H.SessionRow): Promise<number> {
  const spent = await recomputeSpend(q, p.id, p.org_id);
  const [h] = p.current_run_id ? await q.query<{ held: string }>("/* tenant: the parent's own wake, by run id */ SELECT coalesce(sum(usd), 0) AS held FROM harness_gateway_holds WHERE run_id = $1 AND expires_at > now()", [p.current_run_id]) : [{ held: "0" }];
  return money(num(p.budget_usd) - spent - num(p.reserve_usd) - num(p.carved_usd) - num(p.children_spent_usd) - num(h?.held));
}

export interface SpawnInput { program?: unknown; prompt?: unknown; inputs?: unknown; name?: unknown; budget_usd?: unknown }

/** Start a child (or a program's machine). Returns its handle at once; a child waiting for a place says so. */
export async function spawnChild(ctx: CallCtx, input: SpawnInput): Promise<HandleView> {
  needOn();
  const limits = nestedLimits();
  const before = await read((q) => rowOf(q, ctx.orgId, ctx.sessionId));
  assertLive(before, ctx.runId);
  // The person's role now (the token's call re-read it): someone moved below launching spawns no more. An account key has no role.
  if (before.started_by && before.started_by !== "account" && !(ctx.role && canAccount(ctx.role as AccountRole, "launch"))) throw new PackError("The role of the person this session acts for no longer lets it start runs", 403);
  const depth = before.depth + 1;
  if (depth > limits.depth) throw new PackError(`This session is ${before.depth} levels deep: a tree goes at most ${limits.depth} levels`, 403);
  const hasProgram = typeof input.program === "string" && input.program.trim() !== "";
  const hasPrompt = typeof input.prompt === "string" && input.prompt.trim() !== "";
  if (hasProgram === hasPrompt) throw new PackError("Say either program (an id) or prompt (what the child should do)", 400);
  const prog = hasProgram ? await programForSpawn(String(input.program).trim(), before.profile_id) : null;
  const config = prog?.config ?? null;
  const inputs = redactDeep(input.inputs ?? {}) as Record<string, unknown>;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new PackError("inputs: an object", 400);
  if (config) {
    const bad = validateJson(inputs, config.inputs);
    if (bad.length) throw new PackError(`inputs do not match this program: ${bad.slice(0, 5).join("; ")}`, 400);
  }
  const name = maskSecrets(String(input.name ?? prog?.name ?? String(input.prompt ?? "").replace(/\s+/g, " ").slice(0, 60))).trim().slice(0, MAX_NAME) || "Child run";
  const ask = input.budget_usd === undefined || input.budget_usd === null ? (config?.budget_usd ?? Math.max(MIN_CHILD_BUDGET, 1)) : Number(input.budget_usd);
  if (!Number.isFinite(ask) || ask < MIN_CHILD_BUDGET) throw new PackError(`budget_usd: at least $${MIN_CHILD_BUDGET.toFixed(2)}`, 400);
  if (config?.limits?.max_budget_usd && ask > config.limits.max_budget_usd) throw new PackError(`budget_usd: this program takes at most $${config.limits.max_budget_usd.toFixed(2)}`, 400);
  const handleId = newId("hch");
  const prompt = config ? renderPrompt(config.prompt, inputs) : maskSecrets(String(input.prompt)).trim();
  const isMachine = !!config?.machine;
  const pending = isMachine ? null : await buildChild(before, handleId, { name, prompt, inputs, profile: config?.agent_profile ?? (config ? before.profile_id : null), config, schema: typedOutputs(config?.outputs), depth, role: ctx.role });
  let cancels: string[] = [];
  const created = await tx(async (q) => {
    const p = await rowOf(q, ctx.orgId, ctx.sessionId, true);
    assertLive(p, ctx.runId);
    const root = p.root_id ?? p.id;
    // One count for the whole tree, whichever session starts the next: children, grandchildren and machines' steps alike.
    await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harness-tree:${root}`]);
    const [{ n }] = await q.query<{ n: number }>(`/* tenant: the tree's own handles */ SELECT count(*)::int AS n FROM harness_children WHERE org_id = $1 AND root_id = $2 AND kind IN ${SANDBOX_KINDS}`, [p.org_id, root]);
    if (n >= limits.children) throw new PackError(`This session's tree has started its ${limits.children} children: no more can start`, 429);
    const left = await spendable(q, p);
    const canGive = left - PARENT_MARGIN_USD;
    if (ask > canGive + 1e-9) throw new PackError(`Not enough budget left: this session can still give a child $${Math.max(0, canGive).toFixed(2)} (it keeps $${PARENT_MARGIN_USD.toFixed(2)} to read the results), and this one asks for $${ask.toFixed(2)}`, 402);
    const amount = money(ask);
    const no = await nextChildNo(q, p);
    await q.query(`INSERT INTO harness_children (id, org_id, root_id, parent_id, kind, program_id, program_version, name, child_no, inputs, outputs_schema, budget_usd, failure_policy, retries, status, machine, queue_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'queued', $15, $16)`,
      [handleId, p.org_id, root, p.id, isMachine ? "machine" : prog ? "program" : "prompt", prog?.id ?? null, prog?.version ?? null, name, no, JSON.stringify(inputs), typedOutputs(config?.outputs) ? JSON.stringify(config!.outputs) : null, amount,
        config?.failure_policy ?? "continue", config?.retries ?? 1, JSON.stringify(isMachine ? { spec: config!.machine, pending: null } : { pending }), "waiting for a place"]);
    await q.query("UPDATE harness_sessions SET carved_usd = carved_usd + $3, last_activity_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2", [p.id, p.org_id, amount]);
    if (p.current_run_id) await q.query("UPDATE runs SET budget_usd = GREATEST(budget_usd - $3, 0.000001) WHERE id = $1 AND org_id = $2 AND status IN ('queued', 'running')", [p.current_run_id, p.org_id, amount]);
    await runEvent(q, p.current_run_id, p.org_id, "child_spawned", { handle: handleId, name, program: prog?.id ?? null, version: prog?.version ?? null, budget_usd: amount, depth });
    if (isMachine) {
      const started = machineBegin(config!.machine!, inputs, config!.failure_policy);
      await q.query("UPDATE harness_children SET status = 'running', queue_reason = NULL, machine = $2 WHERE id = $1 AND org_id = $3", [handleId, JSON.stringify({ spec: config!.machine, run: started.run, acceptance: config!.acceptance ? { config: config!.acceptance, candidate_from: "", hypothesis: null } : undefined }), p.org_id]);
      if (started.run.status === "error") await settleHandle(q, p.org_id, handleId, { status: "error", error: started.run.error ?? "the machine could not start" });
      else cancels = await createSteps(q, await lockHandle(q, p.org_id, handleId), config!.machine!, config!, inputs, started.start);
    }
    return { id: handleId, parent: p.id, root };
  });
  for (const id of cancels) await cancelHandle(ctx.orgId, id, "its machine could not go on").catch(() => {});
  await pump(ctx.orgId, created.root).catch((e) => console.error(`nested runs: pump: ${(e as Error).message}`));
  return readHandle(ctx.orgId, handleId);
}

async function nextChildNo(q: Queryable, p: { id: string; org_id: number }): Promise<number> {
  const [{ n }] = await q.query<{ n: number }>("/* tenant: within the parent's workspace */ SELECT coalesce(max(child_no), 0)::int AS n FROM harness_children WHERE org_id = $1 AND parent_id = $2", [p.org_id, p.id]);
  return n + 1;
}

async function lockHandle(q: Queryable, orgId: number, id: string): Promise<HandleRow> {
  const [h] = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, id]);
  if (!h) throw new PackError("no such child", 404);
  return h;
}
async function readHandle(orgId: number, id: string): Promise<HandleView> {
  return read(async (q) => {
    const [h] = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [orgId, id]);
    if (!h) throw new PackError("no such child", 404);
    return (await views(q, [h]))[0]!;
  });
}
/** Handles as read: a running child whose wake still waits in the queue says it is queued, in plain words. */
async function views(q: Queryable, rows: HandleRow[]): Promise<HandleView[]> {
  const sids = rows.flatMap((r) => (r.session_id ? [r.session_id] : []));
  const sess = sids.length ? await q.query<{ id: string; ref: string | null; run_status: string | null }>(
    "/* tenant: the sessions of these handles, within their own workspace */ SELECT s.id, s.ref, r.status AS run_status FROM harness_sessions s LEFT JOIN runs r ON r.id = s.current_run_id AND r.org_id = s.org_id WHERE s.id = ANY ($1::text[]) AND s.org_id = $2", [sids, rows[0]!.org_id]) : [];
  const byId = new Map(sess.map((s) => [s.id, s]));
  return rows.map((h) => {
    const s = h.session_id ? byId.get(h.session_id) : undefined;
    const queued = h.status === "running" && s?.run_status === "queued";
    return viewOf(h, s?.ref ?? null, queued ? "queued" : h.status, queued ? "waiting for a sandbox" : h.queue_reason);
  });
}

/** Handles of the caller's own children (by default every one), optionally waiting up to `timeout` seconds for all to settle. */
export async function collect(ctx: CallCtx, input: { handles?: unknown; timeout?: unknown }): Promise<{ children: HandleView[]; settled: boolean }> {
  needOn();
  const ids = Array.isArray(input.handles) ? (input.handles as unknown[]).map(String).slice(0, 200) : null;
  const waitSeconds = Math.min(Math.max(Number(input.timeout ?? 0) || 0, 0), COLLECT_MAX_SECONDS);
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const out = await read(async (q) => {
      const rows = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND parent_id = $2 AND step_of IS NULL ${ids ? "AND id = ANY ($3::text[])" : ""} ORDER BY child_no`, ids ? [ctx.orgId, ctx.sessionId, ids] : [ctx.orgId, ctx.sessionId]);
      return { rows, list: rows.length ? await views(q, rows) : [] };
    });
    const settled = out.list.every((c) => c.settled);
    if (settled || Date.now() >= deadline) return { children: out.list, settled };
    await new Promise((r) => setTimeout(r, 1000));
  }
}
export const listChildren = (ctx: CallCtx) => collect(ctx, {}).then((r) => r.children);

/** The caller cancels one of its own children (a program's machine and its steps with it). */
export async function cancelChild(ctx: CallCtx, handle: unknown, why = "cancelled by its parent"): Promise<HandleView> {
  needOn();
  const id = String(handle ?? "");
  const owned = await read((q) => q.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND id = $2 AND parent_id = $3", [ctx.orgId, id, ctx.sessionId]));
  if (!owned.length) throw new PackError("no such child of this session", 404);
  await cancelHandle(ctx.orgId, id, why);
  return readHandle(ctx.orgId, id);
}

/** A child hands in its answer and typed outputs: checked against its frozen schema now, and redacted. */
export async function submitOutputs(ctx: CallCtx, input: { answer?: unknown; outputs?: unknown }): Promise<{ ok: boolean; errors: string[]; retries_left: number }> {
  needOn();
  const answer = typeof input.answer === "string" ? maskSecrets(input.answer).slice(0, H.MAX_MESSAGE_CHARS) : null;
  const outputs = input.outputs === undefined ? null : redactDeep(input.outputs);
  return tx(async (q) => {
    const s = await rowOf(q, ctx.orgId, ctx.sessionId, true);
    assertLive(s, ctx.runId);
    const [h] = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND session_id = $2 AND settled_at IS NULL FOR UPDATE`, [s.org_id, s.id]);
    if (!h) throw new PackError("This session is not a child waiting for outputs", 409);
    const errors = h.outputs_schema ? validateJson(outputs ?? {}, h.outputs_schema) : [];
    if (errors.length) {
      await q.query("UPDATE harness_children SET retries_used = retries_used + 1, updated_at = now() WHERE org_id = $1 AND id = $2", [s.org_id, h.id]);
      await runEvent(q, s.current_run_id, s.org_id, "child_outputs_refused", { handle: h.id, problems: errors.slice(0, 5) });
      return { ok: false, errors, retries_left: Math.max(0, h.retries - h.retries_used - 1) };
    }
    await q.query("UPDATE harness_children SET outputs = $3, answer = coalesce($4, answer), error = NULL, updated_at = now() WHERE org_id = $1 AND id = $2", [s.org_id, h.id, JSON.stringify(outputs ?? {}), answer]);
    await runEvent(q, s.current_run_id, s.org_id, "child_outputs", { handle: h.id });
    return { ok: true, errors: [], retries_left: h.retries - h.retries_used };
  });
}

/** The candidate a machine's state produced (a bundle), sealed with the workspace's key. Its session's wake's lease. */
export async function wakeCandidate(runId: string, lease: string, bundle: Buffer): Promise<{ sha256: string; paths: number }> {
  needOn();
  const w = await read((q) => wakeOf(q, runId, lease));
  if (!w.session.policy.nested?.candidate) throw new PackError("This session was not asked for a candidate", 403);
  const { readBundle } = await import("./workspace-bundle.js");
  const paths = readBundle(bundle).files.map((f: { path: string }) => f.path).sort();
  const sha = (await import("node:crypto")).createHash("sha256").update(bundle).digest("hex");
  const key = `workspaces/org-${w.org_id}/.agent/${w.session.id}/candidate.wse`;
  const { objectStore } = await import("./storage.js");
  const { sealBytes } = await import("./orgcrypto.js");
  await (await objectStore()).put(key, await sealBytes(w.org_id, bundle, candidateAad(key)), "application/octet-stream");
  await tx(async (q) => {
    const ref: CandidateRef = { key, sha256: sha, bytes: bundle.length, paths, from_session: w.session.id };
    await q.query("UPDATE harness_children SET candidate = $3, updated_at = now() WHERE org_id = $1 AND session_id = $2", [w.org_id, w.session.id, JSON.stringify(ref)]);
    await runEvent(q, runId, w.org_id, "candidate_recorded", { sha256: sha, paths: paths.length });
  });
  return { sha256: sha, paths: paths.length };
}
const candidateAad = (key: string) => `harness-candidate:${key}`;
async function candidateBytes(orgId: number, ref: CandidateRef): Promise<Buffer | null> {
  const { objectStore } = await import("./storage.js");
  const { openBytes } = await import("./orgcrypto.js");
  const sealed = await (await objectStore()).get(ref.key);
  if (!sealed) return null;
  const body = await openBytes(orgId, sealed, candidateAad(ref.key));
  return (await import("node:crypto")).createHash("sha256").update(body).digest("hex") === ref.sha256 ? body : null;
}

// ---------------------------------------------------------------- starting what is queued (durable, idempotent)

const SYSTEM: H.Actor = { kind: "system", user: null, name: "the platform", role: null };

/** Start as many of a tree's queued children as its place allows. Safe to call any number of times: it is what the tick calls. */
export async function pump(orgId: number, rootId: string): Promise<void> {
  const limits = nestedLimits();
  const taken = await tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harness-pump:${rootId}`]);
    const [{ n }] = await q.query<{ n: number }>("/* tenant: the tree's own handles */ SELECT count(*)::int AS n FROM harness_children WHERE org_id = $1 AND root_id = $2 AND status = 'running' AND kind <> 'machine'", [orgId, rootId]);
    const room = limits.concurrent - n;
    if (room <= 0) {
      await q.query("/* tenant: the tree's own handles */ UPDATE harness_children SET queue_reason = $3 WHERE org_id = $1 AND root_id = $2 AND status = 'queued' AND queue_reason IS DISTINCT FROM $3", [orgId, rootId, `waiting: ${limits.concurrent} children are already running`]);
      return [] as HandleRow[];
    }
    const rows = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND root_id = $2 AND status = 'queued' AND kind <> 'machine' AND cancel_requested_at IS NULL ORDER BY created_at, child_no LIMIT $3 FOR UPDATE SKIP LOCKED`, [orgId, rootId, room]);
    for (const h of rows) await q.query("UPDATE harness_children SET status = 'running', queue_reason = NULL, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, h.id]);
    return rows;
  });
  for (const h of taken) await startHandle(orgId, h).catch(async (e: Error) => {
    if (e instanceof LostStart) return;
    if (e instanceof PackError && e.status === 429) {
      await tx((q) => q.query("UPDATE harness_children SET status = 'queued', queue_reason = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND settled_at IS NULL", [orgId, h.id, e.message.slice(0, 200)]));
      return;
    }
    await tx((q) => settleHandle(q, orgId, h.id, { status: "error", error: e.message.slice(0, 1000) }));
    await afterSettleOf(orgId, h.id);
  });
}

async function startHandle(orgId: number, h: HandleRow): Promise<void> {
  if (h.kind === "acceptance") { await startAcceptance(orgId, h); return; }
  const parent = await read((q) => rowOf(q, orgId, h.parent_id));
  if (closed(parent)) { await tx((q) => settleHandle(q, orgId, h.id, { status: "cancelled", error: "its parent session ended" })); await afterSettleOf(orgId, h.id); return; }
  let sessionId = h.session_id;
  if (!sessionId) {
    const stored = h.machine?.pending ?? null;
    const pending: PendingChild = stored ?? await buildStepPending(parent, h);
    const parentRef = parent.ref ?? parent.id;
    const id = newId("hss");
    const ref = `${parentRef}.${h.child_no}`;
    await tx(async (q) => {
      // Whoever holds this row starts the child. Another start that got here first, or a cancel, ends this one before it writes.
      const [cur] = await q.query<{ session_id: string | null; settled_at: Date | null; cancel_requested_at: Date | null }>("SELECT session_id, settled_at, cancel_requested_at FROM harness_children WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, h.id]);
      if (!cur || cur.session_id || cur.settled_at || cur.cancel_requested_at) throw new LostStart();
      await q.query(`INSERT INTO harness_sessions (id, org_id, title, started_by, started_by_name, state, flavour, model, provider, policy, budget_usd, profile_id, profile_version, parent_id, root_id, depth, ref, program_id, program_version)
         VALUES ($1, $2, $3, $4, $5, 'starting', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [id, orgId, pending.title, parent.started_by, parent.started_by_name, pending.policy.flavour, pending.policy.model, pending.policy.provider, JSON.stringify({ ...pending.policy, nested: { ...pending.policy.nested!, handle: h.id } }), num(h.budget_usd),
          pending.profile?.id ?? null, pending.profile?.version ?? null, parent.id, h.root_id, parent.depth + 1, ref, h.program_id, h.program_version]);
      await q.query("INSERT INTO harness_session_messages (session_id, org_id, role, body, status, by_user, by_name) VALUES ($1, $2, 'person', $3, 'pending', $4, $5)", [id, orgId, pending.message, parent.started_by, parent.started_by_name]);
      // A step's outputs are checked against its state's (or its program's) schema, frozen when it starts.
      const won = await q.query("UPDATE harness_children SET session_id = $3, outputs_schema = coalesce(outputs_schema, $4), machine = coalesce(machine, '{}'::jsonb) - 'pending', updated_at = now() WHERE org_id = $1 AND id = $2 AND session_id IS NULL AND settled_at IS NULL AND cancel_requested_at IS NULL RETURNING id", [orgId, h.id, id, pending.schema ? JSON.stringify(pending.schema) : null]);
      if (!won.length) throw new LostStart();
    });
    sessionId = id;
  }
  await queueWake(orgId, sessionId, "start", SYSTEM);
}

/** Tests only: one start of a child, as two racing processes would each make it. */
export const startHandleForTest = (orgId: number, h: HandleRow) => startHandle(orgId, h).catch((e: Error) => { if (!(e instanceof LostStart)) throw e; });

async function buildStepPending(parent: H.SessionRow, h: HandleRow): Promise<PendingChild> {
  const m = h.step_of ? await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [h.org_id, h.step_of]))[0]) : null;
  const spec = m?.machine?.spec;
  const state = spec?.states.find((s) => s.id === h.state_id);
  if (!state || !m) throw new PackError("this step's machine could not be read", 500);
  const step = h.machine?.step;
  const inputs = (step?.bindings ?? h.inputs ?? {}) as Record<string, unknown>;
  const stepProgram = state.program ? await programForSpawn(state.program, parent.profile_id) : null;
  const config = stepProgram?.config ?? null;
  const template = config?.prompt ?? state.prompt ?? "";
  const prompt = renderPrompt(template, { ...(m.inputs ?? {}), ...inputs }); // a machine's own inputs are every state's placeholders
  const schema = typedOutputs(state.outputs ?? config?.outputs);
  const acceptance = m.machine?.acceptance;
  const candidate = acceptance ? spec!.states.some((s) => s.kind === "acceptance" && s.candidate_from === state.id) : false;
  const built = await buildChild(parent, h.id, { name: `${m.name}: ${state.id}`.slice(0, MAX_NAME), prompt, inputs, profile: config?.agent_profile ?? parent.profile_id, config, schema, depth: parent.depth + 1, role: null, candidate });
  return { ...built, schema };
}

/**
 * A machine's next steps: their handles, each carved from the machine's own pool, the states' items sharing it evenly. Inside
 * the transaction that moved the machine. Answers the steps to cancel, once it has committed, if the machine could not go on.
 */
async function createSteps(q: Queryable, m: HandleRow, spec: Machine, config: ProgramConfig, inputs: unknown, starts: StepSpec[]): Promise<string[]> {
  const limits = nestedLimits();
  const limit = spec.max_children ?? spec.max_transitions + 1;
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harness-tree:${m.root_id}`]);
  let [{ used }] = await q.query<{ used: number }>("/* tenant: the machine's own steps */ SELECT count(*)::int AS used FROM harness_children WHERE org_id = $1 AND step_of = $2", [m.org_id, m.id]);
  let [{ tree }] = await q.query<{ tree: number }>(`/* tenant: the tree's own handles */ SELECT count(*)::int AS tree FROM harness_children WHERE org_id = $1 AND root_id = $2 AND kind IN ${SANDBOX_KINDS}`, [m.org_id, m.root_id]);
  let free = num(m.budget_usd) - num(m.pool_used_usd) - num(m.spent_usd);
  const agentStates = Math.max(1, spec.states.filter((s) => s.kind !== "acceptance").length);
  let waiting = starts.filter((st) => spec.states.find((s) => s.id === st.state)!.kind !== "acceptance").length;
  for (const st of starts) {
    if (used >= limit) return failMachine(q, m, `it would start more than its ${limit} steps`);
    const state = spec.states.find((s) => s.id === st.state)!;
    const acceptance = state.kind === "acceptance";
    if (!acceptance && tree >= limits.children) return failMachine(q, m, `its tree has started its ${limits.children} children`);
    const items = Math.max(1, starts.filter((x) => x.state === st.state).length);
    // A state's own figure is per step; with none, this state's share of what is left, split over its items. Never more than
    // an even share of what the steps still to start can have, so the last item gets as much as the first.
    const wanted = state.budget_usd ?? Math.max(MIN_CHILD_BUDGET, (num(m.budget_usd) - num(m.spent_usd)) / agentStates) / items;
    const each = acceptance ? 0 : money(Math.min(wanted, free / Math.max(1, waiting)));
    if (!acceptance && each < MIN_CHILD_BUDGET) return failMachine(q, m, `it has only $${free.toFixed(2)} left for ${waiting} step${waiting === 1 ? "" : "s"}`);
    const id = newId("hch");
    const schema = typedOutputs(state.outputs); // a program step's own schema is frozen when it starts (startHandle)
    const name = `${m.name}: ${st.state}${starts.filter((x) => x.state === st.state).length > 1 ? ` ${st.index + 1}` : ""}`.slice(0, MAX_NAME);
    await q.query(`INSERT INTO harness_children (id, org_id, root_id, parent_id, step_of, state_id, kind, program_id, program_version, name, child_no, inputs, outputs_schema, budget_usd, failure_policy, retries, status, machine, queue_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'queued', $17, 'waiting for a place')`,
      [id, m.org_id, m.root_id, m.parent_id, m.id, st.state, acceptance ? "acceptance" : "step", m.program_id, m.program_version, name, await nextChildNo(q, { id: m.parent_id, org_id: m.org_id }),
        JSON.stringify(st.bindings ?? {}), schema ? JSON.stringify(schema) : null, each, config.failure_policy, state.retries ?? config.retries, JSON.stringify({ step: { entry: st.entry, index: st.index, bindings: st.bindings }, ...(acceptance ? { acceptance: { config: config.acceptance!, candidate_from: state.candidate_from!, hypothesis: state.hypothesis ? String(resolveSource(state.hypothesis, { inputs, outputs: (m.machine?.run ?? { outputs: {} }).outputs }) ?? "") : null } } : {}) })]);
    await q.query("UPDATE harness_children SET pool_used_usd = pool_used_usd + $3, updated_at = now() WHERE org_id = $1 AND id = $2", [m.org_id, m.id, each]);
    free -= each; used++;
    if (!acceptance) { waiting--; tree++; }
  }
  return [];
}
/**
 * A machine that cannot go on. It settles only once none of its steps can spend: its budget is carved, and what was given back
 * could otherwise be spent twice. With a step open it is marked failed, its steps told to stop, and the last one's settling
 * closes it (advanceMachine).
 */
async function failMachine(q: Queryable, m: HandleRow, why: string): Promise<string[]> {
  const error = `The program could not continue: ${why}`;
  const fresh = await lockHandle(q, m.org_id, m.id);
  const machine = fresh.machine?.run ? { ...fresh.machine, run: { ...fresh.machine.run, status: "error" as const, error } } : fresh.machine;
  await q.query("UPDATE harness_children SET machine = $3, updated_at = now() WHERE org_id = $1 AND id = $2", [m.org_id, m.id, JSON.stringify(machine)]);
  const open = await q.query<{ id: string }>("/* tenant: within its workspace */ SELECT id FROM harness_children WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL", [m.org_id, m.id]);
  if (!open.length) { await settleHandle(q, m.org_id, m.id, { status: "error", error }); return []; }
  await q.query("/* tenant: within its workspace */ UPDATE harness_children SET cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now() WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL", [m.org_id, m.id]);
  return open.map((o) => o.id);
}

// ---------------------------------------------------------------- settling

/**
 * A handle settles, once: its cost is charged to whoever carved it and what it did not use is returned. Inside the
 * transaction that decided it. Caller holds the handle's parent's lock first where it can (rowOf with lock).
 */
export async function settleHandle(q: Queryable, orgId: number, handleId: string, r: { status: "done" | "error" | "cancelled"; answer?: string | null; outputs?: unknown; error?: string | null }): Promise<boolean> {
  const parent = await q.query<{ id: string }>("/* tenant: the handle's own parent, within its workspace */ SELECT p.id FROM harness_sessions p JOIN harness_children h ON h.parent_id = p.id AND h.org_id = p.org_id WHERE h.org_id = $1 AND h.id = $2 FOR UPDATE OF p", [orgId, handleId]);
  if (!parent.length) return false;
  const h = await lockHandle(q, orgId, handleId);
  if (h.settled_at) return false;
  // What it cost: a child's own wakes and what its own children cost; a machine's, what its steps cost.
  let cost = num(h.spent_usd);
  if (h.session_id) {
    const s = await rowOf(q, orgId, h.session_id, true);
    cost = (await recomputeSpend(q, s.id, orgId)) + num(s.children_spent_usd);
  }
  const budget = num(h.budget_usd);
  const refund = money(Math.max(0, budget - cost));
  await q.query(`UPDATE harness_children SET status = $3, answer = coalesce($4, answer), outputs = coalesce($5, outputs), error = $6, spent_usd = $7, settled_at = now(), queue_reason = NULL, updated_at = now() WHERE org_id = $1 AND id = $2`,
    [orgId, h.id, r.status, r.answer ?? null, r.outputs === undefined ? null : JSON.stringify(redactDeep(r.outputs)), r.error ? maskSecrets(r.error).slice(0, 2000) : null, money(cost)]);
  if (h.step_of) {
    await q.query("UPDATE harness_children SET pool_used_usd = GREATEST(pool_used_usd - $3, 0), spent_usd = spent_usd + $4, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, h.step_of, budget, money(cost)]);
  } else {
    const [p] = await q.query<{ current_run_id: string | null }>("UPDATE harness_sessions SET carved_usd = GREATEST(carved_usd - $3, 0), children_spent_usd = children_spent_usd + $4, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING current_run_id", [h.parent_id, orgId, budget, money(cost)]);
    if (refund > 0 && p?.current_run_id) await q.query("UPDATE runs SET budget_usd = budget_usd + $3 WHERE id = $1 AND org_id = $2 AND status IN ('queued', 'running')", [p.current_run_id, orgId, refund]);
  }
  const [{ current_run_id: parentRun }] = await q.query<{ current_run_id: string | null }>("SELECT current_run_id FROM harness_sessions WHERE id = $1 AND org_id = $2", [h.parent_id, orgId]);
  await runEvent(q, parentRun, orgId, "child_settled", { handle: h.id, status: r.status, spent_usd: money(cost), returned_usd: refund, error: r.error ? maskSecrets(r.error).slice(0, 300) : undefined });
  return true;
}

/** What follows a settle, after its transaction: its machine moves, its failure policy applies, its parent wakes, the queue moves. */
async function afterSettleOf(orgId: number, handleId: string): Promise<void> {
  const h = await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [orgId, handleId]))[0]);
  if (!h || !h.settled_at) return;
  if (h.step_of) await advanceMachine(orgId, h);
  else if (h.status === "error") await applyFailurePolicy(orgId, h);
  await wakeParentIfDone(orgId, h.parent_id);
  await pump(orgId, h.root_id).catch((e) => console.error(`nested runs: pump: ${(e as Error).message}`));
}

async function applyFailurePolicy(orgId: number, h: HandleRow): Promise<void> {
  if (h.failure_policy === "fail_fast") {
    const open = await read((q) => q.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND parent_id = $2 AND settled_at IS NULL AND id <> $3 AND step_of IS NULL", [orgId, h.parent_id, h.id]));
    for (const c of open) await cancelHandle(orgId, c.id, `cancelled: ${h.name} failed (fail fast)`);
  } else if (h.failure_policy === "escalate") {
    await tx(async (q) => {
      await q.query("UPDATE harness_children SET attention = true, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, h.id]);
      await systemMessage(q, { id: h.root_id, org_id: orgId }, `${h.name} failed and needs someone to look at it${h.error ? `: ${h.error.slice(0, 300)}` : "."}`);
    });
  }
}

async function advanceMachine(orgId: number, step: HandleRow): Promise<void> {
  if (!step.step_of) return;
  const toCancel = await tx(async (q): Promise<string[]> => {
    await q.query("/* tenant: within the caller's workspace */ SELECT 1 FROM harness_sessions WHERE id = $1 AND org_id = $2 FOR UPDATE", [step.parent_id, orgId]);
    const m = await lockHandle(q, orgId, step.step_of!);
    if (m.settled_at || !m.machine?.spec) return [];
    const spec = m.machine.spec;
    const config = await programConfigOf(q, m);
    let machine = m.machine;
    let starts: StepSpec[] = [];
    const cancels: string[] = [];
    // A step of a machine being cancelled, or already finished, moves nothing; it only counts towards settling the machine.
    if (!m.cancel_requested_at && machine.run?.status === "running") {
      const res = machineStep(spec, machine.run, m.inputs, { state: step.state_id!, entry: step.machine?.step?.entry ?? 1, index: step.machine?.step?.index ?? 0, status: step.status === "queued" || step.status === "running" ? "error" : step.status, outputs: step.outputs, answer: step.answer, error: step.error }, config.failure_policy);
      machine = { ...machine, run: res.run };
      starts = res.start;
      await q.query("UPDATE harness_children SET machine = $3, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, m.id, JSON.stringify(machine)]);
      for (const c of res.cancel) cancels.push(...await stepsAt(q, orgId, m.id, c));
    }
    const status = m.cancel_requested_at ? "cancelled" : machine.run?.status ?? "error";
    if (status === "running") {
      if (starts.length) cancels.push(...await createSteps(q, await lockHandle(q, orgId, m.id), spec, config, m.inputs, starts));
      return cancels;
    }
    // Over: whatever is still running goes first, and the machine settles once nothing of it spends any more (its pool is carved).
    const open = await q.query<{ id: string }>("/* tenant: within its workspace */ SELECT id FROM harness_children WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL", [orgId, m.id]);
    if (open.length) {
      await q.query("/* tenant: within its workspace */ UPDATE harness_children SET cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now() WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL", [orgId, m.id]);
      return [...new Set([...cancels, ...open.map((o) => o.id)])];
    }
    if (status === "cancelled") await settleHandle(q, orgId, m.id, { status: "cancelled", error: m.error ?? "cancelled" });
    else if (status === "error") {
      await settleHandle(q, orgId, m.id, { status: "error", error: machine.run?.error ?? "the machine failed" });
      if (config.failure_policy === "escalate") await q.query("UPDATE harness_children SET attention = true WHERE org_id = $1 AND id = $2", [orgId, m.id]);
    } else {
      const final = machine.run?.outputs_final ?? {};
      const problems = m.outputs_schema ? validateJson(final, m.outputs_schema) : [];
      await settleHandle(q, orgId, m.id, problems.length ? { status: "error", error: `the machine's result does not match its outputs: ${problems.slice(0, 5).join("; ")}` } : { status: "done", outputs: final });
    }
    return [];
  });
  for (const id of toCancel) await cancelHandle(orgId, id, "its machine no longer needs it").catch(() => {});
  const after = await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [orgId, step.step_of]))[0]);
  if (after?.settled_at) await afterSettleOf(orgId, after.id);
  else if (after) await pump(orgId, after.root_id).catch((e) => console.error(`nested runs: pump: ${(e as Error).message}`));
}
/** A machine's program as frozen when it started: read on the machine's own transaction (a second connection here could wait on this one). */
const programConfigOf = async (q: Queryable, h: HandleRow): Promise<ProgramConfig> => {
  const [v] = await q.query<{ config: ProgramConfig }>("SELECT config FROM harness_program_versions WHERE program_id = $1 AND version = $2", [h.program_id, h.program_version]);
  if (!v) throw new PackError("this machine's program could not be read", 500);
  return v.config;
};
async function stepsAt(q: Queryable, orgId: number, machine: string, place: { state: string; entry: number; index: number }): Promise<string[]> {
  return (await q.query<{ id: string }>("/* tenant: within its workspace */ SELECT id FROM harness_children WHERE org_id = $1 AND step_of = $2 AND state_id = $3 AND settled_at IS NULL AND (machine->'step'->>'entry')::int = $4 AND (machine->'step'->>'index')::int = $5", [orgId, machine, place.state, place.entry, place.index])).map((r) => r.id);
}

/** A parked parent with no child still open is woken to read their results. */
async function wakeParentIfDone(orgId: number, parentId: string): Promise<void> {
  const should = await tx(async (q) => {
    const p = await rowOf(q, orgId, parentId, true);
    if (closed(p) || p.current_run_id || p.state !== "parked") return false;
    const [{ n }] = await q.query<{ n: number }>("/* tenant: within its workspace */ SELECT count(*)::int AS n FROM harness_children WHERE org_id = $1 AND parent_id = $2 AND settled_at IS NULL", [orgId, parentId]);
    if (n > 0) return false;
    await q.query("UPDATE harness_sessions SET state_reason = 'children settled', updated_at = now() WHERE id = $1 AND org_id = $2", [parentId, orgId]);
    return true;
  });
  if (should) await queueWake(orgId, parentId, "children", SYSTEM).catch((e: Error) => console.error(`nested runs: waking ${parentId}: ${e.message}`));
}

// ---------------------------------------------------------------- after a child's wake ends

/**
 * A wake of a session in a tree ended (src/harness-sessions.ts reconcileWake): a child settles, retries or waits; a
 * session that has ended reaps its children. Idempotent: the sweep says it again.
 */
export async function afterWake(orgId: number, sessionId: string): Promise<void> {
  if (!nestedOn()) return;
  const s = await read((q) => rowOf(q, orgId, sessionId).catch(() => null));
  if (!s) return;
  if (closed(s)) await cancelChildrenOf(orgId, s.id, "its parent session ended");
  const [h] = await read((q) => q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND session_id = $2 AND settled_at IS NULL`, [orgId, sessionId]));
  if (!h) return;
  if (s.current_run_id) return;
  const [{ n: open }] = await read((q) => q.query<{ n: number }>("/* tenant: within its workspace */ SELECT count(*)::int AS n FROM harness_children WHERE org_id = $1 AND parent_id = $2 AND settled_at IS NULL", [orgId, sessionId]));
  const stoppedAsked = !!h.cancel_requested_at;
  if (stoppedAsked) {
    if (!closed(s)) await tx(async (q) => { const x = await rowOf(q, orgId, sessionId, true); if (!closed(x) && !x.current_run_id) await endSession(q, x as never, "stopped", "cancelled"); });
    if (open) { await cancelChildrenOf(orgId, sessionId, "its parent was cancelled"); return; }
    if (await tx((q) => settleHandle(q, orgId, h.id, { status: "cancelled", error: h.error ?? "cancelled" }))) await afterSettleOf(orgId, h.id);
    return;
  }
  if (open && !closed(s)) return;
  if (closed(s)) {
    if (open) { await cancelChildrenOf(orgId, sessionId, "its parent session ended"); return; }
    if (s.state === "failed") { if (await tx((q) => settleHandle(q, orgId, h.id, { status: "error", error: s.state_reason ?? "the session failed" }))) await afterSettleOf(orgId, h.id); return; }
    await finishChild(orgId, h, s);
    return;
  }
  // The retry for missing outputs, its wake lost with its process: asked again, not failed.
  if (s.state === "parked" && s.state_reason === "outputs missing") { await queueWake(orgId, sessionId, "message", SYSTEM).catch((e: Error) => console.error(`nested runs: retry: ${e.message}`)); return; }
  if (s.state === "awaiting" || s.state === "parked") {
    const why = s.state === "awaiting" ? "it spent its budget" : (s.state_reason?.startsWith("crashed") ? s.state_reason : `it stopped before finishing (${s.state_reason ?? "parked"})`);
    await tx(async (q) => { const x = await rowOf(q, orgId, sessionId, true); if (!closed(x) && !x.current_run_id) { await q.query("UPDATE harness_session_requests SET status = 'expired', decided_at = now(), reason = 'a child has no one to ask' WHERE org_id = $1 AND session_id = $2 AND status = 'pending'", [orgId, sessionId]); await endSession(q, x as never, "failed", why); } });
    if (await tx((q) => settleHandle(q, orgId, h.id, { status: "error", error: why }))) await afterSettleOf(orgId, h.id);
  }
}

async function finishChild(orgId: number, h: HandleRow, s: H.SessionRow): Promise<void> {
  // Ended without saying it was done: someone stopped it. Their stop stands; a retry for missing outputs would undo it.
  if (s.state_reason !== "done") { if (await tx((q) => settleHandle(q, orgId, h.id, { status: "cancelled", error: "it was stopped" }))) await afterSettleOf(orgId, h.id); return; }
  const fresh = await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [orgId, h.id]))[0]!);
  const needs = !!fresh.outputs_schema;
  const have = fresh.outputs !== null && fresh.outputs !== undefined;
  if (!needs || have) {
    const answer = fresh.answer ?? await read(async (q) => (await q.query<{ body: string }>("SELECT body FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'agent' ORDER BY id DESC LIMIT 1", [orgId, s.id]))[0]?.body ?? null);
    if (await tx((q) => settleHandle(q, orgId, h.id, { status: "done", answer: answer ? maskSecrets(answer) : null, outputs: fresh.outputs ?? undefined }))) await afterSettleOf(orgId, h.id);
    return;
  }
  if (fresh.retries_used < fresh.retries) {
    const again = await tx(async (q) => {
      const x = await rowOf(q, orgId, s.id, true);
      if (x.current_run_id) return false;
      await q.query("UPDATE harness_children SET retries_used = retries_used + 1, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, h.id]);
      await q.query("UPDATE harness_sessions SET state = 'parked', state_reason = 'outputs missing', archived_at = NULL, ended_at = NULL, retention_until = NULL, updated_at = now() WHERE id = $1 AND org_id = $2", [s.id, orgId]);
      await q.query("INSERT INTO harness_session_messages (session_id, org_id, role, body, status, by_name) VALUES ($1, $2, 'person', $3, 'pending', 'the platform')",
        [s.id, orgId, `Your work is not finished: submit_outputs was not called with outputs matching this JSON Schema: ${JSON.stringify(fresh.outputs_schema).slice(0, 3000)}. Call submit_outputs now with your answer and outputs.`]);
      return true;
    });
    if (again) { await queueWake(orgId, s.id, "message", SYSTEM).catch((e: Error) => console.error(`nested runs: retry: ${e.message}`)); return; }
    return;
  }
  if (await tx((q) => settleHandle(q, orgId, h.id, { status: "error", error: "it finished without outputs matching its schema (after its retries)" }))) await afterSettleOf(orgId, h.id);
}

// ---------------------------------------------------------------- cancelling

async function cancelHandle(orgId: number, id: string, why: string): Promise<void> {
  const h = await tx(async (q) => {
    const [row] = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, id]);
    if (!row || row.settled_at) return null;
    await q.query("UPDATE harness_children SET cancel_requested_at = coalesce(cancel_requested_at, now()), error = coalesce(error, $3), updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, id, `cancelled: ${why}`.slice(0, 300)]);
    return row;
  });
  if (!h) return;
  if (h.kind === "machine") {
    const steps = await read((q) => q.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL", [orgId, id]));
    for (const s of steps) await cancelHandle(orgId, s.id, why);
    // Its budget comes back only once none of its steps can spend it: the last step's settling closes the machine.
    const still = await read((q) => q.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND step_of = $2 AND settled_at IS NULL LIMIT 1", [orgId, id]));
    if (!still.length && await tx((q) => settleHandle(q, orgId, id, { status: "cancelled", error: why }))) await afterSettleOf(orgId, id);
    return;
  }
  if (h.kind === "acceptance") {
    const settled = await tx((q) => settleHandle(q, orgId, id, { status: "cancelled", error: why }));
    await refuseOpenEvaluation(orgId, id, why);
    if (settled) await afterSettleOf(orgId, id);
    return;
  }
  if (!h.session_id) {
    if (await tx((q) => settleHandle(q, orgId, id, { status: "cancelled", error: why }))) await afterSettleOf(orgId, id);
    return;
  }
  const s = await tx(async (q) => {
    const x = await rowOf(q, orgId, h.session_id!, true);
    await revokeToolTokens(q, x.org_id, x.id, "cancelled");
    await q.query("UPDATE harness_sessions SET stop_requested_at = coalesce(stop_requested_at, now()), updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id]);
    await systemMessage(q, x, `Cancelled: ${why}.`, x.current_run_id);
    return x;
  });
  await cancelChildrenOf(orgId, s.id, why); // its own children first: they act only for it
  if (s.current_run_id) {
    const { cancelRun } = await import("./runs.js");
    await cancelRun(orgId, s.current_run_id, "nested runs").catch(() => {});
    await H.reconcileWake(s.current_run_id).catch(() => {}); // a wake still queued settles here; a running one when its runner sees the cancel
  }
  await afterWake(orgId, s.id);
}

/** The step of an acceptance was cancelled: its evaluation is refused and its run told to stop. Whatever it would have measured counts for nothing. */
async function refuseOpenEvaluation(orgId: number, handleId: string, why: string): Promise<void> {
  const [ev] = await read((q) => q.query<{ id: string; run_id: string | null }>("SELECT id, run_id FROM harness_evaluations WHERE org_id = $1 AND handle_id = $2 AND status <> 'decided'", [orgId, handleId]));
  if (!ev) return;
  await decide(orgId, ev.id, { outcome: "refused", reasons: [`it was cancelled: ${why}`.slice(0, 300)], metrics: empty(0) }, null);
  if (ev.run_id) { const { cancelRun } = await import("./runs.js"); await cancelRun(orgId, ev.run_id, "nested runs").catch(() => {}); }
}

/** Every open child of a session is cancelled (a machine's steps with it). */
export async function cancelChildrenOf(orgId: number, sessionId: string, why: string): Promise<number> {
  if (!nestedOn()) return 0;
  const open = await read((q) => q.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND parent_id = $2 AND settled_at IS NULL AND step_of IS NULL", [orgId, sessionId]));
  for (const c of open) await cancelHandle(orgId, c.id, why);
  return open.length;
}

// ---------------------------------------------------------------- the gateway's admission

/** The most a request can cost: `bytes` of JSON treated as no fewer than two bytes per token, all of it as a cache write. */
export function requestBound(price: { inputPerToken: number; outputPerToken: number }, bytes: number, maxTokens: number): number {
  return Math.ceil(bytes / 2) * price.inputPerToken + maxTokens * price.outputPerToken;
}

const requestJson = (body: Buffer): { max_tokens?: unknown; max_completion_tokens?: unknown; n?: unknown; thinking?: { budget_tokens?: unknown } } | null => { try { const v = JSON.parse(body.toString("utf8")) as unknown; return v && typeof v === "object" ? (v as { max_tokens?: unknown }) : null; } catch { return null; } };
/** The body to send (with its limit lowered if the budget needs it) and the hold on what it may cost, or why it is refused. */
export async function admitTreeRequest(run: { id: string; org_id: number; budget_usd: number }, body: Buffer | null, model: string): Promise<{ refused: string } | { hold: string | null; body: Buffer | null; rewritten: boolean }> {
  if (!body || !model) return { hold: null, body, rewritten: false };
  const { costOf } = await import("./usage.js");
  const parsed = requestJson(body);
  const limitKey = typeof parsed?.max_tokens === "number" ? "max_tokens" : typeof parsed?.max_completion_tokens === "number" ? "max_completion_tokens" : null;
  const limitValue = limitKey ? (parsed as Record<string, unknown>)[limitKey] as number : 0;
  const asked = limitKey && limitValue > 0 ? Math.floor(limitValue) : null;
  // OpenAI's n: that many completions, each up to the limit.
  const choices = typeof parsed?.n === "number" && parsed.n > 1 ? Math.floor(parsed.n) : 1;
  // Worst case per token: an input token written to the long cache, an output token at the output price.
  // Priced above any long-context threshold, so the bound is that premium's too (a request's own size decides which it pays).
  const SAMPLE = 2_000_000;
  const input = await costOf(model, { input: SAMPLE, cached: 0, output: 0, cacheWrite: SAMPLE, cacheWrite1h: SAMPLE }).catch(() => null);
  const withOut = await costOf(model, { input: SAMPLE, cached: SAMPLE, output: SAMPLE, cacheWrite: 0, cacheWrite1h: 0 }).catch(() => null);
  const without = await costOf(model, { input: SAMPLE, cached: SAMPLE, output: 0, cacheWrite: 0, cacheWrite1h: 0 }).catch(() => null);
  if (input === null || withOut === null || without === null) return { refused: "this model has no price, so its cost could not be held from the budget" };
  const price = { inputPerToken: input / SAMPLE, outputPerToken: (withOut - without) / SAMPLE };
  const inputBound = requestBound(price, body.length, 0);
  return tx(async (q) => {
    const [r] = await q.query<{ budget_usd: string }>("/* tenant: the gateway token's own run */ SELECT budget_usd FROM runs WHERE id = $1 FOR UPDATE", [run.id]);
    if (!r) return { refused: "no such run" };
    const [u] = await q.query<{ cost: string }>("/* tenant: by run id, the gateway token's own run */ SELECT coalesce(sum(cost_usd), 0) AS cost FROM gateway_usage WHERE run_id = $1", [run.id]);
    const [held] = await q.query<{ held: string }>("/* tenant: by run id, the gateway token's own run */ SELECT coalesce(sum(usd), 0) AS held FROM harness_gateway_holds WHERE run_id = $1 AND expires_at > now()", [run.id]);
    const remaining = num(r.budget_usd) - num(u?.cost) - num(held?.held);
    if (remaining <= 0) return { refused: "This run's budget is used up (by its requests in flight, too)" };
    let want = asked;
    // A request that does not say its limit cannot be bounded: it may use all that is left, and no other runs beside it.
    if (want === null) { const hold = remaining; const id = newId("hgh"); await q.query("INSERT INTO harness_gateway_holds (id, run_id, org_id, usd, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))", [id, run.id, run.org_id, hold, HOLD_SECONDS]); return { hold: id, body, rewritten: false }; }
    let hold = inputBound + want * choices * price.outputPerToken;
    let rewritten = false;
    let out = body;
    if (hold > remaining) {
      const room = Math.floor((remaining - inputBound) / (price.outputPerToken * choices));
      const least = typeof parsed?.thinking?.budget_tokens === "number" ? (parsed.thinking.budget_tokens as number) + 1 : 256;
      if (room < Math.max(256, least)) return { refused: `This run's budget has $${remaining.toFixed(2)} left, too little for this request` };
      want = room;
      hold = inputBound + want * choices * price.outputPerToken;
      const edited = { ...(parsed as unknown as Record<string, unknown>), [limitKey!]: want };
      out = Buffer.from(JSON.stringify(edited));
      rewritten = true;
    }
    const id = newId("hgh");
    await q.query("INSERT INTO harness_gateway_holds (id, run_id, org_id, usd, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))", [id, run.id, run.org_id, money(hold), HOLD_SECONDS]);
    return { hold: id, body: out, rewritten };
  });
}

/** A request's cost is recorded: its hold goes. */
export async function releaseHold(id: string | null): Promise<void> {
  if (id) await asPlatform(async () => (await getDb()).query("/* tenant: the hold just taken, by its id */ DELETE FROM harness_gateway_holds WHERE id = $1", [id])).catch(() => {});
}

// ---------------------------------------------------------------- acceptance

interface EvaluationRow {
  id: string; org_id: number; program_id: string; program_version: number; root_id: string; session_id: string | null; handle_id: string | null; run_id: string | null; target_kind: string; target_id: string; hypothesis: string;
  candidate: CandidateRef & { id?: string }; champion_id: string | null; acceptance: NonNullable<ProgramConfig["acceptance"]>; contract_sha256: string | null; status: string; outcome: string | null; created_at: Date;
}
const E_COLS = "id, org_id, program_id, program_version, root_id, session_id, handle_id, run_id, target_kind, target_id, hypothesis, candidate, champion_id, acceptance, contract_sha256, status, outcome, created_at";
export interface ChampionRow { id: string; org_id: number; target_kind: string; target_id: string; version: number; status: string; candidate: CandidateRef & Record<string, unknown>; metrics: Record<string, unknown>; evaluation_id: string | null; program_id: string | null; applied_at: Date | null; applied_ref: string | null; rolled_back_at: Date | null; created_at: Date; created_by: string; applied_by: string | null; rolled_back_by: string | null; rollback_reason: string | null }
const C_COLS = "id, org_id, target_kind, target_id, version, status, candidate, metrics, evaluation_id, program_id, applied_at, applied_ref, rolled_back_at, created_at, created_by, applied_by, rolled_back_by, rollback_reason";

async function startAcceptance(orgId: number, h: HandleRow): Promise<void> {
  const conf = h.machine?.acceptance;
  if (!conf) { await settleAcceptance(orgId, h.id, { decision: "refused", version: null, reasons: ["this step has no acceptance rule"], metrics: {} }); return; }
  const m = await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND id = $2`, [orgId, h.step_of]))[0]);
  const from = await read(async (q) => (await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND step_of = $2 AND state_id = $3 AND candidate IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [orgId, h.step_of, conf.candidate_from]))[0]);
  const a = conf.config;
  const targetId = a.target.id ?? (a.target.from_input ? String(atPath(m?.inputs ?? {}, a.target.from_input) ?? "") : "");
  const noTarget = !targetId;
  const id = newId("hev");
  const candidate: CandidateRef = from?.candidate ?? { key: "", sha256: "", bytes: 0, paths: [], from_session: "" };
  const off = from?.candidate ? offSurface(candidate.paths, a.surface) : [];
  const contract = a.test?.sha256 ?? null;
  await tx(async (q) => {
    await q.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, session_id, handle_id, target_kind, target_id, hypothesis, candidate, acceptance, contract_sha256, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')`,
      [id, orgId, h.program_id ?? "unknown", h.program_version ?? 1, h.root_id, from?.session_id ?? null, h.id, a.target.kind, targetId || "unknown", maskSecrets(conf.hypothesis ?? "").slice(0, 8000), JSON.stringify(candidate), JSON.stringify(a), contract]);
    await q.query("UPDATE harness_children SET machine = machine || $3::jsonb WHERE org_id = $1 AND id = $2", [orgId, h.id, JSON.stringify({ evaluation: id })]);
  });
  // What fails closed without running anything.
  const champ = await read(async (q) => (await q.query<ChampionRow>(`SELECT ${C_COLS} FROM harness_champions WHERE org_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'champion'`, [orgId, a.target.kind, targetId]))[0] ?? null);
  const reasons: string[] = noTarget ? ["this run did not name the target to promote"] : !from?.candidate ? ["the candidate step sent no candidate"] : [];
  if (reasons.length) { await decide(orgId, id, { outcome: "refused", reasons, metrics: empty(Number(0)) }, null); return; }
  if (off.length || !a.test) {
    await decide(orgId, id, decideAcceptance(a, { measured: null, offSurfacePaths: off, hasBest: !!champ, seed: seedOf(id) }), null);
    return;
  }
  const { startRun } = await import("./runs.js");
  await tx((q) => q.query("UPDATE harness_evaluations SET champion_id = $3, status = 'running' WHERE org_id = $1 AND id = $2", [orgId, id, champ?.id ?? null]));
  const run = await startRun(orgId, AGENT_PACK, ACCEPTANCE_KIND, { scope: { evaluation: id } }, "the platform").catch(async (e: Error) => {
    await decide(orgId, id, { outcome: "refused", reasons: [`the evaluation could not start: ${e.message.slice(0, 300)}`], metrics: empty(0) }, null);
    return null;
  });
  if (run) await tx((q) => q.query("UPDATE harness_evaluations SET run_id = $3 WHERE org_id = $1 AND id = $2", [orgId, id, run.id]));
}
const empty = (n: number): Decision["metrics"] => ({ n, baseline_mean: null, candidate_mean: null, lift: null, ci_low: null, ci_high: null, floors: {} });

async function decide(orgId: number, id: string, d0: Decision, cases: MeasuredCase[] | null): Promise<Decision["outcome"]> {
  let d = d0;
  const out = await tx(async (q) => {
    const [ev] = await q.query<EvaluationRow>(`SELECT ${E_COLS} FROM harness_evaluations WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, id]);
    if (!ev) return null;
    if (ev.status === "decided") { d = { ...d, outcome: (ev.outcome ?? "refused") as Decision["outcome"] }; return null; }
    // Whoever asked has gone: a step cancelled or settled meanwhile cannot have its result promote anything.
    if (ev.handle_id && d.outcome !== "refused") {
      const [h] = await q.query<{ settled_at: Date | null; cancel_requested_at: Date | null }>("SELECT settled_at, cancel_requested_at FROM harness_children WHERE org_id = $1 AND id = $2 FOR UPDATE", [orgId, ev.handle_id]);
      if (h?.settled_at || h?.cancel_requested_at) d = { outcome: "refused", reasons: ["its step had been cancelled or settled before the result came in"], metrics: d.metrics };
    }
    let promoted: string | null = null, version: number | null = null;
    if (d.outcome === "accepted") ({ promoted, version } = await promote(q, ev, d, "the guardian"));
    await q.query("UPDATE harness_evaluations SET status = 'decided', outcome = $3, reasons = $4, metrics = $5, cases = $6, promoted_id = $7, decided_by = 'the guardian', decided_at = now() WHERE org_id = $1 AND id = $2",
      [orgId, id, d.outcome, JSON.stringify(d.reasons), JSON.stringify(d.metrics), cases ? JSON.stringify(cases) : null, promoted]);
    await runEvent(q, ev.handle_id ? (await q.query<{ run: string | null }>("/* tenant: within its workspace */ SELECT s.current_run_id AS run FROM harness_children h JOIN harness_sessions s ON s.id = h.parent_id AND s.org_id = h.org_id WHERE h.org_id = $1 AND h.id = $2", [orgId, ev.handle_id]))[0]?.run ?? null : null, orgId, "evaluation_decided", { evaluation: id, outcome: d.outcome, reasons: d.reasons.slice(0, 5), version });
    return { handle: ev.handle_id, version };
  });
  if (out?.handle) await settleAcceptance(orgId, out.handle, { decision: d.outcome, version: out.version, reasons: d.reasons, metrics: d.metrics });
  return d.outcome;
}
async function settleAcceptance(orgId: number, handleId: string, outputs: { decision: string; version: number | null; reasons: string[]; metrics: unknown }): Promise<void> {
  if (await tx((q) => settleHandle(q, orgId, handleId, { status: "done", outputs }))) await afterSettleOf(orgId, handleId);
}
async function promote(q: Queryable, ev: EvaluationRow, d: Decision, by: string): Promise<{ promoted: string; version: number }> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`harness-champion:${ev.org_id}:${ev.target_kind}:${ev.target_id}`]);
  const [cur] = await q.query<{ version: number }>("/* tenant: within its workspace */ SELECT coalesce(max(version), 0)::int AS version FROM harness_champions WHERE org_id = $1 AND target_kind = $2 AND target_id = $3", [ev.org_id, ev.target_kind, ev.target_id]);
  const version = (cur?.version ?? 0) + 1;
  await q.query("/* tenant: within its workspace */ UPDATE harness_champions SET status = 'superseded' WHERE org_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'champion'", [ev.org_id, ev.target_kind, ev.target_id]);
  const id = newId("hcv");
  await q.query(`INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, evaluation_id, program_id, candidate, metrics, created_by) VALUES ($1, $2, $3, $4, $5, 'champion', $6, $7, $8, $9, $10)`,
    [id, ev.org_id, ev.target_kind, ev.target_id, version, ev.id, ev.program_id, JSON.stringify(ev.candidate), JSON.stringify(d.metrics), by]);
  return { promoted: id, version };
}

// The evaluator's calls, each only for the run this evaluation started, with its lease.
async function evaluationOfRun(runId: string, lease: string): Promise<EvaluationRow> {
  const { leasedRun } = await import("./runs.js");
  const r = await leasedRun(runId, lease);
  const scope = (r.scope ?? {}) as { evaluation?: unknown };
  const [ev] = await read((q) => q.query<EvaluationRow>(`/* tenant: the leased run's own evaluation */ SELECT ${E_COLS} FROM harness_evaluations WHERE org_id = $1 AND id = $2 AND run_id = $3`, [r.org_id, String(scope.evaluation ?? ""), runId]));
  if (!ev) throw new PackError("this run is not an evaluation", 403);
  return ev;
}
export async function evaluationStart(runId: string, lease: string): Promise<EvaluationStart> {
  needOn();
  const ev = await evaluationOfRun(runId, lease);
  const a = ev.acceptance, test = a.test;
  if (!test) throw new PackError("this evaluation has no test", 409);
  // The test as frozen with the program's version, re-derived, never trusted from a stored field.
  const { contractSha } = await import("./program-spec.js");
  if (contractSha(test, sha256) !== ev.contract_sha256) throw new PackError("the test does not match the contract frozen with this program's version", 409);
  return { evaluation: ev.id, test, metric: a.metric, floors: a.floors.map((f) => f.metric), has_candidate: !!ev.candidate.key, has_champion: !!ev.champion_id };
}
export async function evaluationBundle(runId: string, lease: string, which: "candidate" | "champion"): Promise<Buffer | null> {
  needOn();
  const ev = await evaluationOfRun(runId, lease);
  if (which === "candidate") return candidateBytes(ev.org_id, ev.candidate);
  if (!ev.champion_id) return null;
  const [c] = await read((q) => q.query<ChampionRow>(`SELECT ${C_COLS} FROM harness_champions WHERE org_id = $1 AND id = $2`, [ev.org_id, ev.champion_id]));
  return c ? candidateBytes(ev.org_id, c.candidate as CandidateRef) : null;
}
export async function evaluationFile(runId: string, lease: string, index: number): Promise<Buffer> {
  needOn();
  const ev = await evaluationOfRun(runId, lease);
  const f = ev.acceptance.test?.files[index];
  if (!f) throw new PackError("no such test file", 404);
  const { readUploadBytes } = await import("./agent-profiles.js");
  return readUploadBytes(f.id);
}
export async function evaluationResult(runId: string, lease: string, r: EvaluationResult): Promise<{ outcome: string }> {
  needOn();
  const ev = await evaluationOfRun(runId, lease);
  if (ev.status === "decided") return { outcome: ev.outcome ?? "decided" };
  const off = offSurface(ev.candidate.paths ?? [], ev.acceptance.surface);
  const cases: MeasuredCase[] = Array.isArray(r.cases) ? r.cases.map((c) => ({ id: String(c.id), baseline: typeof c.baseline === "number" ? c.baseline : null, candidate: typeof c.candidate === "number" ? c.candidate : null, floors: c.floors ?? {} })) : [];
  const d = r.error && !r.tampered && !cases.length ? { outcome: "refused" as const, reasons: [r.error.slice(0, 500)], metrics: empty(0) }
    : decideAcceptance(ev.acceptance, { measured: { cases, tampered: r.tampered ?? null }, offSurfacePaths: off, hasBest: !!ev.champion_id, seed: seedOf(ev.id) });
  return { outcome: await decide(ev.org_id, ev.id, d, cases) };
}

// ---------------------------------------------------------------- staff: review, rollback, apply

export interface EvaluationView { id: string; org_id: number; workspace?: string | null; program: string; program_version: number; root_id: string; target: { kind: string; id: string }; hypothesis: string; status: string; outcome: string | null; reasons: string[]; metrics: unknown; candidate: { sha256: string; bytes: number; paths: string[] }; decided_at: string | null; reviewed_by: string | null; review_decision: string | null; promoted_id: string | null; created_at: string }
const evView = (e: Record<string, any>): EvaluationView => ({ id: e.id, org_id: e.org_id, workspace: e.slug ?? null, program: e.program_id, program_version: e.program_version, root_id: e.root_id, target: { kind: e.target_kind, id: e.target_id }, hypothesis: e.hypothesis, status: e.status, outcome: e.outcome, reasons: e.reasons ?? [], metrics: e.metrics ?? {}, candidate: { sha256: e.candidate?.sha256 ?? "", bytes: e.candidate?.bytes ?? 0, paths: e.candidate?.paths ?? [] }, decided_at: iso(e.decided_at), reviewed_by: e.reviewed_by ?? null, review_decision: e.review_decision ?? null, promoted_id: e.promoted_id ?? null, created_at: iso(e.created_at)! });
export async function listEvaluations(orgId: number | null, filter: { program?: string; target?: string } = {}): Promise<EvaluationView[]> {
  needOn();
  const rows = await read((q) => q.query<Record<string, any>>(`/* tenant: the caller's workspace (staff: every workspace) */ SELECT e.*, o.slug FROM harness_evaluations e JOIN organizations o ON o.id = e.org_id
    WHERE ($1::int IS NULL OR e.org_id = $1) AND ($2::text IS NULL OR e.program_id = $2) AND ($3::text IS NULL OR e.target_id = $3) ORDER BY e.created_at DESC LIMIT 200`, [orgId, filter.program ?? null, filter.target ?? null]));
  return rows.map(evView);
}
export interface ChampionView { id: string; version: number; target: { kind: string; id: string }; status: string; metrics: unknown; evaluation: string | null; program: string | null; applied_at: string | null; applied_by: string | null; applied_ref: string | null; rolled_back_at: string | null; rollback_reason: string | null; created_at: string; workspace?: string | null }
const champView = (c: ChampionRow & { slug?: string }): ChampionView => ({ id: c.id, version: c.version, target: { kind: c.target_kind, id: c.target_id }, status: c.status, metrics: c.metrics, evaluation: c.evaluation_id, program: c.program_id, applied_at: iso(c.applied_at), applied_by: c.applied_by, applied_ref: c.applied_ref, rolled_back_at: iso(c.rolled_back_at), rollback_reason: c.rollback_reason, created_at: iso(c.created_at)!, ...(c.slug ? { workspace: c.slug } : {}) });
export async function listChampions(orgId: number | null, filter: { target?: string } = {}): Promise<ChampionView[]> {
  needOn();
  const rows = await read((q) => q.query<ChampionRow & { slug: string }>(`/* tenant: the caller's workspace (staff: every workspace) */ SELECT c.${C_COLS.split(", ").join(", c.")}, o.slug FROM harness_champions c JOIN organizations o ON o.id = c.org_id
    WHERE ($1::int IS NULL OR c.org_id = $1) AND ($2::text IS NULL OR c.target_id = $2) ORDER BY c.created_at DESC LIMIT 200`, [orgId, filter.target ?? null]));
  return rows.map(champView);
}
/** A person decides what the guardian could not (no test, or no current best to beat). Their accept is what promotes it. */
export async function reviewEvaluation(by: string, id: string, input: { decision?: unknown; reason?: unknown }): Promise<EvaluationView> {
  needOn();
  if (input.decision !== "accept" && input.decision !== "decline") throw new PackError("decision: accept or decline", 400);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  if (!reason) throw new PackError("reason: say why (it is kept with the decision)", 400);
  await tx(async (q) => {
    const [ev] = await q.query<EvaluationRow & Record<string, unknown>>(`/* tenant: staff, by evaluation id */ SELECT ${E_COLS}, review_decision FROM harness_evaluations WHERE id = $1 FOR UPDATE`, [id]);
    if (!ev) throw new PackError("no such evaluation", 404);
    if (ev.outcome !== "needs_review") throw new PackError("Only an outcome that needs review is decided by a person", 409);
    if (ev.review_decision) throw new PackError("This was already decided", 409);
    let promoted: string | null = null;
    if (input.decision === "accept") ({ promoted } = await promote(q, ev, { outcome: "accepted", reasons: [`accepted by ${by}: ${reason}`], metrics: empty(0) }, by));
    await q.query("/* tenant: staff, by evaluation id */ UPDATE harness_evaluations SET reviewed_by = $2, reviewed_at = now(), review_decision = $3, review_reason = $4, promoted_id = coalesce(promoted_id, $5) WHERE id = $1", [id, by, input.decision, reason, promoted]);
  });
  const [row] = await read((q) => q.query<Record<string, any>>("/* tenant: staff, by evaluation id */ SELECT e.*, o.slug FROM harness_evaluations e JOIN organizations o ON o.id = e.org_id WHERE e.id = $1", [id]));
  return evView(row!);
}
/** Rollback: the version before this one is the champion again; this one is kept, marked. A person's action. */
export async function rollbackChampion(by: string, id: string, input: { reason?: unknown }): Promise<ChampionView> {
  needOn();
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  if (!reason) throw new PackError("reason: say why (it is kept with the rollback)", 400);
  await tx(async (q) => {
    const [c] = await q.query<ChampionRow>(`/* tenant: staff, by version id */ SELECT ${C_COLS} FROM harness_champions WHERE id = $1 FOR UPDATE`, [id]);
    if (!c) throw new PackError("no such version", 404);
    if (c.status !== "champion") throw new PackError("Only the current champion can be rolled back", 409);
    await q.query("/* tenant: staff, by version id */ UPDATE harness_champions SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2, rollback_reason = $3 WHERE id = $1", [id, by, reason]);
    const [prev] = await q.query<{ id: string }>("/* tenant: within the version's own workspace */ SELECT id FROM harness_champions WHERE org_id = $1 AND target_kind = $2 AND target_id = $3 AND status = 'superseded' ORDER BY version DESC LIMIT 1", [c.org_id, c.target_kind, c.target_id]);
    if (prev) await q.query("/* tenant: staff, by version id */ UPDATE harness_champions SET status = 'champion' WHERE id = $1", [prev.id]);
  });
  const [row] = await read((q) => q.query<ChampionRow & { slug: string }>(`/* tenant: staff, by version id */ SELECT c.${C_COLS.split(", ").join(", c.")}, o.slug FROM harness_champions c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1`, [id]));
  return champView(row!);
}
/**
 * A person takes a champion live. A recipe: a proposal against its current version, which staff accept in Recipes as for any
 * agent's (nothing is written to a recipe from here). Any other target is a record of who said it and what they did: this
 * shell pushes to no customer app and no default branch.
 */
export async function applyChampion(by: string, id: string, input: { ref?: unknown }): Promise<ChampionView> {
  needOn();
  const ref = typeof input.ref === "string" ? input.ref.trim().slice(0, 300) : "";
  const [c] = await read((q) => q.query<ChampionRow>(`/* tenant: staff, by version id */ SELECT ${C_COLS} FROM harness_champions WHERE id = $1`, [id]));
  if (!c) throw new PackError("no such version", 404);
  if (c.status !== "champion") throw new PackError("Only the current champion can be applied", 409);
  if (c.applied_at) throw new PackError("This version was already applied", 409);
  let appliedRef = ref;
  if (c.target_kind === "recipe") {
    const R = await import("./recipes.js");
    if (!R.recipesOn()) throw new PackError("Workspace recipes are not on in this app", 404);
    const detail = await R.readRecipe(c.target_id);
    if (detail.version < 1) throw new PackError("This recipe has no version yet: give it its first version in Recipes, then apply this", 409);
    const body = await candidateBytes(c.org_id, c.candidate as CandidateRef);
    if (!body) throw new PackError("The candidate's files could not be read", 409);
    const { readBundle } = await import("./workspace-bundle.js");
    const files = readBundle(body).files.map((f: { path: string; body: Buffer }) => ({ path: f.path, data: f.body, executable: false }));
    const made = await R.proposeRecipeVersion({ org_id: c.org_id, session_id: "", run_id: "", recipe: { id: c.target_id, version: detail.version } }, { note: `Champion version ${c.version} of a program's run (accepted by the guardian).`, removed: [], files });
    appliedRef = `recipe proposal ${made.id}`;
  } else if (!ref) throw new PackError("ref: say what was applied and where (this shell applies nothing by itself)", 400);
  await tx((q) => q.query("/* tenant: staff, by version id */ UPDATE harness_champions SET applied_at = now(), applied_by = $2, applied_ref = $3 WHERE id = $1 AND applied_at IS NULL", [id, by, appliedRef]));
  const [row] = await read((q) => q.query<ChampionRow & { slug: string }>(`/* tenant: staff, by version id */ SELECT c.${C_COLS.split(", ").join(", c.")}, o.slug FROM harness_champions c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1`, [id]));
  return champView(row!);
}

// ---------------------------------------------------------------- the tree, as the console reads it

export interface TreeNode extends HandleView { depth: number; children: TreeNode[]; }
export interface TreeView { root_id: string; handles: HandleView[]; }
export async function readTree(orgId: number | null, sessionId: string, actor: H.Actor): Promise<{ root: H.SessionDetail; children: (HandleView & { parent_id: string; step_of: string | null; machine: { run: MachineRun | null } | null })[] }> {
  needOn();
  const root = await H.readSession(orgId, sessionId, actor);
  const org = root.workspace?.id ?? orgId;
  const rows = await read(async (q) => {
    const rid = root.nested?.root_id ?? root.id;
    const hs = await q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND root_id = $2 ORDER BY created_at, child_no`, [org ?? rootOrgId(root), rid]);
    return { hs, list: hs.length ? await views(q, hs) : [] };
  });
  return { root, children: rows.list.map((v, i) => ({ ...v, parent_id: rows.hs[i]!.parent_id, step_of: rows.hs[i]!.step_of, machine: rows.hs[i]!.machine?.run ? { run: rows.hs[i]!.machine!.run! } : null })) };
}
const rootOrgId = (r: H.SessionDetail) => r.workspace?.id ?? 0;

// ---------------------------------------------------------------- the tick (src/harness-sessions.ts sweepHarnessSessions)

export interface NestedSweep { settled: number; reaped: number; pumped: number; requeued: number; evaluations: number; holds: number }
/** Everything a lost process could have left unfinished is found here. */
export async function nestedTick(now = new Date()): Promise<NestedSweep> {
  if (!nestedOn()) return { settled: 0, reaped: 0, pumped: 0, requeued: 0, evaluations: 0, holds: 0 };
  const out: NestedSweep = { settled: 0, reaped: 0, pumped: 0, requeued: 0, evaluations: 0, holds: 0 };
  // Holds past their time (a request whose process died): they free the budget they held.
  out.holds = await asPlatform(async () => (await (await getDb()).query("/* tenant: platform sweep across workspaces */ DELETE FROM harness_gateway_holds WHERE expires_at < $1 RETURNING id", [now])).length);
  type Open = HandleRow & { updated_at: Date; p_closed: boolean; s_state: string | null; s_run: string | null; s_updated: Date | null; s_wakes: number | null };
  const open = await read((q) => q.query<Open>(
    `/* tenant: platform sweep across workspaces */ SELECT h.${H_COLS.split(", ").join(", h.")}, h.updated_at, (p.state IN ('stopped', 'failed') OR p.archived_at IS NOT NULL) AS p_closed,
            s.state AS s_state, s.current_run_id AS s_run, s.updated_at AS s_updated, s.wakes AS s_wakes
       FROM harness_children h JOIN harness_sessions p ON p.id = h.parent_id AND p.org_id = h.org_id LEFT JOIN harness_sessions s ON s.id = h.session_id AND s.org_id = h.org_id
      WHERE h.settled_at IS NULL ORDER BY h.updated_at LIMIT 500`));
  const lost = (d: Date | null) => !!d && now.getTime() - new Date(d).getTime() > LOST_START_MS;
  const requeue = (h: Open) => tx((q) => q.query("/* tenant: the sweep's own row */ UPDATE harness_children SET status = 'queued', queue_reason = 'waiting for a place', updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'running' AND session_id IS NULL AND settled_at IS NULL", [h.org_id, h.id]));
  const roots = new Set<string>();
  for (const h of open) {
    roots.add(`${h.org_id}:${h.root_id}`);
    if (h.p_closed) { await cancelHandle(h.org_id, h.id, "its parent session ended").catch(() => {}); out.reaped++; continue; }
    if (h.cancel_requested_at) { await cancelHandle(h.org_id, h.id, h.error ?? "cancelled").catch(() => {}); out.reaped++; continue; }
    if (h.kind === "machine") { await reconcileMachine(h.org_id, h).catch((e: Error) => console.error(`nested runs: ${h.id}: ${e.message}`)); continue; }
    if (h.kind === "acceptance") {
      if (h.status !== "running") continue;
      const [ev] = await read((q) => q.query<{ status: string; outcome: string | null; reasons: string[]; metrics: unknown; promoted_id: string | null }>("SELECT status, outcome, reasons, metrics, promoted_id FROM harness_evaluations WHERE org_id = $1 AND handle_id = $2 ORDER BY created_at DESC LIMIT 1", [h.org_id, h.id]));
      if (ev?.status === "decided") {
        // Decided, and the settling lost with its process.
        const [c] = ev.promoted_id ? await read((q) => q.query<{ version: number }>("SELECT version FROM harness_champions WHERE org_id = $1 AND id = $2", [h.org_id, ev.promoted_id])) : [];
        await settleAcceptance(h.org_id, h.id, { decision: ev.outcome ?? "refused", version: c?.version ?? null, reasons: ev.reasons, metrics: ev.metrics }).catch(() => {});
        out.settled++;
      } else if (!ev && lost(h.updated_at)) { await requeue(h); out.requeued++; }
      continue;
    }
    if (!h.session_id) { if (h.status === "running" && lost(h.updated_at)) { await requeue(h); out.requeued++; } continue; }
    // A session made and its wake never queued, or lost half way.
    if (!h.s_run && (h.s_state === "starting" || h.s_state === "waking") && lost(h.s_updated)) {
      await tx((q) => q.query("/* tenant: the sweep's own row */ UPDATE harness_sessions SET state = CASE WHEN wakes = 0 THEN 'starting' ELSE 'parked' END, updated_at = now() WHERE id = $1 AND org_id = $2 AND current_run_id IS NULL AND state IN ('starting', 'waking')", [h.session_id, h.org_id]));
      await queueWake(h.org_id, h.session_id, (h.s_wakes ?? 0) > 0 ? "message" : "start", SYSTEM).catch((e: Error) => console.error(`nested runs: ${h.id}: ${e.message}`));
      out.requeued++;
      continue;
    }
    await afterWake(h.org_id, h.session_id).catch(() => {});
    out.settled++;
  }
  // Evaluations whose run ended without a result, or never started: refused, never waved through.
  const stuck = await read((q) => q.query<{ id: string; org_id: number }>(`/* tenant: platform sweep across workspaces */ SELECT e.id, e.org_id FROM harness_evaluations e LEFT JOIN runs r ON r.id = e.run_id AND r.org_id = e.org_id
     WHERE e.status <> 'decided' AND ((e.run_id IS NOT NULL AND r.status IN ('succeeded', 'failed', 'cancelled')) OR (e.run_id IS NULL AND e.created_at < $1::timestamptz - make_interval(secs => $2))) LIMIT 100`, [now, LOST_START_MS / 1000]));
  for (const s of stuck) { await decide(s.org_id, s.id, { outcome: "refused", reasons: ["the evaluation ended without measurements"], metrics: empty(0) }, null).catch(() => {}); out.evaluations++; }
  for (const key of roots) { const [org, root] = [Number(key.split(":")[0]), key.split(":").slice(1).join(":")]; await pump(org, root).catch(() => {}); out.pumped++; }
  return out;
}

/** A machine whose advance was lost with its process: each settled step its state has not taken in is taken in now (stepping one twice changes nothing). */
async function reconcileMachine(orgId: number, m: HandleRow): Promise<void> {
  const run = m.machine?.run;
  if (!run) return;
  const steps = await read((q) => q.query<HandleRow>(`SELECT ${H_COLS} FROM harness_children WHERE org_id = $1 AND step_of = $2 ORDER BY settled_at NULLS LAST, created_at`, [orgId, m.id]));
  const settled = steps.filter((s) => s.settled_at);
  const unseen = run.status === "running" ? settled.filter((s) => {
    const e = run.running.find((x) => x.state === s.state_id && x.entry === (s.machine?.step?.entry ?? 1));
    return !!e && !e.results.some((r) => r.index === (s.machine?.step?.index ?? 0));
  }) : [];
  for (const s of unseen) await advanceMachine(orgId, s);
  // Finished, and nothing of it still open: closed by the step that settled last.
  if (!unseen.length && run.status !== "running" && settled.length === steps.length && settled.length) await advanceMachine(orgId, settled.at(-1)!);
}
