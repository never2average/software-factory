/**
 * The customer MCP's get_usage tool (mold_v0-260, flag usage_tool, off by default; src/shell-tools.ts USAGE_TOOL_NAMES):
 * spend, runs and tokens for a period, of the caller's own workspace (src/run-analytics.ts usageSummary). A billing
 * manager or owner, or an account key, reads the whole workspace's; anyone else their own runs. Off: not listed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Org } from "./auth.js";
import { featureOn } from "./features.js";
import { usageSummary } from "./run-analytics.js";

export function registerUsageTools(server: McpServer, org: Org) {
  if (!featureOn("usage_tool") || org.staff) return;
  server.registerTool("get_usage", {
    title: "Usage for a period",
    description: "This workspace's spend, runs and tokens for a period (default the last 30 days): the spend in USD, the runs by status, and the tokens in and out by model. Billing managers and owners see the whole workspace's; anyone else their own runs (scope says which).",
    inputSchema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day, YYYY-MM-DD (UTC)"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day, YYYY-MM-DD (UTC; default today)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const out = await usageSummary({ orgId: org.orgId, role: org.role ?? null, userId: org.userId ?? null }, a);
    const text = `${out.scope === "you" ? "Your" : "The workspace's"} usage ${out.period.from} to ${out.period.to}: ${out.spend_usd.toFixed(2)} USD, ${out.runs.total} run(s), ${out.tokens.input} tokens in and ${out.tokens.output} out.`;
    return { content: [{ type: "text", text: `${text}\n\n${JSON.stringify(out)}` }], structuredContent: out };
  });
}
