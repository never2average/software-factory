import { NextRequest, NextResponse } from "next/server";
import { filesystemUrlRules } from "@/lib/storage/filesystem";
import { filesystemSettings, storageKind } from "@/lib/storage/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/storage/object/<key>?exp=<epoch ms>&sig=<signature>
 *
 * Serves ONE stored object to the holder of a signed link, on a deployment whose file store is a directory on this
 * server (`STORAGE_DRIVER=filesystem`). It is what a Vercel Blob presigned GET is on the default driver, and it
 * exists only because a directory has no such thing of its own. On any other driver this route answers 404.
 *
 * THE LINK IS THE CREDENTIAL, exactly as today's presigned URL is: it names one key, is GET-only, expires, and cannot
 * be made or altered without STORAGE_SIGNING_SECRET (lib/storage/signed-url.ts). The agent's sandbox, which holds no
 * session, downloads a workbook with one; the artifact proxy follows one for a preview. Nothing here trusts the
 * caller to say which file it wants: the key is in the signed part.
 *
 * WHO GETS A LINK is decided where it always was, before one is signed:
 *   - /api/ops/artifact-link verifies the caller and signs only an artifact of the caller's own workspace;
 *   - the agent's store is built for one workspace and signs only keys under that workspace's prefix.
 * And a link can only ever name `dataroom/orgs/<workspace>/…` or `artifacts/orgs/<workspace>/…`: the driver refuses to
 * sign anything else and this route refuses to serve it, so the probe object, another tree, or a path with a dot
 * segment is unreachable even with the secret's signature on it.
 *
 * There is no directory listing, no unsigned read, and the storage directory is not under the web root.
 *
 * THE RESPONSE IS INERT ON THIS ORIGIN. A published artifact can be HTML written by the model, an upload carries
 * whatever content type its uploader declared, and on this driver both are served from the app's own address (on
 * Vercel Blob they live on another host). `Content-Security-Policy: sandbox` gives the document a unique origin, so
 * a script in it cannot read the signed-in user's token from this site's storage or call the API as them: the same
 * confinement the preview iframe applies (`sandbox="allow-scripts"`). It is sent for EVERY type except a PDF, which
 * a browser will not draw inside a sandbox and which cannot run script on this origin; `nosniff` keeps a PDF a PDF.
 *
 * tenancy-ok: no tenant rows are read. The key carries the workspace, and it is fixed by the signature.
 */
/** A unique origin for whatever is served, with scripts allowed inside it (as the preview iframe allows them). */
const OBJECT_CSP = "sandbox allow-scripts";

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  let settings;
  try {
    if (storageKind() !== "filesystem") return refuse(404, "Not found");
    settings = filesystemSettings();
  } catch {
    // The driver is selected but a setting is missing: there is nothing to serve (the health check says which).
    return refuse(404, "Not found");
  }

  // The driver checks the path, the signature and the expiry itself. It is handed the path and query of the request
  // on the origin it signs links for, so a forwarded host header cannot change what is verified.
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, settings.publicUrl);
  const upstream = await filesystemUrlRules(settings).open(url);
  if (upstream.status === 403) return refuse(403, "This file link is invalid or has expired.");
  if (upstream.status === 404 || upstream.body === null) return refuse(404, "Not found");

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  headers.set("content-type", contentType);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", "inline");
  // Decided from the type being SERVED: anything a browser might render as a document is sandboxed.
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/pdf") headers.set("content-security-policy", OBJECT_CSP);
  // One workspace's file: never in a shared cache.
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  return new NextResponse(upstream.body, { status: 200, headers });
}
