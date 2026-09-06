import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/artifact-proxy?url=<presigned blob GET>
 *
 * Streams a private artifact SAME-ORIGIN. Two reasons the browser cannot fetch
 * the blob host itself: the CSP allows `frame-src 'self'` only (an HTML artifact
 * preview is an iframe), and `connect-src 'self'` blocks the cross-origin fetch
 * the spreadsheet/markdown renderers make.
 *
 * `url` must already be a valid, unexpired presigned GET — that signature IS the
 * authorization, and it is scoped to one object. This route deliberately holds
 * no store token, so it cannot upgrade a bare pathname into a read: callers get
 * a fresh signature from /api/ops/artifact-link, which verifies the caller
 * first. An upstream 403 therefore means the signature expired, not that the
 * object is missing — say so, because "Artifact fetch failed" sent everyone
 * hunting for a broken file that was fine all along.
 */
function isAllowedArtifactHost(hostname: string): boolean {
  return hostname === "vercel-storage.com" || hostname.endsWith(".vercel-storage.com");
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing artifact URL" }, { status: 400 });
  }

  let artifactUrl: URL;
  try {
    artifactUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid artifact URL" }, { status: 400 });
  }

  if (artifactUrl.protocol !== "https:" || !isAllowedArtifactHost(artifactUrl.hostname)) {
    return NextResponse.json({ error: "Artifact host is not allowed" }, { status: 400 });
  }

  const upstream = await fetch(artifactUrl, { cache: "no-store" });
  if (!upstream.ok) {
    const expired = upstream.status === 401 || upstream.status === 403;
    return NextResponse.json(
      {
        error: expired
          ? "This artifact link has expired — reopen the artifact for a fresh one."
          : "Artifact fetch failed",
        expired,
      },
      { status: upstream.status },
    );
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  return new NextResponse(upstream.body, { status: 200, headers });
}
