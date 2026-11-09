/**
 * The workspace agent's MCP tools (mold_v0-243; src/harness-sessions.ts, src/shell-tools.ts AGENT_TOOL_NAMES): listed
 * only while the app's profile turns `agent_harness` on, so a build without it (the zero-pack surface included) lists
 * exactly what it did. The same rules as the console: a member or more starts a session, only the person who started
 * one messages or resumes it, the starter or an owner pauses, stops and decides, a billing manager or owner raises.
 * The admin MCP's (agentAdminTools): every workspace's sessions, and stop.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Org } from "./auth.js";
import { agentHarnessOn } from "./agent-harness-config.js";
import { PackError } from "./pack-api.js";
import * as H from "./harness-sessions.js";

const actorFor = (org: Org): H.Actor => (org.userId
  ? { kind: "person", user: org.userId, name: org.userId, role: org.role ?? null }
  : { kind: "key", user: null, name: org.keyId ? `account key ${org.keyId}` : "an account key", role: null });

const out = (summary: string, data: unknown) => ({ content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data)}` }], structuredContent: data as Record<string, unknown> });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof PackError ? e.message : `failed: ${(e as Error).message}` }] });
const wrap = <A>(fn: (a: A) => Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
const brief = (s: H.SessionView) => `${s.title} (${s.id}): ${s.phase.replace("_", " ")}, $${s.spent_usd.toFixed(2)} of $${s.budget_usd.toFixed(2)}${s.pending_request ? `; waiting on ${s.pending_request.kind} ${s.pending_request.subject}` : ""}`;

export function registerAgentTools(server: McpServer, org: Org) {
  // A session's own token (mold_v0-250) never reaches these: an agent does not start, steer or approve sessions.
  if (!agentHarnessOn() || org.staff || org.agentSession) return;
  const id = z.string().describe("The session's id (hss_..., list_agent_sessions)");
  server.registerTool("list_agent_sessions", {
    title: "List agent sessions",
    description: "This workspace's agent sessions, newest activity first: each one's phase (starting, working, waiting, parked, waking, paused, awaiting approval, stopped, failed, archived), its budget and spend, and what it is waiting on.",
    inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true },
  }, wrap(async (a: { limit?: number }) => { const s = await H.listSessions(org.orgId, actorFor(org), { limit: a.limit }); return out(`${s.length} session(s).${s.length ? "\n" + s.slice(0, 20).map(brief).join("\n") : ""}`, { sessions: s }); }));
  server.registerTool("start_agent_session", {
    title: "Start an agent session",
    description: "Start a long-lived agent in its own workspace with a first message. conversation (the default) waits for more messages and parks when quiet (the next message wakes it); task ends once its work is answered. It spends from its own budget.",
    inputSchema: { message: z.string().describe("What the agent should do"), title: z.string().optional(), mode: z.enum(["conversation", "task"]).optional(),
      // mold_v0-261: the agent profile it runs with (its instructions, model, budget, tools); the Default when none is named.
      profile: z.string().optional().describe("The agent profile it runs with, by id (the platform's staff set them up); default: the Default profile") },
  }, wrap(async (a: { message: string; title?: string; mode?: string; profile?: string }) => { const s = await H.startSession(org.orgId, actorFor(org), a, org); return out(`Started: ${brief(s)}.`, { session: s }); }));
  server.registerTool("read_agent_session", {
    title: "Read an agent session",
    description: "One agent session: its transcript, what it asked for and the decisions, budget raises, wakes and spend.",
    inputSchema: { session: id }, annotations: { readOnlyHint: true },
  }, wrap(async (a: { session: string }) => { const s = await H.readSession(org.orgId, a.session, actorFor(org)); return out(brief(s), { session: s }); }));
  server.registerTool("message_agent_session", {
    title: "Message an agent session",
    description: "Send guidance to a session you started: a running one takes it mid-run (within seconds), a parked or paused one is woken by it. Refused while it waits for a decision on what it asked for.",
    inputSchema: { session: id, message: z.string() },
  }, wrap(async (a: { session: string; message: string }) => { const r = await H.messageSession(org.orgId, a.session, actorFor(org), a.message, org); return out(r.status === "waking" ? "Sent: the session is waking up to answer it." : "Sent: the session takes it at its next step.", r); }));
  for (const [name, title, desc, run] of [
    ["pause_agent_session", "Pause an agent session", "Pause a session: a running one stops and keeps its place (resume_agent_session continues it).", (s: string) => H.pauseSession(org.orgId, s, actorFor(org))],
    ["resume_agent_session", "Resume an agent session", "Resume a paused or parked session you started, where it left off.", (s: string) => H.resumeSession(org.orgId, s, actorFor(org), org)],
    ["stop_agent_session", "Stop an agent session", "Stop a session for good: a turn in progress finishes, then it ends and becomes read only.", (s: string) => H.stopSession(org.orgId, s, actorFor(org))],
  ] as const) server.registerTool(name, { title, description: desc, inputSchema: { session: id }, annotations: { destructiveHint: name === "stop_agent_session" } },
    wrap(async (a: { session: string }) => { const s = await run(a.session); return out(brief(s), { session: s }); }));
  server.registerTool("decide_agent_request", {
    title: "Approve or decline what an agent asked for",
    description: "A session that asked to reach a web host or use a tool waits for this: approve grants exactly that to the session and it continues; decline records the refusal (with your reason) and the session is told at its next message. A budget request is approved with raise_agent_budget.",
    inputSchema: { session: id, request: z.string().describe("The request's id (hsr_..., its pending_request)"), decision: z.enum(["approve", "decline"]), reason: z.string().optional() },
  }, wrap(async (a: { session: string; request: string; decision: string; reason?: string }) => { const s = await H.decideRequest(org.orgId, a.session, a.request, actorFor(org), a.decision, a.reason, org); return out(brief(s), { session: s }); }));
  server.registerTool("raise_agent_budget", {
    title: "Raise an agent session's budget",
    description: "Raise a session's budget, with a reason (kept with the raise), up to the platform's ceiling for a session, at any time (while it works too); a session waiting on its budget continues. Billing managers and owners.",
    inputSchema: { session: id, to_usd: z.number().positive().optional(), by_usd: z.number().positive().optional(), reason: z.string() },
  }, wrap(async (a: { session: string; to_usd?: number; by_usd?: number; reason: string }) => { const s = await H.raiseBudget(org.orgId, a.session, actorFor(org), { ...a, raise_only: true }, org); return out(brief(s), { session: s }); }));
}

/** The admin MCP's agent tools (src/admin-mcp.ts adminTools), with the flag on: every workspace's sessions, and stop. */
export function agentAdminTools(): Record<string, { title: string; description: string; needs: "read" | "accounts"; destructive?: boolean; input: z.ZodRawShape; run: (a: Record<string, any>, c: { actor: string }) => Promise<unknown>; summary: (d: any) => string }> {
  if (!agentHarnessOn()) return {};
  return {
    list_agent_sessions: {
      title: "Agent sessions", needs: "read",
      description: "Every workspace's agent sessions, newest activity first: phase, workspace, budget, spend and what each waits on.",
      input: { limit: z.number().int().min(1).max(500).optional() },
      run: async (a, c) => ({ sessions: await H.listSessions(null, H.staffActor(c.actor), { limit: a.limit }) }),
      summary: (d) => `${d.sessions.length} session(s); ${d.sessions.filter((s: H.SessionView) => s.phase === "working" || s.phase === "waiting").length} live.`,
    },
    stop_agent_session: {
      title: "Stop an agent session", needs: "accounts", destructive: true,
      description: "Stop one workspace's agent session for good (a turn in progress finishes). Staff never message a session: it acts for the person who started it.",
      input: { session: z.string() },
      run: async (a, c) => ({ session: await H.stopSession(null, String(a.session), H.staffActor(c.actor)) }),
      summary: (d) => `${d.session.title}: ${d.session.phase}.`,
    },
  };
}
