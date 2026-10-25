// The shell's smoke test (mold_v0-039): the server of this build end to end on its own database (re-runnable: it makes
// and deletes its own workspaces), whatever packs it has. Its generated files are current; the root page, the install
// pages and the health check answer; MCP over HTTP with a workspace key lists exactly the build's tools (none with zero
// packs), names the profile's server and refuses a missing or foreign key; the admin API and the admin MCP need an admin
// token; an access request is stored; the worker API and the cron need their secrets; the security checks
// (scripts/smoke-security.ts) hold; a workspace is deleted cleanly.
// Then each host pack's own smoke test runs (packs/<id>/<scripts>/smoke.ts: the product's), and the result is both.
import "../src/hosts.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hostPackDirs, hostScript } from "./lib/host-packs.js";
import { ENV } from "../src/env-names.js";

/** The environment as this run started: a host pack's smoke test gets it, not what this run set for itself. */
const ENV0 = { ...process.env };
process.env.APP_WORKER_TOKEN ??= "smoke-worker-token";
process.env.APP_VAULT_KEY ??= (await import("node:crypto")).randomBytes(32).toString("base64");
process.env.CRON_SECRET ??= "smoke-cron-secret";
process.env.APP_REGISTRY = "scripts/fixtures/registry.json";
const ROOT = path.resolve(import.meta.dirname, "..");
/** The product words the shell never says on its own (scripts/vocabulary.json, mold_v0-045). */
const PRODUCT_WORDS = (JSON.parse(readFileSync(path.join(ROOT, "scripts", "vocabulary.json"), "utf8")).words as string[]).map((w) => w.toLowerCase());

let passed = 0;
const ok = (what: string) => { passed++; console.log(`✓ ${what}`); };

// ---------- generated files are current ----------
{
  try { execFileSync(process.execPath, ["scripts/gen-packs.mjs", "--check"], { cwd: ROOT, stdio: "pipe" }); }
  catch (e) { assert.fail(`the pack registry or profile is stale: run npm run gen:packs\n${String((e as { stderr?: unknown }).stderr ?? e)}`); }
  ok("the pack registry, the host list and the profile are current (gen-packs --check)");
  const vocab = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/check-vocabulary.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(vocab.status, 0, `a product word in the shell (npm run check:vocabulary):\n${vocab.stderr}`);
  ok("no product word in the shell outside its allow list (check:vocabulary)");
  const { mcpCatalog } = await import("./export-mcp-tools.js");
  const committed = JSON.parse(readFileSync(path.join(ROOT, "web/src/content/mcp-tools.generated.json"), "utf8"));
  assert.deepEqual(committed, await mcpCatalog(), "web/src/content/mcp-tools.generated.json is stale: run npx tsx scripts/export-mcp-tools.ts");
  ok("the console's tool list is the server's (mcp-tools.generated.json)");
  const { docsCorpus } = await import("./sync-docs-corpus.js");
  const chunks = JSON.parse(readFileSync(path.join(ROOT, "src/docs-corpus.generated.json"), "utf8")).chunks;
  assert.deepEqual(chunks, docsCorpus(), "src/docs-corpus.generated.json is stale: run npx tsx scripts/sync-docs-corpus.ts");
  ok("the docs answers' corpus is current");
}

const { getDb } = await import("../src/db.js");
const { createOrg } = await import("../src/auth.js");
const { createApp } = await import("../src/http.js");
const { PROFILE } = await import("../src/profile.js");
const { hosts } = await import("../src/host.js");
const { ownToolNames } = await import("../src/server.js");
const { adminToolNames } = await import("../src/admin-mcp.js");
const { createAdminToken } = await import("../src/admin-tokens.js");
const db = await getDb();
const ADMIN_TOKEN = (await createAdminToken({ label: "shell-smoke", role: "owner", days: 1, createdBy: "smoke" })).token;
const app = createApp();
const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.PUBLIC_URL = base; // this server's own origin (the Origin check serves it, src/origin.ts)
const stamp = Date.now().toString(36);
const a = await createOrg("Shell smoke A", `shell-smoke-a-${stamp}`);
const b = await createOrg("Shell smoke B", `shell-smoke-b-${stamp}`);
const hostIds = hosts().map((h) => h.id);
console.log(`database ${db.kind}; profile "${PROFILE.name}"; host packs: ${hostIds.join(", ") || "none"}`);
assert.deepEqual(hostIds, hostPackDirs().map((p) => p.id), "every host pack of the build is registered (src/hosts.ts)");

try {
  // ---------- the public pages ----------
  {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    const html = await root.text();
    if (!hosts().some((x) => x.publicDir)) {
      assert.match(html, new RegExp(`<title>${PROFILE.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</title>`), "the root page names the profile");
      assert.ok(html.includes('href="/install"'), "and points at the install pages");
    }
    ok("/healthz and the root page answer");
    const install = await fetch(`${base}/install.json`);
    assert.equal(install.status, 200);
    const guides = await install.json() as { clients?: unknown[] };
    assert.ok(Array.isArray(guides.clients) && guides.clients.length > 0, "the install guides list clients");
    assert.ok(!JSON.stringify(guides).includes("oct_"), "no key in any install guide");
    ok("the install pages are public and carry no key");
  }

  // ---------- MCP over HTTP: a workspace's key, the build's tools ----------
  {
    const connect = async (key: string) => {
      const c = new Client({ name: "shell-smoke", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
      return c;
    };
    const A = await connect(a.key);
    const info = A.getServerVersion();
    assert.equal(info?.name, PROFILE.mcp_server_name, "the server is named by the profile");
    const tools = (await A.listTools()).tools.map((t) => t.name);
    const own = ownToolNames();
    assert.deepEqual(tools.slice(0, own.length).sort(), [...own].sort(), "the host packs' own tools come first");
    if (!hostIds.length) assert.deepEqual(own, [], "with no host pack the shell has no tool of its own");
    const instructions = A.getInstructions() ?? "";
    // The lead (src/server.ts leadInstructions): the profile's, else a host pack's (its entry's, else its pack.json
    // mcp.instructions since mold_v0-137), else the other packs' (mold_v0-105), else the shell's. mold_v0-149: this read
    // only the non-host packs' and so failed every build whose host pack declares its instructions in pack.json.
    const { leadInstructions, SHELL_INSTRUCTIONS } = await import("../src/server.js");
    const lead = leadInstructions();
    assert.ok(instructions.startsWith(lead), "the instructions start with the profile's, a host pack's, the packs' own, else the shell's");
    if (!PROFILE.mcp_instructions && !hostIds.length) {
      const { packInstructions } = await import("../src/mcp-tools.js");
      assert.equal(lead, packInstructions() ?? SHELL_INSTRUCTIONS, "with no profile instructions and no host pack: the packs' own, else the shell's");
    }
    await A.close();
    ok(`MCP over HTTP with a workspace key: ${tools.length} tool(s), server ${info?.name}`);
    const none = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(none.status, 401, "no key: 401");
    assert.ok(none.headers.get("www-authenticate"), "with a WWW-Authenticate header");
    const refusal = (await none.text()).toLowerCase();
    assert.ok(PRODUCT_WORDS.every((w) => !refusal.includes(w) || PROFILE.name.toLowerCase().includes(w)), "the refusal names the profile, never a product of its own");
    const wrong = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer oct_not_a_key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(wrong.status, 401, "an unknown key: 401");
    ok("/mcp refuses a missing or unknown key");
  }

  // ---------- the shell's security checks (scripts/smoke-security.ts): admin tokens, keys in headers, Origin, RLS ----------
  {
    const sec = await import("./smoke-security.js");
    const staff = await createAdminToken({ label: "smoke staff", role: "viewer", days: 1, createdBy: "smoke" });
    await sec.adminTokenChecks({ base, db, ADMIN_TOKEN, staff });
    await sec.apiKeyHeaderChecks({ base, a });
    await sec.originChecks({ base, a });
    await sec.rowLevelSecurityChecks({ db, a, b });
    ok("the security checks: admin tokens, API keys in headers only, Origin on every MCP endpoint, row-level security");
  }

  // ---------- the admin API and the admin MCP ----------
  {
    assert.equal((await fetch(`${base}/api/admin/onboarding/overview`)).status, 401, "no token: 401");
    const ov = await fetch(`${base}/api/admin/onboarding/overview`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(ov.status, 200, "an owner's admin token reads the overview");
    const keys = await fetch(`${base}/api/admin/onboarding/compute/keys`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(keys.status, 200, "and the model keys (hints only)");
    const c = new Client({ name: "shell-smoke-admin", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/admin/mcp`), { requestInit: { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } } }));
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names.slice(0, adminToolNames().length), adminToolNames(), "the admin MCP lists its own tools first, the host packs' where they belong");
    assert.equal(c.getServerVersion()?.name, `${PROFILE.mcp_server_name}-admin`);
    const settings = await c.callTool({ name: "list_settings", arguments: {} }) as { isError?: boolean; structuredContent?: { settings: { group: string }[] } };
    assert.ok(!settings.isError && settings.structuredContent!.settings.some((s) => s.group === "capacity"), "the shell's settings are listed");
    await c.close();
    ok(`the admin API and the admin MCP (${names.length} tools) need an admin token`);
  }

  // ---------- access requests ----------
  {
    const bad = await fetch(`${base}/api/access-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nope", company: "X" }) });
    assert.equal(bad.status, 400);
    const email = `smoke-${stamp}@example.com`;
    const good = await fetch(`${base}/api/access-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, company: "Shell Smoke Co" }) });
    assert.equal(good.status, 201);
    const [row] = await db.query<{ id: number }>("SELECT id FROM access_requests WHERE email = $1", [email]);
    assert.ok(row, "the request is stored");
    await db.query("DELETE FROM access_requests WHERE email = $1", [email]);
    ok("an access request is checked and stored");
  }

  // ---------- the worker API and the cron need their secrets ----------
  {
    assert.equal((await fetch(`${base}/api/worker/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const claim = await fetch(`${base}/api/worker/claim`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ENV.APP_WORKER_TOKEN}` },
      body: JSON.stringify({ worker_id: `shell-smoke-${stamp}`, limit: 1, simulation_id: "sim_none" }) });
    assert.equal(claim.status, 200);
    assert.deepEqual((await claim.json()).jobs, []);
    assert.equal((await fetch(`${base}/api/cron/autoscale`)).status, 401, "the cron without its secret: 401");
    ok("the worker API and the cron refuse a missing secret");
  }

  // ---------- one workspace's key never reaches another's ----------
  {
    const [ka] = await db.query<{ org_id: number }>("SELECT org_id FROM api_keys WHERE org_id = $1 LIMIT 1", [a.org.orgId]);
    const [kb] = await db.query<{ org_id: number }>("SELECT org_id FROM api_keys WHERE org_id = $1 LIMIT 1", [b.org.orgId]);
    assert.ok(ka && kb && ka.org_id !== kb.org_id);
    const { resolveKey } = await import("../src/auth.js");
    assert.equal((await resolveKey(a.key))?.orgId, a.org.orgId);
    assert.equal((await resolveKey(b.key))?.orgId, b.org.orgId);
    ok("each workspace's key resolves to its own workspace only");
  }
} finally {
  const { deleteOrg } = await import("../src/tenancy.js");
  for (const o of [a, b]) await deleteOrg(o.org.orgId).catch((e) => console.error(`delete ${o.org.slug}: ${(e as Error).message}`));
  // The run's rate-limit counters (sign-ups and MCP requests from this address) go too: a host pack's smoke test that
  // follows makes its own requests from the same address within the same hour.
  await db.query("/* tenant: internal: the smoke run's own counters */ DELETE FROM rate_limit_hits WHERE bucket LIKE 'signup:%' OR bucket LIKE 'mcp:%'").catch(() => {});
  const left = await db.query("SELECT 1 FROM organizations WHERE id = ANY($1)", [[a.org.orgId, b.org.orgId]]);
  assert.equal(left.length, 0, "the smoke's workspaces are deleted");
  server.close();
  // One process per embedded database directory (src/db.ts): close it before a host pack's smoke test opens it.
  await db.close();
}
console.log(`\nshell smoke passed (${passed} checks)`);

// ---------- each host pack's own smoke test ----------
let failed = 0;
for (const p of hostPackDirs()) {
  const own = hostScript(`${p.id}/smoke`);
  if (!own) continue;
  console.log(`\n---------- ${p.id}: its own smoke test (${path.relative(ROOT, own.file)}) ----------`);
  // With the embedded database, each host pack's smoke test gets a fresh one, as the shell's did. It runs as every deploy
  // configures the API (mold_v0-149; molds/mold_v0/mold.json APP_PROXY_HOPS 1 on Vercel and behind a server's Caddy):
  // one proxy trusted, so a smoke that plays distinct callers through X-Forwarded-For is limited per caller, as live,
  // not as one address. A value the environment already sets wins.
  const hops = ENV0.APP_PROXY_HOPS ? {} : { APP_PROXY_HOPS: "1" };
  const env = ENV0.DATABASE_URL ? { ...ENV0, ...hops } : { ...ENV0, ...hops, PGLITE_DIR: mkdtempSync(path.join(tmpdir(), `smoke-${p.id}-`)) };
  const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["--env-file-if-exists=.env", own.file], { cwd: ROOT, stdio: "inherit", env });
  if (r.status !== 0) { failed++; console.error(`${p.id}: its smoke test failed (${r.status})`); }
}
process.exit(failed ? 1 : 0);
