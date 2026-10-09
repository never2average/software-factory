/**
 * THE APP'S OWN EXPIRING FILE LINKS, for a store that has no signed URLs of its own (the filesystem driver).
 *
 * Vercel Blob hands out a presigned GET: a URL that names one object, expires, and is the whole authority to read
 * that object for whoever holds it. The agent gives one to its sandbox to download a workbook, and the console gets a
 * fresh one from /api/ops/artifact-link after the caller's workspace has been checked. A directory on disk has
 * nothing like it, so the app signs the same thing itself:
 *
 *     <STORAGE_PUBLIC_URL>/api/storage/object/<key>?exp=<epoch ms>&sig=<HMAC-SHA256(secret, "GET\n<key>\n<exp>")>
 *
 * Same properties, no more and no less: one key, GET only, an expiry, unforgeable without STORAGE_SIGNING_SECRET.
 * The key stays in the PATH so a link still ends in the file's name (the console reads the extension from it).
 * app/api/storage/object/[...key]/route.ts is the only thing that honours one.
 */
import "./server-guard.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isStorageKey } from "./keys.ts";

/** Where the web app serves signed links from. */
export const STORAGE_OBJECT_ROUTE = "/api/storage/object";

/** The only namespaces a link is ever signed or honoured for: a workspace's data room, a workspace's artifacts. */
const SERVED = /^(?:dataroom|artifacts)\/orgs\/[^/]+\/.+/;

/** May a signed link exist for this key at all? */
export function isServableKey(key: unknown): key is string {
  return isStorageKey(key) && SERVED.test(key);
}

function signature(secret: string, key: string, exp: number): string {
  return createHmac("sha256", secret).update(`GET\n${key}\n${exp}`).digest("base64url");
}

export function signObjectUrl(input: { publicUrl: string; secret: string; key: string; expiresAt: number }): string {
  const path = input.key.split("/").map(encodeURIComponent).join("/");
  return `${input.publicUrl}${STORAGE_OBJECT_ROUTE}/${path}?exp=${input.expiresAt}&sig=${signature(input.secret, input.key, input.expiresAt)}`;
}

export type SignedLinkVerdict = "ok" | "expired" | "invalid";

/** Check a link's signature and expiry. Constant-time on the signature; an unparsable expiry is invalid, not expired. */
export function verifyObjectLink(input: { secret: string; key: string; exp: string | null; sig: string | null; now?: number }): SignedLinkVerdict {
  const { secret, key, exp, sig } = input;
  if (!exp || !sig || !/^\d{1,16}$/.test(exp) || !isServableKey(key)) return "invalid";
  const expiresAt = Number(exp);
  const want = Buffer.from(signature(secret, key, expiresAt));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "invalid";
  return expiresAt > (input.now ?? Date.now()) ? "ok" : "expired";
}

/** The key in a signed link's path, or null when the path is not one of ours or does not decode to a key. */
export function keyFromObjectPath(pathname: string): string | null {
  const prefix = `${STORAGE_OBJECT_ROUTE}/`;
  if (!pathname.startsWith(prefix)) return null;
  let key: string;
  try {
    key = pathname
      .slice(prefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
  // A decoded segment that itself holds a slash or a dot segment would be a different key than the one signed.
  return isStorageKey(key) && key.split("/").length === pathname.slice(prefix.length).split("/").length ? key : null;
}
