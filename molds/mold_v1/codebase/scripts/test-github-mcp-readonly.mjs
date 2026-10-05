/**
 * THE GITHUB CONNECTION EXPOSES READ TOOLS ONLY, WHATEVER THE SERVER ADVERTISES AND WHATEVER THE TOKEN COULD DO.
 *
 * GitHub's hosted MCP server lists write tools beside the read ones (push_files, create_or_update_file,
 * merge_pull_request, ...). "Read-only" used to rest on the token alone. agent/lib/connections.ts now hands eve an
 * allow-list (agent/lib/github-mcp-tools.ts), and this holds it three ways:
 *
 *   1. the list itself: every name on it is one GitHub marks read-only, none is a write tool, and it still carries
 *      what the specialists that hold the connection are asked to do (repositories and files, commits, issues, pull
 *      requests, workflow runs);
 *   2. the definition the agent really hands eve carries that list, with CONNECTIONS_PROVIDER unset and with `env`
 *      (the real modules, loaded in their own process);
 *   3. eve's REAL MCP client, given that definition's filter, against a stand-in server that advertises exactly what
 *      GitHub's server advertised on 2026-10-04 (scripts/fixtures/connections/github-mcp-advertised-tools.json) and
 *      would carry out any call it receives, as a token with write permission would allow: no write tool is listed
 *      to the model, calling one by name is refused before any request is sent, and the read tools are listed and
 *      work. The same client WITHOUT the filter does list and call the write tools, so the stand-in proves something.
 *
 * No request leaves the machine: the stand-in listens on 127.0.0.1.
 *
 *   npm run test:github-mcp-readonly
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PART = process.argv.includes("--part") ? process.argv[process.argv.indexOf("--part") + 1] : null;

if (PART === "definition") {
  // The real agent module and the real eve: what the connection is defined with.
  for (const k of ["CONNECTIONS_WORKSPACE", "GITHUB_MCP_URL", "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "DATABASE_URL", "POSTGRES_URL"]) delete process.env[k];
  const { githubConnection, slackConnection } = await import("../agent/lib/connections.ts");
  process.stdout.write(`\n@@RESULT@@${JSON.stringify({ url: githubConnection.url, tools: githubConnection.tools ?? null, slackTools: slackConnection.tools ?? null })}\n`);
  process.exit(0);
}

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 700)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error) };
  }
};

const advertised = JSON.parse(readFileSync(join(HERE, "fixtures", "connections", "github-mcp-advertised-tools.json"), "utf8"));
const { GITHUB_READ_TOOLS, githubToolFilter } = await import("../agent/lib/github-mcp-tools.ts");
const readOnly = new Map(advertised.all.map((t) => [t.name, t.readOnlyHint]));
const writeTools = advertised.all.filter((t) => !t.readOnlyHint).map((t) => t.name);
const defaultWrites = advertised.default.filter((t) => !t.readOnlyHint).map((t) => t.name);

/* ---- 1. the list ----------------------------------------------------------------------------------------------- */
console.log("1. The allow-list");
{
  check("GitHub's server really does advertise write tools (the recording has them: 18 by default, 32 in all)", defaultWrites.length === 18 && writeTools.length === 32 && defaultWrites.includes("push_files") && defaultWrites.includes("merge_pull_request"), { defaultWrites: defaultWrites.length, all: writeTools.length });
  const unknown = GITHUB_READ_TOOLS.filter((n) => !readOnly.has(n));
  check("every allowed name is a tool GitHub's server has (a misspelt name would allow nothing)", unknown.length === 0, unknown);
  const notRead = GITHUB_READ_TOOLS.filter((n) => readOnly.get(n) !== true);
  check("every allowed name is one GitHub marks read-only", notRead.length === 0, notRead);
  const overlap = GITHUB_READ_TOOLS.filter((n) => writeTools.includes(n));
  check("no write tool is on it", overlap.length === 0, overlap);
  const writeShaped = GITHUB_READ_TOOLS.filter((n) => /(^|_)(write|create|update|delete|push|merge|fork|trigger|add|assign|dismiss|manage|mark|star|unstar|run)(_|$)/.test(n));
  check("…and none is named like one (a new write tool cannot ride in on a read-only annotation)", writeShaped.length === 0, writeShaped);
  check("no name twice", new Set(GITHUB_READ_TOOLS).size === GITHUB_READ_TOOLS.length);
  // What the specialists holding the connection are asked to do, by purpose (no prompt or code names a tool).
  const needed = {
    "repositories and files (data-migration pulls source data from a repo; configuration reads config)": ["search_repositories", "get_file_contents", "search_code", "list_branches"],
    "commits (deployment reports what was deployed)": ["list_commits", "get_commit"],
    "issues": ["list_issues", "issue_read", "search_issues"],
    "pull requests": ["list_pull_requests", "pull_request_read", "search_pull_requests"],
    "workflow runs (deployment, evals)": ["actions_list", "actions_get", "get_job_logs"],
  };
  for (const [purpose, names] of Object.entries(needed)) {
    const missing = names.filter((n) => !GITHUB_READ_TOOLS.includes(n));
    check(`still there: ${purpose}`, missing.length === 0, missing);
  }
  const a = githubToolFilter();
  a.allow.push("push_files");
  check("the filter is a fresh copy each time: widening one does not widen the next", !githubToolFilter().allow.includes("push_files"));
}

/* ---- 2. the definition the agent hands eve ------------------------------------------------------------------- */
console.log("\n2. The connection the agent defines");
const definitions = {};
for (const [label, extra] of [["CONNECTIONS_PROVIDER unset", {}], ["CONNECTIONS_PROVIDER=env", { CONNECTIONS_PROVIDER: "env" }]]) {
  const env = { ...process.env, ...extra };
  if (!("CONNECTIONS_PROVIDER" in extra)) delete env.CONNECTIONS_PROVIDER;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), "--part", "definition"], { encoding: "utf8", env });
  const line = run.stdout.split("\n").find((l) => l.startsWith("@@RESULT@@"));
  const got = line ? JSON.parse(line.slice("@@RESULT@@".length)) : null;
  definitions[label] = got;
  check(`${label}: the GitHub connection carries the allow-list, exactly`, run.status === 0 && JSON.stringify(got?.tools) === JSON.stringify({ allow: [...GITHUB_READ_TOOLS] }), run.status === 0 ? got?.tools : run.stderr.slice(-600));
  check(`${label}: …as an allow-list, not a block-list (a tool GitHub adds later is not exposed)`, got?.tools && "allow" in got.tools && !("block" in got.tools));
  check(`${label}: Slack's connection is untouched (no filter)`, got?.slackTools === null, got?.slackTools);
}

/* ---- 3. eve's real MCP client against a server that advertises writes --------------------------------------- */
console.log("\n3. eve's real MCP client, a server that advertises write tools, a token that could use them");
/** A stand-in MCP server (Streamable HTTP, JSON answers). It lists `tools` and carries out ANY call it is sent. */
function standIn(tools) {
  const seen = { listed: 0, calls: [], bearers: new Set() };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (req.headers.authorization) seen.bearers.add(req.headers.authorization);
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stand-in" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "github-stand-in", version: "0" } });
    if (message.method === "tools/list") {
      seen.listed++;
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: t.readOnlyHint } })) });
    }
    if (message.method === "tools/call") {
      seen.calls.push(message.params.name);
      return reply({ content: [{ type: "text", text: `carried out ${message.params.name}` }] });
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    return reply({});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/mcp/`, seen, close: () => new Promise((r) => server.close(r)) })));
}

// eve's own client, the one its runtime builds for an MCP connection. Not a public export: loaded by path.
const eveClientPath = join(HERE, "..", "node_modules", "eve", "dist", "src", "runtime", "connections", "mcp-client.js");
const { McpConnectionClient, passesToolFilter } = await import(pathToFileURL(eveClientPath).href);
const filter = definitions["CONNECTIONS_PROVIDER unset"]?.tools;
const clientFor = (url, tools) => new McpConnectionClient({ connectionName: "github", url, description: "GitHub", ...(tools ? { tools } : {}), authorization: { principalType: "app", getToken: async () => ({ token: "ghp_a_token_with_write_permission" }) } });

for (const [label, tools] of [["the default URL's 46 tools", advertised.default], ["every toolset's 95 tools", advertised.all]]) {
  const server = await standIn(tools);
  const client = clientFor(server.url, filter);
  try {
    const listed = (await client.getToolMetadata()).map((t) => t.name);
    const upstreamWrites = tools.filter((t) => !t.readOnlyHint).map((t) => t.name);
    check(`${label}: the server advertised ${upstreamWrites.length} write tools and the model is shown none`, server.seen.listed === 1 && upstreamWrites.length > 0 && listed.every((n) => !upstreamWrites.includes(n)), listed.filter((n) => upstreamWrites.includes(n)));
    const expected = GITHUB_READ_TOOLS.filter((n) => tools.some((t) => t.name === n));
    check(`${label}: the model is shown exactly the allowed read tools the server has (${expected.length})`, JSON.stringify([...listed].sort()) === JSON.stringify([...expected].sort()), listed);
    check(`${label}: nothing outside the allow-list is shown`, listed.every((n) => GITHUB_READ_TOOLS.includes(n)));
    const callable = Object.keys(await client.getTools());
    check(`${label}: the callable set is the same set`, JSON.stringify([...callable].sort()) === JSON.stringify([...listed].sort()), callable);
    for (const write of ["push_files", "create_or_update_file", "delete_file", "merge_pull_request"]) {
      const got = await attempt(() => client.executeTool(write, { owner: "o", repo: "r" }));
      check(`${label}: calling ${write} by name is refused`, got.threw && /not found/.test(got.message), got);
    }
    check(`${label}: …and no write call ever reached the server`, server.seen.calls.length === 0, server.seen.calls);
    const read = await attempt(() => client.executeTool("get_file_contents", { owner: "o", repo: "r", path: "README.md" }));
    check(`${label}: a read tool is called, with the bearer`, !read.threw && JSON.stringify(server.seen.calls) === '["get_file_contents"]' && [...server.seen.bearers].join() === "Bearer ghp_a_token_with_write_permission", { read, calls: server.seen.calls });
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
}
{
  // The control: without the filter this same client does list and call the write tools.
  const server = await standIn(advertised.default);
  const client = clientFor(server.url, undefined);
  try {
    const listed = (await client.getToolMetadata()).map((t) => t.name);
    const pushed = await attempt(() => client.executeTool("push_files", {}));
    check("control: WITHOUT the allow-list the same client lists all 46 and carries out push_files", listed.length === 46 && listed.includes("push_files") && !pushed.threw && server.seen.calls.includes("push_files"), { listed: listed.length, pushed });
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
  check("eve matches names exactly: no prefix, suffix or case variant of an allowed name passes", passesToolFilter("get_file_contents", filter) && !passesToolFilter("get_file_contents_and_push", filter) && !passesToolFilter("GET_FILE_CONTENTS", filter) && !passesToolFilter("github__push_files", filter) && !passesToolFilter("", filter));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
for (const label of failed) console.log(`  FAILED: ${label}`);
process.exit(failed.length ? 1 : 0);
