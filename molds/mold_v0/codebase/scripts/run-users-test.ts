// A run user per run (mold_v0-078; src/run-users.ts, src/run-harness.ts), offline, as root: an embedded database, the
// HTTP API, and two runners on this one host (this process, and a second process over HTTP).
//   npm run test:run-users
//
//  1. The range: OCTILLION_RUN_UIDS is checked (never root, nobody or 65535).
//  2. Leases: two runs get two uids; a uid another live run holds is never handed out; a released uid comes back only
//     after the others (round robin); a lease whose runner died is taken over only after its processes are killed and
//     its files swept; a uid with processes this runner never leased is skipped, its processes left alone; a fixed uid
//     in use is refused, never shared; eight runner processes leasing at once never get the same uid.
//  3. The bug (seen: a concurrent test run killed another's steps, exit 128): two runs at once on this host, one in each
//     runner; one ends early and its end-of-run sweep runs (every process of its user killed, its /tmp files removed)
//     while the other keeps running: the other's processes and files are untouched and it finishes. What the early one
//     left behind is gone. Both with the harness's defaults (no runAs), with OCTILLION_RUN_UID set as a runner before 078
//     was configured (one uid for every run): it is no longer read.
//  4. The same with a fixed uid (runAs) for both: the second run is refused (an infrastructure failure, retried), never
//     run beside the first as the same user.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "scripts", "fixtures", "run-users");
if (process.getuid?.() !== 0) { console.log("SKIP: a run user per run needs root (run this test as root)"); process.exit(0); }
// One uid for every run, as runners before mold_v0-078 were configured: the harness no longer reads it.
process.env.OCTILLION_RUN_UID = "64321"; process.env.OCTILLION_RUN_GID = "64321";
const alive = (pid: number) => { try { process.kill(pid, 0); return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")); } catch { return false; } };
const asUser = (uid: number, cmd: string, args: string[]) => {
  const c = spawn(cmd, args, { uid, gid: uid, detached: true, stdio: "ignore", cwd: "/" });
  c.unref();
  return c.pid!;
};

try {
  const ru = await import("../src/run-users.js");

  // ---------- 1. the range ----------
  {
    assert.deepEqual(ru.runUidRange("61000-64999"), { first: 61000, last: 64999 });
    for (const bad of ["0-10", "999-2000", "60000-70000", "65534-65540", "5-3", "x", "61000"]) assert.throws(() => ru.runUidRange(bad), ru.RunUserError, bad);
    console.log("✓ the range: first-last, never root, a system uid, nobody (65534) or 65535");
  }

  // ---------- 2. leases ----------
  {
    const dir = path.join(TMP, "leases");
    const range = { first: 66100, last: 66103 };
    const notes: { type: string; data: Record<string, unknown> }[] = [];
    const note = (type: string, data: Record<string, unknown>) => notes.push({ type, data });
    const a = await ru.leaseRunUser("run_a", { range, dir, note }), b = await ru.leaseRunUser("run_b", { range, dir, note });
    assert.notEqual(a.uid, b.uid, "two runs, two uids");
    assert.equal(a.gid, a.uid);
    for (const u of [a, b]) assert.ok(u.uid >= range.first && u.uid <= range.last);
    assert.equal(JSON.parse(readFileSync(path.join(dir, String(a.uid)), "utf8")).run, "run_a", "the lease names its run");
    // Held: never handed out again, whatever the cursor says.
    writeFileSync(path.join(dir, "cursor"), String(a.uid - range.first));
    const c = await ru.leaseRunUser("run_c", { range, dir, note });
    assert.ok(![a.uid, b.uid].includes(c.uid), "a uid a live run holds is skipped");
    // Round robin: a released uid comes back only after the others.
    assert.equal(await a.release(), true);
    const d = await ru.leaseRunUser("run_d", { range, dir, note });
    assert.ok(![a.uid, b.uid, c.uid].includes(d.uid), "the free uid that was not used last");
    await assert.rejects(ru.leaseRunUser("run_e", { range: { first: b.uid, last: b.uid }, dir }), (e: Error) => e instanceof ru.RunUserError && e.kind === "busy", "every uid in use: busy (the run is retried)");
    await assert.rejects(ru.leaseRunUser("run_f", { fixed: { uid: b.uid, gid: b.uid }, dir }), /in use by another run on this host/, "a fixed uid in use is refused, never shared");
    for (const u of [b, c, d]) await u.release();

    // A lease whose runner died: its leftovers (a process, a file in /tmp) are gone before the uid is handed out again.
    const stale = range.first + 1;
    const ghost = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(path.join(dir, String(stale)), JSON.stringify({ pid: Number(ghost), start: "1", boot: "x", token: "t", run: "run_dead" }));
    const left = asUser(stale, "sleep", ["120"]);
    const leftFile = `/tmp/octi-run-users-stale-${STAMP}`;
    writeFileSync(leftFile, "x"); spawnSync("chown", [`${stale}:${stale}`, leftFile]);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(left), "(the dead run's process is there)");
    writeFileSync(path.join(dir, "cursor"), String(stale - range.first));
    notes.length = 0;
    const s = await ru.leaseRunUser("run_s", { range, dir, note });
    assert.equal(s.uid, stale, "the dead runner's uid is taken over");
    assert.ok(!alive(left) && !existsSync(leftFile), "after its process was killed and its file removed");
    assert.ok(notes.some((n) => n.type === "run_user_reclaimed" && n.data.uid === stale && !("from_run" in n.data)), "(review) which run held it is never in this run's events");
    await s.release();

    // A uid with a process this runner never leased (no lease file): skipped, its process left alone.
    const foreign = range.first + 3;
    const fpid = asUser(foreign, "sleep", ["120"]);
    await new Promise((r) => setTimeout(r, 200));
    const dir2 = path.join(TMP, "leases2");
    mkdirSync(dir2, { recursive: true }); chmodSync(dir2, 0o700);
    writeFileSync(path.join(dir2, "cursor"), String(foreign - range.first));
    notes.length = 0;
    const f = await ru.leaseRunUser("run_g", { range, dir: dir2, note });
    assert.notEqual(f.uid, foreign, "a uid whose processes are not a run's is not handed out");
    assert.ok(alive(fpid), "and its process is not killed");
    assert.ok(notes.some((n) => n.type === "run_user_skipped" && n.data.uid === foreign));
    await f.release();
    process.kill(fpid, "SIGKILL");

    // (review) The lock is a file in the root-only lease directory: a run's user can neither take nor block it.
    const squat = spawnSync("flock", ["-n", path.join(dir, "mutex"), "true"], { uid: range.first + 2, gid: range.first + 2, encoding: "utf8" });
    assert.notEqual(squat.status, 0, "a run's user cannot open the lock");
    // Eight runner processes leasing from one range at once: eight different uids.
    const many = await Promise.all(Array.from({ length: 8 }, () => new Promise<number>((resolve, reject) => {
      const c = spawn(process.execPath, ["--import", "tsx", path.join(FIX, "lease.ts")], { cwd: ROOT, env: { ...process.env, RU_DIR: path.join(TMP, "leases3"), RU_RANGE: "66200-66207" }, stdio: ["ignore", "pipe", "inherit"] });
      let out = ""; c.stdout.on("data", (x) => (out += x));
      c.on("exit", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`lease child exited ${code}: ${out}`))));
    })));
    assert.equal(new Set(many).size, 8, `eight runners, eight uids (${many.join(", ")})`);
    console.log("✓ leases: one uid per run; a held uid is never handed out; round robin; a dead runner's uid only after its leftovers are gone; a uid with foreign processes is skipped and left alone; a fixed uid in use is refused; eight runner processes at once, eight uids");
  }

  // ---------- 3 and 4. two runs at once on one host ----------
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const harness = await import("../src/run-harness.js");
  const runs = await import("../src/runs.js");
  const { createOrg } = await import("../src/auth.js");
  const A = (await createOrg(`Users A ${STAMP}`)).org, B = (await createOrg(`Users B ${STAMP}`)).org;
  const fixture = definePack({ id: "fixture_users", jobKinds: [
    { name: "long", runner: "workspace-harness", entry: "long.mjs", lease_seconds: 15, max_attempts: 1 },
    { name: "short", runner: "workspace-harness", entry: "short.mjs", lease_seconds: 15, max_attempts: 1 },
  ] as never });
  setPacksForTest([{ manifest: { id: "fixture_users", name: "Fixture users", version: "1", entry: "index.ts", migrations: null, words: {}, dir: FIX }, definition: fixture }]);
  const http = await startHttp();
  const events = async (id: string, type: string) => (await db.query<{ data: any }>("SELECT data FROM run_events WHERE run_id = $1 AND type = $2 ORDER BY id", [id, type])).map((e) => e.data);
  const local = await harness.localRunnerClient("ru-first");
  /** The second runner: a process of its own on this host, over HTTP. */
  const second = (extra: Record<string, string> = {}) => new Promise<{ status: string | null; error: string | null }>((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", "tsx", path.join(FIX, "runner.ts")], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, RU_BASE: http.base, RU_KINDS: "fixture_users/long", RU_PACK_DIR: FIX, ...extra } });
    let out = ""; c.stdout.on("data", (x) => (out += x));
    c.on("exit", (code) => { try { const j = JSON.parse(out.trim().split("\n").pop()!); return j.claimed ? resolve(j) : reject(new Error(`the second runner claimed nothing (${code})`)); } catch { reject(new Error(`second runner: ${code} ${out}`)); } });
  });
  const until = async (f: () => Promise<boolean>, what: string) => { for (let i = 0; i < 300; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`waited for ${what}`); };

  try {
    {
      const long = await runs.startRun(B.orgId, "fixture_users", "long", { scope: { seconds: 8 } });
      const short = await runs.startRun(A.orgId, "fixture_users", "short");
      const other = second();
      await until(async () => (await events(long.id, "long_started")).length > 0, "the long run to start");
      const c = await local.claim(["fixture_users/short"]);
      assert.equal(c?.run.id, short.id);
      const v = await harness.runWorkspaceHarness(local, c!, { egress: "off", packDir: () => FIX });
      assert.equal(v?.status, "succeeded", JSON.stringify(v));
      const [sd] = await events(short.id, "short_done");
      // The early run's end: what it left behind is gone.
      assert.ok(!alive(sd.child), "the process the early run left behind is killed at its end");
      assert.ok(!existsSync(`/tmp/octi-run-users-${short.id}`), "and its file in /tmp is removed");
      const [ls] = await events(long.id, "long_started");
      assert.ok(alive(ls.child), "the other run's process is untouched by that end");
      assert.ok(existsSync(`/tmp/octi-run-users-${long.id}`), "and so is its file in /tmp");
      const r = await other;
      assert.equal(r.status, "succeeded", `the other run keeps running and finishes: ${JSON.stringify(r)}`);
      const [lc] = await events(long.id, "long_checked");
      assert.deepEqual([lc.child_alive, lc.file], [true, true]);
      const ua = (await events(short.id, "run_user"))[0].uid, ub = (await events(long.id, "run_user"))[0].uid;
      assert.notEqual(ua, ub, "each run had a user of its own");
      assert.equal(sd.uid, ua); assert.equal(ls.uid, ub);
      assert.equal((await events(short.id, "run_user")).length, 1, "(review) a program's line posing as the harness's event is a log line");
      assert.deepEqual([ls.home_mode, ls.out_mode], ["700", "700"], "(review) a run's directories are its user's alone (0700)");
      const range = ru.runUidRange();
      for (const u of [ua, ub]) assert.ok(u >= range.first && u <= range.last && u !== 64321, `a uid of the reserved range (${u}), not OCTILLION_RUN_UID`);
      assert.ok(!alive(ls.child), "and once it ended, its own leftovers went too");
      console.log(`✓ two runs at once on one host (two runner processes): the one that ended early swept only its own user (${ua}); the other (${ub}) kept its processes and files and finished`);
    }
    {
      const long = await runs.startRun(B.orgId, "fixture_users", "long", { scope: { seconds: 6 } });
      const short = await runs.startRun(A.orgId, "fixture_users", "short");
      const fixed = 66300;
      const other = second({ RU_RUN_AS: String(fixed) });
      await until(async () => (await events(long.id, "long_started")).length > 0, "the long run to start");
      const c = await local.claim(["fixture_users/short"]);
      const v = await harness.runWorkspaceHarness(local, c!, { egress: "off", packDir: () => FIX, runAs: { uid: fixed, gid: fixed } });
      assert.equal(v?.status, "failed"); assert.equal(v?.error_kind, "infrastructure", JSON.stringify(v));
      assert.match(v!.error!, /in use by another run on this host/);
      assert.equal((await other).status, "succeeded", "the run that holds the fixed user is untouched and finishes");
      assert.equal((await events(short.id, "short_done")).length, 0, "the refused run ran nothing");
      console.log("✓ a fixed user (runAs) is never shared: a second run asking for it while the first runs is refused (retried), and the first finishes");
    }
  } finally { await http.close(); }
  await db.close();
  console.log("RUN USERS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
