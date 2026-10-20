/**
 * Why a session or an orchestrator failed, in one place: the Compute page, Health and traces all group failures by
 * these classes, so a reason means the same thing everywhere. Pure functions over stored rows (no database access);
 * callers pass what they already selected. Unit tests: `npx tsx scripts/error-classes-test.ts`.
 */

/** The admin page that fixes a class of failure. */
export type FixPage = "key_vault" | "harness_mix" | "environment";
export const FIX_LINKS: Record<FixPage, { label: string; href: string }> = {
  key_vault: { label: "Key vault", href: "/admin/keys" },
  harness_mix: { label: "Harness mix", href: "/admin/agents" },
  // Session time and turn caps are environment knobs (MAX_SESSION_MINUTES, GIVE_UP_RUNS…), shown read only there.
  environment: { label: "the deployment environment (see Compute › Environment)", href: "/admin/compute#environment" },
};

export type SessionErrorKey =
  | "unclaimable" | "credentials" | "harness_install" | "gateway_token" | "boat_permission" | "boat_capacity"
  | "sandbox_boot" | "sandbox_prepare" | "heartbeat" | "time_cap" | "shutdown" | "agent" | "other";

export interface ErrorClass<K extends string = string> { key: K; label: string; fix: FixPage | null }

/** The fields of an `agent_sessions` row the classifier reads. */
export interface SessionLike {
  status: string;
  agent_id?: string | null;
  error_message?: string | null;
  completed_reason?: string | null;
  metadata?: { infra_error?: unknown } | null;
}

// Message rules, first match wins. Heartbeat comes before the time cap: a session that lost its heartbeat is often
// also marked timed out later, and the heartbeat is the real cause.
const SESSION_RULES: { key: SessionErrorKey; label: string; fix: FixPage | null; re: RegExp }[] = [
  // `/credentials -> 503` is how rows from before the 424 fix read (the broker answered a missing key with a 503).
  { key: "credentials", label: "Missing provider key", fix: "key_vault",
    re: /missing_credential|No vault provider supplies|No .+ credential in the vault|\/credentials -> 503/ },
  { key: "harness_install", label: "Harness install failed", fix: "harness_mix", re: /^harness \S+ not available/m },
  { key: "gateway_token", label: "Gateway token expired", fix: null, re: /Gateway token is invalid, expired or revoked/ },
  { key: "boat_permission", label: "boat key not allowed", fix: "key_vault", re: /api_key_action_forbidden|not allowed to create sandboxes/ },
  { key: "boat_capacity", label: "boat rate limit or capacity", fix: null, re: /rate_limited|limit_reached|no_ready_machine|\b429\b/ },
  { key: "sandbox_boot", label: "Sandbox not ready", fix: null, re: /not ready after \d+s/ },
  { key: "sandbox_prepare", label: "Sandbox setup failed", fix: null, re: /sandbox prepare failed|egress lockdown failed/ },
  { key: "heartbeat", label: "Lost heartbeat", fix: null, re: /No heartbeat for/ },
  { key: "time_cap", label: "Hit time limit", fix: "environment", re: /Exceeded MAX_SESSION_MINUTES/ },
  { key: "shutdown", label: "Worker shut down", fix: null, re: /Worker shut down/ },
];
const AGENT_STOPPED = new Set(["agent_gave_up", "turn_cap", "time_cap", "error"]);

const cls = <K extends string>(key: K, label: string, fix: FixPage | null): ErrorClass<K> => ({ key, label, fix });

/**
 * The class of a session's failure, or null when there is nothing to explain (a finished, running or claimable
 * session). `scheduled` is the set of agent ids the current population schedules: a queued session whose agent is
 * not in it will never be claimed. Without it, queued sessions are not judged.
 */
export function classifySession(row: SessionLike, opts: { scheduled?: ReadonlySet<string> } = {}): ErrorClass<SessionErrorKey> | null {
  if (row.status === "queued" && opts.scheduled && row.agent_id && !opts.scheduled.has(row.agent_id))
    return cls("unclaimable", "Agent not scheduled", "harness_mix");
  const infra = row.metadata?.infra_error;
  const text = [row.error_message, typeof infra === "string" ? infra : null].filter(Boolean).join("\n");
  const stopped = !!row.completed_reason && AGENT_STOPPED.has(row.completed_reason);
  // A requeued session keeps its last infrastructure error in metadata; it is waiting, not failed.
  if (!["failed", "timeout"].includes(row.status) && !stopped) return null;
  for (const r of SESSION_RULES) if (r.re.test(text)) return cls(r.key, r.label, r.fix);
  if (row.status === "timeout") return cls("time_cap", "Hit time limit", "environment");
  if (stopped) return cls("agent", "Agent stopped", "environment");
  return cls("other", "Other", null);
}

/** Launch steps, as `lib.launchOrchestrator` prefixes its errors ("ready (240s): ..."). */
export const LAUNCH_ERROR = /^(create|name|ready|code upload|configure|preflight|start) \(\d+s\): ?([\s\S]*)$/;

export type ReapKind =
  | "stale" | "stuck_booting" | "ttl" | "idle_drain" | "job_drain" | "retired" | "job_ended" | "sandbox_gone" | "never_created" | "other";

// Reap reasons as src/autoscaler.ts writes them, with ids and numbers inside.
const REAP_RULES: { kind: ReapKind; label: string; re: RegExp }[] = [
  { kind: "never_created", label: "Never created", re: /^launch never created a sandbox/ },
  { kind: "sandbox_gone", label: "Sandbox gone", re: /^sandbox (is |gone)/ },
  { kind: "job_drain", label: "Job drain", re: /^drained \(job / },
  { kind: "idle_drain", label: "Idle drain", re: /^drained \(idle/ },
  { kind: "ttl", label: "TTL", re: /^TTL / },
  { kind: "stuck_booting", label: "Stuck booting", re: /^stuck booting/ },
  { kind: "retired", label: "Retired", re: /^retired/ },
  { kind: "job_ended", label: "Job ended", re: /^job \S+ is / },
  { kind: "stale", label: "Stale", re: /^stale/ },
];
/** Reaps that are the autoscaler doing its job, not failures: shown muted and counted apart. */
export const ROUTINE_REAPS: ReadonlySet<ReapKind> = new Set(["idle_drain", "job_drain", "retired", "job_ended"]);

export interface OrchestratorLike {
  launch_step?: string | null;
  launch_error?: string | null;
  reap_reason?: string | null;
  /** Legacy mixed column: a launch error or a reap reason. Read when the split columns are empty. */
  error?: string | null;
  ready_at?: Date | string | null;
}

export interface OrchestratorClass {
  /** `launch:<step>` or `reap:<kind>`. */
  key: string;
  label: string;
  routine: boolean;
  /** The launch error or the reap reason as written. */
  message: string;
}

/** The normalized reap kind of a reap reason. */
export function reapKind(reason: string): { kind: ReapKind; label: string } {
  const r = REAP_RULES.find((x) => x.re.test(reason));
  return r ? { kind: r.kind, label: r.label } : { kind: "other", label: "Other" };
}

/** Why an orchestrator ended: a failed launch step, or the reap reason. Null while it is live and nothing went wrong. */
export function classifyOrchestrator(row: OrchestratorLike): OrchestratorClass | null {
  let step = row.launch_step ?? null, launchError = row.launch_error ?? null, reap = row.reap_reason ?? null;
  if (!step && !reap && row.error) {
    const m = !row.ready_at ? LAUNCH_ERROR.exec(row.error) : null;
    if (m) { step = m[1]; launchError = m[2]; } else reap = row.error;
  }
  if (step) return { key: `launch:${step}`, label: `Launch failed at ${step}`, routine: false, message: launchError ?? "" };
  if (!reap) return null;
  const { kind, label } = reapKind(reap);
  return { key: `reap:${kind}`, label, routine: ROUTINE_REAPS.has(kind), message: reap };
}
