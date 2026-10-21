/**
 * How to add the product to each AI client (its name and MCP server name are the profile's, mold_v0-060): the chat
 * apps, the coding agents (the same harness ids as harnesses/registry.json, so the setup page can order them by real-world usage share), and editors. Each entry gives
 * the one way in that client supports best: a one-click install link, a CLI command, a config file snippet, or UI steps.
 *
 * `verified` marks entries checked against the client's own docs; the rest follow the client's documented MCP config
 * shape and say so in the UI ("check your client's docs if this differs"). Clients change these often: keep it honest.
 */
import { PROFILE } from "./profile.js";

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

/**
 * Without a key, every client connects to the plain URL and signs in (OAuth). With a legacy API key, the key goes in an
 * `Authorization: Bearer` header in each client's own header setting, never in the URL; Claude's and ChatGPT's apps
 * cannot send a header, so they are told to sign in instead.
 */
export function clientCatalog(url: string, key?: string, opts: { signInAvailable?: boolean; name?: string; server?: string } = {}): ClientEntry[] {
  // The product's name and the server's name in each client's config: the profile's (mold_v0-060), never a word in the code.
  const NAME = opts.name ?? PROFILE.name, SERVER = opts.server ?? PROFILE.mcp_server_name;
  const signIn = key ? "" : ` When it asks, sign in with your ${NAME} account.`;
  const auth = key ? `Bearer ${key}` : "";
  const headers = key ? { headers: { Authorization: auth } } : {};
  const noHeader = opts.signInAvailable === false
    ? `This app cannot send an API key header, and this ${NAME} server has no sign-in set up: use a client below that takes a header (Claude Code, Cursor, Codex, VS Code and others).`
    : `This app cannot send an API key header: ask your ${NAME} admin for a sign-in invitation, then connect with sign-in.`;
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString("base64");
  const list: ClientEntry[] = [
    { id: "claude", client: "Claude (web & desktop)", group: "chat", method: "ui", verified: true,
      steps: key ? noHeader : `Settings → Connectors → Add custom connector, name it ${NAME} and paste the URL.${signIn} On Team and Enterprise plans an owner adds it under Organization settings → Connectors.` },
    { id: "chatgpt", client: "ChatGPT", group: "chat", method: "ui", verified: true,
      steps: key ? noHeader : `Turn on developer mode, add a custom MCP server with the URL and choose OAuth.${signIn} Business, Enterprise and Edu workspaces may need an admin to allow custom MCP servers.` },

    { id: "claude-code", client: "Claude Code", group: "agent", method: "cli", verified: true,
      steps: key ? `Run this in your project.` : `Run this in your project, then type /mcp in Claude Code and choose Authenticate.`,
      command: key ? `claude mcp add --transport http ${SERVER} ${url} --header "Authorization: ${auth}"` : `claude mcp add --transport http ${SERVER} ${url}`,
      file: key ? ".mcp.json (keep the key out of version control)" : ".mcp.json (to share it with your team)", snippet: json({ mcpServers: { [SERVER]: { type: "http", url, ...headers } } }) },
    { id: "codex", client: "Codex CLI", group: "agent", method: "config", verified: false,
      steps: `Add this to your Codex config, restart Codex${key ? "" : ", and sign in when it asks"}. Older versions need experimental_use_rmcp_client = true at the top of the file.`,
      file: "~/.codex/config.toml", snippet: `[mcp_servers.${SERVER}]\nurl = "${url}"${key ? `\nhttp_headers = { "Authorization" = "${auth}" }` : ""}` },
    { id: "copilot", client: "GitHub Copilot CLI", group: "agent", method: "config", verified: false,
      steps: `Run /mcp add in Copilot CLI and enter the URL as an HTTP server${key ? " with an Authorization header" : ""}, or add this to its MCP config.${signIn}`,
      file: "~/.copilot/mcp-config.json", snippet: json({ mcpServers: { [SERVER]: { type: "http", url, ...headers } } }) },
    // Cursor's one-click link carries its config in the link itself: offered only when there is no key to put in it.
    { id: "cursor", client: "Cursor", group: "agent", method: key ? "config" : "link", verified: true,
      steps: key ? `Add this to Cursor's MCP config, then switch the ${NAME} tools on.` : `Click Add to Cursor (it opens Cursor's MCP settings with ${NAME} filled in), then switch the ${NAME} tools on.${signIn}`,
      ...(key ? {} : { install_url: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER)}&config=${encodeURIComponent(cursorConfig)}` }),
      file: "~/.cursor/mcp.json", snippet: json({ mcpServers: { [SERVER]: { url, ...headers } } }) },
    { id: "opencode", client: "OpenCode", group: "agent", method: "config", verified: false,
      steps: `Add ${NAME} as a remote MCP server in your OpenCode config.${signIn}`,
      file: "opencode.json", snippet: json({ $schema: "https://opencode.ai/config.json", mcp: { [SERVER]: { type: "remote", url, enabled: true, ...headers } } }) },
    { id: "antigravity", client: "Antigravity", group: "agent", method: "config", verified: false,
      steps: `Open the MCP servers settings, add a custom server with the URL (Streamable HTTP).${signIn}`,
      snippet: json({ mcpServers: { [SERVER]: { serverUrl: url, ...headers } } }) },
    { id: "gemini-cli", client: "Gemini CLI", group: "agent", method: "cli", verified: true,
      steps: `Run this, then restart Gemini CLI.${signIn}`,
      command: key ? `gemini mcp add -t http -H "Authorization: ${auth}" ${SERVER} ${url}` : `gemini mcp add -t http ${SERVER} ${url}`,
      file: "~/.gemini/settings.json", snippet: json({ mcpServers: { [SERVER]: { httpUrl: url, ...headers } } }) },
    { id: "cline", client: "Cline", group: "agent", method: "config", verified: false,
      steps: `Open MCP Servers → Configure, and add ${NAME} as a remote server.${signIn}`,
      file: "cline_mcp_settings.json", snippet: json({ mcpServers: { [SERVER]: { type: "streamableHttp", url, ...headers } } }) },
    { id: "kilo", client: "Kilo Code", group: "agent", method: "config", verified: false,
      steps: `Open MCP settings and add ${NAME} as a remote (Streamable HTTP) server.${signIn}`,
      file: "mcp_settings.json", snippet: json({ mcpServers: { [SERVER]: { type: "streamable-http", url, ...headers } } }) },
    { id: "amp", client: "Amp", group: "agent", method: "config", verified: false,
      steps: `Add ${NAME} to Amp's MCP servers.${signIn}`,
      file: "settings.json", snippet: json({ "amp.mcpServers": { [SERVER]: { url, ...headers } } }) },
    { id: "droid", client: "Factory droid", group: "agent", method: "ui", verified: false,
      steps: `Open droid's MCP settings (/mcp) and add an HTTP server with the URL${key ? " and an Authorization header" : ""}.${signIn}` },
    { id: "qwen-code", client: "Qwen Code", group: "agent", method: "config", verified: false,
      steps: `Add ${NAME} to Qwen Code's settings, then restart it.${signIn}`,
      file: "~/.qwen/settings.json", snippet: json({ mcpServers: { [SERVER]: { httpUrl: url, ...headers } } }) },
    { id: "pi", client: "Pi", group: "agent", method: "ui", verified: false,
      steps: `Pi has no built-in MCP client we could verify. Use ${NAME} from Claude, ChatGPT or another client on this list.` },

    { id: "vscode", client: "VS Code (Copilot Chat)", group: "editor", method: key ? "config" : "cli", verified: false,
      steps: key ? `Add the snippet to your workspace (keep the key out of version control), then start the server from the MCP list.` : `Run this, or add the snippet to your workspace, then start the server from the MCP list and sign in.`,
      ...(key ? {} : { command: `code --add-mcp '${JSON.stringify({ name: SERVER, type: "http", url })}'` }),
      file: ".vscode/mcp.json", snippet: json({ servers: { [SERVER]: { type: "http", url, ...headers } } }) },
    { id: "windsurf", client: "Windsurf", group: "editor", method: "config", verified: false,
      steps: `Add ${NAME} to Windsurf's MCP config and refresh the server list.${signIn}`,
      file: "~/.codeium/windsurf/mcp_config.json", snippet: json({ mcpServers: { [SERVER]: { serverUrl: url, ...headers } } }) },
    { id: "zed", client: "Zed", group: "editor", method: "config", verified: false,
      steps: `Add ${NAME} as a context server in Zed's settings.${signIn}`,
      file: "settings.json", snippet: json({ context_servers: { [SERVER]: { url, ...headers } } }) },
  ];
  if (key) list.push({ id: "header", client: "Header-capable clients", group: "agent", method: "config", verified: true,
    steps: `POST ${url} with this header (or X-API-Key: <key>).`, snippet: `Authorization: ${auth}` });
  return list;
}
