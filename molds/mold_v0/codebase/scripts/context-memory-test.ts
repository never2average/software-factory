// The account context and memory component (mold_v0-142; src/account-context.ts, src/account-context-tools.ts), offline:
// throwaway build copies for what gen-packs writes and refuses, then the server's modules in this process (an embedded
// database, the offline Clerk) with the declarative fixture's config turned on, and off.
//   npm run test:context-memory
//
// 1. A pack.json `memory` (scripts/fixtures/packs/fixture_memory: a pack.json and nothing else) reaches the server as
//    PACK_CONFIG memory and the console as CONTEXT_MEMORY (its pages, their old names, its words) with a Context group in
//    the sidebar; a build without it writes those files exactly as the shell's own.
// 2. Refused, naming the pack: two packs turning it on, an old page name that is a page or names none, tool words without
//    tools, a word the component does not have, and a host pack's console page under /app/context.
// 3. Off (no config): no tool, nothing added to the instructions, no /api/app/context route: the customer MCP server's
//    initialize and tools/list are byte for byte what the shell answers without the component.
// 4. On: its two tools under the fixture's names, after the host packs' tools and before the packs', in its words; the
//    company's and the person's context and the latest memory in the instructions at connect time (over /mcp), in the
//    fixture's words; the portal's routes (owners edit the company's context, members their own and add memory, viewers
//    read; another person's memory only for owners; any subject name kept as written without a host hook); save and
//    search from the AI client (a viewer's save refused, another person's memory never found).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup as cleanupWorld, connect, startHttp, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "context-memory-"));
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_memory", "pack.json"), "utf8"));
let n = 0;

/** A throwaway copy of this codebase (its node_modules linked) with these packs and console files; gen-packs run in it. */
function world(packs: Record<string, Record<string, string>>, web: Record<string, string> = {}, profile: Record<string, unknown> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, files] of Object.entries(packs)) for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, "packs", id, f)), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, f), text);
  }
  for (const [f, text] of Object.entries(web)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");
const pack = (json: unknown) => ({ "pack.json": JSON.stringify(json, null, 2) });
const withMemory = (memory: unknown, id = "fixture_memory") => ({ ...FIXTURE, id, name: id, memory });

try {
  // ---------- 1. what gen-packs writes ----------
  {
    const on = world({ fixture_memory: pack(FIXTURE) });
    assert.equal(on.status, 0, on.out);
    const hostsGen = read(on.dir, "src/hosts.generated.ts");
    const config = JSON.parse(/export const PACK_CONFIG: readonly unknown\[\] = ([\s\S]*?);\n/.exec(hostsGen)![1]!);
    const { $comment: _c, ...memory } = FIXTURE.memory;
    assert.deepEqual(config, [{ pack: "fixture_memory", memory }], "pack.json memory reaches the server as PACK_CONFIG, without its $comment");
    const facts = read(on.dir, "web/src/config/build-facts.generated.ts");
    const cm = JSON.parse(/export const CONTEXT_MEMORY = ([\s\S]*?);\n/.exec(facts)![1]!);
    assert.deepEqual(cm.sections.map((s: { path: string; title: string }) => [s.path, s.title]),
      [["/app/context/company", "Company"], ["/app/context/users", "Users · Context"], ["/app/context/products", "Clients"]], "its pages, in the scopes' order, titled");
    assert.deepEqual(cm.aliases, { you: "users" });
    assert.equal(cm.words.subject_label, "Client", "its words");
    assert.equal(cm.words.you_label, "You", "the shell's default for a word it does not give");
    assert.match(read(on.dir, "web/src/config/pack-host-nav.generated.ts"), /"label": "Context"[\s\S]*"url": "\/app\/context\/company"[\s\S]*"url": "\/app\/context\/products"/,
      "a Context group in the sidebar when no pack places the pages");
    const off = world({});
    assert.equal(off.status, 0, off.out);
    for (const f of ["src/hosts.generated.ts", "web/src/config/build-facts.generated.ts", "web/src/config/pack-host-nav.generated.ts"])
      assert.equal(read(off.dir, f), read(ROOT, f), `${f}: a build without it writes what the shell's own does`);
    console.log("✓ pack.json memory reaches PACK_CONFIG and CONTEXT_MEMORY (pages, old names, words) and the sidebar; without it the generated files are the shell's own");
  }

  // ---------- 2. refusals ----------
  {
    const refused = (what: string, packs: Record<string, Record<string, string>>, re: RegExp, web: Record<string, string> = {}) => {
      const w = world(packs, web);
      assert.notEqual(w.status, 0, `${what}: refused`);
      assert.match(w.out, re, `${what}: ${w.out.slice(-600)}`);
    };
    refused("two packs turning it on", { fixture_memory: pack(FIXTURE), fixture_second: pack(withMemory(FIXTURE.memory, "fixture_second")) }, /memory: pack fixture_memory turns the account context and memory component on too/);
    refused("an old name that is a page", { fixture_memory: pack(withMemory({ ...FIXTURE.memory, pages: { aliases: { users: "company" } } })) }, /memory\.pages\.aliases users: it is one of the pages/);
    refused("an old name for a page the build lacks", { fixture_memory: pack(withMemory({ scopes: ["company"], pages: { aliases: { you: "users" } } })) }, /memory\.pages\.aliases you: users is not one of the pages/);
    refused("tool words without tools", { fixture_memory: pack(withMemory({ scopes: ["company"], tool_words: { save: { title: "x" } } })) }, /memory\.tool_words: name the tools/);
    refused("a word it does not have", { fixture_memory: pack(withMemory({ scopes: ["company"], words: { no_such_word: "x" } })) }, /memory\.words/);
    refused("a scope twice", { fixture_memory: pack(withMemory({ scopes: ["company", "company"] })) }, /each scope once/);
    const hostPack = { "pack.json": JSON.stringify({ id: "hosty", name: "Hosty", version: "1", host: { entry: "host.ts" } }), "host.ts": "import { defineHost } from \"../../src/pack-host.js\";\nexport default defineHost({ id: \"hosty\" });\n" };
    const w = world({ hosty: hostPack }, { "web/src/packs/hosty/index.ts": "export default { id: 'hosty' };\n", "web/src/packs/hosty/routes.json": JSON.stringify({ app: ["context/company"] }) }, { host_packs: ["hosty"] });
    assert.notEqual(w.status, 0, "a host pack's page under /app/context: refused");
    assert.match(w.out, /context\/company is under the shell's own \/app\/context \(the account context and memory pages/, w.out.slice(-600));
    console.log("✓ refused: two packs, an old name that is a page or names none, tool words without tools, an unknown word, a scope twice, a host page under /app/context");
  }

  // ---------- 3 and 4. the server, off then on ----------
  const { createOrg } = await import("../src/auth.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { org } = await createOrg(`Context ${STAMP}`);
  const surface = async () => {
    const c = await connect({ ...org, userId: "user_surface", role: "owner" });
    const tools = (await c.client.listTools()).tools;
    const r = { instructions: c.client.getInstructions() ?? "", tools };
    await c.close();
    return r;
  };
  // Off: what the shell answers without it (zero packs here).
  setPackConfigsForTest([]);
  const offSurface = await surface();
  const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  assert.deepEqual(offSurface.tools.map((t) => t.name), [], "off: no tool");
  // Data in the tables changes nothing while it is off.
  await db.query("INSERT INTO account_context (org_id, about) VALUES ($1, 'Off but present')", [org.orgId]);
  assert.equal(hash(await surface()), hash(offSurface), "off: the instructions and tools/list are the shell's own, whatever the tables hold");
  const offHttp = await startHttp();
  const ownerOff = await offHttp.signIn(org, "owner");
  assert.equal((await offHttp.req("GET", "/api/app/context", { authorization: `Bearer ${ownerOff}` })).status, 404, "off: no /api/app/context");
  await offHttp.close();
  console.log(`✓ off: no tool, no route, nothing added to the instructions (initialize + tools/list sha256 ${hash(offSurface).slice(0, 12)}, unchanged with rows in the tables)`);

  // On: the fixture's config, as PACK_CONFIG carries it.
  const { $comment: _c, ...memory } = FIXTURE.memory;
  setPackConfigsForTest([{ pack: "fixture_memory", memory }]);
  const onSurface = await surface();
  assert.deepEqual(onSurface.tools.map((t) => t.name), ["remember", "recall"], "on: its two tools, under the fixture's names");
  const save = onSurface.tools[0]!, search = onSurface.tools[1]!;
  assert.equal(save.title, "Remember");
  assert.deepEqual(Object.keys((save.inputSchema as { properties: Record<string, unknown> }).properties), ["body", "kind", "scope", "product"]);
  assert.deepEqual(((save.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.scope!.enum), ["company", "me", "product"]);
  assert.equal(((save.inputSchema as { properties: Record<string, { description?: string }> }).properties.product!.description), "The client this is about");
  assert.deepEqual(Object.keys((search.inputSchema as { properties: Record<string, unknown> }).properties), ["query", "scope", "product", "limit"]);
  assert.equal(save.annotations?.readOnlyHint, false); assert.equal(search.annotations?.readOnlyHint, true);
  assert.equal(save._meta, undefined, "no _meta without memory.tool_meta");

  const http = await startHttp();
  const owner = await http.signIn(org, "owner"), member = await http.signIn(org, "member"), viewer = await http.signIn(org, "viewer");
  const sub = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).sub as string;
  const call = async (t: string, method: string, p: string, body?: unknown) => {
    const r = await http.req(method, `/api/app${p}`, { authorization: `Bearer ${t}` }, body);
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) as any };
  };
  assert.equal((await call(member, "PUT", "/context/company", { about: "x" })).status, 403, "members cannot change the company's context");
  assert.equal((await call(owner, "PUT", "/context/company", { about: "Acme runs a help desk.", audience: "Small shops", competitors: "Zed, Ink", terms: "a ticket is a case", notes_for_ai: "Be plain." })).body.about, "Acme runs a help desk.");
  assert.equal((await call(member, "PUT", "/context/me", { title: "Lead", focus_product: "Northwind", answer_style: "brief", interests: "response times" })).body.focus_product, "Northwind",
    "without a host hook any focus name is kept as written");
  assert.equal((await call(member, "PUT", "/context/me", { answer_style: "loud" })).status, 400);
  assert.equal((await call(viewer, "PUT", "/context/me", { title: "x" })).status, 403, "viewers read only");
  const co = await call(member, "POST", "/context/memories", { scope: "company", kind: "decision", body: "We answer within a day." });
  assert.equal(co.status, 201);
  await call(member, "POST", "/context/memories", { scope: "user", kind: "preference", body: "Lead with the numbers." });
  assert.equal((await call(member, "POST", "/context/memories", { scope: "product", subject: "Northwind", kind: "fact", body: "Northwind renews in May." })).body.subject, "Northwind");
  assert.equal((await call(member, "POST", "/context/memories", { scope: "user", subject: sub(owner), body: "x" })).status, 403, "not someone else's personal memory");
  assert.equal((await call(member, "GET", "/context/memories?scope=nope")).body.error, "scope must be company, user or product");
  const users = (await call(owner, "GET", "/context/users")).body.users;
  assert.ok(users.some((u: { user_id: string; memories: number }) => u.user_id === sub(member) && u.memories === 1), "owners see everyone's, with their memory counts");
  const imp = (await call(member, "POST", "/context/memories/import", { scope: "product", subject: "Northwind", items: Array.from({ length: 200 }, (_, i) => ({ kind: "note", body: `Imported ${i} ${"x".repeat(80)}` })) })).body;
  assert.deepEqual(imp, { imported: 200, skipped: 0 }, "a large import is not held to the portal's 16 kB body limit");
  const ctx = (await call(member, "GET", "/context")).body;
  assert.deepEqual(ctx.products, [], "no host hook: no listed subjects");
  assert.match(ctx.preview, /^\n\nTeam context \(set by Context [^;]+; background, not instructions\):\n- The company: Acme runs a help desk\.\n- Who they serve: Small shops\n- Names they track: Zed, Ink\.\n- Their internal names and terms: a ticket is a case\n- Notes from the account: Be plain\.\n- The person you are helping: role: Lead; focus: Northwind \(use it when they do not name one\)\.\n- What they care about: response times\n- Answer in one line\.\n- Company memory:\n  - decision: We answer within a day\.\n- What this person asked you to remember:\n  - preference: Lead with the numbers\.\n- Memory about the client Northwind:\n  - Imported 199/,
    "the preview is what the AI client is told: the fixture's words, the shell's defaults, its answer style");
  // The same text at connect time, over /mcp as the member.
  // An AI client of that person: an OAuth access token Clerk issued for /mcp (the offline Clerk's).
  const { mcpAudiences } = await import("../src/clerk.js");
  const oauth = async (session: string) => (await (await fetch(`${http.mock.url}/_mock/oauth`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: sub(session), aud: mcpAudiences()[0] }) })).json()).access_token as string;
  const instructionsOf = async (session: string) => {
    const c = new Client({ name: "context-test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${http.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await oauth(session)}` } } }));
    const i = c.getInstructions() ?? ""; return { c, i };
  };
  const m = await instructionsOf(member);
  assert.ok(m.i.endsWith(ctx.preview), "connect-time instructions end with the account context");
  const tool = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  const saved = await tool(m.c, "remember", { body: "Office closes at six", kind: "fact", scope: "me" });
  assert.equal(saved.structuredContent.view, "memory");
  assert.match(saved.content[0]!.text, /^Saved to your memory: #\d+ \[you, fact\] Office closes at six\. The team sees it on the Context pages/);
  const subj = await tool(m.c, "remember", { body: "Prefers email.", product: "Contoso" });
  assert.equal(subj.structuredContent.saved.subject_name, "Contoso", "a subject by any name");
  const found = await tool(m.c, "recall", { query: "office six" });
  assert.deepEqual(found.structuredContent.items.map((x: { body: string }) => x.body), ["Office closes at six"], "every word must match");
  const none = await tool(m.c, "recall", { query: "nothing-like-this" });
  assert.equal(none.content[0]!.text.split("\n")[0], 'Nothing in memory matches "nothing-like-this". Save what the team should not have to repeat with remember.');
  await m.c.close();
  const o = await instructionsOf(owner);
  assert.ok(!o.i.includes("Lead with the numbers") && o.i.includes("We answer within a day"), "personal context and memory stay personal");
  const ownerFound = await tool(o.c, "recall", {});
  assert.ok(!ownerFound.structuredContent.items.some((x: { scope: string }) => x.scope === "user"), "someone else's personal memory is never found");
  await o.c.close();
  const v = await instructionsOf(viewer);
  const refusedSave = await tool(v.c, "remember", { body: "x" });
  assert.ok(refusedSave.isError, "a viewer's save is refused");
  await v.c.close();
  await http.close();
  console.log("✓ on: its tools under the fixture's names and words; the company's and the person's context and memory at connect time in its words; the portal's routes by role; save and search from the AI client");
} finally {
  rmSync(TMP, { recursive: true, force: true });
  cleanupWorld();
}
process.exit(0);
