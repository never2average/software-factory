import { readFileSync } from "node:fs";
// mold_v0-344: a catalog tab whose services a workspace connects in place (pack.json tabs[].connect; src/pack-api.ts
// TabConnectSchema, src/metric-spec.ts connectProblems, src/tab-connect.ts, web/src/features/tabs/connect.tsx).
//   npm run test:connect-tab        offline: an embedded database, a fake sign-in, a pack of its own
//   1. Declared: the key and its refusals with their paths (a tab of several areas, the connections' area itself, a create
//      action, a board; via not the area's reference to the catalog, a field only actions set, a flag that is no boolean, a
//      key written in pack.json, an option the field lacks, a shared connections' area, keys that could be read back).
//   2. Pure: a service's state from its connections' health; a connection without via claimed by the one service whose
//      `set` it holds (two claiming it: nobody's).
//   3. Through the API, as each person: the rows carry this workspace's state, its flag and its last test; a second
//      workspace never sees the first's connections or state; a role that may not read the connections gets none (never
//      "not connected"); a key is masked in every answer (its value appears nowhere); the condition says which may be
//      connected; `others` lists a connection no service holds; the form's spec says who may connect, the fields asked
//      first, More options and the flag; a write goes through the connection area's own create (the member's refused).
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const ALL = ["owner", "member", "viewer", "billing"];
const SECRET = `tok-${STAMP}-never-shown`;

const CATALOG = { name: "fx_services", label: "Services", role: "source", scope: "platform",
  fields: [{ name: "hosting", label: "Hosting", type: "enum", options: ["saas", "self-hosted"] }, { name: "summary", label: "Summary", type: "text" }],
  contract: { provenance: ["staff"], actions: { read: ALL, export: ALL, create: { staff: "library" }, update: { staff: "library" }, move: { none: "no lifecycle" }, delete: { staff: "delete" }, reveal: { none: "No encrypted field" }, import: { staff: "library" } },
    primary_action: { none: "staff keep it" } } };
const ACCOUNTS = { name: "fx_accounts", label: "Service accounts", role: "source", scope: "workspace", key_from_title: true,
  fields: [{ name: "provider", label: "Provider", type: "enum", required: true, options: ["alpha", "beta", "other"] },
    { name: "service", label: "Service", type: "reference", to: "fx_services" },
    { name: "account_id", label: "Account ID", type: "text" },
    { name: "api_token", label: "API token", type: "text", required: true, encrypted: true },
    { name: "use_in_builds", label: "Builds use it", type: "boolean" },
    { name: "health", label: "Health", type: "enum", options: ["untested", "working"], set_by: "action" }],
  permissions: { read: ["owner", "member", "billing"], create: ["owner"], update: ["owner"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ["owner", "member", "billing"], export: { none: "keys" }, create: ["owner"], update: ["owner"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "Keys are never shown again once saved" }, import: { none: "keys are typed" } }, primary_action: "create_record" },
  detail: { style: "rail", tabs: [{ label: "Details", sections: [{ title: "Account", fields: ["provider", "account_id", "use_in_builds"] }] }],
    actions: [{ kind: "edit", place: "primary" }, { kind: "toggle", field: "use_in_builds" }, { kind: "delete", confirm: "Disconnect it? The service keeps its data." }] } };
const CONNECT = { area: "fx_accounts", via: "service", when: { field: "hosting", equals: "saas" }, fields: ["api_token"], more: ["account_id"], flag: "use_in_builds",
  services: { alpha: { set: { provider: "alpha" }, get_key: { href: "https://alpha.example.com/tokens", scopes: "read only" }, hints: { account_id: "Settings, General" } }, "*": { set: { provider: "other" } } }, others: true };
const TAB = { id: "services", kind: "area", label: "Services", area: "fx_services", connect: CONNECT, action: false, reason: "Connect is inside each panel" };
const PACK = { id: "fixture_connect", name: "Fixture connect", version: "1", record_areas: [CATALOG, ACCOUNTS], tabs: [TAB] };

try {
  const api = await import("../src/pack-api.js");
  const spec = await import("../src/metric-spec.js");
  const conn = await import("../src/tab-connect.js");

  // 1. Declared, and refused where it cannot work.
  {
    const tab = (t: unknown) => api.TabSchema.safeParse(t);
    assert.ok(tab(TAB).success, JSON.stringify(tab(TAB).error?.issues));
    const issues = (t: unknown) => (tab(t).error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
    assert.ok(issues({ ...TAB, area: undefined, areas: [{ area: "fx_services" }, { area: "fx_accounts" }] }).some((m) => /^connect: connect is for an area tab over one area/.test(m)), "a merged tab");
    assert.ok(issues({ ...TAB, connect: { ...CONNECT, area: "fx_services" } }).some((m) => /^connect.area: connect.area is the connections' area/.test(m)), "the catalog itself");
    assert.ok(issues({ ...TAB, action: { kind: "create_record", area: "fx_accounts" }, reason: undefined }).some((m) => /^action: a connect tab adds no record from its search row/.test(m)), "a create action");
    assert.ok(issues({ ...TAB, views: ["table", "board"], board_by: "hosting" }).some((m) => /^views: a connect tab is a table/.test(m)), "a board");
    assert.ok(issues({ ...TAB, connect: { ...CONNECT, more: ["account_id", "service"] } }).some((m) => /^connect.more.1: service is the service the connection is for/.test(m)), "via asked");
    assert.ok(issues({ ...TAB, connect: { ...CONNECT, more: ["api_token"] } }).some((m) => /^connect.more.0: api_token is listed twice/.test(m)), "a field twice");
    assert.ok(issues({ ...TAB, connect: { ...CONNECT, services: { alpha: { get_key: { href: "http://alpha.example.com" } } } } }).some((m) => /^connect.services.alpha.get_key.href: an https:\/\/ address/.test(m)), "a plain-http key page");
    const areas = [{ ...CATALOG, pack: PACK.id }, { ...ACCOUNTS, pack: PACK.id }] as never[];
    const find = (n: string) => (areas as { name: string }[]).find((a) => a.name === n) as never;
    const probs = (c: unknown) => spec.connectProblems(c as never, find("fx_services"), find);
    assert.deepEqual(probs(CONNECT), [], "the fixture's connect is sound");
    const has = (c: unknown, re: RegExp) => assert.ok(probs(c).some((m) => re.test(m)), `${re}: ${probs(c).join(" | ")}`);
    has({ ...CONNECT, area: "nope" }, /^nope is not a record area of this build/);
    has({ ...CONNECT, via: "account_id" }, /^via account_id is not fx_accounts's single reference to fx_services/);
    has({ ...CONNECT, more: ["health"] }, /^field health is set only by the app's actions/);
    has({ ...CONNECT, flag: "account_id" }, /^flag account_id is not a boolean field/);
    has({ ...CONNECT, services: { alpha: { set: { api_token: "x" } } } }, /^services.alpha.set: api_token is encrypted: a key is typed by the person/);
    has({ ...CONNECT, services: { alpha: { set: { provider: "gamma" } } } }, /^services.alpha.set: gamma is not one of provider's options/);
    has({ ...CONNECT, when: { field: "nope", equals: "saas" } }, /^when: /);
    const leaky = [{ ...CATALOG, pack: PACK.id }, { ...ACCOUNTS, scope: "platform", contract: { ...ACCOUNTS.contract, actions: { ...ACCOUNTS.contract.actions, export: ALL, reveal: ["owner"] } }, pack: PACK.id }] as never[];
    const lp = spec.connectProblems(CONNECT as never, leaky[0]!, (n: string) => (leaky as { name: string }[]).find((a) => a.name === n) as never);
    assert.ok(lp.some((m) => /is a shared area/.test(m)) && lp.some((m) => /contract's export is \{"none"/.test(m)) && lp.some((m) => /contract's reveal is \{"none"/.test(m)), lp.join(" | "));
    ok("declared: connect on an area tab of one catalog; 14 refusals with their paths (several areas, the catalog as its own connections, a create action, a board, via or a field asked twice, a plain-http key page; an unknown area, via that is no reference to the catalog, a field only actions set, a flag that is no boolean, a key or an unknown option written in pack.json, a bad condition, a shared area whose keys could be read back)");
  }

  // 2. Pure: state and ownership.
  {
    assert.equal(conn.connectState([], true), "not_connected");
    assert.equal(conn.connectState([{ health: { state: "untested", attention: false } }], true), "not_tested");
    assert.equal(conn.connectState([{ health: { state: "working", attention: false } }], true), "connected");
    assert.equal(conn.connectState([{ health: { state: "working", attention: false } }, { health: { state: "failing", attention: true } }], true), "needs_attention");
    assert.equal(conn.connectState([{}], false), "connected", "an area nothing tests: saved is connected");
    const c = { ...CONNECT, services: { alpha: { set: { provider: "alpha" } }, beta: { set: { provider: "beta" } }, beta2: { set: { provider: "beta" } }, "*": { set: { provider: "other" } } } } as never;
    assert.equal(conn.serviceOf(c, { service: "beta", provider: "alpha" }), "beta", "via first");
    assert.equal(conn.serviceOf(c, { provider: "alpha" }), "alpha", "the one service whose set it holds");
    assert.equal(conn.serviceOf(c, { provider: "beta" }), null, "two claim it: nobody's (one of others)");
    assert.equal(conn.serviceOf(c, { provider: "other" }), null, "never claimed by *");
    ok("pure: a service's state from its connections (any needing attention, else any working, else not tested; nothing tests: saved is connected); a connection belongs to its via, else to the one service whose set it holds, never to *");
  }

  // 3. Through the API.
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  F.setFeaturesForTest({ record_pages: true });
  setPacksForTest([{ manifest: { id: PACK.id, name: PACK.name, version: "1", entry: null, migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "packs") },
    declared: compileDeclarations(PACK as never) } as never]);
  for (const [key, title, hosting] of [["alpha", "Alpha", "saas"], ["beta", "Beta", "saas"], ["gamma", "Gamma", "self-hosted"]] as const)
    await ra.putPlatform(PACK.id, "fx_services", key, { title, data: { hosting, summary: `${title} service` } }, "put", { by: "staff", id: "seed" } as never);
  const A = (await createOrg(`Connect A ${STAMP}`)).org, B = (await createOrg(`Connect B ${STAMP}`)).org;
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const req = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); const text = await r.text(); let json: any = {}; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, body: json, text }; };
  const rows = async (tok: string) => req(tok, "GET", `/api/records/tabs/${PACK.id}/services?limit=200`);
  const row = (page: { body: { records: { key: string }[] } }, key: string) => page.body.records.find((r) => r.key === key) as any;

  // Nothing connected yet: every service listed once, not connected; the self-hosted one may not be connected.
  {
    const p = await rows(owner);
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.body.records.map((r: { key: string }) => r.key), ["alpha", "beta", "gamma"]);
    assert.equal(row(p, "alpha").data.connection_state, "not_connected");
    assert.equal(row(p, "alpha").data.connection_flag, false);
    assert.equal(row(p, "alpha").connect.connectable, true);
    assert.equal(row(p, "gamma").connect.connectable, false, "a self-hosted one: no Connect (its own data says so)");
    // mold_v0-345: a service this tab does not connect reads "Not available here", never "Not connected", with no flag of its own.
    assert.equal(row(p, "gamma").data.connection_state, "unavailable", "a self-hosted one: not available here");
    assert.equal(row(p, "gamma").data.connection_flag, undefined, "no Builds use it of its own");
    const pages = readFileSync(new URL("../web/src/features/records/record-pages.tsx", import.meta.url), "utf8");
    assert.match(pages, /connect\?\.connect && !source \? listed\.map\(\(c\) => \(c\.key === '_record' \? \{ \.\.\.c, label: 'Service' \}/, "a connect tab's first column says Service");
  }
  // The form's spec: who may connect, the key first, the rest under More options, the flag.
  {
    const s = await req(owner, "GET", `/api/records/tabs/${PACK.id}/services/connect`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.allowed, true);
    assert.deepEqual(s.body.ask, ["provider", "api_token"], "the required fields and fields (provider is filled from the service in the form)");
    assert.deepEqual(s.body.more, ["account_id"], "the rest: never via, the flag or a field only actions set");
    assert.deepEqual(s.body.flag, { name: "use_in_builds", label: "Builds use it" });
    assert.ok(s.body.fields.find((f: { name: string }) => f.name === "api_token").secret, "the key is a sealed input");
    const m = await req(member, "GET", `/api/records/tabs/${PACK.id}/services/connect`);
    assert.equal(m.body.allowed, false, "a member may not create a connection");
    assert.equal(m.body.who, "Only workspace owners can connect it.");
    ok("the form's spec: an owner may connect (the required fields and the key first, the rest under More options, the flag), a member is told who may");
  }
  // An owner connects Alpha through the connection area's own create; a member's create is refused.
  {
    const c = await req(owner, "POST", "/api/data/fx_accounts", { key: "alpha", title: "Alpha", data: { provider: "alpha", service: "alpha", api_token: SECRET, use_in_builds: true } });
    assert.equal(c.status, 201, c.text);
    assert.equal((await req(member, "POST", "/api/data/fx_accounts", { key: "alpha-2", title: "Alpha 2", data: { provider: "alpha", service: "alpha", api_token: "x" } })).status, 403, "the member's create is refused by the area's own permission");
    // A connection saved before the tab had Connect (no via): claimed by the one service whose set it holds; one no service holds: its own row.
    await req(owner, "POST", "/api/data/fx_accounts", { key: "old-beta", title: "Old beta", data: { provider: "beta", api_token: "y" } });
    await req(owner, "POST", "/api/data/fx_accounts", { key: "loose", title: "Loose one", data: { provider: "other", api_token: "z" } });
    const p = await rows(owner);
    const a = row(p, "alpha");
    assert.equal(a.data.connection_state, "connected", "nothing tests this area: saved is connected");
    assert.equal(a.data.connection_flag, true);
    assert.deepEqual(a.connect.connections.map((x: { key: string }) => x.key), ["alpha"]);
    assert.equal(a.connect.connections[0].data.api_token, "[encrypted]", "the key is masked");
    assert.ok(!p.text.includes(SECRET), "the key's value appears nowhere in the answer");
    assert.equal(row(p, "beta").data.connection_state, "not_connected", "beta's set is not claimed: old-beta is provider beta, but the services table gives beta no set");
    const loose = p.body.records.filter((r: { areas?: string[] }) => r.areas?.[0] === "fx_accounts").map((r: { key: string }) => r.key);
    assert.deepEqual(loose.sort(), ["loose", "old-beta"], "others: the connections no service holds, as rows of their own");
    ok("an owner connects through the connection area's own create (a member's refused, 403); the service's row says connected with the flag on, its connection listed with the key masked (its value nowhere in the answer); others lists the connections no service holds");
  }
  // A second workspace sees none of it; a viewer (who may not read the connections) gets no state at all.
  {
    const p = await rows(ownerB);
    assert.equal(p.status, 200, p.text);
    assert.equal(row(p, "alpha").data.connection_state, "not_connected", "workspace B: Alpha is not connected there");
    assert.deepEqual(row(p, "alpha").connect.connections, []);
    assert.ok(!p.body.records.some((r: { areas?: string[] }) => r.areas?.length), "none of A's connections are B's rows");
    assert.ok(!p.text.includes("old-beta") && !p.text.includes("Loose one"), "nothing of A's in B's answer");
    const v = await rows(viewer);
    assert.equal(v.status, 200, v.text);
    assert.deepEqual(row(v, "alpha").connect, { hidden: true }, "a viewer may not read the connections: no state, never not connected");
    assert.equal(row(v, "alpha").data.connection_state, undefined);
    ok("tenant isolation: a second workspace never sees the first's connections or their state on the merged rows; a role that may not read the connections gets no state at all");
  }
  // The account's own actions stay the connection area's (edit, toggle, delete: an owner's).
  {
    const pg = await req(owner, "GET", "/api/records/_page/fx_accounts/alpha");
    assert.deepEqual(pg.body.actions.map((a: { kind: string }) => a.kind), ["edit", "toggle", "delete"]);
    assert.equal(pg.body.actions.find((a: { kind: string }) => a.kind === "delete").confirm, "Disconnect it? The service keeps its data.");
    const del = await req(owner, "POST", "/api/records/_page/fx_accounts/alpha/actions/delete", {});
    assert.equal(del.status, 200, del.text);
    assert.equal(row(await rows(owner), "alpha").data.connection_state, "not_connected");
    ok("each account's actions are the connection area's own page actions (edit, the flag, Disconnect with its confirm words); disconnected, the service is not connected again");
  }
  await http.close();
  console.log("connect tab: ok");
} finally {
  cleanup();
}
process.exit(0);
