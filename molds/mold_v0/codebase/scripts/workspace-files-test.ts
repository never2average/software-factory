// The workspace store's retention and file viewer (mold_v0-056; src/workspace-retention.ts, src/workspace-files.ts,
// src/workspace-store-policy.ts), offline: an embedded database, a local object store (OCTILLION_STORAGE_DIR), runs of
// a fixture program that writes what it is told (scripts/fixtures/runs/files.mjs), the HTTP server behind a fake Clerk.
//   npm run test:workspace-files
//
// 1. The rules alone: which versions expire (latest always kept, keep_last, keep_days, protected ones), the ceiling, the
//    paths the viewer never shows, the line diff, and pack.json's workspace_store.
// 2. Retention keeps exactly the right versions: the latest, the newest keep_last, those within keep_days, the version a
//    run's results reference (also one its unchanged write-back was based on), the one a report file is in, the one a
//    store lease checked out; deletes the rest (rows and objects); a deleted version's run leaves no version behind
//    (never an older one); a second sweep deletes nothing; once a day (scheduler_marks).
// 3. Two workspaces in the sweep: B's references never keep A's versions nor A's B's; a row of A naming B's object
//    never removes it; orphans are removed under the swept store's own prefix only.
// 4. The viewer over HTTP: versions, a version's tree, a text file, a download (attachment, nosniff, sandbox), a diff
//    of versions and of a file; refuses traversal, hidden and secret paths, a file holding a credential, huge files,
//    roles that may not read the pack's areas, a version retention removed; two workspaces see only their own.
// 5. A locked vault: the sweep refuses (nothing deleted, the day not marked) and the viewer serves no file (503).
// 6. Zero packs: nothing is mounted at /api/workspace-files and the scheduler has nothing to sweep.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.OCTILLION_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const VAULT = process.env.OCTILLION_VAULT_KEY!;
const PACK = "fixture_files";
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, defineTool, validatePack, z } = await import("../src/pack-api.js");
  const { compileDeclarations, PackJsonError } = await import("../src/pack-manifest.js");
  const harness = await import("../src/run-harness.js");
  const rec = await import("../src/record-areas.js");
  const store = await import("../src/workspace-store.js");
  const policy = await import("../src/workspace-store-policy.js");
  const retention = await import("../src/workspace-retention.js");
  const files = await import("../src/workspace-files.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");

  // ---------- 1. the rules alone ----------
  {
    const now = new Date("2026-10-22T12:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const vs = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ version: v, committed_at: ago(v <= 5 ? 30 : v === 6 ? 3 : 0) }));
    const p = (keep_last: number | null, keep_days: number | null, max_versions = 100, max_days = 365) => ({ keep_last, keep_days, max_versions, max_days, source: "pack" as const });
    assert.deepEqual(policy.expiredVersions(vs, p(2, 7), new Set(), now), [5, 4, 3, 2, 1], "keep_last 2 or within 7 days: 6, 7, 8 kept");
    assert.deepEqual(policy.expiredVersions(vs, p(2, null), new Set(), now), [6, 5, 4, 3, 2, 1], "keep_last alone");
    assert.deepEqual(policy.expiredVersions(vs, p(null, 7), new Set([2]), now), [5, 4, 3, 1], "keep_days alone, version 2 protected");
    assert.deepEqual(policy.expiredVersions(vs, p(1, 1), new Set(), new Date(now.getTime() + 90 * 86_400_000)), [7, 6, 5, 4, 3, 2, 1], "the latest is always kept, however old");
    assert.deepEqual(policy.expiredVersions([{ version: 3, committed_at: ago(900) }], p(1, 1), new Set(), now), [], "a lone version is the latest");
    // The ceiling is a hard bound: keep_days 7 alone would keep all of a busy week; at most max_versions stay (bar protected).
    const busy = Array.from({ length: 12 }, (_, i) => ({ version: i + 1, committed_at: ago(1) }));
    assert.deepEqual(policy.expiredVersions(busy, p(null, 7, 5), new Set([2]), now), [7, 6, 5, 4, 3, 1], "past the newest 5, only the protected version 2 stays");
    assert.deepEqual(policy.expiredVersions(vs, p(8, null, 100, 10), new Set(), now), [5, 4, 3, 2, 1], "keep_last 8, but none older than the ceiling's 10 days");
    // The ceiling: no pack keeps more than it; a pack that declares nothing gets it.
    process.env.OCTILLION_WORKSPACE_RETENTION_MAX_VERSIONS = "5"; process.env.OCTILLION_WORKSPACE_RETENTION_MAX_DAYS = "30";
    assert.deepEqual(policy.retentionPolicy({ keep_last: 50, keep_days: 400 }), { keep_last: 5, keep_days: 30, max_versions: 5, max_days: 30, source: "pack" }, "capped by the ceiling");
    assert.deepEqual(policy.retentionPolicy({ keep_last: 3 }), { keep_last: 3, keep_days: null, max_versions: 5, max_days: 30, source: "pack" });
    assert.deepEqual(policy.retentionPolicy(undefined), { keep_last: 5, keep_days: 30, max_versions: 5, max_days: 30, source: "platform" }, "nothing declared: the ceiling");
    delete process.env.OCTILLION_WORKSPACE_RETENTION_MAX_VERSIONS; delete process.env.OCTILLION_WORKSPACE_RETENTION_MAX_DAYS;
    assert.deepEqual(policy.retentionPolicy(null), { keep_last: 100, keep_days: 365, max_versions: 100, max_days: 365, source: "platform" }, "the default ceiling");
    // Paths never shown.
    const rules = policy.pathRules({ workspaceStore: { secret_paths: ["private/**", "*.sqlite"] }, agentJobKinds: [{ agent: { strip: ["vendor/cache/**"] } }], credentials: [{ deliver_as: { file: "access.cfg" } }, { deliver_as: { env: "X_TOKEN" } }] });
    const cases: [string, "hidden" | "secret" | null][] = [
      ["notes.txt", null], ["report.md", null], ["src/app/main.ts", null], ["docs/keyboard.md", null],
      [".env", "hidden"], ["config/.env.local", "hidden"], [".git/config", "hidden"], [".ssh/id_rsa", "hidden"], ["a/.npmrc", "hidden"],
      ["keys/server.pem", "secret"], ["deploy/id_ed25519", "secret"], ["x/credentials.json", "secret"], ["gcp/service-account.json", "secret"],
      ["prod.env", "secret"], ["infra/terraform.tfstate", "secret"], ["My_Secrets/a.txt", "secret"], ["SECRET.txt", "secret"],
      ["private/x.txt", "secret"], ["db/data.sqlite", "secret"], ["data.sqlite", "secret"], ["vendor/cache/blob", "secret"], ["access.cfg", "secret"], ["nested/access.cfg", "secret"], ["x/ACCESS.CFG", "secret"], ["home/aws/config", "secret"], ["k/kube/config", "secret"],
    ];
    for (const [p0, want] of cases) assert.equal(policy.pathRefusal(p0, rules), want, `${p0}: ${want ?? "shown"}`);
    // The line diff: applying its hunks to the old text gives the new one.
    const apply = (a: string, hunks: { from_start: number; lines: { op: string; text: string }[] }[]) => {
      const lines = a === "" ? [] : a.replace(/\n$/, "").split("\n"); const out: string[] = []; let i = 0;
      for (const h of hunks) { while (i < h.from_start - 1) out.push(lines[i++]!); for (const l of h.lines) { if (l.op === " ") { assert.equal(lines[i], l.text); out.push(lines[i++]!); } else if (l.op === "-") { assert.equal(lines[i], l.text); i++; } else out.push(l.text); } }
      while (i < lines.length) out.push(lines[i++]!);
      return out.join("\n");
    };
    const pairs: [string, string][] = [["a\nb\nc\n", "a\nB\nc\n"], ["", "x\ny\n"], ["x\ny\n", ""], [Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 60 }, (_, i) => (i % 17 === 3 ? `L${i}` : `l${i}`)).filter((_, i) => i !== 40).join("\n") + "\nend"],
      ["same\n", "same\n"], ["1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n", "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n"]];
    for (const [a, b] of pairs) assert.equal(apply(a, files.lineDiff(a, b)!), b.replace(/\n$/, ""), `diff ${JSON.stringify(a.slice(0, 12))} → ${JSON.stringify(b.slice(0, 12))}`);
    assert.deepEqual(files.lineDiff("same\n", "same\n"), []);
    assert.equal(files.lineDiff(Array.from({ length: 9000 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 9000 }, (_, i) => `b${i}`).join("\n")), null, "too many edits: no line diff");
    assert.equal(files.lineDiff("x", Array.from({ length: 30_000 }, () => "y").join("\n")), null, "too many lines: no line diff");
    // pack.json's workspace_store.
    const base = { id: "decl_files", name: "Decl", version: "1", job_kinds: [{ name: "writer", runner: "workspace-harness", entry: "w.mjs", workspace: true }] };
    const ok = compileDeclarations({ ...base, workspace_store: { retention: { keep_last: 10, keep_days: 30 }, secret_paths: ["private/**"] } });
    assert.deepEqual(ok.workspaceStore, { retention: { keep_last: 10, keep_days: 30 }, secret_paths: ["private/**"] });
    for (const bad of [{ retention: {} }, { retention: { keep_last: 0 } }, { retention: { keep_days: 1.5 } }, { secret_paths: ["../x"] }, { secret_paths: ["/etc/*"] }, { retention: { keep_last: 1 }, extra: true }])
      assert.throws(() => compileDeclarations({ ...base, workspace_store: bad }), PackJsonError, `refused: ${JSON.stringify(bad)}`);
    assert.throws(() => validatePack({ id: "no_store", workspaceStore: { retention: { keep_last: 1 } } } as never), /declare a job kind with workspace: true/, "a store's settings need a workspace kind");
    // A files tab (the console's Files page in a build with tabs): only for a pack with a store, for the roles that may
    // read every one of the pack's areas.
    const { checkViews, tabRoles, viewsOf } = await import("../src/metric-spec.js");
    const area = (name: string, read?: string[]) => ({ name, label: name, role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }], ...(read ? { permissions: { read } } : {}) });
    const withStore = { id: "tab_store", definition: { recordAreas: [area("ts_a"), area("ts_b", ["member", "owner"])], jobKinds: [{ name: "go", runner: "workspace-harness", entry: "go.mjs", workspace: true }], tabs: [{ id: "files", kind: "files" }] } };
    const noStore = { id: "tab_none", definition: { jobKinds: [{ name: "go", runner: "workspace-harness", entry: "go.mjs" }], tabs: [{ id: "files", kind: "files" }] } };
    const views = viewsOf([withStore, noStore] as never);
    assert.deepEqual(checkViews(views).filter((x) => x.includes("workspace store")), ["pack tab_none: tab files: the pack has no workspace store (no kind with workspace: true), so it has no files to show"]);
    assert.deepEqual(tabRoles({ ...views.tabs.find((t) => t.pack === "tab_store")!, pack: "tab_store" } as never, views), ["member", "owner"], "the roles that may read every one of the pack's areas");
    console.log("✓ the rules: latest always kept, keep_last or keep_days, protected versions, the ceiling; hidden and secret paths; the line diff; pack.json workspace_store");
  }

  // ---------- the world: two workspaces, one pack with a workspace store ----------
  const A = (await createOrg(`Files A ${STAMP}`)).org, B = (await createOrg(`Files B ${STAMP}`)).org;
  const kind = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: "workspace-harness", workspace: true, entry: "files.mjs", lease_seconds: 15, max_attempts: 1, ...extra });
  const fixture = definePack({
    id: PACK,
    recordAreas: [
      { name: "ff_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "ff_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }], permissions: { read: ["member", "billing", "owner"] } },
    ],
    jobKinds: [kind("write"), kind("audit", { report: { path: "report.md" } })] as never,
    credentials: [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { file: "access.cfg" } }],
    workspaceStore: { retention: { keep_last: 2, keep_days: 7 }, secret_paths: ["private/**", "*.sqlite"] },
    tools: [defineTool({ name: "fixture_files_run", description: "Start a run (test).", inputSchema: { kind: z.string(), write: z.record(z.string(), z.unknown()).optional(), remove: z.array(z.string()).optional(), results: z.array(z.unknown()).optional() },
      handler: async (_ws, { kind: k, write, remove, results }, { runs: r }) => r.start(k, { scope: { write: write ?? {}, remove: remove ?? [], results: results ?? [] } }) })],
  });
  setPacksForTest([{ manifest: { id: PACK, name: "Fixture files", version: "1", entry: "index.ts", migrations: null, words: {}, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
  await rec.putPlatform(null, "ff_checks", "c1", { title: "A check", data: { summary: "x" } });
  const ca = await connect(A), cb = await connect(B);
  const client = await harness.localRunnerClient("w-files");
  const run = async (c: typeof ca, k: string, scope: { write?: Record<string, unknown>; remove?: string[]; results?: unknown[] } = {}) => {
    const s = await c.call("fixture_files_run", { kind: k, ...scope });
    assert.ok(!s.isError, s.content[0]?.text);
    const claim = (await client.claim([`${PACK}/${k}`]))!;
    const view = await harness.runWorkspaceHarness(client, claim, { allowSameUser: true, egress: "off" });
    assert.equal(view?.status, "succeeded", JSON.stringify(view));
    return claim.run.id;
  };
  const C1 = { check: { area: "ff_checks", key: "c1" }, status: "pass" };
  const versionsOf = async (orgId: number) => (await db.query<{ version: number }>(
    "SELECT version FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'committed' ORDER BY version", [orgId, PACK])).map((r) => Number(r.version));
  const rowOf = async (orgId: number, v: number) => (await db.query<{ id: number; object_key: string; run_id: string }>(
    "SELECT id, object_key, run_id FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND version = $3", [orgId, PACK, v]))[0];
  const objectPath = (key: string) => path.join(process.env.OCTILLION_STORAGE_DIR!, key);
  const age = (orgId: number, versions: number[], days: number) => db.query(
    `UPDATE workspace_snapshots SET committed_at = now() - make_interval(days => $4) WHERE org_id = $1 AND store = $2 AND version = ANY ($3::int[])`, [orgId, PACK, versions, days]);
  const http = await startHttp();
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  try {
    // A: eight versions. v1 plain; v2 an audit with its report; v3 a run with results; between v4 and v5 a run that
    // changes nothing but has results (it left v4); v5..v8 plain. B: its own history, results on its v1 only.
    const runsA: Record<string, string> = {};
    runsA.v1 = await run(ca, "write", { write: { "notes.txt": "A one\n", "data/table.csv": "a,b\n1,2\n" } });
    runsA.v2 = await run(ca, "audit", { write: { "notes.txt": "A two\n", "report.md": "# A's report\n" } });
    runsA.v3 = await run(ca, "write", { write: { "notes.txt": "A three\n" }, results: [C1] });
    runsA.v4 = await run(ca, "write", { write: { "notes.txt": "A four\n" } });
    runsA.same = await run(ca, "write", { results: [C1] });
    runsA.v5 = await run(ca, "write", { write: { "notes.txt": "A five\n" } });
    runsA.v6 = await run(ca, "write", { write: { "notes.txt": "A six\n" } });
    runsA.v7 = await run(ca, "write", { write: { "notes.txt": "A seven\n" } });
    runsA.v8 = await run(ca, "write", {
      write: { "notes.txt": "A eight\n<script>alert('x')</script>\n", ".env": "SECRET=1\n", ".git/config": "[core]\n", "keys/server.pem": "-----BEGIN PRIVATE KEY-----\n", "private/plan.txt": "hidden\n",
        "db/data.sqlite": "x", "access.cfg": "token-file\n", "bin/blob.bin": { base64: Buffer.from([0, 1, 2, 255, 0]).toString("base64") }, "big.txt": "y".repeat(5000), "dir/a/deep.txt": "deep\n" },
    });
    assert.deepEqual(await versionsOf(A.orgId), [1, 2, 3, 4, 5, 6, 7, 8]);
    const runsB: Record<string, string> = {};
    runsB.v1 = await run(cb, "write", { write: { "notes.txt": "B one\n" }, results: [C1] });
    for (let i = 2; i <= 8; i++) runsB[`v${i}`] = await run(cb, "write", { write: { "notes.txt": `B ${i}\n` } });
    assert.deepEqual(await versionsOf(B.orgId), [1, 2, 3, 4, 5, 6, 7, 8]);
    // Ages: v1-v5 a month old, v6 three days old, v7 and v8 today (both workspaces).
    for (const o of [A.orgId, B.orgId]) { await age(o, [1, 2, 3, 4, 5], 30); await age(o, [6], 3); }
    const objectsA = Object.fromEntries(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async (v) => [v, (await rowOf(A.orgId, v))!.object_key] as const)));
    const objectsB = Object.fromEntries(await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async (v) => [v, (await rowOf(B.orgId, v))!.object_key] as const)));

    // ---------- 4a. the viewer before retention (version 1 still there) ----------
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A), viewerA = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
    const api = (tok: string, p: string, method = "GET") => http.req(method, `/api/workspace-files${p}`, bearer(tok));
    const json = async (tok: string, p: string) => { const r = await api(tok, p); return { status: r.status, body: await r.json() as any, headers: r.headers }; };
    {
      const v1 = await json(ownerA, `/${PACK}/versions/1/file?path=notes.txt`);
      assert.equal(v1.status, 200); assert.equal(v1.body.text, "A one\n", "version 1, before retention");
    }

    // ---------- 2. retention keeps exactly the right versions ----------
    {
      // A store lease (a run holding the store) that checked out v5 keeps it.
      await db.query("INSERT INTO workspace_leases (org_id, store, run_id, expires_at, base_version) VALUES ($1, $2, 'run_fake_holder', now() + interval '1 hour', 5)", [A.orgId, PACK]);
      // A planted orphan in each workspace's prefix, and one of A's rows that will expire pointed at B's object.
      const orphanA = `workspaces/org-${A.orgId}/${PACK}/999999.wse`, orphanB = `workspaces/org-${B.orgId}/${PACK}/999998.wse`;
      for (const k of [orphanA, orphanB]) { mkdirSync(path.dirname(objectPath(k)), { recursive: true }); writeFileSync(objectPath(k), "orphan"); }
      const a1 = (await rowOf(A.orgId, 1))!;
      await db.query("UPDATE workspace_snapshots SET object_key = $2 WHERE id = $1", [a1.id, objectsB[1]]);
      const refsA = await retention.referencedVersions(db, A.orgId, PACK);
      assert.deepEqual([...refsA].sort(), [2, 3, 4], "A's references: the report's version, the results' version, the unchanged run's base");
      assert.deepEqual([...(await retention.referencedVersions(db, B.orgId, PACK))], [1], "B's: its own v1 only");

      const r = await retention.sweepStore(A.orgId, PACK);
      assert.deepEqual(r.deleted, [1], "A: only v1 expires (2, 3, 4 referenced, 5 checked out, 6 within 7 days, 7 and 8 the newest two)");
      assert.deepEqual(await versionsOf(A.orgId), [2, 3, 4, 5, 6, 7, 8]);
      assert.ok(existsSync(objectPath(objectsB[1]!)), "a row of A naming B's object never removes B's object");
      assert.ok(existsSync(objectPath(objectsA[1]!)) === false, "A's v1 object went as an orphan of A's own prefix");
      assert.ok(!existsSync(objectPath(orphanA)), "A's orphan is removed");
      assert.ok(existsSync(objectPath(orphanB)), "B's orphan is not touched by A's sweep");
      assert.deepEqual(await versionsOf(B.orgId), [1, 2, 3, 4, 5, 6, 7, 8], "B is untouched by A's sweep");
      // The lease goes; v5 is no longer held and expires at the next sweep. A second sweep after that deletes nothing.
      await db.query("DELETE FROM workspace_leases WHERE org_id = $1 AND run_id = 'run_fake_holder'", [A.orgId]);
      const r2 = await retention.sweepStore(A.orgId, PACK);
      assert.deepEqual(r2.deleted, [5], "v5 expires once no run holds it");
      assert.deepEqual(await versionsOf(A.orgId), [2, 3, 4, 6, 7, 8], "A keeps exactly 2, 3, 4 (referenced), 6 (7 days), 7, 8 (newest two)");
      for (const v of [1, 5]) assert.ok(!existsSync(objectPath(objectsA[v]!)), `A's v${v} object is removed`);
      for (const v of [2, 3, 4, 6, 7, 8]) assert.ok(existsSync(objectPath(objectsA[v]!)), `A's v${v} object is kept`);
      const r3 = await retention.sweepStore(A.orgId, PACK);
      assert.deepEqual([r3.deleted, r3.objects_removed], [[], 0], "idempotent: a second sweep deletes nothing");
      // The deleted versions' runs left no version (never an older one); the kept ones' runs still read theirs.
      assert.equal(await store.snapshotOfRun(db, A.orgId, PACK, runsA.v1!), null, "v1's run: no version");
      assert.equal(await store.snapshotOfRun(db, A.orgId, PACK, runsA.v5!), null, "v5's run: no version");
      assert.equal((await store.snapshotOfRun(db, A.orgId, PACK, runsA.same!))?.version, 4, "the unchanged run with results still reads v4");
      const rep = await ca.call(`${PACK}_get_audit_report`, { run_id: runsA.v2 });
      assert.ok(!rep.isError && rep.content[0]!.text.includes("# A's report"), `the report still reads: ${rep.content[0]?.text}`);
      // The whole sweep: B's turn (B's references are its own: its v1 stays; A's 2, 3, 4 do not keep B's).
      const all = await retention.retentionSweep(new Date(), { force: true });
      assert.equal(all.ran, true); assert.equal(all.failed, 0);
      assert.deepEqual(await versionsOf(B.orgId), [1, 6, 7, 8], "B keeps exactly 1 (its results), 6, 7, 8: A's references never keep B's 2, 3, 4");
      assert.ok(!existsSync(objectPath(orphanB)), "B's orphan goes in B's own sweep");
      assert.ok(existsSync(objectPath(objectsB[1]!)), "B's v1 object is kept");
      assert.deepEqual(await versionsOf(A.orgId), [2, 3, 4, 6, 7, 8], "A is unchanged by the whole sweep");
      // Once a day: marked, a second call the same day does nothing; forced, it finds nothing.
      const again = await retention.retentionSweep(new Date());
      assert.deepEqual([again.ran, again.reason], [false, "already ran today"]);
      const forced = await retention.retentionSweep(new Date(), { force: true });
      assert.deepEqual([forced.ran, forced.deleted, forced.objects_removed], [true, 0, 0], "idempotent across workspaces");
      // The scheduler's tick carries it (src/schedules.ts), and a server's loop starts for it.
      const { schedulerTick } = await import("../src/schedules.js");
      const tick = await schedulerTick();
      assert.deepEqual([tick.retention && "reason" in tick.retention ? tick.retention.reason : null], ["already ran today"], "the scheduler's tick runs the sweep");
      assert.equal(retention.retentionWired(), true);
      console.log("✓ retention keeps exactly the latest, the newest keep_last, those within keep_days, versions results and reports reference, the version a lease checked out; deletes the rest with their objects, idempotently, once a day");
      console.log("✓ two workspaces in the sweep: references are per workspace; a row naming another workspace's object never removes it; orphans only under the swept store's prefix");
    }

    // ---------- 4. the viewer over HTTP ----------
    {
      // Stores, versions, tree.
      const stores = await json(ownerA, "/");
      assert.deepEqual(stores.body.stores.map((s: { store: string }) => s.store), [PACK]);
      assert.deepEqual(stores.body.stores[0].retention, { keep_last: 2, keep_days: 7, max_versions: 100, max_days: 365, source: "pack" });
      const vs = await json(memberA, `/${PACK}/versions`);
      assert.equal(vs.status, 200);
      assert.deepEqual(vs.body.versions.map((v: { version: number }) => v.version), [8, 7, 6, 4, 3, 2], "A's versions, newest first");
      assert.equal(vs.body.versions[0].run_id, runsA.v8); assert.equal(vs.body.versions[0].run_kind, "write");
      assert.ok(vs.body.versions[0].bytes > 5000 && vs.body.versions[0].files === 12);
      const tree = await json(ownerA, `/${PACK}/versions/8/files`);
      assert.deepEqual(tree.body.files.map((f: { path: string }) => f.path), ["big.txt", "bin/blob.bin", "data/table.csv", "dir/a/deep.txt", "notes.txt", "report.md"]);
      assert.equal(tree.body.hidden, 6, "six files are never listed");
      assert.deepEqual(tree.body.files[4], { path: "notes.txt", size: Buffer.byteLength("A eight\n<script>alert('x')</script>\n") }, "a listing names a file and its size, never its hash");
      const raw = JSON.stringify(tree.body);
      for (const s of [".env", ".git", "server.pem", "private/", "data.sqlite", "access.cfg"]) assert.ok(!raw.includes(s), `${s} is not named`);
      // A text file: as JSON text, never markup.
      const notes = await json(ownerA, `/${PACK}/versions/8/file?path=notes.txt`);
      assert.equal(notes.status, 200);
      assert.match(notes.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(notes.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual([notes.body.text, notes.body.binary, notes.body.sha256], ["A eight\n<script>alert('x')</script>\n", false, sha("A eight\n<script>alert('x')</script>\n")]);
      const blob = await json(ownerA, `/${PACK}/versions/8/file?path=bin/blob.bin`);
      assert.deepEqual([blob.status, blob.body.binary, blob.body.text], [200, true, null], "a binary file is not shown as text");
      assert.equal((await json(ownerA, `/${PACK}/versions/3/file?path=notes.txt`)).body.text, "A three\n", "an older version's file");
      // A download: an attachment no browser renders.
      const dl = await api(ownerA, `/${PACK}/versions/8/download?path=notes.txt`);
      assert.equal(dl.status, 200);
      assert.equal(dl.headers.get("content-type"), "application/octet-stream");
      assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="notes.txt"/);
      assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
      assert.match(dl.headers.get("content-security-policy") ?? "", /sandbox/);
      assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha("A eight\n<script>alert('x')</script>\n"));
      // Traversal and paths that are not plain.
      for (const p of ["../../etc/passwd", "/etc/passwd", "a/../notes.txt", "./notes.txt", "a//b", "a\\b", "%2e%2e/notes.txt"]) {
        const r = await api(ownerA, `/${PACK}/versions/8/file?path=${p.startsWith("%") ? p : encodeURIComponent(p)}`);
        assert.equal(r.status, 400, `refused: ${p}`);
      }
      assert.equal((await api(ownerA, `/${PACK}/versions/8/file?path=notes.txt&path=report.md`)).status, 400, "one path only");
      assert.equal((await api(ownerA, `/${PACK}/versions/8/file`)).status, 400, "a path is required");
      assert.equal((await api(ownerA, `/${PACK}/versions/8/file?path=nope.txt`)).status, 404);
      // Hidden and secret paths: refused by their name, whether or not the version has them.
      for (const p of [".env", ".git/config", "keys/server.pem", "private/plan.txt", "db/data.sqlite", "access.cfg", "private/none.txt"]) {
        for (const what of ["file", "download"]) assert.equal((await api(ownerA, `/${PACK}/versions/8/${what}?path=${encodeURIComponent(p)}`)).status, 403, `${what} refused: ${p}`);
        assert.equal((await api(ownerA, `/${PACK}/diff?from=7&to=8&path=${encodeURIComponent(p)}`)).status, 403, `diff refused: ${p}`);
      }
      // Huge files: past the view limit, past the download limit.
      process.env.OCTILLION_WORKSPACE_VIEW_MAX_BYTES = "1000"; process.env.OCTILLION_WORKSPACE_DOWNLOAD_MAX_BYTES = "2000"; process.env.OCTILLION_WORKSPACE_DIFF_MAX_BYTES = "1000";
      assert.equal((await api(ownerA, `/${PACK}/versions/8/file?path=big.txt`)).status, 413, "too large to show");
      assert.equal((await api(ownerA, `/${PACK}/versions/8/download?path=big.txt`)).status, 413, "too large to download");
      delete process.env.OCTILLION_WORKSPACE_DOWNLOAD_MAX_BYTES;
      assert.equal((await api(ownerA, `/${PACK}/versions/8/download?path=big.txt`)).status, 200, "downloaded under the default limit");
      assert.equal((await api(ownerA, `/${PACK}/diff?from=7&to=8&path=big.txt`)).status, 413, "too large to compare");
      delete process.env.OCTILLION_WORKSPACE_VIEW_MAX_BYTES; delete process.env.OCTILLION_WORKSPACE_DIFF_MAX_BYTES;
      // Diffs: which files changed (none of the never-shown ones named), and a file's lines.
      const d = await json(ownerA, `/${PACK}/diff?from=7&to=8`);
      assert.equal(d.status, 200);
      assert.deepEqual(d.body.changed.map((f: { path: string }) => f.path), ["notes.txt"]);
      assert.deepEqual(d.body.added.map((f: { path: string }) => f.path), ["big.txt", "bin/blob.bin", "dir/a/deep.txt"]);
      assert.deepEqual(d.body.removed, []);
      assert.ok(!JSON.stringify(d.body).includes(".env") && !JSON.stringify(d.body).includes("access.cfg"));
      const fd = await json(ownerA, `/${PACK}/diff?from=7&to=8&path=notes.txt`);
      assert.deepEqual(fd.body.hunks, [{ from_start: 1, from_lines: 1, to_start: 1, to_lines: 2, lines: [{ op: "-", text: "A seven" }, { op: "+", text: "A eight" }, { op: "+", text: "<script>alert('x')</script>" }] }]);
      assert.equal((await api(ownerA, `/${PACK}/diff?from=7&to=8&path=bin/blob.bin`)).status, 415, "no line diff of a binary file");
      assert.equal((await api(ownerA, `/${PACK}/diff?from=7&to=8&path=nothing.txt`)).status, 404);
      // Lines that differ only in their endings: the file is changed, its lines are the same, and the diff says why.
      assert.equal(files.lineDiff("a\r\nb\r\n", "a\nb")?.length, 0);
      // A file holding one of the workspace's credential values: never shown, downloaded or compared.
      const { setCredential } = await import("../src/credentials.js");
      const TOKEN = `tok-${STAMP}-0123456789abcdef`;
      await setCredential(A.orgId, "test", { pack: PACK, name: "api_token", value: TOKEN });
      await run(ca, "write", { write: { "logs/run.log": `called with ${Buffer.from(TOKEN).toString("base64")}\n`, [`logs/${TOKEN}.txt`]: "named after it\n", "notes.txt": "A nine\n" } });
      const t9 = await json(ownerA, `/${PACK}/versions/9/files`);
      assert.ok(!JSON.stringify(t9.body).includes(TOKEN) && t9.body.hidden === 7, "a path holding a credential is not listed");
      assert.equal((await api(ownerA, `/${PACK}/versions/9/file?path=${encodeURIComponent(`logs/${TOKEN}.txt`)}`)).status, 403, "nor served");
      assert.ok(!JSON.stringify((await json(ownerA, `/${PACK}/diff?from=8&to=9`)).body).includes(TOKEN), "nor named in a diff");
      for (const what of ["file", "download"]) {
        const r = await api(ownerA, `/${PACK}/versions/9/${what}?path=logs/run.log`);
        assert.equal(r.status, 403, `${what}: a file holding a credential (base64) is refused`);
        assert.ok(!(await r.text()).includes(TOKEN));
      }
      assert.equal((await api(ownerA, `/${PACK}/diff?from=8&to=9&path=logs/run.log`)).status, 403);
      assert.equal((await api(ownerA, `/${PACK}/versions/9/file?path=notes.txt`)).status, 200, "the rest of the version is shown");
      // Roles: a viewer may not read the pack's applications, so not its files either.
      assert.deepEqual((await json(viewerA, "/")).body.stores, [], "a viewer is offered no store");
      for (const p of [`/${PACK}/versions`, `/${PACK}/versions/8/files`, `/${PACK}/versions/8/file?path=notes.txt`, `/${PACK}/versions/8/download?path=notes.txt`, `/${PACK}/diff?from=7&to=8`])
        assert.equal((await api(viewerA, p)).status, 403, `viewer refused: ${p}`);
      assert.equal((await api(ownerA, "/other_pack/versions")).status, 404, "an unknown store");
      assert.equal((await api(ownerA, `/${PACK}/versions/1/files`)).status, 404, "a version retention removed");
      assert.equal((await api(ownerA, `/${PACK}/versions/0/files`)).status, 400);
      assert.equal((await api(ownerA, `/${PACK}/versions/x/files`)).status, 400);
      assert.equal((await api(ownerA, `/${PACK}/versions`, "DELETE")).status, 405, "read only");
      assert.equal((await http.req("GET", `/api/workspace-files/${PACK}/versions`)).status, 401, "signed in only");
      // Two workspaces: B sees its own versions and files, never A's.
      const vb = await json(ownerB, `/${PACK}/versions`);
      assert.deepEqual(vb.body.versions.map((v: { version: number }) => v.version), [8, 7, 6, 1]);
      assert.equal((await json(ownerB, `/${PACK}/versions/8/file?path=notes.txt`)).body.text, "B 8\n", "B's v8 is B's");
      assert.equal((await api(ownerB, `/${PACK}/versions/3/files`)).status, 404, "A has a v3; B does not see it");
      assert.equal((await api(ownerB, `/${PACK}/versions/8/file?path=big.txt`)).status, 404, "A's v8 files are not B's");
      assert.equal((await api(ownerB, `/${PACK}/versions/9/files`)).status, 404, "A's v9 is not B's");
      const bd = await json(ownerB, `/${PACK}/diff?from=1&to=8&path=notes.txt`);
      assert.deepEqual(bd.body.hunks[0].lines, [{ op: "-", text: "B one" }, { op: "+", text: "B 8" }]);
      console.log("✓ the viewer: versions, tree, text, download (attachment, nosniff, sandbox), diffs; refuses traversal, hidden and secret paths, a file holding a credential, huge files, roles that may not read the pack's areas, expired versions; B sees B's only");
    }

    // ---------- 5. the vault locked ----------
    {
      await age(A.orgId, [6, 7], 30);
      delete process.env.OCTILLION_VAULT_KEY;
      const r = await retention.retentionSweep(new Date(Date.now() + 86_400_000));
      assert.equal(r.ran, false); assert.match(r.reason ?? "", /key vault is locked/);
      await assert.rejects(retention.sweepStore(A.orgId, PACK), /key vault is locked/);
      assert.deepEqual(await versionsOf(A.orgId), [2, 3, 4, 6, 7, 8, 9], "nothing deleted while locked");
      const [mark] = await db.query<{ day: string | Date }>("SELECT day FROM scheduler_marks WHERE name = 'workspace_retention'");
      assert.ok(new Date(mark!.day).toISOString().slice(0, 10) < new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), "the day is not marked: tried again at the next tick");
      assert.equal((await api(ownerA, `/${PACK}/versions`)).status, 200, "versions are listed");
      for (const p of [`/${PACK}/versions/8/files`, `/${PACK}/diff?from=7&to=8`, `/${PACK}/versions/8/file?path=notes.txt`, `/${PACK}/versions/8/download?path=notes.txt`, `/${PACK}/diff?from=7&to=8&path=notes.txt`])
        assert.equal((await api(ownerA, p)).status, 503, `no file while the vault is locked: ${p}`);
      process.env.OCTILLION_VAULT_KEY = VAULT;
      const after = await retention.retentionSweep(new Date(Date.now() + 86_400_000));
      assert.equal(after.ran, true);
      assert.deepEqual(await versionsOf(A.orgId), [2, 3, 4, 8, 9], "unlocked, the next tick sweeps: v6 (now a month old) and v7 (no longer among the newest two) expire");
      assert.equal((await api(ownerA, `/${PACK}/versions/8/file?path=notes.txt`)).status, 200);
      console.log("✓ the vault locked: the sweep refuses (nothing deleted, the day not marked) and the viewer serves no file (503); unlocked, the next tick sweeps");
    }

    // ---------- 6. zero packs ----------
    {
      setPacksForTest([]);
      assert.equal(files.workspaceFileAppRouter().stack.length, 0, "nothing is mounted at /api/workspace-files");
      assert.equal(retention.retentionWired(), false, "nothing to sweep: the scheduler's loop does not start for it");
      const { schedulerTick } = await import("../src/schedules.js");
      assert.equal("retention" in (await schedulerTick()), false, "the tick does not sweep");
      console.log("✓ zero packs: nothing mounted, nothing swept");
    }
    // Row-level security still holds across the catalog.
    const { rlsCatalogProblems } = await import("../src/rls.js");
    assert.deepEqual(await rlsCatalogProblems(db), []);
    void withTenant;
  } finally {
    await ca.close(); await cb.close();
    await http.close();
  }
  await db.close();
  console.log("WORKSPACE FILES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
