/**
 * WHICH HOSTS ARE THE FILE STORE'S — the part of the storage driver a BROWSER can ask.
 *
 * Imports nothing and reads only `NEXT_PUBLIC_*` settings, so a client component can use it
 * (app/_components/artifact-view.tsx decides whether a link in a chat is one of ours). The server asks the driver
 * itself: `storageUrlRules().ownsHost(...)` (lib/storage/urls.ts).
 *
 * The default store is Vercel Blob, and this is the one place its host name is written.
 */

/** A Vercel Blob object lives on `<store>.private.blob.vercel-storage.com` (or the public twin). */
export function isVercelBlobHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "vercel-storage.com" || h.endsWith(".vercel-storage.com");
}

/** `NEXT_PUBLIC_STORAGE_HOST`: the host names (comma-separated) signed links to the store are served from. */
export function publicStorageHosts(value: string | undefined = process.env.NEXT_PUBLIC_STORAGE_HOST): string[] | null {
  if (!value) return null;
  const hosts = value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : null;
}

/**
 * Is this hostname the file store's, as far as the browser knows?
 *
 * Unset `NEXT_PUBLIC_STORAGE_HOST` is the Vercel Blob rule, unchanged. A deployment on the filesystem driver serves
 * its files from the app's own origin, which callers already treat as theirs, so it needs nothing here. One on an S3
 * bucket sets the bucket's host name at build time.
 */
export function isStorageHostForBrowser(hostname: string, configured: string[] | null = publicStorageHosts()): boolean {
  const h = hostname.toLowerCase();
  if (configured) return configured.includes(h);
  return isVercelBlobHost(h);
}
