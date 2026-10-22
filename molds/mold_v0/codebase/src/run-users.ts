/**
 * A run user per run (mold_v0-078). Every run's programs run as a uid of their own, leased from a reserved range for
 * that run alone and released when it ends, so the end-of-run sweep (every process of the run's user killed, its files
 * in the shared temporary directories removed) only ever touches that run. Before, every run of a host shared one uid
 * and the sweep was host-wide: a run that ended killed the steps of another still running (seen as exit 128).
 *
 *   range      OCTILLION_RUN_UIDS ("first-last", default 61000-64999): uids no account of the machine has (a uid
 *              /etc/passwd names is skipped, unless it is one this module registered, octirun-<uid>), never root, never
 *              nobody (65534) or 65535. The gid of a run user is its uid. No supplementary groups (node drops them).
 *   lease      a file per uid in a directory only root can enter (OCTILLION_RUN_UID_DIR, default /run/octi-run-uids,
 *              cleared at boot with the processes it guards), naming the process that holds it (pid and start time,
 *              so a reused pid is not mistaken for it), a random token and the run. Taken and given back under a
 *              host-wide mutex (an abstract unix socket: released by the kernel when its holder dies, so a crashed
 *              runner never wedges the others), so two runners never take one uid.
 *   order      round robin over the range: a released uid is taken again only after every other free one was, which
 *              keeps a uid's next run far from its last.
 *   reclaim    a lease whose holder is gone (a runner that died) is taken over only after every process of that uid is
 *              killed and its files swept. A uid with live processes and no lease is never ours: skipped, never killed.
 *   release    only once no process of the uid is left (checked in /proc after kill -KILL -1 as that user) and its files
 *              are swept; a uid whose processes will not die stays leased to its holder ("quarantined") and is not
 *              handed out again while that holder lives (and is reclaimed, killed and swept, once it has gone).
 *
 * A fixed uid (HarnessOptions.runAs, the offline tests' and older setups' choice) is leased the same way: two runs on
 * one host never share it at once (the second is refused, an infrastructure failure the engine retries).
 *
 * In a run sandbox (boat, docker: one run per sandbox) the runner leases from the same range inside the sandbox; the
 * lockdown firewall is set for that uid (orchestrator/core/egress.ts setupScript `uid`).
 *
 * Only node's own modules: the run sandbox's runner imports this (orchestrator/deploy/boat-lib.ts runnerCodeFiles).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_RUN_UIDS = "61000-64999";
/** The prefix of the accounts this module may register for a run user inside a sandbox (octirun-<uid>). */
export const RUN_USER_PREFIX = "octirun-";

export class RunUserError extends Error {
  /** "config": a setting is wrong (nothing will work); "busy": no uid free now (retry later). */
  constructor(message: string, readonly kind: "config" | "busy" = "config") { super(message); }
}

export interface UidRange { first: number; last: number }
/** The reserved range from OCTILLION_RUN_UIDS ("first-last"). Throws on a range that holds root, nobody or the like. */
export function runUidRange(spec = process.env.OCTILLION_RUN_UIDS || DEFAULT_RUN_UIDS): UidRange {
  const m = /^\s*(\d{1,10})\s*-\s*(\d{1,10})\s*$/.exec(spec);
  if (!m) throw new RunUserError(`OCTILLION_RUN_UIDS: "first-last" (e.g. ${DEFAULT_RUN_UIDS}), got ${JSON.stringify(spec.slice(0, 40))}`);
  const first = Number(m[1]), last = Number(m[2]);
  if (!(first >= 1000 && last >= first && last <= 2 ** 31 - 2)) throw new RunUserError("OCTILLION_RUN_UIDS: 1000 <= first <= last < 2^31-1");
  if (last - first > 1_000_000) throw new RunUserError("OCTILLION_RUN_UIDS: at most 1 000 001 uids");
  if (first <= 65534 && last >= 65534) throw new RunUserError("OCTILLION_RUN_UIDS: the range holds 65534 (nobody) or 65535: choose one that does not");
  return { first, last };
}

/** The lease directory: OCTILLION_RUN_UID_DIR, else /run/octi-run-uids (root), else one under the temp directory. */
export const runUidDir = () => process.env.OCTILLION_RUN_UID_DIR
  || (process.getuid?.() === 0 && existsSync("/run") ? "/run/octi-run-uids" : path.join(tmpdir(), `octi-run-uids-${process.getuid?.() ?? 0}`));

// ---------- processes and files of a uid ----------

/** The processes of `uid` still alive (from /proc; zombies count as gone). */
export function processesOf(uid: number): number[] {
  const out: number[] = [];
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    try {
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      // Real, effective, saved and filesystem uid: a process that holds the uid in any of them is the run's.
      const u = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(st), state = /^State:\s+(\S)/m.exec(st)?.[1];
      if (u && u.slice(1).some((x) => Number(x) === uid) && state !== "Z" && state !== "X") out.push(Number(pid));
    } catch { /* gone */ }
  }
  return out;
}

/** Every process of the user, gone (kill -KILL -1 as that user signals all of its processes but itself). */
export function killUser(as: { uid: number; gid: number }) {
  spawnSync("/bin/kill", ["-KILL", "-1"], { uid: as.uid, gid: as.gid, stdio: "ignore", timeout: 10_000 });
}

/** Killed again a few times until /proc shows none; false when some are still alive. */
export function killUntilGone(as: { uid: number; gid: number }, tries = 5): boolean {
  for (let i = 0; i < tries; i++) {
    killUser(as);
    if (!processesOf(as.uid).length) return true;
    spawnSync("/bin/sleep", ["0.2"]);
  }
  return !processesOf(as.uid).length;
}

/** The shared directories a run's user can write into without being given one: swept of its files. */
export const SWEPT_DIRS = ["/tmp", "/var/tmp", "/dev/shm", "/run/lock", "/dev/mqueue"];

/**
 * Every file the run's user left in the shared temporary directories, removed, and its System V IPC objects (shared
 * memory, message queues, semaphores): a copy of a credential (or anything else) left there is never seen by a later
 * run that is given the same uid.
 */
export function sweepUserFiles(uid: number, roots = SWEPT_DIRS) {
  const sweep = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.uid === uid) { rmSync(p, { recursive: true, force: true }); continue; }
      // Another owner's directory the run's user could still write into (world-writable, like /tmp itself).
      if (st.isDirectory() && (st.mode & 0o002) && depth < 4) sweep(p, depth + 1);
    }
  };
  for (const r of roots) sweep(r, 0);
  for (const [file, flag] of [["shm", "-m"], ["msg", "-q"], ["sem", "-s"]] as const) {
    let text = "";
    try { text = readFileSync(`/proc/sysvipc/${file}`, "utf8"); } catch { continue; }
    const [head, ...rows] = text.trim().split("\n");
    const cols = (head ?? "").trim().split(/\s+/);
    const idAt = cols.findIndex((c) => c === "shmid" || c === "msqid" || c === "semid"), uidAt = cols.indexOf("uid"), cuidAt = cols.indexOf("cuid");
    if (idAt < 0 || uidAt < 0) continue;
    for (const r of rows) {
      const v = r.trim().split(/\s+/);
      if (Number(v[uidAt]) === uid || (cuidAt >= 0 && Number(v[cuidAt]) === uid)) spawnSync("ipcrm", [flag, v[idAt]!], { stdio: "ignore", timeout: 5000 });
    }
  }
}

// ---------- who holds a lease ----------

const bootId = (() => { let b: string | null = null; return () => (b ??= (() => { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "-"; } })()); })();
/** A process's start time (clock ticks since boot, /proc/<pid>/stat field 22): with the pid, it names one process. */
function startOf(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
const self = (() => { let s: { pid: number; start: string; boot: string } | null = null; return () => (s ??= { pid: process.pid, start: startOf(process.pid) ?? "?", boot: bootId() }); })();

interface LeaseFile { pid?: number; start?: string; boot?: string; token?: string; run?: string; at?: string; quarantined?: boolean; released_at?: string; last_run?: string }
const holderAlive = (l: LeaseFile) => typeof l.pid === "number" && l.boot === bootId() && startOf(l.pid) === l.start;

/** The uids /etc/passwd names, but the run users this module registered (octirun-<uid>). */
function accountUids(): Set<number> {
  const out = new Set<number>();
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , uid] = line.split(":");
      if (name && uid && !(name === `${RUN_USER_PREFIX}${uid}`)) out.add(Number(uid));
    }
  } catch { /* none readable */ }
  return out;
}

// ---------- the host-wide mutex ----------

/** Held while leases are read and written: an abstract unix socket, which only one process can bind and the kernel frees. */
async function withMutex<T>(dir: string, fn: () => T | Promise<T>, waitMs = 60_000): Promise<T> {
  const name = `\0octi-run-uids:${createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 24)}`;
  const t0 = Date.now();
  let srv: net.Server | null = null;
  for (;;) {
    const s = net.createServer();
    const got = await new Promise<boolean>((resolve, reject) => {
      s.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
      s.listen(name, () => resolve(true));
    });
    if (got) { srv = s; break; }
    if (Date.now() - t0 > waitMs) throw new RunUserError("the run users' lock is held too long by another runner", "busy");
    await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
  }
  srv.unref();
  try { return await fn(); }
  finally { await new Promise<void>((r) => srv!.close(() => r())); }
}

/** The lease directory: made root's 0700, never through a link, refused when someone else owns it. */
function leaseDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== (process.getuid?.() ?? 0)) throw new RunUserError(`the run users' lease directory ${dir} is not a directory of this runner's own`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}
const readLease = (file: string): LeaseFile | null => {
  try { const st = lstatSync(file); if (!st.isFile()) return {}; return JSON.parse(readFileSync(file, "utf8")) as LeaseFile; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : {}; }
};
const writeAtomic = (file: string, body: unknown) => {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
};

// ---------- leasing ----------

export interface RunUser {
  uid: number; gid: number;
  /** The run it was leased for (for the lease file only). */
  run: string;
  /** Kill what is left of the user, sweep its files and give the uid back; false when it is kept ("quarantined"). */
  release(): Promise<boolean>;
}

export interface LeaseOptions {
  /** The reserved range (default: runUidRange()). */
  range?: UidRange;
  /** A fixed uid instead of the range (runAs): leased the same way, never shared by two runs at once. */
  fixed?: { uid: number; gid: number };
  /** The lease directory (default runUidDir()). */
  dir?: string;
  /** Called with what happened (a lease reclaimed from a runner that died, a uid skipped): for the run's events. */
  note?: (what: string, data: Record<string, unknown>) => void;
}

/**
 * Lease a run user for `run`: a uid no other live run holds, with no process left of an earlier holder and its files
 * swept. Throws RunUserError ("busy" when every uid is taken: the run is retried; "config" for a wrong setting).
 */
export async function leaseRunUser(run: string, o: LeaseOptions = {}): Promise<RunUser> {
  if (process.getuid?.() !== 0) throw new RunUserError("a run user needs a runner started as root (to switch to it)");
  const dir = leaseDir(o.dir ?? runUidDir());
  const me = self(), token = randomBytes(12).toString("hex");
  const take = (uid: number, gid: number) => writeAtomic(path.join(dir, String(uid)), { ...me, token, run: run.slice(0, 100), at: new Date().toISOString() } satisfies LeaseFile);
  const reclaim = (uid: number, gid: number, l: LeaseFile | null): boolean => {
    // An earlier holder that is gone (a runner that died): what it left of the user goes before anyone gets it again.
    if (!killUntilGone({ uid, gid })) { o.note?.("run_user_skipped", { uid, reason: "processes of an earlier run would not die" }); return false; }
    sweepUserFiles(uid);
    if (l?.pid) o.note?.("run_user_reclaimed", { uid, from_run: l.run ?? null });
    return true;
  };
  const leased = await withMutex(dir, () => {
    if (o.fixed) {
      const { uid, gid } = o.fixed;
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) throw new RunUserError("runAs: a uid and gid other than root");
      const l = readLease(path.join(dir, String(uid)));
      if (l?.pid && holderAlive(l)) throw new RunUserError(`the run user ${uid} is in use by another run on this host (${l.run ?? "?"}): runs never share a user`, "busy");
      // A fixed user is the operator's (or a test's) own choice: whatever runs as it is ended, as before.
      if (!reclaim(uid, gid, l)) throw new RunUserError(`processes of the run user ${uid} are still running`, "busy");
      take(uid, gid);
      return { uid, gid };
    }
    const range = o.range ?? runUidRange();
    const count = range.last - range.first + 1;
    const cursorFile = path.join(dir, "cursor");
    let cursor = 0;
    try { cursor = Math.abs(Number.parseInt(readFileSync(cursorFile, "utf8"), 10)) % count || 0; } catch { cursor = randomBytes(4).readUInt32BE() % count; }
    const accounts = accountUids();
    for (let i = 0; i < count; i++) {
      const uid = range.first + ((cursor + i) % count), gid = uid;
      if (accounts.has(uid)) continue;
      const l = readLease(path.join(dir, String(uid)));
      if (l?.pid && holderAlive(l)) continue; // another live run's (or quarantined by a live runner)
      const procs = processesOf(uid);
      // Processes of a uid this module never leased are not ours: never killed, never shared.
      if (procs.length && !l) { o.note?.("run_user_skipped", { uid, reason: "processes this runner did not start" }); continue; }
      if ((procs.length || l?.pid) && !reclaim(uid, gid, l)) continue;
      take(uid, gid);
      writeAtomic(cursorFile, (cursor + i + 1) % count);
      return { uid, gid };
    }
    throw new RunUserError(`every run user of ${range.first}-${range.last} is in use on this host: the run waits for one`, "busy");
  });
  let done = false;
  return {
    ...leased, run,
    async release() {
      if (done) return true;
      done = true;
      const gone = killUntilGone(leased);
      sweepUserFiles(leased.uid);
      return withMutex(dir, () => {
        const file = path.join(dir, String(leased.uid));
        const l = readLease(file);
        if (l?.token !== token) return false; // not ours any more (never expected): left as it is
        if (!gone) { writeAtomic(file, { ...l, quarantined: true }); o.note?.("run_user_quarantined", { uid: leased.uid }); return false; }
        writeAtomic(file, { released_at: new Date().toISOString(), last_run: l.run } satisfies LeaseFile);
        return true;
      });
    },
  };
}

/**
 * A run sandbox's own account for its run user (boat, docker: the sandbox lives one run): octirun-<uid> in its
 * /etc/passwd and /etc/group, so a tool that looks its user up finds one. Best effort; never on a shared host.
 */
export function registerSandboxRunUser(uid: number): boolean {
  const name = `${RUN_USER_PREFIX}${uid}`;
  if (spawnSync("id", ["-u", name], { stdio: "ignore" }).status === 0) return true;
  spawnSync("groupadd", ["-g", String(uid), name], { stdio: "ignore", timeout: 10_000 });
  return spawnSync("useradd", ["-M", "-N", "-u", String(uid), "-g", String(uid), "-d", "/nonexistent", "-s", "/usr/sbin/nologin", name], { stdio: "ignore", timeout: 10_000 }).status === 0;
}
