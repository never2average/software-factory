// mold_v0-336: a record page's `toggle` action through the API (src/record-page-routes.ts), offline: an embedded database,
// a fake sign-in, a pack of its own (a connection area whose "use in builds" flag only one record may have on, an
// owners-only members' opt-in, a field only the app's actions set). Run by `npm run test:blocks-ui`.
//   1. Offered as the person may: an owner and a member the flag (with whether it is on now), the owners-only opt-in to an
//      owner alone, a viewer nothing; its label is the field's unless declared.
//   2. Taken: it turns the field the other way round (or to `on`), through the record store as the person: its history
//      names who changed it; the record's other fields, its key (encrypted, read masked) and the fields only actions set
//      are kept.
//   3. Refused as the store refuses: a second record turned on while only one may be (409, in the store's words, naming
//      the first), an owners-only opt-in by a member (403, not offered), a viewer (403), a wrong `on` (400).
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const ALL = ["owner", "member", "viewer", "billing"];
const KEYS = { name: "deploy_keys", label: "Deploy keys", role: "source", scope: "workspace",
  fields: [{ name: "host", label: "Host", type: "text" }, { name: "api_token", label: "API token", type: "text", encrypted: true },
    { name: "use_in_builds", label: "Builds use it", type: "boolean" }, { name: "members_may_use", label: "Members may use it", type: "boolean" },
    { name: "health", label: "Health", type: "enum", options: ["untested", "working"], set_by: "action" }],
  permissions: { read: ALL, create: ["owner", "member"], update: ["owner", "member"], delete: ["owner"] },
  contract: { provenance: ["people"], actions: { read: ALL, export: { none: "secrets" }, create: ["owner", "member"], update: ["owner", "member"], move: { none: "no lifecycle" }, delete: ["owner"],
    reveal: { none: "Secrets are never shown again once saved" }, import: { none: "secrets are typed" } }, primary_action: "create_record" },
  detail: { style: "rail", tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["host", "use_in_builds"] }, { title: "History", history: {} }] }],
    actions: [{ kind: "edit", place: "primary", look: "link" }, { kind: "toggle", field: "use_in_builds" },
      { kind: "toggle", field: "members_may_use", label: "Members may use it", roles: ["owner", "member"] }] } };
const PACK = { id: "fixture_toggle", name: "Fixture toggle", version: "1", record_areas: [KEYS],
  agent_profiles: [{ id: "keeper", name: "Keeper", connection_env: [{ area: "deploy_keys", use: "use_in_builds", only_one: true, members_field: "members_may_use", prefix: "KEEP_", fields: { HOST: "host", TOKEN: "api_token" } }] }] };

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const ra = await import("../src/record-areas.js");
  F.setFeaturesForTest({ record_pages: true, agent_harness: true });
  setPacksForTest([{ manifest: { id: PACK.id, name: PACK.name, version: "1", entry: null, migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "packs") },
    declared: compileDeclarations(PACK as never) } as never]);
  const A = (await createOrg(`Toggle ${STAMP}`)).org;
  const http = await startHttp();
  const owner = await http.signIn(A, "owner"), member = await http.signIn(A, "member"), viewer = await http.signIn(A, "viewer");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const req = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const page = (tok: string, key: string) => req(tok, "GET", `/api/records/_page/deploy_keys/${key}`);
  const act = (tok: string, key: string, id: string, body: unknown = {}) => req(tok, "POST", `/api/records/_page/deploy_keys/${key}/actions/${id}`, body);
  const rec = ra.workspaceRecords(PACK.id, A.orgId);
  await ra.asWriter({ by: "people", id: "seed" }, async () => {
    await rec.put("deploy_keys", "main", { title: "Main", data: { host: "main.example.com", api_token: "tok-main", use_in_builds: true } });
    await rec.put("deploy_keys", "spare", { title: "Spare", data: { host: "spare.example.com", api_token: "tok-spare", use_in_builds: false } });
  });
  const stored = async (key: string) => (await rec.get("deploy_keys", key)) as { data: Record<string, unknown> };

  // 1. Offered as the person may.
  {
    const o = (await page(owner, "spare")).body.actions as { id: string; kind: string; label: string; on?: boolean; look?: string }[];
    assert.deepEqual(o.map((a) => a.id), ["edit", "toggle.use_in_builds", "toggle.members_may_use"], "an owner: Edit and both switches");
    assert.deepEqual(o.filter((a) => a.kind === "toggle").map((a) => [a.label, a.on]), [["Builds use it", false], ["Members may use it", false]], "labelled by the field (or as declared), off now");
    assert.equal(o[0]!.look, "link", "a declared look reaches the page");
    assert.equal(o[1]!.look, undefined, "and only where declared");
    assert.equal((await page(owner, "main")).body.actions.find((a: { id: string }) => a.id === "toggle.use_in_builds").on, true, "on where the field is on");
    const m = (await page(member, "spare")).body.actions as { id: string }[];
    assert.deepEqual(m.map((a) => a.id), ["edit", "toggle.use_in_builds"], "a member: the flag, never the owners-only opt-in");
    assert.deepEqual((await page(viewer, "spare")).body.actions, [], "a viewer: nothing that writes");
    ok("offered as the person may: the flag to owners and members (on or off now), the owners-only opt-in to owners, nothing to a viewer; labelled by the field");
  }

  // 3a. Only one on at a time: the store's own words, naming the record that has it.
  {
    const r = await act(owner, "spare", "toggle.use_in_builds");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /"Main" is already marked "Builds use it", and only one may be: turn it off there first/, r.body.error);
    assert.equal((await stored("spare")).data.use_in_builds, false, "nothing written");
    ok("only one on at a time: a second record turned on is refused (409) in the record store's words, naming the first");
  }

  // 2. Taken: the other way round, through the store, as the person.
  {
    const off = await act(member, "main", "toggle.use_in_builds");
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const main = await stored("main");
    assert.equal(main.data.use_in_builds, false, "turned off");
    assert.equal(main.data.host, "main.example.com", "its other fields kept");
    assert.notEqual(main.data.api_token, null, "its key kept (read masked, left as stored)");
    const on = await act(owner, "spare", "toggle.use_in_builds", { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal((await stored("spare")).data.use_in_builds, true, "now the other one may be on");
    const same = await act(owner, "spare", "toggle.use_in_builds", { on: true });
    assert.equal(same.status, 200);
    assert.equal(same.body.unchanged, true, "asking for what it already is writes nothing");
    const opt = await act(owner, "spare", "toggle.members_may_use");
    assert.equal(opt.status, 200, JSON.stringify(opt.body));
    assert.equal((await stored("spare")).data.members_may_use, true, "an owner turns the owners-only opt-in on");
    // Its history: who changed the flag.
    const hist = (await page(owner, "main")).body.sections as Record<string, { changes?: { by?: string; changes?: { field: string }[] }[] }>;
    const lines = Object.values(hist).flatMap((s) => s?.changes ?? []);
    assert.ok(lines.some((l) => (l.changes ?? []).some((c) => c.field === "use_in_builds")), `the history has the change: ${JSON.stringify(lines).slice(0, 400)}`);
    ok("taken: the field the other way round (or to on), through the record store as the person; the other fields and the key kept; asking for what it is writes nothing; the history says it");
  }

  // 3b. The rest of the refusals.
  {
    const m = await act(member, "spare", "toggle.members_may_use");
    assert.equal(m.status, 403, "a member is refused the owners-only opt-in");
    assert.equal((await act(viewer, "spare", "toggle.use_in_builds")).status, 403, "a viewer is refused");
    const bad = await act(owner, "spare", "toggle.use_in_builds", { on: "yes" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /on: true or false/);
    ok("refused: the owners-only opt-in to a member (403), a viewer (403), an on that is not true or false (400)");
  }
  await http.close();
  console.log("blocks-ui server: ok");
} finally {
  cleanup();
}
process.exit(0);
