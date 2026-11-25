// mold_v0-347: a receiver set up where its service is connected, and a developer surface of receivers alone.
//   npm run test:connect-receiver      offline: an embedded database, a fake sign-in, packs of its own
//   1. Declared: a developer surface may be its receivers alone (events, SDKs and client sessions left out: none, none,
//      read only); one that declares nothing is refused; a connect tab's service names a receiver
//      (`connect.services.<key>.receiver` {name, label?, how?, feeds?}), plain words only.
//   2. Built (scripts/gen-packs.mjs, a temporary copy): with no event there is no Webhooks tab; a receiver a connect tab
//      links leaves Inbound webhooks, so Settings has no Connections group; the old addresses (/app/settings/connections,
//      ?tab=webhooks, ?tab=integrations) lead to that tab; the console's tab spec carries the receiver (a log drain's
//      label "Request logs"); an unknown receiver and one linked from two tabs are refused. A build whose receiver is
//      not linked keeps Inbound webhooks, and one with events keeps Webhooks.
//   3. Through the API, a surface of one log-drain receiver: no webhooks out (the console's and /v1's endpoint routes
//      answer 404, the description lists none, Health has no Webhook Delivery); the inbound sources' own routes: every
//      role reads, only an owner sets one up (a member's refused), the secret answered once and sealed; which secret
//      verifies said without its name; a second workspace never sees the first's source, address or drain state; a
//      delivery signed with another secret is refused, one signed right is received and the state reads Receiving.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const ALL = ["owner", "member", "viewer", "billing"];

const CATALOG = { name: "fx_services", label: "Services", role: "source", scope: "platform",
  fields: [{ name: "hosting", label: "Hosting", type: "enum", options: ["saas", "self-hosted"] }],
  contract: { provenance: ["staff"], actions: { read: ALL, export: ALL, create: { staff: "library" }, update: { staff: "library" }, move: { none: "no lifecycle" }, delete: { staff: "delete" }, reveal: { none: "No encrypted field" }, import: { staff: "library" } },
    primary_action: { none: "staff keep it" } } };
const ACCOUNTS = { name: "fx_accounts", label: "Service accounts", role: "source", scope: "workspace", key_from_title: true,
  fields: [{ name: "provider", label: "Provider", type: "enum", required: true, options: ["alpha", "other"] },
    { name: "service", label: "Service", type: "reference", to: "fx_services" },
    { name: "api_token", label: "API token", type: "text", required: true, encrypted: true }],
  permissions: { read: ["owner", "member", "billing"], create: ["owner"], update: ["owner"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ["owner", "member", "billing"], export: { none: "keys" }, create: ["owner"], update: ["owner"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "Keys are never shown again once saved" }, import: { none: "keys are typed" } }, primary_action: "create_record" } };
const EVENTS = { name: "fx_events", label: "Events", role: "source", scope: "workspace", fields: [{ name: "what", label: "What", type: "text" }] };
const LINK = { name: "fx_in", label: "Service events", how: "At the service: Settings, Webhooks, paste this address.", feeds: "Feeds the Events list." };
const connectTab = (id: string, receiver: unknown = LINK, label = "Services") => ({ id, kind: "area", label, area: "fx_services", action: false, reason: "Connect is inside each panel",
  connect: { area: "fx_accounts", via: "service", fields: ["api_token"], services: { alpha: { set: { provider: "alpha" }, ...(receiver ? { receiver } : {}) }, "*": { set: { provider: "other" } } } } });
const RECEIVER_IN = { name: "fx_in", description: "What the service sends.", area: "fx_events", key: "/id", fields: { what: "/what" } };
const pack = (over: Record<string, unknown> = {}) => ({ id: "fixture_receiver", name: "Fixture receiver", version: "1", record_areas: [CATALOG, ACCOUNTS, EVENTS],
  tabs: [connectTab("services")], developer_surface: { webhooks_in: [RECEIVER_IN] }, ...over });

try {
  const manifest = await import("../src/pack-manifest.js");
  const api = await import("../src/pack-api.js");
  const dc = await import("../src/developer-config.js");

  // ---------- 1. declared ----------
  {
    const parse = (j: unknown) => manifest.PackJsonSchema.safeParse(j);
    const p = parse(pack());
    assert.ok(p.success, JSON.stringify(p.error?.issues.slice(0, 3)));
    const none = parse(pack({ developer_surface: {} }));
    assert.ok(!none.success && none.error.issues.some((i) => /a developer surface declares something/.test(i.message)), "an empty surface is refused");
    const svc = (r: unknown) => api.TabConnectServiceSchema.safeParse({ receiver: r });
    assert.ok(svc(LINK).success);
    assert.ok(!svc({ name: "Not A Name" }).success, "a receiver's name is one of webhooks_in's");
    assert.ok(!svc({ name: "fx_in", how: "two\nlines" }).success, "how is one line of plain words");
    assert.ok(!svc({ name: "fx_in", extra: true }).success, "no other key");
    const d = dc.developerSurfaceDefaults({ webhooks_in: [RECEIVER_IN as never] });
    assert.deepEqual([d.events, d.sdk_languages, d.client_sessions], [[], [], { ttl_seconds: 3600, allowed_origins: [], scopes: ["read"] }], "left out: no events, no SDK, sessions of read only");
    assert.equal(dc.hasWebhooksOut(d), false);
    assert.equal(dc.hasWebhooksOut({ events: [{ name: "record.created", description: "x" }] }), true);
    ok("declared: a developer surface of receivers alone (no events, no SDK, client sessions read only for an hour); an empty one refused; a connect service's receiver {name, label, how, feeds} in plain words, nothing else");
  }

  // ---------- 2. built ----------
  {
    const TMP = mkdtempSync(path.join(tmpdir(), "connect-receiver-"));
    try {
      const build = (j: unknown, tag: string) => {
        const dir = path.join(TMP, tag), packs = path.join(dir, "packs"), out = path.join(dir, "out");
        mkdirSync(path.join(packs, "fixture_receiver"), { recursive: true });
        writeFileSync(path.join(packs, "fixture_receiver", "pack.json"), JSON.stringify(j));
        cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(packs, "pack.schema.json"));
        const g = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packs, "--out", out], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const read = (f: string) => readFileSync(path.join(out, "web", "src", "config", f), "utf8");
        return { status: g.status, said: `${g.stdout}\n${g.stderr}`, nav: () => read("pack-nav.generated.ts"), routes: () => JSON.parse(read("pack-routes.generated.json")) };
      };
      const constOf = (nav: string, name: string) => { const i = nav.indexOf(`export const ${name}`); const j = nav.indexOf(";\n", i); return JSON.parse(nav.slice(nav.indexOf("=", i) + 1, j)); };
      const b = build(pack(), "linked");
      assert.equal(b.status, 0, b.said.slice(-3000));
      const nav = b.nav();
      const tabs = constOf(nav, "settingsTabs") as { id: string; group: string }[];
      assert.deepEqual(tabs.map((t) => t.id), ["api_keys", "allowed_origins"], "no Webhooks (no event), no Inbound webhooks (its receiver is linked)");
      assert.ok(!tabs.some((t) => t.group === "connections"), "no Connections group");
      const moved = constOf(nav, "movedSettingsTabs");
      assert.deepEqual([moved.integrations, moved.webhooks], ["/app/services", "/app/services"], "the old tabs lead to the connect tab");
      assert.ok(b.routes().redirects.some((r: { source: string; destination: string }) => r.source === "/app/settings/connections" && r.destination === "/app/services"), "the Connections page leads there");
      const con = constOf(nav, "developerConsole");
      assert.deepEqual([con.webhooks_out, con.linked], [false, ["fx_in"]]);
      assert.match(nav, /"receiver": \{\s*"name": "fx_in",\s*"label": "Service events",\s*"how": "At the service: Settings, Webhooks, paste this address.",\s*"feeds": "Feeds the Events list.",\s*"drain": false\s*\}/, "the tab spec carries the receiver");

      const unknown = build(pack({ tabs: [connectTab("services", { name: "nope" })] }), "unknown");
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.said, /tab services: connect.services.alpha.receiver: nope is not one of the developer surface's receivers \(developer_surface.webhooks_in: fx_in\)/);
      const twice = build(pack({ tabs: [connectTab("services"), connectTab("services-two", LINK, "More services")] }), "twice");
      assert.notEqual(twice.status, 0);
      assert.match(twice.said, /tab services-two: connect.services.alpha.receiver: fx_in is set up from tab services of pack fixture_receiver already: one tab a receiver/);

      const plain = build(pack({ tabs: [connectTab("services", null)], developer_surface: { events: [{ name: "record.created", description: "A record." }], webhooks_in: [RECEIVER_IN] } }), "plain");
      assert.equal(plain.status, 0, plain.said.slice(-3000));
      const pt = constOf(plain.nav(), "settingsTabs") as { id: string }[];
      assert.deepEqual(pt.map((t) => t.id), ["api_keys", "allowed_origins", "webhooks", "integrations"], "with an event, Webhooks; a receiver nothing links stays in Inbound webhooks");
      assert.deepEqual(constOf(plain.nav(), "movedSettingsTabs"), {}, "nothing moved");
      assert.ok(!plain.routes().redirects.some((r: { source: string }) => r.source === "/app/settings/connections"));
      ok("built: no event, no Webhooks tab; a linked receiver leaves Inbound webhooks, so no Connections group, and its old addresses lead to the connect tab; the tab spec carries the receiver; an unknown receiver and one linked twice refused; unlinked and with events, Settings is as before");
    } finally { rmSync(TMP, { recursive: true, force: true }); }
  }

  // ---------- 3. through the API ----------
  await import("../src/hosts.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { setPackConfigsForTest } = await import("../src/host.js");
  const { compileDeclarations, } = await import("../src/pack-manifest.js");
  const ld = await import("../src/log-drain.js");
  const DRAIN = { name: "fx_logs", description: "The hosting provider's request logs.", area: "fx_reports", signature: "vercel",
    log_drain: { secret_env: "TEST_RECEIVER_347_SECRET", window_minutes: 60, deployments: { area: "fx_deployments", field: "provider_id", match: "deployment_id" } } };
  const J = { id: "fixture_receiver", name: "Fixture receiver", version: "1", record_areas: [
    { name: "fx_deployments", label: "Deployments", role: "source", scope: "workspace", fields: [{ name: "provider_id", label: "Provider id", type: "text" }] },
    { name: "fx_reports", label: "Reports", role: "source", scope: "workspace", fields: [
      { name: "deployment", label: "Deployment", type: "reference", to: "fx_deployments" }, { name: "window_start", label: "From", type: "date" }, { name: "window_end", label: "To", type: "date" },
      { name: "requests", label: "Requests", type: "number" }, { name: "errors", label: "Errors", type: "number" }, { name: "error_rate", label: "Error rate", type: "number" },
      { name: "p95_ms", label: "p95", type: "number" }, { name: "mean_ms", label: "Mean", type: "number" }, { name: "source", label: "Source", type: "text" }, { name: "buckets", label: "Buckets", type: "json" }] }] };
  setPacksForTest([{ manifest: { id: J.id, name: J.name, version: "1", entry: null, migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "packs") }, declared: compileDeclarations(J as never), definition: null } as never]);
  setPackConfigsForTest([{ pack: J.id, developer_surface: dc.developerSurfaceDefaults({ webhooks_in: [DRAIN as never] }) }]);
  const { createOrg } = await import("../src/auth.js");
  const { workspaceRecords } = await import("../src/record-areas.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Receiver A ${STAMP}`)).org, B = (await createOrg(`Receiver B ${STAMP}`)).org;
  await withTenant(A.orgId, () => workspaceRecords(J.id, A.orgId).create("fx_deployments", "d1", { title: "Release 1", data: { provider_id: "dpl_1" } }));
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
  const req = async (tok: string | null, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await http.req(method, p, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "x-pack-request": "1", ...extra }, body);
    const text = await r.text(); let json: any = {}; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text };
  };
  try {
    // No webhooks out.
    {
      const offer = await req(owner, "GET", "/api/developer/");
      assert.equal(offer.status, 200, offer.text);
      assert.deepEqual(offer.body.events, []);
      assert.deepEqual(offer.body.receivers.map((r: { name: string; secret: string }) => [r.name, r.secret]), [["fx_logs", "own"]], "its secret env unset: the source's own verifies");
      process.env.TEST_RECEIVER_347_SECRET = `drain-${STAMP}-secret`;
      assert.equal((await req(owner, "GET", "/api/developer/")).body.receivers[0].secret, "app", "set on the app's hosting: said so, never its name or value");
      assert.ok(!(await req(owner, "GET", "/api/developer/")).text.includes(process.env.TEST_RECEIVER_347_SECRET!) && !(await req(owner, "GET", "/api/developer/")).text.includes("TEST_RECEIVER_347_SECRET"));
      assert.equal((await req(owner, "GET", "/api/developer/webhooks")).status, 404, "the console's endpoint routes are not mounted");
      assert.equal((await req(owner, "POST", "/api/developer/webhooks", { url: "https://hooks.example.com/x" })).status, 404);
      const key = await req(owner, "POST", "/api/developer/keys", { name: "server", scopes: ["webhooks", "read"] });
      assert.equal(key.status, 201, key.text);
      const v1 = await req(key.body.key, "GET", "/v1/webhook_endpoints");
      assert.equal(v1.status, 404, `/v1/webhook_endpoints: ${v1.text}`);
      assert.equal((await req(key.body.key, "GET", "/v1/inbound_sources")).status, 200, "the inbound sources stay");
      const doc = await req(null, "GET", "/openapi.json");
      assert.equal(doc.status, 200);
      assert.ok(!Object.keys(doc.body.paths).some((p) => p.startsWith("/v1/webhook_")), "the description lists no webhook endpoint");
      assert.deepEqual(doc.body.webhooks, {}, "and no event");
      assert.ok(Object.keys(doc.body.paths).includes("/v1/inbound_sources"));
      const { webhooksOn } = await import("../src/health-tabs.js");
      assert.equal(webhooksOn(), false, "Health has no Webhook Delivery");
      ok("no webhooks out: the console's and /v1's endpoint routes answer 404, the description lists neither endpoints nor events, Health has no Webhook Delivery; the inbound sources stay; which secret verifies is said (own, or the app's) without its name or value");
    }
    // The sources: every role reads, an owner sets one up, a second workspace sees none of it.
    let src: { id: string; path: string } | null = null;
    {
      assert.equal((await req(member, "POST", "/api/developer/sources", { receiver: "fx_logs" })).status, 403, "a member may not set it up");
      assert.equal((await req(viewer, "POST", "/api/developer/sources", { receiver: "fx_logs" })).status, 403, "nor a viewer");
      const made = await req(owner, "POST", "/api/developer/sources", { receiver: "fx_logs", description: "Request logs" });
      assert.equal(made.status, 201, made.text);
      assert.match(made.body.data.secret, /^whsec_/, "the source's secret, answered once");
      src = made.body.data;
      const listed = await req(member, "GET", "/api/developer/sources");
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.data.map((s: { id: string }) => s.id), [src!.id], "every role reads the address");
      assert.ok(!listed.text.includes(made.body.data.secret) && !listed.text.includes("secret_sealed"), "never the secret again");
      const b = await req(ownerB, "GET", "/api/developer/sources");
      assert.deepEqual(b.body.data, [], "workspace B sees none of A's sources");
      assert.ok(!b.text.includes(src!.id));
      const sa = await req(owner, "GET", "/api/log-drains/status"), sb = await req(ownerB, "GET", "/api/log-drains/status");
      assert.deepEqual(sa.body.drains.map((d: { state: string }) => d.state), ["waiting"]);
      assert.deepEqual(sb.body.drains.map((d: { state: string }) => d.state), ["not_connected"], "B's drain is its own: not connected");
      assert.equal((await req(ownerB, "DELETE", `/api/developer/sources/${src!.id}`)).status, 404, "B cannot remove A's source");
      ok("the inbound sources' own routes: a member's and a viewer's set-up refused (403), an owner's answers the secret once; every role reads the address, never the secret; a second workspace sees none of A's sources or drain state, and cannot remove them");
    }
    // Inbound verification is unchanged.
    {
      const now = Date.now();
      const body = JSON.stringify([{ id: "l1", deploymentId: "dpl_1", source: "lambda", environment: "production", statusCode: 200, timestamp: now, proxy: { statusCode: 200, timestamp: now, host: "app.example.com" } }]);
      const bad = await http.req("POST", `/v1/inbound/${src!.id}`, { "content-type": "application/json", "x-vercel-signature": ld.vercelSignature("not-the-secret", body) }, body);
      assert.equal(bad.status, 400, "a delivery signed with another secret is refused");
      const good = await http.req("POST", `/v1/inbound/${src!.id}`, { "content-type": "application/json", "x-vercel-signature": ld.vercelSignature(process.env.TEST_RECEIVER_347_SECRET!, body) }, body);
      assert.equal(good.status, 200, await good.text());
      assert.deepEqual((await req(owner, "GET", "/api/log-drains/status")).body.drains.map((d: { state: string }) => d.state), ["receiving"]);
      assert.deepEqual((await req(ownerB, "GET", "/api/log-drains/status")).body.drains.map((d: { state: string }) => d.state), ["not_connected"], "still B's own");
      assert.equal((await req(owner, "DELETE", `/api/developer/sources/${src!.id}`)).status, 204, "an owner removes it");
      ok("inbound verification unchanged: another secret refused (400), the right one received; A reads Receiving, B still Not connected; an owner removes the source");
    }
    // The console's panel reads the state as the server gives it (web/src/features/tabs/connect-receiver.tsx).
    {
      const ui = readFileSync(path.join(ROOT, "web", "src", "features", "tabs", "connect-receiver.tsx"), "utf8");
      assert.match(ui, /dev<\{ data: Source\[\] \}>\('GET', '\/sources'\)/, "the panel lists the inbound sources' own route");
      assert.match(ui, /dev<\{ data: Source & \{ secret: string \} \}>\('POST', '\/sources'/, "and sets one up through it");
      assert.match(ui, /can\('manage'\)/, "set up and removed by those who may manage (owners)");
      const connect = readFileSync(path.join(ROOT, "web", "src", "features", "tabs", "connect.tsx"), "utf8");
      assert.match(connect, /accounts\.length > 0 && service\?\.receiver && <ReceiverSection/, "shown once the service has an account");
      ok("the panel: the receiver's block once the service has an account, through the inbound sources' own routes, set up only by owners");
    }
  } finally { await http.close(); }
  console.log("connect-receiver: ok");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
process.exit(process.exitCode ?? 0);
