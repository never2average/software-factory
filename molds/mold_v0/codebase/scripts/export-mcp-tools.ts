// The customer MCP server's tools and slash commands, for the customer docs (/app/docs): asks a real createServer()
// over an in-memory transport and writes web/src/content/mcp-tools.generated.json (name, title, first sentence of the
// description, read-only or not; prompts with their description). The smoke test fails when the file is stale.
//   npx tsx scripts/export-mcp-tools.ts          write it
//   npx tsx scripts/export-mcp-tools.ts --check  exit 1 if it differs from the server
//   npx tsx scripts/export-mcp-tools.ts --full   print the whole surface to stdout instead (server name and version,
//                                                every tool with its schemas, annotations and _meta, every prompt), for a
//                                                before/after diff of a shell or pack change (mold_v0-038, 039)
// The build's host packs first (src/hosts.ts, mold_v0-039): their tools are part of the surface.
import "../src/hosts.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const OUT = path.resolve(import.meta.dirname, "../web/src/content/mcp-tools.generated.json");
/**
 * The docs table's one line: the first sentence, or the first two when the first is a short lead-in ("Start here.").
 * A sentence ends at . ! ? followed by a capital (so "e.g.", "x" and "(web, mobile, ...)" don't end one); long ones are
 * cut at a word, with an ellipsis.
 */
const firstSentence = (s = "") => {
  const parts = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z`"])/);
  let out = parts[0] ?? "";
  for (let i = 1; out.length < 40 && i < parts.length; i++) out += ` ${parts[i]}`;
  return out.length <= 200 ? out : `${out.slice(0, out.lastIndexOf(" ", 197))}…`;
};

export async function mcpCatalog() {
  const server = createServer({ orgId: 0, slug: "docs", name: "Docs" });
  const client = new Client({ name: "docs-export", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] as { name: string; description?: string }[] }));
  await client.close();
  return {
    tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? null, summary: firstSentence(t.description), read_only: t.annotations?.readOnlyHint === true })),
    prompts: prompts.map((p) => ({ name: p.name, summary: firstSentence(p.description) })),
  };
}

/** Everything a client can see: the server's name and version, every tool in full, every prompt with its arguments. */
export async function mcpSurface() {
  const server = createServer({ orgId: 0, slug: "docs", name: "Docs" });
  const client = new Client({ name: "surface-export", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] as unknown[] }));
  const { resources } = await client.listResources().catch(() => ({ resources: [] as unknown[] }));
  await client.close();
  // The platform admins' MCP server (src/admin-mcp.ts), as an owner sees it.
  const { createAdminServer } = await import("../src/admin-mcp.js");
  const adminServer = createAdminServer({ actor: "surface-export", role: "owner", userId: null });
  const adminClient = new Client({ name: "surface-export", version: "1" });
  const [ac, as] = InMemoryTransport.createLinkedPair();
  await Promise.all([adminServer.connect(as), adminClient.connect(ac)]);
  const admin = { server: adminClient.getServerVersion(), tools: (await adminClient.listTools()).tools, prompts: (await adminClient.listPrompts()).prompts };
  await adminClient.close();
  return { server: info, tools, prompts, resources, admin };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--full")) {
    process.stdout.write(`${JSON.stringify(await mcpSurface(), null, 2)}\n`);
    process.exit(0);
  }
  const json = `${JSON.stringify(await mcpCatalog(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const ok = (() => { try { return readFileSync(OUT, "utf8") === json; } catch { return false; } })();
    console.log(ok ? "mcp-tools.generated.json is current" : "mcp-tools.generated.json is stale: run npx tsx scripts/export-mcp-tools.ts");
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  process.exit(0);
}
