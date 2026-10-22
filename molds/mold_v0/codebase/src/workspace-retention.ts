/**
 * The workspace store's retention (mold_v0-056): once a UTC day, every workspace store's expired versions are deleted,
 * their rows and their objects. Rules: src/workspace-store-policy.ts (the pack's keep_last / keep_days under the
 * platform's ceiling). Never deleted, whatever the rules: a store's latest version; any version a run result or a
 * report references (the version a run with results left, or a succeeded run of a kind with a report whose report file
 * it holds; src/workspace-store.ts snapshotOfRun is how a run's version is found); the version a run holding the
 * store's lease checked out.
 *
 *   per store   one transaction, for one workspace and store, under a lock per workspace (two sweeps at once take
 *               turns): the store's live lease and its committed rows are locked, the versions to keep worked out from
 *               the rows as they stand, the expired rows deleted (with the run's other, discarded rows of each, so a
 *               report of that run never falls back on an older version). Their objects are removed after it commits
 *   objects     every object under the store's own prefix (workspaces/org-<id>/<store>/) whose row is gone or discarded
 *               is removed too: what a removal that failed, or a stage that never got its row, left behind. A key is
 *               removed only under that prefix, never one a row names elsewhere (another workspace's object)
 *   idempotent  a second sweep finds nothing to delete; one cut short (a crash) is finished by the next tick, one whose
 *               store failed (counted in `failed`) by the next day's
 *   locked      with the key vault locked (OCTILLION_VAULT_KEY unset) the sweep refuses: nothing is read or deleted, and
 *               the day is not marked, so the next tick tries again
 *
 * Run from the scheduler's tick (src/schedules.ts schedulerTick: the server's one-minute loop, or the cron entry on
 * Vercel); marked done for the day in scheduler_marks ("workspace_retention"). OCTILLION_WORKSPACE_RETENTION=off stops it.
 */
import { getDb, type Queryable } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { packs } from "./packs.js";
import { keys, objectStore } from "./storage.js";
import { asPlatform } from "./tenant-scope.js";
import { expiredVersions, retentionPolicy, type RetentionPolicy } from "./workspace-store-policy.js";

export interface StoreSweep { org_id: number; store: string; policy: RetentionPolicy; versions: number; kept: number; deleted: number[]; objects_removed: number; error?: string }
export interface RetentionReport { ran: boolean; reason?: string; day: string; stores: number; deleted: number; objects_removed: number; failed: number; sweeps: StoreSweep[] }

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const off = () => (process.env.OCTILLION_WORKSPACE_RETENTION ?? "on").toLowerCase() === "off";

/** The packs of the build with a workspace store (a kind with workspace: true, or an agent-workspace kind). */
export const storePacks = () => packs().filter((p) => (p.definition.agentJobKinds ?? []).length > 0 || (p.definition.jobKinds ?? []).some((k) => (k as { workspace?: boolean }).workspace));
/** Whether the build has anything to sweep: the scheduler's loop starts for it. */
export const retentionWired = () => !off() && storePacks().length > 0;

/** A store's rules: its pack's declaration, or the ceiling (a store whose pack is no longer in the build too). */
export const storePolicy = (store: string) => retentionPolicy(packs().find((p) => p.id === store)?.definition.workspaceStore?.retention);
/** The report file each of the pack's kinds declares now (a run's frozen kind names its own too). */
const reportPaths = (store: string): Record<string, string> => {
  const def = packs().find((p) => p.id === store)?.definition;
  return Object.fromEntries([...(def?.jobKinds ?? []), ...(def?.agentJobKinds ?? [])]
    .filter((k) => (k as { report?: { path?: string } }).report?.path).map((k) => [k.name, (k as { report: { path: string } }).report.path]));
};

/**
 * The versions of one workspace's store that a run result or a report references: for every run of the store's pack in
 * that workspace, the version it left (the one it committed, else the one its last stage was based on), when the run
 * has results, or succeeded with a report file (its frozen kind's or its kind's today) that the version holds.
 */
export async function referencedVersions(q: Queryable, orgId: number, store: string): Promise<Set<number>> {
  const rows = await q.query<{ version: number }>(
    `WITH left_by AS (
       SELECT r.id AS run_id, r.status, r.kind, r.spec->'report'->>'path' AS frozen_report,
              coalesce((SELECT max(s.version) FROM workspace_snapshots s WHERE s.org_id = $1 AND s.store = $2 AND s.run_id = r.id AND s.status = 'committed'),
                       (SELECT s.base_version FROM workspace_snapshots s WHERE s.org_id = $1 AND s.store = $2 AND s.run_id = r.id ORDER BY s.id DESC LIMIT 1)) AS version
         FROM runs r WHERE r.org_id = $1 AND r.pack = $2)
     SELECT DISTINCT v.version FROM left_by l
       JOIN workspace_snapshots v ON v.org_id = $1 AND v.store = $2 AND v.status = 'committed' AND v.version = l.version
      WHERE EXISTS (SELECT 1 FROM run_results x WHERE x.org_id = $1 AND x.run_id = l.run_id)
         OR (l.status = 'succeeded' AND (v.manifest ? l.frozen_report OR v.manifest ? ($3::jsonb ->> l.kind)))`,
    [orgId, store, JSON.stringify(reportPaths(store))]);
  return new Set(rows.map((r) => Number(r.version)));
}

/** The store's objects (keys) under its own prefix only. */
const prefixOf = (orgId: number, store: string) => `${keys.orgPrefix("workspaces", orgId)}${store}/`;
const underPrefix = (orgId: number, store: string, key: string) => {
  const p = prefixOf(orgId, store);
  return key.startsWith(p) && /^\d{1,18}\.wse$/.test(key.slice(p.length));
};

/**
 * Sweep one workspace's store. Its rows: one transaction. Its objects: after it, under its own prefix only. `now` is
 * the clock the age rule reads (a test moves it).
 */
export async function sweepStore(orgId: number, store: string, now = new Date()): Promise<StoreSweep> {
  const policy = storePolicy(store);
  const out: StoreSweep = { org_id: orgId, store, policy, versions: 0, kept: 0, deleted: [], objects_removed: 0 };
  if (!vaultUnlocked()) throw new Error("the key vault is locked (OCTILLION_VAULT_KEY): the workspace store's retention does not run");
  const db = await getDb();
  const gone = await asPlatform(() => db.transaction(async (tx) => {
    // Two sweeps of one workspace take turns (the Vercel cron and a server's loop, two replicas).
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`workspace-retention:${orgId}`]);
    // The run holding the store's lease (a lapsed one too) keeps the version it checked out (its write-back's base), and
    // its lease row is held still while the sweep decides.
    const lease = await tx.query<{ base_version: number | null }>(
      "SELECT base_version FROM workspace_leases WHERE org_id = $1 AND store = $2 FOR UPDATE", [orgId, store]);
    const rows = await tx.query<{ id: number; version: number; committed_at: Date | null; run_id: string | null; object_key: string }>(
      "SELECT id, version, committed_at, run_id, object_key FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'committed' ORDER BY version DESC FOR UPDATE",
      [orgId, store]);
    out.versions = rows.length;
    if (rows.length <= 1) { out.kept = rows.length; return [] as string[]; }
    const protect = await referencedVersions(tx, orgId, store);
    for (const l of lease) if (l.base_version) protect.add(Number(l.base_version));
    const expired = new Set(expiredVersions(rows.map((r) => ({ version: Number(r.version), committed_at: r.committed_at })), policy, protect, now));
    const doomed = rows.filter((r) => expired.has(Number(r.version)));
    out.kept = rows.length - doomed.length;
    if (!doomed.length) return [];
    const deleted = await tx.query<{ version: number | null; object_key: string }>(
      "DELETE FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'committed' AND id = ANY ($3::bigint[]) RETURNING version, object_key",
      [orgId, store, doomed.map((r) => r.id)]);
    // The deleted versions' runs: their discarded stages go too, so the version such a run left is "none", never an
    // older one its earlier stage was based on (src/workspace-store.ts snapshotOfRun).
    const runIds = [...new Set(doomed.map((r) => r.run_id).filter((x): x is string => !!x))];
    const stages = runIds.length ? await tx.query<{ object_key: string }>(
      "DELETE FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status = 'discarded' AND run_id = ANY ($3::text[]) RETURNING object_key",
      [orgId, store, runIds]) : [];
    out.deleted = deleted.map((r) => Number(r.version)).sort((a, b) => a - b);
    return [...deleted, ...stages].map((r) => r.object_key).filter(Boolean);
  }));
  // Objects after the rows are gone: a removal that fails leaves an orphan the next sweep removes, never a row
  // without its object. Only keys under this store's own prefix are removed.
  const ours = gone.filter((k) => underPrefix(orgId, store, k));
  if (ours.length !== gone.length) console.error(`workspace retention: workspace ${orgId} store ${store}: ${gone.length - ours.length} row(s) named an object outside the store's prefix; not removed`);
  const os = objectStore();
  if (ours.length) { await os.remove(ours); out.objects_removed += ours.length; }
  out.objects_removed += await removeOrphans(orgId, store);
  return out;
}

/**
 * Objects under the store's prefix with no live row (none, or a discarded one): removed. The listing comes first, the
 * rows after: a stage's row is written before its object, so an object listed with no row is never one being written.
 */
async function removeOrphans(orgId: number, store: string): Promise<number> {
  const os = objectStore();
  const listed = (await os.list(prefixOf(orgId, store))).filter((k) => underPrefix(orgId, store, k));
  if (!listed.length) return 0;
  const ids = listed.map((k) => k.slice(prefixOf(orgId, store).length).replace(/\.wse$/, ""));
  const live = new Set((await asPlatform(async () => (await getDb()).query<{ id: string }>(
    "SELECT id::text AS id FROM workspace_snapshots WHERE org_id = $1 AND store = $2 AND status IN ('staged', 'committed') AND id = ANY ($3::bigint[])",
    [orgId, store, ids]))).map((r) => r.id));
  const orphans = listed.filter((_, i) => !live.has(ids[i]!));
  if (orphans.length) await os.remove(orphans);
  return orphans.length;
}

/**
 * Once a UTC day: sweep every workspace store (each workspace's on its own, one failing never stops the others).
 * `force` runs it again on a day already done (tests, an operator).
 */
export async function retentionSweep(now = new Date(), opts: { force?: boolean } = {}): Promise<RetentionReport> {
  const day = dayOf(now);
  const report: RetentionReport = { ran: false, day, stores: 0, deleted: 0, objects_removed: 0, failed: 0, sweeps: [] };
  if (off()) return { ...report, reason: "turned off (OCTILLION_WORKSPACE_RETENTION=off)" };
  if (!vaultUnlocked()) return { ...report, reason: "the key vault is locked (OCTILLION_VAULT_KEY): not run, tried again at the next tick" };
  const db = await getDb();
  if (!opts.force) {
    // The day as text: a DATE read back as a Date is local midnight, a day early on a server east of UTC.
    const [mark] = await asPlatform(() => db.query<{ day: string }>("SELECT day::text AS day FROM scheduler_marks WHERE name = 'workspace_retention'"));
    if (mark && mark.day >= day) return { ...report, reason: "already ran today" };
  }
  report.ran = true;
  const stores = await asPlatform(() => db.query<{ org_id: number; store: string }>(
    "/* tenant: platform retention sweep: which workspace stores exist; each is then swept on its own, by its own org_id */ SELECT DISTINCT org_id, store FROM workspace_snapshots ORDER BY org_id, store"));
  for (const s of stores) {
    report.stores++;
    try {
      const r = await sweepStore(Number(s.org_id), s.store, now);
      report.sweeps.push(r);
      report.deleted += r.deleted.length;
      report.objects_removed += r.objects_removed;
    } catch (e) {
      report.failed++;
      const error = String((e as Error)?.message ?? e).slice(0, 300);
      report.sweeps.push({ org_id: Number(s.org_id), store: s.store, policy: storePolicy(s.store), versions: 0, kept: 0, deleted: [], objects_removed: 0, error });
      console.error(`workspace retention: workspace ${s.org_id} store ${s.store}: ${error}`);
    }
  }
  // Marked once every store was tried: one that failed (logged, counted) is tried again tomorrow, not at every tick; its
  // rows are untouched and an object it could not remove is an orphan the next sweep removes.
  await asPlatform(() => db.query(
    `INSERT INTO scheduler_marks (name, day, at) VALUES ('workspace_retention', $1, $2) ON CONFLICT (name) DO UPDATE SET day = excluded.day, at = excluded.at
      WHERE scheduler_marks.day < excluded.day`, [day, now]));
  return report;
}
