/**
 * Octillion orchestrator agent: Pi (pi.dev, embedded via its SDK) role-plays the developer for each job.
 *
 * One Pi AgentSession per claimed job, all in this Node process (WORKER_CONCURRENCY in parallel). Each Pi
 * session gets only that job's developer profile and task prompt, plus the pi-octillion tools (no built-in
 * read/bash/edit/write, no discovered extensions, skills, context files or ~/.pi config).
 *
 * Deterministic fallback: if Pi or its LLM fails (error, abort, never started the worker, or left the session
 * open), the host finishes the session itself exactly like worker.ts would. A job is never lost to an LLM error.
 *
 * Run: `npx tsx orchestrator/pi-octillion/main.ts`
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CFG, ORCH, env } from "../core/config.js";
import type { Runner } from "../core/runners.js";
import { driveToDone, isShuttingDown, markShuttingDown, type Job } from "../core/session.js";
import { log } from "../core/util.js";
import { claimLoop, runDeterministic } from "../worker.js";
import { CREDENTIALS_MODE, orchestratorCredentials, redact } from "../core/credentials.js";
import { researchLoop } from "./research.js";
import { startIdleWatcher } from "../core/activity.js";
import { FleetMembership } from "../core/fleet-client.js";
import { assertOrchestratorHost } from "../core/host-guard.js";
import { createOctillionExtension, OCTILLION_TOOLS, OctillionRegistry } from "./index.js";
import { jobPrompt, ORCHESTRATOR_SYSTEM_PROMPT } from "./prompt.js";

interface Brain {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  dir: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string | null;
}

/**
 * Model runtime isolated from the operator's ~/.pi (own auth.json/models.json in a temp dir).
 * CREDENTIALS_MODE=broker (default): provider, base URL (the Octillion gateway) and ogw_ token come from
 * POST /api/worker/orchestrator/credentials. env: ORCHESTRATOR_PROVIDER / ORCHESTRATOR_API_KEY / ORCHESTRATOR_API_URL.
 */
export async function createBrain(): Promise<Brain> {
  const c = await orchestratorCredentials();
  const provider = c.llm?.provider || ORCH.provider;
  const modelId = c.llm?.model || ORCH.model;
  const baseUrl = c.llm?.base_url || ORCH.apiUrl || null;
  const apiKey = c.llm?.api_key ?? "";
  const dir = await mkdtemp(join(tmpdir(), "octillion-pi-"));
  await mkdir(join(dir, "cwd"), { recursive: true });
  const modelsPath = join(dir, "models.json");
  // Point the provider at the gateway (or a proxy/test mock); Pi keeps its built-in model metadata.
  await writeFile(modelsPath, JSON.stringify({ providers: baseUrl ? { [provider]: { baseUrl } } : {} }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath, allowModelNetwork: false });
  if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi has no model ${provider}/${modelId} (set by the broker or ORCHESTRATOR_MODEL)`);
  return { modelRuntime, model, dir, provider, modelId, apiKey, baseUrl };
}

/** Refetch the orchestrator token near expiry (or after a 401) and hand it to Pi's runtime. */
export async function refreshBrain(brain: Brain, force = false): Promise<void> {
  const c = await orchestratorCredentials(force);
  const key = c.llm?.api_key;
  if (key && key !== brain.apiKey) {
    await brain.modelRuntime.setRuntimeApiKey(brain.provider, key);
    brain.apiKey = key;
    log("orchestrator LLM token refreshed");
  }
}

/** Run one job with a fresh Pi session; fall back to the deterministic path on any Pi/LLM failure. */
export async function runJobWithPi(job: Job, runner: Runner, brain: Brain): Promise<void> {
  const reg = new OctillionRegistry(runner);
  const jobId = reg.addJob(job);
  const maxTurns = Number.isFinite(job.max_user_turns) ? Number(job.max_user_turns) : CFG.defaultMaxUserTurns;
  let piError: string | null = null;
  let stats: { cost: number; tokens_in: number; tokens_out: number; calls: number } | null = null;

  try {
    const cwd = join(brain.dir, "cwd");
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: brain.dir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      extensionFactories: [{ name: "octillion", factory: createOctillionExtension(reg) }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir: brain.dir,
      modelRuntime: brain.modelRuntime, model: brain.model, thinkingLevel: ORCH.thinking,
      resourceLoader,
      tools: [...OCTILLION_TOOLS], // allowlist: no read/bash/edit/write on the orchestrator host
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: ORCH.maxRetries } }),
    });
    reg.metaFn = () => {
      const st = session.getSessionStats();
      return {
        orchestrator_model: `${brain.provider}/${brain.modelId}`,
        orchestrator_cost_usd: Number(st.cost.toFixed(6)),
        orchestrator_tokens_in: st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite,
        orchestrator_tokens_out: st.tokens.output,
        orchestrator_llm_calls: st.assistantMessages,
      };
    };
    session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") log(`[${job.session_id}] pi -> ${ev.toolName}`);
    });
    // Pi gets the whole session budget plus slack; the session deadline itself is enforced by WorkerSession.
    const budget = setTimeout(() => { piError = "orchestrator exceeded the session budget"; void session.abort(); }, CFG.maxSessionMs + 10 * 60_000);
    try {
      await session.prompt(jobPrompt(jobId, job.profile, job.prompt, maxTurns));
      const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
      if (last?.stopReason === "error" || last?.stopReason === "aborted") piError ??= `pi: ${last.errorMessage ?? last.stopReason}`;
    } catch (e) {
      piError ??= `pi: ${String(e instanceof Error ? e.message : e)}`;
    } finally {
      clearTimeout(budget);
      const st = session.getSessionStats();
      stats = { cost: st.cost, tokens_in: st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite, tokens_out: st.tokens.output, calls: st.assistantMessages };
      session.dispose();
    }
  } catch (e) {
    piError ??= `pi setup: ${String(e instanceof Error ? e.message : e)}`;
  }

  const orchestrator = {
    orchestrator: "pi",
    orchestrator_model: `${brain.provider}/${brain.modelId}`,
    ...(stats ? { orchestrator_cost_usd: Number(stats.cost.toFixed(6)), orchestrator_tokens_in: stats.tokens_in, orchestrator_tokens_out: stats.tokens_out, orchestrator_llm_calls: stats.calls } : {}),
    ...(piError ? { orchestrator_error: piError.slice(0, 500) } : {}),
  };
  if (piError) log(`[${job.session_id}] ${redact(piError)}; deterministic fallback`);
  if (piError && /\b401\b|unauthori[sz]ed|invalid.*(key|token)/i.test(piError)) await refreshBrain(brain, true).catch((e) => log("orchestrator credential refresh failed:", redact(String(e))));

  // Deterministic fallback / safety net.
  const s = reg.sessionByJob.get(jobId);
  if (!s) {
    log(`[${job.session_id}] Pi never started the worker; running it without the simulated developer`);
    await runDeterministic(job, runner, { ...orchestrator, orchestrator: "fallback" });
  } else if (!s.finished) {
    if (!piError) log(`[${job.session_id}] Pi left the session open; continuing it deterministically until done`);
    // Not done yet (Pi stopped early or failed): keep the agent going with neutral nudges up to the turn cap.
    await driveToDone(s).catch((e) => log(`[${job.session_id}] nudge loop stopped:`, String(e)));
    await s.finish({ orchestrator: { ...orchestrator, orchestrator: "pi+fallback" } });
  }
}

if (process.argv[1] && /pi-octillion[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  (async () => {
    assertOrchestratorHost(CFG.runner); // before touching any credentials
    const brain = await createBrain();
    if (!brain.apiKey) log("warning: no orchestrator LLM credentials; every job will use the deterministic fallback");
    log(`orchestrator brain ${brain.provider}/${brain.modelId}${brain.baseUrl ? ` via ${brain.baseUrl}` : ""} thinking=${ORCH.thinking} credentials=${CREDENTIALS_MODE}`);
    const fresh = async () => {
      await refreshBrain(brain).catch((e) => log("orchestrator credential refresh failed (using the current token):", redact(String(e))));
      return brain;
    };
    // Per-job research orchestrator (ORCHESTRATOR_JOB=rsh_...): one onboarding research, then leave and exit. Context
    // reaches the run's orchestrator only through the server (personas and their environments, problems), never directly.
    if (CFG.job?.startsWith("rsh_")) {
      const fleet = new FleetMembership({ capacity: 1 }); // liveness for the autoscaler and the job's done signal
      const stop = () => { if (isShuttingDown()) process.exit(1); markShuttingDown(); log(`stopping research orchestrator for ${CFG.job}`); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      fleet.onJobDone = stop;
      await fleet.start();
      if (fleet.job?.done) stop();
      log(`research orchestrator bound to ${CFG.job}`);
      startIdleWatcher();
      await researchLoop(fresh);
      await fleet.leave();
      process.exit(0);
    }
    // Per-job run orchestrator (ORCHESTRATOR_JOB=sim_...): that simulation's sessions only, no research.
    if (CFG.job?.startsWith("sim_")) {
      startIdleWatcher();
      await claimLoop(async (job, runner) => runJobWithPi(job, runner, await fresh()), `orchestrator[${CFG.job}]`);
      process.exit(0);
    }
    // ORCHESTRATOR_MODE=research: a research-only worker (never claims coding-agent sessions).
    if (env.ORCHESTRATOR_MODE === "research") {
      assertOrchestratorHost(CFG.runner); // research is agent work too: boat orchestrator sandboxes only
      const stop = () => { if (isShuttingDown()) process.exit(1); markShuttingDown(); log("stopping research worker"); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      log("research-only mode");
      startIdleWatcher();
      await researchLoop(fresh);
      process.exit(0);
    }
    // Coding-agent sessions and product-onboarding research jobs, claimed side by side on the same brain.
    // On demand: idle for OCTILLION_ORCH_IDLE_MINUTES -> graceful SIGTERM path -> leave the fleet -> exit 0.
    startIdleWatcher();
    await Promise.all([
      claimLoop(async (job, runner) => runJobWithPi(job, runner, await fresh()), "orchestrator"),
      researchLoop(fresh),
    ]);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
