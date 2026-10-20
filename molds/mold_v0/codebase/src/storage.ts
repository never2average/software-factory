import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Off-machine object storage: one private Cloudflare R2 bucket (R2_BUCKET, today `octillion-backup`) with one prefix per
 * kind of data. This module is the only place that knows the layout (docs/storage.md):
 *
 *   postgres/                                      hourly pg_dump files (pg-backup-offsite service, 30-day retention)
 *   transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz   every finished session's trace (archive.ts), kept
 *   research/org-<id>/<research_id>.json           onboarding research results (archive.ts), kept
 *   reports/org-<id>/<simulation>/<stamp>.{pdf,html}    run reports (reports.ts), kept
 *   diffs/org-<id>/<simulation>/<session>.diff.gz  reserved: workspace diffs
 *   exports/org-<id>/...                           reserved: customer data exports
 *   ops/...                                        internal one-offs
 *
 * Customer data always sits under its org's prefix, so access can be scoped per org by construction. The org id (not
 * the slug) is used: slugs can be renamed, ids cannot.
 */

const env = process.env;
export const storageEnabled = () => Boolean(env.R2_BUCKET && env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
const bucket = () => env.R2_BUCKET!;

let client: S3Client | null = null;
function s3(): S3Client {
  if (!storageEnabled()) throw new Error("object storage is not configured (R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  client ??= new S3Client({
    region: "auto", endpoint: env.R2_ENDPOINT, forcePathStyle: true,
    // R2 does not implement the SDK's default flexible checksums on every operation: only send them when required.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
  });
  return client;
}

const safe = (s: string) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) throw new Error(`unsafe storage key part: ${s.slice(0, 40)}`);
  return s;
};
const month = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
/** Timestamp for object names: 2026-10-14T122551Z (sortable, no colons). */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/^(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

export const keys = {
  orgPrefix: (kind: "transcripts" | "research" | "reports" | "diffs" | "exports", orgId: number) => `${kind}/org-${Math.trunc(orgId)}/`,
  transcript: (orgId: number, sessionId: string, endedAt: Date) => `transcripts/org-${Math.trunc(orgId)}/${month(endedAt)}/${safe(sessionId)}.jsonl.gz`,
  research: (orgId: number, researchId: string) => `research/org-${Math.trunc(orgId)}/${safe(researchId)}.json`,
  report: (orgId: number, simulationId: string, at: Date, ext: "pdf" | "html") => `reports/org-${Math.trunc(orgId)}/${safe(simulationId)}/${stamp(at)}.${ext}`,
  diff: (orgId: number, simulationId: string, sessionId: string) => `diffs/org-${Math.trunc(orgId)}/${safe(simulationId)}/${safe(sessionId)}.diff.gz`,
};

export async function putObject(key: string, body: Buffer | string, contentType: string, meta: Record<string, string> = {}): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, Metadata: meta }));
}

/** The object's bytes, or null when it does not exist. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
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
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: Number(o.Size ?? 0), modified: o.LastModified ?? null });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && out.length < max);
  return out;
}

/** Delete objects by key, 1000 per request (organization deletion, src/tenancy.ts). */
export async function deleteKeys(list: string[]): Promise<void> {
  for (let i = 0; i < list.length; i += 1000) {
    const r = await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    if (r.Errors?.length) throw new Error(`R2 delete failed for ${r.Errors.length} object(s), e.g. ${r.Errors[0]!.Key}: ${r.Errors[0]!.Message}`);
  }
}

/** A time-limited download link: 1 hour by default (docs/security.md), at most 7 days (the S3 maximum). */
export async function signedUrl(key: string, seconds = 3600, filename?: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, "")}"` } : {}) }),
    { expiresIn: Math.min(Math.max(60, seconds), 7 * 24 * 3600) });
}
