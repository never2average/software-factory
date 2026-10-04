/**
 * WHERE THE SELECTED STORE'S OBJECTS ARE ADDRESSED — asked by code that follows or recognises a link without
 * touching the store: the artifact proxy, the artifact-link route (which takes the key out of a published link), and
 * the PDF fetcher's "is this one of ours" flag.
 *
 * Needs no store credential, and does not load the Vercel client. On the default driver the answer is the rule those
 * call sites each used to spell themselves.
 */
import "./server-guard.ts";
import { filesystemUrlRules } from "./filesystem.ts";
import { s3UrlRules } from "./s3.ts";
import { filesystemSettings, reportStorageConfigError, s3Settings, storageKind } from "./settings.ts";
import { isStorageConfigError, type StorageUrlRules } from "./types.ts";
import { vercelBlobUrlRules } from "./vercel-blob-urls.ts";

type Env = Record<string, string | undefined>;

/** The selected driver's link rules. Throws a StorageConfigError (logged once) when the deployment is misconfigured. */
export function storageUrlRules(env: Env = process.env): StorageUrlRules {
  try {
    const kind = storageKind(env);
    if (kind === "filesystem") return filesystemUrlRules(filesystemSettings(env));
    if (kind === "s3") return s3UrlRules(s3Settings(env));
  } catch (error) {
    throw isStorageConfigError(error) ? reportStorageConfigError(error) : error;
  }
  return vercelBlobUrlRules;
}

/**
 * Is this hostname the selected store's? A misconfigured deployment owns NO host: this is asked while validating a
 * URL someone supplied (lib/safe-fetch.ts), where the safe answer is "not ours" and the request is then held to the
 * rules for any outside address. It is not silent: the misconfiguration is logged (once), and every route that would
 * have read or written the store answers 503.
 */
export function isStorageHost(hostname: string, env: Env = process.env): boolean {
  try {
    return storageUrlRules(env).ownsHost(hostname);
  } catch (error) {
    if (!isStorageConfigError(error)) throw error;
    return false;
  }
}
