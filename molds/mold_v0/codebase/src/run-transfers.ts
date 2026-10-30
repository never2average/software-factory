/**
 * A run's transfers through object storage (mold_v0-182; sql/migrations/0029_run_transfers.sql). A hosted deployment's
 * API takes at most 4.5 MB per request body and per answer (Vercel's functions: FUNCTION_PAYLOAD_TOO_LARGE), less than
 * a workspace's write-back, its checkout or a completion with many results can be. The bytes then go between the runner
 * and the bucket directly, with a time-limited link for one object key, and only small requests pass through the API:
 *
 *   upload     POST /api/worker/runs/<id>/uploads {purpose, bytes, sha256}: a transfer of this run's attempt, a key
 *              made for it alone, and a PUT link (15 minutes) for workspaces/org-<id>/.transfers/<transfer>.wst. The
 *              runner seals the content with that key (src/run-transfer-seal.ts) and sends it to the link; then
 *              POST .../workspace/commit {upload} (a write-back, staged as PUT .../workspace stages one) or
 *              POST .../complete {upload} (a completion). Used once: checked (its size, its seal, its sha256), then removed.
 *   download   GET .../workspace with X-Workspace-Transfer: link, when the checkout is larger than the API answers:
 *              the bundle sealed with a transfer key of its own, put under the run's transfers, and a GET link to it.
 *
 * Nothing changes for a store that is a local directory (one machine, docker, the tests): it has no links, and its API
 * has no such limit, so the runner sends the bytes to the API as before. Every transfer is its run's attempt's: found by
 * the transfer id, the run row behind the lease token (its workspace, org_id), its id and attempt, never by the id alone;
 * the key under the workspace's own prefix; removed (row and object) once used or when the attempt ends (endAttempt).
 */
import { randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { ENV } from "./env-names.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { PackError } from "./pack-api.js";
import { openTransfer, sealTransfer, sha256Hex, sizeInWords, TRANSFER_OVERHEAD } from "./run-transfer-seal.js";
import { keys, objectStore } from "./storage.js";
import { asPlatform } from "./tenant-scope.js";

export type TransferPurpose = "workspace" | "completion" | "checkout";
type RunRef = { id: string; org_id: number; attempt: number };

/** The largest body the worker API takes or gives inline before a transfer is used: 4 MiB, under Vercel's 4.5 MB. */
export const inlineMaxBytes = () => Number(ENV.APP_WORKER_INLINE_MAX_BYTES ?? 4 * 1024 * 1024);
/** The largest write-back (a workspace bundle) this deployment takes, inline or through a transfer. */
export const maxBundleBytes = () => Number(ENV.APP_WORKSPACE_MAX_BUNDLE_BYTES ?? 300 * 1024 * 1024);
/** The largest completion (a run's results) taken through a transfer. */
const MAX_COMPLETION_BYTES = 64 * 1024 * 1024;
const LINK_SECONDS = 15 * 60, ROW_SECONDS = 60 * 60;
const keyAad = (orgId: number, id: string) => `run-transfer-key:v1:org-${orgId}:${id}`;

/** The size limit of a purpose, with the setting that moves it (named in a refusal). */
export const limitOf = (purpose: TransferPurpose) => purpose === "completion"
  ? { bytes: MAX_COMPLETION_BYTES, setting: null } : { bytes: maxBundleBytes(), setting: "APP_WORKSPACE_MAX_BUNDLE_BYTES" };

/** A refusal for size, naming the size and the limit (and the setting that moves it). Status 413. */
export function tooLarge(purpose: TransferPurpose, bytes: number): PackError {
  const l = limitOf(purpose);
  const what = purpose === "completion" ? "the run's completion (its results)" : "the workspace's write-back";
  return Object.assign(new PackError(`${what} is ${sizeInWords(bytes)} (${bytes} bytes); this deployment takes at most ${sizeInWords(l.bytes)} (${l.bytes} bytes${l.setting ? `, ${l.setting}` : ""})`, 413),
    { bytes, limit: l.bytes });
}

async function newTransfer(db: Queryable, run: RunRef, purpose: TransferPurpose, bytes: number, sha256: string) {
  const id = `tr_${randomBytes(16).toString("hex")}`, key = randomBytes(32);
  const objectKey = keys.transfer(run.org_id, id);
  const sealedKey = await sealBytes(run.org_id, key, keyAad(run.org_id, id));
  await db.query(
    `INSERT INTO run_transfers (id, org_id, run_id, attempt, purpose, object_key, bytes, sha256, sealed_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
    [id, run.org_id, run.id, run.attempt, purpose, objectKey, bytes, sha256, sealedKey, ROW_SECONDS]);
  return { id, key, objectKey };
}

/** This attempt's earlier transfers of one purpose: gone (one at a time per purpose). */
async function dropEarlier(db: Queryable, run: RunRef, purpose: TransferPurpose) {
  const rows = await db.query<{ object_key: string }>(
    "DELETE FROM run_transfers WHERE org_id = $1 AND run_id = $2 AND attempt = $3 AND purpose = $4 RETURNING object_key", [run.org_id, run.id, run.attempt, purpose]);
  if (rows.length) await (await objectStore()).remove(rows.map((r) => r.object_key)).catch(() => {});
}

export interface UploadLink { id: string; url: string; key: string; expires_at: string; max_bytes: number }

/**
 * An upload for `run`'s attempt: null (with the reason) when the store gives no links (a local directory: send the
 * bytes to the API). Refused (413) past the purpose's limit, before anything is sent.
 */
export async function createUpload(run: RunRef, purpose: "workspace" | "completion", bytes: unknown, sha256: unknown): Promise<{ upload: UploadLink | null; reason?: string }> {
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) throw new PackError("bytes: the content's size, a whole number of bytes", 400);
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new PackError("sha256: the content's sha256, 64 lowercase hex characters", 400);
  if (bytes > limitOf(purpose).bytes) throw tooLarge(purpose, bytes);
  const os = await objectStore();
  if (!os.links) return { upload: null, reason: "this deployment's object store is a local directory: send the content to the API" };
  return asPlatform(async () => {
    const db = await getDb();
    await dropEarlier(db, run, purpose);
    const t = await newTransfer(db, run, purpose, bytes, sha256);
    const url = await os.links!.put(t.objectKey, LINK_SECONDS);
    return { upload: { id: t.id, url, key: t.key.toString("base64"), expires_at: new Date(Date.now() + LINK_SECONDS * 1000).toISOString(), max_bytes: limitOf(purpose).bytes } };
  });
}

/**
 * The content of `run`'s upload `id`, used once: its object read from the store, its size, seal and sha256 checked,
 * then the row and the object removed. 404 when the attempt has no such upload; 409 when its object is not there.
 */
export async function takeUpload(run: RunRef, id: unknown, purpose: "workspace" | "completion"): Promise<Buffer> {
  if (typeof id !== "string" || !/^tr_[0-9a-f]{32}$/.test(id)) throw new PackError("upload: a transfer id from POST .../uploads", 400);
  return asPlatform(async () => {
    const db = await getDb();
    const [row] = await db.query<{ object_key: string; bytes: string; sha256: string; sealed_key: Buffer }>(
      `SELECT object_key, bytes, sha256, sealed_key FROM run_transfers
        WHERE id = $1 AND org_id = $2 AND run_id = $3 AND attempt = $4 AND purpose = $5 AND expires_at > now()`, [id, run.org_id, run.id, run.attempt, purpose]);
    if (!row) throw new PackError("this run's attempt has no such upload (or it was used, or it expired)", 404);
    const os = await objectStore();
    const drop = async () => {
      await db.query("DELETE FROM run_transfers WHERE id = $1 AND org_id = $2", [id, run.org_id]);
      await os.remove([row.object_key]).catch(() => {});
    };
    const sealed = await os.get(row.object_key);
    if (!sealed) throw new PackError("the upload is not in the object store (it was not sent, or its link expired): ask for a new one", 409);
    const bytes = Number(row.bytes);
    try {
      if (sealed.length !== bytes + TRANSFER_OVERHEAD) throw new PackError(`the upload holds ${sealed.length - TRANSFER_OVERHEAD} bytes, not the ${bytes} announced`, 400);
      const key = await openBytes(run.org_id, Buffer.from(row.sealed_key), keyAad(run.org_id, id));
      let body: Buffer;
      try { body = openTransfer(key, id, sealed); } catch { throw new PackError("the upload does not open with its key (not sealed for this transfer, or changed on the way)", 400); }
      if (sha256Hex(body) !== row.sha256) throw new PackError("the upload's sha256 is not the one announced", 400);
      return body;
    } finally { await drop(); }
  });
}

export interface DownloadLink { id: string; url: string; key: string; bytes: number; sha256: string; expires_at: string }

/** A download of `body` for `run`'s attempt (a checkout larger than the API answers), or null when the store gives no links. */
export async function createDownload(run: RunRef, purpose: "checkout", body: Buffer): Promise<DownloadLink | null> {
  const os = await objectStore();
  if (!os.links) return null;
  return asPlatform(async () => {
    const db = await getDb();
    await dropEarlier(db, run, purpose);
    const sha256 = sha256Hex(body);
    const t = await newTransfer(db, run, purpose, body.length, sha256);
    await os.put(t.objectKey, sealTransfer(t.key, t.id, body), "application/octet-stream");
    const url = await os.links!.get(t.objectKey, LINK_SECONDS);
    return { id: t.id, url, key: t.key.toString("base64"), bytes: body.length, sha256, expires_at: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() };
  });
}

/** The end of an attempt (src/workspace-store.ts endAttempt, inside its transaction): the run's transfers go; their objects' keys. */
export async function endTransfers(tx: Queryable, runId: string): Promise<string[]> {
  const rows = await tx.query<{ object_key: string }>(
    "/* tenant: the ending run's own transfers, by run id */ DELETE FROM run_transfers WHERE run_id = $1 RETURNING object_key", [runId]);
  return rows.map((r) => r.object_key);
}
