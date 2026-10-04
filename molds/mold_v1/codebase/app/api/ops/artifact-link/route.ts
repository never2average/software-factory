import { NextRequest, NextResponse } from "next/server";
import { signStoredObject, storageConfigured } from "@/lib/dataroom-blob";
import { orgContextForRequest } from "@/lib/org-context";
import { storageUrlRules } from "@/lib/storage/urls";
import { storageErrorResponse, storageMisconfigured } from "@/lib/storage-http";

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
 * store answers 403, and the preview, the spreadsheet renderer and the
 * download button all break at once. A credential minted at write time cannot
 * authenticate a read that happens later; the read has to authenticate itself.
 *
 * (A private object is never fetchable by its plain address, and a signed GET
 * is a capability that EXPIRES: a link minted once at write time is not an
 * access mechanism, it is a countdown. That holds on every storage driver.)
 *
 * So the browser now identifies an artifact by its PATHNAME (stable) and asks
 * this route — behind the same verified-identity gate as the rest of the Ops
 * API — for a short-lived GET at the moment it wants to read. Nothing is ever
 * made public, and the store token stays on the server.
 *
 * An artifact is filed under its workspace, `artifacts/orgs/<org_id>/…`
 * (agent/lib/artifact.ts artifactKey), and this route signs one ONLY for a
 * caller in that workspace: another workspace's artifact is "not found", however
 * its pathname was learned. `artifacts/` used to be one flat namespace shared by
 * every workspace, scoped by nothing but possession of the pathname.
 *
 * Artifacts published before that are still flat (`artifacts/<name>-<suffix>`)
 * and name no workspace, so nothing can say whose they are; they stay readable
 * by their unguessable pathname, as before, and no NEW one is ever written there.
 * Reads outside `artifacts/` — the data room — are refused: those go through
 * /api/ops/dataroom, which IS org-scoped.
 */

/** The only namespace a published artifact can live in. */
const ARTIFACT_PREFIX = "artifacts/";
/** Long enough to open, render and download; short enough to be worthless if leaked. */
const LINK_TTL_MS = 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;

  // A misconfigured store (a mistyped STORAGE_DRIVER, a selected driver missing a setting) is a 503 naming the setting,
  // never "empty" and never "not configured" (lib/storage-http.ts). Null, and nothing else happens, when nothing is wrong.
  const misconfigured = storageMisconfigured();
  if (misconfigured) return misconfigured;
  if (!storageConfigured()) {
    return NextResponse.json({ error: "Artifact storage is not configured." }, { status: 503 });
  }

  const params = request.nextUrl.searchParams;
  const rawUrl = params.get("url");
  // Accept the legacy published link too: we take only its pathname and throw
  // away its (possibly long-expired) signature. Which URLs are the store's, and
  // where the pathname sits in one, is the storage driver's to say.
  const path = params.get("path") ?? (rawUrl ? storageUrlRules().keyFromUrl(rawUrl) : null);
  if (!path) {
    return NextResponse.json({ error: "Missing or invalid artifact path." }, { status: 400 });
  }
  // One canonical spelling, or none: an empty, `.` or `..` segment (`artifacts//orgs/…`, `artifacts/./orgs/…`) or a
  // percent-encoded dot or slash would reach the workspace check below in a form it does not recognise — and the
  // blob store would still resolve it. Such a path is refused, never normalised into a match.
  const segments = path.split("/");
  if (
    !path.startsWith(ARTIFACT_PREFIX) ||
    segments.some((seg) => seg === "" || seg === "." || seg === "..") ||
    /%2[ef]|%5c/i.test(path)
  ) {
    return NextResponse.json({ error: "Not a published artifact." }, { status: 400 });
  }
  // A workspace's artifact is signed for that workspace only. Another workspace's reads as absent (404, never 403).
  if (path.startsWith(`${ARTIFACT_PREFIX}orgs/`) && !path.startsWith(`${ARTIFACT_PREFIX}orgs/${ctx.orgId}/`)) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  try {
    const signed = await signStoredObject(path, LINK_TTL_MS);
    if (!signed) return NextResponse.json({ error: "Artifact storage is not configured." }, { status: 503 });
    const { url, expiresAt } = signed;
    return NextResponse.json({
      path,
      url,
      // Same-origin route the preview iframe must use: the CSP allows
      // `frame-src 'self'`, never the store's host.
      proxyUrl: `/api/artifact-proxy?url=${encodeURIComponent(url)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    const misconfiguredNow = storageErrorResponse(error);
    if (misconfiguredNow) return misconfiguredNow;
    const message = error instanceof Error ? error.message : "Could not sign the artifact link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
