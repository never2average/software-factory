/**
 * The bridge from a workflow script's `agent()` call to the real agent.
 *
 * eve's declared subagents "do not declare channels" — there is no HTTP address
 * for the `deployment` subagent, and which subagent handles a task is decided by
 * the orchestrator's model. So a step becomes a message to the root agent that
 * NAMES the subagent and asks it to hand the work over, and the step's return
 * value is the final assistant text of that turn.
 *
 * Be honest about what that means: `agent("…", { subagent: "deployment" })` is a
 * strong instruction, not a function call. The orchestrator normally complies,
 * but nothing in the protocol guarantees it — the UI says as much rather than
 * dressing this up as an RPC.
 *
 * Auth: the caller's own Google ID token is forwarded, so a workflow run can
 * never do anything the operator who started it could not do themselves.
 */
import "server-only";
// Relative, with its extension: this file is also loaded by the offline tests under plain node.
import { SERVICE_SCOPE_HEADER } from "../agent/lib/service-scope.ts";
import { SESSION_VISIBILITY_GRANT_HEADER } from "./session-token-kinds.ts";
import { mintWorkspaceStepGrant } from "./auth-session.ts";
import { fill, speak, withCurrentToolNames } from "../agent/lib/agent-vocabulary.ts";

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";

/** How long one delegated step may take before the run gives up on it. */
const STEP_TIMEOUT_MS = 120_000;
/** Browser steps are slow (cold remote-browser attach + multi-page read/act),
 *  so they get a longer budget — still under the 300s route maxDuration. The
 *  global cap stays 120s for every other subagent. */
const BROWSER_STEP_TIMEOUT_MS = 280_000;

/**
 * What a step is FOR, not just what it must do.
 *
 * Every agent() call opens a brand-new eve session, so a step arrives knowing
 * nothing but its prompt string: not which workflow it belongs to, not which
 * phase, not which run, not what came before. Anything the script did not spell
 * out in the prompt itself was simply absent — which is why an opened step
 * reads as blank, and why a prompt that says "now do the same for the others"
 * has nothing to refer to.
 *
 * Kept short on purpose. This is prepended to EVERY step, so it competes with
 * the actual instruction for attention; it carries identity and provenance, and
 * leaves the task to the prompt.
 */
export interface StepContext {
  /** The workflow's name, as the operator knows it. */
  workflow?: string;
  /** The phase() this call sits under, when the script declared one. */
  phase?: string;
  /** Durable run id — the thread to look under when tracing what happened. */
  runId?: string;
  /** 1-based position across the whole run. */
  call?: number;
  /** The customer this run is about, when the script is scoped to one. */
  customerId?: string;
}

/** One line naming the run, or "" when there is nothing to say. */
function identity(ctx?: StepContext): string {
  if (!ctx) return "";
  const bits: string[] = [];
  if (ctx.workflow) bits.push(`Workflow: ${ctx.workflow}${ctx.phase ? ` · phase "${ctx.phase}"` : ""}`);
  if (ctx.call) bits.push(`Step ${ctx.call}`);
  if (ctx.customerId) bits.push(`${speak("Customer")}: ${ctx.customerId}`);
  if (ctx.runId) bits.push(`Run: ${ctx.runId}`);
  return bits.length ? `[${bits.join(" · ")}]` : "";
}

const MACHINE_READER =
  "You are one step of an automated workflow. Your reply is consumed by a program, so return the result and nothing else.";

/**
 * Compose the message that opens the step's session.
 *
 * The subagent case is the subtle one. A subagent is reached by ASKING the
 * orchestrator to hand the work over, so the subagent sees only what the
 * orchestrator chooses to forward — put the run's identity in a preamble
 * addressed to the orchestrator and the subagent never learns it, which is
 * exactly the "opens blank" complaint one level down.
 *
 * So the identity line goes INSIDE the <task> block, and the block is what the
 * orchestrator is told to pass on verbatim. Then the subagent knows which
 * workflow, phase, run and customer it is working for even though nothing but
 * text ever crossed the boundary.
 */
export function composeStepMessage(stored: string, subagent?: string, ctx?: StepContext): string {
  // A script stored before a tool was renamed names it by its old name ("Call list_fdes…"), and one seeded raw
  // carries role placeholders (`{owner}`, `{member}`): both reach the model in this deployment's words.
  const prompt = withCurrentToolNames(fill(stored));
  const id = identity(ctx);
  // The step's own brief: identity, then who is reading the answer, then the work.
  const task = id ? [id, MACHINE_READER, "", prompt] : [prompt];
  if (!subagent) return task.join("\n");
  return [
    ...(id ? [id, ""] : []),
    `Delegate this task to the \`${subagent}\` subagent and let it do the work — do not carry it out yourself.`,
    speak("Pass everything between the <task> markers to it VERBATIM, including the bracketed context line: that line is how it knows which run and customer this is for. Do not summarise or rewrite it."),
    "",
    "<task>",
    ...task,
    "</task>",
    "",
    "Reply with the subagent's result and nothing else — no preamble, no commentary. Your reply is consumed by a program, not read by a person.",
  ].join("\n");
}

/**
 * Which customer a run is about, read from the args the operator submitted.
 *
 * Scripts are hand-written, so the key is whatever the author reached for. Only
 * these spellings are accepted — guessing from any key that merely looks like an
 * id would sooner or later tell a step it is working for the wrong account,
 * which is worse than telling it nothing. When this returns undefined the caller
 * falls back to the workflow's own `customer_id` column.
 */
const CUSTOMER_KEYS = ["customerId", "customer_id", "customer", "accountId", "account_id"] as const;

export function customerFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const bag = args as Record<string, unknown>;
  for (const key of CUSTOMER_KEYS) {
    const value = bag[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Fired as soon as a step's session is known (and again when its child subagent
 *  session appears), so the caller can record a steerable RUNNING step. */
export type OnStepSession = (info: { sessionId: string; childSessionId?: string }) => void;

/** A base delegate: runs one workflow step, calling onSession when its session
 *  opens. Wrapped by makeDurableDelegate to add journaling + retry. */
export type StepDelegate = (
  prompt: string,
  subagent?: string,
  onSession?: OnStepSession,
  /** What only the runtime knows: where this call sits in the run. Merged over
   *  the run-wide context the caller supplied when it built the delegate. */
  step?: Pick<StepContext, "call" | "phase">,
) => Promise<string>;

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * The headers of every call a step makes on the agent. The workspace goes on ALL of them, not only the create: the
 * agent admits the service token to a session only while it names that session's workspace (lib/chat-gate.ts), so a
 * stream read or a cancel without it is refused. Ignored on a person's token.
 */
function agentHeaders(bearer: string, orgId: string | null | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, authorization: `Bearer ${bearer}`, ...(orgId ? { [SERVICE_SCOPE_HEADER]: orgId } : {}) };
}

async function cancelEveSession(sessionId: string, bearer: string, orgId: string | null | undefined): Promise<void> {
  await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    headers: agentHeaders(bearer, orgId, { "content-type": "application/json" }),
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/** The email a bearer names (unverified: the agent verifies the bearer itself), or null — a service token names none. */
function bearerEmail(bearer: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof payload.email === "string" && payload.email ? payload.email : null;
  } catch {
    return null;
  }
}

/**
 * What a delegate's sessions ARE, which decides who else may act on them (lib/chat-gate.ts):
 *
 *   step     a workflow run's, an app refresh's or a cron's step. WORKSPACE-visible: colleagues read it on the run
 *            timeline, and the platform's service identity may cancel or resume it (the run-cancel fan-out, the
 *            durable resume cron). Started with a person's token, that takes the web app's signed step grant.
 *   private  anything else a person asks the agent for through this bridge (the workflow author, the account
 *            summary). OWNER-visible, like the person's own chat: no grant is sent, so no colleague and no service
 *            call reaches it.
 */
export type DelegateVisibility = "step" | "private";

/** Thrown when a person's STEP cannot be made the workspace's: the step is not started (see makeDelegate). */
export class StepGrantUnavailable extends Error {}

/**
 * The grant a person's STEP is created with. A step started with a person's token and NO grant would be private to
 * that person — so the run-cancel fan-out and the durable resume, which reach steps as the service, would be refused
 * on it, and a colleague's run timeline would show nothing. That used to happen silently whenever the web app could
 * not sign (no AUTH_JWT_PRIVATE_KEY); now the step is refused instead, loudly, before anything is started.
 */
async function workspaceStepGrant(bearer: string): Promise<string | null> {
  const email = bearerEmail(bearer);
  if (!email) return null; // the service token: a session a service starts is the workspace's already
  const grant = await mintWorkspaceStepGrant(email).catch(() => null);
  if (!grant) {
    throw new StepGrantUnavailable(
      "This workflow step could not be started: the web app cannot sign the workspace step grant (AUTH_JWT_PRIVATE_KEY is not configured), and a step without it could not be cancelled or resumed by the run.",
    );
  }
  return grant;
}

export function makeDelegate(
  bearer: string,
  timeoutMs: number = STEP_TIMEOUT_MS,
  signal?: AbortSignal,
  /** Identity of the run these steps belong to; prepended to every prompt. */
  context?: StepContext,
  /**
   * The workspace these steps act for (the run's, the app's, the schedule's). Sent as a header, never in the
   * prompt: on the front-end's service token it becomes the session's workspace (agent/lib/service-scope.ts);
   * without it a service step resolved to an empty workspace and every by-id tool found nothing. Ignored on a
   * person's token, whose own membership decides.
   */
  orgId?: string | null,
  /** A run/app/cron STEP (workspace-visible) or a PRIVATE request (owner-visible); the safe side by default. */
  visibility: DelegateVisibility = "private",
): StepDelegate {
  return async function delegate(
    prompt: string,
    subagent?: string,
    onSession?: OnStepSession,
    step?: Pick<StepContext, "call" | "phase">,
  ): Promise<string> {
    if (!AGENT_URL) throw new Error("The agent's URL is not configured (NEXT_PUBLIC_EVE_API_URL).");
    const stepContext: StepContext | undefined =
      context || step ? { ...context, ...step } : undefined;

    // The browser subagent's steps get the longer budget.
    const effectiveTimeout = subagent === "browser" ? Math.max(timeoutMs, BROWSER_STEP_TIMEOUT_MS) : timeoutMs;

    const grant = visibility === "step" ? await workspaceStepGrant(bearer) : null;
    const started = await fetch(`${AGENT_URL}/eve/v1/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...(orgId ? { [SERVICE_SCOPE_HEADER]: orgId } : {}),
        // A step belongs to its run, and a run is the workspace's: the run timeline opens every step's session for
        // whoever in the workspace is looking at it (to READ — lib/chat-gate.ts). The agent honours that only with a
        // grant signed here, server-side, for the person whose token creates the step (lib/session-token-kinds.ts).
        // The service token needs none: a session a service starts is the workspace's already.
        ...(grant ? { [SESSION_VISIBILITY_GRANT_HEADER]: grant } : {}),
      },
      body: JSON.stringify({ message: composeStepMessage(prompt, subagent, stepContext) }),
      signal: requestSignal(effectiveTimeout, signal),
    });
    if (!started.ok) {
      throw new Error(`The agent refused the step (${started.status}).`);
    }
    const { sessionId } = (await started.json()) as { sessionId?: string };
    if (!sessionId) throw new Error("The agent did not open a session for this step.");
    // Surface the session immediately — the step is now steerable while it runs.
    onSession?.({ sessionId });
    // Eve cancellation is cooperative and durable. The session's stream remains
    // the source of truth (`turn.cancelled` -> `session.waiting`); aborting our
    // local fetch alone would merely detach and leave the turn running.
    const onAbort = () => void cancelEveSession(sessionId, bearer, orgId);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Read the turn's NDJSON stream and keep the LAST finalized assistant text:
    // interim `message.completed` events narrate tool calls, and the terminal one
    // is the answer (docs/concepts/sessions-runs-and-streaming.md).
    // The orchestrator's own final reply. When it DELEGATES to a subagent it
    // often ends its own turn without echoing the subagent's output — that
    // output lives in the CHILD session, so we read it directly (below).
    let answer = "";
    let childSessionId: string | undefined;

    // Prefer the orchestrator's own reply; else the delegated subagent's own
    // final message, read from its session.
    const finish = async (): Promise<string> => {
      if (answer.trim() || !childSessionId) return answer;
      const child = await readSessionAnswer(childSessionId, bearer, orgId).catch(() => "");
      return child || answer;
    };

    // The Eve stream is durable. Persist a local event-count cursor for this
    // request and reconnect to the SAME session by startIndex after transient
    // disconnects; never start a replacement turn or maintain an in-memory
    // pseudo-stream.
    let streamIndex = 0;
    let reconnects = 0;
    try {
      while (reconnects <= 3) {
        const stream = await fetch(
          `${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${streamIndex}`,
          {
            headers: agentHeaders(bearer, orgId),
            signal: requestSignal(effectiveTimeout, signal),
          },
        );
        if (!stream.ok || !stream.body) {
          throw new Error(`The agent's stream could not be read (${stream.status}).`);
        }
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let event: { type?: string; data?: Record<string, unknown> };
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }
              streamIndex++;
              if (event.type === "message.completed" && typeof event.data?.message === "string") {
                answer = event.data.message as string;
              }
              if (event.type === "subagent.called" && typeof event.data?.childSessionId === "string") {
                childSessionId = event.data.childSessionId as string;
                onSession?.({ sessionId, childSessionId });
              }
              if (event.type === "turn.failed") {
                throw new Error(`The agent failed this step: ${String(event.data?.message ?? "the turn failed")}`);
              }
              if (event.type === "turn.cancelled") {
                throw signal?.reason instanceof Error ? signal.reason : new Error("The agent step was cancelled.");
              }
              if (event.type === "turn.completed" || event.type === "session.completed") {
                await reader.cancel();
                return finish();
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        reconnects++;
      }
      throw new Error("The agent stream disconnected repeatedly before the turn settled.");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Read a session's FINAL assistant text — the last `message.completed`. Used to
 * pull a delegated subagent's output out of its own session when the parent
 * turn doesn't echo it. Bounded so a still-running child mounts at its current
 * state rather than hanging forever.
 */
async function readSessionAnswer(sessionId: string, bearer: string, orgId: string | null | undefined): Promise<string> {
  const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=0`, {
    headers: agentHeaders(bearer, orgId),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: { type?: string; data?: { message?: unknown } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "message.completed" && typeof event.data?.message === "string") {
        answer = event.data.message;
      }
      if (
        event.type === "turn.completed" ||
        event.type === "session.completed" ||
        event.type === "session.waiting"
      ) {
        await reader.cancel();
        return answer;
      }
    }
  }
  return answer;
}
