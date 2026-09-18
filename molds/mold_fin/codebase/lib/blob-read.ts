/**
 * Reading a PRIVATE Vercel Blob object from the NEXT runtime.
 *
 * A private blob's plain `url` is never fetchable (the CDN answers 403), and a
 * presigned GET is a CAPABILITY THAT EXPIRES. So a link minted once at write
 * time is not an access mechanism — it is a countdown. Anything that wants to
 * read an object must mint its own short-lived GET at read time, from the store
 * token, which is what `presignBlobRead` is for.
 *
 * Both blob readers in this runtime (the data room in `lib/dataroom-blob.ts`
 * and the artifact link route) go through here, so there is exactly one place
 * that knows how a private read is authenticated.
 */
import "server-only";

import { issueSignedToken, presignUrl } from "@vercel/blob";

/** Hosts a Vercel Blob object can live on. */
export function isBlobHost(hostname: string): boolean {
  return hostname === "vercel-storage.com" || hostname.endsWith(".vercel-storage.com");
}

/**
 * The blob pathname a URL points at — the object's stable identity, as opposed
 * to the signed query string, which is only its (expiring) credential. Returns
 * null for anything that is not a blob URL, so callers can refuse it.
 */
export function blobPathnameFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !isBlobHost(parsed.hostname)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  return pathname.length > 0 ? pathname : null;
}

/**
 * A short-lived presigned GET for one private object. `token` is the store's
 * read-write token; the returned URL grants `get` on that pathname alone, until
 * `ttlMs` from now.
 */
export async function presignBlobRead(
  token: string,
  pathname: string,
  ttlMs: number,
): Promise<{ url: string; expiresAt: number }> {
  const validUntil = Date.now() + ttlMs;
  const signed = await issueSignedToken({ token, pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(
    { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
    { operation: "get", pathname, access: "private", validUntil: signed.validUntil },
  );
  return { url: presignedUrl, expiresAt: signed.validUntil };
}
