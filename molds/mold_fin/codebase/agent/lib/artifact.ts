/**
 * Artifact publishing: take generated content and store it PRIVATELY in Vercel
 * Blob (no public URL), then mint a short-lived signed GET URL so only a holder
 * of that link can open it, and only until it expires. This is how any agent —
 * root or subagent — hands a customer-ready deliverable (status report,
 * migration plan, eval summary, dashboard) back as an authenticated link.
 *
 * Requires BLOB_READ_WRITE_TOKEN (a private Vercel Blob store on the API
 * project). The store is private, so the blob is never world-readable.
 */
import { issueSignedToken, presignUrl, put } from "@vercel/blob";

const TYPE_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** How long a published artifact link stays valid. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PublishArtifactInput {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export async function publishArtifact({
  filename,
  content,
  contentType,
}: PublishArtifactInput): Promise<{ url: string; pathname: string; expiresAt: string }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "Artifact publishing is not configured: set BLOB_READ_WRITE_TOKEN (a private Vercel Blob store on the API project) to enable publish_artifact.",
    );
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const type = contentType ?? TYPE_BY_EXT[ext] ?? "application/octet-stream";

  // Store privately — the blob is not world-readable.
  const blob = await put(`artifacts/${filename}`, content, {
    access: "private",
    contentType: type,
    token,
    addRandomSuffix: true,
  });

  // Mint a short-lived signed GET URL scoped to just this object.
  const validUntil = Date.now() + LINK_TTL_MS;
  const signed = await issueSignedToken({
    token,
    pathname: blob.pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(
    { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
    { operation: "get", pathname: blob.pathname, access: "private", validUntil: signed.validUntil },
  );

  return {
    url: presignedUrl,
    pathname: blob.pathname,
    expiresAt: new Date(signed.validUntil).toISOString(),
  };
}
