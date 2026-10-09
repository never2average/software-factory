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
 *   npx <package> login            (via this file)
 *   npx -p <package> <direct bin>  (workspace-login here; <name>-login in a
 *                                   package built for a deployment, which has no
 *                                   bare `login` bin: globally installed, that
 *                                   one would shadow the system's)
 *
 * Every product word, the address and the NAME OF EVERY SIBLING MODULE come from
 * deployment.generated.mjs: this file is byte for byte the same in every package
 * built from this codebase, while the files it dispatches to are named after the
 * package that ships them (workspace-login.mjs here; <name>-login.mjs in a
 * deployment's own package, which must not put another company's initials in
 * node_modules).
 */
import { DEPLOYMENT } from "./deployment.generated.mjs";

const [cmd, ...rest] = process.argv.slice(2);

/**
 * What this package answers to: the neutral names, plus whatever this package calls
 * them. In the generic package those are `workspace-login` / `workspace-mcp` /
 * `workspace-install-skill`, and also the names it was published under before
 * (`legacyCommands`), so an MCP config or a note written then keeps working; the help
 * never shows those. A package built for one deployment calls them `login` / `mcp` /
 * `install-skills` and has no legacy names — a package a desk of analysts bought
 * should not take another company's command names, and nothing published points at them.
 */
const C = DEPLOYMENT.commands;
const L = DEPLOYMENT.legacyCommands ?? {};
const M = DEPLOYMENT.modules;
const COMMANDS = {
  login: M.login, [C.login]: M.login,
  mcp: M.mcp, [C.mcp]: M.mcp,
  "install-skills": M.installSkills, "install-skill": M.installSkills, skills: M.installSkills, [C.installSkills]: M.installSkills,
};
for (const [role, old] of Object.entries(L)) if (old && M[role] && !(old in COMMANDS)) COMMANDS[old] = M[role];

/** The help text. A package with a baked-in address names its product and leads with the hosted endpoint. */
function helpText(d = DEPLOYMENT) {
  const pkg = d.packageName;
  const c = d.commands;
  if (!d.origin) {
    return [
      "Workspace CLI",
      "",
      "Your deployment also serves MCP directly at <its address>/api/mcp - no package needed.",
      "This package has NO default address: set WORKSPACE_OPS_URL=<your deployment's address>,",
      `or save it once with: ${c.login} --url <address>`,
      "",
      "Usage:",
      `  npx ${pkg} ${c.login} --url <address>   Sign in with your work Google account`,
      `  npx ${pkg} ${c.login} --url <address> --email <you>   Sign in with a code emailed to you`,
      `  npx ${pkg} ${c.mcp}      Run the MCP server (for your coding agent)`,
      `  npx ${pkg} ${c.installSkills}  Install the setup skills`,
      "",
      "MCP config (Claude Code / Cursor / Codex):",
      `  { "command": "npx", "args": ["-y", "-p", "${pkg}", "${c.mcp}"], "env": { "WORKSPACE_OPS_URL": "<address>" } }`,
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
    "Or use this package. The address is built in. Sign in either way:",
    `  npx ${pkg} ${c.login}            Sign in with your work Google account (opens a browser)`,
    `  npx ${pkg} ${c.login} --email <address>   Sign in with a six-digit code emailed to you`,
    `  npx ${pkg} ${c.mcp}              Run the MCP server (for your coding agent)`,
    `  npx ${pkg} ${c.installSkills}   Install the agent skills`,
    "",
    "MCP config (Claude Code / Cursor / Codex):",
    `  { "command": "npx", "args": ["-y", "${pkg}", "${c.mcp}"] }`,
    "",
    "Another address: --url <address> or WORKSPACE_OPS_URL=<address> wins over the built-in one.",
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
