/**
 * A workspace snapshot's bytes (mold_v0-033; src/workspace-store.ts): every regular file of a directory with its
 * sha256, in one gzipped bundle, and the manifest that names them. No database, no keys: a runner elsewhere packs and
 * unpacks with this module alone; sealing with the workspace's data key happens on the server (src/orgcrypto.ts).
 *
 *   bundle    gzip( "WSB1\n" + u32 header length + header JSON {files: [{path, size, sha256}]} + each file's bytes )
 *   manifest  {path: {sha256, size}} in path order; its sha256 (of that JSON) names the snapshot's content
 *
 * Packing never follows a symbolic link or reads a special file (a run could plant a link to a server file); it
 * refuses them. Unpacking writes only below the target directory, only plain relative paths, and checks every file's
 * sha256 against the manifest before writing anything.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ENV } from "./env-names.js";

export type Manifest = Record<string, { sha256: string; size: number }>;
const MAGIC = Buffer.from("WSB1\n");
const MAX_FILES = () => Number(ENV.APP_WORKSPACE_MAX_FILES ?? 20_000);
const MAX_BYTES = () => Number(ENV.APP_WORKSPACE_MAX_BYTES ?? 256 * 1024 * 1024);
export class BundleError extends Error { status = 400; }

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** The manifest's own hash: sha256 of its JSON with paths in order. */
export const manifestSha256 = (m: Manifest) => sha256(JSON.stringify(Object.keys(m).sort().map((p) => [p, m[p]!.sha256, m[p]!.size])));

/** A path a bundle may hold: relative, forward slashes, no empty, "." or ".." part, no control characters. */
export function safeRelPath(p: unknown): string {
  if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)
      || p.split("/").some((x) => x === "" || x === "." || x === ".."))
    throw new BundleError(`not a path inside the workspace: ${JSON.stringify(String(p).slice(0, 80))}`);
  return p;
}

/** Every regular file under `dir` (relative paths, sorted). Refuses links and special files; skips nothing else. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) throw new BundleError(`${r} is a symbolic link: a workspace holds plain files only`);
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push(safeRelPath(r));
      else throw new BundleError(`${r} is not a regular file`);
      if (out.length > MAX_FILES()) throw new BundleError(`a workspace holds at most ${MAX_FILES()} files`);
    }
  };
  walk("");
  return out.sort();
}

/** Pack a directory: the bundle (gzipped) and its manifest. */
export function packBundle(dir: string): { bundle: Buffer; manifest: Manifest; manifest_sha256: string; bytes: number } {
  const files = listFiles(dir);
  const manifest: Manifest = {};
  const bodies: Buffer[] = [];
  let total = 0;
  for (const f of files) {
    // Opened without following a link (O_NOFOLLOW) and checked again: a file swapped for a link after the walk is refused.
    let fd: number;
    try { fd = openSync(path.join(dir, f), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { throw new BundleError(`${f}: ${(e as NodeJS.ErrnoException).code === "ELOOP" ? "a symbolic link" : (e as Error).message}`); }
    let b: Buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new BundleError(`${f} is not a regular file`);
      b = readFileSync(fd);
    } finally { closeSync(fd); }
    total += b.length;
    if (total > MAX_BYTES()) throw new BundleError(`a workspace holds at most ${MAX_BYTES()} bytes`);
    manifest[f] = { sha256: sha256(b), size: b.length };
    bodies.push(b);
  }
  const header = Buffer.from(JSON.stringify({ files: files.map((f) => ({ path: f, ...manifest[f] })) }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  return { bundle: gzipSync(Buffer.concat([MAGIC, len, header, ...bodies])), manifest, manifest_sha256: manifestSha256(manifest), bytes: total };
}

/** Read a bundle: its files, each checked against its sha256. Nothing is written. */
export function readBundle(bundle: Buffer): { files: { path: string; body: Buffer }[]; manifest: Manifest; manifest_sha256: string } {
  let raw: Buffer;
  try { raw = gunzipSync(bundle, { maxOutputLength: MAX_BYTES() + 64 * 1024 * 1024 }); } catch (e) { throw new BundleError(`not a workspace bundle: ${(e as Error).message}`); }
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new BundleError("not a workspace bundle");
  const hlen = raw.readUInt32BE(MAGIC.length);
  let header: { files: { path: string; size: number; sha256: string }[] };
  try { header = JSON.parse(raw.subarray(MAGIC.length + 4, MAGIC.length + 4 + hlen).toString("utf8")); } catch { throw new BundleError("a bundle's header is not JSON"); }
  if (!Array.isArray(header?.files) || header.files.length > MAX_FILES()) throw new BundleError("a bundle's header lists no files");
  let at = MAGIC.length + 4 + hlen;
  const manifest: Manifest = {};
  const files: { path: string; body: Buffer }[] = [];
  for (const f of header.files) {
    const p = safeRelPath(f?.path);
    if (manifest[p]) throw new BundleError(`${p} is in the bundle twice`);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || at + f.size > raw.length) throw new BundleError(`${p}: bad size`);
    const body = raw.subarray(at, at + f.size);
    at += f.size;
    if (sha256(body) !== f.sha256) throw new BundleError(`${p}: its content does not match its sha256`);
    manifest[p] = { sha256: f.sha256, size: f.size };
    files.push({ path: p, body });
  }
  if (at !== raw.length) throw new BundleError("a bundle has bytes after its last file");
  return { files, manifest, manifest_sha256: manifestSha256(manifest) };
}

/** Unpack a bundle into an empty directory. `expect` (a manifest hash) must match when given. */
export function unpackBundle(bundle: Buffer, dir: string, expect?: string): { manifest: Manifest; manifest_sha256: string } {
  const { files, manifest, manifest_sha256 } = readBundle(bundle);
  if (expect && expect !== manifest_sha256) throw new BundleError("the snapshot's content does not match its manifest");
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) throw new BundleError("a workspace is checked out into an empty directory only");
  const root = path.resolve(dir);
  for (const f of files) {
    const target = path.resolve(root, f.path);
    if (!target.startsWith(root + path.sep)) throw new BundleError(`${f.path} is outside the workspace`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.body, { flag: "wx" });
  }
  return { manifest, manifest_sha256 };
}

/** The empty workspace (a workspace's first run). */
export const EMPTY_MANIFEST_SHA256 = manifestSha256({});
