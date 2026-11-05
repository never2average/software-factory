// The workspace credential vault (mold_v0-034; src/credentials.ts, src/credential-routes.ts, src/run-harness.ts),
// offline: an embedded database, the HTTP server behind a fake Clerk, fixture runs (scripts/fixtures/runs/creds.mjs).
//   npm run test:credentials
//
// 1. Zero packs: no fields, nothing mounted at /api/credentials.
// 2. definePack refuses fields that would get past the vault (an area that is not the pack's asset area, a kind naming
//    a field the pack lacks, a variable the shell sets, two fields on one variable, a file name with a directory).
// 3. The console: owners set values bound to the workspace, an asset of their own workspace, or an asset's environment;
//    every answer shows the last 4 characters only; members and viewers cannot set; a cookie write needs the CSRF
//    header; an asset of another workspace is refused; a body that is not JSON is refused without being quoted.
// 4. Sealed at rest with the workspace's data key: another workspace's key, or another slot, does not open a value.
// 5. Runs: a kind receives exactly the fields it names, for the asset and environment it targets, in its own
//    workspace: an environment variable, or a file (0400, the run user's) in a private directory on tmpfs, gone when
//    the program ends. Two workspaces with the same asset key, run at the same time: each run gets its own
//    workspace's values, never the other's (the cross-workspace injection count is 0). Over HTTP too.
// 6. Leaks: a program that prints every value every way, puts them in its results, writes one into its workspace or a
//    broken results file: everything stored is redacted, the workspace is not written back, the error quotes nothing.
//    The engine redacts again on its own (a runner that does not).
// 7. The canary grep: every table of the database (as text), the database's own files, the object store, the MCP
//    output, every HTTP answer and everything this process logged: 0 hits of any value in any of its encodings.
// 8. Row-level security: the catalog check and the live probe pass with the vault table; deleting a workspace deletes
//    its values.
// 9. Each credential in its own place (mold_v0-239): the workspace's on Settings › Credentials only (?scope=workspace),
//    a record's (one per record) and an environment's (one per record and environment) on that record's own page only
//    (?area=&key=, the record's environments read from the record), never on another record's; a group (an access key
//    id and its secret) is one credential, set and cleared together, refused half given; an environment is one of the
//    record's own; "last used" is when a run received it. The console's model (web/src/features/credentials/model.ts)
//    places each credential in exactly one of the three places. definePack refuses a group that does not hold together.
// 10. A row per record on Settings › Credentials (mold_v0-241): ?scope=workspace names the areas whose records have
//    credentials and the person may read; ?records=<area> answers every record of the workspace the person may read in
//    one request (title, environments, its values' slots, never the last 4 characters), refused for an area they may not
//    read (and so is that area's record page); the console counts each record's credentials one by one ("All set",
//    "N missing", "Optional only"), the four cards count every credential, and a row links to the record's page at its
//    Credentials card (#credentials).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { ENV } from "../src/env-names.js";

// Everything this process writes to its logs, for the canary grep (7).
const logged: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return write(chunk, ...rest); };
}
const seen: string[] = []; // every MCP and HTTP answer
const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canary = (label: string) => `canary-${label}-${randomBytes(12).toString("hex")}`;
const CANARY = {
  A_WS: canary("a-ws"), A_APP: `-----BEGIN FIXTURE KEY-----\n${canary("a-app")}\n-----END FIXTURE KEY-----\n`, A_DB: canary("a-db"),
  B_WS: canary("b-ws"), B_APP: `-----BEGIN FIXTURE KEY-----\n${canary("b-app")}\n-----END FIXTURE KEY-----\n`, B_DB: canary("b-db"),
};
const ALL = Object.values(CANARY);
/** Every way a value could appear: as is, JSON-escaped, base64 and hex, and the canary line inside a key file. */
const needles = ALL.flatMap((v) => [v, JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("hex"),
  ...v.split("\n").filter((l) => l.startsWith("canary-"))]);
const hits = (text: string | Buffer) => needles.filter((n) => text.includes(n)).length;

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const creds = await import("../src/credentials.js");
  const { credentialAppRouter } = await import("../src/credential-routes.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Vault A ${STAMP}`)).org, B = (await createOrg(`Vault B ${STAMP}`)).org;

  // ---------- 1. zero packs ----------
  assert.deepEqual(creds.credentialSpecs(), [], "no packs, no fields");
  assert.equal(credentialAppRouter().stack.length, 0, "nothing is mounted at /api/credentials");
  console.log("✓ zero packs: no credential fields, nothing mounted");

  // ---------- 2. definePack refuses what would get past the vault ----------
  {
    const area = { name: "pk_apps", label: "Apps", role: "asset", scope: "workspace", fields: [{ name: "url", label: "URL" }] };
    const pack = (credentials: unknown[], extra: Record<string, unknown> = {}) => definePack({ id: "pk", recordAreas: [area as never], credentials: credentials as never, ...extra });
    const c = (x: Record<string, unknown>) => ({ name: "tok", label: "Token", bound_to: "workspace", deliver_as: { env: "PK_TOKEN" }, ...x });
    assert.throws(() => pack([c({ bound_to: "asset", area: "elsewhere" })]), /not one of this pack's asset areas/);
    assert.throws(() => pack([c({ bound_to: "asset" })]), /area names the asset area/);
    assert.throws(() => pack([c({ area: "pk_apps" })]), /area names the asset area/);
    assert.throws(() => pack([c({ environments: ["prod"] })]), /environment binding only/);
    for (const env of ["PATH", "HOME", "RUN_ID", "HTTPS_PROXY", "NODE_OPTIONS", "LD_PRELOAD"]) assert.throws(() => pack([c({ deliver_as: { env } })]), /the shell sets for every run/, env);
    assert.throws(() => pack([c({}), c({ name: "tok2" })]), /both deliver to env PK_TOKEN/);
    assert.throws(() => pack([c({ deliver_as: { file: "../x" } })]), /a file name/);
    assert.throws(() => pack([c({ deliver_as: { file: "a/b" } })]), /a file name/);
    assert.throws(() => pack([c({})], { jobKinds: [{ name: "kk", runner: "workspace-harness", entry: "x.mjs", credentials: ["nope"] }] }), /names credential nope/);
    assert.doesNotThrow(() => pack([c({}), c({ name: "key", bound_to: "environment", area: "pk_apps", environments: ["staging"], deliver_as: { file: "key.pem" } })],
      { jobKinds: [{ name: "kk", runner: "workspace-harness", entry: "x.mjs", credentials: ["tok", "key"] }] }));
    console.log("✓ definePack refuses a foreign area, a kind naming an unknown field, the shell's variables, shared targets, paths in file names");
  }

  // ---------- the fixture pack ----------
  const kind = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", entry: "creds.mjs", lease_seconds: 15,
    credentials: ["api_token", "app_key", "db_password"], ...extra });
  const fixture = definePack({
    id: "fixture_vault",
    recordAreas: [
      { name: "cred_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
      { name: "cred_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
    ],
    credentials: [
      { name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "FIXTURE_API_TOKEN" } },
      { name: "app_key", label: "Application key", bound_to: "asset", area: "cred_apps", deliver_as: { file: "app_key.pem" } },
      { name: "db_password", label: "Database password", bound_to: "environment", area: "cred_apps", environments: ["staging", "production"], deliver_as: { env: "FIXTURE_DB_PASSWORD" } },
    ],
    jobKinds: [kind("report"), kind("report_none", { credentials: [] }), kind("report_token", { credentials: ["api_token"] }), kind("leak"),
      kind("leak_ws", { workspace: true }), kind("leak_wsname", { workspace: true }), kind("leak_bad"), kind("stash")] as never,
    tools: [
      defineTool({ name: "fixture_vault_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind: k, targets }, { runs: r }) => r.start(k, { targets }) }),
      defineTool({ name: "fixture_vault_results", description: "A run and its results (test).", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true },
        handler: async (_ws, { id }, { runs: r }) => ({ run: await r.get(id), results: await r.results(id) }) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_vault", name: "Fixture vault", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  await rec.putPlatform(null, "cred_checks", "k1", { title: "A check", data: { summary: "x" } });
  for (const [o, keys] of [[A, ["app-x", "app-a"]], [B, ["app-x", "app-b"]]] as const)
    for (const k of keys) await withTenant(o.orgId, () => rec.workspaceRecords("fixture_vault", o.orgId).put("cred_apps", k, { title: k, data: { url: `https://${k}.example` } }));

  const http = await startHttp();
  const ca = await connect(A), cb = await connect(B);
  const call = async (c: typeof ca, name: string, args: Record<string, unknown>) => { const r = await c.call(name, args); seen.push(JSON.stringify(r)); return r; };
  const req = async (method: string, p: string, h: Record<string, string>, body?: unknown) => {
    const r = await http.req(method, p, h, body);
    const text = await r.text();
    seen.push(text);
    return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  try {
    // ---------- 3. the console ----------
    const ownerA = await http.signIn(A, "owner"), ownerB = await http.signIn(B, "owner"), memberA = await http.signIn(A), viewerA = await http.signIn(A, "viewer");
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    const put = (tok: string, body: unknown) => req("PUT", "/api/credentials", bearer(tok), body);
    {
      const set = async (tok: string, body: Record<string, unknown>) => {
        const r = await put(tok, body);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.last4, String(body.value).slice(-4));
        assert.ok(!("value" in r.body) && !("sealed" in r.body), "the answer carries the last 4 characters only");
      };
      await set(ownerA, { pack: "fixture_vault", name: "api_token", value: CANARY.A_WS });
      await set(ownerA, { pack: "fixture_vault", name: "app_key", asset: "app-x", value: CANARY.A_APP });
      await set(ownerA, { pack: "fixture_vault", name: "db_password", asset: "app-x", environment: "staging", value: CANARY.A_DB });
      await set(ownerB, { pack: "fixture_vault", name: "api_token", value: CANARY.B_WS });
      await set(ownerB, { pack: "fixture_vault", name: "app_key", asset: "app-x", value: CANARY.B_APP });
      await set(ownerB, { pack: "fixture_vault", name: "db_password", asset: "app-x", environment: "staging", value: CANARY.B_DB });
      // Replacing keeps one row per slot.
      await set(ownerA, { pack: "fixture_vault", name: "api_token", value: CANARY.A_WS });
      assert.equal((await db.query("SELECT 1 FROM workspace_credentials WHERE org_id = $1", [A.orgId])).length, 3, "one row per slot");
      assert.equal((await put(memberA, { pack: "fixture_vault", name: "api_token", value: "member-tries-1234" })).status, 403, "a member cannot set a value");
      assert.equal((await put(viewerA, { pack: "fixture_vault", name: "api_token", value: "viewer-tries-1234" })).status, 403, "nor a viewer");
      const csrf = await req("PUT", "/api/credentials", { cookie: `__session=${ownerA}` }, { pack: "fixture_vault", name: "api_token", value: "cookie-tries-1234" });
      assert.equal(csrf.status, 403, "a cookie write without X-Pack-Request is refused");
      assert.equal((await put(ownerA, { pack: "fixture_vault", name: "app_key", asset: "app-b", value: "another-workspaces-asset" })).status, 404, "an asset of another workspace is refused");
      assert.equal((await put(ownerA, { pack: "fixture_vault", name: "db_password", asset: "app-x", environment: "qa", value: "not-an-environment" })).status, 400, "an environment the field does not list");
      assert.equal((await put(ownerA, { pack: "fixture_vault", name: "api_token", asset: "app-x", value: "workspace-field-with-asset" })).status, 400, "a workspace field takes no asset");
      assert.equal((await put(ownerA, { pack: "fixture_vault", name: "api_token", value: "short" })).status, 400, "a value under 8 characters");
      assert.equal((await put(ownerA, { pack: "fixture_vault", name: "nope", value: "whatever-value" })).status, 404, "a field no pack declares");
      const bad = await req("PUT", "/api/credentials", { ...bearer(ownerA), "content-type": "application/json" }, `{"pack": "fixture_vault", "value": "${CANARY.A_WS}"`);
      assert.equal(bad.status, 400, "a body that is not JSON");
      assert.equal(hits(JSON.stringify(bad.body)), 0, "is refused without quoting it");
      const list = await req("GET", "/api/credentials", bearer(viewerA));
      assert.equal(list.status, 200, "a viewer sees which are set");
      assert.deepEqual(list.body.values.map((v: { name: string; asset: string | null; environment: string | null; last4: string | null }) => [v.name, v.asset, v.environment, v.last4]),
        [["api_token", null, null, null], ["app_key", "app-x", null, null], ["db_password", "app-x", "staging", null]], "A's own values: which are set, not even the last 4");
      assert.equal(list.body.can_manage, false);
      const owned = await req("GET", "/api/credentials", bearer(ownerA));
      assert.deepEqual(owned.body.values.map((v: { last4: string }) => v.last4), [CANARY.A_WS.slice(-4), CANARY.A_APP.slice(-4), CANARY.A_DB.slice(-4)], "an owner sees the last 4 characters");
      assert.equal(hits(JSON.stringify(list.body)), 0, "no value in the list");
      assert.deepEqual(list.body.fields.map((f: { name: string }) => f.name), ["api_token", "app_key", "db_password"]);
      console.log("✓ console: owners set values per workspace, asset and environment; answers show the last 4 only; members, viewers, cookie writes without the header, other workspaces' assets refused");
    }

    // ---------- 4. sealed at rest ----------
    {
      const { openBytes } = await import("../src/orgcrypto.js");
      const [row] = await db.query<{ sealed: string; asset_area: string }>("SELECT sealed, asset_area FROM workspace_credentials WHERE org_id = $1 AND name = 'app_key'", [A.orgId]);
      const blob = Buffer.from(row!.sealed, "base64");
      assert.equal(hits(blob), 0, "no plain text at rest");
      const aad = (o: number, asset: string) => JSON.stringify(["workspace-credential/v1", o, "fixture_vault", "app_key", "asset", "cred_apps", asset, null]);
      assert.equal((await openBytes(A.orgId, blob, aad(A.orgId, "app-x"))).toString(), CANARY.A_APP, "A's key opens A's value in its slot");
      await assert.rejects(openBytes(B.orgId, blob, aad(A.orgId, "app-x")), "B's key does not");
      await assert.rejects(openBytes(A.orgId, blob, aad(A.orgId, "app-a")), "nor does another slot (a value moved to another asset)");
      await assert.rejects(openBytes(A.orgId, blob, aad(B.orgId, "app-x")), "nor another workspace's slot");
      // A sealed value copied into B's row for the same slot is not delivered (it does not open there).
      const [bRow] = await db.query<{ sealed: string }>("SELECT sealed FROM workspace_credentials WHERE org_id = $1 AND name = 'app_key'", [B.orgId]);
      await db.query("UPDATE workspace_credentials SET sealed = $2 WHERE org_id = $1 AND name = 'app_key'", [B.orgId, row!.sealed]);
      const moved = await creds.runCredentials({ org_id: B.orgId, pack: "fixture_vault", spec: { credentials: ["app_key"] }, targets: { asset: "app-x" } });
      assert.deepEqual([moved.credentials.length, moved.missing], [0, ["app_key"]], "a value moved into another workspace's row is not delivered");
      await db.query("UPDATE workspace_credentials SET sealed = $2 WHERE org_id = $1 AND name = 'app_key'", [B.orgId, bRow!.sealed]);
      console.log("✓ sealed with the workspace's data key, bound to its slot: another key, slot or workspace does not open it");
    }

    // ---------- 5. runs ----------
    const client = await harness.localRunnerClient("w-vault");
    const start = async (c: typeof ca, k: string, targets: Record<string, unknown> = {}) => {
      const r = await call(c, "fixture_vault_run", { kind: k, targets });
      assert.ok(!r.isError, r.content[0]?.text);
      return r.structuredContent as { id: string };
    };
    const report = async (runId: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'creds' ORDER BY id DESC LIMIT 1", [runId]))[0]?.data;
    const credEvent = async (runId: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'credentials' ORDER BY id DESC LIMIT 1", [runId]))[0]?.data;
    const runIt = async (id: string, kinds: string[], opts: Parameters<typeof harness.runWorkspaceHarness>[2] = {}, via = client) => {
      const c = await via.claim(kinds);
      assert.ok(c && c.run.id === id, `claimed ${id}`);
      assert.equal(hits(JSON.stringify(c)), 0, "the claim carries no value");
      return harness.runWorkspaceHarness(via, c!, { allowSameUser: true, egress: "off", ...opts });
    };
    const injected = { fromB: 0 };
    {
      const shaA = { api_token: sha(CANARY.A_WS), app_key: sha(CANARY.A_APP), db_password: sha(CANARY.A_DB) };
      const shaB = { api_token: sha(CANARY.B_WS), app_key: sha(CANARY.B_APP), db_password: sha(CANARY.B_DB) };
      const count = (r: any) => { for (const v of Object.values(r?.sha ?? {})) if (Object.values(shaB).includes(v as string)) injected.fromB++; };
      // A and B, same asset key, same environment, at the same time: each gets its own workspace's values.
      const ra = await start(ca, "report", { asset: "app-x", environment: "staging" });
      const rb = await start(cb, "report", { asset: "app-x", environment: "staging" });
      const [ca1, cb1] = [await client.claim(["fixture_vault/report"]), await client.claim(["fixture_vault/report"])];
      const byId = new Map([[ca1!.run.id, ca1!], [cb1!.run.id, cb1!]]);
      const [va, vb] = await Promise.all([ra.id, rb.id].map((id) => harness.runWorkspaceHarness(client, byId.get(id)!, { allowSameUser: true, egress: "off" })));
      assert.deepEqual([va?.status, vb?.status], ["succeeded", "succeeded"]);
      const repA = await report(ra.id), repB = await report(rb.id);
      count(repA);
      assert.deepEqual(repA.sha, shaA, "A's run got exactly A's three values");
      assert.deepEqual(repB.sha, shaB, "B's run got exactly B's");
      assert.deepEqual(await credEvent(ra.id), { delivered: ["api_token", "app_key", "db_password"], missing: [] }, "the run's events name what was delivered");
      assert.equal(repA.file.mode, "400", "the file is read-only to its owner");
      assert.equal(repA.file.dir_mode, "700", "in a private directory");
      if (existsSync("/dev/shm")) assert.ok(repA.dir.startsWith("/dev/shm/"), `on tmpfs (${repA.dir})`);
      assert.ok(!existsSync(repA.dir) && !existsSync(repB.dir), "the directory is gone when the program ends");
      // Targets decide: another environment, an asset of the other workspace, no asset at all.
      const prod = await start(ca, "report", { asset: "app-x", environment: "production" });
      await runIt(prod.id, ["fixture_vault/report"]);
      const rp = await report(prod.id);
      count(rp);
      assert.deepEqual(rp.sha, { ...shaA, db_password: null }, "no value for an environment that has none");
      const foreign = await start(ca, "report", { asset: "app-b", environment: "staging" });
      await runIt(foreign.id, ["fixture_vault/report"]);
      const rf = await report(foreign.id);
      count(rf);
      assert.deepEqual(rf.sha, { api_token: shaA.api_token, app_key: null, db_password: null }, "targeting B's asset key from A gets none of B's values");
      assert.deepEqual((await credEvent(foreign.id)).missing, ["app_key", "db_password"]);
      const otherArea = await start(ca, "report", { asset: { area: "elsewhere", key: "app-x" }, environment: "staging" });
      await runIt(otherArea.id, ["fixture_vault/report"]);
      assert.deepEqual((await report(otherArea.id)).sha, { api_token: shaA.api_token, app_key: null, db_password: null }, "a target in another area gets no asset-bound value");
      const none = await start(ca, "report", {});
      await runIt(none.id, ["fixture_vault/report"]);
      count(await report(none.id));
      assert.deepEqual((await report(none.id)).sha, { api_token: shaA.api_token, app_key: null, db_password: null }, "no target, no asset-bound value");
      // A kind gets only the fields it names.
      const nothing = await start(ca, "report_none", { asset: "app-x", environment: "staging" });
      await runIt(nothing.id, ["fixture_vault/report_none"]);
      const rn = await report(nothing.id);
      assert.deepEqual([rn.sha, rn.dir], [{ api_token: null, app_key: null, db_password: null }, null], "a kind that names no field gets none");
      assert.equal(await credEvent(nothing.id), undefined, "and asks for none");
      const tokOnly = await start(ca, "report_token", { asset: "app-x", environment: "staging" });
      await runIt(tokOnly.id, ["fixture_vault/report_token"]);
      assert.deepEqual((await report(tokOnly.id)).sha, { api_token: shaA.api_token, app_key: null, db_password: null }, "a kind gets the fields it names, no others");
      // Over HTTP, with the fleet token and the lease.
      const viaHttp = harness.httpRunnerClient(http.base, ENV.APP_WORKER_TOKEN!, "w-http");
      const rh = await start(cb, "report", { asset: "app-x", environment: "staging" });
      await runIt(rh.id, ["fixture_vault/report"], {}, viaHttp);
      assert.deepEqual((await report(rh.id)).sha, shaB, "over the worker API: B's own values");
      const lease = (await client.claim(["fixture_vault/report"]));
      assert.equal(lease, null);
      const cr = await req("GET", `/api/worker/runs/${rh.id}/credentials`, { authorization: `Bearer ${ENV.APP_WORKER_TOKEN}`, "x-run-lease": "orl_forged" });
      assert.equal(cr.status, 409, "a forged (or spent) lease gets nothing");
      // As a user of its own (a runner started as root).
      if (process.getuid?.() === 0) {
        const iso = await start(ca, "report", { asset: "app-x", environment: "staging" });
        // The harness's default as root: a user of the run's own (mold_v0-078).
        const v = await runIt(iso.id, ["fixture_vault/report"], { allowSameUser: false });
        assert.equal(v?.status, "succeeded", JSON.stringify(v));
        const ri = await report(iso.id);
        const ru = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'run_user'", [iso.id]))[0]!.data.uid;
        assert.deepEqual([ri.uid, ri.file.uid, ri.sha], [ru, ru, shaA], "as the run's user: its file, its values");
        // A run's uid is handed to a later run (mold_v0-078: after the others): nothing one leaves in the shared temporary
        // directories survives it.
        const st = await start(ca, "stash", { asset: "app-x", environment: "staging", mode: "stash" });
        assert.equal((await runIt(st.id, ["fixture_vault/stash"], { allowSameUser: false }))?.status, "succeeded");
        const left: string[] = (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'stashed'", [st.id]))[0]!.data.left;
        assert.ok(left.length >= 2, `it did leave copies (${left.join(", ")})`);
        assert.deepEqual(left.filter((f) => existsSync(f)), [], "and none is there after the run");
        console.log("✓ as a user of its own, the program reads its credential file (0400, owned by that user)");
      } else console.log("- runs as a separate user: skipped (needs a runner started as root)");
      assert.equal(injected.fromB, 0);
      console.log(`✓ runs: each kind gets the fields it names for its target, in its own workspace (env, or a 0400 file on tmpfs gone after); cross-workspace injections: ${injected.fromB}`);
    }

    // ---------- 6. leaks ----------
    {
      const leak = await start(ca, "leak", { asset: "app-x", environment: "staging", mode: "leak" });
      const v = await runIt(leak.id, ["fixture_vault/leak"]);
      assert.equal(v?.status, "succeeded", JSON.stringify(v));
      const ev = await db.query<{ type: string; data: unknown }>("SELECT type, data FROM run_events WHERE run_id = $1", [leak.id]);
      assert.ok(ev.some((e) => JSON.stringify(e.data).includes("[credential api_token]")), `what it printed is there, redacted: ${JSON.stringify(ev).slice(0, 3000)}`);
      assert.ok(ev.some((e) => e.type === "stderr" && JSON.stringify(e.data).includes("[credential db_password]")), "stderr too");
      const res = await call(ca, "fixture_vault_results", { id: leak.id });
      assert.equal(res.structuredContent.results[0].detail.token, "[credential api_token]", "results are redacted");
      assert.ok(ev.some((e) => /authorization: Basic \S{0,8}\[credential/.test(JSON.stringify(e.data))), "a Basic header (base64 of user:value) is redacted");
      const wsn = await start(ca, "leak_wsname", { mode: "leak_wsname" });
      const vn = await runIt(wsn.id, ["fixture_vault/leak_wsname"]);
      assert.deepEqual([vn?.status, vn?.error], ["failed", "the workspace holds the value of credential api_token: it is not written back"], "a file named after a value is caught too");
      const ws = await start(ca, "leak_ws", { asset: "app-x", environment: "staging", mode: "leak_ws" });
      const vw = await runIt(ws.id, ["fixture_vault/leak_ws"]);
      assert.deepEqual([vw?.status, vw?.error], ["failed", "the workspace holds the value of credential api_token: it is not written back"]);
      assert.equal((await db.query("SELECT 1 FROM workspace_snapshots WHERE org_id = $1 AND status = 'committed'", [A.orgId])).length, 0, "nothing written back");
      const bad = await start(ca, "leak_bad", { mode: "leak_bad" });
      const vb = await runIt(bad.id, ["fixture_vault/leak_bad"]);
      assert.deepEqual([vb?.status, vb?.error], ["failed", "results.json: not valid JSON"], "the error quotes nothing");
      // The engine redacts on its own: a runner that sends a value as is.
      const raw = await start(cb, "report", { asset: "app-x", environment: "staging" });
      const c = (await client.claim(["fixture_vault/report"]))!;
      assert.equal(c.run.id, raw.id);
      const got = await client.credentials(c.run.id, c.lease_token);
      assert.equal(got.credentials.length, 3);
      await runs.appendRunEvents(c.run.id, c.lease_token, [{ type: "log", data: { line: `raw ${CANARY.B_WS}`, [CANARY.B_DB]: Buffer.from(CANARY.B_DB).toString("base64") } }]);
      await runs.appendRunEvents(c.run.id, c.lease_token, [{ type: CANARY.B_WS, data: {} }]);
      assert.equal((await db.query("SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'redacted'", [raw.id])).length, 1, "an event whose type is a value is stored as 'redacted'");
      await runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [{ check: { area: "cred_checks", key: "k1" }, status: "pass", detail: { x: CANARY.B_APP } }] });
      const stored = JSON.stringify(await db.query("SELECT data FROM run_events WHERE run_id = $1", [raw.id])) + JSON.stringify(await db.query("SELECT detail FROM run_results WHERE run_id = $1", [raw.id]));
      assert.equal(hits(stored), 0, "the engine redacted what the runner sent");
      assert.ok(stored.includes("[credential api_token]") && stored.includes("[credential app_key]"));
      console.log("✓ leaks: printed, encoded, in results, in stderr, in a workspace file or its name, in a broken results file: stored redacted, not written back, quoted nowhere; the engine redacts on its own");
      // The redaction's forms, one by one (the review's cases).
      const { redactText, redactJson } = await import("../src/credential-redact.js");
      const sv = [{ name: "short", value: "abcdefgh" }, { name: "long", value: "abcdefgh-LONGTAIL" }, { name: "pin", value: "1234567890" }, { name: "tok", value: "s3cr+t/Val=ue!" }];
      for (const k of [0, 1, 2, 3, 4]) {
        const enc = Buffer.from(`${"x".repeat(k)}${sv[3]!.value}tail`).toString("base64");
        assert.match(redactText(enc, sv), /\[credential tok\]/, `base64 at byte offset ${k}`);
      }
      assert.equal(redactText(`?key=${encodeURIComponent(sv[3]!.value)}`, sv), "?key=[credential tok]", "URL-encoded");
      assert.equal(redactText("x abcdefgh-LONGTAIL y", sv), "x [credential long] y", "a value inside a longer one: the longer goes first");
      assert.deepEqual(redactJson({ n: 1234567890 }, sv), { n: "[credential pin]" }, "a number that spells a value");
      console.log("✓ redaction forms: base64 at any offset, URL encoding, nested values, numbers");
    }

    // ---------- 8. row-level security ----------
    {
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), []);
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, [], "the live probe passes with the vault table");
      const fromTenant = await withTenant(A.orgId, () => db.query("/* tenant: test */ SELECT 1 FROM workspace_credentials").then(() => "read", (e) => e.code));
      assert.equal(fromTenant, "42501", "tenant work (a pack's code) cannot read even its own workspace's sealed values");
      console.log(`✓ row-level security: catalog and probe pass (${probe.checked} checks); tenant work cannot reach the vault`);
    }

    // ---------- 9. each credential in its own place (mold_v0-239) ----------
    {
      const area = { name: "pl_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }, { name: "environments", label: "Environments", type: "json" }] };
      const STEPS = ["Open https://console.example.com/keys and sign in.", "Press Create key and copy both parts."];
      const credentials = [
        { name: "ws_token", label: "Workspace token", bound_to: "workspace", deliver_as: { env: "PL_WS_TOKEN" }, purpose: "Reads your account's list of projects.", steps: STEPS },
        { name: "app_token", label: "Application token", bound_to: "asset", area: "pl_apps", deliver_as: { env: "PL_APP_TOKEN" }, purpose: "Reads this application's code." },
        { name: "cloud_key_id", label: "Access key ID", bound_to: "environment", area: "pl_apps", environments_from: { field: "environments", key: "envId" },
          deliver_as: { env: "PL_KEY_ID" }, group: "cloud_key", group_label: "Cloud read-only key", purpose: "Lists this environment's cloud resources, read only.", steps: STEPS },
        { name: "cloud_secret", label: "Secret access key", bound_to: "environment", area: "pl_apps", environments_from: { field: "environments", key: "envId" },
          deliver_as: { env: "PL_KEY_SECRET" }, group: "cloud_key" },
      ];
      const make = (cs: unknown[], areas: unknown[] = [area]) => definePack({ id: "fixture_places", recordAreas: areas as never, credentials: cs as never });
      // definePack: a group holds together.
      const lead = credentials[2]!, tail = credentials[3]!;
      assert.throws(() => make([{ ...lead, group_label: undefined }, tail]), /names the credential \(group_label\)/);
      assert.throws(() => make([lead, { ...tail, purpose: "x" }]), /go on the group's first field/);
      assert.throws(() => make([lead, { ...tail, bound_to: "asset", environments_from: undefined }]), /same bound_to/);
      assert.throws(() => make([lead]), /2 to 4 fields belong together/);
      assert.throws(() => make([{ ...lead, environments_from: { field: "nope" } }, { ...tail, environments_from: { field: "nope" } }]), /does not have/);
      assert.throws(() => make([{ ...credentials[0]!, steps: ["Sign in first."] }]), /first step names the web address/);
      assert.throws(() => make([{ ...credentials[0]!, without: "Everything else" }]), /optional field only/);
      assert.throws(() => make([{ ...credentials[0]!, environments_from: { field: "environments" } }]), /environment binding only/);
      const places = make(credentials);
      setPacksForTest([{ manifest: { id: "fixture_places", name: "Fixture places", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: places }]);
      await withTenant(A.orgId, () => rec.workspaceRecords("fixture_places", A.orgId).put("pl_apps", "app-1", { title: "App one", data: { url: "https://one.example", environments: [{ envId: "prod" }, { envId: "staging" }] } }));
      await withTenant(A.orgId, () => rec.workspaceRecords("fixture_places", A.orgId).put("pl_apps", "app-2", { title: "App two", data: { url: "https://two.example", environments: [{ envId: "prod" }] } }));
      const ownerA = await http.signIn(A, "owner");
      const as = { authorization: `Bearer ${ownerA}` };
      const P = { pack: "fixture_places" };
      const ok = async (method: string, body: unknown) => { const r = await req(method, "/api/credentials", as, body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
      await ok("PUT", { ...P, name: "ws_token", value: "workspace-token-0001" });
      await ok("PUT", { ...P, name: "app_token", asset: "app-1", value: "app-one-token-0002" });
      // A pair: both parts at once, never half.
      assert.equal((await req("PUT", "/api/credentials", as, { ...P, group: "cloud_key", asset: "app-1", environment: "prod", values: { cloud_key_id: "AKIDEXAMPLE0003" } })).status, 400, "half a pair is refused");
      assert.equal((await req("PUT", "/api/credentials", as, { ...P, group: "cloud_key", asset: "app-1", environment: "qa", values: { cloud_key_id: "AKIDEXAMPLE0003", cloud_secret: "secret-example-0004" } })).status, 400, "an environment the record does not have");
      assert.equal((await req("PUT", "/api/credentials", as, { ...P, name: "cloud_key_id", asset: "app-2", environment: "staging", value: "AKIDEXAMPLE0005" })).status, 400, "nor one of another record's");
      const pair = await ok("PUT", { ...P, group: "cloud_key", asset: "app-1", environment: "prod", values: { cloud_key_id: "AKIDEXAMPLE0003", cloud_secret: "secret-example-0004" } });
      assert.deepEqual(pair.values.map((v: { name: string; last4: string }) => [v.name, v.last4]), [["cloud_key_id", "0003"], ["cloud_secret", "0004"]], "a pair is set in one request");
      await ok("PUT", { ...P, group: "cloud_key", asset: "app-2", environment: "prod", values: { cloud_key_id: "AKIDEXAMPLE0006", cloud_secret: "secret-example-0007" } });
      // Settings: the workspace's own only.
      const ws = (await req("GET", "/api/credentials?scope=workspace", as)).body;
      assert.deepEqual(ws.fields.map((f: { name: string }) => f.name), ["ws_token"], "Settings › Credentials lists only the workspace's credential");
      assert.deepEqual(ws.values.map((v: { name: string }) => v.name), ["ws_token"], "and only its value");
      // A record's page: its own, and its environments from the record.
      const one = (await req("GET", "/api/credentials?area=pl_apps&key=app-1", as)).body;
      assert.deepEqual(one.fields.map((f: { name: string }) => f.name), ["app_token", "cloud_key_id", "cloud_secret"], "the record's page: the credentials of its records and their environments, not the workspace's");
      assert.deepEqual(one.values.map((v: { name: string; asset: string; environment: string | null }) => [v.name, v.asset, v.environment]),
        [["app_token", "app-1", null], ["cloud_key_id", "app-1", "prod"], ["cloud_secret", "app-1", "prod"]], "only this record's values");
      assert.deepEqual(one.environments, ["prod", "staging"], "its environments, read from the record");
      const two = (await req("GET", "/api/credentials?area=pl_apps&key=app-2", as)).body;
      assert.deepEqual(two.values.map((v: { name: string; asset: string }) => [v.name, v.asset]), [["cloud_key_id", "app-2"], ["cloud_secret", "app-2"]], "another record's page: its own values only");
      assert.deepEqual(two.environments, ["prod"]);
      assert.equal((await req("GET", "/api/credentials?area=pl_apps&key=app-9", as)).status, 404, "a record this workspace does not have");
      const bOwner = await http.signIn(B, "owner");
      assert.equal((await req("GET", "/api/credentials?area=pl_apps&key=app-1", { authorization: `Bearer ${bOwner}` })).status, 404, "nor another workspace's record");
      // The console's model: each credential in exactly one place, a pair one credential.
      const model = await import("../web/src/features/credentials/model.js");
      const cs = model.credentialsOf(one.fields.concat(ws.fields));
      assert.deepEqual(cs.map((c) => [c.label, c.parts.length, c.place]), [["Application token", 1, "record"], ["Cloud read-only key", 2, "record-environment"], ["Workspace token", 1, "settings"]], "a pair is one credential with two inputs");
      assert.deepEqual(model.forSettings(cs).map((c) => c.label), ["Workspace token"], "Settings: the workspace's only");
      const onPage = model.forRecord(cs, "pl_apps");
      assert.deepEqual([onPage.record.map((c) => c.label), onPage.environment.map((c) => c.label)], [["Application token"], ["Cloud read-only key"]]);
      for (const c of cs) assert.equal([model.forSettings(cs).includes(c), onPage.record.includes(c), onPage.environment.includes(c)].filter(Boolean).length, 1, `${c.label}: in exactly one place`);
      const sec = model.recordSections(cs, "pl_apps", one.environments, one.values, "app-1", one.field_environments);
      assert.deepEqual(sec.record.map((x) => [x.c.label, x.state.status]), [["Application token", "Set"]]);
      assert.deepEqual(sec.environments.map((g) => [g.label, g.items.map((x) => [x.c.label, x.state.status])]),
        [["Production", [["Cloud read-only key", "Set"]]], ["Staging", [["Cloud read-only key", "Missing"]]]], "one group per environment of the record, each with its own status");
      assert.deepEqual(model.stepPieces(STEPS[0]!).filter((x) => x.href).map((x) => x.href), ["https://console.example.com/keys"], "a step's web address is a link");
      // Last used: when a run received it.
      assert.equal(one.values.every((v: { last_used_at: string | null }) => v.last_used_at === null), true, "not used yet");
      const got = await creds.runCredentials({ org_id: A.orgId, pack: "fixture_places", spec: { credentials: ["cloud_key_id", "cloud_secret"] }, targets: { asset: "app-1", environment: "prod" } });
      assert.deepEqual(got.credentials.map((c) => c.name), ["cloud_key_id", "cloud_secret"]);
      await creds.runCredentials({ org_id: A.orgId, pack: "fixture_places", spec: { credentials: ["app_token"] }, targets: { asset: "app-1" } }, { strict: true, mint: false });
      const used = (await req("GET", "/api/credentials?area=pl_apps&key=app-1", as)).body.values as { name: string; last_used_at: string | null }[];
      assert.deepEqual(used.map((v) => [v.name, !!v.last_used_at]), [["app_token", false], ["cloud_key_id", true], ["cloud_secret", true]], "last used: delivered to a run (reading it to redact does not count)");
      // Cleared together.
      await ok("DELETE", { ...P, group: "cloud_key", asset: "app-1", environment: "prod" });
      assert.deepEqual((await req("GET", "/api/credentials?area=pl_apps&key=app-1", as)).body.values.map((v: { name: string }) => v.name), ["app_token"], "a pair is cleared together");
      console.log("✓ each in its own place: the workspace's on Settings only, a record's and its environments' on that record's page only (environments read from the record, picked, never another's); a pair set, refused half given and cleared as one; last used when a run received it");
    }

    // ---------- 10. a row per record on Settings › Credentials (mold_v0-241) ----------
    {
      const envs = { name: "environments", label: "Environments", type: "json" };
      const rows = definePack({
        id: "fixture_rows",
        recordAreas: [
          { name: "rw_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }, envs] },
          // Read by owners only: a member sees neither its rows on Settings nor its records' Credentials cards.
          { name: "rw_vaults", label: "Vaults", role: "asset", scope: "workspace", permissions: { read: ["owner"] }, fields: [{ name: "url", label: "Address" }] },
        ] as never,
        credentials: [
          { name: "ws_token", label: "Workspace token", bound_to: "workspace", deliver_as: { env: "RW_WS_TOKEN" } },
          { name: "app_token", label: "Application token", bound_to: "asset", area: "rw_apps", deliver_as: { env: "RW_APP_TOKEN" } },
          { name: "app_extra", label: "Extra token", bound_to: "asset", area: "rw_apps", optional: true, deliver_as: { env: "RW_APP_EXTRA" } },
          { name: "cloud_id", label: "Access key ID", bound_to: "environment", area: "rw_apps", environments_from: { field: "environments", key: "envId" },
            deliver_as: { env: "RW_KEY_ID" }, group: "cloud", group_label: "Cloud key" },
          { name: "cloud_secret", label: "Secret access key", bound_to: "environment", area: "rw_apps", environments_from: { field: "environments", key: "envId" },
            deliver_as: { env: "RW_KEY_SECRET" }, group: "cloud" },
          { name: "vault_key", label: "Vault key", bound_to: "asset", area: "rw_vaults", deliver_as: { env: "RW_VAULT_KEY" } },
        ] as never,
      });
      setPacksForTest([{ manifest: { id: "fixture_rows", name: "Fixture rows", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: rows }]);
      const put = (o: typeof A, area: string, key: string, title: string, data: Record<string, unknown>) =>
        withTenant(o.orgId, () => rec.workspaceRecords("fixture_rows", o.orgId).put(area, key, { title, data: { url: `https://${key}.example`, ...data } }));
      await put(A, "rw_apps", "app-1", "Alpha app", { environments: [{ envId: "prod" }, { envId: "staging" }] });
      await put(A, "rw_apps", "app-2", "Beta app", { environments: [{ envId: "prod" }] });
      await put(A, "rw_apps", "app-3", "Gamma app", { environments: [] });
      await put(A, "rw_vaults", "vault-1", "Main vault", {});
      await put(B, "rw_apps", "app-1", "Other workspace app", { environments: [{ envId: "prod" }] });
      const owner = { authorization: `Bearer ${await http.signIn(A, "owner")}` }, member = { authorization: `Bearer ${await http.signIn(A)}` };
      const ownerB = { authorization: `Bearer ${await http.signIn(B, "owner")}` };
      const R = { pack: "fixture_rows" };
      const ok = async (h: Record<string, string>, body: unknown) => { const r = await req("PUT", "/api/credentials", h, body); assert.equal(r.status, 200, JSON.stringify(r.body)); };
      await ok(owner, { ...R, name: "ws_token", value: "rows-workspace-0001" });
      // Alpha: its token, Production's key; Staging's key and the optional one not set. Beta: all but the optional one.
      // Gamma: no environments, both of its own. The other workspace's app-1: everything.
      await ok(owner, { ...R, name: "app_token", asset: "app-1", value: "rows-alpha-token-0002" });
      await ok(owner, { ...R, group: "cloud", asset: "app-1", environment: "prod", values: { cloud_id: "AKIDROWS0003", cloud_secret: "rows-secret-0004" } });
      await ok(owner, { ...R, name: "app_token", asset: "app-2", value: "rows-beta-token-0005" });
      await ok(owner, { ...R, group: "cloud", asset: "app-2", environment: "prod", values: { cloud_id: "AKIDROWS0006", cloud_secret: "rows-secret-0007" } });
      await ok(owner, { ...R, name: "app_token", asset: "app-3", value: "rows-gamma-token-0008" });
      await ok(owner, { ...R, name: "app_extra", asset: "app-3", value: "rows-gamma-extra-0009" });
      await ok(ownerB, { ...R, name: "app_token", asset: "app-1", value: "rows-other-token-0010" });
      await ok(ownerB, { ...R, group: "cloud", asset: "app-1", environment: "prod", values: { cloud_id: "AKIDROWS0011", cloud_secret: "rows-secret-0012" } });
      await creds.runCredentials({ org_id: A.orgId, pack: "fixture_rows", spec: { credentials: ["app_token"] }, targets: { asset: "app-2" } });

      // The areas Settings asks about: those whose records have credentials, and the person may read.
      assert.deepEqual((await req("GET", "/api/credentials?scope=workspace", owner)).body.record_areas, ["rw_apps", "rw_vaults"], "an owner: both areas");
      assert.deepEqual((await req("GET", "/api/credentials?scope=workspace", member)).body.record_areas, ["rw_apps"], "a member: only the area they may read");
      // One request per area: every record of this workspace, its environments and its values' slots.
      const apps = await req("GET", "/api/credentials?records=rw_apps", owner);
      assert.equal(apps.status, 200, JSON.stringify(apps.body));
      const body = apps.body as { fields: { name: string }[]; values: { asset: string; name: string; environment: string | null; last4: string | null; last_used_at: string | null }[];
        records: { key: string; title: string; environments: string[]; field_environments: Record<string, string[] | null> }[]; more: boolean; can_manage: boolean };
      assert.deepEqual(body.records.map((r) => [r.key, r.title, r.environments]), [["app-1", "Alpha app", ["prod", "staging"]], ["app-2", "Beta app", ["prod"]], ["app-3", "Gamma app", []]], "every record, its title and environments");
      assert.deepEqual(body.fields.map((f) => f.name), ["app_token", "app_extra", "cloud_id", "cloud_secret"], "the area's credentials, not the workspace's");
      assert.equal(body.values.length, 8, "this workspace's values only (none of the other workspace's)");
      assert.ok(body.values.every((v) => v.last4 === null), "never the last 4 characters, not even for an owner");
      assert.equal(body.more, false);
      const other = (await req("GET", "/api/credentials?records=rw_apps", ownerB)).body as typeof body;
      assert.deepEqual(other.records.map((r) => r.title), ["Other workspace app"], "another workspace: its own records only");
      assert.equal(other.values.length, 3);
      // The area's read permission: refused for a member (here and on the record's page), answered for an owner.
      assert.equal((await req("GET", "/api/credentials?records=rw_vaults", member)).status, 403, "a member may not read Vaults: no rows");
      assert.equal((await req("GET", "/api/credentials?area=rw_vaults&key=vault-1", member)).status, 403, "nor its record's Credentials card");
      assert.deepEqual((await req("GET", "/api/credentials?records=rw_vaults", owner)).body.records.map((r: { title: string }) => r.title), ["Main vault"]);
      assert.equal((await req("GET", "/api/credentials?records=rw_apps", member)).status, 200, "a member reads Applications");
      assert.equal((await req("GET", "/api/credentials?records=nope", owner)).status, 404, "an area with no record credentials");
      // The console's counts: each record's credentials one by one, each environment's apart.
      const model = await import("../web/src/features/credentials/model.js");
      const cs = model.credentialsOf(body.fields as never);
      const sum = body.records.map((r) => model.recordSummary(cs, "rw_apps", r, body.values as never));
      assert.deepEqual(sum.map((x) => [x.words, x.slots.length]), [["1 missing", 4], ["Optional only", 3], ["All set", 2]],
        "Alpha: Staging's key missing; Beta: only the optional one; Gamma: all set (no environments)");
      assert.deepEqual(sum.map((x) => !!x.changed_at && !!x.changed_by), [true, true, true], "when one last changed, and who");
      assert.deepEqual(sum.map((x) => !!x.used_at), [false, true, false], "last used: when a run received one");
      assert.equal(model.recordPurpose(cs, "rw_apps", "application"), "Credentials for this application and its environments");
      const noEnv = model.credentialsOf((await req("GET", "/api/credentials?records=rw_vaults", owner)).body.fields);
      assert.equal(model.recordPurpose(noEnv, "rw_vaults", "vault"), "Credentials for this vault");
      assert.equal(model.recordSummary(cs, "rw_apps", { key: "app-9", title: "Empty", environments: [], field_environments: {} }, [] as never).words, "1 missing", "a record with nothing set: its required one missing");
      const envOnly = model.credentialsOf(body.fields.filter((f) => f.name.startsWith("cloud")) as never);
      assert.equal(model.recordSummary(envOnly, "rw_apps", { key: "app-9", title: "Empty", environments: [], field_environments: {} }, []).words, "No environments yet");
      // The four cards: the workspace's token, then every record's credential counted one by one.
      const units = [{ status: "Set" as const, required: true, changed_at: new Date().toISOString() }, ...sum.flatMap((x) => x.slots.map((u) => ({ status: u.state.status, required: u.required, changed_at: u.state.set_at })))];
      assert.deepEqual(model.settingsCounts(units), { set: 7, missing: 3, required_missing: 1, recent: 7 }, "the cards count credentials, not rows");
      // A row opens the record's own page at its Credentials card.
      assert.equal(model.recordCredentialsHref("rw_apps", "app-1"), "/app/records/rw_apps/app-1#credentials");
      assert.equal(model.recordCredentialsHref("rw_apps", "a b/c"), "/app/records/rw_apps/a%20b%2Fc#credentials");
      console.log("✓ a row per record on Settings › Credentials: one request per area, only the areas and records the person may read, no last 4 characters; each record's credentials counted one by one (All set, N missing, Optional only), the cards count every credential, a row opens the record's Credentials card");
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }

  // ---------- 7. the canary grep ----------
  {
    const tables = (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((r) => r.t);
    let dbHits = 0;
    for (const t of tables) {
      const [r] = await db.query<{ x: string | null }>(`/* tenant: test, every row of every table */ SELECT string_agg(z::text, E'\\n') AS x FROM "${t}" z`);
      const n = hits(r?.x ?? "");
      if (n) console.error(`  canary in table ${t}: ${n}`);
      dbHits += n;
    }
    const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
    // In the deleted workspace's rows too: B goes, and its values with it.
    await db.query("DELETE FROM organizations WHERE id = $1", [B.orgId]);
    assert.equal((await db.query("SELECT 1 FROM workspace_credentials WHERE org_id = $1", [B.orgId])).length, 0, "deleting a workspace deletes its values");
    await db.query("CHECKPOINT").catch(() => {});
    const dbFiles = files(process.env.PGLITE_DIR!).reduce((n, f) => n + (statSync(f).size < 512 * 1024 * 1024 ? hits(readFileSync(f)) : 0), 0);
    const objects = files(ENV.APP_STORAGE_DIR!).reduce((n, f) => n + hits(readFileSync(f)), 0);
    const shm = existsSync("/dev/shm") ? readdirSync("/dev/shm").filter((f) => f.startsWith("run-cred-")).length : 0;
    const answers = hits(seen.join("\n"));
    const logs = hits(logged.join(""));
    console.log(`✓ canary grep: database tables ${dbHits}, database files ${dbFiles}, object store ${objects}, MCP and HTTP answers ${answers}, logs ${logs}; credential directories left on tmpfs ${shm}`);
    assert.deepEqual({ dbHits, dbFiles, objects, answers, logs, shm }, { dbHits: 0, dbFiles: 0, objects: 0, answers: 0, logs: 0, shm: 0 }, "no value anywhere");
  }
  await db.close();
  console.log("CREDENTIALS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
