/**
 * Artifact publishing: take generated content and store it PRIVATELY in the
 * file store (no public URL), then mint a short-lived signed GET URL so only a
 * holder of that link can open it, and only until it expires. This is how any
 * agent — root or subagent — hands a customer-ready deliverable (status report,
 * migration plan, eval summary, dashboard) back as an authenticated link.
 *
 * The store is whichever the deployment selected (lib/storage): by default a
 * private Vercel Blob store on the API project, which needs
 * BLOB_READ_WRITE_TOKEN. The store is private, so the object is never
 * world-readable.
 */
import { requireWorkspace } from "../../lib/dataroom-keyspace.ts";
import { storageDriver } from "../../lib/storage/index.ts";

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

/** Where a workspace's artifact is filed: `artifacts/orgs/<org_id>/<filename>` (the store adds a random suffix). */
export function artifactKey(orgId: string, filename: string): string {
  return `artifacts/orgs/${requireWorkspace(orgId)}/${filename}`;
}

/** How long a published artifact link stays valid. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PublishArtifactInput {
  /**
   * The workspace publishing it. Required: an artifact is filed under `artifacts/orgs/<org_id>/`, and the console's
   * link route (app/api/ops/artifact-link) signs one only for a caller in that workspace. `artifacts/` used to be one
   * flat namespace shared by every workspace, where possession of a pathname was the only thing scoping a read.
   */
  orgId: string;
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export async function publishArtifact({
  orgId,
  filename,
  content,
  contentType,
}: PublishArtifactInput): Promise<{ url: string; pathname: string; expiresAt: string }> {
  const store = storageDriver();
  if (!store) {
    throw new Error(
      "Artifact publishing is not configured: set BLOB_READ_WRITE_TOKEN (a private Vercel Blob store on the API project) to enable publish_artifact.",
    );
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const type = contentType ?? TYPE_BY_EXT[ext] ?? "application/octet-stream";

  // Store privately — the object is not world-readable. The store adds the unguessable suffix.
  const stored = await store.put(artifactKey(orgId, filename), content, {
    contentType: type,
    addRandomSuffix: true,
  });

  // Mint a short-lived signed GET URL scoped to just this object.
  const signed = await store.signedUrl(stored.key, LINK_TTL_MS);

  return {
    url: signed.url,
    pathname: stored.key,
    expiresAt: new Date(signed.expiresAt).toISOString(),
  };
}
