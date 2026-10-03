/**
 * The Vercel Blob driver: the DEFAULT, and the only file in the application that imports `@vercel/blob`
 * (`npm run check:storage-driver` fails on a second one).
 *
 * Every method makes the call its callers made before the driver existed, with the same arguments:
 *
 *   put         put(key, body, { access: "private", token, …the caller's options, absent ones left absent })
 *   get         issueSignedToken + presignUrl for a GET, then fetch(url) (or fetch(url, init) when the caller gave one)
 *   head        head(ref, { token })
 *   list        list({ token, …the caller's params })
 *   delete      del(refs, { token })
 *   signedUrl   issueSignedToken({ token, pathname, operations: ["get"], validUntil }) + presignUrl(…)
 *
 * Options are passed through as given, not normalised: the client sends no `x-allow-overwrite` header when the
 * option is absent and "0" when it is false, and a published artifact relies on the first.
 * scripts/test-storage-default-unchanged.mjs compares all of it with a recording made before this file existed.
 */
import { del, head, issueSignedToken, list as listBlobs, presignUrl, put } from "@vercel/blob";
import type { StorageDriver } from "./types.ts";
import { vercelBlobUrlRules } from "./vercel-blob-urls.ts";

export function createVercelBlobDriver(token: string): StorageDriver {
  async function signedUrl(key: string, ttlMs: number) {
    const validUntil = Date.now() + ttlMs;
    const signed = await issueSignedToken({ token, pathname: key, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
      { operation: "get", pathname: key, access: "private", validUntil: signed.validUntil },
    );
    return { url: presignedUrl, expiresAt: signed.validUntil };
  }

  return {
    kind: "vercel-blob",
    urls: vercelBlobUrlRules,
    async put(key, body, options = {}) {
      const blob = await put(key, body as string | Buffer, { access: "private", token, ...options });
      return { key: blob.pathname, ref: blob.url };
    },
    async get(key, { ttlMs, fetchInit }) {
      // A private blob's plain URL is never fetchable (the CDN answers 403): a read mints its own short-lived GET.
      const { url } = await signedUrl(key, ttlMs);
      const response = fetchInit === undefined ? await fetch(url) : await fetch(url, fetchInit);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`blob read failed for "${key}": HTTP ${response.status}`);
      return response;
    },
    async head(ref) {
      const meta = await head(ref, { token });
      return meta ? { size: meta.size } : null;
    },
    async list(params) {
      const page = await listBlobs({ token, ...params });
      return {
        objects: page.blobs.map((blob) => ({ key: blob.pathname, size: blob.size })),
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    },
    async delete(refs) {
      await del(refs, { token });
    },
    signedUrl,
  };
}
