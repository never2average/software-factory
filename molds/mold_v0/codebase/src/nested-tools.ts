/**
 * The tools a live session uses to spawn and collect children (mold_v0-291, flag nested_runs; src/nested-runs.ts).
 * Listed only to a session's own workspace token that its policy gives them to: never to a person or an account key, so the
 * customer MCP's surface is unchanged. The session is the token's, the workspace the token's: nothing here is taken from the input.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Org } from "./auth.js";
import { PackError } from "./pack-api.js";

const out = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof PackError ? e.message : `failed: ${(e as Error).message}` }] });

export function registerNestedTools(server: McpServer, org: Org) {
  const s = org.agentSession;
  if (!s?.nested || !s.session || !s.run) return; // only a real wake's token
  const ctx = { orgId: org.orgId, sessionId: s.session, runId: s.run, role: org.role ?? null };
  const N = () => import("./nested-runs.js");
  const wrap = <A>(fn: (a: A, n: Awaited<ReturnType<typeof N>>) => Promise<Record<string, unknown>>) => async (a: A) => {
    try { const n = await N(); return out(await fn(a, n)); } catch (e) { return fail(e); }
  };
  if (s.nested.spawn) {
    server.registerTool("spawn", {
      title: "Start a child session",
      description: "Start a child session in its own sandbox, with a program (a typed definition: its inputs are checked) or a prompt. Returns a handle at once; use collect to read its result. Its budget comes out of this session's; a child that waits for a place says so.",
      inputSchema: { program: z.string().optional().describe("A program's id"), prompt: z.string().optional().describe("What the child should do (instead of a program)"), inputs: z.record(z.string(), z.unknown()).optional(), name: z.string().max(80).optional(), budget_usd: z.number().positive().optional() },
    }, wrap((a: Record<string, unknown>, n) => n.spawnChild(ctx, a).then((h) => ({ ...h }))));
    server.registerTool("collect", {
      title: "Read child sessions' results",
      description: "The status of this session's children and, for those that settled, their answer and typed outputs: {status: queued | running | done | error | cancelled, settled, answer, outputs, error}. timeout waits up to that many seconds for all of them to settle (at most 25).",
      inputSchema: { handles: z.array(z.string()).optional(), timeout: z.number().min(0).max(25).optional() }, annotations: { readOnlyHint: true },
    }, wrap((a: { handles?: string[]; timeout?: number }, n) => n.collect(ctx, a)));
    server.registerTool("list_children", {
      title: "List child sessions", description: "This session's children and their status.", inputSchema: {}, annotations: { readOnlyHint: true },
    }, wrap(async (_a: Record<string, never>, n) => ({ children: await n.listChildren(ctx) })));
    server.registerTool("cancel_child", {
      title: "Cancel a child session", description: "Cancel one of this session's children (its unused budget returns to this session).",
      inputSchema: { handle: z.string() }, annotations: { destructiveHint: true },
    }, wrap((a: { handle: string }, n) => n.cancelChild(ctx, a.handle).then((h) => ({ ...h }))));
  }
  if (s.nested.child) server.registerTool("submit_outputs", {
    title: "Hand in this child's result",
    description: "Say this child is done: its answer and its outputs, checked against the program's JSON Schema. If they are refused, what is wrong is said; fix it and call this again.",
    inputSchema: { answer: z.string().optional(), outputs: z.record(z.string(), z.unknown()).optional() },
  }, wrap((a: { answer?: string; outputs?: Record<string, unknown> }, n) => n.submitOutputs(ctx, a)));
}
