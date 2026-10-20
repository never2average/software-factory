/**
 * How to add Octillion to each AI client: the chat apps, the coding agents Octillion measures (the same harness ids as
 * harnesses/registry.json, so the setup page can order them by real-world usage share), and editors. Each entry gives
 * the one way in that client supports best: a one-click install link, a CLI command, a config file snippet, or UI steps.
 *
 * `verified` marks entries checked against the client's own docs; the rest follow the client's documented MCP config
 * shape and say so in the UI ("check your client's docs if this differs"). Clients change these often: keep it honest.
 */
export type Method = "ui" | "cli" | "config" | "link";
export interface ClientEntry {
  id: string;                 // registry harness id where there is one
  client: string;             // display name
  group: "chat" | "agent" | "editor";
  method: Method;
  steps: string;              // one or two sentences
  command?: string;           // a terminal command
  snippet?: string;           // config content
  file?: string;              // where the snippet goes
  install_url?: string;       // one-click install
  verified: boolean;
  /** Back-compat for callers that render { client, steps, snippet }. */
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export function clientCatalog(url: string, key?: string): ClientEntry[] {
  const signIn = key ? "" : " When it asks, sign in with your Octillion account.";
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString("base64");
  const list: ClientEntry[] = [
    { id: "claude", client: "Claude (web & desktop)", group: "chat", method: "ui", verified: true,
      steps: `Settings → Connectors → Add custom connector, name it Octillion and paste the URL.${signIn} On Team and Enterprise plans an owner adds it under Organization settings → Connectors.` },
    { id: "chatgpt", client: "ChatGPT", group: "chat", method: "ui", verified: true,
      steps: `Turn on developer mode, add a custom MCP server with the URL and choose ${key ? "No authentication" : "OAuth"}.${signIn} Business, Enterprise and Edu workspaces may need an admin to allow custom MCP servers.` },

    { id: "claude-code", client: "Claude Code", group: "agent", method: "cli", verified: true,
      steps: `Run this in your project, then type /mcp in Claude Code and choose Authenticate.`,
      command: `claude mcp add --transport http octillion ${url}`,
      file: ".mcp.json (to share it with your team)", snippet: json({ mcpServers: { octillion: { type: "http", url } } }) },
    { id: "codex", client: "Codex CLI", group: "agent", method: "config", verified: false,
      steps: `Add this to your Codex config, restart Codex, and sign in when it asks. Older versions need experimental_use_rmcp_client = true at the top of the file.`,
      file: "~/.codex/config.toml", snippet: `[mcp_servers.octillion]\nurl = "${url}"` },
    { id: "copilot", client: "GitHub Copilot CLI", group: "agent", method: "config", verified: false,
      steps: `Run /mcp add in Copilot CLI and enter the URL as an HTTP server, or add this to its MCP config.${signIn}`,
      file: "~/.copilot/mcp-config.json", snippet: json({ mcpServers: { octillion: { type: "http", url } } }) },
    { id: "cursor", client: "Cursor", group: "agent", method: "link", verified: true,
      steps: `Click Add to Cursor (it opens Cursor's MCP settings with Octillion filled in), then switch the Octillion tools on.${signIn}`,
      install_url: `cursor://anysphere.cursor-deeplink/mcp/install?name=octillion&config=${encodeURIComponent(cursorConfig)}`,
      file: "~/.cursor/mcp.json", snippet: json({ mcpServers: { octillion: { url } } }) },
    { id: "opencode", client: "OpenCode", group: "agent", method: "config", verified: false,
      steps: `Add Octillion as a remote MCP server in your OpenCode config.${signIn}`,
      file: "opencode.json", snippet: json({ $schema: "https://opencode.ai/config.json", mcp: { octillion: { type: "remote", url, enabled: true } } }) },
    { id: "antigravity", client: "Antigravity", group: "agent", method: "config", verified: false,
      steps: `Open the MCP servers settings, add a custom server with the URL (Streamable HTTP).${signIn}`,
      snippet: json({ mcpServers: { octillion: { serverUrl: url } } }) },
    { id: "gemini-cli", client: "Gemini CLI", group: "agent", method: "cli", verified: true,
      steps: `Run this, then restart Gemini CLI.${signIn}`,
      command: `gemini mcp add -t http octillion ${url}`,
      file: "~/.gemini/settings.json", snippet: json({ mcpServers: { octillion: { httpUrl: url } } }) },
    { id: "cline", client: "Cline", group: "agent", method: "config", verified: false,
      steps: `Open MCP Servers → Configure, and add Octillion as a remote server.${signIn}`,
      file: "cline_mcp_settings.json", snippet: json({ mcpServers: { octillion: { type: "streamableHttp", url } } }) },
    { id: "kilo", client: "Kilo Code", group: "agent", method: "config", verified: false,
      steps: `Open MCP settings and add Octillion as a remote (Streamable HTTP) server.${signIn}`,
      file: "mcp_settings.json", snippet: json({ mcpServers: { octillion: { type: "streamable-http", url } } }) },
    { id: "amp", client: "Amp", group: "agent", method: "config", verified: false,
      steps: `Add Octillion to Amp's MCP servers.${signIn}`,
      file: "settings.json", snippet: json({ "amp.mcpServers": { octillion: { url } } }) },
    { id: "droid", client: "Factory droid", group: "agent", method: "ui", verified: false,
      steps: `Open droid's MCP settings (/mcp) and add an HTTP server with the URL.${signIn}` },
    { id: "qwen-code", client: "Qwen Code", group: "agent", method: "config", verified: false,
      steps: `Add Octillion to Qwen Code's settings, then restart it.${signIn}`,
      file: "~/.qwen/settings.json", snippet: json({ mcpServers: { octillion: { httpUrl: url } } }) },
    { id: "pi", client: "Pi", group: "agent", method: "ui", verified: false,
      steps: `Pi has no built-in MCP client we could verify. Use Octillion from Claude, ChatGPT or another client on this list.` },

    { id: "vscode", client: "VS Code (Copilot Chat)", group: "editor", method: "cli", verified: false,
      steps: `Run this, or add the snippet to your workspace, then start the server from the MCP list and sign in.`,
      command: `code --add-mcp '${JSON.stringify({ name: "octillion", type: "http", url })}'`,
      file: ".vscode/mcp.json", snippet: json({ servers: { octillion: { type: "http", url } } }) },
    { id: "windsurf", client: "Windsurf", group: "editor", method: "config", verified: false,
      steps: `Add Octillion to Windsurf's MCP config and refresh the server list.${signIn}`,
      file: "~/.codeium/windsurf/mcp_config.json", snippet: json({ mcpServers: { octillion: { serverUrl: url } } }) },
    { id: "zed", client: "Zed", group: "editor", method: "config", verified: false,
      steps: `Add Octillion as a context server in Zed's settings.${signIn}`,
      file: "settings.json", snippet: json({ context_servers: { octillion: { url } } }) },
  ];
  if (key) list.push({ id: "header", client: "Header-capable clients", group: "agent", method: "config", verified: true,
    steps: `POST ${url.replace(/\/mcp\/.*$/, "/mcp")} with this header.`, snippet: `Authorization: Bearer ${key}` });
  return list;
}
