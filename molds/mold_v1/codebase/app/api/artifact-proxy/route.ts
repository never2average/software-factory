import { NextRequest, NextResponse } from "next/server";
import { storageUrlRules } from "@/lib/storage/urls";
import type { StorageUrlRules } from "@/lib/storage/types";

/**
 * GET /api/artifact-proxy?url=<signed GET for one stored object>
 *
 * Streams a private artifact SAME-ORIGIN. Two reasons the browser cannot fetch
 * the store's host itself: the CSP allows `frame-src 'self'` only (an HTML artifact
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
 *
 * WHICH URLs it will follow is the storage driver's answer (lib/storage/urls.ts),
 * not a host name written here: by default an https URL on the Vercel Blob host,
 * exactly as before. Anything else is refused before any request is made, so
 * this route cannot be pointed at an arbitrary address.
 */
function storeLinks(): StorageUrlRules | null {
  try {
    return storageUrlRules();
  } catch {
    // The selected driver is missing a setting: there is no store to follow a link into.
    return null;
  }
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

  const links = storeLinks();
  if (!links || !links.ownsUrl(artifactUrl)) {
    return NextResponse.json({ error: "Artifact host is not allowed" }, { status: 400 });
  }

  const upstream = await links.open(artifactUrl, { cache: "no-store" });
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
