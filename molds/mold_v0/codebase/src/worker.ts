import { open as openText, openJson } from "./orgcrypto.js";
import { getDb } from "./db.js";
import { orgEvent } from "./telemetry.js";
import { reportSessionSpend, reportSimulationUsage } from "./billing.js";
import { checkBudgetLater } from "./email.js";
import { normalize, transcripts, type RawEvent, type SessionRef, type StoredEvent } from "./transcripts.js";
import { findAgent } from "./agents.js";
import { languageOf, resolveEnvironment, type PersonaEnvironment, type SessionEnvironment } from "../orchestrator/core/environment.js";
import { SCENARIO_ROWS } from "./session-engine.js";
import { sessionEngine } from "./host-tables.js";
import { hosts } from "./host.js";
import { revokeSessionTokens, sessionGatewayUsage } from "./gateway.js";
import { ENV } from "./env-names.js";

/**
 * The orchestrator's side: agent_sessions rows are the job queue.
 *   claim     queued -> running (FOR UPDATE SKIP LOCKED, so many orchestrator replicas can pull safely)
 *   append    raw JSONL events for a running session (also counts as a heartbeat)
 *   complete  running -> completed / failed / timeout, then a host pack scores the transcript (src/host.ts sessions.score)
 *   sweep     sessions whose heartbeat is older than the lease are completed as `timeout`
 * A job carries the task and the developer profile the orchestrator role-plays when the sub-agent asks a question
 * (plus org/product ids so an orchestrator may write events straight to ClickHouse). Nothing in it names the
 * customer's product: the sub-agent and the simulated developer must both be blind.
 * Its tables are a host pack's (mold_v0-049): in a build without them nothing is queued, so a claim finds nothing and
 * a session id names no session.
 */

const LEASE_MINUTES = () => Number(ENV.APP_LEASE_MINUTES ?? 30);
const MAX_USER_TURNS = () => Number(ENV.APP_MAX_USER_TURNS ?? 5);
/** A product or competitor as the claim's blindness check reads it (the products table; its row's words). */
interface NamedTool { name: string; aliases?: string[]; packages?: string[]; domains?: string[] }
/** Event type an orchestrator uses when the simulated developer answers the sub-agent. */
export const SIMULATED_USER = "simulated_user";
const FINAL = ["completed", "failed", "timeout", "cancelled"];

export interface Job {
  session_id: string; simulation_id: string; org_id: number; product_id: number; model: string; harness: string; attempt: number;
  agent_id: string | null;
  /**
   * The session's registry agent spec. Orchestrators add it to their registry view (orchestrator/fleet/plan.ts
   * rememberAgents), which is how they learn harnesses added on /admin/agents (not in their registry.json copy).
   */
  agent: { id: string; harness: string; model: string; label: string; harness_version?: string; event_format?: string; image?: { docker?: string; boat_snapshot?: string };
           requires_env?: string[]; cli?: string; worker_adapter?: string; boat_preinstalled?: boolean; resume?: boolean; origin?: string; base_agent?: string } | null;
  prompt: string; repo_url: string | null; language: string | null; max_user_turns: number;
  /** How the agent works (sql/migrations/0001_baseline.sql exec_mode): plan first and implement once approved, or execute directly. */
  exec_mode: "plan" | "direct";
  /** Starter workspace hint + scenario tags/title (the orchestrator picks a template when repo_url is null). */
  template: string | null; tags: string[]; title: string;
  /** A private run (the org's own tasks or personas): the orchestrator locks down the agent's network (core/egress.ts). */
  private: boolean;
  profile: { slug: string; name: string; summary: string; attributes: Record<string, unknown>; instructions: string } | null;
  /**
   * The persona's developer environment for this session: its editor's language servers for the task's language plus
   * its CLI tools, minus any that would name the product or a competitor. null with APP_DEV_ENV=off.
   */
  environment: SessionEnvironment | null;
}

/** `simulation_id`: a per-job orchestrator claims only the run it was launched for. */
export async function claimJobs(workerId: string, opts: { limit?: number; models?: string[]; harness?: string; agent_ids?: string[]; simulation_id?: string; includePrivate?: boolean } = {}): Promise<Job[]> {
  if (!sessionEngine()) return [];
  await sweepStale();
  const db = await getDb();
  const params: unknown[] = [workerId, Math.min(Math.max(opts.limit ?? 1, 1), 50)];
  let filter = "";
  if (opts.models?.length) params.push(opts.models), (filter += ` AND model = ANY($${params.length})`);
  if (opts.harness) params.push(opts.harness), (filter += ` AND harness = $${params.length}`);
  if (opts.agent_ids?.length) params.push(opts.agent_ids), (filter += ` AND agent_id = ANY($${params.length})`);
  if (opts.simulation_id) params.push(opts.simulation_id), (filter += ` AND simulation_id = $${params.length}`);
  // Private runs only go to their own per-job orchestrator (job token), never to a shared one (docs/security.md).
  if (!opts.includePrivate) filter += " /* tenant: claim filter; a job token's claim is pinned to its own simulation in http.ts, the fleet token claims across orgs */ AND simulation_id NOT IN (SELECT id FROM simulations WHERE private)";
  const jobs = await db.transaction(async (tx) => {
    const rows = await tx.query<Omit<Job, "max_user_turns" | "profile" | "agent" | "environment"> & { profile_id: number | null; scenario_id: number; prompt_variants: Record<string, string> | null; run_prompts: Record<string, string> | null }>(
      `UPDATE agent_sessions s SET status = 'running', worker_id = $1, started_at = now(), heartbeat_at = now()
         FROM ${SCENARIO_ROWS} sc
        WHERE sc.id = s.scenario_id AND s.id IN (
              -- Fair share across organizations, not first-come-first-served: an org's k-th queued session is ranked
              -- after the sessions it already has running, and the lowest ranks are claimed first. One org's large
              -- run can no longer hold every pod while another org's sessions wait behind it.
              SELECT id FROM agent_sessions
               WHERE status = 'queued' AND id IN (
                     SELECT id FROM (
                       SELECT q.id, q.queued_at,
                              row_number() OVER (PARTITION BY q.org_id ORDER BY q.queued_at, q.id)
                              + (SELECT count(*) FROM agent_sessions r WHERE r.org_id = q.org_id AND r.status = 'running') AS pos
                         FROM agent_sessions q WHERE q.status = 'queued' ${filter}) ranked
                      ORDER BY pos, queued_at, id LIMIT $2)
                 FOR UPDATE SKIP LOCKED)
        RETURNING s.id AS session_id, s.simulation_id, s.org_id, s.product_id, s.model, s.harness, s.agent_id, s.attempt, s.profile_id, s.scenario_id, s.exec_mode,
                  sc.prompt, sc.prompt_variants, sc.repo_url, sc.language, sc.template, sc.tags, sc.title,
                  (SELECT prompts FROM simulations WHERE id = s.simulation_id) AS run_prompts,
                  coalesce((SELECT private FROM simulations WHERE id = s.simulation_id), false) AS private`,
      params,
    );
    if (rows.length)
      await tx.query(
        "/* tenant: internal: simulations of the sessions this claim just took */ UPDATE simulations SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = ANY($1) AND status = 'queued'",
        [[...new Set(rows.map((r) => r.simulation_id))]],
      );
    // Blindness at the hand-off: a persona tool that names the product or a competitor as they are now (the customer
    // may have edited either since research) is dropped for this session.
    const productIds = [...new Set(rows.map((r) => r.product_id))];
    const products = productIds.length
      ? await tx.query<{ id: number; name: string; aliases: string[]; packages: string[]; domains: string[]; competitors: NamedTool[] }>(
          "/* tenant: internal: products of the sessions this claim just took */ SELECT id, name, aliases, packages, domains, competitors FROM products WHERE id = ANY($1)", [productIds])
      : [];
    const words = new Map(products.map((p) => [p.id, [p.name, ...(p.aliases ?? []), ...(p.packages ?? []), ...(p.domains ?? []),
      ...(p.competitors ?? []).flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.packages ?? []), ...(c.domains ?? [])])]]));
    const profileIds = [...new Set(rows.map((r) => r.profile_id).filter((x): x is number => x != null))];
    const profiles = profileIds.length
      ? await tx.query<Job["profile"] & { id: number; environment: PersonaEnvironment | null }>("SELECT id, slug, name, summary, attributes, instructions, environment FROM developer_profiles WHERE id = ANY($1)", [profileIds])
      : [];
    // A library persona linked to a product (product_personas) carries that product's environment on the link.
    const links = profileIds.length
      ? await tx.query<{ product_id: number; profile_id: number; environment: PersonaEnvironment | null }>(
          "/* tenant: internal: links of the profiles and products this claim just took */ SELECT product_id, profile_id, environment FROM product_personas WHERE profile_id = ANY($1) AND product_id = ANY($2)",
          [profileIds, productIds])
      : [];
    const devEnv = (ENV.APP_DEV_ENV ?? "on").toLowerCase() !== "off";
    return rows.map(({ profile_id, prompt_variants, run_prompts, scenario_id, ...r }) => {
      const p = profiles.find((x) => x!.id === profile_id);
      const spec = r.agent_id ? findAgent(r.agent_id) : undefined;
      const agent: Job["agent"] = spec ? {
        id: spec.id, harness: spec.harness, model: spec.model, label: spec.label, harness_version: spec.harness_version, event_format: spec.event_format,
        image: spec.image, requires_env: spec.requires_env, cli: spec.cli, worker_adapter: spec.worker_adapter, boat_preinstalled: spec.boat_preinstalled,
        resume: spec.resume, origin: spec.origin, base_agent: spec.base_agent,
      } : null;
      const linked = links.find((l) => l.profile_id === profile_id && l.product_id === r.product_id)?.environment;
      const environment = devEnv ? resolveEnvironment(linked ?? p?.environment ?? null, languageOf(r.language, r.template), words.get(r.product_id) ?? []) : null;
      // A library task in this run's words for this persona (src/adapt.ts, adapted when the run started), else a
      // per-persona version stored on an older task, else the task as written.
      const prompt = (p && run_prompts?.[`${scenario_id}:${p.slug}`]) || run_prompts?.[String(scenario_id)] || (p && prompt_variants?.[p.slug]) || r.prompt;
      return { ...r, prompt, agent, environment, max_user_turns: MAX_USER_TURNS(), profile: p ? { slug: p.slug, name: p.name, summary: p.summary, attributes: p.attributes, instructions: p.instructions } : null };
    });
  });
  // Private text is stored encrypted with its organization's key (src/orgcrypto.ts). Opened after the claim commits:
  // key lookups must not run inside the transaction (one connection on PGlite).
  for (const j of jobs) {
    j.prompt = await openText(j.org_id, j.prompt);
    if (j.profile) {
      j.profile.summary = await openText(j.org_id, j.profile.summary);
      j.profile.instructions = await openText(j.org_id, j.profile.instructions);
      j.profile.attributes = await openJson(j.org_id, j.profile.attributes);
    }
  }
  return jobs;
}

async function sessionRef(sessionId: string) {
  if (!sessionEngine()) throw Object.assign(new Error(`No session ${sessionId}`), { status: 404 });
  const db = await getDb();
  const [s] = await db.query<SessionRef & { status: string; events: number }>(
    "SELECT id, org_id, product_id, simulation_id, model, status, events FROM agent_sessions WHERE id = $1",
    [sessionId],
  );
  if (!s) throw Object.assign(new Error(`No session ${sessionId}`), { status: 404 });
  return s;
}

export async function appendEvents(sessionId: string, raw: RawEvent[]) {
  const s = await sessionRef(sessionId);
  if (s.status !== "running") throw Object.assign(new Error(`Session ${sessionId} is ${s.status}, not running`), { status: 409 });
  if (!raw.length) return { appended: 0, last_seq: s.events };
  const events = normalize(raw, s.events);
  await transcripts().append(s, events);
  const lastSeq = Math.max(s.events, ...events.map((e) => e.seq));
  const db = await getDb();
  await db.query("/* tenant: session checked against the job token in http.ts (/sessions/:id) */ UPDATE agent_sessions SET events = greatest(events, $2), heartbeat_at = now() WHERE id = $1", [sessionId, lastSeq]);
  return { appended: events.length, last_seq: lastSeq };
}

export async function heartbeat(sessionId: string) {
  if (!sessionEngine()) throw Object.assign(new Error(`Session ${sessionId} is not running`), { status: 409 });
  const db = await getDb();
  const [row] = await db.query("/* tenant: session checked against the job token in http.ts (/sessions/:id) */ UPDATE agent_sessions SET heartbeat_at = now() WHERE id = $1 AND status = 'running' RETURNING id", [sessionId]);
  if (!row) throw Object.assign(new Error(`Session ${sessionId} is not running`), { status: 409 });
}

export const COMPLETED_REASONS = ["done", "turn_cap", "time_cap", "agent_gave_up", "error"] as const;

export interface CompleteInput {
  status?: "completed" | "failed" | "timeout"; error_message?: string; sandbox_id?: string;
  /** Why the session ended (orchestrator's deterministic done check / caps). */
  completed_reason?: (typeof COMPLETED_REASONS)[number];
  tokens_in?: number; tokens_out?: number; cost_usd?: number; metadata?: Record<string, unknown>;
}

/** Every stored event of a session, in order (a host pack scores from these). */
export async function allEvents(orgId: number, sessionId: string): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await transcripts().read(orgId, sessionId, offset, 500);
    out.push(...page.events);
    if (page.events.length < 500) return out;
  }
}

/**
 * Infrastructure failures: the sandbox, the network to it, the orchestrator or an overloaded provider, never the
 * agent's own work. Config and request errors (400s, a harness the gateway cannot serve, a spent budget) are not here:
 * retrying those only fails again and spends twice.
 */
const INFRA_FAILURE = /boat runner:|boat command stream error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|socket connection was closed|fetch failed|No heartbeat for \d+ minutes|\b(502|503|504|529)\b|overloaded/i;
/** Config errors that can carry an infrastructure-looking number (a status, an id): a spent budget, a missing vault key. */
const NOT_INFRA = /budget is used up|missing_credential|No vault provider supplies/i;
const INFRA_RETRIES = () => Math.max(0, Number(ENV.APP_SESSION_INFRA_RETRIES ?? 1));

/**
 * Put an infrastructure-failed session back in the queue (at most INFRA_RETRIES times) instead of failing it: its
 * transcript is cleared, its gateway token revoked, and the next claim starts it afresh. Returns false when the failure
 * is not infrastructure, the retries are used up, or the run was cancelled. The spend of the failed attempt stays on
 * the session (it is real), so one retry bounds the waste at one attempt.
 */
async function retryInfraFailure(s: SessionRef, input: CompleteInput): Promise<boolean> {
  if (input.status !== "failed" && input.status !== "timeout") return false;
  const msg = input.error_message ?? "";
  if (!INFRA_FAILURE.test(msg) || NOT_INFRA.test(msg)) return false;
  const db = await getDb();
  const [row] = await db.query<{ retries: number; sim: string }>(
    `/* tenant: session checked against the job token in http.ts, or internal stale sweep */ SELECT coalesce((a.metadata->>'infra_retries')::int, 0) AS retries, m.status AS sim
       FROM agent_sessions a JOIN simulations m ON m.id = a.simulation_id WHERE a.id = $1`, [s.id]);
  if (!row || row.sim === "cancelled" || row.retries >= INFRA_RETRIES()) return false;
  try { await transcripts().remove(s.org_id, s.id); }
  catch (err) { console.error(`session ${s.id}: not retried, transcript reset failed: ${(err as Error).message}`); return false; }
  await revokeSessionTokens(s.id);
  await db.query(
    `/* tenant: session checked against the job token in http.ts, or internal stale sweep */ UPDATE agent_sessions SET status = 'queued', worker_id = NULL, started_at = NULL, heartbeat_at = NULL, ended_at = NULL,
            sandbox_id = NULL, error_message = NULL, events = 0, user_turns = 0,
            archive_key = NULL, archived_at = NULL, archive_events = NULL, archive_claimed_at = NULL,
            metadata = metadata || jsonb_build_object('infra_retries', $2::int, 'infra_error', $3::text)
      WHERE id = $1 AND status = 'running'`,
    [s.id, row.retries + 1, msg.slice(0, 500)]);
  console.error(`session ${s.id}: infrastructure failure, requeued (retry ${row.retries + 1}/${INFRA_RETRIES()}): ${msg.slice(0, 160)}`);
  return true;
}

/** Finish a session and score it. Re-completing an already finished session just re-scores it. */
export async function completeSession(sessionId: string, input: CompleteInput = {}) {
  const s = await sessionRef(sessionId);
  const db = await getDb();
  if (s.status === "running" && (await retryInfraFailure(s, input))) return null;
  // Only an open session is finished here, re-checked in the UPDATE itself: an admin cancel that lands between the
  // read above and this write keeps the session cancelled (and its spend is reported once, by the cancel).
  let finished = false;
  if (!FINAL.includes(s.status)) {
    finished = (await db.query(
      `/* tenant: session checked against the job token in http.ts, or internal stale sweep */ UPDATE agent_sessions SET status = $2, ended_at = now(), error_message = $3, sandbox_id = coalesce($4, sandbox_id),
              tokens_in = coalesce($5, tokens_in), tokens_out = coalesce($6, tokens_out), cost_usd = coalesce($7, cost_usd),
              metadata = metadata || $8::jsonb, completed_reason = coalesce($9, completed_reason),
              -- The mode the session actually ran in: a plan session finished by an orchestrator that ran it directly
              -- (a harness that can't resume, or an orchestrator from before plan mode, which reports no exec_mode).
              exec_mode = CASE WHEN exec_mode = 'plan' AND $8::jsonb ? 'harness_runs' AND coalesce($8::jsonb->>'exec_mode', 'direct') <> 'plan'
                               THEN 'direct' ELSE exec_mode END
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
      [sessionId, input.status ?? "completed", input.error_message ?? null, input.sandbox_id ?? null, input.tokens_in ?? null,
       input.tokens_out ?? null, input.cost_usd ?? null, JSON.stringify(input.metadata ?? {}),
       (COMPLETED_REASONS as readonly string[]).includes(input.completed_reason ?? "") ? input.completed_reason : null],
    )).length > 0;
  }
  // The session's gateway token dies with it; tokens and cost the gateway metered are authoritative when larger
  // than what the worker parsed from the CLI's own output (Codex, for one, reports no cost at all).
  await revokeSessionTokens(sessionId);
  const metered = await sessionGatewayUsage(sessionId);
  if (metered.requests)
    await db.query(
      `/* tenant: session checked against the job token in http.ts, or internal stale sweep */ UPDATE agent_sessions SET tokens_in = greatest(tokens_in, $2), tokens_out = greatest(tokens_out, $3),
              cost_usd = greatest(cost_usd, $4) WHERE id = $1`,
      [sessionId, metered.input_tokens, metered.output_tokens, metered.cost_usd]);
  const score = await scoreSession(sessionId);
  if (finished) {
    reportSessionSpend(sessionId); // usage-based billing; once per session (Stripe dedupes by id too)
    checkBudgetLater(s.org_id); // 80% / 100% of the monthly allowance: an email to owners and billing managers, once a month each
  }
  await finishSimulationIfDone(s.simulation_id);
  return score;
}

/**
 * A finished session's result, from the host pack that scores sessions (src/host.ts sessions.score; the product's
 * verdict). With none, a session has no verdict.
 */
export async function scoreSession(sessionId: string): Promise<unknown> {
  for (const h of hosts()) if (h.sessions?.score) return h.sessions.score(sessionId);
  return null;
}

export async function finishSimulationIfDone(simulationId: string, opts: { extend?: boolean } = {}) {
  // Adaptive runs (a host pack's, src/host.ts sessions.extend): when a batch is done, tasks whose result is not settled yet get more sessions; only a run that
  // queues nothing more is finished. `extend: false` (an admin cancelling a session) never queues more: stopping work
  // must not start new paid work.
  if (!sessionEngine()) return;
  for (const h of opts.extend === false ? [] : hosts()) if (h.sessions?.extend && (await h.sessions.extend(simulationId))) return;
  const db = await getDb();
  const [done] = await db.query<{ org_id: number; status: string; first: boolean }>(
    `/* tenant: internal: the finished session's own simulation */ UPDATE simulations SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'completed' END,
            finished_at = coalesce(finished_at, now())
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE simulation_id = $1 AND status IN ('queued', 'running'))
      RETURNING org_id, status, finished_at > now() - interval '2 seconds' AS first`,
    [simulationId],
  );
  if (done?.first) void orgEvent(done.org_id, done.status === "cancelled" ? "simulation_cancelled" : "simulation_completed", { simulation_id: simulationId });
  if (done?.first && done.status === "completed") reportSimulationUsage(simulationId); // usage-based billing: 1 per completed run
}

/** Time out sessions whose worker went quiet for longer than the lease. */
export async function sweepStale() {
  if (!sessionEngine()) return 0;
  const db = await getDb();
  const stale = await db.query<{ id: string }>(
    `/* tenant: internal: stale-lease sweep across all orgs */ SELECT id FROM agent_sessions WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1)`,
    [LEASE_MINUTES()],
  );
  for (const { id } of stale)
    await completeSession(id, { status: "timeout", error_message: `No heartbeat for ${LEASE_MINUTES()} minutes` });
  return stale.length;
}
