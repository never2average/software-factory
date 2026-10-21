/**
 * pi-octillion: Pi extension that turns Pi into the Octillion orchestrator.
 *
 * Tools (thin wrappers over orchestrator/core):
 *   claim_jobs(limit)                    claim queued jobs (manager mode only)
 *   start_worker(job_id)                 boat VM + harness running headless with the task prompt
 *   wait_for_turn(session)               wait for the harness run to end; last text, commands, files, exit
 *   reply_as_developer(session, text)    emit `simulated_user` and resume the same harness conversation
 *   finish_session(session, status)      git diff event, /complete, delete the VM
 *
 * Embedded by pi-octillion/main.ts (SDK, one Pi session per job). Also loadable in the Pi CLI for manual runs:
 *   pi -e ./orchestrator/pi-octillion --no-builtin-tools     (claim_jobs enabled)
 *
 * BLINDNESS: tool results carry no Octillion ids (session/simulation/org/product), URLs or tokens. Pi only ever
 * sees a job handle, the developer profile, the task prompt and what the sub-agent said and did.
 */
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CFG } from "../core/config.js";
import { RUNNERS, type Runner } from "../core/runners.js";
import { assertOrchestratorHost } from "../core/host-guard.js";
import { claimJobs, WorkerSession, type Job } from "../core/session.js";
import { jobPrompt } from "./prompt.js";

export const OCTILLION_TOOLS = ["start_worker", "wait_for_turn", "reply_as_developer", "finish_session"] as const;

/** Jobs and sessions visible to one Pi session (or to a manager-mode Pi). */
export class OctillionRegistry {
  readonly jobs = new Map<string, Job>();
  readonly sessions = new Map<string, WorkerSession>();
  readonly sessionByJob = new Map<string, WorkerSession>();
  /** Calls made by the LLM, recorded for /complete metadata. */
  toolCalls = 0;
  /** Extra /complete metadata from the host (e.g. the Pi session's LLM cost so far). */
  metaFn: (() => Record<string, unknown>) | null = null;

  constructor(readonly runner: Runner) {}

  addJob(job: Job): string {
    const id = `job_${randomUUID().slice(0, 8)}`;
    this.jobs.set(id, job);
    return id;
  }

  session(handle: string): WorkerSession {
    const s = this.sessions.get(handle);
    if (!s) throw new Error(`unknown session ${handle}`);
    return s;
  }
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], details: undefined });

export function createOctillionExtension(reg: OctillionRegistry, opts: { allowClaim?: boolean } = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (opts.allowClaim) {
      pi.registerTool(defineTool({
        name: "claim_jobs",
        label: "Claim jobs",
        description: "Claim up to `limit` queued simulation jobs. Returns job ids with the developer profile and task for each.",
        parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
        executionMode: "sequential",
        async execute(_id, p) {
          reg.toolCalls++;
          const jobs = await claimJobs(p.limit ?? 1);
          return text(jobs.map((j) => {
            const id = reg.addJob(j);
            return { job_id: id, harness: j.harness, brief: jobPrompt(id, j.profile, j.prompt, j.max_user_turns ?? CFG.defaultMaxUserTurns) };
          }));
        },
      }));
    }

    pi.registerTool(defineTool({
      name: "start_worker",
      label: "Start worker",
      description: "Start the sandbox and the sub-agent for a job (the task prompt is sent verbatim). Returns the session handle.",
      parameters: Type.Object({ job_id: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p) {
        reg.toolCalls++;
        const job = reg.jobs.get(p.job_id);
        if (!job) throw new Error(`unknown job ${p.job_id}`);
        if (reg.sessionByJob.has(p.job_id)) return text({ session: reg.sessionByJob.get(p.job_id)!.handle, note: "already started" });
        const s = await WorkerSession.start(job, reg.runner);
        reg.sessions.set(s.handle, s);
        reg.sessionByJob.set(p.job_id, s);
        return text({ session: s.handle, max_user_turns: s.maxUserTurns });
      },
    }));

    pi.registerTool(defineTool({
      name: "wait_for_turn",
      label: "Wait for turn",
      description: "Wait until the sub-agent's current run ends, then return its last message, the commands it ran, files it touched, exit status, the workspace done check (workspace.done), agent_turns_left, can_reply, must_continue and phase (plan: its last message is the plan it was asked for, awaiting the go-ahead).",
      parameters: Type.Object({ session: Type.String() }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        reg.toolCalls++;
        const s = reg.session(p.session);
        const report = await Promise.race([
          s.waitForTurn(),
          new Promise<never>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true })),
        ]);
        return text(report);
      },
    }));

    pi.registerTool(defineTool({
      name: "reply_as_developer",
      label: "Reply as developer",
      description: "Send the developer's short in-character reply to the sub-agent and resume its conversation. Only when the last report has can_reply=true: when must_continue=true (not done yet), or when the sub-agent is waiting on the developer.",
      parameters: Type.Object({ session: Type.String(), text: Type.String({ minLength: 1, maxLength: 1200 }) }),
      executionMode: "sequential",
      async execute(_id, p) {
        reg.toolCalls++;
        const r = await reg.session(p.session).replyAsDeveloper(p.text);
        return text({ resumed: true, ...r });
      },
    }));

    pi.registerTool(defineTool({
      name: "finish_session",
      label: "Finish session",
      description: "End the session: collect the diff, report completion and delete the sandbox. Refused while the agent is resumable and not done (must_continue=true). Call exactly once per session.",
      parameters: Type.Object({
        session: Type.String(),
        status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
        note: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      executionMode: "sequential",
      async execute(_id, p) {
        reg.toolCalls++;
        const s = reg.session(p.session);
        const refusal = s.finishRefusal();
        if (refusal) throw new Error(`finish_session refused: ${refusal}`);
        const r = await s.finish({ status: p.status, note: p.note, orchestrator: { orchestrator: "pi", orchestrator_tool_calls: reg.toolCalls, ...(reg.metaFn?.() ?? {}) } });
        return text({ finished: true, status: r.status, completed_reason: s.completedReason });
      },
    }));
  };
}

/** Default export for `pi -e ./orchestrator/pi-octillion`: manager mode with claim_jobs. */
export default function octillion(pi: ExtensionAPI) {
  assertOrchestratorHost(CFG.runner); // manual Pi CLI use is agent work too: boat orchestrator sandboxes only
  const runner = RUNNERS[CFG.runner];
  if (!runner) throw new Error(`RUNNER must be one of ${Object.keys(RUNNERS).join(", ")}`);
  return createOctillionExtension(new OctillionRegistry(runner), { allowClaim: true })(pi);
}
