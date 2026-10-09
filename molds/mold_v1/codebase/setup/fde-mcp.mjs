#!/usr/bin/env node
/**
 * The MCP server's file under its pre-rename name, kept so an MCP config written
 * with `setup/fde-mcp.mjs` (TEAM-SETUP.md said so) still starts the server. The
 * code is in workspace-mcp.mjs; loading it starts it.
 */
export * from "./workspace-mcp.mjs";
