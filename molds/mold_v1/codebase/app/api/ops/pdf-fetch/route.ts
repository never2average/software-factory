import { NextRequest, NextResponse } from "next/server";
import { verifyOpsAuth } from "@/lib/ops-auth";
import {
  SafeFetchError,
  guardedPdfFetch,
  openPdfStream,
  statusForCode,
  type SafeFetchCode,
} from "@/lib/safe-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/ops/pdf-fetch?url=<https link to a PDF>  ->  the PDF's bytes
 *
 * The in-app PDF viewer's only way to read a PDF that lives on someone else's
 * site. The page's CSP forbids the browser from framing or fetching another
 * host, and that policy stays as it is — so the server fetches, under the rules
 * in lib/safe-fetch.ts (public https hosts only, pinned connection, redirects
 * re-checked), and ONLY a PDF ever leaves this route: the body must carry the
 * `%PDF-` header, whatever content-type the other side claims. That is what
 * stops this being a general-purpose "fetch any page through our server".
 *
 * Signed-in callers only: proxy.ts gates every /api/ops/* path on a verified
 * identity, and the check is repeated here so the route is safe on its own.
 * Nothing of the caller's (cookies, bearer token) is sent upstream.
 *
 * tenancy-ok: reads no tenant rows — it fetches a public document by URL.
 */
function fail(code: SafeFetchCode, message: string) {
  return NextResponse.json(
    { error: message, code },
    { status: statusForCode(code), headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "Sign in to preview this file.", code: "unauthorized" }, { status: 401 });
  }

  let upstream: Awaited<ReturnType<typeof guardedPdfFetch>>;
  try {
    upstream = await guardedPdfFetch(request.nextUrl.searchParams.get("url") ?? "");
  } catch (err) {
    if (err instanceof SafeFetchError) return fail(err.code, err.message);
    return fail("upstream_error", "That file could not be fetched.");
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await openPdfStream(upstream.body, upstream.done);
  } catch (err) {
    if (err instanceof SafeFetchError) return fail(err.code, err.message);
    return fail("upstream_error", "That file could not be fetched.");
  }

  const headers = new Headers({
    "content-type": "application/pdf",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "private, max-age=300",
  });
  if (upstream.contentLength !== null) headers.set("content-length", String(upstream.contentLength));
  return new NextResponse(stream, { status: 200, headers });
}
