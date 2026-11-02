// Chain and sign (mold_v0-195; src/ledger.ts, sql/migrations/0034_ledger_chain.sql), offline: a build copy of the
// codebase with the fixture pack fixture_vulns plus one chained area (append_only, chain), both audit trails and
// audit.sign on, the API on an embedded database behind a stand-in Clerk.
//   npm run test:ledger
//
// 1. gen-packs: audit.sign and audit.checkpoint_minutes checked; a chained area needs append_only, workspace scope.
// 2. The canonical form and the hash agree in Node and in SQL (the trigger's), byte for byte; RFC 6962 Merkle roots.
// 3. The chain on a fixture: every trail entry and chained record has its hash, each linked to the one before;
//    verify says ok; a chained record is never changed or deleted (the record store, and the database itself).
// 4. Checkpoints: the scheduler's job signs each stream with new entries (not again before checkpoint_minutes unless
//    forced), each linked to the one before; verify checks every signature with the published public key.
// 5. Tamper: a changed entry is caught at its sequence number; a superuser who switches the triggers off and rewrites
//    the chain consistently (heads too) is caught by the checkpoint's Merkle root, and the next checkpoint is refused.
// 6. The key: unset, malformed, in a database setting or in the Key vault: nothing signed, and the key never printed.
// 7. Owners verify through GET /api/ledger/verify and the MCP tool verify_audit_trail; members are refused; tenant
//    isolation (a workspace never reads another's entries or checkpoints); /.well-known/ledger-keys.json.
// 8. audit.sign off: no route, no tool, no well-known keys, no checkpoint; the chain still computed.
// 9. Offline: scripts/operator/verify-ledger.ts (exit 0 / 1, --export) and the Python verifier on its bundle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const INNER = process.argv.includes("--inner");
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };
const SEED = () => Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32).toString("base64");

if (INNER) await inner();
else await outer();
process.exit(0);

function chainedPack(dir: string) {
  const f = path.join(dir, "packs", "fixture_vulns", "pack.json");
  const p = JSON.parse(readFileSync(f, "utf8"));
  p.record_areas.push({ name: "audit_evidence", label: "Evidence", role: "check", scope: "workspace", append_only: true, chain: true,
    fields: [{ name: "note", label: "Note", type: "text", max_length: 200 }] });
  writeFileSync(f, JSON.stringify(p, null, 2));
}

async function outer() {
  const TMP = mkdtempSync(path.join(tmpdir(), "ledger-"));
  try {
    const copyOf = (name: string, profile: Record<string, unknown> | null, edit?: (dir: string) => void) => {
      const copy = path.join(TMP, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules", "orchestrator/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(realpathSync(path.join(ROOT, nm)), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      cpSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_vulns"), path.join(copy, "packs", "fixture_vulns"), { recursive: true });
      edit?.(copy);
      if (profile) {
        const f = path.join(copy, "profile.json");
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...profile }, null, 2));
      }
      return { copy, gen: spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" }) };
    };
    // ---------- 1. gen-packs ----------
    for (const [bad, why] of [[{ sign: "yes" }, /audit: sign: true or false/], [{ checkpoint_minutes: 1 }, /checkpoint_minutes: a whole number of minutes, 5 to 1440/]] as const) {
      const b = copyOf(`bad-${n}-${String(why).length}`, { audit: bad });
      assert.notEqual(b.gen.status, 0, `refused: ${JSON.stringify(bad)}`);
      assert.match(b.gen.stderr, why);
    }
    const unchained = copyOf("bad-chain", null, (d) => { chainedPack(d); const f = path.join(d, "packs", "fixture_vulns", "pack.json"); const p = JSON.parse(readFileSync(f, "utf8")); p.record_areas.at(-1).append_only = false; writeFileSync(f, JSON.stringify(p)); });
    assert.notEqual(unchained.gen.status, 0, "chain without append_only is refused");
    assert.match(unchained.gen.stderr + unchained.gen.stdout, /chain needs append_only/);
    ok("gen-packs: audit.sign (true or false) and audit.checkpoint_minutes (5 to 1440) checked; a chained area needs append_only");

    const one = copyOf("one", { audit: { data: true, platform: true, sign: true, checkpoint_minutes: 5 } }, chainedPack);
    assert.equal(one.gen.status, 0, one.gen.stderr);
    const r = spawnSync(TSX, ["scripts/ledger-test.ts", "--inner"], { cwd: one.copy, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, APP_LEDGER_SIGNING_KEY: SEED(), LEDGER_TEST_TMP: TMP } });
    assert.equal(r.status, 0, "the checks inside the build copy");
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  console.log(`LEDGER TEST PASS (${n} checks here, the rest above)`);
}

async function inner() {
  const KEY = process.env.APP_LEDGER_SIGNING_KEY!;
  const { cleanup, startHttp, STAMP, TMP: WORLD } = await import("./lib/test-world.js");
  const pgliteDir = process.env.PGLITE_DIR!;
  let closed = false;
  void closed;
  try {
    const http = await startHttp();
    const { getDb } = await import("../src/db.js");
    const db = await getDb();
    const L = await import("../src/ledger.js");
    const audit = await import("../src/audit-trail.js");
    const { createApp } = await import("../src/http.js");
    const { createApiKey } = await import("../src/auth.js");
    const { withTenant } = await import("../src/tenant-scope.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const adminH = { authorization: `Bearer ${await http.adminToken("owner")}` };
    const q = L.runOn(db);
    const pub = (L.loadSigningKey() as { pub: Buffer }).pub;
    const ring = L.keyRing([pub]);

    // ---------- 2. the canonical form, Node and SQL ----------
    {
      assert.equal(L.canon(["a", null, "é", ""]), "1:a;~;2:é;0:;", "length-prefixed in bytes, null as ~");
      const parts = ["ledger/v1", "data", "7", null, "ünï;cøde:|~", ""];
      const [row] = await db.query<{ c: string; h: Uint8Array }>("SELECT app_ledger_canon($1::text[]) AS c, app_ledger_hash($2::bytea, $1::text[]) AS h", [parts, L.ZERO]);
      assert.equal(row!.c, L.canon(parts), "SQL and Node give the same canonical text");
      assert.equal(L.hex(row!.h), L.hex(L.entryHash(L.ZERO, parts)), "and the same hash");
      const leaves = [1, 2, 3, 4, 5].map((i) => Buffer.alloc(32, i));
      const h = (...b: Buffer[]) => createHash("sha256").update(Buffer.concat(b)).digest();
      const leaf = (x: Buffer) => h(Buffer.from([0]), x), node = (a: Buffer, b: Buffer) => h(Buffer.from([1]), a, b);
      assert.equal(L.hex(L.merkleRoot(leaves)), L.hex(node(node(node(leaf(leaves[0]!), leaf(leaves[1]!)), node(leaf(leaves[2]!), leaf(leaves[3]!))), leaf(leaves[4]!))), "RFC 6962: five leaves split 4 + 1");
      ok("the canonical form and the entry hash agree byte for byte in Node and in the database's trigger functions; RFC 6962 Merkle root");
    }

    // ---------- the world: two workspaces ----------
    const mkOrg = async (tag: string) => {
      const res = await http.req("POST", "/api/admin/onboarding/orgs", adminH, { name: `Ledger ${tag} ${STAMP}`, email: `owner-${tag}-${STAMP}@${tag}.example` });
      assert.equal(res.status, 201);
      const slug = (await res.json()).org.slug as string;
      const [o] = await db.query<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE slug = $1", [slug]);
      const org = { orgId: o!.id, name: o!.name, slug };
      return { org, id: o!.id, slug, owner: { authorization: `Bearer ${await http.signIn(org as any, "owner")}`, "x-pack-request": "1" },
        member: { authorization: `Bearer ${await http.signIn(org as any, "member")}`, "x-pack-request": "1" }, key: await createApiKey(org.orgId) };
    };
    const A = await mkOrg("a"), B = await mkOrg("b");
    let round = 0;
    const work = async (o: typeof A) => {
      round++;
      for (let i = 0; i < 3; i++) assert.equal((await http.req("POST", "/api/data/audit_evidence", o.owner, { key: `ev-${round}-${i}`, data: { note: `evidence ${round}.${i}` } })).status, 201);
      assert.equal((await http.req("GET", "/api/records/audit_evidence", o.owner)).status, 200);
      assert.equal((await http.req("GET", `/api/records/audit_evidence/ev-${round}-0`, o.owner)).status, 200);
      await audit.flushAudit();
    };
    await work(A); await work(B);
    const streamsOf = (o: typeof A) => ["data", "platform", "records:fixture_vulns/audit_evidence"].map((s) => ({ scope: o.id, stream: s }));

    // ---------- 3. the chain ----------
    {
      for (const t of ["audit_data_events", "audit_platform_events"]) {
        const [c] = await db.query<{ n: number; nohash: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE hash IS NULL OR prev_hash IS NULL)::int AS nohash FROM ${t}`);
        assert.ok(c!.n > 0 && c!.nohash === 0, `${t}: every entry chained (${c!.n})`);
      }
      const recs = await db.query<{ chained: boolean; chain_seq: number }>("SELECT chained, chain_seq FROM workspace_records WHERE org_id = $1 AND area = 'audit_evidence' ORDER BY chain_seq", [A.id]);
      assert.deepEqual(recs.map((x) => [x.chained, Number(x.chain_seq)]), [[true, 1], [true, 2], [true, 3]], "a chained area's records numbered 1, 2, 3 per workspace");
      for (const s of streamsOf(A)) {
        const rep = await L.verifyStream(q, s.scope, s.stream, ring);
        assert.ok(rep.ok && rep.entries > 0 && rep.checkpoints === 0, `${s.stream}: ${JSON.stringify(rep)}`);
      }
      // Append-only, through the store and in the database.
      assert.equal((await http.req("PUT", "/api/data/audit_evidence/ev-1-0", A.owner, { data: { note: "changed" } })).status, 409, "the store refuses a change");
      assert.equal((await http.req("DELETE", "/api/data/audit_evidence/ev-1-0", A.owner)).status, 409, "and a delete");
      await assert.rejects(db.query("UPDATE workspace_records SET title = 'x' WHERE org_id = $1 AND area = 'audit_evidence'", [A.id]), /append-only/, "the database refuses a change");
      await assert.rejects(db.query("DELETE FROM workspace_records WHERE org_id = $1 AND area = 'audit_evidence'", [A.id]), /append-only/, "and a removal");
      await assert.rejects(db.query("INSERT INTO workspace_records (org_id, pack, area, key) VALUES ($1, 'fixture_vulns', 'audit_evidence', 'sneak')", [A.id]), /chained/, "an unchained write to a chained area is refused");
      await assert.rejects(db.query("INSERT INTO audit_data_events (org_id, seq, actor_kind, action, target, channel) VALUES ($1, 99999, 'system', 'read', 'record', 'system')", [A.id]), /out of sequence/, "a trail entry out of sequence is refused");
      await assert.rejects(db.query("INSERT INTO audit_data_events (org_id, seq, actor_kind, action, target, channel, hash) SELECT $1, max(seq) + 1, 'system', 'read', 'record', 'system', '\\x00' FROM audit_data_events WHERE org_id = $1", [A.id]), /hash does not match/, "a writer's wrong hash is refused, never trusted");
      ok("the chain: every trail entry and chained record has its hash, linked in sequence; verify says ok; chained records are append-only in the store and the database; an unchained, out-of-sequence or wrongly hashed write is refused");
    }

    // ---------- 4. checkpoints ----------
    {
      const t1 = await L.checkpointTick(new Date());
      assert.ok(t1.ran && t1.checkpoints >= 6 && !t1.refused.length, JSON.stringify(t1));
      const again = await L.checkpointTick(new Date());
      assert.equal(again.checkpoints, 0, "nothing new: no checkpoint");
      await work(A);
      assert.equal((await L.checkpointTick(new Date())).checkpoints, 0, "new entries, but within checkpoint_minutes: not yet");
      const later = await L.checkpointTick(new Date(Date.now() + 6 * 60_000));
      assert.ok(later.checkpoints >= 3, `after checkpoint_minutes: signed again (${JSON.stringify(later)})`);
      for (const s of [...streamsOf(A), ...streamsOf(B)]) {
        const rep = await L.verifyStream(q, s.scope, s.stream, ring);
        assert.ok(rep.ok && rep.checkpoints >= 1 && rep.unchecked === 0, `${s.scope} ${s.stream}: ${JSON.stringify(rep)}`);
      }
      const cps = await L.readCheckpoints(q, A.id, "data");
      assert.ok(cps.length === 2 && cps[1]!.from_seq === cps[0]!.to_seq + 1 && cps[1]!.prev_checkpoint.equals(cps[0]!.checkpoint_hash), "checkpoint 2 starts where 1 ended and names its hash");
      await assert.rejects(db.query("UPDATE ledger_checkpoints SET key_id = 'x'"), /append-only/, "a checkpoint is never changed");
      ok(`checkpoints: the scheduler's job signs each stream with new entries (${t1.checkpoints} then ${later.checkpoints}), not again within checkpoint_minutes; each follows the one before; every signature verifies with the published key; append-only`);
    }

    // ---------- 7. owners verify; isolation; the published keys ----------
    {
      const v = await http.req("GET", "/api/ledger/verify", A.owner);
      assert.equal(v.status, 200);
      const body = await v.json() as any;
      assert.ok(body.ok && body.streams.length === 3 && body.streams.every((s: any) => s.scope === A.id && s.ok), JSON.stringify(body).slice(0, 400));
      assert.equal((await http.req("GET", "/api/ledger/verify", A.member)).status, 403, "a member does not verify");
      const keys = await (await http.req("GET", "/.well-known/ledger-keys.json", {})).json() as any;
      assert.equal(keys.keys.length, 1);
      assert.equal(keys.keys[0].kid, L.keyId(pub));
      assert.equal(Buffer.from(keys.keys[0].public_key, "base64").toString("hex"), pub.toString("hex"));
      assert.ok(!JSON.stringify(keys).includes(KEY) && !JSON.stringify(keys).includes(Buffer.from(KEY, "base64").toString("hex")), "the private key is never published");
      const c = new Client({ name: "ledger-test", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${http.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${A.key}` } } }));
      assert.ok((await c.listTools()).tools.some((t) => t.name === "verify_audit_trail"), "the owner's MCP lists verify_audit_trail");
      const t = await c.callTool({ name: "verify_audit_trail", arguments: { stream: "data" } }) as any;
      assert.ok(!t.isError && t.structuredContent.ok && t.structuredContent.streams.length === 1, JSON.stringify(t).slice(0, 300));
      await c.close();
      // Tenant isolation: as A, B's entries and checkpoints are not there at all.
      const seen = await withTenant(A.id, async () => (await getDb()).query<{ d: number; c: number; r: number }>(
        "/* tenant: isolation proof, on purpose */ SELECT (SELECT count(*) FROM audit_data_events WHERE org_id <> $1)::int AS d, (SELECT count(*) FROM ledger_checkpoints WHERE scope_id <> $1)::int AS c, (SELECT count(*) FROM workspace_records WHERE org_id <> $1 AND chained)::int AS r", [A.id]));
      assert.deepEqual(seen[0], { d: 0, c: 0, r: 0 }, "row-level security: A's tenant work sees none of B's entries, checkpoints or chained records");
      const asA = await withTenant(A.id, async () => L.verifyStream(L.runOn(await getDb()), B.id, "data", ring));
      assert.ok(asA.entries === 0 && asA.checkpoints === 0, "A verifying B's stream reads nothing of it");
      await assert.rejects(withTenant(A.id, async () => (await getDb()).query("SELECT 1 FROM ledger_heads")), /permission denied/, "the heads are out of tenant work's reach");
      ok("owners verify through GET /api/ledger/verify and the MCP tool verify_audit_trail (members refused); /.well-known/ledger-keys.json publishes the public key only; tenant isolation of entries, checkpoints, chained records and heads");
    }

    // ---------- 5. tamper ----------
    {
      // (a) A changed entry, the chain left as it was: caught at its own sequence number.
      await db.exec("ALTER TABLE audit_data_events DISABLE TRIGGER USER");
      await db.query("UPDATE audit_data_events SET area = 'tampered' WHERE org_id = $1 AND seq = 2", [A.id]);
      await db.exec("ALTER TABLE audit_data_events ENABLE TRIGGER USER");
      const a = await L.verifyStream(q, A.id, "data", ring);
      assert.ok(!a.ok && a.first_bad_seq === 1 && a.problems.some((p) => p.seq === 2 && /do not give its hash/.test(p.reason)), JSON.stringify(a.problems));
      // (b) A superuser rewrites B's entry 2 and recomputes the chain from there to the head, consistently (heads too).
      await db.exec("ALTER TABLE audit_data_events DISABLE TRIGGER USER");
      await db.query("UPDATE audit_data_events SET action = 'list', rows = 1 WHERE org_id = $1 AND seq = 2", [B.id]);
      let prev: Buffer | null = null, lastSeq = 0;
      for await (const e of L.readEntries(q, B.id, "data")) {
        const ph = prev ?? e.prev_hash, h = L.entryHash(ph, e.parts);
        await db.query("UPDATE audit_data_events SET prev_hash = $3, hash = $4 WHERE org_id = $1 AND seq = $2", [B.id, e.seq, ph, h]);
        prev = h; lastSeq = e.seq;
      }
      await db.query("UPDATE ledger_heads SET last_hash = $3, last_seq = $2 WHERE scope_id = $1 AND stream = 'data'", [B.id, lastSeq, prev]);
      await db.exec("ALTER TABLE audit_data_events ENABLE TRIGGER USER");
      const b = await L.verifyStream(q, B.id, "data", ring);
      assert.ok(!b.problems.some((p) => /hash|chain/.test(p.reason) && !/Merkle|signed/.test(p.reason)), `the rewritten chain is consistent: ${JSON.stringify(b.problems)}`);
      assert.ok(!b.ok && b.first_bad_seq === 1 && /Merkle root signed in checkpoint 1/.test(b.reason!), `the checkpoint catches it: ${JSON.stringify(b)}`);
      // The next checkpoint refuses to certify on top of it.
      await work(B);
      const t = await L.checkpointTick(new Date(Date.now() + 60 * 60_000), { force: true });
      assert.ok(t.refused.some((r) => r.scope === B.id && r.stream === "data" && /changed/.test(r.refused!)), JSON.stringify(t.refused));
      assert.equal((await L.readCheckpoints(q, B.id, "data")).length, 1, "no checkpoint written over a tampered chain");
      const v = await (await http.req("GET", "/api/ledger/verify?stream=data", B.owner)).json() as any;
      assert.ok(!v.ok && v.streams[0].first_bad_seq === 1 && /Merkle/.test(v.streams[0].reason), "the owners' endpoint says where and why");
      ok("tamper: a changed entry is caught at its sequence number; a consistent rewrite with the triggers off (heads too) leaves a valid-looking chain that the signed checkpoint's Merkle root catches; the next checkpoint is refused, not certified");
    }

    // ---------- 6. the key ----------
    {
      const said: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
      try {
        const keyForms = [KEY, Buffer.from(KEY, "base64").toString("hex")];
        L.resetKeyGuardForTest();
        const [{ d: dbName }] = await db.query<{ d: string }>("SELECT current_database() AS d");
        assert.match(KEY, /^[A-Za-z0-9+/=]+$/);
        await db.exec(`ALTER DATABASE "${dbName}" SET app.ledger_leak = '${KEY}'`); // a database setting: readable by any role of it
        const g = await L.checkpointTick(new Date(Date.now() + 120 * 60_000), { force: true });
        assert.ok(!g.ran && /database setting/.test(g.problem ?? ""), JSON.stringify(g));
        await db.exec(`ALTER DATABASE "${dbName}" RESET app.ledger_leak`);
        L.resetKeyGuardForTest();
        await db.query("INSERT INTO vault_providers (slug, mode, env_vars) VALUES ('ledger_leak', 'gateway', ARRAY['APP_LEDGER_SIGNING_KEY'])");
        const v = await L.checkpointTick(new Date(Date.now() + 120 * 60_000), { force: true });
        assert.ok(!v.ran && /Key vault/.test(v.problem ?? ""), JSON.stringify(v));
        await db.query("DELETE FROM vault_providers WHERE slug = 'ledger_leak'");
        L.resetKeyGuardForTest();
        const saved = process.env.APP_LEDGER_SIGNING_KEY!;
        delete process.env.APP_LEDGER_SIGNING_KEY;
        const u = await L.checkpointTick(new Date(Date.now() + 120 * 60_000), { force: true });
        assert.ok(!u.ran && /is not set/.test(u.problem ?? ""), JSON.stringify(u));
        process.env.APP_LEDGER_SIGNING_KEY = "not-a-key";
        assert.match((L.loadSigningKey() as { problem: string }).problem, /not an Ed25519 key/);
        process.env.APP_LEDGER_SIGNING_KEY = saved;
        assert.ok(!said.some((s) => keyForms.some((f) => s.includes(f))) && !JSON.stringify([g, v, u]).includes(KEY), "the key is never printed");
      } finally { console.error = orig; }
      ok("the key: in a database setting or the Key vault, unset or malformed: nothing is signed and the reason names the problem, never the key");
    }

    // ---------- 8. audit.sign off ----------
    {
      audit.setAuditForTest({ data: true, platform: true, sign: false });
      const server = createApp().listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      assert.equal((await fetch(`${base}/api/ledger/verify`, { headers: A.owner })).status, 404, "off: no verify route");
      assert.equal((await fetch(`${base}/.well-known/ledger-keys.json`)).status, 404, "off: no published keys");
      const c = new Client({ name: "ledger-off", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${A.key}` } } }));
      assert.ok(!(await c.listTools()).tools.some((t) => t.name === "verify_audit_trail"), "off: no MCP tool");
      await c.close();
      const before = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_checkpoints"))[0]!.n);
      assert.equal((await L.checkpointTick(new Date(Date.now() + 240 * 60_000), { force: true })).ran, false, "off: the job does nothing");
      assert.equal(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_checkpoints"))[0]!.n), before);
      await new Promise((r) => server.close(r));
      audit.setAuditForTest(null);
      ok("audit.sign off: no verify route, no published keys, no MCP tool, no checkpoint (the database still chains)");
    }

    // ---------- 9. offline: the operator's CLI and Python ----------
    await http.close();
    await db.close().catch(() => {});
    closed = true;
    const keysFile = path.join(WORLD, "ledger-keys.json");
    writeFileSync(keysFile, JSON.stringify({ keys: L.publishedKeys() }));
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--import=tsx", "scripts/operator/verify-ledger.ts", ...args],
      { encoding: "utf8", env: { ...process.env, APP_LEDGER_SIGNING_KEY: "", PGLITE_DIR: pgliteDir, DATABASE_URL: "" } });
    const goodBundle = path.join(WORLD, "good.json"), badBundle = path.join(WORLD, "bad.json");
    // Workspace A's chained area and platform trail are untouched; its data trail and B's were tampered with above.
    const okRun = cli("--scope", A.slug, "--stream", "records:fixture_vulns/audit_evidence", "--keys", keysFile, "--export", goodBundle, "--json");
    assert.equal(okRun.status, 0, okRun.stderr + okRun.stdout);
    assert.ok(JSON.parse(okRun.stdout).ok);
    const badRun = cli("--scope", B.slug, "--stream", "data", "--public-key", pub.toString("hex"), "--export", badBundle);
    assert.equal(badRun.status, 1, badRun.stderr + badRun.stdout);
    assert.match(badRun.stdout, /first bad: 1: .*Merkle root/);
    const wrongKey = cli("--scope", A.slug, "--stream", "records:fixture_vulns/audit_evidence", "--public-key", L.hex((L.loadSigningKey({ APP_LEDGER_SIGNING_KEY: SEED() } as NodeJS.ProcessEnv) as { pub: Buffer }).pub));
    assert.equal(wrongKey.status, 1, "another key: the signatures do not verify");
    assert.equal(cli("--scope", A.slug).status, 2, "no public key: could not run");
    for (const out of [okRun.stdout, okRun.stderr, badRun.stdout, badRun.stderr]) assert.ok(!out.includes(KEY), "the CLI never prints the key");
    ok("offline CLI (verify-ledger): exit 0 on an untouched stream, 1 with the first bad sequence on the rewritten one, 1 with another key, 2 without a public key; --export bundles");
    const py = (...args: string[]) => spawnSync("python3", ["-I", "scripts/operator/verify_ledger.py", ...args], { encoding: "utf8" });
    const pg = py(goodBundle, "--public-key", pub.toString("base64"), "--json");
    assert.equal(pg.status, 0, pg.stderr + pg.stdout);
    assert.ok(JSON.parse(pg.stdout).ok);
    const pb = py(badBundle, "--keys", keysFile);
    assert.equal(pb.status, 1, pb.stderr + pb.stdout);
    assert.match(pb.stdout, /first bad: 1: .*Merkle root/);
    const pw = py(goodBundle, "--public-key", L.hex((L.loadSigningKey({ APP_LEDGER_SIGNING_KEY: SEED() } as NodeJS.ProcessEnv) as { pub: Buffer }).pub));
    assert.equal(pw.status, 1, "Python: another key does not verify");
    ok(`Python (${JSON.parse(pg.stdout).library}) verifies the exported bundle from the public key alone, finds the rewritten window at sequence 1, and rejects another key`);
  } finally {
    cleanup();
  }
}
