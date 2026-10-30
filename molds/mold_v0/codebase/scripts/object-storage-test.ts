// Object storage in the key vault (mold_v0-181; src/storage.ts, src/keyvault.ts OBJECT_STORAGE_PROVIDER,
// src/platform-keys.ts), offline: an embedded database and an S3 stand-in (scripts/lib/s3-standin.ts) that checks every
// request's signature as R2 does.
//   npm run test:object-storage
//
// Proves:
//   1. none configured: the store refuses, naming every way (R2_* in the environment, Key vault › Object storage,
//      APP_STORAGE_DIR); the entry's four fields are checked (bucket name, an https endpoint, both keys), errors name the
//      field and never quote a key; Cloudflare's S3 API address with the bucket at its end is taken
//   2. the vault's entry is used when the environment has no R2_*; all four R2_* win over it (unchanged behaviour), and
//      a partial R2_* does not; the bucket-per-prefix layout is the same
//   3. the cache: the entry is read once within its minute; a change made here (save, turn off, delete, provider off)
//      takes effect at once; one made elsewhere when the minute is up
//   4. the row's Test: write, read and delete one object under ops/key-vault-test/ (nothing left behind); a wrong secret,
//      an unknown access key, a missing bucket and an unreachable address each in words
//   5. the secret never appears in any answer of the console's API, the admin MCP's key_vault_status, the operator's
//      vault-status, the audit log or anything the process printed; a viewer cannot save or test
//   6. a run's workspace write-back succeeds with only the vault entry (in-process and over HTTP, the path that failed
//      on a hosted deployment with "no object store"), and the provider is in the build only where something uses the
//      store; operator:vault-status says "needs Object storage" set or MISSING
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { startS3Standin } from "./lib/s3-standin.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const R2 = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
for (const k of R2) delete process.env[k];
delete process.env.APP_STORAGE_DIR;

// Everything the process prints, to prove no key ever reaches a log.
const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const VAULT_ID = `VAULTKEYID${randomBytes(8).toString("hex")}`, VAULT_SECRET = `vault-secret-CANARY-${randomBytes(16).toString("hex")}`;
const ENV_ID = `ENVKEYID${randomBytes(8).toString("hex")}`, ENV_SECRET = `env-secret-CANARY-${randomBytes(16).toString("hex")}`;
const OTHER_SECRET = `other-secret-CANARY-${randomBytes(16).toString("hex")}`;
const SECRETS = [VAULT_SECRET, ENV_SECRET, OTHER_SECRET];

const s3 = await startS3Standin({ buckets: ["vault-bucket", "vault-bucket-2", "env-bucket"], keys: { [VAULT_ID]: VAULT_SECRET, [ENV_ID]: ENV_SECRET } });
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const kv = await import("../src/keyvault.js");
  const storage = await import("../src/storage.js");
  const pk = await import("../src/platform-keys.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const { providerInBuild } = await import("../src/vault-providers.js");
  const entry = (o: Partial<Record<"bucket" | "endpoint" | "access_key_id" | "secret_access_key", string>> = {}) =>
    JSON.stringify({ bucket: "vault-bucket", endpoint: s3.url, access_key_id: VAULT_ID, secret_access_key: VAULT_SECRET, ...o });
  const uses = async () => Number((await db.query<{ uses: number }>("SELECT uses FROM vault_credentials WHERE provider = 'object_storage'"))[0]?.uses ?? -1);
  const later = (ms: number) => { const real = Date.now; Date.now = () => real() + ms; return () => { Date.now = real; }; };

  // ---------- 1. none configured; the fields are checked ----------
  {
    assert.equal(await storage.s3Ready(), false);
    await assert.rejects(storage.objectStore(), (e: Error) => /R2_BUCKET/.test(e.message) && /Key vault/.test(e.message) && /APP_STORAGE_DIR/.test(e.message),
      "none configured: the error names the environment, the key vault and APP_STORAGE_DIR");
    assert.deepEqual(await storage.storageSource(), { source: null, bucket: null });
    const bad: [Record<string, string>, RegExp][] = [
      [{ bucket: "Bad_Bucket" }, /^bucket:/], [{ bucket: "" }, /^bucket:/],
      [{ endpoint: "http://storage.example.com" }, /^endpoint: must start with https/], [{ endpoint: "not a url" }, /^endpoint:/],
      [{ endpoint: "https://acct.r2.cloudflarestorage.com/some/path" }, /^endpoint: give the service's address only/],
      [{ endpoint: `https://u:${OTHER_SECRET}@acct.r2.cloudflarestorage.com` }, /^endpoint: give the address without a user name/],
      [{ access_key_id: "short" }, /^access_key_id:/], [{ secret_access_key: "short" }, /^secret_access_key:/],
      [{ secret_access_key: `${OTHER_SECRET} x` }, /^secret_access_key:/],
    ];
    for (const [o, re] of bad) {
      const err = await kv.setCredential("object_storage", entry(o)).then(() => null, (e: Error) => e);
      assert.ok(err && re.test(err.message), `${JSON.stringify(Object.keys(o))}: ${err?.message}`);
      for (const s of [...SECRETS, VAULT_ID]) assert.ok(!err!.message.includes(s), "an error never quotes a key");
    }
    await assert.rejects(kv.setCredential("object_storage", JSON.stringify({ ...JSON.parse(entry()), region: "x" })), /no field region/);
    assert.equal(kv.checkObjectStorage(entry({ endpoint: "https://acct.r2.cloudflarestorage.com/vault-bucket/" })).endpoint, "https://acct.r2.cloudflarestorage.com",
      "Cloudflare's S3 API address with the bucket at its end is taken");
    assert.equal(storage.regionOf("https://s3.eu-west-2.amazonaws.com"), "eu-west-2"); assert.equal(storage.regionOf("https://acct.r2.cloudflarestorage.com"), "auto");
    assert.equal((await db.query("SELECT 1 FROM vault_credentials WHERE provider = 'object_storage'")).length, 0, "nothing was stored");
    console.log("✓ none configured: refused, naming R2_*, Key vault › Object storage and APP_STORAGE_DIR; each field checked, no key quoted");
  }

  // ---------- 2. the vault when the environment has none; the environment wins ----------
  let entryId: number;
  {
    const saved = await kv.setCredential("object_storage", entry(), { label: "anything" });
    entryId = saved.id;
    assert.equal(saved.label, "default", "one entry, under its one label");
    assert.equal(saved.hint, `vault-bucket at ${new URL(s3.url).host}`, "its hint is the bucket and the endpoint's host");
    const os = await storage.objectStore();
    assert.deepEqual([os.kind, os.source], ["r2", "vault"], "the vault's entry when the environment has no R2_*");
    await os.put("workspaces/org-1/fixture/1.wse", Buffer.from("one"), "application/octet-stream");
    assert.deepEqual(s3.list("vault-bucket"), ["workspaces/org-1/fixture/1.wse"], "written to the vault's bucket, under the workspace's prefix");
    assert.equal((await os.get("workspaces/org-1/fixture/1.wse"))?.toString(), "one");
    assert.equal(await os.get("workspaces/org-1/fixture/none.wse"), null, "a missing object is null");
    assert.deepEqual(await os.list("workspaces/org-1/"), ["workspaces/org-1/fixture/1.wse"]);
    await storage.putObject(storage.keys.research(1, "r1"), "{}", "application/json");
    assert.ok(s3.list("vault-bucket", "research/org-1/").length === 1, "the other prefixes go to the same bucket");
    assert.match(await storage.signedUrl(storage.keys.research(1, "r1")), new RegExp(`^${s3.url}/vault-bucket/research/org-1/r1\\.json\\?`), "signed links name the vault's bucket");
    assert.ok(!(await storage.signedUrl(storage.keys.research(1, "r1"))).includes(VAULT_SECRET), "a signed link carries no secret");
    await os.remove(["workspaces/org-1/fixture/1.wse"]);
    assert.deepEqual(s3.list("vault-bucket", "workspaces/"), []);
    assert.ok(s3.calls.every((c) => c.accessKeyId === VAULT_ID && c.status < 300 || c.status === 404), "signed with the vault's key, accepted");

    // A partial environment does not count; all four win.
    process.env.R2_BUCKET = "env-bucket";
    assert.equal((await storage.objectStore()).source, "vault", "one R2_* alone: still the vault");
    Object.assign(process.env, { R2_ENDPOINT: s3.url, R2_ACCESS_KEY_ID: ENV_ID, R2_SECRET_ACCESS_KEY: ENV_SECRET });
    const fromEnv = await storage.objectStore();
    assert.equal(fromEnv.source, "env", "all four R2_*: the environment wins");
    await fromEnv.put("workspaces/org-2/fixture/1.wse", Buffer.from("env"), "application/octet-stream");
    assert.deepEqual(s3.list("env-bucket"), ["workspaces/org-2/fixture/1.wse"], "written to the environment's bucket");
    assert.deepEqual(s3.list("vault-bucket", "workspaces/"), [], "not the vault's");
    assert.equal(s3.calls.at(-1)!.accessKeyId, ENV_ID, "signed with the environment's key");
    assert.deepEqual(await storage.storageSource(), { source: "env", bucket: "env-bucket" });
    for (const k of R2) delete process.env[k];
    assert.equal((await storage.objectStore()).source, "vault", "the environment's settings removed: the vault again");
    console.log("✓ the vault's entry when the environment has no R2_*; all four R2_* win (a partial set does not); same prefixes, signed links");
  }

  // ---------- 3. the cache ----------
  {
    storage.forgetStorageSettings();
    const u0 = await uses();
    for (let i = 0; i < 5; i++) await storage.objectStore();
    assert.equal(await uses(), u0 + 1, "five uses within the minute: the vault was read once");
    // A change made here: at once.
    await pk.saveObjectStorage("test@owner", { bucket: "vault-bucket-2" });
    const os2 = await storage.objectStore();
    await os2.put("ops/cache-check.txt", Buffer.from("2"), "text/plain");
    assert.deepEqual(s3.list("vault-bucket-2"), ["ops/cache-check.txt"], "saved on /admin/keys: the next write goes to the new bucket at once (the keys kept)");
    // A change made by another instance (the row written directly): this one keeps its client until the minute is up.
    const enc = kv.encrypt(entry());
    await db.query("UPDATE vault_credentials SET ciphertext = $2, iv = $3, tag = $4, key_id = $5 WHERE id = $1", [entryId, enc.ciphertext, enc.iv, enc.tag, enc.key_id]);
    assert.equal((await storage.storageSource()).bucket, "vault-bucket-2", "another instance's change: not seen within the minute");
    let undo = later(61_000);
    try { assert.equal((await storage.storageSource()).bucket, "vault-bucket", "after the minute: read again"); } finally { undo(); }
    // Turned off, the provider off, deleted: at once.
    await pk.setModelKeyEnabled("test@owner", entryId, false);
    assert.equal(await storage.s3Ready(), false, "the entry turned off: not used");
    await pk.setModelKeyEnabled("test@owner", entryId, true);
    assert.equal(await storage.s3Ready(), true);
    await pk.setProviderEnabled("test@owner", "object_storage", false);
    assert.equal(await storage.s3Ready(), false, "the provider turned off: not used");
    await pk.setProviderEnabled("test@owner", "object_storage", true);
    process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
    await pk.deleteModelKey("test@owner", entryId);
    assert.deepEqual([(await storage.objectStore()).source, await storage.s3Ready()], ["dir", false], "deleted: APP_STORAGE_DIR, at once");
    delete process.env.APP_STORAGE_DIR;
    await assert.rejects(storage.objectStore(), /no object store/);
    console.log("✓ the cache: one vault read a minute; a save, a switch or a delete here takes effect at once, one made elsewhere after the minute");
  }

  // ---------- 4. the Test ----------
  {
    await pk.saveObjectStorage("test@owner", JSON.parse(entry()));
    const ok = await pk.testObjectStorage("test@owner");
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.steps, [{ step: "write", ok: true }, { step: "read", ok: true }, { step: "delete", ok: true }]);
    const tested = s3.calls.filter((c) => c.key.startsWith(storage.TEST_PREFIX));
    assert.deepEqual(tested.map((c) => c.method), ["PUT", "GET", "DELETE"], "one object written, read and deleted under ops/key-vault-test/");
    assert.deepEqual(s3.list("vault-bucket", storage.TEST_PREFIX), [], "nothing left behind");
    const cases: [Record<string, string>, RegExp][] = [
      [{ secret_access_key: OTHER_SECRET }, /secret access key does not belong to this access key id/],
      [{ access_key_id: "UNKNOWNKEYID0001" }, /access key id is not one this service knows/],
      [{ bucket: "no-such-bucket" }, /no bucket named no-such-bucket/],
      [{ endpoint: "http://127.0.0.1:9" }, /could not be reached/],
    ];
    for (const [o, re] of cases) {
      await pk.saveObjectStorage("test@owner", o);
      const r = await pk.testObjectStorage("test@owner");
      assert.equal(r.ok, false, JSON.stringify(o));
      assert.match(r.error ?? "", re);
      for (const s of SECRETS) assert.ok(!JSON.stringify(r).includes(s), "a failed Test never carries a key");
      await pk.saveObjectStorage("test@owner", JSON.parse(entry()));
    }
    assert.equal((await pk.testObjectStorage("test@owner")).ok, true, "the right settings again: ok");
    console.log("✓ Test: write, read, delete under ops/key-vault-test/ (nothing left); a wrong secret, an unknown key, no bucket, no answer: in words");
  }

  // ---------- 6. a run's write-back with only the vault entry; the provider in the build ----------
  const harness = await import("../src/run-harness.js");
  const { createOrg } = await import("../src/auth.js");
  const A = (await createOrg(`Bucket A ${STAMP}`)).org;
  assert.equal(await providerInBuild("object_storage", 0), false, "no store, no engine, no key: not in the build");
  const fixture = definePack({
    id: "fixture_store",
    jobKinds: [{ name: "notes", runner: "workspace-harness", workspace: true, lease_seconds: 15, entry: "notes.mjs", validator: "accept.mjs" }] as never,
    tools: [defineTool({ name: "fixture_note_run", description: "Start a notes run (test).", inputSchema: { text: z.string().optional() },
      handler: async (_ws, { text }, { runs: r }) => r.start("notes", { targets: { text } }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_store", name: "Fixture store", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  assert.equal(await providerInBuild("object_storage", 0), true, "a pack whose runs keep a workspace store: in the build");
  const ca = await connect(A);
  const http = await startHttp();
  try {
    assert.equal(process.env.APP_STORAGE_DIR, undefined); assert.ok(R2.every((k) => !process.env[k]), "no R2_*, no directory: only the vault");
    const start = async (text: string) => { const r = await ca.call("fixture_note_run", { text }); assert.ok(!r.isError, r.content[0]?.text); return r.structuredContent as { id: string }; };
    await start(`first ${STAMP}`);
    const local = await harness.localRunnerClient("w-bucket");
    const c1 = (await local.claim(["fixture_store/notes"]))!;
    assert.equal((await harness.runWorkspaceHarness(local, c1, { allowSameUser: true, egress: "off" }))?.status, "succeeded");
    // Over HTTP: PUT /api/worker/runs/<id>/workspace, the request that answered 500 "no object store" before.
    const W = process.env.APP_WORKER_TOKEN!;
    const viaHttp = harness.httpRunnerClient(http.base, W, "w-bucket-http");
    await start(`second ${STAMP}`);
    const c2 = (await viaHttp.claim(["fixture_store/notes"]))!;
    const v2 = await harness.runWorkspaceHarness(viaHttp, c2, { allowSameUser: true, egress: "off" });
    assert.equal(v2?.status, "succeeded", `over HTTP: ${JSON.stringify(v2)}`);
    const snaps = await db.query<{ version: number; object_key: string }>("SELECT version, object_key FROM workspace_snapshots WHERE org_id = $1 AND status = 'committed' ORDER BY version", [A.orgId]);
    assert.deepEqual(snaps.map((s) => s.version), [1, 2], "versions 1 and 2 written back");
    assert.deepEqual(s3.list("vault-bucket", `workspaces/org-${A.orgId}/fixture_store/`), snaps.map((s) => s.object_key).sort(), "each in the vault's bucket, under the workspace's prefix");
    const raw = s3.object("vault-bucket", snaps[1]!.object_key)!;
    assert.ok(raw.subarray(0, 4).toString() === "WSE1" && !raw.includes(Buffer.from(`second ${STAMP}`)), "sealed with the workspace's key, as before");
    const ev = await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'seen' ORDER BY id DESC LIMIT 1", [c2.run.id]);
    assert.match(ev[0]?.data?.notes ?? "", /first/, "the second run checked out the first one's files from the bucket");
    console.log("✓ a run's workspace write-back with only the vault's entry: in-process and over HTTP (PUT /api/worker/runs/<id>/workspace), versions 1 and 2 in the bucket");

    // ---------- 5. never a key in an answer; viewers cannot change it ----------
    const owner = { authorization: `Bearer ${await http.adminToken("owner")}` };
    const viewer = { authorization: `Bearer ${await http.adminToken("viewer")}` };
    const B = "/api/admin/onboarding";
    const answers: string[] = [];
    const call = async (m: string, p: string, h: Record<string, string>, body?: unknown) => {
      const r = await http.req(m, `${B}${p}`, h, body);
      const t = await r.text(); answers.push(t);
      return { status: r.status, body: t ? JSON.parse(t) : null };
    };
    const keys = await call("GET", "/compute/keys", owner);
    assert.equal(keys.status, 200);
    const prov = keys.body.providers.find((p: any) => p.slug === "object_storage");
    assert.ok(prov, "listed on Key vault in this build");
    assert.equal(prov.in_use, "vault");
    const cred = keys.body.credentials.find((c: any) => c.provider === "object_storage");
    assert.deepEqual([cred.bucket, cred.endpoint, cred.label], ["vault-bucket", s3.url, "default"], "the bucket and endpoint are shown");
    assert.equal(cred.access_key_hint, kv.hint(VAULT_ID), "the access key id only as its hint");
    const view = await call("GET", "/compute/object-storage", owner);
    assert.deepEqual([view.body.configured, view.body.bucket, view.body.set], [true, "vault-bucket", { access_key_id: true, secret_access_key: true }]);
    assert.equal((await call("POST", "/compute/object-storage", viewer, { bucket: "vault-bucket-2" })).status, 403, "a viewer cannot save");
    assert.equal((await call("POST", "/compute/object-storage/test", viewer)).status, 403, "nor test");
    const saved = await call("POST", "/compute/object-storage", owner, { bucket: "vault-bucket-2", secret_access_key: "" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.bucket, "vault-bucket-2", "an owner edits it; a blank key keeps the stored one");
    const bad = await call("POST", "/compute/object-storage", owner, { endpoint: "http://storage.example.com" });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /https/);
    const t = await call("POST", "/compute/object-storage/test", owner);
    assert.equal(t.body.ok, true, JSON.stringify(t.body));
    assert.equal((await call("POST", "/compute/keys", owner, { provider: "object_storage", secret: entry() })).status, 201, "the import's path (one JSON entry) takes it too");
    const { runAdminTool } = await import("../src/admin-mcp.js");
    const tool = await runAdminTool({ actor: "test@owner", role: "owner", userId: null }, "key_vault_status", {});
    const listed = JSON.stringify(tool);
    assert.ok(/object_storage/.test(listed) && /vault-bucket/.test(listed), "the admin MCP's key_vault_status lists it, with its bucket");
    answers.push(listed);
    const { vaultStatus, formatVaultStatus } = await import("../src/vault-status.js");
    const conn = { query: async (sql: string, params?: unknown[]) => ({ rows: await db.query(sql, params as never) }) };
    const vs = await vaultStatus(conn);
    const need = vs.runs.needs.find((n) => n.slug === "object_storage");
    assert.deepEqual([need?.set, need?.kinds], ["yes", ["fixture_store.notes"]], "operator:vault-status: needs Object storage, set");
    const text = formatVaultStatus(vs);
    assert.match(text, /needs Object storage \(R2 \/ S3\) \(object_storage\) for the workspace store of 1 run kind .*: set/);
    answers.push(text, JSON.stringify(vs));
    for (const a of answers) for (const s of [...SECRETS, VAULT_ID, ENV_ID]) assert.ok(!a.includes(s), "no key, nor the access key id, in any answer");
    for (const line of printed) for (const s of [...SECRETS, VAULT_ID, ENV_ID]) assert.ok(!line.includes(s), `nothing printed carries a key: ${line.slice(0, 80)}`);
    assert.ok(printed.some((l) => /object_storage\.save/.test(l)) && printed.some((l) => /object_storage\.test/.test(l)), "saves and Tests are in the audit log");
    console.log("✓ no key in any answer (Key vault, the entry, Test, import, vault-status) or anything printed; a viewer cannot save or test; audited");
  } finally {
    await ca.close();
    await http.close();
  }
  setPacksForTest(null);
  await db.close();
  console.log("OBJECT STORAGE TEST PASS");
} finally {
  await s3.close();
  cleanup();
}
process.exit(0);
