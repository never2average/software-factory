/**
 * WHERE THE SELECTED STORE'S OBJECTS ARE ADDRESSED — asked by code that follows or recognises a link without
 * touching the store: the artifact proxy, the artifact-link route (which takes the key out of a published link), and
 * the PDF fetcher's "is this one of ours" flag.
 *
 * Needs no store credential, and does not load the Vercel client. On the default driver the answer is the rule those
 * call sites each used to spell themselves.
 */
import { filesystemUrlRules } from "./filesystem.ts";
import { s3UrlRules } from "./s3.ts";
import { filesystemSettings, s3Settings, storageKind } from "./settings.ts";
import type { StorageUrlRules } from "./types.ts";
import { vercelBlobUrlRules } from "./vercel-blob-urls.ts";

type Env = Record<string, string | undefined>;

/** The selected driver's link rules. Throws a StorageConfigError when a non-default driver is missing a setting. */
export function storageUrlRules(env: Env = process.env): StorageUrlRules {
  const kind = storageKind(env);
  if (kind === "filesystem") return filesystemUrlRules(filesystemSettings(env));
  if (kind === "s3") return s3UrlRules(s3Settings(env));
  return vercelBlobUrlRules;
}

/** Is this hostname the selected store's? False, not an error, when the store's settings are incomplete. */
export function isStorageHost(hostname: string, env: Env = process.env): boolean {
  try {
    return storageUrlRules(env).ownsHost(hostname);
  } catch {
    return false;
  }
}
