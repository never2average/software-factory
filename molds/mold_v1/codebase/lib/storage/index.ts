/**
 * THE FILE STORE THE DEPLOYMENT SELECTED. See lib/storage/types.ts for the interface and lib/storage/settings.ts for
 * the settings, by name.
 *
 *     const store = storageDriver();          // null: Vercel Blob is selected (the default) and has no token
 *     await store.put(key, body, { … });
 *
 * `null` keeps every caller's existing "storage is not configured" answer exactly as it was: the web app returns an
 * empty listing or a 503, publish_artifact says which variable to set, and the agent falls back to local files.
 * A driver that was SELECTED and is missing a setting is different: that is a misconfigured deployment, and it throws
 * a StorageConfigError naming the setting, so it is never mistaken for "no storage" and silently written elsewhere.
 *
 * This module (and everything under lib/storage/) uses relative `.ts` imports and no `@/` alias, so the Next app, the
 * eve agent and plain `node --experimental-strip-types` all load the same file.
 */
import { createFilesystemDriver } from "./filesystem.ts";
import { createS3Driver } from "./s3.ts";
import { filesystemSettings, s3Settings, storageKind } from "./settings.ts";
import type { StorageDriver } from "./types.ts";
import { createVercelBlobDriver } from "./vercel-blob.ts";

export { createVercelBlobDriver } from "./vercel-blob.ts";
export { storageKind } from "./settings.ts";
export { isStorageHost, storageUrlRules } from "./urls.ts";
export { StorageConfigError, StorageKeyError } from "./types.ts";
export type { StorageDriver, StorageDriverKind, StorageListPage, StoragePutOptions, StorageUrlRules } from "./types.ts";

type Env = Record<string, string | undefined>;

/** One driver per distinct configuration, so a hot path does not rebuild it on every call. */
const cache = new Map<string, StorageDriver>();

function cached(fingerprint: string, make: () => StorageDriver): StorageDriver {
  let driver = cache.get(fingerprint);
  if (!driver) {
    driver = make();
    cache.set(fingerprint, driver);
  }
  return driver;
}

/** The selected driver, or null when the default (Vercel Blob) is selected and BLOB_READ_WRITE_TOKEN is not set. */
export function storageDriver(env: Env = process.env): StorageDriver | null {
  const kind = storageKind(env);
  if (kind === "filesystem") {
    const settings = filesystemSettings(env);
    return cached(JSON.stringify(["filesystem", settings.root, settings.publicUrl, settings.signingSecret]), () => createFilesystemDriver(settings));
  }
  if (kind === "s3") {
    const settings = s3Settings(env);
    return cached(JSON.stringify(["s3", settings]), () => createS3Driver(settings));
  }
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return cached(JSON.stringify(["vercel-blob", token]), () => createVercelBlobDriver(token));
}

/**
 * Is a store available? False when none is configured OR the selected one is misconfigured: the routes answer
 * "storage is not configured" either way, and /api/ops/health reports which setting is missing.
 */
export function storageConfigured(env: Env = process.env): boolean {
  try {
    return storageDriver(env) !== null;
  } catch {
    return false;
  }
}
