#!/usr/bin/env node
/**
 * The package-name entrypoint: `npx @delivery-agents/cli <command>`.
 *
 * npx resolves a scoped package to a bin named after its last path segment
 * ("cli"). Without this file `npx @delivery-agents/cli redacted-mcp` fails with
 * "could not determine executable to run", because npm can't pick between the
 * two named bins — a real footgun, since that is the natural thing to type and
 * it's what an MCP config would contain.
 *
 * So this dispatches to the same two commands, and both invocation styles work:
 *   npx @delivery-agents/cli redacted-login       (via this file)
 *   npx -p @delivery-agents/cli redacted-login    (direct bin)
 */
const [cmd, ...rest] = process.argv.slice(2);

const COMMANDS = {
  "redacted-login": "./redacted-login.mjs",
  login: "./redacted-login.mjs",
  "redacted-mcp": "./redacted-mcp.mjs",
  mcp: "./redacted-mcp.mjs",
  "install-skill": "./redacted-install-skill.mjs",
  "redacted-install-skill": "./redacted-install-skill.mjs",
  skills: "./redacted-install-skill.mjs",
};

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.error(
    [
      "Delivered CLI",
      "",
      "Usage:",
      "  npx @delivery-agents/cli redacted-login    Sign in with your work Google account",
      "  npx @delivery-agents/cli redacted-mcp      Run the MCP server (for your coding agent)",
      "  npx @delivery-agents/cli install-skill  Install the Delivered setup skills",
      "",
      "MCP config (Claude Code / Cursor / Codex):",
      '  { "command": "npx", "args": ["-y", "-p", "@delivery-agents/cli", "redacted-mcp"] }',
    ].join("\n"),
  );
  process.exit(cmd ? 0 : 1);
}

const target = COMMANDS[cmd];
if (!target) {
  console.error(`Unknown command "${cmd}". Try: redacted-login, redacted-mcp, install-skill (or --help).`);
  process.exit(1);
}

// Hand the remaining args to the real command, then run it in THIS process so
// stdio stays attached — the MCP server speaks JSON-RPC over stdin/stdout.
process.argv = [process.argv[0], new URL(target, import.meta.url).pathname, ...rest];
await import(target);
