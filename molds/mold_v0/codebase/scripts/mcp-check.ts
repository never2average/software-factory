// End-to-end connector check against a live server, the way an MCP client uses it: connect, list tools, prompts and
// resources, read each resource. Never calls a tool that changes anything. A host pack (mold_v0-039) brings its own
// check (packs/<id>/<scripts>/mcp-check.ts, the product's read-only tool calls): when the build has one, it runs instead.
//   APP_API_KEY=<key> npm run mcp:check -- <https://host/mcp>
// The key is read from the environment (or, for old setups, from a legacy connector URL or a file holding one) and
// always sent as an Authorization header to <host>/mcp: it never goes in a request URL.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hostScript } from "./lib/host-packs.js";
import { ENV } from "../src/env-names.js";

const own = hostScript("mcp-check");
if (own) {
  const tsx = path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
  process.exit(spawnSync(tsx, [own.file, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
}

const arg = process.argv[2];
if (!arg) throw new Error("Usage: APP_API_KEY=<key> npm run mcp:check -- <https://host/mcp, or a file containing a connector URL>");
const text = existsSync(arg) ? readFileSync(arg, "utf8") : arg;
const found = text.match(/https?:\/\/[^\s"']+?\/mcp(?:\/(oct_[\w-]+))?(?=[\s"']|$)/);
if (!found) throw new Error("No connector URL found");
const url = found[0].replace(/\/mcp\/oct_[\w-]+$/, "/mcp");
const key = ENV.APP_API_KEY || found[1];
if (!key) throw new Error("Set APP_API_KEY to the account's API key");

let failures = 0;
const ok = (what: string, detail = "") => console.log(`✓ ${what}${detail ? `  ${detail}` : ""}`);
const bad = (what: string, detail: string) => { failures++; console.log(`✗ ${what}  ${detail}`); };

const client = new Client({ name: "mcp-check", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
const info = client.getServerVersion();
info?.name ? ok("initialize", `${info.name} ${info.version}`) : bad("initialize", "no server name");
const { tools } = await client.listTools();
ok("tools/list", `${tools.length} tools`);
const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] as { name: string }[] }));
ok("prompts/list", prompts.map((p) => p.name).join(", ") || "none");
const { resources } = await client.listResources().catch(() => ({ resources: [] as { uri: string }[] }));
for (const r of resources) {
  const { contents } = await client.readResource({ uri: r.uri });
  (contents[0] as { text?: string })?.text ? ok(`resources/read ${r.uri}`) : bad(`resources/read ${r.uri}`, "empty");
}
await client.close();
console.log(failures ? `\n${failures} problem(s)` : "\nconnector check passed");
process.exit(failures ? 1 : 0);
