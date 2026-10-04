/**
 * THE STORAGE SETTINGS, by name. Values live in the deployment's environment and are never written here.
 *
 *   STORAGE_DRIVER                 vercel-blob (default when unset) | filesystem | s3
 *
 *   vercel-blob
 *     BLOB_READ_WRITE_TOKEN        the private store's token. Without it the store is "not configured", as before.
 *
 *   filesystem
 *     STORAGE_FS_ROOT              absolute directory the files are kept in. Not served by anything; the app reads it.
 *     STORAGE_SIGNING_SECRET       signs the app's own expiring file links (32+ characters). The web app and the
 *                                  agent API must hold the same value.
 *     STORAGE_PUBLIC_URL           the web app's public address (https://…): where a signed link points. Falls back
 *                                  to WEB_ORIGIN.
 *
 *   s3
 *     STORAGE_S3_ENDPOINT          https://<region>.digitaloceanspaces.com, or a MinIO address
 *     STORAGE_S3_BUCKET
 *     STORAGE_S3_REGION            defaults to us-east-1 (what Spaces and MinIO expect in the signature)
 *     STORAGE_S3_ACCESS_KEY_ID
 *     STORAGE_S3_SECRET_ACCESS_KEY
 *     STORAGE_S3_ADDRESSING        path (default: <endpoint>/<bucket>/<key>) | virtual (<bucket>.<endpoint>/<key>)
 *
 *   NEXT_PUBLIC_STORAGE_HOST       (s3 only, build time) the bucket's host name, for the browser (lib/storage/hosts.ts)
 *
 * Read on every call, not cached at import: a test flips them, and the agent and the web app are separate processes
 * that each read their own environment.
 */
import "./server-guard.ts";
import nodePath from "node:path";
import { isStorageConfigError, StorageConfigError, type StorageDriverKind } from "./types.ts";

type Env = Record<string, string | undefined>;

export const STORAGE_DRIVER_KINDS: readonly StorageDriverKind[] = ["vercel-blob", "filesystem", "s3"];

/** Which driver the deployment selected. Unset (or empty) is Vercel Blob: the live app sets nothing. */
export function storageKind(env: Env = process.env): StorageDriverKind {
  const raw = env.STORAGE_DRIVER?.trim();
  if (raw === undefined || raw === "") return "vercel-blob";
  if (raw === "fs") return "filesystem";
  if ((STORAGE_DRIVER_KINDS as readonly string[]).includes(raw)) return raw as StorageDriverKind;
  throw new StorageConfigError(`STORAGE_DRIVER must be one of ${STORAGE_DRIVER_KINDS.join(", ")} (or unset for vercel-blob).`);
}

/** Messages already written to the log by this process: a misconfiguration is said once, not on every request. */
const reported = new Set<string>();

/**
 * Write a storage misconfiguration to the server log, once per distinct message for the life of the process. Every
 * place that meets one calls this (the startup check in lib/storage/index.ts, `storageDriver()`, the link rules), so
 * the log holds it whichever door was tried first. Returns the error so a caller can `throw reportStorageConfigError(e)`.
 */
export function reportStorageConfigError<E extends Error>(error: E, log: (line: string) => void = console.error): E {
  if (!reported.has(error.message)) {
    reported.add(error.message);
    log(`[storage] MISCONFIGURED: ${error.message} File storage is refused (HTTP 503, and the agent's file tools fail) until the setting is corrected. This is not the same as "not configured".`);
  }
  return error;
}

/** For tests: forget what was reported. */
export function resetStorageConfigReports(): void {
  reported.clear();
}

/**
 * What is wrong with the deployment's storage settings, or null when nothing is.
 *
 *   null    the default driver (STORAGE_DRIVER unset, empty or vercel-blob), WITH OR WITHOUT a BLOB_READ_WRITE_TOKEN:
 *           no token is "not configured", today's behaviour, and not an error;
 *           or a selected driver with every setting it requires.
 *   error   STORAGE_DRIVER is not a driver's name, or the selected driver is missing a required setting (or has an
 *           invalid one). The message names the setting.
 *
 * Reads settings only: it builds no driver, touches no store and loads no client. Logged once (above).
 */
export function storageConfigError(env: Env = process.env): StorageConfigError | null {
  try {
    const kind = storageKind(env);
    if (kind === "filesystem") filesystemSettings(env);
    else if (kind === "s3") s3Settings(env);
    return null;
  } catch (error) {
    if (isStorageConfigError(error)) return reportStorageConfigError(error);
    throw error;
  }
}

export interface FilesystemSettings {
  root: string;
  signingSecret: string;
  /** Origin only, no trailing slash: `https://app.example.com`. */
  publicUrl: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** A public https origin (http only for a loopback address, for local runs). */
function originSetting(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") throw new StorageConfigError(`${name} is not set.`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new StorageConfigError(`${name} is not a URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new StorageConfigError(`${name} must be an https address.`);
  }
  if (url.username || url.password) throw new StorageConfigError(`${name} must not carry a username or password.`);
  return url.origin;
}

export function filesystemSettings(env: Env = process.env): FilesystemSettings {
  const root = env.STORAGE_FS_ROOT?.trim();
  if (!root) throw new StorageConfigError("STORAGE_FS_ROOT is not set (STORAGE_DRIVER=filesystem needs the directory to keep files in).");
  if (!nodePath.isAbsolute(root)) throw new StorageConfigError("STORAGE_FS_ROOT must be an absolute path.");
  const signingSecret = env.STORAGE_SIGNING_SECRET ?? "";
  if (signingSecret.length < 32) {
    throw new StorageConfigError("STORAGE_SIGNING_SECRET is not set or shorter than 32 characters (it signs the app's file links).");
  }
  const publicUrl = originSetting(env.STORAGE_PUBLIC_URL?.trim() ? "STORAGE_PUBLIC_URL" : "STORAGE_PUBLIC_URL (or WEB_ORIGIN)", env.STORAGE_PUBLIC_URL?.trim() || env.WEB_ORIGIN);
  return { root: nodePath.resolve(root), signingSecret, publicUrl };
}

export interface S3Settings {
  /** Origin of the endpoint, no trailing slash. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  addressing: "path" | "virtual";
}

/** Bucket names that are safe both as a path segment and as a host label. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function s3Settings(env: Env = process.env): S3Settings {
  const endpoint = originSetting("STORAGE_S3_ENDPOINT", env.STORAGE_S3_ENDPOINT);
  const bucket = env.STORAGE_S3_BUCKET?.trim() ?? "";
  if (!BUCKET.test(bucket) || bucket.includes("..")) throw new StorageConfigError("STORAGE_S3_BUCKET is not set or is not a bucket name.");
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId) throw new StorageConfigError("STORAGE_S3_ACCESS_KEY_ID is not set.");
  if (!secretAccessKey) throw new StorageConfigError("STORAGE_S3_SECRET_ACCESS_KEY is not set.");
  const addressing = env.STORAGE_S3_ADDRESSING?.trim() || "path";
  if (addressing !== "path" && addressing !== "virtual") throw new StorageConfigError("STORAGE_S3_ADDRESSING must be path or virtual.");
  return { endpoint, bucket, region: env.STORAGE_S3_REGION?.trim() || "us-east-1", accessKeyId, secretAccessKey, addressing };
}
