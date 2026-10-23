/**
 * Deleting an organization (docs/security.md, phase 0c). Postgres cascades from `organizations`, but transcripts live
 * in ClickHouse and archives, research results and reports in R2: all of it goes. Steps run in order and the whole
 * thing can be re-run after a partial failure (every step is idempotent and works from the org id alone):
 *
 *   1. revoke access: API keys, worker tokens of its jobs, gateway tokens of its sessions
 *   2. stop work: queued and running sessions cancelled, simulations and research closed
 *   3. purge transcripts from the live store (ClickHouse or Postgres)
 *   4. purge every R2 prefix of the org (transcripts, research, reports, diffs, exports)
 *   5. delete the organization row (Postgres cascades to every tenant table)
 *   6. write a tombstone with counts only (no names, no content)
 *
 * Hourly Postgres dumps in R2 (postgres/, 30-day retention) still hold the rows until they expire.
 */
import { forgetOrgKey } from "./orgcrypto.js";
import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { keys, listKeys, deleteKeys, objectStore, storageEnabled } from "./storage.js";
import { baseTranscripts } from "./transcripts.js";
import { forgetArchivedOrg } from "./archive.js";
import { ENV } from "./env-names.js";

const PREFIX_KINDS = ["transcripts", "research", "reports", "diffs", "exports", "workspaces"] as const;

export interface OrgDeletion {
  org_id: number;
  dry_run: boolean;
  found: boolean;
  counts: { api_keys: number; simulations: number; sessions: number; research: number; objects: number };
}

export async function deleteOrg(orgId: number, opts: { dryRun?: boolean; log?: (m: string) => void } = {}): Promise<OrgDeletion> {
  const log = opts.log ?? (() => {});
  const db = await getDb();
  orgId = Math.trunc(orgId);
  const [org] = await db.query<{ id: number }>("SELECT id FROM organizations WHERE id = $1", [orgId]);
  const count = async (sql: string) => Number((await db.query<{ n: number }>(sql, [orgId]))[0]?.n ?? 0);
  const objects = storageEnabled()
    ? (await Promise.all(PREFIX_KINDS.map((k) => listKeys(keys.orgPrefix(k, orgId))))).flat()
    : [];
  // The session engine's tables are a host pack's (mold_v0-049): with none in this build there is none of its work.
  const engine = sessionEngine(), research = researchJobs();
  const counts = {
    api_keys: await count("SELECT count(*) AS n FROM api_keys WHERE org_id = $1"),
    simulations: engine ? await count("SELECT count(*) AS n FROM simulations WHERE org_id = $1") : 0,
    sessions: engine ? await count("SELECT count(*) AS n FROM agent_sessions WHERE org_id = $1") : 0,
    research: research ? await count("SELECT count(*) AS n FROM product_research WHERE org_id = $1") : 0,
    objects: objects.length,
  };
  const out: OrgDeletion = { org_id: orgId, dry_run: !!opts.dryRun, found: !!org, counts };
  if (opts.dryRun) return out;

  // 1-2. Revoke access and stop work first, so nothing writes new data while it is being purged.
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM api_keys WHERE org_id = $1", [orgId]);
    await tx.query("UPDATE worker_tokens SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL", [orgId]);
    if (engine) {
      await tx.query(
        `UPDATE gateway_tokens SET revoked_at = now()
          WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM agent_sessions WHERE org_id = $1)`, [orgId]);
      await tx.query("UPDATE agent_sessions SET status = 'cancelled', ended_at = now() WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]);
      await tx.query("UPDATE simulations SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]);
    }
    if (research) await tx.query("UPDATE product_research SET status = 'failed', error = 'organization deleted', finished_at = now() WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]);
    // Runs (mold_v0-041): no more spending, no more claims.
    await tx.query("UPDATE gateway_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND run_id IN (SELECT id FROM runs WHERE org_id = $1)", [orgId]);
    await tx.query("UPDATE runs SET status = 'cancelled', error_kind = 'cancelled', error = 'organization deleted', cancel_requested_at = now(), ended_at = now() WHERE org_id = $1 AND status IN ('queued', 'running')", [orgId]);
  });
  log(`org ${orgId}: access revoked, work stopped`);

  // 3. Transcripts in the live store.
  await baseTranscripts().removeOrg(orgId);
  forgetArchivedOrg(orgId);
  log(`org ${orgId}: transcripts purged from ${baseTranscripts().kind}`);

  // 4. Object storage.
  if (objects.length) await deleteKeys(objects.map((o) => o.key));
  if (storageEnabled()) {
    const left = (await Promise.all(PREFIX_KINDS.map((k) => listKeys(keys.orgPrefix(k, orgId))))).flat();
    if (left.length) throw new Error(`org ${orgId}: ${left.length} object(s) still in R2 after the purge; re-run deleteOrg`);
  }
  log(`org ${orgId}: ${objects.length} object(s) purged from R2`);
  // Workspace snapshots kept in a local directory instead (mold_v0-033, APP_STORAGE_DIR without R2).
  if (!storageEnabled() && ENV.APP_STORAGE_DIR) {
    const local = objectStore();
    const mine = await local.list(keys.orgPrefix("workspaces", orgId));
    await local.remove(mine);
    log(`org ${orgId}: ${mine.length} workspace snapshot(s) removed from ${ENV.APP_STORAGE_DIR}`);
  }

  // 5-6. Postgres cascade, then the tombstone.
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await tx.query(
      "INSERT INTO org_deletions (org_id, counts) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET counts = excluded.counts, deleted_at = now()",
      [orgId, JSON.stringify(counts)]);
  });
  forgetOrgKey(orgId); // its data key went with the cascade (org_keys): its private text is unreadable
  log(`org ${orgId}: deleted`);
  return out;
}
