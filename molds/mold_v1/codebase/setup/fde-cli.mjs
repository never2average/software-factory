#!/usr/bin/env node
/**
 * The package-name entrypoint: `npx <this package> <command>`.
 *
 * npx resolves a scoped package to a bin named after its last path segment
 * (e.g. "cli"). Without this file `npx <package> mcp` fails with "could not
 * determine executable to run", because npm can't pick between the named bins —
 * a real footgun, since that is the natural thing to type and it's what an MCP
 * config would contain.
 *
 * So this dispatches to the same commands, and both invocation styles work:
 *   npx <package> login       (via this file)
 *   npx -p <package> login    (direct bin)
 *
 * Every product word and the address come from deployment.generated.mjs: this
 * file is the same in every package built from this codebase.
 */
import { DEPLOYMENT } from "./deployment.generated.mjs";

const [cmd, ...rest] = process.argv.slice(2);

const COMMANDS = {
  "fde-login": "./fde-login.mjs",
  login: "./fde-login.mjs",
  "fde-mcp": "./fde-mcp.mjs",
  mcp: "./fde-mcp.mjs",
  "install-skill": "./fde-install-skill.mjs",
  "install-skills": "./fde-install-skill.mjs",
  "fde-install-skill": "./fde-install-skill.mjs",
  skills: "./fde-install-skill.mjs",
};

/** The help text. A package with a baked-in address names its product and leads with the hosted endpoint. */
function helpText(d = DEPLOYMENT) {
  const pkg = d.packageName;
  const c = d.commands;
  if (!d.origin) {
    return [
      "Workspace CLI",
      "",
      "Your deployment also serves MCP directly at <its address>/api/mcp - no package needed.",
      "This package has NO default address: set FDE_OPS_URL=<your deployment's address>,",
      `or save it once with: ${c.login} --url <address>`,
      "",
      "Usage:",
      `  npx ${pkg} ${c.login} --url <address>   Sign in with your work Google account`,
      `  npx ${pkg} ${c.mcp}      Run the MCP server (for your coding agent)`,
      `  npx ${pkg} ${c.installSkills}  Install the setup skills`,
      "",
      "MCP config (Claude Code / Cursor / Codex):",
      `  { "command": "npx", "args": ["-y", "-p", "${pkg}", "${c.mcp}"], "env": { "FDE_OPS_URL": "<address>" } }`,
    ].join("\n");
  }
  return [
    `${d.name} CLI`,
    ...(d.tagline ? [d.tagline] : []),
    "",
    `Connects your coding agent to ${d.name} at ${d.origin}.`,
    "",
    "Simplest: the hosted MCP endpoint - no package needed. In Claude Code:",
    `  ${d.connect.claudeCommand}`,
    "  Get the token with these two calls:",
    `    ${d.connect.tokenCommands.request}`,
    `    ${d.connect.tokenCommands.verify}`,
    "",
    "Or use this package (Google Workspace accounts). The address is built in:",
    `  npx ${pkg} ${c.login}            Sign in with your work Google account`,
    `  npx ${pkg} ${c.mcp}              Run the MCP server (for your coding agent)`,
    `  npx ${pkg} ${c.installSkills}   Install the agent skills`,
    "",
    "MCP config (Claude Code / Cursor / Codex):",
    `  { "command": "npx", "args": ["-y", "${pkg}", "${c.mcp}"] }`,
    "",
    "Another address: --url <address> or FDE_OPS_URL=<address> wins over the built-in one.",
  ].join("\n");
}

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.error(helpText());
  // A package that knows its deployment answers a bare `npx <package>` with help, successfully.
  process.exit(cmd || DEPLOYMENT.origin ? 0 : 1);
}

const target = COMMANDS[cmd];
if (!target) {
  const c = DEPLOYMENT.commands;
  console.error(`Unknown command "${cmd}". Try: ${c.login}, ${c.mcp}, ${c.installSkills} (or --help).`);
  process.exit(1);
}

// Hand the remaining args to the real command, then run it in THIS process so
// stdio stays attached — the MCP server speaks JSON-RPC over stdin/stdout.
process.argv = [process.argv[0], new URL(target, import.meta.url).pathname, ...rest];
await import(target);
