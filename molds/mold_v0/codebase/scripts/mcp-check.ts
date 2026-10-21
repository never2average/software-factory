// End-to-end connector check against a live server, the way Claude / ChatGPT use it: connect, list tools, prompts and
// the dashboard resource, then call every read-only tool. Never launches runs or spends inference.
//   OCTILLION_API_KEY=oct_... npm run mcp:check -- <https://host/mcp>
// The key is read from the environment (or, for old setups, from a legacy connector URL or a file holding one) and
// always sent as an Authorization header to <host>/mcp: it never goes in a request URL.
import { readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const arg = process.argv[2];
if (!arg) throw new Error("Usage: OCTILLION_API_KEY=oct_... npm run mcp:check -- <https://host/mcp, or a file containing a connector URL>");
const text = existsSync(arg) ? readFileSync(arg, "utf8") : arg;
const found = text.match(/https?:\/\/[^\s"']+?\/mcp(?:\/(oct_[\w-]+))?(?=[\s"']|$)/);
if (!found) throw new Error("No connector URL found");
const url = found[0].replace(/\/mcp\/oct_[\w-]+$/, "/mcp");
const key = process.env.OCTILLION_API_KEY || found[1];
if (!key) throw new Error("Set OCTILLION_API_KEY to the account's API key");

let failures = 0;
const ok = (what: string, detail = "") => console.log(`✓ ${what}${detail ? `  ${detail}` : ""}`);
const bad = (what: string, detail: string) => { failures++; console.log(`✗ ${what}  ${detail}`); };

const client = new Client({ name: "octillion-mcp-check", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
const info = client.getServerVersion();
ok("initialize", `${info?.name} ${info?.version}`);

const { tools } = await client.listTools();
ok("tools/list", `${tools.length} tools`);
const noUi = tools.filter((t) => !(t._meta as any)?.ui?.resourceUri).map((t) => t.name);
noUi.length ? bad("tools carry the dashboard UI", noUi.join(", ")) : ok("every tool links the dashboard UI");

const { prompts } = await client.listPrompts();
ok("prompts/list", prompts.map((p) => p.name).join(", "));

const { resources } = await client.listResources();
for (const r of resources) {
  const { contents } = await client.readResource({ uri: r.uri });
  const c = contents[0] as { mimeType?: string; text?: string };
  c?.text && c.text.length > 1000 ? ok(`resources/read ${r.uri}`, `${c.mimeType}, ${c.text.length} chars`)
                                  : bad(`resources/read ${r.uri}`, "empty or tiny");
}

// Read-only calls. With no product yet, product-scoped tools must fail with a clear, actionable message.
const calls: [string, Record<string, unknown>][] = [
  ["get_started", {}], ["list_products", {}], ["list_simulations", {}], ["list_agents", {}], ["list_developer_profiles", {}],
  ["browse_task_library", {}], ["get_visibility_report", {}], ["get_product", {}], ["get_onboarding", {}],
  ["search_transcripts", { query: "redis" }],
];
for (const [name, args] of calls) {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text?: string }[]; structuredContent?: unknown };
    const text = r.content?.[0]?.text ?? "";
    const first = text.split("\n")[0].slice(0, 140);
    if (r.isError) console.log(`• ${name} -> error (${Date.now() - t0} ms): ${first}`);
    else if (!r.structuredContent) bad(name, "no structuredContent for the dashboard");
    else ok(name, `${Date.now() - t0} ms: ${first}`);
  } catch (e) {
    bad(name, `protocol failure: ${(e as Error).message}`);
  }
}
await client.close();
console.log(failures ? `\n${failures} problem(s)` : "\nconnector check passed");
process.exit(failures ? 1 : 0);
