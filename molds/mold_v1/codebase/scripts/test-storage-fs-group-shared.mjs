#!/usr/bin/env node
/**
 * THE FILESYSTEM DRIVER SHARED BY TWO SERVICE USERS (STORAGE_FS_GROUP_SHARED), AND UNCHANGED WITHOUT IT.
 *
 * lib/storage/filesystem.ts keeps every folder 0700 and every file 0600. On a server where the web app and the agent
 * API run as two users, neither can open what the other wrote. STORAGE_FS_GROUP_SHARED=1 makes folders 2770 and
 * files 0660 (lib/storage/fs-group-shared.ts). This holds:
 *
 *   1. UNSET IS TODAY'S DRIVER. The mode of every folder and file a fixed sequence of writes leaves behind, under
 *      four umasks, equals a recording made by this same script on the code before the setting existed
 *      (scripts/fixtures/storage/filesystem-modes.golden.json, taken at 1f43117 with `--record`).
 *   2. THE SETTING. Unset, empty, 0 and false are off; 1 and true are on; anything else is a misconfiguration that
 *      names it. Off, the root is never looked at.
 *   3. ON: every folder is 2770 and every file 0660 whatever the umask, after a create, an overwrite (the atomic
 *      rename) and a create-only write (the hard link); nothing carries a bit for "other"; nothing is left in tmp/.
 *   4. THE STARTUP REFUSALS, each in a plain sentence: a root open to every user, one that is not exactly 2770, one
 *      whose group is a general-purpose group or some user's main group, a service user who is not in the
 *      group, a root that already holds unshared folders, a root that does not exist.
 *   5. TWO REAL USERS. Two user ids that share one group read, overwrite, add to and delete each other's files
 *      through the driver, also when both create new folders at the same moment; a third user outside the group
 *      can read nothing; and with the setting unset the second user is locked out, which is the reason it exists.
 *      This part needs to act as other users (root, or passwordless sudo, and `setpriv`). Where it cannot, it says
 *      so and is skipped; with REQUIRE_TWO_USERS=1 (CI) a skip is a failure. No account is created: the ids are
 *      numbers no account on the machine uses, and everything is under one scratch directory that is removed.
 *
 *   npm run test:storage-fs-group-shared
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = "test-signing-secret-0123456789abcdef-not-a-real-one";
const PUBLIC_URL = "https://app.storage.test";
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

/* ---- as another user: a copy of this script, run by the parent below --------------------------------------------- */

/**
 * `--as-user <json>`: do the listed storage operations as whoever started this process and print what happened.
 * The copy sits beside a copy of lib/storage/ (`./storage`), so it needs nothing an unknown user could not read.
 */
async function asUser(spec) {
  process.umask(spec.umask ?? 0o022);
  const lib = (file) => import(pathToFileURL(join(HERE, "storage", file)).href);
  const out = [];
  let driver = null;
  try {
    const { filesystemSettings } = await lib("settings.ts");
    const { createFilesystemDriver } = await lib("filesystem.ts");
    driver = createFilesystemDriver(filesystemSettings(spec.env));
  } catch (error) {
    console.log(JSON.stringify({ refused: { name: error?.name, message: String(error?.message ?? error) }, out }));
    return;
  }
  for (const [op, ...args] of spec.ops) {
    try {
      if (op === "put") out.push({ ok: true, value: (await driver.put(args[0], args[1], args[2] ?? {})).key });
      else if (op === "get") {
        const res = await driver.get(args[0], { ttlMs: 1000 });
        out.push({ ok: true, value: res === null ? null : { text: await res.text(), type: res.headers.get("content-type") } });
      } else if (op === "head") out.push({ ok: true, value: await driver.head(args[0]) });
      else if (op === "list") out.push({ ok: true, value: (await driver.list({ prefix: args[0] })).objects.map((o) => o.key) });
      else if (op === "delete") out.push({ ok: true, value: (await driver.delete(args[0]), null) });
      else if (op === "burst") {
        // Many new folders, one write in each, all at once: the other user is doing the same in the same folders.
        const results = await Promise.all(Array.from({ length: args[1] }, (_, i) => driver.put(`${args[0]}/${i}/deep/${args[2]}.md`, `${args[2]} ${i}`, {}).then(() => null, (e) => `${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 120)}`)));
        out.push({ ok: true, value: results.filter((r) => r !== null) });
      } else throw new Error(`unknown op ${op}`);
    } catch (error) {
      out.push({ ok: false, code: error?.code ?? null, name: error?.name, message: String(error?.message ?? error).slice(0, 300) });
    }
  }
  console.log(JSON.stringify({ refused: null, out }));
}

if (process.argv.includes("--as-user")) {
  await asUser(JSON.parse(process.argv[process.argv.indexOf("--as-user") + 1]));
  process.exit(0);
}

/* ---- the test ------------------------------------------------------------------------------------------------------ */

const ROOT = join(HERE, "..");
const GOLDEN = join(ROOT, "scripts/fixtures/storage/filesystem-modes.golden.json");
const RECORD = process.argv.includes("--record");

let passed = 0;
let skipped = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 700)}`}`);
  }
};
const attempt = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, name: error?.name, message: String(error?.message ?? error) };
  }
};

const SCRATCH = mkdtempSync(join(tmpdir(), "storage-fs-shared-"));
const fsSettings = (root, groupShared) => ({ root, signingSecret: SECRET, publicUrl: PUBLIC_URL, groupShared });
const fsEnv = (root, extra = {}) => ({ STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: root, STORAGE_SIGNING_SECRET: SECRET, STORAGE_PUBLIC_URL: PUBLIC_URL, ...extra });
const octal = (mode) => (mode & 0o7777).toString(8).padStart(4, "0");

/** Every folder and file at or under `dir`: [path relative to it, "d" | "f" | "?", mode], sorted by path. */
function modesUnder(dir) {
  const out = [];
  const visit = (abs, rel) => {
    const stat = lstatSync(abs);
    out.push([rel, stat.isDirectory() ? "d" : stat.isFile() ? "f" : "?", octal(stat.mode)]);
    if (stat.isDirectory()) for (const name of readdirSync(abs).sort()) visit(join(abs, name), rel === "." ? name : `${rel}/${name}`);
  };
  visit(dir, ".");
  return out;
}

/**
 * The writes the data room makes, once each: a create, an overwrite (rename onto the key), a typed write (a meta
 * file), a create-only write (the hard link an append part is), an untyped overwrite of a typed object (the meta
 * file is removed), a refused second create, a delete.
 */
async function writeSequence(driver) {
  await driver.put("dataroom/orgs/a/x.md", "x", { allowOverwrite: true });
  await driver.put("dataroom/orgs/a/x.md", "x again", { allowOverwrite: true });
  await driver.put("dataroom/orgs/a/deep/er/t.md", "typed", { allowOverwrite: true, contentType: "text/markdown; charset=utf-8" });
  await driver.put("dataroom/orgs/a/file.jsonl.appends/0001.part", "{}\n", { allowOverwrite: false, contentType: "application/x-ndjson" });
  await driver.put("dataroom/orgs/a/file.jsonl.appends/0001.part", "{}\n", { allowOverwrite: false }).catch(() => {});
  await driver.put("artifacts/orgs/a/r.html", "<p>r</p>", {});
  await driver.put("dataroom/orgs/b/typed-then-not.bin", "1", { allowOverwrite: true, contentType: "application/x-custom" });
  await driver.put("dataroom/orgs/b/typed-then-not.bin", "2", { allowOverwrite: true });
  await driver.put("dataroom/orgs/b/gone.md", "gone", { allowOverwrite: true, contentType: "text/markdown" });
  await driver.delete("dataroom/orgs/b/gone.md");
}
const UMASKS = [0o022, 0o077, 0o002, 0o000];

const { createFilesystemDriver } = await import("../lib/storage/filesystem.ts");

async function modesByUmask(groupShared, prepareRoot) {
  const result = {};
  const saved = process.umask();
  try {
    for (const mask of UMASKS) {
      const name = octal(mask);
      const root = join(SCRATCH, `${groupShared ? "shared" : "unset"}-${name}`, "store");
      process.umask(mask);
      prepareRoot?.(root);
      await writeSequence(createFilesystemDriver(fsSettings(root, groupShared)));
      result[name] = modesUnder(root);
    }
  } finally {
    process.umask(saved);
  }
  return result;
}

try {
  if (RECORD) {
    writeFileSync(GOLDEN, `${JSON.stringify(await modesByUmask(false), null, 1)}\n`);
    console.log(`recorded ${GOLDEN}`);
  } else await run();
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

async function run() {
  const settings = await import("../lib/storage/settings.ts");
  const shared = await import("../lib/storage/fs-group-shared.ts");

  /* ---- 1. unset ---------------------------------------------------------------------------------------------------- */
  console.log("1. With STORAGE_FS_GROUP_SHARED unset the driver is today's");
  {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const now = await modesByUmask(false);
    for (const mask of UMASKS.map(octal)) {
      const want = JSON.stringify(golden[mask]);
      const got = JSON.stringify(now[mask]);
      const firstDiff = got === want ? undefined : { before: golden[mask].find((e, i) => JSON.stringify(e) !== JSON.stringify(now[mask][i])), now: now[mask].find((e, i) => JSON.stringify(e) !== JSON.stringify(golden[mask][i])) };
      check(`umask ${mask}: every folder and file has the mode it had before the setting existed (${golden[mask].length} entries, recorded at 1f43117)`, got === want, firstDiff);
    }
    const all = Object.values(golden).flat();
    check("…which is 0700 for a folder and 0600 for a file under the usual umasks (022, 077, 002)", ["0022", "0077", "0002"].every((m) => golden[m].every(([, kind, mode]) => (kind === "d" ? mode === "0700" : mode === "0600"))), all.find(([, kind, mode]) => (kind === "d" ? mode !== "0700" : mode !== "0600")));
    check("…and it is a recording of something: folders, objects, a meta file, an empty tmp/", all.some(([p, k]) => k === "f" && p.startsWith("objects/")) && all.some(([p, k]) => k === "f" && p.startsWith("meta/")) && all.some(([p]) => p === "tmp") && !all.some(([p]) => p.startsWith("tmp/")));
    // The root is not looked at: one that does not exist, and one open to everybody, are both accepted as before.
    const open = join(SCRATCH, "open-root");
    mkdirSync(open);
    chmodSync(open, 0o777);
    for (const [what, value] of [["unset", undefined], ["empty", ""], ["0", "0"], ["false", "false"], ["spaces", "  "]]) {
      const made = attempt(() => settings.filesystemSettings(fsEnv(open, value === undefined ? {} : { STORAGE_FS_GROUP_SHARED: value })));
      check(`STORAGE_FS_GROUP_SHARED ${what}: off, and the root is not examined (a 0777 root is accepted, as it always was)`, !made.threw && made.value.groupShared === false && made.value.root === open, made);
    }
    check("…and a root that does not exist yet is still accepted (the driver creates it on the first write)", !attempt(() => settings.filesystemSettings(fsEnv(join(SCRATCH, "never-made")))).threw);
    check("the settings hold nothing new but the one flag", JSON.stringify(Object.keys(settings.filesystemSettings(fsEnv(open))).sort()) === JSON.stringify(["groupShared", "publicUrl", "root", "signingSecret"]));
  }

  /* ---- 2. the setting ---------------------------------------------------------------------------------------------- */
  console.log("\n2. The setting");
  {
    for (const on of ["1", "true", "TRUE", " 1 "]) check(`"${on}" is on`, shared.groupSharedSetting(on) === true);
    for (const bad of ["yes", "2770", "group", "on"]) {
      const made = attempt(() => settings.filesystemSettings(fsEnv(join(SCRATCH, "open-root"), { STORAGE_FS_GROUP_SHARED: bad })));
      check(`"${bad}" is a misconfiguration that names the setting, not a guess`, made.threw && made.name === "StorageConfigError" && made.message.includes("STORAGE_FS_GROUP_SHARED"), made);
    }
    check("the modes it gives are 2770 and 0660: nothing for anyone outside the group", shared.SHARED_DIR_MODE === 0o2770 && shared.SHARED_FILE_MODE === 0o660 && ((shared.SHARED_DIR_MODE | shared.SHARED_FILE_MODE) & 0o007) === 0);
  }

  /* ---- 3. on: modes ------------------------------------------------------------------------------------------------ */
  console.log("\n3. On: every folder 2770, every file 0660, whatever the umask");
  {
    const now = await modesByUmask(true, (root) => {
      // What the server's operator does once (docs/STORAGE.md): the root exists, 2770, before the service starts.
      mkdirSync(root, { recursive: true });
      chmodSync(root, 0o2770);
    });
    for (const mask of UMASKS.map(octal)) {
      const wrong = now[mask].filter(([, kind, mode]) => (kind === "d" ? mode !== "2770" : mode !== "0660"));
      check(`umask ${mask}: ${now[mask].filter(([, k]) => k === "d").length} folders are 2770 and ${now[mask].filter(([, k]) => k === "f").length} files are 0660 (create, overwrite, create-only, typed)`, wrong.length === 0 && now[mask].length > 15, wrong.slice(0, 4));
      check(`umask ${mask}: nothing carries a bit for "other", and nothing is left in tmp/`, now[mask].every(([, , mode]) => (Number.parseInt(mode, 8) & 0o007) === 0) && !now[mask].some(([p]) => p.startsWith("tmp/")));
    }
    const unset = JSON.parse(readFileSync(GOLDEN, "utf8"))["0022"];
    check("the same folders and files as with the setting off: only the modes differ", JSON.stringify(now["0022"].map(([p, k]) => [p, k])) === JSON.stringify(unset.map(([p, k]) => [p, k])));
  }

  /* ---- 4. the startup refusals ------------------------------------------------------------------------------------- */
  console.log("\n4. The root is examined before a file is shared");
  {
    // Run as root, a scratch directory is in group 0, which is refused for what it is: give these a group of their own.
    const dir = (name, mode) => {
      const path = join(SCRATCH, "roots", name);
      mkdirSync(path, { recursive: true });
      if (process.geteuid?.() === 0) chownSync(path, 0, 61_999);
      chmodSync(path, mode);
      return path;
    };
    const gidOf = (path) => statSync(path).gid;
    const me = { uid: 4242, groups: [4242, gidOf(dir("probe", 0o700))] };
    // A server whose accounts are: this service, the other service, and a made-up shared group nobody has as main.
    const accounts = (primary = {}, names = {}) => ({ primaryMembers: (gid) => primary[gid] ?? [], groupName: (gid) => names[gid] ?? null });
    const problem = (path, identity = me, acc = accounts()) => shared.groupSharedProblem(path, identity, acc);

    const good = dir("good", 0o2770);
    check("a 2770 root in a group made for the files, with this service's user in it, is accepted", problem(good, me, accounts({}, { [gidOf(good)]: "filestore" })) === null, problem(good));
    for (const [mode, why] of [[0o2777, "open to every user"], [0o2775, "open to every user"], [0o2771, "open to every user"], [0o0777, "open to every user"]]) {
      const said = problem(dir(`world-${octal(mode)}`, mode));
      check(`a root with mode ${octal(mode)} is refused: "${why}"`, said !== null && said.includes(why) && said.includes(octal(mode)) && said.includes("chmod 2770"), said);
    }
    for (const mode of [0o0770, 0o2750, 0o0700, 0o2700, 0o3770, 0o6770]) {
      const said = problem(dir(`mode-${octal(mode)}`, mode));
      check(`a root with mode ${octal(mode)} is refused: it must be exactly 2770`, said !== null && said.includes("exactly 2770") && said.includes(octal(mode)), said);
    }
    const g = gidOf(good);
    for (const name of ["users", "staff", "www-data", "sudo", "docker", "root"]) {
      const said = problem(good, me, accounts({}, { [g]: name }));
      check(`a root in the general-purpose group "${name}" is refused`, said !== null && said.includes(`"${name}"`) && said.includes("general-purpose"), said);
    }
    const mine = problem(good, me, accounts({ [g]: ["web"] }, { [g]: "web" }));
    check("a root in a user's own main group is refused, saying what else that would hand over", mine !== null && mine.includes('main group of the user "web"') && mine.includes("environment file"), mine);
    const outsider = problem(good, { uid: 4242, groups: [4242] }, accounts({}, { [g]: "filestore" }));
    check("a service user who is not in the root's group is refused, and told a restart is needed after joining", outsider !== null && outsider.includes("is not in") && outsider.includes("restart"), outsider);
    check("…root is not asked to be in it", problem(good, { uid: 0, groups: [0] }, accounts({}, { [g]: "filestore" })) === null);
    const missing = problem(join(SCRATCH, "roots", "absent"));
    check("a root that does not exist is refused: it is not created for you", missing !== null && missing.includes("does not exist") && missing.includes("2770"), missing);
    writeFileSync(join(SCRATCH, "roots", "a-file"), "");
    check("a root that is a file is refused", problem(join(SCRATCH, "roots", "a-file"))?.includes("not a directory") === true);
    const legacy = dir("legacy", 0o2770);
    mkdirSync(join(legacy, "objects"));
    chmodSync(join(legacy, "objects"), 0o700);
    const old = problem(legacy);
    check("a root that already holds folders made with the setting off is refused, pointing at the one-time conversion", old !== null && old.includes('"objects"') && old.includes("0700") && old.includes("Turning it on"), old);
    for (const said of [mine, outsider, missing, old, problem(dir("w", 0o2777))]) {
      check(`the refusal names the setting and carries no path: "${String(said).slice(0, 60)}…"`, said.startsWith("STORAGE_FS_GROUP_SHARED is on") && !said.includes(SCRATCH));
    }

    // The same through the settings the app reads, against the machine's real accounts.
    const world = dir("real-world", 0o2777);
    const refused = attempt(() => settings.filesystemSettings(fsEnv(world, { STORAGE_FS_GROUP_SHARED: "1" })));
    check("the app's own settings refuse a world-open root with a StorageConfigError", refused.threw && refused.name === "StorageConfigError" && refused.message.includes("open to every user"), refused);
    const logged = [];
    const savedError = console.error;
    console.error = (line) => logged.push(String(line));
    let viaStartup;
    try {
      settings.resetStorageConfigReports();
      viaStartup = settings.storageConfigError(fsEnv(world, { STORAGE_FS_GROUP_SHARED: "1" }));
      settings.storageConfigError(fsEnv(world, { STORAGE_FS_GROUP_SHARED: "1" }));
    } finally {
      console.error = savedError;
    }
    check("…the startup check reports it, logged once ([storage] MISCONFIGURED)", viaStartup?.name === "StorageConfigError" && logged.length === 1 && logged[0].startsWith("[storage] MISCONFIGURED: STORAGE_FS_GROUP_SHARED is on"), logged);
    chmodSync(world, 0o2770);
    const afterFix = attempt(() => settings.filesystemSettings(fsEnv(world, { STORAGE_FS_GROUP_SHARED: "1" })));
    // Fixed, the next thing wrong is said (in a scratch directory the group is this user's own): never the old answer.
    check("…and a corrected mode is seen at once (no remembered refusal)", !afterFix.threw || !afterFix.message.includes("open to every user"), afterFix);
    check("the other settings are still checked first, in the same words", attempt(() => settings.filesystemSettings({ ...fsEnv(world, { STORAGE_FS_GROUP_SHARED: "1" }), STORAGE_SIGNING_SECRET: "short" })).message?.startsWith("STORAGE_SIGNING_SECRET") === true);
  }

  /* ---- 5. two real users ------------------------------------------------------------------------------------------- */
  console.log("\n5. Two users that share one group, through the driver");
  await twoUsers();
}

/** How to run a command as root from here: [] when already root, ["sudo", "-n"] when that works, null otherwise. */
function rootPrefix() {
  if (process.platform !== "linux") return null;
  if (spawnSync("setpriv", ["--version"], { encoding: "utf8" }).status !== 0) return null;
  if (process.geteuid() === 0) return [];
  return spawnSync("sudo", ["-n", "true"]).status === 0 ? ["sudo", "-n"] : null;
}

async function twoUsers() {
  const root = rootPrefix();
  if (root === null) {
    const why = "this test cannot act as other users here (it needs Linux, `setpriv`, and root or passwordless sudo)";
    if (process.env.REQUIRE_TWO_USERS === "1") check(`two users sharing a group (REQUIRE_TWO_USERS=1): ${why}`, false);
    else {
      skipped++;
      console.log(`  skip two users sharing a group were NOT tested: ${why}. Parts 1 to 4 ran.`);
    }
    return;
  }
  const asRoot = (argv) => spawnSync([...root, ...argv][0], [...root, ...argv].slice(1), { encoding: "utf8" });

  // Ids no account or group on this machine uses. Nothing is added to /etc: the kernel needs only the numbers.
  const used = new Set([...readFileSync("/etc/passwd", "utf8").split("\n").map((l) => l.split(":")[2]), ...readFileSync("/etc/group", "utf8").split("\n").map((l) => l.split(":")[2])].filter(Boolean).map(Number));
  const free = [];
  for (let id = 61_000; free.length < 4 && id < 65_000; id++) if (!used.has(id)) free.push(id);
  const [WEB, AGENT, STRANGER, GROUP] = free;

  // Its own scratch directory: other users must be able to enter it, and some of what lands in it is theirs.
  const STAGE = mkdtempSync(join(tmpdir(), "storage-two-users-"));
  const removeStage = () => {
    // Only ever this one directory, by its full made-up name.
    if (STAGE.startsWith(join(tmpdir(), "storage-two-users-")) && STAGE.length > join(tmpdir(), "storage-two-users-").length) asRoot(["rm", "-rf", "--", STAGE]);
  };
  try {
    chmodSync(STAGE, 0o755);
    cpSync(join(ROOT, "lib/storage"), join(STAGE, "storage"), { recursive: true });
    copyFileSync(fileURLToPath(import.meta.url), join(STAGE, "as-user.mjs"));
    asRoot(["chmod", "-R", "a+rX", STAGE]);
    const idArgs = (uid, groups) => [`--reuid=${uid}`, `--regid=${uid}`, groups.length ? `--groups=${groups.join(",")}` : "--clear-groups"];
    // A node this user can run: the one running this test, or a copy of it when that one is in a private folder.
    let node = process.execPath;
    if (asRoot(["setpriv", ...idArgs(STRANGER, []), "--", node, "--version"]).status !== 0) {
      node = join(STAGE, "node");
      copyFileSync(process.execPath, node);
      chmodSync(node, 0o755);
    }
    const command = (uid, groups, spec) => [...root, "setpriv", ...idArgs(uid, groups), "--", node, ...NODE_FLAGS, join(STAGE, "as-user.mjs"), "--as-user", JSON.stringify(spec)];
    const parse = (r) => {
      try {
        return JSON.parse(r.stdout.trim().split("\n").pop());
      } catch {
        return { crashed: `${r.stdout}${r.stderr}`.slice(-600) };
      }
    };
    const run = (uid, groups, spec) => {
      const argv = command(uid, groups, spec);
      return parse(spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }));
    };
    const runAsync = (uid, groups, spec) =>
      new Promise((resolve) => {
        const argv = command(uid, groups, spec);
        const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", () => resolve(parse({ stdout, stderr })));
      });
    const probe = run(WEB, [GROUP], { env: {}, ops: [] });
    if (probe.crashed !== undefined && !probe.refused) {
      // setpriv is there but may not change ids here (a container without the capability).
      const why = `a process could not be started as another user here (${String(probe.crashed).trim().split("\n").pop()})`;
      if (process.env.REQUIRE_TWO_USERS === "1") check(`two users sharing a group (REQUIRE_TWO_USERS=1): ${why}`, false);
      else {
        skipped++;
        console.log(`  skip two users sharing a group were NOT tested: ${why}. Parts 1 to 4 ran.`);
      }
      return;
    }

    // The server's one-time setup, as docs/STORAGE.md gives it: the root, owned by the web user, group shared, 2770.
    const store = join(STAGE, "store");
    const made = asRoot(["install", "-d", "-m", "2770", "-o", String(WEB), "-g", String(GROUP), store]);
    check(`the root is made as the docs say: install -d -m 2770 -o <web> -g <group> (ids ${WEB}, ${AGENT}; group ${GROUP}; no account is created)`, made.status === 0, made.stderr);
    const on = { STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: store, STORAGE_SIGNING_SECRET: SECRET, STORAGE_PUBLIC_URL: PUBLIC_URL, STORAGE_FS_GROUP_SHARED: "1" };
    const K = "dataroom/orgs/a";
    const allOk = (r) => r.refused === null && r.out.every((o) => o.ok);

    // The web app (umask 022, the usual one: without the explicit modes its folders would be 2750, closed to the agent).
    const web1 = run(WEB, [GROUP], { env: on, umask: 0o022, ops: [["put", `${K}/report.md`, "web wrote this", { allowOverwrite: true, contentType: "text/markdown; charset=utf-8" }], ["put", `${K}/notes/n1.md`, "web note", {}], ["put", `${K}/log.jsonl.appends/0001.part`, "{\"by\":\"web\"}\n", {}]] });
    check("the web app's user writes three files (umask 022)", allOk(web1), web1);

    // The agent (umask 077, the strictest): reads, overwrites, adds beside, adds below, deletes.
    const agent1 = run(AGENT, [GROUP], {
      env: on,
      umask: 0o077,
      ops: [
        ["get", `${K}/report.md`],
        ["list", `${K}/`],
        ["put", `${K}/report.md`, "agent rewrote this", { allowOverwrite: true }],
        ["put", `${K}/log.jsonl.appends/0002.part`, "{\"by\":\"agent\"}\n", {}],
        ["put", `${K}/log.jsonl.appends/0001.part`, "must not replace", {}],
        ["put", `${K}/notes/from-agent/deeper/a1.md`, "agent note", { contentType: "text/markdown" }],
        ["delete", `${K}/notes/n1.md`],
        ["put", "dataroom/orgs/a/../b/escape.md", "x", { allowOverwrite: true }],
      ],
    });
    const a = agent1.out ?? [];
    check("the agent's user (umask 077) reads what the web app wrote, with its content type", a[0]?.ok && a[0].value?.text === "web wrote this" && a[0].value.type === "text/markdown; charset=utf-8", agent1);
    check("…lists the web app's files", a[1]?.ok && JSON.stringify(a[1].value) === JSON.stringify([`${K}/log.jsonl.appends/0001.part`, `${K}/notes/n1.md`, `${K}/report.md`]), a[1]);
    check("…overwrites one (the atomic rename, into a folder the web app created)", a[2]?.ok === true, a[2]);
    check("…adds an append part beside the web app's (the hard link)", a[3]?.ok === true, a[3]);
    check("…but still cannot replace an existing part: one writer wins, as before", a[4]?.ok === false && /already exists/.test(a[4].message), a[4]);
    check("…creates new folders under the web app's, and deletes the web app's file", a[5]?.ok === true && a[6]?.ok === true, [a[5], a[6]]);
    check("…and a key that tries to leave its workspace is refused exactly as before (StorageKeyError)", a[7]?.ok === false && a[7].name === "StorageKeyError", a[7]);

    // Back as the web app: everything the agent did is readable and writable.
    const web2 = run(WEB, [GROUP], {
      env: on,
      umask: 0o022,
      ops: [
        ["get", `${K}/report.md`],
        ["get", `${K}/log.jsonl.appends/0002.part`],
        ["get", `${K}/notes/from-agent/deeper/a1.md`],
        ["head", `${K}/notes/n1.md`],
        ["put", `${K}/notes/from-agent/deeper/a1.md`, "web rewrote the agent's note", { allowOverwrite: true }],
        ["put", `${K}/notes/from-agent/deeper/w2.md`, "web, in the agent's folder", {}],
        ["delete", `${K}/log.jsonl.appends/0002.part`],
        ["list", `${K}/`],
      ],
    });
    const w = web2.out ?? [];
    check("the web app reads the agent's overwrite", w[0]?.ok && w[0].value?.text === "agent rewrote this" && w[0].value.type === "text/markdown; charset=utf-8", web2);
    check("…reads the agent's append part and the file in the agent's new folders", w[1]?.value?.text === "{\"by\":\"agent\"}\n" && w[2]?.value?.text === "agent note" && w[2].value.type === "text/markdown", [w[1], w[2]]);
    check("…sees the file the agent deleted is gone", w[3]?.ok && w[3].value === null, w[3]);
    check("…overwrites and adds inside the agent's folders, deletes the agent's file", w[4]?.ok && w[5]?.ok && w[6]?.ok, [w[4], w[5], w[6]]);
    check("…and lists exactly what is left", w[7]?.ok && JSON.stringify(w[7].value) === JSON.stringify([`${K}/log.jsonl.appends/0001.part`, `${K}/notes/from-agent/deeper/a1.md`, `${K}/notes/from-agent/deeper/w2.md`, `${K}/report.md`]), w[7]);

    // Both at once, each creating the same new folders (the moment a folder exists but is not yet group-writable).
    const [raceWeb, raceAgent] = await Promise.all([
      runAsync(WEB, [GROUP], { env: on, umask: 0o022, ops: [["burst", `${K}/race`, 60, "web"]] }),
      runAsync(AGENT, [GROUP], { env: on, umask: 0o022, ops: [["burst", `${K}/race`, 60, "agent"]] }),
    ]);
    check("both users creating the same 60 new folders at the same moment: every write succeeds", raceWeb.out?.[0]?.ok && raceWeb.out[0].value.length === 0 && raceAgent.out?.[0]?.ok && raceAgent.out[0].value.length === 0, { web: raceWeb.out?.[0]?.value?.slice(0, 2) ?? raceWeb, agent: raceAgent.out?.[0]?.value?.slice(0, 2) ?? raceAgent });
    const raced = run(AGENT, [GROUP], { env: on, ops: [["list", `${K}/race/`]] });
    check("…and all 120 files are there", raced.out?.[0]?.value?.length === 120, raced.out?.[0]?.value?.length);

    // What is on disk, read as root: modes, groups, and that both users really own some of it.
    const found = asRoot(["find", store, "-printf", "%m %U %G %y %P\\n"]).stdout.trim().split("\n").map((l) => l.split(" "));
    const dirs = found.filter((f) => f[3] === "d");
    const files = found.filter((f) => f[3] === "f");
    check(`on disk: all ${dirs.length} folders are 2770`, dirs.length > 100 && dirs.every((f) => f[0] === "2770"), dirs.filter((f) => f[0] !== "2770").slice(0, 3));
    check(`…all ${files.length} files are 660`, files.length > 100 && files.every((f) => f[0] === "660"), files.filter((f) => f[0] !== "660").slice(0, 3));
    check("…every folder and file is in the shared group (inherited: neither service changed a group)", found.every((f) => f[2] === String(GROUP)), found.filter((f) => f[2] !== String(GROUP)).slice(0, 3));
    check("…and both users own some of them", new Set(files.map((f) => f[1])).size === 2 && new Set(dirs.map((f) => f[1])).size === 2);
    check("…nothing is left in tmp/", !found.some((f) => f[4]?.startsWith("tmp/")));

    // A third user who is not in the group.
    const stranger = run(STRANGER, [], { env: on, ops: [] });
    check("a user outside the group is refused at startup, in plain words", stranger.refused?.name === "StorageConfigError" && /does not exist \(or this service's user cannot reach it\)|is not in/.test(stranger.refused.message), stranger);
    const peek = asRoot(["setpriv", ...idArgs(STRANGER, []), "--", "cat", join(store, "objects", K, "report.md")]);
    check("…and cannot read a file by going to the directory directly", peek.status !== 0 && /Permission denied/.test(peek.stderr), peek.stderr);
    const strangerOff = run(STRANGER, [], { env: { ...on, STORAGE_FS_GROUP_SHARED: "" }, ops: [["get", `${K}/report.md`], ["list", `${K}/`], ["put", `${K}/planted.md`, "x", {}]] });
    check("…nor through the driver with the setting left off: every operation is denied (EACCES)", strangerOff.refused === null && strangerOff.out.length === 3 && strangerOff.out.every((o) => o.ok === false && o.code === "EACCES"), strangerOff);

    // A member of the group must have the group when it STARTS: without it, the same refusal.
    const notYet = run(AGENT, [], { env: on, ops: [] });
    check("the agent's user started without the group (added to it, service not restarted) is refused, not half-working", notYet.refused?.name === "StorageConfigError", notYet);

    // And why the setting exists: the same two users and the same 2770 root, with the setting unset.
    const plain = join(STAGE, "store-unset");
    asRoot(["install", "-d", "-m", "2770", "-o", String(WEB), "-g", String(GROUP), plain]);
    const off = { ...on, STORAGE_FS_ROOT: plain, STORAGE_FS_GROUP_SHARED: "" };
    const webOff = run(WEB, [GROUP], { env: off, ops: [["put", `${K}/report.md`, "web wrote this", {}]] });
    const agentOff = run(AGENT, [GROUP], { env: off, ops: [["get", `${K}/report.md`], ["put", `${K}/from-agent.md`, "x", {}]] });
    check("with the setting unset the web app writes as it always did", allOk(webOff), webOff);
    check("…and the agent's user, in the same group, can neither read it nor write beside it (EACCES): today's 0700/0600", agentOff.refused === null && agentOff.out.every((o) => o.ok === false && o.code === "EACCES"), agentOff);
    // (A folder made inside a setgid folder carries the setgid bit itself, from the kernel: 2700. No group access.)
    const offModes = asRoot(["find", plain, "-mindepth", "1", "-printf", "%m %y\\n"]).stdout.trim().split("\n");
    check("…on disk: folders and files for the owner alone (700 and 600), as before", offModes.length > 4 && offModes.every((l) => l === "700 d" || l === "2700 d" || l === "600 f"), offModes);
  } finally {
    removeStage();
  }
  check("the scratch directory the other users wrote into is removed", !existsSync(STAGE));
}

if (RECORD) process.exit(0);
console.log(`\n${passed} passed, ${failed.length} failed${skipped ? `, ${skipped} part skipped (said above)` : ""}`);
if (failed.length) {
  for (const label of failed) console.log(`  FAILED ${label}`);
  process.exit(1);
}
console.log("test-storage-fs-group-shared: unset is today's 0700/0600; on, two users share the files by one group and nobody else can read them");
