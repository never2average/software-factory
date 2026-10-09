/**
 * Where Vercel Blob objects are addressed. Split from the driver (lib/storage/vercel-blob.ts) so that code which only
 * FOLLOWS a link (the artifact proxy, the PDF fetcher) does not load the Vercel client, and so that it works with no
 * token: the artifact proxy has never held one.
 */
import "./server-guard.ts";
import { isVercelBlobHost } from "./hosts.ts";
import type { StorageUrlRules } from "./types.ts";

export const vercelBlobUrlRules: StorageUrlRules = {
  kind: "vercel-blob",
  ownsHost: isVercelBlobHost,
  ownsUrl(url) {
    return url.protocol === "https:" && isVercelBlobHost(url.hostname);
  },
  /**
   * The blob pathname a URL points at: the object's stable identity, as opposed to the signed query string, which is
   * only its (expiring) credential.
   */
  keyFromUrl(rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || !isVercelBlobHost(parsed.hostname)) return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
    return pathname.length > 0 ? pathname : null;
  },
  open(url, fetchInit) {
    return fetchInit === undefined ? fetch(url) : fetch(url, fetchInit);
  },
};
