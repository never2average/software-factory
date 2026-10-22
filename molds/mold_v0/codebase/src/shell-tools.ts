/**
 * The shell's own MCP tool names (mold_v0-067), in a module with no imports, so the build reads them as well as the
 * server: scripts/gen-packs.mjs refuses a pack whose own or generated tool would take one of these names (before, the
 * clash was found only when the server started). The lists are the servers' own, checked by the compiler both ways:
 * src/server.ts (none of its own) and src/admin-mcp.ts (ADMIN_TOOLS) fail to typecheck when a tool is added to or removed
 * from either without changing the list here.
 */

/**
 * The customer MCP's own tools: none since mold_v0-039 (the product's 31 are its host pack's, registered through
 * src/host.ts; src/packs.ts reserves a host pack's tool names when the packs are installed, so a pack may not take one).
 */
export const SHELL_TOOL_NAMES = [] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

/** The MCP tools the shell adds when at least one record area is declared (src/record-areas.ts). */
export const RECORD_TOOL_NAMES = ["list_records", "get_record"] as const;

/**
 * The admin MCP's own tools (src/admin-mcp.ts ADMIN_TOOLS). The session engine's job tools (its simulations: list, get,
 * cancel) are its host pack's since mold_v0-049, added through src/host.ts at the same places.
 */
export const ADMIN_SHELL_TOOL_NAMES = [
  "list_accounts", "get_account", "list_access_requests", "health_summary", "finops_revenue",
  "finops_plans", "finops_experiments", "model_spend", "analytics_overview", "list_settings", "key_vault_status",
  "approve_access_request", "decline_access_request", "set_account_allowance", "allow_prepaid_plans", "create_plan", "archive_plan",
  "set_plan_experiment", "update_setting",
] as const;
export type AdminShellToolName = (typeof ADMIN_SHELL_TOOL_NAMES)[number];

/** True only when A and B are the same union (used by the servers to hold this list to their own). */
export type SameNames<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
