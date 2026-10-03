/**
 * THE FILE STORE, AS ONE INTERFACE.
 *
 * Everything the application keeps as a file (the data room, version snapshots, published artifacts, the health
 * probe) is an object under a KEY in one private store. This is the whole surface the application uses; which store
 * answers it is a deployment setting (lib/storage/index.ts):
 *
 *   vercel-blob   lib/storage/vercel-blob.ts   the default, and the only file that imports `@vercel/blob`
 *   filesystem    lib/storage/filesystem.ts    a directory on the server's own disk
 *   s3            lib/storage/s3.ts            any S3-compatible bucket (DigitalOcean Spaces, MinIO)
 *
 * Keys are the same on every driver: `dataroom/orgs/<workspace>/<dm.md path>` and `artifacts/orgs/<workspace>/<file>`
 * (lib/dataroom-keyspace.ts, agent/lib/artifact.ts). A driver never invents, rewrites or widens a key: workspace
 * scoping is decided by the caller that builds the key, exactly as it was when the callers held `@vercel/blob`
 * themselves, and a driver only refuses keys that could address something outside the store.
 *
 * The methods are shaped by what the callers did before this interface existed, so that the default driver can make
 * the same calls with the same arguments (scripts/test-storage-default-unchanged.mjs holds it to that).
 */

export type StorageDriverKind = "vercel-blob" | "filesystem" | "s3";

export type StorageBody = string | Buffer | Uint8Array;

export interface StoragePutOptions {
  contentType?: string;
  /** The store appends an unguessable suffix to the key (before the extension) and returns the key it used. */
  addRandomSuffix?: boolean;
  /** Replace an existing object. Absent or false: writing over an existing key fails. */
  allowOverwrite?: boolean;
}

export interface StoragePutResult {
  /** The key the object was stored under (differs from the requested key only with `addRandomSuffix`). */
  key: string;
  /** What `head()` and `delete()` take back for this object. On Vercel Blob it is the object's URL; elsewhere the key. */
  ref: string;
}

export interface StorageListParams {
  /** A plain string prefix of the key, NOT a directory: `a/b` matches `a/b`, `a/b.appends/1` and `a/bc`. */
  prefix: string;
  /** The `cursor` of the previous page. */
  cursor?: string;
  /** Page size. */
  limit?: number;
}

export interface StorageListPage {
  /** Keys in ascending order within and across pages. */
  objects: { key: string; size: number }[];
  /** Present when `hasMore`; pass it back to get the next page. */
  cursor?: string;
  hasMore: boolean;
}

export interface StorageGetOptions {
  /** How long the read credential minted for this one read stays valid (drivers that read through a signed URL). */
  ttlMs: number;
  /** Passed to `fetch` by drivers that read over HTTP. The web runtime passes `{ cache: "no-store" }`. */
  fetchInit?: RequestInit;
}

export interface StorageSignedUrl {
  /** A GET-only URL for one object's bytes, valid until `expiresAt`. Whoever holds it can read that object. */
  url: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Where a driver's objects are addressed from outside. Needs no credential, so the routes that only FOLLOW a signed
 * URL (the artifact proxy, the PDF fetcher) can ask it even when the store itself is not configured.
 */
export interface StorageUrlRules {
  readonly kind: StorageDriverKind;
  /** Is this hostname the store's? */
  ownsHost(hostname: string): boolean;
  /** Is this a URL the store serves objects from (scheme and host, and path where the host is shared)? */
  ownsUrl(url: URL): boolean;
  /** The object key a store URL points at, ignoring its (possibly expired) signature. Null for any other URL. */
  keyFromUrl(rawUrl: string): string | null;
  /**
   * Follow one of this store's signed URLs (one `ownsUrl` admits) and return the upstream answer: 200 with the bytes,
   * 401/403 when the signature is bad or expired, 404 when the object is gone.
   */
  open(url: URL, fetchInit?: RequestInit): Promise<Response>;
}

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  readonly urls: StorageUrlRules;
  put(key: string, body: StorageBody, options?: StoragePutOptions): Promise<StoragePutResult>;
  /** The object's bytes as a Response (status 200), or null when there is no such object. */
  get(key: string, options: StorageGetOptions): Promise<Response | null>;
  /** The object's size, or null when there is no such object. Takes a `ref` from `put()` or a key. */
  head(ref: string): Promise<{ size: number } | null>;
  list(params: StorageListParams): Promise<StorageListPage>;
  /** Remove objects. Takes `ref`s from `put()` or keys. Removing a missing object is not an error. */
  delete(refs: string | string[]): Promise<void>;
  signedUrl(key: string, ttlMs: number): Promise<StorageSignedUrl>;
}

/** A deployment setting is missing or invalid. The message names the setting, never a value. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

/** A key that could address something outside the store. Nothing was read or written. */
export class StorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`invalid storage key "${String(key).slice(0, 120)}": ${reason}`);
    this.name = "StorageKeyError";
  }
}
