/**
 * WHAT A STORAGE KEY MAY LOOK LIKE on a driver where a key becomes a path or a URL.
 *
 * The callers already validate what they join into a key (lib/dataroom-keyspace.ts requireWorkspace, the dm.md path
 * grammar, isSafeDataroomPath). This is the driver's own floor underneath them, for a key that reaches it some other
 * way (an artifact's file name comes from the model): a key is forward-slash segments, and no segment is empty, `.`
 * or `..`. Such a key cannot name anything above the store's root, whatever the root is.
 *
 * The Vercel Blob driver does not use it: there a key is an opaque name in a flat store, and the calls it makes today
 * must not change.
 */
import "./server-guard.ts";
import { StorageKeyError } from "./types.ts";

const MAX_KEY_BYTES = 1024;
/** Under the 255 a file name may be, with room for the `.json` of a sidecar. */
const MAX_SEGMENT_BYTES = 240;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function segmentProblem(segment: string): string | null {
  if (segment === "") return "an empty path segment";
  if (segment === "." || segment === "..") return `a "${segment}" path segment`;
  if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return "a path segment longer than 240 bytes";
  return null;
}

function stringProblem(key: unknown): string | null {
  if (typeof key !== "string") return "not a string";
  if (key.length === 0) return "empty";
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) return "longer than 1024 bytes";
  if (key.includes("\\")) return "a backslash";
  if (CONTROL.test(key)) return "a control character";
  if (key.startsWith("/")) return "a leading slash";
  return null;
}

/** The key, or a {@link StorageKeyError}. */
export function assertStorageKey(key: string): string {
  const problem = stringProblem(key);
  if (problem !== null) throw new StorageKeyError(key, problem);
  for (const segment of key.split("/")) {
    const bad = segmentProblem(segment);
    if (bad !== null) throw new StorageKeyError(key, bad);
  }
  return key;
}

export function isStorageKey(key: unknown): key is string {
  try {
    assertStorageKey(key as string);
    return true;
  } catch {
    return false;
  }
}

/**
 * A LIST prefix: a key cut anywhere. Every complete segment obeys the key rules; the last piece may be empty (the
 * prefix ends at a slash) or partial, but never `..`.
 */
export function assertStoragePrefix(prefix: string): { dir: string[]; partial: string } {
  if (prefix === "") return { dir: [], partial: "" };
  const problem = stringProblem(prefix);
  if (problem !== null) throw new StorageKeyError(prefix, problem);
  const pieces = prefix.split("/");
  const partial = pieces.pop() as string;
  for (const segment of pieces) {
    const bad = segmentProblem(segment);
    if (bad !== null) throw new StorageKeyError(prefix, bad);
  }
  if (partial === "." || partial === "..") throw new StorageKeyError(prefix, `a "${partial}" path segment`);
  return { dir: pieces, partial };
}

/** `dir/name.ext` -> `dir/name-<suffix>.ext`, as Vercel Blob's `addRandomSuffix` shapes it. */
export function withSuffix(key: string, suffix: string): string {
  const slash = key.lastIndexOf("/");
  const dir = key.slice(0, slash + 1);
  const name = key.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${dir}${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${dir}${name}-${suffix}`;
}
