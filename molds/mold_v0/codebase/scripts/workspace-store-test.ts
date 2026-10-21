// The workspace store (mold_v0-033; src/workspace-store.ts, src/workspace-bundle.ts), offline: an embedded database, a
// local object store (OCTILLION_STORAGE_DIR), fixture runs (scripts/fixtures/runs/notes.mjs).
//   npm run test:workspace-store
//
// 1. A run checks its workspace out before it runs and writes it back when its program and validation exit 0: version
//    1, 2, ... with a sha256 manifest; the stored object is sealed with the workspace's data key (no plain text at rest).
// 2. A failed validation, a failed program or a planted symbolic link leaves the version where it was (the stage is
//    discarded, its object removed).
// 3. One writer per workspace store: a second run of the same workspace waits in the queue while the first holds the
//    lease; another workspace's run is not held up; a lapsed lease is taken over and the old runner cannot write.
// 4. Two workspaces: A's runs only ever see A's snapshots. Even a row pointed at B's object does not open (B's key and
//    the object's binding to its own row); a runner names a run, never a workspace; the tenant role sees its own rows.
// 5. Bundles: unpacking refuses paths outside the workspace and content that does not match its sha256.
// 6. Over HTTP (/api/worker/runs/:id/workspace) with the lease token; deleting a workspace removes its snapshots.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, z } = await import("../src/pack-api.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const store = await import("../src/workspace-store.js");
  const bundle = await import("../src/workspace-bundle.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const A = (await createOrg(`Store A ${STAMP}`)).org, B = (await createOrg(`Store B ${STAMP}`)).org;

  const kind = (name: string, extra: Record<string, unknown>) => ({ name, runner: "workspace-harness", workspace: true, lease_seconds: 15, entry: "notes.mjs", validator: "accept.mjs", ...extra });
  const fixture = definePack({
    id: "fixture_store",
    jobKinds: [kind("notes", {}), kind("notes_rejected", { validator: "reject.mjs" }), kind("notes_failing", { entry: "fail.mjs" }), kind("notes_stateless", { workspace: false }), kind("notes_same", { entry: "noop.mjs", validator: undefined })] as never,
    tools: [defineTool({ name: "fixture_note_run", description: "Start a notes run (test).", inputSchema: { kind: z.string(), text: z.string().optional(), link: z.string().optional() },
      handler: async (_ws, { kind: k, text, link }, { runs: r }) => r.start(k, { targets: { text, link } }) })],
  });
  setPacksForTest([{ manifest: { id: "fixture_store", name: "Fixture store", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, k: string, input: Record<string, unknown> = {}) => {
    const r = await c.call("fixture_note_run", { kind: k, ...input });
    assert.ok(!r.isError, r.content[0]?.text);
    return r.structuredContent as { id: string };
  };
  const client = await harness.localRunnerClient("w-store");
  const runNext = async (kinds = ["fixture_store/notes"]) => {
    const c = await client.claim(kinds);
    assert.ok(c, "a run to claim");
    return { claim: c!, view: await harness.runWorkspaceHarness(client, c!, { allowSameUser: true, egress: "off" }) };
  };
  const latest = (o: number) => store.latestSnapshot(db, o, "fixture_store");
  const seen = async (runId: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'seen' ORDER BY id DESC LIMIT 1", [runId]))[0]?.data;
  const http = await startHttp();
  try {
    // ---------- 1. checkout, run, validate, write back ----------
    {
      await start(ca, "notes", { text: `A1 ${STAMP}` });
      const r1 = await runNext();
      assert.equal(r1.view?.status, "succeeded", JSON.stringify(r1.view));
      assert.deepEqual((await seen(r1.claim.run.id)).notes, null, "a workspace's first run starts empty");
      const v1 = (await latest(A.orgId))!;
      assert.equal(v1.version, 1, "version 1");
      assert.deepEqual(Object.keys(v1.manifest).sort(), ["evidence/" + r1.claim.run.id + ".txt", "notes.txt"].sort(), "the manifest names every file");
      assert.equal(v1.manifest["notes.txt"]!.sha256, createHash("sha256").update(`A1 ${STAMP}\n`).digest("hex"), "with its sha256");
      assert.equal(v1.manifest_sha256, bundle.manifestSha256(v1.manifest));
      const raw = readFileSync(path.join(process.env.OCTILLION_STORAGE_DIR!, v1.object_key));
      assert.ok(v1.object_key.startsWith(`workspaces/org-${A.orgId}/fixture_store/`), "stored under the workspace's own prefix");
      assert.ok(raw.subarray(0, 4).toString() === "WSE1" && !raw.includes(Buffer.from(`A1 ${STAMP}`)), "sealed: no plain text at rest");
      const { openBytes } = await import("../src/orgcrypto.js");
      await assert.rejects(openBytes(B.orgId, raw, `workspace-snapshot:v1:org-${A.orgId}:fixture_store:${v1.id}:${v1.manifest_sha256}`), "B's data key cannot open A's snapshot");
      assert.ok((await openBytes(A.orgId, raw, `workspace-snapshot:v1:org-${A.orgId}:fixture_store:${v1.id}:${v1.manifest_sha256}`)).length > 0, "A's key opens it");
      await assert.rejects(openBytes(A.orgId, raw, `workspace-snapshot:v1:org-${A.orgId}:fixture_store:${v1.id + 1}:${v1.manifest_sha256}`), "bound to its own row: not under another id");

      await start(ca, "notes", { text: `A2 ${STAMP}` });
      const r2 = await runNext();
      assert.equal(r2.view?.status, "succeeded");
      assert.equal((await seen(r2.claim.run.id)).notes, `A1 ${STAMP}\n`, "the next run checked out version 1 before it ran");
      assert.equal((await latest(A.orgId))!.version, 2, "version 2");
      const ev = await db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [r2.claim.run.id]);
      assert.deepEqual(ev.find((e) => e.type === "workspace_checkout")?.data.version, 1);
      assert.deepEqual(ev.find((e) => e.type === "workspace_written")?.data, { version: 2, unchanged: false });
      console.log("✓ checkout before the run, write-back after a valid run: versions 1 and 2, sha256 manifest, sealed with the workspace key, bound to its row");
    }

    // ---------- 2. nothing is written back unless the run and its validation succeed ----------
    {
      const before = (await latest(A.orgId))!;
      const objects = async () => (await (await import("../src/storage.js")).objectStore().list(`workspaces/org-${A.orgId}/`)).length;
      const n0 = await objects();
      await start(ca, "notes_rejected", { text: "never" });
      const bad = await runNext(["fixture_store/notes_rejected"]);
      assert.deepEqual([bad.view?.status, bad.view?.error_kind], ["failed", "validation"], "validation exited 1: the run failed");
      await start(ca, "notes_failing");
      const failing = await runNext(["fixture_store/notes_failing"]);
      assert.deepEqual([failing.view?.status, failing.view?.error_kind], ["failed", "run"]);
      await start(ca, "notes", { text: "linked", link: "/etc/hostname" });
      const linked = await runNext();
      assert.equal(linked.view?.status, "failed", "a planted symbolic link fails the write-back");
      assert.match(linked.view!.error!, /symbolic link/);
      const after = (await latest(A.orgId))!;
      assert.deepEqual([after.version, after.manifest_sha256], [before.version, before.manifest_sha256], "the version is unchanged");
      assert.equal(await objects(), n0, "no object was left behind");
      assert.equal((await db.query("SELECT 1 FROM workspace_snapshots WHERE org_id = $1 AND status = 'staged'", [A.orgId])).length, 0, "no stage is left");
      // A run that changes nothing: no new version, and its staged object is removed (the review's orphan).
      await start(ca, "notes_same");
      const same = await runNext(["fixture_store/notes_same"]);
      assert.equal(same.view?.status, "succeeded");
      assert.equal((await latest(A.orgId))!.version, before.version, "an unchanged workspace makes no version");
      assert.equal(await objects(), n0, "and leaves no object behind");
      // A run that does not use the store leaves it alone too.
      await start(ca, "notes_stateless", { text: "stateless" });
      assert.equal((await runNext(["fixture_store/notes_stateless"])).view?.status, "succeeded");
      assert.equal((await latest(A.orgId))!.version, before.version);
      console.log("✓ a failed validation, a failed program or a planted link leaves the version unchanged (stage discarded, object removed)");
    }

    // ---------- 3. one writer per workspace store ----------
    {
      const r3 = await start(ca, "notes", { text: "A3" }), r4 = await start(ca, "notes", { text: "A4" });
      const c3 = (await client.claim(["fixture_store/notes"]))!;
      assert.equal(c3.run.id, r3.id);
      assert.equal(await client.claim(["fixture_store/notes"]), null, "A's second run waits: the store's lease is held");
      const rb = await start(cb, "notes", { text: `B1 ${STAMP}` });
      const cB = (await client.claim(["fixture_store/notes"]))!;
      assert.equal(cB.run.id, rb.id, "B's run is not held up by A's lease");
      assert.equal((await harness.runWorkspaceHarness(client, cB, { allowSameUser: true, egress: "off" }))?.status, "succeeded");
      assert.equal((await latest(B.orgId))!.version, 1);
      assert.equal((await runs.getRun(A.orgId, r4.id))?.status, "queued");
      // The first run's runner dies: its lease lapses, the waiting run takes the store, the old runner cannot write.
      const dir = mkdtempSync(path.join(TMP, "dead-"));
      await client.checkout(c3.run.id, c3.lease_token, path.join(dir, "ws"));
      await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [r3.id]);
      await db.query("UPDATE workspace_leases SET expires_at = now() - interval '1 second' WHERE run_id = $1", [r3.id]);
      const c4 = (await client.claim(["fixture_store/notes"]))!;
      assert.ok([r3.id, r4.id].includes(c4.run.id), "after the lapse a run of A's takes the store");
      writeFileSync(path.join(dir, "ws", "notes.txt"), "stale writer\n");
      await assert.rejects(client.stage(c3.run.id, c3.lease_token, path.join(dir, "ws")), /lease is not yours/, "the old runner cannot stage");
      await assert.rejects(runs.completeRun(r3.id, c3.lease_token, { outcome: "succeeded", results: [] }), /lease is not yours/, "nor complete");
      assert.equal((await harness.runWorkspaceHarness(client, c4, { allowSameUser: true, egress: "off" }))?.status, "succeeded");
      for (let i = 0; i < 2; i++) { const c = await client.claim(["fixture_store/notes"]); if (c) await harness.runWorkspaceHarness(client, c, { allowSameUser: true, egress: "off" }); }
      assert.deepEqual([(await runs.getRun(A.orgId, r3.id))?.status, (await runs.getRun(A.orgId, r4.id))?.status], ["succeeded", "succeeded"], "both runs finish, one after the other");
      const notes = (await seen(r4.id)).notes as string;
      assert.ok(!notes.includes("stale writer"), "the lapsed runner's write never landed");
      assert.equal((await latest(A.orgId))!.version, 4, "versions 3 and 4, one per run");
      // The review's case: one workspace's many waiting runs never hide another workspace's run.
      const held = await start(ca, "notes", { text: "holder" });
      const ch = (await client.claim(["fixture_store/notes"]))!;
      assert.equal(ch.run.id, held.id);
      process.env.OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE = "40";
      const waiting = [];
      for (let i = 0; i < 25; i++) waiting.push((await start(ca, "notes", { text: `w${i}` })).id);
      delete process.env.OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE;
      const other = await start(cb, "notes", { text: "B behind A's queue" });
      const cOther = (await client.claim())!;
      assert.equal(cOther?.run.id, other.id, "B's run is claimed past 25 of A's waiting runs");
      await runs.completeRun(cOther.run.id, cOther.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      await runs.completeRun(ch.run.id, ch.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = ANY ($1::text[]) AND status = 'queued'", [waiting]);
      console.log("✓ one writer per workspace store: a second run waits for the lease; another workspace's run does not; a lapsed runner cannot write");
    }

    // ---------- 4. two workspaces: A's run never reads B's snapshot ----------
    {
      await start(ca, "notes", { text: "A5" });
      const ra = await runNext();
      const s = await seen(ra.claim.run.id);
      assert.ok(s.notes.includes("A1") && !s.notes.includes("B1"), "A's run sees A's notes, not B's");
      // Point A's latest row at B's object: it does not open (B's key, and bound to B's row and manifest).
      const a = (await latest(A.orgId))!, b = (await latest(B.orgId))!;
      await db.query("UPDATE workspace_snapshots SET object_key = $2 WHERE id = $1", [a.id, b.object_key]);
      await start(ca, "notes", { text: "A6" });
      const hijack = await runNext();
      assert.equal(hijack.view?.status, "queued", "the checkout fails (an infrastructure failure, retried)");
      assert.match(hijack.view!.error!, /prepare: .*(unable to authenticate|Unsupported state)/i, `B's object does not open as A's: ${hijack.view!.error}`);
      assert.equal(await seen(hijack.claim.run.id), undefined, "the program never ran");
      await db.query("UPDATE workspace_snapshots SET object_key = $2 WHERE id = $1", [a.id, a.object_key]);
      assert.equal((await runNext()).view?.status, "succeeded", "with its own object back, A's run goes on");
      // Same manifest, B's object copied over A's: still refused (bound to B's org, row and key).
      const objects = process.env.OCTILLION_STORAGE_DIR!;
      const aBefore = readFileSync(path.join(objects, (await latest(A.orgId))!.object_key));
      writeFileSync(path.join(objects, (await latest(A.orgId))!.object_key), readFileSync(path.join(objects, b.object_key)));
      await start(ca, "notes", { text: "A7" });
      assert.equal((await runNext()).view?.status, "queued", "B's bytes under A's key path do not open either");
      writeFileSync(path.join(objects, (await latest(A.orgId))!.object_key), aBefore);
      assert.equal((await runNext()).view?.status, "succeeded");
      // The tenant role reads only its own snapshot rows and leases, and writes none.
      const rows = await withTenant(A.orgId, () => db.query<{ org_id: number }>("/* tenant: test */ SELECT DISTINCT org_id FROM workspace_snapshots"));
      assert.deepEqual(rows.map((r) => r.org_id), [A.orgId]);
      await assert.rejects(withTenant(A.orgId, () => db.query("UPDATE workspace_snapshots SET object_key = 'x' WHERE org_id = $1", [A.orgId])), (e: { code?: string }) => e.code === "42501");
      // A runner can only name a run; the run row decides the workspace.
      const rbb = await start(cb, "notes", { text: "B2" });
      const cbb = (await client.claim(["fixture_store/notes"]))!;
      assert.equal(cbb.run.id, rbb.id);
      const peek = mkdtempSync(path.join(TMP, "peek-"));
      await client.checkout(cbb.run.id, cbb.lease_token, path.join(peek, "b"));
      assert.ok(!readFileSync(path.join(peek, "b", "notes.txt"), "utf8").includes("A1"), "B's checkout holds B's files only");
      await assert.rejects(client.checkout(ra.claim.run.id, cbb.lease_token, path.join(peek, "a")), /lease is not yours/, "B's lease token does not open A's run");
      await runs.completeRun(cbb.run.id, cbb.lease_token, { outcome: "failed", error_kind: "run", error: "test" });
      const { rlsCatalogProblems, rlsProbe } = await import("../src/rls.js");
      assert.deepEqual(await rlsCatalogProblems(db), []);
      const probe = await rlsProbe(db);
      assert.deepEqual(probe.problems, []);
      console.log(`✓ two workspaces: A's runs see A's snapshots only; B's object never opens as A's (key and binding); runners name runs, not workspaces; RLS probe ${probe.checked} checks`);
    }

    // ---------- 5. bundles ----------
    {
      const dir = mkdtempSync(path.join(TMP, "bundle-"));
      mkdirSync(path.join(dir, "src", "a"), { recursive: true });
      writeFileSync(path.join(dir, "src", "a", "x.txt"), "x");
      writeFileSync(path.join(dir, "top.json"), "{}");
      const packed = bundle.packBundle(dir);
      const into = path.join(dir, "..", `unpacked-${STAMP}`);
      bundle.unpackBundle(packed.bundle, into, packed.manifest_sha256);
      assert.equal(readFileSync(path.join(into, "src", "a", "x.txt"), "utf8"), "x");
      assert.throws(() => bundle.unpackBundle(packed.bundle, into), /empty directory/, "only into an empty directory");
      const forge = (files: { path: string; body: string; sha?: string }[]) => {
        const header = Buffer.from(JSON.stringify({ files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.body), sha256: f.sha ?? createHash("sha256").update(f.body).digest("hex") })) }));
        const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
        return gzipSync(Buffer.concat([Buffer.from("WSB1\n"), len, header, ...files.map((f) => Buffer.from(f.body))]));
      };
      for (const p of ["../escape.txt", "/etc/passwd", "a/../../x", "a\\b", "./x", "a//b"])
        assert.throws(() => bundle.unpackBundle(forge([{ path: p, body: "x" }]), path.join(TMP, `u-${Math.random()}`)), /not a path inside the workspace/, `refused: ${p}`);
      assert.throws(() => bundle.unpackBundle(forge([{ path: "x.txt", body: "x", sha: "0".repeat(64) }]), path.join(TMP, "u-sha")), /does not match its sha256/);
      assert.ok(!existsSync(path.join(TMP, "escape.txt")) && !existsSync(path.join(TMP, "u-sha", "x.txt")), "nothing written");
      const linkDir = mkdtempSync(path.join(TMP, "link-"));
      symlinkSync("/etc/hostname", path.join(linkDir, "l"));
      assert.throws(() => bundle.packBundle(linkDir), /symbolic link/, "packing never follows a link");
      console.log("✓ bundles: paths outside the workspace and content that does not match its sha256 are refused; links are never followed");
    }

    // ---------- 6. over HTTP; deleting a workspace ----------
    {
      const W = process.env.OCTILLION_WORKER_TOKEN!;
      const viaHttp = harness.httpRunnerClient(http.base, W, "w-http");
      await start(ca, "notes", { text: "A-http" });
      const c = (await viaHttp.claim(["fixture_store/notes"]))!;
      const get = (lease: string) => http.req("GET", `/api/worker/runs/${c.run.id}/workspace`, { authorization: `Bearer ${W}`, "x-run-lease": lease });
      assert.equal((await get("orl_forged")).status, 409, "the lease token is required");
      const v = await harness.runWorkspaceHarness(viaHttp, c, { allowSameUser: true, egress: "off" });
      assert.equal(v?.status, "succeeded", `over HTTP: ${JSON.stringify(v)}`);
      assert.ok((await seen(c.run.id)).notes.includes("A1"), "checked out over HTTP");
      const lastA = (await latest(A.orgId))!;
      assert.ok(lastA.run_id === c.run.id, "written back over HTTP");
      const { deleteOrg } = await import("../src/tenancy.js");
      const bKeys = (await db.query<{ object_key: string }>("SELECT object_key FROM workspace_snapshots WHERE org_id = $1 AND status = 'committed'", [B.orgId])).map((r) => r.object_key);
      assert.ok(bKeys.length > 0);
      await deleteOrg(B.orgId);
      assert.equal((await db.query("SELECT 1 FROM workspace_snapshots WHERE org_id = $1", [B.orgId])).length, 0, "its snapshot rows are gone");
      assert.ok(bKeys.every((k) => !existsSync(path.join(process.env.OCTILLION_STORAGE_DIR!, k))), "and its objects");
      assert.ok(existsSync(path.join(process.env.OCTILLION_STORAGE_DIR!, lastA.object_key)), "A's are untouched");
      console.log("✓ over HTTP with the lease token: checkout and write-back; deleting a workspace removes its snapshots and objects");
    }
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }
  await db.close();
  console.log("WORKSPACE STORE TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
