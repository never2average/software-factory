/**
 * Project-workflow definition loader + renderer for the agent.
 *
 * The Workspace "Project workflows" builder writes workflow definitions (stages
 * with assign rules + transitions). This injects them into the agent so that
 * when it manages tasks or implementations it knows: which stages exist, HOW to
 * assign a person into each stage (including free-text "prompt" rules it must
 * interpret), and WHEN/HOW an item advances (manual / rule / prompt).
 *
 * Fail-safe: no DB / table absent / error → empty (no injection).
 */
import { eq } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { workflowDefinitions } from "./db/schema.ts";
import { fill } from "./agent-vocabulary.ts";

interface AssignRule {
  type: string;
  value?: string;
}
interface Transition {
  to: string;
  migrate: { type: string; value?: string };
}
interface Stage {
  id: string;
  label: string;
  description?: string;
  assign?: AssignRule;
  transitions?: Transition[];
}
interface WorkflowDef {
  id: string;
  name: string;
  entity: string;
  stages: Stage[];
}

export async function loadWorkflowDefs(orgId: string): Promise<WorkflowDef[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.orgId, orgId)),
    );
    return rows.map((r) => ({ id: r.id, name: r.name, entity: r.entity, stages: (r.stages as Stage[]) ?? [] }));
  } catch {
    return [];
  }
}

function assignText(a: AssignRule | undefined): string {
  if (!a) return "no auto-assign";
  switch (a.type) {
    case "role":
      return `assign anyone with the "${a.value}" role`;
    case "person":
      return `always assign ${a.value}`;
    case "team":
      return `round-robin across the ${a.value} team`;
    case "customer_owner":
      return fill("assign the related {account}'s owner");
    case "least_loaded":
      return `assign the least-loaded person${a.value ? ` in ${a.value}` : ""}`;
    case "prompt":
      return `decide who to assign using this rule: "${a.value}"`;
    default:
      return "no auto-assign";
  }
}
function migrateText(m: Transition["migrate"]): string {
  switch (m.type) {
    case "rule":
      return `when: ${m.value}`;
    case "prompt":
      return `advance when this holds: "${m.value}"`;
    default:
      return "moved manually";
  }
}

export function renderWorkflowDefs(defs: WorkflowDef[]): string | null {
  if (defs.length === 0) return null;
  const lines: string[] = [
    fill("## Project workflows (how to manage tasks / {implementations})"),
    "",
    fill("When you move or create a task or {implementation}, follow the workspace's workflow for that entity: put it in the right stage, apply the stage's assignment rule (assign the owner via `reassign_owner` / the todo's assignee), and only advance it along a defined transition when the migration condition is met. Interpret free-text (prompt) rules yourself."),
  ];
  for (const def of defs) {
    const byId = new Map(def.stages.map((s) => [s.id, s.label]));
    lines.push("", `### ${def.name} — governs ${def.entity}s`);
    for (const s of def.stages) {
      lines.push(`- **${s.label}**${s.description ? ` — ${s.description}` : ""}`);
      lines.push(`  - Assign: ${assignText(s.assign)}.`);
      if (s.transitions && s.transitions.length > 0) {
        for (const t of s.transitions) {
          lines.push(`  - → ${byId.get(t.to) ?? "?"}: ${migrateText(t.migrate)}.`);
        }
      } else {
        lines.push("  - Terminal stage (no onward transitions).");
      }
    }
  }
  return lines.join("\n");
}
