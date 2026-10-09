/**
 * What a person types to connect a coding agent to THIS deployment.
 *
 * Every application stamped from this codebase serves its own MCP endpoint at
 * `<its address>/api/mcp`. The instructions used to name a shared npm package
 * and NO address, and the package defaulted to one particular product's
 * production URL — so on every other deployment, following the on-screen steps
 * connected your agent to somebody else's app. These strings are therefore
 * BUILT from the deployment's own address and product name, in one place, and
 * the onboarding screen, the invite email and the docs all read them from here.
 *
 * Pure and dependency-free: imported by a client component, a server-only
 * mailer and a plain-node test.
 */

/** "Acme Research" -> "acme-research". The name an agent's config files the server under. */
export function productSlug(productName: string): string {
  const slug = productName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "workspace";
}

/** Shown where the person's real token goes. Never a real value. */
export const TOKEN_PLACEHOLDER = "<token>";

export interface McpConnect {
  slug: string;
  /** `<origin>/api/mcp` */
  endpoint: string;
  /** The two calls that turn an emailed code into a bearer token. */
  tokenCommands: { request: string; verify: string };
  tokenNote: string;
  claudeCommand: string;
  /** Per-client setup. The config shape is NOT the same across clients. */
  clients: { client: string; path: string; snippet: string; note?: string }[];
  /** The npm package, as a documented alternative — always with the address spelled out. */
  packageAlternative: { login: string; claudeCommand: string; note: string };
}

/** The shared package, which has no address of its own. A deployment's OWN package (docs/AGENT_CLI.md) does. */
export const GENERIC_AGENT_PACKAGE = "@delivery-agents/cli";

export function mcpConnect(input: {
  origin: string;
  productName: string;
  email?: string;
  /**
   * This deployment's own published package (built by scripts/build-agent-cli.mjs with the
   * address baked in). Without it the alternative is the generic package plus WORKSPACE_OPS_URL.
   */
  agentPackage?: string;
}): McpConnect {
  const origin = input.origin.replace(/\/+$/, "");
  const slug = productSlug(input.productName);
  const endpoint = `${origin}/api/mcp`;
  const email = input.email ?? "you@company.com";
  const post = (path: string, body: string) =>
    `curl -s -X POST ${origin}${path} -H 'content-type: application/json' -d '${body}'`;
  const header = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;
  const jsonServer = (key: string, extra: string[] = []) =>
    [
      "{",
      `  "${key}": {`,
      `    "${slug}": {`,
      ...extra,
      `      "url": "${endpoint}",`,
      `      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" }`,
      "    }",
      "  }",
      "}",
    ].join("\n");
  return {
    slug,
    endpoint,
    tokenCommands: {
      request: post("/api/auth/email/request", `{"email":"${email}"}`),
      verify: post("/api/auth/email/verify", `{"email":"${email}","code":"123456"}`),
    },
    tokenNote:
      "The first call emails you a six-digit code; put it in the second. The reply's \"token\" is your access token. " +
      "It lasts 7 days, proves only your email address, and stops working for a workspace the moment you leave it.",
    claudeCommand: `claude mcp add --transport http ${slug} ${endpoint} --header "${header}"`,
    clients: [
      {
        client: "Claude Code",
        path: "Run this — it writes the config for you",
        snippet: `claude mcp add --transport http ${slug} ${endpoint} --header "${header}"`,
      },
      {
        client: "Cursor",
        path: "~/.cursor/mcp.json (or .cursor/mcp.json for this project only)",
        snippet: jsonServer("mcpServers"),
      },
      {
        client: "VS Code",
        path: ".vscode/mcp.json",
        snippet: jsonServer("servers", ['      "type": "http",']),
        note: "VS Code keys this on `servers`, not `mcpServers`.",
      },
      {
        client: "Codex CLI",
        path: "~/.codex/config.toml",
        snippet: [
          `[mcp_servers.${slug}]`,
          `url = "${endpoint}"`,
          `http_headers = { "Authorization" = "Bearer ${TOKEN_PLACEHOLDER}" }`,
        ].join("\n"),
        note: "Codex uses TOML, not JSON.",
      },
    ],
    packageAlternative: input.agentPackage
      ? {
          login: `npx ${input.agentPackage} login`,
          claudeCommand: `claude mcp add ${slug} -- npx -y ${input.agentPackage} mcp`,
          note: `Alternative for Google Workspace accounts: the npm package ${input.agentPackage}. ${origin} is built into it, so it needs no configuration.`,
        }
      : {
          // The package entrypoint's own `login` / `mcp`: neutral, and answered by every
          // published version of the generic package (the older ones too, whose direct bins
          // were still named after the base product), so what is printed works whichever
          // version npx resolves. The direct bins are workspace-login / workspace-mcp now, with
          // the old names kept as aliases (setup/package.json).
          login: `npx ${GENERIC_AGENT_PACKAGE} login --url ${origin}`,
          // WORKSPACE_OPS_URL: these instructions are copied into an MCP config by hand and then
          // live there for months, so what is printed today is what a person is still running
          // next year.
          claudeCommand: `claude mcp add ${slug} --env WORKSPACE_OPS_URL=${origin} -- npx -y ${GENERIC_AGENT_PACKAGE} mcp`,
          note: `Alternative for Google Workspace accounts: the npm package. It has no built-in address, so WORKSPACE_OPS_URL=${origin} is required.`,
        },
  };
}
