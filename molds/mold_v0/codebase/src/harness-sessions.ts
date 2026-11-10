/**
 * The workspace agent's control plane (mold_v0-243; molds/mold_v0/docs/agent-harness.md): sessions a person talks to,
 * each wake a run of the generic run engine (the built-in kind _agent/session, src/agent-harness-config.ts), carried
 * out by src/agent-harness.ts. The only writer of the harness_* tables (sql/migrations/0044_harness_sessions.sql).
 *
 *   start      a person (or an account key) starts a session with its first message: the policy in force is frozen into
 *              it (harness, model, provider, limits, web tools, hooks) and its budget (the setting, at most the ceiling);
 *              its first wake is queued as a run whose budget is what the session has left
 *   message    the person who started it sends more, whatever state it is in: delivered on the running wake's next beat
 *              (steer); on a parked or paused session it wakes it (a new run, the same harness session); while a decision is
 *              pending it waits and is delivered by the wake the decision causes; on an ended session it continues it (a new
 *              wake on the same harness session) or, when nothing can be resumed, starts a follow-on session from its
 *              conversation (mold_v0-289). Nobody but the person who started it can send one
 *   pause      the starter, an owner or staff: a running wake is asked to stop and keep its session (SIGTERM, so the
 *              harness flushes it), a queued one is withdrawn; resume (the starter) wakes it on the same session
 *   stop       the starter, an owner or staff: ends it (a turn in progress finishes); only its starter's next message reopens it
 *   requests   what the agent asked for that its policy does not allow (a web host, a tool) and a stop on its budget:
 *              approve grants exactly that and wakes it; decline records the refusal and parks it with that said
 *   raise      a billing manager, an owner or staff, with a reason: up to the ceiling, down to what it has spent (mold_v0-287), also
 *              while a wake runs (the gateway and the beat read the budget live; the CLI stops at what it was told and is woken again)
 *   composer   (mold_v0-290; src/agent-composer.ts) a message carries files, delivered into the session's working directory,
 *              and repositories of the workspace's own GitHub connection, read-only for that session; a short human number
 *              per workspace (AGI-001) is taken from harness_session_counters in the transaction that inserts the session
 *   beat       the wake's heartbeat (src/run-routes.ts /agent/beat): the lease, the spend, the steer, pause and end
 *   reach      what it may use of its workspace (src/harness-reach.ts, mold_v0-250): the app's own customer MCP tools as
 *              the person who started it (a token per wake, revoked when the wake ends, a pause or stop is asked, at its
 *              budget), reads without asking and the rest as requests, and the workspace's context as standing instructions
 *   profile    (mold_v0-261) a session starts with an agent profile (src/agent-profiles.ts; the Default one unless another
 *              is chosen): who may start it, its instructions, model, budget and ceiling, turns, tools, web and files,
 *              resolved for the workspace (its override) and frozen with the profile's version; a record page's
 *              start_agent action links the session to its record
 *   reconcile  after a wake's run ends (src/runs.ts completeRun, sweepRuns, and the sweep below): parked, paused,
 *              awaiting a decision, stopped, or crashed (parked with its checkpoint; resumed by the next message, or by
 *              itself with AGENT_AUTO_RESUME, within AGENT_CRASH_RESUMES and half its budget)
 *   sweep      requests past their window expire, quiet parked sessions are archived, ended sessions past retention lose
 *              their messages, requests and checkpoints (their spend and budget raises stay)
 *
 * Spend is counted once per session: each wake is one run, the gateway meters every request of it once, and the
 * harness's own cumulative reports are accrued against a high-water mark per wake from a baseline that takes out what
 * a resumed harness session re-reports (accrueSpend); a wake's spend is the greater of the two, never their sum.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import { asPlatform } from "./tenant-scope.js";
import { canAccount, type AccountRole } from "./account-roles.js";
import { AGENT_KIND, AGENT_PACK, agentHarnessOn, agentKind, currentPolicy, flavourOf, freeWorkspaceTools, hostAllowed, resolveHooks, validHost, workspaceToolName, workspaceToolOf, type AgentPolicy, type HookEvent } from "./agent-harness-config.js";
import { mintToolToken, revokeToolTokens, sweepToolTokens, workspaceReach } from "./harness-reach.js";
import { applyOnStart } from "./agent-profile-spec.js";
import { governedEgressHosts, type FrozenGovernance } from "./agent-governance.js";
import { governanceWords, uploadParts } from "./agent-profiles.js";
import { settingNumber } from "./settings.js";
import { maskSecrets } from "./run-events.js";
import { PROFILE } from "./profile.js";
import { attachmentMaxBytes, attachmentNote, bindFiles, COMPOSER_LIMITS, fileIds, filesAvailable, isSessionFile, repositoryNames, sessionFileBytes, sessionRepositories, sessionUploads, sweepAttachments, type MessageAttachments } from "./agent-composer.js";
import { domainAllowed, fetchRules } from "./agent-governance.js";
import { messageStep, TRACE_CONTENT_EVENTS, traceMarks, traceSteps, waitingOn, type TraceEventRow, type TraceMessageRow, type TraceRequestRow, type TraceSandboxRow, type TraceStep, type TraceWakeRow } from "./harness-trace.js";

// ---------------------------------------------------------------- types

export type HarnessState = "starting" | "live" | "parked" | "waking" | "paused" | "awaiting" | "stopped" | "failed";
export type AgentPhase = "starting" | "working" | "waiting" | "parked" | "waking" | "paused" | "awaiting_approval" | "stopped" | "failed" | "archived";
export type RequestKind = "web" | "tool" | "budget";
/** "policy" (mold_v0-267): its governance policy refused a call outright, and the session ends with the reference's code. */
export type EndReason = "parked" | "paused" | "awaiting" | "budget" | "stopped" | "done" | "web_limit" | "policy" | "failed";

/** Who acts: a signed-in person (with their account role), an account key (no person), platform staff, or the platform. */
export interface Actor { kind: "person" | "key" | "staff" | "system"; user: string | null; name: string | null; role: AccountRole | null }

interface SessionRow {
  id: string; org_id: number; title: string; started_by: string | null; started_by_name: string | null; state: HarnessState; in_turn: boolean;
  state_reason: string | null; pause_requested_at: Date | null; stop_requested_at: Date | null; flavour: string; model: string; provider: string;
  policy: AgentPolicy; harness_session: string | null; checkpoint: Checkpoint | null; checkpoint_seq: number; budget_usd: string | number;
  spent_usd: string | number; reserve_usd: string | number; crash_spent_usd: string | number; wakes: number; crashes: number; web_calls: number;
  current_run_id: string | null; last_activity_at: Date; created_at: Date; updated_at: Date; ended_at: Date | null; archived_at: Date | null;
  retention_until: Date | null; pruned_at: Date | null;
  profile_id: string | null; profile_version: number | null; record_area: string | null; record_key: string | null; session_number: number;
}
export interface Checkpoint { seq: number; key: string; sha256: string; bytes: number; at: string; run_id: string }
const COLS = `id, org_id, title, started_by, started_by_name, state, in_turn, state_reason, pause_requested_at, stop_requested_at, flavour, model, provider,
  policy, harness_session, checkpoint, checkpoint_seq, budget_usd, spent_usd, reserve_usd, crash_spent_usd, wakes, crashes, web_calls, current_run_id,
  last_activity_at, created_at, updated_at, ended_at, archived_at, retention_until, pruned_at, profile_id, profile_version, record_area, record_key, session_number`;

export interface RequestView { id: string; kind: RequestKind; subject: string; /** The tool's own title (a workspace tool), else the subject in plain words. */ subject_title: string; detail: Record<string, unknown>; status: string; decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string; expires_at: string | null }
export interface MessageView { id: number; role: "person" | "agent" | "system"; body: string; status: string | null; by: string | null; cost_usd: number | null; at: string; run_id: string | null }
export interface SessionView {
  id: string; /** mold_v0-290: its short human number in its workspace (AGI-001), stored and kept forever. */ ref: string; title: string; phase: AgentPhase; state: HarnessState; reason: string | null; mode: AgentPolicy["mode"]; started_by: string | null; mine: boolean;
  workspace?: { id: number; slug: string | null };
  harness: { flavour: string; label: string; model: string; provider: string; steerable: boolean };
  budget_usd: number; spent_usd: number; remaining_usd: number; ceiling_usd: number; reserve_usd: number;
  wakes: number; crashes: number; web_calls: number; pause_requested: boolean; stop_requested: boolean;
  pending_request: RequestView | null; created_at: string; last_activity_at: string; ended_at: string | null; archived_at: string | null; pruned: boolean;
  can: { message: boolean; pause: boolean; resume: boolean; stop: boolean; decide: boolean; raise: boolean };
  /** mold_v0-287: whether this person may change its budget (and why not), and the least it may be set to (what it has spent). */
  budget_change: { allowed: boolean; why: string | null; floor_usd: number };
  /** mold_v0-261: the agent profile it started with, its name and the version it froze; null for a session from before. */
  profile: { id: string; name: string; version: number } | null;
  /** mold_v0-261: the record it was started from (a record page's start_agent action), or null. */
  record: { area: string; key: string } | null;
}
export interface SessionDetail extends SessionView {
  messages: MessageView[]; requests: RequestView[]; grants: { id: string; from_usd: number; to_usd: number; reason: string; by: string; at: string }[];
  wakes_list: { run_id: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number; end_reason: string | null; error: string | null; input_tokens: number; output_tokens: number }[];
  hooks: { event: HookEvent; source: string; text: string | null }[];
  policy: { max_turns: number; wake_max_minutes: number; park_after_minutes: number; web_tools: string; web_hosts: string[]; web_calls_max: number; tools: string[]; auto_resume: boolean; crash_resumes: number;
    /** mold_v0-261: the files its profile gave its workspace (their paths), and the tools its profile hides. */
    files: string[]; hidden_tools: string[];
    /** mold_v0-267: the uploaded files made executable, and its governance policy in words (null: the platform settings). */
    executables: string[]; governance: string | null;
    /** mold_v0-271: the workspace recipes it started with, each at its frozen version. */
    recipes: { id: string; name: string; version: number }[];
    /** mold_v0-262: the workspace credentials each wake receives (their names, never a value). */
    credentials: string[] };
  /** What it reaches of its workspace (mold_v0-250): null for a session started before (it reaches nothing of it). */
  reach: ReachView | null;
}
export interface ReachView {
  acts_as: { kind: "person" | "key"; name: string | null; role: string | null };
  free: string; named: string[];
  tools: { name: string; title: string | null; read: boolean; asks: boolean }[];
  context: { max_chars: number; parts: { part: string; label: string; chars: number; kept: number }[] };
}
function reachView(p: AgentPolicy | null): ReachView | null {
  const w = p?.workspace;
  if (!w) return null;
  return { acts_as: w.acts_as, free: w.free, named: w.named ?? [],
    tools: (w.tools ?? []).map((t) => ({ name: t.name, title: t.title, read: t.read, asks: !(p!.tools ?? []).includes(workspaceToolName(t.name)) })),
    context: { max_chars: w.context?.max_chars ?? 0, parts: (w.context?.parts ?? []).map((x) => ({ part: x.part, label: x.label, chars: x.chars, kept: x.kept })) } };
}

/** The prefix of a session's short number: the app's (profile.json agent_session_prefix), else the neutral default. */
export const sessionPrefix = () => (PROFILE as { agent_session_prefix?: string }).agent_session_prefix || "AGI";
/** AGI-001, AGI-002 ... AGI-1000: a stored number, so it never moves with a list's order or a removed row. */
export const sessionRef = (n: number) => `${sessionPrefix()}-${String(n).padStart(3, "0")}`;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);
const money = (v: number) => Math.round(v * 1e6) / 1e6;
const tx = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => (await getDb()).transaction(fn));
const read = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => fn(await getDb()));
const SESSION_ID = /^hss_[A-Za-z0-9_-]{8,40}$/;
const REQUEST_ID = /^hsr_[A-Za-z0-9_-]{8,40}$/;
export const MAX_MESSAGE_CHARS = 20_000;
const newId = (p: string) => `${p}_${randomBytes(12).toString("base64url")}`;

function off(): never { throw new PackError("The workspace agent is not on in this app", 404); }
function needOn() { if (!agentHarnessOn()) off(); }

// ---------------------------------------------------------------- the spend ledger (pure)

/**
 * One cumulative report from a wake's harness: what to charge now. `reported` is the harness's running total (a resumed
 * harness session starts it from the total its transcript saved), `baseline` the part of it earlier wakes were already
 * charged for (the lower of the saved figure and what the session was charged, so a turn killed before it reported is
 * billed once and a crash before the save never swallows new work), `high` this wake's high-water mark so far. A
 * replayed or lower report charges nothing and never refunds.
 */
export function accrueSpend(high: number, baseline: number, reported: number): { charge: number; high: number } {
  if (!Number.isFinite(reported) || reported < 0) return { charge: 0, high };
  const effective = Math.max(0, reported - Math.max(0, baseline));
  if (effective <= high) return { charge: 0, high };
  return { charge: money(effective - high), high: money(effective) };
}
/** The baseline a resumed harness session's reports are reduced by: min(saved, charged); the saved figure alone when charged is unknown. */
export const resumedBaseline = (savedUsd: number, chargedUsd: number | null) => (chargedUsd == null ? Math.max(0, savedUsd) : Math.max(0, Math.min(savedUsd, chargedUsd)));

/**
 * The spend a crash's silence most likely cost (the reference's unaccounted window): the wake's own burn rate across the
 * time between its last beat and its end, capped at what it had left. Held back from the next wake, never charged.
 */
export function crashReserve(wakeSpent: number, activeSeconds: number, silentSeconds: number, left: number): number {
  if (!(activeSeconds > 0) || !(silentSeconds > 0) || !(wakeSpent > 0)) return 0;
  return money(Math.max(0, Math.min(left, (wakeSpent / activeSeconds) * silentSeconds)));
}

// ---------------------------------------------------------------- views

const phaseOf = (r: SessionRow): AgentPhase => r.archived_at ? "archived"
  : r.state === "live" ? (r.in_turn ? "working" : "waiting") : r.state === "awaiting" ? "awaiting_approval" : r.state;
const mineOf = (r: SessionRow, a: Actor) => a.kind !== "staff" && a.kind !== "system" && (r.started_by ?? null) === startedByOf(a);
const startedByOf = (a: Actor) => (a.kind === "person" ? a.user : a.kind === "key" ? "account" : null);
const closed = (r: SessionRow) => r.state === "stopped" || r.state === "failed" || !!r.archived_at;
/** Whether an ended session can be continued on its own harness session: nothing was pruned, it has something to resume, and it did not end by its governance policy. */
const resumable = (r: SessionRow) => !r.pruned_at && !!(r.harness_session || r.checkpoint) && !/^(policy|egress_approval_denied|approval_timeout)/.test(r.state_reason ?? "");

function permissions(r: SessionRow, a: Actor) {
  const mine = mineOf(r, a), staff = a.kind === "staff", owner = a.kind === "key" || canAccount(a.role, "manage");
  const open = !closed(r);
  return {
    // The person who started it can always send one (mold_v0-289): held for a pending decision or a working wake, and on an
    // ended session it continues it, which spends as a start does, so an ended one also needs a role that may start sessions.
    message: mine && (open || a.kind === "key" || canAccount(a.role, "launch")),
    pause: open && (mine || owner || staff) && ["starting", "live", "waking", "parked"].includes(r.state) && !r.pause_requested_at,
    resume: open && mine && (r.state === "paused" || r.state === "parked"),
    stop: open && (mine || owner || staff),
    decide: open && (mine || owner),
    raise: open && (staff || a.kind === "key" || canAccount(a.role, "budget")),
  };
}

/** A workspace tool's own title as the session froze it, else its name in words (mold_v0-289: never mcp__app__x or x_y). */
function toolWords(policy: AgentPolicy | null | undefined, name: string): string {
  const own = workspaceToolOf(name) ?? name;
  return policy?.workspace?.tools?.find((t) => t.name === own)?.title?.trim() || (workspaceToolOf(name) ? own.replaceAll("_", " ") : name);
}

function requestView(q: { id: string; kind: RequestKind; subject: string; detail: Record<string, unknown>; status: string; decided_by: string | null; decided_at: Date | null; reason: string | null; created_at: Date }, windowHours: number, policy?: AgentPolicy | null): RequestView {
  return { id: q.id, kind: q.kind, subject: q.subject, subject_title: q.kind === "tool" ? toolWords(policy, q.subject) : q.subject, detail: q.detail ?? {}, status: q.status, decided_by: q.decided_by, decided_at: iso(q.decided_at), reason: q.reason,
    created_at: iso(q.created_at)!, expires_at: q.status === "pending" ? new Date(new Date(q.created_at).getTime() + windowHours * 3600_000).toISOString() : null };
}

function view(r: SessionRow, a: Actor, pending: RequestView | null, slug?: string | null): SessionView {
  const f = flavourOf(r.flavour);
  const budget = num(r.budget_usd), spent = num(r.spent_usd), reserve = num(r.reserve_usd);
  return {
    id: r.id, ref: sessionRef(r.session_number), title: r.title, phase: phaseOf(r), state: r.state, reason: r.state_reason, mode: r.policy?.mode ?? "conversation",
    started_by: r.started_by_name, mine: mineOf(r, a),
    ...(a.kind === "staff" ? { workspace: { id: r.org_id, slug: slug ?? null } } : {}),
    harness: { flavour: r.flavour, label: f?.label ?? r.flavour, model: r.model, provider: r.provider, steerable: f?.holds_stdin_open !== false },
    budget_usd: budget, spent_usd: money(spent), remaining_usd: money(Math.max(0, budget - spent - reserve)), ceiling_usd: ceilingOf(r.policy), reserve_usd: money(reserve),
    wakes: r.wakes, crashes: r.crashes, web_calls: r.web_calls, pause_requested: !!r.pause_requested_at, stop_requested: !!r.stop_requested_at,
    pending_request: pending, created_at: iso(r.created_at)!, last_activity_at: iso(r.last_activity_at)!, ended_at: iso(r.ended_at), archived_at: iso(r.archived_at),
    pruned: !!r.pruned_at, can: permissions(r, a),
    budget_change: { allowed: permissions(r, a).raise, why: closed(r) ? "This session has ended" : permissions(r, a).raise ? null : "Needs the Billing manager or Owner role", floor_usd: money(spent + reserve) },
    profile: r.profile_id && r.profile_version ? { id: r.profile_id, name: r.policy?.profile?.name ?? r.profile_id, version: r.profile_version } : null,
    record: r.record_area && r.record_key ? { area: r.record_area, key: r.record_key } : null,
  };
}

/** A session's budget ceiling: the setting it froze, never above the platform's own ceiling for one run. */
function ceilingOf(p: AgentPolicy | null): number {
  const frozen = Number(p?.budget_ceiling_usd ?? 0) || settingNumber("AGENT_BUDGET_CEILING_USD");
  return Math.min(frozen, platformRunCeiling());
}
let ceilingCache: number | null = null;
function platformRunCeiling(): number {
  if (ceilingCache !== null) return ceilingCache;
  return Number.POSITIVE_INFINITY;
}
/** Loaded once per process (src/rate-limits.ts: the profile and the environment). */
async function loadPlatformCeiling(orgId: number): Promise<number> {
  const { limitsFor, planOf } = await import("./rate-limits.js");
  const c = limitsFor(await planOf(orgId)).runs.budget_usd_max;
  ceilingCache = ceilingCache === null ? c : Math.max(ceilingCache, c);
  return c;
}

async function rowOf(q: Queryable, orgId: number | null, id: string, lock = false): Promise<SessionRow> {
  if (!SESSION_ID.test(String(id))) throw new PackError("no such session", 404);
  const [r] = await q.query<SessionRow>(
    `/* tenant: by session id, within the caller's workspace when it has one (staff: any) */ SELECT ${COLS} FROM harness_sessions
      WHERE id = $1 AND ($2::int IS NULL OR org_id = $2)${lock ? " FOR UPDATE" : ""}`, [String(id), orgId]);
  if (!r) throw new PackError("no such session", 404);
  return r;
}
async function pendingOf(q: Queryable, r: SessionRow): Promise<RequestView | null> {
  const [p] = await q.query<Parameters<typeof requestView>[0]>(
    "SELECT id, kind, subject, detail, status, decided_by, decided_at, reason, created_at FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 AND status = 'pending'",
    [r.org_id, r.id]);
  return p ? requestView(p, r.policy?.approval_window_hours ?? 24, r.policy) : null;
}

async function systemMessage(q: Queryable, r: { id: string; org_id: number }, body: string, runId: string | null = null) {
  await q.query("INSERT INTO harness_session_messages (session_id, org_id, role, body, run_id) VALUES ($1, $2, 'system', $3, $4)", [r.id, r.org_id, body.slice(0, 2000), runId]);
}
async function runEvent(q: Queryable, runId: string | null, orgId: number, type: string, data: Record<string, unknown>) {
  if (!runId) return;
  await q.query(
    `INSERT INTO run_events (run_id, org_id, attempt, type, data) SELECT $1, $2, attempt, $3, $4 FROM runs WHERE id = $1 AND org_id = $2`,
    [runId, orgId, type, JSON.stringify(data)]);
}

/** Recompute a session's spend from its wakes: per wake the greater of the gateway's meter and the harness's accrual. */
async function recomputeSpend(q: Queryable, sessionId: string, orgId: number): Promise<number> {
  const [r] = await q.query<{ spent: string }>(
    `UPDATE harness_sessions s SET spent_usd = coalesce((
        SELECT sum(GREATEST(r.cost_usd, coalesce((SELECT /* tenant: the usage of run r, a row its query scoped */ sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id), 0),
                            coalesce(w.charged_usd, 0)))
          FROM runs r LEFT JOIN harness_wake_spend w ON w.run_id = r.id AND w.org_id = r.org_id
         WHERE r.org_id = s.org_id AND r.harness_session_id = s.id), 0), updated_at = now()
      WHERE s.id = $1 AND s.org_id = $2 RETURNING spent_usd AS spent`, [sessionId, orgId]);
  return num(r?.spent);
}

// ---------------------------------------------------------------- the workspace's side

export interface StartInput { message: unknown; title?: unknown; mode?: unknown; budget_usd?: unknown; profile?: unknown; /** mold_v0-290: drafts of this person and repositories of the workspace's GitHub connection. */ files?: unknown; repositories?: unknown }

/**
 * The most a person may give a session they start (mold_v0-249): the setting's budget; a billing manager, an owner or a
 * key up to the setting's ceiling.
 */
export async function startBudgetMax(orgId: number, actor: Actor): Promise<{ default_usd: number; max_usd: number; ceiling_usd: number }> {
  // mold_v0-267: budgets are the platform's settings, never a profile's.
  const ceiling = Math.min(settingNumber("AGENT_BUDGET_CEILING_USD"), await loadPlatformCeiling(orgId));
  const def = money(Math.min(settingNumber("AGENT_SESSION_BUDGET_USD"), ceiling));
  const raises = actor.kind === "key" || canAccount(actor.role, "budget");
  return { default_usd: def, max_usd: raises ? money(ceiling) : def, ceiling_usd: money(ceiling) };
}

/**
 * Start a session with its first message (the person's words, inside its profile's on_start template). Its agent profile
 * (mold_v0-261: `input.profile`, else the Default) is resolved for this workspace and frozen with its version: who may
 * start it, its instructions, model, budget, ceiling, turns, web, tools and files. `opts.record` (the server's own, from a
 * record page's start_agent action; never from a request's body) links it to that record.
 */
export async function startSession(orgId: number, actor: Actor, input: StartInput, org?: import("./auth.js").Org, opts: { record?: { area: string; key: string }; followOn?: { from: string; context: string } } = {}): Promise<SessionDetail> {
  needOn();
  if (actor.kind === "staff" || actor.kind === "system") throw new PackError("A session acts for the person who starts it: staff cannot start one for a workspace", 403);
  if (actor.kind === "person" && !canAccount(actor.role, "launch")) throw new PackError("Your role cannot start agent sessions. Ask an account owner to change it on the Team page.", 403);
  const message = text(input.message, "message");
  const mode = input.mode === "task" ? "task" : "conversation";
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : message.replace(/\s+/g, " ")).slice(0, 80);
  // Its agent profile, for this workspace (its override): refused when unknown, archived, not this role's, or unpriced.
  const { profileForStart } = await import("./agent-profiles.js");
  const { row: prof, eff } = await profileForStart(typeof input.profile === "string" ? input.profile : null, actor);
  const policy = currentPolicy(mode);
  // mold_v0-267: the profile's five items over the platform's settings (every limit stays the platform's).
  const flavour = flavourOf(eff.harness) ?? flavourOf(policy.flavour)!;
  const workspaceKeys = eff.keys.flatMap((k) => (k.kind === "workspace" ? [k.name] : []));
  const vaultKeys = eff.keys.flatMap((k) => (k.kind === "platform" ? [{ provider: k.provider, label: k.label, env: k.env }] : []));
  // mold_v0-271: the profile's workspace recipes expanded into its uploads at the version in force now (its own files
  // win a path both name), frozen with the session as the uploads are; which versions it used kept beside them.
  const { uploads, recipes } = eff.recipes.length ? await (await import("./recipes.js")).expandRecipes(eff.uploads, eff.recipes) : { uploads: eff.uploads, recipes: [] };
  Object.assign(policy, {
    flavour: flavour.id, model: eff.model, provider: eff.provider, hooks: resolveHooks(flavour, {}),
    profile: { id: prof.id, name: prof.name, version: prof.version },
    ...(eff.key ? { inference_key: eff.key } : {}),
    ...(uploads.length ? { uploads: uploads.map((u) => ({ ...u })) } : {}),
    ...(recipes.length ? { recipes } : {}),
    // mold_v0-262: its profile's workspace credentials, for a session a workspace owner starts (anyone else's: none).
    ...(workspaceKeys.length && actor.kind === "person" && actor.role === "owner" ? { credentials: workspaceKeys } : {}),
    ...(vaultKeys.length ? { vault_keys: vaultKeys } : {}),
    ...(opts.followOn ? { follow_on: opts.followOn } : {}),
  });
  if (eff.governance) {
    // Its governance policy, frozen as the reference freezes a run's (later edits apply to new sessions only); the web
    // fields every runner reads say the same, so its egress proxy opens exactly the hosts it names.
    const g = JSON.parse(JSON.stringify(eff.governance)) as FrozenGovernance;
    policy.governance = g;
    const w = g.web;
    policy.web = { tools: w?.enabled && w.web_fetch_enabled ? (w.web_search_enabled ? "search" : "fetch") : "off",
      hosts: w?.enabled ? w.web_fetch_allowed_domains.filter((d) => d !== "*") : [], calls_max: w?.enabled ? w.max_calls : 0 };
  }
  const limits = await startBudgetMax(orgId, actor);
  let budget = limits.default_usd;
  if (input.budget_usd !== undefined && input.budget_usd !== null && input.budget_usd !== "") {
    const b = Number(input.budget_usd);
    if (!Number.isFinite(b) || b < 0.1) throw new PackError("budget_usd: at least $0.10", 400);
    if (b > limits.max_usd + 1e-9) throw new PackError(limits.max_usd < limits.ceiling_usd
      ? `budget_usd: at most $${limits.max_usd.toFixed(2)} (a billing manager or an owner can give a session up to $${limits.ceiling_usd.toFixed(2)})`
      : `budget_usd: at most $${limits.max_usd.toFixed(2)}`, 400);
    budget = money(b);
  }
  // What it reaches of the workspace (mold_v0-250): the app's own tools as this person, and the workspace's context.
  try {
    const reach = await workspaceReach(orgId, actor, eff.governance?.tools ? { only: eff.governance.tools.allowed } : null);
    policy.workspace = reach;
    for (const t of freeWorkspaceTools(reach.tools, reach.free, reach.named)) policy.tools.push(workspaceToolName(t));
  } catch (e) {
    console.error(`agent session: the workspace's tools could not be listed (${(e as Error).message}): it starts without them`);
  }
  // mold_v0-290: what the person attached, checked before anything is written.
  const fileList = fileIds(input.files);
  const repositories = await checkedRepositories(orgId, policy, repositoryNames(input.repositories), []);
  const id = newId("hss");
  await tx(async (q) => {
    // Its short number: the workspace's counter, taken under that row's lock in the transaction that inserts the session.
    const [n] = await q.query<{ last_number: number }>(
      `INSERT INTO harness_session_counters (org_id, last_number) VALUES ($1, 1)
       ON CONFLICT (org_id) DO UPDATE SET last_number = harness_session_counters.last_number + 1 RETURNING last_number`, [orgId]);
    await q.query(
      `INSERT INTO harness_sessions (id, org_id, title, started_by, started_by_name, state, flavour, model, provider, policy, budget_usd, profile_id, profile_version, record_area, record_key, session_number)
       VALUES ($1, $2, $3, $4, $5, 'starting', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, orgId, title, startedByOf(actor), actor.name, policy.flavour, policy.model, policy.provider, JSON.stringify(policy), budget, prof.id, prof.version,
        opts.record?.area ?? null, opts.record?.key ?? null, n!.last_number]);
    const files = await bindFiles(q, orgId, id, startedByOf(actor)!, fileList);
    await q.query("INSERT INTO harness_session_messages (session_id, org_id, role, body, status, by_user, by_name, attachments) VALUES ($1, $2, 'person', $3, 'pending', $4, $5, $6)",
      [id, orgId, message, actor.user, actor.name, JSON.stringify(attachmentsOf(files, repositories))]);
    if (repositories.length) await systemMessage(q, { id, org_id: orgId }, `${actor.name ?? "Someone"} gave this session read access to ${repositories.join(", ")}.`);
  });
  try { await queueWake(orgId, id, "start", actor, org); }
  catch (e) {
    // Nothing ran: the session goes with the refusal (its run never started), and the caller hears why.
    await tx(async (q) => { await q.query("DELETE FROM harness_sessions WHERE id = $1 AND org_id = $2", [id, orgId]); });
    throw e;
  }
  return readSession(orgId, id, actor);
}

/** What a message carried, as its row keeps it (empty lists left out, so a plain message's is {}). */
const attachmentsOf = (files: MessageAttachments["files"], repositories: string[]): MessageAttachments => ({ ...(files?.length ? { files } : {}), ...(repositories.length ? { repositories } : {}) });

/** Governance has the last word on what cloning needs: a session whose policy cannot reach github.com takes no repository. */
function repositoriesRefused(p: AgentPolicy | null | undefined): string | null {
  const g = p?.governance;
  if (!g) return null;
  return g.web?.enabled && g.web.web_fetch_enabled && domainAllowed("github.com", fetchRules(g)) ? null
    : "This session's governance policy does not allow github.com, so a repository cannot be connected to it. Platform staff can add github.com to the agent profile's web domains.";
}
/**
 * The repositories a message chose, each as the workspace's connection spells it, refused in words: past the limit, under
 * a governance policy that does not allow github.com, or not of this workspace's own GitHub connection.
 */
async function checkedRepositories(orgId: number, policy: AgentPolicy, names: string[], held: readonly string[]): Promise<string[]> {
  if (!names.length) return [];
  const why = repositoriesRefused(policy);
  if (why) throw new PackError(why, 403);
  const { canonicalRepositories } = await import("./github-app.js");
  const canon = [...new Set(await canonicalRepositories(orgId, names))];
  if (new Set([...held, ...canon]).size > COMPOSER_LIMITS.repositories_per_session) throw new PackError(`A session reads at most ${COMPOSER_LIMITS.repositories_per_session} repositories`, 409);
  return canon;
}

const text = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v.trim()) throw new PackError(`${what}: say something`, 400);
  if (v.length > MAX_MESSAGE_CHARS) throw new PackError(`${what}: at most ${MAX_MESSAGE_CHARS} characters`, 413);
  return v.trim();
};

/**
 * Queue a wake: a run of the built-in kind whose budget is what the session has left (the gateway refuses past it). A
 * session with nothing left waits for a raise instead (a budget request).
 */
async function queueWake(orgId: number, sessionId: string, reason: "start" | "message" | "resume" | "approval" | "auto_resume" | "raise", actor: Actor, org?: import("./auth.js").Org): Promise<string | null> {
  const { startRun } = await import("./runs.js");
  // One wake at a time: taken under the session's lock while nothing runs for it (a wake still ending is settled by
  // reconcileWake, which wakes it again for what arrived meanwhile). Undone if the run cannot start.
  const taken = await tx(async (q) => {
    const r = await rowOf(q, orgId, sessionId, true);
    if (r.current_run_id || r.archived_at || !["starting", "parked", "paused", "awaiting"].includes(r.state)) return null;
    const left = money(num(r.budget_usd) - num(r.spent_usd) - num(r.reserve_usd));
    if (left < 0.01) {
      await ensureBudgetRequest(q, r, "the session has spent its budget");
      await q.query("UPDATE harness_sessions SET state = 'awaiting', state_reason = 'budget', updated_at = now() WHERE id = $1 AND org_id = $2", [r.id, orgId]);
      return null;
    }
    await q.query("UPDATE harness_sessions SET state = CASE WHEN wakes = 0 THEN 'starting' ELSE 'waking' END, updated_at = now() WHERE id = $1 AND org_id = $2", [r.id, orgId]);
    return { r, left };
  });
  if (!taken) return null;
  let run;
  try {
    run = await startRun(orgId, AGENT_PACK, AGENT_KIND, { scope: { session: sessionId, reason } }, actor.user ?? actor.name ?? actor.kind,
      org, { kind: agentKind(taken.r.policy), budget_usd: taken.left, harness_session_id: sessionId });
  } catch (e) {
    await tx(async (q) => q.query("UPDATE harness_sessions SET state = $3, updated_at = now() WHERE id = $1 AND org_id = $2 AND current_run_id IS NULL", [sessionId, orgId, taken.r.state]));
    throw e;
  }
  await tx(async (q) => {
    await q.query(
      `UPDATE harness_sessions SET current_run_id = $3, wakes = wakes + 1, in_turn = false, pause_requested_at = NULL, last_activity_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2`, [sessionId, orgId, run.id]);
    await q.query("INSERT INTO harness_wake_spend (run_id, session_id, org_id) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING", [run.id, sessionId, orgId]);
  });
  return run.id;
}

async function ensureBudgetRequest(q: Queryable, r: SessionRow, why: string, runId: string | null = null) {
  const [p] = await q.query<{ id: string; kind: string }>("SELECT id, kind FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 AND status = 'pending'", [r.org_id, r.id]);
  if (p) return;
  await q.query(
    "INSERT INTO harness_session_requests (id, session_id, org_id, run_id, kind, subject, detail) VALUES ($1, $2, $3, $4, 'budget', $5, $6)",
    [newId("hsr"), r.id, r.org_id, runId, `$${num(r.budget_usd).toFixed(2)}`, JSON.stringify({ why, budget_usd: num(r.budget_usd), spent_usd: num(r.spent_usd), ceiling_usd: ceilingOf(r.policy) })]);
}

export async function listSessions(orgId: number | null, actor: Actor, opts: { limit?: number; state?: string } = {}): Promise<SessionView[]> {
  needOn();
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit ?? 200)) || 200, 1), 500);
  return read(async (q) => {
    const rows = await q.query<SessionRow & { slug: string | null }>(
      `/* tenant: the caller's workspace (staff: every workspace) */ SELECT ${COLS.split(",").map((c) => `s.${c.trim()}`).join(", ")}, o.slug
         FROM harness_sessions s JOIN organizations o ON o.id = s.org_id
        WHERE ($1::int IS NULL OR s.org_id = $1) ORDER BY s.last_activity_at DESC, s.id DESC LIMIT $2`, [orgId, limit]);
    const pend = rows.length ? await q.query<Parameters<typeof requestView>[0] & { session_id: string }>(
      `/* tenant: the sessions just listed, by id */ SELECT session_id, id, kind, subject, detail, status, decided_by, decided_at, reason, created_at FROM harness_session_requests
        WHERE session_id = ANY ($1::text[]) AND status = 'pending'`, [rows.map((r) => r.id)]) : [];
    const byS = new Map(pend.map((p) => [p.session_id, p]));
    return rows.map((r) => { const p = byS.get(r.id); return view(r, actor, p ? requestView(p, r.policy?.approval_window_hours ?? 24, r.policy) : null, r.slug); });
  });
}

/**
 * The sessions started from a record (mold_v0-261: a record page's start_agent action), newest first, in the record's
 * workspace: what its page's runs section lists beside its runs. Nothing while the flag is off.
 */
export async function recordSessions(orgId: number, record: { area: string; key: string }, actor: Actor, limit = 5): Promise<{ total: number; sessions: SessionView[] }> {
  if (!agentHarnessOn()) return { total: 0, sessions: [] };
  return read(async (q) => {
    const rows = await q.query<SessionRow>(`SELECT ${COLS} FROM harness_sessions WHERE org_id = $1 AND record_area = $2 AND record_key = $3 ORDER BY created_at DESC, id DESC LIMIT $4`,
      [orgId, record.area, record.key, Math.min(Math.max(Math.trunc(limit) || 5, 1), 50)]);
    const [n] = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM harness_sessions WHERE org_id = $1 AND record_area = $2 AND record_key = $3", [orgId, record.area, record.key]);
    return { total: n?.n ?? rows.length, sessions: rows.map((r) => view(r, actor, null)) };
  });
}

export async function readSession(orgId: number | null, id: string, actor: Actor): Promise<SessionDetail> {
  needOn();
  return read(async (q) => {
    const r = await rowOf(q, orgId, id);
    const [o] = await q.query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [r.org_id]);
    const msgs = await q.query<{ id: string; role: MessageView["role"]; body: string; status: string | null; by_name: string | null; cost_usd: string | null; created_at: Date; run_id: string | null }>(
      "SELECT id, role, body, status, by_name, cost_usd, created_at, run_id FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 ORDER BY id LIMIT 2000", [r.org_id, r.id]);
    const reqs = await q.query<Parameters<typeof requestView>[0]>(
      "SELECT id, kind, subject, detail, status, decided_by, decided_at, reason, created_at FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 ORDER BY created_at", [r.org_id, r.id]);
    const grants = await q.query<{ id: string; from_usd: string; to_usd: string; reason: string; granted_by: string; created_at: Date }>(
      "SELECT id, from_usd, to_usd, reason, granted_by, created_at FROM harness_budget_grants WHERE org_id = $1 AND session_id = $2 ORDER BY created_at", [r.org_id, r.id]);
    const wakes = await q.query<{ id: string; status: string; started_at: Date | null; ended_at: Date | null; cost: string; end_reason: string | null; error: string | null; input_tokens: string; output_tokens: string }>(
      `SELECT r.id, r.status, r.started_at, r.ended_at, GREATEST(r.cost_usd, coalesce(w.charged_usd, 0),
              coalesce((SELECT /* tenant: the usage of run r, a row its query scoped */ sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id), 0)) AS cost, w.end_reason, r.error,
              coalesce((SELECT /* tenant: the usage of run r, a row its query scoped */ sum(g.input_tokens) FROM gateway_usage g WHERE g.run_id = r.id), 0) AS input_tokens,
              coalesce((SELECT /* tenant: the usage of run r, a row its query scoped */ sum(g.output_tokens) FROM gateway_usage g WHERE g.run_id = r.id), 0) AS output_tokens
         FROM runs r LEFT JOIN harness_wake_spend w ON w.run_id = r.id AND w.org_id = r.org_id
        WHERE r.org_id = $1 AND r.harness_session_id = $2 ORDER BY r.created_at`, [r.org_id, r.id]);
    const win = r.policy?.approval_window_hours ?? 24;
    const requests = reqs.map((x) => requestView(x, win, r.policy));
    const p = r.policy;
    return {
      ...view(r, actor, requests.find((x) => x.status === "pending") ?? null, o?.slug ?? null),
      // The ceiling a budget change is held to, this workspace's own (a list shows the one its process last read).
      ceiling_usd: Math.min(ceilingOf(r.policy), await loadPlatformCeiling(r.org_id)),
      messages: msgs.map((m) => ({ id: Number(m.id), role: m.role, body: m.body, status: m.status, by: m.by_name, cost_usd: m.cost_usd === null ? null : num(m.cost_usd), at: iso(m.created_at)!, run_id: m.run_id })),
      requests, grants: grants.map((g) => ({ id: g.id, from_usd: num(g.from_usd), to_usd: num(g.to_usd), reason: g.reason, by: g.granted_by, at: iso(g.created_at)! })),
      wakes_list: wakes.map((w) => ({ run_id: w.id, status: w.status, started_at: iso(w.started_at), ended_at: iso(w.ended_at), cost_usd: money(num(w.cost)), end_reason: w.end_reason, error: w.error, input_tokens: num(w.input_tokens), output_tokens: num(w.output_tokens) })),
      hooks: (p?.hooks ?? []).map((h) => ({ event: h.event, source: h.source, text: h.text })),
      policy: { max_turns: p?.max_turns ?? 0, wake_max_minutes: Math.round((p?.wake_max_seconds ?? 0) / 60), park_after_minutes: Math.round((p?.park_after_seconds ?? 0) / 60),
        web_tools: p?.web?.tools ?? "off", web_hosts: p?.web?.hosts ?? [], web_calls_max: p?.web?.calls_max ?? 0, tools: (p?.tools ?? []).filter((t) => !workspaceToolOf(t)),
        auto_resume: !!p?.auto_resume, crash_resumes: p?.crash_resumes ?? 0, files: [...(p?.files ?? []).map((f) => f.path), ...(p?.uploads ?? []).map((u) => u.path)], hidden_tools: p?.workspace?.hidden ?? [],
        credentials: [...(p?.credentials ?? []), ...(p?.vault_keys ?? []).map((k) => `${k.provider}/${k.label}`)],
        executables: (p?.uploads ?? []).filter((u) => u.executable).map((u) => u.path), recipes: p?.recipes ?? [], governance: p?.governance ? governanceWords(p.governance) : null },
      reach: reachView(p),
    };
  });
}

/** What became of a message: in the running wake or waiting ("queued"), a parked session woken ("waking"), an ended one continued ("continued"), or a new session started from it ("follow_on", with its id). */
export interface MessageAnswer { status: "queued" | "waking" | "continued" | "follow_on"; phase: AgentPhase; session_id?: string }

/**
 * The person who started it sends a message (and nobody else: the agent acts as them), in any state (mold_v0-289). A
 * running wake takes it at its next beat; a parked or paused session wakes; while a decision is pending it waits and the
 * wake the decision causes delivers it (a decline or an expiry wakes it for that message); an ended session is reopened and
 * woken on its own harness session, or, when there is nothing to resume or its governance policy ended it, a follow-on
 * session starts with this conversation as its context.
 */
export async function messageSession(orgId: number, id: string, actor: Actor, body: unknown, org?: import("./auth.js").Org, carried: { files?: unknown; repositories?: unknown } = {}): Promise<MessageAnswer> {
  needOn();
  const message = text(body, "message");
  const first = await read((q) => rowOf(q, orgId, id));
  if (!mineOf(first, actor)) throw new PackError("Only the person who started this session can message it", 403);
  // mold_v0-290: what it carries travels with it, in every state: into the running wake, or waiting with it for the next.
  const fileList = fileIds(carried.files);
  const repositories = await checkedRepositories(orgId, first.policy, repositoryNames(carried.repositories), await read((q) => sessionRepositories(q, orgId, id)));
  // Locked, so two messages racing onto a parked session wake it once: the second finds it waking and waits pending.
  const next = await tx(async (q): Promise<"none" | "wake" | "continued" | "follow_on"> => {
    const x = await rowOf(q, orgId, id, true);
    if (closed(x) && !permissions(x, actor).message) throw new PackError("Your role cannot start agent sessions, so it cannot continue one that has ended", 403);
    if (closed(x) && !resumable(x)) return "follow_on";
    const files = await bindFiles(q, x.org_id, x.id, startedByOf(actor)!, fileList);
    await q.query("INSERT INTO harness_session_messages (session_id, org_id, role, body, status, by_user, by_name, attachments) VALUES ($1, $2, 'person', $3, 'pending', $4, $5, $6)",
      [x.id, x.org_id, message, actor.user, actor.name, JSON.stringify(attachmentsOf(files, repositories))]);
    if (repositories.length) await systemMessage(q, x, `${actor.name ?? "Someone"} gave this session read access to ${repositories.join(", ")}.`);
    await q.query("UPDATE harness_sessions SET last_activity_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id]);
    if (x.current_run_id) await runEvent(q, x.current_run_id, x.org_id, "steer_queued", { length: message.length, by: actor.name });
    if (closed(x)) {
      // Open again: what ended it no longer applies, and its retention starts over when it ends next.
      await q.query(`UPDATE harness_sessions SET state = 'parked', state_reason = 'continued', archived_at = NULL, ended_at = NULL, retention_until = NULL, crashes = 0,
                            pause_requested_at = NULL, stop_requested_at = NULL, updated_at = now() WHERE id = $1 AND org_id = $2`, [x.id, x.org_id]);
      await systemMessage(q, x, `Continued by ${actor.name ?? "someone"}.`);
      return "continued";
    }
    return x.state === "parked" || x.state === "paused" ? "wake" : "none";
  });
  if (next === "follow_on") return followOn(orgId, first, actor, message, org, { files: fileList, repositories });
  if (next === "wake" || next === "continued") {
    const run = await queueWake(orgId, id, "message", actor, org);
    // No wake: it has spent its budget, and the message waits behind the request that was just made for more.
    if (run) return { status: next === "continued" ? "continued" : "waking", phase: "waking" };
  }
  return { status: "queued", phase: phaseOf(await read((q) => rowOf(q, orgId, id))) };
}

/**
 * Whether this person may attach things: to session `sessionId` only as they may message it; before a session exists,
 * as they may start one. Staff never (a session acts for the person who started it).
 */
export async function mayCompose(orgId: number, actor: Actor, sessionId?: string | null): Promise<void> {
  needOn();
  if (actor.kind === "staff" || actor.kind === "system") throw new PackError("Staff cannot message a session: the agent acts as the person who started it", 403);
  if (sessionId) {
    const r = await read((q) => rowOf(q, orgId, sessionId));
    if (!mineOf(r, actor)) throw new PackError("Only the person who started this session can attach files to it", 403);
    if (!permissions(r, actor).message) throw new PackError("Your role cannot continue a session that has ended", 403);
    return;
  }
  if (actor.kind === "person" && !canAccount(actor.role, "launch")) throw new PackError("Your role cannot start agent sessions, so it cannot attach files. Ask an account owner to change it on the Team page.", 403);
}
/** Who a draft file belongs to: the person, or the account for its key. */
export const composerOwner = (a: Actor): string => startedByOf(a) ?? "";

/** What the composer offers this person: attaching files and the workspace's repositories, each with its limits or the reason not. Never a token. */
export async function composerOffer(orgId: number, actor: Actor, sessionId?: string | null) {
  await mayCompose(orgId, actor, sessionId);
  const { repositoryChoice } = await import("./github-app.js");
  const [files, repos, granted, governed] = await Promise.all([filesAvailable(), repositoryChoice(orgId),
    sessionId ? read((q) => sessionRepositories(q, orgId, sessionId)) : Promise.resolve([] as string[]),
    sessionId ? read(async (q) => repositoriesRefused((await rowOf(q, orgId, sessionId)).policy)) : Promise.resolve(null)]);
  return {
    files: { ...files, max_per_message: COMPOSER_LIMITS.files_per_message, max_file_bytes: attachmentMaxBytes() },
    repositories: { ...repos, granted, max_per_message: COMPOSER_LIMITS.repositories_per_message, refused: governed, can_connect: actor.kind === "key" || canAccount(actor.role, "manage") },
  };
}

/** The most of an ended conversation a follow-on session is told, in characters. */
const FOLLOW_ON_CONTEXT_CHARS = 6000;

/** A follow-on session: same person, same agent profile and record, this conversation as its opening context. */
async function followOn(orgId: number, was: SessionRow, actor: Actor, message: string, org?: import("./auth.js").Org, carried: { files?: unknown; repositories?: unknown } = {}): Promise<MessageAnswer> {
  const said = await read((q) => q.query<{ role: MessageView["role"]; body: string }>(
    "SELECT role, body FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role IN ('person', 'agent') ORDER BY id DESC LIMIT 40", [was.org_id, was.id]));
  let room = FOLLOW_ON_CONTEXT_CHARS;
  const lines: string[] = [];
  for (const m of said) {
    if (room <= 0) break;
    const line = `${m.role === "person" ? "The person" : "You"}: ${maskSecrets(m.body).slice(0, room)}`;
    lines.unshift(line);
    room -= line.length;
  }
  const context = lines.length ? `This continues an earlier session, "${was.title}", which has ended. What was said there, oldest first:\n\n${lines.join("\n\n")}` : `This continues an earlier session, "${was.title}", which has ended; its conversation is no longer kept.`;
  const next = await startSession(orgId, actor, { message, title: was.title, mode: was.policy?.mode, profile: was.profile_id ?? undefined, ...carried }, org,
    { record: was.record_area && was.record_key ? { area: was.record_area, key: was.record_key } : undefined, followOn: { from: was.id, context } });
  await tx(async (q) => {
    await systemMessage(q, was, "Continued in a new session: this one could not be resumed.");
    await systemMessage(q, { id: next.id, org_id: was.org_id }, `Continues "${was.title}".`);
    // Told to the follow-on as part of its context: nothing of this session is left waiting to be delivered.
    await q.query("UPDATE harness_session_messages SET status = 'delivered' WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status IN ('pending', 'discarded')", [was.org_id, was.id]);
  });
  return { status: "follow_on", phase: next.phase, session_id: next.id };
}

/** Pause: a running wake stops and keeps its session (resume continues it); a queued one is withdrawn. */
export async function pauseSession(orgId: number | null, id: string, actor: Actor): Promise<SessionView> {
  needOn();
  const r = await read((q) => rowOf(q, orgId, id));
  if (!permissions(r, actor).pause) throw denied(r, actor, "pause");
  const cancelQueued = await tx(async (q) => {
    const x = await rowOf(q, orgId, id, true);
    if (x.state === "parked") {
      await q.query("UPDATE harness_sessions SET state = 'paused', state_reason = 'paused', updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id]);
      await systemMessage(q, x, `Paused by ${actor.name ?? "someone"}.`);
      return null;
    }
    await q.query("UPDATE harness_sessions SET pause_requested_at = coalesce(pause_requested_at, now()), updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id]);
    await revokeToolTokens(q, x.org_id, x.id, "paused");
    await systemMessage(q, x, `Pause asked by ${actor.name ?? "someone"}.`, x.current_run_id);
    if (x.current_run_id) await runEvent(q, x.current_run_id, x.org_id, "pause_requested", { by: actor.name });
    const [run] = x.current_run_id ? await q.query<{ status: string }>("SELECT status FROM runs WHERE id = $1 AND org_id = $2", [x.current_run_id, x.org_id]) : [];
    return run?.status === "queued" ? x.current_run_id : null;
  });
  if (cancelQueued) await withdraw(r.org_id, cancelQueued, actor);
  return (await read(async (q) => view(await rowOf(q, orgId, id), actor, null)));
}

/** A queued wake withdrawn (a pause or a stop before its sandbox started): the run is cancelled and the session settles. */
async function withdraw(orgId: number, runId: string, actor: Actor) {
  const { cancelRun } = await import("./runs.js");
  await cancelRun(orgId, runId, actor.name ?? actor.kind);
  await reconcileWake(runId);
}

export async function resumeSession(orgId: number, id: string, actor: Actor, org?: import("./auth.js").Org): Promise<SessionView> {
  needOn();
  const r = await read((q) => rowOf(q, orgId, id));
  if (!permissions(r, actor).resume) throw denied(r, actor, "resume");
  await tx(async (q) => systemMessage(q, r, `Resumed by ${actor.name ?? "someone"}.`));
  await queueWake(orgId, id, "resume", actor, org);
  return read(async (q) => view(await rowOf(q, orgId, id), actor, null));
}

/** Stop for good: a running wake finishes its turn and ends; anything else ends now. Read only afterwards. */
export async function stopSession(orgId: number | null, id: string, actor: Actor): Promise<SessionView> {
  needOn();
  const r = await read((q) => rowOf(q, orgId, id));
  if (!permissions(r, actor).stop) throw denied(r, actor, "stop");
  const queued = await tx(async (q) => {
    const x = await rowOf(q, orgId, id, true);
    await systemMessage(q, x, `Stopped by ${actor.name ?? "someone"}.`, x.current_run_id);
    if (!x.current_run_id) {
      await endSession(q, x, "stopped", "stopped");
      return null;
    }
    await q.query("UPDATE harness_sessions SET stop_requested_at = coalesce(stop_requested_at, now()), updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id]);
    await revokeToolTokens(q, x.org_id, x.id, "stopped");
    await runEvent(q, x.current_run_id, x.org_id, "stop_requested", { by: actor.name });
    const [run] = await q.query<{ status: string }>("SELECT status FROM runs WHERE id = $1 AND org_id = $2", [x.current_run_id, x.org_id]);
    return run?.status === "queued" ? x.current_run_id : null;
  });
  if (queued) await withdraw(r.org_id, queued, actor);
  return read(async (q) => view(await rowOf(q, orgId, id), actor, null));
}

async function endSession(q: Queryable, x: { id: string; org_id: number; policy?: AgentPolicy }, state: "stopped" | "failed", reason: string) {
  // mold_v0-267: a governance policy may keep the conversation for less than the platform does, never longer.
  const own = x.policy?.governance?.retention_days;
  const days = Math.min(settingNumber("AGENT_RETENTION_DAYS"), own && own > 0 ? own : Number.POSITIVE_INFINITY);
  await q.query(
    `UPDATE harness_sessions SET state = $3, state_reason = $4, in_turn = false, current_run_id = NULL, ended_at = coalesce(ended_at, now()),
            retention_until = coalesce(retention_until, now() + make_interval(days => $5)), pause_requested_at = NULL, stop_requested_at = NULL, updated_at = now()
      WHERE id = $1 AND org_id = $2`, [x.id, x.org_id, state, reason.slice(0, 500), days]);
  await q.query("UPDATE harness_session_requests SET status = 'expired', decided_at = now(), reason = 'the session ended' WHERE org_id = $1 AND session_id = $2 AND status = 'pending'", [x.org_id, x.id]);
  const undelivered = await q.query("SELECT 1 FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status = 'pending' LIMIT 1", [x.org_id, x.id]);
  if (undelivered.length) await systemMessage(q, x, "It ended before reading your last message. Send another and it continues with both.");
  await revokeToolTokens(q, x.org_id, x.id, `the session ${state === "failed" ? "failed" : "ended"}`);
}

function denied(r: SessionRow, a: Actor, what: string) {
  if (closed(r)) return new PackError(`This session has ended: it cannot ${what}`, 409);
  const c = permissions(r, a) as Record<string, boolean>;
  if (c[what] === false && !mineOf(r, a) && a.kind !== "staff") return new PackError(`Only the person who started this session${what === "resume" ? "" : ", an owner or staff"} can ${what} it`, 403);
  return new PackError(`This session cannot ${what} now (it is ${phaseOf(r).replace("_", " ")})`, 409);
}

/**
 * Approve or decline what the session asked for. Approve grants exactly that (a web host, a tool) to this session and
 * wakes it on the same harness session; a budget request is approved by raising the budget (raiseBudget). Decline
 * records the refusal and parks the session: its next wake is told.
 */
export async function decideRequest(orgId: number | null, sessionId: string, requestId: string, actor: Actor, decision: unknown, reason?: unknown, org?: import("./auth.js").Org): Promise<SessionDetail> {
  needOn();
  if (decision !== "approve" && decision !== "decline") throw new PackError("decision: approve or decline", 400);
  if (!REQUEST_ID.test(String(requestId))) throw new PackError("no such request", 404);
  const r = await read((q) => rowOf(q, orgId, sessionId));
  if (!permissions(r, actor).decide && !(actor.kind === "staff")) throw new PackError("Only the person who started this session or an owner can decide what it asked for", 403);
  // mold_v0-267: under a governance policy, egress approvals are a governing decision, as the reference's: deciding one
  // needs the workspace's owner (who governs it), not only the person who started the session (who runs it).
  const governed = !!r.policy?.governance;
  const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  const wake = await tx(async (q): Promise<false | "approval" | "message"> => {
    const x = await rowOf(q, orgId, sessionId, true);
    const [req] = await q.query<{ id: string; kind: RequestKind; subject: string; status: string; created_at: Date }>(
      "SELECT id, kind, subject, status, created_at FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 AND id = $3 FOR UPDATE", [x.org_id, x.id, String(requestId)]);
    if (!req) throw new PackError("no such request", 404);
    if (req.status !== "pending") throw new PackError(`This request was already ${req.status}`, 409);
    if (req.kind === "budget" && decision === "approve") throw new PackError("Approve a budget request with Raise budget (an amount and a reason)", 400);
    if (decision === "approve" && actor.kind === "staff") throw new PackError("Staff may decline a request, not grant a session more than its workspace allows", 403);
    if (governed && req.kind === "web" && actor.kind === "person" && !canAccount(actor.role, "manage"))
      throw new PackError("This session's governance policy has a workspace owner decide where it may reach: ask an owner", 403);
    if (governed && req.kind === "web" && decision === "decline") {
      // The reference's Deny: the session ends with the refused host as its reason, never offered a resume back into it.
      await q.query("UPDATE harness_session_requests SET status = 'declined', decided_by = $3, decided_at = now(), reason = $4 WHERE org_id = $1 AND id = $2", [x.org_id, req.id, actor.name ?? actor.kind, why || null]);
      await systemMessage(q, x, `${actor.name ?? "Someone"} declined ${requestWords(req.kind, req.subject, x.policy)}${why ? `: ${why}` : ""}. The session ended (egress_approval_denied).`);
      if (!x.current_run_id) await endSession(q, x, "failed", `egress_approval_denied: ${req.subject}`);
      else await q.query("UPDATE harness_sessions SET stop_requested_at = coalesce(stop_requested_at, now()), state_reason = $3, updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id, `egress_approval_denied: ${req.subject}`]);
      return false;
    }
    if (decision === "decline") {
      await q.query("UPDATE harness_session_requests SET status = 'declined', decided_by = $3, decided_at = now(), reason = $4 WHERE org_id = $1 AND id = $2", [x.org_id, req.id, actor.name ?? actor.kind, why || null]);
      await systemMessage(q, x, `${actor.name ?? "Someone"} declined ${requestWords(req.kind, req.subject, x.policy)}${why ? `: ${why}` : ""}.`);
      // Its next wake (the person's next message) is told why the request went unanswered.
      await q.query("UPDATE harness_sessions SET state = CASE WHEN state = 'awaiting' THEN 'parked' ELSE state END, state_reason = $3, updated_at = now() WHERE id = $1 AND org_id = $2",
        [x.id, x.org_id, `declined: ${requestWords(req.kind, req.subject, x.policy)}`]);
      // A message queued while it waited (mold_v0-289) is delivered now; the wake still ending, if any, wakes it (reconcileWake).
      return !x.current_run_id && x.state === "awaiting" && await hasWaitingMessage(q, x) ? "message" : false;
    }
    const hiddenTool = req.kind === "tool" ? workspaceToolOf(req.subject) : null;
    if (hiddenTool && (x.policy.workspace?.hidden ?? []).includes(hiddenTool)) throw new PackError(`This session's agent profile does not give it ${hiddenTool}: it cannot be approved`, 403);
    const p = { ...x.policy, web: { ...x.policy.web, hosts: [...(x.policy.web?.hosts ?? [])] }, tools: [...(x.policy.tools ?? [])] };
    if (governed && req.kind === "web") {
      // The reference's Approve: exactly that host, to exactly this session. A website reaches the network too when
      // WebFetch is on (its web allowlist); a package host never does (it only stops the session asking again).
      const g: FrozenGovernance = { ...p.governance!, approved_domains: [...(p.governance!.approved_domains ?? [])], approved_websites: [...(p.governance!.approved_websites ?? [])] };
      const kind = (await q.query<{ detail: Record<string, unknown> }>("SELECT detail FROM harness_session_requests WHERE org_id = $1 AND id = $2", [x.org_id, req.id]))[0]?.detail?.egress;
      if (!g.approved_domains!.includes(req.subject)) g.approved_domains!.push(req.subject);
      if (kind !== "package" && g.web?.enabled && g.web.web_fetch_enabled) {
        if (!g.approved_websites!.includes(req.subject)) g.approved_websites!.push(req.subject);
        if (!hostAllowed(req.subject, p.web.hosts)) p.web.hosts.push(req.subject);
      }
      p.governance = g;
    } else if (req.kind === "web" && !hostAllowed(req.subject, p.web.hosts)) p.web.hosts.push(req.subject);
    if (req.kind === "tool" && !p.tools.includes(req.subject)) p.tools.push(req.subject);
    await q.query("UPDATE harness_session_requests SET status = 'approved', decided_by = $3, decided_at = now(), reason = $4 WHERE org_id = $1 AND id = $2", [x.org_id, req.id, actor.name ?? actor.kind, why || null]);
    await q.query("UPDATE harness_sessions SET policy = $3, state_reason = $4, updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id, JSON.stringify(p), `approved: ${requestWords(req.kind, req.subject, x.policy)}`]);
    await systemMessage(q, x, `${actor.name ?? "Someone"} approved ${requestWords(req.kind, req.subject, x.policy)}.`);
    return x.state === "awaiting" || x.state === "parked" ? "approval" : false;
  });
  if (wake) await queueWake(r.org_id, sessionId, wake, actor, org);
  return readSession(orgId, sessionId, actor);
}
const requestWords = (kind: RequestKind, subject: string, policy?: AgentPolicy | null) => kind === "web" ? `reaching ${subject}` : kind === "tool" ? `using ${toolWords(policy, subject)}` : `more budget (at ${subject})`;
const hasWaitingMessage = async (q: Queryable, r: { id: string; org_id: number }) => (await q.query("SELECT 1 FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status IN ('pending', 'discarded') LIMIT 1", [r.org_id, r.id])).length > 0;

/**
 * Change a session's budget, with a reason (mold_v0-287: raise, or lower it to no less than it has spent; while it works
 * too): up to its ceiling (never above the platform's own ceiling for one run). Recorded as its own grant, from and to, a
 * system message and in the trace. The gateway reads a wake's budget on each request (src/run-limits.ts runSpendRefusal)
 * and the beat reads the session's, so a change reaches a running wake at once: its run's budget moves by the same
 * amount. The harness CLI keeps the allowance it was started with, so one whose budget rose stops at the old allowance
 * and is woken again (wakeEnd). A session waiting on its budget is woken.
 */
export async function raiseBudget(orgId: number | null, id: string, actor: Actor, input: { to_usd?: unknown; by_usd?: unknown; reason?: unknown; raise_only?: boolean }, org?: import("./auth.js").Org): Promise<SessionDetail> {
  needOn();
  const r = await read((q) => rowOf(q, orgId, id));
  const why = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!why) throw new PackError("reason: say why this session needs it (it is kept with the change)", 400);
  const c = permissions(r, actor);
  if (closed(r)) throw new PackError("This session has ended: its budget cannot be changed", 409);
  if (!c.raise) throw new PackError("Changing a budget needs the Billing manager or Owner role", 403);
  const from = num(r.budget_usd);
  const to = input.to_usd !== undefined && input.to_usd !== null ? Number(input.to_usd) : from + Number(input.by_usd);
  if (!Number.isFinite(to)) throw new PackError("to_usd: a number of dollars", 400);
  if (Math.abs(to - from) < 0.005) throw new PackError(`to_usd: a different amount from the budget now ($${from.toFixed(2)})`, 400);
  const raising = to > from;
  if (!raising && input.raise_only) throw new PackError(`to_usd: more than the budget now ($${from.toFixed(2)})`, 400);
  const ceiling = Math.min(ceilingOf(r.policy), await loadPlatformCeiling(r.org_id));
  if (raising && to > ceiling + 1e-9) throw new PackError(`A session's budget can be raised to at most $${ceiling.toFixed(2)}`, 400);
  const floor = num(r.spent_usd) + num(r.reserve_usd);
  if (to < floor - 1e-9 || (raising && to - floor < 0.01)) throw new PackError(raising ? "That raise would leave this session nothing to spend: raise it further"
    : `A budget cannot go below what the session has already spent ($${floor.toFixed(2)})`, 400);
  const wake = await tx(async (q) => {
    const x = await rowOf(q, orgId, id, true);
    if (Math.abs(num(x.budget_usd) - from) > 1e-9) throw new PackError("The budget changed meanwhile: look again", 409);
    const liveFloor = num(x.spent_usd) + num(x.reserve_usd);
    if (to < liveFloor - 1e-9) throw new PackError(`A budget cannot go below what the session has already spent ($${liveFloor.toFixed(2)})`, 400);
    await q.query("INSERT INTO harness_budget_grants (id, session_id, org_id, from_usd, to_usd, reason, granted_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [newId("hsg"), x.id, x.org_id, from, money(to), why.slice(0, 500), actor.name ?? actor.kind]);
    await q.query("UPDATE harness_sessions SET budget_usd = $3, updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id, money(to)]);
    // A wake already queued or running: its own budget moves by the same amount, for the gateway's next request (and the
    // allowance a queued wake's harness is started with). Never below a positive amount: the gateway refuses when spent reaches it.
    if (x.current_run_id) await q.query("UPDATE runs SET budget_usd = GREATEST(budget_usd + $3, 0.000001) WHERE id = $1 AND org_id = $2 AND status IN ('queued', 'running')", [x.current_run_id, x.org_id, money(to - from)]);
    const [req] = raising ? await q.query<{ id: string }>(
      "UPDATE harness_session_requests SET status = 'approved', decided_by = $3, decided_at = now(), reason = $4 WHERE org_id = $1 AND session_id = $2 AND status = 'pending' AND kind = 'budget' RETURNING id",
      [x.org_id, x.id, actor.name ?? actor.kind, why.slice(0, 500)]) : [];
    await systemMessage(q, x, `${actor.name ?? "Someone"} ${raising ? "raised" : "lowered"} the budget from $${from.toFixed(2)} to $${to.toFixed(2)}: ${why.slice(0, 300)}`);
    if (req) await q.query("UPDATE harness_sessions SET state = 'parked', state_reason = 'budget raised' WHERE id = $1 AND org_id = $2 AND state = 'awaiting'", [x.id, x.org_id]);
    return !!req;
  });
  if (wake) await queueWake(r.org_id, id, "raise", actor, org);
  return readSession(orgId, id, actor);
}

/**
 * One read of a session's trace (mold_v0-287): the run events and messages since `cursor` (light form: a tool's whole
 * arguments are read one step at a time), the marks, what a start waits on, and the state a person sees change.
 */
export interface TraceAnswer { steps: TraceStep[]; marks: TraceStep[]; cursor: string; more: boolean; waiting_on: string | null; phase: AgentPhase; spent_usd: number; budget_usd: number }
const TRACE_PAGE = 500;

/** "<event id>:<message id>", what the last read reached; the zero cursor for the first. */
const parseCursor = (raw: unknown): { events: number; messages: number } => {
  const [e, m] = String(raw ?? "").split(":");
  return { events: Math.max(0, Math.trunc(Number(e) || 0)), messages: Math.max(0, Math.trunc(Number(m) || 0)) };
};

/** The session's own wakes, each with its number. */
async function traceWakes(q: Queryable, r: SessionRow) {
  const wakes = await q.query<TraceWakeRow & { harness_session_id: string }>(
    "SELECT id, status, created_at, started_at, ended_at, error, scope FROM runs WHERE org_id = $1 AND harness_session_id = $2 ORDER BY created_at", [r.org_id, r.id]);
  return { wakes, ids: wakes.map((w) => w.id), wakeIndex: new Map(wakes.map((w, i) => [w.id, i + 1])) };
}

/**
 * Everything the session has done, in order (src/harness-trace.ts): the events and messages after `cursor` (so a live
 * session is read incrementally: the stream below sends only what is new), up to one page, and the marks, always whole. A
 * message still being delivered is resent until it settles, so its status changes in place.
 */
export async function sessionTrace(orgId: number | null, id: string, actor: Actor, cursor?: unknown): Promise<TraceAnswer> {
  needOn();
  return read(async (q) => {
    const r = await rowOf(q, orgId, id);
    const { wakes, ids, wakeIndex } = await traceWakes(q, r);
    const facts = { phase: phaseOf(r), spent_usd: money(num(r.spent_usd)), budget_usd: num(r.budget_usd) };
    if (r.pruned_at) return { steps: [], marks: [], cursor: "0:0", more: false, waiting_on: null, ...facts };
    const since = parseCursor(cursor);
    const events = ids.length ? await q.query<TraceEventRow>(
      "SELECT id, run_id, attempt, type, at, data - 'input' - 'result' AS data FROM run_events WHERE org_id = $1 AND run_id = ANY ($2::text[]) AND id > $3 ORDER BY id LIMIT $4",
      [r.org_id, ids, since.events, TRACE_PAGE + 1]) : [];
    const msgs = await q.query<TraceMessageRow>(
      "SELECT id, role, body, status, by_name, created_at, run_id, attachments FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND (id > $3 OR status IN ('pending', 'delivered')) ORDER BY id LIMIT $4",
      [r.org_id, r.id, since.messages, TRACE_PAGE + 1]);
    const more = events.length > TRACE_PAGE || msgs.length > TRACE_PAGE;
    const page = events.slice(0, TRACE_PAGE), msgPage = msgs.slice(0, TRACE_PAGE);
    const sandboxes = ids.length ? await q.query<TraceSandboxRow>(
      "/* tenant: the sandboxes of the session's own wakes, listed above */ SELECT run_id, attempt, state, sandbox_id, created_at, ready_at, claimed_at, deleted_at, launch_step, launch_error, reap_reason FROM run_sandboxes WHERE run_id = ANY ($1::text[]) ORDER BY id", [ids]) : [];
    const requests = await q.query<TraceRequestRow>(
      "SELECT id, kind, subject, status, decided_by, decided_at, reason, created_at, detail FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 ORDER BY created_at", [r.org_id, r.id]);
    const grants = await q.query<{ id: string; from_usd: string; to_usd: string; reason: string; granted_by: string; created_at: Date }>(
      "SELECT id, from_usd, to_usd, reason, granted_by, created_at FROM harness_budget_grants WHERE org_id = $1 AND session_id = $2 ORDER BY created_at", [r.org_id, r.id]);
    const toolTitle = (name: string) => toolWords(r.policy, name);
    const marks = traceMarks({ wakes, sandboxes, requests, grants: grants.map((g) => ({ id: g.id, from_usd: num(g.from_usd), to_usd: num(g.to_usd), reason: g.reason, by: g.granted_by, at: g.created_at })), wakeIndex, toolTitle });
    const current = wakes.find((w) => w.id === r.current_run_id) ?? null;
    const sandbox = current ? [...sandboxes].reverse().find((s) => s.run_id === current.id) ?? null : null;
    const [waited] = current ? await q.query<{ reason: string | null }>("SELECT data->>'reason' AS reason FROM run_events WHERE org_id = $1 AND run_id = $2 AND type = 'waiting' ORDER BY id DESC LIMIT 1", [r.org_id, current.id]) : [];
    const [startedEv] = current ? await q.query("SELECT 1 FROM run_events WHERE org_id = $1 AND run_id = $2 AND type = 'agent_wake' LIMIT 1", [r.org_id, current.id]) : [];
    const nextEvent = page.length ? Number(page.at(-1)!.id) : since.events;
    const nextMsg = Math.max(since.messages, ...msgPage.map((m) => Number(m.id)));
    return { steps: [...traceSteps(page, wakeIndex, toolTitle), ...msgPage.map((m) => messageStep(m, wakeIndex))], marks, cursor: `${nextEvent}:${nextMsg}`, more,
      waiting_on: waitingOn({ phase: phaseOf(r), run: current, sandbox, waiting: waited?.reason ?? null, started: !!startedEv }), ...facts };
  });
}

/** One step's full detail (its event's whole data, arguments and result included), when it is opened. */
export async function sessionTraceStep(orgId: number | null, id: string, actor: Actor, stepId: string): Promise<{ step: { id: string; type: string; at: string; data: unknown } }> {
  needOn();
  return read(async (q) => {
    const r = await rowOf(q, orgId, id);
    const { ids } = await traceWakes(q, r);
    if (!ids.length) throw new PackError("no such step", 404);
    const tool = /^tool:(.{1,200})$/.exec(stepId)?.[1];
    const event = /^e(\d{1,20})$/.exec(stepId)?.[1];
    if (!tool && !event) throw new PackError("no such step", 404);
    const rows = await q.query<{ id: string; type: string; at: Date; data: Record<string, unknown> | null }>(
      tool ? "SELECT id, type, at, data FROM run_events WHERE org_id = $1 AND run_id = ANY ($2::text[]) AND type IN ('agent_tool_call', 'agent_tool_result') AND data->>'id' = $3 ORDER BY id LIMIT 2"
        : "SELECT id, type, at, data FROM run_events WHERE org_id = $1 AND run_id = ANY ($2::text[]) AND id = $3 LIMIT 1",
      [r.org_id, ids, tool ?? event]);
    if (!rows.length) throw new PackError("no such step", 404);
    const mask = (v: unknown): unknown => { const m = maskSecrets(JSON.stringify(v ?? {})); try { return JSON.parse(m); } catch { return m; } };
    return { step: { id: stepId, type: rows[0]!.type, at: new Date(rows[0]!.at).toISOString(), data: Object.fromEntries(rows.map((x) => [x.type, mask(x.data)])) } };
  });
}

// ---------------------------------------------------------------- the wake's side (the runner, with the run's lease)

interface WakeRun { id: string; org_id: number; status: string; session: SessionRow }
async function wakeOf(q: Queryable, runId: string, leaseToken: string, lock = false): Promise<WakeRun> {
  // The run's lease, checked on this query's own connection (as src/runs.ts leased does): only its current attempt's holder.
  const [run] = await q.query<{ id: string; org_id: number; harness_session_id: string | null }>(
    "/* tenant: the leased run, by id and its lease */ SELECT id, org_id, harness_session_id FROM runs WHERE id = $1 AND lease_token_hash = $2 AND status = 'running'",
    [String(runId), createHash("sha256").update(String(leaseToken)).digest("hex")]);
  if (!run) { const { RunLeaseError } = await import("./runs.js"); throw new RunLeaseError(); }
  const x = run;
  if (!x?.harness_session_id) throw new PackError("this run is not an agent session's wake", 400);
  const s = await rowOf(q, run.org_id, x.harness_session_id, lock);
  if (s.current_run_id !== run.id) throw new PackError("this wake is no longer its session's", 409);
  return { id: run.id, org_id: run.org_id, status: "running", session: s };
}

export interface WakeStart {
  session_id: string; title: string; policy: AgentPolicy; resume: string | null; checkpoint: Pick<Checkpoint, "seq" | "sha256" | "bytes"> | null;
  /** What the session was charged for its harness's reports before this wake (the baseline's other half). */
  charged_usd: number; budget_usd: number;
  /** The wake's first turn: the person's messages waiting (each with the uuid the harness echoes), or the on_resume text. */
  first: { id: number; uuid: string; text: string }[]; preface: string | null; web_calls: number;
  /** The workspace's own tools for this wake (mold_v0-250): the MCP server's name and this wake's token; null when it reaches none. */
  workspace: { server: string; token: string; expires_at: string } | null;
  /** mold_v0-267: the files its profile uploads into the workspace, each in parts the wake fetches with its lease. */
  uploads: { id: string; path: string; bytes: number; sha256: string; executable: boolean; parts: number }[];
  /** mold_v0-290: the repositories its messages chose, copied read-only into its working directory by its runner. */
  repositories: string[];
}

/** The wake started: what it is told (its policy, the session to resume, the first turn), its messages marked delivered. */
export async function wakeStart(runId: string, leaseToken: string): Promise<WakeStart> {
  return tx(async (q) => {
    const w = await wakeOf(q, runId, leaseToken, true);
    const s = w.session;
    const msgs = await q.query<{ id: string; body: string; attachments: MessageAttachments | null }>(
      "SELECT id, body, attachments FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status IN ('pending', 'discarded') ORDER BY id LIMIT 50", [s.org_id, s.id]);
    // mold_v0-261: a new session's first message is its profile's on_start template around the person's words (the
    // transcript keeps their own words; what the harness was told is in its hooks directory).
    const onStart = !s.harness_session && s.wakes <= 1 ? s.policy.hooks?.find((h) => h.event === "on_start" && h.source !== "unset")?.text ?? null : null;
    const first = [];
    for (const [i, m] of msgs.entries()) {
      const uuid = randomUUID();
      await q.query("UPDATE harness_session_messages SET status = 'delivered', uuid = $3, run_id = $4, delivered_at = now() WHERE org_id = $1 AND id = $2", [s.org_id, m.id, uuid, w.id]);
      // mold_v0-290: the person's own words stay as they wrote them in the transcript; the agent is told what came with them.
      first.push({ id: Number(m.id), uuid, text: `${i === 0 && onStart ? applyOnStart(onStart, m.body) : m.body}${attachmentNote(m.attachments)}` });
    }
    // Why it talks again, when the person did not say (a resume, an approval, a crash): the on_resume hook and the reason.
    const why = s.state_reason && /^(approved|declined|expired|budget raised|crashed)/.test(s.state_reason) ? `(${s.state_reason})` : null;
    const resumeHook = s.policy.hooks?.find((h) => h.event === "on_resume")?.text ?? null;
    // mold_v0-289: a follow-on session is told the conversation it continues, ahead of its first message.
    const preface = s.wakes > 1 ? [why, first.length ? null : resumeHook].filter(Boolean).join(" ") || null : s.policy.follow_on?.context ?? null;
    const [charged] = await q.query<{ c: string }>("SELECT coalesce(sum(charged_usd), 0) AS c FROM harness_wake_spend WHERE org_id = $1 AND session_id = $2 AND run_id <> $3", [s.org_id, s.id, w.id]);
    const [run] = await q.query<{ budget_usd: string; deadline_at: Date | null }>("SELECT budget_usd, deadline_at FROM runs WHERE id = $1 AND org_id = $2", [w.id, s.org_id]);
    // This wake's token for the workspace's tools: good until its run's deadline, revoked when the wake ends.
    let workspace: WakeStart["workspace"] = null;
    if (s.policy.workspace) {
      const until = run?.deadline_at ? new Date(run.deadline_at) : new Date(Date.now() + (s.policy.wake_max_seconds + 900) * 1000);
      await revokeToolTokens(q, s.org_id, s.id, "a newer wake started");
      workspace = { server: s.policy.workspace.server, token: await mintToolToken(q, s, w.id, until), expires_at: until.toISOString() };
    }
    await q.query("UPDATE harness_sessions SET state = 'live', in_turn = true, last_activity_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2", [s.id, s.org_id]);
    await runEvent(q, w.id, s.org_id, "agent_wake", { session: s.id, resume: !!s.harness_session, messages: first.length, checkpoint: s.checkpoint?.seq ?? null });
    return { session_id: s.id, title: s.title, policy: s.policy, resume: s.harness_session, checkpoint: s.checkpoint ? { seq: s.checkpoint.seq, sha256: s.checkpoint.sha256, bytes: s.checkpoint.bytes } : null,
      charged_usd: money(num(charged?.c)), budget_usd: num(run?.budget_usd), first, preface, web_calls: s.web_calls, workspace,
      uploads: [...(s.policy.uploads ?? []).map((u) => ({ ...u, parts: uploadParts(u.bytes) })), ...await sessionUploads(q, s.org_id, s.id)], repositories: await sessionRepositories(q, s.org_id, s.id) };
  });
}

/**
 * One part of a file the wake's session froze from its profile (mold_v0-267): only an upload its own policy names, only
 * with the run's lease. Read from the object store, never sealed per workspace (it is the platform's, given to sessions).
 */
export async function wakeUploadPart(runId: string, leaseToken: string, uploadId: string, part: number): Promise<Buffer> {
  const s = await read(async (q) => (await wakeOf(q, runId, leaseToken)).session);
  // mold_v0-290: a file a message of this session carried (sealed under the workspace's key; one part).
  if (isSessionFile(uploadId)) { if (part !== 0) throw new PackError("part: 0", 400); return sessionFileBytes(s.org_id, s.id, uploadId); }
  if (!(s.policy.uploads ?? []).some((u) => u.id === uploadId)) throw new PackError("this session was given no such file", 404);
  const { readUploadPart } = await import("./agent-profiles.js");
  return readUploadPart(uploadId, part);
}

/**
 * mold_v0-290: for a wake's runner alone (its lease): a short-lived read-only token for exactly the repositories its
 * session's messages chose (src/github-app.ts sessionRepositoryGrant), and each one's last commit. Never in an answer to a
 * browser or in the transcript; everything the run writes is redacted of it. `only` narrows it to a steer's repositories.
 */
export async function wakeRepositories(runId: string, leaseToken: string, only?: unknown): Promise<import("./github-app.js").SessionRepositoryGrant> {
  const w = await read((q) => wakeOf(q, runId, leaseToken));
  const all = await read((q) => sessionRepositories(q, w.org_id, w.session.id));
  const wanted = Array.isArray(only) ? all.filter((n) => only.includes(n)) : all;
  const { sessionRepositoryGrant } = await import("./github-app.js");
  const refused = repositoriesRefused(w.session.policy);
  if (refused) return { token: null, expires_at: null, repositories: [], missing: wanted.map((full_name) => ({ full_name, why: "its governance policy does not allow github.com" })) };
  return sessionRepositoryGrant({ runId: w.id, orgId: w.org_id, names: wanted });
}

/**
 * mold_v0-271 (flag workspace_recipes): the agent's proposed next version of a recipe its session started with, as its
 * wake sends it when it ends (src/agent-harness.ts: the bundle of `.recipe-proposal/<recipe>/`: note.md, remove.txt and
 * files/<path>; `executable` the paths under files/ that were executable there). Kept as an approval request staff decide
 * (src/recipes.ts proposeRecipeVersion), against the version the session froze.
 */
export async function wakeRecipeProposal(runId: string, leaseToken: string, recipeId: string, bundle: Buffer, executable: readonly string[]): Promise<{ proposal: string }> {
  const { recipesOn, proposeRecipeVersion } = await import("./recipes.js");
  if (!recipesOn()) throw new PackError("Workspace recipes are not on in this app", 404);
  const w = await read((q) => wakeOf(q, runId, leaseToken));
  const used = (w.session.policy.recipes ?? []).find((r) => r.id === recipeId);
  if (!used) throw new PackError("this session did not start with that recipe: it may propose a version only of a recipe it used", 404);
  const { readBundle } = await import("./workspace-bundle.js");
  const { files } = readBundle(bundle);
  const text = (p: string) => files.find((f) => f.path === p)?.body.toString("utf8") ?? "";
  const removed = text("remove.txt").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
  const changed = files.filter((f) => f.path.startsWith("files/")).map((f) => ({ path: f.path.slice(6), data: f.body, executable: executable.includes(f.path.slice(6)) }));
  const p = await proposeRecipeVersion({ org_id: w.org_id, session_id: w.session.id, run_id: w.id, recipe: { id: used.id, version: used.version } }, { note: text("note.md"), removed, files: changed });
  return { proposal: p.id };
}

export interface BeatInput {
  in_turn?: boolean; total_cost_usd?: number | null; baseline_usd?: number | null; session_id?: string | null; web_calls?: number;
  /** Messages the harness was handed but could not write (its stdin was gone): carried to the next wake. */
  discarded?: number[];
}
export interface BeatAnswer { cancel: boolean; reason: string | null; steer: { id: number; uuid: string; text: string; /** mold_v0-290: to deliver before it is written. */ uploads?: WakeStart["uploads"]; repositories?: string[] }[]; pause: boolean; end: boolean; budget: boolean; interval_seconds: number }

/** A wake's heartbeat: its lease renewed, its spend accrued, and the person's messages, pause and end handed over. */
export async function wakeBeat(runId: string, leaseToken: string, b: BeatInput): Promise<BeatAnswer> {
  const { heartbeatRun } = await import("./runs.js");
  const hb = await heartbeatRun(runId, leaseToken);
  return tx(async (q) => {
    const w = await wakeOf(q, runId, leaseToken, true);
    const s = w.session;
    // The spend: the harness's cumulative report, over this wake's high-water mark, from its baseline (set once).
    const [ws] = await q.query<{ baseline_usd: string; reported_usd: string; charged_usd: string }>(
      `INSERT INTO harness_wake_spend (run_id, session_id, org_id, baseline_usd) VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO UPDATE SET updated_at = now() RETURNING baseline_usd, reported_usd, charged_usd`, [w.id, s.id, s.org_id, Math.max(0, Number(b.baseline_usd ?? 0)) || 0]);
    let baseline = num(ws!.baseline_usd);
    if (baseline === 0 && Number(b.baseline_usd) > 0) {
      baseline = Number(b.baseline_usd);
      await q.query("UPDATE harness_wake_spend SET baseline_usd = $3 WHERE run_id = $1 AND org_id = $2 AND baseline_usd = 0 AND reported_usd = 0", [w.id, s.org_id, baseline]);
    }
    if (typeof b.total_cost_usd === "number") {
      const a = accrueSpend(num(ws!.reported_usd), baseline, b.total_cost_usd);
      if (a.charge > 0) await q.query("UPDATE harness_wake_spend SET reported_usd = $3, charged_usd = charged_usd + $4, updated_at = now() WHERE run_id = $1 AND org_id = $2",
        [w.id, s.org_id, a.high, a.charge]);
    }
    const spent = await recomputeSpend(q, s.id, s.org_id);
    for (const id of (b.discarded ?? []).filter((x) => Number.isSafeInteger(x)).slice(0, 100))
      await q.query("UPDATE harness_session_messages SET status = 'discarded' WHERE org_id = $1 AND session_id = $2 AND id = $3 AND status = 'delivered'", [s.org_id, s.id, id]);
    const sid = typeof b.session_id === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(b.session_id) ? b.session_id : null;
    await q.query(
      `UPDATE harness_sessions SET in_turn = $3, harness_session = coalesce($4, harness_session), web_calls = GREATEST(web_calls, $5),
              last_activity_at = CASE WHEN $3 THEN now() ELSE last_activity_at END, updated_at = now() WHERE id = $1 AND org_id = $2`,
      [s.id, s.org_id, b.in_turn === true, sid, Math.max(0, Math.trunc(Number(b.web_calls ?? 0)) || 0)]);
    // The person's messages waiting, handed over now (a flavour with no live stdin gets none: they wait for its next wake).
    const steer: BeatAnswer["steer"] = [];
    if (flavourOf(s.flavour)?.holds_stdin_open !== false && !s.pause_requested_at && !s.stop_requested_at) {
      const msgs = await q.query<{ id: string; body: string; attachments: MessageAttachments | null }>(
        "SELECT id, body, attachments FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status = 'pending' ORDER BY id LIMIT 20", [s.org_id, s.id]);
      for (const m of msgs) {
        const uuid = randomUUID();
        await q.query("UPDATE harness_session_messages SET status = 'delivered', uuid = $3, run_id = $4, delivered_at = now() WHERE org_id = $1 AND id = $2", [s.org_id, m.id, uuid, w.id]);
        const files = m.attachments?.files ?? [], repositories = m.attachments?.repositories ?? [];
        steer.push({ id: Number(m.id), uuid, text: `${m.body}${attachmentNote(m.attachments)}`,
          ...(files.length ? { uploads: files.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, sha256: f.sha256, executable: false, parts: 1 })) } : {}),
          ...(repositories.length ? { repositories } : {}) });
      }
      if (steer.length) await runEvent(q, w.id, s.org_id, "steer_delivered", { count: steer.length });
    }
    const pending = await q.query("SELECT 1 FROM harness_session_messages WHERE org_id = $1 AND session_id = $2 AND role = 'person' AND status = 'pending' LIMIT 1", [s.org_id, s.id]);
    if (spent >= num(s.budget_usd) - 1e-9) await revokeToolTokens(q, s.org_id, s.id, "budget", w.id);
    return { cancel: hb.cancel, reason: hb.reason, steer, pause: !!s.pause_requested_at, end: !!s.stop_requested_at, budget: spent >= num(s.budget_usd) - 1e-9,
      // Quicker while a person is talking to it, so a message arrives in seconds.
      interval_seconds: pending.length || b.in_turn ? 3 : 10 };
  });
}

/** One finished turn of the agent: its words for the person; the messages it answered are marked so. */
export async function wakeTurn(runId: string, leaseToken: string, t: { text?: unknown; cost_usd?: unknown; answered?: unknown }): Promise<{ id: number }> {
  const body = typeof t.text === "string" ? t.text.slice(0, MAX_MESSAGE_CHARS) : "";
  return tx(async (q) => {
    const w = await wakeOf(q, runId, leaseToken, true);
    const s = w.session;
    const [m] = await q.query<{ id: string }>("INSERT INTO harness_session_messages (session_id, org_id, role, body, run_id, cost_usd) VALUES ($1, $2, 'agent', $3, $4, $5) RETURNING id",
      [s.id, s.org_id, body || "(no words: the agent only worked with its tools this turn)", w.id, Number.isFinite(Number(t.cost_usd)) ? Number(t.cost_usd) : null]);
    // The messages the harness saw the CLI take in (echoed) are answered by this turn; without echoes, every one delivered before it.
    const ids = Array.isArray(t.answered) ? (t.answered as unknown[]).filter((x): x is number => Number.isSafeInteger(x)).slice(0, 100) : null;
    if (ids) await q.query("UPDATE harness_session_messages SET status = 'answered' WHERE org_id = $1 AND session_id = $2 AND status = 'delivered' AND id = ANY ($3::bigint[])", [s.org_id, s.id, ids]);
    else await q.query("UPDATE harness_session_messages SET status = 'answered' WHERE org_id = $1 AND session_id = $2 AND status = 'delivered' AND id < $3", [s.org_id, s.id, m!.id]);
    await q.query("UPDATE harness_sessions SET in_turn = false, last_activity_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2", [s.id, s.org_id]);
    return { id: Number(m!.id) };
  });
}

/** The agent asked for something its policy does not allow (a web host, a tool): a pending request; the wake then stops. */
export async function wakeRequest(runId: string, leaseToken: string, r: { kind?: unknown; subject?: unknown; detail?: unknown }): Promise<{ id: string }> {
  const kind = r.kind;
  if (kind !== "web" && kind !== "tool") throw new PackError("kind: web or tool", 400);
  const subject = typeof r.subject === "string" ? r.subject.trim().toLowerCase().slice(0, 200) : "";
  if (kind === "web" && !validHost(subject)) throw new PackError("subject: a host name", 400);
  if (kind === "tool" && !/^[a-z][a-z0-9_.:-]{0,99}$/i.test(String(r.subject ?? ""))) throw new PackError("subject: a tool name", 400);
  const raw = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? JSON.stringify(r.detail) : "{}";
  const detail = raw.length <= 4000 ? JSON.parse(raw) : { note: "the request's details were too long to keep" };
  return tx(async (q) => {
    const w = await wakeOf(q, runId, leaseToken, true);
    const s = w.session;
    // mold_v0-261: a tool its profile hides is never asked for (the harness does not; a request for one is refused).
    const own = kind === "tool" ? workspaceToolOf(String(r.subject).trim()) : null;
    if (own && (s.policy.workspace?.hidden ?? []).includes(own)) throw new PackError(`This session's agent profile does not give it ${own}: it cannot be asked for`, 400);
    const [p] = await q.query<{ id: string }>("SELECT id FROM harness_session_requests WHERE org_id = $1 AND session_id = $2 AND status = 'pending'", [s.org_id, s.id]);
    if (p) return { id: p.id };
    const id = newId("hsr");
    await q.query("INSERT INTO harness_session_requests (id, session_id, org_id, run_id, kind, subject, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, s.id, s.org_id, w.id, kind, kind === "tool" ? String(r.subject).trim() : subject, JSON.stringify(detail)]);
    await systemMessage(q, s, `The agent asks to ${kind === "web" ? `reach ${subject}` : `use ${toolWords(s.policy, String(r.subject).trim())}`}.`, w.id);
    await runEvent(q, w.id, s.org_id, "agent_request", { kind, subject: kind === "tool" ? String(r.subject).trim() : subject });
    return { id };
  });
}

/** How the wake ends, as the harness saw it (before it completes its run): the session's next state. */
export async function wakeEnd(runId: string, leaseToken: string, e: { reason?: unknown; detail?: unknown }): Promise<{ state: HarnessState }> {
  const reasons: EndReason[] = ["parked", "paused", "awaiting", "budget", "stopped", "done", "web_limit", "policy", "failed"];
  const reason = reasons.includes(e.reason as EndReason) ? (e.reason as EndReason) : "failed";
  const detail = typeof e.detail === "string" ? e.detail.slice(0, 300) : null;
  return tx(async (q) => {
    const w = await wakeOf(q, runId, leaseToken, true);
    const s = w.session;
    await q.query("UPDATE harness_wake_spend SET end_reason = $3, updated_at = now() WHERE run_id = $1 AND org_id = $2", [w.id, s.org_id, detail ? `${reason}: ${detail}` : reason]);
    await revokeToolTokens(q, s.org_id, s.id, reason === "awaiting" ? "awaiting a decision" : reason, w.id);
    await runEvent(q, w.id, s.org_id, "agent_end", { reason, detail });
    let state: HarnessState = s.state;
    if (reason === "budget") {
      // mold_v0-287: raised while it worked: the CLI stopped at the allowance it was told, but the budget has moved. It parks
      // and is woken again at once (reconcileWake's next: "budget raised"); nobody is asked for what they already gave.
      const [g] = await q.query("/* tenant: within the session's workspace */ SELECT 1 FROM harness_budget_grants g JOIN runs r ON r.id = $3 AND r.org_id = g.org_id WHERE g.org_id = $1 AND g.session_id = $2 AND g.to_usd > g.from_usd AND g.created_at >= coalesce(r.started_at, r.created_at) LIMIT 1", [s.org_id, s.id, w.id]);
      const raised = !!g && num(s.budget_usd) - num(s.spent_usd) - num(s.reserve_usd) >= 0.01;
      if (raised) { await q.query("UPDATE harness_sessions SET state = 'parked', state_reason = 'budget raised', in_turn = false, updated_at = now() WHERE id = $1 AND org_id = $2", [s.id, s.org_id]); return { state: "parked" as HarnessState }; }
      await ensureBudgetRequest(q, s, "the session reached its budget", w.id); state = "awaiting";
    }
    else if (reason === "awaiting") state = (await pendingOf(q, s)) ? "awaiting" : "parked";
    else if (reason === "parked" || reason === "web_limit") state = "parked";
    else if (reason === "paused") state = "paused";
    else if (reason === "stopped" || reason === "done") state = "stopped";
    else if (reason === "policy") state = "failed";
    if (state !== s.state) await q.query("UPDATE harness_sessions SET state = $3, state_reason = $4, in_turn = false, updated_at = now() WHERE id = $1 AND org_id = $2",
      [s.id, s.org_id, state, reason === "web_limit" ? "web calls used up" : detail ?? reason]);
    return { state };
  });
}

/** The hosts a wake's egress allows besides the gateway: its session's web hosts, when its web tools are on (src/runs.ts claimRun). */
export async function wakeEgressHosts(runId: string): Promise<string[]> {
  const [r] = await read((q) => q.query<{ policy: AgentPolicy }>(
    "/* tenant: the claimed run's own session, by run id */ SELECT s.policy FROM runs r JOIN harness_sessions s ON s.id = r.harness_session_id AND s.org_id = r.org_id WHERE r.id = $1", [runId]));
  // mold_v0-267: under a governance policy, its named WebFetch hosts, the websites approved and its exceptions in force.
  if (r?.policy?.governance) return governedEgressHosts(r.policy.governance).filter(validHost);
  if (!r || (r.policy?.web?.tools ?? "off") === "off") return [];
  return (r.policy.web.hosts ?? []).map((h) => h.replace(/^\*\./, "")).filter(validHost);
}

// ---------------------------------------------------------------- checkpoints

const checkpointKey = (orgId: number, sessionId: string, seq: number) => `workspaces/org-${orgId}/.agent/${sessionId}/${seq}.wse`;
const aad = (sessionId: string, seq: number) => `harness-checkpoint:${sessionId}:${seq}`;

/** A wake's checkpoint (its harness session and working files, a workspace bundle): sealed, stored, the pointer moved forward. */
export async function wakeCheckpoint(runId: string, leaseToken: string, seq: number, body: Buffer, sha256: string): Promise<{ seq: number; stored: boolean }> {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new PackError("seq: a positive whole number", 400);
  if (createHash("sha256").update(body).digest("hex") !== sha256) throw new PackError("the checkpoint is not what its sha256 says", 400);
  const s = await read(async (q) => (await wakeOf(q, runId, leaseToken)).session);
  if (seq <= s.checkpoint_seq) return { seq: s.checkpoint_seq, stored: false }; // a redelivery: the pointer only moves forward
  const { objectStore } = await import("./storage.js");
  const { sealBytes } = await import("./orgcrypto.js");
  const store = await objectStore();
  const key = checkpointKey(s.org_id, s.id, seq);
  await store.put(key, await sealBytes(s.org_id, body, aad(s.id, seq)), "application/octet-stream");
  const old = await tx(async (q) => {
    const x = (await wakeOf(q, runId, leaseToken, true)).session;
    if (seq <= x.checkpoint_seq) return key; // another checkpoint got there first: this one goes
    const cp: Checkpoint = { seq, key, sha256, bytes: body.length, at: new Date().toISOString(), run_id: runId };
    await q.query("UPDATE harness_sessions SET checkpoint = $3, checkpoint_seq = $4, updated_at = now() WHERE id = $1 AND org_id = $2", [x.id, x.org_id, JSON.stringify(cp), seq]);
    await runEvent(q, runId, x.org_id, "agent_checkpoint", { seq, bytes: body.length });
    return x.checkpoint?.key ?? null;
  });
  if (old) await store.remove([old]).catch(() => {});
  return { seq, stored: true };
}

/** The session's last checkpoint for a wake to continue from (null: none). */
export async function wakeCheckpointBody(runId: string, leaseToken: string): Promise<{ body: Buffer; seq: number; sha256: string } | null> {
  const s = await read(async (q) => (await wakeOf(q, runId, leaseToken)).session);
  if (!s.checkpoint) return null;
  const { objectStore } = await import("./storage.js");
  const { openBytes } = await import("./orgcrypto.js");
  const sealed = await (await objectStore()).get(s.checkpoint.key);
  if (!sealed) return null;
  const body = await openBytes(s.org_id, sealed, aad(s.id, s.checkpoint.seq));
  if (createHash("sha256").update(body).digest("hex") !== s.checkpoint.sha256) throw new PackError("the session's checkpoint does not match its sha256", 500);
  return { body, seq: s.checkpoint.seq, sha256: s.checkpoint.sha256 };
}

// ---------------------------------------------------------------- after a wake's run ends

/**
 * A wake's run ended (completed, failed, cancelled, or its lease lapsed): the session settles. What the harness said
 * (wakeEnd) stands; a wake that ended without saying is a crash: the session parks with its last checkpoint, its
 * unanswered messages pending again, and resumes on the next message (or by itself, AGENT_AUTO_RESUME) within its
 * crash limits. Idempotent: called from completeRun, sweepRuns and the sweep.
 */
export async function reconcileWake(runId: string): Promise<void> {
  if (!agentHarnessOn()) return;
  const auto = await tx(async (q) => {
    const [run] = await q.query<{ id: string; org_id: number; status: string; error_kind: string | null; error: string | null; harness_session_id: string | null;
      started_at: Date | null; heartbeat_at: Date | null; ended_at: Date | null }>(
      "/* tenant: the ended run, by id */ SELECT id, org_id, status, error_kind, error, harness_session_id, started_at, heartbeat_at, ended_at FROM runs WHERE id = $1", [runId]);
    if (!run?.harness_session_id || !["succeeded", "failed", "cancelled"].includes(run.status)) return null;
    const s = await rowOf(q, run.org_id, run.harness_session_id, true);
    await revokeToolTokens(q, s.org_id, s.id, "the wake ended", run.id);
    const spent = await recomputeSpend(q, s.id, s.org_id);
    if (s.current_run_id !== run.id) return null;
    const [w] = await q.query<{ end_reason: string | null; charged_usd: string }>("SELECT end_reason, charged_usd FROM harness_wake_spend WHERE run_id = $1 AND org_id = $2", [run.id, s.org_id]);
    const said = w?.end_reason?.split(":")[0] as EndReason | undefined;
    const clear = "current_run_id = NULL, in_turn = false, pause_requested_at = NULL, updated_at = now()";
    // mold_v0-267: refused by its governance policy, or an egress request declined under it: the session ends, failed.
    if (said === "policy" || /^egress_approval_denied/.test(s.state_reason ?? "")) {
      await endSession(q, s, "failed", said === "policy" ? (w!.end_reason ?? "policy").slice(0, 300) : s.state_reason!);
      return null;
    }
    if (s.stop_requested_at || said === "stopped" || said === "done") { await endSession(q, s, "stopped", said === "done" ? "done" : "stopped"); return null; }
    // What arrived while the wake was ending wakes it again: a message (a parked session), or a decision made meanwhile.
    const next = async (state: HarnessState) => {
      if (state === "parked") {
        if (await hasWaitingMessage(q, s)) return { org: s.org_id, id: s.id, reason: "message" as const };
        if (/^(approved|budget raised)/.test(s.state_reason ?? "") && !(await pendingOf(q, s))) return { org: s.org_id, id: s.id, reason: "approval" as const };
      }
      return null;
    };
    if (run.status === "cancelled") {
      const state: HarnessState = s.pause_requested_at ? "paused" : "parked";
      await q.query(`UPDATE harness_sessions SET state = $3, state_reason = $4, ${clear} WHERE id = $1 AND org_id = $2`, [s.id, s.org_id, state, s.pause_requested_at ? "paused" : "withdrawn"]);
      return null;
    }
    if (said && said !== "failed") {
      // The harness settled it (parked, paused, awaiting, budget): a clean wake ends a crash streak.
      let state: HarnessState = s.pause_requested_at && said !== "awaiting" && said !== "budget" ? "paused"
        : s.state === "live" || s.state === "waking" || s.state === "starting" ? "parked" : s.state;
      // Awaiting a request decided while the wake was still ending: parked, and woken if it was approved.
      if (state === "awaiting" && !(await pendingOf(q, s))) state = "parked";
      await q.query(`UPDATE harness_sessions SET state = $3, crashes = 0, ${clear} WHERE id = $1 AND org_id = $2`, [s.id, s.org_id, state]);
      return next(state);
    }
    // A crash: the wake ended without saying how (its runner stopped heartbeating, its deadline, the harness failed).
    const wakeSpent = Math.max(num(w?.charged_usd), await (async () => {
      const [g] = await q.query<{ c: string }>("/* tenant: the ended run's usage, by run id */ SELECT coalesce(sum(cost_usd), 0) AS c FROM gateway_usage WHERE run_id = $1", [run.id]);
      return num(g?.c);
    })());
    const active = run.started_at && run.heartbeat_at ? (new Date(run.heartbeat_at).getTime() - new Date(run.started_at).getTime()) / 1000 : 0;
    const silent = run.heartbeat_at && run.ended_at ? (new Date(run.ended_at).getTime() - new Date(run.heartbeat_at).getTime()) / 1000 : 0;
    const left = Math.max(0, num(s.budget_usd) - spent - num(s.reserve_usd));
    const reserve = run.error_kind === "infrastructure" ? crashReserve(wakeSpent, active, silent, left) : 0;
    const crashes = s.crashes + 1;
    // What the dead wake was handed and never answered is asked again by the next.
    const carried = await q.query("UPDATE harness_session_messages SET status = 'pending' WHERE org_id = $1 AND session_id = $2 AND run_id = $3 AND status IN ('delivered', 'discarded') RETURNING id", [s.org_id, s.id, run.id]);
    const why = `the wake stopped unexpectedly (${run.error_kind ?? "error"}${run.error ? `: ${run.error.slice(0, 160)}` : ""})`;
    await runEvent(q, run.id, s.org_id, "agent_crashed", { crashes, reserve_usd: reserve, wake_spent_usd: money(wakeSpent), carried: carried.length, checkpoint: s.checkpoint?.seq ?? null });
    if (crashes > (s.policy.crash_resumes ?? 3)) {
      await endSession(q, s, "failed", `crashed ${crashes} times in a row: ${why}`);
      await systemMessage(q, s, `The session failed: ${why}, ${crashes} times in a row.`, run.id);
      return null;
    }
    await q.query(`UPDATE harness_sessions SET state = 'parked', state_reason = $3, crashes = $4, crash_spent_usd = crash_spent_usd + $5, reserve_usd = reserve_usd + $6, ${clear}
                    WHERE id = $1 AND org_id = $2`, [s.id, s.org_id, `crashed: ${why}`, crashes, money(wakeSpent), reserve]);
    await systemMessage(q, s, `The session stopped unexpectedly: ${why}. ${s.policy.auto_resume ? "It continues by itself where its last checkpoint left it." : "Send a message to continue where its last checkpoint left it."}`, run.id);
    const crashSpent = num(s.crash_spent_usd) + wakeSpent;
    // Automatic resume: the platform's switch, a session with something to resume, and crashes under half its budget.
    if (s.policy.auto_resume && (s.harness_session || s.checkpoint) && crashSpent < num(s.budget_usd) / 2) return { org: s.org_id, id: s.id, reason: "auto_resume" as const };
    return null;
  });
  if (auto) {
    if (auto.reason === "auto_resume") {
      // Spending a workspace's budget without anyone asking is never quiet: the staff console's audit log says so.
      const { log } = await import("./admin.js");
      log("system", "agent.auto_resume", null, { session: auto.id, org: auto.org });
    }
    await queueWake(auto.org, auto.id, auto.reason, { kind: "system", user: null, name: "the platform", role: null }).catch((e) =>
      console.error(`agent session ${auto.id}: ${auto.reason === "auto_resume" ? "automatic resume" : "wake"} refused: ${(e as Error).message}`));
  }
}

// ---------------------------------------------------------------- the sweep (src/schedules.ts schedulerTick)

export interface HarnessSweep { expired: number; archived: number; pruned: number; settled: number }
/** Requests past their window expire, quiet sessions are archived, ended ones past retention are pruned; bounded batches. */
export async function sweepHarnessSessions(now = new Date()): Promise<HarnessSweep> {
  if (!agentHarnessOn()) return { expired: 0, archived: 0, pruned: 0, settled: 0 };
  const out: HarnessSweep = { expired: 0, archived: 0, pruned: 0, settled: 0 };
  // 1. Wakes whose run ended and nothing settled the session (a run failed before it was launched, a lost completion).
  const loose = await read((q) => q.query<{ current_run_id: string }>(
    `/* tenant: platform sweep across workspaces, by run id */ SELECT s.current_run_id FROM harness_sessions s JOIN runs r ON r.id = s.current_run_id AND r.org_id = s.org_id
      WHERE r.status IN ('succeeded', 'failed', 'cancelled') LIMIT 200`));
  for (const l of loose) { await reconcileWake(l.current_run_id); out.settled++; }
  // 2. Requests nobody answered within the session's window: expired, the session parked with that said.
  const toWake: { org: number; id: string }[] = [];
  out.expired = await tx(async (q) => {
    const rows = await q.query<{ id: string; session_id: string; org_id: number; kind: RequestKind; subject: string }>(
      `/* tenant: platform sweep across workspaces */ UPDATE harness_session_requests x SET status = 'expired', decided_at = $1, reason = 'nobody answered in time'
        FROM harness_sessions s WHERE x.session_id = s.id AND x.org_id = s.org_id AND x.status = 'pending'
          AND x.created_at < $1::timestamptz - make_interval(hours => coalesce((s.policy->>'approval_window_hours')::int, 24))
        RETURNING x.id, x.session_id, x.org_id, x.kind, x.subject`, [now]);
    for (const r of rows) {
      // mold_v0-267: under a governance policy a request left past its window closes the session (approval_timeout).
      const [gs] = await q.query<SessionRow>(`SELECT ${COLS} FROM harness_sessions WHERE id = $1 AND org_id = $2`, [r.session_id, r.org_id]);
      if (gs?.policy?.governance && r.kind === "web" && gs.state === "awaiting" && !gs.current_run_id) {
        await endSession(q, gs, "failed", `approval_timeout: ${r.subject}`);
        await systemMessage(q, { id: r.session_id, org_id: r.org_id }, `Nobody answered the request for ${requestWords(r.kind, r.subject, gs.policy)} in time: the session ended (approval_timeout).`);
        continue;
      }
      await q.query("UPDATE harness_sessions SET state = 'parked', state_reason = $3, updated_at = now() WHERE id = $1 AND org_id = $2 AND state = 'awaiting'",
        [r.session_id, r.org_id, `expired: ${requestWords(r.kind, r.subject, gs?.policy)}`]);
      await systemMessage(q, { id: r.session_id, org_id: r.org_id }, `Nobody answered the request for ${requestWords(r.kind, r.subject, gs?.policy)} in time: it expired.`);
      // A message queued while it waited (mold_v0-289) is delivered now.
      if (gs?.state === "awaiting" && !gs.current_run_id && await hasWaitingMessage(q, { id: r.session_id, org_id: r.org_id })) toWake.push({ org: r.org_id, id: r.session_id });
    }
    return rows.length;
  });
  for (const w of toWake) await queueWake(w.org, w.id, "message", { kind: "system", user: null, name: "the platform", role: null }).catch((e) =>
    console.error(`agent session ${w.id}: wake refused: ${(e as Error).message}`));
  // 3. Sessions quiet for AGENT_ARCHIVE_AFTER_DAYS: archived (read only), retention counted from now.
  out.archived = await tx(async (q) => (await q.query(
    `/* tenant: platform sweep across workspaces */ UPDATE harness_sessions SET archived_at = $1, retention_until = coalesce(retention_until, $1::timestamptz + make_interval(days => LEAST($3, coalesce(NULLIF((policy->'governance'->>'retention_days')::int, 0), $3)))), updated_at = now()
      WHERE id IN (SELECT id FROM harness_sessions WHERE archived_at IS NULL AND current_run_id IS NULL AND state IN ('parked', 'paused', 'awaiting', 'stopped', 'failed')
                     AND last_activity_at < $1::timestamptz - make_interval(days => $2) ORDER BY last_activity_at LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING id`,
    [now, settingNumber("AGENT_ARCHIVE_AFTER_DAYS"), settingNumber("AGENT_RETENTION_DAYS")])).length);
  // 4. Past retention: the conversation, its requests and checkpoint go; its spend, wakes and budget raises stay.
  const due = await read((q) => q.query<{ id: string; org_id: number; checkpoint: Checkpoint | null }>(
    `/* tenant: platform sweep across workspaces */ SELECT id, org_id, checkpoint FROM harness_sessions WHERE pruned_at IS NULL AND retention_until < $1 AND current_run_id IS NULL
      ORDER BY retention_until LIMIT 100`, [now]));
  if (due.length) {
    const keys: string[] = [];
    for (const d of due) await tx(async (q) => {
      await q.query("DELETE FROM harness_session_messages WHERE org_id = $1 AND session_id = $2", [d.org_id, d.id]);
      await q.query("DELETE FROM harness_session_requests WHERE org_id = $1 AND session_id = $2", [d.org_id, d.id]);
      // mold_v0-287: the trace's content (tool arguments and results, model errors) goes with the conversation it records.
      await q.query("/* tenant: the pruned session's own wakes, within its workspace */ DELETE FROM run_events e USING runs r WHERE e.run_id = r.id AND e.org_id = r.org_id AND r.org_id = $1 AND r.harness_session_id = $2 AND e.type = ANY ($3::text[])", [d.org_id, d.id, TRACE_CONTENT_EVENTS]);
      await q.query("UPDATE harness_sessions SET pruned_at = $3, checkpoint = NULL, harness_session = NULL, archived_at = coalesce(archived_at, $3), updated_at = now() WHERE id = $1 AND org_id = $2",
        [d.id, d.org_id, now]);
      if (d.checkpoint?.key) keys.push(d.checkpoint.key);
      out.pruned++;
    });
    if (keys.length) await (await import("./storage.js")).objectStore().then((st) => st.remove(keys)).catch((e) => console.error(`agent sessions: checkpoints not removed: ${(e as Error).message}`));
  }
  // mold_v0-290: the pruned sessions' attached files, and drafts nobody sent within a day.
  await sweepAttachments(now, due).catch((e) => console.error(`agent sessions: attached files not removed: ${(e as Error).message}`));
  // 5. Tool tokens a day past their expiry, and those of pruned sessions (mold_v0-250).
  await tx((q) => sweepToolTokens(q, now));
  return out;
}

/** The actor of a customer request: the signed-in person (with their role), or an account key. */
export function actorOf(s: { user: string | null; email: string | null; accountRole: AccountRole | null } | null, key = false): Actor {
  if (!s || key || !s.user) return { kind: "key", user: null, name: s?.email ?? "an account key", role: null };
  return { kind: "person", user: s.user, name: s.email, role: s.accountRole };
}
export const staffActor = (who: string): Actor => ({ kind: "staff", user: null, name: who, role: null });
