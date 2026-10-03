/**
 * The filesystem driver: the file store as a directory on the server's own disk (`STORAGE_DRIVER=filesystem`).
 *
 * Layout under STORAGE_FS_ROOT:
 *
 *     objects/<key>          the object's bytes, at the path its key spells
 *     meta/<key>.json        { "contentType": … } for an object stored with one
 *     tmp/                   in-flight writes; never listed, never served
 *
 * NOTHING SERVES THIS DIRECTORY. It is not under the web root and no route maps a URL onto it. Bytes leave it two
 * ways only: a server-side read by code that already built the key for its caller's workspace, or a signed link
 * (lib/storage/signed-url.ts) honoured by app/api/storage/object/[...key]/route.ts.
 *
 * What the callers rely on, and how it is kept:
 *
 *   - A key cannot leave the root. `assertStorageKey` refuses `..`, `.`, empty segments, backslashes, control
 *     characters and absolute paths before a path is built, and the resolved path is checked against the root again.
 *     A symbolic link is never followed: an object is a regular file, or it is absent.
 *   - Writes are atomic. The bytes are written and flushed under tmp/, then moved onto the key in one step: a reader
 *     sees the old object or the new one, never part of one. Without `allowOverwrite` the move is a hard link, which
 *     the kernel refuses if the key exists, so two writers of one key cannot both succeed (the data room's append
 *     parts depend on that).
 *   - `list` is a plain string prefix over keys, in ascending key order within and across pages, with an opaque
 *     cursor: what the Vercel Blob listing gives the callers. The cursor is the last key returned, so a page is
 *     stable under concurrent writes.
 *
 * One difference from an object store, by nature: a key cannot be both an object and the folder of another
 * (`a/b` and `a/b/c`). The data room's grammar never produces that pair; a write that would need it fails loudly.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import nodePath from "node:path";
import { Readable } from "node:stream";
import { assertStorageKey, assertStoragePrefix, withSuffix } from "./keys.ts";
import type { FilesystemSettings } from "./settings.ts";
import { isServableKey, keyFromObjectPath, signObjectUrl, STORAGE_OBJECT_ROUTE, verifyObjectLink } from "./signed-url.ts";
import { StorageKeyError, type StorageDriver, type StorageListPage, type StorageUrlRules } from "./types.ts";

const TYPE_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  jsonl: "application/x-ndjson",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** "There is no such object" as the filesystem says it: missing, or a path that runs through a file. */
function isAbsent(error: unknown): boolean {
  const code = errno(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

const encodeCursor = (key: string) => Buffer.from(key, "utf8").toString("base64url");
function decodeCursor(cursor: string): string {
  const key = Buffer.from(cursor, "base64url").toString("utf8");
  if (encodeCursor(key) !== cursor) throw new StorageKeyError(cursor, "not a list cursor");
  return key;
}

/** The directories and path arithmetic shared by the driver and its link rules. */
function layout(root: string) {
  const objects = nodePath.join(root, "objects");
  const meta = nodePath.join(root, "meta");
  const tmp = nodePath.join(root, "tmp");
  function under(base: string, key: string, suffix = ""): string {
    assertStorageKey(key);
    const abs = nodePath.resolve(base, ...key.split("/")) + suffix;
    // Belt and braces: the key rules already forbid every way out.
    if (!abs.startsWith(base + nodePath.sep)) throw new StorageKeyError(key, "escapes the storage root");
    return abs;
  }
  return {
    objects,
    meta,
    tmp,
    objectPath: (key: string) => under(objects, key),
    metaPath: (key: string) => under(meta, key, ".json"),
  };
}

/**
 * The real path of `objects/<key>`'s parent must be the parent the key spells: no directory on the way is a symbolic
 * link to somewhere else. (The key rules stop `..`; this stops a link planted inside the root.)
 */
async function parentIsInside(paths: ReturnType<typeof layout>, path: string): Promise<boolean> {
  try {
    const [realRoot, realParent] = await Promise.all([fs.realpath(paths.objects), fs.realpath(nodePath.dirname(path))]);
    return realParent === nodePath.join(realRoot, nodePath.relative(paths.objects, nodePath.dirname(path)));
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

/** A regular file's size, or null. A symbolic link, a directory or a missing path is "no such object". */
async function regularFileSize(paths: ReturnType<typeof layout>, key: string): Promise<number | null> {
  const path = paths.objectPath(key);
  try {
    const stat = await fs.lstat(path);
    return stat.isFile() && (await parentIsInside(paths, path)) ? stat.size : null;
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

async function contentTypeOf(paths: ReturnType<typeof layout>, key: string): Promise<string> {
  try {
    const stored = JSON.parse(await fs.readFile(paths.metaPath(key), "utf8")) as { contentType?: unknown };
    // An upload's type is whatever its sender declared. Only a plain printable value is ever sent back as a header.
    if (typeof stored.contentType === "string" && /^[\x20-\x7e]{1,200}$/.test(stored.contentType)) return stored.contentType;
  } catch {
    // No sidecar (or an unreadable one): fall through to the extension.
  }
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/** Below this an object is read whole and its file closed at once; above it the body streams from disk. */
const STREAM_ABOVE_BYTES = 1024 * 1024;

/**
 * The object as a Response, or null. One open file descriptor is the object for the whole read, so a concurrent
 * overwrite (a rename onto the key) cannot change the bytes mid-stream: the reader keeps the file it opened.
 */
async function openObject(paths: ReturnType<typeof layout>, key: string): Promise<Response | null> {
  const path = paths.objectPath(key);
  if (!(await parentIsInside(paths, path))) return null;
  let handle;
  try {
    // O_NOFOLLOW: a symbolic link at the key is refused by the kernel (ELOOP), not followed.
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isAbsent(error) || errno(error) === "ELOOP") return null;
    throw error;
  }
  let streaming = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const headers = { "content-type": await contentTypeOf(paths, key), "content-length": String(stat.size) };
    if (stat.size <= STREAM_ABOVE_BYTES) return new Response(new Uint8Array(await handle.readFile()), { status: 200, headers });
    streaming = true;
    // The stream closes the descriptor when it ends or is cancelled.
    return new Response(Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>, { status: 200, headers });
  } finally {
    if (!streaming) await handle.close();
  }
}

/** Remove one file if it is there. A missing path, or a directory at it, is not an object and not an error. */
async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    const code = errno(error);
    if (isAbsent(error) || code === "EISDIR" || code === "EPERM") return;
    throw error;
  }
}

export function filesystemUrlRules(settings: FilesystemSettings): StorageUrlRules {
  const paths = layout(settings.root);
  const origin = new URL(settings.publicUrl);
  const ownsUrl = (url: URL) => url.origin === origin.origin && url.pathname.startsWith(`${STORAGE_OBJECT_ROUTE}/`);
  return {
    kind: "filesystem",
    ownsHost: (hostname) => hostname.toLowerCase() === origin.hostname,
    ownsUrl,
    keyFromUrl(rawUrl) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return null;
      }
      return ownsUrl(url) ? keyFromObjectPath(url.pathname) : null;
    },
    /**
     * Honour one of our own signed links WITHOUT a network round trip: the same checks the route makes, then the file.
     * 403 for a bad or expired signature (the artifact proxy reads that as "the link expired"), 404 when it is gone.
     */
    async open(url) {
      const key = ownsUrl(url) ? keyFromObjectPath(url.pathname) : null;
      const verdict = key === null ? "invalid" : verifyObjectLink({ secret: settings.signingSecret, key, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") });
      if (key === null || verdict !== "ok") return new Response(verdict === "expired" ? "link expired" : "forbidden", { status: 403 });
      return (await openObject(paths, key)) ?? new Response("not found", { status: 404 });
    },
  };
}

export function createFilesystemDriver(settings: FilesystemSettings): StorageDriver {
  const paths = layout(settings.root);

  /** Write bytes under tmp/ and flush them, so the move that follows publishes a complete file. */
  async function stage(bytes: string | Uint8Array): Promise<string> {
    await fs.mkdir(paths.tmp, { recursive: true, mode: 0o700 });
    const tmp = nodePath.join(paths.tmp, `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`);
    const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tmp;
  }

  async function writeMeta(key: string, contentType: string | undefined): Promise<void> {
    const metaPath = paths.metaPath(key);
    if (contentType === undefined) {
      // An overwrite without a type must not inherit the previous object's.
      await unlinkIfPresent(metaPath);
      return;
    }
    await fs.mkdir(nodePath.dirname(metaPath), { recursive: true, mode: 0o700 });
    const tmp = await stage(JSON.stringify({ contentType }));
    await fs.rename(tmp, metaPath);
  }

  /** Every key at or under `dir` whose path starts with `prefix`, unsorted. Only regular files are objects. */
  async function walk(dirKey: string, partial: string, out: string[]): Promise<void> {
    const abs = dirKey === "" ? paths.objects : nodePath.join(paths.objects, ...dirKey.split("/"));
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (isAbsent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (partial !== "" && !entry.name.startsWith(partial)) continue;
      const key = dirKey === "" ? entry.name : `${dirKey}/${entry.name}`;
      if (entry.isFile()) out.push(key);
      // Below the first matching directory every key has the prefix, so the filter is dropped.
      else if (entry.isDirectory()) await walk(key, "", out);
    }
  }

  return {
    kind: "filesystem",
    urls: filesystemUrlRules(settings),

    async put(requestedKey, body, options = {}) {
      assertStorageKey(requestedKey);
      const key = options.addRandomSuffix ? withSuffix(requestedKey, randomBytes(15).toString("base64url").replace(/[-_]/g, "x")) : requestedKey;
      const target = paths.objectPath(key);
      await fs.mkdir(nodePath.dirname(target), { recursive: true, mode: 0o700 });
      if (!(await parentIsInside(paths, target))) throw new StorageKeyError(key, "its folder is not inside the storage root");
      const tmp = await stage(body);
      try {
        if (options.allowOverwrite) {
          await writeMeta(key, options.contentType);
          await fs.rename(tmp, target);
        } else {
          try {
            // link() fails with EEXIST if the key is taken: an atomic "create, never replace".
            await fs.link(tmp, target);
          } catch (error) {
            if (errno(error) === "EEXIST") throw new Error(`storage object already exists: "${key}"`);
            throw error;
          }
          await writeMeta(key, options.contentType);
        }
      } finally {
        await unlinkIfPresent(tmp);
      }
      return { key, ref: key };
    },

    async get(key) {
      return openObject(paths, key);
    },

    async head(ref) {
      const size = await regularFileSize(paths, ref);
      return size === null ? null : { size };
    },

    async list({ prefix, cursor, limit = 1000 }): Promise<StorageListPage> {
      const { dir, partial } = assertStoragePrefix(prefix);
      const after = cursor ? decodeCursor(cursor) : null;
      const keys: string[] = [];
      await walk(dir.join("/"), partial, keys);
      // Code-unit order, the order `Array.prototype.sort()` gives the callers that sort a listing themselves.
      keys.sort();
      const rest = after === null ? keys : keys.filter((key) => key > after);
      const page = rest.slice(0, Math.max(1, limit));
      const hasMore = rest.length > page.length;
      const objects = [];
      for (const key of page) {
        const size = await regularFileSize(paths, key);
        // Removed between the walk and the stat: it is not in the listing.
        if (size !== null) objects.push({ key, size });
      }
      return { objects, hasMore, cursor: hasMore ? encodeCursor(page[page.length - 1]) : undefined };
    },

    async delete(refs) {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        await unlinkIfPresent(paths.objectPath(ref));
        await unlinkIfPresent(paths.metaPath(ref));
      }
    },

    async signedUrl(key, ttlMs) {
      assertStorageKey(key);
      if (!isServableKey(key)) throw new StorageKeyError(key, "no link is signed outside a workspace's data room or artifacts");
      const expiresAt = Date.now() + ttlMs;
      return { url: signObjectUrl({ publicUrl: settings.publicUrl, secret: settings.signingSecret, key, expiresAt }), expiresAt };
    },
  };
}
