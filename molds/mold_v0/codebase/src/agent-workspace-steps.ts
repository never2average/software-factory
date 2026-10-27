/**
 * What an agent-workspace run does besides its one command (molds/mold_v0/MOLD.md "The agent-workspace runner";
 * configured by src/agent-workspace-config.ts, carried out by src/run-harness.ts). Plain node only: the run sandbox's
 * runner imports it (orchestrator/deploy/boat-lib.ts runnerCodeFiles).
 *
 *   mapResults        (mold_v0-071) the program's own result file mapped into run results: the list at a JSON pointer,
 *                     each item's check/asset/source/status/fingerprint/evidence/detail from templates over its own
 *                     fields (own properties only), checked as the engine will check them; an item that does not map
 *                     is reported, and the kind's unresolved_references decides (reject: the run fails)
 *   checkInput        (mold_v0-073) a value against an input's JSON schema (the fixed subset the config accepts)
 *   pinCommits        (mold_v0-166) the repositories an input lists, each without a commit pinned to its branch's head
 *   writeInputFile    a new file in the checkout: never through a link, never over an existing file
 *   gitCredentialFiles (mold_v0-074) git's credential helper for one step: a config file and a helper script that
 *                     answers only its declared hosts, reading each token from a file on tmpfs (never an argument, a
 *                     variable or a URL)
 *   CheckoutCache     repositories at pinned commits, outside the workspace store: per workspace (its own directory,
 *                     root's, entered only during that workspace's run), per repository and commit, size-capped
 *                     (least recently used go first), unused entries and unfinished fetches cleaned
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, fchownSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentRunError } from "./agent-workspace.js";
import { globRegex } from "./agent-workspace-paths.js";

// ---------- results_from (mold_v0-071) ----------

type Ref = { area: string; key: string };
export interface ResultsFrom {
  file: string; pointer: string;
  check: Ref; asset?: Ref; source?: Ref;
  status: string | { from: string; map: Record<string, string>; default?: string };
  fingerprint?: string; evidence?: string; detail: Record<string, string>;
  where?: { field: string; in: (string | number | boolean)[] };
}
const STATUSES = new Set(["pass", "fail", "error", "not_applicable", "unknown"]);
const FINGERPRINT = /^[A-Za-z0-9:_.\-/]{1,160}$/;

/** An own property of a plain object (never its prototype's), or an array's element. */
const own = (o: unknown, k: string): unknown => {
  if (Array.isArray(o)) return /^(0|[1-9]\d{0,8})$/.test(k) ? o[Number(k)] : undefined;
  return o && typeof o === "object" && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
};
const dig = (o: unknown, dotted: string) => dotted.split(".").reduce<unknown>((v, k) => own(v, k), o);

/** The value at a JSON pointer (RFC 6901), own properties only. */
export function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  return pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce<unknown>((v, k) => own(v, k), doc);
}

class Unmappable extends Error {}
/** A template filled from an item, the run's arguments ($args.x) and the file's root ($root.x): single values only. */
function fill(t: string, item: unknown, args: Record<string, string>, rootDoc: unknown): string {
  return t.replace(/\{([^{}]*)\}/g, (_m, p: string) => {
    const v = p.startsWith("$args.") ? (Object.hasOwn(args, p.slice(6)) ? args[p.slice(6)] : undefined) : p.startsWith("$root.") ? dig(rootDoc, p.slice(6)) : dig(item, p);
    if (typeof v === "string") return v;
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") return String(v);
    throw new Unmappable(`{${p}} is ${v === undefined ? "missing" : v === null ? "null" : "not a single value"}`);
  });
}

export interface MappedResults { results: Record<string, unknown>[]; unmapped: { item: number; reason: string }[]; skipped: number; items: number }

/**
 * The run results a result file stands for. Throws AgentRunError when the file is not JSON or the pointer names no list;
 * an item that does not map is listed in `unmapped` (the caller applies the kind's policy). Every mapped value is a
 * string the engine checks again (references against the run's own workspace, the status, the fingerprint).
 */
export function mapResults(text: string, rf: ResultsFrom, args: Record<string, string>): MappedResults {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new AgentRunError(`results_from: ${rf.file} is not valid JSON`); }
  const list = atPointer(doc, rf.pointer);
  if (!Array.isArray(list)) throw new AgentRunError(`results_from: ${rf.file}${rf.pointer ? ` at ${rf.pointer}` : ""} is not a list`);
  if (list.length > 5000) throw new AgentRunError(`results_from: ${list.length} items (at most 5000 results per run)`);
  const out: MappedResults = { results: [], unmapped: [], skipped: 0, items: list.length };
  for (const [i, item] of list.entries()) {
    if (rf.where) {
      const v = dig(item, rf.where.field);
      if (!rf.where.in.some((w) => w === v)) { out.skipped++; continue; }
    }
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Unmappable("not an object");
      const ref = (r: Ref | undefined) => {
        if (!r) return undefined;
        const key = fill(r.key, item, args, doc);
        if (!key || key.length > 300 || /[\u0000-\u001f]/.test(key)) throw new Unmappable(`a ${r.area} key that is empty, too long or holds control characters`);
        return { area: r.area, key };
      };
      let status: string;
      if (typeof rf.status === "string") status = rf.status;
      else {
        const raw = dig(item, rf.status.from);
        const v = typeof raw === "string" ? raw : (typeof raw === "number" && Number.isFinite(raw)) || typeof raw === "boolean" ? String(raw) : null;
        if (v === null && !rf.status.default) throw new Unmappable(`its ${rf.status.from} is ${raw === undefined ? "missing" : "not a single value"}`);
        const m = v !== null && Object.hasOwn(rf.status.map, v) ? rf.status.map[v] : undefined;
        if (m) status = m;
        else if (v !== null && STATUSES.has(v) && !Object.keys(rf.status.map).length) status = v;
        else if (rf.status.default) status = rf.status.default;
        else throw new Unmappable(`status ${JSON.stringify(v).slice(0, 60)} is not in the map`);
      }
      if (!STATUSES.has(status)) throw new Unmappable("not a result status");
      const r: Record<string, unknown> = { check: ref(rf.check), status };
      const asset = ref(rf.asset), source = ref(rf.source);
      if (asset) r.asset = asset;
      if (source) r.source = source;
      if (rf.fingerprint) {
        const fp = fill(rf.fingerprint, item, args, doc);
        if (!FINGERPRINT.test(fp)) throw new Unmappable("a fingerprint that is not 1-160 letters, digits, : _ . - /");
        r.finding_fingerprint = fp;
      }
      if (rf.evidence) {
        const ev = fill(rf.evidence, item, args, doc);
        if (ev.length > 500 || /[\u0000-\u001f]/.test(ev)) throw new Unmappable("evidence longer than 500 characters or with control characters");
        r.evidence_ref = ev;
      }
      const detail: Record<string, string> = {};
      // A detail field the item lacks is left out (it is not the result's identity).
      for (const [k, t] of Object.entries(rf.detail)) { try { detail[k] = fill(t, item, args, doc).slice(0, 2000); } catch { /* absent */ } }
      if (Buffer.byteLength(JSON.stringify(detail)) > 16 * 1024) throw new Unmappable("its detail is over 16 KB");
      r.detail = detail;
      out.results.push(r);
    } catch (e) {
      if (!(e instanceof Unmappable)) throw e;
      out.unmapped.push({ item: i, reason: e.message.slice(0, 200) });
    }
  }
  return out;
}

// ---------- inputs (mold_v0-073) ----------

export type InputSchema = {
  type?: string | string[]; properties?: Record<string, InputSchema>; required?: string[]; additionalProperties?: boolean | InputSchema;
  items?: InputSchema; enum?: unknown[]; const?: unknown; pattern?: string; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; maxProperties?: number;
};
const typeOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The first few places where `v` breaks `s` (empty: valid). The subset src/agent-workspace-config.ts InputSchemaSchema takes. */
export function checkInput(v: unknown, s: InputSchema, at = "$", out: string[] = [], depth = 0): string[] {
  if (out.length >= 10) return out;
  if (depth > 32) { out.push(`${at}: nested too deep`); return out; }
  const bad = (m: string) => out.push(`${at}: ${m}`);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) { bad(`must be ${types.join(" or ")}`); return out; }
  }
  if (s.enum && !s.enum.some((e) => same(e, v))) bad("is not one of the allowed values");
  if (s.const !== undefined && !same(s.const, v)) bad("is not the allowed value");
  if (typeof v === "string") {
    const n = [...v].length;
    if (s.minLength !== undefined && n < s.minLength) bad(`is shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && n > s.maxLength) bad(`is longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) bad("does not match its pattern");
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) bad(`is below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) bad(`is above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) bad(`has fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) bad(`has more than ${s.maxItems} items`);
    if (s.items) for (const [i, x] of v.entries()) checkInput(x, s.items, `${at}[${i}]`, out, depth + 1);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties) bad(`has more than ${s.maxProperties} properties`);
    for (const r of s.required ?? []) if (!Object.hasOwn(o, r)) bad(`lacks ${r}`);
    for (const k of keys) {
      const sub = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : undefined;
      if (sub) checkInput(o[k], sub, `${at}.${k}`, out, depth + 1);
      else if (s.additionalProperties === false) bad(`has ${k.slice(0, 40)}, which is not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") checkInput(o[k], s.additionalProperties, `${at}.${k}`, out, depth + 1);
    }
  }
  return out;
}

/** (mold_v0-166) An input's `pin` (src/agent-workspace-config.ts InputPinSchema). */
export interface InputPin { list: string; url: string; branch: string; commit: string; hosts: string[]; max_items: number }

/**
 * A copy of the input `value` with every repository of its `pin.list` that gives no commit pinned to its branch's
 * current commit (and its default branch filled in when it names none), by `resolve` (src/agent-workspace.ts
 * headCommit). Each url must be https on one of `pin.hosts` exactly; `local` lets the offline tests use a file:// one.
 */
export async function pinCommits(value: unknown, pin: InputPin, resolve: (url: string, branch: string | undefined) => Promise<{ commit: string; branch: string }>,
  local: (url: string) => boolean = () => false): Promise<unknown> {
  const doc = structuredClone(value);
  const list = atPointer(doc, pin.list);
  if (!Array.isArray(list)) throw new AgentRunError(`pin: ${pin.list} is not a list`);
  if (list.length > pin.max_items) throw new AgentRunError(`pin: ${pin.list} lists ${list.length} repositories, more than ${pin.max_items}`);
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AgentRunError(`pin: ${pin.list}/${i} is not an object`);
    const o = item as Record<string, unknown>;
    if (own(o, pin.commit) !== undefined) continue;
    const url = own(o, pin.url), branch = own(o, pin.branch);
    if (typeof url !== "string") throw new AgentRunError(`pin: ${pin.list}/${i} has no ${pin.url}`);
    if (branch !== undefined && typeof branch !== "string") throw new AgentRunError(`pin: ${pin.list}/${i}: ${pin.branch} is not text`);
    if (!local(url)) {
      if (!/^https:\/\/[A-Za-z0-9.-]+(:443)?\/[A-Za-z0-9._~\/-]+$/.test(url)) throw new AgentRunError(`pin: ${pin.list}/${i}: ${pin.url} must be an https:// address with no user, query or fragment`);
      const h = new URL(url).hostname.toLowerCase();
      if (!pin.hosts.includes(h)) throw new AgentRunError(`pin: ${pin.list}/${i}: ${h} is not one of the pin's hosts (${pin.hosts.join(", ")})`);
    }
    const got = await resolve(url, branch as string | undefined);
    o[pin.commit] = got.commit;
    if (branch === undefined) o[pin.branch] = got.branch;
  }
  return doc;
}

/**
 * Write `body` to the new file `rel` of the checkout: every directory on the way a real one (made when missing, never
 * a link), the file created exclusively without following a link (an existing file, of the pinned tree or not, is never
 * replaced). Returns the directories it made, for their owner.
 */
export function writeInputFile(checkout: string, rel: string, body: Buffer, owner: { uid: number; gid: number } | null): void {
  let cur = checkout;
  for (const p of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, p);
    let st; try { st = lstatSync(cur); } catch { st = null; }
    if (st && !st.isDirectory()) throw new AgentRunError(`input ${rel}: ${path.relative(checkout, cur)} is not a directory (a link or a file stands there)`);
    if (!st) { mkdirSync(cur, { mode: 0o755 }); if (owner) chownSync(cur, owner.uid, owner.gid); }
  }
  let fd: number;
  try { fd = openSync(path.join(checkout, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
  catch (e) { throw new AgentRunError(`input ${rel}: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "a file of the checkout is already there (an input never replaces one)" : "cannot be written"}`); }
  try { writeFileSync(fd, body); if (owner) fchownSync(fd, owner.uid, owner.gid); } finally { closeSync(fd); }
}

// ---------- git credentials (mold_v0-074) ----------

export interface GitCredential { protocol: "https" | "http"; host: string; username: string; value: string }
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Git's credential set-up for one program, in `dir` (a private directory on tmpfs): each token in its own file (0400),
 * a helper script that answers `get` for exactly the declared protocol://host and prints that file's content, and a
 * global git config that names the helper for those hosts only (and no other helper). The token is never in an
 * argument, a variable or a URL: git runs the helper (`/bin/sh <script> get`), whose printf is the shell's own.
 * Returns the variables that point git at the config (GIT_CONFIG_GLOBAL; no system config; no prompt).
 */
export function gitCredentialFiles(dir: string, creds: GitCredential[], owner: { uid: number; gid: number } | null): { env: Record<string, string>; helper: string; scopes: string[] } {
  if (!SAFE_PATH.test(dir)) throw new AgentRunError("git credentials: the private directory's path holds unexpected characters");
  // In a directory of their own (never beside the step's credential files, whose names a pack chooses).
  dir = path.join(dir, ".git-credential");
  mkdirSync(dir, { mode: 0o700 });
  if (owner) chownSync(dir, owner.uid, owner.gid);
  const cases: string[] = [], scopes: string[] = [];
  for (const [i, c] of creds.entries()) {
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(c.host) || !/^[A-Za-z0-9._@+-]{1,100}$/.test(c.username)) throw new AgentRunError(`git credentials: ${c.host} or its user name is not plain`);
    if (/[\r\n\u0000]/.test(c.value)) throw new AgentRunError("git credentials: a token spans lines: it is not handed to git");
    const f = path.join(dir, `git-token-${i}`);
    writeFileSync(f, c.value, { mode: 0o400, flag: "wx" });
    if (owner) chownSync(f, owner.uid, owner.gid);
    cases.push(`  ${sq(`${c.protocol}://${c.host}`)}) printf 'username=%s\\n' ${sq(c.username)}; printf 'password=%s\\n' "$(cat ${sq(f)})" ;;`);
    scopes.push(`${c.protocol}://${c.host}`);
  }
  const helper = path.join(dir, "git-credential.sh");
  writeFileSync(helper, [
    "#!/bin/sh",
    "# git credential helper of one run step (mold_v0-074): `get` for its declared hosts only, the token read from a file.",
    '[ "$1" = get ] || exit 0',
    "proto= host=",
    'while IFS= read -r l; do [ -z "$l" ] && break; case "$l" in protocol=*) proto=${l#protocol=} ;; host=*) host=${l#host=} ;; esac; done',
    'case "$proto://$host" in',
    ...cases,
    "esac",
    "exit 0", ""].join("\n"), { mode: 0o500, flag: "wx" });
  const config = path.join(dir, "gitconfig");
  // /dev/shm is often noexec: the helper is run by sh, never executed itself.
  writeFileSync(config, [
    "[credential]", "\thelper =", "\tuseHttpPath = false",
    ...scopes.map((s) => `[credential "${s}"]\n\thelper = "!/bin/sh ${helper}"`),
    "[core]", "\taskPass = /bin/false", ""].join("\n"), { mode: 0o400, flag: "wx" });
  if (owner) { chownSync(helper, owner.uid, owner.gid); chownSync(config, owner.uid, owner.gid); }
  // Also as command-line configuration (GIT_CONFIG_COUNT), which git reads last: a helper a repository's own config adds
  // (one an earlier step could plant) is reset, so the token goes to this helper alone.
  const cmdline: [string, string][] = [["credential.helper", ""], ...scopes.map((sc) => [`credential.${sc}.helper`, `!/bin/sh ${helper}`] as [string, string])];
  return { env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(cmdline.length),
    ...Object.fromEntries(cmdline.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])) }, helper, scopes };
}

// ---------- the checkout cache (mold_v0-074) ----------

const isRoot = () => process.getuid?.() === 0;
/** A directory of the cache: made when missing; when this process is root, root's and writable by no one else. */
function ownDir(p: string, mode: number) {
  let st; try { st = lstatSync(p); } catch { st = null; }
  if (!st) { mkdirSync(p, { recursive: true, mode }); st = lstatSync(p); }
  if (!st.isDirectory()) throw new AgentRunError(`the checkout cache: ${p} is not a directory`, "infrastructure");
  if (isRoot() && (st.uid !== 0 || (st.mode & 0o022))) throw new AgentRunError(`the checkout cache: ${p} is not root's alone: refused`, "infrastructure");
  chmodSync(p, mode);
}
const treeBytes = (dir: string): { bytes: number; files: number } => {
  let bytes = 0, files = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 64) throw new AgentRunError("a checkout nested deeper than 64 directories");
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { files++; bytes += lstatSync(p).size; }
    }
  };
  walk(dir, 0);
  return { bytes, files };
};

export interface CacheEntry { url: string; commit: string; bytes: number; files: number; tree: string; hit: boolean }

export class CheckoutCache {
  readonly dir: string;
  private used = new Set<string>();
  constructor(readonly base: string, orgId: number, private o: { maxBytes: number; maxAgeDays: number; runUser: boolean }) {
    if (!Number.isSafeInteger(orgId) || orgId <= 0) throw new AgentRunError("the checkout cache needs the run's workspace", "infrastructure");
    this.dir = path.join(base, `ws-${orgId}`);
  }
  /** Entered for this run: the base and this workspace's directory traversable (never listable) by the run's user. */
  open() {
    ownDir(this.base, 0o711);
    // Every other workspace's cache closed (a runner that died mid-run may have left one open), then this one opened.
    for (const e of readdirSync(this.base, { withFileTypes: true })) if (e.isDirectory() && /^ws-\d+$/.test(e.name) && path.join(this.base, e.name) !== this.dir) chmodSync(path.join(this.base, e.name), 0o700);
    ownDir(this.dir, this.o.runUser ? 0o711 : 0o700);
    this.clean();
  }
  /** Left: this workspace's directory closed again (no other workspace's run can enter it). */
  close() { try { chmodSync(this.dir, 0o700); } catch { /* gone */ } }
  private entries() {
    const out: { name: string; path: string; bytes: number; atime: number; meta: { url: string; commit: string; bytes: number; files: number } | null }[] = [];
    for (const e of readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory()) { rmSync(path.join(this.dir, e.name), { force: true }); continue; }
      const p = path.join(this.dir, e.name);
      let meta = null;
      try { meta = JSON.parse(readFileSync(path.join(p, "meta.json"), "utf8")); } catch { /* unfinished */ }
      out.push({ name: e.name, path: p, bytes: meta?.bytes ?? 0, atime: statSync(p).mtimeMs, meta });
    }
    return out;
  }
  /** Unfinished fetches (older than an hour) and entries unused for maxAgeDays go; then the least recently used past the cap. */
  clean() {
    const now = Date.now();
    for (const e of this.entries()) {
      if (this.used.has(e.name)) continue;
      if ((!e.meta && now - e.atime > 3600_000) || (e.meta && now - e.atime > this.o.maxAgeDays * 86400_000)) rmSync(e.path, { recursive: true, force: true });
    }
    const all = this.entries().filter((e) => e.meta).sort((a, b) => a.atime - b.atime);
    let total = all.reduce((s, e) => s + e.bytes, 0);
    for (const e of all) {
      if (total <= this.o.maxBytes) break;
      if (this.used.has(e.name)) continue;
      rmSync(e.path, { recursive: true, force: true });
      total -= e.bytes;
    }
  }
  private key = (url: string, commit: string) => createHash("sha256").update(`${url}\u0000${commit}`).digest("hex").slice(0, 32);
  /**
   * The repository at `commit`: from the cache, or fetched (`fetch(dest)` fills an empty directory) into a fresh
   * directory, checked against `maxBytes`, made read-only to everyone but root, and moved into place.
   */
  async get(url: string, commit: string, maxBytes: number, fetch: (dest: string) => Promise<void>): Promise<CacheEntry> {
    const k = this.key(url, commit);
    const hit = this.entries().find((e) => e.name.startsWith(`${k}-`) && e.meta && e.meta.url === url && e.meta.commit === commit);
    if (hit) {
      this.used.add(hit.name);
      const t = new Date();
      utimesSync(hit.path, t, t);
      return { url, commit, bytes: hit.meta!.bytes, files: hit.meta!.files, tree: path.join(hit.path, "tree"), hit: true };
    }
    // A random part in the name: a path into this workspace's cache cannot be guessed, only followed from the link.
    const name = `${k}-${randomBytes(12).toString("hex")}`;
    const tmp = path.join(this.dir, `.tmp-${name}`);
    mkdirSync(tmp, { mode: 0o700 });
    try {
      const tree = path.join(tmp, "tree");
      await fetch(tree);
      const size = treeBytes(tree);
      if (size.bytes > maxBytes) throw new AgentRunError(`the checkout of ${url} at ${commit.slice(0, 12)} is ${size.bytes} bytes, more than its ${maxBytes}`);
      if (size.bytes > this.o.maxBytes) throw new AgentRunError(`the checkout of ${url} is larger than the workspace's whole checkout cache (${this.o.maxBytes} bytes)`);
      // Read-only to the run's user: root's files, no one else may write (git's own modes otherwise, executables kept).
      const fix = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isSymbolicLink()) continue;
          const st = lstatSync(p);
          chmodSync(p, (st.mode & 0o7555) | 0o444 | (e.isDirectory() ? 0o111 : 0));
          if (e.isDirectory()) fix(p);
        }
      };
      fix(tree);
      chmodSync(tree, 0o755);
      writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ url, commit, bytes: size.bytes, files: size.files, at: new Date().toISOString() }), { mode: 0o600 });
      chmodSync(tmp, 0o711);
      renameSync(tmp, path.join(this.dir, name));
      this.used.add(name);
      this.clean();
      return { url, commit, bytes: size.bytes, files: size.files, tree: path.join(this.dir, name, "tree"), hit: false };
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
}

/** Link `target` at `rel` of the checkout (what stood there goes; every directory on the way a real one). */
export function mountInto(checkout: string, rel: string, target: string, owner: { uid: number; gid: number } | null): { replaced: boolean } {
  let cur = checkout;
  for (const p of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, p);
    let st; try { st = lstatSync(cur); } catch { st = null; }
    if (st && !st.isDirectory()) throw new AgentRunError(`checkout: ${path.relative(checkout, cur)} is not a directory (a link or a file stands there)`);
    if (!st) { mkdirSync(cur, { mode: 0o755 }); if (owner) chownSync(cur, owner.uid, owner.gid); }
  }
  const at = path.join(checkout, rel);
  let replaced = false;
  try { const st = lstatSync(at); replaced = true; if (st.isDirectory()) rmSync(at, { recursive: true, force: true }); else unlinkSync(at); } catch { /* absent */ }
  symlinkSync(target, at);
  return { replaced };
}

/** Each manifest file of the checkout matching `glob` (plain files only, at most `max`, each at most 64 KB, never through a link). */
export function readManifests(checkout: string, glob: string, max: number): { path: string; json: unknown }[] {
  const re = globRegex(glob);
  const segs = glob.split("/");
  const firstWild = segs.findIndex((x) => /[*?]/.test(x));
  const start = segs.slice(0, firstWild === -1 ? segs.length - 1 : firstWild).join("/");
  const out: { path: string; json: unknown }[] = [];
  const walk = (rel: string, depth: number) => {
    let names: string[];
    try { const st = lstatSync(path.join(checkout, rel)); if (!st.isDirectory()) return; names = readdirSync(path.join(checkout, rel)).sort(); } catch { return; }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(path.join(checkout, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (depth < 16) walk(r, depth + 1); continue; }
      if (!st.isFile() || !re.test(r)) continue;
      if (out.length >= max) throw new AgentRunError(`checkout: more than ${max} repositories (${glob})`);
      let fd: number;
      try { fd = openSync(path.join(checkout, r), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { continue; }
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.nlink > 1 || s.size > 64 * 1024) throw new AgentRunError(`checkout: ${r} is not a plain file (one name) of at most 64 KB`);
        try { out.push({ path: r, json: JSON.parse(readFileSync(fd, "utf8")) }); } catch { throw new AgentRunError(`checkout: ${r} is not valid JSON`); }
      } finally { closeSync(fd); }
    }
  };
  // Only under the glob's fixed leading directories, each a real directory (never a link out of the checkout).
  let cur = checkout;
  for (const p of start.split("/").filter(Boolean)) {
    if (p === "." || p === "..") return out;
    cur = path.join(cur, p);
    let st; try { st = lstatSync(cur); } catch { return out; }
    if (!st.isDirectory()) return out;
  }
  walk(start, 0);
  return out;
}

/** A manifest's field, as text (own properties only). */
export const field = (o: unknown, dotted: string): string | undefined => { const v = dig(o, dotted); return typeof v === "string" ? v : undefined; };
