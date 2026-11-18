// A workspace's connection records as an agent session's environment (mold_v0-312; src/connection-env.ts,
// src/connection-env-config.ts, a pack profile's connection_env), offline: an embedded database, a local runner and
// the stand-in CLI (scripts/fixtures/agent-cli/cli.mjs) as the sandbox's agent.
//   npx tsx scripts/connection-env-test.ts
//
// Proves:
//   1. the declaration is checked against the pack's own areas: a workspace area whose contract reveals nothing, fields
//      it has holding one value, variable names well formed, never the session's own (PATH, RUN_*), never set twice
//   2. at start: the variables' names frozen into the session (no value), listed in its first system message; a person
//      who may not update the area, and a profile without connection_env, get none
//   3. each wake: the values in the sandbox's environment (a secret proved by its hash, never typed), a plain field as
//      it is; the record in use (use, where) of the session's own workspace only, never another's; a secret the agent
//      prints is "[credential connection:<area>/<VAR>]" in its answer and its trace; the run records the names only;
//      the server's own backstop (runSecrets) holds the secrets and not the plain values
//   4. no secret anywhere: the transcript, the trace, the run's events, the data trail, anything printed
//   5. mold_v0-322 (members_field): a member's session receives an entry's record only while an owner has its opt-in on;
//      a member cannot set or flip it (API, create, batch, an action's scope, import), nor can an agent's tool call in an
//      owner's session; a member's edit of where its secrets go turns it off; turning it off after a session started
//      does not reach that session (documented: the record is frozen with its version) but does the next; each change a
//      grant or revoke line in the data trail; what a member's session receives is redacted like any other
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`✓ ${m}`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canary = (w: string) => `${w}-CANARY-${randomBytes(12).toString("hex")}`;
const A_TOKEN = canary("compute-a"), B_TOKEN = canary("compute-b"), A_SECRET = canary("storage-a"), A_OLD = canary("storage-old"), A_KEYID = canary("keyid-a");
const ROTATED = canary("compute-rotated"), NET_TOKEN = canary("network");
const BUILD_TOKEN = canary("build"), BUILD_NEW = canary("build-new"), BUILD_EVIL = canary("build-evil");
const SECRETS = [A_TOKEN, B_TOKEN, A_SECRET, A_OLD, A_KEYID, ROTATED, NET_TOKEN, BUILD_TOKEN, BUILD_NEW, BUILD_EVIL];

const ALL = ["viewer", "member", "billing", "owner"];
const contract = { provenance: ["people"], actions: { read: ALL, export: { none: "secrets" }, create: ["owner"], update: ["owner"], move: { none: "no lifecycle" }, delete: ["owner"],
  reveal: { none: "Secrets are never shown again once saved" }, import: { none: "secrets are typed" } }, primary_action: "create_record" };
const STORAGE = { name: "storage_connections", label: "Storage connections", role: "source", scope: "workspace",
  fields: [{ name: "bucket", label: "Bucket", type: "text" }, { name: "endpoint", label: "Endpoint", type: "url" },
    { name: "access_key_id", label: "Access key ID", type: "text", encrypted: true }, { name: "secret_access_key", label: "Secret access key", type: "text", encrypted: true },
    { name: "use_for_files", label: "In use", type: "boolean" }],
  permissions: { read: ALL, create: ["owner"], update: ["owner", "member"], delete: ["owner"] },
  contract: { ...contract, actions: { ...contract.actions, update: ["owner", "member"] } } };
const COMPUTE = { name: "compute_connections", label: "Compute connections", role: "source", scope: "workspace",
  fields: [{ name: "provider", label: "Provider", type: "enum", options: ["paas", "vm"] }, { name: "account_id", label: "Account", type: "text" },
    { name: "api_token", label: "API token", type: "text", encrypted: true }],
  permissions: { read: ALL, create: ["owner"], update: ["owner"], delete: ["owner"] }, contract };
const CONNECTION_ENV = [
  { area: "storage_connections", use: "use_for_files", prefix: "STORAGE_",
    fields: { BUCKET: "bucket", ENDPOINT: "endpoint", ACCESS_KEY_ID: "access_key_id", SECRET_ACCESS_KEY: "secret_access_key" } },
  { area: "compute_connections", where: { provider: "paas" }, prefix: "COMPUTE_", fields: { API_TOKEN: "api_token", ACCOUNT: "account_id" } },
  // Members may start a session with the network's, but only with a record they can see (its visibility).
  { area: "network_connections", prefix: "NETWORK_", roles: ["owner", "member"], fields: { TOKEN: "api_token", ID: "network_id" } },
];
const NETWORK = { name: "network_connections", label: "Network connections", role: "source", scope: "workspace",
  fields: [{ name: "network_id", label: "Network", type: "text" }, { name: "api_token", label: "API token", type: "text", encrypted: true }],
  visibility: { modes: ["workspace", "private"], default: "private" },
  permissions: { read: ALL, create: ["owner", "member"], update: ["owner", "member"], delete: ["owner"] },
  contract: { ...contract, actions: { ...contract.actions, create: ["owner", "member"], update: ["owner", "member"] } } };
// mold_v0-322: members may add and edit these records, but only an owner lets members' sessions receive one.
const MEMBERS = { name: "members_may_use", label: "Members' builds may use its keys", type: "boolean" };
const BUILD = { name: "build_connections", label: "Build connections", role: "source", scope: "workspace",
  fields: [{ name: "host", label: "Host", type: "text" }, { name: "api_token", label: "API token", type: "text", encrypted: true },
    { name: "use_in_builds", label: "Use in builds", type: "boolean" }, MEMBERS, { name: "notes", label: "Notes", type: "text" }],
  permissions: { read: ALL, create: ["owner", "member"], update: ["owner", "member"], delete: ["owner"] },
  contract: { ...contract, actions: { ...contract.actions, create: ["owner", "member"], update: ["owner", "member"] } },
  detail: { tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["host", "use_in_builds", "members_may_use"] }] }], actions: [{ kind: "edit", place: "secondary" }] } };
// A connection of plain values only (it takes an import: an area with an encrypted field never does).
const TARGETS = { name: "deploy_targets", label: "Deploy targets", role: "source", scope: "workspace",
  fields: [{ name: "region", label: "Region", type: "text" }, MEMBERS],
  permissions: { read: ALL, create: ["owner", "member"], update: ["owner", "member"], delete: ["owner"] },
  contract: { ...contract, actions: { ...contract.actions, create: ["owner", "member"], update: ["owner", "member"], import: ["owner", "member"] } } };
const BUILDER_ENV = [
  { area: "build_connections", use: "use_in_builds", prefix: "BUILD_", members_field: "members_may_use", fields: { HOST: "host", TOKEN: "api_token" } },
  { area: "deploy_targets", prefix: "TARGET_", members_field: "members_may_use", fields: { REGION: "region" } }];
const PACK = { id: "fixture_conn_env", name: "Fixture connection env", version: "1", record_areas: [STORAGE, COMPUTE, NETWORK, BUILD, TARGETS],
  agent_profiles: [{ id: "deployer", name: "Deploy an application", connection_env: CONNECTION_ENV }, { id: "plain-agent", name: "No connections" },
    { id: "builder", name: "Builder", connection_env: BUILDER_ENV },
    // mold_v0-321: one area split by `where` (as a network per cloud), and two entries of one area naming a flag no record has on.
    { id: "split", name: "Split entries", connection_env: [
      { area: "compute_connections", where: { provider: "paas" }, prefix: "COMPUTE_", fields: { API_TOKEN: "api_token" } },
      { area: "compute_connections", where: { provider: "vm" }, prefix: "VM_", fields: { API_TOKEN: "api_token" } },
      { area: "storage_connections", use: "use_for_files", prefix: "STORAGE_", fields: { BUCKET: "bucket" } },
      { area: "storage_connections", use: "use_for_files", where: { bucket: "other-files" }, prefix: "OTHER_", fields: { BUCKET: "bucket" } }] }] };

try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const api = await import("../src/pack-api.js");
  const ra = await import("../src/record-areas.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const P = await import("../src/agent-profiles.js");
  const harness = await import("../src/run-harness.js");
  const cred = await import("../src/credentials.js");
  const { redactText } = await import("../src/credential-redact.js");
  const { connectionEnvProblems } = await import("../src/connection-env-config.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations, PackJsonSchema } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");

  // ---------- 1. the declaration ----------
  {
    const parsed = PackJsonSchema.safeParse(PACK);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(connectionEnvProblems(CONNECTION_ENV, [STORAGE, COMPUTE, NETWORK]), [], "the fixture's declaration");
    const bad = (patch: (c: any, areas: any[]) => void, re: RegExp, what: string, taken: string[] = []) => {
      const c = structuredClone(CONNECTION_ENV) as any, areas = structuredClone([STORAGE, COMPUTE, NETWORK]) as any[]; patch(c, areas);
      const p = connectionEnvProblems(c, areas, taken);
      assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
    };
    bad((_c, a) => { a[1].scope = "platform"; }, /shared area/, "a shared area");
    bad((_c, a) => { a[0].contract.actions.reveal = ["owner"]; }, /reveals nothing/, "an area whose secrets an owner could reveal");
    bad((c) => { c[1].fields.API_TOKEN = "nope"; }, /has no field nope/, "a field the area lacks");
    bad((c) => { delete c[1].prefix; }, /connection_env\.1\.prefix/, "no prefix");
    for (const pre of ["RUN_", "LD_", "PYTHON_", "BASH_", "SSL_", "CURL_", "REQUESTS_", "GCONV_", "NODE_", "DYLD_"])
      bad((c) => { c[1].prefix = pre; }, new RegExp(`prefix: ${pre} starts names a program or the session reads itself`), `the prefix ${pre}`);
    bad((c) => { c[1].prefix = "HTTP_"; c[1].fields.PROXY = "account_id"; }, /sets HTTP_PROXY itself/, "HTTP_PROXY");
    bad((c) => { c[1].prefix = "PROMPT_"; c[1].fields.COMMAND = "account_id"; }, /sets PROMPT_COMMAND itself/, "PROMPT_COMMAND");
    bad((c) => { c[1].prefix = "BASH_"; }, /prefix: BASH_/, "BASH_ENV's prefix");
    bad((c) => { c[1].fields.lower = "account_id"; }, /variable's name/, "a lower-case name");
    bad((c) => { c[1].prefix = "STORAGE_"; c[1].fields.BUCKET = "account_id"; }, /STORAGE_BUCKET is also set by connection_env\[0\]/, "a variable set twice");
    bad((c) => { c[2].roles = ["viewer"]; }, /connection_env\.2\.roles/, "a viewer's");
    bad((_c, a) => { a[1].lifecycle = { field: "account_id" }; }, /account_id is the lifecycle's field/, "a lifecycle's field delivered");
    bad(() => {}, /COMPUTE_API_TOKEN is also set by the profile's own credentials/, "a credential's variable", ["COMPUTE_API_TOKEN"]);
    bad((c) => { c[0].use = "bucket"; }, /plain boolean field/, "use as text");
    bad((c) => { c[1].where = { api_token: "x" }; }, /encrypted: narrow by a plain field/, "where on a secret");
    bad((c) => { c[0].area = "elsewhere"; }, /declares no record area elsewhere/, "an area of no pack");
    // And through the pack's own check (validatePack: the build and the install).
    const def = compileDeclarations({ ...PACK, agent_profiles: [{ id: "deployer", name: "x", connection_env: [{ area: "compute_connections", prefix: "PYTHON_", fields: { PATH: "api_token" } }] }] } as never);
    assert.throws(() => api.validatePack({ id: PACK.id, ...def } as never), /agent profile deployer: connection_env\[0\]\.prefix: PYTHON_ starts names a program or the session reads itself/);
    // mold_v0-322: members_field, a plain boolean of its own, with members left out of roles.
    assert.deepEqual(connectionEnvProblems(BUILDER_ENV, [BUILD, TARGETS]), [], "the members' opt-in fixture");
    const badM = (patch: (c: any, areas: any[]) => void, re: RegExp, what: string) => {
      const c = structuredClone(BUILDER_ENV) as any, areas = structuredClone([BUILD, TARGETS]) as any[]; patch(c, areas);
      const p = connectionEnvProblems(c, areas);
      assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
    };
    badM((c) => { c[0].members_field = "nope"; }, /members_field: build_connections has no field nope/, "a field the area lacks");
    badM((c) => { c[0].members_field = "host"; }, /members_field: host is a plain boolean field/, "a text field");
    badM((c) => { c[0].members_field = "use_in_builds"; }, /also the entry's use, where or a delivered field/, "the entry's own use flag");
    badM((c) => { c[0].roles = ["owner", "member"]; }, /roles already gives members every record/, "members in roles too");
    badM((_c, a) => { a[0].fields[3].set_by = "action"; }, /members_field: members_may_use is set_by "action"/, "a field the app's actions set");
    badM((_c, a) => { a[0].lifecycle = { field: "members_may_use" }; }, /members_field: members_may_use is the lifecycle's field/, "the lifecycle's field");
    ok("the declaration: a workspace area whose contract reveals nothing, fields it has, well-formed names never the session's own or set twice, use a boolean, where on plain fields; members_field a plain boolean of its own, members not in roles");
  }

  setPacksForTest([{ manifest: { id: PACK.id, name: "x", version: "1", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
  F.setFeatureForTest("agent_harness", true);
  F.setFeatureForTest("teams", true);
  const AT = await import("../src/audit-trail.js");
  AT.setAuditForTest({ data: true });
  P.resetProfileSeedForTest();
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  const web = await startHttp();
  process.env.PUBLIC_URL = web.base;
  const A = (await createOrg(`Conn env A ${STAMP}`)).org, B = (await createOrg(`Conn env B ${STAMP}`)).org;
  const ownerA = { kind: "person" as const, user: "user_owner_a", name: "owner@example.org", role: "owner" as const };
  const memberA = { kind: "person" as const, user: "user_member_a", name: "member@example.org", role: "member" as const };
  const recs = (org: number) => ra.workspaceRecords(PACK.id, org, { role: "owner", userId: "user_owner" });
  const add = (org: number, area: string, key: string, data: Record<string, unknown>) => ra.asWriter({ by: "people", id: "owner" }, () => recs(org).create(area, key, { title: key, data }));
  await add(A.orgId, "storage_connections", "old-bucket", { bucket: "old-files", endpoint: "https://old.example.com", access_key_id: A_KEYID, secret_access_key: A_OLD, use_for_files: false });
  await add(A.orgId, "storage_connections", "files", { bucket: "ws-a-files", endpoint: "https://storage.example.com", access_key_id: A_KEYID, secret_access_key: A_SECRET, use_for_files: true });
  await add(A.orgId, "compute_connections", "hosting", { provider: "paas", account_id: "team-a", api_token: A_TOKEN });
  await add(A.orgId, "compute_connections", "vm", { provider: "vm", account_id: "vm-a", api_token: canary("vm") });
  await add(B.orgId, "compute_connections", "hosting", { provider: "paas", account_id: "team-b", api_token: B_TOKEN });
  // The network's one record: private to the owner who added it (a member cannot see it).
  await ra.asWriter({ by: "people", id: "user_owner" }, () => recs(A.orgId).create("network_connections", "net", { title: "net", data: { network_id: "net-1", api_token: NET_TOKEN }, visibility: { mode: "private" } }));

  const client = await harness.localRunnerClient("w-conn-env");
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 250 };
  const wake = async (sessionId: string) => {
    const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]);
    assert.ok(c, "a wake to claim");
    const [r] = await db.query<{ harness_session_id: string }>("SELECT harness_session_id FROM runs WHERE id = $1", [c!.run.id]);
    assert.equal(r!.harness_session_id, sessionId);
    return { claim: c!, done: harness.runWorkspaceHarness(client, c!, opts) };
  };
  const until = async (what: string, f: () => Promise<boolean>, ms = 20_000) => {
    const t = Date.now();
    while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
  };
  const transcript: string[] = [];

  // ---------- 2. at start ----------
  let sid: string;
  {
    // M1: two storage records in use refuse the start (exactly one is used); one again, it starts.
    await add(A.orgId, "storage_connections", "rival", { bucket: "rival-files", endpoint: "https://rival.example.com", access_key_id: canary("rival-id"), secret_access_key: canary("rival"), use_for_files: true });
    await assert.rejects(H.startSession(A.orgId, ownerA, { message: "x", profile: "deployer" }), /Storage connections has more than one record marked "In use" \(\w+, \w+\): keep exactly one marked "In use", then start again/);
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).delete("storage_connections", "rival"));
    const s = await H.startSession(A.orgId, ownerA, { message: "env STORAGE_BUCKET", profile: "deployer" });
    sid = s.id;
    const [row] = await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [sid]);
    assert.deepEqual(row!.policy.connection_env.map((c: any) => [c.area, c.vars.map((v: any) => v.env)]), [
      ["storage_connections", ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"]],
      ["compute_connections", ["COMPUTE_API_TOKEN", "COMPUTE_ACCOUNT"]], ["network_connections", ["NETWORK_TOKEN", "NETWORK_ID"]]], "names and fields frozen");
    assert.deepEqual(row!.policy.connection_env.map((c: any) => c.key), ["files", "hosting", "net"], "each entry's one record frozen with the session (never the latest changed at a wake)");
    assert.ok(!SECRETS.some((x) => JSON.stringify(row!.policy).includes(x)), "no value in the policy");
    const d = await H.readSession(A.orgId, sid, ownerA);
    const sys = d.messages.filter((m) => m.role === "system").map((m) => m.body).join("\n");
    assert.match(sys, /environment has these variables[^\n]*STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY \(storage_connections\); COMPUTE_API_TOKEN, COMPUTE_ACCOUNT \(compute_connections\)/);
    // H2: a member may update the network's records and the entry names members, but the one record is private to
    // its owner: the member's session gets none of it (nor the owners-only storage and compute). A profile without
    // connection_env: none.
    const m = await H.startSession(A.orgId, memberA, { message: "x", profile: "deployer" });
    const p = await H.startSession(A.orgId, ownerA, { message: "x", profile: "plain-agent" });
    for (const x of [m, p]) {
      const [r] = await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [x.id]);
      assert.equal(r!.policy.connection_env, undefined, "none frozen");
      assert.ok(!(await H.readSession(A.orgId, x.id, x === m ? memberA : ownerA)).messages.some((y) => /environment has these variables/.test(y.body)), "none listed");
    }
    assert.ok((await H.readSession(A.orgId, m.id, memberA)).messages.some((y) => /No record of Network connections is in use/.test(y.body)), "the member's session says the network has none it can use");
    // The member's own network record (visible to them): theirs is the one.
    await ra.asWriter({ by: "people", id: "user_member_a" }, () => ra.workspaceRecords(PACK.id, A.orgId, { role: "member", userId: "user_member_a" })
      .create("network_connections", "net-member", { title: "mine", data: { network_id: "net-2", api_token: canary("member-net") }, visibility: { mode: "private" } }));
    const m2 = await H.startSession(A.orgId, memberA, { message: "x", profile: "deployer" });
    const [r2] = await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [m2.id]);
    assert.deepEqual(r2!.policy.connection_env.map((c: any) => [c.area, c.key]), [["network_connections", "net-member"]], "only the record the member sees, never the owner's private one");
    await H.stopSession(A.orgId, m2.id, memberA);
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).delete("network_connections", "net-member"));
    // Their queued wakes are not this test's: they are stopped before any runs.
    await H.stopSession(A.orgId, m.id, memberA); await H.stopSession(A.orgId, p.id, ownerA);
    ok("at start: the names frozen (no value) and listed in the first system message; a member who may not update the areas and a profile without connection_env get none");
    // mold_v0-321: workspace B has a paas account (the vm entry finds none: the area gave a record, so it is no news) and
    // no storage record in use (two entries of one area: named once, by the flag's label a person turns on).
    const ownerB = { kind: "person" as const, user: "user_owner_b", name: "owner-b@example.org", role: "owner" as const };
    const sp = await H.startSession(B.orgId, ownerB, { message: "x", profile: "split" });
    const spSys = (await H.readSession(B.orgId, sp.id, ownerB)).messages.filter((y) => y.role === "system").map((y) => y.body).join("\n");
    assert.match(spSys, /COMPUTE_API_TOKEN \(compute_connections\)/, "the paas entry gave its record");
    assert.ok(!/Compute connections/.test(spSys), `an area another entry gave a record is not said to have none: ${spSys}`);
    assert.equal(spSys.match(/Storage connections/g)?.length, 1, `an area named once: ${spSys}`);
    assert.match(spSys, /No record of Storage connections is marked "In use": its variables are not set\./, "by the flag's label");
    await H.stopSession(B.orgId, sp.id, ownerB);
    ok("mold_v0-321: an area without a record is named once, by the flag a person turns on, and not when another of its entries gave one");
  }

  // ---------- 3. each wake ----------
  {
    const rd = () => H.readSession(A.orgId, sid, ownerA);
    const lastAgent = async () => (await rd()).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
    const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
    const agentCount = async () => (await rd()).messages.filter((m) => m.role === "agent").length;
    const ask = async (msg: string, re: RegExp) => {
      const n = await agentCount();
      await H.messageSession(A.orgId, sid, ownerA, msg);
      await until(msg, async () => (await agentCount()) > n && re.test(await lastAgent()));
      return lastAgent();
    };
    const w = await wake(sid);
    await until("the bucket", () => said(/^Env STORAGE_BUCKET/));
    assert.equal(await lastAgent(), "Env STORAGE_BUCKET: ws-a-files", "a plain field as it is, from the record in use (not the old one)");
    assert.equal(await ask("env COMPUTE_ACCOUNT", /^Env COMPUTE_ACCOUNT/), "Env COMPUTE_ACCOUNT: team-a", "where: the paas record, the workspace's own");
    assert.equal(await ask(`run printf %s "$COMPUTE_API_TOKEN" | sha256sum`, /^Ran: 0 [0-9a-f]{64}/), `Ran: 0 ${sha(A_TOKEN)}  -`, "the token in the sandbox's environment: its own workspace's (proved by its hash)");
    assert.equal(await ask(`run printf %s "$STORAGE_SECRET_ACCESS_KEY" | sha256sum`, /^Ran: 0 [0-9a-f]{64}/), `Ran: 0 ${sha(A_SECRET)}  -`, "the record in use's secret, not the old one's");
    assert.equal(await ask("env COMPUTE_API_TOKEN", /^Env COMPUTE_API_TOKEN/), "Env COMPUTE_API_TOKEN: [credential connection:compute_connections/COMPUTE_API_TOKEN]", "printed: redacted");
    assert.equal(await ask(`run echo "key=$STORAGE_SECRET_ACCESS_KEY"`, /^Ran: 0 key=/), "Ran: 0 key=[credential connection:storage_connections/STORAGE_SECRET_ACCESS_KEY]", "echoed by a command: redacted");
    assert.equal(await ask("env PATH", /^Env PATH/) === "Env PATH: unset", false, "the session's own PATH is its own");
    assert.equal(await ask(`run printf %s "$NETWORK_TOKEN" | sha256sum`, /^Ran: 0 [0-9a-f]{64}/), `Ran: 0 ${sha(NET_TOKEN)}  -`, "the owner sees the private network record: theirs");
    // M2: the token rotated mid-wake: the wake keeps what it was given, and what it prints of the old value is still redacted.
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("compute_connections", "hosting", { title: "hosting", data: { provider: "paas", account_id: "team-a", api_token: ROTATED } }));
    assert.equal(await ask(`run echo "old=$COMPUTE_API_TOKEN"`, /^Ran: 0 old=/), "Ran: 0 old=[credential connection:compute_connections/COMPUTE_API_TOKEN]", "the old value, after a rotation: redacted");
    const runId = w.claim.run.id;
    // mold_v0-320: another server instance (a fresh copy of the module: nothing in its memory) redacts what this one
    // delivered: the old token is no record's value any more, so only the database's sealed copy can name it.
    const [{ org_id: runOrg }] = await db.query<{ org_id: number }>("SELECT org_id FROM runs WHERE id = $1", [runId]);
    const frozen = (await db.query<{ spec: any }>("SELECT spec FROM runs WHERE id = $1", [runId]))[0]!.spec.connection_env;
    const second = await import(`../src/connection-env.js?instance=${randomBytes(4).toString("hex")}`) as typeof import("../src/connection-env.js");
    assert.notEqual(second, await import("../src/connection-env.js"), "the second instance is a fresh module (its own memory)");
    const elsewhere = await second.connectionSecrets({ id: runId, org_id: runOrg, spec: { connection_env: frozen } });
    assert.ok(elsewhere.some((x) => x.value === A_TOKEN && x.name === "connection:compute_connections/COMPUTE_API_TOKEN"), "a second instance redacts the value the first delivered (rotated since: no record holds it)");
    assert.equal(redactText(`leak ${A_TOKEN}`, elsewhere), "leak [credential connection:compute_connections/COMPUTE_API_TOKEN]");
    const atRest = await db.query<{ run_id: string; digest: string; sealed: string }>("SELECT run_id, digest, sealed FROM run_delivered_secrets WHERE run_id = $1", [runId]);
    assert.ok(atRest.length >= 3, `the delivered secrets are kept sealed while the run runs (${atRest.length})`);
    const restText = JSON.stringify(atRest);
    for (const x of SECRETS) {
      assert.ok(!restText.includes(x) && !restText.includes(sha(x)) && !restText.includes(Buffer.from(x).toString("base64")), "no plain value, plain hash or encoding at rest");
      assert.ok(!atRest.some((r) => Buffer.from(r.sealed, "base64").includes(Buffer.from(x))), "the sealed bytes hold no plain value");
    }
    assert.ok(!(await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_delivered_secrets WHERE name LIKE '%STORAGE_BUCKET%'"))[0]!.n, "a plain field is never kept");
    await H.stopSession(A.orgId, sid, ownerA);
    await w.done;
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_delivered_secrets WHERE run_id = $1", [runId]))[0]!.n, 0, "the run's end deletes what it was given");
    const third = await import(`../src/connection-env.js?instance=${randomBytes(4).toString("hex")}`) as typeof import("../src/connection-env.js");
    assert.ok(!(await third.connectionSecrets({ id: runId, org_id: runOrg, spec: { connection_env: frozen } })).some((x) => x.value === A_TOKEN), "after the end, nothing of it is left to open");
    // A delivery that raced the end (a row the end missed) goes with the next run sweep.
    await db.query("INSERT INTO run_delivered_secrets (run_id, org_id, name, digest, sealed, expires_at) VALUES ($1, $2, 'x', 'leftover', 'x', now() + interval '1 hour')", [runId, runOrg]);
    await (await import("../src/runs.js")).sweepRuns();
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_delivered_secrets WHERE run_id = $1", [runId]))[0]!.n, 0, "the sweep removes a leftover of an ended run");
    ok("mold_v0-320: what a wake was given is kept sealed in the database (no plain value, hash or encoding at rest), a second instance redacts it, it is gone when the run ends, and the sweep removes a leftover");
    const ev = await db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [runId]);
    assert.deepEqual(ev.find((e) => e.type === "credentials")?.data.delivered.sort(), [
      "connection:compute_connections/COMPUTE_ACCOUNT", "connection:compute_connections/COMPUTE_API_TOKEN", "connection:network_connections/NETWORK_ID", "connection:network_connections/NETWORK_TOKEN", "connection:storage_connections/STORAGE_ACCESS_KEY_ID",
      "connection:storage_connections/STORAGE_BUCKET", "connection:storage_connections/STORAGE_ENDPOINT", "connection:storage_connections/STORAGE_SECRET_ACCESS_KEY"], "the run records the names only");
    // The server's own backstop: the wake's run's secrets (the sealed values, not the plain ones), and a value redacted with them.
    const [run] = await db.query<{ id: string; org_id: number; pack: string; spec: any; targets: any }>("SELECT id, org_id, pack, spec, targets FROM runs WHERE id = $1", [runId]);
    const secrets = await cred.runSecrets(run as never);
    const values = secrets.map((s) => s.value);
    assert.ok(values.includes(A_TOKEN) && values.includes(A_SECRET) && values.includes(A_KEYID), "the backstop holds the sealed values it delivered");
    assert.ok(!values.includes(ROTATED), "the rotated value was never this run's (the record changed since the start: nothing of it is delivered)");
    // M3: the redaction lookups write no data-trail line (only the delivery did, once per record).
    const countReads = async () => { await AT.flushAudit(); return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND action = 'read' AND area = 'compute_connections' AND record_key = 'hosting'", [A.orgId]))[0]!.n; };
    const reads = await countReads();
    assert.ok(reads >= 1, `the delivery wrote its data-trail read (${reads})`);
    await cred.runSecrets(run as never); await cred.runSecrets(run as never);
    assert.equal(await countReads(), reads, "redaction lookups audit nothing");
    assert.ok(!values.includes("ws-a-files") && !values.includes(B_TOKEN) && !values.includes(A_OLD), "and not a plain value, another workspace's or an unused record's");
    assert.equal(redactText(`token ${A_TOKEN}`, secrets), "token [credential connection:compute_connections/COMPUTE_API_TOKEN]");
    const trace = await H.sessionTrace(A.orgId, sid, ownerA);
    transcript.push(JSON.stringify(await rd()), JSON.stringify(trace), JSON.stringify(ev));
    const echo = trace.steps.find((x) => x.kind === "command" && /^echo /.test(x.preview ?? ""));
    assert.ok(echo, "the echo is in the trace");
    const step = await H.sessionTraceStep(A.orgId, sid, ownerA, echo!.id);
    transcript.push(JSON.stringify(step));
    ok("each wake: plain fields as they are, secrets in the sandbox's environment (by hash), the record in use and the workspace's own; printed or echoed, redacted in the answer and the trace; the run names only; the backstop holds the sealed values only");
  }

  // ---------- 3b. bound secrets, short secrets ----------
  {
    const CE = await import("../src/connection-env.js");
    const area = ra.findArea("compute_connections")!;
    const frozen = [{ pack: PACK.id, area: "compute_connections", key: "hosting", where: { provider: "paas" }, vars: [{ env: "COMPUTE_API_TOKEN", field: "api_token" }, { env: "COMPUTE_ACCOUNT", field: "account_id" }] }];
    // A secret shorter than 8 characters is never delivered (redaction could not tell it from words).
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("compute_connections", "hosting", { title: "hosting", data: { provider: "paas", account_id: "team-a", api_token: "short1" } }));
    const got = await CE.connectionEnvValues(A.orgId, frozen);
    assert.deepEqual([got.missing, got.delivered.map((d) => d.env)], [["connection:compute_connections/COMPUTE_API_TOKEN", "connection:compute_connections/COMPUTE_ACCOUNT"], []],
      "a short secret: missing, and the entry is all or nothing (its account not given without its token)");
    // H1 for sessions: a member or owner who changes a delivered plain field without typing the secret again clears it.
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("compute_connections", "hosting", { title: "hosting", data: { provider: "paas", account_id: "team-a", api_token: ROTATED } }));
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("compute_connections", "hosting", { title: "hosting", data: { provider: "paas", account_id: "attacker-team" } }));
    const stored = (await ra.workspaceStored(A.orgId, area, ["hosting"])).get("hosting")!;
    assert.equal(stored.data.api_token, undefined, "the token was cleared: it never goes with the new account");
    assert.deepEqual((await CE.connectionEnvValues(A.orgId, frozen)).delivered, [], "nothing of the entry without its token");
    // Typed again in the same write: kept.
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("compute_connections", "hosting", { title: "hosting", data: { provider: "paas", account_id: "team-c", api_token: ROTATED } }));
    assert.ok((await ra.workspaceStored(A.orgId, area, ["hosting"])).get("hosting")!.data.api_token, "a change that types the token again keeps it");
    ok("bound and short secrets: a delivered plain field changed without the secret clears it (typed again, kept); a secret under 8 characters is never delivered");
  }

  // ---------- 3c. N1: the record as it was when the session started, or nothing ----------
  {
    const CE = await import("../src/connection-env.js");
    const sarea = ra.findArea("storage_connections")!;
    const memberRecs = ra.workspaceRecords(PACK.id, A.orgId, { role: "member", userId: "user_member_a" });
    const asMember = <T>(fn: () => Promise<T>) => ra.asWriter({ by: "people", id: "user_member_a" }, fn);
    const good = { bucket: "ws-a-files", endpoint: "https://storage.example.com", access_key_id: A_KEYID, secret_access_key: A_SECRET, use_for_files: true };
    const restore = () => ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("storage_connections", "files", { title: "files", data: good }));
    const frozenOf = async (id: string) => (await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [id]))[0]!.policy.connection_env
      .filter((c: any) => c.area === "storage_connections");
    const storageGiven = async (id: string) => (await CE.connectionEnvValues(A.orgId, await frozenOf(id))).delivered.map((d) => d.env);
    const startS = async () => (await H.startSession(A.orgId, ownerA, { message: "x", profile: "deployer" })).id;
    // Unchanged: delivered (and a re-save of the same values keeps its version: the sealed keys are carried as they are).
    await restore();
    let s2 = await startS();
    assert.deepEqual(await storageGiven(s2), ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"]);
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).update("storage_connections", "files", { title: "files renamed", data: { ...good, access_key_id: undefined, secret_access_key: undefined } }));
    assert.equal((await storageGiven(s2)).length, 4, "a change of nothing the entry reads (its title; its kept keys): still delivered");
    // (A) a member points it at their own bucket and types their own keys: the owner's session gets nothing.
    await asMember(() => memberRecs.update("storage_connections", "files", { title: "files", data: { ...good, endpoint: "https://collector.evil.example", access_key_id: canary("evil-id"), secret_access_key: canary("evil-key") } }));
    assert.deepEqual(await storageGiven(s2), [], "(A) changed with the attacker's own keys: nothing delivered");
    // Through the real delivery path: the wake's credentials leave it out, and the session is told in words.
    const [run] = await db.query<{ id: string; org_id: number; pack: string; spec: any; targets: any }>("SELECT id, org_id, pack, spec, targets FROM runs WHERE harness_session_id = $1 ORDER BY created_at DESC LIMIT 1", [s2]);
    const creds = await cred.runCredentials(run as never);
    assert.ok(!creds.credentials.some((c) => c.name.startsWith("connection:storage_connections/")) && creds.missing.includes("connection:storage_connections/STORAGE_ENDPOINT"), "the wake gets none of it");
    assert.ok((await H.readSession(A.orgId, s2, ownerA)).messages.some((m) => m.role === "system" && /Storage connections changed \(or was replaced\) since this session started, so its variables were not set/.test(m.body)),
      "the session is told, in words");
    await H.stopSession(A.orgId, s2, ownerA);
    // (B) only the endpoint changed: the keys are cleared, and the endpoint is not delivered either.
    await restore();
    s2 = await startS();
    await asMember(() => memberRecs.update("storage_connections", "files", { title: "files", data: { ...good, endpoint: "https://collector.evil.example", access_key_id: undefined, secret_access_key: undefined } }));
    assert.equal((await ra.workspaceStored(A.orgId, sarea, ["files"])).get("files")!.data.secret_access_key, undefined, "(B) the keys cleared");
    assert.deepEqual(await storageGiven(s2), [], "(B) and not even the new endpoint delivered");
    await H.stopSession(A.orgId, s2, ownerA);
    // Deleted and added again under the same key, with the same plain values: another row, nothing.
    await restore();
    s2 = await startS();
    await ra.asWriter({ by: "people", id: "owner" }, () => recs(A.orgId).delete("storage_connections", "files"));
    await add(A.orgId, "storage_connections", "files", { ...good, access_key_id: canary("new-id"), secret_access_key: canary("new-key") });
    assert.deepEqual(await storageGiven(s2), [], "deleted and re-added: nothing delivered");
    await H.stopSession(A.orgId, s2, ownerA);
    ok("N1: a wake delivers the record only as it was at the session's start: a member's edit (their own keys, or the endpoint alone), or a delete and re-add, gives nothing, said in the session; an entry is all or nothing");
  }

  // ---------- 5. mold_v0-322: members' sessions, through an owner's opt-in on the record ----------
  {
    const CE = await import("../src/connection-env.js");
    const RI = await import("../src/record-import.js");
    const barea = ra.findArea("build_connections")!;
    const ownerRecs = ra.workspaceRecords(PACK.id, A.orgId, { role: "owner", userId: "user_owner_a" });
    const memberRecs = ra.workspaceRecords(PACK.id, A.orgId, { role: "member", userId: "user_member_a" });
    const asOwner = <T>(fn: () => Promise<T>) => ra.asWriter({ by: "people", id: "user_owner_a" }, fn);
    const asMember = <T>(fn: () => Promise<T>) => ra.asWriter({ by: "people", id: "user_member_a" }, fn);
    const ci = { host: "ci.example.com", use_in_builds: true };
    const flag = async () => (await ra.workspaceStored(A.orgId, barea, ["ci"])).get("ci")!.data.members_may_use;
    const policyOf = async (id: string) => ((await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [id]))[0]!.policy.connection_env ?? [])
      .filter((c: any) => c.area === "build_connections");
    const trailCount = async (action: string, key = "ci") => { await AT.flushAudit(); return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_data_events WHERE org_id = $1 AND action = $2 AND area IN ('build_connections', 'deploy_targets') AND record_key = $3", [A.orgId, action, key]))[0]!.n; };
    const startM = async () => (await H.startSession(A.orgId, memberA, { message: "x", profile: "builder" })).id;
    await asOwner(() => ownerRecs.create("build_connections", "ci", { title: "ci", data: { ...ci, api_token: BUILD_TOKEN } }));
    await asOwner(() => ownerRecs.create("deploy_targets", "t1", { title: "t1", data: { region: "eu" } }));

    // Off (never turned on): a member's session gets none of it, said in words; an owner's gets it (roles: owners).
    let m = await startM();
    assert.deepEqual(await policyOf(m), [], "off: nothing frozen for a member");
    assert.ok((await H.readSession(A.orgId, m, memberA)).messages.some((x) => x.role === "system" && /Build connections: a workspace owner has not turned on "Members' builds may use its keys" for the record in use, so its variables are not set for sessions members start\./.test(x.body)),
      "the member's session says which switch an owner turns on");
    await H.stopSession(A.orgId, m, memberA);
    const o = (await H.startSession(A.orgId, ownerA, { message: "x", profile: "builder" })).id;
    assert.equal((await policyOf(o)).length, 1, "an owner's session receives it whatever the opt-in");
    await H.stopSession(A.orgId, o, ownerA);

    // A member cannot set it: the data API's update and create, a batch (bulk), inside an action's scope; nor an agent's
    // tool call in an owner's session; nor an import (its preview says so, its write refuses it, nothing is written).
    const refusal = /"Members' builds may use its keys" of Build connections records is for the workspace's owners to set: leave it out/;
    await assert.rejects(asMember(() => memberRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: true } })), refusal, "the API's update");
    await assert.rejects(asMember(() => memberRecs.create("build_connections", "mine", { title: "mine", data: { host: "mine.example.com", api_token: canary("mine"), members_may_use: true } })), refusal, "a create");
    await assert.rejects(asMember(() => memberRecs.batch([{ op: "update", area: "build_connections", key: "ci", title: "ci", data: { ...ci, members_may_use: true } }] as never)), refusal, "a batch");
    await assert.rejects(asMember(() => ra.asAction(() => memberRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: true } }))), refusal, "an action's scope");
    await assert.rejects(ra.asVia("run:fixture-wake", () => asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: true } }))), refusal, "an agent's tool call, even in an owner's session");
    const rows = [{ key: "t1", title: "t1", data: { region: "eu", members_may_use: true } }];
    const preview = await RI.importWorkspaceRecords(A.orgId, { role: "member", userId: "user_member_a" }, ra.findArea("deploy_targets")!, rows, { dryRun: true });
    assert.equal(preview.rows[0]!.action, "invalid", JSON.stringify(preview.rows));
    assert.match(preview.rows[0]!.errors.join(" "), /"Members' builds may use its keys" of Deploy targets records is for the workspace's owners to set/);
    await RI.importWorkspaceRecords(A.orgId, { role: "member", userId: "user_member_a" }, ra.findArea("deploy_targets")!, rows, { dryRun: false });
    assert.notEqual((await ra.workspaceStored(A.orgId, ra.findArea("deploy_targets")!, ["t1"])).get("t1")!.data.members_may_use, true, "the import wrote nothing of it");
    assert.notEqual(await flag(), true, "still off");
    // A member's create that sends it off, and their edits that leave it out, are fine.
    await asMember(() => memberRecs.create("build_connections", "mine", { title: "mine", data: { host: "mine.example.com", api_token: canary("mine"), members_may_use: false } }));
    await ra.asWriter({ by: "people", id: "user_owner_a" }, () => ownerRecs.delete("build_connections", "mine"));
    // An owner's import may set it (a person, by hand).
    await RI.importWorkspaceRecords(A.orgId, { role: "owner", userId: "user_owner_a" }, ra.findArea("deploy_targets")!, rows, { dryRun: false });
    assert.equal((await ra.workspaceStored(A.orgId, ra.findArea("deploy_targets")!, ["t1"])).get("t1")!.data.members_may_use, true, "an owner's import sets it");
    assert.equal(await trailCount("grant", "t1"), 1, "and it is a grant line");
    ok("mold_v0-322: off, a member's session gets nothing (said by the switch's label); a member cannot set it by the API, a create, a batch, an action or an import, nor an agent in an owner's session; an owner's import can");

    // An owner turns it on: a grant line; a member's session now receives it (values, redaction).
    const grants = await trailCount("grant");
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: true } }));
    assert.equal(await flag(), true);
    assert.equal(await trailCount("grant"), grants + 1, "turning it on is a grant line of the data trail (its key, never a value)");
    m = await startM();
    const frozen = await policyOf(m);
    assert.deepEqual(frozen.map((c: any) => [c.key, c.members]), [["ci", true]], "frozen for the member, marked as the owners' consent");
    const got = await CE.connectionEnvValues(A.orgId, frozen);
    assert.deepEqual(got.delivered.map((d) => d.env), ["BUILD_HOST", "BUILD_TOKEN"], "the member's wake receives the entry whole");
    assert.ok(got.delivered.some((d) => d.env === "BUILD_TOKEN" && d.value === BUILD_TOKEN && !d.plain), "the token, as a secret");
    const secrets = await CE.connectionSecrets({ org_id: A.orgId, spec: { connection_env: frozen } });
    assert.equal(redactText(`token ${BUILD_TOKEN}`, secrets), "token [credential connection:build_connections/BUILD_TOKEN]", "and redacted from what it writes");
    // A member's edit that leaves the switch out, and changes nothing of where the secrets go: kept on.
    await asMember(() => memberRecs.update("build_connections", "ci", { title: "ci renamed", data: { ...ci, notes: "a note" } }));
    assert.equal(await flag(), true, "a member's other edit keeps it");
    assert.equal((await CE.connectionEnvValues(A.orgId, frozen)).delivered.length, 2, "and the session still receives it");

    // Turned off after the member's session started: that session keeps what was frozen (its record unchanged); the
    // next member session gets none. A revoke line.
    const revokes = await trailCount("revoke");
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: false } }));
    assert.equal(await trailCount("revoke"), revokes + 1, "turning it off is a revoke line");
    assert.equal((await CE.connectionEnvValues(A.orgId, frozen)).delivered.length, 2, "documented: a session already started keeps receiving the record as frozen");
    const m2 = await startM();
    assert.deepEqual(await policyOf(m2), [], "a new member session gets none");
    await H.stopSession(A.orgId, m2, memberA); await H.stopSession(A.orgId, m, memberA);

    // A member's change of where the secrets go turns it off: the host (the token cleared by its binding too), or a token
    // typed again. A revoke line each; nothing delivered to the member's session started before.
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, members_may_use: true } }));
    m = await startM();
    const frozen2 = await policyOf(m);
    await asMember(() => memberRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, host: "collector.evil.example", members_may_use: true } }));
    const after = (await ra.workspaceStored(A.orgId, barea, ["ci"])).get("ci")!.data;
    assert.equal(after.members_may_use, false, "a member's new host turns it off (sent on, it is still turned off)");
    assert.equal(after.api_token, undefined, "and the token is cleared by its binding");
    assert.equal(await trailCount("revoke"), revokes + 2, "a revoke line");
    assert.deepEqual((await CE.connectionEnvValues(A.orgId, frozen2)).delivered, [], "the member's session started before gets nothing (its record changed)");
    await H.stopSession(A.orgId, m, memberA);
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, api_token: BUILD_NEW, members_may_use: true } }));
    await asMember(() => memberRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, api_token: BUILD_EVIL } }));
    assert.equal(await flag(), false, "a member's own token turns it off");
    assert.equal(await trailCount("revoke"), revokes + 3);
    // An owner's change of the host keeps their own consent.
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, host: "ci2.example.com", api_token: BUILD_NEW, members_may_use: true } }));
    await asOwner(() => ownerRecs.update("build_connections", "ci", { title: "ci", data: { ...ci, host: "ci3.example.com", api_token: BUILD_NEW, members_may_use: true } }));
    assert.equal(await flag(), true, "an owner's own edit keeps it");
    // The form a member is offered leaves the switch out; an owner's has it.
    const { pageActions } = await import("../src/record-page-routes.js");
    const row = (await ra.getFor(A.orgId, "build_connections", "ci", { role: "owner", userId: "user_owner_a" }))!;
    const formOf = async (role: "owner" | "member") => (await pageActions(barea, row, { role, userId: `user_${role}_a` }, { org: A.orgId }))
      .find((x) => x.kind === "edit")?.fields?.map((f: any) => f.name) ?? null;
    const [of, mf] = [await formOf("owner"), await formOf("member")];
    assert.ok(of?.includes("members_may_use"), `an owner's edit form has it: ${JSON.stringify(of)}`);
    assert.ok(mf && !mf.includes("members_may_use") && mf.includes("host"), `a member's does not: ${JSON.stringify(mf)}`);
    ok("mold_v0-322: on, a member's session receives the record whole and redacts it; a member's other edit keeps it; off later, a session already started keeps its frozen record, the next gets none; a member's new host or token turns it off (a revoke line each); an owner's edit keeps it; a member's form leaves it out");
  }

  // ---------- 4. no secret anywhere ----------
  {
    const trail = JSON.stringify(await db.query("SELECT * FROM audit_data_events WHERE org_id = $1", [A.orgId]).catch(() => []));
    const history = JSON.stringify(await db.query("SELECT * FROM record_changes WHERE org_id = $1", [A.orgId]).catch(() => []));
    const messages = JSON.stringify(await db.query("SELECT body FROM harness_session_messages WHERE org_id = $1", [A.orgId]));
    for (const s of SECRETS) {
      assert.ok(!transcript.some((t) => t.includes(s)), "not in the transcript, the trace or the run's events");
      assert.ok(!messages.includes(s), "not in any stored message");
      assert.ok(!trail.includes(s) && !history.includes(s), "not in the data trail or the history");
      assert.ok(!printed.some((p) => p.includes(s)), "nothing printed carries it");
    }
    ok("no secret in the transcript, the trace, the run's events, the stored messages, the data trail, the history or anything printed");
  }
  await web.close();
  console.log("connection-env-test: all passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
process.exit(process.exitCode ?? 0);
