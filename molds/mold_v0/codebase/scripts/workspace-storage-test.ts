// A workspace's own object storage (mold_v0-305, flag workspace_storage; src/workspace-storage.ts, src/storage.ts,
// src/record-page-routes.ts test_storage), offline: an embedded database and the S3 stand-in (scripts/lib/s3-standin.ts),
// which checks every request's signature as R2 does.
//   npm run test:workspace-storage
//
// Proves:
//   1. the declaration (pack.json object_storage) is checked against the pack's own areas: a workspace area, both keys
//      encrypted, a boolean "use", a contract that reveals nothing; the flag is asked for by it alone
//   2. who may: only the workspace's owners add or change a storage record (the area's permissions); a bucket or an
//      endpoint a service would refuse is refused on save
//   3. the keys are sealed: stored as envelopes, masked on every read (lists, a record, the HTTP API), never revealed
//   4. resolution: a key stored for a workspace goes to its record marked for use, else the environment's R2_*, else none
//      (refused, NOT_CONFIGURED); the platform's own keys never go to a workspace's bucket; another workspace keeps its
//      own; a read the workspace's bucket lacks falls back to the platform's; turning "use" off takes effect at once;
//      with only a local directory below, the workspace's keys still go to its bucket
//   5. the record page's Test: offered to an owner only (a member neither sees nor takes it); writes, reads and deletes
//      one object (nothing left behind), writes status working and the date; a wrong secret, an unknown bucket and an
//      unreachable endpoint each in words, status failing; an edit with the keys left empty keeps them
//   7. the transcript archive (mold_v0-308): a workspace's archive goes to its own bucket; with no platform bucket the
//      sweeper still archives the workspaces that have their own (and only those); a restore lists both buckets
//   8. a workspace's deletion (mold_v0-308): its objects go from its own bucket and from the platform's (older ones);
//      another workspace's stay; with no platform bucket, its own bucket alone is enough to purge
//   6. no key in anything: every HTTP answer, every line the process printed
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { startS3Standin } from "./lib/s3-standin.js";
import { TMP } from "./lib/test-world.js";

const R2 = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
for (const k of R2) delete process.env[k];
delete process.env.APP_STORAGE_DIR;

const printed: string[] = [];
for (const m of ["log", "error", "warn", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}
const ok = (m: string) => console.log(`✓ ${m}`);

const WS_ID = `WSKEYID${randomBytes(8).toString("hex")}`, WS_SECRET = `ws-secret-CANARY-${randomBytes(16).toString("hex")}`;
const PL_ID = `PLKEYID${randomBytes(8).toString("hex")}`, PL_SECRET = `pl-secret-CANARY-${randomBytes(16).toString("hex")}`;
const WRONG = `wrong-secret-CANARY-${randomBytes(16).toString("hex")}`;
const SECRETS = [WS_SECRET, PL_SECRET, WRONG];
const s3 = await startS3Standin({ buckets: ["ws-a-files", "platform-files"], keys: { [WS_ID]: WS_SECRET, [PL_ID]: PL_SECRET } });

const ALL = ["viewer", "member", "billing", "owner"];
const PACK = {
  id: "fixture_storage", name: "Fixture storage", version: "1",
  record_areas: [{
    name: "fx_storage", label: "Storage connections", role: "source", scope: "workspace",
    fields: [
      { name: "bucket", label: "Bucket", type: "text", max_length: 63 },
      { name: "endpoint", label: "Endpoint", type: "url" },
      { name: "access_key_id", label: "Access key ID", type: "text", encrypted: true },
      { name: "secret_access_key", label: "Secret access key", type: "text", encrypted: true },
      { name: "use_for_files", label: "Keep this workspace's files here", type: "boolean" },
      { name: "status", label: "Last test", type: "enum", options: ["untested", "working", "failing"] },
      { name: "tested", label: "Tested on", type: "date" },
      { name: "use_in_builds", label: "Use in builds", type: "boolean" },
    ],
    permissions: { read: ALL, create: ["owner"], update: ["owner"], delete: ["owner"] },
    contract: { provenance: ["people"], actions: { read: ALL, export: { none: "keys" }, create: ["owner"], update: ["owner"], move: { none: "no lifecycle" }, delete: ["owner"],
      reveal: { none: "The keys are never shown again once saved" }, import: { none: "keys are typed" } }, primary_action: "create_record" },
    detail: { tabs: [{ label: "Details", sections: [{ title: "Where", fields: ["bucket", "endpoint", "use_for_files"] }] }],
      actions: [{ kind: "test_storage", place: "primary", label: "Test", roles: ["owner"] }, { kind: "edit", place: "secondary" }] },
  }],
  // mold_v0-322: the same area given to agent sessions by another flag: its Test names both.
  agent_profiles: [{ id: "builder", name: "Builder", connection_env: [{ area: "fx_storage", use: "use_in_builds", prefix: "STORE_", fields: { BUCKET: "bucket", SECRET: "secret_access_key" } }] }],
  object_storage: { area: "fx_storage", fields: { bucket: "bucket", endpoint: "endpoint", access_key_id: "access_key_id", secret_access_key: "secret_access_key", use: "use_for_files", status: "status", tested: "tested" } },
};

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const F = await import("../src/features.js");
  const storage = await import("../src/storage.js");
  const W = await import("../src/workspace-storage.js");
  const api = await import("../src/pack-api.js");
  const ra = await import("../src/record-areas.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations, PackJsonSchema } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");

  // ---------- 1. the declaration ----------
  {
    assert.ok(PackJsonSchema.safeParse(PACK).success, JSON.stringify(PackJsonSchema.safeParse(PACK).error?.issues));
    const area = PACK.record_areas[0]!;
    assert.deepEqual(api.objectStorageProblems(PACK.object_storage, [area]), [], "the fixture's declaration");
    const bad = (patch: (a: any, d: any) => void, re: RegExp, what: string) => {
      const a = structuredClone(area) as any, d = structuredClone(PACK.object_storage) as any; patch(a, d);
      const p = api.objectStorageProblems(d, [a]);
      assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
    };
    bad((a) => { a.fields[3].encrypted = false; }, /secret_access_key is an encrypted field/, "a secret in the clear");
    bad((a) => { a.fields[2].encrypted = false; }, /access_key_id is an encrypted field/, "an access key id in the clear");
    bad((a) => { a.scope = "platform"; }, /shared area/, "a shared area");
    bad((a) => { a.contract.actions.reveal = ["owner"]; }, /reveals nothing/, "keys an owner could reveal");
    bad((a) => { a.fields[4].type = "text"; }, /is a boolean field/, "use as text");
    bad((_a, d) => { d.fields.bucket = "nope"; }, /has no field nope/, "a field the area lacks");
    bad((_a, d) => { d.area = "elsewhere"; }, /declares no record area elsewhere/, "an area the pack lacks");
    bad((_a, d) => { d.region = "x"; }, /region|Unrecognized/i, "an unknown key");
    bad((a) => { a.fields[5].options = ["a", "b"]; }, /options working and failing/, "a status without working and failing");
    setPacksForTest([{ manifest: { id: "fixture_storage", name: "x", version: "1", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
    assert.equal(F.featureRequested("workspace_storage"), true, "asked for by object_storage");
    assert.equal(F.featureOn("workspace_storage"), true, "on by default once asked for");
    assert.equal(W.storageDecl()?.area, "fx_storage");
    F.setFeatureForTest("workspace_storage", false);
    assert.equal(W.workspaceStorageOn(), false, "off: the declaration is ignored");
    F.setFeatureForTest("workspace_storage", null);
    ok("the declaration: a workspace area, both keys encrypted, use a boolean, a contract that reveals nothing; status working/failing; the flag asked for by it alone, off ignores it");
  }

  F.setFeaturesForTest({ record_pages: true });
  const A = (await createOrg(`Storage A ${STAMP}`)).org, B = (await createOrg(`Storage B ${STAMP}`)).org;
  const owner = { role: "owner" as const, userId: "user_owner_a" }, member = { role: "member" as const, userId: "user_member_a" };
  const recA = ra.workspaceRecords("fixture_storage", A.orgId, owner);
  const good = { bucket: "ws-a-files", endpoint: s3.url, access_key_id: WS_ID, secret_access_key: WS_SECRET, use_for_files: true, status: "untested" };

  // ---------- 2. who may; checked on save ----------
  {
    await assert.rejects(ra.workspaceRecords("fixture_storage", A.orgId, member).create("fx_storage", "a-files", { title: "A files", data: good }), /role|permission|can't|cannot/i,
      "a member adds no storage");
    await assert.rejects(recA.create("fx_storage", "bad", { title: "Bad", data: { ...good, bucket: "Bad_Bucket" } }), /bucket: 3 to 63 lowercase/, "a bucket name a service refuses");
    await assert.rejects(recA.create("fx_storage", "bad", { title: "Bad", data: { ...good, endpoint: "http://storage.example.com" } }), /endpoint: must start with https/, "an endpoint in the clear");
    await assert.rejects(recA.create("fx_storage", "bad", { title: "Bad", data: { ...good, endpoint: `${s3.url}/other/path` } }), /endpoint: give the service's address only/, "an endpoint with a path");
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.create("fx_storage", "a-files", { title: "A files", data: good }));
    ok("who may: only an owner adds a storage record; a bucket name or an endpoint a service refuses is refused on save, in words");
  }

  // ---------- 3. sealed ----------
  {
    const [row] = await db.query<{ data: unknown }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'fx_storage' AND key = 'a-files'", [A.orgId]);
    const raw = JSON.stringify(row!.data);
    assert.ok(!raw.includes(WS_SECRET) && !raw.includes(WS_ID), "stored sealed: neither key in the row");
    const got = await ra.getFor(A.orgId, "fx_storage", "a-files", owner);
    assert.equal(got!.data.secret_access_key, "[encrypted]"); assert.equal(got!.data.access_key_id, "[encrypted]");
    await assert.rejects(ra.revealFor(A.orgId, "fx_storage", "a-files", undefined, owner), /never revealed/, "never revealed, not even to an owner");
    ok("sealed: both keys stored as envelopes, masked on every read, never revealed (the contract's reveal is none)");
  }

  // ---------- 4. resolution ----------
  {
    const aKey = storage.keys.workspace(A.orgId, "fx", 1), bKey = storage.keys.workspace(B.orgId, "fx", 1);
    assert.equal(storage.orgOfKey(aKey), A.orgId); assert.equal(storage.orgOfKey("agent-profiles/uploads/upl_x/0.part"), null); assert.equal(storage.orgOfKey("postgres/x"), null);
    const os = await storage.objectStore();
    await os.put(aKey, Buffer.from("a1"), "application/octet-stream");
    assert.deepEqual(s3.list("ws-a-files"), [aKey], "A's key: A's own bucket");
    assert.ok(s3.calls.filter((c) => c.bucket === "ws-a-files").every((c) => c.accessKeyId === WS_ID), "signed with A's own key");
    assert.equal((await os.get(aKey))?.toString(), "a1");
    await assert.rejects(os.put(bKey, Buffer.from("b1"), "application/octet-stream"), /no object store/, "B has none and the platform none: refused");
    await assert.rejects(os.put("agent-profiles/uploads/upl_x/0.part", Buffer.from("p"), "application/octet-stream"), /no object store/, "the platform's own key never goes to a workspace's bucket");
    // The environment's bucket below.
    Object.assign(process.env, { R2_BUCKET: "platform-files", R2_ENDPOINT: s3.url, R2_ACCESS_KEY_ID: PL_ID, R2_SECRET_ACCESS_KEY: PL_SECRET });
    const os2 = await storage.objectStore();
    await os2.put(bKey, Buffer.from("b1"), "application/octet-stream");
    await os2.put(storage.keys.workspace(A.orgId, "fx", 2), Buffer.from("a2"), "application/octet-stream");
    await storage.putObject("agent-profiles/uploads/upl_x/0.part", "p", "application/octet-stream");
    assert.deepEqual(s3.list("platform-files"), ["agent-profiles/uploads/upl_x/0.part", bKey].sort(), "B and the platform's own keys: the environment's bucket");
    assert.deepEqual(s3.list("ws-a-files"), [aKey, storage.keys.workspace(A.orgId, "fx", 2)].sort(), "A's keys: still A's own, over the environment's");
    assert.match(await storage.signedUrl(aKey), new RegExp(`/ws-a-files/`), "a link to A's object names A's bucket");
    // Stored before A had its own: still read.
    const oldKey = storage.keys.workspace(A.orgId, "fx", 99);
    // written straight into the platform's bucket, as a release from before the workspace's own bucket would have
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const pc = storage.s3Client({ bucket: "platform-files", endpoint: s3.url, access_key_id: PL_ID, secret_access_key: PL_SECRET });
    await pc.send(new PutObjectCommand({ Bucket: "platform-files", Key: oldKey, Body: "old" })); pc.destroy();
    assert.equal((await os2.get(oldKey))?.toString(), "old", "a key A's bucket lacks: read from the platform's (stored before)");
    // "use" off: at once (the record's change drops the cache).
    const shown = await ra.getFor(A.orgId, "fx_storage", "a-files", owner);
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_storage", "a-files", { title: shown!.title, data: { ...shown!.data, use_for_files: false } }));
    const k3 = storage.keys.workspace(A.orgId, "fx", 3);
    await (await storage.objectStore()).put(k3, Buffer.from("a3"), "application/octet-stream");
    assert.ok(s3.list("platform-files").includes(k3) && !s3.list("ws-a-files").includes(k3), "use turned off: A's next key goes to the environment's bucket at once");
    const back = await ra.getFor(A.orgId, "fx_storage", "a-files", owner);
    await ra.asWriter({ by: "people", id: "owner" }, () => recA.update("fx_storage", "a-files", { title: back!.title, data: { ...back!.data, use_for_files: true } }));
    const k4 = storage.keys.workspace(A.orgId, "fx", 4);
    await storage.putObject(k4, "a4", "application/octet-stream");
    assert.ok(s3.list("ws-a-files").includes(k4), "use on again (the masked keys written back kept): A's bucket again");
    for (const k of R2) delete process.env[k];
    // Only a local directory below: A's keys still go to A's bucket, B's to the directory.
    process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
    const os3 = await storage.objectStore();
    const k5 = storage.keys.workspace(A.orgId, "fx", 5), b2 = storage.keys.workspace(B.orgId, "fx", 2);
    await os3.put(k5, Buffer.from("a5"), "application/octet-stream"); await os3.put(b2, Buffer.from("b2"), "application/octet-stream");
    assert.ok(s3.list("ws-a-files").includes(k5), "a local directory below: A's key still in A's bucket");
    assert.equal((await os3.get(b2))?.toString(), "b2"); assert.ok(!s3.list("ws-a-files").includes(b2) && !s3.list("platform-files").includes(b2), "B's key in the directory");
    assert.equal((await storage.objectStore(storage.keys.orgPrefix("workspaces", A.orgId))).kind, "r2", "A's store, asked for by its prefix: its bucket (with links)");
    assert.ok((await storage.objectStore(storage.keys.orgPrefix("workspaces", A.orgId))).links, "links for a run's transfer of A");
    assert.equal((await storage.objectStore(storage.keys.orgPrefix("workspaces", B.orgId))).kind, "local", "B's: the directory (no links)");
    await os3.remove([k5, b2]);
    assert.ok(!s3.list("ws-a-files").includes(k5) && (await os3.get(b2)) === null, "removed, each from where it is");
    delete process.env.APP_STORAGE_DIR;
    F.setFeatureForTest("workspace_storage", false);
    await assert.rejects(storage.objectStore(), /no object store/, "the flag off: nothing of A's record is used");
    F.setFeatureForTest("workspace_storage", null);
    ok("resolution: a workspace's key to its record marked for use, else R2_*, else refused; platform keys never to a workspace bucket; B keeps its own; a missing key falls back to the platform's bucket; use off/on at once; over a local directory too; off: ignored");
  }

  // ---------- 5. the record page's Test ----------
  const answers: string[] = [];
  {
    const http = await startHttp();
    const ownerTok = await http.signIn(A, "owner"), memberTok = await http.signIn(A, "member");
    const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
    const call = async (method: string, tok: string, p: string, body?: unknown) => {
      const r = await http.req(method, p, h(tok), body);
      const text = await r.text(); answers.push(text);
      return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() as any };
    };
    const page = await call("GET", ownerTok, "/api/records/_page/fx_storage/a-files");
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.actions.some((x: any) => x.kind === "test_storage" && x.label === "Test"), "an owner is offered Test");
    const mPage = await call("GET", memberTok, "/api/records/_page/fx_storage/a-files");
    assert.ok(!mPage.body.actions.some((x: any) => x.kind === "test_storage"), "a member is not");
    assert.equal((await call("POST", memberTok, "/api/records/_page/fx_storage/a-files/actions/test_storage")).status, 403, "nor may take it");
    const before = s3.list("ws-a-files", storage.TEST_PREFIX).length;
    const t = await call("POST", ownerTok, "/api/records/_page/fx_storage/a-files/actions/test_storage");
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.ok, true, JSON.stringify(t.body));
    assert.deepEqual(t.body.steps.map((s: any) => s.step), ["write", "read", "delete"]);
    assert.match(t.body.words, /^It works: a small test file was written to ws-a-files, read back and deleted/);
    assert.match(t.body.words, /This workspace's files are kept there\. Turn on "Use in builds" for agent sessions to receive it\.$/, `both flags the pack declares for the area, by label (mold_v0-322): ${t.body.words}`);
    assert.equal(s3.list("ws-a-files", storage.TEST_PREFIX).length, before, "nothing left behind");
    const after = await ra.getFor(A.orgId, "fx_storage", "a-files", owner);
    assert.equal(after!.data.status, "working"); assert.equal(after!.data.tested, new Date().toISOString().slice(0, 10));
    // A wrong secret, a bucket that is not there, an address nobody answers: each in words, status failing.
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["wrong-secret", { secret_access_key: WRONG }, /secret access key does not belong to this access key id/],
      ["no-bucket", { bucket: "not-there" }, /There is no bucket named not-there/],
      ["no-answer", { endpoint: "http://127.0.0.1:9" }, /could not be reached/],
    ];
    for (const [key, patch, re] of cases) {
      await ra.asWriter({ by: "people", id: "owner" }, () => recA.create("fx_storage", key, { title: key, data: { ...good, use_for_files: false, ...patch } }));
      const r = await call("POST", ownerTok, `/api/records/_page/fx_storage/${key}/actions/test_storage`);
      assert.equal(r.body.ok, false, key); assert.match(r.body.words, /^It does not work yet: /); assert.match(r.body.words, re, `${key}: ${r.body.words}`);
      assert.equal((await ra.getFor(A.orgId, "fx_storage", key, owner))!.data.status, "failing", `${key}: status failing`);
    }
    // An edit with the keys left empty keeps them (the Test still works).
    const edit = await call("POST", ownerTok, "/api/records/_page/fx_storage/a-files/actions/edit", { title: "A files", data: { bucket: "ws-a-files", endpoint: s3.url, access_key_id: "", secret_access_key: "", use_for_files: true, status: "working" } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal((await call("POST", ownerTok, "/api/records/_page/fx_storage/a-files/actions/test_storage")).body.ok, true, "the keys were kept by an edit that left them empty");
    const list = await call("GET", ownerTok, "/api/records/fx_storage");
    assert.equal(list.status, 200); assert.ok(list.body.records.every((r: any) => r.data.secret_access_key === "[encrypted]"), "a list: masked");
    await http.close();
    ok("Test: an owner's only; write, read and delete one object (nothing left), status working and the date; a wrong secret, a missing bucket, an unreachable endpoint each in words, status failing; an edit with empty keys keeps them");
  }

  // ---------- 7. the transcript archive ----------
  const platformClient = () => storage.s3Client({ bucket: "platform-files", endpoint: s3.url, access_key_id: PL_ID, secret_access_key: PL_SECRET });
  const intoPlatform = async (key: string, body: string) => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const pc = platformClient(); await pc.send(new PutObjectCommand({ Bucket: "platform-files", Key: key, Body: body })); pc.destroy();
  };
  {
    const archive = await import("../src/archive.js");
    W.forgetWorkspaceStorage();
    assert.deepEqual(await W.workspacesWithStorage(), [A.orgId], "only A has a storage marked for use");
    assert.deepEqual(await archive.archiveOrgs(), [A.orgId], "no platform bucket: the sweeper archives A (its own bucket) and no other workspace");
    assert.equal(await storage.bucketReadyFor(storage.keys.orgPrefix("transcripts", A.orgId)), true, "A's archive has a bucket");
    assert.equal(await storage.bucketReadyFor(storage.keys.orgPrefix("transcripts", B.orgId)), false, "B's has none");
    const t1 = storage.keys.transcript(A.orgId, "sess-new", new Date());
    await storage.putObject(t1, "new", "application/gzip"); // what archiveSession writes
    assert.ok(s3.list("ws-a-files").includes(t1), "A's archive written to A's own bucket");
    Object.assign(process.env, { R2_BUCKET: "platform-files", R2_ENDPOINT: s3.url, R2_ACCESS_KEY_ID: PL_ID, R2_SECRET_ACCESS_KEY: PL_SECRET });
    assert.equal(await archive.archiveOrgs(), null, "a platform bucket: every workspace is archived");
    const t0 = storage.keys.transcript(A.orgId, "sess-old", new Date("2026-01-15T00:00:00Z"));
    await intoPlatform(t0, "old");
    const tb = storage.keys.transcript(B.orgId, "sess-b", new Date());
    await storage.putObject(tb, "b", "application/gzip");
    assert.ok(s3.list("platform-files").includes(tb) && !s3.list("ws-a-files").includes(tb), "B's archive: the platform's bucket");
    assert.deepEqual((await archive.archivedKeys(A.orgId)).map((o) => o.key).sort(), [t0, t1].sort(), "A's restore lists its own bucket and the platform's older archive");
    assert.deepEqual((await archive.archivedKeys()).map((o) => o.key).filter((k) => [t0, t1, tb].includes(k)).sort(), [t0, t1, tb].sort(), "a restore of all: every bucket");
    assert.equal((await storage.getObject(t0))?.toString(), "old", "a read-through of the older archive still finds it");
    ok("transcript archive: a workspace's archives go to its own bucket; no platform bucket: only workspaces with their own are archived; a restore lists both buckets");
  }

  // ---------- 8. a workspace's deletion ----------
  {
    const { deleteOrg } = await import("../src/tenancy.js");
    const mineOwn = [storage.keys.workspace(A.orgId, "fx", 7), storage.keys.research(A.orgId, "r1")];
    for (const k of mineOwn) await storage.putObject(k, "x", "application/octet-stream");
    const mineOld = storage.keys.workspace(A.orgId, "fx", 98);
    await intoPlatform(mineOld, "old");
    const ofA = (bucket: string) => s3.list(bucket).filter((k) => storage.orgOfKey(k) === A.orgId);
    assert.ok(ofA("ws-a-files").length >= 3 && ofA("platform-files").length >= 2, "A has objects in both buckets");
    const dry = await deleteOrg(A.orgId, { dryRun: true });
    assert.equal(dry.counts.objects, new Set([...ofA("ws-a-files"), ...ofA("platform-files")]).size, "the dry run counts both buckets' objects");
    // No platform bucket: the workspace's own bucket alone is enough to purge it, and the platform's older ones wait.
    for (const k of R2) delete process.env[k];
    const out = await deleteOrg(A.orgId);
    assert.equal(out.found, true);
    assert.deepEqual(ofA("ws-a-files"), [], "nothing of A left in its own bucket");
    Object.assign(process.env, { R2_BUCKET: "platform-files", R2_ENDPOINT: s3.url, R2_ACCESS_KEY_ID: PL_ID, R2_SECRET_ACCESS_KEY: PL_SECRET });
    // With both: the deletion takes both (B's own case: its objects are only the platform's).
    const bOwn = storage.keys.workspace(B.orgId, "fx", 9);
    await storage.putObject(bOwn, "b9", "application/octet-stream");
    // Give B a bucket of its own (A's was the only one): its earlier objects stay in the platform's.
    const recB = ra.workspaceRecords("fixture_storage", B.orgId, owner);
    await ra.asWriter({ by: "people", id: "owner" }, () => recB.create("fx_storage", "b-files", { title: "B files", data: { ...good, bucket: "ws-a-files" } }));
    W.forgetWorkspaceStorage();
    const bNew = storage.keys.workspace(B.orgId, "fx", 10);
    await storage.putObject(bNew, "b10", "application/octet-stream");
    const ofB = (bucket: string) => s3.list(bucket).filter((k) => storage.orgOfKey(k) === B.orgId);
    assert.ok(ofB("ws-a-files").includes(bNew) && ofB("platform-files").includes(bOwn), "B's new object in its own bucket, its older one in the platform's");
    await deleteOrg(B.orgId);
    assert.deepEqual(ofB("ws-a-files"), [], "nothing of B in its own bucket");
    assert.deepEqual(ofB("platform-files"), [], "nor in the platform's (its older objects too)");
    assert.ok(s3.list("platform-files").includes("agent-profiles/uploads/upl_x/0.part"), "the platform's own objects stay");
    for (const k of R2) delete process.env[k];
    ok("deletion: a workspace's objects go from its own bucket and the platform's; its own bucket alone is enough with no platform bucket; the platform's own objects stay");
  }

  // ---------- 6. no key anywhere ----------
  {
    for (const s of SECRETS) {
      assert.ok(!answers.some((a) => a.includes(s)), "no HTTP answer carries a secret");
      assert.ok(!printed.some((p) => p.includes(s)), "nothing printed carries a secret");
    }
    assert.ok(!answers.some((a) => a.includes(WS_ID)), "nor the access key id");
    ok("no key in any HTTP answer or anything the process printed");
  }
  console.log("workspace-storage-test: all passed");
} finally {
  await s3.close();
  cleanup();
}
process.exit(0);
