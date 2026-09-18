import { NextRequest, NextResponse } from "next/server";
import { blobPathnameFromUrl, presignBlobRead } from "@/lib/blob-read";
import { blobToken } from "@/lib/dataroom-blob";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/artifact-link?path=artifacts/…   (or ?url=<a published link>)
 *   -> { path, url, proxyUrl, expiresAt }
 *
 * Mints a FRESH read credential for one published artifact.
 *
 * Why this exists: `publish_artifact` returns a presigned GET that lives for
 * seven days, and that link was the ONLY way the UI could read the object back.
 * Past the seventh day — or for any artifact reopened from an older chat — the
 * blob CDN answers 403, and the preview, the spreadsheet renderer and the
 * download button all break at once. A credential minted at write time cannot
 * authenticate a read that happens later; the read has to authenticate itself.
 *
 * So the browser now identifies an artifact by its PATHNAME (stable) and asks
 * this route — behind the same verified-identity gate as the rest of the Ops
 * API — for a short-lived GET at the moment it wants to read. Nothing is ever
 * made public, and the store token stays on the server.
 *
 * `artifacts/` is a flat namespace shared by every workspace (the publish tool
 * writes no org prefix), so possession of the unguessable pathname is what
 * scopes a read here, exactly as possession of the signed link did before.
 * Reads outside that namespace — the data room — are refused: those go through
 * /api/ops/dataroom, which IS org-scoped.
 */

/** The only namespace a published artifact can live in. */
const ARTIFACT_PREFIX = "artifacts/";
/** Long enough to open, render and download; short enough to be worthless if leaked. */
const LINK_TTL_MS = 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = blobToken();
  if (!token) {
    return NextResponse.json({ error: "Artifact storage is not configured." }, { status: 503 });
  }

  const params = request.nextUrl.searchParams;
  const rawUrl = params.get("url");
  // Accept the legacy published link too: we take only its pathname and throw
  // away its (possibly long-expired) signature.
  const path = params.get("path") ?? (rawUrl ? blobPathnameFromUrl(rawUrl) : null);
  if (!path) {
    return NextResponse.json({ error: "Missing or invalid artifact path." }, { status: 400 });
  }
  if (!path.startsWith(ARTIFACT_PREFIX) || path.includes("..")) {
    return NextResponse.json({ error: "Not a published artifact." }, { status: 400 });
  }

  try {
    const { url, expiresAt } = await presignBlobRead(token, path, LINK_TTL_MS);
    return NextResponse.json({
      path,
      url,
      // Same-origin route the preview iframe must use: the CSP allows
      // `frame-src 'self'`, never the blob host.
      proxyUrl: `/api/artifact-proxy?url=${encodeURIComponent(url)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sign the artifact link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
