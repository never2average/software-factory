/**
 * Read-only Vercel Blob access to the dm.md data room for the NEXT runtime.
 *
 * The canonical store (`agent/lib/dataroom-store.ts`) uses `.ts`-extension
 * imports that the Next bundler cannot resolve (same constraint as
 * `lib/ops-db.ts`), so the /api/dataroom route uses this self-contained twin
 * built directly on `@vercel/blob`. It mirrors the BlobDataroomBackend
 * conventions exactly:
 *
 *   - objects live under the `dataroom/` key prefix; logical paths are the
 *     dm.md paths relative to that prefix
 *   - the store is PRIVATE: reads go through a short-lived presigned GET
 *     (issueSignedToken + presignUrl), never a public URL
 *   - append-part objects under `{path}.appends/` collapse onto the logical
 *     path in list() and are stitched (base + parts, in key order) in read()
 *
 * Everything returns null / [] when BLOB_READ_WRITE_TOKEN is unset so the UI
 * degrades to the skeleton tree without secrets.
 */
import "server-only";

import { list as listBlobs, put } from "@vercel/blob";

import { presignBlobRead } from "@/lib/blob-read";

const STORE_PREFIX = "dataroom";
/**
 * Org #1 — its data room is the legacy root (no per-org sub-prefix).
 *
 * TWO ids, and that is not tidiness. The workspace row is `org-onfinance-ai`
 * while this constant was `org-onfinance`, so the two never matched: a caller
 * holding the real workspace id addressed `orgs/org-onfinance-ai/` and a caller
 * passing nothing addressed the root. Org #1's data room was split across two
 * prefixes — its 223 customer files in one, its chat uploads in the other —
 * and each half looked complete to whoever read it.
 *
 * THIS MAPPING IS DUPLICATED in agent/lib/dataroom-store.ts,
 * agent/lib/org-blob.ts and lib/dataroom-blob.ts (bundler boundaries keep them
 * apart). They must stay in lockstep — `npm run check:gates` enforces it.
 */
const LEGACY_ROOT_ORGS = new Set(["org-onfinance", "org-onfinance-ai"]);
const isLegacyRootOrg = (orgId?: string | null): boolean => !orgId || LEGACY_ROOT_ORGS.has(orgId);
/**
 * The Blob store prefix for a workspace: onfinance → "dataroom" (unchanged),
 * others → "dataroom/orgs/{id}". Twin of agent/lib/dataroom-store.ts's mapping.
 */
function storePrefixForOrg(orgId?: string | null): string {
  return isLegacyRootOrg(orgId) ? STORE_PREFIX : `${STORE_PREFIX}/orgs/${orgId}`;
}
/** Marker directory holding immutable append parts for one logical file. */
const APPENDS_MARKER = ".appends/";
/** How long a presigned internal GET stays valid — just long enough to fetch. */
const READ_LINK_TTL_MS = 5 * 60 * 1000;

/** One path segment: no traversal, no hidden dotfiles, filesystem-safe. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const DOMAINS = new Set([
  "Customers",
  "Platform",
  "Deployments",
  "Solutions",
  "Implementation",
  "Tickets",
  "People",
  "Uploads",
]);

export function blobToken(): string | null {
  return process.env.BLOB_READ_WRITE_TOKEN ?? null;
}

/**
 * True when `path` is a plausible dm.md file path: rooted in one of the seven
 * domains, forward slashes only, every segment traversal-safe. (The full
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
  contentType?: string,
  orgId?: string | null,
): Promise<void> {
  const token = blobToken();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  await put(`${storePrefixForOrg(orgId)}/${path}`, body, {
    access: "private",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    ...(contentType ? { contentType } : {}),
  });
}

async function listObjectPathnames(token: string, rawPrefix: string): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listBlobs({ token, prefix: rawPrefix, cursor, limit: 1000 });
    for (const blob of page.blobs) pathnames.push(blob.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return pathnames;
}

/** Fetch one private blob's text via a short-lived presigned GET; null on 404. */
async function fetchObject(token: string, pathname: string): Promise<string | null> {
  const { url } = await presignBlobRead(token, pathname, READ_LINK_TTL_MS);
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`blob read failed for "${pathname}": HTTP ${response.status}`);
  }
  return await response.text();
}

/**
 * Every logical dm.md file path in the Blob data room, sorted. Append-part
 * objects collapse onto their logical path. [] when the token is unset.
 */
export async function listDataroomPaths(orgId?: string | null): Promise<string[]> {
  const token = blobToken();
  if (!token) return [];
  const prefix = storePrefixForOrg(orgId);
  const logical = new Set<string>();
  for (const pathname of await listObjectPathnames(token, `${prefix}/`)) {
    let rel = pathname.slice(prefix.length + 1);
    const marker = rel.indexOf(APPENDS_MARKER);
    if (marker !== -1) rel = rel.slice(0, marker);
    if (rel.length > 0) logical.add(rel);
  }
  return [...logical].sort();
}

/**
 * Full logical content of one dm.md file (base object + any append parts, in
 * append order), or null when it does not exist / the token is unset.
 */
export async function readDataroomFile(path: string, orgId?: string | null): Promise<string | null> {
  const token = blobToken();
  if (!token) return null;
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const [base, partPathnames] = await Promise.all([
    fetchObject(token, objectPathname),
    listObjectPathnames(token, `${objectPathname}${APPENDS_MARKER}`).then((parts) => parts.sort()),
  ]);
  if (partPathnames.length === 0) return base;
  const pieces: string[] = base === null ? [] : [ensureTrailingNewline(base)];
  for (const partPathname of partPathnames) {
    const part = await fetchObject(token, partPathname);
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
 * Exact-match on the object key, so `Uploads/x/a.pdf` never reports the size of
 * `Uploads/x/a.pdf.appends/0001`.
 */
export async function statDataroomObject(
  path: string,
  orgId?: string | null,
): Promise<{ size: number } | null> {
  const token = blobToken();
  if (!token) return null;
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const page = await listBlobs({ token, prefix: objectPathname, limit: 1000 });
  const hit = page.blobs.find((blob) => blob.pathname === objectPathname);
  return hit ? { size: hit.size } : null;
}

/**
 * The RAW response for one stored object, over a short-lived presigned GET, so
 * a caller can stream its bytes straight through. `null` when it is not there.
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
  orgId?: string | null,
): Promise<Response | null> {
  const token = blobToken();
  if (!token) return null;
  const objectPathname = `${storePrefixForOrg(orgId)}/${path}`;
  const { url } = await presignBlobRead(token, objectPathname, READ_LINK_TTL_MS);
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`blob read failed for "${objectPathname}": HTTP ${response.status}`);
  }
  return response;
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
