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
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

// Everything this process writes to its logs, for the canary grep (7).
const logged: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return write(chunk, ...rest); };
}
const seen: string[] = []; // every MCP and HTTP answer
const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
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
      const viaHttp = harness.httpRunnerClient(http.base, process.env.OCTILLION_WORKER_TOKEN!, "w-http");
      const rh = await start(cb, "report", { asset: "app-x", environment: "staging" });
      await runIt(rh.id, ["fixture_vault/report"], {}, viaHttp);
      assert.deepEqual((await report(rh.id)).sha, shaB, "over the worker API: B's own values");
      const lease = (await client.claim(["fixture_vault/report"]));
      assert.equal(lease, null);
      const cr = await req("GET", `/api/worker/runs/${rh.id}/credentials`, { authorization: `Bearer ${process.env.OCTILLION_WORKER_TOKEN}`, "x-run-lease": "orl_forged" });
      assert.equal(cr.status, 409, "a forged (or spent) lease gets nothing");
      // As a user of its own (a runner started as root).
      if (process.getuid?.() === 0) {
        const iso = await start(ca, "report", { asset: "app-x", environment: "staging" });
        const v = await runIt(iso.id, ["fixture_vault/report"], { allowSameUser: false, runAs: { uid: 65534, gid: 65534 } });
        assert.equal(v?.status, "succeeded", JSON.stringify(v));
        const ri = await report(iso.id);
        assert.deepEqual([ri.uid, ri.file.uid, ri.sha], [65534, 65534, shaA], "as the run's user: its file, its values");
        // Runs share their user: nothing one leaves in the shared temporary directories survives it.
        const st = await start(ca, "stash", { asset: "app-x", environment: "staging", mode: "stash" });
        assert.equal((await runIt(st.id, ["fixture_vault/stash"], { allowSameUser: false, runAs: { uid: 65534, gid: 65534 } }))?.status, "succeeded");
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
    const objects = files(process.env.OCTILLION_STORAGE_DIR!).reduce((n, f) => n + hits(readFileSync(f)), 0);
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
