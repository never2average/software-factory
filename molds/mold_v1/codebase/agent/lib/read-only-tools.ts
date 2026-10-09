/**
 * TOOLS KNOWN NOT TO CHANGE ANYTHING — an explicit allow-list.
 *
 * The empty-response guard (agent/lib/empty-model-response.ts) withholds a recovered answer that
 * claims a write only when it can PROVE nothing could have written: every successful tool result
 * since the person's message came from a tool on this list, or there are none. Anything else — a
 * subagent or delegation (a pack's specialists do their writes there), `bash`, `remember`, a pack's
 * own tool, a remote MCP call, a tool added next month — is possible write evidence, and the guard
 * stands down. Listing reads, not writes, is the point: an unknown tool fails SAFE (a true answer is
 * delivered) instead of failing into withholding one.
 *
 * Add a tool here only when it cannot change stored state, the data room, the sandbox, memory, a
 * schedule, an external system or a message queue. When unsure, leave it out.
 *
 * Both spellings match: the base name and the name the model reads under a relabelling profile
 * (`get_customer` / `get_company`), derived from the vocabulary at module load — no registry, so
 * no dependence on which module instance loaded the tools first.
 */
import { TOOL_ALIASES, speakIdentifier } from "./agent-vocabulary.ts";

export const READ_ONLY_BASE_TOOLS: readonly string[] = [
  // this codebase's model-facing tools that only read
  "get_customer",
  "list_customers",
  "list_stale_customers",
  "match_customer_by_email",
  "read_customer_slas",
  "list_triage_tickets",
  "list_urgent_tickets",
  "list_members",
  "list_roster",
  "list_followups",
  "list_memories",
  "list_todos",
  "list_schedules",
  "list_syncs",
  "list_cycles",
  "list_apps",
  "get_oncall",
  "get_signoff_status",
  "granola_search_notes",
  "email_list_inbox",
  "dataroom_list",
  "dataroom_read",
  "read_image",
  "web_search",
  "mcp_connectors",
  "mcp_tools",
  "browser_read",
  "browser_screenshot",
  // eve framework tools that only read
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "load_skill",
];

// A tool's old name (TOOL_ALIASES) is read-only exactly when its tool is: a transcript stored before the rename
// still proves nothing was written by it.
const ALIASES_OF = (base: string) => Object.entries(TOOL_ALIASES).filter(([, now]) => now === base).map(([old]) => old);
const NAMES: ReadonlySet<string> = new Set(READ_ONLY_BASE_TOOLS.flatMap((n) => [n, speakIdentifier(n), ...ALIASES_OF(n)]));

export function isReadOnlyTool(name: string): boolean {
  return NAMES.has(name);
}
