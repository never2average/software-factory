/**
 * Developer environments: the CLI tools and language servers a developer persona has installed, put into the worker
 * sandbox and wired into the harness the way that developer would have them. No GUI toolchains: an editor is a profile
 * that picks the language servers it ships by default, never the editor itself.
 *
 * Shared by the server (research validation, defaults, the blindness filter at claim time) and the orchestrator
 * (install + harness wiring in the worker sandbox). Every install is pinned, headless and system-wide (/usr/local,
 * /opt), so the unprivileged agent user runs them; config goes into the agent's HOME, never into the workspace (the
 * workspace diff is what gets scored).
 *
 * Wiring per harness:
 *  - claude-code   official LSP plugins from claude-plugins-official; servers without one as a local plugin (.lsp.json)
 *  - opencode/kilo the `lsp` key of the user config (~/.config/opencode/opencode.json, ~/.config/kilo/kilo.json)
 *  - codex, cline, pi, antigravity: no native LSP -> Serena (LSP over MCP) in the harness's MCP config
 */

import { ENV } from "./env-names.js";
export type EditorId = "vscode" | "zed" | "intellij" | "neovim" | "terminal";
export type LanguageId = "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "cpp" | "dart";

export interface LspSpec {
  /** stdio command */
  command: string[];
  extensions: Record<string, string>;
  /** Official plugin in claude-plugins-official (else a local plugin is generated from command/extensions). */
  claudePlugin?: string;
}

export interface EnvTool {
  id: string;
  kind: "server" | "cli";
  label: string;
  /** Names this tool would reveal (vendor, product, binary): a tool that names the product or a competitor is dropped. */
  names: string[];
  /** Binary that must be on the agent PATH afterwards. */
  bin: string;
  /** Bash body (functions from env-install prelude available: SUDO, apt_install, npm_g, fetch, ensure_node). */
  install: string;
  /** Presence check instead of `command -v bin` (for things that are not a binary on PATH). */
  check?: string;
  lsp?: LspSpec;
}

const npmTool = (id: string, label: string, names: string[], bin: string, pkgs: string, extra: Partial<EnvTool> = {}): EnvTool =>
  ({ id, kind: "cli", label, names, bin, install: `npm_g ${pkgs}`, ...extra });
const aptTool = (id: string, label: string, names: string[], bin: string, pkgs: string, extra = ""): EnvTool =>
  ({ id, kind: "cli", label, names, bin, install: `apt_install ${pkgs}${extra ? `\n${extra}` : ""}` });

const TS_EXT = { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" };
const PY_EXT = { ".py": "python", ".pyi": "python" };

export const ENV_TOOLS: EnvTool[] = [
  // ---------------------------------------------------------------- language servers
  { id: "lsp/typescript-language-server", kind: "server", label: "typescript-language-server", names: ["typescript-language-server"], bin: "typescript-language-server",
    install: "npm_g typescript@6.0.3 typescript-language-server@6.0.2",
    lsp: { command: ["typescript-language-server", "--stdio"], extensions: TS_EXT, claudePlugin: "typescript-lsp" } },
  { id: "lsp/vtsls", kind: "server", label: "vtsls", names: ["vtsls"], bin: "vtsls",
    install: "npm_g typescript@6.0.3 @vtsls/language-server@0.3.0",
    lsp: { command: ["vtsls", "--stdio"], extensions: TS_EXT } },
  { id: "lsp/pyright", kind: "server", label: "Pyright", names: ["pyright"], bin: "pyright-langserver",
    install: "npm_g pyright@1.1.414",
    lsp: { command: ["pyright-langserver", "--stdio"], extensions: PY_EXT, claudePlugin: "pyright-lsp" } },
  { id: "lsp/basedpyright", kind: "server", label: "basedpyright", names: ["basedpyright"], bin: "basedpyright-langserver",
    install: "npm_g basedpyright@1.40.2",
    lsp: { command: ["basedpyright-langserver", "--stdio"], extensions: PY_EXT } },
  { id: "lsp/ruff", kind: "server", label: "Ruff language server", names: ["ruff", "Astral"], bin: "ruff",
    install: "uv_tool ruff==0.17.0",
    lsp: { command: ["ruff", "server"], extensions: PY_EXT } },
  { id: "lsp/gopls", kind: "server", label: "gopls", names: ["gopls"], bin: "gopls",
    install: "ensure_go\n$SUDO env PATH=/usr/local/go/bin:$PATH GOBIN=/usr/local/bin GOPATH=/tmp/app-gopath GOCACHE=/tmp/app-gocache go install golang.org/x/tools/gopls@v0.23.0 >&2",
    lsp: { command: ["gopls", "serve"], extensions: { ".go": "go" }, claudePlugin: "gopls-lsp" } },
  { id: "lsp/rust-analyzer", kind: "server", label: "rust-analyzer", names: ["rust-analyzer"], bin: "rust-analyzer",
    install: "fetch https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-12/rust-analyzer-x86_64-unknown-linux-gnu.gz /tmp/ra.gz\ngunzip -f /tmp/ra.gz && $SUDO install -m 0755 /tmp/ra /usr/local/bin/rust-analyzer",
    lsp: { command: ["rust-analyzer"], extensions: { ".rs": "rust" }, claudePlugin: "rust-analyzer-lsp" } },
  { id: "lsp/jdtls", kind: "server", label: "Eclipse JDT Language Server", names: ["jdtls", "Eclipse"], bin: "jdtls",
    install: "apt_install openjdk-21-jdk-headless python3\n" +
      "fetch https://download.eclipse.org/jdtls/milestones/1.62.0/jdt-language-server-1.62.0-202610131109.tar.gz /tmp/jdtls.tgz\n" +
      "$SUDO rm -rf /opt/jdtls && $SUDO mkdir -p /opt/jdtls && $SUDO tar -xzf /tmp/jdtls.tgz -C /opt/jdtls && $SUDO chmod -R a+rX /opt/jdtls\n" +
      // jdtls writes its config area next to the install unless told otherwise: give each user its own.
      "printf '#!/bin/sh\\nexec /opt/jdtls/bin/jdtls -configuration \"$HOME/.cache/jdtls/config\" -data \"$HOME/.cache/jdtls/ws\" \"$@\"\\n' | $SUDO tee /usr/local/bin/jdtls >/dev/null && $SUDO chmod 0755 /usr/local/bin/jdtls",
    lsp: { command: ["jdtls"], extensions: { ".java": "java" }, claudePlugin: "jdtls-lsp" } },
  { id: "lsp/clangd", kind: "server", label: "clangd", names: ["clangd", "LLVM"], bin: "clangd",
    install: "apt_install clangd",
    lsp: { command: ["clangd"], extensions: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cxx": "cpp" }, claudePlugin: "clangd-lsp" } },
  { id: "lsp/dart", kind: "server", label: "Dart analysis server", names: ["dart"], bin: "dart",
    install: "ensure_dart",
    lsp: { command: ["dart", "language-server", "--protocol=lsp"], extensions: { ".dart": "dart" } } },

  // ---------------------------------------------------------------- developer CLIs
  aptTool("cli/jq", "jq", ["jq"], "jq", "jq"),
  aptTool("cli/ripgrep", "ripgrep", ["ripgrep"], "rg", "ripgrep"),
  aptTool("cli/fd", "fd", ["fd"], "fd", "fd-find", "$SUDO ln -sf \"$(command -v fdfind)\" /usr/local/bin/fd"),
  aptTool("cli/httpie", "HTTPie", ["HTTPie"], "http", "httpie"),
  aptTool("cli/make", "GNU Make", ["make"], "make", "make"),
  aptTool("cli/psql", "PostgreSQL client (psql)", ["PostgreSQL", "Postgres", "psql"], "psql", "postgresql-client"),
  aptTool("cli/redis", "Redis CLI", ["Redis", "redis-cli"], "redis-cli", "redis-tools"),
  aptTool("cli/sqlite", "SQLite CLI", ["SQLite", "sqlite3"], "sqlite3", "sqlite3"),
  npmTool("cli/pnpm", "pnpm", ["pnpm"], "pnpm", "pnpm@12.11.2"),
  npmTool("cli/yarn", "Yarn (classic)", ["Yarn"], "yarn", "yarn@1.22.22"),
  npmTool("cli/bun", "Bun", ["Bun", "Oven"], "bun", "bun@1.4.3"),
  { id: "cli/uv", kind: "cli", label: "uv", names: ["uv", "Astral"], bin: "uv", install: "ensure_uv" },
  { id: "cli/gh", kind: "cli", label: "GitHub CLI", names: ["GitHub", "gh"], bin: "gh",
    install: "fetch https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz /tmp/gh.tgz\ntar -xzf /tmp/gh.tgz -C /tmp && $SUDO install -m 0755 /tmp/gh_2.102.0_linux_amd64/bin/gh /usr/local/bin/gh" },
  { id: "cli/kubectl", kind: "cli", label: "kubectl", names: ["Kubernetes", "kubectl"], bin: "kubectl",
    install: "fetch https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl /tmp/kubectl\n$SUDO install -m 0755 /tmp/kubectl /usr/local/bin/kubectl" },
  { id: "cli/terraform", kind: "cli", label: "Terraform", names: ["Terraform", "HashiCorp"], bin: "terraform",
    install: "apt_install unzip\nfetch https://releases.hashicorp.com/terraform/1.16.5/terraform_1.16.5_linux_amd64.zip /tmp/tf.zip\nunzip -o -q /tmp/tf.zip -d /tmp/tf && $SUDO install -m 0755 /tmp/tf/terraform /usr/local/bin/terraform" },
  { id: "cli/aws", kind: "cli", label: "AWS CLI v2", names: ["AWS", "Amazon Web Services", "awscli", "aws-cli"], bin: "aws",
    install: "apt_install unzip\nfetch https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.38.0.zip /tmp/aws.zip\nunzip -o -q /tmp/aws.zip -d /tmp/awscli && $SUDO /tmp/awscli/aws/install --update -i /opt/aws-cli -b /usr/local/bin >&2" },
  { id: "cli/stripe", kind: "cli", label: "Stripe CLI", names: ["Stripe"], bin: "stripe",
    install: "fetch https://github.com/stripe/stripe-cli/releases/download/v1.53.1/stripe_1.53.1_linux_x86_64.tar.gz /tmp/stripe.tgz\ntar -xzf /tmp/stripe.tgz -C /tmp && $SUDO install -m 0755 /tmp/stripe /usr/local/bin/stripe" },
  { id: "cli/flyctl", kind: "cli", label: "flyctl", names: ["Fly.io", "flyctl"], bin: "flyctl",
    install: "fetch https://github.com/superfly/flyctl/releases/download/v0.4.117/flyctl_0.4.117_Linux_x86_64.tar.gz /tmp/fly.tgz\ntar -xzf /tmp/fly.tgz -C /tmp && $SUDO install -m 0755 /tmp/flyctl /usr/local/bin/flyctl" },
  npmTool("cli/vercel", "Vercel CLI", ["Vercel"], "vercel", "vercel@64.0.2"),
  npmTool("cli/netlify", "Netlify CLI", ["Netlify"], "netlify", "netlify-cli@27.12.1"),
  npmTool("cli/supabase", "Supabase CLI", ["Supabase"], "supabase", "supabase@2.120.0"),
  npmTool("cli/firebase", "Firebase CLI", ["Firebase"], "firebase", "firebase-tools@15.33.0"),
  npmTool("cli/wrangler", "Wrangler (Cloudflare Workers)", ["Cloudflare", "Wrangler"], "wrangler", "wrangler@4.151.0"),
];

/**
 * Zed: a Zed developer runs the agent from Zed's agent panel over the Agent Client Protocol, not in a terminal. The
 * worker then launches the harness through ACP (the harness's own ACP mode or its ACP adapter) with a headless client
 * playing Zed (orchestrator/harnesses/acp-client.mjs). Harnesses without an ACP route run as a CLI.
 */
export const ACP_ROUTES: Record<string, { command: string[]; pkg?: string; bin?: string; env?: Record<string, string> }> = {
  "claude-code": { command: ["claude-agent-acp"], pkg: "@agentclientprotocol/claude-agent-acp@0.90.0", bin: "claude-agent-acp" },
  codex: { command: ["codex-acp"], pkg: "@agentclientprotocol/codex-acp@2.2.2", bin: "codex-acp", env: { NO_BROWSER: "1", INITIAL_AGENT_MODE: "agent" } },
  opencode: { command: ["opencode", "acp"] },
  // kilo acp (7.8.8): the prompt never answered in the live smoke run of 2026-10-14; Kilo runs as a CLI until fixed.
  cline: { command: ["cline", "--acp"] },
  pi: { command: ["pi-acp"], pkg: "pi-acp@0.0.34", bin: "pi-acp" },
};
export const ACP_CLIENT_DIR = "/usr/local/lib/acp-client";
export const ACP_CLIENT_PATH = `${ACP_CLIENT_DIR}/acp-client.mjs`;

/** Whether this session runs the harness over ACP (a Zed persona, a harness with a route, APP_ZED_ACP=on). */
export function usesAcp(harness: string, env: SessionEnvironment | null | undefined): boolean {
  // Off until a live run per adapter has confirmed credentials and model selection: APP_ZED_ACP=on enables it.
  return env?.editor === "zed" && !!ACP_ROUTES[harness] && (ENV.APP_ZED_ACP ?? "off").toLowerCase() === "on";
}

/** The ACP client (uploaded next to the install script as acp-client.mjs) plus the harness's ACP adapter, when it has one. */
export function acpTools(harness: string): EnvTool[] {
  const r = ACP_ROUTES[harness];
  if (!r) return [];
  const client: EnvTool = { id: "acp/client", kind: "server", label: "ACP client", names: [], bin: "acp-client.mjs",
    install: `ensure_node\n$SUDO install -D -m 0644 "$ACP_CLIENT_SRC" ${ACP_CLIENT_PATH}\n` +
             `$SUDO env "PATH=$PATH" npm install --prefix ${ACP_CLIENT_DIR} --no-fund --no-audit --no-save @agentclientprotocol/sdk@1.8.0 >&2\n` +
             `$SUDO chmod -R a+rX ${ACP_CLIENT_DIR}`,
    check: `test -r ${ACP_CLIENT_PATH} && test -d ${ACP_CLIENT_DIR}/node_modules/@agentclientprotocol/sdk` };
  return r.pkg ? [client, { id: `acp/${harness}`, kind: "server", label: `${harness} ACP adapter`, names: [], bin: r.bin!, install: `npm_g ${r.pkg}` }] : [client];
}

/** Serena: language servers over MCP, for harnesses without native LSP. Infrastructure, not persona-selectable. */
export const SERENA: EnvTool = { id: "mcp/serena", kind: "server", label: "Serena (LSP over MCP)", names: ["Serena"], bin: "serena",
  install: "ensure_uv\nuv_tool serena-agent==2.0.0" };

export const TOOL = new Map([...ENV_TOOLS, SERENA].map((t) => [t.id, t]));

/** Each editor's default language servers per language (open equivalents where the editor's own engine is not LSP). */
export const EDITORS: Record<EditorId, { label: string; servers: Partial<Record<LanguageId, string[]>> }> = {
  vscode: { label: "VS Code", servers: {
    typescript: ["lsp/typescript-language-server"], javascript: ["lsp/typescript-language-server"], python: ["lsp/pyright"],
    go: ["lsp/gopls"], rust: ["lsp/rust-analyzer"], java: ["lsp/jdtls"], cpp: ["lsp/clangd"], dart: ["lsp/dart"] } },
  zed: { label: "Zed", servers: {
    typescript: ["lsp/vtsls"], javascript: ["lsp/vtsls"], python: ["lsp/basedpyright", "lsp/ruff"],
    go: ["lsp/gopls"], rust: ["lsp/rust-analyzer"], java: ["lsp/jdtls"], cpp: ["lsp/clangd"], dart: ["lsp/dart"] } },
  intellij: { label: "IntelliJ IDEA", servers: {
    typescript: ["lsp/typescript-language-server"], javascript: ["lsp/typescript-language-server"], python: ["lsp/pyright"],
    go: ["lsp/gopls"], rust: ["lsp/rust-analyzer"], java: ["lsp/jdtls"], cpp: ["lsp/clangd"], dart: ["lsp/dart"] } },
  neovim: { label: "Neovim", servers: {
    typescript: ["lsp/typescript-language-server"], javascript: ["lsp/typescript-language-server"], python: ["lsp/pyright"],
    go: ["lsp/gopls"], rust: ["lsp/rust-analyzer"], java: ["lsp/jdtls"], cpp: ["lsp/clangd"], dart: ["lsp/dart"] } },
  terminal: { label: "Terminal only", servers: {} },
};

/** An Agent Skill (SKILL.md) the developer has built up for their kind of work. */
export interface Skill { name: string; description: string; body: string }
/**
 * Persona environment as stored on developer_profiles.environment: editor, CLI tools, the skills they have written for
 * their coding agent (more and deeper with seniority) and their standing instructions to it (a global AGENTS.md).
 */
export interface PersonaEnvironment { editor?: EditorId; tools?: string[]; skills?: Skill[]; agent_rules?: string }
/** What a session gets (resolved on the server at claim). `dropped`: tool ids / skill names withheld for blindness. */
export interface SessionEnvironment {
  editor: EditorId; language: LanguageId | null; tools: string[]; skills?: Skill[]; agent_rules?: string | null; dropped?: string[];
}


/** Every developer has these. */
export const BASE_TOOLS = ["cli/ripgrep", "cli/jq"];
export const DEFAULT_EDITOR: EditorId = "vscode";
export const MAX_PERSONA_TOOLS = 12;
export const SKILL_LIMITS = { max_skills: 6, name: 64, description: 1024, body: 4000, agent_rules: 3000 };
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TEMPLATE_LANGUAGE: Record<string, LanguageId> = {
  "express-ts": "typescript", "nextjs-ts": "typescript", "node-ts": "typescript", "react-native": "typescript",
  fastapi: "python", django: "python", "go-http": "go", "java-spring": "java", "rust-axum": "rust", "cpp-cmake": "cpp", flutter: "dart",
};

export function languageOf(language: string | null | undefined, template?: string | null): LanguageId | null {
  const l = (language ?? "").toLowerCase().replace(/\s+/g, "");
  const map: Record<string, LanguageId> = {
    typescript: "typescript", ts: "typescript", javascript: "javascript", js: "javascript", node: "javascript", "node.js": "javascript",
    python: "python", py: "python", go: "go", golang: "go", rust: "rust", java: "java", kotlin: "java",
    "c++": "cpp", cpp: "cpp", c: "cpp", dart: "dart", flutter: "dart",
  };
  return map[l] ?? (template ? TEMPLATE_LANGUAGE[template] ?? null : null);
}

/** Issues with a persona environment (research validation). */
export function environmentIssues(env: unknown): string[] {
  if (env == null) return [];
  if (typeof env !== "object" || Array.isArray(env)) return ["environment must be an object {editor, tools}"];
  const e = env as PersonaEnvironment;
  const issues: string[] = [];
  if (e.editor !== undefined && !(e.editor in EDITORS)) issues.push(`environment.editor must be one of ${Object.keys(EDITORS).join(", ")}`);
  if (e.tools !== undefined) {
    if (!Array.isArray(e.tools)) issues.push("environment.tools must be a list of tool ids");
    else {
      const bad = e.tools.filter((t) => typeof t !== "string" || !TOOL.has(t) || t === SERENA.id);
      if (bad.length) issues.push(`unknown environment tools: ${bad.join(", ")} (pick from the catalog)`);
      if (e.tools.length > MAX_PERSONA_TOOLS) issues.push(`at most ${MAX_PERSONA_TOOLS} environment tools`);
    }
  }
  if (e.skills !== undefined) {
    if (!Array.isArray(e.skills)) issues.push("environment.skills must be a list of {name, description, body}");
    else {
      if (e.skills.length > SKILL_LIMITS.max_skills) issues.push(`at most ${SKILL_LIMITS.max_skills} skills`);
      const seen = new Set<string>();
      e.skills.forEach((s, i) => {
        if (!s || typeof s.name !== "string" || !SKILL_NAME.test(s.name) || s.name.length > SKILL_LIMITS.name) issues.push(`environment.skills[${i}].name must be lowercase-hyphenated, at most ${SKILL_LIMITS.name} characters`);
        else if (seen.has(s.name)) issues.push(`environment.skills[${i}].name ${s.name} is a duplicate`); else seen.add(s.name);
        if (typeof s?.description !== "string" || !s.description.trim() || s.description.length > SKILL_LIMITS.description) issues.push(`environment.skills[${i}].description must be 1-${SKILL_LIMITS.description} characters`);
        if (typeof s?.body !== "string" || s.body.trim().length < 40 || s.body.length > SKILL_LIMITS.body) issues.push(`environment.skills[${i}].body must be 40-${SKILL_LIMITS.body} characters`);
      });
    }
  }
  if (e.agent_rules !== undefined && (typeof e.agent_rules !== "string" || e.agent_rules.length > SKILL_LIMITS.agent_rules))
    issues.push(`environment.agent_rules must be text of at most ${SKILL_LIMITS.agent_rules} characters`);
  return issues;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, w: string) => w.length > 1 && new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, "i").test(text);

/**
 * The session's environment: the persona's editor (default VS Code) gives the language servers for the task's
 * language; plus the base CLIs and the persona's own tools. Blindness: a tool whose names mention the product or a
 * competitor (or the other way round) is dropped and reported, e.g. no Vercel CLI when Vercel is a competitor.
 */
export function resolveEnvironment(persona: PersonaEnvironment | null | undefined, language: LanguageId | null, blindWords: string[]): SessionEnvironment {
  const editor: EditorId = persona?.editor && persona.editor in EDITORS ? persona.editor : DEFAULT_EDITOR;
  const wanted = [...(language ? EDITORS[editor].servers[language] ?? [] : []), ...BASE_TOOLS, ...(persona?.tools ?? [])];
  const tools: string[] = [], dropped: string[] = [];
  for (const id of [...new Set(wanted)]) {
    const t = TOOL.get(id);
    if (!t || t === SERENA) continue;
    const text = [t.id, t.label, ...t.names].join(" ");
    const clash = blindWords.some((w) => w && (mentions(text, w) || t.names.some((n) => mentions(w, n))));
    (clash ? dropped : tools).push(id);
  }
  // Skills and standing rules are the developer's own words: one that names the product or a competitor is withheld.
  const names = (text: string) => blindWords.some((w) => w && mentions(text, w));
  const skills: Skill[] = [];
  for (const s of persona?.skills ?? []) (names(`${s.name} ${s.description} ${s.body}`) ? dropped.push(`skill:${s.name}`) : skills.push(s));
  let agent_rules: string | null = persona?.agent_rules?.trim() || null;
  if (agent_rules && names(agent_rules)) { dropped.push("agent_rules"); agent_rules = null; }
  return { editor, language, tools, ...(skills.length ? { skills } : {}), ...(agent_rules ? { agent_rules } : {}), ...(dropped.length ? { dropped } : {}) };
}

/** Catalog text for the research prompt. */
export function catalogForPrompt(): string {
  const servers = ENV_TOOLS.filter((t) => t.kind === "server").map((t) => t.id).join(", ");
  const clis = ENV_TOOLS.filter((t) => t.kind === "cli").map((t) => `${t.id} (${t.label})`).join(", ");
  return `editors: ${Object.entries(EDITORS).map(([k, v]) => `${k} (${v.label})`).join(", ")}\n` +
         `language servers (only to add one the editor does not ship by default): ${servers}\nCLI tools: ${clis}`;
}
