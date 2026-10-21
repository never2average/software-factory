/**
 * The workspace store (mold_v0-033; sql/migrations/0006_workspace_store.sql): versioned snapshots of a workspace's files
 * that outlive a run, one store per workspace and pack (the store's name is the pack's id).
 *
 *   lease     a run of a kind with `workspace: true` holds its store's lease from its claim (src/runs.ts claimRun) to
 *             its end, renewed by its heartbeat: one writer per workspace store; a second run waits in the queue
 *   checkout  the latest committed snapshot, opened with the workspace's data key and checked file by file against
 *             its manifest, into the run's empty directory; the version is noted on the lease (the write-back's base)
 *   stage     the run's directory, packed (src/workspace-bundle.ts), sealed and stored as a staged snapshot
 *   commit    inside the run's completion as succeeded (its program and validation exited 0): the staged snapshot
 *             becomes version base + 1, unless another version landed since its checkout (then the run is retried
 *             from a fresh checkout). Any other end discards the stage: the version does not move.
 *
 * Everything is keyed by the run's own workspace (org_id), taken from the run row behind the runner's lease token:
 * a runner names a run and nothing else, so it can never check out or write another workspace's store. The objects
 * are sealed with that workspace's data key (src/orgcrypto.ts sealBytes) and bound to their workspace, store, snapshot
 * and manifest (the AES-GCM additional data): a blob moved under another row or workspace does not open.
 */
import { gzipSync } from "node:zlib";
import { getDb, type Queryable } from "./db.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { PackError } from "./pack-api.js";
import { keys, objectStore } from "./storage.js";
import { asPlatform } from "./tenant-scope.js";
import { BundleError, EMPTY_MANIFEST_SHA256, packBundle, readBundle, unpackBundle, type Manifest } from "./workspace-bundle.js";

export interface Snapshot {
  id: number; org_id: number; store: string; version: number | null; status: "staged" | "committed" | "discarded"; base_version: number;
  run_id: string | null; attempt: number | null; manifest: Manifest; manifest_sha256: string; files: number; bytes: number; object_key: string;
  created_at: Date; committed_at: Date | null;
}
const COLS = "id, org_id, store, version, status, base_version, run_id, attempt, manifest, manifest_sha256, files, bytes, object_key, created_at, committed_at";
const aad = (s: { org_id: number; store: string; id: number; manifest_sha256: string }) => `workspace-snapshot:v1:org-${s.org_id}:${s.store}:${s.id}:${s.manifest_sha256}`;

// ---------- leases (src/runs.ts) ----------

/** Take the store's lease for a run, inside its claim's transaction; false when another live run holds it. */
export async function acquireLease(tx: Queryable, orgId: number, store: string, runId: string, seconds: number): Promise<boolean> {
  const rows = await tx.query(
    `INSERT INTO workspace_leases (org_id, store, run_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (org_id, store) DO UPDATE SET run_id = excluded.run_id, expires_at = excluded.expires_at, base_version = NULL
      WHERE workspace_leases.expires_at < now() OR workspace_leases.run_id = excluded.run_id
     RETURNING run_id`, [orgId, store, runId, seconds]);
  return rows.length > 0;
}
export async function renewLease(runId: string, seconds: number): Promise<void> {
  await asPlatform(async () => (await getDb()).query(
    "/* tenant: the leased run's own store lease */ UPDATE workspace_leases SET expires_at = now() + make_interval(secs => $2) WHERE run_id = $1", [runId, seconds]));
}
/**
 * The end of an attempt, inside the transaction that ends it (src/runs.ts complete and sweep): its store lease goes and
 * every stage it did not commit is discarded, before any later attempt can be claimed. Returns the discarded objects'
 * keys, removed after the transaction commits (removeObjects).
 */
export async function endAttempt(tx: Queryable, runId: string): Promise<string[]> {
  await tx.query("/* tenant: the ending run's own store lease */ DELETE FROM workspace_leases WHERE run_id = $1", [runId]);
  const rows = await tx.query<{ object_key: string }>(
    "/* tenant: the ending run's own staged snapshots, by run id */ UPDATE workspace_snapshots SET status = 'discarded' WHERE run_id = $1 AND status = 'staged' RETURNING object_key", [runId]);
  return rows.map((r) => r.object_key).filter(Boolean);
}
export async function removeObjects(list: string[]): Promise<void> {
  if (list.length) await objectStore().remove(list).catch((e) => console.error(`workspace store: could not remove ${list.length} discarded object(s): ${(e as Error).message}`));
}
const holdsLease = async (q: Queryable, orgId: number, store: string, runId: string) =>
  (await q.query<{ base_version: number | null }>("SELECT base_version FROM workspace_leases WHERE org_id = $1 AND store = $2 AND run_id = $3 AND expires_at > now()",
    [orgId, store, runId]))[0] ?? null;

// ---------- reads ----------

export async function latestSnapshot(q: Queryable, orgId: number, store: string): Promise<Snapshot | null> {
  const [s] = await q.query<Snapshot>(
    `SELECT ${COLS} FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'committed' ORDER BY version DESC LIMIT 1`, [orgId, store]);
  return s ?? null;
}
/** One committed version of a workspace's store (mold_v0-060: a run's report is read from the version it left). */
export async function snapshotAt(q: Queryable, orgId: number, store: string, version: number): Promise<Snapshot | null> {
  const [s] = await q.query<Snapshot>(
    `SELECT ${COLS} FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND version = $3 AND status = 'committed'`, [orgId, store, version]);
  return s ?? null;
}
/**
 * The version a run left (mold_v0-060): the one it committed, else (its write-back changed nothing, so no version was
 * made) the committed version its write-back was staged on. Read from the store's own rows, which only the platform
 * writes; null when the run staged nothing.
 */
export async function snapshotOfRun(q: Queryable, orgId: number, store: string, runId: string): Promise<Snapshot | null> {
  const [own] = await q.query<Snapshot>(
    `SELECT ${COLS} FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND run_id = $3 AND status = 'committed' ORDER BY version DESC LIMIT 1`, [orgId, store, runId]);
  if (own) return own;
  const [staged] = await q.query<{ base_version: number | null }>(
    "SELECT base_version FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND run_id = $3 ORDER BY id DESC LIMIT 1", [orgId, store, runId]);
  return staged?.base_version ? snapshotAt(q, orgId, store, staged.base_version) : null;
}
/** A workspace's versions of one store, newest first (its own only: the org_id filter, and row-level security for tenant work). */
export async function listSnapshots(orgId: number, store: string): Promise<Omit<Snapshot, "manifest">[]> {
  return (await getDb()).query(`SELECT id, org_id, store, version, status, base_version, run_id, attempt, manifest_sha256, files, bytes, object_key, created_at, committed_at
    FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'committed' ORDER BY version DESC`, [orgId, store]);
}

/** A snapshot's files, opened with its workspace's key and checked against its manifest. */
export async function openSnapshot(s: Snapshot): Promise<Buffer> {
  const sealed = await objectStore().get(s.object_key);
  if (!sealed) throw new Error(`snapshot ${s.id}: its object is missing`);
  const bundle = await openBytes(s.org_id, sealed, aad(s));
  const read = readBundle(bundle);
  if (read.manifest_sha256 !== s.manifest_sha256) throw new Error(`snapshot ${s.id}: its content does not match its manifest`);
  return bundle;
}

/** An empty workspace's bundle (a store's first run), without touching the disk. */
const emptyBundle = () => {
  const header = Buffer.from(JSON.stringify({ files: [] }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  return gzipSync(Buffer.concat([Buffer.from("WSB1\n"), len, header]));
};

// ---------- a run's checkout and stage (the runner's lease token, src/runs.ts leasedRun) ----------

type LeasedRun = { id: string; org_id: number; pack: string; attempt: number; spec: { workspace?: boolean } };
const storeOf = (run: LeasedRun) => {
  if (!run.spec?.workspace) throw new PackError("this run's kind does not use the workspace store", 400);
  return run.pack;
};

/** The latest snapshot of the run's own workspace store, as a bundle; notes the version on the lease. */
export async function checkoutBundle(run: LeasedRun): Promise<{ version: number; bundle: Buffer; manifest_sha256: string }> {
  const store = storeOf(run);
  return asPlatform(async () => {
    const db = await getDb();
    if (!(await holdsLease(db, run.org_id, store, run.id))) throw new PackError("this run does not hold its workspace's lease", 409);
    const s = await latestSnapshot(db, run.org_id, store);
    const out = s ? { version: s.version!, bundle: await openSnapshot(s), manifest_sha256: s.manifest_sha256 } : { version: 0, bundle: emptyBundle(), manifest_sha256: EMPTY_MANIFEST_SHA256 };
    await db.query("/* tenant: the run's own store lease */ UPDATE workspace_leases SET base_version = $4 WHERE org_id = $1 AND store = $2 AND run_id = $3",
      [run.org_id, store, run.id, out.version]);
    await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, $3, 'workspace_checkout', $4)",
      [run.id, run.org_id, run.attempt, JSON.stringify({ version: out.version, manifest_sha256: out.manifest_sha256 })]);
    return out;
  });
}

/** Stage a bundle as this attempt's write-back (sealed, stored); committed only by the run's completion as succeeded. */
export async function stageBundle(run: LeasedRun, bundle: Buffer): Promise<{ manifest_sha256: string; files: number; unchanged: boolean }> {
  const store = storeOf(run);
  let read;
  try { read = readBundle(bundle); } catch (e) { throw new PackError((e as Error).message, (e as BundleError).status ?? 400); }
  const files = Object.keys(read.manifest).length, bytes = Object.values(read.manifest).reduce((n, f) => n + f.size, 0);
  return asPlatform(async () => {
    const db = await getDb();
    const lease = await holdsLease(db, run.org_id, store, run.id);
    if (!lease) throw new PackError("this run does not hold its workspace's lease", 409);
    if (lease.base_version === null) throw new PackError("check the workspace out before writing it back", 409);
    const base = lease.base_version ? await db.query<{ manifest_sha256: string }>(
      "SELECT manifest_sha256 FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND version = $3", [run.org_id, store, lease.base_version]) : [];
    const unchanged = (base[0]?.manifest_sha256 ?? EMPTY_MANIFEST_SHA256) === read.manifest_sha256;
    await discardStaged(run.id);
    const [row] = await db.query<Snapshot>(
      `INSERT INTO workspace_snapshots (org_id, store, status, base_version, run_id, attempt, manifest, manifest_sha256, files, bytes, object_key)
       VALUES ($1, $2, 'staged', $3, $4, $5, $6, $7, $8, $9, '') RETURNING ${COLS}`,
      [run.org_id, store, lease.base_version, run.id, run.attempt, JSON.stringify(read.manifest), read.manifest_sha256, files, bytes]);
    const key = keys.workspace(run.org_id, store, row!.id);
    try {
      await objectStore().put(key, await sealBytes(run.org_id, bundle, aad(row!)), "application/octet-stream");
    } catch (e) {
      await db.query("DELETE FROM workspace_snapshots WHERE org_id = $1 AND id = $2", [run.org_id, row!.id]);
      throw e;
    }
    await db.query("UPDATE workspace_snapshots SET object_key = $3 WHERE org_id = $1 AND id = $2", [run.org_id, row!.id, key]);
    return { manifest_sha256: read.manifest_sha256, files, unchanged };
  });
}

/**
 * Inside a run's completion as succeeded (src/runs.ts): its staged snapshot becomes the next version. "conflict" when
 * another version landed after this run's checkout (it cannot, while the lease holds; checked anyway). No stage: null.
 */
export async function commitStaged(tx: Queryable, run: { id: string; org_id: number; pack: string; attempt: number }): Promise<{ version: number; unchanged: boolean } | "conflict" | null> {
  const [s] = await tx.query<Snapshot>(
    `SELECT ${COLS} FROM workspace_snapshots WHERE org_id = $1 AND run_id = $2 AND attempt = $3 AND status = 'staged' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [run.org_id, run.id, run.attempt]);
  if (!s || !s.object_key) return null;
  const latest = await latestSnapshot(tx, run.org_id, s.store);
  if ((latest?.version ?? 0) !== s.base_version) return "conflict";
  // Nothing changed: no new version; the stage stays staged and is discarded (with its object) as the attempt ends.
  if ((latest?.manifest_sha256 ?? EMPTY_MANIFEST_SHA256) === s.manifest_sha256) return { version: s.base_version, unchanged: true };
  await tx.query("UPDATE workspace_snapshots SET status = 'committed', version = $3, committed_at = now() WHERE org_id = $1 AND id = $2",
    [run.org_id, s.id, s.base_version + 1]);
  return { version: s.base_version + 1, unchanged: false };
}

/** Discard a run's staged (uncommitted) snapshots and remove their objects. */
export async function discardStaged(runId: string): Promise<number> {
  return asPlatform(async () => {
    const db = await getDb();
    const rows = await db.query<{ id: number; object_key: string }>(
      "/* tenant: the run's own staged snapshots, by run id */ UPDATE workspace_snapshots SET status = 'discarded' WHERE run_id = $1 AND status = 'staged' RETURNING id, object_key", [runId]);
    await removeObjects(rows.map((r) => r.object_key).filter(Boolean));
    return rows.length;
  });
}

// ---------- the in-process runner's side (src/run-harness.ts localRunnerClient) ----------

export async function checkoutForRun(runId: string, lease: string, dir: string): Promise<{ version: number }> {
  const { leasedRun } = await import("./runs.js");
  const out = await checkoutBundle(await leasedRun(runId, lease));
  unpackBundle(out.bundle, dir, out.manifest_sha256);
  return { version: out.version };
}
export async function stageForRun(runId: string, lease: string, dir: string) {
  const { leasedRun } = await import("./runs.js");
  return stageBundle(await leasedRun(runId, lease), packBundle(dir).bundle);
}
