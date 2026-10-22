/**
 * The workspace store's file viewer (mold_v0-056): what the console's /app/files page reads, for a signed-in person of a
 * workspace (src/app.ts customerSession: the workspace is the session's, never the request's, and the request runs
 * under that workspace's row-level security). Read only. Mounted at /api/workspace-files only when the build has a
 * workspace store (a pack with a kind with workspace: true, or an agent-workspace kind): with zero packs nothing answers.
 *
 *   GET /                                         the stores this person may read: {stores: [{store, label, retention}]}
 *   GET /:store/versions                          the store's versions, newest first: time, the run that wrote it (id,
 *                                                 kind), files, bytes
 *   GET /:store/versions/:v/files                 a version's files (the tree: path and size), less those never shown
 *                                                 (`hidden` counts them)
 *   GET /:store/versions/:v/file?path=p           one text file: {text} (or {binary: true}), at most
 *                                                 OCTILLION_WORKSPACE_VIEW_MAX_BYTES (1 MiB): a larger one is refused (413)
 *   GET /:store/versions/:v/download?path=p       one file's bytes, as an attachment (application/octet-stream, nosniff,
 *                                                 a sandboxing CSP), at most OCTILLION_WORKSPACE_DOWNLOAD_MAX_BYTES (25 MiB)
 *   GET /:store/diff?from=a&to=b                  which files were added, removed and changed between two versions
 *   GET /:store/diff?from=a&to=b&path=p           one text file's line diff (hunks), each side at most
 *                                                 OCTILLION_WORKSPACE_DIFF_MAX_BYTES (256 KiB)
 *
 * Who: the roles that may read every record area of the store's pack (src/record-areas.ts may; with no area, every role
 * that may read). What is never shown, listed or served (src/workspace-store-policy.ts pathRefusal): a path with a
 * segment starting with ".", a credential-looking file, a file the pack declares secret (workspace_store.secret_paths)
 * or strips (its agent kinds' strip), a file a credential is delivered as; nor a file that holds any form of one of the
 * workspace's credential values (src/credential-redact.ts findSecret). A path is a plain relative path (no "..", no
 * leading "/", src/workspace-bundle.ts safeRelPath) that the version's manifest names; anything else is refused.
 * Contents are opened per request with the workspace's own data key (src/orgcrypto.ts), checked against the manifest,
 * and never cached; with the key vault locked a file, a tree or a diff is refused (503: the credential check needs the
 * vault), never served unchecked; the versions are still listed. Text goes out as JSON
 * (the console renders it as text, never as markup); a download as bytes no browser renders.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { canAccount } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import { findSecret, type Secret } from "./credential-redact.js";
import { getDb } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { findArea, may, type Actor } from "./record-areas.js";
import { BundleError, readBundle, safeRelPath, type Manifest } from "./workspace-bundle.js";
import { storePacks, storePolicy } from "./workspace-retention.js";
import { openSnapshot, snapshotAt } from "./workspace-store.js";
import { pathRefusal, pathRules, type PathRules } from "./workspace-store-policy.js";

const cap = (name: string, def: number) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : def; };
export const VIEW_MAX = () => cap("OCTILLION_WORKSPACE_VIEW_MAX_BYTES", 1024 * 1024);
export const DOWNLOAD_MAX = () => cap("OCTILLION_WORKSPACE_DOWNLOAD_MAX_BYTES", 25 * 1024 * 1024);
export const DIFF_MAX = () => cap("OCTILLION_WORKSPACE_DIFF_MAX_BYTES", 256 * 1024);
const DIFF_MAX_LINES = 20_000;
const DIFF_MAX_EDITS = 4_000;
const CONTEXT = 3;

// ---------- who may read which store ----------

/** Whether `actor` may read `store`'s files: a store of the build, and a role that may read every area of its pack. */
export function storeReadable(store: string, actor: Actor): boolean {
  const p = storePacks().find((x) => x.id === store);
  if (!p) return false;
  if (actor.role === null) return true;
  if (!canAccount(actor.role, "read")) return false;
  return (p.definition.recordAreas ?? []).every((a) => { const area = findArea(a.name); return !!area && may(area, "read", actor); });
}
const storeFor = (store: string, actor: Actor) => {
  const p = storePacks().find((x) => x.id === store);
  if (!p) throw new PackError("no such file store", 404);
  if (!storeReadable(store, actor)) throw new PackError("Your role can't read these files: they are evidence of records your role may not read.", 403);
  return p;
};
const rulesCache = new WeakMap<object, PathRules>();
const rulesOf = (store: string): PathRules => {
  const def = packs().find((x) => x.id === store)?.definition ?? null;
  if (!def) return pathRules(null);
  let r = rulesCache.get(def);
  if (!r) { r = pathRules(def as Parameters<typeof pathRules>[0]); rulesCache.set(def, r); }
  return r;
};

/** The stores a person may read, with their retention in words for the page. */
export function viewerStores(actor: Actor) {
  return storePacks().filter((p) => storeReadable(p.id, actor)).map((p) => ({ store: p.id, label: p.manifest.name || p.id, retention: storePolicy(p.id) }));
}

// ---------- versions and their files ----------

export interface VersionView { version: number; committed_at: string | null; run_id: string | null; run_kind: string | null; files: number; bytes: number; manifest_sha256: string }

/** The store's committed versions in `orgId`, newest first (at most 500). */
export async function listVersions(orgId: number, store: string): Promise<VersionView[]> {
  const rows = await (await getDb()).query<{ version: number; committed_at: Date | null; run_id: string | null; run_kind: string | null; files: number; bytes: string | number; manifest_sha256: string }>(
    `SELECT s.version, s.committed_at, s.run_id, r.kind AS run_kind, s.files, s.bytes, s.manifest_sha256
       FROM workspace_snapshots s LEFT JOIN runs r ON r.id = s.run_id AND r.org_id = s.org_id
      WHERE s.org_id = $1 AND s.store = $2 AND s.status = 'committed' ORDER BY s.version DESC LIMIT 500`, [orgId, store]);
  return rows.map((r) => ({ version: Number(r.version), committed_at: r.committed_at ? new Date(r.committed_at).toISOString() : null, run_id: r.run_id,
    run_kind: r.run_kind, files: Number(r.files), bytes: Number(r.bytes), manifest_sha256: r.manifest_sha256 }));
}

const versionNumber = (v: unknown) => {
  const n = Number(v);
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v) || !Number.isSafeInteger(n) || n < 1) throw new PackError("a version is a whole number from 1", 400);
  return n;
};
async function version(orgId: number, store: string, v: unknown) {
  const s = await snapshotAt(await getDb(), orgId, store, versionNumber(v));
  if (!s || s.org_id !== orgId) throw new PackError("no such version (it may have expired under the store's retention)", 404);
  return s;
}

/**
 * The files of a manifest the viewer lists (sorted), and how many it leaves out: those its path rules never show and
 * any whose path holds one of the workspace's credential values. A listing names a file and its size only, never its
 * hash (a hash of a short value could be guessed); the hash goes out with the file, once its contents passed.
 */
function visible(m: Manifest, rules: PathRules, secrets: Secret[]) {
  const files: { path: string; size: number; sha256: string }[] = [];
  let hidden = 0;
  for (const p of Object.keys(m).sort()) {
    if (pathRefusal(p, rules) || findSecret(p, secrets)) { hidden++; continue; }
    files.push({ path: p, size: m[p]!.size, sha256: m[p]!.sha256 });
  }
  return { files, hidden };
}
/** The workspace's credential values, for checking paths and contents: a listing needs them too, so the vault unlocked. */
async function secretsOf(orgId: number): Promise<Secret[]> {
  if (!vaultUnlocked()) throw new PackError("the key vault is locked: files cannot be listed or opened now, try again later", 503);
  const { workspaceSecrets } = await import("./credentials.js");
  return workspaceSecrets(orgId);
}

export async function versionFiles(orgId: number, store: string, v: unknown) {
  const s = await version(orgId, store, v);
  const { files, hidden } = visible(s.manifest, rulesOf(store), await secretsOf(orgId));
  return { version: s.version, committed_at: s.committed_at ? new Date(s.committed_at).toISOString() : null, run_id: s.run_id,
    files: files.map((f) => ({ path: f.path, size: f.size })), hidden };
}

/** A requested path: a plain relative path, not one the viewer never shows. */
function checkedPath(store: string, p: unknown, secrets: Secret[] = []): string {
  let path: string;
  try { path = safeRelPath(p); } catch (e) { throw new PackError((e as BundleError).message, 400); }
  const why = pathRefusal(path, rulesOf(store)) ?? (findSecret(path, secrets) ? "secret" : null);
  if (why) throw new PackError(why === "hidden" ? "hidden files are not shown" : "this file may hold credentials: it is not shown", 403);
  return path;
}

// Opening a version decrypts and checks its whole bundle in memory: a few at a time per server.
let opening = 0;
const waiting: (() => void)[] = [];
async function withOpenSlot<T>(fn: () => Promise<T>): Promise<T> {
  const most = cap("OCTILLION_WORKSPACE_VIEW_CONCURRENCY", 2);
  if (opening >= most) await new Promise<void>((r) => waiting.push(r));
  opening++;
  try { return await fn(); } finally { opening--; waiting.shift()?.(); }
}

/**
 * One file of a version: checked path, size under `max`, opened with the workspace's key (the vault unlocked), checked
 * against the manifest, and holding none of the workspace's credential values.
 */
async function fileBody(orgId: number, store: string, v: unknown, p: unknown, max: number, what: string): Promise<{ path: string; version: number; size: number; sha256: string; body: Buffer }> {
  checkedPath(store, p);
  const secrets = await secretsOf(orgId);
  const path = checkedPath(store, p, secrets);
  const s = await version(orgId, store, v);
  const entry = s.manifest[path];
  if (!entry) throw new PackError(`version ${s.version} has no file ${path}`, 404);
  if (entry.size > max) throw new PackError(`${path} is ${entry.size} bytes: too large to ${what} here (at most ${max})`, 413);
  const body = await withOpenSlot(async () => {
    let files;
    try { files = readBundle(await openSnapshot(s)).files; }
    catch (e) { console.error(`workspace files: version ${s.version} of ${store} in workspace ${orgId} did not open (${(e as Error).name})`); throw new PackError("this version's files could not be opened: try again later", 503); }
    return files.find((f) => f.path === path)?.body ?? null;
  });
  if (!body || body.length !== entry.size) throw new PackError("this version's files could not be opened: try again later", 503);
  if (findSecret(body, secrets)) throw new PackError(`${path} holds one of this workspace's credentials: it is not shown`, 403);
  return { path, version: s.version!, size: entry.size, sha256: entry.sha256, body };
}

/** Text when the bytes are UTF-8 with no NUL; null for anything else (shown as binary, offered as a download). */
const asText = (b: Buffer): string | null => {
  if (b.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
};

export async function viewFile(orgId: number, store: string, v: unknown, p: unknown) {
  const f = await fileBody(orgId, store, v, p, VIEW_MAX(), "show");
  const text = asText(f.body);
  return { path: f.path, version: f.version, size: f.size, sha256: f.sha256, binary: text === null, text };
}

export const downloadFile = (orgId: number, store: string, v: unknown, p: unknown) => fileBody(orgId, store, v, p, DOWNLOAD_MAX(), "download");

// ---------- diffs ----------

export async function diffVersions(orgId: number, store: string, from: unknown, to: unknown) {
  const [a, b] = [await version(orgId, store, from), await version(orgId, store, to)];
  const rules = rulesOf(store), secrets = await secretsOf(orgId);
  const A = visible(a.manifest, rules, secrets).files, B = visible(b.manifest, rules, secrets).files;
  const inA = new Map(A.map((f) => [f.path, f])), inB = new Map(B.map((f) => [f.path, f]));
  return {
    from: a.version, to: b.version,
    added: B.filter((f) => !inA.has(f.path)).map((f) => ({ path: f.path, size: f.size })),
    removed: A.filter((f) => !inB.has(f.path)).map((f) => ({ path: f.path, size: f.size })),
    changed: B.filter((f) => inA.has(f.path) && inA.get(f.path)!.sha256 !== f.sha256).map((f) => ({ path: f.path, from_size: inA.get(f.path)!.size, size: f.size })),
  };
}

export interface DiffLine { op: " " | "-" | "+"; text: string }
export interface Hunk { from_start: number; from_lines: number; to_start: number; to_lines: number; lines: DiffLine[] }

/** One file's line diff between two versions (absent on one side: all added or all removed). */
export async function diffFile(orgId: number, store: string, from: unknown, to: unknown, p: unknown) {
  const path = checkedPath(store, p, await secretsOf(orgId));
  const [a, b] = [await version(orgId, store, from), await version(orgId, store, to)];
  if (!a.manifest[path] && !b.manifest[path]) throw new PackError(`neither version has ${path}`, 404);
  const side = async (s: typeof a) => {
    if (!s.manifest[path]) return "";
    const t = asText((await fileBody(orgId, store, String(s.version), path, DIFF_MAX(), "compare")).body);
    if (t === null) throw new PackError(`${path} is not text: download each version to compare it`, 415);
    return t;
  };
  const [x, y] = [await side(a), await side(b)];
  const same = a.manifest[path]?.sha256 === b.manifest[path]?.sha256;
  const hunks = same ? [] : lineDiff(x, y);
  if (hunks === null) throw new PackError(`${path} changed too much to show line by line: download each version to compare it`, 413);
  // Lines are compared without their line endings: a file that differs only in those (CRLF, a last newline) says so.
  const note = !same && !hunks.length ? "the versions differ only in line endings or the final newline" : null;
  return { path, from: a.version, to: b.version, hunks, note };
}

const lines = (t: string) => (t === "" ? [] : t.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/**
 * A line diff (Myers, O((N+M)D) time, O(D^2) memory), as unified hunks with CONTEXT lines around each change. Null when
 * the files have more than DIFF_MAX_LINES lines or need more than DIFF_MAX_EDITS edits.
 */
export function lineDiff(x: string, y: string): Hunk[] | null {
  const a = lines(x), b = lines(y);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  // The common start and end need no search.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const mid = myers(A, B);
  if (!mid) return null;
  const ops: DiffLine[] = [...a.slice(0, pre).map((t) => ({ op: " " as const, text: t })), ...mid, ...a.slice(a.length - suf).map((t) => ({ op: " " as const, text: t }))];
  // Group into hunks: each change with CONTEXT unchanged lines on either side; close changes share a hunk.
  const hunks: Hunk[] = [];
  let ai = 0, bi = 0, i = 0;
  const pos: { ai: number; bi: number }[] = ops.map((o) => { const p = { ai, bi }; if (o.op !== "+") ai++; if (o.op !== "-") bi++; return p; });
  while (i < ops.length) {
    if (ops[i]!.op === " ") { i++; continue; }
    let start = Math.max(0, i - CONTEXT), end = i;
    // Extend while the next change is within 2 * CONTEXT unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.op !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.op === " " && gap - end < 2 * CONTEXT + 1) gap++;
      if (gap < ops.length && ops[gap]!.op !== " " && gap - end <= 2 * CONTEXT) { end = gap; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    const slice = ops.slice(start, stop);
    hunks.push({ from_start: pos[start]!.ai + 1, from_lines: slice.filter((o) => o.op !== "+").length, to_start: pos[start]!.bi + 1, to_lines: slice.filter((o) => o.op !== "-").length, lines: slice });
    i = stop;
  }
  return hunks;
}

function myers(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  const max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, DIFF_MAX_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  const out: DiffLine[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!, at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    while (x > px && y > py) { out.push({ op: " ", text: a[x - 1]! }); x--; y--; }
    if (x === px) out.push({ op: "+", text: b[py]! });
    else out.push({ op: "-", text: a[px]! });
    x = px; y = py;
  }
  while (x > 0 && y > 0) { out.push({ op: " ", text: a[x - 1]! }); x--; y--; }
  return out.reverse();
}

// ---------- over HTTP ----------

const answer = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = await fn(req, res);
    if (!res.headersSent) res.json(v);
  } catch (e) {
    if (e instanceof PackError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const session = (res: Response) => res.locals.session as Session;
const actorOf = (res: Response): Actor => { const s = session(res); return { role: s.accountRole ?? null, userId: s.user ?? null }; };

/** A download's file name: the path's last part, as a plain ASCII name and in RFC 5987 form. */
const disposition = (p: string) => {
  const base = p.split("/").pop() || "file";
  const ascii = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
  // RFC 5987: encodeURIComponent leaves ' ( ) * ! as they are; they are encoded too.
  const ext = encodeURIComponent(base).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
};

/** /api/workspace-files: mounted when the build has a workspace store. */
export function workspaceFileAppRouter(): Router {
  const r = express.Router();
  if (!storePacks().length) return r;
  r.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); next(); });
  // Read only: anything but GET is not here.
  r.use((req, res, next) => (req.method === "GET" || req.method === "HEAD" ? next() : void res.status(405).json({ error: "Read only" })));
  r.use(customerSession);
  const S = (res: Response) => session(res).org;
  r.get("/", answer((_req, res) => ({ stores: viewerStores(actorOf(res)) })));
  r.get("/:store/versions", answer(async (req, res) => {
    const p = storeFor(String(req.params.store), actorOf(res));
    return { store: p.id, label: p.manifest.name || p.id, retention: storePolicy(p.id), versions: await listVersions(S(res), p.id) };
  }));
  r.get("/:store/versions/:v/files", answer(async (req, res) => {
    const p = storeFor(String(req.params.store), actorOf(res));
    return { store: p.id, ...(await versionFiles(S(res), p.id, String(req.params.v))) };
  }));
  r.get("/:store/versions/:v/file", answer(async (req, res) => {
    const p = storeFor(String(req.params.store), actorOf(res));
    return { store: p.id, ...(await viewFile(S(res), p.id, String(req.params.v), req.query.path)) };
  }));
  r.get("/:store/versions/:v/download", answer(async (req, res) => {
    const p = storeFor(String(req.params.store), actorOf(res));
    const f = await downloadFile(S(res), p.id, String(req.params.v), req.query.path);
    res.set({
      "Content-Type": "application/octet-stream", "Content-Disposition": disposition(f.path), "Content-Length": String(f.body.length),
      // Never rendered: an attachment, no sniffing, and a policy that would run nothing if a browser tried.
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin", "X-Workspace-File-Sha256": f.sha256,
    });
    res.end(f.body);
  }));
  r.get("/:store/diff", answer(async (req, res) => {
    const p = storeFor(String(req.params.store), actorOf(res));
    const q = req.query;
    return { store: p.id, ...(q.path === undefined ? await diffVersions(S(res), p.id, q.from, q.to) : await diffFile(S(res), p.id, q.from, q.to, q.path)) };
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
