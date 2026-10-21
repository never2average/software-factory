/**
 * The shell's own MCP tool names (mold_v0-067), in a module with no imports, so the build reads them as well as the
 * server: scripts/gen-packs.mjs refuses a pack whose own or generated tool would take one of these names (before, the
 * clash was found only when the server started). The lists are the servers' own, checked by the compiler both ways:
 * src/server.ts (handlersFor) and src/admin-mcp.ts (ADMIN_TOOLS) fail to typecheck when a tool is added to or removed
 * from either without changing the list here.
 */

/** The customer MCP's own tools (src/server.ts handlersFor). */
export const SHELL_TOOL_NAMES = [
  "get_started", "list_products", "onboard_product", "get_onboarding", "get_product", "save_product", "save_scenarios", "run_simulation",
  "list_simulations", "get_simulation", "cancel_simulation", "get_visibility_report", "export_visibility_report", "get_agent_session",
  "get_session_transcript", "search_transcripts", "list_developer_profiles", "list_agents", "browse_task_library", "save_harness_mix",
  "list_harness_mixes", "review_draft_tasks", "save_personas", "list_personas", "import_tasks", "list_task_sets", "publish_to_library",
  "register_harness", "list_harnesses", "save_to_memory", "search_memory",
] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

/** The MCP tools the shell adds when at least one record area is declared (src/record-areas.ts). */
export const RECORD_TOOL_NAMES = ["list_records", "get_record"] as const;

/** The admin MCP's own tools (src/admin-mcp.ts ADMIN_TOOLS). */
export const ADMIN_SHELL_TOOL_NAMES = [
  "list_accounts", "get_account", "list_access_requests", "health_summary", "list_simulations", "get_simulation", "finops_revenue",
  "finops_plans", "finops_experiments", "model_spend", "analytics_overview", "list_settings", "key_vault_status", "library_stats",
  "approve_access_request", "decline_access_request", "set_account_allowance", "allow_prepaid_plans", "create_plan", "archive_plan",
  "set_plan_experiment", "update_setting", "cancel_simulation",
] as const;
export type AdminShellToolName = (typeof ADMIN_SHELL_TOOL_NAMES)[number];

/** True only when A and B are the same union (used by the servers to hold this list to their own). */
export type SameNames<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
