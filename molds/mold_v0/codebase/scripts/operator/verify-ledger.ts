// READ-ONLY. Verifies the app's hash-chained audit trails and chained record areas against their signed checkpoints (mold_v0-195): never writes, never reads the signing key.
//   npm run operator:verify-ledger [-- --json] [-- --scope <workspace id or slug>] [-- --stream data|platform|records:<pack>/<area>]
//                                  [-- --public-key <hex|base64|PEM>]... [-- --keys <ledger-keys.json file or URL>] [-- --export <file>]
//   python3 .claude/scripts/provision.py <app_id> --operator verify-ledger [--dry-run|--yes] [-- --json]   (the factory)
//
// Offline from the app: it reads the rows with its own connection (DATABASE_URL, the app's role; without one, the local
// PGlite database) in ONE transaction made READ ONLY before anything else, and checks them here, in this process:
// every entry's hash recomputed from its values and linked to the one before, every checkpoint's Ed25519 signature with
// the PUBLIC key (by default the app's own /.well-known/ledger-keys.json at WORKSPACE_OPS_URL; or --public-key / --keys,
// e.g. a copy kept away from the app), and each checkpoint's Merkle root recomputed from the entries it signed. So a
// stretch rewritten consistently by someone with the database's superuser (triggers off) is still caught: the rewritten
// entries no longer give the root that was signed. --export writes everything it read as a bundle that
// scripts/operator/verify_ledger.py checks again in Python.
// Exit 0: every stream verifies. 1: a stream does not (the first bad sequence number and why). 2: could not run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const values = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
const known = new Set(["--json", "--scope", "--stream", "--public-key", "--keys", "--export"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i]!)) { console.error(`verify-ledger: unknown argument ${argv[i]} (it takes --json, --scope, --stream, --public-key, --keys, --export; it never writes)`); process.exit(2); }
  if (argv[i] !== "--json") i++;
}
const json = flag("--json");

// The signing key is never needed here, and never read: a verifier holds public keys only.
delete process.env.APP_LEDGER_SIGNING_KEY;
const url = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgres://verify-ledger-reads-through-its-own-read-only-transaction.invalid:1/none";
process.env.APP_MIGRATE_ON_BOOT = "off";

type Raw = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }> };
async function connect(): Promise<{ conn: Raw; close: () => Promise<void> }> {
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, application_name: "operator:verify-ledger (read-only)" });
    client.on("error", () => {});
    await client.connect();
    return { conn: client as unknown as Raw, close: () => client.end() };
  }
  const dir = process.env.PGLITE_DIR ?? path.resolve(import.meta.dirname, "..", "..", ".pglite");
  if (!existsSync(dir)) throw Object.assign(new Error("no database: DATABASE_URL is not set and there is no local PGlite database"), { code: 2 });
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  return { conn: lite as unknown as Raw, close: () => lite.close() };
}

async function publicKeys(L: typeof import("../../src/ledger.js")): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const v of values("--public-key")) {
    const k = L.parsePublicKey(v);
    if (!k) throw Object.assign(new Error("--public-key is not an Ed25519 public key (32 bytes as hex or base64, or a PEM)"), { code: 2 });
    out.push(k);
  }
  const sources = values("--keys");
  if (!out.length && !sources.length && process.env.WORKSPACE_OPS_URL) sources.push(`${process.env.WORKSPACE_OPS_URL.replace(/\/+$/, "")}/.well-known/ledger-keys.json`);
  for (const s of sources) {
    const text = /^https?:\/\//.test(s) ? await (await fetch(s)).text() : readFileSync(s, "utf8");
    let doc: { keys?: { public_key?: string; public_key_hex?: string }[] };
    try { doc = JSON.parse(text); } catch { throw Object.assign(new Error(`${s}: not a ledger-keys.json`), { code: 2 }); }
    for (const k of doc.keys ?? []) { const b = L.parsePublicKey(k.public_key_hex ?? k.public_key ?? ""); if (b) out.push(b); }
  }
  if (!out.length) throw Object.assign(new Error("no public key to check the signatures with: pass --public-key or --keys (the app's /.well-known/ledger-keys.json)"), { code: 2 });
  return out;
}

let db: Awaited<ReturnType<typeof connect>> | undefined;
try {
  const L = await import("../../src/ledger.js");
  const pubs = await publicKeys(L);
  db = await connect();
  await db.conn.query("BEGIN");
  await db.conn.query("SET TRANSACTION READ ONLY");
  const ro = (await db.conn.query("SHOW transaction_read_only")).rows[0];
  if (String(Object.values(ro ?? {})[0]) !== "on") throw new Error("the transaction did not become read-only: nothing read");
  const q: import("../../src/ledger.js").RunQuery = async (sql, params) => (await db!.conn.query(sql, params)).rows;
  let scope: number | null = null;
  const sc = values("--scope")[0];
  if (sc !== undefined) {
    const [o] = await q("SELECT id FROM organizations WHERE slug = $1 OR id::text = $1", [sc]);
    if (!o) throw Object.assign(new Error(`no workspace ${sc}`), { code: 2 });
    scope = Number(o.id);
  }
  const only = values("--stream")[0] ?? null;
  const streams = (await q(`/* tenant: the operator's verifier, every stream */ SELECT DISTINCT scope_id::text AS scope, stream FROM (
      SELECT scope_id, stream FROM ledger_heads UNION SELECT scope_id, stream FROM ledger_checkpoints) s ORDER BY 1, 2`, []))
    .map((r) => ({ scope: Number(r.scope), stream: String(r.stream) }))
    .filter((s) => (scope === null || s.scope === scope) && (!only || s.stream === only));
  const ring = L.keyRing(pubs);
  const reports = [];
  for (const s of streams) reports.push(await L.verifyStream(q, s.scope, s.stream, ring));
  if (values("--export")[0]) {
    const bundle = { format: "ledger-bundle/v1", keys: pubs.map((p) => ({ kid: L.keyId(p), public_key_hex: L.hex(p) })), streams: [] as unknown[] };
    for (const s of streams) {
      const entries = [];
      for await (const e of L.readEntries(q, s.scope, s.stream)) entries.push({ seq: e.seq, prev_hash: L.hex(e.prev_hash), hash: L.hex(e.hash), parts: e.parts });
      const checkpoints = (await L.readCheckpoints(q, s.scope, s.stream)).map((c) => ({ ...c, last_hash: L.hex(c.last_hash), merkle_root: L.hex(c.merkle_root),
        prev_checkpoint: L.hex(c.prev_checkpoint), checkpoint_hash: L.hex(c.checkpoint_hash), signature: L.hex(c.signature) }));
      bundle.streams.push({ scope: s.scope, stream: s.stream, entries, checkpoints });
    }
    writeFileSync(values("--export")[0]!, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  }
  await db.conn.query("ROLLBACK");
  const ok = reports.every((r) => r.ok);
  if (json) console.log(JSON.stringify({ ok, keys: pubs.map((p) => L.keyId(p)), streams: reports }, null, 2));
  else {
    for (const r of reports) console.log(`${r.ok ? "ok " : "BAD"} scope ${r.scope} ${r.stream}: ${r.entries} entr${r.entries === 1 ? "y" : "ies"} (${r.first_seq ?? "-"} to ${r.last_seq ?? "-"}), ${r.checkpoints} checkpoint(s), signed through ${r.signed_through ?? "none yet"}${r.unsigned ? `, ${r.unsigned} not signed yet` : ""}${r.ok ? "" : `\n    first bad: ${r.first_bad_seq}: ${r.reason}`}`);
    console.log(reports.length ? (ok ? `LEDGER VERIFIED: ${reports.length} stream(s), signatures checked with ${pubs.map((p) => L.keyId(p)).join(", ")}` : "LEDGER NOT VERIFIED") : "Nothing to verify: no chained entries.");
  }
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  const err = e as Error & { code?: unknown };
  const said = String(err.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
  console.error(`verify-ledger: could not verify: ${said}`);
  process.exitCode = 2;
} finally {
  await db?.close().catch(() => {});
}
