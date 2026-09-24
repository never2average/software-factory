/**
 * On-demand RUN tools: `trigger_workflow` and `run_app` (re-exported from
 * snake_case files under `agent/tools/`).
 *
 * These let the agent EXECUTE a saved workflow or REFRESH an App itself, rather
 * than telling the operator to go click refresh in the Apps tab. Neither runs
 * here: the sandbox runtime and the delegation machinery live on the FRONT-END,
 * so each tool POSTs to `POST /api/ops/run` (guarded by CRON_SECRET), which runs
 * it durably with the front-end's own Vercel OIDC service token — the identity
 * the agent already trusts (agent/channels/eve.ts). That is why the agent never
 * has to bundle the sandbox or self-delegate.
 *
 * Both are approval-gated: a run/refresh spends tokens (it delegates to
 * subagents), so the operator confirms before any spend.
 */
import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";
import { orgForSession, type SessionCtxLike } from "./org-context.ts";
import { modelFacing } from "./model-facing/tools/model-facing.ts";

/** The front-end that owns the run routes + the sandbox runtime. */
const WEB_ORIGIN = process.env.WEB_ORIGIN?.trim() || "https://fde-agent.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET?.trim();
/** Cap a bit under the route's maxDuration (300s) so we surface a clean error. */
const RUN_TIMEOUT_MS = 285_000;

/** The caller's email from verified session auth (never the model). */
function callerEmail(ctx: {
  session: { auth: { current: { principalId: string; attributes: Readonly<Record<string, string | readonly string[]>> } | null } };
}): string {
  const current = ctx.session.auth.current;
  const email = current?.attributes?.email;
  if (typeof email === "string" && email.length > 0) return email;
  return current?.principalId ?? "agent";
}

async function triggerRun(
  kind: "workflow" | "app",
  target: string,
  actor: string,
  orgId: string,
  args?: unknown,
): Promise<Record<string, unknown>> {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET is not set on the agent, so it cannot trigger a run. Add it to the agent's env.");
  }
  const res = await fetch(`${WEB_ORIGIN}/api/ops/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CRON_SECRET}` },
    body: JSON.stringify({ kind, target, actor, orgId, ...(args === undefined ? {} : { args }) }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // The route lists the keys the script reads (`expects`): say them, so a refusal can be corrected in one step.
    const expects = Array.isArray(data.expects) && data.expects.length ? ` It reads: ${(data.expects as string[]).join(", ")}.` : "";
    throw new Error(((data.error as string) ?? `The run failed (${res.status}).`) + expects);
  }
  return data;
}

export const triggerWorkflowTool = modelFacing("trigger_workflow", defineTool({
  description:
    "RUN a saved workflow NOW, durably, and return its result. Use this whenever someone wants to EXECUTE or VALIDATE a workflow on demand — 'run the QBR workflow', 'trigger route-incident', 'show me the workflow working before we turn it on'. Pass the workflow NAME exactly as it appears in the Workflows list. A run delegates to subagents and SPENDS TOKENS, so it is gated on approval. Returns the runId (openable as a chat) plus the workflow's return value; if it hits the wall clock it reports timedOut and keeps running durably.",
  approval: once(),
  inputSchema: z.strictObject({
    workflow: z.string().min(1).describe("The workflow name to run, e.g. 'qbr-prep'."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The payload the workflow runs with, as a JSON object — e.g. {\"customerId\": \"acme-bank\"} " +
          "when someone asks to run it FOR a particular account. Keys must be the ones the script " +
          "actually reads: the run is REFUSED, before spending anything, if a key is misspelled or " +
          "unused, and the error lists the keys it does read. Omit entirely when the request names " +
          "no scope — most workflows read what they need for themselves.",
      ),
  }),
  async execute({ workflow, args }, ctx) {
    const data = await triggerRun(
      "workflow",
      workflow,
      callerEmail(ctx),
      await orgForSession(ctx as SessionCtxLike),
      args,
    );
    return {
      ran: true as const,
      workflow: data.workflow,
      runId: data.runId,
      ok: data.ok,
      timedOut: data.timedOut,
      error: data.error,
      result: data.result,
    };
  },
}), { opaqueInput: ["args"], opaqueOutput: ["result"] });

export const runAppTool = modelFacing("run_app", defineTool({
  description:
    "REFRESH an App NOW — regenerate its living document (running its workflow or prompt) on demand, instead of waiting for the app's cadence or a human clicking refresh in the Apps tab. Use when someone wants to see or validate an app's current output now. Pass the app NAME or slug (from list_apps). A refresh SPENDS TOKENS (it runs the app's source), so it is gated on approval. Returns whether it refreshed; read the fresh document in the Apps tab.",
  approval: once(),
  inputSchema: z.strictObject({
    app: z.string().min(1).describe("The app name or slug to refresh, e.g. 'sbi-qbr'."),
  }),
  async execute({ app }, ctx) {
    const data = await triggerRun(
      "app",
      app,
      callerEmail(ctx),
      await orgForSession(ctx as SessionCtxLike),
    );
    return { refreshed: data.ok === true, app: data.app, error: data.error };
  },
}));
