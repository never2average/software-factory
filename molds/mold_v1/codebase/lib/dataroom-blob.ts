/**
 * The dm.md data room for the NEXT runtime, on the deployment's file store.
 *
 * The canonical store (`agent/lib/dataroom-store.ts`) pulls the agent's module
 * graph into the Next bundle (same constraint as `lib/ops-db.ts`), so the
 * /api/dataroom route uses this self-contained twin built on the same storage
 * driver (lib/storage: Vercel Blob by default, or the filesystem or S3 driver
 * when STORAGE_DRIVER selects one). It mirrors the BlobDataroomBackend
 * conventions exactly, on every driver:
 *
 *   - each workspace's objects live under its own `dataroom/orgs/<id>/` key
 *     prefix (lib/dataroom-keyspace.ts); logical paths are the dm.md paths
 *     relative to that prefix, and every function here REQUIRES the workspace
 *   - the store is PRIVATE: reads go through the driver (on Vercel Blob a
 *     short-lived presigned GET), never a public URL
 *   - append-part objects under `{path}.appends/` collapse onto the logical
 *     path in list() and are stitched (base + parts, in key order) in read()
 *
 * Everything returns null / [] when no store is configured (by default: when
 * BLOB_READ_WRITE_TOKEN is unset) so the UI degrades to the skeleton tree
 * without secrets.
 */
import "server-only";

import { isListedPath, isOwnSnapshotKey, workspaceBlobPrefix } from "@/lib/dataroom-keyspace";
import { storageConfigured as driverConfigured, storageDriver, type StorageDriver } from "@/lib/storage/index";

import { ROOT_FOLDERS } from "../agent/lib/dataroom-folders.ts";
import { guardWorkspaceWrites } from "../agent/lib/dataroom-folder-guard.ts";

/**
 * A workspace's Blob prefix: `dataroom/orgs/<id>`, for EVERY workspace, and a thrown error for none. The mapping is
 * lib/dataroom-keyspace.ts — shared with the agent's store, no longer a hand-kept twin. It used to map workspace #1
 * AND a missing id to the root `dataroom/`, which contains every other workspace's `orgs/<id>/` tree.
 */
function storePrefixForOrg(orgId: string | null | undefined): string {
  return workspaceBlobPrefix(orgId);
}
/** Marker directory holding immutable append parts for one logical file. */
const APPENDS_MARKER = ".appends/";
/** How long a presigned internal GET stays valid — just long enough to fetch. */
const READ_LINK_TTL_MS = 5 * 60 * 1000;

/** One path segment: no traversal, no hidden dotfiles, filesystem-safe. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
// The first segment of a path: one of this deployment's stored folders (the profile's, never spelled here).
const DOMAINS = new Set(ROOT_FOLDERS);

/**
 * Is a file store available to this deployment? By default that is "BLOB_READ_WRITE_TOKEN is set". The routes ask
 * this before they do anything, and answer "storage is not configured" when it is false.
 */
export function storageConfigured(): boolean {
  return driverConfigured();
}

/** The deployment's file store, or null when none is configured. */
function store(): StorageDriver | null {
  return storageDriver();
}

/**
 * A fresh, short-lived signed GET for one stored object (the artifact link route). The caller has ALREADY decided the
 * key belongs to its workspace: this signs what it is given.
 */
export async function signStoredObject(key: string, ttlMs: number): Promise<{ url: string; expiresAt: number } | null> {
  const driver = store();
  return driver ? driver.signedUrl(key, ttlMs) : null;
}

/**
 * True when `path` is a plausible dm.md file path: rooted in one of the seven
 * domains' folders or the attached files', forward slashes only, every segment traversal-safe. (The full
 * template grammar lives agent-side; this guard is what the read-only route
 * needs to stay inside the data room.)
 */
export function isSafeDataroomPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.length < 2 || !DOMAINS.has(segments[0])) return false;
  return segments.every((segment) => SAFE_SEGMENT.test(segment));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Write one object into the private data room at `path`, mirroring the store's
 * BlobDataroomBackend conventions (private access, exact key, overwrite). Used by
 * the authenticated upload route. Throws when the token is unset.
 */
export async function writeDataroomFile(
  path: string,
  body: Buffer | string,
  contentType: string | undefined,
  orgId: string,
): Promise<void> {
  const prefix = storePrefixForOrg(orgId);
  const driver = store();
  if (!driver) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  // The same write guard as the agent's store: a data room that still holds a former folder this profile stores
  // nothing under is refused before a second set of folders is started (agent/lib/dataroom-folder-guard.ts). A
  // no-op, with no listing, when the profile pins every former name.
  await guardWorkspaceWrites(orgId, async (folder) => (await driver.list({ prefix: `${prefix}/${folder}/`, limit: 1 })).objects.length > 0);
  await driver.put(`${prefix}/${path}`, body, {
    addRandomSuffix: false,
    allowOverwrite: true,
    ...(contentType ? { contentType } : {}),
  });
}

async function listObjectPathnames(driver: StorageDriver, rawPrefix: string): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await driver.list({ prefix: rawPrefix, cursor, limit: 1000 });
    for (const object of page.objects) pathnames.push(object.key);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return pathnames;
}

/** What a read of one private object passes to the driver: a short-lived credential, and never Next's fetch cache. */
const READ = { ttlMs: READ_LINK_TTL_MS, fetchInit: { cache: "no-store" } } as const;

/** Fetch one private object's text via a short-lived read; null when absent. */
async function fetchObject(driver: StorageDriver, pathname: string): Promise<string | null> {
  const response = await driver.get(pathname, READ);
  return response === null ? null : await response.text();
}

/**
 * Every logical dm.md file path in the Blob data room, sorted. Append-part
 * objects collapse onto their logical path. [] when the token is unset.
 */
export async function listDataroomPaths(orgId: string): Promise<string[]> {
  const prefix = storePrefixForOrg(orgId);
  const driver = store();
  if (!driver) return [];
  const logical = new Set<string>();
  for (const pathname of await listObjectPathnames(driver, `${prefix}/`)) {
    let rel = pathname.slice(prefix.length + 1);
    const marker = rel.indexOf(APPENDS_MARKER);
    if (marker !== -1) rel = rel.slice(0, marker);
    // Never a snapshot and never a nested `orgs/` tree, whatever is in the prefix (lib/dataroom-keyspace.ts).
    if (isListedPath(rel)) logical.add(rel);
  }
  return [...logical].sort();
}

/**
 * Full logical content of one dm.md file (base object + any append parts, in
 * append order), or null when it does not exist / the token is unset.
 */
export async function readDataroomFile(path: string, orgId: string): Promise<string | null> {
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const driver = store();
  if (!driver) return null;
  const [base, partPathnames] = await Promise.all([
    fetchObject(driver, objectPathname),
    listObjectPathnames(driver, `${objectPathname}${APPENDS_MARKER}`).then((parts) => parts.sort()),
  ]);
  if (partPathnames.length === 0) return base;
  const pieces: string[] = base === null ? [] : [ensureTrailingNewline(base)];
  for (const partPathname of partPathnames) {
    const part = await fetchObject(driver, partPathname);
    if (part !== null) pieces.push(ensureTrailingNewline(part));
  }
  if (pieces.length === 0) return null;
  return pieces.join("");
}

/**
 * One stored object's size, without reading it — `null` when it is not there.
 *
 * The listing already carries `size`, so this costs one prefix-scoped list call
 * and no bytes. That is the whole reason it exists: the binary read below has to
 * be able to REFUSE a file over the preview ceiling (the operator has hit a
 * 44 MB one) with a sentence, and a refusal that first pulls 44 MB through the
 * Node function is not a refusal — it is the same stall one layer down, plus the
 * egress.
 *
 * Exact-match on the object key, so `{folder:uploads}/x/a.pdf` never reports the size of
 * `{folder:uploads}/x/a.pdf.appends/0001`.
 */
export async function statDataroomObject(
  path: string,
  orgId: string,
): Promise<{ size: number } | null> {
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const driver = store();
  if (!driver) return null;
  const page = await driver.list({ prefix: objectPathname, limit: 1000 });
  const hit = page.objects.find((object) => object.key === objectPathname);
  return hit ? { size: hit.size } : null;
}

/**
 * The RAW response for one stored object (on Vercel Blob, over a short-lived
 * presigned GET), so a caller can stream its bytes straight through. `null` when it is not there.
 *
 * Deliberately NOT `readDataroomFile`: that one calls `response.text()`, which
 * decodes as UTF-8 and mangles every byte of a PDF that is not valid UTF-8 —
 * which is most of them. It also stitches `.appends/` parts, a text-file
 * concept; a binary object has none, and concatenating one onto a PDF would
 * produce a file no reader accepts.
 *
 * The presigned URL lives and dies inside this process. It is the entire
 * authority to read the object, for anyone holding it, signed in or not — so it
 * is never returned, never logged and never put in a redirect. The caller gets
 * bytes.
 */
export async function openDataroomObject(
  path: string,
  orgId: string,
): Promise<Response | null> {
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const driver = store();
  if (!driver) return null;
  return driver.get(objectPathname, READ);
}

/**
 * A version SNAPSHOT (lib/dataroom-versions.ts), in the workspace's OWN tree: `dataroom/orgs/<id>/_versions/<id>/…`.
 * The key is the version row's `prev_blob_key`; one that is not this workspace's snapshot is refused rather than
 * resolved. Snapshots used to be written and read at the ROOT (`dataroom/_versions/<id>/…`, "prefix logic bypassed"),
 * beside every other workspace's.
 */
export async function readSnapshotObject(key: string, orgId: string): Promise<string | null> {
  if (!isOwnSnapshotKey(orgId, key)) throw new Error(`"${key.slice(0, 120)}" is not a snapshot of this workspace`);
  return readDataroomFile(key, orgId);
}

export async function writeSnapshotObject(key: string, body: string, orgId: string): Promise<void> {
  if (!isOwnSnapshotKey(orgId, key)) throw new Error(`"${key.slice(0, 120)}" is not a snapshot of this workspace`);
  await writeDataroomFile(key, body, "text/plain", orgId);
}

/** Parse a .jsonl body into records; skips blank lines, throws on bad JSON. */
export function parseJsonlRecords(path: string, content: string): unknown[] {
  const records: unknown[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`"${path}" line ${index + 1} is not valid JSON: ${line.slice(0, 120)}`);
    }
  }
  return records;
}
