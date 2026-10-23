/**
 * Worker-sandbox side of developer environments (core/environment.ts): the install script (system-wide, as the
 * sandbox's sudo user) and the harness wiring (as the agent user, into its HOME only). Names the agent can see are
 * neutral: nothing names the product, a simulation or a test.
 */
import { acpTools, SERENA, TOOL, usesAcp, type EnvTool, type SessionEnvironment } from "./environment.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Harnesses with native LSP wiring; the rest get Serena over MCP when the session has language servers. */
const NATIVE_LSP = new Set(["claude-code", "opencode", "kilo"]);
const MCP_CONFIG: Record<string, true> = { codex: true, cline: true, pi: true, antigravity: true };

/** Tools to install for this session on this harness (Serena added where the harness needs it). */
export function toolsFor(harness: string, env: SessionEnvironment): EnvTool[] {
  const tools = env.tools.map((id) => TOOL.get(id)).filter((t): t is EnvTool => !!t);
  const hasServers = tools.some((t) => t.lsp);
  if (hasServers && !NATIVE_LSP.has(harness) && MCP_CONFIG[harness]) tools.push(SERENA);
  if (usesAcp(harness, env)) tools.push(...acpTools(harness));
  return tools;
}

const PRELUDE = String.raw`
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/bin:$PATH"
# apt-get update once per sandbox (each tool is its own call: boat caps a command at 600s).
apt_install() { [ -e /tmp/.apt-updated ] || { $SUDO apt-get update -qq >&2 && touch /tmp/.apt-updated; }; $SUDO apt-get install -y -qq --no-install-recommends "$@" >&2; }
fetch() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }
ensure_node() {
  if [ -x /usr/local/bin/node ] && [ "$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then return 0; fi
  local d; d="$(ls -d /home/*/.nvm/versions/node/v*/bin 2>/dev/null | sort -V -r | head -n1)"
  [ -n "$d" ] && $SUDO install -m 0755 "$d/node" /usr/local/bin/node && $SUDO ln -sf "$d/../lib/node_modules/npm/bin/npm-cli.js" /usr/local/bin/npm
}
npm_g() { ensure_node; $SUDO env "PATH=$PATH" npm install -g --prefix /usr/local --no-fund --no-audit --force "$@" >&2; }
ensure_uv() {
  [ -x /usr/local/bin/uv ] && return 0
  fetch https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-unknown-linux-gnu.tar.gz /tmp/uv.tgz
  tar -xzf /tmp/uv.tgz -C /tmp && $SUDO install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/
}
uv_tool() {
  ensure_uv
  $SUDO env UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv-python /usr/local/bin/uv tool install -q -p 3.13 "$@" >&2
  $SUDO chmod -R a+rX /opt/uv-tools /opt/uv-python 2>/dev/null || true
}
ensure_go() {
  command -v go >/dev/null 2>&1 && return 0
  [ -x /usr/local/go/bin/go ] || { fetch https://go.dev/dl/go1.27.2.linux-amd64.tar.gz /tmp/go.tgz && $SUDO tar -xzf /tmp/go.tgz -C /usr/local; }
  $SUDO ln -sf /usr/local/go/bin/go /usr/local/bin/go
}
ensure_dart() {
  command -v dart >/dev/null 2>&1 && return 0
  apt_install unzip
  fetch https://storage.googleapis.com/dart-archive/channels/stable/release/3.13.5/sdk/dartsdk-linux-x64-release.zip /tmp/dart.zip
  $SUDO rm -rf /opt/dart-sdk && $SUDO unzip -q -o /tmp/dart.zip -d /opt && $SUDO chmod -R a+rX /opt/dart-sdk
  $SUDO ln -sf /opt/dart-sdk/bin/dart /usr/local/bin/dart
}
`;

/**
 * Install script: only the tools this session needs, and only those not already on the sandbox (preinstalled by boat
 * or baked into a worker image): a tool whose binary is on PATH is kept as is. One subshell per tool, so one failure
 * never stops the rest or the session. Prints `ENV <id> present|ok|fail <seconds>` per tool (logs go to stderr).
 * `bash env-install.sh <n>` runs only tool n (0-based): the runner calls it once per tool, each under boat's 600s cap.
 */
export function envInstallScript(tools: EnvTool[]): string {
  const steps = tools.map((t, i) => `[ -z "\${1:-}" ] || [ "$1" = ${i} ] && {
s=$(date +%s)
if ${t.check ?? `command -v ${shq(t.bin)} >/dev/null 2>&1`}; then r=present
elif ( set -e; ${t.install.split("\n").join("\n  ")}
     ${t.check ?? `command -v ${shq(t.bin)} >/dev/null || [ -x /usr/local/bin/${t.bin} ]`} ) >&2; then r=ok; else r=fail; fi
echo "ENV ${t.id} $r $(( $(date +%s) - s ))"
}`).join("\n");
  return `#!/usr/bin/env bash
set -uo pipefail
${PRELUDE}
${steps}
exit 0
`;
}

/** A file the wiring writes into the agent's HOME (relative path). */
interface HomeFile { path: string; content: string }

function serenaArgs(harness: string): string[] {
  // Serena 2.0 contexts: codex and antigravity have their own; `agent` for other autonomous CLIs.
  return ["start-mcp-server", "--context", harness === "codex" || harness === "antigravity" ? harness : "agent", "--project-from-cwd"];
}

/** Claude Code local plugin marketplace for servers without an official plugin. */
function claudeLocalPlugins(servers: EnvTool[]): HomeFile[] {
  const dir = ".local/share/lsp-plugins";
  const files: HomeFile[] = [];
  const plugins = servers.map((t) => {
    const name = t.id.replace(/^lsp\//, "") + "-lsp";
    const [command, ...args] = t.lsp!.command;
    files.push({ path: `${dir}/plugins/${name}/.claude-plugin/plugin.json`, content: JSON.stringify({ name, version: "1.0.0", description: `${t.label} language server` }, null, 2) });
    files.push({ path: `${dir}/plugins/${name}/.lsp.json`, content: JSON.stringify({ [name.replace(/-lsp$/, "")]: { command, args, extensionToLanguage: t.lsp!.extensions } }, null, 2) });
    return { name, source: `./plugins/${name}`, description: `${t.label} language server` };
  });
  files.push({ path: `${dir}/.claude-plugin/marketplace.json`, content: JSON.stringify({ name: "local-lsp", owner: { name: "developer" }, plugins }, null, 2) });
  return files;
}

/**
 * Wiring script for the agent user (run with HOME = the agent's home, cwd = the workspace's parent). Writes config only
 * under $HOME; for Claude Code it also installs the plugins with the CLI itself.
 */
export function harnessWiringScript(harness: string, tools: EnvTool[], env?: SessionEnvironment | null): { script: string; summary: string } {
  const servers = tools.filter((t) => t.lsp);
  const files: HomeFile[] = personaFiles(harness, env);
  const cmds: string[] = [];
  let summary = "no language servers";
  const serena = tools.some((t) => t.id === SERENA.id);
  const serenaServer = { command: "serena", args: serenaArgs(harness) };
  if (harness === "claude-code" && servers.length) {
    const official = servers.filter((t) => t.lsp!.claudePlugin);
    const local = servers.filter((t) => !t.lsp!.claudePlugin);
    if (official.length) {
      cmds.push("claude plugin marketplace add anthropics/claude-plugins-official </dev/null >&2 || true");
      for (const t of official) cmds.push(`claude plugin install ${t.lsp!.claudePlugin}@claude-plugins-official </dev/null >&2 && echo "WIRE ${t.id} plugin" || echo "WIRE ${t.id} fail"`);
    }
    if (local.length) {
      files.push(...claudeLocalPlugins(local));
      cmds.push(`claude plugin marketplace add "$HOME/.local/share/lsp-plugins" </dev/null >&2 || true`);
      for (const t of local) cmds.push(`claude plugin install ${t.id.replace(/^lsp\//, "")}-lsp@local-lsp </dev/null >&2 && echo "WIRE ${t.id} local-plugin" || echo "WIRE ${t.id} fail"`);
    }
    summary = `Claude Code LSP plugins: ${servers.map((t) => t.lsp!.claudePlugin ?? `${t.id.replace(/^lsp\//, "")}-lsp (local)`).join(", ")}`;
  } else if ((harness === "opencode" || harness === "kilo") && servers.length) {
    const lsp = Object.fromEntries(servers.map((t) => [t.id.replace(/^lsp\//, ""), { command: t.lsp!.command, extensions: Object.keys(t.lsp!.extensions) }]));
    const path = harness === "kilo" ? ".config/kilo/kilo.json" : ".config/opencode/opencode.json";
    const instructions = harness === "kilo" && env?.agent_rules ? { instructions: ["~/.config/kilo/AGENTS.md"] } : {};
    files.push({ path, content: JSON.stringify({ $schema: harness === "kilo" ? "https://kilo.ai/config.json" : "https://opencode.ai/config.json", lsp, ...instructions }, null, 2) });
    for (const t of servers) cmds.push(`echo "WIRE ${t.id} config"`);
    summary = `${harness} lsp config: ${Object.keys(lsp).join(", ")}`;
  } else if (serena) {
    if (harness === "codex")
      files.push({ path: ".codex/config.toml.mcp", content: `[mcp_servers.serena]\ncommand = "serena"\nargs = ${JSON.stringify(serenaServer.args)}\nstartup_timeout_sec = 30\n` });
    if (harness === "cline") files.push({ path: ".cline/data/settings/cline_mcp_settings.json", content: JSON.stringify({ mcpServers: { serena: serenaServer } }, null, 2) });
    if (harness === "pi") files.push({ path: ".pi/agent/mcp.json", content: JSON.stringify({ mcpServers: { serena: serenaServer } }, null, 2) });
    if (harness === "antigravity") files.push({ path: ".gemini/config/mcp_config.json", content: JSON.stringify({ mcpServers: { serena: serenaServer } }, null, 2) });
    for (const t of servers) cmds.push(`echo "WIRE ${t.id} serena"`);
    summary = `${harness}: language servers via Serena (MCP)`;
  } else if (servers.length) {
    for (const t of servers) cmds.push(`echo "WIRE ${t.id} unsupported"`);
    summary = `${harness}: no LSP or MCP wiring; language servers installed on PATH only`;
  }
  // Kilo without language servers still needs `instructions` to read the standing rules.
  if (harness === "kilo" && env?.agent_rules && !files.some((f) => f.path === ".config/kilo/kilo.json"))
    files.push({ path: ".config/kilo/kilo.json", content: JSON.stringify({ $schema: "https://kilo.ai/config.json", instructions: ["~/.config/kilo/AGENTS.md"] }, null, 2) });
  if (env?.skills?.length || env?.agent_rules) summary += `; ${env?.skills?.length ?? 0} skill(s)${env?.agent_rules ? " + standing rules" : ""}`;
  const writes = files.map((f) => `mkdir -p "$HOME/${f.path.replace(/\/[^/]+$/, "")}" && printf %s ${b64(f.content)} | base64 -d > "$HOME/${f.path}"`);
  // Codex: the MCP table is appended to config.toml (the credential setup keeps its own top-level keys first).
  if (harness === "codex" && serena) writes.push(`touch "$HOME/.codex/config.toml" && cat "$HOME/.codex/config.toml.mcp" >> "$HOME/.codex/config.toml" && rm -f "$HOME/.codex/config.toml.mcp"`);
  return { script: `set -uo pipefail\n${writes.join("\n")}\n${cmds.join("\n")}\n`, summary };
}

/**
 * The persona's skills (SKILL.md, portable frontmatter: name + description) and standing rules, at each harness's
 * user-level paths (the harnesses' docs, checked 2026-10-14). Kilo takes its rules through `instructions` in kilo.json.
 */
const SKILL_DIRS: Record<string, string> = {
  "claude-code": ".claude/skills", codex: ".agents/skills", opencode: ".config/opencode/skills", kilo: ".kilo/skills",
  pi: ".pi/agent/skills", cline: ".cline/skills", antigravity: ".gemini/antigravity-cli/skills",
};
const RULES_FILES: Record<string, string> = {
  "claude-code": ".claude/CLAUDE.md", codex: ".codex/AGENTS.md", opencode: ".config/opencode/AGENTS.md", kilo: ".config/kilo/AGENTS.md",
  pi: ".pi/agent/AGENTS.md", cline: ".cline/rules/developer.md", antigravity: ".gemini/GEMINI.md",
};
const yamlStr = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());
export function personaFiles(harness: string, env?: SessionEnvironment | null): HomeFile[] {
  const files: HomeFile[] = [];
  const dir = SKILL_DIRS[harness];
  for (const s of dir ? env?.skills ?? [] : [])
    files.push({ path: `${dir}/${s.name}/SKILL.md`, content: `---\nname: ${s.name}\ndescription: ${yamlStr(s.description)}\n---\n\n${s.body.trim()}\n` });
  if (env?.agent_rules && RULES_FILES[harness]) files.push({ path: RULES_FILES[harness]!, content: `${env.agent_rules.trim()}\n` });
  return files;
}

/** Parse `ENV <id> ok|fail <s>` and `WIRE <id> <how>` lines. */
export function parseEnvLines(out: string): { present: string[]; installed: string[]; failed: string[]; seconds: Record<string, number>; wired: Record<string, string> } {
  const present: string[] = [], installed: string[] = [], failed: string[] = [], seconds: Record<string, number> = {}, wired: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^ENV (\S+) (present|ok|fail) (\d+)/.exec(line);
    if (m) { (m[2] === "ok" ? installed : m[2] === "present" ? present : failed).push(m[1]!); seconds[m[1]!] = Number(m[3]); continue; }
    const w = /^WIRE (\S+) (\S+)/.exec(line);
    if (w) wired[w[1]!] = w[2]!;
  }
  return { present, installed, failed, seconds, wired };
}
