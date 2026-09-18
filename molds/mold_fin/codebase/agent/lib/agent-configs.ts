/**
 * Per-subagent workspace config loader — pause state + custom instructions the
 * Workspace "Agents" tab writes. Read by `agent/instructions/agent-configs.ts`
 * to (a) tell the orchestrator not to delegate to paused subagents and (b)
 * apply each agent's custom instructions when it's used.
 *
 * Fail-safe: no DB / table absent / error → empty (every agent active, no
 * custom instructions), so the agent behaves exactly as before.
 */
import { eq } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { agentConfigs } from "./db/schema.ts";

export interface AgentConfigRow {
  agentKey: string;
  paused: boolean;
  instructions: string | null;
}

export async function loadAgentConfigs(orgId: string): Promise<AgentConfigRow[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx.select().from(agentConfigs).where(eq(agentConfigs.orgId, orgId)),
    );
    return rows.map((r) => ({ agentKey: r.agentKey, paused: r.paused, instructions: r.instructions ?? null }));
  } catch {
    return [];
  }
}

/** Human labels for the known subagent keys (for the injected instructions). */
const AGENT_LABELS: Record<string, string> = {
  research: "Research",
  "customer-context": "Customer context",
  configuration: "Configuration",
  deployment: "Deployment",
  "data-migration": "Data migration",
  evals: "Evals",
  "workflow-author": "Workflow author",
  "app-author": "App author",
  "follow-ups": "Follow-ups",
  browser: "Browser",
  "hfc-kpi-extraction": "HFC KPI extraction",
  "lodr-filings": "LODR filings",
  "investor-presentations": "Investor presentations",
  "annual-report-format": "Annual report format",
};

/** Render the config rows as a system-context block, or null if nothing set. */
export function renderAgentConfigs(rows: AgentConfigRow[]): string | null {
  const paused = rows.filter((r) => r.paused);
  const custom = rows.filter((r) => r.instructions && r.instructions.trim());
  if (paused.length === 0 && custom.length === 0) return null;
  const label = (k: string) => AGENT_LABELS[k] ?? k;
  const lines: string[] = ["## Workspace agent configuration", ""];
  if (paused.length > 0) {
    lines.push(
      `The following subagents are PAUSED — do not delegate to them; do the work yourself or with an active subagent: ${paused.map((p) => label(p.agentKey)).join(", ")}.`,
      "",
    );
  }
  for (const c of custom) {
    lines.push(`When delegating to the ${label(c.agentKey)} subagent, apply these workspace instructions: ${c.instructions!.trim()}`);
  }
  return lines.join("\n");
}
