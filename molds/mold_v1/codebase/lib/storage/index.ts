/**
 * THE FILE STORE THE DEPLOYMENT SELECTED. See lib/storage/types.ts for the interface and lib/storage/settings.ts for
 * the settings, by name.
 *
 *     const store = storageDriver();          // null: Vercel Blob is selected (the default) and has no token
 *     await store.put(key, body, { … });
 *
 * `null` keeps every caller's existing "storage is not configured" answer exactly as it was: the web app returns an
 * empty listing or a 503, publish_artifact says which variable to set, and the agent falls back to local files.
 * `null` means that and nothing else.
 *
 * A MISCONFIGURED deployment is different, and is never `null` and never `false`: STORAGE_DRIVER is not a driver's
 * name, or the selected driver is missing a setting. `storageDriver()` and `storageConfigured()` both THROW a
 * StorageConfigError naming the setting, `storageConfigError()` returns it, the web routes answer 503 with it
 * (lib/storage-http.ts), and it is written to the log once: when this module is first loaded (the agent at startup,
 * the web app on the first request that reaches a storage route) and by whichever door meets it.
 *
 * SERVER ONLY. `import "server-only"` itself cannot be used here: this module is loaded by the eve agent and by plain
 * `node` scripts (every operator command), where that package's default export throws. ./server-guard.ts is the
 * equivalent (it throws in a browser), and `npm run check:storage-server-only` fails the build when a client component
 * can reach anything under lib/storage/ other than hosts.ts.
 *
 * This module (and everything under lib/storage/) uses relative `.ts` imports and no `@/` alias, so the Next app, the
 * eve agent and plain `node --experimental-strip-types` all load the same file.
 */
import "./server-guard.ts";
import { createFilesystemDriver } from "./filesystem.ts";
import { createS3Driver } from "./s3.ts";
import { filesystemSettings, reportStorageConfigError, s3Settings, storageConfigError, storageKind } from "./settings.ts";
import { isStorageConfigError, type StorageDriver } from "./types.ts";
import { createVercelBlobDriver } from "./vercel-blob.ts";

export { createVercelBlobDriver } from "./vercel-blob.ts";
export { reportStorageConfigError, storageConfigError, storageKind } from "./settings.ts";
export { isStorageHost, storageUrlRules } from "./urls.ts";
export { isStorageConfigError, StorageConfigError, StorageKeyError } from "./types.ts";
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

/**
 * The selected driver, or null when the default (Vercel Blob) is selected and BLOB_READ_WRITE_TOKEN is not set.
 * Throws a StorageConfigError (logged once) when the deployment is misconfigured.
 */
export function storageDriver(env: Env = process.env): StorageDriver | null {
  try {
    const kind = storageKind(env);
    if (kind === "filesystem") {
      const settings = filesystemSettings(env);
      return cached(JSON.stringify(["filesystem", settings.root, settings.publicUrl, settings.signingSecret]), () => createFilesystemDriver(settings));
    }
    if (kind === "s3") {
      const settings = s3Settings(env);
      return cached(JSON.stringify(["s3", settings]), () => createS3Driver(settings));
    }
  } catch (error) {
    throw isStorageConfigError(error) ? reportStorageConfigError(error) : error;
  }
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return cached(JSON.stringify(["vercel-blob", token]), () => createVercelBlobDriver(token));
}

/**
 * Is a store available? False ONLY when the default driver has no token ("not configured", as before). A misconfigured
 * deployment is not `false`: this throws the StorageConfigError, so a caller cannot answer "empty" or "not configured"
 * for it by accident. A route asks lib/storage-http.ts `storageMisconfigured()` first and answers 503.
 */
export function storageConfigured(env: Env = process.env): boolean {
  return storageDriver(env) !== null;
}

/**
 * THE STARTUP CHECK. Evaluated once, when this module is first loaded: by the agent when its server starts, by the
 * web app when the first storage route is loaded, by a script when it starts. With nothing set (the live app) it reads
 * two environment values and does nothing. A misconfiguration is written to the log here, before any request meets it.
 */
storageConfigError();
