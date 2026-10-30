/**
 * The agent-workspace runner's steps (mold_v0-061; configured by src/agent-workspace-config.ts, carried out by
 * src/run-harness.ts, which keeps the run's lifecycle: lease, heartbeat, credentials, the run's user, redaction,
 * completion). Nothing here touches the database: a runner elsewhere (a sandbox) uses it as the in-process one does.
 *
 *   fetchPinned     the agent repository at exactly its pinned commit, into an empty directory: fetched by commit id
 *                   (never a branch or tag), into a repository with no refs, git's own configuration ignored (no
 *                   system or global file, so no insteadOf rewrite), redirects refused, only the repository's own
 *                   protocol allowed, objects checked on receipt; the commit's tree is checked out and the .git
 *                   directory removed. Anything that does not yield exactly that commit refuses the run
 *   stripPaths      the declared paths removed from the checkout (never following a link)
 *   restoreInto     the workspace's snapshot (already unpacked into a private directory) laid over the checkout: only
 *                   files under the write-back paths, written without following any link the checkout holds
 *   collectWriteBack  after a valid run, the write-back paths copied out of the checkout into a fresh directory that is
 *                   staged as the next snapshot: regular files only (a link or a special file is left out and named),
 *                   plus the snapshot's files outside the write-back paths, carried over unchanged
 *   expandArgs      the command's {placeholders} from the run's scope, targets and identity, each value checked
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentWorkspaceConfig } from "./agent-workspace-config.js";
import { globRegex, ignoreMatcher, parseIgnore, placeholders, type IgnoreRule } from "./agent-workspace-paths.js";
import { ENV } from "./env-names.js";

export class AgentRunError extends Error {
  /** "run": the configuration or the run's own doing (final); "infrastructure": the network or the machine (retried). */
  constructor(message: string, public kind: "run" | "infrastructure" = "run") { super(message); }
}

// ---------- the pinned upstream ----------

export interface FetchOptions {
  /** Accept a file:/// repository (a mirror on this machine; the offline tests). Default: https only. */
  allowFile?: boolean;
  /** Accept http:// (tests of the redirect refusal only). */
  allowHttp?: boolean;
  timeoutMs?: number;
  /** Where git keeps its scratch (an empty HOME); a fresh directory under `dest`'s parent by default. */
  home?: string;
  /**
   * A credential helper for the fetch (mold_v0-074, the checkout cache): `/bin/sh <script>` for exactly `scope`
   * (protocol://host) and no other helper; the script (src/agent-workspace-steps.ts gitCredentialFiles) reads the token
   * from a file on tmpfs, so it is never in git's arguments, its environment or the URL.
   */
  credentialHelper?: { scope: string; script: string };
  /** Refuse the commit when its tree holds more than this many bytes, counted from git's objects before anything is checked out. */
  maxTreeBytes?: number;
}

const git = (args: string[], o: { env: Record<string, string>; cwd?: string; timeoutMs: number }) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const p = spawn("git", args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.setEncoding("utf8").on("data", (d: string) => { if (out.length < 1 << 20) out += d; });
  p.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 1 << 16) err += d; });
  const t = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs);
  p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, out, err: String(e.message) }); });
  p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

/** The repository's protocol, refused unless allowed: https, else file (a local mirror) or http only when told. */
export function upstreamProtocol(url: string, o: FetchOptions = {}): "https" | "file" | "http" {
  const proto = /^([a-z]+):\/\//.exec(url)?.[1];
  if (proto === "https") {
    // The runner fetches outside the run's egress proxy: never an address or a local name, and, when the operator
    // lists hosts (APP_AGENT_REPO_HOSTS, comma-separated; a host allows its subdomains), only those.
    const host = new URL(url).hostname.toLowerCase();
    if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".") || /\.(local|internal|localhost)$/.test(host))
      throw new AgentRunError(`the agent repository's host ${host} is an address or a local name: refused`);
    const allow = (ENV.APP_AGENT_REPO_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.some((a) => host === a || host.endsWith(`.${a}`))) throw new AgentRunError(`the agent repository's host ${host} is not in APP_AGENT_REPO_HOSTS`);
    return "https";
  }
  if (proto === "file" && o.allowFile) return "file";
  if (proto === "http" && o.allowHttp) return "http";
  throw new AgentRunError(`the agent repository must be fetched over https (${proto ?? "no protocol"}:// is refused here)`);
}

/**
 * (mold_v0-166) The current commit of `branch` of the repository at `url`, or, with no branch, its default branch and
 * that branch's commit: `git ls-remote` with the same hygiene as fetchPinned (no machine configuration, no prompt, no
 * credential, only the repository's protocol, no redirect). Throws AgentRunError when it cannot be read or has no such
 * branch.
 */
export async function headCommit(url: string, branch: string | undefined, o: FetchOptions & { home: string }): Promise<{ commit: string; branch: string }> {
  const proto = upstreamProtocol(url, o);
  if (branch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(branch) || branch.includes("..") || branch.endsWith(".lock") || branch.endsWith("/")))
    throw new AgentRunError(`branch ${branch.slice(0, 60)} is not a plain branch name`);
  mkdirSync(o.home, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.home, LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_ALLOW_PROTOCOL: proto,
  };
  const cfg = ["-c", "protocol.allow=never", "-c", `protocol.${proto}.allow=always`, "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"];
  const r = await git([...cfg, "ls-remote", ...(branch === undefined ? ["--symref", url, "HEAD"] : [url, `refs/heads/${branch}`])], { env, cwd: o.home, timeoutMs: o.timeoutMs ?? 60_000 });
  if (r.code !== 0) {
    const network = /could not resolve|timed out|failed to connect|early EOF|RPC failed/i.test(r.err);
    throw new AgentRunError(`${url} could not be read without a credential${network ? " (the network failed)" : " (a private repository? then give its commit)"}: ${r.err.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`, network ? "infrastructure" : "run");
  }
  const lines = r.out.split("\n");
  const name = branch ?? /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(lines.find((l) => l.startsWith("ref: ")) ?? "")?.[1];
  const commit = lines.map((l) => /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(l)).find((m) => m && m[2] === (branch === undefined ? "HEAD" : `refs/heads/${branch}`))?.[1];
  if (!name || !commit) throw new AgentRunError(`${url} has no ${branch === undefined ? "default branch" : `branch ${branch}`}`);
  return { commit, branch: name };
}

/**
 * Fetch `commit` of `url` into the empty directory `dest` (its tree only, no .git). Throws AgentRunError when the
 * repository is refused, the fetch fails, or what arrived is not exactly that commit.
 */
export async function fetchPinned(url: string, commit: string, dest: string, o: FetchOptions = {}): Promise<{ commit: string; files: number }> {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new AgentRunError("the pin must be a full commit id");
  const proto = upstreamProtocol(url, o);
  mkdirSync(dest, { recursive: true });
  if (readdirSync(dest).length) throw new AgentRunError("the checkout directory is not empty");
  const work = path.join(path.dirname(dest), `.git-${path.basename(dest)}`);
  const home = o.home ?? path.join(work, "home");
  mkdirSync(home, { recursive: true });
  const gitDir = path.join(work, "repo.git");
  const timeoutMs = o.timeoutMs ?? 600_000;
  // Nothing of the machine's git configuration (no ~/.gitconfig, no /etc/gitconfig: no url.insteadOf, no credential
  // helper), no prompt, only this repository's protocol, no redirect, objects checked as they arrive.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: proto, GIT_INDEX_FILE: path.join(work, "index"),
  };
  const cfg = ["-c", "protocol.allow=never", "-c", `protocol.${proto}.allow=always`, "-c", "http.followRedirects=false", "-c", "core.hooksPath=/dev/null",
    "-c", "transfer.fsckObjects=true", "-c", "fetch.recurseSubmodules=false", "-c", "core.symlinks=true", "-c", "credential.helper=", "-c", "core.fsmonitor=false",
    ...(o.credentialHelper ? ["-c", `credential.${o.credentialHelper.scope}.helper=!/bin/sh ${o.credentialHelper.script}`, "-c", "credential.useHttpPath=false"] : [])];
  if (o.credentialHelper && (!/^[A-Za-z0-9._/-]+$/.test(o.credentialHelper.script) || !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o.credentialHelper.scope)))
    throw new AgentRunError("the fetch's credential helper is not plain");
  try {
    const init = await git(["init", "--quiet", "--bare", ...(commit.length === 64 ? ["--object-format=sha256"] : []), gitDir], { env, timeoutMs });
    if (init.code !== 0) throw new AgentRunError(`git init: ${init.err.trim().slice(0, 300)}`, "infrastructure");
    // By commit id, into FETCH_HEAD only: no branch or tag is fetched or created, so no name can stand for the pin.
    const f = await git([...cfg, "--git-dir", gitDir, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--depth=1", url, commit], { env, timeoutMs });
    if (f.code !== 0) {
      const msg = f.err.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      const missing = /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|did not send all necessary objects|is not a commit|bad object|invalid/i.test(f.err);
      const network = /could not resolve|connection|timed out|unable to access|failed to connect|early EOF|RPC failed/i.test(f.err) && !/redirect/i.test(f.err);
      throw new AgentRunError(`the pinned commit ${commit.slice(0, 12)} could not be fetched from the agent repository: ${msg}`, missing || !network ? "run" : "infrastructure");
    }
    // Exactly the pin: an object of type commit whose id is the pin (git names objects by their content).
    const t = await git(["--git-dir", gitDir, "cat-file", "-t", commit], { env, timeoutMs: 30_000 });
    if (t.code !== 0 || t.out.trim() !== "commit") throw new AgentRunError(`the agent repository did not give commit ${commit.slice(0, 12)}`);
    const tree = await git(["--git-dir", gitDir, "rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`], { env, timeoutMs: 30_000 });
    if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree.out.trim())) throw new AgentRunError(`commit ${commit.slice(0, 12)} has no tree`);
    if (o.maxTreeBytes !== undefined) {
      // The tree's size from git's own objects, before a single file is written (a small pack may expand a lot).
      const bytes = await new Promise<number>((resolve, reject) => {
        const p = spawn("git", ["--git-dir", gitDir, "ls-tree", "-r", "-l", "--full-tree", tree.out.trim()], { env, stdio: ["ignore", "pipe", "ignore"] });
        let sum = 0, rest = "";
        const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
        p.stdout.setEncoding("utf8").on("data", (d: string) => {
          const lines = (rest + d).split("\n"); rest = lines.pop() ?? "";
          for (const l of lines) sum += Number(/^\S+ \S+ \S+\s+(\d+)\t/.exec(l)?.[1] ?? 0);
        });
        p.on("error", (e) => { clearTimeout(t); reject(new AgentRunError(`ls-tree: ${e.message}`, "infrastructure")); });
        p.on("close", (code) => { clearTimeout(t); if (code === 0) resolve(sum); else reject(new AgentRunError(`ls-tree exited with ${code}`, "infrastructure")); });
      });
      if (bytes > o.maxTreeBytes) throw new AgentRunError(`the commit's files are ${bytes} bytes, more than ${o.maxTreeBytes}: not checked out`);
    }
    const rt = await git(["--git-dir", gitDir, "--work-tree", dest, "read-tree", tree.out.trim()], { env, timeoutMs: 120_000 });
    if (rt.code !== 0) throw new AgentRunError(`read-tree: ${rt.err.trim().slice(0, 300)}`, "infrastructure");
    const co = await git([...cfg, "--git-dir", gitDir, "--work-tree", dest, "checkout-index", "--all", "--force"], { env, cwd: dest, timeoutMs: 600_000 });
    if (co.code !== 0) throw new AgentRunError(`checkout: ${co.err.trim().slice(0, 300)}`, "infrastructure");
    let files = 0;
    const count = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else files++; } };
    count(dest);
    return { commit, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- paths in the checkout ----------

const MAX_FILES = () => Number(ENV.APP_WORKSPACE_MAX_FILES ?? 20_000);
const MAX_BYTES = () => Number(ENV.APP_WORKSPACE_MAX_BYTES ?? 256 * 1024 * 1024);
const MAX_DEPTH = 64, MAX_ENTRIES = 500_000;
/** Every entry under `root` (lstat, never following a link), breadth first, at most 64 deep and 500 000 entries. */
const walk = (root: string, visit: (rel: string, st: import("node:fs").Stats) => "skip" | void) => {
  const queue: [string, number][] = [["", 0]];
  let seen = 0;
  while (queue.length) {
    const [rel, depth] = queue.shift()!;
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      if (++seen > MAX_ENTRIES) throw new AgentRunError(`more than ${MAX_ENTRIES} entries under ${path.basename(root)}`);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path.join(root, r));
      if (visit(r, st) === "skip") continue;
      if (st.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) throw new AgentRunError(`${r}: directories nested deeper than ${MAX_DEPTH}`);
        queue.push([r, depth + 1]);
      }
    }
  }
};

/** Remove every path of `root` matching one of `globs` (a matching directory goes whole). Links are removed, never followed. */
export function stripPaths(root: string, globs: string[]): string[] {
  if (!globs.length) return [];
  const res = globs.map(globRegex);
  const gone: string[] = [];
  walk(root, (rel) => {
    if (!res.some((r) => r.test(rel))) return;
    rmSync(path.join(root, rel), { recursive: true, force: true });
    gone.push(rel);
    return "skip";
  });
  return gone;
}

/** Is `rel` one of the write-back paths or inside one? */
export const underWriteBack = (rel: string, writeBack: string[]) => writeBack.some((w) => rel === w || rel.startsWith(`${w}/`));

/**
 * The parent directories of `rel` inside `root`, made as real directories: a link or a file standing where a directory
 * should be is removed first (it is the checkout's own copy), so a write never goes through a link.
 */
function realParents(root: string, rel: string) {
  const parts = rel.split("/").slice(0, -1);
  let cur = root;
  for (const p of parts) {
    cur = path.join(cur, p);
    let st;
    try { st = lstatSync(cur); } catch { st = null; }
    if (st && !st.isDirectory()) { rmSync(cur, { force: true }); st = null; }
    if (!st) mkdirSync(cur);
  }
}

/** Lay the snapshot's files (unpacked in `snap`) over the checkout: those under the write-back paths only. */
export function restoreInto(snap: string, checkout: string, writeBack: string[]): { restored: number; kept_aside: number } {
  let restored = 0, aside = 0;
  walk(snap, (rel, st) => {
    if (st.isDirectory()) return;
    if (!st.isFile()) return; // an unpacked snapshot holds plain files only
    if (!underWriteBack(rel, writeBack)) { aside++; return; }
    realParents(checkout, rel);
    const target = path.join(checkout, rel);
    try { const t = lstatSync(target); if (t.isDirectory()) rmSync(target, { recursive: true, force: true }); else unlinkSync(target); } catch { /* absent */ }
    copyFileSync(path.join(snap, rel), target, constants.COPYFILE_EXCL);
    restored++;
  });
  return { restored, kept_aside: aside };
}

/**
 * The next snapshot's directory `stage`: the checkout's write-back paths after the run (regular files only, each opened
 * without following a link and checked to be a plain file with one name), and the snapshot's files outside them.
 * Returns what was left out and why.
 *
 * mold_v0-182: `ignore` (writeBackIgnore) leaves out what is not the workspace's own records: a repository the run
 * cloned under a write-back path (Maxwell's applications/<app>/repos/<repo>/, with its .git), decrypted credentials,
 * anything the agent repository's .gitignore or the kind's write_back_ignore names. Those paths never leave the sandbox.
 */
export function collectWriteBack(checkout: string, snap: string | null, stage: string, writeBack: string[], ignore?: WriteBackIgnore | null):
  { files: number; skipped: { path: string; why: string }[]; ignored: { paths: number; sample: string[] } } {
  mkdirSync(stage, { recursive: true });
  const skipped: { path: string; why: string }[] = [];
  const ignored = { paths: 0, sample: [] as string[] };
  const leaveOut = (rel: string) => { ignored.paths++; if (ignored.sample.length < 20) ignored.sample.push(rel); };
  let files = 0, bytes = 0;
  const count = (size: number) => {
    files++; bytes += size;
    // The store's own limits (src/workspace-bundle.ts), checked before anything is read: a run cannot fill the runner's disk or memory.
    if (files > MAX_FILES()) throw new AgentRunError(`the workspace holds more than ${MAX_FILES()} files: it is not written back`);
    if (bytes > MAX_BYTES()) throw new AgentRunError(`the workspace holds more than ${MAX_BYTES()} bytes: it is not written back`);
  };
  const copyOut = (rel: string, from: string) => {
    let fd: number;
    try { fd = openSync(path.join(from, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { skipped.push({ path: rel, why: (e as NodeJS.ErrnoException).code === "ELOOP" ? "a symbolic link" : "unreadable" }); return; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) { skipped.push({ path: rel, why: "not a regular file" }); return; }
      // A second name of a file elsewhere (a hard link) is never copied: it could be a file the run does not own.
      if (st.nlink > 1) { skipped.push({ path: rel, why: "a hard link" }); return; }
      count(st.size);
      realParents(stage, rel);
      const body = readFileSync(fd);
      if (body.length !== st.size) throw new AgentRunError(`${rel} changed while it was read`);
      writeFileSync(path.join(stage, rel), body, { flag: "wx" });
    } finally { closeSync(fd); }
  };
  for (const w of writeBack) {
    // Every directory on the way to the write-back path must be a real one: a link there would lead out of the checkout.
    const parts = w.split("/");
    let ok = true, cur = checkout;
    for (const p of parts.slice(0, -1)) {
      cur = path.join(cur, p);
      let st; try { st = lstatSync(cur); } catch { ok = false; break; }
      if (!st.isDirectory()) { ok = false; if (st.isSymbolicLink()) skipped.push({ path: w, why: `${path.relative(checkout, cur)} is a symbolic link` }); break; }
    }
    if (!ok) continue;
    let st; try { st = lstatSync(path.join(checkout, w)); } catch { continue; }
    if (st.isSymbolicLink()) { skipped.push({ path: w, why: "a symbolic link" }); continue; }
    const out = ignore ? ignore.under(w, st.isDirectory()) : null;
    if (out && out(w, st.isDirectory())) { leaveOut(w); continue; }
    if (st.isFile()) { copyOut(w, checkout); continue; }
    if (!st.isDirectory()) { skipped.push({ path: w, why: "not a regular file" }); continue; }
    walk(path.join(checkout, w), (rel, s) => {
      const full = `${w}/${rel}`;
      if (out && !s.isSymbolicLink() && out(full, s.isDirectory())) { leaveOut(full); return "skip"; }
      if (s.isSymbolicLink()) { skipped.push({ path: full, why: "a symbolic link" }); return "skip"; }
      if (s.isDirectory()) return;
      copyOut(full, checkout);
    });
  }
  // What the snapshot held outside the write-back paths (a path the configuration no longer writes back) is kept.
  if (snap) walk(snap, (rel, s) => { if (s.isFile() && !underWriteBack(rel, writeBack)) { count(s.size); realParents(stage, rel); copyFileSync(path.join(snap, rel), path.join(stage, rel), constants.COPYFILE_EXCL); } });
  return { files, skipped: skipped.slice(0, 200), ignored };
}

/** What a write-back leaves out (mold_v0-182): `under(w)` is the test for the paths under the write-back path w, or null. */
export interface WriteBackIgnore { rules: number; under(w: string, isDir: boolean): ((rel: string, isDir: boolean) => boolean) | null }

/**
 * The agent repository's own ignore rules, read from the pinned tree (every .gitignore in it, as committed at the pin,
 * read before anything of the run's runs: the run cannot change them), and the kind's write_back_ignore patterns (git's
 * syntax, from the checkout's root).
 *
 * The kind's own patterns apply everywhere. The repository's apply below a write-back path, never to the path itself:
 * a kind that writes back a path the repository ignores (a data directory kept out of git upstream, say) declared
 * that path its workspace, so the repository's rules are not applied inside it at all.
 */
export function writeBackIgnore(pinned: string | null, kindPatterns: string[], useGitignore = true): WriteBackIgnore {
  const git: IgnoreRule[] = [];
  if (pinned && useGitignore) {
    const files: string[] = [];
    walk(pinned, (rel, st) => {
      if (st.isSymbolicLink()) return "skip";
      if (st.isFile() && path.basename(rel) === ".gitignore" && st.size <= 256 * 1024) files.push(rel);
    });
    // Shallower files first: a deeper file's rules come later, so they win (git's precedence).
    files.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
    for (const f of files) {
      let text = "";
      try {
        const fd = openSync(path.join(pinned, f), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { if (fstatSync(fd).isFile()) text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
      } catch { continue; }
      const dir = path.posix.dirname(f);
      git.push(...parseIgnore(text, dir === "." ? "" : dir, f));
    }
  }
  const own = parseIgnore(kindPatterns.join("\n"), "", "write_back_ignore");
  const repo = ignoreMatcher(git), kind = ignoreMatcher(own);
  return {
    rules: git.length + own.length,
    under: (w, isDir) => {
      if (!git.length && !own.length) return null;
      // The write-back path itself (or a directory on its way) ignored upstream: the kind claims it, the repository's rules stay out.
      const claimed = git.length > 0 && repo(w, isDir);
      return (rel, d) => kind(rel, d) || (!claimed && rel !== w && repo(rel, d));
    },
  };
}

/** Files of the checkout matching the `record` globs (regular files only, at most 50, never through a link). */
export function recordedFiles(checkout: string, globs: string[]): { path: string; size: number; sha256: string; json?: unknown }[] {
  if (!globs.length) return [];
  const res = globs.map(globRegex);
  const out: { path: string; size: number; sha256: string; json?: unknown }[] = [];
  walk(checkout, (rel, st) => {
    if (st.isSymbolicLink()) return "skip";
    if (!st.isFile() || out.length >= 50 || !res.some((r) => r.test(rel))) return;
    let fd: number;
    try { fd = openSync(path.join(checkout, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return; }
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink > 1 || s.size > 8 * 1024 * 1024) return;
      const b = readFileSync(fd);
      const item: { path: string; size: number; sha256: string; json?: unknown } = { path: rel, size: b.length, sha256: createHash("sha256").update(b).digest("hex") };
      if (b.length <= 12 * 1024 && /\.json$/i.test(rel)) { try { item.json = JSON.parse(b.toString("utf8")); } catch { /* not JSON */ } }
      out.push(item);
    } finally { closeSync(fd); }
  });
  return out;
}

// ---------- the command's arguments ----------

const DEFAULT_ARG = /^[A-Za-z0-9_][A-Za-z0-9._:@/+=-]{0,199}$/;
const dig = (o: unknown, keys: string[]) => keys.reduce<unknown>((v, k) => (v && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined), o);

/** Each declared argument's value for this run, checked; throws AgentRunError naming the first that is missing or refused. */
export function argValues(cfg: AgentWorkspaceConfig, run: { id: string; attempt: number; kind: string; scope: unknown; targets: unknown }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, a] of Object.entries(cfg.args)) {
    const [root, ...rest] = a.from.split(".");
    let v: unknown = root === "run" ? (run as Record<string, unknown>)[rest[0]!] : dig(root === "scope" ? run.scope : run.targets, rest);
    if (v === undefined || v === null || v === "") v = a.default;
    if (v === undefined) throw new AgentRunError(`argument ${name}: the run gives no ${a.from}`);
    if (typeof v === "number" && Number.isFinite(v)) v = String(v);
    if (typeof v === "boolean") v = String(v);
    if (typeof v !== "string") throw new AgentRunError(`argument ${name}: ${a.from} is not a single value`);
    // Never an option of the command ("-..."), whatever the pattern allows: an argument is data.
    if (v.startsWith("-")) throw new AgentRunError(`argument ${name}: a value may not start with "-"`);
    // Nor a way out of a directory, whatever the pattern allows.
    if (v.split(/[\\/]/).includes("..")) throw new AgentRunError(`argument ${name}: a value may not hold a ".." path part`);
    const re = a.pattern ? new RegExp(`^(?:${a.pattern})$`) : DEFAULT_ARG;
    if (!re.test(v) || /[\u0000-\u001f]/.test(v)) throw new AgentRunError(`argument ${name}: the value does not match its pattern`);
    out[name] = v;
  }
  return out;
}

/** Replace each {placeholder} in `s` from `values` (every placeholder was checked when the kind was declared). */
export function expand(s: string, values: Record<string, string>): string {
  for (const p of placeholders(s)) if (!(p in values)) throw new AgentRunError(`{${p}} has no value for this run`);
  return s.replace(/\{([^{}]*)\}/g, (_m, p: string) => values[p]!);
}
