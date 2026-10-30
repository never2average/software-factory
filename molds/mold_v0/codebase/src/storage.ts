import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname as pathDirname, join as pathJoin, relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";
import { ENV } from "./env-names.js";

/**
 * Off-machine object storage: one private bucket (Cloudflare R2, or any S3-compatible service) with one prefix per
 * kind of data; its settings come from the environment (R2_*) or the key vault (below). This module is the only place that knows the layout (docs/storage.md):
 *
 *   postgres/                                      hourly pg_dump files (pg-backup-offsite service, 30-day retention)
 *   transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz   every finished session's trace (archive.ts), kept
 *   research/org-<id>/<research_id>.json           onboarding research results (archive.ts), kept
 *   reports/org-<id>/<simulation>/<stamp>.{pdf,html}    run reports (reports.ts), kept
 *   diffs/org-<id>/<simulation>/<session>.diff.gz  reserved: workspace diffs
 *   exports/org-<id>/...                           reserved: customer data exports
 *   workspaces/org-<id>/<store>/<snapshot>.wse     workspace snapshots, sealed with the org's data key (mold_v0-033)
 *   workspaces/org-<id>/.transfers/<id>.wst        a run's request or answer too large for the API (mold_v0-182), sealed
 *                                                  with a key of its own, gone once used or when the run's attempt ends
 *   ops/...                                        internal one-offs (ops/key-vault-test/: the Key vault's Test)
 *
 * Customer data always sits under its org's prefix, so access can be scoped per org by construction. The org id (not
 * the slug) is used: slugs can be renamed, ids cannot.
 */

const env = ENV;

/**
 * Where the bucket's settings come from (mold_v0-181): the environment when all four R2_* variables are set (as before),
 * else the key vault's Object storage entry (a platform owner adds it on the console's Key vault page; src/keyvault.ts
 * OBJECT_STORAGE_PROVIDER, sealed like every vault value), else none: objectStore() then uses APP_STORAGE_DIR, or
 * refuses. The vault's entry is read at most once a minute per process (VAULT_TTL_MS) and dropped at once when this
 * process changes the vault (src/keyvault.ts vaultGeneration).
 */
export const ENV_NAMES = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
/** Whether the environment configures the bucket (all four R2_* set). Synchronous; the vault is asked by s3Ready(). */
export const storageInEnv = () => Boolean(env.R2_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
const VAULT_TTL_MS = 60_000;
export const NOT_CONFIGURED = "no object store: set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment, " +
  "or add Object storage (R2 / S3) on the console's Key vault page (/admin/keys), or set APP_STORAGE_DIR";

export interface BucketSettings { bucket: string; endpoint: string; access_key_id: string; secret_access_key: string }
interface Target { source: "env" | "vault"; bucket: string; endpoint: string; client: S3Client }

/** The SigV4 region for an endpoint: AWS's own from its address (s3.<region>.amazonaws.com), else "auto" (R2 and most others). */
export const regionOf = (endpoint: string) => /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(new URL(endpoint).hostname)?.[1] ?? "auto";
/** An S3 client for one bucket's settings (path-style: the bucket in the path, as R2 and the stand-ins want). */
export function s3Client(c: BucketSettings): S3Client {
  return new S3Client({
    region: regionOf(c.endpoint), endpoint: c.endpoint, forcePathStyle: true,
    // R2 does not implement the SDK's default flexible checksums on every operation: only send them when required.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key },
    maxAttempts: 2,
  });
}

let envTarget: { key: string; target: Target } | null = null;
let vaultTarget: { at: number; gen: number; target: Target | null } | null = null;

/** The vault's entry, when the vault is unlocked and holds one turned on (and its provider is on); counted as a use. */
async function fromVault(): Promise<BucketSettings | null> {
  const kv = await import("./keyvault.js");
  if (!kv.vaultUnlocked()) return null;
  const { asPlatform } = await import("./tenant-scope.js");
  const { getDb } = await import("./db.js");
  return asPlatform(async () => {
    const db = await getDb();
    const [row] = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
      `SELECT c.id, c.ciphertext, c.iv, c.tag, c.key_id FROM vault_credentials c JOIN vault_providers p ON p.slug = c.provider
        WHERE c.provider = $1 AND c.label = $2 AND c.enabled AND p.enabled`, [kv.OBJECT_STORAGE_PROVIDER, kv.OBJECT_STORAGE_LABEL]);
    if (!row) return null;
    let settings: BucketSettings;
    // A value that does not open or parse never reaches a message: say which, not what.
    try { settings = kv.checkObjectStorage(kv.decrypt(row)); }
    catch (e) { throw new Error(`object storage: the key vault's Object storage entry cannot be used (${/APP_VAULT_KEY|master key/.test((e as Error).message) ? "it was sealed with another vault key" : "re-enter it on Key vault"})`); }
    await db.query("UPDATE vault_credentials SET uses = uses + 1, last_used_at = now() WHERE id = $1", [row.id]);
    return settings;
  });
}

/** The bucket in use and where its settings came from, or null when neither the environment nor the vault has one. */
async function target(): Promise<Target | null> {
  if (storageInEnv()) {
    const c = { bucket: env.R2_BUCKET!, endpoint: env.R2_ENDPOINT!, access_key_id: env.R2_ACCESS_KEY_ID!, secret_access_key: env.R2_SECRET_ACCESS_KEY! };
    const key = JSON.stringify(c);
    if (envTarget?.key !== key) envTarget = { key, target: { source: "env", bucket: c.bucket, endpoint: c.endpoint, client: s3Client(c) } };
    return envTarget.target;
  }
  const { vaultGeneration } = await import("./keyvault.js");
  const gen = vaultGeneration();
  if (vaultTarget && vaultTarget.gen === gen && Date.now() - vaultTarget.at < VAULT_TTL_MS) return vaultTarget.target;
  const c = await fromVault();
  vaultTarget = { at: Date.now(), gen, target: c ? { source: "vault", bucket: c.bucket, endpoint: c.endpoint, client: s3Client(c) } : null };
  return vaultTarget.target;
}

/** Drop the vault entry's cached client now (tests; a change made by another process shows within VAULT_TTL_MS). */
export function forgetStorageSettings() { vaultTarget = null; }

/** Whether a bucket is configured, in the environment or in the key vault (APP_STORAGE_DIR does not count). */
export const s3Ready = async () => (await target()) !== null;
/** Where the object store's settings come from now: env, vault, dir (APP_STORAGE_DIR) or null (none). Never a value. */
export async function storageSource(): Promise<{ source: "env" | "vault" | "dir" | null; bucket: string | null }> {
  const t = await target().catch(() => null);
  if (t) return { source: t.source, bucket: t.bucket };
  return { source: localDir() ? "dir" : null, bucket: null };
}

async function s3(): Promise<{ client: S3Client; bucket: string }> {
  const t = await target();
  if (!t) throw new Error(NOT_CONFIGURED);
  return { client: t.client, bucket: t.bucket };
}

const safe = (s: string) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) throw new Error(`unsafe storage key part: ${s.slice(0, 40)}`);
  return s;
};
const month = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
/** Timestamp for object names: 2026-10-14T122551Z (sortable, no colons). */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/^(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

export const keys = {
  orgPrefix: (kind: "transcripts" | "research" | "reports" | "diffs" | "exports" | "workspaces", orgId: number) => `${kind}/org-${Math.trunc(orgId)}/`,
  transcript: (orgId: number, sessionId: string, endedAt: Date) => `transcripts/org-${Math.trunc(orgId)}/${month(endedAt)}/${safe(sessionId)}.jsonl.gz`,
  research: (orgId: number, researchId: string) => `research/org-${Math.trunc(orgId)}/${safe(researchId)}.json`,
  report: (orgId: number, simulationId: string, at: Date, ext: "pdf" | "html") => `reports/org-${Math.trunc(orgId)}/${safe(simulationId)}/${stamp(at)}.${ext}`,
  diff: (orgId: number, simulationId: string, sessionId: string) => `diffs/org-${Math.trunc(orgId)}/${safe(simulationId)}/${safe(sessionId)}.diff.gz`,
  workspace: (orgId: number, store: string, snapshotId: number) => `workspaces/org-${Math.trunc(orgId)}/${safe(store)}/${Math.trunc(snapshotId)}.wse`,
  transfer: (orgId: number, transferId: string) => `workspaces/org-${Math.trunc(orgId)}/.transfers/${safe(transferId)}.wst`,
};

export async function putObject(key: string, body: Buffer | string, contentType: string, meta: Record<string, string> = {}): Promise<void> {
  const { client, bucket } = await s3();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: meta }));
}

/** The object's bytes, or null when it does not exist. */
export async function getObject(key: string): Promise<Buffer | null> {
  const { client, bucket } = await s3();
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function listKeys(prefix: string, max = 100_000): Promise<{ key: string; size: number; modified: Date | null }[]> {
  const out: { key: string; size: number; modified: Date | null }[] = [];
  let token: string | undefined;
  const { client, bucket } = await s3();
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: Number(o.Size ?? 0), modified: o.LastModified ?? null });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && out.length < max);
  return out;
}

/** Delete objects by key, 1000 per request (organization deletion, src/tenancy.ts). */
export async function deleteKeys(list: string[]): Promise<void> {
  const { client, bucket } = await s3();
  for (let i = 0; i < list.length; i += 1000) {
    const r = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    if (r.Errors?.length) throw new Error(`object store delete failed for ${r.Errors.length} object(s), e.g. ${r.Errors[0]!.Key}: ${r.Errors[0]!.Message}`);
  }
}

/** A time-limited download link: 1 hour by default (docs/security.md), at most 7 days (the S3 maximum). */
export async function signedUrl(key: string, seconds = 3600, filename?: string): Promise<string> {
  const { client, bucket } = await s3();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, "")}"` } : {}) }),
    { expiresIn: Math.min(Math.max(60, seconds), 7 * 24 * 3600) });
}

/**
 * A time-limited upload link for one key (mold_v0-182): a PUT of the object's bytes, signed for that key only, valid
 * `seconds` (at least 60, at most an hour). A runner sends a body larger than its API accepts (Vercel: 4.5 MB per request)
 * straight to the bucket with it; nothing but that key can be written with it.
 */
export async function signedPutUrl(key: string, seconds = 900): Promise<string> {
  const { client, bucket } = await s3();
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: Math.min(Math.max(60, seconds), 3600) });
}

// ---------- the Key vault's Test (mold_v0-181) ----------

export interface BucketTest {
  ok: boolean; bucket: string; endpoint: string; ms: number;
  /** Each step tried, in order: write, read (the same bytes back), delete. */
  steps: { step: "write" | "read" | "delete"; ok: boolean }[];
  /** What went wrong, in words (never a key). */
  error: string | null;
}
/** Where the Test's object goes (ops/: internal one-offs); removed again by the Test itself. */
export const TEST_PREFIX = "ops/key-vault-test/";

/** An S3 error as a person can act on it; any key the message might carry is cut out. */
export function bucketErrorInWords(e: unknown, c: BucketSettings): string {
  const err = e as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; cause?: { code?: string } };
  const name = err.Code ?? err.name ?? "", status = err.$metadata?.httpStatusCode, code = err.code ?? err.cause?.code ?? "";
  const host = (() => { try { return new URL(c.endpoint).host; } catch { return c.endpoint; } })();
  const known: Record<string, string> = {
    NoSuchBucket: `There is no bucket named ${c.bucket} at ${host}: check the bucket's name (and that it was made in this account)`,
    InvalidAccessKeyId: "The access key id is not one this service knows: copy it again from the API token's page",
    SignatureDoesNotMatch: "The secret access key does not belong to this access key id: paste the secret again",
    AccessDenied: `The key was refused: give its API token read and write access to the bucket ${c.bucket}`,
    InvalidBucketName: `${c.bucket} is not a bucket name this service accepts`,
    PermanentRedirect: "The bucket lives at another address: use the endpoint the bucket's settings page shows",
    AuthorizationHeaderMalformed: "The service refused the key's region: check the endpoint is the bucket's own",
  };
  let words = known[name];
  if (!words && /ENOTFOUND|EAI_AGAIN/.test(code + (err.message ?? ""))) words = `${host} could not be found: check the endpoint`;
  if (!words && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|socket|timeout/i.test(code + (err.message ?? ""))) words = `${host} could not be reached (${code || "no answer"})`;
  if (!words && /certificate|CERT_|SSL/i.test(code + (err.message ?? ""))) words = `${host} answered with a certificate that is not trusted`;
  if (!words) words = `The service said ${name || "no reason"}${status ? ` (HTTP ${status})` : ""}${err.message && err.message !== name ? `: ${err.message.slice(0, 200)}` : ""}`;
  for (const v of [c.secret_access_key, c.access_key_id]) if (v && v.length >= 4) words = words.split(v).join("[hidden]");
  return words;
}

/**
 * Write one small object under TEST_PREFIX, read it back and delete it, with these settings (a fresh client: the cached
 * one is never used, so a Test of an edited entry tests the new values). Never throws; never returns or logs a key.
 */
export async function testBucket(c: BucketSettings): Promise<BucketTest> {
  const t0 = Date.now(), steps: BucketTest["steps"] = [];
  const out = (error: string | null): BucketTest => ({ ok: !error, bucket: c.bucket, endpoint: c.endpoint, ms: Date.now() - t0, steps, error });
  let client: S3Client;
  try { client = s3Client(c); } catch (e) { return out(bucketErrorInWords(e, c)); }
  const key = `${TEST_PREFIX}${stamp()}-${randomBytes(6).toString("hex")}.txt`;
  const body = `key vault test ${new Date().toISOString()}\n`;
  try {
    try {
      await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: body, ContentType: "text/plain" }));
      steps.push({ step: "write", ok: true });
    } catch (e) { steps.push({ step: "write", ok: false }); return out(bucketErrorInWords(e, c)); }
    let readError: string | null = null;
    try {
      const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
      const got = Buffer.from(await r.Body!.transformToByteArray()).toString("utf8");
      if (got !== body) readError = "The object read back is not the one written (a proxy or cache in front of the bucket?)";
      steps.push({ step: "read", ok: !readError });
    } catch (e) { steps.push({ step: "read", ok: false }); readError = bucketErrorInWords(e, c); }
    try {
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
      steps.push({ step: "delete", ok: true });
    } catch (e) { steps.push({ step: "delete", ok: false }); return out(readError ?? `${bucketErrorInWords(e, c)} (the test object ${key} was left in the bucket)`); }
    return out(readError);
  } finally { client.destroy(); }
}

// ---------- one interface over R2 or a local directory (mold_v0-033) ----------

/**
 * The object store a feature that must work offline uses (the workspace store, mold_v0-033): the bucket above when the
 * environment or the key vault configures one, else a local directory when APP_STORAGE_DIR is set (one machine, tests).
 * Same keys, same layout. None of them: it refuses (NOT_CONFIGURED), rather than keep data somewhere nobody chose.
 */
export interface ObjectStore {
  kind: "r2" | "local";
  /** Where a bucket's settings came from: the environment or the key vault (a local directory: "dir"). */
  source: "env" | "vault" | "dir";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  remove(keys: string[]): Promise<void>;
  /**
   * Time-limited links for one key (mold_v0-182), where the store is a bucket: an upload (PUT) and a download (GET).
   * A local directory has none (its API has no request size limit to go around).
   */
  links?: { put(key: string, seconds: number): Promise<string>; get(key: string, seconds: number): Promise<string> };
}

const localDir = () => (env.APP_STORAGE_DIR ? pathResolve(env.APP_STORAGE_DIR) : null);
const localPath = (root: string, key: string) => {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.split("/").some((x) => !x || x === "." || x === "..")) throw new Error(`unsafe storage key: ${key.slice(0, 80)}`);
  return pathJoin(root, key);
};

export async function objectStore(): Promise<ObjectStore> {
  const t = await target();
  if (t) return {
    kind: "r2", source: t.source,
    put: (key, body, type) => putObject(key, body, type),
    get: (key) => getObject(key),
    list: async (prefix) => (await listKeys(prefix)).map((o) => o.key),
    remove: (list) => deleteKeys(list),
    links: { put: (key, seconds) => signedPutUrl(key, seconds), get: (key, seconds) => signedUrl(key, seconds) },
  };
  const root = localDir();
  if (!root) throw new Error(NOT_CONFIGURED);
  return {
    kind: "local", source: "dir",
    put: async (key, body) => { const p = localPath(root, key); await mkdir(pathDirname(p), { recursive: true }); await writeFile(p, body, { mode: 0o600 }); },
    get: async (key) => { try { return await readFile(localPath(root, key)); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; } },
    list: async (prefix) => {
      const base = localPath(root, prefix.replace(/\/$/, ""));
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return; throw e; }
        for (const e of entries) {
          const p = pathJoin(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) out.push(pathRelative(root, p).split(pathSep).join("/"));
        }
      };
      await walk(base);
      return out.sort();
    },
    remove: async (list) => { for (const k of list) await rm(localPath(root, k), { force: true }); },
  };
}
